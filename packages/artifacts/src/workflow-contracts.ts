import { z } from "zod/v4";
import { artifactValidationWarningsSchema } from "./artifact-validation.js";
import { reportCompletionSchema } from "./report-completion.js";
import { reportObservedCompletionSchema, reportVerificationSchema } from "./report-observation.js";

import {
  MAX_FINDINGS,
  MAX_FINDING_NESTED_ITEMS,
  findingLifecycleSchema,
  findingLifecycleStageSchema,
  findingNoteSchema,
  findingReportBoundTextSchema,
  findingSchema,
  findingStrategyHitSchema,
  findingTextSchema
} from "./findings-schema.js";
import { FINDING_SEVERITIES, TRIAGE_CLASSIFICATIONS } from "./findings.js";
import { MAX_COVERAGE_EVIDENCE_RANGES, coverageBlockerSchema, coverageEvidenceSchema } from "./coverage-evidence.js";
import {
  MAX_AGGREGATION_ABSOLUTE_PATH_CHARS,
  MAX_AGGREGATION_REASON_CHARS,
  MAX_AGGREGATION_SOURCE_BUNDLES,
  MAX_AGGREGATION_SOURCE_ENTRIES,
  MAX_GENERATED_TEST_BUNDLE_ENTRIES,
  MAX_GENERATED_TEST_PATH_BYTES,
  MAX_GENERATED_TEST_PATH_SEGMENTS
} from "./artifact-limits.js";
import {
  generatedTestEntrySchema,
  generatedTestFrameworkSchema,
  generatedTestPathSchema,
  generatedTestProvenanceSchema
} from "./generated-test-schema.js";
import { canonicalTimestampSchema } from "./portable-json-primitives.js";
import { PROPERTY_PRIORITIES } from "./property-provenance.js";
import { SAFE_ID_PATTERN } from "./safe-paths.js";
import { validateWithZod, type SchemaValidationResult } from "./schema-validation.js";
import { canonicalJsonValueKey } from "./lang-primitives.js";

const nonEmptyString = z.string().min(1);
const nonNegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
const timestamp = canonicalTimestampSchema;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const gitCommit = z.string().regex(/^[0-9a-f]{40}$/u);
const uniqueStrings = (minimum = 0) =>
  z
    .array(nonEmptyString)
    .min(minimum)
    .meta({ uniqueItems: true })
    .refine((values) => new Set(values).size === values.length, { message: "Values must be unique" });
const stringList = z.array(nonEmptyString);

function uniqueJsonValues<T extends z.ZodType>(item: T, maximum: number): z.ZodArray<T> {
  return z
    .array(item)
    .max(maximum)
    .meta({ uniqueItems: true })
    .superRefine((values, context) => {
      const seen = new Set<string>();
      for (const [index, value] of values.entries()) {
        const key = canonicalJsonValueKey(value);
        if (seen.has(key)) {
          context.addIssue({ code: "custom", message: "Array entries must be unique", path: [index] });
        }
        seen.add(key);
      }
    }) as z.ZodArray<T>;
}

function withDocumentMetadata<T extends z.ZodType>(schema: T, slug: string, version: number, title: string): T {
  return schema.meta({
    $id: `urn:ultrafuzz:schema:artifacts:${slug}:${version}`,
    title
  }) as T;
}

export const HARNESS_REPAIRS_SCHEMA_VERSION = "ultrafuzz.harness-repairs.v1" as const;
export const STRATEGY_DETECTIONS_SCHEMA_VERSION = "ultrafuzz.strategy-detections.v1" as const;
export const TRIAGED_FINDINGS_SCHEMA_VERSION = "ultrafuzz.triaged-findings.v1" as const;
export const SEVERITY_CLASSIFIED_FINDINGS_SCHEMA_VERSION = "ultrafuzz.severity-classified-findings.v1" as const;
export const REFERENCE_MANIFEST_SCHEMA_VERSION = "ultrafuzz.reference-manifest.v1" as const;
export const BOUNDARY_RECIPES_SCHEMA_VERSION = "ultrafuzz.boundary-recipes.v1" as const;
export const ADMIN_CONFIG_BOUNDARY_MATRIX_SCHEMA_VERSION = "ultrafuzz.admin-config-boundary-matrix.v1" as const;
export const DEPENDENCY_SCOPE_MATRIX_SCHEMA_VERSION = "ultrafuzz.dependency-scope-matrix.v1" as const;
export const EXTERNALIZED_STATE_ACCOUNTING_SCHEMA_VERSION = "ultrafuzz.externalized-state-accounting.v1" as const;
export const COVERAGE_GOAL_SCHEMA_VERSION = "ultrafuzz.coverage-goal.v2" as const;
export const INVARIANT_CAMPAIGN_PLAN_SCHEMA_VERSION = "ultrafuzz.invariant-campaign-plan.v2" as const;
export const CAMPAIGN_SUMMARY_SCHEMA_VERSION = "ultrafuzz.campaign-summary.v2" as const;
export const DIFFERENTIAL_PLAN_SCHEMA_VERSION = "ultrafuzz.differential-plan.v1" as const;
export const REFERENCE_HARNESS_SCHEMA_VERSION = "ultrafuzz.reference-harness.v1" as const;
export const AUDITED_DIFFERENTIAL_LANES_SCHEMA_VERSION = "ultrafuzz.audited-differential-lanes.v1" as const;
export const DIFFERENTIAL_LANE_RESULT_SCHEMA_VERSION = "ultrafuzz.differential-lane-result.v1" as const;
export const SEMANTIC_RED_REGISTRY_SCHEMA_VERSION = "ultrafuzz.semantic-red-registry.v1" as const;
export const DIFFERENTIAL_RED_TRIAGE_SCHEMA_VERSION = "ultrafuzz.differential-red-triage.v1" as const;
export const DIFFERENTIAL_REPAIR_SUMMARY_SCHEMA_VERSION = "ultrafuzz.differential-repair-summary.v1" as const;
export const DIFFERENTIAL_GAP_REVIEW_SCHEMA_VERSION = "ultrafuzz.differential-gap-review.v1" as const;
export const DIFFERENTIAL_REPORT_REVIEW_SCHEMA_VERSION = "ultrafuzz.differential-report-review.v1" as const;
export const DYNAMIC_STRATEGY_PLAN_SCHEMA_VERSION = "ultrafuzz.dynamic-strategy-plan.v1" as const;
export const DYNAMIC_ENUMERATOR_OUTPUTS_SCHEMA_VERSION = "ultrafuzz.dynamic-enumerator-outputs.v1" as const;
export const SELECTED_STRATEGIES_SCHEMA_VERSION = "ultrafuzz.selected-strategies.v1" as const;
export const DYNAMIC_STRATEGY_PROVENANCE_SCHEMA_VERSION = "ultrafuzz.dynamic-strategy-provenance.v1" as const;
export const FINDING_LIFECYCLE_LEDGER_SCHEMA_VERSION = "ultrafuzz.finding-lifecycle-ledger.v1" as const;
export const AGGREGATION_MANIFEST_SCHEMA_VERSION = "ultrafuzz.aggregation-manifest.v1" as const;
export const REPORT_SCHEMA_VERSION = "ultrafuzz.report.v3" as const;

const harnessRepairEntrySchema = z
  .strictObject({
    failure_id: nonEmptyString,
    classification: z.literal("harness-defect"),
    failure_summary: nonEmptyString,
    reproducer_path: nonEmptyString.nullable(),
    reproducer_unavailable_reason: nonEmptyString.optional(),
    repair_summary: nonEmptyString,
    files_changed_or_proposed: uniqueStrings(),
    commands: uniqueStrings(),
    notes: uniqueStrings()
  })
  .meta({
    allOf: [
      {
        if: { properties: { reproducer_path: { type: "null" } }, required: ["reproducer_path"] },
        then: {
          properties: { reproducer_unavailable_reason: true },
          required: ["reproducer_unavailable_reason"]
        },
        else: {
          not: {
            properties: { reproducer_unavailable_reason: true },
            required: ["reproducer_unavailable_reason"]
          }
        }
      }
    ]
  })
  .superRefine((repair, context) => {
    if (repair.reproducer_path === null && repair.reproducer_unavailable_reason === undefined) {
      context.addIssue({
        code: "custom",
        message: "A missing reproducer requires reproducer_unavailable_reason",
        path: ["reproducer_unavailable_reason"]
      });
    }
    if (repair.reproducer_path !== null && repair.reproducer_unavailable_reason !== undefined) {
      context.addIssue({
        code: "custom",
        message: "reproducer_unavailable_reason is only valid when reproducer_path is null",
        path: ["reproducer_unavailable_reason"]
      });
    }
  });

export const harnessRepairsSchema = withDocumentMetadata(
  z.array(harnessRepairEntrySchema),
  "harness-repairs",
  1,
  "Ultrafuzz harness repair records"
);

const strategyDetectionSchema = z.strictObject({
  dedupe_key: findingTextSchema,
  finding_id: findingTextSchema.optional(),
  family_id: findingTextSchema.optional(),
  title: findingTextSchema,
  hits: z.array(findingStrategyHitSchema).min(1).max(MAX_FINDING_NESTED_ITEMS)
});

export const strategyDetectionsSchema = withDocumentMetadata(
  z.array(strategyDetectionSchema).max(MAX_FINDINGS),
  "strategy-detections",
  1,
  "Ultrafuzz strategy detection provenance"
);

const triagedFindingSchema = findingSchema
  .safeExtend({
    triage_classification: z.enum(TRIAGE_CLASSIFICATIONS),
    notes: z.array(findingNoteSchema).min(1).max(MAX_FINDING_NESTED_ITEMS)
  })
  .meta({
    allOf: [
      {
        properties: {
          notes: {
            type: "array",
            contains: { type: "string", pattern: "^(?:triage_reason|classification_reason)=" },
            minContains: 1
          }
        }
      },
      {
        if: {
          properties: {
            triage_classification: {
              enum: [
                "false-positive",
                "incomplete-spec",
                "harness-defect",
                "repair-candidate",
                "spec-gated",
                "defensive-hardening"
              ]
            }
          },
          required: ["triage_classification"]
        },
        then: {
          properties: {
            notes: {
              type: "array",
              contains: { type: "string", pattern: "^demotion_reason=" },
              minContains: 1
            }
          }
        }
      }
    ]
  })
  .superRefine((finding, context) => {
    if (!finding.notes.some((note) => /^(?:triage_reason|classification_reason)=/u.test(note))) {
      context.addIssue({ code: "custom", message: "Triage requires a machine-readable reason note", path: ["notes"] });
    }
    if (
      [
        "false-positive",
        "incomplete-spec",
        "harness-defect",
        "repair-candidate",
        "spec-gated",
        "defensive-hardening"
      ].includes(finding.triage_classification) &&
      !finding.notes.some((note) => note.startsWith("demotion_reason="))
    ) {
      context.addIssue({ code: "custom", message: "A demoted finding requires demotion_reason", path: ["notes"] });
    }
  });

export const triagedFindingsSchema = withDocumentMetadata(
  z.array(triagedFindingSchema).max(MAX_FINDINGS),
  "triaged-findings",
  1,
  "Ultrafuzz triaged findings"
);

const severityClassifiedFindingSchema = findingSchema
  .safeExtend({
    triage_classification: z.enum(TRIAGE_CLASSIFICATIONS),
    // Severity review must preserve the already-validated triage notes byte for
    // byte, but the copied values remain inside the report-vocabulary trust
    // boundary and are therefore validated again at this contract boundary.
    notes: z.array(findingNoteSchema).max(MAX_FINDING_NESTED_ITEMS).optional(),
    severity: z.enum(FINDING_SEVERITIES).optional(),
    impact: z.enum(FINDING_SEVERITIES).optional(),
    likelihood: z.enum(FINDING_SEVERITIES).optional(),
    impact_rationale: findingReportBoundTextSchema.optional(),
    likelihood_rationale: findingReportBoundTextSchema.optional(),
    severity_rationale: findingReportBoundTextSchema.optional()
  })
  .meta({
    allOf: [
      {
        if: {
          properties: { triage_classification: { const: "true-positive" } },
          required: ["triage_classification"]
        },
        then: {
          properties: {
            severity: true,
            impact: true,
            likelihood: true,
            impact_rationale: true,
            likelihood_rationale: true,
            severity_rationale: true
          },
          required: [
            "severity",
            "impact",
            "likelihood",
            "impact_rationale",
            "likelihood_rationale",
            "severity_rationale"
          ]
        }
      }
    ]
  })
  .superRefine((finding, context) => {
    if (finding.triage_classification !== "true-positive") return;
    for (const key of [
      "severity",
      "impact",
      "likelihood",
      "impact_rationale",
      "likelihood_rationale",
      "severity_rationale"
    ] as const) {
      if (finding[key] === undefined) {
        context.addIssue({
          code: "custom",
          message: "Production candidates require final classification fields",
          path: [key]
        });
      }
    }
  });

export const severityClassifiedFindingsSchema = withDocumentMetadata(
  z.array(severityClassifiedFindingSchema).max(MAX_FINDINGS),
  "severity-classified-findings",
  1,
  "Ultrafuzz severity-classified findings"
);

const referenceManifestFileSchema = z.strictObject({
  path: nonEmptyString,
  size_bytes: nonNegativeInteger,
  sha256
});

export const referenceManifestSchema = withDocumentMetadata(
  z.strictObject({
    schema_version: z.literal(REFERENCE_MANIFEST_SCHEMA_VERSION),
    reference: nonEmptyString,
    provider: z.literal("github"),
    repo: nonEmptyString,
    commit: gitCommit,
    resolved_at: timestamp,
    kind: z.enum(["document", "vulnerability-database"]).optional(),
    source_files: z.array(referenceManifestFileSchema),
    artifacts: z.array(referenceManifestFileSchema).min(1)
  }),
  "reference-manifest",
  1,
  "Ultrafuzz materialized reference manifest"
);

const classification = z.enum([
  "production-bug",
  "implementation-drift",
  "incomplete-spec",
  "harness-defect",
  "inconclusive"
]);

const boundaryRecipeSchema = z.strictObject({
  id: nonEmptyString,
  title: nonEmptyString,
  path: nonEmptyString,
  workflow: nonEmptyString,
  public_support: uniqueStrings(1),
  setup: stringList,
  action_sequence: stringList.min(1),
  oracle: nonEmptyString,
  boundary_values: stringList.min(1),
  expected_classification_if_red: classification,
  preferred_downstream_lane: nonEmptyString,
  finding_ids: uniqueStrings().optional(),
  property_ids: uniqueStrings().optional(),
  summary: nonEmptyString.optional()
});

export const boundaryRecipesSchema = withDocumentMetadata(
  z.strictObject({
    schema_version: z.literal(BOUNDARY_RECIPES_SCHEMA_VERSION),
    recipes: z.array(boundaryRecipeSchema),
    deferred_or_spec_gated: z.array(
      z.strictObject({ id: nonEmptyString, reason: nonEmptyString, evidence_paths: uniqueStrings() })
    ),
    coverage_priorities: z.array(
      z.strictObject({
        workflow: nonEmptyString,
        priority: z.enum(PROPERTY_PRIORITIES),
        rationale: nonEmptyString.optional()
      })
    )
  }),
  "boundary-recipes",
  1,
  "Ultrafuzz boundary recipes"
);

const adminSurfaceClassification = z.enum([
  "production-bug",
  "implementation-drift",
  "incomplete-spec",
  "harness-defect",
  "inconclusive"
]);
const adminSurfaceSchema = z.strictObject({
  surface_id: nonEmptyString,
  module_family: nonEmptyString,
  contract_or_interface: nonEmptyString,
  documented_name: nonEmptyString,
  implementation_name: nonEmptyString,
  selector: nonEmptyString.nullable(),
  authorization_model: nonEmptyString,
  getter_or_reflection_path: nonEmptyString.nullable(),
  source_evidence: uniqueStrings(1),
  selected_test_cases: uniqueStrings(),
  classification: adminSurfaceClassification
});

export const adminConfigBoundaryMatrixSchema = withDocumentMetadata(
  z.strictObject({
    schema_version: z.literal(ADMIN_CONFIG_BOUNDARY_MATRIX_SCHEMA_VERSION),
    surfaces: z.array(adminSurfaceSchema),
    selector_mismatches: z.array(
      z.strictObject({
        surface_id: nonEmptyString,
        documented_name: nonEmptyString,
        implementation_name: nonEmptyString,
        documented_selector: nonEmptyString.nullable(),
        implementation_selector: nonEmptyString.nullable(),
        evidence_paths: uniqueStrings(1),
        classification: z.enum(["implementation-drift", "incomplete-spec"]),
        reason: nonEmptyString
      })
    ),
    ambiguous_or_incomplete_specs: z.array(
      z.strictObject({
        surface_id: nonEmptyString,
        classification: z.enum(["implementation-drift", "incomplete-spec"]),
        reason: nonEmptyString,
        evidence_paths: uniqueStrings(1)
      })
    ),
    generated_tests: z.array(z.strictObject({ path: nonEmptyString, checks: uniqueStrings(1) })),
    coverage_notes: z.array(z.strictObject({ surface_id: nonEmptyString, reason: nonEmptyString })).optional()
  }),
  "admin-config-boundary-matrix",
  1,
  "Ultrafuzz admin and configuration boundary matrix"
);

const dependencyClassification = z.enum([
  "protocol-owned/in-scope",
  "explicitly-trusted/assumed-correct",
  "documented-out-of-scope-or-known-risk",
  "unknown/ambiguous"
]);
const dependencyRowSchema = z.strictObject({
  dependency_id: nonEmptyString,
  contract_or_interface: nonEmptyString,
  dependency_type: nonEmptyString,
  touched_functions: uniqueStrings(),
  classification: dependencyClassification,
  source_evidence: uniqueStrings(1),
  source_backed_scope_claim: nonEmptyString,
  in_scope_rationale: nonEmptyString.nullable().optional(),
  selected_test_cases: uniqueStrings(),
  expected_classification_if_red: z
    .enum(["production-bug", "incomplete-spec", "harness-defect", "false-positive"])
    .nullable(),
  scope_notes: stringList.optional(),
  harness_notes: stringList.optional()
});

export const dependencyScopeMatrixSchema = withDocumentMetadata(
  z.strictObject({
    schema_version: z.literal(DEPENDENCY_SCOPE_MATRIX_SCHEMA_VERSION),
    dependencies: z.array(dependencyRowSchema),
    in_scope_test_targets: z.array(z.strictObject({ dependency_id: nonEmptyString, rationale: nonEmptyString })),
    non_finding_rows: z.array(z.strictObject({ dependency_id: nonEmptyString, reason: nonEmptyString })),
    generated_tests: z.array(z.strictObject({ path: nonEmptyString, checks: uniqueStrings(1) })),
    source_backed_in_scope_rationales: z.array(
      z.strictObject({
        finding_candidate_id: nonEmptyString,
        dependency_id: nonEmptyString,
        evidence_paths: uniqueStrings(1)
      })
    ),
    coverage_notes: z.array(z.strictObject({ dependency_id: nonEmptyString, reason: nonEmptyString })).optional()
  }),
  "dependency-scope-matrix",
  1,
  "Ultrafuzz dependency scope matrix"
);

export const externalizedStateAccountingSchema = withDocumentMetadata(
  z.strictObject({
    schema_version: z.literal(EXTERNALIZED_STATE_ACCOUNTING_SCHEMA_VERSION),
    state_components: z.array(
      z.strictObject({
        component_id: nonEmptyString,
        name: nonEmptyString,
        category: nonEmptyString,
        economic_relevance: nonEmptyString,
        public_evidence: uniqueStrings(1),
        actors: uniqueStrings(1),
        mutation_paths: uniqueStrings(),
        settlement_or_claim_paths: uniqueStrings(),
        value_reads: uniqueStrings()
      })
    ),
    scenarios: z.array(
      z.strictObject({
        scenario_id: nonEmptyString,
        title: nonEmptyString,
        actors: uniqueStrings(1),
        preconditions: stringList,
        actions: stringList.min(1),
        state_component_ids: uniqueStrings(1),
        expected_outcome: nonEmptyString,
        test_path: nonEmptyString.nullable()
      })
    ),
    accounting_oracles: z.array(
      z.strictObject({
        oracle_id: nonEmptyString,
        state_component_ids: uniqueStrings(1),
        assertion: nonEmptyString,
        public_basis: uniqueStrings(1),
        rounding_rule: nonEmptyString.nullable()
      })
    ),
    generated_tests: z.array(z.strictObject({ path: nonEmptyString, scenario_ids: uniqueStrings(1) })),
    incomplete_specs: z.array(
      z.strictObject({ subject: nonEmptyString, reason: nonEmptyString, evidence_paths: uniqueStrings() })
    ),
    coverage_notes: stringList.optional()
  }),
  "externalized-state-accounting",
  1,
  "Ultrafuzz externalized-state accounting model"
);

export const coverageGoalSchema = withDocumentMetadata(
  z
    .strictObject({
      schema_version: z.literal(COVERAGE_GOAL_SCHEMA_VERSION),
      target: z.strictObject({
        scope: z.literal("recon-selected-declaration-completeness"),
        minimum_percent: z.literal(90)
      }),
      current_measurement: z
        .strictObject({
          scope: z.literal("recon-selected-declaration-completeness"),
          covered_ranges: z.number().int().nonnegative().max(MAX_COVERAGE_EVIDENCE_RANGES),
          total_ranges: z.number().int().nonnegative().max(MAX_COVERAGE_EVIDENCE_RANGES)
        })
        .refine((measurement) => measurement.covered_ranges <= measurement.total_ranges, {
          message: "covered_ranges cannot exceed total_ranges"
        })
        .nullable(),
      current_status: z.enum(["not-run", "in-progress", "target-met", "below-target", "blocked"]),
      planned_commands: uniqueStrings(),
      stop_conditions: uniqueStrings(1),
      timeout_seconds: positiveInteger,
      finalization_reserve_seconds: nonNegativeInteger,
      blockers: z.array(coverageBlockerSchema)
    })
    .meta({
      allOf: [
        {
          if: { properties: { current_status: { const: "not-run" } }, required: ["current_status"] },
          then: {
            properties: {
              current_measurement: { type: "null" },
              blockers: { type: "array", maxItems: 0 }
            }
          }
        },
        {
          if: { properties: { current_status: { const: "in-progress" } }, required: ["current_status"] },
          then: { properties: { blockers: { type: "array", maxItems: 0 } } }
        },
        {
          if: {
            properties: { current_status: { enum: ["target-met", "below-target"] } },
            required: ["current_status"]
          },
          then: {
            properties: {
              current_measurement: { type: "object" },
              blockers: { type: "array", maxItems: 0 }
            }
          }
        },
        {
          if: { properties: { current_status: { const: "blocked" } }, required: ["current_status"] },
          then: {
            properties: {
              current_measurement: { type: "null" },
              blockers: { type: "array", minItems: 1 }
            }
          }
        }
      ]
    })
    .superRefine((goal, context) => {
      const addIssue = (path: "current_measurement" | "blockers", message: string) =>
        context.addIssue({ code: "custom", message, path: [path] });
      if (goal.current_status === "not-run") {
        if (goal.current_measurement !== null) {
          addIssue("current_measurement", "Coverage that has not run cannot report a measurement");
        }
        if (goal.blockers.length > 0) {
          addIssue("blockers", "Coverage that has not run cannot report blockers; use blocked status");
        }
      } else if (goal.current_status === "in-progress") {
        if (goal.blockers.length > 0) {
          addIssue("blockers", "In-progress coverage cannot report terminal blockers; use blocked status");
        }
      } else if (goal.current_status === "target-met" || goal.current_status === "below-target") {
        if (goal.current_measurement === null) {
          addIssue("current_measurement", "Terminal measured coverage requires exact scoped counts");
        } else {
          const targetMet =
            goal.current_measurement.total_ranges > 0 &&
            BigInt(goal.current_measurement.covered_ranges) * 100n >=
              BigInt(goal.current_measurement.total_ranges) * BigInt(goal.target.minimum_percent);
          if ((goal.current_status === "target-met") !== targetMet) {
            addIssue(
              "current_measurement",
              `Coverage status must be ${targetMet ? "target-met" : "below-target"} for the exact scoped counts; 0/0 is below-target`
            );
          }
        }
        if (goal.blockers.length > 0) {
          addIssue("blockers", "Terminal measured coverage cannot carry blockers; use blocked status");
        }
      } else {
        if (goal.current_measurement !== null) {
          addIssue("current_measurement", "Blocked coverage cannot report a measurement");
        }
        if (goal.blockers.length === 0) {
          addIssue("blockers", "Blocked coverage requires at least one typed blocker");
        }
      }
    }),
  "coverage-goal",
  2,
  "Ultrafuzz invariant coverage goal"
);

export const invariantCampaignPlanSchema = withDocumentMetadata(
  z.strictObject({
    schema_version: z.literal(INVARIANT_CAMPAIGN_PLAN_SCHEMA_VERSION),
    available_vcpus: positiveInteger,
    workers: positiveInteger,
    configured_budget_seconds: positiveInteger,
    deadline: timestamp,
    finalization_reserve_seconds: nonNegativeInteger,
    configured_fuzzer_timeout_seconds: positiveInteger,
    recon_internal_timeout_seconds: positiveInteger,
    recon_test_limit: nonEmptyString,
    recon_sequence_length: positiveInteger,
    host_soft_timeout_seconds: positiveInteger,
    host_force_kill_grace_seconds: positiveInteger,
    artifact_finalization_reserve_seconds: positiveInteger,
    backend_started_at: timestamp,
    fuzzing_deadline_utc: timestamp,
    force_kill_deadline_utc: timestamp,
    final_artifact_deadline_utc: timestamp,
    backend: z.strictObject({
      name: z.literal("recon"),
      version: nonEmptyString.nullable(),
      exact_shell_escaped_command: nonEmptyString
    }),
    command_plan: z.array(
      z.strictObject({ phase: z.enum(["validation", "smoke", "campaign", "finalization"]), command: nonEmptyString })
    ),
    paths: z.strictObject({
      corpus: nonEmptyString,
      cache: nonEmptyString,
      log: nonEmptyString,
      raw_results: nonEmptyString,
      reproducers: nonEmptyString
    })
  }),
  "invariant-campaign-plan",
  2,
  "Ultrafuzz current invariant campaign plan"
);

export const campaignSummarySchema = withDocumentMetadata(
  z.strictObject({
    schema_version: z.literal(CAMPAIGN_SUMMARY_SCHEMA_VERSION),
    outcome: z.enum(["complete", "partial", "blocked"]),
    sequence_length: positiveInteger,
    reason: nonEmptyString.max(4_000).optional(),
    implemented_property_suite_refs: uniqueStrings(1),
    campaign_plan_ref: nonEmptyString,
    backend_results: z.array(
      z.strictObject({
        fuzzer_backend: nonEmptyString,
        status: z.enum(["complete", "partial", "blocked", "failed", "timed-out", "unavailable"]),
        result_ref: nonEmptyString
      })
    ),
    finding_refs: uniqueStrings(),
    reproducer_refs: z.array(
      z.strictObject({
        finding_id: nonEmptyString,
        path: nonEmptyString.nullable(),
        blocker: nonEmptyString.nullable()
      })
    ),
    failure_counts: z.strictObject({
      pre_deduplication: nonNegativeInteger,
      post_deduplication: nonNegativeInteger
    })
  }),
  "campaign-summary",
  2,
  "Ultrafuzz invariant campaign summary"
);

const differentialCandidateSurfaceSchema = z.strictObject({
  surface_id: nonEmptyString,
  public_entrypoints: uniqueStrings(),
  public_evidence_paths: uniqueStrings(1),
  oracle_basis: stringList,
  in_scope_behavior: stringList,
  out_of_scope_behavior: stringList,
  ambiguities: stringList,
  priority: z.enum(PROPERTY_PRIORITIES)
});

const plannedDifferentialLaneSchema = z.strictObject({
  lane_id: nonEmptyString,
  planner_attempt_index: nonNegativeInteger,
  surface_id: nonEmptyString,
  intended_t_sol_path: nonEmptyString,
  focused_command: nonEmptyString,
  public_evidence_paths: uniqueStrings(1),
  observable_equality_assertions: stringList.min(1),
  oracle_type: z.enum(["independent_reference", "metamorphic", "self_consistency", "sanity_probe"]),
  calibration_bucket: z.enum(["red_seeking_adversarial", "green_safe_sanity"]),
  red_seeking_priority: z.enum(PROPERTY_PRIORITIES)
});

export const differentialPlanSchema = withDocumentMetadata(
  z.strictObject({
    schema_version: z.literal(DIFFERENTIAL_PLAN_SCHEMA_VERSION),
    planner_attempt_index: nonNegativeInteger,
    candidate_surfaces: z.array(differentialCandidateSurfaceSchema),
    reference_model_rules: z.strictObject({
      allowed_structures: uniqueStrings(1),
      forbidden_sources: uniqueStrings(1)
    }),
    deployment_assumptions: stringList,
    phase_priorities: stringList,
    assigned_differential_lanes: z.array(plannedDifferentialLaneSchema).max(3),
    deferred_lane_candidates: z.array(z.strictObject({ lane_id: nonEmptyString, reason: nonEmptyString })),
    out_of_scope_surfaces: z.array(z.strictObject({ surface_id: nonEmptyString, reason: nonEmptyString }))
  }),
  "differential-plan",
  1,
  "Ultrafuzz differential oracle plan"
);

export const referenceHarnessSchema = withDocumentMetadata(
  z.strictObject({
    schema_version: z.literal(REFERENCE_HARNESS_SCHEMA_VERSION),
    harness_author_attempt_index: nonNegativeInteger,
    source_plan_artifacts: uniqueStrings(),
    authored_paths: uniqueStrings(),
    reference_models: z.array(
      z.strictObject({
        model_id: nonEmptyString,
        covered_surfaces: uniqueStrings(),
        public_evidence_paths: uniqueStrings(1),
        implementation_rules_applied: stringList,
        known_gaps: stringList,
        deployment_helpers: uniqueStrings()
      })
    ),
    validation: z.strictObject({
      commands: uniqueStrings(),
      passed: z.boolean(),
      compiler_errors: stringList,
      notes: stringList
    }),
    lane_readiness_notes: stringList
  }),
  "reference-harness",
  1,
  "Ultrafuzz differential reference harness"
);

const readyDifferentialLaneSchema = z.strictObject({
  lane_id: nonEmptyString,
  attempt_index: nonNegativeInteger,
  auditor_attempt_index: nonNegativeInteger,
  planner_attempt_index: nonNegativeInteger,
  harness_author_attempt_index: nonNegativeInteger,
  source_plan_artifact: nonEmptyString,
  source_harness_artifact: nonEmptyString,
  surface_id: nonEmptyString,
  intended_t_sol_path: nonEmptyString,
  focused_command: nonEmptyString,
  public_evidence_paths: uniqueStrings(1),
  exact_observable_equality_assertions: stringList.min(1),
  oracle_type: z.enum(["independent_reference", "metamorphic", "self_consistency", "sanity_probe"]),
  calibration_bucket: z.enum(["red_seeking_adversarial", "green_safe_sanity"]),
  red_seeking_priority: z.enum(PROPERTY_PRIORITIES)
});

export const auditedDifferentialLanesSchema = withDocumentMetadata(
  z.strictObject({
    schema_version: z.literal(AUDITED_DIFFERENTIAL_LANES_SCHEMA_VERSION),
    auditor_attempt_index: nonNegativeInteger,
    source_plan_artifacts: uniqueStrings(),
    source_harness_artifacts: uniqueStrings(),
    surface_audits: z.array(
      z.strictObject({
        surface_id: nonEmptyString,
        status: z.enum(["conformant", "reference_gap", "ambiguous_spec", "out_of_scope", "ready"]),
        public_evidence_paths: uniqueStrings(),
        audit_notes: stringList,
        required_narrowing: stringList
      })
    ),
    ready_lanes: z.array(readyDifferentialLaneSchema).max(1),
    rejected_or_narrowed_lanes: z.array(
      z.strictObject({ lane_id: nonEmptyString, disposition: z.enum(["rejected", "narrowed"]), reason: nonEmptyString })
    ),
    reference_gap_work_orders: z.array(
      z.strictObject({ surface_id: nonEmptyString, summary: nonEmptyString, evidence_paths: uniqueStrings() })
    ),
    ambiguous_spec_work_orders: z.array(
      z.strictObject({ surface_id: nonEmptyString, summary: nonEmptyString, evidence_paths: uniqueStrings() })
    )
  }),
  "audited-differential-lanes",
  1,
  "Ultrafuzz audited differential lanes"
);

const differentialRedCandidateSchema = z.strictObject({
  stable_failure_hash: sha256,
  red_candidate_id: nonEmptyString,
  test_path: nonEmptyString,
  failing_test_name: nonEmptyString,
  focused_command: nonEmptyString,
  failure_signature: nonEmptyString,
  assertion: nonEmptyString,
  observed: nonEmptyString,
  expected: nonEmptyString,
  public_oracle_basis: uniqueStrings(1),
  classification: z.literal("untriaged")
});

export const differentialLaneResultSchema = withDocumentMetadata(
  z
    .strictObject({
      schema_version: z.literal(DIFFERENTIAL_LANE_RESULT_SCHEMA_VERSION),
      lane_id: nonEmptyString.nullable(),
      attempt_index: nonNegativeInteger,
      auditor_attempt_index: nonNegativeInteger,
      source_auditor_artifact: nonEmptyString,
      source_plan_artifact: nonEmptyString.nullable(),
      source_harness_artifact: nonEmptyString.nullable(),
      assigned_lane_payload: readyDifferentialLaneSchema.nullable(),
      authored_paths: uniqueStrings(),
      focused_command: nonEmptyString.nullable(),
      focused_command_ran: z.boolean(),
      matched_test_count: nonNegativeInteger,
      status: z.enum(["green", "semantic_red_frozen", "compile_or_harness_defect", "no_assigned_lane"]),
      red_preservation_audit: z.strictObject({
        result: z.enum(["no_semantic_red_observed", "semantic_red_frozen", "not_applicable"]),
        pre_repair_file_hash: sha256.nullable(),
        assertion_predicate: nonEmptyString.nullable()
      }),
      red_candidates: z.array(differentialRedCandidateSchema),
      compile_or_harness_defects: z.array(
        z.strictObject({
          stable_failure_hash: sha256,
          category: z.enum(["compile", "harness"]),
          summary: nonEmptyString,
          evidence_paths: uniqueStrings()
        })
      ),
      public_evidence_paths: uniqueStrings(),
      notes: stringList
    })
    .meta({
      allOf: [
        {
          if: {
            properties: {
              status: { enum: ["green", "semantic_red_frozen", "compile_or_harness_defect"] }
            },
            required: ["status"]
          },
          then: {
            properties: {
              lane_id: { type: "string", minLength: 1 },
              source_plan_artifact: { type: "string", minLength: 1 },
              source_harness_artifact: { type: "string", minLength: 1 },
              assigned_lane_payload: { type: "object" },
              authored_paths: { type: "array", minItems: 1 },
              focused_command: { type: "string", minLength: 1 }
            }
          }
        },
        {
          if: { properties: { status: { const: "no_assigned_lane" } }, required: ["status"] },
          then: {
            properties: {
              lane_id: { type: "null" },
              source_plan_artifact: { type: "null" },
              source_harness_artifact: { type: "null" },
              assigned_lane_payload: { type: "null" },
              focused_command: { type: "null" },
              focused_command_ran: { const: false },
              matched_test_count: { const: 0 },
              authored_paths: { type: "array", maxItems: 0 },
              red_preservation_audit: {
                type: "object",
                properties: {
                  result: { const: "not_applicable" },
                  pre_repair_file_hash: { type: "null" },
                  assertion_predicate: { type: "null" }
                },
                required: ["result", "pre_repair_file_hash", "assertion_predicate"]
              },
              red_candidates: { type: "array", maxItems: 0 },
              compile_or_harness_defects: { type: "array", maxItems: 0 },
              public_evidence_paths: { type: "array", maxItems: 0 }
            }
          }
        },
        {
          if: { properties: { status: { const: "green" } }, required: ["status"] },
          then: {
            properties: {
              focused_command_ran: { const: true },
              matched_test_count: { type: "integer", minimum: 1 },
              red_preservation_audit: {
                type: "object",
                properties: {
                  result: { const: "no_semantic_red_observed" },
                  pre_repair_file_hash: { type: "null" },
                  assertion_predicate: { type: "null" }
                },
                required: ["result", "pre_repair_file_hash", "assertion_predicate"]
              },
              red_candidates: { type: "array", maxItems: 0 },
              compile_or_harness_defects: { type: "array", maxItems: 0 }
            }
          }
        },
        {
          if: { properties: { status: { const: "semantic_red_frozen" } }, required: ["status"] },
          then: {
            properties: {
              focused_command_ran: { const: true },
              matched_test_count: { type: "integer", minimum: 1 },
              red_candidates: { type: "array", minItems: 1 },
              compile_or_harness_defects: { type: "array", maxItems: 0 },
              red_preservation_audit: {
                type: "object",
                properties: {
                  result: { const: "semantic_red_frozen" },
                  pre_repair_file_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
                  assertion_predicate: { type: "string", minLength: 1 }
                },
                required: ["result", "pre_repair_file_hash", "assertion_predicate"]
              }
            }
          }
        },
        {
          if: { properties: { status: { const: "compile_or_harness_defect" } }, required: ["status"] },
          then: {
            properties: {
              focused_command_ran: { const: true },
              red_preservation_audit: {
                type: "object",
                properties: {
                  result: { const: "not_applicable" },
                  pre_repair_file_hash: { type: "null" },
                  assertion_predicate: { type: "null" }
                },
                required: ["result", "pre_repair_file_hash", "assertion_predicate"]
              },
              red_candidates: { type: "array", maxItems: 0 },
              compile_or_harness_defects: { type: "array", minItems: 1 }
            }
          }
        }
      ]
    })
    .superRefine((result, context) => {
      const addIssue = (path: string, message: string) =>
        context.addIssue({ code: "custom", message, path: path.split(".") });
      const requireAssignedLane = () => {
        if (result.lane_id === null) addIssue("lane_id", "An executed lane result requires lane_id");
        if (result.source_plan_artifact === null) {
          addIssue("source_plan_artifact", "An executed lane result requires its source plan artifact");
        }
        if (result.source_harness_artifact === null) {
          addIssue("source_harness_artifact", "An executed lane result requires its source harness artifact");
        }
        if (result.assigned_lane_payload === null) {
          addIssue("assigned_lane_payload", "An executed lane result requires its assigned lane payload");
        }
        if (result.authored_paths.length === 0) {
          addIssue("authored_paths", "An executed lane result requires at least one authored path");
        }
        if (result.focused_command === null) {
          addIssue("focused_command", "An executed lane result requires its focused command");
        }
      };
      const requireEmpty = (field: "red_candidates" | "compile_or_harness_defects" | "public_evidence_paths") => {
        if (result[field].length > 0) addIssue(field, `${field} must be empty for ${result.status}`);
      };
      const requireAudit = (
        auditResult: "no_semantic_red_observed" | "semantic_red_frozen" | "not_applicable",
        evidence: "present" | "absent"
      ) => {
        if (result.red_preservation_audit.result !== auditResult) {
          addIssue("red_preservation_audit.result", `Red preservation audit must be ${auditResult}`);
        }
        if (evidence === "present") {
          if (result.red_preservation_audit.pre_repair_file_hash === null) {
            addIssue("red_preservation_audit.pre_repair_file_hash", "A frozen semantic red requires a file hash");
          }
          if (result.red_preservation_audit.assertion_predicate === null) {
            addIssue("red_preservation_audit.assertion_predicate", "A frozen semantic red requires an assertion");
          }
        } else {
          if (result.red_preservation_audit.pre_repair_file_hash !== null) {
            addIssue("red_preservation_audit.pre_repair_file_hash", "This status cannot carry a frozen-red hash");
          }
          if (result.red_preservation_audit.assertion_predicate !== null) {
            addIssue("red_preservation_audit.assertion_predicate", "This status cannot carry a frozen-red assertion");
          }
        }
      };

      if (result.status === "no_assigned_lane") {
        if (result.lane_id !== null) addIssue("lane_id", "No-assigned-lane result requires a null lane_id");
        if (result.source_plan_artifact !== null) {
          addIssue("source_plan_artifact", "No-assigned-lane result requires a null source plan artifact");
        }
        if (result.source_harness_artifact !== null) {
          addIssue("source_harness_artifact", "No-assigned-lane result requires a null source harness artifact");
        }
        if (result.assigned_lane_payload !== null) {
          addIssue("assigned_lane_payload", "No-assigned-lane result cannot carry an assigned payload");
        }
        if (result.authored_paths.length > 0) addIssue("authored_paths", "No-assigned-lane result cannot author files");
        if (result.focused_command !== null) {
          addIssue("focused_command", "No-assigned-lane result requires a null focused command");
        }
        if (result.focused_command_ran) {
          addIssue("focused_command_ran", "No-assigned-lane result cannot report a command run");
        }
        if (result.matched_test_count !== 0) {
          addIssue("matched_test_count", "No-assigned-lane result cannot report matched tests");
        }
        requireAudit("not_applicable", "absent");
        requireEmpty("red_candidates");
        requireEmpty("compile_or_harness_defects");
        requireEmpty("public_evidence_paths");
        return;
      }

      requireAssignedLane();
      if (result.status === "green") {
        if (!result.focused_command_ran) addIssue("focused_command_ran", "Green requires the focused command to run");
        if (result.matched_test_count < 1) addIssue("matched_test_count", "Green requires at least one matched test");
        requireAudit("no_semantic_red_observed", "absent");
        requireEmpty("red_candidates");
        requireEmpty("compile_or_harness_defects");
      } else if (result.status === "semantic_red_frozen") {
        if (!result.focused_command_ran) {
          addIssue("focused_command_ran", "A frozen semantic red requires the focused command to run");
        }
        if (result.matched_test_count < 1) {
          addIssue("matched_test_count", "A frozen semantic red requires at least one matched test");
        }
        if (result.red_candidates.length === 0) {
          addIssue("red_candidates", "A frozen semantic red requires at least one red candidate");
        }
        requireEmpty("compile_or_harness_defects");
        requireAudit("semantic_red_frozen", "present");
      } else {
        if (!result.focused_command_ran) {
          addIssue("focused_command_ran", "A compile or harness defect requires the focused command to run");
        }
        requireEmpty("red_candidates");
        if (result.compile_or_harness_defects.length === 0) {
          addIssue("compile_or_harness_defects", "Defect status requires at least one typed defect");
        }
        requireAudit("not_applicable", "absent");
      }
    }),
  "differential-lane-result",
  1,
  "Ultrafuzz differential lane result"
);

const semanticRedSchema = z.strictObject({
  stable_failure_hash: sha256,
  lane_id: nonEmptyString,
  red_candidate_id: nonEmptyString,
  test_path: nonEmptyString,
  failing_test_name: nonEmptyString,
  focused_command: nonEmptyString,
  failure_signature: nonEmptyString,
  assertion: nonEmptyString,
  observed: nonEmptyString,
  expected: nonEmptyString,
  public_oracle_basis: uniqueStrings(1),
  classification: z.literal("untriaged"),
  pre_repair_file_hash: sha256
});

const compileHarnessDefectSchema = z.strictObject({
  stable_failure_hash: sha256,
  lane_id: nonEmptyString,
  category: z.enum(["compile", "harness"]),
  summary: nonEmptyString,
  evidence_paths: uniqueStrings()
});

export const semanticRedRegistrySchema = withDocumentMetadata(
  z.strictObject({
    schema_version: z.literal(SEMANTIC_RED_REGISTRY_SCHEMA_VERSION),
    semantic_reds: z.array(semanticRedSchema),
    compile_or_harness_defects: z.array(compileHarnessDefectSchema)
  }),
  "semantic-red-registry",
  1,
  "Ultrafuzz semantic red registry"
);

export const differentialRedTriageSchema = withDocumentMetadata(
  z.strictObject({
    schema_version: z.literal(DIFFERENTIAL_RED_TRIAGE_SCHEMA_VERSION),
    pass: z.enum(["a", "b"]),
    classifications: z.array(
      z.strictObject({
        stable_failure_hash: sha256,
        classification: z.enum([
          "harness_bug",
          "reference_bug",
          "production_bug",
          "spec_mismatch",
          "unknown",
          "compile_harness_defect"
        ]),
        rationale: nonEmptyString,
        public_evidence_paths: uniqueStrings(),
        repair_allowed: z.boolean()
      })
    )
  }),
  "differential-red-triage",
  1,
  "Ultrafuzz differential red triage"
);

export const differentialRepairSummarySchema = withDocumentMetadata(
  z.strictObject({
    schema_version: z.literal(DIFFERENTIAL_REPAIR_SUMMARY_SCHEMA_VERSION),
    repairs_attempted: z.array(
      z.strictObject({
        stable_failure_hash: sha256,
        repair_kind: z.enum(["harness", "reference"]),
        summary: nonEmptyString
      })
    ),
    repaired_failures: z.array(
      z.strictObject({
        stable_failure_hash: sha256,
        result: z.enum(["repaired", "still-red"]),
        evidence_paths: uniqueStrings()
      })
    ),
    preserved_production_or_unknown_reds: z.array(
      z.strictObject({
        stable_failure_hash: sha256,
        classification: z.enum(["production_bug", "spec_mismatch", "unknown"]),
        reason: nonEmptyString
      })
    ),
    commands: uniqueStrings(),
    semantic_red_registry_regenerated: z.boolean(),
    notes: stringList
  }),
  "differential-repair-summary",
  1,
  "Ultrafuzz differential repair summary"
);

const gapReadyLaneRowSchema = z.strictObject({
  lane_id: nonEmptyString,
  attempt_index: nonNegativeInteger,
  auditor_attempt_index: nonNegativeInteger,
  source_auditor_artifact: nonEmptyString
});
const gapLaneResultRowSchema = z.strictObject({
  lane_id: nonEmptyString.nullable(),
  attempt_index: nonNegativeInteger,
  auditor_attempt_index: nonNegativeInteger,
  source_auditor_artifact: nonEmptyString,
  status: z.enum(["green", "semantic_red_frozen", "compile_or_harness_defect", "no_assigned_lane"])
});
const workOrderSchema = z.strictObject({
  lane_id: nonEmptyString.nullable(),
  attempt_index: nonNegativeInteger,
  auditor_attempt_index: nonNegativeInteger,
  source_auditor_artifact: nonEmptyString,
  summary: nonEmptyString,
  evidence_paths: uniqueStrings()
});

export const differentialGapReviewSchema = withDocumentMetadata(
  z.strictObject({
    schema_version: z.literal(DIFFERENTIAL_GAP_REVIEW_SCHEMA_VERSION),
    ready_lanes: z.array(gapReadyLaneRowSchema),
    lane_results_seen: z.array(gapLaneResultRowSchema),
    missing_lane_work_orders: z.array(workOrderSchema),
    incomplete_campaign_work_orders: z.array(workOrderSchema),
    green_suite_evidence: z.array(
      z.strictObject({
        lane_id: nonEmptyString,
        attempt_index: nonNegativeInteger,
        auditor_attempt_index: nonNegativeInteger,
        source_auditor_artifact: nonEmptyString,
        command: nonEmptyString,
        matched_test_count: positiveInteger
      })
    ),
    report_blockers: z.array(
      z.strictObject({ category: nonEmptyString, summary: nonEmptyString, evidence_paths: uniqueStrings() })
    )
  }),
  "differential-gap-review",
  1,
  "Ultrafuzz differential gap review"
);

const reportReviewRowSchema = z.strictObject({
  stable_failure_hash: sha256,
  lane_id: nonEmptyString,
  summary: nonEmptyString,
  evidence_paths: uniqueStrings()
});

export const differentialReportReviewSchema = withDocumentMetadata(
  z.strictObject({
    schema_version: z.literal(DIFFERENTIAL_REPORT_REVIEW_SCHEMA_VERSION),
    campaign_status: z.enum(["complete", "incomplete", "blocked_by_preserved_reds"]),
    production_bug_reds: z.array(reportReviewRowSchema),
    harness_or_reference_repairs: z.array(reportReviewRowSchema),
    missing_or_deferred_lanes: z.array(workOrderSchema),
    report_rows_ready: z.array(reportReviewRowSchema),
    notes: stringList
  }),
  "differential-report-review",
  1,
  "Ultrafuzz differential report review"
);

const dynamicRecommendationSchema = z.strictObject({
  strategy_id: nonEmptyString,
  title: nonEmptyString,
  rationale: nonEmptyString.optional(),
  coverage_gap: nonEmptyString.optional(),
  evidence_paths: uniqueStrings(1),
  proposed_test_path: nonEmptyString,
  focused_command: nonEmptyString,
  priority: z.enum(PROPERTY_PRIORITIES)
});

const dynamicExcludedContextSchema = z.strictObject({
  sibling_runs: z.literal("excluded"),
  previous_reports: z.literal("excluded"),
  host_global_paths: z.literal("excluded"),
  network_resources: z.literal("excluded"),
  extra_target_context: z.literal("excluded")
});

export const dynamicStrategyPlanSchema = withDocumentMetadata(
  z
    .strictObject({
      schema_version: z.literal(DYNAMIC_STRATEGY_PLAN_SCHEMA_VERSION),
      // An audit profile may lift the enumerator entirely.
      dynamic_strategies_enumerator: z.union([nonNegativeInteger, z.literal("unlimited")]),
      status: z.enum(["selected", "no-actionable-strategies", "blocked"]),
      selected_strategy_count: nonNegativeInteger,
      selected_strategies: uniqueStrings(),
      rejected_strategies: z.array(z.strictObject({ strategy_id: nonEmptyString, reason: nonEmptyString })),
      current_run_artifacts_considered: z.array(z.strictObject({ path: nonEmptyString, relevance: nonEmptyString })),
      excluded_context: dynamicExcludedContextSchema,
      timeout_seconds: positiveInteger.nullable(),
      finalization_reserve_seconds: nonNegativeInteger.nullable()
    })
    .meta({
      allOf: [
        {
          if: { properties: { status: { const: "selected" } }, required: ["status"] },
          then: {
            properties: {
              selected_strategy_count: { type: "integer", minimum: 1 },
              selected_strategies: { type: "array", minItems: 1 }
            }
          }
        },
        {
          if: {
            properties: { status: { enum: ["no-actionable-strategies", "blocked"] } },
            required: ["status"]
          },
          then: {
            properties: {
              selected_strategy_count: { const: 0 },
              selected_strategies: { type: "array", maxItems: 0 }
            }
          }
        }
      ]
    })
    .superRefine((plan, context) => {
      if (plan.status === "selected") {
        if (plan.selected_strategy_count === 0) {
          context.addIssue({
            code: "custom",
            message: "Selected status requires at least one selected strategy",
            path: ["selected_strategy_count"]
          });
        }
        if (plan.selected_strategies.length === 0) {
          context.addIssue({
            code: "custom",
            message: "Selected status requires at least one selected strategy ID",
            path: ["selected_strategies"]
          });
        }
      } else {
        if (plan.selected_strategy_count !== 0) {
          context.addIssue({
            code: "custom",
            message: `${plan.status} status requires selected_strategy_count to be zero`,
            path: ["selected_strategy_count"]
          });
        }
        if (plan.selected_strategies.length > 0) {
          context.addIssue({
            code: "custom",
            message: `${plan.status} status cannot carry selected strategy IDs`,
            path: ["selected_strategies"]
          });
        }
      }
    }),
  "dynamic-strategy-plan",
  1,
  "Ultrafuzz dynamic strategy plan"
);

// The `json` variant is the single intentionally open payload in this schema
// bundle. It preserves enumerator-specific model output inside a strict,
// discriminated envelope; all identity, status and recommendation fields stay
// typed and closed.
const dynamicEnumeratorPayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), value: nonEmptyString }),
  z.strictObject({ kind: z.literal("json"), value: z.json() })
]);

export const dynamicEnumeratorOutputsSchema = withDocumentMetadata(
  z.strictObject({
    schema_version: z.literal(DYNAMIC_ENUMERATOR_OUTPUTS_SCHEMA_VERSION),
    enumerators: z.array(
      z.strictObject({
        enumerator_id: nonEmptyString,
        agent_label: nonEmptyString,
        status: z.enum(["complete", "failed", "timed-out", "blocked"]),
        diagnostics: stringList,
        recommendations: z.array(dynamicRecommendationSchema),
        payload: dynamicEnumeratorPayloadSchema.optional()
      })
    )
  }),
  "dynamic-enumerator-outputs",
  1,
  "Ultrafuzz dynamic enumerator outputs"
);

export const selectedStrategiesSchema = withDocumentMetadata(
  z.strictObject({
    schema_version: z.literal(SELECTED_STRATEGIES_SCHEMA_VERSION),
    strategies: z.array(
      dynamicRecommendationSchema.extend({
        enumerator_ids: uniqueStrings(1),
        validation_plan: stringList.min(1)
      })
    )
  }),
  "selected-strategies",
  1,
  "Ultrafuzz selected dynamic strategies"
);

const dynamicValidationResultSchema = z.strictObject({
  subject: nonEmptyString,
  command: nonEmptyString,
  status: z.enum(["passed", "failed", "blocked", "not-run"]),
  summary: nonEmptyString
});

export const dynamicStrategyProvenanceSchema = withDocumentMetadata(
  z.strictObject({
    schema_version: z.literal(DYNAMIC_STRATEGY_PROVENANCE_SCHEMA_VERSION),
    current_run_artifacts: uniqueStrings(),
    agents: z.array(z.strictObject({ agent_id: nonEmptyString, label: nonEmptyString, role: nonEmptyString })),
    models: z.array(z.strictObject({ agent_id: nonEmptyString, model: nonEmptyString, backend: nonEmptyString })),
    commands: uniqueStrings(),
    generated_files: z.array(
      z.strictObject({ strategy_id: nonEmptyString, source_path: nonEmptyString, destination_intent: nonEmptyString })
    ),
    validation: z.array(dynamicValidationResultSchema),
    excluded_context: dynamicExcludedContextSchema
  }),
  "dynamic-strategy-provenance",
  1,
  "Ultrafuzz dynamic strategy provenance"
);

const lifecycleRecordSchema = findingLifecycleSchema.extend({
  stages: z.array(findingLifecycleStageSchema).min(1).max(MAX_FINDING_NESTED_ITEMS)
});

export const findingLifecycleLedgerSchema = withDocumentMetadata(
  z.strictObject({
    schema_version: z.literal(FINDING_LIFECYCLE_LEDGER_SCHEMA_VERSION),
    records: z.array(lifecycleRecordSchema).max(MAX_FINDINGS)
  }),
  "finding-lifecycle-ledger",
  1,
  "Ultrafuzz finding lifecycle ledger"
);

const aggregationId = z.string().min(1).max(128).regex(SAFE_ID_PATTERN).meta({ id: "aggregationId" });
const aggregationCount = nonNegativeInteger.max(MAX_AGGREGATION_SOURCE_ENTRIES);
const aggregationAbsolutePath = z
  .string()
  .min(1)
  .max(MAX_AGGREGATION_ABSOLUTE_PATH_CHARS)
  .meta({ id: "aggregationAbsolutePath" });
const aggregationReason = z.string().min(1).max(MAX_AGGREGATION_REASON_CHARS).meta({ id: "aggregationReason" });
const aggregationSafePathSegmentPattern = "(?!\\.{1,2}(?:/|$))[A-Za-z0-9._@+-]{1,128}";
const aggregationSafeRelativePath = z
  .string()
  .min(1)
  .max(MAX_GENERATED_TEST_PATH_BYTES)
  .regex(
    new RegExp(
      `^${aggregationSafePathSegmentPattern}(?:/${aggregationSafePathSegmentPattern}){0,${MAX_GENERATED_TEST_PATH_SEGMENTS - 1}}(?![\\s\\S])`,
      "u"
    )
  )
  .meta({ id: "aggregationSafeRelativePath" });

const aggregationFileSchema = z
  .strictObject({
    strategy: aggregationId,
    node_id: aggregationId,
    source_attempt_id: aggregationId,
    attempt_index: nonNegativeInteger,
    source_manifest_path: aggregationAbsolutePath,
    source_manifest_relative_path: aggregationSafeRelativePath,
    source_manifest_sha256: sha256,
    source_artifact_path: aggregationAbsolutePath,
    source_relative_path: generatedTestPathSchema,
    destination_path: aggregationAbsolutePath,
    destination_relative_path: aggregationSafeRelativePath,
    size_bytes: generatedTestEntrySchema.shape.size_bytes,
    sha256: generatedTestEntrySchema.shape.sha256,
    language: generatedTestEntrySchema.shape.language,
    description: generatedTestEntrySchema.shape.description,
    provenance: generatedTestProvenanceSchema.optional()
  })
  .meta({ id: "aggregationFile" });

const skippedAggregationFileSchema = z
  .strictObject({
    kind: z.enum(["generated-test", "support-file"]),
    strategy: aggregationId,
    node_id: aggregationId,
    source_attempt_id: aggregationId,
    attempt_index: nonNegativeInteger,
    source_manifest_path: aggregationAbsolutePath,
    source_manifest_relative_path: aggregationSafeRelativePath,
    source_manifest_sha256: sha256,
    source_artifact_path: aggregationAbsolutePath,
    source_relative_path: generatedTestPathSchema,
    size_bytes: generatedTestEntrySchema.shape.size_bytes,
    sha256: generatedTestEntrySchema.shape.sha256,
    language: generatedTestEntrySchema.shape.language,
    description: generatedTestEntrySchema.shape.description,
    provenance: generatedTestProvenanceSchema.optional(),
    reason: aggregationReason
  })
  .meta({ id: "skippedAggregationFile" });

const aggregationSourceBundleSchema = z
  .strictObject({
    strategy: aggregationId,
    node_id: aggregationId,
    source_attempt_id: aggregationId,
    attempt_index: nonNegativeInteger,
    source_manifest_path: aggregationAbsolutePath,
    source_manifest_relative_path: aggregationSafeRelativePath,
    source_manifest_sha256: sha256,
    source_run_id: aggregationId,
    framework: generatedTestFrameworkSchema,
    generated_test_count: nonNegativeInteger.max(MAX_GENERATED_TEST_BUNDLE_ENTRIES),
    support_file_count: nonNegativeInteger.max(MAX_GENERATED_TEST_BUNDLE_ENTRIES),
    disposition: z.enum(["empty", "copied", "skipped"]),
    reason: aggregationReason.optional()
  })
  .meta({
    id: "aggregationSourceBundle",
    allOf: [
      {
        if: { type: "object", properties: { disposition: { const: "skipped" } }, required: ["disposition"] },
        then: { type: "object", properties: { reason: true }, required: ["reason"] },
        else: {
          not: {
            type: "object",
            properties: { reason: true },
            required: ["reason"]
          }
        }
      }
    ]
  })
  .superRefine((bundle, context) => {
    if (bundle.disposition === "skipped" && bundle.reason === undefined) {
      context.addIssue({ code: "custom", message: "Skipped source bundles require a reason", path: ["reason"] });
    }
    if (bundle.disposition !== "skipped" && bundle.reason !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Only skipped source bundles may declare a reason",
        path: ["reason"]
      });
    }
  });

export const aggregationManifestSchema = withDocumentMetadata(
  z.strictObject({
    schema_version: z.literal(AGGREGATION_MANIFEST_SCHEMA_VERSION),
    source_generated_tests: aggregationCount,
    copied_generated_tests: aggregationCount,
    source_support_files: aggregationCount,
    copied_support_files: aggregationCount,
    source_bundles: uniqueJsonValues(aggregationSourceBundleSchema, MAX_AGGREGATION_SOURCE_BUNDLES),
    files: uniqueJsonValues(aggregationFileSchema, MAX_AGGREGATION_SOURCE_ENTRIES),
    support_files: uniqueJsonValues(aggregationFileSchema, MAX_AGGREGATION_SOURCE_ENTRIES),
    skipped_files: uniqueJsonValues(skippedAggregationFileSchema, MAX_AGGREGATION_SOURCE_ENTRIES)
  }),
  "aggregation-manifest",
  1,
  "Ultrafuzz generated-test aggregation manifest"
);

const reportPropertySourceSchema = z.strictObject({
  source_node_id: nonEmptyString,
  source_property_id: nonEmptyString
});
const reportPropertyProvenanceSchema = z
  .strictObject({
    finding_id: nonEmptyString,
    source_finding_id: nonEmptyString.optional(),
    title: nonEmptyString,
    property_ids: uniqueStrings(1),
    sources: z.array(reportPropertySourceSchema).min(1),
    implementation_paths: uniqueStrings(),
    test_paths: uniqueStrings(),
    fuzzer_backend: nonEmptyString.optional(),
    fuzzer_backends: uniqueStrings(1).optional()
  })
  .meta({
    not: {
      properties: { fuzzer_backend: true, fuzzer_backends: true },
      required: ["fuzzer_backend", "fuzzer_backends"]
    }
  })
  .superRefine((entry, context) => {
    if (entry.fuzzer_backend !== undefined && entry.fuzzer_backends !== undefined) {
      context.addIssue({ code: "custom", message: "Use one backend representation", path: ["fuzzer_backends"] });
    }
  });

const reportCoverageSchema = z.strictObject({
  priority_threshold: z.enum(PROPERTY_PRIORITIES),
  priorities: z
    .array(z.enum(PROPERTY_PRIORITIES))
    .min(1)
    .meta({ uniqueItems: true })
    .refine((values) => new Set(values).size === values.length, { message: "Priorities must be unique" }),
  selected_property_ids: uniqueStrings(),
  implemented_property_ids: uniqueStrings(),
  blocked_property_ids: uniqueStrings(),
  pending_property_ids: uniqueStrings(),
  deferred_property_ids: uniqueStrings(),
  reference_expected_property_ids: uniqueStrings(),
  reference_expectation_ids: uniqueStrings(),
  blocker_summaries: stringList
});

const reportCoverageNotPlannedSchema = z.strictObject({
  status: z.literal("not-planned"),
  reason: z.literal("property-implementation-track-not-declared")
});

const reportCoverageUnavailableSchema = z.strictObject({
  status: z.literal("unavailable"),
  reason: z.literal("property-implementation-not-completed")
});

const reportIssueSchema = findingSchema.safeExtend({
  notes: z.array(findingNoteSchema).max(MAX_FINDING_NESTED_ITEMS).optional(),
  description: nonEmptyString,
  severity: z.enum(FINDING_SEVERITIES),
  likelihood: z.enum(FINDING_SEVERITIES),
  impact: z.enum(FINDING_SEVERITIES),
  impact_rationale: findingReportBoundTextSchema,
  likelihood_rationale: findingReportBoundTextSchema,
  severity_rationale: findingReportBoundTextSchema,
  proof_of_concept: z.strictObject({
    scenario: z.array(nonEmptyString).min(1),
    language: nonEmptyString,
    code: nonEmptyString
  }),
  lifecycle: findingLifecycleSchema
});

const reportNonProductionOutcomeSchema = findingSchema.safeExtend({
  notes: z.array(findingNoteSchema).max(MAX_FINDING_NESTED_ITEMS).optional(),
  triage_classification: z.enum(TRIAGE_CLASSIFICATIONS),
  recommended_next_action: nonEmptyString,
  lifecycle: findingLifecycleSchema
});

const reportAgentAttemptSchema = z.strictObject({
  attempt: positiveInteger,
  profile_id: nonEmptyString,
  agent_ref: nonEmptyString,
  model_name: nonEmptyString.optional(),
  reasoning_effort: nonEmptyString.optional(),
  role: z.enum(["primary", "fallback"])
});

const reportAgentExecutionSchema = z.strictObject({
  planned_chain: z.array(reportAgentAttemptSchema).min(1),
  failed_attempts: z.array(reportAgentAttemptSchema),
  producer: reportAgentAttemptSchema
});

export const reportSchema = withDocumentMetadata(
  z
    .strictObject({
      schema_version: z.literal(REPORT_SCHEMA_VERSION),
      run_metadata: z.strictObject({
        run_id: nonEmptyString,
        source_run_id: nonEmptyString,
        repository: nonEmptyString,
        elapsed_time: nonEmptyString,
        models_used: z.array(nonEmptyString),
        tokens_used: nonEmptyString,
        estimated_spend: nonEmptyString,
        partial_pricing: z.boolean(),
        strategy_loops: z.union([nonNegativeInteger, z.literal("unavailable")]),
        // The report renders these beside the rest of the run summary, so a report
        // that omits them cannot be projected.
        audit_profile: nonEmptyString,
        audit_profile_catalog_digest: z.union([sha256, z.literal("unavailable")]),
        topology_digest: z.union([sha256, z.literal("unavailable")]),
        prompt_digest: z.union([sha256, z.literal("unavailable")]),
        expanded_graph_fingerprint: nonEmptyString,
        agent_execution: reportAgentExecutionSchema.optional(),
        artifact_validation_warnings: artifactValidationWarningsSchema.optional(),
        source_run_ids: uniqueStrings().optional()
      }),
      completion: reportCompletionSchema.optional(),
      verification: reportVerificationSchema.optional(),
      observed_completion: reportObservedCompletionSchema.optional(),
      campaign_outcome: z
        .strictObject({
          outcome: z.enum(["complete", "partial", "blocked"]),
          reason: nonEmptyString.max(4_000).optional()
        })
        .optional(),
      issues: z.array(reportIssueSchema),
      non_production_outcomes: z.array(reportNonProductionOutcomeSchema),
      coverage_evidence: coverageEvidenceSchema.optional(),
      property_provenance: z.array(reportPropertyProvenanceSchema),
      property_implementation_coverage: z.union([
        reportCoverageNotPlannedSchema,
        reportCoverageUnavailableSchema,
        reportCoverageSchema
      ])
    })
    .meta({
      allOf: [
        {
          if: {
            anyOf: [
              { properties: { verification: true }, required: ["verification"] },
              { properties: { observed_completion: true }, required: ["observed_completion"] }
            ]
          },
          then: {
            properties: { verification: true, observed_completion: true },
            required: ["verification", "observed_completion"],
            not: { properties: { completion: true }, required: ["completion"] }
          }
        }
      ]
    })
    .superRefine((report, context) => {
      if (
        (report.verification !== undefined || report.observed_completion !== undefined) &&
        (report.verification === undefined ||
          report.observed_completion === undefined ||
          report.completion !== undefined)
      ) {
        context.addIssue({
          code: "custom",
          message: "Unchecked reports require verification and observed_completion without a completion census",
          path: ["verification"]
        });
      }
      if (report.completion !== undefined && report.completion.run_id !== report.run_metadata.run_id) {
        context.addIssue({
          code: "custom",
          message: "Completion run ID must equal report run_metadata.run_id",
          path: ["completion", "run_id"]
        });
      }
    }),
  "report",
  3,
  "Ultrafuzz terminal report"
);

export const workflowContractSchemas = {
  "ultrafuzz/harness-repairs@1": harnessRepairsSchema,
  "ultrafuzz/strategy-detections@1": strategyDetectionsSchema,
  "ultrafuzz/triaged-findings@1": triagedFindingsSchema,
  "ultrafuzz/severity-classified-findings@1": severityClassifiedFindingsSchema,
  "ultrafuzz/reference-manifest@1": referenceManifestSchema,
  "ultrafuzz/boundary-recipes@1": boundaryRecipesSchema,
  "ultrafuzz/admin-config-boundary-matrix@1": adminConfigBoundaryMatrixSchema,
  "ultrafuzz/dependency-scope-matrix@1": dependencyScopeMatrixSchema,
  "ultrafuzz/externalized-state-accounting@1": externalizedStateAccountingSchema,
  "ultrafuzz/coverage-goal@2": coverageGoalSchema,
  "ultrafuzz/invariant-campaign-plan@2": invariantCampaignPlanSchema,
  "ultrafuzz/campaign-summary@2": campaignSummarySchema,
  "ultrafuzz/differential-plan@1": differentialPlanSchema,
  "ultrafuzz/reference-harness@1": referenceHarnessSchema,
  "ultrafuzz/audited-differential-lanes@1": auditedDifferentialLanesSchema,
  "ultrafuzz/differential-lane-result@1": differentialLaneResultSchema,
  "ultrafuzz/semantic-red-registry@1": semanticRedRegistrySchema,
  "ultrafuzz/differential-red-triage@1": differentialRedTriageSchema,
  "ultrafuzz/differential-repair-summary@1": differentialRepairSummarySchema,
  "ultrafuzz/differential-gap-review@1": differentialGapReviewSchema,
  "ultrafuzz/differential-report-review@1": differentialReportReviewSchema,
  "ultrafuzz/dynamic-strategy-plan@1": dynamicStrategyPlanSchema,
  "ultrafuzz/dynamic-enumerator-outputs@1": dynamicEnumeratorOutputsSchema,
  "ultrafuzz/selected-strategies@1": selectedStrategiesSchema,
  "ultrafuzz/dynamic-strategy-provenance@1": dynamicStrategyProvenanceSchema,
  "ultrafuzz/finding-lifecycle-ledger@1": findingLifecycleLedgerSchema,
  "ultrafuzz/aggregation-manifest@1": aggregationManifestSchema,
  "ultrafuzz/report@3": reportSchema
} as const;

export type WorkflowContractId = keyof typeof workflowContractSchemas;

export const workflowContractJsonSchemas = Object.fromEntries(
  Object.entries(workflowContractSchemas).map(([contract, schema]) => [contract, z.toJSONSchema(schema)])
) as unknown as Record<WorkflowContractId, Record<string, unknown>>;

export const harnessRepairsJsonSchema = workflowContractJsonSchemas["ultrafuzz/harness-repairs@1"];
export const strategyDetectionsJsonSchema = workflowContractJsonSchemas["ultrafuzz/strategy-detections@1"];
export const triagedFindingsJsonSchema = workflowContractJsonSchemas["ultrafuzz/triaged-findings@1"];
export const severityClassifiedFindingsJsonSchema =
  workflowContractJsonSchemas["ultrafuzz/severity-classified-findings@1"];
export const referenceManifestJsonSchema = workflowContractJsonSchemas["ultrafuzz/reference-manifest@1"];
export const boundaryRecipesJsonSchema = workflowContractJsonSchemas["ultrafuzz/boundary-recipes@1"];
export const adminConfigBoundaryMatrixJsonSchema =
  workflowContractJsonSchemas["ultrafuzz/admin-config-boundary-matrix@1"];
export const dependencyScopeMatrixJsonSchema = workflowContractJsonSchemas["ultrafuzz/dependency-scope-matrix@1"];
export const externalizedStateAccountingJsonSchema =
  workflowContractJsonSchemas["ultrafuzz/externalized-state-accounting@1"];
export const coverageGoalJsonSchema = workflowContractJsonSchemas["ultrafuzz/coverage-goal@2"];
export const invariantCampaignPlanJsonSchema = workflowContractJsonSchemas["ultrafuzz/invariant-campaign-plan@2"];
export const campaignSummaryJsonSchema = workflowContractJsonSchemas["ultrafuzz/campaign-summary@2"];
export const differentialPlanJsonSchema = workflowContractJsonSchemas["ultrafuzz/differential-plan@1"];
export const referenceHarnessJsonSchema = workflowContractJsonSchemas["ultrafuzz/reference-harness@1"];
export const auditedDifferentialLanesJsonSchema = workflowContractJsonSchemas["ultrafuzz/audited-differential-lanes@1"];
export const differentialLaneResultJsonSchema = workflowContractJsonSchemas["ultrafuzz/differential-lane-result@1"];
export const semanticRedRegistryJsonSchema = workflowContractJsonSchemas["ultrafuzz/semantic-red-registry@1"];
export const differentialRedTriageJsonSchema = workflowContractJsonSchemas["ultrafuzz/differential-red-triage@1"];
export const differentialRepairSummaryJsonSchema =
  workflowContractJsonSchemas["ultrafuzz/differential-repair-summary@1"];
export const differentialGapReviewJsonSchema = workflowContractJsonSchemas["ultrafuzz/differential-gap-review@1"];
export const differentialReportReviewJsonSchema = workflowContractJsonSchemas["ultrafuzz/differential-report-review@1"];
export const dynamicStrategyPlanJsonSchema = workflowContractJsonSchemas["ultrafuzz/dynamic-strategy-plan@1"];
export const dynamicEnumeratorOutputsJsonSchema = workflowContractJsonSchemas["ultrafuzz/dynamic-enumerator-outputs@1"];
export const selectedStrategiesJsonSchema = workflowContractJsonSchemas["ultrafuzz/selected-strategies@1"];
export const dynamicStrategyProvenanceJsonSchema =
  workflowContractJsonSchemas["ultrafuzz/dynamic-strategy-provenance@1"];
export const findingLifecycleLedgerJsonSchema = workflowContractJsonSchemas["ultrafuzz/finding-lifecycle-ledger@1"];
export const aggregationManifestJsonSchema = workflowContractJsonSchemas["ultrafuzz/aggregation-manifest@1"];
export const reportJsonSchema = workflowContractJsonSchemas["ultrafuzz/report@3"];

export function validateWorkflowContract(
  contract: WorkflowContractId,
  value: unknown,
  path = "$"
): SchemaValidationResult<unknown> {
  return validateWithZod(workflowContractSchemas[contract] as z.ZodType, value, {
    path,
    code: "WORKFLOW_ARTIFACT_SCHEMA_INVALID"
  });
}

export type HarnessRepairs = z.infer<typeof harnessRepairsSchema>;
export type StrategyDetections = z.infer<typeof strategyDetectionsSchema>;
export type TriagedFindings = z.infer<typeof triagedFindingsSchema>;
export type SeverityClassifiedFindings = z.infer<typeof severityClassifiedFindingsSchema>;
export type ReferenceManifest = z.infer<typeof referenceManifestSchema>;
export type BoundaryRecipes = z.infer<typeof boundaryRecipesSchema>;
export type AdminConfigBoundaryMatrix = z.infer<typeof adminConfigBoundaryMatrixSchema>;
export type DependencyScopeMatrix = z.infer<typeof dependencyScopeMatrixSchema>;
export type ExternalizedStateAccounting = z.infer<typeof externalizedStateAccountingSchema>;
export type CoverageGoal = z.infer<typeof coverageGoalSchema>;
export type InvariantCampaignPlan = z.infer<typeof invariantCampaignPlanSchema>;
export type CampaignSummary = z.infer<typeof campaignSummarySchema>;
export type DifferentialPlan = z.infer<typeof differentialPlanSchema>;
export type ReferenceHarness = z.infer<typeof referenceHarnessSchema>;
export type AuditedDifferentialLanes = z.infer<typeof auditedDifferentialLanesSchema>;
export type DifferentialLaneResult = z.infer<typeof differentialLaneResultSchema>;
export type SemanticRedRegistry = z.infer<typeof semanticRedRegistrySchema>;
export type DifferentialRedTriage = z.infer<typeof differentialRedTriageSchema>;
export type DifferentialRepairSummary = z.infer<typeof differentialRepairSummarySchema>;
export type DifferentialGapReview = z.infer<typeof differentialGapReviewSchema>;
export type DifferentialReportReview = z.infer<typeof differentialReportReviewSchema>;
export type DynamicStrategyPlan = z.infer<typeof dynamicStrategyPlanSchema>;
export type DynamicEnumeratorOutputs = z.infer<typeof dynamicEnumeratorOutputsSchema>;
export type SelectedStrategies = z.infer<typeof selectedStrategiesSchema>;
export type DynamicStrategyProvenance = z.infer<typeof dynamicStrategyProvenanceSchema>;
export type FindingLifecycleLedger = z.infer<typeof findingLifecycleLedgerSchema>;
export type AggregationManifest = z.infer<typeof aggregationManifestSchema>;
export type TerminalReport = z.infer<typeof reportSchema>;

export const WORKFLOW_SCHEMA_FILES = {
  "ultrafuzz/harness-repairs@1": "harness-repairs.schema.json",
  "ultrafuzz/strategy-detections@1": "strategy-detections.schema.json",
  "ultrafuzz/triaged-findings@1": "triaged-findings.schema.json",
  "ultrafuzz/severity-classified-findings@1": "severity-classified-findings.schema.json",
  "ultrafuzz/reference-manifest@1": "reference-manifest.schema.json",
  "ultrafuzz/boundary-recipes@1": "boundary-recipes.schema.json",
  "ultrafuzz/admin-config-boundary-matrix@1": "admin-config-boundary-matrix.schema.json",
  "ultrafuzz/dependency-scope-matrix@1": "dependency-scope-matrix.schema.json",
  "ultrafuzz/externalized-state-accounting@1": "externalized-state-accounting.schema.json",
  "ultrafuzz/coverage-goal@2": "coverage-goal.schema.json",
  "ultrafuzz/invariant-campaign-plan@2": "invariant-campaign-plan-v2.schema.json",
  "ultrafuzz/campaign-summary@2": "campaign-summary.schema.json",
  "ultrafuzz/differential-plan@1": "differential-plan.schema.json",
  "ultrafuzz/reference-harness@1": "reference-harness.schema.json",
  "ultrafuzz/audited-differential-lanes@1": "audited-differential-lanes.schema.json",
  "ultrafuzz/differential-lane-result@1": "differential-lane-result.schema.json",
  "ultrafuzz/semantic-red-registry@1": "semantic-red-registry.schema.json",
  "ultrafuzz/differential-red-triage@1": "differential-red-triage.schema.json",
  "ultrafuzz/differential-repair-summary@1": "differential-repair-summary.schema.json",
  "ultrafuzz/differential-gap-review@1": "differential-gap-review.schema.json",
  "ultrafuzz/differential-report-review@1": "differential-report-review.schema.json",
  "ultrafuzz/dynamic-strategy-plan@1": "dynamic-strategy-plan.schema.json",
  "ultrafuzz/dynamic-enumerator-outputs@1": "dynamic-enumerator-outputs.schema.json",
  "ultrafuzz/selected-strategies@1": "selected-strategies.schema.json",
  "ultrafuzz/dynamic-strategy-provenance@1": "dynamic-strategy-provenance.schema.json",
  "ultrafuzz/finding-lifecycle-ledger@1": "finding-lifecycle-ledger.schema.json",
  "ultrafuzz/aggregation-manifest@1": "aggregation-manifest.schema.json",
  "ultrafuzz/report@3": "report.schema.json"
} as const satisfies Record<WorkflowContractId, string>;

export const WORKFLOW_CONTRACT_DESCRIPTIONS: Record<WorkflowContractId, string> = {
  "ultrafuzz/harness-repairs@1": "Strict harness-defect repair records.",
  "ultrafuzz/strategy-detections@1": "Strategy hits grouped by a stable dedupe key.",
  "ultrafuzz/triaged-findings@1": "Canonical findings enriched with required triage decisions.",
  "ultrafuzz/severity-classified-findings@1":
    "Triaged findings with canonical final severity fields for production candidates.",
  "ultrafuzz/reference-manifest@1": "A pinned materialized reference and its exact file digests.",
  "ultrafuzz/boundary-recipes@1": "Source-backed boundary and negative test recipes.",
  "ultrafuzz/admin-config-boundary-matrix@1": "Typed admin/config surface and selector audit rows.",
  "ultrafuzz/dependency-scope-matrix@1": "Typed external-dependency scope decisions and evidence.",
  "ultrafuzz/externalized-state-accounting@1": "State components, value scenarios, and accounting oracles.",
  "ultrafuzz/coverage-goal@2": "A bounded scoped-count coverage goal and blocker record.",
  "ultrafuzz/invariant-campaign-plan@2":
    "The current v2 invariant backend, CPU, full configured Recon interval, supervised deadlines, reserve, paths, and commands.",
  "ultrafuzz/campaign-summary@2": "A strict invariant campaign accounting summary.",
  "ultrafuzz/differential-plan@1": "Differential surfaces, oracle rules, and assigned lanes.",
  "ultrafuzz/reference-harness@1": "Authored independent reference models and validation results.",
  "ultrafuzz/audited-differential-lanes@1": "Audited differential surfaces and ready lane payloads.",
  "ultrafuzz/differential-lane-result@1": "One status-dependent differential lane result.",
  "ultrafuzz/semantic-red-registry@1": "Frozen semantic reds and compile/harness defects.",
  "ultrafuzz/differential-red-triage@1": "One named differential red triage pass.",
  "ultrafuzz/differential-repair-summary@1": "Typed harness/reference repairs and preserved reds.",
  "ultrafuzz/differential-gap-review@1": "Lane coverage, missing work orders, and report blockers.",
  "ultrafuzz/differential-report-review@1": "Final differential campaign status and report rows.",
  "ultrafuzz/dynamic-strategy-plan@1": "Selected/rejected dynamic strategies and context boundary.",
  "ultrafuzz/dynamic-enumerator-outputs@1":
    "Typed enumerator identities, status, recommendations, and scoped payloads.",
  "ultrafuzz/selected-strategies@1": "Complete selected strategy payloads consumed downstream.",
  "ultrafuzz/dynamic-strategy-provenance@1":
    "Dynamic agents, models, commands, files, validation, and excluded context.",
  "ultrafuzz/finding-lifecycle-ledger@1": "The typed evolving lifecycle keyed by dedupe key.",
  "ultrafuzz/aggregation-manifest@1": "Typed generated-test aggregation counts, files, support files, and skips.",
  "ultrafuzz/report@3": "A strict terminal report with canonical production and non-production findings."
};

export const WORKFLOW_VALID_EMPTY_EXAMPLES: Partial<Record<WorkflowContractId, string>> = {
  "ultrafuzz/harness-repairs@1": "[]",
  "ultrafuzz/strategy-detections@1": "[]",
  "ultrafuzz/triaged-findings@1": "[]",
  "ultrafuzz/severity-classified-findings@1": "[]",
  "ultrafuzz/boundary-recipes@1": JSON.stringify({
    schema_version: BOUNDARY_RECIPES_SCHEMA_VERSION,
    recipes: [],
    deferred_or_spec_gated: [],
    coverage_priorities: []
  }),
  "ultrafuzz/finding-lifecycle-ledger@1": JSON.stringify({
    schema_version: FINDING_LIFECYCLE_LEDGER_SCHEMA_VERSION,
    records: []
  }),
  "ultrafuzz/aggregation-manifest@1": JSON.stringify({
    schema_version: AGGREGATION_MANIFEST_SCHEMA_VERSION,
    source_generated_tests: 0,
    copied_generated_tests: 0,
    source_support_files: 0,
    copied_support_files: 0,
    source_bundles: [],
    files: [],
    support_files: [],
    skipped_files: []
  })
};
