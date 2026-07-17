import { Args, Command, Flags } from "@oclif/core";
import { getRunHealth, type RunHealthValue } from "@ultrafuzz/runtime";

import { cliIo, commandFromRuntime, emitCommandResult, globalFlags, projectRoot } from "../command-shared.js";

export default class Status extends Command {
  static override summary = "Show concise health for an Ultrafuzz run";
  static override args = { runId: Args.string({ required: true, description: "Ultrafuzz run ID" }) };
  static override flags = {
    ...globalFlags,
    window: Flags.integer({ min: 1, summary: "Recent activity window in minutes" })
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Status);
    const result = await getRunHealth({
      projectRoot: projectRoot(flags),
      runId: args.runId,
      windowMinutes: flags.window,
      env: cliIo().env
    });
    emitCommandResult(this, "status", commandFromRuntime("status", result, renderHealth), flags.json === true);
  }
}

function renderHealth(value: RunHealthValue): string {
  const counts = value.counts;
  const lines = [
    `Run: ${value.run_id}`,
    `Status: ${value.status}`,
    `Verdict: ${value.verdict}`,
    `Reason: ${value.reason}`,
    `Nodes: ${counts.finished} done, ${counts.in_progress} running, ${counts.pending} pending, ${counts.failed} failed`,
    `Pace: ${value.throughput.recent_finished} finished in the last ${Math.max(1, Math.round(value.throughput.window_ms / 60_000))}m`
  ];
  if (value.gating.length > 0) {
    lines.push(
      `Gating: ${value.gating.map((entry) => `${entry.node_id} (${entry.detail ?? entry.state})`).join(", ")}${
        value.gating_omitted > 0 ? `, +${value.gating_omitted} more` : ""
      }`
    );
  }
  return `${lines.join("\n")}\n`;
}
