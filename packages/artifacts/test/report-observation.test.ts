import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { createStrictAjv } from "../src/json-schema-validator.js";
import {
  MAX_REPORT_UNREVIEWED_FINDINGS,
  reportObservedCompletionSchema,
  reportVerificationSchema
} from "../src/report-observation.js";
import { reportJsonSchema, reportSchema } from "../src/workflow-contracts.js";

const validateShape = createStrictAjv().compile(reportJsonSchema);

function uncheckedReport(): Record<string, unknown> {
  const fixtureUrl = [
    new URL("../../test/fixtures/contract-schema-fixtures.json", import.meta.url),
    new URL("./fixtures/contract-schema-fixtures.json", import.meta.url)
  ].find((url) => existsSync(url));
  assert.ok(fixtureUrl);
  const fixtures = JSON.parse(readFileSync(fixtureUrl, "utf8")) as Record<string, { valid: Record<string, unknown> }>;
  const fixture = fixtures["ultrafuzz/report@3"];
  assert.ok(fixture);
  return {
    ...fixture.valid,
    verification: { status: "not-checked", reason_codes: ["record-missing", "result-not-reviewed"] },
    observed_completion: {
      outcome: "partial",
      counts: {
        planned: null,
        succeeded: 80,
        failed: 20,
        timed_out: null,
        skipped: null,
        cancelled: 0,
        unverified: null
      }
    },
    issues: [],
    non_production_outcomes: [],
    property_provenance: [],
    property_implementation_coverage: { status: "unavailable", reason: "final-review-not-completed" },
    unreviewed_findings: [
      { source_path: "artifacts/task/findings.json", title: "Candidate", description: "Needs review." }
    ]
  };
}

function assertValidity(value: unknown, expected: boolean): void {
  assert.equal(reportSchema.safeParse(value).success, expected, JSON.stringify(value));
  assert.equal(validateShape(value), expected, JSON.stringify(validateShape.errors));
}

test("unchecked partial reports retain observations and candidates without a strict completion census", () => {
  const report = uncheckedReport();
  assertValidity(report, true);
  assert.deepEqual(reportSchema.parse(report), report);
  const counts = (report.observed_completion as { counts: Record<string, unknown> }).counts;
  counts.planned = 5;
  assertValidity(report, true);
  assert.equal(
    reportObservedCompletionSchema.safeParse({ ...(report.observed_completion as object), outcome: "complete" })
      .success,
    false
  );
});

test("unchecked verification cannot claim an authenticated census or omit its partial observations", () => {
  const report = uncheckedReport();
  const { verification: _verification, ...withoutVerification } = report;
  const { observed_completion: _observed, ...withoutObservation } = report;
  const completion = {
    schema_version: "ultrafuzz.report-completion.v1",
    run_id: (report.run_metadata as { run_id: string }).run_id,
    outcome: "complete",
    counts: { planned: 1, succeeded: 1, failed: 0, timed_out: 0, skipped: 0, cancelled: 0, unverified: 0 },
    incomplete_nodes: [],
    incomplete_nodes_omitted: 0
  };
  for (const value of [
    withoutVerification,
    withoutObservation,
    { ...report, completion },
    { ...report, observed_completion: { ...(report.observed_completion as object), outcome: "complete" } },
    { ...report, verification: { status: "checked", reason_codes: ["record-missing"] } }
  ])
    assertValidity(value, false);
});

test("unavailable final review still cannot claim strict issues or property provenance", () => {
  const report = uncheckedReport();
  for (const field of ["issues", "non_production_outcomes", "property_provenance"]) {
    assertValidity({ ...report, [field]: [{}] }, false);
  }
  const {
    verification: _verification,
    observed_completion: _observation,
    unreviewed_findings: _findings,
    ...withoutObservation
  } = report;
  assertValidity(withoutObservation, false);
});

test("unchecked observations and candidates have bounded values and typed reasons", () => {
  const report = uncheckedReport();
  const observed = report.observed_completion as { outcome: string; counts: Record<string, unknown> };
  for (const invalidCount of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "unknown"]) {
    assertValidity(
      { ...report, observed_completion: { ...observed, counts: { ...observed.counts, failed: invalidCount } } },
      false
    );
  }
  for (const reasons of [[], ["unknown"], ["record-invalid", "record-invalid"], Array(7).fill("record-invalid")]) {
    const verification = { status: "not-checked", reason_codes: reasons };
    assert.equal(reportVerificationSchema.safeParse(verification).success, false);
    assertValidity({ ...report, verification }, false);
  }
  const candidate = (report.unreviewed_findings as Array<Record<string, string>>)[0];
  assert.ok(candidate);
  for (const findings of [
    Array(MAX_REPORT_UNREVIEWED_FINDINGS + 1).fill(candidate),
    [{ ...candidate, source_path: "s".repeat(1_025) }],
    [{ ...candidate, title: "t".repeat(513) }],
    [{ ...candidate, description: "d".repeat(4_001) }],
    [{ ...candidate, severity: "High" }]
  ])
    assertValidity({ ...report, unreviewed_findings: findings }, false);
});
