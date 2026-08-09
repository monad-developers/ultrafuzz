import {
  publishFileDurableExclusive,
  readStrictJsonlSnapshot,
  type DurablePublicationResult,
  type StrictJsonlCodec
} from "@ultrafuzz/artifacts";
import { z } from "zod/v4";

import {
  EVMBENCH_RESULT_VERSION,
  evmbenchOperationalMetricsSchema,
  evmbenchRunProvenanceSchema,
  evmbenchSafeIdSchema,
  parseNormalizedEvmbenchResultBytes,
  serializeNormalizedEvmbenchResult,
  type EvmbenchOperationalMetrics,
  type EvmbenchRunProvenance,
  type NormalizedEvmbenchResult
} from "./contracts.js";
import { assertEvmbenchJsonSchema } from "./schema-registry.js";
import { assertEvmbenchDocumentSemantics } from "./semantic-gates.js";

export const NANOEVAL_FINAL_REPORT_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:evmbench:nanoeval-final-report:1" as const;
export const NANOEVAL_RECORD_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:evmbench:nanoeval-record:1" as const;

const jsonValueSchema = z.json();
const recorderIdSchema = z.string().min(1).max(1024);
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const commonRecorderFields = {
  timestamp: z.string().datetime({ offset: true }),
  sample_id: recorderIdSchema.nullable(),
  group_id: recorderIdSchema.nullable()
} as const;

export const nanoevalPerAuditMetricsSchema = z
  .object({
    score: z.number().nonnegative(),
    max_score: z.number().positive(),
    n_runs: positiveSafeIntegerSchema,
    detect_award: z.number().nonnegative(),
    detect_max_award: z.number().nonnegative()
  })
  .strict();

export const nanoevalMetricsSchema = z
  .object({
    score: z.number().nonnegative(),
    max_score: z.number().positive(),
    score_percentage: z.number().min(0).max(100),
    per_audit: z
      .record(evmbenchSafeIdSchema, nanoevalPerAuditMetricsSchema)
      .refine((perAudit) => Object.keys(perAudit).length > 0, "per_audit must not be empty"),
    detect_award: z.number().nonnegative(),
    detect_max_award: z.number().nonnegative(),
    detect_score_percentage: z.number().min(0).max(100)
  })
  .strict();

export const nanoevalFinalReportSchema = z
  .object({
    params: z
      .object({
        audit_split: evmbenchSafeIdSchema,
        mode: z.literal("detect"),
        n_tries: positiveSafeIntegerSchema,
        n_samples: positiveSafeIntegerSchema,
        agent: z.enum(["ultrafuzz", "human"])
      })
      .strict(),
    run_health: z.object({ n_rollouts_failed: nonNegativeSafeIntegerSchema }).strict(),
    metrics: nanoevalMetricsSchema,
    run_group_id: evmbenchSafeIdSchema,
    partial: z.literal(true).optional()
  })
  .strict();

const nanoevalRunStartedRecordSchema = z
  .object({
    ...commonRecorderFields,
    record_type: z.literal("run_started"),
    sample_id: z.null(),
    group_id: z.null(),
    run_spec: z.object({ run_id: recorderIdSchema, run_set_id: recorderIdSchema }).strict()
  })
  .strict();
const nanoevalSamplingRecordSchema = z
  .object({
    ...commonRecorderFields,
    record_type: z.literal("sampling"),
    prompt: z.string(),
    sampled: z.string()
  })
  .strict();
const nanoevalMatchRecordSchema = z
  .object({
    ...commonRecorderFields,
    record_type: z.literal("match"),
    correct: z.boolean(),
    expected: z.null(),
    picked: z.null(),
    prob_correct: z.null()
  })
  .strict();
const nanoevalExtraRecordSchema = z
  .object({
    ...commonRecorderFields,
    record_type: z.literal("extra"),
    data: jsonValueSchema
  })
  .strict();
const nanoevalSampleCompletedRecordSchema = z
  .object({
    ...commonRecorderFields,
    record_type: z.literal("sample_completed"),
    status: z.literal("completed")
  })
  .strict();
const nanoevalErrorRecordSchema = z
  .object({
    ...commonRecorderFields,
    record_type: z.literal("error"),
    message: z
      .string()
      .min(1)
      .max(64 * 1024),
    error: z
      .string()
      .max(1024 * 1024)
      .nullable()
  })
  .strict();
const nanoevalFinalReportRecordSchema = z
  .object({
    ...commonRecorderFields,
    record_type: z.literal("final_report"),
    sample_id: z.null(),
    group_id: z.null(),
    final_report: nanoevalFinalReportSchema
  })
  .strict();

export const nanoevalRecordSchema = z.discriminatedUnion("record_type", [
  nanoevalRunStartedRecordSchema,
  nanoevalSamplingRecordSchema,
  nanoevalMatchRecordSchema,
  nanoevalExtraRecordSchema,
  nanoevalSampleCompletedRecordSchema,
  nanoevalErrorRecordSchema,
  nanoevalFinalReportRecordSchema
]);

export type NanoevalFinalReport = z.infer<typeof nanoevalFinalReportSchema>;
export type NanoevalRecord = z.infer<typeof nanoevalRecordSchema>;

export function parseNanoevalFinalReport(value: unknown, label = "NanoEval final report"): NanoevalFinalReport {
  assertEvmbenchJsonSchema(NANOEVAL_FINAL_REPORT_JSON_SCHEMA_ID, value, label);
  const parsed = nanoevalFinalReportSchema.parse(value);
  assertEvmbenchDocumentSemantics(NANOEVAL_FINAL_REPORT_JSON_SCHEMA_ID, parsed);
  return parsed;
}

export function parseNanoevalRecord(value: unknown, label = "NanoEval record"): NanoevalRecord {
  assertEvmbenchJsonSchema(NANOEVAL_RECORD_JSON_SCHEMA_ID, value, label);
  const parsed = nanoevalRecordSchema.parse(value);
  assertEvmbenchDocumentSemantics(NANOEVAL_RECORD_JSON_SCHEMA_ID, parsed);
  return parsed;
}

export function normalizeEvmbenchResult(input: {
  finalReport: unknown;
  provenance: EvmbenchRunProvenance;
  operational: EvmbenchOperationalMetrics;
}): NormalizedEvmbenchResult {
  const finalReport = parseNanoevalFinalReport(input.finalReport);
  if (finalReport.partial === true) throw new Error("cannot normalize a partial NanoEval final report");
  const provenance = evmbenchRunProvenanceSchema.parse(input.provenance);
  const operational = evmbenchOperationalMetricsSchema.parse(input.operational);
  const metrics = finalReport.metrics;
  const normalized = {
    schema_version: EVMBENCH_RESULT_VERSION,
    official_evmbench: {
      score: metrics.score,
      max_score: metrics.max_score,
      recall: metrics.score / metrics.max_score,
      detect_award: metrics.detect_award,
      detect_max_award: metrics.detect_max_award,
      per_audit: metrics.per_audit
    },
    provenance,
    operational
  } satisfies NormalizedEvmbenchResult;
  return parseNormalizedEvmbenchResultBytes(serializeNormalizedEvmbenchResult(normalized));
}

export function publishNormalizedEvmbenchResult(
  root: string,
  relativePath: string,
  result: NormalizedEvmbenchResult
): DurablePublicationResult {
  const bytes = serializeNormalizedEvmbenchResult(result);
  return publishFileDurableExclusive(root, relativePath, bytes);
}

export function readNanoevalFinalReport(recordFiles: string[]): NanoevalFinalReport {
  if (recordFiles.length === 0) throw new Error("NanoEval did not produce a JSONL record file");
  let finalReport: NanoevalFinalReport | undefined;
  for (const filePath of [...recordFiles].sort()) {
    const snapshot = readStrictJsonlSnapshot(filePath, nanoevalCodec(filePath));
    if (!snapshot.exists || snapshot.records.length === 0) {
      throw new Error(`NanoEval record journal is missing or empty: ${filePath}`);
    }
    for (const record of snapshot.records) {
      if (record.record_type !== "final_report" || record.final_report.partial === true) continue;
      if (finalReport !== undefined) throw new Error("NanoEval recorded more than one non-partial final report");
      finalReport = record.final_report;
    }
  }
  if (finalReport === undefined) throw new Error("NanoEval did not record a non-partial final report");
  return finalReport;
}

function nanoevalCodec(filePath: string): StrictJsonlCodec<NanoevalRecord> {
  return {
    label: `NanoEval record journal ${filePath}`,
    parseRecord(value, recordPath) {
      try {
        return parseNanoevalRecord(value, `NanoEval record ${recordPath}`);
      } catch (error) {
        throw new Error(
          `NanoEval record ${recordPath} violates the pinned recorder contract: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    },
    identity(record) {
      return `${record.timestamp}\u0000${record.record_type}\u0000${record.sample_id ?? ""}\u0000${record.group_id ?? ""}\u0000${JSON.stringify(record)}`;
    },
    validateHistory(records) {
      if (records[0]?.record_type !== "run_started") {
        throw new Error("NanoEval record journal must begin with run_started");
      }
      if (records.slice(1).some((record) => record.record_type === "run_started")) {
        throw new Error("NanoEval record journal contains more than one run_started record");
      }
      let completeFinalSeen = false;
      for (const [index, record] of records.entries()) {
        if (completeFinalSeen) {
          throw new Error(`NanoEval record journal contains data after its final report at record ${index + 1}`);
        }
        if (record.record_type === "final_report" && record.final_report.partial !== true) {
          completeFinalSeen = true;
        }
      }
    },
    maxBytes: 256 * 1024 * 1024,
    maxRecordBytes: 16 * 1024 * 1024,
    maxRecords: 1_000_000
  };
}
