/** Read a Fetch response body without allowing a provider to force an unbounded allocation. */
export async function readBoundedResponseBytes(
  response: Response,
  maxBytes: number,
  label: string
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("response byte limit must be a non-negative safe integer");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)) {
      throw new Error(`${label} has an invalid Content-Length header`);
    }
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length > maxBytes) {
      throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
    }
  }
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const contents = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    contents.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return contents;
}
