import { Args, Command } from "@oclif/core";
import { auditProfile, loadAuditProfileCatalog, resolvedAuditProfileSettings } from "@ultrafuzz/config";
import { effectiveAuditPolicy, loadResolvedProject } from "@ultrafuzz/runtime";

import { cliIo, commandFailure, emitCommandResult, globalFlags, projectRoot } from "../../command-shared.js";

export default class ConfigAuditProfile extends Command {
  static override summary = "Show one audit profile and its effective project settings";
  static override args = { name: Args.string({ required: true, description: "Audit profile name" }) };
  static override flags = globalFlags;

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ConfigAuditProfile);
    const commandName = "config audit-profile";
    const root = projectRoot(flags);
    try {
      const catalog = loadAuditProfileCatalog();
      const profile = auditProfile(args.name, catalog);
      const resolved = await loadResolvedProject({
        projectRoot: root,
        env: cliIo().env,
        runtimeOverrides: { auditProfile: profile.id }
      });
      if (resolved.config === undefined) {
        throw new Error(
          resolved.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("; ")
        );
      }
      const policy = effectiveAuditPolicy({ projectRoot: root, config: resolved.config });
      const data = {
        id: profile.id,
        description: profile.description,
        intended_use: profile.intendedUse,
        default: profile.id === catalog.defaultProfile,
        catalog_schema_version: catalog.schemaVersion,
        catalog_digest: catalog.digest,
        declared_topology_path: profile.topologyPath ?? null,
        effective_topology_path: policy.effectiveTopologyDisplayPath,
        topology_path_origin: policy.topologyPathOrigin,
        topology_digest: policy.topologyDigest,
        profile_settings: profile.settings,
        effective_settings: resolvedAuditProfileSettings(resolved.config),
        setting_origins: resolved.config.auditProfileResolution.settingOrigins,
        overridden_settings: resolved.config.auditProfileResolution.overriddenSettings
      };
      emitCommandResult(
        this,
        commandName,
        {
          ok: true,
          command: commandName,
          data,
          text: [
            `Profile: ${profile.id}${data.default ? " (default)" : ""}`,
            `Description: ${profile.description}`,
            `Intended use: ${profile.intendedUse}`,
            `Declared topology: ${profile.topologyPath ?? "none (uses project topology)"}`,
            `Effective topology: ${policy.effectiveTopologyDisplayPath} (${policy.topologyPathOrigin})`,
            `Catalog digest: ${catalog.digest}`,
            "Effective settings:",
            ...Object.entries(data.effective_settings).map(([key, value]) => `  ${key}: ${String(value)}`),
            `Overridden profile settings: ${data.overridden_settings.join(", ") || "none"}`,
            ""
          ].join("\n"),
          diagnostics: resolved.diagnostics
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
          "CLI_AUDIT_PROFILE_INVALID"
        ),
        flags.json === true
      );
    }
  }
}
