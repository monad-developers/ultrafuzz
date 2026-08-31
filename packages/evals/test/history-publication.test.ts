import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  EVAL_HISTORY_AUTOMATIC_PUBLICATION_PLAN_SCHEMA_VERSION,
  EVAL_HISTORY_PUBLICATION_HANDOFF_GATE,
  EVAL_HISTORY_PUBLICATION_GENERATION_SCHEMA_VERSION,
  assertEvalHistoryPublicationHandoff,
  evalHistoryPublicationHandoffIssues,
  parseEvalHistoryAutomaticPublicationPlan,
  parseEvalHistoryPublicationGeneration,
  readEvalHistoryAutomaticPublicationPlan,
  readEvalHistoryPublicationGeneration,
  type EvalHistoryAutomaticPublicationPlan,
  type EvalHistoryPublicationGeneration
} from "../src/history-publication.js";
import {
  EVAL_HISTORY_AUTOMATIC_PUBLICATION_PLAN_SCHEMA_ID,
  EVAL_HISTORY_PUBLICATION_GENERATION_SCHEMA_ID,
  validateEvalJsonSchema
} from "../src/eval-schema-registry.js";
import { executeEvalSchemaSemanticGates } from "../src/eval-semantic-gates.js";

const REPOSITORY = "https://github.com/monad-developers/ultrafuzz";
const SOURCE_ARTIFACT = `${REPOSITORY}/actions/runs/12345`;
const PUBLICATION_URL = `${SOURCE_ARTIFACT}/artifacts`;
const MODEL_SLUG = "benchmark-smoke-gpt-5-6-luna-high";
const PAIR = `ultrafuzz-bench-${MODEL_SLUG}`;
const TARGET_IDS = ["target-a", "target-b", "target-c"];

function publicationPlan(): EvalHistoryAutomaticPublicationPlan {
  return {
    schema_version: EVAL_HISTORY_AUTOMATIC_PUBLICATION_PLAN_SCHEMA_VERSION,
    candidate_commit: "a".repeat(40),
    candidate_repository_url: REPOSITORY,
    source_artifact: SOURCE_ARTIFACT,
    producer_run_id: "12345",
    producer_run_attempt: "2",
    mode: "smoke",
    benchmark: "ultrafuzz-bench",
    pairs: [
      {
        pair: PAIR,
        provider: "openai",
        model_slug: MODEL_SLUG,
        bundle_path: `${PAIR}/${MODEL_SLUG}/public-results.json`,
        unpack_path: PAIR,
        eval_run_id: "eval-run-1",
        benchmark: "ultrafuzz-bench",
        lane: "smoke",
        status: "succeeded",
        target_ids: TARGET_IDS,
        executed_case_count: 3,
        graded_case_count: 3,
        publication_url: PUBLICATION_URL
      }
    ]
  };
}

function publicationGeneration(): EvalHistoryPublicationGeneration {
  return {
    schema_version: EVAL_HISTORY_PUBLICATION_GENERATION_SCHEMA_VERSION,
    candidate_commit: "a".repeat(40),
    candidate_repository_url: REPOSITORY,
    source_artifact: SOURCE_ARTIFACT,
    runs: [
      {
        eval_run_id: "eval-run-1",
        benchmark: "ultrafuzz-bench",
        lane: "smoke",
        status: "succeeded",
        input_path: `${PAIR}/eval`,
        target_ids: TARGET_IDS,
        executed_case_count: 3,
        graded_case_count: 3,
        publication_url: PUBLICATION_URL
      }
    ]
  };
}

describe("eval-history publication documents", () => {
  it("registers exact current-only plan and generation shapes with executable integrity gates", () => {
    const plan = publicationPlan();
    const generation = publicationGeneration();
    expect(validateEvalJsonSchema(EVAL_HISTORY_AUTOMATIC_PUBLICATION_PLAN_SCHEMA_ID, plan).ok).toBe(true);
    expect(validateEvalJsonSchema(EVAL_HISTORY_PUBLICATION_GENERATION_SCHEMA_ID, generation).ok).toBe(true);
    expect(executeEvalSchemaSemanticGates(EVAL_HISTORY_AUTOMATIC_PUBLICATION_PLAN_SCHEMA_ID, plan)).toEqual([]);
    expect(executeEvalSchemaSemanticGates(EVAL_HISTORY_PUBLICATION_GENERATION_SCHEMA_ID, generation)).toEqual([]);
    expect(parseEvalHistoryAutomaticPublicationPlan(plan)).toBe(plan);
    expect(parseEvalHistoryPublicationGeneration(generation)).toBe(generation);
  });

  it("requires enriched generation rows and rejects aliases or synthesized publication URLs", () => {
    const missingStatus = structuredClone(publicationGeneration()) as unknown as Record<string, unknown> & {
      runs: Array<Record<string, unknown>>;
    };
    delete missingStatus.runs[0]!.status;
    expect(() => parseEvalHistoryPublicationGeneration(missingStatus)).toThrowError(
      expect.objectContaining({ code: "EVAL_HISTORY_PUBLICATION_GENERATION_INVALID" })
    );

    const missingPublicationUrl = structuredClone(publicationGeneration()) as unknown as Record<string, unknown> & {
      runs: Array<Record<string, unknown>>;
    };
    delete missingPublicationUrl.runs[0]!.publication_url;
    expect(() => parseEvalHistoryPublicationGeneration(missingPublicationUrl)).toThrow();

    expect(() =>
      parseEvalHistoryPublicationGeneration({
        ...publicationGeneration(),
        candidate_repository_url: `${REPOSITORY}/`
      })
    ).toThrow();
  });

  it("rejects cross-field identity drift through the named semantic gates", () => {
    const plan = { ...publicationPlan(), source_artifact: `${REPOSITORY}/actions/runs/99999` };
    expect(validateEvalJsonSchema(EVAL_HISTORY_AUTOMATIC_PUBLICATION_PLAN_SCHEMA_ID, plan).ok).toBe(true);
    expect(executeEvalSchemaSemanticGates(EVAL_HISTORY_AUTOMATIC_PUBLICATION_PLAN_SCHEMA_ID, plan)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gate: "eval-history-automatic-publication-plan-integrity",
          path: "$.source_artifact"
        })
      ])
    );
    expect(() => parseEvalHistoryAutomaticPublicationPlan(plan)).toThrow();

    const generation = structuredClone(publicationGeneration());
    generation.runs[0]!.publication_url = `${REPOSITORY}/actions/runs/99999/artifacts`;
    expect(validateEvalJsonSchema(EVAL_HISTORY_PUBLICATION_GENERATION_SCHEMA_ID, generation).ok).toBe(true);
    expect(executeEvalSchemaSemanticGates(EVAL_HISTORY_PUBLICATION_GENERATION_SCHEMA_ID, generation)).toEqual([
      expect.objectContaining({
        gate: "eval-history-publication-generation-integrity",
        path: "$.runs[0].publication_url"
      })
    ]);
    expect(() => parseEvalHistoryPublicationGeneration(generation)).toThrow();
  });

  it("executes a named exact join between each plan pair and generation run", () => {
    const plan = publicationPlan();
    const generation = publicationGeneration();
    expect(evalHistoryPublicationHandoffIssues(plan, generation)).toEqual([]);
    expect(() => assertEvalHistoryPublicationHandoff(plan, generation)).not.toThrow();

    const drifted = structuredClone(generation);
    drifted.runs[0]!.input_path = "other/eval";
    expect(evalHistoryPublicationHandoffIssues(plan, drifted)).toEqual([
      {
        gate: EVAL_HISTORY_PUBLICATION_HANDOFF_GATE,
        path: "$.generation.runs[0]",
        message: "must equal the canonical projection of plan.pairs[0]"
      }
    ]);
    expect(() => assertEvalHistoryPublicationHandoff(plan, drifted)).toThrowError(
      expect.objectContaining({ code: "EVAL_HISTORY_PUBLICATION_HANDOFF_INVALID" })
    );
  });

  it.runIf(process.platform !== "win32")(
    "strict-reads immutable regular files and rejects duplicate keys and symlinks",
    () => {
      const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-history-publication-"));
      try {
        const planPath = path.join(root, "plan.json");
        const generationPath = path.join(root, "generation.json");
        fs.writeFileSync(planPath, `${JSON.stringify(publicationPlan())}\n`, "utf8");
        fs.writeFileSync(generationPath, `${JSON.stringify(publicationGeneration())}\n`, "utf8");
        expect(readEvalHistoryAutomaticPublicationPlan(planPath)).toEqual(publicationPlan());
        expect(readEvalHistoryPublicationGeneration(generationPath)).toEqual(publicationGeneration());

        const duplicatePath = path.join(root, "duplicate.json");
        fs.writeFileSync(
          duplicatePath,
          `${JSON.stringify(publicationGeneration()).replace(
            '"schema_version":"ultrafuzz.eval-history-publication-generation.v1"',
            '"schema_version":"ultrafuzz.eval-history-publication-generation.v1","schema_version":"shadow"'
          )}\n`,
          "utf8"
        );
        expect(() => readEvalHistoryPublicationGeneration(duplicatePath)).toThrow(/duplicate property/u);

        const linkPath = path.join(root, "generation-link.json");
        fs.symlinkSync(generationPath, linkPath);
        expect(() => readEvalHistoryPublicationGeneration(linkPath)).toThrow();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  );
});
