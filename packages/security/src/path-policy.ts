import path from "node:path";
import { type PolicyDiagnostic, type PolicyResult, policyError, policyResult } from "./types.js";

export function validateSafeId(label: string, id: string): PolicyResult<string> {
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
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isReservedWindowsName(component: string): boolean {
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(component);
}
