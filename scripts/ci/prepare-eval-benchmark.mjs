import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  adaptBenchmarkManifestToEvalSuite,
  evalSuiteInputDocument,
  loadBenchmarkCohortManifest,
  loadBenchmarkLanesManifest
} from "../../packages/evals/dist/index.js";
import { stringify } from "yaml";

const [benchmark, lane, output, targetRoot, runnerModelProfileId] = process.argv.slice(2);
if ((benchmark !== "evmbench" && benchmark !== "ultrafuzz-bench") || (lane !== "smoke" && lane !== "full")) {
  throw new Error(
    "usage: prepare-eval-benchmark.mjs <evmbench|ultrafuzz-bench> <smoke|full> <output> [target-root] [runner-model-profile-id]"
  );
}
if (!output) throw new Error("benchmark suite output path is required");

const root = process.cwd();
const cohort = loadBenchmarkCohortManifest(
  path.join(root, "benchmarks", benchmark === "evmbench" ? "evmbench-detect.json" : "ultrafuzz-bench.json")
);
const lanes = loadBenchmarkLanesManifest(path.join(root, "benchmarks", "lanes.json"));
const suite = adaptBenchmarkManifestToEvalSuite({
  benchmark,
  lane,
  cohort,
  lanes,
  ...(runnerModelProfileId === undefined ? {} : { runnerModelProfileId })
});
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(path.resolve(output), stringify(evalSuiteInputDocument(suite), { lineWidth: 120 }), "utf8");

if (targetRoot) {
  const cli = path.join(root, "packages", "cli", "dist", "index.js");
  for (const target of suite.targets) {
    const checkout = path.join(path.resolve(targetRoot), target.id);
    if (!fs.existsSync(checkout)) throw new Error(`missing prepared checkout for public target ${target.id}`);
    execFileSync(process.execPath, [cli, "init", "--project", checkout, "--force"], { stdio: "inherit" });
  }
}
