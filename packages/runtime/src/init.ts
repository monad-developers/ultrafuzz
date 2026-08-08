import crypto from "node:crypto";
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
const MAX_STOCK_AGENT_ADAPTER_BYTES = 256 * 1024;
const AGENT_TEMPLATES = [
  {
    file: "claude.ts",
    template: "smithers/agents/claude.tsx",
    ref: "ClaudeAgent",
    stockSha256: new Set([
      "efee33db0341d979a412c2f66559700af4462241667a3f9587af857218b341c4",
      "6774e116b8efa175a20a53f8a645c7c9046f266bba974d0e4fab01c5d072c28b",
      "2cc5a7a75e23c40d3da5e80438a916e6f3671e794ef6023115d78c94fa03d210"
    ])
  },
  {
    file: "codex.ts",
    template: "smithers/agents/codex.tsx",
    ref: "CodexAgent",
    stockSha256: new Set([
      "26dae14e43c09dbe7901aa731cd552b282d502d86cea8cc6726e4a8579cd3236",
      "f6497ac57506ec1af4c426711197d43fbbe6d5b5122eef9e8c6e438a6bd65c8e",
      "b2469baaaf5a0818dff321017200feef78e1e285c3f9adb96dcb7c958e5e835c",
      "bce18463addcd722bde69f3d1f46a0d98c7417e8b0fbc1dd64eaa81acc934019",
      "a80cc6ec499f983bbc3edae6d2c89682ce8ca7caa9546c6d79f1e80214e3360e",
      "84834b0d2dc0ac69bc7e76b1ac98b4ce7fba436a07c131920c4697a576014632",
      "4bfb080f3a20d758dec358cabd47a0ce7d1d4a6b6b55905c856e0911ae8590dc",
      "8b5c2db5a98f641a77a0c19b50fd94c7edf3dbebedb2de2126f98b878c74c55a",
      "e892c6384591a3324065016ab42d861daa521718183d091206a9032d484c8f6b"
    ])
  },
  {
    file: "deepseek.ts",
    template: "smithers/agents/deepseek.tsx",
    ref: "DeepSeekAgent",
    stockSha256: new Set(["c23a03c84e2f62d2e6b23ee7b27b1464a633fe20bb5b91c34d2c93d37dcf7e35"])
  },
  {
    file: "kimi.ts",
    template: "smithers/agents/kimi.tsx",
    ref: "KimiAgent",
    stockSha256: new Set([
      "fdbeaad6ea55122da50e9c9d86ac58a8b6377f419f8e78df23fb1fb401924e0b",
      "6de5f4b00b54b533f8fc1aa0628f5a402dbb6521a4584852d83786ee59dcb2fd",
      "25c499f8631db6e2529b046b5d2243119b456696c7a4a729345baa6f21f4c4f5",
      "f790a3f121da84049032cfc5bf5d300f7bd56e9e3b15d0a51df5ea1b275de75f"
    ])
  }
] as const;

export function initProject(input: InitProjectInput) {
  const projectRoot = path.resolve(input.projectRoot);
  const created: string[] = [];
  const preserved: string[] = [];
  const overwritten: string[] = [];
  const upgradedStockAdapters: string[] = [];
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
      const relativePath = `.smithers/agents/${agent.file}`;
      const upgraded = writeProjectFile(
        projectRoot,
        relativePath,
        loadRuntimeTemplate(agent.template),
        input.force === true,
        created,
        preserved,
        overwritten,
        agent.stockSha256
      );
      if (upgraded) upgradedStockAdapters.push(relativePath);
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
    [
      ...upgradedStockAdapterDiagnostics(upgradedStockAdapters),
      ...staleAgentRegistryDiagnostics(projectRoot),
      ...staleAgentAdapterDiagnostics(projectRoot)
    ]
  );
}

function upgradedStockAdapterDiagnostics(relativePaths: readonly string[]): RuntimeDiagnostic[] {
  return relativePaths.map((relativePath) => ({
    code: "INIT_STOCK_AGENT_ADAPTER_UPGRADED",
    message:
      "a byte-identical stock agent adapter was upgraded to use sealed workflow configuration and to withhold controller-only capabilities from model subprocesses; customized adapters are never upgraded automatically",
    severity: "info" as const,
    source: "runtime",
    path: relativePath
  }));
}

function staleAgentAdapterDiagnostics(projectRoot: string): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  for (const agent of AGENT_TEMPLATES) {
    const relativePath = `.smithers/agents/${agent.file}`;
    const filePath = path.join(projectRoot, relativePath);
    let lexical: fs.BigIntStats;
    try {
      lexical = fs.lstatSync(filePath, { bigint: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
    if (lexical.isSymbolicLink() || !lexical.isFile() || lexical.nlink !== 1n) {
      diagnostics.push({
        code: "INIT_AGENT_ADAPTER_UPDATE_REQUIRED",
        message: `${relativePath} is not a physical single-link file, so init preserved it without inspection; replace it with an ordinary file or verify manually that it reads process.env.ULTRAFUZZ_CONFIG_PATH and removes controller-only variables before spawning a model process`,
        severity: "warning",
        source: "runtime",
        path: relativePath
      });
      continue;
    }
    if (lexical.size > BigInt(MAX_STOCK_AGENT_ADAPTER_BYTES)) {
      diagnostics.push({
        code: "INIT_AGENT_ADAPTER_UPDATE_REQUIRED",
        message: `${relativePath} is too large to inspect as a generated adapter and was preserved; verify manually that it reads process.env.ULTRAFUZZ_CONFIG_PATH and removes controller-only variables before spawning a model process`,
        severity: "warning",
        source: "runtime",
        path: relativePath
      });
      continue;
    }
    const source = readStableAgentAdapter(projectRoot, filePath).toString("utf8");
    if (source.includes("ultrafuzz.toml") && !source.includes("ULTRAFUZZ_CONFIG_PATH")) {
      diagnostics.push({
        code: "INIT_AGENT_ADAPTER_UPDATE_REQUIRED",
        message: `${relativePath} was preserved because it is customized and still reads mutable project ultrafuzz.toml; update it to read process.env.ULTRAFUZZ_CONFIG_PATH and use workflowControlChildEnvironment before spawning a model process`,
        severity: "warning",
        source: "runtime",
        path: relativePath
      });
    }
  }
  return diagnostics;
}

// init preserves project-owned files, so a project scaffolded before an agent
// was added keeps its old registry: the new adapter lands on disk but nothing
// exports it, and the agent is only rejected later, at launch. Report it here
// instead of leaving the mismatch silent.
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
  overwritten: string[],
  knownStockSha256?: ReadonlySet<string>
): boolean {
  const filePath = path.join(projectRoot, relativePath);
  const existed = fs.existsSync(filePath);
  if (existed && !force) {
    if (
      knownStockSha256 !== undefined &&
      replaceKnownStockAgentAdapter(projectRoot, filePath, contents, knownStockSha256)
    ) {
      overwritten.push(relativePath);
      return true;
    }
    preserved.push(relativePath);
    return false;
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
  return false;
}

function replaceKnownStockAgentAdapter(
  projectRoot: string,
  filePath: string,
  replacement: string,
  knownStockSha256: ReadonlySet<string>
): boolean {
  assertNoSymlinkComponents(projectRoot, path.dirname(filePath), "generated agent adapter directory");
  const lexicalBefore = fs.lstatSync(filePath, { bigint: true });
  if (
    lexicalBefore.isSymbolicLink() ||
    !lexicalBefore.isFile() ||
    lexicalBefore.nlink !== 1n ||
    lexicalBefore.size > BigInt(MAX_STOCK_AGENT_ADAPTER_BYTES)
  ) {
    return false;
  }

  const descriptor = fs.openSync(filePath, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameStableInitFile(opened, lexicalBefore)) {
      throw new Error("generated agent adapter changed while it was opened");
    }
    const original = fs.readFileSync(descriptor);
    const readCompleted = fs.fstatSync(descriptor, { bigint: true });
    const lexicalCompleted = fs.lstatSync(filePath, { bigint: true });
    if (
      original.byteLength !== Number(opened.size) ||
      !sameStableInitFile(opened, readCompleted) ||
      !sameStableInitFile(opened, lexicalCompleted)
    ) {
      throw new Error("generated agent adapter changed while it was read");
    }
    const digest = crypto.createHash("sha256").update(original).digest("hex");
    if (!knownStockSha256.has(digest)) return false;

    const replacementBytes = Buffer.from(replacement, "utf8");
    try {
      writeDescriptorContents(descriptor, replacementBytes);
    } catch (error) {
      try {
        writeDescriptorContents(descriptor, original);
      } catch {
        // Preserve the replacement failure after attempting to restore the known stock bytes.
      }
      throw error;
    }
    const replaced = fs.fstatSync(descriptor, { bigint: true });
    const lexicalReplaced = fs.lstatSync(filePath, { bigint: true });
    if (
      !replaced.isFile() ||
      replaced.nlink !== 1n ||
      replaced.dev !== opened.dev ||
      replaced.ino !== opened.ino ||
      replaced.mode !== opened.mode ||
      replaced.size !== BigInt(replacementBytes.byteLength) ||
      replaced.dev !== lexicalReplaced.dev ||
      replaced.ino !== lexicalReplaced.ino ||
      replaced.mode !== lexicalReplaced.mode ||
      replaced.nlink !== lexicalReplaced.nlink ||
      replaced.size !== lexicalReplaced.size
    ) {
      throw new Error("generated agent adapter changed while it was upgraded");
    }
    return true;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readStableAgentAdapter(projectRoot: string, filePath: string): Buffer {
  assertNoSymlinkComponents(projectRoot, path.dirname(filePath), "generated agent adapter directory");
  const lexicalBefore = fs.lstatSync(filePath, { bigint: true });
  if (
    lexicalBefore.isSymbolicLink() ||
    !lexicalBefore.isFile() ||
    lexicalBefore.nlink !== 1n ||
    lexicalBefore.size > BigInt(MAX_STOCK_AGENT_ADAPTER_BYTES)
  ) {
    throw new Error("generated agent adapter is not a bounded physical single-link file");
  }
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const contents = fs.readFileSync(descriptor);
    const completed = fs.fstatSync(descriptor, { bigint: true });
    const lexicalCompleted = fs.lstatSync(filePath, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      contents.byteLength !== Number(opened.size) ||
      !sameStableInitFile(opened, lexicalBefore) ||
      !sameStableInitFile(opened, completed) ||
      !sameStableInitFile(opened, lexicalCompleted)
    ) {
      throw new Error("generated agent adapter changed while it was inspected");
    }
    return contents;
  } finally {
    fs.closeSync(descriptor);
  }
}

function sameStableInitFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function writeDescriptorContents(descriptor: number, contents: Buffer): void {
  fs.ftruncateSync(descriptor, 0);
  let offset = 0;
  while (offset < contents.byteLength) {
    const written = fs.writeSync(descriptor, contents, offset, contents.byteLength - offset, offset);
    if (written === 0) throw new Error("generated agent adapter stopped accepting replacement bytes");
    offset += written;
  }
  fs.fsyncSync(descriptor);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
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
