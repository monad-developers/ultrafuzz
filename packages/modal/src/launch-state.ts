import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, type Stats } from "node:fs";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { parseStrictJsonBytes, readRegularFileSnapshot } from "@ultrafuzz/artifacts";

import {
  MODAL_LAUNCH_STATE_SCHEMA_VERSION,
  MODAL_PRE_MODEL_RETRY_BASE_DELAY_MS,
  MODAL_PRE_MODEL_RETRY_LIMIT,
  MODAL_PRE_MODEL_RETRY_MAX_DELAY_MS,
  MODAL_WORKER_LINEAGE_SCHEMA_VERSION,
  type ModalLaunchMode,
  type ModalModelSpec
} from "./defaults.js";
import {
  finishModalRecoveryLifecycle,
  startModalRecoveryLifecycle,
  type FinishModalRecoveryLifecycleInput,
  type ModalRecoveryLifecycleRecord,
  type ModalRecoveryStartReason,
  type ModalRecoveryTerminalReason
} from "./recovery-lifecycle.js";
import {
  MODAL_LAUNCH_STATE_SCHEMA_ID,
  MODAL_WORKER_LINEAGE_SCHEMA_ID,
  MODAL_WORKER_RESULT_SCHEMA_ID
} from "./modal-contracts.js";
import { parseModalDocumentValue, readModalDocument, writeModalDocumentAtomic } from "./modal-documents.js";
import { WORKER_RESULT_SCHEMA_VERSION, type WorkerResultContract } from "./worker-result.js";
import { setTimeout as sleep } from "node:timers/promises";

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
  schema_version: typeof WORKER_RESULT_SCHEMA_VERSION;
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

export function parseModalLaunchState(value: unknown): ModalLaunchState {
  return parseModalDocumentValue(MODAL_LAUNCH_STATE_SCHEMA_ID, value) as ModalLaunchState;
}

export function parseModalWorkerLineage(value: unknown): ModalWorkerLineage {
  return parseModalDocumentValue(MODAL_WORKER_LINEAGE_SCHEMA_ID, value) as ModalWorkerLineage;
}

export function parseModalWorkerStatus(
  value: unknown,
  expected?: { generation: number; attempt: number }
): ModalWorkerStatus | undefined {
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
  const contract = parseModalDocumentValue(MODAL_WORKER_RESULT_SCHEMA_ID, value) as WorkerResultContract;
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
  // Every code below names a fault the worker determined and reported about
  // itself, so each classifies by the code. A worker that never named a fault
  // exits `sandbox-exited` with the matching code and falls through to the
  // exit-category rules; see `namedFaultDisposition` in `worker-result.ts`.
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
  /**
   * What the caller durably observed about the attempt this reservation
   * replaces, used when that attempt's lifecycle is still `active` and has to
   * be force-closed here.
   *
   * The overseer relaunch path reads the outgoing attempt's worker status
   * before it decides to relaunch and is the only writer of that record, so
   * defaulting to `"unknown"` would make `modalPreModelAttempt` count every
   * overseer relaunch as a pre-model flake and leave #267 unfixed for
   * unattended runs.
   */
  observedModelWorkStarted?: boolean | "unknown";
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
        modelWorkStarted: input.observedModelWorkStarted ?? "unknown",
        progressMade: "unknown",
        controllerRequested: "unknown"
      });
    }
    input.state.attempt_history.push(modalAttemptProvenance(existing, input.state.fingerprints));
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

declare const modalPreModelAttemptBrand: unique symbol;

/**
 * A consecutive pre-model attempt streak, as produced by `modalPreModelAttempt`.
 *
 * The brand exists so `record.attempt` — the counter this budget used to be
 * wrongly charged against — cannot be passed where a streak is required. Only
 * `modalPreModelAttempt` produces the brand, so #267 cannot be reintroduced by a
 * call site that looks plausible; it stops compiling instead.
 */
export type ModalPreModelAttempt = number & { readonly [modalPreModelAttemptBrand]: "pre-model-attempt" };

/**
 * How many consecutive attempts, ending at `record`, have failed to start model
 * work in this generation.
 *
 * `record.attempt` counts every attempt a model has made in the current
 * generation, including attempts that ran real model work and then asked for a
 * durable resume. `MODAL_PRE_MODEL_RETRY_LIMIT` only bounds launch flakes that
 * happen before model work, so it must be charged against this streak instead.
 * The streak resets on an attempt whose recovery lifecycle definitely observed
 * model work; an `"unknown"` observation does not reset it, which keeps the
 * bound fail-closed against a zero-progress relaunch cycle. Every writer that
 * closes an attempt lifecycle therefore has to record what it actually observed
 * — see `reserveModalLaunchAttempt`'s `observedModelWorkStarted`.
 */
export function modalPreModelAttempt(
  state: Pick<ModalLaunchState, "recovery_lifecycle">,
  record: Pick<ModalLaunchRecord, "slug" | "generation" | "attempt">
): ModalPreModelAttempt {
  const lastModelWorkAttempt = state.recovery_lifecycle.reduce(
    (latest, lifecycle) =>
      lifecycle.model_slug === record.slug &&
      lifecycle.generation === record.generation &&
      lifecycle.attempt < record.attempt &&
      lifecycle.model_work_started === true
        ? Math.max(latest, lifecycle.attempt)
        : latest,
    0
  );
  return (record.attempt - lastModelWorkAttempt) as ModalPreModelAttempt;
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
      category === "transient-operational-failure" &&
      input.modelWorkStarted === false &&
      modalPreModelAttempt(state, record) >= MODAL_PRE_MODEL_RETRY_LIMIT
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
  /** Consecutive attempts that never reached model work; see `modalPreModelAttempt`. */
  preModelAttempt: ModalPreModelAttempt;
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
  if (input.preModelAttempt >= MODAL_PRE_MODEL_RETRY_LIMIT) {
    return status("permanent-operational-failure", "none", false, false, 0);
  }
  return status(
    "transient-operational-failure",
    "relaunch",
    false,
    true,
    modalPreModelRetryDelay(input.preModelAttempt)
  );
}

export function modalRecoveryTerminalReasonForWorkerStatus(input: {
  category: ModalRunnerStatusCategory | ModalWorkerStatusCategory;
  /** Consecutive attempts that never reached model work; see `modalPreModelAttempt`. */
  preModelAttempt: ModalPreModelAttempt;
  modelWorkStarted: boolean;
  recoveryBudgetExhausted?: boolean;
}): Exclude<ModalRecoveryTerminalReason, "active"> {
  if (input.category === "succeeded") return "succeeded";
  if (input.category === "genuine-task-outcome") return "genuine-worker-failure";
  if (
    (input.recoveryBudgetExhausted === true || input.category === "transient-operational-failure") &&
    input.preModelAttempt >= MODAL_PRE_MODEL_RETRY_LIMIT &&
    !input.modelWorkStarted
  ) {
    return "recovery-budget-exhausted";
  }
  return "operational-failure";
}

/**
 * Whether the pre-model launch budget is what stopped this attempt.
 *
 * Several categories reach `action: "none"` without spending a single
 * pre-model retry: a worker-reported permanent failure, an incompatible
 * checkpoint, a permanent launch failure, and `resume-required` under the
 * stop-on-post-model policy that public benchmark configs use. Naming the
 * budget on those paths is the same class of misdirection #267 is about.
 */
export function modalPreModelBudgetExhausted(input: {
  category: ModalRunnerStatusCategory;
  modelWorkStarted: boolean;
  preModelAttempt: ModalPreModelAttempt;
  workerCategory: ModalWorkerStatusCategory | undefined;
  launchFailure: ModalLaunchFailureCategory | undefined;
}): boolean {
  return (
    input.category === "permanent-operational-failure" &&
    !input.modelWorkStarted &&
    input.preModelAttempt >= MODAL_PRE_MODEL_RETRY_LIMIT &&
    input.workerCategory !== "permanent-operational-failure" &&
    input.launchFailure !== "permanent-operational-failure"
  );
}

/** Names the budget position only when `modalPreModelBudgetExhausted` says the budget is the cause. */
export function modalRunnerAbandonmentMessage(input: {
  slug: string;
  category: ModalRunnerStatusCategory;
  preModelAttempt: ModalPreModelAttempt;
  preModelBudgetExhausted: boolean;
}): string {
  const budget = input.preModelBudgetExhausted
    ? ` (pre-model attempt ${input.preModelAttempt} of ${MODAL_PRE_MODEL_RETRY_LIMIT})`
    : "";
  return `Modal runner cannot relaunch ${input.slug}: ${input.category}${budget}`;
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

export async function readModalLaunchState(statePath: string): Promise<ModalLaunchState | undefined> {
  try {
    const snapshot = readModalDocument(path.resolve(statePath), MODAL_LAUNCH_STATE_SCHEMA_ID);
    return structuredClone(snapshot.value) as ModalLaunchState;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function writeModalLaunchState(statePath: string, state: ModalLaunchState): Promise<void> {
  const target = path.resolve(statePath);
  const checked = parseModalLaunchState(state);
  const trustedRoot = path.dirname(target);
  await mkdir(trustedRoot, { recursive: true, mode: 0o700 });
  await writeModalDocumentAtomic(target, MODAL_LAUNCH_STATE_SCHEMA_ID, checked, {
    trustedRoot
  });
}

export interface ModalLaunchLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  token?: string;
}

interface ModalLaunchLockOwner {
  token: string;
  pid: number;
  pid_start_ticks?: string;
  created_at: string;
}

const MAX_MODAL_LAUNCH_LOCK_BYTES = 4 * 1024;

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
  if (!isModalLaunchLockToken(token)) {
    throw new Error("Modal launch state lock token must be a non-empty bounded opaque string");
  }
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
    const owner = parseModalLaunchLockOwner(readRegularFileSnapshot(lockPath, MAX_MODAL_LAUNCH_LOCK_BYTES), lockPath);
    if (owner.token === token) await unlink(lockPath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) releaseError = error;
  }
  if (operationFailed) throw operationError;
  if (releaseError !== undefined) throw releaseError;
  return result as T;
}

/** Snapshots a launch record for `attempt_history`, including its recovery policy. */
export function modalAttemptProvenance(
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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

interface ObservedLaunchLock {
  identity: string;
  owner: ModalLaunchLockOwner;
  dead: boolean;
}

async function observeLaunchLock(lockPath: string): Promise<ObservedLaunchLock | undefined> {
  try {
    const contents = readRegularFileSnapshot(lockPath, MAX_MODAL_LAUNCH_LOCK_BYTES);
    const metadata = await stat(lockPath);
    const owner = parseModalLaunchLockOwner(contents, lockPath);
    let dead = Date.now() - metadata.mtimeMs > 5_000;
    try {
      process.kill(owner.pid, 0);
      const expectedStartTicks = owner.pid_start_ticks;
      const actualStartTicks = expectedStartTicks === undefined ? undefined : await readProcessStartTicks(owner.pid);
      dead =
        expectedStartTicks !== undefined && actualStartTicks !== undefined
          ? actualStartTicks !== expectedStartTicks
          : false;
    } catch (error) {
      dead = isNodeError(error, "ESRCH");
    }
    return { identity: sha256(contents), owner, dead };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function parseModalLaunchLockOwner(contents: Uint8Array, lockPath: string): ModalLaunchLockOwner {
  let value: unknown;
  try {
    value = parseStrictJsonBytes(contents, {
      maxBytes: MAX_MODAL_LAUNCH_LOCK_BYTES,
      maxDepth: 2,
      maxItems: 0,
      maxProperties: 4
    });
  } catch (error) {
    throw new Error(`Modal launch state lock metadata is not strict bounded JSON: ${lockPath}`, { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Modal launch state lock metadata must be an object: ${lockPath}`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const allowedKeys = new Set(["token", "pid", "pid_start_ticks", "created_at"]);
  const exactKeyCount = Object.hasOwn(record, "pid_start_ticks") ? 4 : 3;
  if (
    keys.length !== exactKeyCount ||
    keys.some((key) => !allowedKeys.has(key)) ||
    !isModalLaunchLockToken(record.token) ||
    typeof record.pid !== "number" ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    (record.pid_start_ticks !== undefined &&
      (typeof record.pid_start_ticks !== "string" || !/^[0-9]+$/u.test(record.pid_start_ticks))) ||
    typeof record.created_at !== "string" ||
    !isCanonicalTimestamp(record.created_at)
  ) {
    throw new Error(`Modal launch state lock metadata has an unsupported shape: ${lockPath}`);
  }
  return {
    token: record.token,
    pid: record.pid,
    ...(record.pid_start_ticks === undefined ? {} : { pid_start_ticks: record.pid_start_ticks }),
    created_at: record.created_at
  };
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isModalLaunchLockToken(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value === value.trim() && Buffer.byteLength(value, "utf8") <= 256
  );
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
  if (!(error instanceof Error)) return false;
  if ("code" in error && error.code === code) return true;
  return "cause" in error && isNodeError(error.cause, code);
}
