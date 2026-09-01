import { Command } from "@oclif/core";
import { listRuns } from "@ultrafuzz/runtime";

import { cliIo, commandFromRuntime, emitCommandResult, globalFlags, projectRoot } from "../command-shared.js";

export default class Ps extends Command {
  static override summary = "List Ultrafuzz runs";
  static override flags = globalFlags;

  async run(): Promise<void> {
    const { flags } = await this.parse(Ps);
    const result = await listRuns({ projectRoot: projectRoot(flags), env: cliIo().env });
    emitCommandResult(
      this,
      "ps",
      commandFromRuntime(
        "ps",
        result,
        (value) =>
          `${value.runs.map((run) => `${run.ultrafuzz_run_id ?? "-"}\t${run.workflow_run_id}\t${run.workflow_status ?? run.ultrafuzz_status ?? "-"}\t${run.run_root ?? ""}`).join("\n")}\n`
      ),
      flags.json === true
    );
  }
}
