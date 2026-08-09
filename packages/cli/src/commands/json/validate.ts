import path from "node:path";

import { Command, Flags } from "@oclif/core";
import {
  artifactSchemaBundleDigest,
  artifactSchemaRegistry,
  schemaRegistryBundleDigest,
  validateJsonFile,
  type SchemaRegistryEntry
} from "@ultrafuzz/artifacts";
import { evalSchemaBundleDigest, evalSchemaRegistry } from "@ultrafuzz/evals";
import { modalSchemaBundleDigest, modalSchemaRegistry } from "@ultrafuzz/modal";
import { topologySchemaBundleDigest, topologySchemaRegistry } from "@ultrafuzz/topology";

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
      schemaBundleSha256: registry.bundleByFilename.get(path.basename(schemaPath)) ?? registry.composedBundle
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

function cliSchemaRegistry(): {
  entries: readonly SchemaRegistryEntry[];
  bundleByFilename: ReadonlyMap<string, string>;
  composedBundle: string;
} {
  const owners = [
    { entries: artifactSchemaRegistry(), bundle: artifactSchemaBundleDigest() },
    { entries: evalSchemaRegistry(), bundle: evalSchemaBundleDigest() },
    { entries: modalSchemaRegistry(), bundle: modalSchemaBundleDigest() },
    { entries: topologySchemaRegistry(), bundle: topologySchemaBundleDigest() }
  ];
  const entries = owners.flatMap((owner) => [...owner.entries]);
  const bundleByFilename = new Map<string, string>();
  const ids = new Set<string>();
  const digests = new Set<string>();
  for (const owner of owners) {
    for (const entry of owner.entries) {
      if (bundleByFilename.has(entry.filename)) {
        throw new Error(`ambiguous registered JSON Schema filename: ${entry.filename}`);
      }
      if (ids.has(entry.id)) throw new Error(`ambiguous registered JSON Schema $id: ${entry.id}`);
      if (digests.has(entry.sha256)) throw new Error(`ambiguous registered JSON Schema digest: ${entry.sha256}`);
      bundleByFilename.set(entry.filename, owner.bundle);
      ids.add(entry.id);
      digests.add(entry.sha256);
    }
  }
  return {
    entries: Object.freeze(entries),
    bundleByFilename,
    composedBundle: schemaRegistryBundleDigest(entries)
  };
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
