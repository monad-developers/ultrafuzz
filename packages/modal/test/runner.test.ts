import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  NotFoundError,
  SandboxFilesystemNotFoundError,
  type App,
  type FileInfo,
  type Image,
  type Sandbox,
  type SandboxCreateParams
} from "modal";
import { describe, expect, it, vi } from "vitest";

import { fingerprintModalModel, isPublicModalBenchmarkConfig, parseModalBenchmarkConfig } from "../src/config.js";
import {
  MODAL_PUBLIC_FULL_SANDBOX_TIMEOUT_MS,
  MODAL_PUBLIC_SANDBOX_TIMEOUT_MS,
  MODAL_SANDBOX_TIMEOUT_MS,
  type ModalModelSpec
} from "../src/defaults.js";
import {
  createModalLaunchState,
  fingerprintModalImage,
  latestModalWorkerStatus,
  markModalLaunchReady,
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
  createModalLaunchSandbox,
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
  modalBenchmarkStatusRow,
  observeTerminalModalRecoveryLifecycle,
  publicBenchmarkCollectionSecretValues,
  readModalCollectResultFiles,
  overseeModalBenchmarks,
  readOptionalModalSandboxText,
  publicEvalDiagnosticsDroppedFromEvidence,
  runningRecoverySandbox,
  replaceSanitizedModalCollectedFiles,
  resolveModalLaunchStateImageForInspection,
  selectModalCollectedEvidence,
  terminateModalBenchmarkSandboxes,
  terminateModalBenchmarkTagScopes
} from "../src/runner.js";
import { currentRunState } from "./current-artifact-fixtures.js";

const MODEL: ModalModelSpec = {
  slug: "model-one",
  model: "model-placeholder",
  provider: "openai",
  agent: "CodexAgent",
  reasoning: "high",
  auth_mode: "api-key"
};
const ARTIFACTS_MODULE_PATH = fileURLToPath(new URL("../../artifacts/dist/index.js", import.meta.url));

function stageKimiCredential(pending: string, destination: string, mode = "resume"): void {
  execFileSync("node", ["-e", KIMI_SHARED_CREDENTIAL_STAGE_SCRIPT, pending, destination, mode, ARTIFACTS_MODULE_PATH]);
}

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

  it.each([
    ["new public smoke", MODAL_PUBLIC_SANDBOX_TIMEOUT_MS],
    ["new public full", MODAL_PUBLIC_FULL_SANDBOX_TIMEOUT_MS],
    ["persisted 24-hour", MODAL_SANDBOX_TIMEOUT_MS]
  ])("creates a %s worker with the timeout recorded in launch state", async (_label, timeoutMs) => {
    const app = {} as App;
    const image = {} as Image;
    const sandbox = {} as Sandbox;
    const sandboxes = {
      create: vi.fn(async (_app: App, _image: Image, _params?: SandboxCreateParams) => sandbox)
    };
    const state = createModalLaunchState({
      logicalRunId: "timeout-run",
      generation: 1,
      generationMode: "resume",
      app: "app-placeholder",
      image: "image-placeholder",
      imageId: "image-id-placeholder",
      timeoutMs,
      sourceRevision: "revision-placeholder",
      fingerprints: { config: "a".repeat(64), source: "b".repeat(64), image: "c".repeat(64) }
    });

    await expect(createModalLaunchSandbox(sandboxes, app, image, state, { name: "worker" })).resolves.toBe(sandbox);
    expect(sandboxes.create).toHaveBeenCalledWith(app, image, expect.objectContaining({ name: "worker", timeoutMs }));
  });
});

describe("Modal pinned launch image inspection", () => {
  it.each(["status", "collect"])(
    "%s inspection keeps using image A after its published name rebounds to image B",
    async () => {
      const state = imageInspectionState("image-a");
      const imageA = { imageId: "image-a" } as Image;
      const imageB = { imageId: "image-b" } as Image;
      const images = {
        fromId: vi.fn(async () => imageA),
        // This models the mutable shared name after a concurrent build. Current
        // state inspection must never consult it.
        fromName: vi.fn(async () => imageB)
      };

      await expect(resolveModalLaunchStateImageForInspection(state, images)).resolves.toEqual({
        state,
        image: imageA
      });
      expect(images.fromId).toHaveBeenCalledOnce();
      expect(images.fromId).toHaveBeenCalledWith("image-a");
      expect(images.fromName).not.toHaveBeenCalled();
    }
  );

  it.each(["status", "collect"])("%s inspection fails closed when the pinned ID is incompatible", async () => {
    const state = imageInspectionState("image-a");
    const images = {
      fromId: vi.fn(async () => ({ imageId: "image-b" }) as Image),
      fromName: vi.fn(async () => ({ imageId: "image-a" }) as Image)
    };

    await expect(resolveModalLaunchStateImageForInspection(state, images)).rejects.toThrow(
      /image fingerprint mismatch/u
    );
    expect(images.fromId).toHaveBeenCalledWith("image-a");
    expect(images.fromName).not.toHaveBeenCalled();
  });

  it("rejects the historical v1 schema instead of resolving its mutable published name", async () => {
    const legacy = legacyImageInspectionState();
    const image = { imageId: "legacy-image-id" } as Image;
    const images = {
      fromId: vi.fn(async () => image),
      fromName: vi.fn(async () => image)
    };

    await expect(resolveModalLaunchStateImageForInspection(legacy, images)).rejects.toThrow();

    expect(images.fromName).not.toHaveBeenCalled();
    expect(images.fromId).not.toHaveBeenCalled();
  });

  it("does not downgrade a malformed current state into the name-based compatibility path", async () => {
    const malformed = { ...imageInspectionState("image-a") } as Record<string, unknown>;
    delete malformed.image_id;
    const images = {
      fromId: vi.fn(async () => ({ imageId: "image-a" }) as Image),
      fromName: vi.fn(async () => ({ imageId: "image-a" }) as Image)
    };

    await expect(resolveModalLaunchStateImageForInspection(malformed, images)).rejects.toThrow();
    expect(images.fromId).not.toHaveBeenCalled();
    expect(images.fromName).not.toHaveBeenCalled();
  });

  it("also rejects a malformed v1 document without consulting either image lookup", async () => {
    const malformed = { ...legacyImageInspectionState(), launches: "not-an-array" };
    const images = {
      fromId: vi.fn(async () => ({ imageId: "image-a" }) as Image),
      fromName: vi.fn(async () => ({ imageId: "image-a" }) as Image)
    };

    await expect(resolveModalLaunchStateImageForInspection(malformed, images)).rejects.toThrow();
    expect(images.fromId).not.toHaveBeenCalled();
    expect(images.fromName).not.toHaveBeenCalled();
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
      schema_version: "ultrafuzz.modal.benchmark.v2",
      run_id: "immutable-run",
      app_name: "ultrafuzz-evals",
      image_name: "ultrafuzz-security-runner:latest",
      target: { repo: "https://github.com/example/target", ref: "main" },
      ground_truth: {
        repo: "https://github.com/example/ground-truth",
        ref: "main",
        file: "findings.yml",
        format: "ultrafuzz"
      },
      braintrust: {
        project: "termination-test",
        api_key_env: "BRAINTRUST_API_KEY",
        judge_api_key_env: "OPENAI_API_KEY",
        judge_url: "https://api.openai.com/v1/chat/completions",
        judge_credential_ttl_seconds: 57_600
      },
      node_timeout_seconds: 7_200,
      loops: 3,
      models: [MODEL],
      benchmark_execution: { excluded_node_ids: [] },
      eval_reporting: { provider: "braintrust" }
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
    const duplicateKeyPayload = Buffer.from(
      '[{"code":"WORKFLOW_SUBMISSION_FAILED","message":"first","message":"shadowed"}]',
      "utf8"
    ).toString("base64url");
    expect(() =>
      assertSanitizedModalCollectedFiles(
        {
          ...files,
          "worker.log": `2026-01-01T00:00:00.000Z eval-failure-diagnostics ${duplicateKeyPayload}\n`
        },
        context
      )
    ).toThrow(/unsanitized Modal worker log/u);
  });

  it("rejects the removed worker-status shape without retrying", async () => {
    const context = { generation: 1, attempt: 2 };
    const removedStatus = {
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
      "status.json": `${JSON.stringify(removedStatus)}\n`,
      "worker.log": ""
    });

    await expect(
      readModalCollectResultFiles({
        readFiles,
        launch: context
      })
    ).rejects.toThrow(/worker-result|failed/u);
    expect(readFiles).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid current status even when a terminal result is present", async () => {
    const context = { generation: 1, attempt: 2 };
    const terminalResult = {
      schema_version: "ultrafuzz.modal.worker-result.v2",
      result_type: "terminal",
      generation: 9,
      launch_generation: 1,
      attempt: 2,
      model_work_started: true,
      counts: { succeeded: 32, failed: 0, remaining: 0 },
      checkpoint: { age_ms: 0, digest: `sha256:${"a".repeat(64)}` },
      exit_category: "finished",
      runtime_ms: 100,
      usage: null,
      diagnostic_code: "worker-finished"
    };
    const readFiles = vi.fn().mockResolvedValue({
      "status.json": '{"schema_version":"ultrafuzz.modal.worker-result.v2",',
      "result.json": `${JSON.stringify(terminalResult)}\n`,
      "worker.log": ""
    });

    await expect(
      readModalCollectResultFiles({
        readFiles,
        launch: context
      })
    ).rejects.toThrow(/strict JSON|JSON document/u);
    expect(readFiles).toHaveBeenCalledTimes(1);
  });

  it("rejects a current worker result from another attempt without retrying", async () => {
    const context = { generation: 1, attempt: 2 };
    const staleStatus = {
      schema_version: "ultrafuzz.modal.worker-result.v2",
      result_type: "partial",
      generation: 8,
      launch_generation: 1,
      attempt: 1,
      model_work_started: true,
      counts: { succeeded: 12, failed: 0, remaining: 20 },
      checkpoint: { age_ms: 0, digest: `sha256:${"a".repeat(64)}` },
      exit_category: "live",
      runtime_ms: 100,
      usage: null,
      diagnostic_code: "worker-live"
    };
    const readFiles = vi.fn().mockResolvedValue({
      "status.json": `${JSON.stringify(staleStatus)}\n`,
      "worker.log": ""
    });

    await expect(
      readModalCollectResultFiles({
        readFiles,
        launch: context
      })
    ).rejects.toThrow(/current launch attempt/u);
    expect(readFiles).toHaveBeenCalledTimes(1);
  });

  it("accepts current worker results with one exact read", async () => {
    const context = { generation: 1, attempt: 2 };
    const currentStatus = {
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
    const expected = {
      "status.json": `${JSON.stringify(currentStatus)}\n`,
      "worker.log": ""
    };
    const readFiles = vi.fn().mockResolvedValue(expected);

    await expect(
      readModalCollectResultFiles({
        readFiles,
        launch: context
      })
    ).resolves.toEqual(expected);
    expect(readFiles).toHaveBeenCalledTimes(1);
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
    const serialized = files["recovery-lifecycle.json"];
    const field = '"schema_version":"ultrafuzz.modal.recovery-lifecycle.v1"';
    const duplicate = serialized.replace(field, `${field},"schema_version":"shadow-version"`);
    expect(duplicate).not.toBe(serialized);
    expect(() => assertSanitizedModalCollectedFiles({ "recovery-lifecycle.json": duplicate }, context)).toThrow(
      /unsanitized Modal recovery lifecycle/u
    );
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

  it("fails collection only for a persisted diagnostics document that selection dropped", async () => {
    const config = publicCollectionLineage().config;
    const persisted = {
      "status.json": "status",
      "public-eval-diagnostics.json": "diagnostics"
    };
    // Run 31171579070, pair ultrafuzz-bench-benchmark-smoke-gpt-5-6-luna-high:
    // the worker reported that it could not build the document, so it never
    // persisted one. CI collects that pair on the diagnostic-only path, and
    // demanding a document nothing ever wrote aborted that collection (#320).
    const workerNamedTheFault = {
      "status.json": "status",
      "result.json": "result",
      "worker.log": "log"
    };

    const dropped = await selectModalCollectedEvidence(persisted, undefined, undefined, {});
    expect(dropped.files["public-eval-diagnostics.json"]).toBeUndefined();
    expect(publicEvalDiagnosticsDroppedFromEvidence({ volumeFiles: persisted, selectedFiles: dropped.files })).toBe(
      true
    );

    const retained = await selectModalCollectedEvidence(persisted, config, config.models[0], {
      OPENAI_API_KEY: "opaque-secret"
    });
    expect(publicEvalDiagnosticsDroppedFromEvidence({ volumeFiles: persisted, selectedFiles: retained.files })).toBe(
      false
    );

    const collectable = await selectModalCollectedEvidence(workerNamedTheFault, config, config.models[0], {
      OPENAI_API_KEY: "opaque-secret"
    });
    expect(
      publicEvalDiagnosticsDroppedFromEvidence({
        volumeFiles: workerNamedTheFault,
        selectedFiles: collectable.files
      })
    ).toBe(false);
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
    schema_version: "ultrafuzz.modal.benchmark.v2",
    run_id: "public-eval",
    app_name: "ultrafuzz-evals",
    image_name: "public-image",
    braintrust: {
      project: "public-evals",
      api_key_env: "BRAINTRUST_API_KEY",
      judge_api_key_env: "OPENAI_API_KEY",
      judge_url: "https://api.openai.com/v1/chat/completions",
      judge_credential_ttl_seconds: 57_600
    },
    public_benchmark: {
      benchmark: "evmbench",
      lane: "smoke",
      runner_model_profile: MODEL.slug,
      candidate_repository: "https://github.com/monad-developers/ultrafuzz",
      candidate_commit: candidateCommit,
      targets: [
        {
          id: "target-one",
          repository: "https://github.com/example/target-one",
          revision: "e".repeat(40),
          framework: "foundry"
        }
      ],
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

function writeCanonicalRecoveryPlan(runRoot: string, runId: string, logicalNodes: number): void {
  fs.writeFileSync(
    path.join(runRoot, "plan.json"),
    JSON.stringify({
      schema_version: "ultrafuzz.run-plan.v2",
      run_id: runId,
      mode: "run",
      graph_fingerprint: "a".repeat(64),
      config_fingerprint: "b".repeat(64),
      redacted_config_fingerprint: "c".repeat(64),
      execution: {
        mode: "local",
        retentionDays: 30,
        resources: { cpu: 1, memoryMiB: 512, timeoutSeconds: 300 },
        nodes: {},
        providers: {}
      },
      topology: { path: "topology.json", logical_nodes: logicalNodes, expanded_nodes: logicalNodes },
      rendered_prompts: [],
      policy_posture: {
        config: "pass",
        topology: "pass",
        prompts: "pass",
        paths: "pass",
        agents: "pass",
        trust: "pass"
      }
    })
  );
}

function writeRecoveryProbeArtifactsModule(root: string): string {
  const modulePath = path.join(root, "recovery-probe-artifacts.mjs");
  fs.writeFileSync(
    modulePath,
    `import fs from "node:fs";
export function readRunState(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
export function readRunPlanDocument(filePath, expectedRunId) {
  const plan = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (plan.run_id !== expectedRunId) throw new Error("run plan identity mismatch");
  return plan;
}
`
  );
  return modulePath;
}

describe("Modal canonical recovery probe", () => {
  it("uses the pinned current artifact readers in the worker image", () => {
    const command = modalCanonicalRecoveryProbeCommand("/data/logical-run/model-one");

    expect(command.at(-1)).toBe("/opt/ultrafuzz/packages/artifacts/dist/index.js");
    expect(command[2]).toContain("artifacts.readRunState(statePath)");
    expect(command[2]).toContain("artifacts.readRunPlanDocument");
  });

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
      JSON.stringify(
        currentRunState(
          {
            "complete-0": {
              logical_node_id: "complete",
              status: "succeeded",
              finished_at: "2026-01-01T00:09:40.000Z"
            },
            "complete-1": {
              logical_node_id: "complete",
              status: "succeeded",
              finished_at: "2026-01-01T00:09:45.000Z"
            },
            "pending-0": {
              logical_node_id: "pending",
              status: "succeeded",
              finished_at: "2026-01-01T00:09:30.000Z"
            },
            "pending-1": { logical_node_id: "pending", status: "pending" }
          },
          {
            run_id: "durable-run",
            status: "running",
            created_at: "2026-01-01T00:00:00.000Z",
            last_transition_at: "2026-01-01T00:09:50.000Z"
          }
        )
      )
    );
    writeCanonicalRecoveryPlan(runRoot, "durable-run", 3);
    const command = modalCanonicalRecoveryProbeCommand(remoteRoot, mount, writeRecoveryProbeArtifactsModule(mount));

    expect(JSON.parse(execFileSync(command[0]!, command.slice(1), { encoding: "utf8" }))).toEqual({
      status: "running",
      successful_nodes: 1,
      total_nodes: 2,
      planned_nodes: 3,
      last_transition_at: "2026-01-01T00:09:50.000Z",
      last_success_at: "2026-01-01T00:09:45.000Z"
    });
  });

  it("rejects malformed present durable state instead of reporting unavailable canonical progress", () => {
    const mount = mkdtempSync(path.join(tmpdir(), "ultrafuzz-modal-recovery-probe-partial-"));
    const remoteRoot = "/data/logical-run/model-one";
    const runRoot = path.join(
      mount,
      "logical-run",
      "model-one",
      "workspace",
      "target",
      ".ultrafuzz",
      "runs",
      "durable-run"
    );
    fs.mkdirSync(runRoot, { recursive: true });
    fs.writeFileSync(path.join(runRoot, "state.json"), "\0".repeat(16));
    writeCanonicalRecoveryPlan(runRoot, "durable-run", 3);
    const command = modalCanonicalRecoveryProbeCommand(remoteRoot, mount, writeRecoveryProbeArtifactsModule(mount));

    expect(() => execFileSync(command[0]!, command.slice(1), { encoding: "utf8" })).toThrow();
  });

  it("rejects malformed present durable plan instead of reporting unavailable canonical progress", () => {
    const mount = mkdtempSync(path.join(tmpdir(), "ultrafuzz-modal-recovery-probe-plan-"));
    const remoteRoot = "/data/logical-run/model-one";
    const runRoot = path.join(
      mount,
      "logical-run",
      "model-one",
      "workspace",
      "target",
      ".ultrafuzz",
      "runs",
      "durable-run"
    );
    fs.mkdirSync(runRoot, { recursive: true });
    fs.writeFileSync(
      path.join(runRoot, "state.json"),
      JSON.stringify(currentRunState({}, { run_id: "durable-run", status: "running" }))
    );
    fs.writeFileSync(path.join(runRoot, "plan.json"), "{not-json");
    const command = modalCanonicalRecoveryProbeCommand(remoteRoot, mount, writeRecoveryProbeArtifactsModule(mount));

    expect(() => execFileSync(command[0]!, command.slice(1), { encoding: "utf8" })).toThrow();
  });

  it("reports unavailable canonical progress only when the durable run directory is absent", () => {
    const mount = mkdtempSync(path.join(tmpdir(), "ultrafuzz-modal-recovery-probe-absent-"));
    const command = modalCanonicalRecoveryProbeCommand(
      "/data/logical-run/model-one",
      mount,
      writeRecoveryProbeArtifactsModule(mount)
    );

    expect(JSON.parse(execFileSync(command[0]!, command.slice(1), { encoding: "utf8" }))).toEqual({});
  });

  it("rejects non-ENOENT durable run discovery errors", () => {
    const mount = mkdtempSync(path.join(tmpdir(), "ultrafuzz-modal-recovery-probe-discovery-"));
    const remoteRoot = "/data/logical-run/model-one";
    const runsRoot = path.join(mount, "logical-run", "model-one", "workspace", "target", ".ultrafuzz", "runs");
    fs.mkdirSync(path.dirname(runsRoot), { recursive: true });
    fs.writeFileSync(runsRoot, "not-a-directory");
    const command = modalCanonicalRecoveryProbeCommand(remoteRoot, mount, writeRecoveryProbeArtifactsModule(mount));

    expect(() => execFileSync(command[0]!, command.slice(1), { encoding: "utf8" })).toThrow();
  });

  it("settles only exact clean or genuine terminal worker rows", () => {
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

    const genuineFailure: ModalWorkerStatus = {
      ...workerStatus,
      category: "genuine-task-outcome",
      error_code: "genuine-evaluation-failure",
      node_counts: { succeeded: 1, failed: 1, remaining: 0 }
    };
    const failedCanonical = { ...canonical, status: "failed", successful_nodes: 1 };
    expect(isModalRecoveryResultComplete(failedCanonical, genuineFailure)).toBe(true);
    expect(
      isModalRecoveryResultComplete(failedCanonical, {
        ...genuineFailure,
        node_counts: { succeeded: 1, failed: 0, remaining: 1 }
      })
    ).toBe(false);
    expect(
      isModalRecoveryResultComplete(failedCanonical, {
        ...genuineFailure,
        category: "permanent-operational-failure",
        error_code: "terminal-run-non-resumable"
      })
    ).toBe(false);
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

  it("keeps the validator toolchain root-owned and installs a trusted image entrypoint", () => {
    expect(modalImageBuildCommand()).not.toContain("chown -R ubuntu:ubuntu /opt/ultrafuzz");
    expect(modalImageBuildCommand()).toContain("install -m 0555 -o root -g root");
    expect(modalImageBuildCommand()).toContain("/usr/local/bin/ultrafuzz json validate");
    expect(modalImageBuildCommand()).toContain("validator-smoke.valid.json");
    expect(modalImageBuildCommand()).toContain("chmod -R a+rX,go-w /opt/ultrafuzz");
    expect(modalImageBuildCommand()).toContain("node packages/modal/scripts/prepare-smithers-seed.mjs");
    expect(modalImageBuildCommand()).toContain("/opt/ultrafuzz-smithers-seed");
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

    stageKimiCredential(pending, destination);

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

  it.each([
    ["pending malformed", "pending", '{"access_token":"pending"'],
    [
      "pending duplicate",
      "pending",
      '{"access_token":"pending","refresh_token":"first","refresh_token":"shadow","expires_at":2100000,"expires_in":900}\n'
    ],
    ["destination malformed", "destination", '{"access_token":"destination"'],
    [
      "destination duplicate",
      "destination",
      '{"access_token":"destination","refresh_token":"first","refresh_token":"shadow","expires_at":2100000,"expires_in":900}\n'
    ],
    ["destination unsupported", "destination", "{}\n"]
  ] as const)(
    "rejects %s Kimi credential evidence without replacing or normalizing either file",
    (_name, target, bytes) => {
      const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-kimi-stage-invalid-"));
      const pending = path.join(root, "kimi-code.json.pending");
      const destination = path.join(root, "kimi-code.json");
      const validPending =
        '{"access_token":"pending-access","refresh_token":"pending-refresh","expires_at":2100000,"expires_in":900}\n';
      const validDestination =
        '{"access_token":"destination-access","refresh_token":"destination-refresh","expires_at":2200000,"expires_in":900}\n';
      fs.writeFileSync(pending, target === "pending" ? bytes : validPending, { mode: 0o600 });
      fs.writeFileSync(destination, target === "destination" ? bytes : validDestination, { mode: 0o600 });
      const pendingBefore = fs.readFileSync(pending);
      const destinationBefore = fs.readFileSync(destination);

      expect(() => stageKimiCredential(pending, destination)).toThrow(/strict bounded JSON|unsupported shape/u);

      expect(fs.readFileSync(pending)).toEqual(pendingBefore);
      expect(fs.readFileSync(destination)).toEqual(destinationBefore);
      expect(fs.existsSync(`${destination}.ultrafuzz-source-refresh-token.sha256`)).toBe(false);
    }
  );

  it("moves a strict new Kimi provider envelope byte-for-byte without normalizing it", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-kimi-stage-new-"));
    const pending = path.join(root, "kimi-code.json.pending");
    const destination = path.join(root, "kimi-code.json");
    const bytes = Buffer.from(
      '{ "provider_state": { "generation": 2 }, "expires_in": 900, "expires_at": 2100000, "refresh_token": "fresh-refresh", "access_token": "fresh-access" }',
      "utf8"
    );
    fs.writeFileSync(pending, bytes, { mode: 0o600 });

    stageKimiCredential(pending, destination);

    expect(fs.readFileSync(destination)).toEqual(bytes);
    expect(fs.existsSync(pending)).toBe(false);
  });

  it("rejects symlinked Kimi credential evidence without following or replacing it", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-kimi-stage-symlink-"));
    const pending = path.join(root, "kimi-code.json.pending");
    const destination = path.join(root, "kimi-code.json");
    const outside = path.join(root, "outside.json");
    const pendingBytes = Buffer.from(
      '{"access_token":"pending-access","refresh_token":"pending-refresh","expires_at":2100000,"expires_in":900}\n',
      "utf8"
    );
    const outsideBytes = Buffer.from(
      '{"access_token":"outside-access","refresh_token":"outside-refresh","expires_at":2200000,"expires_in":900}\n',
      "utf8"
    );
    fs.writeFileSync(pending, pendingBytes, { mode: 0o600 });
    fs.writeFileSync(outside, outsideBytes, { mode: 0o600 });
    fs.symlinkSync(outside, destination);

    expect(() => stageKimiCredential(pending, destination)).toThrow();

    expect(fs.readFileSync(pending)).toEqual(pendingBytes);
    expect(fs.lstatSync(destination).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(outside)).toEqual(outsideBytes);
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

    stageKimiCredential(pending, destination);

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

    stageKimiCredential(pending, destination, "fresh");

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

      expect(() => stageKimiCredential(pending, destination, "fresh")).toThrow(
        /Kimi credential lineage is missing or invalid/u
      );
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

    stageKimiCredential(pending, destination);

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

  // Kept narrow deliberately. modal@0.9.0 relabels NOT_FOUND, CANCELLED, UNKNOWN, DEADLINE_EXCEEDED and
  // UNAVAILABLE all as `NotFoundError("The Sandbox is unavailable...")`, so treating that class as
  // "file absent" would make an ordinary network blip against a healthy sandbox drive writes: it would
  // defeat the readiness-marker guards and let `collect` persist an empty bundle. Issue #295 is fixed in
  // the overseer poll loop instead.
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

    const sandboxGone = new NotFoundError("The Sandbox is unavailable. This Sandbox may have already shut down.");
    await expect(
      readOptionalModalSandboxText(
        {
          readText: async () => {
            throw sandboxGone;
          }
        },
        "/data/status.json"
      )
    ).rejects.toBe(sandboxGone);

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

  // R45's detached overseer exited 1 mid-run on a sandbox-unavailable read (issue #295). The run then hit
  // a transient `agent-failure` half an hour later with nothing alive to retry it, and restarting the
  // overseer immediately produced `action: "launch", reason: "owner-missing"` -- recovery had been
  // available the whole time and simply had no process to trigger it.
  it("keeps polling after a job throws and reports the failure alongside healthy jobs", async () => {
    const job = (configPath: string) => ({
      configPath,
      statePath: `${configPath}.state`,
      recoveryStatePath: `${configPath}.recovery`
    });
    const calls: string[] = [];
    const logged: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => void logged.push(String(line)));
    try {
      const snapshots = await overseeModalBenchmarks({
        jobs: [job("/tmp/first"), job("/tmp/second")],
        pollMs: 1,
        overseeOnce: async (current) => {
          calls.push(current.configPath);
          if (current.configPath === "/tmp/first" && calls.length <= 2) {
            throw new Error("The Sandbox is unavailable. This Sandbox may have already shut down.");
          }
          return {
            logical_run_id: current.configPath === "/tmp/first" ? "run-first" : "run-second",
            complete: calls.length > 2,
            settled: calls.length > 2,
            rows: []
          };
        }
      });
      expect(snapshots.map((entry) => entry.logical_run_id)).toEqual(["run-first", "run-second"]);
    } finally {
      log.mockRestore();
    }
    // The first tick failed for one job, and supervision must have continued.
    expect(calls.length).toBeGreaterThan(2);
    const first = JSON.parse(logged[0]!) as { jobs: unknown[]; failed_jobs?: { config_path: string }[] };
    expect(first.jobs).toHaveLength(1);
    expect(first.failed_jobs?.[0]?.config_path).toBe("/tmp/first");
  });

  // The case the length guard actually protects, which the test above does not reach: a healthy job
  // reports complete on the same tick a sibling throws. Without the guard the loop would return a
  // one-entry array for a two-job overseer and silently abandon the sibling.
  it("does not report completion while a sibling job is still failing", async () => {
    const job = (configPath: string) => ({
      configPath,
      statePath: `${configPath}.state`,
      recoveryStatePath: `${configPath}.recovery`
    });
    let healthyTicks = 0;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const snapshots = await overseeModalBenchmarks({
        jobs: [job("/tmp/healthy"), job("/tmp/flaky")],
        pollMs: 1,
        overseeOnce: async (current) => {
          if (current.configPath === "/tmp/healthy") {
            healthyTicks += 1;
            return { logical_run_id: "run-healthy", complete: true, settled: true, rows: [] };
          }
          if (healthyTicks < 3) throw new Error("The Sandbox is unavailable. This Sandbox may have already shut down.");
          return { logical_run_id: "run-flaky", complete: true, settled: true, rows: [] };
        }
      });
      expect(snapshots.map((entry) => entry.logical_run_id)).toEqual(["run-healthy", "run-flaky"]);
    } finally {
      log.mockRestore();
    }
    // Completion was withheld until the failing sibling also succeeded.
    expect(healthyTicks).toBe(3);
  });

  // A permanently broken job among healthy ones must not be absorbed forever. It stops being polled so
  // its siblings keep being supervised, and the process still ends non-zero naming it.
  it("abandons a persistently failing job, keeps supervising the rest, then exits naming it", async () => {
    const job = (configPath: string) => ({
      configPath,
      statePath: `${configPath}.state`,
      recoveryStatePath: `${configPath}.recovery`
    });
    const wedgedCause = new Error("incompatible Modal recovery configuration fingerprint");
    const attempts = new Map<string, number>();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(
        overseeModalBenchmarks({
          jobs: [job("/tmp/wedged"), job("/tmp/fine")],
          pollMs: 1,
          maxConsecutiveFailures: 2,
          overseeOnce: async (current) => {
            attempts.set(current.configPath, (attempts.get(current.configPath) ?? 0) + 1);
            if (current.configPath === "/tmp/wedged") throw wedgedCause;
            return { logical_run_id: "run-fine", complete: true, settled: true, rows: [] };
          }
        })
      ).rejects.toThrow(/abandoned 1 job\(s\) after 2 consecutive failed ticks: \/tmp\/wedged/u);
    } finally {
      log.mockRestore();
    }
    // The wedged job stopped being polled at its limit; the healthy one was never starved.
    expect(attempts.get("/tmp/wedged")).toBe(2);
    expect(attempts.get("/tmp/fine")).toBe(2);
  });

  it("gives up loudly once every job has failed for the consecutive limit", async () => {
    const failure = new Error("permanently broken overseer configuration");
    const attempts: number[] = [];
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(
        overseeModalBenchmarks({
          jobs: [{ configPath: "/tmp/only", statePath: "/tmp/only.state", recoveryStatePath: "/tmp/only.recovery" }],
          pollMs: 1,
          maxConsecutiveFailures: 3,
          overseeOnce: async () => {
            attempts.push(attempts.length);
            throw failure;
          }
        })
      ).rejects.toMatchObject({ cause: failure });
    } finally {
      log.mockRestore();
    }
    expect(attempts).toHaveLength(3);
  });

  // The exit code that explains a sandbox death was polled here and dropped. On unattended runs nothing
  // else observes these deaths, so three Aave v4 runs lost their sandbox at `stateful-invariant-setup`
  // with no way to tell an OOM kill from an eviction from a clean exit (issue #302).
  it("returns the exit code of a sandbox that has already exited, and the sandbox while it lives", async () => {
    const detach = vi.fn();
    const exited = {
      sandboxes: { fromId: async () => ({ poll: async () => 137, detach }) }
    } as unknown as Parameters<typeof runningRecoverySandbox>[0];
    await expect(runningRecoverySandbox(exited, "sb-dead", "app", "name")).resolves.toEqual({ exitCode: 137 });
    expect(detach).toHaveBeenCalledTimes(1);

    // A clean exit must survive as 0 rather than being coerced away, because a clean exit at a node that
    // was supposed to keep working is the most surprising answer of all.
    const clean = {
      sandboxes: { fromId: async () => ({ poll: async () => 0, detach: vi.fn() }) }
    } as unknown as Parameters<typeof runningRecoverySandbox>[0];
    await expect(runningRecoverySandbox(clean, "sb-clean", "app", "name")).resolves.toEqual({ exitCode: 0 });

    // Still running: the caller gets the sandbox to keep using, and no exit code is invented.
    const live = { poll: async () => null, detach: vi.fn() };
    const alive = {
      sandboxes: { fromId: async () => live }
    } as unknown as Parameters<typeof runningRecoverySandbox>[0];
    await expect(runningRecoverySandbox(alive, "sb-live", "app", "name")).resolves.toEqual({ sandbox: live });

    // A vanished sandbox is an absence, not an observation.
    const gone = {
      sandboxes: {
        fromId: async () => {
          throw new NotFoundError("gone");
        }
      }
    } as unknown as Parameters<typeof runningRecoverySandbox>[0];
    await expect(runningRecoverySandbox(gone, "sb-gone", "app", "name")).resolves.toEqual({});
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

describe("Modal recovery summary agreement", () => {
  it("reports the same recovery summary in status.json and recovery-lifecycle.json", () => {
    const now = "2026-01-01T00:10:00.000Z";
    const files = terminalWorkerFiles();

    const statusState = relaunchedState();
    const statusLaunch = statusState.launches[0]!;
    const row = modalBenchmarkStatusRow({
      state: statusState,
      launch: statusLaunch,
      files,
      sandbox: { state: "exited", exitCode: 0 },
      now
    });

    // What `collect` folds into the state it persists, then writes as recovery-lifecycle.json.
    const collectState = relaunchedState();
    const collectLaunch = collectState.launches[0]!;
    observeTerminalModalRecoveryLifecycle(
      collectState,
      collectLaunch,
      latestModalWorkerStatus(
        Object.values(files).map((contents) => JSON.parse(contents) as unknown),
        collectLaunch
      ),
      now
    );
    const lifecycle = createModalRecoveryLifecycleDocument(
      collectState.recovery_lifecycle.filter((record) => record.model_slug === collectLaunch.slug)
    );

    expect(row.recovery_summary).toEqual(lifecycle.summary);
    expect(lifecycle.summary.total_generations).toBe(2);
    expect(lifecycle.summary.model_work_generations).toBe(1);
    expect(lifecycle.summary.terminal_generations).toBe(2);
    expect(lifecycle.summary.active_generations).toBe(0);
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

function imageInspectionState(imageId: string) {
  return createModalLaunchState({
    logicalRunId: "image-inspection-run",
    generation: 1,
    generationMode: "fresh",
    app: "app-placeholder",
    image: "shared-image",
    imageId,
    timeoutMs: 60_000,
    sourceRevision: "revision-placeholder",
    fingerprints: {
      config: "a".repeat(64),
      source: "b".repeat(64),
      image: fingerprintModalImage("shared-image", imageId)
    }
  });
}

function legacyImageInspectionState() {
  return {
    schema_version: "ultrafuzz.modal.launch-state.v1",
    run_id: "legacy-image-inspection-run",
    app: "app-placeholder",
    image: "shared-image",
    timeout_ms: 60_000,
    source_revision: "revision-placeholder",
    launches: [
      {
        ...MODEL,
        sandbox_id: "sandbox-placeholder",
        volume_name: "volume-placeholder",
        remote_root: "/data/legacy-image-inspection-run/model-one",
        launched_at: "2026-01-01T00:00:00.000Z"
      }
    ]
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

/** A generation whose first attempt was relaunched, leaving the second attempt still `active`. */
function relaunchedState() {
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
  reserveModalLaunchAttempt({
    state,
    model: MODEL,
    modelFingerprint: fingerprintModalModel(MODEL),
    volumeName: "volume-placeholder",
    remoteRoot: "/data/logical-run/model-one",
    workspaceMode: "fresh",
    attemptId: "original-attempt",
    now: "2026-01-01T00:00:00.000Z"
  });
  const record = reserveModalLaunchAttempt({
    state,
    model: MODEL,
    modelFingerprint: fingerprintModalModel(MODEL),
    volumeName: "volume-placeholder",
    remoteRoot: "/data/logical-run/model-one",
    workspaceMode: "resume",
    startReason: "pre-model-retry",
    observedModelWorkStarted: false,
    attemptId: "relaunched-attempt",
    now: "2026-01-01T00:00:30.000Z"
  });
  markModalSandboxCreated(record, "sandbox-placeholder");
  markModalLaunchReady(record, "2026-01-01T00:01:00.000Z");
  return state;
}

function terminalWorkerFiles(): Record<string, string> {
  const base = {
    schema_version: "ultrafuzz.modal.worker-result.v2",
    generation: 3,
    launch_generation: 1,
    attempt: 2,
    model_work_started: true,
    counts: { succeeded: 1, failed: 0, remaining: 0 },
    checkpoint: { age_ms: 0, digest: `sha256:${"a".repeat(64)}` },
    runtime_ms: 100,
    usage: null
  };
  return {
    "status.json": `${JSON.stringify({
      ...base,
      result_type: "partial",
      exit_category: "live",
      diagnostic_code: "worker-live"
    })}\n`,
    "result.json": `${JSON.stringify({
      ...base,
      result_type: "terminal",
      exit_category: "finished",
      diagnostic_code: "worker-finished"
    })}\n`
  };
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
