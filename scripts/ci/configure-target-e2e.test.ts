import { afterEach, describe, expect, it } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { configureTargetE2e } from "./configure-target-e2e.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("production smoke topology configuration", () => {
  it("retains production phases while removing only excluded lanes", () => {
    const targetRoot = mkdtempSync(join(tmpdir(), "ultrafuzz-smoke-topology-"));
    temporaryRoots.push(targetRoot);
    mkdirSync(join(targetRoot, ".ultrafuzz"), { recursive: true });
    copyFileSync(join(repoRoot, ".ultrafuzz", "topology.yml"), join(targetRoot, ".ultrafuzz", "topology.yml"));
    copyFileSync(join(repoRoot, "ultrafuzz.toml"), join(targetRoot, "ultrafuzz.toml"));

    configureTargetE2e(targetRoot, 900);

    const topology = parse(readFileSync(join(targetRoot, ".ultrafuzz", "topology.yml"), "utf-8")) as {
      defaults: { strategy_loops: number };
      groups: { strategies: { defaults: { loops: number; timeout_seconds: number; model_profiles: string[] } } };
      nodes: Array<{ id: string; depends_on: string[] }>;
    };
    const ids = new Set(topology.nodes.map((node) => node.id));
    expect(topology.defaults.strategy_loops).toBe(1);
    expect(topology.groups.strategies.defaults).toMatchObject({
      loops: 1,
      timeout_seconds: 900,
      model_profiles: ["target-e2e"]
    });
    expect(ids).toContain("project-discovery");
    expect(ids).toContain("property-specification-fanin");
    expect(ids).toContain("dedupe-findings");
    expect(ids).toContain("final-report");
    expect(ids).not.toContain("stateful-invariant-setup");
    expect(ids).not.toContain("differential-library-tests");
    expect(ids).not.toContain("dynamic-strategy-generator");
    expect(topology.nodes.every((node) => node.depends_on.every((dependency) => ids.has(dependency)))).toBe(true);

    const config = readFileSync(join(targetRoot, "ultrafuzz.toml"), "utf-8");
    expect(config).toContain('default = "target-e2e"');
    expect(config).toContain('model = "gpt-5.6-luna"');
    expect(config).toContain('reasoning = "high"');
    expect(config).not.toContain("signal_profile");
  });
});
