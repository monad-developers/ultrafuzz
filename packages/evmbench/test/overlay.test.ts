import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { findUltrafuzzRepoRoot } from "../src/definition.js";

describe("EVMBench overlay build context", () => {
  it("keeps generated state out while retaining runtime scaffold assets", () => {
    const repoRoot = findUltrafuzzRepoRoot();
    const patterns = fs
      .readFileSync(path.join(repoRoot, ".dockerignore"), "utf8")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));

    expect(patterns).not.toContain(".ultrafuzz");
    expect(patterns).not.toContain(".ultrafuzz/");
    expect(patterns).toEqual(
      expect.arrayContaining([
        ".ultrafuzz/*",
        "!.ultrafuzz/prompts",
        "!.ultrafuzz/prompts/**",
        "!.ultrafuzz/references.yml",
        "!.ultrafuzz/topology.yml"
      ])
    );

    expect(fs.existsSync(path.join(repoRoot, ".ultrafuzz", "topology.yml"))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, ".ultrafuzz", "prompts", "review", "final-report.md"))).toBe(true);
    expect(
      fs.existsSync(
        path.join(repoRoot, ".ultrafuzz", "prompts", "_templates", "output-contract", "output-contract.mdx")
      )
    ).toBe(true);
    expect(patterns).not.toContain("!.ultrafuzz/evals");
  });

  it("does not shell-interpolate profile override build arguments", () => {
    const repoRoot = findUltrafuzzRepoRoot();
    const dockerfile = fs.readFileSync(path.join(repoRoot, "benchmarks", "evmbench", "overlay.Dockerfile"), "utf8");

    expect(dockerfile).toContain('RUN ["node", "-e"');
    expect(dockerfile).not.toContain('"${MODEL}"');
    expect(dockerfile).not.toContain('"${REASONING}"');
  });
});
