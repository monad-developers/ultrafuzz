import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import { parseModalNodeSandboxInput } from "./node-provider.js";
import { extractSafeTarArchive, sha256File } from "./safe-archive.js";

const DURABLE_WORKSPACE_DIRECTORY = "workspace";
const DURABLE_INPUT_DIRECTORY = "input";
const DURABLE_CHECKPOINT_DIRECTORY = "checkpoints";
const DURABLE_CHECKPOINT_INDEX = "index.json";
const DURABLE_RESTORE_MARKER = "restore.json";
const MAX_PUBLICATION_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_PUBLICATION_MANIFEST_ENTRIES = 4_096;

type DurableCheckpointStage = "prepared" | "running" | "failed" | "completed";

interface DurableCheckpointRecord {
  schema_version: "ultrafuzz.modal.node-checkpoint.v1";
  checkpoint_id: string;
  sequence: number;
  stage: DurableCheckpointStage;
  created_at: string;
  storage_lineage: string;
  workspace_path: string;
  run_root: string;
  handoff_archive: string;
  project_archive_sha256: string;
  restored_from?: string;
  error?: string;
}

interface DurableCheckpointIndex {
  schema_version: "ultrafuzz.modal.node-checkpoint-index.v1";
  storage_lineage: string;
  workspace_path: string;
  run_root: string;
  handoff_archive: string;
  project_archive_sha256: string;
  checkpoints: Array<
    Pick<DurableCheckpointRecord, "checkpoint_id" | "sequence" | "stage" | "created_at"> & { manifest: string }
  >;
}

export interface DurableNodeWorkspace {
  projectRoot: string;
  checkpointIndex: string;
  input: ReturnType<typeof parseModalNodeSandboxInput>;
  hasCompletedCheckpoint: boolean;
  recordCheckpoint(stage: DurableCheckpointStage, error?: unknown): DurableCheckpointRecord;
}

async function main(): Promise<void> {
  const requestPath = requiredOption("--request");
  const archivePath = requiredOption("--project-archive");
  const dataRoot = requiredOption("--data-root");
  const requestedInput = parseModalNodeSandboxInput(JSON.parse(fs.readFileSync(requestPath, "utf8")) as unknown);
  let durableWorkspace: DurableNodeWorkspace | undefined;
  let publishing: string | undefined;
  try {
    durableWorkspace = await initializeDurableNodeWorkspace(dataRoot, archivePath, requestedInput);
    const input = durableWorkspace.input;
    const projectRoot = durableWorkspace.projectRoot;
    if (!durableWorkspace.hasCompletedCheckpoint) {
      durableWorkspace.recordCheckpoint("prepared");
    }
    syncDurableData(projectRoot);
    if (!durableWorkspace.hasCompletedCheckpoint) {
      await runChecked(
        "install-smithers",
        "npm",
        [
          "install",
          "--prefix",
          path.join(projectRoot, ".smithers"),
          "--ignore-scripts",
          "--package-lock=false",
          "--no-audit",
          "--no-fund",
          "--loglevel=error"
        ],
        projectRoot
      );
    }
    const workflowPath = anchoredProjectPath(projectRoot, input.workflow_path);
    const localRunId = `${input.run_id}-${crypto.createHash("sha256").update(input.task_id).digest("hex").slice(0, 12)}`;
    const smithers = path.join(projectRoot, ".smithers", "node_modules", ".bin", "smithers");
    if (!durableWorkspace.hasCompletedCheckpoint) {
      durableWorkspace.recordCheckpoint("running");
      syncDurableData(projectRoot);
      await runDurableWorkflow(smithers, workflowPath, projectRoot, localRunId, input);
    }

    const artifactDir = anchoredProjectPath(projectRoot, input.artifact_dir);
    const workspaceDir = anchoredProjectPath(projectRoot, input.workspace_dir);
    mergeWorkspaceArtifacts(workspaceDir, artifactDir, input.attempt_id);
    const completedCheckpoint = durableWorkspace.recordCheckpoint("completed");
    syncDurableData(projectRoot);
    publishing = path.join(dataRoot, `.result-publishing-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
    fs.mkdirSync(publishing, { recursive: true, mode: 0o700 });
    const staging = path.join(publishing, "bundle");
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    copyPublishedEvidenceTree(artifactDir, path.join(staging, "artifacts"));
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
        schema_version: "ultrafuzz.modal.node-result.v1",
        status: "succeeded",
        artifact_archive: path.posix.join(dataRoot, "artifacts.tgz"),
        artifact_sha256: digest,
        storage_lineage: `${input.run_id}/${input.attempt_id}/${input.execution_generation}`,
        durable_checkpoint: path.posix.join(
          dataRoot,
          DURABLE_CHECKPOINT_DIRECTORY,
          `${completedCheckpoint.checkpoint_id}.json`
        ),
        durable_checkpoint_index: durableWorkspace.checkpointIndex
      })}\n`,
      { mode: 0o600 }
    );
    const publicationLock = path.join(dataRoot, ".result-publishing.lock");
    let lockFd: number | undefined;
    try {
      try {
        lockFd = fs.openSync(publicationLock, "wx", 0o600);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        const lockStat = fs.lstatSync(publicationLock);
        if (Date.now() - lockStat.mtimeMs < 60 * 60 * 1000) throw error;
        fs.unlinkSync(publicationLock);
        lockFd = fs.openSync(publicationLock, "wx", 0o600);
      }
      fs.writeFileSync(lockFd, `${process.pid}\n`);
      replacePublishedFile(artifactArchive, path.join(dataRoot, "artifacts.tgz"));
      replacePublishedFile(path.join(publishing, "result.json"), path.join(dataRoot, "result.json"));
    } finally {
      if (lockFd !== undefined) fs.closeSync(lockFd);
      try {
        fs.unlinkSync(publicationLock);
      } catch {
        // Preserve the publication result if lock cleanup races with a failed worker.
      }
    }
    fs.rmSync(publishing, { recursive: true, force: true });
    publishing = undefined;
    syncDurableData(dataRoot);
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

export async function runDurableWorkflow(
  smithers: string,
  workflowPath: string,
  projectRoot: string,
  localRunId: string,
  input: ReturnType<typeof parseModalNodeSandboxInput>
): Promise<void> {
  const environment = {
    ULTRAFUZZ_CLOUD_WORKER: "1",
    ULTRAFUZZ_ARTIFACTS_MODULE: "file:///opt/ultrafuzz/packages/artifacts/dist/index.js",
    ULTRAFUZZ_RUNTIME_MODULE: "file:///opt/ultrafuzz/packages/runtime/dist/index.js"
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
    if (!isMissingWorkflowRun(error)) throw error;
    await runChecked(
      "run-workflow",
      smithers,
      workflowCommandArguments(workflowPath, projectRoot, localRunId, input, false),
      projectRoot,
      environment
    );
  }
}

export function workflowCommandArguments(
  workflowPath: string,
  projectRoot: string,
  localRunId: string,
  input: ReturnType<typeof parseModalNodeSandboxInput>,
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
      cloud_worker: true,
      task_id: input.task_id,
      ...(input.operator_prompt === undefined ? {} : { operator_prompt: input.operator_prompt })
    }),
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

export async function initializeDurableNodeWorkspace(
  dataRoot: string,
  archivePath: string,
  requestedInput: ReturnType<typeof parseModalNodeSandboxInput>
): Promise<DurableNodeWorkspace> {
  const root = resolveDurableDataRoot(dataRoot);
  const projectRoot = path.join(root, DURABLE_WORKSPACE_DIRECTORY);
  const handoffDirectory = path.join(root, DURABLE_INPUT_DIRECTORY);
  const handoffArchive = path.join(handoffDirectory, "project.tgz");
  const durableRequest = path.join(handoffDirectory, "request.json");
  const checkpointsDirectory = path.join(root, DURABLE_CHECKPOINT_DIRECTORY);
  const checkpointIndex = path.join(checkpointsDirectory, DURABLE_CHECKPOINT_INDEX);

  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(handoffDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(checkpointsDirectory, { recursive: true, mode: 0o700 });
  const hasDurableHandoff = fs.existsSync(handoffArchive);
  const input = hasDurableHandoff
    ? readDurableInput(durableRequest, requestedInput)
    : validateFreshHandoff(archivePath, requestedInput);
  const projectArchiveSha256 = input.project_archive_sha256;
  const storageLineage = `${input.run_id}/${input.attempt_id}/${input.execution_generation}`;
  if (hasDurableHandoff) {
    if (sha256File(handoffArchive) !== projectArchiveSha256) {
      throw new Error("durable cloud handoff archive digest mismatch");
    }
  } else {
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
  } else {
    const staging = path.join(root, `.workspace-publishing-${crypto.randomUUID()}`);
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    try {
      await extractSafeTarArchive(handoffArchive, staging, { gzip: true, label: "cloud handoff" });
      assertSafeTree(staging);
      fs.renameSync(staging, projectRoot);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  const index = loadDurableCheckpointIndex(
    checkpointIndex,
    storageLineage,
    projectRoot,
    input.run_root,
    handoffArchive,
    projectArchiveSha256
  );
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
        workspace_path: projectRoot,
        run_root: input.run_root,
        handoff_archive: handoffArchive,
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
        manifest: manifestPath
      });
      writeJsonAtomic(checkpointIndex, index);
      return checkpoint;
    }
  };
}

function validateFreshHandoff(
  archivePath: string,
  input: ReturnType<typeof parseModalNodeSandboxInput>
): ReturnType<typeof parseModalNodeSandboxInput> & { project_archive_sha256: string } {
  if (input.project_archive_sha256 === undefined || sha256File(archivePath) !== input.project_archive_sha256) {
    throw new Error("cloud handoff archive digest mismatch");
  }
  return input as ReturnType<typeof parseModalNodeSandboxInput> & { project_archive_sha256: string };
}

function readDurableInput(
  durableRequest: string,
  requestedInput: ReturnType<typeof parseModalNodeSandboxInput>
): ReturnType<typeof parseModalNodeSandboxInput> & { project_archive_sha256: string } {
  let persistedInput: ReturnType<typeof parseModalNodeSandboxInput>;
  try {
    persistedInput = parseModalNodeSandboxInput(JSON.parse(fs.readFileSync(durableRequest, "utf8")) as unknown);
  } catch (error) {
    throw new Error("durable cloud handoff request is unavailable", { cause: error });
  }
  if (persistedInput.project_archive_sha256 === undefined || !sameResumableNodeInput(persistedInput, requestedInput)) {
    throw new Error("durable workspace request does not match this cloud node attempt");
  }
  return persistedInput as ReturnType<typeof parseModalNodeSandboxInput> & { project_archive_sha256: string };
}

function sameResumableNodeInput(
  left: ReturnType<typeof parseModalNodeSandboxInput>,
  right: ReturnType<typeof parseModalNodeSandboxInput>,
  ignoreExecutionGeneration = false
): boolean {
  return (
    left.schema_version === right.schema_version &&
    left.run_id === right.run_id &&
    left.task_id === right.task_id &&
    left.attempt_id === right.attempt_id &&
    (ignoreExecutionGeneration || left.execution_generation === right.execution_generation) &&
    left.workflow_path === right.workflow_path &&
    left.prompt_path === right.prompt_path &&
    left.run_root === right.run_root &&
    left.artifact_dir === right.artifact_dir &&
    left.workspace_dir === right.workspace_dir &&
    sameStrings(left.dependency_artifact_dirs, right.dependency_artifact_dirs) &&
    left.resources.cpu === right.resources.cpu &&
    left.resources.memory_mib === right.resources.memory_mib &&
    left.resources.timeout_seconds === right.resources.timeout_seconds &&
    sameStrings(left.agent_credential_env, right.agent_credential_env) &&
    left.operator_prompt === right.operator_prompt
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
  input: ReturnType<typeof parseModalNodeSandboxInput>
): string | undefined {
  const parent = path.dirname(currentRoot);
  const candidates: Array<{ root: string; mtimeMs: number; input: ReturnType<typeof parseModalNodeSandboxInput> }> = [];
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidateRoot = path.join(parent, entry.name);
    if (candidateRoot === currentRoot) continue;
    const requestPath = path.join(candidateRoot, DURABLE_INPUT_DIRECTORY, "request.json");
    try {
      const persisted = parseModalNodeSandboxInput(JSON.parse(fs.readFileSync(requestPath, "utf8")) as unknown);
      if (
        persisted.project_archive_sha256 !== undefined &&
        persisted.execution_generation !== input.execution_generation &&
        sameResumableNodeInput(persisted, input, true) &&
        fs.existsSync(path.join(candidateRoot, DURABLE_CHECKPOINT_DIRECTORY, DURABLE_CHECKPOINT_INDEX)) &&
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

function priorAttemptHasEvidence(candidateRoot: string, input: ReturnType<typeof parseModalNodeSandboxInput>): boolean {
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

function resolveDurableDataRoot(dataRoot: string): string {
  const root = path.resolve(dataRoot);
  if (root === path.parse(root).root) throw new Error("cloud durable data root is unsafe");
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
  storageLineage: string,
  projectRoot: string,
  runRoot: string,
  handoffArchive: string,
  archiveSha256: string
): DurableCheckpointIndex {
  if (!fs.existsSync(checkpointIndex)) {
    return {
      schema_version: "ultrafuzz.modal.node-checkpoint-index.v1",
      storage_lineage: storageLineage,
      workspace_path: projectRoot,
      run_root: runRoot,
      handoff_archive: handoffArchive,
      project_archive_sha256: archiveSha256,
      checkpoints: []
    };
  }
  const parsed = JSON.parse(fs.readFileSync(checkpointIndex, "utf8")) as unknown;
  if (
    !isRecord(parsed) ||
    parsed.schema_version !== "ultrafuzz.modal.node-checkpoint-index.v1" ||
    parsed.storage_lineage !== storageLineage ||
    parsed.workspace_path !== projectRoot ||
    parsed.run_root !== runRoot ||
    parsed.handoff_archive !== handoffArchive ||
    parsed.project_archive_sha256 !== archiveSha256 ||
    !Array.isArray(parsed.checkpoints)
  ) {
    throw new Error("durable checkpoint index is invalid");
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
  env: Record<string, string> = {}
): Promise<void> {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout = readBoundedText(child.stdout);
  const stderr = readBoundedText(child.stderr);
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  const [stdoutText, stderrText] = await Promise.all([stdout, stderr]);
  if (exitCode !== 0) {
    throw new CloudWorkerCommandError(phase, path.basename(command), exitCode, stdoutText, stderrText);
  }
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
  for (const manifestPath of recursiveRegularFiles(sourceRoot).filter((filePath) => {
    if (path.basename(filePath) !== "artifact-manifest.json") return false;
    const parentRelative = path.relative(sourceRoot, path.dirname(filePath));
    return parentRelative === "" || parentRelative.split(path.sep).length === 1;
  })) {
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
      !/^[a-f0-9]{64}$/u.test((entry as { sha256: string }).sha256)
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
    !/^[A-Za-z0-9._/-]+$/u.test(relativePath)
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
