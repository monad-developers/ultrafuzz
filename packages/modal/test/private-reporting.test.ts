import { expect, it } from "vitest";

import { parseModalBenchmarkConfig, type PrivateModalBenchmarkConfig } from "../src/config.js";
import type { ModalModelSpec } from "../src/defaults.js";
import { MODAL_BENCHMARK_SCHEMA_VERSION } from "../src/defaults.js";
import {
  privateEvalProvider,
  privateEvalPublishCommand,
  privateEvalScoreEnv,
  privateJudgeApiKeyEnv,
  privateJudgeUrl,
  renderPrivateEvalConfigSection
} from "../src/private-reporting.js";
import { modalBenchmarkSecretValues } from "../src/runner.js";

const MODEL: ModalModelSpec = {
  slug: "gpt-5-5",
  model: "gpt-5.5",
  provider: "openai",
  agent: "CodexAgent",
  reasoning: "xhigh",
  auth_mode: "api-key"
};

function privateConfig(
  provider: "braintrust" | "none",
  options: { judgeApiKeyEnv: string; judgeUrl: string } = {
    judgeApiKeyEnv: "OPENAI_API_KEY",
    judgeUrl: "https://api.openai.com/v1/chat/completions"
  }
): PrivateModalBenchmarkConfig {
  const config = parseModalBenchmarkConfig({
    schema_version: MODAL_BENCHMARK_SCHEMA_VERSION,
    run_id: "private-no-braintrust",
    app_name: "ultrafuzz-evals",
    image_name: "ultrafuzz-security-runner:latest",
    target: { repo: "https://github.com/aave/aave-v4", ref: "6959e3219b5506bf2acae18551cbb2a68a5b8fba" },
    ground_truth: {
      repo: "https://github.com/example/ground-truth",
      ref: "main",
      file: "findings.yml",
      format: "ultrafuzz"
    },
    braintrust: {
      project: "private-evals",
      api_key_env: "BRAINTRUST_API_KEY",
      judge_api_key_env: options.judgeApiKeyEnv,
      judge_url: options.judgeUrl,
      judge_credential_ttl_seconds: 57_600
    },
    node_timeout_seconds: 7_200,
    loops: 3,
    models: [MODEL],
    benchmark_execution: { excluded_node_ids: [] },
    eval_reporting: { provider }
  });
  if (!("target" in config)) throw new Error("expected private config");
  return config;
}

it("renders private eval provider none without changing scoring credentials", () => {
  const config = privateConfig("none");

  expect(privateEvalProvider(config)).toBe("none");
  expect(renderPrivateEvalConfigSection(config, "/ground-truth")).toBe(
    `[eval]
eval_config = ".ultrafuzz/evals/bug-finding.yml"
ground_truth_root = "/ground-truth"
provider = "none"
`
  );
  expect(modalBenchmarkSecretValues(config, MODEL, { OPENAI_API_KEY: "openai-secret" })).toEqual({
    OPENAI_API_KEY: "openai-secret"
  });
});

it("uses the explicitly configured private judge credential and endpoint", () => {
  const config = privateConfig("none");

  expect(privateJudgeApiKeyEnv(config)).toBe("OPENAI_API_KEY");
  expect(privateJudgeUrl(config)).toBe("https://api.openai.com/v1/chat/completions");
  expect(privateEvalScoreEnv(config, "judge-secret")).toEqual({
    ULTRAFUZZ_EVAL_JUDGE_API_KEY: "judge-secret",
    ULTRAFUZZ_EVAL_JUDGE_ALLOW_PRIVATE_DATA: "true",
    ULTRAFUZZ_EVAL_JUDGE_URL: "https://api.openai.com/v1/chat/completions"
  });
  expect(modalBenchmarkSecretValues(config, MODEL, { OPENAI_API_KEY: "openai-secret" })).toEqual({
    OPENAI_API_KEY: "openai-secret"
  });
});

it("preserves explicit private judge endpoint overrides", () => {
  const config = privateConfig("none", {
    judgeApiKeyEnv: "PRIVATE_JUDGE_KEY",
    judgeUrl: "https://judge.example.invalid/v1/chat/completions"
  });

  expect(privateJudgeApiKeyEnv(config)).toBe("PRIVATE_JUDGE_KEY");
  expect(privateJudgeUrl(config)).toBe("https://judge.example.invalid/v1/chat/completions");
  expect(privateEvalScoreEnv(config, "judge-secret")).toEqual({
    ULTRAFUZZ_EVAL_JUDGE_API_KEY: "judge-secret",
    ULTRAFUZZ_EVAL_JUDGE_ALLOW_PRIVATE_DATA: "true",
    ULTRAFUZZ_EVAL_JUDGE_URL: "https://judge.example.invalid/v1/chat/completions"
  });
});

it("keeps Braintrust reporting opt-in bound to the fixed Braintrust secret", () => {
  const config = privateConfig("braintrust");

  expect(privateEvalProvider(config)).toBe("braintrust");
  expect(renderPrivateEvalConfigSection(config, "/ground-truth")).toContain('provider = "braintrust"');
  expect(() => modalBenchmarkSecretValues(config, MODEL, { OPENAI_API_KEY: "openai-secret" })).toThrow(
    /BRAINTRUST_API_KEY/u
  );
  expect(
    modalBenchmarkSecretValues(config, MODEL, {
      BRAINTRUST_API_KEY: "braintrust-secret",
      OPENAI_API_KEY: "openai-secret"
    })
  ).toEqual({
    BRAINTRUST_API_KEY: "braintrust-secret",
    OPENAI_API_KEY: "openai-secret"
  });
});

it("skips eval publish when private eval reporting is disabled", () => {
  expect(
    privateEvalPublishCommand({
      cliPath: "/opt/ultrafuzz/packages/cli/dist/index.js",
      controlRoot: "/workspace/control",
      evalRunId: "eval-one",
      provider: "none"
    })
  ).toBeUndefined();

  expect(
    privateEvalPublishCommand({
      cliPath: "/opt/ultrafuzz/packages/cli/dist/index.js",
      controlRoot: "/workspace/control",
      evalRunId: "eval-one",
      provider: "braintrust"
    })
  ).toEqual([
    "node",
    "/opt/ultrafuzz/packages/cli/dist/index.js",
    "eval",
    "publish",
    "eval-one",
    "--project",
    "/workspace/control",
    "--provider",
    "braintrust",
    "--resume",
    "--json"
  ]);
});
