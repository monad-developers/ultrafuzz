import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ConfigDiagnostic } from "@ultrafuzz/config";
import type { PolicyDiagnostic, PolicyResult } from "@ultrafuzz/security";

import { RUNTIME_SCHEMA_VERSION, type PostureItem, type RuntimeDiagnostic, type RuntimeResult } from "./types.js";

export function runtimeResult<T>(ok: boolean, value?: T, diagnostics: RuntimeDiagnostic[] = []): RuntimeResult<T> {
  return {
    schema_version: RUNTIME_SCHEMA_VERSION,
    ok,
    diagnostics,
    ...(value !== undefined ? { value } : {})
  };
}

export function runtimeFailure<T>(diagnostics: RuntimeDiagnostic[]): RuntimeResult<T> {
  return {
    schema_version: RUNTIME_SCHEMA_VERSION,
    ok: false,
    diagnostics
  };
}

export function runtimeError(
  code: string,
  message: string,
  source: string,
  pathValue?: string,
  details?: Record<string, unknown>
): RuntimeDiagnostic {
  return {
    code,
    message,
    severity: "error",
    source,
    ...(pathValue !== undefined ? { path: pathValue } : {}),
    ...(details !== undefined ? { details } : {})
  };
}

export function hasRuntimeErrors(diagnostics: RuntimeDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

export function postureFromDiagnostics(
  _source: string,
  summary: string,
  diagnostics: RuntimeDiagnostic[]
): PostureItem {
  const errors = diagnostics.some((diagnostic) => diagnostic.severity === "error");
  const warnings = diagnostics.some((diagnostic) => diagnostic.severity === "warning");
  return {
    ok: !errors,
    status: errors ? "fail" : warnings ? "warn" : "pass",
    summary,
    diagnostics
  };
}

export function configDiagnostics(diagnostics: ConfigDiagnostic[]): RuntimeDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnostic.severity,
    source: diagnostic.source,
    path: diagnostic.path.join("."),
    ...(diagnostic.location ? { details: { location: diagnostic.location } } : {})
  }));
}

export function policyDiagnostics<T>(policy: PolicyResult<T>, source: string): RuntimeDiagnostic[] {
  return policy.diagnostics.map((diagnostic: PolicyDiagnostic) => ({
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnostic.severity,
    source,
    ...(diagnostic.path ? { path: diagnostic.path } : {}),
    ...(diagnostic.details ? { details: diagnostic.details } : {})
  }));
}

export function diagnosticFromError(error: unknown, source: string, fallbackCode: string): RuntimeDiagnostic {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : fallbackCode;
  const details =
    error && typeof error === "object" && "details" in error && isRecord(error.details) ? error.details : undefined;
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    severity: "error",
    source,
    ...(details?.path && typeof details.path === "string" ? { path: details.path } : {}),
    ...(details ? { details } : {})
  };
}

export function generateRunId(prefix: string): string {
  const timestamp = new Date().toISOString().replace(/[-:.]/gu, "").replace("T", "t").replace("Z", "z");
  return `${prefix}-${timestamp}-${crypto.randomBytes(4).toString("hex")}`;
}

export function sha256Stable(value: unknown): string {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function toProjectRelative(projectRoot: string, candidate: string): string {
  return path.relative(path.resolve(projectRoot), path.resolve(candidate)).split(path.sep).join("/");
}

export function readJsonIfExists<T = unknown>(filePath: string): T | undefined {
  return fs.existsSync(filePath) ? (JSON.parse(fs.readFileSync(filePath, "utf8")) as T) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
