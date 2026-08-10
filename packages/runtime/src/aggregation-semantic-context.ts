import crypto from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  ARTIFACT_MANIFEST_FILE,
  ARTIFACT_VERIFICATION_SCHEMA_VERSION,
  MAX_GENERATED_TEST_COMPANION_BYTES,
  assertArtifactVerificationMarkerSemantics,
  assertGeneratedTestManifestSemantics,
  assertNoSymlinkComponents,
  assertPathInside,
  artifactContractDefinition,
  artifactContractSchemaBinding,
  parseStrictJsonBytes,
  readPlannedGraphDocument,
  readSinglyLinkedRegularFileSnapshotInside,
  safeResolveInside,
  validateArtifactContractBytes,
  validateArtifactManifest,
  validateArtifactVerificationMarker,
  type ArtifactManifest,
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

interface AuthenticatedPublicationSnapshot {
  path: string;
  absolutePath: string;
  bytes: Buffer;
  sha256: string;
}

interface AuthenticatedProducerAuthority {
  marker: ArtifactVerificationMarker;
  artifactManifest: ArtifactManifest;
  artifactManifestBytes: Buffer;
  publications: ReadonlyMap<string, AuthenticatedPublicationSnapshot>;
}

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
      const authority = authenticatedProducerAuthority(
        input.layout,
        graph.nodes,
        producer,
        attempt.attemptId,
        attempt.attemptIndex,
        artifactRoot
      );
      for (const output of generatedOutputs) {
        const markerArtifact = authority.marker.artifacts.find((artifact) => artifact.path === output.path);
        if (markerArtifact === undefined) {
          throw new Error(`verified producer ${attempt.attemptId} omits generated-test output ${output.path}`);
        }
        const manifestSnapshot = authority.publications.get(output.path);
        if (manifestSnapshot === undefined || markerArtifact.sha256 !== manifestSnapshot.sha256) {
          throw new Error(`verified generated-test manifest publication changed ${attempt.attemptId}/${output.path}`);
        }
        const validation = validateArtifactContractBytes(
          "ultrafuzz/generated-tests@3",
          manifestSnapshot.bytes,
          manifestSnapshot.absolutePath
        );
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
            authenticatedEntry("generated-test", entry, authority.publications)
          ),
          ...manifest.support_files.map((entry) => authenticatedEntry("support-file", entry, authority.publications))
        ];
        sourceBundles.push(
          Object.freeze({
            strategy: producer.logical_id,
            nodeId: manifest.node_id,
            sourceAttemptId: attempt.attemptId,
            attemptIndex: attempt.attemptIndex,
            sourceManifestPath: manifestSnapshot.absolutePath,
            sourceManifestRelativePath: output.path,
            sourceManifestSha256: manifestSnapshot.sha256,
            sourceRunId: manifest.run_id,
            framework: manifest.framework,
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

function authenticatedProducerAuthority(
  layout: RunLayout,
  nodes: readonly PlannedGraphNodeDocument[],
  producer: PlannedGraphNodeDocument,
  attemptId: string,
  attemptIndex: number,
  artifactRoot: string
): AuthenticatedProducerAuthority {
  const markerRoot = path.resolve(layout.root, VERIFICATION_MARKER_DIRECTORY);
  assertPathInside(layout.root, markerRoot, "artifact verification marker root");
  assertNoSymlinkComponents(layout.root, markerRoot, "artifact verification marker root");
  const markerPath = safeResolveInside(markerRoot, `${attemptId}.json`, "artifact verification marker");
  const markerBytes = readSinglyLinkedRegularFileSnapshotInside(
    markerRoot,
    markerPath,
    MAX_AGGREGATION_AUTHORITY_BYTES,
    "artifact verification marker"
  );
  const parsed = parseStrictJsonBytes(markerBytes);
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

  const artifactManifestPath = safeResolveInside(artifactRoot, ARTIFACT_MANIFEST_FILE, "producer artifact manifest");
  const artifactManifestBytes = readSinglyLinkedRegularFileSnapshotInside(
    artifactRoot,
    artifactManifestPath,
    MAX_AGGREGATION_AUTHORITY_BYTES,
    "producer artifact manifest"
  );
  const artifactManifestValue = parseStrictJsonBytes(artifactManifestBytes);
  const artifactManifestShape = validateArtifactManifest(artifactManifestValue);
  if (!artifactManifestShape.ok) throw new Error(`producer artifact manifest is invalid for ${attemptId}`);
  const artifactManifest = artifactManifestValue as ArtifactManifest;
  const provenanceMetadata = artifactManifest.provenance.metadata as { concrete_node_id?: string } | undefined;
  if (
    artifactManifest.run_id !== layout.runId ||
    artifactManifest.node_id !== attemptId ||
    artifactManifest.producer_node_id !== attemptId ||
    artifactManifest.provenance.producer_node_id !== attemptId ||
    artifactManifest.provenance.run_id !== layout.runId ||
    artifactManifest.provenance.logical_node_id !== producer.logical_id ||
    artifactManifest.provenance.attempt_index !== attemptIndex ||
    provenanceMetadata?.concrete_node_id !== producer.id ||
    !isDeepStrictEqual(artifactManifest.output_contracts, producer.outputs)
  ) {
    throw new Error(`producer artifact manifest identity changed for ${attemptId}`);
  }
  const expectedPrerequisites = producer.depends_on
    .flatMap((dependencyId) => {
      const dependency = nodes.find((candidate) => candidate.id === dependencyId);
      if (dependency === undefined)
        throw new Error(`producer dependency is absent from the planned graph: ${dependencyId}`);
      return plannedAttempts(dependency).map((attempt) => attempt.attemptId);
    })
    .sort();
  const actualPrerequisites = artifactManifest.prerequisite_manifests.map((entry) => entry.node_id).sort();
  if (!isDeepStrictEqual(actualPrerequisites, expectedPrerequisites)) {
    throw new Error(`producer artifact manifest prerequisite set changed for ${attemptId}`);
  }
  authenticatePrerequisiteManifestChain(layout, artifactManifest, attemptId);

  const manifestFiles = new Map(artifactManifest.files.map((entry) => [entry.path, entry]));
  const markerPublications = new Map(marker.publications.map((entry) => [entry.path, entry]));
  if (
    manifestFiles.size !== artifactManifest.files.length ||
    markerPublications.size !== marker.publications.length ||
    manifestFiles.size !== markerPublications.size ||
    [...manifestFiles.keys()].some((relativePath) => !markerPublications.has(relativePath))
  ) {
    throw new Error(`producer artifact manifest and verifier publication sets differ for ${attemptId}`);
  }
  const publications = new Map<string, AuthenticatedPublicationSnapshot>();
  for (const [relativePath, publication] of markerPublications) {
    const manifestFile = manifestFiles.get(relativePath)!;
    const absolutePath = safeResolveInside(artifactRoot, relativePath, "verified producer publication");
    const bytes = readSinglyLinkedRegularFileSnapshotInside(
      artifactRoot,
      absolutePath,
      MAX_AGGREGATION_AUTHORITY_BYTES,
      `verified producer publication ${relativePath}`
    );
    const sha256 = digest(bytes);
    if (
      publication.sha256 !== sha256 ||
      manifestFile.sha256 !== sha256 ||
      manifestFile.size_bytes !== bytes.byteLength
    ) {
      throw new Error(`verified producer publication changed ${attemptId}/${relativePath}`);
    }
    publications.set(relativePath, Object.freeze({ path: relativePath, absolutePath, bytes, sha256 }));
  }
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
    const publication = publications.get(output.path);
    if (publication === undefined || artifact.sha256 !== publication.sha256) {
      throw new Error(`verified producer output publication changed ${attemptId}/${output.path}`);
    }
  }
  return Object.freeze({
    marker,
    artifactManifest,
    artifactManifestBytes: Buffer.from(artifactManifestBytes),
    publications
  });
}

function authenticatePrerequisiteManifestChain(
  layout: RunLayout,
  rootManifest: ArtifactManifest,
  rootAttemptId: string
): void {
  const authenticated = new Map<string, { sha256: string; manifest: ArtifactManifest }>();
  const visiting = new Set<string>([rootAttemptId]);

  const authenticate = (nodeId: string, expectedSha256: string): ArtifactManifest => {
    const cached = authenticated.get(nodeId);
    if (cached !== undefined) {
      if (cached.sha256 !== expectedSha256) {
        throw new Error(`prerequisite artifact manifest has conflicting sealed digests for ${nodeId}`);
      }
      return cached.manifest;
    }
    if (visiting.has(nodeId)) {
      throw new Error(`prerequisite artifact manifest chain contains a cycle at ${nodeId}`);
    }
    visiting.add(nodeId);
    try {
      const artifactRoot = safeResolveInside(layout.artifactsDir, nodeId, "prerequisite artifact directory");
      const manifestPath = safeResolveInside(artifactRoot, ARTIFACT_MANIFEST_FILE, "prerequisite artifact manifest");
      const bytes = readSinglyLinkedRegularFileSnapshotInside(
        artifactRoot,
        manifestPath,
        MAX_AGGREGATION_AUTHORITY_BYTES,
        `prerequisite artifact manifest ${nodeId}`
      );
      const sha256 = digest(bytes);
      if (sha256 !== expectedSha256) {
        throw new Error(`prerequisite artifact manifest bytes changed for ${nodeId}`);
      }
      const value = parseStrictJsonBytes(bytes);
      const shape = validateArtifactManifest(value);
      if (!shape.ok) throw new Error(`prerequisite artifact manifest is invalid for ${nodeId}`);
      const manifest = value as ArtifactManifest;
      if (
        manifest.run_id !== layout.runId ||
        manifest.node_id !== nodeId ||
        manifest.producer_node_id !== nodeId ||
        manifest.provenance.run_id !== layout.runId ||
        manifest.provenance.producer_node_id !== nodeId
      ) {
        throw new Error(`prerequisite artifact manifest identity changed for ${nodeId}`);
      }
      const prerequisiteIds = new Set(manifest.prerequisite_manifests.map((entry) => entry.node_id));
      if (prerequisiteIds.size !== manifest.prerequisite_manifests.length) {
        throw new Error(`prerequisite artifact manifest repeats a prerequisite for ${nodeId}`);
      }
      for (const prerequisite of manifest.prerequisite_manifests) {
        authenticate(prerequisite.node_id, prerequisite.sha256);
      }
      authenticated.set(nodeId, { sha256, manifest });
      return manifest;
    } finally {
      visiting.delete(nodeId);
    }
  };

  const rootPrerequisiteIds = new Set(rootManifest.prerequisite_manifests.map((entry) => entry.node_id));
  if (rootPrerequisiteIds.size !== rootManifest.prerequisite_manifests.length) {
    throw new Error(`producer artifact manifest repeats a prerequisite for ${rootAttemptId}`);
  }
  for (const prerequisite of rootManifest.prerequisite_manifests) {
    authenticate(prerequisite.node_id, prerequisite.sha256);
  }
}

function authenticatedEntry(
  kind: "generated-test" | "support-file",
  entry: GeneratedTestEntry,
  publications: ReadonlyMap<string, AuthenticatedPublicationSnapshot>
): SemanticAggregationSourceEntryContext {
  const publication = publications.get(entry.path);
  if (
    publication === undefined ||
    publication.bytes.length > MAX_GENERATED_TEST_COMPANION_BYTES ||
    publication.bytes.length !== entry.size_bytes ||
    publication.sha256 !== entry.sha256
  ) {
    throw new Error(`verified generated-test companion publication changed ${entry.path}`);
  }
  return Object.freeze({
    kind,
    sourceArtifactPath: publication.absolutePath,
    sourceRelativePath: entry.path,
    sizeBytes: entry.size_bytes,
    sha256: entry.sha256,
    bytes: Buffer.from(publication.bytes),
    ...(entry.language === undefined ? {} : { language: entry.language }),
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.provenance === undefined ? {} : { provenance: Object.freeze({ ...entry.provenance }) })
  });
}

function digest(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
