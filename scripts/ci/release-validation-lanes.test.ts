import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { RELEASE_VALIDATION_LANES } from "./release-validation-lanes.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const laneScript = path.join(repoRoot, "scripts", "ci", "release-validation-lanes.mjs");

interface WorkflowJob {
  if?: string;
  strategy?: { matrix?: { include?: string } };
  steps: Array<{ name?: string; if?: string; run?: string }>;
}

function declaredGateIds(): string[] {
  const source = fs.readFileSync(path.join(repoRoot, "scripts", "validate-release.mjs"), "utf8");
  const literal = [...source.matchAll(/\bgate\(\s*"([a-z0-9-]+)"/gu)].map((match) => match[1]);
  const templated = [...source.matchAll(/\bgate\(\s*`([a-z0-9-]+)-\$\{index\}`/gu)].flatMap((match) => {
    const shardTotals = /\[([0-9, ]+)\]\.map/u.exec(source)?.[1];
    if (shardTotals === undefined) throw new Error("could not read the runtime shard indexes");
    return shardTotals.split(",").map((index) => `${match[1]}-${index.trim()}`);
  });
  return [...literal, ...templated];
}

function laneGates(lanes: ReadonlyArray<{ gates: string }>): string[] {
  return lanes.flatMap((lane) => lane.gates.split(","));
}

function gatedByEvent(condition: string | undefined): boolean {
  return /event_name|pull_request/u.test(condition ?? "");
}

function workflowJobs(): Record<string, WorkflowJob> {
  const workflow = parse(fs.readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8")) as {
    jobs: Record<string, WorkflowJob>;
  };
  return workflow.jobs;
}

describe("release validation lanes", () => {
  it("run every gate scripts/validate-release.mjs defines exactly once", () => {
    const gates = laneGates(RELEASE_VALIDATION_LANES);
    expect(gates.length).toBeGreaterThan(0);
    expect([...gates].sort()).toEqual([...declaredGateIds()].sort());
    expect(new Set(gates).size).toBe(gates.length);
  });

  it("are not gated off pull requests by the workflow", () => {
    // While release validation carried `if: github.event_name != 'pull_request'`,
    // every runtime test reported `skipping` on pull requests and resume-path
    // regressions merged with all checks green.
    const jobs = workflowJobs();
    const releaseValidation = jobs["release-validation"];
    expect(gatedByEvent(releaseValidation?.if)).toBe(false);
    expect(releaseValidation?.steps.filter((step) => gatedByEvent(step.if)).map((step) => step.name)).toEqual([]);
    expect(releaseValidation?.strategy?.matrix?.include).toBe(
      "${{ fromJSON(needs.release-validation-lanes.outputs.lanes) }}"
    );
    const requirement = jobs["release-gates"]?.steps.find((step) => step.name === "Require release validation lanes");
    expect(requirement?.if).toContain("needs.release-validation.result != 'success'");
    expect(gatedByEvent(requirement?.if)).toBe(false);
  });

  it("build every package validate-release.mjs imports before any lane runs it", () => {
    // A lane that skips this build dies with ERR_MODULE_NOT_FOUND before it selects a gate. Behind
    // a per-lane flag, the runtime lanes lost the build when they stopped building modal.
    const source = fs.readFileSync(path.join(repoRoot, "scripts", "validate-release.mjs"), "utf8");
    const imported = new Set(
      [...source.matchAll(/from "\.\.\/packages\/([a-z0-9-]+)\/dist\//gu)].map((match) => match[1])
    );
    expect(imported.size).toBeGreaterThan(0);
    const steps = workflowJobs()["release-validation"]?.steps ?? [];
    const validate = steps.findIndex((step) => step.run?.includes("pnpm -w validate:release") === true);
    expect(validate).toBeGreaterThan(0);
    for (const name of imported) {
      const build = steps.findIndex((step) => step.run?.trim() === `pnpm --filter @ultrafuzz/${name}... build`);
      expect(build).toBeGreaterThanOrEqual(0);
      expect(build).toBeLessThan(validate);
      expect(steps[build]?.if).toBeUndefined();
    }
  });

  it("are printed as the workflow matrix", () => {
    const result = spawnSync(process.execPath, [laneScript], { cwd: repoRoot, encoding: "utf8" });
    expect(result.status).toBe(0);
    const lanes = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    expect(lanes).toEqual(JSON.parse(JSON.stringify(RELEASE_VALIDATION_LANES)));
    for (const lane of lanes) {
      expect(typeof lane.description).toBe("string");
      expect(typeof lane.timeout_minutes).toBe("number");
    }
  });
});
