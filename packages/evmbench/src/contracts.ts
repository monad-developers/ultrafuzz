import { parseStrictJsonBytes } from "@ultrafuzz/artifacts";
import { z, type ZodType } from "zod/v4";

import { assertEvmbenchJsonSchema } from "./schema-registry.js";
import { assertEvmbenchDocumentSemantics } from "./semantic-gates.js";

export const EVMBENCH_PROFILE_VERSION = "ultrafuzz.evmbench.profile.v2" as const;
export const EVMBENCH_DEFINITION_VERSION = "ultrafuzz.evmbench.lock.v2" as const;
export const EVMBENCH_CATALOG_VERSION = "ultrafuzz.evmbench.catalog.v2" as const;
export const EVMBENCH_RESULT_VERSION = "ultrafuzz.evmbench.result.v2" as const;

export const EVMBENCH_PROFILE_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:evmbench:profile:2" as const;
export const EVMBENCH_LOCK_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:evmbench:lock:2" as const;
export const EVMBENCH_CATALOG_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:evmbench:catalog:2" as const;
export const EVMBENCH_RESULT_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:evmbench:result:2" as const;

export const evmbenchCommitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
export const evmbenchDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
export const evmbenchSafeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const modelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u);
const reasoningSchema = evmbenchSafeIdSchema;

export const evmbenchProfileSchema = z
  .object({
    schema_version: z.literal(EVMBENCH_PROFILE_VERSION),
    id: z.enum(["smoke", "full"]),
    max_concurrency: z.number().int().positive().max(32),
    poll_interval_seconds: z.number().int().positive().max(300),
    workflow_timeout_seconds: z.number().int().positive().max(86_400),
    node_timeout_seconds: z.number().int().positive().max(86_400),
    model: modelSchema,
    reasoning: reasoningSchema
  })
  .strict();

export type EvmbenchProfile = z.infer<typeof evmbenchProfileSchema>;

export const evmbenchPublicSnapshotRepositorySchema = z
  .string()
  .regex(/^https:\/\/github\.com\/evmbench-org\/[A-Za-z0-9_.-]+\.git$/u, {
    message: "target repository must be a public EVMBench snapshot"
  });

export const evmbenchCatalogAuditSchema = z
  .object({
    id: evmbenchSafeIdSchema,
    repository: evmbenchPublicSnapshotRepositorySchema,
    framework: evmbenchSafeIdSchema.nullable(),
    target_commit: evmbenchCommitSchema,
    audit_context_sha256: evmbenchDigestSchema,
    ground_truth_manifest_sha256: evmbenchDigestSchema
  })
  .strict();

export const evmbenchCatalogSchema = z
  .object({
    schema_version: z.literal(EVMBENCH_CATALOG_VERSION),
    audits: z
      .array(evmbenchCatalogAuditSchema)
      .min(1)
      .superRefine((audits, context) => addJsonUniqueItemsIssues(audits, context))
  })
  .strict();

export const evmbenchLockSchema = z
  .object({
    schema_version: z.literal(EVMBENCH_DEFINITION_VERSION),
    evmbench: z
      .object({
        repository: z.literal("https://github.com/paradigmxyz/evmbench.git"),
        commit: evmbenchCommitSchema
      })
      .strict(),
    frontier_evals: z
      .object({
        repository: z.literal("https://github.com/openai/frontier-evals.git"),
        commit: evmbenchCommitSchema
      })
      .strict(),
    selected_split: z.literal("detect-tasks"),
    splits: z
      .object({
        debug: z
          .array(evmbenchSafeIdSchema)
          .min(1)
          .superRefine((values, context) => addJsonUniqueItemsIssues(values, context)),
        "detect-tasks": z
          .array(evmbenchSafeIdSchema)
          .min(1)
          .superRefine((values, context) => addJsonUniqueItemsIssues(values, context))
      })
      .strict(),
    catalog: z.object({ path: z.literal("audit-catalog.json"), sha256: evmbenchDigestSchema }).strict()
  })
  .strict();

export type EvmbenchCatalog = z.infer<typeof evmbenchCatalogSchema>;
export type EvmbenchCatalogAudit = z.infer<typeof evmbenchCatalogAuditSchema>;
export type EvmbenchLock = z.infer<typeof evmbenchLockSchema>;

export const evmbenchPerAuditMetricsSchema = z
  .object({
    score: z.number().nonnegative(),
    max_score: z.number().positive(),
    n_runs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    detect_award: z.number().nonnegative(),
    detect_max_award: z.number().nonnegative()
  })
  .strict();

export const evmbenchOfficialMetricsSchema = z
  .object({
    score: z.number().nonnegative(),
    max_score: z.number().positive(),
    recall: z.number().min(0).max(1),
    detect_award: z.number().nonnegative(),
    detect_max_award: z.number().nonnegative(),
    per_audit: z
      .record(evmbenchSafeIdSchema, evmbenchPerAuditMetricsSchema)
      .refine((perAudit) => Object.keys(perAudit).length > 0, "per_audit must not be empty")
  })
  .strict();

export const evmbenchRunProvenanceSchema = z
  .object({
    benchmark_identity: evmbenchDigestSchema,
    ultrafuzz_commit: evmbenchCommitSchema,
    ultrafuzz_dirty: z.boolean(),
    evmbench_commit: evmbenchCommitSchema,
    frontier_evals_commit: evmbenchCommitSchema,
    targets: z
      .array(z.object({ audit_id: evmbenchSafeIdSchema, source_commit: evmbenchCommitSchema }).strict())
      .min(1)
      .superRefine((targets, context) => addJsonUniqueItemsIssues(targets, context)),
    audit_images: z
      .array(
        z
          .object({
            audit_id: evmbenchSafeIdSchema,
            source_image_digest: evmbenchDigestSchema,
            overlay_image_digest: evmbenchDigestSchema.nullable()
          })
          .strict()
      )
      .min(1)
      .superRefine((images, context) => addJsonUniqueItemsIssues(images, context)),
    profile: z.enum(["smoke", "full"]),
    profile_fingerprint: evmbenchDigestSchema,
    topology_fingerprint: evmbenchDigestSchema,
    model: modelSchema,
    agent: z.enum(["ultrafuzz", "official-gold"]),
    reasoning: reasoningSchema,
    concurrency: z.number().int().positive().max(32)
  })
  .strict()
  .superRefine((provenance, context) => {
    if (
      provenance.agent === "official-gold" &&
      provenance.audit_images.some((image) => image.overlay_image_digest !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["audit_images"],
        message: "official-gold provenance must not identify Ultrafuzz overlay images"
      });
    }
    if (
      provenance.agent === "ultrafuzz" &&
      provenance.audit_images.some((image) => image.overlay_image_digest === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["audit_images"],
        message: "Ultrafuzz provenance requires every overlay image digest"
      });
    }
  });

const completenessSchema = z
  .object({
    runtime: z.enum(["complete", "unavailable"]),
    token_usage: z.enum(["complete", "unavailable"]),
    cost: z.enum(["complete", "unavailable"])
  })
  .strict();

export const evmbenchOperationalMetricsSchema = z
  .object({
    runtime_seconds: z.number().nonnegative().nullable(),
    token_usage: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    cost_usd: z.number().nonnegative().nullable(),
    completeness: completenessSchema
  })
  .strict()
  .superRefine((operational, context) => {
    addCompletenessIssue(operational.runtime_seconds, operational.completeness.runtime, "runtime_seconds", context);
    addCompletenessIssue(operational.token_usage, operational.completeness.token_usage, "token_usage", context);
    addCompletenessIssue(operational.cost_usd, operational.completeness.cost, "cost_usd", context);
  });

export const normalizedEvmbenchResultSchema = z
  .object({
    schema_version: z.literal(EVMBENCH_RESULT_VERSION),
    official_evmbench: evmbenchOfficialMetricsSchema,
    provenance: evmbenchRunProvenanceSchema,
    operational: evmbenchOperationalMetricsSchema
  })
  .strict();

export type EvmbenchRunProvenance = z.infer<typeof evmbenchRunProvenanceSchema>;
export type EvmbenchOperationalMetrics = z.infer<typeof evmbenchOperationalMetricsSchema>;
export type NormalizedEvmbenchResult = z.infer<typeof normalizedEvmbenchResultSchema>;

export function parseEvmbenchProfileBytes(bytes: Uint8Array, label = "EVMBench profile"): EvmbenchProfile {
  return parseDocument(bytes, EVMBENCH_PROFILE_JSON_SCHEMA_ID, evmbenchProfileSchema, label);
}

export function parseEvmbenchLockBytes(bytes: Uint8Array, label = "EVMBench lock"): EvmbenchLock {
  return parseDocument(bytes, EVMBENCH_LOCK_JSON_SCHEMA_ID, evmbenchLockSchema, label);
}

export function parseEvmbenchCatalogBytes(bytes: Uint8Array, label = "EVMBench catalog"): EvmbenchCatalog {
  return parseDocument(bytes, EVMBENCH_CATALOG_JSON_SCHEMA_ID, evmbenchCatalogSchema, label);
}

export function parseNormalizedEvmbenchResultBytes(
  bytes: Uint8Array,
  label = "normalized EVMBench result"
): NormalizedEvmbenchResult {
  return parseDocument(bytes, EVMBENCH_RESULT_JSON_SCHEMA_ID, normalizedEvmbenchResultSchema, label);
}

export function serializeEvmbenchProfile(profile: EvmbenchProfile): Buffer {
  return serializeDocument(profile, EVMBENCH_PROFILE_JSON_SCHEMA_ID, evmbenchProfileSchema, "EVMBench profile");
}

export function serializeEvmbenchLock(lock: EvmbenchLock): Buffer {
  return serializeDocument(lock, EVMBENCH_LOCK_JSON_SCHEMA_ID, evmbenchLockSchema, "EVMBench lock");
}

export function serializeEvmbenchCatalog(catalog: EvmbenchCatalog): Buffer {
  return serializeDocument(catalog, EVMBENCH_CATALOG_JSON_SCHEMA_ID, evmbenchCatalogSchema, "EVMBench catalog");
}

export function serializeNormalizedEvmbenchResult(result: NormalizedEvmbenchResult): Buffer {
  return serializeDocument(
    result,
    EVMBENCH_RESULT_JSON_SCHEMA_ID,
    normalizedEvmbenchResultSchema,
    "normalized EVMBench result"
  );
}

function parseDocument<T>(bytes: Uint8Array, schemaId: string, schema: ZodType<T>, label: string): T {
  const value = parseStrictJsonBytes(bytes, {
    maxBytes: 64 * 1024 * 1024,
    maxDepth: 128,
    maxItems: 250_000,
    maxProperties: 250_000
  });
  assertEvmbenchJsonSchema(schemaId, value, label);
  const parsed = schema.parse(value);
  assertEvmbenchDocumentSemantics(schemaId, parsed);
  return parsed;
}

function serializeDocument<T>(value: T, schemaId: string, schema: ZodType<T>, label: string): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  parseDocument(bytes, schemaId, schema, label);
  return bytes;
}

function addJsonUniqueItemsIssues(values: readonly unknown[], context: z.core.$RefinementCtx): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    const identity = canonicalJsonIdentity(value);
    if (seen.has(identity)) context.addIssue({ code: "custom", path: [index], message: "duplicate array item" });
    seen.add(identity);
  }
}

function addCompletenessIssue(
  value: number | null,
  completeness: "complete" | "unavailable",
  field: string,
  context: z.core.$RefinementCtx
): void {
  if ((completeness === "complete") !== (value !== null)) {
    context.addIssue({ code: "custom", path: [field], message: `${field} does not match its completeness label` });
  }
}

function canonicalJsonIdentity(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonIdentity).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJsonIdentity(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
