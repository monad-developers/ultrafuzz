import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";

import { assertRunMetadataDocument } from "@ultrafuzz/artifacts";
import {
  assertBenchmarkAnalysisSources,
  parseAdjudicationHandoff,
  parseBenchmarkFindingManifest,
  parseBenchmarkGroundTruthCredits,
  parseBenchmarkInstanceClusters,
  type BenchmarkSourceSeverity
} from "@ultrafuzz/evals";

import type {
  Accounting,
  AnalysisResult,
  BenchmarkRow,
  ConditionAggregate,
  ConditionSummary,
  FindingEntity,
  FindingRecord,
  PairComparison,
  RowMetric,
  RowStatus,
  Severity
} from "../types.js";
import { SEVERITY_ORDER } from "../types.js";
import { BundleArchive } from "./archive.js";
import { harmonicMean, stats, sum } from "./stats.js";

const SEVERITY_RANK: Record<Severity, number> = { H: 3, M: 2, L: 1 };
const SEVERITY_CODES: Record<BenchmarkSourceSeverity, Severity> = {
  High: "H",
  Medium: "M",
  Low: "L"
};

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function accountingFrom(runPayload: unknown, expectedRunId: string): Accounting {
  const run = assertRunMetadataDocument(runPayload, expectedRunId);
  const cumulative = run.accounting?.cumulative;
  if (cumulative === undefined) throw new Error("Nested run.json has no accounting.cumulative block");
  const totalTokens = cumulative.total_tokens;
  return {
    inputTokens: cumulative.input_tokens,
    outputTokens: cumulative.output_tokens,
    cacheReadTokens: cumulative.cache_read_tokens,
    cacheWriteTokens: cumulative.cache_write_tokens,
    totalTokens,
    totalTokensMillions: totalTokens / 1_000_000,
    estimatedSpendReported: cumulative.estimated_spend,
    estimatedSpendUsd: cumulative.estimated_spend_usd ?? null,
    partialPricing: cumulative.partial_pricing,
    pricedEventCount: cumulative.priced_event_count,
    unpricedEventCount: cumulative.unpriced_event_count
  };
}

function rowOrder(rows: BenchmarkRow[]): string[] {
  return [...rows].sort((left, right) => left.order - right.order).map((row) => row.rowId);
}

function buildEntities(records: FindingRecord[], creditByCluster: Map<string, number>): FindingEntity[] {
  const grouped = new Map<string, FindingRecord[]>();
  for (const record of records)
    grouped.set(record.rootCauseClusterId, [...(grouped.get(record.rootCauseClusterId) ?? []), record]);
  return [...grouped.entries()]
    .map(([entityId, members]) => {
      const first = members[0];
      if (first === undefined) throw new Error(`Root-cause cluster ${entityId} has no findings`);
      const groundTruthTpCredits = creditByCluster.get(entityId);
      if (groundTruthTpCredits === undefined) throw new Error(`Root-cause cluster ${entityId} has no credit record`);
      const classifications = new Set(members.map((member) => member.classification));
      if (classifications.size !== 1) throw new Error(`Cluster ${entityId} has inconsistent final classifications`);
      const topSeverity = members.reduce<Severity>(
        (best, member) => (SEVERITY_RANK[member.severity] > SEVERITY_RANK[best] ? member.severity : best),
        first.severity
      );
      return {
        entityId,
        members,
        rows: new Set(members.map((member) => member.rowId)),
        topSeverity,
        classification: first.classification,
        groundTruthTpCredits
      };
    })
    .sort((left, right) => left.entityId.localeCompare(right.entityId));
}

function rowMetrics(
  rows: BenchmarkRow[],
  records: FindingRecord[],
  entities: FindingEntity[],
  accounting: Map<string, Accounting>,
  groundTruthCount: number
): RowMetric[] {
  return rows.map((row) => {
    const cost = accounting.get(row.rowId);
    if (!cost) throw new Error(`Missing accounting for ${row.rowId}`);
    const rowRecords = records.filter((record) => record.rowId === row.rowId);
    const rowEntities = entities.filter((entity) => entity.rows.has(row.rowId));
    const truePositives = rowRecords.filter(
      (record) => record.classification === "true-positive" && !record.isDuplicate
    ).length;
    const falsePositives = rowRecords.filter(
      (record) => record.classification === "false-positive" && !record.isDuplicate
    ).length;
    const needsHumanReview = rowRecords.filter(
      (record) => record.classification === "needs-human-review" && !record.isDuplicate
    ).length;
    const duplicateCount = rowRecords.filter((record) => record.isDuplicate).length;
    const resolvedDuplicateCount = rowRecords.filter(
      (record) => record.isDuplicate && record.classification !== "needs-human-review"
    ).length;
    const detected = rowEntities.filter(
      (entity) => entity.classification === "true-positive" && entity.groundTruthTpCredits > 0
    );
    const distinctGroundTruthCredits = sum(detected.map((entity) => entity.groundTruthTpCredits));
    const groundTruthRootCauseIds = detected.map((entity) => entity.entityId).sort();
    const groundTruthLabels = detected
      .flatMap((entity) =>
        entity.members.map((member) => member.groundTruthLabel).filter((value): value is string => value !== null)
      )
      .filter((value, index, values) => values.indexOf(value) === index)
      .sort();
    const resolved = truePositives + falsePositives + resolvedDuplicateCount;
    const precision = resolved > 0 ? truePositives / resolved : null;
    const recall = groundTruthCount > 0 ? distinctGroundTruthCredits / groundTruthCount : null;
    return {
      rowId: row.rowId,
      label: row.label,
      condition: row.condition,
      valid: true,
      status: "valid",
      invalidReason: null,
      findings: rowRecords.length,
      truePositives,
      falsePositives,
      needsHumanReview,
      duplicateCount,
      resolvedDuplicateCount,
      distinctGroundTruthCredits,
      groundTruthRootCauseIds,
      groundTruthLabels,
      groundTruthCount,
      precision,
      recall,
      f1: harmonicMean(precision, recall),
      ...cost
    };
  });
}

function conditionSummaries(metrics: RowMetric[], conditions: string[]): ConditionSummary[] {
  const fields = [
    "findings",
    "truePositives",
    "distinctGroundTruthCredits",
    "duplicateCount",
    "totalTokensMillions",
    "precision",
    "recall",
    "f1"
  ] as const;
  return conditions.map((condition) => {
    const conditionRows = metrics.filter((row) => row.condition === condition);
    const fieldStats: Record<string, ReturnType<typeof stats>> = {};
    for (const field of fields) fieldStats[field] = stats(conditionRows.map((row) => row[field]));
    return { condition, validRows: conditionRows.length, invalidRows: 0, stats: fieldStats };
  });
}

function conditionAggregates(
  metrics: RowMetric[],
  entities: FindingEntity[],
  conditions: string[],
  groundTruthCount: number
): ConditionAggregate[] {
  return conditions.map((condition) => {
    const rows = metrics.filter((row) => row.condition === condition);
    const rowIds = new Set(rows.map((row) => row.rowId));
    const detected = entities.filter(
      (entity) =>
        entity.classification === "true-positive" &&
        entity.groundTruthTpCredits > 0 &&
        [...entity.rows].some((row) => rowIds.has(row))
    );
    const distinctGroundTruthCredits = sum(detected.map((entity) => entity.groundTruthTpCredits));
    const truePositives = sum(rows.map((row) => row.truePositives ?? 0));
    const falsePositives = sum(rows.map((row) => row.falsePositives ?? 0));
    const duplicateCount = sum(rows.map((row) => row.duplicateCount ?? 0));
    const resolvedDuplicateCount = sum(rows.map((row) => row.resolvedDuplicateCount ?? 0));
    const resolved = truePositives + falsePositives + resolvedDuplicateCount;
    const pooledPrecision = resolved > 0 ? truePositives / resolved : null;
    const unionRecall = groundTruthCount > 0 ? distinctGroundTruthCredits / groundTruthCount : null;
    return {
      condition,
      validRows: rows.length,
      invalidRows: 0,
      findings: sum(rows.map((row) => row.findings ?? 0)),
      truePositives,
      falsePositives,
      needsHumanReview: sum(rows.map((row) => row.needsHumanReview ?? 0)),
      duplicateCount,
      distinctGroundTruthCredits,
      groundTruthRootCauseIds: detected.map((entity) => entity.entityId).sort(),
      pooledPrecision,
      unionRecall,
      unionF1: harmonicMean(pooledPrecision, unionRecall),
      validTokensMillions: sum(rows.map((row) => row.totalTokensMillions)),
      allRunTokensMillions: sum(rows.map((row) => row.totalTokensMillions))
    };
  });
}

function pairComparisons(metrics: RowMetric[], rows: BenchmarkRow[]): PairComparison[] {
  const lookup = new Map(metrics.map((row) => [row.rowId, row]));
  const grouped = new Map<string, BenchmarkRow[]>();
  for (const row of rows) {
    const pair = /([0-9]+)$/u.exec(row.rowId)?.[1];
    if (pair) grouped.set(pair, [...(grouped.get(pair) ?? []), row]);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => Number(left) - Number(right))
    .flatMap(([pair, pairRows]) => {
      const ultrafuzzRow = pairRows.find((row) => row.variant === "default");
      const noFuzzRow = pairRows.find((row) => row.variant === "no-fuzz");
      if (!ultrafuzzRow || !noFuzzRow) return [];
      const ultrafuzz = lookup.get(ultrafuzzRow.rowId);
      const noFuzz = lookup.get(noFuzzRow.rowId);
      if (!ultrafuzz || !noFuzz) return [];
      const left = new Set(ultrafuzz.groundTruthRootCauseIds);
      const right = new Set(noFuzz.groundTruthRootCauseIds);
      return [
        {
          pair,
          ultrafuzz,
          noFuzz,
          sharedRootCauseIds: [...left].filter((id) => right.has(id)).sort(),
          ultrafuzzOnlyRootCauseIds: [...left].filter((id) => !right.has(id)).sort(),
          noFuzzOnlyRootCauseIds: [...right].filter((id) => !left.has(id)).sort(),
          creditDeltaNoFuzzMinusUltrafuzz:
            (noFuzz.distinctGroundTruthCredits ?? 0) - (ultrafuzz.distinctGroundTruthCredits ?? 0),
          f1DeltaNoFuzzMinusUltrafuzz: ultrafuzz.f1 !== null && noFuzz.f1 !== null ? noFuzz.f1 - ultrafuzz.f1 : null,
          tokenDeltaNoFuzzMinusUltrafuzzMillions: noFuzz.totalTokensMillions - ultrafuzz.totalTokensMillions
        }
      ];
    });
}

export async function analyzeArchive(archivePath: string): Promise<AnalysisResult> {
  const archive = new BundleArchive(archivePath);
  const handoff = parseAdjudicationHandoff(
    archive.readJson("handoff/current-state.json"),
    `${archive.root}handoff/current-state.json`
  );
  const outputPath = handoff.provenance.outputPath;
  const manifest = parseBenchmarkFindingManifest(
    archive.readJson(`${outputPath}/finding-manifest.json`),
    `${archive.root}${outputPath}/finding-manifest.json`
  );
  const instanceClusters = parseBenchmarkInstanceClusters(
    archive.readJson(`${outputPath}/instance-to-cluster.json`),
    `${archive.root}${outputPath}/instance-to-cluster.json`
  );
  const credits = parseBenchmarkGroundTruthCredits(
    archive.readJson(`${outputPath}/ground-truth-tp-credits.json`),
    `${archive.root}${outputPath}/ground-truth-tp-credits.json`
  );
  assertBenchmarkAnalysisSources({ manifest, instanceClusters, credits });

  const rows = manifest.rows.map((row) => ({
    rowId: row.rowId,
    label: row.label,
    variant: row.variant,
    condition: row.condition,
    order: row.order
  }));
  const conditions = [...new Set(rows.map((row) => row.condition))];
  const candidates = new Map(manifest.candidateCatalog.map((candidate) => [candidate.candidateId, candidate]));
  const groundTruthCount = manifest.candidateCatalog.length;
  const creditByCluster = new Map(
    credits.clusters.map((credit) => [credit.rootCauseClusterId, credit.groundTruthTpCredits])
  );
  const sourceFindings = new Map(manifest.findingInstances.map((finding) => [finding.findingInstanceId, finding]));

  const records = instanceClusters.instances.map((mapping) => {
    const source = sourceFindings.get(mapping.findingInstanceId);
    if (source === undefined) throw new Error(`No source finding for ${mapping.findingInstanceId}`);
    const row = rows.find((candidate) => candidate.rowId === mapping.rowId);
    if (row === undefined) throw new Error(`Mapping references unknown row ${mapping.rowId}`);
    const matchedCandidate = mapping.matchedCandidateId === null ? null : candidates.get(mapping.matchedCandidateId);
    if (mapping.matchedCandidateId !== null && matchedCandidate === undefined) {
      throw new Error(`Unknown matched candidate ${mapping.matchedCandidateId}`);
    }
    const groundTruthTpCredits = creditByCluster.get(mapping.rootCauseClusterId);
    if (groundTruthTpCredits === undefined) {
      throw new Error(`No ground-truth credit record for ${mapping.rootCauseClusterId}`);
    }
    return {
      rowId: mapping.rowId,
      condition: row.condition,
      issueIndex: mapping.issueIndex,
      findingId: source.findingId,
      qualifiedId: `${mapping.rowId}:${source.findingId}`,
      severity: SEVERITY_CODES[source.severity],
      title: source.title,
      classification: mapping.instanceClassification,
      matchedSource: mapping.matchedSource,
      matchedCandidateId: mapping.matchedCandidateId,
      matchedIdentity: matchedCandidate?.candidateId ?? null,
      groundTruthLabel: matchedCandidate?.label ?? null,
      groundTruthTitle: matchedCandidate?.title ?? null,
      stableIssueId: mapping.stableIssueId,
      findingInstanceId: mapping.findingInstanceId,
      rootCauseClusterId: mapping.rootCauseClusterId,
      duplicateOfFindingInstanceId: mapping.duplicateOfFindingInstanceId,
      isDuplicate: mapping.duplicateOfFindingInstanceId !== null,
      groundTruthTpCredits,
      sourceStrategies: source.sourceArtifactRefs.map((reference) => reference.nodeId)
    } satisfies FindingRecord;
  });

  const accounting = new Map<string, Accounting>();
  for (const sourceRow of manifest.rows) {
    const nested = await archive.readNestedJson(sourceRow.rowArchivePath, { run: sourceRow.runMetadataPath });
    accounting.set(sourceRow.rowId, accountingFrom(nested.run, sourceRow.runId));
  }

  const entities = buildEntities(records, creditByCluster);
  const metrics = rowMetrics(rows, records, entities, accounting, groundTruthCount);
  const sourceStat = await stat(archivePath);
  const statuses: RowStatus[] = rows.map((row) => ({
    rowId: row.rowId,
    condition: row.condition,
    valid: true,
    status: "valid",
    reason: null
  }));
  return {
    sourceArchive: basename(archivePath),
    sourceSizeBytes: sourceStat.size,
    sourceSha256: await sha256(archivePath),
    archiveRoot: archive.root,
    handoffSchemaVersion: handoff.schema_version,
    outputPath,
    rows,
    rowOrder: rowOrder(rows),
    conditions,
    groundTruthCount,
    records,
    entities,
    rowStatuses: statuses,
    rowMetrics: metrics,
    conditionSummary: conditionSummaries(metrics, conditions),
    conditionAggregate: conditionAggregates(metrics, entities, conditions, groundTruthCount),
    pairComparison: pairComparisons(metrics, rows)
  };
}

export function orderedSetRows(result: AnalysisResult): string[] {
  const rowPosition = new Map(result.rowOrder.map((row, index) => [row, index]));
  return [...result.rows]
    .sort((left, right) => {
      const leftCount = result.entities.filter((entity) => entity.rows.has(left.rowId)).length;
      const rightCount = result.entities.filter((entity) => entity.rows.has(right.rowId)).length;
      return rightCount - leftCount || (rowPosition.get(left.rowId) ?? 99) - (rowPosition.get(right.rowId) ?? 99);
    })
    .map((row) => row.rowId);
}

export function intersectionGroups(result: AnalysisResult): Array<{ rows: Set<string>; entities: FindingEntity[] }> {
  const orderedRows = orderedSetRows(result);
  const rowPosition = new Map(orderedRows.map((row, index) => [row, index]));
  const grouped = new Map<string, { rows: Set<string>; entities: FindingEntity[] }>();
  for (const entity of result.entities) {
    const rows = [...entity.rows].sort((left, right) => (rowPosition.get(left) ?? 99) - (rowPosition.get(right) ?? 99));
    const key = rows.join(";");
    const group = grouped.get(key) ?? { rows: new Set(rows), entities: [] };
    group.entities.push(entity);
    grouped.set(key, group);
  }
  return [...grouped.values()].sort((left, right) => {
    if (right.entities.length !== left.entities.length) return right.entities.length - left.entities.length;
    if (right.rows.size !== left.rows.size) return right.rows.size - left.rows.size;
    const leftKey = [...left.rows].join(";");
    const rightKey = [...right.rows].join(";");
    return leftKey.localeCompare(rightKey);
  });
}

export function severityCounts<T>(items: T[], severity: (item: T) => Severity): Record<Severity, number> {
  return Object.fromEntries(
    SEVERITY_ORDER.map((value) => [value, items.filter((item) => severity(item) === value).length])
  ) as Record<Severity, number>;
}
