import fs from "node:fs";

import {
  DEFAULT_MODAL_MAX_PARALLEL_AGENTS,
  DEFAULT_MODAL_MAX_PARALLEL_NODES,
  type ModalModelSpec,
  type ModelProvider
} from "./defaults.js";
import { remoteAuthDir } from "./layout.js";

export interface ModalTargetCloudExecution {
  app: string;
  image: string;
  providerCredentialEnv?: readonly [string, string];
  resourceOverrideNodeId: string;
}

export function modalTargetToml(
  model: ModalModelSpec,
  nodeTimeoutSeconds: number,
  cloud?: ModalTargetCloudExecution,
  options: { smokeWorkflow?: boolean } = {}
): string {
  const selectedProfile = modelProfileToml(model);
  const smokeCoordinationProfile =
    options.smokeWorkflow === true
      ? `
[models.smoke-coordination]
${modelProfileToml(model, "medium")}
`
      : "";
  const codex = agentToml(model, "CodexAgent", "openai");
  const claude = agentToml(model, "ClaudeAgent", "anthropic");
  const kimi = agentToml(model, "KimiAgent", "kimi");
  const providerCredentialEnv = cloud?.providerCredentialEnv ?? ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"];
  const execution =
    cloud === undefined
      ? ""
      : `
[execution]
mode = "cloud"
provider = "modal"
retention_days = 30

[execution.resources]
cpu = 2
memory_mib = 4096
timeout_seconds = ${nodeTimeoutSeconds}

[execution.providers.modal]
app = ${tomlString(cloud.app)}
image = ${tomlString(cloud.image)}
credential_env = [${providerCredentialEnv.map(tomlString).join(", ")}]

[execution.nodes.${cloud.resourceOverrideNodeId}.resources]
cpu = 4
memory_mib = 8192
timeout_seconds = ${nodeTimeoutSeconds}
`;
  return `schema_version = "1.0"
dynamic_strategies_enumerator = 3

[project]
repo = "."

[run]
output_dir = ".ultrafuzz/runs"
max_parallel_agents = ${DEFAULT_MODAL_MAX_PARALLEL_AGENTS}
max_parallel_nodes = ${DEFAULT_MODAL_MAX_PARALLEL_NODES}
keep_workspaces = true
workspace_mode = "git-worktree"
default_timeout_seconds = ${nodeTimeoutSeconds}
${execution}

[models]
synthesized_default = false

[models.default]
${selectedProfile}

[models.benchmark]
${selectedProfile}

${smokeCoordinationProfile}
${codex}

${claude}

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

function modelProfileToml(model: ModalModelSpec, reasoning: ModalModelSpec["reasoning"] = model.reasoning): string {
  return `agent = ${tomlString(model.agent)}
model = ${tomlString(model.model)}
reasoning = ${tomlString(reasoning)}`;
}

function agentToml(selectedModel: ModalModelSpec, agent: ModalModelSpec["agent"], provider: ModelProvider): string {
  const selected = selectedModel.agent === agent;
  const auth = selected ? selectedModel.auth_mode : "subscription";
  if (auth === "api-key") {
    return `[agents.${agent}]\nauth = "api-key"\napi_key_env = ${tomlString(apiKeyEnv(provider))}`;
  }
  return `[agents.${agent}]\nauth = "subscription"\nconfig_dir = ${tomlString(remoteAuthDir(provider))}`;
}

function apiKeyEnv(provider: ModelProvider): string {
  if (provider === "openai") return "OPENAI_API_KEY";
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  return "KIMI_API_KEY";
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
