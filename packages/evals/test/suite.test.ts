import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadEvalSuite, planEvalSuite } from "../src/suite.js";
import { EvalError } from "../src/utils.js";

const SUITE_YAML = `
schema_version: ultrafuzz.eval.v1
suite: bug-finding-regression

model_profiles:
  eval-runner: { agent: CodexAgent, model: gpt-5.4-mini, reasoning: high }
  eval-judge: { agent: CodexAgent, model: gpt-5.5, reasoning: xhigh }

targets:
  - id: aave-v4
    repo: https://github.com/aave/aave-v4
    ref: v0.5.6
    sensitivity: private
    ground_truth: aave-v4.yml
  - id: very-liquid-vaults
    repo: https://github.com/rheo-xyz/very-liquid-vaults
    ref: e50384709a696c86ab0440bbbc3dd14a5f4ff6ec
    sensitivity: private
    ground_truth: very-liquid-vaults.yml

variants:
  - id: baseline

run:
  runner_model_profile: eval-runner
  judge_model_profile: eval-judge
  trials_per_variant: 10
  max_parallel_targets: 2
  max_parallel_runs: 8

metrics:
  primary: [precision, recall, f1_score]
  recall_threshold: 0.7

reporting:
  node_telemetry: true
  heartbeat_interval_seconds: 60
  experiment_prefix: bug-finding
  artifacts:
    mode: manifest-only
    include: ["report.md", "report.json", "findings.normalized.json"]
    max_file_bytes: 5000000
`;

function setup(): { projectRoot: string; groundTruthRoot: string; suitePath: string } {
  const base = mkdtempSync(path.join(tmpdir(), "ufz-evals-suite-"));
  const projectRoot = path.join(base, "project");
  const groundTruthRoot = path.join(base, "ground-truth");
  fs.mkdirSync(path.join(projectRoot, ".ultrafuzz", "evals"), { recursive: true });
  fs.mkdirSync(groundTruthRoot, { recursive: true });
  const suitePath = path.join(projectRoot, ".ultrafuzz", "evals", "bug-finding.yml");
  fs.writeFileSync(suitePath, SUITE_YAML, "utf8");
  return { projectRoot, groundTruthRoot, suitePath };
}

describe("eval suite loading and planning", () => {
  it("loads the issue-shaped suite YAML with no provider references", () => {
    const { projectRoot, suitePath } = setup();
    const { suite } = loadEvalSuite({ projectRoot, suitePath });
    expect(suite.suite).toBe("bug-finding-regression");
    expect(suite.reporting.node_telemetry).toBe(true);
    expect(suite.reporting.heartbeat_interval_seconds).toBe(60);
    expect(suite.reporting.experiment_prefix).toBe("bug-finding");
    expect(suite.reporting.artifacts.mode).toBe("manifest-only");
    expect(suite.reporting.artifacts.mode_explicit).toBe(true);
    // The YAML is provider-agnostic: no provider, endpoint, or env var names.
    expect(JSON.stringify(suite)).not.toMatch(/braintrust|langsmith|api_key/iu);
  });

  it("defaults the reporting policy when the suite omits it", () => {
    const { projectRoot, suitePath } = setup();
    fs.writeFileSync(suitePath, SUITE_YAML.replace(/reporting:[\s\S]*$/u, ""), "utf8");
    const { suite } = loadEvalSuite({ projectRoot, suitePath });
    expect(suite.reporting).toMatchObject({
      node_telemetry: true,
      heartbeat_interval_seconds: 60,
      artifacts: {
        mode: "manifest-only",
        include: ["report.md", "report.json", "findings.normalized.json"],
        max_file_bytes: 5_000_000,
        mode_explicit: false
      }
    });
  });

  it("plans targets x variants x trials with the ground-truth root from ultrafuzz.toml", () => {
    const { projectRoot, groundTruthRoot, suitePath } = setup();
    const plan = planEvalSuite({
      projectRoot,
      suitePath,
      groundTruthRoot,
      validateTargets: false
    });
    expect(plan.matrix).toHaveLength(20); // 2 targets x 1 variant x 10 trials
    expect(plan.matrix[0]).toMatchObject({
      id: "aave-v4-baseline-trial-1",
      target_id: "aave-v4",
      variant_id: "baseline",
      trial_id: "trial-1",
      runner_model_profile: "eval-runner",
      judge_model_profile: "eval-judge",
      runner_model: "gpt-5.4-mini",
      judge_model: "gpt-5.5",
      runner_reasoning: "high",
      judge_reasoning: "xhigh"
    });
    expect(plan.matrix[0]?.target.ground_truth_path).toBe(path.join(groundTruthRoot, "aave-v4.yml"));
  });

  it("requires a ground-truth root for relative ground_truth paths", () => {
    const { projectRoot, suitePath } = setup();
    expect(() => planEvalSuite({ projectRoot, suitePath, validateTargets: false })).toThrowError(
      expect.objectContaining({ code: "EVAL_GROUND_TRUTH_ROOT_REQUIRED" })
    );
  });

  it("rejects ground truth that resolves inside the repository", () => {
    const { projectRoot, suitePath } = setup();
    expect(() =>
      planEvalSuite({
        projectRoot,
        suitePath,
        groundTruthRoot: path.join(projectRoot, "ground-truth"),
        validateTargets: false
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_GROUND_TRUTH_INSIDE_REPO" }));
  });

  it("rejects external aliases whose nearest existing ancestor resolves inside the repository", () => {
    const { projectRoot, suitePath } = setup();
    const projectAlias = path.join(path.dirname(projectRoot), "project-alias");
    fs.symlinkSync(projectRoot, projectAlias, process.platform === "win32" ? "junction" : "dir");

    expect(() =>
      planEvalSuite({
        projectRoot,
        suitePath,
        groundTruthRoot: path.join(projectAlias, "missing-ground-truth"),
        validateTargets: false
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_GROUND_TRUTH_INSIDE_REPO" }));
  });

  it("keeps ground-truth entries inside the configured root", () => {
    const { projectRoot, groundTruthRoot, suitePath } = setup();
    fs.writeFileSync(suitePath, SUITE_YAML.replace("ground_truth: aave-v4.yml", "ground_truth: ../other.yml"));
    expect(() => planEvalSuite({ projectRoot, suitePath, groundTruthRoot, validateTargets: false })).toThrowError(
      expect.objectContaining({ code: "EVAL_GROUND_TRUTH_OUTSIDE_ROOT" })
    );

    fs.writeFileSync(
      suitePath,
      SUITE_YAML.replace("ground_truth: aave-v4.yml", `ground_truth: ${path.join(groundTruthRoot, "aave-v4.yml")}`)
    );
    expect(() => planEvalSuite({ projectRoot, suitePath, groundTruthRoot, validateTargets: false })).toThrowError(
      expect.objectContaining({ code: "EVAL_GROUND_TRUTH_ABSOLUTE_PATH" })
    );
  });

  it("rejects symlinked ground-truth files", () => {
    const { projectRoot, groundTruthRoot, suitePath } = setup();
    const outside = path.join(path.dirname(groundTruthRoot), "outside.yml");
    fs.writeFileSync(outside, "bugs: []\n", "utf8");
    fs.symlinkSync(outside, path.join(groundTruthRoot, "aave-v4.yml"));
    expect(() => planEvalSuite({ projectRoot, suitePath, groundTruthRoot, validateTargets: false })).toThrowError(
      expect.objectContaining({ code: "EVAL_GROUND_TRUTH_UNSAFE" })
    );
  });

  it("rejects unknown model profiles", () => {
    const { projectRoot, groundTruthRoot, suitePath } = setup();
    fs.writeFileSync(
      suitePath,
      SUITE_YAML.replace("runner_model_profile: eval-runner", "runner_model_profile: nope"),
      "utf8"
    );
    try {
      planEvalSuite({ projectRoot, suitePath, groundTruthRoot, validateTargets: false });
      expect.unreachable("expected EVAL_MODEL_PROFILE_UNKNOWN");
    } catch (error) {
      expect(error).toBeInstanceOf(EvalError);
      expect((error as EvalError).code).toBe("EVAL_MODEL_PROFILE_UNKNOWN");
    }
  });
});
