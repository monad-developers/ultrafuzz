import type { ModalModelSpec } from "../src/defaults.js";

/** Model specs used as ordinary configuration fixtures; production has no default model list. */
export const MODEL_SPEC_FIXTURES = [
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
] as const satisfies readonly ModalModelSpec[];
