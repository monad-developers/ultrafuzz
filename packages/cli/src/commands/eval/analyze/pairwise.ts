import { Command } from "@oclif/core";

import { benchmarkAnalysisFlags, executeBenchmarkAnalysis } from "../../../benchmark-analysis/command.js";

export default class EvalAnalyzePairwise extends Command {
  static override summary = "Generate paired Ultrafuzz versus no-fuzz comparison charts";
  static override flags = benchmarkAnalysisFlags;

  async run(): Promise<void> {
    const { flags } = await this.parse(EvalAnalyzePairwise);
    await executeBenchmarkAnalysis(this, "eval analyze pairwise", "pairwise", flags);
  }
}
