import assert from "node:assert/strict";
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
  NODE_ATTEMPT_LEDGER_SCHEMA_VERSION,
  NODE_STATE_STATUSES,
  RUN_STATE_STATUSES,
  PROPERTIES_SCHEMA_VERSION,
  PLANNED_GRAPH_SCHEMA_VERSION,
  PROPERTY_LENS_SCHEMA_VERSION,
  PROPERTY_CAMPAIGN_SCHEMA_VERSION,
  REPORT_SCHEMA_VERSION,
  USAGE_LEDGER_SCHEMA_VERSION,
  ARTIFACT_CONTRACT_IDS,
  artifactManifestJsonSchema,
  analysisBundleManifestJsonSchema,
  artifactContractDefinition,
  artifactContractSchemaBinding,
  createInitialRunState,
  assertPlannedGraph,
  assertPlannedGraphSemantics,
  findingJsonSchema,
  generatedTestsJsonSchema,
  invariantLedgerJsonSchema,
  invariantSourceProofJsonSchema,
  lensPropertiesJsonSchema,
  nodeAttemptLedgerJsonSchema,
  propertiesJsonSchema,
  referenceExpectationsJsonSchema,
  runStateJsonSchema,
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
  validateArtifactContract,
  validateNodeAttemptLedgerEntry,
  validatePropertiesSchema,
  validatePlannedGraph,
  validatePropertyCampaignSchema,
  validatePropertyReferences,
  validateRunStateSchema,
  validateUsageLedgerEntry,
  materializePromptSchemas,
  ARTIFACT_CONTRACT_SCHEMA_FILES,
  artifactContractSchemaFile,
  isArtifactContractId,
  type ArtifactContractId,
  type PlannedGraphDocument,
  type PlannedGraphNodeDocument,
  trustedCliMetadataJsonSchema
} from "../src/index.js";

const packageRoot = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));

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
  const definition = artifactContractDefinition("ultrafuzz/report@2");
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
    "ultrafuzz/properties@1",
    "ultrafuzz/property-campaign@1",
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

  assert.equal(validateFindingSchema(finding).ok, true);
  assert.equal(validateFindingsSchema([finding]).ok, true);

  const missingSummary = { ...finding };
  delete (missingSummary as Partial<typeof finding>).summary;
  const invalid = validateFindingSchema(missingSummary);

  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.some((issue) => issue.path === "$.summary"));
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
  assert.ok(invalidSource.issues.some((issue) => issue.path.endsWith(".sources[0]") && /note/u.test(issue.message)));

  const duplicateLedgerIds = {
    ...oneSource,
    properties: [{ ...oneSource.properties[0]!, ledger_ids: ["evidence-1", "evidence-1"] }]
  };
  const invalidLedgerIds = validatePropertiesSchema(duplicateLedgerIds);
  assert.equal(invalidLedgerIds.ok, false);
  assert.ok(invalidLedgerIds.issues.some((issue) => /Duplicate invariant ledger ID/u.test(issue.message)));
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
  assert.equal(
    validatePropertyCampaignSchema({
      schema_version: PROPERTY_CAMPAIGN_SCHEMA_VERSION,
      fuzzer_backend: "recon",
      failures: [{ id: "failure-1", status: "reproduced", property_ids: ["property-1"] }]
    }).ok,
    true
  );
  assert.equal(
    validatePropertyCampaignSchema({
      schema_version: PROPERTY_CAMPAIGN_SCHEMA_VERSION,
      failures: [
        { id: "failure-1", status: "reproduced", property_ids: ["property-1", "property-1"] },
        { id: "failure-1", status: "reproduced" }
      ]
    }).ok,
    false,
    "campaign failure IDs and property references must be unambiguous"
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
  assert.ok(
    invalid.issues.some((issue) => /implemented property must identify at least one source/u.test(issue.message))
  );
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
    contributing_backend_failures: [
      "failure-1",
      { fuzzer_backend: "medusa", failure_id: "failure-2", raw_result_ref: "medusa-results.json" }
    ],
    deduplication: { pre_dedup_count: 2, basis: "same root cause" }
  };
  assert.equal(validateFindingSchema(finding).ok, true);
  assert.equal(validateArtifactContract("ultrafuzz/findings@2", JSON.stringify([finding])).ok, true);
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

test("finding and report v2 schemas require their current canonical shapes", () => {
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
      strategy_loops: 1
    },
    issues: [],
    non_production_outcomes: [],
    property_provenance: []
  };
  assert.equal(validateArtifactContract("ultrafuzz/report@2", JSON.stringify(report)).ok, true);
  assert.equal(
    validateArtifactContract("ultrafuzz/report@2", JSON.stringify({ ...report, schema_version: "1.0" })).ok,
    false
  );
  const withoutProvenance = { ...report } as Partial<typeof report>;
  delete withoutProvenance.property_provenance;
  assert.equal(validateArtifactContract("ultrafuzz/report@2", JSON.stringify(withoutProvenance)).ok, false);

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
  assert.equal(validateArtifactContract("ultrafuzz/report@2", JSON.stringify(reportWithTypedEvidence)).ok, true);
  assert.equal(
    validateArtifactContract(
      "ultrafuzz/report@2",
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
  assert.equal(state.schema_version, "ultrafuzz.run-state.v4");
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

test("planned graph v3 validates whole documents and executes every registered document semantic gate", () => {
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
    graph_version: "3" as const,
    topology_version: 2 as const,
    groups: {},
    nodes: [node]
  };

  assert.equal(validatePlannedGraph(graph).ok, true);
  assert.deepEqual(assertPlannedGraph(graph), graph);
  assert.equal(validatePlannedGraph({ ...graph, schema_version: "2.0" }).ok, false);
  assert.equal(validatePlannedGraph({ ...graph, legacy: true }).ok, false);
  const findingsOutput = {
    path: "findings.json",
    contract: "ultrafuzz/findings@2" as const,
    contract_digest: artifactContractDefinition("ultrafuzz/findings@2").digest,
    ...artifactContractSchemaBinding("ultrafuzz/findings@2"),
    primary: true
  };

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
    generated_tests: [
      {
        path: "generated-tests/Invariant.t.sol",
        language: "solidity",
        framework: "foundry",
        description: "Focused invariant replay"
      }
    ]
  };

  assert.equal(validateGeneratedTestManifestSchema(manifest).ok, true);

  const noncanonical = {
    schema_version: GENERATED_TESTS_SCHEMA_VERSION,
    run_id: "run-1",
    node_id: "strategy-a",
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
  const workspacePatchSnapshot = readSchemaSnapshot("workspace-patch.schema.json");

  assert.deepEqual(analysisBundleSnapshot, analysisBundleManifestJsonSchema);
  assert.deepEqual(artifactManifestSnapshot, artifactManifestJsonSchema);
  // Checking only $id and required let the published finding snapshot keep "const": "1.0" after the
  // exported schema had moved on, so the snapshot is compared whole like its siblings.
  assert.deepEqual(findingSnapshot, findingJsonSchema);
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
  assert.deepEqual(workspacePatchSnapshot, workspacePatchJsonSchema);
});

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
