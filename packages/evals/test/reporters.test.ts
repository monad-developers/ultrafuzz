import { describe, expect, it } from "vitest";

import {
  EVAL_PROVIDER_NONE,
  KNOWN_EVAL_PROVIDERS,
  resolveEvalProvider,
  resolveEvalSuitePath
} from "../src/reporters/index.js";

const LEGACY_EVAL_CONFIG = {
  provider: "braintrust",
  evalConfig: ".ultrafuzz/evals/bug-finding.yml",
  providers: {
    braintrust: { apiKeyEnv: "BRAINTRUST_API_KEY", project: "legacy-project" }
  }
};

describe("local provider resolution", () => {
  it("supports only local reporting and permits none to override a retired configured provider", () => {
    expect(KNOWN_EVAL_PROVIDERS).toEqual(["none"]);
    expect(resolveEvalProvider({ env: {} }).provider).toBe(EVAL_PROVIDER_NONE);
    expect(
      resolveEvalProvider({ env: { ULTRAFUZZ_EVAL_PROVIDER: "none" }, evalConfig: LEGACY_EVAL_CONFIG }).provider
    ).toBe(EVAL_PROVIDER_NONE);
    expect(
      resolveEvalProvider({
        cliProvider: "none",
        env: { ULTRAFUZZ_EVAL_PROVIDER: "braintrust" },
        evalConfig: LEGACY_EVAL_CONFIG
      }).provider
    ).toBe(EVAL_PROVIDER_NONE);
    expect(() =>
      resolveEvalProvider({
        cliProvider: "braintrust",
        env: { ULTRAFUZZ_EVAL_PROVIDER: "none" },
        evalConfig: LEGACY_EVAL_CONFIG
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_PROVIDER_UNKNOWN" }));
  });

  it.each(["braintrust", "unknown-provider"])(
    "rejects %s before inspecting credentials or provider profiles",
    (provider) => {
      const env = new Proxy<Record<string, string | undefined>>(
        {},
        {
          get(_target, property) {
            if (property === "ULTRAFUZZ_EVAL_PROVIDER") return undefined;
            throw new Error(`unexpected credential access: ${String(property)}`);
          }
        }
      );
      const providers = new Proxy(
        {},
        {
          get() {
            throw new Error("unexpected provider profile access");
          }
        }
      );
      expect(() => resolveEvalProvider({ env, evalConfig: { provider, providers } })).toThrowError(
        expect.objectContaining({ code: "EVAL_PROVIDER_UNKNOWN", details: { provider, known: ["none"] } })
      );
      expect(resolveEvalProvider({ cliProvider: "none", env, evalConfig: { provider, providers } }).provider).toBe(
        "none"
      );
    }
  );

  it("resolves the suite path with CLI > env > toml > default precedence", () => {
    expect(resolveEvalSuitePath({ env: {}, evalConfig: LEGACY_EVAL_CONFIG })).toBe(".ultrafuzz/evals/bug-finding.yml");
    expect(resolveEvalSuitePath({ env: { ULTRAFUZZ_EVAL_CONFIG: "custom.yml" }, evalConfig: LEGACY_EVAL_CONFIG })).toBe(
      "custom.yml"
    );
    expect(
      resolveEvalSuitePath({
        cliSuite: "flag.yml",
        env: { ULTRAFUZZ_EVAL_CONFIG: "custom.yml" },
        evalConfig: LEGACY_EVAL_CONFIG
      })
    ).toBe("flag.yml");
    expect(resolveEvalSuitePath({ env: {} })).toBe(".ultrafuzz/evals/bug-finding.yml");
  });
});
