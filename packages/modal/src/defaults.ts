export const MODAL_BENCHMARK_SCHEMA_VERSION = "ultrafuzz.modal.benchmark.v1" as const;
export const MODAL_LAUNCH_STATE_SCHEMA_VERSION = "ultrafuzz.modal.launch-state.v3" as const;
export const MODAL_RECOVERY_STATE_SCHEMA_VERSION = "ultrafuzz.modal.recovery-state.v1" as const;
export const MODAL_WORKER_LINEAGE_SCHEMA_VERSION = "ultrafuzz.modal.worker-lineage.v1" as const;
export const MODAL_WORKER_STATUS_SCHEMA_VERSION = "ultrafuzz.modal.worker-status.v2" as const;
export const MODAL_MAX_SANDBOX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const MODAL_RECOVERY_SANDBOX_TIMEOUT_MS = MODAL_MAX_SANDBOX_TIMEOUT_MS;
export const MODAL_OVERSEER_POLL_MS = 60 * 1000;
export const MODAL_RECOVERY_RESUME_GRACE_MS = 15 * 60 * 1000;
export const MODAL_RECOVERY_STALE_AFTER_MS = 30 * 60 * 1000;
export const MODAL_RECOVERY_MAX_NO_PROGRESS_GENERATIONS = 3;
export const MODAL_RECOVERY_BACKOFF_BASE_MS = 5 * 60 * 1000;
export const MODAL_RECOVERY_BACKOFF_MAX_MS = 15 * 60 * 1000;
export const MODAL_RECOVERY_LEASE_TIMEOUT_MS = 10 * 60 * 1000;
export const EVAL_POST_WATCH_MARGIN_MS = 2 * 60 * 60 * 1000;
export const MODAL_SANDBOX_TIMEOUT_MS = MODAL_MAX_SANDBOX_TIMEOUT_MS;
export const EVAL_WATCH_TIMEOUT_SECONDS = (MODAL_SANDBOX_TIMEOUT_MS - EVAL_POST_WATCH_MARGIN_MS) / 1000;
export const MODAL_PRE_MODEL_RETRY_LIMIT = 3;
export const MODAL_PRE_MODEL_RETRY_BASE_DELAY_MS = 1_000;
export const MODAL_PRE_MODEL_RETRY_MAX_DELAY_MS = 4_000;
export const DEFAULT_NODE_TIMEOUT_SECONDS = 2 * 60 * 60;
export const DEFAULT_MODAL_APP = "ultrafuzz-evals";
export const DEFAULT_MODAL_IMAGE = "ultrafuzz-security-runner:latest";
export const MODAL_BENCHMARK_SANDBOX_RESOURCES = {
  cpu: 16,
  cpuLimit: 16,
  memoryMiB: 32_768,
  memoryLimitMiB: 65_536
} as const;
export const DEFAULT_MODAL_MAX_PARALLEL_AGENTS = 16;
export const DEFAULT_MODAL_MAX_PARALLEL_NODES = 32;

export type ModelProvider = "openai" | "anthropic" | "deepseek" | "kimi";
export type ModelAuthMode = "api-key" | "subscription";
export type ModalLaunchMode = "resume" | "fresh";

export interface ModalModelSpec {
  slug: string;
  model: string;
  provider: ModelProvider;
  agent: "CodexAgent" | "ClaudeAgent" | "DeepSeekAgent" | "KimiAgent";
  reasoning: string;
  auth_mode: ModelAuthMode;
}

export const DEFAULT_BENCHMARK_MODELS: readonly ModalModelSpec[] = [
  {
    slug: "gpt-5-5",
    model: "gpt-5.5",
    provider: "openai",
    agent: "CodexAgent",
    reasoning: "xhigh",
    auth_mode: "subscription"
  },
  {
    slug: "gpt-5-6-sol",
    model: "gpt-5.6-sol",
    provider: "openai",
    agent: "CodexAgent",
    reasoning: "xhigh",
    auth_mode: "subscription"
  },
  {
    slug: "gpt-5-6-terra",
    model: "gpt-5.6-terra",
    provider: "openai",
    agent: "CodexAgent",
    reasoning: "xhigh",
    auth_mode: "subscription"
  },
  {
    slug: "gpt-5-6-luna",
    model: "gpt-5.6-luna",
    provider: "openai",
    agent: "CodexAgent",
    reasoning: "xhigh",
    auth_mode: "subscription"
  },
  {
    slug: "claude-fable-5",
    model: "claude-fable-5",
    provider: "anthropic",
    agent: "ClaudeAgent",
    reasoning: "max",
    auth_mode: "subscription"
  },
  {
    slug: "claude-opus-4-8",
    model: "claude-opus-4-8",
    provider: "anthropic",
    agent: "ClaudeAgent",
    reasoning: "max",
    auth_mode: "subscription"
  },
  {
    slug: "kimi-k3",
    model: "kimi-k3",
    provider: "kimi",
    agent: "KimiAgent",
    reasoning: "max",
    auth_mode: "subscription"
  },
  {
    slug: "deepseek-v4-pro",
    model: "deepseek-v4-pro",
    provider: "deepseek",
    agent: "DeepSeekAgent",
    reasoning: "max",
    auth_mode: "api-key"
  }
] as const;
