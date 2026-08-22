import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ArtifactPathError,
  ArtifactSecretGateError,
  ARTIFACT_MANIFEST_FILE,
  GENERATED_TESTS_SCHEMA_VERSION,
  MAX_GENERATED_TEST_BUNDLE_BYTES,
  MAX_GENERATED_TEST_BUNDLE_ENTRIES,
  appendUsageEvents,
  assertArtifactPublicationsContainNoSecrets,
  appendNodeAttempt,
  appendEvent,
  appendLineDurable,
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
  readEventQueryFacade,
  readGeneratedTestManifest,
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
  writeGeneratedTestManifest as writeGeneratedTestManifestWithFramework,
  writeRunState
} from "../src/index.js";

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ufz-artifacts-"));
}

function writeGeneratedTestManifest(
  input: Omit<Parameters<typeof writeGeneratedTestManifestWithFramework>[0], "framework">
): ReturnType<typeof writeGeneratedTestManifestWithFramework> {
  return writeGeneratedTestManifestWithFramework({ ...input, framework: "foundry" });
}

function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(`injected ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
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
    layout.attemptLedgerPath,
    path.join(layout.eventsIndexDir, "query-inputs.json")
  ]) {
    assert.equal(fs.existsSync(expected), true, expected);
  }
  for (const expected of [layout.artifactsDir, layout.reviewDir, layout.eventsIndexDir]) {
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

  appendLineDurable(layout.usageLedgerPath, "{malformed", layout.root);
  assert.throws(() => replayUsageEvents(layout), /invalid strict JSON/u);
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
  appendLineDurable(
    secondLayout.usageLedgerPath,
    fs.readFileSync(firstLayout.usageLedgerPath, "utf8"),
    secondLayout.root
  );

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

test("node attempt ledger replay keeps a persisted failure redaction authoritative across credential rotation", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "attempt-ledger-redacted-replay" });
  const oldCredential = "correct horse battery staple";
  const input = failedAttemptInput("redacted-replay", `provider echoed ${oldCredential}`);

  const first = appendNodeAttempt(layout, { ...input, forbiddenSecretValues: [oldCredential] });
  const persistedBytes = fs.readFileSync(layout.attemptLedgerPath);
  assert.equal(first.entry.failure_message, "provider echoed <redacted>");
  assert.deepEqual(first.entry.failure_message_redaction_span_code_points, [[...oldCredential].length]);
  assert.equal(first.entry.failure_message_truncated, undefined);

  const replayed = appendNodeAttempt(layout, {
    ...input,
    forbiddenSecretValues: ["new credential value"]
  });
  assert.equal(replayed.appended, false);
  assert.deepEqual(replayed.entry, first.entry);
  assert.deepEqual(fs.readFileSync(layout.attemptLedgerPath), persistedBytes);

  for (const failureMessage of [
    `different provider failure ${oldCredential}`,
    `provider echoed ${oldCredential}; changed non-secret context`
  ]) {
    assert.throws(
      () =>
        appendNodeAttempt(layout, {
          ...input,
          failureMessage,
          forbiddenSecretValues: ["new credential value"]
        }),
      /already recorded with different immutable data/u
    );
  }
  assert.deepEqual(fs.readFileSync(layout.attemptLedgerPath), persistedBytes);
});

test("node attempt ledger uses explicit provenance for truncated redaction replay", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "attempt-ledger-truncated-replay" });
  const oldCredential = "old credential material ".repeat(30).trim();
  const input = failedAttemptInput(
    "truncated-replay",
    `provider echoed ${oldCredential}; stable context ${"x".repeat(1_500)}`
  );

  const first = appendNodeAttempt(layout, { ...input, forbiddenSecretValues: [oldCredential] });
  const persistedBytes = fs.readFileSync(layout.attemptLedgerPath);
  assert.equal(Buffer.byteLength(first.entry.failure_message ?? "", "utf8"), MAX_NODE_ATTEMPT_FAILURE_MESSAGE_BYTES);
  assert.deepEqual(first.entry.failure_message_redaction_span_code_points, [[...oldCredential].length]);
  assert.equal(first.entry.failure_message_truncated, true);

  const replayed = appendNodeAttempt(layout, {
    ...input,
    forbiddenSecretValues: ["rotated credential value"]
  });
  assert.equal(replayed.appended, false);
  assert.deepEqual(replayed.entry, first.entry);
  assert.deepEqual(fs.readFileSync(layout.attemptLedgerPath), persistedBytes);

  assert.throws(
    () =>
      appendNodeAttempt(layout, {
        ...input,
        failureMessage: `changed prefix ${oldCredential}; stable context ${"x".repeat(1_500)}`,
        forbiddenSecretValues: ["rotated credential value"]
      }),
    /already recorded with different immutable data/u
  );
});

test("node attempt ledger does not infer replay-safe redaction from a literal placeholder", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "attempt-ledger-literal-placeholder" });
  const input = failedAttemptInput("literal-placeholder", `provider echoed <redacted>; ${"x".repeat(1_500)}`);

  const first = appendNodeAttempt(layout, input);
  assert.equal(first.entry.failure_message_redaction_span_code_points, undefined);
  assert.equal(first.entry.failure_message_truncated, true);
  assert.throws(
    () =>
      appendNodeAttempt(layout, { ...input, failureMessage: `provider echoed old credential; ${"x".repeat(1_500)}` }),
    /already recorded with different immutable data/u
  );
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

test("events append to JSONL, replay, and expose query indexes", () => {
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
  assert.equal(fs.existsSync(path.join(layout.eventsIndexDir, "node", "node-a.jsonl")), true);
  assert.equal(fs.existsSync(path.join(layout.eventsIndexDir, "status", "succeeded.jsonl")), true);
});

test("event indexes encode long IDs in a collision-free hash namespace", () => {
  const maximumRunId = "r".repeat(128);
  const layout = createRunLayout({ projectRoot: tempProject(), runId: maximumRunId });
  const facadeBeforeAppend = readEventQueryFacade(layout);
  const maximumNodeId = "n".repeat(128);
  const directBoundaryNodeId = "d".repeat(122);
  const longBoundaryNodeId = "e".repeat(123);
  const legacyCollisionNodeId = `${maximumNodeId.slice(0, 97)}-${crypto
    .createHash("sha256")
    .update(maximumNodeId, "utf8")
    .digest("hex")
    .slice(0, 24)}`;
  assert.equal(legacyCollisionNodeId.length, 122);

  const appendNodeSynced = (nodeId: string, workflowTaskId: string): void => {
    appendEvent(layout, {
      eventType: "node-synced",
      nodeId,
      status: "running",
      payload: { workflow_run_id: "workflow-1", workflow_task_id: workflowTaskId }
    });
  };

  appendNodeSynced(maximumNodeId, "task-maximum");
  appendNodeSynced(longBoundaryNodeId, "task-long-boundary");
  appendNodeSynced(legacyCollisionNodeId, "task-legacy-collision");
  appendNodeSynced(directBoundaryNodeId, "task-direct-boundary");

  const hashedIndexPath = (dimension: string, value: string): string =>
    path.join(
      layout.eventsIndexDir,
      dimension,
      "sha256",
      `${crypto.createHash("sha256").update(value, "utf8").digest("hex")}.jsonl`
    );
  const maximumRunIndex = hashedIndexPath("run", maximumRunId);
  assert.equal(fs.existsSync(maximumRunIndex), true);
  assert.equal(fs.existsSync(path.join(layout.eventsIndexDir, "node", `${legacyCollisionNodeId}.jsonl`)), true);
  assert.equal(fs.existsSync(path.join(layout.eventsIndexDir, "node", `${directBoundaryNodeId}.jsonl`)), true);
  assert.equal(fs.existsSync(hashedIndexPath("node", longBoundaryNodeId)), true);
  assert.equal(fs.existsSync(hashedIndexPath("node", maximumNodeId)), true);

  const maximumRecords = fs
    .readFileSync(maximumRunIndex, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as { run_id: string });
  assert.equal(maximumRecords.length, 4);
  assert.equal(
    maximumRecords.every((record) => record.run_id === maximumRunId),
    true
  );
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
    version: "ultrafuzz.event-index-key.v1",
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
    eventType: "workflow-submit-failed",
    status: "failed",
    payload: {
      code: "WORKFLOW_SUBMISSION_FAILED",
      message: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
      severity: "error",
      source: "workflow",
      details: {
        stdout: "Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijkl.zyxwvutsrq AKIAIOSFODNN7EXAMPLE",
        stderr: "https://user:pass@example.com xoxb-1234567890-abcdefghi"
      }
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

const exactAtRestSecret = "exact unknown run credential";
const mnemonicAtRestSecret =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const entropyAtRestSecret = "aB3dE5fG7hJ9kL2mN4pQ6rS8tV0wXyZ1_cD3eF5gH7jK9mP2q";

function atRestSecretFixture(): string {
  return [
    `private-key=0x${"1a".repeat(32)}`,
    "token npm_0123456789abcdefghijklmnopqrstuv",
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

test("event payloads redact key, token, mnemonic, URL, entropy, and exact run secrets", () => {
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
  for (const secret of ["0x1a", "npm_", "alchemy.com", entropyAtRestSecret, exactAtRestSecret, "abandon abandon"]) {
    assert.doesNotMatch(serialized, new RegExp(secret.replaceAll(".", "\\."), "u"));
  }
  assert.match(serialized, /<redacted>/u);
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
    ["report.md", Buffer.from(`wallet ${mnemonicAtRestSecret}`, "utf8")],
    ["generated/Exploit.t.sol", Buffer.from(`constant TOKEN = "${entropyAtRestSecret}";`, "utf8")]
  ]);
  const original = new Map([...maintainedFixtures].map(([artifactPath, bytes]) => [artifactPath, Buffer.from(bytes)]));
  assert.throws(
    () => assertArtifactPublicationsContainNoSecrets(maintainedFixtures),
    (error: unknown) => error instanceof ArtifactSecretGateError && error.artifactPath === "generated/Exploit.t.sol"
  );
  for (const [artifactPath, bytes] of maintainedFixtures) assert.deepEqual(bytes, original.get(artifactPath));

  assert.throws(
    () =>
      assertArtifactPublicationsContainNoSecrets(
        new Map([["raw-key.txt", Buffer.from(`signing key: ${"2b".repeat(32)}\n`, "utf8")]])
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

test("durable append rejects a half write without retrying the record", (t) => {
  const root = tempProject();
  const filePath = path.join(root, "audit.jsonl");
  const expected = Buffer.from("0123456789\n", "utf8");
  const partialLength = Math.floor(expected.length / 2);
  const realWriteSync = fs.writeSync;
  const realCloseSync = fs.closeSync;
  const writeSync = t.mock.method(fs, "writeSync", (fd: number, bytes: Uint8Array) =>
    realWriteSync(fd, Buffer.from(bytes).subarray(0, partialLength))
  );
  const closeSync = t.mock.method(fs, "closeSync", (fd: number) => realCloseSync(fd));

  assert.throws(
    () => appendLineDurable(filePath, "0123456789"),
    (error: unknown) => {
      assert.ok(error instanceof ArtifactPathError);
      assert.equal(error.code, "short-write");
      assert.match(error.message, new RegExp(`wrote ${partialLength} of ${expected.length} bytes`, "u"));
      return true;
    }
  );

  assert.equal(writeSync.mock.callCount(), 1);
  assert.equal(closeSync.mock.callCount(), 1);
  assert.deepEqual(fs.readFileSync(filePath), expected.subarray(0, partialLength));
});

test("durable append rejects a zero write without retrying the record", (t) => {
  const root = tempProject();
  const filePath = path.join(root, "audit.jsonl");
  const realCloseSync = fs.closeSync;
  const writeSync = t.mock.method(fs, "writeSync", () => 0);
  const closeSync = t.mock.method(fs, "closeSync", (fd: number) => realCloseSync(fd));

  assert.throws(
    () => appendLineDurable(filePath, "entry"),
    (error: unknown) => {
      assert.ok(error instanceof ArtifactPathError);
      assert.equal(error.code, "short-write");
      assert.match(error.message, /wrote 0 of 6 bytes/u);
      return true;
    }
  );

  assert.equal(writeSync.mock.callCount(), 1);
  assert.equal(closeSync.mock.callCount(), 1);
  assert.equal(fs.readFileSync(filePath, "utf8"), "");
});

test("durable append propagates a directory fsync I/O failure", (t) => {
  const root = tempProject();
  const filePath = path.join(root, "audit.jsonl");
  const realFsyncSync = fs.fsyncSync;
  const realCloseSync = fs.closeSync;
  let fsyncCall = 0;
  const fsyncSync = t.mock.method(fs, "fsyncSync", (fd: number) => {
    fsyncCall += 1;
    if (fsyncCall === 1) {
      realFsyncSync(fd);
      return;
    }
    throw errnoError("EIO");
  });
  const closeSync = t.mock.method(fs, "closeSync", (fd: number) => realCloseSync(fd));

  assert.throws(
    () => appendLineDurable(filePath, "entry"),
    (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error);
      assert.equal(error.code, "EIO");
      return true;
    }
  );

  assert.equal(fsyncSync.mock.callCount(), 2);
  assert.equal(closeSync.mock.callCount(), 2);
  assert.equal(fs.readFileSync(filePath, "utf8"), "entry\n");
});

test("durable append tolerates only an unsupported directory fsync operation", (t) => {
  const root = tempProject();
  const filePath = path.join(root, "audit.jsonl");
  const realFsyncSync = fs.fsyncSync;
  const realCloseSync = fs.closeSync;
  let fsyncCall = 0;
  const fsyncSync = t.mock.method(fs, "fsyncSync", (fd: number) => {
    fsyncCall += 1;
    if (fsyncCall === 1) {
      realFsyncSync(fd);
      return;
    }
    throw errnoError("EINVAL");
  });
  const closeSync = t.mock.method(fs, "closeSync", (fd: number) => realCloseSync(fd));

  appendLineDurable(filePath, "entry");

  assert.equal(fsyncSync.mock.callCount(), 2);
  assert.equal(closeSync.mock.callCount(), 2);
  assert.equal(fs.readFileSync(filePath, "utf8"), "entry\n");
});

test("durable append propagates a close failure without retrying close", (t) => {
  const root = tempProject();
  const filePath = path.join(root, "audit.jsonl");
  const realCloseSync = fs.closeSync;
  const closeSync = t.mock.method(fs, "closeSync", (fd: number) => {
    realCloseSync(fd);
    throw errnoError("EIO");
  });

  assert.throws(
    () => appendLineDurable(filePath, "entry"),
    (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error);
      assert.equal(error.code, "EIO");
      return true;
    }
  );

  assert.equal(closeSync.mock.callCount(), 1);
  assert.equal(fs.readFileSync(filePath, "utf8"), "entry\n");
});

test("durable append aggregates an operation failure with its close failure", (t) => {
  const root = tempProject();
  const filePath = path.join(root, "audit.jsonl");
  const realCloseSync = fs.closeSync;
  const writeSync = t.mock.method(fs, "writeSync", () => {
    throw errnoError("EIO");
  });
  const closeSync = t.mock.method(fs, "closeSync", (fd: number) => {
    realCloseSync(fd);
    throw errnoError("EBADF");
  });

  assert.throws(
    () => appendLineDurable(filePath, "entry"),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map((entry: unknown) => (entry instanceof Error && "code" in entry ? entry.code : undefined)),
        ["EIO", "EBADF"]
      );
      return true;
    }
  );

  assert.equal(writeSync.mock.callCount(), 1);
  assert.equal(closeSync.mock.callCount(), 1);
  assert.equal(fs.readFileSync(filePath, "utf8"), "");
});

test("generated-test manifests persist explicit generated files with provenance", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-1" });
  const generatedContents = "contract InvariantTest {} // π\n";
  const supportContents = "library InvariantFixture {} // café\n";
  const manifest = writeGeneratedTestManifest({
    layout,
    nodeId: "strategy-a",
    provenance: { agent_ref: "CodexAgent", workflow_task_id: "node:strategy-a", attempt_index: 0 },
    tests: [
      {
        path: "generated-tests/Invariant.t.sol",
        content: generatedContents,
        language: "solidity"
      }
    ],
    supportFiles: [
      {
        path: "generated-tests/helpers/InvariantFixture.sol",
        content: supportContents,
        language: "solidity"
      }
    ]
  });

  assert.equal(manifest.schema_version, GENERATED_TESTS_SCHEMA_VERSION);
  assert.equal(manifest.framework, "foundry");
  assert.equal(manifest.generated_tests.length, 1);
  assert.equal(manifest.generated_tests[0]!.path, "generated-tests/Invariant.t.sol");
  assert.equal(manifest.generated_tests[0]!.size_bytes, Buffer.byteLength(generatedContents));
  assert.equal(
    manifest.generated_tests[0]!.sha256,
    crypto.createHash("sha256").update(generatedContents).digest("hex")
  );
  assert.equal(manifest.generated_tests[0]!.provenance!.agent_ref, "CodexAgent");
  assert.equal(manifest.support_files[0]!.path, "generated-tests/helpers/InvariantFixture.sol");
  assert.equal(manifest.support_files[0]!.size_bytes, Buffer.byteLength(supportContents));
  assert.equal(manifest.support_files[0]!.sha256, crypto.createHash("sha256").update(supportContents).digest("hex"));
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
        supportFiles: [],
        tests: [{ path: "generated-tests/Empty.t.sol", content: "" }]
      }),
    /generated test file must be non-empty/u
  );
  assert.equal(fs.existsSync(path.join(getNodeArtifactDir(layout, "strategy-a"), "generated-tests.json")), false);
});

test("generated-test manifest writer rejects support-only bundles before writing files", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-support-only-generated-test" });

  assert.throws(
    () =>
      writeGeneratedTestManifest({
        layout,
        nodeId: "strategy-a",
        tests: [],
        supportFiles: [{ path: "generated-tests/Helper.sol", content: "library Helper {}\n" }]
      }),
    /cannot declare support files without a runnable generated test/u
  );
  assert.equal(fs.existsSync(path.join(getNodeArtifactDir(layout, "strategy-a"), "generated-tests.json")), false);
  assert.equal(
    fs.existsSync(path.join(getNodeArtifactDir(layout, "strategy-a"), "generated-tests", "Helper.sol")),
    false
  );
});

test("generated-test manifest writer rejects excess combined entries before creating bundle paths", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-excess-generated-test-entries" });

  assert.throws(
    () =>
      writeGeneratedTestManifest({
        layout,
        nodeId: "strategy-a",
        tests: Array.from({ length: MAX_GENERATED_TEST_BUNDLE_ENTRIES + 1 }, (_, index) => ({
          path: `generated-tests/Test-${index}.sol`,
          content: "x"
        })),
        supportFiles: []
      }),
    /1024-entry combined bundle limit/u
  );
  assert.equal(fs.existsSync(path.join(layout.artifactsDir, "strategy-a")), false);
});

test("generated-test manifest writer rejects excess cumulative existing bytes before reading companions", (t) => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-excess-generated-test-bytes" });
  const nodeDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  const generatedTestsDir = path.join(nodeDir, "generated-tests");
  fs.mkdirSync(generatedTestsDir);
  const tests = Array.from({ length: 5 }, (_, index) => {
    const relativePath = `generated-tests/Test-${index}.sol`;
    const absolutePath = path.join(nodeDir, relativePath);
    fs.writeFileSync(absolutePath, "x", "utf8");
    fs.truncateSync(absolutePath, MAX_GENERATED_TEST_BUNDLE_BYTES / 4);
    return { path: relativePath };
  });
  const readSync = t.mock.method(fs, "readSync", () => {
    throw new Error("companion content was read before cumulative resource preflight completed");
  });

  assert.throws(
    () =>
      writeGeneratedTestManifest({
        layout,
        nodeId: "strategy-a",
        tests,
        supportFiles: []
      }),
    /67108864-byte combined companion limit/u
  );
  assert.equal(readSync.mock.callCount(), 0);
  assert.equal(fs.existsSync(path.join(nodeDir, "generated-tests.json")), false);
});

test("generated-test manifest writer rejects cross-array duplicate paths before changing bundle bytes", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-duplicate-generated-test" });
  const nodeDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  const generatedTestsDir = path.join(nodeDir, "generated-tests");
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  const companionPath = path.join(generatedTestsDir, "Shared.sol");
  const manifestPath = path.join(nodeDir, "generated-tests.json");
  fs.writeFileSync(companionPath, "sentinel companion\n", "utf8");
  fs.writeFileSync(manifestPath, "sentinel manifest\n", "utf8");

  assert.throws(
    () =>
      writeGeneratedTestManifest({
        layout,
        nodeId: "strategy-a",
        tests: [{ path: "generated-tests/Shared.sol", content: "replacement test\n" }],
        supportFiles: [{ path: "generated-tests/Shared.sol", content: "replacement support\n" }]
      }),
    /repeats path "generated-tests\/Shared\.sol"/u
  );
  assert.equal(fs.readFileSync(companionPath, "utf8"), "sentinel companion\n");
  assert.equal(fs.readFileSync(manifestPath, "utf8"), "sentinel manifest\n");
});

test("generated-test manifest writer preflights missing existing companions before overwriting earlier files", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-missing-support-generated-test" });
  const nodeDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  const generatedTestsDir = path.join(nodeDir, "generated-tests");
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  const testPath = path.join(generatedTestsDir, "Replay.t.sol");
  const manifestPath = path.join(nodeDir, "generated-tests.json");
  fs.writeFileSync(testPath, "sentinel test\n", "utf8");
  fs.writeFileSync(manifestPath, "sentinel manifest\n", "utf8");

  assert.throws(
    () =>
      writeGeneratedTestManifest({
        layout,
        nodeId: "strategy-a",
        tests: [{ path: "generated-tests/Replay.t.sol", content: "replacement test\n" }],
        supportFiles: [{ path: "generated-tests/MissingHelper.sol" }]
      }),
    /generated-test support file does not exist/u
  );
  assert.equal(fs.readFileSync(testPath, "utf8"), "sentinel test\n");
  assert.equal(fs.readFileSync(manifestPath, "utf8"), "sentinel manifest\n");
});

test("generated-test manifest writer preflights non-file destinations before overwriting earlier files", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-directory-support-generated-test" });
  const nodeDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  const generatedTestsDir = path.join(nodeDir, "generated-tests");
  const supportDirectory = path.join(generatedTestsDir, "InvariantFixture.sol");
  fs.mkdirSync(supportDirectory, { recursive: true });
  const testPath = path.join(generatedTestsDir, "Replay.t.sol");
  const manifestPath = path.join(nodeDir, "generated-tests.json");
  fs.writeFileSync(testPath, "sentinel test\n", "utf8");
  fs.writeFileSync(manifestPath, "sentinel manifest\n", "utf8");

  assert.throws(
    () =>
      writeGeneratedTestManifest({
        layout,
        nodeId: "strategy-a",
        tests: [{ path: "generated-tests/Replay.t.sol", content: "replacement test\n" }],
        supportFiles: [{ path: "generated-tests/InvariantFixture.sol", content: "library InvariantFixture {}\n" }]
      }),
    /generated-test bundle destination must be a regular file/u
  );
  assert.equal(fs.readFileSync(testPath, "utf8"), "sentinel test\n");
  assert.equal(fs.readFileSync(manifestPath, "utf8"), "sentinel manifest\n");
  assert.deepEqual(fs.readdirSync(supportDirectory), []);
});

test("generated-test manifest writer validates entry metadata before changing bundle bytes", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-invalid-metadata-generated-test" });
  const nodeDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  const generatedTestsDir = path.join(nodeDir, "generated-tests");
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  const testPath = path.join(generatedTestsDir, "Replay.t.sol");
  const manifestPath = path.join(nodeDir, "generated-tests.json");
  fs.writeFileSync(testPath, "sentinel test\n", "utf8");
  fs.writeFileSync(manifestPath, "sentinel manifest\n", "utf8");

  assert.throws(
    () =>
      writeGeneratedTestManifest({
        layout,
        nodeId: "strategy-a",
        tests: [{ path: "generated-tests/Replay.t.sol", content: "replacement test\n" }],
        supportFiles: [
          {
            path: "generated-tests/InvariantFixture.sol",
            content: "library InvariantFixture {}\n",
            language: ""
          }
        ]
      }),
    /generated tests manifest is schema-invalid/u
  );
  assert.equal(fs.readFileSync(testPath, "utf8"), "sentinel test\n");
  assert.equal(fs.existsSync(path.join(generatedTestsDir, "InvariantFixture.sol")), false);
  assert.equal(fs.readFileSync(manifestPath, "utf8"), "sentinel manifest\n");
});

test("generated-test manifest writer preflights its manifest destination before changing companion bytes", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-directory-manifest-generated-test" });
  const nodeDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  const generatedTestsDir = path.join(nodeDir, "generated-tests");
  const manifestDirectory = path.join(nodeDir, "generated-tests.json");
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  fs.mkdirSync(manifestDirectory);
  const testPath = path.join(generatedTestsDir, "Replay.t.sol");
  fs.writeFileSync(testPath, "sentinel test\n", "utf8");

  assert.throws(
    () =>
      writeGeneratedTestManifest({
        layout,
        nodeId: "strategy-a",
        tests: [{ path: "generated-tests/Replay.t.sol", content: "replacement test\n" }],
        supportFiles: []
      }),
    /generated-test bundle destination must be a regular file/u
  );
  assert.equal(fs.readFileSync(testPath, "utf8"), "sentinel test\n");
  assert.deepEqual(fs.readdirSync(manifestDirectory), []);
});

test("generated-test manifest writer rejects a hard-linked manifest destination before changing bundle bytes", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-hardlinked-manifest-generated-test" });
  const nodeDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  const generatedTestsDir = path.join(nodeDir, "generated-tests");
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  const testPath = path.join(generatedTestsDir, "Replay.t.sol");
  const manifestPath = path.join(nodeDir, "generated-tests.json");
  const manifestAlias = path.join(tempProject(), "generated-tests-alias.json");
  fs.writeFileSync(testPath, "sentinel test\n", "utf8");
  fs.writeFileSync(manifestPath, "sentinel manifest\n", "utf8");
  fs.linkSync(manifestPath, manifestAlias);
  const manifestInode = fs.lstatSync(manifestPath).ino;

  assert.throws(
    () =>
      writeGeneratedTestManifest({
        layout,
        nodeId: "strategy-a",
        tests: [{ path: "generated-tests/Replay.t.sol", content: "replacement test\n" }],
        supportFiles: []
      }),
    (error: unknown) => {
      assert.ok(error instanceof ArtifactPathError);
      assert.equal(error.code, "hard-link");
      assert.match(error.message, /bundle destination must be singly linked/u);
      return true;
    }
  );
  assert.equal(fs.readFileSync(testPath, "utf8"), "sentinel test\n");
  assert.equal(fs.readFileSync(manifestPath, "utf8"), "sentinel manifest\n");
  assert.equal(fs.readFileSync(manifestAlias, "utf8"), "sentinel manifest\n");
  assert.equal(fs.lstatSync(manifestPath).ino, manifestInode);
  assert.equal(fs.lstatSync(manifestPath).nlink, 2);
});

test("generated-test manifest writer rejects a hard-linked companion before changing bundle bytes", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-hardlinked-companion-generated-test" });
  const nodeDir = getNodeArtifactDir(layout, "strategy-a", { create: true });
  const generatedTestsDir = path.join(nodeDir, "generated-tests");
  fs.mkdirSync(generatedTestsDir, { recursive: true });
  const testPath = path.join(generatedTestsDir, "Replay.t.sol");
  const supportPath = path.join(generatedTestsDir, "InvariantFixture.sol");
  const supportAlias = path.join(tempProject(), "InvariantFixture-alias.sol");
  const manifestPath = path.join(nodeDir, "generated-tests.json");
  fs.writeFileSync(testPath, "sentinel test\n", "utf8");
  fs.writeFileSync(supportPath, "sentinel support\n", "utf8");
  fs.linkSync(supportPath, supportAlias);
  fs.writeFileSync(manifestPath, "sentinel manifest\n", "utf8");

  assert.throws(
    () =>
      writeGeneratedTestManifest({
        layout,
        nodeId: "strategy-a",
        tests: [{ path: "generated-tests/Replay.t.sol", content: "replacement test\n" }],
        supportFiles: [{ path: "generated-tests/InvariantFixture.sol", content: "replacement support\n" }]
      }),
    (error: unknown) => {
      assert.ok(error instanceof ArtifactPathError);
      assert.equal(error.code, "hard-link");
      assert.match(error.message, /bundle destination must be singly linked/u);
      return true;
    }
  );
  assert.equal(fs.readFileSync(testPath, "utf8"), "sentinel test\n");
  assert.equal(fs.readFileSync(supportPath, "utf8"), "sentinel support\n");
  assert.equal(fs.readFileSync(supportAlias, "utf8"), "sentinel support\n");
  assert.equal(fs.readFileSync(manifestPath, "utf8"), "sentinel manifest\n");
  assert.equal(fs.lstatSync(supportPath).nlink, 2);
});

test("generated-test manifest reader rejects a hard-linked manifest", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-read-hardlinked-generated-test" });
  writeGeneratedTestManifest({
    layout,
    nodeId: "strategy-a",
    tests: [{ path: "generated-tests/Replay.t.sol", content: "contract Replay {}\n" }],
    supportFiles: []
  });
  const manifestPath = path.join(getNodeArtifactDir(layout, "strategy-a"), "generated-tests.json");
  const manifestAlias = path.join(tempProject(), "generated-tests-alias.json");
  fs.linkSync(manifestPath, manifestAlias);
  const manifestBytes = fs.readFileSync(manifestPath);

  assert.throws(
    () => readGeneratedTestManifest(layout, "strategy-a"),
    (error: unknown) => {
      assert.ok(error instanceof ArtifactPathError);
      assert.equal(error.code, "hard-link");
      assert.match(error.message, /manifest must be a singly linked regular file/u);
      return true;
    }
  );
  assert.deepEqual(fs.readFileSync(manifestPath), manifestBytes);
  assert.deepEqual(fs.readFileSync(manifestAlias), manifestBytes);
});

test("generated-test manifest writer rejects file-directory path collisions before creating bundle bytes", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-prefix-collision-generated-test" });

  assert.throws(
    () =>
      writeGeneratedTestManifest({
        layout,
        nodeId: "strategy-a",
        tests: [{ path: "generated-tests/Replay.t.sol", content: "contract Replay {}\n" }],
        supportFiles: [
          {
            path: "generated-tests/Replay.t.sol/InvariantFixture.sol",
            content: "library InvariantFixture {}\n"
          }
        ]
      }),
    /conflicts with file path/u
  );
  assert.equal(fs.existsSync(path.join(layout.artifactsDir, "strategy-a")), false);
});

test("generated-test manifest writer rejects noncanonical path aliases without rewriting them", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-noncanonical-path-generated-test" });

  for (const candidate of [
    "Replay.t.sol",
    "generated-tests/sub/../Replay.t.sol",
    "generated-tests/./Replay.t.sol",
    "generated-tests/sub//Replay.t.sol"
  ]) {
    assert.throws(
      () =>
        writeGeneratedTestManifest({
          layout,
          nodeId: "strategy-a",
          tests: [{ path: candidate, content: "contract Replay {}\n" }],
          supportFiles: []
        }),
      /must (?:begin with|already be a normalized relative POSIX path)/u,
      candidate
    );
    assert.equal(fs.existsSync(path.join(layout.artifactsDir, "strategy-a")), false, candidate);
  }
});

test("generated-test manifest writer rejects non-UTF-8 supplied support before creating bundle bytes", () => {
  const layout = createRunLayout({ projectRoot: tempProject(), runId: "run-binary-support-generated-test" });

  assert.throws(
    () =>
      writeGeneratedTestManifest({
        layout,
        nodeId: "strategy-a",
        tests: [{ path: "generated-tests/Replay.t.sol", content: "contract Replay {}\n" }],
        supportFiles: [{ path: "generated-tests/fixture.dat", content: Buffer.from([0xff]) }]
      }),
    /generated-test support file must be strict UTF-8 text/u
  );
  assert.equal(fs.existsSync(path.join(getNodeArtifactDir(layout, "strategy-a"), "generated-tests.json")), false);
  assert.equal(fs.existsSync(path.join(getNodeArtifactDir(layout, "strategy-a"), "generated-tests")), false);
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
        supportFiles: [],
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
        supportFiles: [],
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
        supportFiles: [],
        tests: [{ path: "generated-tests/../../Outside.t.sol", content: "outside\n" }]
      }),
    /cannot traverse outside/u
  );
  assert.equal(fs.existsSync(path.join(layout.artifactsDir, "Outside.t.sol")), false);
});
