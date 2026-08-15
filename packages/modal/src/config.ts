import { createHash } from "node:crypto";

import { MODAL_BENCHMARK_CONFIG_SCHEMA_ID, type StrictModalBenchmarkConfigDocument } from "./modal-contracts.js";
import { assertModalDocumentValue, readModalDocument } from "./modal-documents.js";
import { validateModalJsonSchema } from "./modal-schema-registry.js";
import { modalBenchmarkConfigZodSchema } from "./benchmark-config-zod.js";
import {
  MODAL_PUBLIC_FULL_SANDBOX_TIMEOUT_MS,
  MODAL_PUBLIC_SANDBOX_TIMEOUT_MS,
  MODAL_SANDBOX_TIMEOUT_MS,
  type ModalModelSpec
} from "./defaults.js";

export { assertModalBenchmarkConfigZod, modalBenchmarkConfigZodSchema } from "./benchmark-config-zod.js";
export {
  MODAL_GIT_REF_PATTERN_SOURCE,
  MODAL_GIT_URL_PATTERN_SOURCE,
  MODAL_HTTPS_URL_PATTERN_SOURCE
} from "./benchmark-config-patterns.js";

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
  const config = value as ModalBenchmarkConfig;
  assertModalDocumentValue(MODAL_BENCHMARK_CONFIG_SCHEMA_ID, config);
  return config;
}

export function loadModalBenchmarkConfig(filePath: string): ModalBenchmarkConfig {
  const config = readModalDocument(filePath, MODAL_BENCHMARK_CONFIG_SCHEMA_ID).value;
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

export function modalBenchmarkConfigValidatorsAgree(value: unknown): boolean {
  return (
    validateModalJsonSchema(MODAL_BENCHMARK_CONFIG_SCHEMA_ID, value).ok ===
    modalBenchmarkConfigZodSchema.safeParse(value).success
  );
}
