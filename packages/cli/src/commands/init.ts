import { Command, Flags } from "@oclif/core";
import { initProject } from "@ultrafuzz/runtime";

import { commandFromRuntime, diagnosticsText, emitCommandResult, globalFlags, projectRoot } from "../command-shared.js";

export default class Init extends Command {
  static override summary = "Create project-owned Ultrafuzz surfaces";
  static override flags = {
    ...globalFlags,
    force: Flags.boolean({ summary: "Overwrite generated project files" })
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Init);
    const result = initProject({ projectRoot: projectRoot(flags), force: flags.force });
    const commandResult = commandFromRuntime("init", result, (value) =>
      [
        `Project: ${value.project_root}`,
        `Created: ${value.created.length}`,
        `Preserved: ${value.preserved.length}`,
        `Overwritten: ${value.overwritten.length}`,
        ""
      ].join("\n")
    );
    if (result.ok && result.diagnostics.length > 0) {
      commandResult.text = `${commandResult.text ?? ""}${diagnosticsText(result.diagnostics)}`;
    }
    emitCommandResult(this, "init", commandResult, flags.json === true);
  }
}
