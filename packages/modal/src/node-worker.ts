import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import {
  modalAttemptVerificationMarkerName,
  modalNodeDispatchFingerprint,
  modalNodeHandoffContentFingerprint,
  parseModalNodeWorkerInput,
  readModalExecutionDependencyClosure,
  verifyModalExecutionSnapshotClosure
} from "./node-provider.js";
import type { parseModalNodeSandboxInput } from "./node-provider.js";
import { extractSafeTarArchive, sha256File } from "./safe-archive.js";

const TRUSTED_MOUNT_ROOT = "/data";
const DURABLE_WORKSPACE_DIRECTORY = "workspace";
const DURABLE_INPUT_DIRECTORY = "input";
const DURABLE_CHECKPOINT_DIRECTORY = "checkpoints";
const DURABLE_CHECKPOINT_INDEX = "index.json";
const DURABLE_RESTORE_MARKER = "restore.json";
const ARTIFACT_VERIFICATION_DIRECTORY = ".ultrafuzz-verification";
const ARTIFACT_VERIFICATION_SCHEMA_VERSION = "ultrafuzz.artifact-verification.v1";
const MAX_PUBLICATION_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_PUBLICATION_MANIFEST_ENTRIES = 4_096;
const MAX_VERIFICATION_MARKER_BYTES = 4 * 1024 * 1024;
const MAX_WORKFLOW_MARKER_PROBE_BYTES = 16 * 1024 * 1024;

type DurableCheckpointStage = "prepared" | "running" | "failed" | "completed";

interface DurableCheckpointRecord {
  schema_version: "ultrafuzz.modal.node-checkpoint.v1";
  checkpoint_id: string;
  sequence: number;
  stage: DurableCheckpointStage;
  created_at: string;
  storage_lineage: string;
  /**
   * The logical dispatch this record belongs to, independent of the generation it ran under.
   *
   * The storage lineage already names the generation, which a reset intentionally changes. This names
   * what the workspace actually executed, so a durable resume, a cross-generation restore, and the
   * controller reading the published result all compare the same value.
   */
  logical_dispatch_fingerprint: string;
  workspace_path: string;
  run_root: string;
  execution_snapshot_root: string;
  handoff_archive: string;
  project_archive_sha256: string;
  restored_from?: string;
  error?: string;
}

interface DurableCheckpointIndex {
  schema_version: "ultrafuzz.modal.node-checkpoint-index.v1";
  storage_lineage: string;
  logical_dispatch_fingerprint: string;
  workspace_path: string;
  run_root: string;
  execution_snapshot_root: string;
  handoff_archive: string;
  project_archive_sha256: string;
  checkpoints: Array<
    Pick<DurableCheckpointRecord, "checkpoint_id" | "sequence" | "stage" | "created_at"> & { manifest: string }
  >;
}

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
  recordCheckpoint(stage: DurableCheckpointStage, error?: unknown): DurableCheckpointRecord;
}

async function main(): Promise<void> {
  const requestPath = requiredOption("--request");
  const archivePath = requiredOption("--project-archive");
  const dataRoot = requiredOption("--data-root");
  const requestedInput = parseModalNodeWorkerInput(JSON.parse(fs.readFileSync(requestPath, "utf8")) as unknown);
  let durableWorkspace: DurableNodeWorkspace | undefined;
  let publishing: string | undefined;
  try {
    durableWorkspace = await initializeDurableNodeWorkspace(dataRoot, archivePath, requestedInput);
    const input = durableWorkspace.input;
    const projectRoot = durableWorkspace.projectRoot;
    const attemptRoot = durableWorkspace.attemptRoot;
    if (!durableWorkspace.hasCompletedCheckpoint) {
      durableWorkspace.recordCheckpoint("prepared");
    }
    syncDurableData(projectRoot);
    const localRunId = `${input.run_id}-${crypto.createHash("sha256").update(input.task_id).digest("hex").slice(0, 12)}`;
    if (!durableWorkspace.hasCompletedCheckpoint) {
      durableWorkspace.recordCheckpoint("running");
      syncDurableData(projectRoot);
      await runDurableWorkflow(projectRoot, localRunId, input);
    }

    const artifactDir = anchoredProjectPath(projectRoot, input.artifact_dir);
    const workspaceDir = anchoredProjectPath(projectRoot, input.workspace_dir);
    mergeWorkspaceArtifacts(workspaceDir, artifactDir, input.attempt_id);
    const resultPublicationMode = workerResultPublicationMode(
      projectRoot,
      input,
      durableWorkspace.hasCompletedCheckpoint
    );
    const completedCheckpoint = durableWorkspace.recordCheckpoint("completed");
    syncDurableData(projectRoot);
    cleanupStalePublicationDirectories(attemptRoot);
    publishing = path.join(attemptRoot, `.result-publishing-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
    fs.mkdirSync(publishing, { recursive: true, mode: 0o700 });
    const staging = path.join(publishing, "bundle");
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    if (resultPublicationMode === "legacy-markerless-v1") {
      copyPublishedEvidenceTree(artifactDir, path.join(staging, "artifacts"));
    } else {
      const stagedMarker = copyAttemptVerificationMarker(projectRoot, input, path.join(staging, "verification"));
      copyVerifiedPublishedEvidenceTree(artifactDir, path.join(staging, "artifacts"), stagedMarker, input.attempt_id);
    }
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
        durableWorkspace.recordCheckpoint("failed", error);
        syncDurableData(durableWorkspace.projectRoot);
      } catch {
        // Preserve the original worker failure; the durable workspace itself remains mounted on the Volume.
      }
    }
    if (publishing !== undefined) fs.rmSync(publishing, { recursive: true, force: true });
    throw error;
  }
}

export function workerResultPublicationMode(
  projectRoot: string,
  input: { run_root: string; attempt_id: string; workflow_path: string },
  hasCompletedCheckpoint: boolean
): "verified-v2" | "legacy-markerless-v1" {
  if (hasAttemptVerificationMarker(projectRoot, input)) return "verified-v2";
  if (hasCompletedCheckpoint && !workflowSupportsArtifactVerificationMarkers(projectRoot, input)) {
    return "legacy-markerless-v1";
  }
  return "verified-v2";
}

function sealedSmithersExecutable(snapshotRoot: string): string {
  const closure = readModalExecutionDependencyClosure(snapshotRoot);
  const smithers = regularSnapshotFile(snapshotRoot, closure.smithersBin, "sealed Smithers executable");
  const stat = fs.lstatSync(smithers);
  if ((stat.mode & 0o111) === 0) throw new Error("sealed Smithers executable is not executable");
  return smithers;
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
  input: ReturnType<typeof parseModalNodeWorkerInput>
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
    const smithers = sealedSmithersExecutable(snapshotAccessRoot);
    const workflowPath = regularSnapshotFile(snapshotAccessRoot, workflowRelativePath, "sealed cloud workflow");
    const environment = {
      ULTRAFUZZ_CLOUD_WORKER: "1",
      ULTRAFUZZ_ARTIFACTS_MODULE: sealedSnapshotModuleUrl(snapshotAccessRoot, "artifacts"),
      ULTRAFUZZ_RUNTIME_MODULE: sealedSnapshotModuleUrl(snapshotAccessRoot, "runtime"),
      ULTRAFUZZ_CONFIG_PATH: regularSnapshotFile(snapshotAccessRoot, "controls/ultrafuzz.toml", "sealed cloud config"),
      ULTRAFUZZ_WORKFLOW_PERSISTED_PATH: canonicalWorkflowPath
    };
    try {
      await runChecked(
        "resume-workflow",
        smithers,
        workflowCommandArguments(workflowPath, projectRoot, localRunId, input, true),
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
  const durableRequest = path.join(handoffDirectory, "request.json");
  const checkpointsDirectory = path.join(root, DURABLE_CHECKPOINT_DIRECTORY);
  const checkpointIndex = path.join(checkpointsDirectory, DURABLE_CHECKPOINT_INDEX);
  // The controller validates the published result, its durable checkpoint, and the checkpoint index
  // against the lexical data root it dispatched, so those recorded identifiers stay lexical even
  // though every path above is the canonical one the trusted-mount check produced.
  const workspaceIdentity = path.posix.join(dataRoot, DURABLE_WORKSPACE_DIRECTORY);
  const handoffArchiveIdentity = path.posix.join(dataRoot, DURABLE_INPUT_DIRECTORY, "project.tgz");

  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(handoffDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(checkpointsDirectory, { recursive: true, mode: 0o700 });
  const hasDurableHandoff = fs.existsSync(handoffArchive);
  let input: ReturnType<typeof parseModalNodeSandboxInput> & { project_archive_sha256: string };
  if (hasDurableHandoff) {
    const durable = readDurableInput(durableRequest, requestedInput);
    if (sha256File(handoffArchive) !== durable.input.project_archive_sha256) {
      throw new Error("durable cloud handoff archive digest mismatch");
    }
    input = durable.needsContentFingerprintMigration
      ? await migrateLegacyContentFingerprint(handoffArchive, durableRequest, durable.input, requestedInput)
      : durable.input;
  } else {
    input = validateFreshHandoff(archivePath, requestedInput);
  }
  const projectArchiveSha256 = input.project_archive_sha256;
  const storageLineage = `${input.run_id}/${input.attempt_id}/${input.execution_generation}`;
  const logicalDispatchFingerprint = modalNodeDispatchFingerprint(input);
  if (!hasDurableHandoff) {
    const handoffPublishing = path.join(handoffDirectory, ".project.tgz.publishing");
    writeJsonAtomic(durableRequest, input);
    if (fs.existsSync(handoffPublishing)) {
      if (sha256File(handoffPublishing) === projectArchiveSha256) {
        fs.renameSync(handoffPublishing, handoffArchive);
      } else {
        fs.rmSync(handoffPublishing, { force: true });
      }
    }
    if (!fs.existsSync(handoffArchive)) {
      fs.copyFileSync(archivePath, handoffPublishing, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(handoffPublishing, 0o600);
      fs.renameSync(handoffPublishing, handoffArchive);
    }
  }

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

  const index = loadDurableCheckpointIndex(checkpointIndex, {
    storageLineage,
    logicalDispatchFingerprint,
    projectRoot: workspaceIdentity,
    runRoot: input.run_root,
    executionSnapshotRoot: input.execution_snapshot_root,
    handoffArchive: handoffArchiveIdentity,
    archiveSha256: projectArchiveSha256
  });
  const restoreMarker = path.join(handoffDirectory, DURABLE_RESTORE_MARKER);
  let restoredFrom = readRestoreMarker(restoreMarker, path.dirname(root));
  if (restoredFrom === undefined) {
    restoredFrom = restorePriorAttemptOutputs(root, projectRoot, input);
    if (restoredFrom !== undefined) {
      writeJsonAtomic(restoreMarker, { schema_version: "ultrafuzz.modal.node-restore.v1", source_root: restoredFrom });
    }
  }
  const hasCompletedCheckpoint = index.checkpoints.some((checkpoint) => checkpoint.stage === "completed");
  return {
    projectRoot,
    attemptRoot: root,
    checkpointIndex,
    input,
    hasCompletedCheckpoint,
    recordCheckpoint(stage, error) {
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
      writeJsonAtomic(checkpointIndex, index);
      return checkpoint;
    }
  };
}

function validateFreshHandoff(
  archivePath: string,
  input: ReturnType<typeof parseModalNodeWorkerInput>
): ReturnType<typeof parseModalNodeWorkerInput> & { project_archive_sha256: string } {
  if (
    input.project_content_sha256 === undefined ||
    input.project_archive_sha256 === undefined ||
    sha256File(archivePath) !== input.project_archive_sha256
  ) {
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
    persistedInput = parseModalNodeWorkerInput(JSON.parse(fs.readFileSync(durableRequest, "utf8")) as unknown);
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
  return left.execution_generation === right.execution_generation && sameLogicalNodeDispatch(left, right);
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

function readRestoreMarker(markerPath: string, allowedParent: string): string | undefined {
  if (!fs.existsSync(markerPath)) return undefined;
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as unknown;
    if (
      isRecord(marker) &&
      marker.schema_version === "ultrafuzz.modal.node-restore.v1" &&
      typeof marker.source_root === "string" &&
      path.isAbsolute(marker.source_root) &&
      marker.source_root.startsWith(`${allowedParent}${path.sep}`)
    ) {
      return marker.source_root;
    }
  } catch {
    // Re-run restoration when an interrupted marker cannot be parsed.
  }
  return undefined;
}

function restorePriorAttemptOutputs(
  currentRoot: string,
  projectRoot: string,
  input: ReturnType<typeof parseModalNodeWorkerInput>
): string | undefined {
  const parent = path.dirname(currentRoot);
  const candidates: Array<{ root: string; mtimeMs: number; input: ReturnType<typeof parseModalNodeWorkerInput> }> = [];
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidateRoot = path.join(parent, entry.name);
    if (candidateRoot === currentRoot) continue;
    const requestPath = path.join(candidateRoot, DURABLE_INPUT_DIRECTORY, "request.json");
    try {
      const persisted = parseModalNodeWorkerInput(JSON.parse(fs.readFileSync(requestPath, "utf8")) as unknown);
      if (
        persisted.project_archive_sha256 !== undefined &&
        persisted.execution_generation !== input.execution_generation &&
        sameLogicalNodeDispatch(persisted, input) &&
        // The candidate's own durable index must record that same logical dispatch. Its request file
        // alone is a claim; the index is the evidence the workspace actually ran under it.
        priorAttemptRecordedLogicalDispatch(candidateRoot, persisted) &&
        priorAttemptHasEvidence(candidateRoot, persisted)
      ) {
        candidates.push({
          root: candidateRoot,
          mtimeMs: fs.statSync(path.join(candidateRoot, DURABLE_CHECKPOINT_DIRECTORY)).mtimeMs,
          input: persisted
        });
      }
    } catch {
      // Ignore unrelated or incomplete generation directories; the current generation remains recoverable.
    }
  }
  const prior = candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
  if (prior === undefined) return undefined;

  const priorProjectRoot = path.join(prior.root, DURABLE_WORKSPACE_DIRECTORY);
  const recoveryBase = anchoredProjectPath(
    projectRoot,
    path.join(".ultrafuzz", "recovered", path.basename(prior.root))
  );
  const sourceWorkspace = anchoredProjectPath(priorProjectRoot, input.workspace_dir);
  if (fs.existsSync(sourceWorkspace)) {
    copySafeTree(sourceWorkspace, path.join(recoveryBase, "workspace"));
  }
  for (const [label, relative] of [
    ["artifacts", input.artifact_dir],
    ["logs", path.join(input.run_root, "logs")]
  ] as const) {
    const source = anchoredProjectPath(priorProjectRoot, relative);
    if (fs.existsSync(source)) copySafeTree(source, path.join(recoveryBase, label));
  }
  const priorRecovered = anchoredProjectPath(priorProjectRoot, path.join(".ultrafuzz", "recovered"));
  if (fs.existsSync(priorRecovered)) copySafeTree(priorRecovered, path.join(recoveryBase, "previous-recovered"));
  return prior.root;
}

/**
 * True when a prior generation's durable index records the logical dispatch its request file claims.
 *
 * A restore copies another generation's workspace outputs into this attempt, so the source must be a
 * generation of this same logical dispatch by its own persisted record -- not merely by a request
 * document sitting next to it.
 */
function priorAttemptRecordedLogicalDispatch(
  candidateRoot: string,
  persisted: ReturnType<typeof parseModalNodeSandboxInput>
): boolean {
  const indexPath = path.join(candidateRoot, DURABLE_CHECKPOINT_DIRECTORY, DURABLE_CHECKPOINT_INDEX);
  if (!fs.existsSync(indexPath)) return false;
  try {
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8")) as unknown;
    return (
      isRecord(index) &&
      index.schema_version === "ultrafuzz.modal.node-checkpoint-index.v1" &&
      index.logical_dispatch_fingerprint === modalNodeDispatchFingerprint(persisted) &&
      index.storage_lineage === `${persisted.run_id}/${persisted.attempt_id}/${persisted.execution_generation}`
    );
  } catch {
    return false;
  }
}

function priorAttemptHasEvidence(candidateRoot: string, input: ReturnType<typeof parseModalNodeWorkerInput>): boolean {
  const projectRoot = path.join(candidateRoot, DURABLE_WORKSPACE_DIRECTORY);
  const candidates: string[] = [];
  for (const relative of [
    input.workspace_dir,
    input.artifact_dir,
    path.join(input.run_root, "logs"),
    path.join(".ultrafuzz", "recovered")
  ]) {
    try {
      candidates.push(anchoredProjectPath(projectRoot, relative));
    } catch {
      return false;
    }
  }
  return candidates.some((candidate) => {
    try {
      return fs.statSync(candidate).isDirectory() && fs.readdirSync(candidate).length > 0;
    } catch {
      return false;
    }
  });
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
  if (!fs.existsSync(checkpointIndex)) {
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
  const parsed = JSON.parse(fs.readFileSync(checkpointIndex, "utf8")) as unknown;
  const missingLogicalDispatchFingerprint = isRecord(parsed) && parsed.logical_dispatch_fingerprint === undefined;
  if (
    !isRecord(parsed) ||
    parsed.schema_version !== "ultrafuzz.modal.node-checkpoint-index.v1" ||
    parsed.storage_lineage !== identity.storageLineage ||
    // An existing index is only this attempt's index when it records the same logical dispatch. The
    // storage lineage alone cannot say so: it names the generation, not what the dispatch asked for.
    (!missingLogicalDispatchFingerprint &&
      parsed.logical_dispatch_fingerprint !== identity.logicalDispatchFingerprint) ||
    parsed.workspace_path !== identity.projectRoot ||
    parsed.run_root !== identity.runRoot ||
    parsed.execution_snapshot_root !== identity.executionSnapshotRoot ||
    parsed.handoff_archive !== identity.handoffArchive ||
    parsed.project_archive_sha256 !== identity.archiveSha256 ||
    !Array.isArray(parsed.checkpoints)
  ) {
    throw new Error("durable checkpoint index is invalid");
  }
  if (missingLogicalDispatchFingerprint) {
    // The previous v1 worker persisted every identity above but predated the logical fingerprint.
    // `readDurableInput` has already required the same generation and whole logical dispatch, and the
    // caller has already verified the persisted archive digest, so only that exact legacy shape may
    // be upgraded in place. A present mismatch is rejected above and is never rewritten.
    parsed.logical_dispatch_fingerprint = identity.logicalDispatchFingerprint;
    writeJsonAtomic(checkpointIndex, parsed);
  }
  return parsed as unknown as DurableCheckpointIndex;
}

function writeJsonAtomic(destination: string, value: unknown): void {
  const parent = path.dirname(destination);
  assertDurableDirectory(parent, "durable checkpoint parent");
  const publishing = path.join(parent, `.${path.basename(destination)}.${crypto.randomUUID()}.publishing`);
  const descriptor = fs.openSync(publishing, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(publishing, destination);
  syncDirectory(parent);
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
    env: { ...process.env, ...env },
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

function workerErrorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof CloudWorkerCommandError) {
    return {
      schema_version: "ultrafuzz.modal.node-worker-error.v1",
      message: error.message,
      phase: error.phase,
      command: error.command,
      exit_code: error.exitCode,
      ...(error.stdout.trim() === "" ? {} : { stdout: error.stdout.trim().slice(0, 2_000) }),
      ...(error.stderr.trim() === "" ? {} : { stderr: error.stderr.trim().slice(0, 2_000) })
    };
  }
  return {
    schema_version: "ultrafuzz.modal.node-worker-error.v1",
    message: error instanceof Error ? error.message : String(error)
  };
}

function mergeWorkspaceArtifacts(workspaceDir: string, artifactDir: string, attemptId: string): void {
  const mirror = path.join(workspaceDir, "artifacts", attemptId);
  if (!fs.existsSync(mirror)) return;
  copySafeTree(mirror, artifactDir, true);
}

export function copySafeTree(source: string, destination: string, onlyMissing = false): void {
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
      copySafeTree(sourcePath, destinationPath, onlyMissing);
    } else if (entry.isFile()) {
      const stat = fs.lstatSync(sourcePath);
      if (stat.nlink !== 1) throw new Error("cloud publication file is hard-linked");
      if (onlyMissing && fs.existsSync(destinationPath)) continue;
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.copyFileSync(sourcePath, destinationPath);
    } else {
      throw new Error("cloud publication excludes links and special files");
    }
  }
}

/**
 * Publish the complete artifact tree and verify every manifest declaration
 * against both the source tree and the staged copy.  The normal worker
 * archive must be self-contained: a terminal result is not considered
 * publishable when a declared property, harness, or provenance file is
 * missing or altered.
 */
export function copyPublishedEvidenceTree(source: string, destination: string): void {
  copySafeTree(source, destination);
  const sourceRoot = path.resolve(source);
  const destinationRoot = path.resolve(destination);
  for (const manifestPath of recursiveRegularFiles(sourceRoot).filter(
    (filePath) => path.basename(filePath) === "artifact-manifest.json" && path.dirname(filePath) === sourceRoot
  )) {
    const manifest = parsePublicationManifest(manifestPath);
    const nodeRoot = path.dirname(manifestPath);
    for (const entry of manifest.files) {
      const sourcePath = safeManifestFilePath(nodeRoot, entry.path);
      assertManifestFile(sourcePath, entry, "source");
      const relative = path.relative(sourceRoot, sourcePath);
      const destinationPath = path.resolve(destinationRoot, relative);
      if (destinationPath === destinationRoot || !destinationPath.startsWith(`${destinationRoot}${path.sep}`)) {
        throw new Error(`artifact manifest destination path escapes publication root: ${entry.path}`);
      }
      assertManifestFile(destinationPath, entry, "published");
      // Recheck the source after publication to detect a source mutation
      // between the initial digest and the staged copy.
      assertManifestFile(sourcePath, entry, "source");
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

function hasAttemptVerificationMarker(projectRoot: string, input: { run_root: string; attempt_id: string }): boolean {
  try {
    attemptVerificationMarkerSource(projectRoot, input);
    return true;
  } catch (error) {
    if (error instanceof Error && /verification marker is missing/u.test(error.message)) {
      return false;
    }
    throw error;
  }
}

function workflowSupportsArtifactVerificationMarkers(projectRoot: string, input: { workflow_path: string }): boolean {
  try {
    const workflowPath = anchoredProjectPath(projectRoot, input.workflow_path);
    const stat = fs.lstatSync(workflowPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_WORKFLOW_MARKER_PROBE_BYTES) {
      return true;
    }
    const source = fs.readFileSync(workflowPath, "utf8");
    return source.includes(ARTIFACT_VERIFICATION_SCHEMA_VERSION) || source.includes(ARTIFACT_VERIFICATION_DIRECTORY);
  } catch {
    return true;
  }
}

function readVerificationMarkerPublications(markerPath: string, attemptId: string): Map<string, string> {
  const markerFile = assertRegularUnlinkedFile(markerPath, "cloud publication verification marker is unavailable");
  const markerStat = fs.statSync(markerFile);
  if (markerStat.size === 0 || markerStat.size > MAX_VERIFICATION_MARKER_BYTES) {
    throw new Error("cloud publication verification marker size is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(markerFile, "utf8"));
  } catch (error) {
    throw new Error("cloud publication verification marker is invalid JSON", { cause: error });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as { schema_version?: unknown }).schema_version !== ARTIFACT_VERIFICATION_SCHEMA_VERSION ||
    (parsed as { attempt_id?: unknown }).attempt_id !== attemptId ||
    !Array.isArray((parsed as { publications?: unknown }).publications)
  ) {
    throw new Error("cloud publication verification marker is invalid");
  }
  const publications = new Map<string, string>();
  for (const publication of (parsed as { publications: unknown[] }).publications) {
    if (
      typeof publication !== "object" ||
      publication === null ||
      Array.isArray(publication) ||
      typeof (publication as { path?: unknown }).path !== "string" ||
      typeof (publication as { sha256?: unknown }).sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test((publication as { sha256: string }).sha256)
    ) {
      throw new Error("cloud publication verification marker publication is invalid");
    }
    const relativePath = (publication as { path: string }).path;
    assertSafeVerifiedPublicationRelativePath(relativePath);
    if (publications.has(relativePath)) {
      throw new Error(`cloud publication verification marker has duplicate publication: ${relativePath}`);
    }
    publications.set(relativePath, (publication as { sha256: string }).sha256);
  }
  if (publications.size === 0) {
    throw new Error("cloud publication verification marker has no publications");
  }
  return publications;
}

function recursiveRegularFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const stat = fs.lstatSync(fullPath);
      if (entry.isDirectory()) {
        if (stat.isSymbolicLink() || fs.realpathSync(fullPath) !== fullPath) {
          throw new Error("cloud publication source is unsafe");
        }
        visit(fullPath);
      } else if (entry.isFile() && !stat.isSymbolicLink()) {
        if (stat.nlink !== 1) throw new Error("cloud publication file is hard-linked");
        files.push(fullPath);
      } else {
        throw new Error("cloud publication excludes links and special files");
      }
    }
  };
  visit(root);
  return files;
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

function parsePublicationManifest(manifestPath: string): {
  files: Array<{ path: string; size_bytes: number; sha256: string }>;
} {
  const manifestStat = fs.lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.nlink !== 1) {
    throw new Error(`artifact manifest is unsafe: ${manifestPath}`);
  }
  if (manifestStat.size > MAX_PUBLICATION_MANIFEST_BYTES) {
    throw new Error(`artifact manifest exceeds the size limit: ${manifestPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`artifact manifest is not valid JSON: ${manifestPath}`, { cause: error });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Array.isArray((parsed as { files?: unknown }).files)
  ) {
    throw new Error(`artifact manifest is missing its files array: ${manifestPath}`);
  }
  const files = (parsed as { files: unknown[] }).files;
  if (files.length === 0) {
    throw new Error(`artifact manifest must declare at least one file: ${manifestPath}`);
  }
  if (files.length > MAX_PUBLICATION_MANIFEST_ENTRIES) {
    throw new Error(`artifact manifest has too many file entries: ${manifestPath}`);
  }
  const paths = new Set<string>();
  for (const entry of files) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      typeof (entry as { path?: unknown }).path !== "string" ||
      !Number.isSafeInteger((entry as { size_bytes?: unknown }).size_bytes) ||
      ((entry as { size_bytes: number }).size_bytes ?? -1) < 0 ||
      typeof (entry as { sha256?: unknown }).sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test((entry as { sha256: string }).sha256) ||
      typeof (entry as { provenance?: unknown }).provenance !== "object" ||
      (entry as { provenance?: unknown }).provenance === null ||
      typeof (entry as { provenance?: { producer_node_id?: unknown } }).provenance?.producer_node_id !== "string" ||
      (entry as { provenance: { producer_node_id: string } }).provenance.producer_node_id.length === 0
    ) {
      throw new Error(`artifact manifest entry is invalid: ${manifestPath}`);
    }
    const relativePath = (entry as { path: string }).path;
    if (paths.has(relativePath)) {
      throw new Error(`artifact manifest contains duplicate file path: ${manifestPath}`);
    }
    paths.add(relativePath);
  }
  return { files: files as Array<{ path: string; size_bytes: number; sha256: string }> };
}

function safeManifestFilePath(nodeRoot: string, relativePath: string): string {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    path.isAbsolute(relativePath) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u.test(relativePath)
  ) {
    throw new Error(`unsafe artifact manifest path: ${relativePath}`);
  }
  const normalized = path.normalize(relativePath);
  if (
    normalized !== relativePath ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`unsafe artifact manifest path: ${relativePath}`);
  }
  const resolvedRoot = path.resolve(nodeRoot);
  const resolved = path.resolve(resolvedRoot, normalized);
  if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`unsafe artifact manifest path: ${relativePath}`);
  }
  return resolved;
}

function assertManifestFile(
  filePath: string,
  entry: { path: string; size_bytes: number; sha256: string },
  label: string
): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw new Error(`artifact manifest file is unavailable in ${label}: ${entry.path}`, { cause: error });
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`artifact manifest file is unsafe in ${label}: ${entry.path}`);
  }
  if (stat.size !== entry.size_bytes || sha256File(filePath) !== entry.sha256) {
    throw new Error(`artifact manifest file digest mismatch in ${label}: ${entry.path}`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    process.stderr.write(`${JSON.stringify(workerErrorPayload(error))}\n`);
    process.exitCode = 1;
  });
}
