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
    audit_context: {
      threat_model: {
        markdown: "../threat-model/THREAT_MODEL.md",
        json: "../threat-model/threat-model.json"
      },
      goal_plan: { json: "../goal-plan/goal-plan.json" }
    },
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
        },
        source_node_id: "dynamic:threat:state-mismatch",
        source_nodes: ["dynamic:threat:state-mismatch", "dynamic:class:state-machine"]
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
  assert.match(
    first.markdown,
    /## Audit context\n\n- Threat model: \[THREAT_MODEL\.md\]\(\.\.\/threat-model\/THREAT_MODEL\.md\); \[threat-model\.json\]\(\.\.\/threat-model\/threat-model\.json\)\n- Goal plan: \[goal-plan\.json\]\(\.\.\/goal-plan\/goal-plan\.json\)/u
  );
  assert.match(first.markdown, /^## \[L-01\] - State mismatch$/mu);
  assert.match(
    first.markdown,
    /- \*\*Source nodes\*\*: `dynamic:threat:state-mismatch`, `dynamic:class:state-machine`/u
  );
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

test("a campaign that never fuzzed is disclosed instead of reading as a clean result", () => {
  const empty = (): Record<string, unknown> => ({
    schema_version: "1.0",
    run_metadata: { run_id: "campaign-outcome-test" },
    issues: [],
    non_production_outcomes: [],
    property_provenance: []
  });

  const blocked = projectCanonicalFinalReport({
    ...empty(),
    campaign_outcome: {
      outcome: "blocked",
      reason: "recon executable unavailable; the long single-backend campaign was not started"
    }
  });
  assert.match(blocked.markdown, /## Campaign status/u);
  assert.match(blocked.markdown, /did not run: `blocked`/u);
  assert.match(blocked.markdown, /Reason: recon executable unavailable/u);
  assert.match(blocked.markdown, /the invariant campaign did not run, so this is not a result/u);
  assert.doesNotMatch(blocked.markdown, /^No issues reported\.$/mu);
  assert.deepEqual(blocked.report.campaign_outcome, {
    outcome: "blocked",
    reason: "recon executable unavailable; the long single-backend campaign was not started"
  });

  // A campaign that ran and found nothing keeps reading as a clean result.
  const completed = projectCanonicalFinalReport({ ...empty(), campaign_outcome: { outcome: "completed" } });
  assert.doesNotMatch(completed.markdown, /## Campaign status/u);
  assert.match(completed.markdown, /^No issues reported\.$/mu);

  // Runs without a campaign are unchanged.
  const absent = projectCanonicalFinalReport(empty());
  assert.doesNotMatch(absent.markdown, /## Campaign status/u);
  assert.match(absent.markdown, /^No issues reported\.$/mu);

  // A partial campaign did fuzz, so it must not be described as a non-run.
  const partial = projectCanonicalFinalReport({
    ...empty(),
    campaign_outcome: { outcome: "partial", reason: "the deadline elapsed before the last backend finished" }
  });
  assert.match(partial.markdown, /## Campaign status/u);
  assert.match(partial.markdown, /did not complete: `partial`/u);
  assert.match(partial.markdown, /come from a partial campaign/u);
  assert.doesNotMatch(partial.markdown, /did not run/u);
  assert.match(partial.markdown, /^No issues reported\.$/mu);
});
