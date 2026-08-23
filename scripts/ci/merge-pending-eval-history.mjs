import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  formatEvalHistoryJson,
  mergeEvalHistory,
  parseEvalHistoryBytes,
  readEvalHistory
} from "../../packages/evals/dist/index.js";

const ref = process.argv[2];
if (!ref) throw new Error("usage: merge-pending-eval-history.mjs <git-ref>");

const root = process.cwd();
const historyRelativePath = "benchmarks/ultrafuzzbench/history.json";
const historyPath = path.join(root, historyRelativePath);
const pendingText = execFileSync("git", ["show", `${ref}:${historyRelativePath}`], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"]
});

const current = readEvalHistory(historyPath);
const pending = parseEvalHistoryBytes(Buffer.from(pendingText, "utf8"), `${ref}:${historyRelativePath}`);
const merged = mergeEvalHistory(current, pending.observations);
fs.writeFileSync(historyPath, formatEvalHistoryJson(merged), "utf8");
process.stdout.write(`Preserved ${merged.observations.length - current.observations.length} pending observations.\n`);
