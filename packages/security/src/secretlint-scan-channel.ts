/**
 * Shared-memory layout of the synchronous secret-scanning bridge. One request
 * is in flight at a time (the requesting side is synchronous), so a single
 * length-prefixed payload region carries the request text in one direction and
 * the findings JSON back in the other.
 */

/** Int32 slot counting scan requests issued by the requesting thread. */
export const SCAN_REQUEST_SLOT = 0;
/** Int32 slot counting scan responses completed by the worker. */
export const SCAN_RESPONSE_SLOT = 1;
export const SCAN_SIGNAL_BYTES = 8;

const PAYLOAD_LENGTH_BYTES = 4;
/**
 * Initial payload capacity. The buffer grows on demand up to the maximum, and
 * growth only reserves virtual address space until pages are touched.
 */
export const SCAN_CHANNEL_INITIAL_BYTES = 1 << 16;
/**
 * Publication-gate artifacts are capped at 16MB of bytes, which decode to at
 * most 16M UTF-16 code units and re-encode to at most 3 bytes each; 256MB
 * covers any text a caller can realistically hand the redaction API.
 */
export const SCAN_CHANNEL_MAX_BYTES = 1 << 28;

const utf8Decoder = new TextDecoder();
const utf8Encoder = new TextEncoder();

export function createScanChannelBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(SCAN_CHANNEL_INITIAL_BYTES, { maxByteLength: SCAN_CHANNEL_MAX_BYTES });
}

/**
 * Write one length-prefixed UTF-8 payload. UTF-8 round-tripping preserves
 * code-unit counts even for ill-formed strings (a lone surrogate decodes back
 * as one replacement code unit), so finding ranges computed by the worker
 * stay valid offsets into the requester's original string.
 */
export function writeScanChannelPayload(data: SharedArrayBuffer, payload: string): void {
  const encoded = utf8Encoder.encode(payload);
  const required = PAYLOAD_LENGTH_BYTES + encoded.byteLength;
  if (required > data.maxByteLength) {
    throw new Error(`scan payload of ${encoded.byteLength} bytes exceeds the ${data.maxByteLength}-byte channel`);
  }
  if (required > data.byteLength) data.grow(required);
  new Uint8Array(data).set(encoded, PAYLOAD_LENGTH_BYTES);
  new DataView(data, 0, PAYLOAD_LENGTH_BYTES).setUint32(0, encoded.byteLength, true);
}

export function readScanChannelPayload(data: SharedArrayBuffer): string {
  const length = new DataView(data, 0, PAYLOAD_LENGTH_BYTES).getUint32(0, true);
  // TextDecoder refuses shared memory; copy the payload out first.
  const copy = new Uint8Array(length);
  copy.set(new Uint8Array(data).subarray(PAYLOAD_LENGTH_BYTES, PAYLOAD_LENGTH_BYTES + length));
  return utf8Decoder.decode(copy);
}
