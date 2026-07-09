import fs from "node:fs";
import path from "node:path";

import { Args, Command } from "@oclif/core";
import { evalRunRoot, jsonFile, type EvalScoreSummary } from "@ultrafuzz/evals";

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
      const summary = jsonFile<EvalScoreSummary>(path.join(runRoot, "summary.json"));
      const markdownPath = path.join(runRoot, "summary.md");
      const markdown = fs.existsSync(markdownPath) ? fs.readFileSync(markdownPath, "utf8") : "";
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
        commandFailure("eval report", error instanceof Error ? error.message : String(error), "EVAL_REPORT_FAILED"),
        flags.json === true
      );
    }
  }
}
