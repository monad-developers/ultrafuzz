import { describe, expect, it } from "vitest";

import { DEFAULT_BENCHMARK_MODELS } from "../src/defaults.js";
import { modalTargetToml } from "../src/workspace-config.js";

describe("Modal target model profiles", () => {
  it("overrides both explicit default and benchmark profiles with the selected model", () => {
    const model = DEFAULT_BENCHMARK_MODELS[4]!;
    const config = modalTargetToml(model, 7_200);

    expect(config).toContain(`[models.default]\nagent = "ClaudeAgent"\nmodel = "claude-fable-5"`);
    expect(config).toContain(`[models.benchmark]\nagent = "ClaudeAgent"\nmodel = "claude-fable-5"`);
    expect(config).not.toContain('model = "gpt-5.5"');
  });

  it("renders target run concurrency overrides", () => {
    const model = DEFAULT_BENCHMARK_MODELS[0]!;
    const config = modalTargetToml(model, 7_200, { max_parallel_agents: 1, max_parallel_nodes: 2 });

    expect(config).toContain("max_parallel_agents = 1");
    expect(config).toContain("max_parallel_nodes = 2");
  });
});
