import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  automaticProducerPolicyDimensions,
  assertPublicBenchmarkBundleMatrixScope,
  readAutomaticPublicationManifest,
  summarizePublicBenchmarkBundlePublication,
  trustedCandidateRuntimePolicyDimensions,
  validateAutomaticPublicationManifest,
  validateAutomaticPairConfig,
  validateBenchmarkPolicyFiles,
  validateProducerPolicyDimensions
} from "./prepare-eval-history-publication.mjs";

const roots: string[] = [];
const context = {
  candidateCommit: "a".repeat(40),
  repository: "https://github.com/monad-developers/ultrafuzz",
  producerRunId: "12345",
  producerRunAttempt: "2",
  mode: "smoke"
} as const;

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("trusted automatic eval-history publication handoff", () => {
  it("accepts only the exact event-bound smoke manifest", () => {
    expect(validateAutomaticPublicationManifest(smokeManifest(), smokeContext())).toEqual(smokeManifest());
  });

  it("accepts a safe overridden smoke runner before unpacking producer bundles", () => {
    const modelSlug = "benchmark-smoke-gpt-5-6-luna-202607-high";
    const pair = {
      ...smokeManifest().pairs[0]!,
      pair: `ultrafuzz-bench-${modelSlug}`,
      model_slug: modelSlug,
      config_path: `ultrafuzz-bench-${modelSlug}.json`
    };
    const model = {
      slug: modelSlug,
      model: "gpt-5.6-luna-202607",
      provider: "openai",
      agent: "CodexAgent",
      reasoning: "high",
      auth_mode: "api-key"
    };
    const config = {
      schema_version: "ultrafuzz.modal.benchmark.v1",
      run_id: "ci-12345-2-smoke-ultrafuzz-bench-openai",
      app_name: "ultrafuzz-evals",
      image_name: `ufz-runner-${"a".repeat(40)}`,
      node_timeout_seconds: 1800,
      loops: 1,
      braintrust: {
        project: "ultrafuzz-public-benchmarks",
        api_key_env: "BRAINTRUST_API_KEY",
        judge_api_key_env: "OPENAI_API_KEY",
        judge_url: "https://api.openai.com/v1/chat/completions"
      },
      public_benchmark: {
        benchmark: "ultrafuzz-bench",
        lane: "smoke",
        runner_model_profile: modelSlug,
        candidate_repository: context.repository,
        candidate_commit: context.candidateCommit,
        targets: smokeTargets(),
        max_runtime_seconds: 15_000
      }
    };
    expect(
      validateAutomaticPairConfig(
        config,
        model,
        pair,
        {
          ...context,
          generation: "12345-2",
          benchmark: "ultrafuzz-bench",
          targets: smokeTargets()
        },
        new Set()
      )
    ).toBeUndefined();
  });

  it("rejects untrusted identity, topology, provider, and path mutations", () => {
    const cases: Array<[string, (manifest: ReturnType<typeof smokeManifest>) => void]> = [
      ["unexpected root field", (manifest) => Object.assign(manifest, { command: "echo unsafe" })],
      ["candidate", (manifest) => (manifest.candidate_commit = "b".repeat(40))],
      ["repository", (manifest) => (manifest.repository = "https://github.com/example/other")],
      ["generation", (manifest) => (manifest.generation = "12345-1")],
      ["mode", (manifest) => (manifest.mode = "full")],
      ["benchmark", (manifest) => (manifest.benchmark = "evmbench")],
      ["execution mode", (manifest) => (manifest.execution.mode = "local")],
      ["dry run", (manifest) => (manifest.execution.dry_run = true)],
      ["image", (manifest) => (manifest.image_name = "ufz-runner-other")],
      ["target count", (manifest) => manifest.targets.pop()],
      ["target duplicate", (manifest) => (manifest.targets[1] = manifest.targets[0]!)],
      ["target repository", (manifest) => (manifest.targets[0]!.repository = "https://example.com/other")],
      ["matrix row count", (manifest) => (manifest.matrix_rows_per_pair = 4)],
      ["pair provider", (manifest) => (manifest.pairs[0]!.provider = "anthropic")],
      ["pair field", (manifest) => Object.assign(manifest.pairs[0]!, { extra: true })],
      ["pair traversal", (manifest) => (manifest.pairs[0]!.pair = "../escape")],
      ["config traversal", (manifest) => (manifest.pairs[0]!.config_path = "../config.json")],
      ["state absolute path", (manifest) => (manifest.pairs[0]!.state_path = "/tmp/state.json")],
      ["state backslash", (manifest) => (manifest.pairs[0]!.state_path = "pair\\state.json")],
      ["state control character", (manifest) => (manifest.pairs[0]!.state_path = "pair\n.state.json")],
      ["model slug lane", (manifest) => (manifest.pairs[0]!.model_slug = "benchmark-full-model-high")]
    ];
    for (const [label, mutate] of cases) {
      const manifest = smokeManifest();
      mutate(manifest);
      expect(() => validateAutomaticPublicationManifest(manifest, smokeContext()), label).toThrow();
    }
  });

  it("accepts a dispatched smoke runner from any known provider", () => {
    // `smoke_provider` lets a dispatch point the one-runner smoke lane at a provider
    // other than the openai control pair. The lane pinned that provider to openai, so
    // every non-openai dispatch died in pre-flight and no such pair could ever score.
    for (const provider of ["deepseek", "anthropic", "kimi"]) {
      const manifest = smokeProviderManifest(provider);
      expect(
        validateAutomaticPublicationManifest(manifest, smokeContext()).pairs.map((pair) => pair.provider),
        provider
      ).toEqual([provider]);
    }
  });

  it("still pins the smoke lane to one runner from a known provider", () => {
    const unknownProvider = smokeProviderManifest("deepseek");
    unknownProvider.pairs[0]!.provider = "mystery";
    expect(() => validateAutomaticPublicationManifest(unknownProvider, smokeContext())).toThrow();

    const twoRunners = smokeProviderManifest("deepseek");
    twoRunners.pairs.push({ ...twoRunners.pairs[0]! });
    expect(() => validateAutomaticPublicationManifest(twoRunners, smokeContext())).toThrow();

    // A caller that states the provider explicitly still wins over the manifest.
    expect(() =>
      validateAutomaticPublicationManifest(smokeProviderManifest("deepseek"), {
        ...smokeContext(),
        smokeProvider: "openai"
      })
    ).toThrow();
  });

  it("requires the exact full provider set, ordering, and unique control paths", () => {
    const fullContext = fullPublicationContext();
    expect(
      validateAutomaticPublicationManifest(fullManifest(), fullContext).pairs.map((pair) => pair.provider)
    ).toEqual(["openai", "anthropic", "kimi", "deepseek"]);

    for (const mutate of [
      (manifest: ReturnType<typeof fullManifest>) => manifest.pairs.pop(),
      (manifest: ReturnType<typeof fullManifest>) => (manifest.pairs[1]!.provider = "openai"),
      (manifest: ReturnType<typeof fullManifest>) => (manifest.pairs[1]!.pair = manifest.pairs[0]!.pair),
      (manifest: ReturnType<typeof fullManifest>) => (manifest.pairs[1]!.model_slug = manifest.pairs[0]!.model_slug),
      (manifest: ReturnType<typeof fullManifest>) => (manifest.pairs[1]!.config_path = manifest.pairs[0]!.config_path),
      (manifest: ReturnType<typeof fullManifest>) => (manifest.pairs[1]!.state_path = manifest.pairs[0]!.state_path),
      (manifest: ReturnType<typeof fullManifest>) => (manifest.pairs[2]!.provider = "anthropic"),
      (manifest: ReturnType<typeof fullManifest>) => (manifest.pairs[3]!.provider = "kimi")
    ]) {
      const manifest = fullManifest();
      mutate(manifest);
      expect(() => validateAutomaticPublicationManifest(manifest, fullContext)).toThrow();
    }
  });

  it("accepts policy-derived trial and cohort matrix dimensions", () => {
    const manifest = smokeManifest();
    manifest.matrix_rows_per_pair = 6;
    manifest.control_timeout_seconds = 37_500;
    expect(
      validateAutomaticPublicationManifest(manifest, {
        ...smokeContext(),
        targetCount: 3,
        trialsPerVariant: 2
      })
    ).toEqual(manifest);

    const changedCohort = fullManifest();
    changedCohort.targets.push({
      id: "target-41",
      repository: "https://github.com/example/target-41",
      revision: "b".repeat(40),
      framework: "foundry"
    });
    changedCohort.matrix_rows_per_pair = 41;
    changedCohort.control_timeout_seconds = 21_000;
    expect(
      validateAutomaticPublicationManifest(changedCohort, {
        ...context,
        mode: "full",
        targets: changedCohort.targets,
        targetCount: 41,
        trialsPerVariant: 1
      })
    ).toEqual(changedCohort);
  });

  it("accepts an older-policy producer with newer publication tooling", () => {
    const root = temporaryRoot("ultrafuzz-publication-older-policy-");
    const manifest = smokeManifest();
    manifest.control_timeout_seconds = 12_000;
    const pair = manifest.pairs[0]!;
    fs.writeFileSync(
      path.join(root, pair.config_path),
      `${JSON.stringify({ public_benchmark: { max_runtime_seconds: 7_200 } })}\n`
    );

    const producerPolicy = automaticProducerPolicyDimensions(manifest, root);
    expect(producerPolicy).toEqual({
      matrixRowsPerPair: 3,
      controlTimeoutSeconds: 12_000,
      maxParallelEvalRows: 3,
      maxParallelWorkflowNodes: 4,
      maxRuntimeSeconds: 7_200
    });
    expect(validateProducerPolicyDimensions(producerPolicy, { ...producerPolicy })).toEqual(producerPolicy);
    expect(() =>
      validateProducerPolicyDimensions(producerPolicy, {
        ...producerPolicy,
        maxRuntimeSeconds: 15_000,
        controlTimeoutSeconds: 19_800
      })
    ).toThrow(/trusted candidate policy/u);
    expect(
      validateAutomaticPublicationManifest(manifest, {
        ...smokeContext(),
        ...producerPolicy
      })
    ).toEqual(manifest);
  });

  it("reads runtime and concurrency policy from the trusted candidate checkout", () => {
    expect(trustedCandidateRuntimePolicyDimensions(process.cwd(), "smoke")).toEqual({
      maxParallelEvalRows: 3,
      maxParallelWorkflowNodes: 4,
      maxRuntimeSeconds: 15_000,
      evalCleanupSeconds: 300,
      scorePerWaveTimeoutSeconds: 2_700,
      reportTimeoutSeconds: 300,
      preparationTimeoutSeconds: 1_200,
      controlPollingGraceSeconds: 300
    });
  });

  it("ignores declaration-shaped comments, strings, templates, and nested constants", () => {
    const root = temporaryRoot("ultrafuzz-publication-policy-decoys-");
    const benchmarkPath = path.join(root, "packages/evals/src/benchmark-manifest.ts");
    const workerPath = path.join(root, "packages/modal/src/public-worker.ts");
    const preparationPath = path.join(root, "scripts/ci/prepare-modal-benchmarks.mjs");
    for (const filePath of [benchmarkPath, workerPath, preparationPath]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    fs.writeFileSync(
      benchmarkPath,
      [
        'const decoy = "export const BENCHMARK_SMOKE_MAX_PARALLEL_RUNS = 99;";',
        "// export const BENCHMARK_SMOKE_MAX_PARALLEL_TARGETS = 98;",
        "function nested() { const BENCHMARK_SMOKE_MAX_PARALLEL_RUNS = 97; return 97; }",
        "export const BENCHMARK_SMOKE_MAX_PARALLEL_RUNS = 3;",
        "export const BENCHMARK_SMOKE_MAX_PARALLEL_TARGETS = 4;"
      ].join("\n")
    );
    fs.writeFileSync(
      workerPath,
      [
        "const decoy = `export const PUBLIC_BENCHMARK_SMOKE_MAX_RUNTIME_SECONDS = 99;`;",
        "/* export const PUBLIC_BENCHMARK_EVAL_CLEANUP_SECONDS = 98; */",
        "export const PUBLIC_BENCHMARK_SMOKE_MAX_RUNTIME_SECONDS = 2 * 60 * 60;",
        "export const PUBLIC_BENCHMARK_EVAL_CLEANUP_SECONDS = 5 * 60;",
        "export const PUBLIC_BENCHMARK_SCORE_PER_WAVE_TIMEOUT_SECONDS = 45 * 60;",
        "export const PUBLIC_BENCHMARK_REPORT_TIMEOUT_SECONDS = 5 * 60;",
        "export const PUBLIC_BENCHMARK_PREPARATION_TIMEOUT_SECONDS = 20 * 60;"
      ].join("\n")
    );
    fs.writeFileSync(
      preparationPath,
      [
        'const decoy = "const PUBLIC_CONTROL_POLLING_GRACE_SECONDS = 99;";',
        "const PUBLIC_CONTROL_POLLING_GRACE_SECONDS = 5 * 60;"
      ].join("\n")
    );

    expect(trustedCandidateRuntimePolicyDimensions(root, "smoke")).toEqual({
      maxParallelEvalRows: 3,
      maxParallelWorkflowNodes: 4,
      maxRuntimeSeconds: 7_200,
      evalCleanupSeconds: 300,
      scorePerWaveTimeoutSeconds: 2_700,
      reportTimeoutSeconds: 300,
      preparationTimeoutSeconds: 1_200,
      controlPollingGraceSeconds: 300
    });
  });

  it("rejects public bundles that omit a trusted target even when the row count still matches", () => {
    const targetIds = ["very-liquid-vaults-foundry", "venus-isolated-pools-hardhat", "stableswap-ng-vyper"];
    const modelSlug = smokeManifest().pairs[0]!.model_slug;
    const pair = smokeManifest().pairs[0]!.pair;
    const expected = {
      matrixRowsPerPair: 3,
      targetIds,
      trialsPerVariant: 1,
      modelSlug
    };

    expect(() =>
      assertPublicBenchmarkBundleMatrixScope(bundleWithMatrix(matrixRows(targetIds, modelSlug)), expected, pair)
    ).not.toThrow();
    expect(() =>
      assertPublicBenchmarkBundleMatrixScope(
        bundleWithMatrix(matrixRows([targetIds[0]!, targetIds[1]!, targetIds[1]!], modelSlug)),
        expected,
        pair
      )
    ).toThrow(/missing target result\(s\).*stableswap-ng-vyper/u);
    expect(() =>
      assertPublicBenchmarkBundleMatrixScope(
        bundleWithMatrix(matrixRows([targetIds[0]!, targetIds[1]!], modelSlug)),
        expected,
        pair
      )
    ).toThrow(/row count 2 does not match expected 3/u);
  });

  it("summarizes only complete scored public bundles for automatic history ingestion", () => {
    const targetIds = ["very-liquid-vaults-foundry", "venus-isolated-pools-hardhat", "stableswap-ng-vyper"];
    const modelSlug = smokeManifest().pairs[0]!.model_slug;
    const pair = smokeManifest().pairs[0]!.pair;
    const expected = {
      matrixRowsPerPair: 3,
      targetIds,
      trialsPerVariant: 1,
      modelSlug,
      evalRunId: "ci-12345-2-smoke-ultrafuzz-bench-openai-benchmark-smoke-gpt-5-6-luna-high"
    };
    const publicationUrl = "https://github.com/monad-developers/ultrafuzz/actions/runs/12345/artifacts";

    expect(
      summarizePublicBenchmarkBundlePublication(
        completeHistoryBundle(matrixRows(targetIds, modelSlug), expected.evalRunId),
        expected,
        pair,
        publicationUrl
      )
    ).toEqual({
      status: "succeeded",
      target_ids: targetIds,
      executed_case_count: 3,
      graded_case_count: 3,
      publication_url: publicationUrl
    });
    const failedBundle = completeHistoryBundle(matrixRows(targetIds, modelSlug), expected.evalRunId);
    failedBundle.status = "failed";
    failedBundle.targets[2]!.status = "failed";
    expect(summarizePublicBenchmarkBundlePublication(failedBundle, expected, pair, publicationUrl)).toMatchObject({
      status: "failed",
      executed_case_count: 3,
      graded_case_count: 3
    });
    expect(() =>
      summarizePublicBenchmarkBundlePublication(
        completeHistoryBundle(matrixRows(targetIds, modelSlug), expected.evalRunId, { launched: 0 }),
        expected,
        pair,
        publicationUrl
      )
    ).toThrow(/executed case count/u);
    expect(() =>
      summarizePublicBenchmarkBundlePublication(
        completeHistoryBundle(matrixRows(targetIds, modelSlug), expected.evalRunId, {}, { rows: [] }),
        expected,
        pair,
        publicationUrl
      )
    ).toThrow(/graded case count/u);
  });

  it("rejects symlinked and oversized producer manifests before parsing", () => {
    const root = temporaryRoot("ultrafuzz-publication-manifest-");
    const target = path.join(root, "manifest.json");
    fs.writeFileSync(target, `${JSON.stringify(smokeManifest())}\n`);
    const symlink = path.join(root, "manifest-link.json");
    fs.symlinkSync(target, symlink);
    expect(() => readAutomaticPublicationManifest(symlink, smokeContext())).toThrow();

    const oversized = path.join(root, "oversized.json");
    fs.writeFileSync(oversized, " ".repeat(1024 * 1024 + 1));
    expect(() => readAutomaticPublicationManifest(oversized, smokeContext())).toThrow();
  });

  it("rejects a clean candidate policy commit whose selected manifest is a symlink", () => {
    const root = temporaryRoot("ultrafuzz-publication-policy-");
    fs.mkdirSync(path.join(root, "benchmarks"));
    fs.writeFileSync(path.join(root, "benchmarks/lanes.json"), "{}\n");
    fs.writeFileSync(path.join(root, "benchmarks/ultrafuzz-bench.json"), "{}\n");
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.name", "Test"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["add", "benchmarks"]);
    git(root, ["commit", "-m", "regular policy"]);
    const regularCommit = git(root, ["rev-parse", "HEAD"]).trim();
    expect(
      validateBenchmarkPolicyFiles({
        policyRoot: root,
        candidateCommit: regularCommit,
        benchmark: "ultrafuzz-bench"
      })
    ).toBe(fs.realpathSync(root));

    fs.unlinkSync(path.join(root, "benchmarks/lanes.json"));
    fs.writeFileSync(path.join(root, "outside.json"), "{}\n");
    fs.symlinkSync("../outside.json", path.join(root, "benchmarks/lanes.json"));
    git(root, ["add", "benchmarks/lanes.json"]);
    git(root, ["commit", "-m", "symlink policy"]);
    const symlinkCommit = git(root, ["rev-parse", "HEAD"]).trim();
    expect(() =>
      validateBenchmarkPolicyFiles({
        policyRoot: root,
        candidateCommit: symlinkCommit,
        benchmark: "ultrafuzz-bench"
      })
    ).toThrow(/symbolic link/u);
  });
});

function smokeContext() {
  return { ...context, targets: smokeTargets() };
}

function smokeProviderManifest(provider: string) {
  const modelSlug = `benchmark-smoke-${provider}-runner-max`;
  const pair = `ultrafuzz-bench-${modelSlug}`;
  return {
    ...smokeManifest(),
    concurrency: {
      ...smokeManifest().concurrency,
      max_live_runner_workflows_by_provider: { [provider]: 3 }
    },
    pairs: [
      {
        ...smokeManifest().pairs[0]!,
        pair,
        model_slug: modelSlug,
        provider,
        config_path: `${pair}.json`,
        state_path: `${pair}.state.json`
      }
    ]
  };
}

function fullPublicationContext() {
  return { ...context, mode: "full" as const, targets: fullTargets() };
}

function smokeManifest() {
  const modelSlug = "benchmark-smoke-gpt-5-6-luna-high";
  const pair = `ultrafuzz-bench-${modelSlug}`;
  return {
    candidate_commit: "a".repeat(40),
    repository: "https://github.com/monad-developers/ultrafuzz",
    generation: "12345-2",
    mode: "smoke",
    benchmark: "ultrafuzz-bench",
    execution: { mode: "modal", dry_run: false },
    image_name: `ufz-runner-${"a".repeat(40)}`,
    targets: smokeTargets(),
    matrix_rows_per_pair: 3,
    control_timeout_seconds: 19_800,
    concurrency: {
      max_parallel_eval_rows_per_sandbox: 3,
      max_parallel_workflow_nodes_per_row: 4,
      max_live_runner_workflows_by_provider: { openai: 3 },
      max_live_judge_rows: 3
    },
    pairs: [
      {
        pair,
        benchmark: "ultrafuzz-bench",
        mode: "smoke",
        lane: "smoke",
        model_slug: modelSlug,
        provider: "openai",
        config_path: `${pair}.json`,
        state_path: `${pair}.state.json`
      }
    ]
  };
}

function fullManifest() {
  const pairs = [
    ["openai", "benchmark-full-gpt-5-6-luna-high"],
    ["anthropic", "benchmark-full-claude-sonnet-5-high"],
    ["kimi", "benchmark-full-kimi-k3-max"],
    ["deepseek", "benchmark-full-deepseek-v4-pro-max"]
  ].map(([provider, modelSlug]) => {
    const pair = `evmbench-${modelSlug}`;
    return {
      pair,
      benchmark: "evmbench",
      mode: "full",
      lane: "full",
      model_slug: modelSlug,
      provider,
      config_path: `${pair}.json`,
      state_path: `${pair}.state.json`
    };
  });
  return {
    candidate_commit: "a".repeat(40),
    repository: "https://github.com/monad-developers/ultrafuzz",
    generation: "12345-2",
    mode: "full",
    benchmark: "evmbench",
    execution: { mode: "modal", dry_run: false },
    image_name: `ufz-runner-${"a".repeat(40)}`,
    targets: fullTargets(),
    matrix_rows_per_pair: 40,
    control_timeout_seconds: 14_700,
    concurrency: {
      max_parallel_eval_rows_per_sandbox: 20,
      max_parallel_workflow_nodes_per_row: 8,
      max_live_runner_workflows_by_provider: { openai: 20, anthropic: 20, kimi: 20, deepseek: 20 },
      max_live_judge_rows: 80
    },
    pairs
  };
}

function smokeTargets() {
  return [
    {
      id: "very-liquid-vaults-foundry",
      repository: "https://github.com/benchmark-targets/very-liquid-vaults",
      revision: "1".repeat(40),
      framework: "foundry"
    },
    {
      id: "venus-isolated-pools-hardhat",
      repository: "https://github.com/benchmark-targets/venus-isolated-pools",
      revision: "2".repeat(40),
      framework: "hardhat"
    },
    {
      id: "stableswap-ng-vyper",
      repository: "https://github.com/benchmark-targets/stableswap-ng",
      revision: "3".repeat(40),
      framework: "vyper"
    }
  ];
}

function fullTargets() {
  return Array.from({ length: 40 }, (_value, index) => ({
    id: `evmbench-target-${String(index + 1).padStart(2, "0")}`,
    repository: "https://github.com/benchmark-targets/evmbench-target",
    revision: `${String(index % 10).repeat(40)}`,
    framework: "foundry"
  }));
}

function bundleWithMatrix(matrix: Array<Record<string, string>>) {
  return {
    files: [
      {
        path: "eval/matrix.json",
        contents_base64: Buffer.from(`${JSON.stringify(matrix)}\n`, "utf8").toString("base64")
      }
    ]
  };
}

function completeHistoryBundle(
  matrix: Array<Record<string, string>>,
  evalRunId: string,
  diagnosticsSummaryOverrides: Record<string, unknown> = {},
  scoreSummaryOverrides: Record<string, unknown> = {}
) {
  const diagnosticsRows = matrix.map((row, index) => ({
    row_id: row.id,
    target_id: row.target_id,
    variant_id: row.variant_id,
    trial_id: row.trial_id,
    run_status: "launched",
    final_status: "succeeded",
    workflow_status: "succeeded",
    workflow_terminal: true,
    terminal_disposition: "clean",
    terminal_report_present: true,
    workflow_ids: [`workflow-${index + 1}`],
    diagnostic_codes: [],
    failed_nodes: [],
    scoring_ready: true,
    reason_codes: []
  }));
  const diagnostics = {
    eval_run_id: evalRunId,
    summary: {
      planned: matrix.length,
      launched: matrix.length,
      launch_failed: 0,
      run_records_missing: 0,
      workflow_succeeded: matrix.length,
      workflow_failed: 0,
      workflow_nonterminal: 0,
      genuine_task_failure_rows: 0,
      terminal_reports_present: matrix.length,
      scoring_ready: true,
      ...diagnosticsSummaryOverrides
    },
    rows: diagnosticsRows
  };
  const scoreSummary = {
    eval_run_id: evalRunId,
    rows: matrix.map((row) => ({ row_id: row.id })),
    ...scoreSummaryOverrides
  };
  return {
    status: "succeeded",
    executed_case_count: matrix.length,
    graded_case_count: matrix.length,
    targets: matrix.map((row, index) => ({
      id: row.target_id,
      repository: `https://github.com/benchmark-targets/${row.target_id}`,
      revision: String(index + 1).repeat(40),
      framework: index % 3 === 0 ? "foundry" : index % 3 === 1 ? "hardhat" : "vyper",
      status: "succeeded",
      executed_case_count: 1,
      graded_case_count: 1,
      publication_location: {
        bundle_path: "public-results.json",
        report_paths: [
          `reports/${row.id}/report.md`,
          `reports/${row.id}/report.json`,
          `reports/${row.id}/findings.normalized.json`
        ]
      }
    })),
    files: [
      {
        path: "eval/matrix.json",
        contents_base64: Buffer.from(`${JSON.stringify(matrix)}\n`, "utf8").toString("base64")
      },
      {
        path: "eval/public-eval-diagnostics.json",
        contents_base64: Buffer.from(`${JSON.stringify(diagnostics)}\n`, "utf8").toString("base64")
      },
      {
        path: "eval/summary.json",
        contents_base64: Buffer.from(`${JSON.stringify(scoreSummary)}\n`, "utf8").toString("base64")
      }
    ]
  };
}

function matrixRows(targetIds: string[], modelSlug: string): Array<Record<string, string>> {
  return targetIds.map((targetId, index) => ({
    id: `${targetId}-row-${index + 1}`,
    target_id: targetId,
    variant_id: modelSlug,
    trial_id: "trial-1"
  }));
}

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
