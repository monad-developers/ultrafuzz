import { Args, Command, Flags } from "@oclif/core";
import { getWorkflowNode, watchWorkflowNode, type RuntimeDiagnostic, type WorkflowNodeValue } from "@ultrafuzz/runtime";

import {
  cliIo,
  commandFromRuntime,
  diagnosticsText,
  emitCommandResult,
  emitWatchFailure,
  envelope,
  globalFlags,
  projectRoot,
  type CommandResult
} from "../command-shared.js";
import { toCliWorkflowNodeData } from "../cli-contracts.js";

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
      emitCommandResult(
        this,
        "node",
        commandFromRuntime("node", result, renderNode, toCliWorkflowNodeData),
        flags.json === true
      );
      return;
    }
    const json = flags.json === true;
    const result = await watchWorkflowNode({
      ...query,
      intervalSeconds: flags.interval,
      onSnapshot: (value, diagnostics) => {
        emitWatchSnapshot(value, json, diagnostics);
      }
    });
    if (!result.ok) {
      emitWatchFailure("node", commandFromRuntime("node", result, renderNode, toCliWorkflowNodeData), json);
    }
  }
}

function emitWatchSnapshot(value: WorkflowNodeValue, json: boolean, diagnostics: RuntimeDiagnostic[]): void {
  const io = cliIo();
  if (!json) {
    io.stdout.write(`${renderNode(value)}${diagnosticsText(diagnostics)}`);
    return;
  }
  const result: CommandResult = { ok: true, command: "node", data: toCliWorkflowNodeData(value), diagnostics };
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
  const phase = value.backend_finalization;
  if (phase !== undefined) {
    lines.push(
      `Backend phase: ${phase.phase}; checkpoint: ${phase.checkpoint_available ? "available" : "not available"}`,
      `Execution deadline: ${new Date(phase.execution_deadline_ms).toISOString()}; finalization deadline: ${phase.finalization_deadline_ms === null ? "not entered" : new Date(phase.finalization_deadline_ms).toISOString()}`,
      `Finalization grace: ${String(phase.finalization_grace_ms)}ms; last activity: ${new Date(phase.last_activity_at_ms).toISOString()}`
    );
  }
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
