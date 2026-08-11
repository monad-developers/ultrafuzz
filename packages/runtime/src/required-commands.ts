import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type { ResolvedConfig } from "@ultrafuzz/config";

const execFileAsync = promisify(execFile);
const VERSION_PROBE_TIMEOUT_MS = 5_000;

export interface RequiredCommandProbe {
  name: string;
  available: boolean;
  path: string | null;
  version: string | null;
}

export async function probeCommandsForExecution(
  config: ResolvedConfig,
  commands: readonly string[],
  env: Record<string, string | undefined>,
  options: { includeVersions?: boolean; cwd?: string; createProviderAppIfMissing?: boolean } = {}
): Promise<RequiredCommandProbe[]> {
  const uniqueCommands = [...new Set(commands)].sort();
  if (uniqueCommands.length === 0) return [];
  if (config.execution.mode === "local") {
    const cwd = options.cwd ?? process.cwd();
    const sourcePath = Object.hasOwn(env, "PATH") ? env.PATH : process.env.PATH;
    // Smithers prepends this directory to the PATH inherited by local tasks.
    // Reproduce that effective lookup path during preflight. Relative and empty
    // source entries are intentionally ignored by resolveExecutable because
    // tasks execute in fresh worktrees, not the mutable controller checkout.
    const effectiveEnv = {
      ...env,
      PATH: [path.join(cwd, ".smithers", "node_modules", ".bin"), sourcePath]
        .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
        .join(path.delimiter)
    };
    return Promise.all(
      uniqueCommands.map(async (name) => {
        const resolved = resolveExecutable(name, effectiveEnv);
        return {
          name,
          ...resolved,
          version:
            resolved.path === null || options.includeVersions !== true
              ? null
              : await executableVersion(resolved.path, effectiveEnv, cwd)
        };
      })
    );
  }

  const modal = config.execution.providers.modal;
  if (config.execution.provider !== "modal" || modal === undefined) {
    throw new Error("cloud command preflight requires a configured execution provider");
  }
  const moduleName = "@ultrafuzz/modal";
  const provider = (await import(moduleName)) as {
    probeModalCommands(
      providerOptions: {
        app: string;
        image: string;
        region?: string;
        credentialEnv: readonly string[];
        env?: Record<string, string | undefined>;
      },
      requiredCommands: readonly string[],
      probeOptions?: { includeVersions?: boolean; createAppIfMissing?: boolean }
    ): Promise<RequiredCommandProbe[]>;
  };
  return provider.probeModalCommands(
    {
      app: modal.app,
      image: modal.image,
      ...(modal.region === undefined ? {} : { region: modal.region }),
      credentialEnv: modal.credentialEnv,
      env
    },
    uniqueCommands,
    {
      includeVersions: options.includeVersions,
      createAppIfMissing: options.createProviderAppIfMissing
    }
  );
}

export function resolveExecutable(
  name: string,
  env: Record<string, string | undefined>
): { available: boolean; path: string | null } {
  const searchPath = Object.hasOwn(env, "PATH") ? (env.PATH ?? "") : (process.env.PATH ?? "");
  // Windows resolves a bare command name through PATHEXT and does not mark
  // executables with an exec bit, so requiring X_OK there reports every tool
  // missing.
  const windows = process.platform === "win32";
  const extensions = windows
    ? [
        "",
        ...(env.PATHEXT ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      ]
    : [""];
  for (const entry of searchPath.split(path.delimiter)) {
    // Local tasks run in fresh worktrees. A relative or empty entry resolved
    // from the controller checkout can therefore prove the wrong executable
    // and allow model work to start without its required backend.
    if (!path.isAbsolute(entry)) continue;
    for (const extension of extensions) {
      const candidate = path.join(entry, `${name}${extension}`);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (!windows) fs.accessSync(candidate, fs.constants.X_OK);
        return { available: true, path: candidate };
      } catch {
        continue;
      }
    }
  }
  return { available: false, path: null };
}

async function executableVersion(
  executable: string,
  env: Record<string, string | undefined>,
  cwd = process.cwd()
): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(executable, ["--version"], {
      env: { ...process.env, ...env },
      cwd,
      timeout: VERSION_PROBE_TIMEOUT_MS
    });
    const version = `${stdout}\n${stderr}`
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return version?.slice(0, 512) ?? null;
  } catch {
    return null;
  }
}
