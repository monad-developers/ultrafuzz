import { Args, Command } from "@oclif/core";
import { getRunStatus } from "@ultrafuzz/runtime";

import { cliIo, commandFromRuntime, emitCommandResult, globalFlags, projectRoot } from "../command-shared.js";
import { toCliInspectData } from "../cli-contracts.js";

export default class Inspect extends Command {
  static override summary = "Inspect product evidence for a run";
  static override args = {
    runId: Args.string({ required: true, description: "Ultrafuzz run ID" })
  };
  static override flags = globalFlags;

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Inspect);
    const result = await getRunStatus({ projectRoot: projectRoot(flags), runId: args.runId, env: cliIo().env });
    emitCommandResult(
      this,
      "inspect",
      commandFromRuntime(
        "inspect",
        result,
        (status) =>
          [
            `Run: ${status.run_id}`,
            `Status: ${status.status}`,
            `Events: ${status.events}`,
            `Attempts: ${status.attempts.executed} executed, ${status.attempts.reused} reused`,
            `Root: ${status.run_root}`,
            status.workflow_ids.length > 0 ? `Workflow: ${status.workflow_ids.join(", ")}` : "Workflow: none",
            ""
          ].join("\n"),
        toCliInspectData
      ),
      flags.json === true
    );
  }
}
