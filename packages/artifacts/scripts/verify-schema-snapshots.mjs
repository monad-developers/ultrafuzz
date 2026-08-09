import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaRoot = path.join(packageRoot, "schema");
const artifacts = await import("../dist/index.js");

const schemas = {
  "agent-source-proof.schema.json": artifacts.agentSourceProofJsonSchema,
  "analysis-bundle.schema.json": artifacts.analysisBundleManifestJsonSchema,
  "artifact-manifest.schema.json": artifacts.artifactManifestJsonSchema,
  "artifact-verification.schema.json": artifacts.artifactVerificationJsonSchema,
  "finding.schema.json": artifacts.findingJsonSchema,
  "findings.schema.json": artifacts.findingsJsonSchema,
  "generated-tests.schema.json": artifacts.generatedTestsJsonSchema,
  "implemented-properties.schema.json": artifacts.implementedPropertiesJsonSchema,
  "invariant-evidence-ledger.schema.json": artifacts.invariantLedgerJsonSchema,
  "invariant-source-proof.schema.json": artifacts.invariantSourceProofJsonSchema,
  "node-attempt-ledger.schema.json": artifacts.nodeAttemptLedgerJsonSchema,
  "properties.schema.json": artifacts.propertiesJsonSchema,
  "property-campaign.schema.json": artifacts.propertyCampaignJsonSchema,
  "property-lens.schema.json": artifacts.lensPropertiesJsonSchema,
  "reference-expectations.schema.json": artifacts.referenceExpectationsJsonSchema,
  "run-state.schema.json": artifacts.runStateJsonSchema,
  "usage-ledger.schema.json": artifacts.usageLedgerJsonSchema,
  "workspace-patch.schema.json": artifacts.workspacePatchJsonSchema
};

for (const [contract, filename] of Object.entries(artifacts.WORKFLOW_SCHEMA_FILES)) {
  schemas[filename] = artifacts.workflowContractJsonSchemas[contract];
}

const checkedIn = fs.readdirSync(schemaRoot).filter((name) => name.endsWith(".schema.json")).sort();
const exported = Object.keys(schemas).sort();
if (JSON.stringify(checkedIn) !== JSON.stringify(exported)) {
  const unregistered = checkedIn.filter((name) => !exported.includes(name));
  const missing = exported.filter((name) => !checkedIn.includes(name));
  throw new Error(`Schema inventory mismatch; unregistered=${unregistered.join(",")}; missing=${missing.join(",")}`);
}

for (const filename of checkedIn) {
  const canonical = JSON.parse(fs.readFileSync(path.join(schemaRoot, filename), "utf8"));
  assert.deepStrictEqual(
    schemas[filename],
    canonical,
    `${filename} differs from its checked-in canonical JSON Schema`
  );
}
