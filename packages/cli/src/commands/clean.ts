import { Args, Command, Flags } from "@oclif/core";
import { cleanGenerated } from "@ultrafuzz/runtime";

import { commandFromRuntime, emitCommandResult, globalFlags, projectRoot } from "../command-shared.js";

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
    const selections = flags.select && flags.select.length > 0 ? flags.select : [`runs/${args.runId}`];
    const result = await cleanGenerated({
      projectRoot: projectRoot(flags),
      selections,
      confirmed: flags.yes === true || flags.confirm === true,
      dryRun: flags["dry-run"]
    });
    emitCommandResult(
      this,
      "clean",
      commandFromRuntime("clean", result, (value) => `Removed: ${value.removed.join(", ")}\n`),
      flags.json === true
    );
  }
}
