import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runSmithersLifecycleCommand } from "../src/smithers.js";
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
    onDetachedInvocation: () => callbacks.push("detached-submission")
  });

  assert.deepEqual(callbacks, ["prepare-spawned", "detached-submission"]);
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
      onDetachedInvocation: () => callbacks.push("detached-submission")
    }),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 19);
      assert.match((error as { stderr?: string }).stderr ?? "", /detached resume failed/u);
      return true;
    }
  );

  assert.deepEqual(callbacks, ["prepare-spawned", "detached-submission"]);
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
