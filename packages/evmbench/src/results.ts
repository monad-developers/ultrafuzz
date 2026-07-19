import fs from "node:fs";

import { z } from "zod/v4";

export const EVMBENCH_RESULT_VERSION = "ultrafuzz.evmbench.result.v1" as const;

const officialMetricsSchema = z
  .object({
    score: z.number().nonnegative(),
    max_score: z.number().positive(),
    detect_award: z.number().nonnegative(),
    detect_max_award: z.number().nonnegative(),
    per_audit: z.unknown().optional()
  })
  .passthrough();

export interface EvmbenchRunProvenance {
  benchmark_identity: string;
  ultrafuzz_commit: string;
  ultrafuzz_dirty: boolean;
  evmbench_commit: string;
  frontier_evals_commit: string;
  targets: Array<{ audit_id: string; source_commit: string }>;
  audit_images: Array<{ audit_id: string; source_image_digest: string; overlay_image_digest: string | null }>;
  profile: string;
  profile_fingerprint: string;
  topology_fingerprint: string;
  model: string;
  agent: "ultrafuzz" | "official-gold";
  reasoning: string;
  concurrency: number;
}

export interface EvmbenchOperationalMetrics {
  runtime_seconds: number | null;
  token_usage: number | null;
  cost_usd: number | null;
  completeness: {
    runtime: "complete" | "unavailable";
    token_usage: "complete" | "unavailable";
    cost: "complete" | "unavailable";
  };
}

export interface NormalizedEvmbenchResult {
  schema_version: typeof EVMBENCH_RESULT_VERSION;
  official_evmbench: {
    score: number;
    max_score: number;
    recall: number;
    detect_award: number;
    detect_max_award: number;
    per_audit?: unknown;
    per_vulnerability_decisions?: unknown[];
  };
  provenance: EvmbenchRunProvenance;
  operational: EvmbenchOperationalMetrics;
  ultrafuzz_metrics?: unknown;
}

export function normalizeEvmbenchResult(input: {
  finalReport: unknown;
  provenance: EvmbenchRunProvenance;
  operational: EvmbenchOperationalMetrics;
  perVulnerabilityDecisions?: unknown[];
  ultrafuzzMetrics?: unknown;
}): NormalizedEvmbenchResult {
  const finalReport = record(input.finalReport, "NanoEval final report");
  const metrics = officialMetricsSchema.parse(finalReport.metrics ?? finalReport);
  if (metrics.detect_award > metrics.detect_max_award) {
    throw new Error("official detect award exceeds its maximum");
  }
  if (metrics.score > metrics.max_score) throw new Error("official score exceeds its maximum");
  return {
    schema_version: EVMBENCH_RESULT_VERSION,
    official_evmbench: {
      score: metrics.score,
      max_score: metrics.max_score,
      recall: metrics.score / metrics.max_score,
      detect_award: metrics.detect_award,
      detect_max_award: metrics.detect_max_award,
      ...(metrics.per_audit === undefined ? {} : { per_audit: metrics.per_audit }),
      ...(input.perVulnerabilityDecisions === undefined
        ? {}
        : { per_vulnerability_decisions: input.perVulnerabilityDecisions })
    },
    provenance: input.provenance,
    operational: input.operational,
    ...(input.ultrafuzzMetrics === undefined ? {} : { ultrafuzz_metrics: input.ultrafuzzMetrics })
  };
}

export function readNanoevalFinalReport(recordFiles: string[]): unknown {
  let finalReport: unknown;
  for (const filePath of [...recordFiles].sort()) {
    const lines = fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/u)
      .filter((line) => line.trim() !== "");
    for (const line of lines) {
      const row = record(JSON.parse(line) as unknown, "NanoEval record");
      if (row.record_type === "final_report") finalReport = row.final_report;
    }
  }
  if (finalReport === undefined) throw new Error("NanoEval did not record a final report");
  return finalReport;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
