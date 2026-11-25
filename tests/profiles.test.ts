import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledProfilesDirectory, listProfiles, loadProfile, renderPrompt, stageProfile, type PromptContext } from "../src/profiles";
import { HARNESSES } from "../src/types";

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
  test("bundled catalog exposes available profiles, with Pareto v2 for OpenCode only", async () => {
    process.env.ULTRAFUZZ_PROFILE_DIR = bundledProfilesDirectory;
    const profiles = await listProfiles();
    expect(profiles.map(profile => profile.name).sort()).toEqual(["v2/pareto", "v2/property-specification-collaborative", "v2/stateful-fuzzing"]);
    expect((await loadProfile("v2/pareto", "opencode")).harnesses).toEqual(["opencode"]);
    await expect(loadProfile("v2/pareto", "codex")).rejects.toThrow("does not support");
    expect((await loadProfile("v2/property-specification-collaborative", "codex")).requires_properties).toBe(false);
    expect((await loadProfile("v2/stateful-fuzzing", "claude-code")).requires_properties).toBe(true);
    // The single-prompt profile was replaced, not kept beside the collaborative one.
    await expect(loadProfile("v2/property-specification")).rejects.toThrow();
  });

  test("collaborative property specification stages every lens, the fan-in and a plain shared log for each listed harness", async () => {
    process.env.ULTRAFUZZ_PROFILE_DIR = bundledProfilesDirectory;
    const name = "v2/property-specification-collaborative", skill = "property-specification-collaborative";
    // Lens prompt file -> catalog prefix; the lens ID is property-specification-<prefix>.
    const lenses: Record<string, string> = { "0kn0t-lens.md": "0kn0t", "aviggiano-lens.md": "aviggiano", "certora-thinking-lens.md": "certora", "josselin-feist-lens.md": "josselin-feist",
      "property-specification-a16z.md": "a16z", "property-specification-crytic.md": "crytic", "property-specification-runtime-verification.md": "runtime-verification", "recon-lens.md": "recon" };
    const fanin = "property-specification-fanin.md";
    const listed = (await loadProfile(name)).harnesses;
    expect([...listed].sort()).toEqual(["claude-code", "codex", "opencode"]);
    const root = await mkdtemp(join(tmpdir(), "ultrafuzz-collaborative-"));
    directories.push(root);
    const digests = new Set<string>();
    for (const harness of HARNESSES) {
      if (!listed.includes(harness)) { await expect(loadProfile(name, harness)).rejects.toThrow("does not support"); continue; }
      const profile = await loadProfile(name, harness), staged = join(root, harness);
      digests.add(await stageProfile(profile, staged));
      const prompts = join(staged, "skills", skill, "prompts");
      expect((await readdir(prompts)).sort()).toEqual([...Object.keys(lenses), fanin].sort());
      const paths = (await readdir(staged, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name));
      const text = new Map(await Promise.all(paths.map(async path => [path.slice(staged.length + 1), await readFile(path, "utf8")] as const)));
      // v0.2 renders nothing: a leftover v0.1 variable would reach the agent as literal text.
      for (const [path, content] of text) expect([path, /\{\{|\$\{/.test(content)]).toEqual([path, false]);
      // The report is the only deliverable: no property schema or second catalog ships with the profile.
      expect([...text.keys()].filter(path => /(^|\/)properties\.(md|json)$|\.schema\.json$/.test(path))).toEqual([]);
      // Claude Code must keep lens subagents in the foreground, or the lead session can end before they finish.
      expect(JSON.parse(text.get("config/claude-code.env.json")!)).toEqual({ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" });
      const manual = text.get(`skills/${skill}/SKILL.md`)!, references = text.get(`skills/${skill}/references.md`)!;
      expect(manual).toMatch(new RegExp(`^---\\nname: ${skill}\\n`));
      for (const [file, prefix] of Object.entries(lenses)) {
        const lens = text.get(`skills/${skill}/prompts/${file}`)!;
        expect(lens).toContain(`id: property-specification-${prefix}\n`);
        expect(lens).toContain(`<output_directory>/collaborative/properties/${prefix}.md`);
        expect(lens).toContain("<output_directory>/collaborative/shared-log.md");
        expect(lens).toContain(`## property-specification-${prefix} at `);
        expect(lens).toContain("## Final reply");
        const cited = lens.match(/`reference-properties-[a-z0-9-]+`/g) ?? [];
        expect(cited.length).toBeGreaterThan(0);
        for (const reference of cited) expect(references).toContain(`| ${reference} | \`property-specification-${prefix}\` |`);
        expect(manual).toContain(`| \`property-specification-${prefix}\` | \`prompts/${file}\` | \`properties/${prefix}.md\` |`);
      }
      const merge = text.get(`skills/${skill}/prompts/${fanin}`)!;
      expect(merge).toContain("<output_directory>/collaborative/report-draft.md");
      expect(merge).toContain("P-001");
      expect(merge).toContain("Do not write `report.md`");
      expect(manual).toContain(`prompts/${fanin}`);
      const rendered = await renderPrompt(profile, context);
      expect(rendered).toContain('"skill_directory": "/run-data/profile/skills"');
      expect(rendered).toContain(`${skill}/SKILL.md`);
      expect(rendered).toContain("collaborative/shared-log.md");
      expect(rendered).toContain("Do not write `report.md` before the fan-in");
      expect(rendered).not.toMatch(/\{\{|\$\{/);
    }
    // Staging is harness-independent: one digest identifies the profile.
    expect(digests.size).toBe(1);
  });

  test("refuses a profile that is marked unavailable", async () => {
    await fixture({ available: false });
    await expect(loadProfile("test/profile", "opencode")).rejects.toThrow("unavailable");
    await expect(loadProfile("test/missing", "opencode")).rejects.toThrow("Unknown profile test/missing");
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
