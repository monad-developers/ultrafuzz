import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assertNoSymlinkComponents, assertPathInside, assertRegularFileInside } from "@ultrafuzz/artifacts";
import { MAX_EXPANDED_TOPOLOGY_NODES } from "@ultrafuzz/topology";

const fullCommit = /^[0-9a-f]{40}$/u;
const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const dimensionId = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;
const sha256Digest = /^[0-9a-f]{64}$/u;
const MAX_ATTESTED_TASKS = MAX_EXPANDED_TOPOLOGY_NODES;
const MAX_GIT_LIST_BYTES = 16 * 1024 * 1024;
const MAX_DERIVED_TRACKED_PATH_BYTES = 16 * 1024 * 1024;
const TRACKED_FILE_HASH_BUFFER_BYTES = 64 * 1024;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const DEFAULT_WORKSPACE_VERIFICATION_LIMITS: WorkspaceProvenanceVerificationLimits = {
  maxElapsedMilliseconds: 120_000,
  maxGitListingBytes: MAX_GIT_LIST_BYTES,
  maxGitlinkDepth: 16,
  maxGitlinks: 256,
  maxTrackedBytes: 1024 * 1024 * 1024,
  maxTrackedEntries: 100_000
};
// These exact top-level directories are native package-manager, compiler, and
// test-runner output. They may be large and are intentionally allowed between
// retries, but repository-controlled ignore rules do not expand this list.
const NATIVE_TOOL_OUTPUT_PREFIXES = [
  ".build/",
  ".cache/",
  ".pytest_cache/",
  ".venv/",
  "__pycache__/",
  "build/",
  "cache/",
  "dist/",
  "node_modules/",
  "out/"
] as const;

export const NATIVE_TOOL_OUTPUT_ROOTS = NATIVE_TOOL_OUTPUT_PREFIXES.map((prefix) => prefix.slice(0, -1));

function compareCanonicalAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export const LEGACY_WORKSPACE_SOURCE_CLAIM_SCHEMA_VERSION = "ultrafuzz.workspace-source-attestation.v1" as const;
export const LEGACY_WORKSPACE_SOURCE_CLAIM_FILE = "ultrafuzz-workspace-source-claim.json" as const;
export const WORKSPACE_SOURCE_ATTESTATION_SCHEMA_VERSION = "ultrafuzz.workspace-source-attestation.v2" as const;
export const WORKSPACE_SOURCE_ATTESTATION_FILE = "ultrafuzz-workspace-source-attestation.json" as const;

export interface WorkspaceBaseProvenance {
  baseCommit: string;
  initialHead: string;
}

export interface AgentWorkspaceProvenance extends WorkspaceBaseProvenance {
  agentRootVerified: true;
  trackedClean: true;
}

export interface LegacyWorkspaceSourceClaimTask {
  attempt_id: string;
  node_id: string;
  expected_base_commit: string;
  initial_head: string;
  agent_root_verified: true;
  tracked_clean: true;
}

export interface LegacyWorkspaceSourceClaim {
  schema_version: typeof LEGACY_WORKSPACE_SOURCE_CLAIM_SCHEMA_VERSION;
  target_revision: string;
  task_count: number;
  tasks: LegacyWorkspaceSourceClaimTask[];
}

export interface WorkspaceSourceAttestationTask extends LegacyWorkspaceSourceClaimTask {
  ledger_attempt_id: string;
  workflow_run_id: string;
  workflow_execution_id: string;
  controller_invocation_id: string;
  checkpoint_generation_id: string;
  executor_retry_id: string;
  verifier_task_id: string;
  verifier_receipt_digest: string;
  smithers_output_path: string;
  smithers_output_sha256: string;
  output_manifest_digest: string;
}

export interface WorkspaceSourceAttestation {
  schema_version: typeof WORKSPACE_SOURCE_ATTESTATION_SCHEMA_VERSION;
  target_revision: string;
  task_count: number;
  tasks: WorkspaceSourceAttestationTask[];
}

export interface ExpectedWorkspaceSourceTask {
  attemptId: string;
  nodeId: string;
}

export interface WorkspaceProvenanceVerificationLimits {
  maxElapsedMilliseconds: number;
  maxGitListingBytes: number;
  maxGitlinkDepth: number;
  maxGitlinks: number;
  maxTrackedBytes: number;
  maxTrackedEntries: number;
}

interface WorkspaceVerificationBudget {
  derivedPathBytes: number;
  derivedPaths: Set<string>;
  gitListingBytes: number;
  gitlinks: number;
  limits: WorkspaceProvenanceVerificationLimits;
  startedAtNanoseconds: bigint;
  trackedBytes: bigint;
  trackedEntries: number;
}

class WorkspaceVerificationBudgetError extends Error {
  constructor(message: string) {
    super(`workspace-provenance failure: ${message}`);
    this.name = "WorkspaceVerificationBudgetError";
  }
}

interface HeadTrackedEntry {
  mode: "100644" | "100755" | "120000" | "160000";
  type: "blob" | "commit";
  objectId: string;
  relativePath: string;
}

interface TrackedRepositorySnapshot {
  allowedUntrackedRoots: readonly string[];
  entries: TrackedPathSnapshot[];
  expectedCommit: string;
  headEntries: HeadTrackedEntry[];
  rootStat: BigIntStats;
  workspaceRoot: string;
}

interface TrackedEntryIdentity {
  candidate: string;
  entry: HeadTrackedEntry;
  stat: BigIntStats;
}

type TrackedPathSnapshot =
  | {
      candidate: string;
      kind: "regular";
      stat: BigIntStats;
      workspaceRoot: string;
    }
  | {
      candidate: string;
      contents: Buffer;
      kind: "symlink";
      stat: BigIntStats;
      workspaceRoot: string;
    }
  | {
      candidate: string;
      kind: "gitlink";
      repository: TrackedRepositorySnapshot;
      stat: BigIntStats;
      workspaceRoot: string;
    };

export function resolveCheckedOutCommit(
  repositoryPath: string,
  verificationLimits: Partial<WorkspaceProvenanceVerificationLimits> = {}
): string {
  return resolveCheckedOutCommitWithinBudget(repositoryPath, createWorkspaceVerificationBudget(verificationLimits));
}

function resolveCheckedOutCommitWithinBudget(repositoryPath: string, budget: WorkspaceVerificationBudget): string {
  return resolveCheckedOutCommitInternal(repositoryPath, budget);
}

function resolveCheckedOutCommitInternal(repositoryPath: string, budget: WorkspaceVerificationBudget): string {
  const repositoryRoot = realpathSync(path.resolve(repositoryPath));
  let revision: string;
  try {
    const resolve = (timeout: number) =>
      execFileSync("git", trustedGitArguments(["rev-parse", "--verify", "HEAD^{commit}"]), {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: gitWorkspaceEnvironment(repositoryRoot),
        stdio: ["ignore", "pipe", "pipe"],
        timeout
      });
    revision = runGitWithinVerificationBudget(budget, resolve);
  } catch (error) {
    if (error instanceof WorkspaceVerificationBudgetError) throw error;
    throw new Error("workspace-provenance failure: could not resolve the checked-out source commit", {
      cause: error
    });
  }
  const normalized = revision.trim().toLowerCase();
  if (!fullCommit.test(normalized)) {
    throw new Error("workspace-provenance failure: checked-out source commit is invalid");
  }
  return normalized;
}

export function assertWorkspaceBaseCommit(
  workspacePath: string,
  expectedBaseCommit: string,
  verificationLimits: Partial<WorkspaceProvenanceVerificationLimits> = {}
): WorkspaceBaseProvenance {
  const budget = createWorkspaceVerificationBudget(verificationLimits);
  return assertWorkspaceBaseCommitWithinBudget(workspacePath, expectedBaseCommit, budget);
}

function assertWorkspaceBaseCommitWithinBudget(
  workspacePath: string,
  expectedBaseCommit: string,
  budget: WorkspaceVerificationBudget
): WorkspaceBaseProvenance {
  const normalizedExpected = expectedBaseCommit.trim().toLowerCase();
  if (!fullCommit.test(normalizedExpected)) {
    throw new Error("workspace-provenance failure: expected source commit is invalid");
  }
  const initialHead = resolveCheckedOutCommitWithinBudget(workspacePath, budget);
  if (initialHead !== normalizedExpected) {
    throw new Error(`workspace-provenance failure: worktree started at ${initialHead}, expected ${normalizedExpected}`);
  }
  return { baseCommit: normalizedExpected, initialHead };
}

export function assertAgentWorkspaceProvenance(
  workspacePath: string,
  expectedBaseCommit: string,
  agentRoot: string | undefined,
  allowedUntrackedRoots: readonly string[] = [],
  verificationLimits: Partial<WorkspaceProvenanceVerificationLimits> = {}
): AgentWorkspaceProvenance {
  const workspaceRoot = realpathSync(path.resolve(workspacePath));
  if (agentRoot === undefined || realpathSync(agentRoot) !== workspaceRoot) {
    throw new Error("workspace-provenance failure: agent root does not match its task worktree");
  }
  const budget = createWorkspaceVerificationBudget(verificationLimits);
  const base = assertWorkspaceBaseCommitWithinBudget(workspaceRoot, expectedBaseCommit, budget);
  assertTrackedFilesMatchCommit(workspaceRoot, base.baseCommit, allowedUntrackedRoots, budget);
  return {
    ...base,
    agentRootVerified: true,
    trackedClean: true
  };
}

export function assertSingleLinkRegularFile(
  filePath: string,
  failureMessage = "workspace-provenance failure: artifact file is unsafe"
): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    throw new Error(failureMessage, { cause: error });
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(failureMessage);
  }
}

export function cleanWorkspaceOutputRootsForRetry(
  workspacePath: string,
  workspaceRelativeRoots: readonly string[]
): void {
  const workspaceRoot = realpathSync(path.resolve(workspacePath));
  const budget = createWorkspaceVerificationBudget({});
  for (const relativeRoot of new Set(workspaceRelativeRoots)) {
    assertVerificationWithinElapsedLimit(budget);
    if (relativeRoot.length === 0 || path.isAbsolute(relativeRoot)) {
      throw new Error("workspace-provenance failure: retry output root is invalid");
    }
    const candidate = path.resolve(workspaceRoot, relativeRoot);
    if (!candidate.startsWith(`${workspaceRoot}${path.sep}`)) {
      throw new Error("workspace-provenance failure: retry output root escapes the task worktree");
    }
    const stat = lstatSync(candidate);
    const resolved = realpathSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink() || resolved !== candidate) {
      throw new Error("workspace-provenance failure: retry output root is unsafe");
    }
    const gitRelativeRoot = path.relative(workspaceRoot, resolved).split(path.sep).join("/");
    try {
      runGitWithinVerificationBudget(budget, (timeout) =>
        execFileSync("git", trustedGitArguments(["clean", "-ffdx", "--", `:(literal)${gitRelativeRoot}`]), {
          cwd: workspaceRoot,
          env: gitWorkspaceEnvironment(workspaceRoot),
          stdio: "ignore",
          timeout
        })
      );
    } catch (error) {
      if (error instanceof WorkspaceVerificationBudgetError) throw error;
      throw new Error("workspace-provenance failure: could not clean retry output root", { cause: error });
    }
  }
}

/**
 * Remove mutable native tool output before each model invocation.
 *
 * These roots are deliberately allowed by the post-invocation provenance
 * check, so accepting bytes left by an earlier retry (or pre-seeded before
 * attempt one) would let mutable compiler/package-manager state influence an
 * otherwise clean attempt. Git's literal pathspec preserves tracked files;
 * the pre/post identity checks keep the cleanup anchored to the task worktree.
 */
export function cleanNativeWorkspaceOutputRoots(workspacePath: string): void {
  const workspaceRoot = realpathSync(path.resolve(workspacePath));
  const budget = createWorkspaceVerificationBudget({});
  for (const relativeRoot of NATIVE_TOOL_OUTPUT_ROOTS) {
    assertVerificationWithinElapsedLimit(budget);
    const candidate = path.join(workspaceRoot, relativeRoot);
    assertOptionalAnchoredDirectory(workspaceRoot, candidate, "native tool output root");
    try {
      runGitWithinVerificationBudget(budget, (timeout) =>
        execFileSync("git", trustedGitArguments(["clean", "-ffdx", "--", `:(literal)${relativeRoot}`]), {
          cwd: workspaceRoot,
          env: gitWorkspaceEnvironment(workspaceRoot),
          stdio: "ignore",
          timeout
        })
      );
    } catch (error) {
      if (error instanceof WorkspaceVerificationBudgetError) throw error;
      throw new Error("workspace-provenance failure: could not clean native tool output root", { cause: error });
    }
    assertOptionalAnchoredDirectory(workspaceRoot, candidate, "cleaned native tool output root");
  }
}

function assertOptionalAnchoredDirectory(workspaceRoot: string, candidate: string, label: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`workspace-provenance failure: ${label} is unsafe`, { cause: error });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`workspace-provenance failure: ${label} is unsafe`);
  }
  let resolved: string;
  try {
    assertNoSymlinkComponents(workspaceRoot, candidate, label);
    resolved = realpathSync(candidate);
  } catch (error) {
    throw new Error(`workspace-provenance failure: ${label} is unsafe`, { cause: error });
  }
  if (resolved !== candidate || !resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error(`workspace-provenance failure: ${label} escapes the task worktree`);
  }
}

/**
 * Persist the runner-internal v1 source claim used while the generated DAG is
 * still executing. It is intentionally stored under a different file name
 * from the publishable v2 attestation and is never valid public evidence.
 */
export function persistLegacyWorkspaceSourceClaim(input: {
  artifactDir: string;
  targetRevision: string;
  current: ExpectedWorkspaceSourceTask & { workspace: AgentWorkspaceProvenance };
  dependencyArtifactDirs: readonly string[];
  expectedTasks: readonly ExpectedWorkspaceSourceTask[];
}): LegacyWorkspaceSourceClaim {
  const targetRevision = normalizeCommit(input.targetRevision, "source attestation target");
  const tasks = new Map<string, LegacyWorkspaceSourceClaimTask>();
  for (const dependencyArtifactDir of input.dependencyArtifactDirs) {
    const dependency = readLegacyWorkspaceSourceClaim({
      artifactDir: dependencyArtifactDir,
      targetRevision
    });
    for (const entry of dependency.tasks) {
      const existing = tasks.get(entry.attempt_id);
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(entry)) {
        throw new Error(`workspace-provenance failure: contradictory attestation for ${entry.attempt_id}`);
      }
      tasks.set(entry.attempt_id, entry);
    }
  }
  tasks.set(input.current.attemptId, {
    attempt_id: input.current.attemptId,
    node_id: input.current.nodeId,
    expected_base_commit: input.current.workspace.baseCommit,
    initial_head: input.current.workspace.initialHead,
    agent_root_verified: input.current.workspace.agentRootVerified,
    tracked_clean: input.current.workspace.trackedClean
  });
  const attestation: LegacyWorkspaceSourceClaim = {
    schema_version: LEGACY_WORKSPACE_SOURCE_CLAIM_SCHEMA_VERSION,
    target_revision: targetRevision,
    task_count: tasks.size,
    tasks: [...tasks.values()].sort((left, right) => compareCanonicalAscii(left.attempt_id, right.attempt_id))
  };
  assertLegacyWorkspaceSourceClaimClosure(attestation, input.expectedTasks);
  writeLegacyWorkspaceSourceClaim(input.artifactDir, attestation);
  return attestation;
}

export function readLegacyWorkspaceSourceClaim(input: {
  artifactDir: string;
  targetRevision: string;
  expectedTasks?: readonly ExpectedWorkspaceSourceTask[];
}): LegacyWorkspaceSourceClaim {
  const targetRevision = normalizeCommit(input.targetRevision, "source attestation target");
  const artifactRoot = canonicalArtifactRoot(input.artifactDir);
  const attestationPath = path.join(artifactRoot, LEGACY_WORKSPACE_SOURCE_CLAIM_FILE);
  assertRegularFileInside(artifactRoot, attestationPath, "legacy workspace source claim");
  if (lstatSync(attestationPath).nlink !== 1) {
    throw new Error("workspace-provenance failure: legacy source claim cannot be hard-linked");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(attestationPath, "utf8"));
  } catch (error) {
    throw new Error("workspace-provenance failure: legacy source claim is not valid JSON", { cause: error });
  }
  const attestation = parseLegacyWorkspaceSourceClaim(parsed, targetRevision);
  if (input.expectedTasks !== undefined) {
    assertLegacyWorkspaceSourceClaimClosure(attestation, input.expectedTasks);
  }
  return attestation;
}

export function writeLegacyWorkspaceSourceClaim(artifactDir: string, attestation: LegacyWorkspaceSourceClaim): void {
  const targetRevision = normalizeCommit(attestation.target_revision, "source attestation target");
  const parsed = parseLegacyWorkspaceSourceClaim(attestation, targetRevision);
  writeCanonicalAttestationFile(artifactDir, LEGACY_WORKSPACE_SOURCE_CLAIM_FILE, parsed, "legacy source claim");
}

export function persistWorkspaceSourceAttestation(input: {
  artifactDir: string;
  targetRevision: string;
  current: WorkspaceSourceAttestationTask;
  dependencyArtifactDirs: readonly string[];
  expectedTasks: readonly ExpectedWorkspaceSourceTask[];
}): WorkspaceSourceAttestation {
  const targetRevision = normalizeCommit(input.targetRevision, "source attestation target");
  const tasks = new Map<string, WorkspaceSourceAttestationTask>();
  for (const dependencyArtifactDir of input.dependencyArtifactDirs) {
    const dependency = readWorkspaceSourceAttestation({ artifactDir: dependencyArtifactDir, targetRevision });
    for (const entry of dependency.tasks) {
      const existing = tasks.get(entry.attempt_id);
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(entry)) {
        throw new Error(`workspace-provenance failure: contradictory attestation for ${entry.attempt_id}`);
      }
      tasks.set(entry.attempt_id, entry);
    }
  }
  const current = parseWorkspaceSourceAttestationTask(input.current, targetRevision, "current");
  const existingCurrent = tasks.get(current.attempt_id);
  if (existingCurrent !== undefined && JSON.stringify(existingCurrent) !== JSON.stringify(current)) {
    throw new Error(`workspace-provenance failure: contradictory attestation for ${current.attempt_id}`);
  }
  tasks.set(current.attempt_id, current);
  const attestation: WorkspaceSourceAttestation = {
    schema_version: WORKSPACE_SOURCE_ATTESTATION_SCHEMA_VERSION,
    target_revision: targetRevision,
    task_count: tasks.size,
    tasks: [...tasks.values()].sort((left, right) => compareCanonicalAscii(left.attempt_id, right.attempt_id))
  };
  assertWorkspaceSourceAttestationClosure(attestation, input.expectedTasks);
  writeWorkspaceSourceAttestation(input.artifactDir, attestation);
  return attestation;
}

export function readWorkspaceSourceAttestation(input: {
  artifactDir: string;
  targetRevision: string;
  expectedTasks?: readonly ExpectedWorkspaceSourceTask[];
}): WorkspaceSourceAttestation {
  const targetRevision = normalizeCommit(input.targetRevision, "source attestation target");
  const artifactRoot = canonicalArtifactRoot(input.artifactDir);
  const attestationPath = path.join(artifactRoot, WORKSPACE_SOURCE_ATTESTATION_FILE);
  assertRegularFileInside(artifactRoot, attestationPath, "workspace source attestation");
  if (lstatSync(attestationPath).nlink !== 1) {
    throw new Error("workspace-provenance failure: source attestation cannot be hard-linked");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(attestationPath, "utf8"));
  } catch (error) {
    throw new Error("workspace-provenance failure: source attestation is not valid JSON", { cause: error });
  }
  const attestation = parseWorkspaceSourceAttestation(parsed, targetRevision);
  if (input.expectedTasks !== undefined) {
    assertWorkspaceSourceAttestationClosure(attestation, input.expectedTasks);
  }
  return attestation;
}

/** Explicit compatibility reader for legacy/local v1 attestations. */
export function readLegacyWorkspaceSourceAttestation(input: {
  artifactDir: string;
  targetRevision: string;
  expectedTasks?: readonly ExpectedWorkspaceSourceTask[];
}): LegacyWorkspaceSourceClaim {
  const targetRevision = normalizeCommit(input.targetRevision, "source attestation target");
  const artifactRoot = canonicalArtifactRoot(input.artifactDir);
  const attestationPath = path.join(artifactRoot, WORKSPACE_SOURCE_ATTESTATION_FILE);
  assertRegularFileInside(artifactRoot, attestationPath, "legacy workspace source attestation");
  if (lstatSync(attestationPath).nlink !== 1) {
    throw new Error("workspace-provenance failure: legacy source attestation cannot be hard-linked");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(attestationPath, "utf8"));
  } catch (error) {
    throw new Error("workspace-provenance failure: legacy source attestation is not valid JSON", { cause: error });
  }
  const attestation = parseLegacyWorkspaceSourceClaim(parsed, targetRevision);
  if (input.expectedTasks !== undefined) {
    assertLegacyWorkspaceSourceClaimClosure(attestation, input.expectedTasks);
  }
  return attestation;
}

export function writeWorkspaceSourceAttestation(artifactDir: string, attestation: WorkspaceSourceAttestation): void {
  const targetRevision = normalizeCommit(attestation.target_revision, "source attestation target");
  const parsed = parseWorkspaceSourceAttestation(attestation, targetRevision);
  writeCanonicalAttestationFile(artifactDir, WORKSPACE_SOURCE_ATTESTATION_FILE, parsed, "source attestation");
}

function writeCanonicalAttestationFile(
  artifactDir: string,
  fileName: string,
  value: WorkspaceSourceAttestation | LegacyWorkspaceSourceClaim,
  label: string
): void {
  const artifactRoot = canonicalArtifactRoot(artifactDir);
  const attestationPath = path.join(artifactRoot, fileName);
  const temporaryPath = path.join(artifactRoot, `${fileName}.${String(process.pid)}.${String(Date.now())}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, attestationPath);
    const published = lstatSync(attestationPath);
    if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 1) {
      throw new Error(`workspace-provenance failure: published ${label} is unsafe`);
    }
    if (process.platform !== "win32") {
      const directoryDescriptor = openSync(artifactRoot, "r");
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
}

export function assertWorkspaceSourceAttestationClosure(
  attestation: WorkspaceSourceAttestation,
  expectedTasks: readonly ExpectedWorkspaceSourceTask[]
): void {
  const expected = expectedSourceTasks(expectedTasks);
  if (attestation.tasks.length !== expected.size) {
    throw new Error("workspace-provenance failure: source attestation task closure is incomplete");
  }
  for (const task of attestation.tasks) {
    if (expected.get(task.attempt_id) !== task.node_id) {
      throw new Error(`workspace-provenance failure: unexpected source attestation task ${task.attempt_id}`);
    }
  }
}

function assertLegacyWorkspaceSourceClaimClosure(
  attestation: LegacyWorkspaceSourceClaim,
  expectedTasks: readonly ExpectedWorkspaceSourceTask[]
): void {
  const expected = expectedSourceTasks(expectedTasks);
  if (attestation.tasks.length !== expected.size) {
    throw new Error("workspace-provenance failure: legacy source claim task closure is incomplete");
  }
  for (const task of attestation.tasks) {
    if (expected.get(task.attempt_id) !== task.node_id) {
      throw new Error(`workspace-provenance failure: unexpected legacy source claim task ${task.attempt_id}`);
    }
  }
}

function expectedSourceTasks(expectedTasks: readonly ExpectedWorkspaceSourceTask[]): Map<string, string> {
  const expected = new Map<string, string>();
  for (const task of expectedTasks) {
    if (!safeId.test(task.attemptId) || !safeId.test(task.nodeId) || expected.has(task.attemptId)) {
      throw new Error("workspace-provenance failure: expected source attestation tasks are invalid");
    }
    expected.set(task.attemptId, task.nodeId);
  }
  if (expected.size < 1 || expected.size > MAX_ATTESTED_TASKS) {
    throw new Error("workspace-provenance failure: source attestation task closure is incomplete");
  }
  return expected;
}

export function parseWorkspaceSourceAttestation(
  value: unknown,
  expectedTargetRevision?: string
): WorkspaceSourceAttestation {
  const targetRevision = normalizeCommit(
    expectedTargetRevision ??
      (isPlainRecord(value) && typeof value.target_revision === "string" ? value.target_revision : ""),
    "source attestation target"
  );
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["schema_version", "target_revision", "task_count", "tasks"]) ||
    value.schema_version !== WORKSPACE_SOURCE_ATTESTATION_SCHEMA_VERSION ||
    value.target_revision !== targetRevision ||
    !Number.isSafeInteger(value.task_count) ||
    typeof value.task_count !== "number" ||
    value.task_count < 1 ||
    value.task_count > MAX_ATTESTED_TASKS ||
    !Array.isArray(value.tasks) ||
    value.tasks.length !== value.task_count
  ) {
    throw new Error("workspace-provenance failure: source attestation metadata is invalid");
  }
  const tasks = value.tasks.map((task, index) =>
    parseWorkspaceSourceAttestationTask(task, targetRevision, String(index))
  );
  if (new Set(tasks.map((task) => task.attempt_id)).size !== tasks.length) {
    throw new Error("workspace-provenance failure: repeats a source attestation task");
  }
  const canonicalTasks = [...tasks].sort((left, right) => compareCanonicalAscii(left.attempt_id, right.attempt_id));
  if (tasks.some((task, index) => task.attempt_id !== canonicalTasks[index]?.attempt_id)) {
    throw new Error("workspace-provenance failure: source attestation task order is not canonical");
  }
  return {
    schema_version: WORKSPACE_SOURCE_ATTESTATION_SCHEMA_VERSION,
    target_revision: targetRevision,
    task_count: tasks.length,
    tasks
  };
}

function parseWorkspaceSourceAttestationTask(
  task: unknown,
  targetRevision: string,
  index: string
): WorkspaceSourceAttestationTask {
  if (
    !isPlainRecord(task) ||
    !hasExactKeys(task, [
      "attempt_id",
      "ledger_attempt_id",
      "node_id",
      "expected_base_commit",
      "initial_head",
      "agent_root_verified",
      "tracked_clean",
      "workflow_run_id",
      "workflow_execution_id",
      "controller_invocation_id",
      "checkpoint_generation_id",
      "executor_retry_id",
      "verifier_task_id",
      "verifier_receipt_digest",
      "smithers_output_path",
      "smithers_output_sha256",
      "output_manifest_digest"
    ]) ||
    typeof task.attempt_id !== "string" ||
    !safeId.test(task.attempt_id) ||
    typeof task.ledger_attempt_id !== "string" ||
    !dimensionId.test(task.ledger_attempt_id) ||
    typeof task.node_id !== "string" ||
    !safeId.test(task.node_id) ||
    task.expected_base_commit !== targetRevision ||
    task.initial_head !== targetRevision ||
    task.agent_root_verified !== true ||
    task.tracked_clean !== true ||
    typeof task.workflow_run_id !== "string" ||
    !dimensionId.test(task.workflow_run_id) ||
    typeof task.workflow_execution_id !== "string" ||
    !dimensionId.test(task.workflow_execution_id) ||
    typeof task.controller_invocation_id !== "string" ||
    !dimensionId.test(task.controller_invocation_id) ||
    typeof task.checkpoint_generation_id !== "string" ||
    !dimensionId.test(task.checkpoint_generation_id) ||
    typeof task.executor_retry_id !== "string" ||
    !safeId.test(task.executor_retry_id) ||
    typeof task.verifier_task_id !== "string" ||
    !dimensionId.test(task.verifier_task_id) ||
    typeof task.verifier_receipt_digest !== "string" ||
    !sha256Digest.test(task.verifier_receipt_digest) ||
    task.smithers_output_path !==
      `review/verifier-receipts/${String(task.attempt_id)}/${String(task.executor_retry_id)}.smithers-output.json` ||
    typeof task.smithers_output_sha256 !== "string" ||
    !sha256Digest.test(task.smithers_output_sha256) ||
    typeof task.output_manifest_digest !== "string" ||
    !sha256Digest.test(task.output_manifest_digest)
  ) {
    throw new Error(`workspace-provenance failure: source attestation task ${index} is invalid`);
  }
  return task as unknown as WorkspaceSourceAttestationTask;
}

function parseLegacyWorkspaceSourceClaim(value: unknown, targetRevision: string): LegacyWorkspaceSourceClaim {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["schema_version", "target_revision", "task_count", "tasks"]) ||
    value.schema_version !== LEGACY_WORKSPACE_SOURCE_CLAIM_SCHEMA_VERSION ||
    value.target_revision !== targetRevision ||
    !Number.isSafeInteger(value.task_count) ||
    typeof value.task_count !== "number" ||
    value.task_count < 1 ||
    value.task_count > MAX_ATTESTED_TASKS ||
    !Array.isArray(value.tasks) ||
    value.tasks.length !== value.task_count
  ) {
    throw new Error("workspace-provenance failure: legacy source claim metadata is invalid");
  }
  const tasks = value.tasks.map((task, index): LegacyWorkspaceSourceClaimTask => {
    if (
      !isPlainRecord(task) ||
      !hasExactKeys(task, [
        "attempt_id",
        "node_id",
        "expected_base_commit",
        "initial_head",
        "agent_root_verified",
        "tracked_clean"
      ]) ||
      typeof task.attempt_id !== "string" ||
      !safeId.test(task.attempt_id) ||
      typeof task.node_id !== "string" ||
      !safeId.test(task.node_id) ||
      task.expected_base_commit !== targetRevision ||
      task.initial_head !== targetRevision ||
      task.agent_root_verified !== true ||
      task.tracked_clean !== true
    ) {
      throw new Error(`workspace-provenance failure: legacy source claim task ${index} is invalid`);
    }
    return task as unknown as LegacyWorkspaceSourceClaimTask;
  });
  if (new Set(tasks.map((task) => task.attempt_id)).size !== tasks.length) {
    throw new Error("workspace-provenance failure: legacy source claim repeats a task");
  }
  const canonicalTasks = [...tasks].sort((left, right) => compareCanonicalAscii(left.attempt_id, right.attempt_id));
  if (tasks.some((task, index) => task.attempt_id !== canonicalTasks[index]?.attempt_id)) {
    throw new Error("workspace-provenance failure: legacy source claim task order is not canonical");
  }
  return {
    schema_version: LEGACY_WORKSPACE_SOURCE_CLAIM_SCHEMA_VERSION,
    target_revision: targetRevision,
    task_count: tasks.length,
    tasks
  };
}

function normalizeCommit(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!fullCommit.test(normalized)) {
    throw new Error(`workspace-provenance failure: ${label} is invalid`);
  }
  return normalized;
}

function gitWorkspaceEnvironment(workspaceRoot: string): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))
  );
  return {
    ...environment,
    // The task worktree itself is the security boundary. Mutable repository
    // configuration and inherited Git process state must not redirect checks
    // to a clean sibling or redefine the expected commit's tree.
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevicePath(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_WORK_TREE: realpathSync(path.resolve(workspaceRoot))
  };
}

function trustedGitArguments(args: readonly string[]): string[] {
  const nullDevice = nullDevicePath();
  return [
    "-c",
    "core.trustctime=true",
    "-c",
    "core.checkStat=default",
    "-c",
    "core.ignoreStat=false",
    "-c",
    "core.ignoreCase=false",
    "-c",
    "core.fileMode=true",
    "-c",
    "core.symlinks=true",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "core.splitIndex=false",
    "-c",
    "core.sparseCheckout=false",
    "-c",
    "core.sparseCheckoutCone=false",
    "-c",
    `core.attributesFile=${nullDevice}`,
    "-c",
    `core.excludesFile=${nullDevice}`,
    "-c",
    `core.hooksPath=${nullDevice}`,
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "protocol.file.allow=never",
    ...args
  ];
}

function nullDevicePath(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

function createWorkspaceVerificationBudget(
  overrides: Partial<WorkspaceProvenanceVerificationLimits>
): WorkspaceVerificationBudget {
  const limits: WorkspaceProvenanceVerificationLimits = {
    maxElapsedMilliseconds: boundedVerificationLimit(
      "elapsed milliseconds",
      overrides.maxElapsedMilliseconds,
      DEFAULT_WORKSPACE_VERIFICATION_LIMITS.maxElapsedMilliseconds,
      1
    ),
    maxGitListingBytes: boundedVerificationLimit(
      "Git listing bytes",
      overrides.maxGitListingBytes,
      DEFAULT_WORKSPACE_VERIFICATION_LIMITS.maxGitListingBytes,
      0
    ),
    maxGitlinkDepth: boundedVerificationLimit(
      "gitlink depth",
      overrides.maxGitlinkDepth,
      DEFAULT_WORKSPACE_VERIFICATION_LIMITS.maxGitlinkDepth,
      0
    ),
    maxGitlinks: boundedVerificationLimit(
      "gitlink count",
      overrides.maxGitlinks,
      DEFAULT_WORKSPACE_VERIFICATION_LIMITS.maxGitlinks,
      0
    ),
    maxTrackedBytes: boundedVerificationLimit(
      "tracked bytes",
      overrides.maxTrackedBytes,
      DEFAULT_WORKSPACE_VERIFICATION_LIMITS.maxTrackedBytes,
      0
    ),
    maxTrackedEntries: boundedVerificationLimit(
      "tracked entries",
      overrides.maxTrackedEntries,
      DEFAULT_WORKSPACE_VERIFICATION_LIMITS.maxTrackedEntries,
      0
    )
  };
  return {
    derivedPathBytes: 0,
    derivedPaths: new Set(),
    gitListingBytes: 0,
    gitlinks: 0,
    limits,
    startedAtNanoseconds: verificationNowNanoseconds(),
    trackedBytes: 0n,
    trackedEntries: 0
  };
}

function boundedVerificationLimit(label: string, value: number | undefined, maximum: number, minimum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new WorkspaceVerificationBudgetError(
      `${label} limit must be an integer from ${String(minimum)} through ${String(maximum)}`
    );
  }
  return value;
}

function verificationNowNanoseconds(): bigint {
  return process.hrtime.bigint();
}

function verificationElapsedNanoseconds(budget: WorkspaceVerificationBudget): bigint {
  return verificationNowNanoseconds() - budget.startedAtNanoseconds;
}

function assertVerificationWithinElapsedLimit(budget: WorkspaceVerificationBudget): void {
  const maximumNanoseconds = BigInt(budget.limits.maxElapsedMilliseconds) * NANOSECONDS_PER_MILLISECOND;
  if (verificationElapsedNanoseconds(budget) >= maximumNanoseconds) {
    throw new WorkspaceVerificationBudgetError(
      `tracked source verification exceeded the ${String(budget.limits.maxElapsedMilliseconds)}ms elapsed-time limit`
    );
  }
}

function remainingVerificationMilliseconds(budget: WorkspaceVerificationBudget): number {
  assertVerificationWithinElapsedLimit(budget);
  const maximumNanoseconds = BigInt(budget.limits.maxElapsedMilliseconds) * NANOSECONDS_PER_MILLISECOND;
  const remainingNanoseconds = maximumNanoseconds - verificationElapsedNanoseconds(budget);
  if (remainingNanoseconds <= 0n) assertVerificationWithinElapsedLimit(budget);
  return Math.max(1, Number((remainingNanoseconds + NANOSECONDS_PER_MILLISECOND - 1n) / NANOSECONDS_PER_MILLISECOND));
}

function runGitWithinVerificationBudget<T>(budget: WorkspaceVerificationBudget, operation: (timeout: number) => T): T {
  const timeout = remainingVerificationMilliseconds(budget);
  try {
    const result = operation(timeout);
    assertVerificationWithinElapsedLimit(budget);
    return result;
  } catch (error) {
    if (error instanceof WorkspaceVerificationBudgetError) throw error;
    assertVerificationWithinElapsedLimit(budget);
    throw error;
  }
}

function consumeTrackedEntries(budget: WorkspaceVerificationBudget, count: number): void {
  assertVerificationWithinElapsedLimit(budget);
  const next = budget.trackedEntries + count;
  if (!Number.isSafeInteger(next) || next > budget.limits.maxTrackedEntries) {
    throw new WorkspaceVerificationBudgetError(
      `tracked source verification exceeded the ${String(budget.limits.maxTrackedEntries)}-entry limit`
    );
  }
  budget.trackedEntries = next;
}

function consumeTrackedBytes(budget: WorkspaceVerificationBudget, size: bigint): void {
  assertVerificationWithinElapsedLimit(budget);
  if (size < 0n) {
    throw new WorkspaceVerificationBudgetError("tracked source verification encountered a negative file size");
  }
  const next = budget.trackedBytes + size;
  if (next > BigInt(budget.limits.maxTrackedBytes)) {
    throw new WorkspaceVerificationBudgetError(
      `tracked source verification exceeded the ${String(budget.limits.maxTrackedBytes)}-byte limit`
    );
  }
  budget.trackedBytes = next;
}

function consumeDerivedTrackedPath(budget: WorkspaceVerificationBudget, candidate: string): void {
  if (budget.derivedPaths.has(candidate)) return;
  assertVerificationWithinElapsedLimit(budget);
  const nextBytes = budget.derivedPathBytes + Buffer.byteLength(candidate, "utf8");
  if (!Number.isSafeInteger(nextBytes) || nextBytes > MAX_DERIVED_TRACKED_PATH_BYTES) {
    throw new WorkspaceVerificationBudgetError(
      `tracked source verification exceeded the ${String(MAX_DERIVED_TRACKED_PATH_BYTES)}-byte derived-path limit`
    );
  }
  consumeTrackedEntries(budget, 1);
  budget.derivedPaths.add(candidate);
  budget.derivedPathBytes = nextBytes;
}

function consumeGitListingBytes(budget: WorkspaceVerificationBudget, listed: string): void {
  assertVerificationWithinElapsedLimit(budget);
  const next = budget.gitListingBytes + Buffer.byteLength(listed, "utf8");
  if (!Number.isSafeInteger(next) || next > budget.limits.maxGitListingBytes) {
    throw gitListingLimitError(budget);
  }
  budget.gitListingBytes = next;
}

function gitListingLimitError(budget: WorkspaceVerificationBudget): WorkspaceVerificationBudgetError {
  return new WorkspaceVerificationBudgetError(
    `tracked source verification exceeded the ${String(budget.limits.maxGitListingBytes)}-byte recursive Git listing limit`
  );
}

function isMaxBufferExceededError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOBUFS";
}

function consumeGitlink(budget: WorkspaceVerificationBudget, depth: number): void {
  assertVerificationWithinElapsedLimit(budget);
  if (depth > budget.limits.maxGitlinkDepth) {
    throw new WorkspaceVerificationBudgetError(
      `tracked source verification exceeded the ${String(budget.limits.maxGitlinkDepth)}-level gitlink depth limit`
    );
  }
  const next = budget.gitlinks + 1;
  if (next > budget.limits.maxGitlinks) {
    throw new WorkspaceVerificationBudgetError(
      `tracked source verification exceeded the ${String(budget.limits.maxGitlinks)}-gitlink limit`
    );
  }
  budget.gitlinks = next;
}

function assertTrackedFilesMatchCommit(
  workspaceRoot: string,
  expectedCommit: string,
  allowedUntrackedRoots: readonly string[],
  budget: WorkspaceVerificationBudget
): void {
  try {
    const snapshot = captureTrackedRepositorySnapshot(workspaceRoot, expectedCommit, allowedUntrackedRoots, budget, 0);
    assertTrackedRepositorySnapshotStable(snapshot, budget);
  } catch (error) {
    if (error instanceof WorkspaceVerificationBudgetError) throw error;
    if (
      error instanceof Error &&
      (error.message.includes("unexpected untracked source") ||
        error.message.includes("untracked .gitignore") ||
        error.message.includes("allowed untracked root") ||
        error.message.includes("tracked symlink target exposes mutable gitlink source") ||
        error.message.includes("assume-unchanged or skip-worktree"))
    ) {
      throw error;
    }
    throw new Error("workspace-provenance failure: task worktree has tracked changes before agent execution", {
      cause: error
    });
  }
}

function captureTrackedRepositorySnapshot(
  workspaceRoot: string,
  expectedCommit: string,
  allowedUntrackedRoots: readonly string[],
  budget: WorkspaceVerificationBudget,
  gitlinkDepth: number
): TrackedRepositorySnapshot {
  assertVerificationWithinElapsedLimit(budget);
  const rootStat = lstatSync(workspaceRoot, { bigint: true });
  assertTrackedDirectory(rootStat);
  assertNoMaskedTrackedFiles(workspaceRoot, budget, budget.limits.maxTrackedEntries - budget.trackedEntries);
  assertCachedIndexMatchesCommit(workspaceRoot, expectedCommit, budget);
  const headEntries = listCommitTrackedEntries(workspaceRoot, expectedCommit, budget);
  const identities = headEntries.map((entry) => captureTrackedEntryIdentity(workspaceRoot, entry, budget));
  const snapshot: TrackedRepositorySnapshot = {
    allowedUntrackedRoots,
    entries: identities.map((identity) => captureTrackedEntry(workspaceRoot, identity, budget, gitlinkDepth)),
    expectedCommit,
    headEntries,
    rootStat,
    workspaceRoot
  };
  const untracked = assertNoUnexpectedUntrackedFiles(workspaceRoot, allowedUntrackedRoots, expectedCommit, budget);
  assertTrackedSymlinkTargets(snapshot, untracked, budget);
  return snapshot;
}

function assertTrackedRepositorySnapshotStable(
  snapshot: TrackedRepositorySnapshot,
  budget: WorkspaceVerificationBudget
): void {
  // This second pass detects changes to an earlier path while later paths were
  // hashed. Callers must still quiesce hostile writers around verification:
  // no finite sequential filesystem scan can create an atomic read boundary.
  for (const entry of snapshot.entries) assertTrackedPathSnapshotStable(entry, budget);
  const untracked = assertNoUnexpectedUntrackedFiles(
    snapshot.workspaceRoot,
    snapshot.allowedUntrackedRoots,
    snapshot.expectedCommit,
    budget
  );
  assertTrackedSymlinkTargets(snapshot, untracked, budget);
  assertNoMaskedTrackedFiles(snapshot.workspaceRoot, budget, snapshot.headEntries.length);
  assertCachedIndexMatchesCommit(snapshot.workspaceRoot, snapshot.expectedCommit, budget);
  assertVerificationWithinElapsedLimit(budget);
  const rootStat = lstatSync(snapshot.workspaceRoot, { bigint: true });
  assertTrackedDirectory(rootStat);
  assertStableTrackedFileStats(snapshot.rootStat, rootStat);
  if (resolveCheckedOutCommitWithinBudget(snapshot.workspaceRoot, budget) !== snapshot.expectedCommit) {
    throw new Error("workspace-provenance failure: checked-out source commit changed during verification");
  }
}

function assertCachedIndexMatchesCommit(
  workspaceRoot: string,
  expectedCommit: string,
  budget: WorkspaceVerificationBudget
): void {
  // Compare staged object IDs and modes without consulting worktree stat data.
  runGitWithinVerificationBudget(budget, (timeout) =>
    execFileSync(
      "git",
      trustedGitArguments([
        "diff-index",
        "--cached",
        "--quiet",
        "--no-ext-diff",
        "--no-textconv",
        "--ignore-submodules=none",
        expectedCommit,
        "--"
      ]),
      {
        cwd: workspaceRoot,
        env: gitWorkspaceEnvironment(workspaceRoot),
        stdio: "ignore",
        timeout
      }
    )
  );
}

function listCommitTrackedEntries(
  workspaceRoot: string,
  expectedCommit: string,
  budget: WorkspaceVerificationBudget
): HeadTrackedEntry[] {
  const remainingListingBytes = budget.limits.maxGitListingBytes - budget.gitListingBytes;
  let listed: string;
  try {
    listed = runGitWithinVerificationBudget(budget, (timeout) =>
      execFileSync(
        "git",
        trustedGitArguments(["ls-tree", "-r", "-z", "--full-name", "--full-tree", "--abbrev=40", expectedCommit]),
        {
          cwd: workspaceRoot,
          encoding: "utf8",
          env: gitWorkspaceEnvironment(workspaceRoot),
          // Permit one byte beyond the remaining cumulative allowance so a
          // successful command can be charged deterministically below. Larger
          // output is converted from Node's ENOBUFS into the same budget error.
          maxBuffer: Math.min(MAX_GIT_LIST_BYTES, remainingListingBytes + 1),
          stdio: ["ignore", "pipe", "pipe"],
          timeout
        }
      )
    );
  } catch (error) {
    if (error instanceof WorkspaceVerificationBudgetError) throw error;
    if (isMaxBufferExceededError(error)) throw gitListingLimitError(budget);
    throw error;
  }
  consumeGitListingBytes(budget, listed);
  const listedEntryCount = reserveListedTrackedEntries(budget, listed);
  const entries = listed
    .split("\0")
    .filter((record) => record.length > 0)
    .map((record): HeadTrackedEntry => {
      const match = /^(100644|100755|120000|160000) (blob|commit) ([0-9a-f]{40})\t([\s\S]+)$/u.exec(record);
      if (match === null || (match[1] === "160000") !== (match[2] === "commit")) {
        throw new Error("workspace-provenance failure: checked-out source tree entry is invalid");
      }
      return {
        mode: match[1] as HeadTrackedEntry["mode"],
        type: match[2] as HeadTrackedEntry["type"],
        objectId: match[3]!,
        relativePath: match[4]!
      };
    });
  if (entries.length !== listedEntryCount) {
    throw new Error("workspace-provenance failure: checked-out source tree listing is invalid");
  }
  return entries;
}

function reserveListedTrackedEntries(budget: WorkspaceVerificationBudget, listed: string): number {
  if (listed.length > 0 && !listed.endsWith("\0")) {
    throw new Error("workspace-provenance failure: checked-out source tree listing is invalid");
  }
  const remaining = budget.limits.maxTrackedEntries - budget.trackedEntries;
  let count = 0;
  let offset = 0;
  for (;;) {
    const delimiter = listed.indexOf("\0", offset);
    if (delimiter === -1) break;
    count += 1;
    if (count > remaining) {
      throw new WorkspaceVerificationBudgetError(
        `tracked source verification exceeded the ${String(budget.limits.maxTrackedEntries)}-entry limit`
      );
    }
    if (count % 1_024 === 0) assertVerificationWithinElapsedLimit(budget);
    offset = delimiter + 1;
  }
  consumeTrackedEntries(budget, count);
  return count;
}

function captureTrackedEntryIdentity(
  workspaceRoot: string,
  entry: HeadTrackedEntry,
  budget: WorkspaceVerificationBudget
): TrackedEntryIdentity {
  assertVerificationWithinElapsedLimit(budget);
  const candidate = path.resolve(workspaceRoot, entry.relativePath);
  assertPathInside(workspaceRoot, candidate, "tracked task source");
  assertNoSymlinkComponents(workspaceRoot, path.dirname(candidate), "tracked task source");
  const stat = lstatSync(candidate, { bigint: true });
  if (entry.mode === "160000") assertTrackedDirectory(stat);
  else if (entry.mode === "120000") assertSingleLinkTrackedSymlink(stat);
  else assertSingleLinkTrackedRegularFile(stat);
  if (entry.mode !== "160000") consumeTrackedBytes(budget, stat.size);
  return { candidate, entry, stat };
}

function captureTrackedEntry(
  workspaceRoot: string,
  identity: TrackedEntryIdentity,
  budget: WorkspaceVerificationBudget,
  gitlinkDepth: number
): TrackedPathSnapshot {
  assertVerificationWithinElapsedLimit(budget);
  const { candidate, entry } = identity;
  assertNoSymlinkComponents(workspaceRoot, path.dirname(candidate), "tracked task source");
  if (entry.mode === "160000") {
    const nestedDepth = gitlinkDepth + 1;
    consumeGitlink(budget, nestedDepth);
    const before = lstatSync(candidate, { bigint: true });
    assertTrackedDirectory(before);
    assertStableTrackedFileStats(identity.stat, before);
    if (resolveCheckedOutCommitWithinBudget(candidate, budget) !== entry.objectId) {
      throw new Error("workspace-provenance failure: tracked gitlink does not match HEAD");
    }
    const repository = captureTrackedRepositorySnapshot(candidate, entry.objectId, [], budget, nestedDepth);
    const after = lstatSync(candidate, { bigint: true });
    assertTrackedDirectory(after);
    assertStableTrackedFileStats(before, after);
    return { candidate, kind: "gitlink", repository, stat: after, workspaceRoot };
  }

  if (entry.mode === "120000") {
    const symlink = hashStableTrackedSymlink(candidate, budget, identity.stat);
    if (symlink.objectId !== entry.objectId) {
      throw new Error("workspace-provenance failure: tracked task source content or mode does not match HEAD");
    }
    return { candidate, contents: symlink.contents, kind: "symlink", stat: symlink.stat, workspaceRoot };
  }
  const regular = hashStableTrackedRegularFile(candidate, entry.mode, budget, identity.stat);
  if (regular.objectId !== entry.objectId) {
    throw new Error("workspace-provenance failure: tracked task source content or mode does not match HEAD");
  }
  return { candidate, kind: "regular", stat: regular.stat, workspaceRoot };
}

function assertTrackedPathSnapshotStable(snapshot: TrackedPathSnapshot, budget: WorkspaceVerificationBudget): void {
  assertVerificationWithinElapsedLimit(budget);
  assertNoSymlinkComponents(snapshot.workspaceRoot, path.dirname(snapshot.candidate), "tracked task source");
  if (snapshot.kind === "regular") {
    const stat = lstatSync(snapshot.candidate, { bigint: true });
    assertSingleLinkTrackedRegularFile(stat);
    assertStableTrackedFileStats(snapshot.stat, stat);
  } else if (snapshot.kind === "symlink") {
    const symlink = hashStableTrackedSymlink(snapshot.candidate, budget);
    assertStableTrackedFileStats(snapshot.stat, symlink.stat);
    if (!snapshot.contents.equals(symlink.contents)) {
      throw new Error("workspace-provenance failure: tracked symlink changed during verification");
    }
  } else {
    const before = lstatSync(snapshot.candidate, { bigint: true });
    assertTrackedDirectory(before);
    assertStableTrackedFileStats(snapshot.stat, before);
    assertTrackedRepositorySnapshotStable(snapshot.repository, budget);
    const after = lstatSync(snapshot.candidate, { bigint: true });
    assertTrackedDirectory(after);
    assertStableTrackedFileStats(snapshot.stat, after);
  }
  assertNoSymlinkComponents(snapshot.workspaceRoot, path.dirname(snapshot.candidate), "tracked task source");
}

function hashStableTrackedRegularFile(
  candidate: string,
  expectedMode: "100644" | "100755",
  budget: WorkspaceVerificationBudget,
  expectedStat?: BigIntStats
): { objectId: string; stat: BigIntStats } {
  assertVerificationWithinElapsedLimit(budget);
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== "number" || noFollow === 0) {
    throw new Error("workspace-provenance failure: platform cannot safely open tracked source without following links");
  }
  const beforePath = lstatSync(candidate, { bigint: true });
  assertSingleLinkTrackedRegularFile(beforePath);
  if (expectedStat !== undefined) assertStableTrackedFileStats(expectedStat, beforePath);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(candidate, constants.O_RDONLY | noFollow);
    const beforeDescriptor = fstatSync(descriptor, { bigint: true });
    assertSingleLinkTrackedRegularFile(beforeDescriptor);
    assertStableTrackedFileStats(beforePath, beforeDescriptor);
    const actualMode = (beforeDescriptor.mode & 0o111n) === 0n ? "100644" : "100755";
    if (actualMode !== expectedMode || beforeDescriptor.size < 0n) {
      throw new Error("workspace-provenance failure: tracked task source mode or size does not match HEAD");
    }

    const digest = createHash("sha1").update(`blob ${beforeDescriptor.size.toString()}\0`, "utf8");
    const buffer = Buffer.allocUnsafe(TRACKED_FILE_HASH_BUFFER_BYTES);
    let bytesReadTotal = 0n;
    while (true) {
      // A file may be sparse or backed by a slow filesystem. Check the shared
      // monotonic deadline for every bounded read rather than only per file.
      assertVerificationWithinElapsedLimit(budget);
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      bytesReadTotal += BigInt(bytesRead);
      if (bytesReadTotal > beforeDescriptor.size) {
        throw new Error("workspace-provenance failure: tracked task source changed while it was read");
      }
    }
    assertVerificationWithinElapsedLimit(budget);
    const afterDescriptor = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(candidate, { bigint: true });
    assertSingleLinkTrackedRegularFile(afterDescriptor);
    assertSingleLinkTrackedRegularFile(afterPath);
    assertStableTrackedFileStats(beforeDescriptor, afterDescriptor);
    assertStableTrackedFileStats(afterDescriptor, afterPath);
    if (bytesReadTotal !== beforeDescriptor.size) {
      throw new Error("workspace-provenance failure: tracked task source changed while it was read");
    }
    return { objectId: digest.digest("hex"), stat: afterPath };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function hashStableTrackedSymlink(
  candidate: string,
  budget: WorkspaceVerificationBudget,
  expectedStat?: BigIntStats
): { contents: Buffer; objectId: string; stat: BigIntStats } {
  assertVerificationWithinElapsedLimit(budget);
  const before = lstatSync(candidate, { bigint: true });
  assertSingleLinkTrackedSymlink(before);
  if (expectedStat !== undefined) assertStableTrackedFileStats(expectedStat, before);
  const contents = readlinkSync(candidate, { encoding: "buffer" });
  assertVerificationWithinElapsedLimit(budget);
  const after = lstatSync(candidate, { bigint: true });
  if (!after.isSymbolicLink() || after.nlink !== 1n) {
    throw new Error("workspace-provenance failure: tracked symlink changed while it was read");
  }
  assertStableTrackedFileStats(before, after);
  return { contents, objectId: gitBlobObjectId(contents), stat: after };
}

function assertSingleLinkTrackedSymlink(stat: BigIntStats): void {
  if (!stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw new Error("workspace-provenance failure: tracked symlink is unsafe");
  }
}

function assertTrackedDirectory(stat: BigIntStats): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("workspace-provenance failure: tracked repository directory is unsafe");
  }
}

function assertSingleLinkTrackedRegularFile(stat: BigIntStats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw new Error("workspace-provenance failure: tracked task source is not a single-link regular file");
  }
}

function assertStableTrackedFileStats(left: BigIntStats, right: BigIntStats): void {
  if (
    left.dev !== right.dev ||
    left.ino !== right.ino ||
    left.nlink !== right.nlink ||
    left.size !== right.size ||
    left.mode !== right.mode ||
    left.ctimeNs !== right.ctimeNs ||
    left.mtimeNs !== right.mtimeNs
  ) {
    throw new Error("workspace-provenance failure: tracked task source changed while it was read");
  }
}

function gitBlobObjectId(contents: Buffer): string {
  return createHash("sha1")
    .update(`blob ${String(contents.length)}\0`, "utf8")
    .update(contents)
    .digest("hex");
}

function assertTrackedSymlinkTargets(
  snapshot: TrackedRepositorySnapshot,
  untracked: readonly string[],
  budget: WorkspaceVerificationBudget
): void {
  if (!snapshot.entries.some((entry) => entry.kind === "symlink")) return;
  const trackedPaths = new Map<string, HeadTrackedEntry["mode"]>();
  const trackedDirectories = new Set<string>();
  const gitlinkPaths = new Set<string>();
  for (const entry of snapshot.headEntries) {
    assertVerificationWithinElapsedLimit(budget);
    const candidate = path.resolve(snapshot.workspaceRoot, entry.relativePath);
    trackedPaths.set(candidate, entry.mode);
    if (entry.mode === "160000") gitlinkPaths.add(candidate);
    for (
      let directory = path.dirname(candidate);
      directory !== snapshot.workspaceRoot;
      directory = path.dirname(directory)
    ) {
      assertVerificationWithinElapsedLimit(budget);
      if (!directory.startsWith(`${snapshot.workspaceRoot}${path.sep}`)) break;
      consumeDerivedTrackedPath(budget, directory);
      trackedDirectories.add(directory);
    }
  }
  const mutableRoots = [
    ...snapshot.allowedUntrackedRoots.map((root) => path.resolve(root)),
    ...NATIVE_TOOL_OUTPUT_PREFIXES.map((prefix) => path.resolve(snapshot.workspaceRoot, prefix.slice(0, -1)))
  ];

  for (const entry of snapshot.entries) {
    assertVerificationWithinElapsedLimit(budget);
    if (entry.kind !== "symlink") continue;
    const targetText = entry.contents.toString("utf8");
    if (!Buffer.from(targetText, "utf8").equals(entry.contents) || path.isAbsolute(targetText)) {
      throw new Error("workspace-provenance failure: tracked symlink target is unsafe");
    }
    const lexicalTarget = path.resolve(path.dirname(entry.candidate), targetText);
    if (
      lexicalTarget === snapshot.workspaceRoot ||
      !lexicalTarget.startsWith(`${snapshot.workspaceRoot}${path.sep}`) ||
      (!trackedPaths.has(lexicalTarget) && !trackedDirectories.has(lexicalTarget))
    ) {
      throw new Error("workspace-provenance failure: tracked symlink target is not pinned source");
    }

    const resolvedTarget = realpathSync(entry.candidate);
    if (
      resolvedTarget === snapshot.workspaceRoot ||
      !resolvedTarget.startsWith(`${snapshot.workspaceRoot}${path.sep}`)
    ) {
      throw new Error("workspace-provenance failure: tracked symlink escapes the task worktree");
    }
    if (mutableRoots.some((root) => pathsOverlap(root, resolvedTarget))) {
      throw new Error("workspace-provenance failure: tracked symlink target exposes mutable output");
    }
    const targetStat = lstatSync(resolvedTarget);
    if (targetStat.isFile()) {
      const mode = trackedPaths.get(resolvedTarget);
      if (mode !== "100644" && mode !== "100755") {
        throw new Error("workspace-provenance failure: tracked symlink target is not pinned source");
      }
      continue;
    }
    if (!targetStat.isDirectory() || !trackedDirectories.has(resolvedTarget)) {
      throw new Error("workspace-provenance failure: tracked symlink target is not pinned source");
    }
    for (const gitlink of gitlinkPaths) {
      assertVerificationWithinElapsedLimit(budget);
      if (gitlink === resolvedTarget || gitlink.startsWith(`${resolvedTarget}${path.sep}`)) {
        throw new Error("workspace-provenance failure: tracked symlink target exposes mutable gitlink source");
      }
    }
    const relativeDirectory = path.relative(snapshot.workspaceRoot, resolvedTarget).split(path.sep).join("/");
    for (const untrackedPath of untracked) {
      assertVerificationWithinElapsedLimit(budget);
      if (untrackedPath.startsWith(`${relativeDirectory}/`)) {
        throw new Error("workspace-provenance failure: tracked symlink directory contains unpinned source");
      }
    }
    for (const directory of trackedDirectories) {
      assertVerificationWithinElapsedLimit(budget);
      if (directory === resolvedTarget || directory.startsWith(`${resolvedTarget}${path.sep}`)) {
        assertNoGitMetadata(directory);
      }
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
}

function assertNoGitMetadata(directory: string): void {
  try {
    lstatSync(path.join(directory, ".git"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("workspace-provenance failure: tracked symlink directory exposes Git metadata");
}

function assertNoMaskedTrackedFiles(
  workspacePath: string,
  budget: WorkspaceVerificationBudget,
  maximumEntries: number
): void {
  let tracked: string;
  try {
    tracked = runGitWithinVerificationBudget(budget, (timeout) =>
      execFileSync("git", trustedGitArguments(["ls-files", "-v", "-z"]), {
        cwd: workspacePath,
        encoding: "utf8",
        env: gitWorkspaceEnvironment(workspacePath),
        maxBuffer: MAX_GIT_LIST_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
        timeout
      })
    );
  } catch (error) {
    if (error instanceof WorkspaceVerificationBudgetError) throw error;
    throw new Error("workspace-provenance failure: could not inspect tracked task source flags", {
      cause: error
    });
  }
  if (tracked.length > 0 && !tracked.endsWith("\0")) {
    throw new Error("workspace-provenance failure: tracked task source index listing is invalid");
  }
  let count = 0;
  let offset = 0;
  for (;;) {
    const delimiter = tracked.indexOf("\0", offset);
    if (delimiter === -1) break;
    count += 1;
    if (count > maximumEntries) {
      throw new WorkspaceVerificationBudgetError(
        `tracked source verification exceeded the ${String(budget.limits.maxTrackedEntries)}-entry limit`
      );
    }
    const flag = tracked[offset] ?? "";
    if (delimiter - offset > 2 && (flag === "S" || /[a-z]/u.test(flag))) {
      throw new Error(
        "workspace-provenance failure: tracked task source uses assume-unchanged or skip-worktree index flags"
      );
    }
    if (count % 1_024 === 0) assertVerificationWithinElapsedLimit(budget);
    offset = delimiter + 1;
  }
  assertVerificationWithinElapsedLimit(budget);
}

function assertNoUnexpectedUntrackedFiles(
  workspacePath: string,
  allowedUntrackedRoots: readonly string[],
  expectedCommit: string,
  budget: WorkspaceVerificationBudget
): string[] {
  assertVerificationWithinElapsedLimit(budget);
  const workspaceCandidate = path.resolve(workspacePath);
  const workspaceRoot = realpathSync(workspaceCandidate);
  const allowedPrefixes = allowedUntrackedRoots.map((allowedUntrackedRoot) => {
    const allowedCandidate = path.resolve(allowedUntrackedRoot);
    if (!allowedCandidate.startsWith(`${workspaceCandidate}${path.sep}`)) {
      throw new Error("workspace-provenance failure: allowed untracked root is outside the task worktree");
    }
    const stat = lstatSync(allowedCandidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("workspace-provenance failure: allowed untracked root is unsafe");
    }
    const relative = path.relative(workspaceCandidate, allowedCandidate);
    const allowedRoot = realpathSync(allowedCandidate);
    if (allowedRoot !== path.join(workspaceRoot, relative) || !allowedRoot.startsWith(`${workspaceRoot}${path.sep}`)) {
      throw new Error("workspace-provenance failure: allowed untracked root escapes the task worktree");
    }
    return `${relative.split(path.sep).join("/")}/`;
  });
  const untracked = listUntrackedFiles(workspaceRoot, expectedCommit, budget);
  const unsafeIgnoreFiles = untracked.filter(
    (entry) =>
      (entry === ".gitignore" || entry.endsWith("/.gitignore")) && !untrackedPathAllowed(entry, allowedPrefixes)
  );
  if (unsafeIgnoreFiles.length > 0) {
    throw new Error("workspace-provenance failure: task worktree has an untracked .gitignore outside its outputs");
  }
  // Deliberately do not honor committed, info, global, or configured excludes:
  // target repositories are untrusted and an ignore rule such as `*.sol`
  // cannot be allowed to turn new source into an attested clean workspace.
  const unexpected = untracked.filter((entry) => !untrackedPathAllowed(entry, allowedPrefixes));
  assertVerificationWithinElapsedLimit(budget);
  if (unexpected.length > 0) {
    throw new Error(
      "workspace-provenance failure: task worktree has unexpected untracked source before agent execution"
    );
  }
  return untracked;
}

function untrackedPathAllowed(entry: string, allowedPrefixes: readonly string[]): boolean {
  return (
    allowedPrefixes.some((prefix) => entry.startsWith(prefix)) ||
    NATIVE_TOOL_OUTPUT_PREFIXES.some((prefix) => entry.startsWith(prefix))
  );
}

function listUntrackedFiles(
  workspaceRoot: string,
  expectedCommit: string,
  budget: WorkspaceVerificationBudget
): string[] {
  assertVerificationWithinElapsedLimit(budget);
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "ultrafuzz-provenance-index-"));
  const indexPath = path.join(temporaryRoot, "index");
  try {
    // The repository's mutable real index may temporarily describe a second
    // commit and thereby hide attacker-created files as tracked. Seed a private
    // index from the pinned commit so --others has an immutable baseline.
    const environment = { ...gitWorkspaceEnvironment(workspaceRoot), GIT_INDEX_FILE: indexPath };
    runGitWithinVerificationBudget(budget, (timeout) =>
      execFileSync("git", trustedGitArguments(["read-tree", "--reset", expectedCommit]), {
        cwd: workspaceRoot,
        env: environment,
        stdio: "ignore",
        timeout
      })
    );
    const untracked = runGitWithinVerificationBudget(budget, (timeout) =>
      execFileSync("git", trustedGitArguments(["ls-files", "--others", "--full-name", "-z"]), {
        cwd: workspaceRoot,
        encoding: "utf8",
        env: environment,
        maxBuffer: MAX_GIT_LIST_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
        timeout
      })
    );
    return untracked.split("\0").filter((entry) => entry.length > 0);
  } catch (error) {
    if (error instanceof WorkspaceVerificationBudgetError) throw error;
    throw new Error("workspace-provenance failure: could not inspect untracked task source", { cause: error });
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

function canonicalArtifactRoot(artifactDir: string): string {
  const candidate = path.resolve(artifactDir);
  const rootId = path.basename(candidate);
  if (!safeId.test(rootId)) {
    throw new Error("workspace-provenance failure: source attestation artifact root is invalid");
  }
  const parent = realpathSync(path.dirname(candidate));
  const stat = lstatSync(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("workspace-provenance failure: source attestation artifact root is unsafe");
  }
  const root = realpathSync(candidate);
  if (root !== path.join(parent, rootId)) {
    throw new Error("workspace-provenance failure: source attestation artifact root is unsafe");
  }
  return root;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
