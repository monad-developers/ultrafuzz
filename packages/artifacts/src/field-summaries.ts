import fs from "node:fs";
import path from "node:path";

import { artifactSchemaDirectory, readRegularFileSnapshot } from "./schema-registry.js";
import { parseStrictJsonBytes } from "./strict-json.js";

/**
 * Derived field summaries beside the schemas (#1298). Several pinned schemas exceed what an agent
 * can read in one call, so output-contract prompts point at a summary of the shape and name the
 * JSON Pointer to query for anything it omits. A summary is never a validation input: the schema
 * remains the sole authority, and the summary is generated from it by
 * `scripts/schema-field-summaries.mjs`.
 */
export const SCHEMA_FIELD_SUMMARY_INDEX_FILE = "field-summaries.index.json";

const MAX_FIELD_SUMMARY_INDEX_BYTES = 256 * 1024;

export interface ArtifactSchemaFieldSummary {
  /** Summary filename, beside its schema in the same bundle directory. */
  summaryFilename: string;
  schemaBytes: number;
  summaryBytes: number;
  /** Whether the schema is too large for a single agent read, so the summary is the way in. */
  exceedsSingleRead: boolean;
}

const indexByDirectory = new Map<string, ReadonlyMap<string, ArtifactSchemaFieldSummary>>();

/**
 * The summaries shipped with one schema bundle, keyed by schema filename. A bundle sealed by an
 * earlier release carries no index, which reads as an empty map rather than an error: summaries are
 * an agent-facing convenience, and no run depends on one existing.
 */
export function artifactSchemaFieldSummaries(
  directory: string = artifactSchemaDirectory()
): ReadonlyMap<string, ArtifactSchemaFieldSummary> {
  const resolved = path.resolve(directory);
  const cached = indexByDirectory.get(resolved);
  if (cached !== undefined) return cached;
  const index = readFieldSummaryIndex(resolved);
  indexByDirectory.set(resolved, index);
  return index;
}

/** One schema's summary, or `undefined` when the bundle ships none for it. */
export function artifactSchemaFieldSummary(
  schemaFilename: string,
  directory?: string
): ArtifactSchemaFieldSummary | undefined {
  return artifactSchemaFieldSummaries(directory).get(schemaFilename);
}

function readFieldSummaryIndex(directory: string): ReadonlyMap<string, ArtifactSchemaFieldSummary> {
  const indexPath = path.join(directory, SCHEMA_FIELD_SUMMARY_INDEX_FILE);
  if (!fs.existsSync(indexPath)) return Object.freeze(new Map());
  const parsed = parseStrictJsonBytes(readRegularFileSnapshot(indexPath, MAX_FIELD_SUMMARY_INDEX_BYTES), {
    maxBytes: MAX_FIELD_SUMMARY_INDEX_BYTES,
    maxDepth: 8,
    maxItems: 10_000,
    maxProperties: 10_000
  });
  if (!isRecord(parsed) || !isRecord(parsed.summaries)) {
    throw new Error(`artifact schema field summary index is malformed: ${indexPath}`);
  }
  const entries = new Map<string, ArtifactSchemaFieldSummary>();
  for (const [schemaFilename, value] of Object.entries(parsed.summaries)) {
    if (!schemaFilename.endsWith(".schema.json") || schemaFilename.includes("/") || schemaFilename.includes("\\")) {
      throw new Error(`artifact schema field summary index names an unsafe schema: ${schemaFilename}`);
    }
    if (
      !isRecord(value) ||
      typeof value.summary_filename !== "string" ||
      !value.summary_filename.endsWith(".summary.txt") ||
      value.summary_filename.includes("/") ||
      value.summary_filename.includes("\\") ||
      !Number.isSafeInteger(value.schema_bytes) ||
      !Number.isSafeInteger(value.summary_bytes) ||
      typeof value.exceeds_single_read !== "boolean"
    ) {
      throw new Error(`artifact schema field summary index entry is malformed: ${schemaFilename}`);
    }
    entries.set(
      schemaFilename,
      Object.freeze({
        summaryFilename: value.summary_filename,
        schemaBytes: value.schema_bytes as number,
        summaryBytes: value.summary_bytes as number,
        exceedsSingleRead: value.exceeds_single_read
      })
    );
  }
  return Object.freeze(entries);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
