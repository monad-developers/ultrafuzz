import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isPublicModalBenchmarkConfig, loadModalBenchmarkConfig } from "../../packages/modal/dist/config.js";
import { MODAL_BENCHMARK_CONTROL_MANIFEST_SCHEMA_ID } from "../../packages/modal/dist/modal-contracts.js";
import { readModalDocument } from "../../packages/modal/dist/modal-documents.js";

import {
  readBenchmarkControlManifest,
  validateAutomaticPairConfig,
  validateBenchmarkPolicyFiles
} from "./prepare-eval-history-publication.mjs";
import {
  benchmarkRunnerProviderFromManifest,
  modalBenchmarkPolicyDimensions
} from "./validate-modal-benchmark-launch.mjs";

const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const GENERATION = /^[1-9][0-9]*-[1-9][0-9]*$/u;
const MAX_CONTROL_FILE_BYTES = 1024 * 1024;

export function prepareModalBenchmarkCleanup(input) {
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
  // Provider-specific lane concurrency (OpenRouter serializes rows and nodes) is only
  // knowable from the manifest's single smoke runner pair, so callers pass a resolver and
  // cleanup derives the same trusted dimensions the launch guardrail derived.
  const dimensions =
    typeof input.policyDimensions === "function"
      ? input.policyDimensions(
          benchmarkRunnerProviderFromManifest(
            readModalDocument(manifestPath, MODAL_BENCHMARK_CONTROL_MANIFEST_SCHEMA_ID).value,
            input.expectedMode
          )
        )
      : input.policyDimensions;
  if (dimensions === undefined) throw new Error("cleanup policy dimensions are required");
  const manifest = readBenchmarkControlManifest(manifestPath, {
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
    controlTimeoutSeconds: dimensions.controlTimeoutSeconds
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
    const config = loadModalBenchmarkConfig(absoluteConfig);
    if (!isPublicModalBenchmarkConfig(config)) {
      throw new Error(`incomplete benchmark config ${index} must be a public benchmark config`);
    }
    const model = config.models[0];
    if (model === undefined || config.models.length !== 1) {
      throw new Error(`incomplete benchmark config ${index} must contain exactly one model`);
    }
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
        maxRuntimeSeconds: dimensions.maxRuntimeSeconds
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

function assertBoundedRegularFile(filePath, label) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > MAX_CONTROL_FILE_BYTES) {
    throw new Error(`${label} must be a bounded regular file`);
  }
}

function main(args) {
  if (args.length !== 7) {
    throw new Error(
      "usage: prepare-modal-benchmark-cleanup.mjs <manifest> <output> <candidate> <repository> <generation> <mode> <policy-root>"
    );
  }
  const [
    manifestPath,
    outputPath,
    expectedCandidate,
    expectedRepository,
    expectedGeneration,
    expectedMode,
    policyRoot
  ] = args;
  if (expectedMode !== "smoke" && expectedMode !== "full") {
    throw new Error("cleanup mode must be smoke or full");
  }
  const benchmark = expectedMode === "full" ? "evmbench" : "ultrafuzz-bench";
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
    policyDimensions: (runnerProvider) =>
      modalBenchmarkPolicyDimensions(trustedPolicyRoot, expectedMode, runnerProvider)
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
