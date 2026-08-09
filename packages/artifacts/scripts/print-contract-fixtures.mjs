import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = await import("../dist/index.js");
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
  }
};

const fixtures = {};
for (const contract of artifacts.JSON_ARTIFACT_CONTRACT_IDS) {
  const schemaFile = artifacts.artifactContractSchemaFile(contract);
  if (schemaFile === undefined) throw new Error(`Missing schema mapping for ${contract}`);
  const schema = artifacts.parseStrictJsonBytes(fs.readFileSync(path.join(packageRoot, "schema", schemaFile)));
  let valid = structuredClone(fixtureOverrides[contract] ?? sample(schema, schema));
  if (Array.isArray(valid) && valid.length === 0) valid = [sample(schema.items, schema)];
  const result = artifacts.validateArtifactContract(contract, JSON.stringify(valid));
  if (!result.ok) {
    throw new Error(`${contract} sampler produced an invalid fixture: ${JSON.stringify(result.issues)}`);
  }
  const invalid = Array.isArray(valid) ? null : { ...valid, __unexpected_fixture_field: true };
  const invalidResult = artifacts.validateArtifactContract(contract, JSON.stringify(invalid));
  if (invalidResult.ok) throw new Error(`${contract} negative fixture unexpectedly passed`);
  fixtures[contract] = { schema_file: schemaFile, valid, invalid };
}

process.stdout.write(`${JSON.stringify(fixtures, null, 2)}\n`);

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
