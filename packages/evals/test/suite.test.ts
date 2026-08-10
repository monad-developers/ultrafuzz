import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { EVAL_SUITE_SCHEMA_ID, validateEvalJsonSchema } from "../src/eval-schema-registry.js";
import {
  DEFAULT_EVAL_JUDGE_PANEL,
  evalSuiteInputSchema,
  loadEvalSuite,
  planEvalSuite,
  resolveJudgePanelConfig
} from "../src/suite.js";
import { EvalError } from "../src/utils.js";

const SUITE_YAML = `
schema_version: ultrafuzz.eval.v2
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
  recall_threshold: 0.7

recovery_equivalence:
  max_repeated_model_executions: 1
  aggregate_non_comparable: separate
  publication: comparable

reporting:
  node_telemetry: true
  heartbeat_interval_seconds: 60
  experiment_prefix: bug-finding
  artifacts:
    mode: manifest-only
    include: ["report.md", "report.json"]
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

type SuiteDocument = Record<string, unknown>;

function suiteDocument(): SuiteDocument {
  return objectValue(parse(SUITE_YAML));
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object fixture");
  }
  return value as Record<string, unknown>;
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return objectValue(value[key]);
}

function firstObjectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const items = value[key];
  if (!Array.isArray(items) || items.length === 0) throw new Error(`expected nonempty ${key} fixture array`);
  return objectValue(items[0]);
}

function withWorkflowInput(workflowInput: unknown): SuiteDocument {
  const document = suiteDocument();
  document.variants = [{ id: "baseline", workflow_input: workflowInput }];
  return document;
}

function expectSchemaParity(document: unknown, expected: boolean): void {
  const jsonSchemaValid = validateEvalJsonSchema(EVAL_SUITE_SCHEMA_ID, document).ok;
  const zodValid = evalSuiteInputSchema.safeParse(document).success;
  expect({ jsonSchemaValid, zodValid }).toEqual({ jsonSchemaValid: expected, zodValid: expected });
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
    expect(suite.judge_panel).toBeUndefined();
    expect(suite.recovery_equivalence).toEqual({
      max_repeated_model_executions: 1,
      aggregate_non_comparable: "separate",
      publication: "comparable"
    });
    expect(resolveJudgePanelConfig(suite.judge_panel)).toEqual({ total: 3, quorum: 2 });
    expect(DEFAULT_EVAL_JUDGE_PANEL).toEqual({ total: 3, quorum: 2 });
    // The YAML is provider-agnostic: no provider, endpoint, or env var names.
    expect(JSON.stringify(suite)).not.toMatch(/braintrust|api_key/iu);
  });

  it.each([
    [1, 1],
    [4, 3]
  ])("loads an explicit %i-of-%i strict-majority judge panel", (total, quorum) => {
    const { projectRoot, suitePath } = setup();
    fs.writeFileSync(
      suitePath,
      SUITE_YAML.replace("model_profiles:", `judge_panel: { total: ${total}, quorum: ${quorum} }\n\nmodel_profiles:`),
      "utf8"
    );
    const panel = loadEvalSuite({ projectRoot, suitePath }).suite.judge_panel;
    expect(panel).toEqual({ total, quorum });
    expect(resolveJudgePanelConfig(panel)).toEqual({ total, quorum });
  });

  it.each([
    ["non-positive total", "{ total: 0, quorum: 1 }"],
    ["non-positive quorum", "{ total: 3, quorum: 0 }"],
    ["quorum above total", "{ total: 3, quorum: 4 }"],
    ["quorum without a strict majority", "{ total: 4, quorum: 2 }"]
  ])("rejects judge panel configuration with %s", (_description, panel) => {
    const { projectRoot, suitePath } = setup();
    fs.writeFileSync(
      suitePath,
      SUITE_YAML.replace("model_profiles:", `judge_panel: ${panel}\n\nmodel_profiles:`),
      "utf8"
    );
    expect(() => loadEvalSuite({ projectRoot, suitePath })).toThrowError(
      expect.objectContaining({ code: "EVAL_SUITE_INVALID" })
    );
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
        include: ["report.md", "report.json"],
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

describe("eval suite JSON Schema and Zod parity", () => {
  it.each([
    ["ordinary operator JSON", { campaign: { enabled: true, weights: [1, 2, null], label: "nightly" } }],
    ["empty operator JSON", {}],
    [
      "private benchmark controls",
      { benchmark_execution: { strategy_loops: 2, excluded_node_ids: ["optional-analysis"] } }
    ],
    [
      "public full benchmark controls",
      {
        benchmark_lane: "full",
        target_frameworks: { "aave-v4": "foundry" },
        excluded_strategy_families: [],
        benchmark_execution: { strategy_loops: 1, excluded_node_ids: [] }
      }
    ],
    [
      "public smoke benchmark controls",
      {
        benchmark_lane: "smoke",
        target_frameworks: { "aave-v4": "foundry" },
        excluded_strategy_families: ["stateful-invariant", "differential", "dynamic-strategy"],
        benchmark_execution: {
          workflow_profile: "smoke-benchmark-v1",
          audit_profile: "smoke",
          audit_profile_catalog_digest: "a".repeat(64),
          topology_digest: "b".repeat(64),
          selected_strategy_ids: [
            "time-warp-sequences",
            "external-dependency-boundaries",
            "externalized-state-accounting",
            "lifecycle-view-boundaries"
          ],
          strategy_loops: 1,
          excluded_node_ids: []
        }
      }
    ]
  ])("accepts %s in both validators", (_description, workflowInput) => {
    expectSchemaParity(withWorkflowInput(workflowInput), true);
  });

  it.each([null, true, 1, "raw input", [], ["array input"]])(
    "rejects non-object workflow input %j in both validators",
    (workflowInput) => {
      expectSchemaParity(withWorkflowInput(workflowInput), false);
    }
  );

  it.each([
    "benchmark_execution",
    "benchmark_lane",
    "excluded_strategy_families",
    "target_frameworks",
    "ultrafuzz_eval"
  ])("rejects operator input that shadows reserved key %s", (reservedKey) => {
    expectSchemaParity(withWorkflowInput({ campaign: "nightly", [reservedKey]: {} }), false);
  });

  it.each([
    [
      "private controls with an extra field",
      { benchmark_execution: { strategy_loops: 1, excluded_node_ids: [], extra: true } }
    ],
    ["private controls missing excluded node IDs", { benchmark_execution: { strategy_loops: 1 } }],
    [
      "full controls with a nonempty excluded family list",
      {
        benchmark_lane: "full",
        target_frameworks: { "aave-v4": "foundry" },
        excluded_strategy_families: ["differential"],
        benchmark_execution: { strategy_loops: 1, excluded_node_ids: [] }
      }
    ],
    [
      "full controls with an extra execution field",
      {
        benchmark_lane: "full",
        target_frameworks: { "aave-v4": "foundry" },
        excluded_strategy_families: [],
        benchmark_execution: { strategy_loops: 1, excluded_node_ids: [], workflow_profile: "smoke-benchmark-v1" }
      }
    ],
    [
      "full controls without target frameworks",
      {
        benchmark_lane: "full",
        excluded_strategy_families: [],
        benchmark_execution: { strategy_loops: 1, excluded_node_ids: [] }
      }
    ],
    [
      "smoke controls missing one selected strategy",
      {
        benchmark_lane: "smoke",
        target_frameworks: { "aave-v4": "foundry" },
        excluded_strategy_families: ["stateful-invariant", "differential", "dynamic-strategy"],
        benchmark_execution: {
          workflow_profile: "smoke-benchmark-v1",
          audit_profile: "smoke",
          audit_profile_catalog_digest: "a".repeat(64),
          topology_digest: "b".repeat(64),
          selected_strategy_ids: [
            "time-warp-sequences",
            "external-dependency-boundaries",
            "externalized-state-accounting"
          ],
          strategy_loops: 1,
          excluded_node_ids: []
        }
      }
    ],
    [
      "smoke controls without their audit profile policy",
      {
        benchmark_lane: "smoke",
        target_frameworks: { "aave-v4": "foundry" },
        excluded_strategy_families: ["stateful-invariant", "differential", "dynamic-strategy"],
        benchmark_execution: {
          workflow_profile: "smoke-benchmark-v1",
          selected_strategy_ids: [
            "time-warp-sequences",
            "external-dependency-boundaries",
            "externalized-state-accounting",
            "lifecycle-view-boundaries"
          ],
          strategy_loops: 1,
          excluded_node_ids: []
        }
      }
    ],
    [
      "smoke controls with an unpinned audit profile catalog digest",
      {
        benchmark_lane: "smoke",
        target_frameworks: { "aave-v4": "foundry" },
        excluded_strategy_families: ["stateful-invariant", "differential", "dynamic-strategy"],
        benchmark_execution: {
          workflow_profile: "smoke-benchmark-v1",
          audit_profile: "smoke",
          audit_profile_catalog_digest: "not-a-digest",
          topology_digest: "b".repeat(64),
          selected_strategy_ids: [
            "time-warp-sequences",
            "external-dependency-boundaries",
            "externalized-state-accounting",
            "lifecycle-view-boundaries"
          ],
          strategy_loops: 1,
          excluded_node_ids: []
        }
      }
    ]
  ])("rejects malformed benchmark arm: %s", (_description, workflowInput) => {
    expectSchemaParity(withWorkflowInput(workflowInput), false);
  });

  const rejectedMutations: Array<[string, (document: SuiteDocument) => void]> = [
    [
      "model profile config",
      (document) => (objectField(objectField(document, "model_profiles"), "eval-runner").config = {})
    ],
    ["variant prompts", (document) => (firstObjectField(document, "variants").prompts = ["prompt.md"])],
    ["root prompt overlays", (document) => (document.prompt_overlays = ["prompt.md"])],
    ["variant model profiles", (document) => (firstObjectField(document, "variants").model_profiles = ["eval-runner"])],
    ["primary metric alias", (document) => (objectField(document, "metrics").primary = "recall")],
    ["secondary metric alias", (document) => (objectField(document, "metrics").secondary = ["precision"])],
    ["unknown root key", (document) => (document.unknown = true)],
    ["unknown target key", (document) => (firstObjectField(document, "targets").unknown = true)],
    ["unknown run key", (document) => (objectField(document, "run").unknown = true)],
    ["normalized ground-truth root", (document) => (document.ground_truth_root = "/tmp/ground-truth")],
    [
      "normalized reporting mode marker",
      (document) => (objectField(objectField(document, "reporting"), "artifacts").mode_explicit = true)
    ],
    ["historical v1 version", (document) => (document.schema_version = "ultrafuzz.eval.v1")],
    ["numeric-looking historical version", (document) => (document.schema_version = "1.0")]
  ];

  it.each(rejectedMutations)("rejects removed, internal, or unknown field: %s", (_description, mutate) => {
    const document = suiteDocument();
    mutate(document);
    expectSchemaParity(document, false);
  });

  it("keeps nested operator keys bounded by the same nonempty-string rule", () => {
    expectSchemaParity(withWorkflowInput({ campaign: { " ": true } }), false);
  });
});
