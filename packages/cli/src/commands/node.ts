import { Args, Command, Flags } from "@oclif/core";
import { getWorkflowNode, watchWorkflowNode, type WorkflowNodeValue } from "@ultrafuzz/runtime";

import {
  cliIo,
  commandFromRuntime,
  emitCommandResult,
  envelope,
  globalFlags,
  projectRoot,
  type CommandResult
} from "../command-shared.js";

const DEFAULT_WATCH_INTERVAL_SECONDS = 5;

export default class Node extends Command {
  static override summary = "Show status, attempts, and timing for one workflow node";
  static override args = {
    runId: Args.string({ required: true, description: "Ultrafuzz run ID" }),
    nodeId: Args.string({ required: true, description: "Workflow node ID as reported by ultrafuzz inspect" })
  };
  static override flags = {
    ...globalFlags,
    iteration: Flags.integer({ min: 0, summary: "Loop iteration number; defaults to the latest" }),
    attempts: Flags.boolean({ summary: "Include per-attempt retry history" }),
    tools: Flags.boolean({ summary: "Include redacted tool inputs and outputs" }),
    watch: Flags.boolean({ summary: "Stream refreshed node snapshots until the run is terminal" }),
    interval: Flags.integer({
      summary: "Watch refresh interval in seconds",
      min: 1,
      default: DEFAULT_WATCH_INTERVAL_SECONDS
    })
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Node);
    const query = {
      projectRoot: projectRoot(flags),
      runId: args.runId,
      nodeId: args.nodeId,
      env: cliIo().env,
      ...(flags.iteration === undefined ? {} : { iteration: flags.iteration }),
      ...(flags.attempts === true ? { attempts: true } : {}),
      ...(flags.tools === true ? { tools: true } : {})
    };
    if (flags.watch !== true) {
      const result = await getWorkflowNode(query);
      emitCommandResult(this, "node", commandFromRuntime("node", result, renderNode), flags.json === true);
      return;
    }
    const json = flags.json === true;
    const result = await watchWorkflowNode({
      ...query,
      intervalSeconds: flags.interval,
      onSnapshot: (value) => {
        emitWatchSnapshot(value, json);
      }
    });
    if (!result.ok) {
      emitCommandResult(this, "node", commandFromRuntime("node", result, renderNode), json);
    }
  }
}

function emitWatchSnapshot(value: WorkflowNodeValue, json: boolean): void {
  const io = cliIo();
  if (!json) {
    io.stdout.write(renderNode(value));
    return;
  }
  const result: CommandResult = { ok: true, command: "node", data: value, diagnostics: [] };
  io.stdout.write(`${JSON.stringify(envelope("node", result))}\n`);
}

function renderNode(value: WorkflowNodeValue): string {
  const counts = value.attempt_counts;
  const lines = [
    `Run: ${value.run_id}`,
    `Node: ${value.node_id}${value.iteration === null ? "" : `#${value.iteration}`}`,
    `State: ${value.state ?? "unknown"}${value.status === null ? "" : ` (${value.status})`}`,
    `Duration: ${value.duration_ms === null ? "unknown" : `${Math.round(value.duration_ms / 1_000)}s`}`,
    `Attempts: ${counts.total} total, ${counts.succeeded} succeeded, ${counts.failed} failed, ${counts.cancelled} cancelled, ${counts.waiting} waiting`,
    `Agents: ${value.agents.length === 0 ? "none recorded" : value.agents.join(", ")}`,
    `Models: ${value.models.length === 0 ? "none recorded" : value.models.join(", ")}`,
    `Output: ${value.output.present ? `recorded (${value.output.source ?? "unknown source"})` : "not recorded"}`,
    `Updated: ${value.updated_at ?? "unknown"}`
  ];
  for (const attempt of value.attempts) {
    lines.push(
      `- attempt ${attempt.attempt ?? "?"}: ${attempt.state ?? "unknown"}${attempt.cached ? " (cached)" : ""}${
        attempt.duration_ms === null ? "" : ` in ${Math.round(attempt.duration_ms / 1_000)}s`
      }`
    );
    if (attempt.error !== null) {
      lines.push(`  error: ${attempt.error}`);
    }
    for (const call of attempt.tool_calls) {
      lines.push(`  tool ${call.sequence ?? "?"} ${call.name}: ${call.status ?? "unknown"}`);
      if (value.tool_details_included) {
        lines.push(`    input: ${JSON.stringify(call.input ?? null)}`);
        lines.push(`    output: ${JSON.stringify(call.output ?? null)}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
