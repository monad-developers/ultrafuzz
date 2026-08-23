import path from "node:path";

import { Command, Flags } from "@oclif/core";
import { validateJsonFile } from "@ultrafuzz/artifacts";

import { cliSchemaRegistry } from "../../cli-schema-registry.js";
import { cliIo, emitCommandResult, globalFlags, type CommandResult } from "../../command-shared.js";

export default class JsonValidate extends Command {
  static override summary = "Validate one JSON file against a strict Draft 2020-12 JSON Schema";
  static override flags = {
    ...globalFlags,
    schema: Flags.string({ required: true, summary: "Draft 2020-12 JSON Schema file" }),
    file: Flags.string({ required: true, summary: "JSON artifact file" }),
    ref: Flags.string({ multiple: true, summary: "Additional local schema reference" }),
    "max-errors": Flags.integer({
      min: 1,
      max: 1_000,
      default: 50,
      summary: "Maximum number of schema violations to report"
    })
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(JsonValidate);
    const io = cliIo();
    const schemaPath = resolveFromCli(io.cwd, flags.schema);
    const registry = cliSchemaRegistry();
    const result = await validateJsonFile({
      schemaPath,
      filePath: resolveFromCli(io.cwd, flags.file),
      refPaths: (flags.ref ?? []).map((entry) => resolveFromCli(io.cwd, entry)),
      maxErrors: flags["max-errors"],
      schemaRegistry: registry.entries,
      schemaBundleSha256: registry.composedBundle,
      schemaBundleSha256BySchemaDigest: registry.bundleByDigest
    });
    if (result.status !== "valid") process.exitCode = result.status === "instance-error" ? 1 : 2;

    const commandResult: CommandResult = {
      ok: result.status === "valid",
      command: "json validate",
      data: result,
      text:
        result.status === "valid"
          ? `valid: ${flags.file} conforms to ${result.schema?.id ?? flags.schema}\n`
          : `${result.diagnostics.map(humanDiagnostic).join("\n")}\n`,
      diagnostics: result.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message,
        severity: "error" as const,
        source: "cli",
        ...(diagnostic.instancePath === undefined ? {} : { path: diagnostic.instancePath })
      }))
    };
    emitCommandResult(this, "json validate", commandResult, flags.json === true);
  }
}

function resolveFromCli(cwd: string, value: string): string {
  return path.resolve(cwd, value);
}

function humanDiagnostic(diagnostic: {
  code: string;
  message: string;
  instancePath?: string;
  schemaPath?: string;
  keyword?: string;
}): string {
  const location = [
    diagnostic.instancePath === undefined ? undefined : `instance ${diagnostic.instancePath || "/"}`,
    diagnostic.schemaPath === undefined ? undefined : `schema ${diagnostic.schemaPath}`,
    diagnostic.keyword === undefined ? undefined : `keyword ${diagnostic.keyword}`
  ]
    .filter((entry): entry is string => entry !== undefined)
    .join(", ");
  return `${diagnostic.code}${location.length === 0 ? "" : ` (${location})`}: ${diagnostic.message}`;
}
