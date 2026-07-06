import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertNoSymlinkComponents } from "@ultrafuzz/artifacts";
import { redactResolvedConfig, resolveConfig, serializeRedactedResolvedConfigToml } from "@ultrafuzz/config";
import { builtInPromptRelativePaths, scaffoldPrompts } from "@ultrafuzz/prompts";
import { defaultReferenceCatalogYaml } from "@ultrafuzz/references";
import type { InitProjectInput, InitProjectResult } from "./types.js";
import { configDiagnostics, runtimeFailure, runtimeResult, toProjectRelative } from "./utils.js";

const DEFAULT_TOPOLOGY = loadDefaultTopology();

export function initProject(input: InitProjectInput) {
  const projectRoot = path.resolve(input.projectRoot);
  const created: string[] = [];
  const preserved: string[] = [];
  const overwritten: string[] = [];
  fs.mkdirSync(projectRoot, { recursive: true });
  try {
    assertNoSymlinkComponents(projectRoot, path.join(projectRoot, ".ultrafuzz"), "init root");
  } catch (error) {
    return runtimeFailure<InitProjectResult>([
      {
        code: "INIT_ROOT_UNSAFE",
        message: error instanceof Error ? error.message : String(error),
        severity: "error",
        source: "runtime",
        path: ".ultrafuzz"
      }
    ]);
  }

  for (const directory of [
    ".ultrafuzz",
    ".ultrafuzz/runs",
    ".ultrafuzz/workspaces",
    ".ultrafuzz/cache",
    ".ultrafuzz/prompts",
    ".smithers",
    ".smithers/agents",
    ".smithers/workflows"
  ]) {
    const absolute = path.join(projectRoot, directory);
    if (!fs.existsSync(absolute)) {
      fs.mkdirSync(absolute, { recursive: true });
      created.push(directory);
    }
  }

  const resolved = resolveConfig({ env: {} });
  if (!resolved.ok) {
    return runtimeFailure<InitProjectResult>(configDiagnostics(resolved.diagnostics));
  }
  const redacted = redactResolvedConfig(resolved.value);

  try {
    writeProjectFile(
      projectRoot,
      "ultrafuzz.toml",
      serializeRedactedResolvedConfigToml(redacted),
      input.force === true,
      created,
      preserved,
      overwritten
    );
    writeProjectFile(
      projectRoot,
      ".ultrafuzz/references.yml",
      defaultReferenceCatalogYaml(),
      input.force === true,
      created,
      preserved,
      overwritten
    );
    writeProjectFile(
      projectRoot,
      ".ultrafuzz/topology.yml",
      DEFAULT_TOPOLOGY,
      input.force === true,
      created,
      preserved,
      overwritten
    );
    writeProjectFile(
      projectRoot,
      ".smithers/package.json",
      renderSmithersPackageJson(),
      input.force === true,
      created,
      preserved,
      overwritten
    );
    writeProjectFile(
      projectRoot,
      ".smithers/agents/index.ts",
      renderSmithersAgentsIndex(),
      input.force === true,
      created,
      preserved,
      overwritten
    );
    writeProjectFile(
      projectRoot,
      ".smithers/agents/codex.ts",
      renderSmithersCodexAgent(),
      input.force === true,
      created,
      preserved,
      overwritten
    );
  } catch {
    return runtimeFailure<InitProjectResult>([
      {
        code: "INIT_PATH_UNSAFE",
        message: "initialization path is unsafe; remove unsafe generated files or rerun in a clean project",
        severity: "error",
        source: "runtime"
      }
    ]);
  }

  const promptFiles = builtInPromptRelativePaths().map((relativePath) =>
    path.join(projectRoot, ".ultrafuzz", "prompts", ...relativePath.split("/"))
  );
  const existedBefore = new Set(promptFiles.filter((filePath) => fs.existsSync(filePath)));
  let promptReport;
  try {
    promptReport = scaffoldPrompts(projectRoot, { replace: input.force === true });
  } catch (error) {
    return runtimeFailure<InitProjectResult>([
      {
        code: "INIT_PROMPT_PATH_UNSAFE",
        message: error instanceof Error ? error.message : String(error),
        severity: "error",
        source: "runtime",
        path: ".ultrafuzz/prompts"
      }
    ]);
  }
  for (const absolutePath of promptReport.written) {
    const relativePath = toProjectRelative(projectRoot, absolutePath);
    if (existedBefore.has(absolutePath)) {
      overwritten.push(relativePath);
    } else {
      created.push(relativePath);
    }
  }
  for (const absolutePath of promptReport.preserved) {
    preserved.push(toProjectRelative(projectRoot, absolutePath));
  }

  return runtimeResult(true, {
    project_root: projectRoot,
    created: publicInitPaths(created),
    preserved: publicInitPaths(preserved),
    overwritten: publicInitPaths(overwritten)
  });
}

function writeProjectFile(
  projectRoot: string,
  relativePath: string,
  contents: string,
  force: boolean,
  created: string[],
  preserved: string[],
  overwritten: string[]
): void {
  const filePath = path.join(projectRoot, relativePath);
  const existed = fs.existsSync(filePath);
  if (existed && !force) {
    preserved.push(relativePath);
    return;
  }
  assertNoSymlinkComponents(projectRoot, filePath, `init file ${relativePath}`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  assertNoSymlinkComponents(projectRoot, filePath, `init file ${relativePath}`);
  fs.writeFileSync(filePath, contents, "utf8");
  if (existed) {
    overwritten.push(relativePath);
  } else {
    created.push(relativePath);
  }
}

function renderSmithersPackageJson(): string {
  return `${JSON.stringify(
    {
      name: "ultrafuzz-smithers",
      private: true,
      type: "module",
      dependencies: {
        "smithers-orchestrator": "^0.26.1",
        zod: "^4.4.3"
      },
      devDependencies: {
        typescript: "^6.0.3"
      }
    },
    null,
    2
  )}\n`;
}

function renderSmithersAgentsIndex(): string {
  return 'export { CodexAgent } from "./codex";\n';
}

function renderSmithersCodexAgent(): string {
  return [
    'import { CodexAgent as SmithersCodexAgent } from "smithers-orchestrator";',
    "",
    "export const CodexAgent = new SmithersCodexAgent({",
    '  model: "gpt-5.5",',
    "  skipGitRepoCheck: true,",
    "  apiKey: process.env.OPENAI_API_KEY,",
    "});",
    ""
  ].join("\n");
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function publicInitPaths(values: string[]): string[] {
  return uniqueSorted(values).filter((value) => !value.toLowerCase().includes("smithers"));
}

function loadDefaultTopology(): string {
  return fs.readFileSync(defaultTopologyPath(), "utf8");
}

function defaultTopologyPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "topology.yml"),
    path.resolve(here, "../../../.ultrafuzz/topology.yml"),
    path.resolve(here, "../../../../.ultrafuzz/topology.yml")
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found === undefined) {
    throw new Error(`unable to locate topology.yml from ${here}`);
  }
  return found;
}
