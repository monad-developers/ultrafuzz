import { Command, Flags } from "@oclif/core";
import { validateProject } from "@ultrafuzz/runtime";

import { cliIo, commandFromRuntime, emitCommandResult, globalFlags, projectRoot } from "../command-shared.js";

export default class Validate extends Command {
  static override summary = "Validate config, topology, prompts, paths, and agent registry";
  static override flags = {
    ...globalFlags,
    "audit-profile": Flags.string({ summary: "Override the configured audit profile" }),
    "topology-path": Flags.string({ summary: "Override the selected topology path" })
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Validate);
    const result = await validateProject({
      projectRoot: projectRoot(flags),
      env: cliIo().env,
      topologyPath: flags["topology-path"],
      ...(flags["audit-profile"] === undefined ? {} : { runtimeOverrides: { auditProfile: flags["audit-profile"] } })
    });
    emitCommandResult(
      this,
      "validate",
      commandFromRuntime("validate", result, (value) => {
        const entries = Object.entries(value.policy_posture)
          .map(([name, posture]) => `- ${name}: ${posture.status} - ${posture.summary}`)
          .join("\n");
        return `${entries}\n`;
      }),
      flags.json === true
    );
  }
}
