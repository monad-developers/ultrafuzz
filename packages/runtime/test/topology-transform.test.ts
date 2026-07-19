import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadPromptCatalog } from "@ultrafuzz/prompts";
import { loadTopology, validateTopology, type ProjectTopology } from "@ultrafuzz/topology";

import { promptTextsForCatalog, transformPromptCatalogForRun, transformTopologyForRun } from "../src/plan-run.js";

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

test("the checked-in smoke manifest produces a valid filtered production topology", () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const lanes = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "benchmarks", "lanes.json"), "utf8")) as {
    smoke: { strategy_loops: number; excluded_node_ids: string[] };
  };
  const transformed = transformTopologyForRun(loadTopology(repositoryRoot, { requirePromptFiles: true }), {
    strategyLoops: lanes.smoke.strategy_loops,
    excludedNodeIds: lanes.smoke.excluded_node_ids
  });
  const prompts = transformPromptCatalogForRun(loadPromptCatalog({ projectRoot: repositoryRoot }), {
    strategyLoops: lanes.smoke.strategy_loops,
    excludedNodeIds: lanes.smoke.excluded_node_ids
  });
  const validation = validateTopology(transformed, {
    projectRoot: repositoryRoot,
    requirePromptFiles: true,
    promptTexts: promptTextsForCatalog(prompts)
  });
  const nodeIds = new Set(transformed.nodes.map((node) => node.id));
  assert.ok(lanes.smoke.excluded_node_ids.every((id) => !nodeIds.has(id)));
  assert.equal(validation.effectiveLoopCounts["boundary-tests"], 1);
  assert.equal(validation.effectiveLoopCounts["encode-decode"], 1);
});
