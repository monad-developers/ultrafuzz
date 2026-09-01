import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { classifyModalBenchmarkPublication } from "./classify-modal-benchmark-publication.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Modal benchmark publication readiness", () => {
  it("publishes only a successful collected generation with its exact bundle", () => {
    const fixture = setup();
    writeOutcome(fixture, {
      pair: fixture.pair,
      terminal_status: "succeeded",
      category: "succeeded",
      collection_status: "succeeded"
    });
    writeBundle(fixture);

    expect(classifyModalBenchmarkPublication(fixture.control, fixture.results, "smoke", "push")).toEqual({
      ready: true,
      reason: expect.any(String)
    });
  });

  it("turns an explicitly finalized automatic smoke soft-fail into a publication no-op", () => {
    const fixture = setup();
    writeOutcome(fixture, {
      pair: fixture.pair,
      terminal_status: "failed",
      category: "resume-required",
      diagnostic_collection_status: "succeeded"
    });

    expect(classifyModalBenchmarkPublication(fixture.control, fixture.results, "smoke", "push")).toEqual({
      ready: false,
      reason: expect.stringContaining(fixture.pair),
      incompletePairs: [
        {
          pair: fixture.pair,
          terminal_status: "failed",
          category: "resume-required",
          diagnostic_collection_status: "succeeded"
        }
      ]
    });

    const run = classify(fixture);
    expect(run.status).toBe(0);
    expect(run.output).toBe(
      `ready=false\nskip_reason=automatic smoke publication skipped after operational soft-fail: ${fixture.pair}\n`
    );
  });

  // A pre-model `unreachable` exit records two different categories over the
  // life of one incident. `workerResultCategory` in packages/modal/src/launch-state.ts
  // resolves `exit_category: "unreachable"` with `model_work_started: false` to
  // `transient-operational-failure`, and the runner rewrites that to
  // `permanent-operational-failure` once the pre-model retry budget is spent.
  // The control artifact this classifier reads can hold either one.
  it("annotates and summarizes both recorded categories of the unreachable-dependency incident it refused to publish", () => {
    for (const category of ["transient-operational-failure", "permanent-operational-failure"]) {
      const fixture = setup();
      writeOutcome(fixture, { ...incomplete(category), pair: fixture.pair });

      const run = classify(fixture, { summary: true });
      expect(run.status, category).toBe(0);
      expect(run.output, category).toContain("ready=false\n");
      expect(run.stdout, category).toContain(
        `::warning::automatic smoke publication skipped after operational soft-fail: ${fixture.pair}`
      );
      expect(run.stdout, category).toContain(
        `incomplete pairs: ${fixture.pair} (terminal_status=failed, category=${category}, diagnostic_collection_status=succeeded)`
      );
      expect(run.stdout, category).toContain(
        "Published eval history does not advance until one complete Modal benchmark generation exists."
      );
      expect(run.stdout.split("\n").filter((line) => line.startsWith("::")).length, category).toBe(1);
      expect(run.summary, category).toContain("## Eval history publication skipped (incomplete benchmark generation)");
      expect(run.summary, category).toContain(
        `- Refusal: automatic smoke publication skipped after operational soft-fail: ${fixture.pair}`
      );
      expect(run.summary, category).toContain(
        `- Incomplete pair: ${fixture.pair} (terminal_status=failed, category=${category},`
      );
      expect(run.summary, category).toContain(
        "Published eval history does not advance until one complete Modal benchmark generation exists."
      );
    }
  });

  it("leaves a published generation unannotated and writes no job summary", () => {
    const fixture = setup();
    writeOutcome(fixture, {
      pair: fixture.pair,
      terminal_status: "succeeded",
      category: "succeeded",
      collection_status: "succeeded"
    });
    writeBundle(fixture);

    const run = classify(fixture, { summary: true });
    expect(run.status).toBe(0);
    expect(run.output).toBe("ready=true\n");
    expect(run.stdout).not.toContain("::");
    expect(run.summary).toBeUndefined();
  });

  it("still annotates a refusal outside GitHub Actions", () => {
    const fixture = setup();
    writeOutcome(fixture, { ...incomplete("resume-required"), pair: fixture.pair });

    const run = classify(fixture);
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain("::warning::");
    expect(run.summary).toBeUndefined();
  });

  it("pins the refusal verdict for every automatic smoke soft-fail category", () => {
    for (const category of [
      "resume-required",
      "transient-operational-failure",
      "permanent-operational-failure",
      "collection-failed",
      "collection-timeout"
    ]) {
      const collectionFailed = category === "collection-failed" || category === "collection-timeout";
      const fixture = setup();
      writeOutcome(fixture, {
        ...incomplete(category),
        pair: fixture.pair,
        ...(collectionFailed ? { collection_status: "failed" } : {})
      });

      const verdict = classifyModalBenchmarkPublication(fixture.control, fixture.results, "smoke", "push");
      expect(verdict.ready, category).toBe(false);
      expect(verdict.incompletePairs, category).toEqual([
        { pair: fixture.pair, terminal_status: "failed", category, diagnostic_collection_status: "succeeded" }
      ]);
    }
  });

  it("keeps manual, full, genuine, and malformed failures strict", () => {
    for (const [mode, eventName, outcome] of [
      ["smoke", "workflow_dispatch", incomplete("resume-required")],
      ["full", "push", incomplete("resume-required")],
      ["smoke", "push", incomplete("genuine-task-outcome")],
      ["smoke", "push", { ...incomplete("resume-required"), diagnostic_collection_status: undefined }],
      ["smoke", "push", { ...incomplete("collection-timeout"), collection_status: "succeeded" }],
      ["smoke", "push", { ...incomplete("resume-required"), unsupported: true }]
    ] as const) {
      const fixture = setup();
      writeOutcome(fixture, { ...outcome, pair: fixture.pair });
      expect(() => classifyModalBenchmarkPublication(fixture.control, fixture.results, mode, eventName)).toThrow();
    }
  });

  it("rejects missing outcomes and every outcome/bundle contradiction", () => {
    const missing = setup();
    expect(() => classifyModalBenchmarkPublication(missing.control, missing.results, "smoke", "push")).toThrow(
      /outcome/iu
    );

    const missingBundle = setup();
    writeOutcome(missingBundle, {
      pair: missingBundle.pair,
      terminal_status: "succeeded",
      category: "succeeded",
      collection_status: "succeeded"
    });
    expect(() =>
      classifyModalBenchmarkPublication(missingBundle.control, missingBundle.results, "smoke", "push")
    ).toThrow(/missing.*bundle/iu);

    const failedWithBundle = setup();
    writeOutcome(failedWithBundle, { ...incomplete("resume-required"), pair: failedWithBundle.pair });
    writeBundle(failedWithBundle);
    expect(() =>
      classifyModalBenchmarkPublication(failedWithBundle.control, failedWithBundle.results, "smoke", "push")
    ).toThrow(/unexpectedly.*bundle/iu);

    const mismatchedPair = setup();
    writeOutcome(mismatchedPair, { ...incomplete("resume-required"), pair: "foreign-pair" });
    expect(() =>
      classifyModalBenchmarkPublication(mismatchedPair.control, mismatchedPair.results, "smoke", "push")
    ).toThrow(/malformed/iu);
  });
});

function classify(fixture: ReturnType<typeof setup>, options: { summary?: boolean } = {}) {
  const outputPath = path.join(fixture.root, "github-output");
  const summaryPath = path.join(fixture.root, "github-step-summary");
  const env = { ...process.env };
  delete env.GITHUB_STEP_SUMMARY;
  if (options.summary === true) env.GITHUB_STEP_SUMMARY = summaryPath;

  const result = spawnSync(
    process.execPath,
    [
      path.resolve("scripts/ci/classify-modal-benchmark-publication.mjs"),
      fixture.control,
      fixture.results,
      "smoke",
      "push",
      outputPath
    ],
    { cwd: path.resolve("."), encoding: "utf8", env }
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : undefined,
    summary: fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, "utf8") : undefined
  };
}

function incomplete(category: string) {
  return {
    terminal_status: "failed",
    category,
    diagnostic_collection_status: "succeeded"
  };
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "modal-publication-readiness-"));
  roots.push(root);
  const control = path.join(root, "control");
  const results = path.join(root, "results");
  const pair = "ultrafuzz-bench-benchmark-smoke-gpt-5-6-luna-high";
  const modelSlug = "benchmark-smoke-gpt-5-6-luna-high";
  fs.mkdirSync(path.join(control, "outcomes"), { recursive: true });
  fs.mkdirSync(results);
  fs.writeFileSync(
    path.join(control, "manifest.json"),
    `${JSON.stringify({
      schema_version: "ultrafuzz.modal.benchmark-control-manifest.v1",
      candidate_commit: "a".repeat(40),
      repository: "https://github.com/monad-developers/ultrafuzz",
      generation: "12345-1",
      mode: "smoke",
      benchmark: "ultrafuzz-bench",
      execution: { mode: "modal", dry_run: false },
      image_name: `ufz-runner-${"a".repeat(40)}`,
      targets: [
        {
          id: "target-one",
          repository: "https://github.com/benchmark-targets/target-one",
          revision: "b".repeat(40),
          framework: "foundry"
        }
      ],
      matrix_rows_per_pair: 1,
      control_timeout_seconds: 300,
      concurrency: {
        max_parallel_eval_rows_per_sandbox: 1,
        max_parallel_workflow_nodes_per_row: 1,
        max_live_runner_workflows_by_provider: { openai: 1 },
        max_live_judge_rows: 1
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
    })}\n`
  );
  return { root, control, results, pair, modelSlug };
}

function writeOutcome(fixture: ReturnType<typeof setup>, value: Record<string, unknown>) {
  fs.writeFileSync(path.join(fixture.control, "outcomes", `${fixture.pair}.json`), `${JSON.stringify(value)}\n`);
}

function writeBundle(fixture: ReturnType<typeof setup>) {
  const directory = path.join(fixture.results, fixture.pair, fixture.modelSlug);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "public-results.json"), "{}\n");
}
