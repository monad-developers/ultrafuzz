import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { EVAL_WATCH_TIMEOUT_SECONDS } from "./defaults.js";
import {
  inspectPinnedSource,
  PINNED_SOURCE_PROOF_SCHEMA_VERSION,
  PINNED_SOURCE_REF,
  type PinnedSourceProof
} from "./pinned-source.js";
import type { TerminalDisposition } from "./terminal-disposition.js";
import { CheckpointIncompatibleError } from "./worker-lineage.js";

export interface ModalResumeWorkspace {
  target: string;
  control: string;
  evalRunId: string;
  productRunId: string;
}

export interface ModalResumeRunState {
  run_id: string;
  status?: string;
  created_at?: string;
  started_at?: string;
  finished_at?: string;
  nodes?: Record<string, { status?: string }>;
}

export interface ModalResumeCheckpointCounts {
  succeeded: number;
  failed: number;
  remaining: number;
}

const fullPinnedRevision = /^[0-9a-f]{40}$/u;

export class NonResumableTerminalRunError extends Error {
  readonly code = "TERMINAL_RUN_NON_RESUMABLE";

  constructor(status: string | undefined, disposition: TerminalDisposition | undefined) {
    super(
      `refusing to finalize non-resumable terminal run status ${status ?? "unknown"} with disposition ${
        disposition?.kind ?? "unknown"
      }`
    );
    this.name = "NonResumableTerminalRunError";
  }
}

export function modalDurableResumeCommand(cliPath: string, runId: string, projectRoot: string): string[] {
  return ["node", cliPath, "resume", runId, "--project", projectRoot, "--force", "--retry-failed", "--json"];
}

export function modalDurableRunNeedsResume(
  state: ModalResumeRunState,
  counts: ModalResumeCheckpointCounts,
  disposition?: TerminalDisposition
): boolean {
  if (isTerminalRunStatus(state.status) && disposition !== undefined) return false;
  if (!isTerminalRunStatus(state.status)) return true;
  return counts.failed > 0 || counts.remaining > 0;
}

export async function runModalDurableResumeIfNeeded<T>(input: {
  state: ModalResumeRunState;
  counts: ModalResumeCheckpointCounts;
  disposition?: TerminalDisposition;
  resume: () => Promise<T>;
}): Promise<T | undefined> {
  if (!modalDurableRunNeedsResume(input.state, input.counts, input.disposition)) return undefined;
  return input.resume();
}

export function assertModalPinnedTargetRevision(revision: string): string {
  if (!fullPinnedRevision.test(revision)) {
    throw new CheckpointIncompatibleError("persistent benchmark target revision is not an exact commit");
  }
  return revision;
}

export async function assertModalPinnedWorkspace(input: {
  target: string;
  revision: string;
  proofPath: string;
}): Promise<void> {
  const revision = assertModalPinnedTargetRevision(input.revision);
  try {
    const recorded = await readPinnedSourceProof(input.proofPath);
    const inspected = await inspectPinnedSource(input.target, revision, undefined, {
      allowDirty: true,
      allowUltrafuzzWorktreeRefs: true
    });
    if (!matchesPinnedSourceProof(recorded, inspected, revision)) {
      throw new Error("persistent benchmark source proof does not match the inspected source");
    }
  } catch (error) {
    if (error instanceof CheckpointIncompatibleError) throw error;
    throw new CheckpointIncompatibleError("persistent benchmark source is not pinned", { cause: error });
  }
}

async function readPinnedSourceProof(filePath: string): Promise<unknown> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size <= 0n || before.size > 64n * 1024n) {
      throw new Error("persistent benchmark source proof is not a regular file");
    }
    const contents = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < contents.byteLength) {
      const { bytesRead } = await handle.read(contents, offset, contents.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== Number(before.size)) throw new Error("persistent benchmark source proof changed while reading");
    const after = await handle.stat({ bigint: true });
    const current = await lstat(filePath, { bigint: true });
    if (!samePinnedProofIdentity(before, after) || !samePinnedProofIdentity(before, current)) {
      throw new Error("persistent benchmark source proof changed while reading");
    }
    return JSON.parse(contents.subarray(0, offset).toString("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}

function samePinnedProofIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    right.isFile() &&
    right.nlink === 1n &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

function matchesPinnedSourceProof(
  value: unknown,
  inspected: PinnedSourceProof,
  revision: string
): value is PinnedSourceProof {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proof = value as Partial<PinnedSourceProof>;
  return (
    Object.keys(proof).sort().join("\0") ===
      ["base_ref", "commit", "commit_object_count", "refs", "remotes", "revision_count", "schema_version", "tree"]
        .sort()
        .join("\0") &&
    proof.schema_version === PINNED_SOURCE_PROOF_SCHEMA_VERSION &&
    proof.commit === revision &&
    proof.commit === inspected.commit &&
    proof.tree === inspected.tree &&
    proof.base_ref === PINNED_SOURCE_REF &&
    proof.revision_count === 1 &&
    proof.commit_object_count === 1 &&
    Array.isArray(proof.remotes) &&
    proof.remotes.length === 0 &&
    Array.isArray(proof.refs) &&
    proof.refs.length === 1 &&
    proof.refs[0]?.name === PINNED_SOURCE_REF &&
    proof.refs[0].object === revision &&
    inspected.refs.some((ref) => ref.name === proof.refs![0]!.name && ref.object === proof.refs![0]!.object)
  );
}

export async function withModalPinnedWorkspace<T>(input: {
  target: string;
  revision: string;
  proofPath: string;
  run: () => Promise<T>;
}): Promise<T> {
  await assertModalPinnedWorkspace(input);
  return input.run();
}

export function modalDurableRunAdvanced(before: ModalResumeRunState, after: ModalResumeRunState): boolean {
  if (before.run_id !== after.run_id) return false;
  if (before.status !== after.status) return true;
  return JSON.stringify(nodeStatuses(before.nodes)) !== JSON.stringify(nodeStatuses(after.nodes));
}

function isTerminalRunStatus(status: string | undefined): boolean {
  return status !== undefined && ["succeeded", "failed", "timed-out", "canceled"].includes(status);
}

function nodeStatuses(nodes: ModalResumeRunState["nodes"]): Array<[string, string | undefined]> {
  return Object.entries(nodes ?? {})
    .map(([nodeId, node]) => [nodeId, node.status] as [string, string | undefined])
    .sort(([left], [right]) => left.localeCompare(right));
}

export function modalEvalRunCommand(input: {
  cliPath: string;
  controlRoot: string;
  suitePath: string;
  evalRunId: string;
}): string[] {
  return [
    "node",
    input.cliPath,
    "eval",
    "run",
    "--project",
    input.controlRoot,
    "--suite",
    input.suitePath,
    "--provider",
    "braintrust",
    "--eval-run-id",
    input.evalRunId,
    "--watch-timeout-seconds",
    String(EVAL_WATCH_TIMEOUT_SECONDS),
    "--json"
  ];
}

export async function locateModalResumeWorkspace(workRoot: string): Promise<ModalResumeWorkspace> {
  const target = path.join(workRoot, "target");
  const control = path.join(workRoot, "control");
  if (!(await isDirectoryNotSymlink(target)) || !(await isDirectoryNotSymlink(control))) {
    throw new Error("persistent workspace is incomplete");
  }
  const evalRoot = path.join(control, ".ultrafuzz", "evals", "runs");
  const candidates = [];
  for (const name of await readdir(evalRoot)) {
    const root = path.join(evalRoot, name);
    if ((await isDirectoryNotSymlink(root)) && (await isRegularFileNotSymlink(path.join(root, "eval.json")))) {
      candidates.push(name);
    }
  }
  if (candidates.length !== 1) {
    throw new Error(`resume requires exactly one evaluation run, found ${candidates.length}`);
  }
  const evalRunId = candidates[0]!;
  const records = await readRecords(path.join(evalRoot, evalRunId, "runs.jsonl"));
  const productRunIds = new Set(
    records
      .map((record) => record.ultrafuzz_run_id)
      .filter((value): value is string => typeof value === "string" && value.trim() !== "")
  );
  if (productRunIds.size !== 1) {
    throw new Error(`resume requires exactly one linked durable run, found ${productRunIds.size}`);
  }
  return { target, control, evalRunId, productRunId: [...productRunIds][0]! };
}

export async function repairModalEvalRunRecord(
  workspace: ModalResumeWorkspace,
  state: ModalResumeRunState,
  disposition: TerminalDisposition | undefined
): Promise<void> {
  const genuineTaskOutcome = state.status === "failed" && disposition?.kind === "genuine-task-failures";
  if (state.status !== "succeeded" && !genuineTaskOutcome) {
    throw new NonResumableTerminalRunError(state.status, disposition);
  }
  if (state.run_id !== workspace.productRunId) {
    throw new Error(`refusing to finalize evaluation row from unrelated run ${state.run_id}`);
  }
  const evalDir = path.join(workspace.control, ".ultrafuzz", "evals", "runs", workspace.evalRunId);
  const recordsPath = path.join(evalDir, "runs.jsonl");
  const records = await readRecords(recordsPath);
  const linked = records.filter((record) => record.ultrafuzz_run_id === state.run_id);
  if (linked.length === 0) throw new Error(`evaluation run does not reference durable run ${state.run_id}`);
  const rowIds = new Set(linked.map((record) => record.row_id));
  if (rowIds.size !== 1) throw new Error("evaluation run has ambiguous linked rows");
  const record = linked[linked.length - 1]!;
  const finalStatus = state.status;
  const currentWorkflow =
    typeof record.workflow === "object" && record.workflow !== null && !Array.isArray(record.workflow)
      ? (record.workflow as Record<string, unknown>)
      : undefined;
  const finishedAt =
    timestamp(state.finished_at) ??
    timestamp(currentWorkflow?.finished_at) ??
    timestamp(record.finished_at) ??
    new Date().toISOString();
  const workflow = {
    status: finalStatus,
    terminal: true,
    started_at:
      timestamp(currentWorkflow?.started_at) ?? timestamp(state.started_at) ?? timestamp(state.created_at) ?? null,
    finished_at: finishedAt
  };
  const updated =
    record.final_status === finalStatus &&
    currentWorkflow?.status === workflow.status &&
    currentWorkflow?.terminal === workflow.terminal &&
    currentWorkflow?.started_at === workflow.started_at &&
    currentWorkflow?.finished_at === workflow.finished_at
      ? record
      : { ...record, final_status: finalStatus, workflow, finished_at: finishedAt };
  if (updated !== record) await appendLineDurable(recordsPath, `${JSON.stringify(updated)}\n`);
  await writeJsonAtomic(path.join(evalDir, "run-summary.json"), {
    eval_run_id: workspace.evalRunId,
    launched: 1,
    failed: 0,
    incomplete: 0,
    records: [updated]
  });
}

function timestamp(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

async function readRecords(filePath: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(filePath, "utf8"))
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filePath);
    await syncDirectory(path.dirname(filePath));
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function appendLineDurable(filePath: string, line: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const handle = await open(filePath, "a", 0o600);
  try {
    await handle.writeFile(line, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(filePath));
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await open(directoryPath, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function isDirectoryNotSymlink(filePath: string): Promise<boolean> {
  return lstat(filePath)
    .then((stat) => stat.isDirectory() && !stat.isSymbolicLink())
    .catch(() => false);
}

async function isRegularFileNotSymlink(filePath: string): Promise<boolean> {
  return lstat(filePath)
    .then((stat) => stat.isFile() && !stat.isSymbolicLink())
    .catch(() => false);
}
