import {
  DEFAULT_AGENT,
  DEFAULT_MODEL_PROFILE_ID,
  MAX_TIMEOUT_SECONDS,
  cloneResolvedConfig,
  createDefaultPromptMetadataLayer,
  createDefaultResolvedConfig
} from "./defaults.js";
import { syncDefaultModelProfile, validateModelProfiles, validProfileId } from "./model-profiles.js";
import { validateTriageConfig } from "./triage.js";
import {
  diagnostic,
  fail,
  hasErrors,
  ok,
  type ConfigDiagnostic,
  type ConfigResult,
  type PermissionConfig,
  type ProjectConfigInput,
  type PromptMetadataLayer,
  type ResolveConfigInput,
  type ResolvedConfig,
  type RuntimeConfigOverrides,
  type WorkspaceMode
} from "./types.js";

export function resolveConfig(input: ResolveConfigInput = {}): ConfigResult<ResolvedConfig> {
  const diagnostics: ConfigDiagnostic[] = [];
  const config = createDefaultResolvedConfig();

  applyPromptMetadataLayer(config, createDefaultPromptMetadataLayer(), diagnostics);
  if (input.promptMetadata) {
    applyPromptMetadataLayer(config, input.promptMetadata, diagnostics);
  }
  if (input.projectConfig) {
    applyProjectConfigLayer(config, input.projectConfig, diagnostics, "project-toml");
  }
  applyEnvironmentOverrides(config, input.env ?? process.env, diagnostics);
  if (input.runtimeOverrides) {
    applyRuntimeOverrides(config, input.runtimeOverrides, diagnostics);
  }

  syncDefaultModelProfile(config);
  sortConfig(config);
  diagnostics.push(...validateResolvedConfig(config));

  if (hasErrors(diagnostics)) {
    return fail(diagnostics);
  }
  return ok(config, diagnostics);
}

export function validateResolvedConfig(config: ResolvedConfig): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];

  if (config.schemaVersion.trim().length === 0) {
    diagnostics.push(
      diagnostic("CONFIG_SCHEMA_VERSION_EMPTY", "schema_version cannot be empty", ["schema_version"], "validation")
    );
  }
  pushPositiveIntegerDiagnostic(
    config.dynamicStrategiesEnumerator,
    ["dynamic_strategies_enumerator"],
    "dynamic_strategies_enumerator",
    diagnostics
  );
  pushProjectLocalPathDiagnostic(config.project.repo, ["project", "repo"], "project.repo", diagnostics);
  pushProjectLocalPathDiagnostic(config.run.outputDir, ["run", "output_dir"], "run.output_dir", diagnostics);
  pushPositiveIntegerDiagnostic(
    config.run.maxParallelAgents,
    ["run", "max_parallel_agents"],
    "run.max_parallel_agents",
    diagnostics
  );
  pushPositiveIntegerDiagnostic(
    config.run.maxParallelNodes,
    ["run", "max_parallel_nodes"],
    "run.max_parallel_nodes",
    diagnostics
  );
  pushTimeoutDiagnostic(
    config.run.defaultTimeoutSeconds,
    ["run", "default_timeout_seconds"],
    "run.default_timeout_seconds",
    diagnostics
  );
  if (!isWorkspaceMode(config.run.workspaceMode)) {
    diagnostics.push(
      diagnostic(
        "CONFIG_WORKSPACE_MODE_INVALID",
        `run.workspace_mode \`${String(config.run.workspaceMode)}\` is not supported`,
        ["run", "workspace_mode"],
        "validation"
      )
    );
  }
  if (!["high", "medium", "low"].includes(config.invariants.propertyPriorityThreshold)) {
    diagnostics.push(
      diagnostic(
        "CONFIG_INVARIANT_PRIORITY_INVALID",
        "invariants.property_priority_threshold must be high, medium, or low",
        ["invariants", "property_priority_threshold"],
        "validation"
      )
    );
  }
  pushTimeoutDiagnostic(
    config.invariants.invariantTestingFuzzerTimeoutSeconds,
    ["invariants", "invariant_testing_fuzzer_timeout"],
    "invariants.invariant_testing_fuzzer_timeout",
    diagnostics
  );

  if (config.permissions.trustModel !== "skip-permissions") {
    diagnostics.push(
      diagnostic(
        "CONFIG_TRUST_MODEL_INVALID",
        "permissions.trust_model must be skip-permissions",
        ["permissions", "trust_model"],
        "validation"
      )
    );
  }

  diagnostics.push(...validateTriageConfig(config.triage));
  diagnostics.push(...validateModelProfiles(config));
  return diagnostics;
}

export function serializeResolvedConfigToml(config: ResolvedConfig): string {
  const clone = cloneResolvedConfig(config);
  sortConfig(clone);
  const lines: string[] = [];

  pushAssignments(lines, {
    schema_version: clone.schemaVersion,
    dynamic_strategies_enumerator: clone.dynamicStrategiesEnumerator
  });
  pushTable(lines, "project", {
    repo: clone.project.repo,
    name: clone.project.name
  });
  pushTable(lines, "run", {
    output_dir: clone.run.outputDir,
    max_parallel_agents: clone.run.maxParallelAgents,
    max_parallel_nodes: clone.run.maxParallelNodes,
    keep_workspaces: clone.run.keepWorkspaces,
    workspace_mode: clone.run.workspaceMode,
    default_timeout_seconds: clone.run.defaultTimeoutSeconds
  });
  pushTable(lines, "models", {
    default: clone.models.default === DEFAULT_MODEL_PROFILE_ID ? undefined : clone.models.default,
    synthesized_default: clone.models.synthesizedDefault || undefined
  });
  for (const [id, profile] of Object.entries(clone.models.profiles)) {
    pushTable(lines, tableName(["models", id]), {
      agent: profile.agent,
      model: profile.model,
      timeout_seconds: profile.timeoutSeconds
    });
  }
  pushTable(lines, "permissions", {
    trust_model: clone.permissions.trustModel,
    prompt_review_required: clone.permissions.promptReviewRequired,
    materialize_outputs_as_unstaged: clone.permissions.materializeOutputsAsUnstaged
  });
  pushTable(lines, "invariants", {
    property_priority_threshold: clone.invariants.propertyPriorityThreshold,
    invariant_testing_fuzzer_timeout: formatDurationSeconds(clone.invariants.invariantTestingFuzzerTimeoutSeconds)
  });
  pushTable(lines, "triage", {
    quorum: clone.triage.quorum,
    panel_size: clone.triage.panelSize
  });
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

function applyPromptMetadataLayer(
  config: ResolvedConfig,
  layer: PromptMetadataLayer,
  diagnostics: ConfigDiagnostic[]
): void {
  if (layer.run) {
    applyRunConfig(config.run, layer.run);
  }
  if (layer.models) {
    for (const [id, profile] of Object.entries(layer.models).sort()) {
      if (!validProfileId(id)) {
        diagnostics.push(
          diagnostic(
            "CONFIG_MODEL_PROFILE_ID_INVALID",
            `model profile id \`${id}\` must use safe ASCII ID characters`,
            ["models", id],
            "prompt-metadata"
          )
        );
      }
      const existing = config.models.profiles[id];
      config.models.profiles[id] = {
        id,
        agent: profile.agent ?? existing?.agent ?? DEFAULT_AGENT,
        model: profile.model ?? existing?.model,
        timeoutSeconds: profile.timeoutSeconds ?? existing?.timeoutSeconds
      };
      if (id === DEFAULT_MODEL_PROFILE_ID) {
        config.models.synthesizedDefault = false;
      }
    }
  }
}

function applyProjectConfigLayer(
  config: ResolvedConfig,
  layer: ProjectConfigInput,
  diagnostics: ConfigDiagnostic[],
  source: "project-toml" | "runtime"
): void {
  if (layer.schemaVersion !== undefined) {
    config.schemaVersion = layer.schemaVersion;
  }
  if (layer.dynamicStrategiesEnumerator !== undefined) {
    config.dynamicStrategiesEnumerator = layer.dynamicStrategiesEnumerator;
  }
  if (layer.project) {
    config.project = { ...config.project, ...definedOnly(layer.project) };
  }
  if (layer.run) {
    applyRunConfig(config.run, layer.run);
  }
  syncDefaultModelProfile(config);
  if (layer.models) {
    if (layer.models.default !== undefined) {
      config.models.default = layer.models.default;
    }
    if (layer.models.synthesizedDefault !== undefined) {
      config.models.synthesizedDefault = layer.models.synthesizedDefault;
    }
    if (layer.models.profiles) {
      config.models.synthesizedDefault = false;
      for (const [id, profile] of Object.entries(layer.models.profiles).sort()) {
        if (!validProfileId(id)) {
          diagnostics.push(
            diagnostic(
              "CONFIG_MODEL_PROFILE_ID_INVALID",
              `model profile id \`${id}\` must use safe ASCII ID characters`,
              ["models", id],
              source
            )
          );
        }
        const existing = config.models.profiles[id];
        config.models.profiles[id] = {
          id,
          agent: profile.agent ?? existing?.agent ?? DEFAULT_AGENT,
          model: profile.model ?? existing?.model,
          timeoutSeconds: profile.timeoutSeconds ?? existing?.timeoutSeconds
        };
      }
    }
  }
  if (layer.permissions) {
    applyPermissionConfig(config.permissions, layer.permissions);
  }
  if (layer.invariants) {
    config.invariants = {
      ...config.invariants,
      ...definedOnly(layer.invariants)
    };
  }
  if (layer.triage) {
    config.triage = {
      ...config.triage,
      ...definedOnly(layer.triage)
    };
  }
}

function applyEnvironmentOverrides(
  config: ResolvedConfig,
  env: Record<string, string | undefined>,
  diagnostics: ConfigDiagnostic[]
): void {
  applyIntegerEnv(
    config,
    env,
    "ULTRAFUZZ_MAX_PARALLEL_AGENTS",
    ["run", "max_parallel_agents"],
    (value) => {
      config.run.maxParallelAgents = value;
    },
    diagnostics
  );
  applyIntegerEnv(
    config,
    env,
    "ULTRAFUZZ_MAX_PARALLEL_NODES",
    ["run", "max_parallel_nodes"],
    (value) => {
      config.run.maxParallelNodes = value;
    },
    diagnostics
  );
  if (env.ULTRAFUZZ_OUTPUT_DIR !== undefined) {
    config.run.outputDir = env.ULTRAFUZZ_OUTPUT_DIR;
  }
  if (env.ULTRAFUZZ_KEEP_WORKSPACES !== undefined) {
    const parsed = parseBoolean(env.ULTRAFUZZ_KEEP_WORKSPACES);
    if (parsed === undefined) {
      diagnostics.push(
        diagnostic(
          "CONFIG_ENV_BOOLEAN_INVALID",
          "ULTRAFUZZ_KEEP_WORKSPACES must be a boolean",
          ["env", "ULTRAFUZZ_KEEP_WORKSPACES"],
          "environment"
        )
      );
    } else {
      config.run.keepWorkspaces = parsed;
    }
  }
  syncDefaultModelProfile(config);
}

function applyRuntimeOverrides(
  config: ResolvedConfig,
  overrides: RuntimeConfigOverrides,
  diagnostics: ConfigDiagnostic[]
): void {
  applyProjectConfigLayer(config, overrides, diagnostics, "runtime");
  if (overrides.maxParallelAgents !== undefined) {
    config.run.maxParallelAgents = overrides.maxParallelAgents;
  }
  if (overrides.maxParallelNodes !== undefined) {
    config.run.maxParallelNodes = overrides.maxParallelNodes;
  }
  if (overrides.outputDir !== undefined) {
    config.run.outputDir = overrides.outputDir;
  }
  if (overrides.keepWorkspaces !== undefined) {
    config.run.keepWorkspaces = overrides.keepWorkspaces;
  }
  if (overrides.triageQuorum !== undefined) {
    config.triage.quorum = overrides.triageQuorum;
  }
  if (overrides.triagePanelSize !== undefined) {
    config.triage.panelSize = overrides.triagePanelSize;
  }
  syncDefaultModelProfile(config);
}

function applyRunConfig(target: ResolvedConfig["run"], source: Partial<ResolvedConfig["run"]>): void {
  Object.assign(target, definedOnly(source));
}

function applyPermissionConfig(target: PermissionConfig, source: Partial<PermissionConfig>): void {
  Object.assign(target, definedOnly(source));
}

function applyIntegerEnv(
  _config: ResolvedConfig,
  env: Record<string, string | undefined>,
  name: string,
  path: string[],
  apply: (value: number) => void,
  diagnostics: ConfigDiagnostic[]
): void {
  const value = env[name];
  if (value === undefined) {
    return;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    diagnostics.push(
      diagnostic("CONFIG_ENV_INTEGER_INVALID", `${name} must be a positive integer`, ["env", name], "environment")
    );
    return;
  }
  apply(parsed);
  void path;
}

function pushPositiveIntegerDiagnostic(
  value: number,
  path: string[],
  label: string,
  diagnostics: ConfigDiagnostic[]
): void {
  if (!Number.isInteger(value) || value <= 0) {
    diagnostics.push(
      diagnostic("CONFIG_POSITIVE_INTEGER_INVALID", `${label} must be greater than zero`, path, "validation")
    );
  }
}

function pushTimeoutDiagnostic(value: number, path: string[], label: string, diagnostics: ConfigDiagnostic[]): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_SECONDS) {
    diagnostics.push(
      diagnostic("CONFIG_TIMEOUT_INVALID", `${label} must be between 1 and ${MAX_TIMEOUT_SECONDS}`, path, "validation")
    );
  }
}

function pushProjectLocalPathDiagnostic(
  value: string,
  path: string[],
  label: string,
  diagnostics: ConfigDiagnostic[]
): void {
  if (value.length === 0) {
    diagnostics.push(diagnostic("CONFIG_PATH_EMPTY", `${label} cannot be empty`, path, "validation"));
    return;
  }
  if (value === ".") {
    return;
  }
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
    diagnostics.push(
      diagnostic("CONFIG_PATH_ABSOLUTE", `${label} must be a relative project-local path`, path, "validation")
    );
    return;
  }
  const parts = value.split(/[\\/]/);
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    diagnostics.push(
      diagnostic(
        "CONFIG_PATH_TRAVERSAL",
        `${label} must not contain empty, dot, or traversal path components`,
        path,
        "validation"
      )
    );
  }
}

function isWorkspaceMode(value: string): value is WorkspaceMode {
  return value === "git-worktree";
}

function parseBoolean(value: string): boolean | undefined {
  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return undefined;
  }
}

function sortConfig(config: ResolvedConfig): void {
  config.models.profiles = Object.fromEntries(
    Object.entries(config.models.profiles).sort(([left], [right]) => left.localeCompare(right))
  );
}

function pushTable(lines: string[], name: string, values: Record<string, unknown>): void {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return;
  }
  if (lines.length > 0 && lines[lines.length - 1] !== "") {
    lines.push("");
  }
  lines.push(`[${name}]`);
  pushAssignments(lines, Object.fromEntries(entries));
}

function pushAssignments(lines: string[], values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      continue;
    }
    lines.push(`${key} = ${tomlValue(value)}`);
  }
}

function tomlValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => tomlValue(item)).join(", ")}]`;
  }
  throw new TypeError(`unsupported TOML value ${String(value)}`);
}

function tableName(parts: string[]): string {
  return parts.map(quoteTableSegment).join(".");
}

function quoteTableSegment(segment: string): string {
  return /^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment);
}

function formatDurationSeconds(seconds: number): string {
  if (seconds % (60 * 60) === 0) {
    return `${seconds / (60 * 60)}h`;
  }
  if (seconds % 60 === 0) {
    return `${seconds / 60}min`;
  }
  return `${seconds}s`;
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
