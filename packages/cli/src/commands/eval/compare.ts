import { Args, Command, Flags } from "@oclif/core";
import { compareEvalRun, compareEvalRuns } from "@ultrafuzz/evals";

import { commandFailure, emitCommandResult, globalFlags, projectRoot } from "../../command-shared.js";

export default class EvalCompare extends Command {
  static override summary = "Compare scored variants or longitudinal release eval runs";
  static override args = { evalRunId: Args.string({ required: true, description: "Eval run ID" }) };
  static override flags = {
    ...globalFlags,
    baseline: Flags.string({
      summary: "Baseline variant ID for an in-run comparison",
      exclusive: ["against"]
    }),
    against: Flags.string({
      summary: "Baseline eval run ID for a longitudinal comparison",
      exclusive: ["baseline"]
    }),
    "allow-incompatible": Flags.boolean({
      summary: "Explicitly waive cohort or scoring identity mismatches",
      dependsOn: ["against"]
    })
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(EvalCompare);
    const root = projectRoot(flags);
    try {
      if (flags.against !== undefined) {
        const comparison = compareEvalRuns({
          projectRoot: root,
          baselineEvalRunId: flags.against,
          candidateEvalRunId: args.evalRunId,
          ...(flags["allow-incompatible"] === true ? { allowIncompatible: true } : {})
        });
        emitCommandResult(
          this,
          "eval compare",
          {
            ok: true,
            command: "eval compare",
            data: comparison,
            text: [
              `Compatible: ${comparison.compatible ? "yes" : "no (explicit waiver applied)"}`,
              ...comparison.differences.map((difference) => `Compatibility difference: ${difference}`),
              ...comparison.variants.map(
                (variant) =>
                  `${variant.variant_id}: f1=${variant.candidate.f1_score} (${signed(variant.delta_f1_score)}), ` +
                  `recall=${variant.candidate.recall} (${signed(variant.delta_recall)}), ` +
                  `precision=${variant.candidate.precision} (${signed(variant.delta_precision)})`
              )
            ]
              .join("\n")
              .concat("\n"),
            diagnostics: []
          },
          flags.json === true
        );
        return;
      }
      if (flags.baseline === undefined) {
        throw new Error("pass --baseline for an in-run comparison or --against for a longitudinal comparison");
      }
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

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value}`;
}
