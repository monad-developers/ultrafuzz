export const ARTIFACT_CONTRACT_IDS = [
  "ultrafuzz/admin-config-boundary-matrix@1",
  "ultrafuzz/aggregation-manifest@1",
  "ultrafuzz/audited-differential-lanes@1",
  "ultrafuzz/boundary-recipes@1",
  "ultrafuzz/campaign-summary@2",
  "ultrafuzz/coverage-goal@1",
  "ultrafuzz/dependency-scope-matrix@1",
  "ultrafuzz/differential-gap-review@1",
  "ultrafuzz/differential-lane-result@1",
  "ultrafuzz/differential-plan@1",
  "ultrafuzz/differential-red-triage@1",
  "ultrafuzz/differential-repair-summary@1",
  "ultrafuzz/differential-report-review@1",
  "ultrafuzz/dynamic-enumerator-outputs@1",
  "ultrafuzz/dynamic-strategy-plan@1",
  "ultrafuzz/dynamic-strategy-provenance@1",
  "ultrafuzz/externalized-state-accounting@1",
  "ultrafuzz/finding-lifecycle-ledger@1",
  "ultrafuzz/findings@2",
  "ultrafuzz/generated-tests@3",
  "ultrafuzz/harness-repairs@1",
  "ultrafuzz/implemented-properties@3",
  "ultrafuzz/invariant-campaign-plan@2",
  "ultrafuzz/invariant-ledger@1",
  "ultrafuzz/nonempty-markdown@1",
  "ultrafuzz/properties@2",
  "ultrafuzz/property-campaign@3",
  "ultrafuzz/property-lens@2",
  "ultrafuzz/reference-expectations@2",
  "ultrafuzz/reference-harness@1",
  "ultrafuzz/reference-manifest@1",
  "ultrafuzz/report@2",
  "ultrafuzz/selected-strategies@1",
  "ultrafuzz/semantic-red-registry@1",
  "ultrafuzz/severity-classified-findings@1",
  "ultrafuzz/strategy-detections@1",
  "ultrafuzz/text@1",
  "ultrafuzz/triaged-findings@1",
  "ultrafuzz/workspace-patch@1"
] as const;

export type ArtifactContractId = (typeof ARTIFACT_CONTRACT_IDS)[number];

export const NON_JSON_ARTIFACT_CONTRACT_IDS = [
  "ultrafuzz/nonempty-markdown@1",
  "ultrafuzz/text@1"
] as const satisfies readonly ArtifactContractId[];

export type NonJsonArtifactContractId = (typeof NON_JSON_ARTIFACT_CONTRACT_IDS)[number];
export type JsonArtifactContractId = Exclude<ArtifactContractId, NonJsonArtifactContractId>;

export const JSON_ARTIFACT_CONTRACT_IDS = ARTIFACT_CONTRACT_IDS.filter(
  (id): id is JsonArtifactContractId => !(NON_JSON_ARTIFACT_CONTRACT_IDS as readonly string[]).includes(id)
);

export function isArtifactContractId(value: unknown): value is ArtifactContractId {
  return typeof value === "string" && (ARTIFACT_CONTRACT_IDS as readonly string[]).includes(value);
}

export function isJsonArtifactContractId(value: unknown): value is JsonArtifactContractId {
  return typeof value === "string" && (JSON_ARTIFACT_CONTRACT_IDS as readonly string[]).includes(value);
}
