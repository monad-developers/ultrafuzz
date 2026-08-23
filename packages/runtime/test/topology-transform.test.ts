import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { packagedTopology } from "@ultrafuzz/config";
import { loadPromptCatalog, type PromptCatalog } from "@ultrafuzz/prompts";
import {
  expandTopology,
  loadTopology,
  validateTopology,
  type ExpandedGraph,
  type ProjectTopology
} from "@ultrafuzz/topology";

import { toPlannedGraph } from "../src/plan-run.js";
import {
  promptTextsForCatalog,
  transformPromptCatalogForRun,
  transformTopologyForRun
} from "../src/topology-transform.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * The production topology minus the threat-model workstream. Pinned so that any
 * topology addition fails the completeness assertion below and forces a
 * deliberate decision about curated lanes, instead of silently widening them.
 */
const EXPECTED_NODES_AFTER_THREAT_MODEL_PRUNE = [
  "__finish__",
  "__start__",
  "actors-flows",
  "admin-config-boundaries",
  "aggregate-test-files",
  "amm-boundary-liquidity",
  "base-test-setup",
  "batch-atomicity-unsupported-actions",
  "boundary-tests",
  "dedupe-findings",
  "differential-lane-author",
  "differential-library-tests",
  "differential-oracle-planner",
  "differential-red-triage",
  "differential-repair-and-report-review",
  "dynamic-strategy-generator",
  "encode-decode",
  "expand-coverage",
  "external-dependency-boundaries",
  "externalized-state-accounting",
  "final-report",
  "lifecycle-view-boundaries",
  "market-exhaustion-boundaries",
  "order-replacement-collateral",
  "packed-action-parity",
  "payable-fallback-accounting",
  "project-discovery",
  "property-specification-0kn0t",
  "property-specification-a16z",
  "property-specification-aviggiano",
  "property-specification-certora",
  "property-specification-crytic",
  "property-specification-fanin",
  "property-specification-josselin-feist",
  "property-specification-recon",
  "property-specification-runtime-verification",
  "reference-and-lane-auditor",
  "reference-harness-author",
  "reference-properties-0kn0t",
  "reference-properties-a16z-erc4626",
  "reference-properties-aviggiano",
  "reference-properties-certora-sanity",
  "reference-properties-certora-thinking",
  "reference-properties-crytic",
  "reference-properties-montyly-rounding",
  "reference-properties-recon",
  "reference-properties-runtime-verification",
  "round-trip",
  "rounding-direction-audit",
  "router-exact-accounting",
  "setup-foundry",
  "severity-classification",
  "state-machine-boundaries",
  "stateful-invariant-campaign",
  "stateful-invariant-coverage",
  "stateful-invariant-handlers",
  "stateful-invariant-implement-properties",
  "stateful-invariant-setup",
  "time-warp-sequences",
  "triage",
  "workflow-property-based-tests"
];

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

test("planned prompt binding never falls back from the declared path to a matching node ID", () => {
  const catalog: PromptCatalog = {
    entries: new Map([
      [
        "declared-node",
        {
          id: "declared-node",
          displayName: "Wrong path",
          relativePath: "other/wrong-path.md",
          source: "project",
          frontmatter: { id: "declared-node" },
          body: "wrong path\n",
          markdown: "wrong path\n"
        }
      ]
    ]),
    orderedIds: ["declared-node"]
  };
  const expanded: ExpandedGraph = {
    graphVersion: "4",
    topologyVersion: 2,
    groups: {},
    nodes: [
      {
        id: "declared-node",
        logicalId: "declared-node",
        label: "Declared node",
        kind: "agentic",
        promptPath: "declared/exact-path.md",
        dependsOn: [],
        artifactDir: "artifacts/declared-node",
        retryPolicy: { maxAttempts: 1 },
        loop: { index: 0, count: 1, mode: "parallel", attemptIndex: 0 },
        outputs: [],
        modelFanout: []
      }
    ]
  };

  assert.throws(
    () => toPlannedGraph(expanded, catalog),
    /prompt declared\/exact-path\.md for declared-node was not found/u
  );
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
  const transformed = transformTopologyForRun(
    loadTopology(repositoryRoot, { topologyPath: packagedTopology("full").path, requirePromptFiles: true }),
    {
      strategyLoops: 1,
      excludedNodeIds: smokeExcludedNodeIds
    }
  );
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

  // Completeness. The three shape checks below cannot see a default-on node
  // added to a pre-existing group such as `setup`, which is exactly where
  // threat-model and goal-plan live, so pin the surviving node set instead. Any
  // topology addition fails this and forces a deliberate answer to "should
  // curated lanes prune this too?" rather than silently widening every one.
  const remaining = transformed.nodes;
  assert.deepEqual(
    remaining.map((node) => node.id).sort(),
    EXPECTED_NODES_AFTER_THREAT_MODEL_PRUNE,
    "topology changed: decide whether the new node belongs in THREAT_MODEL_GOAL_FANOUT_NODE_IDS, then update this list"
  );
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

test("the invariant-only exclusions retain the whole stateful-invariant chain", () => {
  // The inverse of the smoke exclusions: invariant-only campaigns drop every
  // strategy except the stateful-invariant chain, so the retained chain still
  // has to reach the review fan-in through its own surviving dependencies.
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const source = loadTopology(repositoryRoot, {
    topologyPath: packagedTopology("full").path,
    requirePromptFiles: true
  });
  const invariantNodeIds = source.nodes
    .filter((node) => node.id.startsWith("stateful-invariant-"))
    .map((node) => node.id);
  const invariantOnlyExcludedNodeIds = source.nodes
    .filter(
      (node) => (node.group === "strategies" || node.group === "specialists") && !invariantNodeIds.includes(node.id)
    )
    .map((node) => node.id);
  const transform = { strategyLoops: 1, excludedNodeIds: invariantOnlyExcludedNodeIds };
  const transformed = transformTopologyForRun(source, transform);
  const prompts = transformPromptCatalogForRun(loadPromptCatalog({ projectRoot: REPOSITORY_ROOT }), transform);
  const validation = validateTopology(transformed, {
    projectRoot: REPOSITORY_ROOT,
    requirePromptFiles: true,
    promptTexts: promptTextsForCatalog(prompts)
  });
  const nodeIds = new Set(transformed.nodes.map((node) => node.id));

  assert.ok(invariantNodeIds.length >= 5, "the shipped topology no longer declares a stateful-invariant chain");
  assert.ok(invariantOnlyExcludedNodeIds.length > 0);
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
