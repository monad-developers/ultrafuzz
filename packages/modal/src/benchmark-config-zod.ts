import { z } from "zod/v4";

import { MODAL_GIT_REF_PATTERN, MODAL_GIT_URL_PATTERN, MODAL_HTTPS_URL_PATTERN } from "./benchmark-config-patterns.js";
import { MODAL_BENCHMARK_CONFIG_SCHEMA_ID, type StrictModalBenchmarkConfigDocument } from "./modal-contracts.js";
import { MODAL_BENCHMARK_SCHEMA_VERSION } from "./defaults.js";

const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const gitRef = z.string().regex(MODAL_GIT_REF_PATTERN);
const gitUrl = z.string().min(1).max(2048).regex(MODAL_GIT_URL_PATTERN);
const fullSha = z.string().regex(/^[0-9a-f]{40}$/u);
const relativeFile = z.string().regex(/^(?!\/)(?![A-Za-z]:[\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$)).+$/u);
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const httpsUrl = z.string().max(2048).regex(MODAL_HTTPS_URL_PATTERN);
const openRouterModelId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\s\p{Cc}]+$/u);

const modelSchema = z
  .object({
    slug: safeId,
    model: z.string().min(1).max(256),
    provider: z.enum(["openai", "anthropic", "deepseek", "kimi", "openrouter"]),
    agent: z.enum(["CodexAgent", "ClaudeAgent", "DeepSeekAgent", "KimiAgent", "OpenRouterAgent"]),
    reasoning: z.string().min(1).max(64),
    auth_mode: z.enum(["api-key", "subscription"])
  })
  .strict()
  .refine(
    (model) =>
      (model.provider === "openai" && model.agent === "CodexAgent") ||
      (model.provider === "anthropic" && model.agent === "ClaudeAgent") ||
      (model.provider === "deepseek" && model.agent === "DeepSeekAgent") ||
      (model.provider === "kimi" && model.agent === "KimiAgent") ||
      (model.provider === "openrouter" && model.agent === "OpenRouterAgent"),
    "model provider and agent do not match"
  )
  .refine(
    (model) => model.provider !== "kimi" || ["low", "high", "max"].includes(model.reasoning),
    "Kimi reasoning must be low, high, or max"
  )
  .refine(
    (model) => model.provider !== "deepseek" || ["low", "high", "max"].includes(model.reasoning),
    "DeepSeek reasoning must be low, high, or max"
  )
  .refine(
    (model) => model.provider !== "deepseek" || model.auth_mode === "api-key",
    "DeepSeek authentication must use an API key"
  )
  .refine(
    (model) => model.provider !== "openrouter" || model.auth_mode === "api-key",
    "OpenRouter authentication must use an API key"
  )
  .refine(
    (model) => model.provider !== "openrouter" || openRouterModelId.safeParse(model.model).success,
    "OpenRouter model must be an opaque catalogue ID without whitespace or control characters"
  );

const publicBenchmarkTargetSchema = z
  .object({
    id: safeId,
    repository: httpsUrl,
    revision: fullSha,
    framework: safeId
  })
  .strict();

const privateBenchmarkExecutionSchema = z
  .object({
    excluded_node_ids: z.array(safeId).max(512)
  })
  .strict()
  .superRefine((execution, context) => {
    const seen = new Set<string>();
    for (const [index, id] of execution.excluded_node_ids.entries()) {
      if (seen.has(id)) {
        context.addIssue({
          code: "custom",
          path: ["excluded_node_ids", index],
          message: `duplicate excluded node ID: ${id}`
        });
      }
      seen.add(id);
    }
  });

const privateEvalReportingSchema = z
  .object({
    provider: z.enum(["braintrust", "none"])
  })
  .strict();

const commonBenchmarkConfig = {
  schema_version: z.literal(MODAL_BENCHMARK_SCHEMA_VERSION),
  run_id: safeId,
  app_name: z.string().min(1).max(128),
  image_name: z.string().min(1).max(256),
  braintrust: z
    .object({
      project: z.string().min(1).max(256),
      api_key_env: envName,
      judge_api_key_env: envName,
      judge_url: httpsUrl,
      judge_credential_endpoint: httpsUrl.optional(),
      judge_credential_ttl_seconds: z.number().int().min(60).max(86_400)
    })
    .strict(),
  node_timeout_seconds: z.number().int().positive().max(86_400),
  loops: z.number().int().positive().max(256),
  models: z.array(modelSchema).min(1)
} as const;

const privateBenchmarkConfigSchema = z
  .object({
    ...commonBenchmarkConfig,
    target: z.object({ repo: gitUrl, ref: gitRef, held_out_paths: z.array(relativeFile).max(64).optional() }).strict(),
    benchmark_execution: privateBenchmarkExecutionSchema,
    eval_reporting: privateEvalReportingSchema,
    ground_truth: z
      .object({
        repo: gitUrl,
        ref: gitRef,
        file: relativeFile,
        format: z.enum(["ultrafuzz", "audit-markdown"]),
        expected_findings: z.number().int().positive().max(10_000).optional()
      })
      .strict()
  })
  .strict();

const publicBenchmarkConfigSchema = z
  .object({
    ...commonBenchmarkConfig,
    public_benchmark: z
      .object({
        benchmark: z.enum(["evmbench", "ultrafuzz-bench"]),
        lane: z.enum(["smoke", "full"]),
        runner_model_profile: safeId,
        candidate_repository: httpsUrl,
        candidate_commit: fullSha,
        targets: z.array(publicBenchmarkTargetSchema).min(1).max(2_048),
        max_runtime_seconds: z.number().int().min(300).max(15_000)
      })
      .strict()
  })
  .strict();

/** Shape-only retained parser; cross-field identity rules belong to the registered semantic gate. */
export const modalBenchmarkConfigZodSchema = z.union([privateBenchmarkConfigSchema, publicBenchmarkConfigSchema]);

export function assertModalBenchmarkConfigZod(
  value: unknown,
  label = "Modal benchmark configuration"
): asserts value is StrictModalBenchmarkConfigDocument {
  const result = modalBenchmarkConfigZodSchema.safeParse(value);
  if (result.success) return;
  const summary = result.error.issues
    .slice(0, 10)
    .map((issue) => `${issue.path.join(".") || "/"}: ${issue.message}`)
    .join("; ");
  throw new Error(`${label} does not match ${MODAL_BENCHMARK_CONFIG_SCHEMA_ID}: ${summary}`);
}

export function assertModalRetainedZodShape(schemaId: string, value: unknown): void {
  if (schemaId === MODAL_BENCHMARK_CONFIG_SCHEMA_ID) assertModalBenchmarkConfigZod(value);
}
