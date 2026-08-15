import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SAFE_PROVIDER_HOME_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const CANONICAL_PROVIDER_HOMES: Readonly<Record<string, { environment: readonly string[]; relative: string }>> = {
  claude: { environment: ["CLAUDE_CONFIG_DIR"], relative: ".claude" },
  codex: { environment: ["CODEX_HOME"], relative: ".codex" },
  kimi: { environment: ["KIMI_CODE_HOME", "KIMI_SHARE_DIR"], relative: ".kimi-code" }
};

/**
 * Resolve repository-selected provider state only beneath an operator-owned
 * Ultrafuzz root. The repository may choose a relative child, never a host
 * absolute path, traversal, or symlink escape.
 */
export function resolveProviderHome(provider: string, configured?: string): string {
  const configuredRoot = process.env.ULTRAFUZZ_PROVIDER_HOME_ROOT?.trim();
  if (configured === undefined && (configuredRoot === undefined || configuredRoot.length === 0)) {
    const canonical = CANONICAL_PROVIDER_HOMES[provider];
    if (canonical !== undefined) {
      const operatorSelected = canonical.environment
        .map((name) => process.env[name]?.trim())
        .find((value): value is string => value !== undefined && value.length > 0);
      return prepareProviderHome(operatorSelected ?? path.join(os.homedir(), canonical.relative));
    }
  }

  const relative = configured ?? provider;
  const components = relative.split("/");
  if (
    relative.length === 0 ||
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    components.some(
      (component) => component === "." || component === ".." || !SAFE_PROVIDER_HOME_COMPONENT.test(component)
    )
  ) {
    throw new Error("agent config_dir must be a safe relative path beneath the Ultrafuzz provider-home root");
  }
  const stateRoot =
    configuredRoot && configuredRoot.length > 0
      ? configuredRoot
      : path.join(
          process.env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), ".local", "state"),
          "ultrafuzz",
          "provider-homes"
        );
  if (!path.isAbsolute(stateRoot)) {
    throw new Error("ULTRAFUZZ_PROVIDER_HOME_ROOT must be an absolute operator-owned path");
  }
  const physicalRoot = prepareProviderHome(stateRoot);
  const resolved = path.join(physicalRoot, ...components);
  const relativeToRoot = path.relative(physicalRoot, resolved);
  if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
    throw new Error("agent config_dir escapes the Ultrafuzz provider-home root");
  }
  return prepareProviderHome(resolved);
}

function prepareProviderHome(candidate: string): string {
  if (!path.isAbsolute(candidate)) {
    throw new Error("operator-owned provider-home paths must be absolute");
  }
  const lexical = path.resolve(candidate);
  let current = path.parse(lexical).root;
  for (const component of lexical.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const existing = lstatSync(current);
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw new Error("operator-owned provider home crosses a non-directory or symbolic-link component");
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      mkdirSync(current, { mode: 0o700 });
      const created = lstatSync(current);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error("operator-owned provider home changed while it was created");
      }
    }
  }
  const rootStat = lstatSync(lexical);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("operator-owned provider home must be a physical directory");
  }
  const physical = realpathSync(lexical);
  if (physical !== lexical) {
    throw new Error("operator-owned provider home cannot cross symbolic links");
  }
  return physical;
}
