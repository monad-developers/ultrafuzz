import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { auditProfile, loadAuditProfileCatalog, packagedTopologyPath, type ResolvedConfig } from "@ultrafuzz/config";
import { resolveTopologyPath } from "@ultrafuzz/topology";

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
  const profileTopologyPath = packagedTopologyPath(profile, catalog);
  const effectiveSettings = { ...input.config.auditProfileResolution.effectiveSettings };
  const settingOrigins = { ...input.config.auditProfileResolution.settingOrigins };
  const overriddenSettings = new Set(input.config.auditProfileResolution.overriddenSettings);
  if (input.runtimeStrategyLoops !== undefined) {
    effectiveSettings.strategy_loops = input.runtimeStrategyLoops;
    settingOrigins.strategy_loops = "runtime-override";
    if (profile.settings.strategy_loops !== undefined) overriddenSettings.add("strategy_loops");
  }

  let effectiveTopologyPath: string;
  let effectiveTopologyDisplayPath: string;
  let topologyPathOrigin: TopologyPathOrigin;
  if (input.runtimeTopologyPath !== undefined) {
    effectiveTopologyPath = resolveProjectOrAbsolutePath(projectRoot, input.runtimeTopologyPath);
    effectiveTopologyDisplayPath = portablePath(projectRoot, effectiveTopologyPath);
    topologyPathOrigin = "runtime-override";
  } else if (input.config.topologyPath !== undefined) {
    effectiveTopologyPath = resolveProjectOrAbsolutePath(projectRoot, input.config.topologyPath);
    effectiveTopologyDisplayPath = input.config.topologyPath;
    topologyPathOrigin = "project-config";
  } else if (profileTopologyPath !== undefined) {
    effectiveTopologyPath = profileTopologyPath;
    effectiveTopologyDisplayPath = profile.topologyPath!;
    topologyPathOrigin = "audit-profile";
  } else {
    effectiveTopologyPath = resolveTopologyPath(projectRoot);
    effectiveTopologyDisplayPath = ".ultrafuzz/topology.yml";
    topologyPathOrigin = "project-default";
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
