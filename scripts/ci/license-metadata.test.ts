import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The repository declares MIT in three places that a reader treats as one statement: the root `LICENSE`
 * text, the root manifest, and every workspace manifest. A package that silently drops `license` publishes
 * as unlicensed, and a `LICENSE` whose holder or year drifts from `docs/licensing.md` makes the recorded
 * attribution evidence wrong. Both failures are invisible in review, so they are asserted here.
 */
describe("license metadata", () => {
  const license = fs.readFileSync(path.join(repoRoot, "LICENSE"), "utf8");

  const manifestPaths = (() => {
    const workspace = parseYaml(fs.readFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8")) as {
      packages?: string[];
    };
    const packages = workspace.packages ?? [];
    expect(packages.length).toBeGreaterThan(0);
    return ["package.json", ...packages.map((directory) => `${directory}/package.json`)];
  })();

  it("ships the standard MIT text", () => {
    expect(license.startsWith("MIT License\n")).toBe(true);
    expect(license).toInclude("Permission is hereby granted, free of charge, to any person obtaining a copy");
    expect(license).toInclude("The above copyright notice and this permission notice shall be included in all");
    expect(license).toInclude('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
  });

  it("carries a single-year copyright notice", () => {
    const notice = /^Copyright \(c\) (\d{4}) (.+)$/mu.exec(license);
    expect(notice).not.toBeNull();
    expect(notice?.[1]).toBe("2026");
    expect(notice?.[2]).toBe("Monad Developers");
  });

  it("declares MIT in the root manifest and every workspace manifest", () => {
    const declared = manifestPaths.map((manifestPath) => {
      const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, manifestPath), "utf8")) as {
        license?: string;
      };
      return [manifestPath, manifest.license] as const;
    });
    expect(Object.fromEntries(declared)).toEqual(
      Object.fromEntries(manifestPaths.map((manifestPath) => [manifestPath, "MIT"]))
    );
  });

  it("records the licensing decision, including why no NOTICE file exists", () => {
    expect(fs.existsSync(path.join(repoRoot, "NOTICE"))).toBe(false);
    const licensing = fs.readFileSync(path.join(repoRoot, "docs", "licensing.md"), "utf8");
    expect(licensing).toInclude("Copyright (c) 2026 Monad Developers");
    expect(licensing).toInclude("Why there is no NOTICE file");
  });
});
