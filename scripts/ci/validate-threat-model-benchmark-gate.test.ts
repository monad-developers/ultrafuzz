import { afterEach, describe, expect, it } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  validateThreatModelBenchmarkGate,
  validateThreatModelBenchmarkGateFiles
} from "./validate-threat-model-benchmark-gate.mjs";

const roots: string[] = [];
const candidate = "a".repeat(40);
const modelSlug = "benchmark-threat-model-gpt-5-6-luna-high";
const pairId = `ultrafuzz-bench-${modelSlug}`;
const targets = [
  {
    id: "very-liquid-vaults-foundry",
    repository: "https://github.com/rheo-xyz/very-liquid-vaults",
    revision: "b".repeat(40),
    framework: "foundry"
  },
  {
    id: "venus-isolated-pools-hardhat",
    repository: "https://github.com/code-423n4/2023-05-venus",
    revision: "c".repeat(40),
    framework: "hardhat"
  },
  {
    id: "stableswap-ng-vyper",
    repository: "https://github.com/curvefi/stableswap-ng",
    revision: "d".repeat(40),
    framework: "vyper"
  }
];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("threat-model benchmark structural gate", () => {
  it("accepts complete planner-independent fanout evidence for the canonical cohort", () => {
    const fixture = gateFixture();
    expect(validateThreatModelBenchmarkGate(fixture.manifest, fixture.pairBundles)).toEqual({
      pair_count: 1,
      target_count: 3,
      row_count: 3,
      expected_dynamic_child_count: 6
    });
  });

  it("reads the exact collected bundle path named by the launch manifest", () => {
    const fixture = gateFixture();
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-threat-model-gate-"));
    roots.push(root);
    const manifestPath = path.join(root, "control", "manifest.json");
    const resultsRoot = path.join(root, "results");
    const bundlePath = path.join(resultsRoot, pairId, modelSlug, "public-results.json");
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify(fixture.manifest)}\n`);
    fs.writeFileSync(bundlePath, `${JSON.stringify(fixture.pairBundles[0]!.bundle)}\n`);

    expect(validateThreatModelBenchmarkGateFiles(manifestPath, resultsRoot)).toMatchObject({
      target_count: 3,
      row_count: 3
    });
  });

  it("fails a mismatched or unavailable planner-owned expectation", () => {
    const mismatch = gateFixture();
    firstRow(mismatch).expansion.expected_vs_actual = {
      expected_child_count: 2,
      actual_dynamic_node_count: 1,
      delta: -1,
      matches: false
    };
    expect(() => validateFixture(mismatch)).toThrow(/does not match the planner-owned expectation/u);

    const unavailable = gateFixture();
    firstRow(unavailable).expansion.plan_evidence = { status: "unavailable", reason: "goal-plan-unavailable" };
    expect(() => validateFixture(unavailable)).toThrow(/plan_evidence is not complete/u);
  });

  it("fails missing lineage and incomplete, failed, or timed-out goal lanes", () => {
    const missingLineage = gateFixture();
    firstRow(missingLineage).expansion.dynamic_nodes[0].source_node_id = null;
    expect(() => validateFixture(missingLineage)).toThrow(/failed or unattributed dynamic child/u);

    const missingLane = gateFixture();
    const lane = firstRow(missingLane).expansion.goal_lanes[0];
    lane.observed_node_count = 0;
    lane.observed_node_ids = [];
    expect(() => validateFixture(missingLane)).toThrow(/observed nodes must be a non-empty string array/u);

    const failedLane = gateFixture();
    const failed = firstRow(failedLane).expansion.goal_lanes[0];
    failed.failed = true;
    failed.failed_node_ids = [failed.observed_node_ids[0]];
    failed.status_counts.succeeded = 0;
    failed.status_counts.failed = 1;
    expect(() => validateFixture(failedLane)).toThrow(/was not independently and successfully observed/u);

    const timedOut = gateFixture();
    firstRow(timedOut).expansion.dynamic_nodes[0].status = "timed-out";
    firstRow(timedOut).expansion.dynamic_nodes[0].timed_out = true;
    expect(() => validateFixture(timedOut)).toThrow(/failed or unattributed dynamic child/u);

    const swappedAcrossLanes = gateFixture();
    const firstObserved = firstRow(swappedAcrossLanes).expansion.goal_lanes[0].observed_planned_node_ids;
    const secondObserved = firstRow(swappedAcrossLanes).expansion.goal_lanes[1].observed_planned_node_ids;
    firstRow(swappedAcrossLanes).expansion.goal_lanes[0].observed_planned_node_ids = secondObserved;
    firstRow(swappedAcrossLanes).expansion.goal_lanes[1].observed_planned_node_ids = firstObserved;
    expect(() => validateFixture(swappedAcrossLanes)).toThrow(/exact planner-owned node set/u);

    const reusedAcrossLanes = gateFixture();
    firstRow(reusedAcrossLanes).expansion.goal_lanes[1].observed_node_ids = [
      firstRow(reusedAcrossLanes).expansion.goal_lanes[0].observed_node_ids[0]
    ];
    expect(() => validateFixture(reusedAcrossLanes)).toThrow(/more than one goal lane/u);

    const childOutsideLanes = gateFixture();
    firstRow(childOutsideLanes).expansion.goal_lanes[0].observed_node_ids = ["unrelated-succeeded-node"];
    expect(() => validateFixture(childOutsideLanes)).toThrow(/outside its planner-owned goal lanes/u);
  });

  it("fails missing review artifacts, noncanonical targets, and serialized fanout", () => {
    const missingArtifact = gateFixture();
    missingArtifact.pairBundles[0].bundle.files = missingArtifact.pairBundles[0].bundle.files.filter(
      (file) => !file.path.endsWith("/artifacts/goal-plan/goal-plan.json")
    );
    expect(() => validateFixture(missingArtifact)).toThrow(/missing retained artifact/u);

    const wrongTarget = gateFixture();
    wrongTarget.manifest.targets[0].id = "replacement-target";
    expect(() => validateFixture(wrongTarget)).toThrow(/exactly the three canonical/u);

    const serialized = gateFixture();
    firstRow(serialized).expansion.concurrency.effective = 1;
    expect(() => validateFixture(serialized)).toThrow(/did not demonstrate independently scheduled/u);
  });

  it("rejects configured or observed serial concurrency even for a one-child fanout", () => {
    const configuredSerial = gateFixture();
    configuredSerial.manifest.concurrency.max_parallel_workflow_nodes_per_row = 1;
    expect(() => validateFixture(configuredSerial)).toThrow(/requested workflow concurrency must exceed one/u);

    const observedSerial = gateFixture();
    const row = firstRow(observedSerial);
    row.expansion.dynamic_node_count = 1;
    row.expansion.dynamic_nodes = row.expansion.dynamic_nodes.slice(0, 1);
    row.expansion.plan.expected_child_count = 1;
    row.expansion.plan.lane_count = 2;
    row.expansion.expected_vs_actual = {
      expected_child_count: 1,
      actual_dynamic_node_count: 1,
      delta: 0,
      matches: true
    };
    row.expansion.goal_lanes = [row.expansion.goal_lanes[0], row.expansion.goal_lanes[2]];
    row.expansion.concurrency.effective = 1;
    expect(() => validateFixture(observedSerial)).toThrow(/did not demonstrate independently scheduled/u);
  });

  it("keeps quality, cost, retry and wall-clock values as telemetry", () => {
    const fixture = gateFixture();
    const row = firstRow(fixture);
    row.precision = 0;
    row.recall = 0;
    row.f1_score = 0;
    row.expansion.retried_node_count = 99;
    for (const lane of row.expansion.goal_lanes) {
      lane.total_tokens = null;
      lane.cost_usd = null;
      lane.wall_time_seconds = null;
      lane.cost_evidence = { status: "unavailable", reason: "usage-ledger-unavailable" };
    }
    row.expansion.lane_cost_evidence = { status: "unavailable", reason: "usage-ledger-unavailable" };

    expect(() => validateFixture(fixture)).not.toThrow();
  });
});

function gateFixture() {
  const manifest = {
    candidate_commit: candidate,
    mode: "threat-model",
    benchmark: "ultrafuzz-bench",
    targets: structuredClone(targets),
    matrix_rows_per_pair: 3,
    concurrency: { max_parallel_workflow_nodes_per_row: 8 },
    pairs: [
      {
        pair: pairId,
        benchmark: "ultrafuzz-bench",
        mode: "threat-model",
        lane: "threat-model",
        model_slug: modelSlug,
        provider: "openai"
      }
    ]
  };
  const rows = targets.map((target, index) => scoreRow(target.id, index));
  const summary = { rows };
  const files = [bundleFile("eval/summary.json", JSON.stringify(summary))];
  for (const row of rows) {
    files.push(
      bundleFile(`reports/${row.row_id}/artifacts/threat-model/THREAT_MODEL.md`, "# Threat model\n"),
      bundleFile(`reports/${row.row_id}/artifacts/threat-model/threat-model.json`, '{"threats":[]}\n'),
      bundleFile(`reports/${row.row_id}/artifacts/goal-plan/goal-plan.json`, '{"goals":[]}\n'),
      bundleFile(`reports/${row.row_id}/artifacts/goal-plan/vulnerability-db-manifest.json`, '{"sha256":"abc"}\n')
    );
  }
  const bundle = {
    status: "succeeded",
    benchmark: "ultrafuzz-bench",
    lane: "threat-model",
    model_slug: modelSlug,
    model: "gpt-5.6-luna",
    reasoning: "high",
    candidate_commit: candidate,
    executed_case_count: 3,
    graded_case_count: 3,
    targets: targets.map((target) => ({ ...target, status: "succeeded" })),
    files
  };
  return { manifest, pairBundles: [{ pair: pairId, bundle }], summary };
}

function scoreRow(targetId: string, index: number) {
  const dynamicIds = [`dynamic-threat-${index}`, `dynamic-class-${index}`];
  const lanes = [
    goalLane(`threat-${index}`, dynamicIds[0]),
    goalLane(`class-${index}`, dynamicIds[1]),
    goalLane("goal-roaming", `goal-roaming-${index}`)
  ];
  return {
    row_id: `row-${index}`,
    target_id: targetId,
    precision: 1,
    recall: 1,
    f1_score: 1,
    expansion: {
      dynamic_node_count: 2,
      dynamic_nodes: dynamicIds.map((nodeId) => ({
        node_id: nodeId,
        source_node_id: "goal-plan",
        status: "succeeded",
        timed_out: false
      })),
      plan: {
        expected_child_count: 2,
        threat_count: 1,
        applicable_class_count: 1,
        max_dynamic_nodes: 2048,
        lane_count: 3
      },
      expected_vs_actual: {
        expected_child_count: 2,
        actual_dynamic_node_count: 2,
        delta: 0,
        matches: true
      },
      goal_lanes: lanes,
      truncated: false,
      nodes: complete(),
      lineage: complete(),
      concurrency_evidence: complete(),
      plan_evidence: complete(),
      lane_cost_evidence: complete(),
      concurrency: { requested: 8, effective: 6, ready_queue_depth: 0, active_work: 0 },
      retried_node_count: 0
    }
  };
}

function goalLane(laneId: string, nodeId: string) {
  return {
    lane_id: laneId,
    planned_node_ids: [nodeId],
    observed_planned_node_ids: [nodeId],
    observed_node_ids: [nodeId],
    observed_node_count: 1,
    status_counts: statusCounts(),
    failed: false,
    failed_node_ids: [],
    timed_out_node_ids: [],
    total_tokens: 100,
    cost_usd: 0.01,
    wall_time_seconds: 1,
    cost_evidence: complete()
  };
}

function statusCounts() {
  return {
    pending: 0,
    ready: 0,
    runnable: 0,
    running: 0,
    succeeded: 1,
    failed: 0,
    skipped: 0,
    "timed-out": 0,
    "reused-from-prior-run": 0,
    invalidated: 0
  };
}

function complete() {
  return { status: "complete", reason: null };
}

function bundleFile(filePath: string, contents: string) {
  const bytes = Buffer.from(contents, "utf8");
  return {
    path: filePath,
    size_bytes: bytes.byteLength,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    contents_base64: bytes.toString("base64")
  };
}

function firstRow(fixture: ReturnType<typeof gateFixture>) {
  return fixture.summary.rows[0]!;
}

function validateFixture(fixture: ReturnType<typeof gateFixture>): unknown {
  const files = fixture.pairBundles[0]!.bundle.files;
  const index = files.findIndex((file) => file.path === "eval/summary.json");
  files[index] = bundleFile("eval/summary.json", JSON.stringify(fixture.summary));
  return validateThreatModelBenchmarkGate(fixture.manifest, fixture.pairBundles);
}
