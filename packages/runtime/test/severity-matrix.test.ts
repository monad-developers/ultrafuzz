import assert from "node:assert/strict";
import test from "node:test";

import { expectedSeverityFromMatrix, validateSeverityMatrixArtifact } from "../src/severity-matrix.js";

test("severity matrix accepts only exact canonical levels", () => {
  assert.equal(expectedSeverityFromMatrix("High", "Low"), "Medium");
  assert.equal(expectedSeverityFromMatrix("Medium", "Low"), "Low");
  assert.equal(expectedSeverityFromMatrix("High", "Medium"), "High");
  assert.equal(expectedSeverityFromMatrix("Low", "High"), "Low");
  assert.equal(expectedSeverityFromMatrix("high", "Low"), undefined);
  assert.equal(expectedSeverityFromMatrix("High ", "Low"), undefined);
});

test("final report validation accepts canonical matrix fields and ignores a preliminary severity guess", () => {
  const diagnostics = validateSeverityMatrixArtifact({
    kind: "final-report",
    artifactPath: "/tmp/report.json",
    artifact: {
      issues: [
        {
          severity: "Medium",
          severity_guess: "High",
          impact: "High",
          likelihood: "Low"
        }
      ]
    }
  });

  assert.deepEqual(diagnostics, []);
});

test("final report validation blocks matrix-inconsistent issues", () => {
  const diagnostics = validateSeverityMatrixArtifact({
    kind: "final-report",
    artifactPath: "/tmp/report.json",
    artifact: {
      issues: [
        { severity: "High", impact: "High", likelihood: "Low" },
        { severity: "Medium", impact: "Medium", likelihood: "Low" }
      ]
    }
  });

  assert.equal(diagnostics.filter((diagnostic) => diagnostic.code === "SEVERITY_MATRIX_MISMATCH").length, 2);
  assert.match(diagnostics[0]?.message ?? "", /expected Medium/);
  assert.match(diagnostics[1]?.message ?? "", /expected Low/);
});

test("severity validation rejects lowercase levels and legacy field aliases", () => {
  const diagnostics = validateSeverityMatrixArtifact({
    kind: "severity-classification",
    artifactPath: "/tmp/severity-classified-findings.json",
    artifact: [
      {
        severity: "medium",
        impact: "High",
        likelihood: "Low",
        final_severity: "Medium",
        impact_level: "High",
        likelihood_level: "Low",
        severity_classification: { impact: "High", likelihood: "Low" }
      }
    ]
  });

  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "SEVERITY_LEVEL_INVALID"));
  assert.equal(diagnostics.filter((diagnostic) => diagnostic.code === "SEVERITY_FIELD_ALIAS_UNSUPPORTED").length, 4);
});

test("severity classification rejects wrappers and does not parse matrix values from notes", () => {
  const wrapped = validateSeverityMatrixArtifact({
    kind: "severity-classification",
    artifactPath: "/tmp/severity-classified-findings.json",
    artifact: { findings: [{ severity: "Medium", impact: "High", likelihood: "Low" }] }
  });
  assert.deepEqual(
    wrapped.map((diagnostic) => diagnostic.code),
    ["SEVERITY_ARTIFACT_SHAPE_INVALID"]
  );

  const notesOnly = validateSeverityMatrixArtifact({
    kind: "severity-classification",
    artifactPath: "/tmp/severity-classified-findings.json",
    artifact: [{ severity: "Medium", notes: ["impact=High", "likelihood=Low"] }]
  });
  assert.equal(notesOnly.filter((diagnostic) => diagnostic.code === "SEVERITY_MATRIX_FIELD_MISSING").length, 2);
});

test("severity validation reports non-object records instead of silently dropping them", () => {
  const diagnostics = validateSeverityMatrixArtifact({
    kind: "severity-classification",
    artifactPath: "/tmp/severity-classified-findings.json",
    artifact: [null]
  });

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.code),
    ["SEVERITY_RECORD_SHAPE_INVALID"]
  );
});
