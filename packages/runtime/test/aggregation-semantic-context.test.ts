import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ARTIFACT_VERIFICATION_SCHEMA_VERSION,
  PLANNED_GRAPH_SCHEMA_VERSION,
  artifactContractDefinition,
  artifactContractSchemaBinding,
  createRunLayout,
  executeSchemaSemanticGates,
  writeArtifact,
  writeArtifactManifest,
  writeJsonDurable,
  type ArtifactContractId,
  type ArtifactManifest,
  type ArtifactVerificationMarker,
  type PlannedGraphDocument,
  type PlannedGraphNodeDocument,
  type PlannedGraphOutput,
  type RunLayout
} from "@ultrafuzz/artifacts";

import { authenticatedAggregationSemanticContext } from "../src/aggregation-semantic-context.js";

interface AggregationAuthorityFixture {
  layout: RunLayout;
  aggregationNode: PlannedGraphNodeDocument;
  expectedPrerequisiteAttemptIds: string[];
  prerequisiteManifestPaths: string[];
  originManifestPath: string;
  unrelatedManifestPath: string;
  markerPath: string;
  artifactManifestPath: string;
  generatedManifestPath: string;
  generatedTestPath: string;
  supportFilePath: string;
}

interface RunFileSnapshot {
  bytes: Buffer;
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface RunTreeSnapshot {
  directories: string[];
  files: Map<string, RunFileSnapshot>;
}

test("authenticated aggregation context accepts the exact sealed producer authority", (t) => {
  const fixture = createAggregationAuthorityFixture("aggregation-authority-valid");
  t.after(() => fs.rmSync(path.dirname(fixture.layout.root), { recursive: true, force: true }));

  const before = snapshotRunTree(fixture.layout.root);
  const context = authenticatedContext(fixture);

  assert.equal(context.sourceBundles.length, 1);
  assert.deepEqual(
    context.sourceBundles.map((bundle) => ({
      strategy: bundle.strategy,
      sourceAttemptId: bundle.sourceAttemptId,
      sourceManifestRelativePath: bundle.sourceManifestRelativePath,
      sourceRunId: bundle.sourceRunId,
      framework: bundle.framework,
      entries: bundle.entries.map((entry) => ({ kind: entry.kind, path: entry.sourceRelativePath }))
    })),
    [
      {
        strategy: "generated-producer",
        sourceAttemptId: "generated-producer",
        sourceManifestRelativePath: "generated-tests.json",
        sourceRunId: "aggregation-authority-valid",
        framework: "foundry",
        entries: [
          { kind: "generated-test", path: "generated-tests/Property.t.sol" },
          { kind: "support-file", path: "generated-tests/PropertyHelper.sol" }
        ]
      }
    ]
  );
  assert.deepEqual(snapshotRunTree(fixture.layout.root), before);
});

test("authenticated aggregation source authority rejects hard-linked sealed inputs without mutation", async (t) => {
  const cases: Array<{ name: string; select: (fixture: AggregationAuthorityFixture) => string }> = [
    { name: "verification marker", select: (fixture) => fixture.markerPath },
    { name: "artifact manifest", select: (fixture) => fixture.artifactManifestPath },
    { name: "generated-test manifest", select: (fixture) => fixture.generatedManifestPath },
    { name: "declared companion", select: (fixture) => fixture.supportFilePath }
  ];

  for (const [index, attack] of cases.entries()) {
    await t.test(attack.name, (subtest) => {
      const fixture = createAggregationAuthorityFixture(`aggregation-hardlink-${index}`);
      subtest.after(() => fs.rmSync(path.dirname(fixture.layout.root), { recursive: true, force: true }));
      const target = attack.select(fixture);
      const attackerDirectory = path.join(fixture.layout.root, "attacker-links");
      fs.mkdirSync(attackerDirectory);
      fs.linkSync(target, path.join(attackerDirectory, `${index}.alias`));
      assert.equal(fs.lstatSync(target, { bigint: true }).nlink, 2n);

      assertAuthorityRejectedWithoutMutation(fixture, /must be a singly linked regular file/u);
      assert.equal(fs.lstatSync(target, { bigint: true }).nlink, 2n);
    });
  }
});

test("authenticated aggregation source authority requires exact marker and artifact-manifest publication sets", async (t) => {
  const attacks: Array<{
    name: string;
    mutate: (fixture: AggregationAuthorityFixture) => void;
  }> = [
    {
      name: "marker omits a declared companion",
      mutate(fixture) {
        mutateMarker(fixture, (marker) => {
          marker.publications = marker.publications.filter(
            (publication) => publication.path !== "generated-tests/PropertyHelper.sol"
          );
        });
      }
    },
    {
      name: "marker fabricates an extra publication",
      mutate(fixture) {
        mutateMarker(fixture, (marker) => {
          marker.publications.push({ path: "generated-tests/Extra.sol", sha256: "0".repeat(64) });
        });
      }
    },
    {
      name: "artifact manifest omits a declared companion",
      mutate(fixture) {
        mutateArtifactManifest(fixture, (manifest) => {
          manifest.files = manifest.files.filter((entry) => entry.path !== "generated-tests/PropertyHelper.sol");
        });
      }
    },
    {
      name: "artifact manifest fabricates an extra publication",
      mutate(fixture) {
        mutateArtifactManifest(fixture, (manifest) => {
          const template = manifest.files.find((entry) => entry.path === "generated-tests/PropertyHelper.sol");
          assert.ok(template);
          manifest.files.push({ ...structuredClone(template), path: "generated-tests/Extra.sol" });
        });
      }
    }
  ];

  for (const [index, attack] of attacks.entries()) {
    await t.test(attack.name, (subtest) => {
      const fixture = createAggregationAuthorityFixture(`aggregation-publications-${index}`);
      subtest.after(() => fs.rmSync(path.dirname(fixture.layout.root), { recursive: true, force: true }));
      attack.mutate(fixture);
      assertAuthorityRejectedWithoutMutation(fixture, /publication sets differ/u);
    });
  }
});

test("authenticated aggregation source authority rejects prerequisite fanout attempt-set drift", async (t) => {
  const attacks: Array<{
    name: string;
    mutate: (fixture: AggregationAuthorityFixture, manifest: ArtifactManifest) => void;
  }> = [
    {
      name: "one planned prerequisite attempt is omitted",
      mutate(fixture, manifest) {
        manifest.prerequisite_manifests = manifest.prerequisite_manifests.filter(
          (entry) => entry.node_id !== fixture.expectedPrerequisiteAttemptIds[1]
        );
      }
    },
    {
      name: "a planned prerequisite attempt is replaced with a fabricated attempt",
      mutate(_fixture, manifest) {
        manifest.prerequisite_manifests[1] = {
          ...manifest.prerequisite_manifests[1]!,
          node_id: "seed__model_9__attempt_9"
        };
      }
    }
  ];

  for (const [index, attack] of attacks.entries()) {
    await t.test(attack.name, (subtest) => {
      const fixture = createAggregationAuthorityFixture(`aggregation-prerequisites-${index}`);
      subtest.after(() => fs.rmSync(path.dirname(fixture.layout.root), { recursive: true, force: true }));
      assert.deepEqual(
        readJsonFile<ArtifactManifest>(fixture.artifactManifestPath).prerequisite_manifests.map(
          (entry) => entry.node_id
        ),
        fixture.expectedPrerequisiteAttemptIds
      );
      mutateArtifactManifest(fixture, (manifest) => attack.mutate(fixture, manifest));
      assertAuthorityRejectedWithoutMutation(fixture, /prerequisite set changed/u);
    });
  }
});

test("authenticated aggregation source authority snapshots the sealed prerequisite manifest chain", async (t) => {
  await t.test("hard-linked prerequisite manifest", (subtest) => {
    const fixture = createAggregationAuthorityFixture("aggregation-prerequisite-hardlink");
    subtest.after(() => fs.rmSync(path.dirname(fixture.layout.root), { recursive: true, force: true }));
    const manifestPath = fixture.prerequisiteManifestPaths[0]!;
    const aliasPath = path.join(fixture.layout.root, "prerequisite-manifest.alias.json");
    fs.linkSync(manifestPath, aliasPath);

    assertAuthorityRejectedWithoutMutation(fixture, /must be a singly linked regular file/u);
    assert.equal(fs.lstatSync(manifestPath).nlink, 2);
    assert.deepEqual(fs.readFileSync(aliasPath), fs.readFileSync(manifestPath));
  });

  await t.test("stale prerequisite manifest digest", (subtest) => {
    const fixture = createAggregationAuthorityFixture("aggregation-prerequisite-byte-drift");
    subtest.after(() => fs.rmSync(path.dirname(fixture.layout.root), { recursive: true, force: true }));
    const manifestPath = fixture.prerequisiteManifestPaths[0]!;
    const manifest = readJsonFile<ArtifactManifest>(manifestPath);
    manifest.created_at = "2026-08-10T00:00:00.000Z";
    writeJsonForAttack(manifestPath, manifest);

    assertAuthorityRejectedWithoutMutation(fixture, /prerequisite artifact manifest bytes changed/u);
  });
});

test("authenticated aggregation source authority reconciles every transitive manifest with the planned graph", async (t) => {
  await t.test("stale grandparent bytes", (subtest) => {
    const fixture = createAggregationAuthorityFixture("aggregation-stale-grandparent");
    subtest.after(() => fs.rmSync(path.dirname(fixture.layout.root), { recursive: true, force: true }));
    mutateManifestAtPath(fixture.originManifestPath, (manifest) => {
      manifest.created_at = "2026-08-10T00:00:01.000Z";
    });

    assertAuthorityRejectedWithoutMutation(fixture, /prerequisite artifact manifest bytes changed for origin/u);
  });

  await t.test("omitted planned grandparent after attacker reseals descendants", (subtest) => {
    const fixture = createAggregationAuthorityFixture("aggregation-omitted-grandparent");
    subtest.after(() => fs.rmSync(path.dirname(fixture.layout.root), { recursive: true, force: true }));
    mutateManifestAtPath(fixture.prerequisiteManifestPaths[0]!, (manifest) => {
      manifest.prerequisite_manifests = [];
    });
    resealProducerPrerequisiteDigests(fixture);

    assertAuthorityRejectedWithoutMutation(
      fixture,
      /prerequisite artifact manifest prerequisite set changed for seed__model_0__attempt_0/u
    );
  });

  await t.test("fabricated graph-known nondependency after attacker reseals descendants", (subtest) => {
    const fixture = createAggregationAuthorityFixture("aggregation-fabricated-grandparent");
    subtest.after(() => fs.rmSync(path.dirname(fixture.layout.root), { recursive: true, force: true }));
    mutateManifestAtPath(fixture.prerequisiteManifestPaths[0]!, (manifest) => {
      manifest.prerequisite_manifests.push({
        node_id: "unrelated-generated-producer",
        sha256: digest(fs.readFileSync(fixture.unrelatedManifestPath))
      });
    });
    resealProducerPrerequisiteDigests(fixture);

    assertAuthorityRejectedWithoutMutation(
      fixture,
      /prerequisite artifact manifest prerequisite set changed for seed__model_0__attempt_0/u
    );
  });

  await t.test("transitive manifest identity drift after attacker reseals the complete chain", (subtest) => {
    const fixture = createAggregationAuthorityFixture("aggregation-grandparent-identity");
    subtest.after(() => fs.rmSync(path.dirname(fixture.layout.root), { recursive: true, force: true }));
    mutateManifestAtPath(fixture.originManifestPath, (manifest) => {
      manifest.provenance.logical_node_id = "unrelated-generated-producer";
    });
    const originSha256 = digest(fs.readFileSync(fixture.originManifestPath));
    for (const manifestPath of fixture.prerequisiteManifestPaths) {
      mutateManifestAtPath(manifestPath, (manifest) => {
        manifest.prerequisite_manifests[0]!.sha256 = originSha256;
      });
    }
    resealProducerPrerequisiteDigests(fixture);

    assertAuthorityRejectedWithoutMutation(fixture, /prerequisite artifact manifest identity changed for origin/u);
  });

  await t.test("diamond ancestors with conflicting sealed digests", (subtest) => {
    const fixture = createAggregationAuthorityFixture("aggregation-conflicting-diamond");
    subtest.after(() => fs.rmSync(path.dirname(fixture.layout.root), { recursive: true, force: true }));
    mutateManifestAtPath(fixture.prerequisiteManifestPaths[0]!, (manifest) => {
      manifest.prerequisite_manifests[0]!.sha256 = "f".repeat(64);
    });
    resealProducerPrerequisiteDigests(fixture);

    assertAuthorityRejectedWithoutMutation(
      fixture,
      /prerequisite artifact manifest has conflicting sealed digests for origin/u
    );
  });
});

test("authenticated aggregation context excludes graph-known generated-test nondependencies", (t) => {
  const fixture = createAggregationAuthorityFixture("aggregation-nondependency-producer");
  t.after(() => fs.rmSync(path.dirname(fixture.layout.root), { recursive: true, force: true }));

  const context = authenticatedContext(fixture);

  assert.deepEqual(
    context.sourceBundles.map((bundle) => bundle.sourceAttemptId),
    ["generated-producer"]
  );
  assert.equal(
    fs.existsSync(path.join(fixture.layout.root, ".ultrafuzz-verification", "unrelated-generated-producer.json")),
    false
  );
});

test("authenticated aggregation context distinguishes valid empty authority from a missing required producer", async (t) => {
  await t.test("one authenticated empty bundle remains an explicit typed source bundle", (subtest) => {
    const fixture = createAggregationAuthorityFixture("aggregation-empty-bundle");
    subtest.after(() => fs.rmSync(path.dirname(fixture.layout.root), { recursive: true, force: true }));
    makeGeneratedProducerBundleEmpty(fixture);
    const before = snapshotRunTree(fixture.layout.root);

    const context = authenticatedContext(fixture);

    assert.equal(context.sourceBundles.length, 1);
    assert.equal(context.sourceBundles[0]!.framework, "foundry");
    assert.deepEqual(context.sourceBundles[0]!.entries, []);
    assert.deepEqual(snapshotRunTree(fixture.layout.root), before);
  });

  await t.test("an exact graph with no generated-test producers admits the canonical empty aggregation", (subtest) => {
    const fixture = createNoGeneratedProducerFixture("aggregation-empty-producer-set");
    subtest.after(() => fs.rmSync(path.dirname(fixture.layout.root), { recursive: true, force: true }));
    const before = snapshotRunTree(fixture.layout.root);

    const context = authenticatedAggregationSemanticContext({
      layout: fixture.layout,
      node: fixture.aggregationNode,
      attemptId: fixture.aggregationNode.id
    });
    const document = {
      schema_version: "ultrafuzz.aggregation-manifest.v1",
      source_generated_tests: 0,
      copied_generated_tests: 0,
      source_support_files: 0,
      copied_support_files: 0,
      source_bundles: [],
      files: [],
      support_files: [],
      skipped_files: []
    };
    const results = executeSchemaSemanticGates("aggregation-manifest.schema.json", {
      document,
      context: { aggregation: context }
    });

    assert.deepEqual(context.sourceBundles, []);
    assert.deepEqual(
      results.filter((result) => result.status !== "passed"),
      []
    );
    assert.deepEqual(snapshotRunTree(fixture.layout.root), before);
  });

  await t.test("a declared generated-test producer without verifier authority fails closed", (subtest) => {
    const fixture = createAggregationAuthorityFixture("aggregation-missing-producer-marker");
    subtest.after(() => fs.rmSync(path.dirname(fixture.layout.root), { recursive: true, force: true }));
    fs.rmSync(fixture.markerPath);

    assertAuthorityRejectedWithoutMutation(fixture, /artifact verification marker/u);
  });
});

function createNoGeneratedProducerFixture(runId: string): {
  layout: RunLayout;
  aggregationNode: PlannedGraphNodeDocument;
} {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-empty-aggregation-authority-"));
  const seedNode = plannedNode("seed", [], boundOutput("seed.md", "ultrafuzz/nonempty-markdown@1"));
  const aggregationNode = plannedNode(
    "aggregate-test-files",
    [seedNode.id],
    boundOutput("aggregation-manifest.json", "ultrafuzz/aggregation-manifest@1")
  );
  const graph: PlannedGraphDocument = {
    schema_version: PLANNED_GRAPH_SCHEMA_VERSION,
    graph_version: "3",
    topology_version: 2,
    groups: {},
    nodes: [seedNode, aggregationNode]
  };
  const layout = createRunLayout({ outputRoot, runId, graph });
  fs.mkdirSync(path.join(layout.workspacesDir, aggregationNode.id), { recursive: true });
  return { layout, aggregationNode };
}

function makeGeneratedProducerBundleEmpty(fixture: AggregationAuthorityFixture): void {
  const generatedManifest = readJsonFile<{
    generated_tests: unknown[];
    support_files: unknown[];
  }>(fixture.generatedManifestPath);
  generatedManifest.generated_tests = [];
  generatedManifest.support_files = [];
  writeJsonForAttack(fixture.generatedManifestPath, generatedManifest);
  fs.rmSync(fixture.generatedTestPath);
  fs.rmSync(fixture.supportFilePath);

  const manifestSha256 = digest(fs.readFileSync(fixture.generatedManifestPath));
  const manifestSize = fs.statSync(fixture.generatedManifestPath).size;
  mutateArtifactManifest(fixture, (manifest) => {
    manifest.files = manifest.files.filter(
      (entry) => entry.path !== "generated-tests/Property.t.sol" && entry.path !== "generated-tests/PropertyHelper.sol"
    );
    const generatedManifestEntry = manifest.files.find((entry) => entry.path === "generated-tests.json");
    assert.ok(generatedManifestEntry);
    generatedManifestEntry.sha256 = manifestSha256;
    generatedManifestEntry.size_bytes = manifestSize;
  });
  mutateMarker(fixture, (marker) => {
    marker.publications = marker.publications.filter(
      (entry) => entry.path !== "generated-tests/Property.t.sol" && entry.path !== "generated-tests/PropertyHelper.sol"
    );
    const generatedArtifact = marker.artifacts.find((entry) => entry.path === "generated-tests.json");
    const generatedPublication = marker.publications.find((entry) => entry.path === "generated-tests.json");
    assert.ok(generatedArtifact);
    assert.ok(generatedPublication);
    generatedArtifact.sha256 = manifestSha256;
    generatedPublication.sha256 = manifestSha256;
  });
}

function resealProducerPrerequisiteDigests(fixture: AggregationAuthorityFixture): void {
  const currentDigests = new Map(
    fixture.prerequisiteManifestPaths.map((manifestPath) => [
      path.basename(path.dirname(manifestPath)),
      digest(fs.readFileSync(manifestPath))
    ])
  );
  mutateArtifactManifest(fixture, (manifest) => {
    for (const prerequisite of manifest.prerequisite_manifests) {
      const sha256 = currentDigests.get(prerequisite.node_id);
      if (sha256 !== undefined) prerequisite.sha256 = sha256;
    }
  });
}

function createAggregationAuthorityFixture(runId: string): AggregationAuthorityFixture {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-aggregation-authority-"));
  const originOutput = boundOutput("origin.md", "ultrafuzz/nonempty-markdown@1");
  const seedOutput = boundOutput("seed.md", "ultrafuzz/nonempty-markdown@1");
  const generatedOutput = boundOutput("generated-tests.json", "ultrafuzz/generated-tests@3");
  const aggregationOutput = boundOutput("aggregation-manifest.json", "ultrafuzz/aggregation-manifest@1");
  const originNode = plannedNode("origin", [], originOutput);
  const seedNode: PlannedGraphNodeDocument = {
    ...plannedNode("seed", [originNode.id], seedOutput),
    model_fanout: [
      {
        model_profile_id: "model-zero",
        agent_ref: "CodexAgent",
        model_index: 0,
        loop_index: 0,
        attempt_index: 0
      },
      {
        model_profile_id: "model-one",
        agent_ref: "CodexAgent",
        model_index: 1,
        loop_index: 0,
        attempt_index: 0
      }
    ]
  };
  const producerNode = plannedNode("generated-producer", [seedNode.id], generatedOutput);
  const unrelatedNode = plannedNode("unrelated-generated-producer", [], generatedOutput);
  const aggregationNode = plannedNode("aggregate-test-files", [producerNode.id], aggregationOutput);
  const graph: PlannedGraphDocument = {
    schema_version: PLANNED_GRAPH_SCHEMA_VERSION,
    graph_version: "3",
    topology_version: 2,
    groups: {},
    nodes: [originNode, seedNode, producerNode, unrelatedNode, aggregationNode]
  };
  const layout = createRunLayout({ outputRoot, runId, graph });
  writeArtifact(layout, originNode.id, originOutput.path, "origin\n");
  writeArtifactManifest({
    layout,
    nodeId: originNode.id,
    outputs: [originOutput],
    provenance: {
      logical_node_id: originNode.logical_id,
      attempt_index: 0,
      metadata: { concrete_node_id: originNode.id }
    }
  });
  const originManifestPath = path.join(layout.artifactsDir, originNode.id, "artifact-manifest.json");

  writeArtifact(
    layout,
    unrelatedNode.id,
    generatedOutput.path,
    `${JSON.stringify({
      schema_version: "ultrafuzz.generated-tests.v3",
      run_id: runId,
      node_id: unrelatedNode.logical_id,
      framework: "medusa",
      generated_tests: [],
      support_files: []
    })}\n`
  );
  writeArtifactManifest({
    layout,
    nodeId: unrelatedNode.id,
    outputs: [generatedOutput],
    provenance: {
      logical_node_id: unrelatedNode.logical_id,
      attempt_index: 0,
      metadata: { concrete_node_id: unrelatedNode.id }
    }
  });
  const unrelatedManifestPath = path.join(layout.artifactsDir, unrelatedNode.id, "artifact-manifest.json");

  const expectedPrerequisiteAttemptIds = ["seed__model_0__attempt_0", "seed__model_1__attempt_0"];
  const prerequisiteManifestPaths: string[] = [];
  for (const [modelIndex, attemptId] of expectedPrerequisiteAttemptIds.entries()) {
    writeArtifact(layout, attemptId, seedOutput.path, `seed ${modelIndex}\n`);
    writeArtifactManifest({
      layout,
      nodeId: attemptId,
      outputs: [seedOutput],
      prerequisiteNodeIds: [originNode.id],
      provenance: {
        logical_node_id: seedNode.logical_id,
        attempt_index: 0,
        model_index: modelIndex,
        metadata: { concrete_node_id: seedNode.id }
      }
    });
    prerequisiteManifestPaths.push(path.join(layout.artifactsDir, attemptId, "artifact-manifest.json"));
  }

  const generatedTestContents = Buffer.from("contract Property {}\n", "utf8");
  const supportFileContents = Buffer.from("library PropertyHelper {}\n", "utf8");
  const generatedTestRelativePath = "generated-tests/Property.t.sol";
  const supportFileRelativePath = "generated-tests/PropertyHelper.sol";
  const generatedManifest = {
    schema_version: "ultrafuzz.generated-tests.v3",
    run_id: runId,
    node_id: producerNode.logical_id,
    framework: "foundry",
    generated_tests: [generatedTestEntry(generatedTestRelativePath, generatedTestContents)],
    support_files: [generatedTestEntry(supportFileRelativePath, supportFileContents)]
  };
  const generatedTestPath = writeArtifact(layout, producerNode.id, generatedTestRelativePath, generatedTestContents);
  const supportFilePath = writeArtifact(layout, producerNode.id, supportFileRelativePath, supportFileContents);
  const generatedManifestPath = writeArtifact(
    layout,
    producerNode.id,
    generatedOutput.path,
    `${JSON.stringify(generatedManifest)}\n`
  );
  const artifactManifest = writeArtifactManifest({
    layout,
    nodeId: producerNode.id,
    outputs: [generatedOutput],
    prerequisiteNodeIds: expectedPrerequisiteAttemptIds,
    provenance: {
      logical_node_id: producerNode.logical_id,
      attempt_index: 0,
      metadata: { concrete_node_id: producerNode.id }
    }
  });
  const generatedManifestPublication = artifactManifest.files.find((entry) => entry.path === generatedOutput.path);
  assert.ok(generatedManifestPublication);
  const marker: ArtifactVerificationMarker = {
    schema_version: ARTIFACT_VERIFICATION_SCHEMA_VERSION,
    attempt_id: producerNode.id,
    node_id: producerNode.logical_id,
    artifacts: [{ ...generatedOutput, sha256: generatedManifestPublication.sha256 }],
    publications: artifactManifest.files.map((entry) => ({ path: entry.path, sha256: entry.sha256 }))
  };
  const markerPath = path.join(layout.root, ".ultrafuzz-verification", `${producerNode.id}.json`);
  writeJsonDurable(markerPath, marker);

  return {
    layout,
    aggregationNode,
    expectedPrerequisiteAttemptIds,
    prerequisiteManifestPaths,
    originManifestPath,
    unrelatedManifestPath,
    markerPath,
    artifactManifestPath: path.join(layout.artifactsDir, producerNode.id, "artifact-manifest.json"),
    generatedManifestPath,
    generatedTestPath,
    supportFilePath
  };
}

function plannedNode(id: string, dependsOn: string[], output: PlannedGraphOutput): PlannedGraphNodeDocument {
  return {
    id,
    logical_id: id,
    display_name: id,
    kind: "agentic",
    depends_on: dependsOn,
    artifact_dir: `artifacts/${id}`,
    outputs: [output],
    prompt_id: id,
    prompt_path: `prompts/${id}.md`,
    loop: { index: 0, count: 1, mode: "parallel", attempt_index: 0 },
    model_fanout: []
  };
}

function boundOutput(artifactPath: string, contract: ArtifactContractId): PlannedGraphOutput {
  return {
    path: artifactPath,
    contract,
    contract_digest: artifactContractDefinition(contract).digest,
    ...(artifactContractSchemaBinding(contract) ?? {}),
    primary: true
  };
}

function generatedTestEntry(
  entryPath: string,
  contents: Buffer
): {
  path: string;
  size_bytes: number;
  sha256: string;
} {
  return {
    path: entryPath,
    size_bytes: contents.byteLength,
    sha256: digest(contents)
  };
}

function authenticatedContext(fixture: AggregationAuthorityFixture) {
  return authenticatedAggregationSemanticContext({
    layout: fixture.layout,
    node: fixture.aggregationNode,
    attemptId: fixture.aggregationNode.id
  });
}

function assertAuthorityRejectedWithoutMutation(fixture: AggregationAuthorityFixture, expected: RegExp): void {
  const before = snapshotRunTree(fixture.layout.root);
  assert.throws(() => authenticatedContext(fixture), expected);
  assert.deepEqual(snapshotRunTree(fixture.layout.root), before);
}

function mutateMarker(
  fixture: AggregationAuthorityFixture,
  mutate: (marker: ArtifactVerificationMarker) => void
): void {
  const marker = readJsonFile<ArtifactVerificationMarker>(fixture.markerPath);
  mutate(marker);
  writeJsonForAttack(fixture.markerPath, marker);
}

function mutateArtifactManifest(
  fixture: AggregationAuthorityFixture,
  mutate: (manifest: ArtifactManifest) => void
): void {
  mutateManifestAtPath(fixture.artifactManifestPath, mutate);
}

function mutateManifestAtPath(filePath: string, mutate: (manifest: ArtifactManifest) => void): void {
  const manifest = readJsonFile<ArtifactManifest>(filePath);
  mutate(manifest);
  writeJsonForAttack(filePath, manifest);
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function writeJsonForAttack(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function snapshotRunTree(root: string): RunTreeSnapshot {
  const directories: string[] = [];
  const files = new Map<string, RunFileSnapshot>();
  const visit = (directory: string): void => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      if (entry.isDirectory()) {
        directories.push(relativePath);
        visit(absolutePath);
        continue;
      }
      const stat = fs.lstatSync(absolutePath, { bigint: true });
      assert.equal(stat.isFile(), true, `unexpected non-file in authority fixture: ${relativePath}`);
      files.set(relativePath, {
        bytes: fs.readFileSync(absolutePath),
        dev: stat.dev,
        ino: stat.ino,
        nlink: stat.nlink,
        size: stat.size,
        mtimeNs: stat.mtimeNs,
        ctimeNs: stat.ctimeNs
      });
    }
  };
  visit(root);
  return { directories, files };
}

function digest(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
