import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  appendEvent,
  assertPlannedGraph,
  assertSmithersTaskManifestMatchesPlannedGraph,
  NODE_PROVENANCE_FAILURE_CATEGORIES,
  assertNoSymlinkComponents,
  assertPathInside,
  layoutForRunRoot,
  parseSmithersTaskManifestBytes,
  parseStrictJsonBytes,
  readRunMetadataDocument,
  readRunState,
  sensitiveEnvironmentValues,
  updateRunStatus,
  validateSafeIdOrThrow,
  writeJsonDurable,
  writeRunMetadataDocument,
  writeRunState,
  type RunMetadataDocument,
  type RunMetadataWorkflow,
  type RunWorkflowProvenance,
  type RunRecoveryProvenance,
  type RunLayout,
  type AppendEventInput,
  type SmithersTaskManifestDocument,
  type SmithersTaskManifestTask
} from "@ultrafuzz/artifacts";
import { parseResolvedConfigJsonBytes, type ResolvedConfig } from "@ultrafuzz/config";
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
import { assertTargetCommitForReview, planRun } from "./plan-run.js";
import { assertControllerExecutionSnapshotDigest } from "./controller-source.js";
import { probeCommandsForExecution } from "./required-commands.js";
import { forgeGuardMetadata, prepareForgeGuardEnvironment } from "./forge-guard.js";
import { prepareTrustedCliEnvironment, runTrustedJsonValidatorPreflight } from "./trusted-cli.js";
import { runtimeFailure, runtimeResult } from "./utils.js";
import {
  compileSmithersWorkflow,
  requestSmithersPause,
  runSmithersLifecycleCommand,
  smithersExecutionControlFiles,
  smithersDiagnostic,
  submitSmithersWorkflow,
  type CompiledSmithersWorkflow
} from "./smithers.js";
import { runsRootForProject } from "./validate.js";
import {
  acquireWorkflowControlLock,
  materializeWorkflowExecutionSnapshot,
  sealWorkflowControlFiles,
  verifyWorkflowControlSnapshot,
  workflowControlPaths,
  type MaterializedWorkflowExecutionSnapshot,
  type VerifiedWorkflowControlSnapshot
} from "./workflow-integrity.js";
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

export interface LinkedWorkflowEvidence {
  ok: true;
  smithersRunId: string;
  workflowPath: string;
  inputJson: string;
  layout: RunLayout;
  controlGeneration: string;
  workflowLinkId: string;
  verifiedControl: VerifiedWorkflowControlSnapshot;
  executionSnapshot: MaterializedWorkflowExecutionSnapshot;
}

const WORKFLOW_CONTROLLER_ONLY_ENVIRONMENT_VARIABLES = new Set([
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
]);

export async function startRun(input: StartRunInput) {
  const planned = await planRun(input, {
    beforeMaterialize: async ({
      resolvedConfig,
      expandedGraph,
      launchReviewDigest,
      controllerSource,
      targetCommit
    }) => {
      const reviewDiagnostics = launchReviewDiagnostics(
        input,
        resolvedConfig,
        launchReviewDigest,
        controllerSource,
        targetCommit
      );
      if (reviewDiagnostics.length > 0) return reviewDiagnostics;
      const credentialDiagnostics = credentialEnvironmentPolicyDiagnostics(resolvedConfig);
      if (credentialDiagnostics.length > 0) return credentialDiagnostics;
      return requiredCommandPreflightDiagnostics(input, resolvedConfig, expandedGraph);
    }
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
      workflowName: `ultrafuzz-${plan.run_id}`,
      renderedPrompts: plan.rendered_prompts,
      controllerSourceDigest: plan.controller_source_digest,
      operatorPrompt: input.prompt,
      operatorInput: input.workflowInput
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
      env: forgeGuard.env,
      required: compiled.tasks.some((task) =>
        task.metadata.artifacts.outputs.some((output) => output.schemaFile !== undefined)
      )
    });
    runTrustedJsonValidatorPreflight({ layout: plan.layout, trusted: trustedCli });
    assertTargetCommitForReview(
      path.resolve(plan.validation.project_root, plan.resolved_config.project.repo),
      plan.target_commit
    );
    const activeAgentRefs = compiled.tasks.flatMap((task) => task.agentChain.map((profile) => profile.agentRef));
    const providerCredentialNames = agentCredentialEnvironmentVariableNames(plan.resolved_config, activeAgentRefs);
    const submission = await submitSmithersWorkflow({
      compiled,
      projectRoot: plan.validation.project_root,
      maxConcurrency: input.maxConcurrency ?? plan.resolved_config.run.maxParallelAgents,
      keepWorkspaces: plan.resolved_config.run.keepWorkspaces,
      controllerLeaseSeconds: plan.resolved_config.run.controllerLeaseSeconds,
      workflowPath: prepared.executionSnapshot.workflowPath,
      env: providerScopedControllerEnvironment(
        { ...trustedCli.env, ...prepared.executionSnapshot.env },
        providerCredentialNames
      ),
      environmentVariableNames: mergeEnvironmentVariableNames(
        agentEnvironmentVariableNames(plan.resolved_config, activeAgentRefs, forgeGuard.env),
        ["ULTRAFUZZ_PROVIDER_CREDENTIAL_ENV_NAMES", "ULTRAFUZZ_PROVIDER_HOME_ROOT"],
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
    return runtimeResult(true, {
      run_id: plan.layout.runId,
      run_root: plan.layout.root,
      status: readRunState(plan.layout).status,
      ...(plan.source_run_id ? { source_run_id: plan.source_run_id } : {}),
      graph_fingerprint: plan.graph_fingerprint,
      config_fingerprint: plan.config_fingerprint,
      workflow_ids: [compiled.smithersRunId]
    });
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

function launchReviewDiagnostics(
  input: StartRunInput,
  config: ResolvedConfig,
  expectedDigest: string,
  controllerSource: { stock: boolean; overrides: readonly string[] },
  targetCommit: string | null
): RuntimeDiagnostic[] {
  const required = config.permissions.promptReviewRequired || !controllerSource.stock;
  if (!required) return [];
  const provided = input.reviewAcknowledgement?.trim().toLowerCase();
  if (provided === expectedDigest) return [];
  const stale = provided !== undefined && provided.length > 0;
  return [
    {
      code: stale ? "RUN_REVIEW_ACKNOWLEDGEMENT_STALE" : "RUN_REVIEW_ACKNOWLEDGEMENT_REQUIRED",
      message:
        `${stale ? "launch review acknowledgement is stale" : "launch review acknowledgement is required"}; ` +
        `review the effective prompts, configuration, topology, references, target commit, and controller source, then rerun with --acknowledge-review ${expectedDigest}`,
      severity: "error",
      source: "runtime",
      path: "permissions.prompt_review_required",
      details: {
        expected_digest: expectedDigest,
        target_commit: targetCommit,
        prompt_review_required: config.permissions.promptReviewRequired,
        controller_source_stock: controllerSource.stock,
        controller_source_overrides: [...controllerSource.overrides]
      }
    }
  ];
}

function credentialEnvironmentPolicyDiagnostics(config: ResolvedConfig): RuntimeDiagnostic[] {
  try {
    agentCredentialEnvironmentVariableNames(config, Object.keys(config.agents));
    return [];
  } catch (error) {
    return [
      {
        code: "RUN_CREDENTIAL_ENVIRONMENT_UNSAFE",
        message: error instanceof Error ? error.message : String(error),
        severity: "error",
        source: "runtime"
      }
    ];
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
  const missingCommands = requiredCommands.filter((command) => probeByName.get(command)?.available !== true);
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
  return missingCommands.length === 0
    ? credentialDiagnostics
    : [
        ...credentialDiagnostics,
        {
          code: "RUN_REQUIRED_COMMAND_MISSING",
          message: `required topology commands are not available in the configured execution environment: ${missingRequirements
            .map((requirement) => `${requirement.command} (required by ${requirement.node_ids.join(", ")})`)
            .join("; ")}`,
          severity: "error",
          source: "runtime",
          path: "topology.required_commands",
          details: { commands: missingCommands, requirements: missingRequirements }
        }
      ];
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
  return submitLifecycleAction(input, "resume");
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

async function submitLifecycleAction(input: WorkflowLifecycleInput, action: WorkflowLifecycleValue["action"]) {
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

  const evidence = await readLinkedWorkflowEvidence(input.projectRoot, input.runId);
  if (!evidence.ok) {
    return runtimeFailure<WorkflowLifecycleValue>(evidence.diagnostics);
  }
  try {
    const sealedConfig = parseSealedResolvedConfig(evidence.verifiedControl.executionFiles);
    const sealedGraph = parseSealedExpandedGraph(evidence.verifiedControl.contents.expanded_graph);
    const preflightDiagnostics = await requiredCommandPreflightDiagnostics(input, sealedConfig, sealedGraph);
    if (preflightDiagnostics.length > 0) {
      return runtimeFailure<WorkflowLifecycleValue>(preflightDiagnostics);
    }
    // Reconcile Smithers before retrying so a stale local running state cannot
    // hide the failed run that this retry is recovering.
    if (action === "resume" && input.retryFailed === true) {
      const { syncRun } = await import("./workflow-sync.js");
      const synchronization = await syncRun({ projectRoot: input.projectRoot, runId: input.runId, env: input.env });
      if (!synchronization.ok) {
        return runtimeFailure<WorkflowLifecycleValue>(synchronization.diagnostics);
      }
    }
    const requestedConcurrency = input.maxConcurrency ?? sealedConfig.run.maxParallelAgents;
    const stateBeforeLifecycle = readRunState(evidence.layout);
    let recoveryCandidate:
      | {
          failedNodes: RunRecoveryProvenance["failed_nodes"];
          sourceWorkflowRunId: string;
          sourceWorkflowLinkId: string;
        }
      | undefined;
    if (action === "resume" && input.retryFailed === true && stateBeforeLifecycle.status === "failed") {
      const failedNodes: RunRecoveryProvenance["failed_nodes"] = [];
      let completeAttemptAuthority = true;
      for (const node of Object.values(stateBeforeLifecycle.nodes).filter(
        (candidate) => candidate.status === "failed" || candidate.status === "timed-out"
      )) {
        const provenance = node.provenance as Record<string, unknown> | undefined;
        const workflow = provenance?.workflow as Record<string, unknown> | undefined;
        const workflowTaskId = workflow?.task_id;
        const failedAttempt = workflow?.attempt;
        if (
          typeof workflowTaskId !== "string" ||
          workflowTaskId.length === 0 ||
          typeof failedAttempt !== "number" ||
          !Number.isSafeInteger(failedAttempt) ||
          failedAttempt < 0
        ) {
          // A multi-attempt concrete node is only a projection over its
          // authoritative task attempts. Any other missing task/attempt
          // identity makes this recovery fail closed.
          if (Array.isArray(workflow?.aggregate_attempt_statuses)) continue;
          completeAttemptAuthority = false;
          break;
        }
        const failure = provenance?.failure as Record<string, unknown> | undefined;
        const category = failure?.category;
        if (
          typeof category !== "string" ||
          !NODE_PROVENANCE_FAILURE_CATEGORIES.includes(
            category as RunRecoveryProvenance["failed_nodes"][number]["failure_category"]
          )
        ) {
          completeAttemptAuthority = false;
          break;
        }
        const failureCategory = category as RunRecoveryProvenance["failed_nodes"][number]["failure_category"];
        failedNodes.push({
          node_id: node.node_id,
          workflow_task_id: workflowTaskId,
          failed_attempt: failedAttempt,
          failure_category: failureCategory
        });
      }
      if (completeAttemptAuthority && failedNodes.length > 0) {
        recoveryCandidate = {
          failedNodes,
          sourceWorkflowRunId: evidence.smithersRunId,
          sourceWorkflowLinkId: evidence.workflowLinkId
        };
      }
    }
    const retryFailedLifecycle = action === "resume" && input.retryFailed === true;
    const forgeGuard = prepareForgeGuardEnvironment({
      layout: evidence.layout,
      config: sealedConfig,
      env: input.env
    });
    persistForgeGuardMetadata(evidence.layout, sealedConfig, forgeGuard.active);
    const trustedCli = prepareTrustedCliEnvironment({
      layout: evidence.layout,
      cliEntrypoint: input.ultrafuzzCliEntrypoint,
      env: forgeGuard.env,
      required: sealedTasksRequireTrustedCli(evidence.verifiedControl.contents.tasks)
    });
    runTrustedJsonValidatorPreflight({ layout: evidence.layout, trusted: trustedCli });
    const linkedTasks = linkedWorkflowTasks(evidence.verifiedControl.contents.tasks);
    const linkedAgentRefs = linkedTasks.flatMap((task) => task.agentChain.map((profile) => profile.agentRef));
    const providerCredentialNames = agentCredentialEnvironmentVariableNames(sealedConfig, linkedAgentRefs);
    const controllerInvocation = appendEvent(evidence.layout, {
      eventType: "workflow-lifecycle-invoking",
      status: "running",
      payload: {
        action,
        workflow_run_id: evidence.smithersRunId,
        control_generation: evidence.controlGeneration,
        workflow_link_id: evidence.workflowLinkId,
        ...(retryFailedLifecycle ? { retry_failed: true } : {})
      }
    });
    let preparedRecovery: RunRecoveryProvenance | undefined;
    if (recoveryCandidate !== undefined) {
      const state = readRunState(evidence.layout);
      const priorRecovery = state.provenance?.recovery;
      preparedRecovery = {
        recovery_id: crypto.randomUUID(),
        submission_status: "prepared",
        recovered: false,
        prior_status: "failed",
        failed_nodes: recoveryCandidate.failedNodes,
        source_workflow_run_id: recoveryCandidate.sourceWorkflowRunId,
        source_workflow_link_id: recoveryCandidate.sourceWorkflowLinkId,
        control_generation: evidence.controlGeneration,
        controller_invocation_id: controllerInvocation.event_id,
        controller_invoked_at: controllerInvocation.timestamp
      };
      writeRunState(evidence.layout, {
        ...state,
        provenance: {
          ...state.provenance!,
          recovery_history: [
            ...(state.provenance?.recovery_history ?? []),
            ...(priorRecovery === undefined ? [] : [priorRecovery])
          ],
          recovery: preparedRecovery
        }
      });
    }
    const lifecycleResult = await runSmithersLifecycleCommand({
      action,
      smithersRunId: evidence.smithersRunId,
      workflowPath: evidence.workflowPath,
      projectRoot: path.resolve(input.projectRoot),
      maxConcurrency: requestedConcurrency,
      forkFrame: input.forkFrame,
      resetNode: input.resetNode,
      force: input.force,
      retryFailed: input.retryFailed,
      label: input.label,
      // Recovery consumes the already-materialized sealed input bytes. The
      // evidence directory remains mutable only for recovery receipts and logs.
      relaunchPaths: {
        runRoot: evidence.layout.root,
        inputPath: path.join(evidence.layout.root, "smithers", "input.json"),
        inputJson: evidence.inputJson,
        logsDir: path.join(evidence.layout.root, "smithers", "logs")
      },
      keepWorkspaces: sealedConfig.run.keepWorkspaces,
      controllerLeaseSeconds: sealedConfig.run.controllerLeaseSeconds,
      env: linkedWorkflowExecutionEnvironment(evidence, trustedCli.env, providerCredentialNames),
      environmentVariableNames: mergeEnvironmentVariableNames(
        linkedWorkflowEnvironmentVariableNames(sealedConfig, evidence.verifiedControl.contents.tasks, forgeGuard.env),
        ["ULTRAFUZZ_PROVIDER_CREDENTIAL_ENV_NAMES", "ULTRAFUZZ_PROVIDER_HOME_ROOT"],
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
        controller_invoked_at: controllerInvocation.timestamp,
        ...(retryFailedLifecycle ? { retry_failed: true } : {})
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
    const lifecycleSubmissionEvent = appendEvent(evidence.layout, {
      eventType: lifecycleResult.alreadyRunning ? "workflow-lifecycle-already-running" : "workflow-lifecycle-submitted",
      status: "running",
      payload: {
        action,
        workflow_run_id: workflowRunId,
        workflow_link_id: linkedWorkflow.link_id,
        control_generation: evidence.controlGeneration,
        controller_invocation_id: controllerInvocation.event_id,
        controller_invoked_at: controllerInvocation.timestamp,
        ...(retryFailedLifecycle ? { retry_failed: true } : {}),
        ...(input.resetNode !== undefined ? { reset_node: input.resetNode } : {}),
        ...(lifecycleResult.recoveredMissingRun ? { recovered_missing_workflow_run: true } : {})
      }
    });
    if (preparedRecovery !== undefined && !lifecycleResult.alreadyRunning) {
      const state = readRunState(evidence.layout);
      if (
        state.provenance?.recovery?.submission_status !== "prepared" ||
        state.provenance.recovery.recovery_id !== preparedRecovery.recovery_id ||
        state.provenance.recovery.controller_invocation_id !== controllerInvocation.event_id
      ) {
        throw new Error("prepared retry recovery authority changed before lifecycle submission completed");
      }
      writeRunState(evidence.layout, {
        ...state,
        provenance: {
          ...state.provenance!,
          recovery: {
            ...preparedRecovery,
            submission_status: "submitted",
            workflow_run_id: workflowRunId,
            workflow_link_id: linkedWorkflow.link_id,
            lifecycle_result_event_id: lifecycleResultEvent.event_id,
            lifecycle_result_at: lifecycleResultEvent.timestamp,
            lifecycle_submission_event_id: lifecycleSubmissionEvent.event_id,
            lifecycle_submitted_at: lifecycleSubmissionEvent.timestamp
          }
        }
      });
    }
    return runtimeResult(true, {
      run_id: input.runId,
      workflow_run_id: workflowRunId,
      action,
      submitted: !lifecycleResult.alreadyRunning
    });
  } catch (error) {
    return runtimeFailure<WorkflowLifecycleValue>([smithersDiagnostic(error, "WORKFLOW_LIFECYCLE_FAILED")]);
  }
}

function sealedTasksRequireTrustedCli(contents: Buffer): boolean {
  return parseSmithersTaskManifestBytes(contents).tasks.some((task) =>
    task.metadata.artifacts.outputs.some((output) => output.schemaFile !== undefined)
  );
}

function parseSealedTaskManifest(contents: Readonly<{ graph: Buffer; tasks: Buffer }>): SmithersTaskManifestDocument {
  const graph = assertPlannedGraph(parseStrictJsonBytes(contents.graph));
  const manifest = parseSmithersTaskManifestBytes(contents.tasks);
  assertSmithersTaskManifestMatchesPlannedGraph(manifest, graph);
  return manifest;
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
  writeRunMetadataDocument(layout.runMetadataPath, {
    ...metadata,
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

export async function readLinkedWorkflowEvidence(
  projectRoot: string,
  runId: string
): Promise<LinkedWorkflowEvidence | { ok: false; diagnostics: RuntimeDiagnostic[] }> {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const runsRoot = await runsRootForProject(resolvedProjectRoot);
  let metadataPath: string;
  let layout: RunLayout;
  try {
    const safeRunId = validateSafeIdOrThrow(runId, "run ID");
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
    releaseControlLock = await acquireWorkflowControlLock(layout);
    const missingEvidence = missingLinkedWorkflowEvidenceDiagnostic(resolvedProjectRoot, layout);
    if (missingEvidence !== undefined) {
      return { ok: false, diagnostics: [missingEvidence] };
    }
    reconcilePendingWorkflowRunLink(resolvedProjectRoot, layout);
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

    const verifiedControl = verifyWorkflowControlSnapshot(resolvedProjectRoot, layout);
    const taskDocument = parseSealedTaskManifest(verifiedControl.contents);
    const compiledRunId = workflow.compiled_run_id;
    if (
      typeof compiledRunId !== "string" ||
      taskDocument.smithers_run_id !== compiledRunId ||
      taskDocument.run_id !== runId
    ) {
      throw new Error("compiled workflow identity does not match the sealed task manifest");
    }
    const executionSnapshot = materializeWorkflowExecutionSnapshot({
      projectRoot: resolvedProjectRoot,
      layout,
      snapshot: verifiedControl
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
      execution_snapshot_path: runRelativePath(layout, executionSnapshot.root)
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
    const linkHistory = verifyWorkflowRunLinkHistory(layout);
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
      workflowPath: executionSnapshot.workflowPath,
      inputJson: executionSnapshot.inputJson,
      layout,
      controlGeneration: verifiedControl.generation,
      workflowLinkId: activeWorkflowLink.link_id,
      verifiedControl,
      executionSnapshot
    };
  } catch (error) {
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
  } finally {
    await releaseControlLock?.();
  }
}

function missingLinkedWorkflowEvidenceDiagnostic(
  projectRoot: string,
  layout: RunLayout
): RuntimeDiagnostic | undefined {
  const controlSealPath = workflowControlPaths(projectRoot, layout).integrityPath;
  if (pathIsMissing(controlSealPath)) {
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
    writeRunMetadataDocument(layout.runMetadataPath, {
      ...metadata,
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
  const { accounting: _staleAccounting, ...metadataWithoutAccounting } = metadata;
  writeRunMetadataDocument(layout.runMetadataPath, {
    ...metadataWithoutAccounting,
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
  const tasks = linkedWorkflowTasks(taskContents);
  const names = agentEnvironmentVariableNames(
    config,
    tasks.flatMap((task) => task.agentChain.map((profile) => profile.agentRef)),
    env
  );
  for (const task of tasks) {
    const execution = objectRecord(task.execution);
    pushEnvironmentVariableNames(names, execution.agentCredentialEnv);
    const modal = objectRecord(execution.modal);
    pushEnvironmentVariableNames(names, modal.credentialEnv);
  }
  return [...new Set(names)].sort();
}

function linkedWorkflowTasks(contents: Buffer): SmithersTaskManifestTask[] {
  return parseSmithersTaskManifestBytes(contents).tasks;
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
    ULTRAFUZZ_PROVIDER_CREDENTIAL_ENV_NAMES: [...new Set(providerCredentialNames)].sort().join(",")
  };
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
  if (activeAgentRefs.size > 0) names.push("ULTRAFUZZ_PROVIDER_HOME_ROOT");
  for (const [agentRef, agent] of Object.entries(config.agents)) {
    if (!activeAgentRefs.has(agentRef)) continue;
    if (agent.auth === "api-key" && agent.apiKeyEnv !== undefined) {
      assertCredentialEnvironmentVariableName(agent.apiKeyEnv);
      names.push(agent.apiKeyEnv);
      if (agentRef === "KimiAgent" && agent.apiKeyEnv === "KIMI_API_KEY") names.push("MOONSHOT_API_KEY");
    }
    if (agentRef === "KimiAgent") {
      names.push("KIMI_BASE_URL");
      if (agent.auth === "subscription") {
        names.push(
          "KIMI_CODE_HOME",
          "KIMI_SHARE_DIR",
          "ULTRAFUZZ_KIMI_SESSION_HOME",
          "ULTRAFUZZ_KIMI_SHARED_AUTH_HOME",
          "ULTRAFUZZ_MODAL_REMOTE_ROOT"
        );
      }
    }
  }
  if (config.execution.mode === "cloud" && config.execution.provider !== undefined) {
    const provider = config.execution.providers[config.execution.provider];
    if (provider !== undefined) {
      pushEnvironmentVariableNames(names, provider.credentialEnv);
    }
  }
  const extra = env?.ULTRAFUZZ_AGENT_ENV_ALLOWLIST ?? process.env.ULTRAFUZZ_AGENT_ENV_ALLOWLIST;
  if (extra !== undefined && extra.trim() !== "") {
    for (const name of extra.split(",").map((value) => value.trim())) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
        throw new Error("ULTRAFUZZ_AGENT_ENV_ALLOWLIST must be a comma-separated list of environment variable names");
      }
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

function parseSealedResolvedConfig(
  executionFiles: readonly { snapshotPath: string; contents: Buffer }[]
): ResolvedConfig {
  const sealedConfig = executionFiles.find((file) => file.snapshotPath === "controls/resolved-config.json");
  if (sealedConfig === undefined) {
    throw new Error("sealed workflow execution snapshot is missing its resolved configuration");
  }
  return parseResolvedConfigJsonBytes(sealedConfig.contents);
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
