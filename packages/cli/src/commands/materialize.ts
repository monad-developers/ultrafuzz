import { Args, Command, Flags } from "@oclif/core";
import { DATA_GOVERNANCE_POLICY_ENV, materializeRun } from "@ultrafuzz/runtime";

import { cliIo, commandFromRuntime, emitCommandResult, globalFlags, projectRoot } from "../command-shared.js";

export default class Materialize extends Command {
  static override summary = "Safely copy selected run outputs into the project";
  static override args = { runId: Args.string({ required: true, description: "Ultrafuzz run ID" }) };
  static override flags = {
    ...globalFlags,
    copy: Flags.string({ multiple: true, summary: "Copy selection as source:destination" }),
    yes: Flags.boolean({ summary: "Confirm materialization" }),
    confirm: Flags.boolean({ summary: "Confirm materialization" }),
    "dry-run": Flags.boolean({ summary: "Plan without writing" }),
    force: Flags.boolean({ summary: "Unsupported: materialize never overwrites destinations" }),
    "review-signoff": Flags.string({
      summary: "Absolute path to an operator-owned review signoff for publication-sensitive outputs"
    })
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Materialize);
    const copies = (flags.copy ?? []).map((entry) => {
      const separator = entry.indexOf(":");
      return {
        source: separator === -1 ? entry : entry.slice(0, separator),
        destination: separator === -1 ? entry : entry.slice(separator + 1)
      };
    });
    const result = await materializeRun({
      projectRoot: projectRoot(flags),
      runId: args.runId,
      copies,
      confirmed: flags.yes === true || flags.confirm === true,
      dryRun: flags["dry-run"],
      allowOverwrite: flags.force,
      operatorDataGovernancePolicy: cliIo().env[DATA_GOVERNANCE_POLICY_ENV],
      ...(flags["review-signoff"] === undefined ? {} : { reviewSignoffPath: flags["review-signoff"] })
    });
    emitCommandResult(
      this,
      "materialize",
      commandFromRuntime("materialize", result, (value) => `Materialized: ${value.copied.length} copies\n`),
      flags.json === true
    );
  }
}
