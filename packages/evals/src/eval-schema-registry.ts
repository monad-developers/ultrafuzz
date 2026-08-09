import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  artifactSchemaRegistry,
  createStrictAjv,
  parseStrictJsonBytes,
  readRegularFileSnapshot,
  runValidator,
  schemaRegistryBundleDigest,
  type JsonSchemaValidationResult,
  type SchemaRegistryEntry
} from "@ultrafuzz/artifacts";

type EvalAjv = ReturnType<typeof createStrictAjv>;

export const EVAL_COMMON_SCHEMA_ID = "urn:ultrafuzz:schema:evals:common:2" as const;
export const EVAL_SUITE_SCHEMA_ID = "urn:ultrafuzz:schema:evals:suite:2" as const;
export const EVAL_ADJUDICATION_HANDOFF_SCHEMA_ID = "urn:ultrafuzz:schema:evals:adjudication-handoff:1" as const;
export const EVAL_FINDING_MANIFEST_SCHEMA_ID = "urn:ultrafuzz:schema:evals:finding-manifest:1" as const;
export const EVAL_INSTANCE_CLUSTERS_SCHEMA_ID = "urn:ultrafuzz:schema:evals:instance-clusters:1" as const;
export const EVAL_GROUND_TRUTH_CREDITS_SCHEMA_ID = "urn:ultrafuzz:schema:evals:ground-truth-credits:1" as const;
export const EVAL_BENCHMARK_PROVENANCE_SCHEMA_ID = "urn:ultrafuzz:schema:evals:benchmark-provenance:1" as const;
export const EVAL_BENCHMARK_SOURCE_MANIFEST_SCHEMA_ID =
  "urn:ultrafuzz:schema:evals:benchmark-source-manifest:1" as const;
export const EVAL_BENCHMARK_ANALYSIS_MANIFEST_SCHEMA_ID =
  "urn:ultrafuzz:schema:evals:benchmark-analysis-manifest:1" as const;
export const EVAL_RUN_MANIFEST_SCHEMA_ID = "urn:ultrafuzz:schema:evals:run-manifest:3" as const;
export const EVAL_MATRIX_SCHEMA_ID = "urn:ultrafuzz:schema:evals:matrix:2" as const;
export const EVAL_RUN_RECORD_SCHEMA_ID = "urn:ultrafuzz:schema:evals:run-record:3" as const;
export const EVAL_RUN_SUMMARY_SCHEMA_ID = "urn:ultrafuzz:schema:evals:run-summary:2" as const;
export const EVAL_FINDING_SCORE_SCHEMA_ID = "urn:ultrafuzz:schema:evals:finding-score:1" as const;
export const EVAL_SCORE_SUMMARY_SCHEMA_ID = "urn:ultrafuzz:schema:evals:score-summary:1" as const;
export const EVAL_REVIEW_QUEUE_ITEM_SCHEMA_ID = "urn:ultrafuzz:schema:evals:review-queue-item:2" as const;
export const EVAL_PUBLICATION_STATE_SCHEMA_ID = "urn:ultrafuzz:schema:evals:publication-state:1" as const;
export const EVAL_TELEMETRY_CURSOR_SCHEMA_ID = "urn:ultrafuzz:schema:evals:telemetry-cursor:1" as const;

const MAX_EVAL_SCHEMA_BYTES = 2 * 1024 * 1024;

interface EvalSchemaMetadata {
  role: "runtime-state" | "subschema";
  typescriptExport: keyof typeof EVAL_SCHEMA_EXPORTS;
  semanticGates: readonly string[];
}

export const EVAL_SCHEMA_METADATA: Readonly<Record<string, EvalSchemaMetadata>> = Object.freeze({
  "adjudication-handoff.schema.json": {
    role: "runtime-state",
    typescriptExport: "evalAdjudicationHandoffJsonSchema",
    semanticGates: ["eval-adjudication-handoff-canonical-path"]
  },
  "benchmark-analysis-manifest.schema.json": {
    role: "runtime-state",
    typescriptExport: "evalBenchmarkAnalysisManifestJsonSchema",
    semanticGates: ["eval-benchmark-analysis-manifest-identity-joins"]
  },
  "benchmark-provenance.schema.json": {
    role: "runtime-state",
    typescriptExport: "evalBenchmarkProvenanceJsonSchema",
    semanticGates: ["eval-benchmark-provenance-identity-joins"]
  },
  "benchmark-source-manifest.schema.json": {
    role: "runtime-state",
    typescriptExport: "evalBenchmarkSourceManifestJsonSchema",
    semanticGates: ["eval-benchmark-source-manifest-identity-joins"]
  },
  "eval-common.schema.json": {
    role: "subschema",
    typescriptExport: "evalCommonJsonSchema",
    semanticGates: []
  },
  "eval-finding-score.schema.json": {
    role: "runtime-state",
    typescriptExport: "evalFindingScoreJsonSchema",
    semanticGates: ["eval-finding-score-decision-coupling"]
  },
  "eval-matrix.schema.json": {
    role: "runtime-state",
    typescriptExport: "evalMatrixJsonSchema",
    semanticGates: ["eval-matrix-identity-joins"]
  },
  "eval-publication-state.schema.json": {
    role: "runtime-state",
    typescriptExport: "evalPublicationStateJsonSchema",
    semanticGates: []
  },
  "eval-review-queue-item.schema.json": {
    role: "runtime-state",
    typescriptExport: "evalReviewQueueItemJsonSchema",
    semanticGates: ["eval-review-queue-decision-coupling"]
  },
  "eval-run-manifest.schema.json": {
    role: "runtime-state",
    typescriptExport: "evalRunManifestJsonSchema",
    semanticGates: ["eval-run-manifest-suite-joins"]
  },
  "eval-run-record.schema.json": {
    role: "runtime-state",
    typescriptExport: "evalRunRecordJsonSchema",
    semanticGates: ["eval-run-record-lifecycle-coupling", "eval-recovery-equivalence-coupling"]
  },
  "eval-run-summary.schema.json": {
    role: "runtime-state",
    typescriptExport: "evalRunSummaryJsonSchema",
    semanticGates: [
      "eval-run-summary-count-coupling",
      "eval-run-summary-record-lineage",
      "eval-recovery-equivalence-coupling"
    ]
  },
  "eval-score-summary.schema.json": {
    role: "runtime-state",
    typescriptExport: "evalScoreSummaryJsonSchema",
    semanticGates: [
      "eval-score-summary-count-coupling",
      "eval-score-summary-lineage",
      "eval-recovery-equivalence-coupling"
    ]
  },
  "eval-suite.schema.json": {
    role: "runtime-state",
    typescriptExport: "evalSuiteJsonSchema",
    semanticGates: []
  },
  "finding-manifest.schema.json": {
    role: "runtime-state",
    typescriptExport: "evalFindingManifestJsonSchema",
    semanticGates: ["eval-finding-manifest-identity-joins"]
  },
  "ground-truth-credits.schema.json": {
    role: "runtime-state",
    typescriptExport: "evalGroundTruthCreditsJsonSchema",
    semanticGates: ["eval-ground-truth-credits-identity-joins"]
  },
  "instance-clusters.schema.json": {
    role: "runtime-state",
    typescriptExport: "evalInstanceClustersJsonSchema",
    semanticGates: ["eval-instance-clusters-identity-joins"]
  },
  "telemetry-cursor.schema.json": {
    role: "runtime-state",
    typescriptExport: "evalTelemetryCursorJsonSchema",
    semanticGates: []
  }
});

export function evalSchemaDirectory(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const source = [path.resolve(moduleDirectory, "schema"), path.resolve(moduleDirectory, "..", "schema")].find(
    (candidate) => fs.existsSync(candidate)
  );
  if (source === undefined) throw new Error(`eval schema source is unavailable near ${moduleDirectory}`);
  const stat = fs.lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`eval schema source is unsafe: ${source}`);
  return source;
}

function loadSchemaDocument(filename: string): Readonly<Record<string, unknown>> {
  const bytes = readRegularFileSnapshot(path.join(evalSchemaDirectory(), filename), MAX_EVAL_SCHEMA_BYTES);
  const parsed = parseStrictJsonBytes(bytes, {
    maxBytes: MAX_EVAL_SCHEMA_BYTES,
    maxDepth: 128,
    maxItems: 100_000,
    maxProperties: 100_000
  });
  if (!isRecord(parsed)) throw new Error(`eval schema must be a JSON object: ${filename}`);
  return deepFreeze(parsed);
}

export const evalCommonJsonSchema = loadSchemaDocument("eval-common.schema.json");
export const evalAdjudicationHandoffJsonSchema = loadSchemaDocument("adjudication-handoff.schema.json");
export const evalBenchmarkAnalysisManifestJsonSchema = loadSchemaDocument("benchmark-analysis-manifest.schema.json");
export const evalBenchmarkProvenanceJsonSchema = loadSchemaDocument("benchmark-provenance.schema.json");
export const evalBenchmarkSourceManifestJsonSchema = loadSchemaDocument("benchmark-source-manifest.schema.json");
export const evalFindingScoreJsonSchema = loadSchemaDocument("eval-finding-score.schema.json");
export const evalFindingManifestJsonSchema = loadSchemaDocument("finding-manifest.schema.json");
export const evalGroundTruthCreditsJsonSchema = loadSchemaDocument("ground-truth-credits.schema.json");
export const evalInstanceClustersJsonSchema = loadSchemaDocument("instance-clusters.schema.json");
export const evalMatrixJsonSchema = loadSchemaDocument("eval-matrix.schema.json");
export const evalPublicationStateJsonSchema = loadSchemaDocument("eval-publication-state.schema.json");
export const evalReviewQueueItemJsonSchema = loadSchemaDocument("eval-review-queue-item.schema.json");
export const evalRunManifestJsonSchema = loadSchemaDocument("eval-run-manifest.schema.json");
export const evalRunRecordJsonSchema = loadSchemaDocument("eval-run-record.schema.json");
export const evalRunSummaryJsonSchema = loadSchemaDocument("eval-run-summary.schema.json");
export const evalScoreSummaryJsonSchema = loadSchemaDocument("eval-score-summary.schema.json");
export const evalSuiteJsonSchema = loadSchemaDocument("eval-suite.schema.json");
export const evalTelemetryCursorJsonSchema = loadSchemaDocument("telemetry-cursor.schema.json");

export const EVAL_SCHEMA_EXPORTS = Object.freeze({
  evalAdjudicationHandoffJsonSchema,
  evalBenchmarkAnalysisManifestJsonSchema,
  evalBenchmarkProvenanceJsonSchema,
  evalBenchmarkSourceManifestJsonSchema,
  evalCommonJsonSchema,
  evalFindingScoreJsonSchema,
  evalFindingManifestJsonSchema,
  evalGroundTruthCreditsJsonSchema,
  evalInstanceClustersJsonSchema,
  evalMatrixJsonSchema,
  evalPublicationStateJsonSchema,
  evalReviewQueueItemJsonSchema,
  evalRunManifestJsonSchema,
  evalRunRecordJsonSchema,
  evalRunSummaryJsonSchema,
  evalScoreSummaryJsonSchema,
  evalSuiteJsonSchema,
  evalTelemetryCursorJsonSchema
});

const schemaExportsByFilename: Readonly<Record<string, Readonly<Record<string, unknown>>>> = Object.freeze({
  "adjudication-handoff.schema.json": evalAdjudicationHandoffJsonSchema,
  "benchmark-analysis-manifest.schema.json": evalBenchmarkAnalysisManifestJsonSchema,
  "benchmark-provenance.schema.json": evalBenchmarkProvenanceJsonSchema,
  "benchmark-source-manifest.schema.json": evalBenchmarkSourceManifestJsonSchema,
  "eval-common.schema.json": evalCommonJsonSchema,
  "eval-finding-score.schema.json": evalFindingScoreJsonSchema,
  "eval-matrix.schema.json": evalMatrixJsonSchema,
  "eval-publication-state.schema.json": evalPublicationStateJsonSchema,
  "eval-review-queue-item.schema.json": evalReviewQueueItemJsonSchema,
  "eval-run-manifest.schema.json": evalRunManifestJsonSchema,
  "eval-run-record.schema.json": evalRunRecordJsonSchema,
  "eval-run-summary.schema.json": evalRunSummaryJsonSchema,
  "eval-score-summary.schema.json": evalScoreSummaryJsonSchema,
  "eval-suite.schema.json": evalSuiteJsonSchema,
  "finding-manifest.schema.json": evalFindingManifestJsonSchema,
  "ground-truth-credits.schema.json": evalGroundTruthCreditsJsonSchema,
  "instance-clusters.schema.json": evalInstanceClustersJsonSchema,
  "telemetry-cursor.schema.json": evalTelemetryCursorJsonSchema
});

let cachedRegistry: readonly SchemaRegistryEntry[] | undefined;
let cachedValidator: EvalAjv | undefined;

export function evalSchemaRegistry(): readonly SchemaRegistryEntry[] {
  if (cachedRegistry !== undefined) return cachedRegistry;
  const directory = evalSchemaDirectory();
  const filenames = fs
    .readdirSync(directory)
    .filter((filename) => filename.endsWith(".schema.json"))
    .sort();
  const unknown = filenames.filter((filename) => EVAL_SCHEMA_METADATA[filename] === undefined);
  const missing = Object.keys(EVAL_SCHEMA_METADATA).filter((filename) => !filenames.includes(filename));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `eval schema registry mismatch${unknown.length === 0 ? "" : `; unregistered: ${unknown.join(", ")}`}${missing.length === 0 ? "" : `; missing: ${missing.join(", ")}`}`
    );
  }
  const metadataExportNames = Object.values(EVAL_SCHEMA_METADATA).map((metadata) => metadata.typescriptExport);
  const duplicateExports = metadataExportNames.filter(
    (exportName, index) => metadataExportNames.indexOf(exportName) !== index
  );
  const unusedExports = Object.keys(EVAL_SCHEMA_EXPORTS).filter(
    (exportName) => !metadataExportNames.includes(exportName as keyof typeof EVAL_SCHEMA_EXPORTS)
  );
  if (duplicateExports.length > 0 || unusedExports.length > 0) {
    throw new Error(
      `eval schema export registry mismatch${duplicateExports.length === 0 ? "" : `; duplicated: ${[...new Set(duplicateExports)].sort().join(", ")}`}${unusedExports.length === 0 ? "" : `; unused: ${unusedExports.sort().join(", ")}`}`
    );
  }

  const ids = new Set<string>();
  cachedRegistry = Object.freeze(
    filenames.map((filename): SchemaRegistryEntry => {
      const metadata = EVAL_SCHEMA_METADATA[filename]!;
      const schema = schemaExportsByFilename[filename]!;
      if (EVAL_SCHEMA_EXPORTS[metadata.typescriptExport] !== schema) {
        throw new Error(`eval schema metadata export mismatch: ${filename} names ${metadata.typescriptExport}`);
      }
      if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
        throw new Error(`eval schema must declare Draft 2020-12: ${filename}`);
      }
      const id = schema.$id;
      if (typeof id !== "string" || id.length === 0 || id.includes("#")) {
        throw new Error(`eval schema must have a fragment-free non-empty $id: ${filename}`);
      }
      if (ids.has(id)) throw new Error(`duplicate eval schema $id: ${id}`);
      ids.add(id);
      const bytes = readRegularFileSnapshot(path.join(directory, filename), MAX_EVAL_SCHEMA_BYTES);
      return Object.freeze({
        filename,
        id,
        role: metadata.role,
        contractIds: Object.freeze([]),
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        schema,
        localReferences: Object.freeze([...collectReferences(schema)].sort()),
        semanticGates: Object.freeze([...metadata.semanticGates]),
        typescriptExport: metadata.typescriptExport
      });
    })
  );
  cachedValidator = compileRegistry(cachedRegistry);
  return cachedRegistry;
}

export function evalSchemaBundleDigest(): string {
  return schemaRegistryBundleDigest(evalSchemaRegistry());
}

export function validateEvalJsonSchema(schemaId: string, value: unknown): JsonSchemaValidationResult {
  const validator = evalValidator().getSchema(schemaId);
  if (validator === undefined) throw new Error(`registered eval schema is unavailable: ${schemaId}`);
  return runValidator(validator, value);
}

function evalValidator(): EvalAjv {
  if (cachedValidator !== undefined) return cachedValidator;
  const registry = evalSchemaRegistry();
  cachedValidator ??= compileRegistry(registry);
  return cachedValidator;
}

function compileRegistry(registry: readonly SchemaRegistryEntry[]): EvalAjv {
  const validator = createStrictAjv();
  const findingDependency = artifactSchemaRegistry().find(
    (entry) => entry.id === "urn:ultrafuzz:schema:artifacts:finding:2"
  );
  if (findingDependency === undefined) throw new Error("canonical finding schema dependency is unavailable");
  validator.addSchema(structuredClone(findingDependency.schema), findingDependency.id);
  for (const entry of registry) validator.addSchema(structuredClone(entry.schema), entry.id);
  for (const entry of registry) {
    if (validator.getSchema(entry.id) === undefined) throw new Error(`failed to compile eval schema ${entry.id}`);
  }
  return validator;
}

function collectReferences(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectReferences(entry, output);
    return output;
  }
  if (!isRecord(value)) return output;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "$ref" && typeof entry === "string") output.add(entry);
    collectReferences(entry, output);
  }
  return output;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
