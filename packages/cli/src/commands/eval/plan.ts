import { Command, Flags } from "@oclif/core";
import { planEvalSuite, resolveEvalProvider, resolveEvalSuitePath } from "@ultrafuzz/evals";

import {
  cliIo,
  commandFailure,
  emitCommandResult,
  globalFlags,
  loadEvalConfig,
  projectRoot
} from "../../command-shared.js";

export default class EvalPlan extends Command {
  static override summary = "Dry-run an eval suite matrix without launching workflows";
  static override flags = {
    ...globalFlags,
    suite: Flags.string({ summary: "Eval suite YAML path (defaults to [eval].eval_config)" }),
    provider: Flags.string({ summary: "Eval reporter provider override (braintrust | langsmith | none)" }),
    "target-root": Flags.string({ summary: "Directory containing local target checkouts, one per target id" }),
    "skip-target-validation": Flags.boolean({ summary: "Skip local target git ref validation" })
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EvalPlan);
    const root = projectRoot(flags);
    const env = cliIo().env;
    try {
      const { evalConfig, diagnostics } = await loadEvalConfig(root, env);
      // Provider validation is a plan-time config error (credentials are only
      // checked at publish time so local-only runs keep working).
      const provider = resolveEvalProvider({
        ...(flags.provider !== undefined ? { cliProvider: flags.provider } : {}),
        env,
        evalConfig
      });
      const plan = planEvalSuite({
        projectRoot: root,
        suitePath: resolveEvalSuitePath({
          ...(flags.suite !== undefined ? { cliSuite: flags.suite } : {}),
          env,
          evalConfig
        }),
        validateTargets: flags["skip-target-validation"] !== true,
        ...(flags["target-root"] !== undefined ? { targetRoot: flags["target-root"] } : {}),
        ...(evalConfig.groundTruthRoot !== undefined ? { groundTruthRoot: evalConfig.groundTruthRoot } : {})
      });
      emitCommandResult(
        this,
        "eval plan",
        {
          ok: true,
          command: "eval plan",
          data: {
            suite_path: plan.suite_path,
            suite: plan.suite.suite,
            provider: provider.provider,
            reporting: plan.suite.reporting,
            matrix: plan.matrix
          },
          text: `Suite: ${plan.suite.suite}\nProvider: ${provider.provider}\nRows: ${plan.matrix.length}\n`,
          diagnostics
        },
        flags.json === true
      );
    } catch (error) {
      emitCommandResult(
        this,
        "eval plan",
        commandFailure("eval plan", error instanceof Error ? error.message : String(error), "EVAL_PLAN_FAILED"),
        flags.json === true
      );
    }
  }
}
