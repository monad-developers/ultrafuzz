import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTROLLER_ONLY_ENVIRONMENT_VARIABLES = [
  "SMITHERS_BIN",
  "SMITHERS_CLI_SRC_DIR",
  "ULTRAFUZZ_ARTIFACTS_MODULE",
  "ULTRAFUZZ_CONFIG_PATH",
  "ULTRAFUZZ_MODAL_MODULE",
  "ULTRAFUZZ_PROVIDER_CREDENTIAL_ENV_NAMES",
  "ULTRAFUZZ_PROVIDER_HOME_ROOT",
  "ULTRAFUZZ_RUNTIME_MODULE",
  "ULTRAFUZZ_SCHEMA_BUNDLE_SHA256",
  "ULTRAFUZZ_TRUSTED_BIN",
  "ULTRAFUZZ_VALIDATOR_BUILD",
  "ULTRAFUZZ_SNAPSHOT_INHERITED_DESCRIPTOR",
  "ULTRAFUZZ_SNAPSHOT_PERSISTED_ROOT",
  "ULTRAFUZZ_SNAPSHOT_PROCESS_DESCRIPTOR",
  "ULTRAFUZZ_SNAPSHOT_PROCESS_ROOT",
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

/**
 * Smithers agents inherit the controller environment by default. Remove every
 * controller-only capability, including aliases that name the descriptor-held
 * execution tree, before an untrusted model process is spawned.
 */
export function workflowControlChildEnvironment(
  additions: Record<string, string | undefined> = {},
  source: Record<string, string | undefined> = process.env
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
  for (const name of CONTROLLER_ONLY_ENVIRONMENT_VARIABLES) child[name] = "";
  for (const [name, value] of Object.entries(child)) {
    if (roots.some((root) => environmentPath(value).includes(root))) child[name] = "";
  }
  return child;
}

function providerCredentialEnvironmentVariables(source: Record<string, string | undefined>): string[] {
  const names = new Set<string>(BUILT_IN_PROVIDER_CREDENTIAL_ENVIRONMENT_VARIABLES);
  for (const name of (source.ULTRAFUZZ_PROVIDER_CREDENTIAL_ENV_NAMES ?? "").split(",")) {
    const trimmed = name.trim();
    if (trimmed.length === 0) continue;
    if (!ENVIRONMENT_VARIABLE_PATTERN.test(trimmed)) {
      throw new Error("controller provider credential environment list is invalid");
    }
    names.add(trimmed);
  }
  return [...names].sort();
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
