import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The generated workflow-runner workspace and this repository install Effect
 * independently. The runner manifest pins Effect and the `@effect/*` packages so a
 * cloud run cannot end up with two Effect builds; pinning only there would leave
 * the repository's own Smithers integration test running against whatever the open
 * caret on `@effect/platform-node-shared` resolves to, so CI would not exercise the
 * tree production installs. These two pin sets must stay identical.
 */
describe("workspace workflow-engine overrides", () => {
  const workspaceOverrides = (
    parseYaml(fs.readFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8")) as {
      overrides?: Record<string, string>;
    }
  ).overrides;

  const runnerOverrides = (() => {
    const source = fs.readFileSync(path.join(repoRoot, "packages", "runtime", "src", "smithers-package.ts"), "utf8");
    const effectVersion = /export const SMITHERS_EFFECT_VERSION = "([^"]+)"/u.exec(source)?.[1];
    const nameBlock = /const SMITHERS_EFFECT_PACKAGE_NAMES = \[([\s\S]*?)\] as const;/u.exec(source)?.[1];
    if (effectVersion === undefined || nameBlock === undefined) {
      throw new Error("could not read the pinned Effect override set from smithers-package.ts");
    }
    const names = [...nameBlock.matchAll(/"([^"]+)"/gu)].map((match) => match[1]!);
    return Object.fromEntries([["effect", effectVersion], ...names.map((name) => [name, effectVersion])]);
  })();
  const workspaceEffectOverrides = Object.fromEntries(
    Object.keys(runnerOverrides).map((name) => [name, workspaceOverrides?.[name]])
  );

  it("pins the same Effect versions the generated runner manifest pins", () => {
    expect(workspaceEffectOverrides).toEqual(runnerOverrides);
  });

  it("pins every Effect package onto a single version", () => {
    const versions = new Set(Object.values(workspaceEffectOverrides));
    expect(versions.size).toBe(1);
  });

  it("pins the version the pinned runner itself declares", () => {
    const runnerManifest = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "packages", "runtime", "node_modules", "smthrs", "package.json"), "utf8")
    ) as { dependencies?: Record<string, string> };
    expect(workspaceOverrides?.effect).toBe(runnerManifest.dependencies?.effect);
  });
});
