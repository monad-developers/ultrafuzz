import assert from "node:assert/strict";
import test from "node:test";

import { resolveConfig } from "@ultrafuzz/config";

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
