import assert from "node:assert/strict";
import test from "node:test";

import {
  isDirectiveConformingFinalReportMarkdown,
  projectCanonicalFinalReport,
  supportsCanonicalFinalReportProjection
} from "../src/final-report-markdown.js";

function renderableReport(): Record<string, unknown> {
  return {
    schema_version: "1.0",
    run_metadata: { run_id: "projection-test" },
    issues: [
      {
        schema_version: "1.0",
        id: "source-finding",
        title: "State mismatch",
        status: "confirmed",
        severity: "Medium",
        severity_guess: "Medium",
        confidence: "high",
        summary: "A bounded transition violates the expected relationship.",
        description:
          "A caller can trigger the mismatch; token=synthetic-final-report-secret and /home/runner/private/reproducer.sol stay private.",
        impact: "Medium",
        impact_rationale: "The affected state remains bounded.",
        likelihood: "Low",
        likelihood_rationale: "The transition requires uncommon preconditions.",
        proof_of_concept: {
          scenario: ["Prepare the bounded state.", "Execute the transition and observe the mismatch."]
        },
        strategy: "stateful-invariant",
        strategy_provenance: {
          detection_rates: [{ strategy: "stateful-invariant", detections: 1, configured_loops: 4 }]
        }
      }
    ],
    non_production_outcomes: [],
    property_provenance: [
      {
        finding_id: "source-finding",
        title: "State mismatch",
        property_ids: ["property-1"],
        sources: [{ source_node_id: "properties", source_property_id: "property-1" }],
        implementation_paths: ["test/Invariant.t.sol"],
        test_paths: ["test/Invariant.t.sol"]
      }
    ]
  };
}

test("canonical final-report projection returns one canonical JSON and Markdown presentation", () => {
  const input = renderableReport();
  assert.equal(supportsCanonicalFinalReportProjection(input), true);

  const first = projectCanonicalFinalReport(input);
  const second = projectCanonicalFinalReport(input);
  assert.deepEqual(second, first);

  const issue = (first.report.issues as Array<Record<string, unknown>>)[0]!;
  assert.equal(issue.id, "L-01");
  assert.equal(issue.title, "[L-01] - State mismatch");
  assert.equal(issue.upstream_id, "source-finding");
  assert.equal(issue.severity, "Low");
  assert.equal(issue.severity_guess, "Low");
  assert.equal((first.report.property_provenance as Array<Record<string, unknown>>)[0]?.finding_id, "L-01");

  assert.match(first.markdown, /^# Ultrafuzz report\n\n\| Issue id \| Title \|/u);
  assert.match(first.markdown, /^## \[L-01\] - State mismatch$/mu);
  assert.match(first.markdown, /\| stateful-invariant \| 1\/4 \|/u);
  assert.doesNotMatch(first.markdown, /synthetic-final-report-secret/u);
  assert.doesNotMatch(first.markdown, /\/home\/runner\/private/u);
  assert.equal(isDirectiveConformingFinalReportMarkdown(first.markdown, first.report), true);
});

test("canonical final-report projection supports a meaningful zero-issue report", () => {
  const projection = projectCanonicalFinalReport({
    schema_version: "1.0",
    run_metadata: { run_id: "zero-issue" },
    issues: [],
    non_production_outcomes: [],
    property_provenance: []
  });

  assert.deepEqual(projection.report.issues, []);
  assert.match(projection.markdown, /^# Ultrafuzz report\n/u);
  assert.match(projection.markdown, /^No issues reported\.$/mu);
  assert.match(projection.markdown, /^## Property implementation coverage$/mu);
  assert.match(projection.markdown, /^## Property provenance$/mu);
  assert.doesNotMatch(projection.markdown, /\| Issue id \| Title \|/u);
});

test("canonical final-report projection rejects empty, invalid, and unrenderable structured output", () => {
  assert.throws(
    () =>
      projectCanonicalFinalReport({
        schema_version: "1.0",
        run_metadata: {},
        issues: [],
        non_production_outcomes: []
      }),
    /canonical empty final report/u
  );
  assert.throws(() => projectCanonicalFinalReport({ issues: "not-an-array" }), /validation/u);

  const unrenderable = renderableReport();
  const issue = (unrenderable.issues as Array<Record<string, unknown>>)[0]!;
  issue.strategy_provenance = { detection_rates: [{ strategy: "stateful-invariant" }] };
  assert.equal(supportsCanonicalFinalReportProjection(unrenderable), false);
  assert.throws(() => projectCanonicalFinalReport(unrenderable), /not renderable/u);
});

test("directive validation rejects injected or presentation-divergent Markdown", () => {
  const projection = projectCanonicalFinalReport(renderableReport());
  assert.equal(
    isDirectiveConformingFinalReportMarkdown(
      `${projection.markdown}\n## Executive summary\n\nInjected presentation.\n`,
      projection.report
    ),
    false
  );
  assert.equal(
    isDirectiveConformingFinalReportMarkdown(
      projection.markdown.replace("## [L-01] - State mismatch", "## [M-01] - State mismatch"),
      projection.report
    ),
    false
  );
});

test("directive validation treats fenced proof code as code while retaining prose restrictions", () => {
  const input = renderableReport();
  const issue = (input.issues as Array<Record<string, unknown>>)[0]!;
  issue.proof_of_concept = {
    scenario: ["Prepare the bounded state.", "Execute the transition and observe the mismatch."],
    language: "solidity",
    code: [
      "contract CriticalStateProbe {",
      '    string internal constant label = "#### Sources";',
      "    // **Source Node Id** and ### Strategy provenance are target identifiers here.",
      "}"
    ].join("\n")
  };

  const projection = projectCanonicalFinalReport(input);
  assert.match(projection.markdown, /contract CriticalStateProbe/u);
  assert.match(projection.markdown, /#### Sources/u);
  assert.equal(isDirectiveConformingFinalReportMarkdown(projection.markdown, projection.report), true);
  assert.equal(
    isDirectiveConformingFinalReportMarkdown(
      projection.markdown.replace("### Proof of Concept\n", "### Proof of Concept\n\nCritical\n"),
      projection.report
    ),
    false
  );
});
