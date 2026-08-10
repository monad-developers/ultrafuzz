import { Command } from "@oclif/core";
import { packagedTopologies } from "@ultrafuzz/config";
import { loadTopology } from "@ultrafuzz/topology";

import { emitCommandResult, globalFlags, projectRoot } from "../../command-shared.js";

export default class TopologyList extends Command {
  static override summary = "List the topology files shipped with Ultrafuzz";
  static override flags = globalFlags;

  async run(): Promise<void> {
    const { flags } = await this.parse(TopologyList);
    const root = projectRoot(flags);
    const topologies = packagedTopologies().map((definition) => ({
      id: definition.id,
      description: definition.description,
      topology_path: definition.relativePath,
      logical_nodes: loadTopology(root, { topologyPath: definition.path }).nodes.length,
      digest: definition.digest
    }));
    emitCommandResult(
      this,
      "topology list",
      {
        ok: true,
        command: "topology list",
        data: { topologies },
        text: `${topologies
          .map(
            (topology) =>
              `${topology.id}\n  ${topology.description}\n  Nodes: ${topology.logical_nodes}\n  Digest: ${topology.digest}`
          )
          .join("\n\n")}\n`,
        diagnostics: []
      },
      flags.json === true
    );
  }
}
