import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import os from "node:os";

import {
  ANALYSIS_BUNDLE_SCHEMA_VERSION,
  FINDINGS_SCHEMA_VERSION,
  FINDINGS_SCHEMA_VERSIONS,
  GENERATED_TESTS_SCHEMA_VERSION,
  INVARIANT_LEDGER_SCHEMA_VERSION,
  INVARIANT_SOURCE_PROOF_SCHEMA_VERSION,
  IMPLEMENTED_PROPERTIES_SCHEMA_VERSION,
  NODE_ATTEMPT_LEDGER_SCHEMA_VERSION,
  NODE_STATE_STATUSES,
  RUN_STATE_STATUSES,
  PROPERTIES_SCHEMA_VERSION,
  PROPERTY_LENS_SCHEMA_VERSION,
  PROPERTY_CAMPAIGN_SCHEMA_VERSION,
  USAGE_LEDGER_SCHEMA_VERSION,
  ARTIFACT_CONTRACT_IDS,
  analysisBundleManifestJsonSchema,
  artifactContractDefinition,
  createInitialRunState,
  findingJsonSchema,
  generatedTestsJsonSchema,
  invariantLedgerJsonSchema,
  invariantSourceProofJsonSchema,
  lensPropertiesJsonSchema,
  nodeAttemptLedgerJsonSchema,
  propertiesJsonSchema,
  referenceExpectationsJsonSchema,
  resolveCampaignFindingBackends,
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
  validatePropertyCampaignSchema,
  validatePropertyReferences,
  validateRunStateSchema,
  validateUsageLedgerEntry,
  materializePromptSchemas,
  ARTIFACT_CONTRACT_SCHEMA_FILES,
  artifactContractSchemaFile,
  isArtifactContractId,
  type ArtifactContractId,
  type PropertyCampaignArtifact
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

test("artifact contract registry validates structured, empty, and malformed outputs", () => {
  const definition = artifactContractDefinition("ultrafuzz/report@1");
  assert.match(definition.digest, /^[0-9a-f]{64}$/u);
  assert.equal(validateArtifactContract("ultrafuzz/findings@1", "[]").ok, true);
  assert.equal(validateArtifactContract("ultrafuzz/json-object@1", "[]").ok, false);
  assert.equal(
    validateArtifactContract(
      "ultrafuzz/property-lens@1",
      JSON.stringify({
        schema_version: PROPERTY_LENS_SCHEMA_VERSION,
        properties: [
          { id: "aviggiano-001", description: "Expected behavior", category: "accounting", priority: "high" }
        ]
      })
    ).ok,
    true
  );
  assert.equal(validateArtifactContract("ultrafuzz/nonempty-markdown@1", " \n").ok, false);
  assert.equal(
    validateArtifactContract(
      "ultrafuzz/report@1",
      JSON.stringify({ schema_version: "1.0", run_metadata: {}, issues: [], non_production_outcomes: [] })
    ).ok,
    true
  );
  assert.equal(
    validateArtifactContract(
      "ultrafuzz/report@1",
      JSON.stringify({
        schema_version: "1.0",
        run_metadata: {},
        issues: [],
        non_production_outcomes: [],
        property_implementation_coverage: {
          priority_threshold: "high",
          priorities: ["high"],
          selected_property_ids: ["property-1"],
          implemented_property_ids: ["property-1"],
          blocked_property_ids: [],
          pending_property_ids: [],
          deferred_property_ids: []
        }
      })
    ).ok,
    true
  );
  assert.equal(
    validateArtifactContract(
      "ultrafuzz/report@1",
      JSON.stringify({
        schema_version: "1.0",
        run_metadata: {},
        issues: [],
        non_production_outcomes: [],
        property_implementation_coverage: {
          priority_threshold: "high",
          priorities: ["high"],
          selected_property_ids: ["property-1", "property-1"],
          implemented_property_ids: [],
          blocked_property_ids: [],
          pending_property_ids: [],
          deferred_property_ids: []
        }
      })
    ).ok,
    false,
    "coverage ID arrays must be unique"
  );
  // R55 emitted blocker_summaries as the typed handoff objects and the whole
  // report was discarded at the last node in the pipeline. Pin both sides of
  // the shape the prompt now documents.
  assert.equal(
    validateArtifactContract(
      "ultrafuzz/report@1",
      JSON.stringify({
        schema_version: "1.0",
        run_metadata: {},
        issues: [],
        non_production_outcomes: [],
        property_implementation_coverage: {
          priority_threshold: "high",
          priorities: ["high"],
          selected_property_ids: ["property-1"],
          implemented_property_ids: [],
          blocked_property_ids: [],
          pending_property_ids: [],
          deferred_property_ids: ["property-1"],
          blocker_summaries: [
            {
              property_id: "property-1",
              status: "deferred",
              code: "transition-oracle-deferred",
              summary: "The handler cannot observe the premium delta.",
              next_action: "Add property-scoped snapshots around the handler."
            }
          ]
        }
      })
    ).ok,
    false,
    "blocker_summaries must be strings, not the typed handoff objects"
  );
  // R55 failed with `Invalid input at report.json#property_implementation_coverage`,
  // which named neither the field nor the reason, because the union hid the
  // object branch's issues. The diagnostic must point at the offending element.
  const blockerObjectIssues = validateArtifactContract(
    "ultrafuzz/report@1",
    JSON.stringify({
      schema_version: "1.0",
      run_metadata: {},
      issues: [],
      non_production_outcomes: [],
      property_implementation_coverage: {
        priority_threshold: "high",
        priorities: ["high"],
        selected_property_ids: ["property-1"],
        implemented_property_ids: [],
        blocked_property_ids: [],
        pending_property_ids: [],
        deferred_property_ids: ["property-1"],
        blocker_summaries: [{ property_id: "property-1", summary: "The handler cannot observe the delta." }]
      }
    })
  ).issues;
  assert.ok(
    blockerObjectIssues.some((issue) => issue.path?.includes("property_implementation_coverage.blocker_summaries")),
    `expected a diagnostic naming blocker_summaries, got ${JSON.stringify(blockerObjectIssues.map((issue) => issue.path))}`
  );
  assert.equal(
    validateArtifactContract(
      "ultrafuzz/report@1",
      JSON.stringify({
        schema_version: "1.0",
        run_metadata: {},
        issues: [],
        non_production_outcomes: [],
        property_implementation_coverage: {
          priority_threshold: "high",
          priorities: ["high"],
          selected_property_ids: ["property-1"],
          implemented_property_ids: [],
          blocked_property_ids: [],
          pending_property_ids: [],
          deferred_property_ids: ["property-1"],
          blocker_summaries: ["property-1: the handler cannot observe the premium delta"]
        }
      })
    ).ok,
    true,
    "the documented string form is accepted"
  );
  assert.equal(
    validateArtifactContract(
      "ultrafuzz/report@1",
      JSON.stringify({
        schema_version: "1.0",
        run_metadata: {},
        issues: [
          {
            schema_version: FINDINGS_SCHEMA_VERSION,
            id: "finding-1",
            title: "[H-01] - Unbounded input",
            status: "needs-review",
            severity_guess: "High",
            confidence: "medium",
            summary: "Input length reaches an expensive path.",
            strategy: "invariant",
            strategy_provenance: { names: ["invariant", "fuzz"], detection_rate: 0.5 },
            severity: "High",
            impact: "High",
            likelihood: "Medium"
          }
        ],
        non_production_outcomes: []
      })
    ).ok,
    true
  );
  assert.equal(
    validateArtifactContract(
      "ultrafuzz/report@1",
      JSON.stringify({
        schema_version: "1.0",
        run_metadata: {},
        issues: [{ id: "finding-1", title: "Incomplete issue" }],
        non_production_outcomes: []
      })
    ).ok,
    false
  );
  assert.equal(
    validateArtifactContract(
      "ultrafuzz/report@1",
      JSON.stringify({
        schema_version: "ultrafuzz.e2e.report.v1",
        run_metadata: {},
        issues: [],
        non_production_outcomes: [],
        finding_count: 0,
        findings: []
      })
    ).ok,
    true
  );
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

test("finding schema accepts minimal normalized findings and rejects malformed payloads", () => {
  const finding = {
    schema_version: FINDINGS_SCHEMA_VERSION,
    id: "finding-1",
    title: "Unbounded input",
    status: "reproduced_by_generated_test",
    severity_guess: "high",
    confidence: "medium",
    summary: "Input length reaches an expensive path.",
    evidence: ["test/foundry/Generated.t.sol::testIssue", { note: "Generated test reproduces issue" }]
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

test("property lens schema requires normalized priorities and unique IDs", () => {
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
      properties: [valid.properties[0], valid.properties[0]]
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

test("campaign backend resolution prefers finding-owned provenance and only infers an unambiguous legacy backend", () => {
  const campaigns: PropertyCampaignArtifact[] = [
    {
      schema_version: PROPERTY_CAMPAIGN_SCHEMA_VERSION,
      fuzzer_backend: "recon",
      failures: [
        { id: "deduplicated", status: "reproduced" },
        { id: "legacy-recon", status: "reproduced" },
        { id: "ambiguous-id", status: "reproduced" }
      ]
    },
    {
      schema_version: PROPERTY_CAMPAIGN_SCHEMA_VERSION,
      fuzzer_backend: "medusa",
      failures: [
        { id: "medusa-contribution", status: "reproduced" },
        { id: "ambiguous-id", status: "reproduced" }
      ]
    }
  ];
  const resolved = resolveCampaignFindingBackends(campaigns, [
    { id: "deduplicated", fuzzer_backends: ["recon", "medusa"] },
    { id: "legacy-recon" },
    { id: "ambiguous-id" }
  ]);

  assert.deepEqual(resolved.get("deduplicated"), ["medusa", "recon"]);
  assert.deepEqual(resolved.get("legacy-recon"), ["recon"]);
  assert.equal(
    resolved.has("ambiguous-id"),
    false,
    "a coincidental cross-backend failure-ID collision must not manufacture multi-backend provenance"
  );

  const malformedOwner = resolveCampaignFindingBackends(campaigns, [
    { id: "legacy-recon", fuzzer_backend: "recon", fuzzer_backends: ["medusa", "recon"] }
  ]);
  assert.equal(
    malformedOwner.has("legacy-recon"),
    false,
    "present but malformed finding-owned provenance must fail closed instead of falling back"
  );
});

test("property implementation schema rejects source-less implemented records", () => {
  const sourceLess = {
    schema_version: IMPLEMENTED_PROPERTIES_SCHEMA_VERSION,
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

test("property implementation schema rejects duplicate canonical references", () => {
  const duplicate = {
    schema_version: IMPLEMENTED_PROPERTIES_SCHEMA_VERSION,
    properties: [
      {
        property_id: "property-1",
        status: "implemented",
        implementation_paths: ["test/recon/Properties.sol"],
        test_paths: ["test/foundry/Property1.t.sol"]
      },
      {
        property_id: "property-1",
        status: "pending",
        implementation_paths: [],
        test_paths: []
      }
    ]
  };
  const invalid = validateImplementedPropertiesSchema(duplicate);
  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.some((issue) => /Duplicate implemented property ID/u.test(issue.message)));
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

test("current implementation contract requires selection while historical contract remains readable", () => {
  const historical = JSON.stringify({
    schema_version: IMPLEMENTED_PROPERTIES_SCHEMA_VERSION,
    properties: []
  });
  assert.equal(validateArtifactContract("ultrafuzz/implemented-properties@1", historical).ok, true);
  assert.equal(validateArtifactContract("ultrafuzz/implemented-properties@2", historical).ok, false);
  assert.ok(
    validateArtifactContract("ultrafuzz/implemented-properties@2", historical).issues.some(
      (issue) => issue.code === "IMPLEMENTED_PROPERTIES_SELECTION_REQUIRED"
    )
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

test("the findings contract accepts the house-style schema_version and states the literal it wants", () => {
  // R56's stateful-invariant-campaign produced two complete findings and lost the run because it
  // spelled the version the way every sibling artifact spells it.
  const campaignFindings = [
    {
      schema_version: "ultrafuzz.finding.v1",
      id: "failure-1",
      title: "Harness drawn-rate sync assertion ignores elapsed-time precondition",
      status: "confirmed",
      severity_guess: "low",
      confidence: "high",
      summary: "The stored drawn rate lags the recalculated one after time advances.",
      property_ids: ["property-99"]
    }
  ];
  assert.equal(validateArtifactContract("ultrafuzz/findings@1", JSON.stringify(campaignFindings)).ok, true);
  assert.equal(validateFindingsSchema(campaignFindings).ok, true);
  assert.equal(validateFindingSchema(campaignFindings[0]).ok, true);
  assert.equal(
    validateFindingSchema({ ...campaignFindings[0], schema_version: "ultrafuzz.finding.v2" }).ok,
    false,
    "an unknown version is still rejected"
  );

  const description = artifactContractDefinition("ultrafuzz/findings@1").description;
  assert.ok(
    description.includes(`"${FINDINGS_SCHEMA_VERSION}"`),
    "the contract must state the literal, since its empty example is [] and cannot carry one"
  );
});

test("the findings contract does not require schema_version, and still rejects malformed findings", () => {
  // There is one findings schema, nothing reads the field, and normalizeFinding already defaults an
  // absent value. A version string that no reader consults must not be able to end a run.
  const withoutVersion = [
    {
      id: "failure-1",
      title: "Harness drawn-rate sync assertion ignores elapsed-time precondition",
      status: "confirmed",
      severity_guess: "low",
      confidence: "high",
      summary: "The stored drawn rate lags the recalculated one after time advances.",
      property_ids: ["property-99"]
    }
  ];
  assert.equal(validateArtifactContract("ultrafuzz/findings@1", JSON.stringify(withoutVersion)).ok, true);
  assert.equal(validateFindingsSchema(withoutVersion).ok, true);
  assert.equal(validateFindingSchema(withoutVersion[0]).ok, true);

  assert.ok(
    !(findingJsonSchema.required as readonly string[]).includes("schema_version"),
    "the published JSON Schema must agree with the Zod schema that the field is optional"
  );
  assert.deepEqual([...findingJsonSchema.properties.schema_version.enum], [...FINDINGS_SCHEMA_VERSIONS]);

  // Optional does not mean unconstrained: a present value is still checked, and every field the
  // pipeline actually consumes is still required.
  assert.equal(validateFindingSchema({ ...withoutVersion[0], schema_version: "2.0" }).ok, false);
  assert.equal(validateFindingSchema({ ...withoutVersion[0], schema_version: 1 }).ok, false);
  const missingSummary = { ...withoutVersion[0] };
  delete (missingSummary as Partial<typeof missingSummary>).summary;
  assert.equal(validateFindingSchema(missingSummary).ok, false);
  assert.equal(
    validateArtifactContract("ultrafuzz/findings@1", JSON.stringify([missingSummary])).ok,
    false,
    "an otherwise malformed finding still fails the contract"
  );
  assert.equal(validateFindingSchema({ ...withoutVersion[0], property_ids: ["property-99", "property-99"] }).ok, false);
});

test("finding and report schemas accept non-property and historical artifacts", () => {
  const nonPropertyFinding = {
    schema_version: FINDINGS_SCHEMA_VERSION,
    id: "finding-setup",
    title: "Harness setup is incomplete",
    status: "needs-review",
    severity_guess: "low",
    confidence: "high",
    summary: "The setup path is incomplete."
  };
  assert.equal(validateFindingSchema(nonPropertyFinding).ok, true);
  assert.equal(validateFindingSchema({ ...nonPropertyFinding, property_ids: ["property-1", "property-1"] }).ok, false);
  assert.equal(
    validateArtifactContract(
      "ultrafuzz/report@1",
      JSON.stringify({ schema_version: "1.0", run_metadata: {}, issues: [], non_production_outcomes: [] })
    ).ok,
    true,
    "historical reports without property provenance remain valid"
  );
  assert.equal(
    validateArtifactContract(
      "ultrafuzz/report@1",
      JSON.stringify({
        schema_version: "1.0",
        run_metadata: {},
        issues: [],
        non_production_outcomes: [],
        property_provenance: "unavailable"
      })
    ).ok,
    true
  );
  assert.equal(
    validateArtifactContract(
      "ultrafuzz/report@1",
      JSON.stringify({
        schema_version: "1.0",
        run_metadata: {},
        issues: [],
        non_production_outcomes: [],
        property_provenance: [
          {
            finding_id: "finding-property",
            title: "Property failure",
            property_ids: ["property-1"],
            sources: [
              {
                source_node_id: "property-specification-certora",
                source_property_id: "certora-1"
              }
            ],
            implementation_paths: ["test/recon/Properties.sol"],
            test_paths: ["test/foundry/Property1.t.sol"],
            fuzzer_backends: ["echidna", "medusa"]
          }
        ]
      })
    ).ok,
    true
  );
  assert.equal(
    validateArtifactContract(
      "ultrafuzz/report@1",
      JSON.stringify({
        schema_version: "1.0",
        run_metadata: {},
        issues: [],
        non_production_outcomes: [],
        property_provenance: [
          {
            finding_id: "finding-property",
            title: "Property failure",
            property_ids: ["property-1"],
            sources: [{ source_node_id: "property-specification-certora", source_property_id: "certora-1" }],
            implementation_paths: [],
            test_paths: [],
            fuzzer_backend: "echidna",
            fuzzer_backends: ["echidna", "medusa"]
          }
        ]
      })
    ).ok,
    false
  );
  assert.equal(
    validateArtifactContract(
      "ultrafuzz/report@1",
      JSON.stringify({
        schema_version: "1.0",
        run_metadata: {},
        issues: [],
        non_production_outcomes: [],
        property_provenance: [
          {
            finding_id: "finding-property",
            title: "Property failure",
            property_ids: ["property-1"],
            sources: [],
            implementation_paths: ["test/recon/Properties.sol"],
            test_paths: ["test/foundry/Property1.t.sol"]
          }
        ]
      })
    ).ok,
    false
  );
  assert.equal(
    validateArtifactContract(
      "ultrafuzz/report@1",
      JSON.stringify({
        schema_version: "1.0",
        run_metadata: {},
        issues: [],
        non_production_outcomes: [],
        property_provenance: [
          {
            finding_id: "finding-property",
            title: "Property failure",
            property_ids: ["property-1", "property-1"],
            sources: [
              {
                source_node_id: "property-specification-certora",
                source_property_id: "certora-1"
              }
            ],
            implementation_paths: [],
            test_paths: []
          }
        ]
      })
    ).ok,
    false
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
            contract: "ultrafuzz/findings@1",
            contract_digest: "a".repeat(64),
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
  assert.equal(state.schema_version, "1.1");
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

  const missingWait = structuredClone(state);
  delete missingWait.nodes["node-1"]?.wait_since;
  const invalidWait = validateRunStateSchema(missingWait);
  assert.equal(invalidWait.ok, false);
  assert.ok(invalidWait.issues.some((issue) => issue.path.endsWith(".wait_since")));
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

  const legacy = {
    schema_version: GENERATED_TESTS_SCHEMA_VERSION,
    run_id: "run-1",
    node_id: "strategy-a",
    test_files: [{ path: "generated-tests/Invariant.t.sol" }]
  };
  const invalid = validateGeneratedTestManifestSchema(legacy);

  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.some((issue) => issue.path === "$.generated_tests"));

  const exportedPathPattern = new RegExp(
    generatedTestsJsonSchema.properties.generated_tests.items.properties.path.pattern,
    "u"
  );
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

test("generated test contract documents its exact safe companion-file layout", () => {
  const definition = artifactContractDefinition("ultrafuzz/generated-tests@1");

  assert.match(definition.description, /safe forward-slash path/u);
  assert.match(definition.description, /generated-tests\/<file> prefix/u);
  assert.match(definition.description, /exact path beneath the node artifact directory/u);
  assert.match(definition.description, /non-empty regular file/u);
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

test("usage ledger schema requires typed incompleteness markers", () => {
  const entry = {
    schema_version: USAGE_LEDGER_SCHEMA_VERSION,
    event_id: "usage-event-1",
    run_id: "run-1",
    workflow_run_id: "workflow-1",
    source_event_id: "source-event-1",
    attempt_id: "usage-attempt-1",
    checkpoint_generation_id: "checkpoint-1",
    observed_at: "2026-07-18T00:00:00.000Z",
    usage: {},
    usage_complete: false,
    usage_incomplete_reasons: [{ code: "usage-missing" }]
  };

  assert.equal(validateUsageLedgerEntry(entry).ok, true);
  assert.equal(
    validateUsageLedgerEntry({ ...entry, usage_incomplete_reasons: [] }).ok,
    false,
    "incomplete generated usage must carry a typed reason"
  );
});

test("node attempt ledger schema accepts only bounded optional failure messages", () => {
  const entry = {
    schema_version: NODE_ATTEMPT_LEDGER_SCHEMA_VERSION,
    attempt_id: "attempt-1",
    run_id: "run-1",
    node_id: "node-1",
    strategy_attempt_id: "strategy-1",
    executor_retry_id: "retry-1",
    checkpoint_generation_id: "checkpoint-1",
    workflow_execution_id: "execution-1",
    controller_invocation_id: "controller-1",
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
  assert.equal(validateNodeAttemptLedgerEntry({ ...entry, failure_message: "" }).ok, false);
  assert.equal(validateNodeAttemptLedgerEntry({ ...entry, failure_message: "🙂".repeat(251) }).ok, false);
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
    false
  );
});

test("artifact schema snapshots are present and aligned with exported schema constants", () => {
  const findingSnapshot = readSchemaSnapshot("finding.schema.json");
  const analysisBundleSnapshot = readSchemaSnapshot("analysis-bundle.schema.json");
  const generatedTestsSnapshot = readSchemaSnapshot("generated-tests.schema.json");
  const invariantLedgerSnapshot = readSchemaSnapshot("invariant-evidence-ledger.schema.json");
  const invariantSourceProofSnapshot = readSchemaSnapshot("invariant-source-proof.schema.json");
  const nodeAttemptLedgerSnapshot = readSchemaSnapshot("node-attempt-ledger.schema.json");
  const propertiesSnapshot = readSchemaSnapshot("properties.schema.json");
  const lensPropertiesSnapshot = readSchemaSnapshot("property-lens.schema.json");
  const referenceExpectationsSnapshot = readSchemaSnapshot("reference-expectations.schema.json");
  const runStateSnapshot = readSchemaSnapshot("run-state.schema.json");
  const usageLedgerSnapshot = readSchemaSnapshot("usage-ledger.schema.json");
  const workspacePatchSnapshot = readSchemaSnapshot("workspace-patch.schema.json");

  assert.deepEqual(analysisBundleSnapshot, analysisBundleManifestJsonSchema);
  // Checking only $id and required let the published finding snapshot keep "const": "1.0" after the
  // exported schema had moved on, so the snapshot is compared whole like its siblings.
  assert.deepEqual(findingSnapshot, findingJsonSchema);
  assert.deepEqual(generatedTestsSnapshot, generatedTestsJsonSchema);
  assert.deepEqual(invariantLedgerSnapshot, invariantLedgerJsonSchema);
  assert.deepEqual(invariantSourceProofSnapshot, invariantSourceProofJsonSchema);
  assert.equal(nodeAttemptLedgerSnapshot.$id, nodeAttemptLedgerJsonSchema.$id);
  assert.deepEqual(nodeAttemptLedgerSnapshot.required, nodeAttemptLedgerJsonSchema.required);
  assert.equal(runStateSnapshot.$id, runStateJsonSchema.$id);
  assert.deepEqual(runStateSnapshot.required, runStateJsonSchema.required);
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
  // `@2` requires `selection`; omitting it fails with IMPLEMENTED_PROPERTIES_SELECTION_REQUIRED and would
  // make this test pass or fail for a reason unrelated to the field under test. R51's real document did
  // carry a selection block, which is why its ONLY error was the expectations list.
  const document = (extra: Record<string, unknown>) =>
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v1",
      properties: [{ ...property, ...extra }],
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-1"] }
    });

  // Omitting it was always valid; the empty array must be too, and a populated one must keep working.
  assert.equal(validateArtifactContract("ultrafuzz/implemented-properties@2", document({})).ok, true);
  const empty = validateArtifactContract(
    "ultrafuzz/implemented-properties@2",
    document({ reference_expectations: [] })
  );
  assert.equal(empty.ok, true, JSON.stringify(empty.issues));
  assert.equal(
    validateArtifactContract("ultrafuzz/implemented-properties@2", document({ reference_expectations: ["e1"] })).ok,
    true
  );
});

test("a duplicated reference expectation is still rejected once empty lists are allowed", () => {
  // Accepting `[]` must not accept anything else. The dedup rule inside the list is the reason the schema
  // is more than `z.array(string)`, so it has to survive the change.
  const result = validateArtifactContract(
    "ultrafuzz/implemented-properties@2",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v1",
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
    "ultrafuzz/implemented-properties@2",
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v1",
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
