import assert from "node:assert/strict";
import test from "node:test";

test("final reports retain artifact warnings and their context without changing the report JSON", () => {
  const report = renderableReport();
  (report.run_metadata as Record<string, unknown>).artifact_validation_warnings = [
    {
      code: "ARTIFACT_OPTIONAL_METADATA_MISSING",
      artifact_path: "artifacts/dedupe/strategy-detections.json",
      field_path: "$[5].family_id",
      message: "Optional metadata is missing; the original artifact is accepted unchanged",
      gate: "strategy-detection-review-stage-reconciliation",
      source_path: "artifacts/dedupe/deduped-findings.json#$[5].family_id"
    }
  ];
  const before = structuredClone(report);
  const projection = projectCanonicalFinalReport(report);
  assert.match(projection.markdown, /## Artifact validation warnings/u);
  assert.match(projection.markdown, /strategy-detections\.json#\$\[5\]\.family_id/u);
  assert.match(projection.markdown, /deduped-findings\.json/u);
  assert.deepEqual(report, before);
  assert.deepEqual(projection.report, before);
  assert.match(projectPublicCanonicalFinalReport(report).markdown, /Artifact validation warnings/u);
});

import {
  isDirectiveConformingFinalReportMarkdown,
  projectCanonicalFinalReport,
  projectPublicCanonicalFinalReport,
  renderCoverageEvidenceMarkdownSection,
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
    audit_profile: "exhaustive",
    audit_profile_catalog_digest: "a".repeat(64),
    topology_digest: "b".repeat(64),
    prompt_digest: "c".repeat(64),
    expanded_graph_fingerprint: "d".repeat(64)
  };
}

function renderableReport(): Record<string, unknown> {
  return {
    schema_version: "ultrafuzz.report.v3",
    run_metadata: runMetadata("projection-test"),
    issues: [
      {
        schema_version: "ultrafuzz.finding.v2",
        id: "L-01",
        title: "[L-01] - State mismatch",
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
          strategy_hits: [{ strategy: "stateful-invariant" }],
          canonical_severity: "Low"
        }
      }
    ],
    non_production_outcomes: [],
    property_provenance: [
      {
        finding_id: "L-01",
        source_finding_id: "source-finding",
        title: "[L-01] - State mismatch",
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
  assert.equal(issue.id, "L-01");
  assert.equal(issue.title, "[L-01] - State mismatch");
  assert.equal(issue.severity, "Low");
  assert.equal(issue.severity_guess, "Medium", "the upstream preliminary estimate must remain unchanged");
  assert.equal((issue.lifecycle as Record<string, unknown>).canonical_severity, "Low");
  assert.equal((first.report.property_provenance as Array<Record<string, unknown>>)[0]?.finding_id, "L-01");
  assert.equal(
    (first.report.property_provenance as Array<Record<string, unknown>>)[0]?.source_finding_id,
    "source-finding"
  );

  assert.match(first.markdown, /^# Ultrafuzz report\n\n\| Issue id \| Title \|/u);
  assert.match(first.markdown, /^## \[L-01\] - State mismatch$/mu);
  assert.match(first.markdown, /^- Audit profile: `exhaustive`$/mu);
  assert.doesNotMatch(first.markdown, /Strategy loops|### Strategy|Detection rate/u);
  assert.doesNotMatch(
    first.markdown,
    /Audit profile catalog digest|Topology digest|Prompt digest|Expanded graph fingerprint/u
  );
  assert.match(first.markdown, /synthetic-final-report-secret/u);
  assert.match(first.markdown, /\/home\/runner\/private/u);
  assert.doesNotMatch(first.markdown, /<redacted>|\[redacted-path\]/u);
  assert.equal(isDirectiveConformingFinalReportMarkdown(first.markdown, first.report), true);
});

test("public final-report projection redacts private paths without changing internal report authority", () => {
  const input = renderableReport();
  const issue = (input.issues as Array<Record<string, unknown>>)[0]!;
  issue.description =
    "token=synthetic-public-report-secret. Inspect /srv/customer/private/reproducer.sol, C:\\Users\\runner\\secret.log, " +
    "\\\\internal-host\\customer\\proof.sol, reproducer:file:///home/runner/private/proof.sol, " +
    ".ultrafuzz/runs/private/report.json, marker;/var/private/semicolon.sol, " +
    "and https://github.com/example/public.";
  (issue.proof_of_concept as Record<string, unknown>).code = "// retain this comment\n/* and this block comment */";
  const before = structuredClone(input);

  const internal = projectCanonicalFinalReport(input);
  const published = projectPublicCanonicalFinalReport(input);

  assert.deepEqual(input, before);
  assert.deepEqual(internal.report, before);
  assert.match(JSON.stringify(internal.report), /\/srv\/customer\/private\/reproducer\.sol/u);
  assert.doesNotMatch(
    JSON.stringify(published.report),
    /\/srv\/customer\/private|C:\\\\Users\\\\runner|internal-host|file:\/\/\/home|\.ultrafuzz\/runs|\/var\/private/u
  );
  assert.match(JSON.stringify(published.report), /\[redacted-path\]/u);
  assert.match(JSON.stringify(published.report), /https:\/\/github\.com\/example\/public/u);
  assert.match(JSON.stringify(published.report), /retain this comment/u);
  assert.match(JSON.stringify(published.report), /and this block comment/u);
  assert.doesNotMatch(published.markdown, /synthetic-public-report-secret|\/srv\/customer\/private/u);
  assert.deepEqual(projectCanonicalFinalReport(published.report), published);
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

  const wrongId = renderableReport();
  (wrongId.issues as Array<Record<string, unknown>>)[0]!.id = "source-finding";
  assert.throws(() => projectCanonicalFinalReport(wrongId), /canonical ID L-01/u);

  const wrongTitle = renderableReport();
  (wrongTitle.issues as Array<Record<string, unknown>>)[0]!.title = "State mismatch";
  assert.throws(() => projectCanonicalFinalReport(wrongTitle), /must use title/u);

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
  assert.throws(() => projectCanonicalFinalReport(misordered), /not ordered High, Medium, then Low/u);
});

test("canonical final-report validation accepts mixed severities and minimum-two-digit numbering through 10", () => {
  const report = renderableReport();
  const low = structuredClone((report.issues as Array<Record<string, unknown>>)[0]!);
  const highs = Array.from({ length: 10 }, (_, index) => {
    const count = index + 1;
    const id = `H-${String(count).padStart(2, "0")}`;
    return {
      ...structuredClone(low),
      id,
      title: `[${id}] - High finding ${count}`,
      severity: "High",
      impact: "High",
      likelihood: "High",
      lifecycle: { ...(low.lifecycle as Record<string, unknown>), dedupe_key: `high-${count}` }
    };
  });
  const medium = {
    ...structuredClone(low),
    id: "M-01",
    title: "[M-01] - Medium finding",
    severity: "Medium",
    impact: "High",
    likelihood: "Low",
    lifecycle: { ...(low.lifecycle as Record<string, unknown>), dedupe_key: "medium-1" }
  };
  report.issues = [...highs, medium, low];
  report.property_provenance = [];
  const before = structuredClone(report);

  const projection = projectCanonicalFinalReport(report);

  assert.deepEqual(report, before, "the host must not rewrite producer-authored JSON");
  assert.deepEqual(projection.report, before);
  assert.match(projection.markdown, /^## \[H-09\] - High finding 9$/mu);
  assert.match(projection.markdown, /^## \[H-10\] - High finding 10$/mu);
  assert.ok(projection.markdown.indexOf("## [H-10]") < projection.markdown.indexOf("## [M-01]"));
  assert.ok(projection.markdown.indexOf("## [M-01]") < projection.markdown.indexOf("## [L-01]"));
});

test("canonical final-report projection supports a meaningful zero-issue report", () => {
  const projection = projectCanonicalFinalReport({
    schema_version: "ultrafuzz.report.v3",
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

test("canonical final-report projection renders unavailable coverage evidence and typed blockers", () => {
  const coverageEvidence = {
    schema_version: "ultrafuzz.coverage-evidence.v1",
    status: "unavailable",
    blockers: [
      {
        category: "coverage-tooling-blocked",
        summary: "Recon <span hidden>could not</span> ~~produce~~ an authenticated coverage map.",
        evidence_paths: ["logs/recon-coverage.log", "campaign-summary.json"]
      }
    ]
  };
  const report = renderableReport();
  report.coverage_evidence = coverageEvidence;

  assert.deepEqual(renderCoverageEvidenceMarkdownSection(coverageEvidence), [
    "## Scoped coverage evidence",
    "",
    "- Status: unavailable",
    "",
    "Blockers:",
    "- coverage-tooling-blocked: Recon &lt;span hidden&gt;could not&lt;/span&gt; \\~\\~produce\\~\\~ an authenticated coverage map.",
    "  - Evidence: `logs/recon-coverage.log`",
    "  - Evidence: `campaign-summary.json`"
  ]);

  const projection = projectCanonicalFinalReport(report);
  assert.deepEqual(projection.report.coverage_evidence, coverageEvidence);
  assert.match(
    projection.markdown,
    /## Scoped coverage evidence\n\n- Status: unavailable\n\nBlockers:\n- coverage-tooling-blocked: Recon &lt;span hidden&gt;could not&lt;\/span&gt; \\~\\~produce\\~\\~ an authenticated coverage map\.\n {2}- Evidence: `logs\/recon-coverage\.log`\n {2}- Evidence: `campaign-summary\.json`/u
  );
});

test("canonical coverage projection escapes exclusion-reason HTML as public prose", () => {
  assert.deepEqual(
    renderCoverageEvidenceMarkdownSection({
      status: "measured",
      views: [
        { scope: "recon-selected-declaration-completeness", covered_ranges: 1, total_ranges: 1 },
        { scope: "production-declaration-completeness", covered_ranges: 1, total_ranges: 2 }
      ],
      files: [
        {
          path: "src/Excluded.sol",
          kind: "production",
          included: false,
          exclusion_reason: "Not <span hidden>selected</span> ~~by~~ Recon"
        }
      ],
      zero_coverage_components: []
    }),
    [
      "## Scoped coverage evidence",
      "",
      "- recon-selected-declaration-completeness: `1/1`",
      "- production-declaration-completeness: `1/2`",
      "",
      "Excluded from Recon-selected scope:",
      "- `src/Excluded.sol` (production): Not &lt;span hidden&gt;selected&lt;/span&gt; \\~\\~by\\~\\~ Recon",
      "",
      "Zero-coverage components:",
      "- None"
    ]
  );
});

test("canonical final-report projection rejects empty and invalid structured output", () => {
  assert.throws(
    () =>
      projectCanonicalFinalReport({
        schema_version: "ultrafuzz.report.v3",
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
  delete issue.proof_of_concept;
  assert.equal(supportsCanonicalFinalReportProjection(unrenderable), false);
  assert.throws(() => projectCanonicalFinalReport(unrenderable), /validation/u);
});

test("strategy-loop evidence remains structured but is omitted from developer-facing Markdown", () => {
  const report = renderableReport();
  const [issue] = report.issues as Array<Record<string, unknown>>;
  assert.ok(issue);
  const strategyProvenance = {
    detection_rates: [
      { strategy: "stateful-invariant", detections: 1, configured_loops: 3 },
      { strategy: "class-goals", detections: 1, configured_loops: 4 }
    ],
    attempts: [
      { strategy: "stateful-invariant", attempt_index: 0, loop_index: 0 },
      {
        strategy: "class-goals",
        attempt_index: 2,
        loop_index: 2
      }
    ]
  };
  issue.strategy_provenance = strategyProvenance;
  (issue.lifecycle as Record<string, unknown>).strategy_hits = strategyProvenance.attempts;

  const projection = projectCanonicalFinalReport(report);

  assert.deepEqual(
    (projection.report.issues as Array<Record<string, unknown>>)[0]?.strategy_provenance,
    issue.strategy_provenance,
    "execution observations remain available to machine-readable consumers"
  );
  assert.doesNotMatch(projection.markdown, /1\/3|1\/4|stateful-invariant|class-goals|### Strategy|Detection rate/u);
  assert.equal(isDirectiveConformingFinalReportMarkdown(projection.markdown, projection.report), true);

  const missingObservation = structuredClone(report);
  (
    (missingObservation.issues as Array<Record<string, unknown>>)[0]?.strategy_provenance as Record<string, unknown>
  ).attempts = [{ strategy: "stateful-invariant", attempt_index: 0, loop_index: 0 }];
  assert.throws(
    () => projectCanonicalFinalReport(missingObservation),
    /strategy attempts do not exactly preserve authenticated lifecycle strategy hits/u
  );

  const duplicateObservation = structuredClone(report);
  const duplicateProvenance = (duplicateObservation.issues as Array<Record<string, unknown>>)[0]
    ?.strategy_provenance as Record<string, unknown>;
  duplicateProvenance.attempts = [
    { strategy: "stateful-invariant", attempt_index: 0, loop_index: 0 },
    { strategy: "stateful-invariant", attempt_index: 0, loop_index: 0 }
  ];
  (
    (duplicateObservation.issues as Array<Record<string, unknown>>)[0]?.lifecycle as Record<string, unknown>
  ).strategy_hits = duplicateProvenance.attempts;
  assert.throws(() => projectCanonicalFinalReport(duplicateObservation), /repeats contributing execution provenance/u);

  const swappedObservation = structuredClone(report);
  const swappedProvenance = (swappedObservation.issues as Array<Record<string, unknown>>)[0]
    ?.strategy_provenance as Record<string, unknown>;
  swappedProvenance.attempts = [
    { strategy: "class-goals", attempt_index: 0, loop_index: 0 },
    { strategy: "stateful-invariant", attempt_index: 2, loop_index: 2 }
  ];
  assert.throws(
    () => projectCanonicalFinalReport(swappedObservation),
    /strategy attempts do not exactly preserve authenticated lifecycle strategy hits/u
  );

  const misattributedObservation = structuredClone(report);
  (
    (misattributedObservation.issues as Array<Record<string, unknown>>)[0]?.strategy_provenance as Record<
      string,
      unknown
    >
  ).attempts = [
    { strategy: "stateful-invariant", attempt_index: 0, loop_index: 0 },
    { strategy: "stateful-invariant", attempt_index: 1, loop_index: 1 }
  ];
  assert.throws(
    () => projectCanonicalFinalReport(misattributedObservation),
    /strategy attempts do not exactly preserve authenticated lifecycle strategy hits/u
  );

  const misattributedRates = structuredClone(report);
  const rateProvenance = (misattributedRates.issues as Array<Record<string, unknown>>)[0]
    ?.strategy_provenance as Record<string, unknown>;
  delete rateProvenance.attempts;
  rateProvenance.detection_rates = [
    { strategy: "stateful-invariant", detections: 2, configured_loops: 3 },
    { strategy: "class-goals", detections: 0, configured_loops: 4 }
  ];
  assert.throws(
    () => projectCanonicalFinalReport(misattributedRates),
    /strategy "stateful-invariant" has 1 distinct contributing executions, which does not match 2 detections/u
  );

  const impossibleRate = structuredClone(report);
  (
    (impossibleRate.issues as Array<Record<string, unknown>>)[0]?.strategy_provenance as Record<string, unknown>
  ).detection_rates = [{ strategy: "stateful-invariant", detections: 4, configured_loops: 3 }];
  assert.throws(() => projectCanonicalFinalReport(impossibleRate), /4 detections from only 3 configured executions/u);
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
      projection.markdown.replace("## [L-01] - State mismatch", "## [changed-finding] - State mismatch"),
      projection.report
    ),
    false
  );
  for (const obsoleteLine of [
    "- Strategy loops: `3`",
    `- Prompt digest: \`${"a".repeat(64)}\``,
    "### Strategy\n\n| Strategy | Detection rate |\n| --- | --- |\n| stateful-invariant | 2/3 |"
  ]) {
    assert.equal(
      isDirectiveConformingFinalReportMarkdown(`${projection.markdown}\n${obsoleteLine}\n`, projection.report),
      false,
      obsoleteLine
    );
  }
});

test("directive conformance requires both coverage headings without an opt-out", () => {
  const projection = projectCanonicalFinalReport(renderableReport());
  assert.equal(
    isDirectiveConformingFinalReportMarkdown(
      projection.markdown.replace("## Property implementation coverage", "## Implementation coverage"),
      projection.report
    ),
    false
  );
  assert.equal(
    isDirectiveConformingFinalReportMarkdown(
      projection.markdown,
      projection.report,
      // The requireImplementationCoverage opt-out was removed (issue #702): the coverage heading
      // requirements cannot be waived by any caller.
      // @ts-expect-error a third argument is no longer accepted
      false
    ),
    true
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
  assert.equal(
    isDirectiveConformingFinalReportMarkdown(
      projection.markdown.replace("Prepare the bounded state.", "Prepare the critical invariant state."),
      projection.report
    ),
    true,
    "the unsupported severity label must not ban ordinary explanatory prose"
  );
});

test("directive validation recognizes CommonMark tilde fences and matching closers", () => {
  const projection = projectCanonicalFinalReport(renderableReport());
  const insertProofBlock = (block: string): string =>
    projection.markdown.replace(
      "\n## Property implementation coverage\n",
      `\n${block}\n\n## Property implementation coverage\n`
    );
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
      tildeProof.replace(
        "~~~~   \n\n## Property implementation coverage",
        "~~~~   \n\nCritical\n\n## Property implementation coverage"
      ),
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

test("developer-report directive validation allows private content inside fenced code", () => {
  const projection = projectCanonicalFinalReport(renderableReport());
  const insertProofBlock = (code: string): string =>
    projection.markdown.replace(
      "\n## Property implementation coverage\n",
      `\n~~~text\n${code}\n~~~\n\n## Property implementation coverage\n`
    );

  assert.equal(
    isDirectiveConformingFinalReportMarkdown(insertProofBlock("token=synthetic-tilde-fence-secret"), projection.report),
    true
  );
  assert.equal(
    isDirectiveConformingFinalReportMarkdown(
      insertProofBlock("/home/runner/private/reproducer.sol"),
      projection.report
    ),
    true
  );
});

test("a campaign that never fuzzed is disclosed instead of reading as a clean result", () => {
  const empty = (): Record<string, unknown> => ({
    schema_version: "ultrafuzz.report.v3",
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

test("goal search coverage is rendered into the Markdown report instead of only the JSON", () => {
  const empty = (): Record<string, unknown> => ({
    ...renderableReport(),
    run_metadata: runMetadata("goal-coverage-test"),
    issues: [],
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
  const project = (report: Record<string, unknown>, goalSearchCoverage?: unknown) =>
    projectCanonicalFinalReport(report, { goalSearchCoverage });

  // Every targeted lane searched: an empty findings list is a searched negative.
  const full = project(
    empty(),
    census([
      lane(1, "completed-with-findings"),
      lane(2, "completed-no-findings"),
      lane(3, "completed-no-findings"),
      lane(4, "completed-no-findings", "goal-roaming")
    ])
  );
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
  const partial = project(empty(), census(partialGoals));
  assert.match(
    partial.markdown,
    /\*\*Partial goal search coverage: only 3 of the 77 targeted goal searches completed\.\*\*/u
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
  const partialAndBlocked = project({ ...empty(), campaign_outcome: { outcome: "blocked" } }, census(partialGoals));
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
    const unknown = project(empty(), coverage);
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
  const noLanes = project(empty(), census([], { planned: 0 }));
  assert.match(noLanes.markdown, /\*\*Goal search coverage is unknown\.\*\*/u);

  // A lane count that disagrees with the census summary is disclosed, not silently trusted.
  const inconsistent = project(empty(), census([lane(1, "completed-no-findings")], { planned: 9 }));
  assert.match(inconsistent.markdown, /- Targeted goal search lanes: `1`/u);
  assert.match(inconsistent.markdown, /census summary disagrees with the per-lane record/u);

  // An unrecognized status is a lane, but never a completion.
  const unrecognized = project(empty(), census([lane(1, "completed-no-findings"), lane(2, "invented-status")]));
  assert.match(unrecognized.markdown, /\*\*Partial goal search coverage: only 1 of the 2 targeted goal searches/u);
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
  const roamingOnly = project(empty(), census([lane(1, "completed-no-findings", "goal-roaming")]));
  assert.match(
    roamingOnly.markdown,
    /\*\*No targeted goal search coverage: this run recorded no targeted goal search lanes\.\*\*/u
  );
  assert.match(roamingOnly.markdown, /^No issues were reported, but no targeted goal search lane ran, /mu);
});
