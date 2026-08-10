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
import {
  loadVerifiedFinalReportSnapshot,
  loadVerifiedNodeOutputSnapshot,
  VerifiedOutputError
} from "../src/verified-output.js";

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

interface CampaignAuthorityFixture {
  layout: RunLayout;
  evidencePath: string;
  evidenceBytes: Buffer;
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

test("verified campaign reader requires every declared evidence file in verifier publications", () => {
  const fixture = createVerifiedCampaignFixture("verified-campaign-missing-publication", {
    omitEvidencePublication: true
  });

  assert.throws(
    () =>
      loadVerifiedNodeOutputSnapshot({
        runRoot: fixture.layout.root,
        logicalNodeId: "stateful-invariant-campaign"
      }),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_AUTHORITY_INVALID" &&
      /does not publish campaign evidence/iu.test(error.message)
  );
});

test("verified campaign reader rejects post-finalization evidence mutation without repair", () => {
  const fixture = createVerifiedCampaignFixture("verified-campaign-mutated-evidence");
  const loaded = loadVerifiedNodeOutputSnapshot({
    runRoot: fixture.layout.root,
    logicalNodeId: "stateful-invariant-campaign"
  });
  assert.equal(
    loaded.outputs.some((output) => output.contract === "ultrafuzz/property-campaign@3"),
    true
  );

  const mutated = Buffer.alloc(fixture.evidenceBytes.length, 0x7a);
  fs.writeFileSync(fixture.evidencePath, mutated);

  assert.throws(
    () =>
      loadVerifiedNodeOutputSnapshot({
        runRoot: fixture.layout.root,
        logicalNodeId: "stateful-invariant-campaign"
      }),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_CHANGED" &&
      /digest\/size binding changed/iu.test(error.message)
  );
  assert.deepEqual(fs.readFileSync(fixture.evidencePath), mutated);
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

function createVerifiedCampaignFixture(
  runId: string,
  options: { omitEvidencePublication?: boolean } = {}
): CampaignAuthorityFixture {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-verified-campaign-"));
  const catalogId = "property-specification-fanin";
  const implementationId = "stateful-invariant-implement-properties";
  const campaignId = "stateful-invariant-campaign";
  const catalogOutputs = [boundOutput("properties.json", "ultrafuzz/properties@2", true)];
  const implementationOutputs = [
    boundOutput("implemented-properties.json", "ultrafuzz/implemented-properties@3", true)
  ];
  const campaignOutputs = [
    boundOutput("campaign-plan.json", "ultrafuzz/invariant-campaign-plan@1", false),
    boundOutput("campaign.json", "ultrafuzz/property-campaign@3", true),
    boundOutput("findings.json", "ultrafuzz/findings@2", false),
    boundOutput("campaign-summary.json", "ultrafuzz/campaign-summary@2", false)
  ];
  const graph: PlannedGraphDocument = {
    schema_version: PLANNED_GRAPH_SCHEMA_VERSION,
    graph_version: "3",
    topology_version: 2,
    groups: {},
    nodes: [
      plannedAgentNode(catalogId, catalogOutputs, []),
      plannedAgentNode(implementationId, implementationOutputs, [catalogId]),
      plannedAgentNode(campaignId, campaignOutputs, [implementationId])
    ]
  };
  const layout = createRunLayout({
    outputRoot,
    runId,
    graph,
    graphFingerprint: "f".repeat(64),
    configFingerprint: "e".repeat(64),
    stateNodes: [
      { id: catalogId, logicalNodeId: catalogId, artifactDir: `artifacts/${catalogId}`, outputs: catalogOutputs },
      {
        id: implementationId,
        logicalNodeId: implementationId,
        artifactDir: `artifacts/${implementationId}`,
        outputs: implementationOutputs
      },
      { id: campaignId, logicalNodeId: campaignId, artifactDir: `artifacts/${campaignId}`, outputs: campaignOutputs }
    ]
  });

  const paths = {
    corpus: "backends/recon/corpus",
    cache: "backends/recon/cache",
    log: "backends/recon/run.log",
    raw_results: "backends/recon/results.json",
    reproducers: "backends/recon/reproducers"
  } as const;
  const logBytes = Buffer.from("campaign complete\n", "utf8");
  const evidenceBytes = Buffer.from('{"executions":1}\n', "utf8");
  const catalog = {
    schema_version: "ultrafuzz.properties.v2",
    properties: [
      {
        id: "property-one",
        description: "Balances remain conserved.",
        category: "accounting",
        priority: "high",
        sources: [{ source_node_id: "property-specification-manual", source_property_id: "property-one" }]
      }
    ]
  };
  const implemented = {
    schema_version: "ultrafuzz.implemented-properties.v3",
    selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-one"] },
    properties: [
      {
        property_id: "property-one",
        status: "implemented",
        implementation_paths: ["test/recon/Properties.sol"],
        test_paths: []
      }
    ]
  };
  const plan = {
    schema_version: "ultrafuzz.invariant-campaign-plan.v1",
    available_vcpus: 1,
    workers: 1,
    configured_budget_seconds: 600,
    deadline: "2026-01-01T00:10:00Z",
    finalization_reserve_seconds: 60,
    backend: { name: "recon", version: null },
    command_plan: [{ phase: "campaign", command: "recon fuzz ." }],
    paths
  };
  const campaign = {
    schema_version: "ultrafuzz.property-campaign.v3",
    campaign_plan_ref: "campaign-plan.json",
    implemented_properties_ref: "implemented-properties.json",
    findings_ref: "findings.json",
    campaign_summary_ref: "campaign-summary.json",
    fuzzer_backend: "recon",
    backend_version: null,
    execution: {
      status: "complete",
      usable_results: true,
      command: "recon fuzz .",
      config_path: null,
      workers: 1,
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T00:05:00Z",
      deadline: "2026-01-01T00:10:00Z",
      exit_code: 0,
      failure: null
    },
    paths,
    evidence_files: [
      { path: paths.log, size_bytes: logBytes.length, sha256: digest(logBytes) },
      { path: paths.raw_results, size_bytes: evidenceBytes.length, sha256: digest(evidenceBytes) }
    ],
    coverage: {
      status: "reported",
      metrics: [{ name: "executions", value: 1, unit: "count", source_ref: paths.raw_results }],
      unavailable_reason: null
    },
    property_results: [
      {
        property_id: "property-one",
        status: "passed",
        failure_ids: [],
        coverage_metric_names: ["executions"],
        evidence_refs: [paths.raw_results],
        reason: null
      }
    ],
    failures: []
  };
  const summary = {
    schema_version: "ultrafuzz.campaign-summary.v2",
    outcome: "complete",
    implemented_property_suite_refs: ["implemented-properties.json"],
    campaign_plan_ref: "campaign-plan.json",
    backend_results: [{ fuzzer_backend: "recon", status: "complete", result_ref: "campaign.json" }],
    finding_refs: [],
    reproducer_refs: [],
    failure_counts: { pre_deduplication: 0, post_deduplication: 0 }
  };

  writeJsonArtifact(layout, catalogId, "properties.json", catalog);
  writeJsonArtifact(layout, implementationId, "implemented-properties.json", implemented);
  const planBytes = writeJsonArtifact(layout, campaignId, "campaign-plan.json", plan);
  const campaignBytes = writeJsonArtifact(layout, campaignId, "campaign.json", campaign);
  const findingsBytes = writeJsonArtifact(layout, campaignId, "findings.json", []);
  const summaryBytes = writeJsonArtifact(layout, campaignId, "campaign-summary.json", summary);
  const campaignDir = path.join(layout.artifactsDir, campaignId);
  const logPath = path.join(campaignDir, paths.log);
  const evidencePath = path.join(campaignDir, paths.raw_results);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  writeFileDurable(logPath, logBytes);
  writeFileDurable(evidencePath, evidenceBytes);

  writeArtifactManifest({
    layout,
    nodeId: catalogId,
    outputs: catalogOutputs,
    provenance: manifestProvenance(catalogId, "node:property-catalog")
  });
  writeArtifactManifest({
    layout,
    nodeId: implementationId,
    outputs: implementationOutputs,
    prerequisiteNodeIds: [catalogId],
    provenance: manifestProvenance(implementationId, "node:implemented-properties")
  });
  writeArtifactManifest({
    layout,
    nodeId: campaignId,
    outputs: campaignOutputs,
    prerequisiteNodeIds: [implementationId],
    provenance: manifestProvenance(campaignId, "node:campaign")
  });

  const outputBytes = new Map<string, Buffer>([
    ["campaign-plan.json", planBytes],
    ["campaign.json", campaignBytes],
    ["findings.json", findingsBytes],
    ["campaign-summary.json", summaryBytes]
  ]);
  const publicationBytes = new Map<string, Buffer>([
    ...outputBytes,
    [paths.log, logBytes],
    [paths.raw_results, evidenceBytes]
  ]);
  if (options.omitEvidencePublication) publicationBytes.delete(paths.raw_results);
  const marker: ArtifactVerificationMarker = {
    schema_version: ARTIFACT_VERIFICATION_SCHEMA_VERSION,
    attempt_id: campaignId,
    node_id: campaignId,
    artifacts: campaignOutputs.map((output) => ({ ...output, sha256: digest(outputBytes.get(output.path)!) })),
    publications: [...publicationBytes].map(([publicationPath, bytes]) => ({
      path: publicationPath,
      sha256: digest(bytes)
    }))
  };
  writeJsonDurable(path.join(layout.root, ".ultrafuzz-verification", `${campaignId}.json`), marker);
  updateNodeState(layout, campaignId, {
    status: "succeeded",
    finished_at: new Date().toISOString(),
    wait_since: undefined,
    wait_reason: undefined,
    next_eligible_action: undefined,
    provenance: {
      workflow: {
        run_id: WORKFLOW_RUN_ID,
        task_id: "verify:campaign",
        agent_task_id: "node:campaign",
        verifier_task_id: "verify:campaign",
        state: "finished",
        attempt: 0
      },
      output_contracts: { ok: true, missing: [] }
    }
  });

  return { layout, evidencePath, evidenceBytes };
}

function boundOutput(
  artifactPath: string,
  contract: ArtifactManifestOutputContract["contract"],
  primary: boolean
): ArtifactManifestOutputContract {
  return {
    path: artifactPath,
    contract,
    contract_digest: artifactContractDefinition(contract).digest,
    ...(artifactContractSchemaBinding(contract) ?? {}),
    primary
  };
}

function plannedAgentNode(
  id: string,
  outputs: ArtifactManifestOutputContract[],
  dependsOn: string[]
): PlannedGraphDocument["nodes"][number] {
  return {
    id,
    logical_id: id,
    display_name: id,
    kind: "agentic",
    depends_on: dependsOn,
    artifact_dir: `artifacts/${id}`,
    outputs,
    prompt_id: id,
    prompt_path: `${id}.md`,
    loop: { index: 0, count: 1, mode: "parallel", attempt_index: 0 },
    model_fanout: []
  };
}

function writeJsonArtifact(layout: RunLayout, nodeId: string, relativePath: string, value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  writeFileDurable(path.join(layout.artifactsDir, nodeId, relativePath), bytes);
  return bytes;
}

function manifestProvenance(
  nodeId: string,
  workflowTaskId: string
): Parameters<typeof writeArtifactManifest>[0]["provenance"] {
  return {
    producer_node_id: nodeId,
    logical_node_id: nodeId,
    attempt_index: 0,
    loop_index: 0,
    model_index: 0,
    agent_ref: "Codex",
    workflow_run_id: WORKFLOW_RUN_ID,
    workflow_task_id: workflowTaskId,
    origin: "workflow",
    metadata: { concrete_node_id: nodeId }
  };
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
