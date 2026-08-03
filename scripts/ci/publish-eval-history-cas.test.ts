import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EVAL_HISTORY_PUBLICATION_GENERATION_SCHEMA_VERSION,
  parseEvalHistoryPublicationGeneration,
  publishEvalHistoryGeneration
} from "./publish-eval-history-cas.mjs";

const SCRIPT = fileURLToPath(new URL("./publish-eval-history-cas.mjs", import.meta.url));
const TARGET_REF = "refs/heads/main";
const CHARTS = [
  "latest-summary.svg",
  "quality.svg",
  "performance-cost.svg",
  "precision.svg",
  "recall.svg",
  "f1.svg",
  "cumulative-unique-true-positives.svg",
  "wall-clock-time.svg",
  "cost.svg"
];
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("eval history Git CAS publisher", () => {
  it("preserves two racing generations and makes a repeated generation idempotent", async () => {
    const fixture = createRepositoryFixture();
    const inputRoot = path.join(fixture.root, "inputs");
    const candidateCommit = git(fixture.checkoutA, ["rev-parse", "HEAD"]).trim();
    writeEvalRun(inputRoot, "run-a", "observation-a", candidateCommit);
    writeEvalRun(inputRoot, "run-a-2", "observation-a-2", candidateCommit);
    writeEvalRun(inputRoot, "run-b", "observation-b", candidateCommit);
    const generationA = writeGeneration(fixture.root, "generation-a.json", ["run-a", "run-a-2"], candidateCommit);
    const generationB = writeGeneration(fixture.root, "generation-b.json", ["run-b"], candidateCommit);
    const barrier = path.join(fixture.root, "barrier");
    fs.mkdirSync(barrier);

    const [first, second] = await Promise.all([
      invokePublisher(fixture.checkoutA, generationA, inputRoot, barrier),
      invokePublisher(fixture.checkoutB, generationB, inputRoot, barrier)
    ]);

    expect(first.published).toBe(true);
    expect(second.published).toBe(true);
    expect(Math.max(first.attempts, second.attempts)).toBeGreaterThanOrEqual(2);
    const history = JSON.parse(git(fixture.bare, ["show", `${TARGET_REF}:benchmarks/history.json`])) as {
      observations: Array<{ id: string }>;
    };
    expect(history.observations.map((entry) => entry.id)).toEqual([
      "observation-a",
      "observation-a-2",
      "observation-b"
    ]);
    expect(Number(git(fixture.bare, ["rev-list", "--count", `${candidateCommit}..${TARGET_REF}`]))).toBe(2);
    expect(
      git(fixture.bare, ["log", "--format=%s", `${candidateCommit}..${TARGET_REF}`])
        .trim()
        .split("\n")
    ).toEqual(["Update published eval history", "Update published eval history"]);
    expect(
      git(fixture.bare, ["log", "--format=%an", `${candidateCommit}..${TARGET_REF}`])
        .trim()
        .split("\n")
    ).toEqual(["ultrafuzz-eval-history-publisher[bot]", "ultrafuzz-eval-history-publisher[bot]"]);
    expect(
      git(fixture.bare, ["log", "--format=%ae", `${candidateCommit}..${TARGET_REF}`])
        .trim()
        .split("\n")
    ).toEqual([
      "308007741+ultrafuzz-eval-history-publisher[bot]@users.noreply.github.com",
      "308007741+ultrafuzz-eval-history-publisher[bot]@users.noreply.github.com"
    ]);
    const latestCommitBody = git(fixture.bare, ["log", "-1", "--format=%B", TARGET_REF]);
    expect(latestCommitBody).toContain(
      "Source-Workflow-Run: https://github.com/monad-developers/ultrafuzz/actions/runs/123"
    );
    expect(latestCommitBody).toContain(`Candidate-Commit: ${candidateCommit}`);

    const beforeRetry = git(fixture.bare, ["rev-parse", TARGET_REF]).trim();
    const retried = await invokePublisher(fixture.checkoutA, generationA, inputRoot);
    expect(retried).toMatchObject({ published: false, attempts: 1, commit: beforeRetry });
    expect(git(fixture.bare, ["rev-parse", TARGET_REF]).trim()).toBe(beforeRetry);
    expect(Number(git(fixture.bare, ["rev-list", "--count", `${candidateCommit}..${TARGET_REF}`]))).toBe(2);
    expect(git(fixture.bare, ["diff", "--name-only", candidateCommit, TARGET_REF]).trim().split("\n")).toEqual(
      ["benchmarks/history.json", ...CHARTS.map((chart) => `docs/assets/eval-history/${chart}`).sort()].sort()
    );
    for (const chart of CHARTS) {
      expect(git(fixture.bare, ["show", `${TARGET_REF}:docs/assets/eval-history/${chart}`])).toBe(
        `${chart}:observation-a,observation-a-2,observation-b\n`
      );
    }
  }, 30_000);

  it("preserves independent history already committed to main", async () => {
    const fixture = createRepositoryFixture();
    const inputRoot = path.join(fixture.root, "inputs");
    const candidateCommit = git(fixture.checkoutA, ["rev-parse", "HEAD"]).trim();
    writeEvalRun(inputRoot, "run-a", "observation-a", candidateCommit);
    writeEvalRun(inputRoot, "run-b", "observation-b", candidateCommit);
    const generationA = writeGeneration(fixture.root, "generation-a.json", ["run-a"], candidateCommit);
    const generationB = writeGeneration(fixture.root, "generation-b.json", ["run-b"], candidateCommit);

    await invokePublisher(fixture.checkoutA, generationA, inputRoot);
    git(fixture.seed, ["pull", "--ff-only", "origin", "main"]);
    appendFixtureHistoryObservation(fixture.seed, "observation-main", "run-main");
    git(fixture.seed, ["add", "benchmarks/history.json", "docs/assets/eval-history"]);
    git(fixture.seed, ["commit", "-m", "Append independent main history"]);
    git(fixture.seed, ["push", "origin", "main"]);
    const mainBeforePublication = git(fixture.bare, ["rev-parse", "refs/heads/main"]).trim();

    const published = await invokePublisher(fixture.checkoutB, generationB, inputRoot);

    expect(published).toMatchObject({ published: true, attempts: 1 });
    const targetAfter = git(fixture.bare, ["rev-parse", TARGET_REF]).trim();
    expect(gitStatus(fixture.bare, ["merge-base", "--is-ancestor", mainBeforePublication, targetAfter])).toBe(0);
    expect(git(fixture.bare, ["rev-list", "--parents", "-n", "1", targetAfter]).trim().split(" ")).toHaveLength(2);
    const history = JSON.parse(git(fixture.bare, ["show", `${TARGET_REF}:benchmarks/history.json`])) as {
      observations: Array<{ id: string }>;
    };
    expect(history.observations.map((entry) => entry.id)).toEqual([
      "observation-a",
      "observation-b",
      "observation-main"
    ]);
    for (const chart of CHARTS) {
      expect(git(fixture.bare, ["show", `${TARGET_REF}:docs/assets/eval-history/${chart}`])).toBe(
        `${chart}:observation-a,observation-b,observation-main\n`
      );
    }

    const retried = await invokePublisher(fixture.checkoutA, generationB, inputRoot);
    expect(retried).toMatchObject({ published: false, attempts: 1, commit: targetAfter });
    expect(git(fixture.bare, ["rev-parse", TARGET_REF]).trim()).toBe(targetAfter);
  }, 30_000);

  it("does not move main during an idempotent retry", async () => {
    const fixture = createRepositoryFixture();
    const inputRoot = path.join(fixture.root, "inputs");
    const candidateCommit = git(fixture.checkoutA, ["rev-parse", "HEAD"]).trim();
    writeEvalRun(inputRoot, "run-a", "observation-a", candidateCommit);
    const generation = writeGeneration(fixture.root, "generation.json", ["run-a"], candidateCommit);

    await invokePublisher(fixture.checkoutA, generation, inputRoot);
    const publishedTarget = git(fixture.bare, ["rev-parse", TARGET_REF]).trim();

    const retried = await invokePublisher(fixture.checkoutA, generation, inputRoot);

    expect(retried).toMatchObject({ branch: "main", published: false, attempts: 1, commit: publishedTarget });
    expect(git(fixture.bare, ["rev-parse", TARGET_REF]).trim()).toBe(publishedTarget);
  }, 30_000);

  it("preserves unrelated main changes while committing only publication paths", () => {
    const fixture = createRepositoryFixture();
    const inputRoot = path.join(fixture.root, "inputs");
    const candidateCommit = git(fixture.checkoutB, ["rev-parse", "HEAD"]).trim();
    writeEvalRun(inputRoot, "run-a", "observation-a", candidateCommit);
    const generation = writeGeneration(fixture.root, "generation.json", ["run-a"], candidateCommit);

    writeFile(path.join(fixture.checkoutA, "independent-main-change.txt"), "must be preserved\n");
    git(fixture.checkoutA, ["add", "independent-main-change.txt"]);
    git(fixture.checkoutA, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "-m",
      "Advance main independently"
    ]);
    git(fixture.checkoutA, ["push", "origin", `HEAD:${TARGET_REF}`]);
    const independentTarget = git(fixture.bare, ["rev-parse", TARGET_REF]).trim();

    const published = publishEvalHistoryGeneration({
      generationPath: generation,
      inputRoot,
      repositoryRoot: fixture.checkoutB
    });
    expect(published).toMatchObject({ branch: "main", published: true, attempts: 1 });
    const publishedTarget = git(fixture.bare, ["rev-parse", TARGET_REF]).trim();
    expect(git(fixture.bare, ["show", `${TARGET_REF}:independent-main-change.txt`])).toBe("must be preserved\n");
    expect(git(fixture.bare, ["diff", "--name-only", independentTarget, publishedTarget]).trim().split("\n")).toEqual(
      ["benchmarks/history.json", ...CHARTS.map((chart) => `docs/assets/eval-history/${chart}`)].sort()
    );
  });

  it("rejects non-canonical generation paths and URLs", () => {
    const valid = {
      schema_version: EVAL_HISTORY_PUBLICATION_GENERATION_SCHEMA_VERSION,
      candidate_commit: "a".repeat(40),
      candidate_repository_url: "https://github.com/monad-developers/ultrafuzz",
      source_artifact: "https://github.com/monad-developers/ultrafuzz/actions/runs/123",
      runs: [{ eval_run_id: "run-a", benchmark: "evmbench", lane: "smoke", input_path: "runs/run-a" }]
    };
    expect(() =>
      parseEvalHistoryPublicationGeneration({
        ...valid,
        runs: [{ ...valid.runs[0], input_path: "../run-a" }]
      })
    ).toThrow(/safe path segments/u);
    expect(() =>
      parseEvalHistoryPublicationGeneration({
        ...valid,
        source_artifact: "https://attacker.invalid/actions/runs/123"
      })
    ).toThrow(/GitHub Actions run URL/u);
  });

  it("accepts enriched automatic generation rows and rejects invalid case counts", () => {
    const valid = {
      schema_version: EVAL_HISTORY_PUBLICATION_GENERATION_SCHEMA_VERSION,
      candidate_commit: "a".repeat(40),
      candidate_repository_url: "https://github.com/monad-developers/ultrafuzz",
      source_artifact: "https://github.com/monad-developers/ultrafuzz/actions/runs/123",
      runs: [
        {
          eval_run_id: "run-a",
          benchmark: "ultrafuzz-bench",
          lane: "smoke",
          status: "succeeded",
          input_path: "runs/run-a",
          target_ids: ["very-liquid-vaults-foundry", "venus-isolated-pools-hardhat", "stableswap-ng-vyper"],
          executed_case_count: 3,
          graded_case_count: 3,
          publication_url: "https://github.com/monad-developers/ultrafuzz/actions/runs/123/artifacts"
        }
      ]
    };
    expect(parseEvalHistoryPublicationGeneration(valid).runs[0]).toMatchObject({
      status: "succeeded",
      target_ids: ["very-liquid-vaults-foundry", "venus-isolated-pools-hardhat", "stableswap-ng-vyper"],
      executed_case_count: 3,
      graded_case_count: 3,
      publication_url: "https://github.com/monad-developers/ultrafuzz/actions/runs/123/artifacts"
    });
    expect(
      parseEvalHistoryPublicationGeneration({
        ...valid,
        runs: [{ ...valid.runs[0], status: "failed" }]
      }).runs[0]
    ).toMatchObject({ status: "failed" });
    expect(() =>
      parseEvalHistoryPublicationGeneration({
        ...valid,
        runs: [{ ...valid.runs[0], executed_case_count: 0 }]
      })
    ).toThrow(/executed_case_count must be a positive safe integer/u);
    expect(() =>
      parseEvalHistoryPublicationGeneration({
        ...valid,
        runs: [{ ...valid.runs[0], graded_case_count: 2 }]
      })
    ).toThrow(/case counts do not cover its target set/u);
  });

  it("rejects an eval artifact from a different candidate commit", () => {
    const fixture = createRepositoryFixture();
    const inputRoot = path.join(fixture.root, "inputs");
    const candidateCommit = git(fixture.checkoutA, ["rev-parse", "HEAD"]).trim();
    writeEvalRun(inputRoot, "run-a", "observation-a", "b".repeat(40));
    const generation = writeGeneration(fixture.root, "generation.json", ["run-a"], candidateCommit);

    expect(() =>
      publishEvalHistoryGeneration({
        generationPath: generation,
        inputRoot,
        repositoryRoot: fixture.checkoutA
      })
    ).toThrow(/candidate commit does not match publication generation/u);
  });
});

interface PublisherResult {
  branch: string;
  commit: string;
  attempts: number;
  published: boolean;
  eval_run_ids: string[];
}

function createRepositoryFixture(): { root: string; bare: string; seed: string; checkoutA: string; checkoutB: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-history-cas-test-"));
  temporaryRoots.push(root);
  const bare = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  const checkoutA = path.join(root, "checkout-a");
  const checkoutB = path.join(root, "checkout-b");
  git(root, ["init", "--bare", "--initial-branch=main", bare]);
  git(root, ["init", "--initial-branch=main", seed]);
  git(seed, ["config", "user.name", "Fixture"]);
  git(seed, ["config", "user.email", "fixture@example.com"]);
  writeFile(path.join(seed, ".gitignore"), "dist/\n.ultrafuzz/\n");
  writeFile(
    path.join(seed, "benchmarks", "history.json"),
    `${JSON.stringify({ schema_version: "fixture.history.v1", observations: [] }, null, 2)}\n`
  );
  for (const chart of CHARTS) writeFile(path.join(seed, "docs", "assets", "eval-history", chart), `${chart}:\n`);
  git(seed, ["add", ".gitignore", "benchmarks/history.json", "docs/assets/eval-history"]);
  git(seed, ["commit", "-m", "Initial history"]);
  git(seed, ["remote", "add", "origin", bare]);
  git(seed, ["push", "-u", "origin", "main"]);
  git(root, ["clone", bare, checkoutA]);
  git(root, ["clone", bare, checkoutB]);
  installFixtureCli(checkoutA);
  installFixtureCli(checkoutB);
  return { root, bare, seed, checkoutA, checkoutB };
}

function installFixtureCli(checkout: string): void {
  writeFile(
    path.join(checkout, "packages", "cli", "dist", "index.js"),
    String.raw`import fs from "node:fs";
import path from "node:path";

const charts = [
  "latest-summary.svg",
  "quality.svg",
  "performance-cost.svg",
  "precision.svg",
  "recall.svg",
  "f1.svg",
  "cumulative-unique-true-positives.svg",
  "wall-clock-time.svg",
  "cost.svg"
];
const args = process.argv.slice(2);
if (args[0] !== "eval" || args[1] !== "history") throw new Error("unexpected fixture CLI command");
const projectIndex = args.indexOf("--project");
if (projectIndex < 0 || args[projectIndex + 1] === undefined) throw new Error("fixture CLI requires --project");
const project = path.resolve(args[projectIndex + 1]);
const runId = args[2]?.startsWith("--") === false ? args[2] : undefined;
const historyPath = path.join(project, "benchmarks", "history.json");
const chartsRoot = path.join(project, "docs", "assets", "eval-history");

function expectedCharts(history) {
  const ids = history.observations.map((entry) => entry.id).sort();
  return new Map(charts.map((file) => [file, file + ":" + ids.join(",") + "\n"]));
}

if (runId !== undefined) {
  const run = JSON.parse(fs.readFileSync(path.join(project, ".ultrafuzz", "evals", "runs", runId, "eval.json"), "utf8"));
  if (run.eval_run_id !== runId) throw new Error("fixture eval identity mismatch");
  const barrier = process.env.ULTRAFUZZ_HISTORY_CAS_TEST_BARRIER;
  if (barrier !== undefined && !fs.existsSync(path.join(barrier, "released"))) {
    fs.writeFileSync(path.join(barrier, runId + ".ready"), "ready\n");
    const deadline = Date.now() + 10_000;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (fs.readdirSync(barrier).filter((file) => file.endsWith(".ready")).length < 2) {
      if (Date.now() > deadline) throw new Error("fixture publication barrier timed out");
      Atomics.wait(wait, 0, 0, 20);
    }
    try {
      fs.writeFileSync(path.join(barrier, "released"), "released\n", { flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  const history = JSON.parse(fs.readFileSync(historyPath, "utf8"));
  if (!history.observations.some((entry) => entry.id === run.observation_id)) {
    history.observations.push({ id: run.observation_id, source_eval_run_id: runId });
  }
  history.observations.sort((left, right) => left.id.localeCompare(right.id));
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2) + "\n");
  fs.mkdirSync(chartsRoot, { recursive: true });
  for (const [file, contents] of expectedCharts(history)) fs.writeFileSync(path.join(chartsRoot, file), contents);
  process.exit(0);
}

const history = JSON.parse(fs.readFileSync(historyPath, "utf8"));
if (args.includes("--check")) {
  for (const [file, contents] of expectedCharts(history)) {
    if (fs.readFileSync(path.join(chartsRoot, file), "utf8") !== contents) throw new Error("stale fixture chart " + file);
  }
} else {
  fs.mkdirSync(chartsRoot, { recursive: true });
  for (const [file, contents] of expectedCharts(history)) fs.writeFileSync(path.join(chartsRoot, file), contents);
}
`
  );
}

function writeEvalRun(inputRoot: string, evalRunId: string, observationId: string, candidateCommit: string): void {
  writeFile(
    path.join(inputRoot, evalRunId, "eval.json"),
    `${JSON.stringify(
      {
        eval_run_id: evalRunId,
        observation_id: observationId,
        provenance: { candidate: { commit: candidateCommit } }
      },
      null,
      2
    )}\n`
  );
}

function writeGeneration(root: string, file: string, evalRunIds: string[], candidateCommit: string): string {
  const generationPath = path.join(root, file);
  writeFile(
    generationPath,
    `${JSON.stringify(
      {
        schema_version: EVAL_HISTORY_PUBLICATION_GENERATION_SCHEMA_VERSION,
        candidate_commit: candidateCommit,
        candidate_repository_url: "https://github.com/monad-developers/ultrafuzz",
        source_artifact: "https://github.com/monad-developers/ultrafuzz/actions/runs/123",
        runs: evalRunIds.map((evalRunId) => ({
          eval_run_id: evalRunId,
          benchmark: "evmbench",
          lane: "smoke",
          input_path: evalRunId
        }))
      },
      null,
      2
    )}\n`
  );
  return generationPath;
}

function appendFixtureHistoryObservation(root: string, observationId: string, evalRunId: string): void {
  const historyPath = path.join(root, "benchmarks", "history.json");
  const history = JSON.parse(fs.readFileSync(historyPath, "utf8")) as {
    observations: Array<{ id: string; source_eval_run_id: string }>;
  };
  history.observations.push({ id: observationId, source_eval_run_id: evalRunId });
  history.observations.sort((left, right) => left.id.localeCompare(right.id));
  fs.writeFileSync(historyPath, `${JSON.stringify(history, null, 2)}\n`, "utf8");
  for (const chart of CHARTS) {
    writeFile(
      path.join(root, "docs", "assets", "eval-history", chart),
      `${chart}:${history.observations.map((entry) => entry.id).join(",")}\n`
    );
  }
}

async function invokePublisher(
  checkout: string,
  generationPath: string,
  inputRoot: string,
  barrier?: string
): Promise<PublisherResult> {
  const child = Bun.spawn(["node", SCRIPT, generationPath, inputRoot], {
    cwd: checkout,
    env: {
      ...process.env,
      ...(barrier === undefined ? {} : { ULTRAFUZZ_HISTORY_CAS_TEST_BARRIER: barrier })
    },
    stdout: "pipe",
    stderr: "pipe"
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const [exitCode, output, diagnostics] = await Promise.all([child.exited, stdout, stderr]);
  expect(exitCode, diagnostics).toBe(0);
  return JSON.parse(output) as PublisherResult;
}

function writeFile(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitStatus(cwd: string, args: string[]): number {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
  return result.exitCode;
}
