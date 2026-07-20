import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const AUTOMATIC_PUBLICATION_PLAN_SCHEMA_VERSION = "ultrafuzz.eval-history-automatic-publication-plan.v1";

const GENERATION_SCHEMA_VERSION = "ultrafuzz.eval-history-publication-generation.v1";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_POLICY_BYTES = 16 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_LOWER_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SAFE_REASONING = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u;
const ROOT_KEYS = [
  "candidate_commit",
  "repository",
  "generation",
  "mode",
  "benchmark",
  "image_name",
  "matrix_rows_per_pair",
  "control_timeout_seconds",
  "concurrency",
  "pairs"
];
const PAIR_KEYS = ["pair", "benchmark", "mode", "lane", "model_slug", "provider", "config_path", "state_path"];
const CONCURRENCY_KEYS = [
  "max_parallel_eval_rows_per_sandbox",
  "max_parallel_workflow_nodes_per_row",
  "max_live_runner_workflows_by_provider",
  "max_live_judge_rows"
];

export function validateAutomaticPublicationManifest(value, context) {
  const expected = publicationExpectations(context);
  const manifest = strictRecord(value, "benchmark manifest", ROOT_KEYS);
  if (manifest.candidate_commit !== expected.candidateCommit) {
    throw new Error("benchmark manifest candidate commit does not match the triggering workflow");
  }
  if (manifest.repository !== expected.repository) {
    throw new Error("benchmark manifest repository does not match the triggering workflow");
  }
  if (manifest.generation !== expected.generation) {
    throw new Error("benchmark manifest generation does not match the triggering workflow attempt");
  }
  if (manifest.mode !== expected.mode || manifest.benchmark !== expected.benchmark) {
    throw new Error("benchmark manifest mode or benchmark does not match the triggering workflow");
  }
  if (manifest.image_name !== `ufz-runner-${expected.candidateCommit}`) {
    throw new Error("benchmark manifest image name does not match the candidate commit");
  }
  if (manifest.matrix_rows_per_pair !== expected.matrixRowsPerPair) {
    throw new Error("benchmark manifest matrix row count does not match the trusted lane");
  }
  if (manifest.control_timeout_seconds !== expected.controlTimeoutSeconds) {
    throw new Error("benchmark manifest control timeout does not match the trusted lane");
  }
  validateConcurrency(manifest.concurrency, expected);
  if (!Array.isArray(manifest.pairs) || manifest.pairs.length !== expected.providers.length) {
    throw new Error("benchmark manifest pair count does not match the trusted lane");
  }

  const seenPairs = new Set();
  const seenModelSlugs = new Set();
  const seenConfigPaths = new Set();
  const seenStatePaths = new Set();
  const pairs = manifest.pairs.map((value, index) => {
    const pair = strictRecord(value, `benchmark pair ${index}`, PAIR_KEYS);
    const provider = expected.providers[index];
    if (pair.provider !== provider) {
      throw new Error(`benchmark pair ${index} provider does not match the trusted lane ordering`);
    }
    if (pair.benchmark !== expected.benchmark || pair.mode !== expected.mode || pair.lane !== expected.mode) {
      throw new Error(`benchmark pair ${index} scope does not match the trusted lane`);
    }
    const pairId = safeLowerId(pair.pair, `benchmark pair ${index} ID`);
    const modelSlug = safeLowerId(pair.model_slug, `benchmark pair ${index} model slug`);
    if (!modelSlug.startsWith(`benchmark-${expected.mode}-`)) {
      throw new Error(`benchmark pair ${index} model slug does not match the trusted lane`);
    }
    if (pairId !== `${expected.benchmark}-${modelSlug}`) {
      throw new Error(`benchmark pair ${index} ID does not match its benchmark and model slug`);
    }
    const configPath = safeBasename(pair.config_path, `benchmark pair ${index} config path`);
    const statePath = safeBasename(pair.state_path, `benchmark pair ${index} state path`);
    if (configPath !== `${pairId}.json` || statePath !== `${pairId}.state.json`) {
      throw new Error(`benchmark pair ${index} control paths do not match its pair ID`);
    }
    assertUnique(seenPairs, pairId, "benchmark pair ID");
    assertUnique(seenModelSlugs, modelSlug, "benchmark model slug");
    assertUnique(seenConfigPaths, configPath, "benchmark config path");
    assertUnique(seenStatePaths, statePath, "benchmark state path");
    return {
      pair: pairId,
      benchmark: expected.benchmark,
      mode: expected.mode,
      lane: expected.mode,
      model_slug: modelSlug,
      provider,
      config_path: configPath,
      state_path: statePath
    };
  });

  return {
    candidate_commit: expected.candidateCommit,
    repository: expected.repository,
    generation: expected.generation,
    mode: expected.mode,
    benchmark: expected.benchmark,
    image_name: manifest.image_name,
    matrix_rows_per_pair: expected.matrixRowsPerPair,
    control_timeout_seconds: expected.controlTimeoutSeconds,
    concurrency: manifest.concurrency,
    pairs
  };
}

export function readAutomaticPublicationManifest(filePath, context) {
  return validateAutomaticPublicationManifest(
    readJsonRegular(filePath, MAX_MANIFEST_BYTES, "benchmark manifest"),
    context
  );
}

export function validateBenchmarkPolicyFiles(input) {
  const candidateCommit = fullCommit(input.candidateCommit, "candidate commit");
  if (input.benchmark !== "evmbench" && input.benchmark !== "ultrafuzz-bench") {
    throw new Error("benchmark policy cohort must be evmbench or ultrafuzz-bench");
  }
  const policyRoot = regularDirectory(input.policyRoot, "benchmark policy root");
  const head = gitOutput(policyRoot, ["rev-parse", "HEAD"]);
  if (head !== candidateCommit) throw new Error("benchmark policy checkout does not match the candidate commit");
  if (gitOutput(policyRoot, ["status", "--porcelain=v1", "--untracked-files=no"]) !== "") {
    throw new Error("benchmark policy checkout has tracked modifications");
  }
  const cohortFile = input.benchmark === "evmbench" ? "evmbench-detect.json" : "ultrafuzz-bench.json";
  for (const relative of ["benchmarks/lanes.json", `benchmarks/${cohortFile}`]) {
    regularFileInside(policyRoot, relative, MAX_POLICY_BYTES, `benchmark policy ${relative}`);
  }
  return policyRoot;
}

export async function prepareAutomaticPublication(input) {
  const controlRoot = regularDirectory(input.controlRoot, "benchmark control root");
  const resultsRoot = regularDirectory(input.resultsRoot, "benchmark results root");
  const identity = publicationExpectations(input);
  const policyRoot = validateBenchmarkPolicyFiles({
    policyRoot: input.policyRoot,
    candidateCommit: identity.candidateCommit,
    benchmark: identity.benchmark
  });
  const [evalModule, configModule, bundleModule, workerModule, launchStateModule] = await Promise.all([
    import("../../packages/evals/dist/index.js"),
    import("../../packages/modal/dist/config.js"),
    import("../../packages/modal/dist/public-bundle.js"),
    import("../../packages/modal/dist/public-worker.js"),
    import("../../packages/modal/dist/launch-state.js")
  ]);
  const context = publicationExpectations({
    ...input,
    ...benchmarkPolicyDimensions(policyRoot, identity, evalModule, workerModule)
  });
  const manifestPath = regularFileInside(controlRoot, "manifest.json", MAX_MANIFEST_BYTES, "benchmark manifest");
  const manifest = readAutomaticPublicationManifest(manifestPath, context);
  const { loadModalBenchmarkConfig, fingerprintModalConfigFile, fingerprintModalModel } = configModule;
  const sourceFingerprint = launchStateModule.fingerprintTrackedSource(policyRoot);
  const usedModelSlugs = new Set();
  const evalRunIds = new Set();
  const pairs = [];
  for (const pair of manifest.pairs) {
    const configPath = regularFileInside(
      controlRoot,
      pair.config_path,
      MAX_CONFIG_BYTES,
      `benchmark config ${pair.config_path}`
    );
    const config = loadModalBenchmarkConfig(configPath);
    if (!("public_benchmark" in config)) throw new Error(`benchmark config ${pair.config_path} is not public`);
    const model = config.models[0];
    if (model === undefined || config.models.length !== 1) {
      throw new Error(`benchmark config ${pair.config_path} must contain exactly one model`);
    }
    validateAutomaticPairConfig(config, model, pair, context, usedModelSlugs);
    const bundleRelativePath = `${pair.pair}/${pair.model_slug}/public-results.json`;
    const bundlePath = regularFileInside(
      resultsRoot,
      bundleRelativePath,
      bundleModule.MAX_PUBLIC_BENCHMARK_BUNDLE_BYTES,
      `public benchmark bundle ${pair.pair}`
    );
    const bundle = bundleModule.readPublicBenchmarkBundle(bundlePath);
    const expectedEvalRunId = workerModule.publicEvalRunId(config.run_id, model.slug);
    const mismatches = [
      bundle.benchmark === context.benchmark ? undefined : "benchmark",
      bundle.lane === context.mode ? undefined : "lane",
      bundle.model_slug === model.slug ? undefined : "model slug",
      bundle.model === model.model ? undefined : "model",
      bundle.reasoning === model.reasoning ? undefined : "reasoning",
      bundle.candidate_commit === context.candidateCommit ? undefined : "candidate commit",
      bundle.eval_run_id === expectedEvalRunId ? undefined : "eval run",
      bundle.lineage.logical_run_id === config.run_id ? undefined : "logical run",
      bundle.lineage.generation === 1 ? undefined : "launch generation",
      bundle.lineage.config_fingerprint === fingerprintModalConfigFile(configPath) ? undefined : "config fingerprint",
      bundle.lineage.source_fingerprint === sourceFingerprint ? undefined : "source fingerprint",
      bundle.lineage.model_fingerprint === fingerprintModalModel(model) ? undefined : "model fingerprint"
    ].filter((entry) => entry !== undefined);
    if (mismatches.length > 0) {
      throw new Error(`public benchmark bundle ${pair.pair} has mismatched ${mismatches.join(", ")}`);
    }
    if (!Number.isSafeInteger(bundle.lineage.attempt) || bundle.lineage.attempt < 1 || bundle.lineage.attempt > 3) {
      throw new Error(`public benchmark bundle ${pair.pair} has an invalid launch attempt`);
    }
    assertBundleMatrixCount(bundle, context.matrixRowsPerPair, pair.pair);
    assertUnique(evalRunIds, bundle.eval_run_id, "public eval run ID");
    pairs.push({
      pair: pair.pair,
      provider: pair.provider,
      model_slug: pair.model_slug,
      bundle_path: bundleRelativePath,
      unpack_path: pair.pair,
      eval_run_id: bundle.eval_run_id,
      benchmark: context.benchmark,
      lane: context.mode
    });
  }

  const sourceArtifact = `${context.repository}/actions/runs/${context.producerRunId}`;
  const generation = {
    schema_version: GENERATION_SCHEMA_VERSION,
    candidate_commit: context.candidateCommit,
    candidate_repository_url: context.repository,
    source_artifact: sourceArtifact,
    runs: pairs.map((pair) => ({
      eval_run_id: pair.eval_run_id,
      benchmark: pair.benchmark,
      lane: pair.lane,
      input_path: `${pair.unpack_path}/eval`
    }))
  };
  const plan = {
    schema_version: AUTOMATIC_PUBLICATION_PLAN_SCHEMA_VERSION,
    candidate_commit: context.candidateCommit,
    candidate_repository_url: context.repository,
    source_artifact: sourceArtifact,
    producer_run_id: context.producerRunId,
    producer_run_attempt: context.producerRunAttempt,
    mode: context.mode,
    benchmark: context.benchmark,
    pairs
  };
  writeJsonExclusive(input.generationPath, generation, "publication generation");
  writeJsonExclusive(input.planPath, plan, "automatic publication plan");
  return { generation, plan };
}

function publicationExpectations(input) {
  const candidateCommit = fullCommit(input.candidateCommit, "candidate commit");
  const repository = canonicalRepository(input.repository);
  const producerRunId = positiveDecimal(input.producerRunId, "producer run ID");
  const producerRunAttempt = positiveDecimal(input.producerRunAttempt, "producer run attempt");
  if (input.mode !== "smoke" && input.mode !== "full") throw new Error("benchmark mode must be smoke or full");
  const smoke = input.mode === "smoke";
  const targetCount = positiveSafeInteger(input.targetCount ?? (smoke ? 3 : 40), "benchmark target count");
  const trialsPerVariant = positiveSafeInteger(input.trialsPerVariant ?? 1, "benchmark trials per variant");
  const matrixRowsPerPair = checkedProduct(targetCount, trialsPerVariant, "benchmark matrix row count");
  const maxParallelEvalRows = positiveSafeInteger(
    input.maxParallelEvalRows ?? (smoke ? 2 : 20),
    "maximum parallel eval rows"
  );
  const maxParallelWorkflowNodes = positiveSafeInteger(
    input.maxParallelWorkflowNodes ?? 8,
    "maximum parallel workflow nodes"
  );
  const controlTimeoutSeconds = positiveSafeInteger(
    input.controlTimeoutSeconds ?? defaultControlTimeoutSeconds(matrixRowsPerPair, maxParallelEvalRows),
    "benchmark control timeout"
  );
  const maxLiveRowsPerPair = Math.min(matrixRowsPerPair, maxParallelEvalRows);
  const providers = smoke ? ["openai"] : ["openai", "anthropic"];
  return {
    candidateCommit,
    repository,
    producerRunId,
    producerRunAttempt,
    generation: `${producerRunId}-${producerRunAttempt}`,
    mode: input.mode,
    benchmark: smoke ? "ultrafuzz-bench" : "evmbench",
    providers,
    targetCount,
    trialsPerVariant,
    matrixRowsPerPair,
    controlTimeoutSeconds,
    maxParallelEvalRows,
    maxParallelWorkflowNodes,
    maxLiveRowsPerPair,
    maxLiveJudgeRows: checkedProduct(providers.length, maxLiveRowsPerPair, "maximum live judge rows")
  };
}

function validateConcurrency(value, expected) {
  const concurrency = strictRecord(value, "benchmark concurrency", CONCURRENCY_KEYS);
  if (
    concurrency.max_parallel_eval_rows_per_sandbox !== expected.maxParallelEvalRows ||
    concurrency.max_parallel_workflow_nodes_per_row !== expected.maxParallelWorkflowNodes ||
    concurrency.max_live_judge_rows !== expected.maxLiveJudgeRows
  ) {
    throw new Error("benchmark manifest concurrency does not match the trusted lane");
  }
  const providerConcurrency = strictRecord(
    concurrency.max_live_runner_workflows_by_provider,
    "benchmark provider concurrency",
    expected.providers
  );
  for (const provider of expected.providers) {
    if (providerConcurrency[provider] !== expected.maxLiveRowsPerPair) {
      throw new Error(`benchmark manifest ${provider} concurrency does not match the trusted lane`);
    }
  }
}

function benchmarkPolicyDimensions(policyRoot, identity, evalModule, workerModule) {
  const cohortPath = path.join(
    policyRoot,
    "benchmarks",
    identity.benchmark === "evmbench" ? "evmbench-detect.json" : "ultrafuzz-bench.json"
  );
  const cohort = evalModule.loadBenchmarkCohortManifest(cohortPath);
  const lanes = evalModule.loadBenchmarkLanesManifest(path.join(policyRoot, "benchmarks", "lanes.json"));
  if (
    (identity.benchmark === "evmbench" && cohort.schema_version !== evalModule.EVMBENCH_COHORT_SCHEMA_VERSION) ||
    (identity.benchmark === "ultrafuzz-bench" &&
      cohort.schema_version !== evalModule.ULTRAFUZZ_BENCH_COHORT_SCHEMA_VERSION)
  ) {
    throw new Error(`benchmark policy cohort schema does not match ${identity.benchmark}`);
  }
  const selectedTargets =
    identity.mode === "smoke"
      ? cohort.smoke_targets.map((id) => cohort.targets.find((target) => target.id === id))
      : cohort.targets;
  if (selectedTargets.some((target) => target === undefined)) {
    throw new Error("benchmark policy contains an unknown selected target");
  }
  if (
    identity.mode === "smoke" &&
    JSON.stringify(selectedTargets.map((target) => target.framework).sort()) !==
      JSON.stringify(["foundry", "hardhat", "vyper"])
  ) {
    throw new Error("smoke benchmark policy must select exactly one Foundry, one Hardhat, and one Vyper target");
  }
  const lane = lanes[identity.mode];
  const targetCount = selectedTargets.length;
  const trialsPerVariant = lane.trials_per_variant;
  const matrixRowsPerPair = checkedProduct(targetCount, trialsPerVariant, "benchmark matrix row count");
  const maxParallelEvalRows = workerModule.publicBenchmarkMaxParallelEvalRows(identity.mode);
  const maxParallelWorkflowNodes = workerModule.publicBenchmarkMaxParallelWorkflowNodes(identity.mode);
  const waves = Math.ceil(matrixRowsPerPair / maxParallelEvalRows);
  const controlTimeoutSeconds =
    waves * 3_600 +
    workerModule.PUBLIC_BENCHMARK_EVAL_CLEANUP_SECONDS +
    waves * workerModule.PUBLIC_BENCHMARK_SCORE_PER_WAVE_TIMEOUT_SECONDS +
    workerModule.PUBLIC_BENCHMARK_REPORT_TIMEOUT_SECONDS +
    workerModule.PUBLIC_BENCHMARK_PREPARATION_TIMEOUT_SECONDS +
    5 * 60;
  return {
    targetCount,
    trialsPerVariant,
    maxParallelEvalRows,
    maxParallelWorkflowNodes,
    controlTimeoutSeconds
  };
}

function defaultControlTimeoutSeconds(matrixRowsPerPair, maxParallelEvalRows) {
  const waves = Math.ceil(matrixRowsPerPair / maxParallelEvalRows);
  return waves * 3_600 + 5 * 60 + waves * 45 * 60 + 5 * 60 + 20 * 60 + 5 * 60;
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function checkedProduct(left, right, label) {
  const value = left * right;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

export function validateAutomaticPairConfig(config, model, pair, context, usedModelSlugs) {
  const expectedRunId = `ci-${context.generation}-${context.mode}-${context.benchmark}-${pair.provider}`;
  const expectedAgent = pair.provider === "openai" ? "CodexAgent" : "ClaudeAgent";
  if (!SAFE_MODEL.test(model.model) || /(?:^|[-_.:/])latest$/iu.test(model.model)) {
    throw new Error(`benchmark config ${pair.config_path} has an unsafe or unpinned model`);
  }
  if (!SAFE_REASONING.test(model.reasoning)) {
    throw new Error(`benchmark config ${pair.config_path} has unsafe reasoning`);
  }
  let expectedModelSlug = boundedSafeId(
    `benchmark-${context.mode}-${model.model}-${model.reasoning}`,
    `${context.mode}:${pair.provider}:${model.model}:${model.reasoning}`,
    96
  );
  if (usedModelSlugs.has(expectedModelSlug)) {
    expectedModelSlug = boundedSafeId(
      `${expectedModelSlug}-${pair.provider}`,
      `${context.mode}:${pair.provider}:${model.model}:${model.reasoning}:provider`,
      96
    );
  }
  assertUnique(usedModelSlugs, expectedModelSlug, "derived benchmark model slug");
  const scope = config.public_benchmark;
  const mismatches = [
    config.run_id === expectedRunId ? undefined : "run ID",
    config.image_name === `ufz-runner-${context.candidateCommit}` ? undefined : "image name",
    config.node_timeout_seconds === 1800 ? undefined : "node timeout",
    config.loops === 1 ? undefined : "strategy loops",
    scope.benchmark === context.benchmark ? undefined : "benchmark",
    scope.lane === context.mode ? undefined : "lane",
    scope.runner_model_profile === pair.model_slug ? undefined : "runner profile",
    scope.candidate_repository === context.repository ? undefined : "candidate repository",
    scope.candidate_commit === context.candidateCommit ? undefined : "candidate commit",
    scope.max_runtime_seconds === 3600 ? undefined : "maximum runtime",
    config.braintrust.project === "ultrafuzz-public-benchmarks" ? undefined : "reporting project",
    config.braintrust.api_key_env === "BRAINTRUST_API_KEY" ? undefined : "reporting credential name",
    config.braintrust.judge_api_key_env === "OPENAI_API_KEY" ? undefined : "judge credential name",
    config.braintrust.judge_url === "https://api.openai.com/v1/chat/completions" ? undefined : "judge URL",
    model.slug === pair.model_slug ? undefined : "model slug",
    model.slug === expectedModelSlug ? undefined : "derived model slug",
    model.provider === pair.provider ? undefined : "model provider",
    model.agent === expectedAgent ? undefined : "model agent",
    context.mode !== "smoke" || (model.model === "gpt-5.6-luna" && model.reasoning === "high")
      ? undefined
      : "canonical smoke model",
    model.auth_mode === "api-key" ? undefined : "model authentication mode"
  ].filter((entry) => entry !== undefined);
  if (mismatches.length > 0) {
    throw new Error(`benchmark config ${pair.config_path} has mismatched ${mismatches.join(", ")}`);
  }
}

function assertBundleMatrixCount(bundle, expectedRows, pair) {
  const matrixFile = bundle.files.find((file) => file.path === "eval/matrix.json");
  if (matrixFile === undefined) throw new Error(`public benchmark bundle ${pair} is missing its matrix`);
  let matrix;
  try {
    matrix = JSON.parse(Buffer.from(matrixFile.contents_base64, "base64").toString("utf8"));
  } catch (error) {
    throw new Error(`public benchmark bundle ${pair} matrix is invalid`, { cause: error });
  }
  if (!Array.isArray(matrix) || matrix.length !== expectedRows) {
    throw new Error(`public benchmark bundle ${pair} matrix row count does not match the trusted lane`);
  }
}

function readJsonRegular(filePath, maxBytes, label) {
  const absolute = path.resolve(filePath);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) {
      throw new Error(`${label} must be a non-empty regular file within its size limit`);
    }
    return JSON.parse(fs.readFileSync(descriptor, "utf8"));
  } catch (error) {
    throw new Error(`failed to read ${label}`, { cause: error });
  } finally {
    fs.closeSync(descriptor);
  }
}

function regularDirectory(value, label) {
  const absolute = path.resolve(requiredString(value, label));
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a regular directory`);
  return fs.realpathSync(absolute);
}

function regularFileInside(root, relative, maxBytes, label) {
  const parts = relative.split("/");
  if (parts.length === 0 || parts.some((part) => !SAFE_ID.test(part))) {
    throw new Error(`${label} path is not a safe relative path`);
  }
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} path contains a symbolic link`);
  }
  const resolved = fs.realpathSync(current);
  const relativeToRoot = path.relative(root, resolved);
  if (relativeToRoot === "" || relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} escapes its trusted root`);
  }
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) {
    throw new Error(`${label} must be a non-empty regular file within its size limit`);
  }
  return resolved;
}

function writeJsonExclusive(filePath, value, label) {
  const absolute = path.resolve(requiredString(filePath, `${label} output path`));
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  fs.writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

function strictRecord(value, label, expectedKeys) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new Error(`${label} must contain exactly ${expected.join(", ")}`);
  }
  return value;
}

function safeLowerId(value, label) {
  if (typeof value !== "string" || !SAFE_LOWER_ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function safeBasename(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value) || path.basename(value) !== value) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function fullCommit(value, label) {
  if (typeof value !== "string" || !FULL_COMMIT.test(value)) throw new Error(`${label} must be a full lowercase SHA`);
  return value;
}

function canonicalRepository(value) {
  if (typeof value !== "string" || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) {
    throw new Error("candidate repository must be a canonical public GitHub URL");
  }
  return value;
}

function positiveDecimal(value, label) {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !POSITIVE_DECIMAL.test(text)) throw new Error(`${label} must be a positive decimal`);
  return text;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty string without surrounding whitespace`);
  }
  return value;
}

function assertUnique(values, value, label) {
  if (values.has(value)) throw new Error(`${label} is duplicated: ${value}`);
  values.add(value);
}

function boundedSafeId(value, identity, maxLength) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^[^a-z0-9]+/u, "")
    .replace(/-+/gu, "-")
    .replace(/-+$/u, "");
  if (normalized === "") throw new Error("cannot derive a safe benchmark identifier");
  if (normalized.length <= maxLength) return normalized;
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  const prefix = normalized.slice(0, maxLength - digest.length - 1).replace(/-+$/u, "");
  return `${prefix}-${digest}`;
}

function gitOutput(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "policy") {
    const [policyRoot, candidateCommit, benchmark, ...extra] = args;
    if (policyRoot === undefined || candidateCommit === undefined || benchmark === undefined || extra.length > 0) {
      throw new Error(
        "usage: prepare-eval-history-publication.mjs policy <policy-root> <candidate-commit> <benchmark>"
      );
    }
    validateBenchmarkPolicyFiles({ policyRoot, candidateCommit, benchmark });
    return;
  }
  if (command !== "automatic") {
    throw new Error(
      "usage: prepare-eval-history-publication.mjs automatic <manifest> <control-root> <results-root> <policy-root> <candidate-commit> <repository> <run-id> <run-attempt> <mode> <generation-output> <plan-output>"
    );
  }
  const [
    manifestPath,
    controlRoot,
    resultsRoot,
    policyRoot,
    candidateCommit,
    repository,
    producerRunId,
    producerRunAttempt,
    mode,
    generationPath,
    planPath,
    ...extra
  ] = args;
  if (
    [
      manifestPath,
      controlRoot,
      resultsRoot,
      policyRoot,
      candidateCommit,
      repository,
      producerRunId,
      producerRunAttempt,
      mode,
      generationPath,
      planPath
    ].some((value) => value === undefined) ||
    extra.length > 0
  ) {
    throw new Error(
      "usage: prepare-eval-history-publication.mjs automatic <manifest> <control-root> <results-root> <policy-root> <candidate-commit> <repository> <run-id> <run-attempt> <mode> <generation-output> <plan-output>"
    );
  }
  const result = await prepareAutomaticPublication({
    manifestPath,
    controlRoot,
    resultsRoot,
    policyRoot,
    candidateCommit,
    repository,
    producerRunId,
    producerRunAttempt,
    mode,
    generationPath,
    planPath
  });
  process.stdout.write(`${JSON.stringify({ pairs: result.plan.pairs.length })}\n`);
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
