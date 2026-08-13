import type { ZodIssue, ZodType } from "zod/v4";
import { MAX_RETRY_CHAIN_ATTEMPTS } from "@ultrafuzz/artifacts";
import {
  DEFAULT_AGENT,
  DEFAULT_MODEL_PROFILE_ID,
  MAX_TIMEOUT_SECONDS,
  cloneResolvedConfig,
  createDefaultPromptMetadataLayer,
  createDefaultResolvedConfig
} from "./defaults.js";
import {
  auditProfile as findAuditProfile,
  loadAuditProfileCatalog,
  type AuditProfileSettings
} from "./audit-profiles.js";
import { validateAgentConfigs } from "./agents.js";
import { syncDefaultModelProfile, validateModelProfiles, validProfileId } from "./model-profiles.js";
import { validateTriageConfig } from "./triage.js";
import { resolvedConfigZodSchema } from "./resolved-config-schema.js";
import {
  diagnostic,
  fail,
  hasErrors,
  ok,
  type AgentConfig,
  type ConfigDiagnostic,
  type ConfigResult,
  type PermissionConfig,
  type ProjectConfigInput,
  type PromptMetadataLayer,
  type ResolveConfigInput,
  type ResolvedConfig,
  type RuntimeConfigOverrides
} from "./types.js";

export function resolveConfig(input: ResolveConfigInput = {}): ConfigResult<ResolvedConfig> {
  const diagnostics: ConfigDiagnostic[] = [];
  const config = createDefaultResolvedConfig();
  const environment = input.env ?? process.env;

  const selectedAuditProfile =
    input.runtimeOverrides?.auditProfile ?? input.projectConfig?.auditProfile ?? config.auditProfile;
  try {
    const catalog = loadAuditProfileCatalog();
    const profile = findAuditProfile(selectedAuditProfile, catalog);
    config.auditProfile = profile.id;
    config.auditProfileResolution = {
      catalogSchemaVersion: catalog.schemaVersion,
      catalogDigest: catalog.digest,
      ...(profile.topologyPath === undefined ? {} : { declaredTopologyPath: profile.topologyPath }),
      settings: { ...profile.settings },
      effectiveSettings: {},
      settingOrigins: {},
      overriddenSettings: []
    };
    applyAuditProfileSettings(config, profile.settings);
  } catch (error) {
    diagnostics.push(
      diagnostic(
        "CONFIG_AUDIT_PROFILE_INVALID",
        error instanceof Error ? error.message : String(error),
        ["audit_profile"],
        "audit-profile"
      )
    );
  }

  applyPromptMetadataLayer(config, createDefaultPromptMetadataLayer(), diagnostics);
  if (input.promptMetadata) {
    applyPromptMetadataLayer(config, input.promptMetadata, diagnostics);
  }
  if (input.projectConfig) {
    applyProjectConfigLayer(config, input.projectConfig, diagnostics, "project-toml");
  }
  applyEnvironmentOverrides(config, environment, diagnostics);
  if (input.runtimeOverrides) {
    applyRuntimeOverrides(config, input.runtimeOverrides, diagnostics);
  }

  syncDefaultModelProfile(config);
  finalizeAuditProfileResolution(config, input, environment);
  sortConfig(config);
  for (const entry of validateResolvedConfig(config, environment)) {
    if (!diagnostics.some((existing) => sameDiagnosticIdentity(existing, entry))) diagnostics.push(entry);
  }

  if (hasErrors(diagnostics)) {
    return fail(diagnostics);
  }
  return ok(config, diagnostics);
}

export function validateResolvedConfig(
  config: ResolvedConfig,
  env: Record<string, string | undefined> = process.env
): ConfigDiagnostic[] {
  const diagnostics = schemaIssues(resolvedConfigZodSchema, config)
    .filter(
      (issue) => !isNamedSemanticSchemaIssue(issue) && !isModelProfileSchemaIssue(issue) && !isRetrySchemaIssue(issue)
    )
    .map((issue) => resolvedConfigDiagnostic(issue, config));
  diagnostics.push(...validateAgentConfigs(config.agents));
  diagnostics.push(...validateTriageConfig(config.triage));
  diagnostics.push(...validateModelProfiles(config));
  diagnostics.push(...validateRetryConfig(config));
  diagnostics.push(...validateExecutionConfig(config, env));
  return diagnostics;
}

export interface SerializeResolvedConfigTomlOptions {
  omitAuditProfileManagedSettings?: boolean;
}

export function serializeResolvedConfigToml(
  config: ResolvedConfig,
  options: SerializeResolvedConfigTomlOptions = {}
): string {
  const clone = cloneResolvedConfig(config);
  const omitProfileSettings = options.omitAuditProfileManagedSettings === true;
  sortConfig(clone);
  const lines: string[] = [];

  pushAssignments(lines, {
    schema_version: clone.schemaVersion,
    audit_profile: clone.auditProfile,
    topology_path: clone.topologyPath,
    strategy_loops: omitProfileSettings ? undefined : clone.strategyLoops,
    dynamic_strategies_enumerator: omitProfileSettings ? undefined : clone.dynamicStrategiesEnumerator
  });
  pushTable(lines, "project", {
    repo: clone.project.repo,
    name: clone.project.name
  });
  pushTable(lines, "run", {
    output_dir: clone.run.outputDir,
    max_parallel_agents: omitProfileSettings ? undefined : clone.run.maxParallelAgents,
    max_parallel_nodes: omitProfileSettings ? undefined : clone.run.maxParallelNodes,
    keep_workspaces: clone.run.keepWorkspaces,
    forge_guard_enabled: clone.run.forgeGuardEnabled,
    forge_vmem_limit_kb: clone.run.forgeVmemLimitKb,
    forge_rayon_threads: clone.run.forgeRayonThreads,
    workspace_mode: clone.run.workspaceMode,
    default_timeout_seconds: omitProfileSettings ? undefined : clone.run.defaultTimeoutSeconds,
    workflow_deadline_seconds: omitProfileSettings ? undefined : clone.run.workflowDeadlineSeconds,
    controller_lease_seconds: clone.run.controllerLeaseSeconds
  });
  pushTable(lines, "execution", {
    mode: clone.execution.mode,
    provider: clone.execution.provider,
    retention_days: clone.execution.retentionDays
  });
  pushTable(lines, tableName(["execution", "resources"]), {
    cpu: clone.execution.resources.cpu,
    memory_mib: clone.execution.resources.memoryMiB,
    timeout_seconds: clone.execution.resources.timeoutSeconds
  });
  for (const [id, override] of Object.entries(clone.execution.nodes)) {
    pushTable(lines, tableName(["execution", "nodes", id, "resources"]), {
      cpu: override.resources.cpu,
      memory_mib: override.resources.memoryMiB,
      timeout_seconds: override.resources.timeoutSeconds
    });
  }
  if (clone.execution.providers.modal !== undefined) {
    pushTable(lines, tableName(["execution", "providers", "modal"]), {
      app: clone.execution.providers.modal.app,
      image: clone.execution.providers.modal.image,
      region: clone.execution.providers.modal.region,
      credential_env: clone.execution.providers.modal.credentialEnv
    });
  }
  pushTable(lines, "models", {
    default: clone.models.default === DEFAULT_MODEL_PROFILE_ID ? undefined : clone.models.default,
    synthesized_default: clone.models.synthesizedDefault || undefined
  });
  for (const [id, profile] of Object.entries(clone.models.profiles)) {
    pushTable(lines, tableName(["models", id]), {
      agent: profile.agent,
      model: profile.model,
      reasoning: profile.reasoning,
      timeout_seconds: profile.timeoutSeconds
    });
  }
  pushTable(lines, "retry", {
    same_agent_attempts: clone.retry.sameAgentAttempts,
    agents: clone.retry.agents.length === 0 ? undefined : clone.retry.agents
  });
  for (const [id, agent] of Object.entries(clone.agents)) {
    pushTable(lines, tableName(["agents", id]), {
      auth: agent.auth,
      api_key_env: agent.apiKeyEnv,
      config_dir: agent.configDir
    });
  }
  pushTable(lines, "permissions", {
    trust_model: clone.permissions.trustModel,
    prompt_review_required: clone.permissions.promptReviewRequired,
    materialize_outputs_as_unstaged: clone.permissions.materializeOutputsAsUnstaged,
    production_source_roots: clone.permissions.productionSourceRoots
  });
  pushTable(lines, "invariants", {
    property_priority_threshold: clone.invariants.propertyPriorityThreshold,
    invariant_testing_smoke_timeout: omitProfileSettings
      ? undefined
      : formatDurationSeconds(clone.invariants.invariantTestingSmokeTimeoutSeconds),
    invariant_testing_fuzzer_timeout: omitProfileSettings
      ? undefined
      : formatDurationSeconds(clone.invariants.invariantTestingFuzzerTimeoutSeconds),
    reference_expectation_enforcement: clone.invariants.referenceExpectationEnforcement
  });
  pushTable(lines, "triage", {
    quorum: omitProfileSettings ? undefined : clone.triage.quorum,
    panel_size: omitProfileSettings ? undefined : clone.triage.panelSize
  });
  pushTable(lines, "eval", {
    eval_config: clone.eval.evalConfig,
    ground_truth_root: clone.eval.groundTruthRoot,
    provider: clone.eval.provider
  });
  for (const [name, profile] of Object.entries(clone.eval.providers)) {
    pushTable(lines, tableName(["eval", "providers", name]), {
      api_key_env: profile.apiKeyEnv,
      project: profile.project,
      endpoint: profile.endpoint
    });
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

function applyAuditProfileSettings(config: ResolvedConfig, settings: AuditProfileSettings): void {
  if (settings.strategy_loops !== undefined) config.strategyLoops = settings.strategy_loops;
  if (settings.dynamic_strategies_enumerator !== undefined) {
    config.dynamicStrategiesEnumerator = settings.dynamic_strategies_enumerator;
  }
  if (settings.max_parallel_agents !== undefined) config.run.maxParallelAgents = settings.max_parallel_agents;
  if (settings.max_parallel_nodes !== undefined) config.run.maxParallelNodes = settings.max_parallel_nodes;
  if (settings.default_timeout_seconds !== undefined) {
    config.run.defaultTimeoutSeconds = settings.default_timeout_seconds;
  }
  if (settings.workflow_deadline_seconds !== undefined) {
    config.run.workflowDeadlineSeconds = settings.workflow_deadline_seconds;
  }
  if (settings.invariant_testing_smoke_timeout_seconds !== undefined) {
    config.invariants.invariantTestingSmokeTimeoutSeconds = settings.invariant_testing_smoke_timeout_seconds;
  }
  if (settings.invariant_testing_fuzzer_timeout_seconds !== undefined) {
    config.invariants.invariantTestingFuzzerTimeoutSeconds = settings.invariant_testing_fuzzer_timeout_seconds;
  }
  if (settings.triage_quorum !== undefined) config.triage.quorum = settings.triage_quorum;
  if (settings.triage_panel_size !== undefined) config.triage.panelSize = settings.triage_panel_size;
}

export function resolvedAuditProfileSettings(config: ResolvedConfig): AuditProfileSettings {
  return {
    strategy_loops: config.strategyLoops ?? 1,
    dynamic_strategies_enumerator: config.dynamicStrategiesEnumerator,
    max_parallel_agents: config.run.maxParallelAgents,
    max_parallel_nodes: config.run.maxParallelNodes,
    default_timeout_seconds: config.run.defaultTimeoutSeconds,
    workflow_deadline_seconds: config.run.workflowDeadlineSeconds,
    invariant_testing_smoke_timeout_seconds: config.invariants.invariantTestingSmokeTimeoutSeconds,
    invariant_testing_fuzzer_timeout_seconds: config.invariants.invariantTestingFuzzerTimeoutSeconds,
    triage_quorum: config.triage.quorum,
    triage_panel_size: config.triage.panelSize
  };
}

function finalizeAuditProfileResolution(
  config: ResolvedConfig,
  input: ResolveConfigInput,
  environment: Record<string, string | undefined>
): void {
  const origins = auditProfileSettingOrigins(config.auditProfileResolution.settings, input, environment);
  config.auditProfileResolution.effectiveSettings = resolvedAuditProfileSettings(config);
  config.auditProfileResolution.settingOrigins = origins;
  config.auditProfileResolution.overriddenSettings = Object.keys(config.auditProfileResolution.settings)
    .filter((key) => origins[key] !== "audit-profile")
    .sort();
}

function auditProfileSettingOrigins(
  profile: AuditProfileSettings,
  input: ResolveConfigInput,
  environment: Record<string, string | undefined>
): Record<string, ResolvedConfig["auditProfileResolution"]["settingOrigins"][string]> {
  const keys = Object.keys(resolvedAuditProfileSettings(createDefaultResolvedConfig()));
  const origins = Object.fromEntries(
    keys.map((key) => [key, Object.hasOwn(profile, key) ? "audit-profile" : "default"])
  ) as Record<string, ResolvedConfig["auditProfileResolution"]["settingOrigins"][string]>;
  applyLayerSettingOrigins(origins, input.projectConfig, "project-config");
  if (environment.ULTRAFUZZ_MAX_PARALLEL_AGENTS !== undefined) origins.max_parallel_agents = "environment";
  if (environment.ULTRAFUZZ_MAX_PARALLEL_NODES !== undefined) origins.max_parallel_nodes = "environment";
  applyLayerSettingOrigins(origins, input.runtimeOverrides, "runtime-override");
  return Object.fromEntries(Object.entries(origins).sort(([left], [right]) => left.localeCompare(right)));
}

function applyLayerSettingOrigins(
  origins: Record<string, ResolvedConfig["auditProfileResolution"]["settingOrigins"][string]>,
  layer: ProjectConfigInput | RuntimeConfigOverrides | undefined,
  origin: "project-config" | "runtime-override"
): void {
  if (layer === undefined) return;
  const runtimeLayer = layer as RuntimeConfigOverrides;
  if (layer.strategyLoops !== undefined) origins.strategy_loops = origin;
  if (layer.dynamicStrategiesEnumerator !== undefined) origins.dynamic_strategies_enumerator = origin;
  if (layer.run?.maxParallelAgents !== undefined || runtimeLayer.maxParallelAgents !== undefined) {
    origins.max_parallel_agents = origin;
  }
  if (layer.run?.maxParallelNodes !== undefined || runtimeLayer.maxParallelNodes !== undefined) {
    origins.max_parallel_nodes = origin;
  }
  if (layer.run?.defaultTimeoutSeconds !== undefined) origins.default_timeout_seconds = origin;
  if (layer.run?.workflowDeadlineSeconds !== undefined) origins.workflow_deadline_seconds = origin;
  if (layer.invariants?.invariantTestingSmokeTimeoutSeconds !== undefined) {
    origins.invariant_testing_smoke_timeout_seconds = origin;
  }
  if (layer.invariants?.invariantTestingFuzzerTimeoutSeconds !== undefined) {
    origins.invariant_testing_fuzzer_timeout_seconds = origin;
  }
  if (layer.triage?.quorum !== undefined || runtimeLayer.triageQuorum !== undefined) origins.triage_quorum = origin;
  if (layer.triage?.panelSize !== undefined || runtimeLayer.triagePanelSize !== undefined) {
    origins.triage_panel_size = origin;
  }
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
        reasoning: profile.reasoning ?? existing?.reasoning,
        timeoutSeconds: profile.timeoutSeconds ?? existing?.timeoutSeconds
      };
      if (id === DEFAULT_MODEL_PROFILE_ID) {
        config.models.synthesizedDefault = false;
      }
    }
  }
}

function applyExecutionConfig(config: ResolvedConfig, layer: NonNullable<ProjectConfigInput["execution"]>): void {
  if (layer.mode !== undefined) {
    config.execution.mode = layer.mode;
  }
  if (layer.provider !== undefined) {
    config.execution.provider = layer.provider;
  }
  if (layer.retentionDays !== undefined) {
    config.execution.retentionDays = layer.retentionDays;
  }
  if (layer.resources !== undefined) {
    config.execution.resources = {
      ...config.execution.resources,
      ...definedOnly(layer.resources)
    };
  }
  for (const [id, override] of Object.entries(layer.nodes ?? {})) {
    config.execution.nodes[id] = {
      resources: {
        ...config.execution.nodes[id]?.resources,
        ...definedOnly(override.resources ?? {})
      }
    };
  }
  if (layer.providers?.modal !== undefined) {
    const current = config.execution.providers.modal;
    const next = { ...current, ...definedOnly(layer.providers.modal) };
    config.execution.providers.modal = next as NonNullable<ResolvedConfig["execution"]["providers"]["modal"]>;
  }
}

function validateExecutionConfig(config: ResolvedConfig, env: Record<string, string | undefined>): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  if (config.execution.mode === "local") {
    if (config.execution.provider !== undefined) {
      diagnostics.push(
        diagnostic(
          "CONFIG_EXECUTION_LOCAL_PROVIDER",
          "execution.provider is only valid when execution.mode is cloud",
          ["execution", "provider"],
          "validation"
        )
      );
    }
    if (config.execution.providers.modal !== undefined) {
      diagnostics.push(
        diagnostic(
          "CONFIG_EXECUTION_LOCAL_PROVIDER_SETTINGS",
          "cloud provider settings are only valid when execution.mode is cloud",
          ["execution", "providers", "modal"],
          "validation"
        )
      );
    }
    return diagnostics;
  }

  if (config.execution.provider === undefined) {
    diagnostics.push(
      diagnostic(
        "CONFIG_EXECUTION_PROVIDER_REQUIRED",
        "cloud execution requires an execution provider",
        ["execution", "provider"],
        "validation"
      )
    );
    return diagnostics;
  }
  const provider = config.execution.providers[config.execution.provider];
  if (provider === undefined) {
    diagnostics.push(
      diagnostic(
        "CONFIG_EXECUTION_PROVIDER_SETTINGS_REQUIRED",
        "cloud execution requires settings for the selected provider",
        ["execution", "providers", config.execution.provider],
        "validation"
      )
    );
    return diagnostics;
  }
  provider.credentialEnv.forEach((name, index) => {
    const value = env[name];
    if (value === undefined || value.trim() === "") {
      diagnostics.push(
        diagnostic(
          "CONFIG_EXECUTION_CREDENTIAL_MISSING",
          "a configured cloud credential environment variable is not set",
          ["execution", "providers", config.execution.provider!, "credential_env", String(index)],
          "validation"
        )
      );
    }
  });
  return diagnostics;
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
  if (layer.auditProfile !== undefined) {
    config.auditProfile = layer.auditProfile;
  }
  if (layer.topologyPath !== undefined) {
    config.topologyPath = layer.topologyPath;
  }
  if (layer.strategyLoops !== undefined) {
    config.strategyLoops = layer.strategyLoops;
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
  if (layer.execution) {
    applyExecutionConfig(config, layer.execution);
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
          reasoning: profile.reasoning ?? existing?.reasoning,
          timeoutSeconds: profile.timeoutSeconds ?? existing?.timeoutSeconds
        };
      }
    }
  }
  if (layer.retry) {
    if (layer.retry.sameAgentAttempts !== undefined) {
      config.retry.sameAgentAttempts = layer.retry.sameAgentAttempts;
    }
    if (layer.retry.agents !== undefined) {
      config.retry.agents = [...layer.retry.agents];
    }
  }
  if (layer.agents) {
    for (const [id, agent] of Object.entries(layer.agents).sort()) {
      config.agents[id] = normalizeAgentConfig(agent, config.agents[id]);
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
  if (layer.eval) {
    if (layer.eval.provider !== undefined) {
      config.eval.provider = layer.eval.provider;
    }
    if (layer.eval.evalConfig !== undefined) {
      config.eval.evalConfig = layer.eval.evalConfig;
    }
    if (layer.eval.groundTruthRoot !== undefined) {
      config.eval.groundTruthRoot = layer.eval.groundTruthRoot;
    }
    if (layer.eval.providers) {
      for (const [name, profile] of Object.entries(layer.eval.providers).sort()) {
        config.eval.providers[name] = {
          ...config.eval.providers[name],
          ...definedOnly(profile)
        };
      }
    }
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
  if (env.ULTRAFUZZ_EVAL_PROVIDER !== undefined && env.ULTRAFUZZ_EVAL_PROVIDER.trim().length > 0) {
    config.eval.provider = env.ULTRAFUZZ_EVAL_PROVIDER.trim();
  }
  if (env.ULTRAFUZZ_EVAL_CONFIG !== undefined && env.ULTRAFUZZ_EVAL_CONFIG.trim().length > 0) {
    config.eval.evalConfig = env.ULTRAFUZZ_EVAL_CONFIG.trim();
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
  if (source.productionSourceRoots !== undefined) {
    target.productionSourceRoots = [...source.productionSourceRoots];
  }
}

function normalizeAgentConfig(source: Partial<AgentConfig>, base?: AgentConfig): AgentConfig {
  return {
    auth: source.auth ?? base?.auth ?? "subscription",
    apiKeyEnv: source.apiKeyEnv ?? base?.apiKeyEnv,
    configDir: source.configDir ?? base?.configDir
  };
}

function validateRetryConfig(config: ResolvedConfig): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  const sameAgentAttempts = config.retry.sameAgentAttempts;
  if (!Number.isSafeInteger(sameAgentAttempts) || sameAgentAttempts <= 0) {
    diagnostics.push(
      diagnostic(
        "CONFIG_RETRY_ATTEMPTS_INVALID",
        "retry.same_agent_attempts must be a positive safe integer",
        ["retry", "same_agent_attempts"],
        "validation"
      )
    );
  } else if (sameAgentAttempts > MAX_RETRY_CHAIN_ATTEMPTS) {
    diagnostics.push(
      diagnostic(
        "CONFIG_RETRY_ATTEMPTS_MAX_EXCEEDED",
        `retry.same_agent_attempts must not exceed ${MAX_RETRY_CHAIN_ATTEMPTS}`,
        ["retry", "same_agent_attempts"],
        "validation"
      )
    );
  }
  if (!Array.isArray(config.retry.agents)) {
    diagnostics.push(
      diagnostic(
        "CONFIG_RETRY_AGENTS_INVALID",
        "retry.agents must be an array of model profile IDs",
        ["retry", "agents"],
        "validation"
      )
    );
    return diagnostics;
  }
  const seen = new Set<string>();
  for (const [index, profileId] of config.retry.agents.entries()) {
    if (typeof profileId !== "string" || !validProfileId(profileId)) {
      diagnostics.push(
        diagnostic(
          "CONFIG_RETRY_AGENT_ID_INVALID",
          `retry.agents entry ${index} must be a valid model profile ID`,
          ["retry", "agents", String(index)],
          "validation"
        )
      );
      continue;
    }
    if (seen.has(profileId)) {
      diagnostics.push(
        diagnostic(
          "CONFIG_RETRY_AGENT_DUPLICATE",
          `retry.agents repeats model profile \`${profileId}\``,
          ["retry", "agents", String(index)],
          "validation"
        )
      );
      continue;
    }
    seen.add(profileId);
    if (config.models.profiles[profileId] === undefined) {
      diagnostics.push(
        diagnostic(
          "CONFIG_RETRY_AGENT_UNKNOWN",
          `retry.agents references unknown model profile \`${profileId}\``,
          ["retry", "agents", String(index)],
          "validation"
        )
      );
    }
  }
  if (
    Number.isSafeInteger(sameAgentAttempts) &&
    sameAgentAttempts > 0 &&
    sameAgentAttempts <= MAX_RETRY_CHAIN_ATTEMPTS
  ) {
    const expandedAttempts = sameAgentAttempts + Math.max(0, config.retry.agents.length - 1);
    if (expandedAttempts > MAX_RETRY_CHAIN_ATTEMPTS) {
      diagnostics.push(
        diagnostic(
          "CONFIG_RETRY_CHAIN_MAX_EXCEEDED",
          `retry expands to ${expandedAttempts} attempts; maximum is ${MAX_RETRY_CHAIN_ATTEMPTS}`,
          ["retry"],
          "validation"
        )
      );
    }
  }
  return diagnostics;
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

function schemaIssues(schema: ZodType, value: unknown): ZodIssue[] {
  const parsed = schema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues;
}

/**
 * The canonical JSON Schema conditionals are mirrored as named Zod refinements
 * for validator parity. The named validators in this module own their
 * user-facing diagnostics; mapping the mirrored issue as a structural failure
 * would report the same error twice with a generic structural message.
 */
function isNamedSemanticSchemaIssue(issue: ZodIssue): boolean {
  return issue.code === "custom" && issue.message.startsWith("CONFIG_");
}

function isModelProfileSchemaIssue(issue: ZodIssue): boolean {
  return issue.path[0] === "models" && issue.path[1] === "profiles";
}

function isRetrySchemaIssue(issue: ZodIssue): boolean {
  return issue.path[0] === "retry";
}

function sameDiagnosticIdentity(left: ConfigDiagnostic, right: ConfigDiagnostic): boolean {
  return (
    left.code === right.code &&
    left.path.length === right.path.length &&
    left.path.every((part, i) => part === right.path[i])
  );
}

function resolvedConfigDiagnostic(issue: ZodIssue, config: ResolvedConfig): ConfigDiagnostic {
  const code = resolvedConfigDiagnosticCode(issue);
  return diagnostic(
    code,
    resolvedConfigDiagnosticMessage(code, issue, config),
    resolvedConfigDiagnosticPath(issue),
    "validation"
  );
}

function resolvedConfigDiagnosticCode(issue: ZodIssue): string {
  if (issue.code === "custom" && issue.message.startsWith("CONFIG_")) {
    return issue.message;
  }
  const path = resolvedConfigDiagnosticPath(issue);
  const key = path.join(".");
  switch (key) {
    case "schema_version":
      return "CONFIG_SCHEMA_VERSION_UNSUPPORTED";
    case "run.default_timeout_seconds":
    case "run.workflow_deadline_seconds":
    case "run.controller_lease_seconds":
    case "invariants.invariant_testing_smoke_timeout":
    case "invariants.invariant_testing_fuzzer_timeout":
      return "CONFIG_TIMEOUT_INVALID";
    case "run.workspace_mode":
      return "CONFIG_WORKSPACE_MODE_INVALID";
    case "invariants.property_priority_threshold":
      return "CONFIG_INVARIANT_PRIORITY_INVALID";
    case "invariants.reference_expectation_enforcement":
      return "CONFIG_REFERENCE_EXPECTATION_ENFORCEMENT_INVALID";
    case "permissions.trust_model":
      return "CONFIG_TRUST_MODEL_INVALID";
    default:
      return "CONFIG_POSITIVE_INTEGER_INVALID";
  }
}

function resolvedConfigDiagnosticMessage(code: string, issue: ZodIssue, config: ResolvedConfig): string {
  const label = resolvedConfigDiagnosticPath(issue).join(".");
  switch (code) {
    case "CONFIG_SCHEMA_VERSION_UNSUPPORTED":
      return "schema_version must be exactly ultrafuzz.config.v2";
    case "CONFIG_PATH_EMPTY":
      return `${label} cannot be empty`;
    case "CONFIG_PATH_ABSOLUTE":
      return `${label} must be a relative project-local path`;
    case "CONFIG_PATH_TRAVERSAL":
      return `${label} must not contain empty, dot, or traversal path components`;
    case "CONFIG_TIMEOUT_INVALID":
      return `${label} must be between 1 and ${MAX_TIMEOUT_SECONDS}`;
    case "CONFIG_WORKSPACE_MODE_INVALID":
      return `run.workspace_mode \`${String(valueAtPath(config, issue.path))}\` is not supported`;
    case "CONFIG_INVARIANT_PRIORITY_INVALID":
      return "invariants.property_priority_threshold must be high, medium, or low";
    case "CONFIG_REFERENCE_EXPECTATION_ENFORCEMENT_INVALID":
      return "invariants.reference_expectation_enforcement must be warn or fail";
    case "CONFIG_TRUST_MODEL_INVALID":
      return "permissions.trust_model must be skip-permissions";
    default:
      return `${label} must be greater than zero`;
  }
}

function resolvedConfigDiagnosticPath(issue: ZodIssue): string[] {
  return issue.path.map((segment) => configPathSegment(String(segment)));
}

function configPathSegment(segment: string): string {
  switch (segment) {
    case "schemaVersion":
      return "schema_version";
    case "auditProfile":
      return "audit_profile";
    case "topologyPath":
      return "topology_path";
    case "strategyLoops":
      return "strategy_loops";
    case "dynamicStrategiesEnumerator":
      return "dynamic_strategies_enumerator";
    case "outputDir":
      return "output_dir";
    case "maxParallelAgents":
      return "max_parallel_agents";
    case "maxParallelNodes":
      return "max_parallel_nodes";
    case "forgeGuardEnabled":
      return "forge_guard_enabled";
    case "forgeVmemLimitKb":
      return "forge_vmem_limit_kb";
    case "forgeRayonThreads":
      return "forge_rayon_threads";
    case "defaultTimeoutSeconds":
      return "default_timeout_seconds";
    case "workflowDeadlineSeconds":
      return "workflow_deadline_seconds";
    case "controllerLeaseSeconds":
      return "controller_lease_seconds";
    case "workspaceMode":
      return "workspace_mode";
    case "retentionDays":
      return "retention_days";
    case "memoryMiB":
      return "memory_mib";
    case "timeoutSeconds":
      return "timeout_seconds";
    case "credentialEnv":
      return "credential_env";
    case "propertyPriorityThreshold":
      return "property_priority_threshold";
    case "invariantTestingSmokeTimeoutSeconds":
      return "invariant_testing_smoke_timeout";
    case "invariantTestingFuzzerTimeoutSeconds":
      return "invariant_testing_fuzzer_timeout";
    case "referenceExpectationEnforcement":
      return "reference_expectation_enforcement";
    case "trustModel":
      return "trust_model";
    default:
      return segment;
  }
}

function valueAtPath(value: unknown, path: PropertyKey[]): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
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
  config.agents = Object.fromEntries(
    Object.entries(config.agents).sort(([left], [right]) => left.localeCompare(right))
  );
  config.models.profiles = Object.fromEntries(
    Object.entries(config.models.profiles).sort(([left], [right]) => left.localeCompare(right))
  );
  config.eval.providers = Object.fromEntries(
    Object.entries(config.eval.providers).sort(([left], [right]) => left.localeCompare(right))
  );
  config.execution.nodes = Object.fromEntries(
    Object.entries(config.execution.nodes).sort(([left], [right]) => left.localeCompare(right))
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
