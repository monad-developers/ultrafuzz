import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CLOUD_SELECTED_TASK_SCHEMA_VERSION, type CloudSelectedTask } from "@ultrafuzz/artifacts";
import { SandboxFilesystemNotFoundError, type Sandbox } from "modal";
import { describe, expect, it, vi } from "vitest";

import {
  cleanupModalNodeRun,
  createModalNodeHandoffArchive,
  createModalNodeSandboxProvider,
  ModalNodeCleanupRefusedError,
  modalNodeDispatchFingerprint,
  modalNodeHandoffContentFingerprint,
  modalNodeSandboxName,
  modalNodeTags,
  modalNodeVolumeName,
  parseModalNodeSandboxInput,
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
    // Reattachment looks a sandbox up by tag, so the logical dispatch is part of the lookup key.
    expect(modalNodeTags("run/with spaces", "node:attempt", "base", "a".repeat(64)).dispatch).toBe("a".repeat(32));
  });

  /**
   * The logical dispatch fingerprint is the identity that survives a generation reset.
   *
   * A reset deliberately re-dispatches the same logical attempt into a new sandbox, volume attempt
   * root, and storage lineage, so the generation must not change the fingerprint while every other
   * binding must. Durable resume, checkpoint records, result publication, and live reattachment all
   * compare this one value instead of each re-deriving its own field subset.
   */
  it("fingerprints the logical dispatch independently of the generation it runs under", () => {
    const fixture = createProjectFixture();
    try {
      const dispatched = parseModalNodeSandboxInput({ ...fixture.input, selected_task: fixture.selectedTask });
      const base = modalNodeDispatchFingerprint(dispatched);
      expect(base).toMatch(/^[0-9a-f]{64}$/u);

      // A generation reset keeps the logical identity, in the dispatch and inside the handoff.
      const reset = parseModalNodeSandboxInput({
        ...structuredClone(fixture.input),
        execution_generation: "reset-one",
        selected_task: {
          ...structuredClone(fixture.selectedTask),
          execution: { ...fixture.selectedTask.execution, generation: "reset-one" }
        }
      });
      expect(modalNodeDispatchFingerprint(reset)).toBe(base);

      // A rebuilt archive of identical inputs has a different tar digest; that is bound separately.
      expect(modalNodeDispatchFingerprint({ ...dispatched, project_archive_sha256: "b".repeat(64) })).toBe(base);

      // Key ordering is not identity.
      const reordered = parseModalNodeSandboxInput(
        JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(structuredClone(dispatched)).reverse()))) as unknown
      );
      expect(modalNodeDispatchFingerprint(reordered)).toBe(base);

      // Every other binding is provenance for whatever the durable workspace publishes.
      const divergences: Array<[string, Partial<ModalNodeSandboxInput>]> = [
        ["task_id", { task_id: "node:someone-else" }],
        ["attempt_id", { attempt_id: "someone-else" }],
        ["run_id", { run_id: "another-run" }],
        ["workflow_path", { workflow_path: ".smithers/workflows/other.tsx" }],
        ["prompt_path", { prompt_path: `${fixture.input.run_root}/prompts/other.md` }],
        ["dependency_artifact_dirs", { dependency_artifact_dirs: [fixture.input.dependency_artifact_dirs[0]!] }],
        ["reference_artifact_dirs", { reference_artifact_dirs: [`${fixture.input.run_root}/artifacts/reference`] }],
        ["resources", { resources: { ...fixture.input.resources, cpu: 8 } }],
        ["project_content_sha256", { project_content_sha256: "c".repeat(64) }],
        ["agent_credential_env", { agent_credential_env: [...fixture.input.agent_credential_env, "EXTRA_KEY"] }],
        ["operator_prompt", { operator_prompt: "smuggled operator note" }],
        // Including the handoff DTO, so a substituted selected task is a different logical dispatch.
        ["selected_task", { selected_task: { ...fixture.selectedTask, agentRef: "SomeOtherAgent" } }]
      ];
      for (const [label, override] of divergences) {
        expect(modalNodeDispatchFingerprint({ ...dispatched, ...override }), label).not.toBe(base);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses a published result whose durable provenance names another logical dispatch", async () => {
    const fixture = createProjectFixture();
    const foreign = createResultArchive(fixture.input, { logicalDispatchFingerprint: "f".repeat(64) });
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [fakeSandbox(foreign)] })));
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
      // Nothing from the foreign bundle reached the controller's artifact directory.
      expect(fs.existsSync(path.join(fixture.root, fixture.input.artifact_dir, "finding.json"))).toBe(false);
    } finally {
      foreign.cleanup();
      fixture.cleanup();
    }
  });

  it("refuses a durable checkpoint whose record names another logical dispatch", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive(fixture.input);
    const tampered = {
      ...result,
      durableCheckpoint: JSON.stringify({
        ...(JSON.parse(result.durableCheckpoint) as Record<string, unknown>),
        logical_dispatch_fingerprint: "e".repeat(64)
      })
    };
    const provider = createModalNodeSandboxProvider(providerOptions(fakeClient({ listed: [fakeSandbox(tampered)] })));
    try {
      await expect(
        provider.run({
          runId: "controller-run",
          sandboxId: "node:attempt",
          input: fixture.input,
          rootDir: fixture.root,
          heartbeat: vi.fn()
        })
      ).rejects.toThrow(/cloud node durable checkpoint is invalid/u);
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("refuses to resume a durable workspace whose persisted request is another logical dispatch", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    fixture.input.project_archive_sha256 = archive.sha256;
    const volumeRoot = path.join(path.dirname(fixture.root), "modal-volume", "fingerprint");
    try {
      await initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input);
      // Same run, attempt, and generation, but a different logical dispatch: the workspace is not it.
      const substituted = parseModalNodeSandboxInput({
        ...structuredClone(fixture.input),
        operator_prompt: "smuggled operator note"
      });
      await expect(initializeDurableNodeWorkspace(volumeRoot, archive.path, substituted)).rejects.toThrow(
        /durable workspace request does not match this cloud node attempt/u
      );
      // The unchanged dispatch still resumes, so the rejection above is not vacuous.
      await expect(initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input)).resolves.toMatchObject({
        hasCompletedCheckpoint: false
      });
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("migrates a fingerprint-less v1 index only for the exact same-generation durable request", async () => {
    const fixture = createProjectFixture();
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    fixture.input.project_archive_sha256 = archive.sha256;
    const volumeRoot = path.join(path.dirname(fixture.root), "modal-volume", "legacy-index");
    try {
      const initial = await initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input);
      initial.recordCheckpoint("prepared");
      const indexPath = path.join(volumeRoot, "checkpoints", "index.json");
      const legacy = JSON.parse(fs.readFileSync(indexPath, "utf8")) as Record<string, unknown>;
      delete legacy.logical_dispatch_fingerprint;
      fs.writeFileSync(indexPath, `${JSON.stringify(legacy)}\n`);
      const requestPath = path.join(volumeRoot, "input", "request.json");
      const legacyRequest = JSON.parse(fs.readFileSync(requestPath, "utf8")) as Record<string, unknown>;
      delete legacyRequest.project_content_sha256;
      fs.writeFileSync(requestPath, `${JSON.stringify(legacyRequest)}\n`);
      // Durable execution may legitimately mutate its extracted workspace. Migration derives the
      // original semantic identity from the separately digest-protected handoff archive, not this
      // live tree.
      fs.writeFileSync(path.join(initial.projectRoot, fixture.input.prompt_path), "runtime-mutated prompt\n");

      await expect(initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input)).resolves.toMatchObject({
        hasCompletedCheckpoint: false
      });
      expect(
        (JSON.parse(fs.readFileSync(indexPath, "utf8")) as Record<string, unknown>).logical_dispatch_fingerprint
      ).toBe(modalNodeDispatchFingerprint(fixture.input));
      expect((JSON.parse(fs.readFileSync(requestPath, "utf8")) as Record<string, unknown>).project_content_sha256).toBe(
        fixture.input.project_content_sha256
      );

      const mismatched = JSON.parse(fs.readFileSync(indexPath, "utf8")) as Record<string, unknown>;
      mismatched.logical_dispatch_fingerprint = "d".repeat(64);
      fs.writeFileSync(indexPath, `${JSON.stringify(mismatched)}\n`);
      await expect(initializeDurableNodeWorkspace(volumeRoot, archive.path, fixture.input)).rejects.toThrow(
        /durable checkpoint index is invalid/u
      );
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
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

  it("creates an immutable handoff from committed source plus only declared dependency evidence", async () => {
    const fixture = createProjectFixture();
    fs.writeFileSync(path.join(fixture.root, "local-only-secret"), "must stay local\n");
    // Source directory permissions are normalized in the private archive and are not semantic input.
    fs.chmodSync(path.join(fixture.root, fixture.input.dependency_artifact_dirs[0]!), 0o755);
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    try {
      const entries = execFileSync("tar", ["-tzf", archive.path], { encoding: "utf8" });
      expect(entries).toContain("./source.txt");
      expect(entries).toContain(`./${fixture.input.workflow_path}`);
      expect(entries).toContain(`./${fixture.input.prompt_path}`);
      expect(entries).toContain("./.smithers/agents/kimi.ts");
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

  it("fingerprints equivalent handoff contents deterministically and detects changed prompt bytes", async () => {
    const fixture = createProjectFixture();
    const first = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    const second = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    const extractedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-node-content-test-"));
    const extracted = path.join(extractedRoot, "project");
    fs.mkdirSync(extracted);
    let changed: Awaited<ReturnType<typeof createModalNodeHandoffArchive>> | undefined;
    try {
      expect(second.contentSha256).toBe(first.contentSha256);
      await extractSafeTarArchive(first.path, extracted, { gzip: true, label: "cloud handoff test" });
      expect(modalNodeHandoffContentFingerprint(extracted, fixture.input, { materialized: true })).toBe(
        first.contentSha256
      );
      const schemas = path.join(extracted, ".ultrafuzz", "schemas");
      const generatedSchema = path.join(schemas, fs.readdirSync(schemas).sort()[0]!);
      fs.chmodSync(schemas, 0o700);
      fs.chmodSync(generatedSchema, 0o600);
      fs.appendFileSync(generatedSchema, "\n");
      expect(modalNodeHandoffContentFingerprint(extracted, fixture.input, { materialized: true })).not.toBe(
        first.contentSha256
      );
      fs.writeFileSync(path.join(fixture.root, fixture.input.prompt_path), "different rendered prompt\n");
      const changedInput = { ...fixture.input, project_content_sha256: undefined };
      changed = await createModalNodeHandoffArchive(fixture.root, changedInput);
      expect(changed.contentSha256).not.toBe(first.contentSha256);
      expect(modalNodeDispatchFingerprint(changedInput)).not.toBe(modalNodeDispatchFingerprint(fixture.input));
    } finally {
      changed?.cleanup();
      const schemas = path.join(extracted, ".ultrafuzz", "schemas");
      if (fs.existsSync(schemas)) fs.chmodSync(schemas, 0o700);
      fs.rmSync(extractedRoot, { recursive: true, force: true });
      second.cleanup();
      first.cleanup();
      fixture.cleanup();
    }
  });

  it("hands a relocated worker the reference artifact tree and the digest-bound planner catalog", async () => {
    const fixture = createProjectFixture();
    const referenceDir = `${fixture.input.run_root}/artifacts/reference-vulnerability-database`;
    const catalogRelativePath = `${fixture.input.run_root}/vulnerability-db/catalog.json`;
    const catalogBytes = '{"schema_version":"ultrafuzz.vulnerability-db.planner-catalog.v1"}\n';
    const recordRelativePath = `${referenceDir}/vulnerability-db/classes/oracle/stale-price.md`;
    fs.mkdirSync(path.join(fixture.root, path.dirname(recordRelativePath)), { recursive: true });
    fs.mkdirSync(path.join(fixture.root, referenceDir, "references"), { recursive: true });
    fs.writeFileSync(path.join(fixture.root, recordRelativePath), "# stale price\n");
    fs.writeFileSync(path.join(fixture.root, referenceDir, "vulnerability-db", "catalog.json"), catalogBytes);
    fs.writeFileSync(path.join(fixture.root, referenceDir, "references", "manifest.json"), "{}\n");
    fs.mkdirSync(path.dirname(path.join(fixture.root, catalogRelativePath)), { recursive: true });
    fs.writeFileSync(path.join(fixture.root, catalogRelativePath), catalogBytes);
    // Both compiled database-consuming attempts declare the same two cloud inputs.
    const inputs: ModalNodeSandboxInput[] = ["node:threat-model", "node:goal-plan"].map((taskId) => ({
      ...fixture.input,
      task_id: taskId,
      reference_artifact_dirs: [referenceDir],
      vulnerability_database: {
        catalogPath: catalogRelativePath,
        catalogSha256: crypto.createHash("sha256").update(catalogBytes).digest("hex")
      }
    }));

    for (const input of inputs) {
      const archive = await createModalNodeHandoffArchive(fixture.root, input);
      const worker = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-relocated-worker-"));
      try {
        await extractSafeTarArchive(archive.path, worker, { gzip: true, label: "relocated worker" });
        // The worker sees both trees at the same project-relative locations, byte for byte.
        expect(fs.readFileSync(path.join(worker, catalogRelativePath), "utf8")).toBe(catalogBytes);
        expect(fs.readFileSync(path.join(worker, referenceDir, "vulnerability-db", "catalog.json"), "utf8")).toBe(
          catalogBytes
        );
        expect(fs.readFileSync(path.join(worker, recordRelativePath), "utf8")).toBe("# stale price\n");
        expect(fs.existsSync(path.join(worker, referenceDir, "references", "manifest.json"))).toBe(true);
        // Controller-owned global state is never shipped.
        expect(fs.existsSync(path.join(worker, fixture.input.run_root, "graph.json"))).toBe(false);
        expect(fs.existsSync(path.join(worker, fixture.input.run_root, "smithers", "tasks.json"))).toBe(false);
      } finally {
        fs.rmSync(worker, { recursive: true, force: true });
        archive.cleanup();
      }
    }

    // The catalog is bound to its declared digest, so a tampered run root cannot reach a worker.
    fs.writeFileSync(path.join(fixture.root, catalogRelativePath), '{"schema_version":"tampered"}\n');
    for (const input of inputs) {
      await expect(
        createModalNodeHandoffArchive(fixture.root, { ...input, project_content_sha256: undefined })
      ).rejects.toThrow(/does not match its declared cloud-input digest/u);
    }
    fixture.cleanup();
  });

  it("publishes the prompt-referenced canonical artifact schemas to the worker", async () => {
    const fixture = createProjectFixture();
    fs.mkdirSync(path.join(fixture.root, ".ultrafuzz", "schema"), { recursive: true });
    for (const name of ["threat-model", "goal-plan"]) {
      fs.writeFileSync(path.join(fixture.root, ".ultrafuzz", "schema", `${name}.schema.json`), `{"title":"${name}"}\n`);
    }
    const archive = await createModalNodeHandoffArchive(fixture.root, fixture.input);
    const worker = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-relocated-worker-"));
    try {
      await extractSafeTarArchive(archive.path, worker, { gzip: true, label: "relocated worker" });
      for (const name of ["threat-model", "goal-plan"]) {
        expect(fs.readFileSync(path.join(worker, ".ultrafuzz", "schema", `${name}.schema.json`), "utf8")).toBe(
          `{"title":"${name}"}\n`
        );
      }
    } finally {
      fs.rmSync(worker, { recursive: true, force: true });
      archive.cleanup();
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

  it("accepts only a complete selected-task handoff that agrees with its dispatch", () => {
    const fixture = createProjectFixture();
    try {
      const input = { ...fixture.input, selected_task: fixture.selectedTask };
      expect(() => parseModalNodeSandboxInput(input)).not.toThrow();
      // A partial stub is not a handoff: the contract is exact, so the omitted fields are rejected.
      expect(() =>
        parseModalNodeSandboxInput({
          ...fixture.input,
          selected_task: {
            schema_version: CLOUD_SELECTED_TASK_SCHEMA_VERSION,
            id: fixture.input.task_id,
            attemptId: fixture.input.attempt_id
          }
        })
      ).toThrow(/selected task handoff is invalid/u);
      expect(() => parseModalNodeSandboxInput({ ...fixture.input, selected_task: undefined })).toThrow(
        /selected task handoff is required/u
      );
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    // 1. Every top-level identity field missing, malformed, or mismatched.
    ["schema version absent", "schema_version", ABSENT],
    ["schema version downgraded", "schema_version", "ultrafuzz.cloud-selected-task.v0"],
    ["task id absent", "id", ABSENT],
    ["task id malformed", "id", "../evil"],
    ["task id mismatched", "id", "node:someone-else"],
    ["attempt id absent", "attemptId", ABSENT],
    ["attempt id malformed", "attemptId", 42],
    ["attempt id mismatched", "attemptId", "someone-else"],
    ["preparation id absent", "preparationId", ABSENT],
    ["preparation id malformed", "preparationId", "prepare:../evil"],
    ["verifier id absent", "verifierId", ABSENT],
    ["agent ref absent", "agentRef", ABSENT],
    ["agent ref malformed", "agentRef", "../evil"],
    ["branch absent", "branch", ABSENT],
    ["branch traversal", "branch", "ultrafuzz/../../escape"],
    ["metadata run id mismatched", "metadata.run.ultrafuzzRunId", "another-run"],
    ["metadata attempt id mismatched", "metadata.node.attemptId", "someone-else"],
    // 2. Every path-bearing field with traversal, sibling-prefix escapes, and absolute paths.
    ["prompt path absent", "promptPath", ABSENT],
    ["prompt path traversal", "promptPath", "../escape.md"],
    ["prompt path absolute", "promptPath", "/etc/passwd"],
    ["prompt path non-canonical", "promptPath", ".ultrafuzz/runs/run-one/./prompts/attempt-one.md"],
    ["prompt path sibling-prefix escape", "promptPath", ".ultrafuzz/runs/run-one-evil/prompts/attempt-one.md"],
    ["prompt path disagreeing", "promptPath", ".ultrafuzz/runs/run-one/prompts/other.md"],
    ["workspace path outside the run root", "workspacePath", ".smithers/agents"],
    ["workspace path disagreeing", "workspacePath", ".ultrafuzz/runs/run-one/workspaces/other"],
    ["artifact dir traversal", "artifactDir", ".ultrafuzz/runs/run-one/artifacts/../../escape"],
    ["artifact dir disagreeing", "artifactDir", ".ultrafuzz/runs/run-one/artifacts/other"],
    ["run root absolute", "runRoot", "/etc"],
    ["run root disagreeing", "runRoot", ".ultrafuzz/runs/other"],
    ["workflow path traversal", "workflowPath", "../escape.tsx"],
    ["workflow path disagreeing", "workflowPath", ".smithers/workflows/other.tsx"],
    ["source project root relative", "sourceProjectRoot", "controller/project"],
    ["source project root traversal", "sourceProjectRoot", "/controller/project/../escape"],
    // 3. Dependency and reference artifact arrays.
    ["dependency dirs absent", "dependencyArtifactDirs", ABSENT],
    ["dependency dirs not an array", "dependencyArtifactDirs", "not-an-array"],
    ["dependency dirs element shape", "dependencyArtifactDirs", [{ path: "a" }]],
    ["dependency dirs element traversal", "dependencyArtifactDirs", ["../escape"]],
    ["dependency dirs element absolute", "dependencyArtifactDirs", ["/etc"]],
    ["dependency dirs disagreeing", "dependencyArtifactDirs", [".ultrafuzz/runs/run-one/artifacts/dependency-one"]],
    ["reference dirs not an array", "referenceArtifactDirs", 7],
    ["reference dirs element traversal", "referenceArtifactDirs", [".ultrafuzz/runs/run-one/../escape"]],
    ["reference dirs disagreeing", "referenceArtifactDirs", [".ultrafuzz/runs/run-one/artifacts/reference-one"]],
    // 4. Vulnerability database path and digest.
    ["database absent", "vulnerabilityDatabase", { catalogSha256: "a".repeat(64) }],
    ["database digest malformed", "vulnerabilityDatabase", { catalogPath: "a/b.json", catalogSha256: "nope" }],
    [
      "database path traversal",
      "vulnerabilityDatabase",
      { catalogPath: "../catalog.json", catalogSha256: "a".repeat(64) }
    ],
    [
      "database nested unknown field",
      "vulnerabilityDatabase",
      { catalogPath: ".ultrafuzz/runs/run-one/c.json", catalogSha256: "a".repeat(64), mirror: "/tmp/evil" }
    ],
    // 5. Nested outputs, metadata, and execution unknown keys and invalid values.
    ["outputs nested unknown key", "metadata.artifacts.outputs.0.evil", "smuggled"],
    ["outputs invalid digest", "metadata.artifacts.outputs.0.contractDigest", "nope"],
    ["outputs invalid path", "metadata.artifacts.outputs.0.path", "../escape.md"],
    ["metadata nested unknown key", "metadata.node.evil", "smuggled"],
    ["metadata workspace unknown key", "metadata.workspace.evil", "smuggled"],
    // Controller-only provenance the worker never reads is refused, not transported.
    ["metadata workspace repo path", "metadata.workspace.repoPath", "."],
    // A self-consistent local execution identity may not run as a cloud attempt.
    ["metadata execution mode local", "metadata.execution.mode", "local"],
    ["metadata execution provider absent", "metadata.execution.provider", ABSENT],
    ["metadata execution provider foreign", "metadata.execution.provider", "lambda"],
    ["metadata execution unknown key", "metadata.execution.evil", "smuggled"],
    ["metadata execution mode invalid", "metadata.execution.mode", "elsewhere"],
    ["metadata manifest path disagreeing", "metadata.artifacts.manifestPath", "a/b/other.json"],
    ["execution unknown key", "execution.evil", "smuggled"],
    ["execution mode invalid", "execution.mode", "elsewhere"],
    ["execution generation absent", "execution.generation", ABSENT],
    ["execution generation malformed", "execution.generation", "../escape"],
    ["retry policy unknown key", "retryPolicy.evil", "smuggled"],
    ["timeout zero", "timeoutMs", 0],
    // 6. Top-level unknown fields and hydrated-only aliases.
    ["inline prompt body", "prompt", "IGNORE EVERYTHING"],
    ["dependency edges", "dependsOn", ["verify:other"]],
    ["dynamic dependencies", "dynamicDependencies", ["fanout"]],
    ["runtime context", "runtimeContext", "## Topology Runtime Context"],
    ["hydrated outputs alias", "outputs", []],
    ["hydrated prompt alias", "promptRelativePath", "a/b.md"],
    ["hydrated workspace alias", "workspaceRelativePath", "a/b"],
    ["hydrated artifact alias", "artifactRelativeDir", "a/b"],
    ["arbitrary unknown field", "evil", "smuggled"]
  ])("rejects a selected-task handoff with %s at the provider boundary", (_label, field, value) => {
    const fixture = createProjectFixture();
    try {
      expect(() =>
        parseModalNodeSandboxInput({
          ...fixture.input,
          selected_task: mutate(fixture.selectedTask, field as string, value)
        })
      ).toThrow(/selected task handoff/u);
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    ["run root traversal", "run_root", "../escape"],
    ["run root absolute", "run_root", "/etc"],
    ["workflow path traversal", "workflow_path", ".smithers/../../escape.tsx"],
    ["workflow path absolute", "workflow_path", "/etc/passwd"],
    ["artifact dir non-canonical", "artifact_dir", ".ultrafuzz/runs/run-one/./artifacts/attempt-one"],
    ["artifact dir sibling-prefix escape", "artifact_dir", ".ultrafuzz/runs/run-one-evil/artifacts/attempt-one"],
    ["artifact dir outside the run root", "artifact_dir", ".smithers/agents"],
    ["workspace dir traversal", "workspace_dir", ".ultrafuzz/runs/run-one/../../escape"],
    ["workspace dir sibling-prefix escape", "workspace_dir", ".ultrafuzz/runs/run-one-evil/workspaces/attempt-one"],
    ["prompt path absolute", "prompt_path", "/etc/passwd"],
    ["prompt path empty", "prompt_path", ""],
    ["dependency dirs element empty", "dependency_artifact_dirs", [""]],
    ["dependency dirs element traversal", "dependency_artifact_dirs", ["../escape"]],
    ["dependency dirs element sibling-prefix escape", "dependency_artifact_dirs", [".ultrafuzz/runs/run-one-evil/a"]],
    ["reference dirs element empty", "reference_artifact_dirs", [""]],
    ["reference dirs element absolute", "reference_artifact_dirs", ["/etc"]],
    ["database catalog empty", "vulnerability_database", { catalogPath: "", catalogSha256: "a".repeat(64) }],
    [
      "database catalog traversal",
      "vulnerability_database",
      { catalogPath: "../catalog.json", catalogSha256: "a".repeat(64) }
    ],
    [
      "database catalog outside the run root",
      "vulnerability_database",
      { catalogPath: ".smithers/catalog.json", catalogSha256: "a".repeat(64) }
    ],
    [
      "database nested unknown key",
      "vulnerability_database",
      { catalogPath: ".ultrafuzz/runs/run-one/c.json", catalogSha256: "a".repeat(64), mirror: "/tmp/evil" }
    ]
  ])("rejects a cloud node input whose %s is unsafe", (_label, field, value) => {
    const fixture = createProjectFixture();
    try {
      expect(() => parseModalNodeSandboxInput({ ...fixture.input, [field as string]: value })).toThrow(/cloud node/u);
    } finally {
      fixture.cleanup();
    }
  });

  /**
   * The whole outer dispatch contract is exact.
   *
   * A dispatch is an untrusted document at the provider boundary, so an unknown top-level key, a
   * camelCase or hydrated-only alias, and an unknown key inside `resources` are all refused rather
   * than carried into the archive, the request file, and the relocated worker.
   */
  it.each([
    ["unknown top-level key", "evil", "smuggled"],
    ["hydrated selected-task alias", "selectedTask", { id: "node:attempt-one" }],
    ["camelCase run alias", "runId", "run-one"],
    ["camelCase resource alias", "executionGeneration", "base"],
    ["controller-only project root", "source_project_root", "/controller/project"],
    ["smuggled operator input", "operator_input", { issue: 2 }],
    ["unknown nested resources key", "resources", { cpu: 2, memory_mib: 4096, timeout_seconds: 60, gpu: "a100" }],
    ["aliased nested resources key", "resources", { cpu: 2, memoryMiB: 4096, timeout_seconds: 60 }]
  ])("rejects a cloud node dispatch carrying an %s", (_label, field, value) => {
    const fixture = createProjectFixture();
    try {
      expect(() =>
        parseModalNodeSandboxInput({
          ...fixture.input,
          selected_task: fixture.selectedTask,
          [field as string]: value
        })
      ).toThrow(/cloud node (input has unsupported keys|resources are invalid)/u);
    } finally {
      fixture.cleanup();
    }
  });

  it("requires the selected prompt path while retaining unrelated optional dispatch fields", () => {
    const fixture = createProjectFixture();
    try {
      const { prompt_path: _promptPath, ...withoutPrompt } = fixture.input;
      expect(() => parseModalNodeSandboxInput(withoutPrompt)).toThrow(/cloud node prompt_path is invalid/u);
      expect(() =>
        parseModalNodeSandboxInput({
          ...fixture.input,
          reference_artifact_dirs: [],
          project_archive_sha256: "a".repeat(64),
          operator_prompt: "operator note"
        })
      ).not.toThrow();
    } finally {
      fixture.cleanup();
    }
  });

  /**
   * A local execution identity can never be dispatched as a cloud attempt.
   *
   * A runtime-generated attempt has no compiled canonical peer, so a handoff that agrees with itself
   * about running locally would otherwise be accepted by the provider and archived for a cloud run.
   */
  it("refuses a self-consistent local execution identity at the provider boundary", () => {
    const fixture = createProjectFixture();
    try {
      const local = mutate(mutate(fixture.selectedTask, "execution.mode", "local"), "metadata.execution.mode", "local");
      expect(() => parseModalNodeSandboxInput({ ...fixture.input, selected_task: local })).toThrow(
        /execution mode local is not the dispatched cloud execution identity/u
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses a selected task from a different execution generation at the provider boundary", () => {
    const fixture = createProjectFixture();
    try {
      const wrongGeneration = mutate(fixture.selectedTask, "execution.generation", "reset-one");
      expect(() => parseModalNodeSandboxInput({ ...fixture.input, selected_task: wrongGeneration })).toThrow(
        /execution\.generation reset-one is not the dispatched base generation/u
      );
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    [
      "unknown outer key",
      (fixture: ReturnType<typeof createProjectFixture>) => ({
        ...fixture.input,
        selected_task: fixture.selectedTask,
        evil: "smuggled"
      }),
      /cloud node input has unsupported keys: evil/u
    ],
    [
      "hydrated selected-task alias",
      (fixture: ReturnType<typeof createProjectFixture>) => ({
        ...fixture.input,
        selected_task: fixture.selectedTask,
        selectedTask: fixture.selectedTask
      }),
      /cloud node input has unsupported keys: selectedTask/u
    ],
    [
      "unknown nested resources key",
      (fixture: ReturnType<typeof createProjectFixture>) => ({
        ...fixture.input,
        selected_task: fixture.selectedTask,
        resources: { ...fixture.input.resources, gpu: "a100" }
      }),
      /cloud node resources are invalid/u
    ],
    [
      "local selected-task execution identity",
      (fixture: ReturnType<typeof createProjectFixture>) => ({
        ...fixture.input,
        selected_task: mutate(
          mutate(fixture.selectedTask, "execution.mode", "local"),
          "metadata.execution.mode",
          "local"
        )
      }),
      /execution mode local is not the dispatched cloud execution identity/u
    ],
    [
      "different selected-task execution generation",
      (fixture: ReturnType<typeof createProjectFixture>) => ({
        ...fixture.input,
        selected_task: mutate(fixture.selectedTask, "execution.generation", "reset-one")
      }),
      /execution\.generation reset-one is not the dispatched base generation/u
    ],
    [
      "selected-task source project mismatch",
      (fixture: ReturnType<typeof createProjectFixture>) => ({
        ...fixture.input,
        selected_task: mutate(fixture.selectedTask, "sourceProjectRoot", "/controller/other-project")
      }),
      /source project root does not match the archived project root/u
    ]
  ])(
    "refuses an invalid dispatch with %s before any archive, credential, or sandbox work",
    async (_label, input, error) => {
      const fixture = createProjectFixture();
      const client = fakeClient({});
      const provider = createModalNodeSandboxProvider(providerOptions(client));
      const heartbeat = vi.fn();
      const handoffDirectories = (): string[] =>
        fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith("ultrafuzz-node-handoff-"));
      const before = new Set(handoffDirectories());
      try {
        await expect(
          provider.run({
            runId: "controller-run",
            sandboxId: "node:attempt",
            input: input(fixture),
            rootDir: fixture.root,
            heartbeat
          })
        ).rejects.toThrow(error);
        // Nothing was archived, no credentials were read, and no sandbox was created or listed.
        expect(client.apps.fromName).not.toHaveBeenCalled();
        expect(client.volumes.fromName).not.toHaveBeenCalled();
        expect(client.sandboxes.create).not.toHaveBeenCalled();
        expect(client.sandboxes.list).not.toHaveBeenCalled();
        expect(client.secrets.fromObject).not.toHaveBeenCalled();
        expect(heartbeat).not.toHaveBeenCalled();
        expect(handoffDirectories().filter((entry) => !before.has(entry))).toEqual([]);
      } finally {
        fixture.cleanup();
      }
    }
  );

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

  it("binds selected-task relocation to the exact project being archived", async () => {
    const fixture = createProjectFixture();
    try {
      const selectedTask = mutate(fixture.selectedTask, "sourceProjectRoot", "/controller/other-project");
      const input = parseModalNodeSandboxInput({ ...fixture.input, selected_task: selectedTask });
      await expect(createModalNodeHandoffArchive(fixture.root, input)).rejects.toThrow(
        /source project root does not match the archived project root/u
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

  it("forwards the controller-materialized selected task and attempt identity to the inner workflow", () => {
    const fixture = createProjectFixture();
    try {
      const selectedTask = fixture.selectedTask;
      const args = workflowCommandArguments(
        "/volume/workflow.tsx",
        "/volume/workspace",
        "inner-run",
        { ...fixture.input, selected_task: selectedTask },
        true
      );
      const inner = JSON.parse(args[args.indexOf("--input") + 1]!) as Record<string, unknown>;
      // Without this the worker never receives the handoff and every dynamic or deferred task
      // fails: the worker must not rematerialize controller-owned global state to recover it.
      expect(inner.cloud_worker).toBe(true);
      expect(inner.task_id).toBe(fixture.input.task_id);
      expect(inner.attempt_id).toBe(fixture.input.attempt_id);
      expect(inner.selected_task).toEqual(selectedTask);
      // The relocated worker cannot rederive the generation it publishes under, so it is forwarded.
      expect(inner.execution_generation).toBe(fixture.input.execution_generation);

      expect(() => parseModalNodeSandboxInput({ ...fixture.input, selected_task: undefined })).toThrow(
        /selected task handoff is required/u
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("falls back to a fresh inner workflow only when no persisted run exists", async () => {
    const fixture = createProjectFixture();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-inner-workflow-test-"));
    const logPath = path.join(root, "commands.jsonl");
    const fakeSmithers = path.join(root, "smithers.mjs");
    fs.writeFileSync(
      fakeSmithers,
      `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args.includes("--resume")) { process.stderr.write("RUN_NOT_FOUND\\n"); process.exit(4); }
`
    );
    fs.chmodSync(fakeSmithers, 0o700);
    try {
      await runDurableWorkflow(fakeSmithers, "/volume/workflow.tsx", fixture.root, "inner-run", fixture.input);
      const commands = fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(commands).toHaveLength(2);
      expect(commands[0]).toEqual(expect.arrayContaining(["--resume", "--force", "--run-id", "inner-run"]));
      expect(commands[1]).toEqual(expect.arrayContaining(["--run-id", "inner-run"]));
      expect(commands[1]).not.toContain("--resume");
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

  it("refuses to resume durable state under changed catalog, references, or selected-task provenance", async () => {
    const fixture = createProjectFixture();
    const referenceDir = `${fixture.input.run_root}/artifacts/reference-one`;
    const catalogPath = `${fixture.input.run_root}/references/vulnerability-catalog.json`;
    fs.mkdirSync(path.join(fixture.root, referenceDir), { recursive: true });
    fs.mkdirSync(path.join(fixture.root, path.dirname(catalogPath)), { recursive: true });
    fs.writeFileSync(path.join(fixture.root, referenceDir, "reference.md"), "invented reference\n");
    fs.writeFileSync(path.join(fixture.root, catalogPath), '{"schema_version":"invented.v1"}\n');
    fixture.input.reference_artifact_dirs = [referenceDir];
    fixture.input.vulnerability_database = {
      catalogPath,
      catalogSha256: crypto
        .createHash("sha256")
        .update(fs.readFileSync(path.join(fixture.root, catalogPath)))
        .digest("hex")
    };
    const input = parseModalNodeSandboxInput({
      ...fixture.input,
      selected_task: selectedTaskFor(fixture.input, fixture.root)
    });
    const archive = await createModalNodeHandoffArchive(fixture.root, input);
    input.project_archive_sha256 = archive.sha256;
    const volumeRoot = path.join(path.dirname(fixture.root), "modal-volume", "attempt-provenance");
    try {
      await initializeDurableNodeWorkspace(volumeRoot, archive.path, input);
      const changedCatalog = mutate(input.selected_task!, "vulnerabilityDatabase.catalogSha256", "b".repeat(64));
      const changedReferences = mutate(input.selected_task!, "referenceArtifactDirs", []);
      const changedTask = mutate(input.selected_task!, "metadata.node.label", "Different task label");
      for (const candidate of [
        {
          ...input,
          vulnerability_database: { ...input.vulnerability_database!, catalogSha256: "b".repeat(64) },
          selected_task: changedCatalog
        },
        { ...input, reference_artifact_dirs: [], selected_task: changedReferences },
        { ...input, selected_task: changedTask }
      ]) {
        const parsed = parseModalNodeSandboxInput(candidate);
        await expect(initializeDurableNodeWorkspace(volumeRoot, archive.path, parsed)).rejects.toThrow(
          /durable workspace request does not match this cloud node attempt/u
        );
      }
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  });

  it("recovers reset outputs only when the selected-task provenance still agrees", async () => {
    const fixture = createProjectFixture();
    const input = parseModalNodeSandboxInput({ ...fixture.input, selected_task: fixture.selectedTask });
    const archive = await createModalNodeHandoffArchive(fixture.root, input);
    input.project_archive_sha256 = archive.sha256;
    const volumeParent = path.join(path.dirname(fixture.root), "modal-volume-provenance");
    const priorRoot = path.join(volumeParent, "attempt-base");
    try {
      const prior = await initializeDurableNodeWorkspace(priorRoot, archive.path, input);
      const generated = path.join(prior.projectRoot, input.workspace_dir, "test", "Property.t.sol");
      fs.mkdirSync(path.dirname(generated), { recursive: true });
      fs.writeFileSync(generated, "contract Property {}\n");
      prior.recordCheckpoint("failed", new Error("reset requested"));

      const compatible = parseModalNodeSandboxInput({
        ...input,
        execution_generation: "reset-compatible",
        selected_task: mutate(input.selected_task!, "execution.generation", "reset-compatible")
      });
      const compatibleRoot = path.join(volumeParent, "attempt-compatible");
      const recovered = await initializeDurableNodeWorkspace(compatibleRoot, archive.path, compatible);
      expect(recovered.recordCheckpoint("prepared").restored_from).toBe(priorRoot);

      const changed = mutate(input.selected_task!, "execution.generation", "reset-changed");
      const incompatible = parseModalNodeSandboxInput({
        ...input,
        execution_generation: "reset-changed",
        selected_task: mutate(changed, "metadata.node.label", "Different task label")
      });
      const incompatibleRoot = path.join(volumeParent, "attempt-incompatible");
      const fresh = await initializeDurableNodeWorkspace(incompatibleRoot, archive.path, incompatible);
      expect(fresh.recordCheckpoint("prepared").restored_from).toBeUndefined();
      expect(fs.existsSync(path.join(fresh.projectRoot, ".ultrafuzz", "recovered"))).toBe(false);
    } finally {
      archive.cleanup();
      fixture.cleanup();
    }
  });

  /**
   * The fingerprint is durable evidence, not a transient comparison.
   *
   * A restore copies another generation's outputs into this attempt, so the source must be a
   * generation of this same logical dispatch by its own persisted record. A request document sitting
   * next to a workspace is only a claim about what ran there.
   */
  it("persists the logical dispatch in every checkpoint and requires it before restoring outputs", async () => {
    const fixture = createProjectFixture();
    const input = parseModalNodeSandboxInput({ ...fixture.input, selected_task: fixture.selectedTask });
    const archive = await createModalNodeHandoffArchive(fixture.root, input);
    input.project_archive_sha256 = archive.sha256;
    const fingerprint = modalNodeDispatchFingerprint(input);
    const volumeParent = path.join(path.dirname(fixture.root), "modal-volume-fingerprint-evidence");
    const priorRoot = path.join(volumeParent, "attempt-base");
    try {
      const prior = await initializeDurableNodeWorkspace(priorRoot, archive.path, input);
      const generated = path.join(prior.projectRoot, input.workspace_dir, "test", "Property.t.sol");
      fs.mkdirSync(path.dirname(generated), { recursive: true });
      fs.writeFileSync(generated, "contract Property {}\n");
      const failed = prior.recordCheckpoint("failed", new Error("reset requested"));

      // Both the record and the index carry the fingerprint the controller will re-derive.
      expect(failed.logical_dispatch_fingerprint).toBe(fingerprint);
      const indexPath = path.join(priorRoot, "checkpoints", "index.json");
      expect(
        (JSON.parse(fs.readFileSync(indexPath, "utf8")) as Record<string, unknown>).logical_dispatch_fingerprint
      ).toBe(fingerprint);
      const manifest = path.join(priorRoot, "checkpoints", `${failed.checkpoint_id}.json`);
      expect(
        (JSON.parse(fs.readFileSync(manifest, "utf8")) as Record<string, unknown>).logical_dispatch_fingerprint
      ).toBe(fingerprint);

      // A prior root whose durable index disowns the dispatch is not a restore source, even though
      // its request document still claims it.
      fs.writeFileSync(
        indexPath,
        `${JSON.stringify({
          ...(JSON.parse(fs.readFileSync(indexPath, "utf8")) as Record<string, unknown>),
          logical_dispatch_fingerprint: "c".repeat(64)
        })}\n`
      );
      const reset = parseModalNodeSandboxInput({
        ...input,
        execution_generation: "reset-one",
        selected_task: mutate(input.selected_task!, "execution.generation", "reset-one")
      });
      const disowned = await initializeDurableNodeWorkspace(
        path.join(volumeParent, "attempt-disowned"),
        archive.path,
        reset
      );
      expect(disowned.recordCheckpoint("prepared").restored_from).toBeUndefined();

      // Restored once the index records the dispatch again, so the rejection above is not vacuous.
      fs.writeFileSync(
        indexPath,
        `${JSON.stringify({
          ...(JSON.parse(fs.readFileSync(indexPath, "utf8")) as Record<string, unknown>),
          logical_dispatch_fingerprint: fingerprint
        })}\n`
      );
      const restored = await initializeDurableNodeWorkspace(
        path.join(volumeParent, "attempt-restored"),
        archive.path,
        reset
      );
      expect(restored.recordCheckpoint("prepared").restored_from).toBe(priorRoot);
    } finally {
      archive.cleanup();
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
      const interruptedInput = withExecutionGeneration(fixture.input, "reset-interrupted");
      fs.writeFileSync(path.join(interruptedRoot, "input", "request.json"), `${JSON.stringify(interruptedInput)}\n`);
      const interrupted = await initializeDurableNodeWorkspace(interruptedRoot, archive.path, interruptedInput);
      expect(
        fs.existsSync(
          path.join(interrupted.projectRoot, ".ultrafuzz", "recovered", "attempt-base", "workspace", "test")
        )
      ).toBe(true);

      const resetInput = withExecutionGeneration(fixture.input, "reset-one");
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

      const secondReset = await initializeDurableNodeWorkspace(
        secondResetRoot,
        archive.path,
        withExecutionGeneration(resetInput, "reset-two")
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

      fs.writeFileSync(
        path.join(retry.projectRoot, retry.input.workflow_path),
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
    const result = createResultArchive(fixture.input);
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
      expect(sandbox.exec).not.toHaveBeenCalled();
      expect(sandbox.filesystem.copyFromLocal).not.toHaveBeenCalled();
    } finally {
      result.cleanup();
      fixture.cleanup();
    }
  });

  it("accepts legacy v1 cloud results that predate verification marker archives", async () => {
    const fixture = createProjectFixture();
    const result = createResultArchive(fixture.input, {
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
    fixture.input.agent_credential_env = ["KIMI_API_KEY"];
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

  it("treats Moonshot as an optional Kimi fallback when compiled cloud tasks list both names", async () => {
    const fixture = createProjectFixture();
    fixture.input.agent_credential_env = ["KIMI_API_KEY", "MOONSHOT_API_KEY"];
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
    const fixture = createProjectFixture();
    fixture.input.agent_credential_env = ["KIMI_API_KEY", "MOONSHOT_API_KEY"];
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
    const fixture = createProjectFixture();
    fixture.input.agent_credential_env = ["KIMI_API_KEY", "MOONSHOT_API_KEY", "KIMI_BASE_URL"];
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
      // Run-root-confined and canonically shaped, so the symlinked prefix is what must be refused.
      fixture.input.artifact_dir = `${fixture.input.run_root}/published-artifacts/attempt-one`;
      fixture.input.selected_task = {
        ...fixture.input.selected_task,
        artifactDir: fixture.input.artifact_dir,
        metadata: {
          ...fixture.input.selected_task.metadata,
          artifacts: {
            ...fixture.input.selected_task.metadata.artifacts,
            dir: fixture.input.artifact_dir,
            manifestPath: `${fixture.input.artifact_dir}/artifact-manifest.json`
          }
        }
      };
      fs.mkdirSync(outside, { recursive: true });
      fs.symlinkSync(outside, path.join(fixture.root, fixture.input.run_root, "published-artifacts"), "dir");

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
  // The generated workflow really lives under `.smithers/workflows/`, a project child outside every
  // run root; keeping the fixture faithful is what lets the boundary tests exercise real confinement.
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
  const inputWithoutSelectedTask: Omit<ModalNodeSandboxInput, "selected_task"> = {
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
  const selectedTask = selectedTaskFor(inputWithoutSelectedTask, root);
  const input: ModalNodeSandboxInput = { ...inputWithoutSelectedTask, selected_task: selectedTask };
  return {
    root,
    input,
    selectedTask,
    cleanup: () => fs.rmSync(temporaryRoot, { recursive: true, force: true })
  };
}

/**
 * The exact handoff DTO the controller dispatches alongside a cloud node input.
 *
 * Written out in full rather than as a partial stub: the provider boundary rejects unknown keys and
 * cross-checks every field against the dispatch, so only a complete, agreeing DTO is a valid input.
 */
function selectedTaskFor(
  input: Omit<ModalNodeSandboxInput, "selected_task">,
  sourceProjectRoot: string
): CloudSelectedTask {
  return {
    schema_version: CLOUD_SELECTED_TASK_SCHEMA_VERSION,
    id: input.task_id,
    attemptId: input.attempt_id,
    preparationId: `prepare:${input.attempt_id}`,
    verifierId: `verify:${input.attempt_id}`,
    agentRef: "ClaudeAgent",
    modelName: null,
    reasoningEffort: null,
    branch: `ultrafuzz/${input.run_id}/${input.attempt_id}`,
    promptPath: input.prompt_path!,
    workspacePath: input.workspace_dir,
    artifactDir: input.artifact_dir,
    runRoot: input.run_root,
    workflowPath: input.workflow_path,
    sourceProjectRoot,
    dependencyArtifactDirs: [...input.dependency_artifact_dirs],
    referenceArtifactDirs: [...(input.reference_artifact_dirs ?? [])],
    ...(input.vulnerability_database === undefined ? {} : { vulnerabilityDatabase: input.vulnerability_database }),
    timeoutMs: 600_000,
    heartbeatTimeoutMs: 120_000,
    retries: 1,
    retryPolicy: { backoff: "exponential", initialDelayMs: 1_000, maxDelayMs: 30_000 },
    metadata: {
      schemaVersion: "ultrafuzz.smithers.task-metadata.v1",
      run: {
        ultrafuzzRunId: input.run_id,
        smithersWorkflowName: "ultrafuzz-run-one",
        graphVersion: "1",
        topologyVersion: 2
      },
      node: {
        concreteNodeId: "threat-model",
        logicalNodeId: "threat-model",
        attemptId: input.attempt_id,
        label: "Threat model",
        kind: "agentic"
      },
      dependencies: { concreteNodeIds: ["__start__"], attemptIds: [], smithersNodeIds: [] },
      loop: { index: 0, count: 1, mode: "single", attemptIndex: 0 },
      workspace: { primitive: "worktree", path: input.workspace_dir, trustModel: "trusted-local" },
      artifacts: {
        dir: input.artifact_dir,
        outputs: [
          {
            path: "THREAT_MODEL.md",
            contract: "ultrafuzz/nonempty-markdown@1",
            contractDigest: "a".repeat(64),
            primary: true
          }
        ],
        manifestPath: `${input.artifact_dir}/artifact-manifest.json`
      },
      retryPolicy: { maxAttempts: 2, smithersRetries: 1 },
      timeout: { milliseconds: 600_000, seconds: 600, heartbeatTimeoutMs: 120_000 },
      execution: { mode: "cloud", provider: "modal", resources: { cpu: 2, memoryMiB: 4096, timeoutSeconds: 60 } }
    },
    execution: { mode: "cloud", generation: input.execution_generation }
  };
}

function withExecutionGeneration(input: ModalNodeSandboxInput, generation: string): ModalNodeSandboxInput {
  return {
    ...input,
    execution_generation: generation,
    selected_task: {
      ...input.selected_task,
      execution: { ...input.selected_task.execution, generation }
    }
  };
}

/** Returns a deep copy of `base` with one dotted field set, or removed when `value` is `ABSENT`. */
function mutate(base: unknown, field: string, value: unknown): Record<string, unknown> {
  const clone = structuredClone(base) as Record<string, unknown>;
  const parts = field.split(".");
  let cursor: Record<string, unknown> = clone;
  for (const part of parts.slice(0, -1)) cursor = cursor[part] as Record<string, unknown>;
  const leaf = parts.at(-1)!;
  if (value === ABSENT) {
    delete cursor[leaf];
  } else {
    cursor[leaf] = value;
  }
  return clone;
}

/** Sentinel for "this field is absent", which `undefined` cannot express through JSON. */
const ABSENT = Symbol("absent");

function manifestEntry(relativePath: string, filePath: string) {
  return {
    path: relativePath,
    size_bytes: fs.statSync(filePath).size,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
    provenance: { producer_node_id: "fixture" }
  };
}

function createResultArchive(
  dispatch: ModalNodeSandboxInput,
  options: {
    includeArtifactsDirectory?: boolean;
    includeDurableCheckpoint?: boolean;
    includeVerificationMarker?: boolean;
    logicalDispatchFingerprint?: string;
    schemaVersion?: "ultrafuzz.modal.node-result.v1" | "ultrafuzz.modal.node-result.v2";
  } = {}
) {
  dispatch.project_content_sha256 ??= modalNodeHandoffContentFingerprint(
    dispatch.selected_task.sourceProjectRoot,
    dispatch
  );
  // The published bundle names the logical dispatch that produced it, so the controller can only
  // adopt a result whose provenance is its own dispatch.
  const fingerprint = options.logicalDispatchFingerprint ?? modalNodeDispatchFingerprint(dispatch);
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
    fs.writeFileSync(path.join(bundle, "verification", "attempt-one.json"), '{"verified":true}\n');
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
      logical_dispatch_fingerprint: fingerprint,
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
      logical_dispatch_fingerprint: fingerprint,
      workspace_path: `${attemptRoot}/workspace`,
      run_root: ".ultrafuzz/runs/run-one",
      handoff_archive: `${attemptRoot}/input/project.tgz`
    }),
    durableCheckpointIndex: JSON.stringify({
      schema_version: "ultrafuzz.modal.node-checkpoint-index.v1",
      storage_lineage: "run-one/attempt-one/base",
      logical_dispatch_fingerprint: fingerprint,
      workspace_path: `${attemptRoot}/workspace`,
      run_root: ".ultrafuzz/runs/run-one",
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
