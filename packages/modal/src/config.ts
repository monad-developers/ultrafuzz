import { createHash } from "node:crypto";
import { resolveConfig } from "@ultrafuzz/config";

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
export { MODAL_GIT_URL_PATTERN_SOURCE, MODAL_HTTPS_URL_PATTERN_SOURCE } from "./benchmark-config-patterns.js";

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

/** Refuse an execution envelope that cannot contain even one complete campaign.
 * This is separate from document validation: current-schema configs remain inspectable.
 */
export function assertModalBenchmarkExecutionBudget(config: ModalBenchmarkConfig): void {
  if (!isPublicModalBenchmarkConfig(config) || config.public_benchmark.lane !== "full") return;
  const resolved = resolveConfig({ env: {}, runtimeOverrides: { auditProfile: "exhaustive" } });
  if (!resolved.ok) throw new Error("Cannot resolve the exhaustive campaign execution budget");
  const invariants = resolved.value.invariants;
  const minimumSeconds =
    invariants.invariantTestingSmokeTimeoutSeconds + invariants.invariantTestingFuzzerTimeoutSeconds + 300 + 300;
  if (config.public_benchmark.max_runtime_seconds < minimumSeconds) {
    throw new Error(
      `MODAL_CAMPAIGN_ENVELOPE_TOO_SHORT: full benchmark row allows ${String(config.public_benchmark.max_runtime_seconds)}s, but the exhaustive campaign alone requires at least ${String(minimumSeconds)}s including smoke, shutdown and artifacts. Use local or per-node Modal execution for the four-hour profile until the paid full-benchmark row/control envelopes are explicitly enlarged.`
    );
  }
}
