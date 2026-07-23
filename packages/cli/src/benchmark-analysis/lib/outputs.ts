import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AnalysisResult, ConditionSummary, RowMetric } from "../types.js";
import { fixed, percent, safeJson, toCsv } from "./format.js";

async function writeText(path: string, content: string): Promise<string> {
  await writeFile(path, content, "utf8");
  return path;
}

function rowMetricRecord(row: RowMetric): Record<string, unknown> {
  return {
    row_id: row.rowId,
    condition: row.condition,
    valid: row.valid,
    status: row.status,
    invalid_reason: row.invalidReason,
    findings: row.findings,
    true_positives: row.truePositives,
    false_positives: row.falsePositives,
    needs_human_review: row.needsHumanReview,
    distinct_ground_truth_credits: row.distinctGroundTruthCredits,
    ground_truth_root_cause_ids: row.groundTruthRootCauseIds,
    ground_truth_labels: row.groundTruthLabels,
    ground_truth_count: row.groundTruthCount,
    precision: row.precision,
    recall: row.recall,
    f1: row.f1,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cache_read_tokens: row.cacheReadTokens,
    cache_write_tokens: row.cacheWriteTokens,
    total_tokens: row.totalTokens,
    total_tokens_millions: row.totalTokensMillions,
    estimated_spend_reported: row.estimatedSpendReported,
    estimated_spend_usd: row.estimatedSpendUsd,
    partial_pricing: row.partialPricing,
    priced_event_count: row.pricedEventCount,
    unpriced_event_count: row.unpricedEventCount,
    duplicate_count: row.duplicateCount,
    row_label: row.label
  };
}

function flattenSummary(item: ConditionSummary): Record<string, unknown> {
  const result: Record<string, unknown> = {
    condition: item.condition,
    valid_rows: item.validRows,
    invalid_rows: item.invalidRows
  };
  for (const [metric, values] of Object.entries(item.stats)) {
    result[`${metric}_mean`] = values.mean;
    result[`${metric}_median`] = values.median;
    result[`${metric}_stdev`] = values.stdev;
    result[`${metric}_n`] = values.n;
  }
  return result;
}

export async function writeProvenanceOutputs(result: AnalysisResult, outputDir: string): Promise<string[]> {
  await mkdir(outputDir, { recursive: true });
  const findingRows = result.records.map((record) => ({
    row_id: record.rowId,
    condition: record.condition,
    finding_id: record.findingId,
    qualified_id: record.qualifiedId,
    finding_instance_id: record.findingInstanceId,
    root_cause_cluster_id: record.rootCauseClusterId,
    severity: record.severity,
    title: record.title,
    source_strategies: record.sourceStrategies,
    classification: record.classification,
    matched_source: record.matchedSource,
    matched_candidate_id: record.matchedCandidateId,
    matched_identity: record.matchedIdentity,
    ground_truth_label: record.groundTruthLabel,
    ground_truth_title: record.groundTruthTitle,
    ground_truth_tp_credits: record.groundTruthTpCredits,
    stable_issue_id: record.stableIssueId,
    duplicate_of_finding_instance_id: record.duplicateOfFindingInstanceId
  }));
  const entityRows = result.entities.map((entity) => ({
    root_cause_cluster_id: entity.entityId,
    top_severity: entity.topSeverity,
    classification: entity.classification,
    ground_truth_tp_credits: entity.groundTruthTpCredits,
    rows: [...entity.rows].sort(),
    row_count: entity.rows.size,
    detection_count: entity.members.length,
    qualified_findings: entity.members.map((member) => member.qualifiedId)
  }));
  return [
    await writeText(join(outputDir, "findings_row_provenance.csv"), toCsv(findingRows)),
    await writeText(join(outputDir, "root_cause_provenance.csv"), toCsv(entityRows)),
    await writeText(
      join(outputDir, "provenance.json"),
      safeJson({
        privacy: "private-analysis-output-do-not-commit",
        rows_are_sets: true,
        finding_instances: findingRows,
        root_cause_entities: entityRows,
        row_statuses: result.rowStatuses
      })
    )
  ];
}

export async function writeScoreOutputs(result: AnalysisResult, outputDir: string): Promise<string[]> {
  await mkdir(outputDir, { recursive: true });
  const aggregateRows = result.conditionAggregate.map((item) => ({
    condition: item.condition,
    valid_rows: item.validRows,
    invalid_rows: item.invalidRows,
    findings: item.findings,
    true_positives: item.truePositives,
    false_positives: item.falsePositives,
    needs_human_review: item.needsHumanReview,
    duplicate_count: item.duplicateCount,
    distinct_ground_truth_credits: item.distinctGroundTruthCredits,
    ground_truth_root_cause_ids: item.groundTruthRootCauseIds,
    pooled_precision: item.pooledPrecision,
    union_recall: item.unionRecall,
    union_f1: item.unionF1,
    valid_tokens_millions: item.validTokensMillions,
    all_run_tokens_millions: item.allRunTokensMillions
  }));
  return [
    await writeText(join(outputDir, "row_scores.csv"), toCsv(result.rowMetrics.map(rowMetricRecord))),
    await writeText(join(outputDir, "condition_score_summary.csv"), toCsv(result.conditionSummary.map(flattenSummary))),
    await writeText(join(outputDir, "condition_aggregate.csv"), toCsv(aggregateRows))
  ];
}

function metric(value: number | null, asPercent = false): string {
  return asPercent ? percent(value) : fixed(value);
}

function spend(row: RowMetric): string {
  return row.estimatedSpendUsd !== null && row.pricedEventCount > 0 ? `$${row.estimatedSpendUsd.toFixed(2)}+` : "—";
}

function markdownCell(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/\r?\n/gu, "<br>");
}

export async function writeTableOutputs(result: AnalysisResult, outputDir: string): Promise<string[]> {
  await mkdir(outputDir, { recursive: true });
  const lookup = new Map(result.rowMetrics.map((row) => [row.rowId, row]));
  const orderedRows = result.rowOrder.flatMap((rowId) => {
    const row = lookup.get(rowId);
    return row ? [row] : [];
  });
  const lines = [
    "# Row-level benchmark results",
    "",
    "> Private analysis output: this report may contain finding and ground-truth details. Do not commit it.",
    "",
    "Root-cause credits use the finalized global adjudication. A single detected cluster may receive more than one credit when it covers multiple underlying ground-truth causes.",
    "",
    "## Row quality",
    "",
    "| Row | Condition | GT credits | Precision | Recall | F1 |",
    "| --- | --- | ---: | ---: | ---: | ---: |"
  ];
  for (const row of orderedRows) {
    lines.push(
      `| ${markdownCell(row.label)} | ${markdownCell(row.condition)} | ${row.distinctGroundTruthCredits ?? "NA"} | ${percent(row.precision)} | ${percent(row.recall)} | ${percent(row.f1)} |`
    );
  }

  lines.push(
    "",
    "## Finding disposition",
    "",
    "| Row | Findings | TP | FP | Review | Dup |",
    "| --- | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const row of orderedRows) {
    lines.push(
      `| ${markdownCell(row.label)} | ${row.findings ?? "NA"} | ${row.truePositives ?? "NA"} | ${row.falsePositives ?? "NA"} | ${row.needsHumanReview ?? "NA"} | ${row.duplicateCount ?? "NA"} |`
    );
  }

  lines.push("", "## Compute and spend", "", "| Row | Tokens (M) | Reported USD* |", "| --- | ---: | ---: |");
  for (const row of orderedRows) {
    lines.push(`| ${markdownCell(row.label)} | ${fixed(row.totalTokensMillions)} | ${spend(row)} |`);
  }

  lines.push(
    "",
    "*Reported USD is a partial lower bound. Total tokens are used as the comparable cost proxy.*",
    "",
    "## Condition quality",
    "",
    "| Condition | Rows | GT credits | Pooled precision | Union recall | Union F1 |",
    "| --- | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const item of result.conditionAggregate) {
    lines.push(
      `| ${markdownCell(item.condition)} | ${item.validRows} | ${item.distinctGroundTruthCredits} | ${percent(item.pooledPrecision)} | ${percent(item.unionRecall)} | ${percent(item.unionF1)} |`
    );
  }

  lines.push(
    "",
    "## Condition finding disposition",
    "",
    "| Condition | Findings | TP | FP | Review | Dup |",
    "| --- | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const item of result.conditionAggregate) {
    lines.push(
      `| ${markdownCell(item.condition)} | ${item.findings} | ${item.truePositives} | ${item.falsePositives} | ${item.needsHumanReview} | ${item.duplicateCount} |`
    );
  }

  lines.push("", "## Condition compute", "", "| Condition | Tokens (M) |", "| --- | ---: |");
  for (const item of result.conditionAggregate) {
    lines.push(`| ${markdownCell(item.condition)} | ${fixed(item.allRunTokensMillions)} |`);
  }

  lines.push(
    "",
    "## Row summaries",
    "",
    "| Condition | Metric | n | Average | Median | Sample SD |",
    "| --- | --- | ---: | ---: | ---: | ---: |"
  );
  const summaryMetrics: Array<[string, string, boolean]> = [
    ["distinctGroundTruthCredits", "Ground-truth credits / row", false],
    ["duplicateCount", "Duplicates / row", false],
    ["precision", "Precision", true],
    ["recall", "Recall", true],
    ["f1", "F1", true],
    ["totalTokensMillions", "Total tokens (M)", false]
  ];
  for (const summary of result.conditionSummary) {
    for (const [key, label, asPercent] of summaryMetrics) {
      const item = summary.stats[key];
      if (!item) continue;
      lines.push(
        `| ${markdownCell(summary.condition)} | ${label} | ${item.n} | ${metric(item.mean, asPercent)} | ${metric(item.median, asPercent)} | ${metric(item.stdev, asPercent)} |`
      );
    }
  }

  if (result.pairComparison.length > 0) {
    lines.push(
      "",
      "## Paired score comparison",
      "",
      "| Pair | Rows | GT credits | F1 | Tokens (M) |",
      "| --- | --- | ---: | ---: | ---: |"
    );
    for (const pair of result.pairComparison) {
      lines.push(
        `| ${markdownCell(pair.pair)} | ${markdownCell(`${pair.ultrafuzz.rowId} / ${pair.noFuzz.rowId}`)} | ${pair.ultrafuzz.distinctGroundTruthCredits ?? "NA"} / ${pair.noFuzz.distinctGroundTruthCredits ?? "NA"} | ${percent(pair.ultrafuzz.f1)} / ${percent(pair.noFuzz.f1)} | ${fixed(pair.ultrafuzz.totalTokensMillions)} / ${fixed(pair.noFuzz.totalTokensMillions)} |`
      );
    }

    lines.push(
      "",
      "## Paired detection overlap",
      "",
      "| Pair | Shared clusters | Ultrafuzz-only | no-fuzz-only |",
      "| --- | --- | --- | --- |"
    );
    for (const pair of result.pairComparison) {
      lines.push(
        `| ${markdownCell(pair.pair)} | ${markdownCell(pair.sharedRootCauseIds.join(", ") || "—")} | ${markdownCell(pair.ultrafuzzOnlyRootCauseIds.join(", ") || "—")} | ${markdownCell(pair.noFuzzOnlyRootCauseIds.join(", ") || "—")} |`
      );
    }
  } else {
    lines.push(
      "",
      "## Cross-row ranking",
      "",
      "| Rank | Row | Condition | GT credits | F1 |",
      "| ---: | --- | --- | ---: | ---: |"
    );
    for (const [index, row] of rankedRows(result).entries()) {
      lines.push(
        `| ${index + 1} | ${markdownCell(row.label)} | ${markdownCell(row.condition)} | ${row.distinctGroundTruthCredits ?? "NA"} | ${percent(row.f1)} |`
      );
    }
  }

  const matched = new Map(
    result.records
      .filter(
        (record) => record.classification === "true-positive" && record.groundTruthLabel && record.groundTruthTitle
      )
      .map((record) => [record.groundTruthLabel as string, record.groundTruthTitle as string])
  );
  lines.push("", "## Matched canonical ground truth", "", "| Label | Title |", "| --- | --- |");
  if (matched.size === 0) lines.push("| — | No canonical labels were mapped. | ");
  for (const [label, title] of [...matched].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`| ${markdownCell(label)} | ${markdownCell(title)} |`);
  }
  lines.push(
    "",
    `Recall denominator: ${result.groundTruthCount} canonical ground-truth causes. Needs-human-review findings are excluded from precision.`,
    ""
  );

  const pairRows = result.pairComparison.map((pair) => ({
    pair: pair.pair,
    ultrafuzz_row: pair.ultrafuzz.rowId,
    no_fuzz_row: pair.noFuzz.rowId,
    ultrafuzz_ground_truth_credits: pair.ultrafuzz.distinctGroundTruthCredits,
    no_fuzz_ground_truth_credits: pair.noFuzz.distinctGroundTruthCredits,
    credit_delta_no_fuzz_minus_ultrafuzz: pair.creditDeltaNoFuzzMinusUltrafuzz,
    ultrafuzz_f1: pair.ultrafuzz.f1,
    no_fuzz_f1: pair.noFuzz.f1,
    f1_delta_no_fuzz_minus_ultrafuzz: pair.f1DeltaNoFuzzMinusUltrafuzz,
    ultrafuzz_tokens_millions: pair.ultrafuzz.totalTokensMillions,
    no_fuzz_tokens_millions: pair.noFuzz.totalTokensMillions,
    token_delta_no_fuzz_minus_ultrafuzz_millions: pair.tokenDeltaNoFuzzMinusUltrafuzzMillions,
    shared_root_cause_ids: pair.sharedRootCauseIds,
    ultrafuzz_only_root_cause_ids: pair.ultrafuzzOnlyRootCauseIds,
    no_fuzz_only_root_cause_ids: pair.noFuzzOnlyRootCauseIds
  }));
  const rootsByRow = result.rowMetrics.map((row) => ({
    row_id: row.rowId,
    row_label: row.label,
    condition: row.condition,
    ground_truth_credit_count: row.distinctGroundTruthCredits,
    ground_truth_root_cause_ids: row.groundTruthRootCauseIds,
    canonical_labels: row.groundTruthLabels
  }));
  const comparisonPath =
    result.pairComparison.length > 0
      ? await writeText(join(outputDir, "paired_row_comparison.csv"), toCsv(pairRows))
      : await writeText(
          join(outputDir, "row_comparison.csv"),
          toCsv(
            rankedRows(result).map((row, index) => ({
              rank: index + 1,
              row_id: row.rowId,
              row_label: row.label,
              condition: row.condition,
              ground_truth_credits: row.distinctGroundTruthCredits,
              precision: row.precision,
              recall: row.recall,
              f1: row.f1,
              total_tokens_millions: row.totalTokensMillions
            }))
          )
        );
  return [
    await writeText(join(outputDir, "row_results_table.md"), lines.join("\n")),
    comparisonPath,
    await writeText(join(outputDir, "ground_truth_credits_by_row.csv"), toCsv(rootsByRow))
  ];
}

function rankedRows(result: AnalysisResult): RowMetric[] {
  return [...result.rowMetrics].sort(
    (left, right) =>
      (right.f1 ?? -1) - (left.f1 ?? -1) ||
      (right.distinctGroundTruthCredits ?? -1) - (left.distinctGroundTruthCredits ?? -1) ||
      left.totalTokensMillions - right.totalTokensMillions ||
      left.rowId.localeCompare(right.rowId)
  );
}

export async function writeMethodOutputs(result: AnalysisResult, outputDir: string): Promise<string[]> {
  await mkdir(outputDir, { recursive: true });
  const method = `# Method

> Private analysis output: this directory may contain finding and ground-truth details. Do not commit it.

- Input is discovered from \`handoff/current-state.json\`; no target, repository, or finding constants are compiled into the CLI.
- Finding classifications and clusters come from the handoff's finalized \`instance-to-cluster.json\`.
- Sets are benchmark rows and entities are globally adjudicated root-cause clusters.
- Precision = TP / (TP + FP + duplicates); unresolved findings are excluded.
- Recall = distinct ground-truth TP credits / ${result.groundTruthCount}. Multi-root clusters contribute their explicit credit multiplicity.
- Average, median, and sample standard deviation use finalized rows.
- Compute cost is total tokens from each nested row \`run.json\`; reported USD values may be partial.
`;
  const sourceManifest = {
    schema_version: "ultrafuzz.benchmark-analysis.source.v1",
    privacy: "private-analysis-output-do-not-commit",
    source_archive: result.sourceArchive,
    source_size_bytes: result.sourceSizeBytes,
    source_sha256: result.sourceSha256,
    archive_root: result.archiveRoot,
    handoff_schema_version: result.handoffSchemaVersion,
    adjudication_output_path: result.outputPath,
    rows: result.rows.map((row) => ({
      row_id: row.rowId,
      row_label: row.label,
      condition: row.condition,
      variant: row.variant
    })),
    ground_truth_count: result.groundTruthCount
  };
  return [
    await writeText(join(outputDir, "METHOD.md"), method),
    await writeText(join(outputDir, "source_manifest.json"), safeJson(sourceManifest))
  ];
}
