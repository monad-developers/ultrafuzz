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
    expect(config).toContain("max_parallel_agents = 16");
    expect(config).toContain("max_parallel_nodes = 32");
    expect(config).toContain("keep_workspaces = false");
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
