import os from "node:os";
import path from "node:path";

import type { ModalModelSpec, ModelProvider } from "./defaults.js";
import { remoteAuthPath } from "./layout.js";

export interface SubscriptionAuthCopy {
  source: string;
  destination: string;
}

export function subscriptionAuthCopy(
  model: Pick<ModalModelSpec, "provider" | "auth_mode">,
  env: Record<string, string | undefined> = process.env,
  home = os.homedir()
): SubscriptionAuthCopy | undefined {
  if (model.auth_mode !== "subscription") {
    return undefined;
  }
  return {
    source: localSubscriptionAuthPath(model.provider, env, home),
    destination: remoteAuthPath(model.provider)
  };
}

export function localSubscriptionAuthPath(
  provider: ModelProvider,
  env: Record<string, string | undefined> = process.env,
  home = os.homedir()
): string {
  if (provider === "openai") {
    return path.join(env.CODEX_HOME ?? path.join(home, ".codex"), "auth.json");
  }
  return path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), ".credentials.json");
}

export function runnerApiKeyEnv(provider: ModelProvider): "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" {
  return provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
}
