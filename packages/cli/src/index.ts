#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { run as runOclif } from "@oclif/core";

import { CLI_SCHEMA_VERSION, commandFailure, envelope, type CliIo } from "./command-shared.js";

export async function runCli(argv = process.argv.slice(2), io: CliIo = defaultIo()): Promise<number> {
  const previousIo = globalThis.__ultrafuzzCliIo;
  const previousExitCode = process.exitCode;
  globalThis.__ultrafuzzCliIo = io;
  try {
    process.exitCode = undefined;
    await runOclif(argv, { root: packageRoot() });
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (error) {
    const code = exitCodeFor(error);
    const command = argv.find((entry) => !entry.startsWith("-")) ?? "help";
    const message = error instanceof Error ? error.message : String(error);
    if (argv.includes("--json")) {
      io.stdout.write(
        `${JSON.stringify(envelope(command, commandFailure(command, message, "CLI_OCLIF_ERROR")), null, 2)}\n`
      );
    } else {
      io.stderr.write(`${message}\n`);
    }
    return code;
  } finally {
    globalThis.__ultrafuzzCliIo = previousIo;
    process.exitCode = previousExitCode;
  }
}

function defaultIo(): CliIo {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr
  };
}

function exitCodeFor(error: unknown): number {
  const record =
    error && typeof error === "object" ? (error as { oclif?: { exit?: unknown }; exitCode?: unknown }) : {};
  const exit = record.oclif?.exit ?? record.exitCode;
  return typeof exit === "number" ? exit : 1;
}

function packageRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (current !== path.dirname(current)) {
    const packageJson = path.join(current, "package.json");
    if (fs.existsSync(packageJson)) {
      const parsed = JSON.parse(fs.readFileSync(packageJson, "utf8")) as { name?: string };
      if (parsed.name === "@ultrafuzz/cli") {
        return current;
      }
    }
    current = path.dirname(current);
  }
  throw new Error("unable to locate @ultrafuzz/cli package root");
}

export { CLI_SCHEMA_VERSION };
export type { CliIo };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}
