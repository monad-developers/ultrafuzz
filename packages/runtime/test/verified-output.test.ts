import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ARTIFACT_VERIFICATION_SCHEMA_VERSION,
  PLANNED_GRAPH_SCHEMA_VERSION,
  artifactContractDefinition,
  artifactContractSchemaBinding,
  createRunLayout,
  updateNodeState,
  writeArtifactManifest,
  writeFileDurable,
  writeJsonDurable,
  type ArtifactManifestOutputContract,
  type ArtifactVerificationMarker,
  type PlannedGraphDocument,
  type RunLayout
} from "@ultrafuzz/artifacts";

import { projectCanonicalFinalReport } from "../src/final-report-markdown.js";
import { loadVerifiedFinalReportSnapshot, VerifiedOutputError } from "../src/verified-output.js";

const WORKFLOW_RUN_ID = "workflow-current";
const REPORT_ATTEMPT_ID = "release-summary";
const REPORT_LOGICAL_ID = "security-report";
const REPORT_JSON_PATH = "deliverables/current-audit.json";
const REPORT_MARKDOWN_PATH = "deliverables/current-audit.md";
const AGENT_TASK_ID = `node:${REPORT_ATTEMPT_ID}`;
const VERIFIER_TASK_ID = `verify:${REPORT_ATTEMPT_ID}`;

interface ReportFixture {
  layout: RunLayout;
  reportPath: string;
  markdownPath: string;
  reportBytes: Buffer;
  markdownBytes: Buffer;
}

test("verified final-report reader binds immutable current bytes to verifier and controller authority", () => {
  const fixture = createVerifiedReportFixture("verified-report-current");

  const loaded = loadVerifiedFinalReportSnapshot(fixture.layout.root);

  assert.equal(loaded.authority.attempt_id, REPORT_ATTEMPT_ID);
  assert.equal(loaded.authority.logical_node_id, REPORT_LOGICAL_ID);
  assert.equal(loaded.artifacts.source, "verified-agent-report");
  assert.equal(loaded.artifacts.json_path, fixture.reportPath);
  assert.equal(loaded.artifacts.markdown_path, fixture.markdownPath);
  assert.deepEqual(loaded.json_bytes, fixture.reportBytes);
  assert.deepEqual(loaded.markdown_bytes, fixture.markdownBytes);
  assert.deepEqual(fs.readFileSync(fixture.reportPath), fixture.reportBytes);
  assert.deepEqual(fs.readFileSync(fixture.markdownPath), fixture.markdownBytes);
});

test("post-verification report mutation is rejected even when the physical JSON remains shape-valid", () => {
  const fixture = createVerifiedReportFixture("verified-report-mutated");
  const mutated = Buffer.concat([fixture.reportBytes, Buffer.from(" \n", "utf8")]);
  fs.writeFileSync(fixture.reportPath, mutated);

  assert.throws(
    () => loadVerifiedFinalReportSnapshot(fixture.layout.root),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_CHANGED" &&
      /digest\/size binding changed/u.test(error.message)
  );
  assert.deepEqual(fs.readFileSync(fixture.reportPath), mutated);
  assert.deepEqual(fs.readFileSync(fixture.markdownPath), fixture.markdownBytes);
});

test("shape-valid severity drift is rejected by current semantic gates despite matching authority digests", () => {
  const validReport = currentReport("verified-report-semantic-invalid", [currentIssue()]);
  const validProjection = projectCanonicalFinalReport(validReport);
  const invalidReport = structuredClone(validReport);
  (invalidReport.issues as Array<Record<string, unknown>>)[0]!.severity = "High";
  const fixture = createVerifiedReportFixture("verified-report-semantic-invalid", {
    report: invalidReport,
    markdown: validProjection.markdown
  });
  const reportBefore = fs.readFileSync(fixture.reportPath);
  const markdownBefore = fs.readFileSync(fixture.markdownPath);

  assert.throws(
    () => loadVerifiedFinalReportSnapshot(fixture.layout.root),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_INVALID" &&
      /semantic\/context gates.*severity/iu.test(error.message)
  );
  assert.deepEqual(fs.readFileSync(fixture.reportPath), reportBefore);
  assert.deepEqual(fs.readFileSync(fixture.markdownPath), markdownBefore);
});

test("missing verification evidence after successful finalization is invalid authority, not unavailable authority", () => {
  const fixture = createVerifiedReportFixture("verified-report-missing-marker");
  fs.rmSync(path.join(fixture.layout.root, ".ultrafuzz-verification", `${REPORT_ATTEMPT_ID}.json`));

  assert.throws(
    () => loadVerifiedFinalReportSnapshot(fixture.layout.root),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_AUTHORITY_INVALID" &&
      /incomplete or unreadable/iu.test(error.message)
  );
});

test("verified final-report selection rejects absent and ambiguous declared report producers", () => {
  const markdownOnly = finalReportOutputs().filter((output) => output.contract === "ultrafuzz/nonempty-markdown@1");
  const absent = createSelectionLayout("verified-report-producer-absent", [
    reportGraphNode("release-notes", markdownOnly)
  ]);
  assert.throws(
    () => loadVerifiedFinalReportSnapshot(absent.root),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_AUTHORITY_UNAVAILABLE" &&
      /no current planned node declares/iu.test(error.message)
  );

  const ambiguous = createSelectionLayout("verified-report-producer-ambiguous", [
    reportGraphNode("release-summary-a", finalReportOutputs()),
    reportGraphNode("release-summary-b", finalReportOutputs())
  ]);
  assert.throws(
    () => loadVerifiedFinalReportSnapshot(ambiguous.root),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_AUTHORITY_INVALID" &&
      /producer is ambiguous/iu.test(error.message)
  );
});

test("verified final-report selection rejects missing or ambiguous report output contracts", () => {
  const report = finalReportOutputs().find((output) => output.contract === "ultrafuzz/report@2")!;
  const missingMarkdown = createVerifiedReportFixture("verified-report-markdown-missing", {
    outputs: [{ ...report, primary: true }]
  });
  assert.throws(
    () => loadVerifiedFinalReportSnapshot(missingMarkdown.layout.root),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_INVALID" &&
      /PROPERTY_REPORT_MARKDOWN_DECLARATION_AMBIGUOUS/iu.test(error.message)
  );

  const ambiguousReport = createVerifiedReportFixture("verified-report-contract-ambiguous", {
    outputs: [
      { ...report, path: "deliverables/audit-a.json" },
      { ...report, path: "deliverables/audit-b.json" },
      finalReportOutputs().find((output) => output.contract === "ultrafuzz/nonempty-markdown@1")!
    ]
  });
  assert.throws(
    () => loadVerifiedFinalReportSnapshot(ambiguousReport.layout.root),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_INVALID" &&
      /PROPERTY_REPORT_DECLARATION_AMBIGUOUS/iu.test(error.message)
  );
});

function reportGraphNode(id: string, outputs: ArtifactManifestOutputContract[]): PlannedGraphDocument["nodes"][number] {
  return {
    id,
    logical_id: id,
    display_name: id,
    kind: "agentic",
    depends_on: [],
    artifact_dir: `artifacts/${id}`,
    outputs,
    prompt_id: id,
    prompt_path: `review/${id}.md`,
    loop: { index: 0, count: 1, mode: "parallel", attempt_index: 0 },
    model_fanout: []
  };
}

function createSelectionLayout(runId: string, nodes: PlannedGraphDocument["nodes"]): RunLayout {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-verified-output-selection-"));
  const graph: PlannedGraphDocument = {
    schema_version: PLANNED_GRAPH_SCHEMA_VERSION,
    graph_version: "3",
    topology_version: 2,
    groups: {},
    nodes
  };
  return createRunLayout({
    outputRoot,
    runId,
    graph,
    graphFingerprint: "f".repeat(64),
    configFingerprint: "e".repeat(64),
    stateNodes: nodes.map((node) => ({
      id: node.id,
      logicalNodeId: node.logical_id,
      artifactDir: node.artifact_dir,
      outputs: node.outputs
    }))
  });
}

function createVerifiedReportFixture(
  runId: string,
  override: {
    report?: Record<string, unknown>;
    markdown?: string;
    outputs?: ArtifactManifestOutputContract[];
  } = {}
): ReportFixture {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-verified-output-"));
  const outputs = override.outputs ?? finalReportOutputs();
  const graph: PlannedGraphDocument = {
    schema_version: PLANNED_GRAPH_SCHEMA_VERSION,
    graph_version: "3",
    topology_version: 2,
    groups: {},
    nodes: [
      {
        id: REPORT_ATTEMPT_ID,
        logical_id: REPORT_LOGICAL_ID,
        display_name: "Final report",
        kind: "agentic",
        depends_on: [],
        artifact_dir: `artifacts/${REPORT_ATTEMPT_ID}`,
        outputs,
        prompt_id: REPORT_LOGICAL_ID,
        prompt_path: "review/final-report.md",
        loop: { index: 0, count: 1, mode: "parallel", attempt_index: 0 },
        model_fanout: []
      }
    ]
  };
  const layout = createRunLayout({
    outputRoot,
    runId,
    graph,
    graphFingerprint: "f".repeat(64),
    configFingerprint: "e".repeat(64),
    stateNodes: [
      {
        id: REPORT_ATTEMPT_ID,
        logicalNodeId: REPORT_LOGICAL_ID,
        artifactDir: `artifacts/${REPORT_ATTEMPT_ID}`,
        outputs
      }
    ]
  });
  const report = override.report ?? currentReport(runId);
  const projection = override.markdown === undefined ? projectCanonicalFinalReport(report) : undefined;
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  const markdownBytes = Buffer.from(override.markdown ?? projection!.markdown, "utf8");
  const reportPath = path.join(
    layout.artifactsDir,
    REPORT_ATTEMPT_ID,
    outputs.find((output) => output.contract === "ultrafuzz/report@2")?.path ?? REPORT_JSON_PATH
  );
  const markdownPath = path.join(
    layout.artifactsDir,
    REPORT_ATTEMPT_ID,
    outputs.find((output) => output.contract === "ultrafuzz/nonempty-markdown@1")?.path ?? REPORT_MARKDOWN_PATH
  );
  for (const output of outputs) {
    writeFileDurable(
      path.join(layout.artifactsDir, REPORT_ATTEMPT_ID, output.path),
      output.contract === "ultrafuzz/report@2" ? reportBytes : markdownBytes
    );
  }

  writeArtifactManifest({
    layout,
    nodeId: REPORT_ATTEMPT_ID,
    include: outputs.map((output) => output.path),
    outputs,
    provenance: {
      producer_node_id: REPORT_ATTEMPT_ID,
      logical_node_id: REPORT_LOGICAL_ID,
      attempt_index: 0,
      loop_index: 0,
      model_index: 0,
      agent_ref: "Codex",
      workflow_run_id: WORKFLOW_RUN_ID,
      workflow_task_id: AGENT_TASK_ID,
      origin: "workflow",
      metadata: { concrete_node_id: REPORT_ATTEMPT_ID }
    }
  });
  const marker: ArtifactVerificationMarker = {
    schema_version: ARTIFACT_VERIFICATION_SCHEMA_VERSION,
    attempt_id: REPORT_ATTEMPT_ID,
    node_id: REPORT_LOGICAL_ID,
    artifacts: outputs.map((output) => ({
      ...output,
      sha256: digest(output.contract === "ultrafuzz/report@2" ? reportBytes : markdownBytes)
    })),
    publications: outputs.map((output) => ({
      path: output.path,
      sha256: digest(output.contract === "ultrafuzz/report@2" ? reportBytes : markdownBytes)
    }))
  };
  writeJsonDurable(path.join(layout.root, ".ultrafuzz-verification", `${REPORT_ATTEMPT_ID}.json`), marker);
  updateNodeState(layout, REPORT_ATTEMPT_ID, {
    status: "succeeded",
    finished_at: new Date().toISOString(),
    wait_since: undefined,
    wait_reason: undefined,
    next_eligible_action: undefined,
    provenance: {
      workflow: {
        run_id: WORKFLOW_RUN_ID,
        task_id: VERIFIER_TASK_ID,
        agent_task_id: AGENT_TASK_ID,
        verifier_task_id: VERIFIER_TASK_ID,
        state: "finished",
        attempt: 0
      },
      output_contracts: { ok: true, missing: [] }
    }
  });
  return { layout, reportPath, markdownPath, reportBytes, markdownBytes };
}

function finalReportOutputs(): ArtifactManifestOutputContract[] {
  const reportBinding = artifactContractSchemaBinding("ultrafuzz/report@2");
  assert.ok(reportBinding);
  return [
    {
      path: REPORT_MARKDOWN_PATH,
      contract: "ultrafuzz/nonempty-markdown@1",
      contract_digest: artifactContractDefinition("ultrafuzz/nonempty-markdown@1").digest,
      primary: true
    },
    {
      path: REPORT_JSON_PATH,
      contract: "ultrafuzz/report@2",
      contract_digest: artifactContractDefinition("ultrafuzz/report@2").digest,
      ...reportBinding,
      primary: false
    }
  ];
}

function currentReport(runId: string, issues: Record<string, unknown>[] = []): Record<string, unknown> {
  return {
    schema_version: "ultrafuzz.report.v2",
    run_metadata: {
      run_id: runId,
      source_run_id: runId,
      repository: "example/repository",
      elapsed_time: "1m",
      models_used: ["model-a"],
      tokens_used: "100",
      estimated_spend: "$0.01",
      partial_pricing: false,
      strategy_loops: 1
    },
    issues,
    non_production_outcomes: [],
    property_provenance: [],
    property_implementation_coverage: {
      priority_threshold: "high",
      priorities: ["high"],
      selected_property_ids: [],
      implemented_property_ids: [],
      blocked_property_ids: [],
      pending_property_ids: [],
      deferred_property_ids: [],
      reference_expected_property_ids: [],
      reference_expectation_ids: [],
      blocker_summaries: []
    }
  };
}

function currentIssue(): Record<string, unknown> {
  return {
    schema_version: "ultrafuzz.finding.v2",
    id: "M-01",
    title: "[M-01] - Current finding",
    status: "confirmed",
    severity_guess: "Medium",
    confidence: "high",
    summary: "A bounded state transition violates the expected relationship.",
    description: "A caller can reach a state that violates the documented relationship.",
    severity: "Medium",
    impact: "Medium",
    likelihood: "Medium",
    impact_rationale: "The affected state remains bounded.",
    likelihood_rationale: "The transition uses ordinary preconditions.",
    severity_rationale: "Medium impact and Medium likelihood map to Medium.",
    proof_of_concept: {
      scenario: ["Prepare the bounded state.", "Execute the transition and observe the mismatch."],
      language: "solidity",
      code: "function testCurrentFinding() public {}"
    },
    strategy: "stateful-invariant",
    strategy_provenance: {
      detection_rates: [{ strategy: "stateful-invariant", detections: 1, configured_loops: 1 }]
    },
    lifecycle: {
      dedupe_key: "current-finding",
      source_artifacts: [],
      strategy_hits: [],
      canonical_severity: "Medium"
    }
  };
}

function digest(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
