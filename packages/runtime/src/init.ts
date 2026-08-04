import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertNoSymlinkComponents } from "@ultrafuzz/artifacts";
import { redactResolvedConfig, resolveConfig, serializeRedactedResolvedConfigToml } from "@ultrafuzz/config";
import { builtInPromptRelativePaths, scaffoldPrompts } from "@ultrafuzz/prompts";
import { defaultReferenceCatalogYaml } from "@ultrafuzz/references";
import { loadRuntimeTemplate } from "./runtime-template.js";
import { renderSmithersPackageJson } from "./smithers-package.js";
import type { InitProjectInput, InitProjectResult, RuntimeDiagnostic } from "./types.js";
import { configDiagnostics, runtimeFailure, runtimeResult, toProjectRelative } from "./utils.js";

const DEFAULT_TOPOLOGY = loadDefaultTopology();

const AGENT_REGISTRY_FILE = ".smithers/agents/index.ts";
const AGENT_TEMPLATES = [
  { file: "claude.ts", template: "smithers/agents/claude.tsx", ref: "ClaudeAgent" },
  { file: "codex.ts", template: "smithers/agents/codex.tsx", ref: "CodexAgent" },
  { file: "deepseek.ts", template: "smithers/agents/deepseek.tsx", ref: "DeepSeekAgent" },
  { file: "kimi.ts", template: "smithers/agents/kimi.tsx", ref: "KimiAgent" }
] as const;

// Ordinary init may upgrade only bytes Ultrafuzz itself previously wrote.
// These SHA-256 values were derived from every distinct canonical scaffold
// shipped by v0.0.2-v0.0.12, plus origin/main at 991ff2d. Keeping the exact
// byte digests here lets old projects gain current agent hardening without
// treating a syntactically similar customized adapter as generated output.
const LEGACY_GENERATED_SCAFFOLD_SHA256: Readonly<Record<string, readonly string[]>> = {
  ".smithers/agents/claude.ts": [
    // v0.0.6
    "6774e116b8efa175a20a53f8a645c7c9046f266bba974d0e4fab01c5d072c28b",
    // v0.0.7-v0.0.12 and 991ff2d
    "2cc5a7a75e23c40d3da5e80438a916e6f3671e794ef6023115d78c94fa03d210"
  ],
  ".smithers/agents/codex.ts": [
    // v0.0.2
    "26dae14e43c09dbe7901aa731cd552b282d502d86cea8cc6726e4a8579cd3236",
    // v0.0.3
    "f6497ac57506ec1af4c426711197d43fbbe6d5b5122eef9e8c6e438a6bd65c8e",
    // v0.0.4
    "b2469baaaf5a0818dff321017200feef78e1e285c3f9adb96dcb7c958e5e835c",
    // v0.0.5
    "bce18463addcd722bde69f3d1f46a0d98c7417e8b0fbc1dd64eaa81acc934019",
    // v0.0.6
    "a80cc6ec499f983bbc3edae6d2c89682ce8ca7caa9546c6d79f1e80214e3360e",
    // v0.0.7-v0.0.8
    "84834b0d2dc0ac69bc7e76b1ac98b4ce7fba436a07c131920c4697a576014632",
    // v0.0.9-v0.0.12 and 991ff2d
    "4bfb080f3a20d758dec358cabd47a0ce7d1d4a6b6b55905c856e0911ae8590dc"
  ],
  ".smithers/agents/deepseek.ts": [
    // v0.0.12 and 991ff2d
    "c23a03c84e2f62d2e6b23ee7b27b1464a633fe20bb5b91c34d2c93d37dcf7e35"
  ],
  ".smithers/agents/kimi.ts": [
    // v0.0.10-v0.0.11
    "6de5f4b00b54b533f8fc1aa0628f5a402dbb6521a4584852d83786ee59dcb2fd",
    // v0.0.12 and 991ff2d
    "25c499f8631db6e2529b046b5d2243119b456696c7a4a729345baa6f21f4c4f5"
  ],
  ".smithers/agents/index.ts": [
    // v0.0.2-v0.0.4
    "aceef4910ab0cf97b70dd448ee1a4cee7f9b5d35df4e0171a8a9269e95582f21",
    // v0.0.5
    "fc43529456b4f4ab3ab351d3a433a3eab7e187309a823dd49454ffc319e089e3",
    // v0.0.6-v0.0.9
    "c8402121edc959b629eac0d9bf5c5e4bfe110c92cebb1b0a51022c3bb27d77a2",
    // v0.0.10-v0.0.11 (the last pre-DeepSeek registry)
    "58a1c796bef8466ec77c04a01fcb60bb1e91b55d437f0c69499f054db6305535",
    // v0.0.12 and 991ff2d; also the current registry bytes
    "0a55f99374f994b6bac600cf1868eb641a18d36bdba0bd7a18e062957d7b4ab5"
  ]
};

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
      loadRuntimeTemplate("smithers/agents/index.tsx"),
      input.force === true,
      created,
      preserved,
      overwritten
    );
    writeProjectFile(
      projectRoot,
      ".smithers/agents/toml.ts",
      loadRuntimeTemplate("smithers/agents/toml.tsx"),
      input.force === true,
      created,
      preserved,
      overwritten
    );
    writeProjectFile(
      projectRoot,
      ".smithers/agents/environment.ts",
      loadRuntimeTemplate("smithers/agents/environment.tsx"),
      input.force === true,
      created,
      preserved,
      overwritten
    );
    for (const agent of AGENT_TEMPLATES) {
      writeProjectFile(
        projectRoot,
        `.smithers/agents/${agent.file}`,
        loadRuntimeTemplate(agent.template),
        input.force === true,
        created,
        preserved,
        overwritten
      );
    }
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

  return runtimeResult(
    true,
    {
      project_root: projectRoot,
      created: publicInitPaths(created),
      preserved: publicInitPaths(preserved),
      overwritten: publicInitPaths(overwritten)
    },
    [...staleAgentRegistryDiagnostics(projectRoot), ...staleAgentConfigPathDiagnostics(projectRoot)]
  );
}

// Exact canonical generated registries migrate above, but init still preserves
// every customized registry. Report a preserved stale registry here instead of
// leaving the mismatch silent until launch.
function staleAgentRegistryDiagnostics(projectRoot: string): RuntimeDiagnostic[] {
  const registryPath = path.join(projectRoot, AGENT_REGISTRY_FILE);
  if (!fs.existsSync(registryPath)) {
    return [];
  }
  const registryText = fs.readFileSync(registryPath, "utf8");
  return AGENT_TEMPLATES.filter(
    (agent) =>
      fs.existsSync(path.join(projectRoot, ".smithers", "agents", agent.file)) &&
      !registersAgentFactory(registryText, agent.ref)
  ).map((agent) => ({
    code: "INIT_AGENT_REGISTRY_STALE",
    message: `${AGENT_REGISTRY_FILE} does not register ${agent.ref} in agentFactories, so runs cannot select it; rerun ultrafuzz init --force to regenerate the registry, or add the entry by hand`,
    severity: "warning" as const,
    source: "runtime",
    path: AGENT_REGISTRY_FILE
  }));
}

function staleAgentConfigPathDiagnostics(projectRoot: string): RuntimeDiagnostic[] {
  return AGENT_TEMPLATES.flatMap((agent): RuntimeDiagnostic[] => {
    const relativePath = `.smithers/agents/${agent.file}`;
    const agentText = readSingleLinkProjectFile(projectRoot, relativePath);
    if (
      agentText === undefined ||
      agentText.includes("ULTRAFUZZ_CONFIG_PATH") ||
      !/["'`]ultrafuzz\.toml["'`]/u.test(agentText)
    ) {
      return [];
    }
    return [
      {
        code: "INIT_AGENT_CONFIG_PATH_STALE",
        message: `${relativePath} reads a literal ultrafuzz.toml path without ULTRAFUZZ_CONFIG_PATH, so linked or cloud execution may read the wrong configuration; rerun ultrafuzz init --force to regenerate the adapter, or update it to prefer process.env.ULTRAFUZZ_CONFIG_PATH`,
        severity: "warning",
        source: "runtime",
        path: relativePath
      }
    ];
  });
}

function readSingleLinkProjectFile(projectRoot: string, relativePath: string): string | undefined {
  const filePath = path.join(projectRoot, relativePath);
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      return undefined;
    }
    assertNoSymlinkComponents(projectRoot, filePath, `init file ${relativePath}`);
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

// Generated adapters export only their factory, so agentFactories is the sole
// path that resolves them. Merely naming the agent elsewhere in the registry --
// an `export { ClaudeAgent }` left over from an older adapter, say -- does not
// make it selectable, so match the factory entry rather than the bare name.
function registersAgentFactory(registryText: string, ref: string): boolean {
  const factories = /agentFactories\s*=\s*\{([^}]*)\}/u.exec(registryText);
  return factories === null ? false : new RegExp(`\\b${ref}\\s*:`, "u").test(factories[1] ?? "");
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
  const migrateGeneratedScaffold =
    existed && !force && generatedScaffoldNeedsMigration(projectRoot, filePath, relativePath, contents);
  if (existed && !force && !migrateGeneratedScaffold) {
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

function generatedScaffoldNeedsMigration(
  projectRoot: string,
  filePath: string,
  relativePath: string,
  currentContents: string
): boolean {
  const legacyDigests = LEGACY_GENERATED_SCAFFOLD_SHA256[relativePath];
  if (legacyDigests === undefined) {
    return false;
  }
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    return false;
  }
  assertNoSymlinkComponents(projectRoot, filePath, `init file ${relativePath}`);
  const existing = fs.readFileSync(filePath);
  if (existing.equals(Buffer.from(currentContents, "utf8"))) {
    return false;
  }
  const digest = createHash("sha256").update(existing).digest("hex");
  return legacyDigests.includes(digest);
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
