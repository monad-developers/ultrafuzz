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
  parseModalNodeWorkerInput,
  probeModalCommands,
  type ModalNodeSandboxInput
} from "../src/node-provider.js";
import {
  copyAttemptVerificationMarker,
  copySafeTree,
  copyPublishedEvidenceTree,
  copyVerifiedPublishedEvidenceTree,
  initializeDurableNodeWorkspace,
  runDurableWorkflow,
  workerResultPublicationMode,
  workflowCommandArguments
} from "../src/node-worker.js";
import { extractSafeTarArchive } from "../src/safe-archive.js";

const PROVIDER_ID_ENV = "ULTRAFUZZ_TEST_PROVIDER_ID";
const PROVIDER_SECRET_ENV = "ULTRAFUZZ_TEST_PROVIDER_SECRET";
const AGENT_ENV = "ULTRAFUZZ_TEST_AGENT_KEY";

describe("Modal node sandbox provider", () => {
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

  it("allows Doctor to opt out of first-use app creation", async () => {
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

  it("rejects unsafe cloud attempt identifiers before marker paths are created", () => {
    const fixture = createProjectFixture();
    try {
      for (const attemptId of ["../attempt-one", "nested/attempt-one", ".attempt-one", "attempt one"]) {
        expect(() => parseModalNodeSandboxInput({ ...fixture.input, attempt_id: attemptId })).toThrow(
          /cloud node attempt_id is invalid/u
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
      expect(() => parseModalNodeSandboxInput(withoutCanonical)).toThrow(
        /cloud node execution_snapshot_root is invalid/u
      );
      expect(() =>
        parseModalNodeWorkerInput({ ...fixture.input, execution_snapshot_source_root: "/proc/1/fd/1" })
      ).toThrow(/worker input contains a local snapshot descriptor/u);
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
      for (const helper of ["index", "codex", "claude", "kimi", "deepseek", "environment", "toml"]) {
        expect(entries).toContain(`./${fixture.input.execution_snapshot_root}/.smithers/agents/${helper}.ts`);
      }
      expect(entries).toContain(`./${fixture.input.execution_snapshot_root}/dependencies/packages/000001/dist/cli.js`);
      expect(entries).toContain(`./${fixture.input.execution_snapshot_root}/dependencies/manifest.json`);
      expect(entries).not.toContain("./.smithers/agents/kimi.ts");
      expect(entries).not.toContain(`./${fixture.input.execution_snapshot_root}/node_modules/smithers-orchestrator`);
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

  it("archives sealed workflow, prompt, and agent bytes after mutable project controls are replaced", async () => {
    const fixture = createProjectFixture();
    fs.writeFileSync(path.join(fixture.root, fixture.mutableWorkflowPath), "hostile mutable workflow\n");
    fs.writeFileSync(path.join(fixture.root, fixture.mutablePromptPath), "hostile mutable prompt\n");
    for (const helper of ["kimi", "deepseek", "environment"]) {
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

  it("rejects symlinked dependency verification marker directories in cloud handoff archives", async () => {
    const fixture = createProjectFixture();
    try {
      const markerRoot = path.join(fixture.root, fixture.input.run_root, ".ultrafuzz-verification");
      const realMarkerRoot = path.join(fixture.root, fixture.input.run_root, "real-markers");
      fs.rmSync(markerRoot, { recursive: true, force: true });
      fs.mkdirSync(realMarkerRoot);
      fs.symlinkSync(realMarkerRoot, markerRoot, "dir");

      await expect(createModalNodeHandoffArchive(fixture.root, fixture.input)).rejects.toThrow(
        /dependency verification marker directory is not an anchored run path/u
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
        /cloud handoff file must be a regular unlinked file/u
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

  it("publishes every manifest-declared artifact and nested invariant evidence", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-worker-manifest-"));
    try {
      const source = path.join(root, "source");
      const destination = path.join(root, "published");
      const node = path.join(source, "property-specification-fanin");
      fs.mkdirSync(node, { recursive: true });
      const property = path.join(node, "properties.json");
      const generated = path.join(node, "generated-tests", "HubInvariant.t.sol");
      const nestedManifest = path.join(node, "fixtures", "artifact-manifest.json");
      const oneLevelFixtureManifest = path.join(source, "reports", "artifact-manifest.json");
      fs.mkdirSync(path.dirname(generated), { recursive: true });
      fs.mkdirSync(path.dirname(nestedManifest), { recursive: true });
      fs.mkdirSync(path.dirname(oneLevelFixtureManifest), { recursive: true });
      fs.writeFileSync(property, '{"schema_version":"ultrafuzz.properties.v1"}\n');
      fs.writeFileSync(generated, "contract HubInvariant {}\n");
      fs.writeFileSync(nestedManifest, '{"schema_version":"fixture"}\n');
      fs.writeFileSync(oneLevelFixtureManifest, '{"schema_version":"fixture"}\n');
      const manifest = {
        schema_version: "1.0",
        files: [
          manifestEntry("property-specification-fanin/properties.json", property),
          manifestEntry("property-specification-fanin/generated-tests/HubInvariant.t.sol", generated)
        ]
      };
      fs.writeFileSync(path.join(source, "artifact-manifest.json"), `${JSON.stringify(manifest)}\n`);

      copyPublishedEvidenceTree(source, destination);

      expect(fs.readFileSync(path.join(destination, "property-specification-fanin", "properties.json"), "utf8")).toBe(
        '{"schema_version":"ultrafuzz.properties.v1"}\n'
      );
      expect(
        fs.readFileSync(
          path.join(destination, "property-specification-fanin", "generated-tests", "HubInvariant.t.sol"),
          "utf8"
        )
      ).toBe("contract HubInvariant {}\n");
      expect(fs.existsSync(path.join(destination, "artifact-manifest.json"))).toBe(true);
      expect(
        fs.readFileSync(
          path.join(destination, "property-specification-fanin", "fixtures", "artifact-manifest.json"),
          "utf8"
        )
      ).toBe('{"schema_version":"fixture"}\n');
      expect(fs.readFileSync(path.join(destination, "reports", "artifact-manifest.json"), "utf8")).toBe(
        '{"schema_version":"fixture"}\n'
      );
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
          schema_version: "ultrafuzz.artifact-verification.v1",
          attempt_id: "attempt-one",
          artifacts: [],
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

  it("stages the current cloud attempt verification marker for controller publication", () => {
    const fixture = createProjectFixture();
    const destination = path.join(path.dirname(fixture.root), "verification-staging");
    try {
      fs.writeFileSync(
        path.join(fixture.root, fixture.input.run_root, ".ultrafuzz-verification", "attempt-one.json"),
        '{"attempt_id":"attempt-one"}\n'
      );
      copyAttemptVerificationMarker(fixture.root, fixture.input, destination);

      expect(fs.readFileSync(path.join(destination, "attempt-one.json"), "utf8")).toContain(
        '"attempt_id":"attempt-one"'
      );
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

  it("fails publication when a manifest declaration is missing or has a wrong digest", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-worker-manifest-invalid-"));
    try {
      const source = path.join(root, "source");
      const destination = path.join(root, "published");
      fs.mkdirSync(source, { recursive: true });
      const missing = path.join(source, "missing.json");
      fs.writeFileSync(
        path.join(source, "artifact-manifest.json"),
        `${JSON.stringify({
          schema_version: "1.0",
          files: [
            { path: "missing.json", size_bytes: 7, sha256: "0".repeat(64), provenance: { producer_node_id: "fixture" } }
          ]
        })}\n`
      );
      expect(() => copyPublishedEvidenceTree(source, destination)).toThrow(/manifest file is unavailable/u);

      fs.writeFileSync(missing, "actual\n");
      fs.writeFileSync(
        path.join(source, "artifact-manifest.json"),
        `${JSON.stringify({
          schema_version: "1.0",
          files: [{ ...manifestEntry("missing.json", missing), sha256: "0".repeat(64) }]
        })}\n`
      );
      expect(() => copyPublishedEvidenceTree(source, destination)).toThrow(/manifest file digest mismatch/u);

      fs.writeFileSync(
        path.join(source, "artifact-manifest.json"),
        `${JSON.stringify({ schema_version: "1.0", files: [] })}\n`
      );
      expect(() => copyPublishedEvidenceTree(source, destination)).toThrow(/at least one file/u);

      fs.writeFileSync(
        path.join(source, "artifact-manifest.json"),
        `${JSON.stringify({
          schema_version: "1.0",
          files: [manifestEntry("missing.json", missing), manifestEntry("missing.json", missing)]
        })}\n`
      );
      expect(() => copyPublishedEvidenceTree(source, destination)).toThrow(/duplicate file path/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
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
    } finally {
      fixture.cleanup();
    }
  });

  it("falls back to a fresh inner workflow only when no persisted run exists", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-inner-workflow-test-"));
    const logPath = path.join(root, "commands.jsonl");
    const environmentPath = path.join(root, "environment.json");
    const fixture = createProjectFixture({
      smithersCli: `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
fs.writeFileSync(${JSON.stringify(environmentPath)}, JSON.stringify({
  artifacts: process.env.ULTRAFUZZ_ARTIFACTS_MODULE,
  runtime: process.env.ULTRAFUZZ_RUNTIME_MODULE,
  config: process.env.ULTRAFUZZ_CONFIG_PATH,
  workflow: process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH
}));
if (args.includes("--resume")) { process.stderr.write("RUN_NOT_FOUND\\n"); process.exit(4); }
`
    });
    try {
      await runDurableWorkflow(fixture.root, "inner-run", fixture.input);
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
      const childVisibleRoot = `/proc/${process.pid}/fd/`;
      expect(environment.artifacts).toMatch(
        new RegExp(`^file://${childVisibleRoot}[0-9]+/modules/@ultrafuzz/artifacts/dist/index\\.js$`, "u")
      );
      expect(environment.runtime).toMatch(
        new RegExp(`^file://${childVisibleRoot}[0-9]+/modules/@ultrafuzz/runtime/dist/index\\.js$`, "u")
      );
      expect(environment.config).toMatch(new RegExp(`^${childVisibleRoot}[0-9]+/controls/ultrafuzz\\.toml$`, "u"));
      expect(environment.workflow).toMatch(
        new RegExp(`^${childVisibleRoot}[0-9]+/\\.smithers/workflows/ultrafuzz-run-one\\.tsx$`, "u")
      );
    } finally {
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
      await expect(runDurableWorkflow(fixture.root, "inner-run", fixture.input)).rejects.toThrow(
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
        "smithers-orchestrator"
      );
      expect(fs.lstatSync(smithersLink).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(smithersLink)).toBe(
        path.join(first.projectRoot, fixture.input.execution_snapshot_root, "dependencies", "packages", "000001")
      );
      first.recordCheckpoint("prepared");
      const generatedProperty = path.join(first.projectRoot, fixture.input.workspace_dir, "test", "Property.t.sol");
      fs.mkdirSync(path.dirname(generatedProperty), { recursive: true });
      fs.writeFileSync(generatedProperty, "contract Property {}\n");
      first.recordCheckpoint("failed", new Error("campaign interrupted"));

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
  });

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
      prior.recordCheckpoint("failed", new Error("reset requested"));

      fs.mkdirSync(path.join(interruptedRoot, "input"), { recursive: true });
      fs.copyFileSync(archive.path, path.join(interruptedRoot, "input", "project.tgz"));
      const interruptedInput = { ...fixture.input, execution_generation: "reset-interrupted" };
      fs.writeFileSync(path.join(interruptedRoot, "input", "request.json"), `${JSON.stringify(interruptedInput)}\n`);
      const interrupted = await initializeDurableNodeWorkspace(interruptedRoot, archive.path, interruptedInput);
      expect(
        fs.existsSync(
          path.join(interrupted.projectRoot, ".ultrafuzz", "recovered", "attempt-base", "workspace", "test")
        )
      ).toBe(true);

      const resetInput = { ...fixture.input, execution_generation: "reset-one" };
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
      const prepared = reset.recordCheckpoint("prepared");
      expect(prepared.restored_from).toBe(priorRoot);

      const secondReset = await initializeDurableNodeWorkspace(secondResetRoot, archive.path, {
        ...resetInput,
        execution_generation: "reset-two"
      });
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
  });

  it("recognizes a completed checkpoint so publication retries skip the inner workflow", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    fixture.input.project_archive_sha256 = archive.sha256;
    const volumeRoot = path.join(path.dirname(fixture.root), "modal-volume", "completed");
    try {
      const first = await initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input);
      first.recordCheckpoint("completed");
      const retry = await initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input);
      expect(retry.hasCompletedCheckpoint).toBe(true);
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

  it("publishes only old markerless completed durable handoffs with the legacy result schema", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    fixture.input.project_archive_sha256 = archive.sha256;
    const volumeRoot = path.join(path.dirname(fixture.root), "modal-volume", "legacy-completed");
    try {
      const first = await initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input);
      fs.rmSync(path.join(first.projectRoot, fixture.input.run_root, ".ultrafuzz-verification"), {
        recursive: true,
        force: true
      });
      first.recordCheckpoint("completed");

      const retry = await initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input);

      expect(retry.hasCompletedCheckpoint).toBe(true);
      expect(workerResultPublicationMode(retry.projectRoot, retry.input, retry.hasCompletedCheckpoint)).toBe(
        "legacy-markerless-v1"
      );

      const retainedWorkflow = path.join(retry.projectRoot, retry.input.workflow_path);
      fs.chmodSync(retainedWorkflow, 0o600);
      fs.writeFileSync(
        retainedWorkflow,
        'const ARTIFACT_VERIFICATION_SCHEMA_VERSION = "ultrafuzz.artifact-verification.v1";\n'
      );
      expect(workerResultPublicationMode(retry.projectRoot, retry.input, retry.hasCompletedCheckpoint)).toBe(
        "verified-v2"
      );
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("reattaches to one live attempt and atomically publishes its durable result", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive(fixture.input.execution_snapshot_root);
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
      ).toBe('{"verified":true}\n');
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("recovers a published result before starting a replacement worker", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive(fixture.input.execution_snapshot_root);
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

  it("opens the canonical sealed snapshot after an admission descriptor closes and uploads no descriptor", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive(fixture.input.execution_snapshot_root);
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
        stderr: { readText: vi.fn(async () => "") },
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

  it("accepts legacy v1 cloud results that predate verification marker archives", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive(fixture.input.execution_snapshot_root, {
      schemaVersion: "ultrafuzz.modal.node-result.v1",
      includeVerificationMarker: false
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
      ).resolves.toMatchObject({ status: "finished" });
      expect(
        fs.existsSync(path.join(fixture.root, fixture.input.run_root, ".ultrafuzz-verification", "attempt-one.json"))
      ).toBe(false);
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects v2 cloud results that omit the attempt verification marker", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive(fixture.input.execution_snapshot_root, { includeVerificationMarker: false });
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

  it("republishes over a verification marker a runtime gate refreshed to match a sanitized artifact", async () => {
    const fixture = createProjectFixture();
    const remoteMarker = verificationMarkerFixture(sha256Hex('{"ok":true}\n'));
    const result = createResultArchive(fixture.input.execution_snapshot_root, { verificationMarker: remoteMarker });
    const sandbox = fakeSandbox(result);
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [sandbox] })));
    try {
      // A prior publication of this same attempt landed the remote marker and artifact, then a
      // runtime gate sanitized the artifact and refreshed the marker digest to match it. The
      // attempt id is stable across retries, so republication must not strand the attempt.
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
    const result = createResultArchive(fixture.input.execution_snapshot_root, {
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
    const result = createResultArchive(fixture.input.execution_snapshot_root, {
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
    const result = createResultArchive(fixture.input.execution_snapshot_root);
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
      fs.writeFileSync(verificationMarker, "existing marker\n");

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
      expect(fs.readFileSync(verificationMarker, "utf8")).toBe("existing marker\n");
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects hard-linked existing verification marker destinations before mutating publications", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive(fixture.input.execution_snapshot_root);
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
      fs.writeFileSync(linkedMarker, '{"verified":true}\n');
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
      expect(fs.readFileSync(verificationMarker, "utf8")).toBe('{"verified":true}\n');
      expect(fs.readFileSync(linkedMarker, "utf8")).toBe('{"verified":true}\n');
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("rejects v2 cloud results missing artifacts before mutating workspace publications", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive(fixture.input.execution_snapshot_root, { includeArtifactsDirectory: false });
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
    const result = createResultArchive(fixture.input.execution_snapshot_root, { includeDurableCheckpoint: false });
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
    const result = createResultArchive(fixture.input.execution_snapshot_root);
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
    const result = createResultArchive(fixture.input.execution_snapshot_root);
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
    const result = createResultArchive(fixture.input.execution_snapshot_root);
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
    const result = createResultArchive(fixture.input.execution_snapshot_root);
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
    const result = createResultArchive(fixture.input.execution_snapshot_root);
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

function createProjectFixture(options: { smithersCli?: string } = {}) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-provider-test-"));
  const root = path.join(temporaryRoot, "project");
  const runRoot = ".ultrafuzz/runs/run-one";
  const artifactDir = `${runRoot}/artifacts/attempt-one`;
  const dependencyArtifactDirs = [`${runRoot}/artifacts/dependency-one`, `${runRoot}/artifacts/dependency-two`];
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
  for (const dependency of dependencyArtifactDirs) {
    fs.writeFileSync(
      path.join(markerRoot, `${path.basename(dependency)}.json`),
      `${JSON.stringify({
        schema_version: "ultrafuzz.artifact-verification.v1",
        attempt_id: path.basename(dependency),
        artifacts: [],
        publications: []
      })}\n`
    );
  }
  fs.writeFileSync(path.join(markerRoot, "unrelated.json"), "{}\n");
  fs.mkdirSync(path.join(root, runRoot, "artifacts", "unrelated"), { recursive: true });
  fs.mkdirSync(path.join(root, workspaceDir), { recursive: true });
  fs.mkdirSync(path.join(root, runRoot, "logs"), { recursive: true });
  fs.writeFileSync(path.join(root, "source.txt"), "committed source\n");
  fs.writeFileSync(path.join(root, ".smithers", "agents", "kimi.ts"), "export const mutableKimi = true;\n");
  fs.writeFileSync(path.join(root, ".smithers", "agents", "deepseek.ts"), "export const mutableDeepSeek = true;\n");
  fs.writeFileSync(path.join(root, ".smithers", "agents", "environment.ts"), "export const mutableEnv = true;\n");
  fs.writeFileSync(path.join(root, mutableWorkflowPath), "export default { mutable: true };\n");
  fs.writeFileSync(path.join(root, mutablePromptPath), "mutable rendered prompt\n");
  fs.writeFileSync(path.join(root, artifactDir, "stale.txt"), "stale\n");
  fs.writeFileSync(path.join(root, runRoot, "artifacts", "unrelated", "unrelated.txt"), "unrelated\n");
  fs.writeFileSync(path.join(root, workspaceDir, "local.txt"), "excluded\n");
  fs.writeFileSync(path.join(root, runRoot, "logs", "local.log"), "excluded\n");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Ultrafuzz Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@invalid"], { cwd: root });
  execFileSync("git", ["add", "source.txt"], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });

  const snapshotFiles = new Map<string, string>([
    [workflowRelativePath, "export default { sealed: true };\n"],
    [promptRelativePath, "sealed rendered prompt\n"],
    ["controls/ultrafuzz.toml", '[models]\ndefault = "sealed"\n'],
    [".smithers/agents/index.ts", 'export * from "./kimi.ts";\n'],
    [".smithers/agents/codex.ts", "export const sealedCodex = true;\n"],
    [".smithers/agents/claude.ts", "export const sealedClaude = true;\n"],
    [".smithers/agents/kimi.ts", "export const sealedKimi = true;\n"],
    [".smithers/agents/deepseek.ts", "export const sealedDeepSeek = true;\n"],
    [".smithers/agents/environment.ts", "export const sealedEnvironment = true;\n"],
    [".smithers/agents/toml.ts", "export const sealedToml = true;\n"],
    ["modules/@ultrafuzz/artifacts/package.json", '{"name":"@ultrafuzz/artifacts"}\n'],
    ["modules/@ultrafuzz/artifacts/dist/index.js", "export const sealedArtifacts = true;\n"],
    ["modules/@ultrafuzz/runtime/package.json", '{"name":"@ultrafuzz/runtime"}\n'],
    ["modules/@ultrafuzz/runtime/dist/index.js", "export const sealedRuntime = true;\n"],
    ["dependencies/packages/000001/package.json", '{"name":"smithers-orchestrator","version":"1.0.0"}\n'],
    ["dependencies/packages/000001/dist/cli.js", options.smithersCli ?? "#!/usr/bin/env node\n"]
  ]);
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
        name: "smithers-orchestrator",
        version: "1.0.0",
        snapshot_path: "dependencies/packages/000001"
      }
    ],
    issuers: [
      { id: "module:@ultrafuzz/artifacts", snapshot_path: "modules/@ultrafuzz/artifacts", dependencies: {} },
      { id: "module:@ultrafuzz/runtime", snapshot_path: "modules/@ultrafuzz/runtime", dependencies: {} },
      { id: "package:000001", snapshot_path: "dependencies/packages/000001", dependencies: {} },
      { id: "root", snapshot_path: ".", dependencies: { "smithers-orchestrator": "package:000001" } }
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
  const dependencyLink = path.join(pendingSnapshotRoot, "node_modules", "smithers-orchestrator");
  fs.mkdirSync(path.dirname(dependencyLink), { recursive: true });
  fs.symlinkSync("../dependencies/packages/000001", dependencyLink, "dir");

  const executionFiles = [...snapshotFiles]
    .filter(([relativePath]) => relativePath !== workflowRelativePath)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([relativePath, contents]) => ({
      source_path: path.join(root, relativePath),
      snapshot_path: relativePath,
      sha256: sha256Hex(contents),
      size_bytes: Buffer.byteLength(contents)
    }));
  const workflowContents = snapshotFiles.get(workflowRelativePath)!;
  const controlSeal = `${JSON.stringify({
    schema_version: "ultrafuzz.workflow-control-integrity.v2",
    files: {
      workflow: { sha256: sha256Hex(workflowContents), size_bytes: Buffer.byteLength(workflowContents) }
    },
    execution_files: executionFiles
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
    schema_version: "ultrafuzz.modal.node.v1",
    run_id: "run-one",
    task_id: "node:attempt-one",
    attempt_id: "attempt-one",
    execution_generation: "base",
    execution_snapshot_root: executionSnapshotRoot,
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
    mutableWorkflowPath,
    mutablePromptPath,
    cleanup: () => {
      makeFixtureTreeWritable(temporaryRoot);
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  };
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

function manifestEntry(relativePath: string, filePath: string) {
  return {
    path: relativePath,
    size_bytes: fs.statSync(filePath).size,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
    provenance: { producer_node_id: "fixture" }
  };
}

function sha256Hex(contents: string): string {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

/** A marker shaped like the workflow verifier's, recording one artifact digest for `finding.json`. */
function verificationMarkerFixture(findingSha256: string): string {
  return `${JSON.stringify(
    {
      schema_version: "ultrafuzz.artifact-verification.v1",
      attempt_id: "attempt-one",
      node_id: "property-lens",
      artifacts: [
        {
          path: "finding.json",
          contract: "ultrafuzz/property-lens@1",
          contract_digest: "b".repeat(64),
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

function createResultArchive(
  executionSnapshotRoot: string,
  options: {
    includeArtifactsDirectory?: boolean;
    includeDurableCheckpoint?: boolean;
    includeVerificationMarker?: boolean;
    verificationMarker?: string;
    schemaVersion?: "ultrafuzz.modal.node-result.v1" | "ultrafuzz.modal.node-result.v2";
  } = {}
) {
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
  fs.writeFileSync(path.join(bundle, "source-proofs", "attempt-one.invariant.json"), "durable source proof\n");
  fs.writeFileSync(path.join(bundle, "source-proofs", "attempt-one.json"), "pinned source proof\n");
  if (options.includeVerificationMarker !== false) {
    fs.writeFileSync(
      path.join(bundle, "verification", "attempt-one.json"),
      options.verificationMarker ?? '{"verified":true}\n'
    );
  }
  execFileSync("tar", ["-czf", archive, "-C", bundle, "."]);
  const digest = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  const tags = modalNodeTags("controller-run", "node:attempt");
  const attemptRoot = `/data/ultrafuzz-nodes/${tags.run}/${tags.attempt}`;
  const durableCheckpoint = `${attemptRoot}/checkpoints/0003-completed.json`;
  const durableCheckpointIndex = `${attemptRoot}/checkpoints/index.json`;
  return {
    archive,
    result: JSON.stringify({
      schema_version: options.schemaVersion ?? "ultrafuzz.modal.node-result.v2",
      status: "succeeded",
      artifact_archive: `${attemptRoot}/artifacts.tgz`,
      artifact_sha256: digest,
      storage_lineage: "run-one/attempt-one/base",
      ...(options.includeDurableCheckpoint === false
        ? {}
        : {
            durable_checkpoint: durableCheckpoint,
            durable_checkpoint_index: durableCheckpointIndex
          })
    }),
    durableCheckpoint: JSON.stringify({
      schema_version: "ultrafuzz.modal.node-checkpoint.v1",
      stage: "completed",
      storage_lineage: "run-one/attempt-one/base",
      workspace_path: `${attemptRoot}/workspace`,
      run_root: ".ultrafuzz/runs/run-one",
      execution_snapshot_root: executionSnapshotRoot,
      handoff_archive: `${attemptRoot}/input/project.tgz`
    }),
    durableCheckpointIndex: JSON.stringify({
      schema_version: "ultrafuzz.modal.node-checkpoint-index.v1",
      storage_lineage: "run-one/attempt-one/base",
      workspace_path: `${attemptRoot}/workspace`,
      run_root: ".ultrafuzz/runs/run-one",
      execution_snapshot_root: executionSnapshotRoot,
      handoff_archive: `${attemptRoot}/input/project.tgz`,
      checkpoints: [{ manifest: durableCheckpoint, stage: "completed" }]
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
    close: vi.fn()
  };
}
