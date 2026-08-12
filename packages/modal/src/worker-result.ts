import crypto from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  OperationalDispositionError,
  operationalDispositionForError,
  type OperationalDispositionCategory
} from "./terminal-disposition.js";

export const WORKER_RESULT_SCHEMA_VERSION = "ultrafuzz.modal.worker-result.v2" as const;

export const WORKER_RESULT_ALLOWED_KEYS = [
  "schema_version",
  "result_type",
  "generation",
  "launch_generation",
  "attempt",
  "model_work_started",
  "counts",
  "checkpoint",
  "exit_category",
  "runtime_ms",
  "usage",
  "pricing",
  "diagnostic_code"
] as const;

export const WORKER_DIAGNOSTIC_CODES = [
  "worker-live",
  "worker-finished",
  "capacity-unavailable",
  "authentication-failure",
  "sandbox-exited",
  "dependency-unreachable",
  "genuine-evaluation-failure",
  "terminal-run-non-resumable",
  "checkpoint-incompatible",
  "public-eval-diagnostics-invalid"
] as const;

export type WorkerDiagnosticCode = (typeof WORKER_DIAGNOSTIC_CODES)[number];

export interface WorkerExecutionContext {
  launch_generation: number;
  attempt: number;
  model_work_started: boolean;
}

export interface AggregateCounts {
  succeeded: number;
  failed: number;
  remaining: number;
}

export interface CheckpointMetadata {
  age_ms: number | null;
  digest: string | null;
}

export interface AggregateUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number | null;
  partial_pricing: boolean;
  event_count: number;
  priced_event_count: number;
  unpriced_event_count: number;
}

export interface PricingProvenance {
  source: "models.dev" | "configured-catalog" | "disabled";
  status: "available" | "disabled" | "unavailable";
  fetched_at?: string;
  resolved_model_count: number;
  unresolved_model_count: number;
}

export interface WorkerCheckpointSnapshot {
  counts: AggregateCounts;
  checkpoint: CheckpointMetadata;
  usage: AggregateUsage | null;
  pricing?: PricingProvenance;
}

export interface WorkerResultContract {
  schema_version: typeof WORKER_RESULT_SCHEMA_VERSION;
  result_type: "partial" | "terminal";
  generation: number;
  launch_generation: number;
  attempt: number;
  model_work_started: boolean;
  counts: AggregateCounts;
  checkpoint: CheckpointMetadata;
  exit_category: OperationalDispositionCategory;
  runtime_ms: number;
  usage: AggregateUsage | null;
  pricing?: PricingProvenance;
  diagnostic_code: WorkerDiagnosticCode;
}

type TerminalCompletionCategory = Extract<OperationalDispositionCategory, "finished" | "genuine-evaluation-failure">;

const SUCCEEDED_STATUSES = new Set(["succeeded", "reused-from-prior-run"]);
const FAILED_STATUSES = new Set(["failed", "timed-out", "invalidated", "skipped"]);
const EMPTY_SNAPSHOT: WorkerCheckpointSnapshot = {
  counts: { succeeded: 0, failed: 0, remaining: 0 },
  checkpoint: { age_ms: null, digest: null },
  usage: null
};

const DIAGNOSTIC_CODES: Record<OperationalDispositionCategory, WorkerDiagnosticCode> = {
  live: "worker-live",
  finished: "worker-finished",
  "capacity-unavailable": "capacity-unavailable",
  "authentication-failure": "authentication-failure",
  "sandbox-exited": "sandbox-exited",
  unreachable: "dependency-unreachable",
  "genuine-evaluation-failure": "genuine-evaluation-failure"
};

export class WorkerResultWriter {
  private generation: number;
  private pendingWrite: Promise<void> = Promise.resolve();

  private constructor(
    private readonly statusPath: string,
    private readonly resultPath: string,
    private readonly startedAtMs: number,
    private readonly now: () => number,
    private readonly executionContext: () => WorkerExecutionContext,
    private readonly generationFloorPath: string | undefined,
    private readonly writeGuard: WorkerResultWriteGuard | undefined,
    generation: number
  ) {
    this.generation = generation;
  }

  static async create(input: {
    statusPath: string;
    resultPath: string;
    startedAtMs?: number;
    now?: () => number;
    executionContext?: () => WorkerExecutionContext;
    generationFloorPath?: string;
    writeGuard?: WorkerResultWriteGuard;
  }): Promise<WorkerResultWriter> {
    const now = input.now ?? Date.now;
    const generation = Math.max(
      await persistedGeneration(input.statusPath),
      await persistedGeneration(input.resultPath),
      input.generationFloorPath === undefined ? 0 : await persistedGenerationFloor(input.generationFloorPath)
    );
    return new WorkerResultWriter(
      input.statusPath,
      input.resultPath,
      input.startedAtMs ?? now(),
      now,
      input.executionContext ?? (() => ({ launch_generation: 1, attempt: 1, model_work_started: false })),
      input.generationFloorPath,
      input.writeGuard,
      generation
    );
  }

  currentGeneration(): number {
    return this.generation;
  }

  async writePartial(snapshot: WorkerCheckpointSnapshot): Promise<WorkerResultContract> {
    return this.enqueue(async () => {
      await this.refreshGenerationFloor();
      const contract = this.contract("partial", "live", snapshot);
      await writeJsonAtomic(this.statusPath, contract);
      return contract;
    });
  }

  async writeTerminal(
    category: Exclude<OperationalDispositionCategory, "live">,
    snapshot: WorkerCheckpointSnapshot,
    diagnosticCode?: WorkerDiagnosticCode
  ): Promise<WorkerResultContract> {
    return this.enqueue(async () => {
      await this.refreshGenerationFloor();
      const contract = this.contract("terminal", category, snapshot, diagnosticCode);
      await writeJsonAtomic(this.resultPath, contract);
      await writeJsonAtomic(this.statusPath, contract);
      return contract;
    });
  }

  private enqueue<T>(write: () => Promise<T>): Promise<T> {
    const guardedWrite = this.writeGuard === undefined ? write : () => this.writeGuard!(write);
    const queued = this.pendingWrite.then(guardedWrite, guardedWrite);
    this.pendingWrite = queued.then(
      () => undefined,
      () => undefined
    );
    return queued;
  }

  private async refreshGenerationFloor(): Promise<void> {
    this.generation = Math.max(
      this.generation,
      await persistedGeneration(this.statusPath),
      await persistedGeneration(this.resultPath),
      this.generationFloorPath === undefined ? 0 : await persistedGenerationFloor(this.generationFloorPath)
    );
  }

  private contract(
    resultType: WorkerResultContract["result_type"],
    category: OperationalDispositionCategory,
    snapshot: WorkerCheckpointSnapshot,
    diagnosticCode?: WorkerDiagnosticCode
  ): WorkerResultContract {
    this.generation += 1;
    const sanitized = sanitizedSnapshot(snapshot);
    const context = this.executionContext();
    return {
      schema_version: WORKER_RESULT_SCHEMA_VERSION,
      result_type: resultType,
      generation: this.generation,
      launch_generation: positiveInteger(context.launch_generation),
      attempt: positiveInteger(context.attempt),
      model_work_started: context.model_work_started === true,
      counts: sanitized.counts,
      checkpoint: sanitized.checkpoint,
      exit_category: category,
      runtime_ms: Math.max(0, Math.trunc(this.now() - this.startedAtMs)),
      usage: sanitized.usage,
      ...(sanitized.pricing === undefined ? {} : { pricing: sanitized.pricing }),
      diagnostic_code:
        diagnosticCode !== undefined && WORKER_DIAGNOSTIC_CODES.includes(diagnosticCode)
          ? diagnosticCode
          : DIAGNOSTIC_CODES[category]
    };
  }
}

export type WorkerResultWriteGuard = <T>(write: () => Promise<T>) => Promise<T>;

function sanitizedSnapshot(snapshot: WorkerCheckpointSnapshot): WorkerCheckpointSnapshot {
  const digest = snapshot.checkpoint.digest;
  const pricing = sanitizePricing(snapshot.pricing);
  return {
    counts: {
      succeeded: nonNegativeInteger(snapshot.counts.succeeded),
      failed: nonNegativeInteger(snapshot.counts.failed),
      remaining: nonNegativeInteger(snapshot.counts.remaining)
    },
    checkpoint: {
      age_ms: nonNegativeIntegerOrNull(snapshot.checkpoint.age_ms),
      digest: typeof digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(digest) ? digest : null
    },
    usage: sanitizeUsage(snapshot.usage),
    ...(pricing === undefined ? {} : { pricing })
  };
}

function sanitizeUsage(usage: AggregateUsage | null): AggregateUsage | null {
  if (usage === null) return null;
  return {
    input_tokens: nonNegativeInteger(usage.input_tokens),
    output_tokens: nonNegativeInteger(usage.output_tokens),
    cache_read_tokens: nonNegativeInteger(usage.cache_read_tokens),
    cache_write_tokens: nonNegativeInteger(usage.cache_write_tokens),
    reasoning_tokens: nonNegativeInteger(usage.reasoning_tokens),
    total_tokens: nonNegativeInteger(usage.total_tokens),
    estimated_cost_usd: nonNegativeNumber(usage.estimated_cost_usd),
    partial_pricing: usage.partial_pricing === true,
    event_count: nonNegativeInteger(usage.event_count),
    priced_event_count: nonNegativeInteger(usage.priced_event_count),
    unpriced_event_count: nonNegativeInteger(usage.unpriced_event_count)
  };
}

function sanitizePricing(pricing: PricingProvenance | undefined): PricingProvenance | undefined {
  if (pricing === undefined) return undefined;
  const source = pricing.source;
  const status = pricing.status;
  if (
    (source !== "models.dev" && source !== "configured-catalog" && source !== "disabled") ||
    (status !== "available" && status !== "disabled" && status !== "unavailable")
  ) {
    return undefined;
  }
  const fetchedAt = canonicalTimestamp(pricing.fetched_at);
  return {
    source,
    status,
    ...(fetchedAt === undefined ? {} : { fetched_at: fetchedAt }),
    resolved_model_count: nonNegativeInteger(pricing.resolved_model_count),
    unresolved_model_count: nonNegativeInteger(pricing.unresolved_model_count)
  };
}

export async function runWithTerminalPersistence(input: {
  writer: WorkerResultWriter;
  snapshot: () => Promise<WorkerCheckpointSnapshot>;
  flush: () => Promise<void>;
  run: () => Promise<TerminalCompletionCategory>;
  diagnosticCodeForError?: (error: unknown) => WorkerDiagnosticCode | undefined;
}): Promise<TerminalCompletionCategory> {
  let category: Exclude<OperationalDispositionCategory, "live"> = "sandbox-exited";
  let workerFailure: unknown;
  let finalizationFailure: unknown;
  try {
    category = await input.run();
  } catch (error) {
    workerFailure = error;
    category = operationalDispositionForError(error);
  } finally {
    let snapshot = emptyWorkerCheckpoint();
    try {
      snapshot = await input.snapshot();
    } catch (error) {
      finalizationFailure = error;
      if (workerFailure === undefined) category = "unreachable";
    }
    let terminalWriteFailed = false;
    try {
      const diagnosticCode = workerFailure === undefined ? undefined : input.diagnosticCodeForError?.(workerFailure);
      await input.writer.writeTerminal(namedFaultDisposition(category, diagnosticCode), snapshot, diagnosticCode);
    } catch (error) {
      terminalWriteFailed = true;
      finalizationFailure ??= error;
    }
    let flushFailed = false;
    try {
      await input.flush();
    } catch (error) {
      flushFailed = true;
      finalizationFailure ??= error;
    }
    if (terminalWriteFailed || flushFailed) {
      try {
        await input.writer.writeTerminal("unreachable", snapshot);
      } catch (error) {
        finalizationFailure ??= error;
      }
      try {
        await input.flush();
      } catch (error) {
        finalizationFailure ??= error;
      }
    }
  }
  if (workerFailure !== undefined) throw workerFailure;
  if (finalizationFailure !== undefined) {
    throw new OperationalDispositionError("unreachable", { cause: finalizationFailure });
  }
  return category as TerminalCompletionCategory;
}

/**
 * The exit category to record for a failure the worker named itself.
 *
 * `sandbox-exited` is what `operationalDispositionForError` falls back to for an
 * error that declared no disposition, so it is the one category that is never a
 * determination. Pairing it with a diagnostic code the worker chose claims a
 * sandbox death that demonstrably did not happen -- the worker was alive enough
 * to name the fault and to write this very contract. Run 31171579070 reported
 * `sandbox-exited` with `public-eval-diagnostics-invalid` seconds after its eval
 * command returned normally (#320).
 *
 * A named fault therefore records `unreachable`: the worker's own operation
 * failed. `sandbox-exited` keeps its literal meaning -- the worker died without
 * naming a cause -- so a contract that carries it always carries the matching
 * `sandbox-exited` diagnostic code.
 */
function namedFaultDisposition(
  category: Exclude<OperationalDispositionCategory, "live">,
  diagnosticCode: WorkerDiagnosticCode | undefined
): Exclude<OperationalDispositionCategory, "live"> {
  return diagnosticCode !== undefined && category === "sandbox-exited" ? "unreachable" : category;
}

export async function readWorkerCheckpoint(projectRoot: string, nowMs = Date.now()): Promise<WorkerCheckpointSnapshot> {
  const runsRoot = path.join(projectRoot, ".ultrafuzz", "runs");
  const runs = await readdirIfExists(runsRoot);
  for (const run of runs.sort().reverse()) {
    const runRoot = path.join(runsRoot, run);
    const statePath = path.join(runRoot, "state.json");
    try {
      const [contents, stateStats] = await Promise.all([readFile(statePath), stat(statePath)]);
      const state = record(JSON.parse(contents.toString("utf8")));
      const nodes = record(state?.nodes);
      if (nodes === undefined) continue;
      const metadata = await readJsonRecord(path.join(runRoot, "run.json"));
      const pricing = pricingProvenance(metadata);
      return {
        counts: aggregateCounts(nodes),
        checkpoint: {
          age_ms: Math.max(0, Math.trunc(nowMs - stateStats.mtimeMs)),
          digest: `sha256:${crypto.createHash("sha256").update(contents).digest("hex")}`
        },
        usage: aggregateUsage(metadata),
        ...(pricing === undefined ? {} : { pricing })
      };
    } catch (error) {
      if (!isNodeError(error, "ENOENT") && !(error instanceof SyntaxError)) throw error;
      // A missing or mid-write checkpoint is reported as unavailable, never copied into the result.
    }
  }
  return emptyWorkerCheckpoint();
}

export function emptyWorkerCheckpoint(): WorkerCheckpointSnapshot {
  return {
    counts: { ...EMPTY_SNAPSHOT.counts },
    checkpoint: { ...EMPTY_SNAPSHOT.checkpoint },
    usage: null
  };
}

async function writeJsonAtomic(filePath: string, value: WorkerResultContract): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`
  );
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    const tempHandle = await open(tempPath, "r");
    try {
      await tempHandle.sync();
    } finally {
      await tempHandle.close();
    }
    await rename(tempPath, filePath);
    const directoryHandle = await open(path.dirname(filePath), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function persistedGeneration(filePath: string): Promise<number> {
  const value = await readJsonRecord(filePath);
  const generation = value?.generation;
  return typeof generation === "number" && Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
}

async function persistedGenerationFloor(filePath: string): Promise<number> {
  try {
    const value = record(JSON.parse(await readFile(filePath, "utf8")));
    const generation = value?.generation;
    if (typeof generation === "number" && Number.isSafeInteger(generation) && generation >= 0) return generation;
    throw new Error("persisted result generation floor is invalid");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return 0;
    if (error instanceof SyntaxError) throw new Error("persisted result generation floor is invalid", { cause: error });
    throw error;
  }
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return record(JSON.parse(await readFile(filePath, "utf8")));
  } catch {
    return undefined;
  }
}

async function readdirIfExists(directoryPath: string): Promise<string[]> {
  try {
    return await readdir(directoryPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function aggregateCounts(nodes: Record<string, unknown>): AggregateCounts {
  const logical = new Map<string, string[]>();
  for (const [nodeId, value] of Object.entries(nodes)) {
    const node = record(value);
    if (node === undefined) continue;
    const status = node.status;
    if (typeof status !== "string") continue;
    const logicalId = checkpointLogicalId(nodeId, node);
    logical.set(logicalId, [...(logical.get(logicalId) ?? []), status]);
  }

  let succeeded = 0;
  let failed = 0;
  let remaining = 0;
  for (const statuses of logical.values()) {
    if (statuses.some((status) => FAILED_STATUSES.has(status))) failed += 1;
    else if (statuses.every((status) => SUCCEEDED_STATUSES.has(status))) succeeded += 1;
    else remaining += 1;
  }
  return { succeeded, failed, remaining };
}

function checkpointLogicalId(nodeId: string, node: Record<string, unknown>): string {
  for (const field of ["logical_id", "logical_node_id"] as const) {
    const value = node[field];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return nodeId;
}

function aggregateUsage(metadata: Record<string, unknown> | undefined): AggregateUsage | null {
  const accounting = record(metadata?.accounting);
  const summary = record(accounting?.cumulative) ?? record(accounting?.current);
  if (summary === undefined) return null;
  return {
    input_tokens: nonNegativeInteger(summary.input_tokens),
    output_tokens: nonNegativeInteger(summary.output_tokens),
    cache_read_tokens: nonNegativeInteger(summary.cache_read_tokens),
    cache_write_tokens: nonNegativeInteger(summary.cache_write_tokens),
    reasoning_tokens: nonNegativeInteger(summary.reasoning_tokens),
    total_tokens: nonNegativeInteger(summary.total_tokens),
    estimated_cost_usd: nonNegativeNumber(summary.estimated_spend_usd),
    partial_pricing: summary.partial_pricing === true,
    event_count: nonNegativeInteger(summary.event_count),
    priced_event_count: nonNegativeInteger(summary.priced_event_count),
    unpriced_event_count: nonNegativeInteger(summary.unpriced_event_count)
  };
}

function pricingProvenance(metadata: Record<string, unknown> | undefined): PricingProvenance | undefined {
  const catalog = record(record(metadata?.accounting)?.pricing_catalog);
  if (catalog === undefined) return undefined;
  const source = catalog.source;
  const status = catalog.status;
  if (
    (source !== "models.dev" && source !== "configured-catalog" && source !== "disabled") ||
    (status !== "available" && status !== "disabled" && status !== "unavailable")
  ) {
    return undefined;
  }
  const fetchedAt = canonicalTimestamp(catalog.fetched_at);
  return {
    source,
    status,
    ...(fetchedAt === undefined ? {} : { fetched_at: fetchedAt }),
    resolved_model_count: stringArrayLength(catalog.resolved_models),
    unresolved_model_count: stringArrayLength(catalog.unresolved_models)
  };
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function stringArrayLength(value: unknown): number {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string").length : 0;
}

function canonicalTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  const canonical = new Date(parsed).toISOString();
  return canonical === value ? canonical : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
