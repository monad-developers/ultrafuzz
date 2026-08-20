import fs from "node:fs";

import { PROJECT_CONFIG_SCHEMA_VERSION } from "@ultrafuzz/config";

import {
  DEFAULT_MODAL_MAX_PARALLEL_AGENTS,
  DEFAULT_MODAL_MAX_PARALLEL_NODES,
  type ModalModelSpec,
  type ModelProvider
} from "./defaults.js";
export function modalTargetToml(model: ModalModelSpec, nodeTimeoutSeconds: number, auditProfile = "default"): string {
  const selectedProfile = modelProfileToml(model);
  const dynamicStrategiesEnumerator = auditProfile === "smoke" ? "" : "dynamic_strategies_enumerator = 3\n";
  const codex = agentToml(model, "CodexAgent", "openai");
  const claude = agentToml(model, "ClaudeAgent", "anthropic");
  const deepseek = agentToml(model, "DeepSeekAgent", "deepseek");
  const kimi = agentToml(model, "KimiAgent", "kimi");
  const openrouter = agentToml(model, "OpenRouterAgent", "openrouter");
  return `schema_version = "${PROJECT_CONFIG_SCHEMA_VERSION}"
audit_profile = ${tomlString(auditProfile)}
${dynamicStrategiesEnumerator}
[project]
repo = "."

[run]
output_dir = ".ultrafuzz/runs"
max_parallel_agents = ${DEFAULT_MODAL_MAX_PARALLEL_AGENTS}
max_parallel_nodes = ${DEFAULT_MODAL_MAX_PARALLEL_NODES}
keep_workspaces = false
workspace_mode = "git-worktree"
default_timeout_seconds = ${nodeTimeoutSeconds}

[models]
synthesized_default = false

[models.default]
${selectedProfile}

[models.benchmark]
${selectedProfile}

${codex}

${claude}

${deepseek}

${kimi}

${openrouter}

[permissions]
trust_model = "skip-permissions"
prompt_review_required = true
materialize_outputs_as_unstaged = true

[invariants]
property_priority_threshold = "high"
invariant_testing_smoke_timeout = "10min"
invariant_testing_fuzzer_timeout = "1h"

[triage]
quorum = 3
panel_size = 4

[eval]
provider = "none"
`;
}

export function capModalTargetTopologyTimeouts(topologyPath: string, maximumSeconds: number): void {
  if (!Number.isInteger(maximumSeconds) || maximumSeconds <= 0) {
    throw new Error("Modal target topology timeout must be a positive integer");
  }
  const topology = fs.readFileSync(topologyPath, "utf8");
  const capped = topology.replace(
    /^([\t ]*timeout_seconds:[\t ]*)(\d+)[\t ]*$/gmu,
    (_line, prefix: string, raw: string) => `${prefix}${Math.min(Number(raw), maximumSeconds)}`
  );
  fs.writeFileSync(topologyPath, capped, "utf8");
}

function modelProfileToml(model: ModalModelSpec): string {
  return `agent = ${tomlString(model.agent)}
model = ${tomlString(model.model)}
reasoning = ${tomlString(model.reasoning)}`;
}

function agentToml(selectedModel: ModalModelSpec, agent: ModalModelSpec["agent"], provider: ModelProvider): string {
  const selected = selectedModel.agent === agent;
  const auth = selected
    ? selectedModel.auth_mode
    : provider === "deepseek" || provider === "openrouter"
      ? "api-key"
      : "subscription";
  if (auth === "api-key") {
    return `[agents.${agent}]\nauth = "api-key"\napi_key_env = ${tomlString(apiKeyEnv(provider))}`;
  }
  return `[agents.${agent}]\nauth = "subscription"`;
}

function apiKeyEnv(provider: ModelProvider): string {
  if (provider === "openai") return "OPENAI_API_KEY";
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  if (provider === "deepseek") return "DEEPSEEK_API_KEY";
  if (provider === "openrouter") return "OPENROUTER_API_KEY";
  return "KIMI_API_KEY";
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
