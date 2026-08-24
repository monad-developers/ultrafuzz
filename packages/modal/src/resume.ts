import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import { layoutForRunRoot, readRunMetadataDocument, readRunState } from "@ultrafuzz/artifacts";
import {
  appendEvalRunRecord,
  EVAL_RUN_SUMMARY_SCHEMA_VERSION,
  readEvalRunManifest,
  readEvalRunRecords,
  writeEvalRunSummary,
  type EvalRunRecord,
  type EvalWorkflowLifecycle
} from "@ultrafuzz/evals";

import { EVAL_WATCH_TIMEOUT_SECONDS } from "./defaults.js";
import type { TerminalDisposition } from "./terminal-disposition.js";
import { TERMINAL_RUN_STATE_STATUSES } from "@ultrafuzz/artifacts";

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

export function modalDurableRunNeedsResume(
  state: ModalResumeRunState,
  counts: ModalResumeCheckpointCounts,
  disposition?: TerminalDisposition
): boolean {
  if (disposition?.kind === "genuine-task-failures") return false;
  if (!isTerminalRunStatus(state.status)) return true;
  return counts.failed > 0 || counts.remaining > 0;
}

export function modalDurableRunAdvanced(before: ModalResumeRunState, after: ModalResumeRunState): boolean {
  if (before.run_id !== after.run_id) return false;
  if (before.status !== after.status) return true;
  return JSON.stringify(nodeStatuses(before.nodes)) !== JSON.stringify(nodeStatuses(after.nodes));
}

export async function readModalDurableRunState(
  target: string,
  expectedRunId: string
): Promise<ModalResumeRunState | undefined> {
  const statePath = path.join(target, ".ultrafuzz/runs", expectedRunId, "state.json");
  try {
    await lstat(statePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const state = readRunState(statePath);
  if (state.run_id !== expectedRunId) {
    throw new Error(`durable run state identifies ${state.run_id}, expected ${expectedRunId}`);
  }
  return state;
}

function isTerminalRunStatus(status: string | undefined): boolean {
  return status !== undefined && (TERMINAL_RUN_STATE_STATUSES as readonly string[]).includes(status);
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
  | {
      readonly kind: "not-started";
      readonly reason: string;
      readonly staleEvalRunIds?: readonly string[];
      /** Run roots that exist but can never be resumed, so a restart must clear them (`RUN_ALREADY_EXISTS`). */
      readonly staleRunRootIds?: readonly string[];
    };

/**
 * Decide whether a volume holds a resumable run, WITHOUT treating "nothing to resume" as a failure.
 *
 * `runs.jsonl` is the canonical evaluation-to-run link. A durable run that exists on disk but is absent
 * from that journal is inconsistent state, not evidence from which to reconstruct a missing record. The
 * strict-contract release intentionally fails that window closed: it never infers or writes a link after
 * the fact.
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
  const directories = [];
  const candidates = [];
  const unclassifiableEvalEntries = [];
  for (const name of names) {
    const root = path.join(evalRoot, name);
    // Same reasoning as the run-root loop below: `runEvalSuite` refuses on `fs.existsSync`, which follows
    // symlinks and does not care about entry type, so an entry skipped silently here would still block a
    // restart. Report it instead of dropping it into invisibility.
    if (!(await isDirectoryNotSymlink(root))) {
      unclassifiableEvalEntries.push(name);
      continue;
    }
    // Tracked separately from `candidates`: `runEvalSuite` refuses to reuse an id whose DIRECTORY exists,
    // and it creates that directory before writing `eval.json`. A kill in between leaves a directory that
    // is not a candidate but still blocks reuse, so a restart has to be told to clear it.
    directories.push(name);
    const manifestPath = path.join(root, "eval.json");
    const manifestStat = await lstatIfMissing(manifestPath);
    if (manifestStat !== undefined) {
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
        throw new Error(`evaluation manifest at ${manifestPath} must be a regular file`);
      }
      candidates.push(name);
    }
  }
  // Assert the shape of whatever IS present before deciding anything, including in the zero-candidate case.
  // A path that exists but is a symlink is damage at any candidate count, and the rest of this file is
  // careful to refuse symlinks everywhere; skipping that here would let a symlinked `control` through.
  await assertWorkspaceShape(target);
  await assertWorkspaceShape(control);
  if (candidates.length === 0) {
    const durable = await durableRunsOnDisk(target);
    if (durable.resumable.length > 0) {
      // A linked run with no evaluation to attach it to is damage, not a fresh start. Restarting would
      // abandon it and deleting it is exactly what this function exists to avoid, so refuse instead.
      throw new Error(`workspace has ${durable.resumable.length} linked durable run(s) but no evaluation run`);
    }
    assertNoDamagedRunRoots(durable.damaged);
    assertNoUnclassifiableEvalEntries(unclassifiableEvalEntries);
    return {
      kind: "not-started",
      reason: "resume requires exactly one evaluation run, found 0",
      ...(directories.length === 0 ? {} : { staleEvalRunIds: directories }),
      ...(durable.orphaned.length === 0 ? {} : { staleRunRootIds: durable.orphaned })
    };
  }
  if (candidates.length > 1) {
    throw new Error(`resume requires exactly one evaluation run, found ${candidates.length}`);
  }
  // The workspace now claims to hold an evaluation, so target and control must both actually be there.
  if (!(await isDirectoryNotSymlink(target)) || !(await isDirectoryNotSymlink(control))) {
    throw new Error("persistent workspace is incomplete");
  }
  const evalRunId = candidates[0]!;
  const manifest = readEvalRunManifest(path.join(evalRoot, evalRunId, "eval.json"));
  if (manifest.eval_run_id !== evalRunId) {
    throw new Error(`evaluation manifest identifies ${manifest.eval_run_id}, expected ${evalRunId}`);
  }
  if (path.resolve(manifest.project_root) !== path.resolve(control)) {
    throw new Error("evaluation manifest project root does not identify the persistent control workspace");
  }
  // A missing journal is the earliest form of the same window: `eval.json` is written before the first
  // append, so a kill in between leaves no file at all. That is a state to classify, not to crash on.
  const records = readEvalRunRecords(path.join(evalRoot, evalRunId, "runs.jsonl"));
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
  const durable = await durableRunsOnDisk(target);
  if (durable.resumable.length > 0) {
    throw new Error(
      `evaluation journal does not link durable run(s) ${durable.resumable.join(", ")}; refusing to infer a missing link`
    );
  }
  // Damage only matters on the branch that would restart: a damaged root blocks `planRun`, but it must not
  // preempt resuming a run that is perfectly good. This applies to the `damaged` LIST only — a read fault
  // or malformed metadata raised while classifying some other root still propagates from the loop above and
  // will preempt a resume. That is deliberate (it fails closed and never deletes), but it is not what this
  // deferral promises.
  assertNoDamagedRunRoots(durable.damaged);
  assertNoUnclassifiableEvalEntries(unclassifiableEvalEntries);
  return {
    kind: "not-started",
    reason: "resume requires exactly one linked durable run, found 0",
    // Every eval run directory, not just the candidate: `runEvalSuite` refuses any id whose directory
    // exists, so naming only the candidate would leave a non-candidate directory blocking the restart.
    staleEvalRunIds: directories,
    ...(durable.orphaned.length === 0 ? {} : { staleRunRootIds: durable.orphaned })
  };
}

/**
 * Run roots on disk, split by whether `resume` could actually resume them.
 *
 * The line is the workflow link in the run metadata, whose path is taken from `layoutForRunRoot` and never
 * restated here — see `hasLinkedWorkflow`. `persistSmithersEvidence` writes that link immediately
 * after the workflow compiles and BEFORE it is submitted, and `readLinkedWorkflowEvidence` refuses any run
 * without it (`WORKFLOW_RUN_ID_MISSING`). So the two halves of the failure window differ:
 *
 *   - compiled, then failed to submit -> linked, and genuinely resumable. This is the R54 case.
 *   - died during compilation, or with only a partial run layout -> no link, and `resume` refuses it
 *     forever. Calling that resumable only relocates the wedge; it has to be cleared instead, or a restart
 *     trips `RUN_ALREADY_EXISTS` on its deterministic run id.
 *
 * `state.json` alone is not the test: `createRunLayout` writes it well before compilation, so requiring
 * only that would classify a run nothing can resume as resumable.
 */
async function durableRunsOnDisk(
  target: string
): Promise<{ resumable: string[]; orphaned: string[]; damaged: string[] }> {
  const runsRoot = path.join(target, ".ultrafuzz", "runs");
  const resumable = [];
  const orphaned = [];
  const damaged = [];
  for (const name of await readdirIfMissing(runsRoot)) {
    const root = path.join(runsRoot, name);
    // An entry this function cannot classify is reported, never skipped. `planRun` refuses on
    // `existsSync`, which follows symlinks and does not care whether the name is layout-addressable, so
    // anything dropped here silently would still block a restart — invisibly, which is the whole subject
    // of #378.
    if (!(await isDirectoryNotSymlink(root)) || !isLayoutAddressable(root)) {
      damaged.push(name);
      continue;
    }
    const linked = await hasLinkedWorkflow(root);
    const hasState = await isRegularFileNotSymlink(path.join(root, "state.json"));
    // `orphaned` is a POSITIVE determination — the metadata was read and carries no workflow link — and not
    // merely "not resumable". The difference is destructive: the caller deletes orphaned roots, and the
    // link is written before submission, so a root that HAS a link is one a workflow may have run from.
    // Missing its state is damage to report, never something to delete.
    if (!linked) orphaned.push(name);
    else if (hasState) resumable.push(name);
    else damaged.push(name);
  }
  return { resumable: resumable.sort(), orphaned: orphaned.sort(), damaged: damaged.sort() };
}

/**
 * Whether the runtime's own layout helper can address this run root.
 *
 * Derived by asking the helper rather than restating its id rule. A name it rejects would otherwise throw
 * out of the lookup on every generation, with nothing able to clear it — one stray directory would strand
 * the run permanently.
 */
function isLayoutAddressable(runRoot: string): boolean {
  try {
    layoutForRunRoot(runRoot);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the run metadata carries the workflow link `resume` requires.
 *
 * The path comes from `layoutForRunRoot`, the same helper the runtime writes and reads it through, and is
 * deliberately not restated here. An earlier revision named the file itself and named it wrongly, which
 * classified every real run root as unresumable — and because the caller deletes unresumable roots, that
 * turned this predicate into a destructive one while leaving #378 unfixed.
 *
 * Errors are NOT swallowed. Absence means the link was never written; EACCES or EIO on a durable volume
 * mean the answer is unknown, and answering "unlinked" to an unknown is how a read fault becomes a
 * deletion. Only ENOENT counts as absence, matching `readdirIfMissing`.
 */
async function hasLinkedWorkflow(runRoot: string): Promise<boolean> {
  const metadataPath = layoutForRunRoot(runRoot).runMetadataPath;
  const metadataStat = await lstat(metadataPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (metadataStat === undefined) return false;
  if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) {
    throw new Error(`run metadata at ${metadataPath} must be a regular file`);
  }
  let metadata;
  try {
    metadata = readRunMetadataDocument(metadataPath, path.basename(runRoot));
  } catch (error) {
    throw new Error(`run metadata at ${metadataPath} is not a valid current run document`, {
      cause: error
    });
  }
  return metadata.workflow !== undefined;
}

/**
 * Refuse to restart over an eval run entry that is not a directory. Deleting something we cannot classify
 * would be worse, and ignoring it hands the restart an `EVAL_RUN_ALREADY_EXISTS` it cannot clear.
 */
function assertNoUnclassifiableEvalEntries(entries: readonly string[]): void {
  if (entries.length === 0) return;
  throw new Error(
    `evaluation run entr(ies) ${[...entries].sort().join(", ")} are not directories and would block a restart; ` +
      `resolve them on the volume`
  );
}

/**
 * Refuse to restart over a run root that cannot be classified, rather than deleting it or ignoring it.
 *
 * Sorted so the message is deterministic when there is more than one.
 */
function assertNoDamagedRunRoots(damaged: readonly string[]): void {
  if (damaged.length === 0) return;
  throw new Error(
    `durable run root(s) ${damaged.join(", ")} cannot be classified as resumable or unstarted; ` +
      `resolve them on the volume before this run can restart`
  );
}

/** Refuse a path that exists but is not a real directory. An absent path is the ordinary fresh case. */
async function assertWorkspaceShape(directoryPath: string): Promise<void> {
  const stat = await lstat(directoryPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (stat !== undefined && !stat.isDirectory()) {
    throw new Error("persistent workspace is incomplete");
  }
}

async function readdirIfMissing(directoryPath: string): Promise<string[]> {
  return readdir(directoryPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
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

export async function finalizeModalEvalRunRecord(
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
  const records = readEvalRunRecords(recordsPath);
  const linked = records.filter((record) => record.ultrafuzz_run_id === state.run_id);
  if (linked.length === 0) throw new Error(`evaluation run does not reference durable run ${state.run_id}`);
  const rowIds = new Set(linked.map((record) => record.row_id));
  if (rowIds.size !== 1) throw new Error("evaluation run has ambiguous linked rows");
  const record = linked[linked.length - 1]!;
  const expectedRunRoot = path.join(workspace.target, ".ultrafuzz", "runs", state.run_id);
  if (record.ultrafuzz_run_root !== expectedRunRoot || record.status !== "launched") {
    throw new Error(`evaluation row for durable run ${state.run_id} is not a complete launched record`);
  }
  const finalStatus: "succeeded" | "failed" = state.status === "succeeded" ? "succeeded" : "failed";
  const currentWorkflow = record.workflow;
  const startedAt = timestamp(state.started_at);
  const finishedAt = timestamp(state.finished_at);
  if (startedAt === undefined || finishedAt === undefined) {
    throw new Error(`terminal durable run ${state.run_id} is missing canonical lifecycle timestamps`);
  }
  const workflow: EvalWorkflowLifecycle = {
    status: finalStatus,
    terminal: true,
    started_at: startedAt,
    finished_at: finishedAt
  };
  const updated: EvalRunRecord =
    record.final_status === finalStatus &&
    currentWorkflow?.status === workflow.status &&
    currentWorkflow?.terminal === workflow.terminal &&
    currentWorkflow?.started_at === workflow.started_at &&
    currentWorkflow?.finished_at === workflow.finished_at
      ? record
      : { ...record, final_status: finalStatus, workflow };
  if (updated !== record) appendEvalRunRecord(recordsPath, updated);
  writeEvalRunSummary(path.join(evalDir, "run-summary.json"), {
    schema_version: EVAL_RUN_SUMMARY_SCHEMA_VERSION,
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

async function isDirectoryNotSymlink(filePath: string): Promise<boolean> {
  const stat = await lstatIfMissing(filePath);
  return stat !== undefined && stat.isDirectory() && !stat.isSymbolicLink();
}

async function isRegularFileNotSymlink(filePath: string): Promise<boolean> {
  const stat = await lstatIfMissing(filePath);
  return stat !== undefined && stat.isFile() && !stat.isSymbolicLink();
}

async function lstatIfMissing(filePath: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  return lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}
