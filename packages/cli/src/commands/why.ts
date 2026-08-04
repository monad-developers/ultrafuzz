import { Args, Command } from "@oclif/core";
import { diagnoseRun, type DiagnoseRunValue } from "@ultrafuzz/runtime";

import { cliIo, commandFromRuntime, emitCommandResult, globalFlags, projectRoot } from "../command-shared.js";

export default class Why extends Command {
  static override summary = "Explain why a run is blocked, paused, waiting, or unable to progress";
  static override args = { runId: Args.string({ required: true, description: "Ultrafuzz run ID" }) };
  static override flags = globalFlags;

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Why);
    const result = await diagnoseRun({
      projectRoot: projectRoot(flags),
      runId: args.runId,
      env: cliIo().env
    });
    emitCommandResult(this, "why", commandFromRuntime("why", result, renderDiagnosis), flags.json === true);
  }
}

function renderDiagnosis(value: DiagnoseRunValue): string {
  const lines = [
    `Run: ${value.run_id}`,
    `Status: ${value.run_status}`,
    `Diagnosis: ${value.summary}`,
    `Current node: ${value.current_node_id ?? "none"}`
  ];
  if (value.blockers.length === 0) {
    lines.push("Blockers: none");
  } else {
    lines.push("Blockers:");
    for (const blocker of value.blockers) {
      const node = blocker.node_id ?? "run";
      const iteration = blocker.iteration === null ? "" : `#${blocker.iteration}`;
      const attempts =
        blocker.attempt === null
          ? ""
          : ` (attempt ${blocker.attempt}${blocker.max_attempts === null ? "" : `/${blocker.max_attempts}`})`;
      lines.push(`- ${node}${iteration} ${blocker.kind}: ${blocker.reason}${attempts}`);
      if (blocker.unblocker !== null) {
        lines.push(`  unblock with: ${blocker.unblocker}`);
      }
      if (blocker.waiting_since !== null) {
        lines.push(`  waiting since: ${blocker.waiting_since}`);
      }
    }
  }
  for (const note of value.notes) {
    lines.push(`Note: ${note}`);
  }
  return `${lines.join("\n")}\n`;
}
