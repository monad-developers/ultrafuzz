import { Command } from "@oclif/core";

import { benchmarkAnalysisFlags, executeBenchmarkAnalysis } from "../../../benchmark-analysis/command.js";

export default class EvalAnalyzeUpset extends Command {
  static override summary = "Generate root-cause intersection charts";
  static override flags = benchmarkAnalysisFlags;

  async run(): Promise<void> {
    const { flags } = await this.parse(EvalAnalyzeUpset);
    await executeBenchmarkAnalysis(this, "eval analyze upset", "upset", flags);
  }
}
