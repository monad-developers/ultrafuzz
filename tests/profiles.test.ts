import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledProfilesDirectory, listProfiles, loadProfile, renderPrompt, stageProfile, type PromptContext } from "../src/profiles";

const directories: string[] = [];
const previousRoot = process.env.ULTRAFUZZ_PROFILE_DIR;
afterEach(async () => {
  if (previousRoot === undefined) delete process.env.ULTRAFUZZ_PROFILE_DIR;
  else process.env.ULTRAFUZZ_PROFILE_DIR = previousRoot;
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(options: { available?: boolean; requires_properties?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ultrafuzz-profiles-"));
  directories.push(root);
  const catalog = join(root, "profiles");
  const directory = join(catalog, "test", "profile");
  await mkdir(join(directory, "config"), { recursive: true });
  await writeFile(join(directory, "profile.json"), JSON.stringify({ name: "test/profile", description: "Test profile", harnesses: ["opencode"], available: true, ...options }));
  await writeFile(join(directory, "prompt.mdx"), "Review the source. {globalThis.__profileExecuted = true}");
  process.env.ULTRAFUZZ_PROFILE_DIR = catalog;
  return { root, directory };
}

const context: PromptContext = { repository: "https://github.com/example/project", commit: "a".repeat(40), workspace: "/run-data/workspace", output_dir: "/run-data/outputs/raw", reference_dir: "/run-data/reference", skill_dir: "/run-data/profile/skills", timeout_seconds: 7200, inputs: [] };

describe("profiles", () => {
  test("bundled catalog exposes available profiles and explicitly unavailable Pareto", async () => {
    process.env.ULTRAFUZZ_PROFILE_DIR = bundledProfilesDirectory;
    const profiles = await listProfiles();
    expect(profiles.map(profile => profile.name).sort()).toEqual(["v2/pareto", "v2/property-specification", "v2/stateful-fuzzing"]);
    await expect(loadProfile("v2/pareto", "opencode")).rejects.toThrow("unavailable");
    expect((await loadProfile("v2/property-specification", "codex")).requires_properties).toBe(false);
    expect((await loadProfile("v2/stateful-fuzzing", "claude-code")).requires_properties).toBe(true);
  });

  test("refuses unsupported harnesses and paths outside the catalog", async () => {
    const { root } = await fixture();
    await expect(loadProfile("test/profile", "codex")).rejects.toThrow("does not support");
    await expect(loadProfile("../profile")).rejects.toThrow("Invalid profile name");
    await symlink(root, join(root, "profiles", "escape"));
    await expect(loadProfile("escape/profile")).rejects.toThrow("symlinks");
  });

  test("stages opaque native fragments and produces a reproducible content digest", async () => {
    const { root, directory } = await fixture();
    const fragment = '{"agent":{"reviewer":{"description":"Native reviewer","model":"provider/model"}}}\n';
    await writeFile(join(directory, "config", "opencode.json"), fragment);
    const profile = await loadProfile("test/profile", "opencode");
    const first = await stageProfile(profile, join(root, "first"));
    const second = await stageProfile(profile, join(root, "second"));
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(await readFile(join(root, "first", "config", "opencode.json"), "utf8")).toBe(fragment);
    await writeFile(join(directory, "prompt.mdx"), "Changed prompt");
    expect(await stageProfile(profile, join(root, "third"))).not.toBe(first);
    await expect(stageProfile(profile, directory)).rejects.toThrow("outside");
    await expect(stageProfile(profile, join(root, "first"))).rejects.toThrow("not empty");
  });

  test("requires properties and preserves provenance without executing MDX", async () => {
    await fixture({ requires_properties: true });
    const profile = await loadProfile("test/profile");
    await expect(renderPrompt(profile, context)).rejects.toThrow("requires --properties");
    const rendered = await renderPrompt(profile, { ...context, inputs: [{ name: "properties", path: "/run-data/reference/properties/report.md", sha256: "b".repeat(64), source_run: "20261103-120000-1234abcd" }] });
    expect(rendered).toContain('"source_run": "20261103-120000-1234abcd"');
    expect(rendered).toContain('"fuzz_budget_seconds": 2400');
    expect(rendered).toContain("{globalThis.__profileExecuted = true}");
    expect((globalThis as Record<string, unknown>).__profileExecuted).toBeUndefined();
  });
});
