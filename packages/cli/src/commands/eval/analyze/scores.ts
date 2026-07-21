import { Command } from "@oclif/core";

import { benchmarkAnalysisFlags, executeBenchmarkAnalysis } from "../../../benchmark-analysis/command.js";

export default class EvalAnalyzeScores extends Command {
  static override summary = "Generate precision, recall, and F1 reports";
  static override flags = benchmarkAnalysisFlags;

  async run(): Promise<void> {
    const { flags } = await this.parse(EvalAnalyzeScores);
    await executeBenchmarkAnalysis(this, "eval analyze scores", "scores", flags);
  }
}
