import path from "node:path";
import { fileURLToPath } from "node:url";

export type WorkerResourceLimits = {
  taskId: string;
  runRoot: string;
  memoryMiB: number;
  cpu: number;
};

type CommandSpec = {
  command: string;
  args: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
};

type BuildCommandParams = { prompt: string; [key: string]: unknown };
type BuildableAgent = {
  buildCommand(params: BuildCommandParams): Promise<CommandSpec>;
};

/**
 * Put each real model invocation behind a tiny process-tree supervisor. Smithers
 * preflight commands stay unwrapped: they are short diagnostics and wrapping
 * them would hide the executable identity Smithers is checking.
 */
export function withWorkerResourceLimits<T>(agent: T, limits: WorkerResourceLimits | undefined): T {
  if (limits === undefined || !isBuildableAgent(agent)) return agent;
  const original = agent.buildCommand.bind(agent);
  agent.buildCommand = async (params: BuildCommandParams): Promise<CommandSpec> => {
    const command = await original(params);
    if (params.prompt.length === 0) return command;
    const markerPath = path.join(limits.runRoot, "smithers", "resource-terminations", `${limits.taskId}.json`);
    return {
      ...command,
      command: process.execPath,
      args: [
        fileURLToPath(new URL("./worker-resource-guard.ts", import.meta.url)),
        "--memory-mib",
        String(limits.memoryMiB),
        "--cpu",
        String(limits.cpu),
        "--task-id",
        limits.taskId,
        "--marker",
        markerPath,
        "--",
        command.command,
        ...command.args
      ]
    };
  };
  return agent;
}

function isBuildableAgent(value: unknown): value is BuildableAgent {
  return (
    typeof value === "object" &&
    value !== null &&
    "buildCommand" in value &&
    typeof (value as { buildCommand?: unknown }).buildCommand === "function"
  );
}
