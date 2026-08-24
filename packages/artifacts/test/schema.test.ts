import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import os from "node:os";

import {
  ANALYSIS_BUNDLE_SCHEMA_VERSION,
  CAMPAIGN_SUMMARY_SCHEMA_VERSION,
  FINDINGS_SCHEMA_VERSION,
  GENERATED_TEST_MANIFEST_PATH_PATTERN,
  GENERATED_TESTS_SCHEMA_VERSION,
  INVARIANT_LEDGER_SCHEMA_VERSION,
  INVARIANT_SOURCE_PROOF_SCHEMA_VERSION,
  IMPLEMENTED_PROPERTIES_SCHEMA_VERSION,
  MAX_FINDING_STRING_CODE_POINTS,
  NODE_ATTEMPT_LEDGER_SCHEMA_VERSION,
  NODE_REFERENCE_PATTERN,
  NODE_STATE_STATUSES,
  RUN_STATE_STATUSES,
  PROPERTIES_SCHEMA_VERSION,
  PLANNED_GRAPH_SCHEMA_VERSION,
  PROPERTY_LENS_SCHEMA_VERSION,
  PROPERTY_CAMPAIGN_SCHEMA_VERSION,
  REFERENCE_EXPECTATIONS_SCHEMA_VERSION,
  REPORT_SCHEMA_VERSION,
  USAGE_LEDGER_SCHEMA_VERSION,
  VALIDATOR_BUILD_IDENTITY,
  ARTIFACT_CONTRACT_IDS,
  CANONICAL_ARTIFACT_RELATIVE_PATH_PATTERN,
  artifactManifestJsonSchema,
  artifactVerificationJsonSchema,
  aggregationManifestSchema,
  auditedDifferentialLanesSchema,
  coverageEvidenceJsonSchema,
  MAX_COVERAGE_EVIDENCE_FILES,
  MAX_COVERAGE_EVIDENCE_RANGES,
  coverageGoalSchema,
  differentialLaneResultSchema,
  dynamicStrategyPlanSchema,
  analysisBundleManifestJsonSchema,
  artifactContractDefinition,
  artifactContractSchemaBinding,
  artifactSchemaBundleDigest,
  artifactSchemaRegistryFromDirectory,
  createInitialRunState,
  assertGeneratedTestManifestSchema,
  assertPlannedGraph,
  assertSealedPlannedGraph,
  assertPlannedGraphSemantics,
  derivePropertyImplementationCoverage,
  findingNoteAssignmentIssue,
  executeSemanticGate,
  findingReportSemanticAssignment,
  findingJsonSchema,
  findingSchema,
  generatedTestsJsonSchema,
  goalPlanJsonSchema,
  threatModelJsonSchema,
  GOAL_PLAN_JSON_SCHEMA_ID,
  THREAT_MODEL_JSON_SCHEMA_ID,
  invariantLedgerJsonSchema,
  invariantSourceProofJsonSchema,
  lensPropertiesJsonSchema,
  nodeAttemptLedgerJsonSchema,
  propertiesJsonSchema,
  propertyCampaignJsonSchema,
  plannedGraphJsonSchema,
  referenceExpectationsJsonSchema,
  reportSchema,
  runStateJsonSchema,
  semanticRedRegistrySchema,
  severityClassifiedFindingsSchema,
  validateAnalysisBundleManifestSchema,
  usageLedgerJsonSchema,
  workspacePatchJsonSchema,
  validateFindingSchema,
  validateFindingsSchema,
  validateGeneratedTestManifestSchema,
  validateInvariantLedgerSchema,
  validateInvariantSourceProofSchema,
  validateImplementedPropertiesSchema,
  validateLensPropertiesSchema,
  validateReferenceExpectationsSchema,
  validateArtifactContract,
  validateNodeAttemptLedgerEntry,
  validatePropertiesSchema,
  validatePlannedGraph,
  validatePropertyCampaignSchema,
  validatePropertyReferences,
  validateRunStateSchema,
  validateUsageLedgerEntry,
  schemaRegistryBundleDigest,
  materializePromptSchemas,
  ARTIFACT_CONTRACT_SCHEMA_FILES,
  artifactContractSchemaFile,
  isArtifactContractId,
  type ArtifactContractId,
  type PlannedGraphDocument,
  type PlannedGraphNodeDocument,
  smithersTaskManifestJsonSchema,
  triagedFindingsSchema,
  trustedCliMetadataJsonSchema
} from "../src/index.js";

const packageRoot = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));

function schemaPatterns(schema: unknown): ReadonlySet<string> {
  const patterns = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.pattern === "string") patterns.add(record.pattern);
    for (const item of Object.values(record)) visit(item);
  };
  visit(schema);
  return patterns;
}

test("planned outputs, manifests, markers, and campaign documents share one artifact path grammar", () => {
  assert.equal(artifactManifestJsonSchema.$defs.safePath.pattern, CANONICAL_ARTIFACT_RELATIVE_PATH_PATTERN);
  assert.equal(artifactVerificationJsonSchema.$defs.safePath.pattern, CANONICAL_ARTIFACT_RELATIVE_PATH_PATTERN);
  assert.equal(plannedGraphJsonSchema.$defs.safePath.pattern, CANONICAL_ARTIFACT_RELATIVE_PATH_PATTERN);
  assert.ok(schemaPatterns(smithersTaskManifestJsonSchema).has(CANONICAL_ARTIFACT_RELATIVE_PATH_PATTERN));
  assert.ok(schemaPatterns(propertyCampaignJsonSchema).has(CANONICAL_ARTIFACT_RELATIVE_PATH_PATTERN));
});

test("materializes the checked-in JSON schema bundle into a task-local directory", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-schema-bundle-"));
  try {
    const destination = path.join(root, "workspace", ".ultrafuzz", "schemas");
    const copied = materializePromptSchemas(destination);
    assert.ok(copied.some((file) => file.endsWith("property-lens.schema.json")));
    assert.ok(copied.some((file) => file.endsWith("properties.schema.json")));
    assert.ok(copied.some((file) => file.endsWith("reference-expectations.schema.json")));
    assert.ok(copied.some((file) => file.endsWith("invariant-evidence-ledger.schema.json")));
    assert.ok(copied.some((file) => file.endsWith("invariant-source-proof.schema.json")));
    assert.ok(readdirSync(destination).every((file) => file.endsWith(".schema.json")));
    assert.equal(statSync(path.join(destination, "property-lens.schema.json")).isFile(), true);
    assert.equal(statSync(path.join(destination, "reference-expectations.schema.json")).isFile(), true);
    assert.equal(statSync(path.join(destination, "property-lens.schema.json")).mode & 0o777, 0o400);
    assert.equal(statSync(destination).mode & 0o777, 0o700);
  } finally {
    for (const file of readdirSync(path.join(root, "workspace", ".ultrafuzz", "schemas"))) {
      fs.chmodSync(path.join(root, "workspace", ".ultrafuzz", "schemas", file), 0o600);
    }
    fs.chmodSync(path.join(root, "workspace", ".ultrafuzz", "schemas"), 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

test("loads only a complete physical sealed schema bundle", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-sealed-schema-bundle-"));
  const destination = path.join(root, "schemas");
  try {
    materializePromptSchemas(destination);
    assert.equal(
      schemaRegistryBundleDigest(artifactSchemaRegistryFromDirectory(destination)),
      artifactSchemaBundleDigest()
    );

    const linked = path.join(root, "linked-schemas");
    fs.symlinkSync(destination, linked, "dir");
    assert.throws(() => artifactSchemaRegistryFromDirectory(linked), /snapshot directory is unsafe/u);

    fs.chmodSync(destination, 0o700);
    fs.writeFileSync(path.join(destination, "foreign.schema.json"), "{}\n", "utf8");
    assert.throws(() => artifactSchemaRegistryFromDirectory(destination), /registry mismatch/u);
  } finally {
    fs.chmodSync(destination, 0o700);
    for (const file of readdirSync(destination)) fs.chmodSync(path.join(destination, file), 0o600);
    rmSync(root, { recursive: true, force: true });
  }
});

test("every contract-to-schema mapping names a file the bundle actually materializes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-schema-map-"));
  try {
    const destination = path.join(root, "workspace", ".ultrafuzz", "schemas");
    materializePromptSchemas(destination);
    const materialized = new Set(readdirSync(destination));

    const mapped = Object.entries(ARTIFACT_CONTRACT_SCHEMA_FILES);
    assert.ok(mapped.length > 0);
    for (const [contract, schemaFile] of mapped) {
      // A stale entry would hand every producer of this contract a path that
      // does not exist, which is worse than saying nothing about schemas.
      assert.equal(materialized.has(schemaFile as string), true, `${contract} -> ${String(schemaFile)}`);
      assert.equal(isArtifactContractId(contract), true, contract);
      assert.equal(artifactContractSchemaFile(contract as ArtifactContractId), schemaFile);
    }
  } finally {
    for (const file of readdirSync(path.join(root, "workspace", ".ultrafuzz", "schemas"))) {
      fs.chmodSync(path.join(root, "workspace", ".ultrafuzz", "schemas", file), 0o600);
    }
    fs.chmodSync(path.join(root, "workspace", ".ultrafuzz", "schemas"), 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

test("materialized schema directory can be removed by its owning worktree cleanup", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-schema-cleanup-"));
  const destination = path.join(root, "workspace", ".ultrafuzz", "schemas");
  materializePromptSchemas(destination);

  assert.equal(statSync(destination).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(destination, "property-lens.schema.json")).mode & 0o777, 0o400);
  assert.doesNotThrow(() => rmSync(root, { recursive: true, force: true }));
});

test("rejects a hard-linked schema destination before changing its inode", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-schema-hardlink-"));
  const destination = path.join(root, "workspace", ".ultrafuzz", "schemas");
  const outside = path.join(root, "outside.json");
  try {
    materializePromptSchemas(destination);
    const schema = path.join(destination, "property-lens.schema.json");
    fs.chmodSync(destination, 0o700);
    fs.unlinkSync(schema);
    fs.writeFileSync(outside, "outside\n");
    fs.linkSync(outside, schema);
    fs.chmodSync(destination, 0o500);

    assert.throws(() => materializePromptSchemas(destination), /destination entry is unsafe/u);
    assert.equal(fs.readFileSync(outside, "utf8"), "outside\n");
  } finally {
    fs.chmodSync(destination, 0o700);
    for (const file of readdirSync(destination)) {
      fs.chmodSync(path.join(destination, file), 0o600);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a schema destination that crosses an intermediate symlink", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-schema-symlink-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(workspace, ".ultrafuzz"), "dir");
  try {
    assert.throws(
      () => materializePromptSchemas(path.join(workspace, ".ultrafuzz", "schemas")),
      /destination crosses a symlink/u
    );
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact contract registry exposes only current typed contracts", () => {
  const definition = artifactContractDefinition("ultrafuzz/report@3");
  assert.match(definition.digest, /^[0-9a-f]{64}$/u);
  assert.equal(validateArtifactContract("ultrafuzz/findings@2", "[]").ok, true);
  assert.equal(validateArtifactContract("ultrafuzz/nonempty-markdown@1", " \n").ok, false);
  assert.equal(validateArtifactContract("ultrafuzz/text@1", "").ok, true);

  for (const removed of [
    "ultrafuzz/json-object@1",
    "ultrafuzz/json-array@1",
    "ultrafuzz/findings@1",
    "ultrafuzz/generated-tests@1",
    "ultrafuzz/implemented-properties@1",
    "ultrafuzz/implemented-properties@2",
    "ultrafuzz/invariant-campaign-plan@1",
    "ultrafuzz/properties@1",
    "ultrafuzz/property-campaign@1",
    "ultrafuzz/property-campaign@2",
    "ultrafuzz/property-lens@1",
    "ultrafuzz/reference-expectations@1",
    "ultrafuzz/report@1"
  ]) {
    assert.equal(isArtifactContractId(removed), false, removed);
  }

  for (const id of ARTIFACT_CONTRACT_IDS) {
    const contract = artifactContractDefinition(id);
    if (contract.validEmptyExample !== undefined) {
      assert.equal(validateArtifactContract(id, contract.validEmptyExample).ok, true, id);
    }
  }
});
test("invariant evidence ledger preserves verbatim source entries and inventory joins", () => {
  const ledger = {
    schema_version: INVARIANT_LEDGER_SCHEMA_VERSION,
    entries: [
      {
        id: "evidence-1",
        source_path: "docs/overview.md",
        source_location: "lines 54-57",
        kind: "inequality",
        verbatim: "Total borrowed assets <= total supplied assets",
        inventory_ids: ["inventory-hub-borrowed-assets"]
      },
      {
        id: "evidence-2",
        source_path: "tests/recon/Properties.sol",
        source_location: "invariant_totalBorrowedLessThanSupplied_v1",
        kind: "invariant",
        verbatim: "totalBorrowed <= totalSupplied",
        inventory_ids: ["inventory-hub-borrowed-assets", "inventory-hub-solvency-v1"]
      }
    ],
    inventory_rows: [
      {
        id: "inventory-hub-borrowed-assets",
        description: "Hub borrowed assets remain at or below supplied assets.",
        ledger_ids: ["evidence-1", "evidence-2"]
      },
      {
        id: "inventory-hub-solvency-v1",
        description: "Aggregate borrowed and supplied assets remain solvent.",
        ledger_ids: ["evidence-2"]
      }
    ],
    scan_probes: []
  };

  const result = validateInvariantLedgerSchema(ledger, "ledger.json");
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, ledger);
  assert.equal(
    validateArtifactContract("ultrafuzz/invariant-ledger@1", JSON.stringify(ledger), "ledger.json").ok,
    true
  );

  const contradictory = structuredClone(ledger);
  contradictory.inventory_rows[0]!.ledger_ids = ["evidence-1"];
  const contradictoryResult = validateInvariantLedgerSchema(contradictory);
  assert.equal(contradictoryResult.ok, false);
  assert.ok(contradictoryResult.issues.some((issue) => /does not link back/u.test(issue.message)));
});

test("invariant evidence ledger rejects duplicate entries, duplicate inventory joins, and invalid prefixes", () => {
  const base = {
    schema_version: INVARIANT_LEDGER_SCHEMA_VERSION,
    entries: [
      {
        id: "evidence-1",
        source_path: "docs/overview.md",
        source_location: "lines 54-57",
        kind: "inequality",
        verbatim: "Total borrowed assets <= total supplied assets",
        inventory_ids: ["inventory-hub-borrowed-assets"]
      }
    ],
    inventory_rows: [
      {
        id: "inventory-hub-borrowed-assets",
        description: "Hub borrowed assets remain at or below supplied assets.",
        ledger_ids: ["evidence-1"]
      }
    ],
    scan_probes: []
  };

  const duplicateEntry = structuredClone(base);
  duplicateEntry.entries.push(structuredClone(base.entries[0]!));
  const duplicateEntryResult = validateInvariantLedgerSchema(duplicateEntry);
  assert.equal(duplicateEntryResult.ok, false);
  assert.ok(duplicateEntryResult.issues.some((issue) => /Duplicate ledger entry ID/u.test(issue.message)));

  const duplicateInventory = structuredClone(base);
  duplicateInventory.entries[0]!.inventory_ids = ["inventory-hub-borrowed-assets", "inventory-hub-borrowed-assets"];
  const duplicateInventoryResult = validateInvariantLedgerSchema(duplicateInventory);
  assert.equal(duplicateInventoryResult.ok, false);
  assert.ok(duplicateInventoryResult.issues.some((issue) => /Duplicate inventory ID/u.test(issue.message)));

  const invalidPrefix = structuredClone(base);
  invalidPrefix.entries[0]!.inventory_ids = ["hub-borrowed-assets"];
  const invalidPrefixResult = validateInvariantLedgerSchema(invalidPrefix);
  assert.equal(invalidPrefixResult.ok, false);
  assert.ok(invalidPrefixResult.issues.some((issue) => /inventory-|pattern/u.test(issue.message)));

  const duplicateProbe = {
    ...structuredClone(base),
    entries: [],
    inventory_rows: [],
    no_invariants_justification: "Searched the documented invariant surfaces and found no invariant statements.",
    scan_probes: [
      {
        id: "probe-docs-no-invariants",
        source_path: "docs/overview.md",
        query: "invariant|accounting|solvency",
        result: "No explicit invariant statements found"
      },
      {
        id: "probe-docs-no-invariants",
        source_path: "docs/overview.md",
        query: "invariant|accounting|solvency",
        result: "No explicit invariant statements found"
      }
    ]
  };
  const duplicateProbeResult = validateInvariantLedgerSchema(duplicateProbe);
  assert.equal(duplicateProbeResult.ok, false);
  assert.ok(duplicateProbeResult.issues.some((issue) => /Duplicate scan probe ID/u.test(issue.message)));

  const legacyShape = structuredClone(base) as Record<string, unknown>;
  delete legacyShape.inventory_rows;
  delete legacyShape.scan_probes;
  const legacyShapeResult = validateInvariantLedgerSchema(legacyShape);
  assert.equal(legacyShapeResult.ok, false);
  assert.ok(legacyShapeResult.issues.some((issue) => /include inventory_rows/u.test(issue.message)));

  const noEvidenceWithoutProbe = {
    ...structuredClone(base),
    entries: [],
    inventory_rows: [],
    scan_probes: []
  };
  const noEvidenceWithoutProbeResult = validateInvariantLedgerSchema(noEvidenceWithoutProbe);
  assert.equal(noEvidenceWithoutProbeResult.ok, false);
  assert.ok(noEvidenceWithoutProbeResult.issues.some((issue) => /at least one scan probe/u.test(issue.message)));
});

test("invariant source proofs bind immutable text snapshots to a ledger digest", () => {
  const proof = {
    schema_version: INVARIANT_SOURCE_PROOF_SCHEMA_VERSION,
    attempt_id: "project-discovery",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    ledger_sha256: "c".repeat(64),
    files: [
      { path: "docs/Some File.md", sha256: "d".repeat(64), content: "Total borrowed assets <= total supplied assets" }
    ]
  };
  assert.equal(validateInvariantSourceProofSchema(proof).ok, true);
  assert.deepEqual(invariantSourceProofJsonSchema.required, [
    "schema_version",
    "attempt_id",
    "commit",
    "tree",
    "ledger_sha256",
    "files"
  ]);
  const binary = structuredClone(proof);
  binary.files[0]!.content = "\u0000";
  assert.equal(validateInvariantSourceProofSchema(binary).ok, false);
  const duplicate = structuredClone(proof);
  duplicate.files.push({ ...duplicate.files[0]! });
  assert.equal(validateInvariantSourceProofSchema(duplicate).ok, false);
});

test("finding schema accepts a canonical v2 finding and rejects malformed payloads", () => {
  const finding = {
    schema_version: FINDINGS_SCHEMA_VERSION,
    id: "finding-1",
    title: "Unbounded input",
    status: "candidate",
    severity_guess: "High",
    confidence: "medium",
    summary: "Input length reaches an expensive path."
  };

  const findings = [finding];
  const before = structuredClone(findings);
  const findingValidation = validateFindingSchema(finding);
  const findingsValidation = validateFindingsSchema(findings);

  assert.equal(findingValidation.ok, true);
  assert.equal(findingValidation.value, finding);
  assert.equal(findingsValidation.ok, true);
  assert.equal(findingsValidation.value, findings);
  assert.deepEqual(findings, before);

  const missingSummary = { ...finding };
  delete (missingSummary as Partial<typeof finding>).summary;
  const invalid = validateFindingSchema(missingSummary);

  assert.equal(invalid.ok, false);
  assert.ok(
    invalid.issues.some(
      (issue) => issue.path === "$" && issue.code === "FINDING_SCHEMA_INVALID" && issue.message.includes("summary")
    )
  );
});

test("property catalog schema accepts one source and preserves multiple deduplicated sources", () => {
  const oneSource = {
    schema_version: PROPERTIES_SCHEMA_VERSION,
    properties: [
      {
        id: "property-1",
        description: "Balances remain conserved",
        category: "accounting",
        priority: "high",
        sources: [
          {
            source_node_id: "property-specification-certora",
            source_property_id: "certora-1"
          }
        ]
      }
    ]
  };
  assert.equal(validatePropertiesSchema(oneSource).ok, true);

  const deduplicated = structuredClone(oneSource);
  deduplicated.properties[0]!.sources.push({
    source_node_id: "property-specification-crytic",
    source_property_id: "crytic-2"
  });
  const result = validatePropertiesSchema(deduplicated);
  assert.equal(result.ok, true);
  assert.equal(result.value?.properties[0]?.sources.length, 2);

  const sourceWithExtra = {
    ...oneSource,
    properties: [
      {
        ...oneSource.properties[0]!,
        sources: [
          {
            ...oneSource.properties[0]!.sources[0]!,
            note: "extra source metadata"
          }
        ]
      }
    ]
  };
  const invalidSource = validatePropertiesSchema(sourceWithExtra);
  assert.equal(invalidSource.ok, false);
  assert.deepEqual(invalidSource.issues, [
    {
      path: "$.properties[0].sources[0]",
      code: "PROPERTIES_SCHEMA_INVALID",
      message: "must NOT have additional properties"
    }
  ]);

  const duplicateLedgerIds = {
    ...oneSource,
    properties: [{ ...oneSource.properties[0]!, ledger_ids: ["evidence-1", "evidence-1"] }]
  };
  const invalidLedgerIds = validatePropertiesSchema(duplicateLedgerIds);
  assert.equal(invalidLedgerIds.ok, false);
  assert.ok(invalidLedgerIds.issues.some((issue) => /duplicate items/u.test(issue.message)));
});

test("property lens schema requires canonical priorities and unique reference IDs", () => {
  const valid = {
    schema_version: PROPERTY_LENS_SCHEMA_VERSION,
    properties: [
      {
        id: "aviggiano-001",
        description: "Expected behavior",
        category: "accounting",
        priority: "high",
        reference_expectations: ["scfuzzbench:aave-v4:iSpoke_supply"]
      }
    ]
  };
  assert.equal(validateLensPropertiesSchema(valid).ok, true);
  assert.equal(
    validateLensPropertiesSchema({
      ...valid,
      properties: [{ ...valid.properties[0], priority: "Critical" }]
    }).ok,
    false
  );
  assert.equal(
    validateLensPropertiesSchema({
      ...valid,
      properties: [
        {
          ...valid.properties[0],
          reference_expectations: ["scfuzzbench:aave-v4:iSpoke_supply", "scfuzzbench:aave-v4:iSpoke_supply"]
        }
      ]
    }).ok,
    false,
    "reference expectation IDs must be unique"
  );
});

test("property lens and reference catalog validators expose Ajv additionalProperties diagnostics", () => {
  const lens = validateLensPropertiesSchema(
    {
      schema_version: PROPERTY_LENS_SCHEMA_VERSION,
      properties: [
        {
          id: "aviggiano-001",
          description: "Expected behavior",
          category: "accounting",
          priority: "high",
          undeclared: true
        }
      ]
    },
    "lens.json"
  );
  assert.equal(lens.ok, false);
  assert.deepEqual(lens.issues, [
    {
      path: "lens.json.properties[0]",
      code: "PROPERTY_LENS_SCHEMA_INVALID",
      message: "must NOT have additional properties"
    }
  ]);

  const expectations = validateReferenceExpectationsSchema(
    {
      schema_version: REFERENCE_EXPECTATIONS_SCHEMA_VERSION,
      expectations: [{ id: "benchmark:expectation", undeclared: true }]
    },
    "expectations.json"
  );
  assert.equal(expectations.ok, false);
  assert.deepEqual(expectations.issues, [
    {
      path: "expectations.json.expectations[0]",
      code: "REFERENCE_EXPECTATIONS_SCHEMA_INVALID",
      message: "must NOT have additional properties"
    }
  ]);
});

test("canonical property, implementation, and campaign validators are registered-Ajv-first", () => {
  const properties = {
    schema_version: PROPERTIES_SCHEMA_VERSION,
    properties: [
      {
        id: "property-1",
        description: "Balances remain conserved",
        category: "accounting",
        priority: "high" as const,
        sources: [{ source_node_id: "property-specification-recon", source_property_id: "recon-1" }]
      }
    ]
  };
  const validProperties = validatePropertiesSchema(properties, "properties.json");
  assert.equal(validProperties.ok, true);
  assert.equal(validProperties.value, properties, "typed access must retain the exact Ajv-approved input object");
  const invalidProperties = validatePropertiesSchema(
    {
      ...properties,
      properties: [{ ...properties.properties[0]!, undeclared: true }]
    },
    "properties.json"
  );
  assert.deepEqual(invalidProperties.issues, [
    {
      path: "properties.json.properties[0]",
      code: "PROPERTIES_SCHEMA_INVALID",
      message: "must NOT have additional properties"
    }
  ]);

  const implementation = {
    schema_version: IMPLEMENTED_PROPERTIES_SCHEMA_VERSION,
    selection: { priority_threshold: "high" as const, priorities: ["high" as const], property_ids: ["property-1"] },
    properties: [
      {
        property_id: "property-1",
        status: "implemented" as const,
        implementation_paths: ["test/recon/Properties.sol"],
        test_paths: []
      }
    ]
  };
  const validImplementation = validateImplementedPropertiesSchema(implementation, "implemented-properties.json", {
    requireSelection: true
  });
  assert.equal(validImplementation.ok, true);
  assert.equal(
    validImplementation.value,
    implementation,
    "retained Zod parity must not transform an Ajv-approved implementation"
  );
  const invalidImplementation = validateImplementedPropertiesSchema(
    {
      ...implementation,
      properties: [{ ...implementation.properties[0]!, undeclared: true }]
    },
    "implemented-properties.json",
    { requireSelection: true }
  );
  assert.deepEqual(invalidImplementation.issues, [
    {
      path: "implemented-properties.json.properties[0]",
      code: "IMPLEMENTED_PROPERTIES_SCHEMA_INVALID",
      message: "must NOT have additional properties"
    }
  ]);

  const campaign = {
    schema_version: PROPERTY_CAMPAIGN_SCHEMA_VERSION,
    campaign_plan_ref: "invariant-campaign-plan.json",
    implemented_properties_ref: "implemented-properties.json",
    findings_ref: "findings.json",
    campaign_summary_ref: "campaign-summary.json",
    fuzzer_backend: "recon",
    backend_version: "0.1.0",
    execution: {
      status: "complete",
      usable_results: true,
      command: "recon fuzz .",
      config_path: "recon.config.json",
      workers: 1,
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:05:00Z",
      deadline: "2026-01-01T00:10:00Z",
      exit_code: 0,
      failure: null
    },
    paths: {
      corpus: "backends/recon-fuzzer/corpus",
      cache: "backends/recon-fuzzer/cache",
      log: "backends/recon-fuzzer/run.log",
      raw_results: "backends/recon-fuzzer/results.json",
      reproducers: "backends/recon-fuzzer/reproducers"
    },
    evidence_files: [
      {
        path: "backends/recon-fuzzer/run.log",
        size_bytes: 1,
        sha256: "a".repeat(64)
      },
      {
        path: "backends/recon-fuzzer/results.json",
        size_bytes: 1,
        sha256: "b".repeat(64)
      },
      {
        path: "backends/recon-fuzzer/reproducers/failure-1.t.sol",
        size_bytes: 1,
        sha256: "c".repeat(64)
      }
    ],
    coverage: {
      status: "reported",
      metrics: [{ name: "runs", value: 10, unit: "count", source_ref: "backends/recon-fuzzer/results.json" }],
      unavailable_reason: null
    },
    property_results: [
      {
        property_id: "property-1",
        status: "failed",
        failure_ids: ["failure-1"],
        coverage_metric_names: ["runs"],
        evidence_refs: ["backends/recon-fuzzer/results.json"],
        reason: null
      }
    ],
    failures: [
      {
        id: "failure-1",
        status: "reproduced",
        property_ids: ["property-1"],
        entrypoint: "handler.deposit(uint256)",
        sequence: ["deposit(1)"],
        precondition_evidence: ["balance was nonzero"],
        raw_reproducer_ref: "backends/recon-fuzzer/results.json",
        deterministic_reproducer_ref: "backends/recon-fuzzer/reproducers/failure-1.t.sol",
        reproduction_blocker: null
      }
    ]
  };
  const validCampaign = validatePropertyCampaignSchema(campaign, "campaign.json");
  assert.equal(validCampaign.ok, true);
  assert.equal(validCampaign.value, campaign, "retained Zod parity must not transform an Ajv-approved campaign");
  const invalidCampaign = validatePropertyCampaignSchema(
    {
      ...campaign,
      failures: [{ ...campaign.failures[0]!, undeclared: true }]
    },
    "campaign.json"
  );
  assert.deepEqual(invalidCampaign.issues, [
    {
      path: "campaign.json.failures[0]",
      code: "PROPERTY_CAMPAIGN_SCHEMA_INVALID",
      message: "must NOT have additional properties"
    }
  ]);
});

test("canonical property schema preserves typed benchmark expectations", () => {
  const valid = {
    schema_version: PROPERTIES_SCHEMA_VERSION,
    properties: [
      {
        id: "property-1",
        description: "Supply remains live for valid state",
        category: "dos-liveness",
        priority: "medium",
        reference_expectations: ["scfuzzbench:aave-v4:iSpoke_supply"],
        sources: [{ source_node_id: "property-specification-recon", source_property_id: "iSpoke_supply" }]
      }
    ]
  };
  assert.equal(validatePropertiesSchema(valid).ok, true);
  assert.equal(
    validatePropertiesSchema({
      ...valid,
      properties: [
        {
          ...valid.properties[0],
          reference_expectations: ["scfuzzbench:aave-v4:iSpoke_supply", "scfuzzbench:aave-v4:iSpoke_supply"]
        }
      ]
    }).ok,
    false
  );
});

test("property implementation and campaign schemas retain canonical references", () => {
  const implemented = {
    schema_version: IMPLEMENTED_PROPERTIES_SCHEMA_VERSION,
    selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] },
    properties: [
      {
        property_id: "property-1",
        status: "implemented",
        implementation_paths: ["test/recon/Properties.sol"],
        test_paths: ["test/foundry/Property1.t.sol"]
      }
    ]
  };
  assert.equal(validateImplementedPropertiesSchema(implemented).ok, true);
  const campaign = {
    schema_version: PROPERTY_CAMPAIGN_SCHEMA_VERSION,
    campaign_plan_ref: "invariant-campaign-plan.json",
    implemented_properties_ref: "implemented-properties.json",
    findings_ref: "findings.json",
    campaign_summary_ref: "campaign-summary.json",
    fuzzer_backend: "recon",
    backend_version: "0.1.0",
    execution: {
      status: "complete",
      usable_results: true,
      command: "recon fuzz .",
      config_path: "recon.config.json",
      workers: 1,
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:05:00Z",
      deadline: "2026-01-01T00:10:00Z",
      exit_code: 0,
      failure: null
    },
    paths: {
      corpus: "backends/recon-fuzzer/corpus",
      cache: "backends/recon-fuzzer/cache",
      log: "backends/recon-fuzzer/run.log",
      raw_results: "backends/recon-fuzzer/results.json",
      reproducers: "backends/recon-fuzzer/reproducers"
    },
    evidence_files: [
      {
        path: "backends/recon-fuzzer/run.log",
        size_bytes: 1,
        sha256: "a".repeat(64)
      },
      {
        path: "backends/recon-fuzzer/results.json",
        size_bytes: 1,
        sha256: "b".repeat(64)
      },
      {
        path: "backends/recon-fuzzer/reproducers/failure-1.t.sol",
        size_bytes: 1,
        sha256: "c".repeat(64)
      }
    ],
    coverage: {
      status: "reported",
      metrics: [{ name: "runs", value: 10, unit: "count", source_ref: "backends/recon-fuzzer/results.json" }],
      unavailable_reason: null
    },
    property_results: [
      {
        property_id: "property-1",
        status: "failed",
        failure_ids: ["failure-1"],
        coverage_metric_names: ["runs"],
        evidence_refs: ["backends/recon-fuzzer/results.json"],
        reason: null
      }
    ],
    failures: [
      {
        id: "failure-1",
        status: "reproduced",
        property_ids: ["property-1"],
        entrypoint: "handler.deposit(uint256)",
        sequence: ["deposit(1)"],
        precondition_evidence: ["balance was nonzero"],
        raw_reproducer_ref: "backends/recon-fuzzer/results.json",
        deterministic_reproducer_ref: "backends/recon-fuzzer/reproducers/failure-1.t.sol",
        reproduction_blocker: null
      }
    ]
  };
  assert.equal(validatePropertyCampaignSchema(campaign).ok, true);
  assert.equal(
    validatePropertyCampaignSchema({
      ...campaign,
      failures: [{ ...campaign.failures[0], property_ids: ["property-1", "property-1"] }]
    }).ok,
    false,
    "campaign property references must be unambiguous"
  );
});

test("property implementation schema rejects source-less implemented records", () => {
  const sourceLess = {
    schema_version: IMPLEMENTED_PROPERTIES_SCHEMA_VERSION,
    selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] },
    properties: [
      {
        property_id: "property-1",
        status: "implemented",
        implementation_paths: [],
        test_paths: []
      }
    ]
  };

  const invalid = validateImplementedPropertiesSchema(sourceLess);
  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.issues, [
    {
      path: "$.properties[0]",
      code: "IMPLEMENTED_PROPERTIES_SCHEMA_INVALID",
      message: 'must match "then" schema'
    },
    {
      path: "$.properties[0]",
      code: "IMPLEMENTED_PROPERTIES_SCHEMA_INVALID",
      message: "must NOT be valid"
    }
  ]);
});

test("property implementation schema accepts selection metadata and typed blockers", () => {
  const selected = {
    schema_version: IMPLEMENTED_PROPERTIES_SCHEMA_VERSION,
    selection: {
      priority_threshold: "high",
      priorities: ["high"],
      property_ids: ["property-1"]
    },
    properties: [
      {
        property_id: "property-1",
        status: "blocked",
        implementation_paths: [],
        test_paths: [],
        blocker: {
          code: "missing-oracle",
          summary: "The target exposes no stable getter.",
          next_action: "Add a read-only harness oracle."
        }
      }
    ]
  };
  assert.equal(validateImplementedPropertiesSchema(selected).ok, true);
  assert.equal(
    validateImplementedPropertiesSchema({
      ...selected,
      properties: [{ ...selected.properties[0], blocker: { code: "missing-oracle", summary: "", next_action: "" } }]
    }).ok,
    false,
    "blocker fields must carry actionable text"
  );
});

test("derives complete report implementation coverage only from authoritative property evidence", () => {
  const catalog = validatePropertiesSchema({
    schema_version: PROPERTIES_SCHEMA_VERSION,
    properties: [
      {
        id: "property-high",
        description: "High-priority implementation",
        category: "accounting",
        priority: "high",
        sources: [{ source_node_id: "lens-a", source_property_id: "high-1" }]
      },
      {
        id: "property-low-reference",
        description: "Reference property below the threshold",
        category: "liveness",
        priority: "low",
        reference_expectations: ["benchmark:expected-low", "benchmark:shared"],
        sources: [{ source_node_id: "lens-b", source_property_id: "low-1" }]
      },
      {
        id: "property-medium",
        description: "Blocked medium-priority implementation",
        category: "access-control",
        priority: "medium",
        reference_expectations: ["benchmark:shared"],
        sources: [{ source_node_id: "lens-c", source_property_id: "medium-1" }]
      },
      {
        id: "property-pending",
        description: "Pending high-priority implementation",
        category: "state-transition",
        priority: "high",
        sources: [{ source_node_id: "lens-d", source_property_id: "pending-1" }]
      }
    ]
  });
  const implementation = validateImplementedPropertiesSchema(
    {
      schema_version: IMPLEMENTED_PROPERTIES_SCHEMA_VERSION,
      selection: {
        priority_threshold: "medium",
        priorities: ["high", "medium"],
        property_ids: ["property-high", "property-low-reference", "property-medium", "property-pending"]
      },
      properties: [
        {
          property_id: "property-high",
          status: "implemented",
          implementation_paths: ["src/Properties.sol"],
          test_paths: []
        },
        {
          property_id: "property-low-reference",
          status: "deferred",
          implementation_paths: [],
          test_paths: [],
          reference_expectations: ["benchmark:expected-low", "benchmark:shared"],
          blocker: {
            code: "reference-harness-missing",
            summary: "The reference harness does not expose the transition.",
            next_action: "Add a reference-aware handler."
          }
        },
        {
          property_id: "property-medium",
          status: "blocked",
          implementation_paths: [],
          test_paths: [],
          reference_expectations: ["benchmark:shared"],
          blocker: {
            code: "oracle-missing",
            summary: "The target exposes no stable accounting getter.",
            next_action: "Add a read-only oracle."
          }
        },
        {
          property_id: "property-pending",
          status: "pending",
          implementation_paths: [],
          test_paths: [],
          blocker: {
            code: "pending-review",
            summary: "The generated handler requires bounded manual review.",
            next_action: "Review and bind the handler."
          }
        }
      ]
    },
    "implemented-properties.json",
    { requireSelection: true }
  );
  assert.ok(catalog.value);
  assert.ok(implementation.value);

  const result = derivePropertyImplementationCoverage(catalog.value!, implementation.value!, {
    configuredSelection: { priority_threshold: "medium", priorities: ["high", "medium"] },
    requireConfiguredSelection: true
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(result.value, {
    priority_threshold: "medium",
    priorities: ["high", "medium"],
    selected_property_ids: ["property-high", "property-low-reference", "property-medium", "property-pending"],
    implemented_property_ids: ["property-high"],
    blocked_property_ids: ["property-medium"],
    pending_property_ids: ["property-pending"],
    deferred_property_ids: ["property-low-reference"],
    reference_expected_property_ids: ["property-low-reference", "property-medium"],
    reference_expectation_ids: ["benchmark:expected-low", "benchmark:shared"],
    blocker_summaries: [
      "property-low-reference: The reference harness does not expose the transition.",
      "property-medium: The target exposes no stable accounting getter.",
      "property-pending: The generated handler requires bounded manual review."
    ]
  });

  const wrongConfig = derivePropertyImplementationCoverage(catalog.value!, implementation.value!, {
    configuredSelection: { priority_threshold: "high", priorities: ["high"] },
    requireConfiguredSelection: true
  });
  assert.equal(wrongConfig.ok, false);
  assert.ok(wrongConfig.issues.some((issue) => issue.code === "PROPERTY_IMPLEMENTATION_SELECTION_CONFIG_MISMATCH"));

  const missingConfig = derivePropertyImplementationCoverage(catalog.value!, implementation.value!, {
    requireConfiguredSelection: true
  });
  assert.equal(missingConfig.ok, false);
  assert.ok(missingConfig.issues.some((issue) => issue.code === "PROPERTY_IMPLEMENTATION_CONFIG_MISSING"));
});
test("unknown canonical property references produce a clear diagnostic", () => {
  const catalog = {
    schema_version: PROPERTIES_SCHEMA_VERSION,
    properties: [
      {
        id: "property-1",
        description: "Balances remain conserved",
        category: "accounting",
        priority: "high",
        sources: [{ source_node_id: "property-specification-certora", source_property_id: "certora-1" }]
      }
    ]
  };
  const parsed = validatePropertiesSchema(catalog);
  assert.ok(parsed.value);
  assert.deepEqual(validatePropertyReferences(parsed.value!, [{ propertyIds: ["property-unknown"], path: "$ref" }]), [
    {
      code: "PROPERTY_REFERENCE_UNKNOWN",
      message: 'Unknown canonical property ID "property-unknown"',
      path: "$ref"
    }
  ]);
});

test("the findings v2 contract rejects aliases, omissions, lowercase severities, and extra fields", () => {
  const finding = {
    schema_version: FINDINGS_SCHEMA_VERSION,
    id: "failure-1",
    title: "Harness drawn-rate sync assertion ignores elapsed-time precondition",
    status: "confirmed",
    severity_guess: "Low",
    confidence: "high",
    summary: "The stored drawn rate lags the recalculated one after time advances.",
    property_ids: ["property-99"]
  };
  assert.equal(validateArtifactContract("ultrafuzz/findings@2", JSON.stringify([finding])).ok, true);
  assert.equal(validateFindingsSchema([finding]).ok, true);
  assert.equal(validateFindingSchema(finding).ok, true);

  for (const schemaVersion of ["ultrafuzz.finding.v1", "1.0", undefined]) {
    const candidate: Record<string, unknown> = { ...finding, schema_version: schemaVersion };
    if (schemaVersion === undefined) delete candidate.schema_version;
    assert.equal(validateArtifactContract("ultrafuzz/findings@2", JSON.stringify([candidate])).ok, false);
    assert.equal(validateFindingSchema(candidate).ok, false);
  }
  assert.equal(validateFindingSchema({ ...finding, severity_guess: "low" }).ok, false);
  assert.equal(validateFindingSchema({ ...finding, unexpected: true }).ok, false);

  const canonicalStrategyProvenance = {
    ...finding,
    strategy_provenance: {
      detection_rates: [{ strategy: "stateful-invariant", detections: 1, configured_loops: 2 }]
    }
  };
  assert.equal(validateFindingSchema(canonicalStrategyProvenance).ok, true);
  assert.equal(
    validateArtifactContract("ultrafuzz/findings@2", JSON.stringify([canonicalStrategyProvenance])).ok,
    true
  );
  const removedStrategyAlias = {
    ...finding,
    strategy_provenance: {
      strategies: [{ strategy: "stateful-invariant", detections: 1, configured_loops: 2 }]
    }
  };
  assert.equal(validateFindingSchema(removedStrategyAlias).ok, false);
  assert.equal(validateArtifactContract("ultrafuzz/findings@2", JSON.stringify([removedStrategyAlias])).ok, false);
});

test("the findings v2 schema enforces one authoritative report-note vocabulary with parser and bundle parity", () => {
  const finding = {
    schema_version: FINDINGS_SCHEMA_VERSION,
    id: "reachability-1",
    title: "Helper reachability",
    status: "candidate",
    severity_guess: "Medium",
    confidence: "high",
    summary: "A helper-level proof needs a recognized reachability classification."
  };
  const assertNoteParity = (note: string, expected: boolean): void => {
    const candidate = { ...finding, notes: [note] };
    assert.equal(findingSchema.safeParse(candidate).success, expected, `Zod parser parity for ${note}`);
    assert.equal(validateFindingSchema(candidate).ok, expected, `registered schema parity for ${note}`);
    assert.equal(
      validateArtifactContract("ultrafuzz/findings@2", JSON.stringify([candidate])).ok,
      expected,
      `bundled contract parity for ${note}`
    );
  };

  for (const note of [
    "reachability=public-entrypoint-trace: verified",
    "reachability = public-entrypoint-trace: verified",
    "reachability=generated-public-wrapper-poc: verified",
    "reachability=helper-only: public entrypoints reject the input",
    "reachability=helper-only.",
    "reachability=public-wrapper-required: add a wrapper proof",
    "stateful_failure_classification=production-bug: reproduced",
    "likelihood=High",
    "likelihood = High",
    "impact=Low",
    "triage_reason=public evidence supports the issue",
    "helper_proof=direct helper mismatch reproduced"
  ]) {
    assertNoteParity(note, true);
  }

  for (const evidenceAssignment of [
    "access_control=role-based",
    "access_token=redacted",
    "verification_hash=0xabc",
    "classification_vector=one-hot",
    "Verification: run forge test",
    "Resolution: use checks-effects-interactions",
    "Access: only invoke public entrypoints"
  ]) {
    assertNoteParity(evidenceAssignment, true);
  }

  for (const reportAlias of [
    "access=internal",
    "verification=summary",
    "Access=internal",
    "ACCESS=internal",
    "Verification=summary",
    "access -> internal",
    "verification -> summary",
    "access: internal",
    "verification: summary",
    '"access": "internal"',
    '"verification": "summary"',
    "### access: internal",
    "## verification: summary ##",
    "<h3>access: internal</h3>",
    "access: internal\n---",
    "access:\ninternal",
    "access maps to internal",
    "verification maps to summary",
    "rating: critical",
    "attainability: helper-only",
    "rating maps to critical"
  ]) {
    assertNoteParity(reportAlias, false);
  }

  for (const renamedAlias of [
    "attainability_note=renamed",
    "attainment_alias=renamed",
    "exposure_alias=renamed",
    "rating_alias=renamed",
    "risk_score_v2=renamed",
    "confidence_score_detail=high",
    "severity_alias_v2=critical",
    "classification_v2=bug",
    "classification_v3=bug",
    "classificationAlias=bug",
    "classificationV3=bug",
    "access_alias=internal",
    "access_v2=internal",
    "accessAlias=internal",
    "accessV3=internal",
    "verification_v2=summary",
    "verification_alias=summary",
    "verificationAlias=summary",
    "prefix_disposition=accepted"
  ]) {
    assertNoteParity(renamedAlias, false);
  }

  for (const mappedAlias of [
    "access := internal",
    "verification := summary",
    "classification_v2 := bug",
    "access_alias := internal",
    "access ↦ internal",
    "verification ⟶ summary",
    "access ≔ internal",
    "attainability ↦ helper-only",
    "severity_alias -> critical"
  ]) {
    assertNoteParity(mappedAlias, false);
  }

  for (const mappedMetadataAlias of [
    "root_reason -> renamed",
    "root_reason ↦ renamed",
    "helper_verdict -> renamed",
    "HELPER_VERDICT ↦ renamed"
  ]) {
    assertNoteParity(mappedMetadataAlias, false);
  }

  assert.equal(findingReportSemanticAssignment("access: internal"), undefined);
  assert.equal(findingReportSemanticAssignment('"verification": "summary"'), undefined);
  for (const headingAlias of [
    "### Access: internal",
    "## Verification: summary ##",
    "<h3>Access: internal</h3>",
    "Access: internal\n---",
    "## Rating: critical"
  ]) {
    assert.notEqual(findingReportSemanticAssignment(headingAlias), undefined, headingAlias);
  }
  assert.deepEqual(findingReportSemanticAssignment("access -> internal"), {
    key: "access",
    operator: "=",
    value: "internal"
  });
  assert.deepEqual(findingReportSemanticAssignment("Record access: internal evidence on each finding."), {
    key: "access",
    operator: "=",
    value: "internal"
  });
  assert.deepEqual(findingReportSemanticAssignment("Record verification: summary evidence on each finding."), {
    key: "verification",
    operator: "=",
    value: "summary"
  });
  for (const proseMapping of [
    "Record access -> internal evidence on each finding.",
    "Record the reachability -> helper-only evidence on each finding.",
    "Record root_reason -> renamed evidence on each finding.",
    "Record severity_alias_v2 -> critical evidence on each finding.",
    "Record access | internal evidence on each finding.",
    "Record root_cause: renamed evidence on each finding.",
    "Record reachability -> helper-only evidence on each finding.",
    "Record verification ↦ summary evidence on each finding.",
    "Record root_cause ⟶ renamed evidence on each finding.",
    "Record access ≔ internal evidence on each finding."
  ]) {
    assert.notEqual(findingReportSemanticAssignment(proseMapping), undefined, proseMapping);
  }

  for (const wordMapping of [
    "Set access to internal on every finding.",
    "Write verification as summary on every finding.",
    "Record verification maps to summary on every finding.",
    "Set rating to critical on every finding.",
    "Record classification_v2 equals bug on every finding.",
    "Record classification_v3 equal to bug on every finding."
  ]) {
    assert.notEqual(findingReportSemanticAssignment(wordMapping), undefined, wordMapping);
  }

  for (const benignDirectiveProse of [
    "Set access to public before testing.",
    "Use verification as evidence when classifying findings.",
    "Write verification as a concise testing summary.",
    "Require access to the source tree before triage.",
    "Set access controls to public before testing.",
    "Write verification steps before summarizing the report.",
    "Record classification vectors as evidence."
  ]) {
    assert.equal(findingReportSemanticAssignment(benignDirectiveProse), undefined, benignDirectiveProse);
  }

  for (const evidenceAssignment of [
    "Observed balance=0 after withdrawal; expected balance=1.",
    "Evidence: https://example.test/trace?block=latest",
    "The invariant was amount == expectedAmount.",
    "Evidence: https://example.test/trace?tx=abc",
    "Evidence: https://example.test/trace;session=abc",
    "ipfs://root/path?filename=proof.json",
    "timeout --signal=TERM --kill-after=300s",
    "x==y",
    "Reproducer: FOUNDRY_PROFILE=ci forge test",
    "Run RUST_LOG=debug cargo test",
    "forge test --match-test repro seed=123 runs=1000",
    "Evidence: <https://x.test/?tx=abc>",
    "request_id=abc123",
    "RISK_FREE_RATE=0.05 impact_price=123 helper_address=0xabc",
    "helper_balance=0 proof_size=32 root_slot=0x00 IMPACT_PRICE=123",
    "MERKLE_ROOT=0xabc PUBLIC_KEY=0x123 risk_ratio=0.5 HELPER_BALANCE=0",
    "--dependency-version=1.2.3 STATEFUL_RUNS=1000 scope_id=request-7",
    "https://x.test/?impact_price=123",
    "The HTTP response had status=200.",
    "The oracle returned confidence=0.95.",
    "The trace entered scope=global before reverting.",
    "The shell printed outcome=success.",
    "The proof checks risk=0 after withdrawal.",
    "const result = await run();",
    "bytes32 root = tree.root();",
    "verifyProof(root=0xabc, leaf=0xdef)",
    "proof_type=merkle",
    "command prints result=42",
    "forge test --root=.",
    "The Merkle proof used root=0xabc.",
    "The compiler printed classification=error.",
    "Audit log: result=pass.",
    "The HTTP body contains report_status=200.",
    "The HTTP body contains report_status: 200.",
    "The analyzer reports vulnerability severity=High.",
    "The call returned impact=amountOut.",
    "https://x.test/?tx=abc&status=200",
    "emit Status(status=200)",
    "_=non-semantic evidence",
    "根因=non-semantic evidence",
    "Δ=non-semantic evidence",
    "💣=non-semantic evidence",
    "risK=non-semantic Unicode evidence",
    "liKelihood=non-semantic Unicode evidence",
    "https://x.test/?root%5Fcause=encoded-query-key"
  ]) {
    assertNoteParity(evidenceAssignment, true);
  }

  for (const wrappedCanonical of ["(reachability=helper-only)", "[reachability=helper-only]"]) {
    assertNoteParity(wrappedCanonical, true);
  }

  for (const semanticAlias of [
    "helper_summary=renamed producer key",
    "reachability_note=helper-only",
    "classification_notes=accepted",
    "helper_evidence=renamed producer key",
    "classification_evidence=renamed producer key",
    "root_cause_reason=renamed",
    "root_reason=renamed",
    "audit_status=accepted",
    "finding_result=accepted",
    "report_summary=renamed",
    "helper_verdict=renamed",
    "public_reason=renamed",
    "triage_status=accepted",
    "cause_note=renamed",
    "severity_decision=High",
    "finding_classification=renamed",
    "scope_decision=renamed",
    "ROOT_CAUSE=renamed",
    "rootCause=renamed",
    "Helper_Proof=renamed",
    "_root_cause=renamed",
    "__root_cause=renamed",
    "___Helper=renamed",
    "root_cause__=renamed",
    "<root_cause=renamed>",
    "`root_cause=renamed`",
    '"root_cause=renamed"',
    "Triage: root_cause=renamed",
    "Observed. root_cause=renamed",
    "> root_cause=renamed",
    "Set report field root_cause=renamed",
    "Record a `helper_evidence=renamed` note",
    "-root_cause=renamed",
    "--root_cause=renamed",
    "root-cause=renamed",
    "triage_reason=public evidence root_cause=renamed",
    "triage_reason=ok x=y root_cause=renamed",
    "triage_reason=ok RISK_FREE_RATE=0.05 root_cause=renamed",
    "triage_reason=ok (root_cause=renamed)",
    "triage_reason=ok/root_cause=renamed",
    "triage_reason=ok attainability=renamed",
    `triage_reason=ok ${"a".repeat(4100)} root_cause=renamed`,
    "triage_reason=ok;root_cause=renamed",
    "triage_reason=ok,root_cause=renamed",
    "triage_reason=ok*root_cause=renamed",
    "triage_reason=ok|root_cause=renamed",
    "https://example.test/trace;root_cause=renamed",
    "RISK_SCORE=high",
    "SeverityAlias=critical",
    "https://x.test/?tx=abc&root_cause=renamed",
    "https://x.test/?tx=abc&HELPER_PROOF_ALIAS=renamed",
    "seed=123&classification_alias=renamed",
    "root_cause==renamed",
    "reachability==helper-only",
    "9root_cause=renamed",
    "helperEvidence=renamed",
    "dependencyScope=renamed",
    "resolution=confirmed",
    "disposition=accepted",
    "final_severity=high",
    "severity_guess=high",
    "confidence_score=high",
    "finding_status=confirmed",
    "triage_result=accepted",
    "classification_result=bug",
    "proof_kind=public",
    "reachability=renamed-public-trace",
    "`reachability` = `internal`",
    "**reachability** = **internal**",
    "~~reachability~~ = ~~internal~~",
    "***audit_status***=accepted",
    "***report_verdict***=accepted",
    "`**audit_status**`=accepted",
    "<code>audit_status</code>=accepted",
    "<strong>reachability</strong> = internal",
    "<span>audit_status</span>=accepted",
    "<u>audit_status</u>=accepted",
    "<mark>reachability</mark> = internal",
    "The note contains <span>reachability</span>=internal in prose.",
    "reachability<!--comment-->=internal",
    "reachability\u200b=internal",
    "Reachability:\ninternal",
    "| reachability | internal |",
    "reachability -> internal",
    "reachability → internal",
    "reachability ↦ internal",
    "reachability ⟶ internal",
    "reachability ≔ internal",
    "reachability maps to internal",
    '{ "reachability"\n: "internal" }',
    'Embedded JSON: {\n  "reachability"\n  :\n  "internal"\n}',
    "Reachability: internal",
    "reachability : internal",
    '"reachability": "internal"',
    'Evidence: { "reachability": "internal" }',
    "root_reason: renamed",
    "stateful_failure_classification=renamed",
    "likelihood=likely",
    "impact=critical",
    'triage_reason="summary"',
    "triage_reason=(summary)",
    "triage_reason=[summary]",
    'helper_proof="proof"',
    "helper_proof=(proof)",
    "helper_proof=",
    "attainability=renamed reachability=helper-only",
    "triage_reason=ok RISK_FREE_RATE=0.05 attainability=renamed",
    "reachability_key=helper-only",
    "helper_proof_key=renamed",
    "helper_proof_url=renamed",
    "outcome=helper-only",
    "call_path=helper-only",
    "production_path=public-entrypoint-trace",
    "exploit_path=public-wrapper-required",
    "verification=summary",
    "access=internal",
    "helper_address=helper-only",
    "`call_path=<helper-only>`",
    "((production_path=(public-entrypoint-trace)))",
    "  : outcome=[helper-only]",
    'attainability="helper-only"',
    "attainability=(helper-only)",
    "Evidence follows; reachability=renamed-public-trace",
    "prefix reachability=renamed-public-trace",
    "The reachability=renamed-public-trace annotation is invalid",
    "Observed. stateful_failure_classification=renamed",
    'Evidence: helper_proof="quoted"',
    "Observed. outcome=helper-only"
  ]) {
    assertNoteParity(semanticAlias, false);
    assert.notEqual(findingNoteAssignmentIssue(semanticAlias), undefined, semanticAlias);
  }

  for (const unsupportedAssignmentWhitespace of [
    "reachability\n=helper-only",
    "reachability=\nhelper-only",
    "reachability\u00a0=\u00a0helper-only"
  ]) {
    assertNoteParity(unsupportedAssignmentWhitespace, false);
  }

  for (const nonAsciiIdentifier of [
    "\u0301_root_cause=non-semantic Unicode evidence",
    "root_cause\u0301=non-semantic Unicode evidence",
    "r_\u0301o-o_t__cause=non-semantic Unicode evidence",
    "_9\u0301_root_cause=non-semantic Unicode evidence"
  ]) {
    assertNoteParity(nonAsciiIdentifier, true);
  }

  assert.deepEqual(findingNoteAssignmentIssue("triage_reason=ok root_cause=renamed"), {
    key: "root_cause",
    message: "Unsupported report-bound finding note key"
  });

  assertNoteParity("helper_context is prose, not an assignment", true);

  const triaged = {
    ...finding,
    triage_classification: "true-positive",
    notes: ["triage_reason=public evidence supports the issue", "reachability=public-entrypoint-trace"]
  };
  assert.equal(triagedFindingsSchema.safeParse([triaged]).success, true);
  assert.equal(validateArtifactContract("ultrafuzz/triaged-findings@1", JSON.stringify([triaged])).ok, true);
  const triagedAlias = { ...triaged, notes: [...triaged.notes, "root_cause=renamed"] };
  assert.equal(triagedFindingsSchema.safeParse([triagedAlias]).success, false);
  assert.equal(validateArtifactContract("ultrafuzz/triaged-findings@1", JSON.stringify([triagedAlias])).ok, false);

  const validSeverity = {
    ...triaged,
    severity: "Medium",
    impact: "Medium",
    likelihood: "Medium",
    impact_rationale: "impact=Medium: the affected balance can be recovered",
    likelihood_rationale: "likelihood=Medium: the path requires a specific caller",
    severity_rationale: "reachability=public-entrypoint-trace: reproduced; observed balance=0"
  };
  assert.equal(severityClassifiedFindingsSchema.safeParse([validSeverity]).success, true);
  assert.equal(
    validateArtifactContract("ultrafuzz/severity-classified-findings@1", JSON.stringify([validSeverity])).ok,
    true
  );
  for (const invalidSeverity of [
    { ...validSeverity, severity_rationale: "reachability=renamed-public-trace" },
    { ...validSeverity, notes: [...validSeverity.notes, "helper_evidence=renamed"] }
  ]) {
    assert.equal(severityClassifiedFindingsSchema.safeParse([invalidSeverity]).success, false);
    assert.equal(
      validateArtifactContract("ultrafuzz/severity-classified-findings@1", JSON.stringify([invalidSeverity])).ok,
      false
    );
  }
});

test("max-length adversarial report notes preserve Zod and isolated JSON Schema parity", () => {
  const finding = {
    schema_version: FINDINGS_SCHEMA_VERSION,
    id: "semantic-key-performance",
    title: "Semantic key validation remains bounded",
    status: "candidate",
    severity_guess: "Low",
    confidence: "low",
    summary: "Adversarial notes must not exhaust the isolated validator deadline."
  };
  const maxNote = (prefix: string, repeated: string, suffix: string): string => {
    const fixedCodePoints = [...prefix, ...suffix].length;
    return `${prefix}${repeated.repeat(MAX_FINDING_STRING_CODE_POINTS - fixedCodePoints)}${suffix}`;
  };
  const cases = [
    { label: "separator-only", note: "_".repeat(MAX_FINDING_STRING_CODE_POINTS), expected: true },
    { label: "mark-only", note: "\u0301".repeat(MAX_FINDING_STRING_CODE_POINTS), expected: true },
    { label: "long near-miss", note: maxNote("", "_", "root_causx=x"), expected: true },
    { label: "long leading separators", note: maxNote("", "_", "root_cause=x"), expected: true },
    { label: "long leading marks", note: maxNote("", "\u0301", "root_cause=x"), expected: true },
    { label: "long internal separators", note: maxNote("r", "_", "oot_cause=x"), expected: true },
    { label: "long clause separator", note: maxNote("", "x", ";root_cause=x"), expected: false },
    {
      label: "repeated canonical assignments",
      note: "impact=High x "
        .repeat(Math.ceil(MAX_FINDING_STRING_CODE_POINTS / 14))
        .slice(0, MAX_FINDING_STRING_CODE_POINTS),
      expected: true
    }
  ] as const;

  for (const { label, note, expected } of cases) {
    assert.equal([...note].length, MAX_FINDING_STRING_CODE_POINTS, `${label}: fixture length`);
    const candidate = { ...finding, notes: [note] };
    assert.equal(findingSchema.safeParse(candidate).success, expected, `${label}: Zod parser`);
    const bundled = validateArtifactContract("ultrafuzz/findings@2", JSON.stringify([candidate]));
    assert.equal(bundled.ok, expected, `${label}: bundled contract`);
    assert.equal(
      bundled.issues.some((issue) => issue.code === "ARTIFACT_VALIDATOR_FAILED"),
      false,
      `${label}: isolated validator deadline`
    );
  }
});

test("the findings v2 schema validates closed typed evidence spans without repair", () => {
  const finding = {
    schema_version: FINDINGS_SCHEMA_VERSION,
    id: "failure-1",
    title: "Disjoint source evidence",
    status: "candidate",
    severity_guess: "Medium",
    confidence: "high",
    summary: "Two disjoint source ranges support the finding.",
    evidence: [
      {
        kind: "source",
        path: "src/VeryLiquidVault.sol",
        fragment: "deposit-boundary",
        detail: "The ranges jointly establish the boundary.",
        line_ranges: [
          { line: 105, end_line: 107 },
          { line: 154, end_line: 185 }
        ]
      }
    ]
  };

  for (const candidate of [
    finding,
    {
      ...finding,
      evidence: [
        {
          kind: "source",
          path: "src/VeryLiquidVault.sol",
          detail: "One source span establishes the boundary.",
          line: 105,
          end_line: 107
        }
      ]
    }
  ]) {
    assert.equal(validateFindingSchema(candidate).ok, true);
    assert.equal(validateArtifactContract("ultrafuzz/findings@2", JSON.stringify([candidate])).ok, true);
  }

  const evidenceSchema = JSON.stringify(findingJsonSchema);
  for (const field of ["fragment", "detail", "line", "end_line", "line_ranges"]) {
    assert.match(evidenceSchema, new RegExp(field, "u"));
  }

  for (const evidence of [
    {},
    { kind: "source", path: "src/VeryLiquidVault.sol", end_line: 107 },
    { kind: "source", path: "src/VeryLiquidVault.sol", line: 0 },
    { kind: "source", path: "src/VeryLiquidVault.sol", line: Number.MAX_SAFE_INTEGER + 1 },
    { kind: "source", path: "src/VeryLiquidVault.sol", line_ranges: [{ line: 105, end_line: 107 }] },
    {
      kind: "source",
      path: "src/VeryLiquidVault.sol",
      line: 105,
      line_ranges: [{ line: 105 }, { line: 154 }]
    },
    {
      kind: "source",
      path: "src/VeryLiquidVault.sol",
      line_ranges: [{ line: 105, note: "not canonical" }, { line: 154 }]
    },
    { kind: "source", path: "src/VeryLiquidVault.sol", detail: "evidence", repair_hint: "strip me" }
  ]) {
    const malformed = { ...finding, evidence: [evidence] };
    assert.equal(validateFindingSchema(malformed).ok, false, JSON.stringify(evidence));
    assert.equal(
      validateArtifactContract("ultrafuzz/findings@2", JSON.stringify([malformed])).ok,
      false,
      JSON.stringify(evidence)
    );
  }
});

test("the findings v2 schema retains typed campaign deduplication accounting", () => {
  const finding = {
    schema_version: FINDINGS_SCHEMA_VERSION,
    id: "failure-1",
    title: "Accounting invariant violation",
    status: "candidate",
    severity_guess: "Medium",
    confidence: "high",
    summary: "The accounting invariant failed.",
    property_ids: ["property-1"],
    fuzzer_backends: ["medusa", "recon"],
    contributing_backend_failures: [
      { fuzzer_backend: "recon", failure_id: "failure-1", raw_result_ref: "recon-fuzzer-results.json" },
      { fuzzer_backend: "medusa", failure_id: "failure-2", raw_result_ref: "medusa-results.json" }
    ],
    deduplication: { pre_dedup_count: 2, basis: "same root cause" }
  };
  assert.equal(validateFindingSchema(finding).ok, true);
  assert.equal(validateArtifactContract("ultrafuzz/findings@2", JSON.stringify([finding])).ok, true);
  assert.equal(validateFindingSchema({ ...finding, contributing_backend_failures: ["failure-1"] }).ok, false);
  assert.equal(
    validateFindingSchema({
      ...finding,
      contributing_backend_failures: [{ fuzzer_backend: "recon", failure_id: "failure-1" }]
    }).ok,
    false
  );
  assert.equal(
    validateFindingSchema({ ...finding, contributing_backend_failures: [{ fuzzer_backend: "medusa" }] }).ok,
    false
  );
  assert.equal(validateFindingSchema({ ...finding, deduplication: { pre_dedup_count: 0 } }).ok, false);
});
test("the campaign summary v2 contract requires complete typed accounting", () => {
  const summary = {
    schema_version: CAMPAIGN_SUMMARY_SCHEMA_VERSION,
    outcome: "partial",
    sequence_length: 100,
    implemented_property_suite_refs: ["implemented-properties.json"],
    campaign_plan_ref: "invariant-campaign-plan.json",
    backend_results: [],
    finding_refs: [],
    reproducer_refs: [],
    failure_counts: { pre_deduplication: 29, post_deduplication: 2 }
  };
  assert.equal(validateArtifactContract("ultrafuzz/campaign-summary@2", JSON.stringify(summary)).ok, true);
  assert.equal(
    validateArtifactContract("ultrafuzz/campaign-summary@2", JSON.stringify({ ...summary, schema_version: "1.0" })).ok,
    false
  );
  assert.equal(
    validateArtifactContract(
      "ultrafuzz/campaign-summary@2",
      JSON.stringify({ ...summary, failure_counts: { pre_deduplication: -1, post_deduplication: 2 } })
    ).ok,
    false
  );
});

test("the current invariant campaign plan contract requires v2 timeout evidence", () => {
  const command =
    "timeout --preserve-status --signal=INT --kill-after=300s 3600s recon fuzz . --timeout 3600 --test-limit 18446744073709551615";
  const plan = {
    schema_version: "ultrafuzz.invariant-campaign-plan.v2",
    available_vcpus: 8,
    workers: 8,
    configured_budget_seconds: 3600,
    deadline: "2026-08-11T01:00:00.000Z",
    finalization_reserve_seconds: 300,
    configured_fuzzer_timeout_seconds: 3600,
    recon_internal_timeout_seconds: 3600,
    recon_test_limit: "18446744073709551615",
    recon_sequence_length: 100,
    host_soft_timeout_seconds: 3600,
    host_force_kill_grace_seconds: 300,
    artifact_finalization_reserve_seconds: 300,
    backend_started_at: "2026-08-11T00:00:00.000Z",
    fuzzing_deadline_utc: "2026-08-11T01:00:00.000Z",
    force_kill_deadline_utc: "2026-08-11T01:05:00.000Z",
    final_artifact_deadline_utc: "2026-08-11T01:10:00.000Z",
    backend: { name: "recon", version: null, exact_shell_escaped_command: command },
    command_plan: [{ phase: "campaign", command }],
    paths: {
      corpus: "backends/recon-fuzzer/corpus",
      cache: "backends/recon-fuzzer/cache",
      log: "backends/recon-fuzzer/run.log",
      raw_results: "backends/recon-fuzzer/results.json",
      reproducers: "backends/recon-fuzzer/reproducers"
    }
  };
  assert.equal(validateArtifactContract("ultrafuzz/invariant-campaign-plan@2", JSON.stringify(plan)).ok, true);
  for (const malformed of [
    { ...plan, schema_version: "ultrafuzz.invariant-campaign-plan.v1" },
    { ...plan, configured_fuzzer_timeout_seconds: 0 },
    { ...plan, recon_sequence_length: 0 },
    { ...plan, backend_started_at: "not-a-timestamp" },
    { ...plan, backend: {} }
  ]) {
    const result = validateArtifactContract("ultrafuzz/invariant-campaign-plan@2", JSON.stringify(malformed));
    assert.equal(result.ok, false, JSON.stringify(malformed));
    assert.ok(result.issues.some((issue) => issue.code === "ARTIFACT_SCHEMA_INVALID"));
  }
});

test("finding v2 and report v3 schemas require their current canonical shapes", () => {
  const nonPropertyFinding = {
    schema_version: FINDINGS_SCHEMA_VERSION,
    id: "finding-setup",
    title: "Harness setup is incomplete",
    status: "needs-review",
    severity_guess: "Low",
    confidence: "high",
    summary: "The setup path is incomplete."
  };
  assert.equal(validateFindingSchema(nonPropertyFinding).ok, true);
  assert.equal(validateFindingSchema({ ...nonPropertyFinding, property_ids: ["property-1", "property-1"] }).ok, false);

  const report = {
    schema_version: REPORT_SCHEMA_VERSION,
    run_metadata: {
      run_id: "run-1",
      source_run_id: "run-0",
      repository: "example/repository",
      elapsed_time: "1m",
      models_used: ["model-a"],
      tokens_used: "100",
      estimated_spend: "$0.01",
      partial_pricing: false,
      strategy_loops: 1,
      audit_profile: "exhaustive",
      audit_profile_catalog_digest: "a".repeat(64),
      topology_digest: "b".repeat(64),
      prompt_digest: "c".repeat(64),
      expanded_graph_fingerprint: "d".repeat(64),
      agent_execution: {
        planned_chain: [
          {
            attempt: 1,
            profile_id: "gpt55-xhigh",
            agent_ref: "CodexAgent",
            model_name: "gpt-5.5",
            reasoning_effort: "xhigh",
            role: "primary"
          }
        ],
        failed_attempts: [],
        producer: {
          attempt: 1,
          profile_id: "gpt55-xhigh",
          agent_ref: "CodexAgent",
          model_name: "gpt-5.5",
          reasoning_effort: "xhigh",
          role: "primary"
        }
      }
    },
    issues: [],
    non_production_outcomes: [],
    property_provenance: [],
    property_implementation_coverage: {
      status: "not-planned",
      reason: "property-implementation-track-not-declared"
    }
  };
  assert.equal(validateArtifactContract("ultrafuzz/report@3", JSON.stringify(report)).ok, true);
  assert.equal(
    validateArtifactContract(
      "ultrafuzz/report@3",
      JSON.stringify({ ...report, campaign_outcome: { outcome: "blocked", reason: "recon was unavailable" } })
    ).ok,
    true
  );
  assert.equal(
    validateArtifactContract(
      "ultrafuzz/report@3",
      JSON.stringify({ ...report, campaign_outcome: { outcome: "blocked", unexpected: true } })
    ).ok,
    false
  );
  assert.equal(
    validateArtifactContract("ultrafuzz/report@3", JSON.stringify({ ...report, schema_version: "1.0" })).ok,
    false
  );
  const withoutProvenance = { ...report } as Partial<typeof report>;
  delete withoutProvenance.property_provenance;
  assert.equal(validateArtifactContract("ultrafuzz/report@3", JSON.stringify(withoutProvenance)).ok, false);
  const withoutCoverage = { ...report } as Partial<typeof report>;
  delete withoutCoverage.property_implementation_coverage;
  assert.equal(validateArtifactContract("ultrafuzz/report@3", JSON.stringify(withoutCoverage)).ok, false);
  assert.equal(
    validateArtifactContract(
      "ultrafuzz/report@3",
      JSON.stringify({ ...report, property_implementation_coverage: "unavailable" })
    ).ok,
    false
  );

  const nonProductionOutcome = {
    ...nonPropertyFinding,
    triage_classification: "harness-defect",
    recommended_next_action: "Repair the harness before treating this as a production issue.",
    evidence: [
      {
        kind: "source",
        path: "test/Harness.t.sol",
        fragment: "setup",
        detail: "The disjoint ranges establish the incomplete setup.",
        line_ranges: [{ line: 12, end_line: 14 }, { line: 21 }]
      }
    ],
    lifecycle: { dedupe_key: "harness-setup", source_artifacts: [], strategy_hits: [] }
  };
  const reportWithTypedEvidence = { ...report, non_production_outcomes: [nonProductionOutcome] };
  assert.equal(validateArtifactContract("ultrafuzz/report@3", JSON.stringify(reportWithTypedEvidence)).ok, true);
  for (const invalidNote of [
    'triage_reason="summary"',
    "helper_proof=(proof)",
    "reachability_key=helper-only",
    "outcome=helper-only"
  ]) {
    for (const collection of ["issues", "non_production_outcomes"] as const) {
      const invalidReport = {
        ...report,
        [collection]: [{ ...nonProductionOutcome, notes: [invalidNote] }]
      };
      assert.equal(reportSchema.safeParse(invalidReport).success, false, `${collection} Zod parity for ${invalidNote}`);
      assert.equal(
        validateArtifactContract("ultrafuzz/report@3", JSON.stringify(invalidReport)).ok,
        false,
        `${collection} bundled parity for ${invalidNote}`
      );
    }
  }
  for (const invalidOutcome of [
    { ...nonProductionOutcome, notes: ["reachability=renamed-public-trace"] },
    { ...nonProductionOutcome, severity_rationale: "helper_evidence=renamed" }
  ]) {
    const invalidReport = { ...report, non_production_outcomes: [invalidOutcome] };
    assert.equal(reportSchema.safeParse(invalidReport).success, false);
    assert.equal(validateArtifactContract("ultrafuzz/report@3", JSON.stringify(invalidReport)).ok, false);
  }
  const reportWithEmptyEvidence = {
    ...report,
    non_production_outcomes: [{ ...nonProductionOutcome, evidence: [{}] }]
  };
  assert.equal(validateArtifactContract("ultrafuzz/report@3", JSON.stringify(reportWithEmptyEvidence)).ok, false);
  assert.equal(reportSchema.safeParse(reportWithEmptyEvidence).success, false);
  assert.equal(
    validateArtifactContract(
      "ultrafuzz/report@3",
      JSON.stringify({
        ...reportWithTypedEvidence,
        non_production_outcomes: [
          { ...nonProductionOutcome, evidence: [{ path: "test/Harness.t.sol", line_ranges: [{ line: 12 }] }] }
        ]
      })
    ).ok,
    false,
    "report findings must use scalar line for a single span"
  );
});
test("run state schema covers all required node states and rejects malformed state", () => {
  assert.ok(RUN_STATE_STATUSES.includes("paused"));
  assert.ok(NODE_STATE_STATUSES.includes("ready"));
  assert.ok(NODE_STATE_STATUSES.includes("runnable"));
  assert.ok(NODE_STATE_STATUSES.includes("reused-from-prior-run"));
  assert.ok(NODE_STATE_STATUSES.includes("invalidated"));

  const state = createInitialRunState({
    runId: "run-1",
    graphFingerprint: "graph-fp",
    configFingerprint: "config-fp",
    nodes: [
      {
        id: "node-1",
        status: "ready",
        artifactDir: "artifacts/node-1",
        outputs: [
          {
            path: "findings.json",
            contract: "ultrafuzz/findings@2",
            contract_digest: "a".repeat(64),
            ...artifactContractSchemaBinding("ultrafuzz/findings@2"),
            primary: true
          }
        ],
        attemptIndex: 0,
        loopIndex: 0,
        modelId: "unit-model",
        model: "unit-model",
        modelIndex: 0
      }
    ]
  });

  assert.equal(validateRunStateSchema(state).ok, true);
  assert.equal(state.schema_version, "ultrafuzz.run-state.v5");
  assert.equal(state.nodes["node-1"]?.wait_reason, "ready");
  assert.equal(state.nodes["node-1"]?.next_eligible_action, "dispatch");
  assert.equal(state.controller_lease.status, "active");
  assert.equal(state.controller_lease.duration_ms, 30_000);
  assert.equal(state.concurrency.requested_concurrency, 1);

  const invalid = validateRunStateSchema({
    ...state,
    nodes: {
      "node-1": {
        ...state.nodes["node-1"],
        status: "unknown"
      }
    }
  });

  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.some((issue) => issue.path.endsWith(".status")));

  const partialBindingState = structuredClone(state);
  delete partialBindingState.nodes["node-1"]!.outputs![0]!.schema_id;
  const partialBinding = validateRunStateSchema(partialBindingState);
  assert.equal(partialBinding.ok, false);
  assert.ok(partialBinding.issues.some((issue) => issue.path.endsWith(".schema_file")));

  const completeBinding = validateRunStateSchema({
    ...state,
    nodes: {
      "node-1": {
        ...state.nodes["node-1"],
        outputs: [
          {
            ...state.nodes["node-1"]!.outputs![0]!,
            schema_file: "findings.schema.json",
            schema_id: "urn:ultrafuzz:schema:artifacts:findings:1",
            schema_sha256: "b".repeat(64),
            schema_bundle_sha256: "c".repeat(64),
            validator_build: "test-validator-build"
          }
        ]
      }
    }
  });
  assert.equal(completeBinding.ok, true);

  const missingWait = structuredClone(state);
  delete missingWait.nodes["node-1"]?.wait_since;
  const invalidWait = validateRunStateSchema(missingWait);
  assert.equal(invalidWait.ok, false);
  assert.ok(invalidWait.issues.some((issue) => issue.path.endsWith(".wait_since")));
});

test("planned graph v4 validates whole documents and executes every registered document semantic gate", () => {
  const node: PlannedGraphNodeDocument = {
    id: "node-a",
    logical_id: "node-a",
    display_name: "Node A",
    kind: "agentic" as const,
    depends_on: [] as string[],
    artifact_dir: "artifacts/node-a",
    outputs: [
      {
        path: "report.md",
        contract: "ultrafuzz/nonempty-markdown@1" as const,
        contract_digest: artifactContractDefinition("ultrafuzz/nonempty-markdown@1").digest,
        primary: true
      }
    ],
    prompt_id: "node-a",
    prompt_path: ".ultrafuzz/prompts/node-a.mdx",
    loop: { index: 0, count: 1, mode: "parallel" as const, attempt_index: 0 },
    model_fanout: []
  };
  const graph: PlannedGraphDocument = {
    schema_version: PLANNED_GRAPH_SCHEMA_VERSION,
    graph_version: "4" as const,
    topology_version: 2 as const,
    groups: {},
    nodes: [node]
  };

  assert.equal(validatePlannedGraph(graph).ok, true);
  assert.deepEqual(assertPlannedGraph(graph), graph);

  const retryBoundary = structuredClone(graph);
  retryBoundary.groups.review = { defaults: { max_attempts: 100 } };
  assert.equal(validatePlannedGraph(retryBoundary).ok, true);

  const excessiveRetry = structuredClone(graph);
  excessiveRetry.groups.review = { defaults: { max_attempts: 101 } };
  assert.equal(validatePlannedGraph(excessiveRetry).ok, false);

  assert.equal(validatePlannedGraph({ ...graph, schema_version: "2.0" }).ok, false);
  assert.equal(validatePlannedGraph({ ...graph, legacy: true }).ok, false);
  const findingsOutput = {
    path: "findings.json",
    contract: "ultrafuzz/findings@2" as const,
    contract_digest: artifactContractDefinition("ultrafuzz/findings@2").digest,
    ...artifactContractSchemaBinding("ultrafuzz/findings@2"),
    primary: true
  };
  const preUpgradeValidatorBuild =
    "ultrafuzz-json-validator.v1:4190026d34c5706521f539b0f814073a20250f0bc4984686918205495d63379c";
  assert.equal(VALIDATOR_BUILD_IDENTITY, preUpgradeValidatorBuild);
  const historicalBundle = structuredClone(graph);
  historicalBundle.nodes = [
    {
      ...node,
      outputs: [
        {
          ...findingsOutput,
          schema_bundle_sha256: "f".repeat(64),
          validator_build: preUpgradeValidatorBuild
        }
      ]
    }
  ];
  assert.throws(() => assertPlannedGraph(historicalBundle), /schema binding changed/u);
  assert.deepEqual(assertSealedPlannedGraph(historicalBundle), historicalBundle);
  const historicalSchemaDrift = structuredClone(historicalBundle);
  historicalSchemaDrift.nodes[0]!.outputs[0]!.schema_sha256 = "e".repeat(64);
  assert.throws(() => assertSealedPlannedGraph(historicalSchemaDrift), /schema binding changed/u);

  const documentGateFailures: Array<{ name: string; graph: PlannedGraphDocument; message: RegExp }> = [
    {
      name: "planned-graph-node-id-uniqueness",
      graph: { ...graph, nodes: [node, structuredClone(node)] },
      message: /repeats node ID/u
    },
    {
      name: "planned-graph-dependency-join",
      graph: { ...graph, nodes: [{ ...node, depends_on: ["missing"] }] },
      message: /depends on unknown node/u
    },
    {
      name: "planned-graph-acyclicity",
      graph: {
        ...graph,
        nodes: [
          { ...node, depends_on: ["node-b"] },
          { ...node, id: "node-b", logical_id: "node-b", artifact_dir: "artifacts/node-b", depends_on: ["node-a"] }
        ]
      },
      message: /dependency cycle/u
    },
    {
      name: "planned-graph-output-path-uniqueness",
      graph: { ...graph, nodes: [{ ...node, outputs: [node.outputs[0]!, { ...node.outputs[0]!, primary: false }] }] },
      message: /repeats output path/u
    },
    {
      name: "planned-graph-exactly-one-primary",
      graph: { ...graph, nodes: [{ ...node, outputs: [{ ...node.outputs[0]!, primary: false }] }] },
      message: /exactly one primary/u
    },
    {
      name: "planned-graph-model-fanout-uniqueness",
      graph: {
        ...graph,
        nodes: [
          {
            ...node,
            model_fanout: [
              { model_profile_id: "m", agent_ref: "a", model_index: 0, loop_index: 0, attempt_index: 0 },
              { model_profile_id: "m", agent_ref: "a", model_index: 0, loop_index: 0, attempt_index: 0 }
            ]
          }
        ]
      },
      message: /model-fanout identity/u
    },
    {
      name: "planned-graph-workflow-task-uniqueness",
      graph: {
        ...graph,
        nodes: [
          { ...node, workflow: { node_id: "task-a", task_node_ids: ["task-a"] } },
          {
            ...node,
            id: "node-b",
            logical_id: "node-b",
            artifact_dir: "artifacts/node-b",
            workflow: { node_id: "task-a", task_node_ids: ["task-a"] }
          }
        ]
      },
      message: /repeats workflow task ID/u
    },
    {
      name: "planned-graph-workflow-node-join",
      graph: {
        ...graph,
        nodes: [{ ...node, workflow: { node_id: "task-a", task_node_ids: ["task-b"] } }]
      },
      message: /node_id is not present/u
    },
    {
      name: "planned-graph-artifact-dir-identity",
      graph: { ...graph, nodes: [{ ...node, artifact_dir: "artifacts/someone-else" }] },
      message: /artifact_dir does not match/u
    },
    {
      name: "planned-graph-loop-coupling",
      graph: { ...graph, nodes: [{ ...node, loop: { ...node.loop, index: 1, count: 1, attempt_index: 1 } }] },
      message: /inconsistent loop coordinates/u
    },
    {
      name: "planned-graph-contract-identity",
      graph: {
        ...graph,
        nodes: [{ ...node, outputs: [{ ...findingsOutput, contract_digest: "f".repeat(64) }] }]
      },
      message: /contract digest changed/u
    },
    {
      name: "planned-graph-model-loop-coupling",
      graph: {
        ...graph,
        nodes: [
          {
            ...node,
            model_fanout: [{ model_profile_id: "m", agent_ref: "a", model_index: 0, loop_index: 1, attempt_index: 0 }]
          }
        ]
      },
      message: /model bound to another loop/u
    }
  ];
  for (const fixture of documentGateFailures) {
    assert.equal(validatePlannedGraph(fixture.graph).ok, true, `${fixture.name} is semantic, not shape`);
    assert.throws(() => assertPlannedGraphSemantics(fixture.graph), fixture.message, fixture.name);
  }
});

test("generated test manifest runtime and exported schemas enforce the same safe companion paths", () => {
  const manifest = {
    schema_version: GENERATED_TESTS_SCHEMA_VERSION,
    run_id: "run-1",
    node_id: "strategy-a",
    framework: "foundry",
    generated_tests: [
      {
        path: "generated-tests/Invariant.t.sol",
        size_bytes: 1,
        sha256: "a".repeat(64),
        language: "solidity",
        description: "Focused invariant replay"
      }
    ],
    support_files: []
  };

  assert.equal(validateGeneratedTestManifestSchema(manifest).ok, true);
  assert.equal(
    validateGeneratedTestManifestSchema({ ...manifest, schema_version: "ultrafuzz.generated-tests.v2" }).ok,
    false
  );
  const missingSupportFiles = structuredClone(manifest) as Record<string, unknown>;
  delete missingSupportFiles.support_files;
  assert.equal(validateGeneratedTestManifestSchema(missingSupportFiles).ok, false);
  const missingFramework = structuredClone(manifest) as Record<string, unknown>;
  delete missingFramework.framework;
  assert.equal(validateGeneratedTestManifestSchema(missingFramework).ok, false);
  for (const framework of ["foundry/hardhat", " foundry", "fuzz🚀", "a".repeat(129)]) {
    assert.equal(validateGeneratedTestManifestSchema({ ...manifest, framework }).ok, false, framework);
    assert.equal(
      validateArtifactContract("ultrafuzz/generated-tests@3", JSON.stringify({ ...manifest, framework })).ok,
      false,
      framework
    );
  }
  assert.equal(
    validateGeneratedTestManifestSchema({
      ...manifest,
      generated_tests: [{ ...manifest.generated_tests[0]!, framework: "hardhat" }]
    }).ok,
    false
  );
  const supportManifest = {
    ...manifest,
    support_files: [
      {
        path: "generated-tests/InvariantFixture.sol",
        size_bytes: 1,
        sha256: "b".repeat(64)
      }
    ]
  };
  assert.equal(validateGeneratedTestManifestSchema(supportManifest).ok, true);
  assert.equal(validateArtifactContract("ultrafuzz/generated-tests@3", JSON.stringify(supportManifest)).ok, true);
  for (const generated_tests of [
    [{ path: "generated-tests/Invariant.t.sol", sha256: "a".repeat(64) }],
    [{ path: "generated-tests/Invariant.t.sol", size_bytes: 1 }],
    [{ path: "generated-tests/Invariant.t.sol", size_bytes: 0, sha256: "a".repeat(64) }],
    [{ path: "generated-tests/Invariant.t.sol", size_bytes: 16 * 1024 * 1024 + 1, sha256: "a".repeat(64) }]
  ]) {
    const candidate = { ...manifest, generated_tests };
    assert.equal(validateGeneratedTestManifestSchema(candidate).ok, false);
    assert.equal(validateArtifactContract("ultrafuzz/generated-tests@3", JSON.stringify(candidate)).ok, false);
  }
  for (const candidate of [
    { ...manifest, provenance: {} },
    { ...manifest, generated_tests: [{ ...manifest.generated_tests[0]!, provenance: {} }] }
  ]) {
    assert.equal(validateGeneratedTestManifestSchema(candidate).ok, false);
    assert.equal(validateArtifactContract("ultrafuzz/generated-tests@3", JSON.stringify(candidate)).ok, false);
  }

  const noncanonical = {
    schema_version: GENERATED_TESTS_SCHEMA_VERSION,
    run_id: "run-1",
    node_id: "strategy-a",
    framework: "foundry",
    support_files: [],
    test_files: [{ path: "generated-tests/Invariant.t.sol" }]
  };
  const invalid = validateGeneratedTestManifestSchema(noncanonical);

  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.some((issue) => issue.path === "$.generated_tests"));

  const exportedPathPattern = new RegExp(GENERATED_TEST_MANIFEST_PATH_PATTERN, "u");
  const cases = [
    { path: "generated-tests/Invariant.t.sol", ok: true },
    { path: "generated-tests/nested/Invariant_2.t.sol", ok: true },
    { path: `generated-tests/${"a".repeat(128)}`, ok: true },
    { path: `generated-tests/${"a".repeat(129)}`, ok: false },
    { path: "tests/Invariant.t.sol", ok: false },
    { path: "../Invariant.t.sol", ok: false },
    { path: "generated-tests/../../Invariant.t.sol", ok: false },
    { path: "generated-tests/sub/../Invariant.t.sol", ok: false },
    { path: "generated-tests/./Invariant.t.sol", ok: false },
    { path: "generated-tests//Invariant.t.sol", ok: false },
    { path: "generated-tests/nested\\Invariant.t.sol", ok: false },
    { path: "generated-tests/Invariant.t.sol\n", ok: false },
    { path: "generated-tests:Invariant.t.sol", ok: false }
  ];
  for (const candidate of cases) {
    const value = structuredClone(manifest);
    value.generated_tests[0]!.path = candidate.path;
    assert.equal(validateGeneratedTestManifestSchema(value).ok, candidate.ok, candidate.path);
    assert.equal(exportedPathPattern.test(candidate.path), candidate.ok, candidate.path);
  }
});

test("generated-test file-directory path conflicts remain explicit document semantics", () => {
  const manifest = {
    schema_version: GENERATED_TESTS_SCHEMA_VERSION,
    run_id: "run-1",
    node_id: "strategy-a",
    framework: "foundry",
    generated_tests: [
      {
        path: "generated-tests/Replay.t.sol",
        size_bytes: 1,
        sha256: "a".repeat(64)
      }
    ],
    support_files: [
      {
        path: "generated-tests/Replay.t.sol/InvariantFixture.sol",
        size_bytes: 1,
        sha256: "b".repeat(64)
      }
    ]
  };

  assert.equal(validateGeneratedTestManifestSchema(manifest).ok, true);
  assert.equal(validateArtifactContract("ultrafuzz/generated-tests@3", JSON.stringify(manifest)).ok, true);
  assert.throws(() => assertGeneratedTestManifestSchema(manifest), /conflicts with file path/u);
});

test("present generated-test aggregation provenance cannot be an empty object", () => {
  const manifest = {
    schema_version: "ultrafuzz.aggregation-manifest.v1",
    source_generated_tests: 1,
    copied_generated_tests: 1,
    source_support_files: 0,
    copied_support_files: 0,
    source_bundles: [
      {
        strategy: "boundary-tests",
        node_id: "boundary-tests--attempt-0",
        source_attempt_id: "boundary-tests--attempt-0--model-0",
        attempt_index: 0,
        source_manifest_path: "/run/artifacts/boundary-tests--attempt-0--model-0/generated-tests.json",
        source_manifest_relative_path: "generated-tests.json",
        source_manifest_sha256: "b".repeat(64),
        source_run_id: "run-1",
        framework: "foundry",
        generated_test_count: 1,
        support_file_count: 0,
        disposition: "copied"
      }
    ],
    files: [
      {
        strategy: "boundary-tests",
        node_id: "boundary-tests--attempt-0",
        source_attempt_id: "boundary-tests--attempt-0--model-0",
        attempt_index: 0,
        source_manifest_path: "/run/artifacts/boundary-tests--attempt-0--model-0/generated-tests.json",
        source_manifest_relative_path: "generated-tests.json",
        source_manifest_sha256: "b".repeat(64),
        source_artifact_path: "/run/artifacts/boundary-tests--attempt-0--model-0/generated-tests/Boundary.t.sol",
        source_relative_path: "generated-tests/Boundary.t.sol",
        destination_path: "/run/workspaces/aggregate/test/Boundary.t.sol",
        destination_relative_path: "test/Boundary.t.sol",
        size_bytes: 1,
        sha256: "a".repeat(64),
        provenance: {}
      }
    ],
    support_files: [],
    skipped_files: []
  };

  assert.equal(aggregationManifestSchema.safeParse(manifest).success, false);
  assert.equal(validateArtifactContract("ultrafuzz/aggregation-manifest@1", JSON.stringify(manifest)).ok, false);
});

test("coverage goal status, scoped measurement, target, and blocker evidence stay coupled", () => {
  const base = {
    schema_version: "ultrafuzz.coverage-goal.v2",
    target: { scope: "recon-selected-declaration-completeness", minimum_percent: 90 },
    current_measurement: null as null | {
      scope: "recon-selected-declaration-completeness";
      covered_ranges: number;
      total_ranges: number;
    },
    current_status: "not-run",
    planned_commands: [],
    stop_conditions: ["reserve time for finalization"],
    timeout_seconds: 60,
    finalization_reserve_seconds: 10,
    blockers: [] as Array<{ category: string; summary: string; evidence_paths: string[] }>
  };
  const blocker = { category: "coverage-tooling-blocked", summary: "covg-eval unavailable", evidence_paths: [] };
  const cases = [
    { name: "not run", value: base, expected: true },
    {
      name: "not run with measurement",
      value: {
        ...base,
        current_measurement: { scope: "recon-selected-declaration-completeness", covered_ranges: 0, total_ranges: 1 }
      },
      expected: false
    },
    {
      name: "in progress",
      value: {
        ...base,
        current_status: "in-progress",
        current_measurement: { scope: "recon-selected-declaration-completeness", covered_ranges: 1, total_ranges: 2 }
      },
      expected: true
    },
    {
      name: "in progress with terminal blocker",
      value: { ...base, current_status: "in-progress", blockers: [blocker] },
      expected: false
    },
    {
      name: "target met",
      value: {
        ...base,
        current_status: "target-met",
        current_measurement: { scope: "recon-selected-declaration-completeness", covered_ranges: 9, total_ranges: 10 }
      },
      expected: true
    },
    {
      name: "below target",
      value: {
        ...base,
        current_status: "below-target",
        current_measurement: { scope: "recon-selected-declaration-completeness", covered_ranges: 8, total_ranges: 10 }
      },
      expected: true
    },
    {
      name: "empty denominator is below target",
      value: {
        ...base,
        current_status: "below-target",
        current_measurement: { scope: "recon-selected-declaration-completeness", covered_ranges: 0, total_ranges: 0 }
      },
      expected: true
    },
    {
      name: "target met with empty denominator",
      value: {
        ...base,
        current_status: "target-met",
        current_measurement: { scope: "recon-selected-declaration-completeness", covered_ranges: 0, total_ranges: 0 }
      },
      expected: false,
      structurallyExpected: true
    },
    {
      name: "terminal measurement without counts",
      value: { ...base, current_status: "target-met" },
      expected: false,
      structurallyExpected: false
    },
    {
      name: "measurement numerator exceeds denominator",
      value: {
        ...base,
        current_status: "target-met",
        current_measurement: { scope: "recon-selected-declaration-completeness", covered_ranges: 2, total_ranges: 1 }
      },
      expected: false,
      structurallyExpected: true
    },
    { name: "blocked", value: { ...base, current_status: "blocked", blockers: [blocker] }, expected: true },
    {
      name: "blocked with measurement",
      value: {
        ...base,
        current_status: "blocked",
        current_measurement: { scope: "recon-selected-declaration-completeness", covered_ranges: 0, total_ranges: 1 },
        blockers: [blocker]
      },
      expected: false
    },
    { name: "blocked without blocker", value: { ...base, current_status: "blocked" }, expected: false },
    {
      name: "noncanonical target",
      value: { ...base, target: { ...base.target, minimum_percent: 80 } },
      expected: false
    },
    {
      name: "legacy bare percentage",
      value: { ...base, current_status: "target-met", current_measurement: 90 },
      expected: false,
      structurallyExpected: false
    }
  ] as const;
  for (const candidate of cases) {
    assert.equal(coverageGoalSchema.safeParse(candidate.value).success, candidate.expected, `${candidate.name}:zod`);
    const structurallyExpected =
      "structurallyExpected" in candidate ? candidate.structurallyExpected : candidate.expected;
    assert.equal(
      validateArtifactContract("ultrafuzz/coverage-goal@2", JSON.stringify(candidate.value)).ok,
      structurallyExpected,
      `${candidate.name}:json-schema`
    );
    assert.equal(
      executeSemanticGate("coverage-goal-reconciliation", { document: candidate.value }).status === "passed",
      candidate.expected,
      `${candidate.name}:semantic`
    );
  }
});

test("differential lane statuses require their exact terminal evidence in JSON Schema and Zod", () => {
  const assignedLane = {
    lane_id: "lane-a",
    attempt_index: 0,
    auditor_attempt_index: 0,
    planner_attempt_index: 0,
    harness_author_attempt_index: 0,
    source_plan_artifact: "differential-plan.json",
    source_harness_artifact: "reference-harness.json",
    surface_id: "surface-a",
    intended_t_sol_path: "test/foundry/differential/LaneA.t.sol",
    focused_command: "forge test --match-path test/foundry/differential/LaneA.t.sol",
    public_evidence_paths: ["docs/spec.md"],
    exact_observable_equality_assertions: ["returns match"],
    oracle_type: "independent_reference",
    calibration_bucket: "red_seeking_adversarial",
    red_seeking_priority: "high"
  };
  const green = {
    schema_version: "ultrafuzz.differential-lane-result.v1",
    lane_id: assignedLane.lane_id,
    attempt_index: 0,
    auditor_attempt_index: 0,
    source_auditor_artifact: "audited-differential-lanes.json",
    source_plan_artifact: assignedLane.source_plan_artifact,
    source_harness_artifact: assignedLane.source_harness_artifact,
    assigned_lane_payload: assignedLane,
    authored_paths: [assignedLane.intended_t_sol_path],
    focused_command: assignedLane.focused_command,
    focused_command_ran: true,
    matched_test_count: 1,
    status: "green",
    red_preservation_audit: {
      result: "no_semantic_red_observed",
      pre_repair_file_hash: null,
      assertion_predicate: null
    },
    red_candidates: [] as unknown[],
    compile_or_harness_defects: [] as unknown[],
    public_evidence_paths: [] as string[],
    notes: [] as string[]
  };
  const noLane = {
    ...green,
    lane_id: null,
    source_plan_artifact: null,
    source_harness_artifact: null,
    assigned_lane_payload: null,
    authored_paths: [],
    focused_command: null,
    focused_command_ran: false,
    matched_test_count: 0,
    status: "no_assigned_lane",
    red_preservation_audit: {
      result: "not_applicable",
      pre_repair_file_hash: null,
      assertion_predicate: null
    }
  };
  const frozen = {
    ...green,
    status: "semantic_red_frozen",
    red_preservation_audit: {
      result: "semantic_red_frozen",
      pre_repair_file_hash: "a".repeat(64),
      assertion_predicate: "actual == expected"
    },
    red_candidates: [
      {
        stable_failure_hash: crypto
          .createHash("sha256")
          .update(
            JSON.stringify([
              "semantic-red-v1",
              assignedLane.lane_id,
              "red-a",
              assignedLane.intended_t_sol_path,
              "test_lane_a",
              assignedLane.focused_command,
              "mismatch",
              "actual == expected",
              "1",
              "2",
              ["docs/spec.md"],
              "a".repeat(64)
            ]),
            "utf8"
          )
          .digest("hex"),
        red_candidate_id: "red-a",
        test_path: assignedLane.intended_t_sol_path,
        failing_test_name: "test_lane_a",
        focused_command: assignedLane.focused_command,
        failure_signature: "mismatch",
        assertion: "actual == expected",
        observed: "1",
        expected: "2",
        public_oracle_basis: ["docs/spec.md"],
        classification: "untriaged"
      }
    ]
  };
  const defect = {
    ...green,
    status: "compile_or_harness_defect",
    matched_test_count: 0,
    red_preservation_audit: {
      result: "not_applicable",
      pre_repair_file_hash: null,
      assertion_predicate: null
    },
    compile_or_harness_defects: [
      {
        stable_failure_hash: crypto
          .createHash("sha256")
          .update(
            JSON.stringify(["compile-harness-defect-v1", assignedLane.lane_id, "compile", "compile failed", []]),
            "utf8"
          )
          .digest("hex"),
        category: "compile",
        summary: "compile failed",
        evidence_paths: []
      }
    ]
  };
  const cases = [
    { name: "green", value: green, expected: true },
    { name: "green did not run", value: { ...green, focused_command_ran: false }, expected: false },
    { name: "green matched nothing", value: { ...green, matched_test_count: 0 }, expected: false },
    { name: "green lacks assignment", value: { ...green, lane_id: null }, expected: false },
    { name: "no assigned lane", value: noLane, expected: true },
    { name: "no lane carried source", value: { ...noLane, source_plan_artifact: "plan.json" }, expected: false },
    { name: "frozen red", value: frozen, expected: true },
    { name: "frozen red without candidate", value: { ...frozen, red_candidates: [] }, expected: false },
    { name: "compile defect", value: defect, expected: true },
    {
      name: "defect status without defect",
      value: { ...defect, compile_or_harness_defects: [] },
      expected: false
    }
  ] as const;
  for (const candidate of cases) {
    assert.equal(
      differentialLaneResultSchema.safeParse(candidate.value).success,
      candidate.expected,
      `${candidate.name}:zod`
    );
    assert.equal(
      validateArtifactContract("ultrafuzz/differential-lane-result@1", JSON.stringify(candidate.value)).ok,
      candidate.expected,
      `${candidate.name}:json-schema`
    );
  }
});

test("audited differential attempts can publish at most one ready lane in JSON Schema and Zod", () => {
  const readyLane = {
    lane_id: "lane-a",
    attempt_index: 0,
    auditor_attempt_index: 0,
    planner_attempt_index: 0,
    harness_author_attempt_index: 0,
    source_plan_artifact: "differential-plan.json",
    source_harness_artifact: "reference-harness.json",
    surface_id: "surface-a",
    intended_t_sol_path: "test/foundry/differential/LaneA.t.sol",
    focused_command: "forge test --match-path test/foundry/differential/LaneA.t.sol",
    public_evidence_paths: ["docs/spec.md"],
    exact_observable_equality_assertions: ["returns match"],
    oracle_type: "independent_reference" as const,
    calibration_bucket: "red_seeking_adversarial" as const,
    red_seeking_priority: "high" as const
  };
  const audited = {
    schema_version: "ultrafuzz.audited-differential-lanes.v1",
    auditor_attempt_index: 0,
    source_plan_artifacts: ["differential-plan.json"],
    source_harness_artifacts: ["reference-harness.json"],
    surface_audits: [],
    ready_lanes: [readyLane],
    rejected_or_narrowed_lanes: [],
    reference_gap_work_orders: [],
    ambiguous_spec_work_orders: []
  };

  for (const candidate of [
    { name: "one ready lane", value: audited, expected: true },
    { name: "two ready lanes", value: { ...audited, ready_lanes: [readyLane, readyLane] }, expected: false }
  ] as const) {
    assert.equal(
      auditedDifferentialLanesSchema.safeParse(candidate.value).success,
      candidate.expected,
      `${candidate.name}:zod`
    );
    assert.equal(
      validateArtifactContract("ultrafuzz/audited-differential-lanes@1", JSON.stringify(candidate.value)).ok,
      candidate.expected,
      `${candidate.name}:json-schema`
    );
  }
});

test("semantic-red registries retain the complete frozen failure packet in JSON Schema and Zod", () => {
  const semanticRed = {
    stable_failure_hash: "a".repeat(64),
    lane_id: "lane-a",
    red_candidate_id: "red-a",
    test_path: "test/foundry/differential/LaneA.t.sol",
    failing_test_name: "test_lane_a",
    focused_command: "forge test --match-path test/foundry/differential/LaneA.t.sol",
    failure_signature: "public return mismatch",
    assertion: "actual == expected",
    observed: "1",
    expected: "2",
    public_oracle_basis: ["docs/spec.md"],
    classification: "untriaged" as const,
    pre_repair_file_hash: "b".repeat(64)
  };
  const registry = {
    schema_version: "ultrafuzz.semantic-red-registry.v1",
    semantic_reds: [semanticRed],
    compile_or_harness_defects: []
  };
  const { red_candidate_id: _redCandidateId, ...withoutCandidateId } = semanticRed;
  const { failure_signature: _failureSignature, ...withoutFailureSignature } = semanticRed;

  for (const candidate of [
    { name: "complete packet", value: registry, expected: true },
    { name: "missing candidate ID", value: { ...registry, semantic_reds: [withoutCandidateId] }, expected: false },
    {
      name: "missing failure signature",
      value: { ...registry, semantic_reds: [withoutFailureSignature] },
      expected: false
    },
    {
      name: "rewritten classification",
      value: { ...registry, semantic_reds: [{ ...semanticRed, classification: "production_bug" }] },
      expected: false
    }
  ] as const) {
    assert.equal(
      semanticRedRegistrySchema.safeParse(candidate.value).success,
      candidate.expected,
      `${candidate.name}:zod`
    );
    assert.equal(
      validateArtifactContract("ultrafuzz/semantic-red-registry@1", JSON.stringify(candidate.value)).ok,
      candidate.expected,
      `${candidate.name}:json-schema`
    );
  }
});

test("dynamic strategy plan status and selected population stay coupled in JSON Schema and Zod", () => {
  const base = {
    schema_version: "ultrafuzz.dynamic-strategy-plan.v1",
    dynamic_strategies_enumerator: 1,
    status: "no-actionable-strategies",
    selected_strategy_count: 0,
    selected_strategies: [] as string[],
    rejected_strategies: [],
    current_run_artifacts_considered: [],
    excluded_context: {
      sibling_runs: "excluded",
      previous_reports: "excluded",
      host_global_paths: "excluded",
      network_resources: "excluded",
      extra_target_context: "excluded"
    },
    timeout_seconds: 60,
    finalization_reserve_seconds: 10
  };
  const cases = [
    { name: "no actionable", value: base, expected: true },
    {
      name: "selected",
      value: { ...base, status: "selected", selected_strategy_count: 1, selected_strategies: ["strategy-a"] },
      expected: true
    },
    {
      name: "selected empty",
      value: { ...base, status: "selected" },
      expected: false
    },
    {
      name: "no actionable with selected ID",
      value: { ...base, selected_strategy_count: 1, selected_strategies: ["strategy-a"] },
      expected: false
    },
    {
      name: "blocked with selected ID",
      value: { ...base, status: "blocked", selected_strategy_count: 1, selected_strategies: ["strategy-a"] },
      expected: false
    }
  ] as const;
  for (const candidate of cases) {
    assert.equal(
      dynamicStrategyPlanSchema.safeParse(candidate.value).success,
      candidate.expected,
      `${candidate.name}:zod`
    );
    assert.equal(
      validateArtifactContract("ultrafuzz/dynamic-strategy-plan@1", JSON.stringify(candidate.value)).ok,
      candidate.expected,
      `${candidate.name}:json-schema`
    );
  }
});

test("aggregation skips require a typed source kind and attempt identity", () => {
  const manifest = {
    schema_version: "ultrafuzz.aggregation-manifest.v1",
    source_generated_tests: 1,
    copied_generated_tests: 0,
    source_support_files: 0,
    copied_support_files: 0,
    source_bundles: [
      {
        strategy: "boundary-tests",
        node_id: "boundary-tests--attempt-0",
        source_attempt_id: "boundary-tests--attempt-0--model-0",
        attempt_index: 0,
        source_manifest_path: "/run/artifacts/boundary-tests--attempt-0--model-0/generated-tests.json",
        source_manifest_relative_path: "generated-tests.json",
        source_manifest_sha256: "b".repeat(64),
        source_run_id: "run-1",
        framework: "foundry",
        generated_test_count: 1,
        support_file_count: 0,
        disposition: "skipped",
        reason: "declared framework is incompatible with the checked-in test stack"
      }
    ],
    files: [],
    support_files: [],
    skipped_files: [
      {
        kind: "generated-test",
        strategy: "boundary-tests",
        node_id: "boundary-tests--attempt-0",
        source_attempt_id: "boundary-tests--attempt-0--model-0",
        attempt_index: 0,
        source_manifest_path: "/run/artifacts/boundary-tests--attempt-0--model-0/generated-tests.json",
        source_manifest_relative_path: "generated-tests.json",
        source_manifest_sha256: "b".repeat(64),
        source_artifact_path: "/run/artifacts/boundary-tests--attempt-0--model-0/generated-tests/Boundary.t.sol",
        source_relative_path: "generated-tests/Boundary.t.sol",
        size_bytes: 1,
        sha256: "a".repeat(64),
        reason: "declared framework is incompatible with the checked-in test stack"
      }
    ]
  };
  assert.equal(aggregationManifestSchema.safeParse(manifest).success, true);
  assert.equal(validateArtifactContract("ultrafuzz/aggregation-manifest@1", JSON.stringify(manifest)).ok, true);
  const missingKind = structuredClone(manifest) as Record<string, unknown> & {
    skipped_files: Record<string, unknown>[];
  };
  delete missingKind.skipped_files[0]!.kind;
  assert.equal(aggregationManifestSchema.safeParse(missingKind).success, false);
  assert.equal(validateArtifactContract("ultrafuzz/aggregation-manifest@1", JSON.stringify(missingKind)).ok, false);
});

test("analysis bundle manifest schema rejects unversioned and non-allowlisted entries", () => {
  const manifest = {
    schema_version: ANALYSIS_BUNDLE_SCHEMA_VERSION,
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
  assert.equal(validateAnalysisBundleManifestSchema(manifest).ok, true);
  const registeredSchemaFailure = validateAnalysisBundleManifestSchema({ ...manifest, legacy: true });
  assert.equal(registeredSchemaFailure.ok, false);
  assert.ok(registeredSchemaFailure.issues.every((issue) => issue.code === "ANALYSIS_BUNDLE_MANIFEST_SCHEMA_INVALID"));
  assert.ok(
    registeredSchemaFailure.issues.some((issue) => issue.message === "must NOT have additional properties"),
    "the registered Ajv schema must remain the manifest shape authority"
  );
  assert.equal(
    validateAnalysisBundleManifestSchema({
      ...manifest,
      files: [...manifest.files, { ...manifest.files[0], kind: "raw-output", path: "raw-output.json" }]
    }).ok,
    false
  );
  assert.equal(
    validateAnalysisBundleManifestSchema({
      ...manifest,
      files: [{ ...manifest.files[0], kind: "terminal-status", path: "omissions.json" }]
    }).ok,
    false
  );
  assert.equal(validateAnalysisBundleManifestSchema({ ...manifest, files: [] }).ok, false);
});

test("usage ledger schema accepts only exact projected Smithers usage", () => {
  const entry = {
    schema_version: USAGE_LEDGER_SCHEMA_VERSION,
    run_id: "run-1",
    workflow_run_id: "workflow-1",
    control_generation: "c".repeat(64),
    source_event_sequence: 1,
    observed_timestamp_ms: Date.parse("2026-07-18T00:00:00.000Z"),
    node_id: "node:1",
    iteration: 0,
    attempt: 1,
    usage: { model: "model", agent: "agent", input_tokens: 1, output_tokens: 2 }
  };

  assert.equal(validateUsageLedgerEntry(entry).ok, true);
  assert.equal(validateUsageLedgerEntry({ ...entry, source_event_id: "legacy" }).ok, false);
  assert.equal(validateUsageLedgerEntry({ ...entry, usage: { ...entry.usage, total_tokens: 3 } }).ok, false);
});

test("node attempt ledger shape stays structural while byte and ordering rules remain semantic gates", () => {
  const entry = {
    schema_version: NODE_ATTEMPT_LEDGER_SCHEMA_VERSION,
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
      started_at: "2026-07-18T10:00:00.000Z",
      finished_at: "2026-07-18T10:01:00.000Z"
    },
    outcome: "failed",
    reuse: { status: "executed" },
    manifests: {
      input_sha256: "a".repeat(64),
      output_sha256: null
    },
    failure_category: "executor-error",
    failure_message: "artifact contract rejected findings.json"
  };
  assert.equal(validateNodeAttemptLedgerEntry(entry).ok, true);
  assert.equal(validateNodeAttemptLedgerEntry({ ...entry, node_id: "node:strategy-1" }).ok, false);
  assert.equal(validateNodeAttemptLedgerEntry({ ...entry, failure_message: "" }).ok, false);
  assert.equal(validateNodeAttemptLedgerEntry({ ...entry, failure_message: "🙂".repeat(251) }).ok, true);
  assert.equal(validateNodeAttemptLedgerEntry({ ...entry, failure_message: "x".repeat(1_001) }).ok, false);
  assert.equal(validateNodeAttemptLedgerEntry({ ...entry, diagnostic: { message: "raw failure" } }).ok, false);
  assert.equal(
    validateNodeAttemptLedgerEntry({
      ...entry,
      lifecycle: {
        started_at: "2026-07-18T10:00:00.000+02:00",
        finished_at: "2026-07-18T08:30:00.000Z"
      }
    }).ok,
    true
  );
  assert.equal(
    validateNodeAttemptLedgerEntry({
      ...entry,
      lifecycle: {
        started_at: "2026-07-18T10:00:00.000+02:00",
        finished_at: "2026-07-18T07:59:59.000Z"
      }
    }).ok,
    true
  );
});

test("artifact schema snapshots are present and aligned with exported schema constants", () => {
  const findingSnapshot = readSchemaSnapshot("finding.schema.json");
  const coverageEvidenceSnapshot = readSchemaSnapshot("coverage-evidence.schema.json");
  const analysisBundleSnapshot = readSchemaSnapshot("analysis-bundle.schema.json");
  const artifactManifestSnapshot = readSchemaSnapshot("artifact-manifest.schema.json");
  const generatedTestsSnapshot = readSchemaSnapshot("generated-tests.schema.json");
  const invariantLedgerSnapshot = readSchemaSnapshot("invariant-evidence-ledger.schema.json");
  const invariantSourceProofSnapshot = readSchemaSnapshot("invariant-source-proof.schema.json");
  const nodeAttemptLedgerSnapshot = readSchemaSnapshot("node-attempt-ledger.schema.json");
  const propertiesSnapshot = readSchemaSnapshot("properties.schema.json");
  const lensPropertiesSnapshot = readSchemaSnapshot("property-lens.schema.json");
  const referenceExpectationsSnapshot = readSchemaSnapshot("reference-expectations.schema.json");
  const runStateSnapshot = readSchemaSnapshot("run-state.schema.json");
  const trustedCliSnapshot = readSchemaSnapshot("trusted-cli.schema.json");
  const usageLedgerSnapshot = readSchemaSnapshot("usage-ledger.schema.json");
  const threatModelSnapshot = readSchemaSnapshot("threat-model.schema.json");
  const goalPlanSnapshot = readSchemaSnapshot("goal-plan.schema.json");
  const workspacePatchSnapshot = readSchemaSnapshot("workspace-patch.schema.json");

  assert.deepEqual(analysisBundleSnapshot, analysisBundleManifestJsonSchema);
  assert.deepEqual(artifactManifestSnapshot, artifactManifestJsonSchema);
  // Checking only $id and required let the published finding snapshot keep "const": "1.0" after the
  // exported schema had moved on, so the snapshot is compared whole like its siblings.
  assert.deepEqual(findingSnapshot, findingJsonSchema);
  assert.deepEqual(coverageEvidenceSnapshot, coverageEvidenceJsonSchema);
  const boundedCoverageSnapshot = coverageEvidenceSnapshot as {
    oneOf: ReadonlyArray<{
      properties?: {
        files?: { maxItems: number };
        counted_ranges?: { maxItems: number };
        zero_coverage_components?: { maxItems: number };
      };
    }>;
  };
  const measuredCoverage = boundedCoverageSnapshot.oneOf[0]!.properties!;
  assert.equal(measuredCoverage.files!.maxItems, MAX_COVERAGE_EVIDENCE_FILES);
  assert.equal(measuredCoverage.counted_ranges!.maxItems, MAX_COVERAGE_EVIDENCE_RANGES);
  assert.equal(measuredCoverage.zero_coverage_components!.maxItems, MAX_COVERAGE_EVIDENCE_RANGES);
  assert.deepEqual(generatedTestsSnapshot, generatedTestsJsonSchema);
  assert.deepEqual(invariantLedgerSnapshot, invariantLedgerJsonSchema);
  assert.deepEqual(invariantSourceProofSnapshot, invariantSourceProofJsonSchema);
  assert.deepEqual(nodeAttemptLedgerSnapshot, nodeAttemptLedgerJsonSchema);
  assert.deepEqual(runStateSnapshot, runStateJsonSchema);
  const runStateContractEnum = (
    runStateSnapshot.properties as {
      nodes?: {
        additionalProperties?: {
          properties?: { outputs?: { items?: { properties?: { contract?: { enum?: unknown } } } } };
        };
      };
    }
  ).nodes?.additionalProperties?.properties?.outputs?.items?.properties?.contract?.enum;
  assert.deepEqual(runStateContractEnum, ARTIFACT_CONTRACT_IDS);
  assert.deepEqual(propertiesSnapshot, propertiesJsonSchema);
  assert.deepEqual(lensPropertiesSnapshot, lensPropertiesJsonSchema);
  assert.deepEqual(referenceExpectationsSnapshot, referenceExpectationsJsonSchema);
  assert.deepEqual(trustedCliSnapshot, trustedCliMetadataJsonSchema);
  assert.deepEqual(usageLedgerSnapshot, usageLedgerJsonSchema);
  // The threat-model and goal-plan prompts point agents at these canonical documents, so the
  // snapshots must stay generated from the one runtime contract.
  assert.deepEqual(threatModelSnapshot, threatModelJsonSchema);
  assert.deepEqual(goalPlanSnapshot, goalPlanJsonSchema);
  assert.equal(threatModelSnapshot.$id, THREAT_MODEL_JSON_SCHEMA_ID);
  assert.equal(goalPlanSnapshot.$id, GOAL_PLAN_JSON_SCHEMA_ID);
  assert.deepEqual(workspacePatchSnapshot, workspacePatchJsonSchema);
});

test("checked-in artifact schema snapshots contain no duplicate keys", () => {
  const snapshots = readdirSync(path.join(packageRoot, "schema"))
    .filter((name) => name.endsWith(".json"))
    .sort();
  assert.ok(snapshots.includes("finding.schema.json"));
  for (const name of snapshots) {
    assert.deepEqual(
      duplicateJsonKeys(readFileSync(path.join(packageRoot, "schema", name), "utf8")),
      [],
      `${name} must not define the same key twice; ordinary JSON parsing silently keeps the last one`
    );
  }
});

test("finding schema snapshot node-reference patterns and the runtime validator agree in both directions", () => {
  const snapshot = readSchemaSnapshot("finding.schema.json") as {
    properties: Record<string, { pattern?: string; items?: { pattern?: string } }>;
  };
  const patterns = {
    producer_node_id: snapshot.properties.producer_node_id?.pattern,
    source_node_id: snapshot.properties.source_node_id?.pattern,
    source_nodes: snapshot.properties.source_nodes?.items?.pattern
  };
  for (const [field, pattern] of Object.entries(patterns)) {
    assert.equal(pattern, NODE_REFERENCE_PATTERN.source, `${field} must reuse the runtime node-reference pattern`);
  }
  const base = {
    schema_version: FINDINGS_SCHEMA_VERSION,
    id: "finding-1",
    title: "Unbounded input",
    status: "needs-review",
    severity_guess: "High",
    confidence: "medium",
    summary: "Input length reaches an expensive path."
  };
  const candidates = [
    // Historical uppercase node IDs the runtime accepts must not fail the snapshot.
    { nodeId: "StrategyA", ok: true },
    { nodeId: "dynamic:threat:liquidation:overdue", ok: true },
    // Traversal-shaped node IDs the runtime rejects must not pass the snapshot either.
    { nodeId: "../evil", ok: false },
    { nodeId: "./evil", ok: false },
    { nodeId: "evil/../escape", ok: false }
  ];
  for (const candidate of candidates) {
    for (const [field, pattern] of Object.entries(patterns)) {
      assert.equal(
        new RegExp(pattern!, "u").test(candidate.nodeId),
        candidate.ok,
        `${field} snapshot pattern disagrees for ${candidate.nodeId}`
      );
    }
    const finding = {
      ...base,
      producer_node_id: candidate.nodeId,
      source_node_id: candidate.nodeId,
      source_nodes: [candidate.nodeId]
    };
    assert.equal(validateFindingSchema(finding).ok, candidate.ok, candidate.nodeId);
  }
});

/** Detects repeated object keys before ordinary JSON parsing collapses them to the last value. */
function duplicateJsonKeys(text: string): string[] {
  const duplicates: string[] = [];
  const stack: Array<Set<string>> = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    if (character === "{" || character === "[") {
      stack.push(new Set());
      index += 1;
      continue;
    }
    if (character === "}" || character === "]") {
      stack.pop();
      index += 1;
      continue;
    }
    if (character === '"') {
      const parsed = readJsonString(text, index);
      index = parsed.end;
      while (index < text.length && /\s/u.test(text[index]!)) index += 1;
      if (text[index] === ":") {
        const scope = stack[stack.length - 1];
        if (scope !== undefined) {
          if (scope.has(parsed.value)) duplicates.push(parsed.value);
          scope.add(parsed.value);
        }
      }
      continue;
    }
    index += 1;
  }
  return duplicates;
}

function readJsonString(text: string, start: number): { value: string; end: number } {
  let index = start + 1;
  let value = "";
  while (index < text.length) {
    const character = text[index]!;
    if (character === "\\") {
      value += text.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (character === '"') return { value, end: index + 1 };
    value += character;
    index += 1;
  }
  throw new Error("unterminated JSON string in schema snapshot");
}

function readSchemaSnapshot(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(packageRoot, "schema", name), "utf8")) as Record<string, unknown>;
}

function findPackageRoot(start: string): string {
  let current = path.resolve(start);
  while (current !== path.dirname(current)) {
    if (readableSchemaDir(current)) {
      return current;
    }
    current = path.dirname(current);
  }
  return path.resolve(start, "..");
}

function readableSchemaDir(candidate: string): boolean {
  try {
    readFileSync(path.join(candidate, "schema", "finding.schema.json"));
    return true;
  } catch {
    return false;
  }
}

// R51 died three times at `stateful-invariant-implement-properties` on this, and the error said only
// `Too small: expected array to have >=1 items` eighty-eight times with no field path. The document --
// 173,510 bytes, recovered from the task workspace on the durable volume -- held 89 properties, every one
// `status: "pending"` with a `pending-triage` blocker, and every one carrying `reference_expectations: []`.
//
// `reference_expectations` is OPTIONAL in all three places it appears, so `.min(1)` never guards a required
// field: it only makes an empty list invalid where omitting the field entirely is valid. An empty optional
// list is a natural thing for a producer to emit and means exactly what omission means (issue #328).
test("an empty optional reference_expectations list is accepted, as omitting it already was", () => {
  const property = {
    property_id: "property-1",
    status: "pending" as const,
    implementation_paths: [],
    test_paths: [],
    blocker: {
      code: "pending-triage",
      summary: "Awaiting invariant-suite implementation triage.",
      next_action: "Audit the harness and either implement the assertion or record a concrete blocker."
    }
  };
  // `@3` requires `selection`; omitting it would make this test pass or fail for the wrong reason.
  // R51's real document carried a selection block, which is why its only error was the expectations list.
  const document = (extra: Record<string, unknown>) =>
    JSON.stringify({
      schema_version: IMPLEMENTED_PROPERTIES_SCHEMA_VERSION,
      properties: [{ ...property, ...extra }],
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] }
    });

  // Omitting it was always valid; the empty array must be too, and a populated one must keep working.
  assert.equal(validateArtifactContract("ultrafuzz/implemented-properties@3", document({})).ok, true);
  const empty = validateArtifactContract(
    "ultrafuzz/implemented-properties@3",
    document({ reference_expectations: [] })
  );
  assert.equal(empty.ok, true, JSON.stringify(empty.issues));
  assert.equal(
    validateArtifactContract("ultrafuzz/implemented-properties@3", document({ reference_expectations: ["e1"] })).ok,
    true
  );
});

test("a duplicated reference expectation is still rejected once empty lists are allowed", () => {
  // Accepting `[]` must not accept anything else. The dedup rule inside the list is the reason the schema
  // is more than `z.array(string)`, so it has to survive the change.
  const result = validateArtifactContract(
    "ultrafuzz/implemented-properties@3",
    JSON.stringify({
      schema_version: IMPLEMENTED_PROPERTIES_SCHEMA_VERSION,
      properties: [
        {
          property_id: "property-1",
          status: "implemented" as const,
          implementation_paths: ["test/recon/Properties.sol"],
          test_paths: ["test/recon/CryticTester.sol"],
          reference_expectations: ["e1", "e1"]
        }
      ],
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] }
    })
  );
  assert.equal(result.ok, false);
  assert.ok(
    result.issues.some((issue) => /duplicate/iu.test(issue.message)),
    JSON.stringify(result.issues)
  );
});

test("every schema validation issue carries the field path that identifies it", () => {
  // PRE-EXISTING INVARIANT, not a test of #328. `validateWithZod` already populated `issue.path`, so this
  // passes on `main` unchanged -- review caught me claiming otherwise. The #328 bug was the TEMPLATE's
  // formatter discarding the path, and this file never loads the template; that behaviour is covered by
  // `#328 a contract failure names the field paths` in packages/runtime/test.
  //
  // Kept because the invariant is what makes that formatter possible: if paths ever stopped being
  // populated here, the useful message downstream would silently become useless again.
  const result = validateArtifactContract(
    "ultrafuzz/implemented-properties@3",
    JSON.stringify({
      schema_version: IMPLEMENTED_PROPERTIES_SCHEMA_VERSION,
      properties: [{ property_id: "", status: "pending", implementation_paths: [], test_paths: [] }],
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] }
    })
  );
  assert.equal(result.ok, false);
  for (const issue of result.issues) {
    assert.ok(typeof issue.path === "string" && issue.path.length > 0, JSON.stringify(issue));
    assert.ok(/properties/u.test(issue.path), `path should locate the offending field: ${issue.path}`);
  }
});
