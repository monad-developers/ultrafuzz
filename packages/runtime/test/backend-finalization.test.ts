import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { temporaryRoot } from "./temporary-root.js";
import {
  backendCheckpointDirectory,
  readBackendFinalizationStatus,
  runCheckpointedBackend,
  withBackendFinalization
} from "../src/backend-finalization.js";

function fixture() {
  const root = temporaryRoot("backend-finalization");
  const artifactDirectory = path.join(root, "artifacts");
  const backendDirectory = path.join(artifactDirectory, "backends", "synthetic");
  fs.mkdirSync(backendDirectory, { recursive: true });
  fs.writeFileSync(path.join(backendDirectory, "result.json"), '{"completed":true}\n');
  fs.writeFileSync(path.join(artifactDirectory, "campaign-plan.json"), '{"command":"synthetic"}\n');
  return {
    directory: backendCheckpointDirectory(root, "node:campaign"),
    artifactDirectory,
    binding: "sealed-task-source-and-prompt",
    timeoutMs: 1_000,
    graceMs: 800,
    args: { prompt: "run campaign" }
  };
}

test("backend status timestamps must be representable as JavaScript dates", () => {
  const directory = temporaryRoot("backend-status-date-range-");
  const statusPath = path.join(directory, "status.json");
  const status = {
    phase: "finalization",
    started_at_ms: 1_000,
    execution_deadline_ms: 2_000,
    finalization_deadline_ms: 2_500,
    finalization_grace_ms: 500,
    last_activity_at_ms: 1_900,
    checkpoint_available: true
  };
  for (const field of ["started_at_ms", "execution_deadline_ms", "finalization_deadline_ms", "last_activity_at_ms"]) {
    for (const value of [0, 8_640_000_000_000_000]) {
      const boundary = { ...status, [field]: value };
      fs.writeFileSync(statusPath, JSON.stringify(boundary));
      assert.deepEqual(readBackendFinalizationStatus(directory), boundary);
      assert.doesNotThrow(() => new Date(value).toISOString());
    }
    for (const value of [8_640_000_000_000_001, 9_000_000_000_000_000, Number.MAX_SAFE_INTEGER]) {
      fs.writeFileSync(statusPath, JSON.stringify({ ...status, [field]: value }));
      assert.throws(() => readBackendFinalizationStatus(directory), { name: "ZodError" }, `${field}=${String(value)}`);
    }
  }
  fs.writeFileSync(statusPath, JSON.stringify({ ...status, finalization_deadline_ms: null }));
  assert.equal(readBackendFinalizationStatus(directory)?.finalization_deadline_ms, null);
});

function assertPhaseTimeout(error: unknown, phase: string): boolean {
  assert.ok(error instanceof Error);
  assert.equal("code" in error ? error.code : undefined, "PROCESS_TIMEOUT");
  assert.match(error.message, new RegExp(`phase=${phase}`, "u"));
  assert.match(error.message, /elapsed_ms=\d+.*execution_deadline_ms=\d+/u);
  assert.match(error.message, /finalization_deadline_ms=.*last_activity_at_ms=\d+/u);
  return true;
}

test("a backend finishing near execution deadline checkpoints evidence and finalizes within fixed grace", async () => {
  const input = fixture();
  const started = Date.now();
  const result = await withBackendFinalization({
    ...input,
    generate: async (args) => {
      assert.match(args.prompt, /ultrafuzz backend run/u);
      assert.equal(
        await runCheckpointedBackend(input.directory, [process.execPath, "-e", "setTimeout(() => {}, 700)"]),
        0
      );
      await delay(500);
      const state = readBackendFinalizationStatus(input.directory);
      assert.equal(state?.phase, "finalization");
      assert.equal(state.checkpoint_available, true);
      assert.ok(state.finalization_deadline_ms !== null);
      assert.ok(state.finalization_deadline_ms <= state.execution_deadline_ms + input.graceMs);
      fs.writeFileSync(path.join(input.artifactDirectory, "final.json"), '{"validated":true}\n');
      return "finalized";
    }
  });
  assert.equal(result, "finalized");
  assert.ok(Date.now() - started > input.timeoutMs);
  assert.equal(readBackendFinalizationStatus(input.directory)?.phase, "completed");
  const snapshots = fs
    .readdirSync(input.directory)
    .filter((name) => fs.lstatSync(path.join(input.directory, name)).isDirectory());
  assert.equal(snapshots.length, 1);
  const snapshot = snapshots[0];
  assert.ok(snapshot !== undefined);
  assert.equal(
    fs.readFileSync(path.join(input.directory, snapshot, "canonical", "backends", "synthetic", "result.json"), "utf8"),
    '{"completed":true}\n'
  );
});

test("active logs and provider-like backoff do not admit or renew finalization grace", async () => {
  const input = fixture();
  const started = Date.now();
  let aborted = false;
  await assert.rejects(
    withBackendFinalization({
      ...input,
      timeoutMs: 200,
      generate: async (args: { prompt?: unknown; abortSignal?: AbortSignal; onStdout?: (text: string) => void }) => {
        const heartbeat = setInterval(() => {
          args.onStdout?.("provider retry / heartbeat");
        }, 20);
        try {
          await delay(2_000, undefined, { signal: args.abortSignal });
        } finally {
          clearInterval(heartbeat);
          aborted = args.abortSignal?.aborted === true;
        }
      }
    }),
    (error) => assertPhaseTimeout(error, "execution")
  );
  await delay(0);
  assert.equal(aborted, true);
  assert.ok(Date.now() - started < 800);
  assert.equal(readBackendFinalizationStatus(input.directory)?.checkpoint_available, false);
});

test("finalization timeout preserves completed backend evidence for a bounded finalization-only retry", async () => {
  const input = { ...fixture(), timeoutMs: 500, graceMs: 400 };
  let launches = 0;
  await assert.rejects(
    withBackendFinalization({
      ...input,
      generate: async (args: { prompt?: unknown; abortSignal?: AbortSignal; onStdout?: (text: string) => void }) => {
        launches += 1;
        assert.equal(
          await runCheckpointedBackend(input.directory, [process.execPath, "-e", "setTimeout(() => {}, 300)"]),
          0
        );
        const heartbeat = setInterval(() => {
          args.onStdout?.("finalization heartbeat");
        }, 20);
        try {
          await delay(2_000, undefined, { signal: args.abortSignal });
        } finally {
          clearInterval(heartbeat);
        }
      }
    }),
    (error) => assertPhaseTimeout(error, "finalization")
  );
  assert.equal(readBackendFinalizationStatus(input.directory)?.checkpoint_available, true);
  // Model the existing retry cleanup. The checkpoint is deliberately outside
  // this canonical artifact tree; only raw evidence is restored, never output
  // validation markers or a producer-success result.
  fs.rmSync(path.join(input.artifactDirectory, "backends"), { recursive: true });
  fs.unlinkSync(path.join(input.artifactDirectory, "campaign-plan.json"));
  assert.equal(
    await withBackendFinalization({
      ...input,
      generate: async (args) => {
        assert.match(args.prompt, /Do not rerun fuzzing/u);
        assert.equal(
          fs.readFileSync(path.join(input.artifactDirectory, "backends", "synthetic", "result.json"), "utf8"),
          '{"completed":true}\n'
        );
        await assert.rejects(
          runCheckpointedBackend(input.directory, [process.execPath, "-e", "process.exit(0)"]),
          /already completed/u
        );
        await delay(20);
        return "finalized-without-rerun";
      }
    }),
    "finalized-without-rerun"
  );
  assert.equal(launches, 1);
  const status = readBackendFinalizationStatus(input.directory);
  assert.ok(status !== undefined && status.finalization_deadline_ms !== null);
  assert.equal(status.finalization_deadline_ms - status.started_at_ms, input.graceMs);
});

test("a failed backend cannot admit grace and a stale binding cannot reuse evidence", async () => {
  const input = { ...fixture(), timeoutMs: 300, graceMs: 700 };
  await assert.rejects(
    withBackendFinalization({
      ...input,
      generate: async (args: { prompt?: unknown; abortSignal?: AbortSignal }) => {
        assert.equal(await runCheckpointedBackend(input.directory, [process.execPath, "-e", "process.exit(7)"]), 7);
        await delay(2_000, undefined, { signal: args.abortSignal });
      }
    }),
    (error) => assertPhaseTimeout(error, "execution")
  );
  assert.equal(fs.existsSync(path.join(input.directory, "completed.json")), false);
  await withBackendFinalization({
    ...input,
    generate: async () => runCheckpointedBackend(input.directory, [process.execPath, "-e", "process.exit(0)"])
  });
  await withBackendFinalization({
    ...input,
    binding: "different-sealed-task",
    generate: async (args) => {
      assert.doesNotMatch(args.prompt, /already exists/u);
      assert.equal(readBackendFinalizationStatus(input.directory)?.phase, "execution");
      await runCheckpointedBackend(input.directory, [process.execPath, "-e", "process.exit(0)"]);
    }
  });
});

test("caller cancellation remains authoritative during finalization", async () => {
  const input = fixture();
  const controller = new AbortController();
  await assert.rejects(
    withBackendFinalization({
      ...input,
      args: { ...input.args, abortSignal: controller.signal },
      generate: async (args) => {
        await runCheckpointedBackend(input.directory, [process.execPath, "-e", "process.exit(0)"]);
        await delay(120);
        controller.abort(new Error("operator canceled"));
        await delay(2_000, undefined, { signal: args.abortSignal });
      }
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal("code" in error ? error.code : undefined, "TASK_ABORTED");
      assert.match(error.message, /phase=finalization/u);
      return true;
    }
  );
  assert.equal(readBackendFinalizationStatus(input.directory)?.phase, "aborted");
});

test("zero grace preserves the existing adapter contract without checkpoint state", async () => {
  const input = fixture();
  await withBackendFinalization({
    ...input,
    graceMs: 0,
    generate: async (args) => {
      assert.equal(args, input.args);
      await delay(0);
    }
  });
  assert.equal(fs.existsSync(input.directory), false);
});

test("raw backend logs are bounded without turning successful completion into a failure", async () => {
  const input = { ...fixture(), timeoutMs: 3_000 };
  await withBackendFinalization({
    ...input,
    generate: async () =>
      runCheckpointedBackend(input.directory, [
        process.execPath,
        "-e",
        "process.stdout.write(Buffer.alloc(17 * 1024 * 1024, 65))"
      ])
  });
  const snapshot = fs
    .readdirSync(input.directory)
    .find((name) => fs.lstatSync(path.join(input.directory, name)).isDirectory());
  assert.ok(snapshot !== undefined);
  const log = path.join(input.directory, snapshot, "stdout.log");
  assert.ok(fs.statSync(log).size < 16 * 1024 * 1024 + 100);
  assert.match(fs.readFileSync(log).subarray(-100).toString("utf8"), /backend log truncated/u);
  assert.equal(readBackendFinalizationStatus(input.directory)?.checkpoint_available, true);
});

test("workspace-mirrored evidence is checkpointed and restored independently of canonical artifacts", async () => {
  const input = fixture();
  const mirrorArtifactDirectory = path.join(path.dirname(input.artifactDirectory), "workspace-artifacts");
  fs.mkdirSync(path.join(mirrorArtifactDirectory, "backends"), { recursive: true });
  fs.writeFileSync(path.join(mirrorArtifactDirectory, "backends", "raw.json"), '{"workspace":true}\n');
  await withBackendFinalization({
    ...input,
    mirrorArtifactDirectory,
    generate: async () => runCheckpointedBackend(input.directory, [process.execPath, "-e", "process.exit(0)"])
  });
  fs.unlinkSync(path.join(mirrorArtifactDirectory, "backends", "raw.json"));
  await withBackendFinalization({
    ...input,
    mirrorArtifactDirectory,
    generate: async () => {
      assert.equal(
        fs.readFileSync(path.join(mirrorArtifactDirectory, "backends", "raw.json"), "utf8"),
        '{"workspace":true}\n'
      );
      assert.equal(fs.existsSync(path.join(input.artifactDirectory, "backends", "raw.json")), false);
      await delay(0);
    }
  });
});

test("a finalization-only retry restores backend-time harness repairs through validated workspace patches", async () => {
  const input = fixture();
  const root = temporaryRoot("backend-source-");
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  };
  git(["init", "--quiet"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.invalid"]);
  const harness = path.join(root, "Harness.sol");
  fs.writeFileSync(harness, "initial harness\n");
  git(["add", "Harness.sol"]);
  git(["commit", "--quiet", "-m", "fixture"]);
  const workspace = { root, productionSourceRoots: ["src", "contracts"] };
  await assert.rejects(
    withBackendFinalization({
      ...input,
      workspace,
      generate: async () => {
        fs.writeFileSync(harness, "repaired harness used by backend\n");
        await runCheckpointedBackend(input.directory, [process.execPath, "-e", "process.exit(0)"]);
        throw new Error("finalization interrupted");
      }
    }),
    /finalization interrupted/u
  );
  fs.writeFileSync(harness, "initial harness\n");
  await withBackendFinalization({
    ...input,
    workspace,
    generate: async () => {
      assert.equal(fs.readFileSync(harness, "utf8"), "repaired harness used by backend\n");
      await delay(0);
    }
  });
});
