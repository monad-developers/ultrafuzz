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
    "dry-run": Flags.boolean({
      summary: "Preview a targeted reset without changing the run",
      dependsOn: ["reset-node"],
      exclusive: ["retry-failed"]
    }),
    "reset-generation": Flags.string({
      summary: "Require the generation returned by a reset preview",
      dependsOn: ["reset-node"],
      exclusive: ["retry-failed"]
    }),
    "refresh-controller": Flags.boolean({
      summary: "Render the current controller and continue the same Smithers run"
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
      dryRun: flags["dry-run"],
      resetGeneration: flags["reset-generation"],
      env: cliIo().env
    });
    const commandResult = commandFromRuntime("resume", result, (value) => {
      const plan = value.reset_plan;
      const reset =
        plan === undefined
          ? ""
          : `${value.reset_already_applied === true ? "Previously applied reset" : value.dry_run === true ? "Reset preview" : "Applied reset"}: ${String(plan.node_count)} nodes; generation ${plan.generation}\n` +
            `Reset policy: ${plan.policy} (includes later attempted work).\n` +
            plan.nodes
              .map(
                (node) =>
                  `  ${node.node_id} (iteration ${String(node.iteration)}${node.workflow_run_id === plan.workflow_run_id ? "" : `; workflow ${node.workflow_run_id}`})\n`
              )
              .join("");
      if (value.dry_run === true) return reset + "Dry run: no reset or controller launch performed.\n";
      return (
        reset +
        (value.submitted
          ? `Submitted ${value.action}: ${value.workflow_run_id}\n`
          : `Run already active: ${value.workflow_run_id}; no new controller was started. If a pause is still draining, resume again once status reports paused; if its controller process just exited, resume again after 30 seconds. This resume applied none of the project's current prompts; only a resume that starts a controller does.\n`)
      );
    });
    emitCommandResult(this, "resume", commandResult, flags.json);
  }
}
