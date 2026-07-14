import path from "node:path";

import type { ModelProvider } from "./defaults.js";

export const REMOTE_CONFIG_PATH = "/run/ultrafuzz-config/benchmark.json";
export const REMOTE_CONFIG_DIR = path.posix.dirname(REMOTE_CONFIG_PATH);

export function persistentDataRoot(runId: string, slug: string): string {
  return path.posix.join("/data", runId, slug);
}

export function persistentWorkspaceRoot(runId: string, slug: string): string {
  return path.posix.join(persistentDataRoot(runId, slug), "workspace");
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
