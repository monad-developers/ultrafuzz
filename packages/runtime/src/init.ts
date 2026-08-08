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
    try {
      const lexical = fs.lstatSync(filePath, { bigint: true });
      if (lexical.isSymbolicLink() || !lexical.isFile() || lexical.nlink !== 1n) {
        diagnostics.push(
          manualAgentAdapterReviewDiagnostic(
            relativePath,
            "is not a physical single-link file, so init preserved it without inspection; replace it with an ordinary file"
          )
        );
        continue;
      }
      if (lexical.size > BigInt(MAX_STOCK_AGENT_ADAPTER_BYTES)) {
        diagnostics.push(
          manualAgentAdapterReviewDiagnostic(
            relativePath,
            "is too large to inspect as a generated adapter and was preserved"
          )
        );
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
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      diagnostics.push(
        manualAgentAdapterReviewDiagnostic(relativePath, "could not be safely inspected during post-init review")
      );
    }
  }
  return diagnostics;
}

function manualAgentAdapterReviewDiagnostic(relativePath: string, reason: string): RuntimeDiagnostic {
  return {
    code: "INIT_AGENT_ADAPTER_UPDATE_REQUIRED",
    message: `${relativePath} ${reason}; verify manually that it reads process.env.ULTRAFUZZ_CONFIG_PATH and removes controller-only variables before spawning a model process`,
    severity: "warning",
    source: "runtime",
    path: relativePath
  };
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

  const descriptor = fs.openSync(filePath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
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

    publishAgentAdapterAtomically(projectRoot, filePath, descriptor, opened, Buffer.from(replacement, "utf8"));
    return true;
  } finally {
    fs.closeSync(descriptor);
  }
}

function publishAgentAdapterAtomically(
  projectRoot: string,
  filePath: string,
  originalDescriptor: number,
  original: fs.BigIntStats,
  replacement: Buffer
): void {
  const directoryPath = path.dirname(filePath);
  const directoryDescriptor = fs.openSync(
    directoryPath,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
  );
  let temporaryPath: string | undefined;
  let temporaryDescriptor: number | undefined;
  let temporaryIdentity: fs.BigIntStats | undefined;
  let published = false;
  try {
    const openedDirectory = fs.fstatSync(directoryDescriptor, { bigint: true });
    const lexicalDirectory = fs.lstatSync(directoryPath, { bigint: true });
    if (
      !openedDirectory.isDirectory() ||
      !lexicalDirectory.isDirectory() ||
      openedDirectory.dev !== lexicalDirectory.dev ||
      openedDirectory.ino !== lexicalDirectory.ino ||
      openedDirectory.dev !== original.dev
    ) {
      throw new Error("generated agent adapter directory changed before atomic publication");
    }
    const directoryAccessPath = agentAdapterDirectoryDescriptorPath(directoryDescriptor, openedDirectory);
    const targetAccessPath = path.join(directoryAccessPath, path.basename(filePath));

    const temporary = createAgentAdapterTemporaryFile(directoryAccessPath, path.basename(filePath), original.mode);
    temporaryPath = temporary.path;
    temporaryDescriptor = temporary.descriptor;
    temporaryIdentity = fs.fstatSync(temporaryDescriptor, { bigint: true });
    if (
      !temporaryIdentity.isFile() ||
      temporaryIdentity.nlink !== 1n ||
      temporaryIdentity.size !== 0n ||
      temporaryIdentity.dev !== openedDirectory.dev ||
      temporaryIdentity.uid !== original.uid ||
      temporaryIdentity.gid !== original.gid
    ) {
      throw new Error("generated agent adapter temporary publication file is not a matching regular file");
    }
    fs.fchmodSync(temporaryDescriptor, Number(original.mode & 0o7777n));
    temporaryIdentity = fs.fstatSync(temporaryDescriptor, { bigint: true });
    if (
      !temporaryIdentity.isFile() ||
      temporaryIdentity.nlink !== 1n ||
      temporaryIdentity.size !== 0n ||
      temporaryIdentity.dev !== openedDirectory.dev ||
      temporaryIdentity.mode !== original.mode ||
      temporaryIdentity.uid !== original.uid ||
      temporaryIdentity.gid !== original.gid
    ) {
      throw new Error("generated agent adapter temporary publication file is not a matching regular file");
    }

    writeNewDescriptorContents(temporaryDescriptor, replacement);
    const writtenTemporary = fs.fstatSync(temporaryDescriptor, { bigint: true });
    if (!isExpectedPublishedAgentAdapter(writtenTemporary, temporaryIdentity, original, replacement.byteLength)) {
      throw new Error("generated agent adapter temporary publication file changed while it was written");
    }

    const heldOriginal = fs.fstatSync(originalDescriptor, { bigint: true });
    const accessedOriginal = fs.lstatSync(targetAccessPath, { bigint: true });
    const lexicalOriginal = fs.lstatSync(filePath, { bigint: true });
    const lexicalTemporary = fs.lstatSync(temporaryPath, { bigint: true });
    const currentDirectory = fs.lstatSync(directoryPath, { bigint: true });
    if (
      !sameStableInitFile(original, heldOriginal) ||
      !sameStableInitFile(original, accessedOriginal) ||
      !sameStableInitFile(original, lexicalOriginal) ||
      !isExpectedPublishedAgentAdapter(lexicalTemporary, temporaryIdentity, original, replacement.byteLength) ||
      !currentDirectory.isDirectory() ||
      currentDirectory.dev !== openedDirectory.dev ||
      currentDirectory.ino !== openedDirectory.ino
    ) {
      throw new Error("generated agent adapter or its directory changed before atomic publication");
    }
    assertNoSymlinkComponents(projectRoot, directoryPath, "generated agent adapter directory");

    fs.renameSync(temporaryPath, targetAccessPath);
    published = true;
    fs.fsyncSync(directoryDescriptor);
    const publishedDirectory = fs.lstatSync(directoryPath, { bigint: true });
    if (
      !publishedDirectory.isDirectory() ||
      publishedDirectory.dev !== openedDirectory.dev ||
      publishedDirectory.ino !== openedDirectory.ino
    ) {
      throw new Error("generated agent adapter directory changed during atomic publication");
    }
    verifyPublishedAgentAdapter(targetAccessPath, filePath, temporaryIdentity, original, replacement);
  } finally {
    if (temporaryDescriptor !== undefined) fs.closeSync(temporaryDescriptor);
    if (!published && temporaryPath !== undefined && temporaryIdentity !== undefined) {
      removeOwnedAgentAdapterTemporaryFile(temporaryPath, temporaryIdentity);
    }
    fs.closeSync(directoryDescriptor);
  }
}

function agentAdapterDirectoryDescriptorPath(descriptor: number, directory: fs.BigIntStats): string {
  for (const candidate of [`/proc/self/fd/${descriptor}`, `/dev/fd/${descriptor}`]) {
    try {
      const accessed = fs.statSync(candidate, { bigint: true });
      if (accessed.isDirectory() && accessed.dev === directory.dev && accessed.ino === directory.ino) return candidate;
    } catch {
      // Continue to the next descriptor filesystem.
    }
  }
  throw new Error("generated agent adapter directory has no verifiable descriptor path");
}

function createAgentAdapterTemporaryFile(
  directoryPath: string,
  basename: string,
  mode: bigint
): { path: string; descriptor: number } {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const temporaryPath = path.join(
      directoryPath,
      `.${basename}.ultrafuzz-init-${process.pid}-${crypto.randomBytes(16).toString("hex")}`
    );
    try {
      return {
        path: temporaryPath,
        descriptor: fs.openSync(
          temporaryPath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
          Number(mode & 0o7777n)
        )
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("unable to reserve a unique generated agent adapter publication file");
}

function isExpectedPublishedAgentAdapter(
  candidate: fs.BigIntStats,
  identity: fs.BigIntStats,
  original: fs.BigIntStats,
  byteLength: number
): boolean {
  return (
    candidate.isFile() &&
    candidate.nlink === 1n &&
    candidate.dev === identity.dev &&
    candidate.ino === identity.ino &&
    candidate.mode === original.mode &&
    candidate.uid === original.uid &&
    candidate.gid === original.gid &&
    candidate.size === BigInt(byteLength)
  );
}

function verifyPublishedAgentAdapter(
  accessPath: string,
  lexicalPath: string,
  identity: fs.BigIntStats,
  original: fs.BigIntStats,
  replacement: Buffer
): void {
  const accessedBefore = fs.lstatSync(accessPath, { bigint: true });
  const lexicalBefore = fs.lstatSync(lexicalPath, { bigint: true });
  if (
    !isExpectedPublishedAgentAdapter(accessedBefore, identity, original, replacement.byteLength) ||
    !isExpectedPublishedAgentAdapter(lexicalBefore, identity, original, replacement.byteLength)
  ) {
    throw new Error("generated agent adapter publication did not retain its prepared identity");
  }
  const descriptor = fs.openSync(accessPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const contents = fs.readFileSync(descriptor);
    const completed = fs.fstatSync(descriptor, { bigint: true });
    const accessedCompleted = fs.lstatSync(accessPath, { bigint: true });
    const lexicalCompleted = fs.lstatSync(lexicalPath, { bigint: true });
    if (
      !isExpectedPublishedAgentAdapter(opened, identity, original, replacement.byteLength) ||
      !sameStableInitFile(opened, completed) ||
      !sameStableInitFile(opened, accessedCompleted) ||
      !sameStableInitFile(opened, lexicalCompleted) ||
      !contents.equals(replacement)
    ) {
      throw new Error("generated agent adapter publication failed byte and identity verification");
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function removeOwnedAgentAdapterTemporaryFile(filePath: string, identity: fs.BigIntStats): void {
  try {
    const lexical = fs.lstatSync(filePath, { bigint: true });
    if (lexical.isFile() && lexical.dev === identity.dev && lexical.ino === identity.ino) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Cleanup is best effort and never follows or removes a replacement inode.
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

function writeNewDescriptorContents(descriptor: number, contents: Buffer): void {
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
