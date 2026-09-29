import {
  safeResolveInside,
  type GeneratedTestEntry,
  type GeneratedTestManifest,
  type RunLayout,
  type SemanticAggregationContext,
  type SemanticAggregationSourceBundleContext,
  type SemanticAggregationSourceEntryContext
} from "@ultrafuzz/artifacts";

import type { PlannedGraphNode } from "./types.js";
import type { VerifiedNodeOutputSnapshot, VerifiedOutputArtifactSnapshot } from "./verified-output.js";

/** A finalized `ultrafuzz/generated-tests@3` producer the aggregating attempt admitted. */
export interface AggregationSourceProducer {
  attemptId: string;
  node: Pick<PlannedGraphNode, "logical_id" | "loop">;
  authority: Pick<VerifiedNodeOutputSnapshot, "publications">;
  outputs: readonly VerifiedOutputArtifactSnapshot[];
}

/**
 * Build the aggregation gate's source authority from the producers the caller
 * resolved through the aggregating attempt's sealed ancestor closure and
 * verifier-persisted dependency admission. Those are the producers the
 * in-workflow verifier admitted, so an optional producer that failed is absent
 * rather than fatal, and each source is keyed by its sealed attempt ID.
 */
export function authenticatedAggregationSemanticContext(input: {
  layout: RunLayout;
  attemptId: string;
  producers: readonly AggregationSourceProducer[];
}): SemanticAggregationContext {
  const sourceBundles = input.producers.flatMap((producer) => {
    const publications = new Map(producer.authority.publications.map((publication) => [publication.path, publication]));
    const entry = (
      kind: SemanticAggregationSourceEntryContext["kind"],
      candidate: GeneratedTestEntry
    ): SemanticAggregationSourceEntryContext => {
      const publication = publications.get(candidate.path);
      if (
        publication === undefined ||
        publication.sha256 !== candidate.sha256 ||
        publication.bytes.byteLength !== candidate.size_bytes
      ) {
        throw new Error(
          `verified generated-test companion publication changed ${producer.attemptId}/${candidate.path}`
        );
      }
      return Object.freeze({
        kind,
        sourceArtifactPath: publication.absolute_path,
        sourceRelativePath: candidate.path,
        sizeBytes: candidate.size_bytes,
        sha256: candidate.sha256,
        bytes: Buffer.from(publication.bytes),
        ...(candidate.language === undefined ? {} : { language: candidate.language }),
        ...(candidate.description === undefined ? {} : { description: candidate.description }),
        ...(candidate.provenance === undefined ? {} : { provenance: Object.freeze({ ...candidate.provenance }) })
      });
    };
    return producer.outputs.map((output): SemanticAggregationSourceBundleContext => {
      const manifest = output.value as GeneratedTestManifest;
      return Object.freeze({
        strategy: producer.node.logical_id,
        nodeId: manifest.node_id,
        sourceAttemptId: producer.attemptId,
        // The verifier attributes a bundle to its producer's loop attempt index,
        // which the sealed task manifest binds to the planned node's loop.
        attemptIndex: producer.node.loop.attempt_index,
        sourceManifestPath: output.absolute_path,
        sourceManifestRelativePath: output.path,
        sourceManifestSha256: output.sha256,
        sourceRunId: manifest.run_id,
        framework: manifest.framework,
        entries: Object.freeze([
          ...manifest.generated_tests.map((candidate) => entry("generated-test", candidate)),
          ...manifest.support_files.map((candidate) => entry("support-file", candidate))
        ])
      });
    });
  });
  sourceBundles.sort(
    (left, right) =>
      left.sourceAttemptId.localeCompare(right.sourceAttemptId) ||
      left.sourceManifestRelativePath.localeCompare(right.sourceManifestRelativePath)
  );
  return Object.freeze({
    workspaceRoot: safeResolveInside(input.layout.workspacesDir, input.attemptId, "aggregation task workspace"),
    sourceBundles: Object.freeze(sourceBundles)
  });
}
