import {
  containsSensitiveSecrets,
  MIN_EXACT_SECRET_VALUE_LENGTH,
  sensitiveEnvironmentValues
} from "@ultrafuzz/security";

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
  const exactSecretBytes = [
    ...new Set(forbiddenSecretValues.filter((value) => value.length >= MIN_EXACT_SECRET_VALUE_LENGTH))
  ]
    .sort((left, right) => right.length - left.length || (left < right ? -1 : left > right ? 1 : 0))
    .map((secret) => Buffer.from(secret, "utf8"));

  for (const [artifactPath, publication] of [...publications].sort(([left], [right]) => left.localeCompare(right))) {
    const bytes = Buffer.from(publication);
    if (exactSecretBytes.some((secret) => bytes.indexOf(secret) !== -1)) {
      throw new ArtifactSecretGateError(artifactPath, "secret-detected");
    }
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
    if (containsSensitiveSecrets(text, [], "positive-only")) {
      throw new ArtifactSecretGateError(artifactPath, "secret-detected");
    }
  }
}

export { sensitiveEnvironmentValues };
