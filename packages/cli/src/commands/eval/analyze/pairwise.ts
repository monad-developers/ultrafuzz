import { Command } from "@oclif/core";

import { benchmarkAnalysisFlags, executeBenchmarkAnalysis } from "../../../benchmark-analysis/command.js";

export default class EvalAnalyzePairwise extends Command {
  static override summary = "Generate matched-pair or cross-row comparison charts";
  static override flags = benchmarkAnalysisFlags;

  async run(): Promise<void> {
    const { flags } = await this.parse(EvalAnalyzePairwise);
    await executeBenchmarkAnalysis(this, "eval analyze pairwise", "pairwise", flags);
  }
}
