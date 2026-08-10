import { Command, Flags } from "@oclif/core";
import { resolveEvalSuitePath, runEvalSuite } from "@ultrafuzz/evals";

import {
  cliEntrypoint,
  cliIo,
  commandFailure,
  emitCommandResult,
  globalFlags,
  loadEvalConfig,
  projectRoot
} from "../../command-shared.js";
import { toCliEvalRunData } from "../../cli-contracts.js";

export default class EvalRun extends Command {
  static override summary = "Launch Ultrafuzz runs for an eval suite matrix and stream node telemetry";
  static override flags = {
    ...globalFlags,
    suite: Flags.string({ summary: "Eval suite YAML path (defaults to [eval].eval_config)" }),
    provider: Flags.string({ summary: "Eval reporter provider override (braintrust | none)" }),
    "eval-run-id": Flags.string({ summary: "Eval run ID" }),
    row: Flags.string({ summary: "Matrix row ID to launch; repeatable", multiple: true }),
    "target-root": Flags.string({ summary: "Directory containing local target checkouts, one per target id" }),
    "ground-truth-root": Flags.string({ summary: "External directory containing benchmark ground truth" }),
    "watch-timeout-seconds": Flags.integer({
      summary: "Maximum time to watch each launched row before returning",
      min: 1
    }),
    "no-watch": Flags.boolean({ summary: "Launch detached without polling runs or streaming node telemetry" })
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(EvalRun);
    const root = projectRoot(flags);
    const env = cliIo().env;
    try {
      const { evalConfig, diagnostics } = await loadEvalConfig(root, env);
      const result = await runEvalSuite({
        projectRoot: root,
        suitePath: resolveEvalSuitePath({
          ...(flags.suite !== undefined ? { cliSuite: flags.suite } : {}),
          env,
          evalConfig
        }),
        ...(flags["eval-run-id"] !== undefined ? { evalRunId: flags["eval-run-id"] } : {}),
        ...(flags.row !== undefined ? { rowIds: flags.row } : {}),
        ...(flags["target-root"] !== undefined ? { targetRoot: flags["target-root"] } : {}),
        ...(flags["watch-timeout-seconds"] !== undefined
          ? { watchTimeoutSeconds: flags["watch-timeout-seconds"] }
          : {}),
        ...(flags["ground-truth-root"] !== undefined
          ? { groundTruthRoot: flags["ground-truth-root"] }
          : evalConfig.groundTruthRoot !== undefined
            ? { groundTruthRoot: evalConfig.groundTruthRoot }
            : {}),
        ...(flags.provider !== undefined ? { provider: flags.provider } : {}),
        ...(flags["no-watch"] === true ? { watch: false } : {}),
        evalProviderConfig: evalConfig,
        ultrafuzzCliEntrypoint: cliEntrypoint(),
        env
      });
      emitCommandResult(
        this,
        "eval run",
        {
          ok: result.failed === 0 && result.incomplete === 0,
          command: "eval run",
          data: toCliEvalRunData(result),
          text: `Eval run: ${result.eval_run_id}\nLaunched: ${result.launched}\nFailed: ${result.failed}\nIncomplete: ${result.incomplete}\nRoot: ${result.eval_run_root}\n`,
          diagnostics: [
            ...diagnostics,
            ...result.diagnostics,
            ...result.records.flatMap((record) => record.diagnostics)
          ]
        },
        flags.json === true
      );
    } catch (error) {
      emitCommandResult(
        this,
        "eval run",
        commandFailure("eval run", error instanceof Error ? error.message : String(error), "EVAL_RUN_FAILED"),
        flags.json === true
      );
    }
  }
}
