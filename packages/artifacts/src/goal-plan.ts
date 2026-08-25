import fs from "node:fs";

import { z } from "zod/v4";

import {
  NODE_REFERENCE_PATTERN,
  ArtifactPathError,
  assertRegularFileInside,
  listSafeFiles,
  normalizeSafeRelativePath,
  safeResolveInside,
  sha256Bytes
} from "./safe-paths.js";
import { CAPABILITY_STATUSES, repositoryRelativePathSchema } from "./threat-model.js";
import { schemaErrorMessage, validateWithZod, type SchemaValidationResult } from "./schema-validation.js";
import { sameStrings } from "./lang-primitives.js";

export const GOAL_PLAN_SCHEMA_VERSION = "ultrafuzz.goal-plan.v1" as const;
export const GOAL_PLAN_POLICY = "additive-v1" as const;
export const GOAL_PLAN_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:goal-plan:1" as const;

const nonEmptyString = z.string().trim().min(1);
const nodeReference = z.string().regex(NODE_REFERENCE_PATTERN);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const stableId = z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[a-z0-9]+(?:[.-][a-z0-9]+)*)*$/u);
const threatId = z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*:[a-z0-9]+(?:[.:-][a-z0-9]+)*$/u);
const uniqueIds = z
  .array(stableId)
  .refine((values) => new Set(values).size === values.length, { message: "IDs must be unique" });
/**
 * Replacement keys must be namespaced exactly as the dynamic fanout consumer requires
 * (`<namespace>:<name>`), so a contract-valid plan can never abort its own fanout node.
 */
const replacementKey = z.string().refine(isNamespacedDynamicReplacementKey, {
  message: "Replacement keys must be namespaced as <namespace>:<name>"
});

/** Keep planner replacement keys aligned with the dynamic prompt renderer. */
export function isNamespacedDynamicReplacementKey(name: string): boolean {
  return /^[a-z0-9][a-z0-9_.-]*(?::[a-z0-9][a-z0-9_.-]*)+$/u.test(name);
}

/** Return the unescaped template occurrences that the prompt renderer binds. */
export function promptTemplateOccurrences(template: string): Array<{ name: string }> {
  const occurrences: Array<{ name: string }> = [];
  let offset = 0;
  while (true) {
    const start = template.indexOf("{{", offset);
    if (start === -1) return occurrences;
    if (template[start - 1] === "\\") {
      offset = start + 2;
      continue;
    }
    const end = template.indexOf("}}", start + 2);
    if (end === -1) throw new Error("template variable is missing a closing delimiter");
    const name = template.slice(start + 2, end).trim();
    if (name === "") throw new Error("template variable name cannot be empty");
    occurrences.push({ name });
    offset = end + 2;
  }
}
/**
 * A replacement value is substituted directly into the goal sentence, so its length is the length of
 * the agent's authoritative goal statement. It must be a LABEL, not a payload.
 *
 * The number is set from measurement, not taste. In one 18-hour local default-profile run the
 * planner inlined whole JSON records (a full vulnerability-class record plus the full threat-model
 * entry, including `attack_surfaces`, `assets`, `actors` and every `evidence` array) into these
 * values: across 88 goals the per-goal replacement payload was min 3,751 / median 13,956 / max
 * 42,483 characters, against a `goal_prompt` template of only ~161 characters. `goal-hunter.mdx`
 * then tells the agent "the first sentence above is the authoritative focused goal", so each goal
 * began with a 3.5k-10.6k-token JSON wall. At max reasoning effort that is what exhausted the
 * per-node timeout: 9 nodes were killed at exactly the 7200000ms limit and only 3 of 77 class-goal
 * nodes produced any output (run reliability, #672/#677).
 *
 * 200 characters comfortably holds a human-readable title plus its namespaced ID -- the longest
 * shapes in this contract are like "Fixed-term loan liquidated before it is overdue
 * (lending.liquidation:fixed-term-before-overdue)" at well under half the budget -- while sitting
 * ~19x below the SMALLEST inlined record observed. Even a coverage-gap class goal with several
 * threat placeholders therefore adds a few hundred characters to the goal sentence rather than tens
 * of thousands. The full records stay reachable: the hunter prompt already reads
 * `{{artifact_path:threat-model}}/threat-model.json` and the selected class records under
 * `{{artifact_path:goal-plan}}`'s `vulnerability-db/selected`, so inlining them here was redundant
 * with the pattern the prompt already uses.
 *
 * The prompt asks the planner for titles; this cap is what makes a planner (or a model that ignores
 * the prompt) unable to silently reintroduce the wall.
 */
const REPLACEMENT_VALUE_MAX_LENGTH = 200;

/**
 * Rejects a serialized JSON record without rejecting prose that merely contains punctuation.
 *
 * The check is deliberately narrow: a value fails only when it BOTH begins with `{` or `[` after
 * trimming AND actually parses as a JSON object or array. Testing the prefix alone would reject
 * legitimate titles that open with a symbol or a code fragment ("{withdraw} reentrancy before
 * settlement"), and testing `JSON.parse` alone would reject bare numeric or boolean-looking titles.
 * Requiring both means the only strings rejected are ones that really are a machine record, which
 * is the exact failure mode measured above. Values that merely contain braces anywhere else, quotes,
 * colons, commas, or parenthesised IDs are all accepted -- the cap above, not this check, is what
 * bounds them.
 */
function isSerializedJsonRecord(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not machine-readable JSON, so it is prose that happens to open with a brace. Allowed.
    return false;
  }
  return typeof parsed === "object" && parsed !== null;
}

const replacementValue = nonEmptyString
  .max(REPLACEMENT_VALUE_MAX_LENGTH, {
    message:
      `Replacement values must be at most ${String(REPLACEMENT_VALUE_MAX_LENGTH)} characters: use a short ` +
      "human-readable title and let the hunter read the full record from its artifact path"
  })
  .refine((value) => !isSerializedJsonRecord(value), {
    message:
      "Replacement values must be a human-readable title, not a serialized JSON record: keep the record in the " +
      "artifact directory and reference it by path so the goal sentence stays one sentence"
  });

const replacementsSchema = z
  .record(replacementKey, z.union([replacementValue, z.number().finite(), z.boolean()]))
  .refine((value) => Object.keys(value).length > 0, { message: "At least one item-scoped replacement is required" });

const evidenceReferenceSchema = z
  .strictObject({
    path: repositoryRelativePathSchema,
    line: z.number().int().positive().optional(),
    end_line: z.number().int().positive().optional(),
    symbol: nonEmptyString.optional(),
    note: nonEmptyString.optional()
  })
  .superRefine((value, context) => {
    if (value.line !== undefined && value.end_line !== undefined && value.end_line < value.line) {
      context.addIssue({ code: "custom", path: ["end_line"], message: "end_line cannot precede line" });
    }
  });

const promptGoalFields = {
  title: nonEmptyString,
  goal_prompt: nonEmptyString,
  replacements: replacementsSchema,
  selection_rationale: nonEmptyString
} as const;

const threatGoalSchema = z
  .strictObject({
    kind: z.literal("threat"),
    id: threatId,
    node_id: nodeReference,
    threat_ids: z.array(threatId).length(1),
    class_ids: uniqueIds,
    attack_surface_ids: uniqueIds,
    ...promptGoalFields
  })
  .superRefine((value, context) => {
    if (value.threat_ids[0] !== value.id) {
      context.addIssue({ code: "custom", path: ["threat_ids", 0], message: "Threat goal ID must match threat_ids[0]" });
    }
    if (value.node_id !== "dynamic:threat:" + value.id) {
      context.addIssue({ code: "custom", path: ["node_id"], message: "Threat node ID must be dynamic:threat:<id>" });
    }
    validatePromptReplacements(value.goal_prompt, value.replacements, [value.id], context);
  });

const SELECTED_RECORD_PATH_PREFIX = "vulnerability-db/selected/" as const;
const SELECTED_RECORD_PATH_PATTERN =
  /^vulnerability-db\/selected\/(?:(?!\.{1,2}(?:\/|$))[A-Za-z0-9._@+-]{1,128}\/)*[A-Za-z0-9@+_-][A-Za-z0-9._@+-]{0,127}\.(?:md|yml)$/u;

/**
 * Composes the canonical safe-relative-path validator with the required prefix and `.md` suffix.
 * The raw value must already be canonical, so `.`, `..`, `./`, empty, and nested traversal
 * segments are rejected in the contract instead of only being caught by a later filesystem check.
 * Remote and in-memory consumers of the exported snapshot verifier get the same guarantee.
 */
const selectedRecordPath = z
  .string()
  .regex(SELECTED_RECORD_PATH_PATTERN)
  .superRefine((value, context) => {
    let normalized: string;
    try {
      normalized = normalizeSafeRelativePath(value, "selected vulnerability record path");
    } catch (error) {
      context.addIssue({
        code: "custom",
        message:
          error instanceof ArtifactPathError
            ? `Selected record path is unsafe: ${error.message}`
            : "Selected record path is unsafe"
      });
      return;
    }
    if (normalized !== value) {
      context.addIssue({ code: "custom", message: "Selected record path must already be canonical" });
      return;
    }
    if (!value.startsWith(SELECTED_RECORD_PATH_PREFIX) || value.length === SELECTED_RECORD_PATH_PREFIX.length) {
      context.addIssue({
        code: "custom",
        message: `Selected record path must start with ${SELECTED_RECORD_PATH_PREFIX}`
      });
    }
    if (!value.endsWith(".md") && !value.endsWith(".yml")) {
      context.addIssue({ code: "custom", message: "Selected record path must be a Markdown or YAML file" });
    }
  });

const selectedRecordSchema = z.strictObject({
  id: stableId,
  path: selectedRecordPath,
  sha256,
  size_bytes: z.number().int().nonnegative()
});

const classGoalSchema = z
  .strictObject({
    kind: z.literal("class"),
    id: stableId,
    node_id: nodeReference,
    class_id: stableId,
    class_replacement_key: replacementKey,
    threat_ids: z
      .array(threatId)
      .refine((values) => new Set(values).size === values.length, { message: "Threat IDs must be unique" }),
    threat_replacement_keys: z
      .array(replacementKey)
      .min(1)
      .refine((values) => new Set(values).size === values.length, {
        message: "Threat replacement keys must be unique"
      }),
    attack_surface_ids: uniqueIds,
    coverage_gap: z.boolean(),
    selected_record: selectedRecordSchema,
    ...promptGoalFields
  })
  .superRefine((value, context) => {
    if (value.class_id !== value.id || value.selected_record.id !== value.id) {
      context.addIssue({ code: "custom", path: ["class_id"], message: "Class goal identifiers must agree" });
    }
    if (value.node_id !== "dynamic:class:" + value.id) {
      context.addIssue({ code: "custom", path: ["node_id"], message: "Class node ID must be dynamic:class:<id>" });
    }
    if (value.class_replacement_key !== "class:" + value.id) {
      context.addIssue({
        code: "custom",
        path: ["class_replacement_key"],
        message: "Class replacement key must be the namespaced class:<id>"
      });
    }
    if ((value.threat_ids.length === 0) !== value.coverage_gap) {
      context.addIssue({
        code: "custom",
        path: ["coverage_gap"],
        message: "coverage_gap must be true exactly when no explicit threat maps to an applicable class"
      });
    }
    const expectedThreatReplacementKeys = value.coverage_gap
      ? ["threat-model:coverage-gap"]
      : [...value.threat_ids].sort();
    if (!sameStrings([...value.threat_replacement_keys].sort(), expectedThreatReplacementKeys)) {
      context.addIssue({
        code: "custom",
        path: ["threat_replacement_keys"],
        message: value.coverage_gap
          ? "Coverage-gap class goals must use only threat-model:coverage-gap"
          : "Threat replacement keys must exactly match the mapped threat IDs"
      });
    }
    validatePromptReplacements(
      value.goal_prompt,
      value.replacements,
      [value.class_replacement_key, ...value.threat_replacement_keys],
      context
    );
  });

const capabilityCheckSchema = z.strictObject({
  capability_id: stableId,
  requirement: z.enum(["required", "optional", "incompatible"]),
  observed_status: z.enum(CAPABILITY_STATUSES),
  evidence: z.array(evidenceReferenceSchema),
  rationale: nonEmptyString
});

const applicabilityDecisionSchema = z
  .strictObject({
    class_id: stableId,
    decision: z.enum(["applicable", "inapplicable"]),
    checks: z.array(capabilityCheckSchema),
    rationale: nonEmptyString
  })
  .superRefine((value, context) => {
    const decisive = value.checks.some(
      (check) =>
        (check.requirement === "required" && check.observed_status === "absent") ||
        (check.requirement === "incompatible" && check.observed_status === "present")
    );
    if (value.decision === "inapplicable" && !decisive) {
      context.addIssue({
        code: "custom",
        path: ["decision"],
        message:
          "Inapplicable classes require evidence-backed absent required capability or present incompatible capability"
      });
    }
    if (value.decision === "applicable" && decisive) {
      context.addIssue({
        code: "custom",
        path: ["decision"],
        message: "Applicable class has a decisive incompatibility"
      });
    }
    value.checks.forEach((check, index) => {
      const isDecisive =
        (check.requirement === "required" && check.observed_status === "absent") ||
        (check.requirement === "incompatible" && check.observed_status === "present");
      if (isDecisive && check.evidence.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["checks", index, "evidence"],
          message: "A decisive applicability check requires repository evidence"
        });
      }
    });
  });

export const GOAL_LANE_KINDS = ["threat", "class", "roaming"] as const;
export type GoalLaneKind = (typeof GOAL_LANE_KINDS)[number];

/**
 * One goal lane: a named unit of hunting work and the concrete node IDs it owns.
 *
 * Lanes exist so "failed goal lanes" and per-lane tokens/cost/wall-clock (#183) are a *grouping* of
 * data the run already records, not new telemetry. `node_ids` is a list because one lane may own
 * several nodes once model fanout materializes more than one attempt per goal.
 *
 * A lane is one goal, not one dynamic group; that choice and the alternative are argued in
 * `goalPlanExpansionFacts`.
 */
const goalLaneSchema = z.strictObject({
  // A lane is named by the goal it runs: a threat ID, a class ID, or the fixed roaming node ID.
  lane_id: z.union([stableId, threatId]),
  kind: z.enum(GOAL_LANE_KINDS),
  node_ids: z.array(nodeReference).min(1).refine(uniqueValues, { message: "Lane node IDs must be unique" })
});

export type GoalLane = z.infer<typeof goalLaneSchema>;

export interface GoalPlanExpansionFactsInput {
  threat_goals: ReadonlyArray<{ id: string; node_id: string }>;
  class_goals: ReadonlyArray<{ id: string; node_id: string }>;
  roaming_goal: { node_id: string };
  max_dynamic_nodes: number;
}

export interface GoalPlanExpansionFacts {
  expected_child_count: number;
  threat_count: number;
  applicable_class_count: number;
  max_dynamic_nodes: number;
  goal_lanes: GoalLane[];
}

/**
 * The single authority for #183's dynamic-fanout cardinality rule: one dynamic child per modeled
 * threat plus one per applicable database class, alongside the fixed roaming node, which is a static
 * topology node and therefore never a dynamic child.
 *
 * Both the planner-side recorder that writes these numbers into `goal-plan.json` and the contract
 * that validates them call this one function, so the rule is stated exactly once. That includes the
 * pre-existing `counts` block, whose `threats`, `applicable_classes` and `dynamic_goals` are the same
 * arithmetic: they are checked against these facts rather than recomputed, so the two cannot drift.
 * `counts` is retained because it is already published and read; `expected_child_count`,
 * `threat_count` and `applicable_class_count` are its #364-named aliases, and a reader may use
 * either. The eval side never calls this function -- it reads what the planner wrote and compares, so
 * a planner that under-expands is caught by a component that did not compute the expectation (#364,
 * option (a)).
 *
 * Lane granularity, decided here and recorded rather than assumed: a lane is **one goal**, so
 * `lane_id` is a threat ID or a class ID and a run has `threats + classes + 1` lanes. The alternative
 * reading -- lane = dynamic group, giving exactly three lanes (`threat-goals`, `class-goals`,
 * `goal-roaming`) per run -- is cheaper to aggregate but reports the cost of a whole group, which
 * says nothing about which goal was expensive or which one failed. #364 left this open; per-goal is
 * chosen because per-goal cost and per-goal failure are the metrics #183 asks for. Group-level
 * numbers remain derivable by summing lanes of one `kind`; the reverse is not.
 */
export function goalPlanExpansionFacts(input: GoalPlanExpansionFactsInput): GoalPlanExpansionFacts {
  const threatCount = input.threat_goals.length;
  const applicableClassCount = input.class_goals.length;
  return {
    expected_child_count: threatCount + applicableClassCount,
    threat_count: threatCount,
    applicable_class_count: applicableClassCount,
    max_dynamic_nodes: input.max_dynamic_nodes,
    goal_lanes: [
      ...input.threat_goals.map((goal) => ({
        lane_id: goal.id,
        kind: "threat" as const,
        node_ids: [goal.node_id]
      })),
      ...input.class_goals.map((goal) => ({
        lane_id: goal.id,
        kind: "class" as const,
        node_ids: [goal.node_id]
      })),
      { lane_id: input.roaming_goal.node_id, kind: "roaming" as const, node_ids: [input.roaming_goal.node_id] }
    ]
  };
}

export const goalPlanSchema = z
  .strictObject({
    schema_version: z.literal(GOAL_PLAN_SCHEMA_VERSION),
    policy: z.literal(GOAL_PLAN_POLICY),
    threat_model_sha256: sha256,
    vulnerability_database: z.strictObject({
      planner_catalog_schema_version: z.literal("ultrafuzz.vulnerability-db.planner-catalog.v1"),
      snapshot_manifest_schema_version: z.literal("ultrafuzz.vulnerability-db.snapshot.v1"),
      database_schema_version: z.number().int().positive(),
      aggregate_sha256: sha256,
      catalog_sha256: sha256
    }),
    catalog_class_ids: uniqueIds,
    modeled_threat_ids: uniqueIds.min(1),
    threat_goals: z.array(threatGoalSchema),
    class_goals: z.array(classGoalSchema),
    applicability_decisions: z.array(applicabilityDecisionSchema),
    selected_class_records: z.array(selectedRecordSchema),
    roaming_goal: z.strictObject({
      node_id: z.literal("goal-roaming"),
      prompt_path: z.literal("strategies/roaming-goal.md"),
      purpose: nonEmptyString
    }),
    counts: z.strictObject({
      threats: z.number().int().nonnegative(),
      applicable_classes: z.number().int().nonnegative(),
      inapplicable_classes: z.number().int().nonnegative(),
      dynamic_goals: z.number().int().nonnegative(),
      total_goals: z.number().int().positive()
    }),
    /**
     * How many dynamic children this plan expects the runtime to create, written down at planning
     * time so the eval side can compare it against what the run actually produced without ever
     * recomputing the rule (#364). Equal to `counts.dynamic_goals` by construction -- both are
     * checked against `goalPlanExpansionFacts`, which computes it once.
     */
    expected_child_count: z.number().int().nonnegative().optional(),
    /** Equal to `counts.threats`; see `expected_child_count`. */
    threat_count: z.number().int().nonnegative().optional(),
    /** Equal to `counts.applicable_classes`; see `expected_child_count`. */
    applicable_class_count: z.number().int().nonnegative().optional(),
    /** The `run.max_dynamic_nodes` limit this plan was produced under. */
    max_dynamic_nodes: z.number().int().positive().optional(),
    goal_lanes: z.array(goalLaneSchema).min(1).optional()
  })
  .superRefine((value, context) => {
    // The five fields below are populated by recordGoalPlanExpansionFacts after
    // the agent returns, so they are optional: an agent that omits them, as its
    // prompt instructs, must still pass `ultrafuzz json validate`. Requiring
    // them made the instruction and the validation command mutually
    // unsatisfiable, and the agent could not have supplied max_dynamic_nodes
    // correctly in any case -- it is a run setting the prompt never states.
    //
    // When they ARE present the plan must agree with itself. Four of the five
    // are derivable from this document, so `ultrafuzz artifact validate` can
    // catch a miscount in-session, while the agent can still fix it, instead of
    // failing the node afterwards.
    const derived = [
      value.expected_child_count,
      value.threat_count,
      value.applicable_class_count,
      value.max_dynamic_nodes,
      value.goal_lanes
    ];
    const present = derived.filter((entry) => entry !== undefined).length;
    if (present > 0 && present < derived.length) {
      context.addIssue({
        code: "custom",
        message:
          "goal plan must carry all of expected_child_count, threat_count, applicable_class_count, max_dynamic_nodes and goal_lanes, or none of them"
      });
    }
    addDuplicateIssues(value.threat_goals, "threat_goals", context);
    addDuplicateIssues(value.class_goals, "class_goals", context);
    addDuplicateIssues(value.applicability_decisions, "applicability_decisions", context, "class_id");
    addDuplicateIssues(value.selected_class_records, "selected_class_records", context);

    const modeledThreats = [...value.modeled_threat_ids].sort();
    const plannedThreats = value.threat_goals.map((goal) => goal.id).sort();
    if (!sameStrings(modeledThreats, plannedThreats)) {
      context.addIssue({
        code: "custom",
        path: ["threat_goals"],
        message: "Additive policy requires exactly one threat goal for every modeled threat"
      });
    }

    const catalogClasses = [...value.catalog_class_ids].sort();
    const decidedClasses = value.applicability_decisions.map((decision) => decision.class_id).sort();
    if (!sameStrings(catalogClasses, decidedClasses)) {
      context.addIssue({
        code: "custom",
        path: ["applicability_decisions"],
        message: "Every planner-catalog class requires exactly one applicability decision"
      });
    }

    const applicable = value.applicability_decisions
      .filter((decision) => decision.decision === "applicable")
      .map((decision) => decision.class_id)
      .sort();
    const classGoals = value.class_goals.map((goal) => goal.class_id).sort();
    const selectedRecords = value.selected_class_records.map((record) => record.id).sort();
    if (!sameStrings(applicable, classGoals) || !sameStrings(classGoals, selectedRecords)) {
      context.addIssue({
        code: "custom",
        path: ["class_goals"],
        message: "Applicable classes, class goals, and selected record snapshots must match exactly"
      });
    }
    const selectedById = new Map(value.selected_class_records.map((record) => [record.id, record]));
    value.class_goals.forEach((goal, index) => {
      const selected = selectedById.get(goal.id);
      if (
        selected !== undefined &&
        (selected.path !== goal.selected_record.path ||
          selected.sha256 !== goal.selected_record.sha256 ||
          selected.size_bytes !== goal.selected_record.size_bytes)
      ) {
        context.addIssue({
          code: "custom",
          path: ["class_goals", index, "selected_record"],
          message: "Class goal selected_record must exactly match selected_class_records"
        });
      }
    });

    // One computation feeds both blocks below. `counts` predates #364 and `expected_child_count` and
    // friends were added by it, but they are the same arithmetic over the same goals: computing it
    // twice is the drift hazard #364 chose option (a) to avoid, so the pre-existing `counts` block is
    // derived from these facts rather than restating `threat_goals.length + class_goals.length`.
    const facts = goalPlanExpansionFacts({ ...value, max_dynamic_nodes: value.max_dynamic_nodes ?? 1 });
    const expected = {
      threats: facts.threat_count,
      applicable_classes: facts.applicable_class_count,
      inapplicable_classes: value.applicability_decisions.filter((item) => item.decision === "inapplicable").length,
      dynamic_goals: facts.expected_child_count,
      // The one goal that is not a dynamic child: the fixed roaming node, which is static topology.
      total_goals: facts.expected_child_count + 1
    };
    for (const [field, count] of Object.entries(expected)) {
      if (value.counts[field as keyof typeof expected] !== count) {
        context.addIssue({ code: "custom", path: ["counts", field], message: "Count must equal " + String(count) });
      }
    }

    for (const field of ["expected_child_count", "threat_count", "applicable_class_count"] as const) {
      if (value[field] !== undefined && value[field] !== facts[field]) {
        context.addIssue({ code: "custom", path: [field], message: `${field} must equal ${String(facts[field])}` });
      }
    }
    if (
      value.expected_child_count !== undefined &&
      value.max_dynamic_nodes !== undefined &&
      value.expected_child_count > value.max_dynamic_nodes
    ) {
      context.addIssue({
        code: "custom",
        path: ["expected_child_count"],
        message: `Plan expects ${String(value.expected_child_count)} dynamic children, exceeding max_dynamic_nodes=${String(value.max_dynamic_nodes)}`
      });
    }
    if (value.goal_lanes !== undefined && !sameJson(value.goal_lanes, facts.goal_lanes)) {
      context.addIssue({
        code: "custom",
        path: ["goal_lanes"],
        message: "goal_lanes must name every threat goal, class goal, and the fixed roaming goal exactly once"
      });
    }
  });

/**
 * The canonical JSON Schema for `ultrafuzz/goal-plan@1`, generated from the single runtime contract
 * above and snapshotted to `schema/goal-plan.schema.json` so prompts and external consumers can
 * reference one authoritative document instead of a hand-maintained shape summary.
 */
export const goalPlanJsonSchema = {
  ...z.toJSONSchema(goalPlanSchema, { io: "input", unrepresentable: "any" }),
  $id: GOAL_PLAN_JSON_SCHEMA_ID,
  title: "Ultrafuzz goal plan"
} as Record<string, unknown>;

export type GoalPlan = z.infer<typeof goalPlanSchema>;
export type ThreatGoalPlanItem = z.infer<typeof threatGoalSchema>;
export type ClassGoalPlanItem = z.infer<typeof classGoalSchema>;
export type ApplicabilityDecision = z.infer<typeof applicabilityDecisionSchema>;

export function validateGoalPlan(value: unknown, path = "$"): SchemaValidationResult<GoalPlan> {
  return validateWithZod(goalPlanSchema, value, { path, code: "GOAL_PLAN_SCHEMA_INVALID" });
}

export function assertGoalPlan(value: unknown): GoalPlan {
  const result = validateGoalPlan(value);
  if (!result.ok || result.value === undefined) {
    throw new Error(schemaErrorMessage("goal plan", result.issues));
  }
  return result.value;
}

/**
 * Bind a goal plan to the exact bytes of the canonical upstream
 * threat-model.json artifact. Callers are responsible for resolving those
 * bytes from the actual dependency identity (or bundle manifest), rather than
 * guessing an adjacent artifact directory.
 */
export function verifyGoalPlanThreatModelBytes(
  input: GoalPlan | unknown,
  threatModelJson: string | Uint8Array
): GoalPlan {
  const plan = assertGoalPlan(input);
  if (sha256Bytes(threatModelJson) !== plan.threat_model_sha256) {
    throw new Error("goal plan threat_model_sha256 does not match the upstream threat-model.json bytes");
  }
  return plan;
}

export function verifyGoalPlanSelectedRecordSnapshots(
  artifactDir: string,
  input: GoalPlan | unknown
): Array<{ path: string; contents: Buffer }> {
  const plan = assertGoalPlan(input);
  const manifestPath = safeResolveInside(
    artifactDir,
    "vulnerability-db-manifest.json",
    "vulnerability database manifest"
  );
  assertRegularFileInside(artifactDir, manifestPath, "vulnerability database manifest");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
  const selectedFiles = new Map<string, Buffer>();
  for (const entry of listSafeFiles(artifactDir)) {
    if (!entry.relativePath.startsWith("vulnerability-db/selected/")) continue;
    selectedFiles.set(entry.relativePath, fs.readFileSync(entry.absolutePath));
  }
  return verifyGoalPlanSelectedRecordSnapshotBytes(plan, manifest, selectedFiles);
}

/**
 * Verify an in-memory vulnerability database snapshot without filesystem
 * assumptions. Bundle and remote runners can supply their exact decoded
 * selected-path map and reuse the same contract as the local wrapper.
 */
export function verifyGoalPlanSelectedRecordSnapshotBytes(
  input: GoalPlan | unknown,
  manifestInput: unknown,
  selectedFiles: ReadonlyMap<string, string | Uint8Array>
): Array<{ path: string; contents: Buffer }> {
  const plan = assertGoalPlan(input);
  const manifest = vulnerabilityDatabaseManifestSchema.parse(manifestInput);
  if (
    manifest.schema_version !== plan.vulnerability_database.snapshot_manifest_schema_version ||
    manifest.database_schema_version !== plan.vulnerability_database.database_schema_version ||
    manifest.aggregate_sha256 !== plan.vulnerability_database.aggregate_sha256 ||
    manifest.catalog_sha256 !== plan.vulnerability_database.catalog_sha256
  ) {
    throw new Error("vulnerability database manifest does not match goal-plan provenance");
  }

  assertUniqueManifestRecords(manifest.records, "records");
  assertUniqueManifestRecords(manifest.selected_records, "selected_records");
  const catalogClassIds = manifest.records.map((record) => record.id).sort();
  if (!sameStrings(catalogClassIds, [...plan.catalog_class_ids].sort())) {
    throw new Error("vulnerability database manifest records do not match goal-plan catalog classes");
  }
  const plannedSelectedIds = plan.selected_class_records.map((record) => record.id).sort();
  const manifestSelectedIds = manifest.selected_records.map((record) => record.id).sort();
  if (!sameStrings(plannedSelectedIds, manifestSelectedIds)) {
    throw new Error("vulnerability database snapshot selected set does not match the goal plan");
  }
  const plannedSelectedPaths = plan.selected_class_records.map((record) => record.path).sort();
  const suppliedSelectedPaths = [...selectedFiles.keys()].sort();
  if (!sameStrings(plannedSelectedPaths, suppliedSelectedPaths)) {
    throw new Error("selected vulnerability class byte map does not exactly match the goal plan");
  }

  const manifestRecords = new Map(manifest.records.map((record) => [record.id, record]));
  const selectedManifestRecords = new Map(manifest.selected_records.map((record) => [record.id, record]));
  return plan.selected_class_records.map((selected) => {
    const manifestRecord = manifestRecords.get(selected.id);
    const selectedManifestRecord = selectedManifestRecords.get(selected.id);
    if (
      manifestRecord === undefined ||
      manifestRecord.sha256 !== selected.sha256 ||
      manifestRecord.size_bytes !== selected.size_bytes
    ) {
      throw new Error("selected vulnerability class does not match database manifest: " + selected.id);
    }
    if (
      selectedManifestRecord === undefined ||
      selectedManifestRecord.artifact_path !== selected.path ||
      selectedManifestRecord.path !== manifestRecord.path ||
      selectedManifestRecord.sha256 !== selected.sha256 ||
      selectedManifestRecord.size_bytes !== selected.size_bytes
    ) {
      throw new Error("selected vulnerability class does not match snapshot manifest: " + selected.id);
    }
    const supplied = selectedFiles.get(selected.path);
    if (supplied === undefined) {
      throw new Error("selected vulnerability class bytes are missing: " + selected.id);
    }
    const contents = Buffer.from(supplied);
    if (contents.byteLength !== selected.size_bytes || sha256Bytes(contents) !== selected.sha256) {
      throw new Error("selected vulnerability class bytes do not match goal plan: " + selected.id);
    }
    return { path: selected.path, contents };
  });
}

function assertUniqueManifestRecords(
  records: readonly { id: string; path: string; artifact_path?: string }[],
  field: string
): void {
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const record of records) {
    const artifactPath = record.artifact_path ?? record.path;
    if (ids.has(record.id) || paths.has(artifactPath)) {
      throw new Error(`vulnerability database manifest ${field} contains duplicate IDs or paths`);
    }
    ids.add(record.id);
    paths.add(artifactPath);
  }
}

function validatePromptReplacements(
  template: string,
  replacements: Record<string, string | number | boolean>,
  requiredKeys: string[],
  context: z.RefinementCtx
): void {
  if (!template.includes("/goal")) {
    context.addIssue({ code: "custom", path: ["goal_prompt"], message: "Goal prompt must retain the /goal marker" });
  }
  // Use the shared renderer occurrence parser so a "required placeholder" is exactly a placeholder
  // the renderer will bind. Escaped `\{{key}}` occurrences render as literal text and therefore do
  // not satisfy a requirement, and must not demand a replacement either.
  let placeholders: string[];
  try {
    placeholders = promptTemplateOccurrences(template).map((occurrence) => occurrence.name);
  } catch (error) {
    context.addIssue({
      code: "custom",
      path: ["goal_prompt"],
      message: `Goal prompt is not a renderable template: ${error instanceof Error ? error.message : String(error)}`
    });
    return;
  }
  const placeholderSet = new Set(placeholders);
  for (const key of requiredKeys) {
    if (!placeholderSet.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["goal_prompt"],
        message: template.includes("\\{{" + key + "}}")
          ? "Prompt must not escape the required item-scoped placeholder {{" + key + "}}"
          : "Prompt must retain item-scoped placeholder {{" + key + "}}"
      });
    }
  }
  for (const placeholder of placeholderSet) {
    if (!(placeholder in replacements)) {
      context.addIssue({
        code: "custom",
        path: ["replacements"],
        message: "Missing item-scoped replacement for {{" + placeholder + "}}"
      });
    }
  }
}

function addDuplicateIssues(
  entries: ReadonlyArray<Record<string, unknown>>,
  field: string,
  context: z.RefinementCtx,
  key = "id"
): void {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const value = entry[key];
    if (typeof value !== "string") return;
    if (seen.has(value)) {
      context.addIssue({ code: "custom", path: [field, index, key], message: "Duplicate " + key + " " + value });
    }
    seen.add(value);
  });
}

function uniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/**
 * Order-sensitive structural comparison. Lane order is itself part of the recorded plan, so a
 * reordered `goal_lanes` is a different document and must not be silently accepted.
 */
function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const vulnerabilityDatabaseManifestSchema = z.looseObject({
  schema_version: nonEmptyString,
  database_schema_version: z.number().int().positive(),
  aggregate_sha256: sha256,
  catalog_sha256: sha256,
  records: z.array(
    z.looseObject({
      id: stableId,
      path: nonEmptyString,
      sha256,
      size_bytes: z.number().int().nonnegative()
    })
  ),
  selected_records: z.array(
    z.looseObject({
      id: stableId,
      path: nonEmptyString,
      artifact_path: selectedRecordSchema.shape.path,
      sha256,
      size_bytes: z.number().int().nonnegative()
    })
  )
});
