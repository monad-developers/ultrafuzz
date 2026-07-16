import type { ModalModelSpec, ModelProvider } from "./defaults.js";
import { remoteAuthDir } from "./layout.js";

export interface ModalTargetRunConfig {
  max_parallel_agents: number;
  max_parallel_nodes: number;
}

export function modalTargetToml(
  model: ModalModelSpec,
  nodeTimeoutSeconds: number,
  targetRun: ModalTargetRunConfig = { max_parallel_agents: 4, max_parallel_nodes: 8 }
): string {
  const selectedProfile = modelProfileToml(model);
  const codex = agentToml(model, "CodexAgent", "openai");
  const claude = agentToml(model, "ClaudeAgent", "anthropic");
  return `schema_version = "1.0"
dynamic_strategies_enumerator = 3

[project]
repo = "."

[run]
output_dir = ".ultrafuzz/runs"
max_parallel_agents = ${targetRun.max_parallel_agents}
max_parallel_nodes = ${targetRun.max_parallel_nodes}
keep_workspaces = true
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

function modelProfileToml(model: ModalModelSpec): string {
  return `agent = ${tomlString(model.agent)}
model = ${tomlString(model.model)}
reasoning = ${tomlString(model.reasoning)}`;
}

function agentToml(selectedModel: ModalModelSpec, agent: ModalModelSpec["agent"], provider: ModelProvider): string {
  const selected = selectedModel.agent === agent;
  const auth = selected ? selectedModel.auth_mode : "subscription";
  if (auth === "api-key") {
    return `[agents.${agent}]\nauth = "api-key"\napi_key_env = ${tomlString(
      provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"
    )}`;
  }
  return `[agents.${agent}]\nauth = "subscription"\nconfig_dir = ${tomlString(remoteAuthDir(provider))}`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
