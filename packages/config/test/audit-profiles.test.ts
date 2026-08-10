import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  auditProfile,
  loadAuditProfileCatalog,
  packagedTopologyDigest,
  packagedTopologyPath,
  parseProjectConfigToml,
  resolveConfig,
  serializeResolvedConfigToml
} from "../src/index.js";

describe("audit profile catalog", () => {
  it("loads the complete shipped vocabulary and resolves packaged topologies", () => {
    const catalog = loadAuditProfileCatalog();
    expect(catalog.defaultProfile).toBe("balanced");
    expect(Object.keys(catalog.profiles)).toEqual([
      "balanced",
      "exhaustive",
      "invariant-only",
      "low-cost",
      "smoke",
      "thorough"
    ]);
    expect(catalog.digest).toMatch(/^[0-9a-f]{64}$/u);

    const smoke = auditProfile("smoke", catalog);
    expect(smoke.topologyPath).toBe("topologies/smoke.yml");
    expect(smoke.settings.strategy_loops).toBe(1);
    const smokePath = packagedTopologyPath(smoke, catalog);
    expect(smokePath).toBeDefined();
    expect(fs.readFileSync(smokePath!, "utf8")).toContain("id: smoke-context");
    expect(packagedTopologyDigest(smoke, catalog)).toMatch(/^[0-9a-f]{64}$/u);

    const invariantOnly = auditProfile("invariant-only", catalog);
    expect(fs.readFileSync(packagedTopologyPath(invariantOnly, catalog)!, "utf8")).toContain(
      "id: stateful-invariant-campaign"
    );
    expect(packagedTopologyPath(auditProfile("balanced", catalog), catalog)).toBeUndefined();
  });

  it("fails unknown names with the available profile vocabulary", () => {
    expect(() => auditProfile("fastest")).toThrow(/available profiles: balanced, exhaustive, invariant-only/u);
  });

  it("ships every declared topology beside the built catalog", () => {
    const catalog = loadAuditProfileCatalog();
    for (const profile of Object.values(catalog.profiles)) {
      if (profile.topologyPath === undefined) continue;
      const resolved = packagedTopologyPath(profile, catalog)!;
      expect(path.relative(path.dirname(catalog.path), resolved)).toBe(profile.topologyPath);
      expect(fs.statSync(resolved).isFile()).toBe(true);
    }
  });

  it("applies profile settings below explicit project and runtime overrides", () => {
    const parsed = parseProjectConfigToml(`
audit_profile = "low-cost"
topology_path = ".ultrafuzz/custom-topology.yml"
strategy_loops = 2

[run]
max_parallel_agents = 6
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const resolved = resolveConfig({
      env: {},
      projectConfig: parsed.value,
      runtimeOverrides: { maxParallelNodes: 7 }
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.auditProfile).toBe("low-cost");
    expect(resolved.value.topologyPath).toBe(".ultrafuzz/custom-topology.yml");
    expect(resolved.value.strategyLoops).toBe(2);
    expect(resolved.value.dynamicStrategiesEnumerator).toBe(1);
    expect(resolved.value.run.maxParallelAgents).toBe(6);
    expect(resolved.value.run.maxParallelNodes).toBe(7);
    expect(resolved.value.triage).toEqual({ quorum: 2, panelSize: 3 });
    expect(resolved.value.auditProfileResolution.overriddenSettings).toEqual([
      "max_parallel_agents",
      "max_parallel_nodes",
      "strategy_loops"
    ]);
    expect(resolved.value.auditProfileResolution.effectiveSettings).toMatchObject({
      strategy_loops: 2,
      dynamic_strategies_enumerator: 1,
      max_parallel_agents: 6,
      max_parallel_nodes: 7,
      triage_quorum: 2,
      triage_panel_size: 3
    });
    expect(resolved.value.auditProfileResolution.settingOrigins).toMatchObject({
      strategy_loops: "project-config",
      dynamic_strategies_enumerator: "audit-profile",
      max_parallel_agents: "project-config",
      max_parallel_nodes: "runtime-override",
      triage_quorum: "audit-profile",
      triage_panel_size: "audit-profile"
    });
    expect(serializeResolvedConfigToml(resolved.value)).toContain('audit_profile = "low-cost"');
    expect(serializeResolvedConfigToml(resolved.value)).toContain('topology_path = ".ultrafuzz/custom-topology.yml"');
  });

  it("fails unknown audit profiles during typed resolution", () => {
    const resolved = resolveConfig({ env: {}, projectConfig: { auditProfile: "fastest" } });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.diagnostics[0]).toMatchObject({
      code: "CONFIG_AUDIT_PROFILE_INVALID",
      path: ["audit_profile"],
      source: "audit-profile"
    });
    expect(resolved.diagnostics[0]?.message).toContain("available profiles");
  });
});
