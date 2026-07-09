import type {
  EvalArtifactUpload,
  EvalNodeEventEnvelope,
  EvalPlan,
  EvalReporter,
  EvalRowGraph,
  EvalRowResult,
  EvalSummary
} from "../reporter.js";
import { groupsInGraph } from "../reporter.js";
import type { EvalMatrixRow, EvalReportingPolicy, EvalRowScore } from "../types.js";
import { EvalError, isRecord } from "../utils.js";

export interface BraintrustReporterOptions {
  apiKey: string;
  project: string;
  evalRunId: string;
  policy: EvalReportingPolicy;
  apiUrl?: string;
  appUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_API_URL = "https://api.braintrust.dev";
const DEFAULT_APP_URL = "https://www.braintrust.dev";
const INLINE_ARTIFACT_LIMIT_BYTES = 262_144;

interface RowProgress {
  total: number;
  done: number;
  active: number;
}

/**
 * Braintrust reporter: three-level span tree per matrix row
 * (row root → topology group → node attempt) on one experiment per eval run.
 *
 * Node spans are emitted terminal-time with explicit backdated start/end
 * metrics taken from the journal — no long-lived open spans, fully idempotent
 * (event ids are the journal `event_id`s). True DAG edges and topology
 * metadata ride along in span metadata.
 */
export class BraintrustReporter implements EvalReporter {
  readonly name = "braintrust";
  private readonly options: BraintrustReporterOptions;
  private readonly fetchImpl: typeof fetch;
  private projectId?: string;
  private experimentId?: string;
  private experimentName?: string;
  private readonly progress = new Map<string, RowProgress>();
  private readonly rowGraphs = new Map<string, EvalRowGraph>();

  constructor(options: BraintrustReporterOptions) {
    if (!options.apiKey) {
      throw new EvalError("EVAL_PROVIDER_CREDENTIALS_MISSING", "Braintrust reporter requires an API key");
    }
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async onPlan(plan: EvalPlan): Promise<void> {
    await this.ensureExperiment();
    await this.insertEvents([
      {
        id: `plan-${this.options.evalRunId}`,
        span_id: `plan-${this.options.evalRunId}`,
        root_span_id: `plan-${this.options.evalRunId}`,
        span_attributes: { name: "plan", type: "task" },
        input: { suite: plan.suite.suite, suite_path: plan.suite_path },
        output: {
          matrix_rows: plan.matrix.length,
          targets: plan.suite.targets.map((target) => target.id),
          variants: plan.suite.variants.map((variant) => variant.id)
        },
        metadata: { eval_run_id: this.options.evalRunId }
      }
    ]);
  }

  async onRowStart(row: EvalMatrixRow, graph: EvalRowGraph): Promise<void> {
    await this.ensureExperiment();
    this.rowGraphs.set(row.id, graph);
    this.progress.set(row.id, { total: graph.nodes.length, done: 0, active: 0 });
    const events: Array<Record<string, unknown>> = [
      {
        id: `row-${row.id}`,
        span_id: this.rowSpanId(row.id),
        root_span_id: this.rowSpanId(row.id),
        span_attributes: { name: `${row.target_id}/${row.variant_id}/${row.trial_id}`, type: "eval" },
        input: {
          target: row.target_id,
          variant: row.variant_id,
          trial: row.trial_id,
          repo: row.target.repo,
          ref: row.target.ref
        },
        metadata: {
          eval_run_id: this.options.evalRunId,
          row_id: row.id,
          runner_model_profile: row.runner_model_profile,
          judge_model_profile: row.judge_model_profile,
          node_count: graph.nodes.length,
          dag_edges: graph.nodes.map((node) => ({ id: node.id, depends_on: node.dependsOn }))
        }
      }
    ];
    for (const group of groupsInGraph(graph)) {
      events.push({
        id: `group-${row.id}-${group}`,
        span_id: this.groupSpanId(row.id, group),
        root_span_id: this.rowSpanId(row.id),
        span_parents: [this.rowSpanId(row.id)],
        span_attributes: { name: group, type: "task" },
        metadata: { row_id: row.id, group }
      });
    }
    await this.insertEvents(events);
  }

  async onNodeEvent(envelope: EvalNodeEventEnvelope): Promise<void> {
    const event = envelope.event;
    switch (event.type) {
      case "node-started": {
        const progress = this.progress.get(envelope.rowId);
        if (progress) {
          progress.active += 1;
        }
        // Terminal-time span emission: starts are tracked as row metrics only.
        await this.updateRowMetrics(envelope.rowId);
        return;
      }
      case "node-finished": {
        const progress = this.progress.get(envelope.rowId);
        if (progress) {
          progress.done += 1;
          progress.active = Math.max(0, progress.active - 1);
        }
        const startEpoch = epochSeconds(event.startedAt ?? event.at);
        const endEpoch = epochSeconds(event.at);
        await this.insertEvents([
          {
            id: envelope.eventId,
            span_id: this.nodeSpanId(envelope.rowId, envelope.nodeId, event.attempt),
            root_span_id: this.rowSpanId(envelope.rowId),
            span_parents: [this.groupSpanId(envelope.rowId, this.groupForNode(envelope.rowId, envelope.nodeId))],
            span_attributes: {
              name: event.attempt > 1 ? `${envelope.nodeId} (attempt ${event.attempt})` : envelope.nodeId,
              type: "task"
            },
            metrics: { start: startEpoch, end: endEpoch },
            output: {
              status: event.status,
              ...(event.findingsCount !== undefined ? { findings_count: event.findingsCount } : {})
            },
            ...(event.error !== undefined ? { error: event.error } : {}),
            metadata: {
              row_id: envelope.rowId,
              node_id: envelope.nodeId,
              logical_node_id: this.logicalIdForNode(envelope.rowId, envelope.nodeId),
              attempt: event.attempt,
              event_id: envelope.eventId
            }
          }
        ]);
        await this.updateRowMetrics(envelope.rowId);
        return;
      }
      case "node-heartbeat": {
        await this.updateRowMetrics(envelope.rowId, {
          last_heartbeat_at: event.at,
          last_heartbeat_node: envelope.nodeId,
          last_heartbeat_status: event.status,
          last_heartbeat_active_seconds: event.activeSeconds
        });
        return;
      }
      case "node-artifacts": {
        await this.insertEvents([
          {
            id: envelope.eventId,
            span_id: this.nodeArtifactSpanId(envelope.rowId, envelope.nodeId),
            root_span_id: this.rowSpanId(envelope.rowId),
            span_parents: [this.groupSpanId(envelope.rowId, this.groupForNode(envelope.rowId, envelope.nodeId))],
            span_attributes: { name: `${envelope.nodeId} artifacts`, type: "task" },
            output: {
              manifest: event.manifest.map((entry) => ({
                path: entry.path,
                size_bytes: entry.size_bytes,
                sha256: entry.sha256
              }))
            },
            metadata: { row_id: envelope.rowId, node_id: envelope.nodeId, event_id: envelope.eventId }
          }
        ]);
        return;
      }
      default:
        return;
    }
  }

  async onArtifact(artifact: EvalArtifactUpload): Promise<void> {
    const inlinePayload =
      artifact.read !== undefined &&
      artifact.sizeBytes <= INLINE_ARTIFACT_LIMIT_BYTES &&
      isTextual(artifact.contentType)
        ? (await artifact.read()).toString("utf8")
        : undefined;
    await this.insertEvents([
      {
        id: `artifact-${artifact.nodeId}-${artifact.relativePath}-${artifact.sha256}`,
        span_id: this.nodeArtifactSpanId(artifact.rowId, artifact.nodeId),
        root_span_id: this.rowSpanId(artifact.rowId),
        _is_merge: true,
        output: {
          [`file:${artifact.relativePath}`]: {
            content_type: artifact.contentType,
            size_bytes: artifact.sizeBytes,
            sha256: artifact.sha256,
            ...(inlinePayload !== undefined ? { content: inlinePayload } : { payload: "manifest-only" })
          }
        }
      }
    ]);
  }

  async onRowFinish(row: EvalMatrixRow, result: EvalRowResult): Promise<void> {
    await this.insertEvents([
      {
        id: `row-${row.id}`,
        span_id: this.rowSpanId(row.id),
        root_span_id: this.rowSpanId(row.id),
        _is_merge: true,
        output: {
          status: result.status,
          ...(result.runId !== undefined ? { run_id: result.runId } : {})
        },
        ...(result.startedAt !== undefined && result.finishedAt !== undefined
          ? { metrics: { start: epochSeconds(result.startedAt), end: epochSeconds(result.finishedAt) } }
          : {})
      }
    ]);
  }

  async onScores(scores: EvalRowScore[], summary: EvalSummary): Promise<void> {
    const events: Array<Record<string, unknown>> = scores.map((score) => ({
      id: `row-${score.row_id}`,
      span_id: this.rowSpanId(score.row_id),
      root_span_id: this.rowSpanId(score.row_id),
      _is_merge: true,
      scores: {
        precision: score.precision,
        recall: score.recall,
        f1_score: score.f1_score,
        full_match_rate: score.full_match_rate
      },
      output: {
        true_positives: score.true_positives,
        false_positives: score.false_positives,
        missed: score.missed,
        human_review_queue_count: score.human_review_queue_count
      }
    }));
    events.push({
      id: `summary-${summary.eval_run_id}`,
      span_id: `summary-${summary.eval_run_id}`,
      root_span_id: `summary-${summary.eval_run_id}`,
      span_attributes: { name: "summary", type: "task" },
      scores: Object.fromEntries(
        summary.variants.flatMap((variant) => [
          [`${variant.variant_id}:precision`, variant.precision],
          [`${variant.variant_id}:recall`, variant.recall],
          [`${variant.variant_id}:f1_score`, variant.f1_score]
        ])
      ),
      output: { variants: summary.variants }
    });
    await this.insertEvents(events);
  }

  async finalize(summary: EvalSummary): Promise<{ url?: string }> {
    void summary;
    if (this.projectId !== undefined && this.experimentName !== undefined) {
      return {
        url: `${this.options.appUrl ?? DEFAULT_APP_URL}/app/p/${this.projectId}/experiments/${this.experimentName}`
      };
    }
    return {};
  }

  private rowSpanId(rowId: string): string {
    return `span-row-${rowId}`;
  }

  private groupSpanId(rowId: string, group: string): string {
    return `span-group-${rowId}-${group}`;
  }

  private nodeSpanId(rowId: string, nodeId: string, attempt: number): string {
    return `span-node-${rowId}-${nodeId}-a${attempt}`;
  }

  private nodeArtifactSpanId(rowId: string, nodeId: string): string {
    return `span-node-artifacts-${rowId}-${nodeId}`;
  }

  private groupForNode(rowId: string, nodeId: string): string {
    const graph = this.rowGraphs.get(rowId);
    return graph?.nodes.find((node) => node.id === nodeId)?.group ?? "default";
  }

  private logicalIdForNode(rowId: string, nodeId: string): string {
    const graph = this.rowGraphs.get(rowId);
    return graph?.nodes.find((node) => node.id === nodeId)?.logicalId ?? nodeId;
  }

  private async updateRowMetrics(rowId: string, extraMetadata?: Record<string, unknown>): Promise<void> {
    const progress = this.progress.get(rowId);
    if (progress === undefined) {
      return;
    }
    await this.insertEvents([
      {
        id: `row-${rowId}`,
        span_id: this.rowSpanId(rowId),
        root_span_id: this.rowSpanId(rowId),
        _is_merge: true,
        metadata: {
          nodes_total: progress.total,
          nodes_done: progress.done,
          active_nodes: progress.active,
          ...(extraMetadata ?? {})
        }
      }
    ]);
  }

  private async ensureExperiment(): Promise<void> {
    if (this.experimentId !== undefined) {
      return;
    }
    const project = await this.request("POST", "/v1/project", { name: this.options.project });
    this.projectId = idOf(project, "project");
    const prefix = this.options.policy.experiment_prefix ?? "ultrafuzz";
    this.experimentName = `${prefix}-${this.options.evalRunId}`;
    const experiment = await this.request("POST", "/v1/experiment", {
      project_id: this.projectId,
      name: this.experimentName,
      description: `ultrafuzz eval run ${this.options.evalRunId}`
    });
    this.experimentId = idOf(experiment, "experiment");
  }

  private async insertEvents(events: Array<Record<string, unknown>>): Promise<void> {
    await this.ensureExperiment();
    await this.request("POST", `/v1/experiment/${this.experimentId}/insert`, { events });
  }

  private async request(method: string, requestPath: string, body: unknown): Promise<unknown> {
    const response = await this.fetchImpl(`${this.options.apiUrl ?? DEFAULT_API_URL}${requestPath}`, {
      method,
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) {
      throw new EvalError("EVAL_BRAINTRUST_REQUEST_FAILED", `Braintrust ${method} ${requestPath} failed`, {
        status: response.status,
        body: text.slice(0, 500)
      });
    }
    try {
      return text.length > 0 ? JSON.parse(text) : {};
    } catch {
      return {};
    }
  }
}

function idOf(value: unknown, label: string): string {
  if (isRecord(value) && typeof value.id === "string" && value.id.length > 0) {
    return value.id;
  }
  throw new EvalError("EVAL_BRAINTRUST_RESPONSE_INVALID", `Braintrust ${label} response is missing an id`);
}

function epochSeconds(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed / 1000 : 0;
}

function isTextual(contentType: string): boolean {
  return contentType.startsWith("text/") || contentType === "application/json" || contentType === "application/yaml";
}
