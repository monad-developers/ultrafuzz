import { Command } from "@oclif/core";

import { benchmarkAnalysisFlags, executeBenchmarkAnalysis } from "../../../benchmark-analysis/command.js";

export default class EvalAnalyzePrecisionRecallF1 extends Command {
  static override summary = "Alias for eval analyze scores";
  static override flags = benchmarkAnalysisFlags;

  async run(): Promise<void> {
    const { flags } = await this.parse(EvalAnalyzePrecisionRecallF1);
    await executeBenchmarkAnalysis(this, "eval analyze precision-recall-f1", "scores", flags);
  }
}
