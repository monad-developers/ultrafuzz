import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ArtifactSecretGateError,
  ARTIFACT_MANIFEST_FILE,
  appendUsageEvents,
  assertArtifactPublicationsContainNoSecrets,
  assertPathInside,
  appendNodeAttempt,
  appendEvent,
  createEventRecord,
  assertUsageLedgerEntry,
  createRunLayout,
  getNodeArtifactDir,
  normalizeSafeRelativePath,
  manifestDigest,
  MAX_NODE_ATTEMPT_FAILURE_MESSAGE_BYTES,
  normalizeNodeAttemptFailureMessage,
  publishFileDurableExclusive,
  queryNodeAttempts,
  queryEvents,
  readArtifactManifest,
  readRunState,
  replayEvents,
  replayUsageEvents,
  safeResolveInside,
  sha256File,
  summarizeNodeAttempts,
  updateNodeState,
  validateArtifactManifest,
  validateArtifactVerificationMarker,
  verifyArtifactManifestPrerequisites,
  writeArtifact,
  writeArtifactManifest,
  writeRunState
} from "../src/index.js";

function tempProject(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ufz-artifacts-"));
}

test("createRunLayout persists product-owned run evidence outside checkpoints", () => {
  const project = tempProject();
  const layout = createRunLayout({
    projectRoot: project,
    runId: "run-1",
    sourceRunId: "run-0",
    resolvedConfigToml: '[run]\noutput_dir = ".ultrafuzz/runs"\n',
    configRedactions: {
      schemaVersion: "ultrafuzz.config-redactions.v2",
      placeholder: "<redacted>",
      entries: [
        {
          path: ["models", "profiles", "default", "model"],
          key: "models.profiles.default.model",
          reason: "sensitive-value",
          restoreFrom: "current-config",
          requiredForWorkflowLaunch: true,
          requiredForWorkflowSubmission: true
        }
      ]
    },
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
    layout.attemptLedgerPath
  ]) {
    assert.equal(fs.existsSync(expected), true, expected);
  }
  for (const expected of [layout.artifactsDir, layout.reviewDir]) {
    assert.equal(fs.statSync(expected).isDirectory(), true, expected);
  }
  assert.equal(path.basename(getNodeArtifactDir(layout, "node-a", { create: true })), "node-a");
});

test("validated usage events append idempotently with exact Smithers identities", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-usage" });
  const generated = {
    workflowRunId: "workflow-run-usage",
    controlGeneration: "a".repeat(64),
    sourceEventSequence: 7,
    observedTimestampMs: Date.parse("2026-07-18T00:00:00.000Z"),
    nodeId: "node-a",
    iteration: 0,
    attempt: 1,
    usage: { input_tokens: 12, output_tokens: 3, model: "generated-model", agent: "generated-agent" }
  };

  const first = appendUsageEvents(layout, [generated]);
  const replayed = appendUsageEvents(layout, [generated]);
  const ledger = replayUsageEvents(layout);

  assert.equal(first.appended, 1);
  assert.equal(replayed.appended, 0);
  assert.deepEqual(replayed.entries[0], first.entries[0]);
  assert.equal(ledger.entries[0]?.source_event_sequence, 7);
  assert.equal(ledger.entries[0]?.control_generation, "a".repeat(64));
  assert.equal(ledger.entries.length, 1);

  fs.appendFileSync(layout.usageLedgerPath, "{malformed\n");
  assert.throws(() => replayUsageEvents(layout), /invalid strict JSON/u);
});

test("usage entries carry their required node_id and immutable source authority", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-usage-node-id" });
  const base = {
    workflowRunId: "workflow-run-usage",
    controlGeneration: "d".repeat(64),
    sourceEventSequence: 1,
    observedTimestampMs: Date.parse("2026-07-18T00:00:00.000Z"),
    nodeId: "node:dynamic-fanout-1",
    iteration: 0,
    attempt: 1,
    usage: { input_tokens: 12, output_tokens: 3, model: "model", agent: "agent" }
  };

  const written = appendUsageEvents(layout, [base]);
  assert.equal(written.entries[0]?.node_id, "node:dynamic-fanout-1");
  assert.equal(assertUsageLedgerEntry(JSON.parse(JSON.stringify(written.entries[0]))).node_id, base.nodeId);
  const resumed = appendUsageEvents(layout, [base]);
  assert.equal(resumed.appended, 0);
  assert.equal(replayUsageEvents(layout).entries.length, 1);
  assert.throws(
    () => appendUsageEvents(layout, [{ ...base, sourceEventSequence: 2, nodeId: "../escape" }]),
    /Invalid string/u
  );
});

test("usage ledger replay rejects entries copied from another run", () => {
  const project = tempProject();
  const firstLayout = createRunLayout({ projectRoot: project, runId: "run-usage-first" });
  const secondLayout = createRunLayout({ projectRoot: project, runId: "run-usage-second" });
  const input = {
    workflowRunId: "workflow-run-usage",
    controlGeneration: "b".repeat(64),
    sourceEventSequence: 1,
    observedTimestampMs: Date.parse("2026-07-18T00:00:00.000Z"),
    nodeId: "node-a",
    iteration: 0,
    attempt: 1,
    usage: { input_tokens: 1, output_tokens: 0, model: "model", agent: "agent" }
  };
  appendUsageEvents(firstLayout, [input]);
  appendUsageEvents(secondLayout, [input]);
  fs.appendFileSync(secondLayout.usageLedgerPath, fs.readFileSync(firstLayout.usageLedgerPath));

  assert.throws(() => replayUsageEvents(secondLayout), /run_id belongs to/u);
});

test("node attempt ledger is append-only, idempotent, independently queryable, and exactly summarized", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "attempt-ledger" });
  const inputDigest = manifestDigest("generated input manifest");
  const outputDigest = manifestDigest("generated output manifest");
  const firstInput = {
    workflowRunId: "workflow-run-attempts",
    controlGeneration: "c".repeat(64),
    nodeId: "strategy-a",
    strategyAttemptId: "strategy-a",
    iteration: 0,
    attempt: 1,
    startedEventSequence: 1,
    sourceEventSequence: 2,
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
  assert.deepEqual(replayedFirst.entry, first.entry);
  assert.equal(first.entry.failure_message, replayedFirst.entry.failure_message);
  assert.ok(Buffer.byteLength(first.entry.failure_message ?? "", "utf8") <= MAX_NODE_ATTEMPT_FAILURE_MESSAGE_BYTES);
  assert.match(first.entry.failure_message ?? "", /<redacted>/u);
  assert.doesNotMatch(first.entry.failure_message ?? "", /private-secret/u);

  const second = appendNodeAttempt(layout, {
    ...firstInput,
    attempt: 2,
    startedEventSequence: 3,
    sourceEventSequence: 4,
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
    attempt: 1,
    startedEventSequence: 5,
    sourceEventSequence: 6,
    startedAt: "2026-07-18T10:04:00.000Z",
    finishedAt: "2026-07-18T10:04:00.000Z",
    outcome: "reused",
    reuse: {
      status: "reused",
      sourceWorkflowRunId: second.entry.workflow_run_id,
      sourceEventSequence: second.entry.source_event_sequence
    },
    outputManifestDigest: outputDigest,
    failureCategory: undefined,
    failureMessage: undefined
  });

  assert.equal(queryNodeAttempts(layout, { workflowRunId: "workflow-run-attempts" }).length, 3);
  assert.equal(queryNodeAttempts(layout, { controlGeneration: "c".repeat(64) }).length, 3);
  assert.equal(queryNodeAttempts(layout, { sourceEventSequence: 4 }).length, 1);
  assert.equal(queryNodeAttempts(layout, { reuseStatus: "reused" })[0]?.reuse.status, "reused");

  const summary = summarizeNodeAttempts(queryNodeAttempts(layout));
  assert.deepEqual(summary, {
    total: 3,
    executed: 2,
    reused: 1,
    outcomes: { succeeded: 1, failed: 1, "timed-out": 0, canceled: 0, reused: 1 },
    strategy_attempts: 2,
    workflow_runs: 1,
    control_generations: 1
  });
  assert.equal(fs.readFileSync(layout.attemptLedgerPath, "utf8").trim().split("\n").length, 3);
  assert.equal(normalizeNodeAttemptFailureMessage("  first\nsecond  "), "first second");
});

function failedAttemptInput(id: string, failureMessage: string) {
  return {
    workflowRunId: `workflow-run-${id}`,
    controlGeneration: "d".repeat(64),
    nodeId: `strategy-${id}`,
    strategyAttemptId: `strategy-${id}`,
    iteration: 0,
    attempt: 1,
    startedEventSequence: 1,
    sourceEventSequence: 2,
    startedAt: "2026-07-18T11:00:00.000Z",
    finishedAt: "2026-07-18T11:01:00.000Z",
    outcome: "failed" as const,
    inputManifestDigest: manifestDigest(`${id} input manifest`),
    failureCategory: "executor-error" as const,
    failureMessage
  };
}

test("node attempt ledger records an occurrence once and never re-derives it", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "attempt-ledger-redacted-replay" });
  const oldCredential = "correct horse battery staple";
  const input = failedAttemptInput("redacted-replay", `provider echoed ${oldCredential}`);

  const first = appendNodeAttempt(layout, { ...input, forbiddenSecretValues: [oldCredential] });
  const persistedBytes = fs.readFileSync(layout.attemptLedgerPath);
  assert.equal(first.appended, true);
  assert.equal(first.entry.failure_message, "provider echoed <redacted>");
  assert.deepEqual(first.entry.failure_message_redaction_span_code_points, [[...oldCredential].length]);
  assert.equal(first.entry.failure_message_truncated, undefined);

  // A replay of the same Smithers identity returns the stored entry whatever it
  // would derive now: a rotated secret, a changed message, or a different outcome.
  for (const replay of [
    { ...input, forbiddenSecretValues: ["new credential value"] },
    { ...input, failureMessage: `different provider failure ${oldCredential}` },
    { ...input, outcome: "canceled" as const, failureCategory: "canceled" as const, failureMessage: "run-cancelled" }
  ]) {
    const replayed = appendNodeAttempt(layout, replay);
    assert.equal(replayed.appended, false);
    assert.deepEqual(replayed.entry, first.entry);
  }
  assert.deepEqual(fs.readFileSync(layout.attemptLedgerPath), persistedBytes);
});

test("node attempt ledger keeps truncation and redaction provenance for long failure messages", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "attempt-ledger-truncated-replay" });
  const oldCredential = "old credential material ".repeat(30).trim();
  const input = failedAttemptInput(
    "truncated-replay",
    `provider echoed ${oldCredential}; stable context ${"x".repeat(1_500)}`
  );

  const first = appendNodeAttempt(layout, { ...input, forbiddenSecretValues: [oldCredential] });
  assert.equal(Buffer.byteLength(first.entry.failure_message ?? "", "utf8"), MAX_NODE_ATTEMPT_FAILURE_MESSAGE_BYTES);
  assert.deepEqual(first.entry.failure_message_redaction_span_code_points, [[...oldCredential].length]);
  assert.equal(first.entry.failure_message_truncated, true);

  const literal = appendNodeAttempt(layout, {
    ...failedAttemptInput("literal-placeholder", `provider echoed <redacted>; ${"x".repeat(1_500)}`)
  });
  assert.equal(literal.entry.failure_message_redaction_span_code_points, undefined);
  assert.equal(literal.entry.failure_message_truncated, true);
});

test("createRunLayout rejects symlinked run roots before creating outside writes", () => {
  const project = tempProject();
  const outside = tempProject();
  fs.symlinkSync(outside, path.join(project, ".ultrafuzz"));

  assert.throws(() => createRunLayout({ projectRoot: project, runId: "run-1" }), /symlink/);
  assert.equal(fs.existsSync(path.join(outside, "runs")), false);
});

test("safe path helpers reject traversal, absolutes, unsafe IDs, and symlink escapes", () => {
  assert.equal(normalizeSafeRelativePath(".review/report@v3+1.json"), ".review/report@v3+1.json");
  assert.throws(() => normalizeSafeRelativePath("../secret"), /traverse/);
  assert.throws(() => normalizeSafeRelativePath("/tmp/secret"), /relative/);
  assert.throws(() => normalizeSafeRelativePath(`${"a".repeat(129)}/report.json`), /unsafe segment/);
  assert.throws(() => safeResolveInside(tempProject(), "Display Name/report.md"), /unsafe segment/);

  const root = tempProject();
  const outside = tempProject();
  fs.symlinkSync(outside, path.join(root, "link"));
  assert.throws(() => safeResolveInside(root, "link/file.txt"), /symlink/);
});

test("safe path helpers admit segments that only begin with two dots", () => {
  const root = tempProject();
  assert.equal(safeResolveInside(root, "..data/report.json"), path.join(root, "..data", "report.json"));
  assert.doesNotThrow(() => assertPathInside(root, root));
  assert.throws(() => assertPathInside(root, path.dirname(root)), /escapes/);
  assert.throws(() => assertPathInside(root, path.join(root, "..", "sibling")), /escapes/);
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
  const canonicalPath = ".setup/project@v3+1.json";
  const artifactPath = writeArtifact(layout, "node-a", canonicalPath, "hello artifact\n");
  const manifest = writeArtifactManifest({
    layout,
    nodeId: "node-a",
    outputs: [
      {
        path: canonicalPath,
        contract: "ultrafuzz/coverage-goal@2",
        contract_digest: "a".repeat(64),
        schema_file: "example.schema.json",
        schema_id: "urn:ultrafuzz:schema:test:example:1",
        schema_sha256: "b".repeat(64),
        schema_bundle_sha256: "c".repeat(64),
        validator_build: `ultrafuzz-json-validator.v1:${"d".repeat(64)}`,
        primary: true
      }
    ],
    provenance: {
      logical_node_id: "node-a",
      agent_ref: "CodexAgent",
      workflow_run_id: "workflow-run-1",
      workflow_task_id: "node:node-a",
      verification_marker_sha256: "e".repeat(64),
      attempt_index: 0
    }
  });

  assert.equal(manifest.schema_version, "ultrafuzz.artifact-manifest.v3");
  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.files[0]!.path, canonicalPath);
  assert.equal(manifest.files[0]!.size_bytes, fs.statSync(artifactPath).size);
  assert.equal(manifest.files[0]!.sha256, crypto.createHash("sha256").update("hello artifact\n").digest("hex"));
  assert.equal(manifest.files[0]!.provenance.producer_node_id, "node-a");
  assert.equal(manifest.files[0]!.provenance.agent_ref, "CodexAgent");
  assert.equal(manifest.files[0]!.provenance.workflow_task_id, "node:node-a");
  assert.equal(manifest.files[0]!.provenance.verification_marker_sha256, "e".repeat(64));
  assert.equal(manifest.provenance.verification_marker_sha256, "e".repeat(64));
  assert.equal(manifest.output_contracts[0]!.contract, "ultrafuzz/coverage-goal@2");
  assert.equal(manifest.output_contracts[0]!.schema_id, "urn:ultrafuzz:schema:test:example:1");
  assert.equal(manifest.output_contracts[0]!.schema_sha256, "b".repeat(64));
  assert.equal(manifest.output_contracts[0]!.schema_bundle_sha256, "c".repeat(64));
  assert.equal(manifest.output_contracts[0]!.validator_build, `ultrafuzz-json-validator.v1:${"d".repeat(64)}`);
  assert.deepEqual(manifest.prerequisite_manifests, []);

  const marker = {
    schema_version: "ultrafuzz.artifact-verification.v2",
    attempt_id: "node-a.0",
    node_id: "node-a",
    artifacts: [
      {
        ...manifest.output_contracts[0],
        sha256: manifest.files[0]!.sha256
      }
    ],
    publications: [{ path: canonicalPath, sha256: manifest.files[0]!.sha256 }]
  };
  assert.equal(validateArtifactVerificationMarker(marker).ok, true);
});

test("artifact manifest v3 accepts only exact reference and Smithers task provenance metadata", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-metadata" });
  writeArtifact(layout, "node-a", "result.md", "result\n");
  const manifest = writeArtifactManifest({
    layout,
    nodeId: "node-a",
    createdAt: "2026-08-09T00:00:00.000Z"
  });
  const referenceMetadata = {
    reference: "properties.example",
    repo: "example/reference",
    commit: "a".repeat(40),
    reference_artifact: "/runs/run-metadata/artifacts/node-a/references/example.md",
    manifest_artifact: "/runs/run-metadata/artifacts/node-a/references/manifest.json",
    reference_expectations: {
      source: "operator-supplied" as const,
      path: "references/expectations.json",
      sha256: "b".repeat(64)
    }
  };
  const smithersTaskMetadata = { concrete_node_id: "node-a" };

  const withMetadata = (metadata: unknown, location: "manifest" | "file"): unknown => {
    const candidate = structuredClone(manifest) as unknown as {
      provenance: { metadata?: unknown };
      files: Array<{ provenance: { metadata?: unknown } }>;
    };
    if (location === "manifest") candidate.provenance.metadata = metadata;
    else candidate.files[0]!.provenance.metadata = metadata;
    return candidate;
  };

  for (const location of ["manifest", "file"] as const) {
    assert.equal(validateArtifactManifest(withMetadata(referenceMetadata, location)).ok, true, location);
    assert.equal(validateArtifactManifest(withMetadata(smithersTaskMetadata, location)).ok, true, location);

    for (const invalidMetadata of [
      { arbitrary: { nested: true } },
      { ...referenceMetadata, concrete_node_id: "node-a" },
      { ...referenceMetadata, extra: "not-declared" },
      { ...referenceMetadata, commit: undefined }
    ]) {
      assert.equal(validateArtifactManifest(withMetadata(invalidMetadata, location)).ok, false, location);
    }
  }

  assert.equal(validateArtifactManifest({ ...manifest, schema_version: "ultrafuzz.artifact-manifest.v2" }).ok, false);
});

test("artifact manifest reads reject v2 and generic metadata without conversion", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-current-manifest-only" });
  const manifest = writeArtifactManifest({
    layout,
    nodeId: "node-a",
    createdAt: "2026-08-09T00:00:00.000Z"
  });
  const manifestPath = path.join(getNodeArtifactDir(layout, "node-a"), "artifact-manifest.json");
  const invalidManifests = [
    { ...manifest, schema_version: "ultrafuzz.artifact-manifest.v2" },
    {
      ...manifest,
      provenance: { ...manifest.provenance, metadata: { arbitrary: { nested: true } } }
    }
  ];

  for (const invalid of invalidManifests) {
    const bytes = `${JSON.stringify(invalid)}\n`;
    fs.writeFileSync(manifestPath, bytes, "utf8");
    assert.throws(() => readArtifactManifest(layout, "node-a"), /artifact manifest is schema-invalid/u);
    assert.equal(fs.readFileSync(manifestPath, "utf8"), bytes);
  }
});

test("artifact provenance keeps uppercase-compatible historical static node IDs", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-uppercase-producer" });
  writeArtifact(layout, "StrategyA", "result.md", "historical static strategy\n");
  const manifest = writeArtifactManifest({
    layout,
    nodeId: "StrategyA",
    provenance: { producer_node_id: "StrategyA" }
  });

  assert.equal(manifest.files[0]!.provenance.producer_node_id, "StrategyA");
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

test("artifact manifests accept exact captured prerequisite authorities without rereading mutable paths", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-captured-causal-authority" });
  writeArtifact(layout, "ancestor", "result.md", "original\n");
  writeArtifactManifest({ layout, nodeId: "ancestor", createdAt: "2026-07-18T00:00:00.000Z" });
  const ancestorManifestPath = path.join(layout.artifactsDir, "ancestor", ARTIFACT_MANIFEST_FILE);
  const capturedSha256 = sha256File(ancestorManifestPath);

  writeArtifact(layout, "ancestor", "result.md", "replacement\n");
  writeArtifactManifest({ layout, nodeId: "ancestor", createdAt: "2026-07-18T00:00:01.000Z" });
  assert.notEqual(sha256File(ancestorManifestPath), capturedSha256);
  writeArtifact(layout, "descendant", "result.md", "derived\n");
  const descendant = writeArtifactManifest({
    layout,
    nodeId: "descendant",
    prerequisiteManifestDigests: [{ node_id: "ancestor", sha256: capturedSha256 }],
    createdAt: "2026-07-18T00:00:02.000Z"
  });

  assert.deepEqual(descendant.prerequisite_manifests, [{ node_id: "ancestor", sha256: capturedSha256 }]);
  assert.throws(
    () =>
      writeArtifactManifest({
        layout,
        nodeId: "descendant",
        prerequisiteNodeIds: ["ancestor"],
        prerequisiteManifestDigests: [{ node_id: "ancestor", sha256: capturedSha256 }]
      }),
    /prerequisite authority is ambiguous/u
  );
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

test("events append to JSONL, replay, and filter by node and status", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-1" });
  appendEvent(layout, {
    eventType: "node-synced",
    nodeId: "node-a",
    status: "running",
    payload: { workflow_run_id: "workflow-1", workflow_task_id: "task-1", workflow_state: "in-progress" }
  });
  appendEvent(layout, {
    eventType: "artifact-manifest-written",
    nodeId: "node-a",
    status: "succeeded",
    payload: { file_count: 1, path: "artifacts/node-a/artifact-manifest.json" }
  });

  const replay = replayEvents(layout);
  assert.equal(replay.records.length, 2);
  assert.deepEqual(replay.records[0]!.payload, {
    workflow_run_id: "workflow-1",
    workflow_task_id: "task-1",
    workflow_state: "in-progress"
  });
  assert.equal(queryEvents(layout, { nodeId: "node-a", status: "succeeded" }).length, 1);
});

test("event appends and replays keep working past 100,000 records", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-long-journal" });
  const template = createEventRecord(layout, {
    eventType: "node-synced",
    nodeId: "node-a",
    status: "running",
    timestamp: "2026-08-05T00:00:00.000Z",
    payload: { workflow_run_id: "workflow-1", workflow_task_id: "task-1" }
  });
  const lines = Array.from({ length: 100_000 }, (_, index) =>
    JSON.stringify({ ...template, event_id: `evt-${index.toString(16).padStart(24, "0")}` })
  );
  fs.writeFileSync(layout.eventsPath, `${lines.join("\n")}\n`);

  const appended = appendEvent(layout, {
    eventType: "node-synced",
    nodeId: "node-a",
    status: "succeeded",
    timestamp: "2026-08-05T00:00:01.000Z",
    payload: { workflow_run_id: "workflow-1", workflow_task_id: "task-1" }
  });
  const replay = replayEvents(layout, Number.MAX_SAFE_INTEGER);
  assert.equal(replay.records.length, 100_001);
  assert.equal(replay.records.at(-1)?.event_id, appended.event_id);
});

test("an event append refuses a repeated or out-of-order event without changing the journal", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-event-window" });
  const event = (nodeId: string, timestamp: string) =>
    ({
      eventType: "node-synced",
      nodeId,
      status: "succeeded",
      timestamp,
      payload: { workflow_run_id: "workflow-1", workflow_task_id: `task-${nodeId}` }
    }) as const;
  appendEvent(layout, event("node-a", "2026-08-05T00:00:01.000Z"));
  appendEvent(layout, event("node-b", "2026-08-05T00:00:01.000Z"));
  const before = fs.readFileSync(layout.eventsPath);

  // The same event again in the same millisecond, behind a different one, is still a repeat.
  assert.throws(() => appendEvent(layout, event("node-a", "2026-08-05T00:00:01.000Z")), /duplicate identity/u);
  assert.throws(() => appendEvent(layout, event("node-c", "2026-08-05T00:00:00.000Z")), /not ordered/u);
  assert.deepEqual(fs.readFileSync(layout.eventsPath), before);
  assert.equal(replayEvents(layout).records.length, 2);
});

test("event appends take the wall clock and keep working after it steps back behind the journal", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-event-clock-step" });
  const event = {
    eventType: "node-synced",
    nodeId: "node-a",
    status: "succeeded",
    payload: { workflow_run_id: "workflow-1", workflow_task_id: "task-1" }
  } as const;
  const past = appendEvent(layout, { ...event, timestamp: new Date(Date.now() - 3_600_000).toISOString() });
  const now = new Date().toISOString();
  const current = appendEvent(layout, event);
  assert.ok(current.timestamp >= now, `stamped ${current.timestamp}, wall clock was ${now}`);
  // Recorded before the clock stepped back by an hour.
  const recorded = appendEvent(layout, { ...event, timestamp: new Date(Date.now() + 3_600_000).toISOString() });

  const first = appendEvent(layout, event);
  const second = appendEvent(layout, event);

  assert.equal(first.timestamp, new Date(Date.parse(recorded.timestamp) + 1).toISOString());
  assert.equal(second.timestamp, new Date(Date.parse(recorded.timestamp) + 2).toISOString());
  assert.deepEqual(replayEvents(layout).records, [past, current, recorded, first, second]);
});

test("event redaction covers token families, AWS keys, URL credentials, and private keys", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ufz-artifacts-events-"));
  const layout = createRunLayout({ outputRoot: path.join(root, "runs"), runId: "run-redaction" });
  appendEvent(layout, {
    eventType: "workflow-submit-failed",
    status: "failed",
    payload: {
      code: "WORKFLOW_SUBMISSION_FAILED",
      message: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----", // gitleaks:allow -- fake credential fixture for the redaction tests
      severity: "error",
      source: "workflow",
      details: {
        stdout: "Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijkl.zyxwvutsrq AKIAIOSFODNN7EXAMPLE", // gitleaks:allow -- fake credential fixture for the redaction tests
        stderr: "https://user:pass@example.com xoxb-1234567890-abcdefghi" // gitleaks:allow -- fake credential fixture for the redaction tests
      }
    }
  });
  const serialized = fs.readFileSync(layout.eventsPath, "utf8");
  assert.doesNotMatch(serialized, /AKIAIOSFODNN7EXAMPLE/); // gitleaks:allow -- fake credential fixture for the redaction tests
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

const exactAtRestSecret = "exact unknown run credential";
const mnemonicAtRestSecret =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const entropyAtRestSecret = "aB3dE5fG7hJ9kL2mN4pQ6rS8tV0wXyZ1_cD3eF5gH7jK9mP2q"; // gitleaks:allow -- fake credential fixture for the redaction tests

function atRestSecretFixture(): string {
  return [
    `private-key=0x${"1a".repeat(32)}`,
    // Real npm tokens are npm_ plus exactly 36 characters; secretlint encodes
    // the true vendor format, so the fixture uses it.
    "token npm_0123456789abcdefghijklmnopqrstuvwxyz", // gitleaks:allow -- fake credential fixture for the redaction tests
    `mnemonic ${mnemonicAtRestSecret}`,
    "rpc https://eth-mainnet.g.alchemy.com/v2/0123456789abcdefghijklmnopqrstuv",
    `opaque ${entropyAtRestSecret}`,
    `exact ${exactAtRestSecret}`
  ].join("\n");
}

test("state diagnostics redact key, token, mnemonic, URL, entropy, and exact run secrets", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-state-expanded-redaction" });
  updateNodeState(
    layout,
    "node-a",
    { status: "failed", last_error: atRestSecretFixture() },
    "2026-08-15T00:00:00.000Z",
    { forbiddenSecretValues: [exactAtRestSecret] }
  );

  const serialized = fs.readFileSync(layout.statePath, "utf8");
  for (const secret of ["0x1a", "npm_", "alchemy.com", entropyAtRestSecret, exactAtRestSecret, "abandon abandon"]) {
    assert.doesNotMatch(serialized, new RegExp(secret.replaceAll(".", "\\."), "u"));
  }
  assert.match(readRunState(layout).nodes["node-a"]?.last_error ?? "", /<redacted>/u);
});

test("event payloads redact key, token, mnemonic, URL, and exact run secrets positively", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-event-expanded-redaction" });
  appendEvent(layout, {
    eventType: "workflow-submit-failed",
    status: "failed",
    payload: {
      code: "WORKFLOW_SUBMISSION_FAILED",
      message: atRestSecretFixture(),
      severity: "error",
      source: "workflow",
      details: {}
    },
    forbiddenSecretValues: [exactAtRestSecret]
  });

  const serialized = fs.readFileSync(layout.eventsPath, "utf8");
  for (const secret of ["0x1a", "npm_", "alchemy.com", exactAtRestSecret, "abandon abandon"]) {
    assert.doesNotMatch(serialized, new RegExp(secret.replaceAll(".", "\\."), "u"));
  }
  assert.match(serialized, /<redacted>/u);
  // Event payloads are structured identifier records that sealed-integrity
  // checks byte-compare against their journals, so they scan positive-only:
  // the speculative entropy pass cannot separate a credential from a long
  // identifier and was redacting the pipeline's own workflow run ids,
  // tearing down every CI eval submission (#889). An unlabeled opaque
  // high-entropy string therefore persists here; prose artifacts such as
  // attempt-ledger failure messages keep the speculative scrub below.
  assert.match(serialized, new RegExp(entropyAtRestSecret, "u"));

  const preservedRunId = "ultrafuzz-ci-32872423902-1-smoke-ultrafuzz-benc-346bb576f2a1a2e3";
  const linked = appendEvent(layout, {
    eventType: "workflow-link-recorded",
    status: "pending",
    payload: {
      workflow_link_id: "00000000-0000-4000-8000-000000000009",
      action: "start",
      workflow_run_id: preservedRunId,
      control_generation: "d".repeat(64)
    }
  });
  assert.equal((linked.payload as Record<string, unknown>).workflow_run_id, preservedRunId);
});

test("attempt failures redact key, token, mnemonic, URL, entropy, and exact run secrets", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-attempt-expanded-redaction" });
  const result = appendNodeAttempt(layout, {
    workflowRunId: "workflow-run-expanded-redaction",
    controlGeneration: "c".repeat(64),
    nodeId: "strategy-a",
    strategyAttemptId: "strategy-a",
    iteration: 0,
    attempt: 1,
    startedEventSequence: 1,
    sourceEventSequence: 2,
    startedAt: "2026-08-15T00:00:00.000Z",
    finishedAt: "2026-08-15T00:01:00.000Z",
    outcome: "failed",
    inputManifestDigest: manifestDigest("expanded redaction input"),
    failureCategory: "executor-error",
    failureMessage: atRestSecretFixture(),
    forbiddenSecretValues: [exactAtRestSecret]
  });

  const persisted = result.entry.failure_message ?? "";
  for (const secret of ["0x1a", "npm_", "alchemy.com", entropyAtRestSecret, exactAtRestSecret, "abandon abandon"]) {
    assert.doesNotMatch(persisted, new RegExp(secret.replaceAll(".", "\\."), "u"));
  }
  assert.match(persisted, /<redacted>/u);
});

test("canonical publication secret gate fails closed without rewriting bytes", () => {
  const maintainedFixtures = new Map<string, Buffer>([
    ["generated/Exploit.t.sol", Buffer.from(`constant TOKEN = "${entropyAtRestSecret}";`, "utf8")],
    ["report.md", Buffer.from(`wallet ${mnemonicAtRestSecret}`, "utf8")]
  ]);
  const original = new Map([...maintainedFixtures].map(([artifactPath, bytes]) => [artifactPath, Buffer.from(bytes)]));
  // The mnemonic is a positive identification and still fails the gate. The
  // opaque high-entropy blob beside it no longer does — see the accepted cases
  // below for why the speculative heuristics are off for publication.
  assert.throws(
    () => assertArtifactPublicationsContainNoSecrets(maintainedFixtures),
    (error: unknown) => error instanceof ArtifactSecretGateError && error.artifactPath === "report.md"
  );
  for (const [artifactPath, bytes] of maintainedFixtures) assert.deepEqual(bytes, original.get(artifactPath));

  assert.throws(
    () =>
      assertArtifactPublicationsContainNoSecrets(
        new Map([["raw-key.txt", Buffer.from(`signing key: ${"2b".repeat(32)}\n`, "utf8")]]) // gitleaks:allow -- fake credential fixture for the redaction tests
      ),
    /raw-key\.txt/u
  );

  const exactBytes = Buffer.from(`otherwise safe ${exactAtRestSecret}`, "utf8");
  assert.throws(
    () => assertArtifactPublicationsContainNoSecrets(new Map([["evidence.json", exactBytes]]), [exactAtRestSecret]),
    /evidence\.json/u
  );
  assert.equal(exactBytes.toString("utf8"), `otherwise safe ${exactAtRestSecret}`);
  assert.doesNotThrow(() =>
    assertArtifactPublicationsContainNoSecrets(new Map([["binary-corpus.bin", Buffer.from([0xff, 0x00, 0xfe])]]))
  );
  assert.throws(
    () =>
      assertArtifactPublicationsContainNoSecrets(
        new Map([
          ["binary-leak.bin", Buffer.concat([Buffer.from([0xff]), Buffer.from("sk-ant-binaryLeak123", "utf8")])]
        ])
      ),
    /binary-leak\.bin/u
  );
  assert.doesNotThrow(() =>
    assertArtifactPublicationsContainNoSecrets(
      new Map([["short-exact.txt", Buffer.from("safe prose contains e", "utf8")]]),
      ["e"]
    )
  );

  // Ordinary technical prose must publish. Each of these failed the gate
  // before the speculative heuristics were scoped out of publication, and each
  // killed a real campaign run (#819, #822): qualified method groups and long
  // generated test names clear the entropy thresholds purely because
  // mixed-case identifiers are character-diverse, pinned dependency commits
  // are unlabeled 40-hex, the key-name rule fires on an English sentence about
  // tokens, and hyphenated goal identifiers used to read as ak-/as- keys.
  assert.doesNotThrow(() =>
    assertArtifactPublicationsContainNoSecrets(
      new Map([
        ["setup/actors.md", Buffer.from("IExampleVaultCore.setAuthority/togglePause/transferOwnership\n", "utf8")],
        ["setup/ledger.json", Buffer.from('{"result":"testFuzz_MaximumPrincipalForGrossIsSafeAndBounded"}\n', "utf8")],
        ["generated-tests/EnumFixture.t.sol", Buffer.from("IExampleBook.NativeExecInstruction.POST_ONLY;\n", "utf8")],
        ["setup/invariants.md", Buffer.from("For every token:\n  balance >= sum of credits\n", "utf8")],
        [
          "setup/dependencies.md",
          Buffer.from(`Pinned: \`${"da0e9c1b".repeat(5)}\`, \`${"1a2b3c4d".repeat(5)}\`.\n`, "utf8")
        ],
        ["setup/goals.md", Buffer.from("policy.record-treated-as-private-to-the-service\n", "utf8")],
        ["report.md", Buffer.from("the role bearer (i.e. `account`) is granted the permission\n", "utf8")]
      ])
    )
  );

  // The positive rules must not fire on ordinary contract output either: a
  // Foundry test deriving and signing with Anvil's published mnemonic and
  // account (0) key, and a qualified identifier with three long dotted
  // segments (JWT-shaped until the rule required an eyJ header).
  assert.doesNotThrow(() =>
    assertArtifactPublicationsContainNoSecrets(
      new Map([
        [
          "generated-tests/AnvilSigner.t.sol",
          Buffer.from(
            'string memory mnemonic = "test test test test test test test test test test test junk";\n' +
              "uint256 privateKey = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;\n" + // gitleaks:allow -- public Anvil dev key fixture for the redaction tests
              "assertEq(vm.deriveKey(mnemonic, 0), privateKey);\n",
            "utf8"
          )
        ],
        [
          "setup/call-graph.md",
          Buffer.from(
            "`ReentrancyGuardUpgradeable.nonReentrantModifier.lockedStateCheck` reverts on re-entry\n",
            "utf8"
          )
        ]
      ])
    )
  );

  // Every credential format the previous hand-rolled patterns could name is
  // still rejected — via a secretlint library finding or a documented
  // supplemental pattern.
  for (const [artifactPath, body] of [
    ["k01.txt", "sk-ant-api03-AbCdEf1234567890AbCdEf1234567890AbCdEf"], // gitleaks:allow -- fake credential fixture for the redaction tests
    ["k02.txt", "ghp_AbCdEf1234567890AbCdEf1234567890AbCd"], // gitleaks:allow -- fixed placeholder asserted on by the redaction tests
    ["k03.txt", "AKIAIOSFODNN7EXAMPLE"], // gitleaks:allow -- fake credential fixture for the redaction tests
    ["k04.txt", "AIzaSyD-1234567890abcdefghijklmnopqrstuv"], // gitleaks:allow -- fake credential fixture for the redaction tests
    ["k05.txt", "xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrSt"], // gitleaks:allow -- fake credential fixture for the redaction tests
    ["k06.txt", "npm_AbCdEf1234567890AbCdEf1234567890AbCd"], // gitleaks:allow -- fake credential fixture for the redaction tests
    ["k07.txt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"], // gitleaks:allow -- fake credential fixture for the redaction tests
    ["k08.txt", "https://admin:hunter2hunter2@example.com/x"], // gitleaks:allow -- fake credential fixture for the redaction tests
    ["k09.txt", "Authorization: Bearer AbCdEf1234567890AbCdEf1234567890"], // gitleaks:allow -- fake credential fixture for the redaction tests
    ["k10.txt", "modal ak-0123456789abcdefghijklmnop"], // gitleaks:allow -- fake credential fixture for the redaction tests
    ["k11.txt", "oauth ya29.a0AfH6SMB0123456789abcdefghijklmnop"], // gitleaks:allow -- fake credential fixture for the redaction tests
    ["k12.txt", "rpc wss://mainnet.infura.io/v3/0123456789abcdefghijklmnopqrstuv"], // gitleaks:allow -- fake credential fixture for the redaction tests
    ["k13.txt", `github fine-grained github_pat_${"A1".repeat(41)}`], // gitleaks:allow -- fake credential fixture for the redaction tests
    ["k14.txt", "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----"], // gitleaks:allow -- fake credential fixture for the redaction tests
    ["k15.txt", `signing key: ${"2b".repeat(32)}`] // gitleaks:allow -- fake credential fixture for the redaction tests
  ] as const) {
    assert.throws(
      () => assertArtifactPublicationsContainNoSecrets(new Map([[artifactPath, Buffer.from(body, "utf8")]])),
      new RegExp(artifactPath.replaceAll(".", "\\."), "u"),
      `${artifactPath} must still be rejected`
    );
  }
  assert.doesNotThrow(() =>
    assertArtifactPublicationsContainNoSecrets(
      new Map([
        [
          "report.md",
          Buffer.from(`Reproducer transaction hash: 0x${"56".repeat(32)}\nNo sensitive values here.\n`, "utf8")
        ],
        [
          "generated-tests/HashFixture.t.sol",
          Buffer.from(`contract HashFixture { bytes32 public constant DOMAIN = 0x${"34".repeat(32)}; }\n`, "utf8")
        ],
        ["manifest.json", Buffer.from(`{"sha256":"${"a".repeat(64)}"}\n`, "utf8")]
      ])
    )
  );
});

test("updateNodeState accepts an explicit transition timestamp", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-state-clock" });
  const initial = readRunState(layout);
  initial.nodes["node-a"] = {
    node_id: "node-a",
    status: "pending",
    retry_count: 0,
    timed_out: false,
    wait_since: initial.created_at,
    wait_reason: "ready",
    next_eligible_action: "dispatch"
  };
  writeRunState(layout, initial);

  updateNodeState(layout, "node-a", { status: "running" }, "2026-01-01T00:00:05.000Z");
  const running = readRunState(layout);

  assert.equal(running.last_transition_at, "2026-01-01T00:00:05.000Z");
  assert.equal(running.nodes["node-a"]?.wait_since, "2026-01-01T00:00:05.000Z");
});

test("a verification marker may record restored dependency changes, bounded and non-empty (#1251)", () => {
  const marker = {
    schema_version: "ultrafuzz.artifact-verification.v2",
    attempt_id: "node-a.0",
    node_id: "node-a",
    artifacts: [
      {
        path: "stdout.txt",
        contract: "ultrafuzz/text@1",
        contract_digest: "a".repeat(64),
        sha256: "b".repeat(64),
        primary: true
      }
    ],
    publications: [{ path: "stdout.txt", sha256: "b".repeat(64) }]
  };
  const withChanges = (changes: unknown) =>
    validateArtifactVerificationMarker({ ...marker, dependency_changes: changes });
  assert.equal(validateArtifactVerificationMarker(marker).ok, true);
  assert.equal(withChanges({ changed_path_count: 60, changed_paths: ["lib/forge-std/src/Test.sol"] }).ok, true);
  assert.equal(withChanges({ changed_path_count: 0, changed_paths: [] }).ok, false);
  assert.equal(withChanges({ changed_path_count: 1, changed_paths: ["../escape"] }).ok, false);
  // Dependency files may use any name the filesystem allows.
  for (const name of ["lib/dep/test data.txt", "lib/dep/café.sol", `lib/dep/${"x".repeat(200)}.sol`]) {
    assert.equal(withChanges({ changed_path_count: 1, changed_paths: [name] }).ok, true, name);
  }
  for (const name of ["/abs", "a//b", "a/./b", "a/../b", "a/"]) {
    assert.equal(withChanges({ changed_path_count: 1, changed_paths: [name] }).ok, false, name);
  }
  assert.equal(
    withChanges({ changed_path_count: 51, changed_paths: Array.from({ length: 51 }, (_, i) => `lib/x/${i}.sol`) }).ok,
    false
  );
});
