import { validateMnemonic } from "@scure/bip39";
import { wordlist as englishWordlist } from "@scure/bip39/wordlists/english.js";

export const SENSITIVE_REDACTION_PLACEHOLDER = "<redacted>";
/**
 * Tiny exact values are too collision-prone for substring matching: a
 * one-character credential could otherwise redact or reject almost every
 * artifact. Pattern-based detection still applies regardless of this bound.
 */
export const MIN_EXACT_SECRET_VALUE_LENGTH = 8;

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
  /\bsk-ant-[A-Za-z0-9_-]{6,}\b/gu,
  /\bsk-[A-Za-z0-9_-]{6,}\b/gu,
  /\bgh[opusr]_[A-Za-z0-9_]{12,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\bglpat-[A-Za-z0-9_-]{12,}\b/gu,
  /\bhf_[A-Za-z0-9]{12,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /\bAIza[A-Za-z0-9_-]{20,}\b/gu,
  /\bnpm_[A-Za-z0-9]{20,}\b/gu,
  /\b(?:ak|as)-[A-Za-z0-9_-]{16,}\b/gu,
  /\bya29\.[A-Za-z0-9._-]{20,}\b/gu,
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
  /\b(?:https?|wss?):\/\/[^\s"'`]*(?:alchemy\.com\/v2\/|infura\.io\/v3\/)[A-Za-z0-9_-]{16,}\b/giu
];

const SENSITIVE_ASSIGNMENT_PATTERN =
  /((?:["'`])?(?:api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|id[-_\s]?token|token|password|passwd|secret|credential|client[-_\s]?secret|private[-_\s]?key|access[-_\s]?key|secret[-_\s]?key|authorization|auth|mnemonic|seed[-_\s]?phrase|recovery[-_\s]?phrase)(?:["'`])?\s*[:=]\s*)(?:"[^"\r\n]+"|'[^'\r\n]+'|`[^`\r\n]+`|[^\s,;\]}]+)/giu;
const HIGH_ENTROPY_CANDIDATE_PATTERN =
  /(?<![A-Za-z0-9._~+/=-])[A-Za-z0-9][A-Za-z0-9._~+/=-]{31,511}(?![A-Za-z0-9._~+/=-])/gu;
const GENERIC_HEX_SECRET_PATTERN = /\b[0-9a-f]{40}\b/giu;
const THIRTY_TWO_BYTE_HEX_PATTERN = /(?<![0-9a-f])(?:0x)?[0-9a-f]{64}(?![0-9a-f])/giu;
const BIP39_WORD_PATTERN = /\b[a-z]+\b/giu;
const BIP39_WORD_COUNTS = [24, 21, 18, 15, 12] as const;
const ENGLISH_BIP39_WORDS = new Set(englishWordlist);
const NON_SECRET_EXPLICIT_ENVIRONMENT_NAMES = new Set(["KIMI_BASE_URL"]);
const SENSITIVE_ENVIRONMENT_NAME_PATTERN =
  /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_?KEY|ACCESS_?KEY|CLIENT_?SECRET|CREDENTIALS?|AUTH(?:ORIZATION)?)(?:_|$)/iu;

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
    normalized.includes("session") ||
    normalized.includes("mnemonic") ||
    normalized.includes("seed_phrase") ||
    normalized.includes("recovery_phrase")
  );
}

export function isSensitiveEnvironmentName(name: string): boolean {
  return SENSITIVE_ENVIRONMENT_NAME_PATTERN.test(name);
}

/**
 * Return matchable secret values without retaining their environment names.
 * Explicit names come from trusted run configuration; common credential names
 * are also recognized so local workflows receive exact-value protection.
 * Values shorter than MIN_EXACT_SECRET_VALUE_LENGTH are intentionally omitted
 * because substring matching them would create broad false positives.
 */
export function sensitiveEnvironmentValues(
  environment: Readonly<Record<string, string | undefined>>,
  explicitNames: readonly string[] = []
): string[] {
  const names = new Set(Object.keys(environment).filter(isSensitiveEnvironmentName));
  for (const name of explicitNames) {
    if (!NON_SECRET_EXPLICIT_ENVIRONMENT_NAMES.has(name)) names.add(name);
  }
  return [...new Set([...names].map((name) => environment[name]).filter(isMatchableExactSecret))].sort(compareSecrets);
}

export function isSensitiveSecretValue(value: string, forbiddenSecretValues: readonly string[] = []): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    redactSecretsInText(trimmed, SENSITIVE_REDACTION_PLACEHOLDER, forbiddenSecretValues) !== trimmed
  );
}

export function containsSensitiveSecrets(value: string, forbiddenSecretValues: readonly string[] = []): boolean {
  return redactSecretsInText(value, SENSITIVE_REDACTION_PLACEHOLDER, forbiddenSecretValues) !== value;
}

/** Match exact concealed spans without allowing surrounding context to drift. */
export function matchesRedactedText(
  redacted: string,
  observed: string,
  redactedSpanCodePoints: readonly number[],
  options: { allowObservedSuffix?: boolean } = {}
): boolean {
  const fragments = redacted.split(SENSITIVE_REDACTION_PLACEHOLDER);
  if (fragments.length === 1) return redactedSpanCodePoints.length === 0 && redacted === observed;
  if (redactedSpanCodePoints.length !== fragments.length - 1) return false;
  const first = fragments[0] ?? "";
  if (!observed.startsWith(first)) return false;
  let cursor = first.length;
  for (let index = 0; index < redactedSpanCodePoints.length; index += 1) {
    const next = advanceCodePoints(observed, cursor, redactedSpanCodePoints[index]!);
    if (next === undefined) return false;
    cursor = next;
    const fragment = fragments[index + 1] ?? "";
    if (!observed.startsWith(fragment, cursor)) return false;
    cursor += fragment.length;
  }
  return options.allowObservedSuffix === true || cursor === observed.length;
}

/** Infer one unambiguous normalized source span for each inserted placeholder. */
export function redactedTextSpanCodePointLengths(redacted: string, observed: string): number[] | undefined {
  if (redacted.length > 16_384 || observed.length > 16_384) return undefined;
  const fragments = redacted.split(SENSITIVE_REDACTION_PLACEHOLDER);
  if (fragments.length > 65) return undefined;
  if (fragments.length === 1) return redacted === observed ? [] : undefined;
  if (!observed.startsWith(fragments[0] ?? "") || fragments.slice(1, -1).some((fragment) => fragment === "")) {
    return undefined;
  }
  const solutions: number[][] = [];
  let probes = 0;
  let exhausted = false;
  const visit = (index: number, cursor: number, lengths: number[]): void => {
    if (solutions.length > 1 || exhausted) return;
    const fragment = fragments[index] ?? "";
    if (index === fragments.length - 1) {
      const start = observed.length - fragment.length;
      if (start > cursor && observed.startsWith(fragment, start)) {
        solutions.push([...lengths, [...observed.slice(cursor, start)].length]);
      }
      return;
    }
    for (
      let start = observed.indexOf(fragment, cursor + 1);
      start >= 0;
      start = observed.indexOf(fragment, start + 1)
    ) {
      if (++probes > 256) {
        exhausted = true;
        return;
      }
      visit(index + 1, start + fragment.length, [...lengths, [...observed.slice(cursor, start)].length]);
      if (solutions.length > 1) return;
    }
  };
  visit(1, (fragments[0] ?? "").length, []);
  return !exhausted && solutions.length === 1 ? solutions[0] : undefined;
}

function advanceCodePoints(value: string, start: number, count: number): number | undefined {
  if (!Number.isSafeInteger(count) || count <= 0) return undefined;
  let cursor = start;
  for (let index = 0; index < count; index += 1) {
    if (cursor >= value.length) return undefined;
    cursor += value.codePointAt(cursor)! > 0xffff ? 2 : 1;
  }
  return cursor;
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

export function redactSecretsInText(
  value: string,
  placeholder = SENSITIVE_REDACTION_PLACEHOLDER,
  forbiddenSecretValues: readonly string[] = []
): string {
  let redacted = redactExactSecretValues(value, placeholder, forbiddenSecretValues)
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gu, `$1${placeholder}@`)
    .replace(/(Bearer\s+)[^\s`'"]+/giu, `$1${placeholder}`)
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, (assignment, prefix: string) => {
      const assignedValue = assignment.slice(prefix.length);
      const quote = assignedValue[0];
      return quote === '"' || quote === "'" || quote === "`"
        ? `${prefix}${quote}${placeholder}${quote}`
        : `${prefix}${placeholder}`;
    });
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, placeholder);
  }
  redacted = redactContextLabeledPrivateKeys(redacted, placeholder);
  redacted = redactBip39Mnemonics(redacted, placeholder);
  redacted = redactUnlabeledFortyHexSecrets(redacted, placeholder);
  return redacted.replace(HIGH_ENTROPY_CANDIDATE_PATTERN, (candidate, offset: number) =>
    isHighEntropySecretCandidate(redacted, candidate, offset) ? placeholder : candidate
  );
}

export function redactSecretsInValue(
  value: unknown,
  placeholder = SENSITIVE_REDACTION_PLACEHOLDER,
  forbiddenSecretValues: readonly string[] = []
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecretsInValue(entry, placeholder, forbiddenSecretValues));
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        isSensitiveKeyName(key) ? placeholder : redactSecretsInValue(entry, placeholder, forbiddenSecretValues)
      ])
    );
  }
  if (typeof value === "string") {
    return redactSecretsInText(value, placeholder, forbiddenSecretValues);
  }
  return value;
}

function redactExactSecretValues(value: string, placeholder: string, forbiddenSecretValues: readonly string[]): string {
  let redacted = value;
  for (const secret of [...new Set(forbiddenSecretValues.filter(isMatchableExactSecret))].sort(compareSecrets)) {
    redacted = redacted.split(secret).join(placeholder);
  }
  return redacted;
}

function redactBip39Mnemonics(value: string, placeholder: string): string {
  type WordToken = { word: string; start: number; end: number };
  let run: WordToken[] = [];
  const ranges: Array<{ start: number; end: number }> = [];
  for (const match of value.matchAll(BIP39_WORD_PATTERN)) {
    const token = { word: match[0].toLowerCase(), start: match.index, end: match.index + match[0].length };
    const previous = run.at(-1);
    if (
      !ENGLISH_BIP39_WORDS.has(token.word) ||
      (previous !== undefined && !/^\s+$/u.test(value.slice(previous.end, token.start)))
    ) {
      run = ENGLISH_BIP39_WORDS.has(token.word) ? [token] : [];
      continue;
    }
    run.push(token);
    // A long uninterrupted BIP-39 word stream is itself credential-like and
    // must not force unbounded checksum work on an agent-controlled artifact.
    if (run.length > BIP39_WORD_COUNTS[0] * 2) return placeholder;
    for (const wordCount of BIP39_WORD_COUNTS) {
      if (run.length < wordCount) continue;
      const window = run.slice(-wordCount);
      if (!validateMnemonic(window.map((token) => token.word).join(" "), englishWordlist)) continue;
      ranges.push({ start: window[0]!.start, end: window.at(-1)!.end });
      run = [];
      break;
    }
  }
  let redacted = value;
  for (const range of ranges.reverse()) {
    redacted = `${redacted.slice(0, range.start)}${placeholder}${redacted.slice(range.end)}`;
  }
  return redacted;
}

function redactUnlabeledFortyHexSecrets(value: string, placeholder: string): string {
  GENERIC_HEX_SECRET_PATTERN.lastIndex = 0;
  return value.replace(GENERIC_HEX_SECRET_PATTERN, (candidate, offset: number) =>
    isClearlyLabeledDigestContext(value.slice(Math.max(0, offset - 96), offset)) ? candidate : placeholder
  );
}

function redactContextLabeledPrivateKeys(value: string, placeholder: string): string {
  THIRTY_TWO_BYTE_HEX_PATTERN.lastIndex = 0;
  return value.replace(THIRTY_TWO_BYTE_HEX_PATTERN, (candidate, offset: number) =>
    /(?:private|secret|signing|wallet|ethereum|evm)[-_\s]*(?:key|scalar)\s*(?:(?:[:=]|\bis\b)\s*)?["'`]?$/iu.test(
      value.slice(Math.max(0, offset - 96), offset)
    )
      ? placeholder
      : candidate
  );
}

function isHighEntropySecretCandidate(source: string, candidate: string, offset: number): boolean {
  const unpadded = candidate.replace(/=+$/u, "");
  if (unpadded.length < 32 || /^[0-9a-f]+$/iu.test(unpadded)) return false;
  // A diagnostic may quote the name of a controller variable. The reference
  // is guidance, not the variable's value, and must remain readable.
  if (/^process\.env\.[A-Z][A-Z0-9_]*$/u.test(unpadded)) return false;
  if (isClearlyLabeledDigestContext(source.slice(Math.max(0, offset - 96), offset))) return false;
  const characterClasses = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[._~+/=-]/u].filter((pattern) =>
    pattern.test(unpadded)
  ).length;
  return characterClasses >= 3 && new Set(unpadded).size >= 12 && shannonEntropy(unpadded) >= 4.3;
}

function isClearlyLabeledDigestContext(prefix: string): boolean {
  return /(?:\/(?:commit|tree)\/|(?:["'`]?(?:[A-Za-z0-9]+[-_])*(?:commit(?:[-_](?:sha|id))?|sha(?:1|256|512)?|hash|digest|checksum|revision|rev|ref|tree|parent)["'`]?)\s*(?:(?:[:=]|\bis\b|\bat\b)\s*)?["'`]?)$/iu.test(
    prefix
  );
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function compareSecrets(left: string, right: string): number {
  return right.length - left.length || (left < right ? -1 : left > right ? 1 : 0);
}

function isMatchableExactSecret(value: string | undefined): value is string {
  return value !== undefined && value.length >= MIN_EXACT_SECRET_VALUE_LENGTH;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
