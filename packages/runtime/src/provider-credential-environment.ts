import { isSensitiveEnvironmentName } from "@ultrafuzz/security";

const ROUTE_ENV_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  ClaudeAgent: ["ANTHROPIC_", "CLAUDE_CODE_USE_", "AWS_", "AZURE_", "CLOUD_ML_", "FOUNDRY_", "GOOGLE_"],
  CodexAgent: ["AZURE_OPENAI_", "OPENAI_"],
  KimiAgent: ["KIMI_", "MOONSHOT_"]
};

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
