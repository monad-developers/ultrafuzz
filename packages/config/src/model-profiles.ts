import { DEFAULT_MODEL_PROFILE_ID, synthesizeDefaultModelProfile } from "./defaults.js";
import { diagnostic, type ConfigDiagnostic, type ResolvedConfig } from "./types.js";

const SAFE_AGENT_REF = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;

export function validateModelProfiles(config: ResolvedConfig): ConfigDiagnostic[] {
  const diagnostics: ConfigDiagnostic[] = [];

  if (!config.models.profiles[config.models.default]) {
    diagnostics.push(
      diagnostic(
        "CONFIG_MODEL_DEFAULT_UNKNOWN",
        `models.default references unknown model profile \`${config.models.default}\``,
        ["models", "default"],
        "validation"
      )
    );
  }

  for (const [id, profile] of Object.entries(config.models.profiles).sort()) {
    const path = ["models", id];
    if (profile.id !== id) {
      diagnostics.push(
        diagnostic(
          "CONFIG_MODEL_PROFILE_ID_MISMATCH",
          `model profile key \`${id}\` must match profile id \`${profile.id}\``,
          path.concat("id"),
          "validation"
        )
      );
    }
    if (!validProfileId(id)) {
      diagnostics.push(
        diagnostic(
          "CONFIG_MODEL_PROFILE_ID_INVALID",
          `model profile id \`${id}\` must use ASCII letters, digits, hyphen, underscore, or dot and must not contain traversal segments`,
          path,
          "validation"
        )
      );
    }
    if (!isSafeAgentRef(profile.agent)) {
      diagnostics.push(
        diagnostic(
          "CONFIG_MODEL_AGENT_INVALID",
          `model profile \`${id}\` references invalid agent \`${String(profile.agent)}\``,
          path.concat("agent"),
          "validation"
        )
      );
    }
    if (profile.model !== undefined && profile.model.trim() === "") {
      diagnostics.push(
        diagnostic(
          "CONFIG_MODEL_NAME_EMPTY",
          `model profile \`${id}\` model cannot be empty`,
          path.concat("model"),
          "validation"
        )
      );
    }
    if (
      profile.timeoutSeconds !== undefined &&
      (!Number.isInteger(profile.timeoutSeconds) || profile.timeoutSeconds < 1 || profile.timeoutSeconds > 86_400)
    ) {
      diagnostics.push(
        diagnostic(
          "CONFIG_MODEL_TIMEOUT_INVALID",
          "model profile timeout_seconds must be between 1 and 86400",
          path.concat("timeout_seconds"),
          "validation"
        )
      );
    }
  }

  return diagnostics;
}

export function syncDefaultModelProfile(config: ResolvedConfig): void {
  const defaultId = DEFAULT_MODEL_PROFILE_ID;
  if (config.models.default !== defaultId) {
    return;
  }

  const existingAgent = config.models.profiles[defaultId]?.agent;
  if (!config.models.profiles[defaultId] || config.models.synthesizedDefault) {
    config.models.profiles[defaultId] = synthesizeDefaultModelProfile(existingAgent);
    config.models.synthesizedDefault = true;
  }
}

export function validProfileId(id: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) &&
    !id.split(/[\\/]/).some((segment) => segment === "..") &&
    !id.includes("..")
  );
}

export function isSafeAgentRef(value: string): boolean {
  return SAFE_AGENT_REF.test(value) && !value.includes("..");
}
