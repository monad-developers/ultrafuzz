import { createHash } from "node:crypto";

import { z } from "zod/v4";

import { MODAL_BENCHMARK_CONFIG_SCHEMA_ID, type StrictModalBenchmarkConfigDocument } from "./modal-contracts.js";
import { assertModalDocumentValue, readModalDocument } from "./modal-documents.js";
import {
  MODAL_BENCHMARK_SCHEMA_VERSION,
  MODAL_PUBLIC_FULL_SANDBOX_TIMEOUT_MS,
  MODAL_PUBLIC_SANDBOX_TIMEOUT_MS,
  MODAL_SANDBOX_TIMEOUT_MS,
  type ModalModelSpec
} from "./defaults.js";

const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const gitRef = z.string().min(1).max(256);
const gitUrl = z.string().url().max(2048);
const fullSha = z.string().regex(/^[0-9a-f]{40}$/u);
const relativeFile = z.string().regex(/^(?!\/)(?![A-Za-z]:[\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$)).+$/u);
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const httpsUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
  }, "must be an HTTPS URL without embedded credentials");

const modelSchema = z
  .object({
    slug: safeId,
    model: z.string().min(1).max(256),
    provider: z.enum(["openai", "anthropic", "deepseek", "kimi"]),
    agent: z.enum(["CodexAgent", "ClaudeAgent", "DeepSeekAgent", "KimiAgent"]),
    reasoning: z.string().min(1).max(64),
    auth_mode: z.enum(["api-key", "subscription"])
  })
  .strict()
  .refine(
    (model) =>
      (model.provider === "openai" && model.agent === "CodexAgent") ||
      (model.provider === "anthropic" && model.agent === "ClaudeAgent") ||
      (model.provider === "deepseek" && model.agent === "DeepSeekAgent") ||
      (model.provider === "kimi" && model.agent === "KimiAgent"),
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
    target: z.object({ repo: gitUrl, ref: gitRef }).strict(),
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
  .strict()
  .superRefine((config, context) => {
    if (config.models.length !== 1 || config.models[0]?.slug !== config.public_benchmark.runner_model_profile) {
      context.addIssue({
        code: "custom",
        path: ["models"],
        message: "public benchmarks must configure exactly their selected runner model profile"
      });
    }
    for (const duplicate of duplicateIdentities(config.public_benchmark.targets, (target) => target.id)) {
      context.addIssue({
        code: "custom",
        path: ["public_benchmark", "targets", duplicate.index],
        message: `duplicate public benchmark target ID: ${duplicate.id}`
      });
    }
  });

export const modalBenchmarkConfigZodSchema = z
  .union([privateBenchmarkConfigSchema, publicBenchmarkConfigSchema])
  .superRefine((config, context) => {
    for (const duplicate of duplicateIdentities(config.models, (model) => model.slug)) {
      context.addIssue({
        code: "custom",
        path: ["models", duplicate.index],
        message: `duplicate model slug: ${duplicate.id}`
      });
    }
  });

export type ModalBenchmarkConfig = StrictModalBenchmarkConfigDocument;

export type PublicModalBenchmarkConfig = Extract<ModalBenchmarkConfig, { public_benchmark: unknown }>;
export type PrivateModalBenchmarkConfig = Extract<ModalBenchmarkConfig, { target: unknown }>;

export function isPublicModalBenchmarkConfig(config: ModalBenchmarkConfig): config is PublicModalBenchmarkConfig {
  return "public_benchmark" in config;
}

/** Timeout recorded when a new benchmark launch generation is created. */
export function configuredModalSandboxTimeoutMs(config: ModalBenchmarkConfig): number {
  if (!isPublicModalBenchmarkConfig(config)) return MODAL_SANDBOX_TIMEOUT_MS;
  return config.public_benchmark.lane === "full"
    ? MODAL_PUBLIC_FULL_SANDBOX_TIMEOUT_MS
    : MODAL_PUBLIC_SANDBOX_TIMEOUT_MS;
}

export function parseModalBenchmarkConfig(value: unknown): ModalBenchmarkConfig {
  assertModalDocumentValue(MODAL_BENCHMARK_CONFIG_SCHEMA_ID, value as ModalBenchmarkConfig);
  assertModalBenchmarkConfigZod(value);
  return value;
}

export function loadModalBenchmarkConfig(filePath: string): ModalBenchmarkConfig {
  const config = readModalDocument(filePath, MODAL_BENCHMARK_CONFIG_SCHEMA_ID).value;
  assertModalBenchmarkConfigZod(config);
  return config as ModalBenchmarkConfig;
}

export function fingerprintModalConfigFile(filePath: string): string {
  return readModalDocument(filePath, MODAL_BENCHMARK_CONFIG_SCHEMA_ID).bytes_sha256;
}

export function fingerprintModalModel(model: ModalModelSpec): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        slug: model.slug,
        model: model.model,
        provider: model.provider,
        agent: model.agent,
        reasoning: model.reasoning,
        auth_mode: model.auth_mode
      })
    )
    .digest("hex");
}

export function assertModalBenchmarkConfigZod(
  value: unknown,
  label = "Modal benchmark configuration"
): asserts value is ModalBenchmarkConfig {
  const result = modalBenchmarkConfigZodSchema.safeParse(value);
  if (result.success) return;
  const summary = result.error.issues
    .slice(0, 10)
    .map((issue) => `${issue.path.join(".") || "/"}: ${issue.message}`)
    .join("; ");
  throw new Error(`${label} does not match ${MODAL_BENCHMARK_CONFIG_SCHEMA_ID}: ${summary}`);
}

export function modalBenchmarkConfigValidatorsAgree(value: unknown): boolean {
  let canonical = true;
  try {
    assertModalDocumentValue(MODAL_BENCHMARK_CONFIG_SCHEMA_ID, value as ModalBenchmarkConfig);
  } catch {
    canonical = false;
  }
  return canonical === modalBenchmarkConfigZodSchema.safeParse(value).success;
}

function duplicateIdentities<Item>(
  items: readonly Item[],
  identity: (item: Item) => string
): Array<{ id: string; index: number }> {
  const seen = new Set<string>();
  const duplicates: Array<{ id: string; index: number }> = [];
  for (const [index, item] of items.entries()) {
    const id = identity(item);
    if (seen.has(id)) duplicates.push({ id, index });
    seen.add(id);
  }
  return duplicates;
}
