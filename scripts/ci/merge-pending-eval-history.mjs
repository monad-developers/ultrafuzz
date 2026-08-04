import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  formatEvalHistoryJson,
  mergeEvalHistory,
  parseEvalHistory,
  readEvalHistory
} from "../../packages/evals/dist/index.js";

const ref = process.argv[2];
if (!ref) throw new Error("usage: merge-pending-eval-history.mjs <git-ref>");

const root = process.cwd();
const historyPath = path.join(root, "benchmarks", "history.json");
const pendingText = execFileSync("git", ["show", `${ref}:benchmarks/history.json`], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"]
});

const current = readEvalHistory(historyPath);
const pending = parseEvalHistory(JSON.parse(pendingText), `${ref}:benchmarks/history.json`);
const merged = mergeEvalHistory(current, pending.observations);
fs.writeFileSync(historyPath, formatEvalHistoryJson(merged), "utf8");
process.stdout.write(`Preserved ${merged.observations.length - current.observations.length} pending observations.\n`);
