import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { benchmarkIdentity } from "../src/definition.js";
import {
  normalizeEvmbenchResult,
  publishNormalizedEvmbenchResult,
  readNanoevalFinalReport,
  type NanoevalFinalReport
} from "../src/results.js";
import { serializeNormalizedEvmbenchResult, type EvmbenchRunProvenance } from "../src/contracts.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("EVMBench result normalization", () => {
  it("keeps only fully typed official metrics and does not propagate recorder extras", () => {
    const normalized = normalizeEvmbenchResult({
      finalReport: finalReport(),
      provenance: provenance(),
      operational: operational(12)
    });

    expect(normalized.official_evmbench).toEqual({
      score: 3,
      max_score: 4,
      recall: 0.75,
      detect_award: 7.5,
      detect_max_award: 10,
      per_audit: {
        "synthetic-audit": {
          score: 3,
          max_score: 4,
          n_runs: 1,
          detect_award: 7.5,
          detect_max_award: 10
        }
      }
    });
    expect(normalized).not.toHaveProperty("ultrafuzz_metrics");
    expect(normalized.official_evmbench).not.toHaveProperty("per_vulnerability_decisions");
  });

  it("requires the pinned final-report envelope and rejects fallback metric shapes", () => {
    expect(() =>
      normalizeEvmbenchResult({
        finalReport: finalReport({ partial: true }),
        provenance: provenance(),
        operational: operational(12)
      })
    ).toThrow("partial NanoEval final report");

    expect(() =>
      normalizeEvmbenchResult({
        finalReport: finalReport().metrics,
        provenance: provenance(),
        operational: operational(12)
      })
    ).toThrow("params");
  });

  it("reads successful and recovered failure sequences from strict NanoEval JSONL", () => {
    const successful = temporaryFile("successful.jsonl");
    writeJournal(successful, [
      runStarted(0),
      recorderRow(1, "sampling", { prompt: "", sampled: "Rolling out task synthetic-audit.0" }),
      recorderRow(2, "extra", { data: { third_party_secret: "must-not-propagate" } }),
      recorderRow(3, "match", { correct: true, expected: null, picked: null, prob_correct: null }),
      recorderRow(4, "sample_completed", { status: "completed" }),
      finalReportRow(5)
    ]);
    expect(readNanoevalFinalReport([successful])).toEqual(finalReport());

    const recovered = temporaryFile("recovered.jsonl");
    writeJournal(recovered, [
      runStarted(0),
      recorderRow(1, "error", {
        message: "[nanoeval] _evaluate_episode terminated with error",
        error: "synthetic rollout failure"
      }),
      recorderRow(2, "sample_completed", { status: "completed" }),
      finalReportRow(3)
    ]);
    expect(readNanoevalFinalReport([recovered])).toEqual(finalReport());
  });

  it("accepts partial reports but requires exactly one terminal final report", () => {
    const filePath = temporaryFile("partial-then-final.jsonl");
    writeJournal(filePath, [runStarted(0), finalReportRow(1, { partial: true }), finalReportRow(2)]);
    expect(readNanoevalFinalReport([filePath])).toEqual(finalReport());

    const partialOnly = temporaryFile("partial-only.jsonl");
    writeJournal(partialOnly, [runStarted(0), finalReportRow(1, { partial: true })]);
    expect(() => readNanoevalFinalReport([partialOnly])).toThrow("non-partial final report");

    const second = temporaryFile("second-final.jsonl");
    writeJournal(second, [runStarted(0), finalReportRow(1)]);
    expect(() => readNanoevalFinalReport([filePath, second])).toThrow("more than one non-partial final report");
  });

  it("rejects unknown, open-ended, duplicate, and torn recorder rows", () => {
    const unknown = temporaryFile("unknown.jsonl");
    writeJournal(unknown, [runStarted(0), recorderRow(1, "legacy_final", {})]);
    expect(() => readNanoevalFinalReport([unknown])).toThrow("pinned recorder contract");

    const openEnded = temporaryFile("open-ended.jsonl");
    writeJournal(openEnded, [
      runStarted(0),
      recorderRow(1, "sampling", { prompt: "", sampled: "sample", compatibility_payload: {} })
    ]);
    expect(() => readNanoevalFinalReport([openEnded])).toThrow("must NOT have additional properties");

    const duplicate = temporaryFile("duplicate.jsonl");
    const sample = recorderRow(1, "sampling", { prompt: "", sampled: "sample" });
    writeJournal(duplicate, [runStarted(0), sample, sample]);
    expect(() => readNanoevalFinalReport([duplicate])).toThrow("duplicate identity");

    const torn = temporaryFile("torn.jsonl");
    fs.writeFileSync(torn, JSON.stringify(runStarted(0)), "utf8");
    expect(() => readNanoevalFinalReport([torn])).toThrow("torn or unterminated");
  });

  it("publishes the exact validated normalized bytes without replacing conflicts", () => {
    const root = temporaryDirectory();
    const first = normalizeEvmbenchResult({
      finalReport: finalReport(),
      provenance: provenance(),
      operational: operational(12)
    });
    const publication = publishNormalizedEvmbenchResult(root, "normalized-summary.json", first);
    expect(publication.created).toBe(true);
    expect(fs.readFileSync(publication.path)).toEqual(serializeNormalizedEvmbenchResult(first));
    expect(publishNormalizedEvmbenchResult(root, "normalized-summary.json", first).created).toBe(false);

    const changed = normalizeEvmbenchResult({
      finalReport: finalReport(),
      provenance: provenance(),
      operational: operational(13)
    });
    expect(() => publishNormalizedEvmbenchResult(root, "normalized-summary.json", changed)).toThrow(
      "already exists with different contents"
    );
    expect(fs.readFileSync(publication.path)).toEqual(serializeNormalizedEvmbenchResult(first));
  });

  it("produces the same benchmark identity for the same locked controls", () => {
    const controls = { lock: `sha256:${"a".repeat(64)}`, profile: "smoke", model: "synthetic-model" };
    expect(benchmarkIdentity(controls)).toBe(benchmarkIdentity(structuredClone(controls)));
  });
});

function finalReport(overrides: { partial?: true } = {}): NanoevalFinalReport {
  return {
    params: { audit_split: "synthetic-audit", mode: "detect", n_tries: 1, n_samples: 1, agent: "ultrafuzz" },
    run_health: { n_rollouts_failed: 0 },
    metrics: {
      score: 3,
      max_score: 4,
      score_percentage: 75,
      per_audit: {
        "synthetic-audit": {
          score: 3,
          max_score: 4,
          n_runs: 1,
          detect_award: 7.5,
          detect_max_award: 10
        }
      },
      detect_award: 7.5,
      detect_max_award: 10,
      detect_score_percentage: 75
    },
    run_group_id: "synthetic-run-group",
    ...overrides
  };
}

function provenance(): EvmbenchRunProvenance {
  return {
    benchmark_identity: `sha256:${"0".repeat(64)}`,
    ultrafuzz_commit: "a".repeat(40),
    ultrafuzz_dirty: false,
    evmbench_commit: "b".repeat(40),
    frontier_evals_commit: "c".repeat(40),
    targets: [{ audit_id: "synthetic-audit", source_commit: "d".repeat(40) }],
    audit_images: [
      {
        audit_id: "synthetic-audit",
        source_image_digest: `sha256:${"e".repeat(64)}`,
        overlay_image_digest: `sha256:${"f".repeat(64)}`
      }
    ],
    profile: "smoke",
    profile_fingerprint: `sha256:${"1".repeat(64)}`,
    topology_fingerprint: `sha256:${"2".repeat(64)}`,
    model: "synthetic-model",
    agent: "ultrafuzz",
    reasoning: "high",
    concurrency: 2
  };
}

function operational(runtimeSeconds: number) {
  return {
    runtime_seconds: runtimeSeconds,
    token_usage: null,
    cost_usd: null,
    completeness: { runtime: "complete" as const, token_usage: "unavailable" as const, cost: "unavailable" as const }
  };
}

function runStarted(index: number): Record<string, unknown> {
  return recorderRow(index, "run_started", {
    sample_id: null,
    group_id: null,
    run_spec: { run_id: "260809000000AAAA", run_set_id: "synthetic-run-set" }
  });
}

function finalReportRow(index: number, overrides: { partial?: true } = {}): Record<string, unknown> {
  return recorderRow(index, "final_report", {
    sample_id: null,
    group_id: null,
    final_report: finalReport(overrides)
  });
}

function recorderRow(index: number, recordType: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    timestamp: `2026-08-09T00:00:00.${String(index).padStart(3, "0")}+00:00`,
    record_type: recordType,
    sample_id: "synthetic-audit",
    group_id: "0.0",
    ...fields
  };
}

function writeJournal(filePath: string, rows: Array<Record<string, unknown>>): void {
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function temporaryFile(filename: string): string {
  return path.join(temporaryDirectory(), filename);
}

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-evmbench-results-"));
  temporaryDirectories.push(directory);
  return directory;
}
