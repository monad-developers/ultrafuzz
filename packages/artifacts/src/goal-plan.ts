import fs from "node:fs";

import { z } from "zod/v4";

import { isNamespacedDynamicReplacementKey, promptTemplateOccurrences } from "@ultrafuzz/prompts";

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

export const GOAL_PLAN_SCHEMA_VERSION = "ultrafuzz.goal-plan.v1" as const;
export const GOAL_PLAN_POLICY = "additive-v1" as const;
export const GOAL_PLAN_JSON_SCHEMA_ID = "https://blog.monad.xyz/blog/ultrafuzz#schema/artifacts/goal-plan" as const;

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
const replacementsSchema = z
  .record(replacementKey, z.union([nonEmptyString, z.number().finite(), z.boolean()]))
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
    threat_ids: z.tuple([threatId]),
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

/**
 * Composes the canonical safe-relative-path validator with the required prefix and `.md` suffix.
 * The raw value must already be canonical, so `.`, `..`, `./`, empty, and nested traversal
 * segments are rejected in the contract instead of only being caught by a later filesystem check.
 * Remote and in-memory consumers of the exported snapshot verifier get the same guarantee.
 */
const selectedRecordPath = z.string().superRefine((value, context) => {
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
  if (!value.endsWith(".md")) {
    context.addIssue({ code: "custom", message: "Selected record path must be a Markdown file" });
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
    })
  })
  .superRefine((value, context) => {
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

    const expected = {
      threats: value.threat_goals.length,
      applicable_classes: value.class_goals.length,
      inapplicable_classes: value.applicability_decisions.filter((item) => item.decision === "inapplicable").length,
      dynamic_goals: value.threat_goals.length + value.class_goals.length,
      total_goals: value.threat_goals.length + value.class_goals.length + 1
    };
    for (const [field, count] of Object.entries(expected)) {
      if (value.counts[field as keyof typeof expected] !== count) {
        context.addIssue({ code: "custom", path: ["counts", field], message: "Count must equal " + String(count) });
      }
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

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
