import { Args, Command, Flags } from "@oclif/core";
import { getRunTimeline, type RunTimelineFrame, type RunTimelineValue } from "@ultrafuzz/runtime";

import { cliIo, commandFromRuntime, emitCommandResult, globalFlags, projectRoot } from "../command-shared.js";

export default class Timeline extends Command {
  static override summary = "Show checkpoint frames and fork lineage for a run";
  static override args = { runId: Args.string({ required: true, description: "Ultrafuzz run ID" }) };
  static override flags = {
    ...globalFlags,
    tree: Flags.boolean({ summary: "Include forked runs recursively" })
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Timeline);
    const result = await getRunTimeline({
      projectRoot: projectRoot(flags),
      runId: args.runId,
      tree: flags.tree === true,
      env: cliIo().env
    });
    emitCommandResult(this, "timeline", commandFromRuntime("timeline", result, renderTimeline), flags.json === true);
  }
}

function renderTimeline(value: RunTimelineValue): string {
  const lines = [`Run: ${value.run_id}`, `Frames: ${value.frames.length}`];
  if (value.frames.length === 0) {
    lines.push("No checkpoint frames recorded yet.");
  } else {
    lines.push(`Latest frame: ${value.latest_frame ?? "none"}`);
    lines.push("Use `ultrafuzz fork <run-id> --frame <n>` with a frame number below.");
    for (const frame of value.frames) {
      lines.push(renderFrame(frame, ""));
    }
  }
  if (value.tree) {
    for (const branch of value.lineage.filter((entry) => entry.depth > 0)) {
      const indent = "  ".repeat(branch.depth);
      lines.push(`${indent}Fork: ${branch.workflow_run_id}${branch.branch === null ? "" : ` (${branch.branch})`}`);
      for (const frame of branch.frames) {
        lines.push(renderFrame(frame, `${indent}  `));
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderFrame(frame: RunTimelineFrame, indent: string): string {
  const created = frame.created_at ?? "unknown time";
  const forks =
    frame.forks.length === 0
      ? ""
      : ` forked by ${frame.forks.map((fork) => fork.branch_label ?? fork.run_id).join(", ")}`;
  return `${indent}frame ${frame.frame}: ${created}${forks}`;
}
