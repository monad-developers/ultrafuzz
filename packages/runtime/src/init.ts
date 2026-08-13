import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { assertNoSymlinkComponents, parseStrictJsonBytes } from "@ultrafuzz/artifacts";
import {
  packagedTopology,
  redactResolvedConfig,
  resolveConfig,
  serializeRedactedResolvedConfigToml
} from "@ultrafuzz/config";
import { builtInPromptRelativePaths, scaffoldPrompts } from "@ultrafuzz/prompts";
import { defaultReferenceCatalogYaml } from "@ultrafuzz/references";
import { AGENT_REGISTRY_RELATIVE_PATH, agentRegistryRegisters, inspectAgentRegistry } from "./agent-registry.js";
import { loadRuntimeTemplate } from "./runtime-template.js";
import { migrateStockSmithers032PackageManifest, renderSmithersPackageJson } from "./smithers-package.js";
import type { InitProjectInput, InitProjectResult, RuntimeDiagnostic } from "./types.js";
import { configDiagnostics, runtimeFailure, runtimeResult, toProjectRelative } from "./utils.js";

const DEFAULT_TOPOLOGY = fs.readFileSync(packagedTopology("full").path, "utf8");

const MAX_AGENT_ADAPTER_REVIEW_BYTES = 256 * 1024;
const AGENT_TEMPLATES = [
  {
    file: "claude.ts",
    template: "smithers/agents/claude.tsx",
    ref: "ClaudeAgent",
    stock032Sha256: "f2b97c9b57aa45bdc3b42be20d7a3baddc0086a2bae95c161b841599f3262232"
  },
  {
    file: "codex.ts",
    template: "smithers/agents/codex.tsx",
    ref: "CodexAgent",
    stock032Sha256: "b932fb7da3c05fdc662f60359e8a751aaabd236ca4072dfeaade1a7bb25a01b5"
  },
  {
    file: "deepseek.ts",
    template: "smithers/agents/deepseek.tsx",
    ref: "DeepSeekAgent",
    stock032Sha256: "1da0e8300e1b9f5c8311c14414acd3029b750fe70644c9d364c598ea460a08f2"
  },
  {
    file: "kimi.ts",
    template: "smithers/agents/kimi.tsx",
    ref: "KimiAgent",
    stock032Sha256: "8e9c9fee048d2ac7a04669d8999647ba460c27855959bb77cd2b7eb0ea1ac940"
  }
] as const;

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
    const stockSmithersPackageMigration =
      input.force === true ? undefined : prepareStockSmithers032PackageMigration(projectRoot);
    const upgradedStockAdapters =
      stockSmithersPackageMigration === undefined
        ? new Set<string>()
        : upgradeStockSmithers032Adapters(projectRoot, created, preserved, overwritten);
    writeProjectFile(
      projectRoot,
      "ultrafuzz.toml",
      serializeRedactedResolvedConfigToml(redacted, { omitAuditProfileManagedSettings: true }),
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
      stockSmithersPackageMigration ?? renderSmithersPackageJson(),
      input.force === true || stockSmithersPackageMigration !== undefined,
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
    writeProjectFile(
      projectRoot,
      ".smithers/agents/strict-json.ts",
      loadRuntimeTemplate("smithers/agents/strict-json.tsx"),
      input.force === true,
      created,
      preserved,
      overwritten
    );
    for (const agent of AGENT_TEMPLATES) {
      const relativePath = `.smithers/agents/${agent.file}`;
      if (upgradedStockAdapters.has(relativePath)) continue;
      writeProjectFile(
        projectRoot,
        relativePath,
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
    [...staleAgentRegistryDiagnostics(projectRoot), ...staleAgentAdapterDiagnostics(projectRoot)]
  );
}

function prepareStockSmithers032PackageMigration(projectRoot: string): string | undefined {
  const manifestPath = path.join(projectRoot, ".smithers", "package.json");
  try {
    const bytes = readStableInitReviewFile(
      projectRoot,
      manifestPath,
      1024 * 1024,
      "generated Smithers package manifest"
    );
    const parsed = parseStrictJsonBytes(bytes, {
      maxBytes: 1024 * 1024,
      maxDepth: 32,
      maxItems: 10_000,
      maxProperties: 10_000
    });
    return migrateStockSmithers032PackageManifest(parsed);
  } catch {
    // A missing, customized, malformed, or unsafe manifest remains project-owned.
    // The normal init path preserves it and launch validation reports any
    // incompatible dependency contract without reflecting inspection details.
    return undefined;
  }
}

function upgradeStockSmithers032Adapters(
  projectRoot: string,
  created: string[],
  preserved: string[],
  overwritten: string[]
): ReadonlySet<string> {
  const upgraded = new Set<string>();
  for (const agent of AGENT_TEMPLATES) {
    const relativePath = `.smithers/agents/${agent.file}`;
    const filePath = path.join(projectRoot, relativePath);
    let bytes: Buffer;
    try {
      bytes = readStableInitReviewFile(
        projectRoot,
        filePath,
        MAX_AGENT_ADAPTER_REVIEW_BYTES,
        "generated 0.32 agent adapter"
      );
    } catch {
      continue;
    }
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    if (digest !== agent.stock032Sha256) continue;
    writeProjectFile(
      projectRoot,
      relativePath,
      loadRuntimeTemplate(agent.template),
      true,
      created,
      preserved,
      overwritten
    );
    upgraded.add(relativePath);
  }
  return upgraded;
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
      if (lexical.size > BigInt(MAX_AGENT_ADAPTER_REVIEW_BYTES)) {
        diagnostics.push(
          manualAgentAdapterReviewDiagnostic(
            relativePath,
            "is too large to inspect as a generated adapter and was preserved"
          )
        );
        continue;
      }
      const source = readStableInitReviewFile(
        projectRoot,
        filePath,
        MAX_AGENT_ADAPTER_REVIEW_BYTES,
        "generated agent adapter"
      ).toString("utf8");
      if (source.includes("ultrafuzz.toml") && !source.includes("ULTRAFUZZ_CONFIG_PATH")) {
        diagnostics.push({
          code: "INIT_AGENT_ADAPTER_UPDATE_REQUIRED",
          message: `${relativePath} was preserved and still reads mutable project ultrafuzz.toml; update it to read process.env.ULTRAFUZZ_CONFIG_PATH and use workflowControlChildEnvironment before spawning a model process`,
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
  const registry = inspectAgentRegistry(projectRoot);
  if (!registry.exists) return [];
  if (registry.error !== undefined) {
    // This runs after init may already have written other project files. Keep
    // the warning actionable without reflecting an OS/parser error that can
    // contain sensitive path or injected error details.
    return [
      manualAgentRegistryReviewDiagnostic("was preserved without inspection because it could not be safely inspected")
    ];
  }
  return AGENT_TEMPLATES.filter(
    (agent) =>
      lstatIfPresent(path.join(projectRoot, ".smithers", "agents", agent.file)) !== undefined &&
      !agentRegistryRegisters(registry, agent.ref)
  ).map((agent) => ({
    code: "INIT_AGENT_REGISTRY_STALE",
    message: `${AGENT_REGISTRY_RELATIVE_PATH} does not register ${agent.ref} in agentFactories, so runs cannot select it; rerun ultrafuzz init --force to regenerate the registry, or add the entry by hand`,
    severity: "warning" as const,
    source: "runtime",
    path: AGENT_REGISTRY_RELATIVE_PATH
  }));
}

function manualAgentRegistryReviewDiagnostic(reason: string): RuntimeDiagnostic {
  return {
    code: "INIT_AGENT_REGISTRY_REVIEW_REQUIRED",
    message: `${AGENT_REGISTRY_RELATIVE_PATH} ${reason}; verify manually that agentFactories registers every generated agent before starting a run`,
    severity: "warning",
    source: "runtime",
    path: AGENT_REGISTRY_RELATIVE_PATH
  };
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
  const existing = lstatIfPresent(filePath);
  if (existing !== undefined && !force) {
    preserved.push(relativePath);
    return;
  }
  assertNoSymlinkComponents(projectRoot, filePath, `init file ${relativePath}`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  assertNoSymlinkComponents(projectRoot, filePath, `init file ${relativePath}`);
  writeProjectFileNoFollow(projectRoot, filePath, contents, force, existing);
  if (existing !== undefined) overwritten.push(relativePath);
  else created.push(relativePath);
}

function writeProjectFileNoFollow(
  projectRoot: string,
  filePath: string,
  contents: string,
  replaceExisting: boolean,
  expected: fs.BigIntStats | undefined
): void {
  const directoryPath = path.dirname(filePath);
  assertNoSymlinkComponents(projectRoot, directoryPath, "generated project file directory");
  const directoryDescriptor = fs.openSync(
    directoryPath,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (fs.constants.O_NOFOLLOW ?? 0)
  );
  let fileDescriptor: number | undefined;
  let failure: unknown;
  try {
    const directory = fs.fstatSync(directoryDescriptor, { bigint: true });
    const lexicalDirectory = fs.lstatSync(directoryPath, { bigint: true });
    if (
      !directory.isDirectory() ||
      !lexicalDirectory.isDirectory() ||
      directory.dev !== lexicalDirectory.dev ||
      directory.ino !== lexicalDirectory.ino
    ) {
      throw new Error("generated project file directory changed while it was opened");
    }
    let directoryAccessPath = directoryPath;
    try {
      // Anchor both creation and replacement to the opened directory whenever
      // a verifiable descriptor pseudo-path is available. This closes the
      // parent-directory swap window before an O_EXCL creation as well as the
      // corresponding replacement window.
      directoryAccessPath = initDirectoryDescriptorPath(directoryDescriptor, directory);
    } catch (error) {
      // Descriptor pseudo-files are unavailable on Windows and on some
      // restricted Unix environments. The lexical fallback still opens
      // with O_NOFOLLOW where supported, validates the inode before
      // truncating, and rechecks both path and directory identity after the
      // write.
      if (!(error instanceof Error) || !/no verifiable descriptor path/u.test(error.message)) throw error;
      assertStableInitDirectory(directoryPath, directory, "generated project file directory changed");
    }
    const accessPath = path.join(directoryAccessPath, path.basename(filePath));
    const flags =
      expected === undefined
        ? fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0)
        : fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0);
    fileDescriptor = fs.openSync(accessPath, flags, 0o666);
    const opened = fs.fstatSync(fileDescriptor, { bigint: true });
    // Modal's virtual filesystem can report one device for an opened
    // directory and another for stable children created through that dirfd.
    // The child is authenticated against its lexical dev/ino below; requiring
    // it to share the parent's device rejects that valid, still-anchored shape.
    if (!opened.isFile() || opened.nlink !== 1n || (expected !== undefined && !sameStableInitFile(opened, expected))) {
      throw new Error("generated project file changed while it was opened");
    }
    const lexicalBeforeWrite = fs.lstatSync(filePath, { bigint: true });
    if (!sameStableInitFile(opened, lexicalBeforeWrite)) {
      throw new Error("generated project file changed before its contents could be replaced");
    }
    if (replaceExisting) fs.ftruncateSync(fileDescriptor, 0);
    // Scaffold files retain writeFileSync's prior durability semantics.
    writeDescriptorContents(fileDescriptor, Buffer.from(contents, "utf8"));
    const completed = fs.fstatSync(fileDescriptor, { bigint: true });
    const lexicalCompleted = fs.lstatSync(filePath, { bigint: true });
    const currentDirectory = fs.lstatSync(directoryPath, { bigint: true });
    if (
      !sameInitFileContentIdentity(opened, completed) ||
      completed.size !== BigInt(Buffer.byteLength(contents, "utf8")) ||
      !sameInitFileContentIdentity(opened, lexicalCompleted) ||
      lexicalCompleted.size !== BigInt(Buffer.byteLength(contents, "utf8")) ||
      !currentDirectory.isDirectory() ||
      currentDirectory.dev !== directory.dev ||
      currentDirectory.ino !== directory.ino
    ) {
      throw new Error("generated project file or its directory changed while it was written");
    }
  } catch (error) {
    failure = error;
  }
  try {
    if (fileDescriptor !== undefined) closeDescriptorReliably(fileDescriptor, "generated project file");
  } catch (error) {
    failure ??= error;
  }
  try {
    closeDescriptorReliably(directoryDescriptor, "generated project file directory");
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
}

function lstatIfPresent(filePath: string): fs.BigIntStats | undefined {
  try {
    return fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function initDirectoryDescriptorPath(descriptor: number, directory: fs.BigIntStats): string {
  for (const candidate of [`/proc/self/fd/${descriptor}`, `/dev/fd/${descriptor}`]) {
    try {
      const accessed = fs.statSync(candidate, { bigint: true });
      if (accessed.isDirectory() && accessed.dev === directory.dev && accessed.ino === directory.ino) return candidate;
    } catch {
      // Continue to the next descriptor filesystem.
    }
  }
  throw new Error("generated project file directory has no verifiable descriptor path");
}

function readStableInitReviewFile(projectRoot: string, filePath: string, maxBytes: number, label: string): Buffer {
  assertNoSymlinkComponents(projectRoot, path.dirname(filePath), `${label} directory`);
  const lexicalBefore = fs.lstatSync(filePath, { bigint: true });
  if (
    lexicalBefore.isSymbolicLink() ||
    !lexicalBefore.isFile() ||
    lexicalBefore.nlink !== 1n ||
    lexicalBefore.size > BigInt(maxBytes)
  ) {
    throw new Error(`${label} is not a bounded physical single-link file`);
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.size > BigInt(maxBytes)) {
      throw new Error(`${label} is not a bounded physical single-link file`);
    }
    const contents = readBoundedDescriptor(descriptor, maxBytes, label);
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
      throw new Error(`${label} changed while it was inspected`);
    }
    return contents;
  } finally {
    closeDescriptorReliably(descriptor, label);
  }
}

function readBoundedDescriptor(descriptor: number, maxBytes: number, label: string): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset <= maxBytes) {
    const remaining = maxBytes + 1 - offset;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.byteLength, offset);
    if (bytesRead === 0) return Buffer.concat(chunks, offset);
    chunks.push(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
  throw new Error(`${label} exceeds the safe inspection limit`);
}

function closeDescriptorReliably(descriptor: number, label: string): void {
  try {
    fs.closeSync(descriptor);
  } catch (error) {
    // POSIX leaves descriptor state unspecified when close(2) reports an
    // error. Retrying can close an unrelated descriptor if the number was
    // already recycled, so callers aggregate this error while continuing all
    // other independent cleanup steps.
    throw new Error(`${label} descriptor could not be closed`, { cause: error });
  }
}

function sameInitFileContentIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.isFile() === right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

function assertStableInitDirectory(directoryPath: string, expected: fs.BigIntStats, message: string): void {
  const current = fs.lstatSync(directoryPath, { bigint: true });
  if (!current.isDirectory() || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(message);
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
  let offset = 0;
  while (offset < contents.byteLength) {
    const written = fs.writeSync(descriptor, contents, offset, contents.byteLength - offset, offset);
    if (written === 0) throw new Error("generated agent adapter stopped accepting replacement bytes");
    offset += written;
  }
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
