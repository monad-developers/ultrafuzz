import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { resolveConfig } from "@ultrafuzz/config";
import { expandTopology, loadTopology } from "@ultrafuzz/topology";

import { effectiveAuditPolicy } from "../src/audit-profile-policy.js";

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
