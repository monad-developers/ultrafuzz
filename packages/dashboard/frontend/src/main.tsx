import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState
} from "@xyflow/react";
import type {
  Connection,
  Edge,
  FinalConnectionState,
  IsValidConnection,
  Node,
  NodeProps,
  OnConnectStartParams,
  ReactFlowInstance
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import {
  loopBadgeLabel,
  nodePanelSubtitle,
  phaseGroupDetailLabel,
  propertySummaryFactLabel,
  strategyCategoryLabel,
  type PropertySummaryDisplayData
} from "./display";
import {
  retargetTopologyEdge as retargetTopologyEdgeDependency,
  validateEdgeEndpointEdit,
  type EdgeEndpointEdit,
  type EdgeEndpointValidationNode
} from "./edgeEndpointEditing";
import { assignRankPreservingEdgeHandles } from "./graphHandles";
import { nodeEvidenceCountLabel, visibleNodeEvidenceSections, type NodeEvidenceSectionId } from "./nodeEvidence";
import type { TemplateValidation } from "./templateValidation";
import {
  metaNodeGap,
  metaNodeHeight,
  metaNodeWidth,
  phaseDimensions,
  phaseGroupPositions,
  type PhaseDimensions,
  type PhaseLayoutMember,
  type WorkflowPhaseId
} from "./graphLayout";
import { isInvariantStrategy, phaseForNodeData, showsFindingCount } from "./graphPhases";
import {
  applyResolvedTheme,
  getResolvedThemeFromDocument,
  persistThemePreference,
  readThemePreference,
  resolveThemePreference,
  subscribeToSystemTheme,
  type ResolvedTheme,
  type ThemePreference
} from "./theme";
import { mergeStableGraphEdges, mergeStableGraphNodes } from "./graphMerge";
import { createLiveRefreshGate, shouldPauseLiveRefresh } from "./liveRefreshGate";
import {
  formatHealthSeconds,
  lineageSummaryLabel,
  restartReuseLabel,
  runHealthLabel,
  runHealthTone,
  type RunHealthDisplayInput
} from "./runHealth";
import { useManagedConfigEditor } from "./useManagedConfigEditor";
import { useManagedPromptEditor } from "./useManagedPromptEditor";
import {
  dashboardCommandRequest,
  dashboardRequest,
  dashboardSseEvents,
  dashboardSseCommandJobs,
  dashboardSseErrorMessage,
  parseDashboardHttpDocument
} from "./wireContracts";
import type { DashboardCommandJob, DashboardHttpDocumentType } from "./wireContracts";

type Status =
  | "pending"
  | "ready"
  | "running"
  | "queued"
  | "succeeded"
  | "failed"
  | "skipped"
  | "timed-out"
  | "reused-from-prior-run"
  | "invalidated"
  | "unknown"
  | string;

type StatusTone = "success" | "error" | "info" | "neutral";
type GraphViewMode = "grouped" | "flat";
type LiveState = "loading" | "off" | "connecting" | "live" | "degraded" | "disconnected";
type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";
type PanelToggle = "side-panel" | "activity-console";

type StrategySummary = {
  id: string;
  display_name: string;
  category: string;
  source: string;
  models: string[];
  loops: number;
  attempts: number;
  timeout_seconds?: number;
  expected_cost?: string;
  cost_note?: string;
};

type ModelSummary = {
  id: string;
  backend: string;
  model?: string;
};

type ArtifactAvailability = {
  logs: boolean;
  renderedPrompt: boolean;
  findings: boolean;
  patch: boolean;
  report: boolean;
  metadata: boolean;
  transcript: boolean;
};

type PropertySummary = PropertySummaryDisplayData;

type FlowNodeData = {
  label: string;
  kind: string;
  status: Status;
  strategy?: StrategySummary;
  model?: ModelSummary;
  modelIndex?: number;
  loopIndex?: number;
  dependencies: string[];
  artifactDir: string;
  artifacts: ArtifactAvailability;
  promptAvailable: boolean;
  promptEditable: boolean;
  topologyConnectable: boolean;
  findingCount: number;
  propertySummary: PropertySummary | null;
  latestError?: string;
  incomingHandles?: string[];
  outgoingHandles?: string[];
  logicalNodeId: string;
  attemptIndex: number;
  loopCount: number;
  loopBadgeCount?: number;
  loopMode: "parallel" | "series" | string;
  promptPath: string;
  group?: string;
  groupLabel?: string;
  groupColor?: string;
  requiredArtifacts: string[];
  timeoutSeconds?: number;
  topologyEditable?: boolean;
  connectionSourceNodeId?: string | null;
  connectionTargetValidity?: "valid" | "invalid" | null;
};

type RunOverview = {
  run_id: string;
  status: Status;
  mode: string;
  findings_count: number;
  event_count: number;
  elapsed_seconds?: number;
  restart_eligible: boolean;
  graph_nodes: number;
  active_nodes: string[];
  node_counts: Record<string, number>;
  live_updates: boolean;
  report_path?: string;
  health?: RunHealth;
};

type RunHealth = RunHealthDisplayInput & {
  phase: string;
  start_status?: string;
  finish_status?: string;
  active_nodes: Array<{
    node_id: string;
    label: string;
    status: string;
    artifact_dir: string;
    timeout_remaining_seconds?: number | null;
    stdout_updated_seconds_ago?: number | null;
    stderr_updated_seconds_ago?: number | null;
  }>;
  process_liveness: {
    status: string;
    observed: boolean;
    detail: string;
  };
  stdout_freshness: {
    status: string;
    newest_age_seconds?: number | null;
    newest_path?: string;
  };
  stderr_freshness: {
    status: string;
    newest_age_seconds?: number | null;
    newest_path?: string;
  };
  timeout: {
    status: string;
    minimum_remaining_seconds?: number | null;
  };
  artifacts: {
    status: string;
    total_required: number;
    present_required: number;
    missing_required: number;
  };
};

type FlowData = {
  run: RunOverview;
  nodes: Array<Node<FlowNodeData>>;
  edges: DashboardEdge[];
  strategies: StrategySummary[];
  capabilities: CommandCapabilities;
};

type CommandCapabilities = {
  validate: boolean;
  listRuns: boolean;
  ps: boolean;
  runNewCampaign: boolean;
  inspect: boolean;
  resume: boolean;
  replay: boolean;
  fork: boolean;
  referencesStatus: boolean;
  referencesSync: boolean;
  referencesUpdate: boolean;
  restartWholeRun: boolean;
  status: boolean;
  doctor: boolean;
  config: boolean;
  report: boolean;
  triage: boolean;
  merge: boolean;
  materialize: boolean;
  clean: boolean;
  restartFromNode: boolean;
  rerunSelectedNode: boolean;
  arbitraryShell: boolean;
};

type DashboardFlowNode = Node<FlowNodeData>;
type PhaseGroupData = {
  label: string;
  memberCount: number;
  phase: WorkflowPhaseId;
  propertyCount?: number;
};
type DashboardPhaseNode = Node<PhaseGroupData>;
type DashboardGraphNode = DashboardFlowNode | DashboardPhaseNode;
type DashboardEdgeData = {
  status: Status;
};
type DashboardEdge = Edge<DashboardEdgeData>;
type EdgeEndpoint = {
  flowNodeId: string;
  label: string;
  logicalNodeId: string;
  promptEditable: boolean;
};
type SelectedEdgeSummary = {
  edge: DashboardEdge;
  source: EdgeEndpoint;
  target: EdgeEndpoint;
};
type TopologyEdgeEndpoints = {
  source: string;
  target: string;
};

type DashboardSession = {
  runId: string;
  liveUpdates: boolean;
  sessionToken: string;
  templateVariables: string[];
};

type NodeSummary = {
  id: string;
  label: string;
  kind: string;
  kind_detail: "agentic" | "meta" | "reference";
  status: Status;
  depends_on: string[];
  artifact_dir: string;
  strategy?: StrategySummary;
  model?: ModelSummary;
  attempt_index: number;
  model_index?: number;
  loop_index: number;
  timeout_seconds?: number;
};

type NodeDetail = {
  run_id: string;
  node: NodeSummary;
  state?: unknown;
  stdout?: string;
  stderr?: string;
  rendered_prompt?: string;
  findings: unknown[];
  artifacts: Array<{ path: string; kind: string; size_bytes: number; sha256: string }>;
  artifactReferences: PromptArtifactReferences;
  metadata: { expandedAttempts: unknown[] };
  transcript?: unknown;
};

type PromptArtifactReferences = {
  outputs: PromptArtifactPreview[];
  referencedPrevious: PromptArtifactPreview[];
};

type PromptArtifactPreview = {
  logicalNodeId: string;
  concreteNodeId: string;
  relativePath?: string;
  path: string;
  state: "available" | "missing" | "directory" | "unsupported";
  content?: { kind: "markdown" | "text"; text: string } | { kind: "json"; json: unknown };
};

type PromptDetail = {
  summary: {
    strategyId?: string;
    nodeId?: string;
    promptId: string;
    displayName: string;
    category?: string;
    source: string;
    path: string;
    editable: boolean;
    contentHash: string;
  };
  content: string;
  endpoint: string;
};

type SavePromptResponse = {
  strategyId: string;
  nodeId: string;
  path: string;
  contentHash: string;
  validation: {
    valid: boolean;
    message: string;
  };
};

type ConfigDetail = {
  source: string;
  path: string;
  editable: boolean;
  contentHash: string;
  content: string;
};

type SaveConfigResponse = {
  path: string;
  contentHash: string;
  validation: {
    valid: boolean;
    message: string;
  };
};

type TopologyGroup = {
  label?: string;
  color?: string;
};

type TopologyDefaults = {
  strategy_loops: number;
};

type TopologyNode = {
  id: string;
  kind?: "agentic" | "meta" | "reference";
  role?: "start" | "finish";
  prompt?: string;
  reference?: string;
  group?: string;
  depends_on?: string[];
  loops?: number;
  loop_mode?: "parallel" | "series";
  timeout_seconds?: number;
  outputs?: Array<{ path: string; contract: string; primary?: boolean }>;
};

type ProjectTopology = {
  version: 2;
  defaults: TopologyDefaults;
  groups?: Record<string, TopologyGroup>;
  nodes: TopologyNode[];
};

type TopologyDetail = {
  path: string;
  editable: boolean;
  contentHash: string;
  content: string;
  topology?: ProjectTopology;
  validation: {
    valid: boolean;
    message: string;
  };
};

type SaveTopologyResponse = {
  path: string;
  contentHash: string;
  validation: {
    valid: boolean;
    message: string;
  };
};

type NewPromptDraft = {
  content: string;
  group: string;
  dependsOn: string[];
};

type TopologyGroupOption = {
  id: string;
  label: string;
};

type TopologyNodeOption = {
  id: string;
  label: string;
};

type CommandJob = DashboardCommandJob;

type EventRecord = {
  timestamp: string;
  event_type: string;
  node_id?: string;
  payload: unknown;
};

const statusLabels: Record<string, string> = {
  pending: "Pending",
  ready: "Ready",
  running: "Running",
  queued: "Queued",
  succeeded: "Succeeded",
  failed: "Failed",
  skipped: "Skipped",
  "timed-out": "Timed out",
  "reused-from-prior-run": "Reused",
  invalidated: "Invalidated",
  unknown: "Unknown"
};

const nodeTypes = {
  phaseGroup: PhaseGroupNode,
  metaStart: MetaNode,
  metaFinish: MetaNode,
  projectDiscovery: DashboardNode,
  foundryHarness: DashboardNode,
  baseTestDiscovery: DashboardNode,
  propertySpecificationLens: DashboardNode,
  propertySpecificationFanIn: DashboardNode,
  propertySpecification: DashboardNode,
  reference: DashboardNode,
  strategyAggregate: DashboardNode,
  agentAttempt: DashboardNode,
  strategyConsolidation: DashboardNode,
  dedupe: DashboardNode,
  triage: DashboardNode,
  testAggregation: DashboardNode,
  report: DashboardNode
};

const workflowPhases: Array<{ id: WorkflowPhaseId; label: string }> = [
  { id: "setup", label: "Setup" },
  { id: "references", label: "References" },
  { id: "properties", label: "Properties" },
  { id: "strategies", label: "Strategies" },
  { id: "invariants", label: "Invariants" },
  { id: "differential-tests", label: "Differential" },
  { id: "deduplication", label: "Deduplication" },
  { id: "triaging", label: "Classification" },
  { id: "report", label: "Report" }
];

const ungroupedPhase = { id: "ungrouped" as const, label: "Other" };
const groupedInitialViewport = { x: 42, y: 154, zoom: 0.48 };
const phaseGroupZIndex = 0;
const dependencyEdgeZIndex = 1;
const executableNodeZIndex = 3;

function DashboardNode({ data, id, selected }: NodeProps<DashboardFlowNode>) {
  const nodePhase = phaseForNodeData(data);
  const statusClass = cssSlug(data.status);
  const statusToneValue = statusTone(data.status);
  const flags = nodeAvailabilityFlags(data);
  const incomingHandles = data.incomingHandles ?? [];
  const outgoingHandles = data.outgoingHandles ?? [];
  const loopBadge = loopBadgeLabel(data);
  const timeoutFact = timeoutFactLabel(data.timeoutSeconds);
  const showFindings = showsFindingCount(nodePhase);
  const showStrategyName = Boolean(data.strategy && data.strategy.display_name !== data.label);
  const topologyId = data.logicalNodeId;
  const propertyFact = propertySummaryFactLabel(data.propertySummary);
  const statusLabel = statusLabels[data.status] ?? data.status;
  const canCreateTopologyConnection = canEditTopologyWiringData(data);
  const connectionActive = Boolean(data.connectionSourceNodeId);
  const connectionSourceActive = data.connectionSourceNodeId === id;
  const validConnectionTarget = connectionActive && data.connectionTargetValidity === "valid";
  const invalidConnectionTarget = connectionActive && data.connectionTargetValidity === "invalid";
  const connectionClasses = [
    connectionSourceActive ? "is-connection-source" : "",
    validConnectionTarget ? "is-connection-target" : "",
    invalidConnectionTarget ? "is-connection-invalid-target" : ""
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      aria-label={`${data.label}, Topology ID ${topologyId}, ${statusLabel}`}
      className={`flow-node node-category-${nodePhase} node-tone-${statusToneValue} node-state-${statusClass} ${selected ? "is-selected" : ""} ${connectionClasses}`}
    >
      {incomingHandles.map((handleId, index) => (
        <Handle
          className="flow-handle flow-handle-target"
          id={handleId}
          isConnectable={canCreateTopologyConnection}
          key={handleId}
          position={Position.Left}
          style={{ top: handleOffset(index, incomingHandles.length) }}
          type="target"
        />
      ))}
      {outgoingHandles.map((handleId, index) => (
        <Handle
          className="flow-handle flow-handle-source"
          id={handleId}
          isConnectable={canCreateTopologyConnection}
          key={handleId}
          position={Position.Right}
          style={{ top: handleOffset(index, outgoingHandles.length) }}
          type="source"
        />
      ))}
      {canCreateTopologyConnection ? (
        <>
          <Handle
            aria-label={`Create dependency from ${data.label}`}
            className="flow-handle flow-connect-handle flow-connect-handle-source"
            id="create-dependency-source"
            isConnectable={canCreateTopologyConnection}
            isConnectableEnd={false}
            isConnectableStart={canCreateTopologyConnection}
            position={Position.Right}
            title={`Drag to connect ${data.label} to another node`}
            type="source"
          />
          <Handle
            aria-label={`Connect dependency to ${data.label}`}
            className="flow-handle flow-connect-handle flow-connect-handle-target"
            id="create-dependency-target"
            isConnectable={canCreateTopologyConnection}
            isConnectableEnd={canCreateTopologyConnection}
            isConnectableStart={false}
            position={Position.Left}
            title={`Drop a dependency edge on ${data.label}`}
            type="target"
          />
        </>
      ) : null}
      <div className="flow-node__body">
        <div className="node-header">
          <div className="node-title">{data.label}</div>
          <StatusBadge status={data.status} dense />
        </div>
        <div aria-label={`Topology ID ${topologyId}`} className="node-topology-id" title={`Topology ID: ${topologyId}`}>
          {topologyId}
        </div>
        {data.strategy ? (
          <div className="node-strategy">
            {showStrategyName ? <span>{data.strategy.display_name}</span> : null}
            <span>{strategyCategoryLabel(data.strategy.category)}</span>
          </div>
        ) : null}
        <div className="node-facts">
          {loopBadge ? <span className="loop-badge">{loopBadge}</span> : null}
          {timeoutFact ? <span>{timeoutFact}</span> : null}
          {showFindings ? <span>{formatNumber(data.findingCount)} findings</span> : null}
          {propertyFact ? <span>{propertyFact}</span> : null}
          {data.model ? <span>{data.model.id}</span> : null}
          {flags.map((flag) => (
            <span key={flag}>{flag}</span>
          ))}
        </div>
        {data.latestError ? <div className="node-error">{data.latestError}</div> : null}
      </div>
    </div>
  );
}

function MetaNode({ data, id, selected }: NodeProps<DashboardFlowNode>) {
  const statusClass = cssSlug(data.status);
  const statusToneValue = statusTone(data.status);
  const incomingHandles = data.incomingHandles ?? [];
  const outgoingHandles = data.outgoingHandles ?? [];
  const canWire = canEditTopologyWiringData(data);
  const canStartConnection = canWire && data.kind !== "finish";
  const canReceiveConnection = canWire && data.kind !== "start";
  const connectionActive = Boolean(data.connectionSourceNodeId);
  const connectionSourceActive = data.connectionSourceNodeId === id;
  const validConnectionTarget = connectionActive && data.connectionTargetValidity === "valid";
  const invalidConnectionTarget = connectionActive && data.connectionTargetValidity === "invalid";
  const connectionClasses = [
    connectionSourceActive ? "is-connection-source" : "",
    validConnectionTarget ? "is-connection-target" : "",
    invalidConnectionTarget ? "is-connection-invalid-target" : ""
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      aria-label={`${data.label} meta node, ${statusLabels[data.status] ?? data.status}`}
      className={`meta-node meta-node--${data.kind} node-tone-${statusToneValue} node-state-${statusClass} ${selected ? "is-selected" : ""} ${connectionClasses}`}
    >
      {incomingHandles.map((handleId, index) => (
        <Handle
          className="flow-handle flow-handle-target"
          id={handleId}
          isConnectable={canReceiveConnection}
          key={handleId}
          position={Position.Left}
          style={{ top: handleOffset(index, incomingHandles.length) }}
          type="target"
        />
      ))}
      {outgoingHandles.map((handleId, index) => (
        <Handle
          className="flow-handle flow-handle-source"
          id={handleId}
          isConnectable={canStartConnection}
          key={handleId}
          position={Position.Right}
          style={{ top: handleOffset(index, outgoingHandles.length) }}
          type="source"
        />
      ))}
      {canStartConnection ? (
        <Handle
          aria-label={`Create dependency from ${data.label}`}
          className="flow-handle flow-connect-handle flow-connect-handle-source"
          id="create-dependency-source"
          isConnectable={canStartConnection}
          isConnectableEnd={false}
          isConnectableStart={canStartConnection}
          position={Position.Right}
          title={`Drag to connect ${data.label} to another node`}
          type="source"
        />
      ) : null}
      {canReceiveConnection ? (
        <Handle
          aria-label={`Connect dependency to ${data.label}`}
          className="flow-handle flow-connect-handle flow-connect-handle-target"
          id="create-dependency-target"
          isConnectable={canReceiveConnection}
          isConnectableEnd={canReceiveConnection}
          isConnectableStart={false}
          position={Position.Left}
          title={`Drop a dependency edge on ${data.label}`}
          type="target"
        />
      ) : null}
      <span className="meta-node__label">{data.label}</span>
      <StatusBadge status={data.status} dense />
    </div>
  );
}

function PhaseGroupNode({ data }: NodeProps<DashboardPhaseNode>) {
  return (
    <div aria-label={`${data.label} phase`} className={`phase-group phase-group--${data.phase}`}>
      <div className="phase-group__header">
        <span>{data.label}</span>
        <small>{phaseGroupDetailLabel(data.memberCount, data.propertyCount)}</small>
      </div>
    </div>
  );
}

function App() {
  const [session, setSession] = useState<DashboardSession | null>(null);
  const [flow, setFlow] = useState<FlowData | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<DashboardGraphNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<DashboardEdge>([]);
  const [graphViewMode, setGraphViewMode] = useState<GraphViewMode>("grouped");
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<DashboardGraphNode, DashboardEdge> | null>(null);
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  const [activityConsoleOpen, setActivityConsoleOpen] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [connectSourceNodeId, setConnectSourceNodeId] = useState<string | null>(null);
  const [nodeDetail, setNodeDetail] = useState<NodeDetail | null>(null);
  const [config, setConfig] = useState<ConfigDetail | null>(null);
  const [newPromptDraft, setNewPromptDraft] = useState<NewPromptDraft | null>(null);
  const [topology, setTopology] = useState<TopologyDetail | null>(null);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [jobs, setJobs] = useState<CommandJob[]>([]);
  const [message, setMessage] = useState("");
  const [sessionError, setSessionError] = useState("");
  const [flowError, setFlowError] = useState("");
  const [eventsError, setEventsError] = useState("");
  const [nodeError, setNodeError] = useState("");
  const [configError, setConfigError] = useState("");
  const [newPromptError, setNewPromptError] = useState("");
  const [topologyError, setTopologyError] = useState("");
  const [liveError, setLiveError] = useState("");
  const [commandStreamError, setCommandStreamError] = useState("");
  const [liveState, setLiveState] = useState<LiveState>("loading");
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>(() => readThemePreference());
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => getResolvedThemeFromDocument());
  const fittedGraphRef = useRef<{ initial: boolean; mode: GraphViewMode | null }>({ initial: false, mode: null });
  const liveRefreshGateRef = useRef(createLiveRefreshGate());
  const pendingLiveRefreshRef = useRef(false);
  const templateVariables = session?.templateVariables;

  const setThemePreference = useCallback((preference: ThemePreference) => {
    persistThemePreference(preference);
    setThemePreferenceState(preference);
    const resolved = resolveThemePreference(preference);
    setResolvedTheme(resolved);
    applyResolvedTheme(resolved);
  }, []);

  useEffect(() => {
    const preference = readThemePreference();
    const resolved = resolveThemePreference(preference);
    setThemePreferenceState(preference);
    setResolvedTheme(resolved);
    applyResolvedTheme(resolved);
  }, []);

  useEffect(() => {
    if (themePreference !== "system") {
      return undefined;
    }
    return subscribeToSystemTheme((theme) => {
      setResolvedTheme(theme);
      applyResolvedTheme(theme);
    });
  }, [themePreference]);
  const loadFlow = useCallback(async () => {
    try {
      const data = await getJson<FlowData>("/api/flow", "flow");
      setFlow(data);
      setFlowError("");
      return data;
    } catch (error) {
      const message = errorMessage(error);
      setFlowError(`Run graph failed to load: ${message}`);
      throw error;
    }
  }, []);

  const loadTopology = useCallback(async () => {
    try {
      const detail = await getJson<TopologyDetail>("/api/topology", "topology-detail");
      setTopology(detail);
      setTopologyError(detail.validation.valid ? "" : detail.validation.message);
      return detail;
    } catch (error) {
      const message = `Topology failed to load: ${errorMessage(error)}`;
      setTopologyError(message);
      throw error;
    }
  }, []);

  const saveTopology = useCallback(
    async (nextTopology: ProjectTopology) => {
      if (!session) {
        throw new Error("Dashboard session is not ready.");
      }
      const response = await fetch("/api/topology", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-ultrafuzz-session": session.sessionToken
        },
        body: JSON.stringify(dashboardRequest("topology-save", { topology: nextTopology }))
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      const saved = parseDashboardHttpDocument<SaveTopologyResponse>(await response.json(), "topology-save");
      setMessage(`Saved ${saved.path}: ${saved.validation.message}`);
      await loadTopology();
      return await loadFlow();
    },
    [loadFlow, loadTopology, session]
  );

  const mutateTopology = useCallback(
    async (mutator: (topology: ProjectTopology) => void) => {
      const detail = topology ?? (await loadTopology());
      if (!detail.topology) {
        throw new Error(detail.validation.message);
      }
      const nextTopology = cloneTopology(detail.topology);
      mutator(nextTopology);
      return await saveTopology(nextTopology);
    },
    [loadTopology, saveTopology, topology]
  );

  const topologyNodeIds = useMemo(() => topologyNodeIdSet(topology), [topology]);
  const edgeEndpointOptions = useMemo(() => edgeEndpointOptionsForNodes(flow?.nodes ?? [], topology), [flow, topology]);
  const edgeEndpointValidationNodes = useMemo(
    () => edgeEndpointValidationNodesForTopology(topology, flow?.nodes ?? []),
    [flow, topology]
  );
  useEffect(() => {
    if (!flow) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const graph = dependencyGraphLayout(flow.nodes, flow.edges, graphViewMode);
    const annotated = annotateTopologyConnectionState(
      graph.nodes,
      Boolean(topology?.editable),
      connectSourceNodeId,
      selectedNodeId,
      edgeEndpointValidationNodes,
      topologyNodeIds
    );
    setNodes((current) => mergeStableGraphNodes(current, annotated));
    setEdges((current) => mergeStableGraphEdges(current, graph.edges));
  }, [
    connectSourceNodeId,
    edgeEndpointValidationNodes,
    flow,
    graphViewMode,
    selectedNodeId,
    setEdges,
    setNodes,
    topology?.editable,
    topologyNodeIds
  ]);

  useEffect(() => {
    if (!flowInstance || nodes.length === 0) {
      return;
    }
    const shouldFit = !fittedGraphRef.current.initial || fittedGraphRef.current.mode !== graphViewMode;
    if (!shouldFit) {
      return;
    }
    fittedGraphRef.current = { initial: true, mode: graphViewMode };
    window.requestAnimationFrame(() => {
      if (graphViewMode === "grouped") {
        flowInstance.setViewport(groupedInitialViewport, { duration: 0 }).catch(() => undefined);
        return;
      }
      flowInstance
        .fitView({
          duration: 0,
          maxZoom: 0.5,
          padding: 0.14
        })
        .catch(() => undefined);
    });
  }, [flowInstance, graphViewMode, nodes.length]);

  const openConfig = useCallback(async () => {
    try {
      const detail = await getJson<ConfigDetail>("/api/config", "config-detail");
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      setConnectSourceNodeId(null);
      setNodeDetail(null);
      setNewPromptDraft(null);
      setNewPromptError("");
      setNodeError("");
      setConfig(detail);
      setConfigError("");
      setSidePanelOpen(true);
    } catch (error) {
      const message = errorMessage(error);
      setConfigError(`Config failed to load: ${message}`);
      setMessage(`Config failed to load: ${message}`);
      throw error;
    }
  }, []);

  const loadEvents = useCallback(async () => {
    try {
      const data = await getJson<{ events: EventRecord[] }>("/api/events", "events");
      setEvents(data.events.slice(-80).reverse());
      setEventsError("");
    } catch (error) {
      const message = errorMessage(error);
      setEventsError(`Activity events failed to load: ${message}`);
      throw error;
    }
  }, []);

  const flushDeferredLiveRefresh = useCallback(() => {
    if (!pendingLiveRefreshRef.current || shouldPauseLiveRefresh(liveRefreshGateRef.current)) {
      return;
    }
    pendingLiveRefreshRef.current = false;
    loadFlow().catch(() => undefined);
    loadEvents().catch(() => undefined);
  }, [loadEvents, loadFlow]);

  const reportPendingPromptEdit = useCallback(
    (pending: boolean) => {
      liveRefreshGateRef.current.pendingPromptEdit = pending;
      if (!pending && !shouldPauseLiveRefresh(liveRefreshGateRef.current)) {
        flushDeferredLiveRefresh();
      }
    },
    [flushDeferredLiveRefresh]
  );

  const reportPendingConfigEdit = useCallback(
    (pending: boolean) => {
      liveRefreshGateRef.current.pendingConfigEdit = pending;
      if (!pending && !shouldPauseLiveRefresh(liveRefreshGateRef.current)) {
        flushDeferredLiveRefresh();
      }
    },
    [flushDeferredLiveRefresh]
  );

  useEffect(() => {
    liveRefreshGateRef.current.sidePanelOpen = sidePanelOpen;
  }, [sidePanelOpen]);

  useEffect(() => {
    getJson<DashboardSession>("/api/session", "session")
      .then((sessionData) => {
        setSession(sessionData);
        setSessionError("");
      })
      .catch((error) => setSessionError(`Dashboard session failed to load: ${errorMessage(error)}`));
    loadFlow().catch(() => undefined);
    loadTopology().catch(() => undefined);
    loadEvents().catch(() => undefined);
  }, [loadEvents, loadFlow, loadTopology]);

  useEffect(() => {
    if (!session) {
      setLiveState("loading");
      return;
    }
    if (!session.liveUpdates) {
      setLiveState("off");
      return;
    }

    setLiveState("connecting");
    const stream = new EventSource("/api/events/stream");
    let refreshTimer: number | undefined;
    let refreshInFlight = false;
    let refreshQueued = false;
    let closed = false;

    const flushRefresh = () => {
      refreshTimer = undefined;
      if (refreshInFlight) {
        refreshQueued = true;
        return;
      }
      refreshInFlight = true;
      Promise.all([loadFlow(), loadEvents()])
        .catch((error) => {
          const message = errorMessage(error);
          setLiveState("degraded");
          setLiveError(`Live refresh failed: ${message}`);
        })
        .finally(() => {
          refreshInFlight = false;
          if (refreshQueued && !closed) {
            refreshQueued = false;
            scheduleRefresh();
          }
        });
    };

    const scheduleRefresh = () => {
      if (closed) {
        return;
      }
      if (shouldPauseLiveRefresh(liveRefreshGateRef.current)) {
        pendingLiveRefreshRef.current = true;
        return;
      }
      refreshQueued = true;
      if (refreshTimer !== undefined) {
        return;
      }
      refreshTimer = window.setTimeout(() => {
        refreshQueued = false;
        flushRefresh();
      }, 300);
    };

    stream.onopen = () => {
      setLiveState("live");
      setLiveError("");
    };
    stream.onerror = () => {
      if (!closed) {
        setLiveState("disconnected");
        setLiveError("Live event stream disconnected. The browser will retry automatically.");
      }
    };
    stream.addEventListener("ultrafuzz-event", (event) => {
      try {
        dashboardSseEvents(event.data);
        setLiveState("live");
        setLiveError("");
        scheduleRefresh();
      } catch (error) {
        setLiveState("degraded");
        setLiveError(`Live event update failed to parse: ${errorMessage(error)}`);
      }
    });
    stream.addEventListener("ultrafuzz-error", (event) => {
      setLiveState("degraded");
      try {
        const message = dashboardSseErrorMessage(event.data);
        setLiveError(message);
        setMessage(message);
      } catch (error) {
        setLiveError(`Live event error failed to parse: ${errorMessage(error)}`);
      }
    });
    return () => {
      closed = true;
      stream.close();
      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer);
      }
    };
  }, [loadEvents, loadFlow, session]);

  useEffect(() => {
    const stream = new EventSource("/api/commands/stream");
    stream.onopen = () => setCommandStreamError("");
    stream.onerror = () => {
      setCommandStreamError("Command job stream disconnected. The browser will retry automatically.");
    };
    stream.addEventListener("ultrafuzz-command-jobs", (event) => {
      try {
        setJobs(dashboardSseCommandJobs(event.data));
        setCommandStreamError("");
      } catch (error) {
        setCommandStreamError(`Command job update failed to parse: ${errorMessage(error)}`);
      }
    });
    return () => stream.close();
  }, []);

  const selectedFlowNode = useMemo<DashboardFlowNode | undefined>(() => {
    const selected = nodes.find((node) => node.id === selectedNodeId);
    return isExecutableFlowNode(selected) ? selected : undefined;
  }, [nodes, selectedNodeId]);
  const selectedEdge = useMemo(() => edges.find((edge) => edge.id === selectedEdgeId) ?? null, [edges, selectedEdgeId]);
  const selectedEdgeSummary = useMemo<SelectedEdgeSummary | null>(() => {
    if (!selectedEdge) {
      return null;
    }
    const source = edgeEndpointForFlowNode(nodes, selectedEdge.source, topologyNodeIds);
    const target = edgeEndpointForFlowNode(nodes, selectedEdge.target, topologyNodeIds);
    if (!source || !target) {
      return null;
    }
    return {
      edge: selectedEdge,
      source,
      target
    };
  }, [nodes, selectedEdge, topologyNodeIds]);
  const selectedFlowNodeExists = Boolean(selectedFlowNode);
  const selectedIsStrategyAggregate = Boolean(selectedFlowNode && isStrategyAggregateNode(selectedFlowNode));

  useEffect(() => {
    if (selectedEdgeId && !selectedEdge) {
      setSelectedEdgeId(null);
    }
  }, [selectedEdge, selectedEdgeId]);

  useEffect(() => {
    if (!selectedNodeId || !selectedFlowNodeExists) {
      setNodeDetail(null);
      setNodeError("");
      return;
    }

    let cancelled = false;
    setConfig(null);
    setConfigError("");
    setNodeDetail(null);
    setNodeError("");

    if (selectedIsStrategyAggregate) {
      return () => {
        cancelled = true;
      };
    }

    getJson<NodeDetail>(`/api/nodes/${encodeURIComponent(selectedNodeId)}`, "node-detail")
      .then((detail) => {
        if (cancelled) {
          return;
        }
        setNodeDetail(detail);
      })
      .catch((error) => {
        if (!cancelled) {
          setNodeError(`Node detail failed to load: ${errorMessage(error)}`);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedFlowNodeExists, selectedIsStrategyAggregate, selectedNodeId]);

  const runCommand = useCallback(
    (command: string, body: Record<string, unknown> = {}) => {
      if (!session) {
        setMessage("Dashboard session is not ready.");
        return;
      }

      const run = async () => {
        const capability = capabilityForCommand(command);
        if (capability && flow && !flow.capabilities[capability]) {
          setMessage(`${command} is unavailable for this dashboard view.`);
          return;
        }

        const commandBody = { ...body };
        if ((command === "clean" || command === "materialize") && commandBody.confirmed !== true) {
          if (commandBody.dryRun === true) {
            commandBody.confirmed = true;
          } else {
            setMessage(`${command} requires explicit confirmation before it can start.`);
            return;
          }
        }

        const job = await postCommandJson<CommandJob>(
          `/api/commands/${command}`,
          command,
          commandBody,
          session.sessionToken
        );
        setJobs((current) => [job, ...current.filter((item) => item.jobId !== job.jobId)]);
        setActivityConsoleOpen(true);
        setMessage(`Started ${command}`);
      };

      run().catch((error) => setMessage(`Command failed to start: ${errorMessage(error)}`));
    },
    [flow, session]
  );

  const saveConfig = useCallback(
    async (content: string) => {
      if (!session || !config) {
        return;
      }
      setMessage("");
      try {
        const response = await fetch("/api/config", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "x-ultrafuzz-session": session.sessionToken
          },
          body: JSON.stringify(dashboardRequest("config-save", { content }))
        });
        if (!response.ok) {
          throw new Error(await response.text());
        }
        const saved = parseDashboardHttpDocument<SaveConfigResponse>(await response.json(), "config-save");
        setMessage(`Saved ${saved.path}: ${saved.validation.message}`);
        const refreshed = await getJson<ConfigDetail>("/api/config", "config-detail");
        setConfig(refreshed);
        setConfigError("");
        await loadFlow();
      } catch (error) {
        const message = errorMessage(error);
        setConfigError(`Config save failed: ${message}`);
        setMessage(`Config save failed: ${message}`);
        throw error;
      }
    },
    [config, loadFlow, session]
  );

  const connectTopologyNodesByFlowId = useCallback(
    async (sourceNodeId: string, targetNodeId: string) => {
      const sourceEndpoint = edgeEndpointForFlowNode(nodes, sourceNodeId, topologyNodeIds);
      const targetEndpoint = edgeEndpointForFlowNode(nodes, targetNodeId, topologyNodeIds);
      const source = sourceEndpoint?.logicalNodeId;
      const target = targetEndpoint?.logicalNodeId;
      if (!source || !target || source === target) {
        return;
      }
      const validation = validateEdgeEndpointEdit({
        edit: {
          oldSource: "",
          oldTarget: "",
          source,
          target
        },
        nodes: edgeEndpointValidationNodes,
        topologyEditable: Boolean(topology?.editable)
      });
      if (!validation.valid) {
        throw new Error(validation.message);
      }
      await mutateTopology((nextTopology) => {
        const targetNode = nextTopology.nodes.find((node) => node.id === target);
        if (!targetNode) {
          return;
        }
        const dependencies = new Set(targetNode.depends_on ?? []);
        dependencies.add(source);
        targetNode.depends_on = [...dependencies];
      });
      setMessage("Saved dependency edge");
    },
    [edgeEndpointValidationNodes, mutateTopology, nodes, topology?.editable, topologyNodeIds]
  );

  const connectTopologyNodes = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) {
        return;
      }
      connectTopologyNodesByFlowId(connection.source, connection.target).catch((error) => {
        const message = `Topology edge save failed: ${errorMessage(error)}`;
        setTopologyError(message);
        setMessage(message);
      });
    },
    [connectTopologyNodesByFlowId]
  );

  const isValidTopologyConnection = useCallback<IsValidConnection<DashboardEdge>>(
    (connection) => isValidTopologyConnectionCandidate(nodes, connection, edgeEndpointValidationNodes, topologyNodeIds),
    [edgeEndpointValidationNodes, nodes, topologyNodeIds]
  );

  const retargetSelectedTopologyEdge = useCallback(
    async (edgeSummary: SelectedEdgeSummary, edit: { sourceLogicalNodeId: string; targetLogicalNodeId: string }) => {
      const edgeEdit: EdgeEndpointEdit = {
        oldSource: edgeSummary.source.logicalNodeId,
        oldTarget: edgeSummary.target.logicalNodeId,
        source: edit.sourceLogicalNodeId,
        target: edit.targetLogicalNodeId
      };
      const validation = validateEdgeEndpointEdit({
        edit: edgeEdit,
        nodes: edgeEndpointValidationNodes,
        topologyEditable: Boolean(topology?.editable)
      });
      if (!validation.valid) {
        const message = `Topology edge save failed: ${validation.message}`;
        setTopologyError(message);
        setMessage(message);
        throw new Error(message);
      }

      try {
        const refreshedFlow = await mutateTopology((nextTopology) =>
          retargetTopologyEdgeDependency(nextTopology, edgeEdit)
        );
        const refreshedGraph = refreshedFlow
          ? dependencyGraphLayout(refreshedFlow.nodes, refreshedFlow.edges, graphViewMode)
          : null;
        const retargetedEdgeId = refreshedGraph
          ? edgeIdForLogicalDependency(
              refreshedGraph.nodes,
              refreshedGraph.edges,
              edit.sourceLogicalNodeId,
              edit.targetLogicalNodeId
            )
          : null;
        setSelectedNodeId(null);
        setConnectSourceNodeId(null);
        if (refreshedGraph) {
          setNodes(
            annotateTopologyConnectionState(
              refreshedGraph.nodes,
              Boolean(topology?.editable),
              null,
              null,
              edgeEndpointValidationNodes,
              topologyNodeIds
            )
          );
          setEdges(refreshedGraph.edges);
        }
        setSelectedEdgeId(retargetedEdgeId);
        setSidePanelOpen(true);
        setTopologyError("");
        setMessage("Saved dependency edge");
      } catch (error) {
        const message = `Topology edge save failed: ${errorMessage(error)}`;
        setTopologyError(message);
        setMessage(message);
        throw new Error(message, { cause: error });
      }
    },
    [
      edgeEndpointValidationNodes,
      graphViewMode,
      mutateTopology,
      setEdges,
      setNodes,
      topology?.editable,
      topologyNodeIds
    ]
  );

  const startDraggedTopologyEdge = useCallback(
    (_event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
      if (params.handleType !== "source" || !params.nodeId) {
        return;
      }
      const source = edgeEndpointForFlowNode(nodes, params.nodeId, topologyNodeIds);
      if (!source) {
        return;
      }
      setSelectedEdgeId(null);
      setSelectedNodeId(params.nodeId);
      setConnectSourceNodeId(params.nodeId);
      setMessage("Drag to a highlighted node to connect.");
    },
    [nodes, topologyNodeIds]
  );

  const endDraggedTopologyEdge = useCallback(
    (_event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      if (!connectionState.fromNode) {
        return;
      }
      setConnectSourceNodeId(null);
      if (!connectionState.toNode) {
        setMessage("Connection canceled.");
      }
    },
    []
  );

  const deleteTopologyEdgeDependencies = useCallback(
    (removed: TopologyEdgeEndpoints[]) => {
      if (!removed.length) {
        return Promise.resolve();
      }
      return mutateTopology((nextTopology) => {
        removed.forEach((edge) => {
          const targetNode = nextTopology.nodes.find((node) => node.id === edge.target);
          if (!targetNode) {
            return;
          }
          targetNode.depends_on = (targetNode.depends_on ?? []).filter((dependency) => dependency !== edge.source);
        });
      })
        .then(() => {
          setSelectedEdgeId(null);
          setSidePanelOpen(false);
          setMessage(`Deleted ${removed.length === 1 ? "edge" : "edges"}`);
        })
        .catch((error) => {
          const message = `Topology edge delete failed: ${errorMessage(error)}`;
          setTopologyError(message);
          setMessage(message);
        });
    },
    [mutateTopology]
  );

  const deleteTopologyEdges = useCallback(
    (deletedEdges: DashboardEdge[]) => {
      const removed = deletedEdges
        .map((edge) => ({
          source: edgeEndpointForFlowNode(nodes, edge.source, topologyNodeIds)?.logicalNodeId,
          target: edgeEndpointForFlowNode(nodes, edge.target, topologyNodeIds)?.logicalNodeId
        }))
        .filter((edge): edge is TopologyEdgeEndpoints => Boolean(edge.source && edge.target));
      return deleteTopologyEdgeDependencies(removed);
    },
    [deleteTopologyEdgeDependencies, nodes, topologyNodeIds]
  );

  const deleteSelectedTopologyEdge = useCallback(
    (edgeSummary: SelectedEdgeSummary) =>
      deleteTopologyEdgeDependencies([
        {
          source: edgeSummary.source.logicalNodeId,
          target: edgeSummary.target.logicalNodeId
        }
      ]),
    [deleteTopologyEdgeDependencies]
  );

  const openNewPromptForm = useCallback(() => {
    const ids = existingTopologyNodeIds(topology, flow);
    const id = uniqueTopologyNodeId(ids, "new-prompt");
    const groupOptions = topologyGroupOptions(topology?.topology ?? null);
    const selectedGroup = selectedFlowNode?.data.group ?? "";
    const group = groupOptions.some((option) => option.id === selectedGroup)
      ? selectedGroup
      : (groupOptions[0]?.id ?? "");
    const dependencyOptions = topologyNodeOptions(topology?.topology ?? null, flow);
    const dependency = selectedFlowNode?.data.logicalNodeId ?? "";
    setConfig(null);
    setConfigError("");
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setConnectSourceNodeId(null);
    setNodeDetail(null);
    setNodeError("");
    setNewPromptDraft({
      content: defaultNewPromptMarkdown(id),
      group,
      dependsOn: dependencyOptions.some((option) => option.id === dependency) ? [dependency] : []
    });
    setNewPromptError("");
    setSidePanelOpen(true);
  }, [flow, selectedFlowNode, topology]);

  const createTopologyNode = useCallback(
    async (draft: NewPromptDraft) => {
      const group = draft.group.trim();
      const groupOptions = topologyGroupOptions(topology?.topology ?? null);
      const dependencies = uniqueSelections(draft.dependsOn).filter(
        (dependency) => dependency !== promptFrontmatterId(draft.content)
      );
      if (group && !isValidTopologyToken(group)) {
        setNewPromptError("Use lowercase letters, numbers, dashes, or underscores for the group.");
        return;
      }
      if (group && !groupOptions.some((option) => option.id === group)) {
        setNewPromptError("Choose a group from the topology.");
        return;
      }
      if (!session) {
        setNewPromptError("Dashboard session is not ready.");
        return;
      }
      try {
        const response = await fetch("/api/prompts/nodes", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-ultrafuzz-session": session.sessionToken
          },
          body: JSON.stringify(
            dashboardRequest("prompt-create", {
              content: draft.content,
              ...(group ? { group } : {}),
              dependsOn: dependencies
            })
          )
        });
        if (!response.ok) {
          throw new Error(await response.text());
        }
        const saved = parseDashboardHttpDocument<SavePromptResponse>(await response.json(), "prompt-save");
        await loadTopology();
        await loadFlow();
        if (saved.nodeId) {
          setSelectedNodeId(saved.nodeId);
          setSidePanelOpen(true);
        }
        setNewPromptDraft(null);
        setNewPromptError("");
        setMessage("Added prompt");
      } catch (error) {
        const message = `Topology node save failed: ${errorMessage(error)}`;
        setNewPromptError(message);
        setTopologyError(message);
        setMessage(message);
      }
    },
    [loadFlow, loadTopology, session, topology]
  );

  const cancelNewPrompt = useCallback(() => {
    setNewPromptDraft(null);
    setNewPromptError("");
    setSidePanelOpen(false);
  }, []);

  const startTopologyEdgeFrom = useCallback(
    (sourceNodeId: string) => {
      if (connectSourceNodeId === sourceNodeId) {
        setConnectSourceNodeId(null);
        setMessage("");
        return;
      }
      const source = edgeEndpointForFlowNode(nodes, sourceNodeId, topologyNodeIds);
      if (!source) {
        return;
      }
      setSelectedEdgeId(null);
      setSelectedNodeId(sourceNodeId);
      setSidePanelOpen(true);
      setConnectSourceNodeId(sourceNodeId);
      setMessage("Select a target node to connect.");
    },
    [connectSourceNodeId, nodes, topologyNodeIds]
  );

  const deleteTopologyNode = useCallback(
    (logicalNodeId: string) => {
      mutateTopology((nextTopology) => {
        nextTopology.nodes = nextTopology.nodes.filter((node) => node.id !== logicalNodeId);
        nextTopology.nodes.forEach((node) => {
          node.depends_on = (node.depends_on ?? []).filter((dependency) => dependency !== logicalNodeId);
        });
      })
        .then(() => {
          setSelectedNodeId(null);
          setConnectSourceNodeId(null);
          setSidePanelOpen(false);
          setMessage("Deleted prompt");
        })
        .catch((error) => {
          const message = `Topology node delete failed: ${errorMessage(error)}`;
          setTopologyError(message);
          setMessage(message);
        });
    },
    [mutateTopology]
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!selectedEdge || isEditableKeyboardTarget(event.target)) {
        return;
      }
      if (event.key !== "Backspace" && event.key !== "Delete") {
        return;
      }
      event.preventDefault();
      deleteTopologyEdges([selectedEdge]).catch(() => undefined);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [deleteTopologyEdges, selectedEdge]);

  const toolbarErrors = useMemo(
    () =>
      [sessionError, flowError, eventsError, configError, topologyError, liveError, commandStreamError].filter(Boolean),
    [commandStreamError, configError, eventsError, flowError, liveError, sessionError, topologyError]
  );
  const activityErrors = useMemo(
    () => [eventsError, commandStreamError].filter(Boolean),
    [commandStreamError, eventsError]
  );
  const hasActiveRunActivity = Boolean(flow?.run.active_nodes.length) || flow?.run.status === "running";
  const hasActiveCommandJobs = jobs.some((job) => isActiveActivityStatus(job.status));
  useEffect(() => {
    if (activityErrors.length || hasActiveRunActivity || hasActiveCommandJobs) {
      setActivityConsoleOpen(true);
    }
  }, [activityErrors.length, hasActiveCommandJobs, hasActiveRunActivity]);
  const dashboardClassName = [
    "dashboard",
    sidePanelOpen ? "dashboard--side-open" : "dashboard--side-closed",
    activityConsoleOpen ? "dashboard--activity-open" : "dashboard--activity-closed"
  ].join(" ");

  return (
    <ReactFlowProvider>
      <div className={dashboardClassName}>
        <main className="canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={connectTopologyNodes}
            onConnectEnd={endDraggedTopologyEdge}
            onConnectStart={startDraggedTopologyEdge}
            onEdgesDelete={deleteTopologyEdges}
            onEdgeClick={(event, edge) => {
              event.stopPropagation();
              setSelectedNodeId(null);
              setSelectedEdgeId(edge.id);
              setSidePanelOpen(true);
              setConnectSourceNodeId(null);
              setConfig(null);
              setConfigError("");
              setNewPromptDraft(null);
              setNewPromptError("");
            }}
            onInit={setFlowInstance}
            onNodeClick={(_, node) => {
              if (!isExecutableFlowNode(node)) {
                return;
              }
              if (connectSourceNodeId) {
                const sourceNodeId = connectSourceNodeId;
                setConnectSourceNodeId(null);
                setSelectedEdgeId(null);
                setConfig(null);
                setConfigError("");
                setNewPromptDraft(null);
                setNewPromptError("");
                if (
                  sourceNodeId !== node.id &&
                  isValidTopologyConnectionCandidate(
                    nodes,
                    { source: sourceNodeId, target: node.id },
                    edgeEndpointValidationNodes,
                    topologyNodeIds
                  )
                ) {
                  connectTopologyNodesByFlowId(sourceNodeId, node.id).catch((error) => {
                    const message = `Topology edge save failed: ${errorMessage(error)}`;
                    setTopologyError(message);
                    setMessage(message);
                  });
                }
              }
              setConfig(null);
              setConfigError("");
              setNewPromptDraft(null);
              setNewPromptError("");
              setSelectedEdgeId(null);
              setSelectedNodeId(node.id);
              setSidePanelOpen(true);
            }}
            onPaneClick={() => {
              setSelectedNodeId(null);
              setSelectedEdgeId(null);
              setConnectSourceNodeId(null);
              if (!config && !newPromptDraft) {
                setSidePanelOpen(false);
              }
            }}
            defaultViewport={groupedInitialViewport}
            minZoom={0.18}
            maxZoom={1.35}
            isValidConnection={isValidTopologyConnection}
            nodesConnectable={Boolean(topology?.editable)}
            nodesDraggable={false}
            colorMode={resolvedTheme}
            elevateEdgesOnSelect={false}
            zIndexMode="manual"
          >
            <Background gap={14} size={1} color="var(--mds-grid-dot)" />
            <Controls position="bottom-left" />
            <MiniMap
              pannable
              zoomable
              nodeColor={miniMapNodeFill}
              nodeStrokeColor={miniMapNodeStroke}
              nodeStrokeWidth={2}
              position="bottom-right"
              style={{ height: 108, width: 168 }}
            />
            <Panel position="top-left">
              <Toolbar
                errors={toolbarErrors}
                flow={flow}
                graphViewMode={graphViewMode}
                liveState={liveState}
                message={message}
                openNewPromptForm={openNewPromptForm}
                openConfig={() => openConfig().catch((error) => setMessage(String(error)))}
                panelToggles={{
                  "activity-console": activityConsoleOpen,
                  "side-panel": sidePanelOpen
                }}
                runCommand={runCommand}
                setGraphViewMode={setGraphViewMode}
                setThemePreference={setThemePreference}
                themePreference={themePreference}
                togglePanel={(panel) => {
                  if (panel === "side-panel") {
                    setSidePanelOpen((open) => !open);
                    return;
                  }
                  setActivityConsoleOpen((open) => !open);
                }}
              />
            </Panel>
            {!flow && !flowError ? (
              <Panel position="top-center">
                <div className="loading-strip">Loading run graph</div>
              </Panel>
            ) : null}
          </ReactFlow>
        </main>
        {sidePanelOpen ? (
          <aside
            className="side-panel"
            onBlurCapture={(event) => {
              const nextTarget = event.relatedTarget;
              if (nextTarget instanceof HTMLElement && event.currentTarget.contains(nextTarget)) {
                return;
              }
              liveRefreshGateRef.current.editorFocused = false;
              flushDeferredLiveRefresh();
            }}
            onFocusCapture={() => {
              liveRefreshGateRef.current.editorFocused = true;
            }}
          >
            {config ? (
              <ConfigPanel
                config={config}
                configError={configError}
                onPendingEditChange={reportPendingConfigEdit}
                saveConfig={(content) => saveConfig(content).catch((error) => setMessage(String(error)))}
              />
            ) : newPromptDraft ? (
              <NewPromptPanel
                draft={newPromptDraft}
                error={newPromptError}
                dependencyOptions={topologyNodeOptions(topology?.topology ?? null, flow)}
                groupOptions={topologyGroupOptions(topology?.topology ?? null)}
                onCancel={cancelNewPrompt}
                onCreate={(draft) => createTopologyNode(draft).catch((error) => setMessage(String(error)))}
                setDraft={setNewPromptDraft}
              />
            ) : selectedEdgeSummary ? (
              <EdgePanel
                edgeSummary={selectedEdgeSummary}
                endpointOptions={edgeEndpointOptions}
                onSave={(edit) => retargetSelectedTopologyEdge(selectedEdgeSummary, edit)}
                onDelete={() => deleteSelectedTopologyEdge(selectedEdgeSummary).catch(() => undefined)}
                topologyEditable={Boolean(topology?.editable)}
                validationNodes={edgeEndpointValidationNodes}
              />
            ) : (
              <NodePanel
                key={selectedFlowNode?.id ?? "none"}
                connectSourceNodeId={connectSourceNodeId}
                deleteTopologyNode={deleteTopologyNode}
                detail={nodeDetail}
                flow={flow}
                node={selectedFlowNode ?? null}
                nodeError={nodeError}
                onPendingEditChange={reportPendingPromptEdit}
                onPromptMessage={setMessage}
                sessionToken={session?.sessionToken ?? null}
                startTopologyEdgeFrom={startTopologyEdgeFrom}
                templateVariables={templateVariables}
              />
            )}
          </aside>
        ) : null}
        {activityConsoleOpen ? (
          <section className="event-panel">
            <ActivityConsole errors={activityErrors} events={events} jobs={jobs} />
          </section>
        ) : null}
      </div>
    </ReactFlowProvider>
  );
}

function Toolbar({
  errors,
  flow,
  graphViewMode,
  liveState,
  message,
  openNewPromptForm,
  openConfig,
  panelToggles,
  runCommand,
  setGraphViewMode,
  setThemePreference,
  themePreference,
  togglePanel
}: {
  errors: string[];
  flow: FlowData | null;
  graphViewMode: GraphViewMode;
  liveState: LiveState;
  message: string;
  openNewPromptForm: () => void;
  openConfig: () => void;
  panelToggles: Record<PanelToggle, boolean>;
  runCommand: (command: string, body?: Record<string, unknown>) => void;
  setGraphViewMode: (mode: GraphViewMode) => void;
  setThemePreference: (preference: ThemePreference) => void;
  themePreference: ThemePreference;
  togglePanel: (panel: PanelToggle) => void;
}) {
  const can = (command: string) => {
    const capability = capabilityForCommand(command);
    return Boolean(flow && capability && flow.capabilities[capability]);
  };

  return (
    <div className="toolbar">
      <div className="toolbar__main" aria-label="Run controls">
        <ModeIndicator flow={flow} liveState={liveState} />
        <div className="toolbar__controls">
          <CommandButton disabled={!can("run")} onClick={() => runCommand("run")} variant="primary">
            Run
          </CommandButton>
          <CommandButton disabled={!can("validate")} onClick={() => runCommand("validate")} variant="secondary">
            Validate
          </CommandButton>
          <details className="advanced-actions">
            <summary className="advanced-actions__summary">Advanced</summary>
            <div className="advanced-actions__panel">
              <ActionGroup label="Graph view">
                <ViewToggle value={graphViewMode} onChange={setGraphViewMode} />
                <CommandButton
                  disabled={!flow?.capabilities.runNewCampaign}
                  onClick={openNewPromptForm}
                  variant="secondary"
                >
                  Add prompt
                </CommandButton>
              </ActionGroup>
              <ActionGroup label="Panels">
                <CommandButton
                  ariaLabel={panelToggles["side-panel"] ? "Collapse side panel" : "Expand side panel"}
                  onClick={() => togglePanel("side-panel")}
                  variant="secondary"
                >
                  {panelToggles["side-panel"] ? "Hide side panel" : "Show side panel"}
                </CommandButton>
                <CommandButton
                  ariaLabel={panelToggles["activity-console"] ? "Collapse Activity Console" : "Expand Activity Console"}
                  onClick={() => togglePanel("activity-console")}
                  variant="secondary"
                >
                  {panelToggles["activity-console"] ? "Hide console" : "Show console"}
                </CommandButton>
              </ActionGroup>
              <ActionGroup label="Appearance">
                <ThemeSelect value={themePreference} onChange={setThemePreference} />
              </ActionGroup>
              <ActionGroup label="Run inspection">
                <CommandButton disabled={!can("ps")} onClick={() => runCommand("ps")} variant="ghost">
                  Runs
                </CommandButton>
                <CommandButton disabled={!can("inspect")} onClick={() => runCommand("inspect")} variant="ghost">
                  Inspect
                </CommandButton>
                <CommandButton disabled={!can("report")} onClick={() => runCommand("report")} variant="ghost">
                  Report
                </CommandButton>
              </ActionGroup>
              <ActionGroup label="Lifecycle">
                <CommandButton disabled={!can("resume")} onClick={() => runCommand("resume")} variant="secondary">
                  Resume
                </CommandButton>
                <CommandButton disabled={!can("replay")} onClick={() => runCommand("replay")} variant="secondary">
                  Replay
                </CommandButton>
                <CommandButton disabled={!can("fork")} onClick={() => runCommand("fork")} variant="secondary">
                  Fork
                </CommandButton>
              </ActionGroup>
              <ActionGroup label="References and config">
                <CommandButton
                  disabled={!can("references-status")}
                  onClick={() => runCommand("references-status")}
                  variant="ghost"
                >
                  Ref status
                </CommandButton>
                <CommandButton
                  disabled={!can("references-sync")}
                  onClick={() => runCommand("references-sync")}
                  variant="ghost"
                >
                  Ref sync
                </CommandButton>
                <CommandButton
                  disabled={!can("references-update")}
                  onClick={() => runCommand("references-update", { latest: true })}
                  variant="ghost"
                >
                  Ref update
                </CommandButton>
                <CommandButton disabled={!can("config")} onClick={openConfig} variant="secondary">
                  Config
                </CommandButton>
                <CommandButton
                  disabled={!can("materialize")}
                  onClick={() => runCommand("materialize", { dryRun: true })}
                  variant="secondary"
                >
                  Materialize
                </CommandButton>
              </ActionGroup>
              <ActionGroup label="Confirmation required">
                <CommandButton
                  disabled={!can("clean")}
                  onClick={() => runCommand("clean", { dryRun: true })}
                  variant="destructive"
                >
                  Clean
                </CommandButton>
              </ActionGroup>
            </div>
          </details>
        </div>
      </div>
      {flow?.run.health ? <RunHealthPanel run={flow.run} /> : null}
      <SystemAlerts errors={errors} message={message} />
    </div>
  );
}

function ThemeSelect({ onChange, value }: { onChange: (preference: ThemePreference) => void; value: ThemePreference }) {
  return (
    <label className="theme-select">
      <span className="theme-select__label">Theme</span>
      <select aria-label="Theme" value={value} onChange={(event) => onChange(event.target.value as ThemePreference)}>
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}

function ViewToggle({ onChange, value }: { onChange: (mode: GraphViewMode) => void; value: GraphViewMode }) {
  return (
    <div aria-label="Graph view mode" className="view-toggle" role="group">
      {(["grouped", "flat"] as const).map((mode) => (
        <button
          aria-pressed={value === mode}
          className={`view-toggle__button ${value === mode ? "is-active" : ""}`}
          key={mode}
          onClick={() => onChange(mode)}
          type="button"
        >
          {mode === "grouped" ? "Grouped" : "Flat"}
        </button>
      ))}
    </div>
  );
}

function ModeIndicator({ flow, liveState }: { flow: FlowData | null; liveState: LiveState }) {
  const run = flow?.run;
  const modeLabel = run ? compactModeLabel(run.mode) : "Loading";
  const statusLabel = run ? (statusLabels[run.status] ?? run.status) : "Unknown";
  const liveLabel = liveStateLabel(liveState);
  return (
    <div
      aria-label={`Mode: ${modeLabel}. Status: ${statusLabel}. Live updates: ${liveLabel}.`}
      className="mode-indicator"
      title={`Status: ${statusLabel}; Live updates: ${liveLabel}`}
    >
      <span className="mode-indicator__label">Mode</span>
      <strong className="mode-indicator__value">{modeLabel}</strong>
    </div>
  );
}

function compactModeLabel(mode: string): string {
  const normalized = mode.trim().toLowerCase();
  if (!normalized) {
    return "Unknown";
  }
  if (normalized.includes("preview")) {
    return "Preview";
  }
  if (normalized === "persisted" || normalized.includes("run") || normalized.includes("live")) {
    return "Active run";
  }
  return mode;
}

function RunHealthPanel({ run }: { run: RunOverview }) {
  const health = run.health;
  if (!health) {
    return null;
  }
  const tone = runHealthTone(health);
  const activeNodes = health.active_nodes.map((node) => node.label);
  const activeNodeLabel = activeNodes.length ? activeNodes.join(", ") : "none";
  const logLabel = `${health.stdout_freshness.status} / ${health.stderr_freshness.status}`;
  const timeoutLabel =
    health.timeout.minimum_remaining_seconds == null
      ? health.timeout.status
      : `${health.timeout.status}, ${formatHealthSeconds(health.timeout.minimum_remaining_seconds)} left`;
  const elapsedLabel =
    health.lineage?.cumulative_elapsed_seconds != null
      ? formatHealthSeconds(health.lineage.cumulative_elapsed_seconds)
      : "unavailable";
  const spendLabel = health.lineage?.cumulative_estimated_spend ?? "unavailable";
  const tokenLabel = health.lineage?.cumulative_tokens_used ?? "unavailable";

  return (
    <section aria-label="Run health" className={`run-health run-health--${tone}`}>
      <div className="run-health__header">
        <DenseChip label={runHealthLabel(health)} tone={tone} />
        <strong>{restartReuseLabel(health)}</strong>
      </div>
      <div className="run-health__grid">
        <RunHealthFact label="Active" value={activeNodeLabel} />
        <RunHealthFact label="Process" value={health.process_liveness.status} />
        <RunHealthFact label="Logs" value={logLabel} />
        <RunHealthFact label="Timeout" value={timeoutLabel} />
        <RunHealthFact
          label="Artifacts"
          value={`${health.artifacts.present_required}/${health.artifacts.total_required} required`}
        />
        <RunHealthFact label="Lineage" value={lineageSummaryLabel(health)} />
        <RunHealthFact label="Elapsed" value={elapsedLabel} />
        <RunHealthFact label="Spend" value={`${tokenLabel} / ${spendLabel}`} />
      </div>
      <p>{health.restart?.guidance ?? health.stale?.guidance ?? "Health detail unavailable."}</p>
    </section>
  );
}

function RunHealthFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="run-health__fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ActionGroup({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="action-group">
      <span className="action-group__label">{label}</span>
      <div className="action-group__buttons">{children}</div>
    </div>
  );
}

function CommandButton({
  ariaLabel,
  children,
  className = "",
  disabled,
  onClick,
  title,
  variant
}: {
  ariaLabel?: string;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
  variant: ButtonVariant;
}) {
  return (
    <button
      aria-label={ariaLabel}
      className={`button button--${variant} ${className}`.trim()}
      disabled={disabled}
      onClick={onClick}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}

function SystemAlerts({ errors, message }: { errors: string[]; message: string }) {
  if (!errors.length && !message) {
    return null;
  }
  return (
    <div className="system-alerts">
      {errors.map((error) => (
        <AlertBanner key={error} tone="error">
          {error}
        </AlertBanner>
      ))}
      {message ? (
        <AlertBanner tone={message.toLowerCase().includes("failed") ? "error" : "info"}>{message}</AlertBanner>
      ) : null}
    </div>
  );
}

function ConfigPanel({
  config,
  configError,
  onPendingEditChange,
  saveConfig
}: {
  config: ConfigDetail;
  configError: string;
  onPendingEditChange: (pending: boolean) => void;
  saveConfig: (content: string) => Promise<void>;
}) {
  const {
    configDraft,
    saveConfig: saveDraft,
    setConfigDraft
  } = useManagedConfigEditor({
    config,
    onPendingEditChange,
    onSave: saveConfig
  });
  const deferredConfigDraft = useDeferredValue(configDraft);
  return (
    <div className="panel-content">
      <header className="panel-header">
        <div className="panel-header__meta">
          <span className="panel-node-id">config</span>
        </div>
        <h2>Dashboard config</h2>
        <p>{config.path}</p>
      </header>
      {configError ? (
        <div className="panel-alerts">
          <AlertBanner tone="error">{configError}</AlertBanner>
        </div>
      ) : null}
      <div className="panel-stack">
        <SpecList
          items={[
            { label: "Source", value: config.source },
            { label: "Path", value: <code>{config.path}</code> },
            { label: "Editable", value: config.editable ? "yes" : "no" },
            { label: "Hash", value: <code>{config.contentHash}</code> }
          ]}
        />
        <section className="panel-section">
          <h3>Config TOML</h3>
          <textarea
            aria-label="Config TOML"
            className="markdown-editor config-editor"
            disabled={!config.editable}
            onChange={(event) => setConfigDraft(event.target.value)}
            spellCheck={false}
            value={configDraft}
          />
          <div className="prompt-actions">
            <CommandButton
              disabled={!config.editable}
              onClick={() => saveDraft().catch(() => undefined)}
              variant="primary"
            >
              Save config
            </CommandButton>
          </div>
          <div className="split-view">
            <section>
              <h3>Preview</h3>
              <MarkdownPreview className="config-preview" value={deferredConfigDraft} />
            </section>
            <section>
              <h3>Diff</h3>
              <DiffView after={deferredConfigDraft} before={config.content} />
            </section>
          </div>
        </section>
      </div>
    </div>
  );
}

function NewPromptPanel({
  draft,
  error,
  dependencyOptions,
  groupOptions,
  onCancel,
  onCreate,
  setDraft
}: {
  draft: NewPromptDraft;
  error: string;
  dependencyOptions: TopologyNodeOption[];
  groupOptions: TopologyGroupOption[];
  onCancel: () => void;
  onCreate: (draft: NewPromptDraft) => void;
  setDraft: (draft: NewPromptDraft) => void;
}) {
  const updateDraft = (edit: Partial<NewPromptDraft>) => setDraft({ ...draft, ...edit });
  const draftNodeId = promptFrontmatterId(draft.content);
  const availableDependencyOptions = dependencyOptions.filter((option) => option.id !== draftNodeId);
  const dependencyValues = draft.dependsOn.filter((dependency) =>
    availableDependencyOptions.some((option) => option.id === dependency)
  );
  const dependencySize = Math.min(Math.max(availableDependencyOptions.length, 3), 7);
  return (
    <div className="panel-content">
      <header className="panel-header">
        <h2>New prompt</h2>
      </header>
      {error ? (
        <div className="panel-alerts">
          <AlertBanner tone="error">{error}</AlertBanner>
        </div>
      ) : null}
      <div className="panel-stack">
        <section className="panel-section form-section">
          <textarea
            aria-label="New prompt Markdown"
            className="markdown-editor markdown-editor--prompt"
            onChange={(event) => updateDraft({ content: event.target.value })}
            spellCheck={false}
            value={draft.content}
          />
          <label className="form-field">
            <span>Group</span>
            <select
              aria-label="Group"
              className="text-input select-input"
              onChange={(event) => updateDraft({ group: event.currentTarget.value })}
              value={draft.group}
            >
              <option value="">Ungrouped</option>
              {groupOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            <span>Depends on</span>
            <select
              aria-label="Depends on"
              className="text-input select-input dependency-select"
              disabled={!availableDependencyOptions.length}
              multiple
              onChange={(event) =>
                updateDraft({
                  dependsOn: Array.from(event.currentTarget.selectedOptions, (option) => option.value)
                })
              }
              size={dependencySize}
              value={dependencyValues}
            >
              {availableDependencyOptions.length ? (
                availableDependencyOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))
              ) : (
                <option disabled value="">
                  No nodes available
                </option>
              )}
            </select>
          </label>
          <div className="panel-actions">
            <CommandButton onClick={() => onCreate(draft)} variant="primary">
              Add prompt
            </CommandButton>
            <CommandButton onClick={onCancel} variant="ghost">
              Cancel
            </CommandButton>
          </div>
        </section>
      </div>
    </div>
  );
}

function EdgePanel({
  edgeSummary,
  endpointOptions,
  onSave,
  topologyEditable,
  validationNodes,
  onDelete
}: {
  edgeSummary: SelectedEdgeSummary;
  endpointOptions: EdgeEndpoint[];
  onSave: (edit: { sourceLogicalNodeId: string; targetLogicalNodeId: string }) => Promise<void>;
  topologyEditable: boolean;
  validationNodes: EdgeEndpointValidationNode[];
  onDelete: () => void;
}) {
  const [sourceLogicalNodeId, setSourceLogicalNodeId] = useState(edgeSummary.source.logicalNodeId);
  const [targetLogicalNodeId, setTargetLogicalNodeId] = useState(edgeSummary.target.logicalNodeId);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setSourceLogicalNodeId(edgeSummary.source.logicalNodeId);
    setTargetLogicalNodeId(edgeSummary.target.logicalNodeId);
    setSaveError("");
    setSaving(false);
  }, [edgeSummary.edge.id, edgeSummary.source.logicalNodeId, edgeSummary.target.logicalNodeId]);
  const edit: EdgeEndpointEdit = {
    oldSource: edgeSummary.source.logicalNodeId,
    oldTarget: edgeSummary.target.logicalNodeId,
    source: sourceLogicalNodeId,
    target: targetLogicalNodeId
  };
  const validation = validateEdgeEndpointEdit({ edit, nodes: validationNodes, topologyEditable });
  const validationMessage = validation.changed || !topologyEditable ? validation.message : "";
  const saveDisabled = saving || !validation.valid;
  const saveTitle = saveDisabled ? validation.message : "Save dependency edge";
  const saveEdge = () => {
    if (!validation.valid || saving) {
      return;
    }
    setSaving(true);
    setSaveError("");
    onSave({ sourceLogicalNodeId, targetLogicalNodeId })
      .catch((error) => setSaveError(errorMessage(error)))
      .finally(() => setSaving(false));
  };
  return (
    <div className="panel-content">
      <header className="panel-header">
        <h2>Dependency edge</h2>
        <p>
          {edgeSummary.source.label} feeds {edgeSummary.target.label}
        </p>
      </header>
      <div className="panel-stack">
        {validationMessage || saveError ? (
          <div className="panel-alerts">
            {validationMessage ? <AlertBanner tone="error">{validationMessage}</AlertBanner> : null}
            {saveError ? <AlertBanner tone="error">{saveError}</AlertBanner> : null}
          </div>
        ) : null}
        <section className="panel-section form-section edge-edit-section">
          <label className="form-field">
            <span>Start node</span>
            <select
              aria-label="Start node"
              className="text-input"
              disabled={!topologyEditable || saving}
              onChange={(event) => setSourceLogicalNodeId(event.target.value)}
              value={sourceLogicalNodeId}
            >
              {endpointOptions.map((option) => (
                <option disabled={!option.promptEditable} key={option.logicalNodeId} value={option.logicalNodeId}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            <span>End node</span>
            <select
              aria-label="End node"
              className="text-input"
              disabled={!topologyEditable || saving}
              onChange={(event) => setTargetLogicalNodeId(event.target.value)}
              value={targetLogicalNodeId}
            >
              {endpointOptions.map((option) => (
                <option disabled={!option.promptEditable} key={option.logicalNodeId} value={option.logicalNodeId}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <div className="panel-actions">
            <CommandButton disabled={saveDisabled} onClick={saveEdge} title={saveTitle} variant="primary">
              {saving ? "Saving" : "Save edge"}
            </CommandButton>
            <CommandButton onClick={onDelete} variant="destructive">
              Delete edge
            </CommandButton>
          </div>
        </section>
      </div>
    </div>
  );
}

function NodePanel({
  connectSourceNodeId,
  deleteTopologyNode,
  detail,
  flow,
  node,
  nodeError,
  onPendingEditChange,
  onPromptMessage,
  sessionToken,
  startTopologyEdgeFrom,
  templateVariables
}: {
  connectSourceNodeId: string | null;
  deleteTopologyNode: (logicalNodeId: string) => void;
  detail: NodeDetail | null;
  flow: FlowData | null;
  node: DashboardFlowNode | null;
  nodeError: string;
  onPendingEditChange: (pending: boolean) => void;
  onPromptMessage: (message: string) => void;
  sessionToken: string | null;
  startTopologyEdgeFrom: (sourceNodeId: string) => void;
  templateVariables: readonly string[] | undefined;
}) {
  const promptEndpoint = node ? promptEndpointForNode(node) : null;
  const artifactReferenceContext = useMemo(
    () => artifactReferenceValidationContext(flow, node?.id ?? null),
    [flow, node?.id]
  );
  const { prompt, promptDraft, promptError, promptSaving, promptTemplateValidation, setPromptDraft } =
    useManagedPromptEditor({
      artifactReferenceContext,
      isStrategyAggregate: Boolean(node && isStrategyAggregateNode(node)),
      onMessage: onPromptMessage,
      onPendingEditChange,
      promptEndpoint,
      sessionToken,
      templateVariables
    });

  if (!node) {
    return (
      <div className="empty-panel">
        <h2>Run graph</h2>
        <p>Select a node to inspect editable Markdown and run evidence.</p>
      </div>
    );
  }

  const nodeStatus = node.data.status;
  const timeoutFact = timeoutFactLabel(node.data.timeoutSeconds);
  const panelErrors = [nodeError, promptError].filter(Boolean);
  const subtitle = nodePanelSubtitle({
    label: node.data.label,
    kind: node.data.kind,
    strategy: node.data.strategy
      ? {
          display_name: node.data.strategy.display_name,
          category: node.data.strategy.category
        }
      : undefined
  });

  return (
    <div className="panel-content">
      <header className="panel-header">
        <div className="panel-header__meta">
          <StatusBadge prominent status={nodeStatus} />
          {timeoutFact ? <span className="panel-node-id">{timeoutFact}</span> : null}
        </div>
        <h2>{node.data.label}</h2>
        {subtitle ? <p>{subtitle}</p> : null}
      </header>
      {panelErrors.length ? (
        <div className="panel-alerts">
          {panelErrors.map((error) => (
            <AlertBanner key={error} tone="error">
              {error}
            </AlertBanner>
          ))}
        </div>
      ) : null}
      <div className="panel-stack node-panel-stack">
        <TopologyControls
          connectSourceNodeId={connectSourceNodeId}
          deleteTopologyNode={deleteTopologyNode}
          node={node}
          startTopologyEdgeFrom={startTopologyEdgeFrom}
        />
        <PromptMarkdownSurface
          detail={detail}
          prompt={prompt}
          promptDraft={promptDraft}
          promptError={promptError}
          promptSaving={promptSaving}
          promptTemplateValidation={promptTemplateValidation}
          setPromptDraft={setPromptDraft}
        />
        <NodeEvidence detail={detail} detailLoading={!nodeError && !isStrategyAggregateNode(node)} node={node} />
      </div>
    </div>
  );
}

function TopologyControls({
  connectSourceNodeId,
  deleteTopologyNode,
  node,
  startTopologyEdgeFrom
}: {
  connectSourceNodeId: string | null;
  deleteTopologyNode: (logicalNodeId: string) => void;
  node: DashboardFlowNode;
  startTopologyEdgeFrom: (sourceNodeId: string) => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const logicalNodeId = node.data.logicalNodeId;
  const edgeSourceActive = connectSourceNodeId === node.id;
  const canConnect = canEditTopologyWiringData(node.data) && !isFinishMetaNode(node);
  const canDelete = Boolean(node.data.topologyEditable && node.data.promptEditable && !isMetaFlowNode(node));
  useEffect(() => {
    setConfirmingDelete(false);
  }, [node.id]);
  return (
    <section className="panel-section topology-controls">
      <h3>Actions</h3>
      <div className="panel-actions">
        <CommandButton
          disabled={!canConnect}
          onClick={() => startTopologyEdgeFrom(node.id)}
          variant={edgeSourceActive ? "primary" : "secondary"}
        >
          {edgeSourceActive ? "Cancel edge" : "Connect"}
        </CommandButton>
        {confirmingDelete ? (
          <>
            <CommandButton
              disabled={!canDelete}
              onClick={() => deleteTopologyNode(logicalNodeId)}
              variant="destructive"
            >
              Delete
            </CommandButton>
            <CommandButton onClick={() => setConfirmingDelete(false)} variant="ghost">
              Cancel
            </CommandButton>
          </>
        ) : (
          <CommandButton disabled={!canDelete} onClick={() => setConfirmingDelete(true)} variant="destructive">
            Delete
          </CommandButton>
        )}
      </div>
    </section>
  );
}

function NodeEvidence({
  detail,
  detailLoading,
  node
}: {
  detail: NodeDetail | null;
  detailLoading: boolean;
  node: DashboardFlowNode;
}) {
  const evidenceInput = {
    availability: node.data.artifacts,
    detail,
    detailLoading,
    findingCount: node.data.findingCount
  };
  const sections = visibleNodeEvidenceSections(evidenceInput);
  if (!sections.length) {
    return null;
  }
  return (
    <section aria-label="Node evidence" className="panel-section node-evidence">
      <h3>Evidence</h3>
      <div className="evidence-list">
        {sections.map((section) => (
          <details className="evidence-disclosure" key={section}>
            <summary>
              <span>{evidenceSectionLabel(section)}</span>
              <small>{nodeEvidenceCountLabel(section, evidenceInput)}</small>
            </summary>
            <div className="evidence-body">
              {section === "artifacts" ? <ArtifactsEvidence detail={detail} /> : null}
              {section === "logs" ? <LogsEvidence detail={detail} /> : null}
              {section === "findings" ? <FindingsEvidence detail={detail} /> : null}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

function evidenceSectionLabel(section: NodeEvidenceSectionId): string {
  if (section === "artifacts") {
    return "Artifacts";
  }
  if (section === "logs") {
    return "Logs";
  }
  return "Findings";
}

function ArtifactsEvidence({ detail }: { detail: NodeDetail | null }) {
  if (!detail) {
    return <EmptyState body="Node artifacts are loading." title="Artifacts loading" />;
  }
  const outputs = detail.artifactReferences?.outputs ?? [];
  const referencedPrevious = detail.artifactReferences?.referencedPrevious ?? [];
  return (
    <div className="evidence-stack">
      <ArtifactReferenceGroup artifacts={outputs} title="Outputs from this node" />
      <ArtifactReferenceGroup artifacts={referencedPrevious} title="Referenced previous artifacts" />
      {detail.artifacts.length ? (
        <div className="data-list">
          <div className="data-row data-row--header">
            <span>Kind</span>
            <span>Path</span>
            <span>Size</span>
          </div>
          {detail.artifacts.map((artifact) => (
            <div className="data-row" key={artifact.path}>
              <span>{artifact.kind}</span>
              <code>{artifact.path}</code>
              <span>{formatBytes(artifact.size_bytes)}</span>
            </div>
          ))}
        </div>
      ) : detail.metadata || outputs.length || referencedPrevious.length ? null : (
        <EmptyState body="This node has not recorded artifact files." title="No artifacts" />
      )}
      {detail.metadata ? (
        <section className="panel-section">
          <h3>Metadata</h3>
          <JsonBlock value={detail.metadata} />
        </section>
      ) : null}
    </div>
  );
}

function ArtifactReferenceGroup({ artifacts, title }: { artifacts: PromptArtifactPreview[]; title: string }) {
  if (!artifacts.length) {
    return null;
  }
  return (
    <section className="artifact-reference-group">
      <h4>{title}</h4>
      <div className="artifact-preview-list">
        {artifacts.map((artifact) => (
          <ArtifactPreviewCard artifact={artifact} key={`${artifact.concreteNodeId}:${artifact.path}`} />
        ))}
      </div>
    </section>
  );
}

function ArtifactPreviewCard({ artifact }: { artifact: PromptArtifactPreview }) {
  return (
    <div className={`artifact-preview artifact-preview--${cssSlug(artifact.state)}`.trim()}>
      <div className="artifact-preview__header">
        <code>{artifact.path}</code>
        <span>{artifact.state}</span>
      </div>
      {artifact.content ? (
        <ArtifactPreviewContentView content={artifact.content} />
      ) : (
        <EmptyState body={artifactPreviewEmptyBody(artifact.state)} title={artifactPreviewEmptyTitle(artifact.state)} />
      )}
    </div>
  );
}

function ArtifactPreviewContentView({ content }: { content: NonNullable<PromptArtifactPreview["content"]> }) {
  if (content.kind === "markdown" && content.text !== undefined) {
    return <MarkdownPreview value={content.text} />;
  }
  if (content.kind === "json") {
    return <JsonBlock value={content.json} />;
  }
  if (content.text !== undefined) {
    return <pre>{content.text}</pre>;
  }
  return <EmptyState body="This artifact preview is unavailable." title="Unsupported artifact" />;
}

function artifactPreviewEmptyTitle(state: string): string {
  if (state === "missing") {
    return "Missing artifact";
  }
  if (state === "directory") {
    return "Artifact directory";
  }
  return "Unsupported artifact";
}

function artifactPreviewEmptyBody(state: string): string {
  if (state === "missing") {
    return "This prompt-referenced artifact has not been written yet.";
  }
  if (state === "directory") {
    return "This reference points to an artifact directory.";
  }
  return "This artifact type does not have an inline preview.";
}

function LogsEvidence({ detail }: { detail: NodeDetail | null }) {
  if (!detail) {
    return <EmptyState body="Node logs are loading." title="Logs loading" />;
  }
  const hasLogs = Boolean(detail.stdout || detail.stderr || detail.transcript);
  if (!hasLogs) {
    return <EmptyState body="This node has no stdout, stderr, or transcript artifact." title="No logs" />;
  }
  return (
    <div className="evidence-stack">
      {detail.stdout ? <CodeBlock title="Stdout" value={detail.stdout} /> : null}
      {detail.stderr ? <CodeBlock title="Stderr" value={detail.stderr} /> : null}
      {detail.transcript ? (
        <section className="panel-section">
          <h3>Transcript</h3>
          <JsonBlock value={detail.transcript} />
        </section>
      ) : null}
    </div>
  );
}

const PromptMarkdownEditor = memo(function PromptMarkdownEditor({
  disabled,
  invalid,
  onChange,
  value
}: {
  disabled: boolean;
  invalid: boolean;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <textarea
      aria-label="Editable Markdown"
      aria-invalid={invalid}
      className={`markdown-editor markdown-editor--prompt ${invalid ? "markdown-editor--invalid" : ""}`.trim()}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      spellCheck={false}
      value={value}
    />
  );
});

function PromptMarkdownSurface({
  detail,
  prompt,
  promptDraft,
  promptError,
  promptSaving,
  promptTemplateValidation,
  setPromptDraft
}: {
  detail: NodeDetail | null;
  prompt: PromptDetail | null;
  promptDraft: string;
  promptError: string;
  promptSaving: boolean;
  promptTemplateValidation: TemplateValidation;
  setPromptDraft: (value: string) => void;
}) {
  if (!detail && !prompt && !promptError) {
    return <EmptyState body="Markdown data is loading." title="Markdown loading" />;
  }
  if (!prompt && !detail?.rendered_prompt) {
    return <EmptyState body="This node does not expose editable or rendered Markdown." title="No Markdown" />;
  }

  const promptSaveState = !promptTemplateValidation.valid
    ? "Invalid"
    : promptSaving
      ? "Saving"
      : prompt && promptDraft !== prompt.content
        ? "Pending"
        : "Saved";
  const promptSurfaceClassName = [
    "prompt-surface",
    prompt ? "prompt-surface--with-editor" : "",
    detail?.rendered_prompt ? "prompt-surface--with-rendered" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={promptSurfaceClassName}>
      {detail?.rendered_prompt ? <CodeBlock title="Rendered" value={detail.rendered_prompt} /> : null}
      {prompt ? (
        <section className="panel-section prompt-editor-section">
          <PromptMarkdownEditor
            disabled={!prompt.summary.editable}
            invalid={!promptTemplateValidation.valid}
            onChange={setPromptDraft}
            value={promptDraft}
          />
          <div className="prompt-editor-meta">
            {prompt.summary.editable ? (
              <div
                className={`prompt-save-status ${!promptTemplateValidation.valid ? "prompt-save-status--error" : ""}`}
              >
                {promptSaveState}
              </div>
            ) : (
              <div aria-hidden="true" className="prompt-save-status" />
            )}
            {!promptTemplateValidation.valid ? (
              <div className="prompt-template-warning" role="alert">
                {promptTemplateValidation.message}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function FindingsEvidence({ detail }: { detail: NodeDetail | null }) {
  if (!detail) {
    return <EmptyState body="Finding data is loading." title="Findings loading" />;
  }
  if (!detail.findings.length) {
    return <EmptyState body="This node has not recorded findings." title="No findings" />;
  }
  return <JsonBlock value={detail.findings} />;
}

function ActivityConsole({ errors, events, jobs }: { errors: string[]; events: EventRecord[]; jobs: CommandJob[] }) {
  return (
    <div className="activity-console">
      <header className="activity-header">
        <h2>Activity console</h2>
        <div className="activity-counts">
          <span>{formatNumber(events.length)} events</span>
          <span>{formatNumber(jobs.length)} jobs</span>
        </div>
      </header>
      {errors.length ? (
        <div className="activity-alerts">
          {errors.map((error) => (
            <AlertBanner key={error} tone="error">
              {error}
            </AlertBanner>
          ))}
        </div>
      ) : null}
      <div className="activity-grid">
        <ActivityColumn title="Events">
          {events.length ? (
            events.slice(0, 30).map((event, index) => (
              <details className="activity-row" key={`${event.timestamp}-${index}`}>
                <summary>
                  <time>{timeLabel(event.timestamp)}</time>
                  <DenseChip label={eventTone(event)} tone={eventTone(event)} />
                  <span>{event.node_id ?? "run"}</span>
                  <strong>{event.event_type}</strong>
                </summary>
                <JsonBlock value={event.payload} />
              </details>
            ))
          ) : (
            <EmptyState body="No run events have been recorded yet." compact title="No events" />
          )}
        </ActivityColumn>
        <ActivityColumn title="Command jobs">
          {jobs.length ? (
            jobs.slice(0, 20).map((job) => (
              <details className="activity-row" key={job.jobId}>
                <summary>
                  <time>{unixTimeLabel(job.startedAtUnixSeconds)}</time>
                  <StatusBadge dense status={job.status} />
                  <span>{job.command}</span>
                  <code>{job.argv.join(" ")}</code>
                </summary>
                <div className="job-detail">
                  <SpecList
                    items={[
                      { label: "Job id", value: <code>{job.jobId}</code> },
                      { label: "Exit code", value: job.exitCode ?? "-" },
                      {
                        label: "Finished",
                        value: job.finishedAtUnixSeconds ? unixTimeLabel(job.finishedAtUnixSeconds) : "-"
                      },
                      { label: "Error", value: job.error ?? "-" }
                    ]}
                  />
                  {job.output ? <CodeBlock title="Output" value={job.output} /> : null}
                </div>
              </details>
            ))
          ) : (
            <EmptyState body="No command jobs have been started from this session." compact title="No command jobs" />
          )}
        </ActivityColumn>
      </div>
    </div>
  );
}

function ActivityColumn({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="activity-column">
      <h3>{title}</h3>
      <div className="activity-stream">{children}</div>
    </section>
  );
}

function AlertBanner({ children, tone }: { children: ReactNode; tone: "error" | "info" }) {
  return <div className={`alert-banner alert-banner--${tone}`}>{children}</div>;
}

function EmptyState({ body, compact = false, title }: { body: string; compact?: boolean; title: string }) {
  return (
    <div className={`empty-state ${compact ? "empty-state--compact" : ""}`}>
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

function StatusBadge({
  dense = false,
  prominent = false,
  status
}: {
  dense?: boolean;
  prominent?: boolean;
  status: Status;
}) {
  const tone = statusTone(status);
  return (
    <span
      className={`status-badge status-badge--${tone} ${prominent ? "status-badge--bracketed" : ""} ${dense ? "status-badge--dense" : ""}`}
    >
      {statusLabels[status] ?? status}
    </span>
  );
}

function isActiveActivityStatus(status: Status) {
  return status === "pending" || status === "queued" || status === "running";
}

function DenseChip({ label, tone }: { label: string; tone: StatusTone }) {
  return <span className={`dense-chip dense-chip--${tone}`}>{label}</span>;
}

function SpecList({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="spec-list">
      {items.map((item) => (
        <div className="spec-row" key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function CodeBlock({ title, value }: { title: string; value: string }) {
  return (
    <section className="panel-section">
      <h3>{title}</h3>
      <pre>{value}</pre>
    </section>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}

const MarkdownPreview = memo(function MarkdownPreview({
  className = "",
  value
}: {
  className?: string;
  value: string;
}) {
  const lines = useMemo(() => value.split("\n").slice(0, 80), [value]);
  return (
    <div className={`markdown-preview ${className}`.trim()}>
      {lines.map((line, index) => {
        if (line.startsWith("# ")) {
          return <h2 key={index}>{line.slice(2)}</h2>;
        }
        if (line.startsWith("## ")) {
          return <h3 key={index}>{line.slice(3)}</h3>;
        }
        if (line.trim() === "") {
          return <br key={index} />;
        }
        return <p key={index}>{line}</p>;
      })}
    </div>
  );
});

const DiffView = memo(function DiffView({ before, after }: { before: string; after: string }) {
  const rows = useMemo(() => diffLines(before.split("\n"), after.split("\n")), [after, before]);
  return (
    <div className="diff-view">
      {rows.map((row, index) => (
        <div className={`diff-line ${row.kind}`} key={`${row.kind}-${index}`}>
          {row.kind === "added" ? "+ " : row.kind === "removed" ? "- " : " "}
          {row.value}
        </div>
      ))}
    </div>
  );
});

type DiffRow = {
  kind: "same" | "removed" | "added";
  value: string;
};

function diffLines(beforeLines: string[], afterLines: string[]): DiffRow[] {
  const lengths = Array.from({ length: beforeLines.length + 1 }, () =>
    Array.from({ length: afterLines.length + 1 }, () => 0)
  );
  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex -= 1) {
      lengths[beforeIndex][afterIndex] =
        beforeLines[beforeIndex] === afterLines[afterIndex]
          ? lengths[beforeIndex + 1][afterIndex + 1] + 1
          : Math.max(lengths[beforeIndex + 1][afterIndex], lengths[beforeIndex][afterIndex + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < beforeLines.length || afterIndex < afterLines.length) {
    if (
      beforeIndex < beforeLines.length &&
      afterIndex < afterLines.length &&
      beforeLines[beforeIndex] === afterLines[afterIndex]
    ) {
      rows.push({ kind: "same", value: afterLines[afterIndex] });
      beforeIndex += 1;
      afterIndex += 1;
    } else if (
      afterIndex < afterLines.length &&
      (beforeIndex === beforeLines.length ||
        lengths[beforeIndex][afterIndex + 1] >= lengths[beforeIndex + 1][afterIndex])
    ) {
      rows.push({ kind: "added", value: afterLines[afterIndex] });
      afterIndex += 1;
    } else {
      rows.push({ kind: "removed", value: beforeLines[beforeIndex] });
      beforeIndex += 1;
    }
  }
  return rows;
}

async function getJson<T>(url: string, documentType: DashboardHttpDocumentType): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return parseDashboardHttpDocument<T>(await response.json(), documentType);
}

async function postCommandJson<T>(
  url: string,
  command: string,
  commandArguments: Record<string, unknown>,
  token: string
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ultrafuzz-session": token
    },
    body: JSON.stringify(dashboardCommandRequest(command, commandArguments))
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return parseDashboardHttpDocument<T>(await response.json(), "command-job");
}

function promptEndpointForNode(node: DashboardFlowNode): string | null {
  if (!node.data.promptAvailable) {
    return null;
  }
  if (isStrategyAggregateNode(node)) {
    const strategyId = node.data.strategy?.id;
    return strategyId ? `/api/prompts/strategies/${encodeURIComponent(strategyId)}` : null;
  }
  return nodePromptEndpoint(node.id);
}

function nodePromptEndpoint(nodeId: string): string {
  return `/api/prompts/nodes/${encodeURIComponent(nodeId)}`;
}

function cloneTopology(topology: ProjectTopology): ProjectTopology {
  return structuredClone(topology);
}

function edgeIdForLogicalDependency(
  nodes: DashboardGraphNode[],
  edges: DashboardEdge[],
  sourceLogicalNodeId: string,
  targetLogicalNodeId: string
): string | null {
  const edge = edges.find((candidate) => {
    const source = edgeEndpointForFlowNode(nodes, candidate.source);
    const target = edgeEndpointForFlowNode(nodes, candidate.target);
    return source?.logicalNodeId === sourceLogicalNodeId && target?.logicalNodeId === targetLogicalNodeId;
  });
  return edge?.id ?? null;
}

function isValidTopologyConnectionCandidate(
  nodes: DashboardGraphNode[],
  connection: Pick<Connection, "source" | "target">,
  validationNodes: EdgeEndpointValidationNode[],
  topologyNodeIds?: Set<string>
): boolean {
  if (!connection.source || !connection.target) {
    return false;
  }
  const sourceNode = nodes.find((node) => node.id === connection.source);
  const targetNode = nodes.find((node) => node.id === connection.target);
  if (!isExecutableFlowNode(sourceNode) || !isExecutableFlowNode(targetNode)) {
    return false;
  }
  const source = edgeEndpointForFlowNode(nodes, connection.source, topologyNodeIds);
  const target = edgeEndpointForFlowNode(nodes, connection.target, topologyNodeIds);
  if (!source || !target) {
    return false;
  }
  if (!sourceNode.data.topologyConnectable || !targetNode.data.topologyConnectable) {
    return false;
  }
  if (isFinishMetaNode(sourceNode) || isStartMetaNode(targetNode)) {
    return false;
  }
  const sourceIds = topologyNodeReferenceIds(sourceNode);
  const targetIds = topologyNodeReferenceIds(targetNode);
  if (targetNode.data.dependencies.some((dependency) => sourceIds.has(dependency))) {
    return false;
  }
  if (topologyNodeDependsOn(nodes, sourceNode, targetIds)) {
    return false;
  }
  return validateEdgeEndpointEdit({
    edit: {
      oldSource: "",
      oldTarget: "",
      source: source.logicalNodeId,
      target: target.logicalNodeId
    },
    nodes: validationNodes,
    topologyEditable: true
  }).valid;
}

function canEditTopologyWiringData(data: FlowNodeData): boolean {
  return Boolean(data.topologyEditable && data.topologyConnectable);
}

function isMetaFlowNode(node: DashboardGraphNode | undefined): boolean {
  return isExecutableFlowNode(node) && (node.type === "metaStart" || node.type === "metaFinish");
}

function isStartMetaNode(node: DashboardGraphNode | undefined): boolean {
  return isExecutableFlowNode(node) && node.type === "metaStart";
}

function isFinishMetaNode(node: DashboardGraphNode | undefined): boolean {
  return isExecutableFlowNode(node) && node.type === "metaFinish";
}

function topologyNodeReferenceIds(node: DashboardFlowNode): Set<string> {
  const ids = [node.id];
  if (node.data.logicalNodeId) {
    ids.push(node.data.logicalNodeId);
  }
  return new Set(ids);
}

function topologyNodeDependsOn(
  nodes: DashboardGraphNode[],
  startNode: DashboardFlowNode,
  dependencyIds: Set<string>
): boolean {
  const nodesById = new Map<string, DashboardFlowNode>();
  const nodesByLogicalId = new Map<string, DashboardFlowNode>();
  nodes.forEach((node) => {
    if (!isExecutableFlowNode(node)) {
      return;
    }
    nodesById.set(node.id, node);
    nodesByLogicalId.set(node.data.logicalNodeId ?? node.id, node);
  });

  const visited = new Set<string>();
  const pending = [...startNode.data.dependencies];
  while (pending.length) {
    const dependency = pending.pop()!;
    if (dependencyIds.has(dependency)) {
      return true;
    }
    if (visited.has(dependency)) {
      continue;
    }
    visited.add(dependency);
    const dependencyNode = nodesById.get(dependency) ?? nodesByLogicalId.get(dependency);
    if (dependencyNode) {
      pending.push(...dependencyNode.data.dependencies);
    }
  }
  return false;
}

function artifactReferenceValidationContext(
  flow: FlowData | null,
  selectedNodeId: string | null
): { knownNodeIds: string[]; ancestorNodeIds: string[]; currentNodeId?: string } | undefined {
  if (!flow || !selectedNodeId) {
    return undefined;
  }
  const node = flow.nodes.find((item) => item.id === selectedNodeId);
  if (!node) {
    return undefined;
  }
  return {
    knownNodeIds: uniqueStrings(flow.nodes.map((item) => item.data.logicalNodeId ?? item.id)),
    ancestorNodeIds: ancestorLogicalNodeIds(flow.nodes, node),
    currentNodeId: node.data.logicalNodeId ?? node.id
  };
}

function ancestorLogicalNodeIds(nodes: DashboardFlowNode[], node: DashboardFlowNode): string[] {
  const nodesById = new Map(nodes.map((item) => [item.id, item]));
  const ancestors = new Set<string>();
  const visited = new Set<string>();
  const pending = [...node.data.dependencies];
  while (pending.length) {
    const dependency = pending.pop()!;
    if (visited.has(dependency)) {
      continue;
    }
    visited.add(dependency);
    const dependencyNode = nodesById.get(dependency);
    if (!dependencyNode) {
      continue;
    }
    ancestors.add(dependencyNode.data.logicalNodeId ?? dependencyNode.id);
    pending.push(...dependencyNode.data.dependencies);
  }
  return [...ancestors];
}

function edgeEndpointForFlowNode(
  nodes: DashboardGraphNode[],
  nodeId: string,
  topologyNodeIds?: Set<string>
): EdgeEndpoint | null {
  const node = nodes.find((item) => item.id === nodeId);
  if (!isExecutableFlowNode(node) || isStrategyAggregateNode(node)) {
    return null;
  }
  const logicalNodeId = node.data.logicalNodeId ?? node.id;
  if (topologyNodeIds && !topologyNodeIds.has(logicalNodeId)) {
    return null;
  }
  return {
    flowNodeId: node.id,
    label: node.data.label,
    logicalNodeId,
    promptEditable: node.data.topologyConnectable
  };
}

function edgeEndpointOptionsForNodes(nodes: DashboardFlowNode[], topology: TopologyDetail | null): EdgeEndpoint[] {
  const topologyNodeIds = topologyNodeIdSet(topology);
  if (!topologyNodeIds.size) {
    return [];
  }
  const seen = new Set<string>();
  return nodes
    .filter((node) => !isStrategyAggregateNode(node))
    .sort(
      (left, right) =>
        compareNodePosition(left.position, right.position) || left.data.label.localeCompare(right.data.label)
    )
    .map((node) => edgeEndpointForFlowNode(nodes, node.id, topologyNodeIds))
    .filter((endpoint): endpoint is EdgeEndpoint => Boolean(endpoint))
    .filter((endpoint) => {
      if (seen.has(endpoint.logicalNodeId)) {
        return false;
      }
      seen.add(endpoint.logicalNodeId);
      return true;
    });
}

function edgeEndpointValidationNodesForTopology(
  topology: TopologyDetail | null,
  nodes: DashboardFlowNode[]
): EdgeEndpointValidationNode[] {
  if (!topology?.topology) {
    return [];
  }
  const flowNodeByLogicalId = new Map<string, DashboardFlowNode>();
  nodes.forEach((node) => {
    if (isStrategyAggregateNode(node)) {
      return;
    }
    const logicalNodeId = node.data.logicalNodeId ?? node.id;
    if (!flowNodeByLogicalId.has(logicalNodeId)) {
      flowNodeByLogicalId.set(logicalNodeId, node);
    }
  });
  return topology.topology.nodes.map((node) => {
    const flowNode = flowNodeByLogicalId.get(node.id);
    return {
      canSource: flowNode ? !isFinishMetaNode(flowNode) : true,
      canTarget: flowNode ? !isStartMetaNode(flowNode) : true,
      dependencies: node.depends_on ?? [],
      id: node.id,
      logicalNodeId: node.id,
      promptEditable: flowNode?.data.topologyConnectable ?? Boolean(node.prompt)
    };
  });
}

function topologyNodeIdSet(topology: TopologyDetail | null): Set<string> {
  return new Set(topology?.topology?.nodes.map((node) => node.id) ?? []);
}

function existingTopologyNodeIds(topology: TopologyDetail | null, flow: FlowData | null): string[] {
  if (topology?.topology) {
    return topology.topology.nodes.map((node) => node.id);
  }
  return flow?.nodes.map((node) => node.data.logicalNodeId).filter(Boolean) ?? [];
}

function uniqueTopologyNodeId(existingIds: string[], preferredId: string): string {
  const existing = new Set(existingIds);
  if (!existing.has(preferredId)) {
    return preferredId;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${preferredId}-${index}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function defaultNewPromptMarkdown(nodeId: string): string {
  const displayName = titleCaseLabel(nodeId);
  return `---\nid: ${nodeId}\ndisplay_name: ${displayName}\n---\n\n# ${displayName}\n\n`;
}

function isValidTopologyToken(value: string): boolean {
  return /^[a-z0-9_-]+$/.test(value);
}

function topologyGroupOptions(topology: ProjectTopology | null): TopologyGroupOption[] {
  const groups = topology?.groups ?? {};
  const groupIds = new Set(Object.keys(groups));
  topology?.nodes.forEach((node) => {
    if (node.group) {
      groupIds.add(node.group);
    }
  });
  return [...groupIds].map((id) => ({
    id,
    label: groups[id]?.label?.trim() || titleCaseLabel(id)
  }));
}

function topologyNodeOptions(topology: ProjectTopology | null, flow: FlowData | null): TopologyNodeOption[] {
  const flowLabels = new Map<string, string>();
  flow?.nodes.forEach((node) => {
    const id = node.data.logicalNodeId || node.id;
    if (!flowLabels.has(id)) {
      flowLabels.set(id, node.data.label);
    }
  });
  if (topology?.nodes.length) {
    return topology.nodes.map((node) => ({
      id: node.id,
      label: flowLabels.get(node.id) ?? titleCaseLabel(node.id)
    }));
  }
  return uniqueSelections(flow?.nodes.map((node) => node.data.logicalNodeId || node.id) ?? []).map((id) => ({
    id,
    label: flowLabels.get(id) ?? titleCaseLabel(id)
  }));
}

function uniqueSelections(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function promptFrontmatterId(content: string): string | null {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return null;
  }
  const endIndex = normalized.indexOf("\n---", 4);
  if (endIndex < 0) {
    return null;
  }
  const frontmatter = normalized.slice(4, endIndex);
  const match = frontmatter.match(/^id:\s*["']?([^"'\n#]+?)["']?\s*(?:#.*)?$/m);
  const id = match?.[1]?.trim();
  return id || null;
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  return (
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
  );
}

function titleCaseLabel(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function dependencyGraphLayout(
  nodes: DashboardFlowNode[],
  edges: DashboardEdge[],
  viewMode: GraphViewMode
): { nodes: DashboardGraphNode[]; edges: DashboardEdge[] } {
  const collapsed = collapseStrategyNodes(nodes, edges);
  const compactNodes = compactGraphPositions(collapsed.nodes);
  const flatGraph = {
    nodes: compactNodes,
    edges: dependencyEdges(collapsed.edges, compactNodes)
  };
  const positionedGraph = viewMode === "grouped" ? applyPhaseGrouping(flatGraph.nodes, flatGraph.edges) : flatGraph;
  const handledGraph = assignRankPreservingEdgeHandles(positionedGraph.nodes, positionedGraph.edges, {
    isHandleNode: isExecutableFlowNode
  });
  return applyGraphLayering(handledGraph.nodes, handledGraph.edges);
}

function applyGraphLayering(
  nodes: DashboardGraphNode[],
  edges: DashboardEdge[]
): { nodes: DashboardGraphNode[]; edges: DashboardEdge[] } {
  return {
    nodes: nodes.map((node): DashboardGraphNode => {
      if (node.type === "phaseGroup") {
        return { ...node, zIndex: phaseGroupZIndex };
      }
      return { ...node, zIndex: executableNodeZIndex };
    }),
    edges: edges.map((edge): DashboardEdge => ({ ...edge, zIndex: dependencyEdgeZIndex }))
  };
}

function annotateTopologyConnectionState(
  nodes: DashboardGraphNode[],
  topologyEditable: boolean,
  connectionSourceNodeId: string | null,
  selectedNodeId: string | null,
  validationNodes: EdgeEndpointValidationNode[],
  topologyNodeIds: Set<string>
): DashboardGraphNode[] {
  return nodes.map((node) => {
    if (!isExecutableFlowNode(node)) {
      return node;
    }
    const endpoint = edgeEndpointForFlowNode(nodes, node.id, topologyNodeIds);
    const nodeTopologyEditable = topologyEditable && Boolean(endpoint);
    let connectionTargetValidity: FlowNodeData["connectionTargetValidity"] = null;
    if (connectionSourceNodeId && nodeTopologyEditable) {
      connectionTargetValidity = isValidTopologyConnectionCandidate(
        nodes,
        {
          source: connectionSourceNodeId,
          target: node.id
        },
        validationNodes,
        topologyNodeIds
      )
        ? "valid"
        : "invalid";
    }
    return {
      ...node,
      selected: node.id === selectedNodeId,
      data: {
        ...node.data,
        topologyEditable: nodeTopologyEditable,
        connectionSourceNodeId,
        connectionTargetValidity
      }
    };
  });
}

function applyPhaseGrouping(
  nodes: DashboardFlowNode[],
  edges: DashboardEdge[]
): { nodes: DashboardGraphNode[]; edges: DashboardEdge[] } {
  const phaseByNodeId = new Map<string, WorkflowPhaseId>();
  const nodesByPhase = new Map<WorkflowPhaseId, DashboardFlowNode[]>();
  const metaNodes: DashboardFlowNode[] = [];
  const taskNodes: DashboardFlowNode[] = [];

  nodes.forEach((node) => {
    if (isMetaFlowNode(node)) {
      metaNodes.push(node);
      return;
    }
    taskNodes.push(node);
    const phase = phaseForNode(node);
    phaseByNodeId.set(node.id, phase);
    const phaseNodes = nodesByPhase.get(phase) ?? [];
    phaseNodes.push(node);
    nodesByPhase.set(phase, phaseNodes);
  });

  const groupedNodeIds = new Set<string>();
  const phaseNodes: DashboardPhaseNode[] = [];
  const childNodesById = new Map<string, DashboardFlowNode>();
  const dimensionsByPhase = new Map<WorkflowPhaseId, PhaseDimensions>();

  for (const phase of [...workflowPhases, ungroupedPhase]) {
    const members = nodesByPhase.get(phase.id) ?? [];
    if (!members.length) {
      continue;
    }
    dimensionsByPhase.set(phase.id, phaseDimensions(phase.id, phaseLayoutMembers(phase.id, members)));
  }

  const groupPositions = phaseGroupPositions(dimensionsByPhase);

  for (const phase of [...workflowPhases, ungroupedPhase]) {
    const members = nodesByPhase.get(phase.id) ?? [];
    const dimensions = dimensionsByPhase.get(phase.id);
    const groupPosition = groupPositions.get(phase.id);
    if (!members.length || !dimensions || !groupPosition) {
      continue;
    }

    const groupId = phaseGroupId(phase.id);

    phaseNodes.push({
      id: groupId,
      type: "phaseGroup",
      position: groupPosition,
      data: {
        label: phase.label,
        memberCount: members.length,
        phase: phase.id,
        propertyCount: phase.id === "properties" ? finalizedPropertyCount(members) : undefined
      },
      draggable: false,
      selectable: false,
      deletable: false,
      style: {
        height: dimensions.height,
        width: dimensions.width
      }
    });

    members.forEach((node) => {
      const position = dimensions.positions.get(node.id) ?? node.position;
      groupedNodeIds.add(node.id);
      childNodesById.set(node.id, {
        ...node,
        parentId: groupId,
        extent: "parent",
        draggable: false,
        position
      });
    });
  }

  const childNodes = taskNodes.map((node) => childNodesById.get(node.id) ?? node);
  const positionedMetaNodes = positionMetaNodes(metaNodes, groupPositions, dimensionsByPhase);
  const groupedEdges = edges.map((edge): DashboardEdge => {
    const sourcePhase = phaseByNodeId.get(edge.source);
    const targetPhase = phaseByNodeId.get(edge.target);
    const intraPhase = Boolean(sourcePhase && sourcePhase === targetPhase);
    return {
      ...edge,
      className: `dependency-edge ${intraPhase ? "dependency-edge--intra-phase" : "dependency-edge--cross-phase"}`,
      style: {
        ...edge.style,
        opacity: intraPhase ? 0.56 : 0.94,
        strokeWidth: intraPhase ? 1.35 : 2
      }
    };
  });

  return {
    nodes: [
      ...phaseNodes,
      ...childNodes.filter((node) => groupedNodeIds.has(node.id) || phaseByNodeId.has(node.id)),
      ...positionedMetaNodes
    ],
    edges: groupedEdges
  };
}

function positionMetaNodes(
  metaNodes: DashboardFlowNode[],
  groupPositions: Map<WorkflowPhaseId, { x: number; y: number }>,
  dimensionsByPhase: Map<WorkflowPhaseId, PhaseDimensions>
): DashboardFlowNode[] {
  const bounds = [...groupPositions.entries()]
    .map(([phase, position]) => {
      const dimensions = dimensionsByPhase.get(phase);
      return dimensions
        ? {
            minX: position.x,
            maxX: position.x + dimensions.width,
            minY: position.y,
            maxY: position.y + dimensions.height
          }
        : null;
    })
    .filter((bound): bound is { minX: number; maxX: number; minY: number; maxY: number } => Boolean(bound));

  if (!bounds.length) {
    return metaNodes;
  }

  const minX = Math.min(...bounds.map((bound) => bound.minX));
  const maxX = Math.max(...bounds.map((bound) => bound.maxX));
  const minY = Math.min(...bounds.map((bound) => bound.minY));
  const maxY = Math.max(...bounds.map((bound) => bound.maxY));
  const y = minY + (maxY - minY) / 2 - metaNodeHeight / 2;

  return metaNodes.map((node) => {
    const x = isStartMetaNode(node) ? minX - metaNodeWidth - metaNodeGap : maxX + metaNodeGap;
    return {
      ...node,
      draggable: false,
      position: { x, y }
    };
  });
}

function phaseLayoutMembers(phase: WorkflowPhaseId, members: DashboardFlowNode[]): PhaseLayoutMember[] {
  return members.map((node) => ({
    dependencies: node.data.dependencies,
    id: node.id,
    position: node.position,
    sortValue: phaseMemberSortValue(phase, node)
  }));
}

function phaseMemberSortValue(phase: WorkflowPhaseId, node: DashboardFlowNode): number {
  if (phase === "setup") {
    switch (node.type) {
      case "projectDiscovery":
        return 0;
      case "foundryHarness":
        return 1;
      case "baseTestDiscovery":
        return 2;
      default:
        return 10;
    }
  }
  if (phase === "invariants") {
    const strategyId = node.data.strategy?.id ?? node.data.logicalNodeId ?? node.data.kind;
    if (strategyId.includes("setup")) {
      return 0;
    }
    if (strategyId.includes("handlers")) {
      return 1;
    }
    if (strategyId.includes("coverage")) {
      return 2;
    }
    return 10;
  }
  if (phase === "report") {
    if (node.type === "testAggregation") {
      return 0;
    }
    if (node.type === "report") {
      return 1;
    }
  }
  return 0;
}

function finalizedPropertyCount(members: DashboardFlowNode[]): number {
  const finalizedNodes = members.filter((node) => node.data.propertySummary?.kind === "properties");
  return (
    (
      finalizedNodes.find(isPropertySpecificationFanInNode) ??
      finalizedNodes.find(isDirectPropertySpecificationNode) ??
      finalizedNodes[0]
    )?.data.propertySummary?.count ?? 0
  );
}

function isPropertySpecificationFanInNode(node: DashboardFlowNode): boolean {
  return node.type === "propertySpecificationFanIn" || node.data.logicalNodeId === "property-specification-fanin";
}

function isDirectPropertySpecificationNode(node: DashboardFlowNode): boolean {
  return node.type === "propertySpecification" || node.data.logicalNodeId === "property-specification";
}

function phaseGroupId(phase: WorkflowPhaseId): string {
  return `phase:${phase}`;
}

function collapseStrategyNodes(
  nodes: DashboardFlowNode[],
  edges: DashboardEdge[]
): { nodes: DashboardFlowNode[]; edges: DashboardEdge[] } {
  const loopedByLogicalId = new Map<string, DashboardFlowNode[]>();
  nodes.forEach((node) => {
    if (node.data.loopCount <= 1 || node.id === node.data.logicalNodeId) {
      return;
    }
    const attempts = loopedByLogicalId.get(node.data.logicalNodeId) ?? [];
    attempts.push(node);
    loopedByLogicalId.set(node.data.logicalNodeId, attempts);
  });
  if (loopedByLogicalId.size) {
    const nodeIdMap = new Map<string, string>();
    const logicalNodes: DashboardFlowNode[] = [];
    loopedByLogicalId.forEach((attempts, logicalNodeId) => {
      const orderedAttempts = [...attempts].sort((left, right) => left.data.attemptIndex - right.data.attemptIndex);
      const representative = orderedAttempts[0];
      orderedAttempts.forEach((node) => nodeIdMap.set(node.id, logicalNodeId));
      logicalNodes.push({
        ...representative,
        id: logicalNodeId,
        data: {
          ...representative.data,
          label: titleCaseLabel(logicalNodeId),
          kind: representative.data.logicalNodeId,
          status: combinedNodeStatus(orderedAttempts),
          dependencies: [],
          artifactDir: `${orderedAttempts.length} attempts`,
          artifacts: mergeArtifactAvailability(orderedAttempts),
          findingCount: orderedAttempts.reduce((total, node) => total + node.data.findingCount, 0),
          propertySummary: mergePropertySummary(orderedAttempts),
          latestError: orderedAttempts.find((node) => node.data.latestError)?.data.latestError,
          incomingHandles: undefined,
          outgoingHandles: undefined
        }
      });
    });
    const visibleNodes = nodes.filter((node) => !nodeIdMap.has(node.id));
    const remappedEdges = remapCollapsedEdges(edges, nodeIdMap);
    const dependenciesByNode = dependenciesByTarget(remappedEdges);
    const nextNodes = [...visibleNodes, ...logicalNodes].map((node): DashboardFlowNode => ({
      ...node,
      data: {
        ...node.data,
        dependencies: [...(dependenciesByNode.get(node.id) ?? new Set<string>())]
      }
    }));
    return collapseStrategyNodes(nextNodes, remappedEdges);
  }

  const attemptsByStrategy = new Map<string, DashboardFlowNode[]>();
  const consolidationByStrategy = new Map<string, DashboardFlowNode>();
  nodes.forEach((node) => {
    const strategyId = node.data.strategy?.id;
    if (!strategyId) {
      return;
    }
    if (node.type === "agentAttempt") {
      const attempts = attemptsByStrategy.get(strategyId) ?? [];
      attempts.push(node);
      attemptsByStrategy.set(strategyId, attempts);
    }
    if (node.type === "strategyConsolidation") {
      consolidationByStrategy.set(strategyId, node);
    }
  });

  if (!attemptsByStrategy.size) {
    return { nodes, edges };
  }

  const nodeIdMap = new Map<string, string>();
  const strategyNodes: DashboardFlowNode[] = [];
  attemptsByStrategy.forEach((attempts, strategyId) => {
    const orderedAttempts = [...attempts].sort((left, right) => compareNodePosition(left.position, right.position));
    const representative = orderedAttempts[0];
    const consolidation = consolidationByStrategy.get(strategyId);
    const groupNodes = consolidation ? [...orderedAttempts, consolidation] : orderedAttempts;
    const aggregateId = `strategy:${strategyId}`;
    groupNodes.forEach((node) => nodeIdMap.set(node.id, aggregateId));
    const strategy = representative.data.strategy;
    strategyNodes.push({
      ...representative,
      id: aggregateId,
      type: "strategyAggregate",
      data: {
        ...representative.data,
        label: strategy?.display_name ?? representative.data.label,
        kind: "strategy",
        status: combinedNodeStatus(groupNodes),
        dependencies: [],
        artifactDir: `${orderedAttempts.length} ${orderedAttempts.length === 1 ? "attempt" : "attempts"}`,
        artifacts: mergeArtifactAvailability(groupNodes),
        promptAvailable: Boolean(strategy),
        promptEditable: groupNodes.some((node) => node.data.promptEditable),
        findingCount: groupNodes.reduce((total, node) => total + node.data.findingCount, 0),
        propertySummary: mergePropertySummary(groupNodes),
        latestError: groupNodes.find((node) => node.data.latestError)?.data.latestError,
        incomingHandles: undefined,
        outgoingHandles: undefined
      }
    });
  });

  const visibleNodes = nodes.filter((node) => !nodeIdMap.has(node.id));
  const nextNodes = [...visibleNodes, ...strategyNodes];
  const nextEdges = remapCollapsedEdges(edges, nodeIdMap);
  const dependenciesByNode = dependenciesByTarget(nextEdges);

  return {
    nodes: nextNodes.map((node): DashboardFlowNode => ({
      ...node,
      data: {
        ...node.data,
        dependencies: [...(dependenciesByNode.get(node.id) ?? new Set<string>())]
      }
    })),
    edges: nextEdges
  };
}

function remapCollapsedEdges(edges: DashboardEdge[], nodeIdMap: Map<string, string>): DashboardEdge[] {
  const usedEdgeIds = new Set<string>();
  const usedEdgePairs = new Set<string>();
  const nextEdges: DashboardEdge[] = [];
  edges.forEach((edge, index) => {
    const source = nodeIdMap.get(edge.source) ?? edge.source;
    const target = nodeIdMap.get(edge.target) ?? edge.target;
    if (source === target) {
      return;
    }
    const pair = `${source}->${target}`;
    if (usedEdgePairs.has(pair)) {
      return;
    }
    usedEdgePairs.add(pair);
    const id = usedEdgeIds.has(edge.id) ? `${edge.id}:${source}->${target}:${index}` : edge.id;
    usedEdgeIds.add(id);
    nextEdges.push({
      ...edge,
      id,
      source,
      target
    });
  });
  return nextEdges;
}

function dependenciesByTarget(edges: DashboardEdge[]): Map<string, Set<string>> {
  const dependenciesByNode = new Map<string, Set<string>>();
  edges.forEach((edge) => {
    const dependencies = dependenciesByNode.get(edge.target) ?? new Set<string>();
    dependencies.add(edge.source);
    dependenciesByNode.set(edge.target, dependencies);
  });
  return dependenciesByNode;
}

function compactGraphPositions(nodes: DashboardFlowNode[]): DashboardFlowNode[] {
  const columnGap = 300;
  const rowGap = 150;
  const columns = [...new Set(nodes.map((node) => node.position.x))].sort((left, right) => left - right);
  const compactX = new Map(columns.map((x, index) => [x, index * columnGap]));
  const rowsByColumn = new Map<number, DashboardFlowNode[]>();
  nodes.forEach((node) => {
    const column = node.position.x;
    const rows = rowsByColumn.get(column) ?? [];
    rows.push(node);
    rowsByColumn.set(column, rows);
  });

  const compactY = new Map<string, number>();
  rowsByColumn.forEach((columnNodes) => {
    [...columnNodes]
      .sort((left, right) => compareNodePosition(left.position, right.position))
      .forEach((node, index) => compactY.set(node.id, index * rowGap));
  });

  const invariantLaneY = nodes
    .filter((node) => node.data.strategy?.id.startsWith("stateful-invariant-"))
    .map((node) => compactY.get(node.id))
    .find((value): value is number => value !== undefined && value > 0);
  if (invariantLaneY !== undefined) {
    nodes
      .filter((node) => node.data.strategy?.id.startsWith("stateful-invariant-"))
      .forEach((node) => compactY.set(node.id, invariantLaneY));
  }

  return nodes.map((node): DashboardFlowNode => ({
    ...node,
    position: {
      x: compactX.get(node.position.x) ?? node.position.x,
      y: compactY.get(node.id) ?? node.position.y
    }
  }));
}

function mergeArtifactAvailability(nodes: DashboardFlowNode[]): ArtifactAvailability {
  return nodes.reduce<ArtifactAvailability>(
    (merged, node) => {
      Object.entries(node.data.artifacts).forEach(([key, value]) => {
        const artifactKey = key as keyof ArtifactAvailability;
        merged[artifactKey] = Boolean(merged[artifactKey] || value);
      });
      return merged;
    },
    {
      logs: false,
      renderedPrompt: false,
      findings: false,
      patch: false,
      report: false,
      metadata: false,
      transcript: false
    }
  );
}

function mergePropertySummary(nodes: DashboardFlowNode[]): PropertySummary | null {
  const summaries = nodes
    .map((node) => node.data.propertySummary)
    .filter((summary): summary is PropertySummary => Boolean(summary));
  if (!summaries.length) {
    return null;
  }
  const finalized = summaries.filter((summary) => summary.kind === "properties");
  if (finalized.length) {
    return {
      count: finalized.reduce((total, summary) => total + summary.count, 0),
      kind: "properties"
    };
  }
  return {
    count: summaries.reduce((total, summary) => total + summary.count, 0),
    kind: "candidates"
  };
}

function combinedNodeStatus(nodes: DashboardFlowNode[]): Status {
  const statuses = nodes.map((node) => node.data.status);
  for (const status of ["failed", "timed-out", "invalidated", "running", "queued", "ready"]) {
    if (statuses.includes(status)) {
      return status;
    }
  }
  if (statuses.every((status) => status === "succeeded" || status === "reused-from-prior-run")) {
    return "succeeded";
  }
  if (statuses.every((status) => status === "pending")) {
    return "pending";
  }
  return statuses[0] ?? "unknown";
}

function dependencyEdges(edges: DashboardEdge[], nodes: DashboardFlowNode[]): DashboardEdge[] {
  const visibleNodeIds = new Set(nodes.map((node) => node.id));
  return edges
    .filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target))
    .map((edge): DashboardEdge => {
      const status = edge.data?.status ?? "unknown";
      const stroke = edgeColorForStatus(status);
      return {
        ...edge,
        type: "smoothstep",
        label: undefined,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: stroke,
          width: 14,
          height: 14
        },
        data: {
          ...edge.data,
          status
        },
        style: {
          ...edge.style,
          stroke,
          strokeWidth: 1.8
        }
      };
    });
}

function compareNodePosition(
  left: { x: number; y: number } | undefined,
  right: { x: number; y: number } | undefined
): number {
  if (!left || !right) {
    return left ? -1 : right ? 1 : 0;
  }
  if (left.y !== right.y) {
    return left.y - right.y;
  }
  return left.x - right.x;
}

function handleOffset(index: number, count: number): string {
  return `${((index + 1) / (count + 1)) * 100}%`;
}

function isStrategyAggregateNode(node: DashboardFlowNode): boolean {
  return node.type === "strategyAggregate";
}

function isPhaseGroupNode(node: Node | undefined): node is DashboardPhaseNode {
  return node?.type === "phaseGroup";
}

function isExecutableFlowNode(node: DashboardGraphNode | Node | undefined): node is DashboardFlowNode {
  return Boolean(node && !isPhaseGroupNode(node));
}

function miniMapNodeFill(node: Node): string {
  if (isPhaseGroupNode(node)) {
    return "rgba(216, 218, 221, 0.34)";
  }
  if (node.type === "metaStart") {
    return "#f0f9f4";
  }
  if (node.type === "metaFinish") {
    return "#f3f6ff";
  }
  return "var(--mds-surface-raised)";
}

function miniMapNodeStroke(node: Node): string {
  if (isPhaseGroupNode(node)) {
    return "var(--mds-border-strong)";
  }
  if (node.type === "metaStart" || node.type === "metaFinish") {
    return "var(--mds-border-strong)";
  }
  const flowNode = node as DashboardFlowNode;
  return edgeColorForStatus(flowNode.data?.status ?? "unknown");
}

function edgeColorForStatus(status: Status): string {
  switch (statusTone(status)) {
    case "success":
      return "var(--mds-status-success)";
    case "error":
      return "var(--mds-status-error)";
    case "info":
      return "var(--mds-status-info)";
    case "neutral":
    default:
      return "var(--mds-border-strong)";
  }
}

function capabilityForCommand(command: string): keyof CommandCapabilities | null {
  switch (command) {
    case "validate":
      return "validate";
    case "ps":
      return "listRuns";
    case "run":
      return "runNewCampaign";
    case "inspect":
      return "inspect";
    case "resume":
      return "resume";
    case "replay":
      return "replay";
    case "fork":
      return "fork";
    case "config":
      return "config";
    case "report":
      return "report";
    case "references-status":
      return "referencesStatus";
    case "references-sync":
      return "referencesSync";
    case "references-update":
      return "referencesUpdate";
    case "materialize":
      return "materialize";
    case "clean":
      return "clean";
    default:
      return null;
  }
}

function phaseForNode(node: DashboardFlowNode): WorkflowPhaseId {
  switch (node.type) {
    case "projectDiscovery":
    case "foundryHarness":
    case "baseTestDiscovery":
      return "setup";
    case "reference":
      return "references";
    case "propertySpecificationLens":
    case "propertySpecificationFanIn":
    case "propertySpecification":
      return "properties";
    case "strategyAggregate":
    case "agentAttempt":
    case "strategyConsolidation":
      return isInvariantStrategy(node.data.strategy) ? "invariants" : phaseForNodeData(node.data);
    case "dedupe":
      return "deduplication";
    case "triage":
      return "triaging";
    case "testAggregation":
    case "report":
      return "report";
    default:
      return phaseForNodeData(node.data);
  }
}

function statusTone(status: Status): StatusTone {
  switch (status) {
    case "succeeded":
    case "reused-from-prior-run":
      return "success";
    case "failed":
    case "timed-out":
    case "invalidated":
      return "error";
    case "running":
    case "ready":
    case "queued":
      return "info";
    case "pending":
    case "skipped":
    case "unknown":
    default:
      return "neutral";
  }
}

function eventTone(event: EventRecord): StatusTone {
  const value = event.event_type.toLowerCase();
  if (value.includes("failed") || value.includes("error") || value.includes("timeout")) {
    return "error";
  }
  if (value.includes("succeeded") || value.includes("complete") || value.includes("finished")) {
    return "success";
  }
  if (value.includes("started") || value.includes("running") || value.includes("node")) {
    return "info";
  }
  return "neutral";
}

function nodeAvailabilityFlags(data: FlowNodeData): string[] {
  return availabilityFlags(data.artifacts).slice(0, 4);
}

function availabilityFlags(artifacts: ArtifactAvailability): string[] {
  const flags: string[] = [];
  if (artifacts.logs) {
    flags.push("logs");
  }
  if (artifacts.findings) {
    flags.push("findings");
  }
  if (artifacts.patch) {
    flags.push("patch");
  }
  if (artifacts.report) {
    flags.push("report");
  }
  if (artifacts.metadata) {
    flags.push("metadata");
  }
  if (artifacts.transcript) {
    flags.push("transcript");
  }
  return flags;
}

function liveStateLabel(state: LiveState): string {
  switch (state) {
    case "loading":
      return "Loading";
    case "off":
      return "Off";
    case "connecting":
      return "Connecting";
    case "live":
      return "Live";
    case "degraded":
      return "Degraded";
    case "disconnected":
      return "Disconnected";
  }
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function timeoutFactLabel(seconds: number | undefined): string | null {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return `timeout ${formatTimeoutDuration(seconds)}`;
}

function formatTimeoutDuration(seconds: number): string {
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  const units = ["KB", "MB", "GB"];
  let nextValue = value / 1024;
  for (const unit of units) {
    if (nextValue < 1024) {
      return `${nextValue.toFixed(nextValue >= 10 ? 0 : 1)} ${unit}`;
    }
    nextValue /= 1024;
  }
  return `${nextValue.toFixed(1)} TB`;
}

function timeLabel(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function unixTimeLabel(seconds: number): string {
  return timeLabel(new Date(seconds * 1000).toISOString());
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function cssSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "unknown";
}

createRoot(document.getElementById("root")!).render(<App />);
