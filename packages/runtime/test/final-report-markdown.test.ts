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
    strategy_loops: 4,
    audit_profile: "full",
    audit_profile_catalog_digest: "a".repeat(64),
    topology_digest: "b".repeat(64),
    prompt_digest: "c".repeat(64),
    expanded_graph_fingerprint: "d".repeat(64)
  };
}

function renderableReport(): Record<string, unknown> {
  return {
    schema_version: "ultrafuzz.report.v2",
    run_metadata: runMetadata("projection-test"),
    issues: [
      {
        schema_version: "ultrafuzz.finding.v2",
        id: "source-finding-17",
        title: "State mismatch",
        status: "confirmed",
        severity: "Low",
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
        lifecycle: {
          dedupe_key: "state-mismatch",
          source_artifacts: [],
          strategy_hits: [],
          canonical_severity: "Low"
        }
      }
    ],
    non_production_outcomes: [],
    property_provenance: [
      {
        finding_id: "source-finding-17",
        source_finding_id: "source-finding",
        title: "State mismatch",
        property_ids: ["property-1"],
        sources: [{ source_node_id: "properties", source_property_id: "property-1" }],
        implementation_paths: ["test/Invariant.t.sol"],
        test_paths: ["test/Invariant.t.sol"]
      }
    ],
    property_implementation_coverage: {
      priority_threshold: "high",
      priorities: ["high"],
      selected_property_ids: ["property-1"],
      implemented_property_ids: ["property-1"],
      blocked_property_ids: [],
      pending_property_ids: [],
      deferred_property_ids: [],
      reference_expected_property_ids: [],
      reference_expectation_ids: [],
      blocker_summaries: []
    }
  };
}

test("canonical final-report validation renders Markdown without rewriting the validated report", () => {
  const input = renderableReport();
  const before = structuredClone(input);
  assert.equal(supportsCanonicalFinalReportProjection(input), true);

  const first = projectCanonicalFinalReport(input);
  const second = projectCanonicalFinalReport(first.report);
  assert.deepEqual(second, first);
  assert.deepEqual(first.report, before);
  assert.deepEqual(input, before);

  const issue = (first.report.issues as Array<Record<string, unknown>>)[0]!;
  assert.equal(issue.id, "source-finding-17");
  assert.equal(issue.title, "State mismatch");
  assert.equal(issue.severity, "Low");
  assert.equal(issue.severity_guess, "Medium", "the upstream preliminary estimate must remain unchanged");
  assert.equal((issue.lifecycle as Record<string, unknown>).canonical_severity, "Low");
  assert.equal(
    (first.report.property_provenance as Array<Record<string, unknown>>)[0]?.finding_id,
    "source-finding-17"
  );
  assert.equal(
    (first.report.property_provenance as Array<Record<string, unknown>>)[0]?.source_finding_id,
    "source-finding"
  );

  assert.match(first.markdown, /^# Ultrafuzz report\n\n\| Issue id \| Title \|/u);
  assert.match(first.markdown, /^## \[source-finding-17\] - State mismatch$/mu);
  assert.match(first.markdown, /\| stateful-invariant \| 1\/4 \|/u);
  assert.doesNotMatch(first.markdown, /synthetic-final-report-secret/u);
  assert.doesNotMatch(first.markdown, /\/home\/runner\/private/u);
  assert.equal(isDirectiveConformingFinalReportMarkdown(first.markdown, first.report), true);
});

test("canonical final-report validation rejects presentation drift instead of repairing it", () => {
  const legacyAlias = renderableReport();
  (legacyAlias.issues as Array<Record<string, unknown>>)[0]!.final_severity = "Low";
  const legacyBefore = structuredClone(legacyAlias);
  assert.throws(() => projectCanonicalFinalReport(legacyAlias), /validation/u);
  assert.deepEqual(legacyAlias, legacyBefore);

  const strategyAlias = renderableReport();
  (strategyAlias.issues as Array<Record<string, unknown>>)[0]!.strategy_provenance = {
    strategies: [{ strategy: "stateful-invariant", detections: 1, configured_loops: 4 }]
  };
  const strategyAliasBefore = structuredClone(strategyAlias);
  assert.throws(() => projectCanonicalFinalReport(strategyAlias), /validation/u);
  assert.deepEqual(strategyAlias, strategyAliasBefore);

  const wrongSeverity = renderableReport();
  (wrongSeverity.issues as Array<Record<string, unknown>>)[0]!.severity = "Medium";
  assert.throws(
    () => projectCanonicalFinalReport(wrongSeverity),
    /expected Low from impact Medium and likelihood Low/u
  );

  const staleProvenance = renderableReport();
  (staleProvenance.property_provenance as Array<Record<string, unknown>>)[0]!.finding_id = "source-finding";
  assert.throws(() => projectCanonicalFinalReport(staleProvenance), /references unknown finding/u);

  const arbitraryIdentity = renderableReport();
  (arbitraryIdentity.issues as Array<Record<string, unknown>>)[0]!.id = "finding-from-dedupe";
  (arbitraryIdentity.issues as Array<Record<string, unknown>>)[0]!.title = "Exact upstream title";
  const provenance = (arbitraryIdentity.property_provenance as Array<Record<string, unknown>>)[0]!;
  provenance.finding_id = "finding-from-dedupe";
  provenance.title = "Exact upstream title";
  const arbitraryProjection = projectCanonicalFinalReport(arbitraryIdentity);
  assert.equal((arbitraryProjection.report.issues as Array<Record<string, unknown>>)[0]!.id, "finding-from-dedupe");
  assert.equal((arbitraryProjection.report.issues as Array<Record<string, unknown>>)[0]!.title, "Exact upstream title");
  assert.match(arbitraryProjection.markdown, /^## \[finding-from-dedupe\] - Exact upstream title$/mu);

  const misordered = renderableReport();
  const highIssue = structuredClone((misordered.issues as Array<Record<string, unknown>>)[0]!);
  Object.assign(highIssue, {
    id: "high-source-finding",
    title: "High impact mismatch",
    severity: "High",
    impact: "High",
    likelihood: "High"
  });
  (misordered.issues as Array<Record<string, unknown>>).push(highIssue);
  misordered.property_provenance = [];
  const preservedOrder = projectCanonicalFinalReport(misordered);
  assert.ok(
    preservedOrder.markdown.indexOf("## [source-finding-17] - State mismatch") <
      preservedOrder.markdown.indexOf("## [high-source-finding] - High impact mismatch")
  );
});

test("canonical final-report projection supports a meaningful zero-issue report", () => {
  const projection = projectCanonicalFinalReport({
    schema_version: "ultrafuzz.report.v2",
    run_metadata: runMetadata("zero-issue"),
    issues: [],
    non_production_outcomes: [],
    property_provenance: [],
    property_implementation_coverage: {
      status: "not-planned",
      reason: "property-implementation-track-not-declared"
    }
  });

  assert.deepEqual(projection.report.issues, []);
  assert.match(projection.markdown, /^# Ultrafuzz report\n/u);
  assert.match(projection.markdown, /^No issues reported\.$/mu);
  assert.match(projection.markdown, /^## Property implementation coverage$/mu);
  assert.match(projection.markdown, /^- Status: `not-planned`$/mu);
  assert.match(projection.markdown, /^- Reason: `property-implementation-track-not-declared`$/mu);
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
      projection.markdown.replace("## [source-finding-17] - State mismatch", "## [changed-finding] - State mismatch"),
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
    schema_version: "ultrafuzz.report.v2",
    run_metadata: runMetadata("campaign-outcome-test"),
    issues: [],
    non_production_outcomes: [],
    property_provenance: [],
    property_implementation_coverage: {
      status: "not-planned",
      reason: "property-implementation-track-not-declared"
    }
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
  const completed = projectCanonicalFinalReport({ ...empty(), campaign_outcome: { outcome: "complete" } });
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
