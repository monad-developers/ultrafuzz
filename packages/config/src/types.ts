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

export interface ResolvedConfig {
  schemaVersion: string;
  dynamicStrategiesEnumerator: number;
  project: ProjectConfig;
  run: RunConfig;
  models: ModelsConfig;
  permissions: PermissionConfig;
  invariants: InvariantConfig;
  triage: TriageConfig;
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
  permissions?: Partial<PermissionConfig>;
  invariants?: Partial<InvariantConfig>;
  triage?: Partial<TriageConfig>;
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
