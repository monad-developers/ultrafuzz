import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { currentRowScore, currentScoreSummary, testRow, testSuite } from "../../packages/evals/test/helpers.ts";

import {
  AUTOMATIC_PUBLICATION_PLAN_SCHEMA_VERSION,
  automaticProducerPolicyDimensions,
  automaticPublicationPlanRows,
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
  it("strictly reads the exact automatic publication plan before emitting workflow rows", () => {
    const root = temporaryRoot("ultrafuzz-publication-plan-");
    const planPath = path.join(root, "plan.json");
    const pair = smokeManifest().pairs[0]!;
    const sourceArtifact = `${context.repository}/actions/runs/${context.producerRunId}`;
    const plan = {
      schema_version: AUTOMATIC_PUBLICATION_PLAN_SCHEMA_VERSION,
      candidate_commit: context.candidateCommit,
      candidate_repository_url: context.repository,
      source_artifact: sourceArtifact,
      producer_run_id: context.producerRunId,
      producer_run_attempt: context.producerRunAttempt,
      mode: context.mode,
      benchmark: "ultrafuzz-bench",
      pairs: [
        {
          pair: pair.pair,
          provider: pair.provider,
          model_slug: pair.model_slug,
          bundle_path: `${pair.pair}/${pair.model_slug}/public-results.json`,
          unpack_path: pair.pair,
          eval_run_id: "eval-run-1",
          benchmark: "ultrafuzz-bench",
          lane: "smoke",
          status: "succeeded",
          target_ids: smokeTargets().map((target) => target.id),
          executed_case_count: 3,
          graded_case_count: 3,
          publication_url: `${sourceArtifact}/artifacts`
        }
      ]
    };
    fs.writeFileSync(planPath, `${JSON.stringify(plan)}\n`, "utf8");
    expect(automaticPublicationPlanRows(planPath)).toBe(
      `${pair.pair}/${pair.model_slug}/public-results.json\t${pair.pair}\teval-run-1\tultrafuzz-bench\tsmoke\t${pair.model_slug}\n`
    );

    const duplicatePath = path.join(root, "duplicate-plan.json");
    const serialized = JSON.stringify(plan);
    const field = `"schema_version":"${AUTOMATIC_PUBLICATION_PLAN_SCHEMA_VERSION}"`;
    fs.writeFileSync(duplicatePath, `${serialized.replace(field, `${field},"schema_version":"shadow"`)}\n`);
    expect(() => automaticPublicationPlanRows(duplicatePath)).toThrow(/duplicate property/u);
  });

  it("accepts only the exact event-bound smoke manifest", () => {
    const manifest = smokeManifest();
    expect(validateAutomaticPublicationManifest(manifest, smokeContext())).toBe(manifest);
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
      schema_version: "ultrafuzz.modal.benchmark.v2",
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
      ["schema version", (manifest) => (manifest.schema_version = "ultrafuzz.modal.benchmark-control-manifest.v0")],
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

  it("reads producer policy only from a current strict benchmark config", () => {
    const root = temporaryRoot("ultrafuzz-publication-producer-policy-");
    const manifest = smokeManifest();
    manifest.control_timeout_seconds = 12_000;
    const pair = manifest.pairs[0]!;
    const configPath = path.join(root, pair.config_path);
    fs.writeFileSync(configPath, `${JSON.stringify(smokeBenchmarkConfig(manifest, 7_200))}\n`);

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

    const serialized = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(configPath, serialized.replace('"run_id":', '"run_id":"shadowed","run_id":'));
    expect(() => automaticProducerPolicyDimensions(manifest, root)).toThrow(/duplicate/iu);
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
    const executedCountMismatch = completeHistoryBundle(matrixRows(targetIds, modelSlug), expected.evalRunId);
    executedCountMismatch.executed_case_count = 2;
    expect(() =>
      summarizePublicBenchmarkBundlePublication(executedCountMismatch, expected, pair, publicationUrl)
    ).toThrow(/case counts/u);
    const gradedCountMismatch = completeHistoryBundle(matrixRows(targetIds, modelSlug), expected.evalRunId);
    gradedCountMismatch.graded_case_count = 2;
    expect(() =>
      summarizePublicBenchmarkBundlePublication(gradedCountMismatch, expected, pair, publicationUrl)
    ).toThrow(/case counts/u);
  });

  it("rejects malformed-present embedded eval documents instead of reparsing them loosely", () => {
    const targetIds = ["very-liquid-vaults-foundry", "venus-isolated-pools-hardhat", "stableswap-ng-vyper"];
    const modelSlug = smokeManifest().pairs[0]!.model_slug;
    const pair = smokeManifest().pairs[0]!.pair;
    const evalRunId = "ci-12345-2-smoke-ultrafuzz-bench-openai-benchmark-smoke-gpt-5-6-luna-high";
    const expected = {
      matrixRowsPerPair: 3,
      targetIds,
      trialsPerVariant: 1,
      modelSlug,
      evalRunId
    };
    const publicationUrl = "https://github.com/monad-developers/ultrafuzz/actions/runs/12345/artifacts";

    const matrixBundle = bundleWithMatrix(matrixRows(targetIds, modelSlug));
    addDuplicateBundleKey(matrixBundle, "eval/matrix.json", "id", "shadowed");
    expect(() => assertPublicBenchmarkBundleMatrixScope(matrixBundle, expected, pair)).toThrow(/strict JSON/u);

    for (const [relativePath, key] of [
      ["eval/public-eval-diagnostics.json", "schema_version"],
      ["eval/summary.json", "schema_version"]
    ] as const) {
      const bundle = completeHistoryBundle(matrixRows(targetIds, modelSlug), evalRunId);
      addDuplicateBundleKey(bundle, relativePath, key, "shadowed");
      expect(() => summarizePublicBenchmarkBundlePublication(bundle, expected, pair, publicationUrl)).toThrow(
        /strict JSON/u
      );
    }
  });

  it("rejects duplicate-key, symlinked, and oversized producer manifests before context checks", () => {
    const root = temporaryRoot("ultrafuzz-publication-manifest-");
    const target = path.join(root, "manifest.json");
    fs.writeFileSync(target, `${JSON.stringify(smokeManifest())}\n`);

    const duplicate = path.join(root, "duplicate.json");
    const serialized = JSON.stringify(smokeManifest());
    const field = '"schema_version":"ultrafuzz.modal.benchmark-control-manifest.v1"';
    fs.writeFileSync(duplicate, `${serialized.replace(field, `${field},"schema_version":"shadow"`)}\n`);
    expect(() => readAutomaticPublicationManifest(duplicate, smokeContext())).toThrow(/duplicate property/u);

    const symlink = path.join(root, "manifest-link.json");
    fs.symlinkSync(target, symlink);
    expect(() => readAutomaticPublicationManifest(symlink, smokeContext())).toThrow();

    const oversized = path.join(root, "oversized.json");
    fs.writeFileSync(oversized, " ".repeat(1024 * 1024 + 1));
    expect(() => readAutomaticPublicationManifest(oversized, smokeContext())).toThrow();
  });

  it("rejects a clean candidate policy commit whose selected manifest is a symlink", () => {
    const root = temporaryRoot("ultrafuzz-publication-policy-");
    fs.mkdirSync(path.join(root, "benchmarks", "ultrafuzzbench"), { recursive: true });
    fs.writeFileSync(path.join(root, "benchmarks/ultrafuzzbench/lanes.json"), "{}\n");
    fs.writeFileSync(path.join(root, "benchmarks/ultrafuzzbench/cohort.json"), "{}\n");
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

    fs.unlinkSync(path.join(root, "benchmarks/ultrafuzzbench/lanes.json"));
    fs.writeFileSync(path.join(root, "outside.json"), "{}\n");
    fs.symlinkSync("../../outside.json", path.join(root, "benchmarks/ultrafuzzbench/lanes.json"));
    git(root, ["add", "benchmarks/ultrafuzzbench/lanes.json"]);
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

  it("accepts a pre-family candidate policy checkout and rejects mixed policy layouts", () => {
    const root = temporaryRoot("ultrafuzz-legacy-publication-policy-");
    fs.mkdirSync(path.join(root, "benchmarks"));
    fs.writeFileSync(path.join(root, "benchmarks/lanes.json"), "{}\n");
    fs.writeFileSync(path.join(root, "benchmarks/ultrafuzz-bench.json"), "{}\n");
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.name", "Test"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["add", "benchmarks"]);
    git(root, ["commit", "-m", "legacy policy"]);
    const legacyCommit = git(root, ["rev-parse", "HEAD"]).trim();
    expect(
      validateBenchmarkPolicyFiles({
        policyRoot: root,
        candidateCommit: legacyCommit,
        benchmark: "ultrafuzz-bench"
      })
    ).toBe(fs.realpathSync(root));

    fs.mkdirSync(path.join(root, "benchmarks", "ultrafuzzbench"));
    fs.writeFileSync(path.join(root, "benchmarks/ultrafuzzbench/lanes.json"), "{}\n");
    git(root, ["add", "benchmarks/ultrafuzzbench/lanes.json"]);
    git(root, ["commit", "-m", "mixed policy"]);
    const mixedCommit = git(root, ["rev-parse", "HEAD"]).trim();
    expect(() =>
      validateBenchmarkPolicyFiles({
        policyRoot: root,
        candidateCommit: mixedCommit,
        benchmark: "ultrafuzz-bench"
      })
    ).toThrow(/exactly one complete canonical benchmark policy layout/u);
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
    schema_version: "ultrafuzz.modal.benchmark-control-manifest.v1",
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
    schema_version: "ultrafuzz.modal.benchmark-control-manifest.v1",
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

function smokeBenchmarkConfig(manifest: ReturnType<typeof smokeManifest>, maxRuntimeSeconds: number) {
  const pair = manifest.pairs[0]!;
  return {
    schema_version: "ultrafuzz.modal.benchmark.v2",
    run_id: "ci-12345-2-smoke-ultrafuzz-bench-openai",
    app_name: "ultrafuzz-evals",
    image_name: manifest.image_name,
    braintrust: {
      project: "ultrafuzz-public-benchmarks",
      api_key_env: "BRAINTRUST_API_KEY",
      judge_api_key_env: "OPENAI_API_KEY",
      judge_url: "https://api.openai.com/v1/chat/completions",
      judge_credential_ttl_seconds: 57_600
    },
    node_timeout_seconds: 1800,
    loops: 1,
    models: [
      {
        slug: pair.model_slug,
        model: "gpt-5.6-luna",
        provider: "openai",
        agent: "CodexAgent",
        reasoning: "high",
        auth_mode: "api-key"
      }
    ],
    public_benchmark: {
      benchmark: manifest.benchmark,
      lane: manifest.mode,
      runner_model_profile: pair.model_slug,
      candidate_repository: manifest.repository,
      candidate_commit: manifest.candidate_commit,
      targets: manifest.targets,
      max_runtime_seconds: maxRuntimeSeconds
    }
  };
}

type PublicationMatrixRow = ReturnType<typeof testRow>;

function bundleWithMatrix(matrix: PublicationMatrixRow[]) {
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
  matrix: PublicationMatrixRow[],
  evalRunId: string,
  diagnosticsSummaryOverrides: Record<string, unknown> = {},
  scoreSummaryOverrides: Record<string, unknown> = {}
) {
  const modelSlug = matrix[0]!.variant_id;
  const evalRunSuffix = `-${modelSlug}`;
  if (!evalRunId.endsWith(evalRunSuffix)) throw new Error("test eval run ID must end with its model slug");
  const logicalRunId = evalRunId.slice(0, -evalRunSuffix.length);
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
    schema_version: "ultrafuzz.modal.public-eval-diagnostics.v2",
    stage: "post-eval-pre-score",
    benchmark: "ultrafuzz-bench",
    lane: "smoke",
    model_slug: modelSlug,
    model: "gpt-5.6-luna",
    reasoning: "high",
    candidate_commit: "a".repeat(40),
    eval_run_id: evalRunId,
    created_at: "2026-08-09T00:00:00.000Z",
    lineage: {
      logical_run_id: logicalRunId,
      generation: 1,
      attempt: 1,
      attempt_id: "attempt-1",
      config_fingerprint: "a".repeat(64),
      source_fingerprint: "b".repeat(64),
      image_fingerprint: "c".repeat(64),
      model_fingerprint: "d".repeat(64)
    },
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
  const scoredRows = matrix.map((row) => currentRowScore(row));
  const baseSummary = currentScoreSummary({
    row: matrix[0]!,
    evalRunRoot: "/tmp/publication-eval",
    evalRunId
  });
  const scoreSummary = {
    ...baseSummary,
    rows: scoredRows,
    variants: [
      {
        variant_id: modelSlug,
        row_count: scoredRows.length,
        precision: 1,
        recall: 1,
        f1_score: 1,
        full_match_rate: 1,
        human_review_queue_count: 0,
        duplicate_rate: 0,
        report_schema_valid_rate: 1
      }
    ],
    recovery_equivalence: {
      aggregate_non_comparable: "include",
      included_row_count: scoredRows.length,
      excluded_row_count: 0,
      classification_counts: {
        clean: scoredRows.length,
        "infrastructure-recovered": 0,
        "model-reexecuted-within-policy": 0,
        "non-comparable": 0
      },
      non_comparable_variants: []
    },
    ...scoreSummaryOverrides
  };
  return {
    status: "succeeded",
    executed_case_count: matrix.length,
    graded_case_count: matrix.length,
    targets: matrix.map((row, index) => ({
      id: row.target_id,
      repository: row.target.repo,
      revision: row.target.ref,
      framework: index % 3 === 0 ? "foundry" : index % 3 === 1 ? "hardhat" : "vyper",
      status: "succeeded",
      executed_case_count: 1,
      graded_case_count: 1,
      publication_location: {
        bundle_path: "public-results.json",
        report_paths: [`reports/${row.id}/report.md`, `reports/${row.id}/report.json`]
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

function matrixRows(targetIds: string[], modelSlug: string): PublicationMatrixRow[] {
  const suite = testSuite("/tmp/publication-ground-truth");
  return targetIds.map((targetId, index) => {
    const revision = String((index + 1) % 10).repeat(40);
    return testRow(suite, {
      id: `${targetId}-row-${index + 1}`,
      target_id: targetId,
      variant_id: modelSlug,
      trial_id: "trial-1",
      run_id: `publication-${targetId}-row-${index + 1}-trial-1`,
      target: {
        id: targetId,
        repo: `https://github.com/benchmark-targets/${targetId}`,
        ref: revision,
        ground_truth: `${targetId}.yml`,
        ground_truth_path: `/tmp/publication-ground-truth/${targetId}.yml`
      },
      variant: { id: modelSlug },
      runner_model_profile: modelSlug,
      judge_model_profile: "benchmark-judge-gpt-5-6-sol-xhigh",
      runner_model: "gpt-5.6-luna",
      judge_model: "gpt-5.6-sol",
      runner_reasoning: "high",
      judge_reasoning: "xhigh"
    });
  });
}

function addDuplicateBundleKey(
  bundle: { files: Array<{ path: string; contents_base64: string }> },
  relativePath: string,
  key: string,
  shadow: string
): void {
  const file = bundle.files.find((entry) => entry.path === relativePath);
  if (file === undefined) throw new Error(`test bundle is missing ${relativePath}`);
  const contents = Buffer.from(file.contents_base64, "base64").toString("utf8");
  const token = `"${key}":`;
  const duplicated = contents.replace(token, `${token}${JSON.stringify(shadow)},${token}`);
  if (duplicated === contents) throw new Error(`test bundle ${relativePath} does not contain ${key}`);
  file.contents_base64 = Buffer.from(duplicated, "utf8").toString("base64");
}

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
