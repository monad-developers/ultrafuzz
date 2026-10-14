import { isSensitiveEnvironmentName } from "@ultrafuzz/security";

const ROUTE_ENV_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  ClaudeAgent: ["ANTHROPIC_", "CLAUDE_CODE_USE_", "AWS_", "AZURE_", "CLOUD_ML_", "FOUNDRY_", "GOOGLE_"],
  CodexAgent: ["AZURE_OPENAI_", "OPENAI_"],
  KimiAgent: ["KIMI_", "MOONSHOT_"]
};

/**
 * Provider credentials every model child has blanked. Only the adapter that
 * owns one restores it, from its configured authentication; an
 * ULTRAFUZZ_AGENT_ENV_ALLOWLIST entry never does.
 */
export const BUILT_IN_PROVIDER_CREDENTIAL_ENVIRONMENT_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "AZURE_OPENAI_API_KEY",
  // Claude Code's `claude setup-token` login; only the subscription Claude
  // adapter puts it back (#1266).
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CODEX_API_KEY",
  "DEEPSEEK_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY"
] as const;

/**
 * Claude Code's documented non-interactive login: a long-lived token from
 * `claude setup-token`. A subscription-mode ClaudeAgent receives it the way an
 * api-key agent receives its key, and every other model child has it blanked
 * (#1266).
 */
export const CLAUDE_SUBSCRIPTION_TOKEN_ENVIRONMENT_VARIABLE = "CLAUDE_CODE_OAUTH_TOKEN";

/** The credential variables an agent's adapter reads for its configured authentication. */
export function agentAuthenticationEnvironmentVariableNames(
  agentRef: string,
  agent: { auth?: string; apiKeyEnv?: string }
): string[] {
  if (agent.auth === "api-key" && agent.apiKeyEnv !== undefined) {
    return agentRef === "KimiAgent" && agent.apiKeyEnv === "KIMI_API_KEY"
      ? [agent.apiKeyEnv, "MOONSHOT_API_KEY"]
      : [agent.apiKeyEnv];
  }
  if (agentRef === "ClaudeAgent" && agent.auth === "subscription") {
    return [CLAUDE_SUBSCRIPTION_TOKEN_ENVIRONMENT_VARIABLE];
  }
  return [];
}

export function isCredentialLikeEnvironmentVariableName(name: string): boolean {
  return isSensitiveEnvironmentName(name);
}

/**
 * Assign an allowlisted credential-like variable to the provider route with
 * the most specific matching prefix. For example, AZURE_OPENAI_* belongs to
 * Codex rather than the broader Claude AZURE_* route.
 */
export function routeOwnsCredentialLikeEnvironmentVariable(agent: string, name: string): boolean {
  const upper = name.toUpperCase();
  let longestPrefix = -1;
  const owners = new Set<string>();
  for (const [candidate, prefixes] of Object.entries(ROUTE_ENV_PREFIXES)) {
    for (const prefix of prefixes) {
      if (!upper.startsWith(prefix) || prefix.length < longestPrefix) continue;
      if (prefix.length > longestPrefix) {
        longestPrefix = prefix.length;
        owners.clear();
      }
      owners.add(candidate);
    }
  }
  return owners.has(agent);
}
