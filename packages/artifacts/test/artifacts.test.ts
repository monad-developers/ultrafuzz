import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  appendUsageEvents,
  appendNodeAttempt,
  appendEvent,
  appendBytesDurable,
  appendBytesDurableAt,
  appendLineDurable,
  appendEventRecord,
  createEventRecord,
  createRunLayout,
  ensureEventRecord,
  ensureEventRecords,
  getNodeArtifactDir,
  normalizeFindings,
  normalizeSafeRelativePath,
  manifestDigest,
  publishFileDurableExclusive,
  queryNodeAttempts,
  queryEvents,
  readEventQueryFacade,
  readFindings,
  readRunState,
  repairTornJsonlTail,
  replayEvents,
  replayUsageEvents,
  safeResolveInside,
  summarizeNodeAttempts,
  truncateDurable,
  updateNodeState,
  verifyArtifactManifestPrerequisites,
  writeArtifact,
  writeArtifactManifest,
  writeGeneratedTestManifest,
  writeJsonDurable,
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
    failureCategory: "executor-error" as const
  };

  const first = appendNodeAttempt(layout, firstInput);
  const replayedFirst = appendNodeAttempt(layout, firstInput);
  assert.equal(first.appended, true);
  assert.equal(replayedFirst.appended, false);
  assert.equal(replayedFirst.entry.attempt_id, first.entry.attempt_id);

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
    failureCategory: undefined
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
    failureCategory: undefined
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

test("event recovery repairs every missing index without duplicating the authoritative record", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-event-recovery" });
  const record = createEventRecord(layout, {
    eventType: "node-synced",
    nodeId: "node-a",
    status: "succeeded",
    timestamp: "2026-08-04T00:00:00.000Z",
    payload: { recovered: true }
  });
  ensureEventRecord(layout, record);
  const nodeIndex = path.join(layout.eventsIndexDir, "node", "node-a.jsonl");
  fs.rmSync(nodeIndex);

  ensureEventRecord(layout, record);
  ensureEventRecord(layout, record);

  for (const filePath of [
    layout.eventsPath,
    path.join(layout.eventsIndexDir, "run", "run-event-recovery.jsonl"),
    path.join(layout.eventsIndexDir, "type", "node-synced.jsonl"),
    path.join(layout.eventsIndexDir, "timestamp", "2026-08-04.jsonl"),
    nodeIndex,
    path.join(layout.eventsIndexDir, "status", "succeeded.jsonl")
  ]) {
    const matches = fs
      .readFileSync(filePath, "utf8")
      .trim()
      .split(/\r?\n/u)
      .filter((line) => (JSON.parse(line) as { event_id?: string }).event_id === record.event_id);
    assert.equal(matches.length, 1, filePath);
  }
});

test("durable byte appends retry short writes until the complete payload is persisted", () => {
  const root = tempProject();
  const filePath = path.join(root, "short-writes.jsonl");
  const originalDescriptor = Object.getOwnPropertyDescriptor(fs, "writeSync");
  if (originalDescriptor === undefined) throw new Error("fs.writeSync descriptor is unavailable");
  const originalWriteSync = fs.writeSync;
  let calls = 0;
  Object.defineProperty(fs, "writeSync", {
    ...originalDescriptor,
    value(fd: number, buffer: Uint8Array, offset: number, length: number): number {
      calls += 1;
      return originalWriteSync(fd, buffer, offset, Math.min(length, 3));
    }
  });
  try {
    appendBytesDurable(filePath, Buffer.from("complete append despite short writes\n", "utf8"), root);
  } finally {
    Object.defineProperty(fs, "writeSync", originalDescriptor);
  }

  assert.equal(fs.readFileSync(filePath, "utf8"), "complete append despite short writes\n");
  assert.ok(calls > 1);
});

test("event recovery repairs an exact truncated record in the log and every derived index", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-event-tail-recovery" });
  const record = createEventRecord(layout, {
    eventType: "node-synced",
    nodeId: "node-a",
    status: "succeeded",
    timestamp: "2026-08-05T00:00:00.000Z",
    payload: { recovered: true }
  });
  ensureEventRecord(layout, record);
  const serialized = JSON.stringify(record);
  const recordPaths = [
    layout.eventsPath,
    path.join(layout.eventsIndexDir, "run", "run-event-tail-recovery.jsonl"),
    path.join(layout.eventsIndexDir, "type", "node-synced.jsonl"),
    path.join(layout.eventsIndexDir, "timestamp", "2026-08-05.jsonl"),
    path.join(layout.eventsIndexDir, "node", "node-a.jsonl"),
    path.join(layout.eventsIndexDir, "status", "succeeded.jsonl")
  ];

  for (const filePath of recordPaths) {
    fs.writeFileSync(filePath, serialized.slice(0, -7), "utf8");
    ensureEventRecord(layout, record);
    assert.equal(fs.readFileSync(filePath, "utf8"), `${serialized}\n`, filePath);
  }
});

test("event batch recovery repairs a torn second record in the log and every shared index", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-event-batch-tail-recovery" });
  const first = createEventRecord(layout, {
    eventType: "node-synced",
    nodeId: "node-a",
    status: "succeeded",
    timestamp: "2026-08-05T00:00:00.000Z",
    payload: { sequence: 1 }
  });
  const second = createEventRecord(layout, {
    eventType: "node-synced",
    nodeId: "node-a",
    status: "succeeded",
    timestamp: "2026-08-05T00:00:01.000Z",
    payload: { sequence: 2 }
  });
  ensureEventRecords(layout, [first, second]);
  const firstSerialized = JSON.stringify(first);
  const secondSerialized = JSON.stringify(second);
  const recordPaths = [
    layout.eventsPath,
    path.join(layout.eventsIndexDir, "run", "run-event-batch-tail-recovery.jsonl"),
    path.join(layout.eventsIndexDir, "type", "node-synced.jsonl"),
    path.join(layout.eventsIndexDir, "timestamp", "2026-08-05.jsonl"),
    path.join(layout.eventsIndexDir, "node", "node-a.jsonl"),
    path.join(layout.eventsIndexDir, "status", "succeeded.jsonl")
  ];

  for (const filePath of recordPaths) {
    fs.writeFileSync(filePath, `${firstSerialized}\n${secondSerialized.slice(0, -7)}`, "utf8");
    ensureEventRecords(layout, [first, second]);
    assert.equal(fs.readFileSync(filePath, "utf8"), `${firstSerialized}\n${secondSerialized}\n`, filePath);
  }
});

test("event recovery fails closed on integrity violations and repairs torn tails", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-event-tail-rejection" });
  const record = createEventRecord(layout, {
    eventType: "node-synced",
    nodeId: "node-a",
    status: "succeeded",
    timestamp: "2026-08-05T00:00:00.000Z",
    payload: { recovered: true }
  });
  const unrelated = JSON.stringify({ ...record, event_id: "evt-unrelated" });
  const conflicting = JSON.stringify({ ...record, payload: { recovered: false } });
  const serialized = JSON.stringify(record);

  // A record whose ID is already present with different content is a genuine
  // integrity violation: fail closed and leave the log byte-identical.
  for (const testCase of [{ name: "conflicting event ID", contents: conflicting, expected: /conflicting event ID/u }]) {
    fs.writeFileSync(layout.eventsPath, testCase.contents, "utf8");
    assert.throws(() => ensureEventRecord(layout, record), testCase.expected, testCase.name);
    assert.equal(fs.readFileSync(layout.eventsPath, "utf8"), testCase.contents, testCase.name);
  }

  // An unparseable COMPLETED line is not an integrity violation and must not fail
  // closed. It is the fused remains of a torn append, it can never match any expected
  // record, and `replayEvents` already skips it. Refusing would wedge the run: the
  // trailing-tail repair cannot reach an interior line, so cancel, pause and every
  // guarded mutation would throw forever with no repair path.
  fs.writeFileSync(layout.eventsPath, "{malformed\n", "utf8");
  ensureEventRecord(layout, record);
  assert.equal(fs.readFileSync(layout.eventsPath, "utf8"), `{malformed\n${serialized}\n`);

  // A record already durably present AND duplicated as the unterminated tail: the tail
  // was never a durable line, so it is discarded rather than committed a second time.
  // Refusing instead would wedge every later guarded operation on the run.
  fs.writeFileSync(layout.eventsPath, `${serialized}\n${serialized}`, "utf8");
  ensureEventRecord(layout, record);
  assert.equal(fs.readFileSync(layout.eventsPath, "utf8"), `${serialized}\n`);

  // An ordering fault recovers the same way: a two-record batch with neither durable,
  // where the tail is the SECOND record. The torn copy is dropped and the batch is
  // appended in order.
  const laterRecord = createEventRecord(layout, {
    eventType: "node-synced",
    nodeId: "node-b",
    status: "succeeded",
    timestamp: "2026-08-05T00:00:01.000Z",
    payload: { recovered: true }
  });
  const laterSerialized = JSON.stringify(laterRecord);
  fs.writeFileSync(layout.eventsPath, laterSerialized, "utf8");
  ensureEventRecords(layout, [record, laterRecord]);
  assert.equal(fs.readFileSync(layout.eventsPath, "utf8"), `${serialized}\n${laterSerialized}\n`);

  // An unterminated trailing line, by contrast, is the signature of a process that
  // died mid-append. Recovery must proceed, because refusing would make every
  // guarded lifecycle operation on the run — including cancel — impossible forever.
  // Each case asserts exact bytes, so the restored trailing newline is covered too.

  // A complete record that only lost its newline is preserved and terminated.
  fs.writeFileSync(layout.eventsPath, unrelated, "utf8");
  ensureEventRecord(layout, record);
  assert.equal(fs.readFileSync(layout.eventsPath, "utf8"), `${unrelated}\n${serialized}\n`);

  // A torn fragment was never a durable line, so it is discarded.
  fs.writeFileSync(layout.eventsPath, unrelated.slice(0, -7), "utf8");
  ensureEventRecord(layout, record);
  assert.equal(fs.readFileSync(layout.eventsPath, "utf8"), `${serialized}\n`);

  // A tail that parses but is not a record at all is treated as a torn fragment
  // rather than committed, so no consumer ever receives a shapeless "record".
  for (const scalarTail of ["null", "42", '"text"', "[]"]) {
    fs.writeFileSync(layout.eventsPath, scalarTail, "utf8");
    ensureEventRecord(layout, record);
    assert.equal(fs.readFileSync(layout.eventsPath, "utf8"), `${serialized}\n`, scalarTail);
  }

  // A torn fragment that is a prefix of the record being recovered is completed
  // rather than discarded, and never duplicated.
  fs.writeFileSync(layout.eventsPath, serialized.slice(0, 20), "utf8");
  ensureEventRecord(layout, record);
  assert.equal(fs.readFileSync(layout.eventsPath, "utf8"), `${serialized}\n`);
  ensureEventRecord(layout, record);
  assert.equal(fs.readFileSync(layout.eventsPath, "utf8"), `${serialized}\n`);
});

test("torn-tail repair refuses to act when the file changed since it was read", () => {
  const project = tempProject();
  const filePath = path.join(project, "events.jsonl");
  fs.writeFileSync(filePath, "first\nsecond", "utf8");
  const observedSize = fs.statSync(filePath).size;

  // A repair decides what to write from a read that already happened. If another
  // writer appended in between, both the truncation and the newline termination must
  // refuse rather than destroy or concatenate that writer's durable record.
  fs.appendFileSync(filePath, "-raced\n", "utf8");
  assert.throws(() => truncateDurable(filePath, 6, { expectedSize: observedSize }), /changed size before truncation/u);
  assert.throws(
    () => appendBytesDurableAt(filePath, Buffer.from("\n"), { expectedSize: observedSize }),
    /changed size before repair/u
  );
  assert.equal(fs.readFileSync(filePath, "utf8"), "first\nsecond-raced\n");

  // With the size unchanged both succeed and write at exactly that offset.
  const currentSize = fs.statSync(filePath).size;
  appendBytesDurableAt(filePath, Buffer.from("tail"), { expectedSize: currentSize });
  assert.equal(fs.readFileSync(filePath, "utf8"), "first\nsecond-raced\ntail");
  truncateDurable(filePath, currentSize, { expectedSize: currentSize + 4 });
  assert.equal(fs.readFileSync(filePath, "utf8"), "first\nsecond-raced\n");
});

test("durable repair rejects hard links and out-of-range lengths", () => {
  const project = tempProject();
  const filePath = path.join(project, "events.jsonl");
  fs.writeFileSync(filePath, "line\n", "utf8");
  const size = fs.statSync(filePath).size;

  assert.throws(() => truncateDurable(filePath, size + 1, { expectedSize: size }), /exceeds the file size/u);

  const linkPath = path.join(project, "events-link.jsonl");
  fs.linkSync(filePath, linkPath);
  assert.throws(() => truncateDurable(filePath, 0, { expectedSize: size }), /must not be hard-linked/u);
  assert.throws(
    () => appendBytesDurableAt(filePath, Buffer.from("x"), { expectedSize: size }),
    /must not be hard-linked/u
  );
  assert.equal(fs.readFileSync(filePath, "utf8"), "line\n");
});

test("a failed durable write leaves no temp file beside its destination", () => {
  const project = tempProject();
  const directory = path.join(project, "lock-directory");
  fs.mkdirSync(directory);
  const target = path.join(directory, "owner.json");
  const originalWriteFileSync = fs.writeFileSync;
  // A temp file stranded inside a lock directory keeps that directory non-empty
  // forever, which blocks every form of lock reclamation.
  Object.defineProperty(fs, "writeFileSync", {
    configurable: true,
    writable: true,
    value: () => {
      throw new Error("simulated write failure");
    }
  });
  try {
    assert.throws(() => writeJsonDurable(target, { pid: 1 }), /simulated write failure/u);
  } finally {
    Object.defineProperty(fs, "writeFileSync", {
      configurable: true,
      writable: true,
      value: originalWriteFileSync
    });
  }
  assert.deepEqual(fs.readdirSync(directory), []);
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

test("a torn append cannot fuse into an interior line and wedge every later guarded operation", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-event-torn-fusion" });
  const first = createEventRecord(layout, {
    eventType: "node-synced",
    nodeId: "node-a",
    status: "succeeded",
    timestamp: "2026-08-05T00:00:00.000Z",
    payload: { step: 1 }
  });
  const serializedFirst = JSON.stringify(first);

  // A process killed mid-append leaves an unterminated fragment after a durable line.
  fs.writeFileSync(layout.eventsPath, `${serializedFirst}\n{"event_id":"evt-tor`, "utf8");

  // Appending must not concatenate the new record onto that fragment. Before the fix
  // the two fused into one unparseable line in the log INTERIOR, which the
  // trailing-tail repair can never see because it only inspects bytes after the last
  // newline.
  const second = createEventRecord(layout, {
    eventType: "node-synced",
    nodeId: "node-b",
    status: "succeeded",
    timestamp: "2026-08-05T00:00:01.000Z",
    payload: { step: 2 }
  });
  appendEventRecord(layout.eventsPath, second);

  const lines = fs.readFileSync(layout.eventsPath, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line), `every line must remain parseable: ${line}`);
  }
  assert.equal(lines.length, 2);
  assert.equal(lines[0], serializedFirst);
  assert.deepEqual((JSON.parse(lines[1]!) as { event_id: string }).event_id, second.event_id);

  // The torn fragment was never a durable line, so discarding it loses nothing, and
  // the durable record before it survives untouched.
  assert.equal(replayEvents(layout).malformedRecords, 0);

  // The run remains operable: exactly-once recovery still works afterwards.
  ensureEventRecord(layout, second);
  assert.equal(fs.readFileSync(layout.eventsPath, "utf8").split("\n").filter(Boolean).length, 2);
});

test("an interior line that is already fused does not permanently wedge exactly-once recovery", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-event-interior-fused" });
  const record = createEventRecord(layout, {
    eventType: "node-synced",
    nodeId: "node-a",
    status: "succeeded",
    timestamp: "2026-08-05T00:00:00.000Z",
    payload: { recovered: true }
  });
  const serialized = JSON.stringify(record);

  // A log already in the fused state from before the append-path fix. Recovery must
  // still be able to make progress rather than throwing forever.
  fs.writeFileSync(layout.eventsPath, `{"event_id":"evt-torn{"fused":true}\n`, "utf8");
  ensureEventRecord(layout, record);

  const contents = fs.readFileSync(layout.eventsPath, "utf8");
  assert.ok(contents.endsWith(`${serialized}\n`), "the missing record is appended");
  // The unparseable line is left alone rather than silently rewritten; it is simply
  // skipped, exactly as replayEvents already does.
  assert.equal(replayEvents(layout).malformedRecords, 1);
});

test("a torn index append cannot bury a record from every index reader", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-index-torn" });
  const first = appendEvent(layout, {
    eventType: "node-synced",
    nodeId: "node-a",
    status: "succeeded",
    timestamp: "2026-08-05T00:00:00.000Z",
    payload: { step: 1 }
  });

  // Tear the run-dimension index the way a killed process would.
  const indexPath = path.join(layout.eventsIndexDir, "run", `${layout.runId}.jsonl`);
  fs.appendFileSync(indexPath, '{"event_id":"evt-tor', "utf8");

  const second = appendEvent(layout, {
    eventType: "node-synced",
    nodeId: "node-b",
    status: "succeeded",
    timestamp: "2026-08-05T00:00:01.000Z",
    payload: { step: 2 }
  });

  // Every index line must stay parseable. Before the repair covered index appends, the
  // fragment and the new record fused into one unparseable interior line, which buried
  // the second record from every index reader and made a later ensureEventRecords
  // append a duplicate copy of it.
  const lines = fs.readFileSync(indexPath, "utf8").split("\n").filter(Boolean);
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line), `unparseable index line: ${line}`);
  const ids = lines.map((line) => (JSON.parse(line) as { event_id: string }).event_id);
  assert.deepEqual(ids, [first.event_id, second.event_id]);

  // Recovery must not then add a second copy.
  ensureEventRecords(layout, [first, second]);
  const after = fs.readFileSync(indexPath, "utf8").split("\n").filter(Boolean);
  assert.deepEqual(
    after.map((line) => (JSON.parse(line) as { event_id: string }).event_id),
    [first.event_id, second.event_id]
  );
});

test("a complete record that only lost its newline is terminated, not discarded", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-event-terminate-branch" });
  const durable = createEventRecord(layout, {
    eventType: "node-synced",
    nodeId: "node-a",
    status: "succeeded",
    timestamp: "2026-08-05T00:00:00.000Z",
    payload: { step: 1 }
  });
  const unterminated = createEventRecord(layout, {
    eventType: "node-synced",
    nodeId: "node-b",
    status: "succeeded",
    timestamp: "2026-08-05T00:00:01.000Z",
    payload: { step: 2 }
  });
  // A fully-written record whose newline was lost. Discarding it would contradict both
  // the documented policy and ensureExactEventLines, which preserves exactly this case.
  // Without this test an "always truncate" repair passes the whole suite.
  fs.writeFileSync(layout.eventsPath, `${JSON.stringify(durable)}\n${JSON.stringify(unterminated)}`, "utf8");

  const next = createEventRecord(layout, {
    eventType: "node-synced",
    nodeId: "node-c",
    status: "succeeded",
    timestamp: "2026-08-05T00:00:02.000Z",
    payload: { step: 3 }
  });
  appendEventRecord(layout.eventsPath, next);

  const ids = fs
    .readFileSync(layout.eventsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { event_id: string }).event_id);
  assert.deepEqual(ids, [durable.event_id, unterminated.event_id, next.event_id]);
  assert.equal(replayEvents(layout).malformedRecords, 0);
});

test("a duplicated event ID fails closed and leaves the log byte-identical", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-event-duplicate" });
  const record = createEventRecord(layout, {
    eventType: "node-synced",
    nodeId: "node-a",
    status: "succeeded",
    timestamp: "2026-08-05T00:00:00.000Z",
    payload: { step: 1 }
  });
  const serialized = JSON.stringify(record);
  const contents = `${serialized}\n${serialized}\n`;
  fs.writeFileSync(layout.eventsPath, contents, "utf8");

  // Two durable copies of one event ID is a genuine integrity violation, distinct from
  // unparseable debris: it must fail closed with its own message and must not rewrite
  // the log. Without this, both `duplicates event ID` branches can be deleted and the
  // suite stays green, degrading the outcome to a misleading persistence error.
  assert.throws(() => ensureEventRecord(layout, record), /duplicates event ID/u);
  assert.equal(fs.readFileSync(layout.eventsPath, "utf8"), contents);
});

test("a duplicated event ID fails closed without rewriting a torn log", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-event-duplicate-torn" });
  const record = createEventRecord(layout, {
    eventType: "node-synced",
    nodeId: "node-a",
    status: "succeeded",
    timestamp: "2026-08-05T00:00:00.000Z",
    payload: { step: 1 }
  });
  const serialized = JSON.stringify(record);
  // Two durable copies AND a torn tail. The pre-tail duplicate check is the
  // load-bearing one here: without it `nextMissing` is -1, the tail-repair block runs
  // first, and the log is mutated on a path documented as leaving it byte-identical.
  const contents = `${serialized}\n${serialized}\n{"event_id":"evt-tor`;
  fs.writeFileSync(layout.eventsPath, contents, "utf8");

  assert.throws(() => ensureEventRecord(layout, record), /duplicates event ID/u);
  assert.equal(fs.readFileSync(layout.eventsPath, "utf8"), contents, "the log must not be rewritten");
});

test("the torn-tail probe refuses a symlinked log and does not block on a FIFO", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-probe-hostile" });
  const record = createEventRecord(layout, {
    eventType: "node-synced",
    nodeId: "node-a",
    status: "succeeded",
    timestamp: "2026-08-05T00:00:00.000Z",
    payload: { step: 1 }
  });

  const outside = path.join(path.dirname(layout.eventsPath), "outside.jsonl");
  fs.writeFileSync(outside, "", "utf8");
  fs.rmSync(layout.eventsPath, { force: true });
  fs.symlinkSync(outside, layout.eventsPath);
  // Assert on the PROBE directly. Asserting only via appendEventRecord would re-pin
  // appendBytesDurable's own O_NOFOLLOW instead: the symlink target is empty, so a
  // probe without the flag opens it, sees size 0 and returns silently, and the ELOOP
  // arrives later from safe-paths -- leaving the probe's flag free to be dropped.
  assert.throws(() => repairTornJsonlTail(layout.eventsPath), /ELOOP/u);
  assert.throws(() => appendEventRecord(layout.eventsPath, record), /ELOOP|EMLINK|symbolic/u);
  assert.equal(fs.readFileSync(outside, "utf8"), "", "the symlink target must not be written through");
  fs.rmSync(layout.eventsPath);

  // A FIFO must not block the probe. This has to run OUT OF PROCESS: without
  // O_NONBLOCK the open blocks the thread inside fs.openSync, and a synchronous test
  // body never yields, so node:test's timer can never fire -- a declared `timeout` on
  // this test would be inert and the regression would surface as an unnamed job-level
  // hang rather than a failing test. execFileSync's own timeout does bound it.
  const fifo = path.join(path.dirname(layout.eventsPath), "index-fifo.jsonl");
  execFileSync("mkfifo", [fifo]);
  try {
    const moduleUrl = pathToFileURL(fileURLToPath(new URL("../src/index.js", import.meta.url))).href;
    assert.doesNotThrow(() =>
      execFileSync(
        process.execPath,
        ["-e", `import(${JSON.stringify(moduleUrl)}).then((m) => m.repairTornJsonlTail(process.argv[1]));`, fifo],
        { timeout: 15_000, stdio: "pipe" }
      )
    );
    assert.ok(fs.lstatSync(fifo).isFIFO(), "the FIFO must be left untouched");
  } finally {
    fs.rmSync(fifo, { force: true });
  }

  // A non-regular entry whose size is NON-zero is what makes the isFile() bail
  // decisive. A FIFO reports size 0, so with the bail deleted the size check still
  // returns first and the FIFO fixture alone leaves that mutation alive. A directory
  // reports a non-zero size, so without the bail this is EISDIR on every append.
  const directory = path.join(path.dirname(layout.eventsPath), "index-dir.jsonl");
  fs.mkdirSync(directory);
  try {
    assert.doesNotThrow(() => repairTornJsonlTail(directory));
  } finally {
    fs.rmdirSync(directory);
  }
});
