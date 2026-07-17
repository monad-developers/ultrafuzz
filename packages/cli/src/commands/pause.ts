import { Args, Command } from "@oclif/core";
import { pauseRun } from "@ultrafuzz/runtime";

import { cliIo, commandFromRuntime, emitCommandResult, globalFlags, projectRoot } from "../command-shared.js";

export default class Pause extends Command {
  static override summary = "Gracefully pause a linked run";
  static override args = { runId: Args.string({ required: true, description: "Ultrafuzz run ID" }) };
  static override flags = globalFlags;

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Pause);
    const result = await pauseRun({
      projectRoot: projectRoot(flags),
      runId: args.runId,
      env: cliIo().env
    });
    emitCommandResult(
      this,
      "pause",
      commandFromRuntime("pause", result, (value) =>
        value.submitted ? `Pause requested: ${value.run_id}\n` : `Run already paused: ${value.run_id}\n`
      ),
      flags.json === true
    );
  }
}
