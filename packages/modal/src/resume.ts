import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { EVAL_WATCH_TIMEOUT_SECONDS } from "./defaults.js";
import type { TerminalDisposition } from "./terminal-disposition.js";

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

export function modalDurableRunNeedsResume(state: ModalResumeRunState, counts: ModalResumeCheckpointCounts): boolean {
  if (!isTerminalRunStatus(state.status)) return true;
  return counts.failed > 0 || counts.remaining > 0;
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
  provider?: "braintrust" | "none";
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
    input.provider ?? "braintrust",
    "--eval-run-id",
    input.evalRunId,
    "--watch-timeout-seconds",
    String(EVAL_WATCH_TIMEOUT_SECONDS),
    "--json"
  ];
}

/**
 * What a volume holds: either a run that can genuinely be resumed, or one that never got far enough to
 * have anything to resume from.
 *
 * `not-started` is deliberately NOT an error. A worker that finds it should build the workspace through
 * the normal pre-model path instead of failing (#378).
 */
export type ModalResumeLookup =
  | { readonly kind: "resumable"; readonly workspace: ModalResumeWorkspace }
  | { readonly kind: "not-started"; readonly reason: string; readonly staleEvalRunId?: string };

/**
 * Decide whether a volume holds a resumable run, WITHOUT treating "nothing to resume" as a failure.
 *
 * The problem this solves (#378): `runs.jsonl` is the journal that links an evaluation row to the durable
 * run executing it, and that link is appended only AFTER the launcher returns. `startRun` creates the run
 * root, writes `state.json`, compiles the workflow and submits it before returning. So there is a wide
 * window — the whole of compilation and submission — in which a real durable run exists on disk, with real
 * completed nodes, and nothing in the journal points at it. Reading the journal alone, that is
 * indistinguishable from "never started", and the worker used to reject it outright and wedge the run
 * permanently, because the state is on a durable volume and so recurs every generation.
 *
 * The journal is therefore treated as a cache, not as the source of truth. When it holds no link, the
 * durable run directory is consulted directly:
 *
 *   - **a durable run exists** -> resumable. Its link is missing, not the run. `repairModalEvalRunRecord`
 *     writes the link back when the run finalizes. Restarting here would abandon completed work, and would
 *     fail anyway: row run ids are deterministic, so `planRun` would refuse with `RUN_ALREADY_EXISTS`.
 *   - **no durable run exists** -> genuinely not started. `staleEvalRunId` names the leftover eval run
 *     directory the caller must clear first, because eval run ids are deterministic too and `runEvalSuite`
 *     refuses to reuse one (`EVAL_RUN_ALREADY_EXISTS`).
 *
 * Counts of linked runs stay asymmetric: more than one durable run linked to a single evaluation is
 * corruption no correct producer can create, and silently picking a side would destroy a real run.
 */
export async function findModalResumeWorkspace(workRoot: string): Promise<ModalResumeLookup> {
  const target = path.join(workRoot, "target");
  const control = path.join(workRoot, "control");
  const evalRoot = path.join(control, ".ultrafuzz", "evals", "runs");
  // Only a genuinely absent directory means "nothing here". EACCES, EIO or ESTALE on a durable volume are
  // faults, and reading them as "the run never started" is how a transient mount problem would become a
  // restart over live work.
  const names = await readdirIfMissing(evalRoot);
  const candidates = [];
  for (const name of names) {
    const root = path.join(evalRoot, name);
    if ((await isDirectoryNotSymlink(root)) && (await isRegularFileNotSymlink(path.join(root, "eval.json")))) {
      candidates.push(name);
    }
  }
  // Assert the shape of whatever IS present before deciding anything, including in the zero-candidate case.
  // A path that exists but is a symlink is damage at any candidate count, and the rest of this file is
  // careful to refuse symlinks everywhere; skipping that here would let a symlinked `control` through.
  await assertWorkspaceShape(target);
  await assertWorkspaceShape(control);
  if (candidates.length === 0) {
    return { kind: "not-started", reason: "resume requires exactly one evaluation run, found 0" };
  }
  if (candidates.length > 1) {
    throw new Error(`resume requires exactly one evaluation run, found ${candidates.length}`);
  }
  // The workspace now claims to hold an evaluation, so target and control must both actually be there.
  if (!(await isDirectoryNotSymlink(target)) || !(await isDirectoryNotSymlink(control))) {
    throw new Error("persistent workspace is incomplete");
  }
  const evalRunId = candidates[0]!;
  // A missing journal is the earliest form of the same window: `eval.json` is written before the first
  // append, so a kill in between leaves no file at all. That is a state to classify, not to crash on.
  const records = await readRecordsIfMissing(path.join(evalRoot, evalRunId, "runs.jsonl"));
  const productRunIds = new Set(
    records
      .map((record) => record.ultrafuzz_run_id)
      .filter((value): value is string => typeof value === "string" && value.trim() !== "")
  );
  if (productRunIds.size > 1) {
    throw new Error(`resume requires exactly one linked durable run, found ${productRunIds.size}`);
  }
  if (productRunIds.size === 1) {
    return { kind: "resumable", workspace: { target, control, evalRunId, productRunId: [...productRunIds][0]! } };
  }
  const durableRunIds = await durableRunIdsOnDisk(target);
  if (durableRunIds.length > 1) {
    throw new Error(`resume requires exactly one durable run on disk, found ${durableRunIds.length}`);
  }
  if (durableRunIds.length === 1) {
    return { kind: "resumable", workspace: { target, control, evalRunId, productRunId: durableRunIds[0]! } };
  }
  return {
    kind: "not-started",
    reason: "resume requires exactly one linked durable run, found 0",
    staleEvalRunId: evalRunId
  };
}

/** Durable runs present on disk, identified the same way the runtime identifies them: a run root with state. */
async function durableRunIdsOnDisk(target: string): Promise<string[]> {
  const runsRoot = path.join(target, ".ultrafuzz", "runs");
  const found = [];
  for (const name of await readdirIfMissing(runsRoot)) {
    const root = path.join(runsRoot, name);
    if ((await isDirectoryNotSymlink(root)) && (await isRegularFileNotSymlink(path.join(root, "state.json")))) {
      found.push(name);
    }
  }
  return found.sort();
}

/** Refuse a path that exists but is not a real directory. An absent path is the ordinary fresh case. */
async function assertWorkspaceShape(directoryPath: string): Promise<void> {
  const stat = await lstat(directoryPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
    throw error;
  });
  if (stat !== undefined && !stat.isDirectory()) {
    throw new Error("persistent workspace is incomplete");
  }
}

async function readdirIfMissing(directoryPath: string): Promise<string[]> {
  return readdir(directoryPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [] as string[];
    throw error;
  });
}

/**
 * The strict form. Retained for tests and for any caller that has already established the run must be
 * resumable; `worker.ts` deliberately uses the tolerant lookup above instead.
 */
export async function locateModalResumeWorkspace(workRoot: string): Promise<ModalResumeWorkspace> {
  const found = await findModalResumeWorkspace(workRoot);
  if (found.kind === "not-started") throw new Error(found.reason);
  return found.workspace;
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
  const records = await readRecordsIfMissing(recordsPath);
  let linked: Array<Record<string, unknown>> = records.filter((record) => record.ultrafuzz_run_id === state.run_id);
  // #378: the journal may never have recorded the link, because it is appended only after the launcher
  // returns. The run itself is the evidence it existed, so write the link the journal is missing rather
  // than refuse a run that plainly ran. Only safe when NOTHING is linked: a journal that points at some
  // other durable run is a genuine mismatch and must still be refused.
  const linkageMissing = linked.length === 0 && !records.some((record) => isLinked(record));
  if (linkageMissing) {
    linked = [{ ...(records[records.length - 1] ?? {}), row_id: await soleRowId(evalDir, records) }];
  }
  if (linked.length === 0) throw new Error(`evaluation run does not reference durable run ${state.run_id}`);
  const rowIds = new Set(linked.map((record) => record.row_id));
  if (rowIds.size !== 1) throw new Error("evaluation run has ambiguous linked rows");
  const record: Record<string, unknown> = { ...linked[linked.length - 1]!, ultrafuzz_run_id: state.run_id };
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
  // A repaired link must reach the journal even when nothing else about the row changed, otherwise the
  // next generation would have to rediscover it from disk all over again.
  if (updated !== record || linkageMissing) await appendLineDurable(recordsPath, `${JSON.stringify(updated)}\n`);
  await writeJsonAtomic(path.join(evalDir, "run-summary.json"), {
    eval_run_id: workspace.evalRunId,
    launched: 1,
    failed: 0,
    incomplete: 0,
    records: [updated]
  });
}

function isLinked(record: Record<string, unknown>): boolean {
  return typeof record.ultrafuzz_run_id === "string" && record.ultrafuzz_run_id.trim() !== "";
}

/**
 * The one evaluation row a repaired link belongs to.
 *
 * Prefers the journal, and falls back to `matrix.json` for the case where the journal was never written at
 * all. Refuses anything ambiguous: attaching a durable run to the wrong row would misreport which
 * configuration produced the result, which is worse than failing to repair.
 */
async function soleRowId(evalDir: string, records: Array<Record<string, unknown>>): Promise<string> {
  const journalRowIds = new Set(
    records.map((record) => record.row_id).filter((value): value is string => typeof value === "string")
  );
  if (journalRowIds.size === 1) return [...journalRowIds][0]!;
  if (journalRowIds.size > 1) throw new Error("evaluation run has ambiguous linked rows");
  const matrix = (await readFile(path.join(evalDir, "matrix.json"), "utf8").then(
    (text) => JSON.parse(text) as unknown,
    () => undefined
  )) as Array<{ id?: unknown }> | undefined;
  const matrixRowIds = Array.isArray(matrix)
    ? matrix.map((row) => row?.id).filter((value): value is string => typeof value === "string")
    : [];
  if (matrixRowIds.length !== 1) {
    throw new Error(`evaluation run has no unambiguous row to link, found ${matrixRowIds.length}`);
  }
  return matrixRowIds[0]!;
}

function timestamp(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/**
 * Records, treating an absent journal as no records.
 *
 * A malformed line still throws, deliberately. `appendJsonLine` does not fsync, so a torn final line is
 * possible on a durable volume — and a torn line may be the very line carrying the durable run link.
 * Dropping it silently would read as "never linked" and could strand a live run, so this stays loud.
 */
async function readRecordsIfMissing(filePath: string): Promise<Array<Record<string, unknown>>> {
  return readRecords(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw error;
  });
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
