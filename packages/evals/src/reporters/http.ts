import { EvalError } from "../utils.js";

const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

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
