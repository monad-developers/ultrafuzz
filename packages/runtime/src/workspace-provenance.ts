import { execFileSync } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { assertRegularFileInside } from "@ultrafuzz/artifacts";

const fullCommit = /^[0-9a-f]{40}$/u;
const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_ATTESTED_TASKS = 2_048;

export const WORKSPACE_SOURCE_ATTESTATION_SCHEMA_VERSION = "ultrafuzz.workspace-source-attestation.v1" as const;
export const WORKSPACE_SOURCE_ATTESTATION_FILE = ".ultrafuzz-workspace-source-attestation.json" as const;

export interface WorkspaceBaseProvenance {
  baseCommit: string;
  initialHead: string;
}

export interface AgentWorkspaceProvenance extends WorkspaceBaseProvenance {
  agentRootVerified: true;
  trackedClean: true;
}

export interface WorkspaceSourceAttestationTask {
  attempt_id: string;
  node_id: string;
  expected_base_commit: string;
  initial_head: string;
  agent_root_verified: true;
  tracked_clean: true;
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

export function resolveCheckedOutCommit(repositoryPath: string): string {
  let revision: string;
  try {
    revision = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: repositoryPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
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

export function assertWorkspaceBaseCommit(workspacePath: string, expectedBaseCommit: string): WorkspaceBaseProvenance {
  const normalizedExpected = expectedBaseCommit.trim().toLowerCase();
  if (!fullCommit.test(normalizedExpected)) {
    throw new Error("workspace-provenance failure: expected source commit is invalid");
  }
  const initialHead = resolveCheckedOutCommit(workspacePath);
  if (initialHead !== normalizedExpected) {
    throw new Error(`workspace-provenance failure: worktree started at ${initialHead}, expected ${normalizedExpected}`);
  }
  return { baseCommit: normalizedExpected, initialHead };
}

export function assertAgentWorkspaceProvenance(
  workspacePath: string,
  expectedBaseCommit: string,
  agentRoot: string | undefined,
  allowedUntrackedRoot?: string
): AgentWorkspaceProvenance {
  if (agentRoot === undefined || realpathSync(agentRoot) !== realpathSync(workspacePath)) {
    throw new Error("workspace-provenance failure: agent root does not match its task worktree");
  }
  const base = assertWorkspaceBaseCommit(workspacePath, expectedBaseCommit);
  try {
    execFileSync("git", ["diff-index", "--quiet", "HEAD", "--"], {
      cwd: workspacePath,
      stdio: "ignore"
    });
  } catch (error) {
    throw new Error("workspace-provenance failure: task worktree has tracked changes before agent execution", {
      cause: error
    });
  }
  assertNoUnexpectedUntrackedFiles(workspacePath, allowedUntrackedRoot);
  return {
    ...base,
    agentRootVerified: true,
    trackedClean: true
  };
}

export function persistWorkspaceSourceAttestation(input: {
  artifactDir: string;
  targetRevision: string;
  current: ExpectedWorkspaceSourceTask & { workspace: AgentWorkspaceProvenance };
  dependencyArtifactDirs: readonly string[];
  expectedTasks: readonly ExpectedWorkspaceSourceTask[];
}): WorkspaceSourceAttestation {
  const targetRevision = normalizeCommit(input.targetRevision, "source attestation target");
  const tasks = new Map<string, WorkspaceSourceAttestationTask>();
  for (const dependencyArtifactDir of input.dependencyArtifactDirs) {
    const dependency = readWorkspaceSourceAttestation({
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
  const attestation: WorkspaceSourceAttestation = {
    schema_version: WORKSPACE_SOURCE_ATTESTATION_SCHEMA_VERSION,
    target_revision: targetRevision,
    task_count: tasks.size,
    tasks: [...tasks.values()].sort((left, right) => left.attempt_id.localeCompare(right.attempt_id))
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

export function writeWorkspaceSourceAttestation(artifactDir: string, attestation: WorkspaceSourceAttestation): void {
  const targetRevision = normalizeCommit(attestation.target_revision, "source attestation target");
  const parsed = parseWorkspaceSourceAttestation(attestation, targetRevision);
  const artifactRoot = canonicalArtifactRoot(artifactDir);
  const attestationPath = path.join(artifactRoot, WORKSPACE_SOURCE_ATTESTATION_FILE);
  const temporaryPath = path.join(
    artifactRoot,
    `${WORKSPACE_SOURCE_ATTESTATION_FILE}.${String(process.pid)}.${String(Date.now())}.tmp`
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, attestationPath);
    const published = lstatSync(attestationPath);
    if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 1) {
      throw new Error("workspace-provenance failure: published source attestation is unsafe");
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
  const expected = new Map<string, string>();
  for (const task of expectedTasks) {
    if (!safeId.test(task.attemptId) || !safeId.test(task.nodeId) || expected.has(task.attemptId)) {
      throw new Error("workspace-provenance failure: expected source attestation tasks are invalid");
    }
    expected.set(task.attemptId, task.nodeId);
  }
  if (expected.size < 1 || expected.size > MAX_ATTESTED_TASKS || attestation.tasks.length !== expected.size) {
    throw new Error("workspace-provenance failure: source attestation task closure is incomplete");
  }
  for (const task of attestation.tasks) {
    if (expected.get(task.attempt_id) !== task.node_id) {
      throw new Error(`workspace-provenance failure: unexpected source attestation task ${task.attempt_id}`);
    }
  }
}

function parseWorkspaceSourceAttestation(value: unknown, targetRevision: string): WorkspaceSourceAttestation {
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
  const tasks = value.tasks.map((task, index): WorkspaceSourceAttestationTask => {
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
      throw new Error(`workspace-provenance failure: source attestation task ${index} is invalid`);
    }
    return task as unknown as WorkspaceSourceAttestationTask;
  });
  if (new Set(tasks.map((task) => task.attempt_id)).size !== tasks.length) {
    throw new Error("workspace-provenance failure: source attestation repeats a task");
  }
  return {
    schema_version: WORKSPACE_SOURCE_ATTESTATION_SCHEMA_VERSION,
    target_revision: targetRevision,
    task_count: tasks.length,
    tasks: tasks.sort((left, right) => left.attempt_id.localeCompare(right.attempt_id))
  };
}

function normalizeCommit(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!fullCommit.test(normalized)) {
    throw new Error(`workspace-provenance failure: ${label} is invalid`);
  }
  return normalized;
}

function assertNoUnexpectedUntrackedFiles(workspacePath: string, allowedUntrackedRoot: string | undefined): void {
  const workspaceRoot = realpathSync(workspacePath);
  let allowedPrefix: string | undefined;
  if (allowedUntrackedRoot !== undefined) {
    const allowedCandidate = path.resolve(allowedUntrackedRoot);
    if (!allowedCandidate.startsWith(`${workspaceRoot}${path.sep}`)) {
      throw new Error("workspace-provenance failure: allowed untracked root is outside the task worktree");
    }
    const allowedRoot = realpathSync(allowedCandidate);
    if (!allowedRoot.startsWith(`${workspaceRoot}${path.sep}`)) {
      throw new Error("workspace-provenance failure: allowed untracked root escapes the task worktree");
    }
    allowedPrefix = `${path.relative(workspaceRoot, allowedRoot).split(path.sep).join("/")}/`;
  }
  let untracked: string;
  try {
    untracked = execFileSync("git", ["ls-files", "--others", "--full-name", "-z"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    throw new Error("workspace-provenance failure: could not inspect untracked task source", { cause: error });
  }
  const unexpected = untracked
    .split("\0")
    .filter((entry) => entry.length > 0 && (allowedPrefix === undefined || !entry.startsWith(allowedPrefix)));
  if (unexpected.length > 0) {
    throw new Error(
      "workspace-provenance failure: task worktree has unexpected untracked source before agent execution"
    );
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
