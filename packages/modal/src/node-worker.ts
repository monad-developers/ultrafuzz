import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  artifactSchemaDirectory,
  artifactSchemaRegistry,
  artifactValidatorSmokeFixturePath,
  assertArtifactVerificationMarkerSemantics,
  parseJsonValidatorPreflightSuccessEnvelope,
  parseStrictJsonBytes,
  validateArtifactVerificationMarker,
  type ArtifactVerificationMarker
} from "@ultrafuzz/artifacts";

import {
  modalNodeContinuationIdentity,
  modalAttemptVerificationMarkerName,
  modalNodeDispatchFingerprint,
  modalNodeHandoffContentFingerprint,
  parseModalNodeWorkerInput,
  readModalExecutionDependencyClosure,
  verifyModalExecutionSnapshotClosure
} from "./node-provider.js";
import {
  MODAL_NODE_CHECKPOINT_INDEX_SCHEMA_ID,
  MODAL_NODE_CHECKPOINT_SCHEMA_ID,
  MODAL_NODE_INPUT_SCHEMA_ID,
  MODAL_NODE_RESTORE_SCHEMA_ID,
  MODAL_NODE_RESULT_SCHEMA_ID,
  MODAL_NODE_WORKER_ERROR_SCHEMA_ID,
  type StrictModalNodeCheckpointDocument,
  type StrictModalNodeCheckpointIndexDocument,
  type StrictModalNodeCheckpointStage,
  type StrictModalNodeInputDocument,
  type StrictModalNodeResultDocument,
  type StrictModalNodeRestoreDocument,
  type StrictModalNodeWorkerErrorDocument
} from "./modal-contracts.js";
import { readModalDocument, serializeModalDocument, writeModalDocumentAtomic } from "./modal-documents.js";
import { extractSafeTarArchive, sha256File } from "./safe-archive.js";

const TRUSTED_MOUNT_ROOT = "/data";
const DURABLE_WORKSPACE_DIRECTORY = "workspace";
const DURABLE_INPUT_DIRECTORY = "input";
const DURABLE_CHECKPOINT_DIRECTORY = "checkpoints";
const DURABLE_CHECKPOINT_INDEX = "index.json";
const DURABLE_RESTORE_MARKER = "restore.json";
const ARTIFACT_VERIFICATION_DIRECTORY = ".ultrafuzz-verification";
const MAX_VERIFICATION_MARKER_BYTES = 4 * 1024 * 1024;

type DurableCheckpointStage = StrictModalNodeCheckpointStage;
type DurableCheckpointRecord = StrictModalNodeCheckpointDocument;
type DurableCheckpointIndex = StrictModalNodeCheckpointIndexDocument;

export interface DurableNodeWorkspace {
  projectRoot: string;
  /**
   * The canonical attempt root `resolveDurableDataRoot` already validated, for worker-owned
   * filesystem work.
   *
   * A trusted provider mount such as Modal filesystem-v2's `/data` is an alias, so the lexical
   * `--data-root` and this canonical root differ only in that provider-owned prefix. Every
   * worker-owned staging, lock, archive, publication, and sync operation runs against this root so
   * the unweakened destination guard, which requires `realpath(target) === path.resolve(target)`,
   * accepts ordinary directories below the mount while still rejecting any alias injected under it.
   * Controller-facing identifiers stay lexical; see `initializeDurableNodeWorkspace`.
   */
  attemptRoot: string;
  checkpointIndex: string;
  input: ReturnType<typeof parseModalNodeWorkerInput>;
  hasCompletedCheckpoint: boolean;
  recordCheckpoint(stage: DurableCheckpointStage, error?: unknown): Promise<DurableCheckpointRecord>;
}

async function main(): Promise<void> {
  const requestPath = requiredOption("--request");
  const archivePath = requiredOption("--project-archive");
  const dataRoot = requiredOption("--data-root");
  const requestedInput = readModalDocument(requestPath, MODAL_NODE_INPUT_SCHEMA_ID)
    .value as StrictModalNodeInputDocument;
  let durableWorkspace: DurableNodeWorkspace | undefined;
  let publishing: string | undefined;
  try {
    durableWorkspace = await initializeDurableNodeWorkspace(dataRoot, archivePath, requestedInput);
    const input = durableWorkspace.input;
    const projectRoot = durableWorkspace.projectRoot;
    const attemptRoot = durableWorkspace.attemptRoot;
    if (!durableWorkspace.hasCompletedCheckpoint) {
      await durableWorkspace.recordCheckpoint("prepared");
    }
    syncDurableData(projectRoot);
    preflightModalJsonValidator();
    const localRunId = `${input.run_id}-${crypto.createHash("sha256").update(input.task_id).digest("hex").slice(0, 12)}`;
    if (!durableWorkspace.hasCompletedCheckpoint) {
      await durableWorkspace.recordCheckpoint("running");
      syncDurableData(projectRoot);
      await runDurableWorkflow(projectRoot, localRunId, input);
    }

    const artifactDir = anchoredProjectPath(projectRoot, input.artifact_dir);
    const workspaceDir = anchoredProjectPath(projectRoot, input.workspace_dir);
    const completedCheckpoint = await durableWorkspace.recordCheckpoint("completed");
    syncDurableData(projectRoot);
    cleanupStalePublicationDirectories(attemptRoot);
    publishing = path.join(attemptRoot, `.result-publishing-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
    fs.mkdirSync(publishing, { recursive: true, mode: 0o700 });
    const staging = path.join(publishing, "bundle");
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    const stagedMarker = copyAttemptVerificationMarker(projectRoot, input, path.join(staging, "verification"));
    copyVerifiedPublishedEvidenceTree(artifactDir, path.join(staging, "artifacts"), stagedMarker, input.attempt_id);
    const sourceProofRoot = anchoredProjectPath(projectRoot, path.join(input.run_root, "source-proofs"));
    assertSafeDirectoryTarget(sourceProofRoot);
    for (const suffix of [".json", ".invariant.json"] as const) {
      const sourceProof = path.join(sourceProofRoot, `${input.attempt_id}${suffix}`);
      if (!fs.existsSync(sourceProof)) continue;
      const proofStat = fs.lstatSync(sourceProof);
      if (!proofStat.isFile() || proofStat.isSymbolicLink() || proofStat.nlink !== 1) {
        throw new Error("cloud publication source proof is unsafe");
      }
      const proofDestination = path.join(staging, "source-proofs", `${input.attempt_id}${suffix}`);
      fs.mkdirSync(path.dirname(proofDestination), { recursive: true, mode: 0o700 });
      fs.copyFileSync(sourceProof, proofDestination);
    }
    if (fs.existsSync(workspaceDir)) {
      copySafeTree(workspaceDir, path.join(staging, "workspace"));
    }
    const artifactArchive = path.join(publishing, "artifacts.tgz");
    await runChecked("archive-results", "tar", ["-czf", artifactArchive, "-C", staging, "."], projectRoot);
    const digest = crypto.createHash("sha256").update(fs.readFileSync(artifactArchive)).digest("hex");
    fs.writeFileSync(
      path.join(publishing, "result.json"),
      `${JSON.stringify({
        schema_version:
          resultPublicationMode === "legacy-markerless-v1"
            ? "ultrafuzz.modal.node-result.v1"
            : "ultrafuzz.modal.node-result.v2",
        status: "succeeded",
        artifact_archive: path.posix.join(dataRoot, "artifacts.tgz"),
        artifact_sha256: digest,
        storage_lineage: `${input.run_id}/${input.attempt_id}/${input.execution_generation}`,
        // The controller re-derives this from the dispatch it sent, so a published bundle can only be
        // adopted by the logical dispatch that actually produced it.
        logical_dispatch_fingerprint: completedCheckpoint.logical_dispatch_fingerprint,
        durable_checkpoint: path.posix.join(
          dataRoot,
          DURABLE_CHECKPOINT_DIRECTORY,
          `${completedCheckpoint.checkpoint_id}.json`
        ),
        durable_checkpoint_index: path.posix.join(dataRoot, DURABLE_CHECKPOINT_DIRECTORY, DURABLE_CHECKPOINT_INDEX)
      })}\n`,
      { mode: 0o600 }
    );
    const publicationLock = path.join(attemptRoot, ".result-publishing.lock");
    let lockFd: number | undefined;
    let lockIdentity: { dev: number; ino: number } | undefined;
    try {
      try {
        lockFd = fs.openSync(publicationLock, "wx", 0o600);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        const lockStat = fs.lstatSync(publicationLock);
        let ownerAlive = false;
        try {
          const ownerPid = Number(fs.readFileSync(publicationLock, "utf8").trim());
          if (Number.isSafeInteger(ownerPid) && ownerPid > 0) {
            process.kill(ownerPid, 0);
            ownerAlive = true;
          }
        } catch {
          ownerAlive = false;
        }
        if (ownerAlive || Date.now() - lockStat.mtimeMs < 60 * 60 * 1000) throw error;
        fs.unlinkSync(publicationLock);
        lockFd = fs.openSync(publicationLock, "wx", 0o600);
      }
      fs.writeFileSync(lockFd, `${process.pid}\n`);
      const lockStat = fs.fstatSync(lockFd);
      lockIdentity = { dev: lockStat.dev, ino: lockStat.ino };
      replacePublishedFile(artifactArchive, path.join(attemptRoot, "artifacts.tgz"));
      replacePublishedFile(path.join(publishing, "result.json"), path.join(attemptRoot, "result.json"));
    } finally {
      if (lockFd !== undefined) {
        fs.closeSync(lockFd);
        try {
          const currentLock = fs.lstatSync(publicationLock);
          if (
            lockIdentity !== undefined &&
            currentLock.dev === lockIdentity.dev &&
            currentLock.ino === lockIdentity.ino
          ) {
            fs.unlinkSync(publicationLock);
          }
        } catch {
          // Preserve the publication result if lock cleanup races with a failed worker.
        }
      }
    }
    fs.rmSync(publishing, { recursive: true, force: true });
    publishing = undefined;
    syncDurableData(attemptRoot);
  } catch (error) {
    if (durableWorkspace !== undefined) {
      try {
        await durableWorkspace.recordCheckpoint("failed", error);
        syncDurableData(durableWorkspace.projectRoot);
      } catch {
        // Preserve the original worker failure; the durable workspace itself remains mounted on the Volume.
      }
    }
    if (publishing !== undefined) fs.rmSync(publishing, { recursive: true, force: true });
    throw error;
  }
}

export function preflightModalJsonValidator(cliPath = "/usr/local/bin/ultrafuzz"): void {
  assertRootOwnedReadOnlyFile(cliPath, "Modal Ultrafuzz launcher");
  const findings = artifactSchemaRegistry().find((entry) => entry.filename === "findings.schema.json");
  if (findings === undefined) throw new Error("Modal validator preflight schema is not registered");
  const schemaPath = path.join(artifactSchemaDirectory(), findings.filename);
  assertRootOwnedReadOnlyFile(schemaPath, "Modal validator schema");
  let stdout: string;
  try {
    stdout = execFileSync(
      cliPath,
      ["json", "validate", "--schema", schemaPath, "--file", artifactValidatorSmokeFixturePath(), "--json"],
      { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 15_000, windowsHide: true }
    );
  } catch (error) {
    throw new Error(
      `Modal JSON validator preflight failed: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error
      }
    );
  }
  try {
    parseJsonValidatorPreflightSuccessEnvelope(Buffer.from(stdout, "utf8"));
  } catch (error) {
    throw new Error("Modal JSON validator preflight returned an invalid success envelope", { cause: error });
  }
}

function assertRootOwnedReadOnlyFile(filePath: string, label: string): void {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    throw new Error(`${label} must be a root-owned, non-writable regular file`);
  }
}
function sealedSmithersExecutable(snapshotRoot: string): string {
  const closure = readModalExecutionDependencyClosure(snapshotRoot);
  const smithers = regularSnapshotFile(snapshotRoot, closure.smithersBin, "sealed Smithers executable");
  const stat = fs.lstatSync(smithers);
  if ((stat.mode & 0o111) === 0) throw new Error("sealed Smithers executable is not executable");
  return smithers;
}

function trustedCloudBunExecutable(): string {
  const executable = "/usr/local/bin/bun";
  assertRootOwnedReadOnlyFile(executable, "Modal Bun interpreter");
  return executable;
}

function sealedSnapshotModuleUrl(snapshotRoot: string, name: "artifacts" | "runtime"): string {
  return pathToFileURL(
    regularSnapshotFile(
      snapshotRoot,
      path.posix.join("modules", "@ultrafuzz", name, "dist", "index.js"),
      `sealed ${name} module`
    )
  ).href;
}

function regularSnapshotFile(snapshotRoot: string, relativePath: string, label: string): string {
  const candidate = snapshotRelativePath(snapshotRoot, relativePath, label);
  let parent = snapshotRoot;
  for (const part of relativePath.split("/").slice(0, -1)) {
    parent = path.join(parent, part);
    const parentStat = fs.lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw new Error(`${label} crosses an unsafe snapshot directory`);
    }
  }
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${label} is unsafe`);
  }
  return candidate;
}

function snapshotRelativePath(snapshotRoot: string, relativePath: string, label: string): string {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath === "." ||
    relativePath.startsWith("../")
  ) {
    throw new Error(`${label} path is invalid`);
  }
  const root = path.resolve(snapshotRoot);
  const candidate = path.resolve(root, ...relativePath.split("/"));
  if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} path escapes the execution snapshot`);
  }
  return candidate;
}

function materializeExecutionSnapshotLinks(
  projectRoot: string,
  input: ReturnType<typeof parseModalNodeWorkerInput>
): void {
  const snapshotRoot = anchoredProjectPath(projectRoot, input.execution_snapshot_root);
  const closure = readModalExecutionDependencyClosure(snapshotRoot);
  const root = openWorkerSnapshotRoot(snapshotRoot);
  try {
    for (const [relativeLink, relativeTarget] of [...closure.links].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    )) {
      const parent = openWorkerSnapshotDirectory(root, path.posix.dirname(relativeLink), "snapshot dependency parent");
      let target: ReturnType<typeof openWorkerSnapshotDirectory> | undefined;
      try {
        target = openWorkerSnapshotDirectory(root, relativeTarget, "snapshot dependency target");
        parent.assertCurrent();
        target.assertCurrent();
        const linkPath = path.join(parent.directory.accessPath, path.posix.basename(relativeLink));
        const expectedTarget = path.posix.relative(path.posix.dirname(relativeLink), relativeTarget);
        const existing = lstatWorkerPath(linkPath);
        if (existing === undefined) fs.symlinkSync(expectedTarget, linkPath, "dir");
        const linkStat = fs.lstatSync(linkPath, { bigint: true });
        const followed = fs.statSync(linkPath, { bigint: true });
        if (
          !linkStat.isSymbolicLink() ||
          fs.readlinkSync(linkPath) !== expectedTarget ||
          !sameWorkerIdentity(followed, target.directory.opened)
        ) {
          throw new Error(`snapshot dependency link is unsafe: ${relativeLink}`);
        }
      } finally {
        target?.close();
        parent.close();
      }
    }
    assertWorkerSnapshotRootCurrent(root);
  } finally {
    fs.closeSync(root.descriptor);
  }
}

function sealCloudExecutionSnapshot(projectRoot: string, input: ReturnType<typeof parseModalNodeWorkerInput>): void {
  const snapshotRoot = anchoredProjectPath(projectRoot, input.execution_snapshot_root);
  const executablePaths = readModalExecutionDependencyClosure(snapshotRoot).executablePaths;
  const root = openWorkerSnapshotRoot(snapshotRoot);
  try {
    sealOpenedSnapshotDirectory(root, "", executablePaths);
    assertWorkerSnapshotRootCurrent(root);
  } finally {
    fs.closeSync(root.descriptor);
  }
}

interface OpenedWorkerSnapshotDirectory {
  descriptor: number;
  accessPath: string;
  pathname: string;
  opened: fs.BigIntStats;
  rootPath: string;
}

function openWorkerSnapshotRoot(snapshotRoot: string): OpenedWorkerSnapshotDirectory {
  const rootPath = path.resolve(snapshotRoot);
  const lexical = fs.lstatSync(rootPath, { bigint: true });
  if (!lexical.isDirectory() || lexical.isSymbolicLink() || fs.realpathSync(rootPath) !== rootPath) {
    throw new Error("cloud execution snapshot root is unsafe");
  }
  const descriptor = fs.openSync(
    rootPath,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0)
  );
  const opened = fs.fstatSync(descriptor, { bigint: true });
  if (!opened.isDirectory() || !sameWorkerIdentity(opened, lexical)) {
    fs.closeSync(descriptor);
    throw new Error("cloud execution snapshot root changed while opening");
  }
  try {
    return {
      descriptor,
      accessPath: workerDirectoryDescriptorPath(descriptor, opened),
      pathname: rootPath,
      opened,
      rootPath
    };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function openWorkerSnapshotDirectory(
  root: OpenedWorkerSnapshotDirectory,
  relativePath: string,
  label: string
): { directory: OpenedWorkerSnapshotDirectory; assertCurrent(): void; close(): void } {
  if (relativePath === ".") {
    return { directory: root, assertCurrent: () => assertWorkerSnapshotRootCurrent(root), close: () => undefined };
  }
  const openedDirectories: OpenedWorkerSnapshotDirectory[] = [];
  let parent = root;
  try {
    for (const part of relativePath.split("/")) {
      if (!/^[A-Za-z0-9@][A-Za-z0-9@._-]*$/u.test(part)) throw new Error(`${label} path is invalid`);
      const pathname = path.join(parent.accessPath, part);
      const lexical = fs.lstatSync(pathname, { bigint: true });
      if (!lexical.isDirectory() || lexical.isSymbolicLink()) throw new Error(`${label} is unsafe`);
      const descriptor = fs.openSync(
        pathname,
        fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0)
      );
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!opened.isDirectory() || !sameWorkerIdentity(opened, lexical)) {
        fs.closeSync(descriptor);
        throw new Error(`${label} changed while opening`);
      }
      let directory: OpenedWorkerSnapshotDirectory;
      try {
        directory = {
          descriptor,
          accessPath: workerDirectoryDescriptorPath(descriptor, opened),
          pathname,
          opened,
          rootPath: root.rootPath
        };
      } catch (error) {
        fs.closeSync(descriptor);
        throw error;
      }
      openedDirectories.push(directory);
      parent = directory;
    }
    return {
      directory: parent,
      assertCurrent: () => {
        assertWorkerSnapshotRootCurrent(root);
        for (const directory of openedDirectories) assertOpenedWorkerDirectoryCurrent(directory);
      },
      close: () => {
        for (const directory of openedDirectories.reverse()) fs.closeSync(directory.descriptor);
      }
    };
  } catch (error) {
    for (const directory of openedDirectories.reverse()) fs.closeSync(directory.descriptor);
    throw error;
  }
}

function sealOpenedSnapshotDirectory(
  directory: OpenedWorkerSnapshotDirectory,
  relativeDirectory: string,
  executablePaths: ReadonlySet<string>
): void {
  assertOpenedWorkerDirectoryCurrent(directory);
  const beforeNames = fs.readdirSync(directory.accessPath).sort();
  for (const name of beforeNames) {
    assertOpenedWorkerDirectoryCurrent(directory);
    const pathname = path.join(directory.accessPath, name);
    const relative = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
    const lexical = fs.lstatSync(pathname, { bigint: true });
    if (lexical.isDirectory() && !lexical.isSymbolicLink()) {
      const descriptor = fs.openSync(
        pathname,
        fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0)
      );
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!opened.isDirectory() || !sameWorkerIdentity(opened, lexical)) {
        fs.closeSync(descriptor);
        throw new Error(`cloud execution snapshot directory changed while opening: ${relative}`);
      }
      let child: OpenedWorkerSnapshotDirectory;
      try {
        child = {
          descriptor,
          accessPath: workerDirectoryDescriptorPath(descriptor, opened),
          pathname,
          opened,
          rootPath: directory.rootPath
        };
      } catch (error) {
        fs.closeSync(descriptor);
        throw error;
      }
      try {
        sealOpenedSnapshotDirectory(child, relative, executablePaths);
      } finally {
        fs.closeSync(descriptor);
      }
    } else if (lexical.isFile() && !lexical.isSymbolicLink()) {
      sealOpenedSnapshotFile(pathname, lexical, executablePaths.has(relative) ? 0o500 : 0o400, relative);
    } else if (!lexical.isSymbolicLink()) {
      throw new Error(`cloud execution snapshot contains a special entry: ${relative}`);
    }
  }
  if (JSON.stringify(fs.readdirSync(directory.accessPath).sort()) !== JSON.stringify(beforeNames)) {
    throw new Error(`cloud execution snapshot directory changed while sealing: ${relativeDirectory || "."}`);
  }
  assertOpenedWorkerDirectoryCurrent(directory);
  fs.fchmodSync(directory.descriptor, 0o500);
  const completed = fs.fstatSync(directory.descriptor, { bigint: true });
  const lexicalCompleted = fs.lstatSync(directory.pathname, { bigint: true });
  if (
    !sameWorkerIdentity(completed, directory.opened) ||
    !sameWorkerIdentity(completed, lexicalCompleted) ||
    (completed.mode & 0o777n) !== 0o500n
  ) {
    throw new Error(`cloud execution snapshot directory changed while sealing: ${relativeDirectory || "."}`);
  }
}

function sealOpenedSnapshotFile(pathname: string, lexical: fs.BigIntStats, mode: number, relativePath: string): void {
  const descriptor = fs.openSync(pathname, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(pathname, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      !sameWorkerIdentity(opened, lexical) ||
      !sameWorkerIdentity(opened, current)
    ) {
      throw new Error(`cloud execution snapshot file changed while opening: ${relativePath}`);
    }
    fs.fchmodSync(descriptor, mode);
    const completed = fs.fstatSync(descriptor, { bigint: true });
    const lexicalCompleted = fs.lstatSync(pathname, { bigint: true });
    if (
      !sameWorkerIdentity(completed, opened) ||
      !sameWorkerIdentity(completed, lexicalCompleted) ||
      (completed.mode & 0o777n) !== BigInt(mode)
    ) {
      throw new Error(`cloud execution snapshot file changed while sealing: ${relativePath}`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertOpenedWorkerDirectoryCurrent(directory: OpenedWorkerSnapshotDirectory): void {
  const completed = fs.fstatSync(directory.descriptor, { bigint: true });
  const lexical = fs.lstatSync(directory.pathname, { bigint: true });
  if (
    !completed.isDirectory() ||
    !sameWorkerIdentity(completed, directory.opened) ||
    !sameWorkerIdentity(completed, lexical)
  ) {
    throw new Error("cloud execution snapshot directory changed during descriptor ownership");
  }
}

function assertWorkerSnapshotRootCurrent(root: OpenedWorkerSnapshotDirectory): void {
  assertOpenedWorkerDirectoryCurrent(root);
  if (fs.realpathSync(root.rootPath) !== root.rootPath) {
    throw new Error("cloud execution snapshot root changed during descriptor ownership");
  }
}

function workerDirectoryDescriptorPath(descriptor: number, expected: fs.BigIntStats): string {
  for (const candidate of [`/proc/self/fd/${descriptor}`, `/dev/fd/${descriptor}`]) {
    try {
      if (sameWorkerIdentity(fs.statSync(candidate, { bigint: true }), expected)) return candidate;
    } catch {
      // Try the next platform descriptor path.
    }
  }
  throw new Error("cloud execution snapshot has no descriptor anchor");
}

function workerProcessDirectoryDescriptorPath(descriptor: number, expected: fs.BigIntStats): string {
  const candidate = `/proc/${process.pid}/fd/${descriptor}`;
  try {
    const lexical = fs.lstatSync(candidate, { bigint: true });
    const followed = fs.statSync(candidate, { bigint: true });
    if (lexical.isSymbolicLink() && sameWorkerIdentity(followed, expected)) return candidate;
  } catch {
    // Modal's node worker is Linux-based and requires procfs for a child-visible descriptor anchor.
  }
  throw new Error("cloud execution snapshot has no child-visible descriptor anchor");
}

function sameWorkerIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink;
}

function lstatWorkerPath(pathname: string): fs.BigIntStats | undefined {
  try {
    return fs.lstatSync(pathname, { bigint: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function cleanupStalePublicationDirectories(dataRoot: string): void {
  const now = Date.now();
  for (const entry of fs.readdirSync(dataRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\.result-publishing-[0-9]+-[0-9a-f]{16}$/u.test(entry.name)) continue;
    const candidate = path.join(dataRoot, entry.name);
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || fs.realpathSync(candidate) !== candidate) {
      throw new Error("cloud publication staging directory is unsafe");
    }
    if (now - stat.mtimeMs > 60 * 60 * 1000) {
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  }
}

export async function runDurableWorkflow(
  projectRoot: string,
  localRunId: string,
  input: ReturnType<typeof parseModalNodeWorkerInput>,
  bunExecutable: () => string = trustedCloudBunExecutable
): Promise<void> {
  const canonicalSnapshotRoot = anchoredProjectPath(projectRoot, input.execution_snapshot_root);
  const canonicalWorkflowPath = anchoredProjectPath(projectRoot, input.workflow_path);
  const workflowRelativePath = path.relative(canonicalSnapshotRoot, canonicalWorkflowPath).split(path.sep).join("/");
  const openedSnapshotRoot = openWorkerSnapshotRoot(canonicalSnapshotRoot);
  try {
    const snapshotAccessRoot = workerProcessDirectoryDescriptorPath(
      openedSnapshotRoot.descriptor,
      openedSnapshotRoot.opened
    );
    verifyOpenedExecutionSnapshot(openedSnapshotRoot, snapshotAccessRoot, projectRoot, input);
    const bun = bunExecutable();
    const smithers = sealedSmithersExecutable(snapshotAccessRoot);
    const confinement = regularSnapshotFile(
      snapshotAccessRoot,
      "controls/bun-module-confinement.js",
      "sealed Bun module confinement"
    );
    const bunArguments = [
      `--config=${regularSnapshotFile(snapshotAccessRoot, "controls/bunfig.toml", "sealed Bun config")}`,
      "--no-env-file",
      "--no-install",
      "--no-addons",
      "--preserve-symlinks",
      "--preserve-symlinks-main",
      `--preload=${confinement}`,
      smithers
    ];
    const workflowPath = regularSnapshotFile(snapshotAccessRoot, workflowRelativePath, "sealed cloud workflow");
    const environment = {
      PATH: ["/usr/local/bin", process.env.PATH ?? ""].filter((entry) => entry.length > 0).join(path.delimiter),
      ULTRAFUZZ_CLOUD_WORKER: "1",
      ULTRAFUZZ_ARTIFACTS_MODULE: sealedSnapshotModuleUrl(snapshotAccessRoot, "artifacts"),
      ULTRAFUZZ_RUNTIME_MODULE: sealedSnapshotModuleUrl(snapshotAccessRoot, "runtime"),
      ULTRAFUZZ_CONFIG_PATH: regularSnapshotFile(snapshotAccessRoot, "controls/ultrafuzz.toml", "sealed cloud config"),
      ULTRAFUZZ_WORKFLOW_PERSISTED_PATH: canonicalWorkflowPath
    };
    try {
      await runChecked(
        "resume-workflow",
        bun,
        [...bunArguments, ...workflowCommandArguments(workflowPath, projectRoot, localRunId, input, true)],
        projectRoot,
        environment
      );
    } catch (error) {
      if (isMissingWorkflowRun(error)) {
        await runChecked(
          "run-workflow",
          smithers,
          workflowCommandArguments(workflowPath, projectRoot, localRunId, input, false),
          projectRoot,
          environment
        );
      } else {
        const retryTaskId = await selectedInnerRetriesExhaustedTaskId(
          smithers,
          projectRoot,
          localRunId,
          [input.selected_task.id, input.selected_task.preparationId, input.selected_task.verifierId],
          environment
        );
        if (retryTaskId === undefined) throw error;
        // Unlike `up`, retry-task has no separate execution and persistence workflow paths. Give it
        // the verified physical identity and prevent the sealed launcher from rewriting that identity
        // back through the descriptor used only while executing ordinary run/resume commands.
        const retryEnvironment: Record<string, string | undefined> = {
          ...environment,
          ULTRAFUZZ_WORKFLOW_PERSISTED_PATH: undefined
        };
        await runChecked(
          "retry-workflow-task",
          smithers,
          workflowRetryTaskCommandArguments(canonicalWorkflowPath, localRunId, retryTaskId),
          projectRoot,
          retryEnvironment
        );
      }
    }
    verifyOpenedExecutionSnapshot(openedSnapshotRoot, snapshotAccessRoot, projectRoot, input);
  } finally {
    fs.closeSync(openedSnapshotRoot.descriptor);
  }
}

function verifyOpenedExecutionSnapshot(
  openedSnapshotRoot: OpenedWorkerSnapshotDirectory,
  snapshotAccessRoot: string,
  projectRoot: string,
  input: ReturnType<typeof parseModalNodeWorkerInput>
): void {
  assertWorkerSnapshotRootCurrent(openedSnapshotRoot);
  verifyModalExecutionSnapshotClosure(projectRoot, input, {
    requireSealedPermissions: true,
    snapshotAccessRoot
  });
  assertWorkerSnapshotRootCurrent(openedSnapshotRoot);
}

export function workflowCommandArguments(
  workflowPath: string,
  projectRoot: string,
  localRunId: string,
  input: ReturnType<typeof parseModalNodeWorkerInput>,
  resume: boolean
): string[] {
  return [
    "up",
    workflowPath,
    ...(resume ? ["--resume", "--force"] : []),
    "--run-id",
    localRunId,
    "--max-concurrency",
    "1",
    "--root",
    projectRoot,
    "--input",
    JSON.stringify({
      schema_version: "ultrafuzz.smithers.workflow.v1",
      cloud_worker: true,
      task_id: input.task_id,
      attempt_id: input.attempt_id,
      // The relocated worker cannot rederive the generation it runs under: the controller's evidence
      // never enters the handoff archive, so the validated dispatch carries the identity forward.
      execution_generation: input.execution_generation,
      // The controller-materialized selected task is the worker's only view of the compiled graph.
      selected_task: input.selected_task,
      ...(input.operator_prompt === undefined ? {} : { operator_prompt: input.operator_prompt })
    }),
    "--format",
    "json"
  ];
}

export function workflowRetryTaskCommandArguments(workflowPath: string, localRunId: string, taskId: string): string[] {
  return [
    "retry-task",
    workflowPath,
    "--run-id",
    localRunId,
    "--node-id",
    taskId,
    "--iteration",
    "0",
    "--force",
    "--accept-workflow-change",
    "--format",
    "json"
  ];
}

function isMissingWorkflowRun(error: unknown): boolean {
  return (
    error instanceof CloudWorkerCommandError &&
    /\bRUN_NOT_FOUND\b|\bRun not found\b/u.test(`${error.stdout}\n${error.stderr}`)
  );
}

async function selectedInnerRetriesExhaustedTaskId(
  smithers: string,
  projectRoot: string,
  localRunId: string,
  taskIds: readonly string[],
  environment: Record<string, string>
): Promise<string | undefined> {
  try {
    const diagnosis = await runChecked(
      "diagnose-resume-workflow",
      smithers,
      ["why", localRunId, "--format", "json"],
      projectRoot,
      environment,
      64 * 1024
    );
    const parsed = JSON.parse(diagnosis.stdout) as unknown;
    const data = isRecord(parsed) && isRecord(parsed.data) ? parsed.data : parsed;
    if (!isRecord(data) || !Array.isArray(data.blockers)) return undefined;
    const eligibleTaskIds = new Set(taskIds);
    for (const blocker of data.blockers) {
      if (!isRecord(blocker) || blocker.kind !== "retries-exhausted") continue;
      const blockedTaskId = typeof blocker.nodeId === "string" ? blocker.nodeId : blocker.node_id;
      if (typeof blockedTaskId === "string" && eligibleTaskIds.has(blockedTaskId)) return blockedTaskId;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function initializeDurableNodeWorkspace(
  dataRoot: string,
  archivePath: string,
  requestedInput: ReturnType<typeof parseModalNodeWorkerInput>,
  trustedMountRoot = TRUSTED_MOUNT_ROOT
): Promise<DurableNodeWorkspace> {
  const descriptorFreeInput = { ...requestedInput } as Record<string, unknown>;
  delete descriptorFreeInput.execution_snapshot_source_root;
  requestedInput = parseModalNodeWorkerInput(descriptorFreeInput);
  const root = resolveDurableDataRoot(dataRoot, trustedMountRoot);
  const projectRoot = path.join(root, DURABLE_WORKSPACE_DIRECTORY);
  const handoffDirectory = path.join(root, DURABLE_INPUT_DIRECTORY);
  const handoffArchive = path.join(handoffDirectory, "project.tgz");
  const checkpointsDirectory = path.join(root, DURABLE_CHECKPOINT_DIRECTORY);
  const checkpointIndex = path.join(checkpointsDirectory, DURABLE_CHECKPOINT_INDEX);
  // The controller validates the published result, its durable checkpoint, and the checkpoint index
  // against the lexical data root it dispatched, so those recorded identifiers stay lexical even
  // though every path above is the canonical one the trusted-mount check produced.
  const workspaceIdentity = path.posix.join(dataRoot, DURABLE_WORKSPACE_DIRECTORY);
  const handoffArchiveIdentity = path.posix.join(dataRoot, DURABLE_INPUT_DIRECTORY, "project.tgz");

  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  assertDurableDirectory(root, "durable data root");
  const input = await openOrCreateDurableHandoff(root, archivePath, requestedInput);
  fs.mkdirSync(checkpointsDirectory, { recursive: true, mode: 0o700 });
  assertDurableDirectory(checkpointsDirectory, "durable checkpoints directory");
  const projectArchiveSha256 = input.project_archive_sha256;
  const storageLineage = `${input.run_id}/${input.attempt_id}/${input.execution_generation}`;

  const hadDurableWorkspace = fs.existsSync(projectRoot);
  if (hadDurableWorkspace) {
    assertDurableDirectory(projectRoot, "durable workspace");
    materializeExecutionSnapshotLinks(projectRoot, input);
  } else {
    const staging = path.join(root, `.workspace-publishing-${crypto.randomUUID()}`);
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    try {
      await extractSafeTarArchive(handoffArchive, staging, { gzip: true, label: "cloud handoff" });
      assertSafeTree(staging);
      materializeExecutionSnapshotLinks(staging, input);
      fs.renameSync(staging, projectRoot);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }
  verifyModalExecutionSnapshotClosure(projectRoot, input);
  sealCloudExecutionSnapshot(projectRoot, input);
  verifyModalExecutionSnapshotClosure(projectRoot, input, { requireSealedPermissions: true });

  let index = loadDurableCheckpointIndex(
    checkpointIndex,
    storageLineage,
    logicalDispatchFingerprint,
    projectRoot: workspaceIdentity,
    runRoot: input.run_root,
    executionSnapshotRoot: input.execution_snapshot_root,
    handoffArchive: handoffArchiveIdentity,
    archiveSha256: projectArchiveSha256
  });
  const restoreMarker = path.join(handoffDirectory, DURABLE_RESTORE_MARKER);
  let restoredFrom = readRestoreMarker(restoreMarker, root, input);
  if (restoredFrom === undefined) {
    restoredFrom = restorePriorAttemptOutputs(root, projectRoot, input);
    if (restoredFrom !== undefined) {
      const restoreDocument: StrictModalNodeRestoreDocument = {
        schema_version: "ultrafuzz.modal.node-restore.v1",
        source_root: restoredFrom
      };
      await writeModalDocumentAtomic(restoreMarker, MODAL_NODE_RESTORE_SCHEMA_ID, restoreDocument, {
        trustedRoot: root
      });
    }
  }
  const hasCompletedCheckpoint = index.checkpoints.some((checkpoint) => checkpoint.stage === "completed");
  return {
    projectRoot,
    attemptRoot: root,
    checkpointIndex,
    input,
    hasCompletedCheckpoint,
    async recordCheckpoint(stage, error) {
      assertDurableCheckpointManifestBijection(index, checkpointIndex, true);
      const sequence = index.checkpoints.length + 1;
      const checkpointId = `${String(sequence).padStart(4, "0")}-${stage}`;
      const createdAt = new Date().toISOString();
      const manifestPath = path.join(checkpointsDirectory, `${checkpointId}.json`);
      const checkpoint: DurableCheckpointRecord = {
        schema_version: "ultrafuzz.modal.node-checkpoint.v1",
        checkpoint_id: checkpointId,
        sequence,
        stage,
        created_at: createdAt,
        storage_lineage: storageLineage,
        logical_dispatch_fingerprint: logicalDispatchFingerprint,
        workspace_path: workspaceIdentity,
        run_root: input.run_root,
        execution_snapshot_root: input.execution_snapshot_root,
        handoff_archive: handoffArchiveIdentity,
        project_archive_sha256: projectArchiveSha256,
        ...(restoredFrom === undefined ? {} : { restored_from: restoredFrom }),
        ...(error === undefined ? {} : { error: describeCheckpointError(error) })
      };
      writeJsonAtomic(manifestPath, checkpoint);
      index.checkpoints.push({
        checkpoint_id: checkpointId,
        sequence,
        stage,
        created_at: createdAt,
        manifest: path.posix.join(dataRoot, DURABLE_CHECKPOINT_DIRECTORY, `${checkpointId}.json`)
      });
      const nextIndex: DurableCheckpointIndex = {
        ...index,
        checkpoints: [
          ...index.checkpoints,
          {
            checkpoint_id: checkpointId,
            sequence,
            stage,
            created_at: createdAt,
            manifest: manifestPath
          }
        ]
      };
      await writeModalDocumentAtomic(checkpointIndex, MODAL_NODE_CHECKPOINT_INDEX_SCHEMA_ID, nextIndex, {
        trustedRoot: root
      });
      index = nextIndex;
      return checkpoint;
    }
  };
}

async function openOrCreateDurableHandoff(
  root: string,
  archivePath: string,
  requestedInput: ReturnType<typeof parseModalNodeWorkerInput>
): Promise<ReturnType<typeof parseModalNodeWorkerInput> & { project_archive_sha256: string }> {
  const handoffDirectory = path.join(root, DURABLE_INPUT_DIRECTORY);
  const publishingDirectory = path.join(root, `.${DURABLE_INPUT_DIRECTORY}.publishing`);
  const finalState = lstatWorkerPath(handoffDirectory);
  const publishingState = lstatWorkerPath(publishingDirectory);
  if (finalState !== undefined) {
    if (publishingState !== undefined) {
      throw new Error("durable cloud handoff has conflicting committed and publishing state");
    }
    return readCommittedDurableHandoff(handoffDirectory, requestedInput, true);
  }
  if (publishingState !== undefined) {
    const input = readCommittedDurableHandoff(publishingDirectory, requestedInput, false);
    fs.renameSync(publishingDirectory, handoffDirectory);
    syncDirectory(root);
    return input;
  }
  if (
    lstatWorkerPath(path.join(root, DURABLE_WORKSPACE_DIRECTORY)) !== undefined ||
    durableCheckpointStateExists(path.join(root, DURABLE_CHECKPOINT_DIRECTORY))
  ) {
    throw new Error("durable cloud handoff is missing for existing worker state");
  }

  const input = validateFreshHandoff(archivePath, requestedInput);
  fs.mkdirSync(publishingDirectory, { mode: 0o700 });
  try {
    const publishingArchive = path.join(publishingDirectory, "project.tgz");
    fs.copyFileSync(archivePath, publishingArchive, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(publishingArchive, 0o600);
    if (sha256File(publishingArchive) !== input.project_archive_sha256) {
      throw new Error("published durable cloud handoff archive digest mismatch");
    }
    await writeModalDocumentAtomic(path.join(publishingDirectory, "request.json"), MODAL_NODE_INPUT_SCHEMA_ID, input, {
      trustedRoot: publishingDirectory
    });
    syncDirectory(publishingDirectory);
    fs.renameSync(publishingDirectory, handoffDirectory);
    syncDirectory(root);
    return input;
  } catch (error) {
    fs.rmSync(publishingDirectory, { recursive: true, force: true });
    throw error;
  }
}

function readCommittedDurableHandoff(
  directory: string,
  requestedInput: ReturnType<typeof parseModalNodeWorkerInput>,
  allowRestoreMarker: boolean
): ReturnType<typeof parseModalNodeWorkerInput> & { project_archive_sha256: string } {
  assertDurableDirectory(directory, "durable cloud handoff directory");
  const allowed = new Set(["project.tgz", "request.json", ...(allowRestoreMarker ? [DURABLE_RESTORE_MARKER] : [])]);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!allowed.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("durable cloud handoff directory contains invalid present state");
    }
  }
  const handoffArchive = path.join(directory, "project.tgz");
  assertDurableRegularFile(handoffArchive, "durable cloud handoff archive");
  const input = readDurableInput(path.join(directory, "request.json"), requestedInput);
  if (sha256File(handoffArchive) !== input.project_archive_sha256) {
    throw new Error("durable cloud handoff archive digest mismatch");
  }
  return input;
}

function durableCheckpointStateExists(checkpointsDirectory: string): boolean {
  const state = lstatWorkerPath(checkpointsDirectory);
  if (state === undefined) return false;
  assertDurableDirectory(checkpointsDirectory, "durable checkpoints directory");
  return fs.readdirSync(checkpointsDirectory).length > 0;
}

function validateFreshHandoff(
  archivePath: string,
  input: ReturnType<typeof parseModalNodeWorkerInput>
): ReturnType<typeof parseModalNodeWorkerInput> & { project_archive_sha256: string } {
  assertDurableRegularFile(archivePath, "cloud handoff archive");
  if (input.project_archive_sha256 === undefined || sha256File(archivePath) !== input.project_archive_sha256) {
    throw new Error("cloud handoff archive digest mismatch");
  }
  return input as ReturnType<typeof parseModalNodeWorkerInput> & { project_archive_sha256: string };
}

function readDurableInput(
  durableRequest: string,
  requestedInput: ReturnType<typeof parseModalNodeWorkerInput>
): {
  input: ReturnType<typeof parseModalNodeWorkerInput> & { project_archive_sha256: string };
  needsContentFingerprintMigration: boolean;
} {
  let persistedInput: ReturnType<typeof parseModalNodeWorkerInput>;
  try {
    persistedInput = readModalDocument(durableRequest, MODAL_NODE_INPUT_SCHEMA_ID)
      .value as StrictModalNodeInputDocument;
  } catch (error) {
    throw new Error("durable cloud handoff request is unavailable", { cause: error });
  }
  if (persistedInput.project_archive_sha256 === undefined) {
    throw new Error("durable workspace request does not match this cloud node attempt");
  }
  const needsContentFingerprintMigration =
    persistedInput.project_content_sha256 === undefined &&
    requestedInput.project_content_sha256 !== undefined &&
    persistedInput.execution_generation === requestedInput.execution_generation &&
    modalNodeDispatchFingerprint(persistedInput) ===
      modalNodeDispatchFingerprint({ ...requestedInput, project_content_sha256: undefined });
  if (!needsContentFingerprintMigration && !sameDurableNodeAttempt(persistedInput, requestedInput)) {
    throw new Error("durable workspace request does not match this cloud node attempt");
  }
  return {
    input: persistedInput as ReturnType<typeof parseModalNodeWorkerInput> & { project_archive_sha256: string },
    needsContentFingerprintMigration
  };
}

async function migrateLegacyContentFingerprint(
  handoffArchive: string,
  durableRequest: string,
  persistedInput: ReturnType<typeof parseModalNodeSandboxInput> & { project_archive_sha256: string },
  requestedInput: ReturnType<typeof parseModalNodeSandboxInput>
): Promise<ReturnType<typeof parseModalNodeSandboxInput> & { project_archive_sha256: string }> {
  const expected = requestedInput.project_content_sha256;
  if (expected === undefined) throw new Error("durable workspace request does not match this cloud node attempt");
  const temporaryRoot = fs.mkdtempSync(path.join(path.dirname(handoffArchive), ".legacy-content-"));
  fs.chmodSync(temporaryRoot, 0o700);
  const extracted = path.join(temporaryRoot, "project");
  fs.mkdirSync(extracted, { mode: 0o700 });
  try {
    await extractSafeTarArchive(handoffArchive, extracted, { gzip: true, label: "durable cloud handoff" });
    assertSafeTree(extracted);
    if (modalNodeHandoffContentFingerprint(extracted, persistedInput, { materialized: true }) !== expected) {
      throw new Error("durable workspace request does not match this cloud node attempt");
    }
    const migrated = { ...persistedInput, project_content_sha256: expected };
    if (!sameDurableNodeAttempt(migrated, requestedInput)) {
      throw new Error("durable workspace request does not match this cloud node attempt");
    }
    // Only persist the migration after the caller verified the exact archived bytes and this
    // independently extracted copy verified every semantic input represented by the new fingerprint.
    writeJsonAtomic(durableRequest, migrated);
    return migrated;
  } finally {
    const schemas = path.join(extracted, ".ultrafuzz", "schemas");
    if (fs.existsSync(schemas) && !fs.lstatSync(schemas).isSymbolicLink()) fs.chmodSync(schemas, 0o700);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

/**
 * The exact identity a durable workspace may be *resumed* under.
 *
 * Resuming reuses the extracted workspace, its installed dependencies, and its checkpoint history in
 * place, so the generation must match too: a different generation is a different sandbox, volume
 * attempt root, and storage lineage, and adopting its workspace would publish under the wrong one.
 */
function sameDurableNodeAttempt(
  left: ReturnType<typeof parseModalNodeSandboxInput>,
  right: ReturnType<typeof parseModalNodeSandboxInput>
): boolean {
  return (
    left.schema_version === right.schema_version &&
    left.run_id === right.run_id &&
    left.task_id === right.task_id &&
    left.attempt_id === right.attempt_id &&
    left.source_revision === right.source_revision &&
    left.source_ref === right.source_ref &&
    (ignoreExecutionGeneration || left.execution_generation === right.execution_generation) &&
    left.workflow_path === right.workflow_path &&
    left.prompt_path === right.prompt_path &&
    left.execution_snapshot_root === right.execution_snapshot_root &&
    left.run_root === right.run_root &&
    left.artifact_dir === right.artifact_dir &&
    left.workspace_dir === right.workspace_dir &&
    sameStrings(left.dependency_artifact_dirs, right.dependency_artifact_dirs) &&
    sameStrings(left.optional_dependency_artifact_dirs ?? [], right.optional_dependency_artifact_dirs ?? []) &&
    sameDependencyVerificationAuthorities(
      left.dependency_verification_authorities,
      right.dependency_verification_authorities
    ) &&
    left.resources.cpu === right.resources.cpu &&
    left.resources.memory_mib === right.resources.memory_mib &&
    left.resources.timeout_seconds === right.resources.timeout_seconds &&
    sameStrings(left.agent_credential_env, right.agent_credential_env) &&
    left.operator_prompt === right.operator_prompt
  );
}

/**
 * The identity a *reset* may restore prior outputs from: the same logical dispatch, a new generation.
 *
 * Every task and planner-catalog binding is provenance for whatever the durable workspace produced,
 * so a reset may recover a prior generation's outputs only when the whole logical dispatch still
 * agrees -- which is precisely what the shared fingerprint states.
 */
function sameLogicalNodeDispatch(
  left: ReturnType<typeof parseModalNodeSandboxInput>,
  right: ReturnType<typeof parseModalNodeSandboxInput>
): boolean {
  return modalNodeDispatchFingerprint(left) === modalNodeDispatchFingerprint(right);
}

function sameDependencyVerificationAuthorities(
  left: StrictModalNodeInputDocument["dependency_verification_authorities"],
  right: StrictModalNodeInputDocument["dependency_verification_authorities"]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (value, index) =>
        value.attempt_id === right[index]?.attempt_id &&
        value.marker_sha256 === right[index]?.marker_sha256 &&
        value.size_bytes === right[index]?.size_bytes
    )
  );
}

function readRestoreMarker(
  markerPath: string,
  currentRoot: string,
  input: ReturnType<typeof parseModalNodeWorkerInput>
): string | undefined {
  if (lstatWorkerPath(markerPath) === undefined) return undefined;
  let marker: StrictModalNodeRestoreDocument;
  try {
    marker = readModalDocument(markerPath, MODAL_NODE_RESTORE_SCHEMA_ID).value as StrictModalNodeRestoreDocument;
  } catch (error) {
    throw new Error("durable restore marker is invalid", { cause: error });
  }
  const sourceRoot = path.resolve(marker.source_root);
  if (
    !path.isAbsolute(marker.source_root) ||
    sourceRoot !== marker.source_root ||
    sourceRoot === currentRoot ||
    path.dirname(sourceRoot) !== path.dirname(currentRoot) ||
    compatiblePriorAttempt(sourceRoot, currentRoot, input, false) === undefined
  ) {
    throw new Error("durable restore marker is invalid");
  }
  return sourceRoot;
}

function restorePriorAttemptOutputs(
  currentRoot: string,
  projectRoot: string,
  input: ReturnType<typeof parseModalNodeWorkerInput>
): string | undefined {
  const parent = path.dirname(currentRoot);
  const candidates: CompatiblePriorAttempt[] = [];
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidateRoot = path.join(parent, entry.name);
    if (candidateRoot === currentRoot) continue;
    const candidate = compatiblePriorAttempt(candidateRoot, currentRoot, input, true);
    if (candidate !== undefined) candidates.push(candidate);
  }
  const prior = candidates.sort(
    (left, right) => right.mtimeMs - left.mtimeMs || (left.root < right.root ? -1 : left.root > right.root ? 1 : 0)
  )[0];
  if (prior === undefined) return undefined;

  const priorProjectRoot = path.join(prior.root, DURABLE_WORKSPACE_DIRECTORY);
  const recoveryBase = anchoredProjectPath(
    projectRoot,
    path.join(".ultrafuzz", "recovered", path.basename(prior.root))
  );
  const sourceWorkspace = anchoredProjectPath(priorProjectRoot, input.workspace_dir);
  copyOptionalPriorEvidence(sourceWorkspace, path.join(recoveryBase, "workspace"));
  for (const [label, relative] of [
    ["artifacts", input.artifact_dir],
    ["logs", path.join(input.run_root, "logs")]
  ] as const) {
    const source = anchoredProjectPath(priorProjectRoot, relative);
    copyOptionalPriorEvidence(source, path.join(recoveryBase, label));
  }
  const priorRecovered = anchoredProjectPath(priorProjectRoot, path.join(".ultrafuzz", "recovered"));
  copyOptionalPriorEvidence(priorRecovered, path.join(recoveryBase, "previous-recovered"));
  return prior.root;
}

interface CompatiblePriorAttempt {
  readonly root: string;
  readonly mtimeMs: number;
  readonly input: ReturnType<typeof parseModalNodeWorkerInput>;
}

function compatiblePriorAttempt(
  candidateRoot: string,
  currentRoot: string,
  input: ReturnType<typeof parseModalNodeWorkerInput>,
  allowMissingOrUnrelated: boolean
): CompatiblePriorAttempt | undefined {
  assertDurableDirectory(candidateRoot, "prior generation durable root");
  const handoffDirectory = path.join(candidateRoot, DURABLE_INPUT_DIRECTORY);
  const requestPath = path.join(handoffDirectory, "request.json");
  const handoffState = lstatWorkerPath(handoffDirectory);
  if (handoffState === undefined) {
    if (allowMissingOrUnrelated) return undefined;
    throw new Error("prior generation handoff directory is missing");
  }
  assertDurableDirectory(handoffDirectory, "prior generation handoff directory");
  if (lstatWorkerPath(requestPath) === undefined) {
    if (allowMissingOrUnrelated) return undefined;
    throw new Error("prior generation cloud handoff request is missing");
  }
  let persisted: StrictModalNodeInputDocument;
  try {
    persisted = readModalDocument(requestPath, MODAL_NODE_INPUT_SCHEMA_ID).value as StrictModalNodeInputDocument;
  } catch (error) {
    throw new Error("prior generation cloud handoff request is invalid", { cause: error });
  }
  if (
    persisted.project_archive_sha256 === undefined ||
    persisted.execution_generation === input.execution_generation ||
    !sameCompatiblePriorNodeInput(candidateRoot, currentRoot, persisted, input)
  ) {
    if (allowMissingOrUnrelated) return undefined;
    throw new Error("durable restore marker does not reference a compatible prior generation");
  }
  const allowedHandoffEntries = new Set(["project.tgz", "request.json", DURABLE_RESTORE_MARKER]);
  for (const entry of fs.readdirSync(handoffDirectory, { withFileTypes: true })) {
    if (!allowedHandoffEntries.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("prior generation handoff directory contains invalid present state");
    }
  }
  const priorRestoreMarker = path.join(handoffDirectory, DURABLE_RESTORE_MARKER);
  if (lstatWorkerPath(priorRestoreMarker) !== undefined) {
    try {
      readModalDocument(priorRestoreMarker, MODAL_NODE_RESTORE_SCHEMA_ID);
    } catch (error) {
      throw new Error("prior generation restore marker is invalid", { cause: error });
    }
  }
  const handoffArchive = path.join(handoffDirectory, "project.tgz");
  assertDurableRegularFile(handoffArchive, "prior generation handoff archive");
  if (sha256File(handoffArchive) !== persisted.project_archive_sha256) {
    throw new Error("prior generation handoff archive digest mismatch");
  }
  const checkpointDirectory = path.join(candidateRoot, DURABLE_CHECKPOINT_DIRECTORY);
  const checkpointIndex = path.join(checkpointDirectory, DURABLE_CHECKPOINT_INDEX);
  if (lstatWorkerPath(checkpointIndex) === undefined) {
    if (allowMissingOrUnrelated) return undefined;
    throw new Error("durable restore marker references a generation without a checkpoint index");
  }
  assertDurableDirectory(checkpointDirectory, "prior generation checkpoints directory");
  const index = loadDurableCheckpointIndex(
    checkpointIndex,
    `${persisted.run_id}/${persisted.attempt_id}/${persisted.execution_generation}`,
    path.join(candidateRoot, DURABLE_WORKSPACE_DIRECTORY),
    persisted.run_root,
    persisted.execution_snapshot_root,
    handoffArchive,
    persisted.project_archive_sha256
  );
  if (index.checkpoints.length === 0 || !priorAttemptHasEvidence(candidateRoot, persisted)) {
    if (allowMissingOrUnrelated) return undefined;
    throw new Error("durable restore marker references a generation without recoverable evidence");
  }
  return {
    root: candidateRoot,
    mtimeMs: fs.statSync(checkpointDirectory).mtimeMs,
    input: persisted
  };
}

function sameCompatiblePriorNodeInput(
  candidateRoot: string,
  currentRoot: string,
  prior: ReturnType<typeof parseModalNodeWorkerInput>,
  current: ReturnType<typeof parseModalNodeWorkerInput>
): boolean {
  if (sameResumableNodeInput(prior, current, true)) return true;
  if (prior.run_id !== current.run_id || prior.task_id !== current.task_id || prior.attempt_id !== current.attempt_id) {
    return false;
  }

  const priorProjectRoot = path.join(candidateRoot, DURABLE_WORKSPACE_DIRECTORY);
  const currentProjectRoot = path.join(currentRoot, DURABLE_WORKSPACE_DIRECTORY);
  verifyModalExecutionSnapshotClosure(priorProjectRoot, prior, { requireSealedPermissions: true });
  const priorIdentity = modalNodeContinuationIdentity(priorProjectRoot, prior);
  const currentIdentity = modalNodeContinuationIdentity(currentProjectRoot, current);
  if (
    priorIdentity.taskIdentitySha256 !== currentIdentity.taskIdentitySha256 ||
    priorIdentity.nonControllerInputsSha256 !== currentIdentity.nonControllerInputsSha256 ||
    priorIdentity.targetGitTree !== currentIdentity.targetGitTree ||
    priorIdentity.controlGeneration !== currentIdentity.controlGeneration ||
    !currentIdentity.authorizedGenerations.includes(priorIdentity.controllerGeneration) ||
    currentIdentity.semanticFingerprint === undefined
  ) {
    return false;
  }
  // A refreshed ancestor authenticates its own semantic fingerprint. The
  // original control generation has no manifest field of its own; the current
  // committed manifest was admitted only after matching those sealed semantics.
  return (
    priorIdentity.semanticFingerprint === undefined ||
    priorIdentity.semanticFingerprint === currentIdentity.semanticFingerprint
  );
}

function priorAttemptHasEvidence(candidateRoot: string, input: ReturnType<typeof parseModalNodeWorkerInput>): boolean {
  const projectRoot = path.join(candidateRoot, DURABLE_WORKSPACE_DIRECTORY);
  for (const relative of [
    input.workspace_dir,
    input.artifact_dir,
    path.join(input.run_root, "logs"),
    path.join(".ultrafuzz", "recovered")
  ]) {
    const candidate = anchoredProjectPath(projectRoot, relative);
    const state = lstatWorkerPath(candidate);
    if (state === undefined) continue;
    assertDurableDirectory(candidate, "prior generation evidence directory");
    if (fs.readdirSync(candidate).length > 0) return true;
  }
  return false;
}

function copyOptionalPriorEvidence(source: string, destination: string): void {
  if (lstatWorkerPath(source) === undefined) return;
  assertDurableDirectory(source, "prior generation evidence directory");
  copySafeTree(source, destination);
}

export function resolveDurableDataRoot(dataRoot: string, trustedMountRoot = TRUSTED_MOUNT_ROOT): string {
  const root = path.resolve(dataRoot);
  if (root === path.parse(root).root) throw new Error("cloud durable data root is unsafe");
  const mount = path.resolve(trustedMountRoot);
  if (root !== mount && root.startsWith(`${mount}${path.sep}`)) {
    const canonicalMount = fs.realpathSync(mount);
    if (!fs.statSync(canonicalMount).isDirectory() || canonicalMount === path.parse(canonicalMount).root) {
      throw new Error("cloud durable data root is unsafe");
    }
    let lexical = mount;
    let canonical = canonicalMount;
    for (const part of path.relative(mount, root).split(path.sep)) {
      lexical = path.join(lexical, part);
      canonical = path.join(canonical, part);
      fs.mkdirSync(lexical, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(lexical);
      if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(lexical) !== canonical) {
        throw new Error("cloud durable data root is unsafe");
      }
    }
    return canonical;
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  assertDurableDirectory(root, "cloud durable data root");
  return root;
}

function assertDurableDirectory(directory: string, label: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
    throw new Error(`${label} is unsafe`);
  }
}

function assertDurableRegularFile(filePath: string, label: string): void {
  const resolved = path.resolve(filePath);
  const stat = lstatWorkerPath(resolved);
  if (stat === undefined) throw new Error(`${label} is missing`);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || fs.realpathSync(resolved) !== resolved) {
    throw new Error(`${label} is unsafe`);
  }
}

function loadDurableCheckpointIndex(
  checkpointIndex: string,
  identity: {
    storageLineage: string;
    logicalDispatchFingerprint: string;
    projectRoot: string;
    runRoot: string;
    executionSnapshotRoot: string;
    handoffArchive: string;
    archiveSha256: string;
  }
): DurableCheckpointIndex {
  if (lstatWorkerPath(checkpointIndex) === undefined) {
    const checkpointDirectory = path.dirname(checkpointIndex);
    const hasOrphanedManifest = fs
      .readdirSync(checkpointDirectory, { withFileTypes: true })
      .some((entry) => entry.name !== DURABLE_CHECKPOINT_INDEX && entry.name.endsWith(".json"));
    if (hasOrphanedManifest) {
      throw new Error("durable checkpoint index is missing for existing checkpoint manifests");
    }
    return {
      schema_version: "ultrafuzz.modal.node-checkpoint-index.v1",
      storage_lineage: identity.storageLineage,
      logical_dispatch_fingerprint: identity.logicalDispatchFingerprint,
      workspace_path: identity.projectRoot,
      run_root: identity.runRoot,
      execution_snapshot_root: identity.executionSnapshotRoot,
      handoff_archive: identity.handoffArchive,
      project_archive_sha256: identity.archiveSha256,
      checkpoints: []
    };
  }
  let parsed: StrictModalNodeCheckpointIndexDocument;
  try {
    parsed = readModalDocument(checkpointIndex, MODAL_NODE_CHECKPOINT_INDEX_SCHEMA_ID)
      .value as StrictModalNodeCheckpointIndexDocument;
  } catch (error) {
    throw new Error("durable checkpoint index is invalid", { cause: error });
  }
  if (
    parsed.storage_lineage !== storageLineage ||
    parsed.workspace_path !== projectRoot ||
    parsed.run_root !== runRoot ||
    parsed.execution_snapshot_root !== executionSnapshotRoot ||
    parsed.handoff_archive !== handoffArchive ||
    parsed.project_archive_sha256 !== archiveSha256
  ) {
    throw new Error("durable checkpoint index is invalid");
  }
  assertDurableCheckpointManifestBijection(parsed, checkpointIndex);
  return parsed;
}

function assertDurableCheckpointManifestBijection(
  index: StrictModalNodeCheckpointIndexDocument,
  checkpointIndex: string,
  verifyPersistedIndex = false
): void {
  if (verifyPersistedIndex) {
    const persistedState = lstatWorkerPath(checkpointIndex);
    if (persistedState === undefined) {
      if (index.checkpoints.length !== 0) throw new Error("durable checkpoint index disappeared before append");
    } else {
      let persisted: StrictModalNodeCheckpointIndexDocument;
      try {
        persisted = readModalDocument(checkpointIndex, MODAL_NODE_CHECKPOINT_INDEX_SCHEMA_ID)
          .value as StrictModalNodeCheckpointIndexDocument;
      } catch (error) {
        throw new Error("durable checkpoint index changed to invalid present bytes before append", { cause: error });
      }
      if (!isDeepStrictEqual(persisted, index)) {
        throw new Error("durable checkpoint index changed before append");
      }
    }
  }
  const checkpointDirectory = path.dirname(checkpointIndex);
  const expectedNames = new Set<string>();
  let restoredFrom: string | undefined;
  let observedRestoreState = false;
  for (const entry of index.checkpoints) {
    const expectedName = `${entry.checkpoint_id}.json`;
    const manifestPath = path.join(checkpointDirectory, expectedName);
    if (entry.manifest !== manifestPath || expectedNames.has(expectedName)) {
      throw new Error("durable checkpoint index has a noncanonical manifest reference");
    }
    expectedNames.add(expectedName);
    let checkpoint: StrictModalNodeCheckpointDocument;
    try {
      checkpoint = readModalDocument(manifestPath, MODAL_NODE_CHECKPOINT_SCHEMA_ID)
        .value as StrictModalNodeCheckpointDocument;
    } catch (error) {
      throw new Error("durable checkpoint manifest is invalid", { cause: error });
    }
    if (
      checkpoint.checkpoint_id !== entry.checkpoint_id ||
      checkpoint.sequence !== entry.sequence ||
      checkpoint.stage !== entry.stage ||
      checkpoint.created_at !== entry.created_at ||
      checkpoint.storage_lineage !== index.storage_lineage ||
      checkpoint.workspace_path !== index.workspace_path ||
      checkpoint.run_root !== index.run_root ||
      checkpoint.execution_snapshot_root !== index.execution_snapshot_root ||
      checkpoint.handoff_archive !== index.handoff_archive ||
      checkpoint.project_archive_sha256 !== index.project_archive_sha256
    ) {
      throw new Error("durable checkpoint manifest does not match its index entry or trusted context");
    }
    if (!observedRestoreState) {
      restoredFrom = checkpoint.restored_from;
      observedRestoreState = true;
    } else if (checkpoint.restored_from !== restoredFrom) {
      throw new Error("durable checkpoint manifests disagree on restore lineage");
    }
  }
  const presentNames = new Set<string>();
  for (const entry of fs.readdirSync(checkpointDirectory, { withFileTypes: true })) {
    if (entry.name === DURABLE_CHECKPOINT_INDEX || !entry.name.endsWith(".json")) continue;
    const manifestPath = path.join(checkpointDirectory, entry.name);
    const stat = fs.lstatSync(manifestPath);
    if (!entry.isFile() || entry.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error("durable checkpoint directory contains an unsafe manifest");
    }
    presentNames.add(entry.name);
  }
  if (
    presentNames.size !== expectedNames.size ||
    [...presentNames].some((manifestName) => !expectedNames.has(manifestName))
  ) {
    throw new Error("durable checkpoint manifests do not match the checkpoint index");
  }
}

function replacePublishedFile(source: string, destination: string): void {
  assertDurableDirectory(path.dirname(source), "cloud publication directory");
  assertDurableDirectory(path.dirname(destination), "cloud publication destination");
  fs.rmSync(destination, { force: true });
  fs.renameSync(source, destination);
  syncDirectory(path.dirname(destination));
}

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function syncDurableData(cwd: string): void {
  try {
    execFileSync("sync", [], { cwd, stdio: "ignore" });
  } catch (error) {
    throw new Error("unable to flush cloud durable data", { cause: error });
  }
}

function describeCheckpointError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

async function runChecked(
  phase: string,
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string | undefined> = {},
  outputLimit = 4_096
): Promise<{ stdout: string; stderr: string }> {
  const child = spawn(command, args, {
    cwd,
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout = readBoundedText(child.stdout, outputLimit);
  const stderr = readBoundedText(child.stderr, outputLimit);
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  const [stdoutText, stderrText] = await Promise.all([stdout, stderr]);
  if (exitCode !== 0) {
    throw new CloudWorkerCommandError(phase, path.basename(command), exitCode, stdoutText, stderrText);
  }
  return { stdout: stdoutText, stderr: stderrText };
}

class CloudWorkerCommandError extends Error {
  constructor(
    readonly phase: string,
    readonly command: string,
    readonly exitCode: number,
    readonly stdout: string,
    readonly stderr: string
  ) {
    super(`cloud worker phase ${phase} failed with code ${exitCode}`);
  }
}

function readBoundedText(stream: Readable | null, limit = 4_096): Promise<string> {
  if (stream === null) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    let length = 0;
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      if (length >= limit) return;
      const remaining = limit - length;
      chunks.push(chunk.slice(0, remaining));
      length += Math.min(chunk.length, remaining);
    });
    stream.once("error", reject);
    stream.once("end", () => resolve(chunks.join("")));
  });
}

function workerErrorPayload(error: unknown): StrictModalNodeWorkerErrorDocument {
  if (error instanceof CloudWorkerCommandError) {
    return {
      schema_version: "ultrafuzz.modal.node-worker-error.v1",
      message: boundedWorkerErrorText(error.message, 4_096, "cloud worker command failed"),
      phase: boundedWorkerErrorText(error.phase, 256, "unknown-phase"),
      command: boundedWorkerErrorText(error.command, 1_024, "unknown-command"),
      exit_code: error.exitCode,
      ...(error.stdout.trim() === "" ? {} : { stdout: error.stdout.trim().slice(0, 2_000) }),
      ...(error.stderr.trim() === "" ? {} : { stderr: error.stderr.trim().slice(0, 2_000) })
    };
  }
  return {
    schema_version: "ultrafuzz.modal.node-worker-error.v1",
    message: boundedWorkerErrorText(describeWorkerError(error), 4_096, "cloud worker failed")
  };
}

function describeWorkerError(error: unknown): string {
  try {
    return error instanceof Error ? String(error.message) : String(error);
  } catch {
    return "cloud worker failed";
  }
}

function boundedWorkerErrorText(value: string, limit: number, fallback: string): string {
  const bounded = value.slice(0, limit);
  return bounded.length === 0 ? fallback : bounded;
}

export function copySafeTree(source: string, destination: string): void {
  const resolvedSource = path.resolve(source);
  const sourceStat = fs.lstatSync(resolvedSource);
  const root = fs.realpathSync(resolvedSource);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink() || root !== resolvedSource) {
    throw new Error("cloud publication source is unsafe");
  }
  assertSafeDirectoryTarget(destination);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const sourcePath = path.join(root, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copySafeTree(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      const stat = fs.lstatSync(sourcePath);
      if (stat.nlink !== 1) throw new Error("cloud publication file is hard-linked");
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.copyFileSync(sourcePath, destinationPath);
    } else {
      throw new Error("cloud publication excludes links and special files");
    }
  }
}

export function copyVerifiedPublishedEvidenceTree(
  source: string,
  destination: string,
  markerPath: string,
  attemptId: string
): void {
  const publications = readVerificationMarkerPublications(markerPath, attemptId);
  const sourceRoot = path.resolve(source);
  const sourceStat = fs.lstatSync(sourceRoot);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink() || fs.realpathSync(sourceRoot) !== sourceRoot) {
    throw new Error("cloud publication source is unsafe");
  }
  assertSafeDirectoryTarget(destination);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });

  for (const [relativePath, expectedSha256] of publications) {
    const sourcePath = safeVerifiedPublicationPath(sourceRoot, relativePath);
    const sourceFile = assertRegularUnlinkedFile(sourcePath, `verified publication is unavailable: ${relativePath}`);
    const destinationPath = safeVerifiedPublicationPath(path.resolve(destination), relativePath);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
    fs.copyFileSync(sourceFile, destinationPath, fs.constants.COPYFILE_EXCL);
    const publishedSha256 = sha256File(destinationPath);
    if (publishedSha256 !== expectedSha256) {
      throw new Error(`verified publication digest mismatch: ${relativePath}`);
    }
    const sourceSha256 = sha256File(sourceFile);
    if (sourceSha256 !== expectedSha256) {
      throw new Error(`verified publication changed during publication: ${relativePath}`);
    }
  }
}

export function copyAttemptVerificationMarker(
  projectRoot: string,
  input: { run_root: string; attempt_id: string },
  destinationRoot: string
): string {
  const { markerName, markerPath } = attemptVerificationMarkerSource(projectRoot, input);
  assertSafeDirectoryTarget(destinationRoot);
  fs.mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
  const resolvedDestinationRoot = path.resolve(destinationRoot);
  const destinationPath = path.join(resolvedDestinationRoot, markerName);
  if (path.dirname(destinationPath) !== resolvedDestinationRoot) {
    throw new Error("cloud publication verification marker path is unsafe");
  }
  fs.copyFileSync(markerPath, destinationPath, fs.constants.COPYFILE_EXCL);
  return destinationPath;
}

function attemptVerificationMarkerSource(
  projectRoot: string,
  input: { run_root: string; attempt_id: string }
): { markerName: string; markerPath: string } {
  const markerRoot = anchoredProjectPath(projectRoot, path.join(input.run_root, ARTIFACT_VERIFICATION_DIRECTORY));
  assertSafeDirectoryTarget(markerRoot);
  const markerName = modalAttemptVerificationMarkerName(input.attempt_id);
  const markerPath = path.join(markerRoot, markerName);
  if (path.dirname(markerPath) !== markerRoot) {
    throw new Error("cloud publication verification marker path is unsafe");
  }
  if (!fs.existsSync(markerPath)) {
    throw new Error("cloud publication verification marker is missing");
  }
  const markerStat = fs.lstatSync(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1) {
    throw new Error("cloud publication verification marker is unsafe");
  }
  return { markerName, markerPath };
}

function readVerificationMarkerPublications(markerPath: string, attemptId: string): Map<string, string> {
  const markerFile = assertRegularUnlinkedFile(markerPath, "cloud publication verification marker is unavailable");
  const markerStat = fs.statSync(markerFile);
  if (markerStat.size === 0 || markerStat.size > MAX_VERIFICATION_MARKER_BYTES) {
    throw new Error("cloud publication verification marker size is invalid");
  }
  let parsed: unknown;
  try {
    parsed = parseStrictJsonBytes(fs.readFileSync(markerFile));
  } catch (error) {
    throw new Error("cloud publication verification marker is invalid JSON", { cause: error });
  }
  const shape = validateArtifactVerificationMarker(parsed);
  if (!shape.ok) {
    throw new Error("cloud publication verification marker is invalid");
  }
  const marker = parsed as ArtifactVerificationMarker;
  if (marker.attempt_id !== attemptId) throw new Error("cloud publication verification marker is invalid");
  assertArtifactVerificationMarkerSemantics(marker);
  const publications = new Map<string, string>();
  for (const publication of marker.publications) {
    const relativePath = publication.path;
    assertSafeVerifiedPublicationRelativePath(relativePath);
    if (publications.has(relativePath)) {
      throw new Error(`cloud publication verification marker has duplicate publication: ${relativePath}`);
    }
    publications.set(relativePath, publication.sha256);
  }
  if (publications.size === 0) {
    throw new Error("cloud publication verification marker has no publications");
  }
  return publications;
}

function assertRegularUnlinkedFile(filePath: string, label: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw new Error(label, { cause: error });
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(label);
  }
  return filePath;
}

function safeVerifiedPublicationPath(root: string, relativePath: string): string {
  assertSafeVerifiedPublicationRelativePath(relativePath);
  const absoluteRoot = path.resolve(root);
  const destination = path.resolve(absoluteRoot, ...relativePath.split("/"));
  if (destination === absoluteRoot || !destination.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(`unsafe verified publication path: ${relativePath}`);
  }
  return destination;
}

function assertSafeVerifiedPublicationRelativePath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    /^[A-Za-z]:/u.test(relativePath) ||
    relativePath.split("/").includes("..")
  ) {
    throw new Error(`unsafe verified publication path: ${relativePath}`);
  }
}

function assertSafeDirectoryTarget(destination: string): void {
  const resolved = path.resolve(destination);
  if (fs.existsSync(resolved)) {
    const stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) {
      throw new Error("cloud publication destination is unsafe");
    }
    return;
  }
  const parent = path.dirname(resolved);
  if (parent !== resolved) {
    assertSafeDirectoryTarget(parent);
  }
}

function assertSafeTree(root: string): void {
  const resolvedRoot = path.resolve(root);
  const rootStat = fs.lstatSync(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(resolvedRoot) !== resolvedRoot) {
    throw new Error("cloud handoff archive root is unsafe");
  }
  for (const entry of fs.readdirSync(resolvedRoot, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    const stat = fs.lstatSync(full);
    if ((!stat.isDirectory() && !stat.isFile()) || stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) {
      throw new Error("cloud handoff archive contains an unsafe filesystem entry");
    }
  }
}

function anchoredProjectPath(projectRoot: string, value: string): string {
  const resolved = path.resolve(projectRoot, value);
  if (resolved === projectRoot || !resolved.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error("cloud worker path escapes the project");
  }
  return resolved;
}

function requiredOption(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.trim() === "") throw new Error("cloud worker option is missing");
  return value;
}

function isDirectExecution(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  void main().catch((error: unknown) => {
    process.exitCode = 1;
    const { bytes } = serializeModalDocument(MODAL_NODE_WORKER_ERROR_SCHEMA_ID, workerErrorPayload(error));
    process.stderr.write(bytes);
  });
}
