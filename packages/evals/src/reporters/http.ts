import { EvalError } from "../utils.js";

export const PROVIDER_REQUEST_TIMEOUT_MS = 30_000;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

export function trustedProviderOrigin(
  configured: string | undefined,
  expected: string,
  trustedCustom: string | undefined,
  provider: string
): string {
  const value = configured ?? expected;
  const parsed = parseHttpsOrigin(value, provider);
  const expectedOrigin = new URL(expected).origin;
  if (parsed.origin !== expectedOrigin) {
    const trustedOrigin = trustedCustom === undefined ? undefined : parseHttpsOrigin(trustedCustom, provider).origin;
    if (trustedOrigin === parsed.origin) {
      return parsed.origin;
    }
    throw new EvalError(
      "EVAL_PROVIDER_ENDPOINT_UNTRUSTED",
      `${provider} endpoint ${parsed.origin} is not the canonical origin ${expectedOrigin} and was not explicitly trusted by the operator`,
      { provider, configuredOrigin: parsed.origin, expectedOrigin }
    );
  }
  return expectedOrigin;
}

function parseHttpsOrigin(value: string, provider: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new EvalError("EVAL_PROVIDER_ENDPOINT_INVALID", `${provider} endpoint must be a valid HTTPS origin`, {
      provider
    });
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new EvalError(
      "EVAL_PROVIDER_ENDPOINT_INVALID",
      `${provider} endpoint must be an HTTPS origin without credentials, path, query, or fragment`,
      { provider }
    );
  }
  return parsed;
}

export async function boundedProviderResponseText(response: Response, provider: string): Promise<string> {
  return boundedResponseText(response, provider, "EVAL_PROVIDER_RESPONSE_TOO_LARGE");
}

export async function boundedProviderResponseBytes(response: Response, provider: string): Promise<Buffer> {
  return boundedResponseBytes(response, provider, "EVAL_PROVIDER_RESPONSE_TOO_LARGE");
}

export async function boundedResponseText(
  response: Response,
  label: string,
  errorCode: string,
  maxBytes = MAX_PROVIDER_RESPONSE_BYTES
): Promise<string> {
  return (await boundedResponseBytes(response, label, errorCode, maxBytes)).toString("utf8");
}

export async function boundedResponseBytes(
  response: Response,
  label: string,
  errorCode: string,
  maxBytes = MAX_PROVIDER_RESPONSE_BYTES
): Promise<Buffer> {
  const declaredLength = response.headers?.get?.("content-length");
  if (declaredLength !== null && declaredLength !== undefined) {
    const declaredBytes = Number(declaredLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      await response.body?.cancel();
      throw responseTooLarge(label, errorCode, maxBytes);
    }
  }

  if (response.body === null || response.body === undefined || typeof response.body.getReader !== "function") {
    const text = await response.text();
    const bytes = Buffer.from(text, "utf8");
    if (bytes.byteLength > maxBytes) {
      throw responseTooLarge(label, errorCode, maxBytes);
    }
    return bytes;
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
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw responseTooLarge(label, errorCode, maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    totalBytes
  );
}

function responseTooLarge(label: string, code: string, maxBytes: number): EvalError {
  return new EvalError(code, `${label} response exceeded ${maxBytes} bytes`, { label, maxBytes });
}
