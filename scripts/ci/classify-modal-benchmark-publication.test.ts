import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
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
      reason: expect.stringContaining(fixture.pair)
    });

    const outputPath = path.join(fixture.root, "github-output");
    execFileSync(process.execPath, [
      path.resolve("scripts/ci/classify-modal-benchmark-publication.mjs"),
      fixture.control,
      fixture.results,
      "smoke",
      "push",
      outputPath
    ]);
    expect(fs.readFileSync(outputPath, "utf8")).toBe("ready=false\n");
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
