#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { run as runOclif } from "@oclif/core";
import { parseStrictJsonBytes, readRegularFileSnapshot } from "@ultrafuzz/artifacts";

import { CLI_KNOWN_COMMANDS } from "./cli-contracts.js";
import { CLI_SCHEMA_VERSION, commandFailure, envelope, type CliIo } from "./command-shared.js";

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

export async function runCli(argv = process.argv.slice(2), io: CliIo = defaultIo()): Promise<number> {
  const previousIo = globalThis.__ultrafuzzCliIo;
  const previousExitCode = process.exitCode;
  globalThis.__ultrafuzzCliIo = io;
  try {
    process.exitCode = undefined;
    await runOclif(argv, { root: packageRoot() });
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (error) {
    const command = invokedCommand(argv);
    const code = exitCodeFor(error, command);
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

function exitCodeFor(error: unknown, command: string): number {
  if (command === "json validate") return 2;
  const record =
    error && typeof error === "object" ? (error as { oclif?: { exit?: unknown }; exitCode?: unknown }) : {};
  const exit = record.oclif?.exit ?? record.exitCode;
  return typeof exit === "number" ? exit : 1;
}

function invokedCommand(argv: readonly string[]): string {
  const known = [...CLI_KNOWN_COMMANDS]
    .sort((left, right) => right.split(" ").length - left.split(" ").length)
    .find((candidate) => candidate.split(" ").every((part, index) => argv[index] === part));
  return known ?? argv.find((entry) => !entry.startsWith("-")) ?? "help";
}

function packageRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (current !== path.dirname(current)) {
    const packageJson = path.join(current, "package.json");
    if (fs.existsSync(packageJson)) {
      const parsed = parseStrictJsonBytes(readRegularFileSnapshot(packageJson, MAX_PACKAGE_JSON_BYTES), {
        maxBytes: MAX_PACKAGE_JSON_BYTES,
        maxDepth: 32,
        maxItems: 10_000,
        maxProperties: 10_000
      });
      if (isRecord(parsed) && parsed.name === "@ultrafuzz/cli") {
        return current;
      }
    }
    current = path.dirname(current);
  }
  throw new Error("unable to locate @ultrafuzz/cli package root");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { CLI_SCHEMA_VERSION };
export type { CliIo };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}
