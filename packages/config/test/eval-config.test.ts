import { describe, expect, it } from "vitest";

import { parseProjectConfigToml, resolveConfig, serializeResolvedConfigToml } from "../src/index.js";

const EVAL_TOML = `
[eval]
eval_config = ".ultrafuzz/evals/bug-finding.yml"
ground_truth_root = "/secure/eval-ground-truth"
provider = "braintrust"

[eval.providers.braintrust]
api_key_env = "BRAINTRUST_API_KEY"
project = "ultrafuzz-evals"
`;

describe("[eval] config section", () => {
  it("parses the [eval] table and provider profiles", () => {
    const parsed = parseProjectConfigToml(EVAL_TOML);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.eval).toEqual({
      evalConfig: ".ultrafuzz/evals/bug-finding.yml",
      groundTruthRoot: "/secure/eval-ground-truth",
      provider: "braintrust",
      providers: {
        braintrust: { apiKeyEnv: "BRAINTRUST_API_KEY", project: "ultrafuzz-evals" }
      }
    });
  });

  it("rejects unknown [eval] fields", () => {
    const parsed = parseProjectConfigToml(`
[eval]
provider = "braintrust"
api_key = "not-allowed-here"
`);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.diagnostics.some((entry) => entry.code === "CONFIG_UNKNOWN_FIELD")).toBe(true);
  });

  it("defaults to provider=none so the local loop works offline", () => {
    const resolved = resolveConfig({ env: {} });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.eval.provider).toBe("none");
  });

  it("applies env overrides over the project toml", () => {
    const parsed = parseProjectConfigToml(EVAL_TOML);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const resolved = resolveConfig({
      projectConfig: parsed.value,
      env: { ULTRAFUZZ_EVAL_PROVIDER: "none", ULTRAFUZZ_EVAL_CONFIG: "custom-suite.yml" }
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.eval.provider).toBe("none");
    expect(resolved.value.eval.evalConfig).toBe("custom-suite.yml");
    expect(resolved.value.eval.providers.braintrust).toEqual({
      apiKeyEnv: "BRAINTRUST_API_KEY",
      project: "ultrafuzz-evals"
    });
  });

  it("round-trips [eval] through the resolved config serializer", () => {
    const parsed = parseProjectConfigToml(EVAL_TOML);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const resolved = resolveConfig({ projectConfig: parsed.value, env: {} });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const serialized = serializeResolvedConfigToml(resolved.value);
    const reparsed = parseProjectConfigToml(serialized);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    const reresolved = resolveConfig({ projectConfig: reparsed.value, env: {} });
    expect(reresolved.ok).toBe(true);
    if (!reresolved.ok) return;
    expect(reresolved.value.eval).toEqual(resolved.value.eval);
  });
});
