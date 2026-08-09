import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { assertRegularFileInside, normalizeNodeAttemptFailureMessage, readRunState } from "@ultrafuzz/artifacts";
import {
  MAX_PUBLIC_EVAL_FAILED_NODES_PER_ROW,
  MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES,
  PUBLIC_EVAL_FAILURE_CATEGORIES,
  PUBLIC_EVAL_FAILURE_CODES,
  PUBLIC_EVAL_DIAGNOSTICS_SCHEMA_VERSION,
  comparePublicEvalDiagnosticIds,
  parseEvalMatrix,
  parseEvalRunSummary,
  parsePublicEvalDiagnostics,
  publicEvalDiagnosticsReadinessReasonCodes,
  readEvalMatrix,
  readEvalRunRecords,
  readEvalRunSummary,
  reconcileEvalRunRecords,
  resolveTerminalReportPath,
  summarizePublicEvalDiagnosticsRows,
  type EvalMatrixRow,
  type EvalRunRecord,
  type PublicEvalDiagnostics,
  type PublicEvalFailedNode,
  type PublicEvalDiagnosticsRow
} from "@ultrafuzz/evals";
import { redactSecretsInText } from "@ultrafuzz/security";
import { z } from "zod/v4";

import type { PublicModalBenchmarkConfig } from "./config.js";
import type { ModalModelSpec } from "./defaults.js";
import type { ModalWorkerLineage } from "./launch-state.js";
import { inspectTerminalDispositionAtRunRoot } from "./terminal-disposition.js";

export {
  MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES,
  PUBLIC_EVAL_DIAGNOSTICS_FILE,
  PUBLIC_EVAL_DIAGNOSTICS_SCHEMA_VERSION,
  parsePublicEvalDiagnostics
} from "@ultrafuzz/evals";
export type { PublicEvalDiagnostics } from "@ultrafuzz/evals";

const MAX_ROWS = 2_048;
const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const failureCategory = z.enum(PUBLIC_EVAL_FAILURE_CATEGORIES);
const failureCode = z.enum(PUBLIC_EVAL_FAILURE_CODES);

export function createPublicEvalDiagnosticsFromRun(input: {
  config: PublicModalBenchmarkConfig;
  model: ModalModelSpec;
  lineage: ModalWorkerLineage;
  controlRoot: string;
  evalRunId: string;
  forbiddenSecretValues?: readonly string[];
  createdAt?: string;
}): PublicEvalDiagnostics {
  const evalRoot = path.join(input.controlRoot, ".ultrafuzz/evals/runs", input.evalRunId);
  const matrix = readEvalMatrix(path.join(evalRoot, "matrix.json"));
  const records = readDiagnosticRunRecords(evalRoot);
  const result = createPublicEvalDiagnosticsFromRecords({
    config: input.config,
    model: input.model,
    lineage: input.lineage,
    evalRunId: input.evalRunId,
    matrix,
    records,
    forbiddenSecretValues: input.forbiddenSecretValues,
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt })
  });
  assertPublicEvalDiagnosticsContainsNoSecrets(result, input.forbiddenSecretValues ?? []);
  return result;
}

export function createPublicEvalDiagnostics(input: {
  config: PublicModalBenchmarkConfig;
  model: ModalModelSpec;
  lineage: ModalWorkerLineage;
  evalRunId: string;
  matrix: unknown;
  runSummary: unknown;
  forbiddenSecretValues?: readonly string[];
  createdAt?: string;
}): PublicEvalDiagnostics {
  const matrix = parseEvalMatrix(input.matrix, "public eval diagnostics matrix");
  const runSummary = parseEvalRunSummary(input.runSummary, "public eval diagnostics run summary");
  if (runSummary.eval_run_id !== input.evalRunId) {
    throw new Error("public eval diagnostics run summary names another eval run");
  }
  return createPublicEvalDiagnosticsFromRecords({ ...input, matrix, records: runSummary.records });
}

function createPublicEvalDiagnosticsFromRecords(input: {
  config: PublicModalBenchmarkConfig;
  model: ModalModelSpec;
  lineage: ModalWorkerLineage;
  evalRunId: string;
  matrix: EvalMatrixRow[];
  records: EvalRunRecord[];
  forbiddenSecretValues?: readonly string[];
  createdAt?: string;
}): PublicEvalDiagnostics {
  if (input.matrix.length === 0 || input.matrix.length > MAX_ROWS) {
    throw new Error(`public eval diagnostics matrix must contain between 1 and ${MAX_ROWS} rows`);
  }
  const matrixIds = new Set(input.matrix.map((row) => row.id));
  const recordsByRow = new Map(input.records.map((record) => [record.row_id, record]));
  if (
    recordsByRow.size !== input.records.length ||
    recordsByRow.size !== input.matrix.length ||
    [...recordsByRow].some(([rowId]) => !matrixIds.has(rowId))
  ) {
    throw new Error("public eval diagnostics row set does not match the matrix");
  }

  const rows = input.matrix.map((matrixRow): PublicEvalDiagnosticsRow => {
    const record = recordsByRow.get(matrixRow.id);
    if (record === undefined) {
      throw new Error(`public eval diagnostics has no durable record for matrix row: ${matrixRow.id}`);
    }
    if (
      record.eval_run_id !== input.evalRunId ||
      record.target_id !== matrixRow.target_id ||
      record.variant_id !== matrixRow.variant_id ||
      record.trial_id !== matrixRow.trial_id
    ) {
      throw new Error(`public eval diagnostics row identity does not match the matrix: ${matrixRow.id}`);
    }
    const workflowStatus: PublicEvalDiagnosticsRow["workflow_status"] = record.workflow?.status ?? "unavailable";
    const finalStatus: PublicEvalDiagnosticsRow["final_status"] = record.final_status ?? "unavailable";
    const workflowTerminal = record.workflow?.terminal === true;
    const terminalDisposition = publicEvalRecordTerminalDisposition(record);
    const terminalReportPresent = hasTerminalReport(record);
    const readiness = {
      run_status: record.status,
      final_status: finalStatus,
      workflow_status: workflowStatus,
      workflow_terminal: workflowTerminal,
      terminal_disposition: terminalDisposition,
      terminal_report_present: terminalReportPresent,
      workflow_ids: record.workflow_ids
    };
    const reasons = publicEvalDiagnosticsReadinessReasonCodes(readiness);
    const diagnosticCodes = [
      ...new Set(record.diagnostics.map((diagnostic) => publicDiagnosticCode(diagnostic.code, record.row_id)))
    ].sort();
    return {
      row_id: matrixRow.id,
      target_id: matrixRow.target_id,
      variant_id: matrixRow.variant_id,
      trial_id: matrixRow.trial_id,
      run_status: record.status,
      final_status: finalStatus,
      workflow_status: workflowStatus,
      workflow_terminal: workflowTerminal,
      terminal_disposition: terminalDisposition,
      terminal_report_present: terminalReportPresent,
      workflow_ids: [...record.workflow_ids].sort(),
      diagnostic_codes: diagnosticCodes,
      failed_nodes: publicEvalFailedNodes(record, input.forbiddenSecretValues ?? []),
      scoring_ready: reasons.length === 0,
      reason_codes: reasons
    };
  });

  const result = parsePublicEvalDiagnostics({
    schema_version: PUBLIC_EVAL_DIAGNOSTICS_SCHEMA_VERSION,
    stage: "post-eval-pre-score",
    benchmark: input.config.public_benchmark.benchmark,
    lane: input.config.public_benchmark.lane,
    model_slug: input.model.slug,
    model: input.model.model,
    reasoning: input.model.reasoning,
    candidate_commit: input.config.public_benchmark.candidate_commit,
    eval_run_id: input.evalRunId,
    created_at: input.createdAt ?? new Date().toISOString(),
    lineage: {
      logical_run_id: input.lineage.logical_run_id,
      generation: input.lineage.generation,
      attempt: input.lineage.attempt,
      attempt_id: input.lineage.attempt_id,
      config_fingerprint: input.lineage.fingerprints.config,
      source_fingerprint: input.lineage.fingerprints.source,
      image_fingerprint: input.lineage.fingerprints.image,
      model_fingerprint: input.lineage.model_fingerprint
    },
    summary: summarizePublicEvalDiagnosticsRows(rows),
    rows
  });
  return result;
}

export function assertPublicEvalDiagnosticsContainsNoSecrets(
  value: PublicEvalDiagnostics,
  forbiddenSecretValues: readonly string[]
): void {
  const text = JSON.stringify(value);
  if ([...new Set(forbiddenSecretValues)].filter(Boolean).some((secret) => text.includes(secret))) {
    throw new Error("public eval diagnostics contains an injected secret value");
  }
  if (redactSecretsInText(text) !== text) {
    throw new Error("public eval diagnostics contains secret-like content");
  }
}

export async function writePublicEvalDiagnosticsAtomic(
  filePath: string,
  diagnostics: PublicEvalDiagnostics
): Promise<void> {
  const parsed = parsePublicEvalDiagnostics(diagnostics);
  const contents = `${JSON.stringify(parsed, null, 2)}\n`;
  if (Buffer.byteLength(contents, "utf8") > MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES) {
    throw new Error("public eval diagnostics exceeds the size limit");
  }
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
    const directory = await open(path.dirname(filePath), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export function publicEvalRecordTerminalDisposition(
  record: Pick<EvalRunRecord, "ultrafuzz_run_id" | "ultrafuzz_run_root">
): PublicEvalDiagnosticsRow["terminal_disposition"] {
  if (record.ultrafuzz_run_root === undefined) return "unavailable";
  readRecordRunState(record);
  return inspectTerminalDispositionAtRunRoot(record.ultrafuzz_run_root).kind;
}

function hasTerminalReport(record: EvalRunRecord): boolean {
  const resolution = resolveTerminalReportPath({
    ...(record.ultrafuzz_run_root === undefined ? {} : { runRoot: record.ultrafuzz_run_root })
  });
  if (resolution.path === undefined || record.ultrafuzz_run_root === undefined) return false;
  try {
    fs.lstatSync(resolution.path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
  assertRegularFileInside(record.ultrafuzz_run_root, resolution.path, "public eval terminal report");
  return true;
}

function publicEvalFailedNodes(
  record: Pick<EvalRunRecord, "ultrafuzz_run_id" | "ultrafuzz_run_root">,
  forbiddenSecretValues: readonly string[]
): PublicEvalFailedNode[] {
  if (record.ultrafuzz_run_root === undefined) return [];
  const state = readRecordRunState(record);
  const failedNodes: PublicEvalFailedNode[] = [];
  for (const value of Object.values(state.nodes)) {
    if (value.status !== "failed" && value.status !== "timed-out") continue;
    const provenance = recordValue(value.provenance);
    const failure = recordValue(provenance?.failure);
    const disposition = recordValue(provenance?.terminal_disposition);
    const category = failureCategory.safeParse(failure?.category);
    const code = failureCode.safeParse(
      disposition?.schema_version === "ultrafuzz.terminal-disposition.v1" ? disposition.kind : undefined
    );
    const message =
      value.last_error === undefined
        ? undefined
        : normalizeNodeAttemptFailureMessage(value.last_error, forbiddenSecretValues);
    failedNodes.push({
      node_id: value.node_id,
      status: value.status,
      timed_out: value.timed_out,
      ...(category.success ? { failure_category: category.data } : {}),
      ...(code.success ? { failure_code: code.data } : {}),
      ...(message === undefined ? {} : { failure_message: message })
    });
  }
  return failedNodes
    .sort((left, right) => comparePublicEvalDiagnosticIds(left.node_id, right.node_id))
    .slice(0, MAX_PUBLIC_EVAL_FAILED_NODES_PER_ROW);
}

function readRecordRunState(record: Pick<EvalRunRecord, "ultrafuzz_run_id" | "ultrafuzz_run_root">) {
  if (record.ultrafuzz_run_root === undefined) {
    throw new Error("public eval run root is unavailable");
  }
  const state = readRunState(path.join(record.ultrafuzz_run_root, "state.json"));
  if (record.ultrafuzz_run_id !== undefined && state.run_id !== record.ultrafuzz_run_id) {
    throw new Error("public eval durable run state names another workflow run");
  }
  return state;
}

function publicDiagnosticCode(value: string, rowId: string): string {
  const parsed = safeId.safeParse(value);
  if (!parsed.success) throw new Error(`public eval row ${rowId} contains an invalid diagnostic code`);
  return parsed.data;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readDiagnosticRunRecords(evalRoot: string): EvalRunRecord[] {
  const summaryPath = path.join(evalRoot, "run-summary.json");
  try {
    fs.lstatSync(summaryPath);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    // The runner materializes runs.jsonl before launching rows, and appends each
    // lifecycle observation before sealing run-summary.json. A watchdog may
    // therefore interrupt the intentional in-progress state between those two
    // writes. Reconcile only canonical journal records; the matrix join below
    // still rejects any row the interruption left unrecorded.
    return [...reconcileEvalRunRecords(readEvalRunRecords(path.join(evalRoot, "runs.jsonl"))).values()];
  }
  return readEvalRunSummary(summaryPath).records;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
