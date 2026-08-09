import assert from "node:assert/strict";
import test from "node:test";

import {
  RELEASE_VALIDATION_REPORT_JSON_SCHEMA_ID,
  assertReleaseValidationReport,
  parseStrictJsonBytes,
  serializeReleaseValidationReport,
  validateRegisteredJsonSchema,
  type ReleaseValidationReport
} from "../src/index.js";

function validReport(): ReleaseValidationReport {
  return {
    schema_version: "ultrafuzz.release-validation.report.v2",
    package_id: "ultrafuzz",
    generated_at: "2026-08-09T00:00:00.000Z",
    project_root: "/workspace/ultrafuzz",
    report_path: ".ultrafuzz/release-validation.report.json",
    overall_status: "pass",
    commands: [
      {
        id: "docs",
        title: "Documentation inventory",
        command: "pnpm -w docs:check",
        required: true,
        status: "passed",
        exit_code: 0,
        duration_ms: 1,
        validation_gates: ["G-DOCS"]
      }
    ]
  };
}

test("release validation reports serialize only the current reconciled contract", () => {
  const report = validReport();
  assertReleaseValidationReport(report);
  const before = structuredClone(report);
  const bytes = serializeReleaseValidationReport(report);
  assert.deepEqual(report, before);
  const parsed = parseStrictJsonBytes(bytes);
  assert.deepEqual(parsed, report);
  assert.deepEqual(validateRegisteredJsonSchema(RELEASE_VALIDATION_REPORT_JSON_SCHEMA_ID, parsed), {
    ok: true,
    issues: [],
    truncated: false
  });
});

test("release validation reports reject old versions, shape drift, duplicate commands, and status drift", () => {
  const report = validReport();
  assert.throws(() =>
    assertReleaseValidationReport({ ...report, schema_version: "ultrafuzz.release-validation.report.v1" })
  );
  assert.throws(() => assertReleaseValidationReport({ ...report, failures: { commands: [] } }));
  assert.throws(() =>
    assertReleaseValidationReport({ ...report, commands: [...report.commands, { ...report.commands[0]! }] })
  );
  assert.throws(() => assertReleaseValidationReport({ ...report, overall_status: "fail" }));
  assert.throws(() => assertReleaseValidationReport({ ...report, report_path: "../outside.json" }));
  assert.throws(() =>
    assertReleaseValidationReport({
      ...report,
      overall_status: "fail",
      commands: [{ ...report.commands[0]!, status: "failed", exit_code: 0 }]
    })
  );
});
