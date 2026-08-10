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

function createAggregationAuthorityFixture(runId: string): AggregationAuthorityFixture {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-aggregation-authority-"));
  const seedOutput = boundOutput("seed.md", "ultrafuzz/nonempty-markdown@1");
  const generatedOutput = boundOutput("generated-tests.json", "ultrafuzz/generated-tests@3");
  const aggregationOutput = boundOutput("aggregation-manifest.json", "ultrafuzz/aggregation-manifest@1");
  const seedNode: PlannedGraphNodeDocument = {
    ...plannedNode("seed", [], seedOutput),
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
  const aggregationNode = plannedNode("aggregate-test-files", [producerNode.id], aggregationOutput);
  const graph: PlannedGraphDocument = {
    schema_version: PLANNED_GRAPH_SCHEMA_VERSION,
    graph_version: "3",
    topology_version: 2,
    groups: {},
    nodes: [seedNode, producerNode, aggregationNode]
  };
  const layout = createRunLayout({ outputRoot, runId, graph });
  const expectedPrerequisiteAttemptIds = ["seed__model_0__attempt_0", "seed__model_1__attempt_0"];
  const prerequisiteManifestPaths: string[] = [];
  for (const [modelIndex, attemptId] of expectedPrerequisiteAttemptIds.entries()) {
    writeArtifact(layout, attemptId, seedOutput.path, `seed ${modelIndex}\n`);
    writeArtifactManifest({
      layout,
      nodeId: attemptId,
      outputs: [seedOutput],
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
  const manifest = readJsonFile<ArtifactManifest>(fixture.artifactManifestPath);
  mutate(manifest);
  writeJsonForAttack(fixture.artifactManifestPath, manifest);
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
