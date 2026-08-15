import { realpathSync } from "node:fs";
import path from "node:path";
import { type PolicyDiagnostic, type PolicyResult, policyError, policyResult } from "./types.js";

export interface ResolveInsideOptions {
  allowAbsolute?: boolean;
  mustExist?: boolean;
}

export interface ResolvedPathPolicy {
  root: string;
  path: string;
  relativePath: string;
}

export function validateSafeIdResult(label: string, id: string): PolicyResult<string> {
  const diagnostics: PolicyDiagnostic[] = [];
  if (id.length === 0) {
    diagnostics.push(policyError("ID_EMPTY", `${label} cannot be empty`));
  }
  if (id.length > 128) {
    diagnostics.push(policyError("ID_TOO_LONG", `${label} is longer than 128 characters`));
  }
  if (id.startsWith(".") || id.endsWith(".") || id.includes("..")) {
    diagnostics.push(policyError("ID_TRAVERSAL", `${label} must not contain traversal or dot edges`));
  }
  if (/[\\/:\0\r\n\t]/.test(id)) {
    diagnostics.push(policyError("ID_UNSAFE_CHARACTER", `${label} contains an unsafe character`));
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    diagnostics.push(
      policyError("ID_UNSAFE_SHAPE", `${label} must use ASCII letters, digits, hyphen, underscore, or dot`)
    );
  }
  return policyResult(diagnostics, id);
}

export function validateSafeRelativePath(relativePath: string): PolicyResult<string> {
  const diagnostics: PolicyDiagnostic[] = [];
  const normalized = normalizeRelativePath(relativePath);
  if (normalized === "") {
    diagnostics.push(policyError("PATH_EMPTY", "path must be non-empty"));
  }
  if (relativePath.includes("\\")) {
    diagnostics.push(policyError("PATH_BACKSLASH", `path \`${relativePath}\` must use forward slashes`));
  }
  if (isAbsoluteLike(relativePath)) {
    diagnostics.push(policyError("PATH_ABSOLUTE", `path \`${relativePath}\` must be relative`));
  }
  if (relativePath.includes("\0") || /[\r\n\t]/.test(relativePath)) {
    diagnostics.push(policyError("PATH_CONTROL_CHAR", `path \`${relativePath}\` contains a control character`));
  }
  const components = splitPathComponents(relativePath);
  if (components.some((component) => component === "" || component === "." || component === "..")) {
    diagnostics.push(
      policyError("PATH_TRAVERSAL", `path \`${relativePath}\` may not contain empty, current, or parent components`)
    );
  }
  if (components.some((component) => isReservedWindowsName(component))) {
    diagnostics.push(policyError("PATH_RESERVED_NAME", `path \`${relativePath}\` contains a reserved platform name`));
  }
  return policyResult(diagnostics, normalized);
}

export function resolvePathInside(
  root: string,
  requestedPath: string,
  options: ResolveInsideOptions = {}
): PolicyResult<ResolvedPathPolicy> {
  const diagnostics: PolicyDiagnostic[] = [];
  if (requestedPath.includes("\\")) {
    diagnostics.push(policyError("PATH_BACKSLASH", `path \`${requestedPath}\` must use forward slashes`));
  }
  if (isAbsoluteLike(requestedPath) && !options.allowAbsolute) {
    diagnostics.push(policyError("PATH_ABSOLUTE", `path \`${requestedPath}\` must be relative`));
  }

  let rootReal = "";
  let candidateReal = "";
  try {
    rootReal = realpathSync.native(root);
  } catch (error) {
    diagnostics.push(
      policyError("PATH_ROOT_MISSING", `root \`${root}\` is not accessible`, {
        details: { error: String(error) }
      })
    );
  }

  const candidate = isAbsoluteLike(requestedPath) ? requestedPath : path.join(root, requestedPath);
  if (!isAbsoluteLike(requestedPath)) {
    diagnostics.push(...validateSafeRelativePath(requestedPath).diagnostics);
  }
  try {
    candidateReal = canonicalExistingOrParent(candidate, options.mustExist ?? false);
  } catch (error) {
    diagnostics.push(
      policyError("PATH_CANDIDATE_MISSING", `path \`${requestedPath}\` is not accessible`, {
        path: requestedPath,
        details: { error: String(error) }
      })
    );
  }

  if (rootReal && candidateReal && !isPathInside(rootReal, candidateReal)) {
    diagnostics.push(
      policyError("PATH_ESCAPE", `path \`${requestedPath}\` resolves outside \`${rootReal}\``, {
        path: requestedPath,
        details: { root: rootReal, resolved: candidateReal }
      })
    );
  }

  const relative = rootReal && candidateReal ? toPosixRelative(rootReal, candidateReal) : "";
  return policyResult(diagnostics, {
    root: rootReal,
    path: candidateReal,
    relativePath: relative
  });
}

export function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

export function isAbsoluteLike(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("\\\\") ||
    value.toLowerCase().startsWith("file:")
  );
}

export function splitPathComponents(value: string): string[] {
  return normalizeRelativePath(value).split("/");
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalExistingOrParent(candidate: string, mustExist: boolean): string {
  if (mustExist) {
    return realpathSync.native(candidate);
  }
  let current = candidate;
  const missingParts: string[] = [];
  while (current !== path.dirname(current)) {
    try {
      return path.join(realpathSync.native(current), ...missingParts.reverse());
    } catch {
      missingParts.push(path.basename(current));
      current = path.dirname(current);
    }
  }
  return path.join(realpathSync.native(current), ...missingParts.reverse());
}

function toPosixRelative(root: string, candidate: string): string {
  return normalizeRelativePath(path.relative(root, candidate));
}

function isReservedWindowsName(component: string): boolean {
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(component);
}
