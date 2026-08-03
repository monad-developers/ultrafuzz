import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SandboxFilesystemNotFoundError, type Sandbox } from "modal";
import { describe, expect, it, vi } from "vitest";

import {
  cleanupModalNodeRun,
  createModalNodeHandoffArchive,
  createModalNodeSandboxProvider,
  ModalNodeCleanupRefusedError,
  modalNodeSandboxName,
  modalNodeTags,
  modalNodeVolumeName,
  parseModalNodeSandboxInput,
  type ModalNodeSandboxInput
} from "../src/node-provider.js";
import { copySafeTree, stageCanonicalNodeResultBundle } from "../src/node-worker.js";
import { extractSafeTarArchive } from "../src/safe-archive.js";

const PROVIDER_ID_ENV = "ULTRAFUZZ_TEST_PROVIDER_ID";
const PROVIDER_SECRET_ENV = "ULTRAFUZZ_TEST_PROVIDER_SECRET";
const AGENT_ENV = "ULTRAFUZZ_TEST_AGENT_KEY";

describe("Modal node sandbox provider", () => {
  it("uses stable bounded identities without embedding raw controller identifiers", () => {
    const tags = modalNodeTags("run/with spaces", "node:attempt");
    expect(tags).toEqual({
      purpose: "ultrafuzz-node",
      run: expect.stringMatching(/^run-with-spaces-[0-9a-f]{12}$/u),
      attempt: expect.stringMatching(/^node-attempt-base-[0-9a-f]{12}$/u)
    });
    expect(modalNodeVolumeName("run/with spaces")).toMatch(/^ultrafuzz-node-run-with-spaces-[0-9a-f]{12}$/u);
    expect(modalNodeSandboxName("run/with spaces", "node:attempt")).toMatch(
      /^ufz-run-with-spaces-node-attempt-bas-[0-9a-f]{12}$/u
    );
    expect(modalNodeTags("run/with spaces", "node:attempt", "reset-one").attempt).not.toBe(tags.attempt);
  });

  it("creates an immutable handoff from committed source plus only declared dependency evidence", async () => {
    const fixture = createProjectFixture();
    fs.writeFileSync(path.join(fixture.root, "local-only-secret"), "must stay local\n");
    fs.writeFileSync(path.join(fixture.root, "source.txt"), "current checkout B\n");
    fs.writeFileSync(path.join(fixture.root, "current-only.txt"), "must not cross the pinned handoff\n");
    execFileSync("git", ["add", "source.txt", "current-only.txt"], { cwd: fixture.root });
    execFileSync("git", ["commit", "--quiet", "-m", "move current checkout to B"], { cwd: fixture.root });
    const currentCommit = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: fixture.root,
      encoding: "utf8"
    }).trim();
    expect(currentCommit).not.toBe(fixture.input.base_commit);
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    const extracted = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-handoff-extracted-"));
    try {
      const entries = execFileSync("tar", ["-tzf", archive.path], { encoding: "utf8" });
      expect(entries).toContain("./source.txt");
      expect(entries).toContain(`./${fixture.input.workflow_path}`);
      expect(entries).toContain(`./${fixture.input.prompt_path}`);
      expect(entries).toContain("./.smithers/agents/deepseek.ts");
      expect(entries).toContain("./.smithers/agents/kimi.ts");
      for (const dependency of fixture.input.dependency_artifact_dirs) {
        expect(entries).toContain(`./${dependency}/`);
      }
      expect(entries).not.toContain("local-only-secret");
      expect(entries).not.toContain("current-only.txt");
      expect(entries).not.toContain("unrelated.txt");
      expect(entries).not.toContain("stale.txt");
      expect(entries).not.toContain(`./${fixture.input.run_root}/workspaces/`);
      expect(entries).not.toContain(`./${fixture.input.run_root}/logs/`);
      expect(entries).not.toContain("./.git/logs/");
      expect(entries).not.toContain("./.git/hooks/");
      expect(archive.sha256).toMatch(/^[0-9a-f]{64}$/u);
      await extractSafeTarArchive(archive.path, extracted, { gzip: true, label: "cloud handoff test" });
      const extractedCommit = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
        cwd: extracted,
        encoding: "utf8"
      }).trim();
      expect(extractedCommit).toBe(fixture.input.base_commit);
      expect(fs.readFileSync(path.join(extracted, "source.txt"), "utf8")).toBe("committed source\n");
      expect(fs.readFileSync(path.join(extracted, ".smithers", "agents", "deepseek.ts"), "utf8")).toContain(
        "createDeepSeekAgent"
      );
      expect(() => execFileSync("git", ["cat-file", "-e", "HEAD^"], { cwd: extracted, stdio: "ignore" })).toThrow();
    } finally {
      fs.rmSync(extracted, { recursive: true, force: true });
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("validates the exact base commit and confines generated workflows to .smithers/workflows", async () => {
    const fixture = createProjectFixture();
    try {
      expect(() => parseModalNodeSandboxInput({ ...fixture.input, base_commit: "A".repeat(40) })).toThrow(
        /base commit is invalid/u
      );
      await expect(
        createModalNodeHandoffArchive(fixture.root, {
          ...fixture.input,
          workflow_path: fixture.input.prompt_path!
        })
      ).rejects.toThrow(/workflow path must stay inside \.smithers\/workflows/u);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects committed symlinks before building a cloud handoff archive", async () => {
    const fixture = createProjectFixture();
    try {
      fs.symlinkSync("source.txt", path.join(fixture.root, "source-link.txt"));
      execFileSync("git", ["add", "source-link.txt"], { cwd: fixture.root });
      execFileSync("git", ["commit", "--quiet", "-m", "add symlink"], { cwd: fixture.root });
      fixture.input.base_commit = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
        cwd: fixture.root,
        encoding: "utf8"
      }).trim();

      await expect(createModalNodeHandoffArchive(fixture.root, fixture.input)).rejects.toThrow(
        /unsafe filesystem entry|unsupported symlink entry/u
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects link entries before extracting a cloud result archive", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-archive-link-"));
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const outside = path.join(root, "outside");
    const archive = path.join(root, "result.tgz");
    try {
      fs.mkdirSync(source);
      fs.mkdirSync(destination);
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, path.join(source, "escape"), "dir");
      execFileSync("tar", ["-czf", archive, "-C", source, "."]);

      await expect(extractSafeTarArchive(archive, destination, { gzip: true, label: "test result" })).rejects.toThrow(
        /unsupported symlink entry/u
      );
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to publish a symlinked artifact root from a worker", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-worker-symlink-"));
    try {
      const outside = path.join(root, "outside");
      const source = path.join(root, "artifact-root");
      const destination = path.join(root, "published");
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, "secret.txt"), "must not publish\n");
      fs.symlinkSync(outside, source, "dir");

      expect(() => copySafeTree(source, destination)).toThrow(/cloud publication source is unsafe/u);
      expect(fs.existsSync(path.join(destination, "secret.txt"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to publish through a symlinked worker destination", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-worker-destination-symlink-"));
    try {
      const source = path.join(root, "source");
      const outside = path.join(root, "outside");
      const destination = path.join(root, "destination");
      fs.mkdirSync(source, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(source, "finding.json"), '{"ok":true}\n');
      fs.symlinkSync(outside, destination, "dir");

      expect(() => copySafeTree(source, destination)).toThrow(/cloud publication destination is unsafe/u);
      expect(fs.existsSync(path.join(outside, "finding.json"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("stages only canonical task artifacts while retaining mirrors and source attestation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-worker-canonical-result-"));
    try {
      const artifactDir = path.join(root, "canonical", "attempt-one");
      const workspaceDir = path.join(root, "workspace");
      const mirror = path.join(workspaceDir, "artifacts", "attempt-one");
      const stagingDir = path.join(root, "staging");
      fs.mkdirSync(path.join(artifactDir, "generated-tests"), { recursive: true });
      fs.mkdirSync(path.join(mirror, "generated-tests"), { recursive: true });
      fs.mkdirSync(path.join(workspaceDir, "node_modules", ".bin"), { recursive: true });
      fs.mkdirSync(stagingDir);

      fs.writeFileSync(path.join(artifactDir, "report.md"), "# canonical report\n");
      fs.writeFileSync(path.join(artifactDir, "report.json"), '{"schema_version":"1.0"}\n');
      fs.writeFileSync(path.join(artifactDir, "findings.normalized.json"), "[]\n");
      fs.writeFileSync(
        path.join(artifactDir, ".ultrafuzz-workspace-source-attestation.json"),
        '{"schema_version":"ultrafuzz.workspace-source-attestation.v1"}\n'
      );
      fs.writeFileSync(path.join(mirror, "report.md"), "# stale mirror report\n");
      fs.writeFileSync(path.join(mirror, "generated-tests", "Generated.t.sol"), "contract GeneratedTest {}\n");
      fs.symlinkSync("/usr/bin/env", path.join(workspaceDir, "node_modules", ".bin", "tool"));

      stageCanonicalNodeResultBundle({ artifactDir, workspaceDir, attemptId: "attempt-one", stagingDir });

      expect(fs.readdirSync(stagingDir)).toEqual(["artifacts"]);
      const published = path.join(stagingDir, "artifacts");
      expect(fs.readFileSync(path.join(published, "report.md"), "utf8")).toBe("# canonical report\n");
      expect(fs.readFileSync(path.join(published, "report.json"), "utf8")).toContain('"schema_version":"1.0"');
      expect(fs.readFileSync(path.join(published, "findings.normalized.json"), "utf8")).toBe("[]\n");
      expect(fs.readFileSync(path.join(published, ".ultrafuzz-workspace-source-attestation.json"), "utf8")).toContain(
        "ultrafuzz.workspace-source-attestation.v1"
      );
      expect(fs.readFileSync(path.join(published, "generated-tests", "Generated.t.sol"), "utf8")).toContain(
        "GeneratedTest"
      );
      expect(fs.existsSync(path.join(stagingDir, "workspace"))).toBe(false);
      expect(fs.existsSync(path.join(published, "node_modules"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reattaches to one live attempt and atomically publishes its durable result", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const sandbox = fakeSandbox(result);
    const client = fakeClient({ listed: [sandbox] });
    const provider = createModalNodeSandboxProvider(providerOptions(client));
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).resolves.toMatchObject({
        status: "finished",
        remoteRunId: "sandbox-one",
        workspaceId: "run-one/attempt-one/base"
      });
      expect(client.sandboxes.create).not.toHaveBeenCalled();
      expect(sandbox.exec).not.toHaveBeenCalled();
      expect(sandbox.filesystem.copyFromLocal).not.toHaveBeenCalled();
      expect(sandbox.terminate).toHaveBeenCalledOnce();
      expect(fs.readFileSync(path.join(fixture.root, fixture.input.artifact_dir, "finding.json"), "utf8")).toBe(
        '{"ok":true}\n'
      );
      expect(fs.existsSync(path.join(fixture.root, fixture.input.artifact_dir, "stale.txt"))).toBe(false);
      expect(
        fs.readFileSync(
          path.join(fixture.root, fixture.input.artifact_dir, ".ultrafuzz-workspace-source-attestation.json"),
          "utf8"
        )
      ).toContain("ultrafuzz.workspace-source-attestation.v1");
      expect(fs.readFileSync(path.join(fixture.root, fixture.input.artifact_dir, "report.md"), "utf8")).toBe(
        "# remote report\n"
      );
      expect(fs.existsSync(path.join(fixture.root, fixture.input.workspace_dir, "work.txt"))).toBe(false);
      expect(fs.readFileSync(path.join(fixture.root, fixture.input.workspace_dir, "local.txt"), "utf8")).toBe(
        "excluded\n"
      );
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("recovers a published result before starting a replacement worker", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const sandbox = fakeSandbox(result);
    const client = fakeClient({ created: sandbox });
    const provider = createModalNodeSandboxProvider(providerOptions(client));
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).resolves.toMatchObject({ status: "finished" });
      expect(client.sandboxes.create).toHaveBeenCalledOnce();
      expect(sandbox.exec).not.toHaveBeenCalled();
      expect(sandbox.filesystem.copyFromLocal).not.toHaveBeenCalled();
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects legacy cloud results that include a recursively copied workspace", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive({ includeWorkspace: true });
    const sandbox = fakeSandbox(result);
    const client = fakeClient({ listed: [sandbox] });
    const provider = createModalNodeSandboxProvider(providerOptions(client));
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/must contain only canonical artifacts/u);
      expect(fs.existsSync(path.join(fixture.root, fixture.input.workspace_dir, "work.txt"))).toBe(false);
      expect(fs.readFileSync(path.join(fixture.root, fixture.input.artifact_dir, "stale.txt"), "utf8")).toBe("stale\n");
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("reports structured worker diagnostics when a fresh cloud worker fails", async () => {
    const fixture = createProjectFixture();
    const sandbox = fakeSandbox(undefined);
    sandbox.exec = vi.fn(async () => ({
      stdout: { readText: vi.fn(async () => "worker stdout\n") },
      stderr: {
        readText: vi.fn(
          async () =>
            '{"schema_version":"ultrafuzz.modal.node-worker-error.v1","message":"cloud worker phase run-workflow failed with code 7","phase":"run-workflow","command":"smithers","exit_code":7,"stderr":"workflow failed"}\n'
        )
      },
      wait: vi.fn(async () => 7)
    })) as never;
    const client = fakeClient({ created: sandbox });
    const provider = createModalNodeSandboxProvider(providerOptions(client));
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/run-workflow.*workflow failed/u);
      expect(sandbox.terminate).toHaveBeenCalledOnce();
    } finally {
      fixture.cleanup();
    }
  });

  it("binds Moonshot fallback credentials into the canonical Kimi API-key secret", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const sandbox = fakeSandbox(result);
    const client = fakeClient({ created: sandbox });
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(client),
      env: {
        [PROVIDER_ID_ENV]: "provider-id-value",
        [PROVIDER_SECRET_ENV]: "provider-secret-value",
        MOONSHOT_API_KEY: "moonshot-key-value"
      }
    });
    fixture.input.agent_credential_env = ["KIMI_API_KEY"];
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).resolves.toMatchObject({ status: "finished" });
      expect(client.secrets.fromObject).toHaveBeenCalledWith({ KIMI_API_KEY: "moonshot-key-value" });
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("treats Moonshot as an optional Kimi fallback when compiled cloud tasks list both names", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const sandbox = fakeSandbox(result);
    const client = fakeClient({ created: sandbox });
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(client),
      env: {
        [PROVIDER_ID_ENV]: "provider-id-value",
        [PROVIDER_SECRET_ENV]: "provider-secret-value",
        KIMI_API_KEY: "kimi-key-value"
      }
    });
    fixture.input.agent_credential_env = ["KIMI_API_KEY", "MOONSHOT_API_KEY"];
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).resolves.toMatchObject({ status: "finished" });
      expect(client.secrets.fromObject).toHaveBeenCalledWith({ KIMI_API_KEY: "kimi-key-value" });
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("binds a compiled Moonshot fallback list into Kimi Code's canonical API-key secret", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const sandbox = fakeSandbox(result);
    const client = fakeClient({ created: sandbox });
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(client),
      env: {
        [PROVIDER_ID_ENV]: "provider-id-value",
        [PROVIDER_SECRET_ENV]: "provider-secret-value",
        MOONSHOT_API_KEY: "moonshot-key-value"
      }
    });
    fixture.input.agent_credential_env = ["KIMI_API_KEY", "MOONSHOT_API_KEY"];
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).resolves.toMatchObject({ status: "finished" });
      expect(client.secrets.fromObject).toHaveBeenCalledWith({ KIMI_API_KEY: "moonshot-key-value" });
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("forwards optional Kimi API base URLs into cloud-node workers", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const sandbox = fakeSandbox(result);
    const client = fakeClient({ created: sandbox });
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(client),
      env: {
        [PROVIDER_ID_ENV]: "provider-id-value",
        [PROVIDER_SECRET_ENV]: "provider-secret-value",
        KIMI_API_KEY: "kimi-key-value",
        KIMI_BASE_URL: "https://kimi.example.invalid/v1"
      }
    });
    fixture.input.agent_credential_env = ["KIMI_API_KEY", "MOONSHOT_API_KEY", "KIMI_BASE_URL"];
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).resolves.toMatchObject({ status: "finished" });
      expect(client.secrets.fromObject).toHaveBeenCalledWith({
        KIMI_API_KEY: "kimi-key-value",
        KIMI_BASE_URL: "https://kimi.example.invalid/v1"
      });
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("refuses to publish cloud results through a symlinked project destination prefix", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const sandbox = fakeSandbox(result);
    const client = fakeClient({ listed: [sandbox] });
    const provider = createModalNodeSandboxProvider(providerOptions(client));
    const outside = path.join(path.dirname(fixture.root), "outside-artifacts");
    try {
      fixture.input.artifact_dir = "published-artifacts/attempt-one";
      fs.mkdirSync(outside, { recursive: true });
      fs.symlinkSync(outside, path.join(fixture.root, "published-artifacts"), "dir");

      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/artifact directory is not an anchored project path/u);
      expect(fs.existsSync(path.join(outside, "attempt-one", "finding.json"))).toBe(false);
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("terminates a fresh sandbox when cancellation interrupts the worker", async () => {
    const fixture = createProjectFixture();
    const sandbox = fakeSandbox(undefined);
    sandbox.filesystem.readText = vi.fn(async () => {
      throw new SandboxFilesystemNotFoundError("not found");
    });
    sandbox.exec = vi.fn(async () => ({
      stdout: { readText: vi.fn(async () => "") },
      stderr: { readText: vi.fn(async () => "") },
      wait: vi.fn(() => new Promise<number>(() => undefined))
    })) as never;
    const client = fakeClient({ created: sandbox });
    const provider = createModalNodeSandboxProvider(providerOptions(client));
    const controller = new AbortController();
    try {
      const running = provider.run({
        runId: "controller-run",
        sandboxId: "node:attempt",
        input: fixture.input,
        rootDir: fixture.root,
        signal: controller.signal,
        heartbeat: vi.fn()
      });
      await vi.waitFor(() => expect(sandbox.exec).toHaveBeenCalledOnce());
      controller.abort();
      await expect(running).rejects.toThrow("cancelled");
      expect(sandbox.terminate).toHaveBeenCalled();
    } finally {
      fixture.cleanup();
    }
  });

  it("requires force before deleting storage for a run with active sandboxes", async () => {
    const active = fakeSandbox(undefined);
    const refusedClient = fakeClient({ listed: [active] });
    const refused = cleanupModalNodeRun(providerOptions(refusedClient), "controller-run");
    await expect(refused).rejects.toBeInstanceOf(ModalNodeCleanupRefusedError);
    await expect(refused).rejects.toMatchObject({
      name: "ModalNodeCleanupRefusedError",
      code: "MODAL_NODE_CLEANUP_REFUSED",
      message: "cloud cleanup refused because the run still has active node sandboxes"
    });
    expect(refusedClient.volumes.delete).not.toHaveBeenCalled();

    const forceClient = fakeClient({ listed: [fakeSandbox(undefined)] });
    await expect(cleanupModalNodeRun(providerOptions(forceClient), "controller-run", { force: true })).resolves.toEqual(
      { terminated: 1, volumeDeleted: true }
    );
    expect(forceClient.volumes.delete).toHaveBeenCalledWith(modalNodeVolumeName("controller-run"));
  });

  it("treats a sandbox that finishes during forced cleanup as already terminated", async () => {
    const sandbox = fakeSandbox(undefined);
    sandbox.poll = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(0);
    sandbox.terminate = vi.fn(async () => {
      throw new Error("sandbox already stopped");
    });
    const client = fakeClient({ listed: [sandbox] });

    await expect(cleanupModalNodeRun(providerOptions(client), "controller-run", { force: true })).resolves.toEqual({
      terminated: 0,
      volumeDeleted: true
    });
    expect(sandbox.detach).toHaveBeenCalledOnce();
    expect(client.volumes.delete).toHaveBeenCalledOnce();
  });

  it("fails without echoing configured credential identifiers", async () => {
    const fixture = createProjectFixture();
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(fakeClient({})),
      env: {}
    });
    try {
      const run = provider.run({
        runId: "controller-run",
        sandboxId: "node:attempt",
        input: fixture.input,
        rootDir: fixture.root,
        heartbeat: vi.fn()
      });
      await expect(run).rejects.toThrow("configured cloud credential is unavailable");
      await expect(run).rejects.not.toThrow(PROVIDER_ID_ENV);
    } finally {
      fixture.cleanup();
    }
  });
});

function providerOptions(client: ReturnType<typeof fakeClient>) {
  return {
    app: "ultrafuzz-test",
    image: "ultrafuzz-test-image",
    credentialEnv: [PROVIDER_ID_ENV, PROVIDER_SECRET_ENV],
    env: {
      [PROVIDER_ID_ENV]: "provider-id-value",
      [PROVIDER_SECRET_ENV]: "provider-secret-value",
      [AGENT_ENV]: "agent-key-value"
    },
    clientFactory: () => client as never
  };
}

function createProjectFixture() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-provider-test-"));
  const root = path.join(temporaryRoot, "project");
  const runRoot = ".ultrafuzz/runs/run-one";
  const artifactDir = `${runRoot}/artifacts/attempt-one`;
  const dependencyArtifactDirs = [`${runRoot}/artifacts/dependency-one`, `${runRoot}/artifacts/dependency-two`];
  const workspaceDir = `${runRoot}/workspaces/attempt-one`;
  const workflowPath = ".smithers/workflows/ultrafuzz-run-one.tsx";
  const promptPath = `${runRoot}/prompts/attempt-one.md`;
  fs.mkdirSync(path.join(root, path.dirname(workflowPath)), { recursive: true });
  fs.mkdirSync(path.join(root, path.dirname(promptPath)), { recursive: true });
  fs.mkdirSync(path.join(root, ".smithers", "agents"), { recursive: true });
  fs.mkdirSync(path.join(root, artifactDir), { recursive: true });
  for (const dependency of dependencyArtifactDirs) {
    fs.mkdirSync(path.join(root, dependency), { recursive: true });
    fs.writeFileSync(path.join(root, dependency, "declared.txt"), `${dependency}\n`);
  }
  fs.mkdirSync(path.join(root, runRoot, "artifacts", "unrelated"), { recursive: true });
  fs.mkdirSync(path.join(root, workspaceDir), { recursive: true });
  fs.mkdirSync(path.join(root, runRoot, "logs"), { recursive: true });
  fs.writeFileSync(path.join(root, "source.txt"), "historical source\n");
  fs.writeFileSync(path.join(root, "historical-secret.txt"), "must not survive shallow handoff\n");
  fs.writeFileSync(
    path.join(root, ".smithers", "agents", "deepseek.ts"),
    "export const createDeepSeekAgent = () => ({});\n"
  );
  fs.writeFileSync(path.join(root, ".smithers", "agents", "kimi.ts"), "export const createKimiAgent = () => ({});\n");
  fs.writeFileSync(path.join(root, workflowPath), "export default {};\n");
  fs.writeFileSync(path.join(root, promptPath), "rendered prompt\n");
  fs.writeFileSync(path.join(root, artifactDir, "stale.txt"), "stale\n");
  fs.writeFileSync(path.join(root, runRoot, "artifacts", "unrelated", "unrelated.txt"), "unrelated\n");
  fs.writeFileSync(path.join(root, workspaceDir, "local.txt"), "excluded\n");
  fs.writeFileSync(path.join(root, runRoot, "logs", "local.log"), "excluded\n");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Ultrafuzz Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@invalid"], { cwd: root });
  execFileSync("git", ["add", "source.txt", "historical-secret.txt"], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "historical fixture"], { cwd: root });
  fs.writeFileSync(path.join(root, "source.txt"), "committed source\n");
  fs.unlinkSync(path.join(root, "historical-secret.txt"));
  execFileSync("git", ["add", "source.txt", "historical-secret.txt"], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
  const baseCommit = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: root,
    encoding: "utf8"
  }).trim();
  const input: ModalNodeSandboxInput = {
    schema_version: "ultrafuzz.modal.node.v1",
    run_id: "run-one",
    task_id: "node:attempt-one",
    attempt_id: "attempt-one",
    execution_generation: "base",
    base_commit: baseCommit,
    workflow_path: workflowPath,
    prompt_path: promptPath,
    run_root: runRoot,
    artifact_dir: artifactDir,
    workspace_dir: workspaceDir,
    dependency_artifact_dirs: dependencyArtifactDirs,
    resources: {
      cpu: 2,
      memory_mib: 4096,
      timeout_seconds: 60
    },
    agent_credential_env: [AGENT_ENV]
  };
  return {
    root,
    input,
    cleanup: () => fs.rmSync(temporaryRoot, { recursive: true, force: true })
  };
}

function createResultArchive(options: { includeWorkspace?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-result-test-"));
  const bundle = path.join(root, "bundle");
  const archive = path.join(root, "result.tgz");
  fs.mkdirSync(path.join(bundle, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(bundle, "artifacts", "finding.json"), '{"ok":true}\n');
  fs.writeFileSync(path.join(bundle, "artifacts", "report.md"), "# remote report\n");
  fs.writeFileSync(path.join(bundle, "artifacts", "report.json"), '{"schema_version":"1.0"}\n');
  fs.writeFileSync(path.join(bundle, "artifacts", "findings.normalized.json"), "[]\n");
  fs.writeFileSync(
    path.join(bundle, "artifacts", ".ultrafuzz-workspace-source-attestation.json"),
    '{"schema_version":"ultrafuzz.workspace-source-attestation.v1"}\n'
  );
  if (options.includeWorkspace === true) {
    fs.mkdirSync(path.join(bundle, "workspace"), { recursive: true });
    fs.writeFileSync(path.join(bundle, "workspace", "work.txt"), "remote workspace\n");
  }
  execFileSync("tar", ["-czf", archive, "-C", bundle, "."]);
  const digest = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  const tags = modalNodeTags("controller-run", "node:attempt");
  return {
    archive,
    result: JSON.stringify({
      schema_version: "ultrafuzz.modal.node-result.v1",
      status: "succeeded",
      artifact_archive: `/data/ultrafuzz-nodes/${tags.run}/${tags.attempt}/artifacts.tgz`,
      artifact_sha256: digest,
      storage_lineage: "run-one/attempt-one/base"
    }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

function fakeSandbox(result: ReturnType<typeof createResultArchive> | undefined) {
  return {
    sandboxId: "sandbox-one",
    poll: vi.fn(async () => null),
    terminate: vi.fn(async () => undefined),
    detach: vi.fn(),
    exec: vi.fn(),
    filesystem: {
      readText: vi.fn(async () => {
        if (result === undefined) throw new SandboxFilesystemNotFoundError("not found");
        return result.result;
      }),
      copyFromLocal: vi.fn(async () => undefined),
      copyToLocal: vi.fn(async (_remote: string, local: string) => {
        if (result === undefined) throw new Error("result is unavailable");
        fs.copyFileSync(result.archive, local);
      })
    }
  } as unknown as Sandbox & {
    poll: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
    filesystem: {
      readText: ReturnType<typeof vi.fn>;
      copyFromLocal: ReturnType<typeof vi.fn>;
      copyToLocal: ReturnType<typeof vi.fn>;
    };
  };
}

function fakeClient(options: { listed?: Sandbox[]; created?: Sandbox }) {
  const listed = options.listed ?? [];
  return {
    apps: {
      fromName: vi.fn(async () => ({ appId: "app-one" }))
    },
    images: {
      fromName: vi.fn(async () => ({}))
    },
    volumes: {
      fromName: vi.fn(async () => ({})),
      delete: vi.fn(async () => undefined)
    },
    secrets: {
      fromObject: vi.fn(async () => ({}))
    },
    sandboxes: {
      create: vi.fn(async () => options.created ?? fakeSandbox(undefined)),
      list: vi.fn(async function* () {
        for (const sandbox of listed) yield sandbox;
      })
    },
    close: vi.fn()
  };
}
