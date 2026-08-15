import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  configuredModalSandboxTimeoutMs,
  fingerprintModalConfigFile,
  fingerprintModalModel,
  loadModalBenchmarkConfig,
  MODAL_GIT_URL_PATTERN_SOURCE,
  MODAL_HTTPS_URL_PATTERN_SOURCE,
  modalBenchmarkConfigZodSchema,
  modalBenchmarkConfigValidatorsAgree,
  parseModalBenchmarkConfig
} from "../src/config.js";
import {
  DEFAULT_BENCHMARK_MODELS,
  MODAL_BENCHMARK_SCHEMA_VERSION,
  MODAL_PUBLIC_FULL_SANDBOX_TIMEOUT_MS,
  MODAL_PUBLIC_SANDBOX_TIMEOUT_MS,
  MODAL_SANDBOX_TIMEOUT_MS
} from "../src/defaults.js";
import { MODAL_BENCHMARK_CONFIG_SCHEMA_ID } from "../src/modal-contracts.js";
import { ModalDocumentValidationError } from "../src/modal-documents.js";
import { modalBenchmarkConfigJsonSchema, validateModalJsonSchema } from "../src/modal-schema-registry.js";
import { ModalSemanticValidationError } from "../src/modal-semantic-gates.js";

function minimalConfig(): Record<string, unknown> {
  return {
    ...commonConfig("example-run", [...DEFAULT_BENCHMARK_MODELS]),
    target: { repo: "https://example.invalid/target.git", ref: "0123456789abcdef" },
    ground_truth: {
      repo: "https://example.invalid/ground-truth.git",
      ref: "fedcba9876543210",
      file: "findings.yml",
      format: "ultrafuzz"
    },
    benchmark_execution: { excluded_node_ids: [] },
    eval_reporting: { provider: "braintrust" }
  };
}

function commonConfig(runId: string, models: unknown[]): Record<string, unknown> {
  return {
    schema_version: MODAL_BENCHMARK_SCHEMA_VERSION,
    run_id: runId,
    app_name: "ultrafuzz-evals",
    image_name: "ultrafuzz-security-runner:latest",
    braintrust: {
      project: "example-evals",
      api_key_env: "BRAINTRUST_API_KEY",
      judge_api_key_env: "OPENAI_API_KEY",
      judge_url: "https://api.openai.com/v1/chat/completions",
      judge_credential_ttl_seconds: 57_600
    },
    node_timeout_seconds: 7_200,
    loops: 3,
    models
  };
}

function minimalPublicConfig() {
  const model = DEFAULT_BENCHMARK_MODELS[0]!;
  return {
    ...commonConfig("public-run", [model]),
    public_benchmark: {
      benchmark: "evmbench" as const,
      lane: "smoke" as const,
      runner_model_profile: model.slug,
      candidate_repository: "https://github.com/monad-developers/ultrafuzz",
      candidate_commit: "a".repeat(40),
      targets: [
        {
          id: "target-one",
          repository: "https://github.com/example/target",
          revision: "b".repeat(40),
          framework: "foundry"
        }
      ],
      max_runtime_seconds: 3_600
    }
  };
}

function privateRepositoryVariant(scope: "ground_truth" | "target", repository: string): Record<string, unknown> {
  const config = minimalConfig();
  config[scope] = { ...(config[scope] as Record<string, unknown>), repo: repository };
  return config;
}

function braintrustUrlVariant(field: "judge_credential_endpoint" | "judge_url", url: string): Record<string, unknown> {
  const config = minimalConfig();
  config.braintrust = { ...(config.braintrust as Record<string, unknown>), [field]: url };
  return config;
}

function publicRepositoryVariant(scope: "candidate" | "target", repository: string): Record<string, unknown> {
  const config = minimalPublicConfig();
  const benchmark = config.public_benchmark;
  config.public_benchmark =
    scope === "candidate"
      ? { ...benchmark, candidate_repository: repository }
      : {
          ...benchmark,
          targets: [{ ...benchmark.targets[0]!, repository }]
        };
  return config;
}

function expectBenchmarkConfigIdentityGate(value: unknown): void {
  try {
    parseModalBenchmarkConfig(value);
    throw new Error("expected benchmark config semantic validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ModalDocumentValidationError);
    const cause = (error as ModalDocumentValidationError).cause;
    expect(cause).toBeInstanceOf(ModalSemanticValidationError);
    expect((cause as ModalSemanticValidationError).gate).toBe("modal-benchmark-config-identity");
  }
}

describe("Modal benchmark config", () => {
  it("uses identical portable URL lexical rules in JSON Schema and retained Zod", () => {
    const definitions = modalBenchmarkConfigJsonSchema.$defs as Record<string, Record<string, unknown>>;
    expect(definitions.gitUrl?.pattern).toBe(MODAL_GIT_URL_PATTERN_SOURCE);
    expect(definitions.httpsUrl?.pattern).toBe(MODAL_HTTPS_URL_PATTERN_SOURCE);
    expect(definitions.gitUrl).not.toHaveProperty("format");
    expect(definitions.httpsUrl).not.toHaveProperty("format");

    const cases: Array<{ label: string; value: unknown; accepted: boolean }> = [
      {
        label: "an SSH repository URL",
        value: privateRepositoryVariant("target", "ssh://git@github.com/example/target.git"),
        accepted: true
      },
      {
        label: "a git repository URL",
        value: privateRepositoryVariant("ground_truth", "git://git.example.invalid/reference-data.git"),
        accepted: true
      },
      {
        label: "an encoded credential-free HTTPS endpoint",
        value: braintrustUrlVariant(
          "judge_credential_endpoint",
          "https://gateway.example.invalid/v1/credentials%20temporary?mode=short#request"
        ),
        accepted: true
      },
      {
        label: "an at-sign outside the HTTPS authority",
        value: braintrustUrlVariant(
          "judge_url",
          "https://gateway.example.invalid/v1/user@example.invalid/chat?model=gpt-5.6-sol"
        ),
        accepted: true
      },
      {
        label: "a malformed repository percent escape",
        value: privateRepositoryVariant("target", "https://example.invalid/target%zz.git"),
        accepted: false
      },
      {
        label: "a repository URI without an authority",
        value: privateRepositoryVariant("ground_truth", "urn:example:reference-data"),
        accepted: false
      },
      {
        label: "a normalization-prone repository backslash",
        value: privateRepositoryVariant("target", "https://example.invalid\\target.git"),
        accepted: false
      },
      {
        label: "an uppercase HTTPS scheme",
        value: braintrustUrlVariant("judge_url", "HTTPS://gateway.example.invalid/v1/chat"),
        accepted: false
      },
      {
        label: "embedded HTTPS credentials",
        value: braintrustUrlVariant(
          "judge_credential_endpoint",
          "https://user:secret@gateway.example.invalid/v1/credentials"
        ),
        accepted: false
      },
      {
        label: "a whitespace-padded public candidate URL",
        value: publicRepositoryVariant("candidate", " https://github.com/example/candidate "),
        accepted: false
      },
      {
        label: "a Unicode public target host",
        value: publicRepositoryVariant("target", "https://éxample.invalid/target"),
        accepted: false
      },
      {
        label: "an HTTPS URL without an authority",
        value: publicRepositoryVariant("target", "https:///target"),
        accepted: false
      }
    ];

    for (const { label, value, accepted } of cases) {
      const jsonSchema = validateModalJsonSchema(MODAL_BENCHMARK_CONFIG_SCHEMA_ID, value);
      const retainedZod = modalBenchmarkConfigZodSchema.safeParse(value);
      expect(jsonSchema.ok, `${label}: JSON Schema`).toBe(accepted);
      expect(retainedZod.success, `${label}: retained Zod`).toBe(accepted);
      if (retainedZod.success) expect(retainedZod.data).toEqual(value);
      expect(modalBenchmarkConfigValidatorsAgree(value), label).toBe(true);
    }
  });

  it("bounds new public sandboxes without cutting off the accepted full-lane envelope", () => {
    const privateConfig = parseModalBenchmarkConfig(minimalConfig());
    const model = DEFAULT_BENCHMARK_MODELS[0]!;
    const publicConfig = parseModalBenchmarkConfig({
      ...commonConfig("public-run", [model]),
      public_benchmark: {
        benchmark: "ultrafuzz-bench",
        lane: "smoke",
        runner_model_profile: model.slug,
        candidate_repository: "https://github.com/monad-developers/ultrafuzz",
        candidate_commit: "a".repeat(40),
        targets: [
          {
            id: "target-one",
            repository: "https://github.com/example/target",
            revision: "b".repeat(40),
            framework: "foundry"
          }
        ],
        max_runtime_seconds: 3_600
      }
    });
    if (!("public_benchmark" in publicConfig)) throw new Error("expected a public benchmark config");
    const publicFullConfig = parseModalBenchmarkConfig({
      ...publicConfig,
      run_id: "public-full-run",
      public_benchmark: { ...publicConfig.public_benchmark, benchmark: "evmbench", lane: "full" }
    });

    expect(configuredModalSandboxTimeoutMs(publicConfig)).toBe(MODAL_PUBLIC_SANDBOX_TIMEOUT_MS);
    expect(configuredModalSandboxTimeoutMs(publicFullConfig)).toBe(MODAL_PUBLIC_FULL_SANDBOX_TIMEOUT_MS);
    expect(configuredModalSandboxTimeoutMs(privateConfig)).toBe(MODAL_SANDBOX_TIMEOUT_MS);
  });

  it("requires every operational value instead of defaulting omitted configuration", () => {
    const config = minimalConfig();
    expect(parseModalBenchmarkConfig(config)).toBe(config);

    for (const field of ["app_name", "image_name", "node_timeout_seconds", "loops", "models"] as const) {
      const missing = { ...minimalConfig() };
      delete missing[field];
      expect(() => parseModalBenchmarkConfig(missing), field).toThrow();
    }

    const missingNested = minimalConfig();
    delete (missingNested.braintrust as Record<string, unknown>).judge_credential_ttl_seconds;
    expect(() => parseModalBenchmarkConfig(missingNested)).toThrow();
  });

  it("rejects inline secret fields and duplicate model slugs", () => {
    expect(() =>
      parseModalBenchmarkConfig({
        ...minimalConfig(),
        braintrust: { project: "example-evals", api_key: "must-not-be-accepted" }
      })
    ).toThrow();

    expect(() =>
      parseModalBenchmarkConfig({
        ...minimalConfig(),
        models: [DEFAULT_BENCHMARK_MODELS[0], DEFAULT_BENCHMARK_MODELS[0]]
      })
    ).toThrow();
  });

  it.each([
    {
      label: "duplicate projected model slugs",
      value: {
        ...minimalConfig(),
        models: [DEFAULT_BENCHMARK_MODELS[0], DEFAULT_BENCHMARK_MODELS[0]]
      }
    },
    {
      label: "a public runner-profile mismatch",
      value: {
        ...minimalPublicConfig(),
        public_benchmark: {
          ...minimalPublicConfig().public_benchmark,
          runner_model_profile: "different-profile"
        }
      }
    },
    {
      label: "duplicate projected public target IDs",
      value: {
        ...minimalPublicConfig(),
        public_benchmark: {
          ...minimalPublicConfig().public_benchmark,
          targets: [
            minimalPublicConfig().public_benchmark.targets[0],
            {
              ...minimalPublicConfig().public_benchmark.targets[0],
              revision: "c".repeat(40)
            }
          ]
        }
      }
    }
  ])("keeps $label out of both shape validators and rejects it in the named gate", ({ value }) => {
    expect(validateModalJsonSchema(MODAL_BENCHMARK_CONFIG_SCHEMA_ID, value).ok).toBe(true);
    const retained = modalBenchmarkConfigZodSchema.safeParse(value);
    expect(retained.success).toBe(true);
    if (retained.success) expect(retained.data).toEqual(value);
    expect(modalBenchmarkConfigValidatorsAgree(value)).toBe(true);
    expectBenchmarkConfigIdentityGate(value);
  });

  it("requires provider and agent pairs to match", () => {
    expect(() =>
      parseModalBenchmarkConfig({
        ...minimalConfig(),
        models: [{ ...DEFAULT_BENCHMARK_MODELS[0], agent: "ClaudeAgent" }]
      })
    ).toThrow();
  });

  it("accepts Kimi K3 model configs with the Kimi agent", () => {
    const config = parseModalBenchmarkConfig({
      ...minimalConfig(),
      models: [
        {
          slug: "kimi-k3",
          model: "kimi-k3",
          provider: "kimi",
          agent: "KimiAgent",
          reasoning: "max",
          auth_mode: "subscription"
        }
      ]
    });

    expect(config.models[0]).toEqual({
      slug: "kimi-k3",
      model: "kimi-k3",
      provider: "kimi",
      agent: "KimiAgent",
      reasoning: "max",
      auth_mode: "subscription"
    });
  });

  it("rejects Kimi reasoning values that Kimi Code 0.29.1 cannot execute", () => {
    expect(() =>
      parseModalBenchmarkConfig({
        ...minimalConfig(),
        models: [
          {
            slug: "kimi-k3",
            model: "kimi-k3",
            provider: "kimi",
            agent: "KimiAgent",
            reasoning: "xhigh",
            auth_mode: "api-key"
          }
        ]
      })
    ).toThrow();
  });

  it("rejects whitespace-padded Kimi reasoning values", () => {
    expect(() =>
      parseModalBenchmarkConfig({
        ...minimalConfig(),
        models: [
          {
            slug: "kimi-k3",
            model: "kimi-k3",
            provider: "kimi",
            agent: "KimiAgent",
            reasoning: " max ",
            auth_mode: "api-key"
          }
        ]
      })
    ).toThrow();
  });

  it("accepts only supported DeepSeek V4 API-key model configs", () => {
    const deepseek = {
      slug: "deepseek-v4-pro",
      model: "deepseek-v4-pro",
      provider: "deepseek",
      agent: "DeepSeekAgent",
      reasoning: "max",
      auth_mode: "api-key"
    } as const;

    const config = parseModalBenchmarkConfig({ ...minimalConfig(), models: [deepseek] });
    expect(config.models[0]).toEqual(deepseek);
    expect(() =>
      parseModalBenchmarkConfig({
        ...minimalConfig(),
        models: [{ ...deepseek, reasoning: "xhigh" }]
      })
    ).toThrow();
    expect(() =>
      parseModalBenchmarkConfig({
        ...minimalConfig(),
        models: [{ ...deepseek, auth_mode: "subscription" }]
      })
    ).toThrow();
  });

  it("accepts opaque OpenRouter catalogue IDs without rewriting them", () => {
    const model = "~vendor/model.latest:free+preview@2026";
    const routed = {
      slug: "openrouter-smoke",
      model,
      provider: "openrouter",
      agent: "OpenRouterAgent",
      reasoning: "high",
      auth_mode: "api-key"
    } as const;
    const config = parseModalBenchmarkConfig({ ...minimalConfig(), models: [routed] });
    expect(config.models[0]).toEqual(routed);
    expect(() =>
      parseModalBenchmarkConfig({ ...minimalConfig(), models: [{ ...routed, auth_mode: "subscription" }] })
    ).toThrow();
    expect(() =>
      parseModalBenchmarkConfig({ ...minimalConfig(), models: [{ ...routed, model: "vendor/model bad" }] })
    ).toThrow();
    expect(() =>
      parseModalBenchmarkConfig({ ...minimalConfig(), models: [{ ...routed, model: "vendor/model\u0080control" }] })
    ).toThrow();
  });

  it("accepts audit Markdown conversion and temporary judge credentials", () => {
    const config = parseModalBenchmarkConfig({
      ...minimalConfig(),
      ground_truth: {
        repo: "https://example.invalid/reference-data.git",
        ref: "fedcba9876543210",
        file: "report.md",
        format: "audit-markdown",
        expected_findings: 2
      },
      braintrust: {
        ...(minimalConfig().braintrust as Record<string, unknown>),
        judge_api_key_env: "JUDGE_KEY",
        judge_url: "https://gateway.example.invalid/v1/chat/completions",
        judge_credential_endpoint: "https://gateway.example.invalid/v1/credentials",
        judge_credential_ttl_seconds: 900
      }
    });

    expect("ground_truth" in config && config.ground_truth.expected_findings).toBe(2);
    expect(config.braintrust.judge_credential_ttl_seconds).toBe(900);
  });

  it("accepts bounded private benchmark execution controls", () => {
    const config = parseModalBenchmarkConfig({
      ...minimalConfig(),
      loops: 1,
      benchmark_execution: {
        excluded_node_ids: ["boundary-tests", "dynamic-strategy-generator"]
      }
    });

    expect("target" in config && config.benchmark_execution).toEqual({
      excluded_node_ids: ["boundary-tests", "dynamic-strategy-generator"]
    });
  });

  it("rejects unsafe private benchmark execution controls", () => {
    expect(() =>
      parseModalBenchmarkConfig({
        ...minimalConfig(),
        benchmark_execution: {
          excluded_node_ids: ["../outside"]
        }
      })
    ).toThrow();

    expect(() =>
      parseModalBenchmarkConfig({
        ...minimalConfig(),
        benchmark_execution: {
          excluded_node_ids: [""]
        }
      })
    ).toThrow();

    expect(() =>
      parseModalBenchmarkConfig({
        ...minimalConfig(),
        benchmark_execution: {
          excluded_node_ids: ["boundary-tests"],
          unexpected: true
        }
      })
    ).toThrow();
  });

  it("accepts private eval reporting provider controls", () => {
    const config = parseModalBenchmarkConfig({
      ...minimalConfig(),
      eval_reporting: { provider: "none" }
    });

    expect("target" in config && config.eval_reporting).toEqual({ provider: "none" });

    expect(() =>
      parseModalBenchmarkConfig({
        ...minimalConfig(),
        eval_reporting: { provider: "openai" }
      })
    ).toThrow();

    expect(() =>
      parseModalBenchmarkConfig({
        ...minimalConfig(),
        eval_reporting: { provider: "none", unexpected: true }
      })
    ).toThrow();
  });

  it("accepts only an explicit strict public benchmark shape", () => {
    const model = {
      slug: "benchmark-smoke-gpt-5-6-luna-high",
      model: "gpt-5.6-luna",
      provider: "openai",
      agent: "CodexAgent",
      reasoning: "high",
      auth_mode: "api-key"
    } as const;
    const config = parseModalBenchmarkConfig({
      ...commonConfig("public-main-a1b2c3", [model]),
      public_benchmark: {
        benchmark: "evmbench",
        lane: "full",
        runner_model_profile: "benchmark-smoke-gpt-5-6-luna-high",
        candidate_repository: "https://github.com/monad-developers/ultrafuzz",
        candidate_commit: "a".repeat(40),
        targets: [
          {
            id: "target-one",
            repository: "https://github.com/example/target-one",
            revision: "b".repeat(40),
            framework: "foundry"
          }
        ],
        max_runtime_seconds: 3_600
      }
    });

    expect("public_benchmark" in config && config.public_benchmark.max_runtime_seconds).toBe(3_600);
    expect(() =>
      parseModalBenchmarkConfig({
        ...config,
        target: { repo: "https://example.invalid/target.git", ref: "main" }
      })
    ).toThrow();
    if (!("public_benchmark" in config)) throw new Error("expected a public benchmark config");
    expect(() =>
      parseModalBenchmarkConfig({
        ...config,
        public_benchmark: {
          ...config.public_benchmark,
          excluded_node_ids: ["unexpected-node"]
        }
      })
    ).toThrow();
    expect(() =>
      parseModalBenchmarkConfig({
        ...config,
        models: [{ ...config.models[0]!, slug: "different-profile" }]
      })
    ).toThrow();
  });

  it("fingerprints exact configuration bytes and every model field", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-modal-config-"));
    const file = path.join(root, "config.json");
    fs.writeFileSync(file, `${JSON.stringify(minimalConfig())}\n`);
    const first = fingerprintModalConfigFile(file);
    fs.writeFileSync(file, `${JSON.stringify(minimalConfig(), null, 2)}\n`);
    expect(fingerprintModalConfigFile(file)).not.toBe(first);
    expect(fingerprintModalModel(DEFAULT_BENCHMARK_MODELS[0]!)).not.toBe(
      fingerprintModalModel({ ...DEFAULT_BENCHMARK_MODELS[0]!, reasoning: "different" })
    );
  });

  it("strictly loads one registered v2 document without repair or conversion", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-modal-config-strict-"));
    const file = path.join(root, "config.json");
    const config = minimalConfig();
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    expect(loadModalBenchmarkConfig(file)).toEqual(config);

    const duplicate = `${JSON.stringify(config, null, 2)}\n`.replace(
      '"run_id": "example-run",',
      '"run_id": "example-run",\n  "run_id": "different-run",'
    );
    fs.writeFileSync(file, duplicate);
    expect(() => loadModalBenchmarkConfig(file)).toThrow(/duplicate/iu);

    fs.writeFileSync(file, `${JSON.stringify({ ...config, schema_version: "ultrafuzz.modal.benchmark.v1" })}\n`);
    expect(() => loadModalBenchmarkConfig(file)).toThrow();

    fs.writeFileSync(
      file,
      `${JSON.stringify({
        ...config,
        models: [DEFAULT_BENCHMARK_MODELS[0], DEFAULT_BENCHMARK_MODELS[0]]
      })}\n`
    );
    expect(() => loadModalBenchmarkConfig(file)).toThrow(/trusted semantic gates/u);
  });

  it("keeps the nontransforming Zod parser aligned with canonical JSON Schema", () => {
    const valid = minimalConfig();
    const variants: unknown[] = [
      valid,
      { ...valid, unexpected: true },
      { ...valid, loops: "3" },
      { ...valid, models: [DEFAULT_BENCHMARK_MODELS[0], DEFAULT_BENCHMARK_MODELS[0]] },
      {
        ...valid,
        benchmark_execution: { excluded_node_ids: ["boundary-tests", "boundary-tests"] }
      },
      { ...valid, schema_version: "ultrafuzz.modal.benchmark.v1" }
    ];
    for (const variant of variants) expect(modalBenchmarkConfigValidatorsAgree(variant)).toBe(true);
  });
});
