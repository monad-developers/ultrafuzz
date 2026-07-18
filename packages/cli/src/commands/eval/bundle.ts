import path from "node:path";

import { Args, Command, Flags } from "@oclif/core";
import { collectEvalAnalysisBundle } from "@ultrafuzz/evals";

import { commandFailure, emitCommandResult, globalFlags, projectRoot } from "../../command-shared.js";

export default class EvalBundle extends Command {
  static override summary = "Export a privacy-safe, self-contained eval analysis bundle";
  static override args = { evalRunId: Args.string({ required: true, description: "Eval run ID" }) };
  static override flags = {
    ...globalFlags,
    output: Flags.string({ required: true, summary: "Bundle output directory" })
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(EvalBundle);
    const root = projectRoot(flags);
    try {
      const result = collectEvalAnalysisBundle({
        projectRoot: root,
        evalRunId: args.evalRunId,
        outputDir: path.resolve(root, flags.output)
      });
      emitCommandResult(
        this,
        "eval bundle",
        {
          ok: true,
          command: "eval bundle",
          data: result,
          text: `Analysis bundle: ${result.output_dir}\nManifest: ${result.manifest_path}\n`,
          diagnostics: []
        },
        flags.json === true
      );
    } catch (error) {
      emitCommandResult(
        this,
        "eval bundle",
        commandFailure("eval bundle", error instanceof Error ? error.message : String(error), "EVAL_BUNDLE_FAILED"),
        flags.json === true
      );
    }
  }
}
