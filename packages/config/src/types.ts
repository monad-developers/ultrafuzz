export type DiagnosticSeverity = "error" | "warning";

export type ConfigDiagnosticSource =
  "defaults" | "prompt-metadata" | "project-toml" | "environment" | "runtime" | "validation" | "redaction";

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
  workspaceMode: WorkspaceMode;
  defaultTimeoutSeconds: number;
}

export interface ModelProfile {
  id: string;
  agent: string;
  model?: string;
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
  invariantTestingFuzzerTimeoutSeconds: number;
}

export interface TriageConfig {
  quorum: number;
  panelSize: number;
}

export interface EvalProviderProfile {
  apiKeyEnv?: string;
  workspaceIdEnv?: string;
  project?: string;
  endpoint?: string;
}

export interface EvalConfig {
  /** Path to the committable eval suite YAML used when `--suite` is omitted. */
  evalConfig?: string;
  /** Machine-specific root for ground-truth files; must resolve outside the repository. */
  groundTruthRoot?: string;
  /** Active reporter binding: `braintrust`, `langsmith`, `none`, or any configured profile name. */
  provider: string;
  /** Connection profiles keyed by provider name; values are env-var NAMES, never secrets. */
  providers: Record<string, EvalProviderProfile>;
}

export interface ResolvedConfig {
  schemaVersion: string;
  dynamicStrategiesEnumerator: number;
  project: ProjectConfig;
  run: RunConfig;
  models: ModelsConfig;
  agents: Record<string, AgentConfig>;
  permissions: PermissionConfig;
  invariants: InvariantConfig;
  triage: TriageConfig;
  eval: EvalConfig;
}

export interface PromptMetadataLayer {
  models?: Record<string, Partial<ModelProfile> & { id?: string }>;
  run?: Partial<RunConfig>;
}

export interface ProjectConfigInput {
  schemaVersion?: string;
  dynamicStrategiesEnumerator?: number;
  project?: Partial<ProjectConfig>;
  run?: Partial<RunConfig>;
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
