import { execFileSync, spawn } from "node:child_process";
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
  modalNodeVolumeSubpath,
  modalNodeWorkerLaunchScript,
  modalNodeWorkerSignalScript,
  readCloudAttemptEvidence,
  type ModalNodeSandboxInput
} from "../src/node-provider.js";
import { assertNoCredentialValuesInTree, copySafeTree } from "../src/node-worker.js";
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

  it("pauses and resumes the real worker process group including child work", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-process-group-"));
    const ready = path.join(root, "ready");
    const processGroup = path.join(root, "worker.pgid");
    const counter = path.join(root, "counter");
    fs.writeFileSync(ready, "");
    const launch = modalNodeWorkerLaunchScript(
      ["bash", "-lc", `while :; do printf x >> '${counter}'; sleep 0.05; done`],
      ready,
      processGroup
    );
    const wrapper = spawn("bash", ["-lc", launch], { stdio: "ignore" });
    try {
      await waitForCondition(
        () => fs.existsSync(processGroup) && fs.existsSync(counter) && fs.statSync(counter).size >= 3
      );
      execFileSync("bash", ["-lc", modalNodeWorkerSignalScript("STOP", processGroup)]);
      await testDelay(150);
      const pausedSize = fs.statSync(counter).size;
      await testDelay(250);
      expect(fs.statSync(counter).size).toBe(pausedSize);
      execFileSync("bash", ["-lc", modalNodeWorkerSignalScript("CONT", processGroup)]);
      await waitForCondition(() => fs.statSync(counter).size > pausedSize);
    } finally {
      if (fs.existsSync(processGroup)) {
        const pgid = fs.readFileSync(processGroup, "utf8").trim();
        if (/^[1-9][0-9]*$/u.test(pgid)) {
          try {
            process.kill(-Number(pgid), "SIGTERM");
          } catch {
            // The process group may already have exited.
          }
        }
      }
      wrapper.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (wrapper.exitCode !== null) resolve();
        else wrapper.once("close", () => resolve());
      });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates an immutable handoff from committed source plus only declared dependency evidence", async () => {
    const fixture = createProjectFixture();
    fs.writeFileSync(path.join(fixture.root, "local-only-secret"), "must stay local\n");
    fs.writeFileSync(
      path.join(fixture.root, fixture.input.dependency_artifact_dirs[0]!, ".env"),
      "DEPENDENCY_SECRET=must-not-cross\n"
    );
    fs.mkdirSync(path.join(fixture.root, fixture.input.dependency_artifact_dirs[1]!, ".ssh"), {
      recursive: true
    });
    fs.writeFileSync(
      path.join(fixture.root, fixture.input.dependency_artifact_dirs[1]!, ".ssh", "id_rsa"),
      "must-not-cross\n"
    );
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    try {
      const entries = execFileSync("tar", ["-tzf", archive.path], { encoding: "utf8" });
      expect(entries).toContain("./source.txt");
      expect(entries).toContain(`./${fixture.input.workflow_path}`);
      expect(entries).toContain(`./${fixture.input.prompt_path}`);
      expect(entries).toContain("./.smithers/agents/kimi.ts");
      for (const dependency of fixture.input.dependency_artifact_dirs) {
        expect(entries).toContain(`./${dependency}/`);
      }
      expect(entries).not.toContain("local-only-secret");
      expect(entries).not.toContain("unrelated.txt");
      expect(entries).not.toContain("stale.txt");
      expect(entries).not.toContain(`./${fixture.input.run_root}/workspaces/`);
      expect(entries).not.toContain(`./${fixture.input.run_root}/logs/`);
      expect(entries).not.toContain("./.git/logs/");
      expect(entries).not.toContain("./.git/hooks/");
      expect(entries).not.toContain(`./${fixture.input.dependency_artifact_dirs[0]}/.env`);
      expect(entries).not.toContain(`./${fixture.input.dependency_artifact_dirs[1]}/.ssh/id_rsa`);
      expect(archive.sha256).toMatch(/^[0-9a-f]{64}$/u);
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("includes initialized recursive submodules at the exact committed gitlink revisions", async () => {
    const fixture = createProjectFixture();
    const repositories = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-submodules-"));
    const leaf = path.join(repositories, "leaf");
    const parent = path.join(repositories, "parent");
    try {
      initializeGitRepository(leaf, "leaf.txt", "leaf source\n");
      initializeGitRepository(parent, "parent.txt", "parent source\n");
      execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", leaf, "nested/leaf"], {
        cwd: parent
      });
      execFileSync("git", ["commit", "--quiet", "-am", "add nested submodule"], { cwd: parent });
      execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", parent, "vendor/parent"], {
        cwd: fixture.root
      });
      execFileSync("git", ["commit", "--quiet", "-am", "add recursive submodule"], { cwd: fixture.root });
      execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"], {
        cwd: fixture.root
      });

      const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
      try {
        const entries = execFileSync("tar", ["-tzf", archive.path], { encoding: "utf8" }).trim().split("\n");
        expect(entries).toContain("./vendor/parent/parent.txt");
        expect(entries).toContain("./vendor/parent/nested/leaf/leaf.txt");
        expect(
          entries.some((entry) => entry === "./vendor/parent/.git" || entry.startsWith("./vendor/parent/.git/"))
        ).toBe(false);
      } finally {
        archive.cleanup();
      }
      execFileSync("git", ["checkout", "--quiet", "HEAD^"], {
        cwd: path.join(fixture.root, "vendor", "parent")
      });
      await expect(createModalNodeHandoffArchive(fixture.root, fixture.input)).rejects.toThrow(
        /revision does not match the committed gitlink/u
      );
    } finally {
      fs.rmSync(repositories, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  it("excludes tracked credential and agent-auth paths from immutable handoffs", async () => {
    const fixture = createProjectFixture();
    try {
      const sensitive = [
        ".env",
        ".npmrc",
        "credentials.json",
        ".ssh/id_rsa",
        ".smithers/private-auth.json",
        ".config/gh/hosts.yml"
      ];
      for (const relative of [...sensitive, ".env.example"]) {
        const destination = path.join(fixture.root, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, `tracked ${relative}\n`);
      }
      execFileSync("git", ["add", "--", ...sensitive, ".env.example"], { cwd: fixture.root });
      execFileSync("git", ["commit", "--quiet", "-m", "tracked auth fixtures"], { cwd: fixture.root });

      const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
      try {
        const entries = execFileSync("tar", ["-tzf", archive.path], { encoding: "utf8" }).trim().split("\n");
        for (const relative of sensitive) expect(entries).not.toContain(`./${relative}`);
        expect(entries).toContain("./.env.example");
      } finally {
        archive.cleanup();
      }
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

      await expect(createModalNodeHandoffArchive(fixture.root, fixture.input)).rejects.toThrow(
        /unsupported symlink entry/u
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

  it("rejects credential values in publication file names and contents before archival", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-worker-credentials-"));
    try {
      fs.writeFileSync(path.join(root, "safe.txt"), "prefix-injected-agent-secret-suffix");
      expect(() => assertNoCredentialValuesInTree(root, ["injected-agent-secret"])).toThrow(/injected credential/u);
      fs.writeFileSync(path.join(root, "safe.txt"), "safe output");
      fs.writeFileSync(path.join(root, "injected-agent-secret.txt"), "safe output");
      expect(() => assertNoCredentialValuesInTree(root, ["injected-agent-secret"])).toThrow(/injected credential/u);
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
      expect(fs.readFileSync(path.join(fixture.root, fixture.input.workspace_dir, "work.txt"), "utf8")).toBe(
        "remote workspace\n"
      );
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("recovers a published result before starting a replacement worker", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const interrupted = fakeSandbox(undefined, undefined, "sandbox-original");
    interrupted.filesystem.readText = vi.fn(async () => {
      const error = new Error("provider connection unavailable");
      error.name = "InternalFailure";
      throw error;
    });
    const firstClient = fakeClient({ listed: [interrupted] });
    const inspector = fakeSandbox(result, undefined, "sandbox-inspector");
    const recoveryClient = fakeClient({ created: inspector });
    try {
      await expect(
        createModalNodeSandboxProvider(providerOptions(firstClient)).run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/provider connection unavailable/u);
      expect(interrupted.terminate).not.toHaveBeenCalled();
      expect(interrupted.detach).toHaveBeenCalledOnce();

      await expect(
        createModalNodeSandboxProvider(providerOptions(recoveryClient)).run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).resolves.toMatchObject({ status: "finished" });
      expect(recoveryClient.sandboxes.create).toHaveBeenCalledOnce();
      expect(recoveryClient.sandboxes.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          blockNetwork: true,
          tags: expect.objectContaining({ purpose: "ultrafuzz-node-inspector" })
        })
      );
      expect(recoveryClient.sandboxes.create.mock.calls[0]?.[2]).not.toHaveProperty("secrets");
      expect(inspector.exec).not.toHaveBeenCalled();
      expect(inspector.filesystem.copyFromLocal).not.toHaveBeenCalled();
      expect(readCloudAttemptEvidence(fixture.root, fixture.input)).toMatchObject({
        state: "succeeded",
        provider_execution_ids: ["sandbox-original"],
        retry_index: 0,
        resumed: true,
        reused: true
      });
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("honors a post-pause detach request only after proving the targeted sandbox is live", async () => {
    const fixture = createProjectFixture();
    const sandbox = fakeSandbox(undefined, undefined, "sandbox-live-at-pause");
    const client = fakeClient({ created: sandbox });
    const acceptanceRoot = path.join(fixture.root, fixture.input.run_root, "cloud-execution", "acceptance");
    fs.mkdirSync(acceptanceRoot, { recursive: true });
    fs.writeFileSync(
      path.join(acceptanceRoot, "pause-detach-request.json"),
      `${JSON.stringify({
        schema_version: "ultrafuzz.modal.cloud-acceptance-pause-detach-request.v1",
        controller_run_id: "controller-run",
        run_id: fixture.input.run_id,
        targets: [
          {
            attempt_id: fixture.input.attempt_id,
            provider_execution_id: "sandbox-live-at-pause"
          }
        ],
        requested_at: "2026-07-24T00:00:00.000Z"
      })}\n`
    );
    const baseOptions = providerOptions(client);
    sandbox.exec.mockResolvedValue({ wait: vi.fn(async () => 0) });
    const provider = createModalNodeSandboxProvider({
      ...baseOptions,
      env: { ...baseOptions.env, ULTRAFUZZ_MODAL_CLOUD_ACCEPTANCE: "1" }
    });
    try {
      const run = provider.run({
        runId: "controller-run",
        sandboxId: "node:attempt",
        input: fixture.input,
        rootDir: fixture.root,
        heartbeat: vi.fn()
      });
      await expect(run).rejects.toThrow(/acceptance pause detached a live cloud node sandbox/u);
      expect(sandbox.poll).toHaveBeenCalled();
      expect(sandbox.terminate).not.toHaveBeenCalled();
      expect(sandbox.detach).toHaveBeenCalledOnce();
      expect(readCloudAttemptEvidence(fixture.root, fixture.input)).toMatchObject({
        state: "provider-unknown",
        provider_execution_ids: ["sandbox-live-at-pause"],
        cleanup_state: "pending"
      });
      const claimPath = fs.readdirSync(acceptanceRoot).find((name) => name.startsWith("pause-detach-claim-"));
      expect(claimPath).toBeDefined();
      expect(JSON.parse(fs.readFileSync(path.join(acceptanceRoot, claimPath!), "utf8"))).toMatchObject({
        schema_version: "ultrafuzz.modal.cloud-acceptance-pause-detach-claim.v1",
        controller_run_id: "controller-run",
        run_id: fixture.input.run_id,
        attempt_id: fixture.input.attempt_id,
        provider_execution_id: "sandbox-live-at-pause",
        provider_state_at_detach: "live"
      });
      const result = createResultArchive();
      try {
        sandbox.setResult(result);
        const recoveryOptions = providerOptions(fakeClient({ listed: [sandbox] }));
        await expect(
          createModalNodeSandboxProvider({
            ...recoveryOptions,
            env: { ...recoveryOptions.env, ULTRAFUZZ_MODAL_CLOUD_ACCEPTANCE: "1" }
          }).run({
            runId: "controller-run",
            sandboxId: "node:attempt",
            input: fixture.input,
            rootDir: fixture.root,
            heartbeat: vi.fn()
          })
        ).resolves.toMatchObject({ status: "finished", remoteRunId: "sandbox-live-at-pause" });
        expect(sandbox.exec).toHaveBeenCalledWith(["bash", "-lc", expect.stringContaining("kill -CONT")]);
        const evidence = readCloudAttemptEvidence(fixture.root, fixture.input);
        expect(evidence).toMatchObject({
          state: "succeeded",
          resource_confirmation: "provider-reattached",
          provider_execution_ids: ["sandbox-live-at-pause"],
          resumed: true
        });
        expect(
          evidence.transitions.some(
            (transition) =>
              transition.state === "running" && transition.provider_execution_id === "sandbox-live-at-pause"
          )
        ).toBe(true);
        const releasePath = fs.readdirSync(acceptanceRoot).find((name) => name.startsWith("pause-detach-release-"));
        expect(releasePath).toBeDefined();
        expect(JSON.parse(fs.readFileSync(path.join(acceptanceRoot, releasePath!), "utf8"))).toMatchObject({
          schema_version: "ultrafuzz.modal.cloud-acceptance-pause-detach-release.v1",
          controller_run_id: "controller-run",
          attempt_id: fixture.input.attempt_id,
          provider_execution_id: "sandbox-live-at-pause"
        });
      } finally {
        result.cleanup();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("records a reattached sandbox before releasing an acceptance pause", async () => {
    const fixture = createProjectFixture();
    const sandbox = fakeSandbox(undefined, undefined, "sandbox-reattached-at-pause");
    const acceptanceRoot = path.join(fixture.root, fixture.input.run_root, "cloud-execution", "acceptance");
    fs.mkdirSync(acceptanceRoot, { recursive: true });
    fs.writeFileSync(
      path.join(
        acceptanceRoot,
        `pause-detach-claim-${boundedTestIdentity(`${fixture.input.attempt_id}:${sandbox.sandboxId}`)}.json`
      ),
      `${JSON.stringify({
        schema_version: "ultrafuzz.modal.cloud-acceptance-pause-detach-claim.v1",
        controller_run_id: "controller-run",
        run_id: fixture.input.run_id,
        task_id: fixture.input.task_id,
        attempt_id: fixture.input.attempt_id,
        provider_execution_id: sandbox.sandboxId,
        provider_state_at_detach: "live",
        claimed_at: "2026-07-24T00:00:00.000Z"
      })}\n`
    );
    sandbox.exec.mockRejectedValue(new Error("resume signal failed"));
    const options = providerOptions(fakeClient({ listed: [sandbox] }));
    try {
      await expect(
        createModalNodeSandboxProvider({
          ...options,
          env: { ...options.env, ULTRAFUZZ_MODAL_CLOUD_ACCEPTANCE: "1" }
        }).run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow("resume signal failed");
      expect(readCloudAttemptEvidence(fixture.root, fixture.input)).toMatchObject({
        state: "failed",
        provider_execution_ids: ["sandbox-reattached-at-pause"],
        cleanup_state: "pending"
      });
      expect(sandbox.terminate).not.toHaveBeenCalled();
      expect(sandbox.detach).toHaveBeenCalledOnce();
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a stale controlled-fault marker instead of consuming it for another generation", async () => {
    const fixture = createProjectFixture();
    fixture.input.task_id = "node:smoke-context";
    fixture.input.attempt_id = "smoke-context-attempt";
    const identity = `${fixture.input.task_id}:${fixture.input.attempt_id}`;
    const acceptanceRoot = path.join(fixture.root, fixture.input.run_root, "cloud-execution", "acceptance");
    fs.mkdirSync(acceptanceRoot, { recursive: true });
    fs.writeFileSync(
      path.join(acceptanceRoot, `detach-${boundedTestIdentity(identity)}.json`),
      `${JSON.stringify({
        schema_version: "ultrafuzz.modal.cloud-acceptance-fault.v1",
        fault: "detach",
        task_id: fixture.input.task_id,
        attempt_id: fixture.input.attempt_id,
        execution_generation: "stale-generation",
        claimed_at: "2026-07-24T00:00:00.000Z"
      })}\n`
    );
    const sandbox = fakeSandbox(undefined, undefined, "sandbox-stale-fault");
    const options = providerOptions(fakeClient({ created: sandbox }));
    try {
      await expect(
        createModalNodeSandboxProvider({
          ...options,
          env: { ...options.env, ULTRAFUZZ_MODAL_CLOUD_ACCEPTANCE: "1" }
        }).run({
          runId: "controller-run",
          sandboxId: "node:smoke-context",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/fault marker conflicts with the current attempt identity/u);
      expect(sandbox.terminate).toHaveBeenCalledOnce();
    } finally {
      fixture.cleanup();
    }
  });

  it("recovers a finished sandbox publication by persisted provider ID when listings omit finished sandboxes", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const stopped = fakeSandbox(undefined, undefined, "sandbox-uncommitted");
    const providerFailure = new Error("provider connection unavailable after remote publication");
    providerFailure.name = "InternalFailure";
    stopped.filesystem.readText.mockRejectedValueOnce(providerFailure);
    const inspector = fakeSandbox(result, undefined, "sandbox-inspector");
    try {
      await expect(
        createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [stopped] }))).run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/remote publication/u);
      stopped.poll.mockResolvedValue(0);
      const client = fakeClient({
        fromIds: { "sandbox-uncommitted": stopped },
        created: inspector
      });
      await expect(
        createModalNodeSandboxProvider(providerOptions(client)).run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).resolves.toMatchObject({ status: "finished", remoteRunId: "sandbox-uncommitted" });
      expect(client.sandboxes.fromId).toHaveBeenCalledWith("sandbox-uncommitted");
      expect(client.sandboxes.list).toHaveBeenCalled();
      expect(client.sandboxes.create).toHaveBeenCalledOnce();
      expect(client.sandboxes.create.mock.calls[0]?.[2]).toMatchObject({
        tags: expect.objectContaining({ purpose: "ultrafuzz-node-inspector" })
      });
      expect(readCloudAttemptEvidence(fixture.root, fixture.input)).toMatchObject({
        state: "succeeded",
        provider_execution_ids: ["sandbox-uncommitted"],
        reused: true
      });
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("reports structured worker diagnostics when a fresh cloud worker fails", async () => {
    const fixture = createProjectFixture();
    const sandbox = fakeSandbox(undefined, {
      schema_version: "ultrafuzz.modal.node-worker-error.v1",
      message: "cloud worker phase run-workflow failed with code 7",
      phase: "run-workflow",
      command: "smithers",
      exit_code: 7,
      stderr: `workflow failed ${"agent-key-value"}`
    });
    const client = fakeClient({ created: sandbox });
    const provider = createModalNodeSandboxProvider(providerOptions(client));
    try {
      const run = provider.run({
        runId: "controller-run",
        sandboxId: "node:attempt",
        input: fixture.input,
        rootDir: fixture.root,
        heartbeat: vi.fn()
      });
      await expect(run).rejects.toThrow(/run-workflow.*workflow failed/u);
      await expect(run).rejects.not.toThrow(/agent-key-value/u);
      expect(sandbox.terminate).toHaveBeenCalledOnce();
      expect(sandbox.exec).not.toHaveBeenCalled();
      expect(client.sandboxes.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          command: ["bash", "-lc", expect.stringMatching(/while .*ready-.*setsid .*node-worker/u)]
        })
      );
      expect(JSON.stringify(readCloudAttemptEvidence(fixture.root, fixture.input))).not.toContain("agent-key-value");
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
    const client = fakeClient({ created: sandbox });
    const provider = createModalNodeSandboxProvider(providerOptions(client));
    const controller = new AbortController();
    const heartbeat = vi.fn();
    try {
      const running = provider.run({
        runId: "controller-run",
        sandboxId: "node:attempt",
        input: fixture.input,
        rootDir: fixture.root,
        signal: controller.signal,
        heartbeat
      });
      await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledWith(expect.objectContaining({ stage: "running" })));
      controller.abort();
      await expect(running).rejects.toThrow("cancelled");
      expect(sandbox.terminate).toHaveBeenCalled();
      expect(sandbox.exec).not.toHaveBeenCalled();
    } finally {
      fixture.cleanup();
    }
  });

  it("terminates an owned reattached sandbox when cancellation interrupts the resumed controller", async () => {
    const fixture = createProjectFixture();
    const sandbox = fakeSandbox(undefined, undefined, "sandbox-reattached-cancel");
    const providerFailure = new Error("provider connection unavailable before controller detach");
    providerFailure.name = "InternalFailure";
    sandbox.filesystem.readText.mockRejectedValueOnce(providerFailure);
    try {
      await expect(
        createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [sandbox] }))).run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/provider connection unavailable/u);
      sandbox.filesystem.readText.mockReset();
      sandbox.filesystem.readText.mockRejectedValue(new SandboxFilesystemNotFoundError("not found"));
      const controller = new AbortController();
      const heartbeat = vi.fn();
      const resumed = createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [sandbox] }))).run({
        runId: "controller-run",
        sandboxId: "node:attempt",
        input: fixture.input,
        rootDir: fixture.root,
        signal: controller.signal,
        heartbeat
      });
      await vi.waitFor(() => expect(heartbeat).toHaveBeenCalledWith(expect.objectContaining({ stage: "running" })));
      controller.abort();
      await expect(resumed).rejects.toThrow(/cancelled/u);
      expect(sandbox.terminate).toHaveBeenCalledOnce();
      expect(readCloudAttemptEvidence(fixture.root, fixture.input)).toMatchObject({
        state: "cancelled",
        cleanup_state: "terminated",
        provider_execution_ids: ["sandbox-reattached-cancel"]
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("aborts publication before replacing local output when cancellation arrives during download", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const sandbox = fakeSandbox(result, undefined, "sandbox-publication-cancel");
    const controller = new AbortController();
    sandbox.filesystem.copyToLocal = vi.fn(async (_remote: string, local: string) => {
      fs.copyFileSync(result.archive, local);
      controller.abort();
    });
    try {
      await expect(
        createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [sandbox] }))).run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn(),
          signal: controller.signal
        })
      ).rejects.toThrow(/cancelled during publication/u);
      expect(fs.readFileSync(path.join(fixture.root, fixture.input.artifact_dir, "stale.txt"), "utf8")).toBe("stale\n");
      expect(fs.existsSync(path.join(fixture.root, fixture.input.artifact_dir, "finding.json"))).toBe(false);
      expect(sandbox.terminate).toHaveBeenCalledOnce();
      expect(readCloudAttemptEvidence(fixture.root, fixture.input)).toMatchObject({
        state: "cancelled",
        cleanup_state: "terminated"
      });
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("terminates a failed live sandbox before launching one controlled replacement", async () => {
    const fixture = createProjectFixture();
    const sandbox = fakeSandbox(undefined, undefined, "sandbox-crash-window");
    const createClient = fakeClient({ created: sandbox });
    const uploadFailure = new Error("provider connection unavailable during immutable upload");
    uploadFailure.name = "InternalFailure";
    sandbox.filesystem.copyFromLocal.mockRejectedValueOnce(uploadFailure);
    try {
      await expect(
        createModalNodeSandboxProvider(providerOptions(createClient)).run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/immutable upload/u);
      expect(createClient.sandboxes.create).toHaveBeenCalledTimes(2);
      expect(createClient.sandboxes.create).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          blockNetwork: true,
          tags: expect.objectContaining({ purpose: "ultrafuzz-node-volume-init" }),
          volumes: { "/data": expect.anything() }
        })
      );
      expect(createClient.sandboxes.create).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          volumes: {
            "/data": {
              subPath: modalNodeVolumeSubpath("controller-run", "node:attempt", "base")
            }
          }
        })
      );
      expect(sandbox.terminate).not.toHaveBeenCalled();
      expect(sandbox.detach).toHaveBeenCalledOnce();
      const attemptsRoot = path.join(fixture.root, fixture.input.run_root, "cloud-execution", "attempts");
      const evidencePath = path.join(attemptsRoot, fs.readdirSync(attemptsRoot)[0]!);
      const failedEvidence = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as {
        state: string;
        updated_at: string;
        transitions: Array<{ state: string; at: string }>;
      };
      failedEvidence.state = "failed";
      failedEvidence.updated_at = new Date().toISOString();
      failedEvidence.transitions.push({ state: "failed", at: failedEvidence.updated_at });
      fs.writeFileSync(evidencePath, `${JSON.stringify(failedEvidence)}\n`);

      const result = createResultArchive();
      const replacement = fakeSandbox(result, undefined, "sandbox-controlled-replacement");
      const inspector = fakeSandbox(undefined, undefined, "sandbox-failed-attempt-inspector");
      const resumedClient = fakeClient({ listed: [sandbox], created: [inspector, replacement] });
      try {
        await expect(
          createModalNodeSandboxProvider(providerOptions(resumedClient)).run({
            runId: "controller-run",
            sandboxId: "node:attempt",
            input: fixture.input,
            rootDir: fixture.root,
            heartbeat: vi.fn()
          })
        ).resolves.toMatchObject({ status: "finished", remoteRunId: "sandbox-controlled-replacement" });
        expect(sandbox.terminate).toHaveBeenCalledOnce();
        expect(sandbox.detach).toHaveBeenCalledTimes(2);
        expect(replacement.filesystem.copyFromLocal).toHaveBeenCalled();
        expect(readCloudAttemptEvidence(fixture.root, fixture.input)).toMatchObject({
          state: "succeeded",
          provider_execution_ids: ["sandbox-crash-window", "sandbox-controlled-replacement"],
          retry_index: 1
        });
      } finally {
        result.cleanup();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("reattaches to the deterministic winner when a concurrent controller wins sandbox creation", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const winner = fakeSandbox(result, undefined, "sandbox-concurrent-winner");
    const alreadyExists = new Error("sandbox name already exists");
    alreadyExists.name = "AlreadyExistsError";
    const client = fakeClient({ named: winner, createError: alreadyExists });
    try {
      await expect(
        createModalNodeSandboxProvider(providerOptions(client)).run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).resolves.toMatchObject({
        status: "finished",
        remoteRunId: "sandbox-concurrent-winner"
      });
      expect(client.sandboxes.fromName).toHaveBeenCalledWith(
        "ultrafuzz-test",
        modalNodeSandboxName("controller-run", "node:attempt", "base")
      );
      expect(readCloudAttemptEvidence(fixture.root, fixture.input)).toMatchObject({
        state: "succeeded",
        provider_execution_ids: ["sandbox-concurrent-winner"],
        resumed: true,
        cleanup_state: "terminated"
      });
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("reattaches to a deterministic volume initializer won by a concurrent controller", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const initializer = fakeSandbox(undefined, undefined, "sandbox-initializer-winner");
    initializer.poll.mockResolvedValue(0);
    const alreadyExists = new Error("initializer name already exists");
    alreadyExists.name = "AlreadyExistsError";
    const worker = fakeSandbox(result, undefined, "sandbox-after-initializer");
    const client = fakeClient({
      created: worker,
      named: initializer,
      initializerCreateError: alreadyExists
    });
    try {
      await expect(
        createModalNodeSandboxProvider(providerOptions(client)).run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).resolves.toMatchObject({ status: "finished", remoteRunId: "sandbox-after-initializer" });
      expect(client.sandboxes.fromName).toHaveBeenCalledWith("ultrafuzz-test", expect.stringMatching(/^ufz-init-/u));
      expect(initializer.wait).toHaveBeenCalled();
      expect(readCloudAttemptEvidence(fixture.root, fixture.input)).toMatchObject({
        state: "succeeded",
        provider_execution_ids: ["sandbox-after-initializer"]
      });
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("uses a uniquely named initializer when the SDK omits a finished concurrent winner", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const alreadyExists = new Error("initializer name already exists");
    alreadyExists.name = "AlreadyExistsError";
    const worker = fakeSandbox(result, undefined, "sandbox-after-finished-initializer");
    const client = fakeClient({
      created: worker,
      initializerCreateError: alreadyExists
    });
    try {
      await expect(
        createModalNodeSandboxProvider(providerOptions(client)).run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).resolves.toMatchObject({ status: "finished", remoteRunId: "sandbox-after-finished-initializer" });
      expect(client.sandboxes.fromName).toHaveBeenCalledWith("ultrafuzz-test", expect.stringMatching(/^ufz-init-/u));
      expect(client.sandboxes.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ name: expect.stringMatching(/^ufz-init-recover-/u) })
      );
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("serializes concurrent publication and lets only the publication winner terminate the shared VM", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const firstView = fakeSandbox(result, undefined, "sandbox-publication-winner");
    const secondView = fakeSandbox(result, undefined, "sandbox-publication-winner");
    try {
      const request = {
        runId: "controller-run",
        sandboxId: "node:attempt",
        input: fixture.input,
        rootDir: fixture.root,
        heartbeat: vi.fn()
      };
      const [first, second] = await Promise.all([
        createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [firstView] }))).run(request),
        createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [secondView] }))).run(request)
      ]);

      expect(first).toMatchObject({ status: "finished", remoteRunId: "sandbox-publication-winner" });
      expect(second).toMatchObject({ status: "finished", remoteRunId: "sandbox-publication-winner" });
      expect(firstView.terminate.mock.calls.length + secondView.terminate.mock.calls.length).toBe(1);
      expect(readCloudAttemptEvidence(fixture.root, fixture.input)).toMatchObject({
        state: "succeeded",
        provider_execution_ids: ["sandbox-publication-winner"],
        publication_artifact_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u)
      });
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("repairs an abandoned pre-publication handoff staging directory after controller loss", async () => {
    const fixture = createProjectFixture();
    const handoffIdentity = boundedTestIdentity(
      `controller-run:${fixture.input.task_id}:${fixture.input.attempt_id}:${fixture.input.execution_generation}`
    );
    const handoffParent = path.join(fixture.root, fixture.input.run_root, "cloud-execution", "handoffs");
    const abandoned = path.join(handoffParent, `.${handoffIdentity}.pending-crashed-controller`);
    fs.mkdirSync(abandoned, { recursive: true });
    fs.writeFileSync(path.join(abandoned, "project.tgz"), "partial");
    const result = createResultArchive();
    try {
      await expect(
        createModalNodeSandboxProvider(
          providerOptions(fakeClient({ created: fakeSandbox(result, undefined, "sandbox-after-crash") }))
        ).run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).resolves.toMatchObject({ status: "finished" });
      expect(fs.existsSync(abandoned)).toBe(false);
      expect(fs.existsSync(path.join(handoffParent, handoffIdentity, "manifest.json"))).toBe(true);
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects dependency mutation instead of silently reusing a stale immutable handoff", async () => {
    const fixture = createProjectFixture();
    const interrupted = fakeSandbox(undefined, undefined, "sandbox-original");
    interrupted.filesystem.readText = vi.fn(async () => {
      const error = new Error("provider connection unavailable");
      error.name = "InternalFailure";
      throw error;
    });
    const firstClient = fakeClient({ listed: [interrupted] });
    try {
      await expect(
        createModalNodeSandboxProvider(providerOptions(firstClient)).run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/provider connection unavailable/u);
      const before = readCloudAttemptEvidence(fixture.root, fixture.input);
      fs.writeFileSync(
        path.join(fixture.root, fixture.input.dependency_artifact_dirs[0]!, "declared.txt"),
        "mutated after first launch\n"
      );

      const secondClient = fakeClient({});
      await expect(
        createModalNodeSandboxProvider(providerOptions(secondClient)).run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/dependency evidence changed/u);
      expect(secondClient.sandboxes.create).not.toHaveBeenCalled();
      expect(readCloudAttemptEvidence(fixture.root, fixture.input)).toMatchObject({
        handoff_sha256: before.handoff_sha256,
        request_sha256: before.request_sha256,
        dependency_inputs: before.dependency_inputs
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a mutated durable request instead of rebinding an immutable handoff", async () => {
    const fixture = createProjectFixture();
    const interrupted = fakeSandbox(undefined, undefined, "sandbox-request-binding");
    const providerFailure = new Error("provider connection unavailable after launch");
    providerFailure.name = "InternalFailure";
    interrupted.filesystem.readText = vi.fn(async () => {
      throw providerFailure;
    });
    try {
      await expect(
        createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [interrupted] }))).run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/provider connection unavailable/u);
      const handoffRoot = path.join(fixture.root, fixture.input.run_root, "cloud-execution", "handoffs");
      const requestPath = path.join(
        handoffRoot,
        fs.readdirSync(handoffRoot).find((entry) => !entry.startsWith("."))!,
        "request.json"
      );
      fs.writeFileSync(requestPath, '{"mutated":true}\n');

      await expect(
        createModalNodeSandboxProvider(providerOptions(fakeClient({}))).run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/immutable cloud handoff is incomplete/u);
    } finally {
      fixture.cleanup();
    }
  });

  it("does not let a stale durable worker failure poison a successful replacement", async () => {
    const fixture = createProjectFixture();
    const failed = fakeSandbox(
      undefined,
      {
        schema_version: "ultrafuzz.modal.node-worker-error.v1",
        message: "first VM failed",
        exit_code: 9
      },
      "sandbox-failed"
    );
    try {
      await expect(
        createModalNodeSandboxProvider(providerOptions(fakeClient({ created: failed }))).run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/first VM failed/u);

      const inspector = fakeSandbox(undefined, undefined, "sandbox-inspector");
      const result = createResultArchive();
      const replacement = fakeSandbox(result, undefined, "sandbox-replacement");
      try {
        await expect(
          createModalNodeSandboxProvider(
            providerOptions(fakeClient({ listed: [failed], created: [inspector, replacement] }))
          ).run({
            runId: "controller-run",
            sandboxId: "node:attempt",
            input: fixture.input,
            rootDir: fixture.root,
            heartbeat: vi.fn()
          })
        ).resolves.toMatchObject({ status: "finished", remoteRunId: "sandbox-replacement" });
        expect(readCloudAttemptEvidence(fixture.root, fixture.input)).toMatchObject({
          state: "succeeded",
          provider_execution_ids: ["sandbox-failed", "sandbox-replacement"],
          retry_index: 1
        });
      } finally {
        result.cleanup();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("republishes a proven remote result when local successful artifacts were modified", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    try {
      await createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [fakeSandbox(result)] }))).run({
        runId: "controller-run",
        sandboxId: "node:attempt",
        input: fixture.input,
        rootDir: fixture.root,
        heartbeat: vi.fn()
      });
      fs.writeFileSync(path.join(fixture.root, fixture.input.artifact_dir, "finding.json"), '{"tampered":true}\n');
      const inspector = fakeSandbox(result, undefined, "sandbox-inspector");
      const recoveryClient = fakeClient({ created: inspector });

      await expect(
        createModalNodeSandboxProvider(providerOptions(recoveryClient)).run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).resolves.toMatchObject({ status: "finished" });
      expect(recoveryClient.sandboxes.create).toHaveBeenCalledOnce();
      expect(fs.readFileSync(path.join(fixture.root, fixture.input.artifact_dir, "finding.json"), "utf8")).toBe(
        '{"ok":true}\n'
      );
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("does not reuse successful evidence across a forked controller run namespace", async () => {
    const fixture = createProjectFixture();
    const originalResult = createResultArchive();
    const forkResult = createResultArchive("controller-fork");
    try {
      await createModalNodeSandboxProvider(
        providerOptions(fakeClient({ listed: [fakeSandbox(originalResult, undefined, "sandbox-original")] }))
      ).run({
        runId: "controller-run",
        sandboxId: "node:attempt",
        input: fixture.input,
        rootDir: fixture.root,
        heartbeat: vi.fn()
      });
      const originalEvidence = readCloudAttemptEvidence(fixture.root, fixture.input, "controller-run");
      fs.writeFileSync(
        path.join(fixture.root, fixture.input.dependency_artifact_dirs[0]!, "declared.txt"),
        "fork dependency state\n"
      );

      const forkSandbox = fakeSandbox(forkResult, undefined, "sandbox-fork");
      const forkClient = fakeClient({ created: forkSandbox });
      await expect(
        createModalNodeSandboxProvider(providerOptions(forkClient)).run({
          runId: "controller-fork",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).resolves.toMatchObject({ status: "finished", remoteRunId: "sandbox-fork" });

      expect(forkClient.sandboxes.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ tags: modalNodeTags("controller-fork", "node:attempt") })
      );
      expect(readCloudAttemptEvidence(fixture.root, fixture.input, "controller-run")).toMatchObject({
        controller_run_id: "controller-run",
        provider_execution_ids: ["sandbox-original"]
      });
      expect(readCloudAttemptEvidence(fixture.root, fixture.input, "controller-fork")).toMatchObject({
        controller_run_id: "controller-fork",
        provider_execution_ids: ["sandbox-fork"]
      });
      const forkEvidence = readCloudAttemptEvidence(fixture.root, fixture.input, "controller-fork");
      expect(forkEvidence.handoff_sha256).not.toBe(originalEvidence.handoff_sha256);
      expect(forkEvidence.dependency_inputs).not.toEqual(originalEvidence.dependency_inputs);
    } finally {
      originalResult.cleanup();
      forkResult.cleanup();
      fixture.cleanup();
    }
  });

  it("reconciles provider cleanup before reusing a proven local publication", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const sandbox = fakeSandbox(result, undefined, "sandbox-cleanup-retry");
    sandbox.terminate.mockRejectedValueOnce(new Error("provider cleanup unavailable"));
    try {
      await expect(
        createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [sandbox] }))).run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).resolves.toMatchObject({ status: "finished" });
      expect(readCloudAttemptEvidence(fixture.root, fixture.input)).toMatchObject({
        state: "succeeded",
        cleanup_state: "failed"
      });

      const cleanupClient = fakeClient({ listed: [sandbox] });
      await expect(
        createModalNodeSandboxProvider(providerOptions(cleanupClient)).run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).resolves.toMatchObject({
        status: "finished",
        output: { summary: "cloud attempt reused after provider cleanup reconciliation" }
      });
      expect(cleanupClient.sandboxes.create).not.toHaveBeenCalled();
      expect(cleanupClient.images.fromName).not.toHaveBeenCalled();
      expect(cleanupClient.volumes.fromName).not.toHaveBeenCalled();
      expect(sandbox.terminate).toHaveBeenCalledTimes(2);
      expect(readCloudAttemptEvidence(fixture.root, fixture.input)).toMatchObject({
        state: "succeeded",
        cleanup_state: "terminated",
        reused: true
      });
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("enforces configured cloud retention on provider access before reusing the controller namespace", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive();
    const sandbox = fakeSandbox(undefined, undefined, "sandbox-after-retention");
    const originalWriteText = sandbox.filesystem.writeText;
    sandbox.filesystem.writeText = vi.fn(async (value: string, remotePath: string) => {
      await originalWriteText(value, remotePath);
      sandbox.setResult(result);
    });
    const client = fakeClient({ created: sandbox });
    const policyPath = path.join(
      fixture.root,
      fixture.input.run_root,
      "cloud-execution",
      "retention",
      `${boundedTestIdentity("controller-run")}.json`
    );
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.writeFileSync(
      policyPath,
      `${JSON.stringify({
        schema_version: "ultrafuzz.modal.cloud-retention.v1",
        controller_run_id: "controller-run",
        retention_days: 7,
        updated_at: "2026-01-01T00:00:00.000Z",
        expires_at: "2026-01-08T00:00:00.000Z",
        enforcement: "provider-access"
      })}\n`
    );
    try {
      await expect(
        createModalNodeSandboxProvider({ ...providerOptions(client), retentionDays: 14 }).run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).resolves.toMatchObject({ status: "finished", remoteRunId: "sandbox-after-retention" });
      expect(client.volumes.delete).toHaveBeenCalledWith(modalNodeVolumeName("controller-run"));
      const renewed = JSON.parse(fs.readFileSync(policyPath, "utf8")) as {
        retention_days: number;
        expires_at: string;
      };
      expect(renewed.retention_days).toBe(14);
      expect(Date.parse(renewed.expires_at)).toBeGreaterThan(Date.now() + 13 * 24 * 60 * 60 * 1000);
    } finally {
      result.cleanup();
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

  it("deletes the exact run volume even when the provider app is already absent", async () => {
    const appMissing = new Error("app not found");
    appMissing.name = "NotFoundError";
    const client = fakeClient({ appError: appMissing });

    await expect(cleanupModalNodeRun(providerOptions(client), "controller-run", { force: true })).resolves.toEqual({
      terminated: 0,
      volumeDeleted: true
    });
    expect(client.apps.fromName).toHaveBeenCalledWith("ultrafuzz-test", { createIfMissing: false });
    expect(client.sandboxes.list).not.toHaveBeenCalled();
    expect(client.volumes.delete).toHaveBeenCalledWith(modalNodeVolumeName("controller-run"));
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

  it("forced cleanup terminates attempts, inspectors, and volume initializers before deleting storage", async () => {
    const attempt = fakeSandbox(undefined, undefined, "sandbox-attempt");
    const inspector = fakeSandbox(undefined, undefined, "sandbox-inspector");
    const initializer = fakeSandbox(undefined, undefined, "sandbox-initializer");
    const client = fakeClient({
      listedByPurpose: {
        "ultrafuzz-node": [attempt],
        "ultrafuzz-node-inspector": [inspector],
        "ultrafuzz-node-volume-init": [initializer]
      }
    });

    await expect(cleanupModalNodeRun(providerOptions(client), "controller-run", { force: true })).resolves.toEqual({
      terminated: 3,
      volumeDeleted: true
    });
    expect(attempt.terminate).toHaveBeenCalledOnce();
    expect(inspector.terminate).toHaveBeenCalledOnce();
    expect(initializer.terminate).toHaveBeenCalledOnce();
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

function boundedTestIdentity(value: string): string {
  const normalized =
    value
      .replace(/[^A-Za-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 32) || "run";
  return `${normalized}-${crypto.createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function initializeGitRepository(root: string, fileName: string, contents: string): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, fileName), contents);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Ultrafuzz Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@invalid"], { cwd: root });
  execFileSync("git", ["add", "--", fileName], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for test condition");
    await testDelay(20);
  }
}

function testDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createProjectFixture() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-provider-test-"));
  const root = path.join(temporaryRoot, "project");
  const runRoot = ".ultrafuzz/runs/run-one";
  const artifactDir = `${runRoot}/artifacts/attempt-one`;
  const dependencyArtifactDirs = [`${runRoot}/artifacts/dependency-one`, `${runRoot}/artifacts/dependency-two`];
  const workspaceDir = `${runRoot}/workspaces/attempt-one`;
  const workflowPath = `${runRoot}/smithers/workflow.tsx`;
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
  fs.writeFileSync(path.join(root, "source.txt"), "committed source\n");
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
  execFileSync("git", ["add", "source.txt"], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
  const input: ModalNodeSandboxInput = {
    schema_version: "ultrafuzz.modal.node.v1",
    run_id: "run-one",
    task_id: "node:attempt-one",
    attempt_id: "attempt-one",
    execution_generation: "base",
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

function createResultArchive(controllerRunId = "controller-run", sandboxId = "node:attempt") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-result-test-"));
  const bundle = path.join(root, "bundle");
  const archive = path.join(root, "result.tgz");
  fs.mkdirSync(path.join(bundle, "artifacts"), { recursive: true });
  fs.mkdirSync(path.join(bundle, "workspace"), { recursive: true });
  fs.writeFileSync(path.join(bundle, "artifacts", "finding.json"), '{"ok":true}\n');
  fs.writeFileSync(path.join(bundle, "workspace", "work.txt"), "remote workspace\n");
  execFileSync("tar", ["-czf", archive, "-C", bundle, "."]);
  const digest = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  const tags = modalNodeTags(controllerRunId, sandboxId);
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

function fakeSandbox(
  result: ReturnType<typeof createResultArchive> | undefined,
  failure?: Record<string, unknown>,
  sandboxId = "sandbox-one"
) {
  const remoteText = new Map<string, string>();
  let currentResult = result;
  return {
    sandboxId,
    setResult: (next: ReturnType<typeof createResultArchive>) => {
      currentResult = next;
    },
    poll: vi.fn(async () => (failure === undefined ? null : Number(failure.exit_code ?? 1))),
    wait: vi.fn(async () => (failure === undefined ? 0 : Number(failure.exit_code ?? 1))),
    terminate: vi.fn(async () => undefined),
    detach: vi.fn(),
    exec: vi.fn(),
    filesystem: {
      readText: vi.fn(async (remotePath: string) => {
        if (remotePath.endsWith("/result.json") && currentResult !== undefined) return currentResult.result;
        if (remotePath.endsWith("/error.json") && failure !== undefined) return JSON.stringify(failure);
        const value = remoteText.get(remotePath);
        if (value !== undefined) return value;
        throw new SandboxFilesystemNotFoundError("not found");
      }),
      writeText: vi.fn(async (value: string, remotePath: string) => {
        remoteText.set(remotePath, value);
      }),
      copyFromLocal: vi.fn(async (local: string, remotePath: string) => {
        if (remotePath.endsWith(".json")) remoteText.set(remotePath, fs.readFileSync(local, "utf8"));
      }),
      copyToLocal: vi.fn(async (_remote: string, local: string) => {
        if (currentResult === undefined) throw new Error("result is unavailable");
        fs.copyFileSync(currentResult.archive, local);
      })
    }
  } as unknown as Sandbox & {
    poll: ReturnType<typeof vi.fn>;
    wait: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
    setResult: (next: ReturnType<typeof createResultArchive>) => void;
    filesystem: {
      readText: ReturnType<typeof vi.fn>;
      writeText: ReturnType<typeof vi.fn>;
      copyFromLocal: ReturnType<typeof vi.fn>;
      copyToLocal: ReturnType<typeof vi.fn>;
    };
  };
}

function fakeClient(options: {
  listed?: Sandbox[];
  listedByPurpose?: Record<string, Sandbox[]>;
  fromIds?: Record<string, Sandbox>;
  created?: Sandbox | Sandbox[];
  named?: Sandbox;
  createError?: Error;
  initializerCreateError?: Error;
  appError?: Error;
}) {
  const listed = options.listed ?? [];
  const created = Array.isArray(options.created)
    ? [...options.created]
    : options.created === undefined
      ? []
      : [options.created];
  let initializerCreateError = options.initializerCreateError;
  return {
    apps: {
      fromName: vi.fn(async () => {
        if (options.appError !== undefined) throw options.appError;
        return { appId: "app-one" };
      })
    },
    images: {
      fromName: vi.fn(async () => ({}))
    },
    volumes: {
      fromName: vi.fn(async () => ({
        withMountOptions: vi.fn((mountOptions: Record<string, unknown>) => mountOptions)
      })),
      delete: vi.fn(async () => undefined)
    },
    secrets: {
      fromObject: vi.fn(async () => ({}))
    },
    sandboxes: {
      create: vi.fn(async (_app: unknown, _image: unknown, createOptions: Record<string, unknown>) => {
        const tags = createOptions.tags as Record<string, string> | undefined;
        if (tags?.purpose === "ultrafuzz-node-volume-init") {
          if (initializerCreateError !== undefined) {
            const error = initializerCreateError;
            initializerCreateError = undefined;
            throw error;
          }
          const initializer = fakeSandbox(undefined, undefined, "sandbox-volume-initializer");
          initializer.poll.mockResolvedValue(0);
          return initializer;
        }
        if (options.createError !== undefined) throw options.createError;
        return created.shift() ?? fakeSandbox(undefined);
      }),
      fromId: vi.fn(async (sandboxId: string) => {
        const sandbox = options.fromIds?.[sandboxId];
        if (sandbox !== undefined) return sandbox;
        const error = new Error("sandbox not found");
        error.name = "NotFoundError";
        throw error;
      }),
      fromName: vi.fn(async () => {
        if (options.named !== undefined) return options.named;
        const error = new Error("named sandbox not found");
        error.name = "NotFoundError";
        throw error;
      }),
      list: vi.fn(async function* (params: { tags: Record<string, string> }) {
        const purpose = params.tags.purpose;
        const matches =
          (purpose === undefined ? undefined : options.listedByPurpose?.[purpose]) ??
          (purpose === "ultrafuzz-node" ? listed : []);
        for (const sandbox of matches) yield sandbox;
      })
    },
    close: vi.fn()
  };
}
