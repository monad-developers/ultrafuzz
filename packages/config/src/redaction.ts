import { cloneResolvedConfig } from "./defaults.js";
import { serializeResolvedConfigToml, type SerializeResolvedConfigTomlOptions } from "./resolve.js";
import { SENSITIVE_REDACTION_PLACEHOLDER, isSensitiveSecretValue, redactSecretsInText } from "@ultrafuzz/security";
import type { ConfigDiagnostic, ResolvedConfig } from "./types.js";

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

export function serializeRedactedResolvedConfigToml(
  redacted: RedactedResolvedConfig | ResolvedConfig,
  options: SerializeResolvedConfigTomlOptions = {}
): string {
  return serializeResolvedConfigToml("config" in redacted ? redacted.config : redacted, options);
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

function formatPath(path: string[]): string {
  return path.join(".");
}
