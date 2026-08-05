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
      [".git", ".ultrafuzz", ".smithers", "node_modules"].includes(segment) ||
      segment === ".env" ||
      segment.startsWith(".env.") ||
      segment === ".envrc" ||
      segment === ".npmrc"
    );
  });
}

export const workspacePatchFileSchema = z.strictObject({ path: workspacePatchPath });
export const workspacePatchSchema = z
  .strictObject({
    schema_version: z.literal(WORKSPACE_PATCH_SCHEMA_VERSION),
    base_commit: gitObjectId,
    base_tree: gitObjectId,
    result_tree: gitObjectId,
    patch_sha256: sha256,
    files: z.array(workspacePatchFileSchema)
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
              { not: { pattern: "(^|/)(?:\\.git|\\.ultrafuzz|\\.smithers|node_modules)(?:/|$)" } },
              { not: { pattern: "(^|/)\\.env(?:\\.|/|$)" } },
              { not: { pattern: "(^|/)(?:\\.envrc|\\.npmrc)(?:/|$)" } }
            ]
          }
        }
      }
    }
  }
} as const;
