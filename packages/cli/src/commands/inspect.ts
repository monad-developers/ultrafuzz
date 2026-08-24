import { Args, Command } from "@oclif/core";
import { getRunStatus, type RunStatusValue } from "@ultrafuzz/runtime";

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

export function renderInspectStatus(status: RunStatusValue): string {
  return [
    `Run: ${status.run_id}`,
    `Status: ${status.status}`,
    `Events: ${status.events}`,
    `Attempts: ${status.attempts.executed} executed, ${status.attempts.reused} reused`,
    renderDynamicGraph(status),
    `Root: ${status.run_root}`,
    status.workflow_ids.length > 0 ? `Workflow: ${status.workflow_ids.join(", ")}` : "Workflow: none",
    ""
  ].join("\n");
}

function renderDynamicGraph(status: RunStatusValue): string {
  const graph = record(status.graph);
  const nodes = Array.isArray(graph?.nodes)
    ? graph.nodes.map(record).filter((node): node is Record<string, unknown> => node !== undefined)
    : [];
  const groups = nodes.filter((node) => record(node.dynamic) !== undefined);
  const generated = nodes.filter((node) => record(node.dynamic_generated) !== undefined);
  if (groups.length === 0 && generated.length === 0) return "Dynamic nodes: none";

  const expandedGroups = groups.filter((node) => record(node.dynamic)?.status === "expanded").length;
  const statuses = new Map<string, number>();
  for (const node of generated) {
    const lineage = record(node.dynamic_generated);
    const storageId = typeof lineage?.storage_id === "string" ? lineage.storage_id : undefined;
    const humanId = typeof node.id === "string" ? node.id : undefined;
    const nodeState = storageId === undefined ? undefined : status.state?.nodes[storageId];
    const fallbackState = humanId === undefined ? undefined : status.state?.nodes[humanId];
    const nodeStatus = nodeState?.status ?? fallbackState?.status ?? "pending";
    statuses.set(nodeStatus, (statuses.get(nodeStatus) ?? 0) + 1);
  }
  const statusSummary = [...statuses]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `${count} ${name}`)
    .join(", ");
  return `Dynamic nodes: ${generated.length} generated${statusSummary === "" ? "" : ` (${statusSummary})`}; groups: ${expandedGroups} expanded, ${groups.length - expandedGroups} pending`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
