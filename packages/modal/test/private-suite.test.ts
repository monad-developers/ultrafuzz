import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadEvalSuite, benchmarkTopologyTransform } from "@ultrafuzz/evals";
import { transformTopologyForRun } from "@ultrafuzz/runtime";
import { expect, it } from "vitest";

import { parseModalBenchmarkConfig, type PrivateModalBenchmarkConfig } from "../src/config.js";
import {
  DEFAULT_MODAL_MAX_PARALLEL_AGENTS,
  DEFAULT_MODAL_MAX_PARALLEL_NODES,
  MODAL_BENCHMARK_SCHEMA_VERSION,
  type ModalModelSpec
} from "../src/defaults.js";
import { renderPrivateEvalSuite } from "../src/private-suite.js";
import { modalTargetToml } from "../src/workspace-config.js";

const MODEL: ModalModelSpec = {
  slug: "gpt-5-5",
  model: "gpt-5.5",
  provider: "openai",
  agent: "CodexAgent",
  reasoning: "xhigh",
  auth_mode: "api-key"
};
const AAVE_SCFUZZBENCH_REPOSITORY = "https://github.com/scfuzzbench/aave-v4-scfuzzbench";
const AAVE_SCFUZZBENCH_REVISION = "edd6c82721512540c8c90e7a36a4a8e19fd7bdf3";
const R60_INVARIANT_ONLY_EXCLUDED_NODE_IDS = [
  "boundary-tests",
  "encode-decode",
  "differential-library-tests",
  "round-trip",
  "workflow-property-based-tests",
  "time-warp-sequences",
  "expand-coverage",
  "admin-config-boundaries",
  "external-dependency-boundaries",
  "externalized-state-accounting",
  "amm-boundary-liquidity",
  "payable-fallback-accounting",
  "packed-action-parity",
  "batch-atomicity-unsupported-actions",
  "router-exact-accounting",
  "rounding-direction-audit",
  "market-exhaustion-boundaries",
  "order-replacement-collateral",
  "state-machine-boundaries",
  "lifecycle-view-boundaries",
  "differential-oracle-planner",
  "reference-harness-author",
  "reference-and-lane-auditor",
  "differential-lane-author",
  "differential-red-triage",
  "differential-repair-and-report-review",
  "dynamic-strategy-generator"
] as const;

function privateConfig(excludedNodeIds: string[]): PrivateModalBenchmarkConfig {
  const config = parseModalBenchmarkConfig({
    schema_version: MODAL_BENCHMARK_SCHEMA_VERSION,
    run_id: "private-invariant-only",
    target: { repo: "https://github.com/aave/aave-v4", ref: "6959e3219b5506bf2acae18551cbb2a68a5b8fba" },
    ground_truth: {
      repo: "https://github.com/example/ground-truth",
      ref: "main",
      file: "findings.yml"
    },
    braintrust: { project: "private-evals" },
    loops: 1,
    models: [MODEL],
    benchmark_execution: { excluded_node_ids: excludedNodeIds }
  });
  if (!("target" in config)) throw new Error("expected private config");
  return config;
}

function r60ScFuzzBenchConfig(): PrivateModalBenchmarkConfig {
  const candidate = "f".repeat(40);
  const config = parseModalBenchmarkConfig({
    schema_version: MODAL_BENCHMARK_SCHEMA_VERSION,
    run_id: "aave-v4-scfuzzbench-v0012-main-issue437fix-r60-invariant-only",
    app_name: "ultrafuzz-evals",
    image_name: `ultrafuzz-security-runner:v0.0.12-r60-main-${candidate}-invariant-only`,
    braintrust: { project: "ultrafuzz-evals", api_key_env: "BRAINTRUST_API_KEY" },
    node_timeout_seconds: 7_200,
    loops: 3,
    models: [MODEL],
    target: { repo: AAVE_SCFUZZBENCH_REPOSITORY, ref: AAVE_SCFUZZBENCH_REVISION },
    benchmark_execution: { excluded_node_ids: R60_INVARIANT_ONLY_EXCLUDED_NODE_IDS },
    eval_reporting: { provider: "none" },
    ground_truth: {
      repo: "file:///opt/ultrafuzz",
      ref: candidate,
      file: "benchmarks/private-ground-truth/aave-v4-scfuzzbench/findings.yml",
      format: "ultrafuzz",
      expected_findings: 12
    }
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

it("preflights the exact R60 ScFuzzBench invariant-only controls", () => {
  const config = r60ScFuzzBenchConfig();
  const suite = loadRenderedSuite(
    renderPrivateEvalSuite({ config, model: MODEL, targetPath: "/tmp/scfuzzbench-target" })
  );
  const targetToml = modalTargetToml(MODEL, config.node_timeout_seconds);

  expect(config.target).toEqual({ repo: AAVE_SCFUZZBENCH_REPOSITORY, ref: AAVE_SCFUZZBENCH_REVISION });
  expect(config.ground_truth.expected_findings).toBe(12);
  expect(suite.targets[0]).toMatchObject({ repo: AAVE_SCFUZZBENCH_REPOSITORY, ref: AAVE_SCFUZZBENCH_REVISION });
  expect(suite.variants[0]?.workflow_input).toEqual({
    benchmark_execution: {
      strategy_loops: 3,
      excluded_node_ids: R60_INVARIANT_ONLY_EXCLUDED_NODE_IDS
    }
  });
  expect(DEFAULT_MODAL_MAX_PARALLEL_AGENTS).toBe(16);
  expect(DEFAULT_MODAL_MAX_PARALLEL_NODES).toBe(32);
  expect(targetToml).toContain("max_parallel_agents = 16");
  expect(targetToml).toContain("max_parallel_nodes = 32");
  expect(targetToml).toContain("default_timeout_seconds = 7200");
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
