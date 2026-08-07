import { isDeepStrictEqual } from "node:util";

import { containsSecretValueRepresentation, redactSecretsInText } from "@ultrafuzz/security";
import { z } from "zod/v4";

export const MODAL_RECOVERY_LIFECYCLE_SCHEMA_VERSION = "ultrafuzz.modal.recovery-lifecycle.v1" as const;
export const MODAL_RECOVERY_LIFECYCLE_FILE = "recovery-lifecycle.json" as const;

export const MODAL_RECOVERY_START_REASONS = [
  "initial",
  "pre-model-retry",
  "post-model-resume",
  "image-rollout",
  "stale-probe-rotation",
  "operator-restart",
  "unknown"
] as const;

export const MODAL_RECOVERY_TRIGGER_ACTIONS = [
  "initial-launch",
  "retry",
  "resume",
  "replace-image",
  "rotate-stale-probe",
  "restart",
  "unknown"
] as const;

export const MODAL_RECOVERY_TERMINAL_REASONS = [
  "active",
  "succeeded",
  "genuine-worker-failure",
  "operational-failure",
  "image-rollout",
  "stale-probe-rotation",
  "operator-request",
  "timeout",
  "resource-termination",
  "recovery-budget-exhausted",
  "unknown"
] as const;

export const MODAL_RECOVERY_TERMINAL_CLASSES = [
  "active",
  "succeeded",
  "genuine-worker-failure",
  "operational-failure",
  "controller-rotation",
  "timeout",
  "resource-termination",
  "recovery-budget-exhausted",
  "unknown"
] as const;

export type ModalRecoveryStartReason = (typeof MODAL_RECOVERY_START_REASONS)[number];
export type ModalRecoveryTriggerAction = (typeof MODAL_RECOVERY_TRIGGER_ACTIONS)[number];
export type ModalRecoveryTerminalReason = (typeof MODAL_RECOVERY_TERMINAL_REASONS)[number];
export type ModalRecoveryTerminalClass = (typeof MODAL_RECOVERY_TERMINAL_CLASSES)[number];
export type ModalRecoveryObservation<T> = T | "unknown";

const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
const timestamp = z.string().datetime({ offset: true });
const observationBoolean = z.union([z.boolean(), z.literal("unknown")]);
const observationTimestamp = z.union([timestamp, z.literal("unknown")]);
const observationExitCode = z.union([z.number().int(), z.null(), z.literal("unknown")]);
const observationDigest = z.union([fingerprint, z.literal("unknown")]);
const nodeCounts = z
  .record(safeId, z.number().int().nonnegative())
  .refine((value) => Object.keys(value).length <= 64, { message: "node counts must contain at most 64 statuses" });
const observationNodeCounts = z.union([nodeCounts, z.literal("unknown")]);

const START_REASON_ACTIONS = {
  initial: "initial-launch",
  "pre-model-retry": "retry",
  "post-model-resume": "resume",
  "image-rollout": "replace-image",
  "stale-probe-rotation": "rotate-stale-probe",
  "operator-restart": "restart",
  unknown: "unknown"
} as const satisfies Record<ModalRecoveryStartReason, ModalRecoveryTriggerAction>;

const TERMINAL_REASON_CLASSES = {
  active: "active",
  succeeded: "succeeded",
  "genuine-worker-failure": "genuine-worker-failure",
  "operational-failure": "operational-failure",
  "image-rollout": "controller-rotation",
  "stale-probe-rotation": "controller-rotation",
  "operator-request": "controller-rotation",
  timeout: "timeout",
  "resource-termination": "resource-termination",
  "recovery-budget-exhausted": "recovery-budget-exhausted",
  unknown: "unknown"
} as const satisfies Record<ModalRecoveryTerminalReason, ModalRecoveryTerminalClass>;

export const modalRecoveryLifecycleRecordSchema = z
  .strictObject({
    schema_version: z.literal(MODAL_RECOVERY_LIFECYCLE_SCHEMA_VERSION),
    logical_run_id: safeId,
    model_slug: safeId,
    generation: z.number().int().positive(),
    attempt: z.number().int().positive(),
    attempt_id: safeId,
    parent_generation: z.number().int().positive().optional(),
    parent_attempt_id: safeId.optional(),
    trigger_action: z.enum(MODAL_RECOVERY_TRIGGER_ACTIONS),
    start_reason: z.enum(MODAL_RECOVERY_START_REASONS),
    terminal_reason: z.enum(MODAL_RECOVERY_TERMINAL_REASONS),
    terminal_class: z.enum(MODAL_RECOVERY_TERMINAL_CLASSES),
    launched_at: timestamp,
    finished_at: timestamp.optional(),
    worker_exit_code: observationExitCode,
    fingerprints: z.strictObject({
      config: fingerprint,
      source: fingerprint,
      image: fingerprint,
      model: fingerprint
    }),
    model_work_started: observationBoolean,
    last_durable_transition_at: observationTimestamp,
    node_counts_before: observationNodeCounts,
    node_counts_after: observationNodeCounts,
    progress_made: observationBoolean,
    controller_requested: observationBoolean,
    node_attempt_ledger_digest: observationDigest,
    evaluation_lineage_digest: observationDigest
  })
  .superRefine((record, context) => {
    if (record.trigger_action !== START_REASON_ACTIONS[record.start_reason]) {
      context.addIssue({
        code: "custom",
        path: ["trigger_action"],
        message: "must match start_reason"
      });
    }
    if (record.terminal_class !== TERMINAL_REASON_CLASSES[record.terminal_reason]) {
      context.addIssue({
        code: "custom",
        path: ["terminal_class"],
        message: "must match terminal_reason"
      });
    }
    if (record.terminal_reason === "active" && record.finished_at !== undefined) {
      context.addIssue({ code: "custom", path: ["finished_at"], message: "active generations cannot be finished" });
    }
    if (!["active", "unknown"].includes(record.terminal_reason) && record.finished_at === undefined) {
      context.addIssue({ code: "custom", path: ["finished_at"], message: "terminal generations require finished_at" });
    }
    if (record.finished_at !== undefined && Date.parse(record.finished_at) < Date.parse(record.launched_at)) {
      context.addIssue({ code: "custom", path: ["finished_at"], message: "cannot precede launched_at" });
    }
    if (record.parent_attempt_id === record.attempt_id) {
      context.addIssue({
        code: "custom",
        path: ["parent_attempt_id"],
        message: "a worker generation cannot parent itself"
      });
    }
    if ((record.parent_generation === undefined) !== (record.parent_attempt_id === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["parent_attempt_id"],
        message: "parent generation and attempt ID must be recorded together"
      });
    }
    if (record.parent_generation !== undefined && record.parent_generation > record.generation) {
      context.addIssue({
        code: "custom",
        path: ["parent_generation"],
        message: "cannot exceed generation"
      });
    }
    if (record.controller_requested === true && record.terminal_class === "genuine-worker-failure") {
      context.addIssue({
        code: "custom",
        path: ["terminal_class"],
        message: "a controller-requested termination cannot be a genuine worker failure"
      });
    }
    if (record.terminal_class === "controller-rotation" && record.controller_requested !== true) {
      context.addIssue({
        code: "custom",
        path: ["controller_requested"],
        message: "controller rotations must be explicitly controller-requested"
      });
    }
  });

export type ModalRecoveryLifecycleRecord = z.infer<typeof modalRecoveryLifecycleRecordSchema>;

export interface StartModalRecoveryLifecycleInput {
  logicalRunId: string;
  modelSlug: string;
  generation: number;
  attempt: number;
  attemptId: string;
  startReason: ModalRecoveryStartReason;
  launchedAt: string;
  fingerprints: {
    config: string;
    source: string;
    image: string;
    model: string;
  };
  parentGeneration?: number;
  parentAttemptId?: string;
  nodeCountsBefore?: Record<string, number>;
  nodeAttemptLedgerDigest?: string;
  evaluationLineageDigest?: string;
}

export interface FinishModalRecoveryLifecycleInput {
  attemptId: string;
  terminalReason: Exclude<ModalRecoveryTerminalReason, "active">;
  finishedAt?: string;
  workerExitCode?: number | null;
  modelWorkStarted?: ModalRecoveryObservation<boolean>;
  lastDurableTransitionAt?: string;
  nodeCountsAfter?: Record<string, number>;
  progressMade?: ModalRecoveryObservation<boolean>;
  controllerRequested?: ModalRecoveryObservation<boolean>;
  nodeAttemptLedgerDigest?: string;
  evaluationLineageDigest?: string;
}

export interface ModalRecoveryLifecycleTransitionResult {
  record: ModalRecoveryLifecycleRecord;
  changed: boolean;
}

export function modalRecoveryTriggerAction(reason: ModalRecoveryStartReason): ModalRecoveryTriggerAction {
  return START_REASON_ACTIONS[reason];
}

export function modalRecoveryTerminalClass(reason: ModalRecoveryTerminalReason): ModalRecoveryTerminalClass {
  return TERMINAL_REASON_CLASSES[reason];
}

export function startModalRecoveryLifecycle(
  records: ModalRecoveryLifecycleRecord[],
  input: StartModalRecoveryLifecycleInput
): ModalRecoveryLifecycleTransitionResult {
  const candidate = parseModalRecoveryLifecycleRecord({
    schema_version: MODAL_RECOVERY_LIFECYCLE_SCHEMA_VERSION,
    logical_run_id: input.logicalRunId,
    model_slug: input.modelSlug,
    generation: input.generation,
    attempt: input.attempt,
    attempt_id: input.attemptId,
    ...(input.parentGeneration === undefined ? {} : { parent_generation: input.parentGeneration }),
    ...(input.parentAttemptId === undefined ? {} : { parent_attempt_id: input.parentAttemptId }),
    trigger_action: modalRecoveryTriggerAction(input.startReason),
    start_reason: input.startReason,
    terminal_reason: "active",
    terminal_class: "active",
    launched_at: input.launchedAt,
    worker_exit_code: "unknown",
    fingerprints: input.fingerprints,
    model_work_started: "unknown",
    last_durable_transition_at: "unknown",
    node_counts_before: input.nodeCountsBefore ?? "unknown",
    node_counts_after: "unknown",
    progress_made: "unknown",
    controller_requested: "unknown",
    node_attempt_ledger_digest: input.nodeAttemptLedgerDigest ?? "unknown",
    evaluation_lineage_digest: input.evaluationLineageDigest ?? "unknown"
  });
  const existing = records.find((record) => record.attempt_id === candidate.attempt_id);
  if (existing !== undefined) {
    if (!sameModalRecoveryStart(existing, candidate)) {
      throw new Error(`Modal recovery generation ${candidate.attempt_id} was already recorded with different data`);
    }
    return { record: existing, changed: false };
  }
  if (
    records.some(
      (record) =>
        record.logical_run_id === candidate.logical_run_id &&
        record.model_slug === candidate.model_slug &&
        record.generation === candidate.generation &&
        record.attempt === candidate.attempt
    )
  ) {
    throw new Error("Modal recovery lifecycle repeats a generation attempt");
  }
  records.push(candidate);
  return { record: candidate, changed: true };
}

export function finishModalRecoveryLifecycle(
  records: ModalRecoveryLifecycleRecord[],
  input: FinishModalRecoveryLifecycleInput
): ModalRecoveryLifecycleTransitionResult {
  const record = records.find((candidate) => candidate.attempt_id === input.attemptId);
  if (record === undefined) throw new Error(`Modal recovery generation ${input.attemptId} was not started`);
  if (
    input.nodeAttemptLedgerDigest !== undefined &&
    record.node_attempt_ledger_digest !== "unknown" &&
    record.node_attempt_ledger_digest !== input.nodeAttemptLedgerDigest
  ) {
    throw new Error(`Modal recovery generation ${input.attemptId} has conflicting attempt-ledger linkage`);
  }
  if (
    input.evaluationLineageDigest !== undefined &&
    record.evaluation_lineage_digest !== "unknown" &&
    record.evaluation_lineage_digest !== input.evaluationLineageDigest
  ) {
    throw new Error(`Modal recovery generation ${input.attemptId} has conflicting evaluation-lineage linkage`);
  }
  const candidate = parseModalRecoveryLifecycleRecord({
    ...record,
    terminal_reason: input.terminalReason,
    terminal_class: modalRecoveryTerminalClass(input.terminalReason),
    ...(input.finishedAt === undefined ? {} : { finished_at: input.finishedAt }),
    worker_exit_code: input.workerExitCode === undefined ? "unknown" : input.workerExitCode,
    model_work_started: input.modelWorkStarted ?? "unknown",
    last_durable_transition_at: input.lastDurableTransitionAt ?? "unknown",
    node_counts_after: input.nodeCountsAfter ?? "unknown",
    progress_made:
      input.progressMade ?? observedModalRecoveryProgress(record, input.nodeCountsAfter, input.lastDurableTransitionAt),
    controller_requested: input.controllerRequested ?? false,
    node_attempt_ledger_digest: input.nodeAttemptLedgerDigest ?? record.node_attempt_ledger_digest,
    evaluation_lineage_digest: input.evaluationLineageDigest ?? record.evaluation_lineage_digest
  });
  if (record.terminal_reason !== "active") {
    if (!isDeepStrictEqual(record, candidate)) {
      throw new Error(`Modal recovery generation ${input.attemptId} already has a different terminal transition`);
    }
    return { record, changed: false };
  }
  Object.assign(record, candidate);
  return { record, changed: true };
}

export function parseModalRecoveryLifecycleRecord(value: unknown): ModalRecoveryLifecycleRecord {
  return modalRecoveryLifecycleRecordSchema.parse(value);
}

export function parseModalRecoveryLifecycleRecords(value: unknown): ModalRecoveryLifecycleRecord[] {
  const records = z.array(modalRecoveryLifecycleRecordSchema).max(100_000).parse(value);
  const attemptsById = new Map<string, ModalRecoveryLifecycleRecord>();
  const generationAttempts = new Set<string>();
  for (const record of records) {
    if (attemptsById.has(record.attempt_id)) {
      throw new Error(`duplicate Modal recovery attempt ID: ${record.attempt_id}`);
    }
    const key = `${record.logical_run_id}\0${record.model_slug}\0${record.generation}\0${record.attempt}`;
    if (generationAttempts.has(key)) throw new Error("duplicate Modal recovery generation attempt");
    generationAttempts.add(key);
    if (record.parent_attempt_id !== undefined) {
      const parent = attemptsById.get(record.parent_attempt_id);
      if (parent === undefined) {
        throw new Error(`Modal recovery parent must precede child: ${record.parent_attempt_id}`);
      }
      if (
        parent.logical_run_id !== record.logical_run_id ||
        parent.model_slug !== record.model_slug ||
        parent.generation !== record.parent_generation ||
        (parent.generation === record.generation && parent.attempt >= record.attempt)
      ) {
        throw new Error(`Modal recovery generation ${record.attempt_id} has incompatible parent linkage`);
      }
    }
    attemptsById.set(record.attempt_id, record);
  }
  return records;
}

type CountByStartReason = Record<ModalRecoveryStartReason, number>;
type CountByTerminalReason = Record<ModalRecoveryTerminalReason, number>;
type CountByTerminalClass = Record<ModalRecoveryTerminalClass, number>;

export interface ModalRecoveryLifecycleSummary {
  /**
   * Recorded Modal launch generation-attempts, not evolutionary generations.
   *
   * A worker result reports both counters and they are unrelated: `launch_generation` is the Modal
   * generation this summary counts, while `generation` is how far the evaluation's own loop got. A
   * run showing `generation: 3`, `launch_generation: 1` and `total_generations: 1` is consistent —
   * one Modal launch that reached the third evolutionary generation (#322).
   */
  total_generations: number;
  terminal_generations: number;
  active_generations: number;
  progress_generations: number;
  no_progress_generations: number;
  unknown_progress_generations: number;
  model_work_generations: number;
  no_model_work_generations: number;
  unknown_model_work_generations: number;
  genuine_failures: number;
  rotations: number;
  resumptions: number;
  start_reasons: CountByStartReason;
  terminal_reasons: CountByTerminalReason;
  terminal_classes: CountByTerminalClass;
}

export function summarizeModalRecoveryLifecycle(
  records: readonly ModalRecoveryLifecycleRecord[]
): ModalRecoveryLifecycleSummary {
  const checked = parseModalRecoveryLifecycleRecords(records);
  const startReasons = counts(MODAL_RECOVERY_START_REASONS);
  const terminalReasons = counts(MODAL_RECOVERY_TERMINAL_REASONS);
  const terminalClasses = counts(MODAL_RECOVERY_TERMINAL_CLASSES);
  let progressGenerations = 0;
  let noProgressGenerations = 0;
  let unknownProgressGenerations = 0;
  let modelWorkGenerations = 0;
  let noModelWorkGenerations = 0;
  let unknownModelWorkGenerations = 0;
  for (const record of checked) {
    startReasons[record.start_reason] += 1;
    terminalReasons[record.terminal_reason] += 1;
    terminalClasses[record.terminal_class] += 1;
    if (record.progress_made === true) progressGenerations += 1;
    else if (record.progress_made === false) noProgressGenerations += 1;
    else unknownProgressGenerations += 1;
    if (record.model_work_started === true) modelWorkGenerations += 1;
    else if (record.model_work_started === false) noModelWorkGenerations += 1;
    else unknownModelWorkGenerations += 1;
  }
  return {
    total_generations: checked.length,
    terminal_generations: checked.length - terminalClasses.active,
    active_generations: terminalClasses.active,
    progress_generations: progressGenerations,
    no_progress_generations: noProgressGenerations,
    unknown_progress_generations: unknownProgressGenerations,
    model_work_generations: modelWorkGenerations,
    no_model_work_generations: noModelWorkGenerations,
    unknown_model_work_generations: unknownModelWorkGenerations,
    genuine_failures: terminalClasses["genuine-worker-failure"],
    rotations: terminalClasses["controller-rotation"],
    resumptions: startReasons["post-model-resume"],
    start_reasons: startReasons,
    terminal_reasons: terminalReasons,
    terminal_classes: terminalClasses
  };
}

export interface ModalRecoveryLifecycleDocument {
  schema_version: typeof MODAL_RECOVERY_LIFECYCLE_SCHEMA_VERSION;
  summary: ModalRecoveryLifecycleSummary;
  records: ModalRecoveryLifecycleRecord[];
}

export function createModalRecoveryLifecycleDocument(
  records: readonly ModalRecoveryLifecycleRecord[]
): ModalRecoveryLifecycleDocument {
  const checked = parseModalRecoveryLifecycleRecords(records);
  return {
    schema_version: MODAL_RECOVERY_LIFECYCLE_SCHEMA_VERSION,
    summary: summarizeModalRecoveryLifecycle(checked),
    records: checked
  };
}

export function parseModalRecoveryLifecycleDocument(value: unknown): ModalRecoveryLifecycleDocument {
  const parsed = z
    .strictObject({
      schema_version: z.literal(MODAL_RECOVERY_LIFECYCLE_SCHEMA_VERSION),
      summary: z.record(z.string(), z.unknown()),
      records: z.array(modalRecoveryLifecycleRecordSchema).max(100_000)
    })
    .parse(value);
  const document = createModalRecoveryLifecycleDocument(parsed.records);
  if (!isDeepStrictEqual(parsed.summary, document.summary)) {
    throw new Error("Modal recovery lifecycle summary does not reconcile with its records");
  }
  return document;
}

export function assertModalRecoveryLifecycleContainsNoSecrets(
  value: ModalRecoveryLifecycleDocument | ModalRecoveryLifecycleRecord,
  forbiddenSecretValues: readonly string[] = []
): void {
  const text = JSON.stringify(value);
  if (containsSecretValueRepresentation(text, forbiddenSecretValues)) {
    throw new Error("Modal recovery lifecycle contains an injected secret value");
  }
  if (redactSecretsInText(text) !== text) {
    throw new Error("Modal recovery lifecycle contains secret-like content");
  }
}

function counts<const T extends readonly string[]>(values: T): Record<T[number], number> {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<T[number], number>;
}

function sameModalRecoveryStart(
  existing: ModalRecoveryLifecycleRecord,
  candidate: ModalRecoveryLifecycleRecord
): boolean {
  return (
    isDeepStrictEqual(
      {
        schema_version: existing.schema_version,
        logical_run_id: existing.logical_run_id,
        model_slug: existing.model_slug,
        generation: existing.generation,
        attempt: existing.attempt,
        attempt_id: existing.attempt_id,
        parent_generation: existing.parent_generation,
        parent_attempt_id: existing.parent_attempt_id,
        trigger_action: existing.trigger_action,
        start_reason: existing.start_reason,
        launched_at: existing.launched_at,
        fingerprints: existing.fingerprints,
        node_counts_before: existing.node_counts_before
      },
      {
        schema_version: candidate.schema_version,
        logical_run_id: candidate.logical_run_id,
        model_slug: candidate.model_slug,
        generation: candidate.generation,
        attempt: candidate.attempt,
        attempt_id: candidate.attempt_id,
        parent_generation: candidate.parent_generation,
        parent_attempt_id: candidate.parent_attempt_id,
        trigger_action: candidate.trigger_action,
        start_reason: candidate.start_reason,
        launched_at: candidate.launched_at,
        fingerprints: candidate.fingerprints,
        node_counts_before: candidate.node_counts_before
      }
    ) &&
    sameModalRecoveryStartDigest(existing.node_attempt_ledger_digest, candidate.node_attempt_ledger_digest) &&
    sameModalRecoveryStartDigest(existing.evaluation_lineage_digest, candidate.evaluation_lineage_digest)
  );
}

function sameModalRecoveryStartDigest(existing: string, candidate: string): boolean {
  return candidate === "unknown" || existing === candidate;
}

function observedModalRecoveryProgress(
  record: ModalRecoveryLifecycleRecord,
  nodeCountsAfter: Record<string, number> | undefined,
  lastDurableTransitionAt: string | undefined
): ModalRecoveryObservation<boolean> {
  if (lastDurableTransitionAt !== undefined && Date.parse(lastDurableTransitionAt) > Date.parse(record.launched_at)) {
    return true;
  }
  const nodeCountsBefore = record.node_counts_before;
  if (nodeCountsBefore === "unknown" || nodeCountsAfter === undefined) return "unknown";
  const terminalStatuses = ["succeeded", "failed", "timed-out", "canceled", "skipped", "reused-from-prior-run"];
  const before = terminalStatuses.reduce((total, status) => total + (nodeCountsBefore[status] ?? 0), 0);
  const after = terminalStatuses.reduce((total, status) => total + (nodeCountsAfter[status] ?? 0), 0);
  return after > before;
}
