import { Args, Command } from "@oclif/core";
import { listRunSnapshots, type RunSnapshotsValue } from "@ultrafuzz/runtime";

import { cliIo, commandFromRuntime, emitCommandResult, globalFlags, projectRoot } from "../command-shared.js";

export default class Snapshots extends Command {
  static override summary = "List durability and workspace checkpoints for a run";
  static override args = { runId: Args.string({ required: true, description: "Ultrafuzz run ID" }) };
  static override flags = globalFlags;

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Snapshots);
    const result = await listRunSnapshots({
      projectRoot: projectRoot(flags),
      runId: args.runId,
      env: cliIo().env
    });
    emitCommandResult(this, "snapshots", commandFromRuntime("snapshots", result, renderSnapshots), flags.json === true);
  }
}

function renderSnapshots(value: RunSnapshotsValue): string {
  if (value.snapshots.length === 0) {
    return `Run: ${value.run_id}\nNo durability snapshots recorded.\n`;
  }
  const lines = [`Run: ${value.run_id}`, `Snapshots: ${value.snapshots.length}`];
  for (const snapshot of value.snapshots) {
    const node = snapshot.node_id ?? "run";
    const iteration = snapshot.iteration === null ? "" : `#${snapshot.iteration}`;
    const attempt = snapshot.attempt === null ? "" : ` attempt ${snapshot.attempt}`;
    const tier = snapshot.tier === null ? "" : ` [${snapshot.tier}]`;
    lines.push(
      `- seq ${snapshot.sequence ?? "?"}: ${node}${iteration}${attempt}${tier} at ${snapshot.created_at ?? "unknown time"}`
    );
  }
  return `${lines.join("\n")}\n`;
}
