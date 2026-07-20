import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { assertRegularFileInside } from "@ultrafuzz/artifacts";
import {
  MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES,
  PUBLIC_EVAL_DIAGNOSTICS_FILE,
  parsePublicEvalDiagnostics
} from "@ultrafuzz/evals";
import { redactSecretsInText } from "@ultrafuzz/security";
import { z } from "zod/v4";

import type { ModalWorkerLineage } from "./launch-state.js";

export const PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION = "ultrafuzz.modal.public-benchmark-bundle.v2" as const;
export const MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES = 256 * 1024 * 1024;

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BASE64_CHARACTERS = 4 * Math.ceil(MAX_FILE_BYTES / 3);
const PUBLIC_REPORT_FILES = ["report.md", "report.json", "findings.normalized.json"] as const;
const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
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
  size_bytes: z.number().int().nonnegative().max(MAX_FILE_BYTES),
  sha256,
  contents_base64: z.string().max(MAX_FILE_BASE64_CHARACTERS)
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

const bundleSchema = z.strictObject({
  schema_version: z.literal(PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION),
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
  created_at: z.string().datetime({ offset: true }),
  files: z.array(bundleFileSchema).min(1).max(2_048)
});

export type PublicBenchmarkBundle = z.infer<typeof bundleSchema>;

export interface PublicBenchmarkBundleSource {
  path: string;
  root: string;
  source: string;
}

export function createPublicBenchmarkBundle(input: {
  benchmark: PublicBenchmarkBundle["benchmark"];
  lane: PublicBenchmarkBundle["lane"];
  modelSlug: string;
  model: string;
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
}): PublicBenchmarkBundle {
  const forbiddenSecretValues = [...new Set(input.forbiddenSecretValues ?? [])].filter((value) => value.length > 0);
  const files = input.files.map((entry) => {
    const contents = readRegularFileNoFollow(entry.root, entry.source);
    if (contents.byteLength > MAX_FILE_BYTES) throw new Error(`public benchmark file is too large: ${entry.path}`);
    assertPublicBenchmarkFileContainsNoSecrets(entry.path, contents, forbiddenSecretValues);
    return {
      path: entry.path,
      size_bytes: contents.byteLength,
      sha256: digest(contents),
      contents_base64: contents.toString("base64")
    };
  });
  const bundle = parsePublicBenchmarkBundle(
    {
      schema_version: PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION,
      benchmark: input.benchmark,
      lane: input.lane,
      model_slug: input.modelSlug,
      model: input.model,
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
      created_at: input.createdAt ?? new Date().toISOString(),
      files
    },
    forbiddenSecretValues
  );
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
  if (forbiddenSecretValues.some((secret) => contents.includes(Buffer.from(secret, "utf8")))) {
    throw new Error(`public benchmark file contains an injected secret value: ${bundlePath}`);
  }
  const text = contents.toString("utf8");
  if (redactSecretsInText(text) !== text) {
    throw new Error(`public benchmark file contains secret-like content: ${bundlePath}`);
  }
}

function readRegularFileNoFollow(root: string, source: string): Buffer {
  assertRegularFileInside(root, source, "public benchmark bundle source");
  return readRegularFilePathNoFollow(source, MAX_FILE_BYTES, `public benchmark file is too large: ${source}`);
}

function readRegularFilePathNoFollow(filePath: string, maxBytes: number, tooLargeMessage: string): Buffer {
  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const nonBlocking = (fs.constants as typeof fs.constants & { O_NONBLOCK?: number }).O_NONBLOCK ?? 0;
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow | nonBlocking);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`public benchmark source is not a regular file: ${filePath}`);
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes) throw new Error(tooLargeMessage);

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - totalBytes));
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) return Buffer.concat(chunks, totalBytes);
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    throw new Error(tooLargeMessage);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function parsePublicBenchmarkBundle(
  value: unknown,
  forbiddenSecretValues: readonly string[] = []
): PublicBenchmarkBundle {
  const parsed = bundleSchema.parse(value);
  const exactSecrets = [...new Set(forbiddenSecretValues)].filter((secret) => secret.length > 0);
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
  const matrixRows = parseMatrixRows(matrixContents);
  const diagnosticsPath = `eval/${PUBLIC_EVAL_DIAGNOSTICS_FILE}`;
  const diagnosticsContents = contentsByPath.get(diagnosticsPath);
  if (diagnosticsContents === undefined) throw new Error(`public benchmark bundle is missing ${diagnosticsPath}`);
  const diagnostics = parseBundleDiagnostics(diagnosticsContents);
  assertBundleDiagnosticsLineage(parsed, diagnostics);
  if (!diagnostics.summary.scoring_ready) {
    throw new Error("public benchmark bundle diagnostics are not ready for scoring");
  }
  if (diagnostics.rows.length !== matrixRows.size) {
    throw new Error("public benchmark bundle diagnostics row set does not match the matrix");
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
  for (const bundlePath of paths) {
    if (!bundlePath.startsWith("reports/")) continue;
    const rowId = bundlePath.split("/")[1];
    if (rowId === undefined || !matrixRows.has(rowId)) {
      throw new Error(`public benchmark bundle contains a report for an unexpected matrix row: ${bundlePath}`);
    }
  }
  for (const rowId of matrixRows.keys()) {
    for (const reportFile of PUBLIC_REPORT_FILES) {
      const required = `reports/${rowId}/${reportFile}`;
      if (!paths.has(required)) throw new Error(`public benchmark bundle is missing ${required}`);
    }
  }
  return parsed;
}

interface PublicBundleMatrixRow {
  id: string;
  target_id: string;
  variant_id: string;
  trial_id: string;
}

function parseMatrixRows(contents: Buffer): Map<string, PublicBundleMatrixRow> {
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
    if (rows.has(id.data)) throw new Error(`public benchmark bundle matrix repeats row ID ${id.data}`);
    rows.set(id.data, {
      id: id.data,
      target_id: targetId.data,
      variant_id: variantId.data,
      trial_id: trialId.data
    });
  }
  return rows;
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
  const mismatches = [
    diagnostics.benchmark === bundle.benchmark ? undefined : "benchmark",
    diagnostics.lane === bundle.lane ? undefined : "lane",
    diagnostics.model_slug === bundle.model_slug ? undefined : "model slug",
    diagnostics.model === bundle.model ? undefined : "model",
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

export function readPublicBenchmarkBundle(
  filePath: string,
  forbiddenSecretValues: readonly string[] = []
): PublicBenchmarkBundle {
  const contents = readRegularFilePathNoFollow(
    filePath,
    MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES,
    "public benchmark bundle exceeds the size limit"
  );
  return parsePublicBenchmarkBundle(JSON.parse(contents.toString("utf8")) as unknown, forbiddenSecretValues);
}

export function extractPublicBenchmarkBundle(bundle: PublicBenchmarkBundle, outputDirectory: string): void {
  const parsed = parsePublicBenchmarkBundle(bundle);
  const output = normalizedBundleOutputDirectory(outputDirectory);
  const staging = fs.mkdtempSync(path.join(path.dirname(output), `.${path.basename(output)}.staging-`));
  fs.chmodSync(staging, 0o700);
  try {
    for (const file of parsed.files) {
      writeStagedBundleFile(staging, file.path, Buffer.from(file.contents_base64, "base64"));
    }
    assertStrictExtractedTree(
      staging,
      parsed.files.map((file) => file.path)
    );
    fs.chmodSync(staging, 0o755);
    replaceExtractedDirectory(staging, output);
  } catch (error) {
    if (fs.lstatSync(staging, { throwIfNoEntry: false }) !== undefined) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    throw error;
  }
}

function normalizedBundleOutputDirectory(candidate: string): string {
  const requested = path.resolve(candidate);
  if (path.dirname(requested) === requested) {
    throw new Error("public benchmark bundle output cannot be a filesystem root");
  }
  const parent = path.dirname(requested);
  const root = path.parse(parent).root;
  let current = root;
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("public benchmark bundle output parent root must be a regular directory");
  }
  const relativeParent = path.relative(root, parent);
  for (const component of relativeParent.split(path.sep).filter((part) => part.length > 0)) {
    current = path.join(current, component);
    let stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) {
      try {
        fs.mkdirSync(current, { mode: 0o755 });
      } catch (error) {
        if (!isFileSystemError(error, "EEXIST")) throw error;
      }
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`public benchmark bundle output parent contains a non-directory or symbolic link: ${current}`);
    }
  }
  return path.join(parent, path.basename(requested));
}

function writeStagedBundleFile(root: string, relativeFilePath: string, contents: Buffer): void {
  const parts = relativeFilePath.split("/");
  const fileName = parts.pop();
  if (fileName === undefined) throw new Error("public benchmark bundle file path is empty");

  let directory = root;
  for (const part of parts) {
    directory = path.join(directory, part);
    try {
      fs.mkdirSync(directory, { mode: 0o755 });
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) throw error;
    }
    const directoryStat = fs.lstatSync(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error(`public benchmark bundle output contains a non-directory component: ${relativeFilePath}`);
    }
  }

  const destination = path.join(directory, fileName);
  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(
    destination,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow,
    0o644
  );
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error(`public benchmark bundle output is not a regular file: ${relativeFilePath}`);
    }
    fs.writeFileSync(descriptor, contents);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertStrictExtractedTree(root: string, expectedFiles: readonly string[]): void {
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("public benchmark bundle extraction root must be a regular directory");
  }

  const expectedFileSet = new Set(expectedFiles);
  const expectedDirectories = new Set<string>();
  for (const expectedFile of expectedFiles) {
    let directory = path.posix.dirname(expectedFile);
    while (directory !== ".") {
      expectedDirectories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }

  const actualFiles = new Set<string>();
  function walk(directory: string, relativeDirectory: string): void {
    for (const entryName of fs.readdirSync(directory)) {
      const relativeEntry = relativeDirectory.length === 0 ? entryName : `${relativeDirectory}/${entryName}`;
      const entryPath = path.join(directory, entryName);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`public benchmark bundle extraction contains a symbolic link: ${relativeEntry}`);
      }
      if (stat.isDirectory()) {
        if (!expectedDirectories.has(relativeEntry)) {
          throw new Error(`public benchmark bundle extraction contains an unexpected directory: ${relativeEntry}`);
        }
        walk(entryPath, relativeEntry);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`public benchmark bundle extraction contains a non-regular entry: ${relativeEntry}`);
      }
      actualFiles.add(relativeEntry);
    }
  }
  walk(root, "");

  if (
    actualFiles.size !== expectedFileSet.size ||
    [...actualFiles].some((relativeFilePath) => !expectedFileSet.has(relativeFilePath))
  ) {
    throw new Error("public benchmark bundle extraction does not match the strict file tree");
  }
}

function assertReplaceableOutputTree(output: string): boolean {
  const rootStat = fs.lstatSync(output, { throwIfNoEntry: false });
  if (rootStat === undefined) return false;
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("public benchmark bundle output must be a regular directory");
  }

  function walk(directory: string): void {
    for (const entryName of fs.readdirSync(directory)) {
      const entryPath = path.join(directory, entryName);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`public benchmark bundle output contains a symbolic link: ${entryPath}`);
      }
      if (stat.isDirectory()) {
        walk(entryPath);
      } else if (!stat.isFile()) {
        throw new Error(`public benchmark bundle output contains a non-regular entry: ${entryPath}`);
      }
    }
  }
  walk(output);
  return true;
}

function replaceExtractedDirectory(staging: string, output: string): void {
  const hadPrevious = assertReplaceableOutputTree(output);
  if (!hadPrevious) {
    fs.renameSync(staging, output);
    return;
  }

  const backup = path.join(
    path.dirname(output),
    `.${path.basename(output)}.backup-${process.pid}-${crypto.randomBytes(12).toString("hex")}`
  );
  fs.renameSync(output, backup);
  try {
    // Validate the exact object moved aside as well as the path inspected above.
    // This closes the ordinary check/rename race without ever traversing a link.
    assertReplaceableOutputTree(backup);
    fs.renameSync(staging, output);
  } catch (error) {
    if (fs.lstatSync(output, { throwIfNoEntry: false }) === undefined) {
      fs.renameSync(backup, output);
    }
    throw error;
  }
  fs.rmSync(backup, { recursive: true, force: true });
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
  return /^reports\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/(?:report\.md|report\.json|findings\.normalized\.json)$/u.test(
    value
  );
}

function digest(contents: Uint8Array): string {
  return crypto.createHash("sha256").update(contents).digest("hex");
}
