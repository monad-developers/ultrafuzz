import assert from "node:assert/strict";
import test from "node:test";

import { expectedSeverityFromMatrix, validateSeverityMatrixArtifact } from "../src/severity-matrix.js";

test("severity matrix caps low-likelihood findings", () => {
  assert.equal(expectedSeverityFromMatrix("High", "Low"), "Medium");
  assert.equal(expectedSeverityFromMatrix("Medium", "Low"), "Low");
  assert.equal(expectedSeverityFromMatrix("High", "Medium"), "High");
  assert.equal(expectedSeverityFromMatrix("Low", "High"), "Low");
});

test("final report validation blocks matrix-inconsistent production issues", () => {
  const diagnostics = validateSeverityMatrixArtifact({
    kind: "final-report",
    artifactPath: "/tmp/report.json",
    artifact: {
      schema_version: "1.0",
      issues: [
        {
          title: "[H-01] - High impact low likelihood issue",
          severity: "High",
          impact: "High",
          likelihood: "Low"
        },
        {
          title: "[M-01] - Medium impact low likelihood issue",
          severity: "Medium",
          impact: "Medium",
          likelihood: "Low"
        }
      ],
      non_production_outcomes: []
    }
  });

  assert.equal(diagnostics.filter((diagnostic) => diagnostic.code === "SEVERITY_MATRIX_MISMATCH").length, 2);
  assert.match(diagnostics[0]?.message ?? "", /expected Medium/);
  assert.match(diagnostics[1]?.message ?? "", /expected Low/);
});

test("final report validation accepts legacy adapter issue shape", () => {
  const issue = {
    schema_version: "1.0",
    id: "finding-001",
    title: "Source-backed protocol condition",
    severity_guess: "medium",
    confidence: "high",
    status: "needs-review",
    summary: "A concrete condition is supported by source and test evidence.",
    affected_files: ["src/Example.sol"],
    evidence: [{ kind: "generated-test", path: "generated-tests/Example.t.sol" }],
    notes: ["impact=Medium", "likelihood=Medium"]
  };
  const diagnostics = validateSeverityMatrixArtifact({
    kind: "final-report",
    artifactPath: "/tmp/report.json",
    artifact: {
      schema_version: "ultrafuzz.e2e.report.v1",
      issues: [issue],
      findings: [issue]
    }
  });

  assert.deepEqual(diagnostics, []);
});

test("severity classification validation rejects Critical and missing matrix fields", () => {
  const diagnostics = validateSeverityMatrixArtifact({
    kind: "severity-classification",
    artifactPath: "/tmp/severity-classified-findings.json",
    artifact: [
      {
        schema_version: "1.0",
        id: "finding-1",
        title: "No critical labels",
        status: "needs-review",
        final_severity: "Critical",
        severity: "Critical",
        severity_guess: "Critical"
      }
    ]
  });

  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "SEVERITY_LEVEL_INVALID"));
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "SEVERITY_MATRIX_FIELD_MISSING"));
});

test("severity classification accepts matrix-consistent final severity aliases", () => {
  const diagnostics = validateSeverityMatrixArtifact({
    kind: "severity-classification",
    artifactPath: "/tmp/severity-classified-findings.json",
    artifact: {
      findings: [
        {
          schema_version: "1.0",
          id: "finding-1",
          title: "Consistent labels",
          status: "needs-review",
          final_severity: "Medium",
          severity: "Medium",
          severity_guess: "Medium",
          impact: "High",
          likelihood: "Low",
          confidence: "High",
          notes: ["impact=high", "likelihood=low"]
        }
      ]
    }
  });

  assert.deepEqual(diagnostics, []);
});
