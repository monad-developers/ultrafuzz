import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import {
  assertBenchmarkHistoryFreshness,
  assessExpectedBenchmarkPublication,
  benchmarkHistoryFreshnessExitCode,
  describeBenchmarkHistoryFreshness
} from "./assert-benchmark-history-freshness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptPath = path.join(repoRoot, "scripts", "ci", "assert-benchmark-history-freshness.mjs");
const workflowPath = path.join(repoRoot, ".github", "workflows", "benchmark-history-freshness.yml");
const publishedHistoryPath = path.join(repoRoot, "benchmarks", "ultrafuzzbench", "history.json");
const MILLISECONDS_PER_DAY = 86_400_000;
// A frozen instant: every verdict below is a function of its inputs, so the
// suite cannot start reporting a different answer as the calendar advances.
const NOW = new Date("2026-08-31T06:17:00.000Z");

interface FreshnessResult {
  history_path: string;
  status: string;
  newest: { run_timestamp: string; source_eval_run_id: string; candidate_commit: string };
  age_days: number;
  max_age_days: number;
  observation_count: number;
}

interface WorkflowStep {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
}

interface Workflow {
  on: { schedule: Array<{ cron: string }>; workflow_dispatch: unknown };
  permissions: Record<string, string>;
  jobs: Record<string, { permissions?: Record<string, string>; env?: Record<string, string>; steps: WorkflowStep[] }>;
}

function requireJob(workflow: Workflow, jobId: string): Workflow["jobs"][string] {
  const job = workflow.jobs[jobId];
  if (job === undefined) throw new Error(`${workflowPath} declares no ${jobId} job`);
  return job;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * The published document supplies the observation template, so a fixture is a
 * real schema-valid observation rather than a hand-written guess at the shape
 * `readEvalHistory` accepts.
 */
const template = (() => {
  const published = JSON.parse(fs.readFileSync(publishedHistoryPath, "utf8")) as {
    schema_version: string;
    observations: Array<Record<string, unknown>>;
  };
  const observation = published.observations[0];
  if (observation === undefined)
    throw new Error(`${publishedHistoryPath} has no observation to template fixtures from`);
  return { schemaVersion: published.schema_version, observation };
})();

function writeHistory(runTimestamps: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-history-freshness-"));
  roots.push(root);
  const target = path.join(root, "history.json");
  fs.writeFileSync(
    target,
    `${JSON.stringify(
      {
        schema_version: template.schemaVersion,
        supersessions: [],
        observations: runTimestamps.map((run_timestamp, index) => ({
          ...structuredClone(template.observation),
          id: `observation-${index}`,
          run_timestamp
        }))
      },
      null,
      2
    )}\n`
  );
  return target;
}

function temporaryPath(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-history-freshness-"));
  roots.push(root);
  return path.join(root, name);
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * MILLISECONDS_PER_DAY).toISOString();
}

function assertFreshness(historyPath: string, maxAgeDays: number, now = NOW): FreshnessResult {
  return assertBenchmarkHistoryFreshness({ historyPath, maxAgeDays, now }) as FreshnessResult;
}

function runScript(args: string[], outputPath?: string): { status: number | null; stdout: string; stderr: string } {
  const producerPath = temporaryPath("producer-runs.json");
  fs.writeFileSync(producerPath, JSON.stringify([producerRun(isoDaysAgo(10))]));
  const result = spawnSync(process.execPath, [scriptPath, ...args, "--producer-runs", producerPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...(outputPath === undefined ? {} : { GITHUB_OUTPUT: outputPath }) }
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function producerRun(createdAt: string, headSha = "f".repeat(40)) {
  return { databaseId: 100, createdAt, headSha, event: "push", headBranch: "main" };
}

describe("publication expectations", () => {
  const now = new Date("2026-09-08T12:00:00Z");
  const oldHistory = () => assertFreshness(writeHistory(["2026-08-01T12:00:00.000Z"]), 2, now);

  it("keeps a quiet repository healthy even with old observations", () => {
    const result = assessExpectedBenchmarkPublication(oldHistory(), [], now);
    expect(result.status).toBe("fresh");
    expect(result.expectation).toBe("idle");
    expect(describeBenchmarkHistoryFreshness(result)).toContain("No newer main-branch push");
  });

  it("starts the publication budget with new work rather than the old observation", () => {
    const result = assessExpectedBenchmarkPublication(oldHistory(), [producerRun("2026-09-08T00:00:00Z")], now);
    expect(result.status).toBe("fresh");
    expect(result.expectation).toBe("within-budget");
    expect(result.publication_wait_days).toBe(0.5);
  });

  it("alerts on overdue producer work even if its workflow concluded successfully", () => {
    const runs = [
      { ...producerRun("2026-09-05T00:00:00Z"), conclusion: "success" },
      { ...producerRun("2026-09-08T00:00:00Z"), databaseId: 101, conclusion: "failure" }
    ];
    const result = assessExpectedBenchmarkPublication(oldHistory(), runs, now);
    expect(result.status).toBe("stale");
    expect(result.pending_producer_run_id).toBe(100);
    expect(result.publication_wait_days).toBe(3.5);
    expect(describeBenchmarkHistoryFreshness(result)).toContain("push run 100");
  });

  it("clears earlier failures when a newer observation has been published", () => {
    const history = assertFreshness(writeHistory(["2026-09-07T00:00:00.000Z"]), 2, now);
    const result = assessExpectedBenchmarkPublication(history, [producerRun("2026-09-05T00:00:00Z")], now);
    expect(result.expectation).toBe("idle");
    expect(result.status).toBe("fresh");
  });

  it("ignores the published candidate, manual runs, and other branches", () => {
    const history = oldHistory();
    const run = producerRun("2026-09-05T00:00:00Z");
    const result = assessExpectedBenchmarkPublication(
      history,
      [
        { ...run, headSha: history.newest.candidate_commit },
        { ...run, event: "workflow_dispatch" },
        { ...run, headBranch: "feature" }
      ],
      now
    );
    expect(result.expectation).toBe("idle");
  });

  it("fails when producer evidence is missing, malformed, future-dated, or truncated", () => {
    const history = oldHistory();
    for (const runs of [undefined, {}, [null], [{}], [producerRun("2027-01-01T00:00:00Z")]]) {
      expect(() => assessExpectedBenchmarkPublication(history, runs, now)).toThrow();
    }
    expect(() =>
      assessExpectedBenchmarkPublication(
        history,
        Array.from({ length: 1000 }, (_, index) => ({ ...producerRun("2026-09-08T00:00:00Z"), databaseId: index + 1 })),
        now
      )
    ).toThrow(/truncated/u);
  });
});

describe("benchmark history freshness assertion", () => {
  it("passes a history whose newest observation is inside the budget", () => {
    const history = writeHistory(["2026-08-29T12:00:00.000Z", "2026-08-30T12:00:00.000Z"]);

    const result = assertFreshness(history, 2);

    expect(result.status).toBe("fresh");
    expect(result.newest.run_timestamp).toBe("2026-08-30T12:00:00.000Z");
    expect(result.age_days).toBeCloseTo(0.7618, 4);
    expect(result.observation_count).toBe(2);
    expect(benchmarkHistoryFreshnessExitCode(result.status)).toBe(0);
    expect(describeBenchmarkHistoryFreshness(result)).toContain("Benchmark history is advancing");
  });

  it("fails a stale history and names the age and the newest run_timestamp", () => {
    const history = writeHistory(["2026-08-12T01:03:09.686Z"]);

    const result = assertFreshness(history, 2);
    const report = describeBenchmarkHistoryFreshness(result);

    expect(result.status).toBe("stale");
    expect(result.newest.run_timestamp).toBe("2026-08-12T01:03:09.686Z");
    expect(result.age_days).toBeCloseTo(19.2179, 3);
    expect(benchmarkHistoryFreshnessExitCode(result.status)).toBe(1);
    expect(report).toContain("Benchmark history has stopped advancing");
    expect(report).toContain("no new observation for 19.2 days");
    expect(report).toContain("past the 2-day freshness budget");
    expect(report).toContain("| Newest `run_timestamp` | `2026-08-12T01:03:09.686Z` |");
    expect(report).toContain("| Age | 19.22 days |");
    // The refusal to publish an incomplete generation is the correct behaviour,
    // so the alert must never read as a request to loosen it.
    expect(report).toContain("That refusal is correct and must keep");
  });

  it("names the history it actually read instead of a hardcoded document path", () => {
    const history = writeHistory(["2026-08-12T01:03:09.686Z"]);

    const stale = describeBenchmarkHistoryFreshness(assertFreshness(history, 2));
    const fresh = describeBenchmarkHistoryFreshness(assertFreshness(history, 365));

    for (const report of [stale, fresh]) {
      expect(report).toContain(`\`${history}\``);
      expect(report).not.toContain("benchmarks/ultrafuzzbench/history.json");
    }
  });

  it("takes the true maximum from observations that are not in chronological order", () => {
    const history = writeHistory([
      "2026-08-30T12:00:00.000Z",
      "2026-07-01T00:00:00.000Z",
      "2026-08-31T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z"
    ]);

    const result = assertFreshness(history, 2);

    expect(result.newest.run_timestamp).toBe("2026-08-31T00:00:00.000Z");
    expect(result.status).toBe("fresh");
    expect(result.observation_count).toBe(4);
  });

  it("refuses an observation-less history instead of reporting it fresh", () => {
    const history = writeHistory([]);

    // The canonical rule owns this refusal, so its own code must be what
    // surfaces: a local reimplementation of it is the drift risk here.
    let raised: unknown;
    try {
      assertFreshness(history, 2);
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(Error);
    expect((raised as { code?: string }).code).toBe("EVAL_HISTORY_EMPTY");
    expect((raised as Error).message).toContain("no observation to age against the requested 2 day maximum");
  });

  // `readEvalHistory` answers a missing file with an empty history, which would
  // otherwise make a deleted document the quietest possible pass.
  it("refuses an absent history instead of ageing an empty one", () => {
    expect(() => assertFreshness(temporaryPath("missing-history.json"), 2)).toThrow(/is not a regular file/u);
    expect(() => assertFreshness("", 2)).toThrow(/a history path is required/u);
  });

  it("refuses a budget that is not a positive number of days", () => {
    const history = writeHistory(["2026-08-30T12:00:00.000Z"]);

    for (const maxAgeDays of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertFreshness(history, maxAgeDays), String(maxAgeDays)).toThrow(
        /max age must be a positive number of days/u
      );
    }
    expect(() =>
      assertBenchmarkHistoryFreshness({ historyPath: history, maxAgeDays: 2, now: new Date("nope") })
    ).toThrow(/a valid current instant is required/u);
  });

  it("moves one unchanged document from fresh to stale on the injected clock alone", () => {
    const history = writeHistory(["2026-08-30T00:00:00.000Z"]);

    expect(assertFreshness(history, 2, new Date("2026-08-31T00:00:00.000Z")).status).toBe("fresh");
    expect(assertFreshness(history, 2, new Date("2026-09-01T00:00:00.000Z")).status).toBe("fresh");
    expect(assertFreshness(history, 2, new Date("2026-09-01T00:00:01.000Z")).status).toBe("stale");
    expect(assertFreshness(history, 2, new Date("2026-09-30T00:00:00.000Z")).status).toBe("stale");
  });

  it("delegates the document contract to the canonical parser rather than recopying it", () => {
    const source = fs.readFileSync(scriptPath, "utf8");

    expect(source).toContain('from "../../packages/evals/dist/index.js"');
    expect(source).toContain("assertEvalHistoryRecency");
    // The schema version and the run_timestamp grammar belong to
    // packages/evals/schema/eval-history.schema.json and nowhere else.
    expect(source).not.toContain("ultrafuzz.eval.history.v2");
    expect(source).not.toContain("[0-9]{4}-");
  });

  it("rejects a document the canonical parser does not accept", () => {
    const wrongVersion = temporaryPath("wrong-version.json");
    fs.mkdirSync(path.dirname(wrongVersion), { recursive: true });
    fs.writeFileSync(
      wrongVersion,
      JSON.stringify({ schema_version: "ultrafuzz.eval.history.v1", supersessions: [], observations: [] })
    );
    const notJson = temporaryPath("not-json.json");
    fs.mkdirSync(path.dirname(notJson), { recursive: true });
    fs.writeFileSync(notJson, "{ not json");

    for (const target of [wrongVersion, notJson]) {
      expect(() => assertFreshness(target, 2), target).toThrow();
    }
  });
});

describe("benchmark history freshness entrypoint", () => {
  it("exits 0 for a fresh document and writes the outputs the workflow branches on", () => {
    const history = writeHistory([isoDaysAgo(0.25)]);
    const report = temporaryPath("report.md");
    const outputs = temporaryPath("outputs.txt");

    const result = runScript(["--history", history, "--max-age-days", "2", "--report", report], outputs);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Benchmark publication is not overdue");
    expect(fs.readFileSync(report, "utf8")).toBe(result.stdout);
    expect(fs.readFileSync(outputs, "utf8")).toContain("status=fresh");
  });

  it("exits 1 for a stale document and still leaves the report the issue step reads", () => {
    const newest = isoDaysAgo(100);
    const history = writeHistory([newest]);
    const report = temporaryPath("report.md");
    const outputs = temporaryPath("outputs.txt");

    const result = runScript(["--history", history, "--max-age-days", "2", "--report", report], outputs);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Benchmark history has stopped advancing");
    expect(fs.readFileSync(report, "utf8")).toContain(newest);
    const emitted = fs.readFileSync(outputs, "utf8");
    expect(emitted).toContain("status=stale");
    expect(emitted).toContain(`newest_run_timestamp=${newest}`);
    expect(emitted).toMatch(/^age_days=1[0-9][0-9]\.[0-9]{2}$/mu);
  });

  it("exits non-zero for an unusable invocation instead of asserting nothing", () => {
    const history = writeHistory([isoDaysAgo(0.25)]);
    const report = temporaryPath("report.md");
    const invocations = [
      [],
      ["--history", history],
      ["--history", history, "--max-age-days", "2"],
      ["--history", history, "--max-age-days", "not-a-number", "--report", report],
      ["--history", history, "--max-age-days", "2", "--report", report, "--force"],
      ["--max-age-days", "2", "--report", report]
    ];

    for (const args of invocations) {
      const result = runScript(args, undefined);
      expect(result.status, args.join(" ")).not.toBe(0);
    }
  });
});

describe("benchmark history freshness workflow", () => {
  const workflowText = fs.readFileSync(workflowPath, "utf8");
  const workflow = parseYaml(workflowText) as Workflow;
  const job = requireJob(workflow, "assert_history_freshness");

  // The `runner` context exists in `steps.*.env`, `container.env` and
  // `services.env` only. A job-level `env:` that reads it either rejects the
  // workflow outright or resolves to an empty path, and a monitor that never
  // runs is the exact unearned green this workflow exists to eliminate.
  it("keeps runner.* out of every job-level env block", () => {
    for (const [jobId, candidate] of Object.entries(workflow.jobs)) {
      for (const [name, value] of Object.entries(candidate.env ?? {})) {
        expect(value, `${jobId}.env.${name}`).not.toContain("runner.");
      }
    }
  });

  it("runs the tested assertion instead of an inline copy of it", () => {
    const freshness = job.steps.find((step) => step.id === "freshness");

    expect(freshness?.run).toContain("scripts/ci/assert-benchmark-history-freshness.mjs");
    expect(freshness?.run).toContain('--history "$HISTORY_PATH"');
    expect(freshness?.run).toContain('--max-age-days "$MAX_AGE_DAYS"');
    expect(freshness?.run).toContain('--producer-runs "$PRODUCER_RUNS"');
    expect(freshness?.env?.HISTORY_REPORT).toBe("${{ runner.temp }}/benchmark-history-freshness.md");
    expect(freshness?.["continue-on-error" as keyof WorkflowStep]).toBeUndefined();
    // An assertion inlined into the workflow is covered by no test at all.
    expect(workflowText).not.toContain("ultrafuzz.eval.history.v2");
    expect(workflowText).not.toContain("RUN_TIMESTAMP_PATTERN");
  });

  it("hands the tracking issue the same report the assertion wrote", () => {
    const freshness = job.steps.find((step) => step.id === "freshness");
    const tracking = job.steps.find((step) => step.name === "Open or update the staleness tracking issue");

    expect(tracking?.env?.HISTORY_REPORT).toBe(freshness?.env?.HISTORY_REPORT);
    expect(tracking?.if).toBe("always() && steps.freshness.outputs.status != 'fresh'");
    // One tracking issue, commented on daily, rather than a fresh duplicate.
    expect(tracking?.run).toContain("gh issue comment");
    expect(tracking?.run).toContain("gh issue create");
  });

  it("stays a narrowly permissioned scheduled monitor pinned to full commit SHAs", () => {
    expect(workflow.on.schedule).toEqual([{ cron: "17 6 * * *" }]);
    expect(workflow.on.workflow_dispatch).toBeDefined();
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toEqual({ actions: "read", contents: "read", issues: "write" });
    for (const candidate of Object.values(workflow.jobs)) {
      for (const step of candidate.steps) {
        if (step.uses === undefined) continue;
        expect(step.uses, step.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/u);
      }
    }
  });

  it("checks chart consistency without reintroducing an age-only failure", () => {
    const corroboration = requireJob(workflow, "corroborate_history_consistency");
    const command = corroboration.steps.find(
      (step) => step.name === "Assert history consistency through the eval history CLI"
    );
    expect(command?.run).toContain("eval history --check --project .");
    expect(command?.run).not.toContain("--max-age-days");
  });
});
