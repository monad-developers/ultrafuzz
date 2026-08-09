import { Command } from "@oclif/core";
import { validateProject } from "@ultrafuzz/runtime";

import { cliIo, commandFromRuntime, emitCommandResult, globalFlags, projectRoot } from "../command-shared.js";
import { toCliValidateProjectData } from "../cli-contracts.js";

export default class Validate extends Command {
  static override summary = "Validate config, topology, prompts, paths, and agent registry";
  static override flags = globalFlags;

  async run(): Promise<void> {
    const { flags } = await this.parse(Validate);
    const result = await validateProject({ projectRoot: projectRoot(flags), env: cliIo().env });
    emitCommandResult(
      this,
      "validate",
      commandFromRuntime(
        "validate",
        result,
        (value) => {
          const entries = Object.entries(value.policy_posture)
            .map(([name, posture]) => `- ${name}: ${posture.status} - ${posture.summary}`)
            .join("\n");
          return `${entries}\n`;
        },
        toCliValidateProjectData
      ),
      flags.json === true
    );
  }
}
