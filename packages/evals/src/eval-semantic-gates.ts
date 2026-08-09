import {
  EVAL_ADJUDICATION_HANDOFF_SCHEMA_ID,
  EVAL_BENCHMARK_ANALYSIS_MANIFEST_SCHEMA_ID,
  EVAL_BENCHMARK_PROVENANCE_SCHEMA_ID,
  EVAL_BENCHMARK_SOURCE_MANIFEST_SCHEMA_ID,
  EVAL_FINDING_SCORE_SCHEMA_ID,
  EVAL_FINDING_MANIFEST_SCHEMA_ID,
  EVAL_GROUND_TRUTH_CREDITS_SCHEMA_ID,
  EVAL_INSTANCE_CLUSTERS_SCHEMA_ID,
  EVAL_MATRIX_SCHEMA_ID,
  EVAL_REVIEW_QUEUE_ITEM_SCHEMA_ID,
  EVAL_RUN_MANIFEST_SCHEMA_ID,
  EVAL_RUN_RECORD_SCHEMA_ID,
  EVAL_RUN_SUMMARY_SCHEMA_ID,
  EVAL_SCORE_SUMMARY_SCHEMA_ID,
  evalSchemaRegistry
} from "./eval-schema-registry.js";
import type {
  AdjudicationHandoff,
  BenchmarkAnalysisManifest,
  BenchmarkFindingManifest,
  BenchmarkGroundTruthCredits,
  BenchmarkInstanceCluster,
  BenchmarkInstanceClusters,
  BenchmarkProvenance,
  BenchmarkSourceManifest
} from "./benchmark-analysis-contracts.js";
import type {
  EvalFindingScore,
  EvalMatrixRow,
  EvalRecoveryEquivalence,
  EvalRunExpansion,
  EvalRunManifest,
  EvalRunRecord,
  EvalRunSummary,
  EvalScoreSummary,
  FindingJudgeResult,
  HumanReviewQueueItem
} from "./types.js";

export interface EvalSemanticGateIssue {
  gate: string;
  path: string;
  message: string;
}

export const EVAL_RECOVERY_EQUIVALENCE_SEMANTIC_GATE = "eval-recovery-equivalence-coupling" as const;

export interface EvalRecoveryEquivalenceSemanticIssue {
  path: readonly (string | number)[];
  message: string;
}

type EvalSemanticGate = (value: unknown) => EvalSemanticGateIssue[];

const gateHandlers: Readonly<Record<string, EvalSemanticGate>> = Object.freeze({
  "eval-adjudication-handoff-canonical-path": adjudicationHandoffCanonicalPath,
  "eval-benchmark-analysis-manifest-identity-joins": benchmarkAnalysisManifestIdentityJoins,
  "eval-benchmark-provenance-identity-joins": benchmarkProvenanceIdentityJoins,
  "eval-benchmark-source-manifest-identity-joins": benchmarkSourceManifestIdentityJoins,
  "eval-finding-score-decision-coupling": findingScoreDecisionCoupling,
  "eval-finding-manifest-identity-joins": findingManifestIdentityJoins,
  "eval-ground-truth-credits-identity-joins": groundTruthCreditsIdentityJoins,
  "eval-instance-clusters-identity-joins": instanceClustersIdentityJoins,
  "eval-matrix-identity-joins": matrixIdentityJoins,
  "eval-review-queue-decision-coupling": reviewQueueDecisionCoupling,
  [EVAL_RECOVERY_EQUIVALENCE_SEMANTIC_GATE]: recoveryEquivalenceCoupling,
  "eval-run-manifest-suite-joins": runManifestSuiteJoins,
  "eval-run-record-lifecycle-coupling": runRecordLifecycleCoupling,
  "eval-run-summary-count-coupling": runSummaryCountCoupling,
  "eval-run-summary-record-lineage": runSummaryRecordLineage,
  "eval-score-summary-count-coupling": scoreSummaryCountCoupling,
  "eval-score-summary-lineage": scoreSummaryLineage
});

const gatesBySchema: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [EVAL_ADJUDICATION_HANDOFF_SCHEMA_ID]: ["eval-adjudication-handoff-canonical-path"],
  [EVAL_BENCHMARK_ANALYSIS_MANIFEST_SCHEMA_ID]: ["eval-benchmark-analysis-manifest-identity-joins"],
  [EVAL_BENCHMARK_PROVENANCE_SCHEMA_ID]: ["eval-benchmark-provenance-identity-joins"],
  [EVAL_BENCHMARK_SOURCE_MANIFEST_SCHEMA_ID]: ["eval-benchmark-source-manifest-identity-joins"],
  [EVAL_FINDING_SCORE_SCHEMA_ID]: ["eval-finding-score-decision-coupling"],
  [EVAL_FINDING_MANIFEST_SCHEMA_ID]: ["eval-finding-manifest-identity-joins"],
  [EVAL_GROUND_TRUTH_CREDITS_SCHEMA_ID]: ["eval-ground-truth-credits-identity-joins"],
  [EVAL_INSTANCE_CLUSTERS_SCHEMA_ID]: ["eval-instance-clusters-identity-joins"],
  [EVAL_MATRIX_SCHEMA_ID]: ["eval-matrix-identity-joins"],
  [EVAL_REVIEW_QUEUE_ITEM_SCHEMA_ID]: ["eval-review-queue-decision-coupling"],
  [EVAL_RUN_MANIFEST_SCHEMA_ID]: ["eval-run-manifest-suite-joins"],
  [EVAL_RUN_RECORD_SCHEMA_ID]: ["eval-run-record-lifecycle-coupling", EVAL_RECOVERY_EQUIVALENCE_SEMANTIC_GATE],
  [EVAL_RUN_SUMMARY_SCHEMA_ID]: [
    "eval-run-summary-count-coupling",
    "eval-run-summary-record-lineage",
    EVAL_RECOVERY_EQUIVALENCE_SEMANTIC_GATE
  ],
  [EVAL_SCORE_SUMMARY_SCHEMA_ID]: [
    "eval-score-summary-count-coupling",
    "eval-score-summary-lineage",
    EVAL_RECOVERY_EQUIVALENCE_SEMANTIC_GATE
  ]
});

export function executeEvalSchemaSemanticGates(schemaId: string, value: unknown): EvalSemanticGateIssue[] {
  return (gatesBySchema[schemaId] ?? []).flatMap((name) => gateHandlers[name]!(value));
}

/** Fail registry initialization when metadata names a missing or incorrectly scoped executable gate. */
export function assertEvalSemanticGateRegistry(): void {
  const metadataScopes = evalSchemaRegistry().flatMap((entry) =>
    entry.semanticGates.map((gate) => ({ gate, schemaId: entry.id }))
  );
  const metadataGates = new Set(metadataScopes.map(({ gate }) => gate));
  const unknown = [...metadataGates].filter((gate) => gateHandlers[gate] === undefined).sort();
  const unregistered = Object.keys(gateHandlers)
    .filter((gate) => !metadataGates.has(gate))
    .sort();
  const metadataScopeKeys = new Set(metadataScopes.map(({ gate, schemaId }) => `${schemaId}\0${gate}`));
  const declaredScopes = Object.entries(gatesBySchema).flatMap(([schemaId, gates]) =>
    gates.map((gate) => ({ gate, schemaId }))
  );
  const scopeMismatch = [
    ...metadataScopes
      .filter(({ gate, schemaId }) => !(gatesBySchema[schemaId] ?? []).includes(gate))
      .map(({ gate, schemaId }) => `metadata-only:${gate}:${schemaId}`),
    ...declaredScopes
      .filter(({ gate, schemaId }) => !metadataScopeKeys.has(`${schemaId}\0${gate}`))
      .map(({ gate, schemaId }) => `dispatcher-only:${gate}:${schemaId}`)
  ].sort();
  if (unknown.length > 0 || unregistered.length > 0 || scopeMismatch.length > 0) {
    throw new Error(
      `eval semantic gate registry mismatch${unknown.length === 0 ? "" : `; unknown: ${unknown.join(", ")}`}${unregistered.length === 0 ? "" : `; unregistered: ${unregistered.join(", ")}`}${scopeMismatch.length === 0 ? "" : `; scope: ${scopeMismatch.join(", ")}`}`
    );
  }
}

function adjudicationHandoffCanonicalPath(value: unknown): EvalSemanticGateIssue[] {
  const handoff = value as AdjudicationHandoff;
  const segments = handoff.provenance.outputPath.split("/");
  return segments.some((segment) => segment === "." || segment === "..")
    ? [
        issue(
          "eval-adjudication-handoff-canonical-path",
          "$.provenance.outputPath",
          "outputPath must not contain dot path segments"
        )
      ]
    : [];
}

function findingManifestIdentityJoins(value: unknown): EvalSemanticGateIssue[] {
  const manifest = value as BenchmarkFindingManifest;
  const gate = "eval-finding-manifest-identity-joins";
  const issues: EvalSemanticGateIssue[] = [
    ...uniqueFieldIssues(manifest.rows, (row) => row.rowId, "$.rows", "row ID", gate),
    ...uniqueFieldIssues(manifest.rows, (row) => row.order, "$.rows", "row order", gate),
    ...uniqueFieldIssues(manifest.rows, (row) => row.rowArchivePath, "$.rows", "row archive path", gate),
    ...uniqueFieldIssues(manifest.rows, (row) => row.runMetadataPath, "$.rows", "run metadata path", gate),
    ...uniqueFieldIssues(manifest.rows, (row) => row.runId, "$.rows", "run ID", gate),
    ...uniqueFieldIssues(
      manifest.candidateCatalog,
      (candidate) => candidate.candidateId,
      "$.candidateCatalog",
      "candidate ID",
      gate
    ),
    ...uniqueFieldIssues(
      manifest.candidateCatalog,
      (candidate) => candidate.label,
      "$.candidateCatalog",
      "candidate label",
      gate
    ),
    ...uniqueFieldIssues(
      manifest.findingInstances,
      (finding) => finding.findingInstanceId,
      "$.findingInstances",
      "finding instance ID",
      gate
    ),
    ...uniqueFieldIssues(
      manifest.findingInstances,
      (finding) => `${finding.rowId}\0${finding.issueIndex}`,
      "$.findingInstances",
      "row/issue index",
      gate
    ),
    ...uniqueFieldIssues(
      manifest.findingInstances,
      (finding) => `${finding.rowId}\0${finding.findingId}`,
      "$.findingInstances",
      "row/finding ID",
      gate
    )
  ];
  const rowIds = new Set(manifest.rows.map((row) => row.rowId));
  const findingCounts = new Map<string, number>();
  manifest.findingInstances.forEach((finding, index) => {
    findingCounts.set(finding.rowId, (findingCounts.get(finding.rowId) ?? 0) + 1);
    if (!rowIds.has(finding.rowId)) {
      issues.push(
        issue(gate, `$.findingInstances[${index}].rowId`, `references unknown row ${JSON.stringify(finding.rowId)}`)
      );
    }
  });
  manifest.rows.forEach((row, index) => {
    const actual = findingCounts.get(row.rowId) ?? 0;
    if (actual !== row.findingCount) {
      issues.push(
        issue(gate, `$.rows[${index}].findingCount`, `must equal the ${actual} finding instances joined to this row`)
      );
    }
  });
  return issues;
}

function instanceClustersIdentityJoins(value: unknown): EvalSemanticGateIssue[] {
  const document = value as BenchmarkInstanceClusters;
  const gate = "eval-instance-clusters-identity-joins";
  const issues: EvalSemanticGateIssue[] = [
    ...uniqueFieldIssues(
      document.instances,
      (instance) => instance.findingInstanceId,
      "$.instances",
      "finding instance ID",
      gate
    ),
    ...uniqueFieldIssues(
      document.instances,
      (instance) => `${instance.rowId}\0${instance.issueIndex}`,
      "$.instances",
      "row/issue index",
      gate
    )
  ];
  const instances = new Map(document.instances.map((instance) => [instance.findingInstanceId, instance]));
  document.instances.forEach((instance, index) => {
    if (instance.duplicateOfFindingInstanceId === null) return;
    const target = instances.get(instance.duplicateOfFindingInstanceId);
    const path = `$.instances[${index}].duplicateOfFindingInstanceId`;
    if (target === undefined) {
      issues.push(
        issue(
          gate,
          path,
          `references unknown finding instance ${JSON.stringify(instance.duplicateOfFindingInstanceId)}`
        )
      );
      return;
    }
    if (target.findingInstanceId === instance.findingInstanceId) {
      issues.push(issue(gate, path, "cannot reference the same finding instance"));
      return;
    }
    for (const [field, observed, expected] of [
      ["rowId", target.rowId, instance.rowId],
      ["rootCauseClusterId", target.rootCauseClusterId, instance.rootCauseClusterId],
      ["instanceClassification", target.instanceClassification, instance.instanceClassification]
    ] as const) {
      if (observed !== expected) {
        issues.push(issue(gate, path, `target ${field} must equal ${JSON.stringify(expected)}`));
      }
    }
  });
  issues.push(...duplicateCycleIssues(document.instances, gate));
  return issues;
}

function duplicateCycleIssues(instances: readonly BenchmarkInstanceCluster[], gate: string): EvalSemanticGateIssue[] {
  const byId = new Map(instances.map((instance, index) => [instance.findingInstanceId, { instance, index }]));
  const complete = new Set<string>();
  const issues: EvalSemanticGateIssue[] = [];
  for (const start of byId.keys()) {
    if (complete.has(start)) continue;
    const chain: string[] = [];
    const positions = new Map<string, number>();
    let current: string | null = start;
    while (current !== null && byId.has(current) && !complete.has(current)) {
      const cycleStart = positions.get(current);
      if (cycleStart !== undefined) {
        for (const id of chain.slice(cycleStart)) {
          const index = byId.get(id)!.index;
          issues.push(
            issue(
              gate,
              `$.instances[${index}].duplicateOfFindingInstanceId`,
              "duplicate references must not contain a cycle"
            )
          );
        }
        break;
      }
      positions.set(current, chain.length);
      chain.push(current);
      current = byId.get(current)!.instance.duplicateOfFindingInstanceId;
    }
    chain.forEach((id) => complete.add(id));
  }
  return issues;
}

function groundTruthCreditsIdentityJoins(value: unknown): EvalSemanticGateIssue[] {
  const credits = value as BenchmarkGroundTruthCredits;
  return uniqueFieldIssues(
    credits.clusters,
    (cluster) => cluster.rootCauseClusterId,
    "$.clusters",
    "root-cause cluster ID",
    "eval-ground-truth-credits-identity-joins"
  );
}

function benchmarkProvenanceIdentityJoins(value: unknown): EvalSemanticGateIssue[] {
  const provenance = value as BenchmarkProvenance;
  const gate = "eval-benchmark-provenance-identity-joins";
  const issues: EvalSemanticGateIssue[] = [
    ...uniqueFieldIssues(
      provenance.finding_instances,
      (finding) => finding.finding_instance_id,
      "$.finding_instances",
      "finding instance ID",
      gate
    ),
    ...uniqueFieldIssues(
      provenance.finding_instances,
      (finding) => finding.qualified_id,
      "$.finding_instances",
      "qualified finding ID",
      gate
    ),
    ...uniqueFieldIssues(
      provenance.finding_instances,
      (finding) => `${finding.row_id}\0${finding.finding_id}`,
      "$.finding_instances",
      "row/finding ID",
      gate
    ),
    ...uniqueFieldIssues(
      provenance.root_cause_entities,
      (entity) => entity.root_cause_cluster_id,
      "$.root_cause_entities",
      "root-cause cluster ID",
      gate
    ),
    ...uniqueFieldIssues(provenance.row_statuses, (row) => row.rowId, "$.row_statuses", "row ID", gate)
  ];
  const rowStatuses = new Map(provenance.row_statuses.map((row) => [row.rowId, row]));
  const entityById = new Map(provenance.root_cause_entities.map((entity) => [entity.root_cause_cluster_id, entity]));
  const findingsByEntity = new Map<string, typeof provenance.finding_instances>();
  provenance.finding_instances.forEach((finding, index) => {
    if (finding.qualified_id !== `${finding.row_id}:${finding.finding_id}`) {
      issues.push(
        issue(gate, `$.finding_instances[${index}].qualified_id`, "must equal row_id plus ':' plus finding_id")
      );
    }
    const status = rowStatuses.get(finding.row_id);
    if (status === undefined) {
      issues.push(
        issue(
          gate,
          `$.finding_instances[${index}].row_id`,
          `references unknown row status ${JSON.stringify(finding.row_id)}`
        )
      );
    } else if (status.condition !== finding.condition) {
      issues.push(issue(gate, `$.finding_instances[${index}].condition`, "must equal the joined row status condition"));
    }
    if (!entityById.has(finding.root_cause_cluster_id)) {
      issues.push(
        issue(
          gate,
          `$.finding_instances[${index}].root_cause_cluster_id`,
          `references unknown root-cause entity ${JSON.stringify(finding.root_cause_cluster_id)}`
        )
      );
    }
    const members = findingsByEntity.get(finding.root_cause_cluster_id) ?? [];
    findingsByEntity.set(finding.root_cause_cluster_id, [...members, finding]);
    issues.push(...benchmarkFindingMatchIssues(finding, index, gate));
  });
  provenance.root_cause_entities.forEach((entity, index) => {
    const members = findingsByEntity.get(entity.root_cause_cluster_id) ?? [];
    const basePath = `$.root_cause_entities[${index}]`;
    const memberRows = uniqueSorted(members.map((member) => member.row_id));
    const qualifiedFindings = uniqueSorted(members.map((member) => member.qualified_id));
    if (!sameStringSet(entity.rows, memberRows)) {
      issues.push(issue(gate, `${basePath}.rows`, "must equal the rows projected from joined finding instances"));
    }
    if (entity.row_count !== entity.rows.length) {
      issues.push(issue(gate, `${basePath}.row_count`, "must equal rows.length"));
    }
    if (entity.detection_count !== members.length) {
      issues.push(issue(gate, `${basePath}.detection_count`, "must equal the joined finding instance count"));
    }
    if (!sameStringSet(entity.qualified_findings, qualifiedFindings)) {
      issues.push(
        issue(
          gate,
          `${basePath}.qualified_findings`,
          "must equal the qualified IDs projected from joined finding instances"
        )
      );
    }
    const classifications = new Set(members.map((member) => member.classification));
    if (members.length === 0 || classifications.size !== 1 || !classifications.has(entity.classification)) {
      issues.push(issue(gate, `${basePath}.classification`, "must equal one unanimous joined finding classification"));
    }
    const credits = new Set(members.map((member) => member.ground_truth_tp_credits));
    if (members.length === 0 || credits.size !== 1 || !credits.has(entity.ground_truth_tp_credits)) {
      issues.push(issue(gate, `${basePath}.ground_truth_tp_credits`, "must equal joined finding credits"));
    }
    const topSeverity = topBenchmarkSeverity(members.map((member) => member.severity));
    if (topSeverity === null || entity.top_severity !== topSeverity) {
      issues.push(issue(gate, `${basePath}.top_severity`, "must equal the highest joined finding severity"));
    }
  });
  return issues;
}

function benchmarkFindingMatchIssues(
  finding: BenchmarkProvenance["finding_instances"][number],
  index: number,
  gate: string
): EvalSemanticGateIssue[] {
  const path = `$.finding_instances[${index}]`;
  const matchValues = [
    finding.matched_source,
    finding.matched_identity,
    finding.ground_truth_label,
    finding.ground_truth_title
  ];
  if (finding.matched_candidate_id === null && matchValues.some((item) => item !== null)) {
    return [issue(gate, `${path}.matched_candidate_id`, "null candidate IDs require every matched field to be null")];
  }
  if (
    finding.matched_candidate_id !== null &&
    (finding.matched_source !== "canonical-ground-truth" || matchValues.some((item) => item === null))
  ) {
    return [
      issue(
        gate,
        `${path}.matched_candidate_id`,
        "matched candidate IDs require canonical source, identity, label, and title"
      )
    ];
  }
  return [];
}

function benchmarkSourceManifestIdentityJoins(value: unknown): EvalSemanticGateIssue[] {
  const manifest = value as BenchmarkSourceManifest;
  const gate = "eval-benchmark-source-manifest-identity-joins";
  return [
    ...uniqueFieldIssues(manifest.rows, (row) => row.row_id, "$.rows", "row ID", gate),
    ...uniqueFieldIssues(manifest.rows, (row) => row.order, "$.rows", "row order", gate)
  ];
}

function benchmarkAnalysisManifestIdentityJoins(value: unknown): EvalSemanticGateIssue[] {
  const manifest = value as BenchmarkAnalysisManifest;
  return uniqueFieldIssues(
    manifest.artifacts,
    (artifact) => artifact.path,
    "$.artifacts",
    "artifact path",
    "eval-benchmark-analysis-manifest-identity-joins"
  );
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = uniqueSorted(left);
  const sortedRight = uniqueSorted(right);
  return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function topBenchmarkSeverity(values: readonly ("H" | "M" | "L")[]): "H" | "M" | "L" | null {
  for (const severity of ["H", "M", "L"] as const) {
    if (values.includes(severity)) return severity;
  }
  return null;
}

/**
 * The single semantic authority for every persisted recovery-equivalence value.
 * Callers may add an enclosing JSON path, but must not reimplement these rules.
 */
export function evalRecoveryEquivalenceSemanticIssues(
  value: EvalRecoveryEquivalence
): EvalRecoveryEquivalenceSemanticIssue[] {
  const issues: EvalRecoveryEquivalenceSemanticIssue[] = [];
  if (
    value.recovery_generations !==
    value.infrastructure_only_recovery_generations + value.model_work_recovery_generations
  ) {
    issues.push({
      path: ["recovery_generations"],
      message: "must equal infrastructure-only plus model-work recovery generations"
    });
  }
  if (value.no_progress_recovery_generations > value.infrastructure_only_recovery_generations) {
    issues.push({
      path: ["no_progress_recovery_generations"],
      message: "cannot exceed infrastructure-only recovery generations"
    });
  }
  if (value.recovery_reexecuted_model_backed_node_executions > value.repeated_model_backed_node_executions) {
    issues.push({
      path: ["recovery_reexecuted_model_backed_node_executions"],
      message: "cannot exceed all repeated model-backed node executions"
    });
  }
  if (value.model_work_recovery_generations > value.recovery_reexecuted_model_backed_node_executions) {
    issues.push({
      path: ["model_work_recovery_generations"],
      message: "cannot exceed recovery model re-executions"
    });
  }
  if (
    value.observed_node_attempts <
    value.unique_model_backed_node_executions + value.repeated_model_backed_node_executions
  ) {
    issues.push({
      path: ["observed_node_attempts"],
      message: "cannot be less than accounted model-backed node executions"
    });
  }
  if (
    value.unique_model_backed_node_executions + value.repeated_model_backed_node_executions > 0 &&
    (value.observed_workflow_executions === 0 || value.observed_controller_invocations === 0)
  ) {
    issues.push({
      path: ["observed_workflow_executions"],
      message: "model-backed executions require observed workflow and controller lineage"
    });
  }
  if ((value.classification === "non-comparable") !== (value.reason !== null)) {
    issues.push({
      path: ["reason"],
      message: "must be present exactly for non-comparable classifications"
    });
  }
  if (
    value.classification !== "non-comparable" &&
    value.recovery_reexecuted_model_backed_node_executions > value.policy.max_repeated_model_executions
  ) {
    issues.push({
      path: ["classification"],
      message: "must be non-comparable when recovery model re-executions exceed the policy maximum"
    });
  }
  if (
    value.classification === "clean" &&
    (value.recovery_generations !== 0 ||
      value.recovery_reexecuted_model_backed_node_executions !== 0 ||
      value.model_work_recovery_generations !== 0 ||
      value.observed_workflow_executions > 1 ||
      value.observed_controller_invocations > 1)
  ) {
    issues.push({
      path: ["classification"],
      message: "clean classifications cannot contain recovery generations or recovery model re-executions"
    });
  }
  if (
    value.classification === "infrastructure-recovered" &&
    (value.recovery_generations === 0 ||
      value.model_work_recovery_generations !== 0 ||
      value.recovery_reexecuted_model_backed_node_executions !== 0)
  ) {
    issues.push({
      path: ["classification"],
      message: "infrastructure-recovered classifications require infrastructure-only recovery"
    });
  }
  if (
    value.classification === "model-reexecuted-within-policy" &&
    (value.recovery_generations === 0 ||
      value.model_work_recovery_generations === 0 ||
      value.recovery_reexecuted_model_backed_node_executions === 0)
  ) {
    issues.push({
      path: ["classification"],
      message: "model-reexecuted classifications require recovery model re-executions"
    });
  }
  return issues;
}

function recoveryEquivalenceCoupling(value: unknown): EvalSemanticGateIssue[] {
  if (isEvalScoreSummary(value)) {
    return value.rows.flatMap((row, index) =>
      recoveryEquivalenceIssuesAt(row.recovery_equivalence, `$.rows[${index}].recovery_equivalence`)
    );
  }
  if (isEvalRunSummary(value)) {
    return value.records.flatMap((record, index) =>
      record.recovery_equivalence === undefined
        ? []
        : recoveryEquivalenceIssuesAt(record.recovery_equivalence, `$.records[${index}].recovery_equivalence`)
    );
  }
  const record = value as EvalRunRecord;
  return record.recovery_equivalence === undefined
    ? []
    : recoveryEquivalenceIssuesAt(record.recovery_equivalence, "$.recovery_equivalence");
}

function recoveryEquivalenceIssuesAt(value: EvalRecoveryEquivalence, basePath: string): EvalSemanticGateIssue[] {
  return evalRecoveryEquivalenceSemanticIssues(value).map((semanticIssue) => ({
    gate: EVAL_RECOVERY_EQUIVALENCE_SEMANTIC_GATE,
    path: appendJsonPath(basePath, semanticIssue.path),
    message: semanticIssue.message
  }));
}

function isEvalScoreSummary(value: unknown): value is EvalScoreSummary {
  return typeof value === "object" && value !== null && Array.isArray((value as { rows?: unknown }).rows);
}

function isEvalRunSummary(value: unknown): value is EvalRunSummary {
  return typeof value === "object" && value !== null && Array.isArray((value as { records?: unknown }).records);
}

function appendJsonPath(basePath: string, segments: readonly (string | number)[]): string {
  let current = basePath;
  for (const segment of segments) {
    current = typeof segment === "number" ? `${current}[${segment}]` : `${current}.${segment}`;
  }
  return current;
}

function findingScoreDecisionCoupling(value: unknown): EvalSemanticGateIssue[] {
  const score = value as EvalFindingScore;
  return [
    ...judgeDecisionIssues(score.deterministic_match, "$.deterministic_match", "eval-finding-score-decision-coupling"),
    ...judgeDecisionIssues(score.judge_result, "$.judge_result", "eval-finding-score-decision-coupling")
  ];
}

function reviewQueueDecisionCoupling(value: unknown): EvalSemanticGateIssue[] {
  const item = value as HumanReviewQueueItem;
  return [
    ...judgeDecisionIssues(item.deterministic_match, "$.deterministic_match", "eval-review-queue-decision-coupling"),
    ...judgeDecisionIssues(item.judge_result, "$.judge_result", "eval-review-queue-decision-coupling")
  ];
}

function judgeDecisionIssues(decision: FindingJudgeResult, path: string, gate: string): EvalSemanticGateIssue[] {
  const issues: EvalSemanticGateIssue[] = [];
  const matched = decision.matched_ground_truth_bug_id !== undefined;
  if (decision.classification === "true-positive" && !matched) {
    issues.push(issue(gate, path, "true-positive decisions require a ground-truth bug ID"));
  }
  if (decision.classification === "missed" && matched) {
    issues.push(issue(gate, path, "missed decisions cannot name a ground-truth bug ID"));
  }
  const panel = decision.panel;
  if (panel === undefined) return issues;
  if (panel.quorum > panel.total || panel.quorum * 2 <= panel.total) {
    issues.push(issue(gate, `${path}.panel.quorum`, "panel quorum must be a strict majority no greater than total"));
  }
  if (panel.member_votes.length !== panel.total) {
    issues.push(issue(gate, `${path}.panel.member_votes`, "member vote count must equal panel total"));
  }
  const members = panel.member_votes.map((vote) => vote.member);
  if (new Set(members).size !== members.length || members.some((member) => member < 1 || member > panel.total)) {
    issues.push(issue(gate, `${path}.panel.member_votes`, "member ordinals must be unique and within the panel"));
  }
  const splitVotes = panel.vote_split.reduce((sum, split) => sum + split.votes, 0);
  if (splitVotes !== panel.total) {
    issues.push(issue(gate, `${path}.panel.vote_split`, "vote split totals must equal panel total"));
  }
  if (panel.aggregate_decision.votes < panel.quorum || panel.aggregate_decision.votes > panel.total) {
    issues.push(
      issue(gate, `${path}.panel.aggregate_decision.votes`, "aggregate votes must satisfy quorum and panel bounds")
    );
  }
  return issues;
}

function matrixIdentityJoins(value: unknown): EvalSemanticGateIssue[] {
  const rows = value as EvalMatrixRow[];
  const issues: EvalSemanticGateIssue[] = [];
  issues.push(...uniqueFieldIssues(rows, (row) => row.id, "$.rows", "row ID", "eval-matrix-identity-joins"));
  issues.push(...uniqueFieldIssues(rows, (row) => row.run_id, "$.rows", "run ID", "eval-matrix-identity-joins"));
  rows.forEach((row, index) => {
    if (row.target_id !== row.target.id) {
      issues.push(issue("eval-matrix-identity-joins", `$[${index}].target_id`, "target_id must equal target.id"));
    }
    if (row.variant_id !== row.variant.id) {
      issues.push(issue("eval-matrix-identity-joins", `$[${index}].variant_id`, "variant_id must equal variant.id"));
    }
  });
  return issues;
}

function runManifestSuiteJoins(value: unknown): EvalSemanticGateIssue[] {
  const manifest = value as EvalRunManifest;
  const suite = manifest.suite;
  const issues: EvalSemanticGateIssue[] = [];
  issues.push(
    ...uniqueFieldIssues(
      suite.targets,
      (target) => target.id,
      "$.suite.targets",
      "target ID",
      "eval-run-manifest-suite-joins"
    )
  );
  issues.push(
    ...uniqueFieldIssues(
      suite.variants,
      (variant) => variant.id,
      "$.suite.variants",
      "variant ID",
      "eval-run-manifest-suite-joins"
    )
  );
  const profiles = new Set(Object.keys(suite.model_profiles));
  for (const [path, profile] of [
    ["$.suite.run.runner_model_profile", suite.run.runner_model_profile],
    ["$.suite.run.judge_model_profile", suite.run.judge_model_profile]
  ] as const) {
    if (!profiles.has(profile))
      issues.push(issue("eval-run-manifest-suite-joins", path, `unknown model profile ${JSON.stringify(profile)}`));
  }
  suite.variants.forEach((variant, index) => {
    for (const [field, profile] of [
      ["runner_model_profile", variant.runner_model_profile],
      ["judge_model_profile", variant.judge_model_profile]
    ] as const) {
      if (profile !== undefined && !profiles.has(profile)) {
        issues.push(
          issue(
            "eval-run-manifest-suite-joins",
            `$.suite.variants[${index}].${field}`,
            `unknown model profile ${JSON.stringify(profile)}`
          )
        );
      }
    }
    for (const [profileIndex, profile] of (variant.model_profiles ?? []).entries()) {
      if (!profiles.has(profile)) {
        issues.push(
          issue(
            "eval-run-manifest-suite-joins",
            `$.suite.variants[${index}].model_profiles[${profileIndex}]`,
            `unknown model profile ${JSON.stringify(profile)}`
          )
        );
      }
    }
  });
  if (
    suite.judge_panel !== undefined &&
    (suite.judge_panel.quorum > suite.judge_panel.total || suite.judge_panel.quorum * 2 <= suite.judge_panel.total)
  ) {
    issues.push(
      issue(
        "eval-run-manifest-suite-joins",
        "$.suite.judge_panel.quorum",
        "judge quorum must be a strict majority no greater than total"
      )
    );
  }
  return issues;
}

function runRecordLifecycleCoupling(value: unknown): EvalSemanticGateIssue[] {
  const record = value as EvalRunRecord;
  const issues: EvalSemanticGateIssue[] = [];
  const terminalStatuses = new Set(["succeeded", "failed", "timed-out", "canceled"]);
  if (record.workflow !== undefined && record.workflow.terminal !== terminalStatuses.has(record.workflow.status)) {
    issues.push(
      issue(
        "eval-run-record-lifecycle-coupling",
        "$.workflow.terminal",
        "workflow terminal flag must match workflow status"
      )
    );
  }
  if (record.recovery_equivalence !== undefined && record.workflow?.terminal !== true) {
    issues.push(
      issue(
        "eval-run-record-lifecycle-coupling",
        "$.recovery_equivalence",
        "recovery equivalence requires a terminal workflow observation"
      )
    );
  }
  if (record.expansion !== undefined)
    issues.push(...expansionIssues(record.expansion, "$.expansion", "eval-run-record-lifecycle-coupling"));
  return issues;
}

function runSummaryCountCoupling(value: unknown): EvalSemanticGateIssue[] {
  const summary = value as EvalRunSummary;
  const launched = summary.records.filter((record) => record.status === "launched").length;
  const failed = summary.records.length - launched;
  const incomplete = summary.records.filter(
    (record) =>
      record.status === "launched" &&
      (record.workflow?.terminal !== true ||
        record.workflow.status === "timed-out" ||
        record.workflow.status === "canceled")
  ).length;
  return [
    ...(summary.launched === launched
      ? []
      : [issue("eval-run-summary-count-coupling", "$.launched", "launched must equal launched record count")]),
    ...(summary.failed === failed
      ? []
      : [issue("eval-run-summary-count-coupling", "$.failed", "failed must equal failed record count")]),
    ...(summary.incomplete === incomplete
      ? []
      : [
          issue(
            "eval-run-summary-count-coupling",
            "$.incomplete",
            "incomplete must equal incomplete launched record count"
          )
        ])
  ];
}

function runSummaryRecordLineage(value: unknown): EvalSemanticGateIssue[] {
  const summary = value as EvalRunSummary;
  const issues = uniqueFieldIssues(
    summary.records,
    (record) => record.row_id,
    "$.records",
    "row ID",
    "eval-run-summary-record-lineage"
  );
  summary.records.forEach((record, index) => {
    if (record.eval_run_id !== summary.eval_run_id) {
      issues.push(
        issue(
          "eval-run-summary-record-lineage",
          `$.records[${index}].eval_run_id`,
          "record eval_run_id must equal summary eval_run_id"
        )
      );
    }
  });
  return issues;
}

function scoreSummaryCountCoupling(value: unknown): EvalSemanticGateIssue[] {
  const summary = value as EvalScoreSummary;
  const issues: EvalSemanticGateIssue[] = [];
  for (const row of summary.rows) {
    if (row.true_positives + row.missed !== row.ground_truth_bug_count) {
      issues.push(
        issue(
          "eval-score-summary-count-coupling",
          `$.rows[${JSON.stringify(row.row_id)}].ground_truth_bug_count`,
          "ground-truth count must equal true positives plus missed"
        )
      );
    }
    const classified = row.true_positives + row.false_positives + row.duplicate_count + row.human_review_queue_count;
    if (classified !== row.finding_count) {
      issues.push(
        issue(
          "eval-score-summary-count-coupling",
          `$.rows[${JSON.stringify(row.row_id)}].finding_count`,
          "finding count must equal classified finding counts"
        )
      );
    }
    issues.push(
      ...expansionIssues(
        row.expansion,
        `$.rows[${JSON.stringify(row.row_id)}].expansion`,
        "eval-score-summary-count-coupling"
      )
    );
  }
  const nonComparableRows = summary.rows.filter((row) => row.recovery_equivalence.classification === "non-comparable");
  const includedRows =
    summary.recovery_equivalence.aggregate_non_comparable === "include"
      ? summary.rows
      : summary.rows.filter((row) => row.recovery_equivalence.classification !== "non-comparable");
  const counts = countRowsByVariant(includedRows);
  for (const [index, variant] of summary.variants.entries()) {
    if (variant.row_count !== (counts.get(variant.variant_id) ?? 0)) {
      issues.push(
        issue(
          "eval-score-summary-count-coupling",
          `$.variants[${index}].row_count`,
          "variant row_count must equal its included summary row count"
        )
      );
    }
  }
  if (summary.recovery_equivalence.included_row_count !== includedRows.length) {
    issues.push(
      issue(
        "eval-score-summary-count-coupling",
        "$.recovery_equivalence.included_row_count",
        "included row count must match the aggregation policy"
      )
    );
  }
  if (summary.recovery_equivalence.excluded_row_count !== summary.rows.length - includedRows.length) {
    issues.push(
      issue(
        "eval-score-summary-count-coupling",
        "$.recovery_equivalence.excluded_row_count",
        "excluded row count must match the aggregation policy"
      )
    );
  }
  for (const classification of [
    "clean",
    "infrastructure-recovered",
    "model-reexecuted-within-policy",
    "non-comparable"
  ] as const) {
    const observed = summary.rows.filter((row) => row.recovery_equivalence.classification === classification).length;
    if (summary.recovery_equivalence.classification_counts[classification] !== observed) {
      issues.push(
        issue(
          "eval-score-summary-count-coupling",
          `$.recovery_equivalence.classification_counts.${classification}`,
          "recovery classification count must match summary rows"
        )
      );
    }
  }
  const separateCounts = countRowsByVariant(
    summary.recovery_equivalence.aggregate_non_comparable === "separate" ? nonComparableRows : []
  );
  for (const [index, variant] of summary.recovery_equivalence.non_comparable_variants.entries()) {
    if (variant.row_count !== (separateCounts.get(variant.variant_id) ?? 0)) {
      issues.push(
        issue(
          "eval-score-summary-count-coupling",
          `$.recovery_equivalence.non_comparable_variants[${index}].row_count`,
          "non-comparable variant row_count must match separately aggregated rows"
        )
      );
    }
  }
  return issues;
}

function scoreSummaryLineage(value: unknown): EvalSemanticGateIssue[] {
  const summary = value as EvalScoreSummary;
  const issues = uniqueFieldIssues(summary.rows, (row) => row.row_id, "$.rows", "row ID", "eval-score-summary-lineage");
  issues.push(
    ...uniqueFieldIssues(
      summary.variants,
      (variant) => variant.variant_id,
      "$.variants",
      "variant ID",
      "eval-score-summary-lineage"
    )
  );
  issues.push(
    ...uniqueFieldIssues(
      summary.recovery_equivalence.non_comparable_variants,
      (variant) => variant.variant_id,
      "$.recovery_equivalence.non_comparable_variants",
      "variant ID",
      "eval-score-summary-lineage"
    )
  );
  const includedRows =
    summary.recovery_equivalence.aggregate_non_comparable === "include"
      ? summary.rows
      : summary.rows.filter((row) => row.recovery_equivalence.classification !== "non-comparable");
  const variants = new Set(summary.variants.map((variant) => variant.variant_id));
  includedRows.forEach((row, index) => {
    if (!variants.has(row.variant_id)) {
      issues.push(
        issue(
          "eval-score-summary-lineage",
          `$.rows[${index}].variant_id`,
          "included row variant must exist in variants"
        )
      );
    }
  });
  for (const [index, variant] of summary.variants.entries()) {
    if (!includedRows.some((row) => row.variant_id === variant.variant_id)) {
      issues.push(
        issue(
          "eval-score-summary-lineage",
          `$.variants[${index}].variant_id`,
          "variant must reference at least one included row"
        )
      );
    }
  }
  const separateRows =
    summary.recovery_equivalence.aggregate_non_comparable === "separate"
      ? summary.rows.filter((row) => row.recovery_equivalence.classification === "non-comparable")
      : [];
  const separateVariants = new Set(
    summary.recovery_equivalence.non_comparable_variants.map((variant) => variant.variant_id)
  );
  separateRows.forEach((row, index) => {
    if (!separateVariants.has(row.variant_id)) {
      issues.push(
        issue(
          "eval-score-summary-lineage",
          `$.recovery_equivalence.non_comparable_rows[${index}].variant_id`,
          "separately aggregated row variant must exist in non_comparable_variants"
        )
      );
    }
  });
  for (const [index, variant] of summary.recovery_equivalence.non_comparable_variants.entries()) {
    if (!separateRows.some((row) => row.variant_id === variant.variant_id)) {
      issues.push(
        issue(
          "eval-score-summary-lineage",
          `$.recovery_equivalence.non_comparable_variants[${index}].variant_id`,
          "non-comparable variant must reference at least one separately aggregated row"
        )
      );
    }
  }
  return issues;
}

function countRowsByVariant(rows: readonly EvalScoreSummary["rows"][number][]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.variant_id, (counts.get(row.variant_id) ?? 0) + 1);
  return counts;
}

function expansionIssues(expansion: EvalRunExpansion, path: string, gate: string): EvalSemanticGateIssue[] {
  const statusCount = Object.values(expansion.status_counts).reduce((sum, count) => sum + count, 0);
  const issues: EvalSemanticGateIssue[] = [];
  if (statusCount !== expansion.node_count)
    issues.push(issue(gate, `${path}.status_counts`, "status counts must equal node_count"));
  if (expansion.failed_node_count < expansion.failed_node_ids.length)
    issues.push(issue(gate, `${path}.failed_node_ids`, "failed node IDs cannot exceed failed_node_count"));
  if (expansion.timed_out_node_count < expansion.timed_out_node_ids.length)
    issues.push(issue(gate, `${path}.timed_out_node_ids`, "timed-out node IDs cannot exceed timed_out_node_count"));
  if (
    expansion.dynamic_nodes !== null &&
    expansion.dynamic_node_count !== null &&
    expansion.dynamic_node_count < expansion.dynamic_nodes.length
  ) {
    issues.push(issue(gate, `${path}.dynamic_nodes`, "dynamic node rows cannot exceed dynamic_node_count"));
  }
  return issues;
}

function uniqueFieldIssues<T>(
  values: readonly T[],
  select: (value: T) => string | number,
  path: string,
  label: string,
  gate: string
): EvalSemanticGateIssue[] {
  const seen = new Set<string | number>();
  const issues: EvalSemanticGateIssue[] = [];
  values.forEach((value, index) => {
    const key = select(value);
    if (seen.has(key)) issues.push(issue(gate, `${path}[${index}]`, `duplicate ${label} ${JSON.stringify(key)}`));
    seen.add(key);
  });
  return issues;
}

function issue(gate: string, path: string, message: string): EvalSemanticGateIssue {
  return { gate, path, message };
}
