import { Command } from "@oclif/core";

import { benchmarkAnalysisFlags, executeBenchmarkAnalysis } from "../../../benchmark-analysis/command.js";

export default class EvalAnalyzeCost extends Command {
  static override summary = "Generate performance versus token-cost charts";
  static override flags = benchmarkAnalysisFlags;

  async run(): Promise<void> {
    const { flags } = await this.parse(EvalAnalyzeCost);
    await executeBenchmarkAnalysis(this, "eval analyze cost", "cost", flags);
  }
}
