import { Args, Command, Flags } from "@oclif/core";
import { cleanRun, type RuntimeDiagnostic } from "@ultrafuzz/runtime";

import {
  cliIo,
  commandFromRuntime,
  diagnosticsText,
  emitCommandResult,
  globalFlags,
  projectRoot
} from "../command-shared.js";

export default class Clean extends Command {
  static override summary = "Safely clean selected generated Ultrafuzz paths";
  static override args = { runId: Args.string({ required: true, description: "Ultrafuzz run ID" }) };
  static override flags = {
    ...globalFlags,
    select: Flags.string({ multiple: true, summary: "Path under .ultrafuzz to remove" }),
    yes: Flags.boolean({ summary: "Confirm cleanup" }),
    confirm: Flags.boolean({ summary: "Confirm cleanup" }),
    "dry-run": Flags.boolean({ summary: "Plan without removing" })
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Clean);
    const json = flags.json;
    const selections = flags.select && flags.select.length > 0 ? flags.select : [`runs/${args.runId}`];
    // Removing a run removes the plan that names the Modal storage clean leaves
    // behind, so text output prints those warnings before anything is removed,
    // not only with the result. JSON output carries them in its one result.
    let printed: readonly RuntimeDiagnostic[] = [];
    const result = await cleanRun({
      projectRoot: projectRoot(flags),
      selections,
      confirmed: flags.yes === true || flags.confirm === true,
      dryRun: flags["dry-run"],
      ...(json
        ? {}
        : {
            onRetainedStorage: (warnings: readonly RuntimeDiagnostic[]) => {
              printed = warnings;
              cliIo().stdout.write(diagnosticsText([...warnings]));
            }
          })
    });
    emitCommandResult(
      this,
      "clean",
      commandFromRuntime(
        "clean",
        { ...result, diagnostics: result.diagnostics.filter((diagnostic) => !printed.includes(diagnostic)) },
        (value) => `Removed: ${value.removed.join(", ")}\n`
      ),
      json
    );
  }
}
