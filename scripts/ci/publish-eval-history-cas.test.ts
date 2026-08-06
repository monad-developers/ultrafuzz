import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EVAL_HISTORY_PUBLICATION_GENERATION_SCHEMA_VERSION,
  parseEvalHistoryPublicationGeneration,
  publicationTreeDigest,
  publishEvalHistoryGeneration,
  validateEvalHistoryPublicationHandoff
} from "./publish-eval-history-cas.mjs";

const SCRIPT = fileURLToPath(new URL("./publish-eval-history-cas.mjs", import.meta.url));
const TARGET_REF = "refs/heads/main";
const OVERVIEW_CHARTS = ["latest-summary.svg", "quality.svg", "performance-cost.svg"];
const METRIC_CHARTS = [
  "precision.svg",
  "recall.svg",
  "f1.svg",
  "cumulative-unique-true-positives.svg",
  "wall-clock-time.svg",
  "cost.svg"
];
const CHARTS = [...OVERVIEW_CHARTS, ...METRIC_CHARTS];
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
      ["benchmarks/history.json", ...METRIC_CHARTS.map((chart) => `docs/assets/eval-history/${chart}`)].sort()
    );
    for (const chart of METRIC_CHARTS) {
      expect(git(fixture.bare, ["show", `${TARGET_REF}:docs/assets/eval-history/${chart}`])).toBe(
        `${chart}:observation-a,observation-a-2,observation-b\n`
      );
    }
    for (const chart of OVERVIEW_CHARTS) {
      expect(git(fixture.bare, ["show", `${TARGET_REF}:docs/assets/eval-history/${chart}`])).toBe(`${chart}:\n`);
    }
  }, 30_000);

  it("accepts history-only advancement beyond the tooling checkout", async () => {
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
    for (const chart of METRIC_CHARTS) {
      expect(git(fixture.bare, ["show", `${TARGET_REF}:docs/assets/eval-history/${chart}`])).toBe(
        `${chart}:observation-a,observation-b,observation-main\n`
      );
    }
    for (const chart of OVERVIEW_CHARTS) {
      expect(git(fixture.bare, ["show", `${TARGET_REF}:docs/assets/eval-history/${chart}`])).toBe(`${chart}:\n`);
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

  it("accepts a descendant main advancement after its publication push succeeds", () => {
    const fixture = createRepositoryFixture();
    const inputRoot = path.join(fixture.root, "inputs");
    const candidateCommit = git(fixture.checkoutA, ["rev-parse", "HEAD"]).trim();
    writeEvalRun(inputRoot, "run-post-push", "observation-post-push", candidateCommit);
    const generation = writeGeneration(fixture.root, "generation-post-push.json", ["run-post-push"], candidateCommit);
    installPostPushMainAdvancementHook(fixture.bare);

    const published = publishEvalHistoryGeneration(publisherInput(fixture.checkoutA, generation, inputRoot));

    expect(published).toMatchObject({ branch: "main", published: true, attempts: 1 });
    const advancedTarget = git(fixture.bare, ["rev-parse", TARGET_REF]).trim();
    expect(advancedTarget).not.toBe(published.commit);
    expect(git(fixture.bare, ["rev-parse", `${TARGET_REF}^`]).trim()).toBe(published.commit);
    expect(gitStatus(fixture.bare, ["merge-base", "--is-ancestor", published.commit, advancedTarget])).toBe(0);
    expect(git(fixture.bare, ["show", `${TARGET_REF}:post-push-advancement.txt`])).toBe(
      "advanced after successful publication push\n"
    );
  });

  it("atomically publishes EVMBench history and only the six benchmark-wide charts", () => {
    const fixture = createRepositoryFixture();
    const inputRoot = path.join(fixture.root, "inputs");
    const candidateCommit = git(fixture.checkoutA, ["rev-parse", "HEAD"]).trim();
    writeEvalRun(inputRoot, "run-evmbench", ["observation-a", "observation-b", "observation-c"], candidateCommit);
    const generation = writeGeneration(fixture.root, "generation-evmbench.json", ["run-evmbench"], candidateCommit);

    const published = publishEvalHistoryGeneration(publisherInput(fixture.checkoutA, generation, inputRoot));

    expect(published).toMatchObject({ published: true, attempts: 1 });
    const parent = git(fixture.bare, ["rev-parse", `${TARGET_REF}^`]).trim();
    expect(git(fixture.bare, ["diff", "--name-only", parent, TARGET_REF]).trim().split("\n").sort()).toEqual(
      ["benchmarks/history.json", ...METRIC_CHARTS.map((chart) => `docs/assets/eval-history/${chart}`)].sort()
    );
    for (const chart of OVERVIEW_CHARTS) {
      expect(git(fixture.bare, ["show", `${TARGET_REF}:docs/assets/eval-history/${chart}`])).toBe(`${chart}:\n`);
    }
  });

  it("atomically publishes exactly three UltrafuzzBench observations and all nine charts", () => {
    const fixture = createRepositoryFixture();
    const inputRoot = path.join(fixture.root, "inputs");
    const candidateCommit = git(fixture.checkoutA, ["rev-parse", "HEAD"]).trim();
    writeEvalRun(
      inputRoot,
      "run-three",
      ["observation-a", "observation-b", "observation-c"],
      candidateCommit,
      "ultrafuzz-bench"
    );
    const generation = writeGeneration(fixture.root, "generation-three.json", ["run-three"], candidateCommit);

    const published = publishEvalHistoryGeneration(publisherInput(fixture.checkoutA, generation, inputRoot));

    expect(published).toMatchObject({ published: true, attempts: 1 });
    const parent = git(fixture.bare, ["rev-parse", `${TARGET_REF}^`]).trim();
    expect(git(fixture.bare, ["diff", "--name-only", parent, TARGET_REF]).trim().split("\n").sort()).toEqual(
      ["benchmarks/history.json", ...CHARTS.map((chart) => `docs/assets/eval-history/${chart}`)].sort()
    );
    const history = JSON.parse(git(fixture.bare, ["show", `${TARGET_REF}:benchmarks/history.json`])) as {
      observations: Array<{ id: string }>;
    };
    expect(history.observations.map((observation) => observation.id)).toEqual([
      "observation-a",
      "observation-b",
      "observation-c"
    ]);
  });

  it("rejects a partial generation already preseeded with one expected observation", () => {
    const fixture = createRepositoryFixture();
    const inputRoot = path.join(fixture.root, "inputs");
    const candidateCommit = git(fixture.checkoutA, ["rev-parse", "HEAD"]).trim();
    writeEvalRun(inputRoot, "run-partial", ["observation-a", "observation-b", "observation-c"], candidateCommit);
    const generation = writeGeneration(fixture.root, "generation-partial.json", ["run-partial"], candidateCommit);
    const run = JSON.parse(fs.readFileSync(path.join(inputRoot, "run-partial", "eval", "eval.json"), "utf8")) as {
      observations: Array<ReturnType<typeof fixtureObservation>>;
    };
    appendFixtureHistoryValue(fixture.seed, run.observations[0]!);
    git(fixture.seed, ["add", "benchmarks/history.json", "docs/assets/eval-history"]);
    git(fixture.seed, ["commit", "-m", "Preseed one generation observation"]);
    git(fixture.seed, ["push", "origin", "main"]);

    expect(() => publishEvalHistoryGeneration(publisherInput(fixture.checkoutA, generation, inputRoot))).toThrow(
      /partial or foreign observation set/u
    );
  });

  it("publishes a first publication whose deterministic chart rendering leaves one chart unchanged", () => {
    // Chart rendering is deterministic, so a chart whose own inputs did not change
    // is legitimately byte-identical. `latest-summary.svg` in particular renders only
    // the newest observation by run timestamp. Requiring an exact staged path set
    // would permanently reject a fully scored result, because the rejection escapes
    // the compare-and-swap retry loop. The semantic delta is asserted separately.
    const fixture = createRepositoryFixture();
    const inputRoot = path.join(fixture.root, "inputs");
    const candidateCommit = git(fixture.checkoutA, ["rev-parse", "HEAD"]).trim();
    writeEvalRun(inputRoot, "run-subset", ["observation-a", "observation-b", "observation-c"], candidateCommit);
    const generation = writeGeneration(fixture.root, "generation-subset.json", ["run-subset"], candidateCommit);
    const previous = process.env.ULTRAFUZZ_HISTORY_CAS_TEST_SUBSET_CHARTS;
    process.env.ULTRAFUZZ_HISTORY_CAS_TEST_SUBSET_CHARTS = "1";
    let result;
    try {
      result = publishEvalHistoryGeneration(publisherInput(fixture.checkoutA, generation, inputRoot));
    } finally {
      if (previous === undefined) delete process.env.ULTRAFUZZ_HISTORY_CAS_TEST_SUBSET_CHARTS;
      else process.env.ULTRAFUZZ_HISTORY_CAS_TEST_SUBSET_CHARTS = previous;
    }
    expect(result.published).toBe(true);
    expect(result.eval_run_ids).toEqual(["run-subset"]);
    const changed = git(fixture.bare, ["show", "--name-only", "--format=", TARGET_REF])
      .split("\n")
      .filter((line) => line.length > 0)
      .sort();
    // History must still be recorded, and the unchanged chart must simply be absent
    // rather than causing a rejection.
    expect(changed).toContain("benchmarks/history.json");
    expect(changed).not.toContain("docs/assets/eval-history/cost.svg");
    const history = JSON.parse(git(fixture.bare, ["show", `${TARGET_REF}:benchmarks/history.json`])) as {
      observations: Array<{ id: string }>;
    };
    expect(history.observations.map((observation) => observation.id)).toEqual([
      "observation-a",
      "observation-b",
      "observation-c"
    ]);
  });

  it("rejects a coherently parseable publication tree substituted after generation preparation", () => {
    const fixture = createRepositoryFixture();
    const inputRoot = path.join(fixture.root, "inputs");
    const candidateCommit = git(fixture.checkoutA, ["rev-parse", "HEAD"]).trim();
    writeEvalRun(inputRoot, "run-substituted", "observation-a", candidateCommit);
    const generation = writeGeneration(
      fixture.root,
      "generation-substituted.json",
      ["run-substituted"],
      candidateCommit
    );
    writeFile(
      path.join(inputRoot, "run-substituted", "eval", "summary.json"),
      `${JSON.stringify({ eval_run_id: "run-substituted", score_revision: 2 }, null, 2)}\n`
    );

    expect(() => publishEvalHistoryGeneration(publisherInput(fixture.checkoutA, generation, inputRoot))).toThrow(
      /publication tree digest does not match generation/u
    );
  });

  it("rejects digest rebinding when generation bytes no longer match the trusted workflow output", () => {
    const fixture = createRepositoryFixture();
    const inputRoot = path.join(fixture.root, "inputs");
    const candidateCommit = git(fixture.checkoutA, ["rev-parse", "HEAD"]).trim();
    writeEvalRun(inputRoot, "run-rebound", "observation-a", candidateCommit);
    const generation = writeGeneration(fixture.root, "generation-rebound.json", ["run-rebound"], candidateCommit);
    const trustedGenerationSha256 = sha256(fs.readFileSync(generation));
    writeFile(
      path.join(inputRoot, "run-rebound", "eval", "summary.json"),
      `${JSON.stringify({ eval_run_id: "run-rebound", score_revision: 2 }, null, 2)}\n`
    );
    const rebound = JSON.parse(fs.readFileSync(generation, "utf8")) as {
      runs: Array<{ publication_tree_sha256: string }>;
    };
    rebound.runs[0]!.publication_tree_sha256 = publicationTreeDigest(path.join(inputRoot, "run-rebound"));
    writeFile(generation, `${JSON.stringify(rebound, null, 2)}\n`);

    expect(() =>
      publishEvalHistoryGeneration({
        generationPath: generation,
        inputRoot,
        repositoryRoot: fixture.checkoutA,
        expectedGenerationSha256: trustedGenerationSha256
      })
    ).toThrow(/generation SHA-256 does not match the trusted workflow output/u);
  });

  it("validates only an exact digest-bound publication handoff", () => {
    const fixture = createHandoffFixture();
    const expectedGenerationSha256 = sha256(fs.readFileSync(fixture.generation));

    expect(
      validateEvalHistoryPublicationHandoff({
        handoffRoot: fixture.handoff,
        expectedGenerationSha256,
        expectedCandidateCommit: fixture.candidateCommit,
        expectedRepositoryUrl: "https://github.com/monad-developers/ultrafuzz"
      })
    ).toMatchObject({ candidate_commit: fixture.candidateCommit, eval_run_ids: ["run-handoff"] });
    expect(() =>
      validateEvalHistoryPublicationHandoff({
        handoffRoot: fixture.handoff,
        expectedGenerationSha256,
        expectedCandidateCommit: "b".repeat(40),
        expectedRepositoryUrl: "https://github.com/monad-developers/ultrafuzz"
      })
    ).toThrow(/candidate commit does not match the trusted workflow output/u);

    writeFile(path.join(fixture.handoff, "unexpected.txt"), "unexpected\n");
    expect(() =>
      validateEvalHistoryPublicationHandoff({ handoffRoot: fixture.handoff, expectedGenerationSha256 })
    ).toThrow(/must contain exactly generation.json, unpacked/u);
    fs.rmSync(path.join(fixture.handoff, "unexpected.txt"));

    fs.mkdirSync(path.join(fixture.inputRoot, "unbound-run"));
    expect(() =>
      validateEvalHistoryPublicationHandoff({ handoffRoot: fixture.handoff, expectedGenerationSha256 })
    ).toThrow(/publication input layout must contain exactly run-handoff/u);
    fs.rmdirSync(path.join(fixture.inputRoot, "unbound-run"));

    writeFile(path.join(fixture.inputRoot, "run-handoff", "eval", "summary.json"), "{}\n");
    expect(() =>
      validateEvalHistoryPublicationHandoff({ handoffRoot: fixture.handoff, expectedGenerationSha256 })
    ).toThrow(/publication tree digest does not match generation/u);
  });

  it("rejects linked handoff roots and generation files", () => {
    const fixture = createHandoffFixture();
    const expectedGenerationSha256 = sha256(fs.readFileSync(fixture.generation));
    const linkedRoot = path.join(path.dirname(fixture.handoff), "linked-handoff");
    fs.symlinkSync(fixture.handoff, linkedRoot);
    expect(() => validateEvalHistoryPublicationHandoff({ handoffRoot: linkedRoot, expectedGenerationSha256 })).toThrow(
      /handoff root must be a regular directory/u
    );

    const originalGeneration = path.join(path.dirname(fixture.handoff), "original-generation.json");
    fs.renameSync(fixture.generation, originalGeneration);
    fs.symlinkSync(originalGeneration, fixture.generation);
    expect(() =>
      validateEvalHistoryPublicationHandoff({ handoffRoot: fixture.handoff, expectedGenerationSha256 })
    ).toThrow(/handoff generation JSON must be a regular file/u);
  });

  it("keeps publisher authority out of the history CLI and bypasses repository hooks", () => {
    const fixture = createRepositoryFixture();
    const inputRoot = path.join(fixture.root, "inputs");
    const candidateCommit = git(fixture.checkoutA, ["rev-parse", "HEAD"]).trim();
    writeEvalRun(inputRoot, "run-authority", "observation-authority", candidateCommit);
    const generation = writeGeneration(fixture.root, "generation-authority.json", ["run-authority"], candidateCommit);
    const childEnvironment = path.join(fixture.root, "child-environment.json");
    const hookEnvironment = path.join(fixture.root, "hook-environment.txt");
    const hooksRoot = git(fixture.checkoutA, ["rev-parse", "--git-path", "hooks"]).trim();
    const hooksPath = path.isAbsolute(hooksRoot) ? hooksRoot : path.join(fixture.checkoutA, hooksRoot);
    writeFile(path.join(hooksPath, "pre-push"), `#!/bin/sh\nenv > ${JSON.stringify(hookEnvironment)}\nexit 99\n`);
    fs.chmodSync(path.join(hooksPath, "pre-push"), 0o700);
    const hostileEnvironment = [
      "CURL_CA_BUNDLE",
      "CURL_HOME",
      "CURL_SSL_BACKEND",
      "OPENSSL_CONF",
      "OPENSSL_CONF_INCLUDE",
      "OPENSSL_ENGINES",
      "OPENSSL_MODULES",
      "QLOGDIR",
      "SSL_CERT_DIR",
      "SSL_CERT_FILE",
      "SSLKEYLOGFILE"
    ];
    const previous = new Map<string, string | undefined>();
    for (const name of ["ULTRAFUZZ_HISTORY_CAS_TEST_CAPTURE_CHILD_ENV", ...hostileEnvironment]) {
      previous.set(name, process.env[name]);
    }
    process.env.ULTRAFUZZ_HISTORY_CAS_TEST_CAPTURE_CHILD_ENV = childEnvironment;
    for (const name of hostileEnvironment) process.env[name] = "publisher-secret-value";
    try {
      const published = publishEvalHistoryGeneration({
        ...publisherInput(fixture.checkoutA, generation, inputRoot),
        publisherToken: "publisher-secret-value"
      });
      expect(published.published).toBe(true);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    expect(JSON.parse(fs.readFileSync(childEnvironment, "utf8"))).toEqual({});
    expect(fs.existsSync(hookEnvironment)).toBe(false);
  });

  it("authenticates every remote refresh with redacted publisher authority", () => {
    const fixture = createRepositoryFixture();
    const inputRoot = path.join(fixture.root, "inputs");
    const candidateCommit = git(fixture.checkoutA, ["rev-parse", "HEAD"]).trim();
    writeEvalRun(inputRoot, "run-fetch-authority", "observation-fetch-authority", candidateCommit);
    const generation = writeGeneration(
      fixture.root,
      "generation-fetch-authority.json",
      ["run-fetch-authority"],
      candidateCommit
    );
    const capture = path.join(fixture.root, "fetch-environments.jsonl");
    const wrapperDirectory = path.join(fixture.root, "git-wrapper");
    const wrapper = path.join(wrapperDirectory, "git");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFile(
      wrapper,
      `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "fetch") {
  const count = Number(process.env.GIT_CONFIG_COUNT ?? "0");
  const config = [];
  for (let index = 0; index < count; index += 1) {
    config.push([process.env[\`GIT_CONFIG_KEY_\${index}\`], process.env[\`GIT_CONFIG_VALUE_\${index}\`]]);
  }
  fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ args, config }) + "\\n");
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { env: process.env, stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`
    );
    fs.chmodSync(wrapper, 0o700);
    const publisherToken = "publisher-secret-value";
    const expectedAuthorization = `AUTHORIZATION: basic ${Buffer.from(
      `x-access-token:${publisherToken}`,
      "utf8"
    ).toString("base64")}`;
    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperDirectory}${path.delimiter}${previousPath ?? ""}`;
    try {
      const published = publishEvalHistoryGeneration({
        ...publisherInput(fixture.checkoutA, generation, inputRoot),
        publisherToken
      });
      expect(published.published).toBe(true);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    const fetches = fs
      .readFileSync(capture, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; config: Array<[string | undefined, string | undefined]> });
    expect(fetches.length).toBeGreaterThanOrEqual(2);
    for (const fetch of fetches) {
      expect(fetch.args.join(" ")).not.toContain(publisherToken);
      expect(fetch.config).toContainEqual(["http.https://github.com/.extraheader", expectedAuthorization]);
    }
  });

  it("rejects origin mutation after CLI processing before any authorized push", () => {
    const fixture = createRepositoryFixture();
    const attacker = path.join(fixture.root, "attacker.git");
    git(fixture.root, ["init", "--bare", "--initial-branch=main", attacker]);
    const inputRoot = path.join(fixture.root, "inputs");
    const candidateCommit = git(fixture.checkoutA, ["rev-parse", "HEAD"]).trim();
    writeEvalRun(inputRoot, "run-origin", "observation-origin", candidateCommit);
    const generation = writeGeneration(fixture.root, "generation-origin.json", ["run-origin"], candidateCommit);
    const childEnvironment = path.join(fixture.root, "origin-child-environment.json");
    const previousOrigin = process.env.ULTRAFUZZ_HISTORY_CAS_TEST_MUTATE_ORIGIN;
    const previousCapture = process.env.ULTRAFUZZ_HISTORY_CAS_TEST_CAPTURE_CHILD_ENV;
    process.env.ULTRAFUZZ_HISTORY_CAS_TEST_MUTATE_ORIGIN = attacker;
    process.env.ULTRAFUZZ_HISTORY_CAS_TEST_CAPTURE_CHILD_ENV = childEnvironment;
    try {
      expect(() =>
        publishEvalHistoryGeneration({
          ...publisherInput(fixture.checkoutA, generation, inputRoot),
          publisherToken: "publisher-secret-value"
        })
      ).toThrow(/origin URL changed after trusted checkout/u);
    } finally {
      if (previousOrigin === undefined) delete process.env.ULTRAFUZZ_HISTORY_CAS_TEST_MUTATE_ORIGIN;
      else process.env.ULTRAFUZZ_HISTORY_CAS_TEST_MUTATE_ORIGIN = previousOrigin;
      if (previousCapture === undefined) delete process.env.ULTRAFUZZ_HISTORY_CAS_TEST_CAPTURE_CHILD_ENV;
      else process.env.ULTRAFUZZ_HISTORY_CAS_TEST_CAPTURE_CHILD_ENV = previousCapture;
    }
    expect(JSON.parse(fs.readFileSync(childEnvironment, "utf8"))).toEqual({});
    expect(gitStatus(attacker, ["show-ref", "--verify", TARGET_REF])).not.toBe(0);
  });

  it("requires publisher authority for a canonical GitHub publication", () => {
    const fixture = createRepositoryFixture();
    const inputRoot = path.join(fixture.root, "inputs");
    const candidateCommit = git(fixture.checkoutA, ["rev-parse", "HEAD"]).trim();
    writeEvalRun(inputRoot, "run-token", "observation-token", candidateCommit);
    const generation = writeGeneration(fixture.root, "generation-token.json", ["run-token"], candidateCommit);
    git(fixture.checkoutA, ["remote", "set-url", "origin", "https://github.com/monad-developers/ultrafuzz.git"]);

    expect(() =>
      publishEvalHistoryGeneration({
        generationPath: generation,
        inputRoot,
        repositoryRoot: fixture.checkoutA,
        expectedGenerationSha256: sha256(fs.readFileSync(generation))
      })
    ).toThrow(/requires a publisher token/u);
  });

  it("ignores hostile inherited global Git transport configuration", () => {
    const fixture = createRepositoryFixture();
    const attacker = path.join(fixture.root, "global-attacker.git");
    git(fixture.root, ["init", "--bare", "--initial-branch=main", attacker]);
    const hostileConfig = path.join(fixture.root, "hostile-global.gitconfig");
    writeFile(hostileConfig, `[url ${JSON.stringify(attacker)}]\n\tinsteadOf = ${fixture.bare}\n`);
    const inputRoot = path.join(fixture.root, "inputs");
    const candidateCommit = git(fixture.checkoutA, ["rev-parse", "HEAD"]).trim();
    writeEvalRun(inputRoot, "run-global", "observation-global", candidateCommit);
    const generation = writeGeneration(fixture.root, "generation-global.json", ["run-global"], candidateCommit);
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = hostileConfig;
    try {
      const published = publishEvalHistoryGeneration(publisherInput(fixture.checkoutA, generation, inputRoot));
      expect(published.published).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
    expect(gitStatus(attacker, ["show-ref", "--verify", TARGET_REF])).not.toBe(0);
  });

  it("rejects hostile local HTTP and include transport configuration", () => {
    for (const kind of ["http", "include"] as const) {
      const fixture = createRepositoryFixture();
      const inputRoot = path.join(fixture.root, "inputs");
      const candidateCommit = git(fixture.checkoutA, ["rev-parse", "HEAD"]).trim();
      writeEvalRun(inputRoot, `run-local-${kind}`, `observation-local-${kind}`, candidateCommit);
      const generation = writeGeneration(
        fixture.root,
        `generation-local-${kind}.json`,
        [`run-local-${kind}`],
        candidateCommit
      );
      if (kind === "http") {
        git(fixture.checkoutA, ["config", "http.curloptResolve", "+github.com:443:127.0.0.1"]);
      } else {
        const included = path.join(fixture.root, "included-transport.gitconfig");
        writeFile(included, "[http]\n\tsslVerify = false\n");
        git(fixture.checkoutA, ["config", "include.path", included]);
      }

      expect(() =>
        publishEvalHistoryGeneration({
          ...publisherInput(fixture.checkoutA, generation, inputRoot),
          publisherToken: "publisher-secret-value"
        })
      ).toThrow(/unsafe transport configuration/u);
    }
  });

  it("rejects hostile linked-worktree HTTP configuration created by the history CLI", () => {
    const fixture = createRepositoryFixture();
    const inputRoot = path.join(fixture.root, "inputs");
    const candidateCommit = git(fixture.checkoutA, ["rev-parse", "HEAD"]).trim();
    writeEvalRun(inputRoot, "run-worktree-http", "observation-worktree-http", candidateCommit);
    const generation = writeGeneration(
      fixture.root,
      "generation-worktree-http.json",
      ["run-worktree-http"],
      candidateCommit
    );
    const previous = process.env.ULTRAFUZZ_HISTORY_CAS_TEST_MUTATE_WORKTREE_HTTP;
    process.env.ULTRAFUZZ_HISTORY_CAS_TEST_MUTATE_WORKTREE_HTTP = "1";
    try {
      expect(() =>
        publishEvalHistoryGeneration({
          ...publisherInput(fixture.checkoutA, generation, inputRoot),
          publisherToken: "publisher-secret-value"
        })
      ).toThrow(/unsafe transport configuration: http.sslverify/u);
    } finally {
      if (previous === undefined) delete process.env.ULTRAFUZZ_HISTORY_CAS_TEST_MUTATE_WORKTREE_HTTP;
      else process.env.ULTRAFUZZ_HISTORY_CAS_TEST_MUTATE_WORKTREE_HTTP = previous;
    }
  });

  it("rejects source or publication-tooling advancement beyond the tooling checkout", () => {
    const fixture = createRepositoryFixture();
    const inputRoot = path.join(fixture.root, "inputs");
    const candidateCommit = git(fixture.checkoutB, ["rev-parse", "HEAD"]).trim();
    writeEvalRun(inputRoot, "run-a", "observation-a", candidateCommit);
    const generation = writeGeneration(fixture.root, "generation.json", ["run-a"], candidateCommit);

    writeFile(
      path.join(fixture.checkoutA, "scripts", "ci", "publish-eval-history-cas.mjs"),
      "// Advanced publication tooling.\n"
    );
    git(fixture.checkoutA, ["add", "scripts/ci/publish-eval-history-cas.mjs"]);
    git(fixture.checkoutA, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "-m",
      "Advance publication tooling"
    ]);
    git(fixture.checkoutA, ["push", "origin", `HEAD:${TARGET_REF}`]);
    const advancedTarget = git(fixture.bare, ["rev-parse", TARGET_REF]).trim();

    expect(() =>
      publishEvalHistoryGeneration({
        generationPath: generation,
        inputRoot,
        repositoryRoot: fixture.checkoutB,
        expectedGenerationSha256: sha256(fs.readFileSync(generation)),
        testOnlyPublicationRemoteUrl: fixture.bare
      })
    ).toThrow(
      /publication base advancement since the tooling checkout contains unexpected paths: "scripts\/ci\/publish-eval-history-cas\.mjs"/u
    );
    expect(git(fixture.bare, ["rev-parse", TARGET_REF]).trim()).toBe(advancedTarget);
    expect(git(fixture.bare, ["show", `${TARGET_REF}:benchmarks/history.json`])).not.toContain("observation-a");
  });

  it("rejects non-canonical generation paths and URLs", () => {
    const valid = {
      schema_version: EVAL_HISTORY_PUBLICATION_GENERATION_SCHEMA_VERSION,
      candidate_commit: "a".repeat(40),
      candidate_repository_url: "https://github.com/monad-developers/ultrafuzz",
      source_artifact: "https://github.com/monad-developers/ultrafuzz/actions/runs/123",
      runs: [
        {
          eval_run_id: "run-a",
          benchmark: "evmbench",
          lane: "smoke",
          status: "succeeded",
          input_path: "runs/run-a",
          bundle_sha256: "b".repeat(64),
          publication_tree_sha256: "c".repeat(64),
          target_ids: ["target-a"],
          observation_ids: ["run-a:target-a:variant:profile"],
          executed_case_count: 1,
          graded_case_count: 1,
          publication_url: "https://github.com/monad-developers/ultrafuzz/actions/runs/123/artifacts"
        }
      ]
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
          bundle_sha256: "b".repeat(64),
          publication_tree_sha256: "c".repeat(64),
          target_ids: ["very-liquid-vaults-foundry", "venus-isolated-pools-hardhat", "stableswap-ng-vyper"],
          observation_ids: [
            "run-a:very-liquid-vaults-foundry:variant:profile",
            "run-a:venus-isolated-pools-hardhat:variant:profile",
            "run-a:stableswap-ng-vyper:variant:profile"
          ],
          executed_case_count: 3,
          graded_case_count: 3,
          publication_url: "https://github.com/monad-developers/ultrafuzz/actions/runs/123/artifacts"
        }
      ]
    };
    expect(parseEvalHistoryPublicationGeneration(valid).runs[0]).toMatchObject({
      status: "succeeded",
      target_ids: ["very-liquid-vaults-foundry", "venus-isolated-pools-hardhat", "stableswap-ng-vyper"],
      observation_ids: [
        "run-a:very-liquid-vaults-foundry:variant:profile",
        "run-a:venus-isolated-pools-hardhat:variant:profile",
        "run-a:stableswap-ng-vyper:variant:profile"
      ],
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
        repositoryRoot: fixture.checkoutA,
        expectedGenerationSha256: sha256(fs.readFileSync(generation)),
        testOnlyPublicationRemoteUrl: fixture.bare
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

function createHandoffFixture(): {
  handoff: string;
  generation: string;
  inputRoot: string;
  candidateCommit: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-history-handoff-test-"));
  temporaryRoots.push(root);
  const handoff = path.join(root, "handoff");
  const inputRoot = path.join(handoff, "unpacked");
  const candidateCommit = "a".repeat(40);
  fs.mkdirSync(inputRoot, { recursive: true });
  writeEvalRun(inputRoot, "run-handoff", "observation-handoff", candidateCommit);
  const generation = writeGeneration(handoff, "generation.json", ["run-handoff"], candidateCommit, inputRoot);
  return { handoff, generation, inputRoot, candidateCommit };
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

function installPostPushMainAdvancementHook(bare: string): void {
  const hook = path.join(bare, "hooks", "post-receive");
  writeFile(
    hook,
    String.raw`#!/bin/sh
set -eu

marker="$(git rev-parse --git-dir)/hooks/post-receive-advanced"
while read -r _old_rev new_rev ref_name; do
  if [ "$ref_name" != "refs/heads/main" ] || [ -e "$marker" ]; then
    continue
  fi
  index_file="$(mktemp)"
  rm -f "$index_file"
  trap 'rm -f "$index_file"' EXIT HUP INT TERM
  GIT_INDEX_FILE="$index_file" git read-tree "$new_rev"
  blob_oid="$(printf '%s\n' 'advanced after successful publication push' | git hash-object -w --stdin)"
  GIT_INDEX_FILE="$index_file" git update-index --add --cacheinfo 100644 "$blob_oid" post-push-advancement.txt
  tree_oid="$(GIT_INDEX_FILE="$index_file" git write-tree)"
  commit_oid="$(printf '%s\n' 'Advance main after publication push' | env \
    GIT_AUTHOR_NAME=Fixture \
    GIT_AUTHOR_EMAIL=fixture@example.com \
    GIT_COMMITTER_NAME=Fixture \
    GIT_COMMITTER_EMAIL=fixture@example.com \
    git commit-tree "$tree_oid" -p "$new_rev")"
  git update-ref "$ref_name" "$commit_oid" "$new_rev"
  : > "$marker"
done
`
  );
  fs.chmodSync(hook, 0o700);
}

function installFixtureCli(checkout: string): void {
  writeFile(
    path.join(checkout, "packages", "cli", "dist", "index.js"),
    String.raw`import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const overviewCharts = [
  "latest-summary.svg",
  "quality.svg",
  "performance-cost.svg"
];
const metricCharts = [
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
const captureEnvironment = process.env.ULTRAFUZZ_HISTORY_CAS_TEST_CAPTURE_CHILD_ENV;
if (captureEnvironment !== undefined) {
  const forbiddenTransportEnvironment = new Set([
    "CURL_CA_BUNDLE",
    "CURL_HOME",
    "CURL_SSL_BACKEND",
    "OPENSSL_CONF",
    "OPENSSL_CONF_INCLUDE",
    "OPENSSL_ENGINES",
    "OPENSSL_MODULES",
    "QLOGDIR",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "SSLKEYLOGFILE"
  ]);
  const authority = Object.fromEntries(
    Object.entries(process.env).filter(([name, value]) =>
      name === "PUBLISHER_TOKEN" ||
      name === "GH_TOKEN" ||
      name === "GITHUB_TOKEN" ||
      name === "GIT_ASKPASS" ||
      name === "GIT_SSH" ||
      name === "GIT_SSH_COMMAND" ||
      forbiddenTransportEnvironment.has(name) ||
      value.includes("publisher-secret-value")
    )
  );
  fs.writeFileSync(captureEnvironment, JSON.stringify(authority));
}
const mutatedOrigin = process.env.ULTRAFUZZ_HISTORY_CAS_TEST_MUTATE_ORIGIN;
if (mutatedOrigin !== undefined) execFileSync("git", ["config", "remote.origin.url", mutatedOrigin], { cwd: project });
if (process.env.ULTRAFUZZ_HISTORY_CAS_TEST_MUTATE_WORKTREE_HTTP === "1") {
  execFileSync("git", ["config", "extensions.worktreeConfig", "true"], { cwd: project });
  execFileSync("git", ["config", "--worktree", "http.sslVerify", "false"], { cwd: project });
}

function expectedCharts(history) {
  const ids = history.observations.map((entry) => entry.id).sort();
  const overviewIds = history.observations
    .filter((entry) => entry.benchmark === "ultrafuzz-bench")
    .map((entry) => entry.id)
    .sort();
  return new Map([
    ...overviewCharts.map((file) => [file, file + ":" + overviewIds.join(",") + "\n"]),
    ...metricCharts.map((file) => [file, file + ":" + ids.join(",") + "\n"])
  ]);
}

function selectedCharts(history) {
  const expected = expectedCharts(history);
  if (process.env.ULTRAFUZZ_HISTORY_CAS_TEST_SUBSET_CHARTS === "1") expected.delete("cost.svg");
  return expected;
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
  for (const observation of run.observations) {
    if (!history.observations.some((entry) => entry.id === observation.id)) {
      history.observations.push(observation);
    }
  }
  history.observations.sort((left, right) => left.id.localeCompare(right.id));
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2) + "\n");
  fs.mkdirSync(chartsRoot, { recursive: true });
  for (const [file, contents] of selectedCharts(history)) fs.writeFileSync(path.join(chartsRoot, file), contents);
  process.exit(0);
}

const history = JSON.parse(fs.readFileSync(historyPath, "utf8"));
if (args.includes("--check")) {
  for (const [file, contents] of selectedCharts(history)) {
    if (fs.readFileSync(path.join(chartsRoot, file), "utf8") !== contents) throw new Error("stale fixture chart " + file);
  }
} else {
  fs.mkdirSync(chartsRoot, { recursive: true });
  for (const [file, contents] of selectedCharts(history)) fs.writeFileSync(path.join(chartsRoot, file), contents);
}
`
  );
}

function writeEvalRun(
  inputRoot: string,
  evalRunId: string,
  observationIds: string | string[],
  candidateCommit: string,
  benchmark: "evmbench" | "ultrafuzz-bench" = "evmbench"
): void {
  const ids = Array.isArray(observationIds) ? observationIds : [observationIds];
  writeFile(
    path.join(inputRoot, evalRunId, "eval", "eval.json"),
    `${JSON.stringify(
      {
        eval_run_id: evalRunId,
        provenance: { candidate: { commit: candidateCommit } },
        observations: ids.map((id, index) =>
          fixtureObservation(evalRunId, id, `target-${index + 1}`, candidateCommit, benchmark)
        )
      },
      null,
      2
    )}\n`
  );
  writeFile(
    path.join(inputRoot, evalRunId, "eval", "summary.json"),
    `${JSON.stringify({ eval_run_id: evalRunId, score_revision: 1 }, null, 2)}\n`
  );
}

function writeGeneration(
  root: string,
  file: string,
  evalRunIds: string[],
  candidateCommit: string,
  inputRoot = path.join(root, "inputs")
): string {
  const generationPath = path.join(root, file);
  const runs = evalRunIds.map((evalRunId) => {
    const inputPath = path.join(inputRoot, evalRunId);
    const evalManifest = JSON.parse(fs.readFileSync(path.join(inputPath, "eval", "eval.json"), "utf8")) as {
      observations: Array<ReturnType<typeof fixtureObservation>>;
    };
    return {
      eval_run_id: evalRunId,
      benchmark: evalManifest.observations[0]!.benchmark,
      lane: "smoke",
      status: "succeeded",
      input_path: evalRunId,
      bundle_sha256: sha256(Buffer.from(`bundle:${evalRunId}`, "utf8")),
      publication_tree_sha256: publicationTreeDigest(inputPath),
      target_ids: evalManifest.observations.map((observation) => observation.target),
      observation_ids: evalManifest.observations.map((observation) => observation.id),
      executed_case_count: evalManifest.observations.length,
      graded_case_count: evalManifest.observations.length,
      publication_url: "https://github.com/monad-developers/ultrafuzz/actions/runs/123/artifacts"
    };
  });
  writeFile(
    generationPath,
    `${JSON.stringify(
      {
        schema_version: EVAL_HISTORY_PUBLICATION_GENERATION_SCHEMA_VERSION,
        candidate_commit: candidateCommit,
        candidate_repository_url: "https://github.com/monad-developers/ultrafuzz",
        source_artifact: "https://github.com/monad-developers/ultrafuzz/actions/runs/123",
        runs
      },
      null,
      2
    )}\n`
  );
  return generationPath;
}

function fixtureObservation(
  evalRunId: string,
  id: string,
  target: string,
  candidateCommit: string,
  benchmark: "evmbench" | "ultrafuzz-bench"
) {
  return {
    id,
    source_eval_run_id: evalRunId,
    source_artifact: "https://github.com/monad-developers/ultrafuzz/actions/runs/123",
    target,
    candidate_commit: candidateCommit,
    benchmark,
    lane: "smoke",
    status: "succeeded",
    executed_case_count: 1,
    graded_case_count: 1,
    publication_url: "https://github.com/monad-developers/ultrafuzz/actions/runs/123/artifacts"
  };
}

function appendFixtureHistoryObservation(root: string, observationId: string, evalRunId: string): void {
  const historyPath = path.join(root, "benchmarks", "history.json");
  const history = JSON.parse(fs.readFileSync(historyPath, "utf8")) as {
    observations: Array<{ id: string; source_eval_run_id: string; benchmark: "evmbench" }>;
  };
  history.observations.push({ id: observationId, source_eval_run_id: evalRunId, benchmark: "evmbench" });
  history.observations.sort((left, right) => left.id.localeCompare(right.id));
  fs.writeFileSync(historyPath, `${JSON.stringify(history, null, 2)}\n`, "utf8");
  writeFixtureCharts(root, history.observations);
}

function appendFixtureHistoryValue(root: string, observation: ReturnType<typeof fixtureObservation>): void {
  const historyPath = path.join(root, "benchmarks", "history.json");
  const history = JSON.parse(fs.readFileSync(historyPath, "utf8")) as {
    observations: Array<ReturnType<typeof fixtureObservation>>;
  };
  history.observations.push(observation);
  history.observations.sort((left, right) => left.id.localeCompare(right.id));
  fs.writeFileSync(historyPath, `${JSON.stringify(history, null, 2)}\n`, "utf8");
  writeFixtureCharts(root, history.observations);
}

function writeFixtureCharts(
  root: string,
  observations: Array<{ id: string; benchmark?: "evmbench" | "ultrafuzz-bench" }>
): void {
  const ids = observations.map((entry) => entry.id).sort();
  const overviewIds = observations
    .filter((entry) => entry.benchmark === "ultrafuzz-bench")
    .map((entry) => entry.id)
    .sort();
  for (const chart of OVERVIEW_CHARTS) {
    writeFile(path.join(root, "docs", "assets", "eval-history", chart), `${chart}:${overviewIds.join(",")}\n`);
  }
  for (const chart of METRIC_CHARTS) {
    writeFile(path.join(root, "docs", "assets", "eval-history", chart), `${chart}:${ids.join(",")}\n`);
  }
}

function publisherInput(repositoryRoot: string, generationPath: string, inputRoot: string) {
  return {
    generationPath,
    inputRoot,
    repositoryRoot,
    expectedGenerationSha256: sha256(fs.readFileSync(generationPath)),
    testOnlyPublicationRemoteUrl: git(repositoryRoot, ["remote", "get-url", "origin"]).trim()
  };
}

async function invokePublisher(
  checkout: string,
  generationPath: string,
  inputRoot: string,
  barrier?: string
): Promise<PublisherResult> {
  const child = Bun.spawn(
    ["node", SCRIPT, generationPath, inputRoot, checkout, sha256(fs.readFileSync(generationPath))],
    {
      cwd: checkout,
      env: {
        ...process.env,
        ULTRAFUZZ_HISTORY_CAS_TEST_LOCAL_REMOTE: git(checkout, ["remote", "get-url", "origin"]).trim(),
        ...(barrier === undefined ? {} : { ULTRAFUZZ_HISTORY_CAS_TEST_BARRIER: barrier })
      },
      stdout: "pipe",
      stderr: "pipe"
    }
  );
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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
