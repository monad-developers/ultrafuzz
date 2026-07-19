import { afterEach, describe, expect, it } from "bun:test";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    cpSync(join(repoRoot, ".ultrafuzz", "prompts"), join(targetRoot, ".ultrafuzz", "prompts"), { recursive: true });
    copyFileSync(join(repoRoot, "ultrafuzz.toml"), join(targetRoot, "ultrafuzz.toml"));

    configureTargetE2e(targetRoot, 900);

    const topology = parse(readFileSync(join(targetRoot, ".ultrafuzz", "topology.yml"), "utf-8")) as {
      defaults: { strategy_loops: number };
      groups: { strategies: { defaults: { loops: number; timeout_seconds: number; model_profiles: string[] } } };
      nodes: Array<{ id: string; depends_on: string[]; prompt?: string }>;
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
    expect(config).toContain('[agents.CodexAgent]\nauth = "api-key"');
    expect(config).not.toContain("signal_profile");

    for (const node of topology.nodes) {
      if (node.prompt === undefined) continue;
      const prompt = readFileSync(join(targetRoot, ".ultrafuzz", "prompts", node.prompt), "utf-8");
      const referencedNodeIds = [...prompt.matchAll(/\{\{artifact_(?:path|handoff):([^}]+)\}\}/gu)].map(
        (match) => match[1] as string
      );
      expect(referencedNodeIds.every((referenced) => ids.has(referenced))).toBe(true);
    }
  });
});

describe("target E2E workflow", () => {
  it("rejects an empty or incomplete dynamic matrix before expansion", () => {
    const workflow = parse(readFileSync(join(repoRoot, ".github", "workflows", "target-e2e.yml"), "utf-8")) as {
      jobs: {
        "target-matrix": { steps: Array<{ name?: string; run?: string }> };
      };
    };

    const steps = workflow.jobs["target-matrix"].steps;
    const validationIndex = steps.findIndex((step) => step.name === "Validate target matrix cardinality");
    const readIndex = steps.findIndex((step) => step.name === "Read target manifest");
    const validation = steps[validationIndex]?.run ?? "";

    expect(validationIndex).toBeGreaterThanOrEqual(0);
    expect(readIndex).toBeGreaterThan(validationIndex);
    expect(validation).toContain("length == 3");
    expect(validation).toContain('"very-liquid-vaults-foundry"');
    expect(validation).toContain('"venus-isolated-pools-hardhat"');
    expect(validation).toContain('"stableswap-ng-vyper"');
  });

  it("installs pnpm before setup-node enables the pnpm cache", () => {
    const workflow = parse(readFileSync(join(repoRoot, ".github", "workflows", "target-e2e.yml"), "utf-8")) as {
      jobs: {
        "ultrafuzz-target": {
          steps: Array<{ name?: string; uses?: string; run?: string; with?: Record<string, unknown> }>;
        };
      };
    };

    const steps = workflow.jobs["ultrafuzz-target"].steps;
    const pnpmSetupIndex = steps.findIndex((step) => step.uses?.startsWith("pnpm/action-setup@") === true);
    const nodeCacheIndex = steps.findIndex((step) => step.name === "Set up Node.js 22" && step.with?.cache === "pnpm");

    expect(pnpmSetupIndex).toBeGreaterThanOrEqual(0);
    expect(nodeCacheIndex).toBeGreaterThanOrEqual(0);
    expect(pnpmSetupIndex).toBeLessThan(nodeCacheIndex);
  });

  it("installs framework toolchains only for their target", () => {
    const workflow = parse(readFileSync(join(repoRoot, ".github", "workflows", "target-e2e.yml"), "utf-8")) as {
      jobs: {
        "ultrafuzz-target": {
          steps: Array<{ name?: string; if?: string }>;
        };
      };
    };

    const foundry = workflow.jobs["ultrafuzz-target"].steps.find((step) => step.name === "Install Foundry");
    expect(foundry?.if).toBe("matrix.target.framework == 'foundry'");
  });

  it("keeps the Hardhat Yarn shim usable from generated worktrees", () => {
    const workflow = parse(readFileSync(join(repoRoot, ".github", "workflows", "target-e2e.yml"), "utf-8")) as {
      jobs: {
        "ultrafuzz-target": {
          steps: Array<{ name?: string; run?: string }>;
        };
      };
    };

    const step = workflow.jobs["ultrafuzz-target"].steps.find(
      (candidate) => candidate.name === "Preserve compatible Yarn runtime for agents"
    );

    expect(step?.run).toContain('target_yarn_cli="$GITHUB_WORKSPACE/.target-source/.yarn/releases/yarn-1.22.1.cjs"');
    expect(step?.run).toContain('yarn_cli="__TARGET_YARN_CLI__"');
    expect(step?.run).toContain('-e "s|__TARGET_YARN_CLI__|$target_yarn_cli|g"');
  });
});

describe("target E2E runner", () => {
  it("syncs pinned references before validation and run launch", () => {
    const script = readFileSync(join(repoRoot, "scripts", "ci", "run-target-e2e.sh"), "utf-8");
    const syncCommandIndex = script.indexOf('"$ultrafuzz_bin" references sync');
    const syncCallIndex = script.indexOf("\nsync_reference_cache\n");
    const validateIndex = script.indexOf('run_cli_json "$evidence_root/validate.json"');
    const runIndex = script.indexOf('run_cli_json "$evidence_root/run.json"');

    expect(syncCommandIndex).toBeGreaterThanOrEqual(0);
    expect(syncCallIndex).toBeGreaterThanOrEqual(0);
    expect(validateIndex).toBeGreaterThanOrEqual(0);
    expect(runIndex).toBeGreaterThanOrEqual(0);
    expect(syncCallIndex).toBeLessThan(validateIndex);
    expect(syncCallIndex).toBeLessThan(runIndex);
  });

  it("preserves target build diagnostics while resetting run evidence", () => {
    const script = readFileSync(join(repoRoot, "scripts", "ci", "run-target-e2e.sh"), "utf-8");
    const preserveIndex = script.indexOf('cp -- "$evidence_root/target-build.log" "$preserved_build_log"');
    const resetIndex = script.indexOf('rm -rf -- "$run_root"');
    const restoreIndex = script.indexOf('cp -- "$preserved_build_log" "$evidence_root/target-build.log"');

    expect(preserveIndex).toBeGreaterThanOrEqual(0);
    expect(resetIndex).toBeGreaterThan(preserveIndex);
    expect(restoreIndex).toBeGreaterThan(resetIndex);
  });
});
