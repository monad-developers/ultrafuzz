import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  artifactContractSchemaBinding,
  assertRegularFileInside,
  executeOfflineSchemaSemanticGates,
  parseStrictJsonBytes,
  validateRegisteredJsonSchema,
  type TerminalReport
} from "@ultrafuzz/artifacts";
import {
  EVAL_RUN_SCHEMA_VERSION,
  MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES,
  PUBLIC_EVAL_DIAGNOSTICS_FILE,
  parsePublicEvalDiagnostics,
  publicEvalDiagnosticsRowIsFailedDatapoint
} from "@ultrafuzz/evals";
import { redactSecretsInText } from "@ultrafuzz/security";
import { projectCanonicalFinalReport } from "@ultrafuzz/runtime";

import {
  MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES,
  MODAL_PUBLIC_BENCHMARK_BUNDLE_SCHEMA_ID,
  type StrictModalPublicBenchmarkBundleDocument,
  type StrictModalPublicBenchmarkBundleFile,
  type StrictModalPublicBenchmarkBundleTarget
} from "./modal-contracts.js";
import { validateModalJsonSchema } from "./modal-schema-registry.js";
import { assertModalDocumentSemantics } from "./modal-semantic-gates.js";
import type { ModalWorkerLineage } from "./launch-state.js";

export const PUBLIC_BENCHMARK_BUNDLE_SCHEMA_VERSION = "ultrafuzz.modal.public-benchmark-bundle.v5" as const;
export { MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES } from "./modal-contracts.js";

export const MAX_PUBLIC_BENCHMARK_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = MAX_PUBLIC_BENCHMARK_FILE_BYTES;
const PUBLIC_REPORT_FILES = ["report.md", "report.json"] as const;
const DEFAULT_PUBLICATION_BUNDLE_PATH = "public-results.json";
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const FULL_GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;

export type PublicBenchmarkBundle = StrictModalPublicBenchmarkBundleDocument;
type PublicBenchmarkBundleFile = StrictModalPublicBenchmarkBundleFile;
type PublicBenchmarkBundleTarget = StrictModalPublicBenchmarkBundleTarget;
type PublicBenchmarkBundleMetadata = Pick<
  PublicBenchmarkBundle,
  "status" | "executed_case_count" | "graded_case_count" | "targets"
>;

export interface PublicBenchmarkBundleSource {
  path: string;
  root: string;
  source: string;
  /** Immutable bytes captured by a stronger source authority, when available. */
  immutableContents?: Buffer;
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
  publicationBundlePath?: string;
}): PublicBenchmarkBundle {
  const forbiddenSecretValues = [...new Set(input.forbiddenSecretValues ?? [])].filter((value) => value.length > 0);
  const files = input.files.map((entry) => {
    const contents =
      entry.immutableContents === undefined
        ? readRegularFileNoFollow(entry.root, entry.source)
        : Buffer.from(entry.immutableContents);
    if (contents.byteLength > MAX_FILE_BYTES) throw new Error(`public benchmark file is too large: ${entry.path}`);
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
  const shape = validateModalJsonSchema(MODAL_PUBLIC_BENCHMARK_BUNDLE_SCHEMA_ID, value);
  if (!shape.ok) {
    const detail = shape.issues
      .slice(0, 5)
      .map((issue) => `${issue.instancePath || "/"} ${issue.message}`)
      .join("; ");
    throw new Error(
      `public benchmark bundle failed canonical JSON Schema validation${detail.length === 0 ? "" : `: ${detail}`}`
    );
  }
  const parsed = value as PublicBenchmarkBundle;
  assertModalDocumentSemantics(MODAL_PUBLIC_BENCHMARK_BUNDLE_SCHEMA_ID, parsed);
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
  const summaryContents = contentsByPath.get("eval/summary.json");
  if (summaryContents === undefined) throw new Error("public benchmark bundle is missing eval/summary.json");
  const summaryRows = parseSummaryRows(summaryContents);
  const runRecordsContents = contentsByPath.get("eval/runs.jsonl");
  if (runRecordsContents === undefined) throw new Error("public benchmark bundle is missing eval/runs.jsonl");
  const runRecords = parsePublicRunRecords(runRecordsContents, parsed.eval_run_id, matrixRows);
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
  for (const [rowId, score] of summaryRows) {
    const matrixRow = matrixRows.get(rowId);
    if (
      matrixRow === undefined ||
      matrixRow.target_id !== score.target_id ||
      matrixRow.variant_id !== score.variant_id ||
      matrixRow.trial_id !== score.trial_id
    ) {
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
  for (const rowId of matrixRows.keys()) {
    for (const reportFile of PUBLIC_REPORT_FILES) {
      const required = `reports/${rowId}/${reportFile}`;
      if (!paths.has(required)) throw new Error(`public benchmark bundle is missing ${required}`);
    }
  }
  const reportsByRow = parseTerminalReports(matrixRows, summaryRows, runRecords, contentsByPath);
  assertSmokeFindingFloor(parsed.lane, matrixRows, reportsByRow, diagnostics);
  const publicationBundlePath = uniqueDeclaredPublicationBundlePath(parsed.targets);
  const expectedMetadata = summarizePublicBenchmarkBundleContents({
    matrixRows,
    diagnostics,
    summaryRows,
    publicationBundlePath
  });
  assertPublicBenchmarkBundleMetadata(parsed, expectedMetadata);
  return parsed;
}

function assertSmokeFindingFloor(
  lane: PublicBenchmarkBundle["lane"],
  matrixRows: Map<string, PublicBundleMatrixRow>,
  reportsByRow: Map<string, TerminalReport>,
  diagnostics: ReturnType<typeof parsePublicEvalDiagnostics>
): void {
  if (lane !== "smoke") return;
  const failedDatapointRows = new Set(
    diagnostics.rows.filter(publicEvalDiagnosticsRowIsFailedDatapoint).map((row) => row.row_id)
  );
  for (const rowId of matrixRows.keys()) {
    const report = reportsByRow.get(rowId);
    if (report === undefined) throw new Error(`public benchmark bundle is missing a parsed report for ${rowId}`);
    if (report.issues.length === 0 && !failedDatapointRows.has(rowId)) {
      throw new Error(`smoke benchmark row ${rowId} must report at least one production issue`);
    }
  }
}

function parseTerminalReports(
  matrixRows: Map<string, PublicBundleMatrixRow>,
  summaryRows: Map<string, PublicBundleSummaryRow>,
  runRecords: Map<string, PublicBundleRunRecord>,
  contentsByPath: Map<string, Buffer>
): Map<string, TerminalReport> {
  const binding = artifactContractSchemaBinding("ultrafuzz/report@2");
  if (binding === undefined) throw new Error("terminal report schema binding is unavailable");
  const reports = new Map<string, TerminalReport>();
  for (const rowId of matrixRows.keys()) {
    const bundlePath = `reports/${rowId}/report.json`;
    const contents = contentsByPath.get(bundlePath);
    if (contents === undefined) throw new Error(`public benchmark bundle is missing ${bundlePath}`);
    let value: unknown;
    try {
      value = parseStrictJsonBytes(contents, { maxBytes: MAX_FILE_BYTES, maxDepth: 128 });
    } catch (error) {
      throw new Error(`public benchmark row ${rowId} has invalid strict report JSON`, { cause: error });
    }
    const validation = validateRegisteredJsonSchema(binding.schema_id, value);
    if (!validation.ok) {
      const detail = validation.issues
        .slice(0, 5)
        .map((issue) => `${issue.instancePath || "/"} ${issue.message}`)
        .join("; ");
      throw new Error(`public benchmark row ${rowId} has a schema-invalid terminal report: ${detail}`);
    }
    const semanticFailures = executeOfflineSchemaSemanticGates("report.schema.json", value).filter(
      (result) => result.status === "failed"
    );
    if (semanticFailures.length > 0) {
      throw new Error(
        `public benchmark row ${rowId} has a semantic-invalid terminal report: ${semanticFailures
          .map((result) =>
            result.status === "failed"
              ? `${result.gate}: ${result.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`
              : result.gate
          )
          .join("; ")}`
      );
    }
    const report = value as TerminalReport;
    const row = matrixRows.get(rowId);
    const score = summaryRows.get(rowId);
    const record = runRecords.get(rowId);
    if (row === undefined || score === undefined || record === undefined) {
      throw new Error(`public benchmark row ${rowId} is missing report lineage`);
    }
    if (report.run_metadata.run_id !== record.ultrafuzz_run_id) {
      throw new Error(`public benchmark row ${rowId} terminal report does not match its Ultrafuzz run ID`);
    }
    if (canonicalRepository(report.run_metadata.repository) !== canonicalRepository(row.target.repo)) {
      throw new Error(`public benchmark row ${rowId} terminal report does not match its target repository`);
    }
    if (report.issues.length !== score.finding_count) {
      throw new Error(`public benchmark row ${rowId} terminal report issue count does not match its score`);
    }
    const markdownPath = `reports/${rowId}/report.md`;
    const markdown = contentsByPath.get(markdownPath);
    if (markdown === undefined) throw new Error(`public benchmark bundle is missing ${markdownPath}`);
    const projection = projectCanonicalFinalReport(report);
    if (!isDeepStrictEqual(projection.report, report)) {
      throw new Error(`public benchmark row ${rowId} report.json is not the canonical final-report projection`);
    }
    if (!markdown.equals(Buffer.from(projection.markdown, "utf8"))) {
      throw new Error(`public benchmark row ${rowId} report.md is not the canonical projection of report.json`);
    }
    reports.set(rowId, report);
  }
  return reports;
}

interface PublicBundleRunRecord {
  row_id: string;
  target_id: string;
  variant_id: string;
  trial_id: string;
  ultrafuzz_run_id: string;
}

function parsePublicRunRecords(
  contents: Buffer,
  evalRunId: string,
  matrixRows: Map<string, PublicBundleMatrixRow>
): Map<string, PublicBundleRunRecord> {
  const records = new Map<string, PublicBundleRunRecord>();
  for (const [index, value] of parseStrictJsonLines(contents, "eval/runs.jsonl").entries()) {
    const record = recordValue(value);
    if (record === undefined || record.schema_version !== EVAL_RUN_SCHEMA_VERSION || record.eval_run_id !== evalRunId) {
      throw new Error(`public benchmark bundle run record ${index} has invalid version or eval identity`);
    }
    const rowId = record.row_id;
    const targetId = record.target_id;
    const variantId = record.variant_id;
    const trialId = record.trial_id;
    if (!isSafeId(rowId) || !isSafeId(targetId) || !isSafeId(variantId) || !isSafeId(trialId)) {
      throw new Error(`public benchmark bundle run record ${index} has invalid row identity`);
    }
    const row = matrixRows.get(rowId);
    if (
      row === undefined ||
      row.target_id !== targetId ||
      row.variant_id !== variantId ||
      row.trial_id !== trialId ||
      (record.status !== "launched" && record.status !== "failed")
    ) {
      throw new Error(`public benchmark bundle run record ${index} does not match its matrix row`);
    }
    if (record.status === "failed") {
      records.delete(rowId);
      continue;
    }
    const runId = record.ultrafuzz_run_id;
    if (!isSafeId(runId)) {
      throw new Error(`public benchmark bundle launched run record ${index} has an invalid Ultrafuzz run ID`);
    }
    records.set(rowId, {
      row_id: rowId,
      target_id: targetId,
      variant_id: variantId,
      trial_id: trialId,
      ultrafuzz_run_id: runId
    });
  }
  for (const rowId of matrixRows.keys()) {
    if (!records.has(rowId)) throw new Error(`public benchmark bundle is missing a current run record for ${rowId}`);
  }
  return records;
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
}

function parseMatrixRows(contents: Buffer): Map<string, PublicBundleMatrixRow> {
  const value = parseBundleJson(contents, "eval/matrix.json");
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("public benchmark bundle eval/matrix.json must be a non-empty array");
  }
  const rows = new Map<string, PublicBundleMatrixRow>();
  for (const [index, row] of value.entries()) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error(`public benchmark bundle matrix row ${index} must be an object`);
    }
    const input = row as Record<string, unknown>;
    const id = input.id;
    if (!isSafeId(id)) throw new Error(`public benchmark bundle matrix row ${index} has an invalid ID`);
    const targetId = input.target_id;
    const variantId = input.variant_id;
    const trialId = input.trial_id;
    if (!isSafeId(targetId) || !isSafeId(variantId) || !isSafeId(trialId)) {
      throw new Error(`public benchmark bundle matrix row ${index} has an invalid identity`);
    }
    const target = parseMatrixTargetIdentity(input.target, targetId, index);
    const framework = parseMatrixTargetFramework(input, targetId, index);
    if (rows.has(id)) throw new Error(`public benchmark bundle matrix repeats row ID ${id}`);
    rows.set(id, {
      id,
      target_id: targetId,
      variant_id: variantId,
      trial_id: trialId,
      target,
      ...(framework === undefined ? {} : { framework })
    });
  }
  return rows;
}

function parseMatrixTargetIdentity(value: unknown, targetId: string, index: number): PublicBundleMatrixRow["target"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`public benchmark bundle matrix row ${index} is missing target identity`);
  }
  const target = value as Record<string, unknown>;
  const id = target.id;
  const repo = target.repo;
  const ref = target.ref;
  if (!isSafeId(id) || !isUrl(repo, 2_048) || !isFullGitSha(ref) || id !== targetId) {
    throw new Error(`public benchmark bundle matrix row ${index} has an invalid target identity`);
  }
  return { id, repo, ref };
}

function parseMatrixTargetFramework(row: Record<string, unknown>, targetId: string, index: number): string | undefined {
  const workflowInput = recordValue(row.workflow_input);
  const frameworks = recordValue(workflowInput?.target_frameworks);
  if (frameworks === undefined || !(targetId in frameworks)) return undefined;
  const framework = frameworks[targetId];
  if (!isSafeId(framework)) {
    throw new Error(`public benchmark bundle matrix row ${index} has an invalid target framework`);
  }
  return framework;
}

interface PublicBundleSummaryRow {
  row_id: string;
  target_id: string;
  variant_id: string;
  trial_id: string;
  finding_count: number;
}

function parseSummaryRows(contents: Buffer): Map<string, PublicBundleSummaryRow> {
  const value = parseBundleJson(contents, "eval/summary.json");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("public benchmark bundle eval/summary.json must be an object");
  }
  const rowsValue = (value as Record<string, unknown>).rows;
  if (!Array.isArray(rowsValue) || rowsValue.length === 0) {
    throw new Error("public benchmark bundle eval/summary.json rows must be a non-empty array");
  }
  const rows = new Map<string, PublicBundleSummaryRow>();
  for (const [index, row] of rowsValue.entries()) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error(`public benchmark bundle summary row ${index} must be an object`);
    }
    const input = row as Record<string, unknown>;
    const rowId = input.row_id;
    const targetId = input.target_id;
    const variantId = input.variant_id;
    const trialId = input.trial_id;
    const findingCount = input.finding_count;
    if (
      !isSafeId(rowId) ||
      !isSafeId(targetId) ||
      !isSafeId(variantId) ||
      !isSafeId(trialId) ||
      !isNonnegativeSafeInteger(findingCount) ||
      input.report_schema_valid !== true
    ) {
      throw new Error(`public benchmark bundle summary row ${index} has invalid score identity`);
    }
    if (rows.has(rowId)) throw new Error(`public benchmark bundle summary repeats row ID ${rowId}`);
    rows.set(rowId, {
      row_id: rowId,
      target_id: targetId,
      variant_id: variantId,
      trial_id: trialId,
      finding_count: findingCount
    });
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
    matrixRows: parseMatrixRows(matrixContents),
    diagnostics: parseBundleDiagnostics(diagnosticsContents),
    summaryRows: parseSummaryRows(summaryContents),
    publicationBundlePath
  });
}

function summarizePublicBenchmarkBundleContents(input: {
  matrixRows: Map<string, PublicBundleMatrixRow>;
  diagnostics: ReturnType<typeof parsePublicEvalDiagnostics>;
  summaryRows: Map<string, PublicBundleSummaryRow>;
  publicationBundlePath: string;
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
      const reportPaths = rows.flatMap((row) =>
        PUBLIC_REPORT_FILES.map((reportFile) => `reports/${row.id}/${reportFile}`)
      );
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
  const value = parseBundleJson(contents, `eval/${PUBLIC_EVAL_DIAGNOSTICS_FILE}`);
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
  return parsePublicBenchmarkBundleBytes(contents, forbiddenSecretValues);
}

export function parsePublicBenchmarkBundleBytes(
  contents: Uint8Array,
  forbiddenSecretValues: readonly string[] = []
): PublicBenchmarkBundle {
  const bytes = Buffer.from(contents);
  if (bytes.byteLength > MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES) {
    throw new Error("public benchmark bundle exceeds the size limit");
  }
  return parsePublicBenchmarkBundle(
    parseBundleJson(bytes, "public benchmark bundle", MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES),
    forbiddenSecretValues
  );
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
  if (/^reports\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/(?:report\.md|report\.json)$/u.test(value)) {
    return true;
  }
  return /^reports\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/artifacts\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/(?:THREAT_MODEL\.md|goal-plan\.json|threat-model\.json|vulnerability-db-manifest\.json)$/u.test(
    value
  );
}

function digest(contents: Uint8Array): string {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID_PATTERN.test(value);
}

function isFullGitSha(value: unknown): value is string {
  return typeof value === "string" && FULL_GIT_SHA_PATTERN.test(value);
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isUrl(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength && URL.canParse(value);
}

function parseBundleJson(contents: Buffer, label: string, maxBytes = MAX_FILE_BYTES): unknown {
  try {
    return parseStrictJsonBytes(contents, { maxBytes, maxDepth: 128 });
  } catch (error) {
    throw new Error(`public benchmark bundle ${label} is not strict JSON`, { cause: error });
  }
}

function parseStrictJsonLines(contents: Buffer, label: string): unknown[] {
  const values: unknown[] = [];
  let lineStart = 0;
  for (let index = 0; index <= contents.byteLength; index += 1) {
    if (index !== contents.byteLength && contents[index] !== 0x0a) continue;
    let lineEnd = index;
    if (lineEnd > lineStart && contents[lineEnd - 1] === 0x0d) lineEnd -= 1;
    if (lineEnd === lineStart) {
      if (index !== contents.byteLength) throw new Error(`public benchmark bundle ${label} contains a blank line`);
    } else {
      try {
        values.push(
          parseStrictJsonBytes(contents.subarray(lineStart, lineEnd), {
            maxBytes: MAX_FILE_BYTES,
            maxDepth: 128
          })
        );
      } catch (error) {
        throw new Error(`public benchmark bundle ${label} line ${values.length + 1} is not strict JSON`, {
          cause: error
        });
      }
    }
    lineStart = index + 1;
  }
  if (values.length === 0) throw new Error(`public benchmark bundle ${label} must not be empty`);
  return values;
}

function canonicalRepository(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "https:" && parsed.hostname.toLowerCase() === "github.com") {
      const pathname = parsed.pathname.replace(/\/+$/u, "").replace(/\.git$/u, "");
      return `https://github.com${pathname}`;
    }
  } catch {
    // The report schema deliberately allows the canonical `unavailable` value;
    // the lineage comparison below will reject it for a publishable benchmark.
  }
  return value.replace(/\/+$/u, "");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
