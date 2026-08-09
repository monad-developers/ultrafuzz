import fs from "node:fs";
import path from "node:path";

import { z } from "zod/v4";

import { normalizeArtifactProvenance, type ArtifactProvenance } from "./manifests.js";
import { getNodeArtifactDir, type RunLayout } from "./run-layout.js";
import {
  ArtifactPathError,
  assertRegularFileInside,
  ensureSafeDirectory,
  normalizeSafeRelativePath,
  prepareSafeFilePath,
  readJsonFile,
  sha256File,
  writeFileDurable,
  writeJsonDurable
} from "./safe-paths.js";
import { schemaErrorMessage, validateWithZod, type SchemaValidationResult } from "./schema-validation.js";

export const GENERATED_TESTS_SCHEMA_VERSION = "1.0";
export const GENERATED_TESTS_DIR = "generated-tests";
export const GENERATED_TESTS_MANIFEST = "generated-tests.json";
export const GENERATED_TESTS_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:generated-tests:2" as const;
export const GENERATED_TEST_MANIFEST_PATH_PATTERN =
  "^generated-tests/[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,127})*(?![\\s\\S])" as const;

export interface GeneratedTestInput {
  path: string;
  content?: string | Uint8Array;
  language?: string;
  framework?: string;
  description?: string;
  provenance?: Partial<ArtifactProvenance>;
}

export interface GeneratedTestEntry {
  path: string;
  size_bytes?: number;
  sha256?: string;
  provenance?: ArtifactProvenance;
  language?: string;
  framework?: string;
  description?: string;
}

export interface GeneratedTestManifest {
  schema_version: string;
  run_id: string;
  node_id: string;
  generated_tests: GeneratedTestEntry[];
  provenance?: ArtifactProvenance;
}

const nonEmptyString = z.string().min(1);
const nonNegativeInteger = z.number().int().nonnegative();
const generatedTestManifestPathPattern = new RegExp(GENERATED_TEST_MANIFEST_PATH_PATTERN, "u");

const artifactProvenanceSchema = z.looseObject({
  producer_node_id: nonEmptyString.optional(),
  run_id: nonEmptyString.optional(),
  logical_node_id: nonEmptyString.optional(),
  attempt_index: nonNegativeInteger.optional(),
  loop_index: nonNegativeInteger.optional(),
  model_id: nonEmptyString.optional(),
  model: nonEmptyString.optional(),
  model_index: nonNegativeInteger.optional(),
  agent_ref: nonEmptyString.optional(),
  workflow_run_id: nonEmptyString.optional(),
  workflow_task_id: nonEmptyString.optional(),
  source_run_id: nonEmptyString.optional(),
  origin: nonEmptyString.optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const generatedTestPathSchema = nonEmptyString.refine((value) => isSafeGeneratedTestManifestPath(value), {
  message: `path must use the ${GENERATED_TESTS_DIR}/<file> prefix and stay inside that directory`
});

export const generatedTestEntrySchema = z.looseObject({
  path: generatedTestPathSchema,
  size_bytes: nonNegativeInteger.optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  provenance: artifactProvenanceSchema.optional(),
  language: nonEmptyString.optional(),
  framework: nonEmptyString.optional(),
  description: nonEmptyString.optional()
});

export const generatedTestManifestSchema = z.looseObject({
  schema_version: z.literal(GENERATED_TESTS_SCHEMA_VERSION),
  run_id: nonEmptyString,
  node_id: nonEmptyString,
  generated_tests: z.array(generatedTestEntrySchema),
  provenance: artifactProvenanceSchema.optional()
});

export const generatedTestsJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: GENERATED_TESTS_JSON_SCHEMA_ID,
  title: "Ultrafuzz generated tests manifest",
  type: "object",
  required: ["schema_version", "run_id", "node_id", "generated_tests"],
  additionalProperties: true,
  properties: {
    schema_version: { const: GENERATED_TESTS_SCHEMA_VERSION },
    run_id: { type: "string", minLength: 1 },
    node_id: { type: "string", minLength: 1 },
    generated_tests: {
      type: "array",
      items: {
        type: "object",
        required: ["path"],
        additionalProperties: true,
        properties: {
          path: { type: "string", pattern: GENERATED_TEST_MANIFEST_PATH_PATTERN },
          size_bytes: { type: "integer", minimum: 0 },
          sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          provenance: {
            type: "object",
            additionalProperties: true,
            properties: {
              producer_node_id: { type: "string", minLength: 1 },
              run_id: { type: "string", minLength: 1 },
              logical_node_id: { type: "string", minLength: 1 },
              attempt_index: { type: "integer", minimum: 0 },
              loop_index: { type: "integer", minimum: 0 },
              model_id: { type: "string", minLength: 1 },
              model: { type: "string", minLength: 1 },
              model_index: { type: "integer", minimum: 0 },
              agent_ref: { type: "string", minLength: 1 },
              workflow_run_id: { type: "string", minLength: 1 },
              workflow_task_id: { type: "string", minLength: 1 },
              source_run_id: { type: "string", minLength: 1 },
              origin: { type: "string", minLength: 1 },
              metadata: { type: "object", additionalProperties: true }
            }
          },
          language: { type: "string", minLength: 1 },
          framework: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 }
        }
      }
    },
    provenance: {
      type: "object",
      additionalProperties: true,
      properties: {
        producer_node_id: { type: "string", minLength: 1 },
        run_id: { type: "string", minLength: 1 },
        logical_node_id: { type: "string", minLength: 1 },
        attempt_index: { type: "integer", minimum: 0 },
        loop_index: { type: "integer", minimum: 0 },
        model_id: { type: "string", minLength: 1 },
        model: { type: "string", minLength: 1 },
        model_index: { type: "integer", minimum: 0 },
        agent_ref: { type: "string", minLength: 1 },
        workflow_run_id: { type: "string", minLength: 1 },
        workflow_task_id: { type: "string", minLength: 1 },
        source_run_id: { type: "string", minLength: 1 },
        origin: { type: "string", minLength: 1 },
        metadata: { type: "object", additionalProperties: true }
      }
    }
  }
} as const;

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
  const result = validateGeneratedTestManifestSchema(value);
  if (!result.ok || !result.value) {
    throw new Error(schemaErrorMessage("generated tests manifest", result.issues));
  }
  return result.value;
}

export function writeGeneratedTestManifest(input: {
  layout: RunLayout;
  nodeId: string;
  tests: GeneratedTestInput[];
  provenance?: Partial<ArtifactProvenance>;
}): GeneratedTestManifest {
  const nodeDir = getNodeArtifactDir(input.layout, input.nodeId, { create: true });
  ensureSafeDirectory(nodeDir, GENERATED_TESTS_DIR);
  const provenance = normalizeArtifactProvenance(input.layout, input.nodeId, input.provenance);
  const generated_tests = input.tests.map((test) => writeGeneratedTestEntry(nodeDir, test, provenance));
  const manifest: GeneratedTestManifest = {
    schema_version: GENERATED_TESTS_SCHEMA_VERSION,
    run_id: input.layout.runId,
    node_id: input.nodeId,
    generated_tests,
    provenance
  };
  writeJsonDurable(path.join(nodeDir, GENERATED_TESTS_MANIFEST), manifest);
  return manifest;
}

export function readGeneratedTestManifest(layout: RunLayout, nodeId: string): GeneratedTestManifest {
  return assertGeneratedTestManifestSchema(
    readJsonFile(path.join(getNodeArtifactDir(layout, nodeId), GENERATED_TESTS_MANIFEST))
  );
}

function isSafeGeneratedTestManifestPath(value: string): boolean {
  return generatedTestManifestPathPattern.test(value);
}

function writeGeneratedTestEntry(
  nodeDir: string,
  input: GeneratedTestInput,
  manifestProvenance: ArtifactProvenance
): GeneratedTestEntry {
  const safeRelativeTestPath = normalizeSafeRelativePath(stripGeneratedTestsPrefix(input.path), "generated test path");
  const generatedTestsRoot = path.join(nodeDir, GENERATED_TESTS_DIR);
  const absolutePath = prepareSafeFilePath(generatedTestsRoot, safeRelativeTestPath);
  assertGeneratedTestDestinationIsNotSymlink(absolutePath);
  if (input.content !== undefined) {
    writeFileDurable(absolutePath, input.content);
  }
  assertRegularFileInside(generatedTestsRoot, absolutePath, "generated test file");
  const fileStats = fs.lstatSync(absolutePath);
  if (fileStats.size === 0) {
    throw new Error(`generated test file must be non-empty: ${absolutePath}`);
  }
  const entry: GeneratedTestEntry = {
    path: `${GENERATED_TESTS_DIR}/${safeRelativeTestPath}`,
    size_bytes: fileStats.size,
    sha256: sha256File(absolutePath),
    provenance: normalizeArtifactProvenance(
      { runId: manifestProvenance.run_id ?? "" },
      manifestProvenance.producer_node_id,
      {
        ...manifestProvenance,
        ...input.provenance
      }
    )
  };
  if (input.language !== undefined) {
    entry.language = input.language;
  }
  if (input.framework !== undefined) {
    entry.framework = input.framework;
  }
  if (input.description !== undefined) {
    entry.description = input.description;
  }
  return entry;
}

function assertGeneratedTestDestinationIsNotSymlink(filePath: string): void {
  let fileStats: fs.Stats;
  try {
    fileStats = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (fileStats.isSymbolicLink()) {
    throw new ArtifactPathError("symlink-escape", `generated test file cannot be a symlink: ${filePath}`);
  }
}

function stripGeneratedTestsPrefix(value: string): string {
  return value.replace(/^generated-tests\//u, "");
}
