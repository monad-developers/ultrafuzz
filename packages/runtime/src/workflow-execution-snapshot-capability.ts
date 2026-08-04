import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WORKFLOW_EXECUTION_SNAPSHOT_CAPABILITY: unique symbol = Symbol(
  "ultrafuzz.workflow-execution-snapshot-capability"
);

export interface WorkflowExecutionSnapshotIdentity {
  root: string;
  snapshotsRoot: string;
  snapshotsRootDevice: number;
  snapshotsRootInode: number;
  snapshotDevice: number;
  snapshotInode: number;
  protectedEntries: readonly WorkflowExecutionSnapshotProtectedEntry[];
}

interface WorkflowExecutionSnapshotProtectedEntryBase {
  relativePath: string;
  device: number;
  inode: number;
  mode: number;
  links: number;
}

export interface WorkflowExecutionSnapshotProtectedDirectory extends WorkflowExecutionSnapshotProtectedEntryBase {
  kind: "directory";
}

export interface WorkflowExecutionSnapshotProtectedFile extends WorkflowExecutionSnapshotProtectedEntryBase {
  kind: "file";
  size: number;
  sha256: string;
}

export interface WorkflowExecutionSnapshotProtectedLink extends WorkflowExecutionSnapshotProtectedEntryBase {
  kind: "link";
  size: number;
  target: string;
}

export type WorkflowExecutionSnapshotProtectedEntry =
  | WorkflowExecutionSnapshotProtectedDirectory
  | WorkflowExecutionSnapshotProtectedFile
  | WorkflowExecutionSnapshotProtectedLink;

type CapableEnvironment = Record<string, string | undefined> & {
  [WORKFLOW_EXECUTION_SNAPSHOT_CAPABILITY]?: Readonly<WorkflowExecutionSnapshotIdentity>;
};

export interface WorkflowExecutionSnapshotAnchor {
  assertCurrent(): void;
  rewriteControllerValue(value: string): string;
  close(): void;
}

/**
 * Injectable descriptor access keeps the pathname fallback testable without
 * impersonating another operating system. Production uses the defaults below;
 * a platform that cannot open directories or expose another process's held
 * descriptors simply returns `undefined` and relies on exact lexical identity
 * checks at both controller-command boundaries.
 */
export interface WorkflowExecutionSnapshotAnchorDependencies {
  openDirectory(directory: string): number | undefined;
  directoryDescriptorPath(descriptor: number): string | undefined;
  controllerDirectoryDescriptorPath(descriptor: number): string | undefined;
}

const DEFAULT_ANCHOR_DEPENDENCIES: WorkflowExecutionSnapshotAnchorDependencies = {
  openDirectory: openDirectoryWhenSupported,
  directoryDescriptorPath,
  controllerDirectoryDescriptorPath
};

/**
 * Carries snapshot identity to the controller command boundary without putting
 * forgeable authority in process environment variables. The symbol is kept
 * private to this module and enumerable so the ordinary object spreads used to
 * assemble controller environments preserve it.
 */
export function bindWorkflowExecutionSnapshotCapability<T extends Record<string, string | undefined>>(
  env: T,
  identity: WorkflowExecutionSnapshotIdentity
): T {
  const protectedEntries = identity.protectedEntries.map((entry) => Object.freeze({ ...entry }));
  Object.defineProperty(env, WORKFLOW_EXECUTION_SNAPSHOT_CAPABILITY, {
    configurable: false,
    enumerable: true,
    writable: false,
    value: Object.freeze({ ...identity, protectedEntries: Object.freeze(protectedEntries) })
  });
  return env;
}

export function hasWorkflowExecutionSnapshotCapability(env: Record<string, string | undefined> | undefined): boolean {
  return (env as CapableEnvironment | undefined)?.[WORKFLOW_EXECUTION_SNAPSHOT_CAPABILITY] !== undefined;
}

/**
 * Opens and verifies both ownership directories. Callers retain the returned
 * descriptors for the complete controller command, then revalidate before
 * closing them. This closes the materialize-to-command handoff race without
 * pretending to create a security boundary against arbitrary same-UID code.
 */
export function acquireWorkflowExecutionSnapshotAnchor(
  env: Record<string, string | undefined> | undefined,
  dependencyOverrides: Partial<WorkflowExecutionSnapshotAnchorDependencies> = {}
): WorkflowExecutionSnapshotAnchor | undefined {
  const identity = (env as CapableEnvironment | undefined)?.[WORKFLOW_EXECUTION_SNAPSHOT_CAPABILITY];
  if (identity === undefined) return undefined;

  assertCanonicalIdentity(identity);
  const dependencies = { ...DEFAULT_ANCHOR_DEPENDENCIES, ...dependencyOverrides };
  assertLexicalDirectoryIdentity(
    identity.snapshotsRoot,
    identity.snapshotsRootDevice,
    identity.snapshotsRootInode,
    "workflow execution snapshots"
  );
  assertLexicalDirectoryIdentity(
    identity.root,
    identity.snapshotDevice,
    identity.snapshotInode,
    "workflow execution snapshot"
  );
  const snapshotsDescriptor = dependencies.openDirectory(identity.snapshotsRoot);
  let snapshotDescriptor: number | undefined;
  try {
    if (snapshotsDescriptor !== undefined) {
      assertDescriptorIdentity(
        snapshotsDescriptor,
        identity.snapshotsRootDevice,
        identity.snapshotsRootInode,
        "workflow execution snapshots"
      );
    }
    const snapshotsDescriptorPath =
      snapshotsDescriptor === undefined
        ? undefined
        : verifiedDirectoryDescriptorPath(
            dependencies.directoryDescriptorPath(snapshotsDescriptor),
            identity.snapshotsRootDevice,
            identity.snapshotsRootInode,
            "workflow execution snapshots"
          );
    const snapshotOpenPath =
      snapshotsDescriptorPath === undefined
        ? identity.root
        : path.join(snapshotsDescriptorPath, path.basename(identity.root));
    snapshotDescriptor = dependencies.openDirectory(snapshotOpenPath);
    if (snapshotDescriptor !== undefined) {
      assertDescriptorIdentity(
        snapshotDescriptor,
        identity.snapshotDevice,
        identity.snapshotInode,
        "workflow execution snapshot"
      );
    }
    const controllerSnapshotPath =
      snapshotDescriptor === undefined
        ? undefined
        : verifiedDirectoryDescriptorPath(
            dependencies.controllerDirectoryDescriptorPath(snapshotDescriptor),
            identity.snapshotDevice,
            identity.snapshotInode,
            "workflow execution snapshot"
          );
    const snapshotAccessPath =
      snapshotDescriptor === undefined
        ? identity.root
        : (verifiedDirectoryDescriptorPath(
            dependencies.directoryDescriptorPath(snapshotDescriptor),
            identity.snapshotDevice,
            identity.snapshotInode,
            "workflow execution snapshot"
          ) ?? identity.root);

    let closed = false;
    const assertCurrent = (): void => {
      if (closed) throw new Error("workflow execution snapshot anchor is already closed");
      if (snapshotsDescriptor !== undefined) {
        assertDescriptorIdentity(
          snapshotsDescriptor,
          identity.snapshotsRootDevice,
          identity.snapshotsRootInode,
          "workflow execution snapshots"
        );
      }
      if (snapshotDescriptor !== undefined) {
        assertDescriptorIdentity(
          snapshotDescriptor,
          identity.snapshotDevice,
          identity.snapshotInode,
          "workflow execution snapshot"
        );
      }
      assertLexicalDirectoryIdentity(
        identity.snapshotsRoot,
        identity.snapshotsRootDevice,
        identity.snapshotsRootInode,
        "workflow execution snapshots"
      );
      assertLexicalDirectoryIdentity(
        identity.root,
        identity.snapshotDevice,
        identity.snapshotInode,
        "workflow execution snapshot"
      );
      assertProtectedTreeCurrent(identity, snapshotAccessPath, snapshotDescriptor);
    };
    assertCurrent();
    return {
      assertCurrent,
      rewriteControllerValue: (value) =>
        rewriteControllerValue(value, identity.root, controllerSnapshotPath ?? identity.root),
      close: () => {
        if (closed) return;
        closed = true;
        closeFileDescriptors([
          ...(snapshotDescriptor === undefined ? [] : [snapshotDescriptor]),
          ...(snapshotsDescriptor === undefined ? [] : [snapshotsDescriptor])
        ]);
      }
    };
  } catch (error) {
    try {
      closeFileDescriptors([
        ...(snapshotDescriptor === undefined ? [] : [snapshotDescriptor]),
        ...(snapshotsDescriptor === undefined ? [] : [snapshotsDescriptor])
      ]);
    } catch {
      // Preserve the identity/setup failure after attempting every close.
    }
    throw error;
  }
}

function closeFileDescriptors(descriptors: readonly number[]): void {
  let failed = false;
  let failure: unknown;
  for (const descriptor of descriptors) {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  }
  if (failed) throw failure;
}

function rewriteControllerValue(value: string, lexicalRoot: string, descriptorRoot: string): string {
  if (value.startsWith("file:")) {
    try {
      const filePath = fileURLToPath(value);
      const rewritten = rewriteAbsoluteSnapshotPath(filePath, lexicalRoot, descriptorRoot);
      return rewritten === filePath ? value : pathToFileURL(rewritten).href;
    } catch {
      return value;
    }
  }
  return rewriteAbsoluteSnapshotPath(value, lexicalRoot, descriptorRoot);
}

function rewriteAbsoluteSnapshotPath(value: string, lexicalRoot: string, descriptorRoot: string): string {
  if (!path.isAbsolute(value)) return value;
  const relative = path.relative(lexicalRoot, value);
  if (relative === "") return descriptorRoot;
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) return value;
  return path.join(descriptorRoot, relative);
}

function assertCanonicalIdentity(identity: WorkflowExecutionSnapshotIdentity): void {
  const snapshotsRoot = path.resolve(identity.snapshotsRoot);
  const root = path.resolve(identity.root);
  if (identity.snapshotsRoot !== snapshotsRoot || identity.root !== root || path.dirname(root) !== snapshotsRoot) {
    throw new Error("workflow execution snapshot capability is not a canonical direct-child identity");
  }
  const seen = new Set<string>();
  for (const entry of identity.protectedEntries) {
    const relative = entry.relativePath;
    if (
      typeof relative !== "string" ||
      (relative !== "" &&
        (relative.includes("\\") ||
          path.posix.isAbsolute(relative) ||
          path.posix.normalize(relative) !== relative ||
          relative === "." ||
          relative.startsWith("../"))) ||
      seen.has(relative) ||
      !["directory", "file", "link"].includes(entry.kind) ||
      !validIdentityNumber(entry.device) ||
      !validIdentityNumber(entry.inode) ||
      !validIdentityNumber(entry.mode) ||
      !validIdentityNumber(entry.links) ||
      (entry.kind !== "directory" && (!validIdentityNumber(entry.size) || entry.size < 0)) ||
      (entry.kind === "file" && !/^[0-9a-f]{64}$/u.test(entry.sha256)) ||
      (entry.kind === "link" && typeof entry.target !== "string")
    ) {
      throw new Error("workflow execution snapshot capability has an invalid protected-tree identity");
    }
    seen.add(relative);
  }
  const rootEntry = identity.protectedEntries.find((entry) => entry.relativePath === "");
  if (
    rootEntry?.kind !== "directory" ||
    rootEntry.device !== identity.snapshotDevice ||
    rootEntry.inode !== identity.snapshotInode
  ) {
    throw new Error("workflow execution snapshot capability has no matching protected root identity");
  }
}

function validIdentityNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertProtectedTreeCurrent(
  identity: Readonly<WorkflowExecutionSnapshotIdentity>,
  accessRoot: string,
  rootDescriptor: number | undefined
): void {
  const entries = new Map(identity.protectedEntries.map((entry) => [entry.relativePath, entry]));
  for (const entry of identity.protectedEntries) {
    if (entry.relativePath === "") continue;
    const parent = path.posix.dirname(entry.relativePath);
    const parentRelative = parent === "." ? "" : parent;
    if (entries.get(parentRelative)?.kind !== "directory") {
      throw new Error("workflow execution snapshot capability protected tree has a missing parent directory");
    }
  }

  const directories = identity.protectedEntries.filter(
    (entry): entry is WorkflowExecutionSnapshotProtectedDirectory => entry.kind === "directory"
  );
  const assertDirectories = (): void => {
    for (const directory of directories) {
      const accessPath = protectedEntryPath(accessRoot, directory.relativePath);
      const lexicalPath = protectedEntryPath(identity.root, directory.relativePath);
      const accessStat =
        directory.relativePath === "" && rootDescriptor !== undefined
          ? fs.fstatSync(rootDescriptor)
          : directory.relativePath === ""
            ? fs.statSync(accessPath)
            : fs.lstatSync(accessPath);
      const lexicalStat = fs.lstatSync(lexicalPath);
      assertProtectedEntryStats(accessStat, lexicalStat, directory);
      if (!accessStat.isDirectory() || accessStat.isSymbolicLink() || (accessStat.mode & 0o222) !== 0) {
        throw new Error(
          `workflow execution snapshot directory changed at the controller command boundary: ${directory.relativePath || "."}`
        );
      }
    }
  };

  assertDirectories();
  for (const entry of identity.protectedEntries) {
    if (entry.kind === "directory") continue;
    const accessPath = protectedEntryPath(accessRoot, entry.relativePath);
    const lexicalPath = protectedEntryPath(identity.root, entry.relativePath);
    if (entry.kind === "link") {
      const accessStat = fs.lstatSync(accessPath);
      const lexicalStat = fs.lstatSync(lexicalPath);
      assertProtectedEntryStats(accessStat, lexicalStat, entry);
      const accessTarget = fs.readlinkSync(accessPath);
      const lexicalTarget = fs.readlinkSync(lexicalPath);
      const completedAccess = fs.lstatSync(accessPath);
      const completedLexical = fs.lstatSync(lexicalPath);
      assertProtectedEntryStats(completedAccess, completedLexical, entry);
      if (!accessStat.isSymbolicLink() || accessTarget !== entry.target || lexicalTarget !== entry.target) {
        throw new Error(
          `workflow execution snapshot link changed at the controller command boundary: ${entry.relativePath}`
        );
      }
      continue;
    }
    assertProtectedFileCurrent(accessPath, lexicalPath, entry);
  }
  assertDirectories();
}

function protectedEntryPath(root: string, relative: string): string {
  return relative === "" ? root : path.join(root, ...relative.split("/"));
}

function assertProtectedEntryStats(
  access: fs.Stats,
  lexical: fs.Stats,
  expected: WorkflowExecutionSnapshotProtectedEntry
): void {
  if (
    access.dev !== expected.device ||
    access.ino !== expected.inode ||
    access.mode !== expected.mode ||
    access.nlink !== expected.links ||
    lexical.dev !== expected.device ||
    lexical.ino !== expected.inode ||
    lexical.mode !== expected.mode ||
    lexical.nlink !== expected.links ||
    (expected.kind !== "directory" && (access.size !== expected.size || lexical.size !== expected.size))
  ) {
    throw new Error(
      `workflow execution snapshot entry changed at the controller command boundary: ${expected.relativePath || "."}`
    );
  }
}

function assertProtectedFileCurrent(
  accessPath: string,
  lexicalPath: string,
  expected: WorkflowExecutionSnapshotProtectedFile
): void {
  const descriptor = fs.openSync(accessPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    const lexical = fs.lstatSync(lexicalPath);
    assertProtectedEntryStats(opened, lexical, expected);
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1 || (opened.mode & 0o222) !== 0) {
      throw new Error(
        `workflow execution snapshot file changed at the controller command boundary: ${expected.relativePath}`
      );
    }
    const sha256 = digestDescriptor(descriptor);
    const completedAccess = fs.lstatSync(accessPath);
    const completedLexical = fs.lstatSync(lexicalPath);
    assertProtectedEntryStats(completedAccess, completedLexical, expected);
    if (
      !completedAccess.isFile() ||
      completedAccess.isSymbolicLink() ||
      completedAccess.nlink !== 1 ||
      (completedAccess.mode & 0o222) !== 0 ||
      completedAccess.size !== opened.size ||
      completedAccess.mode !== opened.mode ||
      sha256 !== expected.sha256
    ) {
      throw new Error(
        `workflow execution snapshot file changed at the controller command boundary: ${expected.relativePath}`
      );
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function digestDescriptor(descriptor: number): string {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

function openDirectoryNoFollow(directory: string): number {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const directoryOnly = fs.constants.O_DIRECTORY ?? 0;
  return fs.openSync(directory, fs.constants.O_RDONLY | noFollow | directoryOnly);
}

function openDirectoryWhenSupported(directory: string): number | undefined {
  // Node cannot open directory handles with `fs.openSync` on Windows. The
  // lexical fallback below still checks the exact parent/root identities before
  // and after every controller command.
  return process.platform === "win32" ? undefined : openDirectoryNoFollow(directory);
}

function assertDescriptorIdentity(descriptor: number, device: number, inode: number, label: string): void {
  const stat = fs.fstatSync(descriptor);
  if (!stat.isDirectory() || stat.dev !== device || stat.ino !== inode) {
    throw new Error(`${label} changed at the controller command boundary`);
  }
}

function assertLexicalDirectoryIdentity(directory: string, device: number, inode: number, label: string): void {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== device || stat.ino !== inode) {
    throw new Error(`${label} changed at the controller command boundary`);
  }
}

function directoryDescriptorPath(descriptor: number): string | undefined {
  const candidates = [`/proc/self/fd/${descriptor}`, `/dev/fd/${descriptor}`];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Continue to the next platform descriptor path.
    }
  }
  return undefined;
}

function controllerDirectoryDescriptorPath(descriptor: number): string | undefined {
  const candidate = `/proc/${process.pid}/fd/${descriptor}`;
  try {
    if (fs.statSync(candidate).isDirectory()) return candidate;
  } catch {
    // Platforms without cross-process descriptor paths use lexical identity.
  }
  return undefined;
}

function verifiedDirectoryDescriptorPath(
  candidate: string | undefined,
  device: number,
  inode: number,
  label: string
): string | undefined {
  if (candidate === undefined) return undefined;
  const stat = fs.statSync(candidate);
  if (!stat.isDirectory() || stat.dev !== device || stat.ino !== inode) {
    throw new Error(`${label} descriptor path changed at the controller command boundary`);
  }
  return candidate;
}
