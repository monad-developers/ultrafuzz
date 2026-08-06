import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, type Stats } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { z } from "zod/v4";

import {
  MODAL_LAUNCH_STATE_SCHEMA_VERSION,
  MODAL_PRE_MODEL_RETRY_BASE_DELAY_MS,
  MODAL_PRE_MODEL_RETRY_LIMIT,
  MODAL_PRE_MODEL_RETRY_MAX_DELAY_MS,
  MODAL_WORKER_LINEAGE_SCHEMA_VERSION,
  MODAL_WORKER_STATUS_SCHEMA_VERSION,
  type ModalLaunchMode,
  type ModalModelSpec
} from "./defaults.js";
import {
  finishModalRecoveryLifecycle,
  modalRecoveryLifecycleRecordSchema,
  parseModalRecoveryLifecycleRecord,
  parseModalRecoveryLifecycleRecords,
  startModalRecoveryLifecycle,
  type FinishModalRecoveryLifecycleInput,
  type ModalRecoveryLifecycleRecord,
  type ModalRecoveryStartReason,
  type ModalRecoveryTerminalReason
} from "./recovery-lifecycle.js";
import { OPERATIONAL_DISPOSITION_CATEGORIES } from "./terminal-disposition.js";
import { WORKER_DIAGNOSTIC_CODES, WORKER_RESULT_SCHEMA_VERSION, type WorkerResultContract } from "./worker-result.js";

const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.string().min(1);
const LEGACY_MODAL_LAUNCH_STATE_SCHEMA_VERSION = "ultrafuzz.modal.launch-state.v1" as const;
const PREVIOUS_MODAL_LAUNCH_STATE_SCHEMA_VERSION = "ultrafuzz.modal.launch-state.v2" as const;
const modelSchema = z
  .object({
    slug: z.string().min(1),
    model: z.string().min(1),
    provider: z.enum(["openai", "anthropic", "deepseek", "kimi"]),
    agent: z.enum(["CodexAgent", "ClaudeAgent", "DeepSeekAgent", "KimiAgent"]),
    reasoning: z.string().min(1),
    auth_mode: z.enum(["api-key", "subscription"])
  })
  .strict();

export interface ModalLineageFingerprints {
  config: string;
  source: string;
  image: string;
}

export interface ModalAttemptProvenance {
  slug: string;
  generation: number;
  attempt: number;
  attempt_id: string;
  model_fingerprint: string;
  fingerprints: ModalLineageFingerprints;
  workspace_mode: ModalLaunchMode;
  post_model_recovery?: ModalPostModelRecovery;
  reserved_at: string;
  sandbox_id?: string;
  launched_at?: string;
  finished_at?: string;
  phase: ModalLaunchPhase;
}

export type ModalLaunchPhase = "reserved" | "sandbox-created" | "launched" | "failed";
export type ModalLaunchFailureCategory = "transient-operational-failure" | "permanent-operational-failure";
export type ModalPostModelRecovery = "relaunch" | "stop";

export interface ModalLaunchRecord extends ModalModelSpec {
  generation: number;
  attempt: number;
  attempt_id: string;
  model_fingerprint: string;
  volume_name: string;
  remote_root: string;
  workspace_mode: ModalLaunchMode;
  post_model_recovery?: ModalPostModelRecovery;
  phase: ModalLaunchPhase;
  reserved_at: string;
  sandbox_id?: string;
  launched_at?: string;
  finished_at?: string;
  failure_category?: ModalLaunchFailureCategory;
}

export interface ModalLaunchState {
  schema_version: typeof MODAL_LAUNCH_STATE_SCHEMA_VERSION;
  logical_run_id: string;
  generation: number;
  generation_mode: ModalLaunchMode;
  generation_start_reason: ModalRecoveryStartReason;
  app: string;
  image: string;
  image_id: string;
  timeout_ms: number;
  source_revision: string;
  fingerprints: ModalLineageFingerprints;
  launches: ModalLaunchRecord[];
  attempt_history: ModalAttemptProvenance[];
  recovery_lifecycle: ModalRecoveryLifecycleRecord[];
}

export interface ModalWorkerLineage {
  schema_version: typeof MODAL_WORKER_LINEAGE_SCHEMA_VERSION;
  logical_run_id: string;
  generation: number;
  attempt: number;
  attempt_id: string;
  workspace_mode: ModalLaunchMode;
  fingerprints: ModalLineageFingerprints;
  model_fingerprint: string;
}

export type ModalWorkerStatusCategory =
  | "preparing"
  | "model-work"
  | "post-processing"
  | "succeeded"
  | "genuine-task-outcome"
  | "resume-required"
  | "transient-operational-failure"
  | "permanent-operational-failure"
  | "incompatible-checkpoint";

export interface ModalWorkerStatus {
  schema_version: typeof MODAL_WORKER_STATUS_SCHEMA_VERSION | typeof WORKER_RESULT_SCHEMA_VERSION;
  updated_at?: string;
  stage: string;
  terminal: boolean;
  category: ModalWorkerStatusCategory;
  model_work_started: boolean;
  retryable: boolean;
  generation: number;
  attempt: number;
  eval_run_id?: string;
  run_status?: string;
  node_counts?: Record<string, number>;
  error_code?: string;
  result_generation?: number;
}

const lineageFingerprintsSchema = z
  .object({ config: fingerprintSchema, source: fingerprintSchema, image: fingerprintSchema })
  .strict();

const attemptProvenanceSchema = z
  .object({
    slug: z.string().min(1),
    generation: z.number().int().positive(),
    attempt: z.number().int().positive(),
    attempt_id: z.string().min(1),
    model_fingerprint: fingerprintSchema,
    fingerprints: lineageFingerprintsSchema,
    workspace_mode: z.enum(["resume", "fresh"]),
    post_model_recovery: z.enum(["relaunch", "stop"]).optional(),
    reserved_at: timestampSchema,
    sandbox_id: z.string().min(1).optional(),
    launched_at: timestampSchema.optional(),
    finished_at: timestampSchema.optional(),
    phase: z.enum(["reserved", "sandbox-created", "launched", "failed"])
  })
  .strict();

const launchRecordSchema = modelSchema
  .extend({
    generation: z.number().int().positive(),
    attempt: z.number().int().positive(),
    attempt_id: z.string().min(1),
    model_fingerprint: fingerprintSchema,
    volume_name: z.string().min(1),
    remote_root: z.string().min(1),
    workspace_mode: z.enum(["resume", "fresh"]),
    post_model_recovery: z.enum(["relaunch", "stop"]).optional(),
    phase: z.enum(["reserved", "sandbox-created", "launched", "failed"]),
    reserved_at: timestampSchema,
    sandbox_id: z.string().min(1).optional(),
    launched_at: timestampSchema.optional(),
    finished_at: timestampSchema.optional(),
    failure_category: z.enum(["transient-operational-failure", "permanent-operational-failure"]).optional()
  })
  .strict()
  .superRefine((record, context) => {
    if ((record.phase === "sandbox-created" || record.phase === "launched") && record.sandbox_id === undefined) {
      context.addIssue({ code: "custom", message: `${record.phase} launch is missing sandbox_id` });
    }
    if (record.phase === "launched" && record.launched_at === undefined) {
      context.addIssue({ code: "custom", message: "launched record is missing launched_at" });
    }
    if (record.phase === "failed" && record.failure_category === undefined) {
      context.addIssue({ code: "custom", message: "failed record is missing failure_category" });
    }
  });

const previousLaunchStateSchema = z
  .object({
    schema_version: z.literal(PREVIOUS_MODAL_LAUNCH_STATE_SCHEMA_VERSION),
    logical_run_id: z.string().min(1),
    generation: z.number().int().positive(),
    generation_mode: z.enum(["resume", "fresh"]),
    app: z.string().min(1),
    image: z.string().min(1),
    image_id: z.string().min(1),
    timeout_ms: z.number().int().positive(),
    source_revision: z.string().min(1),
    fingerprints: lineageFingerprintsSchema,
    launches: z.array(launchRecordSchema),
    attempt_history: z.array(attemptProvenanceSchema)
  })
  .strict()
  .superRefine((state, context) => {
    const slugs = new Set<string>();
    for (const launch of state.launches) {
      if (launch.generation !== state.generation) {
        context.addIssue({ code: "custom", message: `launch ${launch.slug} has the wrong generation` });
      }
      if (slugs.has(launch.slug)) {
        context.addIssue({ code: "custom", message: `duplicate launch slug: ${launch.slug}` });
      }
      slugs.add(launch.slug);
    }
    const attempts = new Set<string>();
    for (const attempt of [...state.attempt_history, ...state.launches]) {
      const key = `${attempt.generation}:${attempt.slug}:${attempt.attempt}`;
      if (attempts.has(key)) context.addIssue({ code: "custom", message: `duplicate launch attempt: ${key}` });
      attempts.add(key);
    }
  });

const launchStateSchema = z
  .object({
    schema_version: z.literal(MODAL_LAUNCH_STATE_SCHEMA_VERSION),
    logical_run_id: z.string().min(1),
    generation: z.number().int().positive(),
    generation_mode: z.enum(["resume", "fresh"]),
    generation_start_reason: z.enum([
      "initial",
      "pre-model-retry",
      "post-model-resume",
      "image-rollout",
      "stale-probe-rotation",
      "operator-restart",
      "unknown"
    ]),
    app: z.string().min(1),
    image: z.string().min(1),
    image_id: z.string().min(1),
    timeout_ms: z.number().int().positive(),
    source_revision: z.string().min(1),
    fingerprints: lineageFingerprintsSchema,
    launches: z.array(launchRecordSchema),
    attempt_history: z.array(attemptProvenanceSchema),
    recovery_lifecycle: z.array(modalRecoveryLifecycleRecordSchema)
  })
  .strict()
  .superRefine((state, context) => {
    const slugs = new Set<string>();
    for (const launch of state.launches) {
      if (launch.generation !== state.generation) {
        context.addIssue({ code: "custom", message: `launch ${launch.slug} has the wrong generation` });
      }
      if (slugs.has(launch.slug)) {
        context.addIssue({ code: "custom", message: `duplicate launch slug: ${launch.slug}` });
      }
      slugs.add(launch.slug);
    }
    const attempts = new Set<string>();
    const attemptIds = new Set<string>();
    for (const attempt of [...state.attempt_history, ...state.launches]) {
      const key = `${attempt.generation}:${attempt.slug}:${attempt.attempt}`;
      if (attempts.has(key)) context.addIssue({ code: "custom", message: `duplicate launch attempt: ${key}` });
      attempts.add(key);
      attemptIds.add(attempt.attempt_id);
      const lifecycle = state.recovery_lifecycle.find((record) => record.attempt_id === attempt.attempt_id);
      const expectedFingerprints = "fingerprints" in attempt ? attempt.fingerprints : state.fingerprints;
      if (lifecycle === undefined) {
        context.addIssue({ code: "custom", message: `launch attempt ${attempt.attempt_id} is missing lifecycle` });
      } else if (
        lifecycle.logical_run_id !== state.logical_run_id ||
        lifecycle.model_slug !== attempt.slug ||
        lifecycle.generation !== attempt.generation ||
        lifecycle.attempt !== attempt.attempt ||
        lifecycle.fingerprints.config !== expectedFingerprints.config ||
        lifecycle.fingerprints.source !== expectedFingerprints.source ||
        lifecycle.fingerprints.image !== expectedFingerprints.image ||
        lifecycle.fingerprints.model !== attempt.model_fingerprint
      ) {
        context.addIssue({ code: "custom", message: `launch attempt ${attempt.attempt_id} has mismatched lifecycle` });
      }
    }
    try {
      const recoveryRecords = parseModalRecoveryLifecycleRecords(state.recovery_lifecycle);
      const activeModels = new Set<string>();
      for (const record of recoveryRecords) {
        if (record.logical_run_id !== state.logical_run_id || !attemptIds.has(record.attempt_id)) {
          context.addIssue({
            code: "custom",
            path: ["recovery_lifecycle"],
            message: `orphaned recovery lifecycle ${record.attempt_id}`
          });
        }
        if (record.terminal_reason !== "active") continue;
        if (activeModels.has(record.model_slug)) {
          context.addIssue({
            code: "custom",
            path: ["recovery_lifecycle"],
            message: `multiple active recovery generations for ${record.model_slug}`
          });
        }
        activeModels.add(record.model_slug);
      }
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["recovery_lifecycle"],
        message: error instanceof Error ? error.message : "invalid recovery lifecycle"
      });
    }
  });

const legacyLaunchRecordSchema = modelSchema
  .extend({
    sandbox_id: z.string().min(1),
    volume_name: z.string().min(1),
    remote_root: z.string().min(1),
    launched_at: timestampSchema
  })
  .strict();

const legacyLaunchStateSchema = z
  .object({
    schema_version: z.literal(LEGACY_MODAL_LAUNCH_STATE_SCHEMA_VERSION),
    run_id: z.string().min(1),
    app: z.string().min(1),
    image: z.string().min(1),
    timeout_ms: z.number().int().positive(),
    source_revision: z.string().min(1),
    launches: z.array(legacyLaunchRecordSchema)
  })
  .strict()
  .superRefine((state, context) => {
    const slugs = new Set<string>();
    for (const launch of state.launches) {
      if (slugs.has(launch.slug)) {
        context.addIssue({ code: "custom", message: `duplicate launch slug: ${launch.slug}` });
      }
      slugs.add(launch.slug);
    }
  });

type LegacyModalLaunchState = z.infer<typeof legacyLaunchStateSchema>;
type PreviousModalLaunchState = z.infer<typeof previousLaunchStateSchema>;

export interface ModalLaunchStateCompatibilityContext {
  imageId: string;
  fingerprints: ModalLineageFingerprints;
}

const workerLineageSchema = z
  .object({
    schema_version: z.literal(MODAL_WORKER_LINEAGE_SCHEMA_VERSION),
    logical_run_id: z.string().min(1),
    generation: z.number().int().positive(),
    attempt: z.number().int().positive(),
    attempt_id: z.string().min(1),
    workspace_mode: z.enum(["resume", "fresh"]),
    fingerprints: lineageFingerprintsSchema,
    model_fingerprint: fingerprintSchema
  })
  .strict();

const workerStatusSchema = z
  .object({
    schema_version: z.literal(MODAL_WORKER_STATUS_SCHEMA_VERSION),
    updated_at: timestampSchema,
    stage: z.string().min(1),
    category: z.enum([
      "preparing",
      "model-work",
      "post-processing",
      "succeeded",
      "genuine-task-outcome",
      "resume-required",
      "transient-operational-failure",
      "permanent-operational-failure",
      "incompatible-checkpoint"
    ]),
    model_work_started: z.boolean(),
    retryable: z.boolean(),
    generation: z.number().int().positive(),
    attempt: z.number().int().positive(),
    eval_run_id: z.string().min(1).optional(),
    run_status: z.string().min(1).optional(),
    node_counts: z.record(z.string(), z.number().int().nonnegative()).optional(),
    error_code: z.enum(WORKER_DIAGNOSTIC_CODES).optional()
  })
  .strict();

const workerResultStatusSchema = z
  .object({
    schema_version: z.literal(WORKER_RESULT_SCHEMA_VERSION),
    result_type: z.enum(["partial", "terminal"]),
    generation: z.number().int().positive(),
    launch_generation: z.number().int().positive(),
    attempt: z.number().int().positive(),
    model_work_started: z.boolean(),
    counts: z
      .object({
        succeeded: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        remaining: z.number().int().nonnegative()
      })
      .strict(),
    checkpoint: z
      .object({
        age_ms: z.number().int().nonnegative().nullable(),
        digest: z
          .string()
          .regex(/^sha256:[a-f0-9]{64}$/u)
          .nullable()
      })
      .strict(),
    exit_category: z.enum(OPERATIONAL_DISPOSITION_CATEGORIES),
    runtime_ms: z.number().int().nonnegative(),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
        cache_read_tokens: z.number().int().nonnegative(),
        cache_write_tokens: z.number().int().nonnegative(),
        reasoning_tokens: z.number().int().nonnegative(),
        total_tokens: z.number().int().nonnegative(),
        estimated_cost_usd: z.number().nonnegative().nullable(),
        partial_pricing: z.boolean(),
        event_count: z.number().int().nonnegative(),
        priced_event_count: z.number().int().nonnegative(),
        unpriced_event_count: z.number().int().nonnegative()
      })
      .strict()
      .nullable(),
    pricing: z
      .object({
        source: z.enum(["models.dev", "configured-catalog", "disabled"]),
        status: z.enum(["available", "disabled", "unavailable"]),
        fetched_at: timestampSchema.optional(),
        resolved_model_count: z.number().int().nonnegative(),
        unresolved_model_count: z.number().int().nonnegative()
      })
      .strict()
      .optional(),
    diagnostic_code: z.enum(WORKER_DIAGNOSTIC_CODES)
  })
  .strict()
  .superRefine((status, context) => {
    if (status.result_type === "partial" && status.exit_category !== "live") {
      context.addIssue({ code: "custom", message: "partial worker result must be live" });
    }
    if (status.result_type === "terminal" && status.exit_category === "live") {
      context.addIssue({ code: "custom", message: "terminal worker result cannot be live" });
    }
  });

export function parseModalLaunchState(value: unknown): ModalLaunchState {
  return launchStateSchema.parse(value) as ModalLaunchState;
}

export function parseCompatibleModalLaunchState(
  value: unknown,
  compatibility?: ModalLaunchStateCompatibilityContext
): ModalLaunchState {
  const current = launchStateSchema.safeParse(value);
  if (current.success) return current.data as ModalLaunchState;
  const previous = previousLaunchStateSchema.safeParse(value);
  if (previous.success) return migratePreviousLaunchState(previous.data);
  const legacy = legacyLaunchStateSchema.safeParse(value);
  if (!legacy.success) return launchStateSchema.parse(value) as ModalLaunchState;
  if (compatibility === undefined) {
    throw new Error("legacy Modal launch state requires compatibility context");
  }
  return migrateLegacyLaunchState(legacy.data, compatibility);
}

export function parseModalWorkerLineage(value: unknown): ModalWorkerLineage {
  return workerLineageSchema.parse(value) as ModalWorkerLineage;
}

export function parseModalWorkerStatus(
  value: unknown,
  expected?: { generation: number; attempt: number }
): ModalWorkerStatus | undefined {
  const parsed = workerStatusSchema.safeParse(value);
  if (parsed.success) {
    const candidate = parsed.data;
    const status: ModalWorkerStatus = {
      schema_version: MODAL_WORKER_STATUS_SCHEMA_VERSION,
      updated_at: candidate.updated_at,
      stage: candidate.category,
      terminal: candidate.stage === "terminal",
      category: candidate.category,
      model_work_started: candidate.model_work_started,
      retryable: candidate.retryable,
      generation: candidate.generation,
      attempt: candidate.attempt,
      ...(candidate.eval_run_id === undefined ? {} : { eval_run_id: candidate.eval_run_id }),
      ...(candidate.run_status === undefined ? {} : { run_status: candidate.run_status }),
      ...(candidate.node_counts === undefined ? {} : { node_counts: candidate.node_counts }),
      ...(candidate.error_code === undefined ? {} : { error_code: candidate.error_code })
    };
    return matchesWorkerAttempt(status, expected) ? status : undefined;
  }
  const contract = parseModalWorkerResult(value, expected);
  if (contract === undefined) return undefined;
  const status: ModalWorkerStatus = {
    schema_version: WORKER_RESULT_SCHEMA_VERSION,
    stage: contract.result_type,
    terminal: contract.result_type === "terminal",
    category: workerResultCategory(contract),
    model_work_started: contract.model_work_started,
    retryable: workerResultCategory(contract) === "transient-operational-failure",
    generation: contract.launch_generation,
    attempt: contract.attempt,
    node_counts: { ...contract.counts },
    error_code: contract.diagnostic_code,
    result_generation: contract.generation
  };
  return status;
}

export function parseModalWorkerResult(
  value: unknown,
  expected?: { generation: number; attempt: number }
): WorkerResultContract | undefined {
  const parsed = workerResultStatusSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const contract = parsed.data as WorkerResultContract;
  return matchesWorkerAttempt({ generation: contract.launch_generation, attempt: contract.attempt }, expected)
    ? contract
    : undefined;
}

export function latestModalWorkerStatus(
  values: readonly unknown[],
  expected?: { generation: number; attempt: number }
): ModalWorkerStatus | undefined {
  let latest: ModalWorkerStatus | undefined;
  for (const value of values) {
    const candidate = parseModalWorkerStatus(value, expected);
    if (candidate === undefined) continue;
    if (latest === undefined || (candidate.result_generation ?? 0) >= (latest.result_generation ?? 0)) {
      latest = candidate;
    }
  }
  return latest;
}

export function isModalWorkerStatusTerminal(
  status: ModalWorkerStatus | undefined
): status is ModalWorkerStatus & { terminal: true } {
  return status?.terminal === true;
}

export function isModalWorkerStatusComplete(
  status: ModalWorkerStatus | undefined,
  expectedSucceeded: number | undefined
): status is ModalWorkerStatus & { terminal: true; category: "succeeded" } {
  return (
    Number.isSafeInteger(expectedSucceeded) &&
    expectedSucceeded! > 0 &&
    status?.terminal === true &&
    status.category === "succeeded" &&
    status.node_counts?.succeeded === expectedSucceeded &&
    status.node_counts?.failed === 0 &&
    status.node_counts.remaining === 0
  );
}

function matchesWorkerAttempt(
  status: Pick<ModalWorkerStatus, "generation" | "attempt">,
  expected: { generation: number; attempt: number } | undefined
): boolean {
  return expected === undefined || (status.generation === expected.generation && status.attempt === expected.attempt);
}

function workerResultCategory(contract: WorkerResultContract): ModalWorkerStatusCategory {
  if (contract.exit_category === "finished") return "succeeded";
  if (contract.exit_category === "genuine-evaluation-failure") return "genuine-task-outcome";
  if (contract.diagnostic_code === "terminal-run-non-resumable") return "permanent-operational-failure";
  if (contract.diagnostic_code === "checkpoint-incompatible") return "incompatible-checkpoint";
  if (contract.diagnostic_code === "public-eval-diagnostics-invalid") return "permanent-operational-failure";
  if (contract.exit_category === "live") return contract.model_work_started ? "model-work" : "preparing";
  if (contract.exit_category === "authentication-failure") return "permanent-operational-failure";
  if (contract.model_work_started) return "resume-required";
  return "transient-operational-failure";
}

export function fingerprintModalImage(imageName: string, imageId: string): string {
  return sha256(`${imageName}\0${imageId}`);
}

export function fingerprintTrackedSource(repoRoot: string): string {
  const root = path.resolve(repoRoot);
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root })
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry !== "")
    .sort();
  if (files.length === 0) throw new Error(`no Git-tracked source files found under ${root}`);
  const hash = createHash("sha256");
  for (const relative of files) {
    const absolute = path.join(root, relative);
    const stat = lstatSync(absolute);
    updateFramed(hash, relative);
    updateFramed(hash, sourceFileKind(stat));
    updateFramed(hash, stat.isSymbolicLink() ? readlinkSync(absolute) : readFileSync(absolute));
  }
  return hash.digest("hex");
}

export function createModalLaunchState(input: {
  logicalRunId: string;
  generation: number;
  generationMode: ModalLaunchMode;
  generationStartReason?: ModalRecoveryStartReason;
  app: string;
  image: string;
  imageId: string;
  timeoutMs: number;
  sourceRevision: string;
  fingerprints: ModalLineageFingerprints;
  attemptHistory?: ModalAttemptProvenance[];
  recoveryLifecycle?: ModalRecoveryLifecycleRecord[];
}): ModalLaunchState {
  return parseModalLaunchState({
    schema_version: MODAL_LAUNCH_STATE_SCHEMA_VERSION,
    logical_run_id: input.logicalRunId,
    generation: input.generation,
    generation_mode: input.generationMode,
    generation_start_reason: input.generationStartReason ?? (input.generation === 1 ? "initial" : "unknown"),
    app: input.app,
    image: input.image,
    image_id: input.imageId,
    timeout_ms: input.timeoutMs,
    source_revision: input.sourceRevision,
    fingerprints: input.fingerprints,
    launches: [],
    attempt_history: input.attemptHistory ?? [],
    recovery_lifecycle: input.recoveryLifecycle ?? []
  });
}

function migratePreviousLaunchState(state: PreviousModalLaunchState): ModalLaunchState {
  return parseModalLaunchState({
    ...state,
    schema_version: MODAL_LAUNCH_STATE_SCHEMA_VERSION,
    generation_start_reason: "unknown",
    recovery_lifecycle: historicalRecoveryLifecycle(
      state.logical_run_id,
      [...state.attempt_history, ...state.launches],
      state.fingerprints
    )
  });
}

function migrateLegacyLaunchState(
  state: LegacyModalLaunchState,
  compatibility: ModalLaunchStateCompatibilityContext
): ModalLaunchState {
  const launches: ModalLaunchRecord[] = state.launches.map((launch, index) => ({
    ...launch,
    generation: 1,
    attempt: 1,
    attempt_id: legacyAttemptId(launch, index),
    model_fingerprint: fingerprintLegacyModel(launch),
    workspace_mode: "resume",
    phase: "launched",
    reserved_at: launch.launched_at,
    sandbox_id: launch.sandbox_id,
    launched_at: launch.launched_at
  }));
  return parseModalLaunchState({
    schema_version: MODAL_LAUNCH_STATE_SCHEMA_VERSION,
    logical_run_id: state.run_id,
    generation: 1,
    generation_mode: "resume",
    generation_start_reason: "unknown",
    app: state.app,
    image: state.image,
    image_id: compatibility.imageId,
    timeout_ms: state.timeout_ms,
    source_revision: state.source_revision,
    fingerprints: compatibility.fingerprints,
    launches,
    attempt_history: [],
    recovery_lifecycle: historicalRecoveryLifecycle(state.run_id, launches, compatibility.fingerprints)
  });
}

export function assertExactModalLineage(
  state: ModalLaunchState,
  expected: {
    logicalRunId: string;
    app: string;
    image: string;
    imageId: string;
    fingerprints: ModalLineageFingerprints;
  }
): void {
  const mismatches = [
    state.logical_run_id === expected.logicalRunId ? undefined : "logical run",
    state.app === expected.app ? undefined : "app",
    state.image === expected.image ? undefined : "image name",
    state.image_id === expected.imageId ? undefined : "image identifier",
    state.fingerprints.config === expected.fingerprints.config ? undefined : "configuration fingerprint",
    state.fingerprints.source === expected.fingerprints.source ? undefined : "source fingerprint",
    state.fingerprints.image === expected.fingerprints.image ? undefined : "image fingerprint"
  ].filter((value): value is string => value !== undefined);
  if (mismatches.length > 0) {
    throw new Error(`incompatible Modal checkpoint: ${mismatches.join(", ")} mismatch`);
  }
}

export function reserveModalLaunchAttempt(input: {
  state: ModalLaunchState;
  model: ModalModelSpec;
  modelFingerprint: string;
  volumeName: string;
  remoteRoot: string;
  workspaceMode: ModalLaunchMode;
  postModelRecovery?: ModalPostModelRecovery;
  startReason?: ModalRecoveryStartReason;
  now?: string;
  attemptId?: string;
  /** Exit code observed on the attempt being replaced, when the caller probed its sandbox. */
  observedWorkerExitCode?: number | null;
}): ModalLaunchRecord {
  const existingIndex = input.state.launches.findIndex((launch) => launch.slug === input.model.slug);
  const existing = existingIndex === -1 ? undefined : input.state.launches[existingIndex];
  if (existing !== undefined && existing.model_fingerprint !== input.modelFingerprint) {
    throw new Error(`incompatible Modal checkpoint: model fingerprint mismatch for ${input.model.slug}`);
  }
  if (existing !== undefined) {
    const previousLifecycle = input.state.recovery_lifecycle.find(
      (record) => record.attempt_id === existing.attempt_id
    );
    if (previousLifecycle?.terminal_reason === "active") {
      finishModalRecoveryLifecycle(input.state.recovery_lifecycle, {
        attemptId: existing.attempt_id,
        terminalReason: "unknown",
        finishedAt: input.now ?? new Date().toISOString(),
        // Forwarded when the caller observed it. This force-close used to hardcode every diagnostic to
        // "unknown", which on unattended runs is the ONLY path that records a sandbox death -- so the exit
        // code was computed by `probeModalSandbox` and then discarded, and three Aave v4 runs lost their
        // sandbox at `stateful-invariant-setup` with no way to tell OOM from eviction from a clean exit
        // (issue #302).
        ...(input.observedWorkerExitCode === undefined ? {} : { workerExitCode: input.observedWorkerExitCode }),
        modelWorkStarted: "unknown",
        progressMade: "unknown",
        controllerRequested: "unknown"
      });
    }
    input.state.attempt_history.push(toAttemptProvenance(existing, input.state.fingerprints));
  }
  const record: ModalLaunchRecord = {
    ...input.model,
    generation: input.state.generation,
    attempt: (existing?.attempt ?? 0) + 1,
    attempt_id: input.attemptId ?? randomUUID(),
    model_fingerprint: input.modelFingerprint,
    volume_name: existing?.volume_name ?? input.volumeName,
    remote_root: existing?.remote_root ?? input.remoteRoot,
    workspace_mode: input.workspaceMode,
    ...(input.postModelRecovery === undefined ? {} : { post_model_recovery: input.postModelRecovery }),
    phase: "reserved",
    reserved_at: input.now ?? new Date().toISOString()
  };
  if (existingIndex === -1) input.state.launches.push(record);
  else input.state.launches[existingIndex] = record;
  const parent = existing ?? latestModalRecoveryLifecycle(input.state.recovery_lifecycle, input.model.slug);
  startModalRecoveryLifecycle(input.state.recovery_lifecycle, {
    logicalRunId: input.state.logical_run_id,
    modelSlug: input.model.slug,
    generation: record.generation,
    attempt: record.attempt,
    attemptId: record.attempt_id,
    ...(parent === undefined
      ? {}
      : {
          parentGeneration: parent.generation,
          parentAttemptId: parent.attempt_id
        }),
    startReason: input.startReason ?? (existing === undefined ? input.state.generation_start_reason : "unknown"),
    launchedAt: record.reserved_at,
    fingerprints: {
      ...input.state.fingerprints,
      model: input.modelFingerprint
    },
    ...(parent !== undefined && "node_counts_after" in parent && typeof parent.node_counts_after === "object"
      ? { nodeCountsBefore: parent.node_counts_after }
      : {})
  });
  parseModalLaunchState(input.state);
  return record;
}

export function finishModalLaunchRecoveryLifecycle(
  state: ModalLaunchState,
  record: Pick<ModalLaunchRecord, "attempt_id">,
  input: Omit<FinishModalRecoveryLifecycleInput, "attemptId">
): boolean {
  return finishModalRecoveryLifecycle(state.recovery_lifecycle, {
    ...input,
    attemptId: record.attempt_id
  }).changed;
}

export function markModalSandboxCreated(record: ModalLaunchRecord, sandboxId: string): void {
  if (record.phase !== "reserved") throw new Error(`cannot attach a sandbox to a ${record.phase} launch`);
  record.sandbox_id = sandboxId;
  record.phase = "sandbox-created";
}

export function markModalLaunchReady(record: ModalLaunchRecord, now = new Date().toISOString()): void {
  if (record.phase !== "sandbox-created" || record.sandbox_id === undefined) {
    throw new Error("cannot mark an unpersisted sandbox launch ready");
  }
  record.phase = "launched";
  record.launched_at = now;
  delete record.failure_category;
}

export function markModalLaunchFailed(
  record: ModalLaunchRecord,
  category: ModalLaunchFailureCategory,
  now = new Date().toISOString()
): void {
  record.phase = "failed";
  record.failure_category = category;
  record.finished_at = now;
}

export function markModalLaunchFailedWithRecovery(
  state: ModalLaunchState,
  record: ModalLaunchRecord,
  category: ModalLaunchFailureCategory,
  input: {
    now?: string;
    modelWorkStarted: boolean | "unknown";
    controllerRequested: boolean;
  }
): boolean {
  markModalLaunchFailed(record, category, input.now);
  return finishModalLaunchRecoveryLifecycle(state, record, {
    terminalReason:
      category === "transient-operational-failure" && record.attempt >= MODAL_PRE_MODEL_RETRY_LIMIT
        ? "recovery-budget-exhausted"
        : "operational-failure",
    finishedAt: record.finished_at!,
    modelWorkStarted: input.modelWorkStarted,
    controllerRequested: input.controllerRequested
  });
}

export function modalWorkerLineage(state: ModalLaunchState, record: ModalLaunchRecord): ModalWorkerLineage {
  return parseModalWorkerLineage({
    schema_version: MODAL_WORKER_LINEAGE_SCHEMA_VERSION,
    logical_run_id: state.logical_run_id,
    generation: record.generation,
    attempt: record.attempt,
    attempt_id: record.attempt_id,
    workspace_mode: record.workspace_mode,
    fingerprints: state.fingerprints,
    model_fingerprint: record.model_fingerprint
  });
}

export function modalLaunchTags(state: ModalLaunchState, record: ModalLaunchRecord): Record<string, string> {
  return {
    purpose: "ultrafuzz-eval",
    logical_run: state.logical_run_id,
    generation: String(record.generation),
    model_slug: record.slug,
    attempt: String(record.attempt),
    attempt_id: record.attempt_id,
    config_fingerprint: state.fingerprints.config,
    source_fingerprint: state.fingerprints.source,
    image_fingerprint: state.fingerprints.image,
    model_fingerprint: record.model_fingerprint
  };
}

export function hasExactModalLaunchTags(candidate: Record<string, string>, expected: Record<string, string>): boolean {
  return Object.entries(expected).every(([key, value]) => candidate[key] === value);
}

export type ModalSandboxState = "live" | "exited" | "missing";
export type ModalRunnerStatusCategory =
  | "live"
  | "succeeded"
  | "genuine-task-outcome"
  | "resume-required"
  | "transient-operational-failure"
  | "permanent-operational-failure"
  | "incompatible-checkpoint";

export interface ModalRunnerStatus {
  category: ModalRunnerStatusCategory;
  action: "none" | "relaunch";
  model_work_started: boolean;
  retryable: boolean;
  retry_after_ms: number;
}

export function classifyModalRunnerStatus(input: {
  sandbox: ModalSandboxState;
  attempt: number;
  workerStatus?: ModalWorkerStatus;
  launchFailure?: ModalLaunchFailureCategory;
  postModelRecovery?: "relaunch" | "stop";
  modelWorkMayHaveStarted?: boolean;
}): ModalRunnerStatus {
  if (input.sandbox === "live") {
    return status("live", "none", input.workerStatus?.model_work_started ?? false, false, 0);
  }
  const worker = input.workerStatus;
  if (worker?.category === "succeeded") return status("succeeded", "none", true, false, 0);
  if (worker?.category === "genuine-task-outcome") {
    return status("genuine-task-outcome", "none", true, false, 0);
  }
  if (worker?.category === "incompatible-checkpoint") {
    return status("incompatible-checkpoint", "none", worker.model_work_started, false, 0);
  }
  if (worker?.category === "permanent-operational-failure") {
    return status("permanent-operational-failure", "none", worker.model_work_started, false, 0);
  }
  if (
    worker?.model_work_started === true ||
    worker?.category === "model-work" ||
    worker?.category === "post-processing" ||
    worker?.category === "resume-required"
  ) {
    return status("resume-required", input.postModelRecovery === "stop" ? "none" : "relaunch", true, false, 0);
  }
  if (input.modelWorkMayHaveStarted === true && (worker === undefined || !isModalWorkerStatusTerminal(worker))) {
    return status("resume-required", input.postModelRecovery === "stop" ? "none" : "relaunch", true, false, 0);
  }
  if (input.launchFailure === "permanent-operational-failure") {
    return status("permanent-operational-failure", "none", false, false, 0);
  }
  if (input.attempt >= MODAL_PRE_MODEL_RETRY_LIMIT) {
    return status("permanent-operational-failure", "none", false, false, 0);
  }
  return status("transient-operational-failure", "relaunch", false, true, modalPreModelRetryDelay(input.attempt));
}

export function modalRecoveryTerminalReasonForWorkerStatus(input: {
  category: ModalRunnerStatusCategory | ModalWorkerStatusCategory;
  attempt: number;
  modelWorkStarted: boolean;
  recoveryBudgetExhausted?: boolean;
}): Exclude<ModalRecoveryTerminalReason, "active"> {
  if (input.category === "succeeded") return "succeeded";
  if (input.category === "genuine-task-outcome") return "genuine-worker-failure";
  if (
    (input.recoveryBudgetExhausted === true || input.category === "transient-operational-failure") &&
    input.attempt >= MODAL_PRE_MODEL_RETRY_LIMIT &&
    !input.modelWorkStarted
  ) {
    return "recovery-budget-exhausted";
  }
  return "operational-failure";
}

export function modalRecoveryFinishedAtForWorkerStatus(
  workerStatus: Pick<ModalWorkerStatus, "updated_at"> | undefined,
  fallback: string
): string {
  return workerStatus?.updated_at ?? fallback;
}

export function modalPreModelRetryDelay(completedAttempts: number): number {
  const exponent = Math.max(0, completedAttempts - 1);
  return Math.min(MODAL_PRE_MODEL_RETRY_MAX_DELAY_MS, MODAL_PRE_MODEL_RETRY_BASE_DELAY_MS * 2 ** exponent);
}

export function isTransientModalError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (["InternalFailure", "TimeoutError", "SandboxTimeoutError"].includes(error.name)) return true;
  if ("code" in error && typeof error.code === "string") {
    return ["ECONNRESET", "EAI_AGAIN", "ETIMEDOUT"].includes(error.code);
  }
  return false;
}

export async function readModalLaunchState(
  statePath: string,
  compatibility?: ModalLaunchStateCompatibilityContext
): Promise<ModalLaunchState | undefined> {
  try {
    return parseCompatibleModalLaunchState(
      JSON.parse(await readFile(path.resolve(statePath), "utf8")) as unknown,
      compatibility
    );
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function writeModalLaunchState(statePath: string, state: ModalLaunchState): Promise<void> {
  const target = path.resolve(statePath);
  const checked = parseModalLaunchState(state);
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

export interface ModalLaunchLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  token?: string;
}

export async function withModalLaunchStateLock<T>(
  statePath: string,
  operation: () => Promise<T>,
  options: ModalLaunchLockOptions = {}
): Promise<T> {
  const target = path.resolve(statePath);
  const lockPath = `${target}.lock`;
  const now = options.now ?? Date.now;
  const delay = options.delay ?? sleep;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 25;
  const token = options.token ?? randomUUID();
  const pidStartTicks = readProcessStartTicksSync(process.pid);
  const deadline = now() + timeoutMs;
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  let handle;
  while (handle === undefined) {
    try {
      const candidate = await open(lockPath, "wx", 0o600);
      try {
        await candidate.writeFile(
          `${JSON.stringify({
            token,
            pid: process.pid,
            ...(pidStartTicks === undefined ? {} : { pid_start_ticks: pidStartTicks }),
            created_at: new Date(now()).toISOString()
          })}\n`
        );
        await candidate.sync();
        handle = candidate;
      } catch (error) {
        await candidate.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      if (await reclaimDeadLaunchLock(lockPath)) continue;
      if (now() >= deadline) {
        throw new Error(`timed out acquiring Modal launch state lock: ${lockPath}`, { cause: error });
      }
      await delay(pollMs);
    }
  }
  let result: T | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  await handle.close().catch(() => undefined);
  let releaseError: unknown;
  try {
    const owner = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
    if (owner.token === token) await unlink(lockPath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) releaseError = error;
  }
  if (operationFailed) throw operationError;
  if (releaseError !== undefined) throw releaseError;
  return result as T;
}

function toAttemptProvenance(
  record: ModalLaunchRecord,
  fingerprints: ModalLineageFingerprints
): ModalAttemptProvenance {
  return {
    slug: record.slug,
    generation: record.generation,
    attempt: record.attempt,
    attempt_id: record.attempt_id,
    model_fingerprint: record.model_fingerprint,
    fingerprints,
    workspace_mode: record.workspace_mode,
    ...(record.post_model_recovery === undefined ? {} : { post_model_recovery: record.post_model_recovery }),
    reserved_at: record.reserved_at,
    ...(record.sandbox_id === undefined ? {} : { sandbox_id: record.sandbox_id }),
    ...(record.launched_at === undefined ? {} : { launched_at: record.launched_at }),
    ...(record.finished_at === undefined ? {} : { finished_at: record.finished_at }),
    phase: record.phase
  };
}

function historicalRecoveryLifecycle(
  logicalRunId: string,
  attempts: ReadonlyArray<ModalAttemptProvenance | ModalLaunchRecord>,
  fallbackFingerprints: ModalLineageFingerprints
): ModalRecoveryLifecycleRecord[] {
  const records: ModalRecoveryLifecycleRecord[] = [];
  const latestBySlug = new Map<string, ModalRecoveryLifecycleRecord>();
  for (const attempt of attempts) {
    const parent = latestBySlug.get(attempt.slug);
    const record = parseModalRecoveryLifecycleRecord({
      schema_version: "ultrafuzz.modal.recovery-lifecycle.v1",
      logical_run_id: logicalRunId,
      model_slug: attempt.slug,
      generation: attempt.generation,
      attempt: attempt.attempt,
      attempt_id: attempt.attempt_id,
      ...(parent === undefined
        ? {}
        : {
            parent_generation: parent.generation,
            parent_attempt_id: parent.attempt_id
          }),
      trigger_action: "unknown",
      start_reason: "unknown",
      terminal_reason: "unknown",
      terminal_class: "unknown",
      launched_at: attempt.launched_at ?? attempt.reserved_at,
      ...(attempt.finished_at === undefined ? {} : { finished_at: attempt.finished_at }),
      worker_exit_code: "unknown",
      fingerprints: {
        ...("fingerprints" in attempt ? attempt.fingerprints : fallbackFingerprints),
        model: attempt.model_fingerprint
      },
      model_work_started: "unknown",
      last_durable_transition_at: "unknown",
      node_counts_before: "unknown",
      node_counts_after: "unknown",
      progress_made: "unknown",
      controller_requested: "unknown",
      node_attempt_ledger_digest: "unknown",
      evaluation_lineage_digest: "unknown"
    });
    records.push(record);
    latestBySlug.set(attempt.slug, record);
  }
  return records;
}

function latestModalRecoveryLifecycle(
  records: readonly ModalRecoveryLifecycleRecord[],
  modelSlug: string
): ModalRecoveryLifecycleRecord | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.model_slug === modelSlug) return record;
  }
  return undefined;
}

function status(
  category: ModalRunnerStatusCategory,
  action: ModalRunnerStatus["action"],
  modelWorkStarted: boolean,
  retryable: boolean,
  retryAfterMs: number
): ModalRunnerStatus {
  return {
    category,
    action,
    model_work_started: modelWorkStarted,
    retryable,
    retry_after_ms: retryAfterMs
  };
}

function sourceFileKind(stat: Stats): string {
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isFile()) return stat.mode & 0o111 ? "executable" : "file";
  throw new Error("tracked source contains an unsupported file type");
}

function updateFramed(hash: ReturnType<typeof createHash>, value: string | Buffer): void {
  const contents = Buffer.isBuffer(value) ? value : Buffer.from(value);
  hash.update(String(contents.length));
  hash.update("\0");
  hash.update(contents);
  hash.update("\0");
}

function legacyAttemptId(launch: Pick<ModalLaunchRecord, "slug" | "sandbox_id">, index: number): string {
  return `legacy-${sha256(`${launch.slug}\0${launch.sandbox_id}\0${index}`).slice(0, 32)}`;
}

function fingerprintLegacyModel(model: ModalModelSpec): string {
  return sha256(
    JSON.stringify({
      slug: model.slug,
      model: model.model,
      provider: model.provider,
      agent: model.agent,
      reasoning: model.reasoning,
      auth_mode: model.auth_mode
    })
  );
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

interface ObservedLaunchLock {
  identity: string;
  owner: { token?: unknown; pid?: unknown; pid_start_ticks?: unknown } | undefined;
  dead: boolean;
}

async function observeLaunchLock(lockPath: string): Promise<ObservedLaunchLock | undefined> {
  try {
    const contents = await readFile(lockPath, "utf8");
    const metadata = await stat(lockPath);
    let owner: ObservedLaunchLock["owner"];
    try {
      owner = JSON.parse(contents) as { token?: unknown; pid?: unknown; pid_start_ticks?: unknown };
    } catch {
      owner = undefined;
    }
    let dead = Date.now() - metadata.mtimeMs > 5_000;
    if (typeof owner?.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0) {
      try {
        process.kill(owner.pid, 0);
        const expectedStartTicks = owner.pid_start_ticks;
        const actualStartTicks =
          typeof expectedStartTicks === "string" ? await readProcessStartTicks(owner.pid) : undefined;
        dead =
          typeof expectedStartTicks === "string" && actualStartTicks !== undefined
            ? actualStartTicks !== expectedStartTicks
            : false;
      } catch (error) {
        dead = isNodeError(error, "ESRCH");
      }
    }
    return { identity: sha256(contents), owner, dead };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function reclaimDeadLaunchLock(lockPath: string): Promise<boolean> {
  const observed = await observeLaunchLock(lockPath);
  if (observed === undefined) return true;
  if (!observed.dead) return false;
  const claimPath = `${lockPath}.reclaim-${observed.identity.slice(0, 32)}`;
  let claim;
  try {
    claim = await open(claimPath, "wx", 0o600);
  } catch (error) {
    if (isNodeError(error, "EEXIST")) return false;
    throw error;
  }
  try {
    await claim.writeFile(`${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`);
    await claim.sync();
    const current = await observeLaunchLock(lockPath);
    if (current === undefined) return true;
    if (current.identity !== observed.identity || !current.dead) return false;
    await unlink(lockPath);
    return true;
  } finally {
    await claim.close().catch(() => undefined);
    await unlink(claimPath).catch(() => undefined);
  }
}

function readProcessStartTicksSync(pid: number): string | undefined {
  try {
    return parseProcessStartTicks(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return undefined;
  }
}

async function readProcessStartTicks(pid: number): Promise<string | undefined> {
  try {
    return parseProcessStartTicks(await readFile(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return undefined;
  }
}

function parseProcessStartTicks(contents: string): string | undefined {
  const commandEnd = contents.lastIndexOf(") ");
  if (commandEnd === -1) return undefined;
  const fieldsFromState = contents
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/u);
  const startTicks = fieldsFromState[19];
  return startTicks !== undefined && /^\d+$/u.test(startTicks) ? startTicks : undefined;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
