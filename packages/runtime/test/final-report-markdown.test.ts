import assert from "node:assert/strict";
import test from "node:test";

import {
  isDirectiveConformingFinalReportMarkdown,
  projectCanonicalFinalReport,
  supportsCanonicalFinalReportProjection
} from "../src/final-report-markdown.js";

function runMetadata(runId: string): Record<string, unknown> {
  return {
    run_id: runId,
    source_run_id: runId,
    repository: "example/repository",
    elapsed_time: "1m",
    models_used: ["model-a"],
    tokens_used: "100",
    estimated_spend: "$0.01",
    partial_pricing: false,
    strategy_loops: 4
  };
}

function renderableReport(): Record<string, unknown> {
  return {
    schema_version: "ultrafuzz.report.v2",
    run_metadata: runMetadata("projection-test"),
    issues: [
      {
        schema_version: "ultrafuzz.finding.v2",
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
        severity_rationale: "The bounded impact and uncommon preconditions produce a low final severity.",
        proof_of_concept: {
          scenario: ["Prepare the bounded state.", "Execute the transition and observe the mismatch."],
          language: "solidity",
          code: "assert(expected == actual);"
        },
        strategy: "stateful-invariant",
        strategy_provenance: {
          detection_rates: [{ strategy: "stateful-invariant", detections: 1, configured_loops: 4 }]
        },
        lifecycle: { dedupe_key: "state-mismatch", source_artifacts: [], strategy_hits: [] }
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
  const second = projectCanonicalFinalReport(first.report);
  assert.deepEqual(second, first);

  const issue = (first.report.issues as Array<Record<string, unknown>>)[0]!;
  assert.equal(issue.id, "L-01");
  assert.equal(issue.title, "[L-01] - State mismatch");
  assert.equal(issue.severity, "Low");
  assert.equal(issue.severity_guess, "Medium", "the upstream preliminary estimate must remain unchanged");
  assert.equal((first.report.property_provenance as Array<Record<string, unknown>>)[0]?.finding_id, "L-01");
  assert.equal(
    (first.report.property_provenance as Array<Record<string, unknown>>)[0]?.source_finding_id,
    "source-finding"
  );

  assert.match(first.markdown, /^# Ultrafuzz report\n\n\| Issue id \| Title \|/u);
  assert.match(first.markdown, /^## \[L-01\] - State mismatch$/mu);
  assert.match(first.markdown, /\| stateful-invariant \| 1\/4 \|/u);
  assert.doesNotMatch(first.markdown, /synthetic-final-report-secret/u);
  assert.doesNotMatch(first.markdown, /\/home\/runner\/private/u);
  assert.equal(isDirectiveConformingFinalReportMarkdown(first.markdown, first.report), true);
});

test("canonical final-report projection supports a meaningful zero-issue report", () => {
  const projection = projectCanonicalFinalReport({
    schema_version: "ultrafuzz.report.v2",
    run_metadata: runMetadata("zero-issue"),
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
        schema_version: "ultrafuzz.report.v2",
        run_metadata: {},
        issues: [],
        non_production_outcomes: [],
        property_provenance: []
      }),
    /validation/u
  );
  assert.throws(() => projectCanonicalFinalReport({ issues: "not-an-array" }), /validation/u);

  const unrenderable = renderableReport();
  const issue = (unrenderable.issues as Array<Record<string, unknown>>)[0]!;
  delete issue.strategy_provenance;
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

test("directive validation recognizes CommonMark tilde fences and matching closers", () => {
  const projection = projectCanonicalFinalReport(renderableReport());
  const insertProofBlock = (block: string): string =>
    projection.markdown.replace("\n### Strategy\n", `\n${block}\n\n### Strategy\n`);
  const tildeProof = insertProofBlock(
    [
      "   ~~~~solidity",
      "contract CriticalStateProbe {",
      '    string internal constant label = "#### Sources";',
      "    // **Source Node Id**, ## Executive summary, and ### Strategy provenance are code.",
      "```",
      "Critical",
      "~~~",
      "<script>proofOnly()</script>",
      "~~~~   "
    ].join("\n")
  );

  assert.equal(isDirectiveConformingFinalReportMarkdown(tildeProof, projection.report), true);
  assert.equal(
    isDirectiveConformingFinalReportMarkdown(
      tildeProof.replace("~~~~   \n\n### Strategy", "~~~~   \n\nCritical\n\n### Strategy"),
      projection.report
    ),
    false
  );
  assert.equal(
    isDirectiveConformingFinalReportMarkdown(
      insertProofBlock(["    ~~~solidity", "Critical", "    ~~~"].join("\n")),
      projection.report
    ),
    false,
    "four-space indentation must not hide prose as a CommonMark fence"
  );
});

test("directive validation scans tilde-fenced code for secrets and private paths", () => {
  const projection = projectCanonicalFinalReport(renderableReport());
  const insertProofBlock = (code: string): string =>
    projection.markdown.replace("\n### Strategy\n", `\n~~~text\n${code}\n~~~\n\n### Strategy\n`);

  assert.equal(
    isDirectiveConformingFinalReportMarkdown(insertProofBlock("token=synthetic-tilde-fence-secret"), projection.report),
    false
  );
  assert.equal(
    isDirectiveConformingFinalReportMarkdown(
      insertProofBlock("/home/runner/private/reproducer.sol"),
      projection.report
    ),
    false
  );
});
