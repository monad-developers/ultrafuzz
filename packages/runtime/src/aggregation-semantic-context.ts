import crypto from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  ARTIFACT_VERIFICATION_SCHEMA_VERSION,
  MAX_GENERATED_TEST_COMPANION_BYTES,
  assertArtifactVerificationMarkerSemantics,
  assertGeneratedTestManifestSemantics,
  assertNoSymlinkComponents,
  assertPathInside,
  assertRegularFileInside,
  artifactContractDefinition,
  artifactContractSchemaBinding,
  parseStrictJsonBytes,
  readPlannedGraphDocument,
  readRegularFileSnapshot,
  safeResolveInside,
  validateArtifactContractBytes,
  validateArtifactVerificationMarker,
  type ArtifactVerificationMarker,
  type GeneratedTestEntry,
  type GeneratedTestManifest,
  type PlannedGraphNodeDocument,
  type RunLayout,
  type SemanticAggregationContext,
  type SemanticAggregationSourceBundleContext,
  type SemanticAggregationSourceEntryContext
} from "@ultrafuzz/artifacts";

const MAX_AGGREGATION_AUTHORITY_BYTES = 64 * 1024 * 1024;
const VERIFICATION_MARKER_DIRECTORY = ".ultrafuzz-verification";

/**
 * Build the aggregation gate's immutable source authority from the planned
 * graph's exact transitive ancestors and their current verifier publications.
 */
export function authenticatedAggregationSemanticContext(input: {
  layout: RunLayout;
  node: PlannedGraphNodeDocument;
  attemptId: string;
}): SemanticAggregationContext {
  const graph = readPlannedGraphDocument(input.layout.graphPath);
  const current = graph.nodes.find((candidate) => candidate.id === input.node.id);
  if (current === undefined || !isDeepStrictEqual(current, input.node)) {
    throw new Error(`aggregation node ${JSON.stringify(input.node.id)} does not match the current planned graph`);
  }
  const sourceBundles: SemanticAggregationSourceBundleContext[] = [];
  for (const producer of transitiveAncestorNodes(current, graph.nodes)) {
    if (producer.kind !== "agentic") continue;
    const generatedOutputs = producer.outputs.filter((output) => output.contract === "ultrafuzz/generated-tests@3");
    if (generatedOutputs.length === 0) continue;
    for (const attempt of plannedAttempts(producer)) {
      const artifactRoot = safeResolveInside(
        input.layout.artifactsDir,
        attempt.attemptId,
        "generated-test aggregation source artifact directory"
      );
      const marker = authenticatedProducerMarker(input.layout, producer, attempt.attemptId, artifactRoot);
      const publications = new Map(marker.publications.map((publication) => [publication.path, publication.sha256]));
      for (const output of generatedOutputs) {
        const markerArtifact = marker.artifacts.find((artifact) => artifact.path === output.path);
        if (markerArtifact === undefined) {
          throw new Error(`verified producer ${attempt.attemptId} omits generated-test output ${output.path}`);
        }
        const manifestPath = safeResolveInside(artifactRoot, output.path, "generated-test aggregation source manifest");
        assertRegularFileInside(artifactRoot, manifestPath, "generated-test aggregation source manifest");
        const manifestBytes = readRegularFileSnapshot(manifestPath, MAX_AGGREGATION_AUTHORITY_BYTES);
        const manifestSha256 = digest(manifestBytes);
        if (markerArtifact.sha256 !== manifestSha256 || publications.get(output.path) !== manifestSha256) {
          throw new Error(`verified generated-test manifest publication changed ${attempt.attemptId}/${output.path}`);
        }
        const validation = validateArtifactContractBytes("ultrafuzz/generated-tests@3", manifestBytes, manifestPath);
        if (!validation.ok || validation.value === undefined) {
          throw new Error(`verified generated-test manifest is no longer valid ${attempt.attemptId}/${output.path}`);
        }
        const manifest = validation.value as GeneratedTestManifest;
        assertGeneratedTestManifestSemantics(manifest);
        if (manifest.run_id !== input.layout.runId || manifest.node_id !== producer.logical_id) {
          throw new Error(`verified generated-test manifest identity changed ${attempt.attemptId}/${output.path}`);
        }
        const entries = [
          ...manifest.generated_tests.map((entry) =>
            authenticatedEntry("generated-test", entry, artifactRoot, publications)
          ),
          ...manifest.support_files.map((entry) =>
            authenticatedEntry("support-file", entry, artifactRoot, publications)
          )
        ];
        sourceBundles.push(
          Object.freeze({
            strategy: producer.logical_id,
            nodeId: manifest.node_id,
            sourceAttemptId: attempt.attemptId,
            attemptIndex: attempt.attemptIndex,
            sourceManifestPath: manifestPath,
            sourceManifestRelativePath: output.path,
            sourceManifestSha256: manifestSha256,
            sourceRunId: manifest.run_id,
            entries: Object.freeze(entries)
          })
        );
      }
    }
  }
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

function transitiveAncestorNodes(
  current: PlannedGraphNodeDocument,
  nodes: readonly PlannedGraphNodeDocument[]
): PlannedGraphNodeDocument[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ancestors = new Map<string, PlannedGraphNodeDocument>();
  const pending = [...current.depends_on];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (ancestors.has(id)) continue;
    const node = byId.get(id);
    if (node === undefined) throw new Error(`aggregation dependency is absent from the planned graph: ${id}`);
    ancestors.set(id, node);
    pending.push(...node.depends_on);
  }
  return [...ancestors.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function plannedAttempts(node: PlannedGraphNodeDocument): Array<{ attemptId: string; attemptIndex: number }> {
  if (node.model_fanout.length <= 1) {
    return [{ attemptId: node.id, attemptIndex: node.model_fanout[0]?.attempt_index ?? node.loop.attempt_index }];
  }
  return node.model_fanout.map((model) => ({
    attemptId: `${node.id}__model_${model.model_index}__attempt_${model.attempt_index}`,
    attemptIndex: model.attempt_index
  }));
}

function authenticatedProducerMarker(
  layout: RunLayout,
  producer: PlannedGraphNodeDocument,
  attemptId: string,
  artifactRoot: string
): ArtifactVerificationMarker {
  const markerRoot = path.resolve(layout.root, VERIFICATION_MARKER_DIRECTORY);
  assertPathInside(layout.root, markerRoot, "artifact verification marker root");
  assertNoSymlinkComponents(layout.root, markerRoot, "artifact verification marker root");
  const markerPath = safeResolveInside(markerRoot, `${attemptId}.json`, "artifact verification marker");
  assertRegularFileInside(markerRoot, markerPath, "artifact verification marker");
  const parsed = parseStrictJsonBytes(readRegularFileSnapshot(markerPath, MAX_AGGREGATION_AUTHORITY_BYTES));
  const shape = validateArtifactVerificationMarker(parsed);
  if (!shape.ok) throw new Error(`artifact verification marker is invalid for ${attemptId}`);
  const marker = parsed as ArtifactVerificationMarker;
  assertArtifactVerificationMarkerSemantics(marker);
  if (
    marker.schema_version !== ARTIFACT_VERIFICATION_SCHEMA_VERSION ||
    marker.attempt_id !== attemptId ||
    marker.node_id !== producer.logical_id ||
    marker.artifacts.length !== producer.outputs.length
  ) {
    throw new Error(`artifact verification marker identity changed for ${attemptId}`);
  }
  const markerArtifacts = new Map(marker.artifacts.map((artifact) => [artifact.path, artifact]));
  if (markerArtifacts.size !== marker.artifacts.length)
    throw new Error(`artifact verification marker repeats ${attemptId}`);
  for (const output of producer.outputs) {
    const artifact = markerArtifacts.get(output.path);
    const expectedBinding = artifactContractSchemaBinding(output.contract);
    const expected = {
      path: output.path,
      contract: output.contract,
      contract_digest: artifactContractDefinition(output.contract).digest,
      ...(expectedBinding === undefined
        ? {}
        : {
            schema_file: expectedBinding.schema_file,
            schema_id: expectedBinding.schema_id,
            schema_sha256: expectedBinding.schema_sha256,
            schema_bundle_sha256: expectedBinding.schema_bundle_sha256,
            validator_build: expectedBinding.validator_build
          }),
      primary: output.primary
    };
    if (
      artifact === undefined ||
      !isDeepStrictEqual(
        {
          path: artifact.path,
          contract: artifact.contract,
          contract_digest: artifact.contract_digest,
          ...(artifact.schema_file === undefined ? {} : { schema_file: artifact.schema_file }),
          ...(artifact.schema_id === undefined ? {} : { schema_id: artifact.schema_id }),
          ...(artifact.schema_sha256 === undefined ? {} : { schema_sha256: artifact.schema_sha256 }),
          ...(artifact.schema_bundle_sha256 === undefined
            ? {}
            : { schema_bundle_sha256: artifact.schema_bundle_sha256 }),
          ...(artifact.validator_build === undefined ? {} : { validator_build: artifact.validator_build }),
          primary: artifact.primary
        },
        expected
      )
    ) {
      throw new Error(`artifact verification marker output binding changed ${attemptId}/${output.path}`);
    }
    const artifactPath = safeResolveInside(artifactRoot, output.path, "verified producer output");
    assertRegularFileInside(artifactRoot, artifactPath, "verified producer output");
    const bytes = readRegularFileSnapshot(artifactPath, MAX_AGGREGATION_AUTHORITY_BYTES);
    const sha256 = digest(bytes);
    if (
      artifact.sha256 !== sha256 ||
      !marker.publications.some((entry) => entry.path === output.path && entry.sha256 === sha256)
    ) {
      throw new Error(`verified producer output publication changed ${attemptId}/${output.path}`);
    }
  }
  return marker;
}

function authenticatedEntry(
  kind: "generated-test" | "support-file",
  entry: GeneratedTestEntry,
  artifactRoot: string,
  publications: ReadonlyMap<string, string>
): SemanticAggregationSourceEntryContext {
  const artifactPath = safeResolveInside(artifactRoot, entry.path, "generated-test aggregation source companion");
  assertRegularFileInside(artifactRoot, artifactPath, "generated-test aggregation source companion");
  const bytes = readRegularFileSnapshot(artifactPath, MAX_GENERATED_TEST_COMPANION_BYTES);
  const sha256 = digest(bytes);
  if (bytes.length !== entry.size_bytes || sha256 !== entry.sha256 || publications.get(entry.path) !== sha256) {
    throw new Error(`verified generated-test companion publication changed ${entry.path}`);
  }
  return Object.freeze({
    kind,
    sourceArtifactPath: artifactPath,
    sourceRelativePath: entry.path,
    sizeBytes: entry.size_bytes,
    sha256: entry.sha256,
    bytes: Buffer.from(bytes),
    ...(entry.language === undefined ? {} : { language: entry.language }),
    ...(entry.framework === undefined ? {} : { framework: entry.framework }),
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.provenance === undefined ? {} : { provenance: Object.freeze({ ...entry.provenance }) })
  });
}

function digest(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
