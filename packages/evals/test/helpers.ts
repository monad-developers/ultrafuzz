import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  ARTIFACT_VERIFICATION_SCHEMA_VERSION,
  EVENT_SCHEMA_VERSION,
  PLANNED_GRAPH_SCHEMA_VERSION,
  SMITHERS_TASK_MANIFEST_SCHEMA_VERSION,
  SMITHERS_TASK_METADATA_SCHEMA_VERSION,
  STATE_SCHEMA_VERSION,
  assertEventRecord,
  artifactContractDefinition,
  artifactContractSchemaBinding,
  layoutForRunRoot,
  sha256Bytes,
  writeArtifactManifest,
  writeFileDurable,
  writeJsonDurable,
  type ArtifactManifestOutputContract,
  type ArtifactVerificationMarker,
  type EventRecord,
  type NodeState,
  type PlannedGraphDocument,
  type RunLayout,
  type RunState,
  type SmithersTaskManifestDocument,
  type SmithersTaskManifestTask
} from "@ultrafuzz/artifacts";
import { WORKFLOW_CONTROL_INTEGRITY_SCHEMA_VERSION, projectCanonicalFinalReport } from "@ultrafuzz/runtime";

import type {
  EvalArtifactUpload,
  EvalNodeEventEnvelope,
  EvalPlan,
  EvalReporter,
  EvalRowGraph,
  EvalRowResult,
  EvalSummary
} from "../src/reporter.js";
import type {
  EvalMatrixRow,
  EvalRunProvenance,
  EvalRecoveryEquivalence,
  EvalRecoveryEquivalenceSummary,
  EvalReportAuthority,
  EvalReportingPolicy,
  EvalRunExpansion,
  EvalRunManifest,
  EvalRowScore,
  EvalRunRecord,
  EvalScoreSummary,
  EvalSummaryProvenance,
  EvalSuiteSpec
} from "../src/types.js";

const TEST_TIMESTAMP = "2026-07-09T00:00:00.000Z";
const TEST_FINISHED_TIMESTAMP = "2026-07-09T00:01:00.000Z";
const TEST_SHA256 = "0".repeat(64);
const TEST_SHA40 = "0".repeat(40);

export function initializeTestGitRepository(projectRoot: string): string {
  fs.mkdirSync(projectRoot, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: projectRoot });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Ultrafuzz Tests",
      "-c",
      "user.email=ultrafuzz-tests@example.invalid",
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "test candidate"
    ],
    { cwd: projectRoot }
  );
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
}

export function cleanRecoveryEquivalence(overrides: Partial<EvalRecoveryEquivalence> = {}): EvalRecoveryEquivalence {
  return {
    schema_version: "ultrafuzz.eval.recovery-equivalence.v1",
    policy: { max_repeated_model_executions: 0 },
    unique_model_backed_node_executions: 1,
    repeated_model_backed_node_executions: 0,
    recovery_reexecuted_model_backed_node_executions: 0,
    infrastructure_only_recovery_generations: 0,
    model_work_recovery_generations: 0,
    no_progress_recovery_generations: 0,
    recovery_generations: 0,
    observed_node_attempts: 1,
    observed_workflow_executions: 1,
    observed_controller_invocations: 1,
    classification: "clean",
    reason: null,
    ...overrides
  };
}

export function testRunProvenance(overrides: Partial<EvalRunProvenance> = {}): EvalRunProvenance {
  return {
    candidate: { label: "test-candidate", commit: TEST_SHA40, dirty: false },
    benchmark: {
      availability: "available",
      series: "test-series",
      protocol_revision: "test-protocol-v1",
      cohort_fingerprint: TEST_SHA256,
      targets: [{ id: "target-a", repo: "https://example.com/target-a", commit: TEST_SHA40, dirty: false }],
      ground_truth_sha256: { "target-a": TEST_SHA256 },
      ground_truth_subjects: {},
      execution_policy: {
        revision: "test-execution-policy-v1",
        fingerprint: TEST_SHA256,
        max_parallel_targets: null,
        max_parallel_runs: 1,
        node_telemetry: true,
        heartbeat_interval_seconds: 60,
        controller_mode: "watch",
        watch_timeout_seconds: 60,
        poll_interval_ms: 100,
        recovery_equivalence_fingerprint: TEST_SHA256
      }
    },
    ...overrides
  };
}

export function testSummaryProvenance(overrides: Partial<EvalSummaryProvenance> = {}): EvalSummaryProvenance {
  const run = testRunProvenance();
  return {
    availability: "available",
    candidate: run.candidate,
    benchmark: run.benchmark,
    scoring: {
      implementation_revision: TEST_SHA40,
      implementation_dirty: false,
      judge_mode: "deterministic",
      judge_prompt_version: "test-judge-v1",
      judge_models: ["gpt-test"],
      judge_panel: { total: 1, quorum: 1 },
      ground_truth_sha256: { "target-a": TEST_SHA256 },
      ground_truth_subjects: {},
      fingerprint: TEST_SHA256
    },
    ...overrides
  };
}

export function currentRunManifest(input: {
  suite: EvalSuiteSpec;
  projectRoot: string;
  evalRunId?: string;
  overrides?: Partial<EvalRunManifest>;
}): EvalRunManifest {
  return {
    schema_version: "ultrafuzz.eval.run.v3",
    eval_run_id: input.evalRunId ?? "eval-test",
    suite_path: path.join(input.projectRoot, "eval.yml"),
    project_root: input.projectRoot,
    created_at: TEST_TIMESTAMP,
    suite: input.suite,
    provenance: testRunProvenance(),
    ...input.overrides
  };
}

export function recoveryEquivalenceSummary(
  overrides: Partial<EvalRecoveryEquivalenceSummary> = {}
): EvalRecoveryEquivalenceSummary {
  return {
    aggregate_non_comparable: "include",
    included_row_count: 0,
    excluded_row_count: 0,
    classification_counts: {
      clean: 0,
      "infrastructure-recovered": 0,
      "model-reexecuted-within-policy": 0,
      "non-comparable": 0
    },
    non_comparable_variants: [],
    ...overrides
  };
}

export function testReportingPolicy(overrides: Partial<EvalReportingPolicy> = {}): EvalReportingPolicy {
  return {
    node_telemetry: true,
    heartbeat_interval_seconds: 60,
    artifacts: {
      mode: "manifest-only",
      include: ["report.md", "report.json"],
      max_file_bytes: 5_000_000,
      mode_explicit: false
    },
    ...overrides
  };
}

export function testSuite(groundTruthRoot: string, overrides: Partial<EvalSuiteSpec> = {}): EvalSuiteSpec {
  return {
    schema_version: "ultrafuzz.eval.v2",
    suite: "bug-finding-regression",
    ground_truth_root: groundTruthRoot,
    model_profiles: {
      "eval-runner": { agent: "CodexAgent", model: "gpt-5.4-mini", reasoning: "high" },
      "eval-judge": { agent: "CodexAgent", model: "gpt-5.5", reasoning: "xhigh" }
    },
    targets: [
      {
        id: "target-a",
        repo: "https://example.com/target-a",
        ref: "v1.0.0",
        ground_truth: "target-a.yml"
      }
    ],
    variants: [{ id: "baseline" }],
    run: {
      runner_model_profile: "eval-runner",
      judge_model_profile: "eval-judge",
      trials_per_variant: 1
    },
    metrics: { recall_threshold: 0.7 },
    recovery_equivalence: {
      max_repeated_model_executions: 0,
      aggregate_non_comparable: "include",
      publication: "comparable"
    },
    reporting: testReportingPolicy(),
    ...overrides
  };
}

export function testRow(suite: EvalSuiteSpec, overrides: Partial<EvalMatrixRow> = {}): EvalMatrixRow {
  const target = suite.targets[0]!;
  return {
    id: "target-a-baseline-trial-1",
    target_id: target.id,
    variant_id: "baseline",
    trial_id: "trial-1",
    run_id: "bug-finding-regression-target-a-baseline-trial-1",
    target: { ...target, ground_truth_path: path.join(suite.ground_truth_root ?? "/", target.ground_truth) },
    variant: { id: "baseline" },
    runner_model_profile: suite.run.runner_model_profile,
    judge_model_profile: suite.run.judge_model_profile,
    judge_model: "gpt-5.5",
    ...overrides
  };
}

export function currentRunState(
  input: {
    runId?: string;
    status?: RunState["status"];
    nodes?: Record<string, Partial<NodeState>>;
    overrides?: Partial<RunState>;
  } = {}
): RunState {
  const status = input.status ?? "succeeded";
  const terminal = ["succeeded", "failed", "timed-out", "canceled"].includes(status);
  const nodes = Object.fromEntries(
    Object.entries(input.nodes ?? { "final-report": {} }).map(([nodeId, overrides]) => [
      nodeId,
      {
        node_id: nodeId,
        status: "succeeded",
        retry_count: 0,
        timed_out: false,
        started_at: TEST_TIMESTAMP,
        finished_at: TEST_FINISHED_TIMESTAMP,
        ...overrides
      } satisfies NodeState
    ])
  );
  return {
    schema_version: STATE_SCHEMA_VERSION,
    run_id: input.runId ?? "run-1",
    status,
    graph_fingerprint: TEST_SHA256,
    config_fingerprint: TEST_SHA256,
    created_at: TEST_TIMESTAMP,
    ...(status === "pending" ? {} : { started_at: TEST_TIMESTAMP }),
    ...(terminal ? { finished_at: TEST_FINISHED_TIMESTAMP } : {}),
    last_transition_at: terminal ? TEST_FINISHED_TIMESTAMP : TEST_TIMESTAMP,
    controller_lease: {
      status: "active",
      duration_ms: 30_000,
      renewed_at: TEST_TIMESTAMP,
      expires_at: TEST_FINISHED_TIMESTAMP,
      recovery_attempts: 0
    },
    concurrency: {
      requested_concurrency: 1,
      effective_concurrency: terminal ? 0 : 1,
      ready_queue_depth: 0,
      active_work: terminal ? 0 : 1,
      queued_duration_ms: 0,
      active_duration_ms: terminal ? 60_000 : 0,
      idle_duration_ms: 0,
      observed_at: terminal ? TEST_FINISHED_TIMESTAMP : TEST_TIMESTAMP
    },
    nodes,
    ...input.overrides
  };
}

export function currentPlannedGraph(
  nodeIds: readonly string[] = ["final-report"],
  reportNodeId: string | undefined = "final-report"
): PlannedGraphDocument {
  return {
    schema_version: PLANNED_GRAPH_SCHEMA_VERSION,
    graph_version: "3",
    topology_version: 2,
    groups: { default: {} },
    nodes: nodeIds.map((nodeId) => {
      const isReport = nodeId === reportNodeId;
      const contract = isReport ? "ultrafuzz/report@2" : "ultrafuzz/text@1";
      const binding = artifactContractSchemaBinding(contract);
      return {
        id: nodeId,
        logical_id: nodeId,
        display_name: nodeId,
        kind: "agentic",
        depends_on: [],
        artifact_dir: `artifacts/${nodeId}`,
        outputs: [
          {
            path: isReport ? "report.json" : "output.txt",
            contract,
            contract_digest: artifactContractDefinition(contract).digest,
            ...(binding ?? {}),
            primary: true
          }
        ],
        prompt_id: nodeId,
        prompt_path: `.ultrafuzz/prompts/${nodeId}.mdx`,
        loop: { index: 0, count: 1, mode: "parallel", attempt_index: 0 },
        model_fanout: [
          {
            model_profile_id: "test-model",
            agent_ref: "CodexAgent",
            model_index: 0,
            loop_index: 0,
            attempt_index: 0
          }
        ]
      };
    })
  };
}

export function currentEvalRunRecord(input: {
  row: EvalMatrixRow;
  runRoot: string;
  runId?: string;
  evalRunId?: string;
  overrides?: Partial<EvalRunRecord>;
}): EvalRunRecord {
  const runId = input.runId ?? "run-1";
  return {
    schema_version: "ultrafuzz.eval.run.v3",
    eval_run_id: input.evalRunId ?? "eval-test",
    row_id: input.row.id,
    target_id: input.row.target_id,
    variant_id: input.row.variant_id,
    trial_id: input.row.trial_id,
    ultrafuzz_run_id: runId,
    ultrafuzz_run_root: input.runRoot,
    report_json_path: path.join(input.runRoot, "artifacts", "final-report", "report.json"),
    status: "launched",
    final_status: "succeeded",
    graph_fingerprint: TEST_SHA256,
    config_fingerprint: TEST_SHA256,
    candidate_commit: TEST_SHA40,
    workflow_ids: [`workflow-${runId}`],
    launcher: { status: "succeeded", started_at: TEST_TIMESTAMP, finished_at: TEST_TIMESTAMP },
    workflow: {
      status: "succeeded",
      terminal: true,
      started_at: TEST_TIMESTAMP,
      finished_at: TEST_FINISHED_TIMESTAMP
    },
    recovery_equivalence: cleanRecoveryEquivalence(),
    diagnostics: [],
    ...input.overrides
  };
}

export function currentRunExpansion(overrides: Partial<EvalRunExpansion> = {}): EvalRunExpansion {
  return {
    node_count: 1,
    status_counts: {
      pending: 0,
      ready: 0,
      runnable: 0,
      running: 0,
      succeeded: 1,
      failed: 0,
      skipped: 0,
      "timed-out": 0,
      "reused-from-prior-run": 0,
      invalidated: 0
    },
    static_node_count: 1,
    dynamic_node_count: 0,
    dynamic_status_counts: {
      pending: 0,
      ready: 0,
      runnable: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      "timed-out": 0,
      "reused-from-prior-run": 0,
      invalidated: 0
    },
    dynamic_nodes: [],
    retried_node_count: 0,
    failed_node_count: 0,
    failed_node_ids: [],
    timed_out_node_count: 0,
    timed_out_node_ids: [],
    concurrency: { requested: 1, effective: 0, ready_queue_depth: 0, active_work: 0 },
    truncated: false,
    nodes: { status: "complete", reason: null },
    lineage: { status: "complete", reason: null },
    concurrency_evidence: { status: "complete", reason: null },
    ...overrides
  };
}

export function currentRowScore(row: EvalMatrixRow, overrides: Partial<EvalRowScore> = {}): EvalRowScore {
  return {
    row_id: row.id,
    target_id: row.target_id,
    variant_id: row.variant_id,
    trial_id: row.trial_id,
    report_authority: testReportAuthority(row),
    report_schema_valid: true,
    ground_truth_bug_count: 1,
    finding_count: 1,
    true_positives: 1,
    false_positives: 0,
    missed: 0,
    human_review_queue_count: 0,
    duplicate_count: 0,
    precision: 1,
    recall: 1,
    f1_score: 1,
    full_match_rate: 1,
    severity_accuracy: 1,
    true_positive_accuracy: 1,
    duplicate_rate: 0,
    lifecycle: {
      launcher: { status: "succeeded", started_at: TEST_TIMESTAMP, finished_at: TEST_TIMESTAMP },
      workflow: {
        status: "succeeded",
        terminal: true,
        started_at: TEST_TIMESTAMP,
        finished_at: TEST_FINISHED_TIMESTAMP
      }
    },
    efficiency: {
      wall_time_seconds: 60,
      active_time_seconds: 60,
      wait_time_seconds: 0,
      total_tokens: 15,
      cost_usd: 0.01,
      runtime: { status: "complete", reason: null },
      usage: { status: "complete", reason: null },
      cost: { status: "complete", reason: null }
    },
    expansion: currentRunExpansion(),
    recovery_equivalence: cleanRecoveryEquivalence(),
    ...overrides
  };
}

export function testReportAuthority(
  row: Pick<EvalMatrixRow, "run_id">,
  overrides: Partial<EvalReportAuthority> = {}
): EvalReportAuthority {
  const reportRoot = path.join("/tmp", row.run_id, "artifacts", "final-report");
  return {
    ultrafuzz_run_id: row.run_id,
    producer_attempt_id: `${row.run_id}:final-report:attempt-1`,
    graph_fingerprint: TEST_SHA256,
    config_fingerprint: TEST_SHA256,
    report_json_path: path.join(reportRoot, "final-report.json"),
    report_json_sha256: TEST_SHA256,
    report_markdown_path: path.join(reportRoot, "final-report.md"),
    report_markdown_sha256: TEST_SHA256,
    contract: "ultrafuzz/report@2",
    contract_digest: TEST_SHA256,
    schema_id: "urn:ultrafuzz:schema:artifacts:final-report:2",
    schema_sha256: TEST_SHA256,
    schema_bundle_sha256: TEST_SHA256,
    validator_build: "ultrafuzz-test-validator",
    ...overrides
  };
}

export function currentScoreSummary(input: {
  row: EvalMatrixRow;
  evalRunRoot: string;
  evalRunId?: string;
  rowOverrides?: Partial<EvalRowScore>;
  overrides?: Partial<EvalScoreSummary>;
}): EvalScoreSummary {
  const row = currentRowScore(input.row, input.rowOverrides);
  return {
    schema_version: "ultrafuzz.eval.score-summary.v2",
    eval_run_id: input.evalRunId ?? "eval-test",
    eval_run_root: input.evalRunRoot,
    recall_threshold: 0.7,
    rows: [row],
    variants: [
      {
        variant_id: row.variant_id,
        row_count: 1,
        precision: 1,
        recall: 1,
        f1_score: 1,
        full_match_rate: 1,
        human_review_queue_count: 0,
        duplicate_rate: 0,
        report_schema_valid_rate: 1
      }
    ],
    scores_path: path.join(input.evalRunRoot, "scores.jsonl"),
    summary_path: path.join(input.evalRunRoot, "summary.json"),
    review_queue_path: path.join(input.evalRunRoot, "review", "new-findings.jsonl"),
    recovery_equivalence: {
      aggregate_non_comparable: "include",
      included_row_count: 1,
      excluded_row_count: 0,
      classification_counts: {
        clean: 1,
        "infrastructure-recovered": 0,
        "model-reexecuted-within-policy": 0,
        "non-comparable": 0
      },
      non_comparable_variants: []
    },
    provenance: testSummaryProvenance(),
    ...input.overrides
  };
}

export function writeCurrentRunEvidence(input: {
  runRoot: string;
  runId?: string;
  state?: RunState;
  graph?: PlannedGraphDocument;
  accounting?: Record<string, unknown>;
}): void {
  const runId = input.runId ?? "run-1";
  fs.mkdirSync(input.runRoot, { recursive: true });
  fs.writeFileSync(
    path.join(input.runRoot, "state.json"),
    `${JSON.stringify(input.state ?? currentRunState({ runId }), null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(input.runRoot, "graph.json"),
    `${JSON.stringify(input.graph ?? currentPlannedGraph(), null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(input.runRoot, "run.json"),
    `${JSON.stringify(
      {
        accounting: {
          cumulative: input.accounting ?? {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            reasoning_tokens: 0,
            total_tokens: 15,
            estimated_spend_usd: 0.01,
            usage_complete: true,
            pricing_complete: true,
            partial_pricing: false,
            event_count: 1,
            priced_event_count: 1,
            unpriced_event_count: 0
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

export function writeVerifiedFinalReport(input: {
  runRoot: string;
  runId?: string;
  report?: Record<string, unknown>;
  accounting?: Record<string, unknown>;
  reportJsonRelativePath?: string;
}): { reportPath: string; markdownPath: string; reportBytes: Buffer; markdownBytes: Buffer } {
  const runId = input.runId ?? path.basename(input.runRoot);
  const report =
    input.report ??
    ({
      schema_version: "ultrafuzz.report.v2",
      run_metadata: {
        run_id: runId,
        source_run_id: runId,
        repository: "https://example.com/target-a",
        elapsed_time: "0s",
        models_used: ["gpt-test"],
        tokens_used: "0",
        estimated_spend: "$0",
        partial_pricing: false,
        strategy_loops: 0,
        audit_profile: "full",
        audit_profile_catalog_digest: "a".repeat(64),
        topology_digest: "b".repeat(64),
        prompt_digest: "c".repeat(64),
        expanded_graph_fingerprint: "d".repeat(64)
      },
      issues: [],
      non_production_outcomes: [],
      property_provenance: [],
      property_implementation_coverage: {
        status: "not-planned",
        reason: "property-implementation-track-not-declared"
      }
    } satisfies Record<string, unknown>);
  const projection = projectCanonicalFinalReport(report);
  const reportBytes = Buffer.from(`${JSON.stringify(projection.report, null, 2)}\n`, "utf8");
  const markdownBytes = Buffer.from(projection.markdown, "utf8");
  const outputs = verifiedFinalReportOutputs(input.reportJsonRelativePath);
  const graph = currentPlannedGraph();
  graph.nodes[0]!.outputs = outputs;
  graph.nodes[0]!.workflow = {
    node_id: "node:final-report",
    task_node_ids: ["node:final-report"]
  };
  const workflowRunId = `workflow-${runId}`;
  const agentTaskId = "node:final-report";
  const verifierTaskId = "verify:final-report";

  const layout = layoutForRunRoot(input.runRoot, runId);
  const reportPath = path.join(layout.artifactsDir, "final-report", input.reportJsonRelativePath ?? "report.json");
  const markdownPath = path.join(layout.artifactsDir, "final-report", "report.md");
  writeFileDurable(reportPath, reportBytes);
  writeFileDurable(markdownPath, markdownBytes);
  writeArtifactManifest({
    layout,
    nodeId: "final-report",
    include: outputs.map((output) => output.path),
    outputs,
    provenance: {
      producer_node_id: "final-report",
      logical_node_id: "final-report",
      attempt_index: 0,
      loop_index: 0,
      model_index: 0,
      agent_ref: "CodexAgent",
      workflow_run_id: workflowRunId,
      workflow_task_id: agentTaskId,
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
      sha256: sha256Bytes(output.contract === "ultrafuzz/report@2" ? reportBytes : markdownBytes)
    })),
    publications: outputs.map((output) => ({
      path: output.path,
      sha256: sha256Bytes(output.contract === "ultrafuzz/report@2" ? reportBytes : markdownBytes)
    }))
  };
  writeJsonDurable(path.join(layout.root, ".ultrafuzz-verification", "final-report.json"), marker);
  const manifestPath = path.join(layout.artifactsDir, "final-report", "artifact-manifest.json");
  const state = currentRunState({
    runId,
    nodes: {
      "final-report": {
        logical_node_id: "final-report",
        artifact_dir: "artifacts/final-report",
        outputs,
        provenance: {
          workflow: {
            run_id: workflowRunId,
            task_id: verifierTaskId,
            agent_task_id: agentTaskId,
            verifier_task_id: verifierTaskId,
            state: "finished",
            attempt: 0
          },
          output_contracts: {
            ok: true,
            missing: [],
            artifact_manifest_sha256: sha256Bytes(fs.readFileSync(manifestPath))
          }
        }
      }
    }
  });
  writeCurrentRunEvidence({
    runRoot: input.runRoot,
    runId,
    state,
    graph,
    ...(input.accounting === undefined ? {} : { accounting: input.accounting })
  });
  writeSealedFinalReportAuthority(layout, graph, outputs, workflowRunId);
  return { reportPath, markdownPath, reportBytes, markdownBytes };
}

function writeSealedFinalReportAuthority(
  layout: RunLayout,
  graph: PlannedGraphDocument,
  outputs: ArtifactManifestOutputContract[],
  workflowRunId: string
): void {
  const node = graph.nodes[0]!;
  const model = node.model_fanout[0]!;
  const artifactDir = path.join(layout.artifactsDir, "final-report");
  const workspacePath = path.join(layout.workspacesDir, "final-report");
  const taskOutputs = outputs.map((output) => ({
    path: output.path,
    contract: output.contract,
    contractDigest: output.contract_digest,
    ...(output.schema_file === undefined
      ? {}
      : {
          schemaFile: output.schema_file,
          schemaId: output.schema_id,
          schemaSha256: output.schema_sha256,
          schemaBundleSha256: output.schema_bundle_sha256,
          validatorBuild: output.validator_build
        }),
    primary: output.primary
  }));
  const resources = { cpu: 2, memoryMiB: 1_024, timeoutSeconds: 60 };
  const agentChain = [
    {
      profileId: model.model_profile_id,
      agentRef: model.agent_ref,
      role: "primary" as const
    }
  ];
  const task: SmithersTaskManifestTask = {
    attemptId: "final-report",
    concreteNodeId: node.id,
    logicalNodeId: node.logical_id,
    preparationSmithersNodeId: "prepare:final-report",
    smithersNodeId: "node:final-report",
    verifierSmithersNodeId: "verify:final-report",
    agentRef: model.agent_ref,
    agentChain,
    dependencies: [],
    dependencySmithersNodeIds: [],
    timeoutMs: 60_000,
    heartbeatTimeoutMs: 60_000,
    retries: 0,
    retryPolicy: { backoff: "exponential", initialDelayMs: 1_000 },
    workspacePath,
    artifactDir,
    dependencyArtifactDirs: [],
    renderedPromptPath: path.join(layout.root, "prompts", "final-report.md"),
    execution: { mode: "local", resources, agentCredentialEnv: [] },
    metadata: {
      schemaVersion: SMITHERS_TASK_METADATA_SCHEMA_VERSION,
      run: {
        ultrafuzzRunId: layout.runId,
        smithersWorkflowName: workflowRunId,
        graphVersion: "3",
        topologyVersion: 2
      },
      node: {
        concreteNodeId: node.id,
        logicalNodeId: node.logical_id,
        attemptId: "final-report",
        label: node.display_name,
        kind: "agentic",
        promptPath: node.prompt_path
      },
      dependencies: { concreteNodeIds: [], attemptIds: [], smithersNodeIds: [] },
      loop: {
        index: node.loop.index,
        count: node.loop.count,
        mode: node.loop.mode,
        attemptIndex: node.loop.attempt_index
      },
      model: {
        profileId: model.model_profile_id,
        agentRef: model.agent_ref,
        modelIndex: model.model_index,
        attemptIndex: model.attempt_index,
        agentChain
      },
      workspace: { primitive: "worktree", path: workspacePath, repoPath: "/repo", trustModel: "skip-permissions" },
      artifacts: {
        dir: artifactDir,
        outputs: taskOutputs,
        manifestPath: path.join(artifactDir, "artifact-manifest.json")
      },
      retryPolicy: { maxAttempts: 1, sameAgentAttempts: 1, smithersRetries: 0 },
      timeout: { milliseconds: 60_000, seconds: 60, heartbeatTimeoutMs: 60_000 },
      execution: { mode: "local", resources }
    }
  };
  const smithersRoot = path.join(layout.root, "smithers");
  const tasksPath = path.join(smithersRoot, "tasks.json");
  const document: SmithersTaskManifestDocument = {
    schema_version: SMITHERS_TASK_MANIFEST_SCHEMA_VERSION,
    run_id: layout.runId,
    smithers_run_id: `ultrafuzz-${layout.runId}`,
    workflow_name: workflowRunId,
    pinned_submodules: null,
    tasks: [task]
  };
  writeJsonDurable(tasksPath, document);

  const graphBytes = fs.readFileSync(layout.graphPath);
  const taskBytes = fs.readFileSync(tasksPath);
  const emptyFile = { sha256: sha256Bytes(Buffer.alloc(0)), size_bytes: 0 };
  writeJsonDurable(path.join(smithersRoot, "control-integrity.json"), {
    schema_version: WORKFLOW_CONTROL_INTEGRITY_SCHEMA_VERSION,
    run_id: layout.runId,
    files: {
      graph: { sha256: sha256Bytes(graphBytes), size_bytes: graphBytes.byteLength },
      expanded_graph: emptyFile,
      graph_fingerprint: emptyFile,
      config: emptyFile,
      tasks: { sha256: sha256Bytes(taskBytes), size_bytes: taskBytes.byteLength },
      input: emptyFile,
      workflow: emptyFile,
      evidence_workflow: emptyFile
    },
    execution_files: [],
    bindings: {
      run_id: layout.runId,
      graph_fingerprint: TEST_SHA256,
      config_fingerprint: TEST_SHA256,
      expected_state_node_ids: ["final-report"],
      expected_task_attempt_ids: ["final-report"],
      expected_task_node_ids: ["node:final-report", "prepare:final-report", "verify:final-report"].sort()
    }
  });
}

function verifiedFinalReportOutputs(reportJsonRelativePath = "report.json"): ArtifactManifestOutputContract[] {
  const reportBinding = artifactContractSchemaBinding("ultrafuzz/report@2");
  if (reportBinding === undefined) throw new Error("missing current report schema binding");
  return [
    {
      path: "report.md",
      contract: "ultrafuzz/nonempty-markdown@1",
      contract_digest: artifactContractDefinition("ultrafuzz/nonempty-markdown@1").digest,
      primary: true
    },
    {
      path: reportJsonRelativePath,
      contract: "ultrafuzz/report@2",
      contract_digest: artifactContractDefinition("ultrafuzz/report@2").digest,
      ...reportBinding,
      primary: false
    }
  ];
}

export interface RecordedCall {
  method: string;
  args: unknown[];
}

/** In-memory reporter that records every callback for exact-sequence assertions. */
export class RecordingReporter implements EvalReporter {
  readonly name: string;
  readonly calls: RecordedCall[] = [];
  failOn: Set<string> = new Set();

  constructor(name = "recording") {
    this.name = name;
  }

  envelopes(): EvalNodeEventEnvelope[] {
    return this.calls
      .filter((call) => call.method === "onNodeEvent")
      .map((call) => call.args[0] as EvalNodeEventEnvelope);
  }

  artifacts(): EvalArtifactUpload[] {
    return this.calls.filter((call) => call.method === "onArtifact").map((call) => call.args[0] as EvalArtifactUpload);
  }

  private record(method: string, args: unknown[]): Promise<void> {
    if (this.failOn.has(method)) {
      return Promise.reject(new Error(`${method} forced failure`));
    }
    this.calls.push({ method, args });
    return Promise.resolve();
  }

  onPlan(plan: EvalPlan): Promise<void> {
    return this.record("onPlan", [plan]);
  }

  onRowStart(row: EvalMatrixRow, graph: EvalRowGraph): Promise<void> {
    return this.record("onRowStart", [row, graph]);
  }

  onNodeEvent(envelope: EvalNodeEventEnvelope): Promise<void> {
    return this.record("onNodeEvent", [envelope]);
  }

  onArtifact(artifact: EvalArtifactUpload): Promise<void> {
    return this.record("onArtifact", [artifact]);
  }

  onRowFinish(row: EvalMatrixRow, result: EvalRowResult): Promise<void> {
    return this.record("onRowFinish", [row, result]);
  }

  onScores(scores: EvalRowScore[], summary: EvalSummary): Promise<void> {
    return this.record("onScores", [scores, summary]);
  }

  async finalize(summary: EvalSummary): Promise<{ url?: string }> {
    await this.record("finalize", [summary]);
    return { url: "https://example.com/experiment" };
  }
}

type JournalEventInputFor<RecordType> = RecordType extends EventRecord
  ? Omit<RecordType, "schema_version" | "run_id">
  : never;

export type JournalEventInput = JournalEventInputFor<EventRecord>;

export function writeRunFixture(input: {
  runRoot: string;
  runId?: string;
  events?: JournalEventInput[];
  state?: unknown;
  graph?: unknown;
  artifacts?: Record<string, Record<string, string>>;
}): void {
  fs.mkdirSync(input.runRoot, { recursive: true });
  const runId = input.runId ?? "run-1";
  if (input.events !== undefined) {
    const lines = input.events
      .map((event) =>
        JSON.stringify(assertEventRecord({ schema_version: EVENT_SCHEMA_VERSION, run_id: runId, ...event }))
      )
      .join("\n");
    fs.writeFileSync(path.join(input.runRoot, "events.jsonl"), lines.length > 0 ? `${lines}\n` : "", "utf8");
  }
  if (input.state !== undefined) {
    fs.writeFileSync(path.join(input.runRoot, "state.json"), JSON.stringify(input.state, null, 2), "utf8");
  }
  if (input.graph !== undefined) {
    fs.writeFileSync(path.join(input.runRoot, "graph.json"), JSON.stringify(input.graph, null, 2), "utf8");
  }
  for (const [nodeId, files] of Object.entries(input.artifacts ?? {})) {
    const nodeDir = path.join(input.runRoot, "artifacts", nodeId);
    fs.mkdirSync(nodeDir, { recursive: true });
    const manifestFiles = [];
    for (const [relativePath, contents] of Object.entries(files)) {
      const artifactPath = path.join(nodeDir, relativePath);
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
      fs.writeFileSync(artifactPath, contents, "utf8");
      manifestFiles.push({
        path: relativePath,
        size_bytes: Buffer.byteLength(contents, "utf8"),
        sha256: crypto.createHash("sha256").update(contents).digest("hex"),
        provenance: { producer_node_id: nodeId }
      });
    }
    fs.writeFileSync(
      path.join(nodeDir, "artifact-manifest.json"),
      JSON.stringify(
        {
          schema_version: "ultrafuzz.artifact-manifest.v3",
          run_id: runId,
          node_id: nodeId,
          producer_node_id: nodeId,
          created_at: "2026-07-09T00:00:00.000Z",
          files: manifestFiles,
          output_contracts: [],
          prerequisite_manifests: [],
          provenance: { producer_node_id: nodeId }
        },
        null,
        2
      ),
      "utf8"
    );
  }
}
