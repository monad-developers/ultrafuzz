import { Command } from "@oclif/core";
import { referencesStatus } from "@ultrafuzz/runtime";

import { commandFromRuntime, emitCommandResult, globalFlags, projectRoot } from "../../command-shared.js";

export default class ReferencesStatus extends Command {
  static override summary = "Show pinned reference cache status";
  static override flags = {
    ...globalFlags
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ReferencesStatus);
    const result = referencesStatus({ projectRoot: projectRoot(flags) });
    emitCommandResult(
      this,
      "references status",
      commandFromRuntime("references status", result, (value) =>
        [
          `References: ${value.references.length}`,
          `Cache: ${value.cache_root}`,
          ...value.references.map(
            (reference) =>
              `- ${reference.id}: ${reference.ok ? "ok" : "missing"} (${reference.repo}/${reference.commit})`
          ),
          ""
        ].join("\n")
      ),
      flags.json === true
    );
  }
}
