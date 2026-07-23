import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
  EvalRecoveryEquivalence,
  EvalRecoveryEquivalenceSummary,
  EvalReportingPolicy,
  EvalRowScore,
  EvalSuiteSpec
} from "../src/types.js";

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
      include: ["report.md", "report.json", "findings.normalized.json"],
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
        sensitivity: "private",
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
      .map((event) => JSON.stringify({ schema_version: "1.0", run_id: runId, payload: {}, ...event }))
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
          schema_version: "1.0",
          run_id: runId,
          node_id: nodeId,
          producer_node_id: nodeId,
          created_at: "2026-07-09T00:00:00.000Z",
          files: manifestFiles,
          provenance: { producer_node_id: nodeId }
        },
        null,
        2
      ),
      "utf8"
    );
  }
}
