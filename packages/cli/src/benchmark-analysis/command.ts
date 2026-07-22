import path from "node:path";

import { Flags, type Command } from "@oclif/core";

import { cliIo, commandFailure, emitCommandResult, globalFlags, projectRoot } from "../command-shared.js";
import type { AnalysisCommandName } from "./types.js";
import { runAnalysisCommand } from "./lib/runner.js";

export const benchmarkAnalysisFlags = {
  ...globalFlags,
  input: Flags.string({
    char: "i",
    required: true,
    summary: "Finalized benchmark handoff ZIP (must be outside the repository)"
  }),
  output: Flags.string({
    char: "o",
    required: true,
    summary: "Private report directory (must be outside the repository)"
  })
};

export async function executeBenchmarkAnalysis(
  command: Command,
  commandName: string,
  analysisCommand: AnalysisCommandName,
  flags: { input: string; output: string; project?: string; json?: boolean }
): Promise<void> {
  try {
    const summary = await runAnalysisCommand(analysisCommand, {
      input: path.resolve(cliIo().cwd, flags.input),
      output: path.resolve(cliIo().cwd, flags.output),
      projectRoot: projectRoot(flags)
    });
    emitCommandResult(
      command,
      commandName,
      {
        ok: true,
        command: commandName,
        data: summary,
        text: [
          `Generated ${summary.outputs.length} private analysis files in ${summary.outputDirectory}.`,
          `${summary.findingInstances} finding instances; ${summary.rootCauseClusters} globally deduplicated root-cause clusters.`,
          `${summary.groundTruthTpCredits}/${summary.groundTruthCount} ground-truth TP credits detected.`,
          "Do not commit the input bundle or generated reports."
        ]
          .join("\n")
          .concat("\n"),
        diagnostics: []
      },
      flags.json === true
    );
  } catch (error) {
    emitCommandResult(
      command,
      commandName,
      commandFailure(commandName, error instanceof Error ? error.message : String(error), "BENCHMARK_ANALYSIS_FAILED"),
      flags.json === true
    );
  }
}
