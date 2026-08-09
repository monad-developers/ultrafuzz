import { isDeepStrictEqual } from "node:util";

import { redactSecretsInText } from "@ultrafuzz/security";

import {
  MODAL_COMMON_SCHEMA_ID,
  MODAL_RECOVERY_LIFECYCLE_SCHEMA_ID,
  type StrictModalRecoveryLifecycleDocument,
  type StrictModalRecoveryLifecycleRecord,
  type StrictModalRecoveryLifecycleSummary
} from "./modal-contracts.js";
import { parseModalDocumentValue } from "./modal-documents.js";
import { validateModalJsonSchema } from "./modal-schema-registry.js";
import {
  assertModalRecoveryLifecycleRecordSemantics,
  assertModalRecoveryLifecycleRecordsSemantics
} from "./modal-semantic-gates.js";

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

const MODAL_RECOVERY_LIFECYCLE_RECORD_SCHEMA_ID = `${MODAL_COMMON_SCHEMA_ID}#/$defs/recoveryLifecycleRecord` as const;

export type ModalRecoveryLifecycleRecord = StrictModalRecoveryLifecycleRecord;

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
  const validation = validateModalJsonSchema(MODAL_RECOVERY_LIFECYCLE_RECORD_SCHEMA_ID, value);
  if (!validation.ok) {
    throw new Error(
      `Modal recovery lifecycle record failed ${MODAL_RECOVERY_LIFECYCLE_RECORD_SCHEMA_ID}: ${validation.issues
        .map((issue) => `${issue.instancePath || "/"} ${issue.message}`)
        .join("; ")}`
    );
  }
  const record = value as ModalRecoveryLifecycleRecord;
  assertModalRecoveryLifecycleRecordSemantics(record);
  return record;
}

export function parseModalRecoveryLifecycleRecords(value: unknown): ModalRecoveryLifecycleRecord[] {
  if (!Array.isArray(value) || value.length > 100_000) {
    throw new Error("Modal recovery lifecycle records must be an array of at most 100000 records");
  }
  const records = value as ModalRecoveryLifecycleRecord[];
  for (const record of records) parseModalRecoveryLifecycleRecord(record);
  assertModalRecoveryLifecycleRecordsSemantics(records);
  return records;
}

/**
 * Recorded Modal launch generation-attempts, not evolutionary generations.
 *
 * A worker result reports both counters and they are unrelated: `launch_generation` is the Modal
 * generation this summary counts, while `generation` is how far the evaluation's own loop got. A
 * run showing `generation: 3`, `launch_generation: 1` and `total_generations: 1` is consistent —
 * one Modal launch that reached the third evolutionary generation (#322).
 */
export type ModalRecoveryLifecycleSummary = StrictModalRecoveryLifecycleSummary;

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

export type ModalRecoveryLifecycleDocument = StrictModalRecoveryLifecycleDocument;

export function createModalRecoveryLifecycleDocument(
  records: readonly ModalRecoveryLifecycleRecord[]
): ModalRecoveryLifecycleDocument {
  const checked = parseModalRecoveryLifecycleRecords(records);
  return parseModalRecoveryLifecycleDocument({
    schema_version: MODAL_RECOVERY_LIFECYCLE_SCHEMA_VERSION,
    summary: summarizeModalRecoveryLifecycle(checked),
    records: checked
  });
}

export function parseModalRecoveryLifecycleDocument(value: unknown): ModalRecoveryLifecycleDocument {
  return parseModalDocumentValue(MODAL_RECOVERY_LIFECYCLE_SCHEMA_ID, value) as ModalRecoveryLifecycleDocument;
}

export function assertModalRecoveryLifecycleContainsNoSecrets(
  value: ModalRecoveryLifecycleDocument | ModalRecoveryLifecycleRecord,
  forbiddenSecretValues: readonly string[] = []
): void {
  const text = JSON.stringify(value);
  if ([...new Set(forbiddenSecretValues)].filter(Boolean).some((secret) => text.includes(secret))) {
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
