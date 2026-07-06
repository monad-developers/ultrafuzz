import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadBuiltInPromptAssets, normalizePromptRelativePath, type BuiltInPromptAsset } from "./catalog.js";
import { PromptError } from "./frontmatter.js";

export const PROJECT_PROMPT_DIR = ".ultrafuzz/prompts";

export interface ScaffoldPromptsOptions {
  replace?: boolean;
  builtIns?: BuiltInPromptAsset[];
}

export interface ScaffoldPromptsReport {
  promptDir: string;
  written: string[];
  preserved: string[];
}

export function projectPromptDir(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_PROMPT_DIR);
}

export function scaffoldPrompts(projectRoot: string, options: ScaffoldPromptsOptions = {}): ScaffoldPromptsReport {
  const promptDir = projectPromptDir(projectRoot);
  ensureSafePromptPath(projectRoot, PROJECT_PROMPT_DIR);
  mkdirSync(promptDir, { recursive: true });
  ensureSafePromptPath(projectRoot, PROJECT_PROMPT_DIR);

  const written: string[] = [];
  const preserved: string[] = [];
  for (const asset of options.builtIns ?? loadBuiltInPromptAssets()) {
    const relativePath = normalizePromptRelativePath(asset.relativePath);
    const projectRelativePath = path.posix.join(PROJECT_PROMPT_DIR, relativePath);
    ensureSafePromptPath(projectRoot, projectRelativePath);

    const absolutePath = path.join(promptDir, ...relativePath.split("/"));
    if (!options.replace && pathExists(absolutePath)) {
      preserved.push(absolutePath);
      continue;
    }

    mkdirSync(path.dirname(absolutePath), { recursive: true });
    ensureSafePromptPath(projectRoot, projectRelativePath);
    writeFileSync(absolutePath, asset.markdown, "utf8");
    written.push(absolutePath);
  }

  return {
    promptDir,
    written: written.sort(),
    preserved: preserved.sort()
  };
}

function ensureSafePromptPath(projectRoot: string, relativePath: string): void {
  const normalized = relativePath.split(path.sep).join("/");
  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new PromptError("invalid-prompt-path", `invalid prompt scaffold path: ${relativePath}`);
  }

  let current = projectRoot;
  for (const part of normalized.split("/")) {
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new PromptError("symlink-prompt-path", `refusing to scaffold prompts through symlink: ${current}`);
      }
    } catch (error) {
      if (error instanceof PromptError) {
        throw error;
      }
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
}

function pathExists(absolutePath: string): boolean {
  try {
    lstatSync(absolutePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
