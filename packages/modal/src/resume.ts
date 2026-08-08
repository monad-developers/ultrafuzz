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
  | { readonly kind: "not-started"; readonly reason: string };

/**
 * Decide whether a volume holds a resumable run, WITHOUT treating "nothing to resume" as a failure.
 *
 * The distinction this draws is the whole point (#378). A durable run is linked into `runs.jsonl` only
 * once it exists, but the eval run directory is created earlier, by `eval run` itself
 * (`packages/evals/src/runner.ts` writes `eval.json`). Anything that kills generation 0 in between —
 * workflow compilation, workflow submission, a registry hiccup during either — leaves a directory and a
 * row behind with no `ultrafuzz_run_id` on it. That state is not damage and it is not progress; it means
 * the run never started, and the only correct response is to start it.
 *
 * Zero and many are therefore not symmetric, and are not collapsed into one condition:
 *   - **zero** linked runs means nothing was ever recorded, so restarting loses nothing by construction;
 *   - **more than one** means two durable runs are linked to a single evaluation, which no correct
 *     producer can do. That stays a hard failure, because silently picking a side, or restarting over it,
 *     would destroy a real run.
 */
export async function findModalResumeWorkspace(workRoot: string): Promise<ModalResumeLookup> {
  const target = path.join(workRoot, "target");
  const control = path.join(workRoot, "control");
  const evalRoot = path.join(control, ".ultrafuzz", "evals", "runs");
  // Read the eval root BEFORE asserting the workspace is complete. A fresh sandbox has neither, and
  // checking completeness first would report an empty volume as "incomplete" — damage — rather than as
  // the ordinary not-started case it is.
  const names = await readdir(evalRoot).catch(() => [] as string[]);
  const candidates = [];
  for (const name of names) {
    const root = path.join(evalRoot, name);
    if ((await isDirectoryNotSymlink(root)) && (await isRegularFileNotSymlink(path.join(root, "eval.json")))) {
      candidates.push(name);
    }
  }
  if (candidates.length === 0) {
    return { kind: "not-started", reason: "resume requires exactly one evaluation run, found 0" };
  }
  if (candidates.length > 1) {
    throw new Error(`resume requires exactly one evaluation run, found ${candidates.length}`);
  }
  // Only now is the workspace claiming to hold an evaluation, so an absent target or control really is
  // damage rather than an empty volume.
  if (!(await isDirectoryNotSymlink(target)) || !(await isDirectoryNotSymlink(control))) {
    throw new Error("persistent workspace is incomplete");
  }
  const evalRunId = candidates[0]!;
  const records = await readRecords(path.join(evalRoot, evalRunId, "runs.jsonl"));
  const productRunIds = new Set(
    records
      .map((record) => record.ultrafuzz_run_id)
      .filter((value): value is string => typeof value === "string" && value.trim() !== "")
  );
  if (productRunIds.size === 0) {
    return { kind: "not-started", reason: "resume requires exactly one linked durable run, found 0" };
  }
  if (productRunIds.size > 1) {
    throw new Error(`resume requires exactly one linked durable run, found ${productRunIds.size}`);
  }
  return { kind: "resumable", workspace: { target, control, evalRunId, productRunId: [...productRunIds][0]! } };
}

/** The strict form: for callers that have already established a run must be resumable. */
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
