import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { prepareModalBenchmarkCleanup } from "./prepare-modal-benchmark-cleanup.mjs";

const roots: string[] = [];
const candidate = "a".repeat(40);
const repository = "https://github.com/monad-developers/ultrafuzz";
const modelSlug = "benchmark-smoke-gpt-5-6-luna-high";
const pairId = `ultrafuzz-bench-${modelSlug}`;

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("cancelled Modal benchmark cleanup preparation", () => {
  it("accepts an exact smoke plan and writes only canonical config/state pairs", () => {
    const fixture = cleanupFixture();
    expect(prepareModalBenchmarkCleanup(fixture.input)).toEqual({
      imageName: `ufz-runner-${candidate}`,
      rows: [`${pairId}.json\t${pairId}.state.json`]
    });
    expect(fs.readFileSync(fixture.outputPath, "utf8")).toBe(`${pairId}.json\t${pairId}.state.json\n`);
  });

  it("rejects manifest identity drift, unsafe paths, and non-regular controls", () => {
    for (const mutate of [
      (manifest: CleanupManifest) => (manifest.candidate_commit = "b".repeat(40)),
      (manifest: CleanupManifest) => (manifest.pairs[0]!.config_path = "../escape.json"),
      (manifest: CleanupManifest) => (manifest.pairs[0]!.state_path = "other.state.json")
    ]) {
      const fixture = cleanupFixture();
      const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, "utf8")) as CleanupManifest;
      mutate(manifest);
      fs.writeFileSync(fixture.manifestPath, `${JSON.stringify(manifest)}\n`);
      expect(() => prepareModalBenchmarkCleanup(fixture.input)).toThrow();
    }

    const symlinkFixture = cleanupFixture();
    fs.unlinkSync(path.join(symlinkFixture.root, `${pairId}.json`));
    fs.symlinkSync(symlinkFixture.manifestPath, path.join(symlinkFixture.root, `${pairId}.json`));
    expect(() => prepareModalBenchmarkCleanup(symlinkFixture.input)).toThrow(/bounded regular file/u);
  });

  it("rejects authority-bearing config drift before producing a termination list", () => {
    for (const mutate of [
      (config: CleanupConfig) => (config.app_name = "other-app"),
      (config: CleanupConfig) => (config.run_id = "ci-999-1-smoke-ultrafuzz-bench-openai"),
      (config: CleanupConfig) => (config.image_name = "ufz-runner-other"),
      (config: CleanupConfig) => (config.public_benchmark.candidate_commit = "b".repeat(40)),
      (config: CleanupConfig) => (config.models[0]!.slug = "benchmark-smoke-other-high")
    ]) {
      const fixture = cleanupFixture();
      const configPath = path.join(fixture.root, `${pairId}.json`);
      const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as CleanupConfig;
      mutate(config);
      fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
      expect(() => prepareModalBenchmarkCleanup(fixture.input)).toThrow();
      expect(fs.existsSync(fixture.outputPath)).toBe(false);
    }
  });

  it("refuses to replace an existing cleanup pair list", () => {
    const fixture = cleanupFixture();
    fs.writeFileSync(fixture.outputPath, "existing\n");
    expect(() => prepareModalBenchmarkCleanup(fixture.input)).toThrow();
    expect(fs.readFileSync(fixture.outputPath, "utf8")).toBe("existing\n");
  });
});

interface CleanupManifest {
  candidate_commit: string;
  repository: string;
  generation: string;
  mode: string;
  benchmark: string;
  image_name: string;
  matrix_rows_per_pair: number;
  control_timeout_seconds: number;
  concurrency: {
    max_parallel_eval_rows_per_sandbox: number;
    max_parallel_workflow_nodes_per_row: number;
    max_live_runner_workflows_by_provider: Record<string, number>;
    max_live_judge_rows: number;
  };
  pairs: Array<{
    pair: string;
    benchmark: string;
    mode: string;
    lane: string;
    model_slug: string;
    provider: string;
    config_path: string;
    state_path: string;
  }>;
}

interface CleanupConfig {
  schema_version: string;
  run_id: string;
  app_name: string;
  image_name: string;
  braintrust: Record<string, unknown>;
  node_timeout_seconds: number;
  loops: number;
  public_benchmark: {
    benchmark: string;
    lane: string;
    runner_model_profile: string;
    candidate_repository: string;
    candidate_commit: string;
    max_runtime_seconds: number;
  };
  models: Array<{
    slug: string;
    model: string;
    provider: string;
    agent: string;
    reasoning: string;
    auth_mode: string;
  }>;
}

function cleanupFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-cleanup-"));
  roots.push(root);
  const manifestPath = path.join(root, "manifest.json");
  const outputPath = path.join(root, "pairs.tsv");
  const manifest: CleanupManifest = {
    candidate_commit: candidate,
    repository,
    generation: "12345-2",
    mode: "smoke",
    benchmark: "ultrafuzz-bench",
    image_name: `ufz-runner-${candidate}`,
    matrix_rows_per_pair: 3,
    control_timeout_seconds: 14_700,
    concurrency: {
      max_parallel_eval_rows_per_sandbox: 2,
      max_parallel_workflow_nodes_per_row: 8,
      max_live_runner_workflows_by_provider: { openai: 2 },
      max_live_judge_rows: 2
    },
    pairs: [
      {
        pair: pairId,
        benchmark: "ultrafuzz-bench",
        mode: "smoke",
        lane: "smoke",
        model_slug: modelSlug,
        provider: "openai",
        config_path: `${pairId}.json`,
        state_path: `${pairId}.state.json`
      }
    ]
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  const config: CleanupConfig = {
    schema_version: "ultrafuzz.modal.benchmark.v1",
    run_id: "ci-12345-2-smoke-ultrafuzz-bench-openai",
    app_name: "ultrafuzz-evals",
    image_name: `ufz-runner-${candidate}`,
    braintrust: {
      project: "ultrafuzz-public-benchmarks",
      api_key_env: "BRAINTRUST_API_KEY",
      judge_api_key_env: "OPENAI_API_KEY",
      judge_url: "https://api.openai.com/v1/chat/completions",
      judge_credential_ttl_seconds: 57_600
    },
    node_timeout_seconds: 1800,
    loops: 1,
    public_benchmark: {
      benchmark: "ultrafuzz-bench",
      lane: "smoke",
      runner_model_profile: modelSlug,
      candidate_repository: repository,
      candidate_commit: candidate,
      max_runtime_seconds: 3600
    },
    models: [
      {
        slug: modelSlug,
        model: "gpt-5.6-luna",
        provider: "openai",
        agent: "CodexAgent",
        reasoning: "high",
        auth_mode: "api-key"
      }
    ]
  };
  fs.writeFileSync(path.join(root, `${pairId}.json`), `${JSON.stringify(config)}\n`);
  return {
    root,
    manifestPath,
    outputPath,
    input: {
      manifestPath,
      outputPath,
      expectedCandidate: candidate,
      expectedRepository: repository,
      expectedGeneration: "12345-2",
      expectedMode: "smoke"
    }
  };
}
