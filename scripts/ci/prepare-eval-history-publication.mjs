import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { readRegularFileSnapshot } from "../../packages/artifacts/dist/index.js";
import { MODAL_BENCHMARK_CONTROL_MANIFEST_SCHEMA_ID } from "../../packages/modal/dist/modal-contracts.js";
import { assertModalDocumentValue, parseModalDocumentBytes } from "../../packages/modal/dist/modal-documents.js";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_POLICY_BYTES = 16 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_LOWER_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const OPAQUE_MODEL = /^[^\s\p{Cc}]+$/u;
const LEGACY_SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SAFE_REASONING = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/u;
const ROOT_KEYS = [
  "schema_version",
  "candidate_commit",
  "repository",
  "generation",
  "mode",
  "benchmark",
  "execution",
  "image_name",
  "targets",
  "matrix_rows_per_pair",
  "control_timeout_seconds",
  "concurrency",
  "pairs"
];
const PAIR_KEYS = ["pair", "benchmark", "mode", "lane", "model_slug", "provider", "config_path", "state_path"];
const EXECUTION_KEYS = ["mode", "dry_run"];
const TARGET_KEYS = ["id", "repository", "revision", "framework"];
const CONCURRENCY_KEYS = [
  "max_parallel_eval_rows_per_sandbox",
  "max_parallel_workflow_nodes_per_row",
  "max_live_runner_workflows_by_provider",
  "max_live_judge_rows"
];
const PROVIDER_AGENT = {
  openai: "CodexAgent",
  anthropic: "ClaudeAgent",
  deepseek: "DeepSeekAgent",
  kimi: "KimiAgent",
  openrouter: "OpenRouterAgent"
};

/**
 * The single smoke runner is a dispatch-time choice, not checked-in lane policy: the
 * workflow's `smoke_provider` input builds a one-entry matrix from any known provider.
 * The trusted lane therefore pins how many runners a smoke manifest may declare, and
 * that the runner is a provider this repository knows how to score — not which one it
 * is. Reading that one field back off the manifest keeps every other dimension (targets,
 * trials, timeouts) pinned to policy. The provider selects between two checked-in
 * concurrency bounds — the lane's own numbers, or the candidate's declared OpenRouter
 * serialization — so it can only ever narrow the lane, never widen it.
 */
function smokeProviderFromManifest(manifest) {
  if (!Array.isArray(manifest.pairs) || manifest.pairs.length !== 1) return undefined;
  const pair = manifest.pairs[0];
  if (typeof pair !== "object" || pair === null || Array.isArray(pair)) return undefined;
  if (typeof pair.provider !== "string" || !Object.hasOwn(PROVIDER_AGENT, pair.provider)) return undefined;
  return pair.provider;
}

function smokeProviderName(value) {
  if (value === undefined) return "openai";
  if (typeof value !== "string" || !Object.hasOwn(PROVIDER_AGENT, value)) {
    throw new Error(`benchmark smoke provider must be one of ${Object.keys(PROVIDER_AGENT).join(", ")}`);
  }
  return value;
}

export function validateAutomaticPublicationManifest(value, context) {
  if (context.mode !== "smoke" && context.mode !== "full") {
    throw new Error("automatic publication mode must be smoke or full");
  }
  return validateBenchmarkControlManifest(value, context);
}

/** Validate immutable pre-compute control for every recoverable benchmark lane. */
function validateBenchmarkControlManifest(value, context) {
  assertModalDocumentValue(MODAL_BENCHMARK_CONTROL_MANIFEST_SCHEMA_ID, value);
  const manifest = strictRecord(value, "benchmark manifest", ROOT_KEYS);
  const expected = benchmarkControlExpectations(
    context.mode === "smoke" && context.smokeProvider === undefined
      ? { ...context, smokeProvider: smokeProviderFromManifest(manifest) }
      : context
  );
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
  validateExecution(manifest.execution);
  if (manifest.image_name !== `ufz-runner-${expected.candidateCommit}`) {
    throw new Error("benchmark manifest image name does not match the candidate commit");
  }
  validateManifestTargets(manifest.targets, expected);
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
  manifest.pairs.forEach((value, index) => {
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
  });
  return manifest;
}

export function readBenchmarkControlManifest(filePath, context) {
  return validateBenchmarkControlManifest(readBenchmarkControlManifestDocument(filePath), context);
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
  const cohortPath =
    input.benchmark === "evmbench" ? "benchmarks/evmbench/cohort.json" : "benchmarks/ultrafuzzbench/cohort.json";
  for (const relative of ["benchmarks/ultrafuzzbench/lanes.json", cohortPath]) {
    regularFileInside(policyRoot, relative, MAX_POLICY_BYTES, `benchmark policy ${relative}`);
  }
  return policyRoot;
}

function benchmarkControlExpectations(input) {
  const candidateCommit = fullCommit(input.candidateCommit, "candidate commit");
  const repository = canonicalRepository(input.repository);
  const producerRunId = positiveDecimal(input.producerRunId, "producer run ID");
  const producerRunAttempt = positiveDecimal(input.producerRunAttempt, "producer run attempt");
  if (input.mode !== "smoke" && input.mode !== "full") {
    throw new Error("benchmark control mode must be smoke or full");
  }
  const smoke = input.mode === "smoke";
  const full = input.mode === "full";
  const targets = input.targets === undefined ? undefined : validatedTargets(input.targets);
  const explicitTargetIds = input.targetIds === undefined ? undefined : validatedTargetIds(input.targetIds);
  const targetIds = explicitTargetIds ?? targets?.map((target) => target.id);
  if (
    explicitTargetIds !== undefined &&
    targets !== undefined &&
    JSON.stringify(explicitTargetIds) !== JSON.stringify(targets.map((target) => target.id))
  ) {
    throw new Error("benchmark target IDs do not match the expected target metadata");
  }
  const targetCount = positiveSafeInteger(
    input.targetCount ?? targets?.length ?? targetIds?.length ?? (full ? 40 : 3),
    "benchmark target count"
  );
  if (targetIds !== undefined && targetIds.length !== targetCount) {
    throw new Error("benchmark target IDs do not match the expected target count");
  }
  const trialsPerVariant = positiveSafeInteger(input.trialsPerVariant ?? 1, "benchmark trials per variant");
  const matrixRowsPerPair = checkedProduct(targetCount, trialsPerVariant, "benchmark matrix row count");
  const maxParallelEvalRows = positiveSafeInteger(
    input.maxParallelEvalRows ?? (full ? 20 : 3),
    "maximum parallel eval rows"
  );
  const maxParallelWorkflowNodes = positiveSafeInteger(
    input.maxParallelWorkflowNodes ?? (smoke ? 4 : 8),
    "maximum parallel workflow nodes"
  );
  const maxRuntimeSeconds = positiveSafeInteger(
    input.maxRuntimeSeconds ?? defaultMaxRuntimeSeconds(input.mode),
    "maximum runtime"
  );
  const controlTimeoutSeconds = positiveSafeInteger(
    input.controlTimeoutSeconds ??
      defaultControlTimeoutSeconds(matrixRowsPerPair, maxParallelEvalRows, maxRuntimeSeconds),
    "benchmark control timeout"
  );
  const maxLiveRowsPerPair = Math.min(matrixRowsPerPair, maxParallelEvalRows);
  const providers = full ? ["openai", "anthropic", "kimi", "deepseek"] : [smokeProviderName(input.smokeProvider)];
  return {
    candidateCommit,
    repository,
    producerRunId,
    producerRunAttempt,
    generation: `${producerRunId}-${producerRunAttempt}`,
    mode: input.mode,
    benchmark: full ? "evmbench" : "ultrafuzz-bench",
    providers,
    targetIds,
    targets,
    targetCount,
    trialsPerVariant,
    matrixRowsPerPair,
    controlTimeoutSeconds,
    maxParallelEvalRows,
    maxParallelWorkflowNodes,
    maxRuntimeSeconds,
    maxLiveRowsPerPair,
    maxLiveJudgeRows: checkedProduct(providers.length, maxLiveRowsPerPair, "maximum live judge rows")
  };
}

function validateExecution(value) {
  const execution = strictRecord(value, "benchmark execution", EXECUTION_KEYS);
  if (execution.mode !== "modal" || execution.dry_run !== false) {
    throw new Error("benchmark manifest execution must be Modal with dry-run disabled");
  }
}

function validateManifestTargets(value, expected) {
  const targets = validatedTargets(value);
  if (targets.length !== expected.targetCount) {
    throw new Error("benchmark manifest target count does not match the trusted lane");
  }
  if (
    expected.targetIds !== undefined &&
    JSON.stringify(targets.map((target) => target.id)) !== JSON.stringify(expected.targetIds)
  ) {
    throw new Error("benchmark manifest target IDs do not match the trusted lane");
  }
  if (expected.targets !== undefined && JSON.stringify(targets) !== JSON.stringify(expected.targets)) {
    throw new Error("benchmark manifest targets do not match the trusted benchmark policy");
  }
  return targets;
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

function defaultControlTimeoutSeconds(matrixRowsPerPair, maxParallelEvalRows, maxRuntimeSeconds) {
  const waves = Math.ceil(matrixRowsPerPair / maxParallelEvalRows);
  return waves * maxRuntimeSeconds + 5 * 60 + waves * 45 * 60 + 5 * 60 + 20 * 60 + 5 * 60;
}

function defaultMaxRuntimeSeconds(mode) {
  return mode === "full" ? 15_000 : 4 * 60 * 60 + 10 * 60;
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
  const expectedAgent = PROVIDER_AGENT[pair.provider];
  if (expectedAgent === undefined) {
    throw new Error(`benchmark config ${pair.config_path} has an unsupported model provider`);
  }
  if (
    typeof model.model !== "string" ||
    model.model.length === 0 ||
    model.model.length > 256 ||
    !OPAQUE_MODEL.test(model.model) ||
    (pair.provider !== "openrouter" &&
      (!LEGACY_SAFE_MODEL.test(model.model) || /(?:^|[-_.:/])latest$/iu.test(model.model)))
  ) {
    throw new Error(`benchmark config ${pair.config_path} has an unsafe or unpinned model`);
  }
  if (!SAFE_REASONING.test(model.reasoning)) {
    throw new Error(`benchmark config ${pair.config_path} has unsafe reasoning`);
  }
  if (["kimi", "deepseek"].includes(pair.provider) && !["low", "high", "max"].includes(model.reasoning)) {
    throw new Error(`benchmark config ${pair.config_path} has unsupported ${pair.provider} reasoning`);
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
    config.schema_version === "ultrafuzz.modal.benchmark.v3" ? undefined : "schema version",
    config.run_id === expectedRunId ? undefined : "run ID",
    config.app_name === "ultrafuzz-evals" ? undefined : "app name",
    config.image_name === `ufz-runner-${context.candidateCommit}` ? undefined : "image name",
    config.node_timeout_seconds === 1800 ? undefined : "node timeout",
    config.loops === 1 ? undefined : "strategy loops",
    scope.benchmark === context.benchmark ? undefined : "benchmark",
    scope.lane === context.mode ? undefined : "lane",
    scope.runner_model_profile === pair.model_slug ? undefined : "runner profile",
    scope.candidate_repository === context.repository ? undefined : "candidate repository",
    scope.candidate_commit === context.candidateCommit ? undefined : "candidate commit",
    context.targets === undefined || JSON.stringify(scope.targets) === JSON.stringify(context.targets)
      ? undefined
      : "target selection",
    scope.max_runtime_seconds === (context.maxRuntimeSeconds ?? defaultMaxRuntimeSeconds(context.mode))
      ? undefined
      : "maximum runtime",
    config.judge.api_key_env === "OPENAI_API_KEY" ? undefined : "judge credential name",
    config.judge.url === "https://api.openai.com/v1/chat/completions" ? undefined : "judge URL",
    model.slug === pair.model_slug ? undefined : "model slug",
    model.slug === expectedModelSlug ? undefined : "derived model slug",
    model.provider === pair.provider ? undefined : "model provider",
    model.agent === expectedAgent ? undefined : "model agent",
    model.auth_mode === "api-key" ? undefined : "model authentication mode"
  ].filter((entry) => entry !== undefined);
  if (mismatches.length > 0) {
    throw new Error(`benchmark config ${pair.config_path} has mismatched ${mismatches.join(", ")}`);
  }
}

function validatedTargetIds(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("benchmark target IDs must be a non-empty array");
  const targetIds = [];
  const seen = new Set();
  for (const [index, targetId] of value.entries()) {
    const safeTargetId = safeLowerId(targetId, `benchmark target ID ${index}`);
    assertUnique(seen, safeTargetId, "benchmark target ID");
    targetIds.push(safeTargetId);
  }
  return targetIds;
}

function validatedTargets(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("benchmark targets must be a non-empty array");
  const targets = [];
  const seen = new Set();
  for (const [index, entry] of value.entries()) {
    const target = strictRecord(entry, `benchmark target ${index}`, TARGET_KEYS);
    const id = safeLowerId(target.id, `benchmark target ${index} ID`);
    assertUnique(seen, id, "benchmark target ID");
    targets.push({
      id,
      repository: canonicalRepository(target.repository),
      revision: fullCommit(target.revision, `benchmark target ${index} revision`),
      framework: safeId(target.framework, `benchmark target ${index} framework`)
    });
  }
  return targets;
}

function readBenchmarkControlManifestDocument(filePath) {
  return parseModalDocumentBytes(
    MODAL_BENCHMARK_CONTROL_MANIFEST_SCHEMA_ID,
    readRegularFileSnapshot(path.resolve(filePath), MAX_MANIFEST_BYTES)
  ).value;
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

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`${label} is invalid`);
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
