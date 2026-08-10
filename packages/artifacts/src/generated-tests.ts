import fs from "node:fs";
import path from "node:path";

import { z } from "zod/v4";

import { MAX_GENERATED_TEST_COMPANION_BYTES } from "./artifact-limits.js";
import { validateRegisteredJsonSchema } from "./json-schema-validator.js";
import { normalizeArtifactProvenance, type ArtifactProvenance } from "./manifests.js";
import { getNodeArtifactDir, type RunLayout } from "./run-layout.js";
import {
  ArtifactPathError,
  assertRegularFileInside,
  ensureSafeDirectory,
  normalizeSafeRelativePath,
  prepareSafeFilePath,
  sha256File,
  writeFileDurable,
  writeJsonDurable
} from "./safe-paths.js";
import { readRegularFileSnapshot } from "./schema-registry.js";
import { validateWithZod, type SchemaValidationResult } from "./schema-validation.js";
import { parseStrictJsonBytes } from "./strict-json.js";

export const GENERATED_TESTS_SCHEMA_VERSION = "ultrafuzz.generated-tests.v3" as const;
export const GENERATED_TESTS_DIR = "generated-tests";
export const GENERATED_TESTS_MANIFEST = "generated-tests.json";
export const GENERATED_TESTS_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:generated-tests:3" as const;
export const GENERATED_TEST_MANIFEST_PATH_PATTERN =
  "^generated-tests/[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,127})*(?![\\s\\S])" as const;

export type GeneratedTestProvenance = Partial<Omit<ArtifactProvenance, "metadata">>;

export interface GeneratedTestInput {
  path: string;
  content?: string | Uint8Array;
  language?: string;
  framework?: string;
  description?: string;
  provenance?: GeneratedTestProvenance;
}

export interface GeneratedTestEntry {
  path: string;
  size_bytes?: number;
  sha256?: string;
  provenance?: GeneratedTestProvenance;
  language?: string;
  framework?: string;
  description?: string;
}

export interface GeneratedTestManifest {
  schema_version: typeof GENERATED_TESTS_SCHEMA_VERSION;
  run_id: string;
  node_id: string;
  generated_tests: GeneratedTestEntry[];
  support_files: GeneratedTestEntry[];
  provenance?: GeneratedTestProvenance;
}

const nonEmptyString = z.string().min(1);
const nonNegativeInteger = z.number().int().nonnegative();
const generatedTestFileSize = nonNegativeInteger.max(MAX_GENERATED_TEST_COMPANION_BYTES);
const generatedTestManifestPathPattern = new RegExp(GENERATED_TEST_MANIFEST_PATH_PATTERN, "u");

export const generatedTestProvenanceSchema = z
  .strictObject({
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
    origin: nonEmptyString.optional()
  })
  .meta({ id: "generatedTestProvenance", minProperties: 1 })
  .refine((provenance) => Object.keys(provenance).length > 0, {
    message: "Present generated-test provenance must contain at least one typed field"
  });

const generatedTestPathSchema = nonEmptyString.regex(generatedTestManifestPathPattern, {
  message: `path must use the ${GENERATED_TESTS_DIR}/<file> prefix and stay inside that directory`
});

export const generatedTestEntrySchema = z
  .strictObject({
    path: generatedTestPathSchema,
    size_bytes: generatedTestFileSize.optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    provenance: generatedTestProvenanceSchema.optional(),
    language: nonEmptyString.optional(),
    framework: nonEmptyString.optional(),
    description: nonEmptyString.optional()
  })
  .meta({ id: "generatedTestEntry" });

export const generatedTestManifestSchema = z
  .strictObject({
    schema_version: z.literal(GENERATED_TESTS_SCHEMA_VERSION),
    run_id: nonEmptyString,
    node_id: nonEmptyString,
    generated_tests: z.array(generatedTestEntrySchema),
    support_files: z.array(generatedTestEntrySchema),
    provenance: generatedTestProvenanceSchema.optional()
  })
  .meta({
    $id: GENERATED_TESTS_JSON_SCHEMA_ID,
    title: "Ultrafuzz generated tests manifest"
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
  const paths = new Set<string>();
  for (const entry of [...manifest.generated_tests, ...manifest.support_files]) {
    if (paths.has(entry.path)) {
      throw new Error(`generated tests manifest repeats path ${JSON.stringify(entry.path)}`);
    }
    paths.add(entry.path);
  }
  if (manifest.generated_tests.length === 0 && manifest.support_files.length > 0) {
    throw new Error("generated tests manifest cannot declare support files without a runnable generated test");
  }
}

export function writeGeneratedTestManifest(input: {
  layout: RunLayout;
  nodeId: string;
  tests: GeneratedTestInput[];
  supportFiles: GeneratedTestInput[];
  provenance?: GeneratedTestProvenance;
}): GeneratedTestManifest {
  preflightGeneratedTestInputs(input.tests, input.supportFiles);
  const nodeDir = getNodeArtifactDir(input.layout, input.nodeId, { create: true });
  ensureSafeDirectory(nodeDir, GENERATED_TESTS_DIR);
  const provenance = normalizeArtifactProvenance(input.layout, input.nodeId, input.provenance);
  const generated_tests = input.tests.map((test) => writeGeneratedTestEntry(nodeDir, test, provenance));
  const support_files = input.supportFiles.map((supportFile) =>
    writeGeneratedTestEntry(nodeDir, supportFile, provenance)
  );
  const manifest: GeneratedTestManifest = {
    schema_version: GENERATED_TESTS_SCHEMA_VERSION,
    run_id: input.layout.runId,
    node_id: input.nodeId,
    generated_tests,
    support_files,
    provenance
  };
  assertGeneratedTestManifestSchema(manifest);
  writeJsonDurable(path.join(nodeDir, GENERATED_TESTS_MANIFEST), manifest);
  return manifest;
}

export function readGeneratedTestManifest(layout: RunLayout, nodeId: string): GeneratedTestManifest {
  const manifestPath = path.join(getNodeArtifactDir(layout, nodeId), GENERATED_TESTS_MANIFEST);
  return assertGeneratedTestManifestSchema(
    parseStrictJsonBytes(readRegularFileSnapshot(manifestPath, 64 * 1024 * 1024))
  );
}

function writeGeneratedTestEntry(
  nodeDir: string,
  input: GeneratedTestInput,
  manifestProvenance: GeneratedTestProvenance & Pick<ArtifactProvenance, "producer_node_id">
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
  if (fileStats.size > MAX_GENERATED_TEST_COMPANION_BYTES) {
    throw new Error(
      `generated test file exceeds the ${MAX_GENERATED_TEST_COMPANION_BYTES}-byte limit: ${absolutePath}`
    );
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

function preflightGeneratedTestInputs(
  tests: readonly GeneratedTestInput[],
  supportFiles: readonly GeneratedTestInput[]
): void {
  if (tests.length === 0 && supportFiles.length > 0) {
    throw new Error("generated tests manifest cannot declare support files without a runnable generated test");
  }
  const paths = new Set<string>();
  for (const [label, entries] of [
    ["generated test", tests],
    ["generated-test support file", supportFiles]
  ] as const) {
    for (const entry of entries) {
      const safeRelativePath = normalizeSafeRelativePath(stripGeneratedTestsPrefix(entry.path), `${label} path`);
      const manifestPath = `${GENERATED_TESTS_DIR}/${safeRelativePath}`;
      if (paths.has(manifestPath)) {
        throw new Error(`generated tests manifest repeats path ${JSON.stringify(manifestPath)}`);
      }
      paths.add(manifestPath);
      if (entry.content !== undefined && entry.content.length === 0) {
        throw new Error(`${label} file must be non-empty: ${manifestPath}`);
      }
      if (entry.content !== undefined && Buffer.byteLength(entry.content) > MAX_GENERATED_TEST_COMPANION_BYTES) {
        throw new Error(`${label} file exceeds the ${MAX_GENERATED_TEST_COMPANION_BYTES}-byte limit: ${manifestPath}`);
      }
    }
  }
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
