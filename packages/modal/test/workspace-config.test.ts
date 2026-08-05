import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_BENCHMARK_MODELS } from "../src/defaults.js";
import { capModalTargetTopologyTimeouts, modalTargetToml } from "../src/workspace-config.js";

describe("Modal target model profiles", () => {
  it("overrides both explicit default and benchmark profiles with the selected model", () => {
    const model = DEFAULT_BENCHMARK_MODELS[4]!;
    const config = modalTargetToml(model, 7_200);

    expect(config).toContain(`[models.default]\nagent = "ClaudeAgent"\nmodel = "claude-fable-5"`);
    expect(config).toContain(`[models.benchmark]\nagent = "ClaudeAgent"\nmodel = "claude-fable-5"`);
    expect(config).not.toContain("[models.smoke-coordination]");
    expect(config).not.toContain('model = "gpt-5.5"');
    expect(config).toContain('[agents.DeepSeekAgent]\nauth = "api-key"\napi_key_env = "DEEPSEEK_API_KEY"');
    expect(config).toContain("max_parallel_agents = 16");
    expect(config).toContain("max_parallel_nodes = 32");
    expect(config).toContain("keep_workspaces = false");
    expect(config).toContain('invariant_testing_smoke_timeout = "10min"');
    expect(config).toContain(
      '[execution]\nmode = "cloud"\nprovider = "modal"\n\n[execution.resources]\ntimeout_seconds = 7200'
    );
    expect(config).toContain(
      '[execution.providers.modal]\napp = "ultrafuzz-evals"\nimage = "ultrafuzz-security-runner:latest"\ncredential_env = ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]'
    );
  });

  it("routes benchmark agents through the exact outer Modal app and image", () => {
    const config = modalTargetToml(DEFAULT_BENCHMARK_MODELS[7]!, 900, {
      app: "benchmark-controller",
      image: "candidate-image:sha",
      region: "us-east"
    });

    expect(config).toContain(
      '[execution.providers.modal]\napp = "benchmark-controller"\nimage = "candidate-image:sha"\nregion = "us-east"\ncredential_env = ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]'
    );
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
    expect(config).toContain('[agents.KimiAgent]\nauth = "subscription"\nconfig_dir = "/run/ultrafuzz-auth/kimi"');
    expect(config).toContain("max_parallel_agents = 1");
    expect(config).toContain("max_parallel_nodes = 1");
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
    expect(config).toContain("max_parallel_agents = 16");
    expect(config).toContain("max_parallel_nodes = 32");
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

  it("caps explicit group and node timeouts to the public benchmark node budget", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-timeout-cap-"));
    const topologyPath = path.join(root, "topology.yml");
    fs.writeFileSync(
      topologyPath,
      "groups:\n  strategies:\n    defaults:\n      timeout_seconds: 7200\nnodes:\n  - id: short\n    timeout_seconds: 300\n  - id: long\n    timeout_seconds: 3600\n"
    );

    capModalTargetTopologyTimeouts(topologyPath, 900);

    expect(fs.readFileSync(topologyPath, "utf8")).toBe(
      "groups:\n  strategies:\n    defaults:\n      timeout_seconds: 900\nnodes:\n  - id: short\n    timeout_seconds: 300\n  - id: long\n    timeout_seconds: 900\n"
    );
    expect(() => capModalTargetTopologyTimeouts(topologyPath, 0)).toThrow(/positive integer/u);
  });
});
