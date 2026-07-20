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

test("the Kaden coordinator and its pinned reference can be ablated together", () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const excludedNodeIds = ["reference-vulnerabilities-kadenzipfel", "kadenzipfel-vulnerability-strategies"];
  const transformed = transformTopologyForRun(loadTopology(repositoryRoot, { requirePromptFiles: true }), {
    excludedNodeIds
  });
  const prompts = transformPromptCatalogForRun(loadPromptCatalog({ projectRoot: repositoryRoot }), {
    excludedNodeIds
  });
  const validation = validateTopology(transformed, {
    projectRoot: repositoryRoot,
    requirePromptFiles: true,
    promptTexts: promptTextsForCatalog(prompts)
  });
  const nodeIds = new Set(validation.topology.nodes.map((node) => node.id));

  assert.ok(excludedNodeIds.every((id) => !nodeIds.has(id)));
  assert.ok(
    validation.topology.nodes.every((node) =>
      node.depends_on.every((dependency) => !excludedNodeIds.includes(dependency))
    )
  );
  assert.ok(
    [...prompts.entries.values()].every(
      (entry) =>
        !entry.body.includes("{{artifact_path:kadenzipfel-vulnerability-strategies}}") &&
        !entry.body.includes("{{artifact_handoff:reference-vulnerabilities-kadenzipfel}}")
    )
  );
  for (const promptId of ["dynamic-strategy-generator", "dedupe-findings", "aggregate-test-files"]) {
    assert.doesNotMatch(prompts.entries.get(promptId)?.body ?? "", /Kaden/u);
  }
});

test("the smoke lane and Kaden ablation exclusions compose into a valid run", () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const lanes = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "benchmarks", "lanes.json"), "utf8")) as {
    smoke: { strategy_loops: number; excluded_node_ids: string[] };
  };
  const kadenNodeIds = ["reference-vulnerabilities-kadenzipfel", "kadenzipfel-vulnerability-strategies"];
  const excludedNodeIds = [...new Set([...lanes.smoke.excluded_node_ids, ...kadenNodeIds])];
  const transformed = transformTopologyForRun(loadTopology(repositoryRoot, { requirePromptFiles: true }), {
    strategyLoops: lanes.smoke.strategy_loops,
    excludedNodeIds
  });
  const prompts = transformPromptCatalogForRun(loadPromptCatalog({ projectRoot: repositoryRoot }), {
    strategyLoops: lanes.smoke.strategy_loops,
    excludedNodeIds
  });
  const validation = validateTopology(transformed, {
    projectRoot: repositoryRoot,
    requirePromptFiles: true,
    promptTexts: promptTextsForCatalog(prompts)
  });
  const nodeIds = new Set(validation.topology.nodes.map((node) => node.id));

  assert.ok(excludedNodeIds.every((id) => !nodeIds.has(id)));
  assert.ok(
    validation.topology.nodes.every((node) =>
      node.depends_on.every((dependency) => !excludedNodeIds.includes(dependency))
    )
  );
  assert.ok(
    [...prompts.entries.values()].every(
      (entry) =>
        !entry.body.includes("{{artifact_path:kadenzipfel-vulnerability-strategies}}") &&
        !entry.body.includes("{{artifact_handoff:reference-vulnerabilities-kadenzipfel}}")
    )
  );
});
