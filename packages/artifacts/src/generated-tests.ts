import { z } from "zod/v4";

import { MAX_GENERATED_TEST_BUNDLE_BYTES, MAX_GENERATED_TEST_BUNDLE_ENTRIES } from "./artifact-limits.js";
import {
  generatedTestEntriesSchema,
  generatedTestFrameworkSchema,
  generatedTestProvenanceSchema
} from "./generated-test-schema.js";
import { validateRegisteredJsonSchema } from "./json-schema-validator.js";
import { type ArtifactProvenance } from "./manifests.js";
import { validateWithZod, type SchemaValidationResult } from "./schema-validation.js";

export const GENERATED_TESTS_SCHEMA_VERSION = "ultrafuzz.generated-tests.v3" as const;
export const GENERATED_TESTS_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:generated-tests:3" as const;

export {
  GENERATED_TESTS_DIR,
  GENERATED_TEST_FRAMEWORK_PATTERN,
  GENERATED_TEST_MANIFEST_PATH_PATTERN,
  generatedTestEntrySchema,
  generatedTestFrameworkSchema,
  generatedTestPathSchema,
  generatedTestProvenanceSchema
} from "./generated-test-schema.js";

export {
  MAX_GENERATED_TEST_BUNDLE_BYTES,
  MAX_GENERATED_TEST_BUNDLE_ENTRIES,
  MAX_GENERATED_TEST_COMPANION_BYTES,
  MAX_GENERATED_TEST_METADATA_CHARS,
  MAX_GENERATED_TEST_PATH_BYTES,
  MAX_GENERATED_TEST_PATH_SEGMENTS,
  MAX_GENERATED_TEST_PROVENANCE_VALUE_CHARS
} from "./artifact-limits.js";

export type GeneratedTestProvenance = Partial<Omit<ArtifactProvenance, "metadata">>;

export interface GeneratedTestEntry {
  path: string;
  size_bytes: number;
  sha256: string;
  provenance?: GeneratedTestProvenance;
  language?: string;
  description?: string;
}

export interface GeneratedTestManifest {
  schema_version: typeof GENERATED_TESTS_SCHEMA_VERSION;
  run_id: string;
  node_id: string;
  framework: string;
  generated_tests: GeneratedTestEntry[];
  support_files: GeneratedTestEntry[];
  provenance?: GeneratedTestProvenance;
}

const nonEmptyString = z.string().min(1);

export const generatedTestManifestSchema = z
  .strictObject({
    schema_version: z.literal(GENERATED_TESTS_SCHEMA_VERSION),
    run_id: nonEmptyString,
    node_id: nonEmptyString,
    framework: generatedTestFrameworkSchema,
    generated_tests: generatedTestEntriesSchema,
    support_files: generatedTestEntriesSchema,
    provenance: generatedTestProvenanceSchema.optional()
  })
  .meta({
    $id: GENERATED_TESTS_JSON_SCHEMA_ID,
    title: "Ultrafuzz generated tests manifest",
    allOf: [
      {
        if: {
          properties: { support_files: { type: "array", minItems: 1 } },
          required: ["support_files"]
        },
        then: {
          properties: { generated_tests: { type: "array", minItems: 1 } },
          required: ["generated_tests"]
        }
      }
    ]
  })
  .superRefine((manifest, context) => {
    if (manifest.support_files.length > 0 && manifest.generated_tests.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Generated-test support files require at least one runnable generated test",
        path: ["generated_tests"]
      });
    }
  });

export const generatedTestsJsonSchema = z.toJSONSchema(generatedTestManifestSchema);

export function validateGeneratedTestManifestSchema(
  value: unknown,
  path = "$"
): SchemaValidationResult<GeneratedTestManifest> {
  return validateWithZod(generatedTestManifestSchema as z.ZodType<GeneratedTestManifest>, value, {
    path,
    code: "GENERATED_TEST_MANIFEST_SCHEMA_INVALID"
  });
}

export function assertGeneratedTestManifestSchema(value: unknown): GeneratedTestManifest {
  const result = validateRegisteredJsonSchema(GENERATED_TESTS_JSON_SCHEMA_ID, value);
  if (!result.ok) {
    throw new Error(
      `generated tests manifest is schema-invalid: ${result.issues
        .map((issue) => `${issue.instancePath || "/"} ${issue.message}`)
        .join("; ")}`
    );
  }
  const manifest = value as GeneratedTestManifest;
  assertGeneratedTestManifestSemantics(manifest);
  return manifest;
}

export function assertGeneratedTestManifestSemantics(manifest: GeneratedTestManifest): void {
  assertGeneratedTestBundleResourceBounds(manifest);
  const paths = new Set<string>();
  for (const entry of [...manifest.generated_tests, ...manifest.support_files]) {
    if (paths.has(entry.path)) {
      throw new Error(`generated tests manifest repeats path ${JSON.stringify(entry.path)}`);
    }
    paths.add(entry.path);
  }
  assertGeneratedTestPathsAreMaterializable(paths);
  if (manifest.generated_tests.length === 0 && manifest.support_files.length > 0) {
    throw new Error("generated tests manifest cannot declare support files without a runnable generated test");
  }
}

export function assertGeneratedTestBundleResourceBounds(manifest: GeneratedTestManifest): void {
  const entries = [...manifest.generated_tests, ...manifest.support_files];
  if (entries.length > MAX_GENERATED_TEST_BUNDLE_ENTRIES) {
    throw new Error(
      `generated tests manifest exceeds the ${MAX_GENERATED_TEST_BUNDLE_ENTRIES}-entry combined bundle limit`
    );
  }
  const declaredBytes = entries.reduce((total, entry) => total + entry.size_bytes, 0);
  if (declaredBytes > MAX_GENERATED_TEST_BUNDLE_BYTES) {
    throw new Error(
      `generated tests manifest exceeds the ${MAX_GENERATED_TEST_BUNDLE_BYTES}-byte combined bundle limit`
    );
  }
}

function assertGeneratedTestPathsAreMaterializable(paths: ReadonlySet<string>): void {
  const directoryOrderedPaths = [...paths].sort((left, right) => {
    const leftDirectory = `${left}/`;
    const rightDirectory = `${right}/`;
    return leftDirectory < rightDirectory ? -1 : leftDirectory > rightDirectory ? 1 : 0;
  });
  for (let index = 1; index < directoryOrderedPaths.length; index += 1) {
    const parentCandidate = directoryOrderedPaths[index - 1]!;
    const childCandidate = directoryOrderedPaths[index]!;
    if (childCandidate.startsWith(`${parentCandidate}/`)) {
      throw new Error(
        `generated tests manifest path ${JSON.stringify(childCandidate)} conflicts with file path ${JSON.stringify(parentCandidate)}`
      );
    }
  }
}
