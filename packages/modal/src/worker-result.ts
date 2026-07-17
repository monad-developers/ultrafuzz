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
  "counts",
  "checkpoint",
  "exit_category",
  "runtime_ms",
  "usage",
  "pricing",
  "diagnostic_code"
] as const;

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
  counts: AggregateCounts;
  checkpoint: CheckpointMetadata;
  exit_category: OperationalDispositionCategory;
  runtime_ms: number;
  usage: AggregateUsage | null;
  pricing?: PricingProvenance;
  diagnostic_code: string;
}

type TerminalCompletionCategory = Extract<OperationalDispositionCategory, "finished" | "genuine-evaluation-failure">;

const SUCCEEDED_STATUSES = new Set(["succeeded", "reused-from-prior-run"]);
const FAILED_STATUSES = new Set(["failed", "timed-out", "invalidated", "skipped"]);
const EMPTY_SNAPSHOT: WorkerCheckpointSnapshot = {
  counts: { succeeded: 0, failed: 0, remaining: 0 },
  checkpoint: { age_ms: null, digest: null },
  usage: null
};

const DIAGNOSTIC_CODES: Record<OperationalDispositionCategory, string> = {
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
    generation: number
  ) {
    this.generation = generation;
  }

  static async create(input: {
    statusPath: string;
    resultPath: string;
    startedAtMs?: number;
    now?: () => number;
  }): Promise<WorkerResultWriter> {
    const now = input.now ?? Date.now;
    const generation = Math.max(
      await persistedGeneration(input.statusPath),
      await persistedGeneration(input.resultPath)
    );
    return new WorkerResultWriter(input.statusPath, input.resultPath, input.startedAtMs ?? now(), now, generation);
  }

  async writePartial(snapshot: WorkerCheckpointSnapshot): Promise<WorkerResultContract> {
    return this.enqueue(async () => {
      const contract = this.contract("partial", "live", snapshot);
      await writeJsonAtomic(this.statusPath, contract);
      return contract;
    });
  }

  async writeTerminal(
    category: Exclude<OperationalDispositionCategory, "live">,
    snapshot: WorkerCheckpointSnapshot
  ): Promise<WorkerResultContract> {
    return this.enqueue(async () => {
      const contract = this.contract("terminal", category, snapshot);
      await writeJsonAtomic(this.resultPath, contract);
      await writeJsonAtomic(this.statusPath, contract);
      return contract;
    });
  }

  private enqueue<T>(write: () => Promise<T>): Promise<T> {
    const queued = this.pendingWrite.then(write, write);
    this.pendingWrite = queued.then(
      () => undefined,
      () => undefined
    );
    return queued;
  }

  private contract(
    resultType: WorkerResultContract["result_type"],
    category: OperationalDispositionCategory,
    snapshot: WorkerCheckpointSnapshot
  ): WorkerResultContract {
    this.generation += 1;
    const sanitized = sanitizedSnapshot(snapshot);
    return {
      schema_version: WORKER_RESULT_SCHEMA_VERSION,
      result_type: resultType,
      generation: this.generation,
      counts: sanitized.counts,
      checkpoint: sanitized.checkpoint,
      exit_category: category,
      runtime_ms: Math.max(0, Math.trunc(this.now() - this.startedAtMs)),
      usage: sanitized.usage,
      ...(sanitized.pricing === undefined ? {} : { pricing: sanitized.pricing }),
      diagnostic_code: DIAGNOSTIC_CODES[category]
    };
  }
}

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
    try {
      await input.writer.writeTerminal(category, snapshot);
    } catch (error) {
      finalizationFailure ??= error;
    }
    try {
      await input.flush();
    } catch (error) {
      finalizationFailure ??= error;
    }
  }
  if (workerFailure !== undefined) throw workerFailure;
  if (finalizationFailure !== undefined) {
    throw new OperationalDispositionError("unreachable", { cause: finalizationFailure });
  }
  return category as TerminalCompletionCategory;
}

export async function readWorkerCheckpoint(projectRoot: string, nowMs = Date.now()): Promise<WorkerCheckpointSnapshot> {
  const runsRoot = path.join(projectRoot, ".ultrafuzz", "runs");
  for (const run of (await readdir(runsRoot).catch(() => [])).sort().reverse()) {
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
    } catch {
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

async function readJsonRecord(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return record(JSON.parse(await readFile(filePath, "utf8")));
  } catch {
    return undefined;
  }
}

function aggregateCounts(nodes: Record<string, unknown>): AggregateCounts {
  let succeeded = 0;
  let failed = 0;
  let remaining = 0;
  for (const value of Object.values(nodes)) {
    const status = record(value)?.status;
    if (typeof status !== "string") continue;
    if (SUCCEEDED_STATUSES.has(status)) succeeded += 1;
    else if (FAILED_STATUSES.has(status)) failed += 1;
    else remaining += 1;
  }
  return { succeeded, failed, remaining };
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
