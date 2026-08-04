import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { builtInPromptRoot } from "./assets.js";
import { parsePromptFrontmatter, PromptError, type ParsedPromptDocument, titleFromId } from "./frontmatter.js";
import { validatePromptVariables } from "./render.js";

export type PromptSourceKind = "built-in" | "project";

export interface PromptCatalogEntry {
  id: string;
  displayName: string;
  relativePath: string;
  source: PromptSourceKind;
  absolutePath?: string;
  frontmatter: ParsedPromptDocument["frontmatter"];
  body: string;
  markdown: string;
}

export interface PromptCatalog {
  entries: Map<string, PromptCatalogEntry>;
  orderedIds: string[];
}

export interface BuiltInPromptAsset {
  relativePath: string;
  markdown: string;
}

export interface LoadPromptCatalogOptions {
  projectRoot?: string;
  promptDir?: string;
  builtIns?: BuiltInPromptAsset[];
  validateVariables?: boolean;
}

export function loadBuiltInPromptAssets(): BuiltInPromptAsset[] {
  const root = builtInPromptRoot();
  return discoverBuiltInPromptRelativePaths(root).map((relativePath) => ({
    relativePath,
    markdown: readFileSync(path.join(root, ...relativePath.split("/")), "utf8")
  }));
}

export function loadPromptCatalog(options: LoadPromptCatalogOptions = {}): PromptCatalog {
  const validateVariables = options.validateVariables ?? true;
  const entries = new Map<string, PromptCatalogEntry>();
  for (const asset of options.builtIns ?? loadBuiltInPromptAssets()) {
    const entry = parseCatalogEntry(asset.markdown, {
      relativePath: normalizePromptRelativePath(asset.relativePath),
      source: "built-in",
      validateVariables
    });
    if (entries.has(entry.id)) {
      throw new PromptError("duplicate-prompt-id", `duplicate built-in prompt id \`${entry.id}\``);
    }
    entries.set(entry.id, entry);
  }

  const projectPromptDir =
    options.promptDir ?? (options.projectRoot ? path.join(options.projectRoot, ".ultrafuzz", "prompts") : undefined);
  if (projectPromptDir) {
    for (const absolutePath of discoverPromptFiles(projectPromptDir)) {
      const relativePath = normalizePromptRelativePath(path.relative(projectPromptDir, absolutePath));
      const markdown = readFileSync(absolutePath, "utf8");
      const entry = parseCatalogEntry(markdown, {
        relativePath,
        source: "project",
        absolutePath,
        validateVariables
      });
      if (entry.source === "project") {
        const previousProjectEntry = entries.get(entry.id);
        if (previousProjectEntry?.source === "project") {
          throw new PromptError(
            "duplicate-prompt-id",
            `duplicate project prompt id \`${entry.id}\` at ${entry.relativePath}`
          );
        }
      }
      entries.set(entry.id, entry);
    }
  }

  return {
    entries,
    orderedIds: Array.from(entries.keys()).sort()
  };
}

export function getPrompt(catalog: PromptCatalog, id: string): PromptCatalogEntry {
  const entry = catalog.entries.get(id);
  if (!entry) {
    throw new PromptError("missing-template-variable", `prompt id \`${id}\` was not found`);
  }
  return entry;
}

export function builtInPromptRelativePaths(): string[] {
  return discoverBuiltInPromptRelativePaths(builtInPromptRoot());
}

function discoverBuiltInPromptRelativePaths(root: string): string[] {
  return discoverPromptFiles(root)
    .map((absolutePath) => normalizePromptRelativePath(path.relative(root, absolutePath)))
    .sort();
}

function parseCatalogEntry(
  markdown: string,
  options: {
    relativePath: string;
    source: PromptSourceKind;
    absolutePath?: string;
    validateVariables: boolean;
  }
): PromptCatalogEntry {
  const document = parsePromptFrontmatter(markdown);
  if (options.validateVariables) {
    validatePromptVariables(document.body);
  }
  const fallbackId = path.basename(options.relativePath).replace(/\.(md|mdx)$/i, "");
  const id = document.frontmatter.id ?? fallbackId;
  return {
    id,
    displayName: document.frontmatter.display_name ?? titleFromId(id),
    relativePath: options.relativePath,
    source: options.source,
    ...(options.absolutePath ? { absolutePath: options.absolutePath } : {}),
    frontmatter: document.frontmatter,
    body: document.body,
    markdown
  };
}

function discoverPromptFiles(dir: string): string[] {
  try {
    if (!statSync(dir).isDirectory()) {
      return [];
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

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
        result.push(absolutePath);
      }
    }
  };
  walk(dir);
  return result.sort();
}

export function normalizePromptRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").split(path.sep).join("/");
  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..") ||
    !/\.(md|mdx)$/i.test(normalized)
  ) {
    throw new PromptError("invalid-prompt-path", `invalid prompt path: ${relativePath}`);
  }
  return normalized;
}
