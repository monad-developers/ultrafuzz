import type { ArtifactVerificationEntry, SmithersTaskManifestOutput } from "@ultrafuzz/artifacts";

import type { DynamicExpansionManifest } from "./dynamic-expansion.js";
import { stableJson } from "./utils.js";

export function sameManifestGeneration(
  left: readonly DynamicExpansionManifest[],
  right: readonly DynamicExpansionManifest[]
): boolean {
  const sorted = (values: readonly DynamicExpansionManifest[]): DynamicExpansionManifest[] =>
    [...values].sort((a, b) => a.group_node_id.localeCompare(b.group_node_id));
  return stableJson(sorted(left)) === stableJson(sorted(right));
}

export function markerArtifactAuthority(artifacts: readonly ArtifactVerificationEntry[]): unknown[] {
  return artifacts
    .map((artifact) => ({
      path: artifact.path,
      contract: artifact.contract,
      contractDigest: artifact.contract_digest,
      ...(artifact.schema_file === undefined ? {} : { schemaFile: artifact.schema_file }),
      ...(artifact.schema_id === undefined ? {} : { schemaId: artifact.schema_id }),
      ...(artifact.schema_sha256 === undefined ? {} : { schemaSha256: artifact.schema_sha256 }),
      ...(artifact.schema_bundle_sha256 === undefined ? {} : { schemaBundleSha256: artifact.schema_bundle_sha256 }),
      ...(artifact.validator_build === undefined ? {} : { validatorBuild: artifact.validator_build }),
      primary: artifact.primary
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function expectedArtifactAuthority(outputs: readonly SmithersTaskManifestOutput[]): unknown[] {
  return outputs
    .map((output) => ({
      path: output.path,
      contract: output.contract,
      contractDigest: output.contractDigest,
      ...(output.schemaFile === undefined ? {} : { schemaFile: output.schemaFile }),
      ...(output.schemaId === undefined ? {} : { schemaId: output.schemaId }),
      ...(output.schemaSha256 === undefined ? {} : { schemaSha256: output.schemaSha256 }),
      ...(output.schemaBundleSha256 === undefined ? {} : { schemaBundleSha256: output.schemaBundleSha256 }),
      ...(output.validatorBuild === undefined ? {} : { validatorBuild: output.validatorBuild }),
      primary: output.primary
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}
