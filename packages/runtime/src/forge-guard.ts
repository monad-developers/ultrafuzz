import fs from "node:fs";
import path from "node:path";

import { assertNoSymlinkComponents, ensureSafeDirectory, writeFileDurable, type RunLayout } from "@ultrafuzz/artifacts";
import type { ResolvedConfig } from "@ultrafuzz/config";

import type { RuntimeDiagnostic } from "./types.js";

const REAL_FORGE_ENV = "ULTRAFUZZ_REAL_FORGE";
const FORGE_VMEM_LIMIT_ENV = "ULTRAFUZZ_FORGE_VMEM_LIMIT_KB";
const FORGE_RAYON_THREADS_ENV = "ULTRAFUZZ_FORGE_RAYON_THREADS";
const FORGE_GUARD_ENVIRONMENT_VARIABLES = [REAL_FORGE_ENV, FORGE_VMEM_LIMIT_ENV, FORGE_RAYON_THREADS_ENV] as const;

export interface ForgeGuardEnvironment {
  env: Record<string, string | undefined>;
  environmentVariableNames: readonly string[];
  /** True only when the workflow engine's PATH keeps the wrapper; run.json records this value. */
  active: boolean;
  /** A warning when the guard is enabled and Forge is installed, but tasks run Forge without it. */
  diagnostics: RuntimeDiagnostic[];
}

export interface ForgeGuardMetadata {
  enabled: boolean;
  active: boolean;
  virtual_memory_limit_kb: number;
  rayon_threads: number;
}

export function prepareForgeGuardEnvironment(input: {
  layout: RunLayout;
  /** The target the workflow engine's PATH is composed for (composeSmithersCommandPath). */
  projectRoot: string;
  config: ResolvedConfig;
  env?: Record<string, string | undefined>;
}): ForgeGuardEnvironment {
  const env = { ...(input.env ?? {}) };
  if (!input.config.run.forgeGuardEnabled) {
    return { env, environmentVariableNames: [], active: false, diagnostics: [] };
  }

  const safeBin = path.join(input.layout.root, "safe-bin");
  const sourcePath = env.PATH ?? process.env.PATH ?? "";
  const realForge = resolveExecutableOnPath("forge", sourcePath, safeBin);
  if (realForge === undefined) {
    return { env, environmentVariableNames: [], active: false, diagnostics: [] };
  }

  const safeBinRoot = ensureSafeDirectory(input.layout.root, "safe-bin");
  // mkdir applies the umask, and under a group-writable one such as Ubuntu's
  // default 0002 the directory fails the engine PATH admission below. chmod
  // does not apply it, and also repairs a directory an earlier launch created.
  fs.chmodSync(safeBinRoot, 0o700);
  // The admission also wants the wrapper alone in the directory. Anything else
  // there, such as the temporary file of an interrupted write, would drop the
  // guard for every later command of the run, so remove it.
  for (const name of fs.readdirSync(safeBinRoot)) {
    if (name === "forge") continue;
    try {
      fs.rmSync(path.join(safeBinRoot, name), { recursive: true, force: true });
    } catch {
      // An entry that stays fails the admission below, which reports it.
    }
  }
  const wrapperPath = path.join(safeBinRoot, "forge");
  assertNoSymlinkComponents(input.layout.root, wrapperPath, "Forge guard wrapper");
  // Created executable: resume and replay replace the wrapper while tasks may
  // be running, and a PATH lookup that met it without its execute bit would
  // run the real Forge.
  writeFileDurable(wrapperPath, forgeGuardWrapper(), { mode: 0o700 });
  fs.chmodSync(wrapperPath, 0o700);
  // The engine PATH drops every target-local entry that fails this check, so a
  // wrapper that fails it would never run: report the guard inactive rather
  // than let run.json claim limits that tasks do not get.
  if (!isPreparedForgeGuardBin(input.projectRoot, safeBinRoot)) {
    return {
      env,
      environmentVariableNames: [],
      active: false,
      diagnostics: [
        {
          code: "FORGE_GUARD_INACTIVE",
          message: `run.forge_guard_enabled is set, but the workflow engine does not admit ${safeBinRoot} to PATH (it admits only <project>/.ultrafuzz/runs/<run-id>/safe-bin on a path without symbolic links, holding just the wrapper and not writable by group or others), so tasks run ${realForge} without the configured memory and thread limits`,
          severity: "warning",
          source: "runtime",
          path: "run.forge_guard_enabled"
        }
      ]
    };
  }

  return {
    env: {
      ...env,
      PATH: [safeBinRoot, sourcePath].filter((entry) => entry.length > 0).join(path.delimiter),
      [REAL_FORGE_ENV]: realForge,
      [FORGE_VMEM_LIMIT_ENV]: String(input.config.run.forgeVmemLimitKb),
      [FORGE_RAYON_THREADS_ENV]: String(input.config.run.forgeRayonThreads)
    },
    environmentVariableNames: FORGE_GUARD_ENVIRONMENT_VARIABLES,
    active: true,
    diagnostics: []
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
export function isPreparedForgeGuardBin(projectRoot: string, candidate: string): boolean {
  try {
    const target = fs.realpathSync(path.resolve(projectRoot)),
      lexical = path.resolve(candidate),
      canonical = fs.realpathSync(lexical),
      relative = path.relative(path.join(target, ".ultrafuzz", "runs"), canonical),
      components = relative.split(path.sep),
      directory = fs.lstatSync(lexical),
      names = fs.readdirSync(canonical),
      wrapper = path.join(canonical, "forge"),
      stat = fs.lstatSync(wrapper);
    return (
      lexical === canonical &&
      components.length === 2 &&
      components[0] !== "" &&
      components[0] !== "." &&
      components[0] !== ".." &&
      components[1] === "safe-bin" &&
      directory.isDirectory() &&
      !directory.isSymbolicLink() &&
      (directory.mode & 0o022) === 0 &&
      names.length === 1 &&
      names[0] === "forge" &&
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      (stat.mode & 0o777) === 0o700 &&
      fs.readFileSync(wrapper, "utf8") === forgeGuardWrapper()
    );
  } catch {
    return false;
  }
}

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
