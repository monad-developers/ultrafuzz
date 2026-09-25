import fs from "node:fs";
import path from "node:path";

import {
  appendEvent,
  assertRunPlanDocument,
  assertPlannedGraph,
  assertPlannedGraphSemantics,
  assertSealedPlannedGraph,
  assertSmithersTaskManifestMatchesPlannedGraph,
  assertNoSymlinkComponents,
  assertPathInside,
  assertRegularFileInside,
  layoutForRunRoot,
  parseSmithersTaskManifestBytes,
  parseStrictJsonBytes,
  readRegularFileSnapshot,
  readRunMetadataDocument,
  readRunState,
  safeResolveInside,
  sensitiveEnvironmentValues,
  updateRunStatus,
  validatePlannedGraph,
  validateSafeId,
  writeJsonDurable,
  writeRunMetadataDocument,
  writeRunState,
  type RunMetadataDocument,
  type RunMetadataWorkflow,
  type RunWorkflowProvenance,
  type RunLayout,
  type AppendEventInput,
  type PlannedGraphDocument,
  type SmithersTaskManifestDocument
} from "@ultrafuzz/artifacts";
import { parseResolvedConfigJsonBytes, validateAgentConfigs, type ResolvedConfig } from "@ultrafuzz/config";
import { isSensitiveEnvironmentName, isSensitiveSecretValue } from "@ultrafuzz/security";
import { assertExpandedGraphSchema, type ExpandedGraph } from "@ultrafuzz/topology";

import {
  type PlannedGraph,
  type PauseRunInput,
  type PauseRunValue,
  type RuntimeDiagnostic,
  type StartRunInput,
  type StartRunValue,
  type WorkflowLifecycleInput,
  type WorkflowLifecycleValue
} from "./types.js";
import { planRun } from "./plan-run.js";
import { probeCommandsForExecution } from "./required-commands.js";
import { forgeGuardMetadata, prepareForgeGuardEnvironment } from "./forge-guard.js";
import {
  prepareTrustedCliEnvironment,
  runTrustedJsonValidatorPreflight,
  TRUSTED_CLI_ENVIRONMENT_VARIABLES,
  type TrustedCliEnvironment
} from "./trusted-cli.js";
import { hasRuntimeErrors, runtimeFailure, runtimeResult } from "./utils.js";
import {
  assertControllerExecutionSnapshotDigest,
  assertProviderScopedSensitiveEnvironmentCapability
} from "./controller-source.js";
import { controllerOwnedGovernancePaths, targetIdentity } from "./data-governance.js";
import {
  compileSmithersWorkflow,
  assertSmithersControllerRefreshable,
  nativeSmithersContinuationEnvironment,
  renderCurrentSmithersController,
  requestSmithersPause,
  runSmithersLifecycleCommand,
  type SmithersResumeInspection,
  assertCurrentCloudAgentCredentialEnvironment,
  assertSealedDataGovernance,
  smithersExecutionControlFiles,
  smithersDiagnostic,
  submitSmithersWorkflow,
  type CompiledSmithersWorkflow
} from "./smithers.js";
import { runsRootForProject } from "./validate.js";
import {
  acquireWorkflowControlLock,
  acquireWorkflowLifecycleLock,
  authenticatedContinuationGovernancePath,
  materializeWorkflowExecutionSnapshot,
  sealedBunStartupControlDrift,
  sealWorkflowControlFiles,
  verifyWorkflowControlSnapshot,
  workflowControlPaths,
  type MaterializedWorkflowExecutionSnapshot,
  type VerifiedWorkflowControlSnapshot
} from "./workflow-integrity.js";
import { effectiveControllerGeneration } from "./workflow-controller-generation.js";
import {
  finalizeWorkflowRunLink,
  prepareWorkflowRunLink,
  verifyCommittedWorkflowRunLink,
  verifyWorkflowRunLinkAuthorization,
  verifyWorkflowRunLinkHistory,
  workflowRunLinkJournalPath,
  type WorkflowRunLinkAction,
  type WorkflowRunLinkJournalEntry
} from "./workflow-run-link.js";
import { smithersExecutableCapability } from "./smithers-executable-capability.js";
import { hasWorkflowExecutionSnapshotCapability } from "./workflow-execution-snapshot-capability.js";
import {
  OBSERVATION_SNAPSHOT_ATTEMPTS,
  exhaustedSnapshotRaceError,
  isTransientSnapshotRace,
  isTransientSnapshotRaceMessage
} from "./observation-snapshot.js";
import { repairPrunableRunWorktreeRegistrations } from "./stale-worktree-recovery.js";

export interface LinkedWorkflowEvidence {
  ok: true;
  smithersRunId: string;
  workflowPath: string;
  layout: RunLayout;
  controlGeneration: string;
  controllerGeneration: string;
  workflowLinkId: string;
  verifiedControl: VerifiedWorkflowControlSnapshot;
  controllerSnapshot: VerifiedWorkflowControlSnapshot;
  executionSnapshot: MaterializedWorkflowExecutionSnapshot;
}

type LinkedWorkflowEvidenceFailure = { ok: false; diagnostics: RuntimeDiagnostic[] };
type ReadLinkedWorkflowEvidenceOptions = {
  tolerateControlDivergence?: boolean;
  /** Observers authenticate only already-published evidence and never take or mutate control authority. */
  observeOnly?: boolean;
};

const WORKFLOW_CONTROLLER_ONLY_ENVIRONMENT_VARIABLES = new Set([
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
  "ULTRAFUZZ_MODAL_MODULE",
  "ULTRAFUZZ_PROVIDER_HOME_ROOT",
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
]);
const MODEL_ROUTE_PROXY_ENVIRONMENT_VARIABLES = [
  "ALL_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy"
] as const;

function controllerRefreshInspectionEnvironment(
  env: Record<string, string | undefined> | undefined
): Record<string, string | undefined> | undefined {
  if (smithersExecutableCapability(env) === undefined && !hasWorkflowExecutionSnapshotCapability(env)) {
    return env;
  }
  // A lifecycle caller can accidentally hand back the environment from the
  // old sealed generation. Its enumerable private symbols deliberately survive
  // ordinary spreads, but refresh must inspect with current operator authority:
  // copy string credentials only, remove every snapshot-controlled value, and
  // mask an ambient explicit runner until the current operator runner is bound.
  const current = Object.fromEntries(
    Object.entries(env ?? {}).filter(
      ([name]) => !WORKFLOW_CONTROLLER_ONLY_ENVIRONMENT_VARIABLES.has(name.toUpperCase())
    )
  );
  for (const name of WORKFLOW_CONTROLLER_ONLY_ENVIRONMENT_VARIABLES) current[name] = undefined;
  current.SMITHERS_BIN = "";
  return current;
}

export async function startRun(input: StartRunInput) {
  const planned = await planRun(input, {
    enforceDataGovernance: true,
    beforeMaterialize: async ({ resolvedConfig, expandedGraph }) =>
      requiredCommandPreflightDiagnostics(input, resolvedConfig, expandedGraph)
  });
  if (!planned.ok || !planned.value) {
    return runtimeFailure<StartRunValue>(planned.diagnostics);
  }

  const plan = planned.value;
  const forbiddenSecretValues = sensitiveEnvironmentValues(input.env ?? process.env, [
    ...Object.values(plan.resolved_config.agents).flatMap((agent) =>
      agent.auth === "api-key" && agent.apiKeyEnv !== undefined ? [agent.apiKeyEnv] : []
    ),
    ...(plan.resolved_config.execution.providers.modal?.credentialEnv ?? [])
  ]);
  let releaseControlLock: () => Promise<void>;
  try {
    releaseControlLock = await acquireWorkflowControlLock(plan.layout);
  } catch (error) {
    return runtimeFailure<StartRunValue>([smithersDiagnostic(error, "WORKFLOW_CONTROL_PREPARATION_FAILED")]);
  }
  try {
    const compiled = compileSmithersWorkflow({
      config: plan.resolved_config,
      graph: plan.expanded_graph,
      runLayout: plan.layout,
      projectRoot: plan.validation.project_root,
      sourceRevision: plan.source_revision,
      sourceRef: plan.source_ref,
      workflowName: `ultrafuzz-${plan.run_id}`,
      renderedPrompts: plan.rendered_prompts,
      operatorPrompt: input.prompt,
      operatorInput: input.workflowInput,
      env: { ...process.env, ...(input.env ?? {}) },
      controllerSourceDigest: plan.controller_source_digest,
      dataGovernance: plan.data_governance
    });
    const prepared = await persistSmithersEvidence(plan.layout, plan.graph, compiled, input.env, forbiddenSecretValues);
    appendEvent(plan.layout, {
      eventType: "workflow-compiled",
      status: "succeeded",
      payload: {
        workflow_run_id: compiled.smithersRunId,
        workflow_name: compiled.workflowName,
        control_generation: prepared.verifiedControl.generation,
        workflow_link_id: prepared.workflowLinkId,
        task_count: compiled.tasks.length,
        workflow_path: path.relative(plan.layout.root, prepared.executionSnapshot.workflowPath)
      },
      forbiddenSecretValues
    });

    updateRunStatus(plan.layout, "running", undefined, { forbiddenSecretValues });
    const controllerInvocation = appendEvent(plan.layout, {
      eventType: "workflow-submitting",
      status: "running",
      payload: {
        workflow_run_id: compiled.smithersRunId,
        workflow_name: compiled.workflowName,
        control_generation: prepared.verifiedControl.generation,
        workflow_link_id: prepared.workflowLinkId,
        action: "start"
      },
      forbiddenSecretValues
    });

    const forgeGuard = prepareForgeGuardEnvironment({
      layout: plan.layout,
      config: plan.resolved_config,
      env: input.env
    });
    persistForgeGuardMetadata(plan.layout, plan.resolved_config, forgeGuard.active);
    const trustedCli = prepareTrustedCliEnvironment({
      layout: plan.layout,
      cliEntrypoint: input.ultrafuzzCliEntrypoint,
      executionSnapshotRoot: prepared.executionSnapshot.root,
      env: forgeGuard.env,
      required: compiled.tasks.some((task) =>
        task.metadata.artifacts.outputs.some((output) => output.schemaFile !== undefined)
      )
    });
    runTrustedJsonValidatorPreflight({ layout: plan.layout, trusted: trustedCli });
    assertCurrentDataGovernanceTarget(
      plan.validation.project_root,
      prepared.verifiedControl.executionFiles,
      plan.data_governance.path,
      controllerOwnedGovernancePaths(plan.validation.project_root, plan.layout.root)
    );
    const activeAgentRefs = compiled.tasks.flatMap((task) => task.agentChain.map((profile) => profile.agentRef));
    const providerCredentialNames = agentCredentialEnvironmentVariableNames(plan.resolved_config, activeAgentRefs);
    const submissionEnvironment = {
      ...process.env,
      ...providerScopedControllerEnvironment(
        { ...trustedCli.env, ...prepared.executionSnapshot.env },
        providerCredentialNames
      )
    };
    assertCurrentCloudAgentCredentialEnvironment(plan.resolved_config, compiled.tasks, submissionEnvironment);
    const submission = await submitSmithersWorkflow({
      compiled,
      projectRoot: plan.validation.project_root,
      maxConcurrency: input.maxConcurrency ?? plan.resolved_config.run.maxParallelAgents,
      keepWorkspaces: plan.resolved_config.run.keepWorkspaces,
      controllerLeaseSeconds: plan.resolved_config.run.controllerLeaseSeconds,
      workflowPath: prepared.executionSnapshot.workflowPath,
      env: submissionEnvironment,
      environmentVariableNames: mergeEnvironmentVariableNames(
        agentEnvironmentVariableNames(plan.resolved_config, activeAgentRefs, forgeGuard.env),
        ["ULTRAFUZZ_PROVIDER_CREDENTIAL_ENV_NAMES", "ULTRAFUZZ_SENSITIVE_AGENT_ENV_NAMES"],
        forgeGuard.environmentVariableNames,
        trustedCli.environmentVariableNames
      ),
      inputJson: prepared.executionSnapshot.inputJson
    });
    appendEvent(plan.layout, {
      eventType: "workflow-submitted",
      status: "running",
      payload: {
        workflow_run_id: submission.smithersRunId,
        control_generation: prepared.verifiedControl.generation,
        workflow_link_id: prepared.workflowLinkId,
        controller_invocation_id: controllerInvocation.event_id,
        controller_invoked_at: controllerInvocation.timestamp
      },
      forbiddenSecretValues
    });
    return runtimeResult(
      true,
      {
        run_id: plan.layout.runId,
        run_root: plan.layout.root,
        status: readRunState(plan.layout).status,
        ...(plan.source_run_id ? { source_run_id: plan.source_run_id } : {}),
        graph_fingerprint: plan.graph_fingerprint,
        config_fingerprint: plan.config_fingerprint,
        workflow_ids: [compiled.smithersRunId]
      },
      planned.diagnostics
    );
  } catch (error) {
    const diagnostic = smithersDiagnostic(error, "WORKFLOW_SUBMISSION_FAILED");
    updateRunStatus(plan.layout, "failed", undefined, { forbiddenSecretValues });
    appendEvent(plan.layout, {
      eventType: "workflow-submit-failed",
      status: "failed",
      payload: workflowSubmissionFailureEventPayload(diagnostic),
      forbiddenSecretValues
    });
    return runtimeFailure<StartRunValue>([diagnostic]);
  } finally {
    await releaseControlLock();
  }
}

async function requiredCommandPreflightDiagnostics(
  input: Pick<StartRunInput, "projectRoot" | "env" | "requiredCommandProbe">,
  resolvedConfig: ResolvedConfig,
  expandedGraph: ExpandedGraph
): Promise<RuntimeDiagnostic[]> {
  const credentialDiagnostics = openRouterCredentialPreflightDiagnostics(
    resolvedConfig,
    expandedGraph,
    input.env ?? process.env
  );
  const requiredCommands = [...new Set(expandedGraph.nodes.flatMap((node) => node.requiredCommands ?? []))].sort();
  const blockingRequiredCommands = new Set(
    expandedGraph.nodes
      .filter((node) => !expandedNodeContinuesOnFailure(expandedGraph, node))
      .flatMap((node) => node.requiredCommands ?? [])
  );
  let commandProbes: Awaited<ReturnType<typeof probeCommandsForExecution>>;
  try {
    commandProbes =
      input.requiredCommandProbe === undefined
        ? await probeCommandsForExecution(resolvedConfig, requiredCommands, input.env ?? process.env, {
            cwd: path.resolve(input.projectRoot),
            // Normal cloud launch creates its configured app on first use.
            // Preflight must preserve that behavior to inspect the real image.
            createProviderAppIfMissing: true
          })
        : await input.requiredCommandProbe(requiredCommands);
    if (!Array.isArray(commandProbes)) {
      throw new Error("required-command probe returned a non-array result");
    }
    const expectedCommands = new Set(requiredCommands);
    const seenCommands = new Set<string>();
    for (const probe of commandProbes) {
      if (
        probe === null ||
        typeof probe !== "object" ||
        typeof probe.name !== "string" ||
        !expectedCommands.has(probe.name) ||
        seenCommands.has(probe.name) ||
        typeof probe.available !== "boolean" ||
        (probe.path !== null && typeof probe.path !== "string") ||
        (probe.version !== null && typeof probe.version !== "string")
      ) {
        throw new Error("required-command probe returned an incomplete or ambiguous result set");
      }
      seenCommands.add(probe.name);
    }
    if (seenCommands.size !== expectedCommands.size) {
      throw new Error("required-command probe omitted one or more requested commands");
    }
  } catch (error) {
    return [
      ...credentialDiagnostics,
      {
        code: "RUN_REQUIRED_COMMAND_PREFLIGHT_FAILED",
        message: `could not probe required topology commands in the configured execution environment: ${error instanceof Error ? error.message : String(error)}`,
        severity: "error",
        source: "runtime",
        path: "topology.required_commands"
      }
    ];
  }
  const probeByName = new Map(commandProbes.map((probe) => [probe.name, probe]));
  // Only an exact, successfully returned `available: false` result is a
  // missing-command disposition. Probe exceptions and opaque/partial results
  // above are operational failures and must never degrade to optional warnings.
  const missingCommands = requiredCommands.filter((command) => probeByName.get(command)?.available === false);
  const missingRequirements = missingCommands.map((command) => ({
    command,
    node_ids: [
      ...new Set(
        expandedGraph.nodes
          .filter((node) => node.requiredCommands?.includes(command) === true)
          .map((node) => node.logicalId)
      )
    ].sort()
  }));
  const blockingMissingCommands = missingCommands.filter((command) => blockingRequiredCommands.has(command));
  const optionalMissingCommands = missingCommands.filter((command) => !blockingRequiredCommands.has(command));
  const diagnosticFor = (
    commands: string[],
    severity: RuntimeDiagnostic["severity"]
  ): RuntimeDiagnostic | undefined => {
    if (commands.length === 0) return undefined;
    const requirements = missingRequirements.filter((requirement) => commands.includes(requirement.command));
    return {
      code: severity === "error" ? "RUN_REQUIRED_COMMAND_MISSING" : "RUN_OPTIONAL_COMMAND_MISSING",
      message: `${severity === "error" ? "required" : "optional specialist"} topology commands are not available in the configured execution environment: ${requirements
        .map((requirement) => `${requirement.command} (required by ${requirement.node_ids.join(", ")})`)
        .join("; ")}`,
      severity,
      source: "runtime",
      path: "topology.required_commands",
      details: { commands, requirements }
    };
  };
  return [
    ...credentialDiagnostics,
    diagnosticFor(optionalMissingCommands, "warning"),
    diagnosticFor(blockingMissingCommands, "error")
  ].filter((diagnostic): diagnostic is RuntimeDiagnostic => diagnostic !== undefined);
}

function expandedNodeContinuesOnFailure(graph: ExpandedGraph, node: ExpandedGraph["nodes"][number]): boolean {
  return node.group !== undefined && graph.groups[node.group]?.defaults?.failure_policy === "continue";
}

function openRouterCredentialPreflightDiagnostics(
  config: ResolvedConfig,
  graph: ExpandedGraph,
  env: Record<string, string | undefined>
): RuntimeDiagnostic[] {
  const selected = graph.nodes.some((node) => node.modelFanout.some((model) => model.agentRef === "OpenRouterAgent"));
  if (!selected) return [];
  const agent = config.agents.OpenRouterAgent;
  const name = agent?.auth === "api-key" ? agent.apiKeyEnv : undefined;
  if (name !== undefined && (env[name] ?? "").trim() !== "") return [];
  return [
    {
      code: "RUN_AGENT_CREDENTIAL_MISSING",
      message: `OpenRouterAgent requires its configured API-key environment variable${name === undefined ? "" : ` (${name})`} to be set`,
      severity: "error",
      source: "runtime",
      path: "agents.OpenRouterAgent.api_key_env"
    }
  ];
}

export async function resumeRun(input: WorkflowLifecycleInput) {
  return submitSmithersContinuation(input);
}

async function submitSmithersContinuation(input: WorkflowLifecycleInput) {
  let releaseLifecycleLock: (() => Promise<void>) | undefined;
  try {
    const projectRoot = path.resolve(input.projectRoot);
    const runsRoot = await runsRootForProject(projectRoot);
    const runId = validateSafeId(input.runId, "run ID");
    const layout = layoutForRunRoot(path.join(runsRoot, runId), runId);
    assertPathInside(runsRoot, layout.root, "run root");
    if (fs.existsSync(runsRoot)) assertNoSymlinkComponents(runsRoot, layout.root, "run root");
    releaseLifecycleLock = await acquireWorkflowLifecycleLock(layout);

    assertRegularFileInside(layout.root, layout.runMetadataPath, "run metadata");
    const metadata = objectRecord(
      parseStrictJsonBytes(readRegularFileSnapshot(layout.runMetadataPath, 16 * 1024 * 1024))
    );
    if (metadata.run_id !== runId) throw new Error("run metadata does not match the requested run ID");
    const workflow = objectRecord(metadata.workflow);
    const historicalWorkflowIds = Array.isArray(metadata.workflow_ids)
      ? metadata.workflow_ids.filter(
          (value): value is string => typeof value === "string" && value.length > 0 && !value.includes("\0")
        )
      : [];
    const smithersRunId = validateSafeId(
      typeof workflow.run_id === "string" && workflow.run_id.length > 0 && !workflow.run_id.includes("\0")
        ? workflow.run_id
        : (historicalWorkflowIds.at(-1) ?? `ultrafuzz-${runId}`),
      "Smithers run ID"
    );
    let workflowPath: string;
    // Refresh proves ownership before rendering; the resume below reuses that
    // evidence rather than inspecting the same run a second time (#968).
    let refreshInspection: SmithersResumeInspection | undefined;
    if (input.refreshController === true) {
      // Refresh renders a replacement path below. A lost or malformed
      // historical project-workflow pointer is provenance, not authority to
      // prevent the run-owned task evidence from reaching the current
      // controller.
      workflowPath = "";
    } else {
      const persistedWorkflowPath =
        typeof workflow.path === "string" && workflow.path.length > 0
          ? workflow.path
          : path.join(".smithers", "workflows", `ultrafuzz-${runId}.tsx`);
      workflowPath = safeResolveInside(projectRoot, persistedWorkflowPath, "workflow path");
      assertRegularFileInside(projectRoot, workflowPath, "workflow path");
    }

    const smithersRoot = safeResolveInside(layout.root, "smithers", "Smithers evidence");
    const tasksPath = safeResolveInside(smithersRoot, "tasks.json", "workflow task manifest");
    const configPath = safeResolveInside(smithersRoot, "resolved-config.json", "workflow config");
    let taskDocument: SmithersTaskManifestDocument | undefined;
    let config: ResolvedConfig | undefined;
    if (fs.existsSync(tasksPath)) {
      assertRegularFileInside(layout.root, tasksPath, "workflow task manifest");
      try {
        taskDocument = parseSmithersTaskManifestBytes(readRegularFileSnapshot(tasksPath, 128 * 1024 * 1024));
      } catch (error) {
        if (input.refreshController === true) throw error;
      }
    }
    if (fs.existsSync(configPath)) {
      assertRegularFileInside(layout.root, configPath, "workflow config");
      try {
        config = parseContinuationResolvedConfigBytes(readRegularFileSnapshot(configPath, 16 * 1024 * 1024));
      } catch (error) {
        if (input.refreshController === true) throw error;
      }
    }
    if (input.refreshController === true) {
      if (taskDocument === undefined || config === undefined) {
        throw new Error("current controller rendering requires the persisted workflow task manifest and config");
      }
      refreshInspection = await assertSmithersControllerRefreshable({
        smithersRunId,
        projectRoot,
        env: controllerRefreshInspectionEnvironment(input.env)
      });
      workflowPath = renderCurrentSmithersController({
        projectRoot,
        layout,
        smithersRunId,
        tasks: taskDocument,
        config,
        expandedGraph: readContinuationExpandedGraph(layout)
      });
    }
    const tasks = taskDocument?.tasks ?? [];
    const forgeGuard =
      config === undefined
        ? { env: { ...(input.env ?? {}) }, environmentVariableNames: [] as readonly string[], active: false }
        : prepareForgeGuardEnvironment({ layout, config, env: input.env });
    const controllerEnvironment = {
      ...forgeGuard.env,
      ULTRAFUZZ_ARTIFACTS_MODULE: import.meta.resolve("@ultrafuzz/artifacts"),
      ULTRAFUZZ_RUNTIME_MODULE: import.meta.resolve("@ultrafuzz/runtime"),
      ...(config === undefined ? {} : { ULTRAFUZZ_CONFIG_PATH: configPath }),
      ULTRAFUZZ_WORKFLOW_PERSISTED_PATH: workflowPath
    };
    let trustedCli: TrustedCliEnvironment = {
      active: false,
      env: { ...controllerEnvironment },
      environmentVariableNames: []
    };
    for (const name of TRUSTED_CLI_ENVIRONMENT_VARIABLES) trustedCli.env[name] = undefined;
    if (taskDocument !== undefined && config !== undefined) {
      try {
        const prepared = prepareTrustedCliEnvironment({
          layout,
          cliEntrypoint: input.ultrafuzzCliEntrypoint,
          env: controllerEnvironment,
          required: tasks.some((task) =>
            task.metadata.artifacts.outputs.some((output) => output.schemaFile !== undefined)
          ),
          allowIdentityRotation: input.refreshController === true
        });
        if (prepared.active) runTrustedJsonValidatorPreflight({ layout, trusted: prepared });
        trustedCli = prepared;
      } catch {
        // Historical validator identity is task setup provenance, not authority
        // to prevent Smithers from continuing the workflow.
      }
    }
    const agentRefs = tasks.flatMap((task) => task.agentChain.map((profile) => profile.agentRef));
    const providerCredentialNames =
      config === undefined ? [] : agentCredentialEnvironmentVariableNames(config, agentRefs);
    const continuedEnvironment =
      input.refreshController === true ? trustedCli.env : withoutSensitiveAllowlistedEnvironment(trustedCli.env);
    const lifecycleEnvironment = {
      ...process.env,
      ...providerScopedControllerEnvironment(continuedEnvironment, providerCredentialNames)
    };
    if (config !== undefined && taskDocument !== undefined) {
      assertCurrentCloudAgentCredentialEnvironment(config, tasks, lifecycleEnvironment);
    }
    if (typeof metadata.source_revision === "string") {
      repairPrunableRunWorktreeRegistrations({ projectRoot, runRoot: layout.root, runId });
    }
    const result = await runSmithersLifecycleCommand({
      action: "resume",
      smithersRunId,
      workflowPath,
      projectRoot,
      maxConcurrency: input.maxConcurrency ?? config?.run.maxParallelAgents,
      resetNode: input.resetNode,
      force: input.force,
      retryFailed: input.retryFailed,
      priorInspection: refreshInspection,
      beforeStoppedReset: async (inspection) => {
        if (!hasRetainedResetControlAuthority(projectRoot, layout, workflow)) return;
        // Authenticated original v2 plans predate governance and the current
        // linked-evidence contract; retain their native legacy reset behavior.
        if (authenticatedContinuationGovernancePath(projectRoot, layout, workflow.control_generation) === undefined)
          return;
        // workflow-sync reads linked evidence through this module. Load the
        // failure-only checkpoint after initialization, at an actual reset.
        const { preserveFailedWorkflowAttemptsBeforeReset } = await import("./workflow-sync.js");
        await preserveFailedWorkflowAttemptsBeforeReset({
          projectRoot,
          runId,
          env: lifecycleEnvironment,
          inspection
        });
      },
      relaunchPaths: {
        runRoot: layout.root,
        logsDir: path.join(smithersRoot, "logs")
      },
      keepWorkspaces: config?.run.keepWorkspaces ?? false,
      controllerLeaseSeconds: config?.run.controllerLeaseSeconds ?? 60,
      env: nativeSmithersContinuationEnvironment(lifecycleEnvironment),
      prepareContinuationEnvironment: () => {
        const claimsSealedControl =
          workflow.control_generation !== undefined || workflow.control_integrity_path !== undefined;
        if (!claimsSealedControl && pathIsMissing(workflowControlPaths(projectRoot, layout).integrityPath)) {
          return nativeSmithersContinuationEnvironment(lifecycleEnvironment);
        }
        return nativeSmithersContinuationEnvironment({
          ...lifecycleEnvironment,
          ULTRAFUZZ_DATA_GOVERNANCE_PATH: authenticatedContinuationGovernancePath(
            projectRoot,
            layout,
            workflow.control_generation
          )
        });
      },
      environmentVariableNames: mergeEnvironmentVariableNames(
        config === undefined ? [] : agentEnvironmentVariableNames(config, agentRefs, continuedEnvironment),
        ["ULTRAFUZZ_PROVIDER_CREDENTIAL_ENV_NAMES", "ULTRAFUZZ_SENSITIVE_AGENT_ENV_NAMES"],
        forgeGuard.environmentVariableNames,
        trustedCli.environmentVariableNames
      )
    });
    recordNativeContinuationState({
      layout,
      config,
      requestedConcurrency: input.maxConcurrency,
      alreadyRunning: result.alreadyRunning ?? false
    });
    return runtimeResult(true, {
      run_id: runId,
      workflow_run_id: smithersRunId,
      action: "resume" as const,
      submitted: !result.alreadyRunning
    });
  } catch (error) {
    return runtimeFailure<WorkflowLifecycleValue>([smithersDiagnostic(error, "WORKFLOW_LIFECYCLE_FAILED")]);
  } finally {
    await releaseLifecycleLock?.();
  }
}

function hasRetainedResetControlAuthority(
  projectRoot: string,
  layout: RunLayout,
  workflow: Record<string, unknown>
): boolean {
  if (Object.hasOwn(workflow, "control_generation") || Object.hasOwn(workflow, "control_integrity_path")) return true;
  try {
    fs.lstatSync(workflowControlPaths(projectRoot, layout).integrityPath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function parseContinuationResolvedConfigBytes(bytes: Uint8Array): ResolvedConfig {
  try {
    return parseResolvedConfigJsonBytes(bytes);
  } catch (error) {
    // `run.maxParallelNodes` was persisted by resolved-config v3 before #936
    // removed the unused key without changing the document version. Project a
    // read-only copy through the current parser; never rewrite the historical
    // bytes and never make the retired setting part of continuation behavior.
    const document = objectRecord(parseStrictJsonBytes(bytes));
    const run = objectRecord(document.run);
    if (!Object.hasOwn(run, "maxParallelNodes")) throw error;
    const projected = { ...document, run: { ...run } };
    delete projected.run.maxParallelNodes;
    return parseResolvedConfigJsonBytes(Buffer.from(JSON.stringify(projected), "utf8"));
  }
}

function readContinuationExpandedGraph(layout: RunLayout): unknown {
  for (const graphPath of [path.join(layout.root, "smithers", "expanded-graph.json"), layout.graphPath]) {
    try {
      assertRegularFileInside(layout.root, graphPath, "workflow graph");
      const graph = parseStrictJsonBytes(readRegularFileSnapshot(graphPath, 128 * 1024 * 1024));
      if (Object.keys(objectRecord(objectRecord(graph).groups)).length > 0) return graph;
    } catch {
      // Continue to the canonical run graph when the Smithers copy is absent,
      // unreadable, or from an unsupported schema generation.
    }
  }
  // Graph provenance only restores failure-policy rendering when available.
  // Its absence must not become refresh authorization.
  return undefined;
}

function recordNativeContinuationState(input: {
  layout: RunLayout;
  config: ResolvedConfig | undefined;
  requestedConcurrency: number | undefined;
  alreadyRunning: boolean;
}): void {
  try {
    const submittedAt = new Date().toISOString();
    const submittedAtMs = Date.parse(submittedAt);
    const state = readRunState(input.layout);
    if (state.status !== "running") state.last_transition_at = submittedAt;
    state.status = "running";
    state.started_at ??= submittedAt;
    delete state.finished_at;
    if (!input.alreadyRunning) {
      const leaseDurationMs =
        (input.config?.run.controllerLeaseSeconds ?? Math.max(1, state.controller_lease.duration_ms / 1_000)) * 1_000;
      state.controller_lease = {
        ...state.controller_lease,
        status: "active",
        duration_ms: leaseDurationMs,
        renewed_at: submittedAt,
        expires_at: new Date(submittedAtMs + leaseDurationMs).toISOString()
      };
      state.concurrency.requested_concurrency =
        input.requestedConcurrency ?? input.config?.run.maxParallelAgents ?? state.concurrency.requested_concurrency;
    }
    if (input.config !== undefined) {
      state.workflow_deadline_at = new Date(
        submittedAtMs + input.config.run.workflowDeadlineSeconds * 1_000
      ).toISOString();
    } else if (state.workflow_deadline_at !== undefined && Date.parse(state.workflow_deadline_at) <= submittedAtMs) {
      // A legacy run without readable config cannot supply a fresh duration.
      // Do not let its already-expired historical deadline cancel the Smithers
      // continuation that was just accepted.
      delete state.workflow_deadline_at;
    }
    writeRunState(input.layout, state);
  } catch {
    // Mutable Ultrafuzz projection is best effort after Smithers accepts the
    // continuation. Malformed legacy state must not become a new hard gate.
  }
}

export async function replayRun(input: WorkflowLifecycleInput) {
  return submitLifecycleAction(input, "replay");
}

export async function forkRun(input: WorkflowLifecycleInput) {
  return submitLifecycleAction(input, "fork");
}

export async function pauseRun(input: PauseRunInput) {
  const projectRoot = path.resolve(input.projectRoot);
  const evidence = await readLinkedWorkflowEvidence(projectRoot, input.runId);
  if (!evidence.ok) {
    return runtimeFailure<PauseRunValue>(evidence.diagnostics);
  }
  try {
    const result = await requestSmithersPause({
      smithersRunId: evidence.smithersRunId,
      projectRoot,
      env: linkedWorkflowExecutionEnvironment(evidence, input.env)
    });
    if (result.status === "paused") {
      updateRunStatus(evidence.layout, "paused");
    }
    if (result.status === "paused") {
      appendEvent(evidence.layout, {
        eventType: "workflow-lifecycle-already-paused",
        status: "paused",
        payload: {
          action: "pause",
          workflow_run_id: evidence.smithersRunId
        }
      });
    } else {
      appendEvent(evidence.layout, {
        eventType: "workflow-pause-requested",
        status: "running",
        payload: {
          action: "pause",
          workflow_run_id: evidence.smithersRunId
        }
      });
    }
    return runtimeResult(true, {
      run_id: input.runId,
      workflow_run_id: evidence.smithersRunId,
      action: "pause" as const,
      status: result.status,
      submitted: result.status === "pause-requested"
    });
  } catch (error) {
    return runtimeFailure<PauseRunValue>([smithersDiagnostic(error, "WORKFLOW_PAUSE_FAILED")]);
  }
}

function workflowSubmissionFailureEventPayload(
  diagnostic: RuntimeDiagnostic
): Extract<AppendEventInput, { eventType: "workflow-submit-failed" }>["payload"] {
  if (!isWorkflowSubmissionFailureEventPayload(diagnostic)) {
    throw new Error("workflow submission diagnostic does not match the current event contract");
  }
  return diagnostic;
}

function isWorkflowSubmissionFailureEventPayload(
  diagnostic: RuntimeDiagnostic
): diagnostic is RuntimeDiagnostic & Extract<AppendEventInput, { eventType: "workflow-submit-failed" }>["payload"] {
  if (
    diagnostic.code !== "WORKFLOW_SUBMISSION_FAILED" ||
    diagnostic.severity !== "error" ||
    diagnostic.source !== "workflow" ||
    Object.keys(diagnostic).some((key) => !["code", "message", "severity", "source", "details"].includes(key)) ||
    diagnostic.details === undefined ||
    diagnostic.details === null ||
    Array.isArray(diagnostic.details)
  ) {
    return false;
  }
  const details = diagnostic.details;
  if (Object.keys(details).some((key) => !["exit_code", "signal", "killed", "stdout", "stderr"].includes(key))) {
    return false;
  }
  return (
    (details.exit_code === undefined ||
      typeof details.exit_code === "string" ||
      (typeof details.exit_code === "number" && Number.isFinite(details.exit_code))) &&
    (details.signal === undefined || typeof details.signal === "string") &&
    (details.killed === undefined || typeof details.killed === "boolean") &&
    (details.stdout === undefined || typeof details.stdout === "string") &&
    (details.stderr === undefined || typeof details.stderr === "string")
  );
}

async function submitLifecycleAction(input: WorkflowLifecycleInput, action: "replay" | "fork") {
  if (action === "fork" && input.forkFrame === undefined) {
    return runtimeFailure<WorkflowLifecycleValue>([
      {
        code: "WORKFLOW_FORK_FRAME_REQUIRED",
        message: "fork requires a checkpoint frame",
        severity: "error",
        source: "runtime"
      }
    ]);
  }

  let releaseLifecycleLock: (() => Promise<void>) | undefined;
  try {
    let evidence = await readLinkedWorkflowEvidence(input.projectRoot, input.runId);
    if (!evidence.ok) return runtimeFailure<WorkflowLifecycleValue>(evidence.diagnostics);
    releaseLifecycleLock = await acquireWorkflowLifecycleLock(evidence.layout);
    const lockedEvidence = await readLinkedWorkflowEvidence(input.projectRoot, input.runId);
    if (!lockedEvidence.ok) return runtimeFailure<WorkflowLifecycleValue>(lockedEvidence.diagnostics);
    evidence = lockedEvidence;
    const sealedConfig = parseSealedResolvedConfig(evidence.verifiedControl.executionFiles);
    const sealedGraph = parseSealedExpandedGraph(evidence.verifiedControl.contents.expanded_graph);
    const taskDocument = parseSealedTaskManifest(evidence.verifiedControl.contents);
    const preflightDiagnostics = await requiredCommandPreflightDiagnostics(input, sealedConfig, sealedGraph);
    if (hasRuntimeErrors(preflightDiagnostics)) {
      return runtimeFailure<WorkflowLifecycleValue>(preflightDiagnostics);
    }
    const requestedConcurrency = input.maxConcurrency ?? sealedConfig.run.maxParallelAgents;
    const forgeGuard = prepareForgeGuardEnvironment({
      layout: evidence.layout,
      config: sealedConfig,
      env: input.env
    });
    persistForgeGuardMetadata(evidence.layout, sealedConfig, forgeGuard.active);
    const trustedCli = prepareTrustedCliEnvironment({
      layout: evidence.layout,
      cliEntrypoint: input.ultrafuzzCliEntrypoint,
      executionSnapshotRoot: evidence.executionSnapshot.root,
      env: forgeGuard.env,
      required: sealedTasksRequireTrustedCli(evidence.verifiedControl.contents.tasks)
    });
    runTrustedJsonValidatorPreflight({ layout: evidence.layout, trusted: trustedCli });
    const linkedAgentRefs = taskDocument.tasks.flatMap((task) => task.agentChain.map((profile) => profile.agentRef));
    const providerCredentialNames = agentCredentialEnvironmentVariableNames(sealedConfig, linkedAgentRefs);
    const lifecycleEnvironment = {
      ...process.env,
      ...linkedWorkflowExecutionEnvironment(evidence, trustedCli.env, providerCredentialNames)
    };
    assertProviderScopedSensitiveEnvironmentCapability(
      evidence.controllerSnapshot.executionFiles,
      lifecycleEnvironment.ULTRAFUZZ_SENSITIVE_AGENT_ENV_NAMES
    );
    assertCurrentCloudAgentCredentialEnvironment(sealedConfig, taskDocument.tasks, lifecycleEnvironment);
    const controllerInvocation = appendEvent(evidence.layout, {
      eventType: "workflow-lifecycle-invoking",
      status: "running",
      payload: {
        action,
        workflow_run_id: evidence.smithersRunId,
        control_generation: evidence.controlGeneration,
        workflow_link_id: evidence.workflowLinkId
      }
    });
    const lifecycleResult = await runSmithersLifecycleCommand({
      action,
      smithersRunId: evidence.smithersRunId,
      workflowPath: evidence.workflowPath,
      projectRoot: path.resolve(input.projectRoot),
      maxConcurrency: requestedConcurrency,
      forkFrame: input.forkFrame,
      resetNode: input.resetNode,
      force: input.force,
      label: input.label,
      // Recovery consumes the already-materialized sealed input bytes. The
      // evidence directory remains mutable only for recovery receipts and logs.
      relaunchPaths: {
        runRoot: evidence.layout.root,
        inputJson: evidence.executionSnapshot.inputJson,
        logsDir: path.join(evidence.layout.root, "smithers", "logs")
      },
      keepWorkspaces: sealedConfig.run.keepWorkspaces,
      controllerLeaseSeconds: sealedConfig.run.controllerLeaseSeconds,
      env: lifecycleEnvironment,
      environmentVariableNames: mergeEnvironmentVariableNames(
        linkedWorkflowEnvironmentVariableNames(sealedConfig, evidence.verifiedControl.contents.tasks, forgeGuard.env),
        ["ULTRAFUZZ_PROVIDER_CREDENTIAL_ENV_NAMES", "ULTRAFUZZ_SENSITIVE_AGENT_ENV_NAMES"],
        forgeGuard.environmentVariableNames,
        trustedCli.environmentVariableNames
      )
    });
    const workflowRunId = lifecycleResult.workflowRunId ?? evidence.smithersRunId;
    const lifecycleResultEvent = appendEvent(evidence.layout, {
      eventType: "workflow-lifecycle-result",
      status: "running",
      payload: {
        action,
        source_workflow_run_id: evidence.smithersRunId,
        source_workflow_link_id: evidence.workflowLinkId,
        workflow_run_id: workflowRunId,
        control_generation: evidence.controlGeneration,
        controller_invocation_id: controllerInvocation.event_id,
        controller_invoked_at: controllerInvocation.timestamp
      }
    });
    const linkedWorkflow = await updateLinkedWorkflowRunId(evidence.layout, workflowRunId, {
      action,
      sourceWorkflowRunId: evidence.smithersRunId,
      sourceWorkflowLinkId: evidence.workflowLinkId,
      controlGeneration: evidence.controlGeneration,
      controllerInvocationId: controllerInvocation.event_id,
      controllerInvokedAt: controllerInvocation.timestamp,
      lifecycleResultEventId: lifecycleResultEvent.event_id,
      lifecycleResultAt: lifecycleResultEvent.timestamp
    });
    const submittedAt = new Date().toISOString();
    if (!lifecycleResult.alreadyRunning) {
      const state = readRunState(evidence.layout);
      const leaseDurationMs = sealedConfig.run.controllerLeaseSeconds * 1_000;
      state.concurrency.requested_concurrency = requestedConcurrency;
      state.controller_lease = {
        ...state.controller_lease,
        status: "active",
        duration_ms: leaseDurationMs,
        renewed_at: submittedAt,
        expires_at: new Date(Date.parse(submittedAt) + leaseDurationMs).toISOString()
      };
      state.workflow_deadline_at = new Date(
        Date.parse(submittedAt) + sealedConfig.run.workflowDeadlineSeconds * 1_000
      ).toISOString();
      state.last_transition_at = submittedAt;
      writeRunState(evidence.layout, state);
    }
    updateRunStatus(evidence.layout, "running", submittedAt);
    appendEvent(evidence.layout, {
      eventType: lifecycleResult.alreadyRunning ? "workflow-lifecycle-already-running" : "workflow-lifecycle-submitted",
      status: "running",
      payload: {
        action,
        workflow_run_id: workflowRunId,
        workflow_link_id: linkedWorkflow.link_id,
        control_generation: evidence.controlGeneration,
        controller_invocation_id: controllerInvocation.event_id,
        controller_invoked_at: controllerInvocation.timestamp,
        ...(input.resetNode !== undefined ? { reset_node: input.resetNode } : {})
      }
    });
    return runtimeResult(
      true,
      {
        run_id: input.runId,
        workflow_run_id: workflowRunId,
        action,
        submitted: !lifecycleResult.alreadyRunning
      },
      preflightDiagnostics
    );
  } catch (error) {
    return runtimeFailure<WorkflowLifecycleValue>([smithersDiagnostic(error, "WORKFLOW_LIFECYCLE_FAILED")]);
  } finally {
    await releaseLifecycleLock?.();
  }
}

function sealedTasksRequireTrustedCli(contents: Buffer): boolean {
  return parseSmithersTaskManifestBytes(contents).tasks.some((task) =>
    task.metadata.artifacts.outputs.some((output) => output.schemaFile !== undefined)
  );
}

function parseSealedTaskManifest(contents: Readonly<{ graph: Buffer; tasks: Buffer }>): SmithersTaskManifestDocument {
  const graph = assertSealedPlannedGraph(parseStrictJsonBytes(contents.graph));
  const manifest = parseSmithersTaskManifestBytes(contents.tasks);
  assertSmithersTaskManifestMatchesPlannedGraph(manifest, graph);
  return manifest;
}

/**
 * `assertSmithersTaskManifestMatchesPlannedGraph` is a re-derivation of the compiled plan, not a
 * verification of the seal: it re-runs the compiler's cross-document gates over the sealed graph and
 * task plan and insists the two still agree. Every digest in the seal can match while that
 * re-derivation disagrees, because the disagreement is between two control files rather than between
 * a control file and its recorded digest. Refusing to execute such a run is right — its plan is no
 * longer self-consistent, so scheduling from it is guesswork. Refusing to *report* on it is not, and
 * that is what happened: a dependency-set mismatch on the node that joins every finding producer made
 * `ultrafuzz status` fail on all twelve runs of a campaign, so the one supported way to observe a
 * partially failed run was exactly the thing it broke (issue #866). It also defeated the read-only
 * tolerance issue #674 added, which `getRunHealth` opts into and which never reached this far.
 *
 * An observer therefore keeps the manifest it can still parse and hands the mismatch back as a control
 * divergence, which `getRunHealth` already knows how to render: a `WORKFLOW_CONTROL_EVIDENCE_DIVERGED`
 * warning, no state synchronization, and a `WORKFLOW_STATE_SYNC_SKIPPED` note that the reported counts
 * come from the workflow runner. Nothing structural is relaxed — the sealed graph and the task manifest
 * must still parse against their schemas, and every identity check the caller runs against the returned
 * manifest still fails closed. Only the cross-document re-derivation is downgraded, and only for callers
 * that asked for tolerance.
 */
function parseSealedTaskManifestForObserver(contents: Readonly<{ graph: Buffer; tasks: Buffer }>): {
  document: SmithersTaskManifestDocument;
  divergences: readonly string[];
} {
  const sealedGraph = parseSealedPlannedGraphForObserver(contents.graph);
  const document = parseSmithersTaskManifestBytes(contents.tasks);
  if (sealedGraph.divergences.length > 0) {
    // The graph no longer re-derives, so the cross-document gate below would only restate that in a
    // second, less specific message. Report the cause once.
    return { document, divergences: sealedGraph.divergences };
  }
  try {
    assertSmithersTaskManifestMatchesPlannedGraph(document, sealedGraph.graph);
  } catch (error) {
    return {
      document,
      divergences: [
        `sealed task manifest no longer re-derives from its planned graph: ${error instanceof Error ? error.message : String(error)}`
      ]
    };
  }
  return { document, divergences: [] };
}

/**
 * `assertSealedPlannedGraph` does two different jobs behind one name. The first is structural: the
 * bytes must validate against the planned-graph schema, and nothing can report on a document that is
 * not a planned graph at all. The second, `assertPlannedGraphSemantics`, re-derives the graph against
 * *this build* — it looks every output contract up in the running process's artifact-contract registry
 * and insists the digests, schema IDs and validator build recorded at compile time still match what
 * this checkout produces.
 *
 * That second job is not a property of the run; it is a property of the tree observing the run. An
 * operator whose checkout has moved on since the run was submitted -- a rebased branch, a newer
 * release, a contract whose schema was revised -- gets `planned graph output schema binding changed`
 * and loses `status` for a run that is otherwise intact and possibly still executing. That is the same
 * failure as issue #866, one throw further along the same read-only path: the run is fine, the
 * observer's registry disagrees, and the operator is the one punished. `packages/artifacts`'s own
 * semantic-gate collects exactly this condition as an issue rather than raising it, so the softer
 * reading already exists in the codebase.
 *
 * Execution must still refuse: running a node whose output contract no longer matches the registry
 * that will validate its artifacts would produce evidence nothing can check. So the downgrade is
 * observer-only, and schema invalidity stays fatal for everyone.
 */
function parseSealedPlannedGraphForObserver(graphBytes: Buffer): {
  graph: PlannedGraphDocument;
  divergences: readonly string[];
} {
  const value = parseStrictJsonBytes(graphBytes);
  // Structural, so not tolerated. `assertSealedPlannedGraph` raises the canonical schema message.
  if (!validatePlannedGraph(value).ok) return { graph: assertSealedPlannedGraph(value), divergences: [] };
  const graph = value as PlannedGraphDocument;
  try {
    assertPlannedGraphSemantics(graph, { allowHistoricalSchemaBundle: true });
  } catch (error) {
    return {
      graph,
      divergences: [
        `sealed planned graph no longer re-derives against this build's artifact contracts: ${error instanceof Error ? error.message : String(error)}`
      ]
    };
  }
  return { graph, divergences: [] };
}

async function persistSmithersEvidence(
  layout: RunLayout,
  graph: PlannedGraph,
  compiled: CompiledSmithersWorkflow,
  env: Record<string, string | undefined> | undefined,
  forbiddenSecretValues: readonly string[]
): Promise<{
  verifiedControl: VerifiedWorkflowControlSnapshot;
  executionSnapshot: MaterializedWorkflowExecutionSnapshot;
  workflowLinkId: string;
}> {
  const tasksByConcrete = new Map<string, string[]>();
  for (const task of compiled.tasks) {
    const existing = tasksByConcrete.get(task.concreteNodeId) ?? [];
    existing.push(task.smithersNodeId);
    tasksByConcrete.set(task.concreteNodeId, existing);
  }
  for (const node of graph.nodes) {
    const taskNodeIds = tasksByConcrete.get(node.id) ?? [];
    if (taskNodeIds.length > 0) {
      node.workflow = {
        node_id: taskNodeIds[0]!,
        task_node_ids: taskNodeIds
      };
    }
  }
  assertPlannedGraph(graph);
  const taskManifest = parseSmithersTaskManifestBytes(fs.readFileSync(compiled.tasksPath));
  assertSmithersTaskManifestMatchesPlannedGraph(taskManifest, graph);
  writeJsonDurable(layout.graphPath, graph);

  const executionFiles = await smithersExecutionControlFiles(compiled, layout, env);
  sealWorkflowControlFiles({
    projectRoot: compiled.projectRoot,
    layout,
    workflowPath: compiled.workflowPath,
    expandedGraphPath: compiled.expandedGraphPath,
    configPath: compiled.configPath,
    evidenceWorkflowPath: compiled.evidenceWorkflowPath,
    tasksPath: compiled.tasksPath,
    inputPath: compiled.inputPath,
    executionFiles
  });
  const verifiedControl = verifyWorkflowControlSnapshot(compiled.projectRoot, layout);
  assertControllerExecutionSnapshotDigest(verifiedControl.executionFiles, compiled.controllerSourceDigest);
  if (compiled.dataGovernance === undefined) throw new Error("compiled workflow is missing data governance");
  assertSealedDataGovernance(verifiedControl.executionFiles, compiled.dataGovernance, compiled.runId);
  const executionSnapshot = materializeWorkflowExecutionSnapshot({
    projectRoot: compiled.projectRoot,
    layout,
    snapshot: verifiedControl
  });
  const workflowLink = prepareWorkflowRunLink(layout, {
    action: "start",
    workflowRunId: compiled.smithersRunId,
    controlGeneration: verifiedControl.generation
  });

  const metadata = readRunMetadataDocument(layout.runMetadataPath, layout.runId);
  const { execution_reconciliation: _priorReconciliation, ...metadataWithoutReconciliation } = metadata;
  writeRunMetadataDocument(layout.runMetadataPath, {
    ...metadataWithoutReconciliation,
    workflow_ids: [compiled.smithersRunId],
    workflow: {
      run_id: compiled.smithersRunId,
      compiled_run_id: compiled.smithersRunId,
      name: compiled.workflowName,
      path: projectRelativePath(compiled.projectRoot, verifiedControl.paths.workflowPath),
      evidence_path: runRelativePath(layout, verifiedControl.paths.evidenceWorkflowPath),
      expanded_graph_path: runRelativePath(layout, verifiedControl.paths.expandedGraphPath),
      config_path: runRelativePath(layout, verifiedControl.paths.configPath),
      input_path: runRelativePath(layout, verifiedControl.paths.inputPath),
      tasks_path: runRelativePath(layout, verifiedControl.paths.tasksPath),
      control_integrity_path: runRelativePath(layout, verifiedControl.paths.integrityPath),
      control_generation: verifiedControl.generation,
      workflow_link_id: workflowLink.link_id,
      execution_snapshot_path: runRelativePath(layout, executionSnapshot.root),
      task_node_ids: compiled.tasks.map((task) => task.smithersNodeId)
    }
  });

  const state = readRunState(layout);
  state.provenance = {
    ...(state.provenance ?? {}),
    workflow: {
      inspection: { runId: compiled.smithersRunId },
      runId: compiled.smithersRunId,
      compiledRunId: compiled.smithersRunId,
      name: compiled.workflowName,
      controlGeneration: verifiedControl.generation,
      linkId: workflowLink.link_id,
      executionSnapshot: runRelativePath(layout, executionSnapshot.root)
    }
  };
  writeRunState(layout, state, { forbiddenSecretValues });
  const committedWorkflowLink = finalizeWorkflowRunLink(layout, workflowLink);
  return { verifiedControl, executionSnapshot, workflowLinkId: committedWorkflowLink.link_id };
}

/**
 * run.json and state.json are republished by atomic rename while a run is live, by its controller and
 * by observe-only synchronization from a concurrent `status`, and every strict reader below reports a
 * replacement it straddled as a mid-read change. An observer holds no control lock, so for it that is
 * a transient race, not evidence of anything: the evidence is derived again (`observationAttempt`
 * counts the derivations), within the bounded observation budget, and only an exhausted budget is
 * reported, as the race and naming the document. Execution callers hold the lock; for them the same
 * detection is a violation and keeps failing closed on the first read.
 */
export async function readLinkedWorkflowEvidence(
  projectRoot: string,
  runId: string,
  options: ReadLinkedWorkflowEvidenceOptions = {},
  observationAttempt = 1
): Promise<LinkedWorkflowEvidence | LinkedWorkflowEvidenceFailure> {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const runsRoot = await runsRootForProject(resolvedProjectRoot);
  let metadataPath: string;
  let layout: RunLayout;
  try {
    const safeRunId = validateSafeId(runId, "run ID");
    layout = layoutForRunRoot(path.join(runsRoot, safeRunId), safeRunId);
    assertPathInside(runsRoot, layout.root, "run root");
    if (fs.existsSync(runsRoot)) {
      assertNoSymlinkComponents(runsRoot, layout.root, "run root");
    }
    metadataPath = layout.runMetadataPath;
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "RUN_ID_INVALID",
          message: error instanceof Error ? error.message : String(error),
          severity: "error",
          source: "runtime"
        }
      ]
    };
  }
  if (!fs.existsSync(metadataPath)) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "RUN_METADATA_MISSING",
          message: `run metadata not found for ${runId}`,
          severity: "error",
          source: "runtime",
          path: metadataPath
        }
      ]
    };
  }
  let releaseControlLock: (() => Promise<void>) | undefined;
  try {
    if (options.observeOnly !== true) {
      releaseControlLock = await acquireWorkflowControlLock(layout);
    }
    const missingEvidence = missingLinkedWorkflowEvidenceDiagnostic(resolvedProjectRoot, layout);
    if (missingEvidence !== undefined) {
      return { ok: false, diagnostics: [missingEvidence] };
    }
    if (options.observeOnly !== true) {
      reconcilePendingWorkflowRunLink(resolvedProjectRoot, layout);
    }
    const metadata = readRunMetadataDocument(metadataPath, runId);
    const workflow = metadata.workflow;
    if (workflow === undefined) {
      return {
        ok: false,
        diagnostics: [
          {
            code: "WORKFLOW_RUN_ID_MISSING",
            message: `run ${runId} is not linked to a workflow run`,
            severity: "error",
            source: "workflow",
            path: metadataPath
          }
        ]
      };
    }
    const smithersRunId = workflow.run_id;
    if (smithersRunId.includes("\0")) throw new Error("active workflow run ID contains a NUL byte");
    if (
      !Array.isArray(metadata.workflow_ids) ||
      metadata.workflow_ids.length !== 1 ||
      metadata.workflow_ids[0] !== smithersRunId
    ) {
      throw new Error("run metadata workflow IDs do not exactly match the active workflow run");
    }

    // Observers pass `tolerateControlDivergence` so a divergent control file downgrades to a reported
    // warning instead of hiding a live run entirely (issue #674). Execution callers omit it and keep
    // failing closed.
    const tolerateDivergence = options.tolerateControlDivergence === true;
    const verifiedControl = verifyWorkflowControlSnapshot(resolvedProjectRoot, layout, { tolerateDivergence });
    // A live document replaced under the completeness re-derivation is a transient race, not a
    // divergence of the sealed controls. Recording it as one would have `status` report a healthy run
    // as diverged and skip its synchronization; thrown instead, the observer derives the evidence again.
    const racedDivergence =
      options.observeOnly === true ? verifiedControl.divergences.find(isTransientSnapshotRaceMessage) : undefined;
    if (racedDivergence !== undefined) throw new Error(racedDivergence);
    const sealedPlan = verifiedControl.executionFiles.find((file) => file.snapshotPath === "controls/plan.json");
    if (sealedPlan === undefined) throw new Error("sealed workflow is missing its run plan");
    const plan = assertRunPlanDocument(parseStrictJsonBytes(sealedPlan.contents), runId);
    assertControllerExecutionSnapshotDigest(verifiedControl.executionFiles, plan.controller_source_digest);
    assertSealedDataGovernance(verifiedControl.executionFiles, plan.data_governance, runId);
    const sealedTaskManifest = tolerateDivergence
      ? parseSealedTaskManifestForObserver(verifiedControl.contents)
      : { document: parseSealedTaskManifest(verifiedControl.contents), divergences: [] as readonly string[] };
    const taskDocument = sealedTaskManifest.document;
    // Every downgrade this function performs is reported on one channel, next to the digest
    // divergences `verifyWorkflowControlSnapshot` collected, so `getRunHealth` degrades through the
    // single path it already has and a caller has one place to look.
    const observerDivergences: string[] = [...sealedTaskManifest.divergences];
    const compiledRunId = workflow.compiled_run_id;
    if (
      typeof compiledRunId !== "string" ||
      taskDocument.smithers_run_id !== compiledRunId ||
      taskDocument.run_id !== runId
    ) {
      throw new Error("compiled workflow identity does not match the sealed task manifest");
    }
    const controller = effectiveControllerGeneration(layout, verifiedControl);
    const startupControlDrift = tolerateDivergence
      ? sealedBunStartupControlDrift(controller.snapshot.executionFiles)
      : undefined;
    if (startupControlDrift !== undefined) observerDivergences.push(startupControlDrift);
    const executionSnapshot = materializeWorkflowExecutionSnapshot({
      projectRoot: resolvedProjectRoot,
      layout,
      snapshot: controller.snapshot,
      authorizedGenerations: controller.authorizedGenerations,
      ...(options.observeOnly === true ? { observeOnly: true } : {}),
      ...(startupControlDrift === undefined ? {} : { tolerateStartupControlDrift: true })
    });
    const expectedWorkflowFields: Record<string, string> = {
      path: projectRelativePath(resolvedProjectRoot, verifiedControl.paths.workflowPath),
      evidence_path: runRelativePath(layout, verifiedControl.paths.evidenceWorkflowPath),
      expanded_graph_path: runRelativePath(layout, verifiedControl.paths.expandedGraphPath),
      config_path: runRelativePath(layout, verifiedControl.paths.configPath),
      input_path: runRelativePath(layout, verifiedControl.paths.inputPath),
      tasks_path: runRelativePath(layout, verifiedControl.paths.tasksPath),
      control_integrity_path: runRelativePath(layout, verifiedControl.paths.integrityPath),
      control_generation: verifiedControl.generation,
      execution_snapshot_path: runRelativePath(
        layout,
        path.join(layout.root, "smithers", "execution-snapshots", verifiedControl.generation)
      )
    };
    const workflowRecord = workflow as unknown as Record<string, unknown>;
    for (const [key, expected] of Object.entries(expectedWorkflowFields)) {
      if (workflowRecord[key] !== expected) {
        throw new Error(`stored workflow ${key.replaceAll("_", " ")} does not match its sealed control path`);
      }
    }
    if (workflow.name !== taskDocument.workflow_name) {
      throw new Error("stored workflow name does not match the sealed task manifest");
    }
    const state = readRunState(layout);
    const stateWorkflow = objectRecord(objectRecord(state.provenance).workflow);
    if (
      stateWorkflow.runId !== smithersRunId ||
      objectRecord(stateWorkflow.inspection).runId !== smithersRunId ||
      stateWorkflow.compiledRunId !== compiledRunId ||
      stateWorkflow.name !== taskDocument.workflow_name ||
      stateWorkflow.controlGeneration !== verifiedControl.generation ||
      stateWorkflow.executionSnapshot !== expectedWorkflowFields.execution_snapshot_path
    ) {
      throw new Error("durable run state does not exactly match sealed workflow control evidence");
    }
    const linkHistory = verifyWorkflowRunLinkHistory(layout, {
      ...(options.observeOnly === true ? { allowPending: true } : {})
    });
    const initialWorkflowLink = linkHistory.initial;
    const activeWorkflowLink = linkHistory.current;
    if (
      initialWorkflowLink === undefined ||
      initialWorkflowLink.action !== "start" ||
      initialWorkflowLink.workflow_run_id !== compiledRunId ||
      initialWorkflowLink.control_generation !== verifiedControl.generation
    ) {
      throw new Error("initial workflow run link is not rooted in the sealed compiled workflow");
    }
    if (
      activeWorkflowLink === undefined ||
      activeWorkflowLink.workflow_run_id !== smithersRunId ||
      activeWorkflowLink.control_generation !== verifiedControl.generation ||
      workflow.workflow_link_id !== activeWorkflowLink.link_id ||
      stateWorkflow.linkId !== activeWorkflowLink.link_id
    ) {
      throw new Error("active workflow run is not exactly cross-bound to its control and link journals");
    }
    return {
      ok: true,
      smithersRunId,
      layout,
      controlGeneration: verifiedControl.generation,
      controllerGeneration: controller.controllerGeneration,
      workflowLinkId: activeWorkflowLink.link_id,
      verifiedControl:
        observerDivergences.length === 0
          ? verifiedControl
          : { ...verifiedControl, divergences: [...verifiedControl.divergences, ...observerDivergences] },
      controllerSnapshot: controller.snapshot,
      workflowPath: executionSnapshot.workflowPath,
      executionSnapshot
    };
  } catch (error) {
    if (options.observeOnly === true && isTransientSnapshotRace(error)) {
      if (observationAttempt < OBSERVATION_SNAPSHOT_ATTEMPTS) {
        return await readLinkedWorkflowEvidence(projectRoot, runId, options, observationAttempt + 1);
      }
      return invalidLinkedWorkflowEvidence(metadataPath, exhaustedSnapshotRaceError(observationAttempt, error));
    }
    return invalidLinkedWorkflowEvidence(metadataPath, error);
  } finally {
    await releaseControlLock?.();
  }
}

function invalidLinkedWorkflowEvidence(metadataPath: string, error: unknown): LinkedWorkflowEvidenceFailure {
  return {
    ok: false,
    diagnostics: [
      {
        code: "WORKFLOW_CONTROL_EVIDENCE_INVALID",
        message: error instanceof Error ? error.message : String(error),
        severity: "error",
        source: "workflow",
        path: metadataPath
      }
    ]
  };
}

/**
 * A pending state records incomplete launch preparation, not launcher liveness.
 * It also survives an interrupted launch. Unreadable state retains the strict
 * missing-seal diagnostic.
 */
function runStatusIsPreSubmission(layout: RunLayout): boolean {
  try {
    return readRunState(layout).status === "pending";
  } catch {
    return false;
  }
}

function missingLinkedWorkflowEvidenceDiagnostic(
  projectRoot: string,
  layout: RunLayout
): RuntimeDiagnostic | undefined {
  const controlSealPath = workflowControlPaths(projectRoot, layout).integrityPath;
  if (pathIsMissing(controlSealPath)) {
    if (runStatusIsPreSubmission(layout)) {
      return {
        code: "WORKFLOW_CONTROL_SEAL_PENDING",
        message: `run ${layout.runId} has incomplete launch preparation: its workflow control seal has not been written. Launcher liveness is unknown. If the original launch is still active, wait for it to finish; otherwise inspect its error before retrying`,
        severity: "warning",
        source: "workflow",
        path: controlSealPath
      };
    }
    return {
      code: "WORKFLOW_CONTROL_SEAL_MISSING",
      message: `run ${layout.runId} lacks the required workflow control seal; it may predate sealed runs or be incomplete and cannot be safely upgraded in place. Preserve its stored artifacts and start a new run with a new run ID`,
      severity: "error",
      source: "workflow",
      path: controlSealPath
    };
  }
  const linkJournalPath = workflowRunLinkJournalPath(layout);
  if (pathIsMissing(linkJournalPath)) {
    return {
      code: "WORKFLOW_RUN_LINK_JOURNAL_MISSING",
      message: `run ${layout.runId} lacks the required authenticated workflow-link journal; it may predate authenticated lifecycle links or be incomplete and cannot be safely upgraded in place. Preserve its stored artifacts and start a new run with a new run ID`,
      severity: "error",
      source: "workflow",
      path: linkJournalPath
    };
  }
  return undefined;
}

function pathIsMissing(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}

async function updateLinkedWorkflowRunId(
  layout: RunLayout,
  workflowRunId: string,
  input: {
    action: Exclude<WorkflowRunLinkAction, "start">;
    sourceWorkflowRunId: string;
    sourceWorkflowLinkId: string;
    controlGeneration: string;
    controllerInvocationId: string;
    controllerInvokedAt: string;
    lifecycleResultEventId: string;
    lifecycleResultAt: string;
  }
): Promise<WorkflowRunLinkJournalEntry> {
  const releaseControlLock = await acquireWorkflowControlLock(layout);
  try {
    const committedLink = verifyCommittedWorkflowRunLink(layout);
    if (
      committedLink.workflow_run_id !== input.sourceWorkflowRunId ||
      committedLink.link_id !== input.sourceWorkflowLinkId
    ) {
      throw new Error("workflow run link changed before its replacement was prepared");
    }
    if (committedLink.control_generation !== input.controlGeneration) {
      throw new Error("workflow run link control generation changed before replacement");
    }
    const metadata = readRunMetadataDocument(layout.runMetadataPath, layout.runId);
    const state = readRunState(layout);
    if (
      !metadataMatchesWorkflowRunLink(metadata, committedLink) ||
      !stateMatchesWorkflowRunLink(state, committedLink)
    ) {
      throw new Error("workflow run link projections changed before replacement");
    }
    if (workflowRunId === committedLink.workflow_run_id) return committedLink;

    const workflowLink = prepareWorkflowRunLink(layout, {
      action: input.action,
      workflowRunId,
      sourceWorkflowRunId: input.sourceWorkflowRunId,
      sourceWorkflowLinkId: input.sourceWorkflowLinkId,
      controlGeneration: input.controlGeneration,
      controllerInvocationId: input.controllerInvocationId,
      controllerInvokedAt: input.controllerInvokedAt,
      lifecycleResultEventId: input.lifecycleResultEventId,
      lifecycleResultAt: input.lifecycleResultAt
    });
    writeLinkedWorkflowBinding(layout, metadata, state, workflowLink);
    return finalizeWorkflowRunLink(layout, workflowLink);
  } finally {
    await releaseControlLock();
  }
}

function reconcilePendingWorkflowRunLink(projectRoot: string, layout: RunLayout): void {
  const history = verifyWorkflowRunLinkHistory(layout, { allowPending: true });
  const pending = history.pending;
  if (pending === undefined) return;
  verifyWorkflowRunLinkAuthorization(layout, pending);

  const metadata = readRunMetadataDocument(layout.runMetadataPath, layout.runId);
  const state = readRunState(layout);
  if (pending.action === "start") {
    if (history.current !== undefined) throw new Error("initial workflow run link conflicts with committed history");
    const controlSnapshot = verifyWorkflowControlSnapshot(projectRoot, layout);
    const taskDocument = parseSealedTaskManifest(controlSnapshot.contents);
    if (
      taskDocument.smithers_run_id !== pending.workflow_run_id ||
      pending.control_generation !== controlSnapshot.generation
    ) {
      throw new Error("pending initial workflow run link is not rooted in sealed control evidence");
    }
    const executionSnapshot = materializeWorkflowExecutionSnapshot({
      projectRoot,
      layout,
      snapshot: controlSnapshot
    });
    const binding = initialWorkflowBinding(
      projectRoot,
      layout,
      controlSnapshot,
      executionSnapshot.root,
      taskDocument,
      pending
    );
    if (
      (!metadataIsPristineInitialWorkflowBinding(metadata) &&
        !metadataMatchesInitialWorkflowBinding(metadata, binding.metadataWorkflow)) ||
      (!stateIsPristineInitialWorkflowBinding(state) &&
        !stateMatchesInitialWorkflowBinding(state, binding.stateWorkflow))
    ) {
      throw new Error("pending initial workflow run link projections cannot be reconciled safely");
    }
    const { execution_reconciliation: _unboundReconciliation, ...metadataWithoutReconciliation } = metadata;
    writeRunMetadataDocument(layout.runMetadataPath, {
      ...metadataWithoutReconciliation,
      workflow_ids: [pending.workflow_run_id],
      workflow: binding.metadataWorkflow
    });
    state.provenance = { workflow: binding.stateWorkflow };
    writeRunState(layout, state);
    finalizeWorkflowRunLink(layout, pending);
    return;
  } else {
    const committed = history.current;
    if (
      committed === undefined ||
      pending.source_workflow_run_id !== committed.workflow_run_id ||
      pending.source_workflow_link_id !== committed.link_id ||
      pending.control_generation !== committed.control_generation
    ) {
      throw new Error("pending workflow run link does not extend committed history");
    }
    if (
      (!metadataMatchesWorkflowRunLink(metadata, committed) && !metadataMatchesWorkflowRunLink(metadata, pending)) ||
      (!stateMatchesWorkflowRunLink(state, committed) && !stateMatchesWorkflowRunLink(state, pending))
    ) {
      throw new Error("pending workflow run link projections cannot be reconciled safely");
    }
  }
  writeLinkedWorkflowBinding(layout, metadata, state, pending);
  finalizeWorkflowRunLink(layout, pending);
}

function initialWorkflowBinding(
  projectRoot: string,
  layout: RunLayout,
  controlSnapshot: VerifiedWorkflowControlSnapshot,
  executionSnapshotRoot: string,
  taskDocument: SmithersTaskManifestDocument,
  link: WorkflowRunLinkJournalEntry
): { metadataWorkflow: RunMetadataWorkflow; stateWorkflow: RunWorkflowProvenance } {
  const workflowName = taskDocument.workflow_name;
  const taskNodeIds = taskDocument.tasks.map((task) => task.smithersNodeId);
  const executionSnapshot = runRelativePath(layout, executionSnapshotRoot);
  return {
    metadataWorkflow: {
      run_id: link.workflow_run_id,
      compiled_run_id: link.workflow_run_id,
      name: workflowName,
      path: projectRelativePath(projectRoot, controlSnapshot.paths.workflowPath),
      evidence_path: runRelativePath(layout, controlSnapshot.paths.evidenceWorkflowPath),
      expanded_graph_path: runRelativePath(layout, controlSnapshot.paths.expandedGraphPath),
      config_path: runRelativePath(layout, controlSnapshot.paths.configPath),
      input_path: runRelativePath(layout, controlSnapshot.paths.inputPath),
      tasks_path: runRelativePath(layout, controlSnapshot.paths.tasksPath),
      control_integrity_path: runRelativePath(layout, controlSnapshot.paths.integrityPath),
      control_generation: link.control_generation,
      workflow_link_id: link.link_id,
      execution_snapshot_path: executionSnapshot,
      task_node_ids: taskNodeIds
    },
    stateWorkflow: {
      inspection: { runId: link.workflow_run_id },
      runId: link.workflow_run_id,
      compiledRunId: link.workflow_run_id,
      name: workflowName,
      controlGeneration: link.control_generation,
      linkId: link.link_id,
      executionSnapshot
    }
  };
}

function metadataIsPristineInitialWorkflowBinding(metadata: RunMetadataDocument): boolean {
  return (
    Array.isArray(metadata.workflow_ids) && metadata.workflow_ids.length === 0 && !Object.hasOwn(metadata, "workflow")
  );
}

function stateIsPristineInitialWorkflowBinding(state: ReturnType<typeof readRunState>): boolean {
  return state.provenance === undefined || !Object.hasOwn(state.provenance, "workflow");
}

function metadataMatchesInitialWorkflowBinding(
  metadata: RunMetadataDocument,
  expectedWorkflow: RunMetadataWorkflow
): boolean {
  return (
    Array.isArray(metadata.workflow_ids) &&
    metadata.workflow_ids.length === 1 &&
    metadata.workflow_ids[0] === expectedWorkflow.run_id &&
    exactRecordMatches(objectRecord(metadata.workflow), expectedWorkflow, ["workflow_link_id"])
  );
}

function stateMatchesInitialWorkflowBinding(
  state: ReturnType<typeof readRunState>,
  expectedWorkflow: RunWorkflowProvenance
): boolean {
  return exactRecordMatches(objectRecord(objectRecord(state.provenance).workflow), expectedWorkflow, ["linkId"]);
}

function exactRecordMatches(
  observed: Record<string, unknown>,
  expected: object,
  fieldsAllowedMissing: readonly string[] = []
): boolean {
  const allowedMissing = new Set(fieldsAllowedMissing);
  const expectedRecord = expected as Record<string, unknown>;
  const observedKeys = Object.keys(observed);
  const expectedKeys = Object.keys(expectedRecord);
  if (observedKeys.some((key) => !Object.hasOwn(expectedRecord, key))) return false;
  if (expectedKeys.some((key) => !Object.hasOwn(observed, key) && !allowedMissing.has(key))) return false;
  return expectedKeys.every(
    (key) =>
      (!Object.hasOwn(observed, key) && allowedMissing.has(key)) ||
      JSON.stringify(observed[key]) === JSON.stringify(expectedRecord[key])
  );
}

function writeLinkedWorkflowBinding(
  layout: RunLayout,
  metadata: RunMetadataDocument,
  state: ReturnType<typeof readRunState>,
  link: WorkflowRunLinkJournalEntry
): void {
  const existingWorkflow = metadata.workflow;
  if (existingWorkflow === undefined) throw new Error("workflow replacement requires an existing workflow binding");
  // Accounting and execution reconciliation are both derived from the workflow
  // run being replaced, so neither can survive a rebinding: the next
  // synchronization pass rebuilds them against the new run.
  const {
    accounting: _staleAccounting,
    execution_reconciliation: _staleReconciliation,
    ...metadataWithoutDerivedState
  } = metadata;
  writeRunMetadataDocument(layout.runMetadataPath, {
    ...metadataWithoutDerivedState,
    workflow_ids: [link.workflow_run_id],
    workflow: {
      ...existingWorkflow,
      run_id: link.workflow_run_id,
      control_generation: link.control_generation,
      workflow_link_id: link.link_id
    }
  });
  const existingProvenance = state.provenance;
  if (existingProvenance === undefined) throw new Error("workflow replacement requires existing state provenance");
  state.provenance = {
    ...existingProvenance,
    workflow: {
      ...existingProvenance.workflow,
      inspection: { runId: link.workflow_run_id },
      runId: link.workflow_run_id,
      controlGeneration: link.control_generation,
      linkId: link.link_id
    }
  };
  writeRunState(layout, state);
}

function metadataMatchesWorkflowRunLink(
  metadata: RunMetadataDocument,
  link: WorkflowRunLinkJournalEntry,
  allowMissingLinkId = false
): boolean {
  const workflow = objectRecord(metadata.workflow);
  return (
    workflow.run_id === link.workflow_run_id &&
    workflow.control_generation === link.control_generation &&
    (workflow.workflow_link_id === link.link_id || (allowMissingLinkId && workflow.workflow_link_id === undefined)) &&
    Array.isArray(metadata.workflow_ids) &&
    metadata.workflow_ids.length === 1 &&
    metadata.workflow_ids[0] === link.workflow_run_id
  );
}

function stateMatchesWorkflowRunLink(
  state: ReturnType<typeof readRunState>,
  link: WorkflowRunLinkJournalEntry,
  allowMissingLinkId = false
): boolean {
  const workflow = objectRecord(objectRecord(state.provenance).workflow);
  return (
    workflow.runId === link.workflow_run_id &&
    objectRecord(workflow.inspection).runId === link.workflow_run_id &&
    workflow.controlGeneration === link.control_generation &&
    (workflow.linkId === link.link_id || (allowMissingLinkId && workflow.linkId === undefined))
  );
}

function linkedWorkflowEnvironmentVariableNames(
  config: ResolvedConfig,
  taskContents: Buffer,
  env: Record<string, string | undefined> | undefined
): string[] {
  return agentEnvironmentVariableNames(config, linkedWorkflowAgentRefs(taskContents), env);
}

function linkedWorkflowAgentRefs(taskContents: Buffer): string[] {
  return parseSmithersTaskManifestBytes(taskContents).tasks.flatMap((task) =>
    task.agentChain.map((profile) => profile.agentRef)
  );
}

function persistForgeGuardMetadata(layout: RunLayout, config: ResolvedConfig, active: boolean): void {
  const metadata = readRunMetadataDocument(layout.runMetadataPath, layout.runId);
  writeRunMetadataDocument(layout.runMetadataPath, {
    ...metadata,
    forge_guard: forgeGuardMetadata(config, active)
  });
}

function mergeEnvironmentVariableNames(...groups: readonly (readonly string[])[]): string[] {
  return [...new Set(groups.flat())].sort();
}

export function linkedWorkflowExecutionEnvironment(
  evidence: LinkedWorkflowEvidence,
  credentials: Record<string, string | undefined> | undefined,
  providerCredentialNames: readonly string[] = []
): Record<string, string | undefined> {
  // Snapshot-controlled paths are applied last so caller credentials can add
  // secrets but cannot redirect any verified workflow input.
  return providerScopedControllerEnvironment(
    { ...(credentials ?? {}), ...evidence.executionSnapshot.env },
    providerCredentialNames
  );
}

function providerScopedControllerEnvironment(
  source: Record<string, string | undefined>,
  providerCredentialNames: readonly string[]
): Record<string, string | undefined> {
  return {
    ...source,
    ULTRAFUZZ_PROVIDER_CREDENTIAL_ENV_NAMES: [...new Set(providerCredentialNames)].sort().join(","),
    ULTRAFUZZ_SENSITIVE_AGENT_ENV_NAMES: sensitiveAllowlistedEnvironmentVariableNames({
      ...process.env,
      ...source
    }).join(",")
  };
}

function sensitiveAllowlistedEnvironmentVariableNames(source: Record<string, string | undefined>): string[] {
  const names = new Set<string>();
  for (const entry of (source.ULTRAFUZZ_AGENT_ENV_ALLOWLIST ?? "").split(",")) {
    const name = entry.trim();
    if (name.length === 0) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new Error("ULTRAFUZZ_AGENT_ENV_ALLOWLIST must be a comma-separated list of environment variable names");
    }
    const upper = name.toUpperCase();
    const matchingSourceNames = Object.keys(source).filter((sourceName) => sourceName.toUpperCase() === upper);
    const values = matchingSourceNames
      .map((sourceName) => source[sourceName])
      .filter((value): value is string => value !== undefined);
    if (!isSensitiveEnvironmentName(name) && !values.some((value) => isSensitiveSecretValue(value))) continue;
    names.add(name);
    names.add(upper);
    for (const sourceName of matchingSourceNames) names.add(sourceName);
  }
  return [...names].sort();
}

function withoutSensitiveAllowlistedEnvironment(
  source: Record<string, string | undefined>
): Record<string, string | undefined> {
  const sanitized = { ...source };
  const sensitiveNames = new Set(
    sensitiveAllowlistedEnvironmentVariableNames(source).map((name) => name.toUpperCase())
  );
  for (const name of Object.keys(sanitized)) {
    if (sensitiveNames.has(name.toUpperCase())) sanitized[name] = undefined;
  }
  sanitized.ULTRAFUZZ_AGENT_ENV_ALLOWLIST = (source.ULTRAFUZZ_AGENT_ENV_ALLOWLIST ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && !sensitiveNames.has(name.toUpperCase()))
    .join(",");
  return sanitized;
}

function agentCredentialEnvironmentVariableNames(config: ResolvedConfig, agentRefs: readonly string[]): string[] {
  const activeAgentRefs = new Set(agentRefs);
  const names: string[] = [];
  for (const [agentRef, agent] of Object.entries(config.agents)) {
    if (!activeAgentRefs.has(agentRef) || agent.auth !== "api-key" || agent.apiKeyEnv === undefined) continue;
    assertCredentialEnvironmentVariableName(agent.apiKeyEnv);
    names.push(agent.apiKeyEnv);
    if (agentRef === "KimiAgent" && agent.apiKeyEnv === "KIMI_API_KEY") names.push("MOONSHOT_API_KEY");
  }
  if (config.execution.mode === "cloud" && config.execution.provider !== undefined) {
    const provider = config.execution.providers[config.execution.provider];
    if (provider !== undefined) {
      for (const name of provider.credentialEnv) {
        assertCredentialEnvironmentVariableName(name);
        names.push(name);
      }
    }
  }
  return [...new Set(names)].sort();
}

function agentEnvironmentVariableNames(
  config: ResolvedConfig,
  agentRefs: readonly string[],
  env: Record<string, string | undefined> | undefined
): string[] {
  const activeAgentRefs = new Set(agentRefs);
  const names: string[] = [];
  if (activeAgentRefs.size > 0) names.push("ULTRAFUZZ_PROVIDER_HOME_ROOT", ...MODEL_ROUTE_PROXY_ENVIRONMENT_VARIABLES);
  for (const [agentRef, agent] of Object.entries(config.agents)) {
    if (!activeAgentRefs.has(agentRef)) continue;
    if (agent.auth === "api-key" && agent.apiKeyEnv !== undefined) {
      assertCredentialEnvironmentVariableName(agent.apiKeyEnv);
      names.push(agent.apiKeyEnv);
      if (agentRef === "KimiAgent" && agent.apiKeyEnv === "KIMI_API_KEY") names.push("MOONSHOT_API_KEY");
    }
    if (agentRef === "KimiAgent") {
      names.push("KIMI_BASE_URL", "KIMI_CODE_HOME", "KIMI_SHARE_DIR");
      if (agent.auth === "subscription") {
        names.push("ULTRAFUZZ_KIMI_SESSION_HOME", "ULTRAFUZZ_KIMI_SHARED_AUTH_HOME", "ULTRAFUZZ_MODAL_REMOTE_ROOT");
      }
    }
    if (agentRef === "ClaudeAgent") names.push("CLAUDE_CONFIG_DIR");
    if (agentRef === "CodexAgent") names.push("OPENAI_BASE_URL");
  }
  if (config.execution.mode === "cloud" && config.execution.provider !== undefined) {
    const provider = config.execution.providers[config.execution.provider];
    if (provider !== undefined) {
      pushEnvironmentVariableNames(names, provider.credentialEnv);
      if (config.execution.provider === "modal") {
        names.push("MODAL_ENVIRONMENT", "MODAL_PROFILE");
      }
    }
  }
  const extra = env?.ULTRAFUZZ_AGENT_ENV_ALLOWLIST ?? process.env.ULTRAFUZZ_AGENT_ENV_ALLOWLIST;
  if (extra !== undefined && extra.trim() !== "") {
    names.push("ULTRAFUZZ_AGENT_ENV_ALLOWLIST");
    for (const name of extra.split(",").map((value) => value.trim())) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
        throw new Error("ULTRAFUZZ_AGENT_ENV_ALLOWLIST must be a comma-separated list of environment variable names");
      }
      assertCredentialEnvironmentVariableName(name);
      names.push(name);
    }
  }
  return [...new Set(names)].sort();
}

function pushEnvironmentVariableNames(names: string[], value: unknown): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const name of value) {
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new Error("workflow environment allowlist contains an invalid environment variable name");
    }
    assertCredentialEnvironmentVariableName(name);
    names.push(name);
  }
}

function assertCredentialEnvironmentVariableName(name: string): void {
  if (WORKFLOW_CONTROLLER_ONLY_ENVIRONMENT_VARIABLES.has(name.toUpperCase())) {
    throw new Error(`workflow credential environment cannot name controller-only variable ${name}`);
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function assertCurrentDataGovernanceTarget(
  projectRoot: string,
  executionFiles: readonly { snapshotPath: string; contents: Buffer }[],
  governancePath: string,
  controllerOwnedPaths: string[]
): void {
  const sealed = executionFiles.find((file) => file.snapshotPath === `controls/${governancePath}`),
    expected = objectRecord(objectRecord(parseStrictJsonBytes(sealed?.contents ?? Buffer.alloc(0))).target);
  if (JSON.stringify(targetIdentity(projectRoot, controllerOwnedPaths)) !== JSON.stringify(expected))
    throw new Error("campaign source changed after its data-disclosure acknowledgement");
}

function parseSealedResolvedConfig(
  executionFiles: readonly { snapshotPath: string; contents: Buffer }[]
): ResolvedConfig {
  const sealedConfig = executionFiles.find((file) => file.snapshotPath === "controls/resolved-config.json");
  if (sealedConfig === undefined) {
    throw new Error("sealed workflow execution snapshot is missing its resolved configuration");
  }
  const config = parseResolvedConfigJsonBytes(sealedConfig.contents);
  const diagnostic = validateAgentConfigs(config.agents)[0];
  if (diagnostic !== undefined) throw new Error(`sealed agent policy is invalid: ${diagnostic.message}`);
  return config;
}

function parseSealedExpandedGraph(contents: Buffer): ExpandedGraph {
  return assertExpandedGraphSchema(parseStrictJsonBytes(contents));
}

function runRelativePath(layout: RunLayout, candidate: string): string {
  assertPathInside(layout.root, candidate, "workflow run-relative path");
  return path.relative(layout.root, candidate).split(path.sep).join("/");
}

function projectRelativePath(projectRoot: string, candidate: string): string {
  assertPathInside(projectRoot, candidate, "workflow project-relative path");
  return path.relative(projectRoot, candidate).split(path.sep).join("/");
}
