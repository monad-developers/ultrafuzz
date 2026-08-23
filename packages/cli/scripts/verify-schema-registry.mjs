import {
  cliOwnedSchemaRegistry,
  validateCliResultEnvelope,
  validateOperatorInput,
  validateReportBundleManifest
} from "../dist/cli-schema-registry.js";

const registry = cliOwnedSchemaRegistry();
if (registry.length === 0) throw new Error("CLI schema registry is empty");

const invocationFailure = validateCliResultEnvelope({
  schema_version: "ultrafuzz.cli.result.v2",
  command: "schema-registry-build-check",
  ok: false,
  diagnostics: [],
  data: null
});
if (!invocationFailure.ok) {
  throw new Error(`CLI result schema build check failed: ${JSON.stringify(invocationFailure.issues)}`);
}

const operatorInput = validateOperatorInput({ nested: [null, true, 1, "value"] });
if (!operatorInput.ok) {
  throw new Error(`operator-input schema build check failed: ${JSON.stringify(operatorInput.issues)}`);
}

const reportBundleManifest = validateReportBundleManifest({
  schema_version: "ultrafuzz.report-bundle-manifest.v3",
  run_id: "schema-registry-build-check",
  created_at: "2026-08-09T00:00:00.000Z",
  included_roots: [
    "attempts.jsonl",
    "config.redactions.json",
    "config.resolved.toml",
    "events.jsonl",
    "graph.fingerprint",
    "graph.json",
    "plan.json",
    "run.json",
    "state.json",
    "usage.jsonl",
    "artifacts",
    "review",
    "events.index",
    "engine-logs"
  ],
  excluded_roots: ["workspaces"],
  excluded_patterns: ["artifacts/final-report/report.json.pre-*"],
  path_mappings: [],
  entry_count_without_manifest: 1
});
if (!reportBundleManifest.ok) {
  throw new Error(`report-bundle manifest schema build check failed: ${JSON.stringify(reportBundleManifest.issues)}`);
}
