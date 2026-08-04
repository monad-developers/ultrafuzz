import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

function packagedRenderInput(tmp: string) {
  const artifactDir = path.join(tmp, "artifacts", "packaged-prompt");
  return {
    prompt: "Repository {{repo_path}}",
    graph: {
      logicalNodes: [
        {
          id: "packaged-prompt",
          artifactDir,
          outputs: [
            {
              path: "result.md",
              contract: "ultrafuzz/nonempty-markdown@1",
              primary: true,
              description: "A non-empty Markdown document."
            }
          ]
        }
      ]
    },
    node: {
      logicalId: "packaged-prompt",
      concreteId: "packaged-prompt",
      artifactDir,
      workspacePath: path.join(tmp, "workspace"),
      repoPath: path.join(tmp, "repo")
    },
    run: {
      id: "packaged-prompt-test",
      artifactsDir: path.join(tmp, "artifacts"),
      metadataPath: path.join(tmp, "run.json")
    },
    outputs: {
      findingsPath: path.join(artifactDir, "findings.json"),
      patchPath: path.join(artifactDir, "patch.diff")
    }
  };
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

  it("packs the canonical prompt tree and scaffolds every prompt from the extracted package", async () => {
    const packageRoot = fileURLToPath(new URL("../", import.meta.url));
    const packRoot = mkdtempSync(path.join(packageRoot, ".pack-test-"));
    tmpDirs.push(packRoot);
    execFileSync("pnpm", ["pack", "--pack-destination", packRoot], {
      cwd: packageRoot,
      stdio: "pipe"
    });
    const tarball = readdirSync(packRoot)
      .filter((entry) => entry.endsWith(".tgz"))
      .map((entry) => path.join(packRoot, entry));
    expect(tarball).toHaveLength(1);
    const extractedRoot = path.join(packRoot, "extracted");
    mkdirSync(extractedRoot, { recursive: true });
    execFileSync("tar", ["-xzf", tarball[0]!, "-C", extractedRoot], { stdio: "pipe" });

    const installedEntry = path.join(extractedRoot, "package", "dist", "index.js");
    expect(
      readFileSync(
        path.join(
          extractedRoot,
          "package",
          "dist",
          "assets",
          "prompts",
          "_templates",
          "output-contract",
          "output-contract.mdx"
        ),
        "utf8"
      )
    ).toContain("{{artifact_contracts}}");
    const installed = (await import(`${pathToFileURL(installedEntry).href}?test=${Date.now()}`)) as {
      builtInPromptRelativePaths(): string[];
      loadPromptCatalog(options?: { validateVariables?: boolean }): { orderedIds: string[] };
      renderPrompt(input: ReturnType<typeof packagedRenderInput>): { renderedMarkdown: string };
      scaffoldPrompts(projectRoot: string): { written: string[] };
    };
    const expectedPaths = markdownPromptFiles();
    expect(installed.builtInPromptRelativePaths()).toEqual(expectedPaths);

    // Dynamic item variables are validated against their topology context by
    // the runtime; this packaging test isolates discovery and frontmatter.
    const catalog = installed.loadPromptCatalog({ validateVariables: false });
    expect(catalog.orderedIds).toEqual(
      expect.arrayContaining(["threat-model", "goal-plan", "goal-hunter", "roaming-goal"])
    );
    expect(installed.renderPrompt(packagedRenderInput(tempProject())).renderedMarkdown).toContain(
      "## Ultrafuzz Output Contract"
    );

    const project = tempProject();
    const report = installed.scaffoldPrompts(project);
    const scaffoldedPaths = report.written
      .map((absolutePath) =>
        path
          .relative(path.join(project, ".ultrafuzz", "prompts"), absolutePath)
          .split(path.sep)
          .join("/")
      )
      .sort();
    expect(scaffoldedPaths).toEqual(expectedPaths);
  }, 30_000);
});
