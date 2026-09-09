import { z } from "zod/v4";

import { MAX_REPORT_COMPLETION_INCOMPLETE_NODES, REPORT_INCOMPLETE_NODE_OUTCOMES } from "./report-completion.js";
import { NODE_REFERENCE_PATTERN } from "./safe-paths.js";

export const REPORT_VERIFICATION_REASON_CODES = [
  "verification-unavailable",
  "record-missing",
  "record-invalid",
  "result-unreadable",
  "result-not-reviewed",
  "results-truncated"
] as const;
export const MAX_REPORT_UNREVIEWED_FINDINGS = 256;
export const MAX_REPORT_UNREVIEWED_SOURCE_PATH_CHARS = 1_024;
export const MAX_REPORT_UNREVIEWED_TITLE_CHARS = 512;
export const MAX_REPORT_UNREVIEWED_DESCRIPTION_CHARS = 4_000;

/** Descriptive report metadata only; this never authorizes execution or artifact admission. */
export const reportVerificationSchema = z.strictObject({
  status: z.literal("not-checked"),
  reason_codes: z
    .array(z.enum(REPORT_VERIFICATION_REASON_CODES))
    .min(1)
    .max(REPORT_VERIFICATION_REASON_CODES.length)
    .meta({ uniqueItems: true })
    .refine((values) => new Set(values).size === values.length, { message: "Reason codes must be unique" })
});

const observedCount = z.number().int().nonnegative().nullable();

/** Saved observations can be incomplete or inconsistent; null means the count is unknown. */
export const reportObservedCompletionSchema = z.strictObject({
  outcome: z.literal("partial"),
  counts: z.strictObject({
    planned: observedCount,
    succeeded: observedCount,
    failed: observedCount,
    timed_out: observedCount,
    skipped: observedCount,
    cancelled: observedCount,
    unverified: observedCount
  }),
  incomplete_nodes: z
    .array(
      z.strictObject({
        node_id: z.string().regex(NODE_REFERENCE_PATTERN),
        outcome: z.enum(REPORT_INCOMPLETE_NODE_OUTCOMES)
      })
    )
    .max(MAX_REPORT_COMPLETION_INCOMPLETE_NODES)
    .optional(),
  incomplete_nodes_omitted: observedCount.optional()
});

export const reportUnreviewedFindingSchema = z.strictObject({
  source_path: z.string().min(1).max(MAX_REPORT_UNREVIEWED_SOURCE_PATH_CHARS),
  title: z.string().min(1).max(MAX_REPORT_UNREVIEWED_TITLE_CHARS),
  description: z.string().min(1).max(MAX_REPORT_UNREVIEWED_DESCRIPTION_CHARS)
});
export const reportUnreviewedFindingsSchema = z
  .array(reportUnreviewedFindingSchema)
  .max(MAX_REPORT_UNREVIEWED_FINDINGS);

export type ReportVerification = z.infer<typeof reportVerificationSchema>;
export type ReportVerificationReasonCode = ReportVerification["reason_codes"][number];
export type ReportObservedCompletion = z.infer<typeof reportObservedCompletionSchema>;
export type ReportUnreviewedFinding = z.infer<typeof reportUnreviewedFindingSchema>;
export type ObservedReportCompletion = ReportObservedCompletion;
export type UnreviewedReportFinding = ReportUnreviewedFinding;
