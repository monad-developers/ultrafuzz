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
    return Promise.all(
      uniqueCommands.map(async (name) => {
        const resolved = resolveExecutable(name, env, options.cwd);
        return {
          name,
          ...resolved,
          version:
            resolved.path === null || options.includeVersions !== true
              ? null
              : await executableVersion(resolved.path, env, options.cwd)
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
  env: Record<string, string | undefined>,
  cwd = process.cwd()
): { available: boolean; path: string | null } {
  const searchPath = env.PATH ?? process.env.PATH ?? "";
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
    // Shell PATH lookup treats an empty entry as the command's working
    // directory. Resolve relative entries against the target execution cwd,
    // not the controller process that happened to launch Ultrafuzz.
    const directory = entry.length === 0 ? cwd : path.resolve(cwd, entry);
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
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
