import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SandboxFilesystemNotFoundError, type Sandbox } from "modal";
import {
  CLOUD_SELECTED_TASK_SCHEMA_VERSION,
  SMITHERS_TASK_MANIFEST_SCHEMA_VERSION,
  SMITHERS_TASK_METADATA_SCHEMA_VERSION,
  type CloudSelectedTask,
  type SmithersTaskManifestOutput,
  type SmithersTaskManifestTask
} from "@ultrafuzz/artifacts";
import { BUN_MODULE_CONFINEMENT_SOURCE } from "@ultrafuzz/runtime";
import { describe, expect, it, vi } from "vitest";

import {
  cleanupModalNodeRun,
  createModalNodeHandoffArchive,
  createModalNodeSandboxProvider,
  ModalNodeCleanupRefusedError,
  MODAL_NODE_LIFECYCLE_RESERVE_SECONDS,
  modalAttemptVerificationMarkerName,
  modalNodeLifecycleTimeoutMs,
  modalNodeLifecycleTimeoutSeconds,
  modalNodeDispatchFingerprint,
  modalNodeSandboxName,
  modalNodeTags,
  modalNodeVolumeName,
  parseModalNodeSandboxInput,
  parseModalNodeWorkerInput,
  readModalExecutionDependencyClosure,
  probeModalCommands,
  verifyModalExecutionSnapshotClosure,
  type ModalNodeSandboxInput
} from "../src/node-provider.js";
import {
  copyAttemptVerificationMarker,
  copySafeTree,
  copyVerifiedPublishedEvidenceTree,
  initializeDurableNodeWorkspace,
  runDurableWorkflow,
  workflowCommandArguments,
  workflowRetryTaskCommandArguments
} from "../src/node-worker.js";
import { extractSafeTarArchive } from "../src/safe-archive.js";
import { currentArtifactBinding, currentTaskOutputBinding } from "./current-artifact-fixtures.js";

const PROVIDER_ID_ENV = "ULTRAFUZZ_TEST_PROVIDER_ID";
const PROVIDER_SECRET_ENV = "ULTRAFUZZ_TEST_PROVIDER_SECRET";
const AGENT_ENV = "ULTRAFUZZ_TEST_AGENT_KEY";
const testBunExecutable = (): string => execFileSync("which", ["bun"], { encoding: "utf8" }).trim();

describe("Modal node sandbox provider", { timeout: 30_000 }, () => {
  it("probes required commands inside the configured image and tears down the transient sandbox", async () => {
    const sandbox = fakeSandbox(undefined);
    sandbox.exec = vi.fn(async () => ({
      stdout: {
        readText: vi.fn(async () =>
          JSON.stringify([
            { name: "covg-eval", available: false, path: null, version: null },
            { name: "recon", available: true, path: "/usr/local/bin/recon", version: "recon 1.2.3" }
          ])
        )
      },
      stderr: { readText: vi.fn(async () => "") },
      wait: vi.fn(async () => 0)
    })) as unknown as typeof sandbox.exec;
    const client = fakeClient({ created: sandbox });

    await expect(
      probeModalCommands(providerOptions(client), ["recon", "covg-eval"], { includeVersions: true })
    ).resolves.toEqual([
      { name: "covg-eval", available: false, path: null, version: null },
      { name: "recon", available: true, path: "/usr/local/bin/recon", version: "recon 1.2.3" }
    ]);
    expect(client.apps.fromName).toHaveBeenCalledWith("ultrafuzz-test", { createIfMissing: true });
    expect(client.sandboxes.create).toHaveBeenCalledOnce();
    expect(sandbox.exec).toHaveBeenCalledWith(
      expect.arrayContaining(["node", "--eval", JSON.stringify(["covg-eval", "recon"])]),
      { env: { ULTRAFUZZ_PROBE_VERSIONS: "1" } }
    );
    expect(sandbox.terminate).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("does not resolve image commands through cwd-dependent PATH entries", async () => {
    const sandbox = fakeSandbox(undefined);
    let probeSource = "";
    sandbox.exec = vi.fn(async (command: string[]) => {
      probeSource = command[2] ?? "";
      return {
        stdout: {
          readText: vi.fn(async () => JSON.stringify([{ name: "recon", available: false, path: null, version: null }]))
        },
        stderr: { readText: vi.fn(async () => "") },
        wait: vi.fn(async () => 0)
      };
    }) as unknown as typeof sandbox.exec;
    const client = fakeClient({ created: sandbox });
    await probeModalCommands(providerOptions(client), ["recon"]);

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-probe-path-"));
    try {
      const relativeBin = path.join(cwd, "bin");
      fs.mkdirSync(relativeBin);
      fs.writeFileSync(path.join(relativeBin, "recon"), "#!/bin/sh\n", { mode: 0o755 });
      const output = execFileSync(process.execPath, ["--eval", probeSource, JSON.stringify(["recon"])], {
        cwd,
        env: { PATH: `bin${path.delimiter}` },
        encoding: "utf8"
      });
      expect(JSON.parse(output)).toEqual([{ name: "recon", available: false, path: null, version: null }]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects unsafe command names before creating a cloud sandbox", async () => {
    const client = fakeClient({});
    await expect(probeModalCommands(providerOptions(client), ["../recon"])).rejects.toThrow(/bare executable names/u);
    expect(client.sandboxes.create).not.toHaveBeenCalled();
  });

  it("can opt out of first-use app creation for read-only callers", async () => {
    const sandbox = fakeSandbox(undefined);
    sandbox.exec = vi.fn(async () => ({
      stdout: {
        readText: vi.fn(async () =>
          JSON.stringify([{ name: "recon", available: true, path: "/bin/recon", version: null }])
        )
      },
      stderr: { readText: vi.fn(async () => "") },
      wait: vi.fn(async () => 0)
    })) as unknown as typeof sandbox.exec;
    const client = fakeClient({ created: sandbox });

    await probeModalCommands(providerOptions(client), ["recon"], { createAppIfMissing: false });

    expect(client.apps.fromName).toHaveBeenCalledWith("ultrafuzz-test", { createIfMissing: false });
  });

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

  it("adds one bounded cloud lifecycle reserve without changing the inner timeout", () => {
    const innerTimeoutSeconds = 1_800;
    const lifecycleTimeoutSeconds = modalNodeLifecycleTimeoutSeconds(innerTimeoutSeconds);

    expect(MODAL_NODE_LIFECYCLE_RESERVE_SECONDS).toBe(1_800);
    expect(lifecycleTimeoutSeconds).toBe(3_600);
    expect(modalNodeLifecycleTimeoutMs(innerTimeoutSeconds)).toBe(3_600_000);
    expect(lifecycleTimeoutSeconds - MODAL_NODE_LIFECYCLE_RESERVE_SECONDS).toBe(innerTimeoutSeconds);
    const lifecycleStartedAt = 1_000_000;
    const innerStartedAt = lifecycleStartedAt + MODAL_NODE_LIFECYCLE_RESERVE_SECONDS * 1000;
    const lifecycleDeadline = lifecycleStartedAt + modalNodeLifecycleTimeoutMs(innerTimeoutSeconds);
    expect(lifecycleDeadline - innerStartedAt).toBe(innerTimeoutSeconds * 1000);
    expect(modalNodeLifecycleTimeoutSeconds(84_600)).toBe(86_400);
    expect(() => modalNodeLifecycleTimeoutSeconds(0)).toThrow(/inner timeout/u);
    expect(() => modalNodeLifecycleTimeoutSeconds(84_601)).toThrow(/inner timeout/u);
  });

  it("rejects unsafe cloud attempt identifiers before marker paths are created", () => {
    const fixture = createProjectFixture();
    try {
      for (const attemptId of ["../attempt-one", "nested/attempt-one", ".attempt-one", "attempt one"]) {
        expect(() => parseModalNodeSandboxInput({ ...fixture.input, attempt_id: attemptId })).toThrow(
          /cloud node input is invalid/u
        );
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("requires the canonical execution snapshot root and rejects local descriptors in worker input", () => {
    const fixture = createProjectFixture();
    try {
      const { execution_snapshot_root: _canonical, ...withoutCanonical } = fixture.input;
      expect(() => parseModalNodeSandboxInput(withoutCanonical)).toThrow(/cloud node input is invalid/u);
      expect(() =>
        parseModalNodeWorkerInput({ ...fixture.input, execution_snapshot_source_root: "/proc/1/fd/1" })
      ).toThrow(/cloud node input is invalid/u);
    } finally {
      fixture.cleanup();
    }
  });

  it("creates an immutable handoff from committed source plus only declared dependency evidence", async () => {
    const fixture = createProjectFixture();
    fs.writeFileSync(path.join(fixture.root, "local-only-secret"), "must stay local\n");
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    try {
      const entries = execFileSync("tar", ["-tzf", archive.path], { encoding: "utf8" });
      expect(entries).toContain("./source.txt");
      expect(entries).toContain(`./${fixture.input.workflow_path}`);
      expect(entries).toContain(`./${fixture.input.prompt_path}`);
      for (const helper of ["index", "codex", "claude", "kimi", "deepseek", "openrouter", "environment", "toml"]) {
        expect(entries).toContain(`./${fixture.input.execution_snapshot_root}/.smithers/agents/${helper}.ts`);
      }
      expect(entries).toContain(`./${fixture.input.execution_snapshot_root}/dependencies/packages/000001/dist/cli.js`);
      expect(entries).toContain(`./${fixture.input.execution_snapshot_root}/dependencies/manifest.json`);
      expect(entries).not.toContain("./.smithers/agents/kimi.ts");
      expect(entries).not.toContain(`./${fixture.input.execution_snapshot_root}/node_modules/smthrs`);
      for (const dependency of fixture.input.dependency_artifact_dirs) {
        expect(entries).toContain(`./${dependency}/`);
        const marker = `./${fixture.input.run_root}/.ultrafuzz-verification/${path.basename(dependency)}.json`;
        expect(entries).toContain(marker);
      }
      expect(entries).not.toContain("local-only-secret");
      expect(entries).not.toContain("unrelated.txt");
      expect(entries).not.toContain(`./${fixture.input.run_root}/.ultrafuzz-verification/unrelated.json`);
      expect(entries).not.toContain("stale.txt");
      expect(entries).not.toContain(`./${fixture.input.run_root}/workspaces/`);
      expect(entries).not.toContain(`./${fixture.input.run_root}/logs/`);
      expect(entries).not.toContain("./.git/logs/");
      expect(entries).not.toContain("./.git/hooks/");
      expect(archive.sha256).toMatch(/^[0-9a-f]{64}$/u);
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("stages a catalog already authenticated by its reference closure exactly once", async () => {
    const fixture = createProjectFixture({
      referenceDependencyAttemptIds: ["dependency-one"],
      vulnerabilityDatabaseReferenceAttemptId: "dependency-one"
    });
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    const extracted = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-overlap-test-"));
    try {
      execFileSync("tar", ["-xzf", archive.path, "-C", extracted]);
      const catalogPath = fixture.input.vulnerability_database!.catalogPath;
      expect(fs.readFileSync(path.join(extracted, catalogPath))).toEqual(
        fs.readFileSync(path.join(fixture.root, catalogPath))
      );
    } finally {
      archive.cleanup();
      fs.rmSync(extracted, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  it("rejects a catalog overlap when the independently authenticated bytes differ", async () => {
    const fixture = createProjectFixture({
      referenceDependencyAttemptIds: ["dependency-one"],
      vulnerabilityDatabaseReferenceAttemptId: "dependency-one"
    });
    const catalogPath = path.join(fixture.root, fixture.input.vulnerability_database!.catalogPath);
    const originalWriteFileSync = fs.writeFileSync.bind(fs);
    let changed = false;
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation((filePath, data, options) => {
      originalWriteFileSync(filePath, data, options);
      if (!changed && path.resolve(String(filePath)) !== catalogPath && String(filePath).endsWith("declared.txt")) {
        changed = true;
        originalWriteFileSync(catalogPath, "changed after reference capture\n");
      }
    });
    try {
      await expect(createModalNodeHandoffArchive(fixture.root, fixture.input)).rejects.toThrow(
        /reference publication changed|authenticated dependency publication collides with different staged bytes/u
      );
    } finally {
      writeSpy.mockRestore();
      fixture.cleanup();
    }
  });

  it("stages the exact verified publication closure and excludes dependency directory extras", async () => {
    const fixture = createProjectFixture();
    const dependency = fixture.input.dependency_artifact_dirs[0]!;
    const dependencyRoot = path.join(fixture.root, dependency);
    const companionPath = "companions/nested.txt";
    const companionContents = "authenticated companion\n";
    fs.mkdirSync(path.join(dependencyRoot, "companions"), { recursive: true });
    fs.writeFileSync(path.join(dependencyRoot, companionPath), companionContents);
    fs.writeFileSync(path.join(dependencyRoot, "undeclared-secret.txt"), "must stay local\n");
    const markerPath = path.join(
      fixture.root,
      fixture.input.run_root,
      ".ultrafuzz-verification",
      `${path.basename(dependency)}.json`
    );
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as {
      publications: Array<{ path: string; sha256: string }>;
    };
    marker.publications.push({ path: companionPath, sha256: sha256Hex(companionContents) });
    const markerBytes = Buffer.from(`${JSON.stringify(marker)}\n`);
    fs.writeFileSync(markerPath, markerBytes);
    refreshDependencyVerificationAuthority(fixture, path.basename(dependency));

    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    const extracted = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-publications-test-"));
    try {
      execFileSync("tar", ["-xzf", archive.path, "-C", extracted]);
      expect(fs.readFileSync(path.join(extracted, dependency, "declared.txt"), "utf8")).toContain(dependency);
      expect(fs.readFileSync(path.join(extracted, dependency, companionPath), "utf8")).toBe(companionContents);
      expect(fs.existsSync(path.join(extracted, dependency, "undeclared-secret.txt"))).toBe(false);
      expect(
        fs.readFileSync(
          path.join(extracted, fixture.input.run_root, ".ultrafuzz-verification", `${path.basename(dependency)}.json`)
        )
      ).toEqual(markerBytes);
    } finally {
      archive.cleanup();
      fs.rmSync(extracted, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  it("stages each authenticated publication before reading the next one", async () => {
    const fixture = createProjectFixture();
    const dependency = fixture.input.dependency_artifact_dirs[0]!;
    const dependencyRoot = path.join(fixture.root, dependency);
    const publicationPaths = ["companions/a-first.bin", "companions/b-second.bin"];
    fs.mkdirSync(path.join(dependencyRoot, "companions"), { recursive: true });
    for (const [index, relativePath] of publicationPaths.entries()) {
      fs.writeFileSync(path.join(dependencyRoot, relativePath), Buffer.alloc(1024, index + 1));
    }
    const markerPath = path.join(
      fixture.root,
      fixture.input.run_root,
      ".ultrafuzz-verification",
      `${path.basename(dependency)}.json`
    );
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as {
      publications: Array<{ path: string; sha256: string }>;
    };
    for (const relativePath of publicationPaths) {
      marker.publications.push({
        path: relativePath,
        sha256: sha256Hex(fs.readFileSync(path.join(dependencyRoot, relativePath)))
      });
    }
    fs.writeFileSync(markerPath, `${JSON.stringify(marker)}\n`);
    refreshDependencyVerificationAuthority(fixture, path.basename(dependency));

    const events: string[] = [];
    const originalOpenSync = fs.openSync.bind(fs);
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation((filePath, flags, mode) => {
      const openedPath = String(filePath);
      const relativePath = publicationPaths.find((candidate) =>
        openedPath.endsWith(path.join("companions", path.basename(candidate)))
      );
      if (relativePath !== undefined) events.push(`read:${relativePath}`);
      return originalOpenSync(filePath, flags, mode);
    });
    const originalWriteFileSync = fs.writeFileSync.bind(fs);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation((filePath, data, options) => {
      originalWriteFileSync(filePath, data, options);
      const absolute = path.resolve(String(filePath));
      const relativePath = publicationPaths.find(
        (candidate) =>
          absolute !== path.join(dependencyRoot, candidate) && absolute.endsWith(path.join(dependency, candidate))
      );
      if (relativePath !== undefined) events.push(`stage:${relativePath}`);
    });
    let archive: Awaited<ReturnType<typeof createModalNodeHandoffArchive>> | undefined;
    try {
      archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
      expect(events).toEqual([
        `read:${publicationPaths[0]}`,
        `stage:${publicationPaths[0]}`,
        `read:${publicationPaths[1]}`,
        `stage:${publicationPaths[1]}`
      ]);
    } finally {
      writeSpy.mockRestore();
      openSpy.mockRestore();
      archive?.cleanup();
      fixture.cleanup();
    }
  });

  it("stages a sealed reference dependency only through its controller manifest closure", async () => {
    const fixture = createProjectFixture({ referenceDependencyAttemptIds: ["dependency-one"] });
    const reference = fixture.input.dependency_artifact_dirs[0]!;
    fs.writeFileSync(path.join(fixture.root, reference, "undeclared-secret.txt"), "must stay local\n");
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    try {
      const entries = execFileSync("tar", ["-tzf", archive.path], { encoding: "utf8" });
      expect(entries).toContain(`./${reference}/declared.txt`);
      expect(entries).toContain(`./${reference}/references/manifest.json`);
      expect(entries).toContain(`./${reference}/artifact-manifest.json`);
      expect(entries).not.toContain(`./${reference}/undeclared-secret.txt`);
      expect(entries).not.toContain(
        `./${fixture.input.run_root}/.ultrafuzz-verification/${path.basename(reference)}.json`
      );
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("binds a reference dependency outer manifest to its sealed byte authority", async () => {
    const fixture = createProjectFixture({ referenceDependencyAttemptIds: ["dependency-one"] });
    const referenceManifest = path.join(
      fixture.root,
      fixture.input.dependency_artifact_dirs[0]!,
      "artifact-manifest.json"
    );
    fs.appendFileSync(referenceManifest, " ");
    try {
      await expect(createModalNodeHandoffArchive(fixture.root, fixture.input)).rejects.toThrow(
        /reference artifact manifest does not match the sealed task authority/u
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("omits only markerless optional dependency roots from the handoff archive", async () => {
    const fixture = createProjectFixture({ optionalDependencyAttemptIds: ["dependency-one"] });
    const [markerlessOptional, requiredDependency] = fixture.input.dependency_artifact_dirs;
    const markerRoot = path.join(fixture.root, fixture.input.run_root, ".ultrafuzz-verification");
    fs.rmSync(path.join(markerRoot, `${path.basename(markerlessOptional!)}.json`));
    fixture.input.dependency_verification_authorities = fixture.input.dependency_verification_authorities.filter(
      (authority) => authority.attempt_id !== path.basename(markerlessOptional!)
    );

    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    try {
      const entries = execFileSync("tar", ["-tzf", archive.path], { encoding: "utf8" });
      expect(entries).not.toContain(`./${markerlessOptional}/`);
      expect(entries).not.toContain(`./${markerlessOptional}/declared.txt`);
      expect(entries).not.toContain(
        `./${fixture.input.run_root}/.ultrafuzz-verification/${path.basename(markerlessOptional!)}.json`
      );
      expect(entries).toContain(`./${requiredDependency}/`);
      expect(entries).toContain(`./${requiredDependency}/declared.txt`);
      expect(entries).toContain(
        `./${fixture.input.run_root}/.ultrafuzz-verification/${path.basename(requiredDependency!)}.json`
      );
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("fails closed when an optional dependency marker is present but invalid", async () => {
    const fixture = createProjectFixture({ optionalDependencyAttemptIds: ["dependency-one"] });
    const optionalDependency = fixture.input.dependency_artifact_dirs[0]!;
    fs.writeFileSync(
      path.join(
        fixture.root,
        fixture.input.run_root,
        ".ultrafuzz-verification",
        `${path.basename(optionalDependency)}.json`
      ),
      "{}\n"
    );
    refreshDependencyVerificationAuthority(fixture, path.basename(optionalDependency));
    try {
      await expect(createModalNodeHandoffArchive(fixture.root, fixture.input)).rejects.toThrow(
        /dependency verification marker is schema-invalid/u
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects optional dependency roots outside the declared dependency set", () => {
    const fixture = createProjectFixture();
    try {
      expect(() =>
        parseModalNodeSandboxInput({
          ...fixture.input,
          optional_dependency_artifact_dirs: [`${fixture.input.run_root}/artifacts/undeclared`]
        })
      ).toThrow(/cloud node input is invalid/u);
    } finally {
      fixture.cleanup();
    }
  });

  it("binds the cloud task identity and dependency sets to the sealed task declaration", async () => {
    const fixture = createProjectFixture();
    const [firstDependency] = fixture.input.dependency_artifact_dirs;
    try {
      await expect(
        createModalNodeHandoffArchive(fixture.root, {
          ...fixture.input,
          task_id: "node:dependency-one"
        })
      ).rejects.toThrow(/cloud node input is invalid/u);
      await expect(
        createModalNodeHandoffArchive(fixture.root, {
          ...fixture.input,
          dependency_artifact_dirs: fixture.input.dependency_artifact_dirs.slice(1)
        })
      ).rejects.toThrow(/cloud node input is invalid/u);
      await expect(
        createModalNodeHandoffArchive(fixture.root, {
          ...fixture.input,
          optional_dependency_artifact_dirs: [firstDependency!]
        })
      ).rejects.toThrow(/optional dependency artifact directories do not match the sealed task/u);
    } finally {
      fixture.cleanup();
    }
  });

  it("joins verifier marker authorities exactly to sealed agentic dependencies", async () => {
    const fixture = createProjectFixture();
    const [first, second] = fixture.input.dependency_verification_authorities;
    const alteredDigest = `${first!.marker_sha256[0] === "0" ? "1" : "0"}${first!.marker_sha256.slice(1)}`;
    const cases: Array<{ authorities: ModalNodeSandboxInput["dependency_verification_authorities"]; message: RegExp }> =
      [
        {
          authorities: [second!],
          message: /required cloud dependency has no verifier marker authority/u
        },
        {
          authorities: [
            ...fixture.input.dependency_verification_authorities,
            { ...first!, marker_sha256: alteredDigest }
          ],
          message: /cloud node input is invalid/u
        },
        {
          authorities: [
            ...fixture.input.dependency_verification_authorities,
            { attempt_id: "unrelated", marker_sha256: "a".repeat(64), size_bytes: 1 }
          ],
          message: /extra or unknown producer attempt/u
        },
        {
          authorities: [{ ...first!, marker_sha256: alteredDigest }, second!],
          message: /does not match verifier authority/u
        },
        {
          authorities: [{ ...first!, size_bytes: first!.size_bytes + 1 }, second!],
          message: /does not match verifier authority/u
        }
      ];
    try {
      for (const candidate of cases) {
        await expect(
          createModalNodeHandoffArchive(fixture.root, {
            ...fixture.input,
            dependency_verification_authorities: candidate.authorities
          })
        ).rejects.toThrow(candidate.message);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("requires optional marker presence to agree with its verifier authority", async () => {
    const fixture = createProjectFixture({ optionalDependencyAttemptIds: ["dependency-one"] });
    const optionalAttempt = "dependency-one";
    const withoutOptionalAuthority = fixture.input.dependency_verification_authorities.filter(
      (authority) => authority.attempt_id !== optionalAttempt
    );
    try {
      await expect(
        createModalNodeHandoffArchive(fixture.root, {
          ...fixture.input,
          dependency_verification_authorities: withoutOptionalAuthority
        })
      ).rejects.toThrow(/optional dependency marker appeared/u);
      fs.rmSync(path.join(fixture.root, fixture.input.run_root, ".ultrafuzz-verification", `${optionalAttempt}.json`));
      await expect(createModalNodeHandoffArchive(fixture.root, fixture.input)).rejects.toThrow(
        /dependency verification marker is unavailable/u
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("forbids verifier marker authority rows for sealed reference dependencies", async () => {
    const fixture = createProjectFixture({ referenceDependencyAttemptIds: ["dependency-one"] });
    try {
      await expect(
        createModalNodeHandoffArchive(fixture.root, {
          ...fixture.input,
          dependency_verification_authorities: [
            ...fixture.input.dependency_verification_authorities,
            { attempt_id: "dependency-one", marker_sha256: "a".repeat(64), size_bytes: 1 }
          ]
        })
      ).rejects.toThrow(/reference dependency must not have a verifier marker authority/u);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects credential, resource, and task-owned path substitution against the sealed task", async () => {
    const fixture = createProjectFixture();
    const cases: Array<{ input: ModalNodeSandboxInput; message: RegExp }> = [
      {
        input: { ...fixture.input, agent_credential_env: ["AWS_SESSION_TOKEN"] },
        message: /credential environment does not match the sealed task/u
      },
      {
        input: {
          ...fixture.input,
          resources: { ...fixture.input.resources, memory_mib: fixture.input.resources.memory_mib + 1 }
        },
        message: /resources do not match the sealed task/u
      },
      {
        input: { ...fixture.input, artifact_dir: fixture.input.dependency_artifact_dirs[0]! },
        message: /cloud node input is invalid/u
      },
      {
        input: { ...fixture.input, workspace_dir: fixture.input.dependency_artifact_dirs[0]! },
        message: /cloud node input is invalid/u
      },
      {
        input: { ...fixture.input, prompt_path: fixture.input.workflow_path },
        message: /cloud node input is invalid/u
      },
      {
        input: {
          ...fixture.input,
          workflow_path: `${fixture.input.execution_snapshot_root}/controls/ultrafuzz.toml`
        },
        message: /cloud node input is invalid/u
      }
    ];
    try {
      for (const candidate of cases) {
        await expect(createModalNodeHandoffArchive(fixture.root, candidate.input)).rejects.toThrow(candidate.message);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("binds operator instructions to sealed workflow input while allowing a recovery generation selector", async () => {
    const fixture = createProjectFixture({ operatorPrompt: "Prioritize authorization boundaries" });
    let archive: Awaited<ReturnType<typeof createModalNodeHandoffArchive>> | undefined;
    try {
      await expect(
        createModalNodeHandoffArchive(fixture.root, {
          ...fixture.input,
          operator_prompt: "Substituted instructions"
        })
      ).rejects.toThrow(/operator prompt does not match the sealed workflow input/u);
      archive = await createModalNodeHandoffArchive(fixture.root, {
        ...withFixtureExecutionGeneration(fixture.input, "reset-one")
      });
      expect(archive.sha256).toMatch(/^[0-9a-f]{64}$/u);
    } finally {
      archive?.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects tracked and untracked source changes recorded by cloud governance", async () => {
    for (const kind of ["tracked", "untracked"] as const) {
      const fixture = createProjectFixture({ governanceDirty: true });
      try {
        if (kind === "tracked") fs.writeFileSync(path.join(fixture.root, "source.txt"), "dirty tracked source\n");
        else fs.writeFileSync(path.join(fixture.root, "untracked-source.txt"), "dirty untracked source\n");

        await expect(createModalNodeHandoffArchive(fixture.root, fixture.input)).rejects.toThrow(
          "cloud handoff requires a clean governed Git source"
        );
      } finally {
        fixture.cleanup();
      }
    }
  });

  it("archives the recorded launch revision after the checkout branch moves", async () => {
    const fixture = createProjectFixture({ divergentSource: true });
    const sourceRevision = fixture.governedCommit;
    const sourceRef = "refs/ultrafuzz/runs/run-one/source";
    execFileSync("git", ["update-ref", sourceRef, sourceRevision], { cwd: fixture.root });
    fixture.input.source_revision = sourceRevision;
    fixture.input.source_ref = sourceRef;

    // Simulate a long run whose launch branch is reset before this cloud node
    // is materialized. The run-owned ref remains the archive authority.
    execFileSync("git", ["reset", "--quiet", "--hard", fixture.parentCommit], { cwd: fixture.root });
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    const extracted = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-recorded-source-"));
    try {
      await extractSafeTarArchive(archive.path, extracted, { gzip: true, label: "recorded source handoff test" });
      expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: extracted, encoding: "utf8" }).trim()).toBe(
        sourceRevision
      );
      expect(execFileSync("git", ["rev-parse", sourceRef], { cwd: extracted, encoding: "utf8" }).trim()).toBe(
        sourceRevision
      );
      expect(fs.readFileSync(path.join(extracted, "develop-only.txt"), "utf8")).toBe("develop\n");
    } finally {
      archive.cleanup();
      fs.rmSync(extracted, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  it("rejects a recorded source ref owned by a different run", async () => {
    const fixture = createProjectFixture();
    try {
      fixture.input.source_revision = fixture.governedCommit;
      fixture.input.source_ref = "refs/ultrafuzz/runs/run-foreign/source";
      await expect(createModalNodeHandoffArchive(fixture.root, fixture.input)).rejects.toThrow(
        /source ref does not belong/u
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("preserves committed paths matched by gitignore and still excludes untracked ignored files", async () => {
    for (const baseline of ["deterministic", "recorded"] as const) {
      const fixture = createProjectFixture({
        trackedIgnored: true,
        ...(baseline === "recorded" ? { recordedSource: true } : {})
      });
      let archive: Awaited<ReturnType<typeof createModalNodeHandoffArchive>> | undefined;
      const extracted = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-tracked-ignored-handoff-"));
      try {
        if (baseline === "recorded") {
          execFileSync("git", ["update-ref", fixture.input.source_ref!, fixture.governedCommit], {
            cwd: fixture.root
          });
        }
        const committedPaths = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
          cwd: fixture.root,
          encoding: "utf8"
        });
        expect(committedPaths).toContain("tracked-ignored.txt");

        archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
        await extractSafeTarArchive(archive.path, extracted, { gzip: true, label: "tracked ignored handoff test" });

        expect(fs.readFileSync(path.join(extracted, "tracked-ignored.txt"), "utf8")).toBe("committed but ignored\n");
        expect(
          execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: extracted, encoding: "utf8" })
        ).toBe(committedPaths);
        expect(execFileSync("git", ["status", "--porcelain=v1"], { cwd: extracted, encoding: "utf8" })).not.toContain(
          "tracked-ignored.txt"
        );
        expect(fs.existsSync(path.join(extracted, "untracked-ignored.txt"))).toBe(false);
      } finally {
        archive?.cleanup();
        fs.rmSync(extracted, { recursive: true, force: true });
        fixture.cleanup();
      }
    }
  });

  it("preserves pinned source identity and fails closed without its ref", async () => {
    const fixture = createProjectFixture({ pinnedSubmodules: true });
    const pinnedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.root,
      encoding: "utf8"
    }).trim();
    fixture.input.source_revision = pinnedCommit;
    fixture.input.source_ref = "refs/heads/ultrafuzz-pinned";
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    const extracted = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-pinned-handoff-"));
    try {
      await extractSafeTarArchive(archive.path, extracted, { gzip: true, label: "pinned handoff test" });
      expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: extracted, encoding: "utf8" }).trim()).toBe(
        pinnedCommit
      );
      expect(execFileSync("git", ["branch", "--show-current"], { cwd: extracted, encoding: "utf8" }).trim()).toBe(
        "ultrafuzz-pinned"
      );
      expect(execFileSync("git", ["rev-list", "--all", "--count"], { cwd: extracted, encoding: "utf8" }).trim()).toBe(
        "1"
      );
      expect(execFileSync("git", ["remote"], { cwd: extracted, encoding: "utf8" }).trim()).toBe("");
      expect(execFileSync("git", ["ls-files", "--stage"], { cwd: extracted, encoding: "utf8" })).toContain(
        "vendor/dependency"
      );
      const sealedRoot = path.join(extracted, fixture.input.execution_snapshot_root, "controls/pinned-submodules");
      expect(fs.readFileSync(path.join(sealedRoot, "tree/vendor/dependency/dependency.txt"), "utf8")).toBe(
        "dependency\n"
      );
      const manifest = JSON.parse(fs.readFileSync(path.join(sealedRoot, "manifest.json"), "utf8")) as {
        source_commit?: unknown;
      };
      expect(manifest.source_commit).toBe(pinnedCommit);
      execFileSync("git", ["branch", "-m", "moved-pin"], { cwd: fixture.root });
      await expect(createModalNodeHandoffArchive(fixture.root, fixture.input)).rejects.toThrow(/ultrafuzz-pinned/u);
    } finally {
      archive.cleanup();
      fs.rmSync(extracted, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  it("rejects a cloud handoff when HEAD has drifted from the pinned source", async () => {
    const fixture = createProjectFixture({ pinnedSubmodules: true });
    try {
      execFileSync("git", ["switch", "--quiet", "-c", "drifted"], { cwd: fixture.root });
      execFileSync("git", ["update-index", "--force-remove", "vendor/dependency"], { cwd: fixture.root });
      execFileSync("git", ["commit", "--quiet", "-m", "drift from pin"], { cwd: fixture.root });

      await expect(createModalNodeHandoffArchive(fixture.root, fixture.input)).rejects.toThrow(
        "pinned cloud source ref does not identify HEAD"
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("creates byte-identical handoffs for same-version controller restart", async () => {
    const fixture = createProjectFixture();
    const originalAuthorDate = process.env.GIT_AUTHOR_DATE;
    const originalCommitterDate = process.env.GIT_COMMITTER_DATE;
    let first: Awaited<ReturnType<typeof createModalNodeHandoffArchive>> | undefined;
    let second: Awaited<ReturnType<typeof createModalNodeHandoffArchive>> | undefined;
    try {
      process.env.GIT_AUTHOR_DATE = "2031-01-02T03:04:05Z";
      process.env.GIT_COMMITTER_DATE = "2031-01-02T03:04:05Z";
      first = await createModalNodeHandoffArchive(fixture.root, fixture.input);
      process.env.GIT_AUTHOR_DATE = "2042-06-07T08:09:10Z";
      process.env.GIT_COMMITTER_DATE = "2042-06-07T08:09:10Z";
      second = await createModalNodeHandoffArchive(fixture.root, fixture.input);

      expect(second.sha256).toBe(first.sha256);
      expect(fs.readFileSync(second.path)).toEqual(fs.readFileSync(first.path));
      const gzipHeader = fs.readFileSync(first.path).subarray(0, 10);
      expect([...gzipHeader.subarray(4, 8)]).toEqual([0, 0, 0, 0]);
      expect(gzipHeader[9]).toBe(0xff);

      const extracted = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-deterministic-handoff-"));
      try {
        await extractSafeTarArchive(first.path, extracted, { gzip: true, label: "deterministic handoff test" });
        expect(execFileSync("git", ["status", "--porcelain=v1"], { cwd: extracted, encoding: "utf8" })).not.toContain(
          "source.txt"
        );
        expect(fs.readFileSync(path.join(extracted, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
      } finally {
        fs.rmSync(extracted, { recursive: true, force: true });
      }
    } finally {
      if (originalAuthorDate === undefined) delete process.env.GIT_AUTHOR_DATE;
      else process.env.GIT_AUTHOR_DATE = originalAuthorDate;
      if (originalCommitterDate === undefined) delete process.env.GIT_COMMITTER_DATE;
      else process.env.GIT_COMMITTER_DATE = originalCommitterDate;
      first?.cleanup();
      second?.cleanup();
      fixture.cleanup();
    }
  }, 15_000);

  it("archives sealed workflow, prompt, and agent bytes after mutable project controls are replaced", async () => {
    const fixture = createProjectFixture();
    fs.writeFileSync(path.join(fixture.root, fixture.mutableWorkflowPath), "hostile mutable workflow\n");
    fs.writeFileSync(path.join(fixture.root, fixture.mutablePromptPath), "hostile mutable prompt\n");
    for (const helper of ["kimi", "deepseek", "openrouter", "environment"]) {
      fs.writeFileSync(path.join(fixture.root, ".smithers", "agents", `${helper}.ts`), `hostile ${helper}\n`);
    }
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    const extracted = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-sealed-handoff-"));
    try {
      await extractSafeTarArchive(archive.path, extracted, { gzip: true, label: "sealed handoff test" });
      expect(fs.readFileSync(path.join(extracted, fixture.input.workflow_path), "utf8")).toBe(
        "export default { sealed: true };\n"
      );
      expect(fs.readFileSync(path.join(extracted, fixture.input.prompt_path!), "utf8")).toBe(
        "sealed rendered prompt\n"
      );
      expect(
        fs.readFileSync(
          path.join(extracted, fixture.input.execution_snapshot_root, ".smithers", "agents", "deepseek.ts"),
          "utf8"
        )
      ).toBe("export const sealedDeepSeek = true;\n");
      expect(
        fs.readFileSync(
          path.join(extracted, fixture.input.execution_snapshot_root, ".smithers", "agents", "openrouter.ts"),
          "utf8"
        )
      ).toBe("export const sealedOpenRouter = true;\n");
      expect(
        fs.readFileSync(
          path.join(extracted, fixture.input.execution_snapshot_root, ".smithers", "agents", "environment.ts"),
          "utf8"
        )
      ).toBe("export const sealedEnvironment = true;\n");
      expect(fs.existsSync(path.join(extracted, ".smithers", "agents", "deepseek.ts"))).toBe(false);
    } finally {
      archive.cleanup();
      fs.rmSync(extracted, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  it("rejects snapshot file tampering against the control-seal closure", async () => {
    const fixture = createProjectFixture();
    const workflow = path.join(fixture.root, fixture.input.workflow_path);
    try {
      fs.chmodSync(workflow, 0o600);
      fs.writeFileSync(workflow, "hostile sealed-path replacement\n");
      fs.chmodSync(workflow, 0o400);
      await expect(createModalNodeHandoffArchive(fixture.root, fixture.input)).rejects.toThrow(
        /execution snapshot file is unsafe|execution snapshot file changed while copying/u
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a schema-invalid workflow control seal before building a cloud handoff", async () => {
    const fixture = createProjectFixture();
    try {
      replaceFixtureControlSeal(
        fixture,
        fs
          .readFileSync(path.join(fixture.root, fixture.input.run_root, "smithers", "control-integrity.json"), "utf8")
          .replace('"run_id":"run-one"', '"run_id":"run-one","legacy_files":{}')
      );

      await expect(createModalNodeHandoffArchive(fixture.root, fixture.input)).rejects.toThrow(
        /workflow control seal does not match .*additionalProperties/u
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects duplicate keys in the workflow control seal before building a cloud handoff", async () => {
    const fixture = createProjectFixture();
    try {
      replaceFixtureControlSeal(
        fixture,
        fs
          .readFileSync(path.join(fixture.root, fixture.input.run_root, "smithers", "control-integrity.json"), "utf8")
          .replace(
            '"schema_version":"ultrafuzz.workflow-control-integrity.v2"',
            '"schema_version":"ultrafuzz.workflow-control-integrity.v2","schema_version":"ultrafuzz.workflow-control-integrity.v2"'
          )
      );

      await expect(createModalNodeHandoffArchive(fixture.root, fixture.input)).rejects.toThrow(
        /duplicate property name/iu
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("retains committed controller-generation authority in refreshed cloud handoffs", async () => {
    const fixture = createProjectFixture();
    const authority = installControllerGenerationFixture(fixture, 2);
    const extracted = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-refreshed-controller-handoff-"));
    let archive: Awaited<ReturnType<typeof createModalNodeHandoffArchive>> | undefined;
    try {
      archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
      await extractSafeTarArchive(archive.path, extracted, { gzip: true, label: "refreshed controller handoff test" });

      expect(fs.readFileSync(path.join(extracted, fixture.input.workflow_path), "utf8")).toBe(
        "export default { refreshed: 2 };\n"
      );
      for (const relativePath of [
        `${fixture.input.run_root}/events.jsonl`,
        `${fixture.input.run_root}/smithers/controller-generation-journal.json`,
        ...authority.manifestPaths.map((manifestPath) => path.relative(fixture.root, manifestPath))
      ]) {
        expect(fs.existsSync(path.join(extracted, relativePath))).toBe(true);
      }
    } finally {
      archive?.cleanup();
      fs.rmSync(extracted, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  it("rejects uncommitted, unknown, mismatched, and tampered refreshed controller generations", () => {
    const fixture = createProjectFixture();
    const authority = installControllerGenerationFixture(fixture, 2);
    const journalPath = path.join(
      fixture.root,
      fixture.input.run_root,
      "smithers",
      "controller-generation-journal.json"
    );
    const manifestPath = path.join(
      fixture.root,
      fixture.input.run_root,
      "smithers",
      "controller-generations",
      `${authority.controllerGeneration}.json`
    );
    const ancestorManifestPath = authority.manifestPaths[0]!;
    const eventPath = path.join(fixture.root, fixture.input.run_root, "events.jsonl");
    const originalJournal = fs.readFileSync(journalPath);
    const originalManifest = fs.readFileSync(manifestPath);
    const originalAncestorManifest = fs.readFileSync(ancestorManifestPath);
    const originalEvents = fs.readFileSync(eventPath);
    const originalSnapshotRoot = fixture.input.execution_snapshot_root;
    const originalWorkflowPath = fixture.input.workflow_path;
    try {
      expect(() => verifyModalExecutionSnapshotClosure(fixture.root, fixture.input)).not.toThrow();

      const prepared = JSON.parse(originalJournal.toString("utf8")) as {
        entries: Array<Record<string, unknown>>;
      };
      const pending = prepared.entries.at(-1)!;
      Object.assign(pending, { phase: "prepared" });
      for (const key of ["committed_at", "event_id", "event_at"]) delete pending[key];
      fs.writeFileSync(journalPath, `${JSON.stringify(prepared, null, 2)}\n`);
      expect(() => verifyModalExecutionSnapshotClosure(fixture.root, fixture.input)).toThrow(
        /uncommitted journal transition/u
      );
      fs.writeFileSync(journalPath, originalJournal);

      fixture.input.workflow_path = `${fixture.input.execution_snapshot_root}/controls/bunfig.toml`;
      expect(() => verifyModalExecutionSnapshotClosure(fixture.root, fixture.input)).toThrow(
        /workflow path does not match its committed controller generation/u
      );
      fixture.input.workflow_path = originalWorkflowPath;

      const unknownGeneration = "f".repeat(64);
      const unknownSnapshotRoot = `${path.posix.dirname(originalSnapshotRoot)}/${unknownGeneration}`;
      fs.renameSync(path.join(fixture.root, originalSnapshotRoot), path.join(fixture.root, unknownSnapshotRoot));
      fixture.input.execution_snapshot_root = unknownSnapshotRoot;
      fixture.input.workflow_path = originalWorkflowPath.replace(originalSnapshotRoot, unknownSnapshotRoot);
      if (fixture.input.prompt_path !== undefined) {
        fixture.input.prompt_path = fixture.input.prompt_path.replace(originalSnapshotRoot, unknownSnapshotRoot);
      }
      expect(() => verifyModalExecutionSnapshotClosure(fixture.root, fixture.input)).toThrow(
        /not the committed journal head/u
      );
      fs.renameSync(path.join(fixture.root, unknownSnapshotRoot), path.join(fixture.root, originalSnapshotRoot));
      fixture.input.execution_snapshot_root = originalSnapshotRoot;
      fixture.input.workflow_path = originalWorkflowPath;
      if (fixture.input.prompt_path !== undefined) {
        fixture.input.prompt_path = fixture.input.prompt_path.replace(unknownSnapshotRoot, originalSnapshotRoot);
      }

      const tamperedAncestor = JSON.parse(originalAncestorManifest.toString("utf8")) as Record<string, unknown>;
      tamperedAncestor.controller_source_digest = "9".repeat(64);
      const tamperedAncestorBytes = Buffer.from(`${JSON.stringify(tamperedAncestor, null, 2)}\n`, "utf8");
      const tamperedAncestorSha256 = crypto.createHash("sha256").update(tamperedAncestorBytes).digest("hex");
      const tamperedJournal = JSON.parse(originalJournal.toString("utf8")) as {
        entries: Array<{ manifest_sha256: string }>;
      };
      const tamperedEvents = originalEvents
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as { payload: { manifest_sha256: string; semantic_fingerprint: string } });
      tamperedJournal.entries[0]!.manifest_sha256 = tamperedAncestorSha256;
      tamperedEvents[0]!.payload.manifest_sha256 = tamperedAncestorSha256;
      fs.writeFileSync(ancestorManifestPath, tamperedAncestorBytes);
      fs.writeFileSync(journalPath, `${JSON.stringify(tamperedJournal, null, 2)}\n`);
      fs.writeFileSync(eventPath, `${tamperedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
      expect(() => verifyModalExecutionSnapshotClosure(fixture.root, fixture.input)).toThrow(
        /controller generation manifest identity is invalid/u
      );
      fs.writeFileSync(ancestorManifestPath, originalAncestorManifest);
      fs.writeFileSync(journalPath, originalJournal);
      fs.writeFileSync(eventPath, originalEvents);

      const eventLines = originalEvents.toString("utf8").trimEnd().split("\n");
      fs.writeFileSync(eventPath, `${eventLines.slice(1).join("\n")}\n`);
      expect(() => verifyModalExecutionSnapshotClosure(fixture.root, fixture.input)).toThrow(
        /event does not authenticate its journal entry/u
      );
      fs.writeFileSync(eventPath, originalEvents);

      tamperedEvents[0]!.payload.semantic_fingerprint = "8".repeat(64);
      fs.writeFileSync(eventPath, `${tamperedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
      expect(() => verifyModalExecutionSnapshotClosure(fixture.root, fixture.input)).toThrow(
        /event does not authenticate its journal entry/u
      );
    } finally {
      if (fs.existsSync(ancestorManifestPath)) fs.writeFileSync(ancestorManifestPath, originalAncestorManifest);
      if (fs.existsSync(eventPath)) fs.writeFileSync(eventPath, originalEvents);
      if (fs.existsSync(manifestPath)) fs.writeFileSync(manifestPath, originalManifest);
      fixture.cleanup();
    }
  });

  it("rejects a retained snapshots-parent swap without archiving hostile replacement bytes", async () => {
    const fixture = createProjectFixture();
    const snapshotRoot = path.join(fixture.root, fixture.input.execution_snapshot_root);
    const snapshotsParent = path.dirname(snapshotRoot);
    const retainedParent = `${snapshotsParent}.retained`;
    try {
      const archivePromise = createModalNodeHandoffArchive(fixture.root, fixture.input);
      fs.renameSync(snapshotsParent, retainedParent);
      fs.mkdirSync(snapshotRoot, { recursive: true });
      fs.writeFileSync(path.join(snapshotRoot, "hostile-control.ts"), "hostile replacement bytes\n");
      await expect(archivePromise).rejects.toThrow(/execution snapshot root is unsafe|source does not match/u);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects an execution dependency directory swap between pathname check and descriptor open", async () => {
    const fixture = createProjectFixture();
    const snapshotRoot = path.join(fixture.root, fixture.input.execution_snapshot_root);
    const dependencyDirectory = path.join(snapshotRoot, "dependencies");
    const retainedDirectory = path.join(snapshotRoot, "dependencies-retained");
    const originalOpen = fs.openSync.bind(fs);
    let swapped = false;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation((filePath, flags, mode) => {
      if (!swapped && String(filePath).endsWith("/dependencies")) {
        swapped = true;
        fs.chmodSync(snapshotRoot, 0o700);
        fs.renameSync(dependencyDirectory, retainedDirectory);
        fs.mkdirSync(dependencyDirectory, { recursive: true });
        fs.writeFileSync(
          path.join(dependencyDirectory, "manifest.json"),
          '{"schema_version":"ultrafuzz.workflow-execution-dependencies.v1","hostile":true}\n'
        );
        fs.chmodSync(snapshotRoot, 0o500);
      }
      return originalOpen(filePath, flags, mode);
    });
    try {
      await expect(createModalNodeHandoffArchive(fixture.root, fixture.input)).rejects.toThrow(
        /snapshot directory changed while opening|execution snapshot root changed/u
      );
      expect(swapped).toBe(true);
    } finally {
      openSpy.mockRestore();
      fixture.cleanup();
    }
  });

  it("rejects duplicate keys in the execution dependency manifest", () => {
    const fixture = createProjectFixture();
    const manifest = path.join(fixture.root, fixture.input.execution_snapshot_root, "dependencies", "manifest.json");
    try {
      const contents = fs
        .readFileSync(manifest, "utf8")
        .replace(
          '"schema_version":"ultrafuzz.workflow-execution-dependencies.v1"',
          '"schema_version":"ultrafuzz.workflow-execution-dependencies.v1","schema_version":"ultrafuzz.workflow-execution-dependencies.v1"'
        );
      fs.chmodSync(manifest, 0o600);
      fs.writeFileSync(manifest, contents);
      fs.chmodSync(manifest, 0o400);

      expect(() =>
        readModalExecutionDependencyClosure(path.join(fixture.root, fixture.input.execution_snapshot_root))
      ).toThrow(/execution dependency manifest is invalid/u);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects unknown fields in the execution dependency manifest", () => {
    const fixture = createProjectFixture();
    const snapshotRoot = path.join(fixture.root, fixture.input.execution_snapshot_root);
    const manifest = path.join(snapshotRoot, "dependencies", "manifest.json");
    try {
      const contents = JSON.parse(fs.readFileSync(manifest, "utf8")) as Record<string, unknown>;
      contents.legacy_packages = [];
      fs.chmodSync(manifest, 0o600);
      fs.writeFileSync(manifest, `${JSON.stringify(contents)}\n`);
      fs.chmodSync(manifest, 0o400);

      expect(() => readModalExecutionDependencyClosure(snapshotRoot)).toThrow(
        /execution dependency manifest is invalid/u
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("includes the JSON schema bundle needed by rendered property prompts", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    try {
      const entries = execFileSync("tar", ["-tzf", archive.path], { encoding: "utf8" });
      expect(entries).toContain("./.ultrafuzz/schemas/property-lens.schema.json");
      expect(entries).toContain("./.ultrafuzz/schemas/properties.schema.json");
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects committed symlinks before building a cloud handoff archive", async () => {
    const fixture = createProjectFixture({ committedSymlink: true });
    try {
      await expect(createModalNodeHandoffArchive(fixture.root, fixture.input)).rejects.toThrow(
        /unsupported symlink entry/u
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects symlinked dependency verification marker directories in cloud handoff archives", async () => {
    const fixture = createProjectFixture();
    try {
      const markerRoot = path.join(fixture.root, fixture.input.run_root, ".ultrafuzz-verification");
      const realMarkerRoot = path.join(fixture.root, fixture.input.run_root, "real-markers");
      fs.rmSync(markerRoot, { recursive: true, force: true });
      fs.mkdirSync(realMarkerRoot);
      fs.symlinkSync(realMarkerRoot, markerRoot, "dir");

      await expect(createModalNodeHandoffArchive(fixture.root, fixture.input)).rejects.toThrow(
        /dependency verification marker is unavailable/u
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects symlinked dependency verification marker files in cloud handoff archives", async () => {
    const fixture = createProjectFixture();
    try {
      const markerRoot = path.join(fixture.root, fixture.input.run_root, ".ultrafuzz-verification");
      const marker = path.join(markerRoot, "dependency-one.json");
      fs.rmSync(marker, { force: true });
      fs.symlinkSync("dependency-two.json", marker);

      await expect(createModalNodeHandoffArchive(fixture.root, fixture.input)).rejects.toThrow(
        /dependency verification marker is unavailable/u
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a verified publication replaced by a symlink after descriptor open", async () => {
    const fixture = createProjectFixture();
    const publication = path.join(fixture.root, fixture.input.dependency_artifact_dirs[0]!, "declared.txt");
    const retained = `${publication}.retained`;
    const outside = path.join(fixture.root, "outside-secret.txt");
    fs.writeFileSync(outside, "must never cross the cloud boundary\n");
    const originalOpen = fs.openSync.bind(fs);
    let swapped = false;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation((filePath, flags, mode) => {
      const descriptor = originalOpen(filePath, flags, mode);
      if (!swapped && String(filePath).endsWith("/declared.txt")) {
        swapped = true;
        fs.renameSync(publication, retained);
        fs.symlinkSync(outside, publication);
      }
      return descriptor;
    });
    try {
      await expect(createModalNodeHandoffArchive(fixture.root, fixture.input)).rejects.toThrow(
        /verified dependency publication .* bounded singly linked regular file/u
      );
      expect(swapped).toBe(true);
      expect(fs.readFileSync(outside, "utf8")).toBe("must never cross the cloud boundary\n");
    } finally {
      openSpy.mockRestore();
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

  it("stages only marker-verified cloud artifact publications", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-worker-verified-publication-"));
    try {
      const source = path.join(root, "artifacts");
      const destination = path.join(root, "published");
      const marker = path.join(root, "attempt-one.json");
      const finding = path.join(source, "finding.json");
      const companion = path.join(source, "generated-tests", "Property.t.sol");
      fs.mkdirSync(path.dirname(companion), { recursive: true });
      fs.writeFileSync(finding, '{"ok":true}\n');
      fs.writeFileSync(companion, "contract Property {}\n");
      fs.writeFileSync(path.join(source, "workspace-mirror-extra.txt"), "unverified\n");
      fs.writeFileSync(
        marker,
        `${JSON.stringify({
          schema_version: "ultrafuzz.artifact-verification.v2",
          attempt_id: "attempt-one",
          node_id: "property-lens",
          artifacts: [
            {
              path: "finding.json",
              ...currentArtifactBinding("ultrafuzz/findings@2"),
              sha256: crypto.createHash("sha256").update(fs.readFileSync(finding)).digest("hex"),
              primary: true
            }
          ],
          publications: [
            {
              path: "finding.json",
              sha256: crypto.createHash("sha256").update(fs.readFileSync(finding)).digest("hex")
            },
            {
              path: "generated-tests/Property.t.sol",
              sha256: crypto.createHash("sha256").update(fs.readFileSync(companion)).digest("hex")
            }
          ]
        })}\n`
      );

      copyVerifiedPublishedEvidenceTree(source, destination, marker, "attempt-one");

      expect(fs.readFileSync(path.join(destination, "finding.json"), "utf8")).toBe('{"ok":true}\n');
      expect(fs.readFileSync(path.join(destination, "generated-tests", "Property.t.sol"), "utf8")).toBe(
        "contract Property {}\n"
      );
      expect(fs.existsSync(path.join(destination, "workspace-mirror-extra.txt"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not promote workspace-mirrored output into the canonical cloud artifact root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-worker-no-mirror-promotion-"));
    try {
      const canonical = path.join(root, "artifacts", "attempt-one");
      const mirror = path.join(root, "workspace", "artifacts", "attempt-one");
      const destination = path.join(root, "published");
      const marker = path.join(root, "attempt-one.json");
      const mirroredFinding = path.join(mirror, "finding.json");
      fs.mkdirSync(canonical, { recursive: true });
      fs.mkdirSync(mirror, { recursive: true });
      fs.writeFileSync(mirroredFinding, '{"workspace_only":true}\n');
      const mirroredBytes = fs.readFileSync(mirroredFinding);
      fs.writeFileSync(marker, verificationMarkerFixture(sha256Hex(mirroredBytes.toString("utf8"))));

      expect(() => copyVerifiedPublishedEvidenceTree(canonical, destination, marker, "attempt-one")).toThrow(
        /verified publication is unavailable/u
      );
      expect(fs.existsSync(path.join(canonical, "finding.json"))).toBe(false);
      expect(fs.existsSync(path.join(destination, "finding.json"))).toBe(false);
      expect(fs.readFileSync(mirroredFinding)).toEqual(mirroredBytes);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("stages the current cloud attempt verification marker for controller publication", () => {
    const fixture = createProjectFixture();
    const destination = path.join(path.dirname(fixture.root), "verification-staging");
    try {
      fs.writeFileSync(
        path.join(fixture.root, fixture.input.run_root, ".ultrafuzz-verification", "attempt-one.json"),
        verificationMarkerFixture(sha256Hex('{"ok":true}\n'))
      );
      copyAttemptVerificationMarker(fixture.root, fixture.input, destination);

      expect(JSON.parse(fs.readFileSync(path.join(destination, "attempt-one.json"), "utf8"))).toMatchObject({
        attempt_id: "attempt-one",
        node_id: "property-lens"
      });
      expect(fs.existsSync(path.join(destination, "dependency-one.json"))).toBe(false);
    } finally {
      fixture.cleanup();
      fs.rmSync(destination, { recursive: true, force: true });
    }
  });

  it("rejects unsafe cloud attempt verification markers before staging", () => {
    const fixture = createProjectFixture();
    const destination = path.join(path.dirname(fixture.root), "verification-staging");
    try {
      const markerRoot = path.join(fixture.root, fixture.input.run_root, ".ultrafuzz-verification");
      const marker = path.join(markerRoot, "attempt-one.json");
      fs.symlinkSync("dependency-one.json", marker);

      expect(() => copyAttemptVerificationMarker(fixture.root, fixture.input, destination)).toThrow(
        /verification marker is unsafe/u
      );
    } finally {
      fixture.cleanup();
      fs.rmSync(destination, { recursive: true, force: true });
    }
  });

  it("rejects unsafe cloud attempt ids before staging verification markers", () => {
    const fixture = createProjectFixture();
    const destination = path.join(path.dirname(fixture.root), "verification-staging");
    try {
      expect(() =>
        copyAttemptVerificationMarker(
          fixture.root,
          { run_root: fixture.input.run_root, attempt_id: "../attempt-one" },
          destination
        )
      ).toThrow(/cloud node attempt_id is invalid/u);
      expect(fs.existsSync(destination)).toBe(false);
    } finally {
      fixture.cleanup();
      fs.rmSync(destination, { recursive: true, force: true });
    }
  });

  it("resumes a persisted inner workflow before attempting a new cloud-node run", () => {
    const fixture = createProjectFixture();
    try {
      const resume = workflowCommandArguments(
        "/volume/workflow.tsx",
        "/volume/workspace",
        "inner-run",
        fixture.input,
        true
      );
      const fresh = workflowCommandArguments(
        "/volume/workflow.tsx",
        "/volume/workspace",
        "inner-run",
        fixture.input,
        false
      );
      expect(resume).toEqual(
        expect.arrayContaining(["up", "/volume/workflow.tsx", "--resume", "--force", "--run-id", "inner-run"])
      );
      expect(fresh).toEqual(expect.arrayContaining(["up", "/volume/workflow.tsx", "--run-id", "inner-run"]));
      expect(fresh).not.toContain("--resume");
      expect(
        workflowRetryTaskCommandArguments(
          "/volume/workflow.tsx",
          "inner-run",
          fixture.input.selected_task!.preparationId
        )
      ).toEqual([
        "retry-task",
        "/volume/workflow.tsx",
        "--run-id",
        "inner-run",
        "--node-id",
        fixture.input.selected_task!.preparationId,
        "--iteration",
        "0",
        "--force",
        "--accept-workflow-change",
        "--format",
        "json"
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("retries only the exhausted generated preparation task selected by the dispatch", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-inner-workflow-preparation-retry-test-"));
    const logPath = path.join(root, "commands.jsonl");
    const retryEnvironmentPath = path.join(root, "retry-environment.json");
    const fixture = createProjectFixture({
      smithersCli: `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "up" && args.includes("--resume")) process.exit(1);
if (args[0] === "why") {
  process.stdout.write(JSON.stringify({ data: { blockers: [{ kind: "retries-exhausted", nodeId: "prepare:attempt-one" }] } }));
}
if (args[0] === "retry-task") {
  fs.writeFileSync(${JSON.stringify(retryEnvironmentPath)}, JSON.stringify({
    persistedWorkflow: process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH ?? null
  }));
  const nodeId = args[args.indexOf("--node-id") + 1];
  if (nodeId !== "prepare:attempt-one") process.exit(1);
}
`
    });
    try {
      await runDurableWorkflow(fixture.root, "inner-run", fixture.input, testBunExecutable);
      const commands = fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(commands.map(([command]) => command)).toEqual(["up", "why", "retry-task"]);
      expect(commands[2]).toEqual(
        expect.arrayContaining([
          "--node-id",
          fixture.input.selected_task!.preparationId,
          "--iteration",
          "0",
          "--accept-workflow-change"
        ])
      );
      expect(commands[2]![1]).toMatch(new RegExp(`^/proc/${process.pid}/fd/[0-9]+/`, "u"));
      expect(JSON.parse(fs.readFileSync(retryEnvironmentPath, "utf8"))).toEqual({ persistedWorkflow: null });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  it("keeps an exhausted task outside the selected task family terminal", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-inner-workflow-unrelated-retry-test-"));
    const logPath = path.join(root, "commands.jsonl");
    const fixture = createProjectFixture({
      smithersCli: `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "up" && args.includes("--resume")) process.exit(1);
if (args[0] === "why") {
  process.stdout.write(JSON.stringify({ blockers: [{ kind: "retries-exhausted", nodeId: "prepare:another-attempt" }] }));
}
`
    });
    try {
      await expect(runDurableWorkflow(fixture.root, "inner-run", fixture.input, testBunExecutable)).rejects.toThrow(
        /cloud worker phase resume-workflow failed/u
      );
      const commands = fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(commands.map(([command]) => command)).toEqual(["up", "why"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  it("falls back to a fresh inner workflow only when no persisted run exists", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-inner-workflow-test-"));
    const logPath = path.join(root, "commands.jsonl");
    const environmentPath = path.join(root, "environment.json");
    const ambientMarker = path.join(root, "ambient-package-ran");
    const startupMarker = path.join(root, "ambient-startup-ran"),
      startupPreload = path.join(root, "ambient-startup.mjs");
    const fixture = createProjectFixture({
      smithersCli: `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
let ambientError; try { require("ultrafuzz-hostile-ambient"); } catch (error) { ambientError = String(error); }
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
fs.writeFileSync(${JSON.stringify(environmentPath)}, JSON.stringify({
  path: process.env.PATH,
  startup: process.execArgv.join("\\n"),
  artifacts: process.env.ULTRAFUZZ_ARTIFACTS_MODULE,
  runtime: process.env.ULTRAFUZZ_RUNTIME_MODULE,
  config: process.env.ULTRAFUZZ_CONFIG_PATH,
  confinement: process.env.ULTRAFUZZ_BUN_MODULE_CONFINEMENT,
  governance: process.env.ULTRAFUZZ_DATA_GOVERNANCE_PATH,
  workflow: process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH,
  injections: ["BUN_OPTIONS", "BUN_INSPECT_PRELOAD", "NODE_OPTIONS", "NODE_PATH"].map((name) => process.env[name] ?? null),
  ambientError
}));
if (args.includes("--resume")) { process.stderr.write("RUN_NOT_FOUND\\n"); process.exit(4); }
`
    });
    const shadowBin = path.join(root, "target-bin");
    fs.mkdirSync(shadowBin, { recursive: true });
    const shadowCli = path.join(shadowBin, "ultrafuzz");
    fs.writeFileSync(shadowCli, "#!/bin/sh\nexit 77\n", "utf8");
    fs.chmodSync(shadowCli, 0o500);
    fs.mkdirSync(path.join(fixture.root, "node_modules", "ultrafuzz-hostile-ambient"), { recursive: true });
    fs.writeFileSync(
      path.join(fixture.root, "node_modules", "ultrafuzz-hostile-ambient", "package.json"),
      '{"main":"index.js"}\n'
    );
    fs.writeFileSync(
      path.join(fixture.root, "node_modules", "ultrafuzz-hostile-ambient", "index.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(ambientMarker)}, "hostile");\n`
    );
    fs.writeFileSync(
      startupPreload,
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(startupMarker)}, "hostile");\n`
    );
    const injectionNames = ["BUN_OPTIONS", "BUN_INSPECT_PRELOAD", "NODE_OPTIONS", "NODE_PATH"] as const,
      previousInjections = Object.fromEntries(injectionNames.map((name) => [name, process.env[name]])),
      previousPath = process.env.PATH;
    process.env.PATH = [shadowBin, previousPath ?? ""].filter((entry) => entry.length > 0).join(path.delimiter);
    {
      process.env.BUN_OPTIONS = `--preload=${startupPreload}`;
      process.env.BUN_INSPECT_PRELOAD = startupPreload;
      process.env.NODE_OPTIONS = `--import=${startupPreload}`;
      process.env.NODE_PATH = path.dirname(startupPreload);
    }
    try {
      await runDurableWorkflow(fixture.root, "inner-run", fixture.input, testBunExecutable);
      const commands = fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(commands).toHaveLength(2);
      expect(commands[0]).toEqual(expect.arrayContaining(["--resume", "--force", "--run-id", "inner-run"]));
      expect(commands[1]).toEqual(expect.arrayContaining(["--run-id", "inner-run"]));
      expect(commands[1]).not.toContain("--resume");
      const environment = JSON.parse(fs.readFileSync(environmentPath, "utf8")) as Record<string, string>;
      const childPath = (environment.path ?? "").split(path.delimiter);
      expect(childPath[0]).toBe("/usr/local/bin");
      expect(childPath.indexOf(shadowBin)).toBeGreaterThan(0);
      const childVisibleRoot = `/proc/${process.pid}/fd/`;
      expect(environment.artifacts).toMatch(
        new RegExp(`^file://${childVisibleRoot}[0-9]+/modules/@ultrafuzz/artifacts/dist/index\\.js$`, "u")
      );
      expect(environment.runtime).toMatch(
        new RegExp(`^file://${childVisibleRoot}[0-9]+/modules/@ultrafuzz/runtime/dist/index\\.js$`, "u")
      );
      expect(environment.config).toMatch(new RegExp(`^${childVisibleRoot}[0-9]+/controls/ultrafuzz\\.toml$`, "u"));
      expect(environment.confinement).toMatch(
        new RegExp(`^${childVisibleRoot}[0-9]+/controls/bun-module-confinement\\.js$`, "u")
      );
      expect(environment.startup).toMatch(/--no-addons[\s\S]*--preload=.*bun-module-confinement\.js/u);
      expect(environment.startup).not.toMatch(/--tsconfig-override/u);
      expect(environment.ambientError).toMatch(/outside its sealed snapshot/u);
      expect((environment as unknown as { injections: unknown }).injections).toEqual([null, null, null, null]);
      expect(fs.existsSync(ambientMarker)).toBe(false);
      expect(fs.existsSync(startupMarker)).toBe(false);
      expect(environment.governance).toMatch(
        new RegExp(`^${childVisibleRoot}[0-9]+/controls/data-governance\\.json$`, "u")
      );
      expect(environment.workflow).toMatch(
        new RegExp(`^${childVisibleRoot}[0-9]+/\\.smithers/workflows/ultrafuzz-run-one\\.tsx$`, "u")
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      for (const name of injectionNames) {
        const value = previousInjections[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  it("keeps Smithers on descriptor-anchored controls and rejects a canonical generation swap", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-inner-workflow-swap-test-"));
    const observationPath = path.join(root, "observation.json");
    const fixture = createProjectFixture({
      smithersCli: `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const args = process.argv.slice(2);
const workflowPath = args[1];
const marker = "/.smithers/workflows/";
const markerIndex = workflowPath.indexOf(marker);
if (markerIndex < 1) throw new Error("workflow is not descriptor-rooted");
const snapshotAccessRoot = workflowPath.slice(0, markerIndex);
const canonicalSnapshotRoot = fs.realpathSync(snapshotAccessRoot);
const retainedSnapshotRoot = canonicalSnapshotRoot + ".retained";
fs.renameSync(canonicalSnapshotRoot, retainedSnapshotRoot);
fs.mkdirSync(canonicalSnapshotRoot, { recursive: true });
fs.writeFileSync(path.join(canonicalSnapshotRoot, "hostile-control.ts"), "hostile replacement bytes\\n");
fs.writeFileSync(${JSON.stringify(observationPath)}, JSON.stringify({
  workflow: fs.readFileSync(workflowPath, "utf8"),
  config: fs.readFileSync(process.env.ULTRAFUZZ_CONFIG_PATH, "utf8"),
  artifacts: fs.readFileSync(fileURLToPath(process.env.ULTRAFUZZ_ARTIFACTS_MODULE), "utf8"),
  runtime: fs.readFileSync(fileURLToPath(process.env.ULTRAFUZZ_RUNTIME_MODULE), "utf8"),
  workflowPath,
  canonicalSnapshotRoot
}));
`
    });
    const canonicalSnapshotRoot = path.join(fixture.root, fixture.input.execution_snapshot_root);
    try {
      await expect(runDurableWorkflow(fixture.root, "inner-run", fixture.input, testBunExecutable)).rejects.toThrow(
        /execution snapshot directory changed during descriptor ownership|descriptor does not match its canonical generation/u
      );
      const observation = JSON.parse(fs.readFileSync(observationPath, "utf8")) as Record<string, string>;
      expect(observation).toMatchObject({
        workflow: "export default { sealed: true };\n",
        config: '[models]\ndefault = "sealed"\n',
        artifacts: "export const sealedArtifacts = true;\n",
        runtime: "export const sealedRuntime = true;\n",
        canonicalSnapshotRoot
      });
      expect(observation.workflowPath).toMatch(
        new RegExp(`^/proc/${process.pid}/fd/[0-9]+/\\.smithers/workflows/ultrafuzz-run-one\\.tsx$`, "u")
      );
      expect(fs.readFileSync(path.join(canonicalSnapshotRoot, "hostile-control.ts"), "utf8")).toBe(
        "hostile replacement bytes\n"
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  it("keeps workspace mutations and failure checkpoints on durable storage for a replacement worker", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    const replacementArchive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    const replacementBytes = fs.readFileSync(replacementArchive.path);
    replacementBytes[4] = replacementBytes[4]! ^ 1;
    fs.writeFileSync(replacementArchive.path, replacementBytes);
    replacementArchive.sha256 = crypto.createHash("sha256").update(replacementBytes).digest("hex");
    const volumeRoot = path.join(path.dirname(fixture.root), "modal-volume", "attempt");
    fixture.input.project_archive_sha256 = archive.sha256;
    try {
      const first = await initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input);
      const smithersLink = path.join(
        first.projectRoot,
        fixture.input.execution_snapshot_root,
        "node_modules",
        "smthrs"
      );
      expect(fs.lstatSync(smithersLink).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(smithersLink)).toBe(
        path.join(first.projectRoot, fixture.input.execution_snapshot_root, "dependencies", "packages", "000001")
      );
      await first.recordCheckpoint("prepared");
      const generatedProperty = path.join(first.projectRoot, fixture.input.workspace_dir, "test", "Property.t.sol");
      fs.mkdirSync(path.dirname(generatedProperty), { recursive: true });
      fs.writeFileSync(generatedProperty, "contract Property {}\n");
      await first.recordCheckpoint("failed", new Error("campaign interrupted"));

      const replacementInput = { ...fixture.input, project_archive_sha256: replacementArchive.sha256 };
      const replacement = await initializeDurableNodeWorkspace(volumeRoot, replacementArchive.path, replacementInput);
      expect(
        fs.readFileSync(
          path.join(replacement.projectRoot, fixture.input.workspace_dir, "test", "Property.t.sol"),
          "utf8"
        )
      ).toBe("contract Property {}\n");
      const index = JSON.parse(fs.readFileSync(replacement.checkpointIndex, "utf8")) as {
        checkpoints: Array<{ checkpoint_id: string; stage: string; manifest: string }>;
      };
      expect(index.checkpoints).toEqual([
        expect.objectContaining({ checkpoint_id: "0001-prepared", stage: "prepared" }),
        expect.objectContaining({ checkpoint_id: "0002-failed", stage: "failed" })
      ]);
      const failureManifest = index.checkpoints[1]?.manifest;
      expect(failureManifest).toBe(path.join(volumeRoot, "checkpoints", "0002-failed.json"));
      expect(JSON.parse(fs.readFileSync(failureManifest!, "utf8"))).toMatchObject({
        stage: "failed",
        workspace_path: replacement.projectRoot,
        execution_snapshot_root: fixture.input.execution_snapshot_root,
        error: "campaign interrupted"
      });
      expect(fs.readFileSync(path.join(volumeRoot, "input", "project.tgz"))).toHaveLength(
        fs.readFileSync(archive.path).length
      );
      expect(replacement.input.project_archive_sha256).toBe(archive.sha256);
      expect(replacementArchive.sha256).not.toBe(archive.sha256);
    } finally {
      archive.cleanup();
      replacementArchive.cleanup();
      fixture.cleanup();
    }
  }, 15_000);

  it("seeds a reset generation from the prior generation's durable outputs", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    fixture.input.project_archive_sha256 = archive.sha256;
    const volumeParent = path.join(path.dirname(fixture.root), "modal-volume");
    const priorRoot = path.join(volumeParent, "attempt-base");
    const resetRoot = path.join(volumeParent, "attempt-reset");
    const secondResetRoot = path.join(volumeParent, "attempt-reset-again");
    const interruptedRoot = path.join(volumeParent, "attempt-interrupted");
    try {
      const prior = await initializeDurableNodeWorkspace(priorRoot, archive.path, fixture.input);
      const generatedProperty = path.join(prior.projectRoot, fixture.input.workspace_dir, "test", "Property.t.sol");
      fs.mkdirSync(path.dirname(generatedProperty), { recursive: true });
      fs.writeFileSync(generatedProperty, "contract Property {}\n");
      const finding = path.join(prior.projectRoot, fixture.input.artifact_dir, "finding.json");
      fs.writeFileSync(finding, '{"id":"prior"}\n');
      const priorLog = path.join(prior.projectRoot, fixture.input.run_root, "logs", "campaign.log");
      fs.mkdirSync(path.dirname(priorLog), { recursive: true });
      fs.writeFileSync(priorLog, "prior log\n");
      await prior.recordCheckpoint("failed", new Error("reset requested"));

      fs.mkdirSync(path.join(interruptedRoot, "input"), { recursive: true });
      fs.copyFileSync(archive.path, path.join(interruptedRoot, "input", "project.tgz"));
      const interruptedInput = withFixtureExecutionGeneration(fixture.input, "reset-interrupted");
      fs.writeFileSync(path.join(interruptedRoot, "input", "request.json"), `${JSON.stringify(interruptedInput)}\n`);
      const interrupted = await initializeDurableNodeWorkspace(interruptedRoot, archive.path, interruptedInput);
      expect(
        fs.existsSync(
          path.join(interrupted.projectRoot, ".ultrafuzz", "recovered", "attempt-base", "workspace", "test")
        )
      ).toBe(true);

      const resetInput = withFixtureExecutionGeneration(fixture.input, "reset-one");
      const reset = await initializeDurableNodeWorkspace(resetRoot, archive.path, resetInput);
      expect(fs.existsSync(path.join(reset.projectRoot, resetInput.workspace_dir))).toBe(false);
      expect(
        fs.readFileSync(
          path.join(
            reset.projectRoot,
            ".ultrafuzz",
            "recovered",
            "attempt-base",
            "workspace",
            "test",
            "Property.t.sol"
          ),
          "utf8"
        )
      ).toBe("contract Property {}\n");
      expect(fs.existsSync(path.join(reset.projectRoot, resetInput.artifact_dir, "finding.json"))).toBe(false);
      expect(
        fs.readFileSync(
          path.join(reset.projectRoot, ".ultrafuzz", "recovered", "attempt-base", "artifacts", "finding.json"),
          "utf8"
        )
      ).toBe('{"id":"prior"}\n');
      expect(
        fs.readFileSync(
          path.join(reset.projectRoot, ".ultrafuzz", "recovered", "attempt-base", "logs", "campaign.log"),
          "utf8"
        )
      ).toBe("prior log\n");
      const prepared = await reset.recordCheckpoint("prepared");
      expect(prepared.restored_from).toBe(priorRoot);

      const secondReset = await initializeDurableNodeWorkspace(
        secondResetRoot,
        archive.path,
        withFixtureExecutionGeneration(resetInput, "reset-two")
      );
      expect(
        fs.readFileSync(
          path.join(
            secondReset.projectRoot,
            ".ultrafuzz",
            "recovered",
            "attempt-reset",
            "previous-recovered",
            "attempt-base",
            "workspace",
            "test",
            "Property.t.sol"
          ),
          "utf8"
        )
      ).toBe("contract Property {}\n");
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  }, 15_000);

  it("continues a normalized task across authenticated controller generations", async () => {
    const fixture = createProjectFixture();
    const originalControllerPaths = {
      executionSnapshotRoot: fixture.input.execution_snapshot_root,
      workflowPath: fixture.input.workflow_path,
      promptPath: fixture.input.prompt_path
    };
    installControllerGenerationFixture(fixture);
    const baseArchive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    fixture.input.project_archive_sha256 = baseArchive.sha256;
    const volumeParent = path.join(path.dirname(fixture.root), "modal-volume", "controller-continuation");
    const priorRoot = path.join(volumeParent, "prior");
    const refreshedRoot = path.join(volumeParent, "refreshed");
    let refreshedArchive: Awaited<ReturnType<typeof createModalNodeHandoffArchive>> | undefined;
    try {
      const prior = await initializeDurableNodeWorkspace(priorRoot, baseArchive.path, fixture.input);
      const evidence = path.join(prior.projectRoot, fixture.input.workspace_dir, "continued.txt");
      fs.mkdirSync(path.dirname(evidence), { recursive: true });
      fs.writeFileSync(evidence, "authenticated continuation\n");
      await prior.recordCheckpoint("completed");

      const priorControllerSnapshot = path.join(fixture.root, fixture.input.execution_snapshot_root);
      makeFixtureTreeWritable(priorControllerSnapshot);
      fs.rmSync(priorControllerSnapshot, { recursive: true });
      fixture.input.execution_snapshot_root = originalControllerPaths.executionSnapshotRoot;
      fixture.input.workflow_path = originalControllerPaths.workflowPath;
      fixture.input.prompt_path = originalControllerPaths.promptPath;
      installControllerGenerationFixture(fixture, 2);
      const { project_archive_sha256: _baseDigest, ...refreshedFixtureInput } = fixture.input;
      const refreshedInput = withFixtureExecutionGeneration(refreshedFixtureInput, "reset-after-controller-refresh");
      refreshedArchive = await createModalNodeHandoffArchive(fixture.root, refreshedInput);
      refreshedInput.project_archive_sha256 = refreshedArchive.sha256;
      const refreshed = await initializeDurableNodeWorkspace(refreshedRoot, refreshedArchive.path, refreshedInput);

      expect(
        fs.readFileSync(
          path.join(refreshed.projectRoot, ".ultrafuzz", "recovered", "prior", "workspace", "continued.txt"),
          "utf8"
        )
      ).toBe("authenticated continuation\n");
      expect(JSON.parse(fs.readFileSync(path.join(refreshedRoot, "input", "restore.json"), "utf8"))).toEqual({
        schema_version: "ultrafuzz.modal.node-restore.v1",
        source_root: priorRoot
      });
      await expect(refreshed.recordCheckpoint("prepared")).resolves.toMatchObject({ restored_from: priorRoot });
    } finally {
      refreshedArchive?.cleanup();
      baseArchive.cleanup();
      fixture.cleanup();
    }
  }, 30_000);

  it("rejects controller-generation continuation when the prior target Git tree changed", async () => {
    const fixture = createProjectFixture();
    const originalControllerPaths = {
      executionSnapshotRoot: fixture.input.execution_snapshot_root,
      workflowPath: fixture.input.workflow_path,
      promptPath: fixture.input.prompt_path
    };
    installControllerGenerationFixture(fixture);
    const baseArchive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    fixture.input.project_archive_sha256 = baseArchive.sha256;
    const volumeParent = path.join(path.dirname(fixture.root), "modal-volume", "changed-target-continuation");
    const priorRoot = path.join(volumeParent, "prior");
    const refreshedRoot = path.join(volumeParent, "refreshed");
    let refreshedArchive: Awaited<ReturnType<typeof createModalNodeHandoffArchive>> | undefined;
    try {
      const prior = await initializeDurableNodeWorkspace(priorRoot, baseArchive.path, fixture.input);
      const evidence = path.join(prior.projectRoot, fixture.input.workspace_dir, "must-not-restore.txt");
      fs.mkdirSync(path.dirname(evidence), { recursive: true });
      fs.writeFileSync(evidence, "stale target evidence\n");
      await prior.recordCheckpoint("completed");
      fs.writeFileSync(path.join(prior.projectRoot, "changed-target.txt"), "changed target tree\n");
      execFileSync("git", ["add", "--", "changed-target.txt"], { cwd: prior.projectRoot });
      execFileSync(
        "git",
        ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "-m", "change target"],
        {
          cwd: prior.projectRoot,
          stdio: "ignore"
        }
      );

      const priorControllerSnapshot = path.join(fixture.root, fixture.input.execution_snapshot_root);
      makeFixtureTreeWritable(priorControllerSnapshot);
      fs.rmSync(priorControllerSnapshot, { recursive: true });
      fixture.input.execution_snapshot_root = originalControllerPaths.executionSnapshotRoot;
      fixture.input.workflow_path = originalControllerPaths.workflowPath;
      fixture.input.prompt_path = originalControllerPaths.promptPath;
      installControllerGenerationFixture(fixture, 2);
      const { project_archive_sha256: _baseDigest, ...refreshedFixtureInput } = fixture.input;
      const refreshedInput = withFixtureExecutionGeneration(refreshedFixtureInput, "reset-with-changed-target");
      refreshedArchive = await createModalNodeHandoffArchive(fixture.root, refreshedInput);
      refreshedInput.project_archive_sha256 = refreshedArchive.sha256;
      await expect(
        initializeDurableNodeWorkspace(refreshedRoot, refreshedArchive.path, refreshedInput)
      ).rejects.toThrow(/target Git tree does not match sealed governance/u);
      expect(fs.existsSync(path.join(refreshedRoot, "input", "restore.json"))).toBe(false);
    } finally {
      refreshedArchive?.cleanup();
      baseArchive.cleanup();
      fixture.cleanup();
    }
  }, 30_000);

  it("recognizes a completed checkpoint so publication retries skip the inner workflow", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    fixture.input.project_archive_sha256 = archive.sha256;
    const volumeRoot = path.join(path.dirname(fixture.root), "modal-volume", "completed");
    try {
      const first = await initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input);
      await first.recordCheckpoint("completed");
      const retry = await initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input);
      expect(retry.hasCompletedCheckpoint).toBe(true);
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects a partial durable handoff without overwriting malformed present request bytes", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    fixture.input.project_archive_sha256 = archive.sha256;
    const volumeRoot = path.join(path.dirname(fixture.root), "modal-volume", "partial-handoff");
    const requestPath = path.join(volumeRoot, "input", "request.json");
    fs.mkdirSync(path.dirname(requestPath), { recursive: true });
    const malformed = '{"schema_version":"ultrafuzz.modal.node.v2",\n';
    fs.writeFileSync(requestPath, malformed);
    try {
      await expect(initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input)).rejects.toThrow(
        /durable cloud handoff archive is missing/u
      );
      expect(fs.readFileSync(requestPath, "utf8")).toBe(malformed);
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("commits an exact complete durable handoff publishing transaction after restart", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    fixture.input.project_archive_sha256 = archive.sha256;
    const volumeRoot = path.join(path.dirname(fixture.root), "modal-volume", "publishing-handoff");
    const publishing = path.join(volumeRoot, ".input.publishing");
    fs.mkdirSync(publishing, { recursive: true });
    fs.copyFileSync(archive.path, path.join(publishing, "project.tgz"));
    fs.writeFileSync(path.join(publishing, "request.json"), `${JSON.stringify(fixture.input)}\n`);
    try {
      await expect(initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input)).resolves.toBeDefined();
      expect(fs.existsSync(publishing)).toBe(false);
      expect(fs.readFileSync(path.join(volumeRoot, "input", "project.tgz"))).toEqual(fs.readFileSync(archive.path));
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("appends a checkpoint after reloading a frozen durable index", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    fixture.input.project_archive_sha256 = archive.sha256;
    const volumeRoot = path.join(path.dirname(fixture.root), "modal-volume", "append-after-restart");
    try {
      const first = await initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input);
      await first.recordCheckpoint("prepared");
      const restarted = await initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input);
      await expect(restarted.recordCheckpoint("running")).resolves.toMatchObject({
        checkpoint_id: "0002-running",
        sequence: 2,
        stage: "running"
      });
      expect(JSON.parse(fs.readFileSync(restarted.checkpointIndex, "utf8"))).toMatchObject({
        checkpoints: [
          { checkpoint_id: "0001-prepared", sequence: 1, stage: "prepared" },
          { checkpoint_id: "0002-running", sequence: 2, stage: "running" }
        ]
      });
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects an invalid present restore marker instead of rerunning restoration", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    fixture.input.project_archive_sha256 = archive.sha256;
    const volumeRoot = path.join(path.dirname(fixture.root), "modal-volume", "invalid-restore-marker");
    const inputRoot = path.join(volumeRoot, "input");
    try {
      await initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input);
      fs.writeFileSync(
        path.join(inputRoot, "restore.json"),
        '{"schema_version":"ultrafuzz.modal.node-restore.v1","source_root":"/data/a","source_root":"/data/b"}\n'
      );
      await expect(initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input)).rejects.toThrow(
        /durable restore marker is invalid/u
      );
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects checkpoint manifests when their required index is missing", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    fixture.input.project_archive_sha256 = archive.sha256;
    const volumeRoot = path.join(path.dirname(fixture.root), "modal-volume", "missing-checkpoint-index");
    try {
      const first = await initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input);
      await first.recordCheckpoint("prepared");
      fs.rmSync(first.checkpointIndex);
      await expect(initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input)).rejects.toThrow(
        /checkpoint index is missing for existing checkpoint manifests/u
      );
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects a checkpoint index whose referenced manifest is missing", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    fixture.input.project_archive_sha256 = archive.sha256;
    const volumeRoot = path.join(path.dirname(fixture.root), "modal-volume", "missing-checkpoint-manifest");
    try {
      const first = await initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input);
      const checkpoint = await first.recordCheckpoint("prepared");
      fs.rmSync(path.join(volumeRoot, "checkpoints", `${checkpoint.checkpoint_id}.json`));
      await expect(initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input)).rejects.toThrow(
        /durable checkpoint manifest is invalid/u
      );
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  }, 15_000);

  it("rejects unindexed checkpoint manifests instead of hiding an interrupted append", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    fixture.input.project_archive_sha256 = archive.sha256;
    const volumeRoot = path.join(path.dirname(fixture.root), "modal-volume", "orphan-checkpoint-manifest");
    try {
      const first = await initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input);
      const checkpoint = await first.recordCheckpoint("prepared");
      fs.copyFileSync(
        path.join(volumeRoot, "checkpoints", `${checkpoint.checkpoint_id}.json`),
        path.join(volumeRoot, "checkpoints", "9999-completed.json")
      );
      await expect(initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input)).rejects.toThrow(
        /checkpoint manifests do not match the checkpoint index/u
      );
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("does not overwrite an invalid present checkpoint index during append", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    fixture.input.project_archive_sha256 = archive.sha256;
    const volumeRoot = path.join(path.dirname(fixture.root), "modal-volume", "invalid-index-before-append");
    try {
      const workspace = await initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input);
      const invalid = '{"schema_version":"ultrafuzz.modal.node-checkpoint-index.v1",\n';
      fs.writeFileSync(workspace.checkpointIndex, invalid);
      await expect(workspace.recordCheckpoint("prepared")).rejects.toThrow(
        /checkpoint index changed to invalid present bytes/u
      );
      expect(fs.readFileSync(workspace.checkpointIndex, "utf8")).toBe(invalid);
      expect(fs.existsSync(path.join(volumeRoot, "checkpoints", "0001-prepared.json"))).toBe(false);
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects a schema-valid restore marker that does not identify a compatible prior generation", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    fixture.input.project_archive_sha256 = archive.sha256;
    const volumeRoot = path.join(path.dirname(fixture.root), "modal-volume", "unbound-restore-marker");
    try {
      await initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input);
      fs.writeFileSync(
        path.join(volumeRoot, "input", "restore.json"),
        `${JSON.stringify({ schema_version: "ultrafuzz.modal.node-restore.v1", source_root: volumeRoot })}\n`
      );
      await expect(initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input)).rejects.toThrow(
        /durable restore marker is invalid/u
      );
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("skips missing sibling requests but rejects invalid present sibling request bytes", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    fixture.input.project_archive_sha256 = archive.sha256;
    const volumeParent = path.join(path.dirname(fixture.root), "modal-volume", "sibling-requests");
    const missingRoot = path.join(volumeParent, "missing");
    const firstRoot = path.join(volumeParent, "first");
    const invalidRoot = path.join(volumeParent, "invalid");
    const secondRoot = path.join(volumeParent, "second");
    fs.mkdirSync(missingRoot, { recursive: true });
    try {
      await expect(
        initializeDurableNodeWorkspace(
          firstRoot,
          archive.path,
          withFixtureExecutionGeneration(fixture.input, "reset-one")
        )
      ).resolves.toBeDefined();

      fs.mkdirSync(path.join(invalidRoot, "input"), { recursive: true });
      fs.writeFileSync(path.join(invalidRoot, "input", "request.json"), '{"schema_version":\n');
      await expect(
        initializeDurableNodeWorkspace(
          secondRoot,
          archive.path,
          withFixtureExecutionGeneration(fixture.input, "reset-two")
        )
      ).rejects.toThrow(/prior generation cloud handoff request is invalid/u);
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects a malformed checkpoint index on a matching prior generation", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    fixture.input.project_archive_sha256 = archive.sha256;
    const volumeParent = path.join(path.dirname(fixture.root), "modal-volume", "invalid-prior-index");
    const priorRoot = path.join(volumeParent, "prior");
    const resetRoot = path.join(volumeParent, "reset");
    try {
      const prior = await initializeDurableNodeWorkspace(priorRoot, archive.path, fixture.input);
      const evidence = path.join(prior.projectRoot, fixture.input.workspace_dir, "evidence.txt");
      fs.mkdirSync(path.dirname(evidence), { recursive: true });
      fs.writeFileSync(evidence, "recoverable\n");
      await prior.recordCheckpoint("failed", new Error("reset"));
      fs.writeFileSync(prior.checkpointIndex, '{"schema_version":"ultrafuzz.modal.node-checkpoint-index.v1",\n');

      await expect(
        initializeDurableNodeWorkspace(
          resetRoot,
          archive.path,
          withFixtureExecutionGeneration(fixture.input, "reset-one")
        )
      ).rejects.toThrow(/durable checkpoint index is invalid/u);
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("binds durable recovery to the canonical execution snapshot", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    fixture.input.project_archive_sha256 = archive.sha256;
    const volumeRoot = path.join(path.dirname(fixture.root), "modal-volume", "snapshot-identity");
    try {
      await initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input);
      await expect(
        initializeDurableNodeWorkspace(volumeRoot, archive.path, {
          ...fixture.input,
          execution_snapshot_root: `${fixture.input.run_root}/smithers/execution-snapshots/${"f".repeat(64)}`
        })
      ).rejects.toThrow(/durable workspace request does not match/u);
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("binds durable recovery to the exact dependency verifier authorities", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    fixture.input.project_archive_sha256 = archive.sha256;
    const volumeRoot = path.join(path.dirname(fixture.root), "modal-volume", "dependency-verifier-authority");
    const [first, ...rest] = fixture.input.dependency_verification_authorities;
    const alteredDigest = `${first!.marker_sha256[0] === "0" ? "1" : "0"}${first!.marker_sha256.slice(1)}`;
    try {
      await initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input);
      await expect(
        initializeDurableNodeWorkspace(volumeRoot, archive.path, {
          ...fixture.input,
          dependency_verification_authorities: [{ ...first!, marker_sha256: alteredDigest }, ...rest]
        })
      ).rejects.toThrow(/durable workspace request does not match/u);
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects a sealed module mutated between durable worker attempts", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    fixture.input.project_archive_sha256 = archive.sha256;
    const volumeRoot = path.join(path.dirname(fixture.root), "modal-volume", "snapshot-tamper");
    try {
      const first = await initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input);
      const snapshotRoot = path.join(first.projectRoot, fixture.input.execution_snapshot_root);
      const runtimeModule = path.join(snapshotRoot, "modules", "@ultrafuzz", "runtime", "dist", "index.js");
      expect(fs.statSync(snapshotRoot).mode & 0o222).toBe(0);
      expect(fs.statSync(runtimeModule).mode & 0o222).toBe(0);
      fs.chmodSync(runtimeModule, 0o600);
      fs.writeFileSync(runtimeModule, "export const hostileRuntime = true;\n");
      await expect(initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input)).rejects.toThrow(
        /cloud execution snapshot file is unsealed/u
      );
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("does not chmod outside the snapshot when a seal directory is swapped", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    fixture.input.project_archive_sha256 = archive.sha256;
    const volumeRoot = path.join(path.dirname(fixture.root), "modal-volume", "seal-swap");
    const outside = path.join(path.dirname(fixture.root), "outside-seal-target");
    fs.mkdirSync(outside, { mode: 0o700 });
    const outsideFile = path.join(outside, "must-stay-writable.txt");
    fs.writeFileSync(outsideFile, "outside\n", { mode: 0o600 });
    const originalOpen = fs.openSync.bind(fs);
    let swapped = false;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation((filePath, flags, mode) => {
      if (!swapped && String(filePath).endsWith("/modules")) {
        swapped = true;
        fs.renameSync(filePath, `${String(filePath)}-retained`);
        fs.symlinkSync(outside, filePath, "dir");
      }
      return originalOpen(filePath, flags, mode);
    });
    try {
      await expect(initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input)).rejects.toThrow();
      expect(swapped).toBe(true);
      expect(fs.statSync(outside).mode & 0o777).toBe(0o700);
      expect(fs.statSync(outsideFile).mode & 0o777).toBe(0o600);
    } finally {
      openSpy.mockRestore();
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("does not create dependency links outside a swapped snapshot parent", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    fixture.input.project_archive_sha256 = archive.sha256;
    const volumeRoot = path.join(path.dirname(fixture.root), "modal-volume", "link-swap");
    const outside = path.join(path.dirname(fixture.root), "outside-link-target");
    fs.mkdirSync(outside, { mode: 0o700 });
    const originalOpen = fs.openSync.bind(fs);
    let swapped = false;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation((filePath, flags, mode) => {
      if (!swapped && String(filePath).endsWith("/node_modules")) {
        swapped = true;
        fs.renameSync(filePath, `${String(filePath)}-retained`);
        fs.symlinkSync(outside, filePath, "dir");
      }
      return originalOpen(filePath, flags, mode);
    });
    try {
      await expect(initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input)).rejects.toThrow();
      expect(swapped).toBe(true);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      openSpy.mockRestore();
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("reattaches to one live attempt and atomically publishes its durable result", async () => {
    const fixture = createProjectFixture();
    const firstControllerArchive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    const result = createResultArchive(fixture.input, {
      preserveProjectArchiveSha256: true,
      projectArchiveSha256: firstControllerArchive.sha256
    });
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
      expect(
        fs.readFileSync(
          path.join(fixture.root, fixture.input.run_root, "source-proofs", "attempt-one.invariant.json"),
          "utf8"
        )
      ).toBe("durable source proof\n");
      expect(
        fs.readFileSync(path.join(fixture.root, fixture.input.run_root, "source-proofs", "attempt-one.json"), "utf8")
      ).toBe("pinned source proof\n");
      expect(fs.existsSync(path.join(fixture.root, fixture.input.artifact_dir, "stale.txt"))).toBe(false);
      expect(fs.readFileSync(path.join(fixture.root, fixture.input.workspace_dir, "work.txt"), "utf8")).toBe(
        "remote workspace\n"
      );
      expect(
        fs.readFileSync(
          path.join(fixture.root, fixture.input.run_root, ".ultrafuzz-verification", "attempt-one.json"),
          "utf8"
        )
      ).toBe(verificationMarkerFixture(sha256Hex('{"ok":true}\n')));
    } finally {
      firstControllerArchive.cleanup();
      result.cleanup();
      fixture.cleanup();
    }
  }, 30_000);

  it("relocates cloud workspace Git control metadata before local verifier use", async () => {
    const fixture = createProjectFixture({ recordedSource: true });
    const workspace = path.join(fixture.root, fixture.input.workspace_dir);
    const sourceRevision = fixture.input.source_revision!;
    const sourceTree = execFileSync("git", ["rev-parse", `${sourceRevision}^{tree}`], {
      cwd: fixture.root,
      encoding: "utf8"
    }).trim();
    execFileSync("git", ["update-ref", fixture.input.source_ref!, sourceRevision], { cwd: fixture.root });
    fs.rmSync(workspace, { recursive: true, force: true });
    execFileSync("git", ["worktree", "add", "--quiet", "--detach", fixture.input.workspace_dir, sourceRevision], {
      cwd: fixture.root
    });
    fs.writeFileSync(path.join(fixture.root, "source.txt"), "controller advanced\n");
    execFileSync("git", ["add", "source.txt"], { cwd: fixture.root });
    execFileSync("git", ["commit", "--quiet", "-m", "advance controller checkout"], { cwd: fixture.root });
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.root, encoding: "utf8" }).trim()).not.toBe(
      sourceRevision
    );
    const result = createResultArchive(fixture.input, {
      workspaceGitControlFile: "gitdir: /__modal/volumes/vo-synthetic/external/workspace/.git/worktrees/attempt-one\n"
    });
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [fakeSandbox(result)] })));
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
      expect(fs.readFileSync(path.join(workspace, "work.txt"), "utf8")).toBe("remote workspace\n");
      const git = (cwd: string, args: readonly string[]): string =>
        execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
      expect(fs.realpathSync(git(workspace, ["rev-parse", "--show-toplevel"]))).toBe(fs.realpathSync(workspace));
      expect(git(workspace, ["rev-parse", "HEAD"])).toBe(sourceRevision);
      expect(git(workspace, ["rev-parse", "HEAD^{tree}"])).toBe(sourceTree);
      const controlFile = fs.readFileSync(path.join(workspace, ".git"), "utf8");
      expect(controlFile).not.toContain("/__modal/volumes/");
      expect(controlFile).toBe(
        `gitdir: ${path.join(fs.realpathSync(fixture.root), ".git", "worktrees", "attempt-one")}\n`
      );
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("provisions controller Git metadata for an unregistered cloud workspace", async () => {
    const fixture = createProjectFixture({ recordedSource: true });
    const workspace = path.join(fixture.root, fixture.input.workspace_dir);
    const sourceRevision = fixture.input.source_revision!;
    const sourceTree = execFileSync("git", ["rev-parse", `${sourceRevision}^{tree}`], {
      cwd: fixture.root,
      encoding: "utf8"
    }).trim();
    execFileSync("git", ["update-ref", fixture.input.source_ref!, sourceRevision], { cwd: fixture.root });
    const worktreesRoot = path.join(fixture.root, ".git", "worktrees");
    expect(fs.existsSync(worktreesRoot)).toBe(false);
    expect(fs.existsSync(path.join(workspace, ".git"))).toBe(false);
    fs.writeFileSync(path.join(fixture.root, "source.txt"), "controller advanced\n");
    execFileSync("git", ["add", "source.txt"], { cwd: fixture.root });
    execFileSync("git", ["commit", "--quiet", "-m", "advance controller checkout"], { cwd: fixture.root });
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.root, encoding: "utf8" }).trim()).not.toBe(
      sourceRevision
    );
    const result = createResultArchive(fixture.input, {
      workspaceGitControlFile: "gitdir: /__modal/volumes/vo-synthetic/external/workspace/.git/worktrees/attempt-one\n"
    });
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [fakeSandbox(result)] })));
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
      const git = (cwd: string, args: readonly string[]): string =>
        execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
      expect(fs.realpathSync(git(workspace, ["rev-parse", "--show-toplevel"]))).toBe(fs.realpathSync(workspace));
      expect(git(workspace, ["rev-parse", "HEAD"])).toBe(sourceRevision);
      expect(git(workspace, ["rev-parse", "HEAD^{tree}"])).toBe(sourceTree);
      expect(fs.readFileSync(path.join(workspace, "work.txt"), "utf8")).toBe("remote workspace\n");

      const registrations = fs
        .readdirSync(worktreesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory());
      expect(registrations).toHaveLength(1);
      const administration = path.join(worktreesRoot, registrations[0]!.name);
      expect(fs.readFileSync(path.join(workspace, ".git"), "utf8")).toBe(`gitdir: ${administration}\n`);
      const backpointer = fs.readFileSync(path.join(administration, "gitdir"), "utf8").trim();
      expect(fs.realpathSync(path.dirname(backpointer))).toBe(fs.realpathSync(workspace));
      expect(path.basename(backpointer)).toBe(".git");
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("recovers a published result before starting a replacement worker", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive(fixture.input);
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
      expect(client.sandboxes.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          command: ["sleep", String(60 + MODAL_NODE_LIFECYCLE_RESERVE_SECONDS)],
          timeoutMs: (60 + MODAL_NODE_LIFECYCLE_RESERVE_SECONDS) * 1000
        })
      );
      expect(fixture.input.resources.timeout_seconds).toBe(60);
      expect(sandbox.exec).not.toHaveBeenCalled();
      expect(sandbox.filesystem.copyFromLocal).not.toHaveBeenCalled();
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("opens the canonical sealed snapshot after an admission descriptor closes and uploads no descriptor", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive(fixture.input);
    const sandbox = fakeSandbox(result);
    const snapshotDescriptor = fs.openSync(
      path.join(fixture.root, fixture.input.execution_snapshot_root),
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0)
    );
    fs.closeSync(snapshotDescriptor);
    let resultVisible = false;
    let uploadedRequest: Record<string, unknown> | undefined;
    const readPublished = sandbox.filesystem.readText;
    sandbox.filesystem.readText = vi.fn(async (remote: string) => {
      if (!resultVisible) throw new SandboxFilesystemNotFoundError("not found");
      return readPublished(remote);
    });
    sandbox.filesystem.copyFromLocal = vi.fn(async (local: string, remote: string) => {
      if (remote.endsWith("request.json")) {
        uploadedRequest = JSON.parse(fs.readFileSync(local, "utf8")) as Record<string, unknown>;
      }
    });
    sandbox.exec = vi.fn(async () => {
      resultVisible = true;
      return {
        stdout: { readText: vi.fn(async () => "") },
        stderr: { readBytes: vi.fn(async () => new Uint8Array()) },
        wait: vi.fn(async () => 0)
      };
    }) as never;
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ created: sandbox })));
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
      expect(uploadedRequest).toMatchObject({ execution_snapshot_root: fixture.input.execution_snapshot_root });
      expect(uploadedRequest).not.toHaveProperty("execution_snapshot_source_root");
      expect(() => parseModalNodeWorkerInput(uploadedRequest)).not.toThrow();
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects v2 cloud results that omit the attempt verification marker", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive(fixture.input, { includeVerificationMarker: false });
    const sandbox = fakeSandbox(result);
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [sandbox] })));
    try {
      const artifactFinding = path.join(fixture.root, fixture.input.artifact_dir, "finding.json");
      const workspaceWork = path.join(fixture.root, fixture.input.workspace_dir, "work.txt");
      const sourceProofRoot = path.join(fixture.root, fixture.input.run_root, "source-proofs");
      fs.writeFileSync(artifactFinding, "existing artifact\n");
      fs.writeFileSync(workspaceWork, "existing workspace\n");
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/missing artifact verification marker/u);
      expect(fs.readFileSync(artifactFinding, "utf8")).toBe("existing artifact\n");
      expect(fs.existsSync(path.join(fixture.root, fixture.input.artifact_dir, "stale.txt"))).toBe(true);
      expect(fs.readFileSync(workspaceWork, "utf8")).toBe("existing workspace\n");
      expect(fs.existsSync(path.join(sourceProofRoot, "attempt-one.json"))).toBe(false);
      expect(fs.existsSync(path.join(sourceProofRoot, "attempt-one.invariant.json"))).toBe(false);
      expect(
        fs.existsSync(path.join(fixture.root, fixture.input.run_root, ".ultrafuzz-verification", "attempt-one.json"))
      ).toBe(false);
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("republishes over a verification marker refreshed to match a sanitized artifact", async () => {
    const fixture = createProjectFixture();
    const remoteMarker = verificationMarkerFixture(sha256Hex('{"ok":true}\n'));
    const result = createResultArchive(fixture.input, { verificationMarker: remoteMarker });
    const sandbox = fakeSandbox(result);
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [sandbox] })));
    try {
      const artifactFinding = path.join(fixture.root, fixture.input.artifact_dir, "finding.json");
      const verificationMarker = path.join(
        fixture.root,
        fixture.input.run_root,
        ".ultrafuzz-verification",
        "attempt-one.json"
      );
      const sanitized = '{"ok":true,"reference_expectations":[]}\n';
      fs.writeFileSync(artifactFinding, sanitized);
      fs.writeFileSync(verificationMarker, verificationMarkerFixture(sha256Hex(sanitized)));

      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).resolves.toMatchObject({ status: "finished" });
      expect(fs.readFileSync(artifactFinding, "utf8")).toBe('{"ok":true}\n');
      expect(fs.readFileSync(verificationMarker, "utf8")).toBe(remoteMarker);
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects verification markers whose refreshed digest matches no published artifact", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive(fixture.input, {
      verificationMarker: verificationMarkerFixture(sha256Hex('{"ok":true}\n'))
    });
    const sandbox = fakeSandbox(result);
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [sandbox] })));
    try {
      const artifactFinding = path.join(fixture.root, fixture.input.artifact_dir, "finding.json");
      const verificationMarker = path.join(
        fixture.root,
        fixture.input.run_root,
        ".ultrafuzz-verification",
        "attempt-one.json"
      );
      fs.writeFileSync(artifactFinding, '{"ok":true,"reference_expectations":[]}\n');
      fs.writeFileSync(verificationMarker, verificationMarkerFixture(sha256Hex("bytes nothing on disk has\n")));

      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/would replace an immutable publication file/u);
      expect(fs.readFileSync(artifactFinding, "utf8")).toBe('{"ok":true,"reference_expectations":[]}\n');
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects verification markers that differ outside the recorded artifact digests", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive(fixture.input, {
      verificationMarker: verificationMarkerFixture(sha256Hex('{"ok":true}\n'))
    });
    const sandbox = fakeSandbox(result);
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [sandbox] })));
    try {
      const artifactFinding = path.join(fixture.root, fixture.input.artifact_dir, "finding.json");
      const verificationMarker = path.join(
        fixture.root,
        fixture.input.run_root,
        ".ultrafuzz-verification",
        "attempt-one.json"
      );
      const sanitized = '{"ok":true,"reference_expectations":[]}\n';
      fs.writeFileSync(artifactFinding, sanitized);
      fs.writeFileSync(
        verificationMarker,
        verificationMarkerFixture(sha256Hex(sanitized)).replace('"node_id": "property-lens"', '"node_id": "forged"')
      );

      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/would replace an immutable publication file/u);
      expect(fs.readFileSync(artifactFinding, "utf8")).toBe(sanitized);
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects v2 cloud results with conflicting existing verification markers before mutating publications", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive(fixture.input);
    const sandbox = fakeSandbox(result);
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [sandbox] })));
    try {
      const artifactFinding = path.join(fixture.root, fixture.input.artifact_dir, "finding.json");
      const workspaceWork = path.join(fixture.root, fixture.input.workspace_dir, "work.txt");
      const sourceProofRoot = path.join(fixture.root, fixture.input.run_root, "source-proofs");
      const verificationMarker = path.join(
        fixture.root,
        fixture.input.run_root,
        ".ultrafuzz-verification",
        "attempt-one.json"
      );
      fs.writeFileSync(artifactFinding, "existing artifact\n");
      fs.writeFileSync(workspaceWork, "existing workspace\n");
      const existingMarker = "existing marker\n";
      fs.writeFileSync(verificationMarker, existingMarker);

      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/would replace an immutable publication file/u);
      expect(fs.readFileSync(artifactFinding, "utf8")).toBe("existing artifact\n");
      expect(fs.existsSync(path.join(fixture.root, fixture.input.artifact_dir, "stale.txt"))).toBe(true);
      expect(fs.readFileSync(workspaceWork, "utf8")).toBe("existing workspace\n");
      expect(fs.existsSync(path.join(sourceProofRoot, "attempt-one.json"))).toBe(false);
      expect(fs.existsSync(path.join(sourceProofRoot, "attempt-one.invariant.json"))).toBe(false);
      expect(fs.readFileSync(verificationMarker, "utf8")).toBe(existingMarker);
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("accepts exact existing immutable verification and source-proof publications", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive(fixture.input);
    const sandbox = fakeSandbox(result);
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [sandbox] })));
    try {
      const artifactFinding = path.join(fixture.root, fixture.input.artifact_dir, "finding.json");
      const verificationMarker = path.join(
        fixture.root,
        fixture.input.run_root,
        ".ultrafuzz-verification",
        "attempt-one.json"
      );
      const sourceProofRoot = path.join(fixture.root, fixture.input.run_root, "source-proofs");
      const markerContents = verificationMarkerFixture(sha256Hex('{"ok":true}\n'));
      fs.writeFileSync(artifactFinding, '{"ok":true}\n');
      fs.writeFileSync(verificationMarker, markerContents);
      fs.mkdirSync(sourceProofRoot, { recursive: true });
      fs.writeFileSync(path.join(sourceProofRoot, "attempt-one.json"), "pinned source proof\n");
      fs.writeFileSync(path.join(sourceProofRoot, "attempt-one.invariant.json"), "durable source proof\n");

      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).resolves.toMatchObject({ status: "finished" });
      expect(fs.readFileSync(verificationMarker, "utf8")).toBe(markerContents);
      expect(fs.readFileSync(path.join(sourceProofRoot, "attempt-one.json"), "utf8")).toBe("pinned source proof\n");
      expect(fs.readFileSync(path.join(sourceProofRoot, "attempt-one.invariant.json"), "utf8")).toBe(
        "durable source proof\n"
      );
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("publishes reset-generation provenance when a stable invariant proof advances", async () => {
    const fixture = createProjectFixture();
    const baseResult = createResultArchive(fixture.input, { invariantSourceProof: "base generation proof\n" });
    let resetResult: ReturnType<typeof createResultArchive> | undefined;
    try {
      await expect(publishResultFixture(fixture, fixture.input, baseResult)).resolves.toMatchObject({
        workspaceId: "run-one/attempt-one/base"
      });

      const resetInput = withFixtureExecutionGeneration(fixture.input, "reset-one");
      resetResult = createResultArchive(resetInput, { invariantSourceProof: "reset generation proof\n" });
      await expect(publishResultFixture(fixture, resetInput, resetResult)).resolves.toMatchObject({
        workspaceId: "run-one/attempt-one/reset-one"
      });
      expect(fs.readFileSync(invariantProofPath(fixture), "utf8")).toBe("reset generation proof\n");
      const publishedResult = JSON.parse(resetResult.result) as { logical_dispatch_fingerprint: string };
      expect(JSON.parse(fs.readFileSync(invariantProofPublicationPath(fixture), "utf8"))).toMatchObject({
        schema_version: "ultrafuzz.modal.invariant-source-proof-publication.v1",
        attempt_id: "attempt-one",
        execution_generation: "reset-one",
        storage_lineage: "run-one/attempt-one/reset-one",
        logical_dispatch_fingerprint: publishedResult.logical_dispatch_fingerprint,
        source_proof_sha256: sha256Hex("reset generation proof\n")
      });
    } finally {
      resetResult?.cleanup();
      baseResult.cleanup();
      fixture.cleanup();
    }
  });

  it("keeps same-generation invariant proof republication byte immutable", async () => {
    const fixture = createProjectFixture();
    const resetInput = withFixtureExecutionGeneration(fixture.input, "reset-one");
    const publishedResult = createResultArchive(resetInput, { invariantSourceProof: "reset proof\n" });
    let conflictingResult: ReturnType<typeof createResultArchive> | undefined;
    try {
      await expect(publishResultFixture(fixture, resetInput, publishedResult)).resolves.toMatchObject({
        workspaceId: "run-one/attempt-one/reset-one"
      });
      conflictingResult = createResultArchive(resetInput, { invariantSourceProof: "conflicting reset proof\n" });
      await expect(publishResultFixture(fixture, resetInput, conflictingResult)).rejects.toThrow(
        /would replace an immutable publication file/u
      );
      expect(fs.readFileSync(invariantProofPath(fixture), "utf8")).toBe("reset proof\n");
    } finally {
      conflictingResult?.cleanup();
      publishedResult.cleanup();
      fixture.cleanup();
    }
  });

  it("keeps base-generation invariant proof republication byte immutable", async () => {
    const fixture = createProjectFixture();
    const publishedResult = createResultArchive(fixture.input, { invariantSourceProof: "published proof\n" });
    let conflictingResult: ReturnType<typeof createResultArchive> | undefined;
    try {
      await expect(publishResultFixture(fixture, fixture.input, publishedResult)).resolves.toMatchObject({
        workspaceId: "run-one/attempt-one/base"
      });
      conflictingResult = createResultArchive(fixture.input, { invariantSourceProof: "changed proof\n" });
      await expect(publishResultFixture(fixture, fixture.input, conflictingResult)).rejects.toThrow(
        /would replace an immutable publication file/u
      );
      expect(fs.readFileSync(invariantProofPath(fixture), "utf8")).toBe("published proof\n");
    } finally {
      conflictingResult?.cleanup();
      publishedResult.cleanup();
      fixture.cleanup();
    }
  });

  it("advances recorded reset generations while retaining the sealed logical dispatch", async () => {
    const fixture = createProjectFixture();
    const resetOneInput = withFixtureExecutionGeneration(fixture.input, "reset-one");
    const resetTwoInput = withFixtureExecutionGeneration(fixture.input, "reset-two");
    const resetOneResult = createResultArchive(resetOneInput, { invariantSourceProof: "reset one proof\n" });
    const resetTwoResult = createResultArchive(resetTwoInput, { invariantSourceProof: "reset two proof\n" });
    try {
      expect(modalNodeDispatchFingerprint(resetTwoInput)).toBe(modalNodeDispatchFingerprint(resetOneInput));
      await expect(publishResultFixture(fixture, resetOneInput, resetOneResult)).resolves.toMatchObject({
        workspaceId: "run-one/attempt-one/reset-one"
      });
      await expect(publishResultFixture(fixture, resetTwoInput, resetTwoResult)).resolves.toMatchObject({
        workspaceId: "run-one/attempt-one/reset-two"
      });
      const publishedResult = JSON.parse(resetTwoResult.result) as { logical_dispatch_fingerprint: string };
      expect(fs.readFileSync(invariantProofPath(fixture), "utf8")).toBe("reset two proof\n");
      expect(JSON.parse(fs.readFileSync(invariantProofPublicationPath(fixture), "utf8"))).toMatchObject({
        execution_generation: "reset-two",
        storage_lineage: "run-one/attempt-one/reset-two",
        logical_dispatch_fingerprint: publishedResult.logical_dispatch_fingerprint,
        source_proof_sha256: sha256Hex("reset two proof\n")
      });
    } finally {
      resetTwoResult.cleanup();
      resetOneResult.cleanup();
      fixture.cleanup();
    }
  });

  it("backfills only an identical receipt-less invariant proof", async () => {
    const fixture = createProjectFixture();
    const resetInput = withFixtureExecutionGeneration(fixture.input, "reset-one");
    const result = createResultArchive(resetInput, { invariantSourceProof: "reset proof\n" });
    try {
      const proof = invariantProofPath(fixture);
      fs.mkdirSync(path.dirname(proof), { recursive: true });
      fs.writeFileSync(proof, "reset proof\n");
      await expect(publishResultFixture(fixture, resetInput, result)).resolves.toMatchObject({
        workspaceId: "run-one/attempt-one/reset-one"
      });
      expect(JSON.parse(fs.readFileSync(invariantProofPublicationPath(fixture), "utf8"))).toMatchObject({
        execution_generation: "reset-one",
        source_proof_sha256: sha256Hex("reset proof\n")
      });

      fs.rmSync(invariantProofPublicationPath(fixture));
      fs.writeFileSync(proof, "legacy conflicting proof\n");
      await expect(publishResultFixture(fixture, resetInput, result)).rejects.toThrow(
        /would replace an immutable publication file/u
      );
      expect(fs.readFileSync(proof, "utf8")).toBe("legacy conflicting proof\n");
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("recovers proof publication interrupted before its reset-generation receipt", async () => {
    const fixture = createProjectFixture();
    const baseResult = createResultArchive(fixture.input, { invariantSourceProof: "base proof\n" });
    let resetResult: ReturnType<typeof createResultArchive> | undefined;
    try {
      await expect(publishResultFixture(fixture, fixture.input, baseResult)).resolves.toMatchObject({
        workspaceId: "run-one/attempt-one/base"
      });
      const basePublication = fs.readFileSync(invariantProofPublicationPath(fixture), "utf8");
      fs.writeFileSync(invariantProofPath(fixture), "reset proof\n");

      const resetInput = withFixtureExecutionGeneration(fixture.input, "reset-one");
      resetResult = createResultArchive(resetInput, { invariantSourceProof: "reset proof\n" });
      await expect(publishResultFixture(fixture, resetInput, resetResult)).resolves.toMatchObject({
        workspaceId: "run-one/attempt-one/reset-one"
      });
      expect(fs.readFileSync(invariantProofPublicationPath(fixture), "utf8")).not.toBe(basePublication);
      expect(JSON.parse(fs.readFileSync(invariantProofPublicationPath(fixture), "utf8"))).toMatchObject({
        execution_generation: "reset-one",
        source_proof_sha256: sha256Hex("reset proof\n")
      });
    } finally {
      resetResult?.cleanup();
      baseResult.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects unsafe invariant proof generation provenance before advancing", async () => {
    const fixture = createProjectFixture();
    const baseResult = createResultArchive(fixture.input, { invariantSourceProof: "base proof\n" });
    let resetResult: ReturnType<typeof createResultArchive> | undefined;
    try {
      await expect(publishResultFixture(fixture, fixture.input, baseResult)).resolves.toMatchObject({
        workspaceId: "run-one/attempt-one/base"
      });
      const publication = invariantProofPublicationPath(fixture);
      fs.linkSync(publication, `${publication}.linked`);

      const resetInput = withFixtureExecutionGeneration(fixture.input, "reset-one");
      resetResult = createResultArchive(resetInput, { invariantSourceProof: "reset proof\n" });
      await expect(publishResultFixture(fixture, resetInput, resetResult)).rejects.toThrow(
        /destination file is unsafe/u
      );
      expect(fs.readFileSync(invariantProofPath(fixture), "utf8")).toBe("base proof\n");
    } finally {
      resetResult?.cleanup();
      baseResult.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects dangling verification marker destinations before mutating publications", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive(fixture.input);
    const sandbox = fakeSandbox(result);
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [sandbox] })));
    try {
      const artifactFinding = path.join(fixture.root, fixture.input.artifact_dir, "finding.json");
      const workspaceWork = path.join(fixture.root, fixture.input.workspace_dir, "work.txt");
      const verificationMarker = path.join(
        fixture.root,
        fixture.input.run_root,
        ".ultrafuzz-verification",
        "attempt-one.json"
      );
      fs.writeFileSync(artifactFinding, "existing artifact\n");
      fs.writeFileSync(workspaceWork, "existing workspace\n");
      fs.symlinkSync(path.join(fixture.root, "missing-verification-marker-target"), verificationMarker);

      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/destination file is unsafe/u);
      expect(fs.lstatSync(verificationMarker).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(artifactFinding, "utf8")).toBe("existing artifact\n");
      expect(fs.existsSync(path.join(fixture.root, fixture.input.artifact_dir, "stale.txt"))).toBe(true);
      expect(fs.readFileSync(workspaceWork, "utf8")).toBe("existing workspace\n");
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects dangling source-proof destinations before mutating publications", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive(fixture.input);
    const sandbox = fakeSandbox(result);
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [sandbox] })));
    try {
      const artifactFinding = path.join(fixture.root, fixture.input.artifact_dir, "finding.json");
      const workspaceWork = path.join(fixture.root, fixture.input.workspace_dir, "work.txt");
      const sourceProofRoot = path.join(fixture.root, fixture.input.run_root, "source-proofs");
      const sourceProof = path.join(sourceProofRoot, "attempt-one.json");
      const verificationMarker = path.join(
        fixture.root,
        fixture.input.run_root,
        ".ultrafuzz-verification",
        "attempt-one.json"
      );
      fs.writeFileSync(artifactFinding, "existing artifact\n");
      fs.writeFileSync(workspaceWork, "existing workspace\n");
      fs.mkdirSync(sourceProofRoot, { recursive: true });
      fs.symlinkSync(path.join(fixture.root, "missing-source-proof-target"), sourceProof);

      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/destination file is unsafe/u);
      expect(fs.lstatSync(sourceProof).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(verificationMarker)).toBe(false);
      expect(fs.readFileSync(artifactFinding, "utf8")).toBe("existing artifact\n");
      expect(fs.existsSync(path.join(fixture.root, fixture.input.artifact_dir, "stale.txt"))).toBe(true);
      expect(fs.readFileSync(workspaceWork, "utf8")).toBe("existing workspace\n");
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects hard-linked existing verification marker destinations before mutating publications", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive(fixture.input);
    const sandbox = fakeSandbox(result);
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [sandbox] })));
    try {
      const artifactFinding = path.join(fixture.root, fixture.input.artifact_dir, "finding.json");
      const workspaceWork = path.join(fixture.root, fixture.input.workspace_dir, "work.txt");
      const sourceProofRoot = path.join(fixture.root, fixture.input.run_root, "source-proofs");
      const verificationMarker = path.join(
        fixture.root,
        fixture.input.run_root,
        ".ultrafuzz-verification",
        "attempt-one.json"
      );
      const linkedMarker = path.join(fixture.root, fixture.input.run_root, ".ultrafuzz-verification", "linked.json");
      fs.writeFileSync(artifactFinding, "existing artifact\n");
      fs.writeFileSync(workspaceWork, "existing workspace\n");
      const linkedMarkerContents = verificationMarkerFixture(sha256Hex("existing artifact\n"));
      fs.writeFileSync(linkedMarker, linkedMarkerContents);
      fs.linkSync(linkedMarker, verificationMarker);

      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/destination file is unsafe/u);
      expect(fs.readFileSync(artifactFinding, "utf8")).toBe("existing artifact\n");
      expect(fs.existsSync(path.join(fixture.root, fixture.input.artifact_dir, "stale.txt"))).toBe(true);
      expect(fs.readFileSync(workspaceWork, "utf8")).toBe("existing workspace\n");
      expect(fs.existsSync(path.join(sourceProofRoot, "attempt-one.json"))).toBe(false);
      expect(fs.existsSync(path.join(sourceProofRoot, "attempt-one.invariant.json"))).toBe(false);
      expect(fs.readFileSync(verificationMarker, "utf8")).toBe(linkedMarkerContents);
      expect(fs.readFileSync(linkedMarker, "utf8")).toBe(linkedMarkerContents);
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects v2 cloud results missing artifacts before mutating workspace publications", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive(fixture.input, { includeArtifactsDirectory: false });
    const sandbox = fakeSandbox(result);
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [sandbox] })));
    try {
      const artifactFinding = path.join(fixture.root, fixture.input.artifact_dir, "finding.json");
      const workspaceWork = path.join(fixture.root, fixture.input.workspace_dir, "work.txt");
      const sourceProofRoot = path.join(fixture.root, fixture.input.run_root, "source-proofs");
      fs.writeFileSync(artifactFinding, "existing artifact\n");
      fs.writeFileSync(workspaceWork, "existing workspace\n");

      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/missing a required publication directory/u);
      expect(fs.readFileSync(artifactFinding, "utf8")).toBe("existing artifact\n");
      expect(fs.existsSync(path.join(fixture.root, fixture.input.artifact_dir, "stale.txt"))).toBe(true);
      expect(fs.readFileSync(workspaceWork, "utf8")).toBe("existing workspace\n");
      expect(fs.existsSync(path.join(sourceProofRoot, "attempt-one.json"))).toBe(false);
      expect(fs.existsSync(path.join(sourceProofRoot, "attempt-one.invariant.json"))).toBe(false);
      expect(
        fs.existsSync(path.join(fixture.root, fixture.input.run_root, ".ultrafuzz-verification", "attempt-one.json"))
      ).toBe(false);
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("refuses a terminal result that lacks a durable checkpoint reference", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive(fixture.input, { includeDurableCheckpoint: false });
    const sandbox = fakeSandbox(result);
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [sandbox] })));
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/cloud node result is invalid/u);
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects duplicate-key and Ajv-invalid result bytes at the host boundary", async () => {
    const fixture = createProjectFixture();
    const duplicate = createResultArchive(fixture.input);
    duplicate.result = duplicate.result.replace('"status":"succeeded"', '"status":"succeeded","status":"succeeded"');
    const duplicateProvider = createModalNodeSandboxProvider(
      providerOptions(fakeClient({ listed: [fakeSandbox(duplicate)] }))
    );
    try {
      await expect(
        duplicateProvider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/cloud node result is invalid/u);
    } finally {
      duplicate.cleanup();
    }

    const unknownField = createResultArchive(fixture.input);
    const parsed = JSON.parse(unknownField.result) as Record<string, unknown>;
    parsed.legacy_status = "succeeded";
    unknownField.result = JSON.stringify(parsed);
    const unknownFieldProvider = createModalNodeSandboxProvider(
      providerOptions(fakeClient({ listed: [fakeSandbox(unknownField)] }))
    );
    try {
      await expect(
        unknownFieldProvider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/cloud node result is invalid/u);
    } finally {
      unknownField.cleanup();
      fixture.cleanup();
    }
  }, 15_000);

  it("rejects individually valid checkpoint/result/index documents with a cross-file mismatch", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive(fixture.input);
    const index = JSON.parse(result.durableCheckpointIndex) as {
      checkpoints: Array<{ created_at: string }>;
    };
    index.checkpoints.at(-1)!.created_at = "2026-08-09T00:03:00.000Z";
    result.durableCheckpointIndex = JSON.stringify(index);
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [fakeSandbox(result)] })));
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/modal-node-checkpoint-result-index-context/u);
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects checkpoint and index documents whose matching archive digest differs from the trusted input", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive(fixture.input, {
      preserveProjectArchiveSha256: true
    });
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [fakeSandbox(result)] })));
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/modal-node-checkpoint-result-index-context/u);
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("reports structured worker diagnostics when a fresh cloud worker fails", async () => {
    const fixture = createProjectFixture();
    const sandbox = fakeSandbox(undefined);
    const workerError = {
      schema_version: "ultrafuzz.modal.node-worker-error.v1",
      message: "cloud worker phase run-workflow failed with code 7",
      phase: "run-workflow",
      command: "smithers",
      exit_code: 7,
      stderr: "workflow failed with provider-secret-value"
    };
    sandbox.exec = vi.fn(async () => ({
      stdout: { readText: vi.fn(async () => "worker stdout\n") },
      stderr: {
        readBytes: vi.fn(async () => Buffer.from(`${JSON.stringify(workerError)}\n`, "utf8"))
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
      ).rejects.toThrow(/run-workflow.*workflow failed with \[credential\]/u);
      expect(sandbox.terminate).toHaveBeenCalledOnce();
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    {
      name: "duplicate keys",
      bytes: Buffer.from(
        '{"schema_version":"ultrafuzz.modal.node-worker-error.v1","message":"first","message":"second"}\n',
        "utf8"
      ),
      diagnostic: /JSON_DUPLICATE_KEY/u
    },
    {
      name: "invalid UTF-8",
      bytes: Buffer.concat([
        Buffer.from('{"schema_version":"ultrafuzz.modal.node-worker-error.v1","message":"invalid ', "utf8"),
        Buffer.from([0xff]),
        Buffer.from('"}\n', "utf8")
      ]),
      diagnostic: /JSON is not valid UTF-8/u
    },
    {
      name: "schema-invalid JSON",
      bytes: Buffer.from(
        '{"schema_version":"ultrafuzz.modal.node-worker-error.v1","message":"invalid","unexpected":true}\n',
        "utf8"
      ),
      diagnostic: /JSON_SCHEMA_VIOLATION/u
    }
  ])("rejects $name in a present worker-error document", async ({ bytes, diagnostic }) => {
    const fixture = createProjectFixture();
    const sandbox = fakeSandbox(undefined);
    sandbox.exec = vi.fn(async () => ({
      stdout: { readText: vi.fn(async () => "worker stdout\n") },
      stderr: { readBytes: vi.fn(async () => bytes) },
      wait: vi.fn(async () => 1)
    })) as never;
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ created: sandbox })));
    try {
      const failure = await Promise.resolve(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).then(
        () => undefined,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/worker error document is invalid/u);
      expect((failure as Error).message).toMatch(diagnostic);
      expect((failure as Error).message).not.toContain('"message":"invalid"');
      expect((failure as Error).message.length).toBeLessThanOrEqual(4_125);
      expect(sandbox.terminate).toHaveBeenCalledOnce();
    } finally {
      fixture.cleanup();
    }
  });

  it("binds Moonshot fallback credentials into the canonical Kimi API-key secret", async () => {
    const fixture = createProjectFixture({ agentCredentialEnv: ["KIMI_API_KEY"] });
    const result = createResultArchive(fixture.input);
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

  it("binds only the compiled task's scoped allowlist entries into its Modal secret", async () => {
    const fixture = createProjectFixture({
      agentCredentialEnv: [
        "AWS_SESSION_TOKEN",
        "FOUNDRY_PROFILE",
        "ULTRAFUZZ_AGENT_ENV_ALLOWLIST",
        "ULTRAFUZZ_SENSITIVE_AGENT_ENV_NAMES"
      ]
    });
    const result = createResultArchive(fixture.input);
    const sandbox = fakeSandbox(result);
    const client = fakeClient({ created: sandbox });
    const provider = createModalNodeSandboxProvider({
      ...providerOptions(client),
      env: {
        [PROVIDER_ID_ENV]: "provider-id-value",
        [PROVIDER_SECRET_ENV]: "provider-secret-value",
        AWS_SESSION_TOKEN: "claude-route-token",
        CUSTOM_SHARED_TOKEN: "must-not-cross-provider-boundaries",
        FOUNDRY_PROFILE: "ci",
        ULTRAFUZZ_AGENT_ENV_ALLOWLIST: "AWS_SESSION_TOKEN,CUSTOM_SHARED_TOKEN,FOUNDRY_PROFILE",
        ULTRAFUZZ_SENSITIVE_AGENT_ENV_NAMES: "AWS_SESSION_TOKEN,CUSTOM_SHARED_TOKEN"
      }
    });
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
        AWS_SESSION_TOKEN: "claude-route-token",
        FOUNDRY_PROFILE: "ci",
        ULTRAFUZZ_AGENT_ENV_ALLOWLIST: "AWS_SESSION_TOKEN,CUSTOM_SHARED_TOKEN,FOUNDRY_PROFILE",
        ULTRAFUZZ_SENSITIVE_AGENT_ENV_NAMES: "AWS_SESSION_TOKEN,CUSTOM_SHARED_TOKEN"
      });
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("treats Moonshot as an optional Kimi fallback when compiled cloud tasks list both names", async () => {
    const fixture = createProjectFixture({ agentCredentialEnv: ["KIMI_API_KEY", "MOONSHOT_API_KEY"] });
    const result = createResultArchive(fixture.input);
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
    const fixture = createProjectFixture({ agentCredentialEnv: ["KIMI_API_KEY", "MOONSHOT_API_KEY"] });
    const result = createResultArchive(fixture.input);
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
    const fixture = createProjectFixture({
      agentCredentialEnv: ["KIMI_API_KEY", "MOONSHOT_API_KEY", "KIMI_BASE_URL"]
    });
    const result = createResultArchive(fixture.input);
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
    const result = createResultArchive(fixture.input);
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
      ).rejects.toThrow(/cloud node input is invalid/u);
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
      stderr: { readBytes: vi.fn(async () => new Uint8Array()) },
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
      await vi.waitFor(() => expect(sandbox.exec).toHaveBeenCalledOnce(), { timeout: 10_000 });
      controller.abort();
      await expect(running).rejects.toThrow("cancelled");
      expect(sandbox.terminate).toHaveBeenCalled();
    } finally {
      fixture.cleanup();
    }
  }, 15_000);

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
    clientFactory: (_credentials: unknown, context?: { projectArchiveSha256: string }) => {
      if (context !== undefined) client.bindProjectArchiveSha256(context.projectArchiveSha256);
      return client as never;
    }
  };
}

function createProjectFixture(
  options: {
    smithersCli?: string;
    pinnedSubmodules?: boolean;
    committedSymlink?: boolean;
    governanceDirty?: boolean;
    divergentSource?: boolean;
    optionalDependencyAttemptIds?: readonly string[];
    referenceDependencyAttemptIds?: readonly string[];
    vulnerabilityDatabaseReferenceAttemptId?: string;
    agentCredentialEnv?: readonly string[];
    operatorPrompt?: string;
    trackedIgnored?: boolean;
    recordedSource?: boolean;
  } = {}
) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-provider-test-"));
  const root = path.join(temporaryRoot, "project");
  const runRoot = ".ultrafuzz/runs/run-one";
  const artifactDir = `${runRoot}/artifacts/attempt-one`;
  const dependencyArtifactDirs = [`${runRoot}/artifacts/dependency-one`, `${runRoot}/artifacts/dependency-two`];
  const optionalDependencyArtifactDirs = dependencyArtifactDirs.filter((directory) =>
    (options.optionalDependencyAttemptIds ?? []).includes(path.basename(directory))
  );
  const referenceDependencyArtifactDirs = dependencyArtifactDirs.filter((directory) =>
    (options.referenceDependencyAttemptIds ?? []).includes(path.basename(directory))
  );
  const vulnerabilityDatabaseReferenceArtifactDir =
    options.vulnerabilityDatabaseReferenceAttemptId === undefined
      ? undefined
      : referenceDependencyArtifactDirs.find(
          (directory) => path.basename(directory) === options.vulnerabilityDatabaseReferenceAttemptId
        );
  if (
    options.vulnerabilityDatabaseReferenceAttemptId !== undefined &&
    vulnerabilityDatabaseReferenceArtifactDir === undefined
  ) {
    throw new Error("fixture vulnerability database must belong to an authenticated reference dependency");
  }
  if (optionalDependencyArtifactDirs.some((directory) => referenceDependencyArtifactDirs.includes(directory))) {
    throw new Error("fixture reference dependencies cannot be optional");
  }
  const workspaceDir = `${runRoot}/workspaces/attempt-one`;
  const pendingSnapshotRoot = path.join(root, runRoot, "smithers", "execution-snapshots", "pending");
  const workflowRelativePath = ".smithers/workflows/ultrafuzz-run-one.tsx";
  const promptRelativePath = "controls/rendered-prompts/attempt-one.md";
  const mutableWorkflowPath = ".smithers/workflows/ultrafuzz-run-one.tsx";
  const mutablePromptPath = `${runRoot}/prompts/attempt-one.md`;
  fs.mkdirSync(path.join(root, path.dirname(mutableWorkflowPath)), { recursive: true });
  fs.mkdirSync(path.join(root, path.dirname(mutablePromptPath)), { recursive: true });
  fs.mkdirSync(path.join(root, ".smithers", "agents"), { recursive: true });
  fs.mkdirSync(path.join(root, artifactDir), { recursive: true });
  for (const dependency of dependencyArtifactDirs) {
    fs.mkdirSync(path.join(root, dependency), { recursive: true });
    fs.writeFileSync(path.join(root, dependency, "declared.txt"), `${dependency}\n`);
  }
  const markerRoot = path.join(root, runRoot, ".ultrafuzz-verification");
  fs.mkdirSync(markerRoot, { recursive: true });
  const dependencyVerificationAuthorities: ModalNodeSandboxInput["dependency_verification_authorities"] = [];
  for (const dependency of dependencyArtifactDirs) {
    if (referenceDependencyArtifactDirs.includes(dependency)) continue;
    const relativePath = "declared.txt";
    const artifactPath = path.join(root, dependency, relativePath);
    const sha256 = sha256Hex(fs.readFileSync(artifactPath, "utf8"));
    const markerContents = Buffer.from(
      `${JSON.stringify({
        schema_version: "ultrafuzz.artifact-verification.v2",
        attempt_id: path.basename(dependency),
        node_id: path.basename(dependency),
        artifacts: [
          {
            path: relativePath,
            ...currentArtifactBinding("ultrafuzz/text@1"),
            sha256,
            primary: true
          }
        ],
        publications: [{ path: relativePath, sha256 }]
      })}\n`
    );
    fs.writeFileSync(path.join(markerRoot, `${path.basename(dependency)}.json`), markerContents);
    dependencyVerificationAuthorities.push({
      attempt_id: path.basename(dependency),
      marker_sha256: sha256Hex(markerContents),
      size_bytes: markerContents.byteLength
    });
  }
  fs.writeFileSync(path.join(markerRoot, "unrelated.json"), "{}\n");
  fs.mkdirSync(path.join(root, runRoot, "artifacts", "unrelated"), { recursive: true });
  fs.mkdirSync(path.join(root, workspaceDir), { recursive: true });
  fs.mkdirSync(path.join(root, runRoot, "logs"), { recursive: true });
  fs.writeFileSync(path.join(root, "source.txt"), "committed source\n");
  fs.writeFileSync(path.join(root, ".smithers", "agents", "kimi.ts"), "export const mutableKimi = true;\n");
  fs.writeFileSync(path.join(root, ".smithers", "agents", "deepseek.ts"), "export const mutableDeepSeek = true;\n");
  fs.writeFileSync(path.join(root, ".smithers", "agents", "openrouter.ts"), "export const mutableOpenRouter = true;\n");
  fs.writeFileSync(path.join(root, ".smithers", "agents", "environment.ts"), "export const mutableEnv = true;\n");
  fs.writeFileSync(path.join(root, mutableWorkflowPath), "export default { mutable: true };\n");
  fs.writeFileSync(path.join(root, mutablePromptPath), "mutable rendered prompt\n");
  fs.writeFileSync(path.join(root, artifactDir, "stale.txt"), "stale\n");
  fs.writeFileSync(path.join(root, runRoot, "artifacts", "unrelated", "unrelated.txt"), "unrelated\n");
  fs.writeFileSync(path.join(root, workspaceDir, "local.txt"), "excluded\n");
  fs.writeFileSync(path.join(root, runRoot, "logs", "local.log"), "excluded\n");
  if (options.committedSymlink === true) fs.symlinkSync("source.txt", path.join(root, "source-link.txt"));
  if (options.trackedIgnored === true) {
    fs.writeFileSync(path.join(root, ".gitignore"), "tracked-ignored.txt\nuntracked-ignored.txt\n");
    fs.writeFileSync(path.join(root, "tracked-ignored.txt"), "committed but ignored\n");
    fs.writeFileSync(path.join(root, "untracked-ignored.txt"), "untracked and ignored\n");
  }
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Ultrafuzz Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@invalid"], { cwd: root });
  execFileSync(
    "git",
    [
      "add",
      "source.txt",
      ...(options.committedSymlink === true ? ["source-link.txt"] : []),
      ...(options.trackedIgnored === true ? [".gitignore"] : [])
    ],
    { cwd: root }
  );
  if (options.trackedIgnored === true) {
    execFileSync("git", ["add", "--force", "tracked-ignored.txt"], { cwd: root });
  }
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
  const parentCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (options.divergentSource === true) {
    execFileSync("git", ["switch", "--quiet", "-c", "develop"], { cwd: root });
    fs.rmSync(path.join(root, "source.txt"));
    fs.writeFileSync(path.join(root, "develop-only.txt"), "develop\n");
    execFileSync("git", ["add", "--all", "--", "source.txt", "develop-only.txt"], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "develop source"], { cwd: root });
  }
  if (options.pinnedSubmodules === true) {
    execFileSync("git", ["update-index", "--add", "--cacheinfo", `160000,${"d".repeat(40)},vendor/dependency`], {
      cwd: root
    });
    execFileSync("git", ["commit", "--quiet", "-m", "pinned dependency"], { cwd: root });
    execFileSync("git", ["branch", "-M", "ultrafuzz-pinned"], { cwd: root });
  }
  const governedCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const governedTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
  const sourceRevision =
    options.divergentSource === true || options.pinnedSubmodules === true || options.recordedSource === true
      ? governedCommit
      : undefined;
  const sourceRef =
    options.pinnedSubmodules === true
      ? "refs/heads/ultrafuzz-pinned"
      : options.divergentSource === true || options.recordedSource === true
        ? "refs/ultrafuzz/runs/run-one/source"
        : undefined;
  const consumerAgentCredentialEnv = [...(options.agentCredentialEnv ?? [AGENT_ENV])];

  const dependencyOutput = {
    path: "declared.txt",
    ...currentArtifactBinding("ultrafuzz/text@1"),
    primary: true
  };
  const consumerOutput = {
    path: "result.txt",
    ...currentArtifactBinding("ultrafuzz/text@1"),
    primary: true
  };
  const referenceManifestOutput = {
    path: "references/manifest.json",
    ...currentArtifactBinding("ultrafuzz/reference-manifest@1"),
    primary: false
  };
  const graph = {
    schema_version: "ultrafuzz.planned-graph.v4",
    graph_version: "4",
    topology_version: 2,
    groups:
      optionalDependencyArtifactDirs.length === 0
        ? {}
        : { optional: { label: "Optional dependencies", defaults: { failure_policy: "continue" } } },
    nodes: [
      ...dependencyArtifactDirs.map((directory) => {
        const id = path.basename(directory);
        const isReference = referenceDependencyArtifactDirs.includes(directory);
        return {
          id,
          logical_id: id,
          display_name: id,
          kind: isReference ? "reference" : "agentic",
          ...(optionalDependencyArtifactDirs.includes(directory) ? { group: "optional" } : {}),
          depends_on: [],
          artifact_dir: `artifacts/${id}`,
          outputs: isReference ? [dependencyOutput, referenceManifestOutput] : [dependencyOutput],
          prompt_id: id,
          prompt_path: isReference ? "" : `fixtures/${id}.md`,
          ...(isReference
            ? {
                reference: "fixture-reference",
                reference_revision: {
                  provider: "github",
                  repo: "owner/repo",
                  commit: "b".repeat(40),
                  paths: ["declared.txt"]
                }
              }
            : {}),
          loop: { index: 0, count: 1, mode: "parallel", attempt_index: 0 },
          model_fanout: [],
          ...(isReference ? {} : { workflow: { node_id: `node:${id}`, task_node_ids: [`node:${id}`] } })
        };
      }),
      {
        id: "attempt-one",
        logical_id: "attempt-one",
        display_name: "attempt-one",
        kind: "agentic",
        depends_on: dependencyArtifactDirs.map((directory) => path.basename(directory)),
        artifact_dir: "artifacts/attempt-one",
        outputs: [consumerOutput],
        prompt_id: "attempt-one",
        prompt_path: "fixtures/attempt-one.md",
        loop: { index: 0, count: 1, mode: "parallel", attempt_index: 0 },
        model_fanout: [],
        workflow: { node_id: "node:attempt-one", task_node_ids: ["node:attempt-one"] }
      }
    ]
  };
  const graphContents = `${JSON.stringify(graph)}\n`;
  fs.mkdirSync(path.join(root, runRoot), { recursive: true });
  fs.writeFileSync(path.join(root, runRoot, "graph.json"), graphContents);

  const referenceArtifactManifestAuthorities: NonNullable<
    SmithersTaskManifestTask["referenceArtifactManifestAuthorities"]
  > = [];
  for (const directory of referenceDependencyArtifactDirs) {
    const dependencyRoot = path.join(root, directory);
    const attemptId = path.basename(directory);
    const referenceManifestRelativePath = "references/manifest.json";
    const referenceManifestContents = `${JSON.stringify({
      schema_version: "ultrafuzz.reference-manifest.v1",
      reference: "fixture-reference"
    })}\n`;
    fs.mkdirSync(path.join(dependencyRoot, "references"), { recursive: true });
    fs.writeFileSync(path.join(dependencyRoot, referenceManifestRelativePath), referenceManifestContents);
    const provenance = {
      producer_node_id: attemptId,
      run_id: "run-one",
      logical_node_id: attemptId,
      origin: "pinned-reference",
      metadata: {
        reference: "fixture-reference",
        repo: "owner/repo",
        commit: "b".repeat(40),
        reference_artifact: path.join(dependencyRoot, "declared.txt"),
        manifest_artifact: path.join(dependencyRoot, referenceManifestRelativePath)
      }
    };
    const referenceFiles = ["declared.txt", referenceManifestRelativePath].map((relativePath) => {
      const contents = fs.readFileSync(path.join(dependencyRoot, relativePath));
      return {
        path: relativePath,
        size_bytes: contents.byteLength,
        sha256: sha256Hex(contents),
        provenance
      };
    });
    const artifactManifestContents = Buffer.from(
      `${JSON.stringify({
        schema_version: "ultrafuzz.artifact-manifest.v3",
        run_id: "run-one",
        node_id: attemptId,
        producer_node_id: attemptId,
        created_at: "2026-01-01T00:00:00.000Z",
        files: referenceFiles,
        output_contracts: [dependencyOutput, referenceManifestOutput],
        prerequisite_manifests: [],
        provenance
      })}\n`
    );
    fs.writeFileSync(path.join(dependencyRoot, "artifact-manifest.json"), artifactManifestContents);
    referenceArtifactManifestAuthorities.push({
      attemptId,
      artifactDir: dependencyRoot,
      sizeBytes: artifactManifestContents.byteLength,
      sha256: sha256Hex(artifactManifestContents)
    });
  }

  const producerTasks = dependencyArtifactDirs
    .filter((directory) => !referenceDependencyArtifactDirs.includes(directory))
    .map((directory) => {
      const attemptId = path.basename(directory);
      return fixtureSmithersTask({
        root,
        runRoot,
        attemptId,
        sourceRevision,
        sourceRef,
        outputs: [
          {
            path: "declared.txt",
            ...currentTaskOutputBinding("ultrafuzz/text@1"),
            primary: true
          }
        ],
        ...(optionalDependencyArtifactDirs.includes(directory) ? { group: "optional" } : {})
      });
    });
  const vulnerabilityDatabaseCatalog =
    vulnerabilityDatabaseReferenceArtifactDir === undefined
      ? undefined
      : {
          path: path.join(root, vulnerabilityDatabaseReferenceArtifactDir, "declared.txt"),
          sha256: sha256Hex(fs.readFileSync(path.join(root, vulnerabilityDatabaseReferenceArtifactDir, "declared.txt")))
        };
  const consumerDependencyArtifactDirs =
    vulnerabilityDatabaseCatalog === undefined
      ? dependencyArtifactDirs
      : dependencyArtifactDirs.filter((directory) => !referenceDependencyArtifactDirs.includes(directory));
  const consumerTask = fixtureSmithersTask({
    root,
    runRoot,
    attemptId: "attempt-one",
    dependencies: dependencyArtifactDirs.map((directory) => path.basename(directory)),
    dependencySmithersNodeIds: dependencyArtifactDirs
      .filter((directory) => !referenceDependencyArtifactDirs.includes(directory))
      .map((directory) => `verify:${path.basename(directory)}`),
    dependencyArtifactDirs: consumerDependencyArtifactDirs.map((directory) => path.join(root, directory)),
    referenceArtifactDirs: referenceDependencyArtifactDirs.map((directory) => path.join(root, directory)),
    optionalDependencyArtifactDirs: optionalDependencyArtifactDirs.map((directory) => path.join(root, directory)),
    ...(referenceArtifactManifestAuthorities.length === 0 ? {} : { referenceArtifactManifestAuthorities }),
    ...(vulnerabilityDatabaseCatalog === undefined ? {} : { vulnerabilityDatabaseCatalog }),
    sourceRevision,
    sourceRef,
    renderedPromptPath: path.join(root, mutablePromptPath),
    agentCredentialEnv: consumerAgentCredentialEnv,
    outputs: [
      {
        path: "result.txt",
        ...currentTaskOutputBinding("ultrafuzz/text@1"),
        primary: true
      }
    ]
  });
  const tasks = [...producerTasks, consumerTask];
  const taskManifestContents = `${JSON.stringify({
    schema_version: SMITHERS_TASK_MANIFEST_SCHEMA_VERSION,
    run_id: "run-one",
    smithers_run_id: "workflow-one",
    workflow_name: "fixture-workflow",
    ...(sourceRevision === undefined ? {} : { source_revision: sourceRevision, source_ref: sourceRef }),
    pinned_submodules: null,
    tasks
  })}\n`;
  const workflowInputContents = `${JSON.stringify({
    schema_version: SMITHERS_TASK_MANIFEST_SCHEMA_VERSION,
    ultrafuzz_run_id: "run-one",
    ...(options.operatorPrompt === undefined ? {} : { operator_prompt: options.operatorPrompt }),
    tasks: [{ id: "node:attempt-one", prompt_path: promptRelativePath }]
  })}\n`;
  fs.mkdirSync(path.join(root, runRoot, "smithers"), { recursive: true });
  fs.writeFileSync(path.join(root, runRoot, "smithers", "input.json"), workflowInputContents);

  const snapshotFiles = new Map<string, string>([
    [workflowRelativePath, "export default { sealed: true };\n"],
    [promptRelativePath, "sealed rendered prompt\n"],
    ["tsconfig.json", "{}\n"],
    ["controls/bunfig.toml", "\n"],
    ["controls/bun-module-confinement.js", BUN_MODULE_CONFINEMENT_SOURCE],
    ["controls/tasks.json", taskManifestContents],
    ["controls/ultrafuzz.toml", '[models]\ndefault = "sealed"\n'],
    [
      "controls/data-governance.json",
      `${JSON.stringify({ policy: { sensitivity: options.governanceDirty === true ? "public" : "private" }, target: { commit: governedCommit, tree: governedTree, dirty: options.governanceDirty === true }, required_source_destinations: [] })}\n`
    ],
    [".smithers/agents/index.ts", 'export * from "./kimi.ts";\n'],
    [".smithers/agents/codex.ts", "export const sealedCodex = true;\n"],
    [".smithers/agents/claude.ts", "export const sealedClaude = true;\n"],
    [".smithers/agents/kimi.ts", "export const sealedKimi = true;\n"],
    [".smithers/agents/deepseek.ts", "export const sealedDeepSeek = true;\n"],
    [".smithers/agents/openrouter.ts", "export const sealedOpenRouter = true;\n"],
    [".smithers/agents/environment.ts", "export const sealedEnvironment = true;\n"],
    [".smithers/agents/toml.ts", "export const sealedToml = true;\n"],
    ["modules/@ultrafuzz/artifacts/package.json", '{"name":"@ultrafuzz/artifacts"}\n'],
    ["modules/@ultrafuzz/artifacts/dist/index.js", "export const sealedArtifacts = true;\n"],
    ["modules/@ultrafuzz/runtime/package.json", '{"name":"@ultrafuzz/runtime"}\n'],
    ["modules/@ultrafuzz/runtime/dist/index.js", "export const sealedRuntime = true;\n"],
    ["dependencies/packages/000001/package.json", '{"name":"smthrs","version":"1.0.0"}\n'],
    ["dependencies/packages/000001/dist/cli.js", options.smithersCli ?? "#!/usr/bin/env node\n"]
  ]);
  if (options.pinnedSubmodules === true) {
    const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const sourceTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
    const dependencyContents = "dependency\n";
    const snapshot = {
      schema_version: "ultrafuzz.pinned-submodules.v2",
      source_commit: sourceCommit,
      source_tree: sourceTree,
      top_level_roots: ["vendor/dependency"],
      recursive_gitlinks: [{ path: "vendor/dependency", commit: "d".repeat(40), tree: "e".repeat(40) }],
      entries: [
        { path: "vendor/dependency", type: "directory", mode: 493 },
        {
          path: "vendor/dependency/dependency.txt",
          type: "file",
          mode: 420,
          size_bytes: Buffer.byteLength(dependencyContents),
          sha256: sha256Hex(dependencyContents)
        }
      ]
    };
    snapshotFiles.set("controls/pinned-submodules/manifest.json", `${JSON.stringify(snapshot, null, 2)}\n`);
    snapshotFiles.set("controls/pinned-submodules/tree/vendor/dependency/dependency.txt", dependencyContents);
  }
  const dependencyManifest = {
    schema_version: "ultrafuzz.workflow-execution-dependencies.v1",
    modules: [
      {
        id: "module:@ultrafuzz/artifacts",
        name: "@ultrafuzz/artifacts",
        snapshot_path: "modules/@ultrafuzz/artifacts"
      },
      {
        id: "module:@ultrafuzz/runtime",
        name: "@ultrafuzz/runtime",
        snapshot_path: "modules/@ultrafuzz/runtime"
      }
    ],
    packages: [
      {
        id: "package:000001",
        name: "smthrs",
        version: "1.0.0",
        snapshot_path: "dependencies/packages/000001"
      }
    ],
    issuers: [
      { id: "module:@ultrafuzz/artifacts", snapshot_path: "modules/@ultrafuzz/artifacts", dependencies: {} },
      { id: "module:@ultrafuzz/runtime", snapshot_path: "modules/@ultrafuzz/runtime", dependencies: {} },
      { id: "package:000001", snapshot_path: "dependencies/packages/000001", dependencies: {} },
      { id: "root", snapshot_path: ".", dependencies: { smthrs: "package:000001" } }
    ],
    executable_paths: ["dependencies/packages/000001/dist/cli.js"],
    smithers_bin: "dependencies/packages/000001/dist/cli.js"
  };
  snapshotFiles.set("dependencies/manifest.json", `${JSON.stringify(dependencyManifest)}\n`);
  for (const [relativePath, contents] of snapshotFiles) {
    const destination = path.join(pendingSnapshotRoot, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
  }
  fs.chmodSync(path.join(pendingSnapshotRoot, "dependencies/packages/000001/dist/cli.js"), 0o500);
  const dependencyLink = path.join(pendingSnapshotRoot, "node_modules", "smthrs");
  fs.mkdirSync(path.dirname(dependencyLink), { recursive: true });
  fs.symlinkSync("../dependencies/packages/000001", dependencyLink, "dir");

  const executionFiles = [...snapshotFiles]
    .filter(([relativePath]) => relativePath !== workflowRelativePath)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([relativePath, contents]) => ({
      source_path:
        relativePath === promptRelativePath ? path.join(root, mutablePromptPath) : path.join(root, relativePath),
      snapshot_path: relativePath,
      sha256: sha256Hex(contents),
      size_bytes: Buffer.byteLength(contents)
    }));
  const workflowContents = snapshotFiles.get(workflowRelativePath)!;
  const workflowSeal = { sha256: sha256Hex(workflowContents), size_bytes: Buffer.byteLength(workflowContents) };
  const graphSeal = { sha256: sha256Hex(graphContents), size_bytes: Buffer.byteLength(graphContents) };
  const taskSeal = {
    sha256: sha256Hex(taskManifestContents),
    size_bytes: Buffer.byteLength(taskManifestContents)
  };
  const inputSeal = { sha256: sha256Hex(workflowInputContents), size_bytes: Buffer.byteLength(workflowInputContents) };
  const controlSeal = `${JSON.stringify({
    schema_version: "ultrafuzz.workflow-control-integrity.v2",
    run_id: "run-one",
    files: {
      graph: graphSeal,
      expanded_graph: workflowSeal,
      graph_fingerprint: workflowSeal,
      config: workflowSeal,
      tasks: taskSeal,
      input: inputSeal,
      workflow: workflowSeal,
      evidence_workflow: workflowSeal
    },
    execution_files: executionFiles,
    bindings: {
      run_id: "run-one",
      graph_fingerprint: "0".repeat(64),
      config_fingerprint: "1".repeat(64),
      expected_state_node_ids: graph.nodes.map((node) => node.id).sort(),
      expected_task_attempt_ids: tasks.map((task) => task.attemptId).sort(),
      expected_task_node_ids: tasks
        .flatMap((task) => [task.preparationSmithersNodeId, task.smithersNodeId, task.verifierSmithersNodeId])
        .sort()
    }
  })}\n`;
  const snapshotGeneration = sha256Hex(controlSeal);
  const executionSnapshotRoot = `${runRoot}/smithers/execution-snapshots/${snapshotGeneration}`;
  const executionSnapshotAbsolute = path.join(root, executionSnapshotRoot);
  fs.renameSync(pendingSnapshotRoot, executionSnapshotAbsolute);
  fs.writeFileSync(path.join(root, runRoot, "smithers", "control-integrity.json"), controlSeal);
  sealFixtureSnapshot(executionSnapshotAbsolute);
  const workflowPath = `${executionSnapshotRoot}/${workflowRelativePath}`;
  const promptPath = `${executionSnapshotRoot}/${promptRelativePath}`;
  const input: ModalNodeSandboxInput = {
    schema_version: "ultrafuzz.modal.node.v2",
    run_id: "run-one",
    task_id: "node:attempt-one",
    attempt_id: "attempt-one",
    ...(sourceRevision === undefined ? {} : { source_revision: sourceRevision, source_ref: sourceRef }),
    execution_generation: "base",
    execution_snapshot_root: executionSnapshotRoot,
    workflow_path: workflowPath,
    prompt_path: promptPath,
    run_root: runRoot,
    artifact_dir: artifactDir,
    workspace_dir: workspaceDir,
    dependency_artifact_dirs: consumerDependencyArtifactDirs,
    ...(referenceDependencyArtifactDirs.length === 0
      ? {}
      : { reference_artifact_dirs: referenceDependencyArtifactDirs }),
    ...(vulnerabilityDatabaseCatalog === undefined
      ? {}
      : {
          vulnerability_database: {
            catalogPath: path.relative(root, vulnerabilityDatabaseCatalog.path).split(path.sep).join("/"),
            catalogSha256: vulnerabilityDatabaseCatalog.sha256
          }
        }),
    optional_dependency_artifact_dirs: optionalDependencyArtifactDirs,
    dependency_verification_authorities: dependencyVerificationAuthorities,
    selected_task: fixtureCloudSelectedTask({
      task: consumerTask,
      sourceProjectRoot: root,
      runRoot,
      workflowPath,
      promptPath,
      workspacePath: workspaceDir,
      artifactDir,
      dependencyArtifactDirs: consumerDependencyArtifactDirs,
      referenceArtifactDirs: referenceDependencyArtifactDirs,
      executionGeneration: "base"
    }),
    resources: {
      cpu: 2,
      memory_mib: 4096,
      timeout_seconds: 60
    },
    agent_credential_env: consumerAgentCredentialEnv,
    ...(options.operatorPrompt === undefined ? {} : { operator_prompt: options.operatorPrompt })
  };
  return {
    root,
    input,
    parentCommit,
    governedCommit,
    mutableWorkflowPath,
    mutablePromptPath,
    cleanup: () => {
      makeFixtureTreeWritable(temporaryRoot);
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  };
}

function installControllerGenerationFixture(
  fixture: ReturnType<typeof createProjectFixture>,
  generationCount = 1
): { controllerGeneration: string; manifestPaths: string[] } {
  if (!Number.isSafeInteger(generationCount) || generationCount < 1) {
    throw new Error("controller generation fixture count is invalid");
  }
  const runRoot = path.join(fixture.root, fixture.input.run_root);
  const originalSnapshotRoot = path.join(fixture.root, fixture.input.execution_snapshot_root);
  const controlSeal = JSON.parse(fs.readFileSync(path.join(runRoot, "smithers", "control-integrity.json"), "utf8")) as {
    execution_files: Array<{ snapshot_path: string; sha256: string; size_bytes: number }>;
  };
  const controlGeneration = path.basename(originalSnapshotRoot);
  const workflowPath = path
    .relative(originalSnapshotRoot, path.join(fixture.root, fixture.input.workflow_path))
    .split(path.sep)
    .join("/");
  const semanticFingerprint = "3".repeat(64);
  const workflowLinkId = "00000000-0000-4000-8000-000000000001";
  const entries: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const manifestPaths: string[] = [];
  let previousControllerGeneration = controlGeneration;
  let controllerGeneration = controlGeneration;
  for (let index = 1; index <= generationCount; index += 1) {
    const refreshedWorkflow =
      index === 1 ? "export default { refreshed: true };\n" : `export default { refreshed: ${index} };\n`;
    const files = [
      {
        path: workflowPath,
        kind: "workflow" as const,
        sha256: sha256Hex(refreshedWorkflow),
        size_bytes: Buffer.byteLength(refreshedWorkflow)
      },
      ...controlSeal.execution_files.map((file) => ({
        path: file.snapshot_path,
        kind: "execution" as const,
        sha256: file.sha256,
        size_bytes: file.size_bytes
      }))
    ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    const controllerSourceDigest = sha256Hex(`controller source ${index}\n`);
    controllerGeneration = controllerGenerationDigestFixture({
      runId: "run-one",
      controlGeneration,
      controllerSourceDigest,
      semanticFingerprint,
      workflowPath,
      files
    });
    const refreshedSnapshotRoot = path.join(path.dirname(originalSnapshotRoot), controllerGeneration);
    fs.cpSync(originalSnapshotRoot, refreshedSnapshotRoot, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true
    });
    makeFixtureTreeWritable(refreshedSnapshotRoot);
    fs.writeFileSync(path.join(refreshedSnapshotRoot, workflowPath), refreshedWorkflow);
    sealFixtureSnapshot(refreshedSnapshotRoot);

    const manifest = {
      schema_version: "ultrafuzz.workflow-controller-generation.v1",
      run_id: "run-one",
      control_generation: controlGeneration,
      controller_generation: controllerGeneration,
      controller_source_digest: controllerSourceDigest,
      semantic_fingerprint: semanticFingerprint,
      workflow_path: workflowPath,
      files
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const manifestSha256 = crypto.createHash("sha256").update(manifestBytes).digest("hex");
    const manifestRelativePath = `smithers/controller-generations/${controllerGeneration}.json`;
    const manifestPath = path.join(runRoot, manifestRelativePath);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, manifestBytes);
    manifestPaths.push(manifestPath);

    const baseTimestamp = Date.parse("2026-08-22T01:59:57.000Z") + index * 3_000;
    const preparedAt = new Date(baseTimestamp).toISOString();
    const eventAt = new Date(baseTimestamp + 1_000).toISOString();
    const committedAt = new Date(baseTimestamp + 2_000).toISOString();
    const eventPayload = {
      workflow_run_id: "workflow-run-one",
      workflow_link_id: workflowLinkId,
      control_generation: controlGeneration,
      controller_generation: controllerGeneration,
      previous_controller_generation: previousControllerGeneration,
      manifest_sha256: manifestSha256,
      semantic_fingerprint: semanticFingerprint,
      sequence: index
    };
    const eventId = `evt-${crypto.createHash("sha256").update(JSON.stringify(eventPayload)).digest("hex").slice(0, 24)}`;
    events.push({
      schema_version: "ultrafuzz.event-record.v2",
      event_id: eventId,
      timestamp: eventAt,
      run_id: "run-one",
      event_type: "workflow-controller-generation-recorded",
      payload: eventPayload,
      status: "running"
    });
    entries.push({
      sequence: index,
      controller_generation: controllerGeneration,
      previous_controller_generation: previousControllerGeneration,
      manifest_path: manifestRelativePath,
      manifest_sha256: manifestSha256,
      workflow_run_id: "workflow-run-one",
      workflow_link_id: workflowLinkId,
      phase: "committed",
      prepared_at: preparedAt,
      updated_at: committedAt,
      committed_at: committedAt,
      event_id: eventId,
      event_at: eventAt
    });
    previousControllerGeneration = controllerGeneration;
  }
  fs.writeFileSync(path.join(runRoot, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  fs.writeFileSync(
    path.join(runRoot, "smithers", "controller-generation-journal.json"),
    `${JSON.stringify(
      {
        schema_version: "ultrafuzz.workflow-controller-generation-journal.v1",
        run_id: "run-one",
        control_generation: controlGeneration,
        entries
      },
      null,
      2
    )}\n`
  );

  const previousSnapshotRoot = fixture.input.execution_snapshot_root;
  fixture.input.execution_snapshot_root = `${path.posix.dirname(previousSnapshotRoot)}/${controllerGeneration}`;
  fixture.input.workflow_path = fixture.input.workflow_path.replace(
    `${previousSnapshotRoot}/`,
    `${fixture.input.execution_snapshot_root}/`
  );
  if (fixture.input.prompt_path !== undefined) {
    fixture.input.prompt_path = fixture.input.prompt_path.replace(
      `${previousSnapshotRoot}/`,
      `${fixture.input.execution_snapshot_root}/`
    );
  }
  refreshFixtureSelectedTask(fixture.input);
  return { controllerGeneration, manifestPaths };
}

function controllerGenerationDigestFixture(input: {
  runId: string;
  controlGeneration: string;
  controllerSourceDigest: string;
  semanticFingerprint: string;
  workflowPath: string;
  files: readonly { path: string; kind: "workflow" | "execution"; sha256: string; size_bytes: number }[];
}): string {
  const hash = crypto.createHash("sha256").update("ultrafuzz-controller-generation-v1\0");
  for (const value of [
    input.runId,
    input.controlGeneration,
    input.controllerSourceDigest,
    input.semanticFingerprint,
    input.workflowPath
  ]) {
    hash.update(`${Buffer.byteLength(value)}\0${value}\0`);
  }
  for (const file of input.files) {
    hash.update(`${file.kind}\0${file.path}\0${file.size_bytes}\0${file.sha256}\0`);
  }
  return hash.digest("hex");
}

function refreshDependencyVerificationAuthority(
  fixture: ReturnType<typeof createProjectFixture>,
  attemptId: string
): void {
  const markerContents = fs.readFileSync(
    path.join(fixture.root, fixture.input.run_root, ".ultrafuzz-verification", `${attemptId}.json`)
  );
  const authority = {
    attempt_id: attemptId,
    marker_sha256: sha256Hex(markerContents),
    size_bytes: markerContents.byteLength
  };
  const index = fixture.input.dependency_verification_authorities.findIndex(
    (candidate) => candidate.attempt_id === attemptId
  );
  if (index === -1) fixture.input.dependency_verification_authorities.push(authority);
  else fixture.input.dependency_verification_authorities[index] = authority;
}

function fixtureSmithersTask(input: {
  root: string;
  runRoot: string;
  attemptId: string;
  outputs: SmithersTaskManifestOutput[];
  dependencies?: string[];
  dependencySmithersNodeIds?: string[];
  dependencyArtifactDirs?: string[];
  referenceArtifactDirs?: string[];
  optionalDependencyArtifactDirs?: string[];
  referenceArtifactManifestAuthorities?: NonNullable<SmithersTaskManifestTask["referenceArtifactManifestAuthorities"]>;
  vulnerabilityDatabaseCatalog?: SmithersTaskManifestTask["vulnerabilityDatabaseCatalog"];
  sourceRevision?: string;
  sourceRef?: string;
  renderedPromptPath?: string;
  agentCredentialEnv?: string[];
  group?: string;
}): SmithersTaskManifestTask {
  const dependencies = input.dependencies ?? [];
  const dependencySmithersNodeIds =
    input.dependencySmithersNodeIds ?? dependencies.map((attemptId) => `verify:${attemptId}`);
  const workspacePath = path.join(input.root, input.runRoot, "workspaces", input.attemptId);
  const artifactDir = path.join(input.root, input.runRoot, "artifacts", input.attemptId);
  const resources = { cpu: 2, memoryMiB: 4096, timeoutSeconds: 60 };
  const agentChain = [
    {
      profileId: "fixture-model",
      agentRef: "CodexAgent",
      modelName: "gpt-fixture",
      reasoningEffort: "high",
      role: "primary" as const
    }
  ];
  return {
    attemptId: input.attemptId,
    concreteNodeId: input.attemptId,
    logicalNodeId: input.attemptId,
    preparationSmithersNodeId: `prepare:${input.attemptId}`,
    smithersNodeId: `node:${input.attemptId}`,
    verifierSmithersNodeId: `verify:${input.attemptId}`,
    agentRef: "CodexAgent",
    agentChain,
    modelName: "gpt-fixture",
    reasoningEffort: "high",
    ...(input.sourceRevision === undefined
      ? {}
      : { sourceRevision: input.sourceRevision, sourceRef: input.sourceRef! }),
    dependencies,
    dependencySmithersNodeIds,
    timeoutMs: 60_000,
    heartbeatTimeoutMs: 60_000,
    retries: 0,
    retryPolicy: { backoff: "exponential", initialDelayMs: 1_000 },
    workspacePath,
    artifactDir,
    dependencyArtifactDirs: input.dependencyArtifactDirs ?? [],
    ...(input.referenceArtifactDirs === undefined || input.referenceArtifactDirs.length === 0
      ? {}
      : { referenceArtifactDirs: input.referenceArtifactDirs }),
    ...(input.referenceArtifactManifestAuthorities === undefined ||
    input.referenceArtifactManifestAuthorities.length === 0
      ? {}
      : { referenceArtifactManifestAuthorities: input.referenceArtifactManifestAuthorities }),
    ...(input.vulnerabilityDatabaseCatalog === undefined
      ? {}
      : { vulnerabilityDatabaseCatalog: input.vulnerabilityDatabaseCatalog }),
    optionalDependencyArtifactDirs: input.optionalDependencyArtifactDirs ?? [],
    ...(input.renderedPromptPath === undefined ? {} : { renderedPromptPath: input.renderedPromptPath }),
    execution: {
      mode: "cloud",
      provider: "modal",
      resources,
      modal: {
        app: "fixture-modal-app",
        image: "fixture-modal-image",
        credentialEnv: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]
      },
      agentCredentialEnv: input.agentCredentialEnv ?? [AGENT_ENV]
    },
    metadata: {
      schemaVersion: SMITHERS_TASK_METADATA_SCHEMA_VERSION,
      run: {
        ultrafuzzRunId: "run-one",
        smithersWorkflowName: "fixture-workflow",
        graphVersion: "4",
        topologyVersion: 2
      },
      node: {
        concreteNodeId: input.attemptId,
        logicalNodeId: input.attemptId,
        attemptId: input.attemptId,
        label: input.attemptId,
        kind: "agentic",
        promptPath: `fixtures/${input.attemptId}.md`,
        ...(input.group === undefined ? {} : { group: input.group })
      },
      dependencies: {
        concreteNodeIds: dependencies,
        attemptIds: dependencies,
        smithersNodeIds: dependencySmithersNodeIds
      },
      loop: { index: 0, count: 1, mode: "parallel", attemptIndex: 0 },
      model: {
        profileId: "fixture-model",
        agentRef: "CodexAgent",
        modelName: "gpt-fixture",
        reasoningEffort: "high",
        modelIndex: 0,
        attemptIndex: 0,
        agentChain
      },
      workspace: {
        primitive: "worktree",
        path: workspacePath,
        repoPath: input.root,
        trustModel: "skip-permissions",
        ...(input.sourceRevision === undefined
          ? {}
          : { sourceRevision: input.sourceRevision, sourceRef: input.sourceRef! })
      },
      artifacts: {
        dir: artifactDir,
        outputs: input.outputs,
        manifestPath: path.join(artifactDir, "artifact-manifest.json")
      },
      retryPolicy: { maxAttempts: 1, sameAgentAttempts: 1, smithersRetries: 0 },
      timeout: { milliseconds: 60_000, seconds: 60, heartbeatTimeoutMs: 60_000 },
      execution: { mode: "cloud", provider: "modal", resources }
    }
  };
}

function fixtureCloudSelectedTask(input: {
  task: SmithersTaskManifestTask;
  sourceProjectRoot: string;
  runRoot: string;
  workflowPath: string;
  promptPath: string;
  workspacePath: string;
  artifactDir: string;
  dependencyArtifactDirs: readonly string[];
  referenceArtifactDirs: readonly string[];
  executionGeneration: string;
}): CloudSelectedTask {
  const { task } = input;
  return {
    schema_version: CLOUD_SELECTED_TASK_SCHEMA_VERSION,
    id: task.smithersNodeId,
    attemptId: task.attemptId,
    preparationId: task.preparationSmithersNodeId,
    verifierId: task.verifierSmithersNodeId,
    agentRef: task.agentRef,
    modelName: task.modelName ?? null,
    reasoningEffort: task.reasoningEffort ?? null,
    branch: `ultrafuzz/run-one/${task.attemptId}`,
    promptPath: input.promptPath,
    workspacePath: input.workspacePath,
    artifactDir: input.artifactDir,
    runRoot: input.runRoot,
    workflowPath: input.workflowPath,
    sourceProjectRoot: input.sourceProjectRoot,
    dependencyArtifactDirs: [...input.dependencyArtifactDirs],
    referenceArtifactDirs: [...input.referenceArtifactDirs],
    ...(task.vulnerabilityDatabaseCatalog === undefined
      ? {}
      : {
          vulnerabilityDatabase: {
            catalogPath: path
              .relative(input.sourceProjectRoot, task.vulnerabilityDatabaseCatalog.path)
              .split(path.sep)
              .join("/"),
            catalogSha256: task.vulnerabilityDatabaseCatalog.sha256
          }
        }),
    timeoutMs: task.timeoutMs,
    heartbeatTimeoutMs: task.heartbeatTimeoutMs,
    retries: task.retries,
    retryPolicy: {
      backoff: task.retryPolicy.backoff,
      initialDelayMs: task.retryPolicy.initialDelayMs
    },
    metadata: {
      schemaVersion: task.metadata.schemaVersion,
      run: { ...task.metadata.run },
      node: {
        concreteNodeId: task.metadata.node.concreteNodeId,
        logicalNodeId: task.metadata.node.logicalNodeId,
        attemptId: task.metadata.node.attemptId,
        label: task.metadata.node.label,
        kind: task.metadata.node.kind,
        ...(task.metadata.node.promptPath === undefined ? {} : { promptPath: task.metadata.node.promptPath }),
        ...(task.metadata.node.group === undefined ? {} : { group: task.metadata.node.group }),
        ...(task.metadata.node.producerNodeId === undefined
          ? {}
          : { producerNodeId: task.metadata.node.producerNodeId }),
        ...(task.metadata.node.storageId === undefined ? {} : { storageId: task.metadata.node.storageId }),
        ...(task.metadata.node.dynamic === undefined ? {} : { dynamic: { ...task.metadata.node.dynamic } })
      },
      dependencies: {
        concreteNodeIds: [...task.metadata.dependencies.concreteNodeIds],
        attemptIds: [...task.metadata.dependencies.attemptIds],
        smithersNodeIds: [...task.metadata.dependencies.smithersNodeIds]
      },
      loop: { ...task.metadata.loop },
      ...(task.metadata.model === undefined
        ? {}
        : {
            model: {
              profileId: task.metadata.model.profileId,
              agentRef: task.metadata.model.agentRef,
              ...(task.metadata.model.modelName === undefined ? {} : { modelName: task.metadata.model.modelName }),
              ...(task.metadata.model.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: task.metadata.model.reasoningEffort }),
              modelIndex: task.metadata.model.modelIndex,
              attemptIndex: task.metadata.model.attemptIndex,
              agentChain: task.metadata.model.agentChain.map((entry) => ({ ...entry }))
            }
          }),
      workspace: {
        primitive: task.metadata.workspace.primitive,
        path: input.workspacePath,
        trustModel: task.metadata.workspace.trustModel
      },
      artifacts: {
        dir: input.artifactDir,
        outputs: task.metadata.artifacts.outputs.map((output) => ({
          path: output.path,
          contract: output.contract,
          contractDigest: output.contractDigest,
          primary: output.primary
        })),
        manifestPath: `${input.artifactDir}/artifact-manifest.json`
      },
      retryPolicy: {
        maxAttempts: task.metadata.retryPolicy.maxAttempts,
        smithersRetries: task.metadata.retryPolicy.smithersRetries
      },
      timeout: {
        milliseconds: task.metadata.timeout.milliseconds,
        seconds: task.metadata.timeout.seconds,
        heartbeatTimeoutMs: task.metadata.timeout.heartbeatTimeoutMs
      },
      execution: {
        mode: task.metadata.execution.mode,
        ...(task.metadata.execution.provider === undefined ? {} : { provider: task.metadata.execution.provider }),
        resources: { ...task.metadata.execution.resources }
      }
    },
    execution: { mode: "cloud", generation: input.executionGeneration }
  };
}

function refreshFixtureSelectedTask(input: ModalNodeSandboxInput): void {
  if (input.selected_task === undefined) return;
  input.selected_task = {
    ...input.selected_task,
    promptPath: input.prompt_path ?? input.selected_task.promptPath,
    workflowPath: input.workflow_path,
    execution: { ...input.selected_task.execution, generation: input.execution_generation }
  };
}

function withFixtureExecutionGeneration(
  input: ModalNodeSandboxInput,
  executionGeneration: string
): ModalNodeSandboxInput {
  const updated: ModalNodeSandboxInput = { ...input, execution_generation: executionGeneration };
  if (input.selected_task !== undefined) {
    updated.selected_task = {
      ...input.selected_task,
      execution: { ...input.selected_task.execution, generation: executionGeneration }
    };
  }
  return updated;
}

function replaceFixtureControlSeal(fixture: ReturnType<typeof createProjectFixture>, contents: string): void {
  const previousRoot = fixture.input.execution_snapshot_root;
  const nextGeneration = sha256Hex(contents);
  const nextRoot = `${path.posix.dirname(previousRoot)}/${nextGeneration}`;
  fs.renameSync(path.join(fixture.root, previousRoot), path.join(fixture.root, nextRoot));
  fs.writeFileSync(path.join(fixture.root, fixture.input.run_root, "smithers", "control-integrity.json"), contents);
  fixture.input.execution_snapshot_root = nextRoot;
  fixture.input.workflow_path = fixture.input.workflow_path.replace(`${previousRoot}/`, `${nextRoot}/`);
  if (fixture.input.prompt_path !== undefined) {
    fixture.input.prompt_path = fixture.input.prompt_path.replace(`${previousRoot}/`, `${nextRoot}/`);
  }
  refreshFixtureSelectedTask(fixture.input);
}

function sealFixtureSnapshot(root: string): void {
  const directories: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    directories.push(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) fs.chmodSync(candidate, (fs.statSync(candidate).mode & 0o111) === 0 ? 0o400 : 0o500);
    }
  }
  for (const directory of directories.reverse()) fs.chmodSync(directory, 0o500);
}

function makeFixtureTreeWritable(root: string): void {
  if (!fs.existsSync(root)) return;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    fs.chmodSync(directory, 0o700);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) fs.chmodSync(candidate, 0o600);
    }
  }
}

function sha256Hex(contents: string | Buffer): string {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

/** A marker shaped like the workflow verifier's, recording one artifact digest for `finding.json`. */
function verificationMarkerFixture(findingSha256: string): string {
  return `${JSON.stringify(
    {
      schema_version: "ultrafuzz.artifact-verification.v2",
      attempt_id: "attempt-one",
      node_id: "property-lens",
      artifacts: [
        {
          path: "finding.json",
          ...currentArtifactBinding("ultrafuzz/property-lens@2"),
          sha256: findingSha256,
          primary: true
        }
      ],
      publications: [{ path: "finding.json", sha256: findingSha256 }]
    },
    null,
    2
  )}\n`;
}

function invariantProofPath(fixture: ReturnType<typeof createProjectFixture>): string {
  return path.join(fixture.root, fixture.input.run_root, "source-proofs", `${fixture.input.attempt_id}.invariant.json`);
}

function invariantProofPublicationPath(fixture: ReturnType<typeof createProjectFixture>): string {
  return path.join(
    fixture.root,
    fixture.input.run_root,
    "source-proofs",
    `${fixture.input.attempt_id}.invariant.publication.json`
  );
}

function publishResultFixture(
  fixture: ReturnType<typeof createProjectFixture>,
  input: ModalNodeSandboxInput,
  result: ReturnType<typeof createResultArchive>
) {
  const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [fakeSandbox(result)] })));
  return provider.run({
    runId: "controller-run",
    sandboxId: "node:attempt",
    input,
    rootDir: fixture.root,
    heartbeat: vi.fn()
  });
}

function createResultArchive(
  input: ModalNodeSandboxInput,
  options: {
    includeArtifactsDirectory?: boolean;
    includeDurableCheckpoint?: boolean;
    includeVerificationMarker?: boolean;
    preserveProjectArchiveSha256?: boolean;
    projectArchiveSha256?: string;
    invariantSourceProof?: string;
    verificationMarker?: string;
    workspaceGitControlFile?: string;
  } = {}
) {
  const executionSnapshotRoot = input.execution_snapshot_root;
  const projectArchiveSha256 = options.projectArchiveSha256 ?? "c".repeat(64);
  const fingerprintForProjectArchive = (sha256: string): string =>
    modalNodeDispatchFingerprint({
      ...input,
      project_archive_sha256: sha256,
      project_content_sha256: sha256
    });
  const logicalDispatchFingerprint = fingerprintForProjectArchive(projectArchiveSha256);
  let currentLogicalDispatchFingerprint = logicalDispatchFingerprint;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-result-test-"));
  const bundle = path.join(root, "bundle");
  const archive = path.join(root, "result.tgz");
  if (options.includeArtifactsDirectory !== false) {
    fs.mkdirSync(path.join(bundle, "artifacts"), { recursive: true });
  }
  fs.mkdirSync(path.join(bundle, "workspace"), { recursive: true });
  fs.mkdirSync(path.join(bundle, "source-proofs"), { recursive: true });
  if (options.includeVerificationMarker !== false) {
    fs.mkdirSync(path.join(bundle, "verification"), { recursive: true });
  }
  if (options.includeArtifactsDirectory !== false) {
    fs.writeFileSync(path.join(bundle, "artifacts", "finding.json"), '{"ok":true}\n');
  }
  fs.writeFileSync(path.join(bundle, "workspace", "work.txt"), "remote workspace\n");
  if (options.workspaceGitControlFile !== undefined) {
    fs.writeFileSync(path.join(bundle, "workspace", ".git"), options.workspaceGitControlFile);
  }
  fs.writeFileSync(
    path.join(bundle, "source-proofs", `${input.attempt_id}.invariant.json`),
    options.invariantSourceProof ?? "durable source proof\n"
  );
  fs.writeFileSync(path.join(bundle, "source-proofs", `${input.attempt_id}.json`), "pinned source proof\n");
  if (options.includeVerificationMarker !== false) {
    fs.writeFileSync(
      path.join(bundle, "verification", modalAttemptVerificationMarkerName(input.attempt_id)),
      options.verificationMarker ?? verificationMarkerFixture(sha256Hex('{"ok":true}\n'))
    );
  }
  execFileSync("tar", ["-czf", archive, "-C", bundle, "."]);
  const digest = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  const tags = modalNodeTags("controller-run", "node:attempt", input.execution_generation);
  const attemptRoot = `/data/ultrafuzz-nodes/${tags.run}/${tags.attempt}`;
  const durableCheckpoint = `${attemptRoot}/checkpoints/0003-completed.json`;
  const durableCheckpointIndex = `${attemptRoot}/checkpoints/index.json`;
  const checkpointTimes = ["2026-08-09T00:00:00.000Z", "2026-08-09T00:01:00.000Z", "2026-08-09T00:02:00.000Z"];
  const result = {
    archive,
    result: JSON.stringify({
      schema_version: "ultrafuzz.modal.node-result.v2",
      status: "succeeded",
      artifact_archive: `${attemptRoot}/artifacts.tgz`,
      artifact_sha256: digest,
      storage_lineage: `${input.run_id}/${input.attempt_id}/${input.execution_generation}`,
      logical_dispatch_fingerprint: logicalDispatchFingerprint,
      ...(options.includeDurableCheckpoint === false
        ? {}
        : {
            durable_checkpoint: durableCheckpoint,
            durable_checkpoint_index: durableCheckpointIndex
          })
    }),
    durableCheckpoint: JSON.stringify({
      schema_version: "ultrafuzz.modal.node-checkpoint.v1",
      checkpoint_id: "0003-completed",
      sequence: 3,
      stage: "completed",
      created_at: checkpointTimes[2],
      storage_lineage: `${input.run_id}/${input.attempt_id}/${input.execution_generation}`,
      logical_dispatch_fingerprint: logicalDispatchFingerprint,
      workspace_path: `${attemptRoot}/workspace`,
      run_root: input.run_root,
      execution_snapshot_root: executionSnapshotRoot,
      handoff_archive: `${attemptRoot}/input/project.tgz`,
      project_archive_sha256: projectArchiveSha256
    }),
    durableCheckpointIndex: JSON.stringify({
      schema_version: "ultrafuzz.modal.node-checkpoint-index.v1",
      storage_lineage: `${input.run_id}/${input.attempt_id}/${input.execution_generation}`,
      logical_dispatch_fingerprint: logicalDispatchFingerprint,
      workspace_path: `${attemptRoot}/workspace`,
      run_root: input.run_root,
      execution_snapshot_root: executionSnapshotRoot,
      handoff_archive: `${attemptRoot}/input/project.tgz`,
      project_archive_sha256: projectArchiveSha256,
      checkpoints: [
        {
          checkpoint_id: "0001-prepared",
          sequence: 1,
          stage: "prepared",
          created_at: checkpointTimes[0],
          manifest: `${attemptRoot}/checkpoints/0001-prepared.json`
        },
        {
          checkpoint_id: "0002-running",
          sequence: 2,
          stage: "running",
          created_at: checkpointTimes[1],
          manifest: `${attemptRoot}/checkpoints/0002-running.json`
        },
        {
          checkpoint_id: "0003-completed",
          sequence: 3,
          stage: "completed",
          created_at: checkpointTimes[2],
          manifest: durableCheckpoint
        }
      ]
    }),
    bindProjectArchiveSha256(value: string) {
      if (options.preserveProjectArchiveSha256 === true) return;
      const fingerprint = fingerprintForProjectArchive(value);
      result.result = result.result.replace(
        `"logical_dispatch_fingerprint":"${currentLogicalDispatchFingerprint}"`,
        `"logical_dispatch_fingerprint":"${fingerprint}"`
      );
      currentLogicalDispatchFingerprint = fingerprint;
      const checkpoint = JSON.parse(result.durableCheckpoint) as Record<string, unknown>;
      checkpoint.project_archive_sha256 = value;
      checkpoint.logical_dispatch_fingerprint = fingerprint;
      result.durableCheckpoint = JSON.stringify(checkpoint);
      const checkpointIndex = JSON.parse(result.durableCheckpointIndex) as Record<string, unknown>;
      checkpointIndex.project_archive_sha256 = value;
      checkpointIndex.logical_dispatch_fingerprint = fingerprint;
      result.durableCheckpointIndex = JSON.stringify(checkpointIndex);
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
  return result;
}

function fakeSandbox(result: ReturnType<typeof createResultArchive> | undefined) {
  const sandbox = {
    sandboxId: "sandbox-one",
    poll: vi.fn(async () => null),
    terminate: vi.fn(async () => undefined),
    detach: vi.fn(),
    exec: vi.fn(),
    filesystem: {
      readText: vi.fn(async (remote: string) => {
        if (result === undefined) throw new SandboxFilesystemNotFoundError("not found");
        if (remote.endsWith("/0003-completed.json")) return result.durableCheckpoint;
        if (remote.endsWith("/checkpoints/index.json")) return result.durableCheckpointIndex;
        return result.result;
      }),
      copyFromLocal: vi.fn(async () => undefined),
      copyToLocal: vi.fn(async (_remote: string, local: string) => {
        if (result === undefined) throw new Error("result is unavailable");
        fs.copyFileSync(result.archive, local);
      })
    },
    bindProjectArchiveSha256: (value: string) => result?.bindProjectArchiveSha256(value)
  } as unknown as Sandbox & {
    poll: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
    filesystem: {
      readText: ReturnType<typeof vi.fn>;
      readBytes: ReturnType<typeof vi.fn>;
      copyFromLocal: ReturnType<typeof vi.fn>;
      copyToLocal: ReturnType<typeof vi.fn>;
    };
    bindProjectArchiveSha256(value: string): void;
  };
  sandbox.filesystem.readBytes = vi.fn(async (remote: string) =>
    Buffer.from((await sandbox.filesystem.readText(remote)) as string, "utf8")
  );
  return sandbox;
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
      fromName: vi.fn(async () => ({ volumeId: "vo-node" })),
      delete: vi.fn(async () => undefined)
    },
    cpClient: {
      volumeGetOrCreate: vi.fn(async () => ({ volumeId: "vo-node", metadata: { version: 2 } }))
    },
    environmentName: vi.fn((environment?: string) => environment ?? "main"),
    secrets: {
      fromObject: vi.fn(async () => ({}))
    },
    sandboxes: {
      create: vi.fn(async () => options.created ?? fakeSandbox(undefined)),
      list: vi.fn(async function* () {
        for (const sandbox of listed) yield sandbox;
      })
    },
    bindProjectArchiveSha256(value: string) {
      const sandboxes = new Set([...listed, ...(options.created === undefined ? [] : [options.created])]);
      for (const sandbox of sandboxes) {
        const bind = (sandbox as Sandbox & { bindProjectArchiveSha256?: (digest: string) => void })
          .bindProjectArchiveSha256;
        bind?.(value);
      }
    },
    close: vi.fn()
  };
}
