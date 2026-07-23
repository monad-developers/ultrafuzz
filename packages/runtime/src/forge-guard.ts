import fs from "node:fs";
import path from "node:path";

import { assertNoSymlinkComponents, ensureSafeDirectory, writeFileDurable, type RunLayout } from "@ultrafuzz/artifacts";
import type { ResolvedConfig } from "@ultrafuzz/config";

const REAL_FORGE_ENV = "ULTRAFUZZ_REAL_FORGE";
const FORGE_VMEM_LIMIT_ENV = "ULTRAFUZZ_FORGE_VMEM_LIMIT_KB";
const FORGE_RAYON_THREADS_ENV = "ULTRAFUZZ_FORGE_RAYON_THREADS";
const FORGE_GUARD_ENVIRONMENT_VARIABLES = [REAL_FORGE_ENV, FORGE_VMEM_LIMIT_ENV, FORGE_RAYON_THREADS_ENV] as const;

export interface ForgeGuardEnvironment {
  env: Record<string, string | undefined>;
  environmentVariableNames: readonly string[];
  active: boolean;
}

export function prepareForgeGuardEnvironment(input: {
  layout: RunLayout;
  config: ResolvedConfig;
  env?: Record<string, string | undefined>;
}): ForgeGuardEnvironment {
  const env = { ...(input.env ?? {}) };
  if (!input.config.run.forgeGuardEnabled) {
    return { env, environmentVariableNames: [], active: false };
  }

  const safeBin = path.join(input.layout.root, "safe-bin");
  const sourcePath = env.PATH ?? process.env.PATH ?? "";
  const realForge = resolveExecutableOnPath("forge", sourcePath, safeBin);
  if (realForge === undefined) {
    return { env, environmentVariableNames: [], active: false };
  }

  const safeBinRoot = ensureSafeDirectory(input.layout.root, "safe-bin");
  const wrapperPath = path.join(safeBinRoot, "forge");
  assertNoSymlinkComponents(input.layout.root, wrapperPath, "Forge guard wrapper");
  writeFileDurable(wrapperPath, forgeGuardWrapper());
  fs.chmodSync(wrapperPath, 0o700);

  return {
    env: {
      ...env,
      PATH: [safeBinRoot, sourcePath].filter((entry) => entry.length > 0).join(path.delimiter),
      [REAL_FORGE_ENV]: realForge,
      [FORGE_VMEM_LIMIT_ENV]: String(input.config.run.forgeVmemLimitKb),
      [FORGE_RAYON_THREADS_ENV]: String(input.config.run.forgeRayonThreads)
    },
    environmentVariableNames: FORGE_GUARD_ENVIRONMENT_VARIABLES,
    active: true
  };
}

export function forgeGuardMetadata(config: ResolvedConfig, active: boolean): Record<string, unknown> {
  return {
    enabled: config.run.forgeGuardEnabled,
    active,
    virtual_memory_limit_kb: config.run.forgeVmemLimitKb,
    rayon_threads: config.run.forgeRayonThreads
  };
}

function resolveExecutableOnPath(name: string, pathValue: string, excludedDirectory: string): string | undefined {
  for (const entry of pathValue.split(path.delimiter)) {
    const directory = path.resolve(entry.length > 0 ? entry : process.cwd());
    if (directory === path.resolve(excludedDirectory)) {
      continue;
    }
    const candidate = path.join(directory, name);
    try {
      if (!fs.statSync(candidate).isFile()) {
        continue;
      }
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Keep searching PATH entries that do not resolve to an executable file.
    }
  }
  return undefined;
}

function forgeGuardWrapper(): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `ulimit -v "\${${FORGE_VMEM_LIMIT_ENV}:?}"`,
    `export RAYON_NUM_THREADS="\${RAYON_NUM_THREADS:-\${${FORGE_RAYON_THREADS_ENV}:?}}"`,
    `exec "\${${REAL_FORGE_ENV}:?}" "$@"`,
    ""
  ].join("\n");
}
