import fs from "node:fs";
import path from "node:path";

import type { ResolvedConfig } from "@ultrafuzz/config";

import type { RuntimeDiagnostic } from "./types.js";

/**
 * Each agent adapter's provider-home rules, as the generated adapters apply them
 * (`templates/smithers/agents/provider-home.tsx`, `resolveProviderHome`). Keep the two in step: this
 * module only predicts which directory the adapter will use, so that launch can refuse it up front.
 */
const PROVIDER_HOMES: Readonly<Record<string, { provider: string; env?: readonly string[]; relative?: string }>> = {
  ClaudeAgent: { provider: "claude", env: ["CLAUDE_CONFIG_DIR"], relative: ".claude" },
  CodexAgent: { provider: "codex", env: ["CODEX_HOME"], relative: ".codex" },
  KimiAgent: { provider: "kimi", env: ["KIMI_CODE_HOME", "KIMI_SHARE_DIR"], relative: ".kimi-code" },
  DeepSeekAgent: { provider: "deepseek" }
};

export interface ProviderHomeProblem {
  agentRef: string;
  /** The provider home the adapter will use. */
  home: string;
  /** The directory that fails, the home itself or one of its ancestors. */
  directory: string;
  reason: string;
  /** `doctor --fix` can tighten it: the provider home itself, a real directory the operator owns. */
  fixable: boolean;
}

interface ProviderHomeLayout {
  home: string;
  /** The provider-home root, when the home is below one; the adapters require it to be private too. */
  root?: string;
  /** A root the adapters reject outright. */
  invalidRoot?: string;
}

function providerHomeLayout(
  agentRef: string,
  config: ResolvedConfig,
  env: Record<string, string | undefined>
): ProviderHomeLayout | undefined {
  const rules = PROVIDER_HOMES[agentRef];
  const home = env.HOME?.trim();
  if (rules === undefined || !home) return undefined;
  const configDir = config.agents[agentRef]?.configDir;
  const selectedRoot = env.ULTRAFUZZ_PROVIDER_HOME_ROOT?.trim();
  if (configDir === undefined && !selectedRoot && rules.relative !== undefined) {
    const envHome = (rules.env ?? []).map((name) => env[name]?.trim()).find(Boolean);
    return { home: path.resolve(envHome ?? path.join(home, rules.relative)) };
  }
  const root = selectedRoot || path.join(home, ".ultrafuzz-provider-homes");
  const layout = {
    home: path.resolve(root, rules.provider, ...(configDir === undefined ? [] : configDir.split("/"))),
    root: path.resolve(root)
  };
  return path.isAbsolute(root) ? layout : { ...layout, invalidRoot: root };
}

/**
 * The directory an agent adapter will use as its provider home, or undefined for an agent without
 * one. It is resolved from the launch environment's `HOME`, as the engine sees it, and is undefined
 * without one, as in tests that launch with an empty environment.
 */
export function predictedProviderHome(
  agentRef: string,
  config: ResolvedConfig,
  env: Record<string, string | undefined>
): string | undefined {
  return providerHomeLayout(agentRef, config, env)?.home;
}

/**
 * The provider-home directories the adapters would refuse, checked as `prepareProviderHome` checks
 * them: every existing component must be a real directory that is not group- or world-writable
 * (unless sticky), and the provider-home root and the home itself must be the operator's own with
 * mode 0700. A component that does not exist yet is fine, because the adapter creates it with mode
 * 0700; any other failure to inspect one is not.
 */
export function providerHomeProblems(
  agentRefs: readonly string[],
  config: ResolvedConfig,
  env: Record<string, string | undefined>
): ProviderHomeProblem[] {
  const problems: ProviderHomeProblem[] = [];
  const checked = new Set<string>();
  for (const agentRef of [...new Set(agentRefs)].sort()) {
    const layout = providerHomeLayout(agentRef, config, env);
    if (layout === undefined || checked.has(layout.home)) continue;
    checked.add(layout.home);
    if (layout.invalidRoot !== undefined) {
      problems.push({
        agentRef,
        home: layout.home,
        directory: layout.invalidRoot,
        reason: "is not an absolute path, which ULTRAFUZZ_PROVIDER_HOME_ROOT must be",
        fixable: false
      });
      continue;
    }
    const problem = directoryProblem(
      layout.home,
      new Set([layout.home, ...(layout.root === undefined ? [] : [layout.root])])
    );
    if (problem !== undefined) problems.push({ agentRef, home: layout.home, ...problem });
  }
  return problems;
}

function directoryProblem(
  home: string,
  privateDirectories: ReadonlySet<string>
): Omit<ProviderHomeProblem, "agentRef" | "home"> | undefined {
  let current = path.parse(home).root;
  for (const component of home.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      // The adapter creates a missing directory, and fails on anything else it cannot inspect.
      const code = error instanceof Error && "code" in error ? String(error.code) : "unknown error";
      return code === "ENOENT"
        ? undefined
        : { directory: current, reason: `could not be inspected (${code})`, fixable: false };
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return { directory: current, reason: "is not a real directory", fixable: false };
    }
    const mode = stat.mode & 0o777;
    const owned = typeof process.getuid !== "function" || stat.uid === process.getuid();
    if (privateDirectories.has(current) && (mode !== 0o700 || !owned)) {
      return {
        directory: current,
        reason: owned ? `has mode ${mode.toString(8)}` : "is owned by another user",
        fixable: owned
      };
    }
    if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) {
      return { directory: current, reason: `is group- or world-writable (mode ${mode.toString(8)})`, fixable: false };
    }
  }
  return undefined;
}

/** One error per refused provider home, naming the directory and how to fix it. */
export function providerHomeDiagnostics(problems: readonly ProviderHomeProblem[]): RuntimeDiagnostic[] {
  return problems.map((problem) => ({
    code: "PROVIDER_HOME_UNSAFE",
    message:
      `${problem.agentRef} would use ${problem.home} as its provider home, but ${problem.directory} ${problem.reason}; ` +
      "agents refuse a provider home that is not a private directory you own (mode 0700) under directories only you can write, " +
      (problem.fixable
        ? `so run \`ultrafuzz doctor --fix\` or \`chmod 700 ${problem.directory}\``
        : `so fix ${problem.directory} yourself, or set ULTRAFUZZ_PROVIDER_HOME_ROOT to a private directory`),
    severity: "error",
    source: "agents",
    path: problem.directory
  }));
}

/**
 * Tighten each fixable directory to 0700. The directory is opened without following a link and
 * changed through that descriptor, and only if it is still the directory that was checked, so a
 * directory swapped in after the check is never changed.
 */
export function fixProviderHomes(problems: readonly ProviderHomeProblem[]): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  for (const problem of problems) {
    if (!problem.fixable) continue;
    let descriptor: number | undefined;
    try {
      const before = fs.lstatSync(problem.directory);
      if (before.isSymbolicLink() || !before.isDirectory()) continue;
      descriptor = fs.openSync(
        problem.directory,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
      );
      const opened = fs.fstatSync(descriptor);
      const owned = typeof process.getuid !== "function" || opened.uid === process.getuid();
      if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino || !owned) continue;
      fs.fchmodSync(descriptor, 0o700);
      diagnostics.push({
        code: "PROVIDER_HOME_FIXED",
        message: `tightened ${problem.directory} from mode ${(opened.mode & 0o777).toString(8)} to 700 for ${problem.agentRef}`,
        severity: "info",
        source: "doctor",
        path: problem.directory
      });
    } catch (error) {
      diagnostics.push({
        code: "PROVIDER_HOME_FIX_FAILED",
        message: `could not tighten ${problem.directory}: ${error instanceof Error ? error.message : String(error)}`,
        severity: "warning",
        source: "doctor",
        path: problem.directory
      });
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }
  return diagnostics;
}
