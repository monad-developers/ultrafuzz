import path from "node:path";

import { publicationForbiddenSecretValues, readSinglyLinkedRegularFileSnapshotInside } from "@ultrafuzz/artifacts";
import { parseResolvedConfigJsonBytes } from "@ultrafuzz/config";
import { isSensitiveEnvironmentName, isSensitiveSecretValue } from "@ultrafuzz/security";

const MAX_RESOLVED_CONFIG_BYTES = 16 * 1024 * 1024;

/**
 * The `ULTRAFUZZ_AGENT_ENV_ALLOWLIST` variables that hold a credential, by
 * name or by value, under every spelling the source environment uses.
 */
export function sensitiveAllowlistedEnvironmentVariableNames(source: Record<string, string | undefined>): string[] {
  const names = new Set<string>();
  for (const entry of (source.ULTRAFUZZ_AGENT_ENV_ALLOWLIST ?? "").split(",")) {
    const name = entry.trim();
    if (name.length === 0) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new Error("ULTRAFUZZ_AGENT_ENV_ALLOWLIST must be a comma-separated list of environment variable names");
    }
    const upper = name.toUpperCase();
    const matchingSourceNames = Object.keys(source).filter((sourceName) => sourceName.toUpperCase() === upper);
    const values = matchingSourceNames
      .map((sourceName) => source[sourceName])
      .filter((value): value is string => value !== undefined);
    if (!isSensitiveEnvironmentName(name) && !values.some((value) => isSensitiveSecretValue(value))) continue;
    names.add(name);
    names.add(upper);
    for (const sourceName of matchingSourceNames) names.add(sourceName);
  }
  return [...names].sort();
}

/**
 * The credentials a run's publications must not hold, for a check that runs
 * outside the workflow controller, whose environment names them itself. Besides
 * the values recognized by name, these are the run's configured `api_key_env`
 * variables and the allowlisted variables that hold a credential (#1217). A
 * configuration or allowlist that cannot be read adds no names; every value
 * recognized by name is still included.
 */
export function runPublicationForbiddenSecretValues(
  runRoot: string,
  environment: Readonly<Record<string, string | undefined>> = process.env
): string[] {
  const names: string[] = [];
  try {
    const config = parseResolvedConfigJsonBytes(
      readSinglyLinkedRegularFileSnapshotInside(
        runRoot,
        path.join(runRoot, "smithers", "resolved-config.json"),
        MAX_RESOLVED_CONFIG_BYTES,
        "run resolved configuration"
      )
    );
    for (const [agentRef, agent] of Object.entries(config.agents)) {
      if (agent.auth !== "api-key" || agent.apiKeyEnv === undefined) continue;
      names.push(agent.apiKeyEnv);
      if (agentRef === "KimiAgent" && agent.apiKeyEnv === "KIMI_API_KEY") names.push("MOONSHOT_API_KEY");
    }
  } catch {
    // A run without a readable configuration still checks the named values.
  }
  try {
    names.push(...sensitiveAllowlistedEnvironmentVariableNames({ ...environment }));
  } catch {
    // A malformed allowlist was refused at launch and forwards nothing.
  }
  return publicationForbiddenSecretValues(environment, names);
}
