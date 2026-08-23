import path from "node:path";
import { fileURLToPath } from "node:url";

import { Flags, type Command } from "@oclif/core";
import { loadProjectConfig, resolveConfig, type EvalConfig } from "@ultrafuzz/config";
import type { RuntimeDiagnostic, RuntimeResult } from "@ultrafuzz/runtime";

import {
  CLI_SCHEMA_VERSION,
  publicDiagnostic,
  type CliCommandData,
  type CliCommandDataMap,
  type CliDiagnostic,
  type CliKnownCommand,
  type CliResultEnvelope
} from "./cli-contracts.js";
import { validateCliResultEnvelope } from "./cli-schema-registry.js";

export { CLI_SCHEMA_VERSION };

export interface CliIo {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface CommandResult {
  ok: boolean;
  command: string;
  data: CliCommandData | null;
  text?: string;
  diagnostics: CliDiagnostic[];
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

export function cliEntrypoint(): string {
  return fileURLToPath(new URL("./index.js", import.meta.url));
}

/**
 * Resolve the `[eval]` section of ultrafuzz.toml for the eval commands.
 * Provider binding + credentials env-var names live here; the committable
 * experiment definition lives in the eval suite YAML.
 */
export async function loadEvalConfig(
  root: string,
  env: Record<string, string | undefined>
): Promise<{ evalConfig: EvalConfig; diagnostics: RuntimeDiagnostic[] }> {
  const loaded = await loadProjectConfig(root);
  const diagnostics: RuntimeDiagnostic[] = [];
  const projectConfig = loaded.ok ? loaded.value.config : {};
  if (!loaded.ok) {
    for (const diagnostic of loaded.diagnostics) {
      diagnostics.push({
        code: diagnostic.code,
        message: diagnostic.message,
        severity: diagnostic.severity,
        source: "config"
      });
    }
  }
  const resolved = resolveConfig({ projectConfig, env });
  if (!resolved.ok) {
    const summary = resolved.diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join("; ");
    throw new Error(`ultrafuzz.toml failed to resolve: ${summary}`);
  }
  return { evalConfig: resolved.value.eval, diagnostics };
}

export function commandFromRuntime<CommandName extends CliKnownCommand, Source extends CliCommandDataMap[CommandName]>(
  command: CommandName,
  result: RuntimeResult<Source>,
  text: (value: Source) => string
): CommandResult;
export function commandFromRuntime<CommandName extends CliKnownCommand, Source>(
  command: CommandName,
  result: RuntimeResult<Source>,
  text: (value: Source) => string,
  project: (value: Source) => CliCommandDataMap[CommandName]
): CommandResult;
export function commandFromRuntime<CommandName extends CliKnownCommand, Source>(
  command: CommandName,
  result: RuntimeResult<Source>,
  text: (value: Source) => string,
  project?: (value: Source) => CliCommandDataMap[CommandName]
): CommandResult {
  return {
    ok: result.ok,
    command,
    data:
      result.value === undefined
        ? null
        : project === undefined
          ? (result.value as CliCommandDataMap[CommandName])
          : project(result.value),
    text: result.value
      ? `${result.ok ? "" : diagnosticsText(result.diagnostics)}${text(result.value)}`
      : diagnosticsText(result.diagnostics),
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
    data: null,
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

/**
 * Emits a failure that interrupts a `--watch` stream. In JSON mode the envelope
 * must stay on one line so a line-wise consumer can still parse the error it
 * was waiting for.
 */
export function emitWatchFailure(commandName: string, result: CommandResult, json: boolean): void {
  const io = cliIo();
  process.exitCode = process.exitCode ?? 1;
  if (json) {
    io.stdout.write(`${JSON.stringify(envelope(commandName, result))}\n`);
    return;
  }
  io.stderr.write(result.text ?? "");
}

export function diagnosticsText(diagnostics: RuntimeDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return "";
  }
  return `${diagnostics.map((diagnostic) => `${diagnostic.severity}: ${diagnostic.code}: ${diagnostic.message}`).join("\n")}\n`;
}

export function envelope(command: string, result: CommandResult): CliResultEnvelope {
  if (command !== result.command) {
    throw new Error(`CLI result command mismatch: expected ${command}, received ${result.command}`);
  }
  const value = {
    schema_version: CLI_SCHEMA_VERSION,
    command,
    ok: result.ok,
    diagnostics: result.diagnostics.map(publicDiagnostic),
    data: result.data
  };
  const validation = validateCliResultEnvelope(value);
  if (!validation.ok) {
    const summary = validation.issues
      .slice(0, 10)
      .map((issue) => `${issue.instancePath || "/"} ${issue.keyword}: ${issue.message}`)
      .join("; ");
    throw new Error(`CLI producer result does not match ${CLI_SCHEMA_VERSION}: ${summary}`);
  }
  return value as CliResultEnvelope;
}
