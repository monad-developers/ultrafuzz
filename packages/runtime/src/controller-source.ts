import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { loadRuntimeTemplate } from "./runtime-template.js";

const MAX_CONTROLLER_SOURCE_FILES = 128;
const MAX_CONTROLLER_SOURCE_DIRECTORIES = 128;
const MAX_CONTROLLER_SOURCE_DEPTH = 32;
const MAX_CONTROLLER_SOURCE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CONTROLLER_SOURCE_BYTES = 16 * 1024 * 1024;
const CONTROLLER_EXECUTION_SNAPSHOT_PREFIX = ".smithers/agents/";

export const STOCK_CONTROLLER_SOURCE_TEMPLATES = Object.freeze({
  "claude.ts": "smithers/agents/claude.tsx",
  "codex.ts": "smithers/agents/codex.tsx",
  "deepseek.ts": "smithers/agents/deepseek.tsx",
  "environment.ts": "smithers/agents/environment.tsx",
  "index.ts": "smithers/agents/index.tsx",
  "kimi.ts": "smithers/agents/kimi.tsx",
  "openrouter.ts": "smithers/agents/openrouter.tsx",
  "provider-home.ts": "smithers/agents/provider-home.tsx",
  "strict-json.ts": "smithers/agents/strict-json.tsx",
  "toml.ts": "smithers/agents/toml.tsx"
} satisfies Readonly<Record<string, string>>);

export interface ControllerSourceInspection {
  digest: string;
  stock: boolean;
  files: readonly string[];
  overrides: readonly string[];
}

interface ControllerSourceFile {
  relativePath: string;
  contents: Buffer;
}

interface OpenControllerSourceDirectory {
  lexicalPath: string;
  accessPath: string;
  descriptor?: number;
  opened: fs.BigIntStats;
}

/**
 * Authenticate the complete project-resident controller adapter closure without
 * importing it. Stock scaffolds are recognized byte-for-byte; any other closure
 * is reported as a digest-bound override for the launch-review gate.
 */
export function inspectControllerSource(projectRoot: string): ControllerSourceInspection {
  const root = path.resolve(projectRoot);
  const agentsRoot = path.join(root, ".smithers", "agents");
  const files = readControllerSourceFiles(agentsRoot);
  const expected = new Map(
    Object.entries(STOCK_CONTROLLER_SOURCE_TEMPLATES).map(([relativePath, template]) => [
      relativePath,
      Buffer.from(loadRuntimeTemplate(template), "utf8")
    ])
  );
  const actual = new Map(files.map((file) => [file.relativePath, file.contents]));
  const paths = [...actual.keys()].sort(compareStrings);
  const expectedPaths = [...expected.keys()].sort(compareStrings);
  const stock =
    paths.length === expectedPaths.length &&
    paths.every((relativePath, index) => {
      const expectedPath = expectedPaths[index];
      return expectedPath === relativePath && actual.get(relativePath)!.equals(expected.get(relativePath)!);
    });
  const overrides = stock
    ? []
    : [...new Set([...paths, ...expectedPaths])]
        .filter((relativePath) => {
          const observed = actual.get(relativePath);
          const packaged = expected.get(relativePath);
          return observed === undefined || packaged === undefined || !observed.equals(packaged);
        })
        .sort(compareStrings);
  return {
    digest: controllerSourceDigest(files),
    stock,
    files: paths,
    overrides
  };
}

/** Re-read the closure at the command boundary and reject every post-review change. */
export function assertControllerSourceDigest(projectRoot: string, expectedDigest: string): ControllerSourceInspection {
  const observed = inspectControllerSource(projectRoot);
  if (observed.digest !== expectedDigest) {
    throw controllerSourceChangedError();
  }
  return observed;
}

/** Bind the exact controller bytes sealed for execution back to launch review. */
export function assertControllerExecutionSnapshotDigest(
  executionFiles: readonly { snapshotPath: string; contents: Buffer }[],
  expectedDigest: string
): void {
  const files: ControllerSourceFile[] = [];
  const observedPaths = new Set<string>();
  let totalBytes = 0;
  for (const file of executionFiles) {
    if (!file.snapshotPath.startsWith(CONTROLLER_EXECUTION_SNAPSHOT_PREFIX)) continue;
    const relativePath = file.snapshotPath.slice(CONTROLLER_EXECUTION_SNAPSHOT_PREFIX.length);
    if (
      relativePath.length === 0 ||
      relativePath.startsWith("../") ||
      relativePath.includes("\\") ||
      path.posix.isAbsolute(relativePath) ||
      path.posix.normalize(relativePath) !== relativePath
    ) {
      throw new Error("sealed controller adapter source has an invalid snapshot path");
    }
    if (observedPaths.has(relativePath)) {
      throw new Error("sealed controller adapter source contains a duplicate snapshot path");
    }
    if (file.contents.byteLength > MAX_CONTROLLER_SOURCE_FILE_BYTES) {
      throw new Error("sealed controller adapter source file exceeds the review size limit");
    }
    totalBytes += file.contents.byteLength;
    if (totalBytes > MAX_CONTROLLER_SOURCE_BYTES) {
      throw new Error("sealed controller adapter source exceeds the aggregate review size limit");
    }
    observedPaths.add(relativePath);
    files.push({ relativePath, contents: file.contents });
    if (files.length > MAX_CONTROLLER_SOURCE_FILES) {
      throw new Error("sealed controller adapter source exceeds the review file limit");
    }
  }
  if (!observedPaths.has("index.ts")) {
    throw new Error("sealed controller adapter registry is missing");
  }
  files.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
  if (controllerSourceDigest(files) !== expectedDigest) throw controllerSourceChangedError();
}

function readControllerSourceFiles(root: string): ControllerSourceFile[] {
  const projectRoot = path.dirname(path.dirname(root));
  let openedProject: OpenControllerSourceDirectory | undefined;
  let openedSmithers: OpenControllerSourceDirectory | undefined;
  let openedRoot: OpenControllerSourceDirectory;
  try {
    openedProject = openControllerSourceDirectory(projectRoot, projectRoot);
    openedSmithers = openControllerSourceDirectory(
      path.join(openedProject.accessPath, ".smithers"),
      path.join(openedProject.lexicalPath, ".smithers")
    );
    openedRoot = openControllerSourceDirectory(
      path.join(openedSmithers.accessPath, "agents"),
      path.join(openedSmithers.lexicalPath, "agents")
    );
  } catch (error) {
    if (openedSmithers !== undefined) closeControllerSourceDirectory(openedSmithers);
    if (openedProject !== undefined) closeControllerSourceDirectory(openedProject);
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error("generated controller adapter directory is missing; run ultrafuzz init --force before launch", {
        cause: error
      });
    }
    throw error;
  }
  const files: ControllerSourceFile[] = [];
  const limits = { totalBytes: 0, directories: 1 };
  try {
    readControllerSourceDirectory(openedRoot, "", 0, files, limits);
    assertControllerSourceDirectoryCurrent(openedSmithers!);
    assertControllerSourceDirectoryCurrent(openedProject!);
  } finally {
    closeControllerSourceDirectory(openedRoot);
    closeControllerSourceDirectory(openedSmithers!);
    closeControllerSourceDirectory(openedProject!);
  }
  if (!files.some((file) => file.relativePath === "index.ts")) {
    throw new Error("generated controller adapter registry is missing");
  }
  return files.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
}

function readControllerSourceDirectory(
  directory: OpenControllerSourceDirectory,
  relativeDirectory: string,
  depth: number,
  files: ControllerSourceFile[],
  limits: { totalBytes: number; directories: number }
): void {
  assertControllerSourceDirectoryCurrent(directory);
  const names = fs.readdirSync(directory.accessPath).sort(compareStrings);
  for (const name of names) {
    if (name.length === 0 || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      throw new Error("controller adapter source contains an invalid entry name");
    }
    assertControllerSourceDirectoryCurrent(directory);
    const accessPath = path.join(directory.accessPath, name);
    const lexicalPath = path.join(directory.lexicalPath, name);
    const accessed = fs.lstatSync(accessPath, { bigint: true });
    const lexical = fs.lstatSync(lexicalPath, { bigint: true });
    if (!sameControllerSourceIdentity(accessed, lexical)) {
      throw new Error("controller adapter source entry changed during review");
    }
    if (accessed.isSymbolicLink()) throw new Error("controller adapter source cannot contain symbolic links");
    const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
    if (accessed.isDirectory()) {
      if (depth >= MAX_CONTROLLER_SOURCE_DEPTH) {
        throw new Error("controller adapter source exceeds the review directory depth limit");
      }
      limits.directories += 1;
      if (limits.directories > MAX_CONTROLLER_SOURCE_DIRECTORIES) {
        throw new Error("controller adapter source exceeds the review directory limit");
      }
      const child = openControllerSourceDirectory(accessPath, lexicalPath);
      try {
        readControllerSourceDirectory(child, relativePath, depth + 1, files, limits);
      } finally {
        closeControllerSourceDirectory(child);
      }
      continue;
    }
    if (!accessed.isFile()) throw new Error("controller adapter source contains a non-regular entry");
    const contents = readControllerSourceFile(accessPath, lexicalPath);
    limits.totalBytes += contents.byteLength;
    if (limits.totalBytes > MAX_CONTROLLER_SOURCE_BYTES) {
      throw new Error("controller adapter source exceeds the aggregate review size limit");
    }
    files.push({ relativePath, contents });
    if (files.length > MAX_CONTROLLER_SOURCE_FILES) {
      throw new Error("controller adapter source exceeds the review file limit");
    }
  }
  const completedNames = fs.readdirSync(directory.accessPath).sort(compareStrings);
  if (JSON.stringify(completedNames) !== JSON.stringify(names)) {
    throw new Error("controller adapter source directory changed during review");
  }
  assertControllerSourceDirectoryCurrent(directory);
}

function openControllerSourceDirectory(accessPath: string, lexicalPath: string): OpenControllerSourceDirectory {
  const accessed = fs.lstatSync(accessPath, { bigint: true });
  const lexical = fs.lstatSync(lexicalPath, { bigint: true });
  if (accessed.isSymbolicLink() || !accessed.isDirectory() || lexical.isSymbolicLink() || !lexical.isDirectory()) {
    throw new Error("generated controller adapter root must be a physical directory");
  }
  if (!sameControllerSourceIdentity(accessed, lexical)) {
    throw new Error("controller adapter source directory changed while it was opened");
  }
  const descriptor =
    process.platform === "win32"
      ? undefined
      : fs.openSync(
          accessPath,
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_DIRECTORY ?? 0)
        );
  try {
    const opened = descriptor === undefined ? accessed : fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isDirectory() || !sameControllerSourceIdentity(opened, accessed)) {
      throw new Error("controller adapter source directory changed while it was opened");
    }
    const descriptorPath =
      descriptor === undefined ? undefined : verifiedControllerSourceDescriptorPath(descriptor, opened.dev, opened.ino);
    const result = {
      lexicalPath,
      accessPath: descriptorPath ?? accessPath,
      opened,
      ...(descriptor === undefined ? {} : { descriptor })
    };
    assertControllerSourceDirectoryCurrent(result);
    return result;
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    throw error;
  }
}

function verifiedControllerSourceDescriptorPath(descriptor: number, device: bigint, inode: bigint): string {
  for (const candidate of [`/proc/self/fd/${descriptor}`, `/dev/fd/${descriptor}`]) {
    try {
      const stat = fs.statSync(candidate, { bigint: true });
      if (stat.isDirectory() && stat.dev === device && stat.ino === inode) return candidate;
    } catch {
      // Try the next platform descriptor path.
    }
  }
  throw new Error("controller adapter source has no verifiable directory descriptor path");
}

function assertControllerSourceDirectoryCurrent(directory: OpenControllerSourceDirectory): void {
  const opened =
    directory.descriptor === undefined
      ? fs.lstatSync(directory.accessPath, { bigint: true })
      : fs.fstatSync(directory.descriptor, { bigint: true });
  const lexical = fs.lstatSync(directory.lexicalPath, { bigint: true });
  if (
    !opened.isDirectory() ||
    lexical.isSymbolicLink() ||
    !lexical.isDirectory() ||
    !sameControllerSourceIdentity(opened, directory.opened) ||
    !sameControllerSourceIdentity(opened, lexical)
  ) {
    throw new Error("controller adapter source directory changed during review");
  }
}

function closeControllerSourceDirectory(directory: OpenControllerSourceDirectory): void {
  if (directory.descriptor !== undefined) fs.closeSync(directory.descriptor);
}

function readControllerSourceFile(accessPath: string, lexicalPath: string): Buffer {
  const descriptor = fs.openSync(accessPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const accessed = fs.lstatSync(accessPath, { bigint: true });
    const lexical = fs.lstatSync(lexicalPath, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      accessed.isSymbolicLink() ||
      lexical.isSymbolicLink() ||
      !sameControllerSourceIdentity(opened, accessed) ||
      !sameControllerSourceIdentity(opened, lexical)
    ) {
      throw new Error("controller adapter source must contain only singly linked regular files");
    }
    if (opened.size < 0n || opened.size > BigInt(MAX_CONTROLLER_SOURCE_FILE_BYTES)) {
      throw new Error("controller adapter source file exceeds the review size limit");
    }
    const contents = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < contents.byteLength) {
      const bytesRead = fs.readSync(descriptor, contents, offset, contents.byteLength - offset, offset);
      if (bytesRead === 0) throw new Error("controller adapter source changed size during review");
      offset += bytesRead;
    }
    const completed = fs.fstatSync(descriptor, { bigint: true });
    const currentAccessed = fs.lstatSync(accessPath, { bigint: true });
    const currentLexical = fs.lstatSync(lexicalPath, { bigint: true });
    if (
      !sameControllerSourceIdentity(opened, completed) ||
      !sameControllerSourceIdentity(opened, currentAccessed) ||
      !sameControllerSourceIdentity(opened, currentLexical)
    ) {
      throw new Error("controller adapter source changed while it was reviewed");
    }
    return contents;
  } finally {
    fs.closeSync(descriptor);
  }
}

function sameControllerSourceIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

function controllerSourceChangedError(): Error {
  return new Error(
    "controller adapter source changed after launch review; review the new launch digest before retrying"
  );
}

function controllerSourceDigest(files: readonly ControllerSourceFile[]): string {
  const hash = crypto.createHash("sha256");
  hash.update("ultrafuzz-controller-source-v1\0", "utf8");
  for (const file of files) {
    const pathBytes = Buffer.from(file.relativePath, "utf8");
    const header = Buffer.allocUnsafe(8);
    header.writeUInt32BE(pathBytes.byteLength, 0);
    header.writeUInt32BE(file.contents.byteLength, 4);
    hash.update(header);
    hash.update(pathBytes);
    hash.update(file.contents);
  }
  return hash.digest("hex");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
