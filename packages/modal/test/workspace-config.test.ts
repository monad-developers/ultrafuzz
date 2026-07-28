import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_BENCHMARK_MODELS } from "../src/defaults.js";
import { capModalTargetTopologyTimeouts, modalTargetToml } from "../src/workspace-config.js";

describe("Modal target model profiles", () => {
  const cloud = {
    app: "ultrafuzz-e2e",
    image: "ufz-runner-candidate",
    resourceOverrideNodeId: "smoke-context"
  } as const;

  it("overrides both explicit default and benchmark profiles with the selected model", () => {
    const model = DEFAULT_BENCHMARK_MODELS[4]!;
    const config = modalTargetToml(model, 7_200, cloud, { smokeWorkflow: true });

    expect(config).toContain(`[models.default]\nagent = "ClaudeAgent"\nmodel = "claude-fable-5"`);
    expect(config).toContain(`[models.benchmark]\nagent = "ClaudeAgent"\nmodel = "claude-fable-5"`);
    expect(config).toContain(
      `[models.smoke-coordination]\nagent = "ClaudeAgent"\nmodel = "claude-fable-5"\nreasoning = "medium"`
    );
    expect(config).not.toContain('model = "gpt-5.5"');
    expect(config).toContain("max_parallel_agents = 16");
    expect(config).toContain("max_parallel_nodes = 32");
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
      900,
      cloud
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

  it("keeps ordinary benchmark target execution local unless the gated cloud lane opts in", () => {
    const config = modalTargetToml(DEFAULT_BENCHMARK_MODELS[0]!, 1_800);

    expect(config).not.toContain("[execution]");
  });

  it("declares the coordination profile for a locally executed smoke workflow", () => {
    const config = modalTargetToml(DEFAULT_BENCHMARK_MODELS[0]!, 1_800, undefined, {
      smokeWorkflow: true
    });

    expect(config).toContain("[models.smoke-coordination]");
    expect(config).not.toContain("[execution]");
  });

  it("runs benchmark attempts through the real Modal node provider with an observable resource override", () => {
    const config = modalTargetToml(DEFAULT_BENCHMARK_MODELS[0]!, 1_800, cloud);

    expect(config).toContain('[execution]\nmode = "cloud"\nprovider = "modal"\nretention_days = 30');
    expect(config).toContain("[execution.resources]\ncpu = 2\nmemory_mib = 4096\ntimeout_seconds = 1800");
    expect(config).toContain(
      '[execution.providers.modal]\napp = "ultrafuzz-e2e"\nimage = "ufz-runner-candidate"\ncredential_env = ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]'
    );
    expect(config).toContain(
      "[execution.nodes.smoke-context.resources]\ncpu = 4\nmemory_mib = 8192\ntimeout_seconds = 1800"
    );
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
