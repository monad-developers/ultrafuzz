import { Command } from "@oclif/core";

import { benchmarkAnalysisFlags, executeBenchmarkAnalysis } from "../../../benchmark-analysis/command.js";

export default class EvalAnalyzeProvenance extends Command {
  static override summary = "Generate finding and root-cause provenance reports";
  static override flags = benchmarkAnalysisFlags;

  async run(): Promise<void> {
    const { flags } = await this.parse(EvalAnalyzeProvenance);
    await executeBenchmarkAnalysis(this, "eval analyze provenance", "provenance", flags);
  }
}
