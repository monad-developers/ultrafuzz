import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  assertFindingsSchema,
  assertNodeAttemptLedgerEntry,
  assertUsageLedgerEntry,
  type NodeAttemptLedgerEntry,
  type UsageLedgerEntry
} from "@ultrafuzz/artifacts";
import {
  MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES,
  MAX_TERMINAL_EVIDENCE_BYTES,
  PUBLIC_EVAL_DIAGNOSTICS_FILE,
  PUBLIC_EVAL_DIAGNOSTICS_SCHEMA_VERSION,
  PUBLIC_EVAL_DIAGNOSTICS_V2_SCHEMA_VERSION,
  PUBLIC_EVAL_DIAGNOSTICS_V3_SCHEMA_VERSION,
  TERMINAL_EVIDENCE_BINDING_SCHEMA_VERSION,
  boundedEvalId,
  classifyTerminalDisposition,
  parseRecoveryEquivalence,
  parsePublicEvalDiagnostics,
  publicEvalDiagnosticsRowIsFailedDatapoint,
  type PublicModelIdentity,
  type PublicPricingEvidence,
  type TerminalEvidenceBinding
} from "@ultrafuzz/evals";
import {
  WORKSPACE_SOURCE_ATTESTATION_FILE,
  VERIFIER_PUBLIC_EVIDENCE_MAX_BYTES,
  VERIFIER_RECEIPT_MAX_ARTIFACTS,
  extractVerificationOutput,
  modelPricingFromCatalogBytes,
  parseVerifierReceipt,
  parseWorkspaceSourceAttestation,
  verificationOutputDigest,
  verifierOutputBytesDigest,
  verifierReceiptDigest,
  verifyOfflineWorkflowControlBytes,
  type ModelPricing,
  type VerifierReceipt,
  type WorkspaceSourceAttestation
} from "@ultrafuzz/runtime";
import { redactSecretsInText } from "@ultrafuzz/security";
import { z } from "zod/v4";

import type { ModalWorkerLineage } from "./launch-state.js";

export const PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION = "ultrafuzz.modal.public-benchmark-bundle.v7" as const;
export const PUBLIC_BENCHMARK_BUNDLE_V6_SCHEMA_VERSION = "ultrafuzz.modal.public-benchmark-bundle.v6" as const;
export const PUBLIC_BENCHMARK_BUNDLE_PREVIOUS_SCHEMA_VERSION = PUBLIC_BENCHMARK_BUNDLE_V6_SCHEMA_VERSION;
export const PUBLIC_BENCHMARK_BUNDLE_V5_SCHEMA_VERSION = "ultrafuzz.modal.public-benchmark-bundle.v5" as const;
export const PUBLIC_BENCHMARK_BUNDLE_V4_SCHEMA_VERSION = "ultrafuzz.modal.public-benchmark-bundle.v4" as const;
export const PUBLIC_BENCHMARK_BUNDLE_LEGACY_SCHEMA_VERSION = "ultrafuzz.modal.public-benchmark-bundle.v3" as const;
export const MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES = 256 * 1024 * 1024;

export type PublicBenchmarkBundleSchemaVersion =
  | typeof PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION
  | typeof PUBLIC_BENCHMARK_BUNDLE_V6_SCHEMA_VERSION
  | typeof PUBLIC_BENCHMARK_BUNDLE_V5_SCHEMA_VERSION
  | typeof PUBLIC_BENCHMARK_BUNDLE_V4_SCHEMA_VERSION
  | typeof PUBLIC_BENCHMARK_BUNDLE_LEGACY_SCHEMA_VERSION;

export interface PublicBenchmarkBundleAccessOptions {
  /**
   * Select the one schema the caller intends to trust. A bundle-controlled
   * discriminator is never used as a compatibility negotiation mechanism.
   */
  expectedSchemaVersion: PublicBenchmarkBundleSchemaVersion;
  forbiddenSecretValues?: readonly string[];
}

export const MAX_PUBLIC_BENCHMARK_FILE_BYTES = VERIFIER_PUBLIC_EVIDENCE_MAX_BYTES;
const MAX_FILE_BASE64_CHARACTERS = 4 * Math.ceil(MAX_PUBLIC_BENCHMARK_FILE_BYTES / 3);
const MAX_ROWS = 2_048;
export const PUBLIC_SOURCE_ATTESTATION_FILE = WORKSPACE_SOURCE_ATTESTATION_FILE;
const BASE_PUBLIC_REPORT_FILES = ["report.md", "report.json", "findings.normalized.json"] as const;
const PUBLIC_REPORT_FILES = [...BASE_PUBLIC_REPORT_FILES, PUBLIC_SOURCE_ATTESTATION_FILE] as const;
const PUBLIC_EXECUTION_EVIDENCE_DIRECTORY = "execution-evidence";
const PUBLIC_ATTEMPT_LEDGER_FILE = "attempts.jsonl";
export const PUBLIC_RUN_METADATA_FILE = "run.json" as const;
export const PUBLIC_USAGE_LEDGER_FILE = "usage.jsonl" as const;
export const PUBLIC_PRICING_CATALOGS_DIRECTORY = "pricing-catalogs" as const;
export const PUBLIC_TERMINAL_EVIDENCE_DIRECTORY = "terminal" as const;
export const PUBLIC_TERMINAL_EVIDENCE_FILES = [
  "state.json",
  "graph.json",
  "smithers/tasks.json",
  "smithers/control-integrity.json",
  "smithers/expanded-graph.json",
  "smithers/config.fingerprint-input"
] as const;
const SMOKE_MODEL_BACKED_NODE_IDS = [
  "dedupe-findings",
  "external-dependency-boundaries",
  "externalized-state-accounting",
  "final-report",
  "lifecycle-view-boundaries",
  "smoke-context",
  "time-warp-sequences"
] as const;
const DEFAULT_PUBLICATION_BUNDLE_PATH = "public-results.json";
const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const fullSha = z.string().regex(/^[0-9a-f]{40}$/u);
const terminalEvidenceBindingSchema = z.strictObject({
  schema_version: z.literal(TERMINAL_EVIDENCE_BINDING_SCHEMA_VERSION),
  state_sha256: sha256,
  tasks_sha256: sha256,
  control_integrity_sha256: sha256,
  graph_sha256: sha256,
  expanded_graph_sha256: sha256,
  config_fingerprint_input_sha256: sha256,
  run_metadata_sha256: sha256,
  usage_ledger_sha256: sha256,
  pricing_catalog_sha256: sha256.nullable()
});
const caseCount = z.number().int().nonnegative().max(MAX_ROWS);
const repositoryUrl = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === "https:" || parsed.protocol === "http:") &&
        parsed.username === "" &&
        parsed.password === "" &&
        parsed.search === "" &&
        parsed.hash === ""
      );
    } catch {
      return false;
    }
  }, "must be a credential-free HTTP(S) URL without a query or fragment");
const bundleStatus = z.enum(["succeeded", "genuine-task-failures", "failed"]);
const legacyBundleStatus = z.enum(["succeeded", "genuine-task-failures"]);
const relativePath = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !path.posix.isAbsolute(value) &&
      !path.win32.isAbsolute(value) &&
      !value.includes("\\") &&
      !value.split("/").some((part) => part === "" || part === "." || part === ".."),
    "must be a canonical relative POSIX path"
  );

const bundleFileSchema = z.strictObject({
  path: relativePath,
  size_bytes: z.number().int().nonnegative().max(MAX_PUBLIC_BENCHMARK_FILE_BYTES),
  sha256,
  contents_base64: z.string().max(MAX_FILE_BASE64_CHARACTERS)
});

const provenanceDimensionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u);
const artifactProvenanceSchema = z.strictObject({
  producer_node_id: safeId,
  run_id: safeId,
  logical_node_id: safeId.optional(),
  attempt_index: z.number().int().nonnegative().optional(),
  loop_index: z.number().int().nonnegative().optional(),
  model_id: z.string().min(1).max(512).optional(),
  model: z.string().min(1).max(512).optional(),
  model_index: z.number().int().nonnegative().optional(),
  agent_ref: z.string().min(1).max(512).optional(),
  workflow_run_id: provenanceDimensionId.optional(),
  workflow_task_id: provenanceDimensionId.optional(),
  source_run_id: provenanceDimensionId.optional(),
  origin: z.string().min(1).max(512).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});
const publicArtifactManifestSchema = z.strictObject({
  schema_version: z.literal("1.0"),
  run_id: safeId,
  node_id: safeId,
  producer_node_id: safeId,
  created_at: z.string().datetime({ offset: true }),
  files: z
    .array(
      z.strictObject({
        path: relativePath,
        size_bytes: z.number().int().nonnegative().max(MAX_PUBLIC_BENCHMARK_FILE_BYTES),
        sha256,
        provenance: artifactProvenanceSchema
      })
    )
    .min(1)
    .max(VERIFIER_RECEIPT_MAX_ARTIFACTS),
  output_contracts: z
    .array(
      z.strictObject({
        path: relativePath,
        contract: z.string().min(1).max(512),
        contract_digest: sha256,
        primary: z.boolean()
      })
    )
    .min(1)
    .max(VERIFIER_RECEIPT_MAX_ARTIFACTS),
  prerequisite_manifests: z.array(z.strictObject({ node_id: safeId, sha256 })).max(MAX_ROWS),
  provenance: artifactProvenanceSchema
});

export type PublicArtifactManifest = z.infer<typeof publicArtifactManifestSchema>;

export function parsePublicArtifactManifest(value: unknown): PublicArtifactManifest {
  const manifest = publicArtifactManifestSchema.parse(value);
  if (
    manifest.producer_node_id !== manifest.node_id ||
    manifest.provenance.producer_node_id !== manifest.producer_node_id ||
    manifest.provenance.run_id !== manifest.run_id
  ) {
    throw new Error("public artifact manifest producer identity is inconsistent");
  }
  if (new Set(manifest.files.map((file) => file.path)).size !== manifest.files.length) {
    throw new Error("public artifact manifest repeats a file path");
  }
  if (new Set(manifest.output_contracts.map((entry) => entry.path)).size !== manifest.output_contracts.length) {
    throw new Error("public artifact manifest repeats an output contract path");
  }
  const prerequisiteIds = manifest.prerequisite_manifests.map((entry) => entry.node_id);
  if (new Set(prerequisiteIds).size !== prerequisiteIds.length || prerequisiteIds.includes(manifest.node_id)) {
    throw new Error("public artifact manifest has duplicate or self-referential prerequisites");
  }
  if (manifest.files.some((file) => canonicalJson(file.provenance) !== canonicalJson(manifest.provenance))) {
    throw new Error("public artifact manifest file provenance does not match the manifest provenance");
  }
  return manifest;
}

const targetPublicationLocationSchema = z.strictObject({
  bundle_path: relativePath,
  report_paths: z
    .array(relativePath)
    .min(1)
    .max(MAX_ROWS * PUBLIC_REPORT_FILES.length)
});

const currentBundleTargetSchema = z.strictObject({
  id: safeId,
  repository: repositoryUrl,
  revision: fullSha,
  framework: safeId,
  status: bundleStatus,
  executed_case_count: caseCount,
  graded_case_count: caseCount,
  publication_location: targetPublicationLocationSchema
});

const bundleTargetSchema = z.strictObject({
  id: safeId,
  repository: repositoryUrl,
  revision: fullSha,
  framework: safeId.optional(),
  status: bundleStatus,
  executed_case_count: caseCount,
  graded_case_count: caseCount,
  publication_location: targetPublicationLocationSchema
});

const legacyBundleTargetSchema = z.strictObject({
  id: safeId,
  repository: repositoryUrl,
  revision: fullSha,
  framework: safeId.optional(),
  status: legacyBundleStatus,
  executed_case_count: caseCount,
  graded_case_count: caseCount,
  publication_location: targetPublicationLocationSchema
});

const bundleLineageSchema = z.strictObject({
  logical_run_id: safeId,
  generation: z.number().int().positive(),
  attempt: z.number().int().positive(),
  attempt_id: safeId,
  config_fingerprint: sha256,
  source_fingerprint: sha256,
  image_fingerprint: sha256,
  model_fingerprint: sha256
});

const bundleShape = {
  benchmark: z.enum(["evmbench", "ultrafuzz-bench"]),
  lane: z.enum(["smoke", "full"]),
  model_slug: safeId,
  model: z.string().min(1).max(256),
  reasoning: z.string().min(1).max(64),
  judge_model: z.literal("gpt-5.6-sol"),
  judge_reasoning: z.literal("xhigh"),
  candidate_commit: z.string().regex(/^[0-9a-f]{40}$/u),
  eval_run_id: safeId,
  lineage: bundleLineageSchema,
  executed_case_count: caseCount,
  graded_case_count: caseCount,
  created_at: z.string().datetime({ offset: true }),
  files: z
    .array(bundleFileSchema)
    .min(1)
    .max(MAX_ROWS * 4 + 16)
} as const;

const currentBundleSchema = z.strictObject({
  schema_version: z.literal(PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION),
  ...bundleShape,
  provider_reported_model: z.string().min(1).max(256),
  status: bundleStatus,
  targets: z.array(currentBundleTargetSchema).min(1).max(MAX_ROWS)
});

const previousBundleSchema = z.strictObject({
  schema_version: z.literal(PUBLIC_BENCHMARK_BUNDLE_V6_SCHEMA_VERSION),
  ...bundleShape,
  provider_reported_model: z.string().min(1).max(256),
  status: bundleStatus,
  targets: z.array(bundleTargetSchema).min(1).max(MAX_ROWS)
});

const v5BundleSchema = z.strictObject({
  schema_version: z.literal(PUBLIC_BENCHMARK_BUNDLE_V5_SCHEMA_VERSION),
  ...bundleShape,
  status: bundleStatus,
  targets: z.array(bundleTargetSchema).min(1).max(MAX_ROWS)
});

const v4BundleSchema = z.strictObject({
  schema_version: z.literal(PUBLIC_BENCHMARK_BUNDLE_V4_SCHEMA_VERSION),
  ...bundleShape,
  status: bundleStatus,
  targets: z.array(bundleTargetSchema).min(1).max(MAX_ROWS)
});

const legacyBundleSchema = z.strictObject({
  schema_version: z.literal(PUBLIC_BENCHMARK_BUNDLE_LEGACY_SCHEMA_VERSION),
  ...bundleShape,
  status: legacyBundleStatus,
  targets: z.array(legacyBundleTargetSchema).min(1).max(MAX_ROWS)
});

const bundleSchema = z.union([
  currentBundleSchema,
  previousBundleSchema,
  v5BundleSchema,
  v4BundleSchema,
  legacyBundleSchema
]);

export type PublicBenchmarkBundle = z.infer<typeof bundleSchema>;
type CurrentPublicBenchmarkBundle = z.infer<typeof currentBundleSchema>;
type ModelPricingPublicBenchmarkBundle = CurrentPublicBenchmarkBundle | z.infer<typeof previousBundleSchema>;
type PublicBenchmarkBundleFile = z.infer<typeof bundleFileSchema>;
type PublicBenchmarkBundleTarget = PublicBenchmarkBundle["targets"][number];
type PublicBenchmarkBundleMetadata = Pick<
  PublicBenchmarkBundle,
  "status" | "executed_case_count" | "graded_case_count" | "targets"
>;

export interface PublicBenchmarkBundleSource {
  path: string;
  root: string;
  source: string;
  snapshot?: PublicBenchmarkSourceSnapshot;
}

export interface PublicBenchmarkSourcePathIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
}

export interface PublicBenchmarkSourceFileIdentity extends PublicBenchmarkSourcePathIdentity {
  mode: bigint;
  nlink: bigint;
  size: bigint;
  ctimeNs: bigint;
  mtimeNs: bigint;
}

export interface PublicBenchmarkSourceSnapshot {
  root: string;
  file: string;
  relativeFile: string;
  canonicalRoot: string;
  canonicalFile: string;
  directories: PublicBenchmarkSourcePathIdentity[];
  fileIdentity: PublicBenchmarkSourceFileIdentity;
}

export function sealPublicBenchmarkBundleSource(
  source: Omit<PublicBenchmarkBundleSource, "snapshot">
): PublicBenchmarkBundleSource {
  return { ...source, snapshot: snapshotRegularSource(source.root, source.source) };
}

export function createPublicBenchmarkBundle(input: {
  benchmark: PublicBenchmarkBundle["benchmark"];
  lane: PublicBenchmarkBundle["lane"];
  modelSlug: string;
  model: string;
  providerReportedModel: string;
  reasoning: string;
  candidateCommit: string;
  evalRunId: string;
  lineage: Pick<
    ModalWorkerLineage,
    "logical_run_id" | "generation" | "attempt" | "attempt_id" | "fingerprints" | "model_fingerprint"
  >;
  files: PublicBenchmarkBundleSource[];
  forbiddenSecretValues?: readonly string[];
  createdAt?: string;
  publicationBundlePath?: string;
}): CurrentPublicBenchmarkBundle {
  const forbiddenSecretValues = [...new Set(input.forbiddenSecretValues ?? [])].filter((value) => value.length > 0);
  const files = input.files.map((entry) => {
    const contents = readRegularFileNoFollow(
      entry.root,
      entry.source,
      MAX_PUBLIC_BENCHMARK_FILE_BYTES,
      undefined,
      entry.snapshot
    );
    if (contents.byteLength > MAX_PUBLIC_BENCHMARK_FILE_BYTES) {
      throw new Error(`public benchmark file is too large: ${entry.path}`);
    }
    assertPublicBenchmarkFileContainsNoSecrets(entry.path, contents, forbiddenSecretValues);
    return {
      path: entry.path,
      size_bytes: contents.byteLength,
      sha256: digest(contents),
      contents_base64: contents.toString("base64")
    };
  });
  const metadata = summarizePublicBenchmarkBundleFiles(
    files,
    input.publicationBundlePath ?? DEFAULT_PUBLICATION_BUNDLE_PATH
  );
  const bundle = parsePublicBenchmarkBundle(
    {
      schema_version: PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION,
      benchmark: input.benchmark,
      lane: input.lane,
      model_slug: input.modelSlug,
      model: input.model,
      provider_reported_model: input.providerReportedModel,
      reasoning: input.reasoning,
      judge_model: "gpt-5.6-sol",
      judge_reasoning: "xhigh",
      candidate_commit: input.candidateCommit,
      eval_run_id: input.evalRunId,
      lineage: {
        logical_run_id: input.lineage.logical_run_id,
        generation: input.lineage.generation,
        attempt: input.lineage.attempt,
        attempt_id: input.lineage.attempt_id,
        config_fingerprint: input.lineage.fingerprints.config,
        source_fingerprint: input.lineage.fingerprints.source,
        image_fingerprint: input.lineage.fingerprints.image,
        model_fingerprint: input.lineage.model_fingerprint
      },
      ...metadata,
      created_at: input.createdAt ?? new Date().toISOString(),
      files
    },
    forbiddenSecretValues
  );
  if (bundle.schema_version !== PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION) {
    throw new Error("new public benchmark bundle used an unexpected schema version");
  }
  if (Buffer.byteLength(JSON.stringify(bundle), "utf8") > MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES) {
    throw new Error("public benchmark bundle exceeds the size limit");
  }
  return bundle;
}

function assertPublicBenchmarkFileContainsNoSecrets(
  bundlePath: string,
  contents: Buffer,
  forbiddenSecretValues: readonly string[]
): void {
  if (containsForbiddenSecretRepresentation(contents, forbiddenSecretValues)) {
    throw new Error(`public benchmark file contains an injected secret value: ${bundlePath}`);
  }
  const text = contents.toString("utf8");
  if (redactSecretsInText(text) !== text) {
    throw new Error(`public benchmark file contains secret-like content: ${bundlePath}`);
  }
}

function assertPublicBenchmarkMetadataContainsNoSecrets(
  bundle: PublicBenchmarkBundle,
  forbiddenSecretValues: readonly string[]
): void {
  const metadata = JSON.stringify({
    ...bundle,
    files: bundle.files.map((file) => ({
      path: file.path,
      size_bytes: file.size_bytes,
      sha256: file.sha256
    }))
  });
  if (containsForbiddenSecretRepresentation(Buffer.from(metadata, "utf8"), forbiddenSecretValues)) {
    throw new Error("public benchmark bundle metadata contains an injected secret value");
  }
  if (redactSecretsInText(metadata) !== metadata) {
    throw new Error("public benchmark bundle metadata contains secret-like content");
  }
}

function containsForbiddenSecretRepresentation(contents: Buffer, forbiddenSecretValues: readonly string[]): boolean {
  for (const secret of forbiddenSecretValues) {
    for (const representation of forbiddenSecretRepresentations(secret)) {
      if (contents.includes(Buffer.from(representation, "utf8"))) return true;
    }
  }
  return false;
}

function forbiddenSecretRepresentations(secret: string): string[] {
  if (secret.length === 0) return [];
  const bytes = Buffer.from(secret, "utf8");
  const base64 = bytes.toString("base64");
  const base64Url = base64.replaceAll("+", "-").replaceAll("/", "_");
  const hex = bytes.toString("hex");
  const percentUpper = [...bytes].map((byte) => `%${byte.toString(16).padStart(2, "0").toUpperCase()}`).join("");
  const percentLower = percentUpper.toLowerCase();
  const representations = new Set([
    secret,
    base64,
    base64.replace(/=+$/u, ""),
    base64Url,
    base64Url.replace(/=+$/u, ""),
    hex,
    hex.toUpperCase(),
    percentUpper,
    percentLower
  ]);
  try {
    const uriComponent = encodeURIComponent(secret);
    representations.add(uriComponent);
    representations.add(uriComponent.replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase()));
    representations.add(uriComponent.replaceAll("%20", "+"));
    const jsonString = JSON.stringify(secret);
    representations.add(jsonString.slice(1, -1));
  } catch {
    // The byte-oriented encodings above still cover malformed surrogate input.
  }
  representations.delete("");
  return [...representations];
}

function readRegularFileNoFollow(
  root: string,
  source: string,
  maxBytes = MAX_PUBLIC_BENCHMARK_FILE_BYTES,
  tooLargeMessage = `public benchmark file is too large: ${source}`,
  expectedSnapshot?: PublicBenchmarkSourceSnapshot
): Buffer {
  const resolvedRoot = path.resolve(root);
  const resolvedSource = path.resolve(source);
  if (
    expectedSnapshot !== undefined &&
    (expectedSnapshot.root !== resolvedRoot || expectedSnapshot.file !== resolvedSource)
  ) {
    throw new Error("public benchmark bundle source does not match its sealed path");
  }
  const snapshot = expectedSnapshot ?? snapshotRegularSource(resolvedRoot, resolvedSource);
  assertSourceSnapshotCurrent(snapshot);
  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const nonBlocking = (fs.constants as typeof fs.constants & { O_NONBLOCK?: number }).O_NONBLOCK ?? 0;
  const directoryOnly = (fs.constants as typeof fs.constants & { O_DIRECTORY?: number }).O_DIRECTORY ?? 0;
  const procFdAvailable = process.platform === "linux" && fs.existsSync("/proc/self/fd");
  let rootDescriptor: number | undefined;
  let descriptor: number | undefined;
  try {
    let openPath = snapshot.file;
    if (procFdAvailable) {
      // Anchor traversal to the already-opened root on Linux. Other platforms
      // use the fail-closed dev/inode plus pre/post ancestor proof below.
      rootDescriptor = fs.openSync(snapshot.root, fs.constants.O_RDONLY | noFollow | nonBlocking | directoryOnly);
      const openedRoot = fs.fstatSync(rootDescriptor, { bigint: true });
      assertIdentityMatches(snapshot.directories[0]!, openedRoot, "public benchmark source root changed while opening");
      if (!openedRoot.isDirectory()) {
        throw new Error("public benchmark source root is not a regular directory");
      }
      const openedRootPath = resolveProcDescriptorPath(rootDescriptor, "public benchmark source root");
      if (openedRootPath !== snapshot.canonicalRoot) {
        throw new Error("public benchmark source root changed while opening");
      }
      openPath = path.join(`/proc/self/fd/${String(rootDescriptor)}`, ...snapshot.relativeFile.split(path.sep));
    }

    descriptor = fs.openSync(openPath, fs.constants.O_RDONLY | noFollow | nonBlocking);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    assertOpenedSource(
      snapshot,
      descriptor,
      opened,
      procFdAvailable,
      "public benchmark bundle source changed while opening"
    );
    assertSourceSnapshotCurrent(snapshot, opened);
    if (opened.size < 0n || opened.size > BigInt(maxBytes)) throw new Error(tooLargeMessage);

    const expectedBytes = Number(opened.size);
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes < expectedBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, expectedBytes - totalBytes));
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) {
        const completed = fs.fstatSync(descriptor, { bigint: true });
        assertOpenedSource(
          snapshot,
          descriptor,
          completed,
          procFdAvailable,
          "public benchmark bundle source changed while reading"
        );
        assertSourceSnapshotCurrent(snapshot, completed);
        throw new Error("public benchmark bundle source changed size while reading");
      }
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }

    const eofProbe = Buffer.allocUnsafe(1);
    const trailingBytes = fs.readSync(descriptor, eofProbe, 0, eofProbe.byteLength, null);
    const completed = fs.fstatSync(descriptor, { bigint: true });
    assertOpenedSource(
      snapshot,
      descriptor,
      completed,
      procFdAvailable,
      "public benchmark bundle source changed while reading"
    );
    assertSourceSnapshotCurrent(snapshot, completed);
    if (totalBytes !== expectedBytes || trailingBytes !== 0) {
      throw new Error("public benchmark bundle source changed size while reading");
    }
    return Buffer.concat(chunks, totalBytes);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (rootDescriptor !== undefined) fs.closeSync(rootDescriptor);
  }
}

/**
 * Read a publication input through the same stable, no-follow path proof used
 * when the final bundle is assembled.  Callers that must inspect a control
 * file before selecting other bundle sources must not fall back to a plain
 * path-based read: doing so would let a symlink or rename race influence the
 * trust boundary before the bundle reader gets a chance to validate it.
 */
export function readPublicBenchmarkSourceNoFollow(
  root: string,
  source: string,
  maxBytes: number,
  tooLargeMessage: string
): Buffer {
  return readRegularFileNoFollow(root, source, maxBytes, tooLargeMessage);
}

export function readSealedPublicBenchmarkSourceNoFollow(
  source: PublicBenchmarkBundleSource,
  maxBytes: number,
  tooLargeMessage: string
): Buffer {
  if (source.snapshot === undefined) throw new Error("public benchmark source is not sealed");
  return readRegularFileNoFollow(source.root, source.source, maxBytes, tooLargeMessage, source.snapshot);
}

function snapshotRegularSource(root: string, source: string): PublicBenchmarkSourceSnapshot {
  const rootPath = path.resolve(root);
  const filePath = path.resolve(source);
  const relativeFile = path.relative(rootPath, filePath);
  if (
    relativeFile === "" ||
    relativeFile === ".." ||
    relativeFile.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeFile)
  ) {
    throw new Error(`public benchmark bundle source escapes ${rootPath}`);
  }

  const parts = relativeFile.split(path.sep);
  const directories: PublicBenchmarkSourcePathIdentity[] = [];
  let current = rootPath;
  for (let index = 0; index < parts.length; index += 1) {
    const stat = fs.lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`public benchmark bundle source crosses an unsafe directory: ${current}`);
    }
    directories.push(pathIdentity(current, stat));
    current = path.join(current, parts[index]!);
  }

  const fileStat = fs.lstatSync(filePath, { bigint: true });
  if (fileStat.isSymbolicLink()) {
    throw new Error(`public benchmark bundle source cannot be a symlink: ${filePath}`);
  }
  if (!fileStat.isFile()) {
    throw new Error(`public benchmark source is not a regular file: ${filePath}`);
  }
  if (fileStat.nlink !== 1n) {
    throw new Error(`public benchmark bundle source cannot be hard-linked: ${filePath}`);
  }

  const canonicalRoot = fs.realpathSync.native(rootPath);
  const canonicalFile = fs.realpathSync.native(filePath);
  if (!isStrictlyInside(canonicalRoot, canonicalFile)) {
    throw new Error(`public benchmark bundle source escapes ${canonicalRoot}`);
  }
  return {
    root: rootPath,
    file: filePath,
    relativeFile,
    canonicalRoot,
    canonicalFile,
    directories,
    fileIdentity: fileIdentity(filePath, fileStat)
  };
}

function assertOpenedSource(
  snapshot: PublicBenchmarkSourceSnapshot,
  descriptor: number,
  stat: fs.BigIntStats,
  procFdAvailable: boolean,
  changedMessage: string
): void {
  if (!stat.isFile()) {
    throw new Error(`public benchmark source is not a regular file: ${snapshot.file}`);
  }
  if (stat.nlink !== 1n) {
    throw new Error(`public benchmark bundle source cannot be hard-linked: ${snapshot.file}`);
  }
  assertFileIdentityMatches(snapshot.fileIdentity, stat, changedMessage);
  if (!procFdAvailable) return;
  const openedPath = resolveProcDescriptorPath(descriptor, "public benchmark bundle source");
  if (openedPath !== snapshot.canonicalFile || !isStrictlyInside(snapshot.canonicalRoot, openedPath)) {
    throw new Error("public benchmark bundle opened source escapes its canonical root");
  }
}

function assertSourceSnapshotCurrent(snapshot: PublicBenchmarkSourceSnapshot, opened?: fs.BigIntStats): void {
  const current = snapshotRegularSource(snapshot.root, snapshot.file);
  if (
    current.canonicalRoot !== snapshot.canonicalRoot ||
    current.canonicalFile !== snapshot.canonicalFile ||
    current.directories.length !== snapshot.directories.length
  ) {
    throw new Error("public benchmark bundle source path changed while reading");
  }
  for (const [index, identity] of snapshot.directories.entries()) {
    const currentIdentity = current.directories[index];
    if (
      currentIdentity === undefined ||
      currentIdentity.path !== identity.path ||
      currentIdentity.dev !== identity.dev ||
      currentIdentity.ino !== identity.ino
    ) {
      throw new Error("public benchmark bundle source parent changed while reading");
    }
  }
  if (opened !== undefined) {
    assertFileIdentityMatches(snapshot.fileIdentity, opened, "public benchmark bundle source changed while reading");
  }
  assertFileIdentityEqual(
    snapshot.fileIdentity,
    current.fileIdentity,
    "public benchmark bundle source path changed while reading"
  );
}

function pathIdentity(filePath: string, stat: fs.BigIntStats): PublicBenchmarkSourcePathIdentity {
  return { path: filePath, dev: stat.dev, ino: stat.ino };
}

function fileIdentity(filePath: string, stat: fs.BigIntStats): PublicBenchmarkSourceFileIdentity {
  return {
    ...pathIdentity(filePath, stat),
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    ctimeNs: stat.ctimeNs,
    mtimeNs: stat.mtimeNs
  };
}

function assertIdentityMatches(
  identity: PublicBenchmarkSourcePathIdentity,
  stat: fs.BigIntStats,
  message: string
): void {
  if (identity.dev !== stat.dev || identity.ino !== stat.ino) throw new Error(message);
}

function assertFileIdentityMatches(
  identity: PublicBenchmarkSourceFileIdentity,
  stat: fs.BigIntStats,
  message: string
): void {
  if (
    identity.dev !== stat.dev ||
    identity.ino !== stat.ino ||
    identity.mode !== stat.mode ||
    identity.nlink !== stat.nlink ||
    identity.size !== stat.size ||
    identity.ctimeNs !== stat.ctimeNs ||
    identity.mtimeNs !== stat.mtimeNs
  ) {
    throw new Error(message);
  }
}

function assertFileIdentityEqual(
  left: PublicBenchmarkSourceFileIdentity,
  right: PublicBenchmarkSourceFileIdentity,
  message: string
): void {
  if (
    left.path !== right.path ||
    left.dev !== right.dev ||
    left.ino !== right.ino ||
    left.mode !== right.mode ||
    left.nlink !== right.nlink ||
    left.size !== right.size ||
    left.ctimeNs !== right.ctimeNs ||
    left.mtimeNs !== right.mtimeNs
  ) {
    throw new Error(message);
  }
}

function resolveProcDescriptorPath(descriptor: number, label: string): string {
  try {
    return fs.realpathSync.native(`/proc/self/fd/${String(descriptor)}`);
  } catch (error) {
    throw new Error(`${label} descriptor target cannot be verified`, { cause: error });
  }
}

function isStrictlyInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function parsePublicBenchmarkBundle(
  value: unknown,
  forbiddenSecretValues: readonly string[] = [],
  expectedSchemaVersion: PublicBenchmarkBundle["schema_version"] = PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION
): PublicBenchmarkBundle {
  const requestedSchemaVersion = recordValue(value)?.schema_version;
  if (requestedSchemaVersion !== expectedSchemaVersion) {
    throw new Error(
      `public benchmark bundle schema version ${String(requestedSchemaVersion)} does not match required ${expectedSchemaVersion}`
    );
  }
  const parsed = bundleSchema.parse(value);
  const exactSecrets = [...new Set(forbiddenSecretValues)].filter((secret) => secret.length > 0);
  assertPublicBenchmarkMetadataContainsNoSecrets(parsed, exactSecrets);
  const paths = new Set<string>();
  const contentsByPath = new Map<string, Buffer>();
  let decodedBytes = 0;
  for (const file of parsed.files) {
    if (paths.has(file.path)) throw new Error(`duplicate public benchmark bundle path: ${file.path}`);
    paths.add(file.path);
    if (!isAllowedBundlePath(file.path)) throw new Error(`public benchmark bundle path is not allowed: ${file.path}`);
    const contents = Buffer.from(file.contents_base64, "base64");
    if (contents.toString("base64") !== file.contents_base64) {
      throw new Error(`public benchmark bundle file is not canonical base64: ${file.path}`);
    }
    if (contents.byteLength !== file.size_bytes || digest(contents) !== file.sha256) {
      throw new Error(`public benchmark bundle integrity check failed: ${file.path}`);
    }
    assertPublicBenchmarkFileContainsNoSecrets(file.path, contents, exactSecrets);
    contentsByPath.set(file.path, contents);
    decodedBytes += contents.byteLength;
  }
  if (decodedBytes > MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES) {
    throw new Error("public benchmark bundle exceeds the size limit");
  }
  const hasImmutableExecutionEvidence =
    parsed.schema_version === PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION ||
    parsed.schema_version === PUBLIC_BENCHMARK_BUNDLE_V6_SCHEMA_VERSION ||
    parsed.schema_version === PUBLIC_BENCHMARK_BUNDLE_V5_SCHEMA_VERSION;
  if (hasImmutableExecutionEvidence === false) {
    const currentOnlyPath = [...paths].find(
      (bundlePath) =>
        bundlePath.endsWith(`/${PUBLIC_SOURCE_ATTESTATION_FILE}`) ||
        bundlePath.includes(`/${PUBLIC_EXECUTION_EVIDENCE_DIRECTORY}/`)
    );
    if (currentOnlyPath !== undefined) {
      throw new Error(`legacy public benchmark bundle contains current-only evidence: ${currentOnlyPath}`);
    }
  }
  for (const required of [
    "eval/eval.json",
    "eval/matrix.json",
    "eval/runs.jsonl",
    "eval/run-summary.json",
    `eval/${PUBLIC_EVAL_DIAGNOSTICS_FILE}`,
    "eval/scores.jsonl",
    "eval/summary.json",
    "eval/summary.md"
  ]) {
    if (!paths.has(required)) throw new Error(`public benchmark bundle is missing ${required}`);
  }
  const matrixContents = contentsByPath.get("eval/matrix.json");
  if (matrixContents === undefined) throw new Error("public benchmark bundle is missing eval/matrix.json");
  const matrixRows = parseMatrixRows(matrixContents, parsed.schema_version === PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION);
  const runContents = contentsByPath.get("eval/runs.jsonl");
  if (runContents === undefined) throw new Error("public benchmark bundle is missing eval/runs.jsonl");
  const finalRunRecords = hasImmutableExecutionEvidence
    ? parseFinalRunRecords(parsed, matrixRows, runContents)
    : new Map<string, PublicFinalRunRecord>();
  const summaryContents = contentsByPath.get("eval/summary.json");
  if (summaryContents === undefined) throw new Error("public benchmark bundle is missing eval/summary.json");
  const summaryRows = parseSummaryRows(summaryContents);
  const diagnosticsPath = `eval/${PUBLIC_EVAL_DIAGNOSTICS_FILE}`;
  const diagnosticsContents = contentsByPath.get(diagnosticsPath);
  if (diagnosticsContents === undefined) throw new Error(`public benchmark bundle is missing ${diagnosticsPath}`);
  const diagnostics = parseBundleDiagnostics(diagnosticsContents);
  assertBundleDiagnosticsLineage(parsed, diagnostics);
  if (
    parsed.schema_version === PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION &&
    diagnostics.schema_version !== PUBLIC_EVAL_DIAGNOSTICS_SCHEMA_VERSION
  ) {
    throw new Error(`public benchmark bundle requires ${PUBLIC_EVAL_DIAGNOSTICS_SCHEMA_VERSION}`);
  }
  if (
    parsed.schema_version === PUBLIC_BENCHMARK_BUNDLE_V6_SCHEMA_VERSION &&
    diagnostics.schema_version !== PUBLIC_EVAL_DIAGNOSTICS_V3_SCHEMA_VERSION
  ) {
    throw new Error(`public benchmark bundle v6 requires ${PUBLIC_EVAL_DIAGNOSTICS_V3_SCHEMA_VERSION}`);
  }
  if (
    parsed.schema_version === PUBLIC_BENCHMARK_BUNDLE_V5_SCHEMA_VERSION &&
    diagnostics.schema_version !== PUBLIC_EVAL_DIAGNOSTICS_V2_SCHEMA_VERSION
  ) {
    throw new Error(`public benchmark bundle v5 requires ${PUBLIC_EVAL_DIAGNOSTICS_V2_SCHEMA_VERSION}`);
  }
  if (!diagnostics.summary.scoring_ready) {
    throw new Error("public benchmark bundle diagnostics are not ready for scoring");
  }
  if (diagnostics.rows.length !== matrixRows.size) {
    throw new Error("public benchmark bundle diagnostics row set does not match the matrix");
  }
  if (summaryRows.size !== matrixRows.size) {
    throw new Error("public benchmark bundle graded row set does not match the matrix");
  }
  for (const diagnostic of diagnostics.rows) {
    const matrixRow = matrixRows.get(diagnostic.row_id);
    if (
      matrixRow === undefined ||
      matrixRow.target_id !== diagnostic.target_id ||
      matrixRow.variant_id !== diagnostic.variant_id ||
      matrixRow.trial_id !== diagnostic.trial_id
    ) {
      throw new Error(`public benchmark bundle diagnostics row does not match the matrix: ${diagnostic.row_id}`);
    }
  }
  for (const rowId of summaryRows) {
    if (!matrixRows.has(rowId)) {
      throw new Error(`public benchmark bundle graded row does not match the matrix: ${rowId}`);
    }
  }
  for (const bundlePath of paths) {
    if (!bundlePath.startsWith("reports/")) continue;
    const rowId = bundlePath.split("/")[1];
    if (rowId === undefined || !matrixRows.has(rowId)) {
      throw new Error(`public benchmark bundle contains a report for an unexpected matrix row: ${bundlePath}`);
    }
  }
  const requiredReportFiles = hasImmutableExecutionEvidence ? PUBLIC_REPORT_FILES : BASE_PUBLIC_REPORT_FILES;
  for (const rowId of matrixRows.keys()) {
    for (const reportFile of requiredReportFiles) {
      const required = `reports/${rowId}/${reportFile}`;
      if (!paths.has(required)) throw new Error(`public benchmark bundle is missing ${required}`);
    }
  }
  assertSmokeFindingFloor(parsed.lane, matrixRows, contentsByPath, diagnostics);
  if (hasImmutableExecutionEvidence) {
    assertDiagnosticsTerminalClosure(finalRunRecords, contentsByPath, diagnostics);
    assertCurrentEvalIdentity(parsed, matrixRows, contentsByPath);
    assertRunSummaryClosure(parsed, matrixRows, finalRunRecords, contentsByPath);
    assertReportTargetRevisions(parsed, matrixRows, finalRunRecords, contentsByPath);
    assertSummaryRecoveryClosure(parsed, matrixRows, finalRunRecords, summaryContents);
    assertScoringAndFindingClosure(parsed, matrixRows, finalRunRecords, contentsByPath, diagnostics);
  }
  if (
    parsed.schema_version === PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION ||
    parsed.schema_version === PUBLIC_BENCHMARK_BUNDLE_V6_SCHEMA_VERSION
  ) {
    assertCurrentModelAndPricingClosure(
      parsed,
      matrixRows,
      finalRunRecords,
      contentsByPath,
      summaryContents,
      diagnostics
    );
  }
  assertNoReportTargetRevisionContradictions(matrixRows, contentsByPath);
  const publicationBundlePath = uniqueDeclaredPublicationBundlePath(parsed.targets);
  const expectedMetadata = summarizePublicBenchmarkBundleContents({
    matrixRows,
    diagnostics,
    summaryRows,
    publicationBundlePath,
    ...(hasImmutableExecutionEvidence
      ? { reportPathsByRow: publicReportPathsByRow(paths) }
      : { reportFiles: BASE_PUBLIC_REPORT_FILES })
  });
  assertPublicBenchmarkBundleMetadata(parsed, expectedMetadata);
  return parsed;
}

function assertCurrentEvalIdentity(
  bundle: PublicBenchmarkBundle,
  matrixRows: Map<string, PublicBundleMatrixRow>,
  contentsByPath: Map<string, Buffer>
): void {
  const evalContents = contentsByPath.get("eval/eval.json");
  if (evalContents === undefined) throw new Error("public benchmark bundle is missing eval/eval.json");
  const document = recordValue(parseJson(evalContents, "eval/eval.json"));
  const suite = recordValue(document?.suite);
  const profiles = recordValue(suite?.model_profiles);
  const runnerProfile = recordValue(profiles?.[bundle.model_slug]);
  const judgeProfiles = Object.entries(profiles ?? {}).filter(([, value]) => {
    const profile = recordValue(value);
    return profile?.model === bundle.judge_model && profile.reasoning === bundle.judge_reasoning;
  });
  const judgeProfileId = judgeProfiles.length === 1 ? judgeProfiles[0]![0] : undefined;
  const provenance = recordValue(document?.provenance);
  const candidate = recordValue(provenance?.candidate);
  const recoveryPolicy = recordValue(suite?.recovery_equivalence);
  const expectedSuiteId = `${bundle.benchmark}-${bundle.lane}`;
  if (
    document?.schema_version !== "ultrafuzz.eval.run.v1" ||
    document.eval_run_id !== bundle.eval_run_id ||
    suite?.schema_version !== "ultrafuzz.eval.v1" ||
    suite.suite !== expectedSuiteId ||
    runnerProfile?.model !== bundle.model ||
    runnerProfile.reasoning !== bundle.reasoning ||
    judgeProfileId === undefined ||
    candidate?.commit !== bundle.candidate_commit ||
    candidate.dirty !== false ||
    candidate.execution_artifact_id !== `git:${bundle.candidate_commit}` ||
    recoveryPolicy?.max_repeated_model_executions !== 0 ||
    recoveryPolicy.publication !== "clean"
  ) {
    throw new Error("public benchmark bundle eval/eval.json does not match the bundle execution identity");
  }

  const suiteTargets = new Map<string, { repo: string; ref: string }>();
  if (!Array.isArray(suite.targets)) {
    throw new Error("public benchmark bundle eval/eval.json has invalid targets");
  }
  for (const [index, value] of suite.targets.entries()) {
    const target = recordValue(value);
    const targetId = safeId.safeParse(target?.id);
    const repository = repositoryUrl.safeParse(target?.repo);
    const revision = fullSha.safeParse(target?.ref);
    if (
      !targetId.success ||
      !repository.success ||
      !revision.success ||
      target?.sensitivity !== "public" ||
      suiteTargets.has(targetId.data)
    ) {
      throw new Error(`public benchmark bundle eval/eval.json target ${index} is invalid`);
    }
    suiteTargets.set(targetId.data, { repo: repository.data, ref: revision.data });
  }
  const matrixTargets = new Map([...matrixRows.values()].map((row) => [row.target_id, row.target]));
  if (
    suiteTargets.size !== matrixTargets.size ||
    [...matrixTargets].some(
      ([targetId, target]) =>
        suiteTargets.get(targetId)?.repo !== target.repo || suiteTargets.get(targetId)?.ref !== target.ref
    )
  ) {
    throw new Error("public benchmark bundle eval/eval.json targets do not match the matrix");
  }

  if (!Array.isArray(suite.variants) || suite.variants.length !== 1) {
    throw new Error("public benchmark bundle eval/eval.json must contain exactly one model variant");
  }
  const variant = recordValue(suite.variants[0]);
  const run = recordValue(suite.run);
  if (
    variant?.id !== bundle.model_slug ||
    variant.runner_model_profile !== bundle.model_slug ||
    variant.judge_model_profile !== judgeProfileId ||
    (bundle.lane === "smoke" && variant.topology !== "benchmarks/smoke-benchmark.yml") ||
    run?.runner_model_profile !== bundle.model_slug ||
    run.judge_model_profile !== judgeProfileId
  ) {
    throw new Error("public benchmark bundle eval/eval.json variant does not match the selected model");
  }

  const runIds = new Set<string>();
  for (const row of matrixRows.values()) {
    if (
      row.variant_id !== bundle.model_slug ||
      row.runner_model_profile !== bundle.model_slug ||
      row.runner_model !== bundle.model ||
      row.runner_reasoning !== bundle.reasoning ||
      row.judge_model_profile !== judgeProfileId ||
      row.judge_model !== bundle.judge_model ||
      row.judge_reasoning !== bundle.judge_reasoning ||
      row.run_id === undefined ||
      row.run_id.length === 0 ||
      runIds.has(row.run_id)
    ) {
      throw new Error(`public benchmark bundle matrix row ${row.id} has mismatched model execution identity`);
    }
    runIds.add(row.run_id);
  }
}

function assertRunSummaryClosure(
  bundle: PublicBenchmarkBundle,
  matrixRows: Map<string, PublicBundleMatrixRow>,
  finalRunRecords: Map<string, PublicFinalRunRecord>,
  contentsByPath: Map<string, Buffer>
): void {
  const contents = contentsByPath.get("eval/run-summary.json");
  if (contents === undefined) throw new Error("public benchmark bundle is missing eval/run-summary.json");
  const summary = recordValue(parseJson(contents, "eval/run-summary.json"));
  if (
    summary?.eval_run_id !== bundle.eval_run_id ||
    summary.launched !== matrixRows.size ||
    summary.failed !== 0 ||
    summary.incomplete !== 0 ||
    !Array.isArray(summary.records) ||
    summary.records.length !== matrixRows.size
  ) {
    throw new Error("public benchmark bundle eval/run-summary.json does not match the terminal matrix");
  }
  const seen = new Set<string>();
  for (const [index, value] of summary.records.entries()) {
    const record = recordValue(value);
    const rowId = safeId.safeParse(record?.row_id);
    const finalRecord = rowId.success ? finalRunRecords.get(rowId.data) : undefined;
    if (
      record === undefined ||
      !rowId.success ||
      finalRecord === undefined ||
      seen.has(rowId.data) ||
      canonicalJson(record) !== canonicalJson(finalRecord.value)
    ) {
      throw new Error(`public benchmark bundle eval/run-summary.json record ${index} is not the terminal run record`);
    }
    seen.add(rowId.data);
  }
}

function assertReportTargetRevisions(
  bundle: PublicBenchmarkBundle,
  matrixRows: Map<string, PublicBundleMatrixRow>,
  finalRunRecords: Map<string, PublicFinalRunRecord>,
  contentsByPath: Map<string, Buffer>
): void {
  for (const [rowId, row] of matrixRows) {
    const reportPath = `reports/${rowId}/report.json`;
    const contents = contentsByPath.get(reportPath);
    let report: unknown;
    try {
      report = contents === undefined ? undefined : (JSON.parse(contents.toString("utf8")) as unknown);
    } catch (error) {
      throw new Error(`public benchmark bundle ${reportPath} is not valid JSON`, { cause: error });
    }
    const runMetadata = recordValue(recordValue(report)?.run_metadata);
    const finalRunRecord = finalRunRecords.get(rowId);
    const workflowIds = finalRunRecord?.value.workflow_ids;
    if (
      runMetadata === undefined ||
      finalRunRecord === undefined ||
      runMetadata.run_id !== finalRunRecord.value.ultrafuzz_run_id ||
      runMetadata.model !== bundle.model ||
      !Array.isArray(runMetadata.workflow_ids) ||
      !Array.isArray(workflowIds) ||
      JSON.stringify(runMetadata.workflow_ids) !== JSON.stringify(workflowIds)
    ) {
      throw new Error(`public benchmark bundle ${reportPath} is not bound to its terminal run record`);
    }
    const targetRevision = fullSha.safeParse(runMetadata?.target_revision);
    if (!targetRevision.success) {
      throw new Error(`public benchmark bundle ${reportPath} is missing its runner-attested target revision`);
    }
    if (targetRevision.data !== row.target.ref) {
      throw new Error(`public benchmark bundle ${reportPath} target revision does not match the matrix`);
    }
    const strategyNodes = runMetadata.strategy_nodes;
    if (
      bundle.lane === "smoke" &&
      (!Array.isArray(strategyNodes) ||
        new Set(strategyNodes).size !== SMOKE_MODEL_BACKED_NODE_IDS.length ||
        SMOKE_MODEL_BACKED_NODE_IDS.some((nodeId) => !strategyNodes.includes(nodeId)))
    ) {
      throw new Error(`public benchmark bundle ${reportPath} does not declare the exact smoke model-node closure`);
    }
    if (Object.hasOwn(runMetadata, "source_attestation") || Object.hasOwn(runMetadata, "source_claim")) {
      throw new Error(`public benchmark bundle ${reportPath} embeds a non-publishable source claim`);
    }
    const sourceAttestationPath = `reports/${rowId}/${PUBLIC_SOURCE_ATTESTATION_FILE}`;
    const sourceAttestationContents = contentsByPath.get(sourceAttestationPath);
    if (sourceAttestationContents === undefined) {
      throw new Error(`public benchmark bundle is missing ${sourceAttestationPath}`);
    }
    assertSourceAttestation({
      bundlePath: sourceAttestationPath,
      lane: bundle.lane,
      targetRevision: row.target.ref,
      workflowRunId: workflowIds[0]!,
      runtimeRunId: String(finalRunRecord.value.ultrafuzz_run_id),
      finalRunRecord: finalRunRecord.value,
      rowId,
      recovery: finalRunRecord.recoveryEquivalence,
      contents: sourceAttestationContents,
      contentsByPath
    });
  }
}

function assertSourceAttestation(input: {
  bundlePath: string;
  lane: PublicBenchmarkBundle["lane"];
  targetRevision: string;
  workflowRunId: string;
  runtimeRunId: string;
  finalRunRecord: Record<string, unknown>;
  rowId: string;
  recovery: ReturnType<typeof parseRecoveryEquivalence>;
  contents: Buffer;
  contentsByPath: ReadonlyMap<string, Buffer>;
}): void {
  let attestation: WorkspaceSourceAttestation;
  try {
    attestation = parseWorkspaceSourceAttestation(parseJson(input.contents, input.bundlePath), input.targetRevision);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`public benchmark bundle ${input.bundlePath} has invalid source attestation metadata${detail}`, {
      cause: error
    });
  }
  const attemptIds = new Set<string>();
  const ledgerAttemptIds = new Set<string>();
  const nodeIds = new Set<string>();
  const verifierTaskIds = new Set<string>();
  const verifierReceiptDigests = new Set<string>();
  const workflowExecutionIds = new Set<string>();
  const controllerInvocationIds = new Set<string>();
  const checkpointGenerationIds = new Set<string>();
  for (const [index, task] of attestation.tasks.entries()) {
    if (
      task.expected_base_commit !== input.targetRevision ||
      task.initial_head !== input.targetRevision ||
      task.workflow_run_id !== input.workflowRunId ||
      task.verifier_task_id !== `verify:${task.attempt_id}`
    ) {
      throw new Error(`public benchmark bundle ${input.bundlePath} has invalid source attestation task ${index}`);
    }
    if (attemptIds.has(task.attempt_id)) {
      throw new Error(`public benchmark bundle ${input.bundlePath} repeats a source attestation task`);
    }
    attemptIds.add(task.attempt_id);
    if (ledgerAttemptIds.has(task.ledger_attempt_id)) {
      throw new Error(`public benchmark bundle ${input.bundlePath} repeats a source attestation ledger row`);
    }
    ledgerAttemptIds.add(task.ledger_attempt_id);
    if (nodeIds.has(task.node_id)) {
      throw new Error(`public benchmark bundle ${input.bundlePath} repeats a source attestation node`);
    }
    nodeIds.add(task.node_id);
    if (verifierTaskIds.has(task.verifier_task_id)) {
      throw new Error(`public benchmark bundle ${input.bundlePath} repeats a source attestation verifier task`);
    }
    verifierTaskIds.add(task.verifier_task_id);
    if (verifierReceiptDigests.has(task.verifier_receipt_digest)) {
      throw new Error(`public benchmark bundle ${input.bundlePath} repeats a source attestation verifier receipt`);
    }
    verifierReceiptDigests.add(task.verifier_receipt_digest);
    workflowExecutionIds.add(task.workflow_execution_id);
    controllerInvocationIds.add(task.controller_invocation_id);
    checkpointGenerationIds.add(task.checkpoint_generation_id);
  }
  if (
    input.lane === "smoke" &&
    (nodeIds.size !== SMOKE_MODEL_BACKED_NODE_IDS.length ||
      SMOKE_MODEL_BACKED_NODE_IDS.some((nodeId) => !nodeIds.has(nodeId)))
  ) {
    throw new Error(`public benchmark bundle ${input.bundlePath} does not attest the exact smoke model-node closure`);
  }
  if (
    workflowExecutionIds.size !== input.recovery.observed_workflow_executions ||
    controllerInvocationIds.size !== input.recovery.observed_controller_invocations ||
    checkpointGenerationIds.size !== input.recovery.observed_workflow_executions ||
    attestation.tasks.length !== input.recovery.observed_node_attempts
  ) {
    throw new Error(`public benchmark bundle ${input.bundlePath} does not match the clean execution lineage`);
  }
  assertPublishedTerminalEvidence(input, attestation);
  assertDetachedSourceEvidence(input, attestation);
}

function assertPublishedTerminalEvidence(
  input: {
    runtimeRunId: string;
    workflowRunId: string;
    finalRunRecord: Record<string, unknown>;
    rowId: string;
    contentsByPath: ReadonlyMap<string, Buffer>;
  },
  attestation: WorkspaceSourceAttestation
): void {
  const evidencePaths = terminalEvidenceBundlePaths(input.rowId);
  const evidence = Object.fromEntries(
    Object.entries(evidencePaths).map(([key, bundlePath]) => [
      key,
      requiredEvidenceContents(input.contentsByPath, bundlePath)
    ])
  ) as Record<keyof typeof evidencePaths, Buffer>;
  let binding: TerminalEvidenceBinding;
  try {
    binding = terminalEvidenceBindingSchema.parse(input.finalRunRecord.terminal_evidence);
  } catch (error) {
    throw new Error(`public benchmark bundle row ${input.rowId} has invalid terminal evidence binding`, {
      cause: error
    });
  }
  if (binding.pricing_catalog_sha256 === null) {
    throw new Error(`public benchmark bundle row ${input.rowId} is missing its terminal pricing catalog binding`);
  }
  const accountingRoot = `reports/${input.rowId}/${PUBLIC_EXECUTION_EVIDENCE_DIRECTORY}`;
  const runMetadataPath = `${accountingRoot}/${PUBLIC_RUN_METADATA_FILE}`;
  const usageLedgerPath = `${accountingRoot}/${PUBLIC_USAGE_LEDGER_FILE}`;
  const pricingCatalogPath = `${accountingRoot}/${PUBLIC_PRICING_CATALOGS_DIRECTORY}/${binding.pricing_catalog_sha256}.json`;
  const runMetadataContents = requiredEvidenceContents(input.contentsByPath, runMetadataPath);
  const usageLedgerContents = requiredEvidenceContents(input.contentsByPath, usageLedgerPath);
  const pricingCatalogContents = requiredEvidenceContents(input.contentsByPath, pricingCatalogPath);
  const totalBytes = [
    ...Object.values(evidence),
    runMetadataContents,
    usageLedgerContents,
    pricingCatalogContents
  ].reduce((total, contents) => total + contents.byteLength, 0);
  if (totalBytes > MAX_TERMINAL_EVIDENCE_BYTES) {
    throw new Error(`public benchmark bundle row ${input.rowId} terminal evidence exceeds the shared size limit`);
  }
  let verified: ReturnType<typeof verifyOfflineWorkflowControlBytes>;
  try {
    verified = verifyOfflineWorkflowControlBytes({
      state: evidence.state,
      graph: evidence.graph,
      tasks: evidence.tasks,
      controlIntegrity: evidence.controlIntegrity,
      expandedGraph: evidence.expandedGraph,
      configFingerprintInput: evidence.configFingerprintInput
    });
  } catch (error) {
    throw new Error(`public benchmark bundle row ${input.rowId} has invalid offline terminal workflow controls`, {
      cause: error
    });
  }

  const workflow = recordValue(input.finalRunRecord.workflow);
  const workflowIds = input.finalRunRecord.workflow_ids;
  const finalStatus = input.finalRunRecord.final_status;
  const graphFingerprint = input.finalRunRecord.graph_fingerprint;
  const configFingerprint = input.finalRunRecord.config_fingerprint;
  if (
    input.finalRunRecord.ultrafuzz_run_id !== input.runtimeRunId ||
    !Array.isArray(workflowIds) ||
    workflowIds.length !== 1 ||
    workflowIds[0] !== input.workflowRunId ||
    (finalStatus !== "succeeded" && finalStatus !== "failed") ||
    workflow?.terminal !== true ||
    workflow.status !== finalStatus ||
    typeof graphFingerprint !== "string" ||
    !sha256.safeParse(graphFingerprint).success ||
    typeof configFingerprint !== "string" ||
    !sha256.safeParse(configFingerprint).success ||
    verified.bindings.run_id !== input.runtimeRunId ||
    verified.state_status !== finalStatus ||
    verified.bindings.graph_fingerprint !== graphFingerprint ||
    verified.bindings.config_fingerprint !== configFingerprint
  ) {
    throw new Error(`public benchmark bundle row ${input.rowId} terminal evidence has mismatched execution identity`);
  }
  const observedBinding: TerminalEvidenceBinding = {
    schema_version: TERMINAL_EVIDENCE_BINDING_SCHEMA_VERSION,
    state_sha256: verified.state_sha256,
    tasks_sha256: verified.tasks_sha256,
    control_integrity_sha256: verified.control_integrity_sha256,
    graph_sha256: verified.graph_sha256,
    expanded_graph_sha256: verified.expanded_graph_sha256,
    config_fingerprint_input_sha256: verified.config_fingerprint_input_sha256,
    run_metadata_sha256: digest(runMetadataContents),
    usage_ledger_sha256: digest(usageLedgerContents),
    pricing_catalog_sha256: digest(pricingCatalogContents)
  };
  if (canonicalJson(binding) !== canonicalJson(observedBinding)) {
    throw new Error(`public benchmark bundle row ${input.rowId} terminal evidence bytes do not match its final record`);
  }

  const state = parseJson(evidence.state, evidencePaths.state);
  const tasks = parseJson(evidence.tasks, evidencePaths.tasks);
  const control = parseJson(evidence.controlIntegrity, evidencePaths.controlIntegrity);
  assertTerminalTaskAttestationClosure(input.rowId, tasks, attestation);
  const disposition = classifyTerminalDisposition(state, tasks, control, {
    runtimeRunId: input.runtimeRunId,
    workflowRunId: input.workflowRunId
  });
  if (disposition.kind !== input.finalRunRecord.terminal_disposition) {
    throw new Error(
      `public benchmark bundle row ${input.rowId} terminal disposition does not match offline terminal reclassification`
    );
  }
}

function assertTerminalTaskAttestationClosure(
  rowId: string,
  tasksValue: unknown,
  attestation: WorkspaceSourceAttestation
): void {
  const tasksDocument = recordValue(tasksValue);
  if (!Array.isArray(tasksDocument?.tasks) || tasksDocument.tasks.length !== attestation.tasks.length) {
    throw new Error(`public benchmark bundle row ${rowId} terminal task set does not match source attestation`);
  }
  const attestedByAttempt = new Map(attestation.tasks.map((task) => [task.attempt_id, task]));
  const observed = new Set<string>();
  for (const value of tasksDocument.tasks) {
    const task = recordValue(value);
    const attemptId = typeof task?.attemptId === "string" ? task.attemptId : undefined;
    const attested = attemptId === undefined ? undefined : attestedByAttempt.get(attemptId);
    if (
      attested === undefined ||
      observed.has(attemptId!) ||
      task?.concreteNodeId !== attested.node_id ||
      task.smithersNodeId !== `node:${attemptId}` ||
      task.verifierSmithersNodeId !== `verify:${attemptId}`
    ) {
      throw new Error(`public benchmark bundle row ${rowId} terminal task identity does not match source attestation`);
    }
    observed.add(attemptId!);
  }
}

function terminalEvidenceBundlePaths(rowId: string): {
  state: string;
  graph: string;
  tasks: string;
  controlIntegrity: string;
  expandedGraph: string;
  configFingerprintInput: string;
} {
  const root = `reports/${rowId}/${PUBLIC_EXECUTION_EVIDENCE_DIRECTORY}/${PUBLIC_TERMINAL_EVIDENCE_DIRECTORY}`;
  return {
    state: `${root}/state.json`,
    graph: `${root}/graph.json`,
    tasks: `${root}/smithers/tasks.json`,
    controlIntegrity: `${root}/smithers/control-integrity.json`,
    expandedGraph: `${root}/smithers/expanded-graph.json`,
    configFingerprintInput: `${root}/smithers/config.fingerprint-input`
  };
}

function assertDetachedSourceEvidence(
  input: {
    bundlePath: string;
    runtimeRunId: string;
    finalRunRecord: Record<string, unknown>;
    rowId: string;
    contentsByPath: ReadonlyMap<string, Buffer>;
  },
  attestation: WorkspaceSourceAttestation
): void {
  const evidenceRoot = `reports/${input.rowId}/${PUBLIC_EXECUTION_EVIDENCE_DIRECTORY}`;
  const ledgerPath = `${evidenceRoot}/${PUBLIC_ATTEMPT_LEDGER_FILE}`;
  const runMetadataPath = `${evidenceRoot}/${PUBLIC_RUN_METADATA_FILE}`;
  const usageLedgerPath = `${evidenceRoot}/${PUBLIC_USAGE_LEDGER_FILE}`;
  const ledgerContents = input.contentsByPath.get(ledgerPath);
  if (ledgerContents === undefined) throw new Error(`public benchmark bundle is missing ${ledgerPath}`);
  const ledgerEntries = parseJsonLines(ledgerContents, ledgerPath).map((value, index) => {
    try {
      return assertNodeAttemptLedgerEntry(value);
    } catch (error) {
      throw new Error(`public benchmark bundle ${ledgerPath} has invalid entry ${index}`, { cause: error });
    }
  });
  const ledgerById = new Map<string, NodeAttemptLedgerEntry>(
    ledgerEntries.map((entry): [string, NodeAttemptLedgerEntry] => [entry.attempt_id, entry])
  );
  if (ledgerById.size !== ledgerEntries.length || ledgerEntries.length !== attestation.tasks.length) {
    throw new Error(`public benchmark bundle ${ledgerPath} does not contain the exact attested attempt set`);
  }

  const runMetadataContents = requiredEvidenceContents(input.contentsByPath, runMetadataPath);
  requiredEvidenceContents(input.contentsByPath, usageLedgerPath);
  const catalogSha256 = publishedPricingCatalogSha256(runMetadataContents, runMetadataPath);
  const pricingCatalogPath = `${evidenceRoot}/${PUBLIC_PRICING_CATALOGS_DIRECTORY}/${catalogSha256}.json`;
  const pricingCatalogContents = requiredEvidenceContents(input.contentsByPath, pricingCatalogPath);
  if (digest(pricingCatalogContents) !== catalogSha256) {
    throw new Error(`public benchmark bundle ${pricingCatalogPath} does not match its content-addressed path`);
  }
  const expectedPaths = new Set<string>([
    ledgerPath,
    runMetadataPath,
    usageLedgerPath,
    pricingCatalogPath,
    ...Object.values(terminalEvidenceBundlePaths(input.rowId))
  ]);
  const manifestsByAttempt = new Map<string, PublishedManifestEvidence>();
  for (const [taskIndex, task] of attestation.tasks.entries()) {
    const taskRoot = `${evidenceRoot}/${task.attempt_id}`;
    const manifestPath = `${taskRoot}/artifact-manifest.json`;
    const receiptPath = `${taskRoot}/verifier-receipt.json`;
    const outputPath = `${taskRoot}/smithers-output.json`;
    for (const evidencePath of [manifestPath, receiptPath, outputPath]) expectedPaths.add(evidencePath);
    const manifestContents = requiredEvidenceContents(input.contentsByPath, manifestPath);
    const receiptContents = requiredEvidenceContents(input.contentsByPath, receiptPath);
    const outputContents = requiredEvidenceContents(input.contentsByPath, outputPath);

    let receipt: VerifierReceipt;
    try {
      receipt = parseVerifierReceipt(parseJson(receiptContents, receiptPath));
    } catch (error) {
      throw new Error(`public benchmark bundle ${receiptPath} has an invalid verifier receipt`, { cause: error });
    }
    const expectedOutputSourcePath = path.posix.join(
      "review",
      "verifier-receipts",
      task.attempt_id,
      `${task.executor_retry_id}.smithers-output.json`
    );
    if (
      verifierReceiptDigest(receipt) !== task.verifier_receipt_digest ||
      receipt.run_id !== input.runtimeRunId ||
      receipt.strategy_attempt_id !== task.attempt_id ||
      receipt.node_id !== task.node_id ||
      receipt.agent_task_id !== `node:${task.attempt_id}` ||
      receipt.ledger_attempt_id !== task.ledger_attempt_id ||
      receipt.workflow_run_id !== task.workflow_run_id ||
      receipt.verifier_task_id !== task.verifier_task_id ||
      receipt.workflow_execution_id !== task.workflow_execution_id ||
      receipt.controller_invocation_id !== task.controller_invocation_id ||
      receipt.checkpoint_generation_id !== task.checkpoint_generation_id ||
      receipt.executor_retry_id !== task.executor_retry_id ||
      receipt.output_manifest_digest !== task.output_manifest_digest ||
      receipt.smithers_output_path !== expectedOutputSourcePath ||
      task.smithers_output_path !== expectedOutputSourcePath ||
      receipt.smithers_output_sha256 !== task.smithers_output_sha256 ||
      verifierOutputBytesDigest(outputContents.toString("utf8")) !== task.smithers_output_sha256
    ) {
      throw new Error(`public benchmark bundle ${receiptPath} is not bound to source attestation task ${taskIndex}`);
    }

    let verificationOutput;
    try {
      verificationOutput = extractVerificationOutput(parseJson(outputContents, outputPath));
    } catch (error) {
      throw new Error(`public benchmark bundle ${outputPath} has invalid exact verifier output`, { cause: error });
    }
    if (
      verificationOutputDigest(verificationOutput) !== receipt.verification_output_digest ||
      !verificationOutputMatchesReceipt(verificationOutput, receipt)
    ) {
      throw new Error(`public benchmark bundle ${outputPath} does not match its verifier receipt`);
    }

    const ledgerEntry = ledgerById.get(task.ledger_attempt_id);
    if (ledgerEntry === undefined || !ledgerEntryMatchesEvidence(ledgerEntry, task, receipt, input.runtimeRunId)) {
      throw new Error(`public benchmark bundle ${ledgerPath} does not bind attested task ${taskIndex}`);
    }
    if (digest(manifestContents) !== task.output_manifest_digest) {
      throw new Error(`public benchmark bundle ${manifestPath} does not match its attested digest`);
    }
    const manifestEvidence = assertManifestReceiptClosure({
      manifestPath,
      manifestContents,
      receipt,
      runtimeRunId: input.runtimeRunId,
      taskAttemptId: task.attempt_id,
      taskRoot,
      contentsByPath: input.contentsByPath,
      expectedPaths
    });
    manifestsByAttempt.set(task.attempt_id, manifestEvidence);
  }
  assertPublishedManifestPrerequisiteClosure(manifestsByAttempt);

  const actualPaths = [...input.contentsByPath.keys()].filter((bundlePath) =>
    bundlePath.startsWith(`${evidenceRoot}/`)
  );
  if (actualPaths.length !== expectedPaths.size || actualPaths.some((bundlePath) => !expectedPaths.has(bundlePath))) {
    throw new Error(`public benchmark bundle ${evidenceRoot} does not contain the exact attested evidence closure`);
  }
}

function verificationOutputMatchesReceipt(
  output: ReturnType<typeof extractVerificationOutput>,
  receipt: VerifierReceipt
): boolean {
  return (
    output.executor.workflow_run_id === receipt.workflow_run_id &&
    output.executor.agent_task_id === receipt.agent_task_id &&
    output.executor.agent_iteration === receipt.agent_iteration &&
    output.executor.agent_attempt === receipt.agent_attempt &&
    output.executor.strategy_attempt_id === receipt.strategy_attempt_id &&
    output.executor.workflow_execution_id === receipt.workflow_execution_id &&
    output.executor.controller_invocation_id === receipt.controller_invocation_id &&
    output.executor.checkpoint_generation_id === receipt.checkpoint_generation_id &&
    output.executor.executor_retry_id === receipt.executor_retry_id &&
    output.executor.execution_identity === receipt.execution_identity &&
    output.executor.request_fingerprint === receipt.request_fingerprint &&
    output.executor.executor_result_digest === receipt.executor_result_digest &&
    output.verifier.workflow_run_id === receipt.workflow_run_id &&
    output.verifier.verifier_task_id === receipt.verifier_task_id &&
    output.verifier.iteration === receipt.verifier_iteration &&
    output.verifier.attempt === receipt.verifier_attempt &&
    output.verifier.verification_identity === receipt.verification_identity &&
    canonicalJson(output.artifacts) === canonicalJson(receipt.artifacts) &&
    output.primary_artifact === receipt.primary_artifact &&
    output.artifact_set_digest === receipt.artifact_set_digest
  );
}

function ledgerEntryMatchesEvidence(
  entry: NodeAttemptLedgerEntry,
  task: WorkspaceSourceAttestation["tasks"][number],
  receipt: VerifierReceipt,
  runtimeRunId: string
): boolean {
  return (
    entry.run_id === runtimeRunId &&
    entry.node_id === task.node_id &&
    entry.strategy_attempt_id === task.attempt_id &&
    entry.executor_retry_id === task.executor_retry_id &&
    entry.checkpoint_generation_id === task.checkpoint_generation_id &&
    entry.workflow_execution_id === task.workflow_execution_id &&
    entry.controller_invocation_id === task.controller_invocation_id &&
    entry.outcome === "succeeded" &&
    entry.reuse.status === "executed" &&
    entry.manifests.output_sha256 === task.output_manifest_digest &&
    entry.manifests.output_sha256 === receipt.output_manifest_digest &&
    entry.evidence?.verifier_receipt_sha256 === task.verifier_receipt_digest &&
    entry.evidence.smithers_output_sha256 === task.smithers_output_sha256 &&
    entry.parent_attempt_id === undefined &&
    entry.failure_category === undefined
  );
}

interface PublishedManifestEvidence {
  manifestPath: string;
  manifestContents: Buffer;
  manifest: PublicArtifactManifest;
}

function assertManifestReceiptClosure(input: {
  manifestPath: string;
  manifestContents: Buffer;
  receipt: VerifierReceipt;
  runtimeRunId: string;
  taskAttemptId: string;
  taskRoot: string;
  contentsByPath: ReadonlyMap<string, Buffer>;
  expectedPaths: Set<string>;
}): PublishedManifestEvidence {
  let manifest: PublicArtifactManifest;
  try {
    manifest = parsePublicArtifactManifest(parseJson(input.manifestContents, input.manifestPath));
  } catch (error) {
    throw new Error(`public benchmark bundle ${input.manifestPath} has an invalid artifact manifest`, {
      cause: error
    });
  }
  if (
    manifest.run_id !== input.runtimeRunId ||
    manifest.node_id !== input.taskAttemptId ||
    manifest.producer_node_id !== input.taskAttemptId ||
    manifest.provenance.producer_node_id !== input.taskAttemptId ||
    manifest.provenance.run_id !== input.runtimeRunId ||
    (manifest.provenance.workflow_run_id !== undefined &&
      manifest.provenance.workflow_run_id !== input.receipt.workflow_run_id) ||
    (manifest.provenance.workflow_task_id !== undefined &&
      manifest.provenance.workflow_task_id !== input.receipt.agent_task_id)
  ) {
    throw new Error(`public benchmark bundle ${input.manifestPath} has invalid manifest identity`);
  }

  const expectedOutputContracts = input.receipt.artifacts.map((artifact) => ({
    path: artifact.path,
    contract: artifact.contract,
    contract_digest: artifact.contract_digest,
    primary: artifact.primary
  }));
  if (canonicalJson(manifest.output_contracts) !== canonicalJson(expectedOutputContracts)) {
    throw new Error(`public benchmark bundle ${input.manifestPath} does not match its receipt output contracts`);
  }

  const receiptIndexByPath = new Map(input.receipt.artifacts.map((artifact, index) => [artifact.path, index]));
  const manifestFilesByPath = new Map(manifest.files.map((file) => [file.path, file]));
  if (input.receipt.artifacts.some((artifact) => !manifestFilesByPath.has(artifact.path))) {
    throw new Error(`public benchmark bundle ${input.manifestPath} omits a receipt artifact`);
  }

  for (const [manifestIndex, manifestFile] of manifest.files.entries()) {
    const receiptIndex = receiptIndexByPath.get(manifestFile.path);
    const evidencePath =
      receiptIndex === undefined
        ? `${input.taskRoot}/manifest-files/${String(manifestIndex).padStart(4, "0")}.bin`
        : `${input.taskRoot}/artifacts/${String(receiptIndex).padStart(4, "0")}.bin`;
    input.expectedPaths.add(evidencePath);
    const artifactContents = requiredEvidenceContents(input.contentsByPath, evidencePath);
    if (manifestFile.size_bytes !== artifactContents.byteLength || digest(artifactContents) !== manifestFile.sha256) {
      throw new Error(`public benchmark bundle ${evidencePath} does not match its receipt and manifest`);
    }
    if (receiptIndex !== undefined) {
      const artifact = input.receipt.artifacts[receiptIndex]!;
      if (manifestFile.sha256 !== artifact.sha256) {
        throw new Error(`public benchmark bundle ${evidencePath} does not match its receipt and manifest`);
      }
    }
  }
  return { manifestPath: input.manifestPath, manifestContents: input.manifestContents, manifest };
}

function assertPublishedManifestPrerequisiteClosure(
  manifestsByAttempt: ReadonlyMap<string, PublishedManifestEvidence>
): void {
  for (const evidence of manifestsByAttempt.values()) {
    for (const prerequisite of evidence.manifest.prerequisite_manifests) {
      const dependency = manifestsByAttempt.get(prerequisite.node_id);
      if (dependency === undefined || digest(dependency.manifestContents) !== prerequisite.sha256) {
        throw new Error(
          `public benchmark bundle ${evidence.manifestPath} has an unresolved or changed prerequisite manifest`
        );
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (attemptId: string): void => {
    if (visited.has(attemptId)) return;
    if (visiting.has(attemptId)) {
      throw new Error("public benchmark bundle artifact manifest prerequisite graph contains a cycle");
    }
    visiting.add(attemptId);
    const evidence = manifestsByAttempt.get(attemptId);
    if (evidence === undefined) {
      throw new Error("public benchmark bundle artifact manifest prerequisite graph is incomplete");
    }
    for (const prerequisite of evidence.manifest.prerequisite_manifests) visit(prerequisite.node_id);
    visiting.delete(attemptId);
    visited.add(attemptId);
  };
  for (const attemptId of manifestsByAttempt.keys()) visit(attemptId);
}

function requiredEvidenceContents(contentsByPath: ReadonlyMap<string, Buffer>, bundlePath: string): Buffer {
  const contents = contentsByPath.get(bundlePath);
  if (contents === undefined) throw new Error(`public benchmark bundle is missing ${bundlePath}`);
  return contents;
}

interface PublicFinalRunRecord {
  rowId: string;
  recoveryEquivalence: ReturnType<typeof parseRecoveryEquivalence>;
  value: Record<string, unknown>;
}

function parseFinalRunRecords(
  bundle: PublicBenchmarkBundle,
  matrixRows: Map<string, PublicBundleMatrixRow>,
  contents: Buffer
): Map<string, PublicFinalRunRecord> {
  const records = parseJsonLines(contents, "eval/runs.jsonl");
  const finalByRow = new Map<string, PublicFinalRunRecord>();
  const lastRecordIndexByRow = new Map<string, number>();
  const terminalRecordIndexByRow = new Map<string, number>();
  const workflowIdByRow = new Map<string, string>();
  for (const [index, value] of records.entries()) {
    const record = recordValue(value);
    const rowId = safeId.safeParse(record?.row_id);
    const matrixRow = rowId.success ? matrixRows.get(rowId.data) : undefined;
    const matrixRunId = matrixRow?.run_id;
    if (
      record === undefined ||
      !rowId.success ||
      matrixRow === undefined ||
      typeof matrixRunId !== "string" ||
      matrixRunId.length === 0 ||
      record.schema_version !== "ultrafuzz.eval.run.v1" ||
      record.eval_run_id !== bundle.eval_run_id ||
      record.target_id !== matrixRow.target_id ||
      record.variant_id !== matrixRow.variant_id ||
      record.trial_id !== matrixRow.trial_id ||
      record.candidate_commit !== bundle.candidate_commit
    ) {
      throw new Error(`public benchmark bundle eval/runs.jsonl record ${index} has mismatched row identity`);
    }
    const expectedUltrafuzzRunId = boundedEvalId([bundle.eval_run_id, matrixRunId], 118);
    if (record.ultrafuzz_run_id !== expectedUltrafuzzRunId) {
      throw new Error(`public benchmark bundle eval/runs.jsonl row ${rowId.data} has mismatched runtime run identity`);
    }
    if (
      record.status !== "launched" ||
      !Array.isArray(record.workflow_ids) ||
      record.workflow_ids.length !== 1 ||
      typeof record.workflow_ids[0] !== "string" ||
      record.workflow_ids[0].length === 0
    ) {
      throw new Error(`public benchmark bundle eval/runs.jsonl row ${rowId.data} has invalid execution lineage`);
    }
    const workflowId = record.workflow_ids[0];
    const priorWorkflowId = workflowIdByRow.get(rowId.data);
    if (priorWorkflowId !== undefined && priorWorkflowId !== workflowId) {
      throw new Error(`public benchmark bundle eval/runs.jsonl row ${rowId.data} changes workflow identity`);
    }
    workflowIdByRow.set(rowId.data, workflowId);
    lastRecordIndexByRow.set(rowId.data, index);
    if (record.final_status === undefined) continue;
    if (finalByRow.has(rowId.data)) {
      throw new Error(`public benchmark bundle eval/runs.jsonl repeats terminal row ${rowId.data}`);
    }
    const workflow = recordValue(record.workflow);
    const terminalDisposition = record.terminal_disposition;
    if (
      (record.final_status !== "succeeded" && record.final_status !== "failed") ||
      workflow?.terminal !== true ||
      (workflow.status !== "succeeded" && workflow.status !== "failed") ||
      (record.final_status === "succeeded" && terminalDisposition !== "clean") ||
      (record.final_status === "failed" && terminalDisposition !== "genuine-task-failures")
    ) {
      throw new Error(`public benchmark bundle eval/runs.jsonl row ${rowId.data} is not an exact terminal execution`);
    }
    let recoveryEquivalence: ReturnType<typeof parseRecoveryEquivalence>;
    try {
      recoveryEquivalence = parseRecoveryEquivalence(record.recovery_equivalence);
    } catch (error) {
      throw new Error(`public benchmark bundle eval/runs.jsonl row ${rowId.data} has invalid recovery evidence`, {
        cause: error
      });
    }
    assertCleanRecoveryClosure(bundle.lane, rowId.data, recoveryEquivalence);
    finalByRow.set(rowId.data, { rowId: rowId.data, recoveryEquivalence, value: record });
    terminalRecordIndexByRow.set(rowId.data, index);
  }
  if (finalByRow.size !== matrixRows.size) {
    throw new Error("public benchmark bundle eval/runs.jsonl terminal row set does not match the matrix");
  }
  for (const rowId of matrixRows.keys()) {
    if (terminalRecordIndexByRow.get(rowId) !== lastRecordIndexByRow.get(rowId)) {
      throw new Error(`public benchmark bundle eval/runs.jsonl row ${rowId} continues after its terminal record`);
    }
  }
  return finalByRow;
}

function assertDiagnosticsTerminalClosure(
  finalRunRecords: Map<string, PublicFinalRunRecord>,
  contentsByPath: Map<string, Buffer>,
  diagnostics: ReturnType<typeof parsePublicEvalDiagnostics>
): void {
  for (const diagnostic of diagnostics.rows) {
    const finalRecord = finalRunRecords.get(diagnostic.row_id)?.value;
    const workflow = recordValue(finalRecord?.workflow);
    const workflowIds = finalRecord?.workflow_ids;
    const reportPath = `reports/${diagnostic.row_id}/report.json`;
    const reportContents = contentsByPath.get(reportPath);
    const report = recordValue(reportContents === undefined ? undefined : parseJson(reportContents, reportPath));
    const runMetadata = recordValue(report?.run_metadata);
    if (
      finalRecord === undefined ||
      workflow === undefined ||
      !Array.isArray(workflowIds) ||
      report === undefined ||
      runMetadata === undefined ||
      diagnostic.run_status !== finalRecord.status ||
      diagnostic.final_status !== finalRecord.final_status ||
      diagnostic.workflow_status !== workflow.status ||
      diagnostic.workflow_terminal !== workflow.terminal ||
      diagnostic.terminal_disposition !== finalRecord.terminal_disposition ||
      diagnostic.terminal_report_present !== true ||
      JSON.stringify(diagnostic.workflow_ids) !== JSON.stringify(workflowIds) ||
      JSON.stringify(runMetadata.workflow_ids) !== JSON.stringify(workflowIds) ||
      runMetadata.run_id !== finalRecord.ultrafuzz_run_id ||
      !Array.isArray(report.non_production_outcomes)
    ) {
      throw new Error(
        `public benchmark bundle diagnostics row is not bound to its terminal run record and report: ${diagnostic.row_id}`
      );
    }
  }
}

function assertCleanRecoveryClosure(
  lane: PublicBenchmarkBundle["lane"],
  rowId: string,
  recovery: ReturnType<typeof parseRecoveryEquivalence>
): void {
  const expectedModelExecutions = lane === "smoke" ? SMOKE_MODEL_BACKED_NODE_IDS.length : undefined;
  if (
    recovery.policy.max_repeated_model_executions !== 0 ||
    recovery.unique_model_backed_node_executions < 1 ||
    (expectedModelExecutions !== undefined &&
      recovery.unique_model_backed_node_executions !== expectedModelExecutions) ||
    recovery.repeated_model_backed_node_executions !== 0 ||
    recovery.recovery_reexecuted_model_backed_node_executions !== 0 ||
    recovery.infrastructure_only_recovery_generations !== 0 ||
    recovery.model_work_recovery_generations !== 0 ||
    recovery.no_progress_recovery_generations !== 0 ||
    recovery.recovery_generations !== 0 ||
    recovery.observed_node_attempts !== recovery.unique_model_backed_node_executions ||
    recovery.observed_workflow_executions !== 1 ||
    recovery.observed_controller_invocations !== 1 ||
    recovery.classification !== "clean" ||
    recovery.reason !== null
  ) {
    throw new Error(`public benchmark bundle row ${rowId} does not have an exact clean execution closure`);
  }
}

function assertSummaryRecoveryClosure(
  bundle: PublicBenchmarkBundle,
  matrixRows: Map<string, PublicBundleMatrixRow>,
  finalRunRecords: Map<string, PublicFinalRunRecord>,
  contents: Buffer
): void {
  const summary = recordValue(parseJson(contents, "eval/summary.json"));
  const provenance = recordValue(summary?.provenance);
  const candidate = recordValue(provenance?.candidate);
  const scoring = recordValue(provenance?.scoring);
  const judgeModels = scoring?.judge_models;
  const judgePanel = recordValue(scoring?.judge_panel);
  if (
    summary?.eval_run_id !== bundle.eval_run_id ||
    !Array.isArray(summary.rows) ||
    candidate?.commit !== bundle.candidate_commit ||
    candidate.dirty !== false ||
    candidate.execution_artifact_id !== `git:${bundle.candidate_commit}` ||
    scoring?.implementation_revision !== `ultrafuzz.eval-scorer.v2-judge-panel@${bundle.candidate_commit}` ||
    scoring.implementation_dirty !== false ||
    scoring.judge_mode !== "llm" ||
    !Array.isArray(judgeModels) ||
    judgeModels.length !== 1 ||
    judgeModels[0] !== bundle.judge_model ||
    judgePanel?.total !== 3 ||
    judgePanel.quorum !== 2
  ) {
    throw new Error("public benchmark bundle eval/summary.json has mismatched eval identity");
  }
  const seen = new Set<string>();
  for (const [index, value] of summary.rows.entries()) {
    const row = recordValue(value);
    const rowId = safeId.safeParse(row?.row_id);
    const matrixRow = rowId.success ? matrixRows.get(rowId.data) : undefined;
    const finalRecord = rowId.success ? finalRunRecords.get(rowId.data) : undefined;
    if (
      row === undefined ||
      !rowId.success ||
      matrixRow === undefined ||
      finalRecord === undefined ||
      seen.has(rowId.data) ||
      row.target_id !== matrixRow.target_id ||
      row.variant_id !== matrixRow.variant_id ||
      row.trial_id !== matrixRow.trial_id
    ) {
      throw new Error(`public benchmark bundle eval/summary.json row ${index} has mismatched identity`);
    }
    let recovery: ReturnType<typeof parseRecoveryEquivalence>;
    try {
      recovery = parseRecoveryEquivalence(row.recovery_equivalence);
    } catch (error) {
      throw new Error(`public benchmark bundle eval/summary.json row ${rowId.data} has invalid recovery evidence`, {
        cause: error
      });
    }
    if (JSON.stringify(recovery) !== JSON.stringify(finalRecord.recoveryEquivalence)) {
      throw new Error(`public benchmark bundle eval/summary.json row ${rowId.data} has mismatched recovery evidence`);
    }
    seen.add(rowId.data);
  }
  if (seen.size !== matrixRows.size) {
    throw new Error("public benchmark bundle eval/summary.json row set does not match the matrix");
  }
}

function assertScoringAndFindingClosure(
  bundle: PublicBenchmarkBundle,
  matrixRows: Map<string, PublicBundleMatrixRow>,
  finalRunRecords: Map<string, PublicFinalRunRecord>,
  contentsByPath: Map<string, Buffer>,
  diagnostics: ReturnType<typeof parsePublicEvalDiagnostics>
): void {
  const expectedScores = new Map<string, { rowId: string; findingId: string; findingTitle: string }>();
  const summaryContents = contentsByPath.get("eval/summary.json");
  if (summaryContents === undefined) throw new Error("public benchmark bundle is missing eval/summary.json");
  const summary = recordValue(parseJson(summaryContents, "eval/summary.json"));
  const summaryRows = new Map<string, Record<string, unknown>>();
  const failedDatapointRows = new Set(
    diagnostics.rows.filter(publicEvalDiagnosticsRowIsFailedDatapoint).map((row) => row.row_id)
  );
  for (const value of Array.isArray(summary?.rows) ? summary.rows : []) {
    const row = recordValue(value);
    if (typeof row?.row_id === "string") summaryRows.set(row.row_id, row);
  }

  for (const rowId of matrixRows.keys()) {
    const findingsPath = `reports/${rowId}/findings.normalized.json`;
    const reportPath = `reports/${rowId}/report.json`;
    const findingsContents = contentsByPath.get(findingsPath);
    const reportContents = contentsByPath.get(reportPath);
    let findings: ReturnType<typeof assertFindingsSchema>;
    try {
      findings = assertFindingsSchema(
        findingsContents === undefined ? undefined : parseJson(findingsContents, findingsPath)
      );
    } catch (error) {
      throw new Error(`public benchmark bundle ${findingsPath} is invalid`, { cause: error });
    }
    const report = recordValue(reportContents === undefined ? undefined : parseJson(reportContents, reportPath));
    if (
      report === undefined ||
      (!failedDatapointRows.has(rowId) && canonicalJson(report.issues) !== canonicalJson(findings))
    ) {
      throw new Error(`public benchmark bundle ${reportPath} issues do not match normalized findings`);
    }
    if (summaryRows.get(rowId)?.finding_count !== findings.length) {
      throw new Error(`public benchmark bundle eval/summary.json row ${rowId} has a mismatched finding count`);
    }
    for (const [index, finding] of findings.entries()) {
      const findingRecord = recordValue(finding);
      const findingId = safeId.safeParse(findingRecord?.id);
      if (!findingId.success || typeof findingRecord?.title !== "string" || findingRecord.title.length === 0) {
        throw new Error(`public benchmark bundle ${findingsPath} finding ${index} has invalid scoring identity`);
      }
      const scoreKey = `${rowId}\u0000${findingId.data}`;
      if (expectedScores.has(scoreKey)) {
        throw new Error(`public benchmark bundle ${findingsPath} repeats finding ${findingId.data}`);
      }
      expectedScores.set(scoreKey, { rowId, findingId: findingId.data, findingTitle: findingRecord.title });
    }
  }

  const scoreContents = contentsByPath.get("eval/scores.jsonl");
  if (scoreContents === undefined) throw new Error("public benchmark bundle is missing eval/scores.jsonl");
  const scoreRecords =
    scoreContents.toString("utf8").trim().length === 0 ? [] : parseJsonLines(scoreContents, "eval/scores.jsonl");
  const seenScores = new Set<string>();
  for (const [index, value] of scoreRecords.entries()) {
    const score = recordValue(value);
    const scoreKey = `${String(score?.row_id ?? "")}\u0000${String(score?.finding_id ?? "")}`;
    const expected = expectedScores.get(scoreKey);
    const finalRunRecord = expected === undefined ? undefined : finalRunRecords.get(expected.rowId);
    const deterministic = recordValue(score?.deterministic_match);
    const judged = recordValue(score?.judge_result);
    if (
      score === undefined ||
      expected === undefined ||
      finalRunRecord === undefined ||
      seenScores.has(scoreKey) ||
      score.finding_title !== expected.findingTitle ||
      typeof score.report_path !== "string" ||
      typeof finalRunRecord.value.ultrafuzz_run_id !== "string" ||
      !score.report_path.includes(`/${finalRunRecord.value.ultrafuzz_run_id}/artifacts/final-report/report.json`) ||
      deterministic?.judge_model !== bundle.judge_model ||
      deterministic.reasoning_effort !== bundle.judge_reasoning ||
      judged?.judge_model !== bundle.judge_model ||
      judged.reasoning_effort !== bundle.judge_reasoning
    ) {
      throw new Error(`public benchmark bundle eval/scores.jsonl record ${index} has mismatched scoring identity`);
    }
    seenScores.add(scoreKey);
  }
  if (seenScores.size !== expectedScores.size) {
    throw new Error("public benchmark bundle eval/scores.jsonl does not score the exact normalized finding set");
  }
}

function assertNoReportTargetRevisionContradictions(
  matrixRows: Map<string, PublicBundleMatrixRow>,
  contentsByPath: Map<string, Buffer>
): void {
  const commitFields = ["commit", "revision", "target_commit", "target_revision"] as const;
  for (const [rowId, row] of matrixRows) {
    const reportPath = `reports/${rowId}/report.json`;
    const contents = contentsByPath.get(reportPath);
    let report: unknown;
    try {
      report = contents === undefined ? undefined : (JSON.parse(contents.toString("utf8")) as unknown);
    } catch (error) {
      throw new Error(`public benchmark bundle ${reportPath} is not valid JSON`, { cause: error });
    }
    const reportRecord = recordValue(report);
    if (reportRecord === undefined) {
      throw new Error(`public benchmark bundle ${reportPath} must contain a JSON object`);
    }
    if (reportRecord.run_metadata === undefined) continue;
    const runMetadata = recordValue(reportRecord.run_metadata);
    if (runMetadata === undefined) {
      throw new Error(`public benchmark bundle ${reportPath} run_metadata must be an object`);
    }

    const candidates = commitFields.flatMap((field) => {
      const value = runMetadata[field];
      return typeof value === "string" ? [value.trim()] : [];
    });
    const target = runMetadata.target;
    if (typeof target === "string") {
      candidates.push(...[...target.matchAll(/@\s+commit\s+([0-9a-f]{7,40})\b/giu)].map((match) => match[1] ?? ""));
    }
    for (const candidate of candidates) {
      if (/^[0-9a-f]{7,40}$/iu.test(candidate) && !row.target.ref.startsWith(candidate.toLowerCase())) {
        throw new Error(`public benchmark bundle ${reportPath} contradicts the matrix target revision`);
      }
    }
  }
}

function assertSmokeFindingFloor(
  lane: PublicBenchmarkBundle["lane"],
  matrixRows: Map<string, PublicBundleMatrixRow>,
  contentsByPath: Map<string, Buffer>,
  diagnostics: ReturnType<typeof parsePublicEvalDiagnostics>
): void {
  if (lane !== "smoke") return;
  const failedDatapointRows = new Set(
    diagnostics.rows.filter(publicEvalDiagnosticsRowIsFailedDatapoint).map((row) => row.row_id)
  );
  for (const rowId of matrixRows.keys()) {
    const bundlePath = `reports/${rowId}/findings.normalized.json`;
    const contents = contentsByPath.get(bundlePath);
    let findings;
    try {
      findings = assertFindingsSchema(
        contents === undefined ? undefined : (JSON.parse(contents.toString("utf8")) as unknown)
      );
    } catch (error) {
      throw new Error(`smoke benchmark row ${rowId} has invalid normalized findings`, { cause: error });
    }
    if (findings.length === 0 && !failedDatapointRows.has(rowId)) {
      throw new Error(`smoke benchmark row ${rowId} must report at least one normalized finding`);
    }
  }
}

interface PublicBundleMatrixRow {
  id: string;
  target_id: string;
  variant_id: string;
  trial_id: string;
  target: {
    id: string;
    repo: string;
    ref: string;
  };
  framework?: string;
  run_id?: string;
  runner_model_profile?: string;
  runner_model?: string;
  runner_reasoning?: string;
  judge_model_profile?: string;
  judge_model?: string;
  judge_reasoning?: string;
}

function parseMatrixRows(contents: Buffer, requireTargetFramework = false): Map<string, PublicBundleMatrixRow> {
  let value: unknown;
  try {
    value = JSON.parse(contents.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("public benchmark bundle eval/matrix.json is not valid JSON", { cause: error });
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("public benchmark bundle eval/matrix.json must be a non-empty array");
  }
  const rows = new Map<string, PublicBundleMatrixRow>();
  for (const [index, row] of value.entries()) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error(`public benchmark bundle matrix row ${index} must be an object`);
    }
    const input = row as Record<string, unknown>;
    const id = safeId.safeParse(input.id);
    if (!id.success) throw new Error(`public benchmark bundle matrix row ${index} has an invalid ID`);
    const targetId = safeId.safeParse(input.target_id);
    const variantId = safeId.safeParse(input.variant_id);
    const trialId = safeId.safeParse(input.trial_id);
    if (!targetId.success || !variantId.success || !trialId.success) {
      throw new Error(`public benchmark bundle matrix row ${index} has an invalid identity`);
    }
    const target = parseMatrixTargetIdentity(input.target, targetId.data, index);
    const framework = parseMatrixTargetFramework(input, targetId.data, index, requireTargetFramework);
    if (rows.has(id.data)) throw new Error(`public benchmark bundle matrix repeats row ID ${id.data}`);
    rows.set(id.data, {
      id: id.data,
      target_id: targetId.data,
      variant_id: variantId.data,
      trial_id: trialId.data,
      target,
      ...(framework === undefined ? {} : { framework }),
      ...optionalMatrixIdentity(input)
    });
  }
  return rows;
}

function optionalMatrixIdentity(row: Record<string, unknown>): Partial<PublicBundleMatrixRow> {
  return Object.fromEntries(
    [
      "run_id",
      "runner_model_profile",
      "runner_model",
      "runner_reasoning",
      "judge_model_profile",
      "judge_model",
      "judge_reasoning"
    ].flatMap((field) => (typeof row[field] === "string" ? [[field, row[field]]] : []))
  );
}

function parseMatrixTargetIdentity(value: unknown, targetId: string, index: number): PublicBundleMatrixRow["target"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`public benchmark bundle matrix row ${index} is missing target identity`);
  }
  const target = value as Record<string, unknown>;
  const id = safeId.safeParse(target.id);
  const repo = z.string().url().max(2_048).safeParse(target.repo);
  const ref = fullSha.safeParse(target.ref);
  if (!id.success || !repo.success || !ref.success || id.data !== targetId) {
    throw new Error(`public benchmark bundle matrix row ${index} has an invalid target identity`);
  }
  return { id: id.data, repo: repo.data, ref: ref.data };
}

function parseMatrixTargetFramework(
  row: Record<string, unknown>,
  targetId: string,
  index: number,
  required: boolean
): string | undefined {
  const workflowInput = recordValue(row.workflow_input);
  const frameworks = recordValue(workflowInput?.target_frameworks);
  if (frameworks === undefined || !(targetId in frameworks)) {
    if (required) {
      throw new Error(`public benchmark bundle matrix row ${index} is missing its target framework`);
    }
    return undefined;
  }
  const framework = safeId.safeParse(frameworks[targetId]);
  if (!framework.success) {
    throw new Error(`public benchmark bundle matrix row ${index} has an invalid target framework`);
  }
  return framework.data;
}

function parseSummaryRows(contents: Buffer): Set<string> {
  let value: unknown;
  try {
    value = JSON.parse(contents.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("public benchmark bundle eval/summary.json is not valid JSON", { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("public benchmark bundle eval/summary.json must be an object");
  }
  const rowsValue = (value as Record<string, unknown>).rows;
  if (!Array.isArray(rowsValue) || rowsValue.length === 0) {
    throw new Error("public benchmark bundle eval/summary.json rows must be a non-empty array");
  }
  const rows = new Set<string>();
  for (const [index, row] of rowsValue.entries()) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error(`public benchmark bundle summary row ${index} must be an object`);
    }
    const rowId = safeId.safeParse((row as Record<string, unknown>).row_id);
    if (!rowId.success) throw new Error(`public benchmark bundle summary row ${index} has an invalid row ID`);
    if (rows.has(rowId.data)) throw new Error(`public benchmark bundle summary repeats row ID ${rowId.data}`);
    rows.add(rowId.data);
  }
  return rows;
}

function summarizePublicBenchmarkBundleFiles(
  files: readonly PublicBenchmarkBundleFile[],
  publicationBundlePath: string
): PublicBenchmarkBundleMetadata {
  const contentsByPath = new Map<string, Buffer>();
  for (const file of files) contentsByPath.set(file.path, Buffer.from(file.contents_base64, "base64"));
  const matrixContents = contentsByPath.get("eval/matrix.json");
  if (matrixContents === undefined) throw new Error("public benchmark bundle is missing eval/matrix.json");
  const summaryContents = contentsByPath.get("eval/summary.json");
  if (summaryContents === undefined) throw new Error("public benchmark bundle is missing eval/summary.json");
  const diagnosticsContents = contentsByPath.get(`eval/${PUBLIC_EVAL_DIAGNOSTICS_FILE}`);
  if (diagnosticsContents === undefined) {
    throw new Error(`public benchmark bundle is missing eval/${PUBLIC_EVAL_DIAGNOSTICS_FILE}`);
  }
  return summarizePublicBenchmarkBundleContents({
    matrixRows: parseMatrixRows(matrixContents, true),
    diagnostics: parseBundleDiagnostics(diagnosticsContents),
    summaryRows: parseSummaryRows(summaryContents),
    publicationBundlePath,
    reportPathsByRow: publicReportPathsByRow(new Set(files.map((file) => file.path)))
  });
}

function summarizePublicBenchmarkBundleContents(input: {
  matrixRows: Map<string, PublicBundleMatrixRow>;
  diagnostics: ReturnType<typeof parsePublicEvalDiagnostics>;
  summaryRows: Set<string>;
  publicationBundlePath: string;
  reportFiles?: readonly string[];
  reportPathsByRow?: ReadonlyMap<string, readonly string[]>;
}): PublicBenchmarkBundleMetadata {
  const diagnosticsByRow = new Map(input.diagnostics.rows.map((row) => [row.row_id, row]));
  const rowsByTarget = new Map<string, PublicBundleMatrixRow[]>();
  for (const row of input.matrixRows.values()) {
    rowsByTarget.set(row.target_id, [...(rowsByTarget.get(row.target_id) ?? []), row]);
  }

  const targets = [...rowsByTarget.values()]
    .map((rows): PublicBenchmarkBundleTarget => {
      const first = rows[0]!;
      const target = first.target;
      const frameworks = new Set(rows.flatMap((row) => (row.framework === undefined ? [] : [row.framework])));
      if (frameworks.size > 1) {
        throw new Error(`public benchmark bundle target ${first.target_id} has inconsistent framework identity`);
      }
      for (const row of rows) {
        if (row.target.id !== target.id || row.target.repo !== target.repo || row.target.ref !== target.ref) {
          throw new Error(`public benchmark bundle target ${first.target_id} has inconsistent target identity`);
        }
      }
      const diagnostics = rows.map((row) => diagnosticsByRow.get(row.id)).filter((row) => row !== undefined);
      const executedCaseCount = diagnostics.filter(
        (row) => row?.run_status === "launched" && row.workflow_terminal && row.terminal_report_present
      ).length;
      const gradedCaseCount = rows.filter((row) => input.summaryRows.has(row.id)).length;
      const status = diagnostics.every(
        (row) => row?.final_status === "succeeded" && row.workflow_status === "succeeded"
      )
        ? "succeeded"
        : diagnostics.some((row) => row?.terminal_disposition === "operational-failure")
          ? "failed"
          : "genuine-task-failures";
      const reportPaths = rows
        .flatMap(
          (row) =>
            input.reportPathsByRow?.get(row.id) ??
            (input.reportFiles ?? PUBLIC_REPORT_FILES).map((reportFile) => `reports/${row.id}/${reportFile}`)
        )
        .sort(compareText);
      return {
        id: target.id,
        repository: target.repo,
        revision: target.ref,
        ...(frameworks.size === 0 ? {} : { framework: [...frameworks][0]! }),
        status,
        executed_case_count: executedCaseCount,
        graded_case_count: gradedCaseCount,
        publication_location: {
          bundle_path: input.publicationBundlePath,
          report_paths: reportPaths
        }
      };
    })
    .sort((left, right) => compareText(left.id, right.id));

  const executedCaseCount = targets.reduce((sum, target) => sum + target.executed_case_count, 0);
  const gradedCaseCount = targets.reduce((sum, target) => sum + target.graded_case_count, 0);
  return {
    status: targets.every((target) => target.status === "succeeded")
      ? "succeeded"
      : targets.some((target) => target.status === "failed")
        ? "failed"
        : "genuine-task-failures",
    executed_case_count: executedCaseCount,
    graded_case_count: gradedCaseCount,
    targets
  };
}

function publicReportPathsByRow(paths: ReadonlySet<string>): Map<string, readonly string[]> {
  const result = new Map<string, string[]>();
  for (const bundlePath of paths) {
    if (!bundlePath.startsWith("reports/")) continue;
    const rowId = bundlePath.split("/", 3)[1];
    if (rowId === undefined) throw new Error(`public benchmark bundle has an invalid report path: ${bundlePath}`);
    const existing = result.get(rowId) ?? [];
    existing.push(bundlePath);
    result.set(rowId, existing);
  }
  for (const rowPaths of result.values()) rowPaths.sort(compareText);
  return result;
}

function uniqueDeclaredPublicationBundlePath(targets: readonly PublicBenchmarkBundleTarget[]): string {
  const bundlePaths = new Set(targets.map((target) => target.publication_location.bundle_path));
  if (bundlePaths.size !== 1) throw new Error("public benchmark bundle target publication paths are inconsistent");
  return [...bundlePaths][0]!;
}

function assertPublicBenchmarkBundleMetadata(
  bundle: PublicBenchmarkBundle,
  expected: PublicBenchmarkBundleMetadata
): void {
  if (bundle.executed_case_count === 0) {
    throw new Error("public benchmark bundle executed case count must be positive");
  }
  if (bundle.graded_case_count === 0) {
    throw new Error("public benchmark bundle graded case count must be positive");
  }
  for (const target of bundle.targets) {
    if (target.executed_case_count === 0) {
      throw new Error(`public benchmark bundle target ${target.id} executed case count must be positive`);
    }
    if (target.graded_case_count === 0) {
      throw new Error(`public benchmark bundle target ${target.id} graded case count must be positive`);
    }
  }
  const actualMetadata: PublicBenchmarkBundleMetadata = {
    status: bundle.status,
    executed_case_count: bundle.executed_case_count,
    graded_case_count: bundle.graded_case_count,
    targets: bundle.targets
  };
  if (JSON.stringify(actualMetadata) !== JSON.stringify(expected)) {
    throw new Error("public benchmark bundle result metadata does not match its scored files");
  }
}

function parseBundleDiagnostics(contents: Buffer): ReturnType<typeof parsePublicEvalDiagnostics> {
  if (contents.byteLength > MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES) {
    throw new Error("public benchmark bundle diagnostics exceed the size limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(contents.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("public benchmark bundle diagnostics are not valid JSON", { cause: error });
  }
  try {
    return parsePublicEvalDiagnostics(value);
  } catch (error) {
    throw new Error("public benchmark bundle diagnostics are invalid", { cause: error });
  }
}

function assertBundleDiagnosticsLineage(
  bundle: PublicBenchmarkBundle,
  diagnostics: ReturnType<typeof parsePublicEvalDiagnostics>
): void {
  const providerReportedModels = new Set(
    diagnostics.rows.flatMap((row) =>
      "model_identity" in row && row.model_identity !== undefined ? [row.model_identity.provider_reported_model] : []
    )
  );
  const mismatches = [
    diagnostics.benchmark === bundle.benchmark ? undefined : "benchmark",
    diagnostics.lane === bundle.lane ? undefined : "lane",
    diagnostics.model_slug === bundle.model_slug ? undefined : "model slug",
    diagnostics.model === bundle.model ? undefined : "model",
    (bundle.schema_version !== PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION &&
      bundle.schema_version !== PUBLIC_BENCHMARK_BUNDLE_V6_SCHEMA_VERSION) ||
    (providerReportedModels.size === 1 && providerReportedModels.has(bundle.provider_reported_model))
      ? undefined
      : "provider-reported model",
    diagnostics.reasoning === bundle.reasoning ? undefined : "reasoning",
    diagnostics.candidate_commit === bundle.candidate_commit ? undefined : "candidate commit",
    diagnostics.eval_run_id === bundle.eval_run_id ? undefined : "eval run",
    diagnostics.lineage.logical_run_id === bundle.lineage.logical_run_id ? undefined : "logical run lineage",
    diagnostics.lineage.generation === bundle.lineage.generation ? undefined : "generation lineage",
    diagnostics.lineage.attempt === bundle.lineage.attempt ? undefined : "attempt lineage",
    diagnostics.lineage.attempt_id === bundle.lineage.attempt_id ? undefined : "attempt ID lineage",
    diagnostics.lineage.config_fingerprint === bundle.lineage.config_fingerprint ? undefined : "configuration lineage",
    diagnostics.lineage.source_fingerprint === bundle.lineage.source_fingerprint ? undefined : "source lineage",
    diagnostics.lineage.image_fingerprint === bundle.lineage.image_fingerprint ? undefined : "image lineage",
    diagnostics.lineage.model_fingerprint === bundle.lineage.model_fingerprint ? undefined : "model lineage"
  ].filter((value): value is string => value !== undefined);
  if (mismatches.length > 0) {
    throw new Error(`public benchmark bundle diagnostics do not match ${mismatches.join(", ")}`);
  }
}

function assertCurrentModelAndPricingClosure(
  bundle: ModelPricingPublicBenchmarkBundle,
  matrixRows: ReadonlyMap<string, PublicBundleMatrixRow>,
  finalRunRecords: ReadonlyMap<string, PublicFinalRunRecord>,
  contentsByPath: ReadonlyMap<string, Buffer>,
  summaryContents: Buffer,
  diagnostics: ReturnType<typeof parsePublicEvalDiagnostics>
): void {
  if (
    diagnostics.schema_version !== PUBLIC_EVAL_DIAGNOSTICS_SCHEMA_VERSION &&
    diagnostics.schema_version !== PUBLIC_EVAL_DIAGNOSTICS_V3_SCHEMA_VERSION
  ) {
    throw new Error("public benchmark bundle has incompatible model and pricing diagnostics");
  }
  const summary = recordValue(parseJson(summaryContents, "eval/summary.json"));
  if (!Array.isArray(summary?.rows)) {
    throw new Error("public benchmark bundle summary is missing row pricing closure");
  }
  const summaryRows = new Map<string, Record<string, unknown>>();
  for (const value of summary.rows) {
    const row = recordValue(value);
    const rowId = safeId.safeParse(row?.row_id);
    if (!rowId.success || row === undefined || summaryRows.has(rowId.data)) {
      throw new Error("public benchmark bundle summary has invalid row pricing closure");
    }
    summaryRows.set(rowId.data, row);
  }
  if (summaryRows.size !== matrixRows.size) {
    throw new Error("public benchmark bundle summary row pricing closure does not match the matrix");
  }
  for (const diagnostic of diagnostics.rows) {
    const identity = diagnostic.model_identity;
    const pricing = diagnostic.pricing;
    const summaryRow = summaryRows.get(diagnostic.row_id);
    const efficiency = recordValue(summaryRow?.efficiency);
    const usageCompleteness = recordValue(efficiency?.usage);
    const costCompleteness = recordValue(efficiency?.cost);
    if (
      identity === undefined ||
      pricing === undefined ||
      identity.configured_model !== bundle.model ||
      identity.provider_reported_model !== bundle.provider_reported_model ||
      pricing.configured_model !== bundle.model ||
      pricing.provider_reported_model !== bundle.provider_reported_model ||
      efficiency === undefined ||
      efficiency.total_tokens !== pricing.usage.total_tokens ||
      efficiency.cost_usd !== pricing.cost_usd ||
      usageCompleteness?.status !== "complete" ||
      usageCompleteness.reason !== null ||
      costCompleteness?.status !== "complete" ||
      costCompleteness.reason !== null
    ) {
      throw new Error(`public benchmark bundle row ${diagnostic.row_id} has incomplete model or pricing closure`);
    }
    if (bundle.schema_version === PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION) {
      const finalRunRecord = finalRunRecords.get(diagnostic.row_id);
      if (finalRunRecord === undefined) {
        throw new Error(`public benchmark bundle row ${diagnostic.row_id} is missing its terminal run record`);
      }
      assertRawAccountingClosure({
        bundle,
        rowId: diagnostic.row_id,
        finalRunRecord: finalRunRecord.value,
        identity,
        pricing,
        summaryRow: summaryRow!,
        contentsByPath
      });
    }
  }
}

function assertRawAccountingClosure(input: {
  bundle: CurrentPublicBenchmarkBundle;
  rowId: string;
  finalRunRecord: Record<string, unknown>;
  identity: PublicModelIdentity;
  pricing: PublicPricingEvidence;
  summaryRow: Record<string, unknown>;
  contentsByPath: ReadonlyMap<string, Buffer>;
}): void {
  const runtimeRunId =
    typeof input.finalRunRecord.ultrafuzz_run_id === "string" ? input.finalRunRecord.ultrafuzz_run_id : undefined;
  const workflowIds = input.finalRunRecord.workflow_ids;
  if (runtimeRunId === undefined || !Array.isArray(workflowIds) || workflowIds.length !== 1) {
    throw new Error(`public benchmark bundle row ${input.rowId} has no unique raw-accounting execution identity`);
  }
  const workflowRunId = workflowIds[0];
  if (typeof workflowRunId !== "string") {
    throw new Error(`public benchmark bundle row ${input.rowId} has an invalid raw-accounting workflow identity`);
  }
  let binding: TerminalEvidenceBinding;
  try {
    binding = terminalEvidenceBindingSchema.parse(input.finalRunRecord.terminal_evidence);
  } catch (error) {
    throw new Error(`public benchmark bundle row ${input.rowId} has invalid raw-accounting binding`, { cause: error });
  }
  if (binding.pricing_catalog_sha256 === null) {
    throw new Error(`public benchmark bundle row ${input.rowId} has no raw pricing catalog binding`);
  }

  const evidenceRoot = `reports/${input.rowId}/${PUBLIC_EXECUTION_EVIDENCE_DIRECTORY}`;
  const runMetadataPath = `${evidenceRoot}/${PUBLIC_RUN_METADATA_FILE}`;
  const usageLedgerPath = `${evidenceRoot}/${PUBLIC_USAGE_LEDGER_FILE}`;
  const pricingCatalogPath = `${evidenceRoot}/${PUBLIC_PRICING_CATALOGS_DIRECTORY}/${binding.pricing_catalog_sha256}.json`;
  const runMetadataContents = requiredEvidenceContents(input.contentsByPath, runMetadataPath);
  const usageLedgerContents = requiredEvidenceContents(input.contentsByPath, usageLedgerPath);
  const pricingCatalogContents = requiredEvidenceContents(input.contentsByPath, pricingCatalogPath);
  if (
    digest(runMetadataContents) !== binding.run_metadata_sha256 ||
    digest(usageLedgerContents) !== binding.usage_ledger_sha256 ||
    digest(pricingCatalogContents) !== binding.pricing_catalog_sha256
  ) {
    throw new Error(`public benchmark bundle row ${input.rowId} raw accounting bytes do not match terminal binding`);
  }

  const usageEntries = parseJsonLines(usageLedgerContents, usageLedgerPath).map((value, index) => {
    try {
      return assertUsageLedgerEntry(value);
    } catch (error) {
      throw new Error(`public benchmark bundle ${usageLedgerPath} has invalid entry ${index}`, { cause: error });
    }
  });
  const receiptPaths = [...input.contentsByPath.keys()]
    .filter(
      (bundlePath) =>
        bundlePath.startsWith(`${evidenceRoot}/`) &&
        bundlePath.endsWith("/verifier-receipt.json") &&
        bundlePath.split("/").length === evidenceRoot.split("/").length + 2
    )
    .sort(compareText);
  const receipts = receiptPaths.map((receiptPath) => {
    try {
      return parseVerifierReceipt(parseJson(requiredEvidenceContents(input.contentsByPath, receiptPath), receiptPath));
    } catch (error) {
      throw new Error(`public benchmark bundle ${receiptPath} is invalid raw accounting evidence`, { cause: error });
    }
  });
  if (
    usageEntries.length === 0 ||
    usageEntries.length !== receipts.length ||
    (input.bundle.lane === "smoke" && usageEntries.length !== SMOKE_MODEL_BACKED_NODE_IDS.length)
  ) {
    throw new Error(`public benchmark bundle row ${input.rowId} raw accounting invocation count is incomplete`);
  }

  const receiptKeys = new Map<string, VerifierReceipt>();
  const receiptNodeIds = new Set<string>();
  for (const receipt of receipts) {
    const key = accountingAttemptKey(receipt.agent_task_id, receipt.agent_iteration, receipt.agent_attempt);
    if (receipt.run_id !== runtimeRunId || receipt.workflow_run_id !== workflowRunId || receiptKeys.has(key)) {
      throw new Error(`public benchmark bundle row ${input.rowId} has duplicate or foreign verifier accounting keys`);
    }
    receiptKeys.set(key, receipt);
    receiptNodeIds.add(receipt.node_id);
  }
  if (
    input.bundle.lane === "smoke" &&
    (receiptNodeIds.size !== SMOKE_MODEL_BACKED_NODE_IDS.length ||
      SMOKE_MODEL_BACKED_NODE_IDS.some((nodeId) => !receiptNodeIds.has(nodeId)))
  ) {
    throw new Error(`public benchmark bundle row ${input.rowId} raw accounting does not cover the smoke nodes`);
  }

  const eventIds = new Set<string>();
  const sourceEventIds = new Set<string>();
  const ledgerAttemptIds = new Set<string>();
  const invocationIds = new Set<string>();
  const invocationKeys = new Set<string>();
  for (const entry of usageEntries) {
    const invocation = entry.model_invocation;
    const key =
      invocation === undefined
        ? undefined
        : accountingAttemptKey(invocation.node_id, invocation.iteration, invocation.attempt);
    if (
      invocation === undefined ||
      key === undefined ||
      !receiptKeys.has(key) ||
      eventIds.has(entry.event_id) ||
      sourceEventIds.has(entry.source_event_id) ||
      ledgerAttemptIds.has(entry.attempt_id) ||
      invocationIds.has(invocation.invocation_id) ||
      invocationKeys.has(key) ||
      entry.run_id !== runtimeRunId ||
      entry.workflow_run_id !== workflowRunId ||
      entry.usage_complete !== true ||
      entry.usage_incomplete_reasons.length !== 0 ||
      invocation.configured_model !== input.bundle.model ||
      invocation.provider_reported_model !== input.bundle.provider_reported_model ||
      invocation.terminal_evidence_complete !== true ||
      entry.usage.model !== input.bundle.provider_reported_model ||
      entry.usage.cost_usd !== undefined
    ) {
      throw new Error(
        `public benchmark bundle row ${input.rowId} has invalid or duplicate raw usage invocation evidence`
      );
    }
    eventIds.add(entry.event_id);
    sourceEventIds.add(entry.source_event_id);
    ledgerAttemptIds.add(entry.attempt_id);
    invocationIds.add(invocation.invocation_id);
    invocationKeys.add(key);
  }
  if (invocationKeys.size !== receiptKeys.size || [...receiptKeys.keys()].some((key) => !invocationKeys.has(key))) {
    throw new Error(
      `public benchmark bundle row ${input.rowId} raw usage does not bijectively match verifier receipts`
    );
  }

  let rawModelPrices: ReadonlyMap<string, ModelPricing>;
  try {
    rawModelPrices = modelPricingFromCatalogBytes(pricingCatalogContents, [input.bundle.model]);
  } catch (error) {
    throw new Error(`public benchmark bundle ${pricingCatalogPath} cannot be independently priced`, { cause: error });
  }
  const normalizedModel = input.bundle.model.trim().toLowerCase();
  const modelPrice = rawModelPrices.get(normalizedModel);
  if (
    modelPrice === undefined ||
    modelPrice.cachedInputUsdPerMillion === undefined ||
    modelPrice.reasoningUsdPerMillion === undefined ||
    (modelPrice.contextTiers?.length ?? 0) !== 0
  ) {
    throw new Error(`public benchmark bundle row ${input.rowId} raw catalog has incomplete public pricing rates`);
  }
  const rates = {
    uncached_input: modelPrice.inputUsdPerMillion,
    cache_read: modelPrice.cachedInputUsdPerMillion,
    cache_write: modelPrice.cacheWriteUsdPerMillion ?? null,
    output: modelPrice.outputUsdPerMillion,
    reasoning: modelPrice.reasoningUsdPerMillion
  };
  if (canonicalJson(rates) !== canonicalJson(input.pricing.rates_usd_per_million)) {
    throw new Error(`public benchmark bundle row ${input.rowId} diagnostics rates do not match the raw catalog`);
  }

  const replay = replayRawPublicAccounting(usageEntries, modelPrice, input.bundle.model);
  const rawInvocations = usageEntries
    .map((entry) => entry.model_invocation!)
    .sort((left, right) => compareText(left.invocation_id, right.invocation_id))
    .map((invocation) => ({
      invocation_id: invocation.invocation_id,
      configured_model: invocation.configured_model,
      provider_reported_model: invocation.provider_reported_model
    }));
  if (
    input.identity.configured_model !== input.bundle.model ||
    input.identity.provider_reported_model !== input.bundle.provider_reported_model ||
    input.identity.invocation_count !== rawInvocations.length ||
    canonicalJson(input.identity.invocations) !== canonicalJson(rawInvocations) ||
    canonicalJson(input.pricing.usage) !== canonicalJson(replay.usage) ||
    canonicalJson(input.pricing.component_costs_usd) !== canonicalJson(replay.componentCosts) ||
    input.pricing.cost_usd !== replay.costUsd ||
    input.pricing.event_count !== usageEntries.length ||
    input.pricing.priced_event_count !== usageEntries.length ||
    input.pricing.catalog.catalog_sha256 !== binding.pricing_catalog_sha256
  ) {
    throw new Error(
      `public benchmark bundle row ${input.rowId} diagnostics do not replay from raw accounting evidence`
    );
  }

  assertRawRunMetadataClosure({
    rowId: input.rowId,
    runtimeRunId,
    workflowRunId,
    runMetadataContents,
    catalogSha256: binding.pricing_catalog_sha256,
    modelPrice,
    rawInvocations,
    usageEntries,
    replay,
    bundle: input.bundle,
    pricing: input.pricing
  });
  const efficiency = recordValue(input.summaryRow.efficiency);
  if (efficiency?.total_tokens !== replay.usage.total_tokens || efficiency.cost_usd !== replay.costUsd) {
    throw new Error(`public benchmark bundle row ${input.rowId} summary does not replay from raw accounting evidence`);
  }
}

function replayRawPublicAccounting(
  entries: readonly UsageLedgerEntry[],
  modelPrice: ModelPricing,
  model: string
): {
  usage: PublicPricingEvidence["usage"];
  componentCosts: PublicPricingEvidence["component_costs_usd"];
  costUsd: number;
} {
  const deepSeek = model.toLowerCase().startsWith("deepseek-");
  const usage = {
    uncached_input_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    inclusive_token_total: 0,
    billable_token_total: 0,
    total_tokens: 0
  };
  const componentCosts = {
    uncached_input: 0,
    cache_read: 0,
    cache_write: 0,
    output: 0,
    reasoning: 0
  };
  const rates = {
    uncached_input: modelPrice.inputUsdPerMillion,
    cache_read: modelPrice.cachedInputUsdPerMillion,
    cache_write: modelPrice.cacheWriteUsdPerMillion,
    output: modelPrice.outputUsdPerMillion,
    reasoning: modelPrice.reasoningUsdPerMillion
  };
  for (const entry of entries) {
    const uncachedInput = rawTokenCount(entry, "input_tokens");
    const cacheRead = rawTokenCount(entry, "cache_read_tokens");
    const cacheWrite = rawTokenCount(entry, "cache_write_tokens");
    const output = rawTokenCount(entry, "output_tokens");
    const reportedReasoning = rawTokenCount(entry, "reasoning_tokens");
    if (deepSeek && reportedReasoning !== 0) {
      throw new Error(`public raw DeepSeek usage ${entry.event_id} double-counts reasoning tokens`);
    }
    const reasoning = deepSeek ? 0 : reportedReasoning;
    const components = {
      uncached_input: uncachedInput,
      cache_read: cacheRead,
      cache_write: cacheWrite,
      output,
      reasoning
    };
    const inclusive = Object.values(components).reduce((sum, tokens) => sum + tokens, 0);
    if (inclusive <= 0 || rawTokenCount(entry, "total_tokens") !== inclusive) {
      throw new Error(`public raw usage ${entry.event_id} has an incomplete component breakdown`);
    }
    for (const component of Object.keys(components) as Array<keyof typeof components>) {
      const tokens = components[component];
      const rate = rates[component];
      if (tokens > 0 && rate === undefined) {
        throw new Error(`public raw usage ${entry.event_id} has no ${component} catalog rate`);
      }
      if (rate !== undefined) {
        componentCosts[component] = addPublicUsd(
          componentCosts[component],
          roundPublicUsd((tokens * rate) / 1_000_000)
        );
        if (rate > 0) usage.billable_token_total += tokens;
      }
    }
    usage.uncached_input_tokens += uncachedInput;
    usage.cache_read_tokens += cacheRead;
    usage.cache_write_tokens += cacheWrite;
    usage.output_tokens += output;
    usage.reasoning_tokens += reasoning;
    usage.inclusive_token_total += inclusive;
    usage.total_tokens += inclusive;
  }
  return {
    usage,
    componentCosts,
    costUsd: Object.values(componentCosts).reduce((sum, cost) => addPublicUsd(sum, cost), 0)
  };
}

function assertRawRunMetadataClosure(input: {
  rowId: string;
  runtimeRunId: string;
  workflowRunId: string;
  runMetadataContents: Buffer;
  catalogSha256: string;
  modelPrice: ModelPricing;
  rawInvocations: PublicModelIdentity["invocations"];
  usageEntries: readonly UsageLedgerEntry[];
  replay: ReturnType<typeof replayRawPublicAccounting>;
  bundle: CurrentPublicBenchmarkBundle;
  pricing: PublicPricingEvidence;
}): void {
  const document = recordValue(parseJson(input.runMetadataContents, PUBLIC_RUN_METADATA_FILE));
  const accounting = recordValue(document?.accounting);
  const identity = recordValue(accounting?.model_identity);
  const catalog = recordValue(accounting?.pricing_catalog);
  const current = recordValue(accounting?.current);
  const cumulative = recordValue(accounting?.cumulative);
  const checkpoint = recordValue(accounting?.checkpoint);
  const storedInvocations = Array.isArray(identity?.invocations) ? identity.invocations : [];
  const normalizedStoredInvocations = storedInvocations
    .flatMap((value): PublicModelIdentity["invocations"] => {
      const invocation = recordValue(value);
      return typeof invocation?.invocation_id === "string" &&
        typeof invocation.configured_model === "string" &&
        typeof invocation.provider_reported_model === "string"
        ? [
            {
              invocation_id: invocation.invocation_id,
              configured_model: invocation.configured_model,
              provider_reported_model: invocation.provider_reported_model
            }
          ]
        : [];
    })
    .sort((left, right) => compareText(left.invocation_id, right.invocation_id));
  const rawSummary = {
    uncached_input_tokens: input.replay.usage.uncached_input_tokens,
    cache_read_tokens: input.replay.usage.cache_read_tokens,
    cache_write_tokens: input.replay.usage.cache_write_tokens,
    output_tokens: input.replay.usage.output_tokens,
    reasoning_tokens: input.replay.usage.reasoning_tokens,
    inclusive_token_total: input.replay.usage.inclusive_token_total,
    billable_token_total: input.replay.usage.billable_token_total,
    total_tokens: input.replay.usage.total_tokens,
    estimated_spend_usd: input.replay.costUsd,
    component_costs_usd: input.replay.componentCosts,
    usage_complete: true,
    pricing_complete: true,
    partial_pricing: false,
    event_count: input.usageEntries.length,
    priced_event_count: input.usageEntries.length,
    unpriced_event_count: 0,
    models: [input.bundle.model]
  };
  const selectedSummary = (value: Record<string, unknown> | undefined): unknown =>
    value === undefined ? undefined : Object.fromEntries(Object.keys(rawSummary).map((key) => [key, value[key]]));
  const catalogPrices = recordValue(catalog?.model_prices);
  const storedModelPrice = recordValue(catalogPrices?.[input.bundle.model]);
  const expectedStoredPrice = {
    inputUsdPerMillion: input.modelPrice.inputUsdPerMillion,
    cachedInputUsdPerMillion: input.modelPrice.cachedInputUsdPerMillion,
    ...(input.modelPrice.cacheWriteUsdPerMillion === undefined
      ? {}
      : { cacheWriteUsdPerMillion: input.modelPrice.cacheWriteUsdPerMillion }),
    outputUsdPerMillion: input.modelPrice.outputUsdPerMillion,
    reasoningUsdPerMillion: input.modelPrice.reasoningUsdPerMillion
  };
  const outstanding = accounting?.outstanding_model_invocations;
  const configuredModels = identity?.configured_models;
  const providerModels = identity?.provider_reported_models;
  const resolvedModels = catalog?.resolved_models;
  const unresolvedModels = catalog?.unresolved_models;
  if (
    document?.run_id !== input.runtimeRunId ||
    accounting?.schema_version !== "ultrafuzz.accounting.v2" ||
    accounting.source !== "usage-ledger" ||
    accounting.workflow_run_id !== input.workflowRunId ||
    identity?.schema_version !== "ultrafuzz.runtime.model-identity.v1" ||
    identity.status !== "complete" ||
    identity.invocation_count !== input.rawInvocations.length ||
    !Array.isArray(configuredModels) ||
    canonicalJson(configuredModels) !== canonicalJson([input.bundle.model]) ||
    !Array.isArray(providerModels) ||
    canonicalJson(providerModels) !== canonicalJson([input.bundle.provider_reported_model]) ||
    normalizedStoredInvocations.length !== storedInvocations.length ||
    canonicalJson(normalizedStoredInvocations) !== canonicalJson(input.rawInvocations) ||
    !Array.isArray(outstanding) ||
    outstanding.length !== 0 ||
    catalog?.status !== "available" ||
    catalog.catalog_sha256 !== input.catalogSha256 ||
    catalog.source !== input.pricing.catalog.source ||
    catalog.fetched_at !== input.pricing.catalog.fetched_at ||
    !Array.isArray(resolvedModels) ||
    canonicalJson(resolvedModels) !== canonicalJson([input.bundle.model]) ||
    !Array.isArray(unresolvedModels) ||
    unresolvedModels.length !== 0 ||
    canonicalJson(storedModelPrice) !== canonicalJson(expectedStoredPrice) ||
    canonicalJson(selectedSummary(current)) !== canonicalJson(rawSummary) ||
    canonicalJson(selectedSummary(cumulative)) !== canonicalJson(rawSummary) ||
    checkpoint?.ledger_event_count !== input.usageEntries.length ||
    checkpoint.malformed_entry_count !== 0 ||
    checkpoint.duplicate_entry_count !== 0
  ) {
    throw new Error(`public benchmark bundle row ${input.rowId} run metadata does not replay from raw evidence`);
  }
}

function rawTokenCount(entry: UsageLedgerEntry, field: keyof UsageLedgerEntry["usage"]): number {
  const value = entry.usage[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`public raw usage ${entry.event_id} has invalid ${field}`);
  }
  return value;
}

function accountingAttemptKey(nodeId: string, iteration: number, attempt: number): string {
  return JSON.stringify([nodeId, iteration, attempt]);
}

function roundPublicUsd(value: number): number {
  return Number(value.toFixed(12));
}

function addPublicUsd(left: number, right: number): number {
  return roundPublicUsd(left + right);
}

export function readPublicBenchmarkBundle(
  filePath: string,
  options: PublicBenchmarkBundleAccessOptions
): PublicBenchmarkBundle {
  const resolved = path.resolve(filePath);
  const contents = readRegularFileNoFollow(
    path.dirname(resolved),
    resolved,
    MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES,
    "public benchmark bundle exceeds the size limit"
  );
  return parsePublicBenchmarkBundle(
    JSON.parse(contents.toString("utf8")) as unknown,
    options.forbiddenSecretValues,
    options.expectedSchemaVersion
  );
}

export function extractPublicBenchmarkBundle(
  bundle: PublicBenchmarkBundle,
  outputDirectory: string,
  options: PublicBenchmarkBundleAccessOptions
): void {
  const parsed = parsePublicBenchmarkBundle(bundle, options.forbiddenSecretValues, options.expectedSchemaVersion);
  const output = normalizedBundleOutputDirectory(outputDirectory);
  const openDirectories: StableExtractionDirectory[] = [];
  let staging: StableExtractionDirectory | undefined;
  try {
    const parentChain = openOrCreateExtractionDirectoryChain(path.dirname(output), openDirectories);
    const parent = parentChain.at(-1)!;
    staging = createUniqueOwnedExtractionDirectory(
      parent,
      ".ultrafuzz-public-staging-",
      0o700,
      openDirectories,
      "public benchmark bundle staging directory"
    );
    const stagedDirectories = new Map<string, StableExtractionDirectory>([["", staging]]);
    for (const file of parsed.files) {
      writeStagedBundleFile(
        staging,
        stagedDirectories,
        file.path,
        Buffer.from(file.contents_base64, "base64"),
        openDirectories
      );
    }
    assertStrictExtractedTree(staging, parsed.files);
    fs.fchmodSync(staging.descriptor, 0o755);
    replaceExtractedDirectory(parentChain, staging, path.basename(output), parsed.files, openDirectories);
  } catch (error) {
    try {
      if (staging !== undefined) {
        removeOwnedExtractionDirectoryIfNamed(staging, "public benchmark bundle staging cleanup");
      }
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "public benchmark bundle extraction and cleanup failed", {
        cause: cleanupError
      });
    }
    throw error;
  } finally {
    closeExtractionDirectories(openDirectories);
  }
}

function normalizedBundleOutputDirectory(candidate: string): string {
  const requested = path.resolve(candidate);
  if (path.dirname(requested) === requested) {
    throw new Error("public benchmark bundle output cannot be a filesystem root");
  }
  return requested;
}

interface StableExtractionDirectory {
  descriptor: number;
  anchorPath: string;
  externalPath: string;
  identity: fs.BigIntStats;
  parent?: StableExtractionDirectory;
  name?: string;
}

function openOrCreateExtractionDirectoryChain(
  absoluteDirectory: string,
  openDirectories: StableExtractionDirectory[]
): StableExtractionDirectory[] {
  const resolved = path.resolve(absoluteDirectory);
  const rootPath = path.parse(resolved).root;
  const root = openExtractionDirectory(rootPath, rootPath, undefined, undefined, undefined, openDirectories);
  const chain = [root];
  let parent = root;
  let externalPath = rootPath;
  for (const component of resolved.slice(rootPath.length).split(path.sep).filter(Boolean)) {
    externalPath = path.join(externalPath, component);
    const anchoredPath = path.join(parent.anchorPath, component);
    try {
      fs.mkdirSync(anchoredPath, { mode: 0o755 });
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) throw error;
    }
    const expectedIdentity = fs.lstatSync(anchoredPath, { bigint: true });
    if (expectedIdentity.isSymbolicLink() || !expectedIdentity.isDirectory()) {
      throw new Error(
        `public benchmark bundle output parent contains a non-directory or symbolic link: ${externalPath}`
      );
    }
    try {
      parent = openExtractionDirectory(
        anchoredPath,
        externalPath,
        parent,
        component,
        expectedIdentity,
        openDirectories
      );
    } catch (error) {
      throw new Error(
        `public benchmark bundle output parent contains a non-directory or symbolic link: ${externalPath}`,
        { cause: error }
      );
    }
    chain.push(parent);
    assertExtractionDirectoryChainCurrent(chain);
  }
  return chain;
}

function openExtractionDirectory(
  openPath: string,
  externalPath: string,
  parent: StableExtractionDirectory | undefined,
  name: string | undefined,
  expectedIdentity: fs.BigIntStats | undefined,
  openDirectories: StableExtractionDirectory[]
): StableExtractionDirectory {
  const descriptor = fs.openSync(openPath, extractionDirectoryOpenFlags());
  try {
    const identity = fs.fstatSync(descriptor, { bigint: true });
    if (
      !identity.isDirectory() ||
      (expectedIdentity !== undefined && !sameExtractionIdentity(identity, expectedIdentity))
    ) {
      throw new Error("public benchmark bundle extraction directory changed while opening");
    }
    const directory: StableExtractionDirectory = {
      descriptor,
      anchorPath: extractionDirectoryDescriptorAnchor(descriptor),
      externalPath,
      identity,
      parent,
      name
    };
    assertNamedExtractionDirectory(directory, "public benchmark bundle extraction directory");
    openDirectories.push(directory);
    return directory;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function createOwnedExtractionDirectory(
  parent: StableExtractionDirectory,
  name: string,
  mode: number,
  openDirectories: StableExtractionDirectory[],
  label: string
): StableExtractionDirectory {
  const anchoredPath = path.join(parent.anchorPath, name);
  fs.mkdirSync(anchoredPath, { mode });
  const createdIdentity = fs.lstatSync(anchoredPath, { bigint: true });
  if (createdIdentity.isSymbolicLink() || !createdIdentity.isDirectory()) {
    throw new Error(`${label} was replaced while being created`);
  }
  const directory = openExtractionDirectory(
    anchoredPath,
    path.join(parent.externalPath, name),
    parent,
    name,
    createdIdentity,
    openDirectories
  );
  if (fs.readdirSync(directory.anchorPath).length !== 0) {
    throw new Error(`${label} was not empty when opened`);
  }
  return directory;
}

function createUniqueOwnedExtractionDirectory(
  parent: StableExtractionDirectory,
  prefix: string,
  mode: number,
  openDirectories: StableExtractionDirectory[],
  label: string
): StableExtractionDirectory {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const name = `${prefix}${process.pid}-${crypto.randomBytes(12).toString("hex")}`;
    try {
      return createOwnedExtractionDirectory(parent, name, mode, openDirectories, label);
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) throw error;
    }
  }
  throw new Error(`${label} could not reserve a unique name`);
}

function writeStagedBundleFile(
  root: StableExtractionDirectory,
  directories: Map<string, StableExtractionDirectory>,
  relativeFilePath: string,
  contents: Buffer,
  openDirectories: StableExtractionDirectory[]
): void {
  const parts = relativeFilePath.split("/");
  const fileName = parts.pop();
  if (fileName === undefined) throw new Error("public benchmark bundle file path is empty");

  let directory = root;
  let relativeDirectory = "";
  for (const part of parts) {
    relativeDirectory = relativeDirectory.length === 0 ? part : `${relativeDirectory}/${part}`;
    const existing = directories.get(relativeDirectory);
    if (existing !== undefined) {
      directory = existing;
      continue;
    }
    directory = createOwnedExtractionDirectory(
      directory,
      part,
      0o755,
      openDirectories,
      `public benchmark bundle output component ${relativeDirectory}`
    );
    directories.set(relativeDirectory, directory);
  }

  const destination = path.join(directory.anchorPath, fileName);
  const descriptor = fs.openSync(
    destination,
    fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_WRONLY |
      requiredExtractionFileConstant("O_NOFOLLOW") |
      requiredExtractionFileConstant("O_NONBLOCK"),
    0o644
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n) {
      throw new Error(`public benchmark bundle output is not a regular file: ${relativeFilePath}`);
    }
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
    const completed = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(destination, { bigint: true });
    if (
      !sameExtractionIdentity(opened, completed) ||
      !sameExtractionIdentity(opened, named) ||
      completed.size !== BigInt(contents.byteLength) ||
      named.isSymbolicLink() ||
      !named.isFile()
    ) {
      throw new Error(`public benchmark bundle output changed while writing: ${relativeFilePath}`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertStrictExtractedTree(
  root: StableExtractionDirectory,
  expectedFiles: readonly Pick<PublicBenchmarkBundleFile, "path" | "size_bytes" | "sha256">[]
): void {
  assertNamedExtractionDirectory(root, "public benchmark bundle extraction root");
  const expectedFileMap = new Map(expectedFiles.map((file) => [file.path, file]));
  const expectedDirectories = new Set<string>();
  for (const expectedFile of expectedFiles) {
    let directory = path.posix.dirname(expectedFile.path);
    while (directory !== ".") {
      expectedDirectories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }

  const actualFiles = new Set<string>();
  function walk(directory: StableExtractionDirectory, relativeDirectory: string): void {
    for (const entryName of fs.readdirSync(directory.anchorPath)) {
      const relativeEntry = relativeDirectory.length === 0 ? entryName : `${relativeDirectory}/${entryName}`;
      const entryPath = path.join(directory.anchorPath, entryName);
      const stat = fs.lstatSync(entryPath, { bigint: true });
      if (stat.isSymbolicLink()) {
        throw new Error(`public benchmark bundle extraction contains a symbolic link: ${relativeEntry}`);
      }
      if (stat.isDirectory()) {
        if (!expectedDirectories.has(relativeEntry)) {
          throw new Error(`public benchmark bundle extraction contains an unexpected directory: ${relativeEntry}`);
        }
        const child = openTransientExtractionDirectory(entryPath, directory, entryName, stat);
        try {
          walk(child, relativeEntry);
        } finally {
          fs.closeSync(child.descriptor);
        }
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`public benchmark bundle extraction contains a non-regular entry: ${relativeEntry}`);
      }
      const expected = expectedFileMap.get(relativeEntry);
      if (expected === undefined) {
        throw new Error(`public benchmark bundle extraction contains an unexpected file: ${relativeEntry}`);
      }
      assertExtractedFileContents(entryPath, stat, expected, relativeEntry);
      actualFiles.add(relativeEntry);
    }
  }
  walk(root, "");

  if (
    actualFiles.size !== expectedFileMap.size ||
    [...actualFiles].some((relativeFilePath) => !expectedFileMap.has(relativeFilePath))
  ) {
    throw new Error("public benchmark bundle extraction does not match the strict file tree");
  }
}

function assertExtractedFileContents(
  anchoredPath: string,
  namedIdentity: fs.BigIntStats,
  expected: Pick<PublicBenchmarkBundleFile, "size_bytes" | "sha256">,
  relativeEntry: string
): void {
  const descriptor = fs.openSync(
    anchoredPath,
    fs.constants.O_RDONLY | requiredExtractionFileConstant("O_NOFOLLOW") | requiredExtractionFileConstant("O_NONBLOCK")
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      !sameExtractionIdentity(opened, namedIdentity) ||
      opened.size !== BigInt(expected.size_bytes)
    ) {
      throw new Error(`public benchmark bundle extraction file changed: ${relativeEntry}`);
    }
    const contents = Buffer.alloc(expected.size_bytes);
    let offset = 0;
    while (offset < contents.byteLength) {
      const bytesRead = fs.readSync(descriptor, contents, offset, contents.byteLength - offset, offset);
      if (bytesRead === 0) throw new Error(`public benchmark bundle extraction file changed: ${relativeEntry}`);
      offset += bytesRead;
    }
    const trailing = Buffer.allocUnsafe(1);
    const completed = fs.fstatSync(descriptor, { bigint: true });
    if (
      fs.readSync(descriptor, trailing, 0, 1, contents.byteLength) !== 0 ||
      !sameStableExtractionFile(opened, completed) ||
      digest(contents) !== expected.sha256
    ) {
      throw new Error(`public benchmark bundle extraction file changed: ${relativeEntry}`);
    }
    const current = fs.lstatSync(anchoredPath, { bigint: true });
    if (current.isSymbolicLink() || !current.isFile() || !sameStableExtractionFile(opened, current)) {
      throw new Error(`public benchmark bundle extraction file changed: ${relativeEntry}`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function openReplaceableOutputDirectory(
  parent: StableExtractionDirectory,
  outputName: string,
  openDirectories: StableExtractionDirectory[]
): StableExtractionDirectory | undefined {
  const anchoredPath = path.join(parent.anchorPath, outputName);
  const expectedIdentity = fs.lstatSync(anchoredPath, { bigint: true, throwIfNoEntry: false });
  if (expectedIdentity === undefined) return undefined;
  if (expectedIdentity.isSymbolicLink() || !expectedIdentity.isDirectory()) {
    throw new Error("public benchmark bundle output must be a regular directory");
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(anchoredPath, extractionDirectoryOpenFlags());
  } catch (error) {
    throw new Error("public benchmark bundle output must be a regular directory", { cause: error });
  }
  try {
    const identity = fs.fstatSync(descriptor, { bigint: true });
    if (!identity.isDirectory() || !sameExtractionIdentity(identity, expectedIdentity)) {
      throw new Error("public benchmark bundle output changed while opening");
    }
    const output: StableExtractionDirectory = {
      descriptor,
      anchorPath: extractionDirectoryDescriptorAnchor(descriptor),
      externalPath: path.join(parent.externalPath, outputName),
      identity,
      parent,
      name: outputName
    };
    assertNamedExtractionDirectory(output, "public benchmark bundle output");
    assertReplaceableOutputTree(output);
    openDirectories.push(output);
    return output;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function assertReplaceableOutputTree(root: StableExtractionDirectory): void {
  function walk(directory: StableExtractionDirectory): void {
    for (const entryName of fs.readdirSync(directory.anchorPath)) {
      const entryPath = path.join(directory.anchorPath, entryName);
      const stat = fs.lstatSync(entryPath, { bigint: true });
      if (stat.isSymbolicLink()) {
        throw new Error(`public benchmark bundle output contains a symbolic link: ${entryPath}`);
      }
      if (stat.isDirectory()) {
        const child = openTransientExtractionDirectory(entryPath, directory, entryName, stat);
        try {
          walk(child);
        } finally {
          fs.closeSync(child.descriptor);
        }
      } else if (!stat.isFile()) {
        throw new Error(`public benchmark bundle output contains a non-regular entry: ${entryPath}`);
      } else {
        const descriptor = fs.openSync(
          entryPath,
          fs.constants.O_RDONLY |
            requiredExtractionFileConstant("O_NOFOLLOW") |
            requiredExtractionFileConstant("O_NONBLOCK")
        );
        try {
          const opened = fs.fstatSync(descriptor, { bigint: true });
          if (!opened.isFile() || !sameExtractionIdentity(opened, stat)) {
            throw new Error(`public benchmark bundle output changed while inspecting: ${entryPath}`);
          }
        } finally {
          fs.closeSync(descriptor);
        }
      }
    }
  }
  walk(root);
}

function replaceExtractedDirectory(
  parentChain: readonly StableExtractionDirectory[],
  staging: StableExtractionDirectory,
  outputName: string,
  expectedFiles: readonly Pick<PublicBenchmarkBundleFile, "path" | "size_bytes" | "sha256">[],
  openDirectories: StableExtractionDirectory[]
): void {
  const parent = parentChain.at(-1)!;
  const previous = openReplaceableOutputDirectory(parent, outputName, openDirectories);
  let backupPlaceholder: StableExtractionDirectory | undefined;
  let outputPlaceholder: StableExtractionDirectory | undefined;
  let previousMoved = false;
  let stagingMoved = false;
  try {
    assertExtractionDirectoryChainCurrent(parentChain);
    assertNamedExtractionDirectory(staging, "public benchmark bundle staging directory");
    if (previous !== undefined) {
      backupPlaceholder = createUniqueOwnedExtractionDirectory(
        parent,
        ".ultrafuzz-public-backup-",
        0o700,
        openDirectories,
        "public benchmark bundle backup placeholder"
      );
      moveExtractionDirectoryOverPlaceholder(previous, backupPlaceholder, "public benchmark bundle existing output");
      previousMoved = true;
    }
    assertExtractionDirectoryChainCurrent(parentChain);
    outputPlaceholder = createOwnedExtractionDirectory(
      parent,
      outputName,
      0o700,
      openDirectories,
      "public benchmark bundle output placeholder"
    );
    moveExtractionDirectoryOverPlaceholder(staging, outputPlaceholder, "public benchmark bundle staging directory");
    stagingMoved = true;
    assertExtractionDirectoryChainCurrent(parentChain);
    assertStrictExtractedTree(staging, expectedFiles);
    assertExtractionDirectoryChainCurrent(parentChain);
    if (previous !== undefined) {
      removeOwnedExtractionDirectory(previous, "public benchmark bundle replaced-output cleanup");
    }
    assertExtractionDirectoryChainCurrent(parentChain);
  } catch (error) {
    stagingMoved = stagingMoved || staging.name === outputName;
    previousMoved =
      previousMoved || (previous !== undefined && previous.name !== undefined && previous.name !== outputName);
    const recoveryErrors: unknown[] = [];
    if (stagingMoved) {
      try {
        removeOwnedExtractionDirectoryIfNamed(staging, "public benchmark bundle failed-output cleanup");
      } catch (cleanupError) {
        recoveryErrors.push(cleanupError);
      }
    } else if (outputPlaceholder !== undefined) {
      try {
        removeOwnedExtractionDirectoryIfNamed(outputPlaceholder, "public benchmark bundle output placeholder cleanup");
      } catch (cleanupError) {
        recoveryErrors.push(cleanupError);
      }
    }
    if (previousMoved && previous !== undefined) {
      try {
        const restorePlaceholder = createOwnedExtractionDirectory(
          parent,
          outputName,
          0o700,
          openDirectories,
          "public benchmark bundle restore placeholder"
        );
        moveExtractionDirectoryOverPlaceholder(
          previous,
          restorePlaceholder,
          "public benchmark bundle previous output restore"
        );
      } catch (restoreError) {
        recoveryErrors.push(restoreError);
      }
    } else if (backupPlaceholder !== undefined) {
      try {
        removeOwnedExtractionDirectoryIfNamed(backupPlaceholder, "public benchmark bundle backup placeholder cleanup");
      } catch (cleanupError) {
        recoveryErrors.push(cleanupError);
      }
    }
    if (recoveryErrors.length > 0) {
      throw new AggregateError(
        [error, ...recoveryErrors],
        "public benchmark bundle replacement failed and could not be fully recovered",
        { cause: error }
      );
    }
    throw error;
  }
}

function moveExtractionDirectoryOverPlaceholder(
  source: StableExtractionDirectory,
  placeholder: StableExtractionDirectory,
  label: string
): void {
  if (
    source.parent === undefined ||
    source.name === undefined ||
    placeholder.parent !== source.parent ||
    placeholder.name === undefined
  ) {
    throw new Error(`${label} does not have a stable rename parent`);
  }
  assertNamedExtractionDirectory(source, label);
  assertNamedExtractionDirectory(placeholder, `${label} destination placeholder`);
  if (fs.readdirSync(placeholder.anchorPath).length !== 0) {
    throw new Error(`${label} destination placeholder is not empty`);
  }
  const oldSourceName = source.name;
  const oldSourcePath = path.join(source.parent.anchorPath, oldSourceName);
  const destinationName = placeholder.name;
  const destinationPath = path.join(source.parent.anchorPath, destinationName);
  fs.renameSync(oldSourcePath, destinationPath);

  const destination = fs.lstatSync(destinationPath, { bigint: true });
  const oldSource = fs.lstatSync(oldSourcePath, { bigint: true, throwIfNoEntry: false });
  const placeholderAfter = fs.fstatSync(placeholder.descriptor, { bigint: true });
  const sourceReachedDestination =
    destination.isDirectory() &&
    !destination.isSymbolicLink() &&
    sameExtractionIdentity(source.identity, destination) &&
    oldSource === undefined;
  if (sourceReachedDestination) {
    source.name = destinationName;
    source.externalPath = placeholder.externalPath;
  }
  if (
    !sourceReachedDestination ||
    !sameExtractionIdentity(placeholder.identity, placeholderAfter) ||
    placeholderAfter.nlink !== 0n
  ) {
    throw new Error(`${label} changed during its identity-checked rename`);
  }
  placeholder.name = undefined;
}

function removeOwnedExtractionDirectoryIfNamed(directory: StableExtractionDirectory, label: string): void {
  if (directory.name === undefined || directory.parent === undefined) return;
  const namedPath = path.join(directory.parent.anchorPath, directory.name);
  const named = fs.lstatSync(namedPath, { bigint: true, throwIfNoEntry: false });
  if (named === undefined) {
    if (fs.fstatSync(directory.descriptor, { bigint: true }).nlink === 0n) directory.name = undefined;
    return;
  }
  if (named.isSymbolicLink() || !named.isDirectory() || !sameExtractionIdentity(directory.identity, named)) return;
  removeOwnedExtractionDirectory(directory, label);
}

function removeOwnedExtractionDirectory(directory: StableExtractionDirectory, label: string): void {
  if (directory.parent === undefined || directory.name === undefined) {
    throw new Error(`${label} does not have a stable named path`);
  }
  assertNamedExtractionDirectory(directory, label);
  const namedPath = path.join(directory.parent.anchorPath, directory.name);
  fs.rmSync(namedPath, { recursive: true, force: false, maxRetries: 0 });
  const after = fs.fstatSync(directory.descriptor, { bigint: true });
  if (!sameExtractionIdentity(directory.identity, after) || after.nlink !== 0n) {
    throw new Error(`${label} changed while removing its exact directory`);
  }
  directory.name = undefined;
}

function openTransientExtractionDirectory(
  anchoredPath: string,
  parent: StableExtractionDirectory,
  name: string,
  expectedIdentity: fs.BigIntStats
): StableExtractionDirectory {
  const descriptor = fs.openSync(anchoredPath, extractionDirectoryOpenFlags());
  try {
    const identity = fs.fstatSync(descriptor, { bigint: true });
    if (!identity.isDirectory() || !sameExtractionIdentity(identity, expectedIdentity)) {
      throw new Error("public benchmark bundle extraction directory changed while traversing");
    }
    return {
      descriptor,
      anchorPath: extractionDirectoryDescriptorAnchor(descriptor),
      externalPath: path.join(parent.externalPath, name),
      identity,
      parent,
      name
    };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function assertExtractionDirectoryChainCurrent(chain: readonly StableExtractionDirectory[]): void {
  for (const directory of chain) {
    assertNamedExtractionDirectory(directory, "public benchmark bundle output parent");
    const external = fs.lstatSync(directory.externalPath, { bigint: true });
    if (external.isSymbolicLink() || !external.isDirectory() || !sameExtractionIdentity(directory.identity, external)) {
      throw new Error("public benchmark bundle output parent changed during extraction");
    }
  }
}

function assertNamedExtractionDirectory(directory: StableExtractionDirectory, label: string): void {
  const descriptor = fs.fstatSync(directory.descriptor, { bigint: true });
  if (!descriptor.isDirectory() || !sameExtractionIdentity(directory.identity, descriptor)) {
    throw new Error(`${label} descriptor identity changed`);
  }
  const namedPath =
    directory.parent === undefined || directory.name === undefined
      ? directory.externalPath
      : path.join(directory.parent.anchorPath, directory.name);
  const named = fs.lstatSync(namedPath, { bigint: true });
  if (named.isSymbolicLink() || !named.isDirectory() || !sameExtractionIdentity(directory.identity, named)) {
    throw new Error(`${label} named identity changed`);
  }
}

function sameExtractionIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableExtractionFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    sameExtractionIdentity(left, right) &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

function extractionDirectoryOpenFlags(): number {
  return (
    fs.constants.O_RDONLY |
    requiredExtractionFileConstant("O_NOFOLLOW") |
    requiredExtractionFileConstant("O_DIRECTORY") |
    requiredExtractionFileConstant("O_NONBLOCK")
  );
}

function requiredExtractionFileConstant(name: "O_NOFOLLOW" | "O_DIRECTORY" | "O_NONBLOCK"): number {
  const value = (fs.constants as typeof fs.constants & Record<typeof name, number | undefined>)[name];
  if (typeof value !== "number") throw new Error(`public benchmark bundle extraction requires ${name}`);
  return value;
}

function extractionDirectoryDescriptorAnchor(descriptor: number): string {
  const identity = fs.fstatSync(descriptor, { bigint: true });
  for (const root of ["/proc/self/fd", "/dev/fd"]) {
    const candidate = path.join(root, String(descriptor));
    try {
      const candidateIdentity = fs.statSync(candidate, { bigint: true });
      if (candidateIdentity.isDirectory() && sameExtractionIdentity(identity, candidateIdentity)) return candidate;
    } catch {
      // Try the next descriptor filesystem.
    }
  }
  throw new Error("public benchmark bundle extraction requires a descriptor filesystem");
}

function closeExtractionDirectories(directories: readonly StableExtractionDirectory[]): void {
  const closed = new Set<number>();
  for (const directory of [...directories].reverse()) {
    if (closed.has(directory.descriptor)) continue;
    closed.add(directory.descriptor);
    try {
      fs.closeSync(directory.descriptor);
    } catch {
      // Preserve the extraction result/error; all descriptors are process-local.
    }
  }
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function isAllowedBundlePath(value: string): boolean {
  const evalFiles = new Set([
    "eval/eval.json",
    "eval/matrix.json",
    "eval/runs.jsonl",
    "eval/run-summary.json",
    `eval/${PUBLIC_EVAL_DIAGNOSTICS_FILE}`,
    "eval/scores.jsonl",
    "eval/summary.json",
    "eval/summary.md",
    "eval/review/new-findings.jsonl"
  ]);
  if (evalFiles.has(value)) return true;
  if (
    /^reports\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/(?:report\.md|report\.json|findings\.normalized\.json|ultrafuzz-workspace-source-attestation\.json)$/u.test(
      value
    )
  ) {
    return true;
  }
  const terminalEvidence = /^reports\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/execution-evidence\/terminal\/(.+)$/u.exec(
    value
  );
  if (
    terminalEvidence?.[1] !== undefined &&
    (PUBLIC_TERMINAL_EVIDENCE_FILES as readonly string[]).includes(terminalEvidence[1])
  ) {
    return true;
  }
  return /^reports\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/execution-evidence\/(?:attempts\.jsonl|run\.json|usage\.jsonl|pricing-catalogs\/[0-9a-f]{64}\.json|[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/(?:artifact-manifest\.json|verifier-receipt\.json|smithers-output\.json|(?:artifacts|manifest-files)\/[0-9]{4}\.bin))$/u.test(
    value
  );
}

function publishedPricingCatalogSha256(runMetadataContents: Buffer, bundlePath: string): string {
  const runMetadata = recordValue(parseJson(runMetadataContents, bundlePath));
  const accounting = recordValue(runMetadata?.accounting);
  const pricingCatalog = recordValue(accounting?.pricing_catalog);
  const parsed = sha256.safeParse(pricingCatalog?.catalog_sha256);
  if (!parsed.success) {
    throw new Error(`public benchmark bundle ${bundlePath} is missing exact pricing catalog identity`);
  }
  return parsed.data;
}

function digest(contents: Uint8Array): string {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function parseJson(contents: Buffer, label: string): unknown {
  try {
    return JSON.parse(contents.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`public benchmark bundle ${label} is not valid JSON`, { cause: error });
  }
}

function parseJsonLines(contents: Buffer, label: string): unknown[] {
  const lines = contents
    .toString("utf8")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);
  if (lines.length === 0 || lines.length > MAX_ROWS * 8) {
    throw new Error(`public benchmark bundle ${label} has an invalid record count`);
  }
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`public benchmark bundle ${label} record ${index} is not valid JSON`, { cause: error });
    }
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = recordValue(value);
  if (record !== undefined) {
    return `{${Object.keys(record)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
