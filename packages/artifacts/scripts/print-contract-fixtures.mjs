import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = await import("../dist/index.js");
const digest = "a".repeat(64);
const fixturePath = path.join(packageRoot, "test", "fixtures", "contract-schema-fixtures.json");
const writeFixtures = process.argv.includes("--write");
const existingFixtures = writeFixtures && fs.existsSync(fixturePath) ? JSON.parse(fs.readFileSync(fixturePath)) : {};
const fixtureOverrides = {
  "ultrafuzz/findings@2": [
    {
      schema_version: "ultrafuzz.finding.v2",
      id: "finding-1",
      title: "Canonical finding",
      status: "candidate",
      severity_guess: "Medium",
      confidence: "medium",
      summary: "A canonical typed finding fixture."
    }
  ],
  "ultrafuzz/severity-classified-findings@1": [
    {
      schema_version: "ultrafuzz.finding.v2",
      id: "finding-1",
      title: "Canonical classified finding",
      status: "candidate",
      severity_guess: "Medium",
      confidence: "medium",
      summary: "A canonical typed severity fixture.",
      triage_classification: "false-positive"
    }
  ],
  "ultrafuzz/triaged-findings@1": [
    {
      schema_version: "ultrafuzz.finding.v2",
      id: "finding-1",
      title: "Canonical triaged finding",
      status: "candidate",
      severity_guess: "Medium",
      confidence: "medium",
      summary: "A canonical typed triage fixture.",
      triage_classification: "true-positive",
      notes: ["triage_reason=confirmed"]
    }
  ],
  "ultrafuzz/invariant-ledger@1": {
    schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
    entries: [],
    inventory_rows: [],
    scan_probes: [{ id: "probe-source", source_path: "src/Target.sol", query: "invariant", result: "none" }],
    no_invariants_justification: "Searched the target sources and found no invariant statements."
  },
  "ultrafuzz/goal-plan@1": goalPlanFixture(),
  "ultrafuzz/threat-model@1": threatModelFixture(),
  "ultrafuzz/vulnerability-database-planner-catalog@1": vulnerabilityDatabasePlannerCatalogFixture(),
  "ultrafuzz/vulnerability-database-snapshot@1": vulnerabilityDatabaseSnapshotFixture()
};

const fixtures = {};
for (const contract of artifacts.JSON_ARTIFACT_CONTRACT_IDS) {
  const schemaFile = artifacts.artifactContractSchemaFile(contract);
  if (schemaFile === undefined) throw new Error(`Missing schema mapping for ${contract}`);
  const schema = artifacts.parseStrictJsonBytes(fs.readFileSync(path.join(packageRoot, "schema", schemaFile)));
  const existingFixture = existingFixtures[contract];
  let valid = structuredClone(fixtureOverrides[contract] ?? existingFixture?.valid ?? sample(schema, schema));
  if (Array.isArray(valid) && valid.length === 0) valid = [sample(schema.items, schema)];
  const result = artifacts.validateArtifactContract(contract, JSON.stringify(valid));
  if (!result.ok) {
    throw new Error(`${contract} sampler produced an invalid fixture: ${JSON.stringify(result.issues)}`);
  }
  const invalid =
    fixtureOverrides[contract] === undefined && existingFixture !== undefined
      ? structuredClone(existingFixture.invalid)
      : Array.isArray(valid)
        ? null
        : { ...valid, __unexpected_fixture_field: true };
  const invalidResult = artifacts.validateArtifactContract(contract, JSON.stringify(invalid));
  if (invalidResult.ok) throw new Error(`${contract} negative fixture unexpectedly passed`);
  fixtures[contract] = { schema_file: schemaFile, valid, invalid };
}

const serialized = `${JSON.stringify(fixtures, null, 2)}\n`;
if (writeFixtures) {
  fs.writeFileSync(fixturePath, serialized);
} else {
  process.stdout.write(serialized);
}

function goalPlanFixture() {
  const threatId = "surface:canonical";
  const nodeId = `dynamic:threat:${threatId}`;
  return {
    schema_version: "ultrafuzz.goal-plan.v1",
    policy: "additive-v1",
    threat_model_sha256: digest,
    vulnerability_database: {
      planner_catalog_schema_version: "ultrafuzz.vulnerability-db.planner-catalog.v1",
      snapshot_manifest_schema_version: "ultrafuzz.vulnerability-db.snapshot.v1",
      database_schema_version: 1,
      aggregate_sha256: digest,
      catalog_sha256: digest
    },
    catalog_class_ids: [],
    modeled_threat_ids: [threatId],
    threat_goals: [
      {
        kind: "threat",
        id: threatId,
        node_id: nodeId,
        title: "Inspect the canonical surface",
        threat_ids: [threatId],
        class_ids: [],
        attack_surface_ids: ["surface:canonical"],
        goal_prompt: `Your /goal is to inspect {{${threatId}}}.`,
        replacements: { [threatId]: "Canonical modeled threat" },
        selection_rationale: "Every modeled threat receives a focused goal."
      }
    ],
    class_goals: [],
    applicability_decisions: [],
    selected_class_records: [],
    roaming_goal: {
      node_id: "goal-roaming",
      prompt_path: "strategies/roaming-goal.md",
      purpose: "Challenge taxonomy and threat-model completeness."
    },
    counts: {
      threats: 1,
      applicable_classes: 0,
      inapplicable_classes: 0,
      dynamic_goals: 1,
      total_goals: 2
    },
    expected_child_count: 1,
    threat_count: 1,
    applicable_class_count: 0,
    max_dynamic_nodes: 8,
    goal_lanes: [
      { kind: "threat", lane_id: threatId, node_ids: [nodeId] },
      { kind: "roaming", lane_id: "goal-roaming", node_ids: ["goal-roaming"] }
    ]
  };
}

function vulnerabilityDatabasePlannerCatalogFixture() {
  return {
    schema_version: "ultrafuzz.vulnerability-db.planner-catalog.v1",
    database_schema_version: 3,
    database_aggregate_algorithm: "sha256",
    database_aggregate_sha256: digest,
    upstream_catalog_sha256: digest,
    capabilities: [{ id: "accounting.shares", title: "Share accounting", description: "Tracks share accounting." }],
    records: [
      {
        id: "accounting.share-rounding",
        title: "Share rounding",
        domain: "accounting",
        primary_category: "accounting",
        secondary_categories: [],
        capabilities: { required: ["accounting.shares"], optional: [], incompatible: [] },
        attack_surfaces: ["deposit"],
        sources: [{ title: "Reference", url: "https://example.com/reference" }],
        review_status: "reviewed",
        source_path: "classes/accounting/share-rounding.yml",
        source_sha256: digest,
        source_size_bytes: 1,
        selected_artifact_path: "vulnerability-db/selected/accounting/share-rounding.yml"
      }
    ]
  };
}

function vulnerabilityDatabaseSnapshotFixture() {
  const sourceEntry = { path: "database.yml", sha256: digest, size_bytes: 1 };
  return {
    schema_version: "ultrafuzz.vulnerability-db.snapshot.v1",
    source: {
      provider: "github",
      repo: "example/vulnerability-database",
      commit: "a".repeat(40),
      resolved_at: "2026-01-01T00:00:00Z"
    },
    database_schema_version: 3,
    aggregate_sha256: digest,
    catalog_sha256: digest,
    upstream_catalog_sha256: digest,
    files: {
      metadata: sourceEntry,
      capabilities: { ...sourceEntry, path: "capabilities.yml" },
      catalog: { ...sourceEntry, path: "catalog.json" }
    },
    records: [
      {
        id: "accounting.share-rounding",
        path: "classes/accounting/share-rounding.yml",
        sha256: digest,
        size_bytes: 1
      }
    ],
    selected_records: [
      {
        id: "accounting.share-rounding",
        path: "classes/accounting/share-rounding.yml",
        artifact_path: "vulnerability-db/selected/accounting/share-rounding.yml",
        sha256: digest,
        size_bytes: 1
      }
    ]
  };
}

function threatModelFixture() {
  return {
    schema_version: "ultrafuzz.threat-model.v1",
    title: "Canonical threat model",
    scope: {
      summary: "The canonical contract is in scope.",
      repository_evidence: [],
      exclusions: []
    },
    protocol: {
      summary: "A minimal protocol fixture.",
      archetypes: ["canonical protocol"]
    },
    capabilities: [
      {
        id: "canonical.capability",
        status: "unknown",
        rationale: "The fixture intentionally records an unknown capability.",
        evidence: []
      }
    ],
    assets: [
      {
        id: "asset:canonical",
        name: "Canonical asset",
        description: "An asset used by the fixture.",
        value_at_risk: "The canonical asset.",
        evidence: []
      }
    ],
    actors: [
      {
        id: "actor:canonical",
        name: "Canonical actor",
        role: "Exercises the canonical surface.",
        trust: "untrusted",
        privileges: [],
        evidence: []
      }
    ],
    trust_boundaries: [],
    attack_surfaces: [
      {
        id: "surface:canonical",
        name: "Canonical surface",
        description: "The surface used by the fixture.",
        entry_points: ["Canonical.run"],
        asset_ids: ["asset:canonical"],
        actor_ids: ["actor:canonical"],
        capability_ids: ["canonical.capability"],
        trust_boundary_ids: [],
        evidence: []
      }
    ],
    value_flows: [],
    lifecycle_transitions: [],
    invariants: [
      {
        id: "invariant:canonical",
        name: "Canonical invariant",
        kind: "state",
        statement: "Canonical state remains valid.",
        asset_ids: ["asset:canonical"],
        capability_ids: ["canonical.capability"],
        evidence: []
      }
    ],
    threats: [
      {
        id: "surface:canonical",
        title: "Canonical surface violation",
        description: "The canonical surface may violate its invariant.",
        preconditions: ["The canonical surface is reachable."],
        impact: "The canonical asset may be affected.",
        asset_ids: ["asset:canonical"],
        actor_ids: ["actor:canonical"],
        attack_surface_ids: ["surface:canonical"],
        capability_ids: ["canonical.capability"],
        trust_boundary_ids: [],
        invariant_ids: ["invariant:canonical"],
        assumption_ids: [],
        unknown_ids: [],
        evidence: []
      }
    ],
    assumptions: [],
    unknowns: [],
    coverage_gaps: []
  };
}

function sample(schema, root, stack = new Set()) {
  if (schema === true) return null;
  if (schema === false || typeof schema !== "object" || schema === null) {
    throw new Error(`Cannot sample schema ${JSON.stringify(schema)}`);
  }
  if (typeof schema.$ref === "string") {
    const target = resolveLocalReference(root, schema.$ref);
    if (stack.has(target)) return null;
    return sample(target, root, new Set([...stack, target]));
  }
  if (Object.hasOwn(schema, "const")) return structuredClone(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return structuredClone(schema.enum[0]);
  if (Array.isArray(schema.anyOf)) return sample(schema.anyOf[0], root, stack);
  if (Array.isArray(schema.oneOf)) return sample(schema.oneOf[0], root, stack);

  const type = Array.isArray(schema.type) ? schema.type.find((entry) => entry !== "null") : schema.type;
  if (type === "object" || schema.properties !== undefined) {
    const value = {};
    for (const key of schema.required ?? []) {
      const propertySchema = schema.properties?.[key];
      if (propertySchema === undefined) throw new Error(`Required property ${key} has no schema`);
      value[key] = sample(propertySchema, root, stack);
    }
    return value;
  }
  if (type === "array") {
    const count = Math.max(schema.minItems ?? 0, 0);
    return Array.from({ length: count }, () => sample(schema.items ?? true, root, stack));
  }
  if (type === "string") return sampleString(schema);
  if (type === "integer" || type === "number") {
    if (typeof schema.minimum === "number") return schema.minimum;
    if (typeof schema.exclusiveMinimum === "number") return schema.exclusiveMinimum + 1;
    return 0;
  }
  if (type === "boolean") return false;
  if (type === "null") return null;
  return null;
}

function sampleString(schema) {
  const minimum = Math.max(schema.minLength ?? 0, 1);
  const candidates = [
    "x".repeat(minimum),
    "2026-08-09T00:00:00.000Z",
    "0".repeat(64),
    "0".repeat(40),
    "generated-tests/x",
    "refs/heads/ultrafuzz-pinned",
    `ultrafuzz-json-validator.v1:${"0".repeat(64)}`,
    "urn:ultrafuzz:schema:fixture:1"
  ];
  if (schema.format === "date-time") return candidates[1];
  if (typeof schema.pattern !== "string") return candidates[0];
  const expression = new RegExp(schema.pattern, "u");
  const candidate = candidates.find((value) => value.length >= minimum && expression.test(value));
  if (candidate === undefined) throw new Error(`No canonical sample for pattern ${schema.pattern}`);
  return candidate;
}

function resolveLocalReference(root, reference) {
  if (!reference.startsWith("#/")) throw new Error(`Fixture sampler only supports local references: ${reference}`);
  return reference
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((value, part) => value[part], root);
}
