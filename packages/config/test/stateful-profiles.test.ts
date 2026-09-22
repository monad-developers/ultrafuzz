import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  parseProjectConfigToml,
  resolveConfig,
  serializeResolvedConfigToml,
  validateResolvedConfigJson
} from "../src/index.js";

describe("stateful audit profile defaults", () => {
  it.each([
    ["default", "high", "priority", 3600],
    ["exhaustive", "medium", "priority", 14400],
    ["invariant-only", "high", "mandatory", 3600]
  ] as const)("resolves %s property and campaign policy", (auditProfile, priority, selection, seconds) => {
    const result = resolveConfig({ env: {}, runtimeOverrides: { auditProfile } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.invariants).toMatchObject({
      propertyPriorityThreshold: priority,
      referenceExpectationSelection: selection,
      invariantTestingFuzzerTimeoutSeconds: seconds
    });
    expect(validateResolvedConfigJson(result.value).ok).toBe(true);
  });

  it("fresh scaffolding does not pin the default when selecting exhaustive", () => {
    const defaults = resolveConfig({ env: {} });
    if (!defaults.ok) throw new Error("invalid defaults");
    const toml = serializeResolvedConfigToml(defaults.value, { omitAuditProfileManagedSettings: true });
    expect(toml).not.toContain("property_priority_threshold");
    expect(toml).not.toContain("reference_expectation_selection");
    expect(toml).not.toContain("invariant_testing_fuzzer_timeout");
    expect(toml).not.toContain("strategy_loops");
    const parsed = parseProjectConfigToml(toml);
    if (!parsed.ok) throw new Error("invalid scaffold");
    const result = resolveConfig({
      env: {},
      projectConfig: parsed.value,
      runtimeOverrides: { auditProfile: "exhaustive" }
    });
    if (!result.ok) throw new Error("invalid exhaustive scaffold");
    expect(result.value.strategyLoops).toBe(3);
    expect(result.value.invariants.propertyPriorityThreshold).toBe("medium");
    expect(result.value.invariants.invariantTestingFuzzerTimeoutSeconds).toBe(14400);
    expect(result.value.auditProfileResolution.settingOrigins.property_priority_threshold).toBe("audit-profile");
  });

  it("keeps explicit project and runtime selection overrides, including old high settings", () => {
    const parsed = parseProjectConfigToml(
      'audit_profile = "exhaustive"\nstrategy_loops = 4\n[invariants]\nproperty_priority_threshold = "high"\nreference_expectation_selection = "mandatory"\ninvariant_testing_fuzzer_timeout = "1h"\n'
    );
    if (!parsed.ok) throw new Error("invalid fixture");
    const result = resolveConfig({ env: {}, projectConfig: parsed.value });
    if (!result.ok) throw new Error("invalid override");
    expect(result.value.strategyLoops).toBe(4);
    expect(result.value.invariants).toMatchObject({
      propertyPriorityThreshold: "high",
      referenceExpectationSelection: "mandatory",
      invariantTestingFuzzerTimeoutSeconds: 3600
    });
    expect(result.value.auditProfileResolution.overriddenSettings).toEqual(
      expect.arrayContaining([
        "strategy_loops",
        "property_priority_threshold",
        "reference_expectation_selection",
        "invariant_testing_fuzzer_timeout_seconds"
      ])
    );
    const runtime = resolveConfig({
      env: {},
      projectConfig: parsed.value,
      runtimeOverrides: { invariants: { propertyPriorityThreshold: "low", referenceExpectationSelection: "priority" } }
    });
    if (!runtime.ok) throw new Error("invalid runtime override");
    expect(runtime.value.invariants.propertyPriorityThreshold).toBe("low");
    expect(runtime.value.auditProfileResolution.settingOrigins.reference_expectation_selection).toBe(
      "runtime-override"
    );
  });

  it("the repository project inherits exhaustive invariant settings from separate packaged defaults", () => {
    const parsed = parseProjectConfigToml(
      fs.readFileSync(fileURLToPath(new URL("../../../ultrafuzz.toml", import.meta.url)), "utf8")
    );
    if (!parsed.ok) throw new Error("invalid repository config");
    const result = resolveConfig({
      env: {},
      projectConfig: parsed.value,
      runtimeOverrides: { auditProfile: "exhaustive" }
    });
    if (!result.ok) throw new Error("invalid repository profile");
    expect(result.value.invariants.propertyPriorityThreshold).toBe("medium");
    expect(result.value.invariants.invariantTestingFuzzerTimeoutSeconds).toBe(14400);
  });

  it.each([undefined, 3600, 18000])(
    "preserves cloud timeout inheritance and explicit caps through TOML snapshots: %s",
    (timeoutSeconds) => {
      const resolved = resolveConfig({
        env: {},
        projectConfig: timeoutSeconds === undefined ? {} : { execution: { resources: { timeoutSeconds } } }
      });
      if (!resolved.ok) throw new Error("invalid timeout fixture");
      expect(resolved.value.execution.resourceTimeoutOrigin).toBe(
        timeoutSeconds === undefined ? "default" : "project-config"
      );
      expect(validateResolvedConfigJson(resolved.value).ok).toBe(true);
      const parsed = parseProjectConfigToml(serializeResolvedConfigToml(resolved.value));
      if (!parsed.ok) throw new Error("invalid serialized timeout");
      expect(parsed.value.execution?.resources?.timeoutSeconds).toBe(timeoutSeconds);
      const reloaded = resolveConfig({ env: {}, projectConfig: parsed.value });
      if (!reloaded.ok) throw new Error("invalid reloaded timeout");
      expect(reloaded.value.execution.resourceTimeoutOrigin).toBe(resolved.value.execution.resourceTimeoutOrigin);
      expect(reloaded.value.execution.resources.timeoutSeconds).toBe(resolved.value.execution.resources.timeoutSeconds);
      const runtime = resolveConfig({
        env: {},
        projectConfig: parsed.value,
        runtimeOverrides: { execution: { resources: { timeoutSeconds: 17000 } } }
      });
      if (!runtime.ok) throw new Error("invalid runtime timeout");
      expect(runtime.value.execution.resourceTimeoutOrigin).toBe("runtime-override");
      expect(runtime.value.execution.resources.timeoutSeconds).toBe(17000);
    }
  );

  it("rejects unknown expectation selection policies", () => {
    expect(parseProjectConfigToml('[invariants]\nreference_expectation_selection = "ignore"').ok).toBe(false);
  });
});
