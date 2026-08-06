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

/**
 * Enumerates common lossless textual encodings of an exact credential. This is
 * intentionally separate from heuristic secret detection: callers that know
 * the actual credential bytes must reject encoded copies as well as literals.
 */
export function secretValueRepresentations(secret: string): string[] {
  if (secret.length === 0) return [];
  const bytes = Buffer.from(secret, "utf8");
  const base64 = bytes.toString("base64");
  const base64Url = base64.replaceAll("+", "-").replaceAll("/", "_");
  const hex = bytes.toString("hex");
  const percentUpper = [...bytes].map((byte) => `%${byte.toString(16).padStart(2, "0").toUpperCase()}`).join("");
  const representations = new Set([
    secret,
    base64,
    base64.replace(/=+$/u, ""),
    base64Url,
    base64Url.replace(/=+$/u, ""),
    hex,
    hex.toUpperCase(),
    percentUpper,
    percentUpper.toLowerCase(),
    ...embeddedBase64Representations(bytes),
    ...unicodeEscapeRepresentations(secret)
  ]);
  try {
    const uriComponent = encodeURIComponent(secret);
    representations.add(uriComponent);
    representations.add(uriComponent.replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase()));
    representations.add(uriComponent.replaceAll("%20", "+"));
    representations.add(JSON.stringify(secret).slice(1, -1));
  } catch {
    // Byte-oriented encodings above still cover malformed surrogate input.
  }
  representations.delete("");
  return [...representations].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

/**
 * Base64 encodes three bytes into four characters, so a credential embedded at a
 * byte offset that is not a multiple of three encodes to entirely different
 * characters than the credential encoded on its own. That is the common case in
 * practice: an HTTP request/response body or a JSON envelope is base64-encoded as
 * a whole, placing the credential at an arbitrary offset. This enumerates, for
 * each of the three alignments, the substring of the encoding that depends only on
 * the credential's own bytes, so a plain substring search finds it at any offset.
 */
function embeddedBase64Representations(bytes: Buffer): string[] {
  const representations: string[] = [];
  for (const phase of [1, 2]) {
    // Only whole 3-byte groups encode to characters determined solely by the
    // credential, so drop the leading group (shared with the prefix) and any
    // trailing partial group (shared with whatever follows).
    const padded = Buffer.concat([Buffer.alloc(phase), bytes]);
    const encoded = padded.toString("base64");
    const start = 4;
    const end = encoded.length - (padded.length % 3 === 0 ? 0 : 4);
    if (end - start < 8) continue;
    const aligned = encoded.slice(start, end);
    representations.push(aligned, aligned.replaceAll("+", "-").replaceAll("/", "_"));
  }
  return representations;
}

/**
 * A credential serialized through a JSON encoder that escapes non-ASCII, or
 * embedded in source that escapes every character, survives as `\uXXXX` units.
 */
function unicodeEscapeRepresentations(secret: string): string[] {
  let lower = "";
  for (const unit of secret) {
    const code = unit.codePointAt(0);
    if (code === undefined || code > 0xff_ff) return [];
    lower += `\\u${code.toString(16).padStart(4, "0")}`;
  }
  return lower === "" ? [] : [lower, lower.toUpperCase().replaceAll("\\U", "\\u")];
}

export function containsSecretValueRepresentation(
  value: string | Uint8Array,
  secretValues: readonly string[]
): boolean {
  const contents = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  if (
    uniqueSecretRepresentations(secretValues).some((representation) =>
      contents.includes(Buffer.from(representation, "utf8"))
    )
  ) {
    return true;
  }
  return uniqueSecretValues(secretValues).some((secret) => {
    const secretBytes = Buffer.from(secret, "utf8");
    return (
      findEncodedSecretSpan(contents, secretBytes, 0, "hex") !== undefined ||
      findEncodedSecretSpan(contents, secretBytes, 0, "percent") !== undefined
    );
  });
}

export function redactSecretValueRepresentations(
  value: string,
  secretValues: readonly string[],
  placeholder = SENSITIVE_REDACTION_PLACEHOLDER
): string {
  let redacted = value;
  for (const representation of uniqueSecretRepresentations(secretValues)) {
    redacted = redacted.replaceAll(representation, placeholder);
  }
  for (const secret of uniqueSecretValues(secretValues)) {
    redacted = redactEncodedSecretSpans(redacted, Buffer.from(secret, "utf8"), placeholder, "hex");
    redacted = redactEncodedSecretSpans(redacted, Buffer.from(secret, "utf8"), placeholder, "percent");
  }
  return redacted;
}

type EncodedSecretKind = "hex" | "percent";

function redactEncodedSecretSpans(
  value: string,
  secretBytes: Buffer,
  placeholder: string,
  kind: EncodedSecretKind
): string {
  const contents = Buffer.from(value, "utf8");
  const chunks: Buffer[] = [];
  let copiedThrough = 0;
  let searchFrom = 0;
  while (searchFrom < contents.length) {
    const span = findEncodedSecretSpan(contents, secretBytes, searchFrom, kind);
    if (span === undefined) break;
    chunks.push(contents.subarray(copiedThrough, span.start), Buffer.from(placeholder, "utf8"));
    copiedThrough = span.end;
    searchFrom = span.end;
  }
  if (chunks.length === 0) return value;
  chunks.push(contents.subarray(copiedThrough));
  return Buffer.concat(chunks).toString("utf8");
}

function findEncodedSecretSpan(
  contents: Buffer,
  secretBytes: Buffer,
  searchFrom: number,
  kind: EncodedSecretKind
): { start: number; end: number } | undefined {
  if (secretBytes.length === 0) return undefined;
  for (let start = searchFrom; start < contents.length; start += 1) {
    const end =
      kind === "hex"
        ? mixedCaseHexMatchEnd(contents, start, secretBytes)
        : partialPercentEncodingMatchEnd(contents, start, secretBytes);
    if (end !== undefined) return { start, end };
  }
  return undefined;
}

function mixedCaseHexMatchEnd(contents: Buffer, start: number, secretBytes: Buffer): number | undefined {
  if (start + secretBytes.length * 2 > contents.length) return undefined;
  for (let index = 0; index < secretBytes.length; index += 1) {
    const byte = secretBytes[index]!;
    if (
      asciiHexNibble(contents[start + index * 2]!) !== byte >>> 4 ||
      asciiHexNibble(contents[start + index * 2 + 1]!) !== (byte & 0x0f)
    ) {
      return undefined;
    }
  }
  return start + secretBytes.length * 2;
}

function partialPercentEncodingMatchEnd(contents: Buffer, start: number, secretBytes: Buffer): number | undefined {
  let cursor = start;
  let transformed = false;
  for (const secretByte of secretBytes) {
    if (contents[cursor] === secretByte) {
      cursor += 1;
      continue;
    }
    if (secretByte === 0x20 && contents[cursor] === 0x2b) {
      cursor += 1;
      transformed = true;
      continue;
    }
    if (
      contents[cursor] === 0x25 &&
      asciiHexNibble(contents[cursor + 1] ?? -1) === secretByte >>> 4 &&
      asciiHexNibble(contents[cursor + 2] ?? -1) === (secretByte & 0x0f)
    ) {
      cursor += 3;
      transformed = true;
      continue;
    }
    return undefined;
  }
  return transformed ? cursor : undefined;
}

function asciiHexNibble(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  return -1;
}

function uniqueSecretRepresentations(secretValues: readonly string[]): string[] {
  const representations = new Set<string>();
  for (const secret of new Set(secretValues.filter((value) => value.length > 0))) {
    for (const representation of secretValueRepresentations(secret)) representations.add(representation);
  }
  return [...representations].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function uniqueSecretValues(secretValues: readonly string[]): string[] {
  return [...new Set(secretValues.filter((value) => value.length > 0))];
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
