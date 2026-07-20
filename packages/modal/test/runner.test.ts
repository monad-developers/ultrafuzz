import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  SandboxFilesystemNotFoundError,
  type App,
  type FileInfo,
  type Image,
  type Sandbox,
  type SandboxCreateParams
} from "modal";
import { describe, expect, it, vi } from "vitest";

import { fingerprintModalModel, isPublicModalBenchmarkConfig, parseModalBenchmarkConfig } from "../src/config.js";
import type { ModalModelSpec } from "../src/defaults.js";
import {
  createModalLaunchState,
  markModalSandboxCreated,
  readModalLaunchState,
  reserveModalLaunchAttempt,
  writeModalLaunchState
} from "../src/launch-state.js";
import { REMOTE_CONFIG_PATH, REMOTE_LAUNCH_READY_PATH, REMOTE_LINEAGE_PATH } from "../src/layout.js";
import { MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES } from "../src/public-bundle.js";
import {
  MODAL_COLLECT_RESULT_FILES,
  assertSanitizedModalCollectedFiles,
  assertPublicBenchmarkBundleLineage,
  createModalBenchmarkSandbox,
  createExactCandidateSourceArchive,
  createTrackedSourceArchive,
  finishReservedModalLaunch,
  launchModalBenchmark,
  modalImageBuildCommand,
  modalSandboxName,
  modalSecurityToolchainCommands,
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

describe("Modal benchmark capacity", () => {
  it("forwards the high-capacity resource profile to sandbox creation", async () => {
    const app = {} as App;
    const image = {} as Image;
    const sandbox = {} as Sandbox;
    const sandboxes = {
      create: vi.fn(async (_app: App, _image: Image, _params?: SandboxCreateParams) => sandbox)
    };

    await expect(
      createModalBenchmarkSandbox(sandboxes, app, image, {
        name: "benchmark-sandbox",
        timeoutMs: 60_000
      })
    ).resolves.toBe(sandbox);
    expect(sandboxes.create).toHaveBeenCalledWith(app, image, {
      name: "benchmark-sandbox",
      timeoutMs: 60_000,
      cpu: 16,
      cpuLimit: 16,
      memoryMiB: 32_768,
      memoryLimitMiB: 65_536
    });
  });
});

describe("Modal image source staging", () => {
  it("installs both final invariant backends alongside the Recon coverage backend", () => {
    const commands = modalSecurityToolchainCommands().join("\n");
    const standaloneDockerfile = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");

    expect(commands).toContain("Recon-Fuzz/recon-fuzzer");
    expect(commands).toContain("crytic/echidna");
    expect(commands).toContain("crytic/medusa");
    expect(standaloneDockerfile).toContain("Recon-Fuzz/recon-fuzzer");
    expect(standaloneDockerfile).toContain("crytic/echidna");
    expect(standaloneDockerfile).toContain("crytic/medusa");
  });

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

  it("bakes a clean shallow Git checkout at the exact candidate commit", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-modal-candidate-"));
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Ultrafuzz Test"], { cwd: root });
    execFileSync("git", ["config", "user.email", "ultrafuzz@example.invalid"], { cwd: root });
    fs.writeFileSync(path.join(root, ".gitignore"), "private.txt\n", "utf8");
    fs.writeFileSync(path.join(root, "tracked.txt"), "tracked\n", "utf8");
    fs.writeFileSync(path.join(root, "private.txt"), "private\n", "utf8");
    execFileSync("git", ["add", ".gitignore", "tracked.txt"], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const archive = path.join(root, "candidate.tgz");
    const extracted = path.join(root, "extracted");

    createExactCandidateSourceArchive(root, archive);
    fs.mkdirSync(extracted);
    execFileSync("tar", ["-xzf", archive, "-C", extracted]);

    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: extracted, encoding: "utf8" }).trim()).toBe(revision);
    expect(
      execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
        cwd: extracted,
        encoding: "utf8"
      })
    ).toBe("");
    expect(fs.existsSync(path.join(extracted, ".git/shallow"))).toBe(true);
    expect(fs.existsSync(path.join(extracted, "tracked.txt"))).toBe(true);
    expect(fs.existsSync(path.join(extracted, "private.txt"))).toBe(false);

    const generated = createExactCandidateSourceArchive(root);
    const generatedRoot = path.dirname(generated.path);
    expect(fs.statSync(generated.path).mode & 0o777).toBe(0o600);
    expect(fs.statSync(generatedRoot).mode & 0o777).toBe(0o700);
    generated.cleanup();
    expect(fs.existsSync(generatedRoot)).toBe(false);

    const failedArchive = path.join(root, "failed.tgz");
    expect(() =>
      createExactCandidateSourceArchive(root, failedArchive, {
        createTar: () => {
          throw new Error("injected tar failure");
        }
      })
    ).toThrow(/injected tar failure/u);
    expect(fs.existsSync(failedArchive)).toBe(false);

    const preexistingArchive = path.join(root, "preexisting.tgz");
    fs.writeFileSync(preexistingArchive, "keep me\n", "utf8");
    expect(() => createExactCandidateSourceArchive(root, preexistingArchive)).toThrow();
    expect(fs.readFileSync(preexistingArchive, "utf8")).toBe("keep me\n");

    fs.writeFileSync(path.join(root, "tracked.txt"), "dirty\n", "utf8");
    expect(() => createExactCandidateSourceArchive(root, path.join(root, "dirty.tgz"))).toThrow(/tracked changes/u);
  });

  it("rejects a public configuration for a different candidate before contacting Modal", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-modal-candidate-mismatch-"));
    const configPath = path.join(root, "benchmark.json");
    fs.writeFileSync(configPath, `${JSON.stringify(publicCollectionLineage().config)}\n`);

    await expect(launchModalBenchmark({ configPath, repoRoot: path.resolve("../.."), env: {} })).rejects.toThrow(
      /exact local Git HEAD/u
    );
  });
});

describe("Modal result collection", () => {
  it("collects only sanitized status, terminal result, and generic worker log files", () => {
    expect(MODAL_COLLECT_RESULT_FILES).toEqual(["status.json", "worker.log", "result.json"]);
    expect(MODAL_COLLECT_RESULT_FILES).not.toContain("failure-details.json");
  });

  it("rejects a stale public collection config before accepting its bundle", () => {
    const lineage = publicCollectionLineage();

    expect(() => assertPublicBenchmarkBundleLineage(lineage)).not.toThrow();
    expect(() => assertPublicBenchmarkBundleLineage({ ...lineage, configFingerprint: "f".repeat(64) })).toThrow(
      /configuration fingerprint/u
    );
    expect(() =>
      assertPublicBenchmarkBundleLineage({
        ...lineage,
        state: { ...lineage.state, source_revision: "e".repeat(40) }
      })
    ).toThrow(/candidate source revision/u);
  });

  it("rejects every tampered public bundle lineage field", () => {
    const lineage = publicCollectionLineage();
    const cases: Array<[string, Partial<typeof lineage.bundle>]> = [
      ["candidate commit", { candidate_commit: "e".repeat(40) }],
      ["benchmark", { benchmark: "ultrafuzz-bench" }],
      ["lane", { lane: "full" }],
      ["experiment", { experiment: "without-kadenzipfel" }],
      ["model slug", { model_slug: "other-model" }],
      ["model", { model: "other-model" }],
      ["reasoning", { reasoning: "low" }],
      ["eval run", { eval_run_id: "stale-eval-run" }]
    ];

    for (const [diagnostic, override] of cases) {
      expect(() =>
        assertPublicBenchmarkBundleLineage({
          ...lineage,
          bundle: { ...lineage.bundle, ...override }
        })
      ).toThrow(new RegExp(diagnostic, "u"));
    }
    for (const [diagnostic, override] of [
      ["bundle logical run lineage", { logical_run_id: "other-run" }],
      ["bundle generation lineage", { generation: 2 }],
      ["bundle configuration lineage", { config_fingerprint: "e".repeat(64) }],
      ["bundle source lineage", { source_fingerprint: "e".repeat(64) }],
      ["bundle image lineage", { image_fingerprint: "e".repeat(64) }],
      ["bundle model lineage", { model_fingerprint: "e".repeat(64) }]
    ] as const) {
      expect(() =>
        assertPublicBenchmarkBundleLineage({
          ...lineage,
          bundle: { ...lineage.bundle, lineage: { ...lineage.bundle.lineage, ...override } }
        })
      ).toThrow(new RegExp(diagnostic, "u"));
    }
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

function publicCollectionLineage(): Parameters<typeof assertPublicBenchmarkBundleLineage>[0] {
  const candidateCommit = "d".repeat(40);
  const configFingerprint = "a".repeat(64);
  const config = parseModalBenchmarkConfig({
    schema_version: "ultrafuzz.modal.benchmark.v1",
    run_id: "public-eval",
    image_name: "public-image",
    braintrust: { project: "public-evals", api_key_env: "BRAINTRUST_API_KEY" },
    public_benchmark: {
      benchmark: "evmbench",
      lane: "smoke",
      runner_model_profile: MODEL.slug,
      experiment: "candidate",
      excluded_node_ids: [],
      candidate_repository: "https://github.com/monad-developers/ultrafuzz",
      candidate_commit: candidateCommit,
      max_runtime_seconds: 3600
    },
    node_timeout_seconds: 900,
    loops: 1,
    models: [MODEL]
  });
  if (!isPublicModalBenchmarkConfig(config)) throw new Error("expected a public benchmark config");
  return {
    bundle: {
      benchmark: "evmbench",
      lane: "smoke",
      experiment: "candidate",
      model_slug: MODEL.slug,
      model: MODEL.model,
      reasoning: MODEL.reasoning,
      candidate_commit: candidateCommit,
      eval_run_id: `${config.run_id}-${MODEL.slug}`,
      lineage: {
        logical_run_id: config.run_id,
        generation: 1,
        config_fingerprint: configFingerprint,
        source_fingerprint: "b".repeat(64),
        image_fingerprint: "c".repeat(64),
        model_fingerprint: fingerprintModalModel(MODEL)
      }
    },
    config,
    configFingerprint,
    state: {
      logical_run_id: config.run_id,
      generation: 1,
      source_revision: candidateCommit,
      image: config.image_name,
      fingerprints: {
        config: configFingerprint,
        source: "b".repeat(64),
        image: "c".repeat(64)
      }
    },
    launch: {
      slug: MODEL.slug,
      model: MODEL.model,
      reasoning: MODEL.reasoning,
      model_fingerprint: fingerprintModalModel(MODEL)
    }
  };
}

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

  it("rejects an oversized remote public result before reading and rechecks the returned byte length", async () => {
    const oversizedRead = vi.fn(async () => "must not be read");
    await expect(
      readOptionalModalSandboxText(
        {
          stat: vi.fn(async () => remoteFileInfo(MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES + 1)),
          readText: oversizedRead
        },
        "/data/public-results.json",
        MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES
      )
    ).rejects.toThrow(/exceeds the size limit/u);
    expect(oversizedRead).not.toHaveBeenCalled();

    await expect(
      readOptionalModalSandboxText(
        {
          stat: vi.fn(async () => remoteFileInfo(4)),
          readText: vi.fn(async () => "grown")
        },
        "/data/public-results.json",
        4
      )
    ).rejects.toThrow(/exceeds the size limit/u);
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

function remoteFileInfo(size: number): FileInfo {
  return {
    name: "public-results.json",
    path: "/data/public-results.json",
    type: "file",
    size,
    mode: 0o600,
    permissions: "rw-------",
    owner: "ubuntu",
    group: "ubuntu",
    modifiedTime: 0,
    symlinkTarget: null
  };
}
