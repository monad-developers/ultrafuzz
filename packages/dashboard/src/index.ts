import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  assertPlannedGraph,
  assertNoSymlinkComponents,
  assertPathInside,
  assertRegularFileInside,
  assertRunStateSchema,
  layoutForRunRoot,
  listSafeFiles,
  parseStrictJsonBytes,
  parseSmithersTaskManifestBytes,
  readPlannedGraphDocument,
  readRunMetadataDocument,
  readRunState,
  replayEvents,
  safeResolveInside,
  sha256Bytes,
  validateSafeId,
  writeFileDurable,
  type ArtifactContractId,
  type NodeStatus,
  type NodeState,
  type PlannedGraphOutput,
  type PlannedGraphDocument,
  type RunStatus,
  type RunState
} from "@ultrafuzz/artifacts";
import { parseProjectConfigToml, resolveConfig, type ResolvedConfig } from "@ultrafuzz/config";
import {
  loadPromptCatalog,
  normalizePromptRelativePath,
  parsePromptFrontmatter,
  titleFromId,
  validatePromptVariables,
  SUPPORTED_TEMPLATE_VARIABLES
} from "@ultrafuzz/prompts";
import {
  cleanGenerated,
  assertVerifiedRunOutputAuthorityRemainedCurrent,
  forkRun,
  getRunStatus,
  listRuns,
  materializeRun,
  referencesStatus,
  referencesSync,
  referencesUpdate,
  replayRun,
  resumeRun,
  runsRootForProject,
  startRun,
  validateProject,
  loadResolvedProject,
  modelProfilesForTopology,
  isVerifiedOutputAuthorityUnavailable,
  loadVerifiedFinalReportSnapshot,
  loadVerifiedRunOutputAuthoritySnapshot,
  projectCanonicalFinalReport,
  verifySealedTaskManifestSnapshot,
  type RuntimeResult,
  type VerifiedNodeOutputSnapshot,
  type VerifiedRunOutputAuthoritySnapshot
} from "@ultrafuzz/runtime";
import {
  expandTopology,
  FINISH_NODE_ID,
  loadTopology,
  resolveTopologyPath,
  START_NODE_ID,
  validateTopology,
  type ExpandedGraph,
  type ExpandedNode,
  type ProjectTopology,
  TopologyError,
  type TopologyNode
} from "@ultrafuzz/topology";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  appendDashboardAuditRecord,
  assertDashboardHttpDocument,
  DASHBOARD_HTTP_SCHEMA_VERSION,
  DASHBOARD_SSE_SCHEMA_VERSION,
  readDashboardAuditJournal,
  serializeDashboardHttpDocument,
  serializeDashboardSseDocument,
  type DashboardAuditInput,
  type DashboardHttpDefinition,
  type DashboardSseDefinition
} from "./contracts.js";

export * from "./contracts.js";
export * from "./schema-registry.js";

export interface DashboardServerConfig {
  projectRoot?: string;
  host?: string;
  port?: number;
  runId?: string;
  liveUpdates?: boolean;
  env?: Record<string, string | undefined>;
  /**
   * Ultrafuzz CLI entrypoint handed to every run this dashboard launches. A
   * schema-backed topology refuses to submit without it, so the caller that owns
   * the CLI identity must supply it.
   */
  ultrafuzzCliEntrypoint?: string;
}

export interface DashboardHandle {
  bindAddr: string;
  url: string;
  runId: string;
  sessionToken: string;
  close: () => Promise<void>;
}

type Status = NodeStatus | RunStatus | "queued" | "preview" | "unknown";
type DashboardCommand =
  | "validate"
  | "run"
  | "ps"
  | "inspect"
  | "resume"
  | "replay"
  | "fork"
  | "report"
  | "references-status"
  | "references-sync"
  | "references-update"
  | "materialize"
  | "clean";
type CommandJobStatus = "running" | "succeeded" | "failed";
type JsonObject = Record<string, unknown>;
type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";
type DashboardSseEventType = "ultrafuzz-event" | "ultrafuzz-error" | "ultrafuzz-command-jobs";

interface DashboardRunContext {
  runId: string;
  runsRoot: string;
  runRoot: string;
  persisted: boolean;
}

interface DashboardCapturedRunAuthority {
  context: DashboardRunContext;
  state: RunState | undefined;
  authorityProjection: DashboardFlowAuthorityProjection | undefined;
}

const DASHBOARD_FINDINGS_CONTRACTS = [
  "ultrafuzz/severity-classified-findings@1",
  "ultrafuzz/triaged-findings@1",
  "ultrafuzz/findings@2",
  "ultrafuzz/report@2"
] as const satisfies readonly ArtifactContractId[];
type DashboardFindingsContract = (typeof DASHBOARD_FINDINGS_CONTRACTS)[number];
const DASHBOARD_FINDINGS_STAGE_PRIORITY = ["severity-classified", "triaged", "deduped", "report", "raw"] as const;
type DashboardFindingsStage = (typeof DASHBOARD_FINDINGS_STAGE_PRIORITY)[number];

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3875;
const PREVIEW_RUN_ID = "preview";
const SESSION_HEADER = "x-ultrafuzz-session";
const MAX_COMMAND_JOBS = 20;
const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const FINDINGS_CONTRACT = "ultrafuzz/findings@2" as ArtifactContractId;
const SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'"
  ].join("; "),
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
} as const;

const SUPPORTED_COMMANDS: ReadonlySet<string> = new Set([
  "validate",
  "run",
  "ps",
  "inspect",
  "resume",
  "replay",
  "fork",
  "report",
  "references-status",
  "references-sync",
  "references-update",
  "materialize",
  "clean"
]);

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

export async function serveDashboard(config: DashboardServerConfig = {}): Promise<DashboardHandle> {
  const app = await DashboardApp.create(config);
  const server = http.createServer((request, response) => {
    applySecurityHeaders(response);
    app.handle(request, response).catch((error) => sendError(response, error));
  });
  const bindAddr = await listen(server, app.host, app.port);
  const url = `http://${bindAddr}/dashboard`;
  return {
    bindAddr,
    url,
    runId: await app.selectedRunId(),
    sessionToken: app.sessionToken,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      })
  };
}

export { serveDashboard as serve };

class DashboardApp {
  readonly projectRoot: string;
  readonly host: string;
  readonly port: number;
  readonly liveUpdates: boolean;
  readonly env: Record<string, string | undefined>;
  readonly ultrafuzzCliEntrypoint?: string;
  readonly sessionToken = crypto.randomBytes(32).toString("hex");
  readonly jobs = new Map<string, CommandJob>();
  private requestedRunId?: string;
  private currentRunId?: string;

  private constructor(
    config: Required<Pick<DashboardServerConfig, "host" | "port" | "liveUpdates">> & {
      projectRoot: string;
      runId?: string;
      env: Record<string, string | undefined>;
      ultrafuzzCliEntrypoint?: string;
    }
  ) {
    this.projectRoot = config.projectRoot;
    this.ultrafuzzCliEntrypoint = config.ultrafuzzCliEntrypoint;
    this.host = config.host;
    this.port = config.port;
    this.liveUpdates = config.liveUpdates;
    this.requestedRunId = config.runId;
    this.env = config.env;
  }

  static async create(config: DashboardServerConfig): Promise<DashboardApp> {
    const host = config.host ?? DEFAULT_HOST;
    validateLoopbackHost(host);
    const runId = config.runId === undefined ? undefined : validateSafeId(config.runId, "run ID");
    const app = new DashboardApp({
      projectRoot: path.resolve(config.projectRoot ?? process.cwd()),
      host,
      port: config.port ?? DEFAULT_PORT,
      runId,
      liveUpdates: config.liveUpdates ?? true,
      env: config.env ?? process.env,
      ...(config.ultrafuzzCliEntrypoint === undefined ? {} : { ultrafuzzCliEntrypoint: config.ultrafuzzCliEntrypoint })
    });
    app.currentRunId = runId ?? (await app.latestRunId()) ?? PREVIEW_RUN_ID;
    return app;
  }

  async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      requireLocalRequest(request);
      await this.handleApi(request, response, url);
      return;
    }
    await this.handleStatic(request, response, url);
  }

  async selectedRunId(): Promise<string> {
    if (this.currentRunId !== undefined) {
      return this.currentRunId;
    }
    this.currentRunId = this.requestedRunId ?? (await this.latestRunId()) ?? PREVIEW_RUN_ID;
    return this.currentRunId;
  }

  async handleApi(request: http.IncomingMessage, response: http.ServerResponse, url: URL): Promise<void> {
    const method = parseHttpMethod(request.method);
    const segments = url.pathname.split("/").filter(Boolean).slice(1);

    if (method === "GET" && segments.length === 1 && segments[0] === "session") {
      sendJson(response, await this.session(), "sessionResponse");
      return;
    }
    if (method === "GET" && segments.length === 1 && segments[0] === "flow") {
      sendJson(response, await this.flow(), "flowResponse");
      return;
    }
    if (method === "GET" && segments.length === 1 && segments[0] === "run") {
      sendJson(response, await this.runOverview(), "runOverviewResponse");
      return;
    }
    if (method === "GET" && segments.length === 1 && segments[0] === "graph") {
      sendJson(response, await this.graphDetail(), "graphResponse");
      return;
    }
    if (method === "GET" && segments.length === 1 && segments[0] === "nodes") {
      sendJson(response, dashboardHttpDocument("nodes", { nodes: (await this.flow()).nodes }), "nodesResponse");
      return;
    }
    if (method === "GET" && segments.length === 2 && segments[0] === "nodes") {
      sendJson(response, await this.nodeDetail(decodeURIComponent(segments[1]!)), "nodeDetailResponse");
      return;
    }
    if (method === "GET" && segments.length === 1 && segments[0] === "findings") {
      sendJson(response, await this.findings(), "findingsResponse");
      return;
    }
    if (method === "GET" && segments.length === 1 && segments[0] === "report") {
      sendJson(response, await this.report(), "reportResponse");
      return;
    }
    if (method === "GET" && segments.length === 1 && segments[0] === "events") {
      sendJson(response, await this.events(), "eventsResponse");
      return;
    }
    if (method === "GET" && segments.length === 2 && segments[0] === "events" && segments[1] === "stream") {
      await this.streamEvents(request, response);
      return;
    }
    if (segments[0] === "config") {
      if (method === "GET" && segments.length === 1) {
        sendJson(response, await this.configDetail(), "configDetailResponse");
        return;
      }
      if (method === "PUT" && segments.length === 1) {
        requireMutation(request, this.sessionToken);
        sendJson(
          response,
          await this.saveConfig(await readDashboardRequest(request, "configSaveRequest")),
          "configSaveResponse"
        );
        return;
      }
    }
    if (segments[0] === "topology") {
      if (method === "GET" && segments.length === 1) {
        sendJson(response, await this.topologyDetail(), "topologyDetailResponse");
        return;
      }
      if (method === "PUT" && segments.length === 1) {
        requireMutation(request, this.sessionToken);
        sendJson(
          response,
          await this.saveTopology(await readDashboardRequest(request, "topologySaveRequest")),
          "topologySaveResponse"
        );
        return;
      }
    }
    if (segments[0] === "prompts") {
      await this.handlePrompts(request, response, method, segments);
      return;
    }
    if (segments[0] === "commands") {
      await this.handleCommands(request, response, method, segments);
      return;
    }
    throw new HttpError(404, `unknown dashboard API route: ${url.pathname}`);
  }

  async handlePrompts(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    method: HttpMethod,
    segments: string[]
  ): Promise<void> {
    if (method === "GET" && segments.length === 2 && segments[1] === "strategies") {
      sendJson(
        response,
        dashboardHttpDocument("prompt-list", { prompts: this.promptSummaries() }),
        "promptListResponse"
      );
      return;
    }
    if (segments.length === 3 && segments[1] === "strategies") {
      const id = decodeURIComponent(segments[2]!);
      if (method === "GET") {
        sendJson(response, this.promptDetail(id, "strategy"), "promptDetailResponse");
        return;
      }
      if (method === "PUT") {
        requireMutation(request, this.sessionToken);
        sendJson(
          response,
          await this.saveStrategyPrompt(id, await readDashboardRequest(request, "promptSaveRequest")),
          "promptSaveResponse"
        );
        return;
      }
    }
    if (segments.length === 2 && segments[1] === "nodes" && method === "POST") {
      requireMutation(request, this.sessionToken);
      sendJson(
        response,
        await this.createNodePrompt(await readDashboardRequest(request, "promptCreateRequest")),
        "promptSaveResponse",
        201
      );
      return;
    }
    if (segments.length === 3 && segments[1] === "nodes") {
      const id = decodeURIComponent(segments[2]!);
      if (method === "GET") {
        sendJson(response, await this.nodePromptDetail(id), "promptDetailResponse");
        return;
      }
      if (method === "PUT") {
        requireMutation(request, this.sessionToken);
        sendJson(
          response,
          await this.saveNodePrompt(id, await readDashboardRequest(request, "promptSaveRequest")),
          "promptSaveResponse"
        );
        return;
      }
    }
    throw new HttpError(404, "unknown prompts route");
  }

  async handleCommands(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    method: HttpMethod,
    segments: string[]
  ): Promise<void> {
    if (method === "GET" && segments.length === 2 && segments[1] === "stream") {
      await this.streamCommandJobs(request, response);
      return;
    }
    if (method === "POST" && segments.length === 2) {
      requireMutation(request, this.sessionToken);
      const command = decodeURIComponent(segments[1]!);
      const body = await readDashboardRequest(request, "commandRequest");
      if (stringField(body, "command") !== command) {
        throw new HttpError(400, "command request does not match the command route");
      }
      sendJson(response, await this.startCommand(command, recordField(body, "arguments")), "commandJobResponse", 202);
      return;
    }
    if (method === "GET" && segments.length === 2) {
      const job = this.jobs.get(decodeURIComponent(segments[1]!));
      if (!job) {
        throw new HttpError(404, "command job not found");
      }
      sendJson(response, job, "commandJobResponse");
      return;
    }
    throw new HttpError(404, "unknown commands route");
  }

  async handleStatic(_request: http.IncomingMessage, response: http.ServerResponse, url: URL): Promise<void> {
    if (url.pathname === "/") {
      response.writeHead(302, { location: "/dashboard" });
      response.end();
      return;
    }
    if (url.pathname === "/run" || url.pathname === "/graph" || url.pathname === "/nodes") {
      response.writeHead(302, { location: "/dashboard" });
      response.end();
      return;
    }
    if (url.pathname === "/dashboard") {
      await sendStaticAsset(response, "index.html");
      return;
    }
    if (url.pathname.startsWith("/dashboard/")) {
      const relative = url.pathname.slice("/dashboard/".length) || "index.html";
      await sendStaticAsset(response, relative);
      return;
    }
    throw new HttpError(404, `not found: ${url.pathname}`);
  }

  async session(): Promise<JsonObject> {
    return dashboardHttpDocument("session", {
      runId: await this.selectedRunId(),
      liveUpdates: this.liveUpdates,
      sessionToken: this.sessionToken,
      templateVariables: [...SUPPORTED_TEMPLATE_VARIABLES]
    });
  }

  async runContext(): Promise<DashboardRunContext> {
    const runId = await this.selectedRunId();
    const runsRoot = await runsRootForProject(this.projectRoot);
    const runRoot = path.join(runsRoot, runId);
    assertPathInside(runsRoot, runRoot, "run root");
    if (fs.existsSync(runsRoot)) {
      assertNoSymlinkComponents(runsRoot, runRoot, "run root");
    }
    return {
      runId,
      runsRoot,
      runRoot,
      persisted: runId !== PREVIEW_RUN_ID && fs.existsSync(runRoot)
    };
  }

  async captureRunAuthorityContext(): Promise<DashboardCapturedRunAuthority> {
    const context = await this.runContext();
    const observedState = await this.optionalRunState(context);
    const authorityProjection = context.persisted
      ? dashboardFlowAuthorityProjection(context.runRoot, observedState)
      : undefined;
    return {
      context,
      state: authorityProjection?.state ?? observedState,
      authorityProjection
    };
  }

  async assertCapturedRunAuthorityRemainedCurrent(captured: DashboardCapturedRunAuthority): Promise<void> {
    if ((await this.selectedRunId()) !== captured.context.runId) {
      throw new Error("dashboard selected run changed while the response was being projected");
    }
    assertDashboardCapturedRunAuthorityRemainedCurrent(captured);
  }

  async latestRunId(): Promise<string | undefined> {
    const runsRoot = await runsRootForProject(this.projectRoot);
    if (!fs.existsSync(runsRoot)) {
      return undefined;
    }
    assertNoSymlinkComponents(path.resolve(this.projectRoot), runsRoot, "runs root");
    const candidates = fs
      .readdirSync(runsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const runId = validateSafeId(entry.name, "run ID");
        const root = path.join(runsRoot, runId);
        const metadata = readRunMetadataDocument(path.join(root, "run.json"), runId);
        return { runId, createdAt: metadata.created_at, mtimeMs: fs.statSync(root).mtimeMs };
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.mtimeMs - left.mtimeMs);
    return candidates[0]?.runId;
  }

  async flow(): Promise<JsonObject> {
    const topology = this.loadTopologyForDisplay();
    const expanded = await this.expandCurrentTopology(topology);
    const captured = await this.captureRunAuthorityContext();
    const { context, state, authorityProjection } = captured;
    const run = await this.runOverviewFrom(topology, expanded, captured);
    const attemptsByLogicalId = groupExpandedNodes(expanded.nodes);
    const nodes = topology.nodes.map((node, index) =>
      this.flowNode(node, index, attemptsByLogicalId.get(node.id) ?? [], state, context.runRoot, authorityProjection)
    );
    const edges = topology.nodes.flatMap((node) =>
      (node.depends_on ?? []).map((dependency) => {
        const status = aggregateLogicalStatus(attemptsByLogicalId.get(node.id) ?? [], state);
        return {
          id: `${dependency}->${node.id}`,
          source: dependency,
          target: node.id,
          animated: status === "running" || status === "ready" || status === "runnable",
          data: { status },
          style: { stroke: edgeColorForStatus(status), strokeWidth: 2 },
          zIndex: 1
        };
      })
    );
    const strategies = nodes.flatMap((node) => {
      const data = node.data;
      if (!isRecord(data)) throw new Error(`flow node ${String(node.id)} has invalid data`);
      const strategy = data.strategy;
      return strategy === undefined ? [] : [strategy];
    });
    const document = dashboardHttpDocument("flow", {
      run,
      nodes,
      edges,
      strategies,
      capabilities: this.commandCapabilities()
    });
    await this.assertCapturedRunAuthorityRemainedCurrent(captured);
    return document;
  }

  flowNode(
    node: TopologyNode,
    index: number,
    attempts: ExpandedNode[],
    state: RunState | undefined,
    runRoot?: string,
    authorityProjection?: DashboardFlowAuthorityProjection
  ): JsonObject {
    const logicalId = node.id;
    const status = aggregateLogicalStatus(attempts, state);
    const promptPath = promptPathForNode(node);
    const label = displayNameForNode(this.projectRoot, node);
    const artifactDirs = attempts.map((attempt) => attempt.artifactDir);
    const group = node.group;
    const groups = this.loadTopologyForDisplay().groups ?? {};
    const groupInfo = group ? groups[group] : undefined;
    const findingCount = authorityProjection?.findingsByLogicalId.get(logicalId)?.length ?? 0;
    const requiredArtifacts = uniqueStrings([
      ...(node.outputs ?? []).map((output) => output.path),
      ...attempts.flatMap((attempt) => attempt.outputs.map((output) => output.path))
    ]);
    const loopCount = Math.max(1, attempts.length || node.loops || 1);
    return {
      id: logicalId,
      type: flowNodeType(node),
      position: { x: index * 310, y: 0 },
      data: {
        label,
        kind: nodeKindLabel(node),
        status,
        strategy:
          node.kind === "agentic" || node.kind === undefined
            ? {
                id: logicalId,
                display_name: label,
                category: group ?? "agentic",
                source: promptPath,
                models: uniqueStrings(
                  attempts.flatMap((attempt) => attempt.modelFanout.map((model) => model.modelProfileId))
                ),
                loops: loopCount,
                attempts: attempts.length || loopCount,
                ...(node.timeout_seconds ? { timeout_seconds: node.timeout_seconds } : {})
              }
            : undefined,
        model: firstModelSummary(attempts),
        modelIndex: attempts[0]?.modelFanout[0]?.modelIndex,
        loopIndex: undefined,
        dependencies: [...(node.depends_on ?? [])],
        artifactDir: artifactDirs[0] ?? `artifacts/${logicalId}`,
        artifactDirs,
        artifacts: this.artifactAvailability(attempts, runRoot, authorityProjection),
        promptAvailable: node.kind === undefined || node.kind === "agentic",
        promptEditable: node.kind === undefined || node.kind === "agentic",
        topologyConnectable: true,
        findingCount,
        propertySummary: null,
        latestError: latestErrorForLogicalNode(attempts, state),
        logicalNodeId: logicalId,
        attemptIndex: 0,
        loopCount,
        loopBadgeCount: loopCount,
        loopMode: node.loop_mode ?? attempts[0]?.loop.mode ?? "parallel",
        promptPath,
        group,
        groupLabel: groupInfo?.label ?? (group ? titleFromId(group) : undefined),
        groupColor: groupInfo?.color,
        requiredArtifacts,
        timeoutSeconds: node.timeout_seconds ?? attempts[0]?.timeoutSeconds,
        topologyEditable: true,
        expandedAttempts: attempts.map((attempt) => ({
          id: attempt.id,
          logicalId: attempt.logicalId,
          dependsOn: attempt.dependsOn,
          artifactDir: attempt.artifactDir,
          loop: attempt.loop,
          modelFanout: attempt.modelFanout
        }))
      }
    };
  }

  async runOverview(): Promise<JsonObject> {
    const topology = this.loadTopologyForDisplay();
    const expanded = await this.expandCurrentTopology(topology);
    const captured = await this.captureRunAuthorityContext();
    const document = await this.runOverviewFrom(topology, expanded, captured);
    await this.assertCapturedRunAuthorityRemainedCurrent(captured);
    return document;
  }

  async runOverviewFrom(
    topology: ProjectTopology,
    expanded: ExpandedGraph,
    captured: DashboardCapturedRunAuthority
  ): Promise<JsonObject> {
    const { context, state, authorityProjection } = captured;
    const events = await this.events(context);
    const findings = authorityProjection?.allFindings ?? [];
    const attemptsByLogicalId = groupExpandedNodes(expanded.nodes);
    const nodeCounts: Record<string, number> = {};
    const activeNodes: string[] = [];
    for (const node of topology.nodes) {
      const status = aggregateLogicalStatus(attemptsByLogicalId.get(node.id) ?? [], state);
      nodeCounts[status] = (nodeCounts[status] ?? 0) + 1;
      if (status === "running" || status === "ready" || status === "runnable") {
        activeNodes.push(node.id);
      }
    }
    const report = await this.report(context);
    return dashboardHttpDocument("run-overview", {
      run_id: context.runId,
      run_root: context.runRoot,
      runs_dir: context.runsRoot,
      status: state?.status ?? (context.persisted ? "unknown" : "preview"),
      source_run_id: state?.source_run_id,
      started_at: state?.started_at,
      finished_at: state?.finished_at,
      elapsed_seconds: elapsedSeconds(state),
      graph_nodes: topology.nodes.length,
      expanded_nodes: expanded.nodes.length,
      node_counts: nodeCounts,
      active_nodes: activeNodes,
      findings_count: findings.length,
      event_count: Array.isArray(events.events) ? events.events.length : 0,
      live_updates: this.liveUpdates,
      mode: context.persisted ? "persisted" : "preview",
      restart_eligible: Boolean(state?.finished_at),
      report_path: typeof report.markdown_path === "string" ? report.markdown_path : undefined,
      ...(context.persisted
        ? { run_metadata: readRunMetadataDocument(path.join(context.runRoot, "run.json"), context.runId) }
        : {})
    });
  }

  async graphDetail(): Promise<JsonObject> {
    const topology = this.loadTopologyForDisplay();
    const expanded = await this.expandCurrentTopology(topology);
    return dashboardHttpDocument("graph", {
      topology,
      expandedGraph: expanded,
      logicalNodes: topology.nodes.length,
      expandedNodes: expanded.nodes.length
    });
  }

  async nodeDetail(nodeId: string): Promise<JsonObject> {
    const safeNodeId = validateSafeId(nodeId, "node ID");
    const topology = this.loadTopologyForDisplay();
    const node = topology.nodes.find((candidate) => candidate.id === safeNodeId);
    if (!node) {
      throw new HttpError(404, `node ${safeNodeId} not found`);
    }
    const expanded = await this.expandCurrentTopology(topology);
    const attempts = expanded.nodes.filter((attempt) => attempt.logicalId === safeNodeId);
    const captured = await this.captureRunAuthorityContext();
    const { context, state, authorityProjection } = captured;
    const attemptArtifacts = await this.artifactEntriesForAttempts(attempts, context);
    const primary = attemptArtifacts[0];
    const document = dashboardHttpDocument("node-detail", {
      run_id: context.runId,
      node: {
        id: safeNodeId,
        label: displayNameForNode(this.projectRoot, node),
        kind: nodeKindLabel(node),
        kind_detail: node.kind ?? "agentic",
        status: aggregateLogicalStatus(attempts, state),
        depends_on: node.depends_on ?? [],
        artifact_dir: attempts[0]?.artifactDir ?? `artifacts/${safeNodeId}`,
        attempt_index: 0,
        loop_index: 0,
        timeout_seconds: node.timeout_seconds
      },
      state: stateForLogicalNode(safeNodeId, attempts, state),
      artifacts: attemptArtifacts.flatMap((attempt) => attempt.artifacts),
      artifactReferences: {
        outputs: [],
        referencedPrevious: []
      },
      stdout: primary?.stdout,
      stderr: primary?.stderr,
      rendered_prompt: primary?.renderedPrompt,
      findings: authorityProjection?.findingsByLogicalId.get(safeNodeId) ?? [],
      metadata: {
        expandedAttempts: attempts.map((attempt) => ({
          id: attempt.id,
          logicalId: attempt.logicalId,
          dependsOn: attempt.dependsOn,
          artifactDir: attempt.artifactDir,
          loop: attempt.loop,
          modelFanout: attempt.modelFanout
        }))
      }
    });
    await this.assertCapturedRunAuthorityRemainedCurrent(captured);
    return document;
  }

  async artifactEntriesForAttempts(
    attempts: ExpandedNode[],
    context: DashboardRunContext
  ): Promise<
    Array<{
      attemptId: string;
      artifacts: Array<{ path: string; kind: string; size_bytes: number; sha256: string }>;
      stdout?: string;
      stderr?: string;
      renderedPrompt?: string;
    }>
  > {
    if (!context.persisted) {
      return [];
    }
    return attempts.map((attempt) => {
      const dir = path.join(context.runRoot, attempt.artifactDir);
      assertPathInside(context.runRoot, dir, "artifact directory");
      if (!fs.existsSync(dir)) {
        return { attemptId: attempt.id, artifacts: [] };
      }
      assertNoSymlinkComponents(context.runRoot, dir, "artifact directory");
      const files = listSafeFiles(dir).map((entry) => ({
        path: `${attempt.artifactDir}/${entry.relativePath}`,
        kind: path.extname(entry.relativePath).replace(/^\./, "") || "file",
        size_bytes: entry.sizeBytes,
        sha256: sha256Bytes(fs.readFileSync(entry.absolutePath))
      }));
      return {
        attemptId: attempt.id,
        artifacts: files,
        stdout: readTextIfExists(path.join(dir, "stdout.log")),
        stderr: readTextIfExists(path.join(dir, "stderr.log")),
        renderedPrompt: readTextIfExists(path.join(dir, "prompt.rendered.md"))
      };
    });
  }

  async findings(): Promise<JsonObject> {
    const context = await this.runContext();
    if (!context.persisted) {
      return dashboardHttpDocument("findings", { source: "none", findings: [] });
    }
    const selected = verifiedDeclaredFindings(context.runRoot);
    return dashboardHttpDocument("findings", selected);
  }

  async report(context?: DashboardRunContext): Promise<JsonObject> {
    context ??= await this.runContext();
    if (!context.persisted) {
      return dashboardHttpDocument("report", {
        markdown_path: undefined,
        markdown: undefined,
        json_path: undefined,
        json: undefined
      });
    }
    const declaration = dashboardDeclaredReportAvailability(context.runRoot);
    try {
      const loaded = loadVerifiedFinalReportSnapshot(context.runRoot);
      return dashboardHttpDocument("report", {
        markdown_path: posixRelativePath(context.runRoot, loaded.artifacts.markdown_path),
        markdown: loaded.markdown,
        json_path: posixRelativePath(context.runRoot, loaded.artifacts.json_path),
        json: loaded.json
      });
    } catch (error) {
      if (
        !declaration.physicalPresent &&
        !declaration.claimedSuccess &&
        !declaration.invalidDeclaration &&
        isVerifiedOutputAuthorityUnavailable(error)
      ) {
        return dashboardHttpDocument("report", {
          markdown_path: undefined,
          markdown: undefined,
          json_path: undefined,
          json: undefined
        });
      }
      throw error;
    }
  }

  async events(context?: DashboardRunContext): Promise<JsonObject> {
    context ??= await this.runContext();
    if (!context.persisted) {
      return dashboardHttpDocument("events", {
        source: "none",
        events: [],
        malformed_records: 0,
        truncated_records: 0
      });
    }
    const layout = layoutForRunRoot(context.runRoot, context.runId);
    const replay = replayEvents(layout, 500);
    if (replay.malformedRecords !== 0 || replay.truncatedRecords !== 0) {
      throw new Error(
        `event journal is invalid: ${replay.malformedRecords} malformed and ${replay.truncatedRecords} truncated records`
      );
    }
    return dashboardHttpDocument("events", {
      source: path.relative(context.runRoot, layout.eventsPath).split(path.sep).join("/"),
      events: replay.records,
      malformed_records: replay.malformedRecords,
      truncated_records: replay.truncatedRecords
    });
  }

  async configDetail(): Promise<JsonObject> {
    const configPath = path.join(this.projectRoot, "ultrafuzz.toml");
    assertPathInside(this.projectRoot, configPath, "config path");
    const content = readTextIfExists(configPath) ?? "";
    const validation = await this.validateConfigText(content);
    return dashboardHttpDocument("config-detail", {
      source: fs.existsSync(configPath) ? "project" : "missing",
      path: "ultrafuzz.toml",
      editable: true,
      contentHash: sha256Bytes(content),
      content,
      validation
    });
  }

  async saveConfig(body: JsonObject): Promise<JsonObject> {
    const content = stringField(body, "content");
    const validation = await this.validateConfigText(content);
    if (!validation.valid) {
      throw new HttpError(400, validation.message);
    }
    const configPath = path.join(this.projectRoot, "ultrafuzz.toml");
    assertPathInside(this.projectRoot, configPath, "config path");
    assertNoSymlinkComponents(this.projectRoot, configPath, "config path");
    preflightDashboardAudit(this.projectRoot);
    writeFileDurable(configPath, content);
    appendAudit(this.projectRoot, {
      kind: "config-edit",
      path: "ultrafuzz.toml",
      content_hash: sha256Bytes(content)
    });
    return dashboardHttpDocument("config-save", {
      path: "ultrafuzz.toml",
      contentHash: sha256Bytes(content),
      validation
    });
  }

  async validateConfigText(content: string): Promise<{ valid: boolean; message: string }> {
    const parsed = parseProjectConfigToml(content, "ultrafuzz.toml");
    if (!parsed.ok) {
      return { valid: false, message: diagnosticsMessage(parsed.diagnostics) };
    }
    const resolved = resolveConfig({ projectConfig: parsed.value, env: this.env });
    if (!resolved.ok) {
      return { valid: false, message: diagnosticsMessage(resolved.diagnostics) };
    }
    try {
      const topology = loadTopology(this.projectRoot, { requirePromptFiles: true });
      expandTopology(topology, {
        projectRoot: this.projectRoot,
        requirePromptFiles: true,
        defaultTimeoutSeconds: resolved.value.run.defaultTimeoutSeconds,
        modelProfiles: modelProfilesForTopology(resolved.value),
        defaultModelProfileId: resolved.value.models.default
      });
    } catch (error) {
      return {
        valid: false,
        message: `config parses, but topology expansion with this config failed: ${errorMessage(error)}`
      };
    }
    return { valid: true, message: "config validates" };
  }

  async topologyDetail(): Promise<JsonObject> {
    const topologyPath = resolveTopologyPath(this.projectRoot);
    const content = readTextIfExists(topologyPath) ?? "";
    const validation = await this.validateTopologyText(content);
    return dashboardHttpDocument("topology-detail", {
      path: ".ultrafuzz/topology.yml",
      editable: true,
      contentHash: sha256Bytes(content),
      content,
      topology: validation.topology,
      expandedGraph: validation.expandedGraph,
      validation: {
        valid: validation.valid,
        message: validation.message
      }
    });
  }

  async saveTopology(body: JsonObject): Promise<JsonObject> {
    const content = stringifyYaml(recordField(body, "topology"), { sortMapEntries: false });
    const validation = await this.validateTopologyText(content);
    if (!validation.valid) {
      throw new HttpError(400, validation.message);
    }
    const topologyPath = resolveTopologyPath(this.projectRoot);
    assertPathInside(this.projectRoot, topologyPath, "topology path");
    assertNoSymlinkComponents(this.projectRoot, topologyPath, "topology path");
    preflightDashboardAudit(this.projectRoot);
    writeFileDurable(topologyPath, content.endsWith("\n") ? content : `${content}\n`);
    appendAudit(this.projectRoot, {
      kind: "topology-edit",
      path: ".ultrafuzz/topology.yml",
      content_hash: sha256Bytes(content)
    });
    return dashboardHttpDocument("topology-save", {
      path: ".ultrafuzz/topology.yml",
      contentHash: sha256Bytes(content),
      validation: {
        valid: true,
        message: validation.message
      }
    });
  }

  async validateTopologyText(
    content: string,
    options: {
      promptTexts?: Record<string, string>;
      requirePromptFiles?: boolean;
    } = {}
  ): Promise<{
    valid: boolean;
    message: string;
    topology?: ProjectTopology;
    expandedGraph?: ExpandedGraph;
  }> {
    try {
      const requirePromptFiles = options.requirePromptFiles ?? true;
      const parsed: unknown = parseYaml(content);
      const topologyValidation = validateTopology(parsed, {
        projectRoot: this.projectRoot,
        promptTexts: options.promptTexts,
        requirePromptFiles
      });
      const resolved = await this.resolvedConfig();
      const expandedGraph = expandTopology(parsed, {
        projectRoot: this.projectRoot,
        promptTexts: options.promptTexts,
        requirePromptFiles,
        defaultTimeoutSeconds: resolved?.run.defaultTimeoutSeconds,
        modelProfiles: resolved ? modelProfilesForTopology(resolved) : undefined,
        defaultModelProfileId: resolved?.models.default
      });
      return {
        valid: true,
        message: `topology validates: ${topologyValidation.topology.nodes.length} logical nodes, ${expandedGraph.nodes.length} expanded attempts`,
        topology: parsed as ProjectTopology,
        expandedGraph
      };
    } catch (error) {
      return { valid: false, message: errorMessage(error) };
    }
  }

  promptSummaries(): JsonObject[] {
    const catalog = loadPromptCatalog({ projectRoot: this.projectRoot });
    return catalog.orderedIds.map((id) => {
      const entry = catalog.entries.get(id)!;
      return {
        strategyId: id,
        promptId: id,
        displayName: entry.displayName,
        category: entry.relativePath.split("/")[0] ?? "prompts",
        source: entry.source,
        path: entry.relativePath,
        editable: true,
        contentHash: sha256Bytes(entry.markdown)
      };
    });
  }

  promptDetail(id: string, kind: "strategy" | "node"): JsonObject {
    const catalog = loadPromptCatalog({ projectRoot: this.projectRoot });
    const entry = catalog.entries.get(id);
    if (!entry) {
      throw new HttpError(404, `prompt ${id} not found`);
    }
    return dashboardHttpDocument("prompt-detail", {
      summary: {
        strategyId: kind === "strategy" ? id : undefined,
        nodeId: kind === "node" ? id : undefined,
        promptId: id,
        displayName: entry.displayName,
        category: entry.relativePath.split("/")[0] ?? "prompts",
        source: entry.source,
        path: entry.relativePath,
        editable: true,
        contentHash: sha256Bytes(entry.markdown)
      },
      content: entry.markdown
    });
  }

  async nodePromptDetail(nodeId: string): Promise<JsonObject> {
    const node = this.topologyNode(nodeId);
    const promptPath = promptPathForNode(node);
    const absolute = this.promptPath(promptPath);
    const content =
      readTextIfExists(absolute) ?? defaultPromptMarkdown(node.id, displayNameForNode(this.projectRoot, node));
    const document = parsePromptFrontmatter(content);
    return dashboardHttpDocument("prompt-detail", {
      summary: {
        nodeId: document.frontmatter.id ?? node.id,
        promptId: document.frontmatter.id ?? node.id,
        displayName: document.frontmatter.display_name ?? titleFromId(document.frontmatter.id ?? node.id),
        source: fs.existsSync(absolute) ? "project" : "generated",
        path: promptPath,
        editable: true,
        contentHash: sha256Bytes(content)
      },
      content
    });
  }

  async saveStrategyPrompt(id: string, body: JsonObject): Promise<JsonObject> {
    const content = stringField(body, "content");
    const catalog = loadPromptCatalog({ projectRoot: this.projectRoot });
    const entry = catalog.entries.get(id);
    if (!entry) {
      throw new HttpError(404, `prompt ${id} not found`);
    }
    return this.savePromptFile(entry.relativePath, content, id);
  }

  async saveNodePrompt(nodeId: string, body: JsonObject): Promise<JsonObject> {
    const node = this.topologyNode(nodeId);
    const content = stringField(body, "content");
    const document = parsePromptFrontmatter(content);
    const nextId = document.frontmatter.id ?? node.id;
    validateSafeId(nextId, "prompt ID");
    validatePromptVariables(document.body);

    if (nextId !== node.id) {
      throw new HttpError(400, "changing prompt frontmatter id from the dashboard is not supported");
    }
    const nextNode = this.topologyNode(nextId);
    return {
      ...(await this.savePromptFile(promptPathForNode(nextNode), content, nextId)),
      nodeId: nextId
    };
  }

  async savePromptFile(relativePromptPath: string, content: string, expectedId: string): Promise<JsonObject> {
    const normalized = normalizePromptRelativePath(relativePromptPath);
    const document = parsePromptFrontmatter(content);
    validatePromptVariables(document.body);
    const id = document.frontmatter.id ?? path.basename(normalized).replace(/\.(md|mdx)$/iu, "");
    if (id !== expectedId) {
      throw new HttpError(400, `prompt frontmatter id ${id} does not match ${expectedId}`);
    }
    const target = this.promptPath(normalized);
    assertNoSymlinkComponents(this.projectRoot, target, "prompt path");
    const previousContent = readTextIfExists(target);
    preflightDashboardAudit(this.projectRoot);
    writeFileDurable(target, content);
    try {
      loadPromptCatalog({ projectRoot: this.projectRoot });
      const validation = await validateProject({ projectRoot: this.projectRoot, env: this.env });
      if (!validation.ok) {
        throw new Error(diagnosticsMessage(validation.diagnostics));
      }
    } catch (error) {
      if (previousContent === undefined) {
        fs.rmSync(target, { force: true });
      } else {
        writeFileDurable(target, previousContent);
      }
      throw new HttpError(400, `saved prompt failed catalog validation: ${errorMessage(error)}`);
    }
    appendAudit(this.projectRoot, {
      kind: "prompt-edit",
      path: `.ultrafuzz/prompts/${normalized}`,
      content_hash: sha256Bytes(content)
    });
    return dashboardHttpDocument("prompt-save", {
      strategyId: expectedId,
      nodeId: expectedId,
      path: `.ultrafuzz/prompts/${normalized}`,
      contentHash: sha256Bytes(content),
      validation: {
        valid: true,
        message: `prompt ${expectedId} validates`
      }
    });
  }

  async createNodePrompt(body: JsonObject): Promise<JsonObject> {
    const content = stringField(body, "content");
    const document = parsePromptFrontmatter(content);
    validatePromptVariables(document.body);
    const nodeId = validateSafeId(document.frontmatter.id ?? "", "prompt frontmatter id");
    const group = typeof body.group === "string" && body.group.trim() ? validateSafeId(body.group, "group") : undefined;
    const requestedDependsOn = stringArrayField(body, "dependsOn").map((dependency) =>
      validateSafeId(dependency, "dependency")
    );
    const dependsOn = requestedDependsOn.length > 0 ? requestedDependsOn : [START_NODE_ID];
    const topology = this.loadTopologyForDisplay();
    if (topology.nodes.some((node) => node.id === nodeId)) {
      throw new HttpError(409, `topology node ${nodeId} already exists`);
    }
    const promptPath = group ? `${group}/${nodeId}.md` : `${nodeId}.md`;
    const promptAbsolute = this.promptPath(promptPath);
    const previousPrompt = readTextIfExists(promptAbsolute);
    if (previousPrompt !== undefined) {
      throw new HttpError(409, `prompt file ${promptPath} already exists`);
    }
    const nextTopology: ProjectTopology = {
      ...topology,
      nodes: [
        ...topology.nodes,
        {
          id: nodeId,
          kind: "agentic",
          prompt: promptPath,
          ...(group ? { group } : {}),
          depends_on: dependsOn,
          outputs: [{ path: "findings.json", contract: FINDINGS_CONTRACT, primary: true }]
        }
      ]
    };
    const finishNode = nextTopology.nodes.find((node) => node.id === FINISH_NODE_ID);
    if (finishNode) {
      finishNode.depends_on = uniqueStrings([...(finishNode.depends_on ?? []), nodeId]);
    }
    const nextContent = stringifyYaml(nextTopology, { sortMapEntries: false });
    const promptTexts = { [nodeId]: content, [promptPath]: content };
    const validation = await this.validateTopologyText(nextContent, { promptTexts, requirePromptFiles: false });
    if (!validation.valid) {
      throw new HttpError(400, validation.message);
    }
    const topologyPath = resolveTopologyPath(this.projectRoot);
    assertPathInside(this.projectRoot, topologyPath, "topology path");
    assertNoSymlinkComponents(this.projectRoot, topologyPath, "topology path");
    const previousTopology = readTextIfExists(topologyPath);
    preflightDashboardAudit(this.projectRoot);
    try {
      writeFileDurable(topologyPath, nextContent);
      return {
        ...(await this.savePromptFile(promptPath, content, nodeId)),
        nodeId
      };
    } catch (error) {
      if (previousTopology === undefined) {
        fs.rmSync(topologyPath, { force: true });
      } else {
        writeFileDurable(topologyPath, previousTopology);
      }
      if (previousPrompt === undefined) {
        fs.rmSync(promptAbsolute, { force: true });
      } else {
        writeFileDurable(promptAbsolute, previousPrompt);
      }
      throw error;
    }
  }

  async startCommand(command: string, body: JsonObject): Promise<CommandJob> {
    if (!isDashboardCommand(command)) {
      throw new HttpError(404, `unsupported dashboard command: ${command}`);
    }
    if ((command === "materialize" || command === "clean") && body.confirmed !== true) {
      throw new HttpError(400, `${command} requires explicit confirmation`);
    }
    const job: CommandJob = {
      schema_version: DASHBOARD_HTTP_SCHEMA_VERSION,
      document_type: "command-job",
      jobId: `job-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`,
      command,
      status: "running",
      startedAtUnixSeconds: unixSeconds(),
      argv: this.argvForCommand(command, body),
      output: ""
    };
    this.jobs.set(job.jobId, job);
    pruneJobs(this.jobs);
    this.executeCommand(job, body).catch((error) => {
      updateJob(job, {
        status: "failed",
        error: errorMessage(error),
        exitCode: 1,
        finishedAtUnixSeconds: unixSeconds()
      });
    });
    return job;
  }

  argvForCommand(command: DashboardCommand, body: JsonObject): string[] {
    const runId = typeof body.runId === "string" ? body.runId : this.currentRunId;
    const base = ["ultrafuzz"];
    switch (command) {
      case "references-status":
        return [...base, "references", "status", "--json"];
      case "references-sync":
        return [...base, "references", "sync", "--json"];
      case "references-update":
        return [...base, "references", "update", "--latest", "--json"];
      case "ps":
        return [...base, "ps", "--json"];
      case "validate":
      case "run":
        return [...base, command, "--json"];
      default:
        return [...base, command, runId ?? "<run-id>", "--json"];
    }
  }

  async executeCommand(job: CommandJob, body: JsonObject): Promise<void> {
    const command = job.command;
    const runId = commandNeedsRunId(command) ? await this.commandRunId(body) : undefined;
    const trustedCli =
      this.ultrafuzzCliEntrypoint === undefined ? {} : { ultrafuzzCliEntrypoint: this.ultrafuzzCliEntrypoint };
    let result: RuntimeResult<unknown> | JsonObject;
    switch (command) {
      case "validate":
        result = await validateProject({ projectRoot: this.projectRoot, env: this.env });
        break;
      case "run":
        result = await startRun({
          projectRoot: this.projectRoot,
          runId: optionalStringField(body, "runId"),
          prompt: optionalStringField(body, "prompt"),
          agent: optionalStringField(body, "agent"),
          model: optionalStringField(body, "model"),
          maxConcurrency: optionalNumberField(body, "maxConcurrency"),
          workflowInput: body.workflowInput,
          ...trustedCli,
          env: this.env
        });
        if (isRuntimeOk(result) && result.value && isRecord(result.value) && typeof result.value.run_id === "string") {
          this.currentRunId = result.value.run_id;
        }
        break;
      case "ps":
        result = await listRuns({ projectRoot: this.projectRoot, env: this.env });
        break;
      case "inspect":
        result = await getRunStatus({ projectRoot: this.projectRoot, runId: runId!, env: this.env });
        break;
      case "resume":
        result = await resumeRun({
          projectRoot: this.projectRoot,
          runId: runId!,
          maxConcurrency: optionalNumberField(body, "maxConcurrency"),
          ...trustedCli,
          env: this.env
        });
        break;
      case "replay":
        result = await replayRun({ projectRoot: this.projectRoot, runId: runId!, ...trustedCli, env: this.env });
        break;
      case "fork":
        result = await forkRun({
          projectRoot: this.projectRoot,
          runId: runId!,
          forkFrame: optionalNumberField(body, "forkFrame"),
          resetNode: optionalStringField(body, "resetNode"),
          label: optionalStringField(body, "label"),
          maxConcurrency: optionalNumberField(body, "maxConcurrency"),
          ...trustedCli,
          env: this.env
        });
        break;
      case "report":
        result = { ok: true, diagnostics: [], value: await this.report() };
        break;
      case "references-status":
        result = referencesStatus({ projectRoot: this.projectRoot });
        break;
      case "references-sync":
        result = referencesSync({ projectRoot: this.projectRoot });
        break;
      case "references-update":
        result = referencesUpdate({ projectRoot: this.projectRoot, latest: body.latest !== false });
        break;
      case "materialize":
        result = await materializeRun({
          projectRoot: this.projectRoot,
          runId: runId!,
          copies: copySelections(body),
          confirmed: true,
          dryRun: body.dryRun === true,
          allowOverwrite: body.force === true
        });
        break;
      case "clean":
        result = await cleanGenerated({
          projectRoot: this.projectRoot,
          selections:
            stringArrayField(body, "select").length > 0 ? stringArrayField(body, "select") : [`runs/${runId}`],
          confirmed: true,
          dryRun: body.dryRun === true
        });
        break;
      default:
        throw new Error(`unhandled command ${command}`);
    }
    const ok = isRuntimeOk(result);
    updateJob(job, {
      status: ok ? "succeeded" : "failed",
      output: capOutput(JSON.stringify(result, null, 2)),
      exitCode: ok ? 0 : 1,
      finishedAtUnixSeconds: unixSeconds()
    });
  }

  async commandRunId(body: JsonObject): Promise<string> {
    const runId = optionalStringField(body, "runId") ?? (await this.selectedRunId());
    if (runId === PREVIEW_RUN_ID) {
      throw new HttpError(400, "this command requires a persisted run");
    }
    return validateSafeId(runId, "run ID");
  }

  commandCapabilities(): JsonObject {
    const hasRun = this.currentRunId !== undefined && this.currentRunId !== PREVIEW_RUN_ID;
    return {
      validate: true,
      runNewCampaign: true,
      listRuns: true,
      ps: true,
      inspect: hasRun,
      resume: hasRun,
      replay: hasRun,
      fork: hasRun,
      report: hasRun,
      referencesStatus: true,
      referencesSync: true,
      referencesUpdate: true,
      materialize: hasRun,
      clean: hasRun,
      config: true,
      restartWholeRun: false,
      status: hasRun,
      doctor: false,
      triage: false,
      merge: false,
      restartFromNode: false,
      rerunSelectedNode: false,
      arbitraryShell: false
    };
  }

  async streamEvents(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    startSse(response);
    let sequence = 0;
    const send = async () => {
      try {
        writeSse(
          response,
          "ultrafuzz-event",
          dashboardSseDocument("ultrafuzz-event", sequence++, await this.events()),
          "eventsEnvelope"
        );
      } catch (error) {
        writeSse(
          response,
          "ultrafuzz-error",
          dashboardSseDocument("ultrafuzz-error", sequence++, { message: errorMessage(error) }),
          "errorEnvelope"
        );
      }
    };
    await send();
    const interval = setInterval(() => {
      send().catch(() => undefined);
    }, 2000);
    request.on("close", () => clearInterval(interval));
  }

  async streamCommandJobs(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    startSse(response);
    let sequence = 0;
    const send = () =>
      writeSse(
        response,
        "ultrafuzz-command-jobs",
        dashboardSseDocument("ultrafuzz-command-jobs", sequence++, { jobs: this.commandJobs() }),
        "commandJobsEnvelope"
      );
    send();
    const interval = setInterval(send, 1000);
    request.on("close", () => clearInterval(interval));
  }

  commandJobs(): CommandJob[] {
    return [...this.jobs.values()].sort((left, right) => right.startedAtUnixSeconds - left.startedAtUnixSeconds);
  }

  async optionalRunState(context?: DashboardRunContext): Promise<RunState | undefined> {
    context ??= await this.runContext();
    if (!context.persisted) {
      return undefined;
    }
    const layout = layoutForRunRoot(context.runRoot, context.runId);
    if (lstatIfPresent(layout.statePath) === undefined) {
      return undefined;
    }
    assertRegularFileInside(context.runRoot, layout.statePath, "run state");
    return readRunState(layout);
  }

  async expandCurrentTopology(topology: ProjectTopology): Promise<ExpandedGraph> {
    const resolved = await this.resolvedConfig();
    return expandTopology(topology, {
      projectRoot: this.projectRoot,
      requirePromptFiles: false,
      defaultTimeoutSeconds: resolved?.run.defaultTimeoutSeconds,
      modelProfiles: resolved ? modelProfilesForTopology(resolved) : undefined,
      defaultModelProfileId: resolved?.models.default
    });
  }

  loadTopologyForDisplay(): ProjectTopology {
    try {
      return loadTopology(this.projectRoot, { requirePromptFiles: false });
    } catch (error) {
      if (error instanceof TopologyError && error.code === "MISSING_TOPOLOGY") {
        return emptyTopology();
      }
      throw error;
    }
  }

  async resolvedConfig(): Promise<ResolvedConfig | undefined> {
    const resolved = await loadResolvedProject({ projectRoot: this.projectRoot, env: this.env });
    return resolved.config;
  }

  topologyNode(nodeId: string): TopologyNode {
    const safeNodeId = validateSafeId(nodeId, "node ID");
    const node = this.loadTopologyForDisplay().nodes.find((candidate) => candidate.id === safeNodeId);
    if (!node) {
      throw new HttpError(404, `topology node ${safeNodeId} not found`);
    }
    return node;
  }

  promptPath(relativePromptPath: string): string {
    const normalized = normalizePromptRelativePath(relativePromptPath);
    const promptRoot = path.join(this.projectRoot, ".ultrafuzz", "prompts");
    const absolute = safeResolveInside(promptRoot, normalized, "prompt path");
    assertPathInside(promptRoot, absolute, "prompt path");
    return absolute;
  }

  artifactAvailability(
    attempts: ExpandedNode[],
    runRoot?: string,
    authorityProjection?: DashboardFlowAuthorityProjection
  ): JsonObject {
    const paths = this.artifactPathsForAttempts(attempts, runRoot);
    const exists = (name: string) => paths.some((artifactPath) => artifactPath.endsWith(`/${name}`));
    const verifiedContracts =
      authorityProjection?.contractsByLogicalId.get(attempts[0]?.logicalId ?? "") ?? new Set<ArtifactContractId>();
    return {
      logs: exists("stdout.log") || exists("stderr.log"),
      renderedPrompt: exists("prompt.rendered.md"),
      findings: DASHBOARD_FINDINGS_CONTRACTS.some((contract) => verifiedContracts.has(contract)),
      patch: paths.some((artifactPath) => /\.(patch|diff)$/u.test(artifactPath)),
      report: verifiedContracts.has("ultrafuzz/report@2"),
      metadata: exists("metadata.json")
    };
  }

  artifactPathsForAttempts(attempts: ExpandedNode[], runRoot?: string): string[] {
    if (!runRoot || this.currentRunId === PREVIEW_RUN_ID) {
      return [];
    }
    const paths: string[] = [];
    for (const attempt of attempts) {
      const dir = path.join(runRoot, attempt.artifactDir);
      if (!fs.existsSync(dir)) {
        continue;
      }
      try {
        paths.push(...listSafeFiles(dir).map((entry) => `${attempt.artifactDir}/${entry.relativePath}`));
      } catch {
        continue;
      }
    }
    return paths;
  }
}

export interface CommandJob {
  schema_version: typeof DASHBOARD_HTTP_SCHEMA_VERSION;
  document_type: "command-job";
  jobId: string;
  command: DashboardCommand;
  status: CommandJobStatus;
  startedAtUnixSeconds: number;
  finishedAtUnixSeconds?: number;
  argv: string[];
  output: string;
  error?: string;
  exitCode?: number;
}

class HttpError extends Error {
  readonly status: number;
  readonly closeConnection: boolean;

  constructor(status: number, message: string, closeConnection = false) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.closeConnection = closeConnection;
  }
}

function parseHttpMethod(method: string | undefined): HttpMethod {
  if (method === "GET" || method === "POST" || method === "PUT" || method === "DELETE") return method;
  throw new HttpError(405, `unsupported HTTP method: ${method ?? "missing"}`);
}

function listen(server: http.Server, host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (typeof address === "string" || address === null) {
        resolve(`${host}:${port}`);
        return;
      }
      const renderedHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
      resolve(`${renderedHost}:${address.port}`);
    });
  });
}

function validateLoopbackHost(host: string): void {
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return;
  }
  throw new HttpError(400, `dashboard host ${host} is not loopback`);
}

function requireLocalRequest(request: http.IncomingMessage): void {
  const host = request.headers.host;
  if (host && !isLoopbackAuthority(host)) {
    throw new HttpError(403, "dashboard API requires a loopback Host header");
  }
  const origin = request.headers.origin;
  if (typeof origin === "string" && !isLoopbackOrigin(origin)) {
    throw new HttpError(403, "dashboard API rejects non-loopback Origin headers");
  }
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite === "cross-site") {
    throw new HttpError(403, "dashboard API rejects cross-site browser requests");
  }
}

function requireMutation(request: http.IncomingMessage, sessionToken: string): void {
  requireLocalRequest(request);
  const token = request.headers[SESSION_HEADER];
  if (typeof token !== "string" || !constantTimeEqual(token, sessionToken)) {
    throw new HttpError(401, "missing or invalid dashboard session token");
  }
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackAuthority(new URL(origin).host);
  } catch {
    return false;
  }
}

function isLoopbackAuthority(authority: string): boolean {
  const host = authority.startsWith("[") ? authority.slice(1, authority.indexOf("]")) : (authority.split(":")[0] ?? "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function readBodyObject(request: http.IncomingMessage): Promise<JsonObject> {
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      throw new HttpError(400, "invalid Content-Length header");
    }
    if (declaredBytes > MAX_REQUEST_BODY_BYTES) {
      request.pause();
      throw new HttpError(413, "request body exceeds the maximum allowed size", true);
    }
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      request.pause();
      throw new HttpError(413, "request body exceeds the maximum allowed size", true);
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    const parsed = parseStrictJsonBytes(Buffer.concat(chunks), {
      maxBytes: MAX_REQUEST_BODY_BYTES,
      maxDepth: 128,
      maxItems: 100_000,
      maxProperties: 100_000
    });
    if (!isRecord(parsed)) {
      throw new Error("body must be a JSON object");
    }
    return parsed;
  } catch (error) {
    throw new HttpError(400, `invalid JSON request body: ${errorMessage(error)}`);
  }
}

async function readDashboardRequest(
  request: http.IncomingMessage,
  definition: DashboardHttpDefinition
): Promise<JsonObject> {
  const body = await readBodyObject(request);
  try {
    assertDashboardHttpDocument(body, definition, `dashboard HTTP ${definition}`);
  } catch (error) {
    throw new HttpError(400, errorMessage(error));
  }
  return body;
}

function sendJson(
  response: http.ServerResponse,
  value: unknown,
  definition: DashboardHttpDefinition,
  status = 200
): void {
  const body = serializeDashboardHttpDocument(value, definition);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": body.byteLength
  });
  response.end(body);
}

function sendError(response: http.ServerResponse, error: unknown): void {
  const status = error instanceof HttpError ? error.status : 500;
  if (error instanceof HttpError && error.closeConnection) {
    response.shouldKeepAlive = false;
    response.setHeader("connection", "close");
  }
  sendJson(response, dashboardHttpDocument("error", { error: errorMessage(error) }), "errorResponse", status);
}

function applySecurityHeaders(response: http.ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
}

async function sendStaticAsset(response: http.ServerResponse, relativePath: string): Promise<void> {
  const publicRoot = fileURLToPath(new URL("./public/", import.meta.url));
  const normalized = relativePath.replace(/^\/+/u, "");
  if (normalized.includes("..") || normalized.includes("\\")) {
    throw new HttpError(400, "invalid dashboard asset path");
  }
  const filePath = path.join(publicRoot, normalized === "" ? "index.html" : normalized);
  assertPathInside(publicRoot, filePath, "dashboard asset");
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new HttpError(404, "dashboard asset not found");
  }
  const extension = path.extname(filePath);
  response.writeHead(200, {
    "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream",
    "cache-control": extension === ".html" ? "no-store" : "no-cache"
  });
  fs.createReadStream(filePath).pipe(response);
}

function startSse(response: http.ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  response.write(": connected\n\n");
}

function writeSse(
  response: http.ServerResponse,
  event: DashboardSseEventType,
  data: JsonObject,
  definition: DashboardSseDefinition
): void {
  if (data.event_type !== event) throw new Error("dashboard SSE event name and envelope type disagree");
  const serialized = serializeDashboardSseDocument(data, definition);
  response.write(`event: ${event}\n`);
  response.write(`data: ${serialized}\n\n`);
}

function dashboardHttpDocument(documentType: string, value: JsonObject): JsonObject {
  return {
    schema_version: DASHBOARD_HTTP_SCHEMA_VERSION,
    document_type: documentType,
    ...value
  };
}

function dashboardSseDocument(eventType: DashboardSseEventType, sequence: number, payload: JsonObject): JsonObject {
  return {
    schema_version: DASHBOARD_SSE_SCHEMA_VERSION,
    event_type: eventType,
    sequence,
    generated_at: new Date().toISOString(),
    payload
  };
}

function emptyTopology(): ProjectTopology {
  return {
    version: 2,
    defaults: { strategy_loops: 1 },
    groups: {},
    nodes: []
  };
}

function promptPathForNode(node: TopologyNode): string {
  if (node.prompt) {
    return node.prompt;
  }
  return node.group ? `${node.group}/${node.id}.md` : `${node.id}.md`;
}

function displayNameForNode(projectRoot: string, node: TopologyNode): string {
  if (node.kind === "meta" && node.role) {
    return node.role === "start" ? "START" : "FINISH";
  }
  const promptPath = promptPathForNode(node);
  const absolute = path.join(projectRoot, ".ultrafuzz", "prompts", ...promptPath.split("/"));
  const content = readTextIfExists(absolute);
  if (content !== undefined) {
    try {
      return parsePromptFrontmatter(content).frontmatter.display_name ?? titleFromId(node.id);
    } catch {
      return titleFromId(node.id);
    }
  }
  return titleFromId(node.id);
}

function defaultPromptMarkdown(id: string, displayName: string): string {
  return `---\nid: ${id}\ndisplay_name: ${JSON.stringify(displayName)}\n---\n\nDescribe the ${displayName} task here.\n`;
}

function nodeKindLabel(node: TopologyNode): string {
  if (node.kind === "meta") {
    return node.role ?? "meta";
  }
  return node.kind ?? "agentic";
}

function flowNodeType(node: TopologyNode): string {
  if (node.kind === "meta" && node.role === "start") {
    return "metaStart";
  }
  if (node.kind === "meta" && node.role === "finish") {
    return "metaFinish";
  }
  if (node.kind === "reference") {
    return "reference";
  }
  if (node.id.includes("final-report")) {
    return "report";
  }
  if (node.id.includes("triage") || node.id.includes("severity-classification")) {
    return "triage";
  }
  if (node.id.includes("dedupe")) {
    return "dedupe";
  }
  if (node.group === "setup") {
    return "projectDiscovery";
  }
  if (node.group === "properties") {
    return "propertySpecification";
  }
  return "agentAttempt";
}

function groupExpandedNodes(nodes: ExpandedNode[]): Map<string, ExpandedNode[]> {
  const grouped = new Map<string, ExpandedNode[]>();
  for (const node of nodes) {
    const entries = grouped.get(node.logicalId) ?? [];
    entries.push(node);
    grouped.set(node.logicalId, entries);
  }
  return grouped;
}

function aggregateLogicalStatus(attempts: ExpandedNode[], state: RunState | undefined): Status {
  if (!state) {
    return "pending";
  }
  const states = attempts
    .map((attempt) => state.nodes[attempt.id])
    .filter((entry): entry is NodeState => entry !== undefined);
  if (states.length === 0) {
    return "pending";
  }
  const statuses = states.map((entry) => entry.status);
  if (statuses.some((status) => status === "failed")) {
    return "failed";
  }
  if (statuses.some((status) => status === "timed-out")) {
    return "timed-out";
  }
  if (statuses.some((status) => status === "running")) {
    return "running";
  }
  if (statuses.some((status) => status === "ready" || status === "runnable")) {
    return "ready";
  }
  if (statuses.every((status) => status === "succeeded" || status === "reused-from-prior-run")) {
    return "succeeded";
  }
  if (statuses.some((status) => status === "succeeded" || status === "reused-from-prior-run")) {
    return "running";
  }
  return statuses[0] ?? "pending";
}

function stateForLogicalNode(logicalId: string, attempts: ExpandedNode[], state: RunState | undefined): unknown {
  if (!state) {
    return undefined;
  }
  const concrete = attempts.map((attempt) => state.nodes[attempt.id]).filter(Boolean);
  return { logicalNodeId: logicalId, attempts: concrete };
}

function latestErrorForLogicalNode(attempts: ExpandedNode[], state: RunState | undefined): string | undefined {
  if (!state) {
    return undefined;
  }
  return attempts
    .map((attempt) => state.nodes[attempt.id]?.last_error)
    .find((message): message is string => typeof message === "string" && message.length > 0);
}

function firstModelSummary(attempts: ExpandedNode[]): JsonObject | undefined {
  const model = attempts.flatMap((attempt) => attempt.modelFanout)[0];
  if (!model) {
    return undefined;
  }
  return {
    id: model.modelProfileId,
    backend: model.agentRef,
    model: model.modelName
  };
}

function edgeColorForStatus(status: string): string {
  if (status === "failed" || status === "timed-out") {
    return "var(--mds-status-error)";
  }
  if (status === "succeeded" || status === "reused-from-prior-run") {
    return "var(--mds-status-success)";
  }
  if (status === "running" || status === "ready" || status === "runnable") {
    return "var(--mds-status-info)";
  }
  return "var(--mds-border-strong)";
}

interface DashboardFindingsDeclaration {
  attemptId: string;
  concreteNodeId: string;
  logicalNodeId: string;
  output: PlannedGraphOutput & { contract: DashboardFindingsContract };
  stage: DashboardFindingsStage;
  source: string;
}

interface DashboardFindingsAuthorityContext {
  authority: VerifiedRunOutputAuthoritySnapshot;
  state: RunState;
  graph: PlannedGraphDocument;
  declarations: readonly DashboardFindingsDeclaration[];
}

interface DashboardFlowAuthorityProjection {
  authority: VerifiedRunOutputAuthoritySnapshot;
  state: RunState;
  allFindings: readonly unknown[];
  findingsByLogicalId: ReadonlyMap<string, readonly unknown[]>;
  contractsByLogicalId: ReadonlyMap<string, ReadonlySet<ArtifactContractId>>;
}

export function dashboardFlowAuthorityProjection(
  runRoot: string,
  observedState: RunState | undefined
): DashboardFlowAuthorityProjection | undefined {
  const layout = layoutForRunRoot(runRoot);
  const controlAuthority = dashboardControlAuthorityPresence(layout);
  if (
    !controlAuthority.tasksPresent &&
    !controlAuthority.sealPresent &&
    (observedState === undefined || !Object.values(observedState.nodes).some((node) => node.status === "succeeded"))
  ) {
    return undefined;
  }
  const authority = loadVerifiedRunOutputAuthoritySnapshot(runRoot);
  const findingsContext = dashboardFindingsAuthorityContext(authority);
  if (observedState === undefined || !isDeepStrictEqual(findingsContext.state, observedState)) {
    throw new Error("dashboard run state changed between the initial read and output-authority capture");
  }
  const allFindings = selectDashboardFindings(findingsContext).findings;
  const declarationIdsByLogical = new Map<string, Set<string>>();
  for (const declaration of findingsContext.declarations) {
    const ids = declarationIdsByLogical.get(declaration.logicalNodeId) ?? new Set<string>();
    ids.add(declaration.attemptId);
    ids.add(declaration.concreteNodeId);
    declarationIdsByLogical.set(declaration.logicalNodeId, ids);
  }
  const findingsByLogicalId = new Map<string, readonly unknown[]>();
  for (const [logicalNodeId, ids] of declarationIdsByLogical) {
    findingsByLogicalId.set(logicalNodeId, selectDashboardFindings(findingsContext, ids).findings);
  }
  const contractsByLogicalId = new Map<string, Set<ArtifactContractId>>();
  for (const output of authority.outputs) {
    const contracts = contractsByLogicalId.get(output.logical_node_id) ?? new Set<ArtifactContractId>();
    for (const artifact of output.outputs) contracts.add(artifact.contract);
    contractsByLogicalId.set(output.logical_node_id, contracts);
  }
  return { authority, state: findingsContext.state, allFindings, findingsByLogicalId, contractsByLogicalId };
}

function assertDashboardAbsentAuthorityRemainedCurrent(runRoot: string, state: RunState | undefined): void {
  const layout = layoutForRunRoot(runRoot);
  const controlAuthority = dashboardControlAuthorityPresence(layout);
  const currentStatePresent = lstatIfPresent(layout.statePath) !== undefined;
  if (
    controlAuthority.tasksPresent ||
    controlAuthority.sealPresent ||
    (state === undefined
      ? currentStatePresent
      : !currentStatePresent || !isDeepStrictEqual(readRunState(layout), state))
  ) {
    throw new Error("dashboard output authority changed while the response was being projected");
  }
}

function assertDashboardCapturedRunAuthorityRemainedCurrent(captured: DashboardCapturedRunAuthority): void {
  if (captured.authorityProjection !== undefined) {
    assertVerifiedRunOutputAuthorityRemainedCurrent(captured.authorityProjection.authority);
  } else if (captured.context.persisted) {
    assertDashboardAbsentAuthorityRemainedCurrent(captured.context.runRoot, captured.state);
  }
}

interface DashboardReportAvailability {
  physicalPresent: boolean;
  claimedSuccess: boolean;
  invalidDeclaration: boolean;
}

function dashboardDeclaredReportAvailability(runRoot: string): DashboardReportAvailability {
  const layout = layoutForRunRoot(runRoot);
  const graph = readPlannedGraphDocument(layout.graphPath);
  const state = readRunState(layout);
  const producers = graph.nodes.filter((node) =>
    node.outputs.some((output) => output.contract === "ultrafuzz/report@2")
  );
  let sealedTasks: ReturnType<typeof verifySealedTaskManifestSnapshot>["document"]["tasks"] = [];
  const controlAuthority = dashboardControlAuthorityPresence(layout);
  if (controlAuthority.tasksPresent || controlAuthority.sealPresent) {
    sealedTasks = verifySealedTaskManifestSnapshot(layout).document.tasks;
  }

  let physicalPresent = false;
  let claimedSuccess = false;
  let invalidDeclaration = producers.length > 1;
  for (const producer of producers) {
    const reportOutputs = producer.outputs.filter((output) => output.contract === "ultrafuzz/report@2");
    const markdownOutputs = producer.outputs.filter((output) => output.contract === "ultrafuzz/nonempty-markdown@1");
    invalidDeclaration ||= reportOutputs.length !== 1 || markdownOutputs.length !== 1;
    const reportPaths = [...reportOutputs, ...markdownOutputs].map((output) => output.path);
    const producerTasks = sealedTasks.filter(
      (task) => task.concreteNodeId === producer.id && task.logicalNodeId === producer.logical_id
    );
    const candidateArtifactDirs = new Set([producer.artifact_dir]);
    for (const task of producerTasks) {
      candidateArtifactDirs.add(path.posix.join("artifacts", validateSafeId(task.attemptId, "report attempt ID")));
      if (state.nodes[task.attemptId]?.status === "succeeded") claimedSuccess = true;
    }
    claimedSuccess ||= Object.entries(state.nodes).some(
      ([attemptId, node]) =>
        node.status === "succeeded" &&
        (attemptId === producer.id ||
          node.logical_node_id === producer.logical_id ||
          producerTasks.some((task) => task.attemptId === attemptId))
    );
    for (const artifactDir of candidateArtifactDirs) {
      for (const reportPath of reportPaths) {
        const candidate = safeResolveInside(
          runRoot,
          path.posix.join(artifactDir, reportPath),
          "declared dashboard report output"
        );
        if (lstatIfPresent(candidate) !== undefined) physicalPresent = true;
      }
    }
  }
  return { physicalPresent, claimedSuccess, invalidDeclaration };
}

function dashboardControlAuthorityPresence(layout: ReturnType<typeof layoutForRunRoot>): {
  tasksPresent: boolean;
  sealPresent: boolean;
} {
  const smithersRoot = safeResolveInside(layout.root, "smithers", "workflow control directory");
  const tasksPath = safeResolveInside(smithersRoot, "tasks.json", "workflow task manifest");
  const sealPath = safeResolveInside(smithersRoot, "control-integrity.json", "workflow control seal");
  return {
    tasksPresent: lstatIfPresent(tasksPath) !== undefined,
    sealPresent: lstatIfPresent(sealPath) !== undefined
  };
}

function verifiedDeclaredFindings(
  runRoot: string,
  attemptIds?: ReadonlySet<string>
): { source: string; findings: unknown[] } {
  const layout = layoutForRunRoot(runRoot);
  const controlAuthority = dashboardControlAuthorityPresence(layout);
  if (
    !controlAuthority.tasksPresent &&
    !controlAuthority.sealPresent &&
    !Object.values(readRunState(layout).nodes).some((node) => node.status === "succeeded")
  ) {
    return { source: "none", findings: [] };
  }
  return verifiedDeclaredFindingsFromAuthoritySnapshot(loadVerifiedRunOutputAuthoritySnapshot(runRoot), attemptIds);
}

/**
 * Select dashboard findings from one authenticated run-wide authority epoch.
 * The final recheck is deliberately part of this helper so recursive callers
 * and deterministic mutation tests cannot accidentally omit it.
 */
export function verifiedDeclaredFindingsFromAuthoritySnapshot(
  authority: VerifiedRunOutputAuthoritySnapshot,
  attemptIds?: ReadonlySet<string>
): { source: string; findings: unknown[] } {
  const context = dashboardFindingsAuthorityContext(authority);
  const result = selectDashboardFindings(context, attemptIds);
  assertVerifiedRunOutputAuthorityRemainedCurrent(authority);
  return result;
}

function dashboardFindingsAuthorityContext(
  authority: VerifiedRunOutputAuthoritySnapshot
): DashboardFindingsAuthorityContext {
  const state = assertRunStateSchema(parseStrictJsonBytes(authority.state.bytes));
  const graph = assertPlannedGraph(parseStrictJsonBytes(authority.graph.bytes));
  const sealedTasks = parseSmithersTaskManifestBytes(authority.workflow_tasks.bytes).tasks;
  const outputsByAttempt = new Map<string, VerifiedNodeOutputSnapshot>();
  for (const output of authority.outputs) {
    if (outputsByAttempt.has(output.attempt_id)) {
      throw new Error(`dashboard run authority repeats verified attempt ${output.attempt_id}`);
    }
    outputsByAttempt.set(output.attempt_id, output);
  }
  const declarations: DashboardFindingsDeclaration[] = [];
  const plannedNodes = graph.nodes
    .map((plannedNode) => ({
      plannedNode,
      outputs: plannedNode.outputs.filter(
        (output): output is PlannedGraphOutput & { contract: DashboardFindingsContract } =>
          isDashboardFindingsContract(output.contract)
      )
    }))
    .filter(({ outputs }) => outputs.length > 0);

  if (plannedNodes.length > 0 && Object.values(state.nodes).some(hasSuccessfulDashboardNodeFinalization)) {
    for (const { plannedNode, outputs } of plannedNodes) {
      const finalizedTasks = sealedTasks.filter(
        (task) =>
          task.concreteNodeId === plannedNode.id &&
          task.logicalNodeId === plannedNode.logical_id &&
          hasSuccessfulDashboardNodeFinalization(state.nodes[task.attemptId]) &&
          outputsByAttempt.has(task.attemptId)
      );
      if (finalizedTasks.length === 0) continue;
      const counts = new Map<DashboardFindingsContract, number>();
      for (const output of outputs) counts.set(output.contract, (counts.get(output.contract) ?? 0) + 1);
      const duplicate = [...counts].find(([, count]) => count > 1);
      if (duplicate !== undefined) {
        throw new Error(
          `dashboard findings authority for ${plannedNode.id} declares ${duplicate[1]} ${duplicate[0]} outputs; exactly one per contract is required`
        );
      }
      for (const task of finalizedTasks) {
        const snapshot = outputsByAttempt.get(task.attemptId)!;
        if (snapshot.logical_node_id !== task.logicalNodeId) {
          throw new Error(`dashboard verified output authority does not bind sealed task ${task.attemptId}`);
        }
        for (const output of outputs) {
          declarations.push({
            attemptId: task.attemptId,
            concreteNodeId: task.concreteNodeId,
            logicalNodeId: plannedNode.logical_id,
            output,
            stage: dashboardFindingsStage(plannedNode.outputs, output.contract),
            source: path.posix.join("artifacts", task.attemptId, output.path)
          });
        }
      }
    }
  }

  return { authority, state, graph, declarations };
}

function selectDashboardFindings(
  context: DashboardFindingsAuthorityContext,
  attemptIds?: ReadonlySet<string>
): { source: string; findings: unknown[] } {
  const declarations =
    attemptIds === undefined
      ? context.declarations
      : context.declarations.filter(
          (declaration) => attemptIds.has(declaration.attemptId) || attemptIds.has(declaration.concreteNodeId)
        );
  const selectedStage = DASHBOARD_FINDINGS_STAGE_PRIORITY.find((stage) =>
    declarations.some((candidate) => candidate.stage === stage)
  );
  const selected =
    selectedStage === undefined
      ? []
      : declarationFrontier(
          context.graph,
          declarations.filter((candidate) => candidate.stage === selectedStage)
        ).sort((left, right) => left.source.localeCompare(right.source));
  const findings = selected.flatMap((declaration) => readVerifiedFindingsDeclaration(context.authority, declaration));
  const result =
    selected.length === 0
      ? { source: "none", findings: [] }
      : {
          source:
            selected.length === 1 ? selected[0]!.source : `declared:${selected.map((entry) => entry.source).join(",")}`,
          findings
        };
  return result;
}

function declarationFrontier(
  graph: PlannedGraphDocument,
  candidates: readonly DashboardFindingsDeclaration[]
): DashboardFindingsDeclaration[] {
  return candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) =>
          other.logicalNodeId !== candidate.logicalNodeId &&
          logicalNodeDependsOn(graph, other.logicalNodeId, candidate.logicalNodeId)
      )
  );
}

function logicalNodeDependsOn(
  graph: PlannedGraphDocument,
  descendantLogicalId: string,
  ancestorLogicalId: string
): boolean {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const pending = graph.nodes
    .filter((node) => node.logical_id === descendantLogicalId)
    .flatMap((node) => node.depends_on);
  const visited = new Set<string>();
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (visited.has(next)) continue;
    visited.add(next);
    const node = nodesById.get(next);
    if (node === undefined) continue;
    if (node.logical_id === ancestorLogicalId) return true;
    pending.push(...node.depends_on);
  }
  return false;
}

function readVerifiedFindingsDeclaration(
  authority: VerifiedRunOutputAuthoritySnapshot,
  declaration: DashboardFindingsDeclaration
): unknown[] {
  const node = authority.outputs.find(
    (output) => output.attempt_id === declaration.attemptId && output.logical_node_id === declaration.logicalNodeId
  );
  if (node === undefined) {
    throw new Error(`dashboard findings declaration lacks run-wide verified authority: ${declaration.source}`);
  }
  const matches = node.outputs.filter(
    (output) => output.path === declaration.output.path && output.contract === declaration.output.contract
  );
  if (matches.length !== 1) {
    throw new Error(`dashboard findings declaration is not one exact verified output: ${declaration.source}`);
  }
  if (declaration.output.contract === "ultrafuzz/report@2") {
    const report = matches[0]!;
    const markdown = node.outputs.filter((output) => output.contract === "ultrafuzz/nonempty-markdown@1");
    if (markdown.length !== 1) {
      throw new Error("dashboard report findings declaration does not have one exact Markdown companion");
    }
    const projection = projectCanonicalFinalReport(report.value);
    if (!isDeepStrictEqual(projection.report, report.value)) {
      throw new Error("dashboard verified report JSON is not its canonical final-report projection");
    }
    if (!markdown[0]!.bytes.equals(Buffer.from(projection.markdown, "utf8"))) {
      throw new Error("dashboard verified report Markdown is not the canonical projection of report JSON");
    }
    if (!isRecord(report.value) || !Array.isArray(report.value.issues)) {
      throw new Error(`verified report does not contain an issues array: ${declaration.source}`);
    }
    return report.value.issues;
  }

  const value = matches[0]!.value;
  if (!Array.isArray(value)) {
    throw new Error(`verified findings-stage artifact is not an array: ${declaration.source}`);
  }
  return value;
}

function isDashboardFindingsContract(contract: ArtifactContractId): contract is DashboardFindingsContract {
  return (DASHBOARD_FINDINGS_CONTRACTS as readonly ArtifactContractId[]).includes(contract);
}

function dashboardFindingsStage(
  outputs: readonly PlannedGraphOutput[],
  contract: DashboardFindingsContract
): DashboardFindingsStage {
  switch (contract) {
    case "ultrafuzz/severity-classified-findings@1":
      return "severity-classified";
    case "ultrafuzz/triaged-findings@1":
      return "triaged";
    case "ultrafuzz/report@2":
      return "report";
    case "ultrafuzz/findings@2":
      return outputs.some((output) => output.contract === "ultrafuzz/finding-lifecycle-ledger@1") ? "deduped" : "raw";
  }
}

function hasSuccessfulDashboardNodeFinalization(node: NodeState | undefined): boolean {
  if (node?.status !== "succeeded" || !isRecord(node.provenance)) return false;
  const outputContracts = node.provenance.output_contracts;
  return isRecord(outputContracts) && outputContracts.ok === true && Array.isArray(outputContracts.missing);
}

function posixRelativePath(root: string, filePath: string): string {
  assertPathInside(root, filePath, "dashboard artifact response path");
  return path.relative(path.resolve(root), path.resolve(filePath)).split(path.sep).join("/");
}

function copySelections(body: JsonObject): Array<{ source: string; destination: string }> {
  const copies = body.copies;
  if (copies === undefined) return [];
  if (!Array.isArray(copies)) {
    throw new HttpError(400, "copies must be an array");
  }
  return copies.map((copy, index) => {
    if (!isRecord(copy)) throw new HttpError(400, `copies[${index}] must be an object`);
    return {
      source: stringField(copy, "source"),
      destination: stringField(copy, "destination")
    };
  });
}

function isDashboardCommand(value: string): value is DashboardCommand {
  return SUPPORTED_COMMANDS.has(value);
}

function commandNeedsRunId(command: DashboardCommand): boolean {
  return ["inspect", "resume", "replay", "fork", "report", "materialize", "clean"].includes(command);
}

function isRuntimeOk(value: unknown): boolean {
  return isRecord(value) && value.ok === true;
}

function capOutput(output: string): string {
  if (Buffer.byteLength(output) <= MAX_COMMAND_OUTPUT_BYTES) {
    return output;
  }
  const buffer = Buffer.from(output);
  return `[output truncated]\n${buffer.subarray(buffer.length - MAX_COMMAND_OUTPUT_BYTES).toString("utf8")}`;
}

function updateJob(job: CommandJob, patch: Partial<CommandJob>): void {
  Object.assign(job, patch);
}

function pruneJobs(jobs: Map<string, CommandJob>): void {
  const entries = [...jobs.values()].sort((left, right) => right.startedAtUnixSeconds - left.startedAtUnixSeconds);
  for (const job of entries.slice(MAX_COMMAND_JOBS)) {
    if (job.status !== "running") {
      jobs.delete(job.jobId);
    }
  }
}

function preflightDashboardAudit(projectRoot: string): void {
  readDashboardAuditJournal(path.join(projectRoot, ".ultrafuzz", "dashboard-audit.jsonl"));
}

function appendAudit(projectRoot: string, value: DashboardAuditInput): void {
  const auditPath = path.join(projectRoot, ".ultrafuzz", "dashboard-audit.jsonl");
  appendDashboardAuditRecord(auditPath, value, projectRoot);
}

function readTextIfExists(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function lstatIfPresent(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function elapsedSeconds(state: RunState | undefined): number | undefined {
  if (!state?.started_at) {
    return undefined;
  }
  const end = state.finished_at ? Date.parse(state.finished_at) : Date.now();
  const start = Date.parse(state.started_at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return undefined;
  }
  return Math.max(0, Math.round((end - start) / 1000));
}

function diagnosticsMessage(diagnostics: Array<{ code: string; message: string }>): string {
  return diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("; ");
}

function stringField(record: JsonObject, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new HttpError(400, `${key} must be a string`);
  }
  return value;
}

function optionalStringField(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, `${key} must be a string`);
  }
  return value;
}

function optionalNumberField(record: JsonObject, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, `${key} must be a number`);
  }
  return value;
}

function stringArrayField(record: JsonObject, key: string): string[] {
  const value = record[key];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new HttpError(400, `${key} must be an array of strings`);
  }
  return value;
}

function recordField(record: JsonObject, key: string): JsonObject {
  const value = record[key];
  if (!isRecord(value)) {
    throw new HttpError(400, `${key} must be an object`);
  }
  return value;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string"))];
}

function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
