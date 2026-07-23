import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";

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
import { BundleArchive, normalizeRelativePath } from "./archive.js";
import { harmonicMean, stats, sum } from "./stats.js";

type JsonRecord = Record<string, unknown>;

const SEVERITY_RANK: Record<Severity, number> = { H: 3, M: 2, L: 1, I: 0 };
const SEVERITY_NAMES: Record<string, Severity> = {
  high: "H",
  medium: "M",
  low: "L",
  informational: "I",
  info: "I"
};

function asObject(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing ${label}`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function severityFor(value: unknown, title: string): Severity {
  const named = typeof value === "string" ? SEVERITY_NAMES[value.toLowerCase()] : undefined;
  const prefix = /^\[([HMLI])-/u.exec(title)?.[1] as Severity | undefined;
  const severity = named ?? prefix;
  if (!severity || !SEVERITY_ORDER.includes(severity))
    throw new Error(`Unsupported finding severity: ${String(value)}`);
  if (named && prefix && named !== prefix) throw new Error(`Finding title and severity disagree: ${title}`);
  return severity;
}

function findingLabel(title: string, severity: Severity, issueIndex: number): { id: string; title: string } {
  const match = /^\[([HMLI])-([0-9]+)\]\s*-\s*(.+)$/u.exec(title);
  if (!match) return { id: `${severity}-${String(issueIndex + 1).padStart(2, "0")}`, title };
  return { id: `${match[1]}-${match[2]}`, title: match[3] as string };
}

function candidateLabel(heading: string | null): { label: string | null; title: string | null } {
  if (!heading) return { label: null, title: null };
  const match = /^\[([HMLI]-[0-9]+)\]\s*-\s*(.+)$/u.exec(heading);
  return match ? { label: match[1] as string, title: match[2] as string } : { label: null, title: heading };
}

function conditionLabel(variant: string): string {
  return variant === "default" ? "Ultrafuzz" : variant;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function accountingFrom(runPayload: unknown): Accounting {
  const run = asObject(runPayload);
  const accounting = asObject(run.accounting);
  const current = asObject(accounting.current ?? accounting.cumulative);
  if (Object.keys(current).length === 0)
    throw new Error("Nested run.json has no current or cumulative accounting block");
  const totalTokens = finiteNumber(current.total_tokens);
  return {
    inputTokens: finiteNumber(current.input_tokens),
    outputTokens: finiteNumber(current.output_tokens),
    cacheReadTokens: finiteNumber(current.cache_read_tokens),
    cacheWriteTokens: finiteNumber(current.cache_write_tokens),
    totalTokens,
    totalTokensMillions: totalTokens / 1_000_000,
    estimatedSpendReported: optionalString(current.estimated_spend),
    estimatedSpendUsd: typeof current.estimated_spend_usd === "number" ? current.estimated_spend_usd : null,
    partialPricing: Boolean(current.partial_pricing),
    pricedEventCount: finiteNumber(current.priced_event_count),
    unpricedEventCount: finiteNumber(current.unpriced_event_count)
  };
}

function rowOrder(rows: BenchmarkRow[]): string[] {
  const conditionOrder = new Map(["default", "no-fuzz"].map((condition, index) => [condition, index]));
  return [...rows]
    .sort((left, right) => {
      if (left.order !== null || right.order !== null) {
        const explicit = (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER);
        if (explicit !== 0) return explicit;
      }
      const leftMatch = /^(.*?)([0-9]+)$/u.exec(left.rowId);
      const rightMatch = /^(.*?)([0-9]+)$/u.exec(right.rowId);
      const numeric =
        finiteNumber(Number(leftMatch?.[2]), Number.MAX_SAFE_INTEGER) -
        finiteNumber(Number(rightMatch?.[2]), Number.MAX_SAFE_INTEGER);
      if (numeric !== 0) return numeric;
      const condition = (conditionOrder.get(left.variant) ?? 99) - (conditionOrder.get(right.variant) ?? 99);
      return condition || left.rowId.localeCompare(right.rowId);
    })
    .map((row) => row.rowId);
}

function buildEntities(records: FindingRecord[], creditByCluster: Map<string, number>): FindingEntity[] {
  const grouped = new Map<string, FindingRecord[]>();
  for (const record of records)
    grouped.set(record.rootCauseClusterId, [...(grouped.get(record.rootCauseClusterId) ?? []), record]);
  return [...grouped.entries()]
    .map(([entityId, members]) => {
      const classifications = new Set(members.map((member) => member.classification));
      if (classifications.size !== 1) throw new Error(`Cluster ${entityId} has inconsistent final classifications`);
      const topSeverity = members.reduce<Severity>(
        (best, member) => (SEVERITY_RANK[member.severity] > SEVERITY_RANK[best] ? member.severity : best),
        members[0]?.severity ?? "I"
      );
      return {
        entityId,
        members,
        rows: new Set(members.map((member) => member.rowId)),
        topSeverity,
        classification: members[0]?.classification ?? "needs-human-review",
        groundTruthTpCredits: creditByCluster.get(entityId) ?? 0
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
    const resolved = truePositives + falsePositives + duplicateCount;
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
    const valid = conditionRows.filter((row) => row.valid);
    const fieldStats: Record<string, ReturnType<typeof stats>> = {};
    for (const field of fields) fieldStats[field] = stats(valid.map((row) => row[field]));
    return { condition, validRows: valid.length, invalidRows: conditionRows.length - valid.length, stats: fieldStats };
  });
}

function conditionAggregates(
  metrics: RowMetric[],
  entities: FindingEntity[],
  conditions: string[],
  groundTruthCount: number
): ConditionAggregate[] {
  return conditions.map((condition) => {
    const allRows = metrics.filter((row) => row.condition === condition);
    const rows = allRows.filter((row) => row.valid);
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
    const resolved = truePositives + falsePositives + duplicateCount;
    const pooledPrecision = resolved > 0 ? truePositives / resolved : null;
    const unionRecall = groundTruthCount > 0 ? distinctGroundTruthCredits / groundTruthCount : null;
    return {
      condition,
      validRows: rows.length,
      invalidRows: allRows.length - rows.length,
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
      allRunTokensMillions: sum(allRows.map((row) => row.totalTokensMillions))
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
  const currentState = archive.readJson<JsonRecord>("handoff/current-state.json");
  const handoffSchemaVersion = requiredString(currentState.schemaVersion, "handoff schema version");
  const provenance = asObject(currentState.provenance);
  const outputPath = normalizeRelativePath(requiredString(provenance.outputPath, "handoff provenance.outputPath"));
  const manifest = archive.readJson<JsonRecord>(`${outputPath}/finding-manifest.json`);
  const mappings = archive.readJson<unknown[]>(`${outputPath}/instance-to-cluster.json`);
  const creditPayload = archive.readJson<JsonRecord>(`${outputPath}/ground-truth-tp-credits.json`);

  const rowIds = asArray(manifest.rows).map((value) => requiredString(value, "row id"));
  if (rowIds.length === 0 || new Set(rowIds).size !== rowIds.length)
    throw new Error("Finding manifest has no unique rows");
  const rowMetadata = asObject(manifest.rowMetadata);
  const rows = rowIds.map((rowId) => {
    const { variant } = archive.findRowArchive(rowId);
    const metadata = asObject(rowMetadata[rowId]);
    const rawOrder = metadata.order;
    return {
      rowId,
      label: optionalString(metadata.label) ?? rowId,
      variant,
      condition: optionalString(metadata.condition) ?? conditionLabel(variant),
      order: typeof rawOrder === "number" && Number.isFinite(rawOrder) ? rawOrder : null
    };
  });
  const conditions = [...new Set(rows.map((row) => row.condition))];

  const candidates = new Map(
    asArray(manifest.candidateCatalog).map((value) => {
      const candidate = asObject(value);
      return [
        requiredString(candidate.candidateId, "candidate ID"),
        requiredString(candidate.heading, "candidate heading")
      ] as const;
    })
  );
  const groundTruthCount = asArray(manifest.candidateCatalog).filter(
    (value) => asObject(value).source === "canonical-ground-truth"
  ).length;
  if (groundTruthCount === 0) throw new Error("Finding manifest has no canonical ground-truth denominator");

  const creditByCluster = new Map(
    asArray(creditPayload.clusters).map((value) => {
      const credit = asObject(value);
      return [
        requiredString(credit.rootCauseClusterId, "ground-truth credit cluster ID"),
        finiteNumber(credit.groundTruthTpCredits)
      ] as const;
    })
  );
  const sourceFindings = new Map(
    asArray(manifest.findingInstances).map((value) => {
      const finding = asObject(value);
      return [requiredString(finding.findingInstanceId, "finding instance ID"), finding] as const;
    })
  );

  const records = mappings.map((value) => {
    const mapping = asObject(value);
    const findingInstanceId = requiredString(mapping.findingInstanceId, "mapped finding instance ID");
    const source = sourceFindings.get(findingInstanceId);
    if (!source) throw new Error(`No source finding for ${findingInstanceId}`);
    const rowId = requiredString(mapping.rowId, "mapping row ID");
    const row = rows.find((candidate) => candidate.rowId === rowId);
    if (!row) throw new Error(`Mapping references unknown row ${rowId}`);
    const issueIndex = finiteNumber(mapping.issueIndex, Number.NaN);
    if (!Number.isInteger(issueIndex) || issueIndex < 0)
      throw new Error(`Invalid issue index for ${findingInstanceId}`);
    const rawTitle = requiredString(source.title, `title for ${findingInstanceId}`);
    const severity = severityFor(source.severity, rawTitle);
    const rendered = findingLabel(rawTitle, severity, issueIndex);
    const rootCauseClusterId = requiredString(mapping.rootCauseClusterId, "root-cause cluster ID");
    const duplicateOfFindingInstanceId = optionalString(mapping.duplicateOfFindingInstanceId);
    const matchedCandidateId = optionalString(mapping.matchedCandidateId);
    const matchedIdentity = matchedCandidateId ? (candidates.get(matchedCandidateId) ?? null) : null;
    if (matchedCandidateId && !matchedIdentity) throw new Error(`Unknown matched candidate ${matchedCandidateId}`);
    const groundTruth = candidateLabel(matchedIdentity);
    if (!creditByCluster.has(rootCauseClusterId)) {
      throw new Error(`No ground-truth credit record for ${rootCauseClusterId}`);
    }
    const sourceStrategies = asArray(source.sourceArtifactRefs)
      .map((reference) => optionalString(asObject(reference).nodeId))
      .filter((strategy): strategy is string => strategy !== null)
      .filter((strategy, index, values) => values.indexOf(strategy) === index)
      .sort();
    return {
      rowId,
      condition: row.condition,
      issueIndex,
      findingId: rendered.id,
      qualifiedId: `${rowId}:${rendered.id}`,
      severity,
      title: rendered.title,
      classification: requiredString(mapping.instanceClassification, "final instance classification"),
      matchedSource: optionalString(mapping.matchedSource),
      matchedCandidateId,
      matchedIdentity,
      groundTruthLabel: groundTruth.label,
      groundTruthTitle: groundTruth.title,
      stableIssueId: requiredString(mapping.stableIssueId, "stable issue ID"),
      findingInstanceId,
      rootCauseClusterId,
      duplicateOfFindingInstanceId,
      isDuplicate: duplicateOfFindingInstanceId !== null,
      groundTruthTpCredits: creditByCluster.get(rootCauseClusterId) as number,
      sourceStrategies
    } satisfies FindingRecord;
  });

  if (records.length !== sourceFindings.size) {
    throw new Error(`Final mapping covers ${records.length}/${sourceFindings.size} finding instances`);
  }
  const recordById = new Map(records.map((record) => [record.findingInstanceId, record]));
  for (const record of records) {
    if (record.duplicateOfFindingInstanceId === null) continue;
    const target = recordById.get(record.duplicateOfFindingInstanceId);
    if (
      !target ||
      target.findingInstanceId === record.findingInstanceId ||
      target.rowId !== record.rowId ||
      target.rootCauseClusterId !== record.rootCauseClusterId ||
      target.classification !== record.classification
    ) {
      throw new Error(`Invalid duplicate target for ${record.findingInstanceId}`);
    }
  }
  const rowCounts = asObject(manifest.rowCounts);
  for (const rowId of rowIds) {
    const expected = finiteNumber(rowCounts[rowId], Number.NaN);
    const actual = records.filter((record) => record.rowId === rowId).length;
    if (!Number.isInteger(expected) || expected !== actual)
      throw new Error(`Row ${rowId} count mismatch: ${actual}/${expected}`);
  }

  const accounting = new Map<string, Accounting>();
  for (const row of rows) {
    const rowArchive = archive.findRowArchive(row.rowId);
    const nested = await archive.readNestedJson(rowArchive.relativePath, { run: "/run.json" });
    accounting.set(row.rowId, accountingFrom(nested.run));
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
    handoffSchemaVersion,
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
