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
  type ArtifactSchemaFilename,
  type SemanticGateContext
} from "../src/index.js";

function entryAt<T>(entries: readonly T[], index: number): T {
  const entry = entries[index];
  assert.notEqual(entry, undefined);
  return entry as T;
}

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
  assert.equal(entryAt(warnings, 0).source_path, "deduped-findings.json#$[0].family_id");
  assert.equal(entryAt(warnings, 0).artifact_path, "strategy-detections.json");
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
          findings,
          upstreamStrategyDetections: detections
        }
      }
    }
  });
  assert.equal(downstream.status, "warning");
  const furtherOmission = structuredClone(detections);
  delete entryAt(furtherOmission, 6).family_id;
  const severityContext = {
    artifactSet: {
      reviewStage: {
        stage: "severity-classification" as const,
        findingsArtifactPath: "classified.json",
        findings,
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
      entryAt(rows, 0).dedupe_key = entryAt(rows, 1).dedupe_key;
    },
    (rows: typeof detections) => {
      entryAt(rows, 0).finding_id = "wrong-finding";
    },
    (rows: typeof detections) => {
      entryAt(rows, 0).hits = [{ strategy: "invented" }];
    },
    (rows: typeof detections) => {
      entryAt(rows, 0).family_id = "conflicting-family";
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

test("findings retain a substantive summary while optional metadata remains visible to strict development checks", () => {
  const finding = {
    schema_version: "ultrafuzz.finding.v2",
    id: "finding-1",
    title: "Partial finding",
    status: "candidate",
    summary: "A concrete defect remains under review"
  };
  assert.equal(validateArtifactContract("ultrafuzz/findings@2", JSON.stringify([finding])).ok, true);
  const results = executeSchemaSemanticGates("findings.schema.json", { document: [finding] });
  assert.equal(artifactValidationWarnings("findings.json", results).length, 2);
  assert.ok(results.every((result) => result.status === "passed" || result.status === "warning"));
  assert.ok(
    executeSchemaSemanticGates("findings.schema.json", { document: [finding], strict: true }).some(
      (result) => result.status === "failed"
    )
  );
  for (const invalid of [
    "{",
    JSON.stringify([{ ...finding, id: undefined }]),
    JSON.stringify([{ ...finding, summary: undefined }]),
    JSON.stringify([{ ...finding, confidence: 42 }]),
    '[{"id":"a","id":"b"}]'
  ]) {
    assert.equal(validateArtifactContract("ultrafuzz/findings@2", invalid).ok, false);
  }
});

test("review metadata omissions retain upstream attribution and fail strict validation", () => {
  const upstream = {
    schema_version: "ultrafuzz.finding.v2",
    id: "finding-1",
    title: "Finding",
    status: "candidate",
    summary: "Reachable loss of funds",
    confidence: "high",
    severity_guess: "High",
    family_id: "family-A",
    triage_classification: "true-positive",
    notes: ["triage_reason=Verified source evidence"]
  };
  const stages = [
    {
      schema: "triaged-findings.schema.json",
      upstreamKey: "dedupedFindings",
      source: "artifacts/dedupe/deduped-findings.json"
    },
    {
      schema: "severity-classified-findings.schema.json",
      upstreamKey: "triagedFindings",
      source: "artifacts/triage/triaged-findings.json"
    }
  ] as const;
  for (const stage of stages) {
    for (const field of ["summary", "confidence", "severity_guess", "family_id"] as const) {
      const output = { ...upstream };
      Reflect.deleteProperty(output, field);
      const before = JSON.stringify(output);
      const context: SemanticGateContext = {
        artifactSet: {
          [stage.upstreamKey]: [upstream],
          [`${stage.upstreamKey}ArtifactPath`]: stage.source
        }
      };
      const results = executeSchemaSemanticGates(stage.schema, { document: [output], context });
      const warning = artifactValidationWarnings("reviewed-findings.json", results).find(
        (entry) => entry.field_path === `$[0].${field}` && entry.gate.endsWith("upstream-preservation")
      );
      assert.ok(warning, `${stage.schema} must report omitted ${field}`);
      assert.equal(warning.source_path, `${stage.source}#$[0].${field}`);
      assert.equal(
        results.some((result) => result.status === "failed"),
        false
      );
      const strict = executeSchemaSemanticGates(stage.schema, { document: [output], context, strict: true });
      assert.ok(strict.some((result) => result.status === "failed" && result.gate.endsWith("upstream-preservation")));
      assert.equal(JSON.stringify(output), before);
    }
  }
});

test("severity metadata remains bound to dedupe when triage omitted a supplied value", () => {
  const deduped = { id: "finding-1", family_id: "family-A", summary: "Original mechanism" };
  const context = {
    artifactSet: {
      dedupedFindings: [deduped],
      dedupedFindingsArtifactPath: "artifacts/dedupe/findings.json",
      triagedFindings: [{ id: "finding-1" }],
      triagedFindingsArtifactPath: "artifacts/triage/findings.json"
    }
  };
  const gate = "severity-classification-upstream-preservation";
  assert.equal(executeSemanticGate(gate, { document: [deduped], context }).status, "passed");
  for (const field of ["family_id", "summary"] as const) {
    const conflicted = { ...deduped, [field]: "Conflicting replacement" };
    assert.equal(executeSemanticGate(gate, { document: [conflicted], context }).status, "failed");
  }
  const omitted = executeSemanticGate(gate, { document: [{ id: "finding-1" }], context });
  assert.equal(omitted.status, "warning");
  const warnings = artifactValidationWarnings("classified.json", [omitted]);
  assert.equal(entryAt(warnings, 0).source_path, "artifacts/dedupe/findings.json#$[0].summary");
  assert.equal(executeSemanticGate(gate, { document: [{ id: "finding-1" }], context, strict: true }).status, "failed");
  const conflictingUpstream = {
    artifactSet: { ...context.artifactSet, triagedFindings: [{ id: "finding-1", family_id: "family-B" }] }
  };
  assert.equal(
    executeSemanticGate(gate, { document: [{ id: "finding-1" }], context: conflictingUpstream }).status,
    "failed"
  );
});

test("severity detections reject every supplied family conflict despite omissions in the review chain", () => {
  const detection = { dedupe_key: "root-1", finding_id: "finding-1", title: "Finding", hits: [{ strategy: "review" }] };
  const withFamily = (family: string | undefined) => (family === undefined ? {} : { family_id: family });
  const gate = "strategy-detection-review-stage-reconciliation";
  for (const outputFamily of [undefined, "family-A", "family-B"]) {
    for (const upstreamFamily of [undefined, "family-A", "family-B"]) {
      for (const findingFamily of [undefined, "family-A", "family-B"]) {
        const document = [{ ...detection, ...withFamily(outputFamily) }];
        const context: SemanticGateContext = {
          artifactSet: {
            reviewStage: {
              stage: "severity-classification",
              findingsArtifactPath: "artifacts/severity/findings.json",
              findings: [{ id: "finding-1", ...withFamily(findingFamily) }],
              upstreamStrategyDetections: [{ ...detection, ...withFamily(upstreamFamily) }],
              upstreamStrategyDetectionsArtifactPath: "artifacts/dedupe/strategy-detections.json"
            }
          }
        };
        const before = JSON.stringify({ document, context });
        const result = executeSemanticGate(gate, { document, context });
        const families = [outputFamily, upstreamFamily, findingFamily];
        const supplied = families.filter((family) => family !== undefined);
        const expected =
          new Set(supplied).size > 1 ? "failed" : supplied.length > 0 && supplied.length < 3 ? "warning" : "passed";
        assert.equal(result.status, expected, JSON.stringify(families));
        if (result.status === "warning") {
          assert.equal(executeSemanticGate(gate, { document, context, strict: true }).status, "failed");
        }
        assert.equal(JSON.stringify({ document, context }), before);
      }
    }
  }
});

test("severity detection omissions retain original dedupe family authority and exact source paths", () => {
  const detection = { dedupe_key: "root-1", finding_id: "finding-1", title: "Finding", hits: [{ strategy: "review" }] };
  const review = {
    stage: "severity-classification" as const,
    findingsArtifactPath: "artifacts/severity/findings.json",
    findings: [{ id: "finding-1" }],
    upstreamStrategyDetections: [detection],
    upstreamStrategyDetectionsArtifactPath: "artifacts/dedupe/strategy-detections.json"
  };
  const context = {
    artifactSet: {
      reviewStage: review,
      dedupedFindings: [{ id: "finding-1", family_id: "family-A" }],
      dedupedFindingsArtifactPath: "artifacts/dedupe/findings.json"
    }
  };
  const gate = "strategy-detection-review-stage-reconciliation";
  assert.equal(
    executeSemanticGate(gate, { document: [{ ...detection, family_id: "family-B" }], context }).status,
    "failed"
  );
  const omitted = executeSemanticGate(gate, { document: [detection], context });
  assert.equal(omitted.status, "warning");
  const warning = entryAt(artifactValidationWarnings("strategy-detections.json", [omitted]), 0);
  assert.equal(warning.field_path, "$[0].family_id");
  assert.equal(warning.source_path, "artifacts/dedupe/findings.json#$[0].family_id");
  assert.equal(executeSemanticGate(gate, { document: [detection], context, strict: true }).status, "failed");

  const upstreamContext = {
    artifactSet: {
      reviewStage: { ...review, upstreamStrategyDetections: [{ ...detection, family_id: "family-A" }] }
    }
  };
  const upstreamOmission = executeSemanticGate(gate, { document: [detection], context: upstreamContext });
  assert.equal(upstreamOmission.status, "warning");
  assert.equal(
    entryAt(artifactValidationWarnings("strategy-detections.json", [upstreamOmission]), 0).source_path,
    "artifacts/dedupe/strategy-detections.json#$[0].family_id"
  );
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
    artifactSet: {
      severityClassifiedFindings: [finding],
      findingLifecycleLedger: { records: [lifecycle] },
      dedupedFindings: [{ id: "f-1", dedupe_key: "key-1", family_id: "family-A" }]
    }
  };
  const gate = "report-severity-classification-preservation";
  assert.equal(executeSemanticGate(gate, { document: report, context }).status, "warning");
  assert.equal(executeSemanticGate(gate, { document: report, context, strict: true }).status, "failed");
  const reportWithFamily = (familyId: string) => ({
    ...report,
    issues: [{ ...entryAt(report.issues, 0), family_id: familyId }]
  });
  assert.equal(executeSemanticGate(gate, { document: reportWithFamily("family-A"), context }).status, "warning");
  assert.equal(executeSemanticGate(gate, { document: reportWithFamily("family-B"), context }).status, "failed");
  entryAt(report.issues, 0).severity = "High";
  assert.equal(executeSemanticGate(gate, { document: report, context }).status, "failed");
});

test("metadata omissions remain advisory across threat models and strategy output contracts", () => {
  const fixtures = JSON.parse(
    fs.readFileSync(new URL("../../test/fixtures/contract-schema-fixtures.json", import.meta.url), "utf8")
  ) as Record<string, { valid: Record<string, unknown> }>;
  const fixtureFor = (contract: string): Record<string, unknown> => {
    const fixture = fixtures[contract];
    assert.ok(fixture);
    return fixture.valid;
  };
  const threat = structuredClone(fixtureFor("ultrafuzz/threat-model@1"));
  const removeProse = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(removeProse);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    for (const field of ["description", "summary", "rationale", "value_at_risk", "security_impact"])
      Reflect.deleteProperty(record, field);
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
        ...fixtureFor("ultrafuzz/boundary-recipes@1"),
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
    const document = structuredClone(fixtureFor(`ultrafuzz/${name}@1`));
    delete document.coverage_notes;
    cases.push([`${name}.schema.json`, document]);
  }
  for (const [schema, document] of cases) {
    const contract = ARTIFACT_SCHEMA_METADATA[schema].contractIds[0] as ArtifactContractId;
    const before = JSON.stringify(document);
    assert.equal(validateArtifactContract(contract, before).ok, true, schema);
    const gate = ARTIFACT_SCHEMA_METADATA[schema].semanticGates.find((name) => name.endsWith("-metadata-completeness"));
    assert.ok(gate);
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
  entryAt(findings, 9999).id = entryAt(findings, 0).id;
  assert.ok(
    executeSchemaSemanticGates("findings.schema.json", { document: findings }).some(
      (result) => result.status === "failed"
    )
  );
});
