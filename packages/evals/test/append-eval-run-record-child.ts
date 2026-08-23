import fs from "node:fs";

import { appendEvalRunRecord } from "../src/eval-durable.js";
import type { EvalRunRecord } from "../src/types.js";

const [journalPath, readyPath, gatePath, contendingPath, encodedRecord] = process.argv.slice(2);
if (
  journalPath === undefined ||
  readyPath === undefined ||
  gatePath === undefined ||
  contendingPath === undefined ||
  encodedRecord === undefined
) {
  throw new Error("append child requires journal, ready, gate, contending, and record arguments");
}

const waiter = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const deadline = Date.now() + 20_000;
fs.writeFileSync(readyPath, "", { flag: "wx" });
while (!fs.existsSync(gatePath)) {
  if (Date.now() >= deadline) throw new Error("append child timed out waiting for the contention gate");
  Atomics.wait(waiter, 0, 0, 10);
}
fs.writeFileSync(contendingPath, "", { flag: "wx" });

const record = JSON.parse(Buffer.from(encodedRecord, "base64url").toString("utf8")) as EvalRunRecord;
appendEvalRunRecord(journalPath, record);
