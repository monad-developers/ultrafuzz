import fs from "node:fs";
import path from "node:path";

import { z } from "zod/v4";

import {
  DEFAULT_BENCHMARK_CONDITIONS,
  DEFAULT_BENCHMARK_MODELS,
  DEFAULT_JUDGE_MODEL,
  DEFAULT_MODAL_APP,
  DEFAULT_MODAL_IMAGE,
  DEFAULT_NODE_TIMEOUT_SECONDS,
  MODAL_BENCHMARK_SCHEMA_VERSION,
  type ModalConditionSpec,
  type ModalModelSpec
} from "./defaults.js";

const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const gitRef = z.string().min(1).max(256);
const gitUrl = z.string().url().max(2048);
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
    provider: z.enum(["openai", "anthropic"]),
    agent: z.enum(["CodexAgent", "ClaudeCodeAgent"]),
    reasoning: z.string().min(1).max(64),
    auth_mode: z.enum(["api-key", "subscription"])
  })
  .strict()
  .refine(
    (model) =>
      (model.provider === "openai" && model.agent === "CodexAgent") ||
      (model.provider === "anthropic" && model.agent === "ClaudeCodeAgent"),
    "model provider and agent do not match"
  );

const conditionSchema = z
  .object({
    id: safeId,
    prompt_variant: z.enum(["default", "no-fuzzing"])
  })
  .strict();

const benchmarkConfigSchema = z
  .object({
    schema_version: z.literal(MODAL_BENCHMARK_SCHEMA_VERSION),
    run_id: safeId,
    app_name: z.string().min(1).max(128).default(DEFAULT_MODAL_APP),
    image_name: z.string().min(1).max(256).default(DEFAULT_MODAL_IMAGE),
    target: z.object({ repo: gitUrl, ref: gitRef }).strict(),
    ground_truth: z
      .object({
        repo: gitUrl,
        ref: gitRef,
        file: relativeFile,
        format: z.enum(["ultrafuzz", "audit-markdown"]).default("ultrafuzz"),
        expected_findings: z.number().int().positive().max(10_000).optional()
      })
      .strict(),
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
    loops: z.literal(3).default(3),
    judge: modelSchema.default(() => ({ ...DEFAULT_JUDGE_MODEL })),
    conditions: z
      .array(conditionSchema)
      .length(2)
      .default(() => DEFAULT_BENCHMARK_CONDITIONS.map((condition) => ({ ...condition }))),
    models: z
      .array(modelSchema)
      .min(1)
      .default(() => DEFAULT_BENCHMARK_MODELS.map((model) => ({ ...model })))
  })
  .strict();

export type ModalBenchmarkConfig = Omit<z.infer<typeof benchmarkConfigSchema>, "models"> & {
  models: ModalModelSpec[];
  judge: ModalModelSpec;
  conditions: ModalConditionSpec[];
};

export function parseModalBenchmarkConfig(value: unknown): ModalBenchmarkConfig {
  const parsed = benchmarkConfigSchema.parse(value);
  const slugs = new Set<string>();
  for (const model of parsed.models) {
    if (slugs.has(model.slug)) throw new Error(`duplicate model slug: ${model.slug}`);
    slugs.add(model.slug);
  }
  const conditionIds = new Set<string>();
  const promptVariants = new Set<string>();
  for (const condition of parsed.conditions) {
    if (conditionIds.has(condition.id)) throw new Error(`duplicate condition id: ${condition.id}`);
    conditionIds.add(condition.id);
    promptVariants.add(condition.prompt_variant);
  }
  if (promptVariants.size !== 2 || !promptVariants.has("default") || !promptVariants.has("no-fuzzing")) {
    throw new Error("conditions must include exactly one default and one no-fuzzing prompt variant");
  }
  return parsed as ModalBenchmarkConfig;
}

export function loadModalBenchmarkConfig(filePath: string): ModalBenchmarkConfig {
  const absolute = path.resolve(filePath);
  return parseModalBenchmarkConfig(JSON.parse(fs.readFileSync(absolute, "utf8")) as unknown);
}
