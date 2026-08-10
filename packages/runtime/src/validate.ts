import fs from "node:fs";
import path from "node:path";

import {
  applyDefaultProfileOverrides,
  loadProjectConfig,
  redactDiagnostics,
  resolveConfig,
  validateExecutionNodeOverrides,
  type ResolvedConfig
} from "@ultrafuzz/config";
import { loadPromptCatalog, projectPromptDir } from "@ultrafuzz/prompts";
import { expandTopology, loadTopology, resolveTopologyPath, type ModelProfileSelection } from "@ultrafuzz/topology";

import type {
  PolicyPosture,
  PostureItem,
  RuntimeDiagnostic,
  ValidateProjectInput,
  ValidateProjectResult
} from "./types.js";
import { effectiveAuditPolicy } from "./audit-profile-policy.js";
import { transformTopologyForRun } from "./topology-transform.js";
import {
  configDiagnostics,
  diagnosticFromError,
  hasRuntimeErrors,
  postureFromDiagnostics,
  runtimeResult
} from "./utils.js";

export async function validateProject(input: ValidateProjectInput) {
  const projectRoot = path.resolve(input.projectRoot);
  const resolved = await loadResolvedProject(input);
  const configDiagnosticsList = resolved.diagnostics;
  const posture: Partial<PolicyPosture> = {};

  posture.config = postureFromDiagnostics("config", "resolved typed configuration", configDiagnosticsList);
  const promptCheck = validatePrompts(projectRoot);
  posture.prompts = promptCheck.posture;

  let topologySummary: ValidateProjectResult["topology"];
  const topologyCheck = validateTopologySurface(
    projectRoot,
    resolved.config,
    input.topologyPath,
    input.topologyTransform
  );
  posture.topology = topologyCheck.posture;
  if (topologyCheck.summary) {
    topologySummary = topologyCheck.summary;
  }

  if (resolved.config) {
    const policy = evaluatePolicies(projectRoot, resolved.config, input.env ?? process.env, topologyCheck.agentRefs);
    Object.assign(posture, policy.posture);
  } else {
    const blocked = postureFromDiagnostics("policy", "policy checks need valid config", [
      {
        code: "POLICY_CONFIG_BLOCKED",
        message: "policy posture requires a valid resolved config",
        severity: "error",
        source: "policy"
      }
    ]);
    posture.paths = blocked;
    posture.agents = blocked;
    posture.trust = blocked;
  }

  const completePosture = posture as PolicyPosture;
  const diagnostics = Object.values(completePosture).flatMap((item) => item.diagnostics);
  const value: ValidateProjectResult = {
    project_root: projectRoot,
    ...(resolved.configPath ? { config_path: resolved.configPath } : {}),
    policy_posture: completePosture,
    ...(resolved.config ? { resolved_config: summarizeConfig(resolved.config) } : {}),
    ...(topologySummary ? { topology: topologySummary } : {}),
    ...(promptCheck.summary ? { prompts: promptCheck.summary } : {})
  };
  return runtimeResult(!hasRuntimeErrors(diagnostics), value, diagnostics);
}

export async function loadResolvedProject(input: ValidateProjectInput): Promise<{
  config?: ResolvedConfig;
  configPath?: string;
  diagnostics: RuntimeDiagnostic[];
}> {
  const loaded = await loadProjectConfig(path.resolve(input.projectRoot));
  if (!loaded.ok) {
    return { diagnostics: configDiagnostics(redactDiagnostics(loaded.diagnostics)) };
  }
  const resolved = resolveConfig({
    projectConfig: loaded.value.config,
    env: input.env ?? process.env,
    runtimeOverrides: input.runtimeOverrides
  });
  if (!resolved.ok) {
    return {
      configPath: loaded.value.path,
      diagnostics: configDiagnostics(redactDiagnostics([...loaded.diagnostics, ...resolved.diagnostics]))
    };
  }
  applyAgentOverrides(resolved.value, input);
  return {
    config: resolved.value,
    configPath: loaded.value.path,
    diagnostics: configDiagnostics(redactDiagnostics([...loaded.diagnostics, ...resolved.diagnostics]))
  };
}

export function outputRootForConfig(projectRoot: string, config: ResolvedConfig): string {
  return path.resolve(projectRoot, config.run.outputDir);
}

export async function runsRootForProject(projectRoot: string): Promise<string> {
  const resolved = await loadResolvedProject({ projectRoot });
  if (resolved.config) {
    return outputRootForConfig(path.resolve(projectRoot), resolved.config);
  }
  return path.resolve(projectRoot, ".ultrafuzz/runs");
}

export function modelProfilesForTopology(
  config: ResolvedConfig
): Record<string, Omit<ModelProfileSelection, "profileId">> {
  return Object.fromEntries(
    Object.entries(config.models.profiles)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([profileId, profile]) => [
        profileId,
        {
          agentRef: profile.agent,
          ...(profile.model ? { modelName: profile.model } : {}),
          ...(profile.reasoning ? { reasoningEffort: profile.reasoning } : {})
        }
      ])
  );
}

export function summarizeConfig(config: ResolvedConfig): ValidateProjectResult["resolved_config"] {
  const defaultProfile = config.models.profiles[config.models.default];
  return {
    schema_version: config.schemaVersion,
    audit_profile: config.auditProfile,
    audit_profile_catalog_digest: config.auditProfileResolution.catalogDigest,
    ...(config.auditProfileResolution.declaredTopologyPath === undefined
      ? {}
      : { audit_profile_topology_path: config.auditProfileResolution.declaredTopologyPath }),
    audit_profile_effective_settings: config.auditProfileResolution.effectiveSettings,
    audit_profile_setting_origins: config.auditProfileResolution.settingOrigins,
    audit_profile_overridden_settings: config.auditProfileResolution.overriddenSettings,
    default_agent: defaultProfile?.agent ?? "",
    ...(defaultProfile?.model ? { default_model: defaultProfile.model } : {}),
    ...(defaultProfile?.reasoning ? { default_reasoning: defaultProfile.reasoning } : {}),
    output_dir: config.run.outputDir,
    triage_quorum: config.triage.quorum,
    triage_panel_size: config.triage.panelSize,
    execution_mode: config.execution.mode,
    ...(config.execution.provider === undefined ? {} : { execution_provider: config.execution.provider })
  };
}

function validatePrompts(projectRoot: string): {
  posture: PostureItem;
  summary?: ValidateProjectResult["prompts"];
} {
  const promptDir = projectPromptDir(projectRoot);
  if (!fs.existsSync(promptDir)) {
    return {
      posture: postureFromDiagnostics("prompts", ".ultrafuzz/prompts is missing", [
        {
          code: "PROMPTS_MISSING",
          message: ".ultrafuzz/prompts is required for normal run paths",
          severity: "error",
          source: "prompts",
          path: ".ultrafuzz/prompts"
        }
      ])
    };
  }
  try {
    const catalog = loadPromptCatalog({ projectRoot });
    return {
      posture: postureFromDiagnostics("prompts", "project prompt catalog loads and variables are strict", []),
      summary: {
        prompt_dir: promptDir,
        prompt_count: catalog.orderedIds.length
      }
    };
  } catch (error) {
    return {
      posture: postureFromDiagnostics("prompts", "project prompt catalog failed validation", [
        diagnosticFromError(error, "prompts", "PROMPTS_INVALID")
      ])
    };
  }
}

function validateTopologySurface(
  projectRoot: string,
  config: ResolvedConfig | undefined,
  topologyPath?: string,
  topologyTransform?: ValidateProjectInput["topologyTransform"]
): {
  posture: PostureItem;
  summary?: ValidateProjectResult["topology"];
  agentRefs?: Set<string>;
} {
  try {
    const policy =
      config === undefined
        ? undefined
        : effectiveAuditPolicy({
            projectRoot,
            config,
            runtimeTopologyPath: topologyPath,
            runtimeStrategyLoops: topologyTransform?.strategyLoops
          });
    const pathToTopology = policy?.effectiveTopologyPath ?? topologyPath ?? resolveTopologyPath(projectRoot);
    const topology = transformTopologyForRun(
      loadTopology(projectRoot, {
        topologyPath: pathToTopology,
        requirePromptFiles: true
      }),
      {
        ...(policy?.strategyLoops === undefined ? {} : { strategyLoops: policy.strategyLoops }),
        ...(topologyTransform?.excludedNodeIds === undefined
          ? {}
          : { excludedNodeIds: topologyTransform.excludedNodeIds })
      }
    );
    const executionDiagnostics =
      config === undefined
        ? []
        : configDiagnostics(
            validateExecutionNodeOverrides(
              config,
              topology.nodes.map((node) => node.id)
            )
          );
    const expanded = expandTopology(topology, {
      projectRoot,
      requirePromptFiles: true,
      defaultTimeoutSeconds: config?.run.defaultTimeoutSeconds,
      modelProfiles: config ? modelProfilesForTopology(config) : undefined,
      defaultModelProfileId: config?.models.default
    });
    const selectedAgents = new Set(expanded.nodes.flatMap((node) => node.modelFanout.map((model) => model.agentRef)));
    if (config?.execution.mode === "cloud") {
      for (const agentId of [...selectedAgents].sort()) {
        if (config.agents[agentId]?.auth === "subscription") {
          executionDiagnostics.push({
            code: "CONFIG_EXECUTION_AGENT_AUTH_UNSUPPORTED",
            message: "cloud execution requires API-key agent authentication configured by environment-variable name",
            severity: "error",
            source: "config",
            path: `agents.${agentId}.auth`
          });
        }
      }
    }
    return {
      posture: postureFromDiagnostics(
        "topology",
        "YAML topology v1 loads, validates, and expands",
        executionDiagnostics
      ),
      summary: {
        path: policy?.effectiveTopologyDisplayPath ?? pathToTopology,
        ...(policy === undefined
          ? {}
          : {
              origin: policy.topologyPathOrigin,
              digest: policy.topologyDigest
            }),
        logical_nodes: topology.nodes.length,
        expanded_nodes: expanded.nodes.length
      },
      agentRefs: selectedAgents
    };
  } catch (error) {
    return {
      posture: postureFromDiagnostics("topology", "topology failed validation", [
        diagnosticFromError(error, "topology", "TOPOLOGY_INVALID")
      ])
    };
  }
}

function evaluatePolicies(
  projectRoot: string,
  config: ResolvedConfig,
  _env: Record<string, string | undefined>,
  selectedAgentRefs: Set<string> | undefined
): {
  posture: Omit<PolicyPosture, "config" | "topology" | "prompts">;
} {
  const agentRegistry = validateAgentReferences(projectRoot, config, selectedAgentRefs);
  return {
    posture: {
      paths: postureFromDiagnostics("paths", "product files are written through project-local path guards", []),
      agents: postureFromDiagnostics("agents", "agent references resolve before launch", agentRegistry),
      trust: postureFromDiagnostics(
        "trust",
        "agents run with skip-permissions; repository mutation limits are prompt instructions",
        []
      )
    }
  };
}

function validateAgentReferences(
  projectRoot: string,
  config: ResolvedConfig,
  selectedAgentRefs: Set<string> | undefined
): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  const defaultProfile = config.models.profiles[config.models.default];
  const agentRefs = selectedAgentRefs ?? new Set(defaultProfile === undefined ? [] : [defaultProfile.agent]);
  const candidates = [
    path.join(projectRoot, ".smithers", "agents.ts"),
    path.join(projectRoot, ".smithers", "agents", "index.ts")
  ];
  const existing = candidates.filter((candidate) => fs.existsSync(candidate));
  if (existing.length === 0) {
    return [
      {
        code: "AGENT_REGISTRY_MISSING",
        message: "project agent registry is missing; rerun ultrafuzz init to restore it",
        severity: "error",
        source: "agents",
        path: "agent registry"
      }
    ];
  }
  const registryText = existing.map((candidate) => fs.readFileSync(candidate, "utf8")).join("\n");
  for (const agentRef of [...agentRefs].sort()) {
    if (!agentRefExported(registryText, agentRef)) {
      diagnostics.push({
        code: "AGENT_REFERENCE_UNKNOWN",
        message: `agent reference ${agentRef} is not exported by the project agent registry`,
        severity: "error",
        source: "agents",
        path: "agent registry"
      });
    }
  }
  return diagnostics;
}

function agentRefExported(registryText: string, agentRef: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(agentRef)) {
    return false;
  }
  return new RegExp(`\\b${agentRef}\\b`, "u").test(registryText);
}

function applyAgentOverrides(config: ResolvedConfig, input: ValidateProjectInput): void {
  applyDefaultProfileOverrides(config, { agent: input.agent, model: input.model, reasoning: input.reasoning });
}
