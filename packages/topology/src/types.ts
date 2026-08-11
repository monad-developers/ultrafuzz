import type { ArtifactContractId } from "@ultrafuzz/artifacts";

export const TOPOLOGY_VERSION = 2 as const;
export const GRAPH_VERSION = "2" as const;
export const PROJECT_TOPOLOGY_FILE = ".ultrafuzz/topology.yml";
export const PROJECT_PROMPT_DIR = ".ultrafuzz/prompts";
export const START_NODE_ID = "__start__";
export const FINISH_NODE_ID = "__finish__";
export const MAX_LOOPS = 256;
export const MAX_TOPOLOGY_NODES = 4096;
export const MAX_EXPANDED_TOPOLOGY_NODES = 4096;

export const TOPOLOGY_NODE_KINDS = ["agentic", "meta", "reference"] as const;
export type TopologyNodeKind = (typeof TOPOLOGY_NODE_KINDS)[number];

export const META_NODE_ROLES = ["start", "finish"] as const;
export type MetaNodeRole = (typeof META_NODE_ROLES)[number];

export const LOOP_MODES = ["parallel", "series"] as const;
export type LoopMode = (typeof LOOP_MODES)[number];

export interface TopologyDefaults {
  strategy_loops: number;
}

export interface TopologyGroupDefaults {
  loops?: number;
  timeout_seconds?: number;
  max_attempts?: number;
  model_profiles?: string[];
}

export interface TopologyGroup {
  label?: string;
  color?: string;
  defaults?: TopologyGroupDefaults;
}

export interface TopologyNode {
  id: string;
  kind?: TopologyNodeKind;
  role?: MetaNodeRole;
  prompt?: string;
  reference?: string;
  group?: string;
  depends_on: string[];
  loops?: number;
  loop_mode?: LoopMode;
  timeout_seconds?: number;
  max_attempts?: number;
  outputs?: TopologyArtifactOutput[];
  model_profiles?: string[];
  /** Executables that must be available before this node's workflow can launch. */
  required_commands?: string[];
}

export interface TopologyArtifactOutput {
  path: string;
  contract: ArtifactContractId;
  primary?: boolean;
}

export interface ProjectTopology {
  version: number;
  defaults: TopologyDefaults;
  groups?: Record<string, TopologyGroup>;
  nodes: TopologyNode[];
}

export interface NormalizedTopologyNode {
  id: string;
  kind: TopologyNodeKind;
  role?: MetaNodeRole;
  prompt?: string;
  reference?: string;
  group?: string;
  depends_on: string[];
  loops: number;
  explicit_loops: boolean;
  loop_mode: LoopMode;
  timeout_seconds?: number;
  max_attempts?: number;
  outputs: NormalizedArtifactOutput[];
  model_profiles: string[];
  required_commands: string[];
}

export interface NormalizedArtifactOutput {
  path: string;
  contract: ArtifactContractId;
  primary: boolean;
}

export interface NormalizedProjectTopology {
  version: typeof TOPOLOGY_VERSION;
  defaults: TopologyDefaults;
  groups: Record<string, TopologyGroup>;
  nodes: NormalizedTopologyNode[];
}

export interface ModelProfileSelection {
  profileId: string;
  agentRef: string;
  modelName?: string;
  reasoningEffort?: string;
  timeoutSeconds?: number;
}

export interface ModelFanoutProvenance {
  modelProfileId: string;
  agentRef: string;
  modelName?: string;
  reasoningEffort?: string;
  timeoutSeconds?: number;
  modelIndex: number;
  loopIndex: number;
  attemptIndex: number;
}

export interface ExpandedGraph {
  graphVersion: typeof GRAPH_VERSION;
  runId?: string;
  topologyVersion: typeof TOPOLOGY_VERSION;
  groups: Record<string, TopologyGroup>;
  nodes: ExpandedNode[];
  fingerprintInputs?: FingerprintInputs;
}

export interface FingerprintInputs {
  config?: unknown;
  promptDigests?: Record<string, string>;
}

export interface ExpandedNode {
  id: string;
  logicalId: string;
  label: string;
  kind: TopologyNodeKind;
  role?: MetaNodeRole;
  promptPath?: string;
  reference?: string;
  referenceRevision?: ReferenceRevision;
  group?: string;
  dependsOn: string[];
  requiredCommands?: string[];
  artifactDir: string;
  timeoutSeconds?: number;
  retryPolicy: RetryPolicy;
  loop: {
    index: number;
    count: number;
    mode: LoopMode;
    attemptIndex: number;
  };
  outputs: ExpandedArtifactOutput[];
  modelFanout: ModelFanoutProvenance[];
}

export interface ExpandedArtifactOutput extends NormalizedArtifactOutput {
  contractDigest: string;
}

export interface ReferenceRevision {
  provider: "github";
  repo: string;
  commit: string;
  paths: string[];
}

export interface RetryPolicy {
  maxAttempts: number;
}

export interface TopologyValidationOptions {
  projectRoot?: string;
  requirePromptFiles?: boolean;
  promptTexts?: Record<string, string>;
  limits?: Partial<TopologyLimits>;
}

export interface TopologyLimits {
  maxLoops: number;
  maxTopologyNodes: number;
  maxExpandedNodes: number;
}

export interface TopologyValidationResult {
  topology: NormalizedProjectTopology;
  effectiveLoopCounts: Record<string, number>;
}

export interface ExpandTopologyOptions extends TopologyValidationOptions {
  runId?: string;
  defaultTimeoutSeconds?: number;
  modelProfiles?: ModelProfileSelection[] | Record<string, Omit<ModelProfileSelection, "profileId">>;
  modelProfilesByNode?: Record<string, ModelProfileSelection[]>;
  defaultModelProfileId?: string;
  referenceCatalog?: {
    version: number;
    references: Record<string, { provider: "github"; repo: string; commit: string; paths: string[] }>;
  };
  configFingerprint?: unknown;
}
