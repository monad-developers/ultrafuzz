import fs from "node:fs";
import os from "node:os";
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
    expect(catalog.defaultProfile).toBe("default");
    expect(Object.keys(catalog.profiles)).toEqual(["default", "exhaustive", "invariant-only", "low-cost", "smoke"]);
    expect(catalog.digest).toMatch(/^[0-9a-f]{64}$/u);

    const smoke = auditProfile("smoke", catalog);
    expect(smoke.topologyPath).toBe("topologies/smoke.yml");
    expect(smoke.settings.strategy_loops).toBe(1);
    expect(smoke.settings.dynamic_strategies_enumerator).toBe(0);
    expect(smoke.settings.same_agent_attempts).toBe(1);
    const smokePath = packagedTopologyPath(smoke, catalog);
    expect(smokePath).toBeDefined();
    expect(fs.readFileSync(smokePath!, "utf8")).toContain("id: smoke-context");
    expect(packagedTopologyDigest(smoke, catalog)).toMatch(/^[0-9a-f]{64}$/u);

    const invariantOnly = auditProfile("invariant-only", catalog);
    expect(invariantOnly.settings.dynamic_strategies_enumerator).toBe(0);
    expect(fs.readFileSync(packagedTopologyPath(invariantOnly, catalog)!, "utf8")).toContain(
      "id: stateful-invariant-campaign"
    );
    expect(packagedTopologyPath(auditProfile("default", catalog), catalog)).toBeUndefined();
    expect(auditProfile("exhaustive", catalog).settings.dynamic_strategies_enumerator).toBe("unlimited");
  });

  it("resolves the reserved default profile as the unmodified project workflow", () => {
    const catalog = loadAuditProfileCatalog();
    const profile = auditProfile(catalog.defaultProfile, catalog);
    expect(profile.description).toContain("no settings overrides");
    expect(profile.description).toContain("project topology");
    expect(profile.settings).toEqual({});
    expect(profile.topologyPath).toBeUndefined();
    expect(packagedTopologyPath(profile, catalog)).toBeUndefined();

    const resolved = resolveConfig({ env: {} });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.auditProfile).toBe("default");
    expect(resolved.value.topologyPath).toBeUndefined();
    expect(resolved.value.auditProfileResolution.declaredTopologyPath).toBeUndefined();
    expect(resolved.value.auditProfileResolution.settings).toEqual({});
    expect(resolved.value.auditProfileResolution.overriddenSettings).toEqual([]);
  });

  it("fails closed when the catalog omits the reserved default profile", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-audit-profiles-"));
    const catalogPath = path.join(directory, "audit-profiles.yml");
    try {
      fs.writeFileSync(
        catalogPath,
        `schema_version: 2
profiles:
  smoke:
    description: Smoke profile.
    intended_use: Tests.
    settings: {}
`,
        "utf8"
      );
      expect(() => loadAuditProfileCatalog(catalogPath)).toThrow(
        /profiles\.default: required default audit profile `default` is not defined; define profiles\.default/u
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "settings overrides",
      profile: `    settings:
      strategy_loops: 2`,
      diagnostic: /profiles\.default\.settings: default audit profile must not override settings/u
    },
    {
      label: "a topology override",
      profile: `    topology_path: topologies/smoke.yml
    settings: {}`,
      diagnostic: /profiles\.default\.topology_path: default audit profile must use the project topology/u
    }
  ])("fails closed when the reserved default profile declares $label", ({ profile, diagnostic }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-audit-profiles-"));
    const catalogPath = path.join(directory, "audit-profiles.yml");
    try {
      fs.writeFileSync(
        catalogPath,
        `schema_version: 2
profiles:
  default:
    description: Default profile.
    intended_use: General audits.
${profile}
`,
        "utf8"
      );
      expect(() => loadAuditProfileCatalog(catalogPath)).toThrow(diagnostic);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects the legacy top-level default pointer", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-audit-profiles-"));
    const catalogPath = path.join(directory, "audit-profiles.yml");
    try {
      fs.writeFileSync(
        catalogPath,
        `schema_version: 2
default: default
profiles:
  default:
    description: Default profile.
    intended_use: General audits.
    settings: {}
`,
        "utf8"
      );
      expect(() => loadAuditProfileCatalog(catalogPath)).toThrow(/Unrecognized key.*default/u);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("parses and serializes the unlimited dynamic strategy enumerator", () => {
    const parsed = parseProjectConfigToml('dynamic_strategies_enumerator = "unlimited"\n');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const resolved = resolveConfig({ env: {}, projectConfig: parsed.value });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.dynamicStrategiesEnumerator).toBe("unlimited");
    expect(serializeResolvedConfigToml(resolved.value)).toContain('dynamic_strategies_enumerator = "unlimited"');
  });

  it.each(["balanced", "fuzz-only", "thorough"])(
    "rejects removed profile %s with the available profile vocabulary",
    (profile) => {
      expect(() => auditProfile(profile)).toThrow(/available profiles: default, exhaustive, invariant-only/u);
    }
  );

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

[retry]
same_agent_attempts = 2
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
    expect(resolved.value.retry.sameAgentAttempts).toBe(2);
    expect(resolved.value.triage).toEqual({ quorum: 2, panelSize: 3 });
    expect(resolved.value.auditProfileResolution.overriddenSettings).toEqual([
      "max_parallel_agents",
      "max_parallel_nodes",
      "same_agent_attempts",
      "strategy_loops"
    ]);
    expect(resolved.value.auditProfileResolution.effectiveSettings).toMatchObject({
      strategy_loops: 2,
      dynamic_strategies_enumerator: 1,
      max_parallel_agents: 6,
      max_parallel_nodes: 7,
      same_agent_attempts: 2,
      triage_quorum: 2,
      triage_panel_size: 3
    });
    expect(resolved.value.auditProfileResolution.settingOrigins).toMatchObject({
      strategy_loops: "project-config",
      dynamic_strategies_enumerator: "audit-profile",
      max_parallel_agents: "project-config",
      max_parallel_nodes: "runtime-override",
      same_agent_attempts: "project-config",
      triage_quorum: "audit-profile",
      triage_panel_size: "audit-profile"
    });
    expect(serializeResolvedConfigToml(resolved.value)).toContain('audit_profile = "low-cost"');
    expect(serializeResolvedConfigToml(resolved.value)).toContain('topology_path = ".ultrafuzz/custom-topology.yml"');
  });

  it("fails unknown audit profiles during typed resolution", () => {
    const resolved = resolveConfig({ env: {}, projectConfig: { auditProfile: "balanced" } });
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
