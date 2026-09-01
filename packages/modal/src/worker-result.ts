import crypto from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  parseStrictJsonBytes,
  readRegularFileSnapshot,
  readRunMetadataDocument,
  readRunState,
  type RunAccountingSummary,
  type RunMetadataDocument,
  type RunState
} from "@ultrafuzz/artifacts";

import { MODAL_WORKER_RESULT_SCHEMA_ID } from "./modal-contracts.js";
import { readModalDocument, writeModalDocumentAtomic } from "./modal-documents.js";
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
    const context = this.executionContext();
    return {
      schema_version: WORKER_RESULT_SCHEMA_VERSION,
      result_type: resultType,
      generation: this.generation,
      launch_generation: context.launch_generation,
      attempt: context.attempt,
      model_work_started: context.model_work_started,
      counts: snapshot.counts,
      checkpoint: snapshot.checkpoint,
      exit_category: category,
      runtime_ms: this.now() - this.startedAtMs,
      usage: snapshot.usage,
      ...(snapshot.pricing === undefined ? {} : { pricing: snapshot.pricing }),
      diagnostic_code: diagnosticCode ?? DIAGNOSTIC_CODES[category]
    };
  }
}

export type WorkerResultWriteGuard = <T>(write: () => Promise<T>) => Promise<T>;
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
      const state = readRunState(statePath);
      const metadata = readOptionalRunMetadata(path.join(runRoot, "run.json"), state.run_id);
      const pricing = pricingProvenance(metadata);
      return {
        counts: aggregateCounts(state.nodes),
        checkpoint: {
          age_ms: Math.max(0, Math.trunc(nowMs - stateStats.mtimeMs)),
          digest: `sha256:${crypto.createHash("sha256").update(contents).digest("hex")}`
        },
        usage: aggregateUsage(metadata),
        ...(pricing === undefined ? {} : { pricing })
      };
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
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
  const target = path.resolve(filePath);
  const trustedRoot = path.dirname(target);
  await mkdir(trustedRoot, { recursive: true, mode: 0o700 });
  await writeModalDocumentAtomic(target, MODAL_WORKER_RESULT_SCHEMA_ID, value, { trustedRoot });
}

async function persistedGeneration(filePath: string): Promise<number> {
  try {
    return readModalDocument(filePath, MODAL_WORKER_RESULT_SCHEMA_ID).value.generation;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return 0;
    throw error;
  }
}

async function persistedGenerationFloor(filePath: string): Promise<number> {
  try {
    const parsed = parseStrictJsonBytes(readRegularFileSnapshot(filePath, 4096), {
      maxBytes: 4096,
      maxDepth: 4,
      maxItems: 4,
      maxProperties: 4
    });
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length !== 1) {
      throw new Error("persisted result generation floor is invalid");
    }
    const generation = (parsed as Record<string, unknown>).generation;
    if (typeof generation === "number" && Number.isSafeInteger(generation) && generation >= 0) return generation;
    throw new Error("persisted result generation floor is invalid");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return 0;
    throw new Error("persisted result generation floor is invalid", { cause: error });
  }
}

function readOptionalRunMetadata(filePath: string, expectedRunId: string): RunMetadataDocument | undefined {
  try {
    return readRunMetadataDocument(filePath, expectedRunId);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
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
  if (!(error instanceof Error)) return false;
  if ("code" in error && error.code === code) return true;
  return "cause" in error && isNodeError(error.cause, code);
}

function aggregateCounts(nodes: RunState["nodes"]): AggregateCounts {
  const logical = new Map<string, string[]>();
  for (const [nodeId, node] of Object.entries(nodes)) {
    const status = node.status;
    const logicalId = node.logical_node_id ?? nodeId;
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

function aggregateUsage(metadata: RunMetadataDocument | undefined): AggregateUsage | null {
  const summary = metadata?.accounting?.cumulative;
  if (summary === undefined) return null;
  const components = boundedIndependentUsageComponents(summary);
  const projectedTotal =
    components.input_tokens +
    components.output_tokens +
    components.cache_read_tokens +
    components.cache_write_tokens +
    components.reasoning_tokens;
  if (!Number.isSafeInteger(projectedTotal) || projectedTotal !== summary.total_tokens) {
    throw new Error("run accounting token components do not match the provider-inclusive total");
  }
  return {
    ...components,
    total_tokens: summary.total_tokens,
    estimated_cost_usd: summary.estimated_spend_usd ?? null,
    partial_pricing: summary.partial_pricing,
    event_count: summary.event_count,
    priced_event_count: summary.priced_event_count,
    unpriced_event_count: summary.unpriced_event_count
  };
}

function boundedIndependentUsageComponents(
  summary: RunAccountingSummary
): Pick<
  AggregateUsage,
  "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens" | "reasoning_tokens"
> {
  let inputTokens = Math.min(summary.uncached_input_tokens, summary.input_tokens);
  let remainingInputTokens = summary.input_tokens - inputTokens;
  const cacheReadTokens = Math.min(summary.cache_read_tokens, remainingInputTokens);
  remainingInputTokens -= cacheReadTokens;
  const cacheWriteTokens = Math.min(summary.cache_write_tokens, remainingInputTokens);
  remainingInputTokens -= cacheWriteTokens;
  // accounting.v4 retains contradictory provider breakdowns as incomplete
  // evidence. Attribute any unclassified provider input to the independent
  // input bucket so legacy Modal output stays bounded without changing totals.
  inputTokens += remainingInputTokens;
  const reasoningTokens = Math.min(summary.reasoning_tokens, summary.output_tokens);
  return {
    input_tokens: inputTokens,
    output_tokens: summary.output_tokens - reasoningTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    reasoning_tokens: reasoningTokens
  };
}

function pricingProvenance(metadata: RunMetadataDocument | undefined): PricingProvenance | undefined {
  const catalog = metadata?.accounting?.pricing_catalog;
  if (catalog === undefined) return undefined;
  return {
    source: catalog.source,
    status: catalog.status,
    ...(catalog.fetched_at === undefined ? {} : { fetched_at: catalog.fetched_at }),
    resolved_model_count: catalog.resolved_models.length,
    unresolved_model_count: catalog.unresolved_models.length
  };
}
