import { cloneResolvedConfig } from "./defaults.js";
import { serializeResolvedConfigToml } from "./resolve.js";
import {
  SENSITIVE_REDACTION_PLACEHOLDER,
  hasRedactionPlaceholder,
  isSensitiveSecretValue,
  redactSecretsInText
} from "@ultrafuzz/security";
import {
  diagnostic,
  fail,
  hasErrors,
  ok,
  type ConfigDiagnostic,
  type ConfigResult,
  type ResolvedConfig
} from "./types.js";

export const REDACTION_PLACEHOLDER = SENSITIVE_REDACTION_PLACEHOLDER;
export const CONFIG_REDACTIONS_SCHEMA_VERSION = "ultrafuzz.config-redactions.v2" as const;

export interface RedactionEntry {
  path: string[];
  key: string;
  reason: "sensitive-value";
  restoreFrom: "current-config" | "environment";
  requiredForWorkflowLaunch: boolean;
  requiredForWorkflowSubmission: boolean;
}

export interface RedactionManifest {
  schemaVersion: typeof CONFIG_REDACTIONS_SCHEMA_VERSION;
  placeholder: typeof REDACTION_PLACEHOLDER;
  entries: RedactionEntry[];
}

export interface RedactedResolvedConfig {
  config: ResolvedConfig;
  manifest: RedactionManifest;
}

export function redactResolvedConfig(config: ResolvedConfig): RedactedResolvedConfig {
  const redacted = cloneResolvedConfig(config);
  const entries: RedactionEntry[] = [];

  for (const [id, profile] of Object.entries(redacted.models.profiles).sort()) {
    redactSensitiveScalar(profile, "model", ["models", "profiles", id, "model"], entries);
  }

  return {
    config: redacted,
    manifest: {
      schemaVersion: CONFIG_REDACTIONS_SCHEMA_VERSION,
      placeholder: REDACTION_PLACEHOLDER,
      entries
    }
  };
}

export function serializeRedactedResolvedConfigToml(redacted: RedactedResolvedConfig | ResolvedConfig): string {
  return serializeResolvedConfigToml("config" in redacted ? redacted.config : redacted);
}

export function restoreRedactedConfig(
  redactedConfig: ResolvedConfig,
  currentConfig: ResolvedConfig,
  manifest: RedactionManifest
): ConfigResult<ResolvedConfig> {
  const restored = cloneResolvedConfig(redactedConfig);
  const diagnostics: ConfigDiagnostic[] = [];

  for (const entry of manifest.entries) {
    const currentValue = getPath(currentConfig, entry.path);
    if (typeof currentValue !== "string" || currentValue.length === 0 || hasRedactionPlaceholder(currentValue)) {
      diagnostics.push(
        diagnostic(
          "CONFIG_REDACTION_RESTORE_MISSING",
          `redacted value at ${entry.key} must be restored from current config before workflow launch`,
          entry.path,
          "redaction"
        )
      );
      continue;
    }
    setPath(restored, entry.path, currentValue);
  }

  diagnostics.push(...assertNoRedactionPlaceholders(restored).diagnostics);
  if (hasErrors(diagnostics)) {
    return fail(diagnostics);
  }
  return ok(restored);
}

export function assertNoRedactionPlaceholders(config: ResolvedConfig): ConfigResult<void> {
  const diagnostics: ConfigDiagnostic[] = [];
  visitStrings(config, [], (path, value) => {
    if (hasRedactionPlaceholder(value)) {
      diagnostics.push(
        diagnostic(
          "CONFIG_REDACTION_PLACEHOLDER_PRESENT",
          `redaction placeholder at ${path.join(".")} cannot be passed to workflow launch`,
          path,
          "redaction"
        )
      );
    }
  });
  return diagnostics.length > 0 ? fail(diagnostics) : ok(undefined);
}

export function redactDiagnostics(diagnostics: ConfigDiagnostic[]): ConfigDiagnostic[] {
  return diagnostics.map((entry) => ({
    ...entry,
    message: redactSecretsInText(entry.message)
  }));
}

function redactSensitiveScalar<T extends object, K extends keyof T>(
  object: T,
  key: K,
  path: string[],
  entries: RedactionEntry[]
): void {
  const value = object[key];
  if (typeof value === "string" && isSensitiveSecretValue(value)) {
    (object as Record<string, unknown>)[String(key)] = REDACTION_PLACEHOLDER;
    entries.push({
      path,
      key: formatPath(path),
      reason: "sensitive-value",
      restoreFrom: "current-config",
      requiredForWorkflowLaunch: true,
      requiredForWorkflowSubmission: true
    });
  }
}

function visitStrings(value: unknown, path: string[], visitor: (path: string[], value: string) => void): void {
  if (typeof value === "string") {
    visitor(path, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      visitStrings(entry, path.concat(String(index)), visitor);
    });
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      visitStrings(child, path.concat(key), visitor);
    }
  }
}

function getPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (Array.isArray(current)) {
      current = current[Number(segment)];
    } else if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function setPath(value: unknown, path: string[], nextValue: string): void {
  let current = value as Record<string, unknown>;
  for (const segment of path.slice(0, -1)) {
    const child = current[segment];
    if (Array.isArray(child)) {
      current = child as unknown as Record<string, unknown>;
    } else {
      current = child as Record<string, unknown>;
    }
  }
  const last = path[path.length - 1];
  if (last === undefined) {
    return;
  }
  if (Array.isArray(current)) {
    current[Number(last)] = nextValue;
  } else {
    current[last] = nextValue;
  }
}

function formatPath(path: string[]): string {
  return path.join(".");
}
