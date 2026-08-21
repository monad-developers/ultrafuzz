import { Args, Command, Flags } from "@oclif/core";
import { resumeRun } from "@ultrafuzz/runtime";

import {
  cliEntrypoint,
  cliIo,
  commandFromRuntime,
  emitCommandResult,
  globalFlags,
  projectRoot
} from "../command-shared.js";

export default class Resume extends Command {
  static override summary = "Resume a linked run";
  static override args = { runId: Args.string({ required: true, description: "Ultrafuzz run ID" }) };
  static override flags = {
    ...globalFlags,
    "max-concurrency": Flags.integer({ summary: "Maximum parallel tasks" }),
    force: Flags.boolean({ summary: "Resume even if the workflow is already marked running" }),
    "retry-failed": Flags.boolean({ summary: "Retry failed workflow tasks before resuming" }),
    "reset-node": Flags.string({ summary: "Retry one failed workflow node and its dependents before resuming" }),
    "refresh-controller": Flags.boolean({
      summary: "Authenticate a compatible controller-only refresh before resuming the same workflow run"
    })
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Resume);
    const result = await resumeRun({
      projectRoot: projectRoot(flags),
      ultrafuzzCliEntrypoint: cliEntrypoint(),
      runId: args.runId,
      maxConcurrency: flags["max-concurrency"],
      force: flags.force,
      retryFailed: flags["retry-failed"],
      refreshController: flags["refresh-controller"],
      resetNode: flags["reset-node"],
      env: cliIo().env
    });
    emitCommandResult(
      this,
      "resume",
      commandFromRuntime("resume", result, (value) => `Submitted ${value.action}: ${value.workflow_run_id}\n`),
      flags.json === true
    );
  }
}
