import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTROLLER_ONLY_ENVIRONMENT_VARIABLES = [
  "SMITHERS_BIN",
  "SMITHERS_CLI_SRC_DIR",
  "ULTRAFUZZ_ARTIFACTS_MODULE",
  "ULTRAFUZZ_CONFIG_PATH",
  "ULTRAFUZZ_MODAL_MODULE",
  "ULTRAFUZZ_RUNTIME_MODULE",
  "ULTRAFUZZ_WORKFLOW_PERSISTED_PATH"
] as const;

/**
 * Smithers CLI agents inherit their controller's environment by default.
 * Blank every known controller capability and any other value that names the
 * same lexical or descriptor-anchored snapshot root before spawning an
 * untrusted agent process.
 */
export function workflowControlChildEnvironment(
  source: Record<string, string | undefined> = process.env
): Record<string, string> {
  const child: Record<string, string> = Object.fromEntries(
    CONTROLLER_ONLY_ENVIRONMENT_VARIABLES.map((name) => [name, ""])
  );
  const roots = workflowExecutionSnapshotRoots(source);
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && roots.some((root) => environmentPath(value).includes(root))) child[name] = "";
  }
  return child;
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
