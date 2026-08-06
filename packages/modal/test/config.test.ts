import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { fingerprintModalConfigFile, fingerprintModalModel, parseModalBenchmarkConfig } from "../src/config.js";
import { DEFAULT_BENCHMARK_MODELS, MODAL_BENCHMARK_SCHEMA_VERSION } from "../src/defaults.js";

function minimalConfig(): Record<string, unknown> {
  return {
    schema_version: MODAL_BENCHMARK_SCHEMA_VERSION,
    run_id: "example-run",
    target: { repo: "https://example.invalid/target.git", ref: "0".repeat(40) },
    ground_truth: {
      repo: "https://example.invalid/ground-truth.git",
      ref: "fedcba9876543210",
      file: "findings.yml"
    },
    braintrust: { project: "example-evals" }
  };
}

describe("Modal benchmark config", () => {
  it("defaults to the eight benchmark models and production strategy loops", () => {
    const config = parseModalBenchmarkConfig(minimalConfig());

    expect(config.loops).toBe(3);
    expect(config.models).toEqual(DEFAULT_BENCHMARK_MODELS);
    expect(config.models.map((model) => model.model)).toEqual([
      "gpt-5.5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "claude-fable-5",
      "claude-opus-4-8",
      "kimi-k3",
      "deepseek-v4-pro"
    ]);
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
    ).toThrow(/duplicate model slug/u);
  });

  it("requires private targets pinned to exact lowercase commits while allowing ground-truth Git refs", () => {
    const config = parseModalBenchmarkConfig({
      ...minimalConfig(),
      ground_truth: {
        repo: "https://example.invalid/ground-truth.git",
        ref: "main",
        file: "findings.yml"
      }
    });

    expect("target" in config && config.target.ref).toBe("0".repeat(40));
    expect("ground_truth" in config && config.ground_truth.ref).toBe("main");

    for (const ref of ["main", "a".repeat(39), "A".repeat(40), `${"a".repeat(40)} `]) {
      expect(() =>
        parseModalBenchmarkConfig({
          ...minimalConfig(),
          target: { repo: "https://example.invalid/target.git", ref }
        })
      ).toThrow(/exact 40-character lowercase hexadecimal commit SHA/u);
    }
  });

  it("requires provider and agent pairs to match", () => {
    expect(() =>
      parseModalBenchmarkConfig({
        ...minimalConfig(),
        models: [{ ...DEFAULT_BENCHMARK_MODELS[0], agent: "ClaudeAgent" }]
      })
    ).toThrow(/provider and agent/u);
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
    ).toThrow(/Kimi reasoning must be low, high, or max/u);
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
    ).toThrow(/Kimi reasoning must be low, high, or max/u);
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
    ).toThrow(/DeepSeek reasoning must be low, high, or max/u);
    expect(() =>
      parseModalBenchmarkConfig({
        ...minimalConfig(),
        models: [{ ...deepseek, auth_mode: "subscription" }]
      })
    ).toThrow(/DeepSeek authentication must use an API key/u);
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
        project: "example-evals",
        judge_api_key_env: "JUDGE_KEY",
        judge_url: "https://gateway.example.invalid/v1/chat/completions",
        judge_credential_endpoint: "https://gateway.example.invalid/v1/credentials"
      }
    });

    expect("ground_truth" in config && config.ground_truth.expected_findings).toBe(2);
    expect(config.braintrust.judge_credential_ttl_seconds).toBe(57_600);
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

  it("accepts only the strict public benchmark shape and its one-hour default", () => {
    const config = parseModalBenchmarkConfig({
      schema_version: MODAL_BENCHMARK_SCHEMA_VERSION,
      run_id: "public-main-a1b2c3",
      public_benchmark: {
        benchmark: "evmbench",
        runner_model_profile: "benchmark-smoke-gpt-5-6-luna-high",
        candidate_repository: "https://github.com/monad-developers/ultrafuzz",
        candidate_commit: "a".repeat(40)
      },
      braintrust: { project: "ultrafuzz-public-benchmarks", judge_api_key_env: "OPENAI_API_KEY" },
      models: [
        {
          slug: "benchmark-smoke-gpt-5-6-luna-high",
          model: "gpt-5.6-luna",
          provider: "openai",
          agent: "CodexAgent",
          reasoning: "high",
          auth_mode: "api-key"
        }
      ]
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
    ).toThrow(/selected runner model profile/u);
  });

  it("fingerprints exact configuration bytes and every model field", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ultrafuzz-modal-config-"));
    const file = path.join(root, "config.json");
    fs.writeFileSync(file, '{"value":1}\n');
    const first = fingerprintModalConfigFile(file);
    fs.writeFileSync(file, '{ "value": 1 }\n');
    expect(fingerprintModalConfigFile(file)).not.toBe(first);
    expect(fingerprintModalModel(DEFAULT_BENCHMARK_MODELS[0]!)).not.toBe(
      fingerprintModalModel({ ...DEFAULT_BENCHMARK_MODELS[0]!, reasoning: "different" })
    );
  });
});
