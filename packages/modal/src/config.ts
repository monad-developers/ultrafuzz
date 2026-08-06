import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import { z } from "zod/v4";

import {
  DEFAULT_BENCHMARK_MODELS,
  DEFAULT_MODAL_APP,
  DEFAULT_MODAL_IMAGE,
  DEFAULT_NODE_TIMEOUT_SECONDS,
  MODAL_BENCHMARK_SCHEMA_VERSION,
  type ModalModelSpec
} from "./defaults.js";

const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const gitRef = z.string().min(1).max(256);
const gitUrl = z.string().url().max(2048);
const fullSha = z.string().regex(/^[0-9a-f]{40}$/u);
const relativeFile = z
  .string()
  .min(1)
  .refine((value) => !path.isAbsolute(value) && !value.split(/[\\/]/u).includes(".."), "must be a safe relative path");
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const httpsUrl = z
  .string()
  .url()
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
    excluded_node_ids: z.array(safeId).max(512).default([])
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
  })
  .default({ excluded_node_ids: [] });

const commonBenchmarkConfig = {
  schema_version: z.literal(MODAL_BENCHMARK_SCHEMA_VERSION),
  run_id: safeId,
  app_name: z.string().min(1).max(128).default(DEFAULT_MODAL_APP),
  image_name: z.string().min(1).max(256).default(DEFAULT_MODAL_IMAGE),
  braintrust: z
    .object({
      project: z.string().min(1).max(256),
      api_key_env: envName.default("BRAINTRUST_API_KEY"),
      judge_api_key_env: envName.optional(),
      judge_url: httpsUrl.optional(),
      judge_credential_endpoint: httpsUrl.optional(),
      judge_credential_ttl_seconds: z.number().int().min(60).max(86_400).default(57_600)
    })
    .strict(),
  node_timeout_seconds: z.number().int().positive().max(86_400).default(DEFAULT_NODE_TIMEOUT_SECONDS),
  loops: z.number().int().positive().max(256).default(3),
  models: z
    .array(modelSchema)
    .min(1)
    .default(() => DEFAULT_BENCHMARK_MODELS.map((model) => ({ ...model })))
} as const;

const privateBenchmarkConfigSchema = z
  .object({
    ...commonBenchmarkConfig,
    target: z.object({ repo: gitUrl, ref: gitRef }).strict(),
    benchmark_execution: privateBenchmarkExecutionSchema,
    ground_truth: z
      .object({
        repo: gitUrl,
        ref: gitRef,
        file: relativeFile,
        format: z.enum(["ultrafuzz", "audit-markdown"]).default("ultrafuzz"),
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
        lane: z.enum(["smoke", "full"]).default("smoke"),
        runner_model_profile: safeId,
        candidate_repository: httpsUrl,
        candidate_commit: fullSha,
        targets: z.array(publicBenchmarkTargetSchema).min(1).max(2_048).optional(),
        max_runtime_seconds: z.number().int().min(300).max(15_000).default(3_600)
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
  });

const benchmarkConfigSchema = z.union([privateBenchmarkConfigSchema, publicBenchmarkConfigSchema]);

export type ModalBenchmarkConfig = z.infer<typeof benchmarkConfigSchema> & { models: ModalModelSpec[] };

export type PublicModalBenchmarkConfig = Extract<ModalBenchmarkConfig, { public_benchmark: unknown }>;
export type PrivateModalBenchmarkConfig = Extract<ModalBenchmarkConfig, { target: unknown }>;

export function isPublicModalBenchmarkConfig(config: ModalBenchmarkConfig): config is PublicModalBenchmarkConfig {
  return "public_benchmark" in config;
}

export function parseModalBenchmarkConfig(value: unknown): ModalBenchmarkConfig {
  const parsed = benchmarkConfigSchema.parse(value);
  const slugs = new Set<string>();
  for (const model of parsed.models) {
    if (slugs.has(model.slug)) throw new Error(`duplicate model slug: ${model.slug}`);
    slugs.add(model.slug);
  }
  return parsed as ModalBenchmarkConfig;
}

export function loadModalBenchmarkConfig(filePath: string): ModalBenchmarkConfig {
  const absolute = path.resolve(filePath);
  return parseModalBenchmarkConfig(JSON.parse(fs.readFileSync(absolute, "utf8")) as unknown);
}

export function fingerprintModalConfigFile(filePath: string): string {
  return createHash("sha256")
    .update(fs.readFileSync(path.resolve(filePath)))
    .digest("hex");
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
