import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertNoSymlinkComponents,
  assertRegularFileInside,
  parseStrictJsonBytes,
  readRegularFileSnapshot
} from "../../packages/artifacts/dist/index.js";
import { MODAL_BENCHMARK_CONTROL_MANIFEST_SCHEMA_ID, readModalDocument } from "../../packages/modal/dist/index.js";

import { automaticSmokeOperationalSoftFail } from "./describe-smoke-soft-fail.mjs";

const MAX_OUTCOME_BYTES = 16 * 1024;
const OUTCOME_KEYS = new Set([
  "pair",
  "terminal_status",
  "category",
  "collection_status",
  "diagnostic_collection_status"
]);

export function classifyModalBenchmarkPublication(controlRoot, resultsRoot, mode, eventName) {
  const control = existingDirectory(controlRoot, "benchmark control root");
  const results = existingDirectory(resultsRoot, "benchmark results root");
  const manifestPath = path.join(control, "manifest.json");
  assertRegularFileInside(control, manifestPath, "benchmark control manifest");
  const manifest = readModalDocument(manifestPath, MODAL_BENCHMARK_CONTROL_MANIFEST_SCHEMA_ID).value;
  if (manifest.mode !== mode) {
    throw new Error(`benchmark manifest mode ${manifest.mode} does not match publication mode ${mode}`);
  }

  const incompletePairs = [];
  for (const pair of manifest.pairs) {
    const outcome = readOutcome(control, pair.pair);
    const bundlePath = path.join(results, pair.pair, pair.model_slug, "public-results.json");
    const bundlePresent = regularFilePresent(results, bundlePath, `public benchmark bundle ${pair.pair}`);

    if (outcome.terminal_status === "succeeded") {
      if (
        outcome.category !== "succeeded" ||
        outcome.collection_status !== "succeeded" ||
        outcome.diagnostic_collection_status !== undefined
      ) {
        throw new Error(`successful Modal benchmark outcome ${pair.pair} has inconsistent collection status`);
      }
      if (!bundlePresent) {
        throw new Error(`successful Modal benchmark outcome ${pair.pair} is missing its public result bundle`);
      }
      continue;
    }

    if (!automaticSmokeOperationalSoftFail(mode, eventName, outcome)) {
      throw new Error(`Modal benchmark outcome ${pair.pair} is not eligible for a publication no-op`);
    }
    if (outcome.diagnostic_collection_status !== "succeeded" && outcome.diagnostic_collection_status !== "failed") {
      throw new Error(`incomplete Modal benchmark outcome ${pair.pair} lacks final diagnostic collection status`);
    }
    if (
      (outcome.category === "collection-failed" || outcome.category === "collection-timeout") &&
      outcome.collection_status !== "failed"
    ) {
      throw new Error(`incomplete Modal benchmark outcome ${pair.pair} has inconsistent collection status`);
    }
    if (
      outcome.category !== "collection-failed" &&
      outcome.category !== "collection-timeout" &&
      outcome.collection_status !== undefined
    ) {
      throw new Error(`incomplete Modal benchmark outcome ${pair.pair} has unexpected collection status`);
    }
    if (bundlePresent) {
      throw new Error(`incomplete Modal benchmark outcome ${pair.pair} unexpectedly has a public result bundle`);
    }
    incompletePairs.push(pair.pair);
  }

  return incompletePairs.length === 0
    ? { ready: true, reason: "every Modal benchmark pair has a collected public result bundle" }
    : {
        ready: false,
        reason: `automatic smoke publication skipped after operational soft-fail: ${incompletePairs.join(", ")}`
      };
}

function readOutcome(controlRoot, pairId) {
  const outcomePath = path.join(controlRoot, "outcomes", `${pairId}.json`);
  assertRegularFileInside(controlRoot, outcomePath, `Modal benchmark outcome ${pairId}`);
  const value = parseStrictJsonBytes(readRegularFileSnapshot(outcomePath, MAX_OUTCOME_BYTES), {
    maxBytes: MAX_OUTCOME_BYTES,
    maxDepth: 8,
    maxItems: 32,
    maxProperties: 32
  });
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Modal benchmark outcome ${pairId} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!OUTCOME_KEYS.has(key)) throw new Error(`Modal benchmark outcome ${pairId} contains unsupported field ${key}`);
  }
  if (
    value.pair !== pairId ||
    (value.terminal_status !== "succeeded" && value.terminal_status !== "failed") ||
    typeof value.category !== "string" ||
    !/^[a-z][a-z0-9-]{0,127}$/u.test(value.category) ||
    (value.collection_status !== undefined &&
      value.collection_status !== "succeeded" &&
      value.collection_status !== "failed") ||
    (value.diagnostic_collection_status !== undefined &&
      value.diagnostic_collection_status !== "succeeded" &&
      value.diagnostic_collection_status !== "failed")
  ) {
    throw new Error(`Modal benchmark outcome ${pairId} is malformed`);
  }
  return value;
}

function existingDirectory(value, label) {
  const absolute = path.resolve(value);
  const entry = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (entry === undefined || !entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  if (fs.realpathSync(absolute) !== absolute) throw new Error(`${label} must use its canonical path`);
  return absolute;
}

function regularFilePresent(root, filePath, label) {
  assertNoSymlinkComponents(root, filePath, label);
  const entry = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (entry === undefined) return false;
  assertRegularFileInside(root, filePath, label);
  return true;
}

function main(args) {
  if (args.length !== 5) {
    throw new Error(
      "usage: classify-modal-benchmark-publication.mjs <control-root> <results-root> <mode> <event> <github-output>"
    );
  }
  const [controlRoot, resultsRoot, mode, eventName, outputPath] = args;
  const result = classifyModalBenchmarkPublication(controlRoot, resultsRoot, mode, eventName);
  fs.appendFileSync(outputPath, `ready=${String(result.ready)}\n`);
  console.log(result.reason);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
