import { z } from "zod/v4";

import {
  MAX_GENERATED_TEST_BUNDLE_ENTRIES,
  MAX_GENERATED_TEST_COMPANION_BYTES,
  MAX_GENERATED_TEST_METADATA_CHARS,
  MAX_GENERATED_TEST_PATH_BYTES,
  MAX_GENERATED_TEST_PATH_SEGMENTS,
  MAX_GENERATED_TEST_PROVENANCE_VALUE_CHARS
} from "./artifact-limits.js";

export const GENERATED_TESTS_DIR = "generated-tests";
const GENERATED_TEST_PATH_SEGMENT_PATTERN = "[A-Za-z0-9][A-Za-z0-9._-]{0,127}";
export const GENERATED_TEST_MANIFEST_PATH_PATTERN = `^generated-tests/${GENERATED_TEST_PATH_SEGMENT_PATTERN}(?:/${GENERATED_TEST_PATH_SEGMENT_PATTERN}){0,${MAX_GENERATED_TEST_PATH_SEGMENTS - 2}}(?![\\s\\S])`;

const nonEmptyString = z.string().min(1);
const nonNegativeInteger = z.number().int().nonnegative();
const generatedTestMetadataString = nonEmptyString.max(MAX_GENERATED_TEST_METADATA_CHARS);
const generatedTestProvenanceValue = nonEmptyString.max(MAX_GENERATED_TEST_PROVENANCE_VALUE_CHARS);
const generatedTestFileSize = nonNegativeInteger.min(1).max(MAX_GENERATED_TEST_COMPANION_BYTES);
const generatedTestManifestPathPattern = new RegExp(GENERATED_TEST_MANIFEST_PATH_PATTERN, "u");

export const generatedTestProvenanceSchema = z
  .strictObject({
    producer_node_id: generatedTestProvenanceValue.optional(),
    run_id: generatedTestProvenanceValue.optional(),
    logical_node_id: generatedTestProvenanceValue.optional(),
    attempt_index: nonNegativeInteger.optional(),
    loop_index: nonNegativeInteger.optional(),
    model_id: generatedTestProvenanceValue.optional(),
    model: generatedTestProvenanceValue.optional(),
    model_index: nonNegativeInteger.optional(),
    agent_ref: generatedTestProvenanceValue.optional(),
    workflow_run_id: generatedTestProvenanceValue.optional(),
    workflow_task_id: generatedTestProvenanceValue.optional(),
    source_run_id: generatedTestProvenanceValue.optional(),
    origin: generatedTestProvenanceValue.optional()
  })
  .meta({ id: "generatedTestProvenance", minProperties: 1 })
  .refine((provenance) => Object.keys(provenance).length > 0, {
    message: "Present generated-test provenance must contain at least one typed field"
  });

export const generatedTestPathSchema = z
  .string()
  .min(1)
  .max(MAX_GENERATED_TEST_PATH_BYTES)
  .regex(generatedTestManifestPathPattern, {
    message: `path must use the ${GENERATED_TESTS_DIR}/<file> prefix, contain at most ${MAX_GENERATED_TEST_PATH_SEGMENTS} segments, and stay inside that directory`
  })
  .meta({ id: "generatedTestPath" });

export const generatedTestEntrySchema = z
  .strictObject({
    path: generatedTestPathSchema,
    size_bytes: generatedTestFileSize,
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    provenance: generatedTestProvenanceSchema.optional(),
    language: generatedTestMetadataString.optional(),
    framework: generatedTestMetadataString.optional(),
    description: generatedTestMetadataString.optional()
  })
  .meta({ id: "generatedTestEntry" });

export const generatedTestEntriesSchema = z
  .array(generatedTestEntrySchema)
  .max(MAX_GENERATED_TEST_BUNDLE_ENTRIES)
  .meta({ uniqueItems: true })
  .superRefine((entries, context) => {
    const seen = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      const key = canonicalJsonValueKey(entry);
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          message: "Generated-test manifest entries must be unique within each array",
          path: [index]
        });
      }
      seen.add(key);
    }
  });

function canonicalJsonValueKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJsonValueKey(entry)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJsonValueKey(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
