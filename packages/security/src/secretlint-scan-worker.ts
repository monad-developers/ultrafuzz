import { workerData } from "node:worker_threads";

import { lintSource } from "@secretlint/core";
import { rules as recommendedRules } from "@secretlint/secretlint-rule-preset-recommend";

import {
  readScanChannelPayload,
  SCAN_REQUEST_SLOT,
  SCAN_RESPONSE_SLOT,
  writeScanChannelPayload
} from "./secretlint-scan-channel.js";

/**
 * Worker side of the synchronous secret-scanning bridge. secretlint's public
 * API is Promise-based, but every redaction and publication-gate caller in
 * this codebase is synchronous, so the scan runs on this dedicated thread and
 * the requesting thread blocks until the response sequence advances. All data
 * moves through the shared buffers: MessagePort round trips are deliberately
 * not used because Node retains per-message state on a heavily reused port,
 * which measurably degraded a long-lived scanning session (95ms/scan after
 * 2000 messages against a flat 0.1ms here). See secretlint-scanner.ts for the
 * requesting side.
 */
interface ScanWorkerData {
  signal: SharedArrayBuffer;
  data: SharedArrayBuffer;
}

/**
 * The recommended preset's rules, registered individually. Scanned content is
 * agent-controlled, so the preset's filter-comments rule must be excluded: it
 * honors "secretlint-disable" comments inside the scanned text itself, which
 * would let contaminated output suppress its own findings and walk through
 * the fail-closed publication gate. (The preset creator ignores `disabled` on
 * child rules, so the exclusion has to happen at registration.)
 */
const scanRules = recommendedRules
  .filter((rule) => rule.meta.id !== "@secretlint/secretlint-rule-filter-comments")
  .map((rule) => ({ id: rule.meta.id, rule }));

const { signal, data } = workerData as ScanWorkerData;
const state = new Int32Array(signal);

async function scan(text: string): Promise<Array<{ start: number; end: number; ruleId: string }>> {
  const result = await lintSource({
    // The scanned text is artifact/diagnostic content, never a real file:
    // noPhysicFilePath keeps file-oriented rules (GCP .p12) off the disk.
    source: { filePath: "scanned-text.txt", content: text, ext: ".txt", contentType: "text" },
    options: {
      noPhysicFilePath: true,
      config: { rules: scanRules }
    }
  });
  return result.messages.map((message) => ({
    start: message.range[0],
    end: message.range[1],
    ruleId: message.ruleId
  }));
}

let handledRequests = 0;
for (;;) {
  const requested = Atomics.load(state, SCAN_REQUEST_SLOT);
  if (requested === handledRequests) {
    // Blocking this dedicated thread while idle is intentional; scan requests
    // are the only work it exists for, and process exit tears it down.
    Atomics.wait(state, SCAN_REQUEST_SLOT, requested);
    continue;
  }
  handledRequests = requested;
  let payload: string;
  try {
    payload = JSON.stringify({ findings: await scan(readScanChannelPayload(data)) });
  } catch (error) {
    payload = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
  }
  writeScanChannelPayload(data, payload);
  Atomics.add(state, SCAN_RESPONSE_SLOT, 1);
  Atomics.notify(state, SCAN_RESPONSE_SLOT);
}
