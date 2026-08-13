import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseStrictJsonBytes } from "../../packages/artifacts/dist/index.js";
import { loadBenchmarkCohortManifest, loadBenchmarkLanesManifest } from "../../packages/evals/dist/index.js";
import { parseModalBenchmarkConfig } from "../../packages/modal/dist/config.js";
import { MODAL_BENCHMARK_CONTROL_MANIFEST_SCHEMA_ID } from "../../packages/modal/dist/modal-contracts.js";
import { serializeModalDocument } from "../../packages/modal/dist/modal-documents.js";
import {
  PUBLIC_BENCHMARK_EVAL_CLEANUP_SECONDS,
  PUBLIC_BENCHMARK_PREPARATION_TIMEOUT_SECONDS,
  PUBLIC_BENCHMARK_REPORT_TIMEOUT_SECONDS,
  PUBLIC_BENCHMARK_SCORE_PER_WAVE_TIMEOUT_SECONDS,
  publicBenchmarkMaxParallelEvalRows,
  publicBenchmarkMaxParallelWorkflowNodes,
  publicBenchmarkMaxRuntimeSeconds
} from "../../packages/modal/dist/public-worker.js";

const PUBLIC_NODE_TIMEOUT_SECONDS = 1800;
const PUBLIC_CONTROL_POLLING_GRACE_SECONDS = 5 * 60;
const MAX_BENCHMARK_MODELS_JSON_BYTES = 64 * 1024;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SAFE_REASONING = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MODEL_KEYS = ["model", "provider", "reasoning"];
const PROVIDER_AGENT = {
  openai: "CodexAgent",
  anthropic: "ClaudeAgent",
  deepseek: "DeepSeekAgent",
  kimi: "KimiAgent"
};
const AGENT_PROVIDER = {
  CodexAgent: "openai",
  ClaudeAgent: "anthropic",
  DeepSeekAgent: "deepseek",
  KimiAgent: "kimi"
};

const [candidateCommit, repository, generation, outputDirectory, mode] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(candidateCommit ?? "")) throw new Error("candidate commit must be a full lowercase SHA");
if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) {
  throw new Error("candidate repository must be a canonical public GitHub URL");
}
if (!/^[1-9][0-9]*-[1-9][0-9]*$/.test(generation ?? "")) throw new Error("generation is invalid");
if (mode !== "smoke" && mode !== "full") throw new Error("benchmark mode must be smoke or full");
if (!outputDirectory) throw new Error("output directory is required");

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const benchmark = mode === "smoke" ? "ultrafuzz-bench" : "evmbench";
const cohort = loadBenchmarkCohortManifest(
  path.join(repositoryRoot, "benchmarks", benchmark === "evmbench" ? "evmbench" : "ultrafuzzbench", "cohort.json")
);
const lanes = loadBenchmarkLanesManifest(path.join(repositoryRoot, "benchmarks/ultrafuzzbench/lanes.json"));
const lane = lanes[mode];
const selectedTargets =
  mode === "smoke"
    ? cohort.smoke_targets.map((id) => cohort.targets.find((target) => target.id === id))
    : cohort.targets;
if (selectedTargets.some((target) => target === undefined)) {
  throw new Error(`${mode} benchmark cohort contains an unknown selected target`);
}
if (
  mode === "smoke" &&
  JSON.stringify(selectedTargets.map((target) => target.framework).sort()) !==
    JSON.stringify(["foundry", "hardhat", "vyper"])
) {
  throw new Error("smoke benchmark must select exactly one Foundry, one Hardhat, and one Vyper target");
}
const targets = selectedTargets.map((target) => ({
  id: target.id,
  repository: target.repository,
  revision: target.revision,
  framework: target.framework
}));

const models = benchmarkModels(mode, lane.model_profiles);
const maxParallelEvalRows = publicBenchmarkMaxParallelEvalRows(mode);
const maxRuntimeSeconds = publicBenchmarkMaxRuntimeSeconds(mode);
if (!Number.isSafeInteger(maxParallelEvalRows) || maxParallelEvalRows <= 0) {
  throw new Error(`invalid ${mode} maximum parallel eval rows`);
}
const matrixRowsPerPair = selectedTargets.length * lane.trials_per_variant;
const matrixWaves = Math.ceil(matrixRowsPerPair / maxParallelEvalRows);
const controlTimeoutSeconds =
  matrixWaves * maxRuntimeSeconds +
  PUBLIC_BENCHMARK_EVAL_CLEANUP_SECONDS +
  matrixWaves * PUBLIC_BENCHMARK_SCORE_PER_WAVE_TIMEOUT_SECONDS +
  PUBLIC_BENCHMARK_REPORT_TIMEOUT_SECONDS +
  PUBLIC_BENCHMARK_PREPARATION_TIMEOUT_SECONDS +
  PUBLIC_CONTROL_POLLING_GRACE_SECONDS;

const root = path.resolve(outputDirectory);
fs.mkdirSync(root, { recursive: true });
const imageName = `ufz-runner-${candidateCommit}`;
const pairs = [];
for (const model of models) {
  const pair = boundedSafeId(`${benchmark}-${model.slug}`, `${mode}:${benchmark}:${model.provider}:${model.model}`);
  const runId = boundedSafeId(
    `ci-${generation}-${mode}-${benchmark}-${model.provider}`,
    `${candidateCommit}:${generation}:${mode}:${benchmark}:${model.provider}`
  );
  const config = parseModalBenchmarkConfig({
    schema_version: "ultrafuzz.modal.benchmark.v2",
    run_id: runId,
    app_name: "ultrafuzz-evals",
    image_name: imageName,
    public_benchmark: {
      benchmark,
      lane: mode,
      runner_model_profile: model.slug,
      candidate_repository: repository,
      candidate_commit: candidateCommit,
      targets,
      max_runtime_seconds: maxRuntimeSeconds
    },
    braintrust: {
      project: "ultrafuzz-public-benchmarks",
      api_key_env: "BRAINTRUST_API_KEY",
      judge_api_key_env: "OPENAI_API_KEY",
      judge_url: "https://api.openai.com/v1/chat/completions",
      judge_credential_ttl_seconds: 57_600
    },
    node_timeout_seconds: PUBLIC_NODE_TIMEOUT_SECONDS,
    loops: 1,
    models: [model]
  });
  const configFile = `${pair}.json`;
  const stateFile = `${pair}.state.json`;
  fs.writeFileSync(path.join(root, configFile), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  pairs.push({
    pair,
    benchmark,
    mode,
    lane: mode,
    model_slug: model.slug,
    provider: model.provider,
    config_path: configFile,
    state_path: stateFile
  });
}

const maxLiveRowsPerPair = Math.min(matrixRowsPerPair, maxParallelEvalRows);
const manifest = {
  schema_version: "ultrafuzz.modal.benchmark-control-manifest.v1",
  candidate_commit: candidateCommit,
  repository,
  generation,
  mode,
  benchmark,
  execution: {
    mode: "modal",
    dry_run: false
  },
  image_name: imageName,
  targets,
  matrix_rows_per_pair: matrixRowsPerPair,
  control_timeout_seconds: controlTimeoutSeconds,
  concurrency: {
    max_parallel_eval_rows_per_sandbox: maxParallelEvalRows,
    max_parallel_workflow_nodes_per_row: publicBenchmarkMaxParallelWorkflowNodes(mode),
    max_live_runner_workflows_by_provider: Object.fromEntries(
      models.map((model) => [
        model.provider,
        pairs.filter((pair) => pair.provider === model.provider).length * maxLiveRowsPerPair
      ])
    ),
    max_live_judge_rows: pairs.length * maxLiveRowsPerPair
  },
  pairs
};
const serializedManifest = serializeModalDocument(MODAL_BENCHMARK_CONTROL_MANIFEST_SCHEMA_ID, manifest);
fs.writeFileSync(path.join(root, "manifest.json"), serializedManifest.bytes, { mode: 0o600 });
console.log(JSON.stringify(manifest));

function benchmarkModels(benchmarkMode, checkedInProfiles) {
  const configured = process.env.BENCHMARK_MODELS_JSON;
  let requested;
  if (configured === undefined) {
    requested = checkedInProfiles.map((profile) => ({
      provider: providerForAgent(profile.agent),
      model: profile.model,
      reasoning: profile.reasoning
    }));
  } else {
    try {
      requested = parseStrictJsonBytes(Buffer.from(configured, "utf8"), {
        maxBytes: MAX_BENCHMARK_MODELS_JSON_BYTES,
        maxDepth: 8,
        maxItems: 16,
        maxProperties: 64
      });
    } catch (error) {
      throw new Error("BENCHMARK_MODELS_JSON must be valid strict JSON", { cause: error });
    }
  }
  if (!Array.isArray(requested)) throw new Error("BENCHMARK_MODELS_JSON must be an array");

  const validated = requested.map((entry, index) => validateModelEntry(entry, index));
  const expectedProviders =
    benchmarkMode === "smoke" && configured !== undefined
      ? validated.length === 1
        ? [validated[0].provider]
        : []
      : benchmarkMode === "smoke"
        ? ["openai"]
        : ["openai", "anthropic", "kimi", "deepseek"];
  const providers = validated.map((entry) => entry.provider);
  if (
    providers.length !== expectedProviders.length ||
    new Set(providers).size !== providers.length ||
    expectedProviders.some((provider) => !providers.includes(provider))
  ) {
    throw new Error(`${benchmarkMode} BENCHMARK_MODELS_JSON must contain exactly ${expectedProviders.join(" and ")}`);
  }
  const ordered = expectedProviders.map((provider) => validated.find((entry) => entry.provider === provider));
  const usedSlugs = new Set();
  return ordered.map((entry) => {
    let slug = boundedSafeId(
      `benchmark-${benchmarkMode}-${entry.model}-${entry.reasoning}`,
      `${benchmarkMode}:${entry.provider}:${entry.model}:${entry.reasoning}`,
      96
    );
    if (usedSlugs.has(slug)) {
      slug = boundedSafeId(
        `${slug}-${entry.provider}`,
        `${benchmarkMode}:${entry.provider}:${entry.model}:${entry.reasoning}:provider`,
        96
      );
    }
    if (usedSlugs.has(slug)) throw new Error("benchmark model slugs must be unique");
    usedSlugs.add(slug);
    return {
      slug,
      model: entry.model,
      provider: entry.provider,
      agent: PROVIDER_AGENT[entry.provider],
      reasoning: entry.reasoning,
      auth_mode: "api-key"
    };
  });
}

function validateModelEntry(entry, index) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`BENCHMARK_MODELS_JSON[${index}] must be an object`);
  }
  const keys = Object.keys(entry).sort();
  if (JSON.stringify(keys) !== JSON.stringify(MODEL_KEYS)) {
    throw new Error(`BENCHMARK_MODELS_JSON[${index}] must contain only model, provider, and reasoning`);
  }
  if (!(entry.provider in PROVIDER_AGENT)) {
    throw new Error(`BENCHMARK_MODELS_JSON[${index}].provider is invalid`);
  }
  if (typeof entry.model !== "string" || !SAFE_MODEL.test(entry.model) || /(?:^|[-_.:/])latest$/iu.test(entry.model)) {
    throw new Error(`BENCHMARK_MODELS_JSON[${index}].model is unsafe or unpinned`);
  }
  if (typeof entry.reasoning !== "string" || !SAFE_REASONING.test(entry.reasoning)) {
    throw new Error(`BENCHMARK_MODELS_JSON[${index}].reasoning is unsafe`);
  }
  if (["kimi", "deepseek"].includes(entry.provider) && !["low", "high", "max"].includes(entry.reasoning)) {
    const providerName = entry.provider === "kimi" ? "Kimi" : "DeepSeek";
    throw new Error(`BENCHMARK_MODELS_JSON[${index}].reasoning is unsupported for ${providerName}`);
  }
  return { provider: entry.provider, model: entry.model, reasoning: entry.reasoning };
}

function providerForAgent(agent) {
  const provider = AGENT_PROVIDER[agent];
  if (provider === undefined) throw new Error(`benchmark lane model profile agent is unsupported: ${agent}`);
  return provider;
}

function boundedSafeId(value, identity, maxLength = 128) {
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
