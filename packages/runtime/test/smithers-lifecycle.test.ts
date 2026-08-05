import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runSmithersLifecycleCommand, streamSmithersCommand } from "../src/smithers.js";
import { createSmithersTestEnvironment } from "./helpers/smithers-capability.js";

function replayRunner(input: { root: string; failResume?: boolean; omitRunId?: boolean }): {
  env: Record<string, string | undefined>;
  logPath: string;
} {
  const runner = path.join(input.root, "smithers");
  const logPath = path.join(input.root, "commands.log");
  fs.writeFileSync(
    runner,
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" >> "$SMITHERS_REPLAY_TEST_LOG"',
      'case "$1" in',
      "  replay)",
      '    case " $* " in *" --ultrafuzz-prepare-only "*) ;; *) exit 64 ;; esac',
      "    printf '%s\\n' 'prepared replay child' >&2",
      input.omitRunId
        ? "    printf '%s\\n' '{\"ok\":true,\"data\":{}}'"
        : '    printf \'%s\\n\' \'{"ok":true,"data":{"forkedRunId":"replay-child"}}\'',
      "    ;;",
      "  up)",
      ...(input.failResume
        ? ["    printf '%s\\n' 'detached resume failed' >&2", "    exit 19"]
        : [
            "    printf '%s\\n' 'admitted detached resume' >&2",
            '    printf \'%s\\n\' \'{"ok":true,"data":{"status":"running"}}\''
          ]),
      "    ;;",
      "  *) exit 65 ;;",
      "esac",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(runner, 0o755);
  return {
    env: createSmithersTestEnvironment(runner, { SMITHERS_REPLAY_TEST_LOG: logPath }),
    logPath
  };
}

function forkRunner(input: { root: string }): {
  env: Record<string, string | undefined>;
  logPath: string;
} {
  const runner = path.join(input.root, "smithers");
  const logPath = path.join(input.root, "commands.log");
  fs.writeFileSync(
    runner,
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" >> "$SMITHERS_FORK_TEST_LOG"',
      'case "$1" in',
      "  fork)",
      '    case " $* " in *" --force "*) ;; *) exit 63 ;; esac',
      '    case " $* " in *" --ultrafuzz-prepare-only "*) ;; *) exit 64 ;; esac',
      "    printf '%s\\n' 'prepared fork child' >&2",
      '    printf \'%s\\n\' \'{"ok":true,"data":{"forkedRunId":"fork-child"}}\'',
      "    ;;",
      "  up)",
      "    printf '%s\\n' 'admitted detached resume' >&2",
      '    printf \'%s\\n\' \'{"ok":true,"data":{"status":"running"}}\'',
      "    ;;",
      "  *) exit 65 ;;",
      "esac",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(runner, 0o755);
  return {
    env: createSmithersTestEnvironment(runner, { SMITHERS_FORK_TEST_LOG: logPath }),
    logPath
  };
}

test("fork prepares an authorized child before starting the standard detached supervised resume", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-fork-lifecycle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workflowPath = path.join(root, "workflow.tsx");
  const { env, logPath } = forkRunner({ root });
  const callbacks: string[] = [];

  const result = await runSmithersLifecycleCommand({
    action: "fork",
    smithersRunId: "source-run",
    workflowPath,
    projectRoot: root,
    maxConcurrency: 9,
    forkFrame: 21,
    resetNode: "node:retry-me",
    force: true,
    correlationLabel: "ultrafuzz-lifecycle-correlation",
    keepWorkspaces: false,
    controllerLeaseSeconds: 36,
    env,
    onExternalInvocationSpawned: () => callbacks.push("prepare-spawned"),
    validatePreparedWorkflowRunId: async (workflowRunId) => {
      callbacks.push(`validated-${workflowRunId}`);
    },
    onDetachedInvocation: () => callbacks.push("detached-submission")
  });

  assert.deepEqual(callbacks, ["prepare-spawned", "validated-fork-child", "detached-submission"]);
  assert.equal(result.workflowRunId, "fork-child");
  assert.deepEqual(result.command, [
    "smithers",
    "up",
    workflowPath,
    "--resume",
    "fork-child",
    "--run-id",
    "fork-child",
    "--force",
    "--detach",
    "--max-concurrency",
    "9",
    "--format",
    "json",
    "--supervise",
    "--supervise-interval",
    "12s",
    "--supervise-stale-threshold",
    "36s",
    "--supervise-max-concurrent",
    "1"
  ]);
  assert.equal(result.stderr, "prepared fork child\n\nadmitted detached resume\n");
  assert.deepEqual(fs.readFileSync(logPath, "utf8").trim().split("\n"), [
    `fork ${workflowPath} --run-id source-run --frame 21 --reset-node node:retry-me --label ultrafuzz-lifecycle-correlation --force --ultrafuzz-prepare-only --format json`,
    `up ${workflowPath} --resume fork-child --run-id fork-child --force --detach --max-concurrency 9 --format json --supervise --supervise-interval 12s --supervise-stale-threshold 36s --supervise-max-concurrent 1`
  ]);
});

test("fork child validation completes before any detached resume is submitted", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-fork-lifecycle-validation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workflowPath = path.join(root, "workflow.tsx");
  const { env, logPath } = forkRunner({ root });
  const callbacks: string[] = [];

  await assert.rejects(
    runSmithersLifecycleCommand({
      action: "fork",
      smithersRunId: "source-run",
      workflowPath,
      projectRoot: root,
      maxConcurrency: 4,
      forkFrame: 8,
      force: true,
      correlationLabel: "ultrafuzz-lifecycle-correlation",
      keepWorkspaces: false,
      controllerLeaseSeconds: 30,
      env,
      onExternalInvocationSpawned: () => callbacks.push("prepare-spawned"),
      validatePreparedWorkflowRunId: async (workflowRunId) => {
        callbacks.push(`validated-${workflowRunId}`);
        throw new Error("prepared fork child failed validation");
      },
      onDetachedInvocation: () => callbacks.push("detached-submission")
    }),
    /prepared fork child failed validation/u
  );

  assert.deepEqual(callbacks, ["prepare-spawned", "validated-fork-child"]);
  assert.deepEqual(
    fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split(" ", 1)[0]),
    ["fork"]
  );
});

test("replay prepares a child before starting the standard detached supervised resume", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-replay-lifecycle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workflowPath = path.join(root, "workflow.tsx");
  const { env, logPath } = replayRunner({ root });
  const callbacks: string[] = [];

  const result = await runSmithersLifecycleCommand({
    action: "replay",
    smithersRunId: "source-run",
    workflowPath,
    projectRoot: root,
    maxConcurrency: 7,
    forkFrame: 12,
    force: true,
    correlationLabel: "ultrafuzz-lifecycle-correlation",
    keepWorkspaces: false,
    controllerLeaseSeconds: 31,
    env,
    onExternalInvocationSpawned: () => callbacks.push("prepare-spawned"),
    validatePreparedWorkflowRunId: async (workflowRunId) => {
      callbacks.push(`validated-${workflowRunId}`);
    },
    onDetachedInvocation: () => callbacks.push("detached-submission")
  });

  assert.deepEqual(callbacks, ["prepare-spawned", "validated-replay-child", "detached-submission"]);
  assert.equal(result.workflowRunId, "replay-child");
  assert.deepEqual(result.command, [
    "smithers",
    "up",
    workflowPath,
    "--resume",
    "replay-child",
    "--run-id",
    "replay-child",
    "--force",
    "--detach",
    "--max-concurrency",
    "7",
    "--format",
    "json",
    "--supervise",
    "--supervise-interval",
    "10s",
    "--supervise-stale-threshold",
    "31s",
    "--supervise-max-concurrent",
    "1"
  ]);
  assert.equal(result.stderr, "prepared replay child\n\nadmitted detached resume\n");
  assert.deepEqual(fs.readFileSync(logPath, "utf8").trim().split("\n"), [
    `replay ${workflowPath} --run-id source-run --frame 12 --label ultrafuzz-lifecycle-correlation --force --ultrafuzz-prepare-only --format json`,
    `up ${workflowPath} --resume replay-child --run-id replay-child --force --detach --max-concurrency 7 --format json --supervise --supervise-interval 10s --supervise-stale-threshold 31s --supervise-max-concurrent 1`
  ]);
});

test("a detached replay resume failure retains both uncertainty boundary callbacks", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-replay-lifecycle-failure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workflowPath = path.join(root, "workflow.tsx");
  const { env, logPath } = replayRunner({ root, failResume: true });
  const callbacks: string[] = [];

  await assert.rejects(
    runSmithersLifecycleCommand({
      action: "replay",
      smithersRunId: "source-run",
      workflowPath,
      projectRoot: root,
      forkFrame: 12,
      correlationLabel: "ultrafuzz-lifecycle-correlation",
      keepWorkspaces: false,
      controllerLeaseSeconds: 30,
      env,
      onExternalInvocationSpawned: () => callbacks.push("prepare-spawned"),
      validatePreparedWorkflowRunId: async (workflowRunId) => {
        callbacks.push(`validated-${workflowRunId}`);
      },
      onDetachedInvocation: () => callbacks.push("detached-submission")
    }),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 19);
      assert.match((error as { stderr?: string }).stderr ?? "", /detached resume failed/u);
      return true;
    }
  );

  assert.deepEqual(callbacks, ["prepare-spawned", "validated-replay-child", "detached-submission"]);
  assert.deepEqual(
    fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split(" ", 1)[0]),
    ["replay", "up"]
  );
});

test("replay preparation without a child ID never starts the detached resume", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-replay-lifecycle-missing-id-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workflowPath = path.join(root, "workflow.tsx");
  const { env, logPath } = replayRunner({ root, omitRunId: true });
  const callbacks: string[] = [];

  await assert.rejects(
    runSmithersLifecycleCommand({
      action: "replay",
      smithersRunId: "source-run",
      workflowPath,
      projectRoot: root,
      forkFrame: 12,
      correlationLabel: "ultrafuzz-lifecycle-correlation",
      keepWorkspaces: false,
      controllerLeaseSeconds: 30,
      env,
      onExternalInvocationSpawned: () => callbacks.push("prepare-spawned"),
      validatePreparedWorkflowRunId: async (workflowRunId) => {
        callbacks.push(`validated-${workflowRunId}`);
      },
      onDetachedInvocation: () => callbacks.push("detached-submission")
    }),
    /did not return a replayed workflow run ID/u
  );

  assert.deepEqual(callbacks, ["prepare-spawned"]);
  assert.deepEqual(
    fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split(" ", 1)[0]),
    ["replay"]
  );
});

test("a delayed stream callback rejection waits for the runner to close", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-stream-callback-close-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runner = path.join(root, "smithers.mjs");
  const pidPath = path.join(root, "runner.pid");
  const closedPath = path.join(root, "runner.closed");
  fs.writeFileSync(
    runner,
    [
      "#!/usr/bin/env node",
      'import fs from "node:fs";',
      "fs.writeFileSync(process.env.SMITHERS_STREAM_PID, String(process.pid));",
      'process.on("SIGTERM", () => {',
      '  fs.writeFileSync(process.env.SMITHERS_STREAM_CLOSED, "closed\\n");',
      "  process.exit(0);",
      "});",
      'process.stdout.write("{\\"event\\":1}\\n");',
      "setInterval(() => {}, 1_000);",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(runner, 0o755);
  const env = createSmithersTestEnvironment(runner, {
    PATH: process.env.PATH,
    SMITHERS_STREAM_PID: pidPath,
    SMITHERS_STREAM_CLOSED: closedPath
  });

  await assert.rejects(
    streamSmithersCommand({
      args: ["events", "run-id", "--follow", "--json"],
      projectRoot: root,
      env,
      maxLines: 10,
      onLine: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        throw new Error("delayed stream consumer failure");
      }
    }),
    /delayed stream consumer failure/u
  );

  assert.equal(fs.readFileSync(closedPath, "utf8"), "closed\n");
  const runnerPid = Number(fs.readFileSync(pidPath, "utf8"));
  assert.throws(
    () => process.kill(runnerPid, 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH"
  );
});

test("stream cancellation does not wait for a never-settling line consumer", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-stream-callback-abort-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runner = path.join(root, "smithers.mjs");
  fs.writeFileSync(
    runner,
    ["#!/usr/bin/env node", 'process.stdout.write("{\\"event\\":1}\\n");', "setInterval(() => {}, 1_000);", ""].join(
      "\n"
    ),
    "utf8"
  );
  fs.chmodSync(runner, 0o755);
  const env = createSmithersTestEnvironment(runner, { PATH: process.env.PATH });
  const controller = new AbortController();
  let markCallbackStarted: (() => void) | undefined;
  const callbackStarted = new Promise<void>((resolve) => {
    markCallbackStarted = resolve;
  });
  const stream = streamSmithersCommand({
    args: ["events", "run-id", "--follow", "--json"],
    projectRoot: root,
    env,
    signal: controller.signal,
    maxLines: 10,
    onLine: () => {
      markCallbackStarted?.();
      return new Promise<void>(() => undefined);
    }
  });
  await callbackStarted;
  const abortedAt = Date.now();
  controller.abort();
  const result = await stream;
  assert.equal(result.stoppedByCaller, true);
  assert.ok(Date.now() - abortedAt < 2_000);
});

test(
  "stream truncation kills a signal-resistant command and descendant process group",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-stream-process-group-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runner = path.join(root, "smithers");
    const commandPidPath = path.join(root, "command.pid");
    const descendantPidPath = path.join(root, "descendant.pid");
    fs.writeFileSync(
      runner,
      `#!/bin/sh
printf '%s\n' "$$" > "$SMITHERS_STREAM_COMMAND_PID"
( trap '' TERM; while :; do sleep 1; done ) &
printf '%s\n' "$!" > "$SMITHERS_STREAM_DESCENDANT_PID"
trap '' TERM
printf '%s\n' '{"event":1}'
while :; do sleep 1; done
`,
      "utf8"
    );
    fs.chmodSync(runner, 0o755);
    const env = createSmithersTestEnvironment(runner, {
      PATH: process.env.PATH,
      SMITHERS_STREAM_COMMAND_PID: commandPidPath,
      SMITHERS_STREAM_DESCENDANT_PID: descendantPidPath
    });

    const startedAt = Date.now();
    const result = await streamSmithersCommand({
      args: ["events", "run-id", "--follow", "--json"],
      projectRoot: root,
      env,
      maxLines: 1,
      onLine: () => undefined
    });

    assert.equal(result.truncated, true);
    assert.equal(result.stoppedByCaller, true);
    assert.ok(Date.now() - startedAt < 3_000);
    for (const pidPath of [commandPidPath, descendantPidPath]) {
      await assertProcessGone(Number(fs.readFileSync(pidPath, "utf8").trim()));
    }
  }
);

test("stream callback drain has an absolute deadline after the runner exits", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-stream-callback-deadline-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runner = path.join(root, "smithers.mjs");
  fs.writeFileSync(runner, '#!/usr/bin/env node\nprocess.stdout.write("{\\"event\\":1}\\n");\n', "utf8");
  fs.chmodSync(runner, 0o755);
  const env = createSmithersTestEnvironment(runner, { PATH: process.env.PATH });
  const startedAt = Date.now();
  await assert.rejects(
    streamSmithersCommand({
      args: ["events", "run-id", "--json"],
      projectRoot: root,
      env,
      maxLines: 10,
      onLine: () => new Promise<void>(() => undefined)
    }),
    /bounded drain deadline/u
  );
  assert.ok(Date.now() - startedAt < 3_000);
});

async function assertProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.throws(
    () => process.kill(pid, 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH"
  );
}
