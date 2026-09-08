import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PULL_REQUEST_REQUIRED_GATES,
  RELEASE_VALIDATION_LANES,
  selectReleaseValidationLanes
} from "./release-validation-lanes.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
const runtimeTestDir = path.join(repoRoot, "packages", "runtime", "test");

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

describe("release validation lane policy", () => {
  it("names only gates that scripts/validate-release.mjs defines", () => {
    const declared = new Set(declaredGateIds());
    expect(declared.size).toBeGreaterThan(0);
    for (const gate of laneGates(RELEASE_VALIDATION_LANES)) expect(declared.has(gate)).toBe(true);
  });

  it("runs every declared gate exactly once on push", () => {
    const gates = laneGates(selectReleaseValidationLanes("push"));
    expect([...gates].sort()).toEqual([...declaredGateIds()].sort());
    expect(new Set(gates).size).toBe(gates.length);
  });

  it("runs the whole runtime suite on pull requests", () => {
    const gates = laneGates(selectReleaseValidationLanes("pull_request"));
    expect([...gates].sort()).toEqual([...PULL_REQUEST_REQUIRED_GATES].sort());
  });

  it("gives the complete supporting runtime suite its proven shared-runner budget", () => {
    const supporting = RELEASE_VALIDATION_LANES.find((lane) => lane.lane === "runtime-supporting");
    expect(supporting?.timeout_minutes).toBe(120);
  });

  it("covers every runtime test file on pull requests", () => {
    // runtime-1..runtime-4 shard packages/runtime/test/runtime.test.ts by test
    // name; runtime-supporting runs every other runtime test file. Nothing in
    // the runtime package may fall outside that set, because run resume,
    // controller refresh, replay, and fork are only covered there.
    const gates = new Set(laneGates(selectReleaseValidationLanes("pull_request")));
    const shardScript = fs.readFileSync(
      path.join(repoRoot, "packages", "runtime", "scripts", "run-runtime-test-shard.mjs"),
      "utf8"
    );
    expect(shardScript).toContain("dist-test/test/runtime.test.js");
    const shardTotal = [...gates].filter((gate) => /^runtime-[0-9]+$/u.test(gate)).length;
    for (let index = 1; index <= shardTotal; index += 1) expect(gates.has(`runtime-${index}`)).toBe(true);
    const describedShards = RELEASE_VALIDATION_LANES.filter((lane) => /^runtime-[0-9]+$/u.test(lane.lane)).map((lane) =>
      /shard ([0-9]+)\/([0-9]+)$/u.exec(lane.description)
    );
    expect(describedShards.length).toBe(shardTotal);
    for (const match of describedShards) expect(Number(match?.[2])).toBe(shardTotal);
    expect(gates.has("runtime-supporting")).toBe(true);
    const runtimeTestFiles = fs.readdirSync(runtimeTestDir).filter((entry) => entry.endsWith(".test.ts"));
    expect(runtimeTestFiles).toContain("runtime.test.ts");
    expect(runtimeTestFiles).toContain("dynamic-lifecycle.test.ts");
  });

  it("does not let the workflow gate release validation off pull requests", () => {
    // Regression guard for the outage this policy exists to prevent: while the
    // release-validation job carried `if: github.event_name != 'pull_request'`,
    // every runtime test reported `skipping` on pull requests and resume-path
    // regressions merged with all checks green.
    const releaseValidation = workflow.slice(workflow.indexOf("\n  release-validation:"));
    const job = releaseValidation.slice(0, releaseValidation.indexOf("\n  release-gates:"));
    expect(job).not.toContain("if: github.event_name != 'pull_request'");
    expect(job).toContain("fromJSON(needs.release-validation-lanes.outputs.lanes)");
  });

  it("requires the release validation lanes on pull requests", () => {
    const releaseGates = workflow.slice(workflow.indexOf("\n  release-gates:"));
    const requirement = releaseGates.slice(releaseGates.indexOf("Require release validation lanes"));
    const step = requirement.slice(0, requirement.indexOf("\n      - name:"));
    expect(step).toContain("needs.release-validation.result != 'success'");
    expect(step).not.toContain("github.event_name != 'pull_request'");
  });

  it("emits the workflow matrix for an event", () => {
    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "ci", "release-validation-lanes.mjs"), "--event", "pull_request"],
      { cwd: repoRoot, encoding: "utf8" }
    );
    expect(result.status).toBe(0);
    const lanes = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    expect(lanes.map((lane) => lane.lane)).toEqual([
      "runtime-supporting",
      "runtime-1",
      "runtime-2",
      "runtime-3",
      "runtime-4"
    ]);
    for (const lane of lanes) {
      expect(lane).not.toHaveProperty("pull_request");
      expect(typeof lane.description).toBe("string");
      expect(typeof lane.timeout_minutes).toBe("number");
    }
  });

  it("rejects a missing event name", () => {
    expect(() => selectReleaseValidationLanes("")).toThrow();
    const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "ci", "release-validation-lanes.mjs")], {
      cwd: repoRoot,
      encoding: "utf8"
    });
    expect(result.status).not.toBe(0);
  });
});
