import fs from "node:fs";

import {
  DEFAULT_MODAL_APP,
  DEFAULT_MODAL_IMAGE,
  DEFAULT_MODAL_MAX_PARALLEL_AGENTS,
  DEFAULT_MODAL_MAX_PARALLEL_NODES,
  type ModalModelSpec,
  type ModelProvider
} from "./defaults.js";
import { remoteAuthDir } from "./layout.js";

export interface ModalTargetExecutionOptions {
  app?: string;
  image?: string;
  region?: string;
}

export function modalTargetToml(
  model: ModalModelSpec,
  nodeTimeoutSeconds: number,
  execution: ModalTargetExecutionOptions = {}
): string {
  const selectedProfile = modelProfileToml(model);
  const codex = agentToml(model, "CodexAgent", "openai");
  const claude = agentToml(model, "ClaudeAgent", "anthropic");
  const deepseek = agentToml(model, "DeepSeekAgent", "deepseek");
  const kimi = agentToml(model, "KimiAgent", "kimi");
  const modalApp = execution.app ?? DEFAULT_MODAL_APP;
  const modalImage = execution.image ?? DEFAULT_MODAL_IMAGE;
  const serialKimiSubscription = model.provider === "kimi" && model.auth_mode === "subscription";
  const maxParallelAgents = serialKimiSubscription ? 1 : DEFAULT_MODAL_MAX_PARALLEL_AGENTS;
  const maxParallelNodes = serialKimiSubscription ? 1 : DEFAULT_MODAL_MAX_PARALLEL_NODES;
  return `schema_version = "1.0"
dynamic_strategies_enumerator = 3

[project]
repo = "."

[run]
output_dir = ".ultrafuzz/runs"
max_parallel_agents = ${maxParallelAgents}
max_parallel_nodes = ${maxParallelNodes}
keep_workspaces = false
workspace_mode = "git-worktree"
default_timeout_seconds = ${nodeTimeoutSeconds}

[execution]
mode = "cloud"
provider = "modal"

[execution.resources]
timeout_seconds = ${nodeTimeoutSeconds}

[execution.providers.modal]
app = ${tomlString(modalApp)}
image = ${tomlString(modalImage)}
${execution.region === undefined ? "" : `region = ${tomlString(execution.region)}\n`}credential_env = ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]

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

[permissions]
trust_model = "skip-permissions"
prompt_review_required = true
materialize_outputs_as_unstaged = true

[invariants]
property_priority_threshold = "high"
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
  const auth = selected ? selectedModel.auth_mode : provider === "deepseek" ? "api-key" : "subscription";
  if (auth === "api-key") {
    return `[agents.${agent}]\nauth = "api-key"\napi_key_env = ${tomlString(apiKeyEnv(provider))}`;
  }
  return `[agents.${agent}]\nauth = "subscription"\nconfig_dir = ${tomlString(remoteAuthDir(provider))}`;
}

function apiKeyEnv(provider: ModelProvider): string {
  if (provider === "openai") return "OPENAI_API_KEY";
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  if (provider === "deepseek") return "DEEPSEEK_API_KEY";
  return "KIMI_API_KEY";
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
