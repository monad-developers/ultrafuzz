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

export interface ForgeGuardMetadata {
  enabled: boolean;
  active: boolean;
  virtual_memory_limit_kb: number;
  rayon_threads: number;
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

export function forgeGuardMetadata(config: ResolvedConfig, active: boolean): ForgeGuardMetadata {
  return {
    enabled: config.run.forgeGuardEnabled,
    active,
    virtual_memory_limit_kb: config.run.forgeVmemLimitKb,
    rayon_threads: config.run.forgeRayonThreads
  };
}

// Only the exact run-owned Forge wrapper may re-enter the controller PATH after
// target-local command directories are removed.
// prettier-ignore
export function isPreparedForgeGuardBin(projectRoot: string, candidate: string): boolean { try { const target = fs.realpathSync(path.resolve(projectRoot)), lexical = path.resolve(candidate), canonical = fs.realpathSync(lexical), relative = path.relative(path.join(target, ".ultrafuzz", "runs"), canonical), components = relative.split(path.sep), directory = fs.lstatSync(lexical), names = fs.readdirSync(canonical), wrapper = path.join(canonical, "forge"), stat = fs.lstatSync(wrapper); return lexical === canonical && components.length === 2 && components[0] !== "" && components[0] !== "." && components[0] !== ".." && components[1] === "safe-bin" && directory.isDirectory() && !directory.isSymbolicLink() && (directory.mode & 0o022) === 0 && names.length === 1 && names[0] === "forge" && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o777) === 0o700 && fs.readFileSync(wrapper, "utf8") === forgeGuardWrapper(); } catch { return false; } }

function resolveExecutableOnPath(name: string, pathValue: string, excludedDirectory: string): string | undefined {
  const resolvedExcludedDirectory = comparablePath(excludedDirectory);
  for (const entry of pathValue.split(path.delimiter)) {
    const directory = path.resolve(entry.length > 0 ? entry : process.cwd());
    if (comparablePath(directory) === resolvedExcludedDirectory) {
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

function comparablePath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function forgeGuardWrapper(): string {
  return [
    "#!/bin/sh",
    "set -eu",
    `ulimit -v "\${${FORGE_VMEM_LIMIT_ENV}:?}"`,
    `export RAYON_NUM_THREADS="\${RAYON_NUM_THREADS:-\${${FORGE_RAYON_THREADS_ENV}:?}}"`,
    `exec "\${${REAL_FORGE_ENV}:?}" "$@"`,
    ""
  ].join("\n");
}
