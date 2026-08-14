import { z } from "zod/v4";

import { validateWithZod, type SchemaValidationResult } from "./schema-validation.js";

export const COVERAGE_EVIDENCE_SCHEMA_VERSION = "ultrafuzz.coverage-evidence.v1" as const;
export const COVERAGE_EVIDENCE_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:coverage-evidence:1" as const;
export const MAX_COVERAGE_EVIDENCE_FILES = 10_000;
export const MAX_COVERAGE_EVIDENCE_RANGES = 100_000;

export const COVERAGE_BLOCKER_CATEGORIES = [
  "coverage-tooling-blocked",
  "production-source-attribution-blocked",
  "harness-build-blocked",
  "dependency-blocked",
  "time-budget-exhausted",
  "no-reachable-target"
] as const;

export const coverageBlockerCategorySchema = z.enum(COVERAGE_BLOCKER_CATEGORIES);
export const coverageBlockerSchema = z.strictObject({
  category: coverageBlockerCategorySchema,
  summary: z.string().min(1),
  evidence_paths: z
    .array(z.string().min(1))
    .meta({ uniqueItems: true })
    .refine((paths) => new Set(paths).size === paths.length, { message: "Evidence paths must be unique" })
});

const sourceKind = z.enum(["production", "test", "harness", "dependency"]);
const safePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    { message: "path must be a safe relative forward-slash path" }
  );
const range = z.strictObject({
  file: safePath,
  kind: sourceKind,
  start_line: z.number().int().positive(),
  line_count: z.number().int().positive(),
  selected: z
    .boolean()
    .describe("Whether this trusted declaration range overlaps the authenticated Recon selection map."),
  covered: z
    .boolean()
    .describe(
      "Declaration completeness: true only when the authenticated LCOV contains at least one DA row in the range and every in-range DA row has a positive hit count."
    )
});
const file = z
  .strictObject({
    path: safePath,
    kind: sourceKind,
    included: z.boolean(),
    exclusion_reason: z.string().min(1).optional(),
    covered_ranges: z.number().int().nonnegative(),
    total_ranges: z.number().int().nonnegative()
  })
  .superRefine((value, context) => {
    if (!value.included && value.exclusion_reason === undefined) {
      context.addIssue({
        code: "custom",
        message: "excluded files require exclusion_reason",
        path: ["exclusion_reason"]
      });
    }
    if (value.included && value.exclusion_reason !== undefined) {
      context.addIssue({
        code: "custom",
        message: "included files cannot carry exclusion_reason",
        path: ["exclusion_reason"]
      });
    }
    if (value.covered_ranges > value.total_ranges) {
      context.addIssue({
        code: "custom",
        message: "covered_ranges cannot exceed total_ranges",
        path: ["covered_ranges"]
      });
    }
  });
const view = z
  .strictObject({
    scope: z.enum(["recon-selected-declaration-completeness", "production-declaration-completeness"]),
    covered_ranges: z.number().int().nonnegative(),
    total_ranges: z.number().int().nonnegative()
  })
  .refine((value) => value.covered_ranges <= value.total_ranges, {
    message: "covered_ranges cannot exceed total_ranges"
  });
const durableInput = z.strictObject({
  path: safePath.describe("Path to a declared sibling artifact preserved with this evidence."),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u, "sha256 must be 64 lowercase hexadecimal characters")
});
const zeroCoverageComponent = z.strictObject({
  path: safePath,
  kind: sourceKind,
  start_line: z.number().int().positive(),
  line_count: z.number().int().positive()
});

const measuredCoverageEvidenceSchema = z
  .strictObject({
    schema_version: z.literal(COVERAGE_EVIDENCE_SCHEMA_VERSION),
    status: z.literal("measured"),
    lcov: durableInput,
    recon_selection: durableInput,
    views: z
      .array(view)
      .length(2)
      .superRefine((views, context) => {
        const scopes = new Set(views.map((entry) => entry.scope));
        if (
          !scopes.has("recon-selected-declaration-completeness") ||
          !scopes.has("production-declaration-completeness")
        ) {
          context.addIssue({
            code: "custom",
            message:
              "coverage views require recon-selected-declaration-completeness and production-declaration-completeness scopes"
          });
        }
        if (scopes.size !== views.length)
          context.addIssue({ code: "custom", message: "coverage view scopes must be unique" });
      }),
    files: z.array(file).min(1).max(MAX_COVERAGE_EVIDENCE_FILES),
    counted_ranges: z.array(range).max(MAX_COVERAGE_EVIDENCE_RANGES),
    zero_coverage_components: z.array(zeroCoverageComponent).min(0).max(MAX_COVERAGE_EVIDENCE_RANGES)
  })
  .superRefine((value, context) => {
    if (value.lcov.path === value.recon_selection.path) {
      context.addIssue({
        code: "custom",
        message: "LCOV and Recon selection inputs must use distinct sibling artifacts",
        path: ["recon_selection", "path"]
      });
    }
    const fileByPath = new Map<string, (typeof value.files)[number]>();
    for (const [index, entry] of value.files.entries()) {
      if (fileByPath.has(entry.path)) {
        context.addIssue({
          code: "custom",
          message: "coverage file paths must be unique",
          path: ["files", index, "path"]
        });
      }
      fileByPath.set(entry.path, entry);
    }

    const rangesByFile = new Map<string, (typeof value.counted_ranges)[number][]>();
    const rangeByIdentity = new Map<string, (typeof value.counted_ranges)[number]>();
    for (const [index, entry] of value.counted_ranges.entries()) {
      const declared = fileByPath.get(entry.file);
      if (declared === undefined) {
        context.addIssue({
          code: "custom",
          message: "counted range references an undeclared file",
          path: ["counted_ranges", index, "file"]
        });
        continue;
      }
      if (declared.kind !== entry.kind) {
        context.addIssue({
          code: "custom",
          message: "counted range source kind does not match its file",
          path: ["counted_ranges", index, "kind"]
        });
      }
      if (entry.selected && entry.kind !== "production") {
        context.addIssue({
          code: "custom",
          message: "recon-selected-declaration-completeness coverage may contain only production source ranges",
          path: ["counted_ranges", index, "selected"]
        });
      }
      if (!declared.included && entry.selected) {
        context.addIssue({
          code: "custom",
          message:
            "selected counted ranges must belong to files included in the recon-selected-declaration-completeness scope",
          path: ["counted_ranges", index, "selected"]
        });
      }
      const entries = rangesByFile.get(entry.file) ?? [];
      entries.push(entry);
      rangesByFile.set(entry.file, entries);
      rangeByIdentity.set(`${entry.file}\0${entry.kind}\0${entry.start_line}\0${entry.line_count}`, entry);
    }

    for (const [filePath, entries] of rangesByFile) {
      const sorted = [...entries].sort(
        (left, right) => left.start_line - right.start_line || left.line_count - right.line_count
      );
      for (let index = 1; index < sorted.length; index += 1) {
        const previousEnd = sorted[index - 1]!.start_line + sorted[index - 1]!.line_count - 1;
        if (sorted[index]!.start_line <= previousEnd) {
          context.addIssue({
            code: "custom",
            message: `counted ranges overlap for ${filePath}`,
            path: ["counted_ranges"]
          });
          break;
        }
      }
    }

    for (const [index, entry] of value.files.entries()) {
      const entries = rangesByFile.get(entry.path) ?? [];
      const covered = entries.filter((candidate) => candidate.covered).length;
      const hasSelectedRanges = entries.some((candidate) => candidate.selected);
      if (entry.included !== hasSelectedRanges) {
        context.addIssue({
          code: "custom",
          message: "file included status must equal whether it contributes selected counted ranges",
          path: ["files", index, "included"]
        });
      }
      if (entry.total_ranges !== entries.length || entry.covered_ranges !== covered) {
        context.addIssue({
          code: "custom",
          message: "file totals must equal all of their selected and unselected counted ranges",
          path: ["files", index]
        });
      }
    }

    const expectedViews = new Map<string, { covered_ranges: number; total_ranges: number }>();
    const aggregate = (entries: typeof value.files): { covered_ranges: number; total_ranges: number } => ({
      covered_ranges: entries.reduce((sum, entry) => sum + entry.covered_ranges, 0),
      total_ranges: entries.reduce((sum, entry) => sum + entry.total_ranges, 0)
    });
    expectedViews.set("recon-selected-declaration-completeness", {
      covered_ranges: value.counted_ranges.filter((entry) => entry.selected && entry.covered).length,
      total_ranges: value.counted_ranges.filter((entry) => entry.selected).length
    });
    expectedViews.set(
      "production-declaration-completeness",
      aggregate(value.files.filter((entry) => entry.kind === "production"))
    );
    for (const [index, entry] of value.views.entries()) {
      const expected = expectedViews.get(entry.scope);
      if (
        expected === undefined ||
        entry.covered_ranges !== expected.covered_ranges ||
        entry.total_ranges !== expected.total_ranges
      ) {
        context.addIssue({
          code: "custom",
          message: "coverage view totals do not reconcile with files",
          path: ["views", index]
        });
      }
    }
    const actualZero = new Set<string>();
    for (const [index, component] of value.zero_coverage_components.entries()) {
      const key = `${component.path}\0${component.kind}\0${component.start_line}\0${component.line_count}`;
      const declared = rangeByIdentity.get(key);
      if (actualZero.has(key)) {
        context.addIssue({
          code: "custom",
          message: "zero-coverage components must be unique",
          path: ["zero_coverage_components", index]
        });
      }
      actualZero.add(key);
      if (declared === undefined || declared.covered) {
        context.addIssue({
          code: "custom",
          message: "zero-coverage component must match an incomplete material range",
          path: ["zero_coverage_components", index]
        });
      }
    }
  });

const unavailableCoverageEvidenceSchema = z.strictObject({
  schema_version: z.literal(COVERAGE_EVIDENCE_SCHEMA_VERSION),
  status: z.literal("unavailable"),
  blockers: z.array(coverageBlockerSchema).min(1)
});

export const coverageEvidenceSchema = z.discriminatedUnion("status", [
  measuredCoverageEvidenceSchema,
  unavailableCoverageEvidenceSchema
]);

const sourceKinds = ["production", "test", "harness", "dependency"] as const;
const safePathPattern = "^(?!\\.{1,2}(?:/|$))[^/\\\\\\u0000]+(?:/(?!\\.{1,2}(?:/|$))[^/\\\\\\u0000]+)*$";
const nonNegativeSafeIntegerJsonSchema = {
  type: "integer",
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER
} as const;
const positiveSafeIntegerJsonSchema = {
  type: "integer",
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER
} as const;
const coverageBlockerJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["category", "summary", "evidence_paths"],
  properties: {
    category: { enum: COVERAGE_BLOCKER_CATEGORIES },
    summary: { type: "string", minLength: 1 },
    evidence_paths: {
      type: "array",
      uniqueItems: true,
      items: { type: "string", minLength: 1 }
    }
  }
} as const;

const measuredCoverageEvidenceJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "status",
    "lcov",
    "recon_selection",
    "views",
    "files",
    "counted_ranges",
    "zero_coverage_components"
  ],
  properties: {
    schema_version: { const: COVERAGE_EVIDENCE_SCHEMA_VERSION },
    status: { const: "measured" },
    lcov: {
      type: "object",
      additionalProperties: false,
      required: ["path", "sha256"],
      properties: {
        path: { type: "string", minLength: 1, pattern: safePathPattern },
        sha256: { type: "string", pattern: "^[0-9a-f]{64}$" }
      }
    },
    recon_selection: {
      type: "object",
      additionalProperties: false,
      required: ["path", "sha256"],
      properties: {
        path: { type: "string", minLength: 1, pattern: safePathPattern },
        sha256: { type: "string", pattern: "^[0-9a-f]{64}$" }
      }
    },
    views: {
      type: "array",
      minItems: 2,
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["scope", "covered_ranges", "total_ranges"],
        properties: {
          scope: {
            enum: ["recon-selected-declaration-completeness", "production-declaration-completeness"]
          },
          covered_ranges: nonNegativeSafeIntegerJsonSchema,
          total_ranges: nonNegativeSafeIntegerJsonSchema
        }
      }
    },
    files: {
      type: "array",
      minItems: 1,
      maxItems: MAX_COVERAGE_EVIDENCE_FILES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "kind", "included", "covered_ranges", "total_ranges"],
        properties: {
          path: { type: "string", minLength: 1, pattern: safePathPattern },
          kind: { enum: sourceKinds },
          included: { type: "boolean" },
          exclusion_reason: { type: "string", minLength: 1 },
          covered_ranges: nonNegativeSafeIntegerJsonSchema,
          total_ranges: nonNegativeSafeIntegerJsonSchema
        },
        allOf: [
          {
            if: { properties: { included: { const: false } }, required: ["included"] },
            then: {
              required: ["exclusion_reason"],
              properties: { exclusion_reason: true }
            },
            else: { not: { required: ["exclusion_reason"] } }
          }
        ]
      }
    },
    counted_ranges: {
      type: "array",
      maxItems: MAX_COVERAGE_EVIDENCE_RANGES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "kind", "start_line", "line_count", "selected", "covered"],
        properties: {
          file: { type: "string", minLength: 1, pattern: safePathPattern },
          kind: { enum: sourceKinds },
          start_line: positiveSafeIntegerJsonSchema,
          line_count: positiveSafeIntegerJsonSchema,
          selected: {
            type: "boolean",
            description: "Whether this trusted declaration range overlaps the authenticated Recon selection map."
          },
          covered: {
            type: "boolean",
            description:
              "Declaration completeness: true only when the authenticated LCOV contains at least one DA row in the range and every in-range DA row has a positive hit count."
          }
        }
      }
    },
    zero_coverage_components: {
      type: "array",
      maxItems: MAX_COVERAGE_EVIDENCE_RANGES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "kind", "start_line", "line_count"],
        properties: {
          path: { type: "string", minLength: 1, pattern: safePathPattern },
          kind: { enum: sourceKinds },
          start_line: positiveSafeIntegerJsonSchema,
          line_count: positiveSafeIntegerJsonSchema
        }
      }
    }
  }
} as const;

const unavailableCoverageEvidenceJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "status", "blockers"],
  properties: {
    schema_version: { const: COVERAGE_EVIDENCE_SCHEMA_VERSION },
    status: { const: "unavailable" },
    blockers: { type: "array", minItems: 1, items: coverageBlockerJsonSchema }
  }
} as const;

export const coverageEvidenceJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: COVERAGE_EVIDENCE_JSON_SCHEMA_ID,
  title: "Ultrafuzz coverage evidence",
  description:
    "Producer contract for either authenticated declaration-completeness measurements or typed blockers that made measurement unavailable. Measured evidence identifies durable sibling snapshots of its LCOV and Recon selection inputs and reconciles trusted declaration ranges; unavailable evidence cannot claim measurements.",
  oneOf: [measuredCoverageEvidenceJsonSchema, unavailableCoverageEvidenceJsonSchema]
} as const;

export type CoverageEvidence = z.infer<typeof coverageEvidenceSchema>;

export function validateCoverageEvidence(
  value: unknown,
  path = "$coverage_evidence"
): SchemaValidationResult<CoverageEvidence> {
  return validateWithZod(coverageEvidenceSchema, value, { path, code: "COVERAGE_EVIDENCE_INVALID" });
}
