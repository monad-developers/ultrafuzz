import { Args, Command } from "@oclif/core";
import { cancelRun } from "@ultrafuzz/runtime";

import { cliIo, commandFromRuntime, emitCommandResult, globalFlags, projectRoot } from "../command-shared.js";

export default class Cancel extends Command {
  static override summary = "Cancel a linked run and terminate its active cloud attempts";
  static override args = { runId: Args.string({ required: true, description: "Ultrafuzz run ID" }) };
  static override flags = globalFlags;

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Cancel);
    const result = await cancelRun({
      projectRoot: projectRoot(flags),
      runId: args.runId,
      env: cliIo().env
    });
    emitCommandResult(
      this,
      "cancel",
      commandFromRuntime("cancel", result, (value) => `Cancellation requested: ${value.run_id}\n`),
      flags.json === true
    );
  }
}
