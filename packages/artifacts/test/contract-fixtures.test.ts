import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as artifactExports from "../src/index.js";
import {
  ARTIFACT_CONTRACT_IDS,
  ARTIFACT_CONTRACT_SCHEMA_FILES,
  ARTIFACT_SCHEMA_METADATA,
  JSON_ARTIFACT_CONTRACT_IDS,
  NON_JSON_ARTIFACT_CONTRACT_IDS,
  analysisBundleManifestSchema,
  artifactContractDefinition,
  artifactContractSchemaFile,
  artifactSchemaRegistry,
  createInitialRunState,
  executeSemanticGate,
  invariantLedgerSchema,
  invariantSourceProofSchema,
  isArtifactContractId,
  parseStrictJson,
  validateAnalysisBundleManifestSchema,
  validateArtifactContract,
  validateArtifactContractBytes,
  validateInvariantLedgerSchema,
  validateInvariantSourceProofSchema,
  validateRegisteredJsonSchema,
  validateWorkspacePatchSchema,
  workspacePatchSchema
} from "../src/index.js";

interface ContractFixture {
  schema_file: string;
  valid: unknown;
  invalid: unknown;
}

interface ZodLikeParser {
  safeParse(value: unknown): { success: boolean; data?: unknown };
}

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = [
  path.resolve(moduleDirectory, "..", "..", "test", "fixtures", "contract-schema-fixtures.json"),
  path.resolve(moduleDirectory, "fixtures", "contract-schema-fixtures.json")
].find((candidate) => fs.existsSync(candidate));
if (fixturePath === undefined) throw new Error(`Contract fixtures are unavailable near ${moduleDirectory}`);
const contractFixtures = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Record<string, ContractFixture>;

const removedContractIds = [
  "ultrafuzz/campaign-summary@1",
  "ultrafuzz/findings@1",
  "ultrafuzz/generated-tests@1",
  "ultrafuzz/implemented-properties@1",
  "ultrafuzz/implemented-properties@2",
  "ultrafuzz/json-array@1",
  "ultrafuzz/json-object@1",
  "ultrafuzz/properties@1",
  "ultrafuzz/property-campaign@1",
  "ultrafuzz/property-lens@1",
  "ultrafuzz/reference-expectations@1",
  "ultrafuzz/report@1"
] as const;

test("the registry, schema metadata, mappings, and fixtures cover every current contract exactly once", () => {
  const registry = artifactSchemaRegistry();
  const registeredContractIds = registry.flatMap((entry) => entry.contractIds).sort();

  assert.deepEqual(registeredContractIds, [...JSON_ARTIFACT_CONTRACT_IDS].sort());
  assert.deepEqual(Object.keys(contractFixtures).sort(), [...JSON_ARTIFACT_CONTRACT_IDS].sort());
  assert.deepEqual(Object.keys(ARTIFACT_CONTRACT_SCHEMA_FILES).sort(), [...JSON_ARTIFACT_CONTRACT_IDS].sort());
  assert.deepEqual(Object.keys(ARTIFACT_SCHEMA_METADATA).sort(), registry.map((entry) => entry.filename).sort());
  assert.equal(new Set(ARTIFACT_CONTRACT_IDS).size, ARTIFACT_CONTRACT_IDS.length);

  for (const contract of JSON_ARTIFACT_CONTRACT_IDS) {
    const schemaFile = artifactContractSchemaFile(contract);
    const fixture = contractFixtures[contract];
    const registryMatches = registry.filter((entry) => entry.contractIds.includes(contract));
    assert.equal(artifactContractDefinition(contract).format, "json", contract);
    assert.equal(typeof schemaFile, "string", contract);
    assert.equal(fixture?.schema_file, schemaFile, contract);
    assert.equal(registryMatches.length, 1, contract);
    assert.equal(registryMatches[0]?.filename, schemaFile, contract);
    const metadata = ARTIFACT_SCHEMA_METADATA[schemaFile as keyof typeof ARTIFACT_SCHEMA_METADATA];
    assert.deepEqual(metadata?.contractIds, [contract], contract);
  }

  for (const contract of NON_JSON_ARTIFACT_CONTRACT_IDS) {
    assert.equal(artifactContractSchemaFile(contract), undefined, contract);
    assert.equal(artifactContractDefinition(contract).format === "json", false, contract);
  }
  for (const contract of removedContractIds) assert.equal(isArtifactContractId(contract), false, contract);
});

test("every JSON contract has canonical positive and negative fixtures and validation is non-mutating", () => {
  for (const contract of JSON_ARTIFACT_CONTRACT_IDS) {
    const fixture = contractFixtures[contract]!;
    const validBefore = structuredClone(fixture.valid);
    const invalidBefore = structuredClone(fixture.invalid);
    const validBytes = JSON.stringify(fixture.valid);
    const invalidBytes = JSON.stringify(fixture.invalid);

    const valid = validateArtifactContract(contract, validBytes, `${contract}:valid`);
    const invalid = validateArtifactContract(contract, invalidBytes, `${contract}:invalid`);

    assert.equal(valid.ok, true, `${contract}: ${JSON.stringify(valid.issues)}`);
    assert.equal(invalid.ok, false, contract);
    assert.deepEqual(fixture.valid, validBefore, `${contract} valid value mutated`);
    assert.deepEqual(fixture.invalid, invalidBefore, `${contract} invalid value mutated`);
    assert.equal(JSON.stringify(fixture.valid), validBytes, `${contract} valid bytes changed`);
    assert.equal(JSON.stringify(fixture.invalid), invalidBytes, `${contract} invalid bytes changed`);
    assert.deepEqual(parseStrictJson(validBytes), fixture.valid, contract);
  }
});

test("strict contract parsing rejects duplicate keys in every object-shaped canonical fixture", () => {
  for (const contract of JSON_ARTIFACT_CONTRACT_IDS) {
    const fixture = contractFixtures[contract]!;
    const duplicate = duplicateFixtureJson(fixture.valid);
    if (duplicate === undefined) continue;
    const result = validateArtifactContract(contract, duplicate, `${contract}:duplicate`);
    assert.equal(result.ok, false, contract);
    assert.equal(result.issues[0]?.code, "ARTIFACT_JSON_DUPLICATE_KEY", contract);
  }
});

test("byte-level contract validation rejects invalid UTF-8 before shape validation", () => {
  const invalidUtf8 = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]);
  for (const contract of ["ultrafuzz/findings@2", "ultrafuzz/nonempty-markdown@1", "ultrafuzz/text@1"] as const) {
    const result = validateArtifactContractBytes(contract, invalidUtf8, `${contract}:invalid-utf8`);
    assert.equal(result.ok, false, contract);
    assert.match(result.issues[0]?.code ?? "", /ARTIFACT_(?:JSON|UTF8)_INVALID/u, contract);
  }
});

test("checked-in canonical schemas equal every metadata-named TypeScript export", () => {
  const exports = artifactExports as unknown as Record<string, unknown>;
  for (const entry of artifactSchemaRegistry()) {
    assert.ok(entry.typescriptExport in exports, `${entry.filename}: ${entry.typescriptExport}`);
    assert.deepEqual(exports[entry.typescriptExport], entry.schema, entry.filename);
  }
});

test("Ajv and every retained Zod parser agree bidirectionally on positive, negative, and required-field fixtures", () => {
  const exports = artifactExports as unknown as Record<string, unknown>;
  for (const entry of artifactSchemaRegistry()) {
    if (entry.zodParser === undefined) continue;
    const parser = exports[entry.zodParser] as ZodLikeParser | undefined;
    assert.equal(typeof parser?.safeParse, "function", `${entry.filename}: ${entry.zodParser}`);
    const positive = zodPositiveFixture(entry.filename, entry.contractIds);
    const negative = invalidRootFixture(positive);

    assertParity(entry.id, parser!, positive, true, `${entry.filename}:positive`);
    assertParity(entry.id, parser!, negative, false, `${entry.filename}:negative`);

    if (isRecord(positive)) {
      const required = Array.isArray(entry.schema.required) ? entry.schema.required : [];
      for (const key of required) {
        if (typeof key !== "string") continue;
        const missing = structuredClone(positive);
        delete missing[key];
        assertParity(entry.id, parser!, missing, false, `${entry.filename}:missing:${key}`);
      }
    }
  }
});

test("projected uniqueness, joins, and ordering stay outside structural Zod while public validators run named gates", () => {
  const analysisSchemaId = registeredSchemaId("analysis-bundle.schema.json");
  const unsortedAnalysisManifest = {
    schema_version: "ultrafuzz.analysis-bundle.v1",
    policy_version: "ultrafuzz.analysis-bundle-policy.v1",
    files: [
      {
        kind: "omissions",
        path: "omissions.json",
        media_type: "application/json",
        size_bytes: 10,
        sha256: "a".repeat(64)
      },
      {
        kind: "terminal-status",
        path: "data/terminal-status.json",
        media_type: "application/json",
        size_bytes: 20,
        sha256: "b".repeat(64)
      }
    ]
  };
  assertParity(
    analysisSchemaId,
    analysisBundleManifestSchema,
    unsortedAnalysisManifest,
    true,
    "analysis-bundle:semantic-order"
  );
  assert.equal(
    executeSemanticGate("analysis-bundle-path-order", { document: unsortedAnalysisManifest }).status,
    "failed"
  );
  assert.equal(validateAnalysisBundleManifestSchema(unsortedAnalysisManifest).ok, false);

  const sourceProofSchemaId = registeredSchemaId("invariant-source-proof.schema.json");
  const duplicateSourceProof = canonicalInvariantSourceProof();
  duplicateSourceProof.files.push({ ...duplicateSourceProof.files[0]! });
  assertParity(
    sourceProofSchemaId,
    invariantSourceProofSchema,
    duplicateSourceProof,
    true,
    "invariant-source-proof:semantic-path-uniqueness"
  );
  assert.equal(
    executeSemanticGate("invariant-source-proof-path-uniqueness", { document: duplicateSourceProof }).status,
    "failed"
  );
  const sourceProofValidation = validateInvariantSourceProofSchema(duplicateSourceProof);
  assert.equal(sourceProofValidation.ok, false);
  assert.equal(sourceProofValidation.issues[0]?.path, "$.files[1].path");
  assert.match(sourceProofValidation.issues[0]?.message ?? "", /Duplicate source proof path/u);

  const workspacePatchSchemaId = registeredSchemaId("workspace-patch.schema.json");
  const duplicateWorkspacePatch = canonicalWorkspacePatch();
  duplicateWorkspacePatch.files.push({ ...duplicateWorkspacePatch.files[0]! });
  assertParity(
    workspacePatchSchemaId,
    workspacePatchSchema,
    duplicateWorkspacePatch,
    true,
    "workspace-patch:semantic-path-uniqueness"
  );
  assert.equal(
    executeSemanticGate("workspace-patch-path-uniqueness", { document: duplicateWorkspacePatch }).status,
    "failed"
  );
  const workspacePatchValidation = validateWorkspacePatchSchema(duplicateWorkspacePatch);
  assert.equal(workspacePatchValidation.ok, false);
  assert.equal(workspacePatchValidation.issues.length, 1);
  assert.equal(workspacePatchValidation.issues[0]?.path, "$.files[1].path");

  const overlappingWorkspacePatch = {
    ...canonicalWorkspacePatch(),
    excluded_files: [{ path: "foundry.toml", diff_bytes_at_least: 1, reason: "git-diff-overflow" as const }]
  };
  assertParity(
    workspacePatchSchemaId,
    workspacePatchSchema,
    overlappingWorkspacePatch,
    true,
    "workspace-patch:semantic-included-excluded-disjointness"
  );
  assert.equal(
    executeSemanticGate("workspace-patch-path-uniqueness", { document: overlappingWorkspacePatch }).status,
    "failed"
  );
  const overlappingWorkspaceValidation = validateWorkspacePatchSchema(overlappingWorkspacePatch);
  assert.equal(overlappingWorkspaceValidation.ok, false);
  assert.equal(overlappingWorkspaceValidation.issues.length, 1);
  assert.equal(overlappingWorkspaceValidation.issues[0]?.path, "$.excluded_files[0].path");
  assert.match(overlappingWorkspaceValidation.issues[0]?.message ?? "", /both included and excluded/u);

  const invariantLedgerSchemaId = registeredSchemaId("invariant-evidence-ledger.schema.json");
  const duplicateLedgerId = canonicalInvariantLedger();
  duplicateLedgerId.entries.push({ ...duplicateLedgerId.entries[0]! });
  assertParity(
    invariantLedgerSchemaId,
    invariantLedgerSchema,
    duplicateLedgerId,
    true,
    "invariant-ledger:semantic-projected-id-uniqueness"
  );
  assert.equal(
    executeSemanticGate("invariant-ledger-projected-id-uniqueness", { document: duplicateLedgerId }).status,
    "failed"
  );
  const duplicateLedgerValidation = validateInvariantLedgerSchema(duplicateLedgerId);
  assert.equal(duplicateLedgerValidation.ok, false);
  assert.equal(duplicateLedgerValidation.issues[0]?.path, "$.entries[1].id");
  assert.match(duplicateLedgerValidation.issues[0]?.message ?? "", /Duplicate ledger entry ID/u);

  const brokenLedgerJoin = canonicalInvariantLedger();
  brokenLedgerJoin.entries[0]!.inventory_ids = ["inventory-unregistered"];
  assertParity(
    invariantLedgerSchemaId,
    invariantLedgerSchema,
    brokenLedgerJoin,
    true,
    "invariant-ledger:semantic-cross-array-join"
  );
  assert.equal(executeSemanticGate("invariant-ledger-id-joins", { document: brokenLedgerJoin }).status, "failed");
  const brokenLedgerValidation = validateInvariantLedgerSchema(brokenLedgerJoin);
  assert.equal(brokenLedgerValidation.ok, false);
  assert.ok(brokenLedgerValidation.issues.some((issue) => /references unknown inventory row/u.test(issue.message)));
});

test("portable constraints remain identical in Ajv and the four retained structural Zod parsers", () => {
  const analysisManifestWithoutOmissions = {
    schema_version: "ultrafuzz.analysis-bundle.v1",
    policy_version: "ultrafuzz.analysis-bundle-policy.v1",
    files: [
      {
        kind: "terminal-status",
        path: "data/terminal-status.json",
        media_type: "application/json",
        size_bytes: 20,
        sha256: "a".repeat(64)
      }
    ]
  };
  assertParity(
    registeredSchemaId("analysis-bundle.schema.json"),
    analysisBundleManifestSchema,
    analysisManifestWithoutOmissions,
    false,
    "analysis-bundle:required-kind"
  );

  const analysisManifestWithLargeJsonInteger = {
    schema_version: "ultrafuzz.analysis-bundle.v1",
    policy_version: "ultrafuzz.analysis-bundle-policy.v1",
    files: [
      {
        kind: "omissions",
        path: "omissions.json",
        media_type: "application/json",
        size_bytes: Number.MAX_SAFE_INTEGER + 1,
        sha256: "a".repeat(64)
      }
    ]
  };
  assertParity(
    registeredSchemaId("analysis-bundle.schema.json"),
    analysisBundleManifestSchema,
    analysisManifestWithLargeJsonInteger,
    true,
    "analysis-bundle:json-integer-range"
  );

  const analysisManifestWithDuplicateKind = structuredClone(analysisManifestWithLargeJsonInteger);
  analysisManifestWithDuplicateKind.files.push({ ...analysisManifestWithDuplicateKind.files[0]! });
  assertParity(
    registeredSchemaId("analysis-bundle.schema.json"),
    analysisBundleManifestSchema,
    analysisManifestWithDuplicateKind,
    false,
    "analysis-bundle:portable-kind-cardinality"
  );

  const sourceProofWithTraversal = canonicalInvariantSourceProof();
  sourceProofWithTraversal.files[0]!.path = "docs/../secret.txt";
  assertParity(
    registeredSchemaId("invariant-source-proof.schema.json"),
    invariantSourceProofSchema,
    sourceProofWithTraversal,
    false,
    "invariant-source-proof:path-shape"
  );

  const workspacePatchWithUnsafePath = canonicalWorkspacePatch();
  workspacePatchWithUnsafePath.files[0]!.path = ".git/config";
  assertParity(
    registeredSchemaId("workspace-patch.schema.json"),
    workspacePatchSchema,
    workspacePatchWithUnsafePath,
    false,
    "workspace-patch:path-shape"
  );

  const invariantLedgerWithDuplicateScalar = canonicalInvariantLedger();
  invariantLedgerWithDuplicateScalar.entries[0]!.inventory_ids = ["inventory-solvency", "inventory-solvency"];
  assertParity(
    registeredSchemaId("invariant-evidence-ledger.schema.json"),
    invariantLedgerSchema,
    invariantLedgerWithDuplicateScalar,
    false,
    "invariant-ledger:portable-unique-items"
  );

  const emptyInvariantLedgerWithoutJustification = {
    schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
    entries: [],
    inventory_rows: [],
    scan_probes: [
      {
        id: "probe-docs",
        source_path: "docs/overview.md",
        query: "invariant",
        result: "No invariant found"
      }
    ]
  };
  assertParity(
    registeredSchemaId("invariant-evidence-ledger.schema.json"),
    invariantLedgerSchema,
    emptyInvariantLedgerWithoutJustification,
    false,
    "invariant-ledger:portable-empty-ledger-conditional"
  );
});

test("Ajv and retained Zod parsers agree on canonical unique-array constraints", () => {
  const mismatches: string[] = [];
  const finding = structuredClone(
    (contractFixtures["ultrafuzz/findings@2"]!.valid as Array<Record<string, unknown>>)[0]!
  );
  finding.contributing_backend_failures = ["backend-failure-1", "backend-failure-1"];

  const implementedBase = contractFixtures["ultrafuzz/implemented-properties@3"]!.valid as Record<string, unknown>;
  const implementedWithDuplicateImplementationPaths: Record<string, unknown> & {
    properties: Array<{ implementation_paths: string[]; test_paths: string[]; [key: string]: unknown }>;
  } = {
    ...structuredClone(implementedBase),
    selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] },
    properties: [
      {
        property_id: "property-1",
        status: "implemented",
        implementation_paths: ["test/Properties.sol", "test/Properties.sol"],
        test_paths: []
      }
    ]
  };
  const implementedWithDuplicateTestPaths = structuredClone(implementedWithDuplicateImplementationPaths);
  implementedWithDuplicateTestPaths.properties[0]!.implementation_paths = [];
  implementedWithDuplicateTestPaths.properties[0]!.test_paths = ["test/Property.t.sol", "test/Property.t.sol"];

  const report = {
    ...(structuredClone(contractFixtures["ultrafuzz/report@2"]!.valid) as Record<string, unknown>),
    property_implementation_coverage: {
      priority_threshold: "high",
      priorities: ["high", "high"],
      selected_property_ids: [],
      implemented_property_ids: [],
      blocked_property_ids: [],
      pending_property_ids: [],
      deferred_property_ids: [],
      reference_expected_property_ids: [],
      reference_expectation_ids: [],
      blocker_summaries: []
    }
  };

  for (const [filename, value, label] of [
    ["finding.schema.json", finding, "duplicate contributing_backend_failures"],
    [
      "implemented-properties.schema.json",
      implementedWithDuplicateImplementationPaths,
      "duplicate implementation_paths"
    ],
    ["implemented-properties.schema.json", implementedWithDuplicateTestPaths, "duplicate test_paths"],
    ["report.schema.json", report, "duplicate coverage priorities"]
  ] as const) {
    const entry = artifactSchemaRegistry().find((candidate) => candidate.filename === filename);
    assert.ok(entry?.zodParser !== undefined, filename);
    const parser = (artifactExports as unknown as Record<string, unknown>)[entry.zodParser] as ZodLikeParser;
    const ajv = validateRegisteredJsonSchema(entry.id, value);
    const zod = parser.safeParse(value);
    assert.equal(ajv.ok, false, `${filename}:${label}: Ajv fixture must exercise uniqueItems`);
    if (zod.success) mismatches.push(`${filename}: ${label}`);
  }
  assert.deepEqual(mismatches, [], `Zod accepted JSON-Schema-invalid unique arrays: ${mismatches.join("; ")}`);
});

test("run-state v4 JSON Schema and Zod agree on every closed provenance variant", () => {
  const entry = artifactSchemaRegistry().find((candidate) => candidate.filename === "run-state.schema.json");
  assert.ok(entry?.zodParser !== undefined);
  const parser = (artifactExports as unknown as Record<string, unknown>)[entry.zodParser] as ZodLikeParser;
  const base = createInitialRunState({
    runId: "run-1",
    graphFingerprint: "a".repeat(64),
    configFingerprint: "b".repeat(64),
    nodes: []
  });
  const withNodeProvenance = (provenance: unknown): unknown => ({
    ...base,
    nodes: {
      "node-1": {
        node_id: "node-1",
        status: "succeeded",
        retry_count: 0,
        timed_out: false,
        provenance
      }
    }
  });
  const taskWorkflow = {
    run_id: "workflow-1",
    task_id: "verify:node-1",
    agent_task_id: "node:node-1",
    verifier_task_id: "verify:node-1",
    state: "finished",
    attempt: 1
  };
  const cases: Array<{ label: string; value: unknown; expected: boolean }> = [
    {
      label: "run-workflow",
      value: {
        ...base,
        provenance: {
          workflow: {
            inspection: { runId: "workflow-1" },
            runId: "workflow-1",
            compiledRunId: "workflow-1",
            name: "workflow",
            controlGeneration: "c".repeat(64),
            linkId: "00000000-0000-4000-8000-000000000001",
            executionSnapshot: `smithers/execution-snapshots/${"d".repeat(64)}`
          }
        }
      },
      expected: true
    },
    {
      label: "execution-task",
      value: withNodeProvenance({
        workflow: taskWorkflow,
        output_contracts: { ok: true, missing: [] },
        findings_count: 0
      }),
      expected: true
    },
    {
      label: "execution-aggregate",
      value: withNodeProvenance({
        workflow: { run_id: "workflow-1", aggregate_attempt_statuses: ["failed", "succeeded"] }
      }),
      expected: true
    },
    {
      label: "execution-dynamic-lineage",
      value: withNodeProvenance({ source_node_id: "threat-model" }),
      expected: true
    },
    {
      label: "reference",
      value: withNodeProvenance({
        origin: "pinned-reference",
        reference: "baseline",
        repo: "https://example.invalid/reference.git",
        commit: "e".repeat(40),
        reference_expectations: {
          source: "operator-supplied",
          path: "references/expectations.json",
          sha256: "f".repeat(64)
        }
      }),
      expected: true
    },
    {
      label: "blocked",
      value: withNodeProvenance({
        reason_code: "DEPENDENCY_NOT_SATISFIED",
        blocked_by: ["dependency-1"]
      }),
      expected: true
    },
    {
      label: "legacy-generic-object",
      value: withNodeProvenance({ arbitrary: { nested: true } }),
      expected: false
    },
    {
      label: "partial-task-identity",
      value: withNodeProvenance({ workflow: { run_id: "workflow-1", task_id: "node:node-1" } }),
      expected: false
    },
    {
      label: "empty-aggregate",
      value: withNodeProvenance({ workflow: { run_id: "workflow-1", aggregate_attempt_statuses: [] } }),
      expected: false
    },
    {
      label: "empty-dynamic-lineage",
      value: withNodeProvenance({ source_node_id: "" }),
      expected: false
    },
    {
      label: "partial-reference-revision",
      value: withNodeProvenance({ origin: "pinned-reference", reference: "baseline", repo: "repo" }),
      expected: false
    },
    {
      label: "empty-blocker-list",
      value: withNodeProvenance({ reason_code: "DEPENDENCY_NOT_SATISFIED", blocked_by: [] }),
      expected: false
    },
    {
      label: "duplicate-output-missing-path",
      value: withNodeProvenance({
        workflow: taskWorkflow,
        output_contracts: { ok: false, missing: ["result.json", "result.json"] }
      }),
      expected: false
    }
  ];

  for (const fixture of cases) {
    assertParity(entry.id, parser, fixture.value, fixture.expected, `run-state:${fixture.label}`);
  }
});

test("node-attempt JSON Schema and Zod agree on portable outcome conditionals", () => {
  const entry = artifactSchemaRegistry().find((candidate) => candidate.filename === "node-attempt-ledger.schema.json");
  assert.ok(entry?.zodParser !== undefined);
  const parser = (artifactExports as unknown as Record<string, unknown>)[entry.zodParser] as ZodLikeParser;
  const succeeded = zodPositiveFixture(entry.filename, entry.contractIds) as Record<string, unknown>;
  const failed = {
    ...structuredClone(succeeded),
    outcome: "failed",
    manifests: { input_sha256: "a".repeat(64), output_sha256: null },
    failure_category: "executor-error"
  };
  const reused = {
    ...structuredClone(succeeded),
    outcome: "reused",
    reuse: {
      status: "reused",
      source: { workflow_run_id: "workflow-source", source_event_sequence: 1 }
    }
  };
  const failedWithoutCategory = structuredClone(failed) as Record<string, unknown>;
  delete failedWithoutCategory.failure_category;
  const cases: Array<{ label: string; value: unknown; expected: boolean }> = [
    { label: "succeeded", value: succeeded, expected: true },
    {
      label: "succeeded-null-output",
      value: { ...structuredClone(succeeded), manifests: { input_sha256: "a".repeat(64), output_sha256: null } },
      expected: false
    },
    {
      label: "succeeded-failure-detail",
      value: { ...structuredClone(succeeded), failure_category: "executor-error" },
      expected: false
    },
    { label: "failed", value: failed, expected: true },
    { label: "failed-missing-category", value: failedWithoutCategory, expected: false },
    { label: "reused", value: reused, expected: true },
    {
      label: "reused-executed-status",
      value: { ...structuredClone(reused), reuse: { status: "executed" } },
      expected: false
    },
    {
      label: "reused-null-output",
      value: { ...structuredClone(reused), manifests: { input_sha256: "a".repeat(64), output_sha256: null } },
      expected: false
    },
    {
      label: "semantic-order-is-shape-valid",
      value: {
        ...structuredClone(succeeded),
        started_event_sequence: 3,
        source_event_sequence: 2,
        lifecycle: {
          started_at: "2026-08-09T00:02:00.000Z",
          finished_at: "2026-08-09T00:01:00.000Z"
        }
      },
      expected: true
    },
    {
      label: "semantic-byte-limit-is-shape-valid",
      value: { ...structuredClone(failed), failure_message: "🙂".repeat(251) },
      expected: true
    }
  ];

  for (const fixture of cases) {
    assertParity(entry.id, parser, fixture.value, fixture.expected, `node-attempt:${fixture.label}`);
  }
});

function assertParity(schemaId: string, parser: ZodLikeParser, value: unknown, expected: boolean, label: string): void {
  const before = structuredClone(value);
  const ajv = validateRegisteredJsonSchema(schemaId, value);
  const zod = parser.safeParse(value);
  assert.equal(ajv.ok, expected, `${label}: Ajv ${JSON.stringify(ajv.issues)}`);
  assert.equal(zod.success, expected, `${label}: Zod disagreed with Ajv`);
  assert.deepEqual(value, before, `${label}: validation mutated its input`);
  if (zod.success) assert.deepEqual(zod.data, value, `${label}: retained Zod parser transformed its input`);
}

function zodPositiveFixture(filename: string, contractIds: readonly string[]): unknown {
  if (contractIds.length === 1) {
    const fixture = contractFixtures[contractIds[0]!];
    if (fixture === undefined) throw new Error(`Missing contract fixture for ${contractIds[0]}`);
    return fixture.valid;
  }
  switch (filename) {
    case "analysis-bundle.schema.json":
      return {
        schema_version: "ultrafuzz.analysis-bundle.v1",
        policy_version: "ultrafuzz.analysis-bundle-policy.v1",
        files: [
          {
            kind: "omissions",
            path: "omissions.json",
            media_type: "application/json",
            size_bytes: 10,
            sha256: "a".repeat(64)
          }
        ]
      };
    case "finding.schema.json":
      return (contractFixtures["ultrafuzz/findings@2"]!.valid as unknown[])[0];
    case "event-query-facade.schema.json":
      return {
        schema_version: "ultrafuzz.event-query-facade.v1",
        run_id: "run-1",
        append_log: "events.jsonl",
        index_root: "events.index",
        indexes: ["run", "node", "type", "status", "timestamp"],
        filters: {
          run_id: "events.index/run/<run-id>.jsonl",
          node_id: "events.index/node/<node-id>.jsonl",
          event_type: "events.index/type/<event-type>.jsonl",
          status: "events.index/status/<status>.jsonl",
          timestamp: "events.index/timestamp/<yyyy-mm-dd>.jsonl"
        },
        long_filters: {
          run_id: "events.index/run/sha256/<sha256-hex(run-id)>.jsonl",
          node_id: "events.index/node/sha256/<sha256-hex(node-id)>.jsonl",
          event_type: "events.index/type/sha256/<sha256-hex(event-type)>.jsonl",
          status: "events.index/status/sha256/<sha256-hex(status)>.jsonl"
        },
        index_key_encoding: {
          version: "ultrafuzz.event-index-key.v1",
          direct_max_id_length: 122,
          direct_id_path: "<dimension>/<id>.jsonl",
          long_id_path: "<dimension>/sha256/<sha256-hex(id)>.jsonl",
          digest: "sha256",
          hash_input_encoding: "utf8",
          digest_encoding: "hex"
        }
      };
    case "event-record.schema.json":
      return {
        schema_version: "ultrafuzz.event-record.v2",
        event_id: `evt-${"a".repeat(24)}`,
        timestamp: "2026-08-09T00:00:00.000Z",
        run_id: "run-1",
        event_type: "workflow-synced",
        status: "running",
        payload: {
          workflow_run_id: "workflow-1",
          workflow_status: "running",
          workflow_state: "running",
          synced_nodes: 1,
          accounting_available: true,
          recovery_due: false,
          deadline_exceeded: false
        }
      };
    case "invariant-source-proof.schema.json":
      return {
        schema_version: "ultrafuzz.invariant-source-proof.v1",
        attempt_id: "project-discovery",
        commit: "a".repeat(40),
        tree: "b".repeat(40),
        ledger_sha256: "c".repeat(64),
        files: [{ path: "docs/overview.md", sha256: "d".repeat(64), content: "Invariant source text" }]
      };
    case "node-attempt-ledger.schema.json":
      return {
        schema_version: "ultrafuzz.node-attempt-ledger.v1",
        run_id: "run-1",
        workflow_run_id: "workflow-1",
        control_generation: "c".repeat(64),
        node_id: "node-1",
        strategy_attempt_id: "strategy-1",
        iteration: 0,
        attempt: 1,
        started_event_sequence: 1,
        source_event_sequence: 2,
        lifecycle: {
          started_at: "2026-08-09T00:00:00.000Z",
          finished_at: "2026-08-09T00:01:00.000Z"
        },
        outcome: "succeeded",
        reuse: { status: "executed" },
        manifests: { input_sha256: "a".repeat(64), output_sha256: "b".repeat(64) }
      };
    case "run-state.schema.json":
      return createInitialRunState({
        runId: "run-1",
        graphFingerprint: "graph-fingerprint",
        configFingerprint: "config-fingerprint",
        nodes: []
      });
    case "terminal-disposition.schema.json":
      return {
        schema_version: "ultrafuzz.terminal-disposition.v1",
        kind: "task-output-validation-failure"
      };
    case "usage-ledger.schema.json":
      return {
        schema_version: "ultrafuzz.usage-ledger.v1",
        run_id: "run-1",
        workflow_run_id: "workflow-1",
        control_generation: "c".repeat(64),
        source_event_sequence: 3,
        observed_timestamp_ms: Date.parse("2026-08-09T00:00:00.000Z"),
        node_id: "node:1",
        iteration: 0,
        attempt: 1,
        usage: { model: "model", agent: "agent", input_tokens: 1, output_tokens: 2 }
      };
    default:
      throw new Error(`Missing retained-Zod positive fixture for ${filename}`);
  }
}

function invalidRootFixture(value: unknown): unknown {
  if (isRecord(value)) return { ...value, __unexpected_fixture_field: true };
  return null;
}

function duplicateFixtureJson(value: unknown): string | undefined {
  if (isRecord(value)) return duplicateObjectJson(value);
  if (Array.isArray(value) && isRecord(value[0])) return `[${duplicateObjectJson(value[0])}]`;
  return undefined;
}

function duplicateObjectJson(value: Record<string, unknown>): string {
  const key = Object.keys(value)[0];
  assert.ok(key !== undefined);
  const serialized = JSON.stringify(value);
  return `{${JSON.stringify(key)}:${JSON.stringify(value[key])},${serialized.slice(1)}`;
}

function registeredSchemaId(filename: string): string {
  const entry = artifactSchemaRegistry().find((candidate) => candidate.filename === filename);
  assert.ok(entry, `Missing registered schema ${filename}`);
  return entry.id;
}

function canonicalInvariantSourceProof() {
  return {
    schema_version: "ultrafuzz.invariant-source-proof.v1" as const,
    attempt_id: "project-discovery",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    ledger_sha256: "c".repeat(64),
    files: [{ path: "docs/overview.md", sha256: "d".repeat(64), content: "Invariant source text" }]
  };
}

function canonicalWorkspacePatch() {
  return {
    schema_version: "ultrafuzz.workspace-patch.v1" as const,
    base_commit: "a".repeat(40),
    base_tree: "b".repeat(40),
    result_tree: "c".repeat(40),
    patch_sha256: "d".repeat(64),
    files: [{ path: "foundry.toml" }]
  };
}

function canonicalInvariantLedger() {
  return {
    schema_version: "ultrafuzz.invariant-evidence-ledger.v1" as const,
    entries: [
      {
        id: "evidence-1",
        source_path: "docs/overview.md",
        source_location: "line 10",
        kind: "invariant" as const,
        verbatim: "Assets remain solvent",
        inventory_ids: ["inventory-solvency"]
      }
    ],
    inventory_rows: [
      {
        id: "inventory-solvency",
        description: "Solvency invariant",
        ledger_ids: ["evidence-1"]
      }
    ],
    scan_probes: []
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
