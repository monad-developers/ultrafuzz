import assert from "node:assert/strict";
import test from "node:test";

test("report.md drops the warning and scoped coverage sections while report.json and the companion keep them", () => {
  const report = renderableReport();
  const warnings = [
    {
      code: "ARTIFACT_OPTIONAL_METADATA_MISSING",
      artifact_path: "artifacts/dedupe/strategy-detections.json",
      field_path: "$[5].family_id",
      message: "Optional metadata is missing; the original artifact is accepted unchanged",
      gate: "strategy-detection-review-stage-reconciliation",
      source_path: "artifacts/dedupe/deduped-findings.json#$[5].family_id"
    }
  ];
  (report.run_metadata as Record<string, unknown>).artifact_validation_warnings = warnings;
  report.coverage_evidence = completeCoverageEvidence();
  const before = structuredClone(report);
  const projection = projectCanonicalFinalReport(report);
  assert.doesNotMatch(projection.markdown, /Artifact validation warnings|Scoped coverage evidence/u);
  assert.doesNotMatch(
    projection.markdown,
    /strategy-detections\.json|deduped-findings\.json|declaration-completeness/u
  );
  assert.deepEqual(report, before);
  assert.deepEqual(projection.report, before, "report.json keeps the warnings and the typed coverage evidence");
  const published = projectPublicCanonicalFinalReport(report);
  assert.doesNotMatch(published.markdown, /Artifact validation warnings|Scoped coverage evidence/u);
  assert.deepEqual(
    (published.report.run_metadata as Record<string, unknown>).artifact_validation_warnings,
    projectPublicArtifactValidationWarnings(warnings).warnings
  );
  assert.deepEqual(published.report.coverage_evidence, report.coverage_evidence);
  assertPublicProjectionFixedPoint(published);
  // The warning companions are now the only human-readable form of the warnings, with unchanged bytes.
  assert.equal(
    renderArtifactValidationWarningsMarkdown(warnings),
    "## Artifact validation warnings\n\n" +
      "The run continued with partial metadata. Producer artifacts were preserved unchanged.\n\n" +
      "- ARTIFACT_OPTIONAL_METADATA_MISSING — `artifacts/dedupe/strategy-detections.json#$[5].family_id`: " +
      "Optional metadata is missing; the original artifact is accepted unchanged\n" +
      "  - Available context: `artifacts/dedupe/deduped-findings.json#$[5].family_id`\n"
  );
  const companion = projectPublicArtifactValidationWarnings(warnings);
  assert.match(
    companion.markdown,
    /^## Artifact validation warnings\n\n.*\n\n- ARTIFACT_OPTIONAL_METADATA_MISSING — /u
  );
  assert.deepEqual(projectPublicArtifactValidationWarnings(companion.warnings), companion);
});

import { validateSafeId, type ReportCompletion } from "@ultrafuzz/artifacts";
import { redactSecretsInText } from "@ultrafuzz/security";
import { fromMarkdown } from "mdast-util-from-markdown";

import {
  isDirectiveConformingFinalReportMarkdown,
  projectCanonicalFinalReport,
  projectPublicArtifactValidationWarnings,
  projectPublicCanonicalFinalReport,
  renderArtifactValidationWarningsMarkdown,
  renderCoverageEvidenceMarkdownSection,
  supportsCanonicalFinalReportProjection,
  type CanonicalFinalReportProjection
} from "../src/final-report-markdown.js";

test("public warning companions redact private context and retain the original diagnostics", () => {
  const warnings = [
    {
      code: "ARTIFACT_OPTIONAL_METADATA_MISSING",
      artifact_path: "artifacts/final/report.json",
      field_path: "$.issues[0].summary",
      gate: "report-severity-classification-preservation",
      message: "Optional metadata is missing; token=synthetic-warning-secret",
      source_path: "/srv/customer/private/classified.json#$.summary"
    }
  ];
  const before = structuredClone(warnings);
  const projection = projectPublicArtifactValidationWarnings(warnings);
  assert.match(projection.markdown, /\$\.issues\[0\]\.summary/u);
  assert.doesNotMatch(JSON.stringify(projection), /synthetic-warning-secret|\/srv\/customer/u);
  assert.deepEqual(warnings, before);
  assert.deepEqual(
    projectPublicArtifactValidationWarnings(projection.warnings),
    projection,
    "the public bundle re-projects the companion and requires the same bytes back"
  );
});

const TARGET_COMMIT = "0123456789abcdef0123456789abcdef01234567";

function runMetadata(runId: string): Record<string, unknown> {
  return {
    run_id: runId,
    source_run_id: runId,
    repository: "example/repository",
    target_commit: TARGET_COMMIT,
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

/**
 * The public bundle re-applies the public projection to the published report.json and requires the
 * same JSON and the same report.md bytes back (packages/modal/src/public-bundle.ts), so every
 * public fixture must be a fixed point of the projection.
 */
function assertPublicProjectionFixedPoint(published: CanonicalFinalReportProjection): void {
  const reprojected = projectPublicCanonicalFinalReport(published.report);
  assert.deepEqual(reprojected.report, published.report, "public report.json is not a fixed point of the projection");
  assert.equal(reprojected.markdown, published.markdown, "public report.md changes when report.json is re-projected");
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

function unavailableCoverageEvidence(): Record<string, unknown> {
  return {
    schema_version: "ultrafuzz.coverage-evidence.v1",
    status: "unavailable",
    blockers: [
      {
        category: "coverage-tooling-blocked",
        summary: "Recon could not produce an authenticated coverage map.",
        evidence_paths: ["logs/recon-coverage.log"]
      }
    ]
  };
}

/** Measured evidence over one production file with `covered` of its two selected ranges covered. */
function measuredCoverageEvidence(covered: 1 | 2): Record<string, unknown> {
  return {
    schema_version: "ultrafuzz.coverage-evidence.v1",
    status: "measured",
    lcov: { path: "coverage-input.lcov", sha256: "e".repeat(64) },
    recon_selection: { path: "recon-coverage.json", sha256: "f".repeat(64) },
    views: [
      { scope: "recon-selected-declaration-completeness", covered_ranges: covered, total_ranges: 2 },
      { scope: "production-declaration-completeness", covered_ranges: covered, total_ranges: 2 }
    ],
    files: [{ path: "src/Core.sol", kind: "production", included: true, covered_ranges: covered, total_ranges: 2 }],
    counted_ranges: [1, 2].map((line) => ({
      file: "src/Core.sol",
      kind: "production",
      start_line: line,
      line_count: 1,
      selected: true,
      covered: line <= covered
    })),
    zero_coverage_components:
      covered === 2 ? [] : [{ path: "src/Core.sol", kind: "production", start_line: 2, line_count: 1 }]
  };
}

function completeCoverageEvidence(): Record<string, unknown> {
  return measuredCoverageEvidence(2);
}

const COVERAGE_UNMEASURED_NOTICE =
  "Scoped coverage could not be measured for this run, so how much of the in-scope code the campaign exercised is unknown.";
const COVERAGE_INCOMPLETE_NOTICE =
  "Scoped coverage was measured, but the campaign did not exercise every in-scope declaration; uncovered code may contain issues this report does not show.";
const REMEDIATION_UNRECORDED_NOTICE =
  "No remediation was recorded for this finding, and Ultrafuzz does not infer one. Confirm the root cause in the description and Proof of Concept before designing a fix.";

function partialCompletion(runId = "projection-test"): ReportCompletion {
  return {
    schema_version: "ultrafuzz.report-completion.v1",
    run_id: runId,
    outcome: "partial",
    counts: { planned: 8, succeeded: 2, failed: 2, timed_out: 1, skipped: 1, cancelled: 1, unverified: 1 },
    incomplete_nodes: [
      { node_id: "failed-node", outcome: "failed", failure_category: "task-failure" },
      { node_id: "refused-node", outcome: "failed", failure_category: "refused" },
      { node_id: "timed-out-node", outcome: "timed_out", failure_category: "timeout" },
      { node_id: "skipped-node", outcome: "skipped", failure_category: "dependency" },
      { node_id: "cancelled-node", outcome: "cancelled", failure_category: "cancelled" },
      { node_id: "unverified-node", outcome: "unverified", failure_category: "unverified" }
    ],
    incomplete_nodes_omitted: 0
  };
}

function uncheckedReport(): Record<string, unknown> {
  return {
    ...renderableReport(),
    verification: { status: "not-checked", reason_codes: ["record-missing"] },
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
      },
      incomplete_nodes: [
        { node_id: "failed-task", outcome: "failed" },
        { node_id: "missing-result", outcome: "unverified" }
      ],
      incomplete_nodes_omitted: null
    },
    issues: [],
    non_production_outcomes: [],
    property_provenance: [],
    property_implementation_coverage: { status: "not-planned", reason: "property-implementation-track-not-declared" }
  };
}

test("unchecked agent reports disclose unknown observations", () => {
  const report = uncheckedReport();
  const projection = projectCanonicalFinalReport(report);
  assert.match(
    projection.markdown,
    /^# Ultrafuzz report — PARTIAL\n\n> \*\*PARTIAL REPORT — verification not checked/u
  );
  assert.match(projection.markdown, /- Verification: `not-checked`/u);
  assert.match(projection.markdown, /- Planned nodes: `unknown`\n- Succeeded nodes: `80`\n- Failed nodes: `20`/u);
  assert.match(projection.markdown, /- Cancelled nodes: `0`\n- Unverified nodes: `unknown`/u);
  assert.match(projection.markdown, /\| `failed-task` \| `failed` \|/u);
  assert.match(projection.markdown, /\| `missing-result` \| `unverified` \|/u);
  assert.match(projection.markdown, /Additional observed incomplete node identities omitted: `unknown`/u);
  assert.match(projection.markdown, /No final findings are included/u);
  assert.doesNotMatch(
    projection.markdown,
    /available verified results|^No issues reported\.$|\| Issue id \| Title \|/mu
  );
  assert.deepEqual(projection.report, report);
  assert.equal(isDirectiveConformingFinalReportMarkdown(projection.markdown, report), true);
  assert.deepEqual(projectCanonicalFinalReport(report), projection);
  assertPublicProjectionFixedPoint(projectPublicCanonicalFinalReport(report));
});

test("unchecked reports retain renderable final findings under a global verification warning", () => {
  const report = {
    ...renderableReport(),
    verification: uncheckedReport().verification,
    observed_completion: uncheckedReport().observed_completion
  };
  const projection = projectCanonicalFinalReport(report);
  assert.match(projection.markdown, /PARTIAL REPORT — verification not checked/u);
  assert.match(projection.markdown, /## \[L-01\] - State mismatch/u);
  assert.doesNotMatch(projection.markdown, /No final findings are included|available verified results/u);
  assert.deepEqual(projection.report, report);
  assert.equal(isDirectiveConformingFinalReportMarkdown(projection.markdown, report), true);
});

test("unchecked reports explain missing checks in plain language while retaining structured reason codes", () => {
  const report = uncheckedReport();
  report.verification = {
    status: "not-checked",
    reason_codes: [
      "verification-unavailable",
      "record-missing",
      "record-invalid",
      "result-unreadable",
      "results-truncated"
    ]
  };
  const projection = projectCanonicalFinalReport(report);
  for (const explanation of [
    "Run and output verification could not be completed.",
    "Some saved run records are missing.",
    "Some saved run records did not pass the required checks.",
    "Some output files could not be read.",
    "Some available results were omitted because a file, item, or size limit was reached."
  ]) {
    assert.ok(projection.markdown.includes(`- ${explanation}`));
    assert.equal(isDirectiveConformingFinalReportMarkdown(projection.markdown.replace(explanation, ""), report), false);
  }
  assert.doesNotMatch(
    projection.markdown,
    /verification-unavailable|record-missing|record-invalid|result-unreadable|result-not-reviewed|results-truncated/u
  );
  assert.deepEqual(projection.report.verification, report.verification);
  assert.equal(isDirectiveConformingFinalReportMarkdown(projection.markdown, report), true);
});

test("unchecked completion disclosures cannot be removed or changed independently", () => {
  const projection = projectCanonicalFinalReport(uncheckedReport());
  for (const markdown of [
    projection.markdown.replace("report — PARTIAL", "report"),
    projection.markdown.replace("- Verification: `not-checked`", "- Verification: `checked`"),
    projection.markdown.replace("- Planned nodes: `unknown`", "- Planned nodes: `100`"),
    projection.markdown.replace("| `failed-task` | `failed` |", ""),
    `${projection.markdown}\nNo issues reported.\n`
  ])
    assert.equal(isDirectiveConformingFinalReportMarkdown(markdown, projection.report), false);
  assert.equal(
    isDirectiveConformingFinalReportMarkdown(projection.markdown, {
      ...projection.report,
      completion: partialCompletion()
    }),
    false
  );
});

test("partial completion is prominent and preserves verified findings and the exact census", () => {
  const input = renderableReport();
  const original = projectCanonicalFinalReport(input);
  input.completion = partialCompletion();
  const before = structuredClone(input);
  const projection = projectCanonicalFinalReport(input);

  assert.match(projection.markdown, /^# Ultrafuzz report — PARTIAL\n\n> \*\*PARTIAL REPORT/u);
  assert.ok(projection.markdown.indexOf("PARTIAL REPORT") < projection.markdown.indexOf("| Issue id | Title |"));
  assert.ok(projection.markdown.indexOf("## Run completion") < projection.markdown.indexOf("## [L-01]"));
  for (const [label, count] of [
    ["Planned", 8],
    ["Succeeded", 2],
    ["Failed", 2],
    ["Timed-out", 1],
    ["Skipped", 1],
    ["Cancelled", 1],
    ["Unverified", 1]
  ] as const) {
    assert.ok(projection.markdown.includes(`- ${label} nodes: \`${count}\``));
  }
  assert.match(projection.markdown, /\| `refused-node` \| `failed` \| `refused` \|/u);
  assert.match(projection.markdown, /\| `skipped-node` \| `skipped` \| `dependency` \|/u);
  assert.match(projection.markdown, /missing results are coverage gaps/u);
  assert.match(projection.markdown, /They do not establish full audit coverage or a clean security result/u);
  assert.deepEqual(projection.report, before);
  assert.deepEqual(input, before);
  assert.equal(
    projection.markdown.slice(projection.markdown.indexOf("## [L-01]")),
    original.markdown.slice(original.markdown.indexOf("## [L-01]")),
    "adding a completion census must not rewrite any finding or existing coverage evidence"
  );
  assert.deepEqual(projectCanonicalFinalReport(projection.report), projection);
  assert.equal(isDirectiveConformingFinalReportMarkdown(projection.markdown, projection.report), true);
});

test("completion identity disclosure stays bounded and states how many identities are omitted", () => {
  const completion = partialCompletion();
  completion.counts = {
    planned: 259,
    succeeded: 2,
    failed: 257,
    timed_out: 0,
    skipped: 0,
    cancelled: 0,
    unverified: 0
  };
  completion.incomplete_nodes = Array.from({ length: 256 }, (_unused, index) => ({
    node_id: `incomplete-node-${index}`,
    outcome: "failed",
    failure_category: "task-failure"
  }));
  completion.incomplete_nodes_omitted = 1;
  const projection = projectCanonicalFinalReport({ ...renderableReport(), completion });
  assert.match(projection.markdown, /- Failed nodes: `257`/u);
  assert.equal(projection.markdown.split("\n").filter((line) => line.startsWith("| `incomplete-node-")).length, 256);
  assert.match(projection.markdown, /Additional incomplete node identities omitted from this bounded census: `1`/u);
  assert.deepEqual(projection.report.completion, completion);
});

test("a complete census retains the normal title and reports every count", () => {
  const completion = partialCompletion();
  completion.outcome = "complete";
  completion.counts = { planned: 8, succeeded: 8, failed: 0, timed_out: 0, skipped: 0, cancelled: 0, unverified: 0 };
  completion.incomplete_nodes = [];
  const input = { ...renderableReport(), completion, issues: [], property_provenance: [] };
  const projection = projectCanonicalFinalReport(input);
  assert.match(projection.markdown, /^# Ultrafuzz report\n/u);
  assert.doesNotMatch(projection.markdown, /PARTIAL|Incomplete nodes:/u);
  assert.match(projection.markdown, /- Outcome: `complete`/u);
  assert.match(projection.markdown, /- Planned nodes: `8`\n- Succeeded nodes: `8`\n- Failed nodes: `0`/u);
  assert.match(projection.markdown, /^No issues reported\.$/mu);
  assert.deepEqual(projection.report, input);
  assert.equal(isDirectiveConformingFinalReportMarkdown(projection.markdown, projection.report), true);
  assert.equal(
    isDirectiveConformingFinalReportMarkdown(
      projection.markdown.replace("## Run completion", "## Completion"),
      projection.report
    ),
    false
  );
});

test("empty findings in a partial run explicitly disclaim a clean result", () => {
  const projection = projectCanonicalFinalReport({
    ...renderableReport(),
    completion: partialCompletion(),
    issues: [],
    property_provenance: []
  });
  assert.match(projection.markdown, /^# Ultrafuzz report — PARTIAL$/mu);
  assert.match(projection.markdown, /No production issues were reported from the available verified results\./u);
  assert.match(projection.markdown, /This partial report is not a clean result/u);
  assert.doesNotMatch(projection.markdown, /^No issues reported\.$/mu);
  assert.equal(isDirectiveConformingFinalReportMarkdown(projection.markdown, projection.report), true);
  for (const markdown of [
    projection.markdown.replace(/^No production issues[^\n]+$/mu, "No issues reported."),
    projection.markdown.replace(/^No production issues[^\n]+\n/mu, ""),
    `${projection.markdown}\nNo issues reported.\n`
  ]) {
    assert.equal(isDirectiveConformingFinalReportMarkdown(markdown, projection.report), false);
  }
});

test("directive validation requires the exact partial title, banner, census and identities", () => {
  const projection = projectCanonicalFinalReport({ ...renderableReport(), completion: partialCompletion() });
  const banner = projection.markdown.split("\n").find((line) => line.startsWith("> **PARTIAL REPORT"));
  assert.ok(banner);
  const mutations = [
    projection.markdown.replace("# Ultrafuzz report — PARTIAL", "# Ultrafuzz report"),
    projection.markdown.replace("# Ultrafuzz report — PARTIAL", "# Ultrafuzz report — partial"),
    projection.markdown.replace(`${banner}\n\n`, ""),
    `${projection.markdown.replace(`${banner}\n\n`, "")}\n${banner}\n`,
    projection.markdown.replace("coverage is incomplete", "coverage is complete"),
    projection.markdown.replace("## Run completion", "## Completion"),
    projection.markdown.replace("- Failed nodes: `2`", "- Failed nodes: `0`"),
    projection.markdown.replace("| `refused-node` | `failed` | `refused` |", ""),
    projection.markdown.replace(
      "| `refused-node` | `failed` | `refused` |",
      "| `refused-node` | `failed` | `task-failure` |"
    ),
    projection.markdown.replace("bounded census: `0`", "bounded census: `1`"),
    `${projection.markdown}\n## Run completion\n\n- Outcome: \`complete\`\n`
  ];
  for (const markdown of mutations) {
    assert.equal(isDirectiveConformingFinalReportMarkdown(markdown, projection.report), false);
  }
  const { completion: _completion, ...withoutCompletion } = projection.report;
  assert.equal(isDirectiveConformingFinalReportMarkdown(projection.markdown, withoutCompletion), false);
});

test("rendering and standalone directive validation reject inconsistent completion claims", () => {
  const input = { ...renderableReport(), completion: partialCompletion() };
  const projection = projectCanonicalFinalReport(input);
  const inconsistent = structuredClone(input);
  inconsistent.completion.counts.succeeded += 1;
  assert.throws(() => projectCanonicalFinalReport(inconsistent), /count|planned|sum/iu);
  assert.equal(isDirectiveConformingFinalReportMarkdown(projection.markdown, inconsistent), false);
  const wrongRun = structuredClone(input);
  wrongRun.completion.run_id = "different-run";
  assert.throws(() => projectCanonicalFinalReport(wrongRun), /completion run ID does not match/iu);
  assert.equal(isDirectiveConformingFinalReportMarkdown(projection.markdown, wrongRun), false);
});

test("public partial reports redact distinct private identities and preserve census counts as a fixed point", () => {
  const runId = "ci-33918585561-1-smoke-ultrafuzz-benc-3e994a685ad7bf44";
  const input = renderableReport();
  input.run_metadata = runMetadata(runId);
  const completion = partialCompletion(runId);
  const secretIds = ["sk-abcdefghijklmnopqrstuvwx", "sk-zyxwvutsrqponmlkjihgfedc"]; // gitleaks:allow -- fake credential fixtures
  for (const [index, secretId] of secretIds.entries()) {
    assert.notEqual(redactSecretsInText(secretId), secretId, "the synthetic node ID must trigger redaction");
    const node = completion.incomplete_nodes[index];
    assert.ok(node);
    node.node_id = secretId;
  }
  const retainedNode = completion.incomplete_nodes[2];
  assert.ok(retainedNode);
  retainedNode.node_id = "redacted-node-1";
  input.completion = completion;
  const before = structuredClone(input);
  const published = projectPublicCanonicalFinalReport(input);
  const publicCompletion = published.report.completion as ReportCompletion;

  assert.equal(publicCompletion.run_id, runId);
  assert.deepEqual(publicCompletion.counts, completion.counts);
  assert.equal(publicCompletion.incomplete_nodes.length, completion.incomplete_nodes.length);
  assert.equal(new Set(publicCompletion.incomplete_nodes.map((node) => node.node_id)).size, 6);
  assert.equal(publicCompletion.incomplete_nodes[2]?.node_id, "redacted-node-1", "unchanged identities stay intact");
  for (const secretId of secretIds) assert.equal(JSON.stringify(published).includes(secretId), false);
  assert.doesNotMatch(JSON.stringify(published), /synthetic-final-report-secret|\/home\/runner\/private/u);
  assert.match(published.markdown, /^# Ultrafuzz report — PARTIAL\n/u);
  assert.deepEqual(input, before);
  assert.equal(isDirectiveConformingFinalReportMarkdown(published.markdown, published.report), true);
  assertPublicProjectionFixedPoint(published);
});

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
  assertPublicProjectionFixedPoint(published);
});

test("public final-report projection redacts secrets with a placeholder the bundle can republish", () => {
  const token = "ghp_AbCdEf1234567890AbCdEf1234567890AbCd"; // gitleaks:allow -- fake credential fixture for the redaction tests
  const apiKey = "sk-abcdefghijklmnopqrstuvwx"; // gitleaks:allow -- fake credential fixture for the redaction tests
  const cloneUrl = "https://deploy:hunter2hunter2@github.com/example/repository"; // gitleaks:allow -- fake credential fixture for the redaction tests
  const input = renderableReport();
  const [issue] = input.issues as Array<Record<string, unknown>>;
  if (issue === undefined) throw new Error("missing issue fixture");
  // Three shapes the earlier placeholders broke on: a key-name assignment (`token=[redacted]`
  // re-projects to `token=[redacted]]` because `]` ends the value class), a positive secret directly
  // followed by `(` (`[redacted](` reads as a Markdown link), and a positive secret in an inline-code
  // run summary value (`<redacted>` reads as raw HTML).
  issue.description =
    `A caller signed the transition with ${token} after cloning ${cloneUrl}; ` +
    `the key ${apiKey}(since rotated) was also accepted. ` +
    "token=synthetic-final-report-secret stays private and the reproducer is at /srv/customer/private/reproducer.sol.";
  (issue.proof_of_concept as Record<string, unknown>).scenario = [
    `Authenticate with ${token}.`,
    "Execute the transition and observe the mismatch."
  ];
  (input.run_metadata as Record<string, unknown>).repository =
    `https://x-access-token:${token}@github.com/example/repository`;
  const before = structuredClone(input);

  // Finding prose keeps an underscore between two letters raw, so the developer Markdown carries the
  // exact token; the public checks below use the token body, which no escape can split.
  const tokenBody = token.slice("ghp_".length);
  const internal = projectCanonicalFinalReport(input);
  assert.deepEqual(input, before);
  assert.deepEqual(internal.report, before);
  assert.equal(JSON.stringify(internal.report).includes(token), true, "the developer report keeps the token");
  assert.equal(internal.markdown.includes(token), true);
  assert.equal(internal.markdown.includes(apiKey), true);
  assert.equal(internal.markdown.includes(cloneUrl), true);
  assert.doesNotMatch(internal.markdown, /REDACTED|\[redacted\]|<redacted>|\[redacted-path\]/u);

  const published = projectPublicCanonicalFinalReport(input);
  const publishedJson = JSON.stringify(published.report);
  assert.deepEqual(input, before);
  assert.equal(publishedJson.includes(tokenBody), false);
  assert.equal(publishedJson.includes(apiKey), false);
  assert.equal(publishedJson.includes("hunter2hunter2"), false);
  assert.doesNotMatch(publishedJson, /<redacted>|\[redacted\]|synthetic-final-report-secret|\/srv\/customer\/private/u);
  assert.match(publishedJson, /token=REDACTED stays private/u);
  assert.match(publishedJson, /the key REDACTED\(since rotated\)/u);
  assert.match(publishedJson, /\[redacted-path\]/u);
  assert.equal(published.markdown.includes(tokenBody), false);
  assert.equal(published.markdown.includes(apiKey), false);
  assert.equal(published.markdown.includes("hunter2hunter2"), false);
  assert.doesNotMatch(published.markdown, /<redacted>|&lt;redacted&gt;|\[redacted\]|synthetic-final-report-secret/u);
  // secretlint's basicauth rule replaces the whole `scheme://user:password@host` authority.
  assert.match(published.markdown, /^- Repository: `REDACTED\/example\/repository`$/mu);
  assert.match(published.markdown, /signed the transition with REDACTED after cloning/u);
  assert.match(published.markdown, /the key REDACTED\(since rotated\) was also accepted/u);
  assert.match(published.markdown, /^1\. Authenticate with REDACTED\.$/mu);
  assert.match(published.markdown, /\[redacted-path\]/u);
  assert.equal(isDirectiveConformingFinalReportMarkdown(published.markdown, published.report), true);
  assert.deepEqual(projectCanonicalFinalReport(published.report), published);
  assertPublicProjectionFixedPoint(published);
  assert.equal(
    isDirectiveConformingFinalReportMarkdown(published.markdown.replace("`REDACTED", "`<redacted>"), published.report),
    false,
    "the raw-HTML gate still rejects the default placeholder in inline code"
  );
});

test("public final-report projection keeps machine-generated run IDs the entropy pass would redact", () => {
  // Bounded eval run IDs from UltraFuzzBench smoke run 33918585561 (boundedEvalWorkflowRunId). The
  // public bundle requires report.json to repeat the run ID from its run records, so redacting these
  // fails publication for every smoke row.
  const runId = "ci-33918585561-1-smoke-ultrafuzz-benc-3e994a685ad7bf44";
  const sourceRunId = "ci-33918585561-1-smoke-ultrafuzz-benc-7d622d2207767a8d";
  for (const id of [runId, sourceRunId]) {
    assert.equal(validateSafeId(id), id);
    assert.notEqual(
      redactSecretsInText(id, "<redacted>", [], "all"),
      id,
      `${id} must be a speculative high-entropy candidate for this test to mean anything`
    );
    assert.equal(redactSecretsInText(id, "<redacted>", [], "positive-only"), id);
  }
  const input = renderableReport();
  input.run_metadata = { ...runMetadata(runId), source_run_id: sourceRunId };
  const before = structuredClone(input);

  const published = projectPublicCanonicalFinalReport(input);
  assert.deepEqual(input, before);
  const metadata = published.report.run_metadata as Record<string, unknown>;
  assert.equal(metadata.run_id, runId);
  assert.equal(metadata.source_run_id, sourceRunId);
  assert.match(published.markdown, /^- Run ID: `ci-33918585561-1-smoke-ultrafuzz-benc-3e994a685ad7bf44`$/mu);
  // Lineage stays in report.json only; the Markdown summary names the evaluated commit instead.
  assert.equal(published.markdown.includes(sourceRunId), false);
  assert.match(published.markdown, new RegExp(`^- Commit: \`${TARGET_COMMIT}\`$`, "mu"));
  assert.match(JSON.stringify(published.report), /token=REDACTED/u, "every other field still scans in full");
  assert.equal(isDirectiveConformingFinalReportMarkdown(published.markdown, published.report), true);
  assert.deepEqual(projectCanonicalFinalReport(published.report), published);
  assertPublicProjectionFixedPoint(published);
});

test("the Run summary names the evaluated commit and keeps run lineage in report.json only", () => {
  assert.notEqual(
    redactSecretsInText(TARGET_COMMIT, "REDACTED", [], "all"),
    TARGET_COMMIT,
    "a bare SHA-1 commit must be a generic-hex redaction candidate for this test to mean anything"
  );
  const commit = TARGET_COMMIT;
  const input = renderableReport();
  input.run_metadata = {
    ...runMetadata("commit-run"),
    source_run_id: "commit-source-run",
    source_run_ids: ["commit-source-run"],
    target_commit: commit
  };
  const before = structuredClone(input);
  const projection = projectCanonicalFinalReport(input);
  assert.deepEqual(projection.report, before);
  assert.ok(projection.markdown.includes(`\n## Run summary\n\n${summaryBullets(commit)}\n\n`), projection.markdown);
  assert.doesNotMatch(projection.markdown, /Source run ID|commit-source-run/u);

  const published = projectPublicCanonicalFinalReport(input);
  assert.deepEqual(input, before);
  const metadata = published.report.run_metadata as Record<string, unknown>;
  assert.equal(metadata.target_commit, commit, "the public projection must not redact the evaluated commit");
  assert.equal(metadata.source_run_id, "commit-source-run");
  assert.deepEqual(metadata.source_run_ids, ["commit-source-run"]);
  assert.match(published.markdown, new RegExp(`^- Commit: \`${commit}\`$`, "mu"));
  assert.doesNotMatch(published.markdown, /Source run ID|commit-source-run/u);
  assert.equal(isDirectiveConformingFinalReportMarkdown(published.markdown, published.report), true);
  assert.deepEqual(projectCanonicalFinalReport(published.report), published);
  assertPublicProjectionFixedPoint(published);
});

test("the Run summary states when no Git commit was recorded for the evaluated target", () => {
  const input = renderableReport();
  input.run_metadata = { ...runMetadata("no-commit-run"), target_commit: null };
  const projection = projectCanonicalFinalReport(input);
  assert.match(projection.markdown, /^- Commit: `none` \(no Git commit was recorded for the evaluated target\)$/mu);
  assert.equal(projection.markdown.match(/^- Commit: /gmu)?.length, 1);
  assert.equal((projection.report.run_metadata as Record<string, unknown>).target_commit, null);
  const published = projectPublicCanonicalFinalReport(input);
  assert.equal((published.report.run_metadata as Record<string, unknown>).target_commit, null);
  assert.match(published.markdown, /^- Commit: `none` \(no Git commit was recorded for the evaluated target\)$/mu);
  assertPublicProjectionFixedPoint(published);
});

test("the Run summary rejects a stale Source run ID row, a missing Commit row, and reordered rows", () => {
  const projection = projectCanonicalFinalReport(renderableReport());
  const commitRow = `- Commit: \`${TARGET_COMMIT}\`\n`;
  const repositoryRow = "- Repository: `example/repository`\n";
  assert.ok(projection.markdown.includes(`${repositoryRow}${commitRow}`));
  assert.equal(isDirectiveConformingFinalReportMarkdown(projection.markdown, projection.report), true);
  for (const markdown of [
    projection.markdown.replace(repositoryRow, `- Source run ID: \`projection-test\`\n${repositoryRow}`),
    projection.markdown.replace(commitRow, "- Source run ID: `projection-test`\n"),
    projection.markdown.replace(commitRow, ""),
    projection.markdown.replace(`${repositoryRow}${commitRow}`, `${commitRow}${repositoryRow}`),
    projection.markdown.replace(commitRow, `${commitRow}- Dirty: \`false\`\n`)
  ]) {
    assert.notEqual(markdown, projection.markdown);
    assert.equal(isDirectiveConformingFinalReportMarkdown(markdown, projection.report), false, markdown);
  }
});

test("the Run summary renders the spend as a numeric estimate and rejects an unavailable or annotated spend", () => {
  for (const amount of ["$0.00", "$0.0042", "$12.35", "$1234567.1234567891"]) {
    for (const [estimatedSpend, partialPricing] of [
      [amount, false],
      [`${amount}+`, true]
    ] as const) {
      const input = renderableReport();
      input.run_metadata = {
        ...runMetadata("spend-run"),
        estimated_spend: estimatedSpend,
        partial_pricing: partialPricing
      };
      const projection = projectCanonicalFinalReport(input);
      assert.equal(
        projection.markdown
          .split("\n")
          .filter((line) => line.startsWith("- Estimated spend: "))
          .join("\n"),
        `- Estimated spend: \`${estimatedSpend}\``
      );
      // partial_pricing stays in report.json and is never rendered.
      assert.doesNotMatch(projection.markdown, /partial.pricing/iu);
      assert.equal(isDirectiveConformingFinalReportMarkdown(projection.markdown, projection.report), true);
      assertPublicProjectionFixedPoint(projectPublicCanonicalFinalReport(input));
    }
  }
  for (const [estimatedSpend, partialPricing] of [
    ["$1.00+", false],
    ["$1.00", true],
    ["unavailable", false],
    ["unavailable", true],
    ["$1", false],
    ["1.00", false],
    ["$01.00", false],
    ["$1.00++", true]
  ] as const) {
    const input = renderableReport();
    input.run_metadata = {
      ...runMetadata("spend-run"),
      estimated_spend: estimatedSpend,
      partial_pricing: partialPricing
    };
    assert.throws(() => projectCanonicalFinalReport(input), /estimated_spend/u, estimatedSpend);
  }
  // The Markdown directive complements the schema: a hand-edited spend row cannot pass either.
  const projection = projectCanonicalFinalReport(renderableReport());
  const spendRow = "- Estimated spend: `$0.01`\n";
  assert.ok(projection.markdown.includes(spendRow));
  for (const replacement of [
    "- Estimated spend: `$0.01+`\n",
    "- Estimated spend: `$0.02`\n",
    "- Estimated spend: `unavailable`\n",
    "- Estimated spend: $0.01\n",
    "- Estimated spend: `$0.01` (partial)\n"
  ]) {
    const markdown = projection.markdown.replace(spendRow, replacement);
    assert.equal(isDirectiveConformingFinalReportMarkdown(markdown, projection.report), false, replacement);
  }
});

test("the Run summary spend ends in + when usage was not recorded or could not be priced", () => {
  const usageLines = (metadata: Record<string, unknown>) => {
    const input = renderableReport();
    input.run_metadata = { ...runMetadata("spend-run"), ...metadata };
    const projection = projectCanonicalFinalReport(input);
    assert.equal(isDirectiveConformingFinalReportMarkdown(projection.markdown, projection.report), true);
    // The counts stay in report.json; report.md never states them.
    assert.doesNotMatch(projection.markdown, /excludes|agent attempt|attempts_without_usage|unpriced/iu);
    return projection.markdown
      .split("\n")
      .filter((line) => /^- (?:Models used|Tokens used|Estimated spend):/u.test(line));
  };
  // All usage recorded and priced, whether by a recorded charge, the catalog or the fallback table.
  assert.deepEqual(usageLines({ estimated_spend: "$38.72" }), [
    "- Models used: `model-a`",
    "- Tokens used: `100`",
    "- Estimated spend: `$38.72`"
  ]);
  // Attempts without usage, recorded usage that could not be priced, and partial pricing each mean
  // there is probably more.
  assert.equal(
    usageLines({ estimated_spend: "$38.72+", attempts_without_usage: 2, unpriced_attempts: 1 }).at(-1),
    "- Estimated spend: `$38.72+`"
  );
  assert.equal(
    usageLines({ estimated_spend: "$38.72+", attempts_without_usage: 1 }).at(-1),
    "- Estimated spend: `$38.72+`"
  );
  assert.equal(
    usageLines({ estimated_spend: "$0.0008+", unpriced_attempts: 2 }).at(-1),
    "- Estimated spend: `$0.0008+`"
  );
  assert.equal(
    usageLines({ estimated_spend: "$38.72+", partial_pricing: true }).at(-1),
    "- Estimated spend: `$38.72+`"
  );
  // Nothing recorded at all: no model, zero tokens, zero spend, never `unavailable`.
  assert.deepEqual(
    usageLines({ models_used: [], tokens_used: "0", estimated_spend: "$0.00+", attempts_without_usage: 5 }),
    ["- Models used: `none` (no model usage was recorded)", "- Tokens used: `0`", "- Estimated spend: `$0.00+`"]
  );
  assert.deepEqual(usageLines({ models_used: [], tokens_used: "0", estimated_spend: "$0.00" }), [
    "- Models used: `none` (no model usage was recorded)",
    "- Tokens used: `0`",
    "- Estimated spend: `$0.00`"
  ]);
  // The `+` must agree with the counts, which are positive integers.
  for (const metadata of [
    { estimated_spend: "$38.72", attempts_without_usage: 2 },
    { estimated_spend: "$38.72", unpriced_attempts: 1 },
    { estimated_spend: "$38.72+" }
  ]) {
    const input = renderableReport();
    input.run_metadata = { ...runMetadata("spend-run"), ...metadata };
    assert.throws(() => projectCanonicalFinalReport(input), /estimated_spend/u, JSON.stringify(metadata));
  }
  for (const count of [0, 1.5, "1"]) {
    const input = renderableReport();
    input.run_metadata = { ...runMetadata("spend-run"), estimated_spend: "$0.01+", attempts_without_usage: count };
    assert.throws(() => projectCanonicalFinalReport(input), /attempts_without_usage/u, String(count));
  }

  // A hand-edited spend row cannot pass the Markdown directive.
  const input = renderableReport();
  input.run_metadata = { ...runMetadata("spend-run"), estimated_spend: "$0.01+", attempts_without_usage: 3 };
  const projection = projectCanonicalFinalReport(input);
  const spendRow = "- Estimated spend: `$0.01+`\n";
  assert.ok(projection.markdown.includes(spendRow));
  for (const replacement of [
    "- Estimated spend: `$0.01`\n",
    "- Estimated spend: `$0.01++`\n",
    "- Estimated spend: `unavailable`\n",
    "- Estimated spend: `$0.01+` (3 agent attempts recorded no usage)\n",
    "- Estimated spend: `$0.01`+\n"
  ]) {
    const markdown = projection.markdown.replace(spendRow, replacement);
    assert.equal(isDirectiveConformingFinalReportMarkdown(markdown, projection.report), false, replacement);
  }
});

function summaryBullets(commit: string): string {
  return [
    "- Run ID: `commit-run`",
    "- Repository: `example/repository`",
    `- Commit: \`${commit}\``,
    "- Elapsed time: `1m`",
    "- Models used: `model-a`",
    "- Tokens used: `100`",
    "- Estimated spend: `$0.01`",
    "- Audit profile: `exhaustive`"
  ].join("\n");
}

test("public final-report projection still redacts a vendor-format credential in a run ID slot", () => {
  const credentialId = "sk-abcdefghijklmnopqrstuvwx"; // gitleaks:allow -- fake credential fixture for the redaction tests
  assert.equal(validateSafeId(credentialId), credentialId, "the ID slot accepts this shape");
  const input = renderableReport();
  input.run_metadata = runMetadata(credentialId);
  const before = structuredClone(input);

  const published = projectPublicCanonicalFinalReport(input);
  assert.deepEqual(input, before);
  const metadata = published.report.run_metadata as Record<string, unknown>;
  assert.equal(metadata.run_id, "REDACTED");
  assert.equal(metadata.source_run_id, "REDACTED");
  assert.equal(JSON.stringify(published.report).includes(credentialId), false);
  assert.equal(published.markdown.includes(credentialId), false);
  assert.match(published.markdown, /^- Run ID: `REDACTED`$/mu);
  assert.doesNotMatch(published.markdown, /Source run ID/u);
  assert.equal(metadata.target_commit, TARGET_COMMIT);
  assert.equal(isDirectiveConformingFinalReportMarkdown(published.markdown, published.report), true);
  assertPublicProjectionFixedPoint(published);
});

test("public final-report projection collapses duplicates that redaction creates in unique arrays", () => {
  // UltraFuzzBench smoke run 33933691679 (issue #1028): the internal report passed the schema and the
  // public copy failed `issues/0/affected_files: must NOT have duplicate items`. Redaction maps every
  // private path to `[redacted-path]` and every flagged string to the placeholder, so two distinct
  // entries of one array collapse to one value and the schema's unique arrays reject the public copy.
  const token = "ghp_AbCdEf1234567890AbCdEf1234567890AbCd"; // gitleaks:allow -- fake credential fixture for the redaction tests
  const privateFiles = ["/root/workspace/target/src/Vault.sol", "/root/workspace/target/src/Token.sol"];
  const privatePatches = [
    "/root/workspace/target/patches/vault.patch",
    "patches/fix.patch",
    "/root/workspace/target/patches/token.patch"
  ];
  // Ordinary long repository paths and qualified function names that the speculative high-entropy
  // pass flags in mode "all" (32+ characters, three character classes, entropy >= 4.3), around a
  // short entry it keeps.
  const keptFile = "src/Vault.sol";
  const keptFunction = "Vault.deposit";
  const flaggedFiles = [
    "contracts/mocks/MockOracleAggregatorWithTimestampSkew.sol",
    keptFile,
    "contracts/mocks/MockOracleAggregatorWithoutTimestampSkew.sol"
  ];
  const flaggedFunctions = [
    "UniswapV3TwapOracleAdapterWithFallback.consultTwapPrice",
    keptFunction,
    "MockOracleAggregatorWithTimestampSkew.latestRoundData"
  ];
  for (const value of [...flaggedFiles, ...flaggedFunctions]) {
    const flagged = redactSecretsInText(value, "REDACTED", [], "all") !== value;
    assert.equal(
      flagged,
      value !== keptFile && value !== keptFunction,
      `the speculative high-entropy pass must ${flagged ? "keep" : "flag"} ${value} for this test to mean anything`
    );
  }

  const input = renderableReport();
  const [first] = input.issues as Array<Record<string, unknown>>;
  if (first === undefined) throw new Error("missing issue fixture");
  first.affected_files = [...privateFiles];
  first.patch_refs = [...privatePatches];
  first.affected_functions = ["deposit", "withdraw"];
  const second = structuredClone(first);
  delete second.patch_refs;
  Object.assign(second, {
    id: "L-02",
    title: "[L-02] - Stale oracle round",
    affected_files: [...flaggedFiles],
    affected_functions: [...flaggedFunctions],
    lifecycle: { ...(first.lifecycle as Record<string, unknown>), dedupe_key: "stale-oracle-round" },
    proof_of_concept: {
      ...(first.proof_of_concept as Record<string, unknown>),
      // A step the producer repeated is not a redaction artifact and stays repeated.
      scenario: ["Warp past the round deadline.", "Warp past the round deadline.", `Authenticate with ${token}.`]
    }
  });
  input.issues = [first, second];
  const before = structuredClone(input);

  const internal = projectCanonicalFinalReport(input);
  assert.deepEqual(input, before);
  assert.deepEqual(internal.report, before, "the developer projection keeps every original path");
  const internalJson = JSON.stringify(internal.report);
  for (const value of [...privateFiles, ...privatePatches, ...flaggedFiles, ...flaggedFunctions]) {
    assert.equal(internalJson.includes(value), true, value);
  }
  assert.doesNotMatch(internalJson, /REDACTED|\[redacted-path\]/u);
  assert.doesNotMatch(internal.markdown, /REDACTED|\[redacted-path\]/u);

  const published = projectPublicCanonicalFinalReport(input);
  assert.deepEqual(input, before);
  const [publicFirst, publicSecond] = published.report.issues as Array<Record<string, unknown>>;
  assert.deepEqual(publicFirst?.affected_files, ["[redacted-path]"]);
  assert.deepEqual(publicFirst?.patch_refs, ["[redacted-path]", "patches/fix.patch"], "first-occurrence order");
  assert.deepEqual(
    publicFirst?.affected_functions,
    ["deposit", "withdraw"],
    "an array the redaction passes do not change is returned as is"
  );
  assert.deepEqual(publicSecond?.affected_files, ["REDACTED", keptFile]);
  assert.deepEqual(publicSecond?.affected_functions, ["REDACTED", keptFunction]);
  assert.deepEqual(
    (publicSecond?.proof_of_concept as Record<string, unknown>).scenario,
    ["Warp past the round deadline.", "Warp past the round deadline.", "Authenticate with REDACTED."],
    "a duplicate that existed before redaction is kept even when the pass changes a neighbour"
  );
  assert.deepEqual((published.report.run_metadata as Record<string, unknown>).models_used, ["model-a"]);
  assert.doesNotMatch(
    JSON.stringify(published.report),
    /\/root\/workspace|MockOracleAggregatorWith|UniswapV3Twap|ghp_/u
  );
  assert.equal(isDirectiveConformingFinalReportMarkdown(published.markdown, published.report), true);
  assert.deepEqual(projectCanonicalFinalReport(published.report), published);
  assertPublicProjectionFixedPoint(published);
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

test("priority-filtered reference expectations remain visible without claiming fulfillment", () => {
  const report = renderableReport();
  report.property_implementation_coverage = {
    ...(report.property_implementation_coverage as Record<string, unknown>),
    reference_expected_property_ids: ["property-1", "excluded-low-property", "excluded_low_property"],
    reference_expectation_ids: ["external-required-check"]
  };
  const projection = projectCanonicalFinalReport(report);
  assert.match(projection.markdown, /Reference expectation properties: `3`/u);
  // Inside a code span a backslash is literal, so property IDs are inline values, never escaped prose.
  assert.ok(
    projection.markdown.includes(
      "- Unselected reference expectation properties (not fulfilled): `excluded-low-property`, `excluded_low_property`\n"
    )
  );
  assert.equal(isDirectiveConformingFinalReportMarkdown(projection.markdown, report), true);
});

test("agent reports disclose omitted property implementation without discarding reviewed findings", () => {
  const report: Record<string, unknown> = {
    ...renderableReport(),
    property_implementation_coverage: { status: "unavailable", reason: "property-implementation-not-completed" }
  };
  const projection = projectCanonicalFinalReport(report);
  assert.match(
    projection.markdown,
    /Property implementation was planned, but its results were unavailable to the report agent/u
  );
  assert.match(projection.markdown, /Implementation coverage is unknown/u);
  assert.match(projection.markdown, /## \[L-01\] - State mismatch/u);
  assert.doesNotMatch(projection.markdown, /Status: `not-planned`|Selected properties:|Implemented properties:/u);
  assert.deepEqual(projection.report.issues, report.issues);
  assert.equal(isDirectiveConformingFinalReportMarkdown(projection.markdown, report), true);
});

test("the coverage producer section keeps its bytes while report.md states only the unmeasured notice", () => {
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
  assert.doesNotMatch(
    projection.markdown,
    /Scoped coverage evidence|coverage-tooling-blocked|Blockers:|recon-coverage/u
  );
  assert.ok(projection.markdown.includes(`- Audit profile: \`exhaustive\`\n\n${COVERAGE_UNMEASURED_NOTICE}\n\n`));
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
      `${projection.markdown}\n<img src="https://example.com/p.png">\n`,
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
  assert.equal(
    isDirectiveConformingFinalReportMarkdown(
      projection.markdown.replace("\n## Property provenance\n", "\n## Provenance\n"),
      projection.report
    ),
    false
  );
});

test("directive conformance requires both coverage headings", () => {
  const projection = projectCanonicalFinalReport(renderableReport());
  assert.equal(
    isDirectiveConformingFinalReportMarkdown(
      projection.markdown.replace("## Property implementation coverage", "## Implementation coverage"),
      projection.report
    ),
    false
  );
});

test("directive validation treats fenced proof code as code while retaining prose restrictions", () => {
  const input = renderableReport();
  const issue = (input.issues as Array<Record<string, unknown>>)[0]!;
  issue.proof_of_concept = {
    scenario: ["Prepare the state where balance <b> exceeds <a>.", "Execute the transition and observe the mismatch."],
    language: "solidity",
    code: [
      "contract MarkupProbe {",
      '    string internal constant label = "<b>bold</b>";',
      "    // <script>probe()</script> is a target string here.",
      "}"
    ].join("\n")
  };

  const projection = projectCanonicalFinalReport(input);
  assert.match(projection.markdown, /<script>probe\(\)<\/script>/u);
  assert.match(projection.markdown, /balance &lt;b&gt; exceeds &lt;a&gt;\./u);
  assert.equal(isDirectiveConformingFinalReportMarkdown(projection.markdown, projection.report), true);
  assert.equal(
    isDirectiveConformingFinalReportMarkdown(
      projection.markdown.replace("### Proof of Concept\n", "### Proof of Concept\n\n<b>bold</b>\n"),
      projection.report
    ),
    false
  );
});

test("issue headings inside fenced proof code are code, not issue headings", () => {
  const input = renderableReport();
  const [issue] = input.issues as Array<Record<string, unknown>>;
  if (issue === undefined) throw new Error("missing issue fixture");
  issue.proof_of_concept = {
    scenario: ["Run the script."],
    language: "python",
    code: "## [L-01] - State mismatch\n## [M-01] - Another heading\nprint('probe')"
  };
  const projection = projectCanonicalFinalReport(input);
  assert.equal(isDirectiveConformingFinalReportMarkdown(projection.markdown, projection.report), true);
  assert.equal(
    isDirectiveConformingFinalReportMarkdown(
      projection.markdown.replace(
        "\n## Property implementation coverage\n",
        "\n## [M-01] - Another heading\n\n## Property implementation coverage\n"
      ),
      projection.report
    ),
    false,
    "an issue heading outside the fence still counts"
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
      "contract MarkupProbe {",
      '    string internal constant label = "<b>bold</b>";',
      "```",
      "<i>still code after a backtick line</i>",
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
        "~~~~   \n\n<b>bold</b>\n\n## Property implementation coverage"
      ),
      projection.report
    ),
    false
  );
  assert.equal(
    isDirectiveConformingFinalReportMarkdown(
      insertProofBlock(["    ~~~solidity", "<script>proofOnly()</script>", "    ~~~"].join("\n")),
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

interface MarkdownNode {
  type: string;
  url?: string;
  value?: string;
  children?: MarkdownNode[];
}

/** Flatten the CommonMark tree so assertions describe what a reader sees, not escape bytes. */
function markdownNodes(markdown: string): Array<{ type: string; url?: string; text: string }> {
  const text = (node: MarkdownNode): string => node.value ?? (node.children ?? []).map(text).join("");
  const nodes: Array<{ type: string; url?: string; text: string }> = [];
  const walk = (node: MarkdownNode): void => {
    nodes.push({ type: node.type, ...(node.url === undefined ? {} : { url: node.url }), text: text(node) });
    for (const child of node.children ?? []) walk(child);
  };
  walk(fromMarkdown(markdown) as unknown as MarkdownNode);
  return nodes;
}

/** GitHub's heading slug: lowercase, keep letters, marks, digits, spaces, "-" and "_", then spaces become "-". */
function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
    .replace(/\s/gu, "-");
}

function titledReport(title: string): Record<string, unknown> {
  const report = renderableReport();
  const [issue] = report.issues as Array<Record<string, unknown>>;
  if (issue === undefined) throw new Error("missing issue fixture");
  issue.title = title;
  for (const entry of report.property_provenance as Array<Record<string, unknown>>) entry.title = title;
  return report;
}

test("upstream prose with link or image syntax renders as literal text", () => {
  const report = renderableReport();
  const [issue] = report.issues as Array<Record<string, unknown>>;
  if (issue === undefined) throw new Error("missing issue fixture");
  const description =
    "See [the spec](https://example.com/spec), ![flow](https://example.com/flow.png), " +
    "[THREAT_MODEL.md](../threat-model/THREAT_MODEL.md), and handlers[id](payload).";
  issue.description = description;
  (issue.proof_of_concept as Record<string, unknown>).scenario = ["Call handlers[id](payload).", "Observe it."];
  const before = structuredClone(report);

  const projection = projectCanonicalFinalReport(report);
  assert.deepEqual(projection.report, before);
  const nodes = markdownNodes(projection.markdown);
  assert.deepEqual(
    nodes.filter((node) => node.type === "image" || (node.type === "link" && !node.url?.startsWith("#"))),
    []
  );
  assert.ok(nodes.some((node) => node.type === "paragraph" && node.text === description));
  assert.ok(nodes.some((node) => node.type === "paragraph" && node.text === "Call handlers[id](payload)."));
});

test("artifact validation warning codes with link or image syntax render as literal text", () => {
  const report = renderableReport();
  const codes = ["[notice](https://example.com/x)", "![t](https://example.com/p.png)"];
  const warnings = codes.map((code) => ({
    code,
    artifact_path: "artifacts/dedupe/strategy-detections.json",
    field_path: "$[5].family_id",
    message: "Optional metadata is missing",
    gate: "strategy-detection-review-stage-reconciliation"
  }));
  (report.run_metadata as Record<string, unknown>).artifact_validation_warnings = warnings;

  // report.md no longer lists the warnings; the public companion carries them as literal text.
  assert.equal(
    codes.some((code) => projectCanonicalFinalReport(report).markdown.includes(code)),
    false
  );
  for (const markdown of [projectPublicArtifactValidationWarnings(warnings).markdown]) {
    const nodes = markdownNodes(markdown);
    assert.deepEqual(
      nodes.filter((node) => node.type === "image" || (node.type === "link" && !node.url?.startsWith("#"))),
      []
    );
    for (const code of codes) {
      assert.ok(
        nodes.some((node) => node.type === "paragraph" && node.text.startsWith(`${code} — `)),
        code
      );
    }
  }
});

test("upstream prose that reads like a legacy report label still renders", () => {
  const report = renderableReport();
  const [issue] = report.issues as Array<Record<string, unknown>>;
  if (issue === undefined) throw new Error("missing issue fixture");
  issue.family_variants = [
    { id: "variant-1", title: "Item 1", summary: "The first sibling path.", dedupe_key: "variant-1" },
    { id: "variant-2", title: "Source Node Id", summary: "Mislabelled identifiers.", dedupe_key: "variant-2" }
  ];
  (report.property_implementation_coverage as Record<string, unknown>).blocker_summaries = [
    "Critical",
    "Strategy loops: 4"
  ];

  const items = markdownNodes(projectCanonicalFinalReport(report).markdown)
    .filter((node) => node.type === "listItem")
    .map((node) => node.text);
  for (const text of [
    "Item 1: The first sibling path.",
    "Source Node Id: Mislabelled identifiers.",
    "Critical",
    "Strategy loops: 4"
  ]) {
    assert.ok(items.includes(text), text);
  }
});

test("issue titles with non-ASCII letters, underscores, and code spans render index anchors that resolve", () => {
  for (const title of [
    "Δ-neutral rebalance drifts",
    "Naïve [share] math",
    "max_supply overflow in `_mint`",
    "`` a`b `` and ` spaced ` spans",
    "`Vec<T>` length and _private_ helper",
    "Q&amp;A \\x19 prefix",
    "| piped `a|b` title"
  ]) {
    const markdown = projectCanonicalFinalReport(titledReport(`[L-01] - ${title}`)).markdown;
    const nodes = markdownNodes(markdown);
    const headings = new Set(nodes.filter((node) => node.type === "heading").map((node) => headingSlug(node.text)));
    const anchors = nodes.filter((node) => node.type === "link" && node.url?.startsWith("#"));
    assert.ok(anchors.length > 0, title);
    for (const anchor of anchors) assert.ok(headings.has(anchor.url?.slice(1) ?? ""), `${title}: ${anchor.url ?? ""}`);
  }
  // A GFM table row splits on every pipe that is not backslash-escaped, so the index escapes each one,
  // including a title's first character: the title follows the label's `] - `, so it opens no block.
  const piped = renderableReport();
  const [pipedIssue] = piped.issues as Array<Record<string, unknown>>;
  if (pipedIssue === undefined) throw new Error("missing issue fixture");
  pipedIssue.title = "[L-01] - | piped `a|b` title";
  for (const entry of piped.property_provenance as Array<Record<string, unknown>>) entry.title = pipedIssue.title;
  assert.ok(
    projectCanonicalFinalReport(piped).markdown.includes(
      "\n| L-01 | [[L-01] - \\| piped `a\\|b` title](#l-01----piped-ab-title) |\n"
    )
  );
});

test("public projection keeps a redacted path followed by a parenthesis as literal text", () => {
  const report = renderableReport();
  const [issue] = report.issues as Array<Record<string, unknown>>;
  if (issue === undefined) throw new Error("missing issue fixture");
  issue.description = "The reproducer at /srv/customer/private/Repro.t.sol(line 12) fails.";

  const published = projectPublicCanonicalFinalReport(report);
  assert.equal(
    (published.report.issues as Array<Record<string, unknown>>)[0]?.description,
    "The reproducer at [redacted-path](line 12) fails."
  );
  const nodes = markdownNodes(published.markdown);
  assert.equal(
    nodes.some((node) => node.type === "link" && !node.url?.startsWith("#")),
    false
  );
  assert.ok(
    nodes.some((node) => node.type === "paragraph" && node.text === "The reproducer at [redacted-path](line 12) fails.")
  );
  assertPublicProjectionFixedPoint(published);

  // An escape inserted before `]` would read as a UNC path after a doubled backslash, and would
  // extend a redacted assignment value so the fixed-point re-scan redacts it again.
  for (const description of ["Match a literal \\](x) in the parser.", "Set token=synthetic-escape-secret](x)."]) {
    issue.description = description;
    assertPublicProjectionFixedPoint(projectPublicCanonicalFinalReport(report));
  }
});

function emptyFindingsReport(): Record<string, unknown> {
  return { ...renderableReport(), issues: [], property_provenance: [] };
}

function runSummaryParagraphAfterBullets(markdown: string): string | undefined {
  return markdown.split("\n## Run summary\n\n")[1]?.split("\n\n")[1];
}

const UNMEASURED_EMPTY_SENTENCE =
  "No issues were reported, but scoped coverage could not be measured, so this is not a result.";

test("coverage notices follow the Run summary exactly when the typed evidence calls for one", () => {
  const cases: Array<{ evidence: Record<string, unknown> | undefined; notice: string | undefined; empty: string }> = [
    {
      evidence: unavailableCoverageEvidence(),
      notice: COVERAGE_UNMEASURED_NOTICE,
      empty: UNMEASURED_EMPTY_SENTENCE
    },
    { evidence: measuredCoverageEvidence(1), notice: COVERAGE_INCOMPLETE_NOTICE, empty: "No issues reported." },
    { evidence: completeCoverageEvidence(), notice: undefined, empty: "No issues reported." },
    { evidence: undefined, notice: undefined, empty: "No issues reported." }
  ];
  for (const { evidence, notice, empty } of cases) {
    for (const base of [renderableReport(), emptyFindingsReport()]) {
      const report = evidence === undefined ? base : { ...base, coverage_evidence: evidence };
      const projection = projectCanonicalFinalReport(report);
      const label = `${String(evidence?.status)} with ${String((report.issues as unknown[]).length)} issues`;
      assert.deepEqual(projection.report, report, label);
      const afterSummary = runSummaryParagraphAfterBullets(projection.markdown);
      if (notice === undefined) {
        assert.notEqual(afterSummary, COVERAGE_UNMEASURED_NOTICE, label);
        assert.notEqual(afterSummary, COVERAGE_INCOMPLETE_NOTICE, label);
      } else {
        assert.equal(afterSummary, notice, label);
      }
      assert.doesNotMatch(projection.markdown, /Scoped coverage evidence|declaration-completeness|\d+\/\d+/u, label);
      if ((report.issues as unknown[]).length === 0) {
        assert.ok(projection.markdown.split("\n").includes(empty), `${label}: ${projection.markdown}`);
      }
      assert.equal(isDirectiveConformingFinalReportMarkdown(projection.markdown, projection.report), true, label);
      assertPublicProjectionFixedPoint(projectPublicCanonicalFinalReport(report));

      const otherNotice =
        notice === COVERAGE_UNMEASURED_NOTICE ? COVERAGE_INCOMPLETE_NOTICE : COVERAGE_UNMEASURED_NOTICE;
      const mutations = [
        `${projection.markdown}\n${COVERAGE_UNMEASURED_NOTICE}\n`,
        `${projection.markdown}\n${COVERAGE_INCOMPLETE_NOTICE}\n`,
        projection.markdown.replace(
          "- Audit profile: `exhaustive`\n",
          `- Audit profile: \`exhaustive\`\n\n${otherNotice}\n`
        )
      ];
      if (notice !== undefined) {
        mutations.push(
          projection.markdown.replace(`\n${notice}\n`, "\n"),
          projection.markdown
            .replace(`\n\n${notice}\n`, "\n")
            .replace("\n## Property provenance\n", `\n${notice}\n\n## Property provenance\n`)
        );
      }
      for (const markdown of mutations) {
        assert.notEqual(markdown, projection.markdown, label);
        assert.equal(
          isDirectiveConformingFinalReportMarkdown(markdown, projection.report),
          false,
          `${label}: ${markdown}`
        );
      }
    }
  }

  const unmeasured = projectCanonicalFinalReport({
    ...emptyFindingsReport(),
    coverage_evidence: unavailableCoverageEvidence()
  });
  assert.equal(
    isDirectiveConformingFinalReportMarkdown(
      unmeasured.markdown.replace(UNMEASURED_EMPTY_SENTENCE, "No issues reported."),
      unmeasured.report
    ),
    false,
    "unmeasured scoped coverage must never read as a clean empty result"
  );
});

test("finding prose that repeats a coverage notice or the clean-result sentence still renders", () => {
  const cases: Array<{ evidence: Record<string, unknown> | undefined; notice: string | undefined }> = [
    { evidence: undefined, notice: undefined },
    { evidence: unavailableCoverageEvidence(), notice: COVERAGE_UNMEASURED_NOTICE },
    { evidence: measuredCoverageEvidence(1), notice: COVERAGE_INCOMPLETE_NOTICE }
  ];
  for (const { evidence, notice } of cases) {
    const report = remediationReport(COVERAGE_INCOMPLETE_NOTICE);
    const [issue] = report.issues as Array<Record<string, unknown>>;
    if (issue === undefined) throw new Error("missing issue fixture");
    issue.description = COVERAGE_UNMEASURED_NOTICE;
    issue.impact_rationale = "No issues reported.";
    (issue.proof_of_concept as Record<string, unknown>).scenario = ["No issues reported.", COVERAGE_INCOMPLETE_NOTICE];
    if (evidence !== undefined) report.coverage_evidence = evidence;
    const projection = projectCanonicalFinalReport(report);
    const label = String(evidence?.status);
    assert.ok(projection.markdown.includes(`\n${COVERAGE_UNMEASURED_NOTICE}\n\n### Severity\n`), label);
    assert.ok(projection.markdown.includes(`\n### Remediation\n\n${COVERAGE_INCOMPLETE_NOTICE}\n`), label);
    const afterSummary = runSummaryParagraphAfterBullets(projection.markdown);
    if (notice === undefined) {
      assert.notEqual(afterSummary, COVERAGE_UNMEASURED_NOTICE, label);
      assert.notEqual(afterSummary, COVERAGE_INCOMPLETE_NOTICE, label);
    } else {
      assert.equal(afterSummary, notice, label);
    }
    assert.equal(isDirectiveConformingFinalReportMarkdown(projection.markdown, projection.report), true, label);
    assertPublicProjectionFixedPoint(projectPublicCanonicalFinalReport(report));
    // Outside the issue blocks a notice still appears exactly when owed, once, after the Run summary.
    for (const extra of [COVERAGE_UNMEASURED_NOTICE, COVERAGE_INCOMPLETE_NOTICE]) {
      assert.equal(
        isDirectiveConformingFinalReportMarkdown(
          projection.markdown.replace(
            "\n## Property implementation coverage\n",
            `\n## Notes\n\n${extra}\n\n## Property implementation coverage\n`
          ),
          projection.report
        ),
        false,
        `${label}: ${extra}`
      );
    }
  }
  // An empty report keeps its clean-result rule: the sentence outside an issue block still fails.
  const unmeasured = projectCanonicalFinalReport({
    ...emptyFindingsReport(),
    coverage_evidence: unavailableCoverageEvidence()
  });
  assert.equal(
    isDirectiveConformingFinalReportMarkdown(
      unmeasured.markdown.replace(
        "\n## Property implementation coverage\n",
        "\n## Notes\n\nNo issues reported.\n\n## Property implementation coverage\n"
      ),
      unmeasured.report
    ),
    false
  );
});

test("the unmeasured-coverage clause composes with the other no-issues clauses", () => {
  const blocked = projectCanonicalFinalReport({
    ...emptyFindingsReport(),
    coverage_evidence: unavailableCoverageEvidence(),
    campaign_outcome: { outcome: "blocked" }
  });
  assert.ok(
    blocked.markdown
      .split("\n")
      .includes(
        "No issues were reported, but the invariant campaign did not run and scoped coverage could not be measured, so this is not a result."
      ),
    blocked.markdown
  );
  const lane = (index: number, status: string): Record<string, unknown> => ({
    node_id: `dynamic:class:${index}`,
    logical_node_id: "class-goals",
    attempt_id: `attempt-${index}`,
    status,
    finding_count: status === "completed-no-findings" ? 0 : null
  });
  const census = {
    schema_version: "ultrafuzz.goal-search-coverage.v1",
    run_id: "projection-test",
    totals: { planned: 2 },
    goals: [lane(1, "completed-no-findings"), lane(2, "stopped-early")]
  };
  const allThree = projectCanonicalFinalReport(
    {
      ...emptyFindingsReport(),
      coverage_evidence: unavailableCoverageEvidence(),
      campaign_outcome: { outcome: "blocked" }
    },
    { goalSearchCoverage: census }
  );
  assert.ok(
    allThree.markdown
      .split("\n")
      .includes(
        "No issues were reported, but the invariant campaign did not run, only 1 of 2 targeted goal searches completed, and scoped coverage could not be measured, so this is not a result. See [Goal search coverage](#goal-search-coverage)."
      ),
    allThree.markdown
  );
  assert.equal(isDirectiveConformingFinalReportMarkdown(allThree.markdown, allThree.report), true);
  // Without the coverage clause the existing sentence keeps its exact bytes.
  const goalOnly = projectCanonicalFinalReport(
    { ...emptyFindingsReport(), campaign_outcome: { outcome: "blocked" } },
    { goalSearchCoverage: census }
  );
  assert.ok(
    goalOnly.markdown
      .split("\n")
      .includes(
        "No issues were reported, but the invariant campaign did not run and only 1 of 2 targeted goal searches completed, so this is not a result. See [Goal search coverage](#goal-search-coverage)."
      )
  );
});

test("partial and unchecked disclosures are unchanged by the coverage notice", () => {
  const partial = projectCanonicalFinalReport({
    ...emptyFindingsReport(),
    completion: partialCompletion(),
    coverage_evidence: unavailableCoverageEvidence()
  });
  assert.match(
    partial.markdown,
    /^# Ultrafuzz report — PARTIAL\n\n> \*\*PARTIAL REPORT — coverage is incomplete\.\*\*/u
  );
  assert.match(partial.markdown, /^No production issues were reported from the available verified results\. /mu);
  assert.equal(runSummaryParagraphAfterBullets(partial.markdown), COVERAGE_UNMEASURED_NOTICE);
  assert.doesNotMatch(partial.markdown, /^No issues (?:were )?reported/mu);
  assert.equal(isDirectiveConformingFinalReportMarkdown(partial.markdown, partial.report), true);

  const unchecked = projectCanonicalFinalReport({
    ...uncheckedReport(),
    coverage_evidence: measuredCoverageEvidence(1)
  });
  assert.match(
    unchecked.markdown,
    /^# Ultrafuzz report — PARTIAL\n\n> \*\*PARTIAL REPORT — verification not checked\.\*\*/u
  );
  assert.match(unchecked.markdown, /^No final findings are included in this agent-written report\. /mu);
  assert.equal(runSummaryParagraphAfterBullets(unchecked.markdown), COVERAGE_INCOMPLETE_NOTICE);
  assert.equal(isDirectiveConformingFinalReportMarkdown(unchecked.markdown, unchecked.report), true);
});

test("directive validation rejects the removed sections outside fenced code only", () => {
  const projection = projectCanonicalFinalReport(renderableReport());
  const insertBlock = (block: string): string =>
    projection.markdown.replace("\n## Property provenance\n", `\n${block}\n\n## Property provenance\n`);
  for (const heading of [
    "## Scoped coverage evidence",
    "## Artifact validation warnings",
    "### Scoped coverage evidence"
  ]) {
    assert.equal(
      isDirectiveConformingFinalReportMarkdown(insertBlock(`${heading}\n\n- Status: unavailable`), projection.report),
      false,
      heading
    );
    assert.equal(
      isDirectiveConformingFinalReportMarkdown(insertBlock(`~~~text\n${heading}\n~~~`), projection.report),
      true,
      `${heading} inside fenced code`
    );
  }
});

function remediationReport(recommendation?: unknown): Record<string, unknown> {
  const report = renderableReport();
  const [issue] = report.issues as Array<Record<string, unknown>>;
  if (issue === undefined) throw new Error("missing issue fixture");
  issue.family_variants = [
    { id: "variant-1", title: "Sibling path", summary: "The same overflow via `burn`.", dedupe_key: "variant-1" }
  ];
  if (recommendation !== undefined) issue.recommendation = recommendation;
  return report;
}

test("every production issue ends with Remediation after its proof and family variants", () => {
  const recommendation = "Use `SafeERC20.safeTransfer` instead of `transfer`, and bound max_supply in `_mint()`.";
  const report = remediationReport(recommendation);
  const before = structuredClone(report);
  const projection = projectCanonicalFinalReport(report);
  assert.deepEqual(projection.report, before);
  const markdown = projection.markdown;
  const proof = markdown.indexOf("\n### Proof of Concept\n");
  const variants = markdown.indexOf("\n#### Family variants\n");
  const remediation = markdown.indexOf(`\n### Remediation\n\n${recommendation}\n`);
  assert.ok(proof > 0 && variants > proof && remediation > variants, markdown);
  assert.ok(remediation < markdown.indexOf("\n## Property implementation coverage\n"));
  const nodes = markdownNodes(markdown);
  for (const code of ["SafeERC20.safeTransfer", "transfer", "_mint()"]) {
    assert.ok(
      nodes.some((node) => node.type === "inlineCode" && node.text === code),
      code
    );
  }
  assert.ok(
    nodes.some(
      (node) =>
        node.type === "paragraph" &&
        node.text === "Use SafeERC20.safeTransfer instead of transfer, and bound max_supply in _mint()."
    )
  );
  assert.equal(isDirectiveConformingFinalReportMarkdown(markdown, projection.report), true);
  assertPublicProjectionFixedPoint(projectPublicCanonicalFinalReport(report));

  for (const missing of [undefined, "   ", "unavailable", " Unavailable "]) {
    const fallbackReport = remediationReport(missing);
    const fallbackBefore = structuredClone(fallbackReport);
    const fallback = projectCanonicalFinalReport(fallbackReport);
    assert.deepEqual(fallback.report, fallbackBefore, "the fallback is render-time only");
    assert.ok(
      fallback.markdown.includes(
        "\n#### Family variants\n\n- **Sibling path**: The same overflow via `burn`.\n\n" +
          `### Remediation\n\n${REMEDIATION_UNRECORDED_NOTICE}\n\n## Property implementation coverage\n`
      ),
      `${JSON.stringify(missing)}: ${fallback.markdown}`
    );
    assert.equal(isDirectiveConformingFinalReportMarkdown(fallback.markdown, fallback.report), true);
  }
});

test("directive validation rejects a missing, duplicated, or misordered Remediation", () => {
  const recommendation = "Bound the supply before minting.";
  const projection = projectCanonicalFinalReport(remediationReport(recommendation));
  const block = `\n### Remediation\n\n${recommendation}\n`;
  const withoutBlock = projection.markdown.replace(block, "");
  assert.notEqual(withoutBlock, projection.markdown);
  const section = `### Remediation\n\n${recommendation}\n\n`;
  const mutations = {
    missing: withoutBlock,
    duplicated: projection.markdown.replace(block, `${block}${block}`),
    "before the proof": withoutBlock.replace("### Proof of Concept\n", `${section}### Proof of Concept\n`),
    "before family variants": withoutBlock.replace("#### Family variants\n", `${section}#### Family variants\n`),
    "after the next h2": withoutBlock.replace("\n## Goal search coverage\n", `\n## Goal search coverage\n${block}`)
  };
  for (const [label, markdown] of Object.entries(mutations)) {
    assert.notEqual(markdown, projection.markdown, label);
    assert.equal(isDirectiveConformingFinalReportMarkdown(markdown, projection.report), false, label);
  }

  // Remediation text inside fenced proof code is code, not the issue's section.
  const fenced = remediationReport(recommendation);
  const [issue] = fenced.issues as Array<Record<string, unknown>>;
  if (issue === undefined) throw new Error("missing issue fixture");
  (issue.proof_of_concept as Record<string, unknown>).code = `// notes\n### Remediation\n\n${recommendation}`;
  const fencedProjection = projectCanonicalFinalReport(fenced);
  assert.equal(isDirectiveConformingFinalReportMarkdown(fencedProjection.markdown, fencedProjection.report), true);
  const fencedWithoutBlock = fencedProjection.markdown.replace(`\n### Remediation\n\n${recommendation}\n\n##`, "\n##");
  assert.notEqual(fencedWithoutBlock, fencedProjection.markdown);
  assert.equal(isDirectiveConformingFinalReportMarkdown(fencedWithoutBlock, fencedProjection.report), false);
});

function descriptionReport(description: string): Record<string, unknown> {
  const report = renderableReport();
  const [issue] = report.issues as Array<Record<string, unknown>>;
  if (issue === undefined) throw new Error("missing issue fixture");
  issue.description = description;
  return report;
}

function projectDescription(description: string): CanonicalFinalReportProjection {
  return projectCanonicalFinalReport(descriptionReport(description));
}

test("finding prose renders backtick spans as inline code and everything else as literal text", () => {
  const description = "Use `max_supply` and `_mint()` so max_supply and _a b_ stay text.";
  const projection = projectDescription(description);
  assert.ok(projection.markdown.includes("\nUse `max_supply` and `_mint()` so max_supply and \\_a b\\_ stay text.\n"));
  const nodes = markdownNodes(projection.markdown);
  assert.ok(nodes.some((node) => node.type === "inlineCode" && node.text === "max_supply"));
  assert.ok(nodes.some((node) => node.type === "inlineCode" && node.text === "_mint()"));
  assert.equal(
    nodes.some((node) => node.type === "emphasis"),
    false
  );
  assert.ok(
    nodes.some(
      (node) =>
        node.type === "paragraph" && node.text === "Use max_supply and _mint() so max_supply and _a b_ stay text."
    )
  );

  const markup = projectDescription("A `Vec<T>` length and ```x``` and `` a`b `` and an unmatched ` tick.");
  assert.ok(
    markup.markdown.includes(
      "\nA \\`Vec&lt;T&gt;\\` length and \\`\\`\\`x\\`\\`\\` and `` a`b `` and an unmatched \\` tick.\n"
    )
  );
  const markupNodes = markdownNodes(markup.markdown);
  assert.equal(
    markupNodes.some((node) => node.type === "inlineCode" && (node.text.includes("Vec") || node.text === "x")),
    false
  );
  assert.ok(markupNodes.some((node) => node.type === "inlineCode" && node.text === "a`b"));
  assert.ok(
    markupNodes.some(
      (node) =>
        node.type === "paragraph" && node.text === "A `Vec<T>` length and ```x``` and a`b and an unmatched ` tick."
    )
  );
  assert.equal(
    isDirectiveConformingFinalReportMarkdown(markup.markdown, markup.report),
    true,
    "passes the raw-HTML rule"
  );
  assertPublicProjectionFixedPoint(projectPublicCanonicalFinalReport(markup.report));
});

test("finding prose cannot open a block, a fence, or a link reference definition", () => {
  for (const description of [
    "1. Call deposit.",
    "2) Call deposit.",
    "- Call deposit.",
    "+ Call deposit.",
    "# Call deposit.",
    "> Call deposit.",
    "| a | b |",
    "=== heading",
    "```solidity",
    "~~~ fence",
    "<div>raw</div>"
  ]) {
    const projection = projectDescription(description);
    const nodes = markdownNodes(projection.markdown);
    assert.ok(
      nodes.some((node) => node.type === "paragraph" && node.text === description),
      `${description}: ${projection.markdown}`
    );
    assert.equal(
      nodes.some((node) => node.type === "html" || node.type === "blockquote"),
      false,
      description
    );
    assert.equal(isDirectiveConformingFinalReportMarkdown(projection.markdown, projection.report), true, description);
  }

  const report = descriptionReport("[spec]: https://example.com/evil");
  const [issue] = report.issues as Array<Record<string, unknown>>;
  if (issue === undefined) throw new Error("missing issue fixture");
  (issue.proof_of_concept as Record<string, unknown>).scenario = [
    "[spec]: https://example.com/evil",
    "Read [spec] and [spec][spec]."
  ];
  issue.recommendation = "Follow [spec].";
  const nodes = markdownNodes(projectCanonicalFinalReport(report).markdown);
  assert.equal(
    nodes.some((node) => node.type === "definition" || node.type === "linkReference"),
    false
  );
  assert.ok(nodes.some((node) => node.type === "paragraph" && node.text === "[spec]: https://example.com/evil"));
  assert.ok(nodes.some((node) => node.type === "paragraph" && node.text === "Read [spec] and [spec][spec]."));
});

test("finding prose keeps public projections fixed points without private-content false positives", () => {
  const digestText = "The digest uses \\x19\\x01 as prefix, and a\\b keeps its backslash.";
  const published = projectPublicCanonicalFinalReport(descriptionReport(digestText));
  assert.ok(published.markdown.includes(`\n${digestText}\n`));
  assertPublicProjectionFixedPoint(published);
  assert.ok(markdownNodes(published.markdown).some((node) => node.type === "paragraph" && node.text === digestText));

  // A backslash before punctuation, or at the end, renders as an entity, never as a doubled backslash.
  const escapes = projectPublicCanonicalFinalReport(descriptionReport("Escape \\*star and \\_under, ending in \\"));
  assert.ok(escapes.markdown.includes("\nEscape &#92;\\*star and &#92;\\_under, ending in &#92;\n"));
  assert.ok(
    markdownNodes(escapes.markdown).some(
      (node) => node.type === "paragraph" && node.text === "Escape \\*star and \\_under, ending in \\"
    )
  );
  assertPublicProjectionFixedPoint(escapes);

  const redacted = projectPublicCanonicalFinalReport(
    descriptionReport("Set token=synthetic-assignment-secret and `api_key=zzz` now.")
  );
  assert.equal(
    (redacted.report.issues as Array<Record<string, unknown>>)[0]?.description,
    "Set token=REDACTED and `api_key=REDACTED now."
  );
  assert.ok(redacted.markdown.includes("\nSet token=REDACTED and \\`api_key=REDACTED now.\n"));
  assert.doesNotMatch(redacted.markdown, /synthetic-assignment-secret|zzz/u);
  assert.equal(isDirectiveConformingFinalReportMarkdown(redacted.markdown, redacted.report), true);
  assertPublicProjectionFixedPoint(redacted);

  const privateSpan = projectPublicCanonicalFinalReport(descriptionReport("Read `/srv/customer/private/x.sol` first."));
  assert.ok(privateSpan.markdown.includes("\nRead `[redacted-path]` first.\n"));
  assertPublicProjectionFixedPoint(privateSpan);

  // The renderer's own escapes are not path syntax: `&` stays raw unless it would start a character
  // reference, and a backslash written before escaped punctuation is not a `B:\` or `file:\` separator.
  for (const description of [
    "Option B:&C, see file:&x, and read Q&amp;A.",
    "Option B:*x* and C:_y_ differ, and the error |a - b|/b grows."
  ]) {
    const published = projectPublicCanonicalFinalReport(descriptionReport(description));
    assert.equal((published.report.issues as Array<Record<string, unknown>>)[0]?.description, description);
    assert.ok(
      markdownNodes(published.markdown).some((node) => node.type === "paragraph" && node.text === description),
      `${description}: ${published.markdown}`
    );
    assertPublicProjectionFixedPoint(published);
  }
  assert.ok(
    projectCanonicalFinalReport(descriptionReport("Option B:&C and Q&amp;A")).markdown.includes(
      "\nOption B:&C and Q&amp;amp;A\n"
    )
  );

  // A path after a literal backslash, a pipe that starts a word, or a literal `&lt;` is redacted in
  // report.json, so the Markdown re-scan never meets one behind `&#92;`, `&#124;`, or `&amp;lt;`.
  for (const [description, redactedDescription] of [
    ["Escape a\\/b.", "Escape a\\[redacted-path]"],
    ["Read a\\/srv/customer/key first.", "Read a\\[redacted-path] first."],
    ["|/x leads.", "|[redacted-path] leads."],
    ["|/srv/customer/key first.", "|[redacted-path] first."],
    ["Pipe x |/srv/customer/key first.", "Pipe x |[redacted-path] first."],
    ["Quoted &lt;/srv/customer/key first.", "Quoted &lt;[redacted-path] first."]
  ] as const) {
    const published = projectPublicCanonicalFinalReport(descriptionReport(description));
    assert.equal(
      (published.report.issues as Array<Record<string, unknown>>)[0]?.description,
      redactedDescription,
      description
    );
    assert.doesNotMatch(published.markdown, /srv\/customer/u, description);
    assertPublicProjectionFixedPoint(published);
  }
  const pipeTitle = renderableReport();
  const [pipeIssue] = pipeTitle.issues as Array<Record<string, unknown>>;
  if (pipeIssue === undefined) throw new Error("missing issue fixture");
  pipeIssue.title = "[L-01] - |/srv/customer/key leaks";
  for (const entry of pipeTitle.property_provenance as Array<Record<string, unknown>>) entry.title = pipeIssue.title;
  const pipePublished = projectPublicCanonicalFinalReport(pipeTitle);
  assert.ok(pipePublished.markdown.includes("\n## [L-01] - |[redacted-path] leaks\n"), pipePublished.markdown);
  assert.ok(pipePublished.markdown.includes("](#l-01---redacted-path-leaks) |\n"), pipePublished.markdown);
  assertPublicProjectionFixedPoint(pipePublished);
});

test("a home, private-directory, drive-letter, or UNC path after a literal backslash, star, or word-starting pipe is redacted", () => {
  // findingProse shows these characters literally, so each one is a path boundary in report.json, as
  // it already was for a `/`-rooted path; a star still is not one for a `/`-rooted glob.
  for (const [description, redactedDescription] of [
    ["Read \\~/secret first.", "Read \\[redacted-path] first."],
    ["Read *C:\\Users\\bob\\key first.", "Read *[redacted-path] first."],
    ["Read \\C:\\Users\\bob\\key first.", "Read \\[redacted-path] first."],
    ["Read **~/.bashrc** first.", "Read **[redacted-path] first."],
    ["Read >~/secret first.", "Read >[redacted-path] first."],
    ["Read |~/secret first.", "Read |[redacted-path] first."],
    ["Read ;artifacts/run/report.json first.", "Read ;[redacted-path] first."],
    ["Read x\\\\\\host\\share first.", "Read x\\[redacted-path] first."],
    ["Keep src/**/X.sol and x~/y readable.", "Keep src/**/X.sol and x~/y readable."],
    ["Keep gt;artifacts/<run-id> readable.", "Keep gt;artifacts/<run-id> readable."]
  ] as const) {
    const published = projectPublicCanonicalFinalReport(descriptionReport(description));
    assert.equal(
      (published.report.issues as Array<Record<string, unknown>>)[0]?.description,
      redactedDescription,
      description
    );
    assert.doesNotMatch(published.markdown, /secret|bob|bashrc|host|run\/report/u, description);
    assertPublicProjectionFixedPoint(published);
  }
});

test("blocker summaries keep the frozen public prose escaping", () => {
  const report = renderableReport();
  (report.property_implementation_coverage as Record<string, unknown>).blocker_summaries = [
    "Needs `max_supply` and *care*"
  ];
  assert.ok(projectCanonicalFinalReport(report).markdown.includes("\n- Needs \\`max\\_supply\\` and \\*care\\*\n"));
});

test("an issue title that opens with a bracket keeps a working index link, including a redacted leading path", () => {
  const redactedTitle = "[L-01] - /home/runner/private/Vault.sol rounds deposits down";
  const cases = [
    { project: projectCanonicalFinalReport, title: "[L-01] - [Vault] deposit rounding" },
    { project: projectCanonicalFinalReport, title: "[L-01] - - [x] 1. =| title" },
    {
      project: projectPublicCanonicalFinalReport,
      title: redactedTitle,
      label: "[L-01] - [redacted-path] rounds deposits down"
    }
  ];
  for (const { project, title, label = title } of cases) {
    const projection = project(titledReport(title));
    const nodes = markdownNodes(projection.markdown);
    assert.ok(
      nodes.some((node) => node.type === "heading" && node.text === label),
      `${title}: ${projection.markdown}`
    );
    // The index row's link text is the whole label, and its fragment is the heading's slug.
    const link = nodes.find((node) => node.type === "link" && node.text === label);
    assert.equal(link?.url, `#${headingSlug(label)}`, `${title}: ${projection.markdown}`);
    assert.equal(isDirectiveConformingFinalReportMarkdown(projection.markdown, projection.report), true, title);
  }
  assertPublicProjectionFixedPoint(projectPublicCanonicalFinalReport(titledReport(redactedTitle)));
});

test("remediation that writes the renderer's escapes next to a slash publishes, and a real path there is redacted", () => {
  const cases: ReadonlyArray<readonly [recommendation: string, published: string]> = [
    ["Delete the stale /* unchecked */ annotation.", "Delete the stale /* unchecked */ annotation."],
    ["Use `<`/`<=` consistently.", "Use `<`/`<=` consistently."],
    ["Use `a >= b`/`a > b` checks.", "Use `a >= b`/`a > b` checks."],
    ["Render it as <Foo />.", "Render it as <Foo />."],
    ["Keep outputs under artifacts/<run-id> only.", "Keep outputs under artifacts/<run-id> only."],
    // A `>` is a path boundary in report.json, so whatever follows `>/` is redacted before rendering
    // and the re-scan can treat the escaped `&gt;` in front of a slash as the renderer's own escape.
    ["Ensure ratio>/2 is rejected.", "Ensure ratio>[redacted-path] is rejected."],
    ["Delete the stale /srv/customer/key annotation.", "Delete the stale [redacted-path] annotation."],
    ["Use `<`/srv/customer/key consistently.", "Use `<`[redacted-path] consistently."],
    ["Use `a >= b`/srv/customer/key checks.", "Use `a >= b`[redacted-path] checks."],
    ["Render it as <Foo /srv/customer/key.", "Render it as <Foo [redacted-path]"],
    ["Keep outputs under artifacts/srv/customer only.", "Keep outputs under [redacted-path] only."],
    ["Ensure ratio>/srv/customer/key is rejected.", "Ensure ratio>[redacted-path] is rejected."],
    // The re-scan reads the escaped run after a slash as a word break, so report.json redacts a path
    // that follows the run, however long or nested the run is.
    ["Delete the stale /*/srv/customer/key annotation.", "Delete the stale /*[redacted-path] annotation."],
    ["Use `<`/</srv/customer/key consistently.", "Use `<`/<[redacted-path] consistently."],
    ["Render it as <Foo />artifacts/srv/customer.", "Render it as <Foo />[redacted-path]"],
    ["Keep outputs under artifacts/</srv/customer only.", "Keep outputs under artifacts/<[redacted-path] only."],
    [
      "Keep outputs under artifacts/<artifacts/srv/customer only.",
      "Keep outputs under artifacts/<[redacted-path] only."
    ],
    ["Match /**/srv/customer/key and /*/*/srv/customer/key.", "Match /**[redacted-path] and /*/*[redacted-path]"],
    ["Read /*file:///srv/customer/key now.", "Read /*[redacted-path] now."],
    // A slash inside a word starts no run, so a relative glob stays readable.
    [
      "Match test/*/Invariant.t.sol and test/**/Vault.t.sol, not /**/*.sol or /*/*.",
      "Match test/*/Invariant.t.sol and test/**/Vault.t.sol, not /**/*.sol or /*/*."
    ]
  ];
  for (const [recommendation, expected] of cases) {
    const published = projectPublicCanonicalFinalReport(remediationReport(recommendation));
    assert.equal(
      (published.report.issues as Array<Record<string, unknown>>)[0]?.recommendation,
      expected,
      recommendation
    );
    assert.doesNotMatch(published.markdown, /srv\/customer/u, recommendation);
    const remediation = published.markdown.split("\n### Remediation\n\n")[1]?.split("\n")[0] ?? "";
    assert.ok(
      markdownNodes(remediation).some((node) => node.type === "paragraph" && node.text === expected),
      `${recommendation}: ${remediation}`
    );
    assertPublicProjectionFixedPoint(published);
  }
  // report.json reads no boundary after `<`, so it leaves this path in place; the re-scan still reads
  // a path after the escaped run and refuses to publish.
  assert.throws(
    () => projectPublicCanonicalFinalReport(remediationReport("Close it with </*/srv/customer/key.")),
    /public final-report projection contains private/u
  );
});

test("finding prose ending in a secret-like key name and a colon publishes without a secret false positive", () => {
  for (const recommendation of [
    "Validate the API key:",
    "Rotate the leaked token:",
    "Rotate the secret:",
    "Check the private key:"
  ]) {
    const published = projectPublicCanonicalFinalReport(remediationReport(recommendation));
    assert.equal((published.report.issues as Array<Record<string, unknown>>)[0]?.recommendation, recommendation);
    assert.ok(published.markdown.includes(`\n### Remediation\n\n${recommendation}\n\n## `), recommendation);
    assertPublicProjectionFixedPoint(published);
  }
  // The same holds when the next line is a list item or a fence, or the next text a table cell or the
  // rest of a bold variant label.
  const report = titledReport("[L-01] - Leaked token:");
  const [issue] = report.issues as Array<Record<string, unknown>>;
  if (issue === undefined) throw new Error("missing issue fixture");
  issue.description = "Rotate the password:";
  issue.impact_rationale = "Anyone holding the secret:";
  (issue.proof_of_concept as Record<string, unknown>).scenario = ["Read the token:", "Replay the auth:"];
  issue.family_variants = [
    { id: "variant-1", title: "Replay the token:", summary: "The same leak via `burn`.", dedupe_key: "variant-1" }
  ];
  assertPublicProjectionFixedPoint(projectPublicCanonicalFinalReport(report));

  // A credential the report walk cannot see field by field still fails closed: a key label that ends
  // one block and the key that opens the next are still scanned together.
  const leaked = titledReport("[L-01] - Hardcoded deployer signing key");
  const [leakedIssue] = leaked.issues as Array<Record<string, unknown>>;
  if (leakedIssue === undefined) throw new Error("missing issue fixture");
  leakedIssue.description = `0x${"3f9a1c7e5b2d8f40".repeat(4)} is committed in the deploy script.`;
  assert.throws(() => projectPublicCanonicalFinalReport(leaked), /public final-report projection contains private/u);
  // A credential inside one field is still redacted from both report.json and report.md.
  const assigned = projectPublicCanonicalFinalReport(
    remediationReport("Rotate token=synthetic-remediation-secret now.")
  );
  assert.equal(
    (assigned.report.issues as Array<Record<string, unknown>>)[0]?.recommendation,
    "Rotate token=REDACTED now."
  );
  assert.doesNotMatch(assigned.markdown, /synthetic-remediation-secret/u);
  assertPublicProjectionFixedPoint(assigned);
});

test("finding titles with backslashes publish through the provenance table, dispositions, and outcomes", () => {
  const report = titledReport("[L-01] - Missing `\\x19\\x01` prefix and Q&amp;A \\x19 text in max_supply | digest");
  const [issue] = report.issues as Array<Record<string, unknown>>;
  if (issue === undefined) throw new Error("missing issue fixture");
  (issue.lifecycle as Record<string, unknown>).comparison_disposition = "promoted-again";
  const outcomeTitle = "1. Digest omits \\x19\\x01 in `_hash` | here";
  report.non_production_outcomes = [
    {
      ...structuredClone(issue),
      id: "NP-01",
      title: outcomeTitle,
      triage_classification: "undetermined",
      recommended_next_action: "Review the campaign evidence.",
      lifecycle: {
        dedupe_key: "digest-prefix",
        source_artifacts: [],
        strategy_hits: [{ strategy: "stateful-invariant" }],
        triage_classification: "undetermined",
        final_disposition: "non-production",
        comparison_disposition: "not-reproduced"
      }
    }
  ];
  (report.property_provenance as Array<Record<string, unknown>>).push({
    finding_id: "NP-01",
    source_finding_id: "source-outcome",
    title: outcomeTitle,
    property_ids: ["property-1"],
    sources: [{ source_node_id: "properties", source_property_id: "property-1" }],
    implementation_paths: ["test/Invariant.t.sol"],
    test_paths: ["test/Invariant.t.sol"]
  });
  // Finding prose in a cell: inline code kept, a backslash before a letter kept, every pipe escaped.
  const label = "[L-01] - Missing `\\x19\\x01` prefix and Q&amp;amp;A \\x19 text in max_supply | digest";
  const outcomeCell = "1. Digest omits \\x19\\x01 in `_hash` \\| here";
  for (const projection of [projectCanonicalFinalReport(report), projectPublicCanonicalFinalReport(report)]) {
    const { markdown } = projection;
    assert.ok(markdown.includes(`\n| ${label.replace("|", "\\|")} | property-1 |`), markdown);
    assert.ok(markdown.includes(`\n| ${outcomeCell} | property-1 |`), markdown);
    assert.ok(markdown.includes(`\n| undetermined | ${outcomeCell} | confirmed |`), markdown);
    // A disposition entry starts a list item, so an outcome title cannot open a nested list there.
    assert.ok(markdown.includes(`\n### Promoted again\n\n- ${label}\n`), markdown);
    assert.ok(
      markdown.includes("\n### Not reproduced\n\n- 1\\. Digest omits \\x19\\x01 in `_hash` | here\n"),
      markdown
    );
    const items = markdownNodes(markdown).filter((node) => node.type === "listItem");
    assert.ok(items.some((node) => node.text === "1. Digest omits \\x19\\x01 in _hash | here"));
    assert.equal(isDirectiveConformingFinalReportMarkdown(markdown, projection.report), true);
  }
  assertPublicProjectionFixedPoint(projectPublicCanonicalFinalReport(report));
});

/** A GFM table row's cells: a backslash escapes the character after it, and every other `|` delimits. */
function gfmTableCells(row: string): string[] {
  const cells = [""];
  for (let index = 0; index < row.length; index += 1) {
    const character = row.charAt(index);
    if (character === "|") {
      cells.push("");
      continue;
    }
    const text = character === "\\" ? row.slice(index, index + 2) : character;
    cells[cells.length - 1] += text;
    index += text.length - 1;
  }
  return cells.slice(1, -1).map((cell) => cell.trim());
}

test("a finding title whose code span holds \\| keeps every table row whole", () => {
  const report = titledReport("[L-01] - Pipe `a\\|b` in code");
  const [issue] = report.issues as Array<Record<string, unknown>>;
  if (issue === undefined) throw new Error("missing issue fixture");
  report.non_production_outcomes = [
    {
      ...structuredClone(issue),
      id: "NP-01",
      title: "Outcome `a\\|b` in code",
      triage_classification: "undetermined",
      recommended_next_action: "Review the campaign evidence.",
      lifecycle: {
        dedupe_key: "pipe-outcome",
        source_artifacts: [],
        strategy_hits: [{ strategy: "stateful-invariant" }],
        triage_classification: "undetermined",
        final_disposition: "non-production"
      }
    }
  ];
  // escapeTable would turn the span's `\|` into `\\|`, an escaped backslash and a delimiter, so a
  // cell writes the span as text: `&#92;` and an escaped pipe.
  const label = "[L-01] - Pipe \\`a&#92;\\|b\\` in code";
  for (const projection of [projectCanonicalFinalReport(report), projectPublicCanonicalFinalReport(report)]) {
    const { markdown } = projection;
    const rows = markdown
      .split("\n")
      .filter((line) => line.startsWith("| "))
      .map(gfmTableCells);
    assert.deepEqual(
      rows.find((cells) => cells[0] === "L-01"),
      ["L-01", `[${label}](#l-01---pipe-ab-in-code)`]
    );
    assert.deepEqual(
      rows.find((cells) => cells[0] === label),
      [label, "property-1", "properties", "property-1", "test/Invariant.t.sol", "unavailable"]
    );
    assert.deepEqual(
      rows.find((cells) => cells[0] === "undetermined"),
      [
        "undetermined",
        "Outcome \\`a&#92;\\|b\\` in code",
        "confirmed",
        "A bounded transition violates the expected relationship.",
        "Review the campaign evidence."
      ]
    );
    // Outside a table the span stays code, and the index link still resolves to the heading.
    assert.ok(markdown.includes("\n## [L-01] - Pipe `a\\|b` in code\n"), markdown);
    const nodes = markdownNodes(markdown);
    const heading = nodes.find((node) => node.type === "heading" && node.text.startsWith("[L-01]"));
    const link = nodes.find((node) => node.type === "link" && node.text === "[L-01] - Pipe `a\\|b` in code");
    assert.equal(link?.url, `#${headingSlug(heading?.text ?? "")}`);
    assert.equal(isDirectiveConformingFinalReportMarkdown(markdown, projection.report), true);
  }
  assertPublicProjectionFixedPoint(projectPublicCanonicalFinalReport(report));
});

test("a property ID with angle brackets renders as escaped text, not as raw HTML inside a code span", () => {
  const report = renderableReport();
  report.property_implementation_coverage = {
    ...(report.property_implementation_coverage as Record<string, unknown>),
    reference_expected_property_ids: ["property-1", "excluded_low_property", "Vault<ERC4626>-share_price"]
  };
  const projection = projectCanonicalFinalReport(report);
  assert.ok(
    projection.markdown.includes(
      "\n- Unselected reference expectation properties (not fulfilled): `excluded_low_property`, Vault&lt;ERC4626&gt;-share_price\n"
    ),
    projection.markdown
  );
  assert.ok(
    markdownNodes(projection.markdown).some(
      (node) =>
        node.type === "listItem" &&
        node.text ===
          "Unselected reference expectation properties (not fulfilled): excluded_low_property, Vault<ERC4626>-share_price"
    )
  );
  assert.equal(isDirectiveConformingFinalReportMarkdown(projection.markdown, projection.report), true);
  assertPublicProjectionFixedPoint(projectPublicCanonicalFinalReport(report));
});

test("report.md carries the fixed dependency notice exactly when report.json records restored dependency edits (#1251)", () => {
  const notice =
    "An agent changed hydrated dependency files during this run. Ultrafuzz restored them before later tasks ran, but results from the tasks that changed them may rely on the modified dependency code. report.json lists those tasks under run_metadata.dependency_changes.";
  const clean = renderableReport();
  const cleanProjection = projectCanonicalFinalReport(clean);
  assert.equal(cleanProjection.markdown.includes(notice), false);
  assert.equal(
    isDirectiveConformingFinalReportMarkdown(
      cleanProjection.markdown.replace("\n## Run summary\n\n", `\n## Run summary\n\n${notice}\n\n`),
      clean
    ),
    false
  );

  const report = renderableReport();
  (report.run_metadata as Record<string, unknown>).dependency_changes = [
    {
      attempt_id: "invariant-handlers",
      changed_path_count: 2,
      changed_paths: ["lib/forge-std/src/Test.sol", "lib/forge-std/x.sol"]
    }
  ];
  const projection = projectCanonicalFinalReport(report);
  assert.equal(projection.markdown.split(notice).length - 1, 1);
  const summary = projection.markdown.split("\n## Run summary\n\n")[1]?.split("\n## ")[0] ?? "";
  assert.ok(summary.includes(notice), "the notice sits in the Run summary block");
  assert.doesNotMatch(projection.markdown, /invariant-handlers|lib\/forge-std/u);
  assert.deepEqual(projection.report, report);
  assert.equal(isDirectiveConformingFinalReportMarkdown(projection.markdown, report), true);
  assert.equal(
    isDirectiveConformingFinalReportMarkdown(projection.markdown.replace(`\n\n${notice}`, ""), report),
    false
  );
});
