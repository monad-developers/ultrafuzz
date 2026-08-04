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
  env: Record<string, string | undefined> | undefined
): WorkflowExecutionSnapshotAnchor | undefined {
  const identity = (env as CapableEnvironment | undefined)?.[WORKFLOW_EXECUTION_SNAPSHOT_CAPABILITY];
  if (identity === undefined) return undefined;

  assertCanonicalIdentity(identity);
  const snapshotsDescriptor = openDirectoryNoFollow(identity.snapshotsRoot);
  let snapshotDescriptor: number | undefined;
  try {
    assertDescriptorIdentity(
      snapshotsDescriptor,
      identity.snapshotsRootDevice,
      identity.snapshotsRootInode,
      "workflow execution snapshots"
    );
    const snapshotsDescriptorPath = requiredDirectoryDescriptorPath(
      snapshotsDescriptor,
      identity.snapshotsRootDevice,
      identity.snapshotsRootInode,
      "workflow execution snapshots"
    );
    snapshotDescriptor = openDirectoryNoFollow(path.join(snapshotsDescriptorPath, path.basename(identity.root)));
    assertDescriptorIdentity(
      snapshotDescriptor,
      identity.snapshotDevice,
      identity.snapshotInode,
      "workflow execution snapshot"
    );
    const controllerSnapshotPath = requiredControllerDirectoryDescriptorPath(
      snapshotDescriptor,
      identity.snapshotDevice,
      identity.snapshotInode,
      "workflow execution snapshot"
    );

    let closed = false;
    const assertCurrent = (): void => {
      if (closed) throw new Error("workflow execution snapshot anchor is already closed");
      assertDescriptorIdentity(
        snapshotsDescriptor,
        identity.snapshotsRootDevice,
        identity.snapshotsRootInode,
        "workflow execution snapshots"
      );
      assertDescriptorIdentity(
        snapshotDescriptor!,
        identity.snapshotDevice,
        identity.snapshotInode,
        "workflow execution snapshot"
      );
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
      rewriteControllerValue: (value) => rewriteControllerValue(value, identity.root, controllerSnapshotPath),
      close: () => {
        if (closed) return;
        closed = true;
        closeFileDescriptors([snapshotDescriptor!, snapshotsDescriptor]);
      }
    };
  } catch (error) {
    try {
      closeFileDescriptors([...(snapshotDescriptor === undefined ? [] : [snapshotDescriptor]), snapshotsDescriptor]);
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

function requiredDirectoryDescriptorPath(descriptor: number, device: number, inode: number, label: string): string {
  const candidates = process.platform === "win32" ? [] : [`/proc/self/fd/${descriptor}`, `/dev/fd/${descriptor}`];
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory() && stat.dev === device && stat.ino === inode) return candidate;
    } catch {
      // Continue to the next platform descriptor path.
    }
  }
  throw new Error(`${label} cannot be anchored without directory-descriptor paths`);
}

function requiredControllerDirectoryDescriptorPath(
  descriptor: number,
  device: number,
  inode: number,
  label: string
): string {
  if (process.platform !== "win32") {
    const candidate = `/proc/${process.pid}/fd/${descriptor}`;
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory() && stat.dev === device && stat.ino === inode) return candidate;
    } catch {
      // Fall through to the explicit unsupported-platform error.
    }
  }
  throw new Error(`${label} cannot be passed safely without controller directory-descriptor paths`);
}
