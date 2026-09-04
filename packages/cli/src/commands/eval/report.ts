import path from "node:path";
import { TextDecoder } from "node:util";

import { Args, Command } from "@oclif/core";
import { readRegularFileSnapshot } from "@ultrafuzz/artifacts";
import { describeEvalError, evalRunRoot, readEvalScoreSummary } from "@ultrafuzz/evals";

import { commandFailure, emitCommandResult, globalFlags, projectRoot } from "../../command-shared.js";

export default class EvalReport extends Command {
  static override summary = "Show the scored eval run variant ranking";
  static override args = { evalRunId: Args.string({ required: true, description: "Eval run ID" }) };
  static override flags = globalFlags;

  async run(): Promise<void> {
    const { args, flags } = await this.parse(EvalReport);
    const root = projectRoot(flags);
    try {
      const runRoot = evalRunRoot(root, args.evalRunId);
      const summary = readEvalScoreSummary(path.join(runRoot, "summary.json"));
      const markdownPath = path.join(runRoot, "summary.md");
      const markdown = new TextDecoder("utf-8", { fatal: true }).decode(
        readRegularFileSnapshot(markdownPath, 16 * 1024 * 1024)
      );
      if (markdown.trim().length === 0) throw new Error(`eval report Markdown is empty: ${markdownPath}`);
      emitCommandResult(
        this,
        "eval report",
        {
          ok: true,
          command: "eval report",
          data: summary,
          text: markdown,
          diagnostics: []
        },
        flags.json === true
      );
    } catch (error) {
      emitCommandResult(
        this,
        "eval report",
        commandFailure("eval report", describeEvalError(error), "EVAL_REPORT_FAILED"),
        flags.json === true
      );
    }
  }
}
