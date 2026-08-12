import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { packagedTopology } from "@ultrafuzz/config";
import { loadPromptCatalog } from "@ultrafuzz/prompts";
import { expandTopology, loadTopology, validateTopology, type ProjectTopology } from "@ultrafuzz/topology";

import { promptTextsForCatalog, transformPromptCatalogForRun } from "../src/plan-run.js";
import { transformTopologyForRun } from "../src/topology-transform.js";

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
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  // This list mirrors BENCHMARK_SMOKE_EXCLUDED_NODE_IDS in packages/evals/src/benchmark-manifest.ts.
  // `@ultrafuzz/evals` depends on `@ultrafuzz/runtime`, so this package cannot import the constant; the
  // copy stays complete instead, and the divergence below is asserted explicitly. The NoFuzz control
  // removes the stateful-invariant chain from the production topology, so the constant now names five
  // nodes the topology does not declare and `transformTopologyForRun` rejects the full list. Asserting
  // both the exact rejection and the exact missing set keeps that staleness detectable in both
  // directions: reinstating the chain, or dropping another id from the constant, fails here.
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
    "dynamic-strategy-generator"
  ];
  const source = loadTopology(repositoryRoot, { requirePromptFiles: true });
  const declaredNodeIds = new Set(source.nodes.map((node) => node.id));
  const undeclaredExclusions = smokeExcludedNodeIds.filter((id) => !declaredNodeIds.has(id));
  const declaredExclusions = smokeExcludedNodeIds.filter((id) => declaredNodeIds.has(id));

  assert.deepEqual(undeclaredExclusions, [
    "stateful-invariant-setup",
    "stateful-invariant-handlers",
    "stateful-invariant-coverage",
    "stateful-invariant-implement-properties",
    "stateful-invariant-campaign"
  ]);
  assert.throws(
    () => transformTopologyForRun(source, { strategyLoops: 1, excludedNodeIds: smokeExcludedNodeIds }),
    /unknown node stateful-invariant-setup/u
  );

  const transform = { strategyLoops: 1, excludedNodeIds: declaredExclusions };
  const transformed = transformTopologyForRun(source, transform);
  const prompts = transformPromptCatalogForRun(loadPromptCatalog({ projectRoot: repositoryRoot }), transform);
  const validation = validateTopology(transformed, {
    projectRoot: repositoryRoot,
    requirePromptFiles: true,
    promptTexts: promptTextsForCatalog(prompts)
  });
  const nodeIds = new Set(transformed.nodes.map((node) => node.id));
  assert.ok(declaredExclusions.length > 0);
  assert.ok(smokeExcludedNodeIds.every((id) => !nodeIds.has(id)));
  assert.ok(transformed.nodes.every((node) => node.depends_on.every((dependency) => nodeIds.has(dependency))));
  assert.equal(validation.effectiveLoopCounts["boundary-tests"], 1);
  assert.equal(validation.effectiveLoopCounts["encode-decode"], 1);
});

test("the invariant-only exclusions retain the whole stateful-invariant chain", () => {
  // The inverse of the smoke exclusions: invariant-only campaigns drop every
  // strategy except the stateful-invariant chain, so the retained chain still
  // has to reach the review fan-in through its own surviving dependencies.
  //
  // The NoFuzz control removes that chain from the production topology, so the chain can no longer be
  // derived by excluding strategies from it. `invariant-only.yml` is the already-excluded form of the
  // same graph, so the exhaustive derivation runs against it: every strategies node it declares must
  // belong to the chain (an empty inverse exclusion set, asserted exactly rather than assumed), the
  // whole chain must survive, and the exclusion / depends_on-rewrite path is still exercised below on
  // the same topology.
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const source = loadTopology(repositoryRoot, {
    topologyPath: packagedTopology("invariant-only").path,
    requirePromptFiles: true
  });
  const invariantNodeIds = source.nodes
    .filter((node) => node.group === "strategies" && node.id.startsWith("stateful-invariant-"))
    .map((node) => node.id);
  const invariantOnlyExcludedNodeIds = source.nodes
    .filter((node) => node.group === "strategies" && !invariantNodeIds.includes(node.id))
    .map((node) => node.id);
  const transform = { strategyLoops: 1, excludedNodeIds: invariantOnlyExcludedNodeIds };
  const transformed = transformTopologyForRun(source, transform);
  const prompts = transformPromptCatalogForRun(loadPromptCatalog({ projectRoot: repositoryRoot }), transform);
  const validation = validateTopology(transformed, {
    projectRoot: repositoryRoot,
    requirePromptFiles: true,
    promptTexts: promptTextsForCatalog(prompts)
  });
  const nodeIds = new Set(transformed.nodes.map((node) => node.id));

  assert.ok(invariantNodeIds.length >= 5, "the invariant-only topology no longer declares a stateful-invariant chain");
  assert.deepEqual(
    invariantOnlyExcludedNodeIds,
    [],
    "the invariant-only topology must declare no strategy outside the stateful-invariant chain"
  );
  assert.ok(invariantNodeIds.every((id) => nodeIds.has(id)));
  assert.ok(invariantOnlyExcludedNodeIds.every((id) => !nodeIds.has(id)));
  assert.deepEqual(transformed.nodes.find((node) => node.id === "stateful-invariant-handlers")?.depends_on, [
    "stateful-invariant-setup"
  ]);
  assert.ok(
    transformed.nodes.find((node) => node.id === "dedupe-findings")?.depends_on.includes("stateful-invariant-campaign"),
    "the review fan-in lost its only surviving strategy dependency"
  );
  for (const id of invariantNodeIds) assert.equal(validation.effectiveLoopCounts[id], 1);

  // Excluding the chain's root must remove it from the node list and from every `depends_on` that names
  // it, so the rewrite path this test used to exercise through the inverse exclusion set stays covered.
  const withoutChainRoot = transformTopologyForRun(source, {
    strategyLoops: 1,
    excludedNodeIds: ["stateful-invariant-setup"]
  });
  assert.ok(!withoutChainRoot.nodes.some((node) => node.id === "stateful-invariant-setup"));
  assert.deepEqual(withoutChainRoot.nodes.find((node) => node.id === "stateful-invariant-handlers")?.depends_on, []);
  assert.ok(withoutChainRoot.nodes.every((node) => !node.depends_on.includes("stateful-invariant-setup")));
});

test("invariant-only strategy loops repeat the serial coverage stage", () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const source = loadTopology(repositoryRoot, { topologyPath: packagedTopology("invariant-only").path });
  const one = expandTopology(transformTopologyForRun(source, { strategyLoops: 1 }), { projectRoot: repositoryRoot });
  const three = expandTopology(transformTopologyForRun(source, { strategyLoops: 3 }), {
    projectRoot: repositoryRoot
  });

  assert.equal(one.nodes.filter((node) => node.logicalId === "stateful-invariant-coverage").length, 1);
  assert.equal(three.nodes.filter((node) => node.logicalId === "stateful-invariant-coverage").length, 3);
  assert.equal(three.nodes.filter((node) => node.logicalId === "stateful-invariant-campaign").length, 1);
});
