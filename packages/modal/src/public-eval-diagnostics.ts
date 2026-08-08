import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { assertRegularFileInside } from "@ultrafuzz/artifacts";
import {
  MAX_PUBLIC_EVAL_FAILED_NODES_PER_ROW,
  MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES,
  PUBLIC_EVAL_FAILED_NODE_STATUSES,
  PUBLIC_EVAL_FAILURE_CATEGORIES,
  PUBLIC_EVAL_FAILURE_CODES,
  PUBLIC_EVAL_DIAGNOSTICS_SCHEMA_VERSION,
  comparePublicEvalDiagnosticIds,
  parsePublicEvalDiagnostics,
  publicEvalDiagnosticsReadinessReasonCodes,
  resolveTerminalReportPath,
  summarizePublicEvalDiagnosticsRows,
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
const workflowId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u);
const workflowStatus = z.enum([
  "pending",
  "running",
  "paused",
  "succeeded",
  "failed",
  "timed-out",
  "canceled",
  "unavailable"
]);
const finalStatus = z.enum([...workflowStatus.options, "launched"]);
const terminalDisposition = z.enum([
  "clean",
  "genuine-task-failures",
  "incomplete",
  "operational-failure",
  "unavailable"
]);

const matrixRowInputSchema = z.looseObject({
  id: safeId,
  target_id: safeId,
  variant_id: safeId,
  trial_id: safeId
});
const diagnosticInputSchema = z.looseObject({ code: z.unknown() });
const workflowInputSchema = z.looseObject({
  status: z.unknown(),
  terminal: z.unknown()
});
const recordInputSchema = z.looseObject({
  row_id: safeId,
  target_id: safeId,
  variant_id: safeId,
  trial_id: safeId,
  status: z.enum(["launched", "failed", "missing"]),
  final_status: z.unknown().optional(),
  workflow_ids: z.array(workflowId).max(32),
  workflow: workflowInputSchema.optional(),
  diagnostics: z.array(diagnosticInputSchema).max(64),
  ultrafuzz_run_root: z.string().optional(),
  report_json_path: z.string().optional()
});
// An eval that stopped before recording any row leaves no records at all. Every
// planned row is then reported as `run_status: "missing"`, so the document still
// describes the run rather than refusing to exist. The matrix itself still has to
// be non-empty: a benchmark that planned nothing is an integrity failure, and an
// empty row set would summarize as scoring-ready.
const runSummaryInputSchema = z.looseObject({ records: z.array(recordInputSchema).max(MAX_ROWS) });
const failedNodeStatus = z.enum(PUBLIC_EVAL_FAILED_NODE_STATUSES);
const failureCategory = z.enum(PUBLIC_EVAL_FAILURE_CATEGORIES);
const failureCode = z.enum(PUBLIC_EVAL_FAILURE_CODES);
const failedNodeInputSchema = z.looseObject({
  node_id: safeId,
  status: failedNodeStatus,
  timed_out: z.boolean(),
  provenance: z.unknown().optional()
});
const runStateInputSchema = z.looseObject({ nodes: z.record(z.string(), z.unknown()) });

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
  const matrix = readBoundedJson(path.join(evalRoot, "matrix.json"), evalRoot, "matrix");
  const runSummary = readDiagnosticRunSummary(evalRoot, matrix);
  const result = createPublicEvalDiagnostics({
    config: input.config,
    model: input.model,
    lineage: input.lineage,
    evalRunId: input.evalRunId,
    matrix,
    runSummary,
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
  createdAt?: string;
}): PublicEvalDiagnostics {
  const matrix = z.array(matrixRowInputSchema).min(1).max(MAX_ROWS).parse(input.matrix);
  const runSummary = runSummaryInputSchema.parse(input.runSummary);
  const matrixIds = new Set(matrix.map((row) => row.id));
  if (matrixIds.size !== matrix.length) throw new Error("public eval diagnostics matrix contains duplicate rows");
  const recordsByRow = new Map(runSummary.records.map((record) => [record.row_id, record]));
  // A duplicated record, or one for a row the matrix never planned, is a lineage
  // integrity failure and stays fatal. A planned row with no record is not: it is
  // what an eval that stopped early leaves behind, and `run_status: "missing"`
  // with the `run-record-missing` reason code exists to describe exactly that.
  if (recordsByRow.size !== runSummary.records.length || [...recordsByRow].some(([rowId]) => !matrixIds.has(rowId))) {
    throw new Error("public eval diagnostics row set does not match the matrix");
  }

  const rows = matrix.map((matrixRow): PublicEvalDiagnosticsRow => {
    const record = recordsByRow.get(matrixRow.id);
    if (record === undefined) {
      const readiness = {
        run_status: "missing",
        final_status: "unavailable",
        workflow_status: "unavailable",
        workflow_terminal: false,
        terminal_disposition: "unavailable",
        terminal_report_present: false,
        workflow_ids: []
      } as const satisfies Pick<
        PublicEvalDiagnosticsRow,
        | "run_status"
        | "final_status"
        | "workflow_status"
        | "workflow_terminal"
        | "terminal_disposition"
        | "terminal_report_present"
        | "workflow_ids"
      >;
      return {
        row_id: matrixRow.id,
        target_id: matrixRow.target_id,
        variant_id: matrixRow.variant_id,
        trial_id: matrixRow.trial_id,
        ...readiness,
        workflow_ids: [],
        diagnostic_codes: [],
        failed_nodes: [],
        scoring_ready: false,
        reason_codes: publicEvalDiagnosticsReadinessReasonCodes(readiness)
      };
    }
    if (
      record.target_id !== matrixRow.target_id ||
      record.variant_id !== matrixRow.variant_id ||
      record.trial_id !== matrixRow.trial_id
    ) {
      throw new Error(`public eval diagnostics row identity does not match the matrix: ${matrixRow.id}`);
    }
    const normalizedWorkflowStatus = normalizeWorkflowStatus(record.workflow?.status);
    const normalizedFinalStatus = normalizeFinalStatus(record.final_status);
    const workflowTerminal = record.workflow?.terminal === true;
    const normalizedTerminalDisposition = publicEvalRecordTerminalDisposition(record as unknown as EvalRunRecord);
    const terminalReportPresent = hasTerminalReport(record as unknown as EvalRunRecord);
    const readiness = {
      run_status: record.status,
      final_status: normalizedFinalStatus,
      workflow_status: normalizedWorkflowStatus,
      workflow_terminal: workflowTerminal,
      terminal_disposition: normalizedTerminalDisposition,
      terminal_report_present: terminalReportPresent,
      workflow_ids: record.workflow_ids
    };
    const reasons = publicEvalDiagnosticsReadinessReasonCodes(readiness);
    const diagnosticCodes = [
      ...new Set(
        record.diagnostics.map((diagnostic) =>
          safeId.safeParse(diagnostic.code).success ? String(diagnostic.code) : "unavailable"
        )
      )
    ].sort();
    return {
      row_id: matrixRow.id,
      target_id: matrixRow.target_id,
      variant_id: matrixRow.variant_id,
      trial_id: matrixRow.trial_id,
      run_status: record.status,
      final_status: normalizedFinalStatus,
      workflow_status: normalizedWorkflowStatus,
      workflow_terminal: workflowTerminal,
      terminal_disposition: normalizedTerminalDisposition,
      terminal_report_present: terminalReportPresent,
      workflow_ids: [...new Set(record.workflow_ids)].sort(),
      diagnostic_codes: diagnosticCodes,
      failed_nodes: publicEvalFailedNodes(record as unknown as EvalRunRecord),
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

function normalizeWorkflowStatus(value: unknown): z.infer<typeof workflowStatus> {
  return workflowStatus.safeParse(value).success ? (value as z.infer<typeof workflowStatus>) : "unavailable";
}

function normalizeFinalStatus(value: unknown): z.infer<typeof finalStatus> {
  return finalStatus.safeParse(value).success ? (value as z.infer<typeof finalStatus>) : "unavailable";
}

export function publicEvalRecordTerminalDisposition(
  record: Pick<EvalRunRecord, "ultrafuzz_run_root">
): z.infer<typeof terminalDisposition> {
  if (record.ultrafuzz_run_root === undefined) return "unavailable";
  return terminalDisposition.parse(inspectTerminalDispositionAtRunRoot(record.ultrafuzz_run_root).kind);
}

function hasTerminalReport(record: EvalRunRecord): boolean {
  const resolution = resolveTerminalReportPath({
    ...(record.ultrafuzz_run_root === undefined ? {} : { runRoot: record.ultrafuzz_run_root }),
    ...(record.report_json_path === undefined ? {} : { recordedPath: record.report_json_path })
  });
  if (resolution.path === undefined || record.ultrafuzz_run_root === undefined) return false;
  try {
    assertRegularFileInside(record.ultrafuzz_run_root, resolution.path, "public eval terminal report");
    return true;
  } catch {
    return false;
  }
}

function publicEvalFailedNodes(record: Pick<EvalRunRecord, "ultrafuzz_run_root">): PublicEvalFailedNode[] {
  if (record.ultrafuzz_run_root === undefined) return [];
  try {
    const statePath = path.join(record.ultrafuzz_run_root, "state.json");
    assertRegularFileInside(record.ultrafuzz_run_root, statePath, "public eval run state");
    const stat = fs.statSync(statePath);
    if (stat.size > MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES) return [];
    const state = runStateInputSchema.parse(JSON.parse(fs.readFileSync(statePath, "utf8")) as unknown);
    const failedNodes: PublicEvalFailedNode[] = [];
    for (const [nodeId, value] of Object.entries(state.nodes)) {
      const parsed = failedNodeInputSchema.safeParse(value);
      if (!parsed.success || parsed.data.node_id !== nodeId) continue;
      const provenance = recordValue(parsed.data.provenance);
      const failure = recordValue(provenance?.failure);
      const disposition = recordValue(provenance?.terminal_disposition);
      const category = failureCategory.safeParse(failure?.category);
      const code = failureCode.safeParse(
        disposition?.schema_version === "ultrafuzz.terminal-disposition.v1" ? disposition.kind : undefined
      );
      failedNodes.push({
        node_id: parsed.data.node_id,
        status: parsed.data.status,
        timed_out: parsed.data.timed_out,
        ...(category.success ? { failure_category: category.data } : {}),
        ...(code.success ? { failure_code: code.data } : {})
      });
    }
    return failedNodes
      .filter((node) => node.timed_out === (node.status === "timed-out"))
      .sort((left, right) => comparePublicEvalDiagnosticIds(left.node_id, right.node_id))
      .slice(0, MAX_PUBLIC_EVAL_FAILED_NODES_PER_ROW);
  } catch {
    return [];
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readBoundedJson(filePath: string, root: string, label: string): unknown {
  assertRegularFileInside(root, filePath, `public eval ${label}`);
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES) throw new Error(`public eval ${label} exceeds the size limit`);
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

function readDiagnosticRunSummary(evalRoot: string, matrixValue: unknown): unknown {
  const summaryPath = path.join(evalRoot, "run-summary.json");
  if (fs.existsSync(summaryPath)) return readBoundedJson(summaryPath, evalRoot, "run summary");

  const matrix = z.array(matrixRowInputSchema).min(1).max(MAX_ROWS).parse(matrixValue);
  const recordsByRow = new Map<string, z.infer<typeof recordInputSchema>>();
  const journalPath = path.join(evalRoot, "runs.jsonl");
  if (fs.existsSync(journalPath)) {
    assertRegularFileInside(evalRoot, journalPath, "public eval run journal");
    const stat = fs.statSync(journalPath);
    if (stat.size > MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES) {
      throw new Error("public eval run journal exceeds the size limit");
    }
    for (const line of fs.readFileSync(journalPath, "utf8").split(/\r?\n/u).filter(Boolean)) {
      const record = recordInputSchema.parse(JSON.parse(line) as unknown);
      recordsByRow.set(record.row_id, record);
    }
  }
  const matrixIds = new Set(matrix.map((row) => row.id));
  if ([...recordsByRow].some(([rowId]) => !matrixIds.has(rowId))) {
    throw new Error("public eval run journal contains a row outside the matrix");
  }
  return {
    records: matrix.map(
      (row) =>
        recordsByRow.get(row.id) ?? {
          row_id: row.id,
          target_id: row.target_id,
          variant_id: row.variant_id,
          trial_id: row.trial_id,
          status: "missing",
          final_status: "unavailable",
          workflow_ids: [],
          diagnostics: [{ code: "EVAL_ROW_RECORD_MISSING" }]
        }
    )
  };
}
