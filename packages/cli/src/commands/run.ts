import path from "node:path";

import { Command, Flags } from "@oclif/core";
import { parseStrictJsonBytes, readRegularFileSnapshot } from "@ultrafuzz/artifacts";
import { startRun } from "@ultrafuzz/runtime";

import { validateOperatorInput } from "../cli-schema-registry.js";
import {
  cliIo,
  cliEntrypoint,
  commandFailure,
  commandFromRuntime,
  emitCommandResult,
  globalFlags,
  projectRoot
} from "../command-shared.js";

const MAX_OPERATOR_INPUT_BYTES = 64 * 1024 * 1024;

export default class Run extends Command {
  static override summary = "Plan, render prompts, and launch a fuzzing workflow";
  static override flags = {
    ...globalFlags,
    "run-id": Flags.string({ summary: "Ultrafuzz run ID" }),
    "input-json": Flags.string({
      summary: "Workflow input as strict inline JSON",
      exclusive: ["input-file"]
    }),
    "input-file": Flags.string({
      summary: "Workflow input as a strict JSON file (relative to the project root)",
      exclusive: ["input-json"]
    }),
    "reference-expectations": Flags.string({
      summary: "Trusted benchmark expectation catalog JSON path"
    }),
    prompt: Flags.string({ summary: "Operator prompt text" }),
    agent: Flags.string({ summary: "Override the default agent reference" }),
    model: Flags.string({ summary: "Override the default model metadata" }),
    "audit-profile": Flags.string({ summary: "Override the configured audit profile" }),
    "topology-path": Flags.string({ summary: "Override the selected topology path" }),
    "max-concurrency": Flags.integer({ summary: "Maximum parallel tasks" }),
    "acknowledge-review": Flags.string({
      summary: "Acknowledge the exact effective launch-review SHA-256"
    })
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Run);
    const root = projectRoot(flags);
    let workflowInput: unknown;
    try {
      workflowInput = parseWorkflowInput(flags["input-json"], flags["input-file"], root);
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
      ultrafuzzCliEntrypoint: cliEntrypoint(),
      runId: flags["run-id"],
      referenceExpectationsPath: flags["reference-expectations"],
      prompt: flags.prompt,
      agent: flags.agent,
      model: flags.model,
      topologyPath: flags["topology-path"],
      ...(flags["audit-profile"] === undefined ? {} : { runtimeOverrides: { auditProfile: flags["audit-profile"] } }),
      workflowInput,
      reviewAcknowledgement: flags["acknowledge-review"],
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

function parseWorkflowInput(
  inlineJson: string | undefined,
  inputFile: string | undefined,
  projectRoot: string
): unknown {
  if (inlineJson === undefined && inputFile === undefined) return undefined;

  let value: unknown;
  try {
    value =
      inlineJson !== undefined
        ? parseStrictJsonBytes(Buffer.from(inlineJson, "utf8"), { maxBytes: MAX_OPERATOR_INPUT_BYTES })
        : parseStrictJsonBytes(
            readRegularFileSnapshot(path.resolve(projectRoot, inputFile!), MAX_OPERATOR_INPUT_BYTES),
            { maxBytes: MAX_OPERATOR_INPUT_BYTES }
          );
  } catch (error) {
    const source = inlineJson === undefined ? `workflow input file ${inputFile}` : "inline workflow input";
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${source} is not valid strict JSON: ${message}`, { cause: error });
  }

  const validation = validateOperatorInput(value);
  if (!validation.ok) {
    const summary = validation.issues
      .slice(0, 10)
      .map((issue) => `${issue.instancePath || "/"} ${issue.keyword}: ${issue.message}`)
      .join("; ");
    throw new Error(`workflow input does not match the operator-input contract: ${summary}`);
  }
  return value;
}
