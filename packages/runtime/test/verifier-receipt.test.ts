import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createNodeAttemptLedgerEntry,
  createRunLayout,
  getNodeArtifactDir,
  writeArtifactManifest
} from "@ultrafuzz/artifacts";

import {
  buildVerifierReceipt,
  parseVerifierReceipt,
  persistVerifierOutputEvidence,
  readVerifierOutputEvidence,
  snapshotVerifierArtifactManifest,
  VERIFIER_ARTIFACT_MANIFEST_MAX_BYTES,
  VERIFIER_OUTPUT_EVIDENCE_MAX_BYTES,
  VERIFIER_PUBLIC_EVIDENCE_MAX_BYTES,
  VERIFIER_RECEIPT_MAX_ARTIFACTS,
  verifierOutputEvidenceRelativePath,
  type VerificationOutput
} from "../src/verifier-receipt.js";

test("verifier output evidence persists exact bounded bytes at its stable no-follow path", () => {
  const layout = fixtureLayout("exact-output");
  const output = fixtureOutput("attempt-one", "retry-one");
  const bytes = `${JSON.stringify(output)}\n`;

  const persisted = persistVerifierOutputEvidence({ layout, output, smithersOutputBytes: bytes });
  const replayed = readVerifierOutputEvidence(layout, "attempt-one", "retry-one");

  assert.equal(persisted.relativePath, "review/verifier-receipts/attempt-one/retry-one.smithers-output.json");
  assert.equal(replayed.bytes, bytes);
  assert.equal(replayed.digest, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(replayed.output, output);
  assert.deepEqual(persistVerifierOutputEvidence({ layout, output, smithersOutputBytes: bytes }), persisted);

  assert.throws(
    () =>
      persistVerifierOutputEvidence({
        layout,
        output,
        smithersOutputBytes: `${JSON.stringify(output)}${" ".repeat(VERIFIER_OUTPUT_EVIDENCE_MAX_BYTES)}`
      }),
    /exceeds 16777216 bytes/u
  );
});

test("verifier public evidence uses one 16 MiB per-file limit", () => {
  assert.equal(VERIFIER_PUBLIC_EVIDENCE_MAX_BYTES, 16 * 1024 * 1024);
  assert.equal(VERIFIER_OUTPUT_EVIDENCE_MAX_BYTES, VERIFIER_PUBLIC_EVIDENCE_MAX_BYTES);
  assert.equal(VERIFIER_ARTIFACT_MANIFEST_MAX_BYTES, VERIFIER_PUBLIC_EVIDENCE_MAX_BYTES);
});

test("verifier receipts reject more than 10,000 artifacts before enumerating them", () => {
  const layout = fixtureLayout("receipt-artifact-cap");
  const contents = "# Verified report\n";
  const output = fixtureOutput("attempt-one", "retry-one", contents);
  const fixture = fixtureManifest(layout, output, contents);
  const artifactManifest = snapshotVerifierArtifactManifest({
    layout,
    nodeId: "attempt-one",
    output,
    expectedOutputs: fixture.expectedOutputs
  });
  const ledgerEntry = createNodeAttemptLedgerEntry(layout, {
    nodeId: "node-one",
    strategyAttemptId: output.executor.strategy_attempt_id,
    executorRetryId: output.executor.executor_retry_id,
    checkpointGenerationId: output.executor.checkpoint_generation_id,
    workflowExecutionId: output.executor.workflow_execution_id,
    controllerInvocationId: output.executor.controller_invocation_id,
    startedAt: "2026-08-03T00:00:00.000Z",
    finishedAt: "2026-08-03T00:00:01.000Z",
    outcome: "succeeded",
    inputManifestDigest: "9".repeat(64),
    outputManifestDigest: artifactManifest.outputManifestDigest
  });
  const receipt = buildVerifierReceipt({
    layout,
    nodeId: "node-one",
    ledgerEntry,
    output,
    smithersOutputBytes: JSON.stringify(output),
    smithersOutputPath: verifierOutputEvidenceRelativePath("attempt-one", "retry-one"),
    artifactManifest
  }) as unknown as Record<string, unknown>;
  const artifacts: unknown[] = [];
  artifacts.length = VERIFIER_RECEIPT_MAX_ARTIFACTS + 1;
  Object.defineProperty(artifacts, 0, {
    get() {
      throw new Error("oversized receipt artifacts must not be enumerated");
    }
  });
  receipt.artifacts = artifacts;
  assert.throws(() => parseVerifierReceipt(receipt), /receipt artifact set is invalid/u);
});

test("verifier output evidence rejects truncation, transplant, symlink, and hardlink substitution", () => {
  const truncatedLayout = fixtureLayout("truncated-output");
  const truncatedOutput = fixtureOutput("attempt-one", "retry-one");
  const truncated = persistVerifierOutputEvidence({
    layout: truncatedLayout,
    output: truncatedOutput,
    smithersOutputBytes: `${JSON.stringify(truncatedOutput)}\n`
  });
  fs.writeFileSync(truncated.path, '{"schema_version":', "utf8");
  assert.throws(
    () => readVerifierOutputEvidence(truncatedLayout, "attempt-one", "retry-one"),
    /truncated or invalid JSON/u
  );

  const transplantLayout = fixtureLayout("transplanted-output");
  const original = fixtureOutput("attempt-one", "retry-one");
  const originalEvidence = persistVerifierOutputEvidence({
    layout: transplantLayout,
    output: original,
    smithersOutputBytes: `${JSON.stringify(original)}\n`
  });
  const transplantedRelative = verifierOutputEvidenceRelativePath("attempt-two", "retry-two");
  const transplantedPath = path.join(transplantLayout.root, ...transplantedRelative.split("/"));
  fs.mkdirSync(path.dirname(transplantedPath), { recursive: true });
  fs.copyFileSync(originalEvidence.path, transplantedPath);
  assert.throws(
    () => readVerifierOutputEvidence(transplantLayout, "attempt-two", "retry-two"),
    /transplanted across attempts/u
  );

  const symlinkLayout = fixtureLayout("symlink-output");
  const symlinkOutput = fixtureOutput("attempt-one", "retry-one");
  const symlinkRelative = verifierOutputEvidenceRelativePath("attempt-one", "retry-one");
  const symlinkPath = path.join(symlinkLayout.root, ...symlinkRelative.split("/"));
  const outsidePath = path.join(path.dirname(symlinkLayout.root), "outside-output.json");
  fs.mkdirSync(path.dirname(symlinkPath), { recursive: true });
  fs.writeFileSync(outsidePath, `${JSON.stringify(symlinkOutput)}\n`, "utf8");
  fs.symlinkSync(outsidePath, symlinkPath);
  assert.throws(
    () =>
      persistVerifierOutputEvidence({
        layout: symlinkLayout,
        output: symlinkOutput,
        smithersOutputBytes: `${JSON.stringify(symlinkOutput)}\n`
      }),
    /symlink|regular file/u
  );

  const hardlinkLayout = fixtureLayout("hardlink-output");
  const hardlinkOutput = fixtureOutput("attempt-one", "retry-one");
  const hardlinkEvidence = persistVerifierOutputEvidence({
    layout: hardlinkLayout,
    output: hardlinkOutput,
    smithersOutputBytes: `${JSON.stringify(hardlinkOutput)}\n`
  });
  fs.linkSync(hardlinkEvidence.path, path.join(path.dirname(hardlinkEvidence.path), "second-link.json"));
  assert.throws(() => readVerifierOutputEvidence(hardlinkLayout, "attempt-one", "retry-one"), /hard-linked/u);
});

test("verifier artifact snapshots bind exact no-follow bytes to the manifest closure", () => {
  const layout = fixtureLayout("artifact-manifest-snapshot");
  const contents = "# Verified report\n";
  const output = fixtureOutput("attempt-one", "retry-one", contents);
  const { expectedOutputs, manifestPath } = fixtureManifest(layout, output, contents);

  const snapshot = snapshotVerifierArtifactManifest({
    layout,
    nodeId: "attempt-one",
    output,
    expectedOutputs
  });

  assert.equal(
    snapshot.outputManifestDigest,
    crypto.createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex")
  );
  assert.equal(snapshot.artifactSetDigest, output.artifact_set_digest);
  assert.equal(snapshot.primaryArtifact, "report.md");
  assert.deepEqual(snapshot.artifacts, [{ ...output.artifacts[0], size_bytes: Buffer.byteLength(contents) }]);
});

test("verifier artifact snapshots reject public evidence larger than 16 MiB", () => {
  const layout = fixtureLayout("oversized-artifact-snapshot");
  const contents = "x".repeat(VERIFIER_PUBLIC_EVIDENCE_MAX_BYTES + 1);
  const output = fixtureOutput("attempt-one", "retry-one", contents);
  const fixture = fixtureManifest(layout, output, contents);

  assert.throws(
    () =>
      snapshotVerifierArtifactManifest({
        layout,
        nodeId: "attempt-one",
        output,
        expectedOutputs: fixture.expectedOutputs
      }),
    /verified artifact report\.md exceeds 16777216 bytes/u
  );
});

test("verifier receipts require the exact artifact-manifest snapshot", () => {
  const layout = fixtureLayout("receipt-manifest-binding");
  const contents = "# Verified report\n";
  const output = fixtureOutput("attempt-one", "retry-one", contents);
  const fixture = fixtureManifest(layout, output, contents);
  const artifactManifest = snapshotVerifierArtifactManifest({
    layout,
    nodeId: "attempt-one",
    output,
    expectedOutputs: fixture.expectedOutputs
  });
  const ledgerEntry = createNodeAttemptLedgerEntry(layout, {
    nodeId: "node-one",
    strategyAttemptId: output.executor.strategy_attempt_id,
    executorRetryId: output.executor.executor_retry_id,
    checkpointGenerationId: output.executor.checkpoint_generation_id,
    workflowExecutionId: output.executor.workflow_execution_id,
    controllerInvocationId: output.executor.controller_invocation_id,
    startedAt: "2026-08-03T00:00:00.000Z",
    finishedAt: "2026-08-03T00:00:01.000Z",
    outcome: "succeeded",
    inputManifestDigest: "9".repeat(64),
    outputManifestDigest: artifactManifest.outputManifestDigest
  });
  const smithersOutputBytes = `${JSON.stringify(output)}\n`;
  const receipt = buildVerifierReceipt({
    layout,
    nodeId: "node-one",
    ledgerEntry,
    output,
    smithersOutputBytes,
    smithersOutputPath: verifierOutputEvidenceRelativePath("attempt-one", "retry-one"),
    artifactManifest
  });
  assert.deepEqual(receipt.artifacts, output.artifacts);
  assert.equal(receipt.output_manifest_digest, artifactManifest.outputManifestDigest);

  const conflicting = structuredClone(artifactManifest);
  conflicting.artifacts[0]!.sha256 = "8".repeat(64);
  assert.throws(
    () =>
      buildVerifierReceipt({
        layout,
        nodeId: "node-one",
        ledgerEntry,
        output,
        smithersOutputBytes,
        smithersOutputPath: verifierOutputEvidenceRelativePath("attempt-one", "retry-one"),
        artifactManifest: conflicting
      }),
    /successful ledger lineage does not match verifier output/u
  );
});

test("verifier artifact snapshots reject manifest semantic mismatches", () => {
  const digestLayout = fixtureLayout("manifest-digest-mismatch");
  const contents = "# Verified report\n";
  const digestOutput = fixtureOutput("attempt-one", "retry-one", contents);
  const digestFixture = fixtureManifest(digestLayout, digestOutput, contents);
  const digestManifest = JSON.parse(fs.readFileSync(digestFixture.manifestPath, "utf8")) as {
    files: Array<{ path: string; sha256: string }>;
  };
  digestManifest.files.find((file) => file.path === "report.md")!.sha256 = "f".repeat(64);
  fs.writeFileSync(digestFixture.manifestPath, `${JSON.stringify(digestManifest, null, 2)}\n`, "utf8");
  assert.throws(
    () =>
      snapshotVerifierArtifactManifest({
        layout: digestLayout,
        nodeId: "attempt-one",
        output: digestOutput,
        expectedOutputs: digestFixture.expectedOutputs
      }),
    /receipt artifacts do not match the artifact manifest closure/u
  );

  const contractLayout = fixtureLayout("manifest-contract-mismatch");
  const contractOutput = fixtureOutput("attempt-one", "retry-one", contents);
  const contractFixture = fixtureManifest(contractLayout, contractOutput, contents);
  const contractManifest = JSON.parse(fs.readFileSync(contractFixture.manifestPath, "utf8")) as {
    output_contracts: Array<{ contract_digest: string }>;
  };
  contractManifest.output_contracts[0]!.contract_digest = "e".repeat(64);
  fs.writeFileSync(contractFixture.manifestPath, `${JSON.stringify(contractManifest, null, 2)}\n`, "utf8");
  assert.throws(
    () =>
      snapshotVerifierArtifactManifest({
        layout: contractLayout,
        nodeId: "attempt-one",
        output: contractOutput,
        expectedOutputs: contractFixture.expectedOutputs
      }),
    /artifact manifest output contract closure is inconsistent/u
  );
});

test("verifier artifact snapshots reject path replacement during descriptor reads", () => {
  const layout = fixtureLayout("artifact-path-race");
  const contents = "# Verified report\n";
  const output = fixtureOutput("attempt-one", "retry-one", contents);
  const fixture = fixtureManifest(layout, output, contents);
  const reportPath = path.join(fixture.artifactDir, "report.md");
  const displacedPath = path.join(fixture.artifactDir, "report.displaced.md");
  const originalOpenDescriptor = Object.getOwnPropertyDescriptor(fs, "openSync")!;
  const originalReadDescriptor = Object.getOwnPropertyDescriptor(fs, "readSync")!;
  const originalOpenSync = fs.openSync;
  const originalReadSync = fs.readSync;
  let reportDescriptor: number | undefined;
  let replaced = false;
  Object.defineProperty(fs, "openSync", {
    ...originalOpenDescriptor,
    value: (...args: unknown[]) => {
      const descriptor = Reflect.apply(originalOpenSync, fs, args) as number;
      if (args[0] === reportPath) reportDescriptor = descriptor;
      return descriptor;
    }
  });
  Object.defineProperty(fs, "readSync", {
    ...originalReadDescriptor,
    value: (...args: unknown[]) => {
      const descriptor = args[0] as number;
      const result = Reflect.apply(originalReadSync, fs, args) as number;
      if (!replaced && descriptor === reportDescriptor) {
        replaced = true;
        fs.renameSync(reportPath, displacedPath);
        fs.writeFileSync(reportPath, "# Replacement report\n", "utf8");
      }
      return result;
    }
  });
  try {
    assert.throws(
      () =>
        snapshotVerifierArtifactManifest({
          layout,
          nodeId: "attempt-one",
          output,
          expectedOutputs: fixture.expectedOutputs
        }),
      /changed while snapshotting/u
    );
    assert.equal(replaced, true);
  } finally {
    Object.defineProperty(fs, "readSync", originalReadDescriptor);
    Object.defineProperty(fs, "openSync", originalOpenDescriptor);
  }
});

test("verifier artifact snapshots reject symlink and hardlink substitution", () => {
  const contents = "# Verified report\n";
  const hardlinkLayout = fixtureLayout("artifact-hardlink");
  const hardlinkOutput = fixtureOutput("attempt-one", "retry-one", contents);
  const hardlinkFixture = fixtureManifest(hardlinkLayout, hardlinkOutput, contents);
  fs.linkSync(
    path.join(hardlinkFixture.artifactDir, "report.md"),
    path.join(hardlinkFixture.artifactDir, "report-second-link.md")
  );
  assert.throws(
    () =>
      snapshotVerifierArtifactManifest({
        layout: hardlinkLayout,
        nodeId: "attempt-one",
        output: hardlinkOutput,
        expectedOutputs: hardlinkFixture.expectedOutputs
      }),
    /single-link regular file/u
  );

  const symlinkLayout = fixtureLayout("manifest-symlink");
  const symlinkOutput = fixtureOutput("attempt-one", "retry-one", contents);
  const symlinkFixture = fixtureManifest(symlinkLayout, symlinkOutput, contents);
  const displacedManifest = path.join(symlinkFixture.artifactDir, "artifact-manifest.displaced.json");
  fs.renameSync(symlinkFixture.manifestPath, displacedManifest);
  fs.symlinkSync(displacedManifest, symlinkFixture.manifestPath);
  assert.throws(
    () =>
      snapshotVerifierArtifactManifest({
        layout: symlinkLayout,
        nodeId: "attempt-one",
        output: symlinkOutput,
        expectedOutputs: symlinkFixture.expectedOutputs
      }),
    /symlink|regular file/u
  );
});

function fixtureLayout(runId: string) {
  return createRunLayout({
    projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), `ufz-verifier-receipt-${runId}-`)),
    runId
  });
}

function fixtureOutput(
  strategyAttemptId: string,
  executorRetryId: string,
  artifactContents?: string
): VerificationOutput {
  const artifacts = [
    {
      path: "report.md",
      contract: "ultrafuzz/nonempty-markdown@1",
      contract_digest: "a".repeat(64),
      sha256:
        artifactContents === undefined
          ? "b".repeat(64)
          : crypto.createHash("sha256").update(artifactContents).digest("hex"),
      primary: true
    }
  ];
  const primaryArtifact = "report.md";
  const artifactSetDigest = digest({ artifacts, primary_artifact: primaryArtifact });
  const executor = {
    schema_version: "ultrafuzz.executor-result.v1" as const,
    execution_mode: "local" as const,
    workflow_run_id: "workflow-one",
    agent_task_id: `node:${strategyAttemptId}`,
    agent_iteration: 0,
    agent_attempt: 1,
    strategy_attempt_id: strategyAttemptId,
    workflow_execution_id: "execution-one",
    controller_invocation_id: "controller-one",
    checkpoint_generation_id: "checkpoint-one",
    executor_retry_id: executorRetryId,
    execution_identity: "c".repeat(64),
    request_fingerprint: "d".repeat(64),
    executor_result_digest: artifactSetDigest
  };
  const verifier = {
    workflow_run_id: "workflow-one",
    verifier_task_id: `verify:${strategyAttemptId}`,
    iteration: 0,
    attempt: 1,
    verification_identity: digest({
      executor,
      verifier_task_id: `verify:${strategyAttemptId}`,
      iteration: 0,
      attempt: 1,
      artifact_set_digest: artifactSetDigest
    })
  };
  return {
    schema_version: "ultrafuzz.verification-output.v2",
    executor,
    verifier,
    artifacts,
    primary_artifact: primaryArtifact,
    artifact_set_digest: artifactSetDigest
  };
}

function fixtureManifest(layout: ReturnType<typeof fixtureLayout>, output: VerificationOutput, contents: string) {
  const artifactDir = getNodeArtifactDir(layout, output.executor.strategy_attempt_id, { create: true });
  const manifestPath = path.join(artifactDir, "artifact-manifest.json");
  const expectedOutputs = [
    {
      path: "report.md",
      contract: "ultrafuzz/nonempty-markdown@1" as const,
      contract_digest: "a".repeat(64),
      primary: true
    }
  ];
  fs.writeFileSync(path.join(artifactDir, "report.md"), contents, "utf8");
  writeArtifactManifest({
    layout,
    nodeId: output.executor.strategy_attempt_id,
    include: ["report.md"],
    outputs: expectedOutputs,
    createdAt: "2026-08-03T00:00:00.000Z"
  });
  return { artifactDir, expectedOutputs, manifestPath };
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
