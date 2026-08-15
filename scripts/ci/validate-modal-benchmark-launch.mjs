import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadBenchmarkCohortManifest, loadBenchmarkLanesManifest } from "../../packages/evals/dist/index.js";
import { isPublicModalBenchmarkConfig, loadModalBenchmarkConfig } from "../../packages/modal/dist/config.js";
import { MODAL_BENCHMARK_CONTROL_MANIFEST_SCHEMA_ID } from "../../packages/modal/dist/modal-contracts.js";
import { readModalDocument } from "../../packages/modal/dist/modal-documents.js";
import {
  PUBLIC_BENCHMARK_EVAL_CLEANUP_SECONDS,
  PUBLIC_BENCHMARK_PREPARATION_TIMEOUT_SECONDS,
  PUBLIC_BENCHMARK_REPORT_TIMEOUT_SECONDS,
  PUBLIC_BENCHMARK_SCORE_PER_WAVE_TIMEOUT_SECONDS,
  publicBenchmarkMaxParallelEvalRows,
  publicBenchmarkMaxParallelWorkflowNodes,
  publicBenchmarkMaxRuntimeSeconds
} from "../../packages/modal/dist/public-worker.js";

import {
  validateAutomaticPairConfig,
  validateAutomaticPublicationManifest
} from "./prepare-eval-history-publication.mjs";

const MAX_CONTROL_FILE_BYTES = 1024 * 1024;
const SAFE_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const GENERATION = /^([1-9][0-9]*)-([1-9][0-9]*)$/u;
const PUBLIC_CONTROL_POLLING_GRACE_SECONDS = 5 * 60;

export function validateModalBenchmarkLaunch(input) {
  const manifestPath = path.resolve(input.manifestPath);
  const policyRoot = path.resolve(input.policyRoot);
  assertBoundedRegularFile(manifestPath, "Modal benchmark launch manifest");
  const rawManifest = readModalDocument(manifestPath, MODAL_BENCHMARK_CONTROL_MANIFEST_SCHEMA_ID).value;

  const mode = rawManifest.mode;
  if (mode !== "smoke" && mode !== "full") {
    throw new Error(`Modal benchmark launch manifest ${manifestPath} has invalid mode`);
  }
  if (input.expectedMode !== undefined && mode !== input.expectedMode) {
    throw new Error(
      `Modal benchmark launch manifest ${manifestPath} mode ${mode} does not match requested ${input.expectedMode}`
    );
  }

  const candidateCommit = gitOutput(policyRoot, ["rev-parse", "HEAD"], "benchmark policy HEAD");
  if (rawManifest.candidate_commit !== candidateCommit) {
    throw new Error(
      `Modal benchmark launch manifest ${manifestPath} candidate commit does not match the checked-out benchmark candidate`
    );
  }
  const dimensions = modalBenchmarkPolicyDimensions(
    policyRoot,
    mode,
    benchmarkRunnerProviderFromManifest(rawManifest, mode)
  );
  assertConfiguredTargetCoverage(rawManifest, manifestPath, dimensions);
  const [producerRunId, producerRunAttempt] = generationParts(rawManifest.generation, manifestPath);
  const manifest = validateAutomaticPublicationManifest(rawManifest, {
    candidateCommit,
    repository: rawManifest.repository,
    producerRunId,
    producerRunAttempt,
    mode,
    targets: dimensions.targets,
    targetIds: dimensions.targetIds,
    targetCount: dimensions.targetCount,
    trialsPerVariant: dimensions.trialsPerVariant,
    maxParallelEvalRows: dimensions.maxParallelEvalRows,
    maxParallelWorkflowNodes: dimensions.maxParallelWorkflowNodes,
    maxRuntimeSeconds: dimensions.maxRuntimeSeconds,
    controlTimeoutSeconds: dimensions.controlTimeoutSeconds
  });

  validatePairConfigs(manifest, path.dirname(manifestPath), manifestPath, dimensions);
  return {
    mode: manifest.mode,
    benchmark: manifest.benchmark,
    execution: manifest.execution,
    target_count: dimensions.targetCount,
    matrix_rows_per_pair: manifest.matrix_rows_per_pair,
    pair_count: manifest.pairs.length
  };
}

function assertConfiguredTargetCoverage(manifest, manifestPath, dimensions) {
  const scope = dimensions.mode === "smoke" ? "canonical smoke" : dimensions.mode;
  const actualTargetIds = new Set(manifest.targets.map((target) => target.id));
  const missingTargetIds = dimensions.targetIds.filter((targetId) => !actualTargetIds.has(targetId));
  if (missingTargetIds.length > 0) {
    throw new Error(
      `${scope} launch manifest ${manifestPath} is missing configured target(s) from ${dimensions.cohortPath}: ${missingTargetIds.join(", ")}`
    );
  }
  if (manifest.targets.length < dimensions.targetCount) {
    throw new Error(
      `${scope} launch manifest ${manifestPath} is missing configured target(s): expected ${dimensions.targetCount} target(s) from ${dimensions.cohortPath}, found ${manifest.targets.length}`
    );
  }
  if (manifest.matrix_rows_per_pair < dimensions.expectedMatrixRowsPerPair) {
    throw new Error(
      `${scope} launch manifest ${manifestPath} is missing target rows: expected at least ${dimensions.expectedMatrixRowsPerPair} matrix row(s) for ${dimensions.targetCount} configured target(s) from ${dimensions.cohortPath} and ${dimensions.lanesPath}, found ${manifest.matrix_rows_per_pair}`
    );
  }
}

function validatePairConfigs(manifest, controlRoot, manifestPath, dimensions) {
  if (!Array.isArray(manifest.pairs) || manifest.pairs.length === 0) {
    throw new Error(`Modal benchmark launch manifest ${manifestPath} contains no dispatch pairs`);
  }
  const seenPairs = new Set();
  const usedModelSlugs = new Set();
  for (const [index, pair] of manifest.pairs.entries()) {
    if (seenPairs.has(pair.pair)) {
      throw new Error(`Modal benchmark launch manifest ${manifestPath} duplicates dispatch pair ${pair.pair}`);
    }
    seenPairs.add(pair.pair);
    if (!SAFE_BASENAME.test(pair.config_path)) {
      throw new Error(`Modal benchmark launch manifest ${manifestPath} pair ${index} has an unsafe config path`);
    }
    const configPath = path.join(controlRoot, pair.config_path);
    assertBoundedRegularFile(configPath, `Modal benchmark launch config ${pair.config_path}`);
    const config = loadModalBenchmarkConfig(configPath);
    if (!isPublicModalBenchmarkConfig(config)) {
      throw new Error(
        `Modal benchmark launch config ${configPath} is local-only/private: expected public_benchmark for manifest ${manifestPath}`
      );
    }
    const configTargets = config.public_benchmark.targets;
    if (configTargets.length < dimensions.targetCount) {
      throw new Error(
        `Modal benchmark launch config ${configPath} is missing configured target(s) from manifest ${manifestPath}: expected ${dimensions.targetCount}, found ${configTargets.length}`
      );
    }
    if (JSON.stringify(configTargets) !== JSON.stringify(dimensions.targets)) {
      throw new Error(
        `Modal benchmark launch config ${configPath} target selection does not match benchmark config ${dimensions.cohortPath}; referenced by manifest ${manifestPath}`
      );
    }
    if (
      config.public_benchmark.benchmark !== pair.benchmark ||
      config.public_benchmark.lane !== pair.lane ||
      config.public_benchmark.runner_model_profile !== pair.model_slug
    ) {
      throw new Error(`Modal benchmark launch config ${configPath} does not match manifest ${manifestPath}`);
    }
    validateAutomaticPairConfig(
      config,
      config.models[0],
      pair,
      {
        candidateCommit: manifest.candidate_commit,
        repository: manifest.repository,
        generation: manifest.generation,
        mode: manifest.mode,
        benchmark: manifest.benchmark,
        targets: dimensions.targets,
        maxRuntimeSeconds: dimensions.maxRuntimeSeconds
      },
      usedModelSlugs
    );
  }
}

/**
 * Read the dispatched smoke runner provider back off a control manifest. The smoke lane
 * carries exactly one runner pair, and provider-specific request-rate limits (OpenRouter)
 * change how many eval rows and workflow nodes the lane may run at once. Every consumer of
 * `modalBenchmarkPolicyDimensions` has to derive that provider the same way, or a lane's
 * launch, cleanup, and publication guardrails would disagree about the trusted concurrency.
 */
export function benchmarkRunnerProviderFromManifest(rawManifest, mode) {
  if (mode !== "smoke") return undefined;
  const pairs = rawManifest?.pairs;
  if (!Array.isArray(pairs) || pairs.length !== 1) return undefined;
  const provider = pairs[0]?.provider;
  return typeof provider === "string" ? provider : undefined;
}

export function modalBenchmarkPolicyDimensions(policyRoot, mode, runnerProvider) {
  const benchmark = mode === "smoke" ? "ultrafuzz-bench" : "evmbench";
  const cohortPath = path.join(
    policyRoot,
    "benchmarks",
    benchmark === "evmbench" ? "evmbench" : "ultrafuzzbench",
    "cohort.json"
  );
  const lanesPath = path.join(policyRoot, "benchmarks", "ultrafuzzbench", "lanes.json");
  const cohort = loadBenchmarkCohortManifest(cohortPath);
  const lanes = loadBenchmarkLanesManifest(lanesPath);
  const selectedTargets =
    mode === "smoke"
      ? cohort.smoke_targets.map((id) => cohort.targets.find((target) => target.id === id))
      : cohort.targets;
  if (selectedTargets.some((target) => target === undefined)) {
    throw new Error(`Modal benchmark launch config ${cohortPath} contains an unknown selected target`);
  }
  const lane = lanes[mode];
  const targetCount = selectedTargets.length;
  const trialsPerVariant = lane.trials_per_variant;
  const expectedMatrixRowsPerPair = checkedProduct(targetCount, trialsPerVariant, "benchmark matrix row count");
  const maxParallelEvalRows = publicBenchmarkMaxParallelEvalRows(mode, runnerProvider);
  const maxRuntimeSeconds = publicBenchmarkMaxRuntimeSeconds(mode);
  const matrixWaves = Math.ceil(expectedMatrixRowsPerPair / maxParallelEvalRows);
  const targets = selectedTargets.map((target) => ({
    id: target.id,
    repository: target.repository,
    revision: target.revision,
    framework: target.framework
  }));
  return {
    mode,
    benchmark,
    cohortPath,
    lanesPath,
    targets,
    targetIds: targets.map((target) => target.id),
    targetCount,
    trialsPerVariant,
    expectedMatrixRowsPerPair,
    maxParallelEvalRows,
    maxParallelWorkflowNodes: publicBenchmarkMaxParallelWorkflowNodes(mode, runnerProvider),
    maxRuntimeSeconds,
    controlTimeoutSeconds:
      matrixWaves * maxRuntimeSeconds +
      PUBLIC_BENCHMARK_EVAL_CLEANUP_SECONDS +
      matrixWaves * PUBLIC_BENCHMARK_SCORE_PER_WAVE_TIMEOUT_SECONDS +
      PUBLIC_BENCHMARK_REPORT_TIMEOUT_SECONDS +
      PUBLIC_BENCHMARK_PREPARATION_TIMEOUT_SECONDS +
      PUBLIC_CONTROL_POLLING_GRACE_SECONDS
  };
}

function generationParts(value, manifestPath) {
  if (typeof value !== "string") {
    throw new Error(`Modal benchmark launch manifest ${manifestPath} generation is invalid`);
  }
  const match = GENERATION.exec(value);
  if (match === null) {
    throw new Error(`Modal benchmark launch manifest ${manifestPath} generation must be a GitHub run-attempt pair`);
  }
  return [match[1], match[2]];
}

function checkedProduct(left, right, label) {
  if (!Number.isSafeInteger(left) || left < 1 || !Number.isSafeInteger(right) || right < 1) {
    throw new Error(`${label} inputs are invalid`);
  }
  const product = left * right;
  if (!Number.isSafeInteger(product)) throw new Error(`${label} exceeds the safe integer range`);
  return product;
}

function assertBoundedRegularFile(filePath, label) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw new Error(`${label} ${filePath} is unavailable`, { cause: error });
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > MAX_CONTROL_FILE_BYTES) {
    throw new Error(`${label} ${filePath} must be a bounded regular file`);
  }
}

function gitOutput(cwd, args, label) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    throw new Error(`${label} is unavailable`, { cause: error });
  }
}

function main(args) {
  if (args.length !== 3) {
    throw new Error("usage: validate-modal-benchmark-launch.mjs <manifest> <policy-root> <smoke|full>");
  }
  const [manifestPath, policyRoot, expectedMode] = args;
  if (expectedMode !== "smoke" && expectedMode !== "full") throw new Error("expected mode must be smoke or full");
  console.log(JSON.stringify(validateModalBenchmarkLaunch({ manifestPath, policyRoot, expectedMode })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
