import path from "node:path";

import { Command, Flags } from "@oclif/core";
import { validateProject } from "@ultrafuzz/runtime";

import { cliIo, commandFromRuntime, emitCommandResult, globalFlags, projectRoot } from "../command-shared.js";

export default class Validate extends Command {
  static override summary = "Validate config, topology, prompts, paths, and agent registry";
  static override flags = {
    ...globalFlags,
    topology: Flags.string({
      summary: "Topology YAML override, resolved relative to the project root"
    })
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Validate);
    const root = projectRoot(flags);
    const result = await validateProject({
      projectRoot: root,
      ...(flags.topology === undefined ? {} : { topologyPath: path.resolve(root, flags.topology) }),
      env: cliIo().env
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
