import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadPromptCatalog } from "@ultrafuzz/prompts";
import { expandTopology, loadTopology, validateTopology, type ProjectTopology } from "@ultrafuzz/topology";

import { promptTextsForCatalog, transformPromptCatalogForRun, transformTopologyForRun } from "../src/plan-run.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const SMOKE_TOPOLOGY_PATH = path.join(REPOSITORY_ROOT, "benchmarks", "smoke-benchmark.yml");
const SMOKE_MODEL_PROFILES = {
  benchmark: { agentRef: "CodexAgent", modelName: "gpt-5.6-luna", reasoningEffort: "high" },
  "smoke-coordination": { agentRef: "CodexAgent", modelName: "gpt-5.6-luna", reasoningEffort: "medium" }
} as const;

/**
 * `@ultrafuzz/evals` owns the canonical smoke exclusion list and checks it
 * against the graph. This file owns the harder half of the claim, that the
 * pruned graph still expands. It cannot import that package without a
 * dependency cycle, so it re-derives the same set from the graph itself.
 */
function smokeGoalFanoutExclusions(): string[] {
  const smoke = loadTopology(REPOSITORY_ROOT, { topologyPath: SMOKE_TOPOLOGY_PATH });
  const dynamic = smoke.nodes.filter((node) => node.dynamic !== undefined).map((node) => node.id);
  assert.deepEqual(dynamic.slice().sort(), ["class-goals", "threat-goals"]);
  return [...dynamic, "goal-plan"];
}

function expandPrunedSmokeGraph(excludedNodeIds: string[]): ReturnType<typeof expandTopology> {
  const transform = { strategyLoops: 1, excludedNodeIds };
  const smoke = loadTopology(REPOSITORY_ROOT, { topologyPath: SMOKE_TOPOLOGY_PATH });
  const promptTexts = promptTextsForCatalog(
    transformPromptCatalogForRun(loadPromptCatalog({ projectRoot: REPOSITORY_ROOT }), transform)
  );
  return expandTopology(transformTopologyForRun(smoke, transform), {
    projectRoot: REPOSITORY_ROOT,
    promptTexts,
    modelProfiles: SMOKE_MODEL_PROFILES,
    defaultModelProfileId: "benchmark"
  });
}

function topology(): ProjectTopology {
  return {
    version: 2,
    defaults: { strategy_loops: 3 },
    groups: {
      strategies: { defaults: { loops: 3, timeout_seconds: 60 } },
      review: { label: "Review" }
    },
    nodes: [
      { id: "__start__", kind: "meta", role: "start", depends_on: [] },
      { id: "boundary-tests", kind: "agentic", group: "strategies", depends_on: ["__start__"] },
      {
        id: "dynamic-strategy-generator",
        kind: "agentic",
        group: "strategies",
        depends_on: ["boundary-tests"]
      },
      {
        id: "dedupe-findings",
        kind: "agentic",
        group: "review",
        depends_on: ["boundary-tests", "dynamic-strategy-generator"]
      },
      { id: "__finish__", kind: "meta", role: "finish", depends_on: ["dedupe-findings"] }
    ]
  };
}

test("per-run topology transform applies smoke loops and removes excluded dependencies", () => {
  const source = topology();
  const transformed = transformTopologyForRun(source, {
    strategyLoops: 1,
    excludedNodeIds: ["dynamic-strategy-generator"]
  });
  assert.equal(transformed.defaults.strategy_loops, 1);
  assert.deepEqual(transformed.groups?.strategies?.defaults, { loops: 1, timeout_seconds: 60 });
  assert.ok(!transformed.nodes.map((node) => node.id).includes("dynamic-strategy-generator"));
  assert.deepEqual(transformed.nodes.find((node) => node.id === "dedupe-findings")?.depends_on, ["boundary-tests"]);
  assert.equal(source.nodes.length, 5);
  assert.equal(source.groups?.strategies?.defaults?.loops, 3);
});

test("per-run topology transform rejects unknown nodes, terminals, and invalid loops", () => {
  assert.throws(() => transformTopologyForRun(topology(), { excludedNodeIds: ["missing"] }), /unknown node/u);
  assert.throws(() => transformTopologyForRun(topology(), { excludedNodeIds: ["__finish__"] }), /cannot exclude/u);
  assert.throws(() => transformTopologyForRun(topology(), { strategyLoops: 0 }), /positive integer/u);
});

test("an empty topology transform preserves the production topology object", () => {
  const source = { version: 2, defaults: { strategy_loops: 3 }, nodes: topology().nodes } satisfies ProjectTopology;
  assert.equal(transformTopologyForRun(source, { excludedNodeIds: [] }), source);
});

test("the exact smoke exclusions produce a valid filtered production topology", () => {
  const repositoryRoot = REPOSITORY_ROOT;
  const smokeExcludedNodeIds = [
    "stateful-invariant-setup",
    "stateful-invariant-handlers",
    "stateful-invariant-coverage",
    "stateful-invariant-implement-properties",
    "stateful-invariant-campaign",
    "differential-library-tests",
    "differential-oracle-planner",
    "reference-harness-author",
    "reference-and-lane-auditor",
    "differential-lane-author",
    "differential-red-triage",
    "differential-repair-and-report-review",
    "dynamic-strategy-generator",
    // Dynamic goal fanout, plus the goal-plan that feeds it. Dropping the
    // fanout alone would leave goal-plan terminal and strand the report
    // prompt's `artifact_path` citation of it.
    "threat-goals",
    "class-goals",
    "goal-plan"
  ];
  const transformed = transformTopologyForRun(loadTopology(repositoryRoot, { requirePromptFiles: true }), {
    strategyLoops: 1,
    excludedNodeIds: smokeExcludedNodeIds
  });
  const prompts = transformPromptCatalogForRun(loadPromptCatalog({ projectRoot: repositoryRoot }), {
    strategyLoops: 1,
    excludedNodeIds: smokeExcludedNodeIds
  });
  const validation = validateTopology(transformed, {
    projectRoot: repositoryRoot,
    requirePromptFiles: true,
    promptTexts: promptTextsForCatalog(prompts)
  });
  const nodeIds = new Set(transformed.nodes.map((node) => node.id));
  assert.ok(smokeExcludedNodeIds.every((id) => !nodeIds.has(id)));
  assert.equal(validation.effectiveLoopCounts["boundary-tests"], 1);
  assert.equal(validation.effectiveLoopCounts["encode-decode"], 1);
});

test("the smoke lane expands to a dynamic-free graph that keeps its bounded goal work", () => {
  const graph = expandPrunedSmokeGraph(smokeGoalFanoutExclusions());
  const remaining = new Set(graph.nodes.map((node) => node.logicalId ?? node.id));

  for (const id of smokeGoalFanoutExclusions()) assert.equal(remaining.has(id), false, `${id} should be pruned`);
  assert.equal(
    graph.nodes.some((node) => node.dynamic !== undefined),
    false,
    "no dynamic expansion may survive on the smoke lane"
  );
  // threat-model still feeds the fixed roaming goal, so the lane keeps a
  // bounded, deterministic amount of the new work.
  assert.equal(remaining.has("threat-model"), true);
  assert.equal(remaining.has("goal-roaming"), true);
  assert.equal(remaining.has("final-report"), true);
});

test("pruning the smoke fanout without goal-plan fails expansion", () => {
  // Guards why goal-plan is in the exclusion set at all. The fanout is its only
  // dependent, so dropping just the fanout leaves it terminal, and the smoke
  // report prompt's `artifact_path` citation of it loses its ancestor. The
  // terminal check reports first; either way the lane could not plan.
  const fanoutOnly = smokeGoalFanoutExclusions().filter((id) => id !== "goal-plan");

  assert.throws(() => expandPrunedSmokeGraph(fanoutOnly), /Only __finish__ may be terminal/u);
});
