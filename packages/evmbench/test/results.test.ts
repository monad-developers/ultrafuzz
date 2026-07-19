import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { benchmarkIdentity } from "../src/definition.js";
import { normalizeEvmbenchResult, readNanoevalFinalReport } from "../src/results.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("EVMBench result normalization", () => {
  it("keeps official metrics authoritative and namespaces optional Ultrafuzz metrics", () => {
    const normalized = normalizeEvmbenchResult({
      finalReport: {
        metrics: { score: 3, max_score: 4, detect_award: 7.5, detect_max_award: 10, per_audit: {} }
      },
      provenance: provenance(),
      operational: {
        runtime_seconds: 12,
        token_usage: null,
        cost_usd: null,
        completeness: { runtime: "complete", token_usage: "unavailable", cost: "unavailable" }
      },
      ultrafuzzMetrics: { precision: 0.5 }
    });

    expect(normalized.official_evmbench).toMatchObject({
      score: 3,
      max_score: 4,
      recall: 0.75,
      detect_award: 7.5,
      detect_max_award: 10
    });
    expect(normalized.ultrafuzz_metrics).toEqual({ precision: 0.5 });
  });

  it("reads the authoritative final report from NanoEval JSONL", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-evmbench-results-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "records.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ record_type: "run_started" }),
        JSON.stringify({ record_type: "final_report", final_report: { metrics: { score: 1 } } }),
        ""
      ].join("\n"),
      "utf8"
    );
    expect(readNanoevalFinalReport([filePath])).toEqual({ metrics: { score: 1 } });
  });

  it("produces the same benchmark identity for the same locked controls", () => {
    const controls = { lock: "sha256:fixture", profile: "smoke", model: "synthetic-model" };
    expect(benchmarkIdentity(controls)).toBe(benchmarkIdentity(structuredClone(controls)));
  });
});

function provenance() {
  return {
    benchmark_identity: "sha256:fixture",
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
    agent: "ultrafuzz" as const,
    reasoning: "high",
    concurrency: 2
  };
}
