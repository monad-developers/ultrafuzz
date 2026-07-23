export const SEVERITY_ORDER = ["H", "M", "L", "I"] as const;

export type Severity = (typeof SEVERITY_ORDER)[number];
export type Classification = "true-positive" | "false-positive" | "needs-human-review" | string;
export type AnalysisCommandName = "upset" | "scores" | "provenance" | "table" | "cost" | "pairwise" | "all";

export interface BenchmarkRow {
  rowId: string;
  label: string;
  condition: string;
  variant: string;
  order: number | null;
}

export interface Accounting {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  totalTokensMillions: number;
  estimatedSpendReported: string | null;
  estimatedSpendUsd: number | null;
  partialPricing: boolean;
  pricedEventCount: number;
  unpricedEventCount: number;
}

export interface RowStatus {
  rowId: string;
  condition: string;
  valid: boolean;
  status: "valid" | "invalid";
  reason: string | null;
}

export interface FindingRecord {
  rowId: string;
  condition: string;
  issueIndex: number;
  findingId: string;
  qualifiedId: string;
  severity: Severity;
  title: string;
  classification: Classification;
  matchedSource: string | null;
  matchedCandidateId: string | null;
  matchedIdentity: string | null;
  groundTruthLabel: string | null;
  groundTruthTitle: string | null;
  stableIssueId: string;
  findingInstanceId: string;
  rootCauseClusterId: string;
  duplicateOfFindingInstanceId: string | null;
  isDuplicate: boolean;
  groundTruthTpCredits: number;
  sourceStrategies: string[];
}

export interface FindingEntity {
  entityId: string;
  members: FindingRecord[];
  rows: Set<string>;
  topSeverity: Severity;
  classification: Classification;
  groundTruthTpCredits: number;
}

export interface RowMetric extends Accounting {
  rowId: string;
  label: string;
  condition: string;
  valid: boolean;
  status: string;
  invalidReason: string | null;
  findings: number | null;
  truePositives: number | null;
  falsePositives: number | null;
  needsHumanReview: number | null;
  duplicateCount: number | null;
  resolvedDuplicateCount: number | null;
  distinctGroundTruthCredits: number | null;
  groundTruthRootCauseIds: string[];
  groundTruthLabels: string[];
  groundTruthCount: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface Stats {
  mean: number | null;
  median: number | null;
  stdev: number | null;
  n: number;
}

export interface ConditionSummary {
  condition: string;
  validRows: number;
  invalidRows: number;
  stats: Record<string, Stats>;
}

export interface ConditionAggregate {
  condition: string;
  validRows: number;
  invalidRows: number;
  findings: number;
  truePositives: number;
  falsePositives: number;
  needsHumanReview: number;
  duplicateCount: number;
  distinctGroundTruthCredits: number;
  groundTruthRootCauseIds: string[];
  pooledPrecision: number | null;
  unionRecall: number | null;
  unionF1: number | null;
  validTokensMillions: number;
  allRunTokensMillions: number;
}

export interface PairComparison {
  pair: string;
  ultrafuzz: RowMetric;
  noFuzz: RowMetric;
  sharedRootCauseIds: string[];
  ultrafuzzOnlyRootCauseIds: string[];
  noFuzzOnlyRootCauseIds: string[];
  creditDeltaNoFuzzMinusUltrafuzz: number | null;
  f1DeltaNoFuzzMinusUltrafuzz: number | null;
  tokenDeltaNoFuzzMinusUltrafuzzMillions: number;
}

export interface AnalysisResult {
  sourceArchive: string;
  sourceSizeBytes: number;
  sourceSha256: string;
  archiveRoot: string;
  handoffSchemaVersion: string;
  outputPath: string;
  rows: BenchmarkRow[];
  rowOrder: string[];
  conditions: string[];
  groundTruthCount: number;
  records: FindingRecord[];
  entities: FindingEntity[];
  rowStatuses: RowStatus[];
  rowMetrics: RowMetric[];
  conditionSummary: ConditionSummary[];
  conditionAggregate: ConditionAggregate[];
  pairComparison: PairComparison[];
}
