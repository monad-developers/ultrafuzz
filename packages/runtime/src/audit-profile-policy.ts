import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { auditProfile, loadAuditProfileCatalog, packagedTopologyPath, type ResolvedConfig } from "@ultrafuzz/config";
import { loadTopology, resolveTopologyPath } from "@ultrafuzz/topology";

export type TopologyPathOrigin = "project-default" | "audit-profile" | "project-config" | "runtime-override";

export interface EffectiveAuditPolicy {
  auditProfile: string;
  catalogSchemaVersion: number;
  catalogDigest: string;
  profileSettings: Record<string, unknown>;
  effectiveSettings: Record<string, unknown>;
  settingOrigins: Record<string, string>;
  overriddenSettings: string[];
  declaredTopologyPath?: string;
  effectiveTopologyPath: string;
  effectiveTopologyDisplayPath: string;
  topologyPathOrigin: TopologyPathOrigin;
  topologyOverridden: boolean;
  topologyDigest: string;
  strategyLoops?: number;
}

export function effectiveAuditPolicy(input: {
  projectRoot: string;
  config: ResolvedConfig;
  runtimeTopologyPath?: string;
  runtimeStrategyLoops?: number;
}): EffectiveAuditPolicy {
  const projectRoot = path.resolve(input.projectRoot);
  const catalog = loadAuditProfileCatalog();
  const profile = auditProfile(input.config.auditProfile, catalog);
  const effectiveSettings = { ...input.config.auditProfileResolution.effectiveSettings };
  const settingOrigins = { ...input.config.auditProfileResolution.settingOrigins };
  const overriddenSettings = new Set(input.config.auditProfileResolution.overriddenSettings);
  if (input.runtimeStrategyLoops !== undefined) {
    effectiveSettings.strategy_loops = input.runtimeStrategyLoops;
    settingOrigins.strategy_loops = "runtime-override";
    if (profile.settings.strategy_loops !== undefined) overriddenSettings.add("strategy_loops");
  }

  const {
    path: effectiveTopologyPath,
    displayPath: effectiveTopologyDisplayPath,
    origin: topologyPathOrigin
  } = selectTopologyPath(projectRoot, input.config, input.runtimeTopologyPath, profileTopology(profile, catalog));

  if (input.runtimeStrategyLoops === undefined && input.config.strategyLoops === undefined) {
    const topology = loadTopology(projectRoot, { topologyPath: effectiveTopologyPath, requirePromptFiles: false });
    // Describe the selected editable topology without rewriting its loop policy.
    effectiveSettings.strategy_loops = topology.groups?.strategies?.defaults?.loops ?? topology.defaults.strategy_loops;
  }

  return {
    auditProfile: profile.id,
    catalogSchemaVersion: catalog.schemaVersion,
    catalogDigest: catalog.digest,
    profileSettings: { ...profile.settings },
    effectiveSettings,
    settingOrigins,
    overriddenSettings: [...overriddenSettings].sort(),
    ...(profile.topologyPath === undefined ? {} : { declaredTopologyPath: profile.topologyPath }),
    effectiveTopologyPath,
    effectiveTopologyDisplayPath,
    topologyPathOrigin,
    topologyOverridden: topologyPathOrigin === "project-config" || topologyPathOrigin === "runtime-override",
    topologyDigest: digestFile(effectiveTopologyPath),
    ...((input.runtimeStrategyLoops ?? input.config.strategyLoops) === undefined
      ? {}
      : { strategyLoops: input.runtimeStrategyLoops ?? input.config.strategyLoops })
  };
}

/**
 * The topology file a run plans from, as `effectiveAuditPolicy` selects it, without loading the
 * topology: `resume` rebuilds a run's plan from it.
 */
export function effectiveTopologyPath(input: {
  projectRoot: string;
  config: ResolvedConfig;
  runtimeTopologyPath?: string;
}): string {
  const catalog = loadAuditProfileCatalog();
  const profile = auditProfile(input.config.auditProfile, catalog);
  return selectTopologyPath(
    path.resolve(input.projectRoot),
    input.config,
    input.runtimeTopologyPath,
    profileTopology(profile, catalog)
  ).path;
}

function profileTopology(
  profile: ReturnType<typeof auditProfile>,
  catalog: ReturnType<typeof loadAuditProfileCatalog>
): { path: string; displayPath: string } | undefined {
  const topologyPath = packagedTopologyPath(profile, catalog);
  return topologyPath === undefined || profile.topologyPath === undefined
    ? undefined
    : { path: topologyPath, displayPath: profile.topologyPath };
}

function selectTopologyPath(
  projectRoot: string,
  config: ResolvedConfig,
  runtimeTopologyPath: string | undefined,
  packaged: { path: string; displayPath: string } | undefined
): { path: string; displayPath: string; origin: TopologyPathOrigin } {
  if (runtimeTopologyPath !== undefined) {
    const topologyPath = resolveProjectOrAbsolutePath(projectRoot, runtimeTopologyPath);
    return { path: topologyPath, displayPath: portablePath(projectRoot, topologyPath), origin: "runtime-override" };
  }
  if (config.topologyPath !== undefined) {
    return {
      path: resolveProjectOrAbsolutePath(projectRoot, config.topologyPath),
      displayPath: config.topologyPath,
      origin: "project-config"
    };
  }
  if (packaged !== undefined) return { ...packaged, origin: "audit-profile" };
  return { path: resolveTopologyPath(projectRoot), displayPath: ".ultrafuzz/topology.yml", origin: "project-default" };
}

function resolveProjectOrAbsolutePath(projectRoot: string, value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(projectRoot, value);
}

function portablePath(projectRoot: string, value: string): string {
  const relative = path.relative(projectRoot, value);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.split(path.sep).join("/")
    : value;
}

function digestFile(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}
