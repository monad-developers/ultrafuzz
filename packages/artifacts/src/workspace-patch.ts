import path from "node:path";

import { z } from "zod/v4";

import { validateWithZod, type SchemaValidationResult } from "./schema-validation.js";

export const WORKSPACE_PATCH_SCHEMA_VERSION = "ultrafuzz.workspace-patch.v1" as const;
export const WORKSPACE_PATCH_JSON_SCHEMA_ID =
  "https://blog.monad.xyz/blog/ultrafuzz#schema/artifacts/workspace-patch" as const;

const gitObjectId = z.string().regex(/^[0-9a-f]{40,64}$/u);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const WORKSPACE_PATCH_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/u;

/** Normalize a target-relative Git path while allowing ordinary dotfiles. */
export function normalizeWorkspacePatchPath(value: string, label = "workspace patch file path"): string {
  if (value.length === 0 || value.includes("\u0000") || value.includes("\\")) {
    throw new Error(`${label} is not a safe relative path`);
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes(":")) {
    throw new Error(`${label} must be target-relative`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} must be canonical and remain inside the target`);
  }
  for (const segment of normalized.split("/")) {
    if (!WORKSPACE_PATCH_SEGMENT.test(segment) || segment === "." || segment === "..") {
      throw new Error(`${label} contains an unsafe path segment`);
    }
  }
  return normalized;
}

const workspacePatchPath = z
  .string()
  .refine(
    (value) => {
      try {
        return normalizeWorkspacePatchPath(value) === value;
      } catch {
        return false;
      }
    },
    {
      message: "Workspace patch paths must be canonical safe relative paths"
    }
  )
  .refine((value) => isSafeWorkspacePatchPath(value), {
    message: "Workspace patch paths cannot modify internal or secret roots"
  });

function isSafeWorkspacePatchPath(value: string): boolean {
  return !value.split("/").some((segment) => {
    return (
      [".git", ".ultrafuzz", ".smithers", "node_modules", "artifacts"].includes(segment) ||
      segment === ".env" ||
      segment.startsWith(".env.") ||
      segment === ".envrc" ||
      segment === ".npmrc"
    );
  });
}

export const workspacePatchFileSchema = z.strictObject({ path: workspacePatchPath });

/**
 * A top-level root the capture left out for exceeding its size ceiling (issue #368).
 *
 * Deliberately validated far more loosely than `files`, and the difference is not an oversight. A
 * `files` path is APPLIED — `applyWorkspacePatch` writes it into the dependent worktree — so every
 * segment there has to survive `normalizeWorkspacePatchPath`. An `excluded_roots` path is the opposite:
 * it names something that was NOT delivered and never will be. Nothing opens it, so the charset rules
 * that keep a written path safe buy nothing here, and imposing them would actively hurt.
 *
 * Concretely: the producer keys these roots on their raw bytes and renders them with `toString("latin1")`
 * (`packages/runtime/src/workspace-handoff.ts`), precisely so that a directory whose name is not valid
 * UTF-8 is matched exactly instead of through a lossy decode that could collide two distinct roots. Run
 * `WORKSPACE_PATCH_SEGMENT` over that and a corpus directory with one non-ASCII byte in its name fails
 * the artifact gate — turning the oversize failure this field exists to report into a contract failure at
 * the same node. That is the exact trade this change was written to remove, so it must not be
 * reintroduced here.
 *
 * What IS enforced is what makes the record readable as a root: one path segment, non-empty, not a
 * relative-path token. All three are unreachable from the producer (git never lists a `.` or `..`
 * component, and the root is by construction the text before the first `/`), so rejecting them cannot
 * fail a real capture — they guard a hand-written or future producer, not this one.
 */
export const workspacePatchExcludedRootSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .refine((value) => !value.includes("/"), { message: "Excluded roots must be a single path segment" })
    .refine((value) => value !== "." && value !== "..", {
      message: "Excluded roots cannot be a relative path token"
    }),
  bytes: z.number().int().nonnegative()
});

export const workspacePatchSchema = z
  .strictObject({
    schema_version: z.literal(WORKSPACE_PATCH_SCHEMA_VERSION),
    base_commit: gitObjectId,
    base_tree: gitObjectId,
    result_tree: gitObjectId,
    patch_sha256: sha256,
    files: z.array(workspacePatchFileSchema),
    // Optional, and absent rather than empty when nothing was excluded, so its mere presence always
    // means content really was left out. Adding it as OPTIONAL is what keeps this backward compatible:
    // every manifest written before #368 stays valid and the schema version does not move.
    excluded_roots: z.array(workspacePatchExcludedRootSchema).optional()
  })
  .superRefine((manifest, context) => {
    const seen = new Set<string>();
    for (const [index, entry] of manifest.files.entries()) {
      if (seen.has(entry.path)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate workspace patch path ${JSON.stringify(entry.path)}`,
          path: ["files", index, "path"]
        });
      }
      seen.add(entry.path);
    }
    // Same rule as `files`, for the same reason: two rows for one root make the byte totals ambiguous,
    // and this record is only useful if an operator can read a root's size straight off it.
    const seenRoots = new Set<string>();
    for (const [index, entry] of (manifest.excluded_roots ?? []).entries()) {
      if (seenRoots.has(entry.path)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate workspace patch excluded root ${JSON.stringify(entry.path)}`,
          path: ["excluded_roots", index, "path"]
        });
      }
      seenRoots.add(entry.path);
    }
  });

export type WorkspacePatchManifest = z.infer<typeof workspacePatchSchema>;

export function validateWorkspacePatchSchema(
  value: unknown,
  path = "$"
): SchemaValidationResult<WorkspacePatchManifest> {
  return validateWithZod(workspacePatchSchema, value, {
    path,
    code: "WORKSPACE_PATCH_SCHEMA_INVALID"
  });
}

export const workspacePatchJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: WORKSPACE_PATCH_JSON_SCHEMA_ID,
  title: "Ultrafuzz workspace patch manifest",
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "base_commit", "base_tree", "result_tree", "patch_sha256", "files"],
  properties: {
    schema_version: { const: WORKSPACE_PATCH_SCHEMA_VERSION },
    base_commit: { type: "string", pattern: "^[0-9a-f]{40,64}$" },
    base_tree: { type: "string", pattern: "^[0-9a-f]{40,64}$" },
    result_tree: { type: "string", pattern: "^[0-9a-f]{40,64}$" },
    patch_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: {
            type: "string",
            minLength: 1,
            pattern: "^[A-Za-z0-9._-]{1,128}(?:/[A-Za-z0-9._-]{1,128})*$",
            allOf: [
              { not: { pattern: "^/" } },
              { not: { pattern: "^[A-Za-z]:" } },
              { not: { pattern: "(^|/)\\.(?:/|$)" } },
              { not: { pattern: "(^|/)\\.\\.(?:/|$)" } },
              { not: { pattern: "(^|/)(?:\\.git|\\.ultrafuzz|\\.smithers|node_modules|artifacts)(?:/|$)" } },
              { not: { pattern: "(^|/)\\.env(?:\\.|/|$)" } },
              { not: { pattern: "(^|/)(?:\\.envrc|\\.npmrc)(?:/|$)" } }
            ]
          }
        }
      }
    },
    excluded_roots: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "bytes"],
        properties: {
          // No charset pattern, unlike `files.items.path` above. See `workspacePatchExcludedRootSchema`:
          // these roots are recorded from raw bytes and never applied, so a non-UTF-8 corpus directory
          // name must not fail the gate. `pattern` is a SEARCH in JSON Schema, so `not: {pattern: "/"}`
          // is "contains no slash" — the single-segment rule — and needs no anchors.
          path: {
            type: "string",
            minLength: 1,
            allOf: [{ not: { pattern: "/" } }, { not: { pattern: "^\\.{1,2}$" } }]
          },
          // Bounded above at `Number.MAX_SAFE_INTEGER`, matching zod's `.int()`, so the two schemas
          // accept the same set rather than diverging at the top of the range.
          bytes: { type: "integer", minimum: 0, maximum: 9007199254740991 }
        }
      }
    }
  }
} as const;
