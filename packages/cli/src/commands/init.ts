import { Command, Flags } from "@oclif/core";
import { initProject } from "@ultrafuzz/runtime";

import { commandFromRuntime, emitCommandResult, globalFlags, projectRoot } from "../command-shared.js";

export default class Init extends Command {
  static override summary = "Create project-owned Ultrafuzz surfaces";
  static override flags = {
    ...globalFlags,
    force: Flags.boolean({ summary: "Overwrite generated project files" })
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Init);
    const result = initProject({ projectRoot: projectRoot(flags), force: flags.force });
    emitCommandResult(
      this,
      "init",
      commandFromRuntime("init", result, (value) =>
        [
          `Project: ${value.project_root}`,
          `Created: ${value.created.length}`,
          `Preserved: ${value.preserved.length}`,
          `Overwritten: ${value.overwritten.length}`,
          ""
        ].join("\n")
      ),
      flags.json === true
    );
  }
}
