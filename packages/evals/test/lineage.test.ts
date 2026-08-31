import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildEvalRunProvenance, buildScoringProvenance } from "../src/lineage.js";
import type { EvalPlanValue } from "../src/types.js";
import { testRow, testSuite } from "./helpers.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initializeRepository(directory: string, tag?: string): string {
  fs.mkdirSync(directory, { recursive: true });
  git(directory, ["init", "--initial-branch=main"]);
  git(directory, ["config", "user.name", "Eval Fixture"]);
  git(directory, ["config", "user.email", "eval-fixture@example.invalid"]);
  fs.writeFileSync(path.join(directory, "tracked.txt"), "initial\n", "utf8");
  git(directory, ["add", "tracked.txt"]);
  git(directory, ["commit", "-m", "Initial fixture"]);
  if (tag !== undefined) {
    git(directory, ["tag", tag]);
  }
  return git(directory, ["rev-parse", "HEAD"]);
}

function commitChange(directory: string, contents: string, tag?: string): string {
  fs.writeFileSync(path.join(directory, "tracked.txt"), contents, "utf8");
  git(directory, ["add", "tracked.txt"]);
  git(directory, ["commit", "-m", "Update fixture"]);
  if (tag !== undefined) {
    git(directory, ["tag", tag]);
  }
  return git(directory, ["rev-parse", "HEAD"]);
}

function writeGroundTruth(filePath: string, bugIds: string[] = []): void {
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({
      schema_version: "ultrafuzz.eval-ground-truth.v1",
      bugs: bugIds.map((id) => ({ id }))
    })}\n`,
    "utf8"
  );
}

function fixture(): { plan: EvalPlanValue; candidateRoot: string; targetRoot: string; groundTruthPath: string } {
  const base = mkdtempSync(path.join(fs.realpathSync(tmpdir()), "ufz-eval-lineage-"));
  const candidateRoot = path.join(base, "candidate");
  const targetRoot = path.join(base, "target");
  const groundTruthRoot = path.join(base, "ground-truth");
  initializeRepository(candidateRoot, "v0.0.1");
  const targetCommit = initializeRepository(targetRoot);
  fs.mkdirSync(groundTruthRoot, { recursive: true });
  const groundTruthPath = path.join(groundTruthRoot, "target-a.yml");
  writeGroundTruth(groundTruthPath);
  const suite = testSuite(groundTruthRoot, {
    targets: [
      {
        id: "target-a",
        repo: "https://example.com/generated-target",
        ref: targetCommit,
        path: targetRoot,
        ground_truth: "target-a.yml"
      }
    ]
  });
  const row = testRow(suite, {
    target: {
      ...suite.targets[0]!,
      path: targetRoot,
      ground_truth_path: groundTruthPath
    }
  });
  return {
    plan: { suite_path: "generated-suite.yml", project_root: candidateRoot, suite, matrix: [row] },
    candidateRoot,
    targetRoot,
    groundTruthPath
  };
}

describe("versioned eval lineage", { timeout: 15_000 }, () => {
  it("keeps the cohort stable across candidate releases and changes it for comparison controls", () => {
    const generated = fixture();
    const policy = { watch: true, watchTimeoutSeconds: 120, pollIntervalMs: 10 };
    const first = buildEvalRunProvenance(generated.plan, policy);
    expect(first.candidate).toMatchObject({ label: "v0.0.1", dirty: false });
    expect(first.candidate.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(first.benchmark.targets[0]?.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(first.benchmark.cohort_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(first.benchmark.execution_policy.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);

    commitChange(generated.candidateRoot, "candidate v2\n", "v0.0.2");
    const nextCandidate = buildEvalRunProvenance(generated.plan, policy);
    expect(nextCandidate.candidate.label).toBe("v0.0.2");
    expect(nextCandidate.candidate.commit).not.toBe(first.candidate.commit);
    expect(nextCandidate.benchmark.cohort_fingerprint).toBe(first.benchmark.cohort_fingerprint);

    writeGroundTruth(generated.groundTruthPath, ["GENERATED-1"]);
    const changedGroundTruth = buildEvalRunProvenance(generated.plan, policy);
    expect(changedGroundTruth.benchmark.cohort_fingerprint).not.toBe(first.benchmark.cohort_fingerprint);

    writeGroundTruth(generated.groundTruthPath);
    commitChange(generated.targetRoot, "target v2\n");
    const changedTarget = buildEvalRunProvenance(generated.plan, policy);
    expect(changedTarget.benchmark.cohort_fingerprint).not.toBe(first.benchmark.cohort_fingerprint);

    fs.writeFileSync(path.join(generated.targetRoot, "tracked.txt"), "dirty target\n", "utf8");
    const dirtyTarget = buildEvalRunProvenance(generated.plan, policy);
    expect(dirtyTarget.benchmark).toMatchObject({
      availability: "available",
      targets: [{ id: "target-a", dirty: true }]
    });
    expect(dirtyTarget.benchmark.cohort_fingerprint).not.toBe(changedTarget.benchmark.cohort_fingerprint);
    fs.writeFileSync(path.join(generated.targetRoot, "tracked.txt"), "target v2\n", "utf8");

    const changedPolicy = buildEvalRunProvenance(generated.plan, { ...policy, watchTimeoutSeconds: 121 });
    expect(changedPolicy.benchmark.execution_policy.fingerprint).not.toBe(first.benchmark.execution_policy.fingerprint);
    expect(changedPolicy.benchmark.cohort_fingerprint).not.toBe(changedTarget.benchmark.cohort_fingerprint);
  });

  it("tracks candidate dirtiness outside the stable cohort and versions scoring separately", () => {
    const generated = fixture();
    const clean = buildEvalRunProvenance(generated.plan, { watch: false });
    const cleanScoring = buildScoringProvenance({
      projectRoot: generated.candidateRoot,
      suite: generated.plan.suite,
      matrix: generated.plan.matrix
    });
    const llmScoring = buildScoringProvenance({
      projectRoot: generated.candidateRoot,
      suite: generated.plan.suite,
      matrix: generated.plan.matrix,
      judgeMode: "llm"
    });
    expect(llmScoring.fingerprint).not.toBe(cleanScoring.fingerprint);
    const panelScoring = buildScoringProvenance({
      projectRoot: generated.candidateRoot,
      suite: { ...generated.plan.suite, judge_panel: { total: 4, quorum: 3 } },
      matrix: generated.plan.matrix,
      judgeMode: "llm"
    });
    expect(panelScoring).toMatchObject({ judge_panel: { total: 4, quorum: 3 } });
    expect(panelScoring.fingerprint).not.toBe(llmScoring.fingerprint);
    fs.writeFileSync(path.join(generated.candidateRoot, "scratch.log"), "local scratch\n", "utf8");
    const untracked = buildEvalRunProvenance(generated.plan, { watch: false });
    expect(untracked.candidate).toMatchObject({
      dirty: false,
      execution_artifact_id: clean.candidate.execution_artifact_id
    });
    fs.rmSync(path.join(generated.candidateRoot, "scratch.log"));

    writeGroundTruth(generated.groundTruthPath, ["GENERATED-2"]);
    const rescoredGroundTruth = buildScoringProvenance({
      projectRoot: generated.candidateRoot,
      suite: generated.plan.suite,
      matrix: generated.plan.matrix
    });
    expect(rescoredGroundTruth.fingerprint).not.toBe(cleanScoring.fingerprint);
    writeGroundTruth(generated.groundTruthPath);

    fs.writeFileSync(path.join(generated.candidateRoot, "tracked.txt"), "dirty candidate\n", "utf8");
    const dirty = buildEvalRunProvenance(generated.plan, { watch: false });
    const dirtyScoring = buildScoringProvenance({
      projectRoot: generated.candidateRoot,
      suite: generated.plan.suite,
      matrix: generated.plan.matrix
    });

    expect(dirty.candidate.dirty).toBe(true);
    expect(dirty.candidate.execution_artifact_id).toBeUndefined();
    expect(dirty.benchmark.cohort_fingerprint).toBe(clean.benchmark.cohort_fingerprint);
    expect(dirtyScoring.fingerprint).not.toBe(cleanScoring.fingerprint);
    expect(cleanScoring).toMatchObject({
      judge_mode: "deterministic",
      judge_prompt_version: "ultrafuzz-eval-judge-v10-registered-result-schema",
      judge_models: ["gpt-5.5"],
      judge_panel: { total: 3, quorum: 2 },
      ground_truth_sha256: { "target-a": expect.stringMatching(/^sha256:/u) }
    });
  });
});
