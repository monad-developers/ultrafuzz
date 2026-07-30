import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

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
const PUBLIC_EVAL_DIAGNOSTICS_PATH = "eval/public-eval-diagnostics.json";
const ROOT_KEYS = [
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
  kimi: "KimiAgent"
};

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
  validateExecution(manifest.execution);
  if (manifest.image_name !== `ufz-runner-${expected.candidateCommit}`) {
    throw new Error("benchmark manifest image name does not match the candidate commit");
  }
  const targets = validateManifestTargets(manifest.targets, expected);
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
    execution: { mode: "modal", dry_run: false },
    image_name: manifest.image_name,
    targets,
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
  const manifestPath = regularFileInside(controlRoot, "manifest.json", MAX_MANIFEST_BYTES, "benchmark manifest");
  const producerPolicy = automaticProducerPolicyDimensions(
    readJsonRegular(manifestPath, MAX_MANIFEST_BYTES, "benchmark manifest"),
    controlRoot
  );
  const context = publicationExpectations({
    ...input,
    ...benchmarkPolicyDimensions(policyRoot, identity, evalModule, producerPolicy)
  });
  const manifest = readAutomaticPublicationManifest(manifestPath, context);
  const { loadModalBenchmarkConfig, fingerprintModalConfigFile, fingerprintModalModel } = configModule;
  const sourceFingerprint = launchStateModule.fingerprintTrackedSource(policyRoot);
  const usedModelSlugs = new Set();
  const evalRunIds = new Set();
  const pairs = [];
  const publicationUrl = `${context.repository}/actions/runs/${context.producerRunId}/artifacts`;
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
    const publicationSummary = summarizePublicBenchmarkBundlePublication(
      bundle,
      {
        matrixRowsPerPair: context.matrixRowsPerPair,
        targetIds: context.targetIds,
        targets: context.targets,
        trialsPerVariant: context.trialsPerVariant,
        modelSlug: pair.model_slug,
        evalRunId: bundle.eval_run_id
      },
      pair.pair,
      publicationUrl
    );
    assertUnique(evalRunIds, bundle.eval_run_id, "public eval run ID");
    pairs.push({
      pair: pair.pair,
      provider: pair.provider,
      model_slug: pair.model_slug,
      bundle_path: bundleRelativePath,
      unpack_path: pair.pair,
      eval_run_id: bundle.eval_run_id,
      benchmark: context.benchmark,
      lane: context.mode,
      status: publicationSummary.status,
      target_ids: publicationSummary.target_ids,
      executed_case_count: publicationSummary.executed_case_count,
      graded_case_count: publicationSummary.graded_case_count,
      publication_url: publicationSummary.publication_url
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
      status: pair.status,
      input_path: `${pair.unpack_path}/eval`,
      target_ids: pair.target_ids,
      executed_case_count: pair.executed_case_count,
      graded_case_count: pair.graded_case_count,
      publication_url: pair.publication_url
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
    input.targetCount ?? targets?.length ?? targetIds?.length ?? (smoke ? 3 : 40),
    "benchmark target count"
  );
  if (targetIds !== undefined && targetIds.length !== targetCount) {
    throw new Error("benchmark target IDs do not match the expected target count");
  }
  const trialsPerVariant = positiveSafeInteger(input.trialsPerVariant ?? 1, "benchmark trials per variant");
  const matrixRowsPerPair = checkedProduct(targetCount, trialsPerVariant, "benchmark matrix row count");
  const maxParallelEvalRows = positiveSafeInteger(
    input.maxParallelEvalRows ?? (smoke ? 3 : 20),
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
  const providers = smoke ? ["openai"] : ["openai", "anthropic", "kimi"];
  return {
    candidateCommit,
    repository,
    producerRunId,
    producerRunAttempt,
    generation: `${producerRunId}-${producerRunAttempt}`,
    mode: input.mode,
    benchmark: smoke ? "ultrafuzz-bench" : "evmbench",
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

function benchmarkPolicyDimensions(policyRoot, identity, evalModule, producerPolicy) {
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
  const candidatePolicy = trustedCandidateRuntimePolicyDimensions(policyRoot, identity.mode);
  const maxParallelEvalRows = candidatePolicy.maxParallelEvalRows;
  const maxParallelWorkflowNodes = candidatePolicy.maxParallelWorkflowNodes;
  const maxRuntimeSeconds = candidatePolicy.maxRuntimeSeconds;
  const waves = Math.ceil(matrixRowsPerPair / maxParallelEvalRows);
  const controlTimeoutSeconds =
    waves * maxRuntimeSeconds +
    candidatePolicy.evalCleanupSeconds +
    waves * candidatePolicy.scorePerWaveTimeoutSeconds +
    candidatePolicy.reportTimeoutSeconds +
    candidatePolicy.preparationTimeoutSeconds +
    candidatePolicy.controlPollingGraceSeconds;
  validateProducerPolicyDimensions(producerPolicy, {
    matrixRowsPerPair,
    maxParallelEvalRows,
    maxParallelWorkflowNodes,
    maxRuntimeSeconds,
    controlTimeoutSeconds
  });
  return {
    targets: selectedTargets.map((target) => ({
      id: target.id,
      repository: target.repository,
      revision: target.revision,
      framework: target.framework
    })),
    targetIds: selectedTargets.map((target) => target.id),
    targetCount,
    trialsPerVariant,
    maxParallelEvalRows,
    maxParallelWorkflowNodes,
    maxRuntimeSeconds,
    controlTimeoutSeconds
  };
}

export function validateProducerPolicyDimensions(actual, expected) {
  for (const key of [
    "matrixRowsPerPair",
    "maxParallelEvalRows",
    "maxParallelWorkflowNodes",
    "maxRuntimeSeconds",
    "controlTimeoutSeconds"
  ]) {
    if (actual[key] !== expected[key]) {
      throw new Error(`benchmark producer ${key} does not match the trusted candidate policy`);
    }
  }
  return actual;
}

export function trustedCandidateRuntimePolicyDimensions(policyRoot, mode) {
  if (mode !== "smoke" && mode !== "full") throw new Error("benchmark mode is invalid");
  const root = regularDirectory(policyRoot, "benchmark policy root");
  const benchmarkSource = fs.readFileSync(
    regularFileInside(
      root,
      "packages/evals/src/benchmark-manifest.ts",
      MAX_POLICY_BYTES,
      "candidate benchmark concurrency policy"
    ),
    "utf8"
  );
  const workerSource = fs.readFileSync(
    regularFileInside(
      root,
      "packages/modal/src/public-worker.ts",
      MAX_POLICY_BYTES,
      "candidate benchmark runtime policy"
    ),
    "utf8"
  );
  const preparationSource = fs.readFileSync(
    regularFileInside(
      root,
      "scripts/ci/prepare-modal-benchmarks.mjs",
      MAX_POLICY_BYTES,
      "candidate benchmark control policy"
    ),
    "utf8"
  );
  const concurrencyNames =
    mode === "smoke"
      ? ["BENCHMARK_SMOKE_MAX_PARALLEL_RUNS", "BENCHMARK_SMOKE_MAX_PARALLEL_TARGETS"]
      : ["BENCHMARK_FULL_MAX_PARALLEL_RUNS", "BENCHMARK_FULL_MAX_PARALLEL_TARGETS"];
  const concurrency = Object.fromEntries(
    concurrencyNames.map((name) => [name, readNumericSourceConstant(benchmarkSource, name, {}, name)])
  );
  const runtimeName =
    mode === "smoke" ? "PUBLIC_BENCHMARK_SMOKE_MAX_RUNTIME_SECONDS" : "PUBLIC_FULL_BENCHMARK_MAX_RUNTIME_SECONDS";
  return {
    maxParallelEvalRows: concurrency[concurrencyNames[0]],
    maxParallelWorkflowNodes: concurrency[concurrencyNames[1]],
    maxRuntimeSeconds: readNumericSourceConstant(workerSource, runtimeName, concurrency, runtimeName),
    evalCleanupSeconds: readNumericSourceConstant(
      workerSource,
      "PUBLIC_BENCHMARK_EVAL_CLEANUP_SECONDS",
      concurrency,
      "benchmark cleanup timeout"
    ),
    scorePerWaveTimeoutSeconds: readNumericSourceConstant(
      workerSource,
      "PUBLIC_BENCHMARK_SCORE_PER_WAVE_TIMEOUT_SECONDS",
      concurrency,
      "benchmark scoring timeout"
    ),
    reportTimeoutSeconds: readNumericSourceConstant(
      workerSource,
      "PUBLIC_BENCHMARK_REPORT_TIMEOUT_SECONDS",
      concurrency,
      "benchmark report timeout"
    ),
    preparationTimeoutSeconds: readNumericSourceConstant(
      workerSource,
      "PUBLIC_BENCHMARK_PREPARATION_TIMEOUT_SECONDS",
      concurrency,
      "benchmark preparation timeout"
    ),
    controlPollingGraceSeconds: readNumericSourceConstant(
      preparationSource,
      "PUBLIC_CONTROL_POLLING_GRACE_SECONDS",
      {},
      "benchmark control polling grace"
    )
  };
}

function readNumericSourceConstant(source, name, identifiers, label) {
  const sourceFile = ts.createSourceFile("trusted-candidate-policy.ts", source, ts.ScriptTarget.Latest, true);
  if (sourceFile.parseDiagnostics.length > 0) {
    throw new Error(`${label} source is not valid TypeScript`);
  }
  const declarations = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer !== undefined
      ) {
        declarations.push(declaration.initializer);
      }
    }
  }
  if (declarations.length !== 1) {
    throw new Error(`${label} must have exactly one top-level const declaration in the trusted candidate policy`);
  }
  return evaluateIntegerExpression(declarations[0], identifiers, label);
}

function evaluateIntegerExpression(node, identifiers, label) {
  let result;
  if (ts.isNumericLiteral(node)) {
    result = Number(node.text);
  } else if (ts.isIdentifier(node) && Object.hasOwn(identifiers, node.text)) {
    result = identifiers[node.text];
  } else if (ts.isParenthesizedExpression(node)) {
    result = evaluateIntegerExpression(node.expression, identifiers, label);
  } else if (ts.isPrefixUnaryExpression(node)) {
    const operand = evaluateIntegerExpression(node.operand, identifiers, label);
    if (node.operator === ts.SyntaxKind.PlusToken) result = operand;
    else if (node.operator === ts.SyntaxKind.MinusToken) result = -operand;
  } else if (ts.isBinaryExpression(node)) {
    const left = evaluateIntegerExpression(node.left, identifiers, label);
    const right = evaluateIntegerExpression(node.right, identifiers, label);
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken:
        result = left + right;
        break;
      case ts.SyntaxKind.MinusToken:
        result = left - right;
        break;
      case ts.SyntaxKind.AsteriskToken:
        result = left * right;
        break;
      case ts.SyntaxKind.SlashToken:
        if (right === 0 || left % right !== 0) throw new Error(`${label} contains a non-integral expression`);
        result = left / right;
        break;
    }
  }
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new Error(`${label} must resolve to a positive safe integer`);
  }
  return result;
}

export function automaticProducerPolicyDimensions(value, controlRoot) {
  const root = regularDirectory(controlRoot, "benchmark control root");
  const manifest = strictRecord(value, "benchmark manifest", ROOT_KEYS);
  const matrixRowsPerPair = positiveSafeInteger(manifest.matrix_rows_per_pair, "benchmark matrix row count");
  const controlTimeoutSeconds = positiveSafeInteger(manifest.control_timeout_seconds, "benchmark control timeout");
  const concurrency = strictRecord(manifest.concurrency, "benchmark concurrency", CONCURRENCY_KEYS);
  const maxParallelEvalRows = positiveSafeInteger(
    concurrency.max_parallel_eval_rows_per_sandbox,
    "maximum parallel eval rows"
  );
  const maxParallelWorkflowNodes = positiveSafeInteger(
    concurrency.max_parallel_workflow_nodes_per_row,
    "maximum parallel workflow nodes"
  );
  if (!Array.isArray(manifest.pairs) || manifest.pairs.length === 0) {
    throw new Error("benchmark manifest must contain producer pairs");
  }
  const runtimes = manifest.pairs.map((value, index) => {
    const pair = strictRecord(value, `benchmark pair ${index}`, PAIR_KEYS);
    const configPath = safeBasename(pair.config_path, `benchmark pair ${index} config path`);
    const config = looseRecord(
      readJsonRegular(
        regularFileInside(root, configPath, MAX_CONFIG_BYTES, `benchmark config ${configPath}`),
        MAX_CONFIG_BYTES,
        `benchmark config ${configPath}`
      ),
      `benchmark config ${configPath}`
    );
    const scope = looseRecord(config.public_benchmark, `benchmark config ${configPath} public scope`);
    return positiveSafeInteger(scope.max_runtime_seconds, `benchmark config ${configPath} maximum runtime`);
  });
  if (new Set(runtimes).size !== 1) {
    throw new Error("benchmark producer pairs must use one maximum runtime policy");
  }
  return {
    matrixRowsPerPair,
    controlTimeoutSeconds,
    maxParallelEvalRows,
    maxParallelWorkflowNodes,
    maxRuntimeSeconds: runtimes[0]
  };
}

function defaultControlTimeoutSeconds(matrixRowsPerPair, maxParallelEvalRows, maxRuntimeSeconds) {
  const waves = Math.ceil(matrixRowsPerPair / maxParallelEvalRows);
  return waves * maxRuntimeSeconds + 5 * 60 + waves * 45 * 60 + 5 * 60 + 20 * 60 + 5 * 60;
}

function defaultMaxRuntimeSeconds(mode) {
  return mode === "smoke" ? 4 * 60 * 60 + 10 * 60 : 60 * 60;
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
  if (!SAFE_MODEL.test(model.model) || /(?:^|[-_.:/])latest$/iu.test(model.model)) {
    throw new Error(`benchmark config ${pair.config_path} has an unsafe or unpinned model`);
  }
  if (!SAFE_REASONING.test(model.reasoning)) {
    throw new Error(`benchmark config ${pair.config_path} has unsafe reasoning`);
  }
  if (pair.provider === "kimi" && !["low", "high", "max"].includes(model.reasoning)) {
    throw new Error(`benchmark config ${pair.config_path} has unsupported Kimi reasoning`);
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
    config.schema_version === "ultrafuzz.modal.benchmark.v1" ? undefined : "schema version",
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
    config.braintrust.project === "ultrafuzz-public-benchmarks" ? undefined : "reporting project",
    config.braintrust.api_key_env === "BRAINTRUST_API_KEY" ? undefined : "reporting credential name",
    config.braintrust.judge_api_key_env === "OPENAI_API_KEY" ? undefined : "judge credential name",
    config.braintrust.judge_url === "https://api.openai.com/v1/chat/completions" ? undefined : "judge URL",
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

export function assertPublicBenchmarkBundleMatrixScope(bundle, expected, pair) {
  const expectedRows = positiveSafeInteger(expected.matrixRowsPerPair, "benchmark bundle matrix row count");
  const matrixFile = bundle.files.find((file) => file.path === "eval/matrix.json");
  if (matrixFile === undefined) throw new Error(`public benchmark bundle ${pair} is missing its matrix`);
  let matrix;
  try {
    matrix = JSON.parse(Buffer.from(matrixFile.contents_base64, "base64").toString("utf8"));
  } catch (error) {
    throw new Error(`public benchmark bundle ${pair} matrix is invalid`, { cause: error });
  }
  if (!Array.isArray(matrix) || matrix.length === 0) {
    throw new Error(`public benchmark bundle ${pair} matrix is not a non-empty array`);
  }
  const targetIds = expected.targetIds === undefined ? undefined : validatedTargetIds(expected.targetIds);
  if (targetIds === undefined) {
    if (matrix.length !== expectedRows) {
      throw new Error(`public benchmark bundle ${pair} matrix row count does not match the trusted lane`);
    }
    return;
  }

  const trialsPerVariant = positiveSafeInteger(expected.trialsPerVariant, "benchmark trials per variant");
  const modelSlug = safeLowerId(expected.modelSlug, `public benchmark bundle ${pair} model slug`);
  if (checkedProduct(targetIds.length, trialsPerVariant, "benchmark bundle target matrix row count") !== expectedRows) {
    throw new Error(`public benchmark bundle ${pair} trusted target IDs do not match the expected row count`);
  }

  const expectedRowsByScope = new Set();
  for (const targetId of targetIds) {
    for (let trial = 1; trial <= trialsPerVariant; trial += 1) {
      expectedRowsByScope.add(matrixScopeKey(targetId, modelSlug, `trial-${trial}`));
    }
  }
  const missingRows = new Set(expectedRowsByScope);
  const seenRows = new Set();
  const duplicateRows = [];
  const unexpectedRows = [];
  for (const [index, row] of matrix.entries()) {
    const identity = matrixRowIdentity(row, index, pair);
    const key = matrixScopeKey(identity.targetId, identity.variantId, identity.trialId);
    if (seenRows.has(key)) duplicateRows.push(key);
    seenRows.add(key);
    if (expectedRowsByScope.has(key)) missingRows.delete(key);
    else unexpectedRows.push(key);
  }

  const problems = [];
  if (matrix.length !== expectedRows) {
    problems.push(`row count ${matrix.length} does not match expected ${expectedRows}`);
  }
  if (missingRows.size > 0) {
    problems.push(`missing target result(s): ${formatMatrixScopeList([...missingRows])}`);
  }
  if (unexpectedRows.length > 0) {
    problems.push(`unexpected target/model/trial row(s): ${formatMatrixScopeList(unexpectedRows)}`);
  }
  if (duplicateRows.length > 0) {
    problems.push(`duplicate target/model/trial row(s): ${formatMatrixScopeList(duplicateRows)}`);
  }
  if (problems.length > 0) {
    throw new Error(
      `public benchmark bundle ${pair} matrix does not match the trusted target set: ${problems.join("; ")}`
    );
  }
}

export function summarizePublicBenchmarkBundlePublication(bundle, expected, pair, publicationUrl) {
  assertPublicBenchmarkBundleMatrixScope(bundle, expected, pair);
  const targetIds = expected.targetIds === undefined ? undefined : validatedTargetIds(expected.targetIds);
  if (targetIds === undefined) {
    throw new Error(`public benchmark bundle ${pair} is missing trusted target identities`);
  }
  const bundleTargets = validatedBundleTargets(bundle.targets, pair);
  assertBundleTargetsMatchExpected(bundleTargets, expected.targets, targetIds, pair);
  const diagnostics = bundleFileJson(bundle, PUBLIC_EVAL_DIAGNOSTICS_PATH, pair);
  const summary = bundleFileJson(bundle, "eval/summary.json", pair);
  const expectedRows = positiveSafeInteger(expected.matrixRowsPerPair, "benchmark bundle matrix row count");
  const evalRunId = safeLowerId(expected.evalRunId, `public benchmark bundle ${pair} eval run ID`);
  const status = safeBundleStatus(bundle.status, `public benchmark bundle ${pair} status`);
  const mismatches = [
    diagnostics.eval_run_id === evalRunId ? undefined : "diagnostics eval run",
    diagnostics.summary?.scoring_ready === true ? undefined : "diagnostics scoring readiness",
    summary.eval_run_id === evalRunId ? undefined : "score summary eval run"
  ].filter((entry) => entry !== undefined);
  if (mismatches.length > 0) {
    throw new Error(`public benchmark bundle ${pair} has mismatched ${mismatches.join(", ")}`);
  }
  const executedCaseCount = positiveSafeInteger(
    bundle.executed_case_count,
    `public benchmark bundle ${pair} executed case count`
  );
  const gradedCaseCount = positiveSafeInteger(
    bundle.graded_case_count,
    `public benchmark bundle ${pair} graded case count`
  );
  const diagnosticsExecuted = positiveSafeInteger(
    diagnostics.summary?.launched,
    `public benchmark bundle ${pair} diagnostics executed case count`
  );
  const summaryGraded = positiveSafeInteger(
    Array.isArray(summary.rows) ? summary.rows.length : undefined,
    `public benchmark bundle ${pair} summary graded case count`
  );
  if (
    executedCaseCount !== expectedRows ||
    gradedCaseCount !== expectedRows ||
    diagnosticsExecuted !== executedCaseCount ||
    summaryGraded !== gradedCaseCount
  ) {
    throw new Error(
      `public benchmark bundle ${pair} case counts do not match the trusted lane: executed ${executedCaseCount}, graded ${gradedCaseCount}, expected ${expectedRows}`
    );
  }
  return {
    status,
    target_ids: targetIds,
    executed_case_count: executedCaseCount,
    graded_case_count: gradedCaseCount,
    publication_url: canonicalPublicationUrl(publicationUrl)
  };
}

function validatedBundleTargets(value, pair) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`public benchmark bundle ${pair} targets must be a non-empty array`);
  }
  const seen = new Set();
  return value.map((entry, index) => {
    const target = strictRecord(entry, `public benchmark bundle ${pair} target ${index}`, [
      "id",
      "repository",
      "revision",
      "status",
      "executed_case_count",
      "graded_case_count",
      "publication_location",
      ...(entry.framework === undefined ? [] : ["framework"])
    ]);
    const id = safeLowerId(target.id, `public benchmark bundle ${pair} target ${index} ID`);
    assertUnique(seen, id, "public benchmark bundle target ID");
    const executed = positiveSafeInteger(
      target.executed_case_count,
      `public benchmark bundle ${pair} target ${id} executed case count`
    );
    const graded = positiveSafeInteger(
      target.graded_case_count,
      `public benchmark bundle ${pair} target ${id} graded case count`
    );
    return {
      id,
      repository: canonicalRepository(target.repository),
      revision: fullCommit(target.revision, `public benchmark bundle ${pair} target ${id} revision`),
      ...(target.framework === undefined
        ? {}
        : { framework: safeId(target.framework, `public benchmark bundle ${pair} target ${id} framework`) }),
      status: safeBundleStatus(target.status, `public benchmark bundle ${pair} target ${id} status`),
      executed_case_count: executed,
      graded_case_count: graded
    };
  });
}

function assertBundleTargetsMatchExpected(bundleTargets, expectedTargetsValue, targetIds, pair) {
  if (JSON.stringify([...bundleTargets.map((target) => target.id)].sort()) !== JSON.stringify([...targetIds].sort())) {
    throw new Error(`public benchmark bundle ${pair} target IDs do not match the trusted lane`);
  }
  if (expectedTargetsValue === undefined) return;
  const expectedTargets = new Map(validatedTargets(expectedTargetsValue).map((target) => [target.id, target]));
  for (const target of bundleTargets) {
    const expected = expectedTargets.get(target.id);
    if (
      expected === undefined ||
      target.repository !== expected.repository ||
      target.revision !== expected.revision ||
      (target.framework !== undefined && target.framework !== expected.framework)
    ) {
      throw new Error(
        `public benchmark bundle ${pair} target ${target.id} does not match the trusted benchmark policy`
      );
    }
  }
}

function safeBundleStatus(value, label) {
  if (value !== "succeeded" && value !== "genuine-task-failures") throw new Error(`${label} is invalid`);
  return value;
}

function bundleFileJson(bundle, relativePath, pair) {
  const file = bundle.files.find((entry) => entry.path === relativePath);
  if (file === undefined) throw new Error(`public benchmark bundle ${pair} is missing ${relativePath}`);
  try {
    return JSON.parse(Buffer.from(file.contents_base64, "base64").toString("utf8"));
  } catch (error) {
    throw new Error(`public benchmark bundle ${pair} ${relativePath} is invalid`, { cause: error });
  }
}

function matrixRowIdentity(row, index, pair) {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error(`public benchmark bundle ${pair} matrix row ${index} must be an object`);
  }
  return {
    targetId: safeLowerId(row.target_id, `public benchmark bundle ${pair} matrix row ${index} target ID`),
    variantId: safeLowerId(row.variant_id, `public benchmark bundle ${pair} matrix row ${index} variant ID`),
    trialId: safeLowerId(row.trial_id, `public benchmark bundle ${pair} matrix row ${index} trial ID`)
  };
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

function matrixScopeKey(targetId, variantId, trialId) {
  return [targetId, variantId, trialId].join("\u0000");
}

function formatMatrixScopeList(keys) {
  const values = keys.map((key) => key.split("\u0000").join("/"));
  const shown = values.slice(0, 8);
  return `${shown.join(", ")}${values.length > shown.length ? `, and ${values.length - shown.length} more` : ""}`;
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

function looseRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
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

function canonicalPublicationUrl(value) {
  if (
    typeof value !== "string" ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9][0-9]*\/artifacts$/u.test(value)
  ) {
    throw new Error("publication URL must be a canonical public GitHub Actions artifact URL");
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
