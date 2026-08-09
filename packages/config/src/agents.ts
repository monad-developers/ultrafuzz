import { z, type ZodIssue } from "zod/v4";
import { diagnostic, type AgentConfig, type ConfigDiagnostic } from "./types.js";

const SAFE_AGENT_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const agentIdSchema = z
  .string()
  .regex(SAFE_AGENT_REF_PATTERN)
  .refine((value) => !value.includes(".."));

const apiKeyEnvSchema = z.string().regex(ENVIRONMENT_VARIABLE_PATTERN);
const configDirSchema = z.string().refine((value) => value.trim().length > 0);

const agentConfigSchema = z.discriminatedUnion("auth", [
  z.strictObject({
    auth: z.literal("api-key"),
    apiKeyEnv: apiKeyEnvSchema,
    configDir: configDirSchema.optional()
  }),
  z.strictObject({
    auth: z.literal("subscription"),
    apiKeyEnv: apiKeyEnvSchema.optional(),
    configDir: configDirSchema.optional()
  })
]);

const agentConfigsSchema = z.record(agentIdSchema, agentConfigSchema);

export function validateAgentConfigs(agents: Record<string, AgentConfig>): ConfigDiagnostic[] {
  const parsed = agentConfigsSchema.safeParse(agents);
  if (parsed.success) {
    return validateProviderAgentConfigs(parsed.data);
  }
  return parsed.error.issues.map(agentConfigDiagnostic);
}

function validateProviderAgentConfigs(agents: Record<string, AgentConfig>): ConfigDiagnostic[] {
  if (agents.DeepSeekAgent?.auth !== "subscription") return [];
  return [
    diagnostic(
      "CONFIG_AGENT_DEEPSEEK_AUTH_UNSUPPORTED",
      "DeepSeekAgent supports only api-key authentication",
      ["agents", "DeepSeekAgent", "auth"],
      "validation"
    )
  ];
}

function agentConfigDiagnostic(issue: ZodIssue): ConfigDiagnostic {
  const code = agentConfigDiagnosticCode(issue);
  return diagnostic(code, agentConfigDiagnosticMessage(code, issue), agentConfigPath(issue), "validation");
}

function agentConfigDiagnosticCode(issue: ZodIssue): string {
  if (issue.code === "invalid_key") {
    return "CONFIG_AGENT_ID_INVALID";
  }
  if (issue.code === "unrecognized_keys") {
    return "CONFIG_AGENT_FIELD_UNKNOWN";
  }
  const field = String(issue.path[1] ?? "");
  if (field === "auth") {
    return "CONFIG_AGENT_AUTH_INVALID";
  }
  if (field === "apiKeyEnv") {
    return issue.code === "invalid_type" ? "CONFIG_AGENT_API_KEY_ENV_REQUIRED" : "CONFIG_AGENT_API_KEY_ENV_INVALID";
  }
  if (field === "configDir") {
    return "CONFIG_AGENT_CONFIG_DIR_EMPTY";
  }
  return "CONFIG_AGENT_AUTH_INVALID";
}

function agentConfigDiagnosticMessage(code: string, issue: ZodIssue): string {
  switch (code) {
    case "CONFIG_AGENT_ID_INVALID":
      return `agent config id \`${String(issue.path[0] ?? "")}\` must be a safe agent reference`;
    case "CONFIG_AGENT_API_KEY_ENV_REQUIRED":
      return "agent api-key auth requires api_key_env";
    case "CONFIG_AGENT_API_KEY_ENV_INVALID":
      return "agent api_key_env must be an environment variable name";
    case "CONFIG_AGENT_CONFIG_DIR_EMPTY":
      return "agent config_dir cannot be empty";
    case "CONFIG_AGENT_FIELD_UNKNOWN":
      return `agent config contains unknown field \`${issue.code === "unrecognized_keys" ? (issue.keys[0] ?? "") : ""}\``;
    default:
      return "agent auth must be api-key or subscription";
  }
}

function agentConfigPath(issue: ZodIssue): string[] {
  if (issue.code === "invalid_key") {
    return ["agents", String(issue.path[0] ?? "")];
  }
  const path = ["agents", ...issue.path.map((segment) => camelCaseConfigPathSegment(String(segment)))];
  return issue.code === "unrecognized_keys" ? [...path, issue.keys[0] ?? ""] : path;
}

function camelCaseConfigPathSegment(segment: string): string {
  switch (segment) {
    case "apiKeyEnv":
      return "api_key_env";
    case "configDir":
      return "config_dir";
    default:
      return segment;
  }
}
