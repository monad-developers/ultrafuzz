import type { PrivateModalBenchmarkConfig } from "./config.js";

export type PrivateEvalProvider = "braintrust" | "none";

export function privateEvalProvider(config: PrivateModalBenchmarkConfig): PrivateEvalProvider {
  return config.eval_reporting.provider;
}

export function privateJudgeApiKeyEnv(config: PrivateModalBenchmarkConfig): string {
  return config.braintrust.judge_api_key_env;
}

export function privateJudgeUrl(config: PrivateModalBenchmarkConfig): string {
  return config.braintrust.judge_url;
}

export function privateEvalScoreEnv(
  config: PrivateModalBenchmarkConfig,
  judgeCredential: string
): Record<string, string> {
  return {
    ULTRAFUZZ_EVAL_JUDGE_API_KEY: judgeCredential,
    ULTRAFUZZ_EVAL_JUDGE_ALLOW_PRIVATE_DATA: "true",
    ULTRAFUZZ_EVAL_JUDGE_URL: privateJudgeUrl(config)
  };
}

export function renderPrivateEvalConfigSection(config: PrivateModalBenchmarkConfig, groundTruthRoot: string): string {
  return `[eval]
eval_config = ".ultrafuzz/evals/bug-finding.yml"
ground_truth_root = ${tomlString(groundTruthRoot)}
provider = ${tomlString(privateEvalProvider(config))}
`;
}

export function privateEvalPublishCommand(input: {
  cliPath: string;
  controlRoot: string;
  evalRunId: string;
  provider: PrivateEvalProvider;
}): string[] | undefined {
  if (input.provider === "none") return undefined;
  return [
    "node",
    input.cliPath,
    "eval",
    "publish",
    input.evalRunId,
    "--project",
    input.controlRoot,
    "--provider",
    input.provider,
    "--resume",
    "--json"
  ];
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
