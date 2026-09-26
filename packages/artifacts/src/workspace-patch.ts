import path from "node:path";

import { z } from "zod/v4";

import { validateWithZod, type SchemaValidationResult } from "./schema-validation.js";
import { executeSemanticGate } from "./semantic-gates.js";

export const WORKSPACE_PATCH_SCHEMA_VERSION = "ultrafuzz.workspace-patch.v1" as const;
export const WORKSPACE_PATCH_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:artifacts:workspace-patch:1" as const;

const gitObjectId = z.string().regex(/^[0-9a-f]{40,64}$/u);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
// The 128-character bound is part of the published ultrafuzz.workspace-patch.v1
// JSON schema; loosening it requires a schema version change.
const WORKSPACE_PATCH_SEGMENT_MAX_LENGTH = 128;
const WORKSPACE_PATCH_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/u;
const WORKSPACE_PATCH_SEGMENT_CHARACTER = /^[A-Za-z0-9._-]$/u;

function unsafeWorkspacePatchSegmentReason(segment: string): string {
  if (segment === "." || segment === "..") return "is a relative directory reference";
  const characters = segment.match(/./gsu) ?? [];
  if (characters.length === 0) return "is empty";
  if (characters.length > WORKSPACE_PATCH_SEGMENT_MAX_LENGTH) {
    return `is ${String(characters.length)} characters long (maximum ${String(WORKSPACE_PATCH_SEGMENT_MAX_LENGTH)})`;
  }
  const disallowed = characters.find((character) => !WORKSPACE_PATCH_SEGMENT_CHARACTER.test(character));
  return `contains disallowed character ${JSON.stringify(disallowed)} (allowed: A-Z, a-z, 0-9, ".", "_", "-")`;
}

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
      throw new Error(
        `${label} ${JSON.stringify(value)} contains an unsafe path segment ${JSON.stringify(segment)}: segment ${unsafeWorkspacePatchSegmentReason(segment)}`
      );
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
export const workspacePatchSourceSnapshotSchema = z.strictObject({
  status: z.literal("preserved"),
  protected_roots: z.array(workspacePatchPath).min(1)
});
export const workspacePatchExcludedFileSchema = z.strictObject({
  path: workspacePatchPath,
  diff_bytes_at_least: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  reason: z.literal("git-diff-overflow")
});
export const workspacePatchSchema = z.strictObject({
  schema_version: z.literal(WORKSPACE_PATCH_SCHEMA_VERSION),
  base_commit: gitObjectId,
  base_tree: gitObjectId,
  result_tree: gitObjectId,
  patch_sha256: sha256,
  files: z.array(workspacePatchFileSchema),
  source_snapshot: workspacePatchSourceSnapshotSchema,
  excluded_files: z.array(workspacePatchExcludedFileSchema).min(1).optional()
});

export type WorkspacePatchManifest = z.infer<typeof workspacePatchSchema>;

export function validateWorkspacePatchSchema(
  value: unknown,
  path = "$"
): SchemaValidationResult<WorkspacePatchManifest> {
  const shape = validateWithZod(workspacePatchSchema, value, {
    path,
    code: "WORKSPACE_PATCH_SCHEMA_INVALID"
  });
  if (!shape.ok || shape.value === undefined) return shape;
  const semantics = executeSemanticGate("workspace-patch-path-uniqueness", { document: shape.value });
  if (semantics.status !== "failed") return shape;
  return {
    ok: false,
    issues: semantics.issues.map((semanticIssue) => ({
      code: "WORKSPACE_PATCH_SCHEMA_INVALID",
      message: semanticIssue.message,
      path: prefixedSemanticPath(path, semanticIssue.path)
    }))
  };
}

function prefixedSemanticPath(rootPath: string, semanticPath: string): string {
  return semanticPath === "$" ? rootPath : `${rootPath}${semanticPath.slice(1)}`;
}

export const workspacePatchJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: WORKSPACE_PATCH_JSON_SCHEMA_ID,
  title: "Ultrafuzz workspace patch manifest",
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "base_commit", "base_tree", "result_tree", "patch_sha256", "source_snapshot", "files"],
  properties: {
    schema_version: { const: WORKSPACE_PATCH_SCHEMA_VERSION },
    base_commit: { type: "string", pattern: "^[0-9a-f]{40,64}$" },
    base_tree: { type: "string", pattern: "^[0-9a-f]{40,64}$" },
    result_tree: { type: "string", pattern: "^[0-9a-f]{40,64}$" },
    patch_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    source_snapshot: {
      type: "object",
      additionalProperties: false,
      required: ["status", "protected_roots"],
      properties: {
        status: { const: "preserved" },
        protected_roots: {
          type: "array",
          minItems: 1,
          items: { type: "string", pattern: "^[A-Za-z0-9._-]{1,128}(?:/[A-Za-z0-9._-]{1,128})*$" }
        }
      }
    },
    excluded_files: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "diff_bytes_at_least", "reason"],
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
          },
          diff_bytes_at_least: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          reason: { const: "git-diff-overflow" }
        }
      }
    },
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
    }
  }
} as const;
