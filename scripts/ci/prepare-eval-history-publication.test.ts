import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  readAutomaticPublicationManifest,
  validateAutomaticPublicationManifest,
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
    expect(validateAutomaticPublicationManifest(smokeManifest(), context)).toEqual(smokeManifest());
  });

  it("rejects untrusted identity, topology, provider, and path mutations", () => {
    const cases: Array<[string, (manifest: ReturnType<typeof smokeManifest>) => void]> = [
      ["unexpected root field", (manifest) => Object.assign(manifest, { command: "echo unsafe" })],
      ["candidate", (manifest) => (manifest.candidate_commit = "b".repeat(40))],
      ["repository", (manifest) => (manifest.repository = "https://github.com/example/other")],
      ["generation", (manifest) => (manifest.generation = "12345-1")],
      ["mode", (manifest) => (manifest.mode = "full")],
      ["benchmark", (manifest) => (manifest.benchmark = "evmbench")],
      ["image", (manifest) => (manifest.image_name = "ufz-runner-other")],
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
      expect(() => validateAutomaticPublicationManifest(manifest, context), label).toThrow();
    }
  });

  it("requires the exact full provider set, ordering, and unique control paths", () => {
    const fullContext = { ...context, mode: "full" as const };
    expect(
      validateAutomaticPublicationManifest(fullManifest(), fullContext).pairs.map((pair) => pair.provider)
    ).toEqual(["openai", "anthropic"]);

    for (const mutate of [
      (manifest: ReturnType<typeof fullManifest>) => manifest.pairs.pop(),
      (manifest: ReturnType<typeof fullManifest>) => (manifest.pairs[1]!.provider = "openai"),
      (manifest: ReturnType<typeof fullManifest>) => (manifest.pairs[1]!.pair = manifest.pairs[0]!.pair),
      (manifest: ReturnType<typeof fullManifest>) => (manifest.pairs[1]!.model_slug = manifest.pairs[0]!.model_slug),
      (manifest: ReturnType<typeof fullManifest>) => (manifest.pairs[1]!.config_path = manifest.pairs[0]!.config_path),
      (manifest: ReturnType<typeof fullManifest>) => (manifest.pairs[1]!.state_path = manifest.pairs[0]!.state_path)
    ]) {
      const manifest = fullManifest();
      mutate(manifest);
      expect(() => validateAutomaticPublicationManifest(manifest, fullContext)).toThrow();
    }
  });

  it("accepts policy-derived trial and cohort matrix dimensions", () => {
    const manifest = smokeManifest();
    manifest.matrix_rows_per_pair = 6;
    manifest.control_timeout_seconds = 21_000;
    expect(
      validateAutomaticPublicationManifest(manifest, {
        ...context,
        targetCount: 3,
        trialsPerVariant: 2
      })
    ).toEqual(manifest);

    const changedCohort = fullManifest();
    changedCohort.matrix_rows_per_pair = 41;
    changedCohort.control_timeout_seconds = 21_000;
    expect(
      validateAutomaticPublicationManifest(changedCohort, {
        ...context,
        mode: "full",
        targetCount: 41,
        trialsPerVariant: 1
      })
    ).toEqual(changedCohort);
  });

  it("rejects symlinked and oversized producer manifests before parsing", () => {
    const root = temporaryRoot("ultrafuzz-publication-manifest-");
    const target = path.join(root, "manifest.json");
    fs.writeFileSync(target, `${JSON.stringify(smokeManifest())}\n`);
    const symlink = path.join(root, "manifest-link.json");
    fs.symlinkSync(target, symlink);
    expect(() => readAutomaticPublicationManifest(symlink, context)).toThrow();

    const oversized = path.join(root, "oversized.json");
    fs.writeFileSync(oversized, " ".repeat(1024 * 1024 + 1));
    expect(() => readAutomaticPublicationManifest(oversized, context)).toThrow();
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

function smokeManifest() {
  const modelSlug = "benchmark-smoke-gpt-5-6-luna-high";
  const pair = `ultrafuzz-bench-${modelSlug}`;
  return {
    candidate_commit: "a".repeat(40),
    repository: "https://github.com/monad-developers/ultrafuzz",
    generation: "12345-2",
    mode: "smoke",
    benchmark: "ultrafuzz-bench",
    image_name: `ufz-runner-${"a".repeat(40)}`,
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
    ["anthropic", "benchmark-full-claude-sonnet-5-high"]
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
    image_name: `ufz-runner-${"a".repeat(40)}`,
    matrix_rows_per_pair: 40,
    control_timeout_seconds: 14_700,
    concurrency: {
      max_parallel_eval_rows_per_sandbox: 20,
      max_parallel_workflow_nodes_per_row: 8,
      max_live_runner_workflows_by_provider: { openai: 20, anthropic: 20 },
      max_live_judge_rows: 40
    },
    pairs
  };
}

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
