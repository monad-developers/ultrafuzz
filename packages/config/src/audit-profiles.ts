import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { z } from "zod/v4";

export const AUDIT_PROFILE_CATALOG_SCHEMA_VERSION = 2 as const;
export const DEFAULT_AUDIT_PROFILE_ID = "default" as const;

export type DynamicStrategiesEnumerator = number | "unlimited";

export interface AuditProfileSettings {
  strategy_loops?: number;
  dynamic_strategies_enumerator?: DynamicStrategiesEnumerator;
  max_parallel_agents?: number;
  max_parallel_nodes?: number;
  default_timeout_seconds?: number;
  workflow_deadline_seconds?: number;
  invariant_testing_smoke_timeout_seconds?: number;
  invariant_testing_fuzzer_timeout_seconds?: number;
  triage_quorum?: number;
  triage_panel_size?: number;
}

export interface AuditProfileDefinition {
  id: string;
  description: string;
  intendedUse: string;
  topologyPath?: string;
  settings: AuditProfileSettings;
}

export interface AuditProfileCatalog {
  schemaVersion: typeof AUDIT_PROFILE_CATALOG_SCHEMA_VERSION;
  defaultProfile: typeof DEFAULT_AUDIT_PROFILE_ID;
  digest: string;
  path: string;
  profiles: Record<string, AuditProfileDefinition>;
}

export interface PackagedTopologyDefinition {
  id: string;
  description: string;
  relativePath: string;
  path: string;
  digest: string;
}

const PACKAGED_TOPOLOGY_DESCRIPTIONS = {
  full: "The complete production audit graph copied to projects by ultrafuzz init.",
  smoke: "The bounded CI graph with context, four parallel strategies, dedupe, and reporting.",
  "invariant-only": "The focused property discovery, stateful-invariant campaign, review, and reporting graph."
} as const;

const safeIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u);
const positiveIntegerSchema = z.number().int().positive();
const dynamicStrategiesEnumeratorSchema = z.union([z.number().int().nonnegative(), z.literal("unlimited")]);
const packagedTopologyPathSchema = z
  .string()
  .regex(/^topologies\/[a-z0-9][a-z0-9-]*\.ya?ml$/u)
  .refine((value) => !value.split("/").some((segment) => segment === "" || segment === "." || segment === ".."));
const settingsSchema = z
  .strictObject({
    strategy_loops: positiveIntegerSchema.optional(),
    dynamic_strategies_enumerator: dynamicStrategiesEnumeratorSchema.optional(),
    max_parallel_agents: positiveIntegerSchema.optional(),
    max_parallel_nodes: positiveIntegerSchema.optional(),
    default_timeout_seconds: positiveIntegerSchema.max(86_400).optional(),
    workflow_deadline_seconds: positiveIntegerSchema.max(86_400).optional(),
    invariant_testing_smoke_timeout_seconds: positiveIntegerSchema.max(86_400).optional(),
    invariant_testing_fuzzer_timeout_seconds: positiveIntegerSchema.max(86_400).optional(),
    triage_quorum: positiveIntegerSchema.optional(),
    triage_panel_size: positiveIntegerSchema.optional()
  })
  .superRefine((settings, context) => {
    if (
      settings.triage_quorum !== undefined &&
      settings.triage_panel_size !== undefined &&
      settings.triage_quorum > settings.triage_panel_size
    ) {
      context.addIssue({
        code: "custom",
        path: ["triage_quorum"],
        message: "triage_quorum must be at most triage_panel_size"
      });
    }
  });
const profileSchema = z.strictObject({
  description: z.string().trim().min(1).max(512),
  intended_use: z.string().trim().min(1).max(512),
  topology_path: packagedTopologyPathSchema.optional(),
  settings: settingsSchema
});
const catalogSchema = z
  .strictObject({
    schema_version: z.literal(AUDIT_PROFILE_CATALOG_SCHEMA_VERSION),
    profiles: z.record(safeIdSchema, profileSchema)
  })
  .superRefine((catalog, context) => {
    if (catalog.profiles[DEFAULT_AUDIT_PROFILE_ID] === undefined) {
      context.addIssue({
        code: "custom",
        path: ["profiles", DEFAULT_AUDIT_PROFILE_ID],
        message: `required default audit profile \`${DEFAULT_AUDIT_PROFILE_ID}\` is not defined; define profiles.${DEFAULT_AUDIT_PROFILE_ID}`
      });
    }
  });

export function loadAuditProfileCatalog(catalogPath = defaultAuditProfileCatalogPath()): AuditProfileCatalog {
  const absoluteCatalogPath = path.resolve(catalogPath);
  assertRegularFileWithoutSymlinks(path.dirname(absoluteCatalogPath), absoluteCatalogPath, "audit profile catalog");
  const source = fs.readFileSync(absoluteCatalogPath, "utf8");
  let input: unknown;
  try {
    input = YAML.parse(source);
  } catch (error) {
    throw new Error(`audit profile catalog is not valid YAML: ${errorMessage(error)}`, { cause: error });
  }
  const parsed = catalogSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      `audit profile catalog is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "catalog"}: ${issue.message}`)
        .join("; ")}`
    );
  }
  const catalogRoot = path.dirname(absoluteCatalogPath);
  const profiles = Object.fromEntries(
    Object.entries(parsed.data.profiles)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, profile]) => {
        if (profile.topology_path !== undefined) {
          resolvePackagedTopologyPath(catalogRoot, profile.topology_path);
        }
        return [
          id,
          {
            id,
            description: profile.description,
            intendedUse: profile.intended_use,
            ...(profile.topology_path === undefined ? {} : { topologyPath: profile.topology_path }),
            settings: { ...profile.settings }
          }
        ];
      })
  );
  return {
    schemaVersion: parsed.data.schema_version,
    defaultProfile: DEFAULT_AUDIT_PROFILE_ID,
    digest: crypto.createHash("sha256").update(source).digest("hex"),
    path: absoluteCatalogPath,
    profiles
  };
}

export function auditProfile(
  id: string,
  catalog: AuditProfileCatalog = loadAuditProfileCatalog()
): AuditProfileDefinition {
  const profile = catalog.profiles[id];
  if (profile === undefined) {
    throw new Error(`unknown audit profile \`${id}\`; available profiles: ${Object.keys(catalog.profiles).join(", ")}`);
  }
  return profile;
}

export function packagedTopologyPath(
  profile: AuditProfileDefinition,
  catalog: AuditProfileCatalog = loadAuditProfileCatalog()
): string | undefined {
  return profile.topologyPath === undefined
    ? undefined
    : resolvePackagedTopologyPath(path.dirname(catalog.path), profile.topologyPath);
}

export function packagedTopologyDigest(
  profile: AuditProfileDefinition,
  catalog: AuditProfileCatalog = loadAuditProfileCatalog()
): string | undefined {
  const topologyPath = packagedTopologyPath(profile, catalog);
  return topologyPath === undefined
    ? undefined
    : crypto.createHash("sha256").update(fs.readFileSync(topologyPath)).digest("hex");
}

export function packagedTopologies(
  catalog: AuditProfileCatalog = loadAuditProfileCatalog()
): PackagedTopologyDefinition[] {
  return Object.entries(PACKAGED_TOPOLOGY_DESCRIPTIONS).map(([id, description]) =>
    packagedTopology(id, catalog, description)
  );
}

export function packagedTopology(
  id: string,
  catalog: AuditProfileCatalog = loadAuditProfileCatalog(),
  knownDescription?: string
): PackagedTopologyDefinition {
  const description =
    knownDescription ?? PACKAGED_TOPOLOGY_DESCRIPTIONS[id as keyof typeof PACKAGED_TOPOLOGY_DESCRIPTIONS];
  if (description === undefined) {
    throw new Error(
      `unknown packaged topology \`${id}\`; available topologies: ${Object.keys(PACKAGED_TOPOLOGY_DESCRIPTIONS).join(", ")}`
    );
  }
  const relativePath = `topologies/${id}.yml`;
  const topologyPath = resolvePackagedTopologyPath(path.dirname(catalog.path), relativePath);
  return {
    id,
    description,
    relativePath,
    path: topologyPath,
    digest: crypto.createHash("sha256").update(fs.readFileSync(topologyPath)).digest("hex")
  };
}

export function defaultAuditProfileCatalogPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "audit-profiles.yml"),
    path.resolve(here, "../audit-profiles.yml"),
    path.resolve(here, "../../../packages/config/audit-profiles.yml")
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found === undefined) {
    throw new Error(`unable to locate packaged audit-profiles.yml from ${here}`);
  }
  return found;
}

function resolvePackagedTopologyPath(catalogRoot: string, relativePath: string): string {
  const topologyRoot = path.join(catalogRoot, "topologies");
  const candidate = path.resolve(catalogRoot, relativePath);
  const relative = path.relative(topologyRoot, candidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`packaged topology path escapes the topology directory: ${relativePath}`);
  }
  assertRegularFileWithoutSymlinks(catalogRoot, candidate, `packaged topology ${relativePath}`);
  return candidate;
}

function assertRegularFileWithoutSymlinks(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its package root`);
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} contains a symlink component: ${current}`);
    }
  }
  if (!fs.statSync(candidate).isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
