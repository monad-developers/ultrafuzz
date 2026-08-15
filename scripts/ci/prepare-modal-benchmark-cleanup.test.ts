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

  it("resolves policy dimensions from the manifest's own smoke runner provider", () => {
    const fixture = cleanupFixture();
    const manifest = readJson<CleanupManifest>(fixture.manifestPath);
    manifest.concurrency.max_parallel_eval_rows_per_sandbox = 1;
    manifest.concurrency.max_parallel_workflow_nodes_per_row = 1;
    manifest.concurrency.max_live_runner_workflows_by_provider = { openrouter: 1 };
    manifest.concurrency.max_live_judge_rows = 1;
    manifest.control_timeout_seconds = 55_200;
    manifest.pairs[0]!.provider = "openrouter";
    writeJson(fixture.manifestPath, manifest);
    const config = readJson<CleanupConfig>(path.join(fixture.root, `${pairId}.json`));
    config.models[0]!.provider = "openrouter";
    config.models[0]!.agent = "OpenRouterAgent";
    config.run_id = "ci-12345-2-smoke-ultrafuzz-bench-openrouter";
    config.public_benchmark.max_runtime_seconds = 15_000;
    writeJson(path.join(fixture.root, `${pairId}.json`), config);

    const observed: Array<string | undefined> = [];
    expect(
      prepareModalBenchmarkCleanup({
        ...fixture.input,
        policyDimensions: (runnerProvider: string | undefined) => {
          observed.push(runnerProvider);
          return {
            ...fixture.input.policyDimensions,
            maxParallelEvalRows: runnerProvider === "openrouter" ? 1 : 3,
            maxParallelWorkflowNodes: runnerProvider === "openrouter" ? 1 : 4,
            maxRuntimeSeconds: 15_000,
            controlTimeoutSeconds: 55_200
          };
        }
      })
    ).toEqual({
      imageName: `ufz-runner-${candidate}`,
      rows: [`${pairId}.json\t${pairId}.state.json`]
    });
    expect(observed).toEqual(["openrouter"]);
  });

  it("rejects the removed threat-model control mode instead of converting or tolerating it", () => {
    const fixture = cleanupFixture();
    const manifest = readJson<CleanupManifest>(fixture.manifestPath);
    manifest.mode = "threat-model";
    manifest.pairs[0]!.mode = "threat-model";
    manifest.pairs[0]!.lane = "threat-model";
    writeJson(fixture.manifestPath, manifest);

    expect(() => prepareModalBenchmarkCleanup(fixture.input)).toThrow(/benchmark-control-manifest/iu);
    expect(() =>
      prepareModalBenchmarkCleanup({
        ...fixture.input,
        expectedMode: "threat-model"
      })
    ).toThrow(/cleanup mode must be smoke or full/u);
    expect(fs.existsSync(fixture.outputPath)).toBe(false);
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

  it("rejects duplicate config keys at the cleanup trust boundary", () => {
    const fixture = cleanupFixture();
    const configPath = path.join(fixture.root, `${pairId}.json`);
    const config = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(configPath, config.replace('"run_id":', '"run_id":"shadowed","run_id":'));

    expect(() => prepareModalBenchmarkCleanup(fixture.input)).toThrow(/duplicate/iu);
    expect(fs.existsSync(fixture.outputPath)).toBe(false);
  });

  it("refuses to replace an existing cleanup pair list", () => {
    const fixture = cleanupFixture();
    fs.writeFileSync(fixture.outputPath, "existing\n");
    expect(() => prepareModalBenchmarkCleanup(fixture.input)).toThrow();
    expect(fs.readFileSync(fixture.outputPath, "utf8")).toBe("existing\n");
  });
});

interface CleanupManifest {
  schema_version: "ultrafuzz.modal.benchmark-control-manifest.v1";
  candidate_commit: string;
  repository: string;
  generation: string;
  mode: string;
  benchmark: string;
  execution: { mode: string; dry_run: boolean };
  image_name: string;
  targets: Array<{ id: string; repository: string; revision: string; framework: string }>;
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
    targets: Array<{ id: string; repository: string; revision: string; framework: string }>;
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
    schema_version: "ultrafuzz.modal.benchmark-control-manifest.v1",
    candidate_commit: candidate,
    repository,
    generation: "12345-2",
    mode: "smoke",
    benchmark: "ultrafuzz-bench",
    execution: { mode: "modal", dry_run: false },
    image_name: `ufz-runner-${candidate}`,
    targets: cleanupTargets(),
    matrix_rows_per_pair: 3,
    control_timeout_seconds: 8_400,
    concurrency: {
      max_parallel_eval_rows_per_sandbox: 3,
      max_parallel_workflow_nodes_per_row: 4,
      max_live_runner_workflows_by_provider: { openai: 3 },
      max_live_judge_rows: 3
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
    schema_version: "ultrafuzz.modal.benchmark.v2",
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
      targets: cleanupTargets(),
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
      expectedMode: "smoke",
      policyDimensions: {
        targets: cleanupTargets(),
        targetIds: cleanupTargets().map((target) => target.id),
        targetCount: 3,
        trialsPerVariant: 1,
        maxParallelEvalRows: 3,
        maxParallelWorkflowNodes: 4,
        maxRuntimeSeconds: 3600,
        controlTimeoutSeconds: 8_400
      }
    }
  };
}

function cleanupTargets() {
  return [
    {
      id: "very-liquid-vaults-foundry",
      repository: "https://github.com/rheo-xyz/very-liquid-vaults",
      revision: "e50384709a696c86ab0440bbbc3dd14a5f4ff6ec",
      framework: "foundry"
    },
    {
      id: "venus-isolated-pools-hardhat",
      repository: "https://github.com/code-423n4/2023-05-venus",
      revision: "9853f6f4fe906b635e214b22de9f627c6a17ba5b",
      framework: "hardhat"
    },
    {
      id: "stableswap-ng-vyper",
      repository: "https://github.com/curvefi/stableswap-ng",
      revision: "8c78731ed43c22e6bcdcb5d39b0a7d02f8cb0386",
      framework: "vyper"
    }
  ];
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function writeJson(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}
