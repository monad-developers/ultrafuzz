import { Command } from "@oclif/core";

import { benchmarkAnalysisFlags, executeBenchmarkAnalysis } from "../../../benchmark-analysis/command.js";

export default class EvalAnalyzeUpsert extends Command {
  static override summary = "Alias for eval analyze upset";
  static override flags = benchmarkAnalysisFlags;

  async run(): Promise<void> {
    const { flags } = await this.parse(EvalAnalyzeUpsert);
    await executeBenchmarkAnalysis(this, "eval analyze upsert", "upset", flags);
  }
}
