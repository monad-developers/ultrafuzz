import { Command } from "@oclif/core";

import { benchmarkAnalysisFlags, executeBenchmarkAnalysis } from "../../../benchmark-analysis/command.js";

export default class EvalAnalyzeTable extends Command {
  static override summary = "Generate row, condition, and paired benchmark tables";
  static override flags = benchmarkAnalysisFlags;

  async run(): Promise<void> {
    const { flags } = await this.parse(EvalAnalyzeTable);
    await executeBenchmarkAnalysis(this, "eval analyze table", "table", flags);
  }
}
