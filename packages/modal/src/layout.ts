import path from "node:path";
import { createHash } from "node:crypto";

import type { ModelProvider } from "./defaults.js";

export const REMOTE_CONFIG_PATH = "/run/ultrafuzz-config/benchmark.json";
export const REMOTE_CONFIG_DIR = path.posix.dirname(REMOTE_CONFIG_PATH);
export const REMOTE_LINEAGE_PATH = path.posix.join(REMOTE_CONFIG_DIR, "lineage.json");

export const PERSISTED_LINEAGE_FILE = "lineage.json";

export function persistentDataRoot(runId: string, slug: string): string {
  return path.posix.join("/data", runId, slug);
}

export function persistentWorkspaceRoot(runId: string, slug: string): string {
  return path.posix.join(persistentDataRoot(runId, slug), "workspace");
}

export function modalVolumeName(runId: string, slug: string): string {
  const identity = `${runId}\0${slug}`;
  const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  const prefix = `ultrafuzz-${runId}-${slug}`.slice(0, 63 - suffix.length - 1).replace(/[-.]+$/u, "");
  return `${prefix}-${suffix}`;
}

export function resolvePersistentRemoteRoot(remoteRoot: string, resolvedMountRoot: string): string {
  const relative = path.posix.relative("/data", remoteRoot);
  if (relative === "" || relative === "." || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
    throw new Error(`persistent remote root must be a child of /data: ${remoteRoot}`);
  }
  return path.posix.join(resolvedMountRoot, relative);
}

export function remoteAuthDir(provider: ModelProvider): string {
  return provider === "openai" ? "/run/ultrafuzz-auth/codex" : "/run/ultrafuzz-auth/claude";
}

export function remoteAuthPath(provider: ModelProvider): string {
  return path.posix.join(remoteAuthDir(provider), provider === "openai" ? "auth.json" : ".credentials.json");
}
