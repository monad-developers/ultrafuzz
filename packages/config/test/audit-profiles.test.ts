import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { auditProfile, loadAuditProfileCatalog, packagedTopologyDigest, packagedTopologyPath } from "../src/index.js";

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
});
