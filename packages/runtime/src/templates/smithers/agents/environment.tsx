import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseStrictJsonBytes, readRegularFileSnapshot } from "./strict-json";

export const PROVIDER_SCOPED_SENSITIVE_ENVIRONMENT_CAPABILITY =
  "ultrafuzz.provider-scoped-sensitive-environment.v1" as const;

// The controller computes acknowledged route IDs and credential ownership
// with these @ultrafuzz/runtime functions. Use the same functions, loaded from
// the module the rendered workflow imports, rather than copies that have to be
// kept in step with them.
const {
  isCredentialLikeEnvironmentVariableName,
  providerRouteDestination,
  routeOwnsCredentialLikeEnvironmentVariable
} = (await import(
  process.env.ULTRAFUZZ_RUNTIME_MODULE ??
    new URL("../../modules/@ultrafuzz/runtime/dist/index.js", import.meta.url).href
)) as {
  isCredentialLikeEnvironmentVariableName: (name: string) => boolean;
  providerRouteDestination: (
    agent: string,
    env: Record<string, string | undefined>,
    routeConfig?: Uint8Array
  ) => string;
  routeOwnsCredentialLikeEnvironmentVariable: (agent: string, name: string) => boolean;
};

const CONTROLLER_ONLY_ENVIRONMENT_VARIABLES = [
  "SMITHERS_BIN",
  "SMITHERS_CLI_SRC_DIR",
  "ULTRAFUZZ_AGENT_ENV_ALLOWLIST",
  "ULTRAFUZZ_ARTIFACTS_MODULE",
  "ULTRAFUZZ_BUN_MODULE_CONFINEMENT",
  "ULTRAFUZZ_CONFIG_PATH",
  "ULTRAFUZZ_DATA_DISCLOSURE_ACKNOWLEDGEMENTS",
  "ULTRAFUZZ_MODAL_PUBLIC_BENCHMARK",
  "ULTRAFUZZ_DATA_GOVERNANCE_PATH",
  "ULTRAFUZZ_DATA_GOVERNANCE_POLICY",
  "ULTRAFUZZ_PROVIDER_CREDENTIAL_ENV_NAMES",
  "ULTRAFUZZ_PROVIDER_HOME_ROOT",
  "ULTRAFUZZ_MODAL_MODULE",
  "ULTRAFUZZ_RUNTIME_MODULE",
  "ULTRAFUZZ_SCHEMA_BUNDLE_SHA256",
  "ULTRAFUZZ_SENSITIVE_AGENT_ENV_NAMES",
  "ULTRAFUZZ_TRUSTED_BIN",
  "ULTRAFUZZ_VALIDATOR_BUILD",
  "ULTRAFUZZ_SNAPSHOT_INHERITED_DESCRIPTOR",
  "ULTRAFUZZ_SNAPSHOT_PERSISTED_ROOT",
  "ULTRAFUZZ_SNAPSHOT_PROCESS_DESCRIPTOR",
  "ULTRAFUZZ_SNAPSHOT_PROCESS_ROOT",
  "ULTRAFUZZ_SNAPSHOT_SOURCE_ROOT",
  "ULTRAFUZZ_WORKFLOW_PERSISTED_PATH"
] as const;

const BUILT_IN_PROVIDER_CREDENTIAL_ENVIRONMENT_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "AZURE_OPENAI_API_KEY",
  "CODEX_API_KEY",
  "DEEPSEEK_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY"
] as const;
const BUILT_IN_PROVIDER_HOME_ENVIRONMENT_VARIABLES = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "KIMI_CODE_HOME",
  "KIMI_SHARE_DIR"
] as const;
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

type WorkflowRouteAgent = "ClaudeAgent" | "CodexAgent" | "DeepSeekAgent" | "KimiAgent" | "OpenRouterAgent";
type WorkflowDataRoute = { agent: WorkflowRouteAgent; configDir?: string };

/**
 * Smithers agents inherit the controller environment by default. Remove every
 * controller-only capability, including aliases that name the descriptor-held
 * execution tree, before an untrusted model process is spawned.
 */
export function workflowControlChildEnvironment(
  additions: Record<string, string | undefined> = {},
  source: Record<string, string | undefined> = process.env,
  route?: WorkflowDataRoute
): Record<string, string> {
  const child: Record<string, string> = Object.fromEntries(
    [
      ...CONTROLLER_ONLY_ENVIRONMENT_VARIABLES,
      ...BUILT_IN_PROVIDER_HOME_ENVIRONMENT_VARIABLES,
      ...providerCredentialEnvironmentVariables(source)
    ].map((name) => [name, ""])
  );
  const roots = workflowExecutionSnapshotRoots(source);
  const aliasesControl = (name: string, value: string): boolean => {
    // PATH has already passed the controller's command-path admission. Its
    // trusted-bin/forge guard intentionally lives under the target; blanking
    // the whole list also removes external CLIs admitted by the controller.
    if (name === "PATH") return false;
    return roots.some((root) => environmentPath(value).includes(root));
  };
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && aliasesControl(name, value)) child[name] = "";
  }
  for (const [name, value] of Object.entries(additions)) {
    if (value !== undefined) child[name] = value;
  }
  if (route !== undefined) restoreRouteScopedAllowlistedCredentials(child, source, route.agent);
  for (const name of CONTROLLER_ONLY_ENVIRONMENT_VARIABLES) child[name] = "";
  for (const [name, value] of Object.entries(child)) {
    if (aliasesControl(name, value)) child[name] = "";
  }
  if (route !== undefined) assertWorkflowDataRoute(route, { ...source, ...child }, source);
  return child;
}

function providerCredentialEnvironmentVariables(source: Record<string, string | undefined>): string[] {
  const names = new Set<string>(configuredProviderCredentialEnvironmentVariables(source));
  for (const name of sensitiveAgentEnvironmentVariableNames(source)) names.add(name);
  return [...names].sort();
}

function configuredProviderCredentialEnvironmentVariables(source: Record<string, string | undefined>): string[] {
  const names = new Set<string>(BUILT_IN_PROVIDER_CREDENTIAL_ENVIRONMENT_VARIABLES);
  for (const name of (source.ULTRAFUZZ_PROVIDER_CREDENTIAL_ENV_NAMES ?? "").split(",")) {
    const trimmed = name.trim();
    if (trimmed.length === 0) continue;
    if (!ENVIRONMENT_VARIABLE_PATTERN.test(trimmed)) {
      throw new Error("controller provider credential environment list is invalid");
    }
    names.add(trimmed);
  }
  const normalized = new Set([...names].map((name) => name.toUpperCase()));
  for (const name of Object.keys(source)) {
    if (normalized.has(name.toUpperCase())) names.add(name);
  }
  return [...names].sort();
}

function allowlistedEnvironmentVariables(
  source: Record<string, string | undefined>
): Array<{ name: string; upper: string }> {
  const variables = new Map<string, { name: string; upper: string }>();
  for (const name of (source.ULTRAFUZZ_AGENT_ENV_ALLOWLIST ?? "").split(",")) {
    const trimmed = name.trim();
    if (trimmed.length === 0) continue;
    if (!ENVIRONMENT_VARIABLE_PATTERN.test(trimmed)) {
      throw new Error("controller agent environment allowlist is invalid");
    }
    const upper = trimmed.toUpperCase();
    if (!variables.has(upper)) variables.set(upper, { name: trimmed, upper });
  }
  return [...variables.values()];
}

function sensitiveAgentEnvironmentVariableNames(source: Record<string, string | undefined>): string[] {
  const names = new Set<string>();
  for (const name of (source.ULTRAFUZZ_SENSITIVE_AGENT_ENV_NAMES ?? "").split(",")) {
    const trimmed = name.trim();
    if (trimmed.length === 0) continue;
    if (!ENVIRONMENT_VARIABLE_PATTERN.test(trimmed)) {
      throw new Error("controller sensitive agent environment list is invalid");
    }
    addLogicalEnvironmentVariableNames(names, source, trimmed);
  }
  for (const { name, upper } of allowlistedEnvironmentVariables(source)) {
    if (!isCredentialLikeEnvironmentVariableName(upper)) continue;
    addLogicalEnvironmentVariableNames(names, source, name);
  }
  return [...names].sort();
}

function addLogicalEnvironmentVariableNames(
  names: Set<string>,
  source: Record<string, string | undefined>,
  name: string
): void {
  const upper = name.toUpperCase();
  names.add(name);
  names.add(upper);
  for (const sourceName of Object.keys(source)) {
    if (sourceName.toUpperCase() === upper) names.add(sourceName);
  }
}

function restoreRouteScopedAllowlistedCredentials(
  child: Record<string, string>,
  source: Record<string, string | undefined>,
  agent: WorkflowRouteAgent
): void {
  const configuredCredentials = new Set(
    configuredProviderCredentialEnvironmentVariables(source).map((name) => name.toUpperCase())
  );
  const sensitiveNames = new Set(sensitiveAgentEnvironmentVariableNames(source));
  for (const variable of allowlistedEnvironmentVariables(source)) {
    if (![variable.name, variable.upper].some((name) => sensitiveNames.has(name))) continue;
    if (!routeOwnsCredentialLikeEnvironmentVariable(agent, variable.upper)) continue;
    if (configuredCredentials.has(variable.upper)) continue;
    for (const name of Object.keys(source)) {
      if (name.toUpperCase() !== variable.upper) continue;
      const value = source[name];
      if (value !== undefined) child[name] = value;
    }
  }
}

function assertWorkflowDataRoute(
  route: WorkflowDataRoute,
  effectiveEnvironment: Record<string, string | undefined>,
  authorityEnvironment: Record<string, string | undefined>
): void {
  const governancePath = authorityEnvironment.ULTRAFUZZ_DATA_GOVERNANCE_PATH?.trim();
  if (!governancePath) {
    if (authorityEnvironment.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH)
      throw new Error("sealed workflow is missing data-governance authority");
    return;
  }
  if (!path.isAbsolute(governancePath)) throw new Error("sealed data-governance path must be absolute");
  const governance = parseStrictJsonBytes(readRegularFileSnapshot(governancePath, 1024 * 1024), {
    maxBytes: 1024 * 1024,
    maxDepth: 32,
    maxItems: 4096,
    maxProperties: 4096
  });
  const record = governance !== null && typeof governance === "object" && !Array.isArray(governance) ? governance : {},
    required = (record as { required_source_destinations?: unknown }).required_source_destinations;
  if (!Array.isArray(required) || required.some((entry) => typeof entry !== "string"))
    throw new Error("sealed data-governance authority is invalid");
  const configPath =
    route.configDir === undefined || route.agent === "OpenRouterAgent"
      ? undefined
      : path.join(route.configDir, route.agent === "ClaudeAgent" ? "settings.json" : "config.toml");
  const effective = providerRouteDestination(
    route.agent,
    {
      ...effectiveEnvironment,
      ULTRAFUZZ_AGENT_ENV_ALLOWLIST: authorityEnvironment.ULTRAFUZZ_AGENT_ENV_ALLOWLIST,
      // The Codex adapter derives OPENAI_BASE_URL from the provider config,
      // which the config part of the route already covers.
      ...(route.agent === "CodexAgent" && !authorityEnvironment.OPENAI_BASE_URL?.trim()
        ? { OPENAI_BASE_URL: undefined }
        : {})
    },
    configPath !== undefined && existsSync(configPath) ? readRegularFileSnapshot(configPath, 1024 * 1024) : undefined
  );
  if (!required.includes(effective))
    throw new Error(`effective ${route.agent} provider route changed after disclosure acknowledgement`);
}

export function workflowControlCredentialValue(
  value: string,
  name: string,
  source: Record<string, string | undefined> = process.env
): string {
  const roots = workflowExecutionSnapshotRoots(source);
  if (roots.some((root) => environmentPath(value).includes(root))) {
    throw new Error(`workflow credential ${name} resolves inside controller-only execution state`);
  }
  return value;
}

/**
 * The sealed execution snapshot this process runs from, under every name the
 * process anchor advertises for it. A native continuation runs the target's
 * own workflow and advertises none: treating that project as controller-only
 * state would blank every adapter-owned path under it, such as OpenCode's
 * run-scoped XDG roots and Kimi's API-key home.
 */
function workflowExecutionSnapshotRoots(source: Record<string, string | undefined>): string[] {
  const roots = new Set<string>();
  for (const name of [
    "ULTRAFUZZ_SNAPSHOT_PERSISTED_ROOT",
    "ULTRAFUZZ_SNAPSHOT_PROCESS_ROOT",
    "ULTRAFUZZ_SNAPSHOT_SOURCE_ROOT"
  ]) {
    const root = source[name]?.trim();
    if (root && path.isAbsolute(root) && root !== path.parse(root).root) roots.add(root);
  }
  return [...roots];
}

function environmentPath(value: string): string {
  if (!value.startsWith("file:")) return value;
  try {
    return fileURLToPath(value);
  } catch {
    return value;
  }
}
