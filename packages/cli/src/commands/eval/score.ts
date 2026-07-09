import { Args, Command, Flags } from "@oclif/core";
import { scoreEvalRun } from "@ultrafuzz/evals";

import { cliIo, commandFailure, emitCommandResult, globalFlags, projectRoot } from "../../command-shared.js";

export default class EvalScore extends Command {
  static override summary = "Score finished eval run reports against external ground truth";
  static override args = { evalRunId: Args.string({ required: true, description: "Eval run ID" }) };
  static override flags = {
    ...globalFlags,
    "llm-judge": Flags.boolean({
      summary: "Use the optional LLM judge configured by the suite judge model profile"
    })
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(EvalScore);
    const root = projectRoot(flags);
    try {
      const summary = await scoreEvalRun({
        projectRoot: root,
        evalRunId: args.evalRunId,
        llmJudge: flags["llm-judge"] === true,
        env: cliIo().env
      });
      emitCommandResult(
        this,
        "eval score",
        {
          ok: true,
          command: "eval score",
          data: summary,
          text: `Summary: ${summary.summary_path}\nScores: ${summary.scores_path}\nReview queue: ${summary.review_queue_path}\n`,
          diagnostics: []
        },
        flags.json === true
      );
    } catch (error) {
      emitCommandResult(
        this,
        "eval score",
        commandFailure("eval score", error instanceof Error ? error.message : String(error), "EVAL_SCORE_FAILED"),
        flags.json === true
      );
    }
  }
}
