import fs from "node:fs";
import { parse } from "yaml";
import { z } from "zod/v4";

import type { GroundTruthBug } from "./types.js";
import { EvalError } from "./utils.js";

export const GROUND_TRUTH_SCHEMA_VERSION = "ultrafuzz.eval-ground-truth.v1" as const;

const MAX_GROUND_TRUTH_BYTES = 1024 * 1024;
const fullSha = /^[0-9a-f]{40}$/u;
const bugSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  severity: z.string().min(1).optional(),
  root_cause: z.string().min(1).optional(),
  root_cause_keywords: z.array(z.string().min(1)).optional(),
  affected_files: z.array(z.string().min(1)).optional(),
  affected_functions: z.array(z.string().min(1)).optional(),
  impact: z.string().min(1).optional(),
  impact_keywords: z.array(z.string().min(1)).optional(),
  evidence: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
  evidence_keywords: z.array(z.string().min(1)).optional(),
  keywords: z.array(z.string().min(1)).optional()
});
const subjectSchema = z.strictObject({
  repository: z.string().min(1),
  revision: z.string().regex(fullSha)
});

export interface GroundTruthSubject {
  repository: string;
  revision: string;
}

export interface GroundTruthDocument {
  schema_version: typeof GROUND_TRUTH_SCHEMA_VERSION;
  subject?: GroundTruthSubject;
  bugs: GroundTruthBug[];
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
  const object = isRecord(value) ? value : undefined;
  const competingIdentityKeys =
    object === undefined
      ? []
      : ["source", "repository", "revision", "target", "codebase"].filter((key) => key in object);
  if (competingIdentityKeys.length > 0 && object?.subject !== undefined) {
    throw new EvalError("EVAL_GROUND_TRUTH_SUBJECT_AMBIGUOUS", "ground truth contains competing subject identities", {
      fields: competingIdentityKeys
    });
  }

  const bugsValue = Array.isArray(value) ? value : object?.bugs;
  const bugsResult = z.array(bugSchema).safeParse(bugsValue);
  if (!bugsResult.success) {
    throw new EvalError("EVAL_GROUND_TRUTH_INVALID", "ground truth bugs are invalid", {
      issues: bugsResult.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    });
  }

  const version = object?.schema_version;
  const subjectValue = object?.subject;
  if (subjectValue !== undefined && version !== GROUND_TRUTH_SCHEMA_VERSION) {
    throw new EvalError("EVAL_GROUND_TRUTH_INVALID", `bound ground truth must declare ${GROUND_TRUTH_SCHEMA_VERSION}`);
  }
  if (options.requireSubject === true && subjectValue === undefined) {
    throw new EvalError(
      "EVAL_GROUND_TRUTH_SUBJECT_MISSING",
      "private ground truth must declare exactly one subject binding"
    );
  }
  if (subjectValue === undefined) {
    return { schema_version: GROUND_TRUTH_SCHEMA_VERSION, bugs: bugsResult.data as GroundTruthBug[] };
  }
  const subjectResult = subjectSchema.safeParse(subjectValue);
  if (!subjectResult.success) {
    throw new EvalError("EVAL_GROUND_TRUTH_SUBJECT_INVALID", "ground-truth subject binding is invalid", {
      issues: subjectResult.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    });
  }
  return {
    schema_version: GROUND_TRUTH_SCHEMA_VERSION,
    subject: {
      repository: canonicalRepositoryIdentity(subjectResult.data.repository),
      revision: subjectResult.data.revision.toLowerCase()
    },
    bugs: bugsResult.data as GroundTruthBug[]
  };
}

export function readGroundTruthDocument(
  filePath: string,
  options: { requireSubject?: boolean } = {}
): GroundTruthDocument {
  if (!fs.existsSync(filePath)) {
    throw new EvalError("EVAL_GROUND_TRUTH_MISSING", `ground truth file is missing: ${filePath}`, { path: filePath });
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new EvalError("EVAL_GROUND_TRUTH_INVALID", `ground truth path is not a regular file: ${filePath}`, {
      path: filePath
    });
  }
  if (stat.size > MAX_GROUND_TRUTH_BYTES) {
    throw new EvalError("EVAL_GROUND_TRUTH_TOO_LARGE", `ground truth file exceeds ${MAX_GROUND_TRUTH_BYTES} bytes`, {
      path: filePath,
      sizeBytes: stat.size,
      maxBytes: MAX_GROUND_TRUTH_BYTES
    });
  }
  let value: unknown;
  try {
    value = parse(fs.readFileSync(filePath, "utf8"));
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
