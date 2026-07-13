import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  appendLineDurable,
  assertNoSymlinkComponents,
  assertPathInside,
  assertRegularFileInside,
  layoutForRunRoot,
  listSafeFiles,
  queryEvents,
  readJsonFile,
  readRunState,
  replayEvents,
  safeResolveInside,
  sha256Bytes,
  validateSafeId,
  writeFileDurable,
  type NodeState,
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
  type RuntimeResult
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
  type TopologyNode
} from "@ultrafuzz/topology";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface DashboardServerConfig {
  projectRoot?: string;
  host?: string;
  port?: number;
  runId?: string;
  liveUpdates?: boolean;
  env?: Record<string, string | undefined>;
}

export interface DashboardHandle {
  bindAddr: string;
  url: string;
  runId: string;
  sessionToken: string;
  close: () => Promise<void>;
}

type Status = string;
type JsonObject = Record<string, unknown>;
type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3875;
const PREVIEW_RUN_ID = "preview";
const SESSION_HEADER = "x-ultrafuzz-session";
const MAX_COMMAND_JOBS = 20;
const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
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

const SUPPORTED_COMMANDS = new Set([
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
  readonly sessionToken = crypto.randomBytes(32).toString("hex");
  readonly jobs = new Map<string, CommandJob>();
  private requestedRunId?: string;
  private currentRunId?: string;

  private constructor(
    config: Required<Pick<DashboardServerConfig, "host" | "port" | "liveUpdates">> & {
      projectRoot: string;
      runId?: string;
      env: Record<string, string | undefined>;
    }
  ) {
    this.projectRoot = config.projectRoot;
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
      env: config.env ?? process.env
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
    const method = request.method as HttpMethod;
    const segments = url.pathname.split("/").filter(Boolean).slice(1);

    if (method === "GET" && segments.length === 1 && segments[0] === "session") {
      sendJson(response, await this.session());
      return;
    }
    if (method === "GET" && segments.length === 1 && segments[0] === "flow") {
      sendJson(response, await this.flow());
      return;
    }
    if (method === "GET" && segments.length === 1 && segments[0] === "run") {
      sendJson(response, await this.runOverview());
      return;
    }
    if (method === "GET" && segments.length === 1 && segments[0] === "graph") {
      sendJson(response, await this.graphDetail());
      return;
    }
    if (method === "GET" && segments.length === 1 && segments[0] === "nodes") {
      sendJson(response, { nodes: (await this.flow()).nodes });
      return;
    }
    if (method === "GET" && segments.length === 2 && segments[0] === "nodes") {
      sendJson(response, await this.nodeDetail(decodeURIComponent(segments[1]!)));
      return;
    }
    if (method === "GET" && segments.length === 1 && segments[0] === "findings") {
      sendJson(response, await this.findings());
      return;
    }
    if (method === "GET" && segments.length === 1 && segments[0] === "report") {
      sendJson(response, await this.report());
      return;
    }
    if (method === "GET" && segments.length === 1 && segments[0] === "events") {
      sendJson(response, await this.events());
      return;
    }
    if (method === "GET" && segments.length === 2 && segments[0] === "events" && segments[1] === "stream") {
      await this.streamEvents(request, response);
      return;
    }
    if (segments[0] === "config") {
      if (method === "GET" && segments.length === 1) {
        sendJson(response, await this.configDetail());
        return;
      }
      if (method === "PUT" && segments.length === 1) {
        requireMutation(request, this.sessionToken);
        sendJson(response, await this.saveConfig(await readBodyObject(request)));
        return;
      }
    }
    if (segments[0] === "topology") {
      if (method === "GET" && segments.length === 1) {
        sendJson(response, await this.topologyDetail());
        return;
      }
      if (method === "PUT" && segments.length === 1) {
        requireMutation(request, this.sessionToken);
        sendJson(response, await this.saveTopology(await readBodyObject(request)));
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
      sendJson(response, { prompts: this.promptSummaries() });
      return;
    }
    if (segments.length === 3 && segments[1] === "strategies") {
      const id = decodeURIComponent(segments[2]!);
      if (method === "GET") {
        sendJson(response, this.promptDetail(id, "strategy"));
        return;
      }
      if (method === "PUT") {
        requireMutation(request, this.sessionToken);
        sendJson(response, await this.saveStrategyPrompt(id, await readBodyObject(request)));
        return;
      }
    }
    if (segments.length === 2 && segments[1] === "nodes" && method === "POST") {
      requireMutation(request, this.sessionToken);
      sendJson(response, await this.createNodePrompt(await readBodyObject(request)), 201);
      return;
    }
    if (segments.length === 3 && segments[1] === "nodes") {
      const id = decodeURIComponent(segments[2]!);
      if (method === "GET") {
        sendJson(response, await this.nodePromptDetail(id));
        return;
      }
      if (method === "PUT") {
        requireMutation(request, this.sessionToken);
        sendJson(response, await this.saveNodePrompt(id, await readBodyObject(request)));
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
      sendJson(response, await this.startCommand(command, await readBodyObject(request)), 202);
      return;
    }
    if (method === "GET" && segments.length === 2) {
      const job = this.jobs.get(decodeURIComponent(segments[1]!));
      if (!job) {
        throw new HttpError(404, "command job not found");
      }
      sendJson(response, job);
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
    return {
      runId: await this.selectedRunId(),
      liveUpdates: this.liveUpdates,
      sessionToken: this.sessionToken,
      templateVariables: [...SUPPORTED_TEMPLATE_VARIABLES]
    };
  }

  async runContext(): Promise<{
    runId: string;
    runsRoot: string;
    runRoot: string;
    persisted: boolean;
  }> {
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
        try {
          const runId = validateSafeId(entry.name, "run ID");
          const root = path.join(runsRoot, runId);
          const metadata = readJsonIfExists<JsonObject>(path.join(root, "run.json"));
          return {
            runId,
            createdAt: typeof metadata?.created_at === "string" ? metadata.created_at : "",
            mtimeMs: fs.statSync(root).mtimeMs
          };
        } catch {
          return undefined;
        }
      })
      .filter((entry): entry is { runId: string; createdAt: string; mtimeMs: number } => entry !== undefined)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.mtimeMs - left.mtimeMs);
    return candidates[0]?.runId;
  }

  async flow(): Promise<JsonObject> {
    const topology = this.loadTopologyForDisplay();
    const expanded = await this.expandCurrentTopology(topology);
    const run = await this.runOverviewFrom(topology, expanded);
    const state = await this.optionalRunState();
    const context = await this.runContext();
    const attemptsByLogicalId = groupExpandedNodes(expanded.nodes);
    const nodes = topology.nodes.map((node, index) =>
      this.flowNode(node, index, attemptsByLogicalId.get(node.id) ?? [], state, context.runRoot)
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
    return {
      run,
      nodes,
      edges,
      strategies: nodes.map((node) => (node.data as JsonObject).strategy).filter(Boolean),
      capabilities: this.commandCapabilities()
    };
  }

  flowNode(
    node: TopologyNode,
    index: number,
    attempts: ExpandedNode[],
    state: RunState | undefined,
    runRoot?: string
  ): JsonObject {
    const logicalId = node.id;
    const status = aggregateLogicalStatus(attempts, state);
    const promptPath = promptPathForNode(node);
    const label = displayNameForNode(this.projectRoot, node);
    const artifactDirs = attempts.map((attempt) => attempt.artifactDir);
    const group = node.group;
    const groups = this.loadTopologyForDisplay().groups ?? {};
    const groupInfo = group ? groups[group] : undefined;
    const findingCount = this.countFindings(attempts, runRoot);
    const requiredArtifacts = uniqueStrings([
      ...(node.required_artifacts ?? []),
      ...attempts.flatMap((attempt) => attempt.requiredArtifacts)
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
        artifacts: this.artifactAvailability(attempts, runRoot),
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
    return this.runOverviewFrom(topology, expanded);
  }

  async runOverviewFrom(topology: ProjectTopology, expanded: ExpandedGraph): Promise<JsonObject> {
    const context = await this.runContext();
    const state = await this.optionalRunState();
    const events = await this.events();
    const findings = await this.findings();
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
    const report = await this.report();
    return {
      schema_version: "1.0",
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
      findings_count: Array.isArray(findings.findings) ? findings.findings.length : 0,
      event_count: Array.isArray(events.events) ? events.events.length : 0,
      live_updates: this.liveUpdates,
      mode: context.persisted ? "persisted" : "preview",
      restart_eligible: Boolean(state?.finished_at),
      report_path: typeof report.markdown_path === "string" ? report.markdown_path : undefined,
      run_metadata: context.persisted ? readJsonIfExists<JsonObject>(path.join(context.runRoot, "run.json")) : {}
    };
  }

  async graphDetail(): Promise<JsonObject> {
    const topology = this.loadTopologyForDisplay();
    const expanded = await this.expandCurrentTopology(topology);
    return {
      topology,
      expandedGraph: expanded,
      logicalNodes: topology.nodes.length,
      expandedNodes: expanded.nodes.length
    };
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
    const state = await this.optionalRunState();
    const attemptArtifacts = await this.artifactEntriesForAttempts(attempts);
    const primary = attemptArtifacts[0];
    return {
      run_id: await this.selectedRunId(),
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
      findings: this.findingsForAttempts(attempts),
      metadata: {
        expandedAttempts: attempts.map((attempt) => ({
          id: attempt.id,
          logicalId: attempt.logicalId,
          dependsOn: attempt.dependsOn,
          artifactDir: attempt.artifactDir,
          loop: attempt.loop,
          modelFanout: attempt.modelFanout
        }))
      },
      transcript: primary?.transcript
    };
  }

  async artifactEntriesForAttempts(attempts: ExpandedNode[]): Promise<
    Array<{
      attemptId: string;
      artifacts: Array<{ path: string; kind: string; size_bytes: number; sha256?: string }>;
      stdout?: string;
      stderr?: string;
      renderedPrompt?: string;
      transcript?: unknown;
    }>
  > {
    const context = await this.runContext();
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
        renderedPrompt: readTextIfExists(path.join(dir, "prompt.rendered.md")),
        transcript: readJsonIfExists(path.join(dir, "transcript.json"))
      };
    });
  }

  async findings(): Promise<JsonObject> {
    const context = await this.runContext();
    if (!context.persisted) {
      return { source: "none", findings: [] };
    }
    const candidates = [
      "artifacts/severity-classification/severity-classified-findings.json",
      "artifacts/triage/triaged-findings.json",
      "artifacts/dedupe-findings/deduped-findings.json",
      "artifacts/final-report/report.json"
    ];
    for (const candidate of candidates) {
      const file = safeResolveInside(context.runRoot, candidate, "findings path");
      if (!fs.existsSync(file)) {
        continue;
      }
      assertRegularFileInside(context.runRoot, file, "findings path");
      return {
        source: candidate,
        findings: extractFindings(readJsonFile(file))
      };
    }
    return {
      source: "scan",
      findings: this.findingsForArtifactsRoot(context.runRoot)
    };
  }

  async report(): Promise<JsonObject> {
    const context = await this.runContext();
    if (!context.persisted) {
      return {
        markdown_path: undefined,
        markdown: undefined,
        json_path: undefined,
        json: undefined
      };
    }
    const candidateDirs = ["artifacts/final-report", ...this.finalReportDirs(context.runRoot)];
    for (const candidateDir of uniqueStrings(candidateDirs)) {
      const markdownPath = safeResolveInside(context.runRoot, `${candidateDir}/report.md`, "report markdown");
      const jsonPath = safeResolveInside(context.runRoot, `${candidateDir}/report.json`, "report JSON");
      if (fs.existsSync(markdownPath) || fs.existsSync(jsonPath)) {
        if (fs.existsSync(markdownPath)) {
          assertRegularFileInside(context.runRoot, markdownPath, "report markdown");
        }
        if (fs.existsSync(jsonPath)) {
          assertRegularFileInside(context.runRoot, jsonPath, "report JSON");
        }
        return {
          markdown_path: fs.existsSync(markdownPath) ? `${candidateDir}/report.md` : undefined,
          markdown: readTextIfExists(markdownPath),
          json_path: fs.existsSync(jsonPath) ? `${candidateDir}/report.json` : undefined,
          json: readJsonIfExists(jsonPath)
        };
      }
    }
    return {
      markdown_path: undefined,
      markdown: undefined,
      json_path: undefined,
      json: undefined
    };
  }

  finalReportDirs(runRoot: string): string[] {
    const artifacts = path.join(runRoot, "artifacts");
    if (!fs.existsSync(artifacts)) {
      return [];
    }
    assertNoSymlinkComponents(runRoot, artifacts, "artifacts root");
    return fs
      .readdirSync(artifacts, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("final-report"))
      .map((entry) => `artifacts/${entry.name}`);
  }

  async events(): Promise<JsonObject> {
    const context = await this.runContext();
    if (!context.persisted) {
      return { source: "none", events: [], malformed_records: 0, truncated_records: 0 };
    }
    const layout = layoutForRunRoot(context.runRoot, context.runId);
    const replay = replayEvents(layout);
    return {
      source: path.relative(context.runRoot, layout.eventsPath).split(path.sep).join("/"),
      events: queryEvents(layout, { limit: 500 }),
      malformed_records: replay.malformedRecords,
      truncated_records: replay.truncatedRecords
    };
  }

  async configDetail(): Promise<JsonObject> {
    const configPath = path.join(this.projectRoot, "ultrafuzz.toml");
    assertPathInside(this.projectRoot, configPath, "config path");
    const content = readTextIfExists(configPath) ?? "";
    const validation = await this.validateConfigText(content);
    return {
      source: fs.existsSync(configPath) ? "project" : "missing",
      path: "ultrafuzz.toml",
      editable: true,
      contentHash: sha256Bytes(content),
      content,
      validation
    };
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
    writeFileDurable(configPath, content);
    appendAudit(this.projectRoot, {
      kind: "config-edit",
      path: "ultrafuzz.toml",
      content_hash: sha256Bytes(content),
      timestamp: new Date().toISOString()
    });
    return {
      path: "ultrafuzz.toml",
      contentHash: sha256Bytes(content),
      validation
    };
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
    return {
      path: ".ultrafuzz/topology.yml",
      editable: true,
      contentHash: sha256Bytes(content),
      content,
      topology: content.trim() ? (parseYaml(content) as ProjectTopology) : emptyTopology(),
      expandedGraph: validation.expandedGraph,
      validation: {
        valid: validation.valid,
        message: validation.message
      }
    };
  }

  async saveTopology(body: JsonObject): Promise<JsonObject> {
    const content =
      typeof body.content === "string"
        ? body.content
        : stringifyYaml(recordField(body, "topology"), { sortMapEntries: false });
    const validation = await this.validateTopologyText(content);
    if (!validation.valid) {
      throw new HttpError(400, validation.message);
    }
    const topologyPath = resolveTopologyPath(this.projectRoot);
    assertPathInside(this.projectRoot, topologyPath, "topology path");
    assertNoSymlinkComponents(this.projectRoot, topologyPath, "topology path");
    writeFileDurable(topologyPath, content.endsWith("\n") ? content : `${content}\n`);
    appendAudit(this.projectRoot, {
      kind: "topology-edit",
      path: ".ultrafuzz/topology.yml",
      content_hash: sha256Bytes(content),
      timestamp: new Date().toISOString()
    });
    return {
      path: ".ultrafuzz/topology.yml",
      contentHash: sha256Bytes(content),
      validation: {
        valid: true,
        message: validation.message
      }
    };
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
    expandedGraph?: ExpandedGraph;
  }> {
    try {
      const requirePromptFiles = options.requirePromptFiles ?? true;
      const parsed = parseYaml(content) as ProjectTopology;
      validateTopology(parsed, {
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
        message: `topology validates: ${parsed.nodes.length} logical nodes, ${expandedGraph.nodes.length} expanded attempts`,
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
    return {
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
    };
  }

  async nodePromptDetail(nodeId: string): Promise<JsonObject> {
    const node = this.topologyNode(nodeId);
    const promptPath = promptPathForNode(node);
    const absolute = this.promptPath(promptPath);
    const content =
      readTextIfExists(absolute) ?? defaultPromptMarkdown(node.id, displayNameForNode(this.projectRoot, node));
    const document = parsePromptFrontmatter(content);
    return {
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
    };
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
      content_hash: sha256Bytes(content),
      timestamp: new Date().toISOString()
    });
    return {
      strategyId: expectedId,
      nodeId: expectedId,
      path: `.ultrafuzz/prompts/${normalized}`,
      contentHash: sha256Bytes(content),
      validation: {
        valid: true,
        message: `prompt ${expectedId} validates`
      }
    };
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
          required_artifacts: ["findings.json"],
          primary_artifact: "findings.json"
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

  async renameTopologyNode(oldId: string, newId: string): Promise<void> {
    const topology = this.loadTopologyForDisplay();
    if (topology.nodes.some((node) => node.id === newId)) {
      throw new HttpError(409, `topology node ${newId} already exists`);
    }
    const nextTopology: ProjectTopology = {
      ...topology,
      nodes: topology.nodes.map((node) => {
        const next = {
          ...node,
          id: node.id === oldId ? newId : node.id,
          depends_on: (node.depends_on ?? []).map((dependency) => (dependency === oldId ? newId : dependency))
        };
        if (node.id === oldId && node.prompt) {
          const extension = path.extname(node.prompt) || ".md";
          next.prompt = path.join(path.dirname(node.prompt), `${newId}${extension}`).split(path.sep).join("/");
        }
        return next;
      })
    };
    const nextContent = stringifyYaml(nextTopology, { sortMapEntries: false });
    const validation = await this.validateTopologyText(nextContent);
    if (!validation.valid) {
      throw new HttpError(400, validation.message);
    }
    writeFileDurable(resolveTopologyPath(this.projectRoot), nextContent);
  }

  async startCommand(command: string, body: JsonObject): Promise<CommandJob> {
    if (!SUPPORTED_COMMANDS.has(command)) {
      throw new HttpError(404, `unsupported dashboard command: ${command}`);
    }
    if ((command === "materialize" || command === "clean") && body.confirmed !== true) {
      throw new HttpError(400, `${command} requires explicit confirmation`);
    }
    const job: CommandJob = {
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

  argvForCommand(command: string, body: JsonObject): string[] {
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
          env: this.env
        });
        break;
      case "replay":
        result = await replayRun({ projectRoot: this.projectRoot, runId: runId!, env: this.env });
        break;
      case "fork":
        result = await forkRun({
          projectRoot: this.projectRoot,
          runId: runId!,
          forkFrame: optionalNumberField(body, "forkFrame"),
          resetNode: optionalStringField(body, "resetNode"),
          label: optionalStringField(body, "label"),
          maxConcurrency: optionalNumberField(body, "maxConcurrency"),
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
    const send = async () => {
      try {
        writeSse(response, "ultrafuzz-event", await this.events());
      } catch (error) {
        writeSse(response, "ultrafuzz-error", errorMessage(error));
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
    const send = () => writeSse(response, "ultrafuzz-command-jobs", this.commandJobs());
    send();
    const interval = setInterval(send, 1000);
    request.on("close", () => clearInterval(interval));
  }

  commandJobs(): CommandJob[] {
    return [...this.jobs.values()].sort((left, right) => right.startedAtUnixSeconds - left.startedAtUnixSeconds);
  }

  async optionalRunState(): Promise<RunState | undefined> {
    const context = await this.runContext();
    if (!context.persisted) {
      return undefined;
    }
    const layout = layoutForRunRoot(context.runRoot, context.runId);
    if (!fs.existsSync(layout.statePath)) {
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
    } catch {
      return emptyTopology();
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

  artifactAvailability(attempts: ExpandedNode[], runRoot?: string): JsonObject {
    const paths = this.artifactPathsForAttempts(attempts, runRoot);
    const exists = (name: string) => paths.some((artifactPath) => artifactPath.endsWith(`/${name}`));
    return {
      logs: exists("stdout.log") || exists("stderr.log"),
      renderedPrompt: exists("prompt.rendered.md"),
      findings: paths.some((artifactPath) => /findings.*\.json$/u.test(artifactPath)),
      patch: paths.some((artifactPath) => /\.(patch|diff)$/u.test(artifactPath)),
      report: exists("report.md") || exists("report.json"),
      metadata: exists("metadata.json"),
      transcript: exists("transcript.json")
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

  countFindings(attempts: ExpandedNode[], runRoot?: string): number {
    return this.findingsForAttempts(attempts, runRoot).length;
  }

  findingsForAttempts(attempts: ExpandedNode[], runRoot?: string): unknown[] {
    if (!runRoot || this.currentRunId === PREVIEW_RUN_ID) {
      return [];
    }
    return attempts.flatMap((attempt) => {
      const dir = path.join(runRoot, attempt.artifactDir);
      if (!fs.existsSync(dir)) {
        return [];
      }
      return [
        "findings.json",
        "deduped-findings.json",
        "triaged-findings.json",
        "severity-classified-findings.json",
        "report.json"
      ].flatMap((file) => {
        const candidate = path.join(dir, file);
        if (!fs.existsSync(candidate)) {
          return [];
        }
        try {
          assertRegularFileInside(runRoot, candidate, "findings path");
          return extractFindings(readJsonFile(candidate));
        } catch {
          return [];
        }
      });
    });
  }

  findingsForArtifactsRoot(runRoot: string): unknown[] {
    const artifacts = path.join(runRoot, "artifacts");
    if (!fs.existsSync(artifacts)) {
      return [];
    }
    return listSafeFiles(artifacts)
      .filter((entry) => entry.relativePath.endsWith("findings.json") || entry.relativePath.endsWith("report.json"))
      .flatMap((entry) => {
        try {
          return extractFindings(readJsonFile(entry.absolutePath));
        } catch {
          return [];
        }
      });
  }
}

export interface CommandJob {
  jobId: string;
  command: string;
  status: Status;
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
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("body must be a JSON object");
    }
    return parsed;
  } catch (error) {
    throw new HttpError(400, `invalid JSON request body: ${errorMessage(error)}`);
  }
}

function sendJson(response: http.ServerResponse, value: unknown, status = 200): void {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

function sendError(response: http.ServerResponse, error: unknown): void {
  const status = error instanceof HttpError ? error.status : 500;
  if (error instanceof HttpError && error.closeConnection) {
    response.shouldKeepAlive = false;
    response.setHeader("connection", "close");
  }
  sendJson(response, { error: errorMessage(error) }, status);
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

function writeSse(response: http.ServerResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function emptyTopology(): ProjectTopology {
  return {
    version: 1,
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

function extractFindings(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (isRecord(value) && Array.isArray(value.findings)) {
    return value.findings;
  }
  return [];
}

function copySelections(body: JsonObject): Array<{ source: string; destination: string }> {
  const copies = body.copies ?? body.copy;
  if (!Array.isArray(copies)) {
    return [];
  }
  return copies.filter(isRecord).map((copy) => ({
    source: stringField(copy, "source"),
    destination: stringField(copy, "destination")
  }));
}

function commandNeedsRunId(command: string): boolean {
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

function appendAudit(projectRoot: string, value: JsonObject): void {
  const auditPath = path.join(projectRoot, ".ultrafuzz", "dashboard-audit.jsonl");
  appendLineDurable(auditPath, JSON.stringify(value), projectRoot);
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

function readJsonIfExists<T = unknown>(filePath: string): T | undefined {
  try {
    return readJsonFile<T>(filePath);
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
