import { z, type ZodIssue } from "zod/v4";
import { diagnostic, type AgentConfig, type ConfigDiagnostic } from "./types.js";

const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROVIDER_HOME_COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const STOCK_AGENT_IDS = ["ClaudeAgent", "CodexAgent", "DeepSeekAgent", "KimiAgent", "OpenRouterAgent"] as const;
const BUILT_IN_CREDENTIAL_ENVIRONMENT_VARIABLES: Readonly<Record<(typeof STOCK_AGENT_IDS)[number], string>> = {
  ClaudeAgent: "ANTHROPIC_API_KEY",
  CodexAgent: "OPENAI_API_KEY",
  DeepSeekAgent: "DEEPSEEK_API_KEY",
  KimiAgent: "KIMI_API_KEY",
  OpenRouterAgent: "OPENROUTER_API_KEY"
};

const agentIdSchema = z.enum(STOCK_AGENT_IDS);

const apiKeyEnvSchema = z.string().regex(ENVIRONMENT_VARIABLE_PATTERN);
const configDirSchema = z.string().refine(safeProviderHomeRelativePath);

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

const agentConfigsSchema = z.partialRecord(agentIdSchema, agentConfigSchema);

export function validateAgentConfigs(agents: Record<string, AgentConfig>): ConfigDiagnostic[] {
  const unsupported = Object.keys(agents).filter((agent) => !(STOCK_AGENT_IDS as readonly string[]).includes(agent));
  // prettier-ignore
  if (unsupported.length > 0) return unsupported.map((agent) => diagnostic("CONFIG_AGENT_ID_INVALID", `agent config id \`${agent}\` must name a packaged stock agent`, ["agents", agent], "validation"));
  const parsed = agentConfigsSchema.safeParse(agents);
  if (parsed.success) {
    return validateProviderAgentConfigs(parsed.data);
  }
  return parsed.error.issues.map(agentConfigDiagnostic);
}

function validateProviderAgentConfigs(agents: Record<string, AgentConfig>): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];
  for (const [agentRef, canonicalName] of Object.entries(BUILT_IN_CREDENTIAL_ENVIRONMENT_VARIABLES)) {
    const configured = agents[agentRef]?.apiKeyEnv;
    if (configured !== undefined && configured !== canonicalName) {
      diagnostics.push(
        diagnostic(
          "CONFIG_AGENT_API_KEY_ENV_NONCANONICAL",
          `${agentRef}.api_key_env must use the canonical operator-owned credential name ${canonicalName}`,
          ["agents", agentRef, "api_key_env"],
          "validation"
        )
      );
    }
  }
  if (agents.DeepSeekAgent?.auth === "subscription") {
    diagnostics.push(
      diagnostic(
        "CONFIG_AGENT_DEEPSEEK_AUTH_UNSUPPORTED",
        "DeepSeekAgent supports only api-key authentication",
        ["agents", "DeepSeekAgent", "auth"],
        "validation"
      )
    );
  }
  if (agents.OpenRouterAgent?.auth === "subscription") {
    diagnostics.push(
      diagnostic(
        "CONFIG_AGENT_OPENROUTER_AUTH_UNSUPPORTED",
        "OpenRouterAgent supports only api-key authentication",
        ["agents", "OpenRouterAgent", "auth"],
        "validation"
      )
    );
  }
  return diagnostics;
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
    return "CONFIG_AGENT_CONFIG_DIR_UNSAFE";
  }
  return "CONFIG_AGENT_AUTH_INVALID";
}

function agentConfigDiagnosticMessage(code: string, issue: ZodIssue): string {
  switch (code) {
    case "CONFIG_AGENT_ID_INVALID":
      return `agent config id \`${String(issue.path[0] ?? "")}\` must name a packaged stock agent`;
    case "CONFIG_AGENT_API_KEY_ENV_REQUIRED":
      return "agent api-key auth requires api_key_env";
    case "CONFIG_AGENT_API_KEY_ENV_INVALID":
      return "agent api_key_env must be an environment variable name";
    case "CONFIG_AGENT_CONFIG_DIR_UNSAFE":
      return "agent config_dir must be a safe relative path beneath the operator-owned Ultrafuzz provider-home root";
    case "CONFIG_AGENT_FIELD_UNKNOWN":
      return `agent config contains unknown field \`${issue.code === "unrecognized_keys" ? (issue.keys[0] ?? "") : ""}\``;
    default:
      return "agent auth must be api-key or subscription";
  }
}

// prettier-ignore
function safeProviderHomeRelativePath(value: string): boolean { if (value.length === 0 || value.length > 1024 || value.trim() !== value || value.includes("\\") || value.startsWith("/")) return false; return value.split("/").every((component) => component !== "." && component !== ".." && PROVIDER_HOME_COMPONENT_PATTERN.test(component)); }

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
