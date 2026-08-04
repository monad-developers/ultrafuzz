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
}

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
  Object.defineProperty(env, WORKFLOW_EXECUTION_SNAPSHOT_CAPABILITY, {
    configurable: false,
    enumerable: true,
    writable: false,
    value: Object.freeze({ ...identity })
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
