import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

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
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-ci-"));
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
    expect(manifest.mode).toBe("smoke");
    expect(manifest).not.toHaveProperty("experiment");
    expect(manifest.benchmark).toBe("ultrafuzz-bench");
    expect(manifest.execution).toEqual({ mode: "modal", dry_run: false });
    const cohort = JSON.parse(fs.readFileSync(path.join(workspace, "benchmarks/ultrafuzz-bench.json"), "utf8")) as {
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
        braintrust: { judge_api_key_env: string; judge_url?: string };
        models: Array<{ model: string; provider: string; agent: string; reasoning: string }>;
      };
      expect(config.node_timeout_seconds).toBe(1800);
      expect(config.public_benchmark).toEqual(
        expect.objectContaining({ benchmark: "ultrafuzz-bench", lane: "smoke", max_runtime_seconds: 15_000 })
      );
      expect(config.public_benchmark.targets).toEqual(manifest.targets);
      expect(config.braintrust.judge_api_key_env).toBe("OPENAI_API_KEY");
      expect(config.braintrust.judge_url).toBe("https://api.openai.com/v1/chat/completions");
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
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-full-"));
    execFileSync(
      process.execPath,
      [
        path.join(workspace, "scripts/ci/prepare-modal-benchmarks.mjs"),
        "d".repeat(40),
        "https://github.com/monad-developers/ultrafuzz",
        "full-1",
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
    const cohort = JSON.parse(fs.readFileSync(path.join(workspace, "benchmarks/evmbench-detect.json"), "utf8")) as {
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
        expect.objectContaining({ benchmark: "evmbench", lane: "full", max_runtime_seconds: 3600 })
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
  });

  it("accepts safe per-provider full model overrides and derives deterministic unique slugs", () => {
    const workspace = path.resolve("../..");
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-overrides-"));
    execFileSync(
      process.execPath,
      [
        path.join(workspace, "scripts/ci/prepare-modal-benchmarks.mjs"),
        "c".repeat(40),
        "https://github.com/monad-developers/ultrafuzz",
        "overrides-1",
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
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-smoke-override-"));
    execFileSync(
      process.execPath,
      [
        path.join(workspace, "scripts/ci/prepare-modal-benchmarks.mjs"),
        "e".repeat(40),
        "https://github.com/monad-developers/ultrafuzz",
        "smoke-override-1",
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
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-deepseek-smoke-"));
    execFileSync(
      process.execPath,
      [
        path.join(workspace, "scripts/ci/prepare-modal-benchmarks.mjs"),
        "f".repeat(40),
        "https://github.com/monad-developers/ultrafuzz",
        "deepseek-smoke-1",
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
      const output = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-invalid-model-"));
      const result = spawnSync(
        process.execPath,
        [
          path.join(workspace, "scripts/ci/prepare-modal-benchmarks.mjs"),
          "d".repeat(40),
          "https://github.com/monad-developers/ultrafuzz",
          `invalid-${index}`,
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
  });

  it("uses GitHub Actions only as the asynchronous Modal control and publication plane", () => {
    const workspace = path.resolve("../..");
    const workflowText = fs.readFileSync(path.join(workspace, ".github/workflows/eval-benchmarks.yml"), "utf8");
    const workflow = parse(workflowText) as {
      on: {
        push: { branches: string[] };
        workflow_dispatch: {
          inputs: Record<string, { default: string; type: string; options?: string[] }>;
        };
      };
      env: { BENCHMARK_MODE: string; BENCHMARK_CANDIDATE: string };
      concurrency: { group: string; "cancel-in-progress": string };
      jobs: Record<
        string,
        {
          if?: string;
          steps: Array<{ name?: string; env?: Record<string, string>; run?: string; with?: Record<string, unknown> }>;
        }
      >;
    };
    expect(Object.hasOwn(workflow.on, "push")).toBe(true);
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(Object.hasOwn(workflow.on, "pull_request")).toBe(false);
    expect(workflow.on.workflow_dispatch.inputs).toEqual({
      benchmark_mode: expect.objectContaining({ default: "full", type: "choice", options: ["full", "smoke"] }),
      smoke_provider: expect.objectContaining({ default: "deepseek", type: "choice" }),
      smoke_model: expect.objectContaining({ default: "deepseek-v4-flash", type: "string" }),
      smoke_reasoning: expect.objectContaining({ default: "max", type: "string" }),
      openai_model: expect.objectContaining({ default: "gpt-5.6-luna", type: "string" }),
      openai_reasoning: expect.objectContaining({ default: "high", type: "string" }),
      anthropic_model: expect.objectContaining({ default: "claude-sonnet-5", type: "string" }),
      anthropic_reasoning: expect.objectContaining({ default: "high", type: "string" }),
      kimi_model: expect.objectContaining({ default: "kimi-k3", type: "string" }),
      kimi_reasoning: expect.objectContaining({ default: "max", type: "string" }),
      deepseek_model: expect.objectContaining({ default: "deepseek-v4-pro", type: "string" }),
      deepseek_reasoning: expect.objectContaining({ default: "max", type: "string" })
    });
    expect(workflow.env.BENCHMARK_MODE).toContain("github.event_name == 'workflow_dispatch'");
    expect(workflow.env.BENCHMARK_MODE).toContain("'full'");
    expect(workflow.env.BENCHMARK_MODE).toContain("'smoke'");
    expect(workflow.env.BENCHMARK_CANDIDATE).toContain("github.event.after");
    expect(workflow.env.BENCHMARK_CANDIDATE).toContain("github.sha");
    expect(workflow.concurrency.group).toContain("inputs.benchmark_mode");
    expect(workflow.concurrency.group).toContain("'full'");
    expect(workflow.concurrency.group).toContain("'smoke'");
    expect(workflow.concurrency.group).toContain("github.ref");
    expect(workflow.concurrency.group).toContain("github.run_id");
    expect(workflow.concurrency.group).not.toContain("pull_request");
    expect(workflow.concurrency["cancel-in-progress"]).toBe("${{ github.event_name == 'push' }}");
    expect(workflow.jobs.launch?.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(workflow.jobs.launch?.if).toContain("github.event_name == 'push'");
    expect(workflow.jobs.launch?.if).toContain("github.event.deleted == false");
    expect(fs.existsSync(path.join(workspace, ".github/workflows/target-e2e.yml"))).toBe(false);

    const prepare = workflow.jobs.launch?.steps.find(
      (step) => step.name === "Prepare the exact model by benchmark matrix"
    );
    expect(prepare?.env?.BENCHMARK_OPENAI_MODEL).toContain("inputs.openai_model");
    expect(prepare?.env?.BENCHMARK_OPENAI_MODEL).toContain("'gpt-5.6-luna'");
    expect(prepare?.env?.BENCHMARK_OPENAI_MODEL).toContain("vars.BENCHMARK_SMOKE_OPENAI_MODEL");
    expect(prepare?.env?.BENCHMARK_OPENAI_REASONING).toContain("inputs.openai_reasoning");
    expect(prepare?.env?.BENCHMARK_OPENAI_REASONING).toContain("'high'");
    expect(prepare?.env?.BENCHMARK_OPENAI_REASONING).not.toContain("vars.BENCHMARK_SMOKE_OPENAI_REASONING");
    expect(prepare?.env?.BENCHMARK_ANTHROPIC_MODEL).toContain("inputs.anthropic_model");
    expect(prepare?.env?.BENCHMARK_ANTHROPIC_REASONING).toContain("inputs.anthropic_reasoning");
    expect(prepare?.env?.BENCHMARK_KIMI_MODEL).toContain("inputs.kimi_model");
    expect(prepare?.env?.BENCHMARK_KIMI_MODEL).toContain("'kimi-k3'");
    expect(prepare?.env?.BENCHMARK_KIMI_REASONING).toContain("inputs.kimi_reasoning");
    expect(prepare?.env?.BENCHMARK_KIMI_REASONING).toContain("'max'");
    expect(prepare?.env?.BENCHMARK_DEEPSEEK_MODEL).toContain("inputs.deepseek_model");
    expect(prepare?.env?.BENCHMARK_DEEPSEEK_MODEL).toContain("'deepseek-v4-pro'");
    expect(prepare?.env?.BENCHMARK_DEEPSEEK_REASONING).toContain("inputs.deepseek_reasoning");
    expect(prepare?.env?.BENCHMARK_DEEPSEEK_REASONING).toContain("'max'");
    expect(prepare?.run).toContain("BENCHMARK_MODELS_JSON");
    expect(prepare?.run).toContain('--arg reasoning "high"');
    expect(prepare?.run).toContain('{provider: "kimi", model: $kimi_model, reasoning: $kimi_reasoning}');
    expect(prepare?.run).toContain('{provider: "deepseek", model: $deepseek_model, reasoning: $deepseek_reasoning}');
    expect(prepare?.run).toContain('"$BENCHMARK_MODE"');
    for (const jobName of ["launch", "collect", "cleanup_incomplete_run"]) {
      const checkout = workflow.jobs[jobName]?.steps.find((step) =>
        String(step.with?.ref ?? "").includes("BENCHMARK_CANDIDATE")
      );
      expect(checkout?.with?.ref, `${jobName} exact candidate checkout`).toBe("${{ env.BENCHMARK_CANDIDATE }}");
    }

    expect(workflowText).toContain("node packages/modal/dist/cli.js launch");
    expect(workflowText).toContain("Validate Modal benchmark launch guardrails");
    expect(workflowText).toContain("validate-modal-benchmark-launch.mjs");
    expect(workflowText).toContain("Launch detached Modal benchmark sandboxes");
    expect(workflowText).toContain("actions/download-artifact@");
    expect(workflowText).toContain("--public-results");
    expect(workflowText).toContain("retention-days: 30");
    expect(workflowText).toContain(
      "modal-benchmark-launch-${{ env.BENCHMARK_MODE }}-${{ github.run_id }}-${{ github.run_attempt }}"
    );
    expect(workflowText).toContain(
      "public-benchmark-results-${{ env.BENCHMARK_MODE }}-${{ github.run_id }}-${{ github.run_attempt }}"
    );
    expect(workflowText).toContain(
      "modal-benchmark-control-${{ env.BENCHMARK_MODE }}-${{ github.run_id }}-${{ github.run_attempt }}"
    );
    expect(workflow.jobs).not.toHaveProperty("publish");
    expect(workflowText).not.toContain("publish-eval-history-cas.mjs");
    expect(workflowText).not.toContain("EVAL_HISTORY_PR_TOKEN");
    expect(workflowText).not.toContain("contents: write");
    expect(workflowText).not.toContain("pull-requests: write");
    expect(workflowText).not.toContain("group: publish-eval-history");
    expect(workflowText).not.toContain("peter-evans/create-pull-request");
    expect(workflowText).not.toContain("ultrafuzz-benchmark");
    expect(workflowText).not.toContain("self-hosted");
    expect(workflowText).not.toMatch(/ablation|fake binary|BENCHMARK_EXPERIMENT/iu);
    const generatorText = fs.readFileSync(path.join(workspace, "scripts/ci/prepare-modal-benchmarks.mjs"), "utf8");
    expect(generatorText).not.toMatch(/ablation|experiment|fake/iu);
  });

  it("limits trusted benchmark credentials to Modal steps for either supported trigger", () => {
    const workspace = path.resolve("../..");
    const workflow = parse(fs.readFileSync(path.join(workspace, ".github/workflows/eval-benchmarks.yml"), "utf8")) as {
      permissions: Record<string, string>;
      jobs: Record<
        string,
        {
          if?: string;
          permissions?: Record<string, string>;
          env?: Record<string, string>;
          steps: Array<{
            name?: string;
            env?: Record<string, string>;
            uses?: string;
            with?: Record<string, unknown>;
          }>;
        }
      >;
    };
    const sensitive = [
      "ANTHROPIC_API_KEY",
      "BRAINTRUST_API_KEY",
      "DEEPSEEK_API_KEY",
      "KIMI_API_KEY",
      "MODAL_TOKEN_ID",
      "MODAL_TOKEN_SECRET",
      "OPENAI_API_KEY"
    ].sort();
    const modalOnly = ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"].sort();
    const runnerCredentials = sensitive.filter((name) => name !== "BRAINTRUST_API_KEY");
    const expectedByStep = new Map<string, string[]>([
      ["launch:Validate benchmark credentials", runnerCredentials],
      ["launch:Build an immutable Modal image for the candidate", modalOnly],
      ["launch:Launch detached Modal benchmark sandboxes", runnerCredentials],
      ["collect:Wait for Modal compute and retry only pre-model launch failures", runnerCredentials],
      ["collect:Collect and validate public finding bundles", runnerCredentials],
      ["cleanup_incomplete_run:Terminate every exact incomplete-run sandbox", modalOnly]
    ]);

    expect(workflow.permissions).toEqual({ actions: "read", contents: "read" });
    expect(workflow.jobs.launch?.if).toContain("github.event.deleted == false");
    expect(workflow.jobs).not.toHaveProperty("publish");

    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      expect(
        sensitive.filter((name) => Object.hasOwn(job.env ?? {}, name)),
        `${jobName} job env`
      ).toEqual([]);
      for (const step of job.steps) {
        const key = `${jobName}:${step.name ?? "unnamed"}`;
        const actual = sensitive.filter((name) => Object.hasOwn(step.env ?? {}, name)).sort();
        expect(actual, key).toEqual(expectedByStep.get(key) ?? []);
      }
    }
    for (const jobName of ["launch", "collect", "cleanup_incomplete_run"]) {
      const checkout = workflow.jobs[jobName]?.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
      expect(checkout?.with?.["persist-credentials"], `${jobName} checkout credentials`).toBe(false);
      expect(checkout?.with?.ref, `${jobName} checkout ref`).toBe("${{ env.BENCHMARK_CANDIDATE }}");
    }
  });

  it("uses a fast draft lane and cancels superseded CI work for the same pull request", () => {
    const workspace = path.resolve("../..");
    const workflow = parse(fs.readFileSync(path.join(workspace, ".github/workflows/ci.yml"), "utf8")) as {
      on: {
        push: { branches: string[] };
        pull_request: { types: string[] };
      };
      concurrency: { group: string; "cancel-in-progress": boolean };
      jobs: Record<
        string,
        {
          if?: string;
          needs?: string[];
          strategy?: {
            "fail-fast": boolean;
            "max-parallel": number;
            matrix: { include: Array<{ lane: string; gates: string }> };
          };
          steps: Array<{ name?: string; if?: string; run?: string }>;
        }
      >;
    };

    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.on.pull_request.types).toEqual([
      "opened",
      "synchronize",
      "reopened",
      "ready_for_review",
      "converted_to_draft"
    ]);
    expect(workflow.concurrency.group).toContain("github.event.pull_request.number");
    expect(workflow.concurrency.group).toContain("github.ref");
    expect(workflow.concurrency["cancel-in-progress"]).toBe(true);

    const steps = workflow.jobs["draft-and-build-gates"]?.steps ?? [];
    for (const name of ["Check formatting", "Lint", "Build"]) {
      expect(steps.find((step) => step.name === name)?.if, `${name} must run for drafts`).toBeUndefined();
    }
    const fullLane = "github.event_name == 'push' || github.event.pull_request.draft == false";
    const releaseValidation = workflow.jobs["release-validation"];
    expect(releaseValidation?.if).toBe(fullLane);
    expect(releaseValidation?.strategy).toEqual({
      "fail-fast": false,
      "max-parallel": 3,
      matrix: {
        include: [
          {
            lane: "package-gates",
            gates: "docs,config,audit-profile-package,security,topology,prompts,artifacts,evals,modal"
          },
          { lane: "runtime", gates: "runtime" },
          { lane: "cli-typecheck", gates: "cli,benchmark-history,workspace-typecheck" }
        ]
      }
    });
    expect(releaseValidation?.steps.find((step) => step.name === "Validate release lane")?.run).toContain("--gates");
    const modalDependentLaneBuild = releaseValidation?.steps.find(
      (step) => step.name === "Build Modal-dependent lane dependencies"
    );
    expect(modalDependentLaneBuild?.if).toBe("matrix.lane == 'package-gates' || matrix.lane == 'runtime'");
    expect(modalDependentLaneBuild?.run).toBe("pnpm --filter @ultrafuzz/modal... build");
    expect(releaseValidation?.steps.find((step) => step.name === "Validate benchmark history charts")).toBeUndefined();
    expect(workflow.jobs["release-gates"]?.needs).toEqual(["draft-and-build-gates", "release-validation"]);
    expect(
      workflow.jobs["release-gates"]?.steps.find((step) => step.name === "Merge release validation report")?.run
    ).toContain("--merge-report-dir");
  });

  it("terminates every exact detached sandbox after either supported run becomes incomplete", () => {
    const workspace = path.resolve("../..");
    const workflow = parse(fs.readFileSync(path.join(workspace, ".github/workflows/eval-benchmarks.yml"), "utf8")) as {
      jobs: Record<
        string,
        {
          if?: string;
          needs?: string[];
          "timeout-minutes"?: number;
          steps: Array<{
            name?: string;
            run?: string;
            uses?: string;
            if?: string;
            env?: Record<string, string>;
            with?: Record<string, unknown>;
            "continue-on-error"?: boolean;
          }>;
        }
      >;
    };
    const cleanup = workflow.jobs.cleanup_incomplete_run!;
    expect(cleanup.if).toContain("!cancelled()");
    expect(cleanup.if).toContain("needs.launch.result == 'failure'");
    expect(cleanup.if).toContain("needs.collect.result == 'failure'");
    expect(cleanup.if).not.toContain("always()");
    expect(cleanup.if).not.toContain("github.event_name");
    expect(cleanup.needs).toEqual(["launch", "collect"]);
    expect(cleanup["timeout-minutes"]).toBeGreaterThanOrEqual(75);
    const launch = workflow.jobs.launch!;
    const planUploadIndex = launch.steps.findIndex(
      (step) => step.name === "Persist immutable benchmark plan before starting Modal compute"
    );
    const buildIndex = launch.steps.findIndex(
      (step) => step.name === "Build an immutable Modal image for the candidate"
    );
    const guardIndex = launch.steps.findIndex((step) => step.name === "Validate Modal benchmark launch guardrails");
    const launchIndex = launch.steps.findIndex((step) => step.name === "Launch detached Modal benchmark sandboxes");
    expect(planUploadIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(planUploadIndex);
    expect(planUploadIndex).toBeLessThan(buildIndex);
    expect(buildIndex).toBeLessThan(launchIndex);
    expect(launch.steps[planUploadIndex]?.with?.name).toContain("${{ github.run_id }}-${{ github.run_attempt }}");
    expect(launch.steps[planUploadIndex]?.with?.["retention-days"]).toBe(30);
    expect(launch.steps[buildIndex]?.run).toContain('--build-scope "${{ github.run_id }}-${{ github.run_attempt }}"');
    expect(launch.steps.find((step) => step.name === "Persist detached launch state")?.with?.["retention-days"]).toBe(
      30
    );

    const restorePlan = cleanup.steps.find((step) => step.name === "Restore the immutable pre-compute benchmark plan")!;
    expect(restorePlan["continue-on-error"]).toBeUndefined();
    expect(restorePlan.if).toContain("steps.incomplete_plan.outputs.available == 'true'");
    expect(restorePlan.with?.name).toContain("modal-benchmark-plan-");
    expect(restorePlan.with?.name).toContain("${{ github.run_id }}-${{ github.run_attempt }}");
    expect(restorePlan.with?.["run-id"]).toBe("${{ github.run_id }}");
    expect(restorePlan.with?.["github-token"]).toBe("${{ github.token }}");
    const restoreState = cleanup.steps.find((step) => step.name === "Restore any persisted launch IDs")!;
    expect(restoreState["continue-on-error"]).toBe(true);

    const pathValidation = cleanup.steps.find((step) => step.name === "Validate incomplete-run cleanup paths")?.run;
    expect(
      cleanup.steps.find((step) => step.name === "Validate incomplete-run cleanup paths")?.env?.EXPECTED_CANDIDATE
    ).toBe("${{ env.BENCHMARK_CANDIDATE }}");
    expect(pathValidation).toContain("prepare-modal-benchmark-cleanup.mjs");
    const cleanupPreparation = fs.readFileSync(
      path.join(workspace, "scripts/ci/prepare-modal-benchmark-cleanup.mjs"),
      "utf8"
    );
    expect(cleanupPreparation).toContain("readBenchmarkControlManifest");
    expect(cleanupPreparation).toContain("validateAutomaticPairConfig");
    expect(cleanupPreparation).toContain("CONFIG_KEYS");
    expect(cleanupPreparation).toContain("MODEL_KEYS");
    expect(cleanupPreparation).toContain("configs.has(configPath) || states.has(statePath)");
    const termination = cleanup.steps.find((step) => step.name === "Terminate every exact incomplete-run sandbox")!;
    expect(Object.keys(termination.env ?? {})).toEqual(
      expect.arrayContaining([
        "BENCHMARK_PLAN",
        "BENCHMARK_STATE",
        "CLEANUP_PAIR_LIST",
        "BUILD_SCOPE",
        "MODAL_TOKEN_ID",
        "MODAL_TOKEN_SECRET"
      ])
    );
    expect(termination.if).toContain("steps.validate_incomplete_plan.outcome == 'success'");
    expect(termination.run).toContain("terminate-modal-benchmark.sh");
    const terminationScript = fs.readFileSync(path.join(workspace, "scripts/ci/terminate-modal-benchmark.sh"), "utf8");
    expect(terminationScript).toContain("terminate --state");
    expect(terminationScript).toContain("terminate-build");
    expect(terminationScript).toContain('terminate_scope "eval config $config pass $pass" terminate');
    expect(terminationScript).toContain("for pass in 1 2");
    expect(terminationScript).toContain("sleep 20");
    expect(terminationScript).toContain("termination_failed=true");
    const discovery = cleanup.steps.find((step) => step.name === "Discover the exact pre-compute benchmark plan")!;
    expect(discovery.run).toContain("actions/runs/$SOURCE_RUN_ID/artifacts");
    expect(discovery.run).toContain("attempts/$GITHUB_RUN_ATTEMPT/jobs");
    expect(discovery.run).toContain("compute_may_have_started");
    expect(discovery.run).toContain('echo "available=false"');
    expect(discovery.run).toContain("never reached a Modal compute step");
  });

  it("uses trusted default-branch tooling to recover incomplete Modal generations", () => {
    const workspace = path.resolve("../..");
    const recoveryText = fs.readFileSync(path.join(workspace, ".github/workflows/eval-benchmark-recovery.yml"), "utf8");
    const recovery = parse(recoveryText) as {
      "run-name": string;
      on: { workflow_run: { workflows: string[]; types: string[] } };
      permissions: Record<string, string>;
      concurrency: { group: string; "cancel-in-progress": boolean };
      jobs: Record<
        string,
        {
          name?: string;
          if?: string;
          env?: Record<string, string>;
          "timeout-minutes"?: number;
          steps: Array<{
            name?: string;
            uses?: string;
            run?: string;
            if?: string;
            env?: Record<string, string>;
            with?: Record<string, unknown>;
            "continue-on-error"?: boolean;
          }>;
        }
      >;
    };

    expect(recovery.on.workflow_run).toEqual({ workflows: ["Modal Eval Benchmarks"], types: ["completed"] });
    expect(recovery["run-name"]).toBe(
      "Recover Modal benchmark candidate ${{ github.event.workflow_run.head_sha }} " +
        "from source run ${{ github.event.workflow_run.id }} attempt ${{ github.event.workflow_run.run_attempt }}"
    );
    expect(recovery.permissions).toEqual({ actions: "read", contents: "read" });
    expect(recovery.concurrency.group).toContain("github.event.workflow_run.id");
    expect(recovery.concurrency["cancel-in-progress"]).toBe(false);
    const cleanup = recovery.jobs.cleanup_incomplete_run!;
    expect(cleanup.name).toBe(
      "Recover candidate ${{ github.event.workflow_run.head_sha }} " +
        "from source run ${{ github.event.workflow_run.id }} attempt ${{ github.event.workflow_run.run_attempt }}"
    );
    expect(cleanup.if).toContain("github.event.workflow_run.conclusion == 'cancelled'");
    expect(cleanup.if).toContain("github.event.workflow_run.conclusion == 'failure'");
    expect(cleanup.if).toContain("github.event.workflow_run.conclusion == 'timed_out'");
    expect(cleanup.if).toContain("github.event.workflow_run.path == '.github/workflows/eval-benchmarks.yml'");
    expect(cleanup.if).toContain("github.event.workflow_run.head_repository.full_name == github.repository");
    expect(cleanup.if).toContain("github.event.workflow_run.event == 'push'");
    expect(cleanup.if).toContain("github.event.workflow_run.event == 'workflow_dispatch'");
    expect(cleanup.env?.BENCHMARK_CANDIDATE).toBe("${{ github.event.workflow_run.head_sha }}");
    expect(cleanup.env).not.toHaveProperty("BENCHMARK_MODE");
    expect(cleanup["timeout-minutes"]).toBeGreaterThanOrEqual(75);

    const attribution = cleanup.steps.find((step) => step.name === "Publish candidate attribution")!;
    expect(attribution.run).toContain("$GITHUB_STEP_SUMMARY");
    expect(attribution.run).toContain("$BENCHMARK_CANDIDATE");
    expect(attribution.run).toContain("actions/runs/$SOURCE_RUN_ID/attempts/$SOURCE_RUN_ATTEMPT");
    expect(attribution.run).toContain("$GITHUB_SHA");

    const checkouts = cleanup.steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(2);
    const trustedCheckout = checkouts.find((step) => step.with?.path === "trusted-tooling")!;
    const candidateCheckout = checkouts.find((step) => step.with?.path === "candidate-source")!;
    expect(trustedCheckout.with?.ref).toBe("${{ github.sha }}");
    expect(candidateCheckout.with?.ref).toBe("${{ env.BENCHMARK_CANDIDATE }}");
    expect(trustedCheckout.with?.["persist-credentials"]).toBe(false);
    expect(candidateCheckout.with?.["persist-credentials"]).toBe(false);
    const install = cleanup.steps.find((step) => step.name === "Install and build only trusted cleanup tooling")!;
    expect(install.run).toContain("pnpm -w build");
    expect(recoveryText).not.toContain("Install and build the incomplete candidate");

    const plan = cleanup.steps.find((step) => step.name === "Restore the incomplete run's immutable pre-compute plan")!;
    expect(plan["continue-on-error"]).toBeUndefined();
    expect(plan.with?.name).toBe("${{ steps.incomplete_plan.outputs.plan_artifact_name }}");
    expect(plan.with?.["run-id"]).toBe("${{ env.SOURCE_RUN_ID }}");
    expect(plan.with?.["github-token"]).toBe("${{ github.token }}");
    expect(plan.with?.path).toContain("${{ runner.temp }}");
    const discovery = cleanup.steps.find((step) => step.name === "Discover the exact pre-compute benchmark plan")!;
    expect(discovery.run).toContain("attempts/$SOURCE_RUN_ATTEMPT/jobs");
    expect(discovery.run).toContain("compute_may_have_started");
    expect(discovery.run).toContain("for mode in smoke full threat-model");
    expect(discovery.run).toContain('echo "benchmark_mode=$plan_mode"');
    expect(discovery.run).toContain('echo "plan_artifact_name=$plan_artifact_name"');

    const validation = cleanup.steps.find(
      (step) => step.name === "Validate incomplete-run identity and termination scopes"
    );
    expect(validation?.run).toContain("prepare-modal-benchmark-cleanup.mjs");
    expect(validation?.run).toContain('git -C "$CANDIDATE_SOURCE" rev-parse HEAD');
    expect(validation?.env?.BENCHMARK_MODE).toBe("${{ steps.incomplete_plan.outputs.benchmark_mode }}");
    const cleanupInvocation = validation?.run?.match(
      /node scripts\/ci\/prepare-modal-benchmark-cleanup\.mjs[\s\S]*$/u
    )?.[0];
    expect(cleanupInvocation?.trimEnd().endsWith('"$CANDIDATE_SOURCE"')).toBe(true);
    const termination = cleanup.steps.find((step) => step.name === "Terminate every exact incomplete-run sandbox");
    expect(termination?.run).toContain("terminate-modal-benchmark.sh");
    expect(termination?.run).toContain("false");
    expect(termination?.if).toContain("steps.validate_incomplete_plan.outcome == 'success'");
    expect(Object.keys(termination?.env ?? {}).sort()).toEqual(
      ["BENCHMARK_PLAN", "CANDIDATE_SOURCE", "CLEANUP_PAIR_LIST", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"].sort()
    );
    expect(recoveryText).not.toContain("Restore any persisted launch IDs");
    expect(recoveryText).not.toContain("OPENAI_API_KEY");
    expect(recoveryText).not.toContain("ANTHROPIC_API_KEY");
  });

  it("contains no GitHub-hosted benchmark or model-execution workflow", () => {
    const workspace = path.resolve("../..");
    const workflowRoot = path.join(workspace, ".github/workflows");
    const workflowFiles = fs.readdirSync(workflowRoot).filter((name) => /\.ya?ml$/u.test(name));
    expect(workflowFiles).not.toContain("target-e2e.yml");
    for (const name of workflowFiles) {
      const source = fs.readFileSync(path.join(workflowRoot, name), "utf8");
      expect(source, name).not.toMatch(/Run target repository E2E|run-target-e2e\.sh|codex exec/iu);
    }
  });

  it("validates persisted public results after lineage preflight and seals replacements atomically", () => {
    const workspace = path.resolve("../..");
    const source = fs.readFileSync(path.join(workspace, "packages/modal/src/public-worker.ts"), "utf8");
    const preflight = source.indexOf("await input.preflight");
    const persistedBundle = source.indexOf("if (fs.existsSync(bundlePath))");
    const readPersistedBundle = source.indexOf("readPublicBenchmarkBundle", persistedBundle);
    const assertPersistedLineage = source.indexOf("assertPublicWorkerBundleLineage", readPersistedBundle);

    expect(preflight).toBeGreaterThan(-1);
    expect(persistedBundle).toBeGreaterThan(preflight);
    expect(readPersistedBundle).toBeGreaterThan(persistedBundle);
    expect(assertPersistedLineage).toBeGreaterThan(readPersistedBundle);
    expect(source).toContain("await writePublicBundleAtomic(bundlePath, bundle)");
    expect(source).not.toContain("writeFile(bundlePath");
  });

  it("uses a least-privilege App token for automatic default-branch history publication", () => {
    const workspace = path.resolve("../..");
    const producerText = fs.readFileSync(path.join(workspace, ".github/workflows/eval-benchmarks.yml"), "utf8");
    const publicationText = fs.readFileSync(
      path.join(workspace, ".github/workflows/eval-history-publication.yml"),
      "utf8"
    );
    expect(() => parse(producerText)).not.toThrow();
    expect(() => parse(publicationText)).not.toThrow();
    expect(producerText).not.toContain("publish-eval-history-cas.mjs");
    expect(publicationText.match(/publish-eval-history-cas\.mjs/gu)).toHaveLength(1);
    expect(publicationText).not.toContain("automation/eval-history");
    expect(publicationText).not.toContain("group: publish-eval-history");
    expect(publicationText).not.toContain("peter-evans/create-pull-request");
    expect(publicationText).not.toContain("gh pr create");

    const publication = parse(publicationText) as {
      on: { workflow_run: { workflows: string[]; types: string[] } };
      permissions: Record<string, string>;
      jobs: Record<
        string,
        {
          if?: string;
          needs?: string | string[];
          permissions?: Record<string, string>;
          env?: Record<string, string>;
          steps: Array<{
            id?: string;
            name?: string;
            uses?: string;
            run?: string;
            env?: Record<string, string>;
            with?: Record<string, unknown>;
          }>;
        }
      >;
    };
    expect(publication.on.workflow_run).toEqual({ workflows: ["Modal Eval Benchmarks"], types: ["completed"] });
    expect(publication.on).not.toHaveProperty("workflow_dispatch");
    expect(publication.permissions).toEqual({
      actions: "read",
      contents: "read"
    });
    for (const [jobName, job] of Object.entries(publication.jobs)) {
      const firstNodeInvocation = job.steps.findIndex((step) => /(^|\s)node(?:\s|$)/u.test(step.run ?? ""));
      if (firstNodeInvocation === -1) continue;
      const setupNode = job.steps.findIndex((step) => step.uses?.startsWith("actions/setup-node@"));
      expect(setupNode, `${jobName} must pin Node.js before invoking node`).toBeGreaterThanOrEqual(0);
      expect(setupNode, `${jobName} must pin Node.js before invoking node`).toBeLessThan(firstNodeInvocation);
      expect(job.steps[setupNode]?.with?.["node-version"], `${jobName} Node.js version`).toBe(24);
    }
    const qualifier = publication.jobs.qualify_modal_benchmark!;
    expect(qualifier.if).toBe("github.event_name == 'workflow_run'");
    expect(qualifier.permissions).toEqual({ actions: "read", contents: "read" });
    const qualifierCheckout = qualifier.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(qualifierCheckout?.with?.ref).toBe("main");
    expect(qualifierCheckout?.with?.["persist-credentials"]).toBe(false);
    const qualification = qualifier.steps.find(
      (step) => step.name === "Qualify the exact completed producer attempt"
    )?.run;
    expect(qualification).toContain("/attempts/$PRODUCER_RUN_ATTEMPT/jobs?per_page=100");
    expect(qualification).toContain("/actions/runs/$PRODUCER_RUN_ID/artifacts?per_page=100");
    expect(qualification).toContain("qualify-modal-benchmark-publication.mjs");
    expect(qualification).toContain('"$GITHUB_EVENT_PATH"');
    expect(qualification).toContain('"$artifacts_path"');
    expect(qualification).toContain('"$GITHUB_OUTPUT"');

    const automatic = publication.jobs.publish_modal_benchmark!;
    expect(automatic.needs).toBe("qualify_modal_benchmark");
    expect(automatic.if).toBe("needs.qualify_modal_benchmark.outputs.eligible == 'true'");
    expect(automatic.env?.BENCHMARK_MODE).toBe("${{ needs.qualify_modal_benchmark.outputs.benchmark_mode }}");
    expect(automatic.env?.CANDIDATE_COMMIT).toBe("${{ needs.qualify_modal_benchmark.outputs.candidate_commit }}");
    const automaticToken = automatic.steps.find((step) => step.id === "publisher-token");
    expect(automaticToken?.uses).toBe("actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1");
    expect(automaticToken?.with).toEqual({
      "client-id": "${{ vars.EVAL_HISTORY_APP_CLIENT_ID }}",
      "private-key": "${{ secrets.EVAL_HISTORY_APP_PRIVATE_KEY }}",
      owner: "${{ github.repository_owner }}",
      repositories: "${{ github.event.repository.name }}",
      "permission-contents": "write",
      "skip-token-revoke": false
    });
    const automaticCheckout = automatic.steps.find(
      (step) => step.name === "Check out trusted main publication tooling"
    );
    expect(automaticCheckout?.with?.ref).toBe("main");
    expect(automaticCheckout?.with).not.toHaveProperty("token");
    expect(automaticCheckout?.with?.["persist-credentials"]).toBe(false);
    const policyCheckout = automatic.steps.find(
      (step) => step.name === "Check out the exact candidate benchmark policy"
    );
    expect(policyCheckout?.with?.ref).toBe("${{ env.CANDIDATE_COMMIT }}");
    expect(policyCheckout?.with?.["persist-credentials"]).toBe(false);
    expect(automatic.steps.some((step) => step.uses?.startsWith("actions/cache@"))).toBe(false);
    const downloads = automatic.steps.filter((step) => step.uses?.startsWith("actions/download-artifact@"));
    expect(downloads).toHaveLength(2);
    for (const download of downloads) {
      expect(download.with?.path).toContain("${{ runner.temp }}");
      expect(download.with?.["run-id"]).toBe("${{ github.event.workflow_run.id }}");
      expect(download.with?.["github-token"]).toBe("${{ github.token }}");
      expect(download.with?.name).toContain("${{ github.event.workflow_run.run_attempt }}");
    }
    const reachability = automatic.steps.find(
      (step) => step.name === "Verify the candidate remains reachable from main"
    )?.run;
    expect(reachability).toContain("compare/$CANDIDATE_COMMIT...main");
    expect(reachability).toContain("comparison_status");
    const trustedValidation = automatic.steps.find(
      (step) => step.name === "Validate the atomic Modal benchmark generation"
    )?.run;
    expect(trustedValidation).toContain("prepare-eval-history-publication.mjs automatic");
    expect(trustedValidation).toContain('"$PUBLICATION_POLICY_ROOT"');
    expect(trustedValidation).not.toContain("publish-eval-history-cas.mjs");
    expect(trustedValidation).not.toContain("pnpm install");
    const privilegedPublish = automatic.steps.find(
      (step) => step.name === "Publish the validated generation with remote-tip compare-and-swap retries"
    );
    expect(privilegedPublish?.env?.PUBLISHER_TOKEN).toBe("${{ steps.publisher-token.outputs.token }}");
    expect(privilegedPublish?.run).toContain('GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $publisher_basic"');
    expect(privilegedPublish?.run).toContain("publish-eval-history-cas.mjs");
    const buildIndex = automatic.steps.findIndex((step) => step.name === "Install and build trusted main");
    const validationIndex = automatic.steps.findIndex(
      (step) => step.name === "Validate the atomic Modal benchmark generation"
    );
    const tokenIndex = automatic.steps.findIndex((step) => step.id === "publisher-token");
    const publishIndex = automatic.steps.indexOf(privilegedPublish!);
    expect(tokenIndex).toBeGreaterThan(buildIndex);
    expect(tokenIndex).toBeGreaterThan(validationIndex);
    expect(publishIndex).toBeGreaterThan(tokenIndex);
    expect(publication.jobs).not.toHaveProperty("publish_manual");
    expect(publication.jobs).not.toHaveProperty("open_publication_pr");
  });

  it("keeps direct App publications from recursively launching Modal", () => {
    const workspace = path.resolve("../..");
    const producer = parse(fs.readFileSync(path.join(workspace, ".github/workflows/eval-benchmarks.yml"), "utf8")) as {
      on: { push: { branches: string[]; "paths-ignore": string[] } };
    };
    expect(producer.on.push.branches).toEqual(["main"]);
    expect(producer.on.push["paths-ignore"]).toEqual([
      "benchmarks/history.json",
      "benchmarks/public-results/**",
      "docs/assets/eval-history/**"
    ]);

    const publisher = fs.readFileSync(path.join(workspace, "scripts/ci/publish-eval-history-cas.mjs"), "utf8");
    expect(publisher).toContain('const TARGET_BRANCH = "main"');
    expect(publisher).toContain('const COMMIT_MESSAGE = "Update published eval history"');
    expect(publisher).not.toContain("[ci skip]");
  });

  it("preserves partial launches and defers matrix failure until after artifact upload", () => {
    const workspace = path.resolve("../..");
    const workflowText = fs.readFileSync(path.join(workspace, ".github/workflows/eval-benchmarks.yml"), "utf8");
    const workflow = parse(workflowText) as {
      jobs: Record<
        string,
        {
          if?: string;
          "timeout-minutes"?: number;
          steps: Array<{
            name?: string;
            run?: string;
            if?: string;
            env?: Record<string, string>;
            "continue-on-error"?: boolean;
            with?: Record<string, unknown>;
          }>;
        }
      >;
    };
    const launch = workflow.jobs.launch!;
    const collect = workflow.jobs.collect!;
    const step = (name: string) => {
      const found = collect.steps.find((candidate) => candidate.name === name);
      expect(found, `missing collect step ${name}`).toBeDefined();
      return found!;
    };

    const launchScript = launch.steps.find(
      (candidate) => candidate.name === "Launch detached Modal benchmark sandboxes"
    )?.run;
    expect(launchScript).toContain("launch-attempts.jsonl");
    expect(launchScript).toContain("timeout --signal=TERM --kill-after=30s 20m");
    expect(launchScript).toContain("node packages/modal/dist/cli.js launch");
    expect(launchScript).toContain("launch_outcome=failed");
    expect(launchScript).not.toContain("exit 1");
    expect(launch["timeout-minutes"]).toBeGreaterThanOrEqual(180);

    expect(collect.if).toContain("!cancelled()");
    expect(collect.if).toContain("needs.launch.result != 'skipped'");
    expect(collect.if).not.toContain("always()");
    expect(collect["timeout-minutes"]).toBe(360);
    const restoreLaunch = step("Restore detached launch state candidates");
    expect(restoreLaunch["continue-on-error"]).toBe(true);
    expect(restoreLaunch.with?.pattern).toBe("modal-benchmark-launch-${{ env.BENCHMARK_MODE }}-${{ github.run_id }}-*");
    expect(restoreLaunch.with?.["run-id"]).toBe("${{ github.run_id }}");
    expect(restoreLaunch.with?.["github-token"]).toBe("${{ github.token }}");
    const selectLaunch = step("Select the newest compatible detached launch state");
    expect(selectLaunch.if).toBe("steps.restore_launch.outcome == 'success'");
    expect(selectLaunch.run).toContain('[ -f "$candidate_root/manifest.json" ]');
    expect(selectLaunch.run).toContain('selected="$candidate_root"');
    expect(selectLaunch.run).toContain("attempt > current_attempt");
    expect(selectLaunch.run).toContain("attempt > selected_attempt");
    expect(selectLaunch.run).toContain('cp -a -- "$selected"/. "$control_root"/');
    expect(step("Discover recoverable launch control").if).toBe("always()");

    const waitScript = step("Wait for Modal compute and retry only pre-model launch failures").run ?? "";
    expect(waitScript).toContain("launch-state-missing");
    expect(waitScript).toContain("launch-state-empty");
    expect(waitScript).toContain("initial-launch-recovery-succeeded");
    expect(waitScript).toContain("initial-launch-recovery-incomplete");
    expect(waitScript).toContain("initial-launch-recovery-timeout");
    expect(waitScript).toContain(".control_timeout_seconds");
    expect(waitScript).toContain("deadline=$((SECONDS + control_timeout_seconds))");
    expect(waitScript).not.toContain("SECONDS + 7200");
    expect(waitScript).toContain('"$recovery_exit" -eq 137');
    expect(waitScript).toContain("resume-attempt-timeout");
    expect(waitScript).toContain('.phase == "reserved"');
    expect(waitScript).toContain("recovery_mode=fresh");
    expect(waitScript).toContain("recovery_mode=resume");
    expect(waitScript.indexOf("initial-launch-recovery-succeeded")).toBeLessThan(
      waitScript.indexOf("launch-state-missing")
    );
    expect(waitScript).toContain("control-plane-timeout");
    expect(waitScript).toContain("timeout --signal=TERM --kill-after=30s 30s");
    expect(waitScript).toContain("status-query-timeout");
    expect(waitScript).not.toContain("exit 1");

    const collectScript = step("Collect and validate public finding bundles").run;
    expect(collectScript).toContain('.terminal_status == "succeeded"');
    expect(collectScript).toContain("timeout --signal=TERM --kill-after=30s 5m");
    expect(collectScript).toContain("max_parallel_collections=4");
    expect(collectScript).toContain("wait -n");
    expect(collectScript).toContain("node packages/modal/dist/cli.js collect");
    expect(collectScript).toContain('--config "$BENCHMARK_CONTROL/$config"');
    expect(collectScript).toContain('--state "$BENCHMARK_CONTROL/$state"');
    expect(collectScript).toContain('diagnostic_collection_status = "succeeded"');
    expect(collectScript).toContain('diagnostic_collection_status = "failed"');
    expect(collectScript).toContain('collection_status = "failed"');
    expect(collectScript).toContain("collection-timeout");
    expect(collectScript).not.toContain("rm -rf");

    const resultUpload = step("Upload public benchmark reports and findings");
    const diagnosticsUpload = step("Upload launch state and failure diagnostics");
    const finalGate = step("Fail an incomplete matrix after preserving artifacts");
    expect(resultUpload.if).toBe("always()");
    expect(resultUpload.with?.["if-no-files-found"]).toBe("warn");
    expect(diagnosticsUpload.if).toBe("always()");
    expect(finalGate.if).toBe("always()");
    expect(finalGate.env).toMatchObject({
      CI_EVENT_NAME: "${{ github.event_name }}",
      CI_REF_NAME: "${{ github.ref_name }}",
      CI_DEFAULT_BRANCH: "${{ github.event.repository.default_branch }}"
    });
    expect(collect.steps.indexOf(finalGate)).toBeGreaterThan(collect.steps.indexOf(resultUpload));
    expect(collect.steps.indexOf(finalGate)).toBeGreaterThan(collect.steps.indexOf(diagnosticsUpload));
    expect(finalGate.run).toContain("smoke_model_soft_fail=false");
    expect(finalGate.run).toContain('[ "$BENCHMARK_MODE" = smoke ]');
    expect(finalGate.run).toContain('[ "$CI_EVENT_NAME" = push ]');
    expect(finalGate.run).toContain('[ "$CI_REF_NAME" != "$CI_DEFAULT_BRANCH" ]');
    expect(finalGate.run).toContain("not blocking non-default branch smoke gate");
    expect(finalGate.run).toContain("describe-smoke-soft-fail.mjs --json");
    expect(finalGate.run).toContain('--ref "$CI_REF_NAME"');
    expect(finalGate.run).toContain(".blocks_gate == true");
    expect(finalGate.run).toContain(".scoring_ready_required == true");
    expect(finalGate.run).toContain("blocking validation-ref smoke gate because scoring readiness is required");
    expect(finalGate.run).toContain("not blocking validation-ref smoke gate because scoring readiness was validated");
    expect(finalGate.run).toContain("exit 1");

    // The soft-fail rule lives in exactly one jq filter, and the gate applies
    // that filter rather than restating a condition of its own.
    const softFailFilter = /^\s*smoke_soft_fail_filter='(?<filter>[^']+)'$/mu.exec(finalGate.run ?? "")?.groups?.filter;
    expect(softFailFilter).toBeTypeOf("string");
    expect(finalGate.run).toContain('jq -e "$smoke_soft_fail_filter" "$outcome_file"');
    expect(finalGate.run?.match(/smoke_soft_fail_filter=/gu)).toHaveLength(1);
    // A forgiven pair still announces itself as a run annotation.
    expect(finalGate.run).toContain("::warning::Modal smoke pair $pair failed operationally");

    const softFails = (outcome: Record<string, unknown>): boolean =>
      spawnSync("jq", ["-e", softFailFilter as string], { input: JSON.stringify(outcome), encoding: "utf8" }).status ===
      0;
    // #255: model work started and diagnostics survived.
    expect(
      softFails({
        pair: "openai-one",
        terminal_status: "failed",
        category: "resume-required",
        diagnostic_collection_status: "succeeded"
      })
    ).toBe(true);
    // #321: the same pair broke operationally and diagnostics did not survive.
    expect(
      softFails({
        pair: "openai-one",
        terminal_status: "failed",
        category: "permanent-operational-failure",
        diagnostic_collection_status: "failed"
      })
    ).toBe(true);
    for (const category of ["control-plane-timeout", "collection-failed", "launch-state-missing"]) {
      expect(softFails({ pair: "openai-one", terminal_status: "failed", category })).toBe(true);
    }
    // A genuine target outcome is scoring evidence and still hard-fails.
    expect(
      softFails({
        pair: "openai-one",
        terminal_status: "failed",
        category: "genuine-task-outcome",
        diagnostic_collection_status: "succeeded"
      })
    ).toBe(false);
    expect(
      softFails({
        pair: "openai-one",
        terminal_status: "succeeded",
        category: "succeeded",
        collection_status: "succeeded"
      })
    ).toBe(false);
  });

  it("hydrates pinned target submodules before initializing a public benchmark", () => {
    const workspace = path.resolve("../..");
    const worker = fs.readFileSync(path.join(workspace, "packages/modal/src/public-worker.ts"), "utf8");
    const clone = worker.indexOf(
      "await cloneAtCommit(target.repo, target.ref, destination, logPath, { initializeSubmodules: true"
    );
    const init = worker.indexOf('["node", CLI, "init", "--project", destination', clone);
    const checkout = worker.indexOf('["git", "checkout", "--detach", commit]');
    const submodules = worker.indexOf('["git", "submodule", "update", "--init", "--recursive", "--depth", "1"]');
    const timeoutCap = worker.indexOf("capModalTargetTopologyTimeouts", init);
    const referenceSync = worker.indexOf('["node", CLI, "references", "sync"', init);

    expect(clone).toBeGreaterThan(-1);
    expect(init).toBeGreaterThan(clone);
    expect(timeoutCap).toBeGreaterThan(init);
    expect(referenceSync).toBeGreaterThan(timeoutCap);
    expect(checkout).toBeGreaterThan(-1);
    expect(submodules).toBeGreaterThan(checkout);
  });
});
