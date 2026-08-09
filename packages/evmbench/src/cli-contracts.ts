import { z } from "zod/v4";

export const ULTRAFUZZ_CLI_RESULT_VERSION = "ultrafuzz.cli.result.v2" as const;

const stringSchema = z.string();
const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const nonnegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const evmbenchCliDiagnosticSchema = z
  .object({
    code: stringSchema,
    message: stringSchema,
    severity: z.enum(["error", "warning", "info"]),
    source: stringSchema,
    path: stringSchema.optional()
  })
  .strict();

const initDataSchema = z
  .object({
    project_root: stringSchema,
    created: z.array(stringSchema),
    preserved: z.array(stringSchema),
    overwritten: z.array(stringSchema)
  })
  .strict();

const runDataSchema = z
  .object({
    run_id: stringSchema,
    run_root: stringSchema,
    status: stringSchema,
    source_run_id: stringSchema.optional(),
    graph_fingerprint: fingerprintSchema,
    config_fingerprint: fingerprintSchema,
    workflow_ids: z.array(stringSchema)
  })
  .strict();

const resumeDataSchema = z
  .object({
    run_id: stringSchema,
    workflow_run_id: stringSchema.optional(),
    workflow_path: stringSchema.optional(),
    action: z.literal("resume"),
    submitted: z.boolean()
  })
  .strict();

const runListFields = {
  run_id: stringSchema,
  run_root: stringSchema,
  status: stringSchema,
  created_at: stringSchema.optional(),
  started_at: stringSchema.optional(),
  finished_at: stringSchema.optional(),
  source_run_id: stringSchema.optional(),
  workflow_ids: z.array(stringSchema)
} as const;

const statusDataSchema = z
  .object({
    ...runListFields,
    workflow_run_id: stringSchema,
    workflow_status: stringSchema,
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
    reason: stringSchema,
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
          engine: stringSchema,
          model: stringSchema,
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
        node_id: stringSchema.nullable(),
        iteration: nonnegativeIntegerSchema.nullable(),
        started_at: stringSchema.nullable(),
        elapsed_seconds: z.number().nonnegative().nullable(),
        running_count: nonnegativeIntegerSchema
      })
      .strict(),
    gating: z.array(
      z
        .object({
          node_id: stringSchema,
          iteration: nonnegativeIntegerSchema,
          state: stringSchema,
          detail: stringSchema.nullable()
        })
        .strict()
    ),
    gating_omitted: nonnegativeIntegerSchema,
    quota: z
      .object({
        parked_count: nonnegativeIntegerSchema,
        parked_node_ids: z.array(stringSchema),
        reset_at_ms: nonnegativeIntegerSchema.nullable()
      })
      .strict()
      .nullable(),
    generated_at_ms: nonnegativeIntegerSchema
  })
  .strict();

const reportDataSchema = z
  .object({
    markdown_path: stringSchema,
    json_path: stringSchema,
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
