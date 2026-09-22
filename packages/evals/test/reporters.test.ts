import { describe, expect, it } from "vitest";

import { graphFromPlannedGraph } from "../src/reporter.js";
import { boundedResponseText } from "../src/reporters/http.js";
import {
  EVAL_PROVIDER_NONE,
  KNOWN_EVAL_PROVIDERS,
  resolveEvalProvider,
  resolveEvalSuitePath
} from "../src/reporters/index.js";
import { currentPlannedGraph } from "./helpers.js";

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

describe("provider transport", () => {
  it("rejects provider responses larger than the transport limit", async () => {
    const response = new Response("oversized", {
      headers: { "content-length": String(1024 * 1024 + 1) }
    });
    await expect(boundedResponseText(response, "provider", "EVAL_TEST_RESPONSE_TOO_LARGE")).rejects.toMatchObject({
      code: "EVAL_TEST_RESPONSE_TOO_LARGE"
    });
  });
});

describe("graphFromPlannedGraph", () => {
  it("maps planned nodes into the provider row graph with group inference", () => {
    const planned = currentPlannedGraph(["setup-1-a1", "strategies-fuzz-a1", "mystery"], undefined);
    planned.groups = { setup: {}, strategies: {} };
    planned.nodes[0]!.logical_id = "setup-1";
    planned.nodes[0]!.model_fanout[0]!.model_profile_id = "eval-runner";
    planned.nodes[0]!.model_fanout[0]!.model_name = "gpt-5.4-mini";
    planned.nodes[1]!.depends_on = ["setup-1-a1"];
    Object.assign(planned.nodes[2]!, {
      kind: "reference",
      prompt_path: "",
      model_fanout: [],
      reference: "monad-developers/ultrafuzz",
      reference_revision: {
        provider: "github",
        repo: "monad-developers/ultrafuzz",
        commit: "a".repeat(40),
        paths: ["README.md"]
      }
    });

    const graph = graphFromPlannedGraph(planned, "row-1");
    expect(graph.rowId).toBe("row-1");
    expect(graph.nodes).toHaveLength(3);
    expect(graph.nodes[0]).toMatchObject({
      id: "setup-1-a1",
      logicalId: "setup-1",
      group: "setup",
      modelProfileId: "eval-runner",
      model: "gpt-5.4-mini",
      loopIndex: 0
    });
    expect(graph.nodes[1]).toMatchObject({ group: "strategies", dependsOn: ["setup-1-a1"] });
    expect(graph.nodes[2]).toMatchObject({ group: "default", kind: "reference" });
  });

  it("uses an empty graph only when graph.json is absent", () => {
    expect(graphFromPlannedGraph(undefined, "row-1")).toEqual({ rowId: "row-1", nodes: [] });
  });

  it("rejects every malformed, schema-invalid, or semantically invalid present graph", () => {
    expect(() => graphFromPlannedGraph({ nodes: "nope" }, "row-1")).toThrow("planned graph is schema-invalid");

    const missingLogicalId = currentPlannedGraph(["setup-1"], undefined);
    Reflect.deleteProperty(missingLogicalId.nodes[0]!, "logical_id");
    expect(() => graphFromPlannedGraph(missingLogicalId, "row-1")).toThrow("planned graph is schema-invalid");

    const unknownDependency = currentPlannedGraph(["setup-1"], undefined);
    unknownDependency.nodes[0]!.depends_on = ["missing-node"];
    expect(() => graphFromPlannedGraph(unknownDependency, "row-1")).toThrow(
      'planned graph node "setup-1" depends on unknown node "missing-node"'
    );
  });
});
