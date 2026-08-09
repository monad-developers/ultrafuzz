import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  EVENT_SCHEMA_VERSION,
  PLANNED_GRAPH_SCHEMA_VERSION,
  STATE_SCHEMA_VERSION,
  artifactContractDefinition,
  artifactContractSchemaBinding,
  type NodeState,
  type PlannedGraphDocument,
  type RunState
} from "@ultrafuzz/artifacts";

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
    schema_version: "ultrafuzz.eval.run.v2",
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
    schema_version: "ultrafuzz.eval.v1",
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
    metrics: { primary: ["precision", "recall", "f1_score"], recall_threshold: 0.7, secondary: [] },
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
    variant: { id: "baseline", prompt_overlay_paths: [] },
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
    schema_version: "ultrafuzz.eval.run.v2",
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
    runtime_seconds: 60,
    cost_estimate: 0.01,
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

export function currentScoreSummary(input: {
  row: EvalMatrixRow;
  evalRunRoot: string;
  evalRunId?: string;
  overrides?: Partial<EvalScoreSummary>;
}): EvalScoreSummary {
  const row = currentRowScore(input.row);
  return {
    schema_version: "ultrafuzz.eval.score-summary.v1",
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

export interface JournalEventInput {
  event_id: string;
  event_type: string;
  timestamp: string;
  node_id?: string;
  status?: string;
  payload?: unknown;
}

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
      .map((event) => JSON.stringify({ schema_version: EVENT_SCHEMA_VERSION, run_id: runId, payload: {}, ...event }))
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
          schema_version: "ultrafuzz.artifact-manifest.v2",
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
