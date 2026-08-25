import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseStrictJsonBytes, readRegularFileSnapshot } from "./strict-json";

export const PROVIDER_SCOPED_SENSITIVE_ENVIRONMENT_CAPABILITY =
  "ultrafuzz.provider-scoped-sensitive-environment.v1" as const;

const CONTROLLER_ONLY_ENVIRONMENT_VARIABLES = [
  "SMITHERS_BIN",
  "SMITHERS_CLI_SRC_DIR",
  "ULTRAFUZZ_AGENT_ENV_ALLOWLIST",
  "ULTRAFUZZ_ARTIFACTS_MODULE",
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
const ROUTE_ENV_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  ClaudeAgent: ["ANTHROPIC_", "CLAUDE_CODE_USE_", "AWS_", "AZURE_", "CLOUD_ML_", "FOUNDRY_", "GOOGLE_"],
  CodexAgent: ["AZURE_OPENAI_", "OPENAI_"],
  KimiAgent: ["KIMI_", "MOONSHOT_"]
};
const NON_ROUTING_PROVIDER_ENVIRONMENT_NAMES = new Set(["AZURE_EXTENSION_DIR"]);
// Keep this generated, dependency-free boundary in parity with
// @ultrafuzz/security's isSensitiveEnvironmentName contract.
const SENSITIVE_ENVIRONMENT_NAME_PATTERN =
  /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_?KEY|ACCESS_?KEY|CLIENT_?SECRET|CREDENTIALS?|AUTH(?:ORIZATION)?)(?:_|$)/iu;
const ROUTE_PROXY_ENV = [
  "ALL_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy"
] as const;

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
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && roots.some((root) => environmentPath(value).includes(root))) child[name] = "";
  }
  for (const [name, value] of Object.entries(additions)) {
    if (value !== undefined) child[name] = value;
  }
  if (route !== undefined) restoreRouteScopedAllowlistedCredentials(child, source, route.agent);
  for (const name of CONTROLLER_ONLY_ENVIRONMENT_VARIABLES) child[name] = "";
  for (const [name, value] of Object.entries(child)) {
    if (roots.some((root) => environmentPath(value).includes(root))) child[name] = "";
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

function isCredentialLikeEnvironmentVariableName(name: string): boolean {
  return SENSITIVE_ENVIRONMENT_NAME_PATTERN.test(name);
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

function routeOwnsCredentialLikeEnvironmentVariable(agent: WorkflowRouteAgent, name: string): boolean {
  const upper = name.toUpperCase();
  let longestPrefix = -1;
  const owners = new Set<string>();
  for (const [candidate, prefixes] of Object.entries(ROUTE_ENV_PREFIXES)) {
    for (const prefix of prefixes) {
      if (!upper.startsWith(prefix) || prefix.length < longestPrefix) continue;
      if (prefix.length > longestPrefix) {
        longestPrefix = prefix.length;
        owners.clear();
      }
      owners.add(candidate);
    }
  }
  return owners.has(agent);
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
  const effective = effectiveWorkflowDataRoute(route, effectiveEnvironment, authorityEnvironment);
  if (!required.includes(effective))
    throw new Error(`effective ${route.agent} provider route changed after disclosure acknowledgement`);
}

function effectiveWorkflowDataRoute(
  route: WorkflowDataRoute,
  source: Record<string, string | undefined>,
  authority: Record<string, string | undefined>
): string {
  const routeSource = { ...source, ULTRAFUZZ_AGENT_ENV_ALLOWLIST: authority.ULTRAFUZZ_AGENT_ENV_ALLOWLIST },
    routeEnvironment = effectiveRouteEnvironment(
      route.agent,
      route.agent === "CodexAgent" && !authority.OPENAI_BASE_URL?.trim()
        ? { ...routeSource, OPENAI_BASE_URL: undefined }
        : routeSource
    );
  let configDigest: string | undefined;
  if (route.configDir !== undefined && route.agent !== "OpenRouterAgent") {
    const configPath = path.join(route.configDir, route.agent === "ClaudeAgent" ? "settings.json" : "config.toml");
    if (existsSync(configPath)) {
      const bytes = readRegularFileSnapshot(configPath, 1024 * 1024);
      const affectsRoute =
        route.agent === "ClaudeAgent"
          ? claudeSettingsAffectRoute(bytes)
          : route.agent !== "CodexAgent" || codexConfigAffectsRoute(bytes.toString("utf8"));
      if (affectsRoute) configDigest = sha256(bytes);
    }
  }
  const digest =
      routeEnvironment.length > 0
        ? sha256(JSON.stringify({ agent: route.agent, config: configDigest ?? null, route: routeEnvironment }))
        : configDigest,
    provider = {
      ClaudeAgent: "anthropic",
      CodexAgent: "openai",
      DeepSeekAgent: "deepseek",
      KimiAgent: "moonshot",
      OpenRouterAgent: "openrouter"
    }[route.agent];
  return digest === undefined
    ? `model:${provider}`
    : `model:${route.agent.toLowerCase().replace("agent", "")}-route-${digest}`;
}

/**
 * The Codex CLI rewrites its own config.toml on invocation — marketplace
 * `last_updated` timestamps, plugin toggles, and project trust levels — so
 * digesting the whole file makes the acknowledged route change the moment the
 * CLI first runs in a fresh HOME, which failed every sandbox agent task after
 * disclosure (#908). Keep this generated copy in exact parity with
 * @ultrafuzz/runtime data-governance.ts: only content that can actually
 * redirect traffic — a `model_provider` selection, a `[model_providers…]`
 * table, or a `base_url` assignment — participates in the route digest.
 */
function codexConfigAffectsRoute(text: string): boolean {
  return (
    /(?:^|\n)\s*(?:model_provider|"model_provider"|'model_provider')\s*=/u.test(text) ||
    /(?:^|\n)\s*\[[^\]\n]*model_providers[^\]\n]*\]/u.test(text) ||
    /(?:^|\n)\s*(?:base_url|"base_url"|'base_url')\s*=/u.test(text)
  );
}

function claudeSettingsAffectRoute(bytes: Buffer): boolean {
  const parsed = parseStrictJsonBytes(bytes, {
    maxBytes: 1024 * 1024,
    maxDepth: 32,
    maxItems: 4096,
    maxProperties: 4096
  });
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Claude settings must be a JSON object");
  if (Object.keys(parsed).some((name) => /(?:helper|refresh|credentialexport|processwrapper|proxyauth)$/iu.test(name)))
    return true;
  const configuredEnv = (parsed as Record<string, unknown>).env;
  if (configuredEnv === undefined) return false;
  if (configuredEnv === null || typeof configuredEnv !== "object" || Array.isArray(configuredEnv))
    throw new Error("Claude settings env must be a JSON object");
  return Object.keys(configuredEnv).some((name) => {
    const upper = name.toUpperCase();
    return (
      ["ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"].includes(upper) ||
      (!NON_ROUTING_PROVIDER_ENVIRONMENT_NAMES.has(upper) &&
        !isCredentialLikeEnvironmentVariableName(upper) &&
        ROUTE_ENV_PREFIXES.ClaudeAgent!.some((prefix) => upper.startsWith(prefix)))
    );
  });
}

function effectiveRouteEnvironment(
  agent: WorkflowRouteAgent,
  env: Record<string, string | undefined>
): Array<[string, string]> {
  const names = new Set(
    (env.ULTRAFUZZ_AGENT_ENV_ALLOWLIST ?? "").split(",").map((entry) => entry.trim().toUpperCase())
  );
  for (const name of ROUTE_PROXY_ENV) names.add(name);
  for (const name of Object.keys(env))
    if (
      !isCredentialLikeEnvironmentVariableName(name) &&
      ROUTE_ENV_PREFIXES[agent]?.some((prefix) => name.startsWith(prefix))
    )
      names.add(name);
  if (agent === "CodexAgent") names.add("OPENAI_BASE_URL");
  if (agent === "KimiAgent") names.add("KIMI_BASE_URL");
  for (const name of NON_ROUTING_PROVIDER_ENVIRONMENT_NAMES) names.delete(name);
  names.delete("KIMI_CODE_HOME");
  names.delete("KIMI_SHARE_DIR");
  return [...names].sort().flatMap((name): Array<[string, string]> => {
    const value = env[name];
    return value !== undefined &&
      value.trim() !== "" &&
      !isCredentialLikeEnvironmentVariableName(name) &&
      (ROUTE_PROXY_ENV.includes(name as never) || ROUTE_ENV_PREFIXES[agent]?.some((prefix) => name.startsWith(prefix)))
      ? [[name, value]]
      : [];
  });
}

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

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

function workflowExecutionSnapshotRoots(source: Record<string, string | undefined>): string[] {
  const roots = new Set<string>();
  const persistedWorkflow = source.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH;
  if (persistedWorkflow !== undefined && path.isAbsolute(persistedWorkflow)) {
    const workflowsDirectory = path.dirname(persistedWorkflow);
    const smithersDirectory = path.dirname(workflowsDirectory);
    if (path.basename(workflowsDirectory) === "workflows" && path.basename(smithersDirectory) === ".smithers") {
      roots.add(path.dirname(smithersDirectory));
    }
  }
  for (const name of CONTROLLER_ONLY_ENVIRONMENT_VARIABLES) {
    const value = source[name];
    if (value === undefined) continue;
    const candidate = environmentPath(value);
    for (const marker of ["/dependencies/", "/modules/", "/controls/", "/.smithers/workflows/"]) {
      const index = candidate.indexOf(marker);
      if (index > 0) roots.add(candidate.slice(0, index));
    }
  }
  return [...roots].filter((root) => root !== path.parse(root).root);
}

function environmentPath(value: string): string {
  if (!value.startsWith("file:")) return value;
  try {
    return fileURLToPath(value);
  } catch {
    return value;
  }
}
