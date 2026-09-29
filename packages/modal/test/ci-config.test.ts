import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MODAL_PUBLIC_FULL_SANDBOX_TIMEOUT_MS } from "../src/defaults.js";
import {
  PUBLIC_BENCHMARK_EVAL_CLEANUP_SECONDS,
  PUBLIC_BENCHMARK_PREPARATION_TIMEOUT_SECONDS,
  PUBLIC_BENCHMARK_REPORT_TIMEOUT_SECONDS,
  PUBLIC_BENCHMARK_SCORE_PER_WAVE_TIMEOUT_SECONDS,
  publicBenchmarkMaxParallelEvalRows,
  publicBenchmarkMaxParallelWorkflowNodes,
  publicBenchmarkMaxRuntimeSeconds
} from "../src/public-worker.js";

interface BenchmarkTarget {
  id: string;
  repository: string;
  revision: string;
  framework: string;
}

describe("public Modal benchmark configuration", () => {
  it("creates the exact three-target OpenAI smoke benchmark with bounded row and control budgets", () => {
    const workspace = path.resolve("../..");
    const output = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-modal-ci-"));
    execFileSync(
      process.execPath,
      [
        path.join(workspace, "scripts/ci/prepare-modal-benchmarks.mjs"),
        "a".repeat(40),
        "https://github.com/monad-developers/ultrafuzz",
        "12345-1",
        output,
        "smoke"
      ],
      { cwd: workspace }
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8")) as {
      schema_version: string;
      mode: string;
      benchmark: string;
      execution: { mode: string; dry_run: boolean };
      targets: BenchmarkTarget[];
      pairs: Array<{ benchmark: string; model_slug: string; provider: string; config_path: string }>;
      image_name: string;
      matrix_rows_per_pair: number;
      control_timeout_seconds: number;
      concurrency: {
        max_parallel_eval_rows_per_sandbox: number;
        max_parallel_workflow_nodes_per_row: number;
        max_live_runner_workflows_by_provider: Record<string, number>;
        max_live_judge_rows: number;
      };
    };
    expect(manifest.schema_version).toBe("ultrafuzz.modal.benchmark-control-manifest.v1");
    expect(manifest.mode).toBe("smoke");
    expect(manifest).not.toHaveProperty("experiment");
    expect(manifest.benchmark).toBe("ultrafuzz-bench");
    expect(manifest.execution).toEqual({ mode: "modal", dry_run: false });
    const cohort = JSON.parse(
      fs.readFileSync(path.join(workspace, "benchmarks/ultrafuzzbench/cohort.json"), "utf8")
    ) as {
      smoke_targets: string[];
      targets: BenchmarkTarget[];
    };
    const expectedTargets = cohort.smoke_targets.map((id) => cohort.targets.find((target) => target.id === id));
    expect(manifest.targets).toEqual(expectedTargets);
    expect(manifest.targets).toHaveLength(3);
    expect(new Set(manifest.targets.map((target) => target.id)).size).toBe(3);
    expect(manifest.pairs).toHaveLength(1);
    expect(manifest.pairs[0]).toEqual(
      expect.objectContaining({
        benchmark: "ultrafuzz-bench",
        model_slug: "benchmark-smoke-gpt-5-6-luna-high",
        provider: "openai"
      })
    );
    expect(manifest.image_name).toBe(`ufz-runner-${"a".repeat(40)}`);
    expect(manifest.matrix_rows_per_pair).toBe(3);
    const maxParallel = publicBenchmarkMaxParallelEvalRows("smoke");
    const matrixWaves = Math.ceil(manifest.matrix_rows_per_pair / maxParallel);
    const workerEnvelopeSeconds =
      matrixWaves * publicBenchmarkMaxRuntimeSeconds("smoke") +
      PUBLIC_BENCHMARK_EVAL_CLEANUP_SECONDS +
      matrixWaves * PUBLIC_BENCHMARK_SCORE_PER_WAVE_TIMEOUT_SECONDS +
      PUBLIC_BENCHMARK_REPORT_TIMEOUT_SECONDS;
    expect(manifest.control_timeout_seconds).toBe(
      workerEnvelopeSeconds + PUBLIC_BENCHMARK_PREPARATION_TIMEOUT_SECONDS + 5 * 60
    );
    expect(manifest.control_timeout_seconds).toBe(19_800);
    expect(manifest.control_timeout_seconds).toBeLessThan(6 * 60 * 60);
    expect(manifest.concurrency).toEqual({
      max_parallel_eval_rows_per_sandbox: maxParallel,
      max_parallel_workflow_nodes_per_row: publicBenchmarkMaxParallelWorkflowNodes("smoke"),
      max_live_runner_workflows_by_provider: { openai: Math.min(3, maxParallel) },
      max_live_judge_rows: Math.min(3, maxParallel)
    });
    for (const pair of manifest.pairs) {
      const config = JSON.parse(fs.readFileSync(path.join(output, pair.config_path), "utf8")) as {
        node_timeout_seconds: number;
        public_benchmark: {
          benchmark: string;
          lane: string;
          targets: BenchmarkTarget[];
          max_runtime_seconds: number;
        };
        judge: { api_key_env: string; url: string; credential_ttl_seconds: number };
        models: Array<{ model: string; provider: string; agent: string; reasoning: string }>;
      };
      expect(config.node_timeout_seconds).toBe(1800);
      expect(config.public_benchmark).toEqual(
        expect.objectContaining({ benchmark: "ultrafuzz-bench", lane: "smoke", max_runtime_seconds: 15_000 })
      );
      expect(config.public_benchmark.targets).toEqual(manifest.targets);
      expect(config.judge).toEqual({
        api_key_env: "OPENAI_API_KEY",
        url: "https://api.openai.com/v1/chat/completions",
        credential_ttl_seconds: 57_600
      });
      expect(config).not.toHaveProperty("braintrust");
      expect(config).not.toHaveProperty("eval_reporting");
      expect(config.models).toEqual([
        expect.objectContaining({
          model: "gpt-5.6-luna",
          provider: "openai",
          agent: "CodexAgent",
          reasoning: "high"
        })
      ]);
    }
  });

  it("creates the complete four-provider EVMBench full mode from the checked-in cohort", () => {
    const workspace = path.resolve("../..");
    const output = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-modal-full-"));
    execFileSync(
      process.execPath,
      [
        path.join(workspace, "scripts/ci/prepare-modal-benchmarks.mjs"),
        "d".repeat(40),
        "https://github.com/monad-developers/ultrafuzz",
        "23456-1",
        output,
        "full"
      ],
      { cwd: workspace }
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8")) as {
      mode: string;
      benchmark: string;
      execution: { mode: string; dry_run: boolean };
      targets: BenchmarkTarget[];
      matrix_rows_per_pair: number;
      pairs: Array<{ pair: string; benchmark: string; provider: string; model_slug: string; config_path: string }>;
      control_timeout_seconds: number;
      concurrency: {
        max_parallel_eval_rows_per_sandbox: number;
        max_parallel_workflow_nodes_per_row: number;
        max_live_runner_workflows_by_provider: Record<string, number>;
        max_live_judge_rows: number;
      };
    };
    expect(manifest.mode).toBe("full");
    expect(manifest).not.toHaveProperty("experiment");
    expect(manifest.benchmark).toBe("evmbench");
    expect(manifest.execution).toEqual({ mode: "modal", dry_run: false });
    const cohort = JSON.parse(fs.readFileSync(path.join(workspace, "benchmarks/evmbench/cohort.json"), "utf8")) as {
      targets: BenchmarkTarget[];
    };
    expect(manifest.targets).toEqual(cohort.targets);
    expect(new Set(manifest.targets.map((target) => target.id)).size).toBe(40);
    expect(manifest.matrix_rows_per_pair).toBe(40);
    expect(manifest.pairs).toHaveLength(4);
    expect(new Set(manifest.pairs.map((pair) => pair.benchmark))).toEqual(new Set(["evmbench"]));
    expect(new Set(manifest.pairs.map((pair) => pair.provider))).toEqual(
      new Set(["openai", "anthropic", "kimi", "deepseek"])
    );
    expect(new Set(manifest.pairs.map((pair) => pair.model_slug))).toEqual(
      new Set([
        "benchmark-full-gpt-5-6-luna-high",
        "benchmark-full-claude-sonnet-5-high",
        "benchmark-full-kimi-k3-max",
        "benchmark-full-deepseek-v4-pro-max"
      ])
    );
    expect(new Set(manifest.pairs.map((pair) => pair.pair)).size).toBe(4);
    const maxParallel = publicBenchmarkMaxParallelEvalRows("full");
    const liveRows = Math.min(40, maxParallel);
    const waves = Math.ceil(40 / maxParallel);
    expect(manifest.control_timeout_seconds).toBe(
      waves * publicBenchmarkMaxRuntimeSeconds("full") +
        PUBLIC_BENCHMARK_EVAL_CLEANUP_SECONDS +
        waves * PUBLIC_BENCHMARK_SCORE_PER_WAVE_TIMEOUT_SECONDS +
        PUBLIC_BENCHMARK_REPORT_TIMEOUT_SECONDS +
        PUBLIC_BENCHMARK_PREPARATION_TIMEOUT_SECONDS +
        5 * 60
    );
    expect(publicBenchmarkMaxRuntimeSeconds("full")).toBe(15_000);
    expect(manifest.control_timeout_seconds).toBe(37_500);
    expect(manifest.control_timeout_seconds * 1000).toBeLessThan(MODAL_PUBLIC_FULL_SANDBOX_TIMEOUT_MS);
    expect(manifest.concurrency.max_parallel_eval_rows_per_sandbox).toBe(maxParallel);
    expect(manifest.concurrency.max_parallel_workflow_nodes_per_row).toBe(
      publicBenchmarkMaxParallelWorkflowNodes("full")
    );
    expect(manifest.concurrency.max_live_runner_workflows_by_provider).toEqual({
      openai: liveRows,
      anthropic: liveRows,
      kimi: liveRows,
      deepseek: liveRows
    });
    expect(manifest.concurrency.max_live_judge_rows).toBe(4 * liveRows);
    for (const pair of manifest.pairs) {
      const config = JSON.parse(fs.readFileSync(path.join(output, pair.config_path), "utf8")) as {
        public_benchmark: {
          benchmark: string;
          lane: string;
          targets: BenchmarkTarget[];
          max_runtime_seconds: number;
        };
        models: Array<{ provider: string; model: string; reasoning: string }>;
      };
      expect(config.public_benchmark).toEqual(
        expect.objectContaining({ benchmark: "evmbench", lane: "full", max_runtime_seconds: 15_000 })
      );
      expect(config.public_benchmark.targets).toEqual(manifest.targets);
      expect(config.models).toEqual([
        expect.objectContaining(
          pair.provider === "openai"
            ? { provider: "openai", model: "gpt-5.6-luna", reasoning: "high" }
            : pair.provider === "anthropic"
              ? { provider: "anthropic", model: "claude-sonnet-5", reasoning: "high" }
              : pair.provider === "kimi"
                ? { provider: "kimi", model: "kimi-k3", reasoning: "max" }
                : { provider: "deepseek", model: "deepseek-v4-pro", reasoning: "max" }
        )
      ]);
    }
  }, 15_000);

  it("accepts safe per-provider full model overrides and derives deterministic unique slugs", () => {
    const workspace = path.resolve("../..");
    const output = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-modal-overrides-"));
    execFileSync(
      process.execPath,
      [
        path.join(workspace, "scripts/ci/prepare-modal-benchmarks.mjs"),
        "c".repeat(40),
        "https://github.com/monad-developers/ultrafuzz",
        "34567-1",
        output,
        "full"
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          BENCHMARK_MODELS_JSON: JSON.stringify([
            { provider: "anthropic", model: "claude-sonnet-5-202607", reasoning: "medium" },
            { provider: "kimi", model: "kimi-k3-202607", reasoning: "max" },
            { provider: "deepseek", model: "deepseek-v4-pro-202607", reasoning: "high" },
            { provider: "openai", model: "gpt-5.6-luna-202607", reasoning: "xhigh" }
          ])
        }
      }
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8")) as {
      pairs: Array<{ provider: string; model_slug: string; config_path: string }>;
    };
    expect(manifest.pairs.map((pair) => pair.provider)).toEqual(["openai", "anthropic", "kimi", "deepseek"]);
    expect(new Set(manifest.pairs.map((pair) => pair.model_slug)).size).toBe(4);
    expect(manifest.pairs.every((pair) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(pair.model_slug))).toBe(true);
    const models = Object.fromEntries(
      manifest.pairs.map((pair) => {
        const config = JSON.parse(fs.readFileSync(path.join(output, pair.config_path), "utf8")) as {
          models: Array<{ provider: string; model: string; reasoning: string }>;
        };
        return [pair.provider, config.models[0]];
      })
    );
    expect(models).toEqual({
      openai: expect.objectContaining({ model: "gpt-5.6-luna-202607", reasoning: "xhigh" }),
      anthropic: expect.objectContaining({ model: "claude-sonnet-5-202607", reasoning: "medium" }),
      kimi: expect.objectContaining({ model: "kimi-k3-202607", reasoning: "max" }),
      deepseek: expect.objectContaining({ model: "deepseek-v4-pro-202607", reasoning: "high" })
    });
  });

  it("accepts a safe OpenAI smoke model override while keeping high strategy reasoning fixed", () => {
    const workspace = path.resolve("../..");
    const output = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-modal-smoke-override-"));
    execFileSync(
      process.execPath,
      [
        path.join(workspace, "scripts/ci/prepare-modal-benchmarks.mjs"),
        "e".repeat(40),
        "https://github.com/monad-developers/ultrafuzz",
        "45678-1",
        output,
        "smoke"
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          BENCHMARK_MODELS_JSON: JSON.stringify([
            { provider: "openai", model: "gpt-5.6-luna-202607", reasoning: "high" }
          ])
        }
      }
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8")) as {
      benchmark: string;
      pairs: Array<{ provider: string; model_slug: string; config_path: string }>;
    };
    expect(manifest.benchmark).toBe("ultrafuzz-bench");
    expect(manifest.pairs).toHaveLength(1);
    expect(manifest.pairs[0]).toEqual(
      expect.objectContaining({
        provider: "openai",
        model_slug: "benchmark-smoke-gpt-5-6-luna-202607-high"
      })
    );
    const config = JSON.parse(fs.readFileSync(path.join(output, manifest.pairs[0]!.config_path), "utf8")) as {
      models: Array<{ agent: string; model: string; provider: string; reasoning: string }>;
    };
    expect(config.models).toEqual([
      expect.objectContaining({
        agent: "CodexAgent",
        model: "gpt-5.6-luna-202607",
        provider: "openai",
        reasoning: "high"
      })
    ]);
  });

  it("creates an explicit DeepSeek V4 smoke benchmark with max reasoning", () => {
    const workspace = path.resolve("../..");
    const output = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-modal-deepseek-smoke-"));
    execFileSync(
      process.execPath,
      [
        path.join(workspace, "scripts/ci/prepare-modal-benchmarks.mjs"),
        "f".repeat(40),
        "https://github.com/monad-developers/ultrafuzz",
        "56789-1",
        output,
        "smoke"
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          BENCHMARK_MODELS_JSON: JSON.stringify([{ provider: "deepseek", model: "deepseek-v4-pro", reasoning: "max" }])
        }
      }
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8")) as {
      benchmark: string;
      pairs: Array<{ provider: string; model_slug: string; config_path: string }>;
    };
    expect(manifest.benchmark).toBe("ultrafuzz-bench");
    expect(manifest.pairs).toEqual([
      expect.objectContaining({
        provider: "deepseek",
        model_slug: "benchmark-smoke-deepseek-v4-pro-max"
      })
    ]);
    const config = JSON.parse(fs.readFileSync(path.join(output, manifest.pairs[0]!.config_path), "utf8")) as {
      models: Array<{ agent: string; auth_mode: string; model: string; provider: string; reasoning: string }>;
    };
    expect(config.models).toEqual([
      expect.objectContaining({
        agent: "DeepSeekAgent",
        auth_mode: "api-key",
        model: "deepseek-v4-pro",
        provider: "deepseek",
        reasoning: "max"
      })
    ]);
  });

  it("creates an OpenRouter smoke benchmark and preserves a punctuation-rich catalogue ID", () => {
    const workspace = path.resolve("../..");
    const output = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-modal-openrouter-smoke-"));
    const model = "~anthropic/claude-sonnet-latest:free+preview@2026";
    execFileSync(
      process.execPath,
      [
        path.join(workspace, "scripts/ci/prepare-modal-benchmarks.mjs"),
        "b".repeat(40),
        "https://github.com/monad-developers/ultrafuzz",
        "57890-1",
        output,
        "smoke"
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          BENCHMARK_MODELS_JSON: JSON.stringify([{ provider: "openrouter", model, reasoning: "high" }])
        }
      }
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8")) as {
      pairs: Array<{ provider: string; config_path: string }>;
      concurrency: {
        max_parallel_eval_rows_per_sandbox: number;
        max_parallel_workflow_nodes_per_row: number;
        max_live_runner_workflows_by_provider: Record<string, number>;
      };
    };
    expect(manifest.pairs).toHaveLength(1);
    expect(manifest.pairs[0]?.provider).toBe("openrouter");
    expect(manifest.concurrency.max_parallel_eval_rows_per_sandbox).toBe(1);
    expect(manifest.concurrency.max_parallel_workflow_nodes_per_row).toBe(1);
    expect(manifest.concurrency.max_live_runner_workflows_by_provider).toEqual({ openrouter: 1 });
    const config = JSON.parse(fs.readFileSync(path.join(output, manifest.pairs[0]!.config_path), "utf8")) as {
      models: Array<Record<string, string>>;
    };
    expect(config.models[0]).toEqual(
      expect.objectContaining({
        provider: "openrouter",
        agent: "OpenRouterAgent",
        model,
        auth_mode: "api-key"
      })
    );
  });

  it("rejects unsafe model overrides and provider sets that do not match the mode", () => {
    const workspace = path.resolve("../..");
    const cases = [
      {
        mode: "smoke",
        models: [
          { provider: "openai", model: "gpt-5.6-luna", reasoning: "high" },
          { provider: "deepseek", model: "deepseek-v4-pro", reasoning: "max" }
        ],
        message: /smoke BENCHMARK_MODELS_JSON must contain exactly/u
      },
      {
        mode: "smoke",
        models: [{ provider: "deepseek", model: "deepseek-v4-pro", reasoning: "xhigh" }],
        message: /reasoning is unsupported for DeepSeek/u
      },
      {
        mode: "full",
        models: [{ provider: "openai", model: "gpt-5.6-luna", reasoning: "high" }],
        message: /full BENCHMARK_MODELS_JSON must contain exactly openai and anthropic and kimi and deepseek/u
      },
      {
        mode: "full",
        models: [
          { provider: "openai", model: "gpt-5.6-luna", reasoning: "high" },
          { provider: "anthropic", model: "claude-sonnet-5", reasoning: "high" },
          { provider: "kimi", model: "kimi-k3", reasoning: "xhigh" },
          { provider: "deepseek", model: "deepseek-v4-pro", reasoning: "max" }
        ],
        message: /reasoning is unsupported for Kimi/u
      },
      {
        mode: "smoke",
        models: [{ provider: "openai", model: "gpt-5.6;echo", reasoning: "high" }],
        message: /model is unsafe or unpinned/u
      }
    ];
    for (const [index, testCase] of cases.entries()) {
      const output = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-modal-invalid-model-"));
      const result = spawnSync(
        process.execPath,
        [
          path.join(workspace, "scripts/ci/prepare-modal-benchmarks.mjs"),
          "d".repeat(40),
          "https://github.com/monad-developers/ultrafuzz",
          `${60_000 + index}-1`,
          output,
          testCase.mode
        ],
        {
          cwd: workspace,
          encoding: "utf8",
          env: { ...process.env, BENCHMARK_MODELS_JSON: JSON.stringify(testCase.models) }
        }
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(testCase.message);
      expect(fs.existsSync(path.join(output, "manifest.json"))).toBe(false);
    }
  }, 15_000);

  // Give each subprocess its own timeout budget on busy CI runners.
  it.each([
    { name: "whitespace-only JSON", generation: "70000-1", value: "   ", message: /must be valid strict JSON/u },
    {
      name: "duplicate JSON keys",
      generation: "70001-1",
      value: '[{"provider":"openai","provider":"anthropic","model":"gpt-5.6-luna","reasoning":"high"}]',
      message: /duplicate/iu
    }
  ])("rejects malformed-present model selection: $name", (testCase) => {
    const workspace = path.resolve("../..");
    const output = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-modal-invalid-model-json-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          path.join(workspace, "scripts/ci/prepare-modal-benchmarks.mjs"),
          "d".repeat(40),
          "https://github.com/monad-developers/ultrafuzz",
          testCase.generation,
          output,
          "smoke"
        ],
        {
          cwd: workspace,
          encoding: "utf8",
          env: { ...process.env, BENCHMARK_MODELS_JSON: testCase.value }
        }
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(testCase.message);
      expect(fs.existsSync(path.join(output, "manifest.json"))).toBe(false);
    } finally {
      fs.rmSync(output, { recursive: true, force: true });
    }
  });

  it("keeps Actions limited to CI without provider secrets or paid benchmark launches", () => {
    const workspace = path.resolve("../..");
    const workflowRoot = path.join(workspace, ".github/workflows");
    const workflowFiles = fs
      .readdirSync(workflowRoot)
      .filter((name) => /\.ya?ml$/u.test(name))
      .sort();
    // Adding a workflow requires revisiting this credential-free boundary.
    expect(workflowFiles).toEqual(["ci.yml"]);
    for (const name of workflowFiles) {
      const source = fs.readFileSync(path.join(workflowRoot, name), "utf8");
      expect(source, name).not.toMatch(/\bsecrets\b|pull_request_target|workflow_run/iu);
      expect(source, name).not.toMatch(
        /Run target repository E2E|run-target-e2e\.sh|codex exec|prepare-modal-benchmarks|watch-modal-benchmark|ultrafuzz-modal (?:build|launch|smoke)|eval (?:run|score|publish)\b/iu
      );
    }
  });

  it("validates persisted public results after lineage preflight and seals replacements atomically", () => {
    const workspace = path.resolve("../..");
    const source = fs.readFileSync(path.join(workspace, "packages/modal/src/public-worker.ts"), "utf8");
    const preflight = source.indexOf("await input.preflight");
    const persistedBundle = source.indexOf("if (pathEntryPresent(bundlePath))");
    const readPersistedBundle = source.indexOf("readPublicBenchmarkBundle", persistedBundle);
    const assertPersistedLineage = source.indexOf("assertPublicWorkerBundleLineage", readPersistedBundle);

    expect(preflight).toBeGreaterThan(-1);
    expect(persistedBundle).toBeGreaterThan(preflight);
    expect(readPersistedBundle).toBeGreaterThan(persistedBundle);
    expect(assertPersistedLineage).toBeGreaterThan(readPersistedBundle);
    expect(source).toContain("await publishPublicBenchmarkBundle({");
    expect(source).toContain("await writePublicBundleAtomic(input.bundlePath, bundle)");
    expect(source).not.toContain("writeFile(bundlePath");
  });

  it("hydrates pinned target submodules before initializing a public benchmark", () => {
    const workspace = path.resolve("../..");
    const worker = fs.readFileSync(path.join(workspace, "packages/modal/src/public-worker.ts"), "utf8");
    const clone = worker.indexOf("await cloneAtCommit(target.repo, target.ref, destination, logPath, {");
    const init = worker.indexOf('["node", CLI, "init", "--project", destination', clone);
    const smithersSeed = worker.indexOf("await seedPublicBenchmarkSmithersDependencies(destination)", init);
    const laneProfile = worker.indexOf(
      "modalTargetToml(model, config.node_timeout_seconds, auditProfile)",
      smithersSeed
    );
    const checkout = worker.indexOf('["git", "checkout", "--detach", commit]');
    const submodules = worker.indexOf('["git", "submodule", "update", "--init", "--recursive", "--depth", "1"]');
    const referenceSync = worker.indexOf('["node", CLI, "references", "sync"', init);

    expect(clone).toBeGreaterThan(-1);
    expect(init).toBeGreaterThan(clone);
    expect(worker.slice(clone, init)).toContain("initializeSubmodules: true");
    expect(smithersSeed).toBeGreaterThan(init);
    expect(laneProfile).toBeGreaterThan(smithersSeed);
    expect(referenceSync).toBeGreaterThan(laneProfile);
    expect(worker.indexOf("capModalTargetTopologyTimeouts", init)).toBe(-1);
    expect(checkout).toBeGreaterThan(-1);
    expect(submodules).toBeGreaterThan(checkout);
  });
});
