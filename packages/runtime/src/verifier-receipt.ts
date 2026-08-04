import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  ARTIFACT_MANIFEST_FILE,
  ARTIFACT_MANIFEST_SCHEMA_VERSION,
  assertPathInside,
  assertRegularFileInside,
  ensureSafeDirectory,
  safeResolveInside,
  validateSafeId,
  writeJsonDurable,
  type NodeAttemptLedgerEntry,
  type RunLayout
} from "@ultrafuzz/artifacts";

import type { PlannedArtifactOutput } from "./types.js";

export const EXECUTOR_RESULT_SCHEMA_VERSION = "ultrafuzz.executor-result.v1" as const;
export const VERIFICATION_OUTPUT_SCHEMA_VERSION = "ultrafuzz.verification-output.v2" as const;
export const VERIFIER_RECEIPT_SCHEMA_VERSION = "ultrafuzz.verifier-receipt.v1" as const;
export const VERIFIER_PUBLIC_EVIDENCE_MAX_BYTES = 16 * 1024 * 1024;
export const VERIFIER_OUTPUT_EVIDENCE_MAX_BYTES = VERIFIER_PUBLIC_EVIDENCE_MAX_BYTES;
export const VERIFIER_ARTIFACT_MANIFEST_MAX_BYTES = VERIFIER_PUBLIC_EVIDENCE_MAX_BYTES;
export const VERIFIER_RECEIPT_MAX_ARTIFACTS = 10_000;

const SNAPSHOT_READ_BUFFER_BYTES = 64 * 1024;

const dimensionId = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;
const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const digest = /^[0-9a-f]{64}$/u;

export interface ExecutorResult {
  schema_version: typeof EXECUTOR_RESULT_SCHEMA_VERSION;
  execution_mode: "local" | "cloud";
  workflow_run_id: string;
  agent_task_id: string;
  agent_iteration: number;
  agent_attempt: number;
  strategy_attempt_id: string;
  workflow_execution_id: string;
  controller_invocation_id: string;
  checkpoint_generation_id: string;
  executor_retry_id: string;
  execution_identity: string;
  request_fingerprint: string;
  executor_result_digest: string;
}

export interface VerifiedArtifactReceipt {
  path: string;
  contract: string;
  contract_digest: string;
  sha256: string;
  primary: boolean;
}

export interface VerificationOutput {
  schema_version: typeof VERIFICATION_OUTPUT_SCHEMA_VERSION;
  executor: ExecutorResult;
  verifier: {
    workflow_run_id: string;
    verifier_task_id: string;
    iteration: number;
    attempt: number;
    verification_identity: string;
  };
  artifacts: VerifiedArtifactReceipt[];
  primary_artifact: string;
  artifact_set_digest: string;
}

export interface VerifierReceipt {
  schema_version: typeof VERIFIER_RECEIPT_SCHEMA_VERSION;
  run_id: string;
  strategy_attempt_id: string;
  node_id: string;
  ledger_attempt_id: string;
  workflow_run_id: string;
  agent_task_id: string;
  agent_iteration: number;
  agent_attempt: number;
  verifier_task_id: string;
  workflow_execution_id: string;
  controller_invocation_id: string;
  checkpoint_generation_id: string;
  executor_retry_id: string;
  execution_identity: string;
  request_fingerprint: string;
  executor_result_digest: string;
  verifier_iteration: number;
  verifier_attempt: number;
  verification_identity: string;
  smithers_output_path: string;
  smithers_output_sha256: string;
  verification_output_digest: string;
  artifacts: VerifiedArtifactReceipt[];
  primary_artifact: string;
  artifact_set_digest: string;
  output_manifest_digest: string;
}

export interface VerifierArtifactManifestSnapshot {
  runId: string;
  nodeId: string;
  outputManifestDigest: string;
  artifactSetDigest: string;
  primaryArtifact: string;
  artifacts: Array<VerifiedArtifactReceipt & { size_bytes: number }>;
}

interface OpenStableFile {
  descriptor: number;
  filePath: string;
  label: string;
  root: string;
  stat: fs.BigIntStats;
}

export function parseVerificationOutput(value: unknown): VerificationOutput {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "schema_version",
      "executor",
      "verifier",
      "artifacts",
      "primary_artifact",
      "artifact_set_digest"
    ]) ||
    value.schema_version !== VERIFICATION_OUTPUT_SCHEMA_VERSION
  ) {
    throw new Error("verifier-receipt failure: verifier output metadata is invalid");
  }
  const executor = parseExecutorResult(value.executor);
  const verifier = value.verifier;
  if (
    !isPlainRecord(verifier) ||
    !hasExactKeys(verifier, ["workflow_run_id", "verifier_task_id", "iteration", "attempt", "verification_identity"]) ||
    !isDimensionId(verifier.workflow_run_id) ||
    !isDimensionId(verifier.verifier_task_id) ||
    !isNonNegativeInteger(verifier.iteration) ||
    !isNonNegativeInteger(verifier.attempt) ||
    !isDigest(verifier.verification_identity) ||
    verifier.workflow_run_id !== executor.workflow_run_id
  ) {
    throw new Error("verifier-receipt failure: verifier lineage is invalid");
  }
  if (
    !Array.isArray(value.artifacts) ||
    value.artifacts.length < 1 ||
    value.artifacts.length > VERIFIER_RECEIPT_MAX_ARTIFACTS
  ) {
    throw new Error("verifier-receipt failure: verified artifact set is invalid");
  }
  const artifacts = value.artifacts.map(parseVerifiedArtifact);
  if (new Set(artifacts.map((artifact) => artifact.path)).size !== artifacts.length) {
    throw new Error("verifier-receipt failure: verified artifact path is repeated");
  }
  if (
    typeof value.primary_artifact !== "string" ||
    artifacts.filter((artifact) => artifact.primary && artifact.path === value.primary_artifact).length !== 1 ||
    artifacts.filter((artifact) => artifact.primary).length !== 1 ||
    !isDigest(value.artifact_set_digest) ||
    canonicalDigest({ artifacts, primary_artifact: value.primary_artifact }) !== value.artifact_set_digest
  ) {
    throw new Error("verifier-receipt failure: verified artifact aggregate is invalid");
  }
  if (
    canonicalDigest({
      executor,
      verifier_task_id: verifier.verifier_task_id,
      iteration: verifier.iteration,
      attempt: verifier.attempt,
      artifact_set_digest: value.artifact_set_digest
    }) !== verifier.verification_identity
  ) {
    throw new Error("verifier-receipt failure: verifier identity digest is invalid");
  }
  return {
    schema_version: VERIFICATION_OUTPUT_SCHEMA_VERSION,
    executor,
    verifier: verifier as unknown as VerificationOutput["verifier"],
    artifacts,
    primary_artifact: value.primary_artifact,
    artifact_set_digest: value.artifact_set_digest
  };
}

export function extractVerificationOutput(value: unknown): VerificationOutput {
  if (isPlainRecord(value) && value.schema_version === VERIFICATION_OUTPUT_SCHEMA_VERSION) {
    return parseVerificationOutput(value);
  }
  if (isPlainRecord(value) && hasExactKeys(value, ["data"])) {
    return parseVerificationOutput(value.data);
  }
  if (isPlainRecord(value) && hasExactKeys(value, ["output"])) {
    return parseVerificationOutput(value.output);
  }
  throw new Error("verifier-receipt failure: workflow output row has an invalid envelope");
}

export function assertVerificationOutputMatchesArtifacts(input: {
  layout: RunLayout;
  nodeId: string;
  output: VerificationOutput;
  expectedOutputs: readonly PlannedArtifactOutput[];
}): void {
  const output = parseVerificationOutput(input.output);
  assertVerificationOutputDeclarations(output, input.expectedOutputs);
  snapshotVerifiedArtifacts(output, canonicalNodeArtifactDirectory(input.layout, input.nodeId));
}

export function snapshotVerifierArtifactManifest(input: {
  layout: RunLayout;
  nodeId: string;
  output: VerificationOutput;
  expectedOutputs: readonly PlannedArtifactOutput[];
}): VerifierArtifactManifestSnapshot {
  const output = parseVerificationOutput(input.output);
  assertVerificationOutputDeclarations(output, input.expectedOutputs);
  const artifactRoot = canonicalNodeArtifactDirectory(input.layout, input.nodeId);
  const opened: OpenStableFile[] = [];
  try {
    const manifest = openStableFile(
      artifactRoot,
      safeResolveInside(artifactRoot, ARTIFACT_MANIFEST_FILE, "artifact manifest path"),
      "artifact manifest"
    );
    opened.push(manifest);
    const artifactFiles = output.artifacts.map((artifact) => {
      const openedArtifact = openStableFile(
        artifactRoot,
        safeResolveInside(artifactRoot, artifact.path, `verified artifact ${artifact.path}`),
        `verified artifact ${artifact.path}`
      );
      opened.push(openedArtifact);
      return openedArtifact;
    });
    const manifestBytes = readStableBytes(manifest, VERIFIER_ARTIFACT_MANIFEST_MAX_BYTES);
    const artifactSnapshots = artifactFiles.map((file, index) => {
      const verified = output.artifacts[index]!;
      const snapshot = readStableDigest(file, VERIFIER_PUBLIC_EVIDENCE_MAX_BYTES);
      if (snapshot.sha256 !== verified.sha256) {
        throw new Error(`verifier-receipt failure: verified artifact bytes changed for ${verified.path}`);
      }
      return { ...verified, size_bytes: snapshot.sizeBytes };
    });
    for (const file of opened) assertStableFile(file);
    assertArtifactManifestClosure({
      bytes: manifestBytes,
      runId: input.layout.runId,
      nodeId: input.nodeId,
      expectedOutputs: input.expectedOutputs,
      artifactSnapshots
    });
    return {
      runId: input.layout.runId,
      nodeId: input.nodeId,
      outputManifestDigest: sha256Bytes(manifestBytes),
      artifactSetDigest: output.artifact_set_digest,
      primaryArtifact: output.primary_artifact,
      artifacts: artifactSnapshots
    };
  } finally {
    for (const file of opened.reverse()) fs.closeSync(file.descriptor);
  }
}

export function buildVerifierReceipt(input: {
  layout: RunLayout;
  nodeId: string;
  ledgerEntry: NodeAttemptLedgerEntry;
  output: VerificationOutput;
  smithersOutputBytes: string;
  smithersOutputPath: string;
  artifactManifest: VerifierArtifactManifestSnapshot;
}): VerifierReceipt {
  const { output, ledgerEntry } = input;
  if (
    ledgerEntry.run_id !== input.layout.runId ||
    ledgerEntry.strategy_attempt_id !== output.executor.strategy_attempt_id ||
    ledgerEntry.executor_retry_id !== output.executor.executor_retry_id ||
    ledgerEntry.workflow_execution_id !== output.executor.workflow_execution_id ||
    ledgerEntry.controller_invocation_id !== output.executor.controller_invocation_id ||
    ledgerEntry.checkpoint_generation_id !== output.executor.checkpoint_generation_id ||
    ledgerEntry.outcome !== "succeeded" ||
    ledgerEntry.manifests.output_sha256 !== input.artifactManifest.outputManifestDigest ||
    !isDigest(input.artifactManifest.outputManifestDigest) ||
    input.artifactManifest.runId !== input.layout.runId ||
    input.artifactManifest.nodeId !== output.executor.strategy_attempt_id ||
    input.artifactManifest.artifactSetDigest !== output.artifact_set_digest ||
    input.artifactManifest.primaryArtifact !== output.primary_artifact ||
    !verifiedArtifactsEqual(input.artifactManifest.artifacts, output.artifacts)
  ) {
    throw new Error("verifier-receipt failure: successful ledger lineage does not match verifier output");
  }
  return parseVerifierReceipt({
    schema_version: VERIFIER_RECEIPT_SCHEMA_VERSION,
    run_id: input.layout.runId,
    strategy_attempt_id: output.executor.strategy_attempt_id,
    node_id: input.nodeId,
    ledger_attempt_id: ledgerEntry.attempt_id,
    workflow_run_id: output.executor.workflow_run_id,
    agent_task_id: output.executor.agent_task_id,
    agent_iteration: output.executor.agent_iteration,
    agent_attempt: output.executor.agent_attempt,
    verifier_task_id: output.verifier.verifier_task_id,
    workflow_execution_id: output.executor.workflow_execution_id,
    controller_invocation_id: output.executor.controller_invocation_id,
    checkpoint_generation_id: output.executor.checkpoint_generation_id,
    executor_retry_id: output.executor.executor_retry_id,
    execution_identity: output.executor.execution_identity,
    request_fingerprint: output.executor.request_fingerprint,
    executor_result_digest: output.executor.executor_result_digest,
    verifier_iteration: output.verifier.iteration,
    verifier_attempt: output.verifier.attempt,
    verification_identity: output.verifier.verification_identity,
    smithers_output_path: input.smithersOutputPath,
    smithers_output_sha256: sha256Bytes(input.smithersOutputBytes),
    verification_output_digest: canonicalDigest(output),
    artifacts: output.artifacts,
    primary_artifact: output.primary_artifact,
    artifact_set_digest: output.artifact_set_digest,
    output_manifest_digest: input.artifactManifest.outputManifestDigest
  });
}

export function verifierReceiptMatchesArtifactManifest(
  receipt: VerifierReceipt,
  artifactManifest: VerifierArtifactManifestSnapshot
): boolean {
  return (
    receipt.run_id === artifactManifest.runId &&
    receipt.strategy_attempt_id === artifactManifest.nodeId &&
    receipt.output_manifest_digest === artifactManifest.outputManifestDigest &&
    receipt.artifact_set_digest === artifactManifest.artifactSetDigest &&
    receipt.primary_artifact === artifactManifest.primaryArtifact &&
    verifiedArtifactsEqual(receipt.artifacts, artifactManifest.artifacts)
  );
}

export function verifierOutputEvidenceRelativePath(strategyAttemptId: string, executorRetryId: string): string {
  const attemptId = validateSafeId(strategyAttemptId, "strategy attempt ID");
  const retryId = validateSafeId(executorRetryId, "executor retry ID");
  return path.posix.join("review", "verifier-receipts", attemptId, `${retryId}.smithers-output.json`);
}

export function persistVerifierOutputEvidence(input: {
  layout: RunLayout;
  output: VerificationOutput;
  smithersOutputBytes: string;
}): { path: string; relativePath: string; digest: string } {
  const output = parseVerificationOutput(input.output);
  const bytes = Buffer.from(input.smithersOutputBytes, "utf8");
  assertBoundedVerifierOutputBytes(bytes);
  const parsedOutput = parseVerifierOutputBytes(bytes);
  if (JSON.stringify(parsedOutput) !== JSON.stringify(output)) {
    throw new Error("verifier-receipt failure: exact workflow output bytes do not match parsed verifier output");
  }
  const relativePath = verifierOutputEvidenceRelativePath(
    output.executor.strategy_attempt_id,
    output.executor.executor_retry_id
  );
  const receiptsRoot = ensureSafeDirectory(input.layout.reviewDir, "verifier-receipts");
  const attemptRoot = ensureSafeDirectory(receiptsRoot, output.executor.strategy_attempt_id);
  const evidencePath = safeResolveInside(
    attemptRoot,
    `${validateSafeId(output.executor.executor_retry_id, "executor retry ID")}.smithers-output.json`,
    "verifier output evidence path"
  );
  persistExactEvidenceBytes(attemptRoot, evidencePath, bytes);
  return { path: evidencePath, relativePath, digest: sha256Bytes(bytes) };
}

export function readVerifierOutputEvidence(
  layout: RunLayout,
  strategyAttemptId: string,
  executorRetryId: string
): { output: VerificationOutput; bytes: string; path: string; relativePath: string; digest: string } {
  const relativePath = verifierOutputEvidenceRelativePath(strategyAttemptId, executorRetryId);
  const receiptsRoot = ensureSafeDirectory(layout.reviewDir, "verifier-receipts");
  const attemptRoot = ensureSafeDirectory(receiptsRoot, strategyAttemptId);
  const evidencePath = safeResolveInside(
    attemptRoot,
    `${validateSafeId(executorRetryId, "executor retry ID")}.smithers-output.json`,
    "verifier output evidence path"
  );
  assertRegularFileInside(attemptRoot, evidencePath, "verifier output evidence");
  if (fs.lstatSync(evidencePath).nlink !== 1) {
    throw new Error("verifier-receipt failure: persisted workflow output is hard-linked");
  }
  const bytes = fs.readFileSync(evidencePath);
  assertBoundedVerifierOutputBytes(bytes);
  const output = parseVerifierOutputBytes(bytes);
  if (
    output.executor.strategy_attempt_id !== validateSafeId(strategyAttemptId, "strategy attempt ID") ||
    output.executor.executor_retry_id !== validateSafeId(executorRetryId, "executor retry ID")
  ) {
    throw new Error("verifier-receipt failure: persisted workflow output was transplanted across attempts");
  }
  return {
    output,
    bytes: bytes.toString("utf8"),
    path: evidencePath,
    relativePath,
    digest: sha256Bytes(bytes)
  };
}

export function persistVerifierReceipt(layout: RunLayout, receipt: VerifierReceipt): { path: string; digest: string } {
  const parsed = parseVerifierReceipt(receipt);
  const attemptId = validateSafeId(parsed.strategy_attempt_id, "strategy attempt ID");
  const retryId = validateSafeId(parsed.executor_retry_id, "executor retry ID");
  const receiptsRoot = ensureSafeDirectory(layout.reviewDir, "verifier-receipts");
  const attemptRoot = ensureSafeDirectory(receiptsRoot, attemptId);
  const receiptPath = safeResolveInside(attemptRoot, `${retryId}.json`, "verifier receipt path");
  if (fs.existsSync(receiptPath)) {
    assertRegularFileInside(attemptRoot, receiptPath, "verifier receipt");
    if (fs.lstatSync(receiptPath).nlink !== 1) {
      throw new Error("verifier-receipt failure: persisted receipt is hard-linked");
    }
    const existing = parseVerifierReceipt(JSON.parse(fs.readFileSync(receiptPath, "utf8")) as unknown);
    if (JSON.stringify(existing) !== JSON.stringify(parsed)) {
      throw new Error("verifier-receipt failure: executor retry already has a conflicting receipt");
    }
  } else {
    writeJsonDurable(receiptPath, parsed);
  }
  return { path: receiptPath, digest: canonicalDigest(parsed) };
}

export function readVerifierReceipt(
  layout: RunLayout,
  strategyAttemptId: string,
  executorRetryId: string
): { receipt: VerifierReceipt; path: string; digest: string } {
  const attemptId = validateSafeId(strategyAttemptId, "strategy attempt ID");
  const retryId = validateSafeId(executorRetryId, "executor retry ID");
  const receiptsRoot = ensureSafeDirectory(layout.reviewDir, "verifier-receipts");
  const attemptRoot = ensureSafeDirectory(receiptsRoot, attemptId);
  const receiptPath = safeResolveInside(attemptRoot, `${retryId}.json`, "verifier receipt path");
  assertRegularFileInside(attemptRoot, receiptPath, "verifier receipt");
  if (fs.lstatSync(receiptPath).nlink !== 1) {
    throw new Error("verifier-receipt failure: persisted receipt is hard-linked");
  }
  const receipt = parseVerifierReceipt(JSON.parse(fs.readFileSync(receiptPath, "utf8")) as unknown);
  if (receipt.strategy_attempt_id !== attemptId || receipt.executor_retry_id !== retryId) {
    throw new Error("verifier-receipt failure: persisted receipt key does not match its lineage");
  }
  return { receipt, path: receiptPath, digest: canonicalDigest(receipt) };
}

export function parseVerifierReceipt(value: unknown): VerifierReceipt {
  const keys = [
    "schema_version",
    "run_id",
    "strategy_attempt_id",
    "node_id",
    "ledger_attempt_id",
    "workflow_run_id",
    "agent_task_id",
    "agent_iteration",
    "agent_attempt",
    "verifier_task_id",
    "workflow_execution_id",
    "controller_invocation_id",
    "checkpoint_generation_id",
    "executor_retry_id",
    "execution_identity",
    "request_fingerprint",
    "executor_result_digest",
    "verifier_iteration",
    "verifier_attempt",
    "verification_identity",
    "smithers_output_path",
    "smithers_output_sha256",
    "verification_output_digest",
    "artifacts",
    "primary_artifact",
    "artifact_set_digest",
    "output_manifest_digest"
  ];
  if (!isPlainRecord(value) || !hasExactKeys(value, keys) || value.schema_version !== VERIFIER_RECEIPT_SCHEMA_VERSION) {
    throw new Error("verifier-receipt failure: receipt metadata is invalid");
  }
  for (const key of ["run_id", "strategy_attempt_id", "node_id"] as const) {
    if (typeof value[key] !== "string" || !safeId.test(value[key])) {
      throw new Error("verifier-receipt failure: receipt safe identity is invalid");
    }
  }
  for (const key of [
    "ledger_attempt_id",
    "workflow_run_id",
    "agent_task_id",
    "verifier_task_id",
    "workflow_execution_id",
    "controller_invocation_id",
    "checkpoint_generation_id",
    "executor_retry_id"
  ] as const) {
    if (!isDimensionId(value[key])) throw new Error("verifier-receipt failure: receipt lineage is invalid");
  }
  if (
    value.smithers_output_path !==
    verifierOutputEvidenceRelativePath(value.strategy_attempt_id as string, value.executor_retry_id as string)
  ) {
    throw new Error("verifier-receipt failure: receipt workflow output path is invalid");
  }
  for (const key of [
    "execution_identity",
    "request_fingerprint",
    "executor_result_digest",
    "verification_identity",
    "smithers_output_sha256",
    "verification_output_digest",
    "artifact_set_digest",
    "output_manifest_digest"
  ] as const) {
    if (!isDigest(value[key])) throw new Error("verifier-receipt failure: receipt digest is invalid");
  }
  if (
    !isNonNegativeInteger(value.agent_iteration) ||
    !isNonNegativeInteger(value.agent_attempt) ||
    !isNonNegativeInteger(value.verifier_iteration) ||
    !isNonNegativeInteger(value.verifier_attempt)
  ) {
    throw new Error("verifier-receipt failure: receipt task attempt is invalid");
  }
  if (
    !Array.isArray(value.artifacts) ||
    value.artifacts.length < 1 ||
    value.artifacts.length > VERIFIER_RECEIPT_MAX_ARTIFACTS
  ) {
    throw new Error("verifier-receipt failure: receipt artifact set is invalid");
  }
  const artifacts = value.artifacts.map(parseVerifiedArtifact);
  if (
    new Set(artifacts.map((artifact) => artifact.path)).size !== artifacts.length ||
    typeof value.primary_artifact !== "string" ||
    artifacts.filter((artifact) => artifact.primary && artifact.path === value.primary_artifact).length !== 1 ||
    artifacts.filter((artifact) => artifact.primary).length !== 1 ||
    canonicalDigest({ artifacts, primary_artifact: value.primary_artifact }) !== value.artifact_set_digest
  ) {
    throw new Error("verifier-receipt failure: receipt artifact aggregate is invalid");
  }
  return { ...value, artifacts } as unknown as VerifierReceipt;
}

export function verifierReceiptDigest(receipt: VerifierReceipt): string {
  return canonicalDigest(parseVerifierReceipt(receipt));
}

export function verificationOutputDigest(output: VerificationOutput): string {
  return canonicalDigest(parseVerificationOutput(output));
}

export function verifierOutputBytesDigest(value: string): string {
  return sha256Bytes(value);
}

function assertVerificationOutputDeclarations(
  output: VerificationOutput,
  expectedOutputs: readonly PlannedArtifactOutput[]
): void {
  if (output.artifacts.length !== expectedOutputs.length) {
    throw new Error("verifier-receipt failure: verifier output artifact closure is incomplete");
  }
  for (const [index, declaration] of expectedOutputs.entries()) {
    const verified = output.artifacts[index];
    if (
      verified === undefined ||
      verified.path !== declaration.path ||
      verified.contract !== declaration.contract ||
      verified.contract_digest !== declaration.contract_digest ||
      verified.primary !== declaration.primary
    ) {
      throw new Error("verifier-receipt failure: verifier output does not match the artifact contract closure");
    }
  }
}

function snapshotVerifiedArtifacts(output: VerificationOutput, artifactDir: string): void {
  const artifactRoot = canonicalDirectory(artifactDir, "artifact root");
  const opened: OpenStableFile[] = [];
  try {
    for (const artifact of output.artifacts) {
      const file = openStableFile(
        artifactRoot,
        safeResolveInside(artifactRoot, artifact.path, `verified artifact ${artifact.path}`),
        `verified artifact ${artifact.path}`
      );
      opened.push(file);
    }
    for (const [index, file] of opened.entries()) {
      const artifact = output.artifacts[index]!;
      if (readStableDigest(file, VERIFIER_PUBLIC_EVIDENCE_MAX_BYTES).sha256 !== artifact.sha256) {
        throw new Error(`verifier-receipt failure: verified artifact bytes changed for ${artifact.path}`);
      }
    }
    for (const file of opened) assertStableFile(file);
  } finally {
    for (const file of opened.reverse()) fs.closeSync(file.descriptor);
  }
}

function assertArtifactManifestClosure(input: {
  bytes: Buffer;
  runId: string;
  nodeId: string;
  expectedOutputs: readonly PlannedArtifactOutput[];
  artifactSnapshots: ReadonlyArray<VerifiedArtifactReceipt & { size_bytes: number }>;
}): void {
  let value: unknown;
  try {
    value = JSON.parse(input.bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("verifier-receipt failure: artifact manifest snapshot is not valid JSON", { cause: error });
  }
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "schema_version",
      "run_id",
      "node_id",
      "producer_node_id",
      "created_at",
      "files",
      "output_contracts",
      "prerequisite_manifests",
      "provenance"
    ]) ||
    value.schema_version !== ARTIFACT_MANIFEST_SCHEMA_VERSION ||
    value.run_id !== input.runId ||
    value.node_id !== input.nodeId ||
    value.producer_node_id !== input.nodeId ||
    typeof value.created_at !== "string" ||
    value.created_at.length < 1 ||
    !isPlainRecord(value.provenance) ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.output_contracts) ||
    !Array.isArray(value.prerequisite_manifests)
  ) {
    throw new Error("verifier-receipt failure: artifact manifest metadata is invalid");
  }
  const files = value.files.map((entry) => {
    if (
      !isPlainRecord(entry) ||
      !hasExactKeys(entry, ["path", "size_bytes", "sha256", "provenance"]) ||
      typeof entry.path !== "string" ||
      entry.path.length < 1 ||
      !Number.isSafeInteger(entry.size_bytes) ||
      typeof entry.size_bytes !== "number" ||
      entry.size_bytes < 0 ||
      !isDigest(entry.sha256) ||
      !isPlainRecord(entry.provenance)
    ) {
      throw new Error("verifier-receipt failure: artifact manifest file entry is invalid");
    }
    return { path: entry.path, size_bytes: entry.size_bytes, sha256: entry.sha256 };
  });
  if (new Set(files.map((entry) => entry.path)).size !== files.length) {
    throw new Error("verifier-receipt failure: artifact manifest repeats a file path");
  }
  const outputContracts = value.output_contracts.map((entry) => {
    if (
      !isPlainRecord(entry) ||
      !hasExactKeys(entry, ["path", "contract", "contract_digest", "primary"]) ||
      typeof entry.path !== "string" ||
      typeof entry.contract !== "string" ||
      !isDigest(entry.contract_digest) ||
      typeof entry.primary !== "boolean"
    ) {
      throw new Error("verifier-receipt failure: artifact manifest output contract is invalid");
    }
    return {
      path: entry.path,
      contract: entry.contract,
      contract_digest: entry.contract_digest,
      primary: entry.primary
    };
  });
  for (const prerequisite of value.prerequisite_manifests) {
    if (
      !isPlainRecord(prerequisite) ||
      !hasExactKeys(prerequisite, ["node_id", "sha256"]) ||
      typeof prerequisite.node_id !== "string" ||
      !safeId.test(prerequisite.node_id) ||
      !isDigest(prerequisite.sha256)
    ) {
      throw new Error("verifier-receipt failure: artifact manifest prerequisite is invalid");
    }
  }
  const expectedOutputs = input.expectedOutputs.map((entry) => ({
    path: entry.path,
    contract: entry.contract,
    contract_digest: entry.contract_digest,
    primary: entry.primary
  }));
  if (JSON.stringify(outputContracts) !== JSON.stringify(expectedOutputs)) {
    throw new Error("verifier-receipt failure: artifact manifest output contract closure is inconsistent");
  }
  if (input.artifactSnapshots.length !== input.expectedOutputs.length) {
    throw new Error("verifier-receipt failure: artifact manifest receipt closure is incomplete");
  }
  const filesByPath = new Map(files.map((entry) => [entry.path, entry]));
  for (const [index, snapshot] of input.artifactSnapshots.entries()) {
    const declaration = input.expectedOutputs[index];
    const manifestFile = filesByPath.get(snapshot.path);
    if (
      declaration === undefined ||
      snapshot.path !== declaration.path ||
      snapshot.contract !== declaration.contract ||
      snapshot.contract_digest !== declaration.contract_digest ||
      snapshot.primary !== declaration.primary ||
      manifestFile?.sha256 !== snapshot.sha256 ||
      manifestFile.size_bytes !== snapshot.size_bytes
    ) {
      throw new Error("verifier-receipt failure: receipt artifacts do not match the artifact manifest closure");
    }
  }
}

function verifiedArtifactsEqual(
  left: ReadonlyArray<VerifiedArtifactReceipt>,
  right: ReadonlyArray<VerifiedArtifactReceipt>
): boolean {
  return (
    left.length === right.length &&
    left.every((artifact, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        artifact.path === candidate.path &&
        artifact.contract === candidate.contract &&
        artifact.contract_digest === candidate.contract_digest &&
        artifact.sha256 === candidate.sha256 &&
        artifact.primary === candidate.primary
      );
    })
  );
}

function canonicalDirectory(directory: string, label: string): string {
  const absolute = path.resolve(directory);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    throw new Error(`verifier-receipt failure: ${label} does not exist`, { cause: error });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`verifier-receipt failure: ${label} is unsafe`);
  }
  return fs.realpathSync(absolute);
}

function canonicalNodeArtifactDirectory(layout: RunLayout, nodeId: string): string {
  const runRoot = canonicalDirectory(layout.root, "run root");
  const expectedArtifactsPath = safeResolveInside(runRoot, "artifacts", "artifacts root");
  if (path.resolve(layout.artifactsDir) !== path.resolve(layout.root, "artifacts")) {
    throw new Error("verifier-receipt failure: run artifact layout is inconsistent");
  }
  const artifactsRoot = canonicalDirectory(expectedArtifactsPath, "artifacts root");
  const artifactRoot = canonicalDirectory(
    safeResolveInside(artifactsRoot, validateSafeId(nodeId, "strategy attempt ID"), "artifact root"),
    "artifact root"
  );
  assertPathInside(artifactsRoot, artifactRoot, "artifact root");
  return artifactRoot;
}

function openStableFile(root: string, filePath: string, label: string): OpenStableFile {
  assertRegularFileInside(root, filePath, label);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) {
      throw new Error(`verifier-receipt failure: ${label} must be a single-link regular file`);
    }
    assertOpenFilePathIdentity(root, filePath, stat, label);
    return { descriptor, filePath, label, root, stat };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error instanceof Error && error.message.startsWith("verifier-receipt failure:")) throw error;
    throw new Error(`verifier-receipt failure: ${label} could not be opened safely`, { cause: error });
  }
}

function assertStableFile(file: OpenStableFile): void {
  const current = fs.fstatSync(file.descriptor, { bigint: true });
  if (!sameSnapshotStat(file.stat, current)) {
    throw new Error(`verifier-receipt failure: ${file.label} changed while snapshotting`);
  }
  assertOpenFilePathIdentity(file.root, file.filePath, current, file.label);
}

function assertOpenFilePathIdentity(
  root: string,
  filePath: string,
  descriptorStat: fs.BigIntStats,
  label: string
): void {
  let pathStat: fs.BigIntStats;
  let resolved: string;
  try {
    pathStat = fs.lstatSync(filePath, { bigint: true });
    resolved = fs.realpathSync(filePath);
  } catch (error) {
    throw new Error(`verifier-receipt failure: ${label} path changed while snapshotting`, { cause: error });
  }
  assertPathInside(root, resolved, label);
  if (
    pathStat.isSymbolicLink() ||
    !pathStat.isFile() ||
    pathStat.nlink !== 1n ||
    pathStat.dev !== descriptorStat.dev ||
    pathStat.ino !== descriptorStat.ino
  ) {
    throw new Error(`verifier-receipt failure: ${label} path changed while snapshotting`);
  }
}

function sameSnapshotStat(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function stableFileSize(file: OpenStableFile, maximum?: number): number {
  const size = Number(file.stat.size);
  if (!Number.isSafeInteger(size) || size < 0 || (maximum !== undefined && size > maximum)) {
    throw new Error(
      maximum === undefined
        ? `verifier-receipt failure: ${file.label} size is invalid`
        : `verifier-receipt failure: ${file.label} exceeds ${maximum} bytes`
    );
  }
  return size;
}

function readStableBytes(file: OpenStableFile, maximum: number): Buffer {
  const size = stableFileSize(file, maximum);
  const bytes = Buffer.allocUnsafe(size);
  readDescriptorExactly(file, bytes);
  return bytes;
}

function readStableDigest(file: OpenStableFile, maximum?: number): { sha256: string; sizeBytes: number } {
  const sizeBytes = stableFileSize(file, maximum);
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(SNAPSHOT_READ_BUFFER_BYTES, sizeBytes)));
  let position = 0;
  while (position < sizeBytes) {
    const length = Math.min(buffer.byteLength, sizeBytes - position);
    const read = fs.readSync(file.descriptor, buffer, 0, length, position);
    if (read < 1) throw new Error(`verifier-receipt failure: ${file.label} was truncated while snapshotting`);
    hash.update(buffer.subarray(0, read));
    position += read;
  }
  assertDescriptorEof(file, sizeBytes);
  return { sha256: hash.digest("hex"), sizeBytes };
}

function readDescriptorExactly(file: OpenStableFile, target: Buffer): void {
  let position = 0;
  while (position < target.byteLength) {
    const read = fs.readSync(file.descriptor, target, position, target.byteLength - position, position);
    if (read < 1) throw new Error(`verifier-receipt failure: ${file.label} was truncated while snapshotting`);
    position += read;
  }
  assertDescriptorEof(file, target.byteLength);
}

function assertDescriptorEof(file: OpenStableFile, position: number): void {
  const extra = Buffer.allocUnsafe(1);
  if (fs.readSync(file.descriptor, extra, 0, 1, position) !== 0) {
    throw new Error(`verifier-receipt failure: ${file.label} grew while snapshotting`);
  }
}

function parseExecutorResult(value: unknown): ExecutorResult {
  const keys = [
    "schema_version",
    "execution_mode",
    "workflow_run_id",
    "agent_task_id",
    "agent_iteration",
    "agent_attempt",
    "strategy_attempt_id",
    "workflow_execution_id",
    "controller_invocation_id",
    "checkpoint_generation_id",
    "executor_retry_id",
    "execution_identity",
    "request_fingerprint",
    "executor_result_digest"
  ];
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, keys) ||
    value.schema_version !== EXECUTOR_RESULT_SCHEMA_VERSION ||
    (value.execution_mode !== "local" && value.execution_mode !== "cloud") ||
    !isDimensionId(value.workflow_run_id) ||
    !isDimensionId(value.agent_task_id) ||
    !isNonNegativeInteger(value.agent_iteration) ||
    !isNonNegativeInteger(value.agent_attempt) ||
    !isDimensionId(value.strategy_attempt_id) ||
    !isDimensionId(value.workflow_execution_id) ||
    !isDimensionId(value.controller_invocation_id) ||
    !isDimensionId(value.checkpoint_generation_id) ||
    !isDimensionId(value.executor_retry_id) ||
    !isDigest(value.execution_identity) ||
    !isDigest(value.request_fingerprint) ||
    !isDigest(value.executor_result_digest)
  ) {
    throw new Error("verifier-receipt failure: executor result lineage is invalid");
  }
  return value as unknown as ExecutorResult;
}

function parseVerifiedArtifact(value: unknown): VerifiedArtifactReceipt {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["path", "contract", "contract_digest", "sha256", "primary"]) ||
    typeof value.path !== "string" ||
    value.path.length < 1 ||
    path.isAbsolute(value.path) ||
    value.path.split(/[\\/]/u).some((segment) => segment === "" || segment === "." || segment === "..") ||
    typeof value.contract !== "string" ||
    value.contract.length < 1 ||
    !isDigest(value.contract_digest) ||
    !isDigest(value.sha256) ||
    typeof value.primary !== "boolean"
  ) {
    throw new Error("verifier-receipt failure: verified artifact entry is invalid");
  }
  return value as unknown as VerifiedArtifactReceipt;
}

function canonicalDigest(value: unknown): string {
  return sha256Bytes(JSON.stringify(value));
}

function sha256Bytes(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseVerifierOutputBytes(bytes: Buffer): VerificationOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("verifier-receipt failure: exact workflow output is truncated or invalid JSON", { cause: error });
  }
  return extractVerificationOutput(parsed);
}

function assertBoundedVerifierOutputBytes(bytes: Buffer): void {
  if (bytes.byteLength < 1 || bytes.byteLength > VERIFIER_OUTPUT_EVIDENCE_MAX_BYTES) {
    throw new Error(
      `verifier-receipt failure: exact workflow output exceeds ${VERIFIER_OUTPUT_EVIDENCE_MAX_BYTES} bytes`
    );
  }
}

function persistExactEvidenceBytes(root: string, filePath: string, bytes: Buffer): void {
  if (fs.existsSync(filePath)) {
    assertRegularFileInside(root, filePath, "verifier output evidence");
    if (fs.lstatSync(filePath).nlink !== 1 || !fs.readFileSync(filePath).equals(bytes)) {
      throw new Error("verifier-receipt failure: executor retry already has conflicting workflow output bytes");
    }
    return;
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600
    );
    let offset = 0;
    while (offset < bytes.byteLength) {
      offset += fs.writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    }
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  const directoryDescriptor = fs.openSync(root, "r");
  try {
    fs.fsyncSync(directoryDescriptor);
  } finally {
    fs.closeSync(directoryDescriptor);
  }
  assertRegularFileInside(root, filePath, "verifier output evidence");
  if (fs.lstatSync(filePath).nlink !== 1) {
    throw new Error("verifier-receipt failure: persisted workflow output is hard-linked");
  }
}

function isDimensionId(value: unknown): value is string {
  return typeof value === "string" && dimensionId.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && digest.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}
