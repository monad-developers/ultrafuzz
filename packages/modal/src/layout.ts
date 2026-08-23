import path from "node:path";
import { createHash } from "node:crypto";

import type { ModelProvider } from "./defaults.js";

export const REMOTE_CONFIG_PATH = "/run/ultrafuzz-config/benchmark.json";
export const REMOTE_CONFIG_DIR = path.posix.dirname(REMOTE_CONFIG_PATH);
export const REMOTE_LINEAGE_PATH = path.posix.join(REMOTE_CONFIG_DIR, "lineage.json");
export const REMOTE_LAUNCH_READY_PATH = path.posix.join(REMOTE_CONFIG_DIR, "launch-ready");

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
  if (provider === "openai") return "/run/ultrafuzz-auth/codex";
  if (provider === "anthropic") return "/run/ultrafuzz-auth/claude";
  if (provider === "deepseek") return "/run/ultrafuzz-auth/deepseek";
  if (provider === "openrouter") return "/run/ultrafuzz-auth/openrouter";
  return "/run/ultrafuzz-auth/kimi";
}

export function remoteAuthPath(provider: ModelProvider): string {
  if (provider === "openai") return path.posix.join(remoteAuthDir(provider), "auth.json");
  if (provider === "anthropic") return path.posix.join(remoteAuthDir(provider), ".credentials.json");
  if (provider === "deepseek") return path.posix.join(remoteAuthDir(provider), "api-key");
  if (provider === "openrouter") return path.posix.join(remoteAuthDir(provider), "api-key");
  return path.posix.join(remoteAuthDir(provider), "config.toml");
}
