import { Args, Command, Flags } from "@oclif/core";
import { compareEvalRun } from "@ultrafuzz/evals";

import { commandFailure, emitCommandResult, globalFlags, projectRoot } from "../../command-shared.js";

export default class EvalCompare extends Command {
  static override summary = "Compare scored eval variants against a baseline variant";
  static override args = { evalRunId: Args.string({ required: true, description: "Eval run ID" }) };
  static override flags = {
    ...globalFlags,
    baseline: Flags.string({ summary: "Baseline variant ID", required: true })
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(EvalCompare);
    const root = projectRoot(flags);
    try {
      const comparison = compareEvalRun({ projectRoot: root, evalRunId: args.evalRunId, baseline: flags.baseline });
      emitCommandResult(
        this,
        "eval compare",
        {
          ok: true,
          command: "eval compare",
          data: comparison,
          text: comparison.variants
            .map(
              (variant) =>
                `${variant.variant_id}: f1=${variant.f1_score} (${variant.delta_f1_score >= 0 ? "+" : ""}${variant.delta_f1_score})`
            )
            .join("\n")
            .concat("\n"),
          diagnostics: []
        },
        flags.json === true
      );
    } catch (error) {
      emitCommandResult(
        this,
        "eval compare",
        commandFailure("eval compare", error instanceof Error ? error.message : String(error), "EVAL_COMPARE_FAILED"),
        flags.json === true
      );
    }
  }
}
