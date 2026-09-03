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
      commandFromRuntime("ps", result, (value) => {
        const listed = new Set(value.runs.map((run) => run.ultrafuzz_run_id).filter((id) => id !== undefined));
        // A run that never reached a workflow -- a failed launch, or a
        // directory this build cannot read -- has no row in `runs`. Listing
        // only that view hides exactly the runs an operator is looking for
        // when something went wrong, and hides the id `clean` needs.
        const productOnly = value.product_runs.filter((run) => !listed.has(run.run_id));
        const rows = [
          ...value.runs.map(
            (run) =>
              `${run.ultrafuzz_run_id ?? "-"}\t${run.workflow_run_id}\t${run.workflow_status ?? run.ultrafuzz_status ?? "-"}\t${run.run_root ?? ""}`
          ),
          ...productOnly.map((run) => `${run.run_id}\t-\t${run.status}\t${run.run_root}`)
        ];
        return `${rows.join("\n")}\n`;
      }),
      flags.json === true
    );
  }
}
