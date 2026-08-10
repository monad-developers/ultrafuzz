import { Command } from "@oclif/core";
import { loadAuditProfileCatalog, packagedTopologyDigest, type AuditProfileDefinition } from "@ultrafuzz/config";

import { emitCommandResult, globalFlags } from "../../command-shared.js";

export default class ConfigAuditProfiles extends Command {
  static override summary = "List the audit profiles shipped with Ultrafuzz";
  static override flags = globalFlags;

  async run(): Promise<void> {
    const { flags } = await this.parse(ConfigAuditProfiles);
    const catalog = loadAuditProfileCatalog();
    const profiles = Object.values(catalog.profiles).map((profile) => profileData(profile, catalog.defaultProfile));
    emitCommandResult(
      this,
      "config audit-profiles",
      {
        ok: true,
        command: "config audit-profiles",
        data: {
          schema_version: catalog.schemaVersion,
          catalog_digest: catalog.digest,
          default_profile: catalog.defaultProfile,
          profiles
        },
        text: `${profiles.map(profileText).join("\n\n")}\n`,
        diagnostics: []
      },
      flags.json === true
    );
  }
}

function profileData(profile: AuditProfileDefinition, defaultProfile: string) {
  return {
    id: profile.id,
    description: profile.description,
    intended_use: profile.intendedUse,
    default: profile.id === defaultProfile,
    ...(profile.topologyPath === undefined
      ? {}
      : {
          topology_path: profile.topologyPath,
          topology_digest: packagedTopologyDigest(profile)
        })
  };
}

function profileText(profile: ReturnType<typeof profileData>): string {
  return [
    `${profile.id}${profile.default ? " (default)" : ""}`,
    `  ${profile.description}`,
    `  Intended use: ${profile.intended_use}`,
    `  Topology: ${profile.topology_path ?? ".ultrafuzz/topology.yml (project)"}`
  ].join("\n");
}
