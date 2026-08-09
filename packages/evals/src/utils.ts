import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import {
  appendLineDurable,
  assertPlannedGraph,
  parseStrictJson,
  parseStrictJsonBytes,
  readRegularFileSnapshot,
  safeResolveInside,
  validateSafeId
} from "@ultrafuzz/artifacts";
import type { RuntimeDiagnostic } from "@ultrafuzz/runtime";

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
  const normalized = normalizeEvalId(parts).slice(0, 128);
  return assertSafeEvalId(normalized.length > 0 ? normalized : "eval", "eval ID");
}

/**
 * Build a safe eval ID without losing uniqueness when a composed ID exceeds its
 * caller-defined bound. Short IDs remain readable and unchanged; long IDs keep
 * a readable prefix plus a deterministic hash of the complete normalized ID.
 */
export function boundedEvalId(parts: string[], maxLength: number): string {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > 128) {
    throw new EvalError("EVAL_ID_INVALID", "eval ID max length must be an integer from 1 through 128", {
      maxLength
    });
  }

  const normalized = normalizeEvalId(parts);
  const candidate = normalized.length > 0 ? normalized : "eval";
  if (candidate.length <= maxLength) {
    return assertSafeEvalId(candidate, "eval ID");
  }

  const digest = crypto.createHash("sha256").update(candidate).digest("hex");
  const hashLength = 16;
  const bounded =
    maxLength <= hashLength + 1
      ? digest.slice(0, maxLength)
      : `${candidate.slice(0, maxLength - hashLength - 1)}-${digest.slice(0, hashLength)}`;
  return assertSafeEvalId(bounded, "eval ID");
}

function normalizeEvalId(parts: string[]): string {
  return parts
    .join("-")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[._-]+/u, "")
    .replace(/[._-]+$/u, "");
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

export interface TerminalReportPathResolution {
  path?: string;
  relativePath?: string;
  reason: string;
}

export function resolveTerminalReportPath(input: { runRoot?: string }): TerminalReportPathResolution {
  if (input.runRoot === undefined) {
    return { reason: "terminal report run root is unavailable" };
  }

  const runRoot = path.resolve(input.runRoot);
  const graphPath = path.join(runRoot, "graph.json");
  if (!fs.existsSync(graphPath)) {
    return { reason: "run graph is unavailable" };
  }
  const graph = assertPlannedGraph(jsonFile(graphPath));
  const candidates = terminalReportCandidates(runRoot, graph);
  if (candidates.length === 1) {
    return {
      path: candidates[0]!.path,
      relativePath: candidates[0]!.relativePath,
      reason: "terminal report path came from the run graph contract"
    };
  }
  if (candidates.length > 1) {
    return { reason: "run graph declares more than one ultrafuzz/report@2 output" };
  }
  return { reason: "run graph does not declare ultrafuzz/report@2" };
}

function terminalReportCandidates(runRoot: string, graph: unknown): Array<{ path: string; relativePath: string }> {
  if (!isRecord(graph) || !Array.isArray(graph.nodes)) {
    return [];
  }
  const candidates = new Map<string, { path: string; relativePath: string }>();
  for (const node of graph.nodes) {
    if (!isRecord(node) || typeof node.artifact_dir !== "string" || !Array.isArray(node.outputs)) {
      continue;
    }
    for (const output of node.outputs) {
      if (!isRecord(output) || output.contract !== "ultrafuzz/report@2" || typeof output.path !== "string") {
        continue;
      }
      try {
        const relativePath = path.posix.join(node.artifact_dir.replaceAll(path.sep, "/"), output.path);
        const reportPath = safeResolveInside(runRoot, relativePath, "terminal report path");
        candidates.set(reportPath, { path: reportPath, relativePath });
      } catch {
        // Invalid graph paths cannot be publication or scoring inputs.
      }
    }
  }
  return [...candidates.values()];
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
  return parseStrictJsonBytes(readRegularFileSnapshot(filePath, 64 * 1024 * 1024)) as T;
}

export function appendJsonLine(filePath: string, value: unknown): void {
  appendLineDurable(filePath, JSON.stringify(value));
}

export function readJsonLines<T = unknown>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const bytes = readRegularFileSnapshot(filePath, 64 * 1024 * 1024);
  const contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (contents.length === 0) return [];
  const lines = contents.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((rawLine, index) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length === 0) throw new SyntaxError(`blank JSONL record at ${filePath}:${index + 1}`);
    return parseStrictJson(line) as T;
  });
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
