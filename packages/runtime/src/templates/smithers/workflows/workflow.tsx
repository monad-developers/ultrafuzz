// smithers-source: generated
// smithers-display-name: Ultrafuzz __ULTRAFUZZ_RUN_ID__
// smithers-description: Generated Ultrafuzz product workflow. Smithers owns execution; Ultrafuzz owns config, topology, prompts, artifacts, reports, and materialization evidence.
// project-agents: .smithers/agents
/** @jsxImportSource smithers-orchestrator */
import { readFileSync } from "node:fs";
import { createSmithers, type AgentLike } from "smithers-orchestrator";
import { z } from "zod/v4";
import * as projectAgents from "__ULTRAFUZZ_AGENT_IMPORT__";

const inputTaskSchema = z.object({
  id: z.string(),
  prompt: z.string().optional(),
  prompt_path: z.string().optional()
});

const inputSchema = z.looseObject({
  tasks: z.array(inputTaskSchema).default([]),
  operator_prompt: z.string().optional(),
  operator_input: z.unknown().optional()
});

const taskOutput = z.object({
  summary: z.string().min(1)
});

const { Workflow, Task, Worktree, Parallel, smithers, outputs } = createSmithers({
  input: inputSchema,
  task: taskOutput
});

const agentRegistry = projectAgents as Record<string, AgentLike | AgentLike[]>;
const taskSpecs = __ULTRAFUZZ_TASK_SPECS__ as const;

function promptForTask(
  task: (typeof taskSpecs)[number],
  inputTask?: { prompt?: string; prompt_path?: string }
): string {
  if (typeof inputTask?.prompt === "string") {
    return inputTask.prompt;
  }
  const promptPath = inputTask?.prompt_path ?? task.promptPath;
  return promptPath ? readFileSync(promptPath, "utf8") : "";
}

export default smithers((ctx) => {
  const inputTasks = new Map(
    ((ctx.input as { tasks?: Array<{ id: string; prompt?: string; prompt_path?: string }> }).tasks ?? []).map(
      (task) => [task.id, task]
    )
  );
  const operatorPrompt =
    typeof ctx.input.operator_prompt === "string" && ctx.input.operator_prompt.length > 0
      ? `${ctx.input.operator_prompt}\n\n`
      : "";
  return (
    <Workflow name={__ULTRAFUZZ_WORKFLOW_NAME__}>
      <Parallel id="ultrafuzz-agent-tasks">
        {taskSpecs.map((task) => {
          const inputTask = inputTasks.get(task.id);
          return (
            <Worktree key={task.id} path={task.workspacePath} branch={task.branch}>
              <Task
                id={task.id}
                output={outputs.task}
                agent={agentRegistry[task.agentRef]}
                dependsOn={task.dependsOn}
                timeoutMs={task.timeoutMs}
                heartbeatTimeoutMs={task.heartbeatTimeoutMs}
                retries={task.retries}
                retryPolicy={task.retryPolicy}
                metadata={task.metadata}
              >
                {`${operatorPrompt}${promptForTask(task, inputTask)}`}
              </Task>
            </Worktree>
          );
        })}
      </Parallel>
    </Workflow>
  );
});
