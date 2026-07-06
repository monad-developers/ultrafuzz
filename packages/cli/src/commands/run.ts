import fs from "node:fs";
import path from "node:path";

import { Command, Flags } from "@oclif/core";
import { startRun } from "@ultrafuzz/runtime";

import {
  cliIo,
  commandFailure,
  commandFromRuntime,
  emitCommandResult,
  globalFlags,
  projectRoot
} from "../command-shared.js";

export default class Run extends Command {
  static override summary = "Plan, render prompts, and launch a fuzzing workflow";
  static override flags = {
    ...globalFlags,
    "run-id": Flags.string({ summary: "Ultrafuzz run ID" }),
    input: Flags.string({ summary: "Workflow input JSON path or inline JSON" }),
    prompt: Flags.string({ summary: "Operator prompt text" }),
    agent: Flags.string({ summary: "Override the default agent reference" }),
    model: Flags.string({ summary: "Override the default model metadata" }),
    "max-concurrency": Flags.integer({ summary: "Maximum parallel tasks" })
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Run);
    const root = projectRoot(flags);
    let workflowInput: unknown;
    try {
      workflowInput = parseWorkflowInput(flags.input, root);
    } catch (error) {
      emitCommandResult(
        this,
        "run",
        commandFailure("run", error instanceof Error ? error.message : String(error), "CLI_INPUT_INVALID"),
        flags.json === true
      );
      return;
    }
    const result = await startRun({
      projectRoot: root,
      runId: flags["run-id"],
      prompt: flags.prompt,
      agent: flags.agent,
      model: flags.model,
      workflowInput,
      maxConcurrency: flags["max-concurrency"],
      env: cliIo().env
    });
    emitCommandResult(
      this,
      "run",
      commandFromRuntime("run", result, (value) =>
        [
          `Run: ${value.run_id}`,
          `Status: ${value.status}`,
          `Root: ${value.run_root}`,
          `Workflow: ${value.workflow_ids.join(", ")}`,
          ""
        ].join("\n")
      ),
      flags.json === true
    );
  }
}

function parseWorkflowInput(value: string | undefined, projectRoot: string): unknown {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    const absolute = path.resolve(projectRoot, value);
    if (!fs.existsSync(absolute)) {
      throw new Error(`workflow input must be inline JSON or an existing JSON file: ${value}`);
    }
    try {
      return JSON.parse(fs.readFileSync(absolute, "utf8")) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`workflow input file is not valid JSON: ${message}`, { cause: error });
    }
  }
}
