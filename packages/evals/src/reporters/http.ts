import { EvalError } from "../utils.js";

export const PROVIDER_REQUEST_TIMEOUT_MS = 30_000;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

export function exactProviderOrigin(configured: string | undefined, expected: string, provider: string): string {
  const value = configured ?? expected;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new EvalError("EVAL_PROVIDER_ENDPOINT_INVALID", `${provider} endpoint must be a valid HTTPS origin`, {
      provider
    });
  }
  const expectedOrigin = new URL(expected).origin;
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== expectedOrigin ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new EvalError(
      "EVAL_PROVIDER_ENDPOINT_INVALID",
      `${provider} endpoint must use the approved HTTPS origin ${expectedOrigin}`,
      { provider, expectedOrigin }
    );
  }
  return expectedOrigin;
}

export async function boundedProviderResponseText(response: Response, provider: string): Promise<string> {
  const declaredLength = response.headers?.get?.("content-length");
  if (declaredLength !== null && declaredLength !== undefined) {
    const declaredBytes = Number(declaredLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_PROVIDER_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw responseTooLarge(provider);
    }
  }

  if (response.body === null || response.body === undefined || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_PROVIDER_RESPONSE_BYTES) {
      throw responseTooLarge(provider);
    }
    return text;
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw responseTooLarge(provider);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function responseTooLarge(provider: string): EvalError {
  return new EvalError(
    "EVAL_PROVIDER_RESPONSE_TOO_LARGE",
    `${provider} response exceeded ${MAX_PROVIDER_RESPONSE_BYTES} bytes`,
    { provider, maxBytes: MAX_PROVIDER_RESPONSE_BYTES }
  );
}
