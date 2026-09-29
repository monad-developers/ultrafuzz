import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  readBenchmarkControlManifest,
  validateAutomaticPublicationManifest,
  validateAutomaticPairConfig,
  validateBenchmarkPolicyFiles
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
    const manifest = smokeManifest();
    expect(validateAutomaticPublicationManifest(manifest, smokeContext())).toBe(manifest);
  });

  it("accepts a safe overridden smoke runner", () => {
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
      schema_version: "ultrafuzz.modal.benchmark.v3",
      run_id: "ci-12345-2-smoke-ultrafuzz-bench-openai",
      app_name: "ultrafuzz-evals",
      image_name: `ufz-runner-${"a".repeat(40)}`,
      node_timeout_seconds: 1800,
      loops: 1,
      judge: {
        api_key_env: "OPENAI_API_KEY",
        url: "https://api.openai.com/v1/chat/completions"
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

  it("accepts an opaque OpenRouter catalogue model without rewriting it", () => {
    const modelId = "~vendor/model.latest:free+preview@2026";
    const modelSlug = "benchmark-smoke-vendor-model-latest-free-preview-2026-high";
    const pair = {
      pair: `ultrafuzz-bench-${modelSlug}`,
      benchmark: "ultrafuzz-bench",
      mode: "smoke",
      lane: "smoke",
      model_slug: modelSlug,
      provider: "openrouter",
      config_path: `ultrafuzz-bench-${modelSlug}.json`,
      state_path: `ultrafuzz-bench-${modelSlug}.state.json`
    };
    const model = {
      slug: modelSlug,
      model: modelId,
      provider: "openrouter",
      agent: "OpenRouterAgent",
      reasoning: "high",
      auth_mode: "api-key"
    };
    const config = {
      schema_version: "ultrafuzz.modal.benchmark.v3",
      run_id: "ci-12345-2-smoke-ultrafuzz-bench-openrouter",
      app_name: "ultrafuzz-evals",
      image_name: `ufz-runner-${"a".repeat(40)}`,
      node_timeout_seconds: 1800,
      loops: 1,
      judge: {
        api_key_env: "OPENAI_API_KEY",
        url: "https://api.openai.com/v1/chat/completions"
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

    expect(model.model).toBe(modelId);
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
    for (const provider of ["deepseek", "anthropic", "kimi", "openrouter"]) {
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
    changedCohort.control_timeout_seconds = 55_200;
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

  it("rejects duplicate-key, symlinked, and oversized producer manifests before context checks", () => {
    const root = temporaryRoot("ultrafuzz-publication-manifest-");
    const target = path.join(root, "manifest.json");
    fs.writeFileSync(target, `${JSON.stringify(smokeManifest())}\n`);

    const duplicate = path.join(root, "duplicate.json");
    const serialized = JSON.stringify(smokeManifest());
    const field = '"schema_version":"ultrafuzz.modal.benchmark-control-manifest.v1"';
    fs.writeFileSync(duplicate, `${serialized.replace(field, `${field},"schema_version":"shadow"`)}\n`);
    expect(() => readBenchmarkControlManifest(duplicate, smokeContext())).toThrow(/duplicate property/u);

    const symlink = path.join(root, "manifest-link.json");
    fs.symlinkSync(target, symlink);
    expect(() => readBenchmarkControlManifest(symlink, smokeContext())).toThrow();

    const oversized = path.join(root, "oversized.json");
    fs.writeFileSync(oversized, " ".repeat(1024 * 1024 + 1));
    expect(() => readBenchmarkControlManifest(oversized, smokeContext())).toThrow();
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
    control_timeout_seconds: 37_500,
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

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  roots.push(root);
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
