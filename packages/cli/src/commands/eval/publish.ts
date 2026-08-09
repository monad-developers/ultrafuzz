import { Args, Command, Flags } from "@oclif/core";
import { publishEvalRun } from "@ultrafuzz/evals";

import {
  cliIo,
  commandFailure,
  emitCommandResult,
  globalFlags,
  loadEvalConfig,
  projectRoot
} from "../../command-shared.js";
import { toCliEvalPublishData } from "../../cli-contracts.js";

export default class EvalPublish extends Command {
  static override summary = "Replay a recorded eval run's node telemetry to the configured provider";
  static override description =
    "Post-hoc/CI/backfill path: replays the run journals from offset 0 (or --resume from the persisted cursor) and reconstructs the entire node trace — spans, heartbeats, manifests, artifacts, scores — on the provider.";
  static override args = { evalRunId: Args.string({ required: true, description: "Eval run ID" }) };
  static override flags = {
    ...globalFlags,
    provider: Flags.string({ summary: "Eval reporter provider override (braintrust)" }),
    resume: Flags.boolean({ summary: "Resume from the persisted publish cursor instead of replaying from offset 0" })
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(EvalPublish);
    const root = projectRoot(flags);
    const env = cliIo().env;
    try {
      const { evalConfig, diagnostics } = await loadEvalConfig(root, env);
      const result = await publishEvalRun({
        projectRoot: root,
        evalRunId: args.evalRunId,
        ...(flags.provider !== undefined ? { provider: flags.provider } : {}),
        ...(flags.resume === true ? { resume: true } : {}),
        evalProviderConfig: evalConfig,
        env
      });
      emitCommandResult(
        this,
        "eval publish",
        {
          ok: true,
          command: "eval publish",
          data: toCliEvalPublishData(result),
          text:
            `Provider: ${result.provider}\nRows published: ${result.rows_published} (skipped ${result.rows_skipped})\n` +
            `Events: ${result.events_published}\nArtifacts: ${result.artifacts_published}\n` +
            `Scores: ${result.scores_published ? "published" : "not scored yet"}\n` +
            (result.report_url !== undefined ? `URL: ${result.report_url}\n` : ""),
          diagnostics: [...diagnostics, ...result.diagnostics]
        },
        flags.json === true
      );
    } catch (error) {
      emitCommandResult(
        this,
        "eval publish",
        commandFailure("eval publish", error instanceof Error ? error.message : String(error), "EVAL_PUBLISH_FAILED"),
        flags.json === true
      );
    }
  }
}
