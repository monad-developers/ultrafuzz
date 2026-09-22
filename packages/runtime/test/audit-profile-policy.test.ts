import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { resolveConfig } from "@ultrafuzz/config";
import { expandTopology, loadTopology } from "@ultrafuzz/topology";

import { effectiveAuditPolicy } from "../src/audit-profile-policy.js";
import { transformTopologyForRun } from "../src/topology-transform.js";

test("stateful profiles expand two and three ordinary passes with one complete invariant pipeline", () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  for (const [auditProfile, loops, campaignTimeout] of [
    ["default", 2, 7200],
    ["exhaustive", 3, 16200]
  ] as const) {
    const resolved = resolveConfig({ env: {}, runtimeOverrides: { auditProfile } });
    if (!resolved.ok) throw new Error("invalid profile");
    const policy = effectiveAuditPolicy({ projectRoot: repositoryRoot, config: resolved.value });
    const topology = loadTopology(repositoryRoot, {
      topologyPath: policy.effectiveTopologyPath,
      requirePromptFiles: true
    });
    const graph = expandTopology(transformTopologyForRun(topology, { strategyLoops: policy.strategyLoops }), {
      projectRoot: repositoryRoot
    });
    assert.equal(policy.effectiveSettings.strategy_loops, loops);
    assert.equal(graph.nodes.filter((node) => node.logicalId === "boundary-tests").length, loops);
    const stages = [
      "stateful-invariant-setup",
      "stateful-invariant-handlers",
      "stateful-invariant-coverage",
      "stateful-invariant-implement-properties",
      "stateful-invariant-campaign"
    ];
    for (const stage of stages) assert.equal(graph.nodes.filter((node) => node.logicalId === stage).length, 1);
    assert.equal(
      graph.nodes.find((node) => node.logicalId === "stateful-invariant-campaign")?.timeoutSeconds,
      campaignTimeout
    );
    const visited = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      for (const dependency of graph.nodes.find((node) => node.id === id)?.dependsOn ?? []) visit(dependency);
    };
    for (const report of graph.nodes.filter((node) => node.logicalId === "final-report")) visit(report.id);
    for (const stage of stages) assert.ok(visited.has(stage), `${auditProfile} report must depend on ${stage}`);
  }
});

test("effective default loop metadata describes editable topology without overwriting it", () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-policy-loops-"));
  try {
    fs.mkdirSync(path.join(projectRoot, ".ultrafuzz"));
    const source = fs.readFileSync(path.join(repositoryRoot, ".ultrafuzz/topology.yml"), "utf8");
    const edited = source.replace("      loops: 2", "      loops: 7");
    fs.writeFileSync(path.join(projectRoot, ".ultrafuzz/topology.yml"), edited);
    const resolved = resolveConfig({ env: {} });
    if (!resolved.ok) throw new Error("invalid defaults");
    const policy = effectiveAuditPolicy({ projectRoot, config: resolved.value });
    assert.equal(policy.effectiveSettings.strategy_loops, 7);
    assert.equal(policy.strategyLoops, undefined);
    assert.equal(fs.readFileSync(path.join(projectRoot, ".ultrafuzz/topology.yml"), "utf8"), edited);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("runtime strategy loops update effective audit policy provenance", () => {
  const resolved = resolveConfig({ env: {}, runtimeOverrides: { auditProfile: "smoke" } });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;

  const policy = effectiveAuditPolicy({
    projectRoot: process.cwd(),
    config: resolved.value,
    runtimeStrategyLoops: 3
  });

  assert.equal(policy.strategyLoops, 3);
  assert.equal(policy.effectiveSettings.strategy_loops, 3);
  assert.equal(policy.settingOrigins.strategy_loops, "runtime-override");
  assert.deepEqual(policy.overriddenSettings, ["strategy_loops"]);
});

test("audit profile retry budgets reach every agentic node without topology shadowing", () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  for (const [auditProfile, expectedAttempts] of [
    ["smoke", 1],
    ["low-cost", 1],
    ["default", 3],
    ["invariant-only", 3],
    ["exhaustive", 5]
  ] as const) {
    const resolved = resolveConfig({ env: {}, runtimeOverrides: { auditProfile } });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) continue;
    const policy = effectiveAuditPolicy({ projectRoot: repositoryRoot, config: resolved.value });
    const topology = loadTopology(repositoryRoot, {
      topologyPath: policy.effectiveTopologyPath,
      requirePromptFiles: true
    });
    const graph = expandTopology(topology, {
      projectRoot: repositoryRoot,
      defaultMaxAttempts: resolved.value.retry.sameAgentAttempts
    });
    const actualAttempts = [
      ...new Set(graph.nodes.filter((node) => node.kind === "agentic").map((node) => node.retryPolicy.maxAttempts))
    ];
    assert.deepEqual(actualAttempts, [expectedAttempts], `${auditProfile} retry authority was shadowed`);
  }
});
