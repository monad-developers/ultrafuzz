import type { AuditProfileSettings } from "./audit-profiles.js";

export type DiagnosticSeverity = "error" | "warning";

export type ConfigDiagnosticSource =
  | "defaults"
  | "audit-profile"
  | "prompt-metadata"
  | "project-toml"
  | "environment"
  | "runtime"
  | "validation"
  | "redaction";

export interface ConfigDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  path: string[];
  source: ConfigDiagnosticSource;
  location?: {
    file?: string;
    line?: number;
    column?: number;
  };
}

export type ConfigResult<T> =
  | {
      ok: true;
      value: T;
      diagnostics: ConfigDiagnostic[];
    }
  | {
      ok: false;
      diagnostics: ConfigDiagnostic[];
    };

export function ok<T>(value: T, diagnostics: ConfigDiagnostic[] = []): ConfigResult<T> {
  return { ok: true, value, diagnostics };
}

export function fail<T = never>(diagnostics: ConfigDiagnostic[]): ConfigResult<T> {
  return { ok: false, diagnostics };
}

export function diagnostic(
  code: string,
  message: string,
  path: string[],
  source: ConfigDiagnosticSource,
  location?: ConfigDiagnostic["location"]
): ConfigDiagnostic {
  return {
    code,
    severity: "error",
    message,
    path,
    source,
    ...(location ? { location } : {})
  };
}

export function hasErrors(diagnostics: ConfigDiagnostic[]): boolean {
  return diagnostics.some((entry) => entry.severity === "error");
}

export type WorkspaceMode = "git-worktree";

export type TrustModel = "skip-permissions";

export type AgentAuthMode = "api-key" | "subscription";

export interface ProjectConfig {
  repo: string;
  name?: string;
}

export interface RunConfig {
  outputDir: string;
  maxParallelAgents: number;
  maxParallelNodes: number;
  keepWorkspaces: boolean;
  forgeGuardEnabled: boolean;
  forgeVmemLimitKb: number;
  forgeRayonThreads: number;
  workspaceMode: WorkspaceMode;
  defaultTimeoutSeconds: number;
  workflowDeadlineSeconds: number;
  controllerLeaseSeconds: number;
}

export type ExecutionMode = "local" | "cloud";

export type CloudExecutionProvider = "modal";

export interface ExecutionResources {
  cpu: number;
  memoryMiB: number;
  timeoutSeconds: number;
}

export interface ExecutionNodeOverride {
  resources: Partial<ExecutionResources>;
}

export interface ModalExecutionProviderConfig {
  app: string;
  image: string;
  region?: string;
  /** Environment-variable names only. Credential values never enter resolved config. */
  credentialEnv: string[];
}

export interface ExecutionConfig {
  mode: ExecutionMode;
  provider?: CloudExecutionProvider;
  retentionDays: number;
  resources: ExecutionResources;
  nodes: Record<string, ExecutionNodeOverride>;
  providers: {
    modal?: ModalExecutionProviderConfig;
  };
}

export interface ModelProfile {
  id: string;
  agent: string;
  model?: string;
  reasoning?: string;
  timeoutSeconds?: number;
}

export interface ModelsConfig {
  default: string;
  synthesizedDefault: boolean;
  profiles: Record<string, ModelProfile>;
}

export interface AgentConfig {
  auth: AgentAuthMode;
  apiKeyEnv?: string;
  configDir?: string;
}

export interface PermissionConfig {
  trustModel: TrustModel;
  promptReviewRequired: boolean;
  materializeOutputsAsUnstaged: boolean;
}

export interface InvariantConfig {
  propertyPriorityThreshold: "high" | "medium" | "low";
  invariantTestingSmokeTimeoutSeconds: number;
  invariantTestingFuzzerTimeoutSeconds: number;
  /**
   * How the property-lens provenance gate treats a reference expectation absent from a supplied
   * catalogue (issue #285). `warn` strips it and reports a warning; `fail` leaves the lens bytes
   * intact and fails the node. Omitted means `warn`, and it stays `warn` until a smoke lane has
   * been observed on a run that actually supplies a catalogue.
   */
  referenceExpectationEnforcement?: "warn" | "fail";
}

export interface TriageConfig {
  quorum: number;
  panelSize: number;
}

export interface EvalProviderProfile {
  /** Built-in providers require their canonical API-key environment variable name. */
  apiKeyEnv?: string;
  project?: string;
  endpoint?: string;
}

export interface EvalConfig {
  /** Path to the committable eval suite YAML used when `--suite` is omitted. */
  evalConfig?: string;
  /** Machine-specific root for ground-truth files; must resolve outside the repository. */
  groundTruthRoot?: string;
  /** Active reporter binding: `braintrust` or `none`. */
  provider: string;
  /** Connection profiles keyed by provider name; values are env-var NAMES, never secrets. */
  providers: Record<string, EvalProviderProfile>;
}

export interface ResolvedConfig {
  schemaVersion: string;
  auditProfile: string;
  topologyPath?: string;
  strategyLoops?: number;
  auditProfileResolution: AuditProfileResolution;
  dynamicStrategiesEnumerator: number;
  project: ProjectConfig;
  run: RunConfig;
  execution: ExecutionConfig;
  models: ModelsConfig;
  agents: Record<string, AgentConfig>;
  permissions: PermissionConfig;
  invariants: InvariantConfig;
  triage: TriageConfig;
  eval: EvalConfig;
}

export interface AuditProfileResolution {
  catalogSchemaVersion: number;
  catalogDigest: string;
  declaredTopologyPath?: string;
  settings: AuditProfileSettings;
  effectiveSettings: AuditProfileSettings;
  settingOrigins: Record<string, AuditProfileSettingOrigin>;
  overriddenSettings: string[];
}

export type AuditProfileSettingOrigin =
  "default" | "audit-profile" | "project-config" | "environment" | "runtime-override";

export interface PromptMetadataLayer {
  models?: Record<string, Partial<ModelProfile> & { id?: string }>;
  run?: Partial<RunConfig>;
}

export interface ProjectConfigInput {
  schemaVersion?: string;
  auditProfile?: string;
  topologyPath?: string;
  strategyLoops?: number;
  dynamicStrategiesEnumerator?: number;
  project?: Partial<ProjectConfig>;
  run?: Partial<RunConfig>;
  execution?: ExecutionConfigInput;
  models?: {
    default?: string;
    synthesizedDefault?: boolean;
    profiles?: Record<string, Partial<ModelProfile> & { id?: string }>;
  };
  agents?: Record<string, Partial<AgentConfig>>;
  permissions?: Partial<PermissionConfig>;
  invariants?: Partial<InvariantConfig>;
  triage?: Partial<TriageConfig>;
  eval?: EvalConfigInput;
}

export interface ExecutionConfigInput {
  mode?: ExecutionMode;
  provider?: CloudExecutionProvider;
  retentionDays?: number;
  resources?: Partial<ExecutionResources>;
  nodes?: Record<string, { resources?: Partial<ExecutionResources> }>;
  providers?: {
    modal?: Partial<ModalExecutionProviderConfig>;
  };
}

export interface EvalConfigInput {
  evalConfig?: string;
  groundTruthRoot?: string;
  provider?: string;
  providers?: Record<string, Partial<EvalProviderProfile>>;
}

export interface LoadedProjectConfig {
  path: string;
  exists: boolean;
  config: ProjectConfigInput;
}

export interface RuntimeConfigOverrides extends ProjectConfigInput {
  triageQuorum?: number;
  triagePanelSize?: number;
  maxParallelAgents?: number;
  maxParallelNodes?: number;
  outputDir?: string;
  keepWorkspaces?: boolean;
}

export interface ResolveConfigInput {
  projectConfig?: ProjectConfigInput;
  promptMetadata?: PromptMetadataLayer;
  env?: Record<string, string | undefined>;
  runtimeOverrides?: RuntimeConfigOverrides;
}
