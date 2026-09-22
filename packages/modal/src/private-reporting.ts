import type { PrivateModalBenchmarkConfig } from "./config.js";
import { tomlString } from "./workspace-config.js";

export function privateJudgeApiKeyEnv(config: PrivateModalBenchmarkConfig): string {
  return config.judge.api_key_env;
}

export function privateJudgeUrl(config: PrivateModalBenchmarkConfig): string {
  return config.judge.url;
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

export function renderPrivateEvalConfigSection(groundTruthRoot: string): string {
  return `[eval]
eval_config = ".ultrafuzz/evals/bug-finding.yml"
ground_truth_root = ${tomlString(groundTruthRoot)}
provider = "none"
`;
}
