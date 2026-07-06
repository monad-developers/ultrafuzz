import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { builtInPromptRelativePaths, loadPromptCatalog, scaffoldPrompts } from "../src/index.js";

let tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function tempProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ufz-prompts-"));
  tmpDirs.push(dir);
  return dir;
}

function markdownPromptFiles(): string[] {
  const promptRoot = fileURLToPath(new URL("../../../.ultrafuzz/prompts/", import.meta.url));
  const result: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith("_")) {
        continue;
      }
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
      } else if (entry.isFile() && /\.(md|mdx)$/i.test(entry.name)) {
        result.push(path.relative(promptRoot, absolutePath).split(path.sep).join("/"));
      }
    }
  };
  walk(promptRoot);
  return result.sort();
}

describe("prompt scaffold and catalog", () => {
  it("writes editable project prompt copies and preserves edits without replace", () => {
    const project = tempProject();
    const report = scaffoldPrompts(project);
    expect(report.written.length).toBeGreaterThan(0);

    const promptPath = path.join(project, ".ultrafuzz", "prompts", "setup", "project-discovery.md");
    writeFileSync(promptPath, "edited", "utf8");
    const second = scaffoldPrompts(project);

    expect(second.preserved).toContain(promptPath);
    expect(readFileSync(promptPath, "utf8")).toBe("edited");

    scaffoldPrompts(project, { replace: true });
    expect(readFileSync(promptPath, "utf8")).toContain("id: project-discovery");
  });

  it("loads built-in prompts and deterministic project overlays", () => {
    const project = tempProject();
    mkdirSync(path.join(project, ".ultrafuzz", "prompts", "strategies"), { recursive: true });
    writeFileSync(
      path.join(project, ".ultrafuzz", "prompts", "strategies", "boundary-tests.mdx"),
      "---\nid: boundary-tests\ndisplay_name: Local Boundary\n---\nLocal {{repo_path}}",
      "utf8"
    );

    const catalog = loadPromptCatalog({ projectRoot: project });
    const entry = catalog.entries.get("boundary-tests");

    expect(catalog.orderedIds).toEqual([...catalog.orderedIds].sort());
    expect(entry?.source).toBe("project");
    expect(entry?.displayName).toBe("Local Boundary");
    expect(entry?.body).toContain("Local");
  });

  it("discovers built-in prompt filenames from the prompt filesystem", () => {
    const discovered = builtInPromptRelativePaths();

    expect(discovered).toEqual(markdownPromptFiles());
    expect(discovered).toEqual([...discovered].sort());
    expect(discovered).toContain("setup/prepare-foundry-harness.md");
    expect(discovered).toContain("strategies/differential/differential-lane-author.md");
    expect(discovered).toContain("review/triage.md");
    expect(discovered.some((relativePath) => relativePath.startsWith("_templates/"))).toBe(false);
  });
});
