import { Command } from "@oclif/core";
import { referencesSync } from "@ultrafuzz/runtime";

import { commandFromRuntime, emitCommandResult, globalFlags, projectRoot } from "../../command-shared.js";

export default class ReferencesSync extends Command {
  static override summary = "Fetch pinned references into the local cache";
  static override flags = {
    ...globalFlags
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ReferencesSync);
    const result = referencesSync({ projectRoot: projectRoot(flags) });
    emitCommandResult(
      this,
      "references sync",
      commandFromRuntime("references sync", result, (value) => {
        const fetched = value.synced.filter((reference) => reference.fetched).length;
        return `References synced: ${value.synced.length} tracked, ${fetched} fetched\nCache: ${value.cache_root}\n`;
      }),
      flags.json === true
    );
  }
}
