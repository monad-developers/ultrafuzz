import fs from "node:fs";
import path from "node:path";

import { parseModalBenchmarkConfig } from "../../packages/modal/dist/config.js";

const [candidateCommit, repository, generation, outputDirectory, lane = "smoke", experiment = "candidate"] =
  process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(candidateCommit ?? "")) throw new Error("candidate commit must be a full lowercase SHA");
if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) {
  throw new Error("candidate repository must be a canonical public GitHub URL");
}
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(generation ?? "")) throw new Error("generation is invalid");
if (lane !== "smoke") {
  throw new Error("the public Modal launcher supports only the bounded smoke lane; full must be chunked before launch");
}
if (!["candidate", "without-kadenzipfel", "paired-kadenzipfel"].includes(experiment)) {
  throw new Error("experiment must be candidate, without-kadenzipfel, or paired-kadenzipfel");
}
if (!outputDirectory) throw new Error("output directory is required");

const root = path.resolve(outputDirectory);
fs.mkdirSync(root, { recursive: true });
const imageName = `ufz-runner-${candidateCommit}`;
const profilePrefix = `benchmark-${lane}`;
const models = [
  {
    slug: `${profilePrefix}-gpt-5-6-luna-high`,
    model: "gpt-5.6-luna",
    provider: "openai",
    agent: "CodexAgent",
    reasoning: "high",
    auth_mode: "api-key"
  },
  {
    slug: `${profilePrefix}-claude-sonnet-5-high`,
    model: "claude-sonnet-5",
    provider: "anthropic",
    agent: "ClaudeAgent",
    reasoning: "high",
    auth_mode: "api-key"
  }
];
const pairs = [];
const experiments = experiment === "paired-kadenzipfel" ? ["without-kadenzipfel", "candidate"] : [experiment];
for (const benchmarkExperiment of experiments) {
  for (const benchmark of ["evmbench", "ultrafuzz-bench"]) {
    for (const model of models) {
      const pair = `${benchmarkExperiment}-${benchmark}-${model.slug}`;
      const runId = `ci-${generation}-${benchmarkExperiment}-${benchmark}-${model.provider}`;
      const config = parseModalBenchmarkConfig({
        schema_version: "ultrafuzz.modal.benchmark.v1",
        run_id: runId,
        image_name: imageName,
        public_benchmark: {
          benchmark,
          lane,
          runner_model_profile: model.slug,
          experiment: benchmarkExperiment,
          excluded_node_ids:
            benchmarkExperiment === "without-kadenzipfel"
              ? ["reference-vulnerabilities-kadenzipfel", "kadenzipfel-vulnerability-strategies"]
              : [],
          candidate_repository: repository,
          candidate_commit: candidateCommit,
          max_runtime_seconds: 3600
        },
        braintrust: {
          project: "ultrafuzz-public-benchmarks",
          api_key_env: "BRAINTRUST_API_KEY",
          judge_api_key_env: "BRAINTRUST_API_KEY"
        },
        node_timeout_seconds: 900,
        loops: 1,
        models: [model]
      });
      const configFile = `${pair}.json`;
      const stateFile = `${pair}.state.json`;
      const configPath = path.join(root, configFile);
      fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      pairs.push({
        pair,
        benchmark,
        lane,
        model_slug: model.slug,
        experiment: benchmarkExperiment,
        config_path: configFile,
        state_path: stateFile
      });
    }
  }
}
const manifest = {
  candidate_commit: candidateCommit,
  repository,
  generation,
  experiment,
  image_name: imageName,
  pairs
};
fs.writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(manifest));
