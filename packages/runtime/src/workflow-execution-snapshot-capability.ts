import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WORKFLOW_EXECUTION_SNAPSHOT_CAPABILITY: unique symbol = Symbol(
  "ultrafuzz.workflow-execution-snapshot-capability"
);

export interface WorkflowExecutionSnapshotProtectedDirectory {
  kind: "directory";
  relativePath: string;
  device: number;
  inode: number;
  mode: number;
  links: number;
}

export interface WorkflowExecutionSnapshotProtectedFile {
  kind: "file";
  relativePath: string;
  device: number;
  inode: number;
  mode: number;
  links: number;
  size: number;
  sha256: string;
}

export interface WorkflowExecutionSnapshotProtectedLink {
  kind: "link";
  relativePath: string;
  device: number;
  inode: number;
  mode: number;
  links: number;
  size: number;
  target: string;
}

export type WorkflowExecutionSnapshotProtectedEntry =
  | WorkflowExecutionSnapshotProtectedDirectory
  | WorkflowExecutionSnapshotProtectedFile
  | WorkflowExecutionSnapshotProtectedLink;

export interface WorkflowExecutionSnapshotIdentity {
  root: string;
  snapshotsRoot: string;
  snapshotsRootDevice: number;
  snapshotsRootInode: number;
  snapshotDevice: number;
  snapshotInode: number;
  protectedEntries: readonly WorkflowExecutionSnapshotProtectedEntry[];
}

type CapableEnvironment = Record<string, string | undefined> & {
  [WORKFLOW_EXECUTION_SNAPSHOT_CAPABILITY]?: Readonly<WorkflowExecutionSnapshotIdentity>;
};

interface ProtectedTreeAttestation {
  changeTokens: readonly string[];
}

// The identity object is a process-private capability that survives the
// controlled environment clones used throughout one lifecycle. A reloaded or
// rebound identity is a different WeakMap key and must authenticate every byte
// independently before it can use metadata-only command-boundary checks.
const protectedTreeAttestations = new WeakMap<Readonly<WorkflowExecutionSnapshotIdentity>, ProtectedTreeAttestation>();

export interface WorkflowExecutionSnapshotAnchor {
  assertCurrent(): void;
  rewriteControllerValue(value: string): string;
  close(): void;
}

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
 * Attaches non-forgeable snapshot identity to the controller environment. The
 * private enumerable symbol survives the ordinary object spreads used to add
 * credentials without becoming a process environment variable.
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
 * Holds the snapshot and its parent open for a complete Smithers command. On
 * Linux, controller arguments are rewritten through the held descriptor so a
 * pathname replacement cannot change which verified tree the child consumes.
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
    if (snapshotDescriptor === undefined) {
      throw new Error("workflow execution snapshot has no descriptor anchor for controller execution");
    }
    assertDescriptorIdentity(
      snapshotDescriptor,
      identity.snapshotDevice,
      identity.snapshotInode,
      "workflow execution snapshot"
    );
    const controllerSnapshotPath = verifiedDirectoryDescriptorPath(
      dependencies.controllerDirectoryDescriptorPath(snapshotDescriptor),
      identity.snapshotDevice,
      identity.snapshotInode,
      "workflow execution snapshot"
    );
    if (controllerSnapshotPath === undefined) {
      throw new Error("workflow execution snapshot has no cross-process descriptor path for controller execution");
    }
    const snapshotAccessPath =
      verifiedDirectoryDescriptorPath(
        dependencies.directoryDescriptorPath(snapshotDescriptor),
        identity.snapshotDevice,
        identity.snapshotInode,
        "workflow execution snapshot"
      ) ?? controllerSnapshotPath;

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
      const attestation = protectedTreeAttestations.get(identity);
      if (attestation === undefined) {
        // Bracket the content digest with exact change tokens. This prevents a
        // mutation racing the initial digest from being blessed as the cached
        // baseline, including same-size writes whose mtime is restored.
        const before = assertProtectedTreeCurrent(identity, snapshotAccessPath, snapshotDescriptor);
        assertProtectedTreeCurrent(identity, snapshotAccessPath, snapshotDescriptor, digestDescriptor);
        const after = assertProtectedTreeCurrent(identity, snapshotAccessPath, snapshotDescriptor);
        assertMatchingChangeTokens(before, after);
        protectedTreeAttestations.set(identity, Object.freeze({ changeTokens: Object.freeze(after) }));
        return;
      }
      const current = assertProtectedTreeCurrent(identity, snapshotAccessPath, snapshotDescriptor);
      assertMatchingChangeTokens(attestation.changeTokens, current);
    };
    assertCurrent();
    return {
      assertCurrent,
      rewriteControllerValue: (value) => rewriteControllerValue(value, identity.root, controllerSnapshotPath),
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
      // Preserve the integrity failure after attempting every close.
    }
    throw error;
  }
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
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return value;
  return path.join(descriptorRoot, relative);
}

function assertCanonicalIdentity(identity: Readonly<WorkflowExecutionSnapshotIdentity>): void {
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
  rootDescriptor: number | undefined,
  digest: ((descriptor: number) => string) | undefined = undefined
): string[] {
  const entries = new Map(identity.protectedEntries.map((entry) => [entry.relativePath, entry]));
  const expectedChildren = new Map<string, string[]>();
  for (const entry of identity.protectedEntries) {
    if (entry.kind === "directory") expectedChildren.set(entry.relativePath, []);
  }
  for (const entry of identity.protectedEntries) {
    if (entry.relativePath === "") continue;
    const parent = path.posix.dirname(entry.relativePath);
    const parentRelative = parent === "." ? "" : parent;
    if (entries.get(parentRelative)?.kind !== "directory") {
      throw new Error("workflow execution snapshot capability protected tree has a missing parent directory");
    }
    expectedChildren.get(parentRelative)!.push(path.posix.basename(entry.relativePath));
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
      const expectedNames = expectedChildren.get(directory.relativePath)!.sort();
      const accessNames = fs.readdirSync(accessPath).sort();
      const lexicalNames = fs.readdirSync(lexicalPath).sort();
      if (
        JSON.stringify(accessNames) !== JSON.stringify(expectedNames) ||
        JSON.stringify(lexicalNames) !== JSON.stringify(expectedNames)
      ) {
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
    assertProtectedFileCurrent(accessPath, lexicalPath, entry, digest);
  }
  assertDirectories();
  return captureProtectedTreeChangeTokens(identity, accessRoot, rootDescriptor);
}

function captureProtectedTreeChangeTokens(
  identity: Readonly<WorkflowExecutionSnapshotIdentity>,
  accessRoot: string,
  rootDescriptor: number | undefined
): string[] {
  return identity.protectedEntries.map((entry) => {
    const accessPath = protectedEntryPath(accessRoot, entry.relativePath);
    const lexicalPath = protectedEntryPath(identity.root, entry.relativePath);
    const access =
      entry.relativePath === "" && rootDescriptor !== undefined
        ? fs.fstatSync(rootDescriptor, { bigint: true })
        : fs.lstatSync(accessPath, { bigint: true });
    const lexical = fs.lstatSync(lexicalPath, { bigint: true });
    return `${entry.relativePath}\0${protectedEntryChangeToken(access)}\0${protectedEntryChangeToken(lexical)}`;
  });
}

function protectedEntryChangeToken(stat: fs.BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs]
    .map((value) => value.toString())
    .join(":");
}

function assertMatchingChangeTokens(expected: readonly string[], current: readonly string[]): void {
  if (expected.length !== current.length || expected.some((token, index) => token !== current[index])) {
    throw new Error("workflow execution snapshot changed at the controller command boundary");
  }
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
  expected: WorkflowExecutionSnapshotProtectedFile,
  digest: ((descriptor: number) => string) | undefined
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
    const sha256 = digest?.(descriptor);
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
      (sha256 !== undefined && sha256 !== expected.sha256)
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
  for (;;) {
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) return hash.digest("hex");
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
}

function closeFileDescriptors(descriptors: readonly number[]): void {
  let failure: unknown;
  for (const descriptor of descriptors) {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

function openDirectoryWhenSupported(directory: string): number | undefined {
  return process.platform === "win32"
    ? undefined
    : fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_DIRECTORY ?? 0));
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
  for (const candidate of [`/proc/self/fd/${descriptor}`, `/dev/fd/${descriptor}`]) {
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
    return fs.statSync(candidate).isDirectory() ? candidate : undefined;
  } catch {
    return undefined;
  }
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
