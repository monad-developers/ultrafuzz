import { parseStrictJsonBytes } from "@ultrafuzz/artifacts";

export const MAX_EPHEMERAL_JUDGE_CREDENTIAL_RESPONSE_BYTES = 64 * 1024;

export class JudgeCredentialResponseError extends Error {
  constructor(
    readonly category: "authentication-failure" | "unreachable",
    message: string,
    options: ErrorOptions = {}
  ) {
    super(message, options);
    this.name = "JudgeCredentialResponseError";
  }
}

/** Parse the exact Ultrafuzz credential-broker response; the key is never normalized or persisted. */
export function parseEphemeralJudgeCredentialResponse(contents: Uint8Array): string {
  let value: unknown;
  try {
    value = parseStrictJsonBytes(contents, {
      maxBytes: MAX_EPHEMERAL_JUDGE_CREDENTIAL_RESPONSE_BYTES,
      maxDepth: 2,
      maxItems: 16,
      maxProperties: 16
    });
  } catch (error) {
    throw new JudgeCredentialResponseError("unreachable", "judge credential response is not strict bounded JSON", {
      cause: error
    });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new JudgeCredentialResponseError("authentication-failure", "judge credential response must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    typeof record.key !== "string" ||
    record.key.length === 0 ||
    record.key !== record.key.trim() ||
    Buffer.byteLength(record.key, "utf8") > 16 * 1024
  ) {
    throw new JudgeCredentialResponseError(
      "authentication-failure",
      "judge credential response has an unsupported shape"
    );
  }
  return record.key;
}
