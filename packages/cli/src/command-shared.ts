import path from "node:path";

import { Flags, type Command } from "@oclif/core";
import type { RuntimeDiagnostic, RuntimeResult } from "@ultrafuzz/runtime";

export const CLI_SCHEMA_VERSION = "ultrafuzz.cli.result.v1" as const;

export interface CliIo {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface CommandResult {
  ok: boolean;
  command: string;
  data?: unknown;
  text?: string;
  diagnostics: RuntimeDiagnostic[];
}

declare global {
  var __ultrafuzzCliIo: CliIo | undefined;
}

export const globalFlags = {
  project: Flags.string({
    summary: "Project root"
  }),
  json: Flags.boolean({
    summary: "Emit schema-versioned JSON"
  })
};

export function cliIo(): CliIo {
  return (
    globalThis.__ultrafuzzCliIo ?? {
      cwd: process.cwd(),
      env: process.env,
      stdout: process.stdout,
      stderr: process.stderr
    }
  );
}

export function projectRoot(flags: { project?: string }): string {
  return path.resolve(flags.project ?? cliIo().cwd);
}

export function commandFromRuntime<T>(
  command: string,
  result: RuntimeResult<T>,
  text: (value: T) => string
): CommandResult {
  return {
    ok: result.ok,
    command,
    data: result.value,
    text: result.value ? text(result.value) : diagnosticsText(result.diagnostics),
    diagnostics: result.diagnostics
  };
}

export function commandFailure(
  command: string,
  message: string,
  code = "CLI_ERROR",
  pathValue?: string
): CommandResult {
  return {
    ok: false,
    command,
    text: `${message}\n`,
    diagnostics: [
      {
        code,
        message,
        severity: "error",
        source: "cli",
        ...(pathValue ? { path: pathValue } : {})
      }
    ]
  };
}

export function emitCommandResult(command: Command, commandName: string, result: CommandResult, json: boolean): void {
  const io = cliIo();
  if (!result.ok) {
    process.exitCode = process.exitCode ?? 1;
  }
  if (json) {
    io.stdout.write(`${JSON.stringify(envelope(commandName, result), null, 2)}\n`);
    return;
  }
  const output = result.text ?? "";
  if (result.ok) {
    io.stdout.write(output);
  } else {
    io.stderr.write(output);
  }
  void command;
}

export function diagnosticsText(diagnostics: RuntimeDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return "";
  }
  return `${diagnostics.map((diagnostic) => `${diagnostic.severity}: ${diagnostic.code}: ${diagnostic.message}`).join("\n")}\n`;
}

export function envelope(command: string, result: CommandResult): Record<string, unknown> {
  return {
    schema_version: CLI_SCHEMA_VERSION,
    command,
    ok: result.ok,
    diagnostics: result.diagnostics,
    data: result.data ?? null
  };
}
