export const SENSITIVE_REDACTION_PLACEHOLDER = "<redacted>";

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{6,}\b/gu,
  /\bsk-ant-[A-Za-z0-9_-]{6,}\b/gu,
  /\bgh[opusr]_[A-Za-z0-9_]{12,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\bglpat-[A-Za-z0-9_-]{12,}\b/gu,
  /\bhf_[A-Za-z0-9]{12,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu
];

export function isSensitiveKeyName(key: string): boolean {
  const normalized = key
    .toLowerCase()
    .replaceAll("-", "_")
    .replace(/[^a-z0-9_]+/g, "_");
  return (
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("api_key") ||
    normalized.includes("apikey") ||
    normalized.includes("credential") ||
    normalized.includes("private_key") ||
    normalized.includes("access_key") ||
    normalized.includes("secret_key") ||
    normalized.includes("client_secret") ||
    normalized === "auth" ||
    normalized.includes("authorization") ||
    normalized.includes("session")
  );
}

export function isSensitiveSecretValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (/^Bearer\s+/iu.test(trimmed)) {
    return true;
  }
  if (/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/u.test(trimmed)) {
    return true;
  }
  if (/((?:api[-_]?key|token|password|secret|credential|auth|authorization)=)[^,\s`'"]+/iu.test(trimmed)) {
    return true;
  }
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(trimmed);
  });
}

export function hasRedactionPlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    value === SENSITIVE_REDACTION_PLACEHOLDER ||
    value.includes(SENSITIVE_REDACTION_PLACEHOLDER) ||
    normalized === "redacted" ||
    normalized === "[redacted]" ||
    normalized === "{{redacted}}" ||
    normalized === "***redacted***" ||
    normalized === "ultrafuzz:redacted"
  );
}

export function redactSecretsInText(value: string, placeholder = SENSITIVE_REDACTION_PLACEHOLDER): string {
  let redacted = value
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gu, `$1${placeholder}@`)
    .replace(/(Bearer\s+)[^\s`'"]+/giu, `$1${placeholder}`)
    .replace(/((?:api[-_]?key|token|password|secret|credential|auth|authorization)=)[^,\s`'"]+/giu, `$1${placeholder}`);
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, placeholder);
  }
  return redacted;
}

export function redactSecretsInValue(value: unknown, placeholder = SENSITIVE_REDACTION_PLACEHOLDER): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecretsInValue(entry, placeholder));
  }
  if (isPlainRecord(value)) {
    const redacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      redacted[key] = isSensitiveKeyName(key) ? placeholder : redactSecretsInValue(entry, placeholder);
    }
    return redacted;
  }
  if (typeof value === "string") {
    return isSensitiveSecretValue(value) ? redactSecretsInText(value, placeholder) : value;
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
