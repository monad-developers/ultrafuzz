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
const MAX_AGGREGATION_PREREQUISITE_MANIFESTS = 4_096;
const MAX_AGGREGATION_PREREQUISITE_EDGES = 16_384;
const MAX_AGGREGATION_PREREQUISITE_BYTES = 64 * 1024 * 1024;
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

interface PlannedAttemptAuthority {
  node: PlannedGraphNodeDocument;
  attemptId: string;
  attemptIndex: number;
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

function plannedAttemptAuthorities(nodes: readonly PlannedGraphNodeDocument[]): Map<string, PlannedAttemptAuthority> {
  const authorities = new Map<string, PlannedAttemptAuthority>();
  for (const node of nodes) {
    for (const attempt of plannedAttempts(node)) {
      if (authorities.has(attempt.attemptId)) {
        throw new Error(`planned graph repeats artifact attempt authority ${attempt.attemptId}`);
      }
      authorities.set(attempt.attemptId, { node, ...attempt });
    }
  }
  return authorities;
}

function plannedPrerequisiteAttempts(
  node: PlannedGraphNodeDocument,
  nodesById: ReadonlyMap<string, PlannedGraphNodeDocument>
): PlannedAttemptAuthority[] {
  return node.depends_on
    .flatMap((dependencyId) => {
      const dependency = nodesById.get(dependencyId);
      if (dependency === undefined) {
        throw new Error(`producer dependency is absent from the planned graph: ${dependencyId}`);
      }
      return plannedAttempts(dependency).map((attempt) => ({ node: dependency, ...attempt }));
    })
    .sort((left, right) => left.attemptId.localeCompare(right.attemptId));
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
  authenticatePrerequisiteManifestChain(layout, nodes, artifactManifest, attemptId);

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
    const expected = {
      path: output.path,
      contract: output.contract,
      contract_digest: output.contract_digest,
      ...(output.schema_file === undefined
        ? {}
        : {
            schema_file: output.schema_file,
            schema_id: output.schema_id,
            schema_sha256: output.schema_sha256,
            schema_bundle_sha256: output.schema_bundle_sha256,
            validator_build: output.validator_build
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
  nodes: readonly PlannedGraphNodeDocument[],
  rootManifest: ArtifactManifest,
  rootAttemptId: string
): void {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const attemptsById = plannedAttemptAuthorities(nodes);
  const rootAuthority = attemptsById.get(rootAttemptId);
  if (rootAuthority === undefined) {
    throw new Error(`producer attempt is absent from the planned graph: ${rootAttemptId}`);
  }

  const pending: Array<{ authority: PlannedAttemptAuthority; expectedSha256: string }> = [];
  const scheduledDigests = new Map<string, string>();
  const schedule = (authority: PlannedAttemptAuthority, expectedSha256: string): void => {
    const previous = scheduledDigests.get(authority.attemptId);
    if (previous !== undefined) {
      if (previous !== expectedSha256) {
        throw new Error(`prerequisite artifact manifest has conflicting sealed digests for ${authority.attemptId}`);
      }
      return;
    }
    if (scheduledDigests.size >= MAX_AGGREGATION_PREREQUISITE_MANIFESTS) {
      throw new Error(
        `prerequisite artifact manifest chain exceeds ${MAX_AGGREGATION_PREREQUISITE_MANIFESTS} manifests`
      );
    }
    scheduledDigests.set(authority.attemptId, expectedSha256);
    pending.push({ authority, expectedSha256 });
  };

  const rootExpectedPrerequisites = plannedPrerequisiteAttempts(rootAuthority.node, nodesById);
  const rootExpectedById = new Map(rootExpectedPrerequisites.map((entry) => [entry.attemptId, entry]));
  const rootActualIds = rootManifest.prerequisite_manifests.map((entry) => entry.node_id).sort();
  if (!isDeepStrictEqual(rootActualIds, [...rootExpectedById.keys()].sort())) {
    throw new Error(`producer artifact manifest prerequisite set changed for ${rootAttemptId}`);
  }
  for (const prerequisite of rootManifest.prerequisite_manifests) {
    schedule(rootExpectedById.get(prerequisite.node_id)!, prerequisite.sha256);
  }

  let authenticatedManifestCount = 0;
  let authenticatedEdgeCount = rootManifest.prerequisite_manifests.length;
  let authenticatedBytes = 0;
  if (authenticatedEdgeCount > MAX_AGGREGATION_PREREQUISITE_EDGES) {
    throw new Error(`prerequisite artifact manifest chain exceeds ${MAX_AGGREGATION_PREREQUISITE_EDGES} edges`);
  }

  while (pending.length > 0) {
    const { authority, expectedSha256 } = pending.pop()!;
    const remainingBytes = MAX_AGGREGATION_PREREQUISITE_BYTES - authenticatedBytes;
    if (remainingBytes <= 0) {
      throw new Error(`prerequisite artifact manifest chain exceeds ${MAX_AGGREGATION_PREREQUISITE_BYTES} bytes`);
    }
    const artifactRoot = safeResolveInside(layout.artifactsDir, authority.attemptId, "prerequisite artifact directory");
    const manifestPath = safeResolveInside(artifactRoot, ARTIFACT_MANIFEST_FILE, "prerequisite artifact manifest");
    const bytes = readSinglyLinkedRegularFileSnapshotInside(
      artifactRoot,
      manifestPath,
      Math.min(MAX_AGGREGATION_AUTHORITY_BYTES, remainingBytes),
      `prerequisite artifact manifest ${authority.attemptId}`
    );
    authenticatedBytes += bytes.byteLength;
    authenticatedManifestCount += 1;
    const sha256 = digest(bytes);
    if (sha256 !== expectedSha256) {
      throw new Error(`prerequisite artifact manifest bytes changed for ${authority.attemptId}`);
    }
    const value = parseStrictJsonBytes(bytes);
    const shape = validateArtifactManifest(value);
    if (!shape.ok) throw new Error(`prerequisite artifact manifest is invalid for ${authority.attemptId}`);
    const manifest = value as ArtifactManifest;
    const provenanceMetadata = manifest.provenance.metadata as { concrete_node_id?: string } | undefined;
    if (
      manifest.run_id !== layout.runId ||
      manifest.node_id !== authority.attemptId ||
      manifest.producer_node_id !== authority.attemptId ||
      manifest.provenance.run_id !== layout.runId ||
      manifest.provenance.producer_node_id !== authority.attemptId ||
      manifest.provenance.logical_node_id !== authority.node.logical_id ||
      !isDeepStrictEqual(manifest.output_contracts, authority.node.outputs) ||
      (authority.node.kind === "agentic" &&
        (manifest.provenance.attempt_index !== authority.attemptIndex ||
          provenanceMetadata?.concrete_node_id !== authority.node.id))
    ) {
      throw new Error(`prerequisite artifact manifest identity changed for ${authority.attemptId}`);
    }

    const expectedPrerequisites = plannedPrerequisiteAttempts(authority.node, nodesById);
    const expectedById = new Map(expectedPrerequisites.map((entry) => [entry.attemptId, entry]));
    const actualIds = manifest.prerequisite_manifests.map((entry) => entry.node_id).sort();
    if (!isDeepStrictEqual(actualIds, [...expectedById.keys()].sort())) {
      throw new Error(`prerequisite artifact manifest prerequisite set changed for ${authority.attemptId}`);
    }
    authenticatedEdgeCount += manifest.prerequisite_manifests.length;
    if (authenticatedEdgeCount > MAX_AGGREGATION_PREREQUISITE_EDGES) {
      throw new Error(`prerequisite artifact manifest chain exceeds ${MAX_AGGREGATION_PREREQUISITE_EDGES} edges`);
    }
    for (const prerequisite of manifest.prerequisite_manifests) {
      schedule(expectedById.get(prerequisite.node_id)!, prerequisite.sha256);
    }
  }

  if (authenticatedManifestCount !== scheduledDigests.size) {
    throw new Error(`prerequisite artifact manifest chain authentication was incomplete for ${rootAttemptId}`);
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
