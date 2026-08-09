import {
  EVAL_ADJUDICATION_HANDOFF_SCHEMA_ID,
  EVAL_BENCHMARK_ANALYSIS_MANIFEST_SCHEMA_ID,
  EVAL_BENCHMARK_PROVENANCE_SCHEMA_ID,
  EVAL_BENCHMARK_SOURCE_MANIFEST_SCHEMA_ID,
  EVAL_FINDING_MANIFEST_SCHEMA_ID,
  EVAL_GROUND_TRUTH_CREDITS_SCHEMA_ID,
  EVAL_INSTANCE_CLUSTERS_SCHEMA_ID,
  validateEvalJsonSchema
} from "./eval-schema-registry.js";
import { assertEvalSemanticGateRegistry, executeEvalSchemaSemanticGates } from "./eval-semantic-gates.js";
import { EvalError } from "./utils.js";

export const ADJUDICATION_HANDOFF_SCHEMA_VERSION = "ultrafuzz.eval.adjudication-handoff.v1" as const;
export const FINDING_MANIFEST_SCHEMA_VERSION = "ultrafuzz.eval.finding-manifest.v1" as const;
export const INSTANCE_CLUSTERS_SCHEMA_VERSION = "ultrafuzz.eval.instance-clusters.v1" as const;
export const GROUND_TRUTH_CREDITS_SCHEMA_VERSION = "ultrafuzz.eval.ground-truth-credits.v1" as const;
export const BENCHMARK_PROVENANCE_SCHEMA_VERSION = "ultrafuzz.eval.benchmark-provenance.v1" as const;
export const BENCHMARK_SOURCE_MANIFEST_SCHEMA_VERSION = "ultrafuzz.eval.benchmark-source-manifest.v1" as const;
export const BENCHMARK_ANALYSIS_MANIFEST_SCHEMA_VERSION = "ultrafuzz.eval.benchmark-analysis-manifest.v1" as const;

export const BENCHMARK_ANALYSIS_SOURCE_JOIN_GATE = "eval-benchmark-analysis-source-joins" as const;
export const BENCHMARK_ANALYSIS_CREDIT_GATE = "eval-benchmark-analysis-credit-coupling" as const;

export type BenchmarkSourceSeverity = "High" | "Medium" | "Low";
export type BenchmarkClassification = "true-positive" | "false-positive" | "needs-human-review";
export type BenchmarkAnalysisCommand = "upset" | "scores" | "provenance" | "table" | "cost" | "pairwise" | "all";

export interface AdjudicationHandoff {
  schema_version: typeof ADJUDICATION_HANDOFF_SCHEMA_VERSION;
  provenance: { outputPath: string };
}

export interface BenchmarkFindingManifestRow {
  rowId: string;
  label: string;
  condition: string;
  order: number;
  variant: string;
  rowArchivePath: string;
  runMetadataPath: string;
  runId: string;
  findingCount: number;
}

export interface BenchmarkCandidate {
  candidateId: string;
  label: string;
  title: string;
  source: "canonical-ground-truth";
}

export interface BenchmarkFindingInstance {
  rowId: string;
  issueIndex: number;
  findingId: string;
  findingInstanceId: string;
  stableIssueId: string;
  title: string;
  severity: BenchmarkSourceSeverity;
  sourceArtifactRefs: Array<{ nodeId: string }>;
}

export interface BenchmarkFindingManifest {
  schema_version: typeof FINDING_MANIFEST_SCHEMA_VERSION;
  rows: BenchmarkFindingManifestRow[];
  candidateCatalog: BenchmarkCandidate[];
  findingInstances: BenchmarkFindingInstance[];
}

export interface BenchmarkInstanceCluster {
  rowId: string;
  issueIndex: number;
  findingInstanceId: string;
  stableIssueId: string;
  rootCauseClusterId: string;
  instanceClassification: BenchmarkClassification;
  matchedCandidateId: string | null;
  matchedSource: "canonical-ground-truth" | null;
  duplicateOfFindingInstanceId: string | null;
}

export interface BenchmarkInstanceClusters {
  schema_version: typeof INSTANCE_CLUSTERS_SCHEMA_VERSION;
  instances: BenchmarkInstanceCluster[];
}

export interface BenchmarkGroundTruthCredit {
  rootCauseClusterId: string;
  groundTruthTpCredits: number;
}

export interface BenchmarkGroundTruthCredits {
  schema_version: typeof GROUND_TRUTH_CREDITS_SCHEMA_VERSION;
  clusters: BenchmarkGroundTruthCredit[];
}

export interface BenchmarkFindingProvenance {
  row_id: string;
  condition: string;
  finding_id: string;
  qualified_id: string;
  finding_instance_id: string;
  root_cause_cluster_id: string;
  severity: "H" | "M" | "L";
  title: string;
  source_strategies: string[];
  classification: BenchmarkClassification;
  matched_source: string | null;
  matched_candidate_id: string | null;
  matched_identity: string | null;
  ground_truth_label: string | null;
  ground_truth_title: string | null;
  ground_truth_tp_credits: number;
  stable_issue_id: string;
  duplicate_of_finding_instance_id: string | null;
}

export interface BenchmarkRootCauseProvenance {
  root_cause_cluster_id: string;
  top_severity: "H" | "M" | "L";
  classification: BenchmarkClassification;
  ground_truth_tp_credits: number;
  rows: string[];
  row_count: number;
  detection_count: number;
  qualified_findings: string[];
}

export interface BenchmarkRowStatus {
  rowId: string;
  condition: string;
  valid: true;
  status: "valid";
  reason: null;
}

export interface BenchmarkProvenance {
  schema_version: typeof BENCHMARK_PROVENANCE_SCHEMA_VERSION;
  privacy: "private-analysis-output-do-not-commit";
  rows_are_sets: true;
  finding_instances: BenchmarkFindingProvenance[];
  root_cause_entities: BenchmarkRootCauseProvenance[];
  row_statuses: BenchmarkRowStatus[];
}

export interface BenchmarkSourceManifest {
  schema_version: typeof BENCHMARK_SOURCE_MANIFEST_SCHEMA_VERSION;
  privacy: "private-analysis-output-do-not-commit";
  source_archive: string;
  source_size_bytes: number;
  source_sha256: string;
  archive_root: string;
  handoff_schema_version: typeof ADJUDICATION_HANDOFF_SCHEMA_VERSION;
  adjudication_output_path: string;
  rows: Array<{ row_id: string; row_label: string; condition: string; variant: string; order: number }>;
  ground_truth_count: number;
}

export interface BenchmarkAnalysisManifestArtifact {
  path: string;
  size_bytes: number;
  sha256: string;
}

export interface BenchmarkAnalysisManifest {
  schema_version: typeof BENCHMARK_ANALYSIS_MANIFEST_SCHEMA_VERSION;
  privacy: "private-analysis-output-do-not-commit";
  command: BenchmarkAnalysisCommand;
  source_archive: string;
  source_sha256: string;
  handoff_schema_version: typeof ADJUDICATION_HANDOFF_SCHEMA_VERSION;
  artifacts: BenchmarkAnalysisManifestArtifact[];
}

export interface BenchmarkAnalysisSourceDocuments {
  manifest: BenchmarkFindingManifest;
  instanceClusters: BenchmarkInstanceClusters;
  credits: BenchmarkGroundTruthCredits;
}

export interface BenchmarkAnalysisContractIssue {
  gate: string;
  path: string;
  message: string;
}

export function parseAdjudicationHandoff(value: unknown, source = "handoff/current-state.json"): AdjudicationHandoff {
  return parseBenchmarkContract<AdjudicationHandoff>(EVAL_ADJUDICATION_HANDOFF_SCHEMA_ID, value, source);
}

export function parseBenchmarkFindingManifest(
  value: unknown,
  source = "finding-manifest.json"
): BenchmarkFindingManifest {
  return parseBenchmarkContract<BenchmarkFindingManifest>(EVAL_FINDING_MANIFEST_SCHEMA_ID, value, source);
}

export function parseBenchmarkInstanceClusters(
  value: unknown,
  source = "instance-to-cluster.json"
): BenchmarkInstanceClusters {
  return parseBenchmarkContract<BenchmarkInstanceClusters>(EVAL_INSTANCE_CLUSTERS_SCHEMA_ID, value, source);
}

export function parseBenchmarkGroundTruthCredits(
  value: unknown,
  source = "ground-truth-tp-credits.json"
): BenchmarkGroundTruthCredits {
  return parseBenchmarkContract<BenchmarkGroundTruthCredits>(EVAL_GROUND_TRUTH_CREDITS_SCHEMA_ID, value, source);
}

export function parseBenchmarkProvenance(value: unknown, source = "provenance.json"): BenchmarkProvenance {
  return parseBenchmarkContract<BenchmarkProvenance>(EVAL_BENCHMARK_PROVENANCE_SCHEMA_ID, value, source);
}

export function parseBenchmarkSourceManifest(value: unknown, source = "source_manifest.json"): BenchmarkSourceManifest {
  return parseBenchmarkContract<BenchmarkSourceManifest>(EVAL_BENCHMARK_SOURCE_MANIFEST_SCHEMA_ID, value, source);
}

export function parseBenchmarkAnalysisManifest(
  value: unknown,
  source = "analysis_manifest.json"
): BenchmarkAnalysisManifest {
  return parseBenchmarkContract<BenchmarkAnalysisManifest>(EVAL_BENCHMARK_ANALYSIS_MANIFEST_SCHEMA_ID, value, source);
}

export function assertBenchmarkAnalysisSources(input: BenchmarkAnalysisSourceDocuments): void {
  const issues = benchmarkAnalysisSourceIssues(input);
  if (issues.length === 0) return;
  throw new EvalError("EVAL_BENCHMARK_SOURCE_SEMANTIC_INVALID", "benchmark analysis sources failed canonical joins", {
    issues
  });
}

export function benchmarkAnalysisSourceIssues(
  input: BenchmarkAnalysisSourceDocuments
): BenchmarkAnalysisContractIssue[] {
  const issues: BenchmarkAnalysisContractIssue[] = [];
  const rows = new Map(input.manifest.rows.map((row) => [row.rowId, row]));
  const findings = new Map(input.manifest.findingInstances.map((finding) => [finding.findingInstanceId, finding]));
  const mappings = new Map(input.instanceClusters.instances.map((mapping) => [mapping.findingInstanceId, mapping]));
  const candidates = new Set(input.manifest.candidateCatalog.map((candidate) => candidate.candidateId));
  const credits = new Map(input.credits.clusters.map((credit) => [credit.rootCauseClusterId, credit]));

  for (const findingId of difference(findings.keys(), mappings.keys())) {
    issues.push(sourceIssue(`$.manifest.findingInstances[${JSON.stringify(findingId)}]`, "has no cluster mapping"));
  }
  for (const mappingId of difference(mappings.keys(), findings.keys())) {
    issues.push(sourceIssue(`$.instanceClusters.instances[${JSON.stringify(mappingId)}]`, "has no source finding"));
  }

  for (const [findingInstanceId, mapping] of mappings) {
    const finding = findings.get(findingInstanceId);
    if (finding === undefined) continue;
    for (const [field, observed, expected] of [
      ["rowId", mapping.rowId, finding.rowId],
      ["issueIndex", mapping.issueIndex, finding.issueIndex],
      ["stableIssueId", mapping.stableIssueId, finding.stableIssueId]
    ] as const) {
      if (observed !== expected) {
        issues.push(
          sourceIssue(
            `$.instanceClusters.instances[${JSON.stringify(findingInstanceId)}].${field}`,
            `must equal the source finding value ${JSON.stringify(expected)}`
          )
        );
      }
    }
    if (!rows.has(mapping.rowId)) {
      issues.push(
        sourceIssue(
          `$.instanceClusters.instances[${JSON.stringify(findingInstanceId)}].rowId`,
          `references unknown row ${JSON.stringify(mapping.rowId)}`
        )
      );
    }
    if (mapping.matchedCandidateId !== null && !candidates.has(mapping.matchedCandidateId)) {
      issues.push(
        sourceIssue(
          `$.instanceClusters.instances[${JSON.stringify(findingInstanceId)}].matchedCandidateId`,
          `references unknown candidate ${JSON.stringify(mapping.matchedCandidateId)}`
        )
      );
    }
  }

  const mappedClusterIds = new Set(input.instanceClusters.instances.map((mapping) => mapping.rootCauseClusterId));
  for (const clusterId of difference(mappedClusterIds, credits.keys())) {
    issues.push(sourceIssue(`$.instanceClusters.instances[${JSON.stringify(clusterId)}]`, "has no credit record"));
  }
  for (const clusterId of difference(credits.keys(), mappedClusterIds)) {
    issues.push(sourceIssue(`$.credits.clusters[${JSON.stringify(clusterId)}]`, "has no mapped finding"));
  }

  const mappingsByCluster = new Map<string, BenchmarkInstanceCluster[]>();
  for (const mapping of input.instanceClusters.instances) {
    mappingsByCluster.set(mapping.rootCauseClusterId, [
      ...(mappingsByCluster.get(mapping.rootCauseClusterId) ?? []),
      mapping
    ]);
  }
  let totalCredits = 0;
  for (const [clusterId, credit] of credits) {
    totalCredits += credit.groundTruthTpCredits;
    const clusterMappings = mappingsByCluster.get(clusterId) ?? [];
    const classifications = new Set(clusterMappings.map((mapping) => mapping.instanceClassification));
    if (classifications.size > 1) {
      issues.push(creditIssue(`$.credits.clusters[${JSON.stringify(clusterId)}]`, "cluster classifications disagree"));
    }
    const classification = clusterMappings[0]?.instanceClassification;
    if (credit.groundTruthTpCredits > 0 && classification !== "true-positive") {
      issues.push(
        creditIssue(
          `$.credits.clusters[${JSON.stringify(clusterId)}].groundTruthTpCredits`,
          "positive credit requires a true-positive cluster"
        )
      );
    }
    if (credit.groundTruthTpCredits > 0 && !clusterMappings.some((mapping) => mapping.matchedCandidateId !== null)) {
      issues.push(
        creditIssue(
          `$.credits.clusters[${JSON.stringify(clusterId)}].groundTruthTpCredits`,
          "positive credit requires a canonical candidate match"
        )
      );
    }
  }
  if (totalCredits > input.manifest.candidateCatalog.length) {
    issues.push(
      creditIssue(
        "$.credits.clusters",
        `total ground-truth credits ${totalCredits} exceed candidate count ${input.manifest.candidateCatalog.length}`
      )
    );
  }
  return issues;
}

function parseBenchmarkContract<T>(schemaId: string, value: unknown, source: string): T {
  const result = validateEvalJsonSchema(schemaId, value);
  if (!result.ok) {
    throw new EvalError("EVAL_BENCHMARK_SCHEMA_INVALID", `${source} failed canonical schema ${schemaId}`, {
      source,
      schema_id: schemaId,
      issues: result.issues,
      truncated: result.truncated
    });
  }
  assertEvalSemanticGateRegistry();
  const semanticIssues = executeEvalSchemaSemanticGates(schemaId, value);
  if (semanticIssues.length > 0) {
    throw new EvalError("EVAL_BENCHMARK_SEMANTIC_INVALID", `${source} failed canonical semantic gates`, {
      source,
      schema_id: schemaId,
      issues: semanticIssues
    });
  }
  return value as T;
}

function difference(left: Iterable<string>, right: Iterable<string>): string[] {
  const rightSet = new Set(right);
  return [...left].filter((value) => !rightSet.has(value)).sort();
}

function sourceIssue(path: string, message: string): BenchmarkAnalysisContractIssue {
  return { gate: BENCHMARK_ANALYSIS_SOURCE_JOIN_GATE, path, message };
}

function creditIssue(path: string, message: string): BenchmarkAnalysisContractIssue {
  return { gate: BENCHMARK_ANALYSIS_CREDIT_GATE, path, message };
}
