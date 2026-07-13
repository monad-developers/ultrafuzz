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
import { EvalError, deterministicUuid, isRecord } from "../utils.js";

export interface LangSmithReporterOptions {
  apiKey: string;
  project: string;
  evalRunId: string;
  policy: EvalReportingPolicy;
  workspaceId?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_ENDPOINT = "https://api.smith.langchain.com";
const INLINE_ARTIFACT_LIMIT_BYTES = 262_144;

/**
 * LangSmith reporter: root run per matrix row with a child run per topology
 * group (via `parent_run_id`/`dotted_order`) and one child run per node
 * attempt. `node-started` creates the run with `start_time` so the waterfall
 * shows it live; `node-finished` patches `end_time`/outputs/error.
 *
 * Run ids are deterministic UUIDs derived from (eval run, row, node, attempt),
 * so post-hoc replay and crash-resume converge on the same trace.
 */
export class LangSmithReporter implements EvalReporter {
  readonly name = "langsmith";
  private readonly options: LangSmithReporterOptions;
  private readonly fetchImpl: typeof fetch;
  private projectEnsured = false;
  private readonly createdRuns = new Set<string>();
  private readonly latestAttemptByNode = new Map<string, number>();
  private readonly rowGraphs = new Map<string, EvalRowGraph>();
  private readonly rowStartTimes = new Map<string, string>();

  constructor(options: LangSmithReporterOptions) {
    if (!options.apiKey) {
      throw new EvalError("EVAL_PROVIDER_CREDENTIALS_MISSING", "LangSmith reporter requires an API key");
    }
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async onPlan(plan: EvalPlan): Promise<void> {
    await this.ensureProject();
    void plan;
  }

  async onRowStart(row: EvalMatrixRow, graph: EvalRowGraph): Promise<void> {
    await this.ensureProject();
    this.rowGraphs.set(row.id, graph);
    const startTime = new Date().toISOString();
    this.rowStartTimes.set(row.id, startTime);
    const rootId = this.rowRunId(row.id);
    await this.createRun({
      id: rootId,
      trace_id: rootId,
      dotted_order: dottedOrderSegment(startTime, rootId),
      name: `${row.target_id}/${row.variant_id}/${row.trial_id}`,
      run_type: "chain",
      session_name: this.options.project,
      start_time: startTime,
      inputs: { matrix_row_id: row.id, repo: row.target.repo, ref: row.target.ref },
      extra: {
        metadata: {
          eval_run_id: this.options.evalRunId,
          row_id: row.id,
          target_id: row.target_id,
          variant_id: row.variant_id,
          trial_id: row.trial_id,
          runner_model_profile: row.runner_model_profile,
          judge_model_profile: row.judge_model_profile,
          node_count: graph.nodes.length,
          dag_edges: graph.nodes.map((node) => ({ id: node.id, depends_on: node.dependsOn })),
          tags: ["ultrafuzz", "eval", row.target_id, row.variant_id]
        }
      }
    });
    for (const group of groupsInGraph(graph)) {
      const groupId = this.groupRunId(row.id, group);
      await this.createRun({
        id: groupId,
        trace_id: rootId,
        parent_run_id: rootId,
        dotted_order: `${dottedOrderSegment(startTime, rootId)}.${dottedOrderSegment(startTime, groupId)}`,
        name: group,
        run_type: "chain",
        session_name: this.options.project,
        start_time: startTime,
        inputs: { group },
        extra: { metadata: { row_id: row.id, group } }
      });
    }
  }

  async onNodeEvent(envelope: EvalNodeEventEnvelope): Promise<void> {
    const event = envelope.event;
    switch (event.type) {
      case "node-started": {
        await this.ensureNodeRun(envelope.rowId, envelope.nodeId, event.attempt, event.at);
        return;
      }
      case "node-finished": {
        const runId = this.nodeRunId(envelope.rowId, envelope.nodeId, event.attempt);
        await this.ensureNodeRun(envelope.rowId, envelope.nodeId, event.attempt, event.startedAt ?? event.at);
        await this.patchRun(runId, {
          end_time: event.at,
          outputs: {
            status: event.status,
            ...(event.findingsCount !== undefined ? { findings_count: event.findingsCount } : {})
          },
          ...(event.error !== undefined ? { error: event.error } : {})
        });
        return;
      }
      case "node-heartbeat": {
        await this.patchRun(this.rowRunId(envelope.rowId), {
          extra: {
            metadata: {
              last_heartbeat_at: event.at,
              last_heartbeat_node: envelope.nodeId,
              last_heartbeat_status: event.status,
              last_heartbeat_active_seconds: event.activeSeconds
            }
          }
        });
        return;
      }
      case "node-artifacts": {
        // Announce the manifest on the node's most recent attempt run; in
        // manifest-only mode this is all the provider ever sees.
        const runId = this.latestNodeRunId(envelope.rowId, envelope.nodeId);
        if (runId === undefined) {
          return;
        }
        await this.patchRun(runId, {
          outputs: {
            artifact_manifest: event.manifest.map((entry) => ({
              path: entry.path,
              size_bytes: entry.size_bytes,
              sha256: entry.sha256
            }))
          }
        });
        return;
      }
      default:
        return;
    }
  }

  async onArtifact(artifact: EvalArtifactUpload): Promise<void> {
    const runId = this.latestNodeRunId(artifact.rowId, artifact.nodeId);
    if (runId === undefined) {
      return;
    }
    const inlinePayload =
      artifact.read !== undefined &&
      artifact.sizeBytes <= INLINE_ARTIFACT_LIMIT_BYTES &&
      isTextual(artifact.contentType)
        ? (await artifact.read()).toString("utf8")
        : undefined;
    await this.patchRun(runId, {
      outputs: {
        [`artifact:${artifact.relativePath}`]: {
          content_type: artifact.contentType,
          size_bytes: artifact.sizeBytes,
          sha256: artifact.sha256,
          ...(inlinePayload !== undefined ? { content: inlinePayload } : { payload: "manifest-only" })
        }
      }
    });
  }

  async onRowFinish(row: EvalMatrixRow, result: EvalRowResult): Promise<void> {
    const endTime = result.finishedAt ?? new Date().toISOString();
    // In the post-hoc publish path onRowStart runs at publish time, so the
    // root/group runs were created with a wall-clock start_time that can be
    // hours or days after the actual run. state.json's started_at arrives here
    // as result.startedAt — patch start_time back so the waterfall is correct.
    // In the live path this second PATCH is a harmless near-no-op.
    const startPatch = result.startedAt !== undefined ? { start_time: result.startedAt } : {};
    if (result.startedAt !== undefined) {
      this.rowStartTimes.set(row.id, result.startedAt);
    }
    const graph = this.rowGraphs.get(row.id);
    for (const group of graph ? groupsInGraph(graph) : []) {
      await this.patchRun(this.groupRunId(row.id, group), { ...startPatch, end_time: endTime });
    }
    await this.patchRun(this.rowRunId(row.id), {
      ...startPatch,
      end_time: endTime,
      outputs: {
        status: result.status,
        ...(result.runId !== undefined ? { run_id: result.runId } : {})
      },
      ...(result.status === "failed" || result.status === "timed-out" ? { error: `row ${result.status}` } : {})
    });
  }

  async onScores(scores: EvalRowScore[], summary: EvalSummary): Promise<void> {
    for (const score of scores) {
      const runId = this.rowRunId(score.row_id);
      for (const metric of ["precision", "recall", "f1_score"] as const) {
        await this.request("POST", "/api/v1/feedback", {
          id: deterministicUuid([this.options.evalRunId, score.row_id, metric]),
          run_id: runId,
          key: metric,
          score: score[metric],
          comment: `ultrafuzz eval ${summary.eval_run_id} ${metric}`
        });
      }
    }
  }

  async finalize(summary: EvalSummary): Promise<{ url?: string }> {
    void summary;
    const session = await this.readProject();
    if (session !== undefined) {
      const base = this.options.workspaceId !== undefined ? `/o/${this.options.workspaceId}` : "";
      return { url: `https://smith.langchain.com${base}/projects/p/${session}` };
    }
    return {};
  }

  private rowRunId(rowId: string): string {
    return deterministicUuid([this.options.evalRunId, rowId, "row"]);
  }

  private groupRunId(rowId: string, group: string): string {
    return deterministicUuid([this.options.evalRunId, rowId, "group", group]);
  }

  private nodeRunId(rowId: string, nodeId: string, attempt: number): string {
    return deterministicUuid([this.options.evalRunId, rowId, "node", nodeId, String(attempt)]);
  }

  private latestNodeRunId(rowId: string, nodeId: string): string | undefined {
    const latestAttempt = this.latestAttemptByNode.get(`${rowId}:${nodeId}`);
    if (latestAttempt === undefined) {
      return undefined;
    }
    return this.nodeRunId(rowId, nodeId, latestAttempt);
  }

  private recordLatestAttempt(rowId: string, nodeId: string, attempt: number): void {
    const key = `${rowId}:${nodeId}`;
    const prior = this.latestAttemptByNode.get(key);
    if (prior === undefined || attempt > prior) {
      this.latestAttemptByNode.set(key, attempt);
    }
  }

  private async ensureNodeRun(rowId: string, nodeId: string, attempt: number, startTime: string): Promise<void> {
    const runId = this.nodeRunId(rowId, nodeId, attempt);
    if (this.createdRuns.has(runId)) {
      this.recordLatestAttempt(rowId, nodeId, attempt);
      return;
    }
    const graph = this.rowGraphs.get(rowId);
    const node = graph?.nodes.find((candidate) => candidate.id === nodeId);
    const group = node?.group ?? "default";
    const rootId = this.rowRunId(rowId);
    const groupId = this.groupRunId(rowId, group);
    const rowStart = this.rowStartTimes.get(rowId) ?? startTime;
    await this.createRun({
      id: runId,
      trace_id: rootId,
      parent_run_id: groupId,
      dotted_order: [
        dottedOrderSegment(rowStart, rootId),
        dottedOrderSegment(rowStart, groupId),
        dottedOrderSegment(startTime, runId)
      ].join("."),
      name: attempt > 1 ? `${nodeId} (attempt ${attempt})` : nodeId,
      run_type: "chain",
      session_name: this.options.project,
      start_time: startTime,
      inputs: { node_id: nodeId, attempt },
      extra: {
        metadata: {
          row_id: rowId,
          node_id: nodeId,
          logical_node_id: node?.logicalId ?? nodeId,
          group,
          depends_on: node?.dependsOn ?? [],
          ...(node?.modelProfileId !== undefined ? { model_profile_id: node.modelProfileId } : {}),
          ...(node?.model !== undefined ? { model: node.model } : {}),
          attempt
        }
      }
    });
    this.recordLatestAttempt(rowId, nodeId, attempt);
  }

  private async createRun(body: Record<string, unknown>): Promise<void> {
    await this.request("POST", "/api/v1/runs", body);
    if (typeof body.id === "string") {
      this.createdRuns.add(body.id);
    }
  }

  private async patchRun(runId: string, body: Record<string, unknown>): Promise<void> {
    await this.request("PATCH", `/api/v1/runs/${runId}`, body);
  }

  private async ensureProject(): Promise<void> {
    if (this.projectEnsured) {
      return;
    }
    try {
      await this.request("POST", "/api/v1/sessions", {
        name: this.options.project,
        description: `ultrafuzz eval runs (${this.options.evalRunId})`
      });
    } catch (error) {
      // 409 conflict means the project already exists — that is fine.
      if (!(error instanceof EvalError) || error.details?.status !== 409) {
        throw error;
      }
    }
    this.projectEnsured = true;
  }

  private async readProject(): Promise<string | undefined> {
    try {
      const sessions = await this.request(
        "GET",
        `/api/v1/sessions?name=${encodeURIComponent(this.options.project)}`,
        undefined
      );
      if (Array.isArray(sessions) && isRecord(sessions[0]) && typeof sessions[0].id === "string") {
        return sessions[0].id;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private async request(method: string, requestPath: string, body: unknown): Promise<unknown> {
    const response = await this.fetchImpl(`${this.options.endpoint ?? DEFAULT_ENDPOINT}${requestPath}`, {
      method,
      redirect: "error",
      headers: {
        "x-api-key": this.options.apiKey,
        "content-type": "application/json",
        ...(this.options.workspaceId !== undefined ? { "x-tenant-id": this.options.workspaceId } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const text = await response.text();
    if (!response.ok) {
      throw new EvalError("EVAL_LANGSMITH_REQUEST_FAILED", `LangSmith ${method} ${requestPath} failed`, {
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

/** LangSmith dotted-order segment: %Y%m%dT%H%M%S%fZ concatenated with the run id. */
export function dottedOrderSegment(isoTime: string, runId: string): string {
  const date = new Date(isoTime);
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  const stamp =
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1, 2)}${pad(date.getUTCDate(), 2)}` +
    `T${pad(date.getUTCHours(), 2)}${pad(date.getUTCMinutes(), 2)}${pad(date.getUTCSeconds(), 2)}` +
    `${pad(date.getUTCMilliseconds(), 3)}000Z`;
  return `${stamp}${runId}`;
}

function isTextual(contentType: string): boolean {
  return contentType.startsWith("text/") || contentType === "application/json" || contentType === "application/yaml";
}
