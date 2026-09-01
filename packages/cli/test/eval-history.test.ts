import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EVAL_HISTORY_OBSERVATION_SCHEMA_VERSION,
  emptyEvalHistory,
  mergeEvalHistory,
  type EvalHistoryObservation
} from "@ultrafuzz/evals";

import { runCli } from "../src/index.js";

const FROZEN_RUN_TIMESTAMP = "2026-07-19T00:00:00.000Z";
const TARGET_REVISION = "2222222222222222222222222222222222222222";

function frozenObservation(): EvalHistoryObservation {
  return {
    schema_version: EVAL_HISTORY_OBSERVATION_SCHEMA_VERSION,
    id: "run-1:target-a:baseline:benchmark-smoke",
    benchmark: "ultrafuzz-bench",
    lane: "smoke",
    status: "succeeded",
    target: "target-a",
    variant: "baseline",
    trial_count: 1,
    run_timestamp: FROZEN_RUN_TIMESTAMP,
    candidate_commit: "1111111111111111111111111111111111111111",
    candidate_repository_url: "https://github.com/monad-developers/ultrafuzz",
    cohort_fingerprint: `sha256:${"a".repeat(64)}`,
    target_revisions: [{ target: "target-a", revision: TARGET_REVISION }],
    model_profile: "benchmark-smoke",
    model: "gpt-5.6-luna",
    reasoning_effort: "high",
    execution_policy_fingerprint: `sha256:${"d".repeat(64)}`,
    scoring_fingerprint: `sha256:${"b".repeat(64)}`,
    precision: 0.75,
    recall: 0.5,
    f1: 0.6,
    cumulative_unique_true_positives: 2,
    ground_truth_bug_count: 2,
    wall_clock_seconds: 120,
    wall_clock_completeness: { status: "complete", reasons: [] },
    cost_usd: 1.25,
    cost_completeness: { status: "complete", reasons: [] },
    executed_case_count: 1,
    graded_case_count: 1,
    publication_url: "https://github.com/monad-developers/ultrafuzz/actions/runs/123/artifacts",
    target_publication: {
      target: "target-a",
      repository: "https://example.com/target-a",
      revision: TARGET_REVISION,
      status: "succeeded",
      executed_case_count: 1,
      graded_case_count: 1,
      publication_location: {
        bundle_path: "public-results.json",
        report_paths: ["reports/target-a-baseline-trial-1/report.md", "reports/target-a-baseline-trial-1/report.json"]
      }
    },
    source_eval_run_id: "run-1",
    source_artifact: "https://github.com/monad-developers/ultrafuzz/actions/runs/1"
  };
}

test("eval history renders and checks deterministic public charts", async () => {
  const project = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ufz-cli-history-"));
  fs.mkdirSync(path.join(project, "benchmarks", "ultrafuzzbench"), { recursive: true });
  fs.writeFileSync(
    path.join(project, "benchmarks", "ultrafuzzbench", "history.json"),
    `${JSON.stringify(emptyEvalHistory())}\n`,
    "utf8"
  );

  const rendered = await invoke(project, ["eval", "history", "--project", project, "--json"]);
  assert.equal(rendered.code, 0, rendered.stderr || rendered.stdout);
  const result = JSON.parse(rendered.stdout) as { command: string; ok: boolean; data: { observations: number } };
  assert.equal(result.command, "eval history");
  assert.equal(result.ok, true);
  assert.equal(result.data.observations, 0);
  assert.deepEqual(fs.readdirSync(path.join(project, "docs", "assets", "eval-history")).sort(), [
    "cost.svg",
    "cumulative-unique-true-positives.svg",
    "f1.svg",
    "latest-summary.svg",
    "performance-cost.svg",
    "precision.svg",
    "quality.svg",
    "recall.svg",
    "wall-clock-time.svg"
  ]);

  const checked = await invoke(project, ["eval", "history", "--project", project, "--check", "--json"]);
  assert.equal(checked.code, 0, checked.stderr || checked.stdout);

  const aged = await invoke(project, [
    "eval",
    "history",
    "--project",
    project,
    "--check",
    "--max-age-days",
    "7",
    "--json"
  ]);
  assert.equal(aged.code, 1);
  assert.equal(
    (JSON.parse(aged.stdout) as { diagnostics: Array<{ message: string }> }).diagnostics[0]?.message,
    "eval history has no observation to age against the requested 7 day maximum"
  );

  fs.appendFileSync(path.join(project, "docs", "assets", "eval-history", "precision.svg"), "stale\n");
  const stale = await invoke(project, ["eval", "history", "--project", project, "--check", "--json"]);
  assert.equal(stale.code, 1);
  assert.equal((JSON.parse(stale.stdout) as { ok: boolean }).ok, false);
});

test("eval history asserts a requested maximum observation age without changing the default check", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-cli-history-age-"));
  fs.mkdirSync(path.join(project, "benchmarks", "ultrafuzzbench"), { recursive: true });
  fs.writeFileSync(
    path.join(project, "benchmarks", "ultrafuzzbench", "history.json"),
    `${JSON.stringify(mergeEvalHistory(emptyEvalHistory(), [frozenObservation()]))}\n`,
    "utf8"
  );

  const rendered = await invoke(project, ["eval", "history", "--project", project, "--json"]);
  assert.equal(rendered.code, 0, rendered.stderr || rendered.stdout);
  const checked = await invoke(project, ["eval", "history", "--project", project, "--check", "--json"]);
  assert.equal(checked.code, 0, checked.stderr || checked.stdout);
  const generous = await invoke(project, [
    "eval",
    "history",
    "--project",
    project,
    "--check",
    "--max-age-days",
    "100000",
    "--json"
  ]);
  assert.equal(generous.code, 0, generous.stderr || generous.stdout);
  assert.equal(generous.stdout, checked.stdout);

  const stale = await invoke(project, [
    "eval",
    "history",
    "--project",
    project,
    "--check",
    "--max-age-days",
    "1",
    "--json"
  ]);
  assert.equal(stale.code, 1);
  const failure = JSON.parse(stale.stdout) as {
    ok: boolean;
    diagnostics: Array<{ code: string; message: string }>;
  };
  assert.equal(failure.ok, false);
  assert.match(
    failure.diagnostics[0]?.message ?? "",
    new RegExp(
      `^newest eval history observation ran at ${FROZEN_RUN_TIMESTAMP.replace(/\./u, "\\.")}, [0-9.]+ days ago, exceeding the requested 1 day maximum$`,
      "u"
    )
  );

  const appended = await invoke(project, ["eval", "history", "run-1", "--project", project, "--max-age-days", "1"]);
  assert.equal(appended.code, 1);
  assert.match(appended.stderr, /--max-age-days cannot append an eval run/u);
});

test("eval history fails a requested maximum age when the newest observation is dated in the future", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-cli-history-future-"));
  fs.mkdirSync(path.join(project, "benchmarks", "ultrafuzzbench"), { recursive: true });
  const future = "2099-01-01T00:00:00.000Z";
  fs.writeFileSync(
    path.join(project, "benchmarks", "ultrafuzzbench", "history.json"),
    `${JSON.stringify(mergeEvalHistory(emptyEvalHistory(), [{ ...frozenObservation(), run_timestamp: future }]))}\n`,
    "utf8"
  );

  const rendered = await invoke(project, ["eval", "history", "--project", project, "--json"]);
  assert.equal(rendered.code, 0, rendered.stderr || rendered.stdout);
  const dated = await invoke(project, [
    "eval",
    "history",
    "--project",
    project,
    "--check",
    "--max-age-days",
    "2",
    "--json"
  ]);
  assert.equal(dated.code, 1);
  const failure = JSON.parse(dated.stdout) as { ok: boolean; diagnostics: Array<{ message: string }> };
  assert.equal(failure.ok, false);
  assert.match(
    failure.diagnostics[0]?.message ?? "",
    new RegExp(
      `^newest eval history observation ran at ${future.replace(/\./u, "\\.")}, which is in the future at [0-9TZ:.-]+, so its age cannot be measured against the requested 2 day maximum$`,
      "u"
    )
  );
});

async function invoke(project: string, argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    cwd: project,
    env: {},
    stdout: {
      write: (chunk: string | Uint8Array) => {
        stdout += String(chunk);
        return true;
      }
    },
    stderr: {
      write: (chunk: string | Uint8Array) => {
        stderr += String(chunk);
        return true;
      }
    }
  });
  return { code, stdout, stderr };
}
