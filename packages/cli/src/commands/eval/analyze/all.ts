import { Command } from "@oclif/core";

import { benchmarkAnalysisFlags, executeBenchmarkAnalysis } from "../../../benchmark-analysis/command.js";

export default class EvalAnalyzeAll extends Command {
  static override summary = "Generate all private benchmark analysis reports";
  static override flags = benchmarkAnalysisFlags;

  async run(): Promise<void> {
    const { flags } = await this.parse(EvalAnalyzeAll);
    await executeBenchmarkAnalysis(this, "eval analyze all", "all", flags);
  }
}
