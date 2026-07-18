import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendEvent,
  appendLineDurable,
  createRunLayout,
  getNodeArtifactDir,
  normalizeFindings,
  normalizeSafeRelativePath,
  queryEvents,
  readFindings,
  readRunState,
  replayEvents,
  safeResolveInside,
  updateNodeState,
  verifyArtifactManifestPrerequisites,
  writeArtifact,
  writeArtifactManifest,
  writeGeneratedTestManifest
} from "../src/index.js";

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ufz-artifacts-"));
}

test("createRunLayout persists product-owned run evidence outside checkpoints", () => {
  const project = tempProject();
  const layout = createRunLayout({
    projectRoot: project,
    runId: "run-1",
    sourceRunId: "run-0",
    resolvedConfigToml: '[run]\noutput_dir = ".ultrafuzz/runs"\n',
    configRedactions: { schema_version: "1.0", redactions: [{ key: "OPENAI_API_KEY" }] },
    graph: { schema_version: "1.0", nodes: [{ id: "node-a" }] },
    graphFingerprint: "graph-fp",
    configFingerprint: "config-fp",
    stateNodes: [
      {
        id: "node-a",
        logicalNodeId: "node-a",
        outputs: [
          {
            path: "setup/result.md",
            contract: "ultrafuzz/nonempty-markdown@1",
            contract_digest: "a".repeat(64),
            primary: true
          }
        ]
      }
    ]
  });

  for (const expected of [
    layout.runMetadataPath,
    layout.sourceRunPath,
    layout.resolvedConfigPath,
    layout.configRedactionsPath,
    layout.graphPath,
    layout.graphFingerprintPath,
    layout.statePath,
    layout.eventsPath,
    layout.workspacesPath,
    path.join(layout.eventsIndexDir, "query-inputs.json")
  ]) {
    assert.equal(fs.existsSync(expected), true, expected);
  }
  for (const expected of [layout.artifactsDir, layout.reviewDir, layout.eventsIndexDir]) {
    assert.equal(fs.statSync(expected).isDirectory(), true, expected);
  }
  assert.equal(path.basename(getNodeArtifactDir(layout, "node-a", { create: true })), "node-a");
});

test("createRunLayout rejects symlinked run roots before creating outside writes", () => {
  const project = tempProject();
  const outside = tempProject();
  fs.symlinkSync(outside, path.join(project, ".ultrafuzz"));

  assert.throws(() => createRunLayout({ projectRoot: project, runId: "run-1" }), /symlink/);
  assert.equal(fs.existsSync(path.join(outside, "runs")), false);
});

test("safe path helpers reject traversal, absolutes, unsafe IDs, and symlink escapes", () => {
  assert.throws(() => normalizeSafeRelativePath("../secret"), /traverse/);
  assert.throws(() => normalizeSafeRelativePath("/tmp/secret"), /relative/);
  assert.throws(() => safeResolveInside(tempProject(), "Display Name/report.md"), /unsafe segment/);

  const root = tempProject();
  const outside = tempProject();
  fs.symlinkSync(outside, path.join(root, "link"));
  assert.throws(() => safeResolveInside(root, "link/file.txt"), /symlink/);
});

test("artifact manifests record safe paths, sizes, digests, schema version, and provenance", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-1" });
  const artifactPath = writeArtifact(layout, "node-a", "setup/project.md", "hello artifact\n");
  const manifest = writeArtifactManifest({
    layout,
    nodeId: "node-a",
    outputs: [
      {
        path: "setup/project.md",
        contract: "ultrafuzz/nonempty-markdown@1",
        contract_digest: "a".repeat(64),
        primary: true
      }
    ],
    provenance: {
      logical_node_id: "node-a",
      agent_ref: "CodexAgent",
      workflow_run_id: "workflow-run-1",
      workflow_task_id: "node:node-a",
      attempt_index: 0
    }
  });

  assert.equal(manifest.schema_version, "1.0");
  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.files[0]!.path, "setup/project.md");
  assert.equal(manifest.files[0]!.size_bytes, fs.statSync(artifactPath).size);
  assert.equal(manifest.files[0]!.sha256, crypto.createHash("sha256").update("hello artifact\n").digest("hex"));
  assert.equal(manifest.files[0]!.provenance.producer_node_id, "node-a");
  assert.equal(manifest.files[0]!.provenance.agent_ref, "CodexAgent");
  assert.equal(manifest.files[0]!.provenance.workflow_task_id, "node:node-a");
  assert.equal(manifest.output_contracts[0]!.contract, "ultrafuzz/nonempty-markdown@1");
  assert.deepEqual(manifest.prerequisite_manifests, []);
});

test("artifact manifests preserve causal prerequisite digests for safe reuse", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-causal" });
  writeArtifact(layout, "ancestor", "result.md", "unchanged\n");
  writeArtifactManifest({ layout, nodeId: "ancestor", createdAt: "2026-07-18T00:00:00.000Z" });
  writeArtifact(layout, "descendant", "result.md", "derived\n");
  const descendant = writeArtifactManifest({
    layout,
    nodeId: "descendant",
    prerequisiteNodeIds: ["ancestor"],
    createdAt: "2026-07-18T00:00:01.000Z"
  });

  assert.equal(descendant.prerequisite_manifests.length, 1);
  assert.deepEqual(verifyArtifactManifestPrerequisites(layout, "descendant"), {
    ok: true,
    changed: [],
    missing: []
  });

  writeArtifact(layout, "ancestor", "result.md", "changed\n");
  writeArtifactManifest({ layout, nodeId: "ancestor", createdAt: "2026-07-18T00:00:02.000Z" });
  assert.deepEqual(verifyArtifactManifestPrerequisites(layout, "descendant"), {
    ok: false,
    changed: ["ancestor"],
    missing: []
  });
});

test("events append to JSONL, redact secrets, replay, and expose query indexes", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-1" });
  appendEvent(layout, {
    eventType: "node-started",
    nodeId: "node-a",
    status: "running",
    payload: { token: "sk-secret", nested: { api_key: "abc" } }
  });
  appendEvent(layout, {
    eventType: "node-finished",
    nodeId: "node-a",
    status: "succeeded",
    payload: { ok: true }
  });

  const replay = replayEvents(layout);
  assert.equal(replay.records.length, 2);
  assert.deepEqual(replay.records[0]!.payload, { token: "<redacted>", nested: { api_key: "<redacted>" } });
  assert.equal(queryEvents(layout, { nodeId: "node-a", status: "succeeded" }).length, 1);
  assert.equal(fs.existsSync(path.join(layout.eventsIndexDir, "node", "node-a.jsonl")), true);
  assert.equal(fs.existsSync(path.join(layout.eventsIndexDir, "status", "succeeded.jsonl")), true);
});

test("event redaction covers token families, AWS keys, URL credentials, and private keys", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-artifacts-events-"));
  const layout = createRunLayout({ outputRoot: path.join(root, "runs"), runId: "run-redaction" });
  appendEvent(layout, {
    eventType: "workflow-result",
    payload: {
      stdout: "Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijkl.zyxwvutsrq AKIAIOSFODNN7EXAMPLE",
      stderr: "https://user:pass@example.com xoxb-1234567890-abcdefghi",
      keyBlock: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----"
    }
  });
  const serialized = fs.readFileSync(layout.eventsPath, "utf8");
  assert.doesNotMatch(serialized, /AKIAIOSFODNN7EXAMPLE/);
  assert.doesNotMatch(serialized, /xoxb-/);
  assert.doesNotMatch(serialized, /user:pass/);
  assert.doesNotMatch(serialized, /PRIVATE KEY/);
});

test("run state redacts secret-looking node errors before persistence", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-state-redaction" });
  updateNodeState(layout, "node-a", {
    status: "failed",
    last_error: "request failed with Authorization: Bearer sk-state-secret"
  });

  const serialized = fs.readFileSync(layout.statePath, "utf8");
  assert.doesNotMatch(serialized, /sk-state-secret/);
  assert.match(readRunState(layout).nodes["node-a"]?.last_error ?? "", /<redacted>/);
});

test("durable append rejects a symlinked parent before creating outside directories", () => {
  const root = tempProject();
  const outside = tempProject();
  fs.symlinkSync(outside, path.join(root, "linked"), "dir");

  assert.throws(
    () => appendLineDurable(path.join(root, "linked", "created", "audit.jsonl"), "entry", root),
    /crosses symlink/u
  );
  assert.equal(fs.existsSync(path.join(outside, "created")), false);
});

test("findings normalize schema-versioned findings arrays", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-1" });
  const nodeDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  fs.writeFileSync(
    path.join(nodeDir, "findings.json"),
    JSON.stringify([
      {
        title: "Invariant can be broken",
        status: "candidate",
        severity_guess: "high",
        confidence: "medium",
        summary: "A generated test demonstrates the issue.",
        affected_files: [".ultrafuzz/runs/run-1/artifacts/strategy-a/generated-tests/Invariant.t.sol"],
        evidence: [{ kind: "test", path: ".ultrafuzz/runs/run-1/artifacts/strategy-a/generated-tests/Invariant.t.sol" }]
      }
    ])
  );

  const report = normalizeFindings({
    artifactDir: nodeDir,
    nodeId: "strategy-a",
    provenance: {
      strategy: "strategy-a",
      attemptIndex: 0,
      modelId: "test-fast",
      model: "unit-model",
      modelIndex: 1,
      loopIndex: 2
    }
  });

  assert.equal(report.count, 1);
  assert.equal(Array.isArray(readFindings(nodeDir)), true);
  assert.equal(report.findings[0]!.schema_version, "1.0");
  assert.equal(report.findings[0]!.id, "strategy-a-0");
  assert.equal(report.findings[0]!.strategy, "strategy-a");
  assert.equal(report.findings[0]!.model_index, 1);
  assert.deepEqual(report.findings[0]!.affected_files, [
    ".ultrafuzz/runs/run-1/artifacts/strategy-a/generated-tests/Invariant.t.sol"
  ]);
  assert.deepEqual(report.findings[0]!.evidence, [
    { kind: "test", path: ".ultrafuzz/runs/run-1/artifacts/strategy-a/generated-tests/Invariant.t.sol" }
  ]);
});

test("findings normalize agent lifecycle statuses and flexible evidence references", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-1" });
  const nodeDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  fs.writeFileSync(
    path.join(nodeDir, "findings.json"),
    JSON.stringify([
      {
        title: "Generated test reproduces issue",
        status: "reproduced_by_generated_test",
        severity_guess: "high",
        confidence: "high",
        summary: "The generated test fails deterministically.",
        notes: "narrow rerun confirmed the generated test",
        evidence: [
          "test/foundry/strategy-a/Generated.t.sol::testReproducesIssue",
          { note: "Generated test reproduces issue" },
          { kind: "validation", path: "forge test --match-path test/foundry/strategy-a/Generated.t.sol -vvvv" }
        ]
      }
    ])
  );

  const report = normalizeFindings({ artifactDir: nodeDir, nodeId: "strategy-a" });

  assert.equal(report.count, 1);
  assert.equal(report.findings[0]!.status, "reproduced_by_generated_test");
  assert.deepEqual(report.findings[0]!.notes, ["narrow rerun confirmed the generated test"]);
  assert.deepEqual(report.findings[0]!.evidence, [
    "test/foundry/strategy-a/Generated.t.sol::testReproducesIssue",
    { note: "Generated test reproduces issue" },
    { kind: "validation", command: "forge test --match-path test/foundry/strategy-a/Generated.t.sol -vvvv" }
  ]);

  fs.writeFileSync(
    path.join(nodeDir, "findings.json"),
    JSON.stringify([
      {
        title: "Generated test reproduces issue",
        status: "reproduced_by_generated_test",
        severity_guess: "high",
        confidence: "high",
        summary: "The generated test fails deterministically.",
        evidence: [{ kind: 123 }]
      }
    ])
  );

  assert.throws(() => normalizeFindings({ artifactDir: nodeDir, nodeId: "strategy-a" }), /field kind/);
});

test("findings normalize markdown evidence path fragments", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-1" });
  const nodeDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  fs.writeFileSync(
    path.join(nodeDir, "findings.json"),
    JSON.stringify([
      {
        title: "Recipe-backed issue",
        status: "candidate",
        severity_guess: "medium",
        confidence: "medium",
        summary: "A recipe section explains the issue.",
        evidence: [{ kind: "recipe", path: "artifacts/strategy-a/recipes.md#bt-013" }]
      }
    ])
  );

  const report = normalizeFindings({ artifactDir: nodeDir, nodeId: "strategy-a" });

  assert.deepEqual(report.findings[0]!.evidence, [
    { kind: "recipe", path: "artifacts/strategy-a/recipes.md", fragment: "bt-013" }
  ]);

  fs.writeFileSync(
    path.join(nodeDir, "findings.json"),
    JSON.stringify([
      {
        title: "Recipe-backed issue",
        status: "candidate",
        severity_guess: "medium",
        confidence: "medium",
        summary: "A recipe section explains the issue.",
        evidence: [{ kind: "recipe", path: "artifacts/strategy-a/recipes.md#bt-013", fragment: "other" }]
      }
    ])
  );

  assert.throws(() => normalizeFindings({ artifactDir: nodeDir, nodeId: "strategy-a" }), /fragment conflicts/);
});

test("findings normalize source evidence line suffixes", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-1" });
  const nodeDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  fs.writeFileSync(
    path.join(nodeDir, "findings.json"),
    JSON.stringify([
      {
        title: "Source-backed issue",
        status: "candidate",
        severity_guess: "medium",
        confidence: "medium",
        summary: "A source line anchors the issue.",
        evidence: [{ kind: "source", path: "src/Oracle.sol:42" }]
      }
    ])
  );

  const report = normalizeFindings({ artifactDir: nodeDir, nodeId: "strategy-a" });

  assert.deepEqual(report.findings[0]!.evidence, [{ kind: "source", path: "src/Oracle.sol", line: 42 }]);

  fs.writeFileSync(
    path.join(nodeDir, "findings.json"),
    JSON.stringify([
      {
        title: "Source-backed issue",
        status: "candidate",
        severity_guess: "medium",
        confidence: "medium",
        summary: "A source line anchors the issue.",
        evidence: [{ kind: "source", path: "src/Oracle.sol:42", line: 43 }]
      }
    ])
  );

  assert.throws(() => normalizeFindings({ artifactDir: nodeDir, nodeId: "strategy-a" }), /line conflicts/);
});

test("findings metadata paths allow dot-prefixed generated roots but reject traversal", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-1" });
  const nodeDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  fs.writeFileSync(
    path.join(nodeDir, "findings.json"),
    JSON.stringify([
      {
        title: "Traversal",
        status: "candidate",
        severity_guess: "medium",
        confidence: "medium",
        summary: "A generated test suggests a reviewable issue.",
        affected_files: ["../outside.sol"]
      }
    ])
  );

  assert.throws(() => normalizeFindings({ artifactDir: nodeDir }), /traverse/);

  fs.writeFileSync(
    path.join(nodeDir, "findings.json"),
    JSON.stringify([
      {
        title: "Traversal",
        status: "candidate",
        severity_guess: "medium",
        confidence: "medium",
        summary: "A generated test suggests a reviewable issue.",
        evidence: [{ kind: "test", path: "../outside.sol" }]
      }
    ])
  );

  assert.throws(() => normalizeFindings({ artifactDir: nodeDir }), /traverse/);
});

test("findings normalization requires findings.json and rejects symlink sources", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-1" });
  const nodeDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  fs.writeFileSync(
    path.join(nodeDir, "finding.json"),
    JSON.stringify({
      title: "Candidate issue",
      status: "candidate",
      severity_guess: "medium",
      confidence: "medium",
      summary: "A legacy single-object finding is no longer accepted."
    })
  );

  assert.throws(() => normalizeFindings({ artifactDir: nodeDir }), /missing findings\.json/);

  fs.writeFileSync(
    path.join(nodeDir, "findings.json"),
    JSON.stringify([
      {
        schema_version: "1.0",
        title: "Candidate issue",
        status: "candidate",
        severity_guess: "medium",
        confidence: "medium",
        summary: "The generated test suggests a reviewable issue."
      }
    ])
  );

  assert.doesNotThrow(() => normalizeFindings({ artifactDir: nodeDir }));

  const outside = tempProject();
  fs.writeFileSync(path.join(outside, "findings.json"), "[]");
  fs.unlinkSync(path.join(nodeDir, "findings.json"));
  fs.symlinkSync(path.join(outside, "findings.json"), path.join(nodeDir, "findings.json"));
  assert.throws(() => normalizeFindings({ artifactDir: nodeDir }), /symlink/);
});

test("generated-test manifests persist explicit generated files with provenance", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-1" });
  const manifest = writeGeneratedTestManifest({
    layout,
    nodeId: "strategy-a",
    provenance: { agent_ref: "CodexAgent", workflow_task_id: "node:strategy-a", attempt_index: 0 },
    tests: [
      {
        path: "Invariant.t.sol",
        content: "contract InvariantTest {}\n",
        language: "solidity",
        framework: "foundry"
      }
    ]
  });

  assert.equal(manifest.schema_version, "1.0");
  assert.equal(manifest.generated_tests.length, 1);
  assert.equal(manifest.generated_tests[0]!.path, "generated-tests/Invariant.t.sol");
  assert.equal(manifest.generated_tests[0]!.provenance!.agent_ref, "CodexAgent");
  assert.equal(
    fs.existsSync(path.join(getNodeArtifactDir(layout, "strategy-a"), "generated-tests", "Invariant.t.sol")),
    true
  );
});
