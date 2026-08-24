import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Args, Command, Flags } from "@oclif/core";
import { assertNoSymlinkComponents, assertPathInside } from "@ultrafuzz/artifacts";
import { packagedTopology } from "@ultrafuzz/config";

import { commandFailure, emitCommandResult, globalFlags, projectRoot } from "../../command-shared.js";

export default class TopologyCopy extends Command {
  static override summary = "Copy a packaged topology into the project";
  static override args = {
    name: Args.string({ required: true, description: "Packaged topology name" }),
    destination: Args.string({ required: true, description: "Project-relative destination path" })
  };
  static override flags = {
    ...globalFlags,
    force: Flags.boolean({ summary: "Overwrite an existing regular file" })
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(TopologyCopy);
    const commandName = "topology copy";
    const root = projectRoot(flags);
    try {
      const definition = packagedTopology(args.name);
      const destination = safeDestination(root, args.destination);
      const overwritten = publishTopology(root, destination, fs.readFileSync(definition.path), flags.force === true);
      const relativeDestination = path.relative(root, destination).split(path.sep).join("/");
      emitCommandResult(
        this,
        commandName,
        {
          ok: true,
          command: commandName,
          data: {
            id: definition.id,
            source_path: definition.relativePath,
            destination_path: relativeDestination,
            digest: definition.digest,
            overwritten
          },
          text: `Copied ${definition.id} to ${relativeDestination}\n`,
          diagnostics: []
        },
        flags.json === true
      );
    } catch (error) {
      emitCommandResult(
        this,
        commandName,
        commandFailure(commandName, error instanceof Error ? error.message : String(error), "CLI_TOPOLOGY_COPY_FAILED"),
        flags.json === true
      );
    }
  }
}

function safeDestination(projectRoot: string, requested: string): string {
  if (
    requested.length === 0 ||
    requested.includes("\0") ||
    path.isAbsolute(requested) ||
    path.win32.isAbsolute(requested)
  ) {
    throw new Error("topology destination must be a non-empty project-relative path");
  }
  const normalized = path.normalize(requested);
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error("topology destination must stay inside the project");
  }
  const destination = path.resolve(projectRoot, normalized);
  assertPathInside(projectRoot, destination, "topology destination");
  assertNoSymlinkComponents(projectRoot, destination, "topology destination");
  return destination;
}

function publishTopology(projectRoot: string, destination: string, contents: Buffer, force: boolean): boolean {
  const existing = lstatIfPresent(destination);
  if (existing?.isSymbolicLink()) throw new Error(`topology destination cannot be a symlink: ${destination}`);
  if (existing !== undefined && !existing.isFile()) {
    throw new Error(`topology destination exists and is not a regular file: ${destination}`);
  }
  if (existing !== undefined && !force) {
    throw new Error(`topology destination already exists; pass --force to overwrite: ${destination}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  assertNoSymlinkComponents(projectRoot, destination, "topology destination");
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`);
  try {
    const descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
      0o600
    );
    try {
      fs.writeFileSync(descriptor, contents);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    if (force) {
      fs.renameSync(temporary, destination);
    } else {
      fs.linkSync(temporary, destination);
      fs.unlinkSync(temporary);
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return existing !== undefined;
}

function lstatIfPresent(filePath: string): fs.Stats | undefined {
  return fs.lstatSync(filePath, { throwIfNoEntry: false });
}
