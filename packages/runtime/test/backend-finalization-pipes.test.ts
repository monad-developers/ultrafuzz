import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CheckpointDirectory } from "../src/backend-checkpoint-files.js";
import {
  backendCheckpointDirectory,
  readBackendFinalizationStatus,
  runCheckpointedBackend,
  withBackendFinalization
} from "../src/backend-finalization.js";
import { temporaryRoot } from "./temporary-root.js";

function document<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function fixture(t: TestContext) {
  const root = temporaryRoot("backend-inherited-pipes-");
  const artifactDirectory = path.join(root, "artifacts");
  fs.mkdirSync(path.join(artifactDirectory, "backends"), { recursive: true });
  fs.writeFileSync(path.join(artifactDirectory, "backends", "result.json"), '{"completed":true}\n');
  const marker = path.join(root, "leader-exit.json");
  t.after(() => {
    if (!fs.existsSync(marker)) return;
    const { workerPid } = document<{ workerPid: number }>(marker);
    try {
      process.kill(workerPid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  });
  return {
    marker,
    directory: backendCheckpointDirectory(root, "node:campaign"),
    artifactDirectory,
    binding: "synthetic-inherited-pipes",
    timeoutMs: 1_000,
    graceMs: 800,
    args: { prompt: "synthetic backend" }
  };
}

function command(input: ReturnType<typeof fixture>, detached: boolean, exitAt = 0, code = 0): string[] {
  return [
    process.execPath,
    "-e",
    `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const worker = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], {
      stdio: 'inherit', detached: ${String(detached)}
    });
    worker.unref();
    process.stdout.write('leader stdout\\n');
    process.stderr.write('leader stderr\\n');
    setTimeout(() => {
      fs.writeFileSync(${JSON.stringify(input.marker)}, JSON.stringify({workerPid: worker.pid, exitedAt: Date.now()}));
      process.exit(${String(code)});
    }, Math.max(0, ${String(exitAt)} - Date.now()));
    `
  ];
}

test("successful leader exit reaps inherited-pipe descendants without shifting the completion timestamp", async (t) => {
  const input = fixture(t);
  const started = Date.now();
  assert.equal(
    await withBackendFinalization({
      ...input,
      generate: () => runCheckpointedBackend(input.directory, command(input, false))
    }),
    0
  );
  const receipt = document<{ completedAt: number; evidenceDirectory: string }>(
    path.join(input.directory, "completed.json")
  );
  const { exitedAt, workerPid } = document<{ exitedAt: number; workerPid: number }>(input.marker);
  assert.ok(receipt.completedAt - exitedAt < 200);
  assert.ok(Date.now() - started < input.timeoutMs);
  try {
    // An orphan can remain a zombie until the host's init reaps it.
    assert.match(fs.readFileSync(`/proc/${String(workerPid)}/stat`, "utf8"), /\) [ZX] /u);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  assert.equal(readBackendFinalizationStatus(input.directory)?.checkpoint_available, true);
  const evidence = receipt.evidenceDirectory;
  assert.match(fs.readFileSync(path.join(evidence, "stdout.log"), "utf8"), /leader stdout/u);
  assert.match(fs.readFileSync(path.join(evidence, "stderr.log"), "utf8"), /leader stderr/u);
});

test("near-deadline success admits grace before a bounded drain of escaped inherited pipes", async (t) => {
  const input = fixture(t);
  let deadline = 0;
  assert.equal(
    await withBackendFinalization({
      ...input,
      generate: async () => {
        const status = readBackendFinalizationStatus(input.directory);
        assert.ok(status !== undefined);
        deadline = status.execution_deadline_ms;
        return runCheckpointedBackend(input.directory, command(input, true, deadline - 125));
      }
    }),
    0
  );
  const receipt = document<{ completedAt: number; evidenceDirectory: string }>(
    path.join(input.directory, "completed.json")
  );
  assert.ok(receipt.completedAt <= deadline);
  assert.ok(Date.now() > deadline, "log draining must cross the original execution deadline");
  assert.ok(Date.now() < deadline + input.graceMs);
  const { exitedAt } = document<{ exitedAt: number }>(input.marker);
  assert.ok(receipt.completedAt - exitedAt < 200);
  const status = readBackendFinalizationStatus(input.directory);
  assert.equal(status?.checkpoint_available, true);
  assert.equal(status.finalization_deadline_ms, receipt.completedAt + input.graceMs);
  const evidence = receipt.evidenceDirectory;
  assert.match(fs.readFileSync(path.join(evidence, "stdout.log"), "utf8"), /log drain stopped after 250 ms/u);
});

test("a failed leader with inherited pipes never admits finalization grace", async (t) => {
  const input = fixture(t);
  await assert.rejects(
    withBackendFinalization({
      ...input,
      generate: async (args: { prompt?: unknown; abortSignal?: AbortSignal }) => {
        assert.equal(await runCheckpointedBackend(input.directory, command(input, true, 0, 7)), 7);
        assert.equal(readBackendFinalizationStatus(input.directory)?.phase, "execution");
        await delay(2_000, undefined, { signal: args.abortSignal });
      }
    }),
    /timed-out: phase=execution/u
  );
  assert.equal(fs.existsSync(path.join(input.directory, "completed.json")), false);
});

test("caller cancellation during post-exit log draining cannot publish a checkpoint", async (t) => {
  const input = fixture(t);
  const controller = new AbortController();
  await assert.rejects(
    withBackendFinalization({
      ...input,
      args: { ...input.args, abortSignal: controller.signal },
      generate: async () => {
        const launch = runCheckpointedBackend(input.directory, command(input, true));
        while (readBackendFinalizationStatus(input.directory)?.phase === "execution") await delay(5);
        assert.equal(readBackendFinalizationStatus(input.directory)?.checkpoint_available, false);
        controller.abort(new Error("operator canceled during drain"));
        return launch;
      }
    }),
    /aborted: phase=finalization/u
  );
  assert.equal(fs.existsSync(path.join(input.directory, "completed.json")), false);
  assert.equal(readBackendFinalizationStatus(input.directory)?.checkpoint_available, false);
});

test("a log write failure after successful exit cannot publish a reusable checkpoint", async (t) => {
  const input = fixture(t);
  const createLog = CheckpointDirectory.prototype.createLog;
  t.mock.method(CheckpointDirectory.prototype, "createLog", function (this: CheckpointDirectory, name: string) {
    const log = createLog.call(this, name);
    return {
      ...log,
      write: (chunk: Buffer) => {
        if (chunk.includes("log drain stopped")) throw new Error("synthetic log failure after exit");
        log.write(chunk);
      }
    };
  });
  await assert.rejects(
    withBackendFinalization({
      ...input,
      generate: () => runCheckpointedBackend(input.directory, command(input, true))
    }),
    /synthetic log failure after exit/u
  );
  assert.equal(fs.existsSync(path.join(input.directory, "completed.json")), false);
  assert.equal(readBackendFinalizationStatus(input.directory)?.checkpoint_available, false);
});
