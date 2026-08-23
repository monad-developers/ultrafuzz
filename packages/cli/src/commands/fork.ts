import { Args, Command, Flags } from "@oclif/core";
import { forkRun } from "@ultrafuzz/runtime";

import {
  cliEntrypoint,
  cliIo,
  commandFromRuntime,
  emitCommandResult,
  globalFlags,
  projectRoot
} from "../command-shared.js";

export default class Fork extends Command {
  static override summary = "Fork a linked run";
  static override args = { runId: Args.string({ required: true, description: "Ultrafuzz run ID" }) };
  static override flags = {
    ...globalFlags,
    frame: Flags.integer({ summary: "Checkpoint frame to fork from" }),
    "reset-node": Flags.string({ summary: "Workflow node ID to reset to pending" }),
    label: Flags.string({ summary: "Fork label" }),
    "max-concurrency": Flags.integer({ summary: "Maximum parallel tasks when starting the fork" })
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Fork);
    const result = await forkRun({
      projectRoot: projectRoot(flags),
      ultrafuzzCliEntrypoint: cliEntrypoint(),
      runId: args.runId,
      forkFrame: flags.frame,
      resetNode: flags["reset-node"],
      label: flags.label,
      maxConcurrency: flags["max-concurrency"],
      env: cliIo().env
    });
    emitCommandResult(
      this,
      "fork",
      commandFromRuntime("fork", result, (value) => `Submitted ${value.action}: ${value.workflow_run_id}\n`),
      flags.json === true
    );
  }
}
