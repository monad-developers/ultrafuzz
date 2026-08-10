import type { ArtifactContractId } from "./artifact-contract-ids.js";

export type ArtifactSchemaRole = "artifact-contract" | "runtime-state" | "subschema";

export interface ArtifactSchemaMetadata {
  role: ArtifactSchemaRole;
  contractIds: readonly ArtifactContractId[];
  semanticGates: readonly string[];
  typescriptExport: string;
  zodParser?: string;
}

function artifact(
  contractId: ArtifactContractId,
  typescriptExport: string,
  zodParser: string | undefined,
  semanticGates: readonly string[] = []
): ArtifactSchemaMetadata {
  return {
    role: "artifact-contract",
    contractIds: [contractId],
    semanticGates,
    typescriptExport,
    ...(zodParser === undefined ? {} : { zodParser })
  };
}

function runtime(
  typescriptExport: string,
  zodParser?: string,
  semanticGates: readonly string[] = []
): ArtifactSchemaMetadata {
  return {
    role: "runtime-state",
    contractIds: [],
    semanticGates,
    typescriptExport,
    ...(zodParser === undefined ? {} : { zodParser })
  };
}

export const ARTIFACT_SCHEMA_METADATA = Object.freeze({
  "admin-config-boundary-matrix.schema.json": artifact(
    "ultrafuzz/admin-config-boundary-matrix@1",
    "adminConfigBoundaryMatrixJsonSchema",
    "adminConfigBoundaryMatrixSchema",
    ["admin-config-surface-id-uniqueness", "admin-config-surface-joins"]
  ),
  "agent-source-proof.schema.json": runtime("agentSourceProofJsonSchema", undefined, [
    "agent-source-proof-ref-uniqueness",
    "agent-source-proof-dependency-lineage",
    "agent-source-proof-commit-binding"
  ]),
  "aggregation-manifest.schema.json": artifact(
    "ultrafuzz/aggregation-manifest@1",
    "aggregationManifestJsonSchema",
    "aggregationManifestSchema",
    ["aggregation-destination-path-uniqueness", "aggregation-source-entry-uniqueness", "aggregation-count-coupling"]
  ),
  "analysis-bundle.schema.json": runtime("analysisBundleManifestJsonSchema", "analysisBundleManifestSchema", [
    "analysis-bundle-path-order",
    "analysis-bundle-file-digest"
  ]),
  "analysis-bundle-accounting-summary.schema.json": runtime(
    "analysisAccountingSummaryJsonSchema",
    "analysisAccountingSummarySchema",
    ["analysis-bundle-accounting-reconciliation"]
  ),
  "analysis-bundle-attempt-history.schema.json": runtime(
    "analysisAttemptHistoryJsonSchema",
    "analysisAttemptHistorySchema",
    ["analysis-bundle-attempt-order"]
  ),
  "analysis-bundle-evaluation-metrics.schema.json": runtime(
    "analysisEvaluationMetricsJsonSchema",
    "analysisEvaluationMetricsSchema",
    ["analysis-bundle-evaluation-count-reconciliation"]
  ),
  "analysis-bundle-omissions.schema.json": runtime(
    "analysisBundleOmissionsJsonSchema",
    "analysisBundleOmissionsSchema",
    ["analysis-bundle-omission-order", "analysis-bundle-inclusion-omission-coverage"]
  ),
  "analysis-bundle-recovery-summary.schema.json": runtime(
    "analysisRecoverySummaryJsonSchema",
    "analysisRecoverySummarySchema",
    ["analysis-bundle-recovery-reconciliation"]
  ),
  "analysis-bundle-terminal-status.schema.json": runtime(
    "analysisTerminalStatusJsonSchema",
    "analysisTerminalStatusSchema",
    ["analysis-bundle-terminal-status-reconciliation"]
  ),
  "artifact-manifest.schema.json": runtime("artifactManifestJsonSchema", undefined, [
    "artifact-manifest-file-path-uniqueness",
    "artifact-manifest-output-path-uniqueness",
    "artifact-manifest-prerequisite-node-uniqueness",
    "artifact-manifest-file-digest"
  ]),
  "artifact-verification.schema.json": runtime("artifactVerificationJsonSchema", undefined, [
    "artifact-verification-artifact-path-uniqueness",
    "artifact-verification-publication-path-uniqueness",
    "artifact-verification-exactly-one-primary",
    "artifact-verification-publication-digest-correspondence",
    "artifact-verification-plan-contract-identity"
  ]),
  "audited-differential-lanes.schema.json": artifact(
    "ultrafuzz/audited-differential-lanes@1",
    "auditedDifferentialLanesJsonSchema",
    "auditedDifferentialLanesSchema",
    ["audited-differential-lane-id-uniqueness"]
  ),
  "boundary-recipes.schema.json": artifact(
    "ultrafuzz/boundary-recipes@1",
    "boundaryRecipesJsonSchema",
    "boundaryRecipesSchema",
    ["boundary-recipe-id-uniqueness"]
  ),
  "campaign-summary.schema.json": artifact(
    "ultrafuzz/campaign-summary@2",
    "campaignSummaryJsonSchema",
    "campaignSummarySchema",
    ["campaign-summary-backend-uniqueness", "campaign-summary-count-coupling"]
  ),
  "config-redactions.schema.json": runtime("configRedactionsJsonSchema", undefined, [
    "config-redactions-path-key-equality",
    "config-redactions-path-uniqueness"
  ]),
  "coverage-goal.schema.json": artifact("ultrafuzz/coverage-goal@1", "coverageGoalJsonSchema", "coverageGoalSchema"),
  "dependency-scope-matrix.schema.json": artifact(
    "ultrafuzz/dependency-scope-matrix@1",
    "dependencyScopeMatrixJsonSchema",
    "dependencyScopeMatrixSchema",
    ["dependency-id-uniqueness", "dependency-row-joins"]
  ),
  "differential-gap-review.schema.json": artifact(
    "ultrafuzz/differential-gap-review@1",
    "differentialGapReviewJsonSchema",
    "differentialGapReviewSchema",
    ["differential-gap-lane-uniqueness"]
  ),
  "differential-lane-result.schema.json": artifact(
    "ultrafuzz/differential-lane-result@1",
    "differentialLaneResultJsonSchema",
    "differentialLaneResultSchema",
    ["differential-result-failure-hash-uniqueness", "differential-result-lane-binding"]
  ),
  "differential-plan.schema.json": artifact(
    "ultrafuzz/differential-plan@1",
    "differentialPlanJsonSchema",
    "differentialPlanSchema",
    ["differential-plan-surface-id-uniqueness", "differential-plan-lane-id-uniqueness"]
  ),
  "differential-red-triage.schema.json": artifact(
    "ultrafuzz/differential-red-triage@1",
    "differentialRedTriageJsonSchema",
    "differentialRedTriageSchema",
    ["differential-triage-failure-hash-uniqueness"]
  ),
  "differential-repair-summary.schema.json": artifact(
    "ultrafuzz/differential-repair-summary@1",
    "differentialRepairSummaryJsonSchema",
    "differentialRepairSummarySchema",
    ["differential-repair-failure-hash-uniqueness"]
  ),
  "differential-report-review.schema.json": artifact(
    "ultrafuzz/differential-report-review@1",
    "differentialReportReviewJsonSchema",
    "differentialReportReviewSchema",
    ["differential-report-failure-hash-uniqueness"]
  ),
  "dynamic-enumerator-outputs.schema.json": artifact(
    "ultrafuzz/dynamic-enumerator-outputs@1",
    "dynamicEnumeratorOutputsJsonSchema",
    "dynamicEnumeratorOutputsSchema",
    ["dynamic-enumerator-id-uniqueness", "dynamic-recommendation-id-uniqueness"]
  ),
  "dynamic-strategy-plan.schema.json": artifact(
    "ultrafuzz/dynamic-strategy-plan@1",
    "dynamicStrategyPlanJsonSchema",
    "dynamicStrategyPlanSchema",
    ["dynamic-strategy-selection-coherence"]
  ),
  "dynamic-strategy-provenance.schema.json": artifact(
    "ultrafuzz/dynamic-strategy-provenance@1",
    "dynamicStrategyProvenanceJsonSchema",
    "dynamicStrategyProvenanceSchema",
    ["dynamic-agent-id-uniqueness", "dynamic-model-agent-join"]
  ),
  "externalized-state-accounting.schema.json": artifact(
    "ultrafuzz/externalized-state-accounting@1",
    "externalizedStateAccountingJsonSchema",
    "externalizedStateAccountingSchema",
    ["externalized-state-id-uniqueness", "externalized-state-scenario-joins"]
  ),
  "event-query-facade.schema.json": runtime("eventQueryFacadeJsonSchema", "eventQueryFacadeSchema"),
  "event-record.schema.json": runtime("eventRecordJsonSchema", "eventRecordSchema"),
  "finding-lifecycle-ledger.schema.json": artifact(
    "ultrafuzz/finding-lifecycle-ledger@1",
    "findingLifecycleLedgerJsonSchema",
    "findingLifecycleLedgerSchema",
    ["finding-lifecycle-dedupe-key-uniqueness"]
  ),
  "finding.schema.json": {
    role: "subschema",
    contractIds: [],
    semanticGates: ["finding-evidence-span-consistency", "finding-projected-reference-uniqueness"],
    typescriptExport: "findingJsonSchema",
    zodParser: "findingSchema"
  },
  "findings.schema.json": artifact("ultrafuzz/findings@2", "findingsJsonSchema", "findingsSchema", [
    "findings-evidence-span-consistency",
    "findings-id-uniqueness"
  ]),
  "generated-tests.schema.json": artifact(
    "ultrafuzz/generated-tests@2",
    "generatedTestsJsonSchema",
    "generatedTestManifestSchema",
    ["generated-test-path-uniqueness", "generated-test-current-identity", "generated-test-path-exists"]
  ),
  "harness-repairs.schema.json": artifact(
    "ultrafuzz/harness-repairs@1",
    "harnessRepairsJsonSchema",
    "harnessRepairsSchema",
    ["harness-repair-failure-id-uniqueness"]
  ),
  "implemented-properties.schema.json": artifact(
    "ultrafuzz/implemented-properties@3",
    "implementedPropertiesJsonSchema",
    "implementedPropertiesSchema",
    ["implemented-property-id-uniqueness", "implemented-property-selection-join"]
  ),
  "invariant-campaign-plan.schema.json": artifact(
    "ultrafuzz/invariant-campaign-plan@1",
    "invariantCampaignPlanJsonSchema",
    "invariantCampaignPlanSchema"
  ),
  "invariant-evidence-ledger.schema.json": artifact(
    "ultrafuzz/invariant-ledger@1",
    "invariantLedgerJsonSchema",
    "invariantLedgerSchema",
    ["invariant-ledger-id-joins", "invariant-ledger-projected-id-uniqueness"]
  ),
  "invariant-source-proof.schema.json": runtime("invariantSourceProofJsonSchema", "invariantSourceProofSchema", [
    "invariant-source-proof-path-uniqueness",
    "invariant-source-proof-git-binding"
  ]),
  "invariant-suite-manifest.schema.json": runtime("invariantSuiteManifestJsonSchema", undefined, [
    "invariant-suite-file-path-uniqueness",
    "invariant-suite-tombstone-uniqueness",
    "invariant-suite-file-tombstone-disjointness"
  ]),
  "json-validator-preflight-success.schema.json": runtime("jsonValidatorPreflightSuccessJsonSchema", undefined, [
    "json-validator-preflight-current-identity"
  ]),
  "node-attempt-ledger.schema.json": runtime("nodeAttemptLedgerJsonSchema", "nodeAttemptLedgerEntrySchema", [
    "attempt-failure-message-byte-length",
    "attempt-reuse-source-link",
    "attempt-source-event-join",
    "attempt-outcome-digest-coupling",
    "attempt-order"
  ]),
  "properties.schema.json": artifact("ultrafuzz/properties@2", "propertiesJsonSchema", "propertiesSchema", [
    "property-id-uniqueness",
    "property-source-projected-uniqueness",
    "property-source-join"
  ]),
  "property-campaign.schema.json": artifact(
    "ultrafuzz/property-campaign@2",
    "propertyCampaignJsonSchema",
    "propertyCampaignSchema",
    ["property-campaign-failure-id-uniqueness"]
  ),
  "property-lens.schema.json": artifact(
    "ultrafuzz/property-lens@2",
    "lensPropertiesJsonSchema",
    "lensPropertiesSchema",
    ["property-lens-id-uniqueness"]
  ),
  "planned-graph.schema.json": runtime("plannedGraphJsonSchema", undefined, [
    "planned-graph-node-id-uniqueness",
    "planned-graph-dependency-join",
    "planned-graph-acyclicity",
    "planned-graph-output-path-uniqueness",
    "planned-graph-exactly-one-primary",
    "planned-graph-model-fanout-uniqueness",
    "planned-graph-workflow-task-uniqueness",
    "planned-graph-workflow-node-join",
    "planned-graph-artifact-dir-identity",
    "planned-graph-loop-coupling",
    "planned-graph-contract-identity",
    "planned-graph-model-loop-coupling"
  ]),
  "reference-expectations.schema.json": artifact(
    "ultrafuzz/reference-expectations@2",
    "referenceExpectationsJsonSchema",
    "referenceExpectationsSchema",
    ["reference-expectation-id-uniqueness"]
  ),
  "reference-harness.schema.json": artifact(
    "ultrafuzz/reference-harness@1",
    "referenceHarnessJsonSchema",
    "referenceHarnessSchema"
  ),
  "reference-manifest.schema.json": artifact(
    "ultrafuzz/reference-manifest@1",
    "referenceManifestJsonSchema",
    "referenceManifestSchema",
    ["reference-manifest-path-uniqueness"]
  ),
  "release-validation-report.schema.json": runtime("releaseValidationReportJsonSchema", undefined, [
    "release-validation-report-reconciliation"
  ]),
  "report.schema.json": artifact("ultrafuzz/report@2", "reportJsonSchema", "reportSchema", [
    "report-finding-evidence-span-consistency",
    "report-finding-id-uniqueness",
    "report-property-provenance-join"
  ]),
  "run-plan.schema.json": runtime("runPlanJsonSchema", undefined, ["run-plan-attempt-id-uniqueness"]),
  "run-metadata.schema.json": runtime("runMetadataJsonSchema", undefined, [
    "run-metadata-workflow-id-equality",
    "run-metadata-current-segment-equality",
    "run-metadata-accounting-workflow-identity"
  ]),
  "run-state.schema.json": runtime("runStateJsonSchema", "runStateSchema", [
    "run-state-fingerprint",
    "run-state-node-key-equality"
  ]),
  "source-run.schema.json": runtime("sourceRunJsonSchema", undefined, ["source-run-not-self"]),
  "terminal-disposition.schema.json": runtime("terminalDispositionJsonSchema", "terminalDispositionSchema"),
  "selected-strategies.schema.json": artifact(
    "ultrafuzz/selected-strategies@1",
    "selectedStrategiesJsonSchema",
    "selectedStrategiesSchema",
    ["selected-strategy-id-uniqueness"]
  ),
  "semantic-red-registry.schema.json": artifact(
    "ultrafuzz/semantic-red-registry@1",
    "semanticRedRegistryJsonSchema",
    "semanticRedRegistrySchema",
    ["semantic-red-hash-uniqueness"]
  ),
  "severity-classified-findings.schema.json": artifact(
    "ultrafuzz/severity-classified-findings@1",
    "severityClassifiedFindingsJsonSchema",
    "severityClassifiedFindingsSchema",
    [
      "severity-finding-evidence-span-consistency",
      "severity-finding-id-uniqueness",
      "severity-classification-matrix",
      "severity-classification-upstream-preservation"
    ]
  ),
  "smithers-task-manifest.schema.json": runtime("smithersTaskManifestJsonSchema", undefined, [
    "smithers-task-attempt-id-uniqueness",
    "smithers-task-workflow-id-uniqueness",
    "smithers-task-document-identity",
    "smithers-task-pinned-submodule-expectation",
    "smithers-task-dependency-join",
    "smithers-task-dependency-acyclicity",
    "smithers-task-planned-graph-coverage",
    "smithers-task-planned-graph-identity",
    "smithers-task-planned-graph-dependency-join"
  ]),
  "strategy-detections.schema.json": artifact(
    "ultrafuzz/strategy-detections@1",
    "strategyDetectionsJsonSchema",
    "strategyDetectionsSchema",
    ["strategy-detection-dedupe-key-uniqueness", "strategy-detection-hit-identity-uniqueness"]
  ),
  "triaged-findings.schema.json": artifact(
    "ultrafuzz/triaged-findings@1",
    "triagedFindingsJsonSchema",
    "triagedFindingsSchema",
    ["triaged-finding-evidence-span-consistency", "triaged-finding-id-uniqueness"]
  ),
  "trusted-cli.schema.json": runtime("trustedCliMetadataJsonSchema"),
  "usage-ledger.schema.json": runtime("usageLedgerJsonSchema", "usageLedgerEntrySchema", [
    "usage-ledger-event-order",
    "usage-ledger-source-event-join"
  ]),
  "workspace-patch.schema.json": artifact(
    "ultrafuzz/workspace-patch@1",
    "workspacePatchJsonSchema",
    "workspacePatchSchema",
    ["workspace-patch-path-uniqueness", "workspace-patch-git-binding"]
  )
} satisfies Readonly<Record<string, ArtifactSchemaMetadata>>);

export type ArtifactSchemaFilename = keyof typeof ARTIFACT_SCHEMA_METADATA;
