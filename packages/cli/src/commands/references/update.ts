import { Command, Flags } from "@oclif/core";
import { referencesUpdate } from "@ultrafuzz/runtime";

import { commandFromRuntime, emitCommandResult, globalFlags, projectRoot } from "../../command-shared.js";

export default class ReferencesUpdate extends Command {
  static override summary = "Rewrite pinned references to current default-branch SHAs";
  static override flags = {
    ...globalFlags,
    latest: Flags.boolean({ summary: "Intentionally update pinned commits to latest default-branch SHAs" })
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ReferencesUpdate);
    const result = referencesUpdate({ projectRoot: projectRoot(flags), latest: flags.latest });
    emitCommandResult(
      this,
      "references update",
      commandFromRuntime("references update", result, (value) => {
        const changed = value.updated.filter((reference) => reference.old_commit !== reference.new_commit).length;
        return `References updated: ${value.updated.length} tracked, ${changed} changed\nCatalog: ${value.catalog_path}\n`;
      }),
      flags.json === true
    );
  }
}
