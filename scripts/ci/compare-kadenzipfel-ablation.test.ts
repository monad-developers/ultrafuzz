import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createPublicBenchmarkBundle, readPublicBenchmarkBundle } from "../../packages/modal/src/public-bundle.ts";
import {
  compareKadenzipfelAblation,
  KADEN_ABLATION_JSON,
  KADEN_ABLATION_MARKDOWN
} from "./compare-kadenzipfel-ablation.mjs";

const RUNNER_SLUG = "benchmark-smoke-gpt-5-6-luna-high";
const CANDIDATE_COMMIT = "a".repeat(40);
const SCORING_FINGERPRINT = `sha256:${"b".repeat(64)}`;
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Kaden public benchmark comparison", () => {
  it("writes deterministic paired metrics and deltas", async () => {
    const fixture = fixtureRoot();
    const baseline = pairEntry("baseline-pair", "without-kadenzipfel");
    const candidate = pairEntry("candidate-pair", "candidate");
    writeBundle(fixture.resultsRoot, baseline, {
      precision: 0.5,
      recall: 0.25,
      f1: 0.3,
      rows: [row("target-a", 1, 60, 0.1), row("target-b", 2, 90, 0.2)]
    });
    writeBundle(fixture.resultsRoot, candidate, {
      precision: 0.75,
      recall: 0.5,
      f1: 0.6,
      rows: [row("target-a", 2, 100, 0.2), row("target-b", 3, 200, 0.3)]
    });
    writeManifest(fixture.manifestPath, [candidate, baseline]);

    const first = await compareKadenzipfelAblation({
      manifestPath: fixture.manifestPath,
      resultsRoot: fixture.resultsRoot,
      outputDirectory: fixture.outputRoot,
      readBundle: readPublicBenchmarkBundle
    });
    const comparison = first.comparison.comparisons[0];
    expect(first.comparison.candidate_commit).toBe(CANDIDATE_COMMIT);
    expect(first.comparison.comparisons).toHaveLength(1);
    expect(comparison.baseline).toMatchObject({
      precision: 0.5,
      recall: 0.25,
      f1_score: 0.3,
      summed_true_positives: 3,
      total_tokens: 150,
      token_completeness: "complete",
      cost_usd: 0.3,
      cost_completeness: "complete"
    });
    expect(comparison.candidate).toMatchObject({
      precision: 0.75,
      recall: 0.5,
      f1_score: 0.6,
      summed_true_positives: 5,
      total_tokens: 300,
      cost_usd: 0.5
    });
    expect(comparison.delta).toEqual({
      precision: 0.25,
      recall: 0.25,
      f1_score: 0.3,
      summed_true_positives: 2,
      total_tokens: 150,
      cost_usd: 0.2
    });
    const markdown = fs.readFileSync(path.join(fixture.outputRoot, KADEN_ABLATION_MARKDOWN), "utf8");
    expect(markdown).toContain("# Kaden Strategy Ablation Comparison");
    expect(markdown).toContain("| Summed true positives | 3 | 5 | +2 |");
    expect(markdown).toContain("| Runner cost USD | 0.3 | 0.5 | +0.2 |");

    const secondOutput = path.join(fixture.root, "second-output");
    await compareKadenzipfelAblation({
      manifestPath: fixture.manifestPath,
      resultsRoot: fixture.resultsRoot,
      outputDirectory: secondOutput,
      readBundle: readPublicBenchmarkBundle
    });
    expect(fs.readFileSync(path.join(secondOutput, KADEN_ABLATION_JSON), "utf8")).toBe(
      fs.readFileSync(path.join(fixture.outputRoot, KADEN_ABLATION_JSON), "utf8")
    );
    expect(fs.readFileSync(path.join(secondOutput, KADEN_ABLATION_MARKDOWN), "utf8")).toBe(markdown);
  });

  it("reports token and cost deltas only when both sides are complete", async () => {
    const fixture = fixtureRoot();
    const baseline = pairEntry("baseline-incomplete", "without-kadenzipfel");
    const candidate = pairEntry("candidate-complete", "candidate");
    writeBundle(fixture.resultsRoot, baseline, {
      precision: 0.4,
      recall: 0.4,
      f1: 0.4,
      rows: [row("target-a", 1, null, null, "partial", "unavailable")]
    });
    writeBundle(fixture.resultsRoot, candidate, {
      precision: 0.5,
      recall: 0.5,
      f1: 0.5,
      rows: [row("target-a", 2, 50, 0.25)]
    });
    writeManifest(fixture.manifestPath, [baseline, candidate]);

    const result = await compareKadenzipfelAblation({
      manifestPath: fixture.manifestPath,
      resultsRoot: fixture.resultsRoot,
      outputDirectory: fixture.outputRoot,
      readBundle: readPublicBenchmarkBundle
    });
    const comparison = result.comparison.comparisons[0];
    expect(comparison.baseline).toMatchObject({
      total_tokens: null,
      token_completeness: "incomplete",
      cost_usd: null,
      cost_completeness: "incomplete"
    });
    expect(comparison.delta.total_tokens).toBeNull();
    expect(comparison.delta.cost_usd).toBeNull();
    expect(fs.readFileSync(result.markdownPath, "utf8")).toContain("| Runner tokens | n/a (incomplete) | 50 | n/a |");
  });

  it("rejects baseline and candidate identity mismatches", async () => {
    const fixture = fixtureRoot();
    const baseline = pairEntry("baseline-identity", "without-kadenzipfel");
    const candidate = pairEntry("candidate-identity", "candidate");
    writeBundle(
      fixture.resultsRoot,
      baseline,
      { precision: 0.4, recall: 0.4, f1: 0.4, rows: [row("target-a", 1, 10, 0.1)] },
      { candidateCommit: "c".repeat(40) }
    );
    writeBundle(fixture.resultsRoot, candidate, {
      precision: 0.5,
      recall: 0.5,
      f1: 0.5,
      rows: [row("target-a", 2, 20, 0.2)]
    });
    writeManifest(fixture.manifestPath, [baseline, candidate], null);

    await expect(
      compareKadenzipfelAblation({
        manifestPath: fixture.manifestPath,
        resultsRoot: fixture.resultsRoot,
        outputDirectory: fixture.outputRoot,
        readBundle: readPublicBenchmarkBundle
      })
    ).rejects.toThrow(/candidate_commit values differ/u);
  });

  it("requires matching runner identities and both experiments for every group", async () => {
    const mismatch = fixtureRoot();
    const mismatchedBaseline = pairEntry("baseline-model", "without-kadenzipfel");
    const mismatchedCandidate = pairEntry("candidate-model", "candidate");
    const metrics = { precision: 0.5, recall: 0.5, f1: 0.5, rows: [row("target-a", 1, 10, 0.1)] };
    writeBundle(mismatch.resultsRoot, mismatchedBaseline, metrics, { model: "gpt-5.6-terra" });
    writeBundle(mismatch.resultsRoot, mismatchedCandidate, metrics);
    writeManifest(mismatch.manifestPath, [mismatchedBaseline, mismatchedCandidate]);

    await expect(
      compareKadenzipfelAblation({
        manifestPath: mismatch.manifestPath,
        resultsRoot: mismatch.resultsRoot,
        outputDirectory: mismatch.outputRoot,
        readBundle: readPublicBenchmarkBundle
      })
    ).rejects.toThrow(/model values differ/u);

    const missing = fixtureRoot();
    const candidateOnly = pairEntry("candidate-only", "candidate");
    writeBundle(missing.resultsRoot, candidateOnly, metrics);
    writeManifest(missing.manifestPath, [candidateOnly]);
    await expect(
      compareKadenzipfelAblation({
        manifestPath: missing.manifestPath,
        resultsRoot: missing.resultsRoot,
        outputDirectory: missing.outputRoot,
        readBundle: readPublicBenchmarkBundle
      })
    ).rejects.toThrow(/must contain exactly candidate and without-kadenzipfel/u);
  });

  it("rejects bundles that fail the Modal public bundle integrity API", async () => {
    const fixture = fixtureRoot();
    const baseline = pairEntry("baseline-tampered", "without-kadenzipfel");
    const candidate = pairEntry("candidate-untampered", "candidate");
    const metrics = { precision: 0.5, recall: 0.5, f1: 0.5, rows: [row("target-a", 1, 10, 0.1)] };
    const baselinePath = writeBundle(fixture.resultsRoot, baseline, metrics);
    writeBundle(fixture.resultsRoot, candidate, metrics);
    writeManifest(fixture.manifestPath, [baseline, candidate]);
    const tampered = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as {
      files: Array<{ path: string; contents_base64: string }>;
    };
    const summary = tampered.files.find((file) => file.path === "eval/summary.json");
    if (summary === undefined) throw new Error("missing summary fixture");
    summary.contents_base64 = Buffer.from("{}\n").toString("base64");
    fs.writeFileSync(baselinePath, `${JSON.stringify(tampered, null, 2)}\n`);

    await expect(
      compareKadenzipfelAblation({
        manifestPath: fixture.manifestPath,
        resultsRoot: fixture.resultsRoot,
        outputDirectory: fixture.outputRoot,
        readBundle: readPublicBenchmarkBundle
      })
    ).rejects.toThrow(/integrity check failed/u);
  });
});

interface PairEntry {
  pair: string;
  benchmark: "evmbench";
  lane: "smoke";
  model_slug: string;
  experiment: "candidate" | "without-kadenzipfel";
}

interface FixtureRow {
  target: string;
  truePositives: number;
  tokens: number | null;
  cost: number | null;
  usageStatus: "complete" | "partial" | "unavailable";
  costStatus: "complete" | "partial" | "unavailable";
}

interface FixtureMetrics {
  precision: number;
  recall: number;
  f1: number;
  rows: FixtureRow[];
}

function fixtureRoot(): {
  root: string;
  manifestPath: string;
  resultsRoot: string;
  outputRoot: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-kaden-ablation-"));
  temporaryRoots.push(root);
  return {
    root,
    manifestPath: path.join(root, "manifest.json"),
    resultsRoot: path.join(root, "results"),
    outputRoot: path.join(root, "comparison")
  };
}

function pairEntry(pair: string, experiment: PairEntry["experiment"]): PairEntry {
  return { pair, benchmark: "evmbench", lane: "smoke", model_slug: RUNNER_SLUG, experiment };
}

function row(
  target: string,
  truePositives: number,
  tokens: number | null,
  cost: number | null,
  usageStatus: FixtureRow["usageStatus"] = "complete",
  costStatus: FixtureRow["costStatus"] = "complete"
): FixtureRow {
  return { target, truePositives, tokens, cost, usageStatus, costStatus };
}

function writeManifest(filePath: string, pairs: PairEntry[], candidateCommit: string | null = CANDIDATE_COMMIT): void {
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({ ...(candidateCommit === null ? {} : { candidate_commit: candidateCommit }), pairs }, null, 2)}\n`
  );
}

function writeBundle(
  resultsRoot: string,
  entry: PairEntry,
  metrics: FixtureMetrics,
  overrides: { candidateCommit?: string; model?: string } = {}
): string {
  const candidateCommit = overrides.candidateCommit ?? CANDIDATE_COMMIT;
  const evalRunId = `${entry.pair}-run`;
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-kaden-bundle-source-"));
  temporaryRoots.push(sourceRoot);
  const summary = {
    eval_run_id: evalRunId,
    variants: [
      {
        variant_id: entry.model_slug,
        precision: metrics.precision,
        recall: metrics.recall,
        f1_score: metrics.f1
      }
    ],
    rows: metrics.rows.map((fixture) => ({
      row_id: `${fixture.target}-${entry.model_slug}-trial-1`,
      target_id: fixture.target,
      variant_id: entry.model_slug,
      trial_id: "trial-1",
      true_positives: fixture.truePositives,
      efficiency: {
        total_tokens: fixture.tokens,
        cost_usd: fixture.cost,
        usage: { status: fixture.usageStatus, reason: fixture.usageStatus === "complete" ? null : "usage-incomplete" },
        cost: { status: fixture.costStatus, reason: fixture.costStatus === "complete" ? null : "pricing-incomplete" }
      }
    })),
    provenance: {
      candidate: { commit: candidateCommit },
      scoring: {
        judge_mode: "llm",
        judge_models: ["gpt-5.6-sol"],
        fingerprint: SCORING_FINGERPRINT
      }
    }
  };
  const required = [
    "eval.json",
    "matrix.json",
    "runs.jsonl",
    "run-summary.json",
    "scores.jsonl",
    "summary.json",
    "summary.md"
  ].map((name) => {
    const source = path.join(sourceRoot, name);
    const contents =
      name === "summary.json"
        ? `${JSON.stringify(summary)}\n`
        : name === "matrix.json"
          ? `${JSON.stringify(summary.rows.map((row) => ({ id: row.row_id })))}\n`
          : `${name}\n`;
    fs.writeFileSync(source, contents);
    return { path: `eval/${name}`, root: sourceRoot, source };
  });
  for (const row of summary.rows) {
    for (const [name, contents] of [
      ["report.md", `# ${row.row_id}\n`],
      ["report.json", '{"schema_version":"1.0","issues":[]}\n'],
      ["findings.normalized.json", "[]\n"]
    ] as const) {
      const source = path.join(sourceRoot, "reports", row.row_id, name);
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(source, contents);
      required.push({ path: `reports/${row.row_id}/${name}`, root: sourceRoot, source });
    }
  }
  const bundle = createPublicBenchmarkBundle({
    benchmark: entry.benchmark,
    lane: entry.lane,
    modelSlug: entry.model_slug,
    experiment: entry.experiment,
    model: overrides.model ?? "gpt-5.6-luna",
    reasoning: "high",
    candidateCommit,
    evalRunId,
    lineage: {
      logical_run_id: `fixture-${entry.model_slug}`,
      generation: 1,
      fingerprints: { config: "1".repeat(64), source: "2".repeat(64), image: "3".repeat(64) },
      model_fingerprint: "4".repeat(64)
    },
    files: required,
    createdAt: "2026-07-19T00:00:00.000Z"
  });
  const bundlePath = path.join(resultsRoot, entry.pair, entry.model_slug, "public-results.json");
  fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
  fs.writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  return bundlePath;
}
