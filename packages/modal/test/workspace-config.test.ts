import { describe, expect, it } from "vitest";

import { DEFAULT_BENCHMARK_MODELS } from "../src/defaults.js";
import { modalTargetToml } from "../src/workspace-config.js";

describe("Modal target model profiles", () => {
  it("overrides both explicit default and benchmark profiles with the selected model", () => {
    const model = DEFAULT_BENCHMARK_MODELS[4]!;
    const config = modalTargetToml(model, 7_200);

    expect(config).toContain(`[models.default]\nagent = "ClaudeCodeAgent"\nmodel = "claude-fable-5"`);
    expect(config).toContain(`[models.benchmark]\nagent = "ClaudeCodeAgent"\nmodel = "claude-fable-5"`);
    expect(config).not.toContain('model = "gpt-5.5"');
  });
});
