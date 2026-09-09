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
  const published = projectPublicCanonicalFinalReport(report);
  assert.match(published.markdown, /Artifact validation warnings/u);
  assertPublicProjectionFixedPoint(published);
});

import { validateSafeId, type ReportCompletion } from "@ultrafuzz/artifacts";
import { redactSecretsInText } from "@ultrafuzz/security";

import {
  isDirectiveConformingFinalReportMarkdown,
  projectCanonicalFinalReport,
  projectPublicArtifactValidationWarnings,
  projectPublicCanonicalFinalReport,
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

  // Prose escapes Markdown punctuation such as the token's underscore, so the developer Markdown is
  // checked on the token body while the JSON keeps the exact token.
  const tokenBody = token.slice("ghp_".length);
  const internal = projectCanonicalFinalReport(input);
  assert.deepEqual(input, before);
  assert.deepEqual(internal.report, before);
  assert.equal(JSON.stringify(internal.report).includes(token), true, "the developer report keeps the token");
  assert.equal(internal.markdown.includes(tokenBody), true);
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
  assert.match(published.markdown, /^- Source run ID: `ci-33918585561-1-smoke-ultrafuzz-benc-7d622d2207767a8d`$/mu);
  assert.match(JSON.stringify(published.report), /token=REDACTED/u, "every other field still scans in full");
  assert.equal(isDirectiveConformingFinalReportMarkdown(published.markdown, published.report), true);
  assert.deepEqual(projectCanonicalFinalReport(published.report), published);
  assertPublicProjectionFixedPoint(published);
});

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
  assert.match(published.markdown, /^- Source run ID: `REDACTED`$/mu);
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
