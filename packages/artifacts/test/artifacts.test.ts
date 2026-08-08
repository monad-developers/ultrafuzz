import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendUsageEvents,
  appendNodeAttempt,
  appendEvent,
  appendLineDurable,
  createRunLayout,
  getNodeArtifactDir,
  normalizeFindings,
  normalizeSafeRelativePath,
  manifestDigest,
  MAX_NODE_ATTEMPT_FAILURE_MESSAGE_BYTES,
  normalizeNodeAttemptFailureMessage,
  publishFileDurableExclusive,
  queryNodeAttempts,
  queryEvents,
  readEventQueryFacade,
  readFindings,
  readRunState,
  replayEvents,
  replayUsageEvents,
  safeResolveInside,
  summarizeNodeAttempts,
  updateNodeState,
  verifyArtifactManifestPrerequisites,
  writeArtifact,
  writeArtifactManifest,
  writeGeneratedTestManifest,
  writeRunState
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
    layout.usageLedgerPath,
    layout.attemptLedgerPath,
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

test("generated usage events append idempotently with stable checkpoint dimensions", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-usage" });
  const generated = {
    workflowRunId: "workflow-run-usage",
    sourceEventId: "source-event-1",
    checkpointGenerationId: "checkpoint-1",
    observedAt: "2026-07-18T00:00:00.000Z",
    nodeId: "node-a",
    iteration: 0,
    attempt: 1,
    usage: { input_tokens: 12, output_tokens: 3, cost_usd: 0.01, model: "generated-model" },
    usageComplete: true,
    usageIncompleteReasons: []
  };

  const first = appendUsageEvents(layout, [generated]);
  const replayed = appendUsageEvents(layout, [generated]);
  const ledger = replayUsageEvents(layout);

  assert.equal(first.appended, 1);
  assert.equal(replayed.appended, 0);
  assert.equal(replayed.entries[0]?.event_id, first.entries[0]?.event_id);
  assert.match(ledger.entries[0]?.attempt_id ?? "", /^usage-attempt-/u);
  assert.equal(ledger.entries[0]?.checkpoint_generation_id, "checkpoint-1");
  assert.equal(ledger.entries.length, 1);

  appendLineDurable(layout.usageLedgerPath, "{malformed", layout.root);
  assert.equal(replayUsageEvents(layout).malformedEntries, 1);
});

test("usage ledger replay rejects entries copied from another run", () => {
  const project = tempProject();
  const firstLayout = createRunLayout({ projectRoot: project, runId: "run-usage-first" });
  const secondLayout = createRunLayout({ projectRoot: project, runId: "run-usage-second" });
  const input = {
    workflowRunId: "workflow-run-usage",
    sourceEventId: "source-event-1",
    checkpointGenerationId: "checkpoint-1",
    observedAt: "2026-07-18T00:00:00.000Z",
    nodeId: "node-a",
    iteration: 0,
    attempt: 1,
    usage: { input_tokens: 1 },
    usageComplete: true,
    usageIncompleteReasons: []
  };
  appendUsageEvents(firstLayout, [input]);
  appendUsageEvents(secondLayout, [input]);
  appendLineDurable(
    secondLayout.usageLedgerPath,
    fs.readFileSync(firstLayout.usageLedgerPath, "utf8"),
    secondLayout.root
  );

  const replay = replayUsageEvents(secondLayout);
  assert.equal(replay.entries.length, 1);
  assert.equal(replay.entries[0]?.run_id, secondLayout.runId);
  assert.equal(replay.malformedEntries, 1);
});

test("node attempt ledger is append-only, idempotent, independently queryable, and exactly summarized", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "attempt-ledger" });
  const inputDigest = manifestDigest("generated input manifest");
  const outputDigest = manifestDigest("generated output manifest");
  const firstInput = {
    nodeId: "strategy-a",
    strategyAttemptId: "strategy-a",
    executorRetryId: "executor-retry-1",
    checkpointGenerationId: "checkpoint-1",
    workflowExecutionId: "execution-1",
    controllerInvocationId: "controller-1",
    startedAt: "2026-07-18T10:00:00.000Z",
    finishedAt: "2026-07-18T10:01:00.000Z",
    outcome: "failed" as const,
    inputManifestDigest: inputDigest,
    failureCategory: "executor-error" as const,
    failureMessage: `executor failed with token=private-secret ${"🙂".repeat(600)}`
  };

  const first = appendNodeAttempt(layout, firstInput);
  const replayedFirst = appendNodeAttempt(layout, firstInput);
  assert.equal(first.appended, true);
  assert.equal(replayedFirst.appended, false);
  assert.equal(replayedFirst.entry.attempt_id, first.entry.attempt_id);
  assert.equal(first.entry.failure_message, replayedFirst.entry.failure_message);
  assert.ok(Buffer.byteLength(first.entry.failure_message ?? "", "utf8") <= MAX_NODE_ATTEMPT_FAILURE_MESSAGE_BYTES);
  assert.match(first.entry.failure_message ?? "", /<redacted>/u);
  assert.doesNotMatch(first.entry.failure_message ?? "", /private-secret/u);

  const second = appendNodeAttempt(layout, {
    ...firstInput,
    executorRetryId: "executor-retry-2",
    checkpointGenerationId: "checkpoint-2",
    workflowExecutionId: "execution-2",
    controllerInvocationId: "controller-2",
    parentAttemptId: first.entry.attempt_id,
    startedAt: "2026-07-18T10:02:00.000Z",
    finishedAt: "2026-07-18T10:03:00.000Z",
    outcome: "succeeded",
    outputManifestDigest: outputDigest,
    failureCategory: undefined,
    failureMessage: undefined
  });
  appendNodeAttempt(layout, {
    ...firstInput,
    nodeId: "strategy-b",
    strategyAttemptId: "strategy-b",
    executorRetryId: "executor-retry-3",
    checkpointGenerationId: "checkpoint-2",
    workflowExecutionId: "execution-2",
    controllerInvocationId: "controller-2",
    startedAt: "2026-07-18T10:04:00.000Z",
    finishedAt: "2026-07-18T10:04:00.000Z",
    outcome: "reused",
    reuse: { status: "reused", sourceAttemptId: second.entry.attempt_id },
    outputManifestDigest: outputDigest,
    failureCategory: undefined,
    failureMessage: undefined
  });

  assert.equal(queryNodeAttempts(layout, { checkpointGenerationId: "checkpoint-1" }).length, 1);
  assert.equal(queryNodeAttempts(layout, { workflowExecutionId: "execution-2" }).length, 2);
  assert.equal(queryNodeAttempts(layout, { controllerInvocationId: "controller-2" }).length, 2);
  assert.equal(queryNodeAttempts(layout, { reuseStatus: "reused" })[0]?.reuse.status, "reused");

  const summary = summarizeNodeAttempts(queryNodeAttempts(layout));
  assert.deepEqual(summary, {
    total: 3,
    executed: 2,
    reused: 1,
    outcomes: { succeeded: 1, failed: 1, "timed-out": 0, canceled: 0, skipped: 0, reused: 1 },
    strategy_attempts: 2,
    executor_retries: 3,
    checkpoint_generations: 2,
    workflow_executions: 2,
    controller_invocations: 2
  });
  assert.equal(fs.readFileSync(layout.attemptLedgerPath, "utf8").trim().split("\n").length, 3);
  assert.equal(normalizeNodeAttemptFailureMessage("  first\nsecond  "), "first second");
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

test("validated artifact publication is atomic, exclusive, durable, and idempotent", () => {
  const root = tempProject();
  const expected = "verified artifact\n";

  const first = publishFileDurableExclusive(root, "nested/result.md", expected);
  const replay = publishFileDurableExclusive(root, "nested/result.md", expected);

  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.sha256, first.sha256);
  assert.equal(fs.readFileSync(first.path, "utf8"), expected);
  assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);
  assert.deepEqual(
    fs.readdirSync(path.dirname(first.path)).filter((entry) => entry.includes(".publish-")),
    []
  );
  assert.throws(
    () => publishFileDurableExclusive(root, "nested/result.md", "different artifact\n"),
    /different contents/u
  );
  assert.equal(fs.readFileSync(first.path, "utf8"), expected);
});

test("validated artifact publication rejects symlinked canonical parents", () => {
  const root = tempProject();
  const outside = tempProject();
  fs.symlinkSync(outside, path.join(root, "linked"), "dir");

  assert.throws(() => publishFileDurableExclusive(root, "linked/result.md", "verified\n"), /symlink/u);
  assert.equal(fs.existsSync(path.join(outside, "result.md")), false);
});

test("validated artifact publication falls back to an exclusive durable write when hard links are unsupported", () => {
  const root = tempProject();
  const expected = "verified artifact on a no-link volume\n";
  const originalLinkSync = fs.linkSync;
  fs.linkSync = (() => {
    throw Object.assign(new Error("hard links are unsupported"), { code: "EPERM" });
  }) as typeof fs.linkSync;
  try {
    const first = publishFileDurableExclusive(root, "nested/result.md", expected);
    const replay = publishFileDurableExclusive(root, "nested/result.md", expected);
    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(fs.readFileSync(first.path, "utf8"), expected);
    assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);
    assert.deepEqual(
      fs.readdirSync(path.dirname(first.path)).filter((entry) => entry.includes(".publish-")),
      []
    );
    assert.throws(
      () => publishFileDurableExclusive(root, "nested/result.md", "different artifact\n"),
      /different contents/u
    );
  } finally {
    fs.linkSync = originalLinkSync;
  }
});

test("validated artifact publication preserves a temporary-file close error without retrying the descriptor", () => {
  const root = tempProject();
  const originalCloseSync = fs.closeSync;
  let injected = false;
  fs.closeSync = ((fd) => {
    if (!injected) {
      injected = true;
      originalCloseSync(fd);
      throw Object.assign(new Error("injected close failure"), { code: "EIO" });
    }
    originalCloseSync(fd);
  }) as typeof fs.closeSync;

  try {
    assert.throws(
      () => publishFileDurableExclusive(root, "nested/result.md", "verified artifact\n"),
      (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === "EIO"
    );
  } finally {
    fs.closeSync = originalCloseSync;
  }
});

test("no-link artifact publication preserves a destination close error without retrying the descriptor", () => {
  const root = tempProject();
  const destination = path.join(root, "nested", "result.md");
  const originalCloseSync = fs.closeSync;
  const originalLinkSync = fs.linkSync;
  let closeCalls = 0;
  fs.linkSync = (() => {
    throw Object.assign(new Error("hard links are unsupported"), { code: "EPERM" });
  }) as typeof fs.linkSync;
  fs.closeSync = ((fd) => {
    closeCalls += 1;
    if (closeCalls === 2) {
      originalCloseSync(fd);
      throw Object.assign(new Error("injected close failure"), { code: "EIO" });
    }
    originalCloseSync(fd);
  }) as typeof fs.closeSync;

  try {
    assert.throws(
      () => publishFileDurableExclusive(root, "nested/result.md", "verified artifact\n"),
      (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === "EIO"
    );
    assert.equal(fs.existsSync(destination), false);
  } finally {
    fs.closeSync = originalCloseSync;
    fs.linkSync = originalLinkSync;
  }
});

test("failed publication cleanup detects a canonical-path replacement before accepting the unlink", () => {
  const root = tempProject();
  const destination = path.join(root, "nested", "result.md");
  const displaced = path.join(root, "nested", "displaced-result.md");
  const replacement = "concurrent publisher artifact\n";
  const originalFsyncSync = fs.fsyncSync;
  const originalLinkSync = fs.linkSync;
  const originalUnlinkSync = fs.unlinkSync;
  let fsyncCalls = 0;

  fs.linkSync = (() => {
    throw Object.assign(new Error("hard links are unsupported"), { code: "EPERM" });
  }) as typeof fs.linkSync;
  fs.fsyncSync = ((fd) => {
    fsyncCalls += 1;
    if (fsyncCalls === 2) {
      throw Object.assign(new Error("injected fsync failure"), { code: "EIO" });
    }
    originalFsyncSync(fd);
  }) as typeof fs.fsyncSync;
  fs.unlinkSync = ((filePath) => {
    if (filePath === destination) {
      fs.renameSync(destination, displaced);
      fs.writeFileSync(destination, replacement);
      originalUnlinkSync(destination);
      fs.writeFileSync(destination, replacement);
      return;
    }
    originalUnlinkSync(filePath);
  }) as typeof fs.unlinkSync;

  try {
    assert.throws(
      () => publishFileDurableExclusive(root, "nested/result.md", "verified artifact\n"),
      /failed to remove an incomplete published artifact/u
    );
    assert.equal(fs.readFileSync(destination, "utf8"), replacement);
  } finally {
    fs.fsyncSync = originalFsyncSync;
    fs.linkSync = originalLinkSync;
    fs.unlinkSync = originalUnlinkSync;
  }
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

test("artifact manifest reuse checks the complete prerequisite chain", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-causal-chain" });
  writeArtifact(layout, "ancestor", "result.md", "first\n");
  writeArtifactManifest({ layout, nodeId: "ancestor", createdAt: "2026-07-18T00:00:00.000Z" });
  writeArtifact(layout, "middle", "result.md", "second\n");
  writeArtifactManifest({
    layout,
    nodeId: "middle",
    prerequisiteNodeIds: ["ancestor"],
    createdAt: "2026-07-18T00:00:01.000Z"
  });
  writeArtifact(layout, "descendant", "result.md", "third\n");
  writeArtifactManifest({
    layout,
    nodeId: "descendant",
    prerequisiteNodeIds: ["middle"],
    createdAt: "2026-07-18T00:00:02.000Z"
  });

  writeArtifact(layout, "ancestor", "result.md", "changed\n");
  writeArtifactManifest({ layout, nodeId: "ancestor", createdAt: "2026-07-18T00:00:03.000Z" });
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

test("event indexes encode long IDs in a collision-free hash namespace", () => {
  const maximumRunId = "r".repeat(128);
  const layout = createRunLayout({ projectRoot: tempProject(), runId: maximumRunId });
  const facadeBeforeAppend = readEventQueryFacade(layout);
  const secondMaximumRunId = `${"r".repeat(127)}s`;
  const directBoundaryRunId = "d".repeat(122);
  const longBoundaryEventType = "e".repeat(123);
  const maximumEventType = "t".repeat(128);
  const maximumNodeId = "n".repeat(128);
  const maximumStatus = "s".repeat(128);
  const legacyCollisionRunId = `${maximumRunId.slice(0, 97)}-${crypto
    .createHash("sha256")
    .update(maximumRunId, "utf8")
    .digest("hex")
    .slice(0, 24)}`;
  assert.equal(legacyCollisionRunId.length, 122);

  appendEvent(layout, {
    eventType: maximumEventType,
    nodeId: maximumNodeId,
    status: maximumStatus,
    payload: { id: "maximum" }
  });
  appendEvent(layout, {
    runId: secondMaximumRunId,
    eventType: longBoundaryEventType,
    nodeId: "direct-node",
    status: "direct-status",
    payload: { id: "second-maximum" }
  });
  appendEvent(layout, {
    runId: legacyCollisionRunId,
    eventType: "direct-event",
    payload: { id: "legacy-collision" }
  });
  appendEvent(layout, {
    runId: directBoundaryRunId,
    eventType: "boundary-event",
    payload: { id: "direct-boundary" }
  });

  const hashedIndexPath = (dimension: string, value: string): string =>
    path.join(
      layout.eventsIndexDir,
      dimension,
      "sha256",
      `${crypto.createHash("sha256").update(value, "utf8").digest("hex")}.jsonl`
    );
  const maximumRunIndex = hashedIndexPath("run", maximumRunId);
  const secondMaximumRunIndex = hashedIndexPath("run", secondMaximumRunId);
  assert.equal(fs.existsSync(maximumRunIndex), true);
  assert.equal(fs.existsSync(secondMaximumRunIndex), true);
  assert.notEqual(maximumRunIndex, secondMaximumRunIndex);
  assert.equal(fs.existsSync(path.join(layout.eventsIndexDir, "run", `${legacyCollisionRunId}.jsonl`)), true);
  assert.equal(fs.existsSync(path.join(layout.eventsIndexDir, "run", `${directBoundaryRunId}.jsonl`)), true);
  assert.equal(fs.existsSync(hashedIndexPath("type", longBoundaryEventType)), true);
  assert.equal(fs.existsSync(hashedIndexPath("type", maximumEventType)), true);
  assert.equal(fs.existsSync(hashedIndexPath("node", maximumNodeId)), true);
  assert.equal(fs.existsSync(hashedIndexPath("status", maximumStatus)), true);

  const maximumRecord = JSON.parse(fs.readFileSync(maximumRunIndex, "utf8")) as { run_id: string };
  assert.equal(maximumRecord.run_id, maximumRunId);
  const facadeAfterAppend = readEventQueryFacade(layout) as {
    filters?: unknown;
    long_filters?: unknown;
    index_key_encoding?: unknown;
  };
  assert.deepEqual(facadeAfterAppend, facadeBeforeAppend);
  assert.deepEqual(facadeAfterAppend.filters, {
    run_id: "events.index/run/<run-id>.jsonl",
    node_id: "events.index/node/<node-id>.jsonl",
    event_type: "events.index/type/<event-type>.jsonl",
    status: "events.index/status/<status>.jsonl",
    timestamp: "events.index/timestamp/<yyyy-mm-dd>.jsonl"
  });
  assert.deepEqual(facadeAfterAppend.long_filters, {
    run_id: "events.index/run/sha256/<sha256-hex(run-id)>.jsonl",
    node_id: "events.index/node/sha256/<sha256-hex(node-id)>.jsonl",
    event_type: "events.index/type/sha256/<sha256-hex(event-type)>.jsonl",
    status: "events.index/status/sha256/<sha256-hex(status)>.jsonl"
  });
  assert.deepEqual(facadeAfterAppend.index_key_encoding, {
    version: "1",
    direct_max_id_length: 122,
    direct_id_path: "<dimension>/<id>.jsonl",
    long_id_path: "<dimension>/sha256/<sha256-hex(id)>.jsonl",
    digest: "sha256",
    hash_input_encoding: "utf8",
    digest_encoding: "hex"
  });
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

test("updateNodeState accepts an explicit transition timestamp", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-state-clock" });
  const initial = readRunState(layout);
  initial.nodes["node-a"] = {
    node_id: "node-a",
    status: "pending",
    retry_count: 0,
    timed_out: false
  };
  writeRunState(layout, initial);

  updateNodeState(layout, "node-a", { status: "running" }, "2026-01-01T00:00:05.000Z");
  const running = readRunState(layout);

  assert.equal(running.last_transition_at, "2026-01-01T00:00:05.000Z");
  assert.equal(running.nodes["node-a"]?.wait_since, "2026-01-01T00:00:05.000Z");
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

test("findings normalize the house-style schema_version alias to the canonical literal", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-1" });
  const nodeDir = getNodeArtifactDir(layout, "stateful-invariant-campaign", { create: true });
  fs.writeFileSync(
    path.join(nodeDir, "findings.json"),
    JSON.stringify([
      {
        schema_version: "ultrafuzz.finding.v1",
        id: "failure-1",
        title: "Harness drawn-rate sync assertion ignores elapsed-time precondition",
        status: "confirmed",
        severity_guess: "low",
        confidence: "high",
        summary: "The stored drawn rate lags the recalculated one after time advances."
      }
    ])
  );

  const report = normalizeFindings({ artifactDir: nodeDir, nodeId: "stateful-invariant-campaign" });

  assert.equal(report.count, 1);
  assert.equal(report.findings[0]!.schema_version, "1.0");
  assert.equal(report.findings[0]!.id, "failure-1");
  assert.equal(readFindings(nodeDir)[0]!.schema_version, "1.0", "the alias is rewritten on disk, not preserved");

  fs.writeFileSync(
    path.join(nodeDir, "findings.json"),
    JSON.stringify([{ schema_version: "ultrafuzz.finding.v2", id: "failure-1", title: "t", status: "confirmed" }])
  );
  assert.throws(
    () => normalizeFindings({ artifactDir: nodeDir, nodeId: "stateful-invariant-campaign" }),
    /unsupported schema_version/u
  );
});

test("findings that omit schema_version normalize to the canonical literal", () => {
  // The contract no longer requires the field, so the normalizer is what makes every finding on disk
  // carry the same version regardless of whether the producer wrote one.
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-1" });
  const nodeDir = getNodeArtifactDir(layout, "stateful-invariant-campaign", { create: true });
  fs.writeFileSync(
    path.join(nodeDir, "findings.json"),
    JSON.stringify([
      {
        id: "failure-1",
        title: "Harness drawn-rate sync assertion ignores elapsed-time precondition",
        status: "confirmed",
        severity_guess: "low",
        confidence: "high",
        summary: "The stored drawn rate lags the recalculated one after time advances."
      }
    ])
  );

  const report = normalizeFindings({ artifactDir: nodeDir, nodeId: "stateful-invariant-campaign" });

  assert.equal(report.count, 1);
  assert.equal(report.findings[0]!.schema_version, "1.0");
  assert.equal(readFindings(nodeDir)[0]!.schema_version, "1.0", "an absent version is filled in on disk");
});

test("findings normalize bounded numeric confidence to its canonical string representation", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-1" });
  const nodeDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  fs.writeFileSync(
    path.join(nodeDir, "findings.json"),
    JSON.stringify([
      {
        title: "Numeric confidence issue",
        status: "candidate",
        severity_guess: "medium",
        confidence: 0.85,
        summary: "The agent emitted a bounded numeric confidence."
      }
    ])
  );

  const report = normalizeFindings({ artifactDir: nodeDir, nodeId: "strategy-a" });

  assert.equal(report.findings[0]!.confidence, "0.85");
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
        title: "Source range-backed issue",
        status: "candidate",
        severity_guess: "medium",
        confidence: "medium",
        summary: "A source line range anchors the issue.",
        evidence: [{ kind: "source", path: "PoolLens.sol:248-274" }]
      }
    ])
  );

  const rangeReport = normalizeFindings({ artifactDir: nodeDir, nodeId: "strategy-a" });

  assert.deepEqual(rangeReport.findings[0]!.evidence, [
    { kind: "source", path: "PoolLens.sol", line: 248, end_line: 274 }
  ]);

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

test("findings normalize scalar lists and affected-file line references", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-1" });
  const nodeDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  fs.writeFileSync(
    path.join(nodeDir, "findings.json"),
    JSON.stringify([
      {
        title: "Line-referenced metadata",
        status: "candidate",
        severity_guess: "medium",
        confidence: "medium",
        summary: "Legacy metadata includes source locations in path-only fields.",
        affected_files: "src/Oracle.sol:42:7",
        affected_functions: "quote",
        patch_refs: ["test/Oracle.t.sol#L10-L18", "src/Pool.sol:21-24"],
        property_ids: "prop-1",
        notes: "normalized"
      }
    ])
  );

  const report = normalizeFindings({ artifactDir: nodeDir, nodeId: "strategy-a" });

  assert.deepEqual(report.findings[0]!.affected_files, ["src/Oracle.sol"]);
  assert.deepEqual(report.findings[0]!.affected_functions, ["quote"]);
  assert.deepEqual(report.findings[0]!.patch_refs, ["test/Oracle.t.sol", "src/Pool.sol"]);
  assert.deepEqual(report.findings[0]!.property_ids, ["prop-1"]);
  assert.deepEqual(report.findings[0]!.notes, ["normalized"]);
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

test("generated-test manifest writer rejects zero-byte companion files", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-empty-generated-test" });

  assert.throws(
    () =>
      writeGeneratedTestManifest({
        layout,
        nodeId: "strategy-a",
        tests: [{ path: "generated-tests/Empty.t.sol", content: "" }]
      }),
    /generated test file must be non-empty/u
  );
  assert.equal(fs.existsSync(path.join(getNodeArtifactDir(layout, "strategy-a"), "generated-tests.json")), false);
});

test("generated-test manifest writer rejects final symlinks without touching outside files", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-symlinked-generated-test" });
  const nodeDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  const generatedTestsDir = path.join(nodeDir, "generated-tests");
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  const outsideDir = tempProject();
  const outsideFile = path.join(outsideDir, "Outside.t.sol");
  fs.writeFileSync(outsideFile, "outside sentinel\n");
  const symlinkPath = path.join(generatedTestsDir, "Linked.t.sol");
  fs.symlinkSync(outsideFile, symlinkPath);

  assert.throws(
    () =>
      writeGeneratedTestManifest({
        layout,
        nodeId: "strategy-a",
        tests: [{ path: "generated-tests/Linked.t.sol", content: "replacement\n" }]
      }),
    /symlink/u
  );
  assert.equal(fs.lstatSync(symlinkPath).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(outsideFile, "utf8"), "outside sentinel\n");
  assert.equal(fs.existsSync(path.join(nodeDir, "generated-tests.json")), false);
});

test("generated-test manifest writer rejects broken final symlinks before writing content", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-broken-symlink-generated-test" });
  const nodeDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  const generatedTestsDir = path.join(nodeDir, "generated-tests");
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  const missingOutsideFile = path.join(tempProject(), "Missing.t.sol");
  const symlinkPath = path.join(generatedTestsDir, "Broken.t.sol");
  fs.symlinkSync(missingOutsideFile, symlinkPath);

  assert.throws(
    () =>
      writeGeneratedTestManifest({
        layout,
        nodeId: "strategy-a",
        tests: [{ path: "generated-tests/Broken.t.sol", content: "replacement\n" }]
      }),
    /symlink/u
  );
  assert.equal(fs.lstatSync(symlinkPath).isSymbolicLink(), true);
  assert.equal(fs.existsSync(missingOutsideFile), false);
});

test("generated-test manifest writer rejects paths outside the generated-tests root", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-outside-generated-test" });

  assert.throws(
    () =>
      writeGeneratedTestManifest({
        layout,
        nodeId: "strategy-a",
        tests: [{ path: "generated-tests/../../Outside.t.sol", content: "outside\n" }]
      }),
    /cannot traverse outside/u
  );
  assert.equal(fs.existsSync(path.join(layout.artifactsDir, "Outside.t.sol")), false);
});
