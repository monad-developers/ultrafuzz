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
  type LoadedProjectConfig,
  type ModelProfile,
  type ProjectConfigInput,
  type WorkspaceMode
} from "./types.js";

const TOP_LEVEL_KEYS = new Set([
  "schema_version",
  "dynamic_strategies_enumerator",
  "project",
  "run",
  "models",
  "agents",
  "permissions",
  "invariants",
  "triage"
]);

const PROJECT_KEYS = ["repo", "name"] as const;
const RUN_KEYS = [
  "output_dir",
  "max_parallel_agents",
  "max_parallel_nodes",
  "keep_workspaces",
  "workspace_mode",
  "default_timeout_seconds"
] as const;
const MODEL_PROFILE_KEYS = ["agent", "model", "timeout_seconds"] as const;
const AGENT_KEYS = ["auth", "api_key_env", "config_dir"] as const;
const PERMISSION_KEYS = ["trust_model", "prompt_review_required", "materialize_outputs_as_unstaged"] as const;
const INVARIANT_KEYS = ["property_priority_threshold", "invariant_testing_fuzzer_timeout"] as const;
const TRIAGE_KEYS = ["quorum", "panel_size"] as const;

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
    config.schemaVersion = value;
  });
  readInteger(root, "dynamic_strategies_enumerator", ["dynamic_strategies_enumerator"], diagnostics, (value) => {
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
        key: "max_parallel_nodes",
        type: "integer",
        assign: (value) => {
          runConfig.maxParallelNodes = value;
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
        key: "default_timeout_seconds",
        type: "integer",
        assign: (value) => {
          runConfig.defaultTimeoutSeconds = value;
        }
      }
    ]);
    readEnum(run, "workspace_mode", ["run", "workspace_mode"], diagnostics, normalizeWorkspaceMode, (value) => {
      runConfig.workspaceMode = value;
    });
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
      config.agents[id] = agentConfig;
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
  diagnostics: ConfigDiagnostic[]
): Record<string, unknown> | undefined {
  const child = readTable(table, key, [key], diagnostics);
  if (child) {
    collectUnknownKeys(child, new Set(allowedKeys), [key], diagnostics);
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
