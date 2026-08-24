import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const CANONICAL_TARGET_IDS = ["stableswap-ng-vyper", "venus-isolated-pools-hardhat", "very-liquid-vaults-foundry"];
const COMPLETENESS_FIELDS = ["nodes", "lineage", "concurrency_evidence", "plan_evidence"];
const NODE_STATUSES = [
  "pending",
  "ready",
  "runnable",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "timed-out",
  "reused-from-prior-run",
  "invalidated"
];
const SUCCESSFUL_NODE_STATUSES = new Set(["succeeded", "reused-from-prior-run"]);
const REQUIRED_ROW_ARTIFACTS = [
  ["threat-model", "THREAT_MODEL.md", "markdown"],
  ["threat-model", "threat-model.json", "json"],
  ["goal-plan", "goal-plan.json", "json"],
  ["goal-plan", "vulnerability-db-manifest.json", "json"]
];

/**
 * Validate the structural claims made by the opt-in threat-model gate.
 *
 * Quality, cost, retry, token and wall-clock values deliberately remain
 * telemetry. The checks here are limited to whether the production fanout ran,
 * matched the planner-owned expectation from #373, retained its reviewable
 * evidence and preserved independently attributable goal lanes.
 */
export function validateThreatModelBenchmarkGate(manifestValue, pairBundles) {
  const manifest = record(manifestValue, "threat-model benchmark manifest");
  if (manifest.mode !== "threat-model" || manifest.benchmark !== "ultrafuzz-bench") {
    throw new Error("threat-model gate requires the threat-model Ultrafuzz-bench manifest");
  }
  if (typeof manifest.candidate_commit !== "string" || !FULL_COMMIT.test(manifest.candidate_commit)) {
    throw new Error("threat-model gate manifest has an invalid candidate commit");
  }
  const targets = manifestTargets(manifest.targets);
  const targetIds = [...targets.keys()].sort();
  if (JSON.stringify(targetIds) !== JSON.stringify(CANONICAL_TARGET_IDS)) {
    throw new Error("threat-model gate must use exactly the three canonical Ultrafuzz-bench targets");
  }
  if (manifest.matrix_rows_per_pair !== targets.size) {
    throw new Error("threat-model gate manifest must schedule one row per canonical target");
  }
  const concurrency = record(manifest.concurrency, "threat-model gate concurrency");
  const requestedConcurrency = positiveInteger(
    concurrency.max_parallel_workflow_nodes_per_row,
    "threat-model gate requested workflow concurrency"
  );
  if (requestedConcurrency < 2) {
    throw new Error("threat-model gate requested workflow concurrency must exceed one");
  }
  if (!Array.isArray(manifest.pairs) || manifest.pairs.length !== 1) {
    throw new Error("threat-model gate must contain exactly one checked-in runner pair");
  }
  if (!Array.isArray(pairBundles) || pairBundles.length !== 1) {
    throw new Error("threat-model gate must provide exactly one collected runner bundle");
  }
  const pair = manifestPair(manifest.pairs[0]);
  const supplied = record(pairBundles[0], "threat-model gate pair bundle");
  if (supplied.pair !== pair.pair) throw new Error("threat-model gate bundle does not match its manifest pair");
  const bundle = record(supplied.bundle, `threat-model gate bundle ${pair.pair}`);
  validateBundleIdentity(bundle, manifest, pair, targets);
  const files = verifiedBundleFiles(bundle.files);
  const summary = jsonBundleFile(files, "eval/summary.json");
  const rows = summaryRows(summary, targetIds);
  for (const row of rows) {
    validateRowArtifacts(files, row.row_id);
    validateRowExpansion(row, requestedConcurrency);
  }
  return {
    pair_count: 1,
    target_count: targets.size,
    row_count: rows.length,
    expected_dynamic_child_count: rows.reduce((total, row) => total + row.expansion.plan.expected_child_count, 0)
  };
}

export function validateThreatModelBenchmarkGateFiles(manifestPath, resultsRoot) {
  const manifest = readJsonRegular(manifestPath, MAX_MANIFEST_BYTES, "threat-model benchmark manifest");
  const pairs = Array.isArray(manifest?.pairs) ? manifest.pairs : [];
  const root = path.resolve(resultsRoot);
  const pairBundles = pairs.map((value, index) => {
    const pair = manifestPair(value, index);
    const bundlePath = regularFileInside(
      root,
      [pair.pair, pair.model_slug, "public-results.json"],
      MAX_BUNDLE_BYTES,
      `threat-model gate bundle ${pair.pair}`
    );
    return { pair: pair.pair, bundle: readJsonRegular(bundlePath, MAX_BUNDLE_BYTES, `bundle ${pair.pair}`) };
  });
  return validateThreatModelBenchmarkGate(manifest, pairBundles);
}

function manifestTargets(value) {
  if (!Array.isArray(value) || value.length !== CANONICAL_TARGET_IDS.length) {
    throw new Error("threat-model gate manifest must contain three targets");
  }
  const targets = new Map();
  for (const [index, entry] of value.entries()) {
    const target = record(entry, `threat-model gate target ${index}`);
    const id = safeId(target.id, `threat-model gate target ${index} ID`);
    if (
      typeof target.repository !== "string" ||
      !target.repository.startsWith("https://github.com/") ||
      typeof target.revision !== "string" ||
      !FULL_COMMIT.test(target.revision) ||
      typeof target.framework !== "string" ||
      !SAFE_ID.test(target.framework)
    ) {
      throw new Error(`threat-model gate target ${id} has invalid immutable identity`);
    }
    if (targets.has(id)) throw new Error(`threat-model gate repeats target ${id}`);
    targets.set(id, {
      id,
      repository: target.repository,
      revision: target.revision,
      framework: target.framework
    });
  }
  return targets;
}

function manifestPair(value, index = 0) {
  const pair = record(value, `threat-model gate pair ${index}`);
  const pairId = safeId(pair.pair, `threat-model gate pair ${index} ID`);
  const modelSlug = safeId(pair.model_slug, `threat-model gate pair ${index} model slug`);
  if (
    pair.mode !== "threat-model" ||
    pair.lane !== "threat-model" ||
    pair.benchmark !== "ultrafuzz-bench" ||
    pair.provider !== "openai" ||
    !modelSlug.startsWith("benchmark-threat-model-")
  ) {
    throw new Error("threat-model gate pair does not use its checked-in OpenAI runner profile");
  }
  return { pair: pairId, model_slug: modelSlug };
}

function validateBundleIdentity(bundle, manifest, pair, targets) {
  if (
    bundle.status !== "succeeded" ||
    bundle.benchmark !== "ultrafuzz-bench" ||
    bundle.lane !== "threat-model" ||
    bundle.model_slug !== pair.model_slug ||
    bundle.model !== "gpt-5.6-luna" ||
    bundle.reasoning !== "high" ||
    bundle.candidate_commit !== manifest.candidate_commit
  ) {
    throw new Error("threat-model gate bundle does not represent a successful pinned Luna/high run");
  }
  if (
    bundle.executed_case_count !== targets.size ||
    bundle.graded_case_count !== targets.size ||
    !Array.isArray(bundle.targets) ||
    bundle.targets.length !== targets.size
  ) {
    throw new Error("threat-model gate bundle does not contain three executed and graded targets");
  }
  const seen = new Set();
  for (const entry of bundle.targets) {
    const target = record(entry, "threat-model gate bundle target");
    const expected = targets.get(target.id);
    if (
      expected === undefined ||
      seen.has(target.id) ||
      target.repository !== expected.repository ||
      target.revision !== expected.revision ||
      target.framework !== expected.framework ||
      target.status !== "succeeded"
    ) {
      throw new Error("threat-model gate bundle target identity or status does not match the manifest");
    }
    seen.add(target.id);
  }
}

function verifiedBundleFiles(value) {
  if (!Array.isArray(value)) throw new Error("threat-model gate bundle files must be an array");
  const files = new Map();
  for (const [index, entry] of value.entries()) {
    const file = record(entry, `threat-model gate bundle file ${index}`);
    if (typeof file.path !== "string" || file.path === "" || files.has(file.path)) {
      throw new Error("threat-model gate bundle contains an invalid or duplicate file path");
    }
    if (
      typeof file.contents_base64 !== "string" ||
      !Number.isSafeInteger(file.size_bytes) ||
      file.size_bytes < 0 ||
      typeof file.sha256 !== "string" ||
      !SHA256.test(file.sha256)
    ) {
      throw new Error(`threat-model gate bundle file ${file.path} has invalid integrity metadata`);
    }
    const contents = Buffer.from(file.contents_base64, "base64");
    if (
      contents.toString("base64") !== file.contents_base64 ||
      contents.byteLength !== file.size_bytes ||
      crypto.createHash("sha256").update(contents).digest("hex") !== file.sha256
    ) {
      throw new Error(`threat-model gate bundle file ${file.path} failed its integrity check`);
    }
    files.set(file.path, contents);
  }
  return files;
}

function summaryRows(summaryValue, expectedTargetIds) {
  const summary = record(summaryValue, "threat-model gate eval summary");
  if (!Array.isArray(summary.rows) || summary.rows.length !== expectedTargetIds.length) {
    throw new Error("threat-model gate eval summary must contain one row per canonical target");
  }
  const expected = new Set(expectedTargetIds);
  const seenTargets = new Set();
  const seenRows = new Set();
  return summary.rows.map((value, index) => {
    const row = record(value, `threat-model gate summary row ${index}`);
    const rowId = safeId(row.row_id, `threat-model gate summary row ${index} ID`);
    const targetId = safeId(row.target_id, `threat-model gate summary row ${index} target`);
    if (!expected.has(targetId) || seenTargets.has(targetId) || seenRows.has(rowId)) {
      throw new Error("threat-model gate eval summary has duplicate or unexpected row identity");
    }
    seenTargets.add(targetId);
    seenRows.add(rowId);
    return { ...row, row_id: rowId, target_id: targetId };
  });
}

function validateRowArtifacts(files, rowId) {
  for (const [producer, name, kind] of REQUIRED_ROW_ARTIFACTS) {
    const artifactPath = `reports/${rowId}/artifacts/${producer}/${name}`;
    const contents = files.get(artifactPath);
    if (contents === undefined || contents.byteLength === 0) {
      throw new Error(`threat-model gate row ${rowId} is missing retained artifact ${artifactPath}`);
    }
    if (kind === "json") {
      let value;
      try {
        value = JSON.parse(contents.toString("utf8"));
      } catch (error) {
        throw new Error(`threat-model gate retained artifact ${artifactPath} is not valid JSON`, { cause: error });
      }
      record(value, `threat-model gate retained artifact ${artifactPath}`);
    } else if (contents.toString("utf8").trim() === "") {
      throw new Error(`threat-model gate retained artifact ${artifactPath} is empty`);
    }
  }
}

function validateRowExpansion(row, requestedConcurrency) {
  const label = `threat-model gate row ${row.row_id}`;
  const expansion = record(row.expansion, `${label} expansion`);
  for (const field of COMPLETENESS_FIELDS) assertComplete(expansion[field], `${label} ${field}`);
  if (expansion.truncated !== false) throw new Error(`${label} expansion evidence is truncated`);
  const plan = record(expansion.plan, `${label} expansion plan`);
  const expected = positiveInteger(plan.expected_child_count, `${label} expected child count`);
  const maxDynamicNodes = positiveInteger(plan.max_dynamic_nodes, `${label} max dynamic nodes`);
  const laneCount = positiveInteger(plan.lane_count, `${label} goal lane count`);
  if (expected > maxDynamicNodes) throw new Error(`${label} expected child count exceeds its recorded limit`);
  const comparison = record(expansion.expected_vs_actual, `${label} expected-versus-actual expansion`);
  if (
    comparison.matches !== true ||
    comparison.delta !== 0 ||
    comparison.expected_child_count !== expected ||
    comparison.actual_dynamic_node_count !== expected ||
    expansion.dynamic_node_count !== expected
  ) {
    throw new Error(`${label} dynamic child count does not match the planner-owned expectation`);
  }
  if (!Array.isArray(expansion.dynamic_nodes) || expansion.dynamic_nodes.length !== expected) {
    throw new Error(`${label} does not expose every expected dynamic child`);
  }
  const dynamicIds = new Set();
  for (const value of expansion.dynamic_nodes) {
    const node = record(value, `${label} dynamic child`);
    if (
      typeof node.node_id !== "string" ||
      node.node_id === "" ||
      dynamicIds.has(node.node_id) ||
      typeof node.source_node_id !== "string" ||
      node.source_node_id === "" ||
      !SUCCESSFUL_NODE_STATUSES.has(node.status) ||
      node.timed_out !== false
    ) {
      throw new Error(`${label} has an incomplete, failed or unattributed dynamic child`);
    }
    dynamicIds.add(node.node_id);
  }
  if (!Array.isArray(expansion.goal_lanes) || expansion.goal_lanes.length !== laneCount) {
    throw new Error(`${label} does not expose every planner-owned goal lane`);
  }
  const laneIds = new Set();
  const observedLaneNodeIds = new Set();
  for (const value of expansion.goal_lanes) {
    const lane = record(value, `${label} goal lane`);
    if (typeof lane.lane_id !== "string" || lane.lane_id === "" || laneIds.has(lane.lane_id)) {
      throw new Error(`${label} has an invalid or duplicate goal lane`);
    }
    laneIds.add(lane.lane_id);
    const plannedIds = nonemptyUniqueStrings(lane.planned_node_ids, `${label} lane ${lane.lane_id} planned nodes`);
    const observedPlannedIds = nonemptyUniqueStrings(
      lane.observed_planned_node_ids,
      `${label} lane ${lane.lane_id} observed planned nodes`
    );
    const observedIds = nonemptyUniqueStrings(lane.observed_node_ids, `${label} lane ${lane.lane_id} observed nodes`);
    if (!sameStringSet(plannedIds, observedPlannedIds)) {
      throw new Error(`${label} lane ${lane.lane_id} did not resolve its exact planner-owned node set`);
    }
    if (observedIds.some((nodeId) => observedLaneNodeIds.has(nodeId))) {
      throw new Error(`${label} assigns one observed node to more than one goal lane`);
    }
    for (const nodeId of observedIds) observedLaneNodeIds.add(nodeId);
    if (
      lane.observed_node_count !== plannedIds.length ||
      observedIds.length !== plannedIds.length ||
      lane.failed !== false ||
      !Array.isArray(lane.failed_node_ids) ||
      lane.failed_node_ids.length !== 0 ||
      !Array.isArray(lane.timed_out_node_ids) ||
      lane.timed_out_node_ids.length !== 0
    ) {
      throw new Error(`${label} lane ${lane.lane_id} was not independently and successfully observed`);
    }
    assertSuccessfulStatusCounts(lane.status_counts, observedIds.length, `${label} lane ${lane.lane_id}`);
  }
  if ([...dynamicIds].some((nodeId) => !observedLaneNodeIds.has(nodeId))) {
    throw new Error(`${label} has a dynamic child outside its planner-owned goal lanes`);
  }
  const observedConcurrency = record(expansion.concurrency, `${label} observed concurrency`);
  const effective = positiveInteger(observedConcurrency.effective, `${label} effective concurrency`);
  nonnegativeInteger(observedConcurrency.ready_queue_depth, `${label} ready queue depth`);
  nonnegativeInteger(observedConcurrency.active_work, `${label} active work`);
  if (observedConcurrency.requested !== requestedConcurrency || effective > requestedConcurrency || effective < 2) {
    throw new Error(`${label} did not demonstrate independently scheduled dynamic work`);
  }
}

function assertComplete(value, label) {
  const evidence = record(value, label);
  if (evidence.status !== "complete" || evidence.reason !== null) {
    throw new Error(`${label} is not complete`);
  }
}

function assertSuccessfulStatusCounts(value, expectedCount, label) {
  const counts = record(value, `${label} status counts`);
  let total = 0;
  for (const status of NODE_STATUSES) {
    const count = nonnegativeInteger(counts[status], `${label} ${status} count`);
    if (!SUCCESSFUL_NODE_STATUSES.has(status) && count !== 0) {
      throw new Error(`${label} has non-successful node status ${status}`);
    }
    total += count;
  }
  if (total !== expectedCount) throw new Error(`${label} status counts do not match its observed nodes`);
}

function nonemptyUniqueStrings(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry === "")) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicates`);
  return value;
}

function sameStringSet(left, right) {
  const rightSet = new Set(right);
  return left.length === right.length && left.every((value) => rightSet.has(value));
}

function jsonBundleFile(files, filePath) {
  const contents = files.get(filePath);
  if (contents === undefined) throw new Error(`threat-model gate bundle is missing ${filePath}`);
  try {
    return JSON.parse(contents.toString("utf8"));
  } catch (error) {
    throw new Error(`threat-model gate bundle ${filePath} is not valid JSON`, { cause: error });
  }
}

function readJsonRegular(filePath, maxBytes, label) {
  const resolved = path.resolve(filePath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function regularFileInside(root, parts, maxBytes, label) {
  const resolved = path.resolve(root, ...parts);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
    throw new Error(`${label} escapes its results root`);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  return resolved;
}

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value;
}

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function main(args) {
  if (args.length !== 2) {
    throw new Error(
      "usage: validate-threat-model-benchmark-gate.mjs <benchmark-manifest.json> <benchmark-results-root>"
    );
  }
  const result = validateThreatModelBenchmarkGateFiles(args[0], args[1]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
