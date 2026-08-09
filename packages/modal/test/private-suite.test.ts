import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadEvalSuite, benchmarkTopologyTransform } from "@ultrafuzz/evals";
import { transformTopologyForRun } from "@ultrafuzz/runtime";
import { expect, it } from "vitest";

import { parseModalBenchmarkConfig, type PrivateModalBenchmarkConfig } from "../src/config.js";
import type { ModalModelSpec } from "../src/defaults.js";
import { MODAL_BENCHMARK_SCHEMA_VERSION } from "../src/defaults.js";
import { renderPrivateEvalSuite } from "../src/private-suite.js";

const MODEL: ModalModelSpec = {
  slug: "gpt-5-5",
  model: "gpt-5.5",
  provider: "openai",
  agent: "CodexAgent",
  reasoning: "xhigh",
  auth_mode: "api-key"
};

function privateConfig(excludedNodeIds: string[]): PrivateModalBenchmarkConfig {
  const config = parseModalBenchmarkConfig({
    schema_version: MODAL_BENCHMARK_SCHEMA_VERSION,
    run_id: "private-invariant-only",
    app_name: "ultrafuzz-evals",
    image_name: "ultrafuzz-security-runner:latest",
    target: { repo: "https://github.com/aave/aave-v4", ref: "6959e3219b5506bf2acae18551cbb2a68a5b8fba" },
    ground_truth: {
      repo: "https://github.com/example/ground-truth",
      ref: "main",
      file: "findings.yml",
      format: "ultrafuzz"
    },
    braintrust: {
      project: "private-evals",
      api_key_env: "BRAINTRUST_API_KEY",
      judge_api_key_env: "OPENAI_API_KEY",
      judge_url: "https://api.openai.com/v1/chat/completions",
      judge_credential_ttl_seconds: 57_600
    },
    node_timeout_seconds: 7_200,
    loops: 1,
    models: [MODEL],
    benchmark_execution: { excluded_node_ids: excludedNodeIds },
    eval_reporting: { provider: "braintrust" }
  });
  if (!("target" in config)) throw new Error("expected private config");
  return config;
}

function loadRenderedSuite(contents: string) {
  const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-private-suite-"));
  const suitePath = path.join(root, "modal-suite.yml");
  fs.writeFileSync(suitePath, contents);
  return loadEvalSuite({ projectRoot: root, suitePath }).suite;
}

it("renders private benchmark execution controls into workflow input", () => {
  const suite = loadRenderedSuite(
    renderPrivateEvalSuite({
      config: privateConfig(["boundary-tests", "dynamic-strategy-generator"]),
      model: MODEL,
      targetPath: "/tmp/target"
    })
  );

  expect(suite.variants[0]?.workflow_input).toEqual({
    benchmark_execution: {
      strategy_loops: 1,
      excluded_node_ids: ["boundary-tests", "dynamic-strategy-generator"]
    }
  });
  expect(benchmarkTopologyTransform({ workflow_input: suite.variants[0]?.workflow_input })).toEqual({
    topologyTransform: {
      strategyLoops: 1,
      excludedNodeIds: ["boundary-tests", "dynamic-strategy-generator"]
    }
  });
});

it("routes unknown private node exclusions to the runtime topology validator", () => {
  const suite = loadRenderedSuite(
    renderPrivateEvalSuite({
      config: privateConfig(["unexpected-node"]),
      model: MODEL,
      targetPath: "/tmp/target"
    })
  );
  const transform = benchmarkTopologyTransform({ workflow_input: suite.variants[0]?.workflow_input }).topologyTransform;

  expect(() =>
    transformTopologyForRun(
      {
        version: 2,
        defaults: { strategy_loops: 3 },
        nodes: [
          { id: "__start__", kind: "meta", role: "start", depends_on: [] },
          { id: "boundary-tests", kind: "agentic", depends_on: ["__start__"] },
          { id: "__finish__", kind: "meta", role: "finish", depends_on: ["boundary-tests"] }
        ]
      },
      transform
    )
  ).toThrow(/unknown node unexpected-node/u);
});
