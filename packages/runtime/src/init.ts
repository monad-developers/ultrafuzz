import fs from "node:fs";
import path from "node:path";

import {
  assertNoSymlinkComponents,
  goalPlanJsonSchema,
  parseStrictJsonBytes,
  threatModelJsonSchema
} from "@ultrafuzz/artifacts";
import {
  packagedTopology,
  redactResolvedConfig,
  resolveConfig,
  serializeRedactedResolvedConfigToml
} from "@ultrafuzz/config";
import { builtInPromptRelativePaths, scaffoldPrompts } from "@ultrafuzz/prompts";
import { defaultReferenceCatalogYaml } from "@ultrafuzz/references";
import { STOCK_CONTROLLER_SOURCE_TEMPLATES } from "./controller-source.js";
import { loadRuntimeTemplate } from "./runtime-template.js";
import { migrateStockSmithers032PackageManifest, renderSmithersPackageJson } from "./smithers-package.js";
import type { InitProjectInput, InitProjectResult } from "./types.js";
import { configDiagnostics, runtimeFailure, runtimeResult, toProjectRelative } from "./utils.js";

const DEFAULT_TOPOLOGY = fs.readFileSync(packagedTopology("default").path, "utf8");

/**
 * Canonical artifact JSON Schemas scaffolded into the project.
 *
 * The threat-model and goal-plan prompts point the agent at these files, so they must exist in
 * every initialized project -- not only in this monorepo -- and they must be generated from the
 * same runtime validators that gate the nodes. `schema/*.schema.json` in `@ultrafuzz/artifacts` is
 * the parity-checked snapshot of the identical documents.
 */
const PROJECT_ARTIFACT_SCHEMA_DIR = ".ultrafuzz/schema";
const PROJECT_ARTIFACT_SCHEMA_FILES = [
  { relativePath: `${PROJECT_ARTIFACT_SCHEMA_DIR}/threat-model.schema.json`, schema: threatModelJsonSchema },
  { relativePath: `${PROJECT_ARTIFACT_SCHEMA_DIR}/goal-plan.schema.json`, schema: goalPlanJsonSchema }
] as const;

/** The absolute scaffolded schema directory backing the `artifact_schema_dir` prompt variable. */
export function projectArtifactSchemaDir(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_ARTIFACT_SCHEMA_DIR);
}

export function projectArtifactSchemaJson(schema: Record<string, unknown>): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

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
    PROJECT_ARTIFACT_SCHEMA_DIR,
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
    for (const { relativePath, schema } of PROJECT_ARTIFACT_SCHEMA_FILES) {
      writeProjectFile(
        projectRoot,
        relativePath,
        projectArtifactSchemaJson(schema),
        input.force === true,
        created,
        preserved,
        overwritten
      );
    }
    writeProjectFile(
      projectRoot,
      ".smithers/package.json",
      stockSmithersPackageMigration ?? renderSmithersPackageJson(),
      input.force === true || stockSmithersPackageMigration !== undefined,
      created,
      preserved,
      overwritten
    );
    // Planning admits only the byte-exact packaged adapter closure, so these
    // files are never project-owned. Refresh them on every init: otherwise an
    // upgrade needs `init --force`, which also resets ultrafuzz.toml, the
    // topology, and the prompts.
    for (const [file, template] of Object.entries(STOCK_CONTROLLER_SOURCE_TEMPLATES)) {
      writeProjectFile(
        projectRoot,
        `.smithers/agents/${file}`,
        loadRuntimeTemplate(template),
        true,
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

  return runtimeResult(true, {
    project_root: projectRoot,
    created: publicInitPaths(created),
    preserved: publicInitPaths(preserved),
    overwritten: publicInitPaths(overwritten)
  });
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
    // O_NONBLOCK makes a FIFO planted at a generated path fail the open (or the
    // regular-file check below) instead of blocking init on a missing reader.
    fileDescriptor = fs.openSync(accessPath, flags | fs.constants.O_NONBLOCK, 0o666);
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
  return fs.lstatSync(filePath, { bigint: true, throwIfNoEntry: false });
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

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function publicInitPaths(values: string[]): string[] {
  return uniqueSorted(values).filter((value) => !value.toLowerCase().includes("smithers"));
}
