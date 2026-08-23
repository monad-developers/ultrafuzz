import { z } from "zod/v4";

import { validateWithZod, type SchemaValidationIssue, type SchemaValidationResult } from "./schema-validation.js";
import { executeSemanticGate } from "./semantic-gates.js";

export const INVARIANT_SOURCE_PROOF_SCHEMA_VERSION = "ultrafuzz.invariant-source-proof.v1" as const;

const fullSha = /^[0-9a-f]{40}$/u;
const sha256 = /^[0-9a-f]{64}$/u;

/**
 * A durable, text-only snapshot of the source files used by the discovery
 * invariant ledger.  The snapshot is written before a task worktree may be
 * reclaimed, so later artifact gates do not have to trust a mutable worktree.
 */
export const invariantSourceProofFileSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .refine((value) => !value.includes("\u0000"), { message: "Source proof paths cannot contain NUL bytes" })
    .refine((value) => !value.includes("\\"), { message: "Source proof paths must use POSIX separators" })
    .refine((value) => !value.startsWith("/") && !/^[A-Za-z]:/u.test(value), {
      message: "Source proof paths must be target-relative"
    })
    .refine((value) => !value.split("/").some((segment) => segment === ".."), {
      message: "Source proof paths cannot traverse outside the target"
    }),
  sha256: z.string().regex(sha256),
  content: z
    .string()
    .refine((value) => !value.includes("\u0000"), { message: "Source proof content must be UTF-8 text" })
});

export const invariantSourceProofSchema = z.strictObject({
  schema_version: z.literal(INVARIANT_SOURCE_PROOF_SCHEMA_VERSION),
  attempt_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  commit: z.string().regex(fullSha),
  tree: z.string().regex(fullSha),
  ledger_sha256: z.string().regex(sha256),
  files: z.array(invariantSourceProofFileSchema)
});

export type InvariantSourceProof = z.infer<typeof invariantSourceProofSchema>;
export type InvariantSourceProofFile = z.infer<typeof invariantSourceProofFileSchema>;

export function validateInvariantSourceProofSchema(
  value: unknown,
  path = "$"
): SchemaValidationResult<InvariantSourceProof> {
  const shape = validateWithZod(invariantSourceProofSchema, value, {
    path,
    code: "INVARIANT_SOURCE_PROOF_SCHEMA_INVALID"
  });
  if (!shape.ok || shape.value === undefined) return shape;
  const semantics = executeSemanticGate("invariant-source-proof-path-uniqueness", { document: shape.value });
  if (semantics.status !== "failed") return shape;
  return {
    ok: false,
    issues: semantics.issues.map((semanticIssue) => ({
      code: "INVARIANT_SOURCE_PROOF_SCHEMA_INVALID",
      message: semanticIssue.message.replace("Duplicate invariant source proof path ", "Duplicate source proof path "),
      path: `${prefixedSemanticPath(path, semanticIssue.path)}.path`
    }))
  };
}

function prefixedSemanticPath(rootPath: string, semanticPath: string): string {
  return semanticPath === "$" ? rootPath : `${rootPath}${semanticPath.slice(1)}`;
}

export function invariantSourceProofSchemaIssues(value: unknown, path = "$"): SchemaValidationIssue[] {
  return validateInvariantSourceProofSchema(value, path).issues;
}

export const invariantSourceProofJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:ultrafuzz:schema:artifacts:invariant-source-proof:1",
  title: "Ultrafuzz invariant source proof",
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "attempt_id", "commit", "tree", "ledger_sha256", "files"],
  properties: {
    schema_version: { const: INVARIANT_SOURCE_PROOF_SCHEMA_VERSION },
    attempt_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
    commit: { type: "string", pattern: "^[0-9a-f]{40}$" },
    tree: { type: "string", pattern: "^[0-9a-f]{40}$" },
    ledger_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "sha256", "content"],
        properties: {
          path: {
            type: "string",
            minLength: 1,
            pattern: "^[^\\\\\\u0000]+$",
            allOf: [
              { not: { pattern: "^/" } },
              { not: { pattern: "^[A-Za-z]:" } },
              { not: { pattern: "(^|/)\\.\\.(?:/|$)" } }
            ]
          },
          sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
          content: { type: "string", pattern: "^[^\\u0000]*$" }
        }
      }
    }
  }
} as const;
