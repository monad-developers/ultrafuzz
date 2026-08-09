import { z } from "zod/v4";

export const ULTRAFUZZ_CLI_RESULT_VERSION = "ultrafuzz.cli.result.v1" as const;

const nonemptyStringSchema = z
  .string()
  .min(1)
  .max(16 * 1024);
const safeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u);
const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const nonnegativeIntegerSchema = z.number().int().nonnegative();

export const evmbenchCliDiagnosticSchema = z
  .object({
    code: nonemptyStringSchema,
    message: nonemptyStringSchema,
    severity: z.enum(["error", "warning", "info"]),
    source: nonemptyStringSchema,
    path: nonemptyStringSchema.optional()
  })
  .strict();

const initDataSchema = z
  .object({
    project_root: nonemptyStringSchema,
    created: z.array(nonemptyStringSchema),
    preserved: z.array(nonemptyStringSchema),
    overwritten: z.array(nonemptyStringSchema)
  })
  .strict();

const runDataSchema = z
  .object({
    run_id: safeIdSchema,
    run_root: nonemptyStringSchema,
    status: nonemptyStringSchema,
    source_run_id: safeIdSchema.optional(),
    graph_fingerprint: fingerprintSchema,
    config_fingerprint: fingerprintSchema,
    workflow_ids: z.array(nonemptyStringSchema).min(1)
  })
  .strict();

const resumeDataSchema = z
  .object({
    run_id: safeIdSchema,
    workflow_run_id: nonemptyStringSchema.optional(),
    workflow_path: nonemptyStringSchema.optional(),
    action: z.literal("resume"),
    submitted: z.boolean()
  })
  .strict();

const runListFields = {
  run_id: safeIdSchema,
  run_root: nonemptyStringSchema,
  status: nonemptyStringSchema,
  created_at: nonemptyStringSchema.optional(),
  started_at: nonemptyStringSchema.optional(),
  finished_at: nonemptyStringSchema.optional(),
  source_run_id: safeIdSchema.optional(),
  workflow_ids: z.array(nonemptyStringSchema)
} as const;

const statusDataSchema = z
  .object({
    ...runListFields,
    workflow_run_id: nonemptyStringSchema,
    workflow_status: nonemptyStringSchema,
    verdict: z.enum([
      "done",
      "running-healthy",
      "progressing",
      "stalled",
      "blocked",
      "waiting-quota",
      "paused",
      "cancelled",
      "failed"
    ]),
    reason: z.string().max(16 * 1024),
    counts: z
      .object({
        finished: nonnegativeIntegerSchema,
        in_progress: nonnegativeIntegerSchema,
        pending: nonnegativeIntegerSchema,
        failed: nonnegativeIntegerSchema,
        waiting_approval: nonnegativeIntegerSchema,
        waiting_event: nonnegativeIntegerSchema,
        waiting_timer: nonnegativeIntegerSchema,
        skipped: nonnegativeIntegerSchema,
        other: nonnegativeIntegerSchema,
        total: nonnegativeIntegerSchema
      })
      .strict(),
    model_mix: z.array(
      z
        .object({
          engine: nonemptyStringSchema,
          model: nonemptyStringSchema,
          attempts: nonnegativeIntegerSchema,
          quota_parked: z.boolean()
        })
        .strict()
    ),
    throughput: z
      .object({
        recent_finished: nonnegativeIntegerSchema,
        window_ms: nonnegativeIntegerSchema,
        total_finished: nonnegativeIntegerSchema,
        last_finished_at_ms: nonnegativeIntegerSchema.nullable()
      })
      .strict(),
    progress: z
      .object({
        percent: z.number().min(0).max(100),
        finished: nonnegativeIntegerSchema,
        in_progress: nonnegativeIntegerSchema,
        pending: nonnegativeIntegerSchema,
        failed: nonnegativeIntegerSchema,
        skipped: nonnegativeIntegerSchema,
        remaining: nonnegativeIntegerSchema,
        total: nonnegativeIntegerSchema
      })
      .strict(),
    eta: z
      .object({
        available: z.boolean(),
        seconds: z.number().nonnegative().nullable(),
        basis: z.enum(["recent-throughput", "run-throughput", "no-remaining-nodes"]).nullable(),
        unavailable_reason: z
          .enum(["run-terminal", "run-paused", "no-node-counts", "no-finished-nodes", "no-observed-elapsed-time"])
          .nullable()
      })
      .strict()
      .superRefine((eta, context) => {
        if (eta.available !== (eta.seconds !== null)) {
          context.addIssue({ code: "custom", path: ["seconds"], message: "ETA availability does not match seconds" });
        }
        if (eta.available && (eta.basis === null || eta.unavailable_reason !== null)) {
          context.addIssue({ code: "custom", path: ["basis"], message: "available ETA metadata is inconsistent" });
        }
        if (!eta.available && (eta.basis !== null || eta.unavailable_reason === null)) {
          context.addIssue({
            code: "custom",
            path: ["unavailable_reason"],
            message: "unavailable ETA metadata is inconsistent"
          });
        }
      }),
    current_step: z
      .object({
        node_id: safeIdSchema.nullable(),
        iteration: nonnegativeIntegerSchema.nullable(),
        started_at: nonemptyStringSchema.nullable(),
        elapsed_seconds: z.number().nonnegative().nullable(),
        running_count: nonnegativeIntegerSchema
      })
      .strict(),
    gating: z.array(
      z
        .object({
          node_id: safeIdSchema,
          iteration: nonnegativeIntegerSchema,
          state: nonemptyStringSchema,
          detail: z
            .string()
            .max(16 * 1024)
            .nullable()
        })
        .strict()
    ),
    gating_omitted: nonnegativeIntegerSchema,
    quota: z
      .object({
        parked_count: nonnegativeIntegerSchema,
        parked_node_ids: z.array(safeIdSchema),
        reset_at_ms: nonnegativeIntegerSchema.nullable()
      })
      .strict()
      .nullable(),
    generated_at_ms: nonnegativeIntegerSchema
  })
  .strict();

const reportDataSchema = z
  .object({
    markdown_path: nonemptyStringSchema,
    json_path: nonemptyStringSchema,
    source: z.literal("validated-agent-report")
  })
  .strict();

export const evmbenchCliCommandDataSchemas = {
  init: initDataSchema,
  run: runDataSchema,
  resume: resumeDataSchema,
  status: statusDataSchema,
  report: reportDataSchema
} as const;

export type EvmbenchCliCommand = keyof typeof evmbenchCliCommandDataSchemas;
export type EvmbenchInitData = z.infer<typeof initDataSchema>;
export type EvmbenchRunData = z.infer<typeof runDataSchema>;
export type EvmbenchResumeData = z.infer<typeof resumeDataSchema>;
export type EvmbenchStatusData = z.infer<typeof statusDataSchema>;
export type EvmbenchReportData = z.infer<typeof reportDataSchema>;

interface EvmbenchCliDataMap {
  init: EvmbenchInitData;
  run: EvmbenchRunData;
  resume: EvmbenchResumeData;
  status: EvmbenchStatusData;
  report: EvmbenchReportData;
}

export function parseEvmbenchCliResult<Command extends EvmbenchCliCommand>(
  command: Command,
  value: unknown
): EvmbenchCliDataMap[Command] {
  const envelopeSchema = z
    .object({
      schema_version: z.literal(ULTRAFUZZ_CLI_RESULT_VERSION),
      command: z.literal(command),
      ok: z.literal(true),
      diagnostics: z.array(evmbenchCliDiagnosticSchema),
      data: evmbenchCliCommandDataSchemas[command]
    })
    .strict()
    .superRefine((envelope, context) => {
      if (envelope.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
        context.addIssue({
          code: "custom",
          path: ["diagnostics"],
          message: "successful CLI response contains an error diagnostic"
        });
      }
    });
  const parsed = envelopeSchema.parse(value) as unknown as { data: EvmbenchCliDataMap[Command] };
  return parsed.data;
}
