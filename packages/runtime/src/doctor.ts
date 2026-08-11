import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { referencesStatus } from "./references.js";
import { inspectSmithersInstallation, type SmithersInstallationPosture } from "./smithers.js";
import {
  SMITHERS_ORCHESTRATOR_PACKAGE_NAME,
  SMITHERS_ORCHESTRATOR_VERSION,
  SMITHERS_SUCCESSOR_PACKAGE_NAME
} from "./smithers-package.js";
import type {
  DoctorCheck,
  DoctorCheckStatus,
  DoctorInput,
  DoctorValue,
  RuntimeDiagnostic,
  ValidateProjectResult
} from "./types.js";
import { runtimeResult } from "./utils.js";
import { loadResolvedProject, validateProject } from "./validate.js";
import { probeCommandsForExecution } from "./required-commands.js";

const execFileAsync = promisify(execFile);

const REGISTRY_LOOKUP_TIMEOUT_MS = 10_000;

/** Local commands every run needs regardless of which agent backend is selected. */
const REQUIRED_TOOLCHAIN_COMMANDS = ["git", "node", "forge"] as const;

/** Agent references map to the CLI each Smithers agent class shells out to. */
const AGENT_EXECUTABLES: Record<string, string> = {
  ClaudeAgent: "claude",
  CodexAgent: "codex",
  DeepSeekAgent: "claude",
  KimiAgent: "kimi"
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
  const validation = await validateProject({ projectRoot, env });
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

  checks.push({
    name: "references",
    status: references.ok ? "ok" : "error",
    summary: references.ok
      ? `${references.value?.references.length ?? 0} pinned references present in the local cache`
      : "pinned references are missing from the local cache; run ultrafuzz references sync"
  });
  diagnostics.push(...references.diagnostics);

  const agentRefs = configuredAgentRefs(resolved.config?.models.profiles);
  const topologyCommands = validation.value?.topology?.required_commands ?? [];
  const commandRequirements = [
    ...REQUIRED_TOOLCHAIN_COMMANDS.map((name) => ({ name, required: true })),
    ...topologyCommands.map((name) => ({ name, required: true })),
    ...agentRefs.map((agentRef) => ({
      name: AGENT_EXECUTABLES[agentRef] ?? agentRef,
      // Only demand a CLI for agents whose executable Ultrafuzz actually
      // knows; an unrecognised ref is reported without being required.
      required: AGENT_EXECUTABLES[agentRef] !== undefined
    }))
  ].filter((entry, index, entries) => entries.findIndex((candidate) => candidate.name === entry.name) === index);
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
          ? `${toolchain.length} required commands available in the configured execution environment`
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

  const engineCheck = workflowEngineCheck(installation);
  checks.push(engineCheck.check);
  diagnostics.push(...engineCheck.diagnostics);

  const patchCheck = compatibilityPatchCheck(installation);
  checks.push(patchCheck.check);
  diagnostics.push(...patchCheck.diagnostics);

  const latestCheck = registryCheck(latest);
  checks.push(latestCheck.check);
  diagnostics.push(...latestCheck.diagnostics);

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
      // The newest release can come from a renamed upstream package, so the version
      // above is not necessarily comparable with the pinned one. Flag that rather
      // than naming the package, which would leak engine branding.
      latest_published_is_renamed_package: latest !== undefined && "version" in latest && latest.renamed,
      layout_status: engineCheck.check.status,
      layout_detail: installation.layout_error,
      compatibility_patches: installation.compatibility_patches
    }
  };
  return runtimeResult<DoctorValue>(value.ok, value, diagnostics);
}

function workflowEngineCheck(installation: SmithersInstallationPosture): {
  check: DoctorCheck;
  diagnostics: RuntimeDiagnostic[];
} {
  if (installation.installed_version === null) {
    return {
      check: {
        name: "workflow-engine-install",
        status: "error",
        summary: `pinned workflow engine ${installation.required_version} is not installed for this project`
      },
      diagnostics: [
        {
          code: "DOCTOR_WORKFLOW_ENGINE_MISSING",
          message: `pinned workflow engine ${installation.required_version} is not installed; it installs automatically on the next run`,
          severity: "error",
          source: "doctor"
        }
      ]
    };
  }
  if (installation.installed_version !== installation.required_version) {
    return {
      check: {
        name: "workflow-engine-install",
        status: "error",
        summary: `installed workflow engine ${installation.installed_version} does not match the required ${installation.required_version}`
      },
      diagnostics: [
        {
          code: "DOCTOR_WORKFLOW_ENGINE_VERSION_MISMATCH",
          message: `installed workflow engine is ${installation.installed_version} but ${installation.required_version} is required`,
          severity: "error",
          source: "doctor"
        }
      ]
    };
  }
  if (installation.layout_error !== null) {
    return {
      check: {
        name: "workflow-engine-install",
        status: "error",
        summary: `installed workflow engine layout is not usable: ${installation.layout_error}`
      },
      diagnostics: [
        {
          code: "DOCTOR_WORKFLOW_ENGINE_LAYOUT_INVALID",
          message: `installed workflow engine layout failed validation: ${installation.layout_error}`,
          severity: "error",
          source: "doctor"
        }
      ]
    };
  }
  return {
    check: {
      name: "workflow-engine-install",
      status: "ok",
      summary: `workflow engine ${installation.installed_version} installed and passing manifest and path validation`
    },
    diagnostics: []
  };
}

function compatibilityPatchCheck(installation: SmithersInstallationPosture): {
  check: DoctorCheck;
  diagnostics: RuntimeDiagnostic[];
} {
  const entries = Object.entries(installation.compatibility_patches);
  const incompatible = entries.filter(([, posture]) => posture === "incompatible").map(([name]) => name);
  const missing = entries.filter(([, posture]) => posture === "missing").map(([name]) => name);
  const unknown = entries.filter(([, posture]) => posture === "unknown").map(([name]) => name);
  if (incompatible.length > 0) {
    // The next run hard-fails in this state, so doctor must not call it healthy.
    return {
      check: {
        name: "workflow-engine-patches",
        status: "error",
        summary: `installed engine source is modified or incompatible for: ${incompatible.join(", ")}`
      },
      diagnostics: [
        {
          code: "DOCTOR_WORKFLOW_ENGINE_PATCHES_INCOMPATIBLE",
          message: `installed workflow engine source no longer matches the shape Ultrafuzz patches for: ${incompatible.join(", ")}; reinstall the pinned engine`,
          severity: "error",
          source: "doctor"
        }
      ]
    };
  }
  if (missing.length > 0) {
    return {
      check: {
        name: "workflow-engine-patches",
        status: "warning",
        summary: `compatibility patches not applied yet: ${missing.join(", ")}; they apply on the next run`
      },
      diagnostics: [
        {
          code: "DOCTOR_WORKFLOW_ENGINE_PATCHES_PENDING",
          message: `required workflow engine compatibility patches are not applied: ${missing.join(", ")}`,
          severity: "warning",
          source: "doctor"
        }
      ]
    };
  }
  if (unknown.length > 0) {
    return {
      check: {
        name: "workflow-engine-patches",
        status: "unknown",
        summary: `compatibility patch posture unavailable for: ${unknown.join(", ")}`
      },
      diagnostics: []
    };
  }
  const upstream = entries.filter(([, posture]) => posture === "upstream").map(([name]) => name);
  return {
    check: {
      name: "workflow-engine-patches",
      status: "ok",
      summary:
        upstream.length === entries.length
          ? "the installed engine already provides every patched behavior upstream"
          : `compatibility patches applied${upstream.length > 0 ? `; upstream now covers ${upstream.join(", ")}` : ""}`
    },
    diagnostics: []
  };
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
  // The successor lookup failing while the legacy one succeeds must not read as
  // "you are current": the legacy name is frozen at the pinned version forever, so
  // that combination is exactly the false positive this check exists to remove.
  if (latest.successorUnavailable) {
    return {
      check: {
        name: "workflow-engine-registry",
        status: "warning",
        summary: "registry lookup was only partly available; a newer workflow engine cannot be ruled out"
      },
      diagnostics: [
        {
          code: "DOCTOR_REGISTRY_UNAVAILABLE",
          message:
            "the pinned workflow engine name is frozen upstream, and the renamed successor package could not be " +
            `read, so ${SMITHERS_ORCHESTRATOR_VERSION} cannot be confirmed as current: ${latest.successorUnavailable}`,
          severity: "warning",
          source: "doctor"
        }
      ]
    };
  }
  if (latest.version === SMITHERS_ORCHESTRATOR_VERSION && !latest.renamed) {
    return {
      check: {
        name: "workflow-engine-registry",
        status: "ok",
        summary: `pinned workflow engine ${SMITHERS_ORCHESTRATOR_VERSION} is the latest published stable release`
      },
      diagnostics: []
    };
  }
  // Deliberately never names the upstream package: operator-facing text keeps the
  // engine de-branded, and the successor name would slip past the `smithers` scrub
  // by spelling alone. "renamed upstream package" carries the actionable signal.
  const newest = `${latest.version}${latest.renamed ? " under a renamed upstream package" : ""}`;
  return {
    check: {
      name: "workflow-engine-registry",
      status: "warning",
      summary: `a newer stable workflow engine is published: ${newest} (Ultrafuzz pins ${SMITHERS_ORCHESTRATOR_VERSION})`
    },
    diagnostics: [
      {
        code: "DOCTOR_WORKFLOW_ENGINE_OUTDATED",
        message:
          `Ultrafuzz pins workflow engine ${SMITHERS_ORCHESTRATOR_VERSION}; ${newest} is the latest published stable release` +
          (latest.renamed
            ? `; upgrading past ${SMITHERS_ORCHESTRATOR_VERSION} requires migrating to the renamed upstream package`
            : ""),
        severity: "warning",
        source: "doctor"
      }
    ]
  };
}

interface LatestPublishedEngine {
  version: string;
  /** True when the newest release comes from the renamed successor package. */
  renamed: boolean;
  /** Set when the successor lookup failed, so "current" cannot be concluded. */
  successorUnavailable?: string;
}

// Upstream renamed the package after the version Ultrafuzz pins, so the old name
// is frozen forever and asking only about it would silently report "you are on the
// latest release" for every future release. Consult both names and report the
// newer. The package names stay inside this module: operator-facing text keeps the
// engine de-branded.
async function latestPublishedSmithersVersion(
  projectRoot: string,
  env: Record<string, string | undefined>
): Promise<LatestPublishedEngine | { error: string }> {
  const [legacy, successor] = await Promise.all([
    latestPublishedVersionOf(SMITHERS_ORCHESTRATOR_PACKAGE_NAME, projectRoot, env),
    latestPublishedVersionOf(SMITHERS_SUCCESSOR_PACKAGE_NAME, projectRoot, env)
  ]);
  if ("error" in legacy && "error" in successor) {
    return { error: legacy.error };
  }
  if ("error" in successor) {
    // `legacy` resolved. Its name can never advance past the pinned version, so an
    // unreadable successor leaves the question genuinely open rather than answered.
    return { version: (legacy as { version: string }).version, renamed: false, successorUnavailable: successor.error };
  }
  if ("error" in legacy) {
    return { version: successor.version, renamed: true };
  }
  return compareSemanticVersions(successor.version, legacy.version) > 0
    ? { version: successor.version, renamed: true }
    : { version: legacy.version, renamed: false };
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

// Callers only ever pass versions `latestPublishedVersionOf` has already matched
// against `^\d+\.\d+\.\d+$`. That invariant lives in another function, so treat a
// non-numeric segment as 0 rather than returning NaN, which would silently compare
// as "not newer" and reinstate the dead upgrade signal.
function compareSemanticVersions(left: string, right: string): number {
  const segment = (value: string, index: number): number => {
    const parsed = Number(value.split(".")[index]);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  for (let index = 0; index < 3; index += 1) {
    const difference = segment(left, index) - segment(right, index);
    if (difference !== 0) return difference;
  }
  return 0;
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
