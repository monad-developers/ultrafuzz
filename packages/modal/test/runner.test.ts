import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SandboxFilesystemNotFoundError, type Sandbox } from "modal";
import { describe, expect, it, vi } from "vitest";

import { fingerprintModalModel } from "../src/config.js";
import type { ModalModelSpec } from "../src/defaults.js";
import {
  createModalLaunchState,
  markModalSandboxCreated,
  readModalLaunchState,
  reserveModalLaunchAttempt,
  writeModalLaunchState
} from "../src/launch-state.js";
import { REMOTE_CONFIG_PATH, REMOTE_LAUNCH_READY_PATH, REMOTE_LINEAGE_PATH } from "../src/layout.js";
import {
  MODAL_COLLECT_RESULT_FILES,
  assertSanitizedModalCollectedFiles,
  createTrackedSourceArchive,
  finishReservedModalLaunch,
  modalImageBuildCommand,
  modalSandboxName,
  modalVolumeRelativeRoot,
  modalWorkerEntrypointCommand,
  readOptionalModalSandboxText,
  replaceSanitizedModalCollectedFiles
} from "../src/runner.js";

const MODEL: ModalModelSpec = {
  slug: "model-one",
  model: "model-placeholder",
  provider: "openai",
  agent: "CodexAgent",
  reasoning: "high",
  auth_mode: "api-key"
};

describe("Modal image source staging", () => {
  it("archives tracked files only", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-modal-archive-"));
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    fs.writeFileSync(path.join(root, ".gitignore"), ".private/\n", "utf8");
    fs.writeFileSync(path.join(root, "tracked.txt"), "tracked\n", "utf8");
    fs.writeFileSync(path.join(root, "untracked.txt"), "untracked\n", "utf8");
    fs.mkdirSync(path.join(root, ".private"));
    fs.writeFileSync(path.join(root, ".private", "benchmark.json"), "private\n", "utf8");
    execFileSync("git", ["add", ".gitignore", "tracked.txt"], { cwd: root });
    const archive = path.join(root, "source.tgz");

    createTrackedSourceArchive(root, archive);
    const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");

    expect(entries).toEqual(expect.arrayContaining([".gitignore", "tracked.txt"]));
    expect(entries).not.toContain("untracked.txt");
    expect(entries).not.toContain(".private/benchmark.json");
  });
});

describe("Modal result collection", () => {
  it("collects only sanitized status, terminal result, and generic worker log files", () => {
    expect(MODAL_COLLECT_RESULT_FILES).toEqual(["status.json", "worker.log", "result.json"]);
    expect(MODAL_COLLECT_RESULT_FILES).not.toContain("failure-details.json");
  });

  it("accepts only exact-attempt aggregate contracts and generic lifecycle logs", () => {
    const context = { generation: 1, attempt: 2 };
    const base = {
      schema_version: "ultrafuzz.modal.worker-result.v2",
      generation: 4,
      launch_generation: 1,
      attempt: 2,
      model_work_started: true,
      counts: { succeeded: 1, failed: 0, remaining: 0 },
      checkpoint: { age_ms: 0, digest: `sha256:${"a".repeat(64)}` },
      runtime_ms: 100,
      usage: null
    };
    const files = {
      "status.json": `${JSON.stringify({
        ...base,
        result_type: "partial",
        exit_category: "live",
        diagnostic_code: "worker-live"
      })}\n`,
      "result.json": `${JSON.stringify({
        ...base,
        generation: 5,
        result_type: "terminal",
        exit_category: "finished",
        diagnostic_code: "worker-finished"
      })}\n`,
      "worker.log": "2026-01-01T00:00:00.000Z worker-started\n"
    };

    expect(() => assertSanitizedModalCollectedFiles(files, context)).not.toThrow();
    expect(() => assertSanitizedModalCollectedFiles({ ...files, "result.json": '{"legacy":true}\n' }, context)).toThrow(
      /unsanitized Modal result/u
    );
    expect(() =>
      assertSanitizedModalCollectedFiles({ ...files, "worker.log": "unexpected detail\n" }, context)
    ).toThrow(/unsanitized Modal worker log/u);
  });

  it("atomically replaces allowlisted files and removes a stale terminal artifact", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-modal-collect-"));
    const output = path.join(root, "model-one");
    fs.mkdirSync(output, { mode: 0o755 });
    fs.writeFileSync(path.join(output, "result.json"), '{"legacy":true}\n', { mode: 0o644 });
    fs.writeFileSync(path.join(output, "failure-details.json"), "{}\n", { mode: 0o644 });
    const status = {
      schema_version: "ultrafuzz.modal.worker-result.v2",
      result_type: "partial",
      generation: 1,
      launch_generation: 1,
      attempt: 1,
      model_work_started: false,
      counts: { succeeded: 0, failed: 0, remaining: 0 },
      checkpoint: { age_ms: null, digest: null },
      exit_category: "live",
      runtime_ms: 0,
      usage: null,
      diagnostic_code: "worker-live"
    };

    await replaceSanitizedModalCollectedFiles(
      output,
      { "status.json": `${JSON.stringify(status)}\n`, "worker.log": "" },
      { generation: 1, attempt: 1 }
    );

    expect(fs.existsSync(path.join(output, "result.json"))).toBe(false);
    expect(fs.existsSync(path.join(output, "failure-details.json"))).toBe(false);
    expect(fs.statSync(output).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(output, "status.json")).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(output).filter((name) => name.startsWith(".collect-"))).toEqual([]);
  });
});

describe("Modal worker identity", () => {
  it("makes the compiled source tree readable by the non-root worker", () => {
    expect(modalImageBuildCommand()).toContain("chown -R ubuntu:ubuntu /opt/ultrafuzz");
  });

  it("stages as root and executes the worker as the non-root image user", () => {
    const command = modalWorkerEntrypointCommand("anthropic");

    expect(command).toContain('chown -R ubuntu:ubuntu "$data_root"');
    expect(command).toContain("chown -R ubuntu:ubuntu '/run/ultrafuzz-auth/claude'");
    expect(command).toContain("runuser -u ubuntu -- env HOME='/home/ubuntu'");
    expect(command).toContain("/opt/ultrafuzz/packages/modal/dist/worker.js");
    expect(command).toContain("/run/ultrafuzz-config/lineage.json");
    expect(command).toContain("/run/ultrafuzz-config/launch-ready");
    expect(command).toContain("staging_deadline=$((SECONDS + 900))");
    expect(command).toContain("if (( SECONDS >= staging_deadline ))");
    expect(command.match(/wait_for_staged_input '\/run\//gu)).toHaveLength(4);
    expect(() => execFileSync("bash", ["-n", "-c", command])).not.toThrow();
  });

  it("publishes worker readiness only after launch state and all staged inputs are durable", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-modal-staging-"));
    const configPath = path.join(root, "benchmark.json");
    const statePath = path.join(root, "launch-state.json");
    fs.writeFileSync(configPath, "{}\n", { mode: 0o600 });
    const state = createModalLaunchState({
      logicalRunId: "logical-run",
      generation: 1,
      generationMode: "resume",
      app: "app-placeholder",
      image: "image-placeholder",
      imageId: "image-id-placeholder",
      timeoutMs: 60_000,
      sourceRevision: "revision-placeholder",
      fingerprints: { config: "a".repeat(64), source: "b".repeat(64), image: "c".repeat(64) }
    });
    const record = reserveModalLaunchAttempt({
      state,
      model: MODEL,
      modelFingerprint: fingerprintModalModel(MODEL),
      volumeName: "volume-placeholder",
      remoteRoot: "/data/logical-run/model-one",
      workspaceMode: "resume",
      attemptId: "attempt-one"
    });
    markModalSandboxCreated(record, "sandbox-one");
    await writeModalLaunchState(statePath, state);

    const copied: string[] = [];
    let readinessObservedDurableState = false;
    const sandbox = {
      filesystem: {
        readText: vi.fn(async () => {
          throw new SandboxFilesystemNotFoundError("missing");
        }),
        copyFromLocal: vi.fn(async (_localPath: string, remotePath: string) => {
          if (remotePath === REMOTE_LAUNCH_READY_PATH) {
            const persisted = await readModalLaunchState(statePath);
            readinessObservedDurableState = persisted?.launches[0]?.phase === "launched";
          }
          copied.push(remotePath);
        })
      },
      exec: vi.fn(async () => ({
        stdin: new WritableStream<string>(),
        stdout: emptyReadableStream(),
        stderr: emptyReadableStream(),
        wait: async () => 0
      })),
      detach: vi.fn()
    } as unknown as Sandbox;

    await finishReservedModalLaunch({ configPath, statePath, state }, record, sandbox);

    expect(copied).toEqual([REMOTE_CONFIG_PATH, REMOTE_LINEAGE_PATH, REMOTE_LAUNCH_READY_PATH]);
    expect(readinessObservedDurableState).toBe(true);
    expect((await readModalLaunchState(statePath))?.launches[0]?.phase).toBe("launched");
    expect(sandbox.detach).toHaveBeenCalledTimes(1);
  });

  it("treats only an explicit remote not-found as an absent persisted file", async () => {
    await expect(
      readOptionalModalSandboxText(
        {
          readText: async () => {
            throw new SandboxFilesystemNotFoundError("missing");
          }
        },
        "/data/status.json"
      )
    ).resolves.toBeUndefined();

    const failure = new Error("generic remote read failure");
    await expect(
      readOptionalModalSandboxText(
        {
          readText: async () => {
            throw failure;
          }
        },
        "/data/status.json"
      )
    ).rejects.toBe(failure);
  });

  it("gives each generation attempt a bounded unique sandbox name", () => {
    const first = modalSandboxName("logical-run", {
      slug: "model-one",
      generation: 1,
      attempt: 1,
      attempt_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    });
    const second = modalSandboxName("logical-run", {
      slug: "model-one",
      generation: 1,
      attempt: 2,
      attempt_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    });
    expect(first.length).toBeLessThanOrEqual(64);
    expect(first).not.toBe(second);
  });

  it("maps only /data children into the volume-relative root", () => {
    expect(modalVolumeRelativeRoot("/data/run-one/model-one")).toBe("run-one/model-one");
    expect(() => modalVolumeRelativeRoot("/outside/run-one")).toThrow("must be a child of /data");
  });
});

function emptyReadableStream(): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      controller.close();
    }
  });
}
