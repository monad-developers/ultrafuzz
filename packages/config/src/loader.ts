import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, TomlError, type TomlTable } from "smol-toml";
import { CONFIG_FILE_NAME } from "./constants.js";
import {
  diagnostic,
  fail,
  hasErrors,
  ok,
  type AgentAuthMode,
  type AgentConfig,
  type ConfigDiagnostic,
  type ConfigResult,
  type CloudExecutionProvider,
  type ExecutionMode,
  type LoadedProjectConfig,
  type ModelProfile,
  type ProjectConfigInput,
  type RunCompletionPolicy,
  PROJECT_CONFIG_SCHEMA_VERSION,
  type WorkspaceMode
} from "./types.js";

const TOP_LEVEL_KEYS = new Set([
  "schema_version",
  "audit_profile",
  "topology_path",
  "strategy_loops",
  "dynamic_strategies_enumerator",
  "project",
  "run",
  "execution",
  "models",
  "retry",
  "agents",
  "permissions",
  "invariants",
  "triage",
  "eval"
]);

const PROJECT_KEYS = ["repo", "name"] as const;
const RUN_KEYS = [
  "completion_policy",
  "output_dir",
  "max_parallel_agents",
  "max_dynamic_nodes",
  "keep_workspaces",
  "forge_guard_enabled",
  "forge_vmem_limit_kb",
  "forge_rayon_threads",
  "workspace_mode",
  "default_timeout_seconds",
  "workflow_deadline_seconds",
  "controller_lease_seconds"
] as const;
const EXECUTION_KEYS = ["mode", "provider", "retention_days", "resources", "nodes", "providers"] as const;
const EXECUTION_RESOURCE_KEYS = ["cpu", "memory_mib", "timeout_seconds"] as const;
const EXECUTION_NODE_KEYS = ["resources"] as const;
const EXECUTION_PROVIDER_KEYS = ["modal"] as const;
const MODAL_EXECUTION_PROVIDER_KEYS = ["app", "image", "region", "credential_env"] as const;
const MODEL_PROFILE_KEYS = ["agent", "model", "reasoning", "timeout_seconds"] as const;
const RETRY_KEYS = ["same_agent_attempts", "agents"] as const;
const AGENT_KEYS = ["auth", "api_key_env", "config_dir"] as const;
const PERMISSION_KEYS = [
  "trust_model",
  "prompt_review_required",
  "materialize_outputs_as_unstaged",
  "production_source_roots"
] as const;
const INVARIANT_KEYS = [
  "property_priority_threshold",
  "reference_expectation_selection",
  "invariant_testing_smoke_timeout",
  "invariant_testing_fuzzer_timeout",
  "reference_expectation_enforcement"
] as const;
const TRIAGE_KEYS = ["quorum", "panel_size"] as const;
const EVAL_KEYS = ["eval_config", "ground_truth_root", "provider", "providers"] as const;
const EVAL_PROVIDER_KEYS = ["api_key_env", "project", "endpoint"] as const;

export interface LoadProjectConfigOptions {
  fileName?: string;
  allowMissing?: boolean;
}

export async function loadProjectConfig(
  projectRoot: string,
  options: LoadProjectConfigOptions = {}
): Promise<ConfigResult<LoadedProjectConfig>> {
  const fileName = options.fileName ?? CONFIG_FILE_NAME;
  const configPath = join(projectRoot, fileName);
  try {
    const text = await readFile(configPath, "utf8");
    const parsed = parseProjectConfigToml(text, configPath);
    if (!parsed.ok) {
      return parsed;
    }
    return ok(
      {
        path: configPath,
        exists: true,
        config: parsed.value
      },
      parsed.diagnostics
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT" && options.allowMissing !== false) {
      return ok({
        path: configPath,
        exists: false,
        config: {}
      });
    }
    return fail([
      diagnostic("CONFIG_FILE_READ_FAILED", `failed to read ${fileName}`, [], "project-toml", { file: configPath })
    ]);
  }
}

export function parseProjectConfigToml(text: string, file = CONFIG_FILE_NAME): ConfigResult<ProjectConfigInput> {
  let table: TomlTable;
  try {
    table = parse(text);
  } catch (error) {
    return fail([
      diagnostic("CONFIG_TOML_PARSE_FAILED", `${file} is not valid TOML`, [], "project-toml", tomlLocation(error, file))
    ]);
  }

  const diagnostics: ConfigDiagnostic[] = [];
  const root = table as Record<string, unknown>;
  collectUnknownKeys(root, TOP_LEVEL_KEYS, [], diagnostics);

  const config: ProjectConfigInput = {};
  readString(root, "schema_version", ["schema_version"], diagnostics, (value) => {
    if (value !== PROJECT_CONFIG_SCHEMA_VERSION) {
      diagnostics.push(
        diagnostic(
          "CONFIG_SCHEMA_VERSION_UNSUPPORTED",
          `schema_version must be exactly ${PROJECT_CONFIG_SCHEMA_VERSION}`,
          ["schema_version"],
          "project-toml",
          { file }
        )
      );
      return;
    }
    config.schemaVersion = PROJECT_CONFIG_SCHEMA_VERSION;
  });
  readString(root, "audit_profile", ["audit_profile"], diagnostics, (value) => {
    config.auditProfile = value;
  });
  readString(root, "topology_path", ["topology_path"], diagnostics, (value) => {
    config.topologyPath = value;
  });
  readInteger(root, "strategy_loops", ["strategy_loops"], diagnostics, (value) => {
    config.strategyLoops = value;
  });
  readDynamicStrategiesEnumerator(root, diagnostics, (value) => {
    config.dynamicStrategiesEnumerator = value;
  });

  const project = readConfigTable(root, "project", PROJECT_KEYS, diagnostics);
  if (project) {
    const projectConfig: NonNullable<ProjectConfigInput["project"]> = {};
    config.project = projectConfig;
    readScalarFields(project, ["project"], diagnostics, [
      {
        key: "repo",
        type: "string",
        assign: (value) => {
          projectConfig.repo = value;
        }
      },
      {
        key: "name",
        type: "string",
        assign: (value) => {
          projectConfig.name = value;
        }
      }
    ]);
  }

  const run = readConfigTable(root, "run", RUN_KEYS, diagnostics);
  if (run) {
    const runConfig: NonNullable<ProjectConfigInput["run"]> = {};
    config.run = runConfig;
    readScalarFields(run, ["run"], diagnostics, [
      {
        key: "output_dir",
        type: "string",
        assign: (value) => {
          runConfig.outputDir = value;
        }
      },
      {
        key: "max_parallel_agents",
        type: "integer",
        assign: (value) => {
          runConfig.maxParallelAgents = value;
        }
      },
      {
        key: "max_dynamic_nodes",
        type: "integer",
        assign: (value) => {
          runConfig.maxDynamicNodes = value;
        }
      },
      {
        key: "keep_workspaces",
        type: "boolean",
        assign: (value) => {
          runConfig.keepWorkspaces = value;
        }
      },
      {
        key: "forge_guard_enabled",
        type: "boolean",
        assign: (value) => {
          runConfig.forgeGuardEnabled = value;
        }
      },
      {
        key: "forge_vmem_limit_kb",
        type: "integer",
        assign: (value) => {
          runConfig.forgeVmemLimitKb = value;
        }
      },
      {
        key: "forge_rayon_threads",
        type: "integer",
        assign: (value) => {
          runConfig.forgeRayonThreads = value;
        }
      },
      {
        key: "default_timeout_seconds",
        type: "integer",
        assign: (value) => {
          runConfig.defaultTimeoutSeconds = value;
        }
      },
      {
        key: "workflow_deadline_seconds",
        type: "integer",
        assign: (value) => {
          runConfig.workflowDeadlineSeconds = value;
        }
      },
      {
        key: "controller_lease_seconds",
        type: "integer",
        assign: (value) => {
          runConfig.controllerLeaseSeconds = value;
        }
      }
    ]);
    readEnum(
      run,
      "completion_policy",
      ["run", "completion_policy"],
      diagnostics,
      normalizeRunCompletionPolicy,
      (value) => {
        runConfig.completionPolicy = value;
      }
    );
    readEnum(run, "workspace_mode", ["run", "workspace_mode"], diagnostics, normalizeWorkspaceMode, (value) => {
      runConfig.workspaceMode = value;
    });
  }

  const execution = readConfigTable(root, "execution", EXECUTION_KEYS, diagnostics);
  if (execution) {
    const executionConfig: NonNullable<ProjectConfigInput["execution"]> = {};
    config.execution = executionConfig;
    readEnum(execution, "mode", ["execution", "mode"], diagnostics, normalizeExecutionMode, (value) => {
      executionConfig.mode = value;
    });
    readEnum(
      execution,
      "provider",
      ["execution", "provider"],
      diagnostics,
      normalizeCloudExecutionProvider,
      (value) => {
        executionConfig.provider = value;
      }
    );
    readInteger(execution, "retention_days", ["execution", "retention_days"], diagnostics, (value) => {
      executionConfig.retentionDays = value;
    });

    const resources = readConfigTable(execution, "resources", EXECUTION_RESOURCE_KEYS, diagnostics, [
      "execution",
      "resources"
    ]);
    if (resources) {
      executionConfig.resources = {};
      readNumber(resources, "cpu", ["execution", "resources", "cpu"], diagnostics, (value) => {
        executionConfig.resources!.cpu = value;
      });
      readInteger(resources, "memory_mib", ["execution", "resources", "memory_mib"], diagnostics, (value) => {
        executionConfig.resources!.memoryMiB = value;
      });
      readInteger(resources, "timeout_seconds", ["execution", "resources", "timeout_seconds"], diagnostics, (value) => {
        executionConfig.resources!.timeoutSeconds = value;
      });
    }

    const nodes = readTable(execution, "nodes", ["execution", "nodes"], diagnostics);
    if (nodes) {
      executionConfig.nodes = {};
      for (const [id, value] of Object.entries(nodes).sort()) {
        if (!isPlainObject(value)) {
          pushTypeDiagnostic(["execution", "nodes", id], "table", diagnostics);
          continue;
        }
        const node = value as Record<string, unknown>;
        collectUnknownKeys(node, new Set(EXECUTION_NODE_KEYS), ["execution", "nodes", id], diagnostics);
        const override: NonNullable<NonNullable<ProjectConfigInput["execution"]>["nodes"]>[string] = {};
        const nodeResources = readConfigTable(node, "resources", EXECUTION_RESOURCE_KEYS, diagnostics, [
          "execution",
          "nodes",
          id,
          "resources"
        ]);
        if (nodeResources) {
          override.resources = {};
          readNumber(nodeResources, "cpu", ["execution", "nodes", id, "resources", "cpu"], diagnostics, (value) => {
            override.resources!.cpu = value;
          });
          readInteger(
            nodeResources,
            "memory_mib",
            ["execution", "nodes", id, "resources", "memory_mib"],
            diagnostics,
            (value) => {
              override.resources!.memoryMiB = value;
            }
          );
          readInteger(
            nodeResources,
            "timeout_seconds",
            ["execution", "nodes", id, "resources", "timeout_seconds"],
            diagnostics,
            (value) => {
              override.resources!.timeoutSeconds = value;
            }
          );
        }
        executionConfig.nodes[id] = override;
      }
    }

    const providers = readConfigTable(execution, "providers", EXECUTION_PROVIDER_KEYS, diagnostics, [
      "execution",
      "providers"
    ]);
    if (providers) {
      executionConfig.providers = {};
      const modal = readConfigTable(providers, "modal", MODAL_EXECUTION_PROVIDER_KEYS, diagnostics, [
        "execution",
        "providers",
        "modal"
      ]);
      if (modal) {
        const profile: NonNullable<NonNullable<NonNullable<ProjectConfigInput["execution"]>["providers"]>["modal"]> =
          {};
        readScalarFields(modal, ["execution", "providers", "modal"], diagnostics, [
          {
            key: "app",
            type: "string",
            assign: (value) => {
              profile.app = value;
            }
          },
          {
            key: "image",
            type: "string",
            assign: (value) => {
              profile.image = value;
            }
          },
          {
            key: "region",
            type: "string",
            assign: (value) => {
              profile.region = value;
            }
          },
          {
            key: "credential_env",
            type: "string-array",
            assign: (value) => {
              profile.credentialEnv = value;
            }
          }
        ]);
        executionConfig.providers.modal = profile;
      }
    }
  }

  const models = readTable(root, "models", ["models"], diagnostics);
  if (models) {
    config.models = { profiles: {} };
    for (const [key, value] of Object.entries(models).sort()) {
      if (key === "default" && typeof value === "string") {
        config.models.default = value;
        continue;
      }
      if (key === "synthesized_default") {
        if (typeof value === "boolean") {
          config.models.synthesizedDefault = value;
        } else {
          pushTypeDiagnostic(["models", key], "boolean", diagnostics);
        }
        continue;
      }
      if (!isPlainObject(value)) {
        pushTypeDiagnostic(["models", key], "table", diagnostics);
        continue;
      }
      const profile = value as Record<string, unknown>;
      collectUnknownKeys(profile, new Set(MODEL_PROFILE_KEYS), ["models", key], diagnostics);
      const modelProfile: Partial<ModelProfile> & { id?: string } = {};
      readScalarFields(profile, ["models", key], diagnostics, [
        {
          key: "agent",
          type: "string",
          assign: (value) => {
            modelProfile.agent = value;
          }
        },
        {
          key: "model",
          type: "string",
          assign: (value) => {
            modelProfile.model = value;
          }
        },
        {
          key: "reasoning",
          type: "string",
          assign: (value) => {
            modelProfile.reasoning = value;
          }
        },
        {
          key: "timeout_seconds",
          type: "integer",
          assign: (value) => {
            modelProfile.timeoutSeconds = value;
          }
        }
      ]);
      config.models.profiles = {
        ...config.models.profiles,
        [key]: modelProfile
      };
    }
  }

  const retry = readConfigTable(root, "retry", RETRY_KEYS, diagnostics);
  if (retry) {
    const retryConfig: NonNullable<ProjectConfigInput["retry"]> = {};
    config.retry = retryConfig;
    readScalarFields(retry, ["retry"], diagnostics, [
      {
        key: "same_agent_attempts",
        type: "integer",
        assign: (value) => {
          retryConfig.sameAgentAttempts = value;
        }
      },
      {
        key: "agents",
        type: "string-array",
        assign: (value) => {
          retryConfig.agents = value;
        }
      }
    ]);
  }

  const agents = readTable(root, "agents", ["agents"], diagnostics);
  if (agents) {
    config.agents = {};
    for (const [id, value] of Object.entries(agents).sort()) {
      if (!isPlainObject(value)) {
        pushTypeDiagnostic(["agents", id], "table", diagnostics);
        continue;
      }
      const table = value as Record<string, unknown>;
      collectUnknownKeys(table, new Set(AGENT_KEYS), ["agents", id], diagnostics);
      const agentConfig: Partial<AgentConfig> = {};
      readEnum(table, "auth", ["agents", id, "auth"], diagnostics, normalizeAgentAuthMode, (value) => {
        agentConfig.auth = value;
      });
      readScalarFields(table, ["agents", id], diagnostics, [
        {
          key: "api_key_env",
          type: "string",
          assign: (value) => {
            agentConfig.apiKeyEnv = value;
          }
        },
        {
          key: "config_dir",
          type: "string",
          assign: (value) => {
            agentConfig.configDir = value;
          }
        }
      ]);
      config.agents = { ...config.agents, [id]: agentConfig };
    }
  }

  const permissions = readConfigTable(root, "permissions", PERMISSION_KEYS, diagnostics);
  if (permissions) {
    const permissionConfig: NonNullable<ProjectConfigInput["permissions"]> = {};
    config.permissions = permissionConfig;
    readScalarFields(permissions, ["permissions"], diagnostics, [
      {
        key: "trust_model",
        type: "string",
        assign: (value) => {
          permissionConfig.trustModel = value as never;
        }
      },
      {
        key: "prompt_review_required",
        type: "boolean",
        assign: (value) => {
          permissionConfig.promptReviewRequired = value;
        }
      },
      {
        key: "materialize_outputs_as_unstaged",
        type: "boolean",
        assign: (value) => {
          permissionConfig.materializeOutputsAsUnstaged = value;
        }
      },
      {
        key: "production_source_roots",
        type: "string-array",
        assign: (value) => {
          permissionConfig.productionSourceRoots = value;
        }
      }
    ]);
  }

  const invariants = readConfigTable(root, "invariants", INVARIANT_KEYS, diagnostics);
  if (invariants) {
    const invariantConfig: NonNullable<ProjectConfigInput["invariants"]> = {};
    config.invariants = invariantConfig;
    readEnum(
      invariants,
      "property_priority_threshold",
      ["invariants", "property_priority_threshold"],
      diagnostics,
      normalizeInvariantPriority,
      (value) => {
        invariantConfig.propertyPriorityThreshold = value;
      }
    );
    readEnum(
      invariants,
      "reference_expectation_selection",
      ["invariants", "reference_expectation_selection"],
      diagnostics,
      (value) => (value === "priority" || value === "mandatory" ? value : undefined),
      (value) => {
        invariantConfig.referenceExpectationSelection = value;
      }
    );
    readString(
      invariants,
      "invariant_testing_smoke_timeout",
      ["invariants", "invariant_testing_smoke_timeout"],
      diagnostics,
      (value) => {
        const seconds = parseDurationSeconds(value);
        if (seconds === undefined) {
          diagnostics.push(
            diagnostic(
              "CONFIG_DURATION_INVALID",
              "invariants.invariant_testing_smoke_timeout must be a positive duration like 10min, 600s, or 1h",
              ["invariants", "invariant_testing_smoke_timeout"],
              "project-toml"
            )
          );
        } else {
          invariantConfig.invariantTestingSmokeTimeoutSeconds = seconds;
        }
      }
    );
    readString(
      invariants,
      "invariant_testing_fuzzer_timeout",
      ["invariants", "invariant_testing_fuzzer_timeout"],
      diagnostics,
      (value) => {
        const seconds = parseDurationSeconds(value);
        if (seconds === undefined) {
          diagnostics.push(
            diagnostic(
              "CONFIG_DURATION_INVALID",
              "invariants.invariant_testing_fuzzer_timeout must be a positive duration like 30min, 1800s, or 1h",
              ["invariants", "invariant_testing_fuzzer_timeout"],
              "project-toml"
            )
          );
        } else {
          invariantConfig.invariantTestingFuzzerTimeoutSeconds = seconds;
        }
      }
    );
    readEnum(
      invariants,
      "reference_expectation_enforcement",
      ["invariants", "reference_expectation_enforcement"],
      diagnostics,
      normalizeReferenceExpectationEnforcement,
      (value) => {
        invariantConfig.referenceExpectationEnforcement = value;
      }
    );
  }

  const triage = readConfigTable(root, "triage", TRIAGE_KEYS, diagnostics);
  if (triage) {
    const triageConfig: NonNullable<ProjectConfigInput["triage"]> = {};
    config.triage = triageConfig;
    readScalarFields(triage, ["triage"], diagnostics, [
      {
        key: "quorum",
        type: "integer",
        assign: (value) => {
          triageConfig.quorum = value;
        }
      },
      {
        key: "panel_size",
        type: "integer",
        assign: (value) => {
          triageConfig.panelSize = value;
        }
      }
    ]);
  }

  const evalTable = readConfigTable(root, "eval", EVAL_KEYS, diagnostics);
  if (evalTable) {
    const evalConfig: NonNullable<ProjectConfigInput["eval"]> = {};
    config.eval = evalConfig;
    readScalarFields(evalTable, ["eval"], diagnostics, [
      {
        key: "eval_config",
        type: "string",
        assign: (value) => {
          evalConfig.evalConfig = value;
        }
      },
      {
        key: "ground_truth_root",
        type: "string",
        assign: (value) => {
          evalConfig.groundTruthRoot = value;
        }
      },
      {
        key: "provider",
        type: "string",
        assign: (value) => {
          evalConfig.provider = value;
        }
      }
    ]);
    const providers = readTable(evalTable, "providers", ["eval", "providers"], diagnostics);
    if (providers) {
      evalConfig.providers = {};
      for (const [name, value] of Object.entries(providers).sort()) {
        if (!isPlainObject(value)) {
          pushTypeDiagnostic(["eval", "providers", name], "table", diagnostics);
          continue;
        }
        const profileTable = value as Record<string, unknown>;
        collectUnknownKeys(profileTable, new Set(EVAL_PROVIDER_KEYS), ["eval", "providers", name], diagnostics);
        const profile: NonNullable<NonNullable<ProjectConfigInput["eval"]>["providers"]>[string] = {};
        readScalarFields(profileTable, ["eval", "providers", name], diagnostics, [
          {
            key: "api_key_env",
            type: "string",
            assign: (value) => {
              profile.apiKeyEnv = value;
            }
          },
          {
            key: "project",
            type: "string",
            assign: (value) => {
              profile.project = value;
            }
          },
          {
            key: "endpoint",
            type: "string",
            assign: (value) => {
              profile.endpoint = value;
            }
          }
        ]);
        evalConfig.providers[name] = profile;
      }
    }
  }

  if (hasErrors(diagnostics)) {
    return fail(diagnostics);
  }
  return ok(config);
}

type ScalarField =
  | {
      key: string;
      type: "string";
      assign: (value: string) => void;
    }
  | {
      key: string;
      type: "integer";
      assign: (value: number) => void;
    }
  | {
      key: string;
      type: "boolean";
      assign: (value: boolean) => void;
    }
  | {
      key: string;
      type: "string-array";
      assign: (value: string[]) => void;
    };

function readConfigTable(
  table: Record<string, unknown>,
  key: string,
  allowedKeys: readonly string[],
  diagnostics: ConfigDiagnostic[],
  path: string[] = [key]
): Record<string, unknown> | undefined {
  const child = readTable(table, key, path, diagnostics);
  if (child) {
    collectUnknownKeys(child, new Set(allowedKeys), path, diagnostics);
  }
  return child;
}

function readScalarFields(
  table: Record<string, unknown>,
  basePath: string[],
  diagnostics: ConfigDiagnostic[],
  fields: readonly ScalarField[]
): void {
  for (const field of fields) {
    const path = [...basePath, field.key];
    switch (field.type) {
      case "string":
        readString(table, field.key, path, diagnostics, field.assign);
        break;
      case "integer":
        readInteger(table, field.key, path, diagnostics, field.assign);
        break;
      case "boolean":
        readBoolean(table, field.key, path, diagnostics, field.assign);
        break;
      case "string-array":
        readStringArray(table, field.key, path, diagnostics, field.assign);
        break;
    }
  }
}

function readTable(
  table: Record<string, unknown>,
  key: string,
  path: string[],
  diagnostics: ConfigDiagnostic[]
): Record<string, unknown> | undefined {
  const value = table[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    pushTypeDiagnostic(path, "table", diagnostics);
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readString(
  table: Record<string, unknown>,
  key: string,
  path: string[],
  diagnostics: ConfigDiagnostic[],
  assign: (value: string) => void
): void {
  const value = table[key];
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string") {
    pushTypeDiagnostic(path, "string", diagnostics);
    return;
  }
  assign(value);
}

function readInteger(
  table: Record<string, unknown>,
  key: string,
  path: string[],
  diagnostics: ConfigDiagnostic[],
  assign: (value: number) => void
): void {
  const value = table[key];
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    pushTypeDiagnostic(path, "integer", diagnostics);
    return;
  }
  assign(value);
}

function readDynamicStrategiesEnumerator(
  table: Record<string, unknown>,
  diagnostics: ConfigDiagnostic[],
  assign: (value: number | "unlimited") => void
): void {
  const path = ["dynamic_strategies_enumerator"];
  const value = table.dynamic_strategies_enumerator;
  if (value === undefined) return;
  if (value === "unlimited" || (typeof value === "number" && Number.isInteger(value))) {
    assign(value);
    return;
  }
  pushTypeDiagnostic(path, "non-negative integer or `unlimited`", diagnostics);
}

function readNumber(
  table: Record<string, unknown>,
  key: string,
  path: string[],
  diagnostics: ConfigDiagnostic[],
  assign: (value: number) => void
): void {
  const value = table[key];
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    pushTypeDiagnostic(path, "number", diagnostics);
    return;
  }
  assign(value);
}

function readBoolean(
  table: Record<string, unknown>,
  key: string,
  path: string[],
  diagnostics: ConfigDiagnostic[],
  assign: (value: boolean) => void
): void {
  const value = table[key];
  if (value === undefined) {
    return;
  }
  if (typeof value !== "boolean") {
    pushTypeDiagnostic(path, "boolean", diagnostics);
    return;
  }
  assign(value);
}

function readStringArray(
  table: Record<string, unknown>,
  key: string,
  path: string[],
  diagnostics: ConfigDiagnostic[],
  assign: (value: string[]) => void
): void {
  const value = table[key];
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    pushTypeDiagnostic(path, "string array", diagnostics);
    return;
  }
  assign([...value]);
}

function readEnum<T extends string>(
  table: Record<string, unknown>,
  key: string,
  path: string[],
  diagnostics: ConfigDiagnostic[],
  normalize: (value: string) => T | undefined,
  assign: (value: T) => void
): void {
  const value = table[key];
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string") {
    pushTypeDiagnostic(path, "string", diagnostics);
    return;
  }
  const normalized = normalize(value);
  if (normalized === undefined) {
    diagnostics.push(
      diagnostic("CONFIG_ENUM_INVALID", `${path.join(".")} has an unsupported value`, path, "project-toml")
    );
    return;
  }
  assign(normalized);
}

function collectUnknownKeys(
  table: Record<string, unknown>,
  allowed: Set<string>,
  path: string[],
  diagnostics: ConfigDiagnostic[]
): void {
  for (const key of Object.keys(table).sort()) {
    if (!allowed.has(key)) {
      diagnostics.push(
        diagnostic(
          "CONFIG_UNKNOWN_FIELD",
          `unknown config field ${[...path, key].join(".")}`,
          path.concat(key),
          "project-toml"
        )
      );
    }
  }
}

function pushTypeDiagnostic(path: string[], expected: string, diagnostics: ConfigDiagnostic[]): void {
  diagnostics.push(
    diagnostic("CONFIG_FIELD_TYPE_INVALID", `${path.join(".")} must be a ${expected}`, path, "project-toml")
  );
}

function normalizeWorkspaceMode(value: string): WorkspaceMode | undefined {
  switch (value.trim().toLowerCase().replaceAll("_", "-")) {
    case "git-worktree":
      return value.trim().toLowerCase().replaceAll("_", "-") as WorkspaceMode;
    default:
      return undefined;
  }
}

function normalizeRunCompletionPolicy(value: string): RunCompletionPolicy | undefined {
  return value === "best-effort" || value === "require-complete" ? value : undefined;
}

function normalizeExecutionMode(value: string): ExecutionMode | undefined {
  return value === "local" || value === "cloud" ? value : undefined;
}

function normalizeCloudExecutionProvider(value: string): CloudExecutionProvider | undefined {
  return value === "modal" ? value : undefined;
}

function normalizeAgentAuthMode(value: string): AgentAuthMode | undefined {
  switch (value.trim().toLowerCase().replaceAll("_", "-")) {
    case "api-key":
    case "subscription":
      return value.trim().toLowerCase().replaceAll("_", "-") as AgentAuthMode;
    default:
      return undefined;
  }
}

function normalizeInvariantPriority(value: string): "high" | "medium" | "low" | undefined {
  switch (value.trim().toLowerCase()) {
    case "high":
    case "medium":
    case "low":
      return value.trim().toLowerCase() as "high" | "medium" | "low";
    default:
      return undefined;
  }
}

function normalizeReferenceExpectationEnforcement(value: string): "warn" | "fail" | undefined {
  switch (value.trim().toLowerCase()) {
    case "warn":
    case "fail":
      return value.trim().toLowerCase() as "warn" | "fail";
    default:
      return undefined;
  }
}

function parseDurationSeconds(value: string): number | undefined {
  const match = /^([1-9][0-9]*)(s|min|h)$/.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  switch (match[2]) {
    case "s":
      return amount;
    case "min":
      return amount * 60;
    case "h":
      return amount * 60 * 60;
    default:
      return undefined;
  }
}

function tomlLocation(error: unknown, file: string): { file: string; line?: number; column?: number } {
  if (error instanceof TomlError) {
    return { file, line: error.line, column: error.column };
  }
  return { file };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
