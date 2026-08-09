import type { PrivateModalBenchmarkConfig } from "./config.js";
import type { ModalModelSpec } from "./defaults.js";

interface RenderPrivateEvalSuiteInput {
  config: PrivateModalBenchmarkConfig;
  model: ModalModelSpec;
  targetPath: string;
}

export function privateBenchmarkExecutionControls(config: PrivateModalBenchmarkConfig): {
  strategy_loops: number;
  excluded_node_ids: string[];
} {
  return {
    strategy_loops: config.loops,
    excluded_node_ids: [...config.benchmark_execution.excluded_node_ids]
  };
}

export function renderPrivateEvalSuite(input: RenderPrivateEvalSuiteInput): string {
  const execution = privateBenchmarkExecutionControls(input.config);
  return `schema_version: ultrafuzz.eval.v2
suite: ${yamlString(`modal-${input.model.slug}`)}

model_profiles:
  benchmark:
    agent: ${yamlString(input.model.agent)}
    model: ${yamlString(input.model.model)}
    reasoning: ${yamlString(input.model.reasoning)}

targets:
  - id: target
    repo: ${yamlString(input.config.target.repo)}
    ref: ${yamlString(input.config.target.ref)}
    path: ${yamlString(input.targetPath)}
    sensitivity: private
    ground_truth: findings.yml

variants:
  - id: ${yamlString(input.model.slug)}
    runner_model_profile: benchmark
    judge_model_profile: benchmark
    workflow_input:
      benchmark_execution:
        strategy_loops: ${execution.strategy_loops}
        excluded_node_ids: ${yamlStringArray(execution.excluded_node_ids)}

run:
  runner_model_profile: benchmark
  judge_model_profile: benchmark
  trials_per_variant: 1
  max_parallel_targets: 1
  max_parallel_runs: 1

metrics:
  recall_threshold: 0.7

reporting:
  node_telemetry: true
  heartbeat_interval_seconds: 60
  experiment_prefix: modal
  artifacts:
    mode: manifest-only
    include: ["report.md", "report.json"]
    max_file_bytes: 5000000
`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function yamlStringArray(values: readonly string[]): string {
  return `[${values.map((value) => yamlString(value)).join(", ")}]`;
}
