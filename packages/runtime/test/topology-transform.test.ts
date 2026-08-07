import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadPromptCatalog } from "@ultrafuzz/prompts";
import { loadTopology, validateTopology, type ProjectTopology } from "@ultrafuzz/topology";

import { promptTextsForCatalog, transformPromptCatalogForRun, transformTopologyForRun } from "../src/plan-run.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

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

test("pruning the threat-model workstream leaves a valid, dependency-free production topology", () => {
  // @ultrafuzz/evals owns THREAT_MODEL_GOAL_FANOUT_NODE_IDS and every curated
  // private lane prunes exactly this set, but evals depends on runtime, so it
  // cannot push the set through the real topology itself. Re-declare it here and
  // prove the pruned graph still plans.
  const threatModelWorkstream = [
    "reference-vulnerability-database",
    "threat-model",
    "goal-roaming",
    "threat-goals",
    "class-goals",
    "goal-plan"
  ];
  const transform = { strategyLoops: 1, excludedNodeIds: threatModelWorkstream };
  const transformed = transformTopologyForRun(loadTopology(REPOSITORY_ROOT, { requirePromptFiles: true }), transform);
  const prompts = transformPromptCatalogForRun(loadPromptCatalog({ projectRoot: REPOSITORY_ROOT }), transform);
  validateTopology(transformed, {
    projectRoot: REPOSITORY_ROOT,
    requirePromptFiles: true,
    promptTexts: promptTextsForCatalog(prompts)
  });

  // Completeness: if a later change adds another default-on node belonging to
  // this workstream, it survives the prune and one of these catches it, rather
  // than every curated lane silently widening.
  const remaining = transformed.nodes;
  assert.deepEqual(
    remaining.filter((node) => node.dynamic !== undefined).map((node) => node.id),
    [],
    "no dynamic expansion may survive the prune"
  );
  assert.deepEqual(
    remaining.filter((node) => node.group === "goals").map((node) => node.id),
    [],
    "the goals group must be empty after the prune"
  );
  assert.deepEqual(
    remaining.filter((node) => node.kind === "reference" && node.reference?.startsWith("vulnerability-database")),
    [],
    "no vulnerability-database reference node may survive the prune"
  );
});
