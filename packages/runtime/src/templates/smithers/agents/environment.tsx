import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseStrictJsonBytes, readRegularFileSnapshot } from "./strict-json";

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
  "ULTRAFUZZ_PROVIDER_HOME_ROOT",
  "ULTRAFUZZ_MODAL_MODULE",
  "ULTRAFUZZ_RUNTIME_MODULE",
  "ULTRAFUZZ_SCHEMA_BUNDLE_SHA256",
  "ULTRAFUZZ_TRUSTED_BIN",
  "ULTRAFUZZ_VALIDATOR_BUILD",
  "ULTRAFUZZ_SNAPSHOT_INHERITED_DESCRIPTOR",
  "ULTRAFUZZ_SNAPSHOT_PERSISTED_ROOT",
  "ULTRAFUZZ_SNAPSHOT_PROCESS_DESCRIPTOR",
  "ULTRAFUZZ_SNAPSHOT_PROCESS_ROOT",
  "ULTRAFUZZ_SNAPSHOT_SOURCE_ROOT",
  "ULTRAFUZZ_WORKFLOW_PERSISTED_PATH"
] as const;

type WorkflowRouteAgent = "ClaudeAgent" | "CodexAgent" | "DeepSeekAgent" | "KimiAgent" | "OpenRouterAgent";
type WorkflowDataRoute = { agent: WorkflowRouteAgent; configDir?: string };
const ROUTE_ENV_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  ClaudeAgent: ["ANTHROPIC_", "CLAUDE_CODE_USE_", "AWS_", "AZURE_", "CLOUD_ML_", "FOUNDRY_", "GOOGLE_"],
  CodexAgent: ["AZURE_OPENAI_", "OPENAI_"],
  KimiAgent: ["KIMI_", "MOONSHOT_"]
};
const ROUTE_ENV_SECRET = /(?:API_?KEY|AUTH|CREDENTIAL|PASSWORD|SECRET|TOKEN)/u;
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
    CONTROLLER_ONLY_ENVIRONMENT_VARIABLES.map((name) => [name, ""])
  );
  const roots = workflowExecutionSnapshotRoots(source);
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && roots.some((root) => environmentPath(value).includes(root))) child[name] = "";
  }
  for (const [name, value] of Object.entries(additions)) {
    if (value !== undefined) child[name] = value;
  }
  for (const name of CONTROLLER_ONLY_ENVIRONMENT_VARIABLES) child[name] = "";
  for (const [name, value] of Object.entries(child)) {
    if (roots.some((root) => environmentPath(value).includes(root))) child[name] = "";
  }
  if (route !== undefined) assertWorkflowDataRoute(route, { ...source, ...child }, source);
  return child;
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
      if (route.agent !== "ClaudeAgent" || claudeSettingsAffectRoute(bytes)) configDigest = sha256(bytes);
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
      (!ROUTE_ENV_SECRET.test(upper) && ROUTE_ENV_PREFIXES.ClaudeAgent!.some((prefix) => upper.startsWith(prefix)))
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
    if (!ROUTE_ENV_SECRET.test(name) && ROUTE_ENV_PREFIXES[agent]?.some((prefix) => name.startsWith(prefix)))
      names.add(name);
  if (agent === "CodexAgent") names.add("OPENAI_BASE_URL");
  if (agent === "KimiAgent") names.add("KIMI_BASE_URL");
  names.delete("KIMI_CODE_HOME");
  names.delete("KIMI_SHARE_DIR");
  return [...names].sort().flatMap((name): Array<[string, string]> => {
    const value = env[name];
    return value !== undefined &&
      value.trim() !== "" &&
      !ROUTE_ENV_SECRET.test(name) &&
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
