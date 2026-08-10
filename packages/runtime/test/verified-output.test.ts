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
const AGENT_TASK_ID = "node:final-report";
const VERIFIER_TASK_ID = "verify:final-report";

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

  assert.equal(loaded.authority.attempt_id, "final-report");
  assert.equal(loaded.authority.logical_node_id, "final-report");
  assert.equal(loaded.artifacts.source, "verified-agent-report");
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
  fs.rmSync(path.join(fixture.layout.root, ".ultrafuzz-verification", "final-report.json"));

  assert.throws(
    () => loadVerifiedFinalReportSnapshot(fixture.layout.root),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_AUTHORITY_INVALID" &&
      /incomplete or unreadable/iu.test(error.message)
  );
});

function createVerifiedReportFixture(
  runId: string,
  override: { report?: Record<string, unknown>; markdown?: string } = {}
): ReportFixture {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-verified-output-"));
  const outputs = finalReportOutputs();
  const graph: PlannedGraphDocument = {
    schema_version: PLANNED_GRAPH_SCHEMA_VERSION,
    graph_version: "3",
    topology_version: 2,
    groups: {},
    nodes: [
      {
        id: "final-report",
        logical_id: "final-report",
        display_name: "Final report",
        kind: "agentic",
        depends_on: [],
        artifact_dir: "artifacts/final-report",
        outputs,
        prompt_id: "final-report",
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
        id: "final-report",
        logicalNodeId: "final-report",
        artifactDir: "artifacts/final-report",
        outputs
      }
    ]
  });
  const report = override.report ?? currentReport(runId);
  const projection = override.markdown === undefined ? projectCanonicalFinalReport(report) : undefined;
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  const markdownBytes = Buffer.from(override.markdown ?? projection!.markdown, "utf8");
  const reportPath = path.join(layout.artifactsDir, "final-report", "report.json");
  const markdownPath = path.join(layout.artifactsDir, "final-report", "report.md");
  writeFileDurable(reportPath, reportBytes);
  writeFileDurable(markdownPath, markdownBytes);

  writeArtifactManifest({
    layout,
    nodeId: "final-report",
    include: ["report.md", "report.json"],
    outputs,
    provenance: {
      producer_node_id: "final-report",
      logical_node_id: "final-report",
      attempt_index: 0,
      loop_index: 0,
      model_index: 0,
      agent_ref: "Codex",
      workflow_run_id: WORKFLOW_RUN_ID,
      workflow_task_id: AGENT_TASK_ID,
      origin: "workflow",
      metadata: { concrete_node_id: "final-report" }
    }
  });
  const marker: ArtifactVerificationMarker = {
    schema_version: ARTIFACT_VERIFICATION_SCHEMA_VERSION,
    attempt_id: "final-report",
    node_id: "final-report",
    artifacts: outputs.map((output) => ({
      ...output,
      sha256: digest(output.path === "report.json" ? reportBytes : markdownBytes)
    })),
    publications: outputs.map((output) => ({
      path: output.path,
      sha256: digest(output.path === "report.json" ? reportBytes : markdownBytes)
    }))
  };
  writeJsonDurable(path.join(layout.root, ".ultrafuzz-verification", "final-report.json"), marker);
  updateNodeState(layout, "final-report", {
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
      output_contracts: {
        ok: true,
        missing: [],
        artifact_manifest_sha256: digest(
          fs.readFileSync(path.join(layout.artifactsDir, "final-report", "artifact-manifest.json"))
        )
      }
    }
  });
  return { layout, reportPath, markdownPath, reportBytes, markdownBytes };
}

function finalReportOutputs(): ArtifactManifestOutputContract[] {
  const reportBinding = artifactContractSchemaBinding("ultrafuzz/report@2");
  assert.ok(reportBinding);
  return [
    {
      path: "report.md",
      contract: "ultrafuzz/nonempty-markdown@1",
      contract_digest: artifactContractDefinition("ultrafuzz/nonempty-markdown@1").digest,
      primary: true
    },
    {
      path: "report.json",
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
