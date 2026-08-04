import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  parseAutomaticPublicationProfileOptions,
  readAutomaticPublicationManifest,
  validateAutomaticPairConfig,
  validateBenchmarkPolicyFiles
} from "./prepare-eval-history-publication.mjs";
import { modalBenchmarkPolicyDimensions } from "./validate-modal-benchmark-launch.mjs";

const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const GENERATION = /^[1-9][0-9]*-[1-9][0-9]*$/u;
const MAX_CONTROL_FILE_BYTES = 1024 * 1024;
const CONFIG_KEYS = [
  "app_name",
  "braintrust",
  "image_name",
  "loops",
  "models",
  "node_timeout_seconds",
  "public_benchmark",
  "run_id",
  "schema_version"
];
const MODEL_KEYS = ["agent", "auth_mode", "model", "provider", "reasoning", "slug"];

export function prepareModalBenchmarkCleanup(input) {
  assertExpectedProfileInput(input);
  if (!FULL_COMMIT.test(input.expectedCandidate)) throw new Error("cleanup candidate must be a full commit");
  if (!GENERATION.test(input.expectedGeneration)) throw new Error("cleanup generation is invalid");
  if (input.expectedMode !== "smoke" && input.expectedMode !== "full") {
    throw new Error("cleanup mode must be smoke or full");
  }
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.expectedRepository)) {
    throw new Error("cleanup repository is invalid");
  }

  const manifestPath = path.resolve(input.manifestPath);
  const root = fs.realpathSync(path.dirname(manifestPath));
  assertBoundedRegularFile(manifestPath, "incomplete benchmark manifest");
  if (fs.realpathSync(manifestPath) !== path.join(root, path.basename(manifestPath))) {
    throw new Error("incomplete benchmark manifest escapes its control root");
  }

  const [producerRunId, producerRunAttempt] = input.expectedGeneration.split("-");
  const dimensions = input.policyDimensions;
  const manifest = readAutomaticPublicationManifest(manifestPath, {
    candidateCommit: input.expectedCandidate,
    repository: input.expectedRepository,
    producerRunId,
    producerRunAttempt,
    mode: input.expectedMode,
    targets: dimensions.targets,
    targetIds: dimensions.targetIds,
    targetCount: dimensions.targetCount,
    trialsPerVariant: dimensions.trialsPerVariant,
    maxParallelEvalRows: dimensions.maxParallelEvalRows,
    maxParallelWorkflowNodes: dimensions.maxParallelWorkflowNodes,
    maxRuntimeSeconds: dimensions.maxRuntimeSeconds,
    controlTimeoutSeconds: dimensions.controlTimeoutSeconds,
    ...(input.expectedProvider === undefined ? {} : { expectedProviders: [input.expectedProvider] }),
    ...(input.expectedModel === undefined
      ? {}
      : { expectedModel: input.expectedModel, expectedReasoning: input.expectedReasoning })
  });

  const configs = new Set();
  const states = new Set();
  const modelSlugs = new Set();
  const rows = [];
  for (const [index, value] of manifest.pairs.entries()) {
    const configPath = value.config_path;
    const statePath = value.state_path;
    if (configs.has(configPath) || states.has(statePath)) {
      throw new Error(`incomplete benchmark pair ${index} duplicates a control path`);
    }
    const absoluteConfig = path.join(root, configPath);
    assertBoundedRegularFile(absoluteConfig, `incomplete benchmark config ${index}`);
    if (fs.realpathSync(absoluteConfig) !== absoluteConfig) {
      throw new Error(`incomplete benchmark config ${index} escapes its control root`);
    }
    const config = JSON.parse(fs.readFileSync(absoluteConfig, "utf8"));
    assertExactKeys(config, CONFIG_KEYS, `incomplete benchmark config ${index}`);
    if (!Array.isArray(config.models) || config.models.length !== 1) {
      throw new Error(`incomplete benchmark config ${index} must contain exactly one model`);
    }
    const model = config.models[0];
    assertExactKeys(model, MODEL_KEYS, `incomplete benchmark config ${index} model`);
    validateAutomaticPairConfig(
      config,
      model,
      value,
      {
        candidateCommit: input.expectedCandidate,
        repository: input.expectedRepository,
        generation: input.expectedGeneration,
        mode: input.expectedMode,
        benchmark: manifest.benchmark,
        targets: manifest.targets,
        maxRuntimeSeconds: dimensions.maxRuntimeSeconds,
        ...(input.expectedModel === undefined
          ? {}
          : { expectedModel: input.expectedModel, expectedReasoning: input.expectedReasoning })
      },
      modelSlugs
    );
    configs.add(configPath);
    states.add(statePath);
    rows.push(`${configPath}\t${statePath}`);
  }

  fs.writeFileSync(input.outputPath, `${rows.join("\n")}\n`, { flag: "wx", mode: 0o600 });
  return { imageName: manifest.image_name, rows };
}

function assertExpectedProfileInput(input) {
  const hasModel = input.expectedModel !== undefined;
  const hasReasoning = input.expectedReasoning !== undefined;
  if (hasModel !== hasReasoning) {
    throw new Error("expected benchmark model and reasoning must be supplied together");
  }
  if (hasModel && input.expectedProvider === undefined) {
    throw new Error("an exact expected benchmark model profile requires an expected provider");
  }
}

function assertBoundedRegularFile(filePath, label) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > MAX_CONTROL_FILE_BYTES) {
    throw new Error(`${label} must be a bounded regular file`);
  }
}

function assertExactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} contains unexpected fields`);
  }
}

function main(args) {
  const usage =
    "usage: prepare-modal-benchmark-cleanup.mjs <manifest> <output> <candidate> <repository> <generation> <mode> <policy-root> [--expected-provider <provider>] [--expected-model <model> --expected-reasoning <reasoning>]";
  if (args.length < 7) throw new Error(usage);
  const [
    manifestPath,
    outputPath,
    expectedCandidate,
    expectedRepository,
    expectedGeneration,
    expectedMode,
    policyRoot,
    ...profileArgs
  ] = args;
  const expectedProfile = parseAutomaticPublicationProfileOptions(profileArgs);
  if (expectedMode !== "smoke" && expectedMode !== "full") {
    throw new Error("cleanup mode must be smoke or full");
  }
  const benchmark = expectedMode === "smoke" ? "ultrafuzz-bench" : "evmbench";
  const trustedPolicyRoot = validateBenchmarkPolicyFiles({
    policyRoot,
    candidateCommit: expectedCandidate,
    benchmark
  });
  prepareModalBenchmarkCleanup({
    manifestPath,
    outputPath,
    expectedCandidate,
    expectedRepository,
    expectedGeneration,
    expectedMode,
    ...(expectedProfile.expectedProviders === undefined
      ? {}
      : { expectedProvider: expectedProfile.expectedProviders[0] }),
    ...(expectedProfile.expectedModel === undefined
      ? {}
      : {
          expectedModel: expectedProfile.expectedModel,
          expectedReasoning: expectedProfile.expectedReasoning
        }),
    policyDimensions: modalBenchmarkPolicyDimensions(trustedPolicyRoot, expectedMode)
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
