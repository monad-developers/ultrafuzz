import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { referencesStatus } from "./references.js";
import { inspectSmithersInstallation } from "./smithers.js";
import { SMITHERS_PACKAGE_NAME, SMITHERS_VERSION } from "./smithers-package.js";
import type {
  DoctorCheck,
  DoctorCheckStatus,
  DoctorInput,
  DoctorValue,
  RuntimeDiagnostic,
  ValidateProjectResult
} from "./types.js";
import { runtimeResult } from "./utils.js";
import { activeTopologyAgentRefs, loadResolvedProject, validateProject } from "./validate.js";
import { probeCommandsForExecution } from "./required-commands.js";

const execFileAsync = promisify(execFile);

const REGISTRY_LOOKUP_TIMEOUT_MS = 10_000;

/** Linux `statfs` filesystem type of a tmpfs mount (`TMPFS_MAGIC`). */
const TMPFS_MAGIC = 0x01021994;

const MIN_TEMPORARY_DIRECTORY_FREE_BYTES = 2 * 1024 ** 3;

/** Local commands every run needs regardless of which agent backend is selected. */
const REQUIRED_TOOLCHAIN_COMMANDS = ["git", "node", "forge"] as const;

/** Agent references map to the CLI each Smithers agent class shells out to. */
const AGENT_EXECUTABLES: Record<string, string> = {
  ClaudeAgent: "claude",
  CodexAgent: "codex",
  DeepSeekAgent: "claude",
  KimiAgent: "kimi",
  OpenCodeAgent: "opencode",
  OpenRouterAgent: "codex",
  PiAgent: "pi"
};

/**
 * Operational superset of `validate`: reports configuration posture plus the
 * local toolchain and pinned workflow-engine install posture. It never changes
 * project or run state and never installs, upgrades, or repairs dependencies.
 * Cloud toolchain checks may create the configured provider app on first use
 * and always use a transient sandbox so they inspect the launch image itself.
 */
export async function diagnoseProject(input: DoctorInput) {
  const projectRoot = path.resolve(input.projectRoot);
  const env = input.env ?? process.env;
  const validation = await validateProject({ projectRoot, env, topologyPath: input.topologyPath });
  const resolved = await loadResolvedProject({ projectRoot, env });
  const references = referencesStatus({ projectRoot });
  const installation = inspectSmithersInstallation(projectRoot);
  const latest = input.offline === true ? undefined : await latestPublishedSmithersVersion(projectRoot, env);

  const checks: DoctorCheck[] = [];
  const diagnostics: RuntimeDiagnostic[] = [];

  const validationStatus = doctorStatus(validation.ok, hasWarnings(validation.diagnostics));
  checks.push({
    name: "validate",
    status: validationStatus,
    summary: validation.ok
      ? "config, topology, prompts, paths, agents, and trust posture pass"
      : "configuration validation reported errors; run ultrafuzz validate for detail"
  });
  diagnostics.push(...validation.diagnostics);

  // The agents the selected topology can dispatch to, including retry fallbacks.
  const selectedAgentRefs =
    resolved.config === undefined ? [] : activeTopologyAgentRefs(projectRoot, resolved.config, input.topologyPath);
  const openRouterSelected = selectedAgentRefs.includes("OpenRouterAgent");
  const openRouterCredential = openRouterSelected ? resolved.config?.agents.OpenRouterAgent?.apiKeyEnv : undefined;
  const openRouterCredentialReady =
    !openRouterSelected || (openRouterCredential !== undefined && (env[openRouterCredential] ?? "").trim() !== "");
  checks.push({
    name: "agent-credentials",
    status: openRouterCredentialReady ? "ok" : "error",
    summary: openRouterCredentialReady
      ? "selected agent credential posture passes"
      : "the selected OpenRouter agent API-key environment variable is not set"
  });
  if (!openRouterCredentialReady) {
    diagnostics.push({
      code: "DOCTOR_AGENT_CREDENTIAL_MISSING",
      message: `OpenRouterAgent requires ${openRouterCredential} to be set`,
      severity: "error",
      source: "doctor",
      path: "agents.OpenRouterAgent.api_key_env"
    });
  }

  checks.push({
    name: "references",
    status: references.ok ? "ok" : "error",
    summary: references.ok
      ? `${references.value?.references.length ?? 0} pinned references present in the local cache`
      : "pinned references are missing from the local cache; run ultrafuzz references sync"
  });
  diagnostics.push(...references.diagnostics);

  const requiredByName = new Map<string, boolean>();
  for (const name of [...REQUIRED_TOOLCHAIN_COMMANDS, ...(validation.value?.topology?.required_commands ?? [])]) {
    requiredByName.set(name, true);
  }
  for (const agentRef of configuredAgentRefs(resolved.config?.models.profiles)) {
    // Every configured agent's CLI is reported, but only a selected agent's
    // known CLI is required. Agents can share a CLI, so any requirer wins.
    const name = AGENT_EXECUTABLES[agentRef] ?? agentRef;
    const required = AGENT_EXECUTABLES[agentRef] !== undefined && selectedAgentRefs.includes(agentRef);
    requiredByName.set(name, requiredByName.get(name) === true || required);
  }
  const commandRequirements = [...requiredByName].map(([name, required]) => ({ name, required }));
  let probeFailure: string | undefined;
  const probes =
    resolved.config === undefined
      ? []
      : await (
          input.requiredCommandProbe === undefined
            ? probeCommandsForExecution(
                resolved.config,
                commandRequirements.map((entry) => entry.name),
                env,
                { includeVersions: true, cwd: projectRoot, createProviderAppIfMissing: true }
              )
            : input.requiredCommandProbe(commandRequirements.map((entry) => entry.name))
        ).catch((error: unknown) => {
          probeFailure = error instanceof Error ? error.message : String(error);
          return [];
        });
  const probeByName = new Map(probes.map((probe) => [probe.name, probe]));
  const toolchain = commandRequirements.map((requirement) => ({
    ...requirement,
    ...(probeByName.get(requirement.name) ?? { available: false, path: null, version: null })
  }));
  const missingTools = toolchain.filter((entry) => entry.required && !entry.available).map((entry) => entry.name);
  checks.push({
    name: "toolchain",
    status: missingTools.length === 0 && probeFailure === undefined ? "ok" : "error",
    summary:
      probeFailure !== undefined
        ? "required command probe failed in the configured execution environment"
        : missingTools.length === 0
          ? `${String(toolchain.filter((entry) => entry.required).length)} required commands available in the configured execution environment`
          : `missing required commands in the configured execution environment: ${missingTools.join(", ")}`
  });
  if (probeFailure !== undefined) {
    diagnostics.push({
      code: "DOCTOR_TOOLCHAIN_PROBE_FAILED",
      message: `could not probe required commands in the configured execution environment: ${probeFailure}`,
      severity: "error",
      source: "doctor"
    });
  } else if (missingTools.length > 0) {
    diagnostics.push({
      code: "DOCTOR_TOOLCHAIN_MISSING",
      message: `required commands are not available in the configured execution environment: ${missingTools.join(", ")}`,
      severity: "error",
      source: "doctor"
    });
  }

  checks.push(
    {
      name: "workflow-engine-install",
      status: "unknown",
      summary:
        "project-local workflow engine posture is informational and ignored; the pinned operator-owned controller is installed, patched, and sealed at launch"
    },
    {
      name: "workflow-engine-patches",
      status: "unknown",
      summary:
        "project-local compatibility-patch posture is informational and ignored; operator-owned controller patches are sealed at launch"
    }
  );

  const latestCheck = registryCheck(latest);
  checks.push(latestCheck.check);
  diagnostics.push(...latestCheck.diagnostics);

  const temporaryCheck = temporaryDirectoryCheck(os.tmpdir());
  checks.push(temporaryCheck.check);
  diagnostics.push(...temporaryCheck.diagnostics);

  const value: DoctorValue = {
    project_root: projectRoot,
    ok: checks.every((check) => check.status !== "error"),
    checks,
    validation: {
      status: validationStatus,
      policy_posture: policyPostureSummary(validation.value)
    },
    toolchain,
    workflow_engine: {
      bundled_version: installation.bundled_version,
      required_version: installation.required_version,
      installed_version: installation.installed_version,
      installed_bin_target: installation.installed_bin_target,
      bin_path: installation.bin_path,
      latest_published_version: latest !== undefined && "version" in latest ? latest.version : "unknown",
      layout_status:
        installation.installed_version === installation.required_version && installation.layout_error === null
          ? "ok"
          : "error",
      layout_detail: installation.layout_error,
      compatibility_patches: installation.compatibility_patches
    }
  };
  return runtimeResult<DoctorValue>(value.ok, value, diagnostics);
}

/**
 * Launch and resume install the workflow engine controller under the OS
 * temporary directory, and a native resume keeps its install there for the
 * detached engine. Warn when that directory is RAM-backed or nearly full. The
 * controller roots are only reported: a live engine may still be using them.
 */
function temporaryDirectoryCheck(directory: string): { check: DoctorCheck; diagnostics: RuntimeDiagnostic[] } {
  const warning = (message: string) => ({
    check: { name: "temporary-directory", status: "warning" as const, summary: message },
    diagnostics: [
      { code: "DOCTOR_TEMPORARY_DIRECTORY_CONSTRAINED", message, severity: "warning" as const, source: "doctor" }
    ]
  });
  let stats: fs.StatsFs;
  let roots: string[];
  try {
    stats = fs.statfsSync(directory);
    roots = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("ultrafuzz-controller-"))
      .map((entry) => path.join(directory, entry.name));
  } catch (error) {
    return warning(
      `could not inspect the temporary directory ${directory}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const free = stats.bavail * stats.bsize;
  const rootBytes = roots.reduce((total, root) => total + regularFileBytes(root), 0);
  const usage = `${formatBytes(free)} free; ${String(roots.length)} ultrafuzz-controller-* ${roots.length === 1 ? "directory holds" : "directories hold"} ${formatBytes(rootBytes)}`;
  const problems = [
    ...(stats.type === TMPFS_MAGIC ? ["is a RAM-backed tmpfs"] : []),
    ...(free < MIN_TEMPORARY_DIRECTORY_FREE_BYTES ? ["has less than 2 GiB free"] : [])
  ];
  return problems.length === 0
    ? { check: { name: "temporary-directory", status: "ok", summary: `${directory}: ${usage}` }, diagnostics: [] }
    : warning(
        `temporary directory ${directory} ${problems.join(" and ")}; launch and resume install the workflow engine controller there (${usage}). Set TMPDIR to a disk-backed directory with more free space.`
      );
}

/** Total size of the regular files under a directory, skipping entries that vanish or cannot be read. */
function regularFileBytes(directory: string): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += regularFileBytes(entryPath);
    else if (entry.isFile()) {
      try {
        total += fs.lstatSync(entryPath).size;
      } catch {
        // Removed while scanning.
      }
    }
  }
  return total;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${String(Math.round(bytes / 1024 ** 2))} MiB`;
}

function registryCheck(latest: LatestPublishedEngine | { error: string } | undefined): {
  check: DoctorCheck;
  diagnostics: RuntimeDiagnostic[];
} {
  if (latest === undefined) {
    return {
      check: {
        name: "workflow-engine-registry",
        status: "unknown",
        summary: "registry check skipped; latest published version is unknown"
      },
      diagnostics: []
    };
  }
  if ("error" in latest) {
    // An offline project with a valid pinned install stays healthy.
    return {
      check: {
        name: "workflow-engine-registry",
        status: "warning",
        summary: "registry lookup unavailable; latest published version is unknown"
      },
      diagnostics: [
        {
          code: "DOCTOR_REGISTRY_UNAVAILABLE",
          message: `could not read the latest published workflow engine version: ${latest.error}`,
          severity: "warning",
          source: "doctor"
        }
      ]
    };
  }
  if (latest.version === SMITHERS_VERSION) {
    return {
      check: {
        name: "workflow-engine-registry",
        status: "ok",
        summary: `pinned workflow engine ${SMITHERS_VERSION} is the latest published stable release`
      },
      diagnostics: []
    };
  }
  return {
    check: {
      name: "workflow-engine-registry",
      status: "warning",
      summary: `a newer stable workflow engine is published: ${latest.version} (Ultrafuzz pins ${SMITHERS_VERSION})`
    },
    diagnostics: [
      {
        code: "DOCTOR_WORKFLOW_ENGINE_OUTDATED",
        message: `Ultrafuzz pins workflow engine ${SMITHERS_VERSION}; ${latest.version} is the latest published stable release`,
        severity: "warning",
        source: "doctor"
      }
    ]
  };
}

interface LatestPublishedEngine {
  version: string;
}

async function latestPublishedSmithersVersion(
  projectRoot: string,
  env: Record<string, string | undefined>
): Promise<LatestPublishedEngine | { error: string }> {
  return latestPublishedVersionOf(SMITHERS_PACKAGE_NAME, projectRoot, env);
}

async function latestPublishedVersionOf(
  packageName: string,
  projectRoot: string,
  env: Record<string, string | undefined>
): Promise<{ version: string } | { error: string }> {
  try {
    const { stdout } = await execFileAsync("npm", ["view", packageName, "dist-tags.latest"], {
      cwd: projectRoot,
      env: { ...process.env, ...env },
      timeout: REGISTRY_LOOKUP_TIMEOUT_MS
    });
    const version = stdout.trim();
    return /^\d+\.\d+\.\d+$/u.test(version) ? { version } : { error: "registry returned an unexpected version" };
  } catch (error) {
    return { error: error instanceof Error ? error.message.split("\n")[0]! : String(error) };
  }
}

function configuredAgentRefs(profiles: Record<string, { agent: string }> | undefined): string[] {
  return [...new Set(Object.values(profiles ?? {}).map((profile) => profile.agent))].sort();
}

function policyPostureSummary(
  value: ValidateProjectResult | undefined
): Record<string, { status: string; summary: string }> {
  return Object.fromEntries(
    Object.entries(value?.policy_posture ?? {}).map(([name, posture]) => [
      name,
      { status: posture.status, summary: posture.summary }
    ])
  );
}

function doctorStatus(ok: boolean, warnings: boolean): DoctorCheckStatus {
  return ok ? (warnings ? "warning" : "ok") : "error";
}

function hasWarnings(diagnostics: RuntimeDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "warning");
}
