import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { validateSafeId } from "@ultrafuzz/artifacts";
import type { RuntimeDiagnostic } from "@ultrafuzz/runtime";

import { EVAL_RESULT_SCHEMA_VERSION, type EvalResult } from "./types.js";

export class EvalError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "EvalError";
    this.code = code;
    this.details = details;
  }
}

export function evalResult<T>(ok: boolean, value?: T, diagnostics: RuntimeDiagnostic[] = []): EvalResult<T> {
  return {
    schema_version: EVAL_RESULT_SCHEMA_VERSION,
    ok,
    diagnostics,
    ...(value !== undefined ? { value } : {})
  };
}

export function diagnosticFromError(error: unknown, fallbackCode = "EVAL_FAILED"): RuntimeDiagnostic {
  const code = error instanceof EvalError ? error.code : fallbackCode;
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    severity: "error",
    source: "evals"
  };
}

export function warningDiagnostic(code: string, message: string): RuntimeDiagnostic {
  return { code, message, severity: "warning", source: "evals" };
}

export function assertSafeEvalId(value: string, label: string): string {
  try {
    return validateSafeId(value, label);
  } catch (error) {
    throw new EvalError("EVAL_ID_INVALID", error instanceof Error ? error.message : String(error), { label, value });
  }
}

export function safeEvalId(parts: string[]): string {
  const normalized = parts
    .join("-")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[._-]+/u, "")
    .replace(/[._-]+$/u, "")
    .slice(0, 128);
  return assertSafeEvalId(normalized.length > 0 ? normalized : "eval", "eval ID");
}

export function generateEvalRunId(suite: string): string {
  const timestamp = new Date().toISOString().replace(/[-:.]/gu, "").replace("T", "t").replace("Z", "z");
  return safeEvalId(["eval", suite, timestamp, crypto.randomBytes(4).toString("hex")]);
}

export function resolveProjectPath(projectRoot: string, value: string): string {
  return path.resolve(projectRoot, value);
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertExternalPath(projectRoot: string, candidate: string, label: string): void {
  let resolvedProjectRoot: string;
  let resolvedCandidate: string;
  try {
    resolvedProjectRoot = resolveFromNearestExistingAncestor(projectRoot);
    resolvedCandidate = resolveFromNearestExistingAncestor(candidate);
  } catch (error) {
    throw new EvalError("EVAL_GROUND_TRUTH_UNSAFE", `${label} could not be resolved safely`, {
      path: path.resolve(candidate),
      reason: error instanceof Error ? error.message : String(error)
    });
  }
  if (isPathInside(resolvedProjectRoot, resolvedCandidate)) {
    throw new EvalError("EVAL_GROUND_TRUTH_INSIDE_REPO", `${label} must resolve outside this repository`, {
      path: path.resolve(candidate),
      resolvedPath: resolvedCandidate,
      projectRoot: path.resolve(projectRoot),
      resolvedProjectRoot
    });
  }
}

/** Resolve symlinks in the nearest existing ancestor, preserving a missing tail. */
function resolveFromNearestExistingAncestor(candidate: string): string {
  let current = path.resolve(candidate);
  const missingSegments: string[] = [];
  while (true) {
    let exists = false;
    try {
      fs.lstatSync(current);
      exists = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
    }
    if (exists) {
      return path.resolve(fs.realpathSync(current), ...missingSegments);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    missingSegments.unshift(path.basename(current));
    current = parent;
  }
}

export function assertExistingDirectory(candidate: string, label: string): void {
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
    throw new EvalError("EVAL_DIRECTORY_MISSING", `${label} must be an existing directory: ${candidate}`, {
      path: candidate
    });
  }
}

export function assertExistingFile(candidate: string, label: string): void {
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    throw new EvalError("EVAL_FILE_MISSING", `${label} must be an existing file: ${candidate}`, { path: candidate });
  }
}

export function assertTargetRef(targetPath: string, ref: string): void {
  assertExistingDirectory(targetPath, "target path");
  const gitDir = path.join(targetPath, ".git");
  if (!fs.existsSync(gitDir)) {
    throw new EvalError("EVAL_TARGET_NOT_GIT_REPOSITORY", `target path must be a git checkout: ${targetPath}`, {
      path: targetPath
    });
  }
  const head = git(targetPath, ["rev-parse", "HEAD"]);
  const resolved = resolveGitRef(targetPath, ref);
  if (resolved !== undefined) {
    if (resolved !== head) {
      throw new EvalError("EVAL_TARGET_REF_MISMATCH", `target checkout is ${head}, not ${ref} (${resolved})`, {
        path: targetPath,
        ref,
        head,
        resolved
      });
    }
    return;
  }
  if (/^[0-9a-f]{7,40}$/iu.test(ref) && head.startsWith(ref.toLowerCase())) {
    return;
  }
  throw new EvalError("EVAL_TARGET_REF_UNKNOWN", `target ref ${ref} is not present in ${targetPath}`, {
    path: targetPath,
    ref,
    head
  });
}

export function evalRunRoot(projectRoot: string, evalRunId: string): string {
  return path.join(
    path.resolve(projectRoot),
    ".ultrafuzz",
    "evals",
    "runs",
    assertSafeEvalId(evalRunId, "eval run ID")
  );
}

export function jsonFile<T = unknown>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export function appendJsonLine(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export function readJsonLines<T = unknown>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

export function roundMetric(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * 10000) / 10000;
}

export function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return roundMetric(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deterministic RFC-4122-shaped UUID derived from stable parts (for provider run/span ids). */
export function deterministicUuid(parts: string[]): string {
  const digest = crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32)
  ].join("-");
}

export function contentTypeForArtifact(relativePath: string): string {
  const extension = path.extname(relativePath).toLowerCase();
  switch (extension) {
    case ".md":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".txt":
    case ".log":
      return "text/plain";
    case ".yml":
    case ".yaml":
      return "application/yaml";
    default:
      return "application/octet-stream";
  }
}

function resolveGitRef(targetPath: string, ref: string): string | undefined {
  try {
    return git(targetPath, ["rev-parse", "--verify", `${ref}^{commit}`]);
  } catch {
    return undefined;
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  })
    .trim()
    .toLowerCase();
}
