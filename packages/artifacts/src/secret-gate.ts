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
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new ArtifactSecretGateError(artifactPath, "invalid-utf8", { cause: error });
    }
    if (containsSensitiveSecrets(text)) {
      throw new ArtifactSecretGateError(artifactPath, "secret-detected");
    }
  }
}

export { sensitiveEnvironmentValues };
