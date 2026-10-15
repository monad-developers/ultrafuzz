import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { temporaryRoot } from "./temporary-root.js";
import { CheckpointDirectory } from "../src/backend-checkpoint-files.js";
import {
  backendCheckpointDirectory,
  readBackendFinalizationStatus,
  runCheckpointedBackend,
  withBackendFinalization
} from "../src/backend-finalization.js";

function fixture(timeoutMs = 2_000) {
  const root = temporaryRoot("backend-adversarial-");
  const artifactDirectory = path.join(root, "artifacts");
  fs.mkdirSync(path.join(artifactDirectory, "backends"), { recursive: true });
  fs.writeFileSync(path.join(artifactDirectory, "backends", "result.json"), '{"result":"original"}\n');
  return {
    root,
    directory: backendCheckpointDirectory(root, "node:campaign"),
    artifactDirectory,
    binding: "synthetic-sealed-task",
    timeoutMs,
    graceMs: 600,
    args: { prompt: "test" }
  };
}

function document<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

test("an ancestor swap during atomic publication cannot redirect writes outside the held directory", (t) => {
  const input = fixture();
  const owned = path.join(input.root, "owned");
  const moved = path.join(input.root, "moved");
  const outside = path.join(input.root, "outside");
  fs.mkdirSync(owned);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "result"), "untouched");
  const directory = CheckpointDirectory.open(owned);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (source: fs.PathLike, destination: fs.PathLike) => {
    rename(owned, moved);
    fs.symlinkSync(outside, owned);
    rename(source, destination);
  });
  try {
    assert.throws(() => directory.write("result", Buffer.from("checkpoint")), /directory changed/u);
  } finally {
    directory.close();
  }
  assert.equal(fs.readFileSync(path.join(outside, "result"), "utf8"), "untouched");
  assert.equal(fs.readFileSync(path.join(moved, "result"), "utf8"), "checkpoint");
});

test("descriptor reads reject file replacement across capture", (t) => {
  const input = fixture();
  const file = path.join(input.artifactDirectory, "file");
  fs.writeFileSync(file, "captured bytes");
  const directory = CheckpointDirectory.open(input.artifactDirectory);
  const read = fs.readSync;
  t.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => {
    const count = read(...args);
    fs.renameSync(file, `${file}.previous`);
    fs.writeFileSync(file, "replacement");
    return count;
  });
  try {
    assert.throws(() => directory.read("file"), /file changed/u);
  } finally {
    directory.close();
  }
});
function receipt(directory: string) {
  return document<{ evidenceDirectory: string }>(path.join(directory, "completed.json"));
}
async function succeed(input: ReturnType<typeof fixture>) {
  await withBackendFinalization({
    ...input,
    generate: () =>
      runCheckpointedBackend(input.directory, [process.execPath, "-e", "process.stdout.write('backend log')"])
  });
}

test("a failed launch is reaped and cannot publish a completion receipt", async () => {
  const input = fixture();
  await withBackendFinalization({
    ...input,
    generate: async () => {
      await assert.rejects(
        runCheckpointedBackend(input.directory, [path.join(input.root, "nonexistent-backend")]),
        /ENOENT/u
      );
    }
  });
  assert.equal(fs.existsSync(path.join(input.directory, "completed.json")), false);
});

for (const evidenceReady of [false, true]) {
  test(`task-authored completion cannot admit grace (evidenceReady=${String(evidenceReady)})`, async () => {
    const input = fixture(200);
    await assert.rejects(
      withBackendFinalization({
        ...input,
        generate: async (args: { prompt?: unknown; abortSignal?: AbortSignal }) => {
          const active = document<{ token: string; binding: string }>(path.join(input.directory, "active.json"));
          fs.writeFileSync(
            path.join(input.directory, "completed.json"),
            JSON.stringify({
              version: 1,
              token: active.token,
              binding: active.binding,
              completedAt: Date.now(),
              exitCode: 0,
              evidenceReady,
              evidenceDirectory: path.join(input.directory, active.token),
              manifest: [],
              proof: "0".repeat(64)
            })
          );
          await delay(400, undefined, { signal: args.abortSignal });
          return "forged";
        }
      }),
      /timed-out: phase=execution/u
    );
    assert.equal(readBackendFinalizationStatus(input.directory)?.checkpoint_available, false);
  });
}

test("editing active policy cannot extend the runtime-owned execution deadline", async () => {
  const input = fixture(250);
  const pidFile = path.join(input.root, "pid");
  await assert.rejects(
    withBackendFinalization({
      ...input,
      generate: async (args: { prompt?: unknown; abortSignal?: AbortSignal }) => {
        const policyFile = path.join(input.directory, "active.json");
        const active = document<Record<string, unknown>>(policyFile);
        fs.writeFileSync(policyFile, JSON.stringify({ ...active, executionDeadline: Date.now() + 60_000 }));
        await runCheckpointedBackend(input.directory, [
          process.execPath,
          "-e",
          "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)",
          pidFile
        ]);
        await delay(1_000, undefined, { signal: args.abortSignal });
      }
    }),
    /timed-out: phase=execution/u
  );
  assert.equal(fs.existsSync(path.join(input.directory, "completed.json")), false);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

for (const mutation of ["modified", "missing", "extra", "log", "manifest", "hardlink", "symlink"]) {
  test(`finalization retry rejects ${mutation} evidence before restoration or generation`, async () => {
    const input = fixture();
    await succeed(input);
    const snapshot = receipt(input.directory).evidenceDirectory;
    const checkpoint = path.join(snapshot, "canonical", "backends", "result.json");
    const outside = path.join(input.root, "outside");
    fs.writeFileSync(outside, "outside must survive");
    if (mutation === "modified") fs.writeFileSync(checkpoint, "modified evidence");
    if (mutation === "missing") fs.unlinkSync(checkpoint);
    if (mutation === "extra") fs.writeFileSync(path.join(snapshot, "extra"), "extra evidence");
    if (mutation === "log") fs.writeFileSync(path.join(snapshot, "stdout.log"), "modified log");
    if (mutation === "manifest") {
      const file = path.join(input.directory, "completed.json");
      fs.writeFileSync(file, JSON.stringify({ ...document<Record<string, unknown>>(file), manifest: [] }));
    }
    if (mutation === "hardlink" || mutation === "symlink") {
      fs.unlinkSync(checkpoint);
      if (mutation === "hardlink") fs.linkSync(outside, checkpoint);
      else fs.symlinkSync(outside, checkpoint);
    }
    fs.unlinkSync(path.join(input.artifactDirectory, "backends", "result.json"));
    let called = false;
    await assert.rejects(
      withBackendFinalization({
        ...input,
        generate: async () => {
          called = true;
          await delay(0);
        }
      })
    );
    assert.equal(called, false);
    assert.equal(readBackendFinalizationStatus(input.directory)?.checkpoint_available, false);
    assert.equal(readBackendFinalizationStatus(input.directory)?.phase, "failed");
    assert.equal(fs.existsSync(path.join(input.artifactDirectory, "backends", "result.json")), false);
    assert.equal(fs.readFileSync(outside, "utf8"), "outside must survive");
  });
}

for (const variant of ["dangling-symlink", "hardlink", "directory-symlink"]) {
  test(`checkpoint capture cannot write through a ${variant} destination`, async () => {
    const input = fixture();
    const outside = path.join(input.root, "outside");
    if (variant === "hardlink") fs.writeFileSync(outside, "must survive");
    if (variant === "directory-symlink") fs.mkdirSync(outside);
    await withBackendFinalization({
      ...input,
      generate: async () => {
        const launch = runCheckpointedBackend(input.directory, [
          process.execPath,
          "-e",
          `
          const fs = require('fs'), path = require('path');
          const directory = process.argv[1], outside = process.argv[2], variant = process.argv[3];
          const policy = JSON.parse(fs.readFileSync(path.join(directory, 'active.json'), 'utf8'));
          const canonical = path.join(directory, policy.token, 'canonical');
          fs.mkdirSync(canonical, {recursive: true});
          if (variant === 'directory-symlink') fs.symlinkSync(outside, path.join(canonical, 'backends'));
          else {
            const target = path.join(canonical, 'backends', 'result.json');
            fs.mkdirSync(path.dirname(target));
            if (variant === 'hardlink') fs.linkSync(outside, target); else fs.symlinkSync(outside, target);
          }
        `,
          input.directory,
          outside,
          variant
        ]);
        if (variant === "directory-symlink") await assert.rejects(launch);
        else assert.equal(await launch, 0);
      }
    });
    if (variant === "hardlink") assert.equal(fs.readFileSync(outside, "utf8"), "must survive");
    if (variant === "dangling-symlink") assert.equal(fs.existsSync(outside), false);
    if (variant === "directory-symlink") assert.deepEqual(fs.readdirSync(outside), []);
  });
}

test("retry restoration atomically replaces destination links without modifying their external targets", async () => {
  const input = fixture();
  await succeed(input);
  const destination = path.join(input.artifactDirectory, "backends", "result.json");
  for (const variant of ["hardlink", "symlink"]) {
    const outside = path.join(input.root, variant);
    if (variant === "hardlink") fs.writeFileSync(outside, "untouched");
    fs.unlinkSync(destination);
    if (variant === "hardlink") fs.linkSync(outside, destination);
    else fs.symlinkSync(outside, destination);
    await withBackendFinalization({
      ...input,
      generate: async () => {
        await delay(0);
      }
    });
    assert.equal(fs.readFileSync(destination, "utf8"), '{"result":"original"}\n');
    if (variant === "hardlink") assert.equal(fs.readFileSync(outside, "utf8"), "untouched");
    else assert.equal(fs.existsSync(outside), false);
  }
});

function launchClient(input: ReturnType<typeof fixture>, pidFile: string): ChildProcess {
  const moduleUrl = new URL("../src/backend-finalization.js", import.meta.url).href;
  const backend =
    "require('fs').writeFileSync(process.argv[1], String(process.pid)); process.on('SIGTERM', () => {}); setTimeout(() => {}, 10000)";
  return spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { runCheckpointedBackend } from ${JSON.stringify(moduleUrl)};
    process.exitCode = await runCheckpointedBackend(process.argv[1], [process.execPath, '-e', process.argv[3], process.argv[2]]);
  `,
      input.directory,
      pidFile,
      backend
    ],
    { stdio: "ignore" }
  );
}

async function waitPid(file: string): Promise<number> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (fs.existsSync(file)) return Number(fs.readFileSync(file, "utf8"));
    await delay(5);
  }
  throw new Error("backend did not launch");
}

for (const signal of ["SIGKILL", "SIGTERM"] as const) {
  test(`the surviving runtime reaps the backend when its wrapper receives ${signal}`, async () => {
    const input = fixture(3_000);
    const pidFile = path.join(input.root, "backend.pid");
    await withBackendFinalization({
      ...input,
      generate: async () => {
        const client = launchClient(input, pidFile);
        const closed = new Promise((resolve) => client.once("close", resolve));
        const pid = await waitPid(pidFile);
        client.kill(signal);
        await closed;
        await delay(450);
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
        assert.equal(fs.existsSync(path.join(input.directory, "completed.json")), false);
      }
    });
  });
}

test("operator cancellation kills a running backend that ignores SIGTERM and never checkpoints success", async () => {
  const input = fixture(3_000);
  const controller = new AbortController();
  const pidFile = path.join(input.root, "backend.pid");
  let pid: number | undefined;
  await assert.rejects(
    withBackendFinalization({
      ...input,
      args: { ...input.args, abortSignal: controller.signal },
      generate: async () => {
        const client = launchClient(input, pidFile);
        const closed = new Promise((resolve) => client.once("close", resolve));
        pid = await waitPid(pidFile);
        controller.abort(new Error("operator cancel"));
        await closed;
      }
    }),
    /aborted: phase=execution/u
  );
  assert.ok(pid !== undefined);
  const backendPid = pid;
  assert.throws(() => process.kill(backendPid, 0), { code: "ESRCH" });
  assert.equal(fs.existsSync(path.join(input.directory, "completed.json")), false);
});

test("a new runtime process cannot authenticate old writable checkpoint state", async () => {
  const input = fixture();
  await succeed(input);
  const moduleUrl = new URL("../src/backend-finalization.js", import.meta.url).href;
  const client = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { withBackendFinalization } from ${JSON.stringify(moduleUrl)};
    try { await withBackendFinalization({...JSON.parse(process.argv[1]), generate: async () => {}}); process.exitCode = 2; }
    catch (error) { process.exitCode = /authentication failed/.test(error.message) ? 0 : 3; }
  `,
      JSON.stringify(input)
    ],
    { stdio: "ignore" }
  );
  assert.equal(await new Promise((resolve) => client.once("close", resolve)), 0);
  assert.equal(
    fs.readFileSync(
      path.join(receipt(input.directory).evidenceDirectory, "canonical", "backends", "result.json"),
      "utf8"
    ),
    '{"result":"original"}\n'
  );
});
