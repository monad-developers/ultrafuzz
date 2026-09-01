import assert from "node:assert/strict";
import { temporaryRoot } from "./temporary-root.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  ARTIFACT_VERIFICATION_SCHEMA_VERSION,
  PLANNED_GRAPH_SCHEMA_VERSION,
  SMITHERS_TASK_MANIFEST_SCHEMA_VERSION,
  SMITHERS_TASK_METADATA_SCHEMA_VERSION,
  artifactContractDefinition,
  artifactContractSchemaBinding,
  createRunLayout,
  getNodeArtifactDir,
  updateNodeState,
  writeArtifactManifest,
  writeFileDurable,
  writeJsonDurable,
  type ArtifactManifest,
  type ArtifactManifestOutputContract,
  type ArtifactVerificationMarker,
  type PlannedGraphDocument,
  type PlannedGraphNodeDocument,
  type RunLayout,
  type SmithersTaskManifestDocument,
  type SmithersTaskManifestTask
} from "@ultrafuzz/artifacts";

import { projectCanonicalFinalReport } from "../src/final-report-markdown.js";
import { WORKFLOW_CONTROL_INTEGRITY_SCHEMA_VERSION } from "../src/runtime-contracts.js";
import {
  assertVerifiedRunOutputAuthorityRemainedCurrent,
  loadVerifiedFinalReportSnapshot,
  loadVerifiedNodeOutputSnapshot,
  loadVerifiedRunOutputAuthoritySnapshot,
  loadVerifiedRunOutputSnapshots,
  VerifiedOutputError
} from "../src/verified-output.js";

const WORKFLOW_RUN_ID = "workflow-current";
const REPORT_ATTEMPT_ID = "release-summary";
const REPORT_LOGICAL_ID = "security-report";
const REPORT_JSON_PATH = "deliverables/current-audit.json";
const REPORT_MARKDOWN_PATH = "deliverables/current-audit.md";

interface ReportFixture {
  layout: RunLayout;
  attemptId: string;
  reportPath: string;
  markdownPath: string;
  reportBytes: Buffer;
  markdownBytes: Buffer;
}

interface CampaignAuthorityFixture {
  layout: RunLayout;
  evidencePath: string;
  evidenceBytes: Buffer;
}

test("verified final-report reader binds immutable current bytes to verifier and controller authority", () => {
  const fixture = createVerifiedReportFixture("verified-report-current");

  const loaded = loadVerifiedFinalReportSnapshot(fixture.layout.root);

  assert.equal(loaded.authority.attempt_id, REPORT_ATTEMPT_ID);
  assert.equal(loaded.authority.logical_node_id, REPORT_LOGICAL_ID);
  assert.equal(loaded.artifacts.source, "verified-agent-report");
  assert.equal(loaded.artifacts.json_path, fixture.reportPath);
  assert.equal(loaded.artifacts.markdown_path, fixture.markdownPath);
  assert.deepEqual(loaded.json_bytes, fixture.reportBytes);
  assert.deepEqual(loaded.markdown_bytes, fixture.markdownBytes);
  assert.deepEqual(fs.readFileSync(fixture.reportPath), fixture.reportBytes);
  assert.deepEqual(fs.readFileSync(fixture.markdownPath), fixture.markdownBytes);
  assert.deepEqual(
    loaded.authority.publications.map((publication) => publication.absolute_path),
    [fixture.markdownPath, fixture.reportPath]
  );

  const runSnapshots = loadVerifiedRunOutputSnapshots(fixture.layout.root);
  assert.equal(runSnapshots.length, 1);
  assert.equal(runSnapshots[0]!.attempt_id, fixture.attemptId);
  assert.deepEqual(
    runSnapshots[0]!.publications.map((publication) => publication.bytes),
    [fixture.markdownBytes, fixture.reportBytes]
  );
});

test("verified output readers reject authenticated historical publications containing secrets", () => {
  const issue = currentIssue();
  // A positively identified vendor-format credential: the publication gate
  // scans positive-only (#819), so a bare `token=` keyword assignment is a
  // display-redaction heuristic and no longer fails publication.
  issue.description = "Executor leaked ghp_AbCdEf1234567890AbCdEf1234567890AbCd"; // gitleaks:allow -- fixed placeholder asserted on by the redaction tests
  const fixture = createVerifiedReportFixture("verified-report-secret-contamination", {
    report: currentReport("verified-report-secret-contamination", [issue])
  });
  const reportBefore = fs.readFileSync(fixture.reportPath);
  const markdownBefore = fs.readFileSync(fixture.markdownPath);

  assert.throws(
    () => loadVerifiedNodeOutputSnapshot({ runRoot: fixture.layout.root, logicalNodeId: REPORT_LOGICAL_ID }),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_INVALID" &&
      /secret-safety validation/iu.test(error.message)
  );
  assert.deepEqual(fs.readFileSync(fixture.reportPath), reportBefore);
  assert.deepEqual(fs.readFileSync(fixture.markdownPath), markdownBefore);
});

test("verified final-report reader rejects a schema-valid report that claims another run", () => {
  const fixture = createVerifiedReportFixture("verified-report-run-identity", {
    report: currentReport("different-run")
  });
  const reportBefore = fs.readFileSync(fixture.reportPath);
  const markdownBefore = fs.readFileSync(fixture.markdownPath);

  assert.throws(
    () => loadVerifiedFinalReportSnapshot(fixture.layout.root),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_INVALID" &&
      /run_metadata\.run_id does not match the authenticated Ultrafuzz run/iu.test(error.message)
  );
  assert.deepEqual(fs.readFileSync(fixture.reportPath), reportBefore);
  assert.deepEqual(fs.readFileSync(fixture.markdownPath), markdownBefore);
});

test("verified final-report selection resolves one finalized sealed model-fanout attempt", () => {
  const selectedAttempt = `${REPORT_ATTEMPT_ID}__model_0__attempt_0`;
  const fixture = createVerifiedReportFixture("verified-report-model-fanout", {
    attemptId: selectedAttempt,
    modelFanout: [
      {
        model_profile_id: "review-a",
        agent_ref: "CodexAgent",
        model_name: "gpt-test-a",
        reasoning_effort: "high",
        model_index: 0,
        loop_index: 0,
        attempt_index: 0
      },
      {
        model_profile_id: "review-b",
        agent_ref: "CodexAgent",
        model_name: "gpt-test-b",
        reasoning_effort: "high",
        model_index: 1,
        loop_index: 0,
        attempt_index: 0
      }
    ]
  });

  const loaded = loadVerifiedFinalReportSnapshot(fixture.layout.root);

  assert.equal(loaded.authority.attempt_id, selectedAttempt);
  assert.equal(loaded.authority.logical_node_id, REPORT_LOGICAL_ID);
});

function goalSearchCoverageCensus(runId: string): Record<string, unknown> {
  return {
    schema_version: "ultrafuzz.goal-search-coverage.v1",
    run_id: runId,
    totals: { planned: 2 },
    goals: [
      {
        node_id: "dynamic:class:1",
        logical_node_id: "class-goals",
        attempt_id: "attempt-001",
        status: "completed-no-findings",
        finding_count: 0
      },
      {
        node_id: "dynamic:class:2",
        logical_node_id: "class-goals",
        attempt_id: "attempt-002",
        status: "stopped-early",
        finding_count: null
      }
    ]
  };
}

test("verified final-report reader returns the census-rendered coverage without re-rendering", () => {
  const runId = "verified-report-goal-census";
  const report = currentReport(runId);
  const census = goalSearchCoverageCensus(runId);
  const fixture = createVerifiedReportFixture(runId, {
    report,
    markdown: projectCanonicalFinalReport(report, { goalSearchCoverage: census }).markdown
  });
  writeJsonDurable(path.join(fixture.layout.root, "goal-search-coverage.json"), census);

  const loaded = loadVerifiedFinalReportSnapshot(fixture.layout.root);

  assert.match(loaded.markdown, /^## Goal search coverage$/mu);
  assert.match(
    loaded.markdown,
    /\*\*Partial goal search coverage: only 1 of the 2 targeted goal searches completed\.\*\*/u
  );
  // The runtime-published bytes come back unchanged: external readers agree with the runtime
  // verifier about coverage without anyone running `ultrafuzz report` (issue #702).
  assert.deepEqual(loaded.markdown_bytes, fixture.markdownBytes);
});

test("verified final-report reader rejects census-less Markdown once the run recorded a census", () => {
  const runId = "verified-report-goal-census-mismatch";
  const fixture = createVerifiedReportFixture(runId);
  writeJsonDurable(path.join(fixture.layout.root, "goal-search-coverage.json"), goalSearchCoverageCensus(runId));

  assert.throws(
    () => loadVerifiedFinalReportSnapshot(fixture.layout.root),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_INVALID" &&
      /report\.md is not the canonical projection of report\.json/iu.test(error.message)
  );
});

test("run-wide publication capture fails closed for reused outputs without current-run authority", () => {
  const fixture = createVerifiedReportFixture("verified-report-reused");
  updateNodeState(fixture.layout, fixture.attemptId, { status: "reused-from-prior-run" });

  assert.throws(
    () => loadVerifiedRunOutputSnapshots(fixture.layout.root),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_AUTHORITY_INVALID" &&
      /reused sealed task.*no current-run.*authority/iu.test(error.message)
  );
});

test("run-wide recursive consumers reject an exact authority change after capture", () => {
  const fixture = createVerifiedReportFixture("verified-report-run-authority-race");
  const snapshot = loadVerifiedRunOutputAuthoritySnapshot(fixture.layout.root);
  const stateBytes = fs.readFileSync(fixture.layout.statePath);

  fs.appendFileSync(fixture.layout.statePath, "\n", "utf8");

  assert.throws(
    () => assertVerifiedRunOutputAuthorityRemainedCurrent(snapshot),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_CHANGED" &&
      /run output authority changed while recursive bundle inputs were being captured/iu.test(error.message)
  );
  assert.deepEqual(snapshot.state.bytes, stateBytes);
  assert.deepEqual(fs.readFileSync(fixture.layout.statePath), Buffer.concat([stateBytes, Buffer.from("\n")]));
});

test("run-wide authority exposes exact graph-fingerprint and deduplicated manifest bytes", () => {
  const fixture = createVerifiedReportFixture("verified-report-run-manifest-authority", { withPrerequisite: true });
  const snapshot = loadVerifiedRunOutputAuthoritySnapshot(fixture.layout.root);
  const expectedManifestPaths = [
    path.join(fixture.layout.artifactsDir, "producer", "artifact-manifest.json"),
    path.join(fixture.layout.artifactsDir, fixture.attemptId, "artifact-manifest.json")
  ].sort();

  assert.equal(snapshot.graph_fingerprint.path, fixture.layout.graphFingerprintPath);
  assert.deepEqual(snapshot.graph_fingerprint.bytes, fs.readFileSync(fixture.layout.graphFingerprintPath));
  assert.deepEqual(
    snapshot.artifact_manifests.map((manifest) => manifest.path),
    expectedManifestPaths
  );
  for (const manifest of snapshot.artifact_manifests) {
    assert.deepEqual(manifest.bytes, fs.readFileSync(manifest.path));
  }
  assert.equal(new Set(snapshot.artifact_manifests.map((manifest) => manifest.path)).size, 2);
});

test("run-wide authority rejects a graph fingerprint outside the sealed state/control authority", () => {
  const fixture = createVerifiedReportFixture("verified-report-graph-fingerprint-injection");
  const injected = Buffer.from(`${"a".repeat(64)}\n`, "utf8");
  fs.writeFileSync(fixture.layout.graphFingerprintPath, injected);

  assert.throws(
    () => loadVerifiedRunOutputAuthoritySnapshot(fixture.layout.root),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_AUTHORITY_INVALID" &&
      /graph fingerprint.*sealed workflow control file authority/iu.test(error.message)
  );
  assert.deepEqual(fs.readFileSync(fixture.layout.graphFingerprintPath), injected);
});

test("post-finalization property fan-in remains readable through sealed fanout ancestor authority", () => {
  const outputRoot = temporaryRoot("ultrafuzz-verified-fanout-fanin-");
  const discoveryOutput = boundOutput("setup/invariant-evidence-ledger.json", "ultrafuzz/invariant-ledger@1", true);
  const discoveryMarkdownOutput = boundOutput("handoffs/discovery-evidence.md", "ultrafuzz/nonempty-markdown@1", false);
  const lensOutput = boundOutput("custom/recon-lens.json", "ultrafuzz/property-lens@2", true);
  const faninOutputs = [
    boundOutput("handoffs/canonical-properties.json", "ultrafuzz/properties@2", true),
    boundOutput("handoffs/canonical-properties.md", "ultrafuzz/nonempty-markdown@1", false)
  ];
  // Keep the sealed dependency declaration deliberately out of lexical order.
  // Artifact manifests canonicalize prerequisite rows lexically, so verified
  // readers must compare the same canonical representation.
  const lensAttemptIds = [
    "property-specification-recon__model_1__attempt_0",
    "property-specification-recon__model_0__attempt_0"
  ];
  const graph: PlannedGraphDocument = {
    schema_version: PLANNED_GRAPH_SCHEMA_VERSION,
    graph_version: "4",
    topology_version: 2,
    groups: {},
    nodes: [
      {
        id: "project-discovery",
        logical_id: "project-discovery",
        display_name: "Project discovery",
        kind: "agentic",
        depends_on: [],
        artifact_dir: "artifacts/project-discovery",
        outputs: [discoveryOutput, discoveryMarkdownOutput],
        prompt_id: "project-discovery",
        prompt_path: "setup/project-discovery.md",
        loop: { index: 0, count: 1, mode: "parallel", attempt_index: 0 },
        model_fanout: [],
        workflow: { node_id: "node:project-discovery", task_node_ids: ["node:project-discovery"] }
      },
      {
        id: "property-specification-recon",
        logical_id: "property-specification-recon",
        display_name: "Property specification recon",
        kind: "agentic",
        depends_on: ["project-discovery"],
        artifact_dir: "artifacts/property-specification-recon",
        outputs: [lensOutput],
        prompt_id: "property-specification-recon",
        prompt_path: "properties/recon.md",
        loop: { index: 0, count: 1, mode: "parallel", attempt_index: 0 },
        model_fanout: [
          {
            model_profile_id: "lens-b",
            agent_ref: "CodexAgent",
            model_name: "gpt-test-b",
            reasoning_effort: "high",
            model_index: 1,
            loop_index: 0,
            attempt_index: 0
          },
          {
            model_profile_id: "lens-a",
            agent_ref: "CodexAgent",
            model_name: "gpt-test-a",
            reasoning_effort: "high",
            model_index: 0,
            loop_index: 0,
            attempt_index: 0
          }
        ],
        workflow: {
          node_id: `node:${lensAttemptIds[0]}`,
          task_node_ids: lensAttemptIds.map((attemptId) => `node:${attemptId}`)
        }
      },
      {
        id: "property-specification-fanin",
        logical_id: "property-specification-fanin",
        display_name: "Property specification fan-in",
        kind: "agentic",
        depends_on: ["property-specification-recon"],
        artifact_dir: "artifacts/property-specification-fanin",
        outputs: faninOutputs,
        prompt_id: "property-specification-fanin",
        prompt_path: "properties/fanin.md",
        loop: { index: 0, count: 1, mode: "parallel", attempt_index: 0 },
        model_fanout: [],
        workflow: {
          node_id: "node:property-specification-fanin",
          task_node_ids: ["node:property-specification-fanin"]
        }
      }
    ]
  };
  const layout = createRunLayout({
    outputRoot,
    runId: "verified-fanout-fanin",
    graph,
    graphFingerprint: "f".repeat(64),
    configFingerprint: "e".repeat(64),
    stateNodes: [
      {
        id: "project-discovery",
        logicalNodeId: "project-discovery",
        artifactDir: "artifacts/project-discovery",
        outputs: [discoveryOutput, discoveryMarkdownOutput]
      },
      ...lensAttemptIds.map((attemptId) => ({
        id: attemptId,
        logicalNodeId: "property-specification-recon",
        artifactDir: `artifacts/${attemptId}`,
        outputs: [lensOutput]
      })),
      {
        id: "property-specification-fanin",
        logicalNodeId: "property-specification-fanin",
        artifactDir: "artifacts/property-specification-fanin",
        outputs: faninOutputs
      }
    ]
  });
  finalizeNodeOutputs(layout, graph.nodes[0]!, "project-discovery", {
    [discoveryOutput.path]: JSON.stringify({
      schema_version: "ultrafuzz.invariant-evidence-ledger.v1",
      entries: [
        {
          id: "evidence-1",
          source_path: "docs/overview.md",
          source_location: "line 1",
          kind: "invariant",
          verbatim: "Supply accounting remains consistent.",
          inventory_ids: ["inventory-1"]
        }
      ],
      inventory_rows: [
        { id: "inventory-1", description: "Supply accounting remains consistent.", ledger_ids: ["evidence-1"] }
      ],
      scan_probes: []
    }),
    [discoveryMarkdownOutput.path]: "# Discovery evidence\n"
  });
  const lensDocument = JSON.stringify({
    schema_version: "ultrafuzz.property-lens.v2",
    properties: [
      {
        id: "recon-1",
        description: "Supply accounting remains consistent.",
        category: "accounting",
        priority: "high"
      }
    ]
  });
  for (const attemptId of lensAttemptIds) {
    finalizeNodeOutputs(
      layout,
      graph.nodes[1]!,
      attemptId,
      { [lensOutput.path]: lensDocument },
      ["project-discovery"],
      Number(/__model_(\d+)__/u.exec(attemptId)?.[1])
    );
  }
  finalizeNodeOutputs(
    layout,
    graph.nodes[2]!,
    "property-specification-fanin",
    {
      "handoffs/canonical-properties.json": JSON.stringify({
        schema_version: "ultrafuzz.properties.v2",
        properties: [
          {
            id: "property-1",
            description: "Supply accounting remains consistent.",
            category: "accounting",
            priority: "high",
            sources: [{ source_node_id: "property-specification-recon", source_property_id: "recon-1" }],
            ledger_ids: ["evidence-1"]
          }
        ]
      }),
      "handoffs/canonical-properties.md": [
        '### Canonical property: "property-1"',
        'description: "Supply accounting remains consistent."',
        'category: "accounting"',
        'priority: "high"',
        'sources: [{"source_node_id":"property-specification-recon","source_property_id":"recon-1"}]',
        'ledger_ids: ["evidence-1"]',
        '### End canonical property: "property-1"'
      ].join("\n")
    },
    lensAttemptIds
  );
  const tasks = graph.nodes.flatMap((node) =>
    plannedAttemptIds(node).map((attemptId) => smithersTaskForNode(layout, graph, node, attemptId))
  );
  writeSealedTaskAuthority(layout, graph, tasks);

  const loaded = loadVerifiedNodeOutputSnapshot({
    runRoot: layout.root,
    logicalNodeId: "property-specification-fanin",
    attemptId: "property-specification-fanin"
  });

  assert.equal(loaded.attempt_id, "property-specification-fanin");
  assert.deepEqual(
    loaded.outputs.map((output) => output.path),
    faninOutputs.map((output) => output.path)
  );

  const faninManifestPath = path.join(layout.artifactsDir, "property-specification-fanin", "artifact-manifest.json");
  const originalManifest = readManifest(faninManifestPath);
  const originalManifestBytes = fs.readFileSync(faninManifestPath);
  assert.deepEqual(
    originalManifest.prerequisite_manifests.map((entry) => entry.node_id),
    [...lensAttemptIds].sort((left, right) => left.localeCompare(right))
  );
  const alternateAttemptId = "property-specification-recon__model_2__attempt_0";
  writeFileDurable(path.join(layout.artifactsDir, alternateAttemptId, lensOutput.path), lensDocument);
  writeArtifactManifest({
    layout,
    nodeId: alternateAttemptId,
    include: [lensOutput.path],
    outputs: [lensOutput],
    prerequisiteNodeIds: ["project-discovery"],
    provenance: {
      producer_node_id: alternateAttemptId,
      logical_node_id: "property-specification-recon",
      attempt_index: 0,
      loop_index: 0,
      model_index: 2,
      agent_ref: "CodexAgent",
      workflow_run_id: WORKFLOW_RUN_ID,
      workflow_task_id: `node:${alternateAttemptId}`,
      origin: "workflow",
      metadata: { concrete_node_id: "property-specification-recon" }
    }
  });
  const alternateManifestBytes = fs.readFileSync(
    path.join(layout.artifactsDir, alternateAttemptId, "artifact-manifest.json")
  );
  const alternatePrerequisite = { node_id: alternateAttemptId, sha256: digest(alternateManifestBytes) };
  const prerequisiteVariants = [
    {
      label: "missing",
      prerequisites: originalManifest.prerequisite_manifests.slice(0, 1)
    },
    {
      label: "extra",
      prerequisites: [...originalManifest.prerequisite_manifests, alternatePrerequisite]
    },
    {
      label: "substituted",
      prerequisites: [alternatePrerequisite, originalManifest.prerequisite_manifests[1]!]
    },
    {
      label: "reordered",
      prerequisites: [...originalManifest.prerequisite_manifests].reverse()
    }
  ] as const;
  for (const variant of prerequisiteVariants) {
    const mutatedManifest = {
      ...structuredClone(originalManifest),
      prerequisite_manifests: [...variant.prerequisites]
    };
    writeJsonDurable(faninManifestPath, mutatedManifest);
    const mutatedBytes = fs.readFileSync(faninManifestPath);
    sealFinalReportManifest(layout, "property-specification-fanin", digest(mutatedBytes));

    assert.throws(
      () =>
        loadVerifiedNodeOutputSnapshot({
          runRoot: layout.root,
          logicalNodeId: "property-specification-fanin",
          attemptId: "property-specification-fanin"
        }),
      (error: unknown) =>
        error instanceof VerifiedOutputError &&
        error.code === "VERIFIED_OUTPUT_AUTHORITY_INVALID" &&
        /prerequisite attempt IDs do not match the verifier-persisted admission/iu.test(error.message),
      `${variant.label} fanout prerequisite attempt must fail closed`
    );
    assert.deepEqual(fs.readFileSync(faninManifestPath), mutatedBytes);
  }
  fs.writeFileSync(faninManifestPath, originalManifestBytes);
  sealFinalReportManifest(layout, "property-specification-fanin", digest(originalManifestBytes));
  assert.equal(
    loadVerifiedNodeOutputSnapshot({
      runRoot: layout.root,
      logicalNodeId: "property-specification-fanin",
      attemptId: "property-specification-fanin"
    }).attempt_id,
    "property-specification-fanin"
  );
});

test("post-verification report mutation is rejected even when the physical JSON remains shape-valid", () => {
  const fixture = createVerifiedReportFixture("verified-report-mutated");
  const mutated = Buffer.concat([fixture.reportBytes, Buffer.from(" \n", "utf8")]);
  fs.writeFileSync(fixture.reportPath, mutated);

  assert.throws(
    () => loadVerifiedFinalReportSnapshot(fixture.layout.root),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_CHANGED" &&
      /digest\/size binding changed/u.test(error.message)
  );
  assert.deepEqual(fs.readFileSync(fixture.reportPath), mutated);
  assert.deepEqual(fs.readFileSync(fixture.markdownPath), fixture.markdownBytes);
});

test("a resealed controller manifest cannot authenticate an unpublished sidecar", () => {
  const fixture = createVerifiedReportFixture("verified-report-unpublished-sidecar");
  const manifestPath = path.join(fixture.layout.artifactsDir, fixture.attemptId, "artifact-manifest.json");
  const sidecarPath = path.join(fixture.layout.artifactsDir, fixture.attemptId, "unverified-sidecar.json");
  const sidecarBytes = Buffer.from('{"unverified":true}\n', "utf8");
  writeFileDurable(sidecarPath, sidecarBytes);
  const manifest = readManifest(manifestPath);
  manifest.files.push({
    path: "unverified-sidecar.json",
    size_bytes: sidecarBytes.byteLength,
    sha256: digest(sidecarBytes),
    provenance: manifest.provenance
  });
  manifest.files.sort((left, right) => left.path.localeCompare(right.path));
  writeJsonDurable(manifestPath, manifest);
  const manifestBytes = fs.readFileSync(manifestPath);
  sealFinalReportManifest(fixture.layout, fixture.attemptId, digest(manifestBytes));

  assert.throws(
    () => loadVerifiedFinalReportSnapshot(fixture.layout.root),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_AUTHORITY_INVALID" &&
      /file set does not match the exact verifier publications/iu.test(error.message)
  );
  assert.deepEqual(fs.readFileSync(manifestPath), manifestBytes);
  assert.deepEqual(fs.readFileSync(sidecarPath), sidecarBytes);
});

test("post-finalization reads reject task-manifest bytes that no longer match the workflow-control seal", () => {
  const fixture = createVerifiedReportFixture("verified-report-task-authority-mutated");
  fs.appendFileSync(path.join(fixture.layout.root, "smithers", "tasks.json"), " \n");

  assert.throws(
    () => loadVerifiedFinalReportSnapshot(fixture.layout.root),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_AUTHORITY_INVALID" &&
      /sealed Smithers task authority/iu.test(error.message)
  );
});

test("shape-valid severity drift is rejected by current semantic gates despite matching authority digests", () => {
  const validReport = currentReport("verified-report-semantic-invalid", [currentIssue()]);
  const validProjection = projectCanonicalFinalReport(validReport);
  const invalidReport = structuredClone(validReport);
  (invalidReport.issues as Array<Record<string, unknown>>)[0]!.severity = "High";
  const fixture = createVerifiedReportFixture("verified-report-semantic-invalid", {
    report: invalidReport,
    markdown: validProjection.markdown
  });
  const reportBefore = fs.readFileSync(fixture.reportPath);
  const markdownBefore = fs.readFileSync(fixture.markdownPath);

  assert.throws(
    () => loadVerifiedFinalReportSnapshot(fixture.layout.root),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_INVALID" &&
      /semantic\/context gates.*severity/iu.test(error.message)
  );
  assert.deepEqual(fs.readFileSync(fixture.reportPath), reportBefore);
  assert.deepEqual(fs.readFileSync(fixture.markdownPath), markdownBefore);
});

test("missing verification evidence after successful finalization is invalid authority, not unavailable authority", () => {
  const fixture = createVerifiedReportFixture("verified-report-missing-marker");
  fs.rmSync(path.join(fixture.layout.root, ".ultrafuzz-verification", `${REPORT_ATTEMPT_ID}.json`));

  assert.throws(
    () => loadVerifiedFinalReportSnapshot(fixture.layout.root),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_AUTHORITY_INVALID" &&
      /incomplete or unreadable/iu.test(error.message)
  );
});

test("a report producer that claims success without controller finalization authority is invalid", () => {
  const fixture = createVerifiedReportFixture("verified-report-success-without-finalization-authority");
  updateNodeState(fixture.layout, fixture.attemptId, { provenance: undefined });

  assert.throws(
    () => loadVerifiedFinalReportSnapshot(fixture.layout.root),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_AUTHORITY_INVALID" &&
      /claims succeeded without complete current verification\/finalization authority/iu.test(error.message)
  );
});

test("a genuinely pending report producer remains unavailable rather than invalid", () => {
  const fixture = createVerifiedReportFixture("verified-report-pending-authority");
  updateNodeState(fixture.layout, fixture.attemptId, {
    status: "pending",
    finished_at: undefined,
    provenance: undefined
  });

  assert.throws(
    () => loadVerifiedFinalReportSnapshot(fixture.layout.root),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_AUTHORITY_UNAVAILABLE" &&
      /no successful current verification\/finalization authority/iu.test(error.message)
  );
});

test("controller manifest seal rejects removal of a planned prerequisite row without repairing authority", () => {
  const fixture = createVerifiedReportFixture("verified-report-prerequisite-removed", { withPrerequisite: true });
  const manifestPath = path.join(fixture.layout.artifactsDir, fixture.attemptId, "artifact-manifest.json");
  const manifest = readManifest(manifestPath);
  assert.equal(manifest.prerequisite_manifests.length, 1);
  manifest.prerequisite_manifests = [];
  writeJsonDurable(manifestPath, manifest);
  const removedBytes = fs.readFileSync(manifestPath);

  assert.throws(
    () => loadVerifiedFinalReportSnapshot(fixture.layout.root),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_AUTHORITY_INVALID" &&
      /manifest does not match controller finalization authority/iu.test(error.message)
  );
  assert.deepEqual(fs.readFileSync(manifestPath), removedBytes);
});

test("controller manifest seal rejects a prerequisite digest rewrite even when the rewritten digest is current", () => {
  const fixture = createVerifiedReportFixture("verified-report-prerequisite-rewritten", { withPrerequisite: true });
  const manifestPath = path.join(fixture.layout.artifactsDir, fixture.attemptId, "artifact-manifest.json");
  const prerequisitePath = path.join(fixture.layout.artifactsDir, "producer", "artifact-manifest.json");
  const prerequisite = readManifest(prerequisitePath);
  prerequisite.created_at = "2030-01-01T00:00:00.000Z";
  writeJsonDurable(prerequisitePath, prerequisite);
  const rewrittenPrerequisiteBytes = fs.readFileSync(prerequisitePath);

  const manifest = readManifest(manifestPath);
  assert.equal(manifest.prerequisite_manifests.length, 1);
  manifest.prerequisite_manifests[0]!.sha256 = digest(rewrittenPrerequisiteBytes);
  writeJsonDurable(manifestPath, manifest);
  const rewrittenManifestBytes = fs.readFileSync(manifestPath);

  assert.throws(
    () => loadVerifiedFinalReportSnapshot(fixture.layout.root),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_AUTHORITY_INVALID" &&
      /manifest does not match controller finalization authority/iu.test(error.message)
  );
  assert.deepEqual(fs.readFileSync(manifestPath), rewrittenManifestBytes);
  assert.deepEqual(fs.readFileSync(prerequisitePath), rewrittenPrerequisiteBytes);
});

test("sealed manifest prerequisites must exactly cover the current sealed direct dependency attempts", () => {
  const fixture = createVerifiedReportFixture("verified-report-prerequisite-coverage", { withPrerequisite: true });
  const manifestPath = path.join(fixture.layout.artifactsDir, fixture.attemptId, "artifact-manifest.json");
  const manifest = readManifest(manifestPath);
  manifest.prerequisite_manifests = [];
  writeJsonDurable(manifestPath, manifest);
  const manifestBytes = fs.readFileSync(manifestPath);
  sealFinalReportManifest(fixture.layout, fixture.attemptId, digest(manifestBytes));

  assert.throws(
    () => loadVerifiedFinalReportSnapshot(fixture.layout.root),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_AUTHORITY_INVALID" &&
      /prerequisite attempt IDs do not match the verifier-persisted admission/iu.test(error.message)
  );
  assert.deepEqual(fs.readFileSync(manifestPath), manifestBytes);
});

test("sealed manifest prerequisites may omit a markerless optional direct dependency", () => {
  const fixture = createVerifiedReportFixture("verified-report-markerless-optional-prerequisite", {
    withPrerequisite: true,
    optionalPrerequisite: true
  });

  const loaded = loadVerifiedNodeOutputSnapshot({
    runRoot: fixture.layout.root,
    logicalNodeId: REPORT_LOGICAL_ID,
    attemptId: fixture.attemptId
  });

  assert.equal(loaded.attempt_id, fixture.attemptId);
  assert.deepEqual(
    readManifest(path.join(fixture.layout.artifactsDir, fixture.attemptId, "artifact-manifest.json"))
      .prerequisite_manifests,
    []
  );
});

test("legacy controller manifests without a marker digest fail closed for optional dependency closures", () => {
  const fixture = createVerifiedReportFixture("verified-report-optional-missing-marker-digest", {
    withPrerequisite: true,
    optionalPrerequisite: true
  });
  const manifestPath = path.join(fixture.layout.artifactsDir, fixture.attemptId, "artifact-manifest.json");
  const manifest = readManifest(manifestPath);
  delete manifest.provenance.verification_marker_sha256;
  for (const entry of manifest.files) delete entry.provenance.verification_marker_sha256;
  writeJsonDurable(manifestPath, manifest);
  const manifestBytes = fs.readFileSync(manifestPath);
  sealFinalReportManifest(fixture.layout, fixture.attemptId, digest(manifestBytes));

  assert.throws(
    () =>
      loadVerifiedNodeOutputSnapshot({
        runRoot: fixture.layout.root,
        logicalNodeId: REPORT_LOGICAL_ID,
        attemptId: fixture.attemptId
      }),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_AUTHORITY_INVALID" &&
      /manifest does not authenticate optional dependency admission/iu.test(error.message)
  );
});

test("persisted omitted admission survives a later successful optional-only retry", () => {
  const fixture = createVerifiedReportFixture("verified-report-optional-retry-after-consumer", {
    withPrerequisite: true,
    optionalPrerequisite: true
  });
  finalizeFixtureProducer(fixture.layout);

  const loaded = loadVerifiedNodeOutputSnapshot({
    runRoot: fixture.layout.root,
    logicalNodeId: REPORT_LOGICAL_ID,
    attemptId: fixture.attemptId
  });

  assert.equal(loaded.attempt_id, fixture.attemptId);
  assert.deepEqual(
    readManifest(path.join(fixture.layout.artifactsDir, fixture.attemptId, "artifact-manifest.json"))
      .prerequisite_manifests,
    []
  );
});

test("persisted admitted prerequisite remains causal after its optional marker disappears", () => {
  const fixture = createVerifiedReportFixture("verified-report-admitted-optional-marker-removed", {
    withPrerequisite: true,
    optionalPrerequisite: true,
    admitOptionalPrerequisite: true
  });
  finalizeFixtureProducer(fixture.layout);
  fs.rmSync(path.join(fixture.layout.root, ".ultrafuzz-verification", "producer.json"));

  const loaded = loadVerifiedNodeOutputSnapshot({
    runRoot: fixture.layout.root,
    logicalNodeId: REPORT_LOGICAL_ID,
    attemptId: fixture.attemptId
  });

  assert.equal(loaded.attempt_id, fixture.attemptId);
  assert.deepEqual(
    readManifest(
      path.join(fixture.layout.artifactsDir, fixture.attemptId, "artifact-manifest.json")
    ).prerequisite_manifests.map((entry) => entry.node_id),
    ["producer"]
  );
});

test("controller manifest prerequisites must equal the verifier-persisted direct admission", () => {
  const fixture = createVerifiedReportFixture("verified-report-optional-forged-prerequisite", {
    withPrerequisite: true,
    optionalPrerequisite: true
  });
  const producerManifestBytes = fs.readFileSync(
    path.join(fixture.layout.artifactsDir, "producer", "artifact-manifest.json")
  );
  const manifestPath = path.join(fixture.layout.artifactsDir, fixture.attemptId, "artifact-manifest.json");
  const manifest = readManifest(manifestPath);
  manifest.prerequisite_manifests = [{ node_id: "producer", sha256: digest(producerManifestBytes) }];
  writeJsonDurable(manifestPath, manifest);
  const manifestBytes = fs.readFileSync(manifestPath);
  sealFinalReportManifest(fixture.layout, fixture.attemptId, digest(manifestBytes));

  assert.throws(
    () =>
      loadVerifiedNodeOutputSnapshot({
        runRoot: fixture.layout.root,
        logicalNodeId: REPORT_LOGICAL_ID,
        attemptId: fixture.attemptId
      }),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_AUTHORITY_INVALID" &&
      /prerequisite attempt IDs do not match the verifier-persisted admission/iu.test(error.message)
  );
});

test("controller manifest authenticates a marker replacement that changes only indirect optional admission", () => {
  const fixture = createVerifiedReportFixture("verified-report-indirect-optional-marker-replaced", {
    indirectOptionalPrerequisite: true
  });
  const manifestPath = path.join(fixture.layout.artifactsDir, fixture.attemptId, "artifact-manifest.json");
  const markerPath = path.join(fixture.layout.root, ".ultrafuzz-verification", `${fixture.attemptId}.json`);
  const manifestBefore = readManifest(manifestPath);
  assert.deepEqual(
    manifestBefore.prerequisite_manifests.map((entry) => entry.node_id),
    ["bridge"],
    "the direct prerequisite set is independent of the indirect optional admission"
  );
  const replacement = JSON.parse(fs.readFileSync(markerPath, "utf8")) as ArtifactVerificationMarker;
  assert.deepEqual(replacement.admitted_dependency_attempt_ids, ["bridge"]);
  replacement.admitted_dependency_attempt_ids = ["producer", "bridge"];
  writeJsonDurable(markerPath, replacement);
  const replacementBytes = fs.readFileSync(markerPath);

  assert.throws(
    () =>
      loadVerifiedNodeOutputSnapshot({
        runRoot: fixture.layout.root,
        logicalNodeId: REPORT_LOGICAL_ID,
        attemptId: fixture.attemptId
      }),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_AUTHORITY_INVALID" &&
      /verification marker does not match controller manifest authority/iu.test(error.message)
  );
  assert.deepEqual(
    readManifest(manifestPath).prerequisite_manifests.map((entry) => entry.node_id),
    ["bridge"]
  );
  assert.deepEqual(fs.readFileSync(markerPath), replacementBytes);
});

for (const markerAuthority of ["malformed leaf", "dangling leaf"] as const) {
  test(`persisted omitted admission ignores an optional marker that later becomes a ${markerAuthority}`, () => {
    const fixture = createVerifiedReportFixture(`verified-report-optional-${markerAuthority.replaceAll(" ", "-")}`, {
      withPrerequisite: true,
      optionalPrerequisite: true
    });
    const markerRoot = path.join(fixture.layout.root, ".ultrafuzz-verification");
    const producerMarker = path.join(markerRoot, "producer.json");
    if (markerAuthority === "malformed leaf") {
      writeJsonDurable(producerMarker, {});
    } else if (markerAuthority === "dangling leaf") {
      fs.symlinkSync("missing-producer-marker.json", producerMarker);
    }

    const loaded = loadVerifiedNodeOutputSnapshot({
      runRoot: fixture.layout.root,
      logicalNodeId: REPORT_LOGICAL_ID,
      attemptId: fixture.attemptId
    });
    assert.equal(loaded.attempt_id, fixture.attemptId);
    assert.deepEqual(
      readManifest(path.join(fixture.layout.artifactsDir, fixture.attemptId, "artifact-manifest.json"))
        .prerequisite_manifests,
      []
    );
  });
}

test("verified output still rejects an unsafe marker authority root", () => {
  const fixture = createVerifiedReportFixture("verified-report-optional-symlinked-root", {
    withPrerequisite: true,
    optionalPrerequisite: true
  });
  const markerRoot = path.join(fixture.layout.root, ".ultrafuzz-verification");
  const realMarkerRoot = path.join(fixture.layout.root, "verification-authority-real");
  fs.renameSync(markerRoot, realMarkerRoot);
  fs.symlinkSync(realMarkerRoot, markerRoot, "dir");

  assert.throws(
    () =>
      loadVerifiedNodeOutputSnapshot({
        runRoot: fixture.layout.root,
        logicalNodeId: REPORT_LOGICAL_ID,
        attemptId: fixture.attemptId
      }),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_AUTHORITY_INVALID" &&
      /artifact verification marker root is unsafe/iu.test(error.message)
  );
});

test("verified final-report selection rejects absent and ambiguous declared report producers", () => {
  const markdownOnly = finalReportOutputs().filter((output) => output.contract === "ultrafuzz/nonempty-markdown@1");
  const absent = createSelectionLayout("verified-report-producer-absent", [
    reportGraphNode("release-notes", markdownOnly)
  ]);
  assert.throws(
    () => loadVerifiedFinalReportSnapshot(absent.root),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_AUTHORITY_UNAVAILABLE" &&
      /no current planned node declares/iu.test(error.message)
  );

  const ambiguous = createSelectionLayout("verified-report-producer-ambiguous", [
    reportGraphNode("release-summary-a", finalReportOutputs()),
    reportGraphNode("release-summary-b", finalReportOutputs())
  ]);
  assert.throws(
    () => loadVerifiedFinalReportSnapshot(ambiguous.root),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_AUTHORITY_INVALID" &&
      /producer is ambiguous/iu.test(error.message)
  );
});

test("verified final-report selection rejects missing or ambiguous report output contracts", () => {
  const report = finalReportOutputs().find((output) => output.contract === "ultrafuzz/report@3")!;
  const missingMarkdown = createVerifiedReportFixture("verified-report-markdown-missing", {
    outputs: [{ ...report, primary: true }]
  });
  assert.throws(
    () => loadVerifiedFinalReportSnapshot(missingMarkdown.layout.root),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_INVALID" &&
      /PROPERTY_REPORT_MARKDOWN_DECLARATION_AMBIGUOUS/iu.test(error.message)
  );

  const ambiguousReport = createVerifiedReportFixture("verified-report-contract-ambiguous", {
    outputs: [
      { ...report, path: "deliverables/audit-a.json" },
      { ...report, path: "deliverables/audit-b.json" },
      finalReportOutputs().find((output) => output.contract === "ultrafuzz/nonempty-markdown@1")!
    ]
  });
  assert.throws(
    () => loadVerifiedFinalReportSnapshot(ambiguousReport.layout.root),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_INVALID" &&
      /PROPERTY_REPORT_DECLARATION_AMBIGUOUS/iu.test(error.message)
  );
});

function reportGraphNode(id: string, outputs: ArtifactManifestOutputContract[]): PlannedGraphDocument["nodes"][number] {
  return {
    id,
    logical_id: id,
    display_name: id,
    kind: "agentic",
    depends_on: [],
    artifact_dir: `artifacts/${id}`,
    outputs,
    prompt_id: id,
    prompt_path: `review/${id}.md`,
    loop: { index: 0, count: 1, mode: "parallel", attempt_index: 0 },
    model_fanout: []
  };
}

function createSelectionLayout(runId: string, nodes: PlannedGraphDocument["nodes"]): RunLayout {
  const outputRoot = temporaryRoot("ultrafuzz-verified-output-selection-");
  const graph: PlannedGraphDocument = {
    schema_version: PLANNED_GRAPH_SCHEMA_VERSION,
    graph_version: "4",
    topology_version: 2,
    groups: {},
    nodes
  };
  return createRunLayout({
    outputRoot,
    runId,
    graph,
    graphFingerprint: "f".repeat(64),
    configFingerprint: "e".repeat(64),
    stateNodes: nodes.map((node) => ({
      id: node.id,
      logicalNodeId: node.logical_id,
      artifactDir: node.artifact_dir,
      outputs: node.outputs
    }))
  });
}

test("verified campaign reader requires every declared evidence file in verifier publications", () => {
  const fixture = createVerifiedCampaignFixture("verified-campaign-missing-publication", {
    omitEvidencePublication: true
  });

  assert.throws(
    () =>
      loadVerifiedNodeOutputSnapshot({
        runRoot: fixture.layout.root,
        logicalNodeId: "stateful-invariant-campaign"
      }),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_AUTHORITY_INVALID" &&
      /does not publish campaign evidence/iu.test(error.message)
  );
});

test("verified campaign reader rejects post-finalization evidence mutation without repair", () => {
  const fixture = createVerifiedCampaignFixture("verified-campaign-mutated-evidence");
  const loaded = loadVerifiedNodeOutputSnapshot({
    runRoot: fixture.layout.root,
    logicalNodeId: "stateful-invariant-campaign"
  });
  assert.equal(
    loaded.outputs.some((output) => output.contract === "ultrafuzz/property-campaign@3"),
    true
  );
  const evidencePublication = loaded.publications.find(
    (publication) => publication.absolute_path === fixture.evidencePath
  );
  assert.ok(evidencePublication);
  assert.deepEqual(evidencePublication.bytes, fixture.evidenceBytes);

  const mutated = Buffer.alloc(fixture.evidenceBytes.length, 0x7a);
  fs.writeFileSync(fixture.evidencePath, mutated);

  assert.throws(
    () =>
      loadVerifiedNodeOutputSnapshot({
        runRoot: fixture.layout.root,
        logicalNodeId: "stateful-invariant-campaign"
      }),
    (error: unknown) =>
      error instanceof VerifiedOutputError &&
      error.code === "VERIFIED_OUTPUT_CHANGED" &&
      /digest\/size binding changed/iu.test(error.message)
  );
  assert.deepEqual(fs.readFileSync(fixture.evidencePath), mutated);
});

function createVerifiedReportFixture(
  runId: string,
  override: {
    report?: Record<string, unknown>;
    markdown?: string;
    outputs?: ArtifactManifestOutputContract[];
    attemptId?: string;
    modelFanout?: PlannedGraphNodeDocument["model_fanout"];
    withPrerequisite?: boolean;
    optionalPrerequisite?: boolean;
    admitOptionalPrerequisite?: boolean;
    indirectOptionalPrerequisite?: boolean;
  } = {}
): ReportFixture {
  const outputRoot = temporaryRoot("ultrafuzz-verified-output-");
  const outputs = override.outputs ?? finalReportOutputs();
  const prerequisiteOutputs = producerOutputs();
  const attemptId = override.attemptId ?? REPORT_ATTEMPT_ID;
  const withPrerequisite = override.withPrerequisite === true || override.indirectOptionalPrerequisite === true;
  const optionalPrerequisite = override.optionalPrerequisite === true || override.indirectOptionalPrerequisite === true;
  const rootPrerequisiteAttemptId = override.indirectOptionalPrerequisite === true ? "bridge" : "producer";
  const modelFanout = override.modelFanout ?? [];
  const reportAttemptIds =
    modelFanout.length <= 1
      ? [REPORT_ATTEMPT_ID]
      : modelFanout.map((model) => `${REPORT_ATTEMPT_ID}__model_${model.model_index}__attempt_${model.attempt_index}`);
  const graph: PlannedGraphDocument = {
    schema_version: PLANNED_GRAPH_SCHEMA_VERSION,
    graph_version: "4",
    topology_version: 2,
    groups: optionalPrerequisite ? { specialists: { defaults: { failure_policy: "continue" } } } : {},
    nodes: [
      ...(withPrerequisite
        ? [
            {
              id: "producer",
              logical_id: "producer",
              display_name: "Producer",
              kind: "agentic" as const,
              ...(optionalPrerequisite ? { group: "specialists" } : {}),
              depends_on: [],
              artifact_dir: "artifacts/producer",
              outputs: prerequisiteOutputs,
              prompt_id: "producer",
              prompt_path: "review/producer.md",
              loop: { index: 0, count: 1, mode: "parallel" as const, attempt_index: 0 },
              model_fanout: [],
              workflow: { node_id: "node:producer", task_node_ids: ["node:producer"] }
            }
          ]
        : []),
      ...(override.indirectOptionalPrerequisite === true
        ? [
            {
              id: "bridge",
              logical_id: "bridge",
              display_name: "Bridge",
              kind: "agentic" as const,
              depends_on: ["producer"],
              artifact_dir: "artifacts/bridge",
              outputs: prerequisiteOutputs,
              prompt_id: "bridge",
              prompt_path: "review/bridge.md",
              loop: { index: 0, count: 1, mode: "parallel" as const, attempt_index: 0 },
              model_fanout: [],
              workflow: { node_id: "node:bridge", task_node_ids: ["node:bridge"] }
            }
          ]
        : []),
      {
        id: REPORT_ATTEMPT_ID,
        logical_id: REPORT_LOGICAL_ID,
        display_name: "Final report",
        kind: "agentic",
        depends_on: withPrerequisite ? [rootPrerequisiteAttemptId] : [],
        artifact_dir: `artifacts/${REPORT_ATTEMPT_ID}`,
        outputs,
        prompt_id: REPORT_LOGICAL_ID,
        prompt_path: "review/final-report.md",
        loop: { index: 0, count: 1, mode: "parallel", attempt_index: 0 },
        model_fanout: modelFanout,
        workflow: {
          node_id: `node:${reportAttemptIds[0]!}`,
          task_node_ids: reportAttemptIds.map((plannedAttemptId) => `node:${plannedAttemptId}`)
        }
      }
    ]
  };
  const layout = createRunLayout({
    outputRoot,
    runId,
    graph,
    graphFingerprint: "f".repeat(64),
    configFingerprint: "e".repeat(64),
    stateNodes: [
      ...(withPrerequisite
        ? [
            {
              id: "producer",
              logicalNodeId: "producer",
              artifactDir: "artifacts/producer",
              outputs: prerequisiteOutputs
            }
          ]
        : []),
      ...(override.indirectOptionalPrerequisite === true
        ? [
            {
              id: "bridge",
              logicalNodeId: "bridge",
              artifactDir: "artifacts/bridge",
              outputs: prerequisiteOutputs
            }
          ]
        : []),
      {
        id: attemptId,
        logicalNodeId: REPORT_LOGICAL_ID,
        artifactDir: `artifacts/${attemptId}`,
        outputs
      }
    ]
  });
  const report = override.report ?? currentReport(runId);
  const projection = override.markdown === undefined ? projectCanonicalFinalReport(report) : undefined;
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  const markdownBytes = Buffer.from(override.markdown ?? projection!.markdown, "utf8");
  const reportPath = path.join(
    layout.artifactsDir,
    attemptId,
    outputs.find((output) => output.contract === "ultrafuzz/report@3")?.path ?? REPORT_JSON_PATH
  );
  const markdownPath = path.join(
    layout.artifactsDir,
    attemptId,
    outputs.find((output) => output.contract === "ultrafuzz/nonempty-markdown@1")?.path ?? REPORT_MARKDOWN_PATH
  );
  for (const output of outputs) {
    writeFileDurable(
      path.join(layout.artifactsDir, attemptId, output.path),
      output.contract === "ultrafuzz/report@3" ? reportBytes : markdownBytes
    );
  }

  if (withPrerequisite) {
    writeFileDurable(path.join(layout.artifactsDir, "producer", "context.md"), "# Producer context\n");
    writeArtifactManifest({
      layout,
      nodeId: "producer",
      include: ["context.md"],
      outputs: prerequisiteOutputs,
      provenance: {
        producer_node_id: "producer",
        logical_node_id: "producer",
        attempt_index: 0,
        loop_index: 0,
        model_index: 0,
        agent_ref: "Codex",
        workflow_run_id: WORKFLOW_RUN_ID,
        workflow_task_id: "node:producer",
        origin: "workflow",
        metadata: { concrete_node_id: "producer" }
      }
    });
  }

  if (override.indirectOptionalPrerequisite === true) {
    writeFileDurable(path.join(layout.artifactsDir, "bridge", "context.md"), "# Bridge context\n");
    writeArtifactManifest({
      layout,
      nodeId: "bridge",
      include: ["context.md"],
      outputs: prerequisiteOutputs,
      provenance: {
        producer_node_id: "bridge",
        logical_node_id: "bridge",
        attempt_index: 0,
        loop_index: 0,
        model_index: 0,
        agent_ref: "Codex",
        workflow_run_id: WORKFLOW_RUN_ID,
        workflow_task_id: "node:bridge",
        origin: "workflow",
        metadata: { concrete_node_id: "bridge" }
      }
    });
  }

  const marker: ArtifactVerificationMarker = {
    schema_version: ARTIFACT_VERIFICATION_SCHEMA_VERSION,
    attempt_id: attemptId,
    node_id: REPORT_LOGICAL_ID,
    admitted_dependency_attempt_ids:
      withPrerequisite && (!optionalPrerequisite || override.admitOptionalPrerequisite === true)
        ? override.indirectOptionalPrerequisite === true
          ? ["producer", "bridge"]
          : ["producer"]
        : override.indirectOptionalPrerequisite === true
          ? ["bridge"]
          : [],
    artifacts: outputs.map((output) => ({
      ...output,
      sha256: digest(output.contract === "ultrafuzz/report@3" ? reportBytes : markdownBytes)
    })),
    publications: outputs.map((output) => ({
      path: output.path,
      sha256: digest(output.contract === "ultrafuzz/report@3" ? reportBytes : markdownBytes)
    }))
  };
  const markerPath = path.join(layout.root, ".ultrafuzz-verification", `${attemptId}.json`);
  writeJsonDurable(markerPath, marker);
  const markerBytes = fs.readFileSync(markerPath);

  writeArtifactManifest({
    layout,
    nodeId: attemptId,
    include: outputs.map((output) => output.path),
    outputs,
    prerequisiteNodeIds:
      override.indirectOptionalPrerequisite === true
        ? ["bridge"]
        : withPrerequisite && (!optionalPrerequisite || override.admitOptionalPrerequisite === true)
          ? [rootPrerequisiteAttemptId]
          : [],
    provenance: {
      producer_node_id: attemptId,
      logical_node_id: REPORT_LOGICAL_ID,
      attempt_index: 0,
      loop_index: 0,
      model_index: 0,
      agent_ref: "Codex",
      workflow_run_id: WORKFLOW_RUN_ID,
      workflow_task_id: `node:${attemptId}`,
      ...(optionalPrerequisite ? { verification_marker_sha256: digest(markerBytes) } : {}),
      origin: "workflow",
      metadata: { concrete_node_id: REPORT_ATTEMPT_ID }
    }
  });
  updateNodeState(layout, attemptId, {
    status: "succeeded",
    finished_at: new Date().toISOString(),
    wait_since: undefined,
    wait_reason: undefined,
    next_eligible_action: undefined,
    provenance: {
      workflow: {
        run_id: WORKFLOW_RUN_ID,
        task_id: `verify:${attemptId}`,
        agent_task_id: `node:${attemptId}`,
        verifier_task_id: `verify:${attemptId}`,
        state: "finished",
        attempt: 0
      },
      output_contracts: {
        ok: true,
        missing: [],
        artifact_manifest_sha256: digest(
          fs.readFileSync(path.join(layout.artifactsDir, attemptId, "artifact-manifest.json"))
        )
      }
    }
  });
  const tasks = graph.nodes.flatMap((node) =>
    plannedAttemptIds(node).map((plannedAttemptId) => smithersTaskForNode(layout, graph, node, plannedAttemptId))
  );
  writeSealedTaskAuthority(layout, graph, tasks);
  return { layout, attemptId, reportPath, markdownPath, reportBytes, markdownBytes };
}

function finalizeFixtureProducer(layout: RunLayout): void {
  const outputs = producerOutputs();
  const bytes = fs.readFileSync(path.join(layout.artifactsDir, "producer", "context.md"));
  const marker: ArtifactVerificationMarker = {
    schema_version: ARTIFACT_VERIFICATION_SCHEMA_VERSION,
    attempt_id: "producer",
    node_id: "producer",
    admitted_dependency_attempt_ids: [],
    artifacts: outputs.map((output) => ({ ...output, sha256: digest(bytes) })),
    publications: outputs.map((output) => ({ path: output.path, sha256: digest(bytes) }))
  };
  writeJsonDurable(path.join(layout.root, ".ultrafuzz-verification", "producer.json"), marker);
  updateNodeState(layout, "producer", {
    status: "succeeded",
    finished_at: new Date().toISOString(),
    wait_since: undefined,
    wait_reason: undefined,
    next_eligible_action: undefined,
    provenance: {
      workflow: {
        run_id: WORKFLOW_RUN_ID,
        task_id: "verify:producer",
        agent_task_id: "node:producer",
        verifier_task_id: "verify:producer",
        state: "finished",
        attempt: 1
      },
      output_contracts: {
        ok: true,
        missing: [],
        artifact_manifest_sha256: digest(
          fs.readFileSync(path.join(layout.artifactsDir, "producer", "artifact-manifest.json"))
        )
      }
    }
  });
}

function boundOutput(
  artifactPath: string,
  contract: ArtifactManifestOutputContract["contract"],
  primary: boolean
): ArtifactManifestOutputContract {
  return {
    path: artifactPath,
    contract,
    contract_digest: artifactContractDefinition(contract).digest,
    ...(artifactContractSchemaBinding(contract) ?? {}),
    primary
  };
}

function finalizeNodeOutputs(
  layout: RunLayout,
  node: PlannedGraphNodeDocument,
  attemptId: string,
  contents: Readonly<Record<string, string>>,
  prerequisiteAttemptIds: readonly string[] = [],
  modelIndex = 0,
  additionalPublications: Readonly<Record<string, Buffer | string>> = {}
): void {
  const bytesByPath = new Map<string, Buffer>();
  for (const output of node.outputs) {
    const value = contents[output.path];
    if (value === undefined) throw new Error(`missing fixture output ${output.path}`);
    const bytes = Buffer.from(value, "utf8");
    bytesByPath.set(output.path, bytes);
    writeFileDurable(path.join(layout.artifactsDir, attemptId, output.path), bytes);
  }
  const publicationBytes = new Map(bytesByPath);
  for (const [publicationPath, value] of Object.entries(additionalPublications)) {
    const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, "utf8");
    publicationBytes.set(publicationPath, bytes);
    writeFileDurable(path.join(layout.artifactsDir, attemptId, publicationPath), bytes);
  }
  writeArtifactManifest({
    layout,
    nodeId: attemptId,
    include: [...publicationBytes.keys()],
    outputs: node.outputs,
    prerequisiteNodeIds: [...prerequisiteAttemptIds],
    provenance: {
      producer_node_id: attemptId,
      logical_node_id: node.logical_id,
      attempt_index: node.loop.attempt_index,
      loop_index: node.loop.index,
      model_index: modelIndex,
      agent_ref: "CodexAgent",
      workflow_run_id: WORKFLOW_RUN_ID,
      workflow_task_id: `node:${attemptId}`,
      origin: "workflow",
      metadata: { concrete_node_id: node.id }
    }
  });
  const marker: ArtifactVerificationMarker = {
    schema_version: ARTIFACT_VERIFICATION_SCHEMA_VERSION,
    attempt_id: attemptId,
    node_id: node.logical_id,
    artifacts: node.outputs.map((output) => ({ ...output, sha256: digest(bytesByPath.get(output.path)!) })),
    publications: [...publicationBytes].map(([publicationPath, bytes]) => ({
      path: publicationPath,
      sha256: digest(bytes)
    }))
  };
  writeJsonDurable(path.join(layout.root, ".ultrafuzz-verification", `${attemptId}.json`), marker);
  updateNodeState(layout, attemptId, {
    status: "succeeded",
    finished_at: new Date().toISOString(),
    wait_since: undefined,
    wait_reason: undefined,
    next_eligible_action: undefined,
    provenance: {
      workflow: {
        run_id: WORKFLOW_RUN_ID,
        task_id: `verify:${attemptId}`,
        agent_task_id: `node:${attemptId}`,
        verifier_task_id: `verify:${attemptId}`,
        state: "finished",
        attempt: 0
      },
      output_contracts: {
        ok: true,
        missing: [],
        artifact_manifest_sha256: digest(
          fs.readFileSync(path.join(layout.artifactsDir, attemptId, "artifact-manifest.json"))
        )
      }
    }
  });
}

function plannedAttemptIds(node: PlannedGraphNodeDocument): string[] {
  if (node.model_fanout.length <= 1) return [node.id];
  return node.model_fanout.map((model) => `${node.id}__model_${model.model_index}__attempt_${model.attempt_index}`);
}

function smithersTaskForNode(
  layout: RunLayout,
  graph: PlannedGraphDocument,
  node: PlannedGraphNodeDocument,
  attemptId: string
): SmithersTaskManifestTask {
  const nodesById = new Map(graph.nodes.map((candidate) => [candidate.id, candidate] as const));
  const attemptOffset = plannedAttemptIds(node).indexOf(attemptId);
  assert.notEqual(attemptOffset, -1);
  const model = node.model_fanout[attemptOffset];
  const dependencies = node.depends_on.flatMap((dependencyId) => plannedAttemptIds(nodesById.get(dependencyId)!));
  const dependencySmithersNodeIds = node.depends_on.flatMap((dependencyId) => {
    const dependency = nodesById.get(dependencyId)!;
    return dependency.kind === "agentic"
      ? plannedAttemptIds(dependency).map((dependencyAttemptId) => `verify:${dependencyAttemptId}`)
      : [];
  });
  const ancestors = new Set<string>();
  const pending = [...node.depends_on];
  while (pending.length > 0) {
    const dependencyId = pending.pop()!;
    if (ancestors.has(dependencyId)) continue;
    ancestors.add(dependencyId);
    pending.push(...nodesById.get(dependencyId)!.depends_on);
  }
  const dependencyArtifactDirs = graph.nodes
    .filter((candidate) => ancestors.has(candidate.id))
    .flatMap(plannedAttemptIds)
    .map((ancestorAttemptId) => getNodeArtifactDir(layout, ancestorAttemptId, { create: true }));
  const optionalAttemptIds = new Set(
    graph.nodes
      .filter(
        (candidate) =>
          candidate.group !== undefined && graph.groups[candidate.group]?.defaults?.failure_policy === "continue"
      )
      .flatMap(plannedAttemptIds)
  );
  const optionalDependencyArtifactDirs = dependencyArtifactDirs.filter((directory) =>
    optionalAttemptIds.has(path.basename(directory))
  );
  const artifactDir = getNodeArtifactDir(layout, attemptId, { create: true });
  const workspacePath = path.join(layout.workspacesDir, attemptId);
  const outputs = node.outputs.map((output) => ({
    path: output.path,
    contract: output.contract,
    contractDigest: output.contract_digest,
    ...(output.schema_file === undefined
      ? {}
      : {
          schemaFile: output.schema_file,
          schemaId: output.schema_id,
          schemaSha256: output.schema_sha256,
          schemaBundleSha256: output.schema_bundle_sha256,
          validatorBuild: output.validator_build
        }),
    primary: output.primary
  }));
  const agentRef = model?.agent_ref ?? "CodexAgent";
  const modelName = model?.model_name ?? "gpt-test";
  const reasoningEffort = model?.reasoning_effort ?? "high";
  const agentChain = [
    {
      profileId: model?.model_profile_id ?? "default",
      agentRef,
      modelName,
      reasoningEffort,
      role: "primary" as const
    }
  ];
  const execution = {
    mode: "local" as const,
    resources: { cpu: 2, memoryMiB: 1_024, timeoutSeconds: 60 },
    agentCredentialEnv: []
  };
  return {
    attemptId,
    concreteNodeId: node.id,
    logicalNodeId: node.logical_id,
    preparationSmithersNodeId: `prepare:${attemptId}`,
    smithersNodeId: `node:${attemptId}`,
    verifierSmithersNodeId: `verify:${attemptId}`,
    agentRef,
    agentChain,
    modelName,
    reasoningEffort,
    dependencies,
    dependencySmithersNodeIds,
    timeoutMs: 60_000,
    heartbeatTimeoutMs: 60_000,
    retries: 0,
    retryPolicy: { backoff: "exponential", initialDelayMs: 1_000 },
    workspacePath,
    artifactDir,
    dependencyArtifactDirs,
    optionalDependencyArtifactDirs,
    renderedPromptPath: path.join(layout.root, "prompts", `${attemptId}.md`),
    execution,
    metadata: {
      schemaVersion: SMITHERS_TASK_METADATA_SCHEMA_VERSION,
      run: {
        ultrafuzzRunId: layout.runId,
        smithersWorkflowName: WORKFLOW_RUN_ID,
        graphVersion: "4",
        topologyVersion: 2
      },
      node: {
        concreteNodeId: node.id,
        logicalNodeId: node.logical_id,
        attemptId,
        label: node.display_name,
        kind: "agentic",
        ...(node.group === undefined ? {} : { group: node.group }),
        ...(node.prompt_path === "" ? {} : { promptPath: node.prompt_path })
      },
      dependencies: {
        concreteNodeIds: [...node.depends_on],
        attemptIds: dependencies,
        smithersNodeIds: dependencySmithersNodeIds
      },
      loop: {
        index: node.loop.index,
        count: node.loop.count,
        mode: node.loop.mode,
        attemptIndex: node.loop.attempt_index
      },
      model: {
        profileId: model?.model_profile_id ?? "default",
        agentRef,
        modelName,
        reasoningEffort,
        modelIndex: model?.model_index ?? 0,
        attemptIndex: model?.attempt_index ?? node.loop.attempt_index,
        agentChain
      },
      workspace: { primitive: "worktree", path: workspacePath, repoPath: "/repo", trustModel: "skip-permissions" },
      artifacts: { dir: artifactDir, outputs, manifestPath: path.join(artifactDir, "artifact-manifest.json") },
      retryPolicy: { maxAttempts: 1, sameAgentAttempts: 1, smithersRetries: 0 },
      timeout: { milliseconds: 60_000, seconds: 60, heartbeatTimeoutMs: 60_000 },
      execution: { mode: execution.mode, resources: execution.resources }
    }
  };
}

function writeSealedTaskAuthority(
  layout: RunLayout,
  graph: PlannedGraphDocument,
  tasks: SmithersTaskManifestTask[]
): void {
  const smithersRoot = path.join(layout.root, "smithers");
  fs.mkdirSync(smithersRoot, { recursive: true });
  const tasksPath = path.join(smithersRoot, "tasks.json");
  const document: SmithersTaskManifestDocument = {
    schema_version: SMITHERS_TASK_MANIFEST_SCHEMA_VERSION,
    run_id: layout.runId,
    smithers_run_id: `ultrafuzz-${layout.runId}`,
    workflow_name: WORKFLOW_RUN_ID,
    pinned_submodules: null,
    tasks
  };
  writeJsonDurable(tasksPath, document);
  const graphBytes = fs.readFileSync(layout.graphPath);
  const graphFingerprintBytes = fs.readFileSync(layout.graphFingerprintPath);
  const taskBytes = fs.readFileSync(tasksPath);
  const emptyFile = { sha256: digest(Buffer.alloc(0)), size_bytes: 0 };
  const files = {
    graph: { sha256: digest(graphBytes), size_bytes: graphBytes.byteLength },
    expanded_graph: emptyFile,
    graph_fingerprint: {
      sha256: digest(graphFingerprintBytes),
      size_bytes: graphFingerprintBytes.byteLength
    },
    config: emptyFile,
    tasks: { sha256: digest(taskBytes), size_bytes: taskBytes.byteLength },
    input: emptyFile,
    workflow: emptyFile,
    evidence_workflow: emptyFile
  };
  writeJsonDurable(path.join(smithersRoot, "control-integrity.json"), {
    schema_version: WORKFLOW_CONTROL_INTEGRITY_SCHEMA_VERSION,
    run_id: layout.runId,
    files,
    execution_files: [],
    bindings: {
      run_id: layout.runId,
      graph_fingerprint: "f".repeat(64),
      config_fingerprint: "e".repeat(64),
      expected_state_node_ids: graph.nodes.map((node) => node.id).sort(),
      expected_task_attempt_ids: tasks.map((task) => task.attemptId).sort(),
      expected_task_node_ids: tasks
        .flatMap((task) => [task.preparationSmithersNodeId, task.smithersNodeId, task.verifierSmithersNodeId])
        .sort()
    }
  });
}

function finalReportOutputs(): ArtifactManifestOutputContract[] {
  const reportBinding = artifactContractSchemaBinding("ultrafuzz/report@3");
  assert.ok(reportBinding);
  return [
    {
      path: REPORT_MARKDOWN_PATH,
      contract: "ultrafuzz/nonempty-markdown@1",
      contract_digest: artifactContractDefinition("ultrafuzz/nonempty-markdown@1").digest,
      primary: true
    },
    {
      path: REPORT_JSON_PATH,
      contract: "ultrafuzz/report@3",
      contract_digest: artifactContractDefinition("ultrafuzz/report@3").digest,
      ...reportBinding,
      primary: false
    }
  ];
}

function producerOutputs(): ArtifactManifestOutputContract[] {
  return [
    {
      path: "context.md",
      contract: "ultrafuzz/nonempty-markdown@1",
      contract_digest: artifactContractDefinition("ultrafuzz/nonempty-markdown@1").digest,
      primary: true
    }
  ];
}

function readManifest(manifestPath: string): ArtifactManifest {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ArtifactManifest;
}

function sealFinalReportManifest(layout: RunLayout, attemptId: string, artifactManifestSha256: string): void {
  updateNodeState(layout, attemptId, {
    provenance: {
      workflow: {
        run_id: WORKFLOW_RUN_ID,
        task_id: `verify:${attemptId}`,
        agent_task_id: `node:${attemptId}`,
        verifier_task_id: `verify:${attemptId}`,
        state: "finished",
        attempt: 0
      },
      output_contracts: { ok: true, missing: [], artifact_manifest_sha256: artifactManifestSha256 }
    }
  });
}

function createVerifiedCampaignFixture(
  runId: string,
  options: { omitEvidencePublication?: boolean } = {}
): CampaignAuthorityFixture {
  const outputRoot = temporaryRoot("ultrafuzz-verified-campaign-");
  const catalogId = "property-specification-fanin";
  const implementationId = "stateful-invariant-implement-properties";
  const campaignId = "stateful-invariant-campaign";
  const catalogOutputs = [
    boundOutput("properties.json", "ultrafuzz/properties@2", true),
    boundOutput("properties.md", "ultrafuzz/nonempty-markdown@1", false)
  ];
  const implementationOutputs = [
    boundOutput("implemented-properties.json", "ultrafuzz/implemented-properties@3", true)
  ];
  const campaignOutputs = [
    boundOutput("campaign-plan.json", "ultrafuzz/invariant-campaign-plan@2", false),
    boundOutput("campaign.json", "ultrafuzz/property-campaign@3", true),
    boundOutput("findings.json", "ultrafuzz/findings@2", false),
    boundOutput("campaign-summary.json", "ultrafuzz/campaign-summary@2", false)
  ];
  const graph: PlannedGraphDocument = {
    schema_version: PLANNED_GRAPH_SCHEMA_VERSION,
    graph_version: "4",
    topology_version: 2,
    groups: {},
    nodes: [
      plannedAgentNode(catalogId, catalogOutputs, []),
      plannedAgentNode(implementationId, implementationOutputs, [catalogId]),
      { ...plannedAgentNode(campaignId, campaignOutputs, [implementationId]), timeout_seconds: 7200 }
    ]
  };
  const layout = createRunLayout({
    outputRoot,
    runId,
    resolvedConfigToml: '[invariants]\ninvariant_testing_fuzzer_timeout = "1h"\n',
    graph,
    graphFingerprint: "f".repeat(64),
    configFingerprint: "e".repeat(64),
    stateNodes: [
      { id: catalogId, logicalNodeId: catalogId, artifactDir: `artifacts/${catalogId}`, outputs: catalogOutputs },
      {
        id: implementationId,
        logicalNodeId: implementationId,
        artifactDir: `artifacts/${implementationId}`,
        outputs: implementationOutputs
      },
      { id: campaignId, logicalNodeId: campaignId, artifactDir: `artifacts/${campaignId}`, outputs: campaignOutputs }
    ]
  });

  const paths = {
    corpus: "backends/recon/corpus",
    cache: "backends/recon/cache",
    log: "backends/recon/run.log",
    raw_results: "backends/recon/results.json",
    reproducers: "backends/recon/reproducers"
  } as const;
  const logBytes = Buffer.from("campaign complete\n", "utf8");
  const evidenceBytes = Buffer.from('{"executions":1}\n', "utf8");
  const catalog = {
    schema_version: "ultrafuzz.properties.v2",
    properties: [
      {
        id: "property-one",
        description: "Balances remain conserved.",
        category: "accounting",
        priority: "high",
        sources: [{ source_node_id: "property-specification-manual", source_property_id: "property-one" }]
      }
    ]
  };
  const implemented = {
    schema_version: "ultrafuzz.implemented-properties.v3",
    selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-one"] },
    properties: [
      {
        property_id: "property-one",
        status: "implemented",
        implementation_paths: ["test/recon/Properties.sol"],
        test_paths: []
      }
    ]
  };
  const campaignCommand =
    "timeout --preserve-status --signal=INT --kill-after=300s 3600s recon fuzz . --workers 1 --test-limit 18446744073709551615 --timeout 3600 --seq-len 100";
  const plan = {
    schema_version: "ultrafuzz.invariant-campaign-plan.v2",
    available_vcpus: 1,
    workers: 1,
    configured_budget_seconds: 4200,
    deadline: "2026-01-01T01:10:00Z",
    finalization_reserve_seconds: 300,
    configured_fuzzer_timeout_seconds: 3600,
    recon_internal_timeout_seconds: 3600,
    recon_test_limit: "18446744073709551615",
    recon_sequence_length: 100,
    host_soft_timeout_seconds: 3600,
    host_force_kill_grace_seconds: 300,
    artifact_finalization_reserve_seconds: 300,
    backend_started_at: "2026-01-01T00:00:00Z",
    fuzzing_deadline_utc: "2026-01-01T01:00:00Z",
    force_kill_deadline_utc: "2026-01-01T01:05:00Z",
    final_artifact_deadline_utc: "2026-01-01T01:10:00Z",
    backend: { name: "recon", version: null, exact_shell_escaped_command: campaignCommand },
    command_plan: [{ phase: "campaign", command: campaignCommand }],
    paths
  };
  const campaign = {
    schema_version: "ultrafuzz.property-campaign.v3",
    campaign_plan_ref: "campaign-plan.json",
    implemented_properties_ref: "implemented-properties.json",
    findings_ref: "findings.json",
    campaign_summary_ref: "campaign-summary.json",
    fuzzer_backend: "recon",
    backend_version: null,
    configured_timeout_seconds: 3600,
    sequence_length: 100,
    exact_command: campaignCommand,
    start_timestamp: "2026-01-01T00:00:00Z",
    end_timestamp: "2026-01-01T01:00:00Z",
    termination_reason: "configured-timeout",
    campaign_outcome: "complete",
    usable_results: true,
    execution: {
      status: "complete",
      usable_results: true,
      command: campaignCommand,
      config_path: null,
      workers: 1,
      started_at: "2026-01-01T00:00:00Z",
      finished_at: "2026-01-01T01:00:00Z",
      deadline: "2026-01-01T01:10:00Z",
      exit_code: 0,
      failure: null
    },
    paths,
    evidence_files: [
      { path: paths.log, size_bytes: logBytes.length, sha256: digest(logBytes) },
      { path: paths.raw_results, size_bytes: evidenceBytes.length, sha256: digest(evidenceBytes) }
    ],
    coverage: {
      status: "reported",
      metrics: [{ name: "executions", value: 1, unit: "count", source_ref: paths.raw_results }],
      unavailable_reason: null
    },
    property_results: [
      {
        property_id: "property-one",
        status: "passed",
        failure_ids: [],
        coverage_metric_names: ["executions"],
        evidence_refs: [paths.raw_results],
        reason: null
      }
    ],
    failures: []
  };
  const summary = {
    schema_version: "ultrafuzz.campaign-summary.v2",
    outcome: "complete",
    sequence_length: 100,
    implemented_property_suite_refs: ["implemented-properties.json"],
    campaign_plan_ref: "campaign-plan.json",
    backend_results: [{ fuzzer_backend: "recon", status: "complete", result_ref: "campaign.json" }],
    finding_refs: [],
    reproducer_refs: [],
    failure_counts: { pre_deduplication: 0, post_deduplication: 0 }
  };

  const campaignDir = path.join(layout.artifactsDir, campaignId);
  const evidencePath = path.join(campaignDir, paths.raw_results);
  const catalogNode = graph.nodes.find((node) => node.id === catalogId)!;
  const implementationNode = graph.nodes.find((node) => node.id === implementationId)!;
  const campaignNode = graph.nodes.find((node) => node.id === campaignId)!;
  const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
  finalizeNodeOutputs(layout, catalogNode, catalogId, {
    "properties.json": json(catalog),
    "properties.md": [
      '### Canonical property: "property-one"',
      'description: "Balances remain conserved."',
      'category: "accounting"',
      'priority: "high"',
      'sources: [{"source_node_id":"property-specification-manual","source_property_id":"property-one"}]',
      '### End canonical property: "property-one"'
    ].join("\n")
  });
  finalizeNodeOutputs(
    layout,
    implementationNode,
    implementationId,
    { "implemented-properties.json": json(implemented) },
    [catalogId]
  );
  finalizeNodeOutputs(
    layout,
    campaignNode,
    campaignId,
    {
      "campaign-plan.json": json(plan),
      "campaign.json": json(campaign),
      "findings.json": json([]),
      "campaign-summary.json": json(summary)
    },
    [implementationId],
    0,
    {
      [paths.log]: logBytes,
      ...(options.omitEvidencePublication === true ? {} : { [paths.raw_results]: evidenceBytes })
    }
  );
  if (options.omitEvidencePublication === true) writeFileDurable(evidencePath, evidenceBytes);

  const tasks = graph.nodes.flatMap((node) =>
    plannedAttemptIds(node).map((attemptId) => smithersTaskForNode(layout, graph, node, attemptId))
  );
  writeSealedTaskAuthority(layout, graph, tasks);

  return { layout, evidencePath, evidenceBytes };
}

function plannedAgentNode(
  id: string,
  outputs: ArtifactManifestOutputContract[],
  dependsOn: string[]
): PlannedGraphDocument["nodes"][number] {
  return {
    id,
    logical_id: id,
    display_name: id,
    kind: "agentic",
    depends_on: dependsOn,
    artifact_dir: `artifacts/${id}`,
    outputs,
    prompt_id: id,
    prompt_path: `${id}.md`,
    loop: { index: 0, count: 1, mode: "parallel", attempt_index: 0 },
    model_fanout: [],
    workflow: { node_id: `node:${id}`, task_node_ids: [`node:${id}`] }
  };
}

function currentReport(runId: string, issues: Record<string, unknown>[] = []): Record<string, unknown> {
  return {
    schema_version: "ultrafuzz.report.v3",
    run_metadata: {
      run_id: runId,
      source_run_id: runId,
      repository: "example/repository",
      elapsed_time: "1m",
      models_used: ["model-a"],
      tokens_used: "100",
      estimated_spend: "$0.01",
      partial_pricing: false,
      strategy_loops: 1,
      audit_profile: "exhaustive",
      audit_profile_catalog_digest: "a".repeat(64),
      topology_digest: "b".repeat(64),
      prompt_digest: "c".repeat(64),
      expanded_graph_fingerprint: "d".repeat(64)
    },
    issues,
    non_production_outcomes: [],
    property_provenance: [],
    property_implementation_coverage: {
      status: "not-planned",
      reason: "property-implementation-track-not-declared"
    }
  };
}

function currentIssue(): Record<string, unknown> {
  return {
    schema_version: "ultrafuzz.finding.v2",
    id: "M-01",
    title: "[M-01] - Current finding",
    status: "confirmed",
    severity_guess: "Medium",
    confidence: "high",
    summary: "A bounded state transition violates the expected relationship.",
    description: "A caller can reach a state that violates the documented relationship.",
    severity: "Medium",
    impact: "Medium",
    likelihood: "Medium",
    impact_rationale: "The affected state remains bounded.",
    likelihood_rationale: "The transition uses ordinary preconditions.",
    severity_rationale: "Medium impact and Medium likelihood map to Medium.",
    proof_of_concept: {
      scenario: ["Prepare the bounded state.", "Execute the transition and observe the mismatch."],
      language: "solidity",
      code: "function testCurrentFinding() public {}"
    },
    strategy: "stateful-invariant",
    strategy_provenance: {
      detection_rates: [{ strategy: "stateful-invariant", detections: 1, configured_loops: 1 }]
    },
    lifecycle: {
      dedupe_key: "current-finding",
      source_artifacts: [],
      strategy_hits: [{ strategy: "stateful-invariant" }],
      canonical_severity: "Medium"
    }
  };
}

function digest(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
