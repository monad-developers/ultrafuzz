import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG_FILE_NAME } from "./constants.js";
import { parseProjectConfigToml } from "./loader.js";
import type {
  AgentConfig,
  EvalConfig,
  EvalConfigInput,
  ExecutionConfig,
  ModelProfile,
  PermissionConfig,
  ProjectConfigInput,
  PromptMetadataLayer,
  ResolvedConfig,
  RunConfig
} from "./types.js";

export { CONFIG_FILE_NAME } from "./constants.js";
export const DEFAULT_MODEL_PROFILE_ID = "default";
export const DEFAULT_AGENT = "CodexAgent";
export const DEFAULT_CODEX_MODEL = "gpt-5.5";
export const DEFAULT_CODEX_REASONING = "xhigh";
export const DEFAULT_TRIAGE_QUORUM = 3;
export const DEFAULT_TRIAGE_PANEL_SIZE = 4;
export const MAX_TIMEOUT_SECONDS = 86_400;
export const DEFAULT_EVAL_PROVIDER = "none";

const DEFAULT_CONFIG = loadDefaultConfig();

export function createDefaultResolvedConfig(): ResolvedConfig {
  return cloneResolvedConfig(DEFAULT_CONFIG);
}

export function createDefaultPromptMetadataLayer(): PromptMetadataLayer {
  return {};
}

export function synthesizeDefaultModelProfile(agent = DEFAULT_AGENT): ModelProfile {
  return {
    id: DEFAULT_MODEL_PROFILE_ID,
    agent,
    model: DEFAULT_CODEX_MODEL,
    reasoning: DEFAULT_CODEX_REASONING
  };
}

export function cloneResolvedConfig(config: ResolvedConfig): ResolvedConfig {
  return structuredClone(config);
}

function loadDefaultConfig(): ResolvedConfig {
  const filePath = defaultConfigPath();
  const parsed = parseProjectConfigToml(fs.readFileSync(filePath, "utf8"), filePath);
  if (!parsed.ok) {
    throw new Error(`${filePath} failed default config validation: ${formatDefaultDiagnostics(parsed.diagnostics)}`);
  }
  const config = normalizeDefaultConfig(parsed.value, filePath);
  assertResolvedConfig(config, filePath);
  return config;
}

function defaultConfigPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, CONFIG_FILE_NAME),
    path.resolve(here, "../../../", CONFIG_FILE_NAME),
    path.resolve(here, "../../../../", CONFIG_FILE_NAME)
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found === undefined) {
    throw new Error(`unable to locate ${CONFIG_FILE_NAME} from ${here}`);
  }
  return found;
}

function normalizeDefaultConfig(input: ProjectConfigInput, filePath: string): ResolvedConfig {
  const project = requiredRecord(input.project, "project", filePath);
  const run = requiredRecord(input.run, "run", filePath);
  const models = requiredRecord(input.models, "models", filePath);
  const agents = requiredRecord(input.agents, "agents", filePath);
  const execution = requiredRecord(input.execution, "execution", filePath);
  const permissions = requiredRecord(input.permissions, "permissions", filePath);
  const invariants = requiredRecord(input.invariants, "invariants", filePath);
  const triage = requiredRecord(input.triage, "triage", filePath);

  return {
    schemaVersion: required(input.schemaVersion, "schema_version", filePath),
    dynamicStrategiesEnumerator: required(input.dynamicStrategiesEnumerator, "dynamic_strategies_enumerator", filePath),
    project: {
      repo: required(project.repo, "project.repo", filePath),
      ...(project.name !== undefined ? { name: project.name } : {})
    },
    run: normalizeRunConfig(run, filePath),
    execution: normalizeExecutionConfig(execution, filePath),
    models: {
      default: models.default ?? DEFAULT_MODEL_PROFILE_ID,
      synthesizedDefault: required(models.synthesizedDefault, "models.synthesized_default", filePath),
      profiles: Object.fromEntries(
        Object.entries(requiredRecord(models.profiles, "models profiles", filePath)).map(([id, profile]) => [
          id,
          normalizeModelProfile(id, profile, filePath)
        ])
      )
    },
    agents: Object.fromEntries(
      Object.entries(agents).map(([id, agent]) => [id, normalizeAgentConfig(id, agent, filePath)])
    ),
    permissions: normalizePermissions(permissions, filePath),
    invariants: {
      propertyPriorityThreshold: required(
        invariants.propertyPriorityThreshold,
        "invariants.property_priority_threshold",
        filePath
      ),
      invariantTestingSmokeTimeoutSeconds: required(
        invariants.invariantTestingSmokeTimeoutSeconds,
        "invariants.invariant_testing_smoke_timeout",
        filePath
      ),
      invariantTestingFuzzerTimeoutSeconds: required(
        invariants.invariantTestingFuzzerTimeoutSeconds,
        "invariants.invariant_testing_fuzzer_timeout",
        filePath
      ),
      // Optional: absent means `warn`, the staged default for issue #285. Requiring it here would
      // force every default config to declare a switch that has one safe setting.
      ...(invariants.referenceExpectationEnforcement !== undefined
        ? { referenceExpectationEnforcement: invariants.referenceExpectationEnforcement }
        : {})
    },
    triage: {
      quorum: required(triage.quorum, "triage.quorum", filePath),
      panelSize: required(triage.panelSize, "triage.panel_size", filePath)
    },
    eval: normalizeEvalConfig(input.eval)
  };
}

function normalizeExecutionConfig(
  execution: NonNullable<ProjectConfigInput["execution"]>,
  filePath: string
): ExecutionConfig {
  const resources = requiredRecord(execution.resources, "execution.resources", filePath);
  return {
    mode: required(execution.mode, "execution.mode", filePath),
    ...(execution.provider !== undefined ? { provider: execution.provider } : {}),
    retentionDays: required(execution.retentionDays, "execution.retention_days", filePath),
    resources: {
      cpu: required(resources.cpu, "execution.resources.cpu", filePath),
      memoryMiB: required(resources.memoryMiB, "execution.resources.memory_mib", filePath),
      timeoutSeconds: required(resources.timeoutSeconds, "execution.resources.timeout_seconds", filePath)
    },
    nodes: Object.fromEntries(
      Object.entries(execution.nodes ?? {}).map(([id, override]) => [id, { resources: { ...override.resources } }])
    ),
    providers: {
      ...(execution.providers?.modal === undefined
        ? {}
        : {
            modal: {
              app: required(execution.providers.modal.app, "execution.providers.modal.app", filePath),
              image: required(execution.providers.modal.image, "execution.providers.modal.image", filePath),
              ...(execution.providers.modal.region === undefined ? {} : { region: execution.providers.modal.region }),
              credentialEnv: required(
                execution.providers.modal.credentialEnv,
                "execution.providers.modal.credential_env",
                filePath
              )
            }
          })
    }
  };
}

export function normalizeEvalConfig(input: EvalConfigInput | undefined): EvalConfig {
  return {
    provider: input?.provider ?? DEFAULT_EVAL_PROVIDER,
    providers: Object.fromEntries(
      Object.entries(input?.providers ?? {}).map(([name, profile]) => [
        name,
        {
          ...(profile.apiKeyEnv !== undefined ? { apiKeyEnv: profile.apiKeyEnv } : {}),
          ...(profile.project !== undefined ? { project: profile.project } : {}),
          ...(profile.endpoint !== undefined ? { endpoint: profile.endpoint } : {})
        }
      ])
    ),
    ...(input?.evalConfig !== undefined ? { evalConfig: input.evalConfig } : {}),
    ...(input?.groundTruthRoot !== undefined ? { groundTruthRoot: input.groundTruthRoot } : {})
  };
}

function normalizeAgentConfig(id: string, agent: Partial<AgentConfig>, filePath: string): AgentConfig {
  return {
    auth: required(agent.auth, `agents.${id}.auth`, filePath),
    ...(agent.apiKeyEnv !== undefined ? { apiKeyEnv: agent.apiKeyEnv } : {}),
    ...(agent.configDir !== undefined ? { configDir: agent.configDir } : {})
  };
}

function normalizeRunConfig(run: Partial<RunConfig>, filePath: string): RunConfig {
  return {
    outputDir: required(run.outputDir, "run.output_dir", filePath),
    maxParallelAgents: required(run.maxParallelAgents, "run.max_parallel_agents", filePath),
    maxParallelNodes: required(run.maxParallelNodes, "run.max_parallel_nodes", filePath),
    maxDynamicNodes: required(run.maxDynamicNodes, "run.max_dynamic_nodes", filePath),
    keepWorkspaces: required(run.keepWorkspaces, "run.keep_workspaces", filePath),
    forgeGuardEnabled: required(run.forgeGuardEnabled, "run.forge_guard_enabled", filePath),
    forgeVmemLimitKb: required(run.forgeVmemLimitKb, "run.forge_vmem_limit_kb", filePath),
    forgeRayonThreads: required(run.forgeRayonThreads, "run.forge_rayon_threads", filePath),
    workspaceMode: required(run.workspaceMode, "run.workspace_mode", filePath),
    defaultTimeoutSeconds: required(run.defaultTimeoutSeconds, "run.default_timeout_seconds", filePath),
    workflowDeadlineSeconds: required(run.workflowDeadlineSeconds, "run.workflow_deadline_seconds", filePath),
    controllerLeaseSeconds: required(run.controllerLeaseSeconds, "run.controller_lease_seconds", filePath)
  };
}

function normalizePermissions(permissions: Partial<PermissionConfig>, filePath: string): PermissionConfig {
  return {
    trustModel: required(permissions.trustModel, "permissions.trust_model", filePath),
    promptReviewRequired: required(permissions.promptReviewRequired, "permissions.prompt_review_required", filePath),
    materializeOutputsAsUnstaged: required(
      permissions.materializeOutputsAsUnstaged,
      "permissions.materialize_outputs_as_unstaged",
      filePath
    )
  };
}

function normalizeModelProfile(id: string, profile: Partial<ModelProfile>, filePath: string): ModelProfile {
  return {
    id,
    agent: required(profile.agent, `models.${id}.agent`, filePath),
    ...(profile.model !== undefined ? { model: profile.model } : {}),
    ...(profile.reasoning !== undefined ? { reasoning: profile.reasoning } : {}),
    ...(profile.timeoutSeconds !== undefined ? { timeoutSeconds: profile.timeoutSeconds } : {})
  };
}

function requiredRecord<T extends object>(value: T | undefined, label: string, filePath: string): T {
  if (value === undefined) {
    throw new Error(`${filePath} missing required default ${label}`);
  }
  return value;
}

function required<T>(value: T | undefined, label: string, filePath: string): T {
  if (value === undefined) {
    throw new Error(`${filePath} missing required default ${label}`);
  }
  return value;
}

function formatDefaultDiagnostics(diagnostics: Array<{ code: string; message: string }>): string {
  return diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join("; ");
}

function assertResolvedConfig(value: unknown, filePath: string): asserts value is ResolvedConfig {
  if (!isRecord(value)) {
    throw new Error(`${filePath} must contain a mapping`);
  }
  assertString(value.schemaVersion, "schemaVersion", filePath);
  assertNumber(value.dynamicStrategiesEnumerator, "dynamicStrategiesEnumerator", filePath);
  assertRecord(value.project, "project", filePath);
  assertString(value.project.repo, "project.repo", filePath);
  assertRecord(value.run, "run", filePath);
  for (const key of ["outputDir", "workspaceMode"] as const) {
    assertString(value.run[key], `run.${key}`, filePath);
  }
  for (const key of [
    "maxParallelAgents",
    "maxParallelNodes",
    "maxDynamicNodes",
    "forgeVmemLimitKb",
    "forgeRayonThreads",
    "defaultTimeoutSeconds",
    "workflowDeadlineSeconds",
    "controllerLeaseSeconds"
  ] as const) {
    assertNumber(value.run[key], `run.${key}`, filePath);
  }
  assertBoolean(value.run.keepWorkspaces, "run.keepWorkspaces", filePath);
  assertBoolean(value.run.forgeGuardEnabled, "run.forgeGuardEnabled", filePath);
  assertRecord(value.execution, "execution", filePath);
  assertString(value.execution.mode, "execution.mode", filePath);
  assertNumber(value.execution.retentionDays, "execution.retentionDays", filePath);
  assertRecord(value.execution.resources, "execution.resources", filePath);
  assertNumber(value.execution.resources.cpu, "execution.resources.cpu", filePath);
  assertNumber(value.execution.resources.memoryMiB, "execution.resources.memoryMiB", filePath);
  assertNumber(value.execution.resources.timeoutSeconds, "execution.resources.timeoutSeconds", filePath);
  assertRecord(value.execution.nodes, "execution.nodes", filePath);
  assertRecord(value.execution.providers, "execution.providers", filePath);
  assertRecord(value.models, "models", filePath);
  assertString(value.models.default, "models.default", filePath);
  assertBoolean(value.models.synthesizedDefault, "models.synthesizedDefault", filePath);
  assertRecord(value.models.profiles, "models.profiles", filePath);
  for (const [id, profile] of Object.entries(value.models.profiles)) {
    assertRecord(profile, `models.profiles.${id}`, filePath);
    assertString(profile.id, `models.profiles.${id}.id`, filePath);
    assertString(profile.agent, `models.profiles.${id}.agent`, filePath);
    if (profile.reasoning !== undefined) {
      assertString(profile.reasoning, `models.profiles.${id}.reasoning`, filePath);
    }
  }
  assertRecord(value.agents, "agents", filePath);
  for (const [id, agent] of Object.entries(value.agents)) {
    assertRecord(agent, `agents.${id}`, filePath);
    assertString(agent.auth, `agents.${id}.auth`, filePath);
    if (agent.apiKeyEnv !== undefined) {
      assertString(agent.apiKeyEnv, `agents.${id}.apiKeyEnv`, filePath);
    }
    if (agent.configDir !== undefined) {
      assertString(agent.configDir, `agents.${id}.configDir`, filePath);
    }
  }
  assertRecord(value.permissions, "permissions", filePath);
  assertString(value.permissions.trustModel, "permissions.trustModel", filePath);
  if (value.permissions.trustModel !== "skip-permissions") {
    throw new Error(`${filePath} permissions.trustModel must be skip-permissions`);
  }
  assertBoolean(value.permissions.promptReviewRequired, "permissions.promptReviewRequired", filePath);
  assertBoolean(value.permissions.materializeOutputsAsUnstaged, "permissions.materializeOutputsAsUnstaged", filePath);
  assertRecord(value.invariants, "invariants", filePath);
  assertString(value.invariants.propertyPriorityThreshold, "invariants.propertyPriorityThreshold", filePath);
  assertNumber(
    value.invariants.invariantTestingSmokeTimeoutSeconds,
    "invariants.invariantTestingSmokeTimeoutSeconds",
    filePath
  );
  assertNumber(
    value.invariants.invariantTestingFuzzerTimeoutSeconds,
    "invariants.invariantTestingFuzzerTimeoutSeconds",
    filePath
  );
  assertRecord(value.triage, "triage", filePath);
  assertNumber(value.triage.quorum, "triage.quorum", filePath);
  assertNumber(value.triage.panelSize, "triage.panelSize", filePath);
  assertRecord(value.eval, "eval", filePath);
  assertString(value.eval.provider, "eval.provider", filePath);
  assertRecord(value.eval.providers, "eval.providers", filePath);
}

function assertRecord(value: unknown, label: string, filePath: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${filePath} ${label} must be a mapping`);
  }
}

function assertString(value: unknown, label: string, filePath: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${filePath} ${label} must be a non-empty string`);
  }
}

function assertNumber(value: unknown, label: string, filePath: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${filePath} ${label} must be a number`);
  }
}

function assertBoolean(value: unknown, label: string, filePath: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${filePath} ${label} must be a boolean`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
