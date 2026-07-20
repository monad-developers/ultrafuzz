import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const KADEN_ABLATION_COMPARISON_SCHEMA_VERSION = "ultrafuzz.kadenzipfel-ablation-comparison.v1";
export const KADEN_ABLATION_JSON = "kadenzipfel-ablation-comparison.json";
export const KADEN_ABLATION_MARKDOWN = "kadenzipfel-ablation-comparison.md";

const BASELINE_EXPERIMENT = "without-kadenzipfel";
const CANDIDATE_EXPERIMENT = "candidate";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export async function compareKadenzipfelAblation(input) {
  const manifestPath = path.resolve(requiredString(input.manifestPath, "manifest path"));
  const resultsRoot = path.resolve(requiredString(input.resultsRoot, "results root"));
  const outputDirectory = path.resolve(requiredString(input.outputDirectory, "output directory"));
  const readBundle = input.readBundle ?? (await defaultBundleReader());
  const manifest = parseManifest(readJson(manifestPath));
  const grouped = new Map();

  for (const entry of manifest.pairs) {
    const bundlePath = path.join(resultsRoot, entry.pair, entry.model_slug, "public-results.json");
    const bundle = await readBundle(bundlePath);
    validateBundleAgainstManifest(bundle, entry, manifest.candidate_commit);
    const summary = parseSummary(bundle);
    const key = [entry.benchmark, entry.lane, entry.model_slug].join("\u0000");
    const experiments = grouped.get(key) ?? new Map();
    if (experiments.has(entry.experiment)) {
      throw new Error(`duplicate ${entry.experiment} result for ${entry.benchmark}/${entry.model_slug}/${entry.lane}`);
    }
    experiments.set(entry.experiment, { entry, bundle, summary });
    grouped.set(key, experiments);
  }

  const comparisons = [...grouped.entries()]
    .map(([key, experiments]) => comparisonForGroup(key, experiments))
    .sort(compareRows);
  if (comparisons.length === 0) throw new Error("comparison manifest contains no experiment pairs");
  const commits = new Set(comparisons.map((comparison) => comparison.candidate_commit));
  if (commits.size !== 1) throw new Error("all comparison pairs must use the same candidate commit");

  const comparison = {
    schema_version: KADEN_ABLATION_COMPARISON_SCHEMA_VERSION,
    candidate_commit: comparisons[0].candidate_commit,
    experiments: {
      baseline: BASELINE_EXPERIMENT,
      candidate: CANDIDATE_EXPERIMENT
    },
    comparisons
  };
  const json = `${JSON.stringify(comparison, null, 2)}\n`;
  const markdown = renderKadenzipfelAblationMarkdown(comparison);
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
  const jsonPath = path.join(outputDirectory, KADEN_ABLATION_JSON);
  const markdownPath = path.join(outputDirectory, KADEN_ABLATION_MARKDOWN);
  fs.writeFileSync(jsonPath, json, { encoding: "utf8", mode: 0o644 });
  fs.writeFileSync(markdownPath, markdown, { encoding: "utf8", mode: 0o644 });
  return { comparison, jsonPath, markdownPath };
}

export function renderKadenzipfelAblationMarkdown(comparison) {
  const lines = [
    "# Kaden Strategy Ablation Comparison",
    "",
    `Candidate commit: \`${comparison.candidate_commit}\``,
    `Baseline: \`${BASELINE_EXPERIMENT}\`; candidate: \`${CANDIDATE_EXPERIMENT}\`.`,
    ""
  ];
  for (const row of comparison.comparisons) {
    lines.push(
      `## ${row.benchmark} / ${row.lane} / ${row.model_slug}`,
      "",
      `Runner: \`${row.model}\` (${row.reasoning}); judge: \`${row.judge.model}\` (${row.judge.reasoning}).`,
      "",
      "| Metric | Baseline | Candidate | Delta |",
      "| --- | ---: | ---: | ---: |",
      metricRow("Precision", row.baseline.precision, row.candidate.precision, row.delta.precision),
      metricRow("Recall", row.baseline.recall, row.candidate.recall, row.delta.recall),
      metricRow("F1", row.baseline.f1_score, row.candidate.f1_score, row.delta.f1_score),
      metricRow(
        "Summed true positives",
        row.baseline.summed_true_positives,
        row.candidate.summed_true_positives,
        row.delta.summed_true_positives
      ),
      metricRow(
        "Runner tokens",
        completeValue(row.baseline.total_tokens, row.baseline.token_completeness),
        completeValue(row.candidate.total_tokens, row.candidate.token_completeness),
        row.delta.total_tokens
      ),
      metricRow(
        "Runner cost USD",
        completeValue(row.baseline.cost_usd, row.baseline.cost_completeness),
        completeValue(row.candidate.cost_usd, row.candidate.cost_completeness),
        row.delta.cost_usd
      ),
      ""
    );
  }
  return `${lines.join("\n")}\n`;
}

function parseManifest(value) {
  const manifest = requiredRecord(value, "comparison manifest");
  if (!Array.isArray(manifest.pairs) || manifest.pairs.length === 0) {
    throw new Error("comparison manifest pairs must be a non-empty array");
  }
  const candidateCommit = optionalCommit(manifest.candidate_commit, "manifest candidate commit");
  const seenPairs = new Set();
  const pairs = manifest.pairs.map((value, index) => {
    const entry = requiredRecord(value, `manifest pair ${index}`);
    const pair = safeId(entry.pair, `manifest pair ${index} pair`);
    if (seenPairs.has(pair)) throw new Error(`duplicate manifest pair ${pair}`);
    seenPairs.add(pair);
    const experiment = requiredString(entry.experiment, `manifest pair ${pair} experiment`);
    if (experiment !== BASELINE_EXPERIMENT && experiment !== CANDIDATE_EXPERIMENT) {
      throw new Error(`manifest pair ${pair} has unsupported experiment ${experiment}`);
    }
    const benchmark = requiredString(entry.benchmark, `manifest pair ${pair} benchmark`);
    if (benchmark !== "evmbench" && benchmark !== "ultrafuzz-bench") {
      throw new Error(`manifest pair ${pair} has unsupported benchmark ${benchmark}`);
    }
    const lane = requiredString(entry.lane, `manifest pair ${pair} lane`);
    if (lane !== "smoke" && lane !== "full") throw new Error(`manifest pair ${pair} has unsupported lane ${lane}`);
    return {
      pair,
      benchmark,
      lane,
      model_slug: safeId(entry.model_slug, `manifest pair ${pair} model slug`),
      experiment
    };
  });
  return { candidate_commit: candidateCommit, pairs };
}

function validateBundleAgainstManifest(bundleValue, entry, manifestCommit) {
  const bundle = requiredRecord(bundleValue, `bundle ${entry.pair}`);
  for (const [field, expected] of [
    ["benchmark", entry.benchmark],
    ["lane", entry.lane],
    ["model_slug", entry.model_slug],
    ["experiment", entry.experiment]
  ]) {
    if (bundle[field] !== expected) {
      throw new Error(`bundle ${entry.pair} ${field} does not match its manifest entry`);
    }
  }
  if (manifestCommit !== undefined && bundle.candidate_commit !== manifestCommit) {
    throw new Error(`bundle ${entry.pair} candidate commit does not match the manifest`);
  }
}

function parseSummary(bundleValue) {
  const bundle = requiredRecord(bundleValue, "public result bundle");
  if (!Array.isArray(bundle.files)) throw new Error("public result bundle files must be an array");
  const summaryFile = bundle.files.find((file) => requiredRecord(file, "bundle file").path === "eval/summary.json");
  if (summaryFile === undefined) throw new Error("public result bundle is missing eval/summary.json");
  const encoded = requiredString(
    requiredRecord(summaryFile, "summary bundle file").contents_base64,
    "summary contents"
  );
  let summaryValue;
  try {
    summaryValue = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch (error) {
    throw new Error("eval/summary.json is not valid JSON", { cause: error });
  }
  const summary = requiredRecord(summaryValue, "eval summary");
  const evalRunId = requiredString(summary.eval_run_id, "eval summary run id");
  if (evalRunId !== bundle.eval_run_id) throw new Error("eval summary run id does not match its bundle");
  if (!Array.isArray(summary.variants) || summary.variants.length !== 1) {
    throw new Error("eval summary must contain exactly one runner variant");
  }
  const variant = requiredRecord(summary.variants[0], "eval summary variant");
  if (variant.variant_id !== bundle.model_slug) throw new Error("eval summary variant does not match the bundle model");
  if (!Array.isArray(summary.rows) || summary.rows.length === 0) throw new Error("eval summary rows must be non-empty");
  const rows = summary.rows.map((value, index) => parseSummaryRow(value, index, bundle.model_slug));
  const rowIds = rows.map((row) => row.row_id);
  if (new Set(rowIds).size !== rowIds.length) throw new Error("eval summary contains duplicate row ids");
  const provenance = requiredRecord(summary.provenance, "eval summary provenance");
  const candidate = requiredRecord(provenance.candidate, "eval summary candidate provenance");
  if (candidate.commit !== bundle.candidate_commit) {
    throw new Error("eval summary candidate commit does not match its bundle");
  }
  const scoring = requiredRecord(provenance.scoring, "eval summary scoring provenance");
  if (scoring.judge_mode !== "llm") throw new Error("eval summary was not scored by the configured LLM judge");
  if (!Array.isArray(scoring.judge_models) || !scoring.judge_models.includes(bundle.judge_model)) {
    throw new Error("eval summary judge does not match its bundle");
  }
  const scoringFingerprint = requiredString(scoring.fingerprint, "eval summary scoring fingerprint");
  const tokenTotal = completeSum(rows, "total_tokens", "usage", true);
  const costTotal = completeSum(rows, "cost_usd", "cost", false);
  return {
    eval_run_id: evalRunId,
    scoring_fingerprint: scoringFingerprint,
    row_ids: [...rowIds].sort(compareText),
    metrics: {
      row_count: rows.length,
      precision: ratio(variant.precision, "variant precision"),
      recall: ratio(variant.recall, "variant recall"),
      f1_score: ratio(variant.f1_score, "variant F1"),
      summed_true_positives: rows.reduce((sum, row) => sum + row.true_positives, 0),
      total_tokens: tokenTotal.value,
      token_completeness: tokenTotal.completeness,
      cost_usd: costTotal.value,
      cost_completeness: costTotal.completeness
    }
  };
}

function parseSummaryRow(value, index, modelSlug) {
  const row = requiredRecord(value, `eval summary row ${index}`);
  if (row.variant_id !== modelSlug) throw new Error(`eval summary row ${index} has the wrong variant`);
  return {
    row_id: requiredString(row.row_id, `eval summary row ${index} id`),
    true_positives: nonNegativeInteger(row.true_positives, `eval summary row ${index} true positives`),
    efficiency: requiredRecord(row.efficiency, `eval summary row ${index} efficiency`)
  };
}

function completeSum(rows, valueField, completenessField, integer) {
  const complete = rows.every((row) => {
    const state = requiredRecord(row.efficiency[completenessField], `${completenessField} completeness`);
    return state.status === "complete";
  });
  if (!complete) return { value: null, completeness: "incomplete" };
  const values = rows.map((row, index) => {
    const value = row.efficiency[valueField];
    if (integer) return nonNegativeInteger(value, `eval summary row ${index} ${valueField}`);
    return nonNegativeNumber(value, `eval summary row ${index} ${valueField}`);
  });
  const total = values.reduce((sum, value) => sum + value, 0);
  return { value: integer ? total : round(total), completeness: "complete" };
}

function comparisonForGroup(key, experiments) {
  const [benchmark, lane, modelSlug] = key.split("\u0000");
  const baseline = experiments.get(BASELINE_EXPERIMENT);
  const candidate = experiments.get(CANDIDATE_EXPERIMENT);
  if (baseline === undefined || candidate === undefined || experiments.size !== 2) {
    throw new Error(`${benchmark}/${modelSlug}/${lane} must contain exactly candidate and without-kadenzipfel`);
  }
  for (const field of [
    "benchmark",
    "lane",
    "model_slug",
    "model",
    "reasoning",
    "judge_model",
    "judge_reasoning",
    "candidate_commit"
  ]) {
    if (baseline.bundle[field] !== candidate.bundle[field]) {
      throw new Error(`${benchmark}/${modelSlug}/${lane} baseline and candidate ${field} values differ`);
    }
  }
  if (baseline.summary.scoring_fingerprint !== candidate.summary.scoring_fingerprint) {
    throw new Error(`${benchmark}/${modelSlug}/${lane} baseline and candidate scoring identities differ`);
  }
  if (JSON.stringify(baseline.summary.row_ids) !== JSON.stringify(candidate.summary.row_ids)) {
    throw new Error(`${benchmark}/${modelSlug}/${lane} baseline and candidate row scopes differ`);
  }
  const baselineMetrics = baseline.summary.metrics;
  const candidateMetrics = candidate.summary.metrics;
  return {
    benchmark,
    lane,
    model_slug: modelSlug,
    model: candidate.bundle.model,
    reasoning: candidate.bundle.reasoning,
    judge: {
      model: candidate.bundle.judge_model,
      reasoning: candidate.bundle.judge_reasoning
    },
    candidate_commit: candidate.bundle.candidate_commit,
    baseline_eval_run_id: baseline.bundle.eval_run_id,
    candidate_eval_run_id: candidate.bundle.eval_run_id,
    baseline: baselineMetrics,
    candidate: candidateMetrics,
    delta: {
      precision: difference(candidateMetrics.precision, baselineMetrics.precision),
      recall: difference(candidateMetrics.recall, baselineMetrics.recall),
      f1_score: difference(candidateMetrics.f1_score, baselineMetrics.f1_score),
      summed_true_positives: candidateMetrics.summed_true_positives - baselineMetrics.summed_true_positives,
      total_tokens: nullableDifference(candidateMetrics.total_tokens, baselineMetrics.total_tokens),
      cost_usd: nullableDifference(candidateMetrics.cost_usd, baselineMetrics.cost_usd)
    }
  };
}

function compareRows(left, right) {
  return (
    compareText(left.benchmark, right.benchmark) ||
    compareText(left.model_slug, right.model_slug) ||
    compareText(left.lane, right.lane)
  );
}

function difference(candidate, baseline) {
  return round(candidate - baseline);
}

function nullableDifference(candidate, baseline) {
  return candidate === null || baseline === null ? null : difference(candidate, baseline);
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 1_000_000_000_000) / 1_000_000_000_000;
}

function metricRow(label, baseline, candidate, delta) {
  return `| ${label} | ${displayValue(baseline)} | ${displayValue(candidate)} | ${displayDelta(delta)} |`;
}

function completeValue(value, completeness) {
  return value === null ? `n/a (${completeness})` : value;
}

function displayValue(value) {
  return String(value);
}

function displayDelta(value) {
  if (value === null) return "n/a";
  if (typeof value === "number" && value > 0) return `+${value}`;
  return String(value);
}

function ratio(value, label) {
  const number = nonNegativeNumber(value, label);
  if (number > 1) throw new Error(`${label} must be between 0 and 1`);
  return round(number);
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

function nonNegativeNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
  return value;
}

function optionalCommit(value, label) {
  if (value === undefined) return undefined;
  const commit = requiredString(value, label);
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`${label} must be a full lowercase SHA`);
  return commit;
}

function safeId(value, label) {
  const id = requiredString(value, label);
  if (!SAFE_ID.test(id)) throw new Error(`${label} is not a safe identifier`);
  return id;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requiredRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`failed to read JSON file ${filePath}`, { cause: error });
  }
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function defaultBundleReader() {
  const module = await import("../../packages/modal/dist/public-bundle.js");
  return module.readPublicBenchmarkBundle;
}

async function main() {
  const [manifestPath, resultsRoot, outputDirectory] = process.argv.slice(2);
  if (manifestPath === undefined || resultsRoot === undefined || outputDirectory === undefined) {
    throw new Error(
      "usage: compare-kadenzipfel-ablation.mjs <manifest.json> <collected-results-root> <output-directory>"
    );
  }
  const result = await compareKadenzipfelAblation({ manifestPath, resultsRoot, outputDirectory });
  process.stdout.write(
    `${JSON.stringify({
      comparisons: result.comparison.comparisons.length,
      json_path: result.jsonPath,
      markdown_path: result.markdownPath
    })}\n`
  );
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
