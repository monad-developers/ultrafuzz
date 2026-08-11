import fs from "node:fs";

import { Args, Command } from "@oclif/core";
import { packagedTopology } from "@ultrafuzz/config";
import { loadTopology } from "@ultrafuzz/topology";

import { commandFailure, emitCommandResult, globalFlags, projectRoot } from "../../command-shared.js";

export default class TopologyShow extends Command {
  static override summary = "Show one topology shipped with Ultrafuzz";
  static override args = { name: Args.string({ required: true, description: "Packaged topology name" }) };
  static override flags = globalFlags;

  async run(): Promise<void> {
    const { args, flags } = await this.parse(TopologyShow);
    const commandName = "topology show";
    try {
      const definition = packagedTopology(args.name);
      const source = fs.readFileSync(definition.path, "utf8");
      const topology = loadTopology(projectRoot(flags), { topologyPath: definition.path });
      const data = {
        id: definition.id,
        description: definition.description,
        topology_path: definition.relativePath,
        logical_nodes: topology.nodes.length,
        digest: definition.digest,
        source
      };
      emitCommandResult(
        this,
        commandName,
        {
          ok: true,
          command: commandName,
          data,
          text: [
            `Name: ${definition.id}`,
            `Description: ${definition.description}`,
            `Path: ${definition.relativePath}`,
            `Logical nodes: ${topology.nodes.length}`,
            `Digest: ${definition.digest}`,
            "",
            source
          ].join("\n"),
          diagnostics: []
        },
        flags.json === true
      );
    } catch (error) {
      emitCommandResult(
        this,
        commandName,
        commandFailure(
          commandName,
          error instanceof Error ? error.message : String(error),
          "CLI_PACKAGED_TOPOLOGY_INVALID"
        ),
        flags.json === true
      );
    }
  }
}
