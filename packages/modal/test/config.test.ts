import { describe, expect, it } from "vitest";

import { parseModalBenchmarkConfig } from "../src/config.js";
import { DEFAULT_BENCHMARK_MODELS, MODAL_BENCHMARK_SCHEMA_VERSION } from "../src/defaults.js";

function minimalConfig(): Record<string, unknown> {
  return {
    schema_version: MODAL_BENCHMARK_SCHEMA_VERSION,
    run_id: "example-run",
    target: { repo: "https://example.invalid/target.git", ref: "0123456789abcdef" },
    ground_truth: {
      repo: "https://example.invalid/ground-truth.git",
      ref: "fedcba9876543210",
      file: "findings.yml"
    },
    braintrust: { project: "example-evals" }
  };
}

describe("Modal benchmark config", () => {
  it("defaults to the six benchmark models and one loop", () => {
    const config = parseModalBenchmarkConfig(minimalConfig());

    expect(config.loops).toBe(1);
    expect(config.models).toEqual(DEFAULT_BENCHMARK_MODELS);
    expect(config.models.map((model) => model.model)).toEqual([
      "gpt-5.5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "claude-fable-5",
      "claude-opus-4-8"
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

  it("requires provider and agent pairs to match", () => {
    expect(() =>
      parseModalBenchmarkConfig({
        ...minimalConfig(),
        models: [{ ...DEFAULT_BENCHMARK_MODELS[0], agent: "ClaudeAgent" }]
      })
    ).toThrow(/provider and agent/u);
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

    expect(config.ground_truth.expected_findings).toBe(2);
    expect(config.braintrust.judge_credential_ttl_seconds).toBe(57_600);
  });
});
