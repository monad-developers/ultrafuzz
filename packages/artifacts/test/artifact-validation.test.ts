import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  ARTIFACT_SCHEMA_METADATA,
  artifactValidationWarnings,
  boundArtifactValidationWarnings,
  executeSchemaSemanticGates,
  executeSemanticGate,
  renderThreatModelMarkdown,
  assertThreatModel,
  validateArtifactContract,
  type ArtifactContractId,
  type ArtifactSchemaFilename
} from "../src/index.js";

test("1091: 41 strategy detections with six omitted family IDs remain immutable and usable", () => {
  const findings = Array.from({ length: 41 }, (_, index) => ({
    id: `finding-${index}`,
    dedupe_key: `key-${index}`,
    title: `Finding ${index}`,
    family_id: `family-${index}`
  }));
  const detections = findings.map((finding, index) => ({
    dedupe_key: finding.dedupe_key,
    finding_id: finding.id,
    title: finding.title,
    ...(index < 6 ? {} : { family_id: finding.family_id }),
    hits: [{ strategy: "review" }]
  }));
  const bytes = JSON.stringify(detections);
  const context = {
    artifactSet: {
      reviewStage: {
        stage: "dedupe" as const,
        findingsArtifactPath: "deduped-findings.json",
        findings,
        lifecycleLedger: { records: detections.map((row) => ({ dedupe_key: row.dedupe_key, strategy_hits: row.hits })) }
      }
    }
  };
  assert.equal(validateArtifactContract("ultrafuzz/strategy-detections@1", bytes).ok, true);
  const results = executeSchemaSemanticGates("strategy-detections.schema.json", { document: detections, context });
  assert.equal(
    results.some((result) => result.status === "failed" || result.status === "requires-context"),
    false
  );
  const warnings = artifactValidationWarnings("strategy-detections.json", results);
  assert.equal(warnings.length, 6);
  assert.deepEqual(
    warnings.map((warning) => warning.field_path),
    Array.from({ length: 6 }, (_, i) => `$[${i}].family_id`)
  );
  assert.equal(warnings[0]!.source_path, "deduped-findings.json#$[0].family_id");
  assert.equal(warnings[0]!.artifact_path, "strategy-detections.json");
  assert.equal(JSON.stringify(detections), bytes);
  const strict = executeSchemaSemanticGates("strategy-detections.schema.json", {
    document: detections,
    context,
    strict: true
  });
  assert.equal(strict.filter((result) => result.status === "failed").length, 1);
  // The next agent can copy the partial artifact exactly; no synthetic repair is needed.
  const downstream = executeSemanticGate("strategy-detection-review-stage-reconciliation", {
    document: structuredClone(detections),
    context: {
      artifactSet: {
        reviewStage: {
          stage: "severity-classification",
          findingsArtifactPath: "classified.json",
          upstreamStrategyDetections: detections
        }
      }
    }
  });
  assert.equal(downstream.status, "passed");
  const furtherOmission = structuredClone(detections);
  delete furtherOmission[6]!.family_id;
  const severityContext = {
    artifactSet: {
      reviewStage: {
        stage: "severity-classification" as const,
        findingsArtifactPath: "classified.json",
        upstreamStrategyDetections: detections
      }
    }
  };
  assert.equal(
    executeSemanticGate("strategy-detection-review-stage-reconciliation", {
      document: furtherOmission,
      context: severityContext
    }).status,
    "warning"
  );
  assert.equal(
    executeSemanticGate("strategy-detection-review-stage-reconciliation", {
      document: furtherOmission,
      context: severityContext,
      strict: true
    }).status,
    "failed"
  );
  for (const mutate of [
    (rows: typeof detections) => {
      rows[0]!.dedupe_key = rows[1]!.dedupe_key;
    },
    (rows: typeof detections) => {
      rows[0]!.finding_id = "wrong-finding";
    },
    (rows: typeof detections) => {
      rows[0]!.hits = [{ strategy: "invented" }];
    },
    (rows: typeof detections) => {
      rows[0]!.family_id = "conflicting-family";
    }
  ]) {
    const changed = structuredClone(detections);
    mutate(changed);
    assert.ok(
      executeSchemaSemanticGates("strategy-detections.schema.json", { document: changed, context }).some(
        (result) => result.status === "failed"
      )
    );
  }
  assert.equal(
    executeSemanticGate("strategy-detection-review-stage-reconciliation", { document: detections }).status,
    "requires-context"
  );
});

test("partial findings validate in production and optional metadata remains visible to strict development checks", () => {
  const finding = {
    schema_version: "ultrafuzz.finding.v2",
    id: "finding-1",
    title: "Partial finding",
    status: "candidate"
  };
  assert.equal(validateArtifactContract("ultrafuzz/findings@2", JSON.stringify([finding])).ok, true);
  const results = executeSchemaSemanticGates("findings.schema.json", { document: [finding] });
  assert.equal(artifactValidationWarnings("findings.json", results).length, 3);
  assert.ok(results.every((result) => result.status === "passed" || result.status === "warning"));
  assert.ok(
    executeSchemaSemanticGates("findings.schema.json", { document: [finding], strict: true }).some(
      (result) => result.status === "failed"
    )
  );
  for (const invalid of [
    "{",
    JSON.stringify([{ ...finding, id: undefined }]),
    JSON.stringify([{ ...finding, confidence: 42 }]),
    '[{"id":"a","id":"b"}]'
  ]) {
    assert.equal(validateArtifactContract("ultrafuzz/findings@2", invalid).ok, false);
  }
});

test("final report preservation permits omitted preliminary metadata but preserves final severity", () => {
  const finding = {
    id: "f-1",
    title: "Finding",
    dedupe_key: "key-1",
    severity: "Low",
    summary: "Summary",
    confidence: "high",
    severity_guess: "Medium"
  };
  const lifecycle = { dedupe_key: "key-1", final_disposition: "promoted" };
  const report = {
    issues: [{ id: "L-01", title: "[L-01] - Finding", dedupe_key: "key-1", severity: "Low", lifecycle }],
    non_production_outcomes: []
  };
  const context = {
    artifactSet: { severityClassifiedFindings: [finding], findingLifecycleLedger: { records: [lifecycle] } }
  };
  const gate = "report-severity-classification-preservation";
  assert.equal(executeSemanticGate(gate, { document: report, context }).status, "warning");
  assert.equal(executeSemanticGate(gate, { document: report, context, strict: true }).status, "failed");
  report.issues[0]!.severity = "High";
  assert.equal(executeSemanticGate(gate, { document: report, context }).status, "failed");
});

test("metadata omissions remain advisory across threat models and strategy output contracts", () => {
  const fixtures = JSON.parse(
    fs.readFileSync(new URL("../../test/fixtures/contract-schema-fixtures.json", import.meta.url), "utf8")
  ) as Record<string, { valid: Record<string, unknown> }>;
  const threat = structuredClone(fixtures["ultrafuzz/threat-model@1"]!.valid);
  const removeProse = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(removeProse);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    for (const field of ["description", "summary", "rationale", "value_at_risk", "security_impact"])
      delete record[field];
    Object.values(record).forEach(removeProse);
  };
  removeProse(threat);
  const recommendation = {
    strategy_id: "strategy-1",
    title: "Exercise boundary",
    evidence_paths: ["src/Core.sol"],
    proposed_test_path: "test/Core.t.sol",
    focused_command: "forge test",
    priority: "high"
  };
  const cases: Array<[ArtifactSchemaFilename, Record<string, unknown>]> = [
    ["threat-model.schema.json", threat],
    [
      "boundary-recipes.schema.json",
      {
        ...fixtures["ultrafuzz/boundary-recipes@1"]!.valid,
        coverage_priorities: [{ workflow: "withdraw", priority: "high" }]
      }
    ],
    [
      "dynamic-enumerator-outputs.schema.json",
      {
        schema_version: "ultrafuzz.dynamic-enumerator-outputs.v1",
        enumerators: [
          {
            enumerator_id: "e-1",
            agent_label: "review",
            status: "complete",
            diagnostics: [],
            recommendations: [recommendation]
          }
        ]
      }
    ],
    [
      "selected-strategies.schema.json",
      {
        schema_version: "ultrafuzz.selected-strategies.v1",
        strategies: [{ ...recommendation, enumerator_ids: ["e-1"], validation_plan: ["Run test"] }]
      }
    ]
  ];
  for (const name of [
    "admin-config-boundary-matrix",
    "dependency-scope-matrix",
    "externalized-state-accounting"
  ] as const) {
    const document = structuredClone(fixtures[`ultrafuzz/${name}@1`]!.valid);
    delete document.coverage_notes;
    cases.push([`${name}.schema.json`, document]);
  }
  for (const [schema, document] of cases) {
    const contract = ARTIFACT_SCHEMA_METADATA[schema].contractIds[0] as ArtifactContractId;
    const before = JSON.stringify(document);
    assert.equal(validateArtifactContract(contract, before).ok, true, schema);
    const gate = ARTIFACT_SCHEMA_METADATA[schema].semanticGates.find((name) =>
      name.endsWith("-metadata-completeness")
    )!;
    const results = executeSchemaSemanticGates(schema, { document });
    assert.equal(results.find((result) => result.gate === gate)?.status, "warning", schema);
    assert.equal(
      executeSchemaSemanticGates(schema, { document, strict: true }).find((result) => result.gate === gate)?.status,
      "failed",
      schema
    );
    assert.equal(JSON.stringify(document), before);
  }
  const markdown = renderThreatModelMarkdown(assertThreatModel(threat));
  assert.ok(markdown.includes("Not recorded."));
  assert.equal(markdown.includes("undefined"), false);
});

test("large warning sets neither fail validation nor conceal identity errors", () => {
  const findings = Array.from({ length: 10_000 }, (_, index) => ({
    schema_version: "ultrafuzz.finding.v2",
    id: `f-${index}`,
    title: "Partial",
    status: "candidate"
  }));
  const results = executeSchemaSemanticGates("findings.schema.json", { document: findings });
  assert.ok(results.every((result) => result.status === "passed" || result.status === "warning"));
  const warnings = boundArtifactValidationWarnings(artifactValidationWarnings("findings.json", results));
  assert.ok(Buffer.byteLength(JSON.stringify(warnings)) <= 64 * 1024);
  findings[9999]!.id = findings[0]!.id;
  assert.ok(
    executeSchemaSemanticGates("findings.schema.json", { document: findings }).some(
      (result) => result.status === "failed"
    )
  );
});
