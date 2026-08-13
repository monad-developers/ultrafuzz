import { z } from "zod/v4";

import { validateWithZod, type SchemaValidationResult } from "./schema-validation.js";

export const COVERAGE_EVIDENCE_SCHEMA_VERSION = "ultrafuzz.coverage-evidence.v1" as const;
export const COVERAGE_EVIDENCE_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:coverage-evidence:1" as const;

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
const range = z
  .strictObject({
    file: safePath,
    kind: sourceKind,
    start_line: z.number().int().positive(),
    end_line: z.number().int().positive(),
    covered: z.boolean()
  })
  .refine((value) => value.end_line >= value.start_line, { message: "end_line must not precede start_line" });
const file = z
  .strictObject({
    path: safePath,
    kind: sourceKind,
    included: z.boolean(),
    critical: z.boolean(),
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
    if (!value.included && value.covered_ranges !== 0) {
      context.addIssue({
        code: "custom",
        message: "excluded files cannot claim covered ranges",
        path: ["covered_ranges"]
      });
    }
    if (value.critical && value.total_ranges === 0) {
      context.addIssue({
        code: "custom",
        message: "declared critical files must contribute a material denominator",
        path: ["total_ranges"]
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
    scope: z.enum(["selected-range", "production-source", "declared-critical-path"]),
    covered_ranges: z.number().int().nonnegative(),
    total_ranges: z.number().int().nonnegative()
  })
  .refine((value) => value.covered_ranges <= value.total_ranges, {
    message: "covered_ranges cannot exceed total_ranges"
  });

export const coverageEvidenceSchema = z
  .strictObject({
    schema_version: z.literal(COVERAGE_EVIDENCE_SCHEMA_VERSION),
    views: z
      .array(view)
      .min(2)
      .superRefine((views, context) => {
        const scopes = new Set(views.map((entry) => entry.scope));
        if (!scopes.has("selected-range") || !scopes.has("production-source")) {
          context.addIssue({
            code: "custom",
            message: "coverage views require selected-range and production-source scopes"
          });
        }
        if (scopes.size !== views.length)
          context.addIssue({ code: "custom", message: "coverage view scopes must be unique" });
      }),
    files: z.array(file).min(1),
    counted_ranges: z.array(range),
    zero_coverage_components: z.array(z.strictObject({ path: safePath, kind: sourceKind })).min(0)
  })
  .superRefine((value, context) => {
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
      if (!declared.included) {
        context.addIssue({
          code: "custom",
          message: "counted ranges must belong to files included in the selected-range scope",
          path: ["counted_ranges", index, "file"]
        });
      }
      const entries = rangesByFile.get(entry.file) ?? [];
      entries.push(entry);
      rangesByFile.set(entry.file, entries);
    }

    for (const [filePath, entries] of rangesByFile) {
      const sorted = [...entries].sort(
        (left, right) => left.start_line - right.start_line || left.end_line - right.end_line
      );
      for (let index = 1; index < sorted.length; index += 1) {
        if (sorted[index]!.start_line <= sorted[index - 1]!.end_line) {
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
      if (entry.included && (entry.total_ranges !== entries.length || entry.covered_ranges !== covered)) {
        context.addIssue({
          code: "custom",
          message: "included file totals must equal their counted ranges",
          path: ["files", index]
        });
      }
    }

    const expectedViews = new Map<string, { covered_ranges: number; total_ranges: number }>();
    const aggregate = (entries: typeof value.files): { covered_ranges: number; total_ranges: number } => ({
      covered_ranges: entries.reduce((sum, entry) => sum + entry.covered_ranges, 0),
      total_ranges: entries.reduce((sum, entry) => sum + entry.total_ranges, 0)
    });
    expectedViews.set("selected-range", aggregate(value.files.filter((entry) => entry.included)));
    expectedViews.set("production-source", aggregate(value.files.filter((entry) => entry.kind === "production")));
    const criticalFiles = value.files.filter((entry) => entry.critical);
    if (criticalFiles.length > 0) expectedViews.set("declared-critical-path", aggregate(criticalFiles));
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
    if (criticalFiles.length > 0 && !value.views.some((entry) => entry.scope === "declared-critical-path")) {
      context.addIssue({
        code: "custom",
        message: "declared critical files require a declared-critical-path view",
        path: ["views"]
      });
    }

    const actualZero = new Set<string>();
    for (const [index, component] of value.zero_coverage_components.entries()) {
      const key = `${component.path}\0${component.kind}`;
      const declared = fileByPath.get(component.path);
      if (actualZero.has(key)) {
        context.addIssue({
          code: "custom",
          message: "zero-coverage components must be unique",
          path: ["zero_coverage_components", index]
        });
      }
      actualZero.add(key);
      if (
        declared === undefined ||
        declared.kind !== component.kind ||
        declared.total_ranges === 0 ||
        declared.covered_ranges !== 0
      ) {
        context.addIssue({
          code: "custom",
          message: "zero-coverage component must match a zero-covered material file",
          path: ["zero_coverage_components", index]
        });
      }
    }
    const expectedZero = value.files
      .filter((entry) => entry.total_ranges > 0 && entry.covered_ranges === 0)
      .map((entry) => `${entry.path}\0${entry.kind}`);
    if (expectedZero.some((key) => !actualZero.has(key)) || actualZero.size !== expectedZero.length) {
      context.addIssue({
        code: "custom",
        message: "zero-coverage components must enumerate every zero-covered material file",
        path: ["zero_coverage_components"]
      });
    }
  });

const sourceKinds = ["production", "test", "harness", "dependency"] as const;
const safePathPattern = "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*//)[^\\\\\\u0000]+$";
export const coverageEvidenceJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: COVERAGE_EVIDENCE_JSON_SCHEMA_ID,
  title: "Ultrafuzz complete coverage denominator",
  description:
    "Producer contract. Semantic validation additionally requires: every counted range joins a declared included file with the same kind; ranges within each file do not overlap; included-file totals equal their counted ranges; selected-range, production-source, and declared-critical-path view totals equal their applicable file totals; and zero_coverage_components exactly enumerates every material file with no covered ranges. Runtime binds excluded production totals and included ranges to the trusted source inventory.",
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "views", "files", "counted_ranges", "zero_coverage_components"],
  properties: {
    schema_version: { const: COVERAGE_EVIDENCE_SCHEMA_VERSION },
    views: {
      type: "array",
      minItems: 2,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["scope", "covered_ranges", "total_ranges"],
        properties: {
          scope: { enum: ["selected-range", "production-source", "declared-critical-path"] },
          covered_ranges: { type: "integer", minimum: 0 },
          total_ranges: { type: "integer", minimum: 0 }
        }
      }
    },
    files: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "kind", "included", "critical", "covered_ranges", "total_ranges"],
        properties: {
          path: { type: "string", minLength: 1, pattern: safePathPattern },
          kind: { enum: sourceKinds },
          included: { type: "boolean" },
          critical: { type: "boolean" },
          exclusion_reason: { type: "string", minLength: 1 },
          covered_ranges: { type: "integer", minimum: 0 },
          total_ranges: { type: "integer", minimum: 0 }
        },
        allOf: [
          {
            if: { properties: { included: { const: false } }, required: ["included"] },
            then: {
              required: ["exclusion_reason"],
              properties: { exclusion_reason: true, covered_ranges: { const: 0 } }
            },
            else: { not: { required: ["exclusion_reason"] } }
          },
          {
            if: { properties: { critical: { const: true } }, required: ["critical"] },
            then: { properties: { total_ranges: { type: "integer", minimum: 1 } } }
          }
        ]
      }
    },
    counted_ranges: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "kind", "start_line", "end_line", "covered"],
        properties: {
          file: { type: "string", minLength: 1, pattern: safePathPattern },
          kind: { enum: sourceKinds },
          start_line: { type: "integer", minimum: 1 },
          end_line: { type: "integer", minimum: 1 },
          covered: { type: "boolean" }
        }
      }
    },
    zero_coverage_components: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "kind"],
        properties: {
          path: { type: "string", minLength: 1, pattern: safePathPattern },
          kind: { enum: sourceKinds }
        }
      }
    }
  }
} as const;

export type CoverageEvidence = z.infer<typeof coverageEvidenceSchema>;

export function validateCoverageEvidence(
  value: unknown,
  path = "$coverage_evidence"
): SchemaValidationResult<CoverageEvidence> {
  return validateWithZod(coverageEvidenceSchema, value, { path, code: "COVERAGE_EVIDENCE_INVALID" });
}
