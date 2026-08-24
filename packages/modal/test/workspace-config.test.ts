import fs from "node:fs";
import path from "node:path";

import { parseProjectConfigToml, resolveConfig } from "@ultrafuzz/config";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { DEFAULT_BENCHMARK_MODELS } from "../src/defaults.js";
import { PUBLIC_FULL_BENCHMARK_MAX_RUNTIME_SECONDS } from "../src/public-worker.js";
import { modalTargetToml } from "../src/workspace-config.js";

describe("Modal target model profiles", () => {
  it("overrides both explicit default and benchmark profiles with the selected model", () => {
    const model = DEFAULT_BENCHMARK_MODELS[4]!;
    const config = modalTargetToml(model, 7_200);

    expect(config).toMatch(/^schema_version = "ultrafuzz\.config\.v2"$/mu);
    expect(config).toContain(`[models.default]\nagent = "ClaudeAgent"\nmodel = "claude-fable-5"`);
    expect(config).toContain(`[models.benchmark]\nagent = "ClaudeAgent"\nmodel = "claude-fable-5"`);
    expect(config).not.toContain("[models.smoke-coordination]");
    expect(config).not.toContain('model = "gpt-5.5"');
    expect(config).toContain('[agents.DeepSeekAgent]\nauth = "api-key"\napi_key_env = "DEEPSEEK_API_KEY"');
    expect(config).toContain("max_parallel_agents = 16");
    expect(config).toContain("max_parallel_nodes = 32");
    expect(config).toContain("keep_workspaces = false");
    expect(config).toContain('invariant_testing_smoke_timeout = "10min"');
    expect(config).toContain('audit_profile = "default"');
  });

  it("selects the packaged smoke audit profile for smoke target preparation", () => {
    const config = modalTargetToml(DEFAULT_BENCHMARK_MODELS[0]!, 900, "smoke");

    expect(config).toMatch(/^schema_version = "ultrafuzz\.config\.v2"$/mu);
    expect(config).toContain('audit_profile = "smoke"');
    expect(config).not.toContain("dynamic_strategies_enumerator");
    const parsed = parseProjectConfigToml(config, "modal-target-ultrafuzz.toml");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(resolveConfig({ projectConfig: parsed.value, env: {} }).ok).toBe(true);
  });

  it("selects the packaged full audit profile for full target preparation", () => {
    const config = modalTargetToml(DEFAULT_BENCHMARK_MODELS[0]!, 1_800, "full");

    expect(config).toContain('audit_profile = "full"');
    expect(config).toContain("dynamic_strategies_enumerator = 3");
    const parsed = parseProjectConfigToml(config, "modal-target-ultrafuzz.toml");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const resolved = resolveConfig({ projectConfig: parsed.value, env: {} });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.auditProfile).toBe("full");

    const topology = parse(fs.readFileSync(path.resolve("../config/topologies/full.yml"), "utf8")) as {
      groups: { specialists: { defaults: { failure_policy: string; timeout_seconds: number } } };
      nodes: Array<{ id: string; group?: string }>;
    };
    const campaign = topology.nodes.find((node) => node.id === "stateful-invariant-campaign");
    expect(campaign?.group).toBe("specialists");
    expect(topology.groups.specialists.defaults.failure_policy).toBe("continue");
    const specialistTimeoutSeconds = topology.groups.specialists.defaults.timeout_seconds;
    const hostShutdownGraceSeconds = 5 * 60;
    const finalizationReserveSeconds = Math.min(5 * 60, Math.floor(specialistTimeoutSeconds / 6));
    const invariantBudgetSeconds =
      resolved.value.invariants.invariantTestingSmokeTimeoutSeconds +
      resolved.value.invariants.invariantTestingFuzzerTimeoutSeconds +
      hostShutdownGraceSeconds +
      finalizationReserveSeconds;
    expect(specialistTimeoutSeconds).toBe(7_200);
    expect(invariantBudgetSeconds).toBe(4_800);
    expect(specialistTimeoutSeconds).toBeGreaterThanOrEqual(invariantBudgetSeconds);
    expect(PUBLIC_FULL_BENCHMARK_MAX_RUNTIME_SECONDS).toBeGreaterThan(specialistTimeoutSeconds);
  });

  it("uses the staged API key for a public Claude benchmark target", () => {
    const config = modalTargetToml(
      {
        slug: "benchmark-smoke-claude-sonnet-5-low",
        model: "claude-sonnet-5",
        provider: "anthropic",
        agent: "ClaudeAgent",
        reasoning: "low",
        auth_mode: "api-key"
      },
      900
    );

    expect(config).toContain('[agents.ClaudeAgent]\nauth = "api-key"\napi_key_env = "ANTHROPIC_API_KEY"');
    expect(config).toContain("default_timeout_seconds = 900");
  });

  it("generates Kimi agent config for Kimi K3 without the incompatible final-message flag", () => {
    const config = modalTargetToml(
      {
        slug: "kimi-k3",
        model: "kimi-k3",
        provider: "kimi",
        agent: "KimiAgent",
        reasoning: "max",
        auth_mode: "subscription"
      },
      900
    );

    expect(config).toContain(`[models.default]\nagent = "KimiAgent"\nmodel = "kimi-k3"\nreasoning = "max"`);
    expect(config).toContain('[agents.KimiAgent]\nauth = "subscription"');
    expect(config).not.toContain("final-message-only");
  });

  it("uses Kimi-compatible API-key credentials for public Kimi benchmark targets", () => {
    const config = modalTargetToml(
      {
        slug: "kimi-k3",
        model: "kimi-k3",
        provider: "kimi",
        agent: "KimiAgent",
        reasoning: "max",
        auth_mode: "api-key"
      },
      900
    );

    expect(config).toContain('[agents.KimiAgent]\nauth = "api-key"\napi_key_env = "KIMI_API_KEY"');
  });

  it("generates the dedicated DeepSeek V4 profile and API-key agent config", () => {
    const config = modalTargetToml(
      {
        slug: "deepseek-v4-pro",
        model: "deepseek-v4-pro",
        provider: "deepseek",
        agent: "DeepSeekAgent",
        reasoning: "max",
        auth_mode: "api-key"
      },
      900
    );

    expect(config).toContain(`[models.default]\nagent = "DeepSeekAgent"\nmodel = "deepseek-v4-pro"\nreasoning = "max"`);
    expect(config).toContain('[agents.DeepSeekAgent]\nauth = "api-key"\napi_key_env = "DEEPSEEK_API_KEY"');
  });

  it("generates a dedicated OpenRouter API-key profile without changing the catalogue ID", () => {
    const model = "~anthropic/claude-sonnet-latest:free";
    const config = modalTargetToml(
      {
        slug: "openrouter-catalogue",
        model,
        provider: "openrouter",
        agent: "OpenRouterAgent",
        reasoning: "high",
        auth_mode: "api-key"
      },
      900
    );

    expect(config).toContain(`[models.default]\nagent = "OpenRouterAgent"\nmodel = ${JSON.stringify(model)}`);
    expect(config).toContain('[agents.OpenRouterAgent]\nauth = "api-key"\napi_key_env = "OPENROUTER_API_KEY"');
    const parsed = parseProjectConfigToml(config, "modal-openrouter-ultrafuzz.toml");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(resolveConfig({ projectConfig: parsed.value, env: {} }).ok).toBe(true);
  });
});
