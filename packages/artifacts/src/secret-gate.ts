import {
  containsSensitiveSecrets,
  MIN_EXACT_SECRET_VALUE_LENGTH,
  sensitiveEnvironmentValues
} from "@ultrafuzz/security";

import { parseStrictJsonBytes } from "./strict-json.js";

export const ARTIFACT_SECRET_GATE_ERROR_CODE = "ARTIFACT_SECRET_GATE_REJECTED" as const;

export class ArtifactSecretGateError extends Error {
  readonly code = ARTIFACT_SECRET_GATE_ERROR_CODE;
  readonly artifactPath: string;

  constructor(artifactPath: string, reason: "secret-detected" | "invalid-utf8", options?: ErrorOptions) {
    super(
      reason === "secret-detected"
        ? `artifact publication contains sensitive data: ${artifactPath}`
        : `artifact publication cannot be secret-scanned as strict UTF-8: ${artifactPath}`,
      options
    );
    this.name = "ArtifactSecretGateError";
    this.artifactPath = artifactPath;
  }
}

/**
 * Fail closed before canonical publication. This function deliberately does
 * not return transformed bytes: verifier-authenticated agent output remains
 * immutable, and contaminated output must be regenerated explicitly.
 */
export function assertArtifactPublicationsContainNoSecrets(
  publications: ReadonlyMap<string, Uint8Array>,
  forbiddenSecretValues: readonly string[] = []
): void {
  const secrets = matchableSecretValues(forbiddenSecretValues);
  for (const [artifactPath, publication] of [...publications].sort(([left], [right]) => left.localeCompare(right))) {
    if (containsPublicationSecret(publication, secrets)) {
      throw new ArtifactSecretGateError(artifactPath, "secret-detected");
    }
  }
}

/**
 * Whether one publication holds a configured value or a positively identified
 * credential, by the same checks as the artifact secret gate. For gates outside
 * the artifact verifier that publish their own documents.
 */
export function publicationContainsSecrets(
  publication: Uint8Array,
  forbiddenSecretValues: readonly string[] = []
): boolean {
  return containsPublicationSecret(publication, matchableSecretValues(forbiddenSecretValues));
}

/**
 * The run credentials a publication must not hold: every value
 * `sensitiveEnvironmentValues` recognizes by name, plus the variables the
 * controller names as credentials although their names do not say so, such as
 * a configured `api_key_env` or an allowlisted variable whose value is secret.
 */
export function publicationForbiddenSecretValues(
  environment: Readonly<Record<string, string | undefined>>,
  explicitNames: readonly string[] = []
): string[] {
  // The lists themselves hold variable names, not credentials, although
  // ULTRAFUZZ_PROVIDER_CREDENTIAL_ENV_NAMES is named like one: matching them
  // would reject an output that mentions ANTHROPIC_API_KEY.
  const { ULTRAFUZZ_PROVIDER_CREDENTIAL_ENV_NAMES, ULTRAFUZZ_SENSITIVE_AGENT_ENV_NAMES, ...credentials } = environment;
  return sensitiveEnvironmentValues(credentials, [
    ...explicitNames,
    ...environmentNameList(ULTRAFUZZ_PROVIDER_CREDENTIAL_ENV_NAMES),
    ...environmentNameList(ULTRAFUZZ_SENSITIVE_AGENT_ENV_NAMES)
  ]);
}

function environmentNameList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name));
}

interface MatchableSecret {
  value: string;
  bytes: Buffer;
  withoutWhitespace: string;
}

function matchableSecretValues(forbiddenSecretValues: readonly string[]): MatchableSecret[] {
  return [...new Set(forbiddenSecretValues.filter((value) => value.length >= MIN_EXACT_SECRET_VALUE_LENGTH))]
    .sort((left, right) => right.length - left.length || (left < right ? -1 : left > right ? 1 : 0))
    .map((value) => ({ value, bytes: Buffer.from(value, "utf8"), withoutWhitespace: value.replace(/\s+/gu, "") }));
}

function containsPublicationSecret(publication: Uint8Array, secrets: readonly MatchableSecret[]): boolean {
  const bytes = Buffer.from(publication);
  if (secrets.some((secret) => bytes.indexOf(secret.bytes) !== -1)) return true;
  // Campaign evidence may be an arbitrary binary corpus. Decode invalid
  // sequences with replacement so printable UTF-8/ASCII secret signatures
  // are still scanned, while exact active credentials remain protected by
  // the byte-level check above.
  //
  // "positive-only": this gate FAILS on a hit and deliberately does not
  // rewrite the bytes, so a false positive destroys a run rather than
  // over-redacting a log line. The speculative heuristics cannot carry that
  // weight — Shannon entropy scores a versioned contract method (4.62) above
  // a GitHub token (4.25), unlabeled 40-hex matches every commit hash, and
  // the key-name rule fires on the English sentence "For every token:"
  // (#819). Positively identified credentials — secretlint library findings,
  // the documented supplemental vendor formats, mnemonics, labeled private
  // keys, URL and Bearer credentials — are all still detected here, and the
  // configured values are still matched byte-for-byte above.
  const text = new TextDecoder("utf-8").decode(bytes);
  if (containsSensitiveSecrets(text, [], "positive-only") || containsEncodedSecret(text, secrets)) return true;
  // JSON escapes a quote, a backslash and a control character, so a value
  // holding one never appears verbatim in the bytes (#1217). The decoded
  // strings are scanned as well. They are joined by NUL, which no pattern
  // treats as a word gap, so words that end one string and start the next
  // never read as one phrase.
  const strings = decodedJsonStrings(bytes);
  if (strings === undefined) return false;
  const decoded = strings.join("\0");
  return (
    secrets.some((secret) => decoded.includes(secret.value)) ||
    containsSensitiveSecrets(decoded, [], "positive-only") ||
    containsEncodedSecret(decoded, secrets)
  );
}

/**
 * A configured value written in an encoding agents produce without meaning
 * to: percent-encoded inside a URL, with Markdown backslash escapes, or broken
 * across lines. Deliberate encodings such as base64 are out of reach of any
 * scan and are not attempted (#1217).
 */
function containsEncodedSecret(text: string, secrets: readonly MatchableSecret[]): boolean {
  if (secrets.length === 0) return false;
  const markdownUnescaped = text.replace(/\\([!-/:-@[-`{-~])/gu, "$1");
  const percentDecoded = text.replace(/(?:%[0-9A-Fa-f]{2})+/gu, (encoded) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  });
  const withoutWhitespace = markdownUnescaped.replace(/\s+/gu, "");
  return secrets.some(
    (secret) =>
      markdownUnescaped.includes(secret.value) ||
      percentDecoded.includes(secret.value) ||
      (secret.withoutWhitespace.length >= MIN_EXACT_SECRET_VALUE_LENGTH &&
        withoutWhitespace.includes(secret.withoutWhitespace))
  );
}

/**
 * Every object key and string value of a publication that is strict JSON, in
 * document order; undefined for any other publication, whose bytes the scan
 * above already reads as they are.
 */
function decodedJsonStrings(bytes: Uint8Array): string[] | undefined {
  let value: unknown;
  try {
    value = parseStrictJsonBytes(bytes);
  } catch {
    return undefined;
  }
  const strings: string[] = [];
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      strings.push(current);
    } else if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) pending.push(current[index]);
    } else if (typeof current === "object" && current !== null) {
      for (const [key, entry] of Object.entries(current).reverse()) pending.push(entry, key);
    }
  }
  return strings;
}

export { sensitiveEnvironmentValues };
