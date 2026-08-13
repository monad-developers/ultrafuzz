import { Args, Command } from "@oclif/core";
import { replayRun } from "@ultrafuzz/runtime";

import {
  cliEntrypoint,
  cliIo,
  commandFromRuntime,
  emitCommandResult,
  globalFlags,
  projectRoot
} from "../command-shared.js";

export default class Replay extends Command {
  static override summary = "Replay a linked run";
  static override args = { runId: Args.string({ required: true, description: "Ultrafuzz run ID" }) };
  static override flags = globalFlags;

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Replay);
    const result = await replayRun({
      projectRoot: projectRoot(flags),
      runId: args.runId,
      ultrafuzzCliEntrypoint: cliEntrypoint(),
      env: cliIo().env
    });
    emitCommandResult(
      this,
      "replay",
      commandFromRuntime("replay", result, (value) => `Submitted ${value.action}: ${value.workflow_run_id}\n`),
      flags.json === true
    );
  }
}
