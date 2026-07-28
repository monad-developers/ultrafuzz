import { Args, Command } from "@oclif/core";
import { getRunStatus } from "@ultrafuzz/runtime";

import { cliIo, commandFromRuntime, emitCommandResult, globalFlags, projectRoot } from "../command-shared.js";

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
      commandFromRuntime("inspect", result, (status) =>
        [
          `Run: ${status.run_id}`,
          `Status: ${status.status}`,
          `Events: ${status.events}`,
          `Attempts: ${status.attempts.executed} executed, ${status.attempts.reused} reused`,
          `Cloud attempts: ${status.cloud_attempts.length}`,
          ...status.cloud_attempts.map((attempt) => {
            const requested =
              `${attempt.requested_resources.cpu}cpu/${attempt.requested_resources.memory_mib}MiB/` +
              `${attempt.requested_resources.timeout_seconds}s`;
            const resolved =
              attempt.resolved_resources === undefined
                ? "unconfirmed"
                : `${attempt.resolved_resources.cpu}cpu/${attempt.resolved_resources.memory_mib}MiB/` +
                  `${attempt.resolved_resources.timeout_seconds}s`;
            return (
              `Cloud: ${attempt.task_id} ${attempt.state} provider=${attempt.provider} retry=${attempt.retry_index} ` +
              `vm=${attempt.provider_execution_ids.join(",") || "none"} requested=${requested} resolved=${resolved} ` +
              `resource_confirmation=${attempt.resource_confirmation ?? "none"} ` +
              `handoff=${attempt.handoff_sha256.slice(0, 12)} resumed=${attempt.resumed} reused=${attempt.reused} ` +
              `cleanup=${attempt.cleanup_state}`
            );
          }),
          `Root: ${status.run_root}`,
          status.workflow_ids.length > 0 ? `Workflow: ${status.workflow_ids.join(", ")}` : "Workflow: none",
          ""
        ].join("\n")
      ),
      flags.json === true
    );
  }
}
