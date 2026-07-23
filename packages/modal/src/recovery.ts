import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { z } from "zod/v4";

import {
  MODAL_RECOVERY_BACKOFF_BASE_MS,
  MODAL_RECOVERY_BACKOFF_MAX_MS,
  MODAL_RECOVERY_MAX_NO_PROGRESS_GENERATIONS,
  MODAL_RECOVERY_RESUME_GRACE_MS,
  MODAL_RECOVERY_STALE_AFTER_MS,
  MODAL_RECOVERY_STATE_SCHEMA_VERSION
} from "./defaults.js";

const timestampSchema = z.iso.datetime({ offset: true });
const workerPhaseSchema = z.enum(["reserved", "launched", "stopped"]);
const workerStopReasonSchema = z.enum(["exited", "stalled", "rollout", "completed"]);
const rowStatusSchema = z.enum(["idle", "healthy", "grace", "backoff", "rollout-deferred", "terminal", "completed"]);

export type ModalRecoveryRowStatus = z.infer<typeof rowStatusSchema>;
export type ModalRecoveryWorkerPhase = z.infer<typeof workerPhaseSchema>;
export type ModalRecoveryWorkerStopReason = z.infer<typeof workerStopReasonSchema>;

export interface ModalRecoveryWorker {
  generation: number;
  attempt: number;
  attempt_id: string;
  name: string;
  image: string;
  phase: ModalRecoveryWorkerPhase;
  reserved_at: string;
  sandbox_id?: string;
  launched_at?: string;
  stopped_at?: string;
  stop_reason?: ModalRecoveryWorkerStopReason;
  baseline_successful_nodes: number;
  made_progress: boolean;
  no_progress_accounted: boolean;
}

export interface ModalRecoveryTerminalState {
  category: "no-progress-budget-exhausted";
  entered_at: string;
}

export interface ModalRecoveryRowState {
  slug: string;
  status: ModalRecoveryRowStatus;
  no_progress_generations: number;
  successful_nodes: number;
  last_progress_at?: string;
  next_eligible_at?: string;
  pending_image?: string;
  terminal?: ModalRecoveryTerminalState;
  workers: ModalRecoveryWorker[];
}

export interface ModalRecoveryState {
  schema_version: typeof MODAL_RECOVERY_STATE_SCHEMA_VERSION;
  logical_run_id: string;
  launch_generation: number;
  app: string;
  rows: ModalRecoveryRowState[];
}

export interface ModalRecoveryCanonicalProgress {
  status: string;
  successful_nodes: number;
  total_nodes: number;
  last_transition_at: string;
  last_success_at?: string;
}

export interface ModalRecoveryOwner {
  kind: "original" | "recovery";
  live: boolean;
  image: string;
  launched_at: string;
  generation?: number;
}

export interface ModalRecoveryPolicy {
  resumeGraceMs: number;
  staleAfterMs: number;
  maxNoProgressGenerations: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export const DEFAULT_MODAL_RECOVERY_POLICY: Readonly<ModalRecoveryPolicy> = {
  resumeGraceMs: MODAL_RECOVERY_RESUME_GRACE_MS,
  staleAfterMs: MODAL_RECOVERY_STALE_AFTER_MS,
  maxNoProgressGenerations: MODAL_RECOVERY_MAX_NO_PROGRESS_GENERATIONS,
  backoffBaseMs: MODAL_RECOVERY_BACKOFF_BASE_MS,
  backoffMaxMs: MODAL_RECOVERY_BACKOFF_MAX_MS
};

export type ModalRecoveryAction = "keep" | "wait" | "launch" | "replace" | "complete" | "terminal" | "defer-rollout";

export interface ModalRecoveryDecision {
  action: ModalRecoveryAction;
  reason:
    | "complete"
    | "canonical-progress"
    | "canonical-unavailable"
    | "resume-grace"
    | "backoff"
    | "owner-missing"
    | "owner-stalled"
    | "rollout-deferred"
    | "forced-rollout"
    | "no-progress-budget-exhausted";
  row: ModalRecoveryRowState;
  replacement_kind?: "recovery" | "rollout";
  retry_after_ms: number;
}

const recoveryWorkerSchema = z
  .object({
    generation: z.number().int().positive(),
    attempt: z.number().int().positive(),
    attempt_id: z.string().min(1),
    name: z.string().min(1),
    image: z.string().min(1),
    phase: workerPhaseSchema,
    reserved_at: timestampSchema,
    sandbox_id: z.string().min(1).optional(),
    launched_at: timestampSchema.optional(),
    stopped_at: timestampSchema.optional(),
    stop_reason: workerStopReasonSchema.optional(),
    baseline_successful_nodes: z.number().int().nonnegative(),
    made_progress: z.boolean(),
    no_progress_accounted: z.boolean()
  })
  .strict()
  .superRefine((worker, context) => {
    if (worker.phase === "launched" && (worker.sandbox_id === undefined || worker.launched_at === undefined)) {
      context.addIssue({ code: "custom", message: "launched recovery worker is missing ownership metadata" });
    }
    if (worker.phase === "stopped" && (worker.stopped_at === undefined || worker.stop_reason === undefined)) {
      context.addIssue({ code: "custom", message: "stopped recovery worker is missing terminal metadata" });
    }
  });

const recoveryRowSchema = z
  .object({
    slug: z.string().min(1),
    status: rowStatusSchema,
    no_progress_generations: z.number().int().nonnegative(),
    successful_nodes: z.number().int().nonnegative(),
    last_progress_at: timestampSchema.optional(),
    next_eligible_at: timestampSchema.optional(),
    pending_image: z.string().min(1).optional(),
    terminal: z
      .object({
        category: z.literal("no-progress-budget-exhausted"),
        entered_at: timestampSchema
      })
      .strict()
      .optional(),
    workers: z.array(recoveryWorkerSchema)
  })
  .strict()
  .superRefine((row, context) => {
    const generations = new Set<number>();
    for (const worker of row.workers) {
      if (generations.has(worker.generation)) {
        context.addIssue({ code: "custom", message: `duplicate recovery generation ${worker.generation}` });
      }
      generations.add(worker.generation);
    }
    if ((row.status === "terminal") !== (row.terminal !== undefined)) {
      context.addIssue({ code: "custom", message: "terminal recovery row must have exactly one terminal state" });
    }
  });

const recoveryStateSchema = z
  .object({
    schema_version: z.literal(MODAL_RECOVERY_STATE_SCHEMA_VERSION),
    logical_run_id: z.string().min(1),
    launch_generation: z.number().int().positive(),
    app: z.string().min(1),
    rows: z.array(recoveryRowSchema)
  })
  .strict()
  .superRefine((state, context) => {
    const slugs = new Set<string>();
    for (const row of state.rows) {
      if (slugs.has(row.slug)) context.addIssue({ code: "custom", message: `duplicate recovery row ${row.slug}` });
      slugs.add(row.slug);
    }
  });

export function parseModalRecoveryState(value: unknown): ModalRecoveryState {
  return recoveryStateSchema.parse(value) as ModalRecoveryState;
}

export function createModalRecoveryState(input: {
  logicalRunId: string;
  launchGeneration: number;
  app: string;
  slugs: string[];
}): ModalRecoveryState {
  return parseModalRecoveryState({
    schema_version: MODAL_RECOVERY_STATE_SCHEMA_VERSION,
    logical_run_id: input.logicalRunId,
    launch_generation: input.launchGeneration,
    app: input.app,
    rows: input.slugs.map((slug) => ({
      slug,
      status: "idle",
      no_progress_generations: 0,
      successful_nodes: 0,
      workers: []
    }))
  });
}

export async function readModalRecoveryState(statePath: string): Promise<ModalRecoveryState | undefined> {
  try {
    return parseModalRecoveryState(JSON.parse(await readFile(path.resolve(statePath), "utf8")) as unknown);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function writeModalRecoveryState(statePath: string, state: ModalRecoveryState): Promise<void> {
  const target = path.resolve(statePath);
  const checked = parseModalRecoveryState(state);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(checked, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    const directory = await open(path.dirname(target), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

export function reconcileModalRecoveryRow(input: {
  row: ModalRecoveryRowState;
  now: string;
  requestedImage: string;
  owner?: ModalRecoveryOwner;
  canonical?: ModalRecoveryCanonicalProgress;
  complete?: boolean;
  forceRollout?: boolean;
  policy?: Partial<ModalRecoveryPolicy>;
}): ModalRecoveryDecision {
  const nowMs = requiredTimestamp(input.now, "recovery observation");
  const policy = recoveryPolicy(input.policy);
  let row = cloneRow(input.row);
  if (input.complete === true) {
    row = { ...row, status: "completed" };
    delete row.next_eligible_at;
    delete row.pending_image;
    delete row.terminal;
    return decision("complete", "complete", row);
  }
  if (row.status === "completed") return decision("complete", "complete", row);

  const progress = observeCanonicalProgress(row, input.canonical, input.owner, input.now, policy.staleAfterMs);
  row = progress.row;
  if (row.status === "terminal") return decision("terminal", "no-progress-budget-exhausted", row);
  const owner = input.owner;
  const imageChanged = owner !== undefined && owner.image !== input.requestedImage;
  if (owner?.live === true && imageChanged && input.forceRollout === true) {
    row.status = "healthy";
    updatePendingImage(row, imageChanged, input.requestedImage);
    delete row.next_eligible_at;
    return decision("replace", "forced-rollout", row, "rollout");
  }
  if (owner?.live === true && progress.recent) {
    if (imageChanged) {
      row.status = "rollout-deferred";
      row.pending_image = input.requestedImage;
      return decision("defer-rollout", "rollout-deferred", row);
    }
    row.status = "healthy";
    delete row.pending_image;
    delete row.next_eligible_at;
    return decision("keep", "canonical-progress", row);
  }
  if (owner?.live === true && input.canonical === undefined) {
    row.status = "healthy";
    updatePendingImage(row, imageChanged, input.requestedImage);
    return decision("keep", "canonical-unavailable", row);
  }
  if (owner?.live === true && nowMs - requiredTimestamp(owner.launched_at, "owner launch") < policy.resumeGraceMs) {
    row.status = "grace";
    updatePendingImage(row, imageChanged, input.requestedImage);
    const retryAfterMs = policy.resumeGraceMs - (nowMs - Date.parse(owner.launched_at));
    return decision("wait", "resume-grace", row, undefined, retryAfterMs);
  }

  if (owner?.kind === "recovery") {
    const previousNoProgress = row.no_progress_generations;
    row = accountRecoveryGeneration(row, owner.generation);
    if (!owner.live) row = stopNonLiveRecoveryGeneration(row, owner.generation, input.now);
    if (row.no_progress_generations > previousNoProgress) {
      row.next_eligible_at = nextEligibleAt(row, input.now, policy);
    }
    if (row.no_progress_generations >= policy.maxNoProgressGenerations) {
      row.status = "terminal";
      row.terminal = { category: "no-progress-budget-exhausted", entered_at: input.now };
      delete row.next_eligible_at;
      return decision("terminal", "no-progress-budget-exhausted", row);
    }
  }

  if (owner?.live === true) {
    row.status = "backoff";
    updatePendingImage(row, imageChanged, input.requestedImage);
    row.next_eligible_at = nextEligibleAt(row, input.now, policy);
    return decision("replace", "owner-stalled", row, "recovery");
  }

  const retryAtMs = optionalTimestamp(row.next_eligible_at);
  if (retryAtMs !== undefined && retryAtMs > nowMs) {
    row.status = "backoff";
    return decision("wait", "backoff", row, undefined, retryAtMs - nowMs);
  }
  row.status = "idle";
  updatePendingImage(row, imageChanged, input.requestedImage);
  delete row.next_eligible_at;
  return decision("launch", "owner-missing", row, imageChanged ? "rollout" : "recovery");
}

export function reserveModalRecoveryWorker(
  row: ModalRecoveryRowState,
  input: {
    attempt: number;
    attemptId: string;
    name: string;
    image: string;
    now: string;
  }
): ModalRecoveryRowState {
  requiredTimestamp(input.now, "recovery reservation");
  const generation = Math.max(0, ...row.workers.map((worker) => worker.generation)) + 1;
  const next = cloneRow(row);
  next.status = "grace";
  delete next.next_eligible_at;
  delete next.pending_image;
  next.workers.push({
    generation,
    attempt: input.attempt,
    attempt_id: input.attemptId,
    name: input.name,
    image: input.image,
    phase: "reserved",
    reserved_at: input.now,
    baseline_successful_nodes: row.successful_nodes,
    made_progress: false,
    no_progress_accounted: false
  });
  return parseRecoveryRow(next);
}

export function markModalRecoveryWorkerLaunched(
  row: ModalRecoveryRowState,
  generation: number,
  sandboxId: string,
  now: string
): ModalRecoveryRowState {
  requiredTimestamp(now, "recovery launch");
  const next = cloneRow(row);
  const worker = requiredWorker(next, generation);
  if (worker.phase !== "reserved") throw new Error(`cannot launch a ${worker.phase} recovery worker`);
  worker.phase = "launched";
  worker.sandbox_id = sandboxId;
  worker.launched_at = now;
  return parseRecoveryRow(next);
}

export function attachModalRecoverySandbox(
  row: ModalRecoveryRowState,
  generation: number,
  sandboxId: string
): ModalRecoveryRowState {
  const next = cloneRow(row);
  const worker = requiredWorker(next, generation);
  if (worker.phase !== "reserved") throw new Error(`cannot attach a sandbox to a ${worker.phase} recovery worker`);
  worker.sandbox_id = sandboxId;
  return parseRecoveryRow(next);
}

export function markModalRecoveryWorkerStopped(
  row: ModalRecoveryRowState,
  generation: number,
  reason: ModalRecoveryWorkerStopReason,
  now: string
): ModalRecoveryRowState {
  requiredTimestamp(now, "recovery stop");
  const next = cloneRow(row);
  const worker = requiredWorker(next, generation);
  const neverLaunched = worker.phase === "reserved";
  worker.phase = "stopped";
  worker.stopped_at = now;
  worker.stop_reason = reason;
  if (neverLaunched || reason === "rollout" || reason === "completed") worker.no_progress_accounted = true;
  return parseRecoveryRow(next);
}

export function modalRecoveryBackoffMs(
  noProgressGenerations: number,
  policy: Partial<ModalRecoveryPolicy> = {}
): number {
  const checked = recoveryPolicy(policy);
  const exponent = Math.max(0, noProgressGenerations - 1);
  return Math.min(checked.backoffMaxMs, checked.backoffBaseMs * 2 ** exponent);
}

function observeCanonicalProgress(
  row: ModalRecoveryRowState,
  canonical: ModalRecoveryCanonicalProgress | undefined,
  owner: ModalRecoveryOwner | undefined,
  now: string,
  staleAfterMs: number
): { row: ModalRecoveryRowState; recent: boolean } {
  if (canonical === undefined) return { row, recent: false };
  const next = cloneRow(row);
  const successAtMs = optionalTimestamp(canonical.last_success_at);
  const transitionAtMs = requiredTimestamp(canonical.last_transition_at, "canonical transition");
  const successfulTransition = canonical.successful_nodes > next.successful_nodes;
  if (successfulTransition) {
    next.successful_nodes = canonical.successful_nodes;
    next.no_progress_generations = 0;
    next.last_progress_at = canonical.last_success_at ?? now;
    delete next.next_eligible_at;
    delete next.terminal;
    if (next.status === "terminal") next.status = "idle";
    const active = activeRecoveryWorker(next, owner);
    if (active !== undefined) active.made_progress = true;
  }
  const nowMs = Date.parse(now);
  const policyRecentAtMs = Math.max(transitionAtMs, successAtMs ?? Number.NEGATIVE_INFINITY);
  return { row: next, recent: successfulTransition || nowMs - policyRecentAtMs <= staleAfterMs };
}

function accountRecoveryGeneration(row: ModalRecoveryRowState, generation: number | undefined): ModalRecoveryRowState {
  if (generation === undefined) throw new Error("recovery owner is missing its generation");
  const next = cloneRow(row);
  const worker = requiredWorker(next, generation);
  if (worker.no_progress_accounted) return next;
  worker.no_progress_accounted = true;
  const madeProgress = worker.made_progress || next.successful_nodes > worker.baseline_successful_nodes;
  next.no_progress_generations = madeProgress ? 0 : next.no_progress_generations + 1;
  return next;
}

function updatePendingImage(row: ModalRecoveryRowState, imageChanged: boolean, requestedImage: string): void {
  if (imageChanged) row.pending_image = requestedImage;
  else delete row.pending_image;
}

function stopNonLiveRecoveryGeneration(
  row: ModalRecoveryRowState,
  generation: number | undefined,
  now: string
): ModalRecoveryRowState {
  if (generation === undefined) throw new Error("recovery owner is missing its generation");
  const worker = requiredWorker(row, generation);
  if (worker.phase === "stopped") return row;
  return markModalRecoveryWorkerStopped(row, generation, "exited", now);
}

function nextEligibleAt(row: ModalRecoveryRowState, now: string, policy: ModalRecoveryPolicy): string {
  if (row.no_progress_generations === 0) return now;
  return new Date(Date.parse(now) + modalRecoveryBackoffMs(row.no_progress_generations, policy)).toISOString();
}

function activeRecoveryWorker(
  row: ModalRecoveryRowState,
  owner: ModalRecoveryOwner | undefined
): ModalRecoveryWorker | undefined {
  return owner?.kind === "recovery" ? row.workers.find((worker) => worker.generation === owner.generation) : undefined;
}

function requiredWorker(row: ModalRecoveryRowState, generation: number): ModalRecoveryWorker {
  const worker = row.workers.find((candidate) => candidate.generation === generation);
  if (worker === undefined) throw new Error(`recovery generation ${generation} is not reserved`);
  return worker;
}

function parseRecoveryRow(value: ModalRecoveryRowState): ModalRecoveryRowState {
  return recoveryRowSchema.parse(value) as ModalRecoveryRowState;
}

function cloneRow(row: ModalRecoveryRowState): ModalRecoveryRowState {
  return {
    ...row,
    ...(row.terminal === undefined ? {} : { terminal: { ...row.terminal } }),
    workers: row.workers.map((worker) => ({ ...worker }))
  };
}

function decision(
  action: ModalRecoveryAction,
  reason: ModalRecoveryDecision["reason"],
  row: ModalRecoveryRowState,
  replacementKind?: ModalRecoveryDecision["replacement_kind"],
  retryAfterMs = 0
): ModalRecoveryDecision {
  return {
    action,
    reason,
    row: parseRecoveryRow(row),
    ...(replacementKind === undefined ? {} : { replacement_kind: replacementKind }),
    retry_after_ms: Math.max(0, Math.trunc(retryAfterMs))
  };
}

function recoveryPolicy(overrides: Partial<ModalRecoveryPolicy> | undefined): ModalRecoveryPolicy {
  const policy = { ...DEFAULT_MODAL_RECOVERY_POLICY, ...overrides };
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
  }
  if (policy.backoffBaseMs > policy.backoffMaxMs) {
    throw new Error("recovery backoff base cannot exceed its maximum");
  }
  return policy;
}

function requiredTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} timestamp is invalid`);
  return parsed;
}

function optionalTimestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
