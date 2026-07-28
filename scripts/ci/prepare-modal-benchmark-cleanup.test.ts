import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { boundedEvalId, safeEvalId } from "../../packages/evals/dist/index.js";
import { prepareModalBenchmarkCleanup, readCleanupNodeExecution } from "./prepare-modal-benchmark-cleanup.mjs";

const roots: string[] = [];
const candidate = "a".repeat(40);
const repository = "https://github.com/monad-developers/ultrafuzz";
const modelSlug = "benchmark-smoke-gpt-5-6-luna-high";
const pairId = `ultrafuzz-bench-${modelSlug}`;
const unscopedNestedControllerRunIds = cleanupTargets().map((target) => {
  const evalRunId = boundedEvalId(["ci-12345-2-smoke-ultrafuzz-bench-openai", modelSlug], 128);
  const rowId = safeEvalId([target.id, modelSlug, "trial-1"]);
  const rowRunId = safeEvalId(["ultrafuzz-bench-smoke", rowId]);
  return `ultrafuzz-${boundedEvalId([evalRunId, rowRunId], 118)}`;
});
const nestedControllerRunIds = unscopedNestedControllerRunIds.map((base, index) => {
  const target = cleanupTargets()[index]!;
  const projectRoot = path.resolve("/tmp/ultrafuzz-public-workspace", "targets", target.id);
  const suffix = createHash("sha256").update(projectRoot).digest("hex").slice(0, 12);
  return `${base.slice(0, 128 - suffix.length - 1).replace(/[-.]+$/u, "")}-${suffix}`;
});

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

  it("derives every exact nested Modal controller ID from the validated cloud matrix", () => {
    const fixture = cleanupFixture({ nodeExecution: "modal" });
    const row = `${pairId}.json\t${pairId}.state.json\t${nestedControllerRunIds.join(",")}`;
    expect(readCleanupNodeExecution(fixture.manifestPath)).toBe("modal");
    expect(prepareModalBenchmarkCleanup(fixture.input)).toEqual({
      imageName: `ufz-runner-${candidate}`,
      rows: [row]
    });
    expect(fs.readFileSync(fixture.outputPath, "utf8")).toBe(`${row}\n`);
  });

  it("rejects malformed or inconsistent cloud-node execution before selecting cleanup policy", () => {
    for (const execution of [
      { mode: "modal", dry_run: false, node_execution: "other", acceptance_e2e: false },
      { mode: "modal", dry_run: false, node_execution: "modal", acceptance_e2e: false },
      { mode: "local", dry_run: false, node_execution: "modal", acceptance_e2e: true },
      { mode: "modal", dry_run: false, node_execution: "modal", acceptance_e2e: true, extra: true }
    ]) {
      const fixture = cleanupFixture();
      const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, "utf8")) as CleanupManifest;
      manifest.execution = execution;
      fs.writeFileSync(fixture.manifestPath, `${JSON.stringify(manifest)}\n`);
      expect(() => readCleanupNodeExecution(fixture.manifestPath)).toThrow();
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
  execution: {
    mode: string;
    dry_run: boolean;
    node_execution?: string;
    acceptance_e2e?: boolean;
    extra?: boolean;
  };
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
    node_execution?: string;
    acceptance_e2e?: boolean;
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

function cleanupFixture(options: { nodeExecution?: "local" | "modal" } = {}) {
  const nodeExecution = options.nodeExecution ?? "local";
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
    execution:
      nodeExecution === "modal"
        ? { mode: "modal", dry_run: false, node_execution: "modal", acceptance_e2e: true }
        : { mode: "modal", dry_run: false },
    image_name: `ufz-runner-${candidate}`,
    targets: cleanupTargets(),
    matrix_rows_per_pair: 3,
    control_timeout_seconds: nodeExecution === "modal" ? 15_900 : 19_800,
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
      max_runtime_seconds: nodeExecution === "modal" ? 7200 : 15_000,
      ...(nodeExecution === "modal" ? { node_execution: "modal", acceptance_e2e: true } : {})
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
        controlTimeoutSeconds: nodeExecution === "modal" ? 15_900 : 19_800,
        nodeExecution
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
