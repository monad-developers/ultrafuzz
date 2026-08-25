import { Worker } from "node:worker_threads";

import {
  createScanChannelBuffer,
  readScanChannelPayload,
  SCAN_REQUEST_SLOT,
  SCAN_RESPONSE_SLOT,
  SCAN_SIGNAL_BYTES,
  writeScanChannelPayload
} from "./secretlint-scan-channel.js";

/**
 * One secretlint finding, as UTF-16 code-unit offsets into the scanned text.
 * Ranges come straight from the library so redaction callers can rewrite the
 * exact matched span.
 */
export interface VendorSecretFinding {
  readonly start: number;
  readonly end: number;
  readonly ruleId: string;
}

interface ScanResponsePayload {
  findings?: VendorSecretFinding[];
  error?: string;
}

interface ScannerSession {
  worker: Worker;
  state: Int32Array;
  data: SharedArrayBuffer;
}

/**
 * A scan is a handful of regex passes over the text; this budget only exists
 * so a worker that died or never booted fails the caller closed instead of
 * blocking it forever.
 */
const SCAN_TIMEOUT_MS = 30_000;
/**
 * The shortest text any preset rule or supplemental pattern can match (a
 * minimal Slack token, `xoxb-1-1`). Shorter inputs skip the cross-thread
 * round trip entirely.
 */
const MIN_SCANNABLE_LENGTH = 8;

let session: ScannerSession | undefined;

function ensureScannerSession(): ScannerSession {
  if (session !== undefined) return session;
  const signal = new SharedArrayBuffer(SCAN_SIGNAL_BYTES);
  const data = createScanChannelBuffer();
  const worker = new Worker(new URL("./secretlint-scan-worker.js", import.meta.url), {
    workerData: { signal, data },
    // Never inherit eval/loader flags ("node -e", test runners): they are
    // meant for the parent's entry point and can break the worker's boot,
    // which this synchronous bridge could only surface as a timeout.
    execArgv: []
  });
  // The scanner must never keep an otherwise-finished process alive.
  worker.unref();
  session = { worker, state: new Int32Array(signal), data };
  return session;
}

function failScannerSession(reason: string): never {
  if (session !== undefined) {
    void session.worker.terminate();
    session = undefined;
  }
  // Deliberately an exception, not an empty result: a scanner that cannot run
  // must stop the caller (the publication gate fails closed; redaction paths
  // surface a loud error) instead of silently passing text through unscanned.
  throw new Error(`sensitive-data scan could not complete: ${reason}`);
}

/**
 * Scan text for positively identified vendor-format credentials using
 * secretlint (@secretlint/core with the recommended preset) and return the
 * findings with their match ranges.
 *
 * secretlint's programmatic API is asynchronous while every caller of the
 * redaction and publication-gate functions is synchronous — including the
 * generated Smithers workflow verifier, whose emitted code is pinned by
 * contract tests. The library therefore runs on a dedicated worker thread,
 * request text and findings travel through shared memory, and this function
 * blocks until the worker advances the response sequence, keeping the whole
 * public API of this package synchronous and the scan fully in-process.
 */
export function scanTextForVendorSecrets(text: string): readonly VendorSecretFinding[] {
  if (text.length < MIN_SCANNABLE_LENGTH) return [];
  const { state, data } = ensureScannerSession();
  try {
    writeScanChannelPayload(data, text);
  } catch (error) {
    failScannerSession(error instanceof Error ? error.message : String(error));
  }
  const expected = Atomics.add(state, SCAN_REQUEST_SLOT, 1) + 1;
  Atomics.notify(state, SCAN_REQUEST_SLOT);
  const deadline = Date.now() + SCAN_TIMEOUT_MS;
  for (;;) {
    const completed = Atomics.load(state, SCAN_RESPONSE_SLOT);
    if (completed >= expected) break;
    const remaining = deadline - Date.now();
    // Terminating the timed-out session is required for correctness, not just
    // hygiene: a still-running worker could later write its stale response
    // over this channel while a fresh request is being written.
    if (remaining <= 0) failScannerSession(`scan worker did not respond within ${SCAN_TIMEOUT_MS}ms`);
    Atomics.wait(state, SCAN_RESPONSE_SLOT, completed, remaining);
  }
  const payload = JSON.parse(readScanChannelPayload(data)) as ScanResponsePayload;
  if (payload.error !== undefined || payload.findings === undefined) {
    failScannerSession(payload.error ?? "scan worker returned no findings");
  }
  return payload.findings;
}
