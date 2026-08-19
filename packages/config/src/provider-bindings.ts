import { accessSync, constants } from "node:fs";
import { delimiter, resolve } from "node:path";
import {
  diagnostic,
  type ConfigDiagnostic,
  type HarnessCapabilities,
  type NodeRequirements,
  type ProviderBinding,
  type QualifiedHarnessBinding
} from "./types.js";

export function eventCapabilitySatisfies(
  actual: HarnessCapabilities["events"],
  required: HarnessCapabilities["events"]
): boolean {
  return actual === required || (actual === "jsonl" && required === "final-text-only");
}

export function qualifyHarnessBinding(input: {
  profileId: string;
  model: string;
  reasoning?: string;
  provider: ProviderBinding;
  harness: HarnessCapabilities;
  requirements?: NodeRequirements;
  env?: Record<string, string | undefined>;
  argv?: readonly string[];
}): { binding?: QualifiedHarnessBinding; diagnostics: ConfigDiagnostic[] } {
  const { profileId, provider, harness } = input;
  const env = input.env ?? process.env;
  const diagnostics: ConfigDiagnostic[] = [];
  const issue = (code: string, message: string, path: string[]) =>
    diagnostics.push(diagnostic(code, message, path, "validation"));
  const protocol = provider.protocols.find((value) => harness.protocols.includes(value));
  if (!protocol)
    issue(
      "CONFIG_BINDING_PROTOCOL_UNSUPPORTED",
      `models.${profileId}.provider and models.${profileId}.harness have no mutually supported wire protocol`,
      ["models", profileId, "provider"]
    );
  if (input.reasoning && !harness.reasoningLevels?.includes(input.reasoning))
    issue(
      "CONFIG_BINDING_REASONING_UNSUPPORTED",
      `models.${profileId}.reasoning is unsupported by harnesses.${harness.id}`,
      ["models", profileId, "reasoning"]
    );
  if (!harness.version.trim())
    issue("CONFIG_BINDING_VERSION_MISSING", `harnesses.${harness.id}.version is required`, [
      "harnesses",
      harness.id,
      "version"
    ]);
  if (!executableExists(harness.executable, env.PATH))
    issue("CONFIG_BINDING_EXECUTABLE_MISSING", `harnesses.${harness.id}.executable is unavailable`, [
      "harnesses",
      harness.id,
      "executable"
    ]);
  if (input.requirements?.events && !eventCapabilitySatisfies(harness.events, input.requirements.events))
    issue(
      "CONFIG_BINDING_EVENTS_UNSUPPORTED",
      `models.${profileId}.harness events ${harness.events} does not satisfy node.requires.events ${input.requirements.events}`,
      ["models", profileId, "harness"]
    );
  if (input.requirements?.cloudPortable && harness.cloudPortable !== true)
    issue(
      "CONFIG_BINDING_CLOUD_UNSUPPORTED",
      `models.${profileId}.harness does not satisfy node.requires.cloudPortable`,
      ["models", profileId, "harness"]
    );
  const childEnv: Record<string, string> = {};
  let exemption: QualifiedHarnessBinding["persistedCredentialExemption"];
  if (provider.auth === "api-key") {
    const credential = env[provider.credentialEnv];
    if (!credential?.trim())
      issue(
        "CONFIG_BINDING_CREDENTIAL_MISSING",
        `providers.${provider.id}.api_key_env ${provider.credentialEnv} is not set`,
        ["providers", provider.id, "api_key_env"]
      );
    else childEnv[provider.credentialEnv] = credential;
    if (input.argv?.some((arg) => arg === credential))
      issue("CONFIG_BINDING_ARGV_CREDENTIAL", `models.${profileId} credential must not appear in argv`, [
        "models",
        profileId,
        "provider"
      ]);
  } else if (harness.state.mode !== "persistent")
    issue(
      "CONFIG_BINDING_SUBSCRIPTION_STATE",
      `providers.${provider.id}.auth subscription requires harnesses.${harness.id}.state_root`,
      ["harnesses", harness.id, "state_root"]
    );
  else exemption = { stateRoot: harness.state.stateRoot, reason: "subscription credential persisted in harness state" };
  if (diagnostics.length || !protocol) return { diagnostics };
  return {
    binding: {
      provider,
      harness,
      model: input.model,
      ...(input.reasoning ? { reasoning: input.reasoning } : {}),
      protocol,
      childEnv,
      ...(exemption ? { persistedCredentialExemption: exemption } : {})
    },
    diagnostics
  };
}
function executableExists(name: string, path = ""): boolean {
  return path.split(delimiter).some((dir) => {
    try {
      accessSync(resolve(dir, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}
