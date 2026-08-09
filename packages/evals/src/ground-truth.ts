import fs from "node:fs";
import { isDeepStrictEqual, TextDecoder } from "node:util";

import { readRegularFileSnapshot } from "@ultrafuzz/artifacts";
import { parse } from "yaml";
import { z } from "zod/v4";

import { EVAL_GROUND_TRUTH_SCHEMA_ID, validateEvalJsonSchema } from "./eval-schema-registry.js";
import type { GroundTruthBug } from "./types.js";
import { EvalError } from "./utils.js";

export const GROUND_TRUTH_SCHEMA_VERSION = "ultrafuzz.eval-ground-truth.v1" as const;

const MAX_GROUND_TRUTH_BYTES = 1024 * 1024;
const MAX_GROUND_TRUTH_TEXT_CODE_POINTS = 16_384;
const MAX_GROUND_TRUTH_ID_CODE_POINTS = 256;
const MAX_GROUND_TRUTH_URL_CODE_POINTS = 2_048;
const MAX_GROUND_TRUTH_LIST_ITEMS = 256;
const MAX_GROUND_TRUTH_BUGS = 10_000;
const MAX_GROUND_TRUTH_CANARIES = 1_000;
const fullSha = /^[0-9a-f]{40}$/u;
const httpUrl = /^https?:\/\/[^\s]+$/u;

function boundedNonBlank(maximum: number): z.ZodType<string> {
  return z
    .string()
    .min(1)
    .regex(/\S/u)
    .refine((value) => [...value].length <= maximum, `must contain at most ${maximum} Unicode code points`);
}

function hasUniqueJsonItems(values: readonly unknown[]): boolean {
  return values.every((value, index) => values.findIndex((candidate) => isDeepStrictEqual(candidate, value)) === index);
}

const nonBlankText = boundedNonBlank(MAX_GROUND_TRUTH_TEXT_CODE_POINTS);
const identifier = boundedNonBlank(MAX_GROUND_TRUTH_ID_CODE_POINTS);
const urlSchema = boundedNonBlank(MAX_GROUND_TRUTH_URL_CODE_POINTS).refine(
  (value) => httpUrl.test(value),
  "must be an HTTP(S) URL without whitespace"
);
const stringList = z
  .array(nonBlankText)
  .max(MAX_GROUND_TRUTH_LIST_ITEMS)
  .refine(hasUniqueJsonItems, "entries must be unique");
const bugSchema = z.strictObject({
  id: identifier,
  title: nonBlankText.optional(),
  severity: nonBlankText.optional(),
  root_cause: nonBlankText.optional(),
  root_cause_keywords: stringList.optional(),
  affected_files: stringList.optional(),
  affected_functions: stringList.optional(),
  impact: nonBlankText.optional(),
  impact_keywords: stringList.optional(),
  evidence: z.union([nonBlankText, stringList]).optional(),
  evidence_keywords: stringList.optional(),
  keywords: stringList.optional()
});
const subjectSchema = z.strictObject({
  repository: urlSchema,
  revision: z.string().regex(fullSha)
});
const publicSourceSchema = z.strictObject({
  url: urlSchema,
  source_commit: z.string().regex(fullSha).optional(),
  retrieved_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  note: nonBlankText
});
const privateProvenanceSchema = z.strictObject({
  name: nonBlankText,
  benchmark_id: z.string().regex(/^[0-9a-f]{32}$/u),
  ultrafuzz_target_repo: urlSchema,
  ultrafuzz_target_commit: z.string().regex(fullSha),
  scfuzzbench_target_repo: urlSchema,
  scfuzzbench_target_commit: z.string().regex(fullSha),
  note: nonBlankText
});
const canarySchema = z.strictObject({
  id: identifier,
  benchmark_name: identifier,
  title: nonBlankText
});

export const groundTruthDocumentZodSchema = z.strictObject({
  schema_version: z.literal(GROUND_TRUTH_SCHEMA_VERSION),
  subject: subjectSchema.optional(),
  source: publicSourceSchema.optional(),
  provenance: privateProvenanceSchema.optional(),
  canaries: z
    .array(canarySchema)
    .max(MAX_GROUND_TRUTH_CANARIES)
    .refine(hasUniqueJsonItems, "canaries must be unique")
    .optional(),
  bugs: z.array(bugSchema).max(MAX_GROUND_TRUTH_BUGS).refine(hasUniqueJsonItems, "bugs must be unique")
});

export interface GroundTruthSubject {
  repository: string;
  revision: string;
}

export interface GroundTruthPublicSource {
  url: string;
  source_commit?: string;
  retrieved_sha256: string;
  note: string;
}

export interface GroundTruthPrivateProvenance {
  name: string;
  benchmark_id: string;
  ultrafuzz_target_repo: string;
  ultrafuzz_target_commit: string;
  scfuzzbench_target_repo: string;
  scfuzzbench_target_commit: string;
  note: string;
}

export interface GroundTruthCanary {
  id: string;
  benchmark_name: string;
  title: string;
}

export interface GroundTruthDocument {
  schema_version: typeof GROUND_TRUTH_SCHEMA_VERSION;
  subject?: GroundTruthSubject;
  source?: GroundTruthPublicSource;
  provenance?: GroundTruthPrivateProvenance;
  canaries?: GroundTruthCanary[];
  bugs: GroundTruthBug[];
}

export interface GroundTruthSemanticIssue {
  path: string;
  message: string;
}

/**
 * Canonicalize only URL spelling that cannot change repository identity. Host
 * names and GitHub owner/repository names are case-insensitive; a trailing
 * slash and a terminal `.git` are transport aliases. Forks remain distinct
 * because their owner/repository path is retained.
 */
export function canonicalRepositoryIdentity(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EvalError("EVAL_GROUND_TRUTH_SUBJECT_INVALID", "ground-truth subject repository must be a URL");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username !== "" || url.password !== "" || url.port !== "") {
    throw new EvalError(
      "EVAL_GROUND_TRUTH_SUBJECT_INVALID",
      "ground-truth subject repository must be an HTTP(S) URL without credentials"
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new EvalError(
      "EVAL_GROUND_TRUTH_SUBJECT_INVALID",
      "ground-truth subject repository URL cannot contain query or fragment"
    );
  }
  let pathname = url.pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/iu, "");
  if (pathname === "") {
    throw new EvalError(
      "EVAL_GROUND_TRUTH_SUBJECT_INVALID",
      "ground-truth subject repository URL must name a repository"
    );
  }
  if (url.hostname.toLowerCase() === "github.com") pathname = pathname.toLowerCase();
  return `${url.protocol}//${url.hostname.toLowerCase()}/${pathname}`;
}

export function parseGroundTruthDocument(
  value: unknown,
  options: { requireSubject?: boolean } = {}
): GroundTruthDocument {
  const canonical = validateEvalJsonSchema(EVAL_GROUND_TRUTH_SCHEMA_ID, value);
  if (!canonical.ok) {
    throw new EvalError("EVAL_GROUND_TRUTH_INVALID", `ground truth must be a ${GROUND_TRUTH_SCHEMA_VERSION} document`, {
      schema_id: EVAL_GROUND_TRUTH_SCHEMA_ID,
      issues: canonical.issues,
      truncated: canonical.truncated
    });
  }
  const retained = groundTruthDocumentZodSchema.safeParse(value);
  if (!retained.success) {
    throw new EvalError(
      "EVAL_GROUND_TRUTH_SCHEMA_DRIFT",
      "canonical ground-truth schema and retained Zod parser disagree"
    );
  }
  const document = retained.data as GroundTruthDocument;
  const semanticIssues = groundTruthSemanticIssues(document);
  if (semanticIssues.length > 0) {
    const subjectInvalid = semanticIssues.some((issue) => issue.path.includes("repo"));
    const ambiguous = semanticIssues.some((issue) => issue.path === "$.source");
    throw new EvalError(
      ambiguous
        ? "EVAL_GROUND_TRUTH_SUBJECT_AMBIGUOUS"
        : subjectInvalid
          ? "EVAL_GROUND_TRUTH_SUBJECT_INVALID"
          : "EVAL_GROUND_TRUTH_INVALID",
      "ground truth failed semantic validation",
      { issues: semanticIssues }
    );
  }
  if (options.requireSubject === true && document.subject === undefined) {
    throw new EvalError(
      "EVAL_GROUND_TRUTH_SUBJECT_MISSING",
      "private ground truth must declare exactly one subject binding"
    );
  }
  return document;
}

export function groundTruthSemanticIssues(document: GroundTruthDocument): GroundTruthSemanticIssue[] {
  const issues: GroundTruthSemanticIssue[] = [];
  const bugIds = document.bugs.map((bug) => bug.id);
  if (new Set(bugIds).size !== bugIds.length) {
    issues.push({ path: "$.bugs", message: "bug IDs must be unique" });
  }
  const canaryIds = (document.canaries ?? []).map((canary) => canary.id);
  if (new Set(canaryIds).size !== canaryIds.length) {
    issues.push({ path: "$.canaries", message: "canary IDs must be unique" });
  }
  const canaryNames = (document.canaries ?? []).map((canary) => canary.benchmark_name);
  if (new Set(canaryNames).size !== canaryNames.length) {
    issues.push({ path: "$.canaries", message: "canary benchmark names must be unique" });
  }
  if (canaryIds.some((id) => bugIds.includes(id))) {
    issues.push({ path: "$.canaries", message: "canary and bug IDs must be disjoint" });
  }
  if (document.subject !== undefined && document.source !== undefined) {
    issues.push({ path: "$.source", message: "public source and private subject identities cannot coexist" });
  }
  if (document.provenance !== undefined && document.subject === undefined) {
    issues.push({ path: "$.provenance", message: "private provenance requires a subject binding" });
  }
  if (document.canaries !== undefined && document.provenance === undefined) {
    issues.push({ path: "$.canaries", message: "private canaries require provenance" });
  }
  if (document.subject !== undefined) {
    pushCanonicalRepositoryIssue(issues, "$.subject.repository", document.subject.repository);
  }
  if (document.provenance !== undefined) {
    pushCanonicalRepositoryIssue(
      issues,
      "$.provenance.ultrafuzz_target_repo",
      document.provenance.ultrafuzz_target_repo
    );
    pushCanonicalRepositoryIssue(
      issues,
      "$.provenance.scfuzzbench_target_repo",
      document.provenance.scfuzzbench_target_repo
    );
    if (
      document.subject !== undefined &&
      (document.provenance.scfuzzbench_target_repo !== document.subject.repository ||
        document.provenance.scfuzzbench_target_commit !== document.subject.revision)
    ) {
      issues.push({ path: "$.provenance", message: "ScFuzzBench provenance must equal the subject binding" });
    }
  }
  return issues;
}

function pushCanonicalRepositoryIssue(issues: GroundTruthSemanticIssue[], path: string, repository: string): void {
  try {
    const canonical = canonicalRepositoryIdentity(repository);
    if (canonical !== repository) issues.push({ path, message: `must use canonical spelling ${canonical}` });
  } catch (error) {
    issues.push({ path, message: error instanceof Error ? error.message : String(error) });
  }
}

export function readGroundTruthDocument(
  filePath: string,
  options: { requireSubject?: boolean } = {}
): GroundTruthDocument {
  let inspected: fs.Stats;
  try {
    inspected = fs.lstatSync(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new EvalError("EVAL_GROUND_TRUTH_MISSING", `ground truth file is missing: ${filePath}`, {
        path: filePath
      });
    }
    throw new EvalError("EVAL_GROUND_TRUTH_INVALID", `ground truth file is unreadable: ${filePath}`, {
      path: filePath,
      reason: error instanceof Error ? error.message : String(error)
    });
  }
  if (!inspected.isFile()) {
    throw new EvalError("EVAL_GROUND_TRUTH_INVALID", `ground truth path is not a regular file: ${filePath}`, {
      path: filePath
    });
  }
  if (inspected.size > MAX_GROUND_TRUTH_BYTES) {
    throw new EvalError("EVAL_GROUND_TRUTH_TOO_LARGE", `ground truth file exceeds ${MAX_GROUND_TRUTH_BYTES} bytes`, {
      path: filePath,
      sizeBytes: inspected.size,
      maxBytes: MAX_GROUND_TRUTH_BYTES
    });
  }
  let bytes: Buffer;
  try {
    bytes = readRegularFileSnapshot(filePath, MAX_GROUND_TRUTH_BYTES);
  } catch (error) {
    throw new EvalError("EVAL_GROUND_TRUTH_INVALID", `ground truth file is unreadable: ${filePath}`, {
      path: filePath,
      reason: error instanceof Error ? error.message : String(error)
    });
  }
  let value: unknown;
  try {
    value = parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new EvalError("EVAL_GROUND_TRUTH_INVALID", `ground truth file is invalid: ${filePath}`, {
      path: filePath,
      reason: error instanceof Error ? error.message : String(error)
    });
  }
  try {
    return parseGroundTruthDocument(value, options);
  } catch (error) {
    if (error instanceof EvalError) throw new EvalError(error.code, `${error.message}: ${filePath}`, error.details);
    throw error;
  }
}

export function assertGroundTruthSubject(
  subject: GroundTruthSubject | undefined,
  expected: { repository: string; revision: string }
): GroundTruthSubject {
  if (subject === undefined) {
    throw new EvalError("EVAL_GROUND_TRUTH_SUBJECT_MISSING", "ground truth has no validated subject binding");
  }
  if (!fullSha.test(expected.revision.toLowerCase())) {
    throw new EvalError("EVAL_TARGET_REVISION_NOT_IMMUTABLE", "target revision must be a full immutable commit");
  }
  const expectedRepository = canonicalRepositoryIdentity(expected.repository);
  const actualRepository = canonicalRepositoryIdentity(subject.repository);
  if (actualRepository !== expectedRepository) {
    throw new EvalError(
      "EVAL_GROUND_TRUTH_SUBJECT_REPOSITORY_MISMATCH",
      "ground-truth subject repository does not match target repository",
      {
        expected: expectedRepository,
        actual: actualRepository
      }
    );
  }
  const expectedRevision = expected.revision.toLowerCase();
  const actualRevision = subject.revision.toLowerCase();
  if (actualRevision !== expectedRevision) {
    throw new EvalError(
      "EVAL_GROUND_TRUTH_SUBJECT_REVISION_MISMATCH",
      "ground-truth subject revision does not match target revision",
      {
        expected: expectedRevision,
        actual: actualRevision
      }
    );
  }
  return { repository: actualRepository, revision: actualRevision };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
