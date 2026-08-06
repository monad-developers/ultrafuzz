import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  modalLaunchTags,
  readModalLaunchState,
  reserveModalLaunchAttempt,
  writeModalLaunchState,
  type ModalWorkerStatus
} from "../src/launch-state.js";
import { REMOTE_CONFIG_PATH, REMOTE_LAUNCH_READY_PATH, REMOTE_LINEAGE_PATH, remoteAuthPath } from "../src/layout.js";
import { MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES } from "../src/public-bundle.js";
import { createModalRecoveryLifecycleDocument } from "../src/recovery-lifecycle.js";
import {
  CODEX_CLI_VERSION,
  KIMI_SHARED_CREDENTIAL_STAGE_SCRIPT,
  MODAL_COLLECT_RESULT_FILES,
  ModalTerminationError,
  assertPublicBenchmarkBundleDiagnosticsMatch,
  assertPublicBenchmarkBundleLineage,
  assertSanitizedModalCollectedFiles,
  classifyModalLaunchFailure,
  createModalBenchmarkSandbox,
  createExactCandidateSourceArchive,
  createTrackedSourceArchive,
  finishReservedModalLaunch,
  hasExactPublicDiagnosticCollectionConfig,
  isModalRecoveryResultComplete,
  launchModalBenchmark,
  modalCanonicalRecoveryProbeCommand,
  modalImageBuildTags,
  modalImageBuildCommand,
  modalSandboxName,
  modalSecurityToolchainCommands,
  modalTerminationScopesForConfig,
  modalBenchmarkSecretValues,
  modalVolumeRelativeRoot,
  modalWorkerEntrypointCommand,
  publicBenchmarkCollectionSecretValues,
  readModalCollectResultFilesWithStatusRetry,
  readOptionalModalSandboxText,
  replaceSanitizedModalCollectedFiles,
  selectModalCollectedEvidence,
  terminateModalBenchmarkSandboxes,
  terminateModalBenchmarkTagScopes
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

describe("Modal benchmark termination", () => {
  it("terminates an exact newer attempt once and ignores broader or mismatched tags", async () => {
    const { state, record } = terminationState();
    const exact = fakeTerminationSandbox("sandbox-exact", {
      ...modalLaunchTags(state, record),
      attempt: "2",
      attempt_id: "newer-attempt"
    });
    const broader = fakeTerminationSandbox("sandbox-broader", {
      purpose: "ultrafuzz-eval",
      logical_run: state.logical_run_id,
      generation: String(state.generation),
      model_slug: record.slug,
      attempt: "3",
      attempt_id: "broader-attempt"
    });
    const mismatched = fakeTerminationSandbox("sandbox-mismatch", {
      ...modalLaunchTags(state, record),
      attempt: "4",
      attempt_id: "mismatched-attempt",
      source_fingerprint: "d".repeat(64)
    });
    const stopped = fakeTerminationSandbox(
      "sandbox-stopped",
      {
        ...modalLaunchTags(state, record),
        attempt: "5",
        attempt_id: "stopped-attempt"
      },
      0
    );
    const sandboxes = fakeTerminationService([exact, exact, broader, mismatched, stopped]);
    const onTerminatedAttempt = vi.fn();

    await expect(
      terminateModalBenchmarkSandboxes({ state, appId: "app-id", sandboxes, onTerminatedAttempt })
    ).resolves.toEqual({
      scopes: 1,
      discovered: 4,
      matched: 2,
      ignored: 2,
      live: 1,
      already_stopped: 1,
      terminated: 1,
      failures: 0
    });

    expect(sandboxes.list).toHaveBeenCalledWith({
      appId: "app-id",
      tags: {
        purpose: "ultrafuzz-eval",
        logical_run: state.logical_run_id,
        generation: String(state.generation),
        model_slug: record.slug,
        config_fingerprint: state.fingerprints.config,
        source_fingerprint: state.fingerprints.source,
        image_fingerprint: state.fingerprints.image,
        model_fingerprint: record.model_fingerprint
      }
    });
    expect(exact.terminate).toHaveBeenCalledTimes(1);
    expect(stopped.terminate).not.toHaveBeenCalled();
    expect(onTerminatedAttempt).toHaveBeenCalledOnce();
    expect(onTerminatedAttempt).toHaveBeenCalledWith("newer-attempt");
    expect(broader.poll).not.toHaveBeenCalled();
    expect(broader.terminate).not.toHaveBeenCalled();
    expect(mismatched.poll).not.toHaveBeenCalled();
    expect(mismatched.terminate).not.toHaveBeenCalled();
  });

  it("attempts every exact termination before reporting aggregate failures", async () => {
    const { state, record } = terminationState();
    const failed = fakeTerminationSandbox("sandbox-failed", {
      ...modalLaunchTags(state, record),
      attempt: "2",
      attempt_id: "failed-attempt"
    });
    failed.terminate.mockRejectedValueOnce(new Error("termination unavailable"));
    const succeeded = fakeTerminationSandbox("sandbox-succeeded", {
      ...modalLaunchTags(state, record),
      attempt: "3",
      attempt_id: "succeeded-attempt"
    });
    const sandboxes = fakeTerminationService([failed, succeeded]);

    let failure: unknown;
    try {
      await terminateModalBenchmarkSandboxes({ state, appId: "app-id", sandboxes });
    } catch (error) {
      failure = error;
    }

    expect(failed.terminate).toHaveBeenCalledTimes(1);
    expect(succeeded.terminate).toHaveBeenCalledTimes(1);
    expect(failure).toBeInstanceOf(ModalTerminationError);
    expect((failure as ModalTerminationError).counts).toEqual({
      scopes: 1,
      discovered: 2,
      matched: 2,
      ignored: 0,
      live: 2,
      already_stopped: 0,
      terminated: 1,
      failures: 1
    });
    expect((failure as Error).message).not.toMatch(/sandbox-failed|sandbox-succeeded/u);
  });

  it("uses stable config lineage to terminate every valid generation and reject malformed candidates", async () => {
    const config = parseModalBenchmarkConfig({
      schema_version: "ultrafuzz.modal.benchmark.v1",
      run_id: "immutable-run",
      target: { repo: "https://github.com/example/target", ref: "main" },
      ground_truth: {
        repo: "https://github.com/example/ground-truth",
        ref: "main",
        file: "findings.yml"
      },
      braintrust: { project: "termination-test" },
      models: [MODEL]
    });
    const scopes = modalTerminationScopesForConfig(config, {
      config: "a".repeat(64),
      source: "b".repeat(64)
    });
    const exactGenerationOne = fakeTerminationSandbox("generation-one", {
      ...scopes[0]!.tags,
      generation: "1",
      attempt: "1",
      attempt_id: "attempt-one",
      image_fingerprint: "c".repeat(64)
    });
    const exactGenerationTwo = fakeTerminationSandbox("generation-two", {
      ...scopes[0]!.tags,
      generation: "2",
      attempt: "3",
      attempt_id: "attempt-three",
      image_fingerprint: "d".repeat(64)
    });
    const invalidGeneration = fakeTerminationSandbox("invalid-generation", {
      ...scopes[0]!.tags,
      generation: "0",
      attempt: "4",
      attempt_id: "invalid-generation",
      image_fingerprint: "d".repeat(64)
    });
    const mismatched = fakeTerminationSandbox("mismatched", {
      ...scopes[0]!.tags,
      generation: "3",
      attempt: "5",
      attempt_id: "mismatched",
      image_fingerprint: "e".repeat(64),
      source_fingerprint: "f".repeat(64)
    });
    const sandboxes = fakeTerminationService([exactGenerationOne, exactGenerationTwo, invalidGeneration, mismatched]);

    await expect(terminateModalBenchmarkTagScopes({ scopes, appId: "app-id", sandboxes })).resolves.toEqual({
      scopes: 1,
      discovered: 4,
      matched: 2,
      ignored: 2,
      live: 2,
      already_stopped: 0,
      terminated: 2,
      failures: 0
    });
    expect(exactGenerationOne.terminate).toHaveBeenCalledTimes(1);
    expect(exactGenerationTwo.terminate).toHaveBeenCalledTimes(1);
    expect(invalidGeneration.terminate).not.toHaveBeenCalled();
    expect(mismatched.terminate).not.toHaveBeenCalled();
  });

  it("uses direct IDs from attempt history and rejects an empty state as unconfirmed", async () => {
    const { state, record } = terminationState();
    markModalSandboxCreated(record, "historical-sandbox");
    reserveModalLaunchAttempt({
      state,
      model: MODEL,
      modelFingerprint: fingerprintModalModel(MODEL),
      volumeName: record.volume_name,
      remoteRoot: record.remote_root,
      workspaceMode: "fresh",
      attemptId: "replacement-attempt"
    });
    const historical = fakeTerminationSandbox("historical-sandbox", modalLaunchTags(state, record));
    const sandboxes = fakeTerminationService([historical], []);

    await expect(terminateModalBenchmarkSandboxes({ state, appId: "app-id", sandboxes })).resolves.toMatchObject({
      scopes: 1,
      discovered: 1,
      matched: 1,
      terminated: 1,
      failures: 0
    });
    expect(sandboxes.fromId).toHaveBeenCalledWith("historical-sandbox");

    const empty = createModalLaunchState({
      logicalRunId: "empty-run",
      generation: 1,
      generationMode: "fresh",
      app: "app-placeholder",
      image: "image-placeholder",
      imageId: "image-id-placeholder",
      timeoutMs: 60_000,
      sourceRevision: "revision-placeholder",
      fingerprints: { config: "a".repeat(64), source: "b".repeat(64), image: "c".repeat(64) }
    });
    await expect(
      terminateModalBenchmarkSandboxes({ state: empty, appId: "app-id", sandboxes: fakeTerminationService([]) })
    ).rejects.toMatchObject({ counts: { scopes: 0, failures: 1 } });
  });

  it("uses exact workflow-scoped tags for cancellable image staging", async () => {
    const tags = modalImageBuildTags({
      buildScope: "12345-2",
      imageName: "ufz-runner-candidate",
      sourceFingerprint: "a".repeat(64)
    });
    const exact = fakeTerminationSandbox("exact-build", tags);
    const other = fakeTerminationSandbox("other-build", { ...tags, build_scope: "12345-3" });
    const sandboxes = fakeTerminationService([exact, other]);

    await expect(
      terminateModalBenchmarkTagScopes({
        scopes: [{ kind: "image-build", tags }],
        appId: "app-id",
        sandboxes
      })
    ).resolves.toMatchObject({ matched: 1, ignored: 1, terminated: 1, failures: 0 });
    expect(exact.terminate).toHaveBeenCalledTimes(1);
    expect(other.terminate).not.toHaveBeenCalled();
  });
});

describe("Modal image source staging", () => {
  it("pins a Codex CLI release compatible with Smithers stdin prompts", () => {
    const commands = modalSecurityToolchainCommands().join("\n");
    const standaloneDockerfile = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    const expected = `@openai/codex@${CODEX_CLI_VERSION}`;

    expect(commands).toContain(expected);
    expect(standaloneDockerfile).toContain(expected);
    expect(commands).not.toContain("@openai/codex@0.144.3");
    expect(standaloneDockerfile).not.toContain("@openai/codex@0.144.3");
  });

  it("installs recon-fuzzer as the only fuzzing backend", () => {
    const commands = modalSecurityToolchainCommands().join("\n");
    const standaloneDockerfile = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");

    expect(commands).toContain("Recon-Fuzz/recon-fuzzer");
    expect(commands).not.toContain("crytic/echidna");
    expect(commands).not.toContain("crytic/medusa");
    expect(standaloneDockerfile).toContain("Recon-Fuzz/recon-fuzzer");
    expect(standaloneDockerfile).not.toContain("crytic/echidna");
    expect(standaloneDockerfile).not.toContain("crytic/medusa");
    expect(standaloneDockerfile).toContain("@moonshot-ai/kimi-code@0.29.1");
    expect(commands).toMatch(/apt-get install[^\n]*\bzstd\b/u);
    expect(standaloneDockerfile).toMatch(/apt-get install[\s\S]*\bzstd\b/u);
    expect(commands).toContain("RUN command -v zstd && zstd --version");
    expect(standaloneDockerfile).toContain("RUN command -v zstd");
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
    expect(MODAL_COLLECT_RESULT_FILES).toEqual([
      "status.json",
      "worker.log",
      "result.json",
      "public-eval-diagnostics.json",
      "recovery-lifecycle.json"
    ]);
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

  it("retains public diagnostics only for the exact launch config and model", () => {
    const lineage = publicCollectionLineage();
    const input = {
      config: lineage.config,
      configFingerprint: lineage.configFingerprint,
      configuredModel: MODEL,
      state: lineage.state,
      launch: { ...lineage.launch, generation: lineage.state.generation }
    };

    expect(hasExactPublicDiagnosticCollectionConfig(input)).toBe(true);
    expect(hasExactPublicDiagnosticCollectionConfig({ ...input, configFingerprint: "f".repeat(64) })).toBe(false);
    expect(
      hasExactPublicDiagnosticCollectionConfig({
        ...input,
        configuredModel: { ...MODEL, provider: "anthropic" }
      })
    ).toBe(false);
    expect(
      hasExactPublicDiagnosticCollectionConfig({
        ...input,
        state: { ...lineage.state, source_revision: "f".repeat(40) }
      })
    ).toBe(false);
  });

  it("rejects every tampered public bundle lineage field", () => {
    const lineage = publicCollectionLineage();
    const cases: Array<[string, Partial<typeof lineage.bundle>]> = [
      ["candidate commit", { candidate_commit: "e".repeat(40) }],
      ["benchmark", { benchmark: "ultrafuzz-bench" }],
      ["lane", { lane: "full" }],
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
      ["bundle attempt lineage", { attempt: 2 }],
      ["bundle attempt ID lineage", { attempt_id: "other-attempt" }],
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

  it("binds the bundled diagnostics to the exact collected attempt sidecar", () => {
    const diagnostics = '{"attempt_id":"attempt-2"}\n';
    const bundle = {
      files: [
        {
          path: "eval/public-eval-diagnostics.json",
          contents_base64: Buffer.from(diagnostics, "utf8").toString("base64")
        }
      ]
    } as unknown as Parameters<typeof assertPublicBenchmarkBundleDiagnosticsMatch>[0];

    expect(() => assertPublicBenchmarkBundleDiagnosticsMatch(bundle, diagnostics)).not.toThrow();
    expect(() => assertPublicBenchmarkBundleDiagnosticsMatch(bundle, '{"attempt_id":"attempt-3"}\n')).toThrow(
      /exact collected attempt/u
    );
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

    const diagnosticPayload = Buffer.from(
      JSON.stringify([{ code: "WORKFLOW_SUBMISSION_FAILED", message: "detached admission timed out" }]),
      "utf8"
    ).toString("base64url");
    expect(() =>
      assertSanitizedModalCollectedFiles(
        {
          ...files,
          "worker.log": `2026-01-01T00:00:00.000Z eval-failure-diagnostics ${diagnosticPayload}\n`
        },
        context
      )
    ).not.toThrow();
    const secretLikePayload = Buffer.from(
      JSON.stringify([{ code: "WORKFLOW_SUBMISSION_FAILED", message: "api_key=sk-secret-value" }]),
      "utf8"
    ).toString("base64url");
    expect(() =>
      assertSanitizedModalCollectedFiles(
        {
          ...files,
          "worker.log": `2026-01-01T00:00:00.000Z eval-failure-diagnostics ${secretLikePayload}\n`
        },
        context
      )
    ).toThrow(/unsanitized Modal worker log/u);
    const injectedSecretPayload = Buffer.from(
      JSON.stringify([{ code: "WORKFLOW_SUBMISSION_FAILED", message: "opaque-secret-that-is-not-pattern-shaped" }]),
      "utf8"
    ).toString("base64url");
    expect(() =>
      assertSanitizedModalCollectedFiles(
        {
          ...files,
          "worker.log": `2026-01-01T00:00:00.000Z eval-failure-diagnostics ${injectedSecretPayload}\n`
        },
        context,
        ["opaque-secret-that-is-not-pattern-shaped"]
      )
    ).toThrow(/unsanitized Modal worker log/u);
  });

  it("retries transient invalid live status reads before collecting", async () => {
    const context = { generation: 1, attempt: 2 };
    const validStatus = {
      schema_version: "ultrafuzz.modal.worker-result.v2",
      result_type: "partial",
      generation: 8,
      launch_generation: 1,
      attempt: 2,
      model_work_started: true,
      counts: { succeeded: 12, failed: 0, remaining: 20 },
      checkpoint: { age_ms: 0, digest: `sha256:${"a".repeat(64)}` },
      exit_category: "live",
      runtime_ms: 100,
      usage: null,
      diagnostic_code: "worker-live"
    };
    const transientStatus = {
      schema_version: "ultrafuzz.modal.worker-status.v2",
      updated_at: "2026-08-06T04:54:04.000Z",
      stage: "partial",
      category: "model-work",
      model_work_started: true,
      retryable: false,
      generation: 1,
      attempt: 2,
      node_counts: { succeeded: 12, failed: 0, remaining: 20 },
      error_code: "worker-live"
    };
    const readFiles = vi
      .fn()
      .mockResolvedValueOnce({
        "status.json": `${JSON.stringify(transientStatus)}\n`,
        "worker.log": ""
      })
      .mockResolvedValueOnce({
        "status.json": `${JSON.stringify(validStatus)}\n`,
        "worker.log": ""
      });

    const files = await readModalCollectResultFilesWithStatusRetry({
      readFiles,
      launch: context,
      maxAttempts: 2,
      retryDelayMs: 0
    });

    expect(readFiles).toHaveBeenCalledTimes(2);
    expect(() => assertSanitizedModalCollectedFiles(files, context)).not.toThrow();
  });

  it("retries transient invalid status reads even when a terminal result is present", async () => {
    const context = { generation: 1, attempt: 2 };
    const partialStatus = {
      schema_version: "ultrafuzz.modal.worker-result.v2",
      result_type: "partial",
      generation: 8,
      launch_generation: 1,
      attempt: 2,
      model_work_started: true,
      counts: { succeeded: 12, failed: 0, remaining: 20 },
      checkpoint: { age_ms: 0, digest: `sha256:${"a".repeat(64)}` },
      exit_category: "live",
      runtime_ms: 100,
      usage: null,
      diagnostic_code: "worker-live"
    };
    const terminalResult = {
      ...partialStatus,
      result_type: "terminal",
      generation: 9,
      counts: { succeeded: 32, failed: 0, remaining: 0 },
      exit_category: "finished",
      diagnostic_code: "worker-finished"
    };
    const staleStatus = {
      schema_version: "ultrafuzz.modal.worker-status.v2",
      updated_at: "2026-08-06T04:54:04.000Z",
      stage: "partial",
      category: "model-work",
      model_work_started: true,
      retryable: false,
      generation: 1,
      attempt: 2,
      node_counts: { succeeded: 12, failed: 0, remaining: 20 },
      error_code: "worker-live"
    };
    const readFiles = vi
      .fn()
      .mockResolvedValueOnce({
        "status.json": `${JSON.stringify(staleStatus)}\n`,
        "result.json": `${JSON.stringify(terminalResult)}\n`,
        "worker.log": ""
      })
      .mockResolvedValueOnce({
        "status.json": `${JSON.stringify(partialStatus)}\n`,
        "result.json": `${JSON.stringify(terminalResult)}\n`,
        "worker.log": ""
      });

    const files = await readModalCollectResultFilesWithStatusRetry({
      readFiles,
      launch: context,
      maxAttempts: 2,
      retryDelayMs: 0
    });

    expect(readFiles).toHaveBeenCalledTimes(2);
    expect(() => assertSanitizedModalCollectedFiles(files, context)).not.toThrow();
  });

  it("keeps rejecting permanently invalid collected status after bounded retries", async () => {
    const context = { generation: 1, attempt: 2 };
    const staleStatus = {
      schema_version: "ultrafuzz.modal.worker-status.v2",
      updated_at: "2026-08-06T04:54:04.000Z",
      stage: "partial",
      category: "model-work",
      model_work_started: true,
      retryable: false,
      generation: 1,
      attempt: 2,
      node_counts: { succeeded: 12, failed: 0, remaining: 20 },
      error_code: "worker-live"
    };
    const readFiles = vi.fn().mockResolvedValue({
      "status.json": `${JSON.stringify(staleStatus)}\n`,
      "worker.log": ""
    });

    const files = await readModalCollectResultFilesWithStatusRetry({
      readFiles,
      launch: context,
      maxAttempts: 2,
      retryDelayMs: 0
    });

    expect(readFiles).toHaveBeenCalledTimes(2);
    expect(() => assertSanitizedModalCollectedFiles(files, context)).toThrow(/unsanitized Modal status/u);
  });

  it("collects only an exactly reconciled privacy-safe recovery lifecycle", () => {
    const { state, record } = terminationState();
    const document = createModalRecoveryLifecycleDocument(state.recovery_lifecycle);
    const context = {
      generation: record.generation,
      attempt: record.attempt,
      logical_run_id: state.logical_run_id,
      attempt_id: record.attempt_id,
      model_slug: record.slug,
      config_fingerprint: state.fingerprints.config,
      source_fingerprint: state.fingerprints.source,
      image_fingerprint: state.fingerprints.image,
      model_fingerprint: record.model_fingerprint
    };
    const files = { "recovery-lifecycle.json": `${JSON.stringify(document)}\n` };

    expect(() => assertSanitizedModalCollectedFiles(files, context)).not.toThrow();
    expect(() =>
      assertSanitizedModalCollectedFiles(
        {
          "recovery-lifecycle.json": JSON.stringify({
            ...document,
            summary: { ...document.summary, total_generations: 2 }
          })
        },
        context
      )
    ).toThrow(/unsanitized Modal recovery lifecycle/u);
    expect(() => assertSanitizedModalCollectedFiles(files, { ...context, attempt_id: "different-attempt" })).toThrow(
      /mismatched attempt ID/u
    );
  });

  it("omits diagnostics unless an exact config supplies every injected secret value", async () => {
    const files = {
      "status.json": "status",
      "public-eval-diagnostics.json": "diagnostics"
    };
    await expect(selectModalCollectedEvidence(files, undefined, undefined, {})).resolves.toMatchObject({
      files: {
        "status.json": "status"
      },
      forbiddenSecretValues: []
    });

    const config = publicCollectionLineage().config;
    await expect(selectModalCollectedEvidence(files, config, config.models[0], {})).resolves.toMatchObject({
      files: {
        "status.json": "status"
      },
      forbiddenSecretValues: []
    });
    await expect(
      selectModalCollectedEvidence(files, config, undefined, { OPENAI_API_KEY: "opaque-secret" })
    ).resolves.toMatchObject({
      files: {
        "status.json": "status"
      },
      forbiddenSecretValues: []
    });

    const selected = await selectModalCollectedEvidence(files, config, config.models[0], {
      OPENAI_API_KEY: "opaque-secret"
    });
    expect(selected.files).toBe(files);
    expect(selected.forbiddenSecretValues).toEqual(["opaque-secret"]);
  });

  it("retains pre- and post-reconciliation Kimi subscription secrets for public collection", async () => {
    const config = publicCollectionLineage().config;
    const model: ModalModelSpec = {
      slug: "benchmark-smoke-kimi-k3-max",
      model: "kimi-k3",
      provider: "kimi",
      agent: "KimiAgent",
      reasoning: "max",
      auth_mode: "subscription"
    };
    const kimiAuthRoot = kimiSubscriptionAuthFixture("post-access", "post-refresh");

    await expect(
      publicBenchmarkCollectionSecretValues(
        {
          ...config,
          models: [model],
          public_benchmark: { ...config.public_benchmark, runner_model_profile: model.slug }
        },
        model,
        { KIMI_CODE_HOME: kimiAuthRoot, OPENAI_API_KEY: "judge-secret" },
        ["pre-access", "pre-refresh"]
      )
    ).resolves.toEqual(["pre-access", "pre-refresh", "post-access", "post-refresh", "judge-secret"]);

    const files = {
      "status.json": "status"
    };
    await expect(
      selectModalCollectedEvidence(
        files,
        {
          ...config,
          models: [model],
          public_benchmark: { ...config.public_benchmark, runner_model_profile: model.slug }
        },
        model,
        { KIMI_CODE_HOME: kimiAuthRoot, OPENAI_API_KEY: "judge-secret" },
        ["pre-access"]
      )
    ).resolves.toEqual({ files, forbiddenSecretValues: ["pre-access"] });
  });

  it("uses Moonshot API keys as Kimi public collection redaction secrets", async () => {
    const config = publicCollectionLineage().config;
    const model: ModalModelSpec = {
      slug: "kimi-k3",
      model: "kimi-k3",
      provider: "kimi",
      agent: "KimiAgent",
      reasoning: "max",
      auth_mode: "api-key"
    };

    await expect(
      publicBenchmarkCollectionSecretValues(config, model, {
        MOONSHOT_API_KEY: "moonshot-secret",
        OPENAI_API_KEY: "judge-secret"
      })
    ).resolves.toEqual(["moonshot-secret", "judge-secret"]);
    await expect(
      publicBenchmarkCollectionSecretValues(config, model, { OPENAI_API_KEY: "judge-secret" })
    ).rejects.toThrow(/KIMI_API_KEY or MOONSHOT_API_KEY/u);
  });

  it("passes Kimi API base URLs to remote Modal benchmark workers", () => {
    const config = publicCollectionLineage().config;
    const model: ModalModelSpec = {
      slug: "kimi-k3",
      model: "kimi-k3",
      provider: "kimi",
      agent: "KimiAgent",
      reasoning: "max",
      auth_mode: "api-key"
    };

    expect(
      modalBenchmarkSecretValues(config, model, {
        MOONSHOT_API_KEY: "moonshot-secret",
        OPENAI_API_KEY: "judge-secret",
        KIMI_BASE_URL: "https://kimi.example.invalid/v1/"
      })
    ).toEqual({
      KIMI_API_KEY: "moonshot-secret",
      OPENAI_API_KEY: "judge-secret",
      KIMI_BASE_URL: "https://kimi.example.invalid/v1"
    });

    expect(() =>
      modalBenchmarkSecretValues(config, model, {
        MOONSHOT_API_KEY: "moonshot-secret",
        OPENAI_API_KEY: "judge-secret",
        KIMI_BASE_URL: "http://kimi.example.invalid/v1"
      })
    ).toThrow(/KIMI_BASE_URL must be an HTTPS URL/u);
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

function kimiSubscriptionAuthFixture(accessToken: string, refreshToken: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-kimi-collection-"));
  fs.mkdirSync(path.join(root, "credentials"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "config.toml"),
    `default_model = "kimi-k3"

[providers."managed:kimi-code"]
oauth = { storage = "file", key = "oauth/kimi-code" }

[models."kimi-k3"]
provider = "managed:kimi-code"
model = "k3"
`
  );
  fs.writeFileSync(
    path.join(root, "credentials", "kimi-code.json"),
    `${JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: 2_010_000,
      expires_in: 900
    })}\n`
  );
  return root;
}

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
      model_slug: MODEL.slug,
      model: MODEL.model,
      reasoning: MODEL.reasoning,
      candidate_commit: candidateCommit,
      eval_run_id: `${config.run_id}-${MODEL.slug}`,
      lineage: {
        logical_run_id: config.run_id,
        generation: 1,
        attempt: 1,
        attempt_id: "attempt-1",
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
      attempt: 1,
      attempt_id: "attempt-1",
      model_fingerprint: fingerprintModalModel(MODEL)
    }
  };
}

describe("Modal canonical recovery probe", () => {
  it("reads durable transitions and completions independently of a stale mirrored status", () => {
    const mount = mkdtempSync(path.join(tmpdir(), "ultrafuzz-modal-recovery-probe-"));
    const remoteRoot = "/data/logical-run/model-one";
    const dataRoot = path.join(mount, "logical-run", "model-one");
    const runRoot = path.join(dataRoot, "workspace", "target", ".ultrafuzz", "runs", "durable-run");
    fs.mkdirSync(runRoot, { recursive: true });
    fs.writeFileSync(
      path.join(dataRoot, "status.json"),
      JSON.stringify({ updated_at: "2025-12-31T20:00:00.000Z", stage: "running" })
    );
    fs.writeFileSync(
      path.join(runRoot, "state.json"),
      JSON.stringify({
        status: "running",
        created_at: "2026-01-01T00:00:00.000Z",
        last_transition_at: "2026-01-01T00:09:50.000Z",
        nodes: {
          "complete-0": {
            node_id: "complete-0",
            logical_node_id: "complete",
            status: "succeeded",
            finished_at: "2026-01-01T00:09:40.000Z"
          },
          "complete-1": {
            node_id: "complete-1",
            logical_node_id: "complete",
            status: "succeeded",
            finished_at: "2026-01-01T00:09:45.000Z"
          },
          "pending-0": {
            node_id: "pending-0",
            logical_node_id: "pending",
            status: "succeeded",
            finished_at: "2026-01-01T00:09:30.000Z"
          },
          "pending-1": { node_id: "pending-1", logical_node_id: "pending", status: "pending" }
        }
      })
    );
    fs.writeFileSync(path.join(runRoot, "plan.json"), JSON.stringify({ topology: { logical_nodes: 3 } }));
    const command = modalCanonicalRecoveryProbeCommand(remoteRoot, mount);

    expect(JSON.parse(execFileSync(command[0]!, command.slice(1), { encoding: "utf8" }))).toEqual({
      status: "running",
      successful_nodes: 1,
      total_nodes: 2,
      planned_nodes: 3,
      last_transition_at: "2026-01-01T00:09:50.000Z",
      last_success_at: "2026-01-01T00:09:45.000Z"
    });
  });

  it("uses durable worker rows instead of topology-only nodes for strict completion", () => {
    const canonical = {
      status: "succeeded",
      successful_nodes: 2,
      total_nodes: 2,
      planned_nodes: 3,
      last_transition_at: "2026-01-01T00:10:00.000Z",
      last_success_at: "2026-01-01T00:10:00.000Z"
    };
    const workerStatus: ModalWorkerStatus = {
      schema_version: "ultrafuzz.modal.worker-result.v2",
      stage: "terminal",
      terminal: true,
      category: "succeeded",
      model_work_started: true,
      retryable: false,
      generation: 1,
      attempt: 1,
      node_counts: { succeeded: 2, failed: 0, remaining: 0 }
    };

    expect(isModalRecoveryResultComplete(canonical, workerStatus)).toBe(true);
    expect(isModalRecoveryResultComplete({ ...canonical, successful_nodes: 1 }, workerStatus)).toBe(false);
  });
});

describe("Modal worker identity", () => {
  it("fails closed when non-resumable model work may have crossed the readiness boundary", () => {
    const transient = new Error("injected transient failure");
    transient.name = "TimeoutError";

    expect(classifyModalLaunchFailure(transient, { modelMayHaveStarted: false, postModelRecovery: "stop" })).toBe(
      "transient-operational-failure"
    );
    expect(classifyModalLaunchFailure(transient, { modelMayHaveStarted: true, postModelRecovery: "relaunch" })).toBe(
      "transient-operational-failure"
    );
    expect(classifyModalLaunchFailure(transient, { modelMayHaveStarted: true, postModelRecovery: "stop" })).toBe(
      "permanent-operational-failure"
    );
    expect(
      classifyModalLaunchFailure(new Error("injected permanent failure"), {
        modelMayHaveStarted: false,
        postModelRecovery: "stop"
      })
    ).toBe("permanent-operational-failure");
  });

  it("makes the compiled source tree readable by the non-root worker", () => {
    expect(modalImageBuildCommand()).toContain("chown -R ubuntu:ubuntu /opt/ultrafuzz");
    expect(modalImageBuildCommand()).toContain("@moonshot-ai/kimi-code@0.29.1");
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

    const kimi = modalWorkerEntrypointCommand("kimi");
    expect(kimi).toContain("chown -R ubuntu:ubuntu '/run/ultrafuzz-auth/kimi'");
    expect(kimi).toContain("wait_for_staged_input '/run/ultrafuzz-auth/kimi/config.toml'");
    expect(kimi).toContain("KIMI_CODE_HOME='/run/ultrafuzz-auth/kimi'");
    expect(kimi).toContain('ULTRAFUZZ_KIMI_SHARED_AUTH_HOME="$data_root/kimi-code-auth"');
    expect(kimi).toContain('ULTRAFUZZ_KIMI_SESSION_HOME="$data_root/kimi-code-sessions"');
    expect(kimi).not.toContain("/run/ultrafuzz-auth/claude/.credentials.json");
    expect(() => execFileSync("bash", ["-n", "-c", kimi])).not.toThrow();
  });

  it("preserves Kimi refresh tokens and refuses to replace newer shared Modal auth state", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-kimi-stage-"));
    const pending = path.join(root, "kimi-code.json.pending");
    const destination = path.join(root, "kimi-code.json");
    const lineage = `${destination}.ultrafuzz-source-refresh-token.sha256`;
    fs.writeFileSync(
      pending,
      `${JSON.stringify({
        access_token: "fresh-access",
        refresh_token: "older-refresh",
        expires_at: 2_000_000,
        expires_in: 900
      })}\n`,
      "utf8"
    );
    fs.writeFileSync(
      destination,
      `${JSON.stringify({
        access_token: "newer-volume-access",
        refresh_token: "newer-volume-refresh",
        expires_at: 2_100_000,
        expires_in: 900
      })}\n`,
      "utf8"
    );

    execFileSync("node", ["-e", KIMI_SHARED_CREDENTIAL_STAGE_SCRIPT, pending, destination]);

    const staged = JSON.parse(fs.readFileSync(destination, "utf8")) as {
      access_token?: string;
      refresh_token?: string;
      expires_at?: number;
    };
    expect(staged).toMatchObject({
      access_token: "newer-volume-access",
      refresh_token: "newer-volume-refresh",
      expires_at: 2_100_000
    });
    expect(fs.existsSync(pending)).toBe(false);
    expect(fs.existsSync(lineage)).toBe(false);
  });

  it("does not replace a rotated shared Modal Kimi credential with a stale ancestor", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-kimi-stage-"));
    const pending = path.join(root, "kimi-code.json.pending");
    const destination = path.join(root, "kimi-code.json");
    const lineage = `${destination}.ultrafuzz-source-refresh-token.sha256`;
    fs.writeFileSync(
      pending,
      `${JSON.stringify({
        access_token: "ancestor-access",
        refresh_token: "ancestor-refresh",
        expires_at: 2_200_000,
        expires_in: 900
      })}\n`,
      "utf8"
    );
    fs.writeFileSync(
      destination,
      `${JSON.stringify({
        access_token: "rotated-volume-access",
        refresh_token: "rotated-volume-refresh",
        expires_at: 2_100_000,
        expires_in: 900
      })}\n`,
      "utf8"
    );
    fs.writeFileSync(lineage, `${createHash("sha256").update("ancestor-refresh").digest("hex")}\n`, "utf8");

    execFileSync("node", ["-e", KIMI_SHARED_CREDENTIAL_STAGE_SCRIPT, pending, destination]);

    expect(JSON.parse(fs.readFileSync(destination, "utf8"))).toMatchObject({
      access_token: "rotated-volume-access",
      refresh_token: "rotated-volume-refresh",
      expires_at: 2_100_000
    });
    expect(fs.readFileSync(lineage, "utf8")).toBe(`${createHash("sha256").update("ancestor-refresh").digest("hex")}\n`);
    expect(fs.existsSync(pending)).toBe(false);
  });

  it("replaces stale shared Modal Kimi credentials on fresh host-token rotation", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-kimi-stage-"));
    const pending = path.join(root, "kimi-code.json.pending");
    const destination = path.join(root, "kimi-code.json");
    const lineage = `${destination}.ultrafuzz-source-refresh-token.sha256`;
    fs.writeFileSync(
      pending,
      `${JSON.stringify({
        access_token: "current-host-access",
        refresh_token: "current-host-refresh",
        expires_at: 2_200_000,
        expires_in: 900
      })}\n`,
      "utf8"
    );
    fs.writeFileSync(
      destination,
      `${JSON.stringify({
        access_token: "previous-volume-access",
        refresh_token: "previous-volume-refresh",
        expires_at: 2_100_000,
        expires_in: 900
      })}\n`,
      "utf8"
    );
    fs.writeFileSync(lineage, `${createHash("sha256").update("previous-host-refresh").digest("hex")}\n`, "utf8");

    execFileSync("node", ["-e", KIMI_SHARED_CREDENTIAL_STAGE_SCRIPT, pending, destination, "fresh"]);

    expect(JSON.parse(fs.readFileSync(destination, "utf8"))).toMatchObject({
      access_token: "current-host-access",
      refresh_token: "current-host-refresh",
      expires_at: 2_200_000
    });
    expect(fs.readFileSync(lineage, "utf8")).toBe(
      `${createHash("sha256").update("current-host-refresh").digest("hex")}\n`
    );
    expect(fs.existsSync(pending)).toBe(false);
  });

  it("refuses fresh Kimi shared credential replacement without valid lineage", () => {
    for (const lineageCase of ["missing", "corrupt", "unreadable"] as const) {
      const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-kimi-stage-"));
      const pending = path.join(root, "kimi-code.json.pending");
      const destination = path.join(root, "kimi-code.json");
      const lineage = `${destination}.ultrafuzz-source-refresh-token.sha256`;
      fs.writeFileSync(
        pending,
        `${JSON.stringify({
          access_token: "current-host-access",
          refresh_token: "current-host-refresh",
          expires_at: 2_200_000,
          expires_in: 900
        })}\n`,
        "utf8"
      );
      fs.writeFileSync(
        destination,
        `${JSON.stringify({
          access_token: "rotated-volume-access",
          refresh_token: "rotated-volume-refresh",
          expires_at: 2_100_000,
          expires_in: 900
        })}\n`,
        "utf8"
      );
      if (lineageCase === "corrupt") fs.writeFileSync(lineage, "not-a-sha\n", "utf8");
      if (lineageCase === "unreadable") fs.mkdirSync(lineage);

      expect(() =>
        execFileSync("node", ["-e", KIMI_SHARED_CREDENTIAL_STAGE_SCRIPT, pending, destination, "fresh"])
      ).toThrow(/Kimi credential lineage is missing or invalid/u);
      expect(JSON.parse(fs.readFileSync(destination, "utf8"))).toMatchObject({
        access_token: "rotated-volume-access",
        refresh_token: "rotated-volume-refresh",
        expires_at: 2_100_000
      });
    }
  });

  it("stages a lineage sidecar when Kimi shared Modal auth is replaced", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-kimi-stage-"));
    const pending = path.join(root, "kimi-code.json.pending");
    const destination = path.join(root, "kimi-code.json");
    const lineage = `${destination}.ultrafuzz-source-refresh-token.sha256`;
    fs.writeFileSync(
      pending,
      `${JSON.stringify({
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        expires_at: 2_100_000,
        expires_in: 900
      })}\n`,
      "utf8"
    );
    fs.writeFileSync(
      destination,
      `${JSON.stringify({
        access_token: "access-only",
        expires_at: 2_000_000,
        expires_in: 900
      })}\n`,
      "utf8"
    );

    execFileSync("node", ["-e", KIMI_SHARED_CREDENTIAL_STAGE_SCRIPT, pending, destination]);

    expect(JSON.parse(fs.readFileSync(destination, "utf8"))).toMatchObject({
      access_token: "fresh-access",
      refresh_token: "fresh-refresh",
      expires_at: 2_100_000
    });
    expect(fs.readFileSync(lineage, "utf8")).toMatch(/^[a-f0-9]{64}\n$/u);
  });

  it("publishes worker readiness only after launch state and all staged inputs are durable", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-modal-staging-"));
    const configPath = path.join(root, "benchmark.json");
    const statePath = path.join(root, "launch-state.json");
    const kimiAuthRoot = path.join(root, "kimi-code");
    fs.mkdirSync(path.join(kimiAuthRoot, "credentials"), { recursive: true });
    fs.writeFileSync(path.join(kimiAuthRoot, "config.toml"), '[providers."managed:kimi-code"]\n');
    fs.writeFileSync(
      path.join(kimiAuthRoot, "credentials", "kimi-code.json"),
      `${JSON.stringify({
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        expires_at: 2_100_000,
        expires_in: 900
      })}\n`
    );
    fs.writeFileSync(path.join(kimiAuthRoot, "device_id"), "device-one\n");
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

    const copied: Array<{ localPath: string; remotePath: string }> = [];
    const execCalls: string[][] = [];
    let readinessObservedDurableState = false;
    const execMock = vi.fn(async (argv: string[]) => {
      execCalls.push(argv);
      return {
        stdin: new WritableStream<string>(),
        stdout: emptyReadableStream(),
        stderr: emptyReadableStream(),
        wait: async () => 0
      };
    });
    const sandbox = {
      filesystem: {
        readText: vi.fn(async () => {
          throw new SandboxFilesystemNotFoundError("missing");
        }),
        copyFromLocal: vi.fn(async (localPath: string, remotePath: string) => {
          if (remotePath === REMOTE_LAUNCH_READY_PATH) {
            const persisted = await readModalLaunchState(statePath);
            readinessObservedDurableState = persisted?.launches[0]?.phase === "launched";
          }
          copied.push({ localPath, remotePath });
        })
      },
      exec: execMock,
      detach: vi.fn()
    } as unknown as Sandbox;

    await finishReservedModalLaunch(
      {
        configPath,
        statePath,
        state,
        auth: {
          source: kimiAuthRoot,
          destination: remoteAuthPath("kimi"),
          entries: [
            {
              source: path.join(kimiAuthRoot, "config.toml"),
              destination: "/run/ultrafuzz-auth/kimi/config.toml"
            },
            {
              source: path.join(kimiAuthRoot, "credentials", "kimi-code.json"),
              destination: "/run/ultrafuzz-auth/kimi/credentials/kimi-code.json"
            },
            {
              source: path.join(kimiAuthRoot, "device_id"),
              destination: "/run/ultrafuzz-auth/kimi/device_id"
            }
          ]
        }
      },
      record,
      sandbox
    );

    const copiedRemotePaths = copied.map((entry) => entry.remotePath);
    expect(copiedRemotePaths[0]).toBe(REMOTE_CONFIG_PATH);
    expect(copiedRemotePaths[1]).toBe(REMOTE_LINEAGE_PATH);
    expect(copiedRemotePaths[2]).toBe("/run/ultrafuzz-auth/kimi/config.toml");
    expect(copiedRemotePaths[3]).toMatch(
      /^\/data\/logical-run\/model-one\/kimi-code-auth\/credentials\/kimi-code\.json\.pending-/u
    );
    expect(copiedRemotePaths[4]).toBe("/run/ultrafuzz-auth/kimi/device_id");
    expect(copiedRemotePaths[5]).toBe(REMOTE_LAUNCH_READY_PATH);
    expect(copiedRemotePaths).toHaveLength(6);
    expect(copiedRemotePaths).not.toContain("/run/ultrafuzz-auth/kimi/credentials/kimi-code.json");
    const shellScripts = execCalls
      .filter((command) => command[0] === "bash" && command[1] === "-lc")
      .map((command) => command[2] ?? "");
    expect(execCalls).toContainEqual([
      "install",
      "-d",
      "-m",
      "700",
      "-o",
      "ubuntu",
      "-g",
      "ubuntu",
      "/run/ultrafuzz-config"
    ]);
    expect(execCalls).toContainEqual([
      "chown",
      "ubuntu:ubuntu",
      REMOTE_CONFIG_PATH,
      REMOTE_LINEAGE_PATH,
      "/run/ultrafuzz-config"
    ]);
    expect(execCalls).toContainEqual(["chown", "ubuntu:ubuntu", REMOTE_LAUNCH_READY_PATH]);
    expect(shellScripts.join("\n")).toContain("kimi-code.lock");
    expect(shellScripts.join("\n")).toContain("ultrafuzz-source-refresh-token.sha256");
    expect(copied.some((entry) => entry.localPath === path.join(kimiAuthRoot, "credentials"))).toBe(false);
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

function terminationState() {
  const state = createModalLaunchState({
    logicalRunId: "logical-run",
    generation: 1,
    generationMode: "fresh",
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
    workspaceMode: "fresh",
    attemptId: "original-attempt"
  });
  return { state, record };
}

function fakeTerminationSandbox(sandboxId: string, tags: Record<string, string>, exitCode: number | null = null) {
  return {
    sandboxId,
    getTags: vi.fn(async () => tags),
    poll: vi.fn(async () => exitCode),
    terminate: vi.fn(async (_params: { wait: true }) => 0),
    detach: vi.fn()
  };
}

function fakeTerminationService(sandboxes: Array<ReturnType<typeof fakeTerminationSandbox>>, listed = sandboxes) {
  return {
    fromId: vi.fn(async (sandboxId: string) => {
      const sandbox = sandboxes.find((candidate) => candidate.sandboxId === sandboxId);
      if (sandbox === undefined) throw new Error(`unknown sandbox fixture: ${sandboxId}`);
      return sandbox;
    }),
    list: vi.fn((_params: { appId: string; tags: Record<string, string> }) => listedSandboxes(listed))
  };
}

async function* listedSandboxes(
  sandboxes: Array<ReturnType<typeof fakeTerminationSandbox>>
): AsyncGenerator<ReturnType<typeof fakeTerminationSandbox>, void, unknown> {
  for (const sandbox of sandboxes) yield sandbox;
}
