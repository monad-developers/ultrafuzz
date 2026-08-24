import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadEvalSuite, benchmarkTopologyTransform, THREAT_MODEL_GOAL_FANOUT_NODE_IDS } from "@ultrafuzz/evals";
import { transformTopologyForRun } from "@ultrafuzz/runtime";
import { expect, it } from "vitest";

import { parseModalBenchmarkConfig, type PrivateModalBenchmarkConfig } from "../src/config.js";
import type { ModalModelSpec } from "../src/defaults.js";
import { MODAL_BENCHMARK_SCHEMA_VERSION } from "../src/defaults.js";
import { privateBenchmarkExecutionControls, renderPrivateEvalSuite } from "../src/private-suite.js";

const MODEL: ModalModelSpec = {
  slug: "gpt-5-5",
  model: "gpt-5.5",
  provider: "openai",
  agent: "CodexAgent",
  reasoning: "xhigh",
  auth_mode: "api-key"
};

function privateConfig(excludedNodeIds: string[], includeThreatModelGoalFanout?: boolean): PrivateModalBenchmarkConfig {
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
    benchmark_execution: {
      excluded_node_ids: excludedNodeIds,
      ...(includeThreatModelGoalFanout === undefined
        ? {}
        : { include_threat_model_goal_fanout: includeThreatModelGoalFanout })
    },
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

  const expected = ["boundary-tests", "dynamic-strategy-generator", ...THREAT_MODEL_GOAL_FANOUT_NODE_IDS];
  expect(suite.variants[0]?.workflow_input).toEqual({
    benchmark_execution: {
      strategy_loops: 1,
      excluded_node_ids: expected
    }
  });
  expect(benchmarkTopologyTransform({ workflow_input: suite.variants[0]?.workflow_input })).toEqual({
    topologyTransform: {
      strategyLoops: 1,
      excludedNodeIds: expected
    }
  });
});

it("prunes threat-model and goal fanout from a curated private lane by default", () => {
  // A curated invariant-only lane names only the nodes it wants gone. Its list
  // predates these IDs, so without this the lane would silently start running a
  // threat model and unbounded goal hunters and stop being comparable.
  const controls = privateBenchmarkExecutionControls(privateConfig(["boundary-tests"]));

  for (const id of THREAT_MODEL_GOAL_FANOUT_NODE_IDS) expect(controls.excluded_node_ids).toContain(id);
  expect(controls.excluded_node_ids[0]).toBe("boundary-tests");
  expect(new Set(controls.excluded_node_ids).size).toBe(controls.excluded_node_ids.length);
});

it("leaves an uncurated private lane running the whole production topology", () => {
  // An empty list means the operator wants everything, so nothing is implied.
  expect(privateBenchmarkExecutionControls(privateConfig([])).excluded_node_ids).toEqual([]);
});

it("lets a private lane opt back into measuring threat-model goal fanout", () => {
  const controls = privateBenchmarkExecutionControls(privateConfig(["boundary-tests"], true));

  expect(controls.excluded_node_ids).toEqual(["boundary-tests"]);
});

it("does not duplicate a fanout node a curated lane already excludes", () => {
  const controls = privateBenchmarkExecutionControls(privateConfig(["threat-goals", "boundary-tests"]));

  expect(controls.excluded_node_ids.filter((id) => id === "threat-goals")).toHaveLength(1);
  expect(new Set(controls.excluded_node_ids).size).toBe(controls.excluded_node_ids.length);
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
