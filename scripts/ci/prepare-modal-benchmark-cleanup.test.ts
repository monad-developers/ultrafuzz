import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { prepareModalBenchmarkCleanup } from "./prepare-modal-benchmark-cleanup.mjs";

const roots: string[] = [];
const candidate = "a".repeat(40);
const repository = "https://github.com/monad-developers/ultrafuzz";
const modelSlug = "benchmark-smoke-gpt-5-6-luna-high";
const pairId = `ultrafuzz-bench-${modelSlug}`;
const threatModelSlug = "benchmark-threat-model-gpt-5-6-luna-high";
const threatPairId = `ultrafuzz-bench-${threatModelSlug}`;

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

  it("accepts the exact canonical threat-model plan through both the cleanup API and CLI", () => {
    const fixture = threatModelCleanupFixture();
    const expectedRow = `${threatPairId}.json\t${threatPairId}.state.json`;
    expect(prepareModalBenchmarkCleanup(fixture.input)).toEqual({
      imageName: `ufz-runner-${fixture.candidate}`,
      rows: [expectedRow]
    });
    expect(fs.readFileSync(fixture.outputPath, "utf8")).toBe(`${expectedRow}\n`);

    const cliOutputPath = path.join(fixture.root, "pairs-cli.tsv");
    execFileSync(
      process.execPath,
      [
        path.join(fixture.workspace, "scripts/ci/prepare-modal-benchmark-cleanup.mjs"),
        fixture.manifestPath,
        cliOutputPath,
        fixture.candidate,
        repository,
        "54321-3",
        "threat-model",
        fixture.policyRoot
      ],
      { cwd: fixture.workspace }
    );
    expect(fs.readFileSync(cliOutputPath, "utf8")).toBe(`${expectedRow}\n`);
  });

  it("rejects any threat-model identity, model, concurrency, runtime, or config drift", () => {
    const cases: Array<(fixture: ReturnType<typeof threatModelCleanupFixture>) => void> = [
      (fixture) => {
        const manifest = readJson<CleanupManifest>(fixture.manifestPath);
        manifest.targets[0]!.revision = "b".repeat(40);
        writeJson(fixture.manifestPath, manifest);
      },
      (fixture) => {
        const manifest = readJson<CleanupManifest>(fixture.manifestPath);
        manifest.control_timeout_seconds = 19_799;
        writeJson(fixture.manifestPath, manifest);
      },
      (fixture) => {
        const manifest = readJson<CleanupManifest>(fixture.manifestPath);
        manifest.concurrency.max_parallel_workflow_nodes_per_row = 7;
        writeJson(fixture.manifestPath, manifest);
      },
      (fixture) => {
        const config = readJson<CleanupConfig>(path.join(fixture.root, `${threatPairId}.json`));
        config.models[0]!.model = "gpt-5.6-sol";
        writeJson(path.join(fixture.root, `${threatPairId}.json`), config);
      },
      (fixture) => {
        const config = readJson<CleanupConfig>(path.join(fixture.root, `${threatPairId}.json`));
        config.public_benchmark.max_runtime_seconds = 14_999;
        writeJson(path.join(fixture.root, `${threatPairId}.json`), config);
      },
      (fixture) => {
        const config = readJson<CleanupConfig>(path.join(fixture.root, `${threatPairId}.json`));
        config.braintrust.project = "candidate-controlled";
        writeJson(path.join(fixture.root, `${threatPairId}.json`), config);
      }
    ];
    for (const mutate of cases) {
      const fixture = threatModelCleanupFixture();
      mutate(fixture);
      expect(() => prepareModalBenchmarkCleanup(fixture.input)).toThrow();
      expect(fs.existsSync(fixture.outputPath)).toBe(false);
    }
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
    targets?: Array<{ id: string; repository: string; revision: string; framework: string }>;
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

function threatModelCleanupFixture() {
  const workspace = path.resolve(".");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-modal-threat-cleanup-"));
  roots.push(root);
  // The candidate checkout is authenticated as data, but its policy contents
  // deliberately carry no cleanup authority on the trusted default branch.
  const policyRoot = path.join(root, "candidate-policy");
  fs.mkdirSync(path.join(policyRoot, "benchmarks"), { recursive: true });
  writeJson(path.join(policyRoot, "benchmarks/lanes.json"), { candidate_policy: "not-trusted" });
  writeJson(path.join(policyRoot, "benchmarks/ultrafuzz-bench.json"), { candidate_policy: "not-trusted" });
  execFileSync("git", ["init", "--quiet"], { cwd: policyRoot });
  execFileSync("git", ["add", "benchmarks/lanes.json", "benchmarks/ultrafuzz-bench.json"], { cwd: policyRoot });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Ultrafuzz Tests",
      "-c",
      "user.email=tests@ultrafuzz.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture"
    ],
    { cwd: policyRoot }
  );
  const threatCandidate = execFileSync("git", ["rev-parse", "HEAD"], { cwd: policyRoot, encoding: "utf8" }).trim();
  const manifestPath = path.join(root, "manifest.json");
  const outputPath = path.join(root, "pairs-api.tsv");
  const targets = cleanupTargets();
  const manifest: CleanupManifest = {
    candidate_commit: threatCandidate,
    repository,
    generation: "54321-3",
    mode: "threat-model",
    benchmark: "ultrafuzz-bench",
    execution: { mode: "modal", dry_run: false },
    image_name: `ufz-runner-${threatCandidate}`,
    targets,
    matrix_rows_per_pair: 3,
    control_timeout_seconds: 19_800,
    concurrency: {
      max_parallel_eval_rows_per_sandbox: 3,
      max_parallel_workflow_nodes_per_row: 8,
      max_live_runner_workflows_by_provider: { openai: 3 },
      max_live_judge_rows: 3
    },
    pairs: [
      {
        pair: threatPairId,
        benchmark: "ultrafuzz-bench",
        mode: "threat-model",
        lane: "threat-model",
        model_slug: threatModelSlug,
        provider: "openai",
        config_path: `${threatPairId}.json`,
        state_path: `${threatPairId}.state.json`
      }
    ]
  };
  writeJson(manifestPath, manifest);
  const config: CleanupConfig = {
    schema_version: "ultrafuzz.modal.benchmark.v1",
    run_id: "ci-54321-3-threat-model-ultrafuzz-bench-openai",
    app_name: "ultrafuzz-evals",
    image_name: `ufz-runner-${threatCandidate}`,
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
      lane: "threat-model",
      runner_model_profile: threatModelSlug,
      candidate_repository: repository,
      candidate_commit: threatCandidate,
      targets,
      max_runtime_seconds: 15_000
    },
    models: [
      {
        slug: threatModelSlug,
        model: "gpt-5.6-luna",
        provider: "openai",
        agent: "CodexAgent",
        reasoning: "high",
        auth_mode: "api-key"
      }
    ]
  };
  writeJson(path.join(root, `${threatPairId}.json`), config);
  return {
    workspace,
    policyRoot,
    root,
    manifestPath,
    outputPath,
    candidate: threatCandidate,
    input: {
      manifestPath,
      outputPath,
      expectedCandidate: threatCandidate,
      expectedRepository: repository,
      expectedGeneration: "54321-3",
      expectedMode: "threat-model"
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
