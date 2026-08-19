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

test("goal search coverage is rendered into the Markdown report instead of only the JSON", () => {
  const empty = (): Record<string, unknown> => ({
    schema_version: "1.0",
    run_metadata: { run_id: "goal-coverage-test" },
    issues: [],
    non_production_outcomes: [],
    property_provenance: []
  });
  const lane = (index: number, status: string, logicalNodeId = "class-goals"): Record<string, unknown> => ({
    node_id: `dynamic:class:${index}`,
    logical_node_id: logicalNodeId,
    attempt_id: `attempt-${String(index).padStart(3, "0")}`,
    status,
    finding_count: status === "completed-with-findings" ? 1 : status === "completed-no-findings" ? 0 : null
  });
  const census = (
    goals: Array<Record<string, unknown>>,
    totals?: Record<string, unknown>
  ): Record<string, unknown> => ({
    schema_version: "ultrafuzz.goal-search-coverage.v1",
    run_id: "goal-coverage-test",
    totals: totals ?? { planned: goals.length },
    goals
  });

  // Every targeted lane searched: an empty findings list is a searched negative.
  const full = projectCanonicalFinalReport({
    ...empty(),
    goal_search_coverage: census([
      lane(1, "completed-with-findings"),
      lane(2, "completed-no-findings"),
      lane(3, "completed-no-findings"),
      lane(4, "completed-no-findings", "goal-roaming")
    ])
  });
  assert.match(full.markdown, /^## Goal search coverage$/mu);
  assert.match(full.markdown, /All 3 targeted goal searches completed and published a verified result/u);
  assert.match(full.markdown, /- Targeted goal search lanes: `3`\n- Completed with a verified result: `3`/u);
  assert.match(full.markdown, /- Completed and reported findings: `1`\n- Completed and reported no findings: `2`/u);
  assert.match(full.markdown, /- Untargeted roaming passes, counted separately: `1` of `1` completed/u);
  // The roaming pass must not be counted inside the targeted denominator.
  assert.doesNotMatch(full.markdown, /- Targeted goal search lanes: `4`/u);
  assert.match(full.markdown, /^No issues reported\.$/mu);
  assert.equal(isDirectiveConformingFinalReportMarkdown(full.markdown, full.report), true);

  // A partial hunt must be unmistakable, and must not leave "No issues reported." standing alone.
  const partialGoals = [
    lane(1, "completed-no-findings"),
    lane(2, "completed-no-findings"),
    lane(3, "completed-no-findings"),
    ...Array.from({ length: 73 }, (_entry, index) => lane(index + 4, "stopped-early")),
    lane(77, "unverified")
  ];
  const partial = projectCanonicalFinalReport({ ...empty(), goal_search_coverage: census(partialGoals) });
  assert.match(
    partial.markdown,
    /\*\*Partial goal search coverage: only 3 of 77 targeted goal searches completed\.\*\*/u
  );
  assert.match(partial.markdown, /The other 74 published no verified result/u);
  assert.match(partial.markdown, /absence of evidence, not evidence of absence/u);
  assert.match(partial.markdown, /- Stopped early without returning: `73`/u);
  assert.match(partial.markdown, /- Returned without passing verification: `1`/u);
  assert.match(
    partial.markdown,
    /^No issues were reported, but only 3 of 77 targeted goal searches completed, so this is not a result\. See \[Goal search coverage\]\(#goal-search-coverage\)\.$/mu
  );
  assert.doesNotMatch(partial.markdown, /^No issues reported\.$/mu);
  assert.equal(isDirectiveConformingFinalReportMarkdown(partial.markdown, partial.report), true);

  // Both absences of measurement are named when both happened.
  const partialAndBlocked = projectCanonicalFinalReport({
    ...empty(),
    campaign_outcome: { outcome: "blocked" },
    goal_search_coverage: census(partialGoals)
  });
  assert.match(
    partialAndBlocked.markdown,
    /^No issues were reported, but the invariant campaign did not run and only 3 of 77 targeted goal searches completed, so this is not a result\./mu
  );

  // An unknown census must read as unknown, never as silence and never as full coverage.
  for (const coverage of [
    undefined,
    "unavailable",
    { schema_version: "ultrafuzz.goal-search-coverage.v0" },
    {},
    "",
    7
  ]) {
    const unknown = projectCanonicalFinalReport(
      coverage === undefined ? empty() : { ...empty(), goal_search_coverage: coverage }
    );
    assert.match(unknown.markdown, /^## Goal search coverage$/mu);
    assert.match(unknown.markdown, /\*\*Goal search coverage is unknown\.\*\*/u);
    assert.match(unknown.markdown, /Unknown coverage is not full coverage\./u);
    assert.doesNotMatch(unknown.markdown, /- Targeted goal search lanes:/u);
    // A topology that runs no goal lanes reports unknown coverage as a matter of course, so the
    // unknown case must not turn its clean result into a warning.
    assert.match(unknown.markdown, /^No issues reported\.$/mu);
    assert.equal(isDirectiveConformingFinalReportMarkdown(unknown.markdown, unknown.report), true);
  }

  // A census with zero recorded lanes is the dead-goal-plan shape, and reports unknown, not complete.
  const noLanes = projectCanonicalFinalReport({ ...empty(), goal_search_coverage: census([], { planned: 0 }) });
  assert.match(noLanes.markdown, /\*\*Goal search coverage is unknown\.\*\*/u);

  // A lane count that disagrees with the census summary is disclosed, not silently trusted.
  const inconsistent = projectCanonicalFinalReport({
    ...empty(),
    goal_search_coverage: census([lane(1, "completed-no-findings")], { planned: 9 })
  });
  assert.match(inconsistent.markdown, /- Targeted goal search lanes: `1`/u);
  assert.match(inconsistent.markdown, /census summary disagrees with the per-lane record/u);

  // An unrecognized status is a lane, but never a completion.
  const unrecognized = projectCanonicalFinalReport({
    ...empty(),
    goal_search_coverage: census([lane(1, "completed-no-findings"), lane(2, "invented-status")])
  });
  assert.match(unrecognized.markdown, /\*\*Partial goal search coverage: only 1 of 2 targeted goal searches/u);
  assert.match(unrecognized.markdown, /- Recorded with an unrecognized status: `1`/u);

  // Dropping the section from a current-run projection is a conformance failure, not a style choice.
  assert.equal(
    isDirectiveConformingFinalReportMarkdown(
      full.markdown.replace("## Goal search coverage", "## Goal coverage"),
      full.report
    ),
    false
  );

  // Only roaming ran: the targeted denominator is empty and says so.
  const roamingOnly = projectCanonicalFinalReport({
    ...empty(),
    goal_search_coverage: census([lane(1, "completed-no-findings", "goal-roaming")])
  });
  assert.match(
    roamingOnly.markdown,
    /\*\*No targeted goal search coverage: this run recorded no targeted goal search lanes\.\*\*/u
  );
  assert.match(roamingOnly.markdown, /^No issues were reported, but no targeted goal search lane ran, /mu);
});
