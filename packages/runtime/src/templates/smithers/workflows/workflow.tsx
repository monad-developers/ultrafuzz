// smithers-source: generated
// smithers-display-name: Ultrafuzz __ULTRAFUZZ_RUN_ID__
// smithers-description: Generated Ultrafuzz product workflow. Smithers owns execution; Ultrafuzz owns config, topology, prompts, artifacts, reports, and materialization evidence.
// project-agents: .smithers/agents
/** @jsxImportSource smithers-orchestrator */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Fragment } from "react";
import { createSmithers, type AgentLike } from "smithers-orchestrator";
import { z } from "zod/v4";
// Imported via the explicit index path: Smithers' bootstrap can scaffold a
// sibling .smithers/agents.ts, which bun's resolution would prefer over the
// .smithers/agents/ directory this workflow needs.
import * as projectAgents from "../agents/index.ts";

const artifactsModule = process.env.ULTRAFUZZ_ARTIFACTS_MODULE ?? __ULTRAFUZZ_ARTIFACTS_MODULE__;
const runtimeModule = process.env.ULTRAFUZZ_RUNTIME_MODULE ?? __ULTRAFUZZ_RUNTIME_MODULE__;
const {
  artifactContractDefinition,
  assertCloudSelectedTaskMatchesCanonical,
  assertRegularFileInside,
  buildFindingSourceExpectations,
  checkInvariantSourcePinned,
  CLOUD_SELECTED_TASK_CLOUD_EXECUTION,
  CLOUD_SELECTED_TASK_RUNTIME_PROMPT_BASENAME,
  CLOUD_SELECTED_TASK_SCHEMA_VERSION,
  findingIdentityKeys,
  derivePropertyImplementationCoverage,
  invariantPinnedSourceRefExists,
  isCloudExecutionGeneration,
  materializeCanonicalThreatModelMarkdown,
  materializePromptSchemas,
  normalizeFindings,
  normalizeEvidenceLineRangeCardinality,
  normalizeNodeAttemptFailureMessage,
  parseCloudSelectedTask,
  publishFileDurableExclusive,
  validateArtifactContract,
  validateImplementedPropertiesSchema,
  validateInvariantLedgerSchema,
  validateInvariantSourceProofSchema,
  verifyGoalPlanSelectedRecordSnapshots,
  verifyThreatModelEvidenceFiles,
  validatePropertiesSchema,
  writeFileDurable
} = await import(artifactsModule);
const {
  applyWorkspacePatch,
  captureWorkspacePatch,
  captureWorkspaceTree,
  dynamicStorageId,
  materializeDynamicRuntime,
  materializeGoalPlanVulnerabilityDatabaseSnapshots,
  topologyRuntimeContextForTimeout,
  hydratePinnedSubmodulesFromExecutionSnapshot,
  MAX_FINAL_REPORT_JSON_BYTES,
  normalizeFinalReportSeverityRecord,
  projectCanonicalFinalReport,
  validateWorkspacePatchCapture,
  verifyThreatModelVulnerabilityDatabaseCapabilities,
  verifyPinnedSubmodulesFromExecutionSnapshot
} = await import(runtimeModule);

const inputTaskSchema = z.object({
  id: z.string(),
  prompt: z.string().optional(),
  prompt_path: z.string().optional()
});

/**
 * The exact outer dispatch contract for this workflow.
 *
 * A relocated cloud worker is launched with an untrusted input document, so the outer object is
 * strict: an unknown dispatch key -- a future field, a camelCase or hydrated-only alias such as
 * `selectedTask`, or smuggled controller state -- is refused instead of transiting the boundary.
 * The controller's own submitted document (`schema_version`, `tasks`, operator fields) is part of
 * the same contract, so the non-worker invocation shape keeps working unchanged. The product run ID
 * is a compiled constant and is deliberately absent here because Smithers reserves `run_id` for its
 * own persisted input column.
 */
const inputSchema = z.strictObject({
  schema_version: z.string().min(1).optional(),
  // Smithers persistence represents absent top-level workflow inputs as null. Normalize those storage
  // placeholders before applying the product dispatch contract; nested task entries are preserved.
  tasks: z
    .array(inputTaskSchema)
    .nullish()
    .transform((value) => value ?? []),
  operator_prompt: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined),
  operator_input: z.unknown().optional(),
  cloud_worker: z
    .boolean()
    .nullish()
    .transform((value) => value ?? undefined),
  task_id: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined),
  attempt_id: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined),
  execution_generation: z
    .string()
    .refine(isCloudExecutionGeneration, "must be a bounded generation")
    .nullish()
    .transform((value) => value ?? undefined),
  // Validated against the shared versioned contract, never trusted as a task spec.
  selected_task: z.unknown().optional()
});

const taskOutput = z.object({
  summary: z.string().min(1)
});

const preparationOutput = z.object({
  prepared: z.literal(true)
});

const verificationOutput = z.object({
  artifacts: z.array(
    z.object({
      path: z.string().min(1),
      contract: z.string().min(1),
      contract_digest: z.string().regex(/^[0-9a-f]{64}$/u),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
      primary: z.boolean()
    })
  ),
  primary_artifact: z.string().min(1)
});

const ARTIFACT_VERIFICATION_SCHEMA_VERSION = "ultrafuzz.artifact-verification.v1";
const ARTIFACT_VERIFICATION_DIRECTORY = ".ultrafuzz-verification";
/**
 * The topology group whose nodes are GOAL SEARCHES, plus the run-root census that records what each
 * of those searches actually managed to do (issues #672, #677).
 *
 * Every other node in this topology owes its dependents a specific artifact: a threat model, a
 * property catalog, an invariant suite. A goal search owes them an ANSWER, and "no supported
 * vulnerability of this class exists here" is one of the two legitimate answers -- `goal-hunter`
 * already contracts it as `[]`. That asymmetry is why `goals` is the only group whose nodes are
 * allowed to fail without failing the run, and it is also why the census below is mandatory rather
 * than nice to have: once a goal lane may end with nothing, "no vulnerabilities found" stops being
 * a statement about the code unless something states how many of the planned searches actually ran
 * to completion. In the 18-hour local default-profile run 9 goal nodes were killed at exactly their
 * 7200000ms node timeout and only 3 of 77 class-goal nodes produced any output at all, so a report
 * built on that evidence describes roughly 4% of its plan, not the target.
 */
const GOAL_SEARCH_TOPOLOGY_GROUP = "goals";
const GOAL_SEARCH_COVERAGE_FILE = "goal-search-coverage.json";
const GOAL_SEARCH_COVERAGE_SCHEMA_VERSION = "ultrafuzz.goal-search-coverage.v1";
const unreachableCommitCountCommand =
  'set -euo pipefail; git fsck --connectivity-only --unreachable --no-reflogs --no-progress 2>&1 | awk \'$1 == "unreachable" && $2 == "commit" { count++ } END { print count + 0 }\'';

const { Workflow, Task, Worktree, Parallel, Sandbox, smithers, outputs } = createSmithers({
  input: inputSchema,
  task: taskOutput,
  preparation: preparationOutput,
  verification: verificationOutput
});

const agentRegistry = projectAgents as Record<string, AgentLike | AgentLike[]>;
type AgentFactory = (options: { model?: string; reasoningEffort?: string; addDir?: string[] }) => AgentLike;
const agentFactories =
  (projectAgents as unknown as { agentFactories?: Record<string, AgentFactory> }).agentFactories ?? {};
const sourceProjectRoot = __ULTRAFUZZ_SOURCE_PROJECT_ROOT__;
const dynamicRunRoot = path.resolve(process.cwd(), __ULTRAFUZZ_RUN_ROOT_RELATIVE__);
const dynamicGraphPath = path.join(dynamicRunRoot, "graph.json");
const dynamicTasksPath = path.join(dynamicRunRoot, "smithers", "tasks.json");
const compiledBaseTasks = __ULTRAFUZZ_COMPILED_TASKS__;
const dynamicGroupSpecs = __ULTRAFUZZ_DYNAMIC_GROUPS__;
/** Resolved `run.max_dynamic_nodes`, recorded by the planner into `goal-plan.json`. */
const maxDynamicNodes = __ULTRAFUZZ_MAX_DYNAMIC_NODES__;
const serializedTaskSpecs = __ULTRAFUZZ_TASK_SPECS__ as const;
const loadedWorkflowPath = fileURLToPath(import.meta.url);
const persistedWorkflowPath = process.env.ULTRAFUZZ_WORKFLOW_PERSISTED_PATH;
const admittedWorkflowControls = admitWorkflowControls(loadedWorkflowPath, persistedWorkflowPath);
const admittedWorkflowRelativePath =
  admittedWorkflowControls.persistedWorkflowPath === undefined
    ? __ULTRAFUZZ_WORKFLOW_PATH_RELATIVE__
    : cloudSnapshotRelativePath(admittedWorkflowControls.persistedWorkflowPath, "persisted workflow path");
const dynamicBaseGraphPath = sealedRuntimeControlPath("runtime-base-graph.json", admittedWorkflowControls);
const dynamicBaseTasksPath = sealedRuntimeControlPath("runtime-base-tasks.json", admittedWorkflowControls);
/**
 * Hydrates one serialized task spec against the current project root.
 *
 * Every path in a serialized spec is project-relative, so the same spec hydrates correctly in the
 * controller root and in a relocated cloud-worker root.
 */
function hydrateTaskSpec(task: (typeof serializedTaskSpecs)[number]) {
  const controlPaths = taskWorkflowControlPaths(task.execution.mode, admittedWorkflowControls);
  const promptPath =
    task.promptPath === undefined
      ? undefined
      : (sealedTaskPromptPath(task.attemptId, controlPaths.promptExecutionSnapshotRoot) ??
        path.resolve(process.cwd(), task.promptPath));
  return {
    ...task,
    dependsOn: [...task.dependsOn] as string[],
    dynamicDependencies: [] as string[],
    promptRelativePath:
      promptPath === undefined
        ? undefined
        : task.execution.mode === "cloud" && controlPaths.executionSnapshotRoot !== undefined
          ? cloudSnapshotRelativePath(promptPath, "rendered prompt path")
          : task.promptPath,
    promptPath,
    workflowPath: controlPaths.workflowPath ?? path.resolve(process.cwd(), task.workflowPath),
    executionSnapshotRoot: controlPaths.executionSnapshotRoot,
    workspaceRelativePath: task.workspacePath,
    workspacePath: path.resolve(process.cwd(), task.workspacePath),
    artifactRelativeDir: task.artifactDir,
    artifactDir: path.resolve(process.cwd(), task.artifactDir)
  };
}
let taskSpecs = serializedTaskSpecs.map((task) => hydrateTaskSpec(task));

type AdmittedWorkflowControls = {
  loadedWorkflowPath: string;
  loadedExecutionSnapshotRoot: string | undefined;
  persistedWorkflowPath: string | undefined;
  persistedExecutionSnapshotRoot: string | undefined;
};

function admitWorkflowControls(loadedPath: string, persistedPath: string | undefined): AdmittedWorkflowControls {
  const loadedExecutionSnapshotRoot = workflowExecutionSnapshotRoot(loadedPath);
  const persistedExecutionSnapshotRoot =
    persistedPath === undefined ? undefined : workflowExecutionSnapshotRoot(persistedPath);
  if (
    persistedPath !== undefined &&
    (loadedExecutionSnapshotRoot === undefined ||
      persistedExecutionSnapshotRoot === undefined ||
      realpathSync(loadedPath) !== realpathSync(persistedPath))
  ) {
    throw new Error("persisted workflow path does not identify the loaded execution snapshot");
  }
  return {
    loadedWorkflowPath: loadedPath,
    loadedExecutionSnapshotRoot,
    persistedWorkflowPath: persistedPath,
    persistedExecutionSnapshotRoot
  };
}

function taskWorkflowControlPaths(
  executionMode: "local" | "cloud",
  controls: AdmittedWorkflowControls
): {
  promptExecutionSnapshotRoot: string | undefined;
  workflowPath: string | undefined;
  executionSnapshotRoot: string | undefined;
} {
  const anySnapshotRoot = controls.loadedExecutionSnapshotRoot ?? controls.persistedExecutionSnapshotRoot;
  if (anySnapshotRoot === undefined) {
    return {
      promptExecutionSnapshotRoot: undefined,
      workflowPath: undefined,
      executionSnapshotRoot: undefined
    };
  }
  if (executionMode === "cloud") {
    return controls.persistedExecutionSnapshotRoot === undefined
      ? {
          // Preserve direct cloud-workflow admission behavior: the loaded
          // generation can supply sealed prompt/module bytes, but cloud handoff
          // still requires the explicit persisted generation binding.
          promptExecutionSnapshotRoot: controls.loadedExecutionSnapshotRoot,
          workflowPath: controls.loadedWorkflowPath,
          executionSnapshotRoot: undefined
        }
      : {
          promptExecutionSnapshotRoot: controls.persistedExecutionSnapshotRoot,
          workflowPath: controls.persistedWorkflowPath!,
          executionSnapshotRoot: controls.persistedExecutionSnapshotRoot
        };
  }
  const persistedSnapshotRoot = controls.persistedExecutionSnapshotRoot ?? controls.loadedExecutionSnapshotRoot;
  return {
    // The descriptor-rooted loaded path is an admission capability owned by
    // the Ultrafuzz controller. Smithers may continue a detached local run
    // after that controller closes the descriptor, so no task-spec path that
    // survives admission may retain it when a verified persisted path exists.
    promptExecutionSnapshotRoot: persistedSnapshotRoot,
    workflowPath: controls.persistedWorkflowPath ?? controls.loadedWorkflowPath,
    executionSnapshotRoot: persistedSnapshotRoot
  };
}

function workflowExecutionSnapshotRoot(workflowPath: string): string | undefined {
  if (!path.isAbsolute(workflowPath)) return undefined;
  const workflows = path.dirname(workflowPath);
  const smithers = path.dirname(workflows);
  const candidate = path.dirname(smithers);
  if (
    path.basename(workflows) !== "workflows" ||
    path.basename(smithers) !== ".smithers" ||
    !existsSync(path.join(candidate, "dependencies", "manifest.json")) ||
    !existsSync(path.join(candidate, "controls", "plan.json"))
  ) {
    return undefined;
  }
  return candidate;
}

function sealedTaskPromptPath(attemptId: string, snapshotRoot: string | undefined): string | undefined {
  if (snapshotRoot === undefined) return undefined;
  const promptPath = path.join(snapshotRoot, "controls", "rendered-prompts", `${attemptId}.md`);
  if (!existsSync(promptPath)) throw new Error(`sealed rendered prompt is missing for ${attemptId}`);
  return promptPath;
}

function sealedRuntimeControlPath(name: string, controls: AdmittedWorkflowControls): string | undefined {
  const snapshotRoot = controls.persistedExecutionSnapshotRoot ?? controls.loadedExecutionSnapshotRoot;
  if (snapshotRoot === undefined) return undefined;
  const candidate = path.join(snapshotRoot, "controls", name);
  return existsSync(candidate) ? candidate : undefined;
}

function cloudSnapshotRelativePath(value: string, label: string): string {
  const relative = path.relative(process.cwd(), value);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the cloud handoff project`);
  }
  return relative.split(path.sep).join("/");
}
const usesCloudExecution = [...compiledBaseTasks, ...dynamicGroupSpecs.flatMap((group) => group.taskTemplates)].some(
  (task) => task.execution.mode === "cloud"
);
const isCloudWorkerProcess = process.env.ULTRAFUZZ_CLOUD_WORKER === "1";
const modalModule =
  usesCloudExecution && !isCloudWorkerProcess
    ? await import(process.env.ULTRAFUZZ_MODAL_MODULE ?? __ULTRAFUZZ_MODAL_MODULE__)
    : undefined;
const modalExecution = [...compiledBaseTasks, ...dynamicGroupSpecs.flatMap((group) => group.taskTemplates)].find(
  (task) => task.execution.mode === "cloud"
)?.execution.modal;
const cloudProvider =
  modalModule === undefined || modalExecution === undefined
    ? undefined
    : modalModule.createModalNodeSandboxProvider({
        app: modalExecution.app,
        image: modalExecution.image,
        ...(modalExecution.region === undefined ? {} : { region: modalExecution.region }),
        credentialEnv: modalExecution.credentialEnv
      });
const cloudExecutionGeneration = readCloudExecutionGeneration();
const agentPromptTemplate = __ULTRAFUZZ_AGENT_PROMPT_TEMPLATE__;
const authorizedDefensiveSecurityContext = __ULTRAFUZZ_AUTHORIZED_DEFENSIVE_SECURITY_CONTEXT__;
const untrustedContentBoundary = __ULTRAFUZZ_UNTRUSTED_CONTENT_BOUNDARY__;
const retryFailureTemplate = __ULTRAFUZZ_RETRY_FAILURE_TEMPLATE__;
const pinnedSourceBranch = "ultrafuzz-pinned";
const pinnedSourceRef = `refs/heads/${pinnedSourceBranch}`;
const usesPinnedSource = sourceUsesPinnedBranch();
// Smithers defaults `<Worktree baseBranch>` to "main". For a benchmark run that is correct,
// because `ultrafuzz-pinned` names the sealed revision; for an ordinary run launched from any
// other revision it silently bases every task worktree on a tree the run was never pointed at,
// so agents audit the wrong source and the run's own commit pinning is not what executes.
// Resolve the launch revision instead of naming a branch: a commit id is what the run pinned,
// it needs no branch to exist, and it cannot drift while the run is in flight.
const localSourceCommit = resolveLocalSourceCommit();

function dynamicExecutionPath(task: (typeof compiledBaseTasks)[number], value: string, label: string): string {
  const relative = path.relative(sourceProjectRoot, path.resolve(value));
  if (relative === "" || relative === "." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a project child path`);
  }
  return task.execution.mode === "cloud" ? relative.split(path.sep).join("/") : path.resolve(process.cwd(), relative);
}

function dynamicExecutionMetadata(task: (typeof compiledBaseTasks)[number]) {
  return {
    ...task.metadata,
    workspace: {
      ...task.metadata.workspace,
      path: dynamicExecutionPath(task, task.metadata.workspace.path, "workspace metadata path")
    },
    artifacts: {
      ...task.metadata.artifacts,
      dir: dynamicExecutionPath(task, task.metadata.artifacts.dir, "artifact metadata directory"),
      manifestPath: dynamicExecutionPath(task, task.metadata.artifacts.manifestPath, "artifact manifest path")
    }
  };
}

function taskSpecsFromCompiled(tasks: typeof compiledBaseTasks) {
  return tasks.map((task) => {
    const controlPaths = taskWorkflowControlPaths(task.execution.mode, admittedWorkflowControls);
    const compiled = serializedTaskSpecs.find((candidate) => candidate.id === task.smithersNodeId);
    const runtimePromptPath =
      task.renderedPromptPath === undefined
        ? undefined
        : path.resolve(process.cwd(), dynamicExecutionPath(task, task.renderedPromptPath, "rendered prompt"));
    // A static compiled prompt exists in the initial execution seal. A deferred or generated prompt
    // cannot exist there, so it stays in the run root and is bound by selected_task plus the handoff
    // content digest instead.
    const promptPath =
      compiled?.promptPath === undefined
        ? runtimePromptPath
        : (sealedTaskPromptPath(task.attemptId, controlPaths.promptExecutionSnapshotRoot) ?? runtimePromptPath);
    return {
      id: task.smithersNodeId,
      preparationId: `prepare:${task.attemptId}`,
      verifierId: task.verifierSmithersNodeId,
      attemptId: task.attemptId,
      dependsOn: task.dependencySmithersNodeIds,
      dynamicDependencies: task.dynamicDependencies ?? [],
      agentRef: task.agentRef,
      modelName: task.modelName ?? null,
      reasoningEffort: task.reasoningEffort ?? null,
      prompt: "",
      promptPath,
      promptRelativePath:
        promptPath === undefined
          ? undefined
          : task.execution.mode === "cloud" && controlPaths.executionSnapshotRoot !== undefined
            ? cloudSnapshotRelativePath(promptPath, "rendered prompt path")
            : projectRelativePath(task.renderedPromptPath!, "rendered prompt"),
      workspaceRelativePath: dynamicExecutionPath(task, task.workspacePath, "task workspace"),
      workspacePath: path.resolve(process.cwd(), dynamicExecutionPath(task, task.workspacePath, "task workspace")),
      artifactRelativeDir: dynamicExecutionPath(task, task.artifactDir, "task artifact directory"),
      artifactDir: path.resolve(process.cwd(), dynamicExecutionPath(task, task.artifactDir, "task artifact directory")),
      dependencyArtifactDirs: task.dependencyArtifactDirs.map((directory) =>
        dynamicExecutionPath(task, directory, "dependency artifact directory")
      ),
      referenceArtifactDirs: (task.referenceArtifactDirs ?? []).map((directory) =>
        dynamicExecutionPath(task, directory, "reference artifact directory")
      ),
      ...(task.vulnerabilityDatabaseCatalog === undefined
        ? {}
        : {
            vulnerabilityDatabase: {
              catalogPath: dynamicExecutionPath(
                task,
                task.vulnerabilityDatabaseCatalog.path,
                "vulnerability database catalog"
              ),
              catalogSha256: task.vulnerabilityDatabaseCatalog.sha256
            }
          }),
      runRoot: dynamicExecutionPath(task, path.resolve(task.artifactDir, "..", ".."), "run root"),
      workflowPath:
        controlPaths.workflowPath ??
        path.resolve(
          process.cwd(),
          dynamicExecutionPath(
            task,
            path.resolve(sourceProjectRoot, __ULTRAFUZZ_WORKFLOW_PATH_RELATIVE__),
            "workflow path"
          )
        ),
      executionSnapshotRoot: controlPaths.executionSnapshotRoot,
      sourceProjectRoot,
      branch: `ultrafuzz/${__ULTRAFUZZ_RUN_ID_LITERAL__}/${task.attemptId}`,
      timeoutMs: task.timeoutMs,
      runtimeContext: topologyRuntimeContextForTimeout(task.timeoutMs),
      heartbeatTimeoutMs: task.heartbeatTimeoutMs,
      retries: task.retries,
      retryPolicy: task.retryPolicy,
      metadata: dynamicExecutionMetadata(task),
      outputs: task.metadata.artifacts.outputs,
      execution: task.execution
    };
  });
}

function projectRelativePath(value: string, label: string): string {
  const relative = path.relative(sourceProjectRoot, path.resolve(value));
  if (relative === "" || relative === "." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a project child path`);
  }
  return relative.split(path.sep).join("/");
}

/**
 * Restates one task's metadata as the exact handoff metadata DTO.
 *
 * Every member is named explicitly instead of spread, so a field that only exists after hydration --
 * or a future compiled-task field -- can never silently cross the trust boundary.
 */
function cloudSelectedTaskMetadata(metadata: (typeof taskSpecs)[number]["metadata"]) {
  const node = metadata.node as Record<string, undefined | string | Record<string, string>>;
  const model = metadata.model as Record<string, undefined | string | number> | undefined;
  const dynamic = node.dynamic as Record<string, string> | undefined;
  return {
    schemaVersion: metadata.schemaVersion,
    run: {
      ultrafuzzRunId: metadata.run.ultrafuzzRunId,
      smithersWorkflowName: metadata.run.smithersWorkflowName,
      graphVersion: metadata.run.graphVersion,
      topologyVersion: metadata.run.topologyVersion
    },
    node: {
      concreteNodeId: node.concreteNodeId,
      logicalNodeId: node.logicalNodeId,
      attemptId: node.attemptId,
      label: node.label,
      kind: node.kind,
      ...(node.role === undefined ? {} : { role: node.role }),
      ...(node.promptPath === undefined ? {} : { promptPath: node.promptPath }),
      ...(node.group === undefined ? {} : { group: node.group }),
      ...(node.producerNodeId === undefined ? {} : { producerNodeId: node.producerNodeId }),
      ...(node.storageId === undefined ? {} : { storageId: node.storageId }),
      ...(dynamic === undefined
        ? {}
        : {
            dynamic: {
              groupNodeId: dynamic.groupNodeId,
              sourceNodeId: dynamic.sourceNodeId,
              sourceAttemptId: dynamic.sourceAttemptId,
              sourceDigest: dynamic.sourceDigest,
              expansionKey: dynamic.expansionKey,
              itemDigest: dynamic.itemDigest,
              manifestPath: dynamic.manifestPath
            }
          })
    },
    dependencies: {
      concreteNodeIds: [...metadata.dependencies.concreteNodeIds],
      attemptIds: [...metadata.dependencies.attemptIds],
      smithersNodeIds: [...metadata.dependencies.smithersNodeIds]
    },
    loop: {
      index: metadata.loop.index,
      count: metadata.loop.count,
      mode: metadata.loop.mode,
      attemptIndex: metadata.loop.attemptIndex
    },
    ...(model === undefined
      ? {}
      : {
          model: {
            profileId: model.profileId,
            agentRef: model.agentRef,
            ...(model.modelName === undefined ? {} : { modelName: model.modelName }),
            ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
            modelIndex: model.modelIndex,
            attemptIndex: model.attemptIndex
          }
        }),
    // `repoPath` is deliberately dropped: it is controller-only provenance the worker never reads and
    // cannot resolve in its relocated root, so the shared contract refuses it as an unknown key.
    workspace: {
      primitive: metadata.workspace.primitive,
      path: metadata.workspace.path,
      trustModel: metadata.workspace.trustModel
    },
    artifacts: {
      dir: metadata.artifacts.dir,
      outputs: metadata.artifacts.outputs.map((output) => ({
        path: output.path,
        contract: output.contract,
        contractDigest: output.contractDigest,
        primary: output.primary
      })),
      manifestPath: metadata.artifacts.manifestPath
    },
    retryPolicy: {
      maxAttempts: metadata.retryPolicy.maxAttempts,
      smithersRetries: metadata.retryPolicy.smithersRetries
    },
    timeout: {
      milliseconds: metadata.timeout.milliseconds,
      seconds: metadata.timeout.seconds,
      heartbeatTimeoutMs: metadata.timeout.heartbeatTimeoutMs
    },
    execution: {
      mode: metadata.execution.mode,
      ...(metadata.execution.provider === undefined ? {} : { provider: metadata.execution.provider }),
      resources: {
        cpu: metadata.execution.resources.cpu,
        memoryMiB: metadata.execution.resources.memoryMiB,
        timeoutSeconds: metadata.execution.resources.timeoutSeconds
      }
    }
  };
}

/**
 * The explicit controller-to-worker handoff DTO for one already-materialized concrete attempt.
 *
 * A cloud worker must never rematerialize controller-global dynamic state: it receives no graph, task
 * plan, expansion manifest, or template snapshot. Only the fields required to execute this attempt
 * are constructed -- never a spread of a hydrated spec -- and every path is project-relative so the
 * spec stays valid in the relocated worker root. The worker derives the inline prompt body, the
 * dependency edges, the runtime context, the outputs list, and the hydration path aliases itself.
 */
function buildCloudSelectedTaskHandoff(
  task: {
    id: string;
    attemptId: string;
    preparationId: string;
    verifierId: string;
    agentRef: string;
    modelName: string | null;
    reasoningEffort: string | null;
    branch: string;
    runRoot: string;
    workflowPath: string;
    sourceProjectRoot: string;
    dependencyArtifactDirs: readonly string[];
    referenceArtifactDirs?: readonly string[];
    vulnerabilityDatabase?: { catalogPath: string; catalogSha256: string };
    timeoutMs: number;
    heartbeatTimeoutMs: number;
    retries: number;
    retryPolicy: { backoff: "exponential"; initialDelayMs: number; maxDelayMs: number };
    metadata: (typeof taskSpecs)[number]["metadata"];
    execution: { mode: "local" | "cloud" };
  },
  relative: { promptPath: string; workspacePath: string; artifactDir: string },
  executionGeneration: string
) {
  return {
    schema_version: CLOUD_SELECTED_TASK_SCHEMA_VERSION,
    id: task.id,
    attemptId: task.attemptId,
    preparationId: task.preparationId,
    verifierId: task.verifierId,
    agentRef: task.agentRef,
    modelName: task.modelName ?? null,
    reasoningEffort: task.reasoningEffort ?? null,
    branch: task.branch,
    promptPath: relative.promptPath,
    workspacePath: relative.workspacePath,
    artifactDir: relative.artifactDir,
    runRoot: task.runRoot,
    workflowPath: cloudSnapshotRelativePath(task.workflowPath, "workflow path"),
    sourceProjectRoot: task.sourceProjectRoot,
    dependencyArtifactDirs: [...task.dependencyArtifactDirs],
    referenceArtifactDirs: [...(task.referenceArtifactDirs ?? [])],
    ...(task.vulnerabilityDatabase === undefined
      ? {}
      : {
          vulnerabilityDatabase: {
            catalogPath: task.vulnerabilityDatabase.catalogPath,
            catalogSha256: task.vulnerabilityDatabase.catalogSha256
          }
        }),
    timeoutMs: task.timeoutMs,
    heartbeatTimeoutMs: task.heartbeatTimeoutMs,
    retries: task.retries,
    retryPolicy: {
      backoff: task.retryPolicy.backoff,
      initialDelayMs: task.retryPolicy.initialDelayMs,
      maxDelayMs: task.retryPolicy.maxDelayMs
    },
    metadata: cloudSelectedTaskMetadata(task.metadata),
    execution: { mode: task.execution.mode, generation: executionGeneration }
  };
}

/** The DTO the controller dispatches, built from the hydrated spec's project-relative locations. */
function cloudSelectedTaskHandoff(task: (typeof taskSpecs)[number]) {
  return buildCloudSelectedTaskHandoff(
    task,
    {
      promptPath: task.promptRelativePath as string,
      workspacePath: task.workspaceRelativePath,
      artifactDir: task.artifactRelativeDir
    },
    cloudExecutionGeneration
  );
}

/**
 * The canonical DTO a compiled attempt must produce.
 *
 * A compiled spec already stores cloud locations project-relative. When its prompt rendering was
 * deferred to runtime expansion, the canonical prompt is the attempt's own rendered prompt inside its
 * own artifact directory -- the one location runtime materialization is allowed to supply.
 */
function compiledCanonicalSelectedTask(compiled: (typeof serializedTaskSpecs)[number], executionGeneration: string) {
  const hydrated = hydrateTaskSpec(compiled);
  return buildCloudSelectedTaskHandoff(
    hydrated,
    {
      promptPath:
        hydrated.promptRelativePath ??
        `${compiled.artifactDir}/${CLOUD_SELECTED_TASK_RUNTIME_PROMPT_BASENAME as string}`,
      workspacePath: compiled.workspacePath,
      artifactDir: compiled.artifactDir
    },
    executionGeneration
  );
}

/**
 * Every attempt ID one declared dynamic group could materialize for a generated concrete node ID.
 *
 * A group's storage identity is a pure function of the group node ID and the generated node ID, and
 * the per-template attempt suffix comes from the group's own compiled model fan-out, so the whole set
 * is derivable from compile-time constants inside a relocated worker -- no expansion manifest needed.
 */
function generatedAttemptIdsFor(group: (typeof dynamicGroupSpecs)[number], generatedNodeId: string): string[] {
  const storageId = dynamicStorageId(group.groupNodeId, generatedNodeId) as string;
  if (group.taskTemplates.length <= 1) return [storageId];
  return group.taskTemplates.map((template, index) => {
    const model = template.metadata.model;
    return `${storageId}__model_${model?.modelIndex ?? index}__attempt_${model?.attemptIndex ?? index}`;
  });
}

/**
 * Correlated runtime-materialization evidence for the dynamic groups one compiled task declared.
 *
 * A handoff may only gain a dependency that one of those groups could actually have produced: a
 * generated child's own attempt, or -- when a group expanded to no items -- the group's compiled
 * source attempt, which is the single fallback runtime lowering substitutes.
 */
function runtimeDependencyEvidence(groupNodeIds: readonly string[]) {
  const groups = groupNodeIds.map((groupNodeId) => {
    const group = dynamicGroupSpecs.find((candidate) => candidate.groupNodeId === groupNodeId);
    if (group === undefined) {
      throw new Error(`cloud worker task declares unknown dynamic group ${groupNodeId}`);
    }
    return group;
  });
  return {
    admissibleAttemptIds(concreteNodeId: string): string[] {
      return groups.flatMap((group) => [
        ...generatedAttemptIdsFor(group, concreteNodeId),
        ...(group.source.concreteNodeId === concreteNodeId ? [group.source.attemptId] : [])
      ]);
    },
    requiredVerifierSmithersNodeId(concreteNodeId: string, attemptId: string): string | undefined {
      for (const group of groups) {
        if (group.source.concreteNodeId === concreteNodeId && group.source.attemptId === attemptId) {
          return group.source.verifierSmithersNodeId;
        }
        if (generatedAttemptIdsFor(group, concreteNodeId).includes(attemptId)) {
          return `verify:${attemptId}`;
        }
      }
      return undefined;
    }
  };
}

/**
 * Resolves the declared dynamic group and template that could have produced one dispatched attempt.
 *
 * The group is never taken from the handoff: it is the group whose compile-time storage derivation
 * actually yields the dispatched attempt ID from the claimed generated node ID. Group, storage
 * identity, and attempt identity therefore form one mutually consistent claim instead of three
 * independent ones a runtime-generated attempt could each choose freely.
 */
function generatingGroupFor(
  concreteNodeId: string,
  attemptId: string
): { group: (typeof dynamicGroupSpecs)[number]; template: (typeof compiledBaseTasks)[number] } | undefined {
  for (const group of dynamicGroupSpecs) {
    const index = generatedAttemptIdsFor(group, concreteNodeId).indexOf(attemptId);
    const template = index < 0 ? undefined : group.taskTemplates[index];
    if (template !== undefined) return { group, template: template as (typeof compiledBaseTasks)[number] };
  }
  return undefined;
}

/**
 * Placeholder for the three values only the expansion itself produced.
 *
 * These are never compared: the shared contract relaxes exactly the expansion key and the two runtime
 * digests. The placeholder exists so the reconstructed canonical DTO stays structurally complete,
 * which is what makes an *absent* dynamic provenance block a mismatch rather than a silent omission.
 */
const GENERATED_EXPANSION_PLACEHOLDER = "<runtime-expansion-value>";

/**
 * The canonical DTO a runtime-generated child of one declared dynamic group must produce.
 *
 * A generated attempt has no compiled spec of its own, so without this every constant it inherits
 * would be attacker-chosen. Everything its group's compiled template fixes is reconstructed here from
 * compile-time constants -- the run root and every path derived from it, the snapshotted prompt
 * template's rendered location, the agent and model profile, the execution mode/provider/resources,
 * the artifact output contracts, the pinned planner catalog, and the reference trees -- so only the
 * three expansion-only values above remain runtime-supplied.
 */
function generatedCanonicalSelectedTask(
  group: (typeof dynamicGroupSpecs)[number],
  template: (typeof compiledBaseTasks)[number],
  concreteNodeId: string,
  attemptId: string,
  expansionKey: string,
  executionGeneration: string
) {
  const runRoot = path.resolve(sourceProjectRoot, __ULTRAFUZZ_RUN_ROOT_RELATIVE__);
  const artifactDir = path.join(runRoot, "artifacts", attemptId);
  const workspacePath = path.join(runRoot, "workspaces", attemptId);
  const generated = {
    ...template,
    attemptId,
    concreteNodeId,
    smithersNodeId: `node:${attemptId}`,
    verifierSmithersNodeId: `verify:${attemptId}`,
    workspacePath,
    artifactDir,
    renderedPromptPath: path.join(artifactDir, CLOUD_SELECTED_TASK_RUNTIME_PROMPT_BASENAME as string),
    metadata: {
      ...template.metadata,
      node: {
        ...template.metadata.node,
        concreteNodeId,
        attemptId,
        // The label is the template's compiled label composed with the claimed expansion key, so it
        // stays bound to a compile-time constant even though the key itself is runtime data.
        label: `${template.metadata.node.label}: ${expansionKey}`,
        producerNodeId: concreteNodeId,
        storageId: dynamicStorageId(group.groupNodeId, concreteNodeId) as string,
        dynamic: {
          groupNodeId: group.groupNodeId,
          sourceNodeId: group.source.concreteNodeId,
          sourceAttemptId: group.source.attemptId,
          sourceDigest: GENERATED_EXPANSION_PLACEHOLDER,
          expansionKey: GENERATED_EXPANSION_PLACEHOLDER,
          itemDigest: GENERATED_EXPANSION_PLACEHOLDER,
          manifestPath: `dynamic-expansions/${group.groupNodeId}.json`
        }
      },
      workspace: { ...template.metadata.workspace, path: workspacePath },
      artifacts: {
        ...template.metadata.artifacts,
        dir: artifactDir,
        manifestPath: path.join(artifactDir, "artifact-manifest.json")
      }
    }
  };
  const hydrated = taskSpecsFromCompiled([generated] as unknown as typeof compiledBaseTasks)[0]!;
  return buildCloudSelectedTaskHandoff(
    hydrated,
    {
      promptPath: hydrated.promptRelativePath as string,
      workspacePath: hydrated.workspaceRelativePath,
      artifactDir: hydrated.artifactRelativeDir
    },
    executionGeneration
  );
}

/** Resolves one validated project-relative handoff path inside the relocated worker root. */
function relocatedHandoffPath(value: string, label: string): string {
  const workerRoot = path.resolve(process.cwd());
  const resolved = path.resolve(workerRoot, value);
  if (resolved === workerRoot || !resolved.startsWith(`${workerRoot}${path.sep}`)) {
    throw new Error(`cloud worker selected_task ${label} must stay inside the relocated project root`);
  }
  return resolved;
}

/**
 * Re-verifies the relocated vulnerability-database catalog against its declared digest.
 *
 * The worker never inherits the controller's verification: the catalog travels inside the handoff
 * archive and is then extracted into a durable volume workspace that survives retries, so absence, an
 * irregular entry, and tampered bytes are each distinct, explicit failures rather than a silently
 * different planner catalog feeding threat-model and goal-plan postprocessing.
 */
function assertRelocatedVulnerabilityDatabaseCatalog(catalogPath: string, expectedSha256: string): void {
  if (!existsSync(catalogPath)) {
    throw new Error("cloud worker selected_task vulnerabilityDatabase catalog is absent from the relocated project");
  }
  let bytes: Buffer;
  try {
    // Lexical containment is insufficient here: a relocated durable workspace may contain a
    // symlinked parent component. Reuse the artifact boundary's realpath and symlink checks before
    // reading so matching bytes outside the relocated root cannot satisfy the digest binding.
    assertRegularFileInside(process.cwd(), catalogPath, "cloud worker vulnerability database catalog");
    bytes = readFileSync(catalogPath);
  } catch (error) {
    throw new Error("cloud worker selected_task vulnerabilityDatabase catalog is unreadable in the relocated project", {
      cause: error
    });
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedSha256) {
    throw new Error(
      "cloud worker selected_task vulnerabilityDatabase catalog does not match its declared catalogSha256"
    );
  }
}

/**
 * Hydrates one validated handoff into exactly one runnable task spec.
 *
 * Fields the handoff deliberately omits are derived here rather than trusted: the empty inline prompt
 * body, the dropped dependency edges, the timeout-derived runtime context, and the outputs list the
 * attempt's own metadata already declares.
 */
function hydrateSelectedTaskHandoff(spec: ReturnType<typeof cloudSelectedTaskHandoff>): (typeof taskSpecs)[number] {
  if (spec.vulnerabilityDatabase !== undefined) {
    // The controller verified the catalog bytes it archived, but the bytes this worker will actually
    // read are the relocated ones. Re-hashing them here -- before any spec exists to hydrate and long
    // before a postprocessor consumes the catalog -- is what makes the declared digest binding.
    assertRelocatedVulnerabilityDatabaseCatalog(
      relocatedHandoffPath(spec.vulnerabilityDatabase.catalogPath, "vulnerability database catalog"),
      spec.vulnerabilityDatabase.catalogSha256
    );
  }
  for (const [label, candidates] of [
    ["dependency artifact directory", spec.dependencyArtifactDirs],
    ["reference artifact directory", spec.referenceArtifactDirs],
    ["run root", [spec.runRoot]],
    ["workflow path", [spec.workflowPath]],
    [
      "vulnerability database catalog",
      spec.vulnerabilityDatabase === undefined ? [] : [spec.vulnerabilityDatabase.catalogPath]
    ],
    ["artifact metadata directory", [spec.metadata.artifacts.dir, spec.metadata.artifacts.manifestPath]],
    ["workspace metadata path", [spec.metadata.workspace.path]]
  ] as Array<[string, readonly string[]]>) {
    for (const candidate of candidates) relocatedHandoffPath(candidate, label);
  }
  return {
    id: spec.id,
    preparationId: spec.preparationId,
    verifierId: spec.verifierId,
    attemptId: spec.attemptId,
    dependsOn: [] as string[],
    dynamicDependencies: [] as string[],
    agentRef: spec.agentRef,
    modelName: spec.modelName,
    reasoningEffort: spec.reasoningEffort,
    prompt: "",
    promptRelativePath: spec.promptPath,
    promptPath: relocatedHandoffPath(spec.promptPath, "rendered prompt"),
    workspaceRelativePath: spec.workspacePath,
    workspacePath: relocatedHandoffPath(spec.workspacePath, "task workspace"),
    artifactRelativeDir: spec.artifactDir,
    artifactDir: relocatedHandoffPath(spec.artifactDir, "task artifact directory"),
    dependencyArtifactDirs: [...spec.dependencyArtifactDirs],
    referenceArtifactDirs: [...spec.referenceArtifactDirs],
    ...(spec.vulnerabilityDatabase === undefined ? {} : { vulnerabilityDatabase: spec.vulnerabilityDatabase }),
    runRoot: spec.runRoot,
    workflowPath: spec.workflowPath,
    sourceProjectRoot: spec.sourceProjectRoot,
    branch: spec.branch,
    timeoutMs: spec.timeoutMs,
    runtimeContext: topologyRuntimeContextForTimeout(spec.timeoutMs),
    heartbeatTimeoutMs: spec.heartbeatTimeoutMs,
    retries: spec.retries,
    retryPolicy: spec.retryPolicy,
    metadata: spec.metadata,
    outputs: spec.metadata.artifacts.outputs,
    execution: spec.execution
  } as unknown as (typeof taskSpecs)[number];
}

/**
 * Reconstructs read-only specs for runtime-generated dependencies from this workflow's compiled
 * dynamic-group templates.
 *
 * The selected-task DTO already proves each runtime-added attempt belongs to a declared group, but
 * the initial serialized spec list cannot contain children that did not exist at compile time. The
 * worker still needs each child's compiled output contracts and logical producer identity to verify
 * its artifact marker and to resolve downstream findings/invariant provenance. Rebuilding those
 * constants here closes that gap without transporting controller-owned task plans or trusting a
 * second handoff DTO. Empty-group fallbacks are compiled source attempts and are excluded by
 * `compiledAttemptIds`; the shared correlation contract has already enforced their exact verifier
 * requirement, while every remaining generated dependency must retain its verifier here as well.
 */
function generatedDependencyTaskSpecs(
  selected: ReturnType<typeof cloudSelectedTaskHandoff>,
  executionGeneration: string
): typeof taskSpecs {
  const compiledAttemptIds = new Set(serializedTaskSpecs.map((task) => task.attemptId));
  const declaredVerifierIds = new Set(selected.metadata.dependencies.smithersNodeIds);
  const reconstructed: typeof taskSpecs = [];
  for (const dependencyArtifactDir of selected.dependencyArtifactDirs) {
    const dependencyAttemptId = path.posix.basename(dependencyArtifactDir);
    if (compiledAttemptIds.has(dependencyAttemptId)) continue;
    if (!declaredVerifierIds.has(`verify:${dependencyAttemptId}`)) {
      throw new Error(`cloud worker selected_task dependency ${dependencyAttemptId} is missing its verifier`);
    }

    const candidates = selected.metadata.dependencies.concreteNodeIds.flatMap((concreteNodeId) => {
      const generating = generatingGroupFor(concreteNodeId, dependencyAttemptId);
      return generating === undefined ? [] : [{ concreteNodeId, ...generating }];
    });
    if (candidates.length !== 1) {
      throw new Error(
        `cloud worker selected_task dependency ${dependencyAttemptId} does not resolve to exactly one compiled dynamic template`
      );
    }
    const candidate = candidates[0]!;
    const canonical = generatedCanonicalSelectedTask(
      candidate.group,
      candidate.template,
      candidate.concreteNodeId,
      dependencyAttemptId,
      GENERATED_EXPANSION_PLACEHOLDER,
      executionGeneration
    );
    if (canonical.artifactDir !== dependencyArtifactDir) {
      throw new Error(
        `cloud worker selected_task dependency ${dependencyAttemptId} disagrees with its compiled artifact directory`
      );
    }
    reconstructed.push(hydrateSelectedTaskHandoff(canonical));
  }
  return reconstructed;
}

/**
 * Validates one dispatch document against the exact outer input contract.
 *
 * Smithers already parses the declared input schema, but the relocated worker is launched from an
 * untrusted request document, so the workflow refuses unknown or aliased dispatch keys itself instead
 * of depending on where the document happened to enter the system.
 */
function parseWorkflowInput(value: unknown): z.infer<typeof inputSchema> {
  const parsed = inputSchema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(`ultrafuzz workflow input is invalid: ${detail}`);
  }
  return parsed.data;
}

/** Validates the handoff contract and hydrates one runnable spec plus read-only generated dependencies. */
function cloudWorkerTaskSpecs(input: Record<string, unknown>): typeof taskSpecs {
  const taskId = input.task_id;
  const attemptId = input.attempt_id;
  if (typeof taskId !== "string" || taskId === "") {
    throw new Error("cloud worker input must identify one task_id");
  }
  const compiled = serializedTaskSpecs.find((task) => task.id === taskId);
  const selected = input.selected_task;
  // Every cloud dispatch carries the controller's already-materialized handoff. There is no
  // no-handoff fallback: hydrating a compiled spec instead would silently substitute a *different*
  // attempt whenever the dispatch and the bundle disagree, which is exactly the disagreement the
  // handoff exists to make impossible.
  if (selected === undefined) {
    throw new Error(`cloud worker task ${taskId} requires an explicit selected_task handoff`);
  }
  // The dispatch always carries the attempt identity, so the handoff is bound to it unconditionally:
  // a runtime-generated dynamic attempt has no compiled spec to cross-check against.
  if (typeof attemptId !== "string" || attemptId === "") {
    throw new Error("cloud worker input must identify one attempt_id alongside selected_task");
  }
  // The generation names the sandbox, the durable attempt root, and the storage lineage this worker
  // publishes under. A relocated worker cannot rederive it, so the dispatch must state it exactly.
  if (!isCloudExecutionGeneration(input.execution_generation)) {
    throw new Error("cloud worker input must identify one bounded execution_generation alongside selected_task");
  }
  try {
    // A runtime-generated dynamic attempt has no compiled spec, so it is bound to this workflow's own
    // compiled constants and to the identities its dispatched attempt ID determines.
    const spec = parseCloudSelectedTask(selected, {
      taskId,
      attemptId,
      executionGeneration: input.execution_generation,
      // A relocated worker only ever executes a cloud attempt, so a self-consistent local handoff --
      // the shape a runtime-generated attempt with no compiled peer could smuggle -- is refused.
      ...CLOUD_SELECTED_TASK_CLOUD_EXECUTION,
      sourceProjectRoot,
      runId: __ULTRAFUZZ_RUN_ID_LITERAL__,
      workflowName: __ULTRAFUZZ_WORKFLOW_NAME__,
      workflowPath: admittedWorkflowRelativePath,
      preparationId: `prepare:${attemptId}`,
      verifierId: `verify:${attemptId}`,
      branch: `ultrafuzz/${__ULTRAFUZZ_RUN_ID_LITERAL__}/${attemptId}`
    });
    // When this workflow already compiled the attempt, the handoff must reproduce its entire
    // canonical DTO. Only runtime expansion of a declared dynamic dependency may extend it, and only
    // with correlated evidence of the materialization behind each added entry.
    if (compiled !== undefined) {
      const compiledBase = compiledBaseTasks.find((candidate) => candidate.smithersNodeId === taskId);
      const declaredGroups = compiledBase?.dynamicDependencies ?? [];
      assertCloudSelectedTaskMatchesCanonical(
        spec,
        compiledCanonicalSelectedTask(compiled, input.execution_generation),
        {
          ...(declaredGroups.length === 0 ? {} : { runtimeDependencies: runtimeDependencyEvidence(declaredGroups) }),
          allowsRuntimeRenderedPrompt: compiled.promptPath === undefined
        }
      );
    } else {
      // A runtime-generated child of a declared dynamic group. It has no compiled spec, so it is
      // bound to the whole canonical DTO its group's compiled template determines; only the three
      // expansion-only values the shared contract enumerates stay runtime-supplied.
      const generating = generatingGroupFor(spec.metadata.node.concreteNodeId, attemptId);
      if (generating === undefined || spec.metadata.node.dynamic?.groupNodeId !== generating.group.groupNodeId) {
        throw new Error(
          `cloud worker selected_task ${attemptId} is not a generated attempt of any dynamic group this workflow compiled`
        );
      }
      assertCloudSelectedTaskMatchesCanonical(
        spec,
        generatedCanonicalSelectedTask(
          generating.group,
          generating.template,
          spec.metadata.node.concreteNodeId,
          attemptId,
          spec.metadata.node.dynamic.expansionKey,
          input.execution_generation
        ),
        { allowsGeneratedExpansionValues: true }
      );
    }
    return [hydrateSelectedTaskHandoff(spec), ...generatedDependencyTaskSpecs(spec, input.execution_generation)];
  } catch (error) {
    const message = (error as Error).message;
    throw message.startsWith("cloud worker")
      ? (error as Error)
      : new Error(`cloud worker ${message}`, { cause: error });
  }
}

function currentProjectPath(value: string, label: string): string {
  const relative = path.relative(sourceProjectRoot, path.resolve(value));
  if (relative === "" || relative === "." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a project child path`);
  }
  return path.resolve(process.cwd(), relative);
}

function dynamicallyAvailableTaskSpecs(
  specs: typeof taskSpecs,
  expandedGroupIds: ReadonlySet<string>
): typeof taskSpecs {
  const blocked = new Set(
    specs
      .filter((task) => task.dynamicDependencies.some((groupId) => !expandedGroupIds.has(groupId)))
      .map((task) => task.id)
  );
  let changed = true;
  while (changed) {
    changed = false;
    const blockedVerifiers = new Set(specs.filter((task) => blocked.has(task.id)).map((task) => task.verifierId));
    for (const task of specs) {
      if (!blocked.has(task.id) && task.dependsOn.some((dependency) => blockedVerifiers.has(dependency))) {
        blocked.add(task.id);
        changed = true;
      }
    }
  }
  return specs.filter((task) => !blocked.has(task.id));
}

function sourceUsesPinnedBranch(): boolean {
  return invariantPinnedSourceRefExists(process.cwd(), pinnedSourceRef);
}
/**
 * The commit every task worktree branches from when the run is not using the pinned benchmark ref.
 *
 * Returning `undefined` restores Smithers' own default of "main", which is only right when HEAD
 * actually is main. Resolving HEAD to an id keeps a run reproducible against the revision it was
 * launched from, which is the whole point of pinning a source for an audit.
 */
function resolveLocalSourceCommit(): string | undefined {
  if (usesPinnedSource) return undefined;
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD^{commit}"], {
      cwd: process.cwd(),
      encoding: "utf8"
    }).trim();
    return /^[0-9a-f]{40}$/u.test(commit) ? commit : undefined;
  } catch {
    // Not a git checkout, or HEAD is unborn. Fall back to the Smithers default rather than
    // failing workflow generation over a worktree base.
    return undefined;
  }
}
function readCloudExecutionGeneration(): string {
  if (!usesCloudExecution) return "base";
  const generationPath = path.resolve(dynamicRunRoot, "smithers", "cloud-execution-generation.json");
  if (!existsSync(generationPath)) return "base";
  const parsed = JSON.parse(readFileSync(generationPath, "utf8")) as { generation?: unknown };
  if (typeof parsed.generation !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(parsed.generation)) {
    throw new Error("cloud execution generation evidence is invalid");
  }
  return parsed.generation;
}

function promptForTask(
  task: (typeof taskSpecs)[number],
  inputTask?: { prompt?: string; prompt_path?: string }
): string {
  let prompt: string;
  if (typeof inputTask?.prompt === "string") {
    prompt = inputTask.prompt;
  } else if (task.prompt.length > 0) {
    prompt = task.prompt;
  } else {
    const promptPath = task.promptPath ?? inputTask?.prompt_path;
    prompt = promptPath ? readFileSync(promptPath, "utf8") : "";
  }
  prompt = prompt.replaceAll(task.sourceProjectRoot, process.cwd());
  return prompt.replaceAll(task.artifactDir, mirroredArtifactDir(task));
}

function baseAgentForTask(task: (typeof taskSpecs)[number]): AgentLike | AgentLike[] | undefined {
  const factory = agentFactories[task.agentRef];
  if (factory === undefined) {
    return agentRegistry[task.agentRef];
  }
  return factory({
    ...(task.modelName === null ? {} : { model: task.modelName }),
    ...(task.reasoningEffort === null ? {} : { reasoningEffort: task.reasoningEffort }),
    addDir: [task.artifactDir, ...task.dependencyArtifactDirs]
  });
}

function agentForTask(task: (typeof taskSpecs)[number]): AgentLike | AgentLike[] | undefined {
  const selected = baseAgentForTask(task);
  if (selected === undefined) {
    return undefined;
  }
  return Array.isArray(selected)
    ? selected.map((agent) => artifactAwareAgent(task, agent))
    : artifactAwareAgent(task, selected);
}

function artifactAwareAgent(task: (typeof taskSpecs)[number], agent: AgentLike): AgentLike {
  let previousFailure: string | undefined;
  return {
    ...(agent.id === undefined ? {} : { id: `${agent.id}:ultrafuzz-artifacts` }),
    ...(agent.tools === undefined ? {} : { tools: agent.tools }),
    ...(agent.capabilities === undefined ? {} : { capabilities: agent.capabilities }),
    ...(agent.supportsNativeStructuredOutput === undefined
      ? {}
      : { supportsNativeStructuredOutput: agent.supportsNativeStructuredOutput }),
    ...(agent.preflight === undefined ? {} : { preflight: (args) => agent.preflight!(args) }),
    generate: async (args) => {
      // Smithers retries the same task in the same worktree. Preserve the
      // preparation task's first-attempt roots, but empty their exact contents
      // before every retry so outputs cannot span multiple model attempts.
      if ((args?.taskContext?.attempt ?? 1) > 1) {
        resetTaskArtifactsForRetry(task);
      }
      const attemptArgs = retryFailureAwareArgs(args, previousFailure);
      try {
        const result = await agent.generate(attemptArgs);
        // Agent work may replace or clean its worktree, including the prepared
        // artifact mirror. Re-establish the same path-checked directories before
        // preserving outputs; this remains deterministic and model-free.
        // Rebuild the artifact mirror after the agent without replaying setup
        // patches against the agent's now-dirty workspace. The first preparation
        // captured the producer baseline and applied all dependency patches;
        // replaying them here would either overwrite that baseline or fail with
        // a base-tree mismatch.
        prepareArtifactMirror(task, { replayWorkspacePatches: false, pinnedSubmodules: "verify" });
        materializeMissingMarkdownArtifacts(task, result);
        materializeCanonicalThreatModelArtifact(task);
        materializeGoalPlanDatabaseArtifacts(task);
        materializeMissingDedupeArtifact(task);
        normalizeLegacyFindingFields(task);
        normalizeFindingProvenance(task);
        reconstructAuthoritativeReportImplementationCoverage(task);
        reconstructAuthoritativeGoalSearchCoverage(task);
        normalizeLegacyReportProvenance(task);
        materializeMissingFinalReportArtifacts(task);
        normalizeLegacyGeneratedTestManifests(task);
        materializeGeneratedTestCompanions(task);
        materializeInvariantSuiteCompanions(task);
        materializeWorkspacePatch(task);
        // Keep artifact validation inside the agent task completion boundary.
        // This does not create a second model opportunity; it validates and, for
        // Markdown only, preserves the same agent's final response as its output.
        // Compatibility handling only adapts known legacy field representations;
        // generated-test companions are mirrored from their mandated workspace
        // path, and the strict verifier still validates every resulting artifact.
        //
        // `agentReturned` is unconditionally true here and the assertion is this line's position:
        // execution only reaches it because `agent.generate` above resolved, which is the very fact
        // Smithers is about to record as this task's output row (#677). The verifier NODE cannot make
        // that claim from the filesystem, so it reads the row instead.
        verifyArtifacts(task, { agentReturned: true });
        return result;
      } catch (error) {
        previousFailure = normalizeNodeAttemptFailureMessage(retryFailureText(error)) ?? "previous attempt failed";
        throw error;
      }
    }
  };
}

function retryFailureText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = "code" in error && typeof error.code === "string" ? ` (${error.code})` : "";
  return `${error.name}${code}: ${error.message}`;
}

function renderEmbeddedPromptTemplate(
  label: string,
  template: string,
  variables: Readonly<Record<string, string>>
): string {
  const unused = new Set(Object.keys(variables));
  const rendered = template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/gu, (_, key: string) => {
    const value = variables[key];
    if (value === undefined) throw new Error(`${label} is missing template variable ${key}`);
    unused.delete(key);
    return value;
  });
  if (unused.size > 0) {
    throw new Error(`${label} has unknown template variables ${Array.from(unused).sort().join(", ")}`);
  }
  return rendered;
}

function retryFailureAwareArgs<T extends { prompt?: unknown } | undefined>(
  args: T,
  previousFailure: string | undefined
): T {
  if (args === undefined || previousFailure === undefined || typeof args.prompt !== "string") return args;
  const boundaryEnd = `${untrustedContentBoundary}\n\n`;
  const boundaryIndex = args.prompt.indexOf(boundaryEnd);
  if (boundaryIndex < 0) throw new Error("retry feedback cannot locate the untrusted-content boundary");
  const insertionIndex = boundaryIndex + boundaryEnd.length;
  const failureSection = `${renderEmbeddedPromptTemplate("retry failure prompt", retryFailureTemplate, {
    previous_failure: previousFailure
  })}\n\n`;
  return {
    ...args,
    prompt: `${args.prompt.slice(0, insertionIndex)}${failureSection}${args.prompt.slice(insertionIndex)}`
  };
}

function isStrictlyInsideDirectory(root: string, candidate: string): boolean {
  return candidate !== root && candidate.startsWith(`${root}${path.sep}`);
}

function mirroredArtifactDir(task: (typeof taskSpecs)[number]): string {
  return path.join(task.workspacePath, "artifacts", task.attemptId);
}

function taskPromptPathForArtifactReset(artifactDir: string, promptPath: string | undefined): string | undefined {
  if (promptPath === undefined) return undefined;
  const candidate = path.resolve(promptPath);
  return path.dirname(candidate) === path.resolve(artifactDir) ? candidate : undefined;
}

function resetTaskArtifactsForRetry(task: (typeof taskSpecs)[number]): void {
  // Legacy runs keep prompt.rendered.md directly in the task artifact root, so
  // retry cleanup must preserve it. Sealed runs instead rebind task.promptPath
  // to the immutable execution snapshot. That file is outside this cleanup
  // root and is validated independently; treating it as a task-owned child
  // rejects every second attempt as an unsafe canonical input.
  const promptPath = taskPromptPathForArtifactReset(task.metadata.artifacts.dir, task.promptPath);
  resetTaskArtifactContents(task.metadata.artifacts.dir, task.attemptId, "canonical", promptPath);
  const canonicalArtifactRoot = realpathSync(task.metadata.artifacts.dir);
  const baselinePath = path.join(canonicalArtifactRoot, INVARIANT_SUITE_BASELINE_FILE);
  const baselineSnapshot = invariantSuiteBaselineSnapshots.get(canonicalArtifactRoot);
  if (baselineSnapshot !== undefined) {
    writeFileDurable(baselinePath, baselineSnapshot.contents);
  }
  // Tombstones are re-derived from the protected baseline on every companions
  // pass, so the previous attempt's deletions must not survive into this one.
  // The restored workspace snapshot puts a deleted source physically back, and
  // a stale tombstone would then suppress it durably for the whole invariant
  // chain: this stage would publish it as deleted and every descendant would
  // honour that in `inheritedInvariantSuiteTombstones`.
  invariantSuiteTombstones.delete(realpathSync(task.workspacePath));
  restoreInvariantSuiteWorkspaceSnapshot(task);

  const workspaceRoot = realpathSync(task.workspacePath);
  const artifactsParentCandidate = path.resolve(workspaceRoot, "artifacts");
  if (!isStrictlyInsideDirectory(workspaceRoot, artifactsParentCandidate)) {
    throw new Error(`artifact-contract failure: unsafe task artifact parent ${task.attemptId}`);
  }
  mkdirSync(artifactsParentCandidate, { recursive: true });
  const artifactsParent = realpathSync(artifactsParentCandidate);
  if (!isStrictlyInsideDirectory(workspaceRoot, artifactsParent)) {
    throw new Error(`artifact-contract failure: unsafe task artifact parent ${task.attemptId}`);
  }
  resetTaskArtifactContents(path.join(artifactsParent, task.attemptId), task.attemptId, "mirror");

  if (task.outputs.some((output) => output.contract === "ultrafuzz/generated-tests@1")) {
    for (const testRoot of invariantTestRoots(workspaceRoot)) {
      const foundryParentCandidate = path.resolve(workspaceRoot, testRoot, "foundry");
      if (!isStrictlyInsideDirectory(workspaceRoot, foundryParentCandidate)) {
        throw new Error(`artifact-contract failure: unsafe generated test parent ${task.attemptId}`);
      }
      mkdirSync(foundryParentCandidate, { recursive: true });
      const foundryParent = realpathSync(foundryParentCandidate);
      if (!isStrictlyInsideDirectory(workspaceRoot, foundryParent)) {
        throw new Error(`artifact-contract failure: unsafe generated test parent ${task.attemptId}`);
      }
      // Every directory the companion lookup accepts must be cleared, or the
      // previous attempt's test survives in the one this reset skipped and the
      // next attempt publishes it as its own.
      for (const nodeId of generatedTestNodeIds(task)) {
        resetTaskArtifactContents(path.join(foundryParent, nodeId), nodeId, "generated-test");
      }
    }
  }
  restoreWorkspacePatchPreparation(task, workspaceRoot);
  prepareArtifactMirror(task, { replayWorkspacePatches: false });
}

function resetTaskArtifactContents(
  rootPath: string,
  attemptId: string,
  label: "canonical" | "mirror" | "generated-test",
  preservedInputPath?: string
): void {
  const candidate = path.resolve(rootPath);
  if (path.basename(candidate) !== attemptId) {
    throw new Error(`artifact-contract failure: unsafe ${label} task artifact root ${attemptId}`);
  }
  const parent = realpathSync(path.dirname(candidate));
  try {
    lstatSync(candidate);
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }
  const anchoredRoot = realpathSync(candidate);
  if (anchoredRoot !== path.join(parent, attemptId)) {
    throw new Error(`artifact-contract failure: unsafe ${label} task artifact root ${attemptId}`);
  }
  const preservedInput =
    preservedInputPath === undefined
      ? undefined
      : resolveRegularArtifactFile(
          anchoredRoot,
          path.resolve(preservedInputPath),
          `artifact-contract failure: unsafe ${label} task input ${attemptId}`
        );
  if (preservedInput !== undefined && path.dirname(preservedInput) !== anchoredRoot) {
    throw new Error(`artifact-contract failure: unsafe ${label} task input ${attemptId}`);
  }
  for (const entry of readdirSync(anchoredRoot)) {
    const candidate = path.join(anchoredRoot, entry);
    if (
      candidate === preservedInput ||
      (label === "canonical" &&
        (entry === INVARIANT_SUITE_BASELINE_FILE ||
          entry === WORKSPACE_PATCH_BASELINE_FILE ||
          entry === WORKSPACE_PATCH_PREPARATION_FILE))
    )
      continue;
    rmSync(candidate, { recursive: true, force: true });
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function taskArtifactRoots(task: (typeof taskSpecs)[number], canonicalArtifactDir: string): string[] {
  const roots = [canonicalArtifactDir];
  try {
    const workspaceRoot = realpathSync(task.workspacePath);
    const candidate = path.resolve(workspaceRoot, "artifacts", task.attemptId);
    if (!isStrictlyInsideDirectory(workspaceRoot, candidate) || !existsSync(candidate)) {
      return roots;
    }
    const mirroredRoot = realpathSync(candidate);
    if (isStrictlyInsideDirectory(workspaceRoot, mirroredRoot)) {
      roots.push(mirroredRoot);
    }
  } catch {
    // The strict verifier below will report the required output as missing.
  }
  return roots;
}

/**
 * Name the preparation step that threw, because the stack cannot.
 *
 * Bun discards the user frames of an error raised inside a Smithers task body. Every one of
 * the 53 `prepare:*` failures in issue #672 arrived as a bare
 * `TypeError: undefined is not an object (evaluating 'get')` whose entire stack was
 * `at run (node:async_hooks:68:37)` and `at processTicksAndRejections (native:7:39)` -- no
 * file, no line, nothing to bisect, across 26% of every node failure in an 18-hour run.
 *
 * Preparation is synchronous, so the throw site is still on the stack when we catch it here.
 * Recording which of the twelve steps failed turns "somewhere in preparation" into one step,
 * and `cause` keeps the original error and its stack intact for anything that inspects it.
 */
function preparationStep<T>(attemptId: string, step: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw new Error(
      `prepare:${attemptId} failed at step ${step}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

function prepareArtifactMirror(
  task: (typeof taskSpecs)[number],
  options: { replayWorkspacePatches?: boolean; pinnedSubmodules?: "restore" | "verify" } = {}
): z.infer<typeof preparationOutput> {
  const workspaceRoot = preparationStep(task.attemptId, "resolve-workspace-root", () =>
    realpathSync(task.workspacePath)
  );
  if (options.pinnedSubmodules === "verify") {
    preparationStep(task.attemptId, "verify-pinned-submodules", () =>
      verifyPinnedSubmodulesFromExecutionSnapshot({
        executionSnapshotRoot: task.executionSnapshotRoot,
        workspaceRoot,
        expectation: task.pinnedSubmodules ?? undefined
      })
    );
  } else {
    preparationStep(task.attemptId, "hydrate-pinned-submodules", () =>
      hydratePinnedSubmodulesFromExecutionSnapshot({
        executionSnapshotRoot: task.executionSnapshotRoot,
        workspaceRoot,
        expectation: task.pinnedSubmodules ?? undefined
      })
    );
  }
  preparationStep(task.attemptId, "preserve-pinned-source-proof", () => preservePinnedSourceProof(task));
  preparationStep(task.attemptId, "materialize-prompt-schemas", () =>
    materializePromptSchemas(path.join(workspaceRoot, ".ultrafuzz", "schemas"))
  );
  preparationStep(task.attemptId, "assert-task-inputs", () => assertTaskInputs(task, workspaceRoot));
  preparationStep(task.attemptId, "materialize-workspace-patch-dependencies", () =>
    materializeWorkspacePatchDependencies(task, workspaceRoot, options.replayWorkspacePatches ?? true)
  );
  preparationStep(task.attemptId, "restore-invariant-suite-snapshot", () =>
    restoreInvariantSuiteWorkspaceSnapshot(task, {
      // On the post-agent pass, preserve source files authored in this attempt
      // until materializeWorkspacePatch captures them. Initial preparation and
      // retry reset calls use the default and remove stale sources.
      preserveCurrentSources: options.replayWorkspacePatches === false
    })
  );
  preparationStep(task.attemptId, "materialize-invariant-suite", () =>
    materializeInvariantSuiteFromDependencies(task, workspaceRoot)
  );
  preparationStep(task.attemptId, "capture-invariant-suite-snapshot", () =>
    captureInvariantSuiteWorkspaceSnapshot(task, workspaceRoot)
  );
  const candidate = path.resolve(workspaceRoot, "artifacts", task.attemptId);
  if (!isStrictlyInsideDirectory(workspaceRoot, candidate)) {
    throw new Error(`artifact-contract failure: unsafe task artifact mirror ${task.attemptId}`);
  }
  preparationStep(task.attemptId, "create-artifact-mirror", () => mkdirSync(candidate, { recursive: true }));
  const mirrorRoot = preparationStep(task.attemptId, "resolve-artifact-mirror", () => realpathSync(candidate));
  if (!isStrictlyInsideDirectory(workspaceRoot, mirrorRoot)) {
    throw new Error(`artifact-contract failure: unsafe task artifact mirror ${task.attemptId}`);
  }
  preparationStep(task.attemptId, "capture-invariant-suite-baseline", () =>
    captureInvariantSuiteBaseline(task, workspaceRoot)
  );

  for (const output of task.outputs) {
    const artifactPath = path.resolve(mirrorRoot, output.path);
    if (!isStrictlyInsideDirectory(mirrorRoot, artifactPath)) {
      throw new Error(`artifact-contract failure: unsafe output path ${output.path}`);
    }
    const parentPath = path.dirname(artifactPath);
    mkdirSync(parentPath, { recursive: true });
    const resolvedParent = realpathSync(parentPath);
    if (resolvedParent !== mirrorRoot && !isStrictlyInsideDirectory(mirrorRoot, resolvedParent)) {
      throw new Error(`artifact-contract failure: unsafe output parent ${output.path}`);
    }

    const emptyArtifact = canonicalEmptyArtifact(task, output);
    if (emptyArtifact !== undefined && !existsSync(artifactPath)) {
      writeFileSync(artifactPath, emptyArtifact, { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
  }
  return { prepared: true };
}

function taskPublishesWorkspacePatch(task: (typeof taskSpecs)[number]): boolean {
  return (
    task.outputs.some((output) => output.path === "workspace.patch" && output.contract === "ultrafuzz/text@1") &&
    task.outputs.some(
      (output) => output.path === "workspace-patch.json" && output.contract === "ultrafuzz/workspace-patch@1"
    )
  );
}

/**
 * Where replay of a dependency chain should START, given the worktree it is replaying into (issue #312).
 *
 * Replaying every dependency patch unconditionally is correct on a fresh run: the task worktree begins at
 * the pinned baseline, so each patch's declared `base_tree` is satisfied in turn down the chain. A RESUMED
 * run breaks that precondition, because the worktree lives on a durable volume and still holds the
 * previous attempt's state. R48 died on it at this node with `expected 2dd4efef… got bf324c39…`, and its
 * dependency manifests, dumped from the volume, show why: the worktree was at the END of the chain, so
 * every dependency's content was already present and `applyWorkspacePatch` threw only because it compares
 * the worktree against one patch's own `base_tree` in isolation. R49 failed at the same node with the same
 * expected tree (`got b8d46f13…`), but its manifests were never dumped, so its worktree being at the end
 * of ITS chain is a hypothesis, not a measurement.
 *
 * Two conditions are needed, and only the first is a hash identity:
 *
 *   1. The worktree's tree equals dependency `i`'s declared `result_tree`. A tree id is a content hash, so
 *      this means the workspace is identical to that dependency's output over the snapshot the hash covers
 *      — every path `stageWorkspaceTree` stages. Content outside it is content no patch can carry either,
 *      because `captureWorkspacePatch` diffs the same staged index, so nothing patch-delivered is missed.
 *   2. The dependencies BEFORE `i` form a chain into it, each one's `result_tree` being the next one's
 *      `base_tree`. Without this, "everything before `i` is already materialized" is an inference about
 *      topology rather than a fact about content — and a false one for a fan-in of siblings that share a
 *      base and diverge, where skipping to the end would silently drop a sibling's work and leave a hole
 *      that every descendant then inherits through this task's own published patch.
 *
 * Condition 2 is why this checks the prefix instead of trusting the ordering. A partial skip is
 * self-validating (the next `applyWorkspacePatch` re-checks `base_tree` and throws), but a TOTAL skip
 * validates nothing at all, and that is exactly the case a non-chain fan-in produces.
 *
 * Today's topology pins `loops: 1` on every patch publisher, so a sibling fan-in is not reachable; but
 * `loop_mode` defaults to `parallel`, nothing validates linearity of `workspace-patch@1` publishers, and
 * the dependency sort follows topology DECLARATION order, which is not required to be causal order. A
 * one-line topology change should not silently corrupt a workspace.
 *
 * When the prefix is not a chain this returns 0: replay everything, and let `applyWorkspacePatch` raise
 * its base-tree mismatch exactly as it does today. Failing the way we already fail is the safe direction.
 */
/**
 * Render schema-validation issues so the failure names WHERE it happened.
 *
 * `validateWithZod` computes a path for every issue and both call sites used to map `issue.message` alone,
 * discarding it. R51 died three times on `implemented-properties.json` and the durable error read
 * `Too small: expected array to have >=1 items` eighty-eight times with nothing to distinguish them --
 * while the issues themselves carried `properties.0.reference_expectations` all along (issue #328).
 *
 * Identical messages are collapsed with their paths listed, because eighty-eight copies of one sentence is
 * not eighty-eight problems, and the paths are the only part that varies. Truncated, because a document
 * with thousands of entries should not turn one failure into an unreadable durable record -- the same
 * reasoning as the capture-attribution cap in #311.
 */
function formatSchemaValidationIssues(issues: readonly { path: string; message: string }[]): string {
  const byMessage = new Map<string, string[]>();
  for (const issue of issues) {
    const paths = byMessage.get(issue.message) ?? [];
    paths.push(issue.path);
    byMessage.set(issue.message, paths);
  }
  return [...byMessage.entries()]
    .map(([message, paths]) => {
      const shown = paths.slice(0, 5).join(", ");
      const rest = paths.length > 5 ? ` and ${paths.length - 5} more` : "";
      return `${message} at ${shown}${rest}`;
    })
    .join("; ");
}

function firstDependencyRequiringReplay(
  currentTree: string,
  manifests: readonly { base_tree: string; result_tree: string }[]
): number {
  // Scan from the end: with a no-op dependency in the chain (`base-test-setup` declared base == result)
  // two adjacent entries share an output, and resuming after the LAST of them is the honest reading of
  // "everything up to here is already present".
  for (let index = manifests.length - 1; index >= 0; index -= 1) {
    if (manifests[index]?.result_tree !== currentTree) continue;
    let chained = true;
    for (let link = 1; link <= index; link += 1) {
      if (manifests[link]?.base_tree !== manifests[link - 1]?.result_tree) {
        chained = false;
        break;
      }
    }
    return chained ? index + 1 : 0;
  }
  return 0;
}

function materializeWorkspacePatchDependencies(
  task: (typeof taskSpecs)[number],
  workspaceRoot: string,
  replayWorkspacePatches: boolean
): void {
  const expectedPreparation = workspacePatchPreparationTrees.get(task.attemptId);
  if (expectedPreparation !== undefined && readWorkspacePatchPreparation(task) !== expectedPreparation) {
    throw new Error(`artifact-contract failure: workspace preparation was modified ${task.attemptId}`);
  }
  const dependencies = [...task.dependencyArtifactDirs]
    .filter(
      (dependency) =>
        existsSync(path.join(dependency, "workspace.patch")) &&
        existsSync(path.join(dependency, "workspace-patch.json"))
    )
    .sort((left, right) => {
      const leftIndex = taskSpecs.findIndex((candidate) => candidate.attemptId === path.basename(left));
      const rightIndex = taskSpecs.findIndex((candidate) => candidate.attemptId === path.basename(right));
      return leftIndex - rightIndex || left.localeCompare(right);
    });
  // Read every manifest and patch BEFORE applying any of them. The decision below is about the chain as a whole --
  // whether a LATER dependency's output already describes this worktree -- and that cannot be made one
  // patch at a time. Reading first also keeps the artifact-contract failures ordered by dependency rather
  // than interleaved with partially applied patches.
  const captures = dependencies.map((dependency) => {
    const patchPath = resolveRegularArtifactFile(
      dependency,
      path.join(dependency, "workspace.patch"),
      "artifact-contract failure: workspace patch is not a regular file"
    );
    const manifestPath = resolveRegularArtifactFile(
      dependency,
      path.join(dependency, "workspace-patch.json"),
      "artifact-contract failure: workspace patch manifest is not a regular file"
    );
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    } catch (error) {
      throw new Error(`artifact-contract failure: workspace patch manifest is malformed ${manifestPath}`, {
        cause: error
      });
    }
    return {
      patch: readFileSync(patchPath, "utf8"),
      manifest: manifest as Parameters<typeof applyWorkspacePatch>[1]["manifest"]
    };
  });
  // Validate EVERY capture, including any the replay below decides to skip. All of these checks -- the
  // manifest schema, the object ids, the patch digest, the symlink/submodule rejection and the
  // sensitive-path rejection -- used to live inside `applyWorkspacePatch`, so skipping a patch meant
  // skipping its validation entirely, and the skip decision reads `result_tree` from a manifest nothing
  // had checked was even well formed.
  for (const capture of captures) validateWorkspacePatchCapture(workspaceRoot, capture);
  // On a RESUME the worktree lives on a durable volume and still holds the previous attempt's state, so it
  // can already sit at -- or past -- some of these dependencies' outputs. Skip the prefix the worktree
  // already holds (issue #312). On a fresh run at the pinned baseline nothing normally matches, though a
  // leading dependency that published a zero-file patch declares `base_tree === result_tree` and so can
  // match; skipping that one is a no-op, since `applyWorkspacePatch` already early-returns on it.
  const replayFrom =
    replayWorkspacePatches && captures.length > 0
      ? firstDependencyRequiringReplay(
          captureWorkspaceTree(workspaceRoot),
          captures.map((entry) => entry.manifest)
        )
      : 0;
  for (const capture of captures.slice(replayFrom)) {
    if (!replayWorkspacePatches) {
      // Post-agent preparation may see a dirty worktree. Replay only when the
      // exact dependency result tree is absent and the clean base tree is
      // still present; otherwise the dependency patch is already represented
      // by the dirty workspace and must not be applied over agent changes.
      const currentTree = captureWorkspaceTree(workspaceRoot);
      if (currentTree !== capture.manifest.base_tree) continue;
    }
    applyWorkspacePatch(workspaceRoot, capture);
  }
  if (!workspacePatchPreparationTrees.has(task.attemptId)) {
    const persistedPreparation = readWorkspacePatchPreparation(task);
    if (persistedPreparation === undefined && !replayWorkspacePatches) {
      throw new Error(`artifact-contract failure: workspace preparation is unavailable ${task.attemptId}`);
    }
    const preparationTree = persistedPreparation ?? captureWorkspaceTree(workspaceRoot);
    workspacePatchPreparationTrees.set(task.attemptId, preparationTree);
    if (persistedPreparation === undefined) writeWorkspacePatchPreparation(task, preparationTree);
  }
  const expectedBaseline = workspacePatchBaselineTrees.get(task.attemptId);
  if (expectedBaseline !== undefined && readWorkspacePatchBaseline(task) !== expectedBaseline) {
    throw new Error(`artifact-contract failure: workspace patch baseline was modified ${task.attemptId}`);
  }
  if (taskPublishesWorkspacePatch(task) && !workspacePatchBaselineTrees.has(task.attemptId)) {
    const persistedBaseline = readWorkspacePatchBaseline(task);
    if (persistedBaseline === undefined && !replayWorkspacePatches) {
      throw new Error(`artifact-contract failure: workspace patch baseline is unavailable ${task.attemptId}`);
    }
    const baselineTree = persistedBaseline ?? captureWorkspaceTree(workspaceRoot);
    workspacePatchBaselineTrees.set(task.attemptId, baselineTree);
    if (persistedBaseline === undefined) writeWorkspacePatchBaseline(task, baselineTree);
  }
}

function workspacePatchBaselinePath(task: (typeof taskSpecs)[number]): string {
  const artifactRoot = realpathSync(task.metadata.artifacts.dir);
  const candidate = path.resolve(artifactRoot, WORKSPACE_PATCH_BASELINE_FILE);
  if (!isStrictlyInsideDirectory(artifactRoot, candidate)) {
    throw new Error(`artifact-contract failure: unsafe workspace patch baseline ${task.attemptId}`);
  }
  return candidate;
}

function writeWorkspacePatchBaseline(task: (typeof taskSpecs)[number], baselineTree: string): void {
  if (!/^[0-9a-f]{40,64}$/u.test(baselineTree)) {
    throw new Error(`artifact-contract failure: invalid workspace patch baseline ${task.attemptId}`);
  }
  const target = workspacePatchBaselinePath(task);
  const contents = `${JSON.stringify({
    schema_version: "ultrafuzz.workspace-patch-baseline.v1",
    attempt_id: task.attemptId,
    baseline_tree: baselineTree
  })}\n`;
  if (existsSync(target)) {
    if (readFileSync(target, "utf8") !== contents) {
      throw new Error(`artifact-contract failure: workspace patch baseline was modified ${task.attemptId}`);
    }
    return;
  }
  writeFileDurable(target, contents);
}

function readWorkspacePatchBaseline(task: (typeof taskSpecs)[number]): string | undefined {
  const target = workspacePatchBaselinePath(task);
  if (!existsSync(target)) return undefined;
  const resolved = resolveRegularArtifactFile(
    realpathSync(task.metadata.artifacts.dir),
    target,
    "artifact-contract failure: workspace patch baseline is not a regular file"
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`artifact-contract failure: workspace patch baseline is malformed ${task.attemptId}`, {
      cause: error
    });
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    (parsed as Record<string, unknown>).schema_version !== "ultrafuzz.workspace-patch-baseline.v1" ||
    (parsed as Record<string, unknown>).attempt_id !== task.attemptId ||
    typeof (parsed as Record<string, unknown>).baseline_tree !== "string" ||
    !/^[0-9a-f]{40,64}$/u.test((parsed as Record<string, unknown>).baseline_tree as string)
  ) {
    throw new Error(`artifact-contract failure: workspace patch baseline is invalid ${task.attemptId}`);
  }
  return (parsed as Record<string, unknown>).baseline_tree as string;
}

function workspacePatchPreparationPath(task: (typeof taskSpecs)[number]): string {
  const artifactRoot = realpathSync(task.metadata.artifacts.dir);
  const candidate = path.resolve(artifactRoot, WORKSPACE_PATCH_PREPARATION_FILE);
  if (!isStrictlyInsideDirectory(artifactRoot, candidate)) {
    throw new Error(`artifact-contract failure: unsafe workspace preparation ${task.attemptId}`);
  }
  return candidate;
}

function writeWorkspacePatchPreparation(task: (typeof taskSpecs)[number], preparationTree: string): void {
  if (!/^[0-9a-f]{40,64}$/u.test(preparationTree)) {
    throw new Error(`artifact-contract failure: invalid workspace preparation ${task.attemptId}`);
  }
  const target = workspacePatchPreparationPath(task);
  const contents = `${JSON.stringify({
    schema_version: "ultrafuzz.workspace-patch-preparation.v1",
    attempt_id: task.attemptId,
    preparation_tree: preparationTree
  })}\n`;
  if (existsSync(target)) {
    if (readFileSync(target, "utf8") !== contents) {
      throw new Error(`artifact-contract failure: workspace preparation was modified ${task.attemptId}`);
    }
    return;
  }
  writeFileDurable(target, contents);
}

function readWorkspacePatchPreparation(task: (typeof taskSpecs)[number]): string | undefined {
  const target = workspacePatchPreparationPath(task);
  if (!existsSync(target)) return undefined;
  const resolved = resolveRegularArtifactFile(
    realpathSync(task.metadata.artifacts.dir),
    target,
    "artifact-contract failure: workspace preparation is not a regular file"
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`artifact-contract failure: workspace preparation is malformed ${task.attemptId}`, {
      cause: error
    });
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    (parsed as Record<string, unknown>).schema_version !== "ultrafuzz.workspace-patch-preparation.v1" ||
    (parsed as Record<string, unknown>).attempt_id !== task.attemptId ||
    typeof (parsed as Record<string, unknown>).preparation_tree !== "string" ||
    !/^[0-9a-f]{40,64}$/u.test((parsed as Record<string, unknown>).preparation_tree as string)
  ) {
    throw new Error(`artifact-contract failure: workspace preparation is invalid ${task.attemptId}`);
  }
  return (parsed as Record<string, unknown>).preparation_tree as string;
}

function restoreWorkspacePatchPreparation(task: (typeof taskSpecs)[number], workspaceRoot: string): void {
  const preparationTree = workspacePatchPreparationTrees.get(task.attemptId) ?? readWorkspacePatchPreparation(task);
  if (preparationTree === undefined) {
    throw new Error(`artifact-contract failure: workspace preparation is unavailable ${task.attemptId}`);
  }
  workspacePatchPreparationTrees.set(task.attemptId, preparationTree);
  execFileSync("git", ["read-tree", "--reset", "-u", preparationTree], {
    cwd: workspaceRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  removeStaleWorkspaceFiles(workspaceRoot, preparationTree);
}

function removeStaleWorkspaceFiles(workspaceRoot: string, preparationTree: string): void {
  const expected = new Set(
    execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", preparationTree], {
      cwd: workspaceRoot,
      encoding: "utf8"
    })
      .split("\0")
      .filter(Boolean)
  );
  const candidates = new Set<string>();
  for (const args of [
    ["ls-files", "--others", "--exclude-standard", "-z"],
    ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]
  ]) {
    for (const entry of execFileSync("git", args, { cwd: workspaceRoot, encoding: "utf8" }).split("\0")) {
      if (entry) candidates.add(entry);
    }
  }
  for (const relativePath of candidates) {
    if (expected.has(relativePath) || isWorkspaceRuntimePath(relativePath)) continue;
    const candidate = path.resolve(workspaceRoot, ...relativePath.split("/"));
    if (!isStrictlyInsideDirectory(workspaceRoot, candidate) || hasSymlinkComponent(workspaceRoot, candidate)) {
      throw new Error(`artifact-contract failure: unsafe stale workspace path ${relativePath}`);
    }
    rmSync(candidate, { recursive: true, force: true });
  }
}

function isWorkspaceRuntimePath(relativePath: string): boolean {
  const root = relativePath.split("/")[0];
  return [".ultrafuzz", ".smithers", "node_modules", "artifacts"].includes(root);
}

function hasSymlinkComponent(root: string, candidate: string): boolean {
  let current = path.resolve(root);
  const relative = path.relative(current, candidate);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch (error) {
      if (isMissingPathError(error)) return false;
      throw error;
    }
  }
  return false;
}

function materializeWorkspacePatch(task: (typeof taskSpecs)[number]): void {
  if (!taskPublishesWorkspacePatch(task)) return;
  const baselineTree = workspacePatchBaselineTrees.get(task.attemptId);
  if (baselineTree === undefined) {
    throw new Error(`artifact-contract failure: workspace patch baseline is unavailable ${task.attemptId}`);
  }
  const workspaceRoot = realpathSync(task.workspacePath);
  const captured = captureWorkspacePatch(workspaceRoot, baselineTree);
  const manifest = `${JSON.stringify(captured.manifest, null, 2)}\n`;
  for (const artifactRoot of taskArtifactRoots(task, realpathSync(task.metadata.artifacts.dir))) {
    // Classify the surviving pair BEFORE writing either half of the new one. Writing the patch first
    // would leave the manifest describing different bytes, and the pair could no longer be recognised
    // as one this node published.
    const superseded = holdsSupersededWorkspacePatchPair(artifactRoot, workspaceRoot, baselineTree);
    writeWorkspacePatchArtifact(artifactRoot, "workspace.patch", captured.patch, superseded);
    writeWorkspacePatchArtifact(artifactRoot, "workspace-patch.json", manifest, superseded);
  }
}

/**
 * Does this artifact root hold a workspace patch pair THIS node published in an earlier recovery
 * generation (#357)?
 *
 * A re-executed node's fresh capture legitimately differs from the one still on the durable volume --
 * its agent ran again -- so `writeWorkspacePatchArtifact` read the survivor as tampering and killed the
 * run. Nothing clears it across that boundary: `resetTaskArtifactsForRetry` only fires for
 * `attempt > 1` within ONE process, and a new generation starts a new process at attempt 1. That holds
 * whatever `max_attempts` a topology sets, and the pair is not in the set reset preserves anyway.
 *
 * Content equality cannot be the discriminator -- it is exactly what conflates "my own superseded
 * output" with "someone edited this". Two things together answer it. `validateWorkspacePatchCapture`
 * establishes that the pair is a well-formed capture whose manifest digest matches its patch, and the
 * `base_tree` identity establishes it was taken from THIS node's baseline rather than copied from a
 * dependency's artifact dir, which agents can read. Anything else -- a lone patch, a mismatched digest,
 * an unreadable or foreign manifest, another node's capture -- is left for the caller to reject exactly
 * as before.
 *
 * This only decides; it does not delete. `writeFileDurable` renames over the target, so the caller
 * replaces the pair atomically and the durable artifact is never momentarily absent. That matters
 * because `materializeWorkspacePatchDependencies` SILENTLY skips a dependency missing both files, so an
 * absence window is a silent hole rather than an error.
 *
 * `patch_sha256` is a digest of a file the agent can read, and the artifact root is reachable from the
 * model-controlled workspace, so a forged pair is cheap to produce. This is a self-consistency
 * heuristic and a tripwire, NOT provenance. It stays acceptable only because the runtime's own capture
 * is written over the survivor either way, so forging one gains an agent nothing but silence.
 *
 * Real provenance is available and deliberately not used here: `invariantSuiteProtectedBaselinePath`
 * keeps a digest-checked copy outside the agent-writable tree, and recording each published patch
 * digest the same way would keep tamper detection fully intact. That is more durable machinery than
 * this bug warrants, so it is named rather than built -- but anyone reusing this helper somewhere that
 * does NOT immediately overwrite the survivor needs that mechanism instead of this one.
 */
function holdsSupersededWorkspacePatchPair(artifactRoot: string, workspaceRoot: string, baselineTree: string): boolean {
  const patchPath = path.resolve(artifactRoot, "workspace.patch");
  const manifestPath = path.resolve(artifactRoot, "workspace-patch.json");
  // Both halves are required: a lone patch keeps the caller's rejection, which is what stops an agent
  // laundering one by deleting the manifest beside it.
  if (!existsSync(patchPath) || !existsSync(manifestPath)) return false;
  // Name the file that failed rather than "artifact", so a symlinked or non-regular half is diagnosable
  // from the message alone.
  const patch = readFileSync(
    resolveRegularArtifactFile(
      artifactRoot,
      patchPath,
      "artifact-contract failure: workspace patch artifact is unsafe workspace.patch"
    ),
    "utf8"
  );
  const manifestText = readFileSync(
    resolveRegularArtifactFile(
      artifactRoot,
      manifestPath,
      "artifact-contract failure: workspace patch artifact is unsafe workspace-patch.json"
    ),
    "utf8"
  );
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText) as unknown;
  } catch {
    return false;
  }
  if (manifest === null || (manifest as Record<string, unknown>).base_tree !== baselineTree) return false;
  try {
    validateWorkspacePatchCapture(workspaceRoot, { patch, manifest } as Parameters<
      typeof validateWorkspacePatchCapture
    >[1]);
  } catch {
    return false;
  }
  return true;
}

function writeWorkspacePatchArtifact(
  root: string,
  relativePath: string,
  contents: string,
  replaceSuperseded = false
): void {
  const target = path.resolve(root, relativePath);
  if (!isStrictlyInsideDirectory(root, target)) {
    throw new Error(`artifact-contract failure: unsafe workspace patch artifact path ${relativePath}`);
  }
  mkdirSync(path.dirname(target), { recursive: true });
  if (existsSync(target)) {
    const existing = resolveRegularArtifactFile(
      root,
      target,
      "artifact-contract failure: workspace patch artifact is unsafe"
    );
    const existingContents = readFileSync(existing, "utf8");
    if (existingContents !== "" && existingContents !== "\n") {
      if (existingContents === contents) return;
      // These paths are runtime-owned. Replace an empty placeholder, or a pair this node published in
      // an earlier generation; reject any other non-empty agent-authored or tampered patch.
      if (!replaceSuperseded) {
        throw new Error(`artifact-contract failure: workspace patch artifact was modified ${relativePath}`);
      }
    }
  }
  writeFileDurable(target, contents);
}

function captureInvariantSuiteBaseline(task: (typeof taskSpecs)[number], workspaceRoot: string): void {
  if (!invariantSuiteNodeIds.has(task.metadata.node.logicalNodeId)) return;
  const artifactRoot = realpathSync(task.metadata.artifacts.dir);
  const baselinePath = path.join(artifactRoot, INVARIANT_SUITE_BASELINE_FILE);
  const protectedBaselinePath = invariantSuiteProtectedBaselinePath(task);
  if (!isStrictlyInsideDirectory(artifactRoot, baselinePath)) {
    throw new Error(`artifact-contract failure: unsafe invariant suite baseline ${task.attemptId}`);
  }
  if (existsSync(protectedBaselinePath)) {
    const protectedRoot = realpathSync(path.dirname(protectedBaselinePath));
    const resolvedProtected = resolveRegularArtifactFile(
      protectedRoot,
      protectedBaselinePath,
      "artifact-contract failure: protected invariant suite baseline is not a regular file"
    );
    const contents = readFileSync(resolvedProtected, "utf8");
    const digest = createHash("sha256").update(contents).digest("hex");
    const snapshot = invariantSuiteBaselineSnapshots.get(artifactRoot);
    if (snapshot !== undefined && snapshot.sha256 !== digest) {
      throw new Error("artifact-contract failure: protected invariant suite baseline was modified");
    }
    writeFileDurable(baselinePath, contents);
    invariantSuiteProtectedBaselineSnapshots.set(protectedBaselinePath, { contents, sha256: digest });
    invariantSuiteBaselineSnapshots.set(artifactRoot, { contents, sha256: digest });
    return;
  }
  if (existsSync(baselinePath)) {
    const resolvedBaseline = resolveRegularArtifactFile(
      artifactRoot,
      baselinePath,
      "artifact-contract failure: invariant suite baseline is not a regular file"
    );
    const contents = readFileSync(resolvedBaseline, "utf8");
    const snapshot = invariantSuiteBaselineSnapshots.get(artifactRoot);
    const digest = createHash("sha256").update(contents).digest("hex");
    if (snapshot !== undefined && snapshot.sha256 !== digest) {
      throw new Error("artifact-contract failure: invariant suite baseline was modified by the agent");
    }
    invariantSuiteBaselineSnapshots.set(artifactRoot, { contents, sha256: digest });
    invariantSuiteProtectedBaselineSnapshots.set(protectedBaselinePath, { contents, sha256: digest });
    writeFileDurable(protectedBaselinePath, contents);
    return;
  }
  const files = new Map<string, { path: string; sha256: string; size: number }>();
  try {
    for (const value of invariantSuiteGitPaths(workspaceRoot, [
      "ls-files",
      "--cached",
      "--others",
      "--",
      "test",
      "tests"
    ]).split(/\r?\n/u)) {
      if (value.length === 0 || (!value.startsWith("test/") && !value.startsWith("tests/"))) continue;
      const relativePath = assertSafeInvariantSuiteTestPath(value);
      const sourcePath = path.resolve(workspaceRoot, relativePath);
      const source = resolveRegularArtifactFile(
        workspaceRoot,
        sourcePath,
        `artifact-contract failure: invariant suite baseline source is not regular ${relativePath}`
      );
      const sourceStat = statSync(source);
      if (sourceStat.size === 0) continue;
      if (sourceStat.nlink !== 1) {
        throw new Error(`artifact-contract failure: invariant suite baseline source is hard-linked ${relativePath}`);
      }
      assertInvariantSuiteSourceSize(relativePath, sourceStat.size);
      const sourceBytes = readFileSync(source);
      if (sourceBytes.length !== sourceStat.size) {
        throw new Error(`artifact-contract failure: invariant suite baseline source changed ${relativePath}`);
      }
      files.set(relativePath, {
        path: relativePath,
        sha256: createHash("sha256").update(sourceBytes).digest("hex"),
        size: sourceStat.size
      });
    }
    assertInvariantSuiteSourceBudget(
      files.size,
      [...files.values()].reduce((total, entry) => total + entry.size, 0)
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("artifact-contract failure:")) throw error;
    throw new Error("artifact-contract failure: unable to capture invariant suite baseline", { cause: error });
  }
  const contents = `${JSON.stringify(
    { schema_version: "ultrafuzz.invariant-suite-baseline.v1", files: [...files.values()] },
    null,
    2
  )}\n`;
  writeFileDurable(baselinePath, contents);
  writeFileDurable(protectedBaselinePath, contents);
  invariantSuiteProtectedBaselineSnapshots.set(protectedBaselinePath, {
    contents,
    sha256: createHash("sha256").update(contents).digest("hex")
  });
  invariantSuiteBaselineSnapshots.set(artifactRoot, {
    contents,
    sha256: createHash("sha256").update(contents).digest("hex")
  });
}

function invariantSuiteProtectedBaselinePath(task: (typeof taskSpecs)[number]): string {
  const projectRoot = realpathSync(process.cwd());
  const runRoot = path.resolve(process.cwd(), task.runRoot);
  if (runRoot !== projectRoot && !isStrictlyInsideDirectory(projectRoot, runRoot)) {
    throw new Error(`artifact-contract failure: unsafe invariant suite baseline root ${task.attemptId}`);
  }
  const protectedRoot = path.join(runRoot, "invariant-suite-baselines");
  mkdirSync(protectedRoot, { recursive: true, mode: 0o700 });
  const resolvedRoot = realpathSync(protectedRoot);
  if (resolvedRoot !== protectedRoot || !isStrictlyInsideDirectory(runRoot, resolvedRoot)) {
    throw new Error(`artifact-contract failure: unsafe invariant suite baseline root ${task.attemptId}`);
  }
  return path.join(resolvedRoot, `${task.attemptId}.json`);
}

function invariantWorkspaceSourcePaths(workspaceRoot: string): string[] {
  const values = invariantSuiteGitPaths(workspaceRoot, [
    "ls-files",
    "--cached",
    "--others",
    "--",
    "src",
    "contracts",
    "test",
    "tests"
  ]).split(/\r?\n/u);
  return values.filter(
    (value) =>
      value.startsWith("src/") ||
      value.startsWith("contracts/") ||
      value.startsWith("test/") ||
      value.startsWith("tests/")
  );
}

function invariantSuiteWorkspaceSnapshotRoot(task: (typeof taskSpecs)[number]): string {
  return invariantSuiteAttemptStateRoot(task, INVARIANT_SUITE_WORKSPACE_SNAPSHOT_DIR);
}

/**
 * Anchor a per-attempt directory of durable invariant-suite run state. Run
 * state has to live under the run root rather than under a task artifact
 * directory, because artifact roots are emptied on every retry and are
 * reachable from the model-controlled workspace.
 */
function invariantSuiteAttemptStateRoot(task: (typeof taskSpecs)[number], directoryName: string): string {
  const projectRoot = realpathSync(process.cwd());
  const runRootCandidate = path.resolve(process.cwd(), task.runRoot);
  if (runRootCandidate !== projectRoot && !isStrictlyInsideDirectory(projectRoot, runRootCandidate)) {
    throw new Error(`artifact-contract failure: unsafe invariant workspace snapshot root ${task.attemptId}`);
  }
  let runRootStat: ReturnType<typeof lstatSync>;
  try {
    runRootStat = lstatSync(runRootCandidate);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    safeInvariantSuiteDirectory(projectRoot, path.dirname(runRootCandidate));
    mkdirSync(runRootCandidate, { recursive: false, mode: 0o700 });
    runRootStat = lstatSync(runRootCandidate);
  }
  if (!runRootStat.isDirectory() || runRootStat.isSymbolicLink()) {
    throw new Error(`artifact-contract failure: unsafe invariant workspace snapshot root ${task.attemptId}`);
  }
  const runRoot = realpathSync(runRootCandidate);
  if (runRoot !== runRootCandidate || (runRoot !== projectRoot && !isStrictlyInsideDirectory(projectRoot, runRoot))) {
    throw new Error(`artifact-contract failure: unsafe invariant workspace snapshot root ${task.attemptId}`);
  }
  const rootCandidate = path.join(runRoot, directoryName);
  mkdirSync(rootCandidate, { recursive: true, mode: 0o700 });
  const root = realpathSync(rootCandidate);
  if (root !== rootCandidate || !isStrictlyInsideDirectory(runRoot, root)) {
    throw new Error(`artifact-contract failure: unsafe invariant workspace snapshot root ${task.attemptId}`);
  }
  const attemptCandidate = path.join(root, task.attemptId);
  mkdirSync(attemptCandidate, { recursive: true, mode: 0o700 });
  const attemptRoot = realpathSync(attemptCandidate);
  if (attemptRoot !== attemptCandidate || !isStrictlyInsideDirectory(root, attemptRoot)) {
    throw new Error(`artifact-contract failure: unsafe invariant workspace snapshot root ${task.attemptId}`);
  }
  return attemptRoot;
}

function readStableWorkspaceSnapshotFile(
  root: string,
  filePath: string,
  relativePath: string,
  expectedSize?: number,
  expectedSha256?: string
): Buffer {
  const resolved = resolveRegularArtifactFile(
    root,
    filePath,
    `artifact-contract failure: invariant workspace snapshot file is not regular ${relativePath}`
  );
  const beforeLstat = lstatSync(resolved);
  if (beforeLstat.isSymbolicLink() || !beforeLstat.isFile()) {
    throw new Error(`artifact-contract failure: invariant workspace snapshot file changed ${relativePath}`);
  }
  const before = statSync(resolved);
  if (before.nlink !== 1 || (expectedSize !== undefined && before.size !== expectedSize)) {
    throw new Error(`artifact-contract failure: invariant workspace snapshot file changed ${relativePath}`);
  }
  const bytes = readFileSync(resolved);
  const afterLstat = lstatSync(resolved);
  const after = statSync(resolved);
  if (
    afterLstat.isSymbolicLink() ||
    !afterLstat.isFile() ||
    after.nlink !== 1 ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    bytes.length !== before.size ||
    (expectedSha256 !== undefined && createHash("sha256").update(bytes).digest("hex") !== expectedSha256)
  ) {
    throw new Error(`artifact-contract failure: invariant workspace snapshot file changed ${relativePath}`);
  }
  return bytes;
}

function loadInvariantSuiteWorkspaceSnapshot(task: (typeof taskSpecs)[number]): Map<string, Buffer> | undefined {
  const snapshotRoot = invariantSuiteWorkspaceSnapshotRoot(task);
  const manifestPath = path.join(snapshotRoot, INVARIANT_SUITE_WORKSPACE_SNAPSHOT_FILE);
  if (!existsSync(manifestPath)) return undefined;
  const manifestBytes = readStableWorkspaceSnapshotFile(snapshotRoot, manifestPath, "snapshot manifest");
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestBytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error("artifact-contract failure: invariant workspace snapshot manifest is malformed", { cause: error });
  }
  if (
    !isPlainRecord(parsed) ||
    parsed.schema_version !== "ultrafuzz.invariant-workspace-snapshot.v1" ||
    !Array.isArray(parsed.files)
  ) {
    throw new Error("artifact-contract failure: invariant workspace snapshot manifest is malformed");
  }
  if (parsed.files.length > MAX_INVARIANT_SUITE_WORKSPACE_FILES) {
    throw new Error("artifact-contract failure: invariant workspace snapshot exceeds its file budget");
  }
  const filesRoot = path.join(snapshotRoot, INVARIANT_SUITE_WORKSPACE_FILES_DIR);
  const snapshot = new Map<string, Buffer>();
  let totalBytes = 0;
  for (const entry of parsed.files) {
    if (
      !isPlainRecord(entry) ||
      typeof entry.path !== "string" ||
      typeof entry.size !== "number" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      typeof entry.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(entry.sha256)
    ) {
      throw new Error("artifact-contract failure: invariant workspace snapshot entry is malformed");
    }
    const relativePath = assertSafeInvariantSuitePath(entry.path);
    if (snapshot.has(relativePath)) {
      throw new Error(`artifact-contract failure: duplicate invariant workspace snapshot path ${relativePath}`);
    }
    if (entry.size > MAX_INVARIANT_SUITE_WORKSPACE_SOURCE_BYTES) {
      throw new Error(`artifact-contract failure: invariant workspace snapshot file is too large ${relativePath}`);
    }
    totalBytes += entry.size;
    if (totalBytes > MAX_INVARIANT_SUITE_WORKSPACE_TOTAL_BYTES) {
      throw new Error("artifact-contract failure: invariant workspace snapshot exceeds its byte budget");
    }
    const sidecarPath = path.resolve(filesRoot, relativePath);
    if (!isStrictlyInsideDirectory(filesRoot, sidecarPath)) {
      throw new Error(`artifact-contract failure: unsafe invariant workspace snapshot path ${relativePath}`);
    }
    snapshot.set(
      relativePath,
      readStableWorkspaceSnapshotFile(filesRoot, sidecarPath, relativePath, entry.size, entry.sha256)
    );
  }
  invariantSuiteWorkspaceSnapshots.set(task.attemptId, snapshot);
  return snapshot;
}

function captureInvariantSuiteWorkspaceSnapshot(task: (typeof taskSpecs)[number], workspaceRoot: string): void {
  if (invariantSuiteWorkspaceSnapshots.has(task.attemptId)) return;
  if (loadInvariantSuiteWorkspaceSnapshot(task) !== undefined) return;
  const snapshot = new Map<string, Buffer>();
  let totalBytes = 0;
  for (const value of invariantWorkspaceSourcePaths(workspaceRoot)) {
    const relativePath = assertSafeInvariantSuitePath(value);
    const source = resolveRegularArtifactFile(
      workspaceRoot,
      path.resolve(workspaceRoot, relativePath),
      `artifact-contract failure: invariant workspace source is not regular ${relativePath}`
    );
    const stat = statSync(source);
    if (stat.nlink !== 1)
      throw new Error(`artifact-contract failure: invariant workspace source is hard-linked ${relativePath}`);
    if (stat.size > MAX_INVARIANT_SUITE_WORKSPACE_SOURCE_BYTES) {
      throw new Error(`artifact-contract failure: invariant workspace source is too large ${relativePath}`);
    }
    const bytes = readFileSync(source);
    const after = statSync(source);
    if (
      bytes.length !== stat.size ||
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.nlink !== 1
    ) {
      throw new Error(`artifact-contract failure: invariant workspace source changed ${relativePath}`);
    }
    totalBytes += bytes.length;
    if (
      snapshot.size >= MAX_INVARIANT_SUITE_WORKSPACE_FILES ||
      totalBytes > MAX_INVARIANT_SUITE_WORKSPACE_TOTAL_BYTES
    ) {
      throw new Error("artifact-contract failure: invariant workspace snapshot exceeds its budget");
    }
    snapshot.set(relativePath, bytes);
  }
  const snapshotRoot = invariantSuiteWorkspaceSnapshotRoot(task);
  const filesRoot = path.join(snapshotRoot, INVARIANT_SUITE_WORKSPACE_FILES_DIR);
  mkdirSync(filesRoot, { recursive: true, mode: 0o700 });
  if (realpathSync(filesRoot) !== filesRoot || !isStrictlyInsideDirectory(snapshotRoot, filesRoot)) {
    throw new Error("artifact-contract failure: invariant workspace snapshot files root is unsafe");
  }
  const manifestEntries: Array<{ path: string; size: number; sha256: string }> = [];
  for (const [relativePath, bytes] of snapshot) {
    const sidecarPath = path.resolve(filesRoot, relativePath);
    if (!isStrictlyInsideDirectory(filesRoot, sidecarPath)) {
      throw new Error(`artifact-contract failure: unsafe invariant workspace snapshot path ${relativePath}`);
    }
    const parent = safeInvariantSuiteDirectory(filesRoot, path.dirname(sidecarPath));
    writeFileDurable(path.join(parent, path.basename(sidecarPath)), bytes);
    manifestEntries.push({
      path: relativePath,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  }
  writeFileDurable(
    path.join(snapshotRoot, INVARIANT_SUITE_WORKSPACE_SNAPSHOT_FILE),
    `${JSON.stringify({ schema_version: "ultrafuzz.invariant-workspace-snapshot.v1", files: manifestEntries }, null, 2)}\n`
  );
  invariantSuiteWorkspaceSnapshots.set(task.attemptId, snapshot);
}

function restoreInvariantSuiteWorkspaceSnapshot(
  task: (typeof taskSpecs)[number],
  options: { preserveCurrentSources?: boolean } = {}
): void {
  const preserveCurrentSources = options.preserveCurrentSources === true;
  const snapshot = invariantSuiteWorkspaceSnapshots.get(task.attemptId) ?? loadInvariantSuiteWorkspaceSnapshot(task);
  if (snapshot === undefined) return;
  const projectRoot = realpathSync(process.cwd());
  const workspaceCandidate = path.resolve(task.workspacePath);
  const runRootCandidate = path.resolve(process.cwd(), task.runRoot);
  if (
    (workspaceCandidate !== projectRoot && !isStrictlyInsideDirectory(projectRoot, workspaceCandidate)) ||
    (runRootCandidate !== projectRoot && !isStrictlyInsideDirectory(projectRoot, runRootCandidate)) ||
    !isStrictlyInsideDirectory(runRootCandidate, workspaceCandidate)
  ) {
    throw new Error(`artifact-contract failure: invariant workspace root is outside its run root ${task.attemptId}`);
  }
  const runRootStat = lstatSync(runRootCandidate);
  if (
    !runRootStat.isDirectory() ||
    runRootStat.isSymbolicLink() ||
    realpathSync(runRootCandidate) !== runRootCandidate
  ) {
    throw new Error(`artifact-contract failure: invariant workspace run root is unsafe ${task.attemptId}`);
  }
  const runRoot = runRootCandidate;
  if (!isStrictlyInsideDirectory(runRoot, workspaceCandidate)) {
    throw new Error(`artifact-contract failure: invariant workspace root is outside its run root ${task.attemptId}`);
  }
  const workspaceStat = lstatSync(workspaceCandidate);
  if (
    !workspaceStat.isDirectory() ||
    workspaceStat.isSymbolicLink() ||
    realpathSync(workspaceCandidate) !== workspaceCandidate
  ) {
    throw new Error(`artifact-contract failure: invariant workspace root is unsafe ${task.attemptId}`);
  }
  const workspaceRoot = workspaceCandidate;
  for (const relativePath of invariantWorkspaceSourcePaths(workspaceRoot)) {
    const safePath = assertSafeInvariantSuitePath(relativePath);
    if (snapshot.has(safePath) || preserveCurrentSources) continue;
    const candidate = path.resolve(workspaceRoot, safePath);
    const parent = safeInvariantSuiteDirectory(workspaceRoot, path.dirname(candidate));
    const entry = path.join(parent, path.basename(candidate));
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(entry);
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw new Error(`artifact-contract failure: invariant workspace source is unsafe ${safePath}`);
    }
    rmSync(entry, { force: true });
  }
  // The post-agent pass must preserve modified and deleted baseline sources as
  // well as newly added files; materializeWorkspacePatch captures the complete
  // resulting worktree immediately after preparation.
  if (preserveCurrentSources) return;
  for (const [relativePath, bytes] of snapshot) {
    const destination = path.resolve(workspaceRoot, relativePath);
    const parent = safeInvariantSuiteDirectory(workspaceRoot, path.dirname(destination));
    const anchored = path.join(parent, path.basename(destination));
    try {
      const stat = lstatSync(anchored);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        throw new Error(`artifact-contract failure: invariant workspace source is unsafe ${relativePath}`);
      }
      if (stat.isDirectory()) rmSync(anchored, { recursive: true, force: true });
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    writeFileDurable(anchored, bytes);
    readStableWorkspaceSnapshotFile(
      workspaceRoot,
      anchored,
      relativePath,
      bytes.length,
      createHash("sha256").update(bytes).digest("hex")
    );
  }
}

function assertTaskInputs(task: (typeof taskSpecs)[number], workspaceRoot: string): void {
  const schemaRoot = path.join(workspaceRoot, ".ultrafuzz", "schemas");
  for (const schema of ["property-lens.schema.json", "properties.schema.json"]) {
    assertRegularFileInside(schemaRoot, path.join(schemaRoot, schema), `prompt schema ${schema}`);
  }
  if (task.promptPath !== undefined) {
    assertRegularFileInside(path.dirname(task.promptPath), task.promptPath, "rendered task prompt");
  }
  for (const dependency of task.dependencyArtifactDirs) {
    const dependencyTask = taskSpecs.find((candidate) => candidate.attemptId === path.basename(dependency));
    // #677: `dynamic-strategy-generator` and `dedupe-findings` depend on EVERY goal node, so before
    // this a single killed goal search took both fan-ins down with it and produced 97 downstream
    // `artifact dependency has not passed verification` events -- the largest single failure class in
    // the 18-hour run. That cascade is the artifact-contract system working as designed for every
    // other dependency class, and it stays exactly as it was for them; a goal search is the one
    // dependency semantically allowed to arrive with nothing, so an unverified goal lane is treated
    // here as MISSING rather than as a contract breach. Read it that way and nothing else: the lane
    // is skipped, not defaulted, so no unverified model bytes reach a consumer (the same exclusion is
    // repeated in `dependencyFindingSources` and `materializeMissingDedupeArtifact`, which read
    // dependency findings directly), and the run-root goal-search census records which lanes were
    // skipped so an empty report can never read as full coverage.
    const unverifiedGoalSearch = dependencyTask !== undefined && goalSearchDependencyIsUnverified(task, dependencyTask);
    if (unverifiedGoalSearch && !existsSync(dependency)) {
      continue;
    }
    let stat;
    try {
      stat = lstatSync(dependency);
    } catch (error) {
      throw new Error(`artifact handoff directory is unavailable: ${dependency}`, { cause: error });
    }
    let resolvedDependency: string;
    try {
      resolvedDependency = realpathSync(dependency);
    } catch (error) {
      throw new Error(`artifact handoff directory is unavailable: ${dependency}`, { cause: error });
    }
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      resolvedDependency !== dependency ||
      !isStrictlyInsideDirectory(realpathSync(task.runRoot), resolvedDependency)
    ) {
      throw new Error(`artifact handoff directory is unsafe: ${dependency}`);
    }
    // Pinned/reference nodes are materialized without an agent verifier and
    // therefore have no success marker; only agentic task dependencies need
    // this explicit verifier boundary.
    if (dependencyTask !== undefined) {
      if (unverifiedGoalSearch) {
        continue;
      }
      assertVerifiedDependency(task, dependency);
    }
  }
}

/**
 * Is this task a goal SEARCH, i.e. a node of the `goals` topology group?
 *
 * The discriminator is `metadata.node.group`, which `buildSmithersTask` already copies from the
 * topology node (`...(input.node.group ? { group: input.node.group } : {})`) and which the
 * controller-to-worker handoff DTO forwards verbatim, so both `threat-goals`/`class-goals` dynamic
 * expansions -- which inherit their template node's metadata -- and the static `goal-roaming` node
 * carry it without any new plumbing. Matching on the group rather than on the three logical IDs is
 * deliberate: a fourth goal lane added to the topology inherits this behavior, and a node moved out
 * of the group loses it, which is the direction an operator would expect a group to work.
 */
function isGoalSearchTask(task: (typeof taskSpecs)[number]): boolean {
  return task.metadata.node.group === GOAL_SEARCH_TOPOLOGY_GROUP;
}

/**
 * Did this goal search fail to publish a verified handoff?
 *
 * True means "there is no runtime-owned success marker for this goal lane", which is exactly the
 * state a killed, timed-out, or contract-failing goal node leaves behind now that goal lanes carry
 * `continueOnFail`. It is deliberately narrow in three ways:
 *
 *   1. It answers only for goal-group tasks. Every other dependency returns false and therefore
 *      still goes through the unchanged `assertVerifiedDependency`, which fails closed.
 *   2. It reads only the marker's PRESENCE. Whether a present marker is internally consistent, still
 *      matches its published digests, and still validates against its contract remains
 *      `assertVerifiedDependency`'s decision, unchanged and unbypassed for goal lanes too.
 *   3. An unsafe marker root still throws, because `artifactVerificationMarkerLocation` owns that
 *      check and a hostile symlink over the verification directory must never be reinterpreted as a
 *      goal that simply found nothing.
 */
function goalSearchDependencyIsUnverified(
  task: (typeof taskSpecs)[number],
  dependencyTask: (typeof taskSpecs)[number]
): boolean {
  if (!isGoalSearchTask(dependencyTask)) {
    return false;
  }
  const location = artifactVerificationMarkerLocation(task.runRoot, dependencyTask.attemptId, false);
  if (location === undefined) {
    return true;
  }
  try {
    return !lstatSync(location.path).isFile();
  } catch (error) {
    if (isMissingPathError(error)) {
      return true;
    }
    throw error;
  }
}

function assertVerifiedDependency(task: (typeof taskSpecs)[number], dependency: string): void {
  try {
    const dependencyAttemptId = path.basename(dependency);
    const dependencyTask = taskSpecs.find((candidate) => candidate.attemptId === dependencyAttemptId);
    if (dependencyTask === undefined || path.resolve(dependencyTask.artifactDir) !== path.resolve(dependency)) {
      throw new Error("dependency task is not declared for this handoff");
    }
    const markerLocation = artifactVerificationMarkerLocation(task.runRoot, dependencyAttemptId, false);
    if (markerLocation === undefined) {
      throw new Error("verification marker is missing");
    }
    const resolvedMarker = resolveRegularArtifactFile(
      markerLocation.root,
      markerLocation.path,
      `artifact-contract failure: artifact dependency has not passed verification ${dependencyAttemptId}`
    );
    const marker = JSON.parse(readFileSync(resolvedMarker, "utf8")) as {
      schema_version?: unknown;
      attempt_id?: unknown;
      artifacts?: unknown;
      publications?: unknown;
    };
    if (
      marker.schema_version !== ARTIFACT_VERIFICATION_SCHEMA_VERSION ||
      marker.attempt_id !== dependencyAttemptId ||
      !Array.isArray(marker.artifacts) ||
      !Array.isArray(marker.publications)
    ) {
      throw new Error("invalid verification marker");
    }
    if (marker.artifacts.length === 0 || dependencyTask.outputs.length === 0) {
      throw new Error("verification marker has no declared artifacts");
    }
    const expectedArtifacts = new Map(dependencyTask.outputs.map((output) => [output.path, output]));
    if (
      expectedArtifacts.size !== dependencyTask.outputs.length ||
      marker.artifacts.length !== expectedArtifacts.size
    ) {
      throw new Error("verification marker artifact set does not match the declared outputs");
    }
    const seenPaths = new Set<string>();
    const declaredArtifactShas = new Map<string, string>();
    const expectedPublicationShas = new Map<string, string>();
    for (const artifact of marker.artifacts) {
      if (
        typeof artifact !== "object" ||
        artifact === null ||
        Array.isArray(artifact) ||
        typeof (artifact as { path?: unknown }).path !== "string" ||
        typeof (artifact as { contract?: unknown }).contract !== "string" ||
        typeof (artifact as { contract_digest?: unknown }).contract_digest !== "string" ||
        !/^[0-9a-f]{64}$/u.test((artifact as { contract_digest: string }).contract_digest) ||
        typeof (artifact as { sha256?: unknown }).sha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test((artifact as { sha256: string }).sha256) ||
        typeof (artifact as { primary?: unknown }).primary !== "boolean"
      ) {
        throw new Error("invalid verification marker artifact entry");
      }
      const entry = artifact as {
        path: string;
        contract: string;
        contract_digest: string;
        sha256: string;
        primary: boolean;
      };
      if (seenPaths.has(entry.path)) {
        throw new Error(`duplicate verification marker artifact ${entry.path}`);
      }
      seenPaths.add(entry.path);
      const expected = expectedArtifacts.get(entry.path);
      if (
        expected === undefined ||
        expected.contract !== entry.contract ||
        expected.contractDigest !== entry.contract_digest ||
        expected.primary !== entry.primary
      ) {
        throw new Error(`verification marker artifact is not a declared output ${entry.path}`);
      }
      assertSafeVerifiedPublicationPath(entry.path);
      const artifactPath = path.resolve(dependency, entry.path);
      const resolvedArtifact = resolveRegularArtifactFile(
        dependency,
        artifactPath,
        `artifact-contract failure: verified dependency artifact is missing ${entry.path}`
      );
      const bytes = readFileSync(resolvedArtifact);
      const contents = bytes.toString("utf8");
      const definition = artifactContractDefinition(entry.contract as Parameters<typeof artifactContractDefinition>[0]);
      if (definition.digest !== entry.contract_digest) {
        throw new Error(`verified dependency contract changed ${entry.path}`);
      }
      const artifactSha = createHash("sha256").update(bytes).digest("hex");
      if (artifactSha !== entry.sha256) {
        throw new Error(`verified dependency artifact changed ${entry.path}`);
      }
      const validation = validateArtifactContract(
        entry.contract as Parameters<typeof validateArtifactContract>[0],
        contents,
        entry.path
      );
      if (!validation.ok) {
        throw new Error(`verified dependency artifact is no longer valid ${entry.path}`);
      }
      declaredArtifactShas.set(entry.path, entry.sha256);
      rememberExpectedVerifiedPublication(expectedPublicationShas, entry.path, bytes);
      if (entry.contract === "ultrafuzz/generated-tests@1") {
        for (const companion of verifyGeneratedTestFiles(dependency, validation.value)) {
          rememberExpectedVerifiedPublication(expectedPublicationShas, companion.path, companion.contents);
        }
      }
      if (entry.contract === "ultrafuzz/goal-plan@1") {
        for (const selected of verifyGoalPlanSelectedRecordSnapshots(dependency, validation.value)) {
          rememberExpectedVerifiedPublication(expectedPublicationShas, selected.path, selected.contents);
        }
      }
    }
    if (seenPaths.size !== expectedArtifacts.size) {
      throw new Error("verification marker is missing a declared output");
    }
    if (invariantSuiteNodeIds.has(dependencyTask.metadata.node.logicalNodeId)) {
      rememberExpectedInvariantSuitePublications(dependencyTask, dependency, expectedPublicationShas);
    }
    if (marker.publications.length === 0 || expectedPublicationShas.size === 0) {
      throw new Error("verification marker has no verified publications");
    }
    const publicationPaths = new Set<string>();
    const markerPublicationShas = new Map<string, string>();
    for (const publication of marker.publications) {
      if (
        typeof publication !== "object" ||
        publication === null ||
        Array.isArray(publication) ||
        typeof (publication as { path?: unknown }).path !== "string" ||
        typeof (publication as { sha256?: unknown }).sha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test((publication as { sha256: string }).sha256)
      ) {
        throw new Error("invalid verification marker publication entry");
      }
      const entry = publication as { path: string; sha256: string };
      assertSafeVerifiedPublicationPath(entry.path);
      if (publicationPaths.has(entry.path)) {
        throw new Error(`duplicate verification marker publication ${entry.path}`);
      }
      publicationPaths.add(entry.path);
      markerPublicationShas.set(entry.path, entry.sha256);
      const artifactPath = path.resolve(dependency, entry.path);
      const resolvedArtifact = resolveRegularArtifactFile(
        dependency,
        artifactPath,
        `artifact-contract failure: verified dependency publication is missing ${entry.path}`
      );
      const bytes = readFileSync(resolvedArtifact);
      if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
        throw new Error(`verified dependency publication changed ${entry.path}`);
      }
      const declaredSha = declaredArtifactShas.get(entry.path);
      if (declaredSha !== undefined && declaredSha !== entry.sha256) {
        throw new Error(`verified dependency publication disagrees with declared artifact ${entry.path}`);
      }
    }
    if (markerPublicationShas.size !== expectedPublicationShas.size) {
      throw new Error("verification marker publication set does not match the verified outputs");
    }
    for (const [expectedPath, expectedSha] of expectedPublicationShas) {
      const markerSha = markerPublicationShas.get(expectedPath);
      if (markerSha === undefined) {
        throw new Error(`verification marker publication is missing verified output ${expectedPath}`);
      }
      if (markerSha !== expectedSha) {
        throw new Error(`verification marker publication digest does not match verified output ${expectedPath}`);
      }
    }
  } catch (error) {
    throw new Error(
      `artifact-contract failure: artifact dependency has not passed verification ${path.basename(dependency)} for ${task.attemptId}`,
      { cause: error }
    );
  }
}

function rememberExpectedVerifiedPublication(
  publications: Map<string, string>,
  relativePath: string,
  contents: Buffer
): void {
  assertSafeVerifiedPublicationPath(relativePath);
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const previous = publications.get(relativePath);
  if (previous !== undefined && previous !== sha256) {
    throw new Error(`artifact-contract failure: conflicting verified publication ${relativePath}`);
  }
  publications.set(relativePath, sha256);
}

function assertSafeVerifiedPublicationPath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\u0000") ||
    relativePath.includes("\\") ||
    /^[A-Za-z]:/u.test(relativePath) ||
    relativePath.split("/").some((segment) => segment.length === 0 || segment === "..")
  ) {
    throw new Error(`artifact-contract failure: unsafe verified publication path ${relativePath}`);
  }
}

function preservePinnedSourceProof(task: (typeof taskSpecs)[number]): void {
  if (!usesPinnedSource) return;
  const workspaceRoot = realpathSync(task.workspacePath);
  const git = (args: string[]): string =>
    execFileSync("git", args, {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  const gitUnreachableCommitCount = (): string =>
    execFileSync("bash", ["-lc", unreachableCommitCountCommand], {
      cwd: workspaceRoot,
      encoding: "utf8",
      maxBuffer: 1024,
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  const commit = git(["rev-parse", "HEAD"]).toLowerCase();
  const tree = git(["rev-parse", "HEAD^{tree}"]).toLowerCase();
  const pinnedCommit = git(["rev-parse", pinnedSourceRef]).toLowerCase();
  const remotes = git(["remote"]).split("\n").filter(Boolean);
  const refs = git(["for-each-ref", "--format=%(refname)%00%(objectname)"])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, object] = line.split("\0");
      return { name, object: object?.toLowerCase() };
    });
  const reachableCommitCount = Number(git(["rev-list", "--all", "--count"]));
  const onlyReachableCommit = git(["rev-list", "--all", "--max-count=1"]).toLowerCase();
  const unreachableCommitCount = Number(gitUnreachableCommitCount());
  const commitObjectCount = reachableCommitCount + unreachableCommitCount;
  const pinnedSourceRefPresent = refs.some((ref) => ref.name === pinnedSourceRef && ref.object === pinnedCommit);
  const pinnedDependencies = task.pinnedSubmodules ?? null;
  if (
    !/^[0-9a-f]{40}$/u.test(commit) ||
    !/^[0-9a-f]{40}$/u.test(tree) ||
    commit !== pinnedCommit ||
    remotes.length !== 0 ||
    !Number.isSafeInteger(reachableCommitCount) ||
    !Number.isSafeInteger(unreachableCommitCount) ||
    unreachableCommitCount < 0 ||
    reachableCommitCount !== 1 ||
    commitObjectCount !== 1 ||
    onlyReachableCommit !== pinnedCommit ||
    !pinnedSourceRefPresent ||
    refs.some(
      (ref) =>
        (ref.name !== pinnedSourceRef && !ref.name?.startsWith("refs/heads/ultrafuzz/")) || ref.object !== pinnedCommit
    )
  ) {
    throw new Error(`source-isolation failure: final worktree ${task.attemptId} is not pinned`);
  }

  const runRoot = realpathSync(path.resolve(process.cwd(), task.metadata.artifacts.dir, "..", ".."));
  const proofRoot = path.resolve(runRoot, "source-proofs");
  if (!isStrictlyInsideDirectory(runRoot, proofRoot)) {
    throw new Error(`source-isolation failure: unsafe proof root ${task.attemptId}`);
  }
  mkdirSync(proofRoot, { recursive: true });
  const resolvedProofRoot = realpathSync(proofRoot);
  if (!isStrictlyInsideDirectory(runRoot, resolvedProofRoot)) {
    throw new Error(`source-isolation failure: unsafe proof root ${task.attemptId}`);
  }
  const proofPath = path.join(resolvedProofRoot, `${task.attemptId}.json`);
  const proofContents = `${JSON.stringify(
    {
      schema_version: "ultrafuzz.agent-source-proof.v2",
      attempt_id: task.attemptId,
      commit,
      tree,
      base_ref: pinnedSourceRef,
      refs: [{ name: pinnedSourceRef, object: pinnedCommit }],
      remotes,
      revision_count: reachableCommitCount,
      commit_object_count: commitObjectCount,
      dependencies: pinnedDependencies
    },
    null,
    2
  )}\n`;
  if (existsSync(proofPath)) {
    const previousBytes = readFileSync(proofPath);
    if (previousBytes.equals(Buffer.from(proofContents, "utf8"))) {
      return;
    }
    let previousProof;
    try {
      previousProof = JSON.parse(previousBytes.toString("utf8"));
    } catch {
      previousProof = undefined;
    }
    const expectedProofKeys = [
      "schema_version",
      "attempt_id",
      "commit",
      "tree",
      "base_ref",
      "refs",
      "remotes",
      "revision_count",
      "commit_object_count",
      "dependencies"
    ];
    const previousProofKeys =
      previousProof !== null && typeof previousProof === "object" && !Array.isArray(previousProof)
        ? Object.keys(previousProof)
        : [];
    const previousRefs = Array.isArray(previousProof?.refs) ? previousProof.refs : [];
    const seenPreviousRefNames = new Set();
    const previousRefsAreCanonical = previousRefs.every((ref) => {
      if (ref === null || typeof ref !== "object" || Array.isArray(ref)) return false;
      const refKeys = Object.keys(ref);
      if (refKeys.length !== 2 || refKeys[0] !== "name" || refKeys[1] !== "object") return false;
      if (typeof ref.name !== "string" || typeof ref.object !== "string") return false;
      if (seenPreviousRefNames.has(ref.name)) return false;
      seenPreviousRefNames.add(ref.name);
      return (
        (ref.name === pinnedSourceRef || ref.name.startsWith("refs/heads/ultrafuzz/")) && ref.object === pinnedCommit
      );
    });
    const previousProofIsCanonicalJson = previousBytes.equals(
      Buffer.from(`${JSON.stringify(previousProof, null, 2)}\n`)
    );
    const legacyRefNoisePresent = previousRefs.some(
      (ref) => ref !== null && typeof ref === "object" && ref.name !== pinnedSourceRef
    );
    const canonicalizedPreviousProofContents = `${JSON.stringify(
      {
        schema_version: previousProof?.schema_version,
        attempt_id: previousProof?.attempt_id,
        commit: previousProof?.commit,
        tree: previousProof?.tree,
        base_ref: previousProof?.base_ref,
        refs: [{ name: pinnedSourceRef, object: pinnedCommit }],
        remotes: previousProof?.remotes,
        revision_count: previousProof?.revision_count,
        commit_object_count: previousProof?.commit_object_count,
        dependencies: previousProof?.dependencies
      },
      null,
      2
    )}\n`;
    const previousProofMatches =
      previousProofKeys.length === expectedProofKeys.length &&
      previousProofKeys.every((key, index) => key === expectedProofKeys[index]) &&
      previousProof?.schema_version === "ultrafuzz.agent-source-proof.v2" &&
      previousProof.attempt_id === task.attemptId &&
      previousProof.commit === commit &&
      previousProof.tree === tree &&
      previousProof.base_ref === pinnedSourceRef &&
      Array.isArray(previousProof.remotes) &&
      previousProof.remotes.length === 0 &&
      previousProof.revision_count === reachableCommitCount &&
      previousProof.commit_object_count === commitObjectCount &&
      JSON.stringify(previousProof.dependencies) === JSON.stringify(pinnedDependencies) &&
      previousRefs.some((ref) => ref?.name === pinnedSourceRef && ref.object === pinnedCommit) &&
      previousRefsAreCanonical &&
      previousProofIsCanonicalJson &&
      legacyRefNoisePresent &&
      canonicalizedPreviousProofContents === proofContents;
    if (!previousProofMatches) {
      throw new Error(`source-isolation failure: pinned source proof ${task.attemptId} changed`);
    }
    return;
  }
  writeFileDurable(proofPath, proofContents);
}

function canonicalEmptyArtifact(
  task: (typeof taskSpecs)[number],
  output: (typeof task.outputs)[number]
): string | undefined {
  // Workspace patches are captured and materialized by the runtime after the
  // agent returns. Leaving an empty placeholder here would make the later
  // runtime-owned workspace patch outputs look like agent modifications to the
  // strict writer.
  if (output.path === "workspace.patch" || output.path === "workspace-patch.json") {
    return undefined;
  }
  // The vulnerability-db snapshot manifest is likewise materialized by the
  // runtime after the agent returns. A pre-created empty placeholder would
  // conflict with the exclusive canonical bytes the snapshot publishes.
  if (output.path === "vulnerability-db-manifest.json") {
    return undefined;
  }
  // These artifacts carry source-completeness and provenance joins. An empty
  // sidecar would make an omitted agent output look successful, so they must
  // always be produced by the agent and rejected by the strict verifier.
  if (output.contract === "ultrafuzz/invariant-ledger@1" || output.contract === "ultrafuzz/properties@1") {
    return undefined;
  }
  // A primary findings array canonically represents "no findings". Other
  // primary outputs must still come from the agent. Non-primary outputs use
  // their contract-defined empty representation and remain overwritable.
  if (output.primary && output.contract !== "ultrafuzz/findings@1") {
    return undefined;
  }
  const example = artifactContractDefinition(output.contract).validEmptyExample;
  if (example === undefined) {
    return undefined;
  }
  return `${example
    .replaceAll("<run-id>", task.metadata.run.ultrafuzzRunId)
    .replaceAll("<node-id>", task.metadata.node.concreteNodeId)}\n`;
}

function materializeMissingMarkdownArtifacts(task: (typeof taskSpecs)[number], result: unknown): void {
  const summary = agentResultSummary(result);
  if (summary === undefined) {
    return;
  }
  const artifactDir = realpathSync(task.metadata.artifacts.dir);
  const artifactRoots = taskArtifactRoots(task, artifactDir);
  const mirrorRoot = realpathSync(mirroredArtifactDir(task));
  const title = String(task.metadata.node.label ?? task.metadata.node.concreteNodeId).replace(/[\r\n]+/gu, " ");
  const fallback = `# ${title}\n\n${summary}\n`;

  for (const output of task.outputs) {
    if (
      output.contract !== "ultrafuzz/nonempty-markdown@1" ||
      (task.metadata.node.logicalNodeId === "final-report" && output.path === "report.md")
    ) {
      continue;
    }
    let invalidArtifactPath: string | undefined;
    let invalidArtifactRoot: string | undefined;
    let valid = false;
    for (const candidateRoot of artifactRoots) {
      try {
        const resolvedPath = resolveRegularArtifactFile(
          candidateRoot,
          path.resolve(candidateRoot, output.path),
          `artifact-contract failure: output is not a regular file ${output.path}`
        );
        const validation = validateArtifactContract(output.contract, readFileSync(resolvedPath, "utf8"), output.path);
        if (validation.ok) {
          valid = true;
          break;
        }
        if (invalidArtifactPath === undefined) {
          invalidArtifactPath = resolvedPath;
          invalidArtifactRoot = candidateRoot;
        }
      } catch {
        // A missing output is materialized into the exact task-owned mirror.
      }
    }
    if (valid) {
      continue;
    }
    const artifactPath = invalidArtifactPath ?? path.resolve(mirrorRoot, output.path);
    const artifactRoot = invalidArtifactRoot ?? mirrorRoot;
    if (!isStrictlyInsideDirectory(artifactRoot, artifactPath)) {
      throw new Error(`artifact-contract failure: unsafe Markdown output path ${output.path}`);
    }
    writeFileSync(artifactPath, fallback, {
      encoding: "utf8",
      flag: invalidArtifactPath === undefined ? "wx" : "w",
      mode: 0o600
    });
  }
}

function materializeCanonicalThreatModelArtifact(task: (typeof taskSpecs)[number]): void {
  if (task.metadata.node.logicalNodeId !== "threat-model") return;
  const artifactDir = realpathSync(task.metadata.artifacts.dir);
  const runRoot = realpathSync(path.resolve(artifactDir, "..", ".."));
  const workspaceRoot = realpathSync(task.workspacePath);
  for (const artifactRoot of taskArtifactRoots(task, artifactDir)) {
    const jsonPath = path.resolve(artifactRoot, "threat-model.json");
    if (!existsSync(jsonPath)) continue;
    resolveRegularArtifactFile(
      artifactRoot,
      jsonPath,
      "artifact-contract failure: threat-model.json is not a regular file"
    );
    const model = verifyThreatModelVulnerabilityDatabaseCapabilities(artifactRoot, runRoot);
    verifyThreatModelEvidenceFiles(model, workspaceRoot);
    materializeCanonicalThreatModelMarkdown(artifactRoot);
  }
}

function materializeGoalPlanDatabaseArtifacts(task: (typeof taskSpecs)[number]): void {
  if (task.metadata.node.logicalNodeId !== "goal-plan") return;
  const dependencyAttemptIds = new Set(task.metadata.dependencies.attemptIds);
  const threatModelArtifactDirs = taskSpecs
    .filter(
      (candidate) =>
        dependencyAttemptIds.has(candidate.attemptId) && candidate.metadata.node.logicalNodeId === "threat-model"
    )
    .map((candidate) => candidate.metadata.artifacts.dir);
  if (threatModelArtifactDirs.length === 0) {
    throw new Error("artifact-contract failure: goal-plan has no direct threat-model dependency identity");
  }
  const artifactDir = realpathSync(task.metadata.artifacts.dir);
  const runRoot = realpathSync(path.resolve(artifactDir, "..", ".."));
  for (const artifactRoot of taskArtifactRoots(task, artifactDir)) {
    const goalPlanPath = path.resolve(artifactRoot, "goal-plan.json");
    if (!existsSync(goalPlanPath)) continue;
    resolveRegularArtifactFile(
      artifactRoot,
      goalPlanPath,
      "artifact-contract failure: goal-plan.json is not a regular file"
    );
    materializeGoalPlanVulnerabilityDatabaseSnapshots(artifactRoot, {
      threatModelArtifactDirs,
      runRoot,
      maxDynamicNodes
    });
  }
}

function normalizeFindingProvenance(task: (typeof taskSpecs)[number]): void {
  const artifactDir = realpathSync(task.metadata.artifacts.dir);
  const preserveSourceNodes = isFindingTransformationNode(task.metadata.node.logicalNodeId);
  const producerNodeId = task.metadata.node.producerNodeId ?? task.attemptId;
  const sourceProvenance = preserveSourceNodes ? dependencyFindingProvenance(task, artifactDir) : undefined;
  for (const output of task.outputs) {
    if (output.contract !== "ultrafuzz/findings@1") continue;
    for (const candidateRoot of taskArtifactRoots(task, artifactDir)) {
      const candidatePath = path.resolve(candidateRoot, output.path);
      if (!existsSync(candidatePath)) continue;
      resolveRegularArtifactFile(
        candidateRoot,
        candidatePath,
        `artifact-contract failure: output is not a regular file ${output.path}`
      );
      normalizeFindings({
        artifactDir: candidateRoot,
        relativePath: output.path,
        nodeId: task.attemptId,
        provenance: {
          producerNodeId,
          strategy: task.metadata.node.logicalNodeId,
          attemptIndex: task.metadata.model?.attemptIndex ?? task.metadata.loop.attemptIndex,
          modelId: task.metadata.model?.profileId,
          model: task.metadata.model?.modelName,
          modelIndex: task.metadata.model?.modelIndex,
          loopIndex: task.metadata.loop.index
        },
        preserveSourceNodes,
        requireSourceNodes: preserveSourceNodes,
        allowedSourceNodes: sourceProvenance?.allowedSourceNodes,
        sourceExpectations: sourceProvenance?.expectations,
        requireSourceExpectation: preserveSourceNodes
      });
    }
  }
}

function dependencyFindingProvenance(
  task: (typeof taskSpecs)[number],
  artifactDir: string
): { allowedSourceNodes: string[]; expectations: ReturnType<typeof buildFindingSourceExpectations> } {
  const upstream = dependencyFindingSources(task, artifactDir);
  const requireLifecycleCoverage = task.metadata.node.logicalNodeId === "dedupe-findings";
  const lifecycleLedger = requireLifecycleCoverage ? currentFindingLifecycleLedger(task, artifactDir) : undefined;
  if (requireLifecycleCoverage && lifecycleLedger === undefined && upstream.length > 0) {
    throw new Error("artifact-contract failure: dedupe provenance requires finding-lifecycle-ledger.json");
  }
  const expectations = buildFindingSourceExpectations({
    upstream,
    ...(lifecycleLedger === undefined ? {} : { lifecycleLedger }),
    requireLifecycleCoverage
  });
  return {
    allowedSourceNodes: uniqueStrings(expectations.flatMap((expectation) => expectation.source_nodes)),
    expectations
  };
}

function dependencyFindingSources(
  task: (typeof taskSpecs)[number],
  artifactDir: string
): Array<{ node_id: string; artifact_path: string; finding: unknown }> {
  const artifactsParent = realpathSync(path.dirname(artifactDir));
  const findingFiles = [
    "severity-classified-findings.json",
    "triaged-findings.json",
    "deduped-findings.json",
    "findings.normalized.json",
    "findings.json"
  ];
  const upstream: Array<{ node_id: string; artifact_path: string; finding: unknown }> = [];
  for (const attemptId of task.metadata.dependencies.attemptIds) {
    const dependency = taskSpecs.find((candidate) => candidate.attemptId === attemptId);
    if (dependency === undefined) continue;
    // #677: a goal lane without a verification marker is tolerated by `assertTaskInputs` so one
    // killed search cannot fail the fan-ins, and this is the other half of that bargain. Tolerating a
    // MISSING dependency must never turn into consuming an UNVERIFIED one: whatever findings bytes an
    // interrupted goal worktree happens to have left behind were never published, digest-checked, or
    // contract-verified, so they are not provenance and are excluded here. The census records the
    // lane as skipped instead.
    if (goalSearchDependencyIsUnverified(task, dependency)) continue;
    const nodeId = dependency.metadata.node.producerNodeId ?? dependency.metadata.node.concreteNodeId ?? attemptId;
    const roots = [path.resolve(artifactsParent, attemptId)];
    let collected = false;
    for (const rootPath of roots) {
      if (!existsSync(rootPath)) continue;
      const dependencyRoot = realpathSync(rootPath);
      if (!isStrictlyInsideDirectory(artifactsParent, dependencyRoot)) continue;
      for (const fileName of findingFiles) {
        const findingPath = path.resolve(dependencyRoot, fileName);
        if (!existsSync(findingPath)) continue;
        const resolvedPath = resolveRegularArtifactFile(
          dependencyRoot,
          findingPath,
          `artifact-contract failure: dependency findings are not a regular file ${fileName}`
        );
        const validation = validateArtifactContract(
          "ultrafuzz/findings@1",
          readFileSync(resolvedPath, "utf8"),
          fileName
        );
        if (!validation.ok || !Array.isArray(validation.value)) continue;
        upstream.push(
          ...validation.value.map((finding) => ({ node_id: nodeId, artifact_path: resolvedPath, finding }))
        );
        collected = true;
        break;
      }
      if (collected) break;
    }
  }
  return upstream;
}

function currentFindingLifecycleLedger(task: (typeof taskSpecs)[number], artifactDir: string): unknown | undefined {
  for (const artifactRoot of taskArtifactRoots(task, artifactDir)) {
    const ledgerPath = path.resolve(artifactRoot, "finding-lifecycle-ledger.json");
    if (!existsSync(ledgerPath)) continue;
    const resolvedPath = resolveRegularArtifactFile(
      artifactRoot,
      ledgerPath,
      "artifact-contract failure: finding lifecycle ledger is not a regular file"
    );
    try {
      return JSON.parse(readFileSync(resolvedPath, "utf8")) as unknown;
    } catch {
      throw new Error("artifact-contract failure: finding lifecycle ledger must contain valid JSON");
    }
  }
  return undefined;
}

function uniqueStrings(values: readonly unknown[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "" && !result.includes(value.trim())) result.push(value.trim());
  }
  return result;
}

function isFindingTransformationNode(logicalNodeId: string): boolean {
  return ["dedupe-findings", "triage", "severity-classification", "final-report"].includes(logicalNodeId);
}

function agentResultSummary(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) {
    return typeof result === "string" && result.trim().length > 0 ? result.trim() : undefined;
  }
  const record = result as { output?: unknown; experimental_output?: unknown; text?: unknown };
  for (const candidate of [record.output, record.experimental_output]) {
    if (typeof candidate === "object" && candidate !== null) {
      const summary = (candidate as { summary?: unknown }).summary;
      if (typeof summary === "string" && summary.trim().length > 0) {
        return summary.trim();
      }
    }
  }
  return typeof record.text === "string" && record.text.trim().length > 0 ? record.text.trim() : undefined;
}

function materializeMissingDedupeArtifact(task: (typeof taskSpecs)[number]): void {
  if (task.metadata.node.logicalNodeId !== "dedupe-findings") {
    return;
  }
  const output = task.outputs.find((candidate) => candidate.primary && candidate.path === "deduped-findings.json");
  if (
    output === undefined ||
    (output.contract !== "ultrafuzz/json-array@1" && output.contract !== "ultrafuzz/findings@1")
  ) {
    return;
  }

  const artifactDir = realpathSync(task.metadata.artifacts.dir);
  for (const candidateRoot of taskArtifactRoots(task, artifactDir)) {
    try {
      const candidatePath = resolveRegularArtifactFile(
        candidateRoot,
        path.resolve(candidateRoot, output.path),
        `artifact-contract failure: output is not a regular file ${output.path}`
      );
      const contents = readFileSync(candidatePath, "utf8");
      const validation = validateArtifactContract("ultrafuzz/findings@1", contents, output.path);
      if (validation.ok && Array.isArray(validation.value) && validation.value.length > 0) {
        return;
      }
      const normalized = normalizeLegacyFindingArray(contents);
      if (normalized !== undefined) {
        const normalizedValidation = validateArtifactContract("ultrafuzz/findings@1", normalized, output.path);
        if (
          normalizedValidation.ok &&
          Array.isArray(normalizedValidation.value) &&
          normalizedValidation.value.length > 0
        ) {
          writeFileDurable(candidatePath, normalized);
          return;
        }
      }
    } catch {
      // Recover from the already validated dependency findings below.
    }
  }

  const retained: unknown[] = [];
  for (const dependencyAttemptId of task.metadata.dependencies.attemptIds) {
    const dependency = taskSpecs.find((candidate) => candidate.attemptId === dependencyAttemptId);
    if (dependency === undefined) {
      continue;
    }
    // #677: this recovery path reads the dependency's own worktree mirror as a fallback, which for a
    // goal lane that never passed verification is exactly the unpublished, unchecked byte stream the
    // artifact contract exists to keep out of a report. Retain only verified goal lanes.
    if (goalSearchDependencyIsUnverified(task, dependency)) {
      continue;
    }
    for (const candidateRootPath of [dependency.metadata.artifacts.dir, mirroredArtifactDir(dependency)]) {
      try {
        const candidateRoot = realpathSync(candidateRootPath);
        const findingsPath = resolveRegularArtifactFile(
          candidateRoot,
          path.resolve(candidateRoot, "findings.json"),
          "artifact-contract failure: dependency findings are not a regular file"
        );
        const validation = validateArtifactContract(
          "ultrafuzz/findings@1",
          readFileSync(findingsPath, "utf8"),
          "findings.json"
        );
        if (validation.ok && Array.isArray(validation.value)) {
          retained.push(...validation.value);
          break;
        }
      } catch {
        // Try the dependency's task-owned mirror when canonical publication is still catching up.
      }
    }
  }

  const mirrorRoot = realpathSync(mirroredArtifactDir(task));
  const outputPath = path.resolve(mirrorRoot, output.path);
  if (!isStrictlyInsideDirectory(mirrorRoot, outputPath)) {
    throw new Error(`artifact-contract failure: unsafe output path ${output.path}`);
  }
  const serialized = `${JSON.stringify(retained, null, 2)}\n`;
  if (!validateArtifactContract("ultrafuzz/findings@1", serialized, output.path).ok) {
    throw new Error(`artifact-contract failure: retained findings did not form ${output.path}`);
  }
  writeFileDurable(outputPath, serialized);
}

function materializeMissingFinalReportArtifacts(task: (typeof taskSpecs)[number]): void {
  if (task.metadata.node.logicalNodeId !== "final-report") {
    return;
  }
  const reportOutput = task.outputs.find(
    (candidate) => candidate.path === "report.json" && candidate.contract === "ultrafuzz/report@1"
  );
  const markdownOutput = task.outputs.find(
    (candidate) => candidate.path === "report.md" && candidate.contract === "ultrafuzz/nonempty-markdown@1"
  );
  const findingsOutput = task.outputs.find(
    (candidate) => candidate.path === "findings.normalized.json" && candidate.contract === "ultrafuzz/findings@1"
  );
  if (reportOutput === undefined || markdownOutput === undefined) {
    return;
  }

  const artifactDir = realpathSync(task.metadata.artifacts.dir);
  const artifactRoots = taskArtifactRoots(task, artifactDir);
  const recoverableOutputs =
    findingsOutput === undefined ? [reportOutput, markdownOutput] : [reportOutput, markdownOutput, findingsOutput];
  if (!recoverableOutputs.some((output) => finalReportOutputNeedsRecovery(artifactRoots, output))) {
    // Canonical projection is a recovery path, not an additional input
    // contract for an already complete final-review attempt. The unchanged
    // verifier below remains authoritative for the declared artifacts.
    return;
  }
  const report = validatedFinalReport(artifactRoots, reportOutput.path);
  if (report === undefined) {
    // Only the final-review worker may decide which findings are production
    // issues. Leave its required output missing so Smithers retries the node.
    return;
  }
  const projection = projectCanonicalFinalReport(report);
  writeValidatedTaskArtifact(task, reportOutput, projection.report);
  if (findingsOutput !== undefined) {
    const findings = normalizedFindingArray(projection.report.issues);
    if (findings === undefined) {
      throw new Error("artifact-contract failure: canonical final report issues did not form normalized findings");
    }
    writeNormalizedFindings(task, findingsOutput.path, findings);
  }
  writeValidatedTaskArtifactContents(task, markdownOutput, projection.markdown);
}

function finalReportOutputNeedsRecovery(
  artifactRoots: string[],
  output: (typeof taskSpecs)[number]["outputs"][number]
): boolean {
  for (const candidateRoot of artifactRoots) {
    let resolvedPath: string;
    try {
      resolvedPath = resolveRegularArtifactFile(
        candidateRoot,
        path.resolve(candidateRoot, output.path),
        `artifact-contract failure: output is not a regular file ${output.path}`
      );
    } catch {
      // Match verifier root selection: only a regular file claims this root.
      continue;
    }
    try {
      const contents = readFileSync(resolvedPath).toString("utf8");
      return !validateArtifactContract(output.contract, contents, output.path).ok;
    } catch {
      return true;
    }
  }
  return true;
}

function validatedFinalReport(
  artifactRoots: string[],
  relativePath: string
): { issues?: unknown; run_metadata?: unknown; non_production_outcomes?: unknown } | undefined {
  for (const candidateRoot of artifactRoots) {
    try {
      const reportPath = resolveRegularArtifactFile(
        candidateRoot,
        path.resolve(candidateRoot, relativePath),
        `artifact-contract failure: output is not a regular file ${relativePath}`
      );
      const validation = validateArtifactContract(
        "ultrafuzz/report@1",
        readBoundedFinalReportJson(reportPath),
        relativePath
      );
      if (!validation.ok || !isPlainRecord(validation.value)) {
        continue;
      }
      return validation.value;
    } catch {
      // Try the task's other exact artifact root.
    }
  }
  return undefined;
}

function normalizedFindingArray(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const validation = validateArtifactContract("ultrafuzz/findings@1", serialized, "findings.normalized.json");
  return validation.ok ? value : undefined;
}

function writeNormalizedFindings(task: (typeof taskSpecs)[number], relativePath: string, findings: unknown[]): void {
  const output = task.outputs.find(
    (candidate) => candidate.path === relativePath && candidate.contract === "ultrafuzz/findings@1"
  );
  if (output === undefined) {
    throw new Error(`artifact-contract failure: undeclared normalized findings output ${relativePath}`);
  }
  writeValidatedTaskArtifact(task, output, findings);
}

function writeValidatedTaskArtifact(
  task: (typeof taskSpecs)[number],
  output: (typeof task.outputs)[number],
  value: unknown
): void {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  writeValidatedTaskArtifactContents(task, output, serialized);
}

function writeValidatedTaskArtifactContents(
  task: (typeof taskSpecs)[number],
  output: (typeof task.outputs)[number],
  contents: string
): void {
  if (!validateArtifactContract(output.contract, contents, output.path).ok) {
    throw new Error(`artifact-contract failure: recovered value did not form ${output.path}`);
  }

  const canonicalRoot = realpathSync(task.metadata.artifacts.dir);
  const canonicalPath = path.resolve(canonicalRoot, output.path);
  if (!isStrictlyInsideDirectory(canonicalRoot, canonicalPath)) {
    throw new Error(`artifact-contract failure: unsafe output path ${output.path}`);
  }
  let existingCanonical: string | undefined;
  try {
    existingCanonical = resolveRegularArtifactFile(
      canonicalRoot,
      canonicalPath,
      `artifact-contract failure: output is not a regular file ${output.path}`
    );
  } catch {
    // A missing canonical path may be created below. An unsafe existing path
    // is left untouched and the exact task-owned mirror remains available.
  }
  if (existingCanonical !== undefined) {
    writeFileDurable(existingCanonical, contents);
    return;
  }
  if (!existsSync(canonicalPath)) {
    writeFileDurable(canonicalPath, contents);
    return;
  }
  // An unsafe canonical path is left untouched; publish through the exact
  // task-owned mirror so the strict verifier can fail closed or reconcile it.

  const mirrorRoot = realpathSync(mirroredArtifactDir(task));
  const mirrorPath = path.resolve(mirrorRoot, output.path);
  if (!isStrictlyInsideDirectory(mirrorRoot, mirrorPath)) {
    throw new Error(`artifact-contract failure: unsafe output path ${output.path}`);
  }
  if (existsSync(mirrorPath)) {
    resolveRegularArtifactFile(
      mirrorRoot,
      mirrorPath,
      `artifact-contract failure: output is not a regular file ${output.path}`
    );
  }
  writeFileDurable(mirrorPath, contents);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLegacyFindingFields(task: (typeof taskSpecs)[number]): void {
  const artifactDir = realpathSync(task.metadata.artifacts.dir);
  const artifactRoots = taskArtifactRoots(task, artifactDir);

  for (const output of task.outputs) {
    if (output.contract !== "ultrafuzz/findings@1") {
      continue;
    }
    for (const candidateRoot of artifactRoots) {
      let resolvedPath: string;
      try {
        resolvedPath = resolveRegularArtifactFile(
          candidateRoot,
          path.resolve(candidateRoot, output.path),
          `artifact-contract failure: output is not a regular file ${output.path}`
        );
      } catch {
        continue;
      }
      const contents = readFileSync(resolvedPath, "utf8");
      if (validateArtifactContract(output.contract, contents, output.path).ok) {
        break;
      }
      const normalized = normalizeLegacyFindingArray(contents);
      if (normalized !== undefined && validateArtifactContract(output.contract, normalized, output.path).ok) {
        writeFileSync(resolvedPath, normalized, { encoding: "utf8", flag: "w", mode: 0o600 });
        break;
      }
    }
  }
}

function normalizeLegacyFindingArray(contents: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return undefined;
  }

  let changed = false;
  const findings = parsed.map((entry) => {
    const normalized = normalizeLegacyFindingRecord(entry);
    changed ||= normalized.changed;
    return normalized.value;
  });

  return changed ? `${JSON.stringify(findings, null, 2)}\n` : undefined;
}

function normalizeLegacyFindingRecord(entry: unknown): { value: unknown; changed: boolean } {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return { value: entry, changed: false };
  }
  const finding = { ...entry } as Record<string, unknown>;
  let changed = false;
  for (const key of ["affected_files", "affected_functions", "patch_refs", "property_ids", "notes"] as const) {
    const value = finding[key];
    if (typeof value === "string" && value.trim().length > 0) {
      finding[key] = [value.trim()];
      changed = true;
    }
  }
  for (const key of ["affected_files", "patch_refs"] as const) {
    const normalizedPaths = normalizeLegacyPathReferences(finding[key]);
    if (normalizedPaths.changed) {
      finding[key] = normalizedPaths.value;
      changed = true;
    }
  }
  if (
    typeof finding.confidence === "number" &&
    Number.isFinite(finding.confidence) &&
    finding.confidence >= 0 &&
    finding.confidence <= 1
  ) {
    finding.confidence = String(finding.confidence);
    changed = true;
  }
  const strategy = finding.strategy;
  if (typeof strategy === "object" && strategy !== null && !Array.isArray(strategy)) {
    const legacyStrategy = [
      (strategy as Record<string, unknown>).strategy,
      (strategy as Record<string, unknown>).origin
    ].find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
    if (legacyStrategy !== undefined) {
      finding.strategy = legacyStrategy.trim();
      changed = true;
    }
  }
  const evidence = finding.evidence;
  if (typeof evidence === "string" || (typeof evidence === "object" && evidence !== null && !Array.isArray(evidence))) {
    finding.evidence = [evidence];
    changed = true;
  }
  const normalizedEvidence = normalizeEvidenceLineRangeCardinality(finding.evidence);
  if (normalizedEvidence.changed) {
    finding.evidence = normalizedEvidence.value;
    changed = true;
  }
  return changed ? { value: finding, changed: true } : { value: entry, changed: false };
}

function normalizeLegacyPathReferences(value: unknown): { value: unknown; changed: boolean } {
  if (!Array.isArray(value)) {
    return { value, changed: false };
  }
  let changed = false;
  const normalized = value.map((entry) => {
    if (typeof entry !== "string") {
      return entry;
    }
    const normalizedPath = normalizeLegacyPathReference(entry);
    changed ||= normalizedPath.changed;
    return normalizedPath.value;
  });
  return changed ? { value: normalized, changed: true } : { value, changed: false };
}

function normalizeLegacyPathReference(value: string): { value: string; changed: boolean } {
  const trimmed = value.trim();
  const hashLineSuffix = trimmed.match(/^(.+?)#L\d+(?:-L?\d+)?$/u);
  const withoutHashLineSuffix = hashLineSuffix?.[1] ?? trimmed;
  const colonLineSuffix = withoutHashLineSuffix.match(/^(.+?):\d+(?::\d+)?$/u);
  const normalized = colonLineSuffix?.[1] ?? withoutHashLineSuffix;
  return normalized === value ? { value, changed: false } : { value: normalized, changed: true };
}

function readBoundedFinalReportJson(reportPath: string): string {
  const descriptor = openSync(reportPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new Error("artifact-contract failure: final report JSON must be a regular file");
    }
    if (stat.size > MAX_FINAL_REPORT_JSON_BYTES) {
      throw new Error(
        `artifact-contract failure: final report JSON exceeds the ${MAX_FINAL_REPORT_JSON_BYTES}-byte read limit`
      );
    }
    const contents = readFileSync(descriptor);
    if (contents.byteLength > MAX_FINAL_REPORT_JSON_BYTES) {
      throw new Error(
        `artifact-contract failure: final report JSON exceeds the ${MAX_FINAL_REPORT_JSON_BYTES}-byte read limit`
      );
    }
    return contents.toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function reconstructAuthoritativeReportImplementationCoverage(task: (typeof taskSpecs)[number]): void {
  if (task.metadata.node.logicalNodeId !== "final-report") {
    return;
  }
  const reportOutput = task.outputs.find(
    (output) => output.path === "report.json" && output.contract === "ultrafuzz/report@1"
  );
  if (reportOutput === undefined) {
    return;
  }

  const artifactDir = realpathSync(task.metadata.artifacts.dir);
  const reportPaths = taskArtifactRoots(task, artifactDir).flatMap((artifactRoot) => {
    try {
      return [
        resolveRegularArtifactFile(
          artifactRoot,
          path.resolve(artifactRoot, reportOutput.path),
          `artifact-contract failure: output is not a regular file ${reportOutput.path}`
        )
      ];
    } catch {
      return [];
    }
  });
  if (reportPaths.length === 0) {
    return;
  }

  const implementationArtifact = verifiedAncestorJsonArtifact(
    task,
    "stateful-invariant-implement-properties",
    "implemented-properties.json",
    "ultrafuzz/implemented-properties@2",
    "ultrafuzz/implemented-properties@1"
  );
  const implementationProducerDeclared = taskSpecs.some(
    (candidate) => candidate.metadata.node.logicalNodeId === "stateful-invariant-implement-properties"
  );
  // A producer-free topology has no authoritative implementation coverage to
  // report. Replace a model-authored optional value with the contract's
  // canonical no-coverage sentinel rather than letting an invented or
  // malformed object break an otherwise valid terminal report. Historical
  // plans do declare an explicit @1 producer, so they keep their agent-authored
  // unavailable/no-selection compatibility behavior.
  if (implementationArtifact === undefined) {
    if (!implementationProducerDeclared) {
      for (const reportPath of reportPaths) {
        const reconstructed = replaceReportImplementationCoverage(
          readBoundedFinalReportJson(reportPath),
          "unavailable"
        );
        if (reconstructed !== undefined) {
          writeFileDurable(reportPath, reconstructed);
        }
      }
    }
    return;
  }
  const catalogArtifact = verifiedAncestorJsonArtifact(
    task,
    "property-specification-fanin",
    "properties.json",
    "ultrafuzz/properties@1"
  );
  if (catalogArtifact === undefined) {
    throw new Error("artifact-contract failure: authoritative property catalog is unavailable for final-report");
  }
  const catalog = validatePropertiesSchema(catalogArtifact.value, catalogArtifact.path);
  const implementation = validateImplementedPropertiesSchema(
    implementationArtifact.value,
    implementationArtifact.path,
    { requireSelection: true }
  );
  if (!catalog.ok || catalog.value === undefined || !implementation.ok || implementation.value === undefined) {
    throw new Error(
      `artifact-contract failure: authoritative property implementation coverage is invalid: ${formatSchemaValidationIssues(
        [...catalog.issues, ...implementation.issues]
      )}`
    );
  }
  const configured = configuredInvariantPrioritySelection(task);
  const derived = derivePropertyImplementationCoverage(catalog.value, implementation.value, {
    configuredSelection: configured.selection,
    requireConfiguredSelection: true,
    catalogPath: catalogArtifact.path,
    implementationPath: implementationArtifact.path,
    configPath: configured.path
  });
  if (!derived.ok || derived.value === undefined) {
    throw new Error(
      `artifact-contract failure: authoritative property implementation coverage is invalid: ${formatSchemaValidationIssues(derived.issues)}`
    );
  }

  for (const reportPath of reportPaths) {
    const reconstructed = replaceReportImplementationCoverage(readBoundedFinalReportJson(reportPath), derived.value);
    if (reconstructed !== undefined) {
      writeFileDurable(reportPath, reconstructed);
    }
  }
}

function verifiedAncestorJsonArtifact(
  task: (typeof taskSpecs)[number],
  logicalNodeId: string,
  relativePath: string,
  contract: string,
  historicalContract?: string
): { path: string; value: unknown } | undefined {
  const declaredProducers = taskSpecs.filter((candidate) => candidate.metadata.node.logicalNodeId === logicalNodeId);
  // Some selected topologies deliberately omit this producer. The shipped
  // smoke benchmark, for example, has no invariant-implementation phase, so
  // there is no authoritative coverage handoff to reconstruct. Once a
  // topology declares a producer, however, its handoff must be an ancestor
  // and every current-contract verification below remains fail-closed.
  if (declaredProducers.length === 0) {
    return undefined;
  }
  const candidates = task.dependencyArtifactDirs.flatMap((dependency) => {
    const dependencyTask = declaredProducers.find((candidate) => candidate.attemptId === path.basename(dependency));
    if (dependencyTask === undefined) {
      return [];
    }
    return dependencyTask.outputs
      .filter((output) => output.path === relativePath)
      .map((output) => ({ dependency, dependencyTask, output }));
  });
  if (candidates.length === 0) {
    throw new Error(`artifact-contract failure: authoritative ${relativePath} handoff is unavailable`);
  }
  if (candidates.length !== 1) {
    throw new Error(`artifact-contract failure: authoritative ${relativePath} handoff is ambiguous`);
  }
  const candidate = candidates[0]!;
  if (historicalContract !== undefined && candidate.output.contract === historicalContract) {
    return undefined;
  }
  if (candidate.output.contract !== contract) {
    throw new Error(
      `artifact-contract failure: authoritative ${relativePath} handoff declares unexpected contract ${JSON.stringify(candidate.output.contract)}; expected ${JSON.stringify(contract)}`
    );
  }
  // Re-check the runtime-owned marker and every published digest after the
  // model returns, immediately before consuming this ancestor as authority.
  assertVerifiedDependency(task, candidate.dependency);
  const dependencyRoot = realpathSync(candidate.dependency);
  const artifactPath = resolveRegularArtifactFile(
    dependencyRoot,
    path.resolve(dependencyRoot, relativePath),
    `artifact-contract failure: verified dependency artifact is missing ${relativePath}`
  );
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(artifactPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`artifact-contract failure: authoritative ${relativePath} handoff is malformed`, { cause: error });
  }
  return { path: artifactPath, value };
}

function configuredInvariantPrioritySelection(task: (typeof taskSpecs)[number]): {
  path: string;
  selection?: { priority_threshold: "high" | "medium" | "low"; priorities: ("high" | "medium" | "low")[] };
} {
  const runRoot = realpathSync(path.resolve(process.cwd(), task.runRoot));
  const configPath = path.join(runRoot, "config.resolved.toml");
  let resolvedConfig: string;
  try {
    resolvedConfig = resolveRegularArtifactFile(
      runRoot,
      configPath,
      "artifact-contract failure: resolved invariant priority configuration is unavailable"
    );
  } catch {
    return { path: configPath };
  }
  const contents = readFileSync(resolvedConfig, "utf8");
  const match = /^\s*property_priority_threshold\s*=\s*["'](high|medium|low)["']\s*$/mu.exec(contents);
  if (match === null) {
    return { path: resolvedConfig };
  }
  const priority_threshold = match[1] as "high" | "medium" | "low";
  const order = ["high", "medium", "low"] as const;
  return {
    path: resolvedConfig,
    selection: {
      priority_threshold,
      priorities: order.slice(0, order.indexOf(priority_threshold) + 1)
    }
  };
}

function replaceReportImplementationCoverage(contents: string, coverage: unknown): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    return undefined;
  }
  if (!isPlainRecord(parsed)) {
    return undefined;
  }
  const report = { ...parsed };
  delete report.property_implementation_coverage;
  return `${JSON.stringify({ ...report, property_implementation_coverage: coverage }, null, 2)}\n`;
}

function normalizeLegacyReportProvenance(task: (typeof taskSpecs)[number]): void {
  const artifactDir = realpathSync(task.metadata.artifacts.dir);
  const artifactRoots = taskArtifactRoots(task, artifactDir);
  const sourceExpectations =
    task.metadata.node.logicalNodeId === "final-report"
      ? dependencyFindingProvenance(task, artifactDir).expectations
      : undefined;

  for (const output of task.outputs) {
    if (output.contract !== "ultrafuzz/report@1") {
      continue;
    }
    for (const candidateRoot of artifactRoots) {
      let resolvedPath: string;
      try {
        resolvedPath = resolveRegularArtifactFile(
          candidateRoot,
          path.resolve(candidateRoot, output.path),
          `artifact-contract failure: output is not a regular file ${output.path}`
        );
      } catch {
        continue;
      }
      const contents = readFileSync(resolvedPath, "utf8");
      const originalIsValid = validateArtifactContract(output.contract, contents, output.path).ok;
      const normalized = normalizeLegacyReportProvenanceFields(contents, sourceExpectations);
      if (normalized !== undefined && validateArtifactContract(output.contract, normalized, output.path).ok) {
        writeFileSync(resolvedPath, normalized, { encoding: "utf8", flag: "w", mode: 0o600 });
        break;
      }
      if (originalIsValid) {
        break;
      }
    }
  }
}

function normalizeLegacyReportProvenanceFields(
  contents: string,
  sourceExpectations?: ReadonlyArray<{ finding_keys: readonly string[]; source_nodes: readonly string[] }>
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const report = parsed as { issues?: unknown; non_production_outcomes?: unknown; property_provenance?: unknown };

  let changed = false;
  const issues = Array.isArray(report.issues)
    ? report.issues.map((entry) => {
        const normalized = normalizeLegacyFindingRecord(entry);
        const severity = normalizeFinalReportSeverityRecord(normalized.value);
        const provenance = normalizeReportFindingSourceNodes(severity.value, sourceExpectations);
        changed ||= normalized.changed || severity.changed || provenance.changed;
        return provenance.value;
      })
    : report.issues;
  const nonProductionOutcomes = Array.isArray(report.non_production_outcomes)
    ? report.non_production_outcomes.map((entry) => {
        const normalized = normalizeLegacyFindingRecord(entry);
        const provenance = normalizeReportFindingSourceNodes(normalized.value, sourceExpectations);
        changed ||= normalized.changed || provenance.changed;
        return provenance.value;
      })
    : report.non_production_outcomes;
  const propertyProvenance = Array.isArray(report.property_provenance)
    ? report.property_provenance.map((entry) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          return entry;
        }
        const provenance = { ...entry } as Record<string, unknown>;
        for (const field of ["implementation_paths", "test_paths"] as const) {
          if (provenance[field] === "unavailable") {
            provenance[field] = [];
            changed = true;
          }
        }
        for (const field of ["fuzzer_backend", "fuzzer_backends"] as const) {
          if (provenance[field] === "unavailable") {
            delete provenance[field];
            changed = true;
          }
        }
        return provenance;
      })
    : report.property_provenance;

  return changed
    ? `${JSON.stringify(
        {
          ...report,
          ...(issues === undefined ? {} : { issues }),
          ...(nonProductionOutcomes === undefined ? {} : { non_production_outcomes: nonProductionOutcomes }),
          ...(propertyProvenance === undefined ? {} : { property_provenance: propertyProvenance })
        },
        null,
        2
      )}\n`
    : undefined;
}

function normalizeReportFindingSourceNodes(
  value: unknown,
  expectations: ReadonlyArray<{ finding_keys: readonly string[]; source_nodes: readonly string[] }> | undefined
): { value: unknown; changed: boolean } {
  if (expectations === undefined || !isPlainRecord(value)) return { value, changed: false };
  const keys = new Set(findingIdentityKeys(value));
  const matched = expectations.filter((expectation) => expectation.finding_keys.some((key) => keys.has(key)));
  if (matched.length === 0)
    throw new Error("artifact-contract failure: report finding does not match dependency provenance");
  const sourceNodes = uniqueStrings(matched.flatMap((expectation) => expectation.source_nodes));
  if (sourceNodes.length === 0)
    throw new Error("artifact-contract failure: report finding has no dependency discovery provenance");
  const current = Array.isArray(value.source_nodes)
    ? value.source_nodes
    : typeof value.source_node_id === "string"
      ? [value.source_node_id]
      : [];
  const changed =
    current.length !== sourceNodes.length ||
    current.some((sourceNode, index) => sourceNode !== sourceNodes[index]) ||
    value.source_node_id !== sourceNodes[0];
  return { value: { ...value, source_nodes: sourceNodes, source_node_id: sourceNodes[0] }, changed };
}

function normalizeLegacyGeneratedTestManifests(task: (typeof taskSpecs)[number]): void {
  const artifactDir = realpathSync(task.metadata.artifacts.dir);
  const artifactRoots = taskArtifactRoots(task, artifactDir);

  for (const output of task.outputs) {
    if (output.contract !== "ultrafuzz/generated-tests@1") {
      continue;
    }
    for (const candidateRoot of artifactRoots) {
      let resolvedPath: string;
      try {
        resolvedPath = resolveRegularArtifactFile(
          candidateRoot,
          path.resolve(candidateRoot, output.path),
          `artifact-contract failure: output is not a regular file ${output.path}`
        );
      } catch {
        continue;
      }
      const contents = readFileSync(resolvedPath, "utf8");
      if (validateArtifactContract(output.contract, contents, output.path).ok) {
        break;
      }
      const normalized = normalizeLegacyGeneratedTestManifest(contents);
      if (normalized !== undefined && validateArtifactContract(output.contract, normalized, output.path).ok) {
        writeFileSync(resolvedPath, normalized, { encoding: "utf8", flag: "w", mode: 0o600 });
        break;
      }
    }
  }
}

function normalizeLegacyGeneratedTestManifest(contents: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const manifest = parsed as { generated_tests?: unknown };
  if (
    !Array.isArray(manifest.generated_tests) ||
    !manifest.generated_tests.some((entry) => typeof entry === "string") ||
    !manifest.generated_tests.every(
      (entry) => typeof entry === "string" || (typeof entry === "object" && entry !== null && !Array.isArray(entry))
    )
  ) {
    return undefined;
  }
  return `${JSON.stringify(
    {
      ...manifest,
      generated_tests: manifest.generated_tests.map((entry) => (typeof entry === "string" ? { path: entry } : entry))
    },
    null,
    2
  )}\n`;
}

function materializeGeneratedTestCompanions(task: (typeof taskSpecs)[number]): void {
  const artifactDir = realpathSync(task.metadata.artifacts.dir);
  const artifactRoots = taskArtifactRoots(task, artifactDir);
  const workspaceRoot = realpathSync(task.workspacePath);

  for (const output of task.outputs) {
    if (output.contract !== "ultrafuzz/generated-tests@1") {
      continue;
    }
    for (const candidateRoot of artifactRoots) {
      let resolvedManifestPath: string;
      try {
        resolvedManifestPath = resolveRegularArtifactFile(
          candidateRoot,
          path.resolve(candidateRoot, output.path),
          `artifact-contract failure: output is not a regular file ${output.path}`
        );
      } catch {
        continue;
      }
      const validation = validateArtifactContract(
        output.contract,
        readFileSync(resolvedManifestPath, "utf8"),
        output.path
      );
      if (!validation.ok) {
        continue;
      }
      const entries = (validation.value as { generated_tests?: Array<{ path?: string }> }).generated_tests ?? [];
      for (const entry of entries) {
        materializeGeneratedTestCompanion(workspaceRoot, candidateRoot, generatedTestNodeIds(task), entry.path ?? "");
      }
      break;
    }
  }
}

/**
 * Directory names an agent may have used for its generated tests, most
 * authoritative first.
 *
 * `strategy_attempt_test_dir` (`packages/prompts/src/render.ts`) mandates
 * `<workspace>/test/foundry/<LOGICAL node id>/`, and the retry reset below
 * clears that same logical directory. Only this lookup used the CONCRETE node
 * id, so on any node the topology expands (`loops > 1`, model fan-out) the one
 * directory the prompt named was never searched and an obedient agent's test
 * failed the contract as missing. Both ids are accepted: the logical id is what
 * the prompt promises, and the concrete id stays valid for a run that used it.
 */
function generatedTestNodeIds(task: (typeof taskSpecs)[number]): string[] {
  return [...new Set([task.metadata.node.logicalNodeId, task.metadata.node.concreteNodeId])];
}

function materializeGeneratedTestCompanion(
  workspaceRoot: string,
  artifactRoot: string,
  nodeIds: readonly string[],
  relativePath: string
): void {
  const generatedPrefix = "generated-tests/";
  if (!relativePath.startsWith(generatedPrefix) || relativePath.length === generatedPrefix.length) {
    throw new Error(`artifact-contract failure: unsafe generated test path ${relativePath}`);
  }
  const artifactPath = path.resolve(artifactRoot, relativePath);
  if (!isStrictlyInsideDirectory(artifactRoot, artifactPath)) {
    throw new Error(`artifact-contract failure: unsafe generated test path ${relativePath}`);
  }
  if (existsSync(artifactPath)) {
    resolveNonEmptyRegularArtifactFile(
      artifactRoot,
      artifactPath,
      `artifact-contract failure: generated test file is missing ${relativePath}`,
      `artifact-contract failure: generated test file is empty ${relativePath}`
    );
    return;
  }

  const workspaceRelativePath = relativePath.slice(generatedPrefix.length);
  const sourceCandidates = [
    ...new Set(
      INVARIANT_TEST_ROOT_NAMES.flatMap((testRoot) => [
        path.resolve(workspaceRoot, testRoot, "foundry", workspaceRelativePath),
        ...nodeIds.map((nodeId) => path.resolve(workspaceRoot, testRoot, "foundry", nodeId, workspaceRelativePath))
      ])
    )
  ];
  const existingCandidates = sourceCandidates.filter((candidate) => existsSync(candidate));
  const sourceCandidate = existingCandidates[0] ?? sourceCandidates[0];
  if (existingCandidates.length > 1) {
    const first = readFileSync(
      resolveNonEmptyRegularArtifactFile(
        workspaceRoot,
        existingCandidates[0],
        `artifact-contract failure: generated test file is missing ${relativePath}`,
        `artifact-contract failure: generated test file is empty ${relativePath}`
      )
    );
    for (const candidate of existingCandidates.slice(1)) {
      const bytes = readFileSync(
        resolveNonEmptyRegularArtifactFile(
          workspaceRoot,
          candidate,
          `artifact-contract failure: generated test file is missing ${relativePath}`,
          `artifact-contract failure: generated test file is empty ${relativePath}`
        )
      );
      if (!bytes.equals(first)) {
        throw new Error(`artifact-contract failure: generated test sources conflict ${relativePath}`);
      }
    }
  }
  if (!isStrictlyInsideDirectory(workspaceRoot, sourceCandidate)) {
    throw new Error(`artifact-contract failure: unsafe generated test source ${relativePath}`);
  }
  const missingSource = `artifact-contract failure: generated test file is missing ${relativePath}`;
  const emptySource = `artifact-contract failure: generated test file is empty ${relativePath}`;
  const sourcePath = resolveNonEmptyRegularArtifactFile(workspaceRoot, sourceCandidate, missingSource, emptySource);
  const sourceBefore = statSync(sourcePath);
  if (sourceBefore.nlink !== 1) {
    throw new Error(`artifact-contract failure: generated test source is hard-linked ${relativePath}`);
  }
  const contents = readFileSync(sourcePath);
  const sourcePathAfter = resolveNonEmptyRegularArtifactFile(
    workspaceRoot,
    sourceCandidate,
    missingSource,
    emptySource
  );
  const sourceAfter = statSync(sourcePathAfter);
  if (
    sourcePathAfter !== sourcePath ||
    sourceBefore.dev !== sourceAfter.dev ||
    sourceBefore.ino !== sourceAfter.ino ||
    sourceBefore.size !== sourceAfter.size ||
    sourceBefore.mtimeMs !== sourceAfter.mtimeMs ||
    sourceAfter.nlink !== 1
  ) {
    throw new Error(`artifact-contract failure: generated test source changed ${relativePath}`);
  }

  const artifactParent = path.dirname(artifactPath);
  mkdirSync(artifactParent, { recursive: true });
  const resolvedParent = realpathSync(artifactParent);
  if (!isStrictlyInsideDirectory(artifactRoot, resolvedParent)) {
    throw new Error(`artifact-contract failure: unsafe generated test parent ${relativePath}`);
  }
  const anchoredArtifactPath = path.join(resolvedParent, path.basename(artifactPath));
  writeFileSync(anchoredArtifactPath, contents, { flag: "wx", mode: 0o600 });
  const resolvedArtifactPath = resolveNonEmptyRegularArtifactFile(
    artifactRoot,
    anchoredArtifactPath,
    `artifact-contract failure: generated test file is missing ${relativePath}`,
    `artifact-contract failure: generated test file is empty ${relativePath}`
  );
  if (
    createHash("sha256").update(readFileSync(resolvedArtifactPath)).digest("hex") !==
    createHash("sha256").update(contents).digest("hex")
  ) {
    throw new Error(`artifact-contract failure: generated test copy mismatch ${relativePath}`);
  }
}

/**
 * Preserve the complete invariant suite across task worktrees. Every
 * invariant stage deliberately uses a separate worktree, so dependency
 * artifact directories are the only durable handoff boundary. The old
 * handoff copied Markdown/JSON but left generated CryticTester, Setup,
 * TargetFunctions, and Properties sources behind; downstream stages then ran
 * the pinned repository without the selected harness.
 */
function materializeInvariantSuiteCompanions(task: (typeof taskSpecs)[number]): void {
  if (!invariantSuiteNodeIds.has(task.metadata.node.logicalNodeId)) {
    return;
  }
  const implementationOutput = task.outputs.find(
    (output) =>
      output.path === "implemented-properties.json" &&
      (output.contract === "ultrafuzz/implemented-properties@1" ||
        output.contract === "ultrafuzz/implemented-properties@2")
  );
  const artifactDir = realpathSync(task.metadata.artifacts.dir);
  const artifactRoots = taskArtifactRoots(task, artifactDir);
  const paths = new Set<string>();
  if (implementationOutput !== undefined) {
    for (const root of artifactRoots) {
      let implementationPath: string;
      try {
        implementationPath = resolveRegularArtifactFile(
          root,
          path.resolve(root, implementationOutput.path),
          "artifact-contract failure: implemented property records are not a regular file"
        );
      } catch {
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(implementationPath, "utf8")) as unknown;
      } catch {
        // Leave malformed task output for verifyArtifacts, which reports the
        // typed artifact-contract failure instead of leaking SyntaxError from
        // this companion-preservation compatibility path.
        continue;
      }
      const parsed = validateImplementedPropertiesSchema(raw, implementationPath);
      if (!parsed.ok || parsed.value === undefined) {
        continue;
      }
      for (const record of parsed.value.properties) {
        if (record.status !== "implemented") continue;
        for (const relativePath of record.implementation_paths) {
          paths.add(assertSafeInvariantSuitePath(relativePath));
        }
        for (const relativePath of record.test_paths) {
          paths.add(assertSafeInvariantSuiteTestPath(relativePath));
        }
      }
    }
  }

  // Capture every changed test-tree source as well.  Harness files such as
  // CryticTester.sol and TargetFunctions.sol are often shared by several
  // properties and therefore are not repeated in each record's path arrays.
  for (const relativePath of changedTestTreePaths(
    realpathSync(task.workspacePath),
    path.join(realpathSync(task.metadata.artifacts.dir), INVARIANT_SUITE_BASELINE_FILE),
    invariantSuiteProtectedBaselinePath(task)
  )) {
    paths.add(relativePath);
  }
  for (const relativePath of changedInvariantSourcePaths(realpathSync(task.workspacePath))) {
    paths.add(relativePath);
  }
  // The budget covers the ASSEMBLED publication -- the inherited ancestor union
  // plus this stage's own paths -- because every entry of it is written to each
  // artifact root below. Budgeting `paths` alone let the union reach roughly
  // twice the limit on disk before verifyArtifacts rejected the manifest.
  let totalBytes = 0;
  const publicationSnapshot = new Map<string, Buffer>();
  const tombstones = invariantSuiteTombstones.get(realpathSync(task.workspacePath)) ?? new Set<string>();
  const selectedDependencies = resolveInvariantSuiteDependencySnapshot(task);
  for (const [relativePath, entry] of selectedDependencies) {
    if (tombstones.has(relativePath)) continue;
    publicationSnapshot.set(relativePath, Buffer.from(entry.bytes));
    totalBytes += entry.bytes.length;
    assertInvariantSuiteSourceBudget(publicationSnapshot.size, totalBytes);
  }
  for (const relativePath of paths) {
    const sourcePath = path.resolve(task.workspacePath, relativePath);
    const source = resolveNonEmptyRegularArtifactFile(
      realpathSync(task.workspacePath),
      sourcePath,
      `artifact-contract failure: invariant suite source is missing ${relativePath}`,
      `artifact-contract failure: invariant suite source is empty ${relativePath}`
    );
    const sourceStat = statSync(source);
    assertInvariantSuiteSourceSize(relativePath, sourceStat.size);
    const sourceBytes = readFileSync(source);
    if (sourceBytes.length !== sourceStat.size) {
      throw new Error(`artifact-contract failure: invariant suite source changed ${relativePath}`);
    }
    // A path this stage republishes REPLACES the inherited copy rather than
    // adding to it, so the superseded bytes leave the running total.
    totalBytes += sourceBytes.length - (publicationSnapshot.get(relativePath)?.length ?? 0);
    publicationSnapshot.set(relativePath, sourceBytes);
    assertInvariantSuiteSourceBudget(publicationSnapshot.size, totalBytes);
  }
  invariantSuitePublicationSnapshots.set(task.attemptId, publicationSnapshot);
  const manifestFiles = [...publicationSnapshot]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, contents]) => ({
      path: relativePath,
      size_bytes: contents.length,
      sha256: createHash("sha256").update(contents).digest("hex")
    }));
  // Publish the deletion channel alongside the surviving files. Tombstones
  // accumulate down the chain and a path this stage still publishes clears its
  // own tombstone, so a deleted-then-re-added source is not suppressed.
  const manifestTombstones = [...new Set([...resolveInheritedInvariantSuiteTombstones(task), ...tombstones])]
    .filter((relativePath) => !publicationSnapshot.has(relativePath))
    .sort();
  assertInvariantSuiteTombstoneBudget(manifestTombstones.length, task.attemptId);
  for (const artifactRoot of artifactRoots) {
    resetInvariantSuiteArtifactRoot(artifactRoot);
    copyDependencyInvariantSuiteToArtifact(task, artifactRoot);
    for (const relativePath of paths) {
      copyInvariantSuiteSource(realpathSync(task.workspacePath), artifactRoot, relativePath, true);
    }
    writeFileDurable(
      path.join(artifactRoot, INVARIANT_SUITE_MANIFEST_FILE),
      `${JSON.stringify({
        schema_version: "ultrafuzz.invariant-suite-manifest.v1",
        producer_node_id: task.metadata.node.logicalNodeId,
        producer_attempt_id: task.attemptId,
        files: manifestFiles,
        tombstones: manifestTombstones
      })}\n`
    );
  }
}

function resetInvariantSuiteArtifactRoot(artifactRoot: string): void {
  const suiteRoot = path.join(artifactRoot, "invariant-suite");
  if (!existsSync(suiteRoot)) return;
  const stat = lstatSync(suiteRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(suiteRoot) !== suiteRoot) {
    throw new Error("artifact-contract failure: invariant suite artifact root is unsafe");
  }
  rmSync(suiteRoot, { recursive: true, force: true });
  mkdirSync(suiteRoot, { recursive: true, mode: 0o700 });
}

function invariantSuiteProducerTask(dependencyArtifactDir: string): (typeof taskSpecs)[number] | undefined {
  const attemptId = path.basename(dependencyArtifactDir);
  const producer = taskSpecs.find((candidate) => candidate.attemptId === attemptId);
  if (producer === undefined || !invariantSuiteNodeIds.has(producer.metadata.node.logicalNodeId)) return undefined;
  return producer;
}

function assertInvariantSuiteTombstoneBudget(count: number, label: string): void {
  if (count > MAX_INVARIANT_SUITE_FILES) {
    throw new Error(`artifact-contract failure: invariant suite tombstones exceed their budget ${label}`);
  }
}

/**
 * Parse a published invariant-suite manifest into its file digests and its
 * deletion channel. `tombstones` is an additive v1 field: a manifest published
 * before deletions were represented simply carries no deletion channel and is
 * read as an empty set.
 */
function parseInvariantSuiteManifestRecord(
  manifestBytes: Buffer,
  manifestPath: string
): {
  producerNodeId: string;
  producerAttemptId: string;
  files: Map<string, { sha256: string; sizeBytes: number }>;
  tombstones: Set<string>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestBytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`artifact-contract failure: invariant suite manifest is malformed ${manifestPath}`, {
      cause: error
    });
  }
  if (
    !isPlainRecord(parsed) ||
    parsed.schema_version !== "ultrafuzz.invariant-suite-manifest.v1" ||
    typeof parsed.producer_node_id !== "string" ||
    typeof parsed.producer_attempt_id !== "string" ||
    !Array.isArray(parsed.files)
  ) {
    throw new Error(`artifact-contract failure: invariant suite manifest is invalid ${manifestPath}`);
  }
  const files = new Map<string, { sha256: string; sizeBytes: number }>();
  for (const file of parsed.files) {
    if (
      !isPlainRecord(file) ||
      typeof file.path !== "string" ||
      typeof file.size_bytes !== "number" ||
      !Number.isSafeInteger(file.size_bytes) ||
      file.size_bytes < 1 ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(file.sha256)
    ) {
      throw new Error(`artifact-contract failure: invariant suite manifest file entry is invalid ${manifestPath}`);
    }
    const relativePath = assertSafeInvariantSuitePath(file.path);
    assertInvariantSuiteSourceSize(relativePath, file.size_bytes);
    if (files.has(relativePath)) {
      throw new Error(`artifact-contract failure: duplicate invariant suite manifest file ${relativePath}`);
    }
    files.set(relativePath, { sha256: file.sha256, sizeBytes: file.size_bytes });
  }
  const tombstones = new Set<string>();
  if (parsed.tombstones !== undefined) {
    if (!Array.isArray(parsed.tombstones)) {
      throw new Error(`artifact-contract failure: invariant suite manifest tombstones are invalid ${manifestPath}`);
    }
    for (const entry of parsed.tombstones) {
      if (typeof entry !== "string") {
        throw new Error(`artifact-contract failure: invariant suite manifest tombstones are invalid ${manifestPath}`);
      }
      tombstones.add(assertSafeInvariantSuitePath(entry));
    }
    assertInvariantSuiteTombstoneBudget(tombstones.size, manifestPath);
  }
  return {
    producerNodeId: parsed.producer_node_id,
    producerAttemptId: parsed.producer_attempt_id,
    files,
    tombstones
  };
}

function readInvariantSuiteManifestRecord(artifactRoot: string):
  | {
      producerNodeId: string;
      producerAttemptId: string;
      files: Map<string, { sha256: string; sizeBytes: number }>;
      tombstones: Set<string>;
    }
  | undefined {
  const manifestPath = path.join(artifactRoot, INVARIANT_SUITE_MANIFEST_FILE);
  if (!existsSync(manifestPath)) return undefined;
  const resolvedManifest = resolveNonEmptyRegularArtifactFile(
    artifactRoot,
    manifestPath,
    `artifact-contract failure: invariant suite manifest is missing ${manifestPath}`,
    `artifact-contract failure: invariant suite manifest is empty ${manifestPath}`
  );
  return parseInvariantSuiteManifestRecord(readFileSync(resolvedManifest), manifestPath);
}

/**
 * Rebuild the deletion channel a stage inherits from its declared predecessors.
 * `dependencyArtifactDirs` is the full transitive ancestor closure, so a source
 * an earlier invariant stage deleted still exists in an indirect ancestor's
 * artifact and would otherwise be re-selected and re-copied into every
 * descendant workspace, including the campaign workspace Recon fuzzes.
 *
 * A predecessor that still carries the path outranks the tombstone, so a source
 * that was deleted and later re-added stays alive.
 */
function inheritedInvariantSuiteTombstones(task: (typeof taskSpecs)[number]): Set<string> {
  const directDependencies = new Set(task.metadata.dependencies.attemptIds);
  const tombstones = new Set<string>();
  const present = new Set<string>();
  for (const dependency of task.dependencyArtifactDirs) {
    const dependencyAttemptId = path.basename(dependency);
    if (!directDependencies.has(dependency) && !directDependencies.has(dependencyAttemptId)) continue;
    const producer = invariantSuiteProducerTask(dependency);
    if (producer === undefined) continue;
    let dependencyRoot: string;
    try {
      dependencyRoot = realpathSync(dependency);
    } catch {
      continue;
    }
    const manifest = readInvariantSuiteManifestRecord(dependencyRoot);
    if (
      manifest === undefined ||
      manifest.producerAttemptId !== dependencyAttemptId ||
      manifest.producerNodeId !== producer.metadata.node.logicalNodeId
    ) {
      continue;
    }
    for (const relativePath of manifest.tombstones) tombstones.add(relativePath);
    for (const relativePath of manifest.files.keys()) present.add(relativePath);
  }
  for (const relativePath of present) tombstones.delete(relativePath);
  assertInvariantSuiteTombstoneBudget(tombstones.size, task.attemptId);
  return tombstones;
}

function invariantSuiteHandoffRoot(task: (typeof taskSpecs)[number]): string {
  return invariantSuiteAttemptStateRoot(task, INVARIANT_SUITE_HANDOFF_DIR);
}

/**
 * Path of the durable handoff record, computed without touching the
 * filesystem. Diagnostics must be able to name the record even when the run
 * state directory itself is in an unexpected state, which is exactly when
 * `invariantSuiteHandoffRoot` would throw a different, less useful error.
 */
function invariantSuiteHandoffRecordPath(task: (typeof taskSpecs)[number]): string {
  return path.join(
    path.resolve(process.cwd(), task.runRoot),
    INVARIANT_SUITE_HANDOFF_DIR,
    task.attemptId,
    INVARIANT_SUITE_HANDOFF_FILE
  );
}

/**
 * Fingerprint every ancestor artifact this stage may select from, by the digest
 * of its published invariant-suite manifest. The handoff record binds itself to
 * these, so a legitimately re-executed ancestor (operator `retry-task`,
 * `timetravel`, or a new Modal execution generation republishing the directory)
 * is recognisable as "this record describes a superseded handoff" rather than
 * as tampering. Without this the record could never go stale, and a `retries=0`
 * preparation node would fail closed forever on a recovery flow.
 */
function invariantSuiteDependencyFingerprints(
  task: (typeof taskSpecs)[number]
): Array<{ attempt_id: string; manifest_sha256: string | null }> {
  const fingerprints: Array<{ attempt_id: string; manifest_sha256: string | null }> = [];
  for (const dependency of task.dependencyArtifactDirs) {
    if (invariantSuiteProducerTask(dependency) === undefined) continue;
    let digest: string | null = null;
    try {
      const dependencyRoot = realpathSync(dependency);
      const manifestPath = path.join(dependencyRoot, INVARIANT_SUITE_MANIFEST_FILE);
      if (existsSync(manifestPath)) {
        digest = createHash("sha256")
          .update(
            readFileSync(
              resolveRegularArtifactFile(
                dependencyRoot,
                manifestPath,
                "artifact-contract failure: invariant suite manifest is not a regular file"
              )
            )
          )
          .digest("hex");
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("artifact-contract failure:")) throw error;
      digest = null;
    }
    fingerprints.push({ attempt_id: path.basename(dependency), manifest_sha256: digest });
  }
  return fingerprints.sort((left, right) => left.attempt_id.localeCompare(right.attempt_id));
}

function invariantSuiteFingerprintKey(
  fingerprints: readonly { attempt_id: string; manifest_sha256: string | null }[]
): string {
  return fingerprints.map((entry) => `${entry.attempt_id}:${entry.manifest_sha256 ?? "-"}`).join("\n");
}

/**
 * Record the exact dependency handoff this attempt materialized under durable
 * run state, so recovery never has to re-derive it from the mutable dependency
 * artifact directories.
 */
function writeInvariantSuiteDependencyHandoff(
  task: (typeof taskSpecs)[number],
  selected: ReadonlyMap<string, { dependency: string; bytes: Buffer; direct: boolean }>,
  tombstones: ReadonlySet<string>
): void {
  const dependencies = [...selected]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, entry]) => ({
      path: relativePath,
      attempt_id: path.basename(entry.dependency),
      size: entry.bytes.length,
      sha256: createHash("sha256").update(entry.bytes).digest("hex"),
      direct: entry.direct
    }));
  assertInvariantSuiteTombstoneBudget(tombstones.size, task.attemptId);
  writeFileDurable(
    path.join(invariantSuiteHandoffRoot(task), INVARIANT_SUITE_HANDOFF_FILE),
    `${JSON.stringify(
      {
        schema_version: INVARIANT_SUITE_HANDOFF_SCHEMA_VERSION,
        producer_node_id: task.metadata.node.logicalNodeId,
        producer_attempt_id: task.attemptId,
        producers: invariantSuiteDependencyFingerprints(task),
        dependencies,
        tombstones: [...tombstones].sort()
      },
      null,
      2
    )}\n`
  );
}

/**
 * Rebuild the dependency handoff from durable run state and re-verify it
 * against the current ancestor artifacts. Recovery must not depend on a
 * module-level Map: after a controller restart the in-process selection is
 * gone, and re-deriving a fresh selection would copy ancestor bytes over the
 * harness this attempt already authored.
 *
 * A record whose ancestor fingerprints no longer match describes a superseded
 * handoff: an ancestor was legitimately re-executed and republished, so the
 * record is discarded and the caller re-derives. Only a record whose ancestors
 * are byte-identical yet whose recorded suite bytes are not fails closed, which
 * is the actual tampering case.
 */
function loadInvariantSuiteDependencyHandoff(task: (typeof taskSpecs)[number]):
  | {
      selected: Map<string, { dependency: string; bytes: Buffer; direct: boolean }>;
      tombstones: Set<string>;
    }
  | undefined {
  const handoffRoot = invariantSuiteHandoffRoot(task);
  const handoffPath = path.join(handoffRoot, INVARIANT_SUITE_HANDOFF_FILE);
  if (!existsSync(handoffPath)) return undefined;
  const resolvedHandoff = resolveNonEmptyRegularArtifactFile(
    handoffRoot,
    handoffPath,
    `artifact-contract failure: invariant suite handoff record is missing ${handoffPath}`,
    `artifact-contract failure: invariant suite handoff record is empty ${handoffPath}`
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolvedHandoff, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`artifact-contract failure: invariant suite handoff record is malformed ${handoffPath}`, {
      cause: error
    });
  }
  if (
    !isPlainRecord(parsed) ||
    parsed.schema_version !== INVARIANT_SUITE_HANDOFF_SCHEMA_VERSION ||
    parsed.producer_node_id !== task.metadata.node.logicalNodeId ||
    parsed.producer_attempt_id !== task.attemptId ||
    !Array.isArray(parsed.dependencies) ||
    !Array.isArray(parsed.tombstones)
  ) {
    throw new Error(`artifact-contract failure: invariant suite handoff record is invalid ${handoffPath}`);
  }
  // A record that predates the ancestor fingerprint, or whose ancestors have
  // since republished, describes a handoff that no longer exists. Discard it
  // and let the caller re-derive rather than failing a retries=0 node closed on
  // a legitimate recovery flow.
  const recordedProducers: Array<{ attempt_id: string; manifest_sha256: string | null }> = [];
  if (!Array.isArray(parsed.producers)) return undefined;
  for (const entry of parsed.producers) {
    if (
      !isPlainRecord(entry) ||
      typeof entry.attempt_id !== "string" ||
      (entry.manifest_sha256 !== null &&
        (typeof entry.manifest_sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(entry.manifest_sha256)))
    ) {
      throw new Error(`artifact-contract failure: invariant suite handoff producer entry is invalid ${handoffPath}`);
    }
    recordedProducers.push({ attempt_id: entry.attempt_id, manifest_sha256: entry.manifest_sha256 });
  }
  if (
    invariantSuiteFingerprintKey(recordedProducers) !==
    invariantSuiteFingerprintKey(invariantSuiteDependencyFingerprints(task))
  ) {
    return undefined;
  }
  const dependencyRoots = new Map<string, string>(
    [...task.dependencyArtifactDirs].map((dependency) => [path.basename(dependency), dependency])
  );
  const selected = new Map<string, { dependency: string; bytes: Buffer; direct: boolean }>();
  let selectedBytes = 0;
  for (const entry of parsed.dependencies) {
    if (
      !isPlainRecord(entry) ||
      typeof entry.path !== "string" ||
      typeof entry.attempt_id !== "string" ||
      typeof entry.size !== "number" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 1 ||
      typeof entry.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(entry.sha256) ||
      typeof entry.direct !== "boolean"
    ) {
      throw new Error(`artifact-contract failure: invariant suite handoff entry is invalid ${handoffPath}`);
    }
    const relativePath = assertSafeInvariantSuitePath(entry.path);
    assertInvariantSuiteSourceSize(relativePath, entry.size);
    if (selected.has(relativePath)) {
      throw new Error(`artifact-contract failure: duplicate invariant suite handoff path ${relativePath}`);
    }
    const dependency = dependencyRoots.get(entry.attempt_id);
    if (dependency === undefined) {
      throw new Error(`artifact-contract failure: invariant suite handoff producer is unavailable ${entry.attempt_id}`);
    }
    const bytes = readInvariantSuiteSourceBytes(
      path.join(realpathSync(dependency), "invariant-suite"),
      relativePath,
      "artifact handoff invariant suite"
    );
    if (bytes.length !== entry.size || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
      throw new Error(`artifact-contract failure: invariant suite dependency changed ${relativePath}`);
    }
    selectedBytes += bytes.length;
    selected.set(relativePath, { dependency, bytes, direct: entry.direct });
    assertInvariantSuiteSourceBudget(selected.size, selectedBytes);
  }
  const tombstones = new Set<string>();
  for (const entry of parsed.tombstones) {
    if (typeof entry !== "string") {
      throw new Error(`artifact-contract failure: invariant suite handoff record is invalid ${handoffPath}`);
    }
    tombstones.add(assertSafeInvariantSuitePath(entry));
  }
  assertInvariantSuiteTombstoneBudget(tombstones.size, handoffPath);
  invariantSuiteDependencySnapshots.set(task.attemptId, selected);
  return { selected, tombstones };
}

/**
 * Resolve the dependency handoff this attempt is publishing against, preferring
 * in-process state and falling back to the durable record. An empty selection
 * is a legitimate outcome (the first invariant stage has no suite ancestor), so
 * only a genuinely absent record is an error, and it names the missing file.
 */
function resolveInvariantSuiteDependencySnapshot(
  task: (typeof taskSpecs)[number]
): Map<string, { dependency: string; bytes: Buffer; direct: boolean }> {
  const selected =
    invariantSuiteDependencySnapshots.get(task.attemptId) ?? loadInvariantSuiteDependencyHandoff(task)?.selected;
  if (selected === undefined) {
    throw new Error(
      `artifact-contract failure: invariant suite dependency handoff record is unavailable ${invariantSuiteHandoffRecordPath(
        task
      )}`
    );
  }
  return selected;
}

/**
 * Resolve the deletion channel this stage inherits, preferring the durable
 * handoff record. The record is the statement of what was actually suppressed
 * when the handoff was materialized; recomputing from the ancestor manifests is
 * the fallback for an absent or superseded record, where re-derivation is the
 * correct answer anyway.
 */
function resolveInheritedInvariantSuiteTombstones(task: (typeof taskSpecs)[number]): Set<string> {
  return loadInvariantSuiteDependencyHandoff(task)?.tombstones ?? inheritedInvariantSuiteTombstones(task);
}

/**
 * Order the ancestor closure so indirect ancestors are visited before declared
 * dependencies. A declared dependency therefore always wins a byte conflict.
 */
/**
 * Does `later` transitively depend on `earlier`? (issue #315)
 *
 * When two ancestors publish the same invariant-suite source with different bytes, the selection below
 * has to decide whether that is a CONFLICT or a SUPERSESSION, and the answer is a property of the
 * dependency graph, not of anything in the bytes.
 *
 * R50 died on exactly this at `prepare:stateful-invariant-implement-properties`, at 25 succeeded and zero
 * failed, with `tests/recon/Properties.sol` published by both `stateful-invariant-setup` and
 * `stateful-invariant-handlers`. `handlers` depends on `setup`, runs after it, and legitimately rewrites
 * the file. Nothing was in conflict; the newer content simply replaced the older.
 *
 * `orderedInvariantSuiteDependencies` could not express that. It sorts by directness and then
 * ALPHABETICALLY, and `implement-properties` depends directly only on `stateful-invariant-coverage`, so
 * both of these are indirect and the tie-break is `localeCompare` — under which `handlers` sorts BEFORE
 * `setup`, the reverse of causal order. Sort position is not causality.
 *
 * Reachability, not ordering, is deliberately the question asked. Two ancestors that are unordered with
 * respect to each other — parallel siblings publishing different bytes for the same path — are a genuine
 * conflict and must still fail closed. Answering "whichever sorts later wins" would silently drop a
 * sibling's work, which is the exact failure that made the first revision of #314 unmergeable.
 *
 * Terminates on a malformed cyclic graph. The topology validator rejects cycles, so that should be
 * unreachable, but a helper that hangs on bad input converts a validation bug into a run that never fails
 * and never finishes — worse than an error.
 *
 * Two limitations, both measured rather than assumed, neither fixed here:
 *
 *   1. The caller folds over ancestors in sort order, so on a FAN-IN MERGE shape the outcome depends on
 *      node naming. With unordered siblings `L` and `N` plus a merge node `M` that depends on both and
 *      republished the merged file, visiting `M` first resolves cleanly, while visiting `L` then `N`
 *      throws before `M` is ever reached — same graph, same bytes, opposite outcomes decided by
 *      `localeCompare`. The failing direction is fail-closed and identical to the behaviour before this
 *      change, and the shipped invariant topology is a pure chain, so it does not arise today. Making it
 *      order-independent means reducing the publishers of each path to their maximal elements before
 *      comparing, which is a restructure rather than a guard (#317).
 *   2. Attempt ids are stable across re-runs, so a node re-run OUT OF ORDER loses loudness: retrying
 *      `stateful-invariant-setup` after `stateful-invariant-handlers` has already succeeded leaves setup's
 *      content newer in wall-clock time while `supersedes(handlers, setup)` is still true, so the retried
 *      bytes are silently discarded where the old code raised a conflict. That is the deliberate trade —
 *      always throwing is what killed R50 — but it is a real loss and is recorded so it is not rediscovered
 *      as a surprise.
 */
function invariantSuiteAncestorSupersedes(later: string, earlier: string): boolean {
  if (later === earlier) return false;
  const byAttemptId = new Map(taskSpecs.map((candidate) => [candidate.attemptId, candidate]));
  const visited = new Set<string>();
  const pending = [later];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (visited.has(current)) continue;
    visited.add(current);
    for (const dependency of byAttemptId.get(current)?.metadata.dependencies.attemptIds ?? []) {
      if (dependency === earlier) return true;
      pending.push(dependency);
    }
  }
  return false;
}

function orderedInvariantSuiteDependencies(task: (typeof taskSpecs)[number]): string[] {
  const directDependencies = new Set(task.metadata.dependencies.attemptIds);
  return [...task.dependencyArtifactDirs].sort((left, right) => {
    const leftDirect = directDependencies.has(left) || directDependencies.has(path.basename(left));
    const rightDirect = directDependencies.has(right) || directDependencies.has(path.basename(right));
    if (leftDirect !== rightDirect) return leftDirect ? 1 : -1;
    return left.localeCompare(right);
  });
}

/**
 * List the published suite sources of every dependency whose invariant-suite
 * manifest validates against its producer. A dependency with no manifest, or
 * one that does not identify its own producer, contributes nothing.
 *
 * `budget` is shared across every dependency on purpose. A fresh allowance per
 * ancestor bounds one suite at a time, but the caller goes on to retain a buffer
 * for every (ancestor, path) pair, so the retained bytes scaled with the number
 * of ancestors instead of with the limit.
 */
function invariantSuiteDependencySuitePaths(
  dependencies: readonly string[],
  budget: { files: number; totalBytes: number } = { files: 0, totalBytes: 0 }
): Map<string, string[]> {
  const suitePathsByDependency = new Map<string, string[]>();
  for (const dependency of dependencies) {
    const producer = invariantSuiteProducerTask(dependency);
    if (producer === undefined) continue;
    const dependencyAttemptId = path.basename(dependency);
    const dependencyRoot = realpathSync(dependency);
    const suiteRoot = path.join(dependencyRoot, "invariant-suite");
    if (!existsSync(suiteRoot)) continue;
    const manifestPath = path.join(dependencyRoot, INVARIANT_SUITE_MANIFEST_FILE);
    if (!existsSync(manifestPath)) continue;
    let manifest: { schema_version?: unknown; producer_node_id?: unknown; producer_attempt_id?: unknown };
    try {
      manifest = JSON.parse(
        readFileSync(
          resolveRegularArtifactFile(
            dependencyRoot,
            manifestPath,
            "artifact-contract failure: invariant suite manifest is not a regular file"
          ),
          "utf8"
        )
      ) as { schema_version?: unknown; producer_node_id?: unknown; producer_attempt_id?: unknown };
    } catch (error) {
      throw new Error(`artifact-contract failure: invariant suite manifest is malformed ${manifestPath}`, {
        cause: error
      });
    }
    if (
      manifest.schema_version !== "ultrafuzz.invariant-suite-manifest.v1" ||
      typeof manifest.producer_node_id !== "string" ||
      !invariantSuiteNodeIds.has(manifest.producer_node_id) ||
      manifest.producer_attempt_id !== dependencyAttemptId ||
      manifest.producer_node_id !== producer.metadata.node.logicalNodeId
    ) {
      continue;
    }
    suitePathsByDependency.set(dependency, listInvariantSuiteSources(suiteRoot, "", budget));
  }
  return suitePathsByDependency;
}

/**
 * Fail closed when an ancestor claims a property is implemented by a suite
 * source it did not publish. This runs on the recovered path too: a durable
 * handoff record binds the suite bytes, not the ancestors' implemented-property
 * ledgers, so the expectation still has to be re-checked on every preparation.
 */
function assertInvariantSuiteDependencyExpectations(
  task: (typeof taskSpecs)[number],
  dependencies: readonly string[],
  suitePathsByDependency: ReadonlyMap<string, string[]>
): void {
  for (const dependency of dependencies) {
    const dependencyRoot = realpathSync(dependency);
    const implementationCandidate = path.join(dependencyRoot, "implemented-properties.json");
    const expectedPaths = new Set<string>();
    let implementationPath: string | undefined;
    if (existsSync(implementationCandidate)) {
      implementationPath = resolveRegularArtifactFile(
        dependencyRoot,
        implementationCandidate,
        "artifact-contract failure: implemented properties JSON is not a regular file"
      );
    }
    if (implementationPath !== undefined) {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(implementationPath, "utf8")) as unknown;
      } catch {
        throw new Error(`artifact-contract failure: implemented properties JSON is malformed ${implementationPath}`);
      }
      const implementation = validateImplementedPropertiesSchema(raw, implementationPath);
      if (implementation.ok && implementation.value !== undefined) {
        for (const record of implementation.value.properties) {
          if (record.status !== "implemented") continue;
          for (const relativePath of record.implementation_paths) {
            expectedPaths.add(assertSafeInvariantSuitePath(relativePath));
          }
          for (const relativePath of record.test_paths) {
            expectedPaths.add(assertSafeInvariantSuiteTestPath(relativePath));
          }
        }
      }
    }
    const suiteRoot = path.join(dependencyRoot, "invariant-suite");
    if (expectedPaths.size > 0 && !existsSync(suiteRoot)) {
      throw new Error(
        `artifact handoff is missing invariant-suite sources for ${task.metadata.node.logicalNodeId}: ${dependency}`
      );
    }
    if (!existsSync(suiteRoot)) continue;
    const suitePaths = suitePathsByDependency.get(dependency) ?? [];
    for (const relativePath of expectedPaths) {
      if (!suitePaths.includes(relativePath)) {
        throw new Error(`artifact handoff is missing invariant suite source ${relativePath}: ${dependency}`);
      }
    }
  }
}

/**
 * Repopulate a worktree that lost its inherited suite before the durable
 * workspace snapshot existed, which is the only window in which no other
 * durable record can restore it. Gated on the absence of that snapshot and on
 * the absence of each individual path, so the post-agent pass never overwrites
 * a source this attempt authored and never resurrects one it deleted.
 */
function reconcileInvariantSuiteWorkspace(
  task: (typeof taskSpecs)[number],
  workspaceRoot: string,
  selected: ReadonlyMap<string, { dependency: string; bytes: Buffer; direct: boolean }>,
  tombstones: ReadonlySet<string>
): void {
  if ((invariantSuiteWorkspaceSnapshots.get(task.attemptId) ?? loadInvariantSuiteWorkspaceSnapshot(task)) !== undefined)
    return;
  for (const [relativePath, entry] of selected) {
    if (tombstones.has(relativePath)) continue;
    const destination = path.resolve(workspaceRoot, relativePath);
    if (!isStrictlyInsideDirectory(workspaceRoot, destination)) {
      throw new Error(`artifact-contract failure: unsafe invariant suite workspace path ${relativePath}`);
    }
    try {
      lstatSync(destination);
      continue;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    copyInvariantSuiteIntoWorkspace(
      workspaceRoot,
      path.join(realpathSync(entry.dependency), "invariant-suite"),
      relativePath
    );
  }
}

function materializeInvariantSuiteFromDependencies(task: (typeof taskSpecs)[number], workspaceRoot: string): void {
  if (!invariantSuiteNodeIds.has(task.metadata.node.logicalNodeId)) return;
  const dependencies = orderedInvariantSuiteDependencies(task);
  // ONE allowance for the whole ancestor union rather than one per ancestor: the
  // selection below retains a buffer for every (ancestor, path) pair it walks.
  const suiteBudget = { files: 0, totalBytes: 0 };
  const previousSnapshot = invariantSuiteDependencySnapshots.get(task.attemptId);
  if (previousSnapshot !== undefined) {
    for (const [relativePath, entry] of previousSnapshot) {
      const sourceRoot = path.join(realpathSync(entry.dependency), "invariant-suite");
      const current = readInvariantSuiteSourceBytes(sourceRoot, relativePath, "artifact handoff invariant suite");
      if (!current.equals(entry.bytes)) {
        throw new Error(`artifact-contract failure: invariant suite dependency changed ${relativePath}`);
      }
    }
    reconcileInvariantSuiteWorkspace(task, workspaceRoot, previousSnapshot, new Set());
    return;
  }
  // A durable record means an earlier pass of this same attempt already
  // materialized the handoff. loadInvariantSuiteDependencyHandoff re-verifies
  // every recorded byte, so the attempt keeps the exact handoff it used before
  // the restart instead of reverting sources it has since authored. It returns
  // nothing when an ancestor has since republished, and materialization then
  // re-derives against the new ancestor bytes rather than failing closed.
  const recorded = loadInvariantSuiteDependencyHandoff(task);
  if (recorded !== undefined) {
    for (const relativePath of recorded.tombstones) {
      if (recorded.selected.has(relativePath)) {
        throw new Error(`artifact-contract failure: invariant suite handoff record is inconsistent ${relativePath}`);
      }
    }
    assertInvariantSuiteDependencyExpectations(
      task,
      dependencies,
      invariantSuiteDependencySuitePaths(dependencies, suiteBudget)
    );
    reconcileInvariantSuiteWorkspace(task, workspaceRoot, recorded.selected, recorded.tombstones);
    return;
  }
  const tombstones = new Set([
    ...(invariantSuiteTombstones.get(realpathSync(workspaceRoot)) ?? []),
    ...inheritedInvariantSuiteTombstones(task)
  ]);
  const directDependencies = new Set(task.metadata.dependencies.attemptIds);
  const selectedSources = new Map<string, { dependency: string; bytes: Buffer; direct: boolean }>();
  let selectedBytes = 0;
  const suitePathsByDependency = invariantSuiteDependencySuitePaths(dependencies, suiteBudget);
  // Collect EVERY publisher of every path before deciding any of them (issue #315, and the confluence
  // hole review found in the first revision of this fix).
  //
  // The previous shape folded pairwise against whichever ancestor happened to have been selected so far,
  // and that made the outcome depend on the visit order `orderedInvariantSuiteDependencies` produces --
  // which tie-breaks equal-directness ancestors ALPHABETICALLY. Two consequences, both constructed and
  // run rather than reasoned about:
  //
  //   - A fan-in merge resolved cleanly or threw depending purely on node NAMING: siblings `L` and `N`
  //     plus a merge node `M` depending on both succeeded when `M` sorted first and threw when it sorted
  //     last.
  //   - Worse, an ancestor whose entry was REPLACED -- including replacement by identical bytes -- was
  //     forgotten and never reachability-checked, so an unordered claim could be silently dropped instead
  //     of raising the conflict it should. That arm was NEW; before the fix both orderings threw.
  //
  // Resolving per path removes the order dependence entirely, because the answer is a property of the set
  // of publishers rather than of the sequence they arrive in.
  const publishersByPath = new Map<
    string,
    Array<{ dependency: string; attemptId: string; bytes: Buffer; direct: boolean }>
  >();
  for (const dependency of dependencies) {
    const suitePaths = suitePathsByDependency.get(dependency);
    if (suitePaths === undefined) continue;
    const isDirect = directDependencies.has(dependency) || directDependencies.has(path.basename(dependency));
    const suiteRoot = path.join(realpathSync(dependency), "invariant-suite");
    for (const relativePath of suitePaths) {
      // A deleted source must never re-enter the selection, otherwise it is
      // republished to this stage's own artifact and copied into every
      // descendant workspace.
      if (tombstones.has(relativePath)) continue;
      const bytes = readInvariantSuiteSourceBytes(suiteRoot, relativePath, "artifact handoff invariant suite");
      const publishers = publishersByPath.get(relativePath) ?? [];
      publishers.push({ dependency, attemptId: path.basename(dependency), bytes, direct: isDirect });
      publishersByPath.set(relativePath, publishers);
    }
  }
  for (const [relativePath, publishers] of publishersByPath) {
    // Reachability first, and BEFORE directness. A publisher that another publisher transitively depends
    // on has been superseded: its bytes are simply older, not a competing claim. Doing this first also
    // settles the case where a DIRECT ancestor is stale and an INDIRECT descendant rewrote it -- the old
    // rule handed that to the direct one, silently selecting the older Solidity.
    const unsuperseded = publishers.filter(
      (candidate) =>
        !publishers.some(
          (other) => other !== candidate && invariantSuiteAncestorSupersedes(other.attemptId, candidate.attemptId)
        )
    );
    // A cycle would leave every publisher superseded by another and the set empty. The topology validator
    // rejects cycles, so this should be unreachable — but falling through with an empty set would drop the
    // path SILENTLY, which is the failure mode this whole change exists to remove. Keeping every publisher
    // instead hands the decision to the conflict check below, which fails closed.
    const maximal = unsuperseded.length > 0 ? unsuperseded : publishers;
    // Disagreement between publishers of the SAME directness is a real conflict, and it has to be
    // detected across the WHOLE maximal set. Applying the directness preference first hides it: with two
    // unordered indirect publishers disagreeing and one unrelated direct publisher, filtering to the
    // direct one first drops both indirect claims with no error. `main` throws there, so doing this
    // second was a strict loss of fail-closed behaviour, found by review running the algorithm over
    // permutations rather than by reading it.
    //
    // Checking per directness group, rather than across the whole set, is what `main` does — its pairwise
    // rule is "same directness disagreeing throws, otherwise the direct publisher wins". `main` reaches
    // that outcome only for some arrival orders; grouping makes it the outcome for all of them.
    for (const group of [maximal.filter((c) => c.direct), maximal.filter((c) => !c.direct)]) {
      const head = group[0];
      if (head === undefined) continue;
      const disagreeing = group.find((candidate) => !candidate.bytes.equals(head.bytes));
      if (disagreeing !== undefined) {
        throw new Error(
          `artifact handoff ancestor invariant suite sources conflict for ${relativePath}: ${head.dependency} vs ${disagreeing.dependency}`
        );
      }
    }
    // A DIRECT dependency outranks an indirect one when they disagree, which is long-standing behaviour
    // the #217 tombstone tests depend on. Only cross-directness disagreement reaches here; same-directness
    // disagreement has already thrown.
    const preferred = maximal.some((candidate) => candidate.direct)
      ? maximal.filter((candidate) => candidate.direct)
      : maximal;
    const first = preferred[0];
    // `publishers` is never empty — a path only enters the map when some dependency published it — and an
    // empty unsuperseded set falls back to the full list above, so this is unreachable.
    if (first === undefined) continue;
    // Every remaining publisher carries identical bytes, so `first` is not an arbitrary tie-break: the
    // content is settled and only the attribution differs.
    selectedBytes += first.bytes.length;
    selectedSources.set(relativePath, { dependency: first.dependency, bytes: first.bytes, direct: first.direct });
    assertInvariantSuiteSourceBudget(selectedSources.size, selectedBytes);
  }
  assertInvariantSuiteSourceBudget(
    selectedSources.size,
    [...selectedSources.values()].reduce((total, entry) => total + entry.bytes.length, 0)
  );
  invariantSuiteDependencySnapshots.set(task.attemptId, selectedSources);
  assertInvariantSuiteDependencyExpectations(task, dependencies, suitePathsByDependency);
  for (const [relativePath, entry] of selectedSources) {
    if (tombstones.has(relativePath)) continue;
    copyInvariantSuiteIntoWorkspace(
      workspaceRoot,
      path.join(realpathSync(entry.dependency), "invariant-suite"),
      relativePath
    );
  }
  writeInvariantSuiteDependencyHandoff(task, selectedSources, tombstones);
}

const MAX_INVARIANT_SUITE_PATH_LENGTH = 4_096;
const MAX_INVARIANT_SUITE_SEGMENT_LENGTH = 255;
const MAX_INVARIANT_SUITE_FILES = 512;
const MAX_INVARIANT_SUITE_SOURCE_DEPTH = 32;
const MAX_INVARIANT_SUITE_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_INVARIANT_SUITE_TOTAL_BYTES = 64 * 1024 * 1024;
const INVARIANT_SUITE_BASELINE_FILE = "invariant-suite-baseline.json";
const WORKSPACE_PATCH_BASELINE_FILE = "workspace-patch-baseline.json";
const WORKSPACE_PATCH_PREPARATION_FILE = "workspace-patch-preparation.json";
const INVARIANT_SUITE_MANIFEST_FILE = "invariant-suite-manifest.json";
const INVARIANT_SUITE_HANDOFF_DIR = "invariant-suite-handoffs";
const INVARIANT_SUITE_HANDOFF_FILE = "handoff.json";
const INVARIANT_SUITE_HANDOFF_SCHEMA_VERSION = "ultrafuzz.invariant-suite-handoff.v1";
const INVARIANT_SUITE_WORKSPACE_SNAPSHOT_DIR = "invariant-suite-workspace-snapshots";
const INVARIANT_SUITE_WORKSPACE_SNAPSHOT_FILE = "snapshot.json";
const INVARIANT_SUITE_WORKSPACE_FILES_DIR = "files";
const MAX_INVARIANT_SUITE_WORKSPACE_FILES = 4_096;
const MAX_INVARIANT_SUITE_WORKSPACE_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_INVARIANT_SUITE_WORKSPACE_TOTAL_BYTES = 128 * 1024 * 1024;
/**
 * Ceiling on one invariant-discovery git capture, in bytes.
 *
 * `execFileSync` defaults to 1 MB. These enumerations list every tracked and untracked path under
 * `src`, `contracts`, `test` and `tests`, so on a protocol the size of Aave v4 the PATH TEXT alone can
 * pass that -- and Node then throws a bare `spawnSync git ENOBUFS` naming no subcommand, no size and no
 * path. #310 hardened `runGit` against exactly that failure; these call sites do not go through it.
 * Sized to the ceiling a handed-off patch has to meet, since a workspace listing that outgrows it is
 * not one that can be handed off either.
 */
const MAX_INVARIANT_SUITE_ENUMERATION_BYTES = 16 * 1024 * 1024;
/** Roots named when an enumeration overflows: enough to point at a directory, short enough to read. */
const INVARIANT_SUITE_ENUMERATION_RANKED_ROOTS = 5;
/** How much of git's own stderr to inline when stderr, not the path list, is what overflowed. */
const INVARIANT_SUITE_ENUMERATION_STDERR_BYTES = 400;
const INVARIANT_TEST_ROOT_NAMES = ["test", "tests"] as const;
const invariantSuiteNodeIds = new Set([
  "stateful-invariant-setup",
  "stateful-invariant-handlers",
  "stateful-invariant-coverage",
  "stateful-invariant-implement-properties",
  "stateful-invariant-campaign"
]);
const INVARIANT_SUITE_SENSITIVE_SEGMENTS = new Set([".git", ".ultrafuzz", ".smithers", "node_modules", ".env"]);
const INVARIANT_SUITE_ALLOWED_ROOTS = ["src", "contracts", "test", "tests"] as const;
const invariantSuiteBaselineSnapshots = new Map<string, { contents: string; sha256: string }>();
const invariantSuiteProtectedBaselineSnapshots = new Map<string, { contents: string; sha256: string }>();
const invariantSuiteTombstones = new Map<string, Set<string>>();
const invariantSuiteDependencySnapshots = new Map<
  string,
  Map<string, { dependency: string; bytes: Buffer; direct: boolean }>
>();
const invariantSuitePublicationSnapshots = new Map<string, Map<string, Buffer>>();
const invariantSuiteWorkspaceSnapshots = new Map<string, Map<string, Buffer>>();
const workspacePatchBaselineTrees = new Map<string, string>();
const workspacePatchPreparationTrees = new Map<string, string>();

/**
 * Enumerate workspace paths with git, under an explicit capture bound.
 *
 * Every invariant-discovery enumeration goes through here so that the bound is stated once and an
 * overflow arrives as a sentence rather than as a `SystemError`.
 */
function invariantSuiteGitPaths(workspaceRoot: string, args: readonly string[]): string {
  try {
    // No `encoding`, deliberately. With one, Node decodes the capture BEFORE it throws, and that decode
    // is lossy: a byte that is not valid UTF-8 comes back as U+FFFD, which re-encodes to three. The byte
    // totals the diagnostic reports would then not be the bytes `maxBuffer` counted. Decode here, on the
    // success path, which is what the call sites were already getting from `encoding: "utf8"`.
    return execFileSync("git", [...args], {
      cwd: workspaceRoot,
      maxBuffer: MAX_INVARIANT_SUITE_ENUMERATION_BYTES
    }).toString("utf8");
  } catch (error) {
    rethrowOversizedInvariantSuiteEnumeration(args, error);
  }
}

/**
 * Rethrow an enumeration that outgrew its capture buffer as something an operator can act on.
 *
 * The bare failure is `spawnSync git ENOBUFS`: no subcommand, no size, no path, and no hint that the
 * workspace is at fault. This names all four, following #311, which does the same for the handoff diff.
 * That helper is not reusable here -- it reads its attribution out of `diff --git` headers, and it is
 * deliberately not part of the runtime package's public surface, which is all this template can import.
 *
 * Scope: this improves the string. The enumeration has already failed by the time it runs.
 */
function rethrowOversizedInvariantSuiteEnumeration(args: readonly string[], error: unknown): never {
  if (!(error instanceof Error) || (error as { code?: unknown }).code !== "ENOBUFS") throw error;
  // Every call site here passes the subcommand first and no global git options, so no scan is needed.
  const subcommand = args[0] ?? "git";
  const capturedStdout = (error as { stdout?: unknown }).stdout;
  const capturedStderr = (error as { stderr?: unknown }).stderr;
  const stdoutBytes = Buffer.isBuffer(capturedStdout) ? capturedStdout.length : 0;
  const stderrBytes = Buffer.isBuffer(capturedStderr) ? capturedStderr.length : 0;
  // ENOBUFS fires on EITHER stream. Blaming the workspace when git merely wrote a lot of stderr would be
  // a confident lie that sends an operator to delete sources over a git message, so claim the path list
  // only when the path list is the larger capture.
  const overflowedStderr = stderrBytes > stdoutBytes;
  const attribution = overflowedStderr ? "" : rankInvariantSuiteEnumerationRoots(capturedStdout);
  const detail = overflowedStderr
    ? `wrote more than the ${MAX_INVARIANT_SUITE_ENUMERATION_BYTES}-byte enumeration buffer to stderr: ${
        Buffer.isBuffer(capturedStderr)
          ? capturedStderr.subarray(0, INVARIANT_SUITE_ENUMERATION_STDERR_BYTES).toString("utf8")
          : ""
      }`
    : `listed more than the ${MAX_INVARIANT_SUITE_ENUMERATION_BYTES}-byte enumeration buffer of workspace paths`;
  // Drop the payload before this becomes a `cause`. Node holds the capture in both `stdout` and
  // `output[1]`, and `error.error` is a self-reference, so an unstripped cause serializes to a multiple
  // of a capture that is by construction at the buffer ceiling -- one way to lose the report of the
  // failure along with the failure.
  for (const field of ["stdout", "stderr", "output", "error"]) {
    delete (error as unknown as Record<string, unknown>)[field];
  }
  throw new Error(
    `artifact-contract failure: git ${subcommand} ${detail}${
      attribution === ""
        ? ""
        : `. Largest contributors within the first ${stdoutBytes} bytes git wrote; git emits in path order, so anything past that cutoff is not visible here: ${attribution}`
    }`,
    { cause: error }
  );
}

/** Total the captured path list per top-level root, largest first. */
function rankInvariantSuiteEnumerationRoots(capturedStdout: unknown): string {
  if (!Buffer.isBuffer(capturedStdout)) return "";
  // A `latin1` view is a byte/code-unit bijection, so an offset IS a byte offset and the spans below are
  // exact; a `utf8` decode inflates every undecodable byte threefold and can rank a smaller root first.
  // The scan is index-based rather than `split("\n")` because this runs in a process that has just been
  // refused an allocation, and 16 MB of short paths is a million lines. The table cannot grow without
  // bound: every call site restricts the enumeration to a pathspec of at most four roots.
  const listing = capturedStdout.toString("latin1");
  const totals = new Map<string, { bytes: number; paths: number }>();
  for (let start = 0; start < listing.length;) {
    const end = listing.indexOf("\n", start);
    // The last line was cut mid-path by the very overflow being reported, so it is not attributed: its
    // root may be the prefix of a longer name. Every figure here is a floor for that reason and because
    // the capture is a prefix of what git had to say.
    if (end < 0) break;
    const separator = listing.indexOf("/", start);
    const root = listing.slice(start, separator >= 0 && separator < end ? separator : end);
    const previous = totals.get(root) ?? { bytes: 0, paths: 0 };
    totals.set(root, { bytes: previous.bytes + (end - start) + 1, paths: previous.paths + 1 });
    start = end + 1;
  }
  return [...totals.entries()]
    .sort((left, right) => right[1].bytes - left[1].bytes)
    .slice(0, INVARIANT_SUITE_ENUMERATION_RANKED_ROOTS)
    .map(([root, total]) => `${root} (>=${total.bytes} bytes in ${total.paths} path${total.paths === 1 ? "" : "s"})`)
    .join(", ");
}

function invariantTestRoots(workspaceRoot: string): readonly string[] {
  const discovered = INVARIANT_TEST_ROOT_NAMES.filter((root) => {
    const candidate = path.resolve(workspaceRoot, root);
    try {
      const stat = lstatSync(candidate);
      return stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(candidate) === candidate;
    } catch {
      return false;
    }
  });
  return discovered.length > 0 ? discovered : ["test"];
}

/**
 * Validate an explicit repository-relative path from implementation/test
 * provenance. Implementation sources commonly live under src/contracts, so
 * this intentionally accepts any ordinary relative path while excluding
 * internal state roots and traversal/absolute forms.
 */
function assertSafeInvariantSuitePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_INVARIANT_SUITE_PATH_LENGTH) {
    throw new Error(`artifact-contract failure: unsafe invariant suite source path ${String(value)}`);
  }
  const segments = value.split("/");
  if (
    path.isAbsolute(value) ||
    value.includes("\\") ||
    value.includes("\u0000") ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment.length > MAX_INVARIANT_SUITE_SEGMENT_LENGTH ||
        segment === "." ||
        segment === ".." ||
        INVARIANT_SUITE_SENSITIVE_SEGMENTS.has(segment) ||
        segment === ".envrc" ||
        segment === ".gitignore" ||
        segment === ".npmrc" ||
        segment.startsWith(".env.")
    ) ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw new Error(`artifact-contract failure: unsafe invariant suite source path ${String(value)}`);
  }
  if (!INVARIANT_SUITE_ALLOWED_ROOTS.some((prefix) => value.startsWith(`${prefix}/`))) {
    throw new Error(`artifact-contract failure: unsupported invariant suite source root ${value}`);
  }
  return value;
}

function assertSafeInvariantSuiteTestPath(value: string): string {
  const safePath = assertSafeInvariantSuitePath(value);
  if (!safePath.startsWith("test/") && !safePath.startsWith("tests/")) {
    throw new Error(`artifact-contract failure: invariant suite test path must be under test/ or tests/: ${safePath}`);
  }
  return safePath;
}

function assertInvariantSuiteSourceBudget(fileCount: number, totalBytes: number): void {
  if (fileCount > MAX_INVARIANT_SUITE_FILES) {
    throw new Error(`artifact-contract failure: invariant suite has too many source files (${fileCount})`);
  }
  if (totalBytes > MAX_INVARIANT_SUITE_TOTAL_BYTES) {
    throw new Error(`artifact-contract failure: invariant suite exceeds the source byte budget (${totalBytes})`);
  }
}

function assertInvariantSuiteSourceSize(relativePath: string, size: number): void {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_INVARIANT_SUITE_SOURCE_BYTES) {
    throw new Error(`artifact-contract failure: invariant suite source exceeds the file byte limit ${relativePath}`);
  }
}

function changedTestTreePaths(workspaceRoot: string, baselinePath?: string, protectedBaselinePath?: string): string[] {
  try {
    const authoritativeBaselinePath =
      protectedBaselinePath !== undefined && existsSync(protectedBaselinePath) ? protectedBaselinePath : baselinePath;
    if (authoritativeBaselinePath !== undefined && existsSync(authoritativeBaselinePath)) {
      const baselineRoot = realpathSync(path.dirname(authoritativeBaselinePath));
      const resolvedBaseline = resolveRegularArtifactFile(
        baselineRoot,
        authoritativeBaselinePath,
        "artifact-contract failure: invariant suite baseline is not a regular file"
      );
      const baselineContents = readFileSync(resolvedBaseline, "utf8");
      const baselineDigest = createHash("sha256").update(baselineContents).digest("hex");
      const snapshot =
        protectedBaselinePath !== undefined && authoritativeBaselinePath === protectedBaselinePath
          ? invariantSuiteProtectedBaselineSnapshots.get(authoritativeBaselinePath)
          : invariantSuiteBaselineSnapshots.get(baselineRoot);
      if (snapshot !== undefined && snapshot.sha256 !== baselineDigest) {
        throw new Error("artifact-contract failure: invariant suite baseline was modified by the agent");
      }
      const parsed = JSON.parse(baselineContents) as {
        schema_version?: unknown;
        files?: unknown;
      };
      if (parsed.schema_version !== "ultrafuzz.invariant-suite-baseline.v1" || !Array.isArray(parsed.files)) {
        throw new Error("artifact-contract failure: invariant suite baseline is malformed");
      }
      const baseline = new Map<string, { sha256: string; size: number }>();
      for (const entry of parsed.files) {
        if (
          typeof entry !== "object" ||
          entry === null ||
          Array.isArray(entry) ||
          typeof (entry as { path?: unknown }).path !== "string" ||
          typeof (entry as { sha256?: unknown }).sha256 !== "string" ||
          !/^[0-9a-f]{64}$/u.test((entry as { sha256: string }).sha256) ||
          !Number.isSafeInteger((entry as { size?: unknown }).size) ||
          (entry as { size: number }).size < 0
        ) {
          throw new Error("artifact-contract failure: invariant suite baseline entry is malformed");
        }
        const relativePath = assertSafeInvariantSuiteTestPath((entry as { path: string }).path);
        baseline.set(relativePath, {
          sha256: (entry as { sha256: string }).sha256,
          size: (entry as { size: number }).size
        });
      }
      const current = gitTestTreePaths(workspaceRoot);
      const currentSet = new Set(current);
      const changed = new Set<string>();
      for (const relativePath of baseline.keys()) {
        if (!currentSet.has(relativePath)) recordInvariantSuiteTombstone(workspaceRoot, relativePath);
      }
      for (const relativePath of current) {
        const sourcePath = path.resolve(workspaceRoot, relativePath);
        const source = resolveRegularArtifactFile(
          workspaceRoot,
          sourcePath,
          `artifact-contract failure: invariant suite source is not regular ${relativePath}`
        );
        const sourceStat = statSync(source);
        if (sourceStat.size === 0) {
          recordInvariantSuiteTombstone(workspaceRoot, relativePath);
          continue;
        }
        if (sourceStat.nlink !== 1) {
          throw new Error(`artifact-contract failure: invariant suite source is hard-linked ${relativePath}`);
        }
        const digest = createHash("sha256").update(readFileSync(source)).digest("hex");
        const previous = baseline.get(relativePath);
        if (previous === undefined || previous.size !== sourceStat.size || previous.sha256 !== digest) {
          changed.add(relativePath);
        }
      }
      return [...changed].sort();
    }
    const changed = new Set<string>();
    const baseRef = [pinnedSourceRef, "HEAD^"].find((candidate) => {
      try {
        execFileSync("git", ["rev-parse", "--verify", `${candidate}^{commit}`], {
          cwd: workspaceRoot,
          stdio: ["ignore", "ignore", "pipe"]
        });
        return true;
      } catch {
        return false;
      }
    });
    const diffArgs =
      baseRef === undefined
        ? ["diff", "--name-only", "HEAD", "--", "test", "tests"]
        : ["diff", "--name-only", `${baseRef}...HEAD`, "--", "test", "tests"];
    for (const args of [
      diffArgs,
      ["diff", "--name-only", "HEAD", "--", "test", "tests"],
      ["ls-files", "--others", "--", "test", "tests"]
    ]) {
      for (const value of invariantSuiteGitPaths(workspaceRoot, args).split(/\r?\n/u)) {
        if (value.startsWith("test/") || value.startsWith("tests/")) {
          const candidate = path.resolve(workspaceRoot, value);
          if (!existsSync(candidate)) {
            recordInvariantSuiteTombstone(workspaceRoot, assertSafeInvariantSuiteTestPath(value));
            continue;
          }
          const source = resolveRegularArtifactFile(
            workspaceRoot,
            candidate,
            `artifact-contract failure: invariant suite source is not regular ${value}`
          );
          // An emptied source is a deletion the agent expressed by truncation.
          // Without a tombstone it is merely skipped, and the ancestor copy is
          // silently republished in its place.
          if (statSync(source).size > 0) changed.add(assertSafeInvariantSuiteTestPath(value));
          else recordInvariantSuiteTombstone(workspaceRoot, assertSafeInvariantSuiteTestPath(value));
        }
      }
    }
    return [...changed].sort();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("artifact-contract failure:")) throw error;
    throw new Error("artifact-contract failure: unable to enumerate changed invariant suite sources", { cause: error });
  }
}

function recordInvariantSuiteTombstone(workspaceRoot: string, relativePath: string): void {
  const tombstones = invariantSuiteTombstones.get(workspaceRoot) ?? new Set<string>();
  tombstones.add(relativePath);
  invariantSuiteTombstones.set(workspaceRoot, tombstones);
}

function changedInvariantSourcePaths(workspaceRoot: string): string[] {
  const changed = new Set<string>();
  try {
    for (const args of [
      ["diff", "--name-only", "HEAD", "--", "src", "contracts"],
      ["ls-files", "--others", "--", "src", "contracts"]
    ]) {
      for (const value of invariantSuiteGitPaths(workspaceRoot, args).split(/\r?\n/u)) {
        if (!value.startsWith("src/") && !value.startsWith("contracts/")) continue;
        const relativePath = assertSafeInvariantSuitePath(value);
        const candidate = path.resolve(workspaceRoot, relativePath);
        if (!existsSync(candidate)) {
          recordInvariantSuiteTombstone(workspaceRoot, relativePath);
          continue;
        }
        const source = resolveRegularArtifactFile(
          workspaceRoot,
          candidate,
          `artifact-contract failure: invariant source is not regular ${relativePath}`
        );
        if (statSync(source).size > 0) changed.add(relativePath);
        else recordInvariantSuiteTombstone(workspaceRoot, relativePath);
      }
    }
    return [...changed].sort();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("artifact-contract failure:")) throw error;
    throw new Error("artifact-contract failure: unable to enumerate changed invariant sources", { cause: error });
  }
}

function gitTestTreePaths(workspaceRoot: string): string[] {
  const paths = new Set<string>();
  for (const value of invariantSuiteGitPaths(workspaceRoot, [
    "ls-files",
    "--cached",
    "--others",
    "--",
    "test",
    "tests"
  ]).split(/\r?\n/u)) {
    if (value.startsWith("test/") || value.startsWith("tests/")) {
      const source = resolveRegularArtifactFile(
        workspaceRoot,
        path.resolve(workspaceRoot, value),
        `artifact-contract failure: invariant suite source is not regular ${value}`
      );
      if (statSync(source).size > 0) paths.add(assertSafeInvariantSuiteTestPath(value));
    }
  }
  return [...paths].sort();
}

function copyInvariantSuiteSource(
  workspaceRoot: string,
  artifactRoot: string,
  relativePath: string,
  replaceExisting = false
): void {
  const sourcePath = path.resolve(workspaceRoot, relativePath);
  const source = resolveNonEmptyRegularArtifactFile(
    workspaceRoot,
    sourcePath,
    `artifact-contract failure: invariant suite source is missing ${relativePath}`,
    `artifact-contract failure: invariant suite source is empty ${relativePath}`
  );
  const sourceStat = statSync(source);
  if (sourceStat.nlink !== 1) {
    throw new Error(`artifact-contract failure: invariant suite source is hard-linked ${relativePath}`);
  }
  assertInvariantSuiteSourceSize(relativePath, sourceStat.size);
  const sourceBytes = readFileSync(source);
  if (sourceBytes.length !== sourceStat.size) {
    throw new Error(`artifact-contract failure: invariant suite source changed ${relativePath}`);
  }
  const artifactPath = path.resolve(artifactRoot, "invariant-suite", relativePath);
  if (!isStrictlyInsideDirectory(artifactRoot, artifactPath)) {
    throw new Error(`artifact-contract failure: unsafe invariant suite artifact path ${relativePath}`);
  }
  const artifactParent = safeInvariantSuiteDirectory(artifactRoot, path.dirname(artifactPath));
  mkdirSync(artifactParent, { recursive: true });
  const resolvedParent = realpathSync(artifactParent);
  if (resolvedParent !== artifactParent || !isStrictlyInsideDirectory(artifactRoot, resolvedParent)) {
    throw new Error(`artifact-contract failure: unsafe invariant suite artifact parent ${relativePath}`);
  }
  const anchoredArtifactPath = path.join(resolvedParent, path.basename(artifactPath));
  let artifactEntryExists = false;
  try {
    const artifactStat = lstatSync(anchoredArtifactPath);
    artifactEntryExists = true;
    if (artifactStat.isSymbolicLink()) {
      throw new Error(`artifact-contract failure: invariant suite artifact is a symlink ${relativePath}`);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (artifactEntryExists) {
    const existing = resolveNonEmptyRegularArtifactFile(
      artifactRoot,
      anchoredArtifactPath,
      `artifact-contract failure: invariant suite artifact is missing ${relativePath}`,
      `artifact-contract failure: invariant suite artifact is empty ${relativePath}`
    );
    if (!replaceExisting && !readFileSync(existing).equals(sourceBytes)) {
      throw new Error(`artifact-contract failure: invariant suite source changed ${relativePath}`);
    }
    if (!replaceExisting) return;
  }
  if (replaceExisting) {
    writeFileDurable(anchoredArtifactPath, sourceBytes);
  } else {
    writeFileSync(anchoredArtifactPath, sourceBytes, { flag: "wx", mode: 0o600 });
  }
}

function copyDependencyInvariantSuiteToArtifact(task: (typeof taskSpecs)[number], artifactRoot: string): void {
  const tombstones = invariantSuiteTombstones.get(realpathSync(task.workspacePath)) ?? new Set<string>();
  const selected = resolveInvariantSuiteDependencySnapshot(task);
  for (const [relativePath, entry] of selected) {
    if (tombstones.has(relativePath)) continue;
    const destination = path.resolve(artifactRoot, "invariant-suite", relativePath);
    const parent = safeInvariantSuiteDirectory(artifactRoot, path.dirname(destination));
    mkdirSync(parent, { recursive: true });
    const resolvedParent = realpathSync(parent);
    if (resolvedParent !== parent || !isStrictlyInsideDirectory(artifactRoot, resolvedParent)) {
      throw new Error(`artifact-contract failure: unsafe invariant suite artifact parent ${relativePath}`);
    }
    writeFileDurable(path.join(resolvedParent, path.basename(destination)), entry.bytes);
  }
}

function listInvariantSuiteSources(
  suiteRoot: string,
  relative = "",
  budget: { files: number; totalBytes: number } = { files: 0, totalBytes: 0 }
): string[] {
  // Bound the walk BEFORE stat'ing the entry. A suite whose tree is nested past
  // the limit is rejected on the way down instead of after the recursion has
  // already paid for it.
  if (relative.split(path.sep).length > MAX_INVARIANT_SUITE_SOURCE_DEPTH) {
    throw new Error(`artifact handoff invariant-suite tree is too deep: ${relative}`);
  }
  const current = relative.length === 0 ? suiteRoot : path.join(suiteRoot, relative);
  const stat = lstatSync(current);
  if (stat.isSymbolicLink()) {
    throw new Error(`artifact handoff invariant-suite path is a symlink: ${relative || "invariant-suite"}`);
  }
  if (stat.isFile()) {
    if (stat.nlink !== 1) {
      throw new Error(`artifact handoff invariant-suite source is hard-linked: ${relative}`);
    }
    assertInvariantSuiteSourceSize(relative, stat.size);
    budget.files += 1;
    budget.totalBytes += stat.size;
    assertInvariantSuiteSourceBudget(budget.files, budget.totalBytes);
    return [assertSafeInvariantSuitePath(relative.split(path.sep).join("/"))];
  }
  if (!stat.isDirectory()) {
    throw new Error(`artifact handoff invariant-suite path is not a regular file: ${relative}`);
  }
  const sources = readdirSync(current).flatMap((entry) =>
    listInvariantSuiteSources(suiteRoot, relative.length === 0 ? entry : path.join(relative, entry), budget)
  );
  return sources;
}

function readInvariantSuiteSourceBytes(suiteRoot: string, relativePath: string, prefix: string): Buffer {
  const sourcePath = path.resolve(suiteRoot, relativePath);
  const source = resolveNonEmptyRegularArtifactFile(
    suiteRoot,
    sourcePath,
    `${prefix} source is missing ${relativePath}`,
    `${prefix} source is empty ${relativePath}`
  );
  const sourceStat = statSync(source);
  if (sourceStat.nlink !== 1) {
    throw new Error(`${prefix} source is hard-linked ${relativePath}`);
  }
  assertInvariantSuiteSourceSize(relativePath, sourceStat.size);
  const sourceBytes = readFileSync(source);
  if (sourceBytes.length !== sourceStat.size) {
    throw new Error(`${prefix} source changed ${relativePath}`);
  }
  return sourceBytes;
}

function copyInvariantSuiteIntoWorkspace(workspaceRoot: string, suiteRoot: string, relativePath: string): void {
  const sourceBytes = readInvariantSuiteSourceBytes(suiteRoot, relativePath, "artifact handoff invariant suite");
  const destination = path.resolve(workspaceRoot, relativePath);
  if (!isStrictlyInsideDirectory(workspaceRoot, destination)) {
    throw new Error(`artifact-contract failure: invariant suite destination escapes workspace ${relativePath}`);
  }
  const destinationParent = safeInvariantSuiteDirectory(workspaceRoot, path.dirname(destination));
  mkdirSync(destinationParent, { recursive: true });
  const resolvedParent = realpathSync(destinationParent);
  if (resolvedParent !== destinationParent || !isStrictlyInsideDirectory(workspaceRoot, resolvedParent)) {
    throw new Error(`artifact-contract failure: invariant suite destination parent escapes workspace ${relativePath}`);
  }
  const anchoredDestination = path.join(resolvedParent, path.basename(destination));
  let destinationEntryExists = false;
  try {
    const destinationStat = lstatSync(anchoredDestination);
    destinationEntryExists = true;
    if (destinationStat.isSymbolicLink()) {
      throw new Error(`artifact-contract failure: invariant suite destination is a symlink ${relativePath}`);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (destinationEntryExists) {
    const existing = resolveNonEmptyRegularArtifactFile(
      workspaceRoot,
      anchoredDestination,
      `artifact handoff invariant suite destination is missing ${relativePath}`,
      `artifact handoff invariant suite destination is empty ${relativePath}`
    );
    if (existing !== anchoredDestination) {
      throw new Error(`artifact handoff invariant suite destination is not canonical ${relativePath}`);
    }
  }
  // A generated suite is authoritative over the pinned source and over an
  // earlier ancestor suite. Replace only after the canonical parent and leaf
  // have been checked; writeFileDurable atomically replaces a leaf symlink
  // rather than following it if a concurrent actor races after validation.
  writeFileDurable(anchoredDestination, sourceBytes);
}

function safeInvariantSuiteDirectory(root: string, candidate: string): string {
  const canonicalRoot = realpathSync(root);
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  const relativeCandidate = path.relative(absoluteRoot, absoluteCandidate);
  if (
    relativeCandidate === ".." ||
    relativeCandidate.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeCandidate)
  ) {
    throw new Error(`artifact-contract failure: invariant suite directory escapes root ${candidate}`);
  }
  // The snapshot workspace may be reached through a symlink alias. Validate
  // the candidate relative to the lexical root, then perform all filesystem
  // operations below the canonical root so the alias cannot escape checks.
  const canonicalCandidate = path.resolve(canonicalRoot, relativeCandidate);
  if (canonicalCandidate !== canonicalRoot && !isStrictlyInsideDirectory(canonicalRoot, canonicalCandidate)) {
    throw new Error(`artifact-contract failure: invariant suite directory escapes root ${candidate}`);
  }
  let current = canonicalCandidate;
  const missing: string[] = [];
  while (current !== canonicalRoot) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(current) !== current) {
        throw new Error(`artifact-contract failure: invariant suite directory is unsafe ${candidate}`);
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      missing.push(current);
    }
    const parent = path.dirname(current);
    if (parent === current || (parent !== canonicalRoot && !isStrictlyInsideDirectory(canonicalRoot, parent))) {
      throw new Error(`artifact-contract failure: invariant suite directory escapes root ${candidate}`);
    }
    current = parent;
  }
  for (const directory of missing.reverse()) {
    mkdirSync(directory, { recursive: false });
  }
  const resolved = realpathSync(canonicalCandidate);
  if (
    resolved !== canonicalCandidate ||
    (resolved !== canonicalRoot && !isStrictlyInsideDirectory(canonicalRoot, resolved))
  ) {
    throw new Error(`artifact-contract failure: invariant suite directory changed during creation ${candidate}`);
  }
  return resolved;
}

/**
 * Rebuild the publication expectation from the durable manifest this attempt
 * already published. verifyArtifacts is its own retries:0 node, so a restart
 * between an invariant agent task finishing and its verifier running left the
 * in-process snapshot empty and killed the run at a stateful-invariant stage.
 * The manifest is the durable record of the same publication, so recovery reads
 * it and reports a typed artifact failure naming the file only when the
 * manifest itself is unavailable.
 */
function recoverInvariantSuitePublicationSnapshot(
  task: (typeof taskSpecs)[number],
  artifactRoots: readonly string[]
): Map<string, Buffer> {
  for (const artifactRoot of artifactRoots) {
    const manifest = readInvariantSuiteManifestRecord(artifactRoot);
    if (
      manifest === undefined ||
      manifest.producerNodeId !== task.metadata.node.logicalNodeId ||
      manifest.producerAttemptId !== task.attemptId
    ) {
      continue;
    }
    const suiteRoot = path.join(artifactRoot, "invariant-suite");
    const recovered = new Map<string, Buffer>();
    for (const [relativePath, entry] of manifest.files) {
      const bytes = readInvariantSuiteSourceBytes(
        suiteRoot,
        relativePath,
        "artifact-contract failure: invariant suite artifact"
      );
      if (bytes.length !== entry.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
        throw new Error(`artifact-contract failure: invariant suite artifact changed ${relativePath}`);
      }
      recovered.set(relativePath, bytes);
    }
    invariantSuitePublicationSnapshots.set(task.attemptId, recovered);
    return recovered;
  }
  throw new Error(
    `artifact-contract failure: invariant suite manifest is unavailable for ${task.attemptId} ${path.join(
      artifactRoots[0] ?? "",
      INVARIANT_SUITE_MANIFEST_FILE
    )}`
  );
}

function rememberInvariantSuitePublications(
  task: (typeof taskSpecs)[number],
  publications: Map<string, Buffer>,
  artifactRoots: readonly string[]
): void {
  const expected =
    invariantSuitePublicationSnapshots.get(task.attemptId) ??
    recoverInvariantSuitePublicationSnapshot(task, artifactRoots);
  const expectedPaths = new Set(expected.keys());
  let observedRoot = false;
  for (const artifactRoot of artifactRoots) {
    const manifestPath = path.join(artifactRoot, INVARIANT_SUITE_MANIFEST_FILE);
    const manifest = resolveNonEmptyRegularArtifactFile(
      artifactRoot,
      manifestPath,
      "artifact-contract failure: invariant suite manifest is missing",
      "artifact-contract failure: invariant suite manifest is empty"
    );
    rememberVerifiedPublication(publications, INVARIANT_SUITE_MANIFEST_FILE, readFileSync(manifest));
    const suiteRoot = path.join(artifactRoot, "invariant-suite");
    if (!existsSync(suiteRoot)) continue;
    observedRoot = true;
    const actualPaths = listInvariantSuiteSources(suiteRoot);
    for (const relativePath of actualPaths) {
      const expectedBytes = expected.get(relativePath);
      if (expectedBytes === undefined) {
        throw new Error(`artifact-contract failure: unexpected invariant suite artifact ${relativePath}`);
      }
      const sourcePath = path.resolve(suiteRoot, relativePath);
      const source = resolveNonEmptyRegularArtifactFile(
        suiteRoot,
        sourcePath,
        `artifact-contract failure: invariant suite artifact is missing ${relativePath}`,
        `artifact-contract failure: invariant suite artifact is empty ${relativePath}`
      );
      const bytes = readFileSync(source);
      if (!bytes.equals(expectedBytes)) {
        throw new Error(`artifact-contract failure: invariant suite artifact changed ${relativePath}`);
      }
      rememberVerifiedPublication(publications, path.posix.join("invariant-suite", relativePath), expectedBytes);
    }
    if (
      actualPaths.length !== expectedPaths.size ||
      actualPaths.some((relativePath) => !expectedPaths.has(relativePath))
    ) {
      throw new Error("artifact-contract failure: invariant suite artifact set changed");
    }
  }
  if (expected.size > 0 && !observedRoot) {
    throw new Error(`artifact-contract failure: invariant suite artifact root is missing ${task.attemptId}`);
  }
}

function rememberExpectedInvariantSuitePublications(
  dependencyTask: (typeof taskSpecs)[number],
  dependency: string,
  publications: Map<string, string>
): void {
  const dependencyRoot = realpathSync(dependency);
  const manifestPath = path.join(dependencyRoot, INVARIANT_SUITE_MANIFEST_FILE);
  const resolvedManifest = resolveNonEmptyRegularArtifactFile(
    dependencyRoot,
    manifestPath,
    "artifact-contract failure: invariant suite manifest is missing",
    "artifact-contract failure: invariant suite manifest is empty"
  );
  const manifestBytes = readFileSync(resolvedManifest);
  let manifest: {
    schema_version?: unknown;
    producer_node_id?: unknown;
    producer_attempt_id?: unknown;
    files?: unknown;
  };
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8")) as typeof manifest;
  } catch (error) {
    throw new Error(`artifact-contract failure: invariant suite manifest is malformed ${manifestPath}`, {
      cause: error
    });
  }
  if (
    manifest.schema_version !== "ultrafuzz.invariant-suite-manifest.v1" ||
    manifest.producer_node_id !== dependencyTask.metadata.node.logicalNodeId ||
    manifest.producer_attempt_id !== dependencyTask.attemptId ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error(`artifact-contract failure: invariant suite manifest is invalid ${dependencyTask.attemptId}`);
  }
  rememberExpectedVerifiedPublication(publications, INVARIANT_SUITE_MANIFEST_FILE, manifestBytes);

  const expectedFiles = new Map<string, { sha256: string; sizeBytes: number }>();
  for (const file of manifest.files) {
    if (
      typeof file !== "object" ||
      file === null ||
      Array.isArray(file) ||
      typeof (file as { path?: unknown }).path !== "string" ||
      typeof (file as { size_bytes?: unknown }).size_bytes !== "number" ||
      !Number.isSafeInteger((file as { size_bytes: number }).size_bytes) ||
      (file as { size_bytes: number }).size_bytes < 1 ||
      typeof (file as { sha256?: unknown }).sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test((file as { sha256: string }).sha256)
    ) {
      throw new Error(
        `artifact-contract failure: invariant suite manifest file entry is invalid ${dependencyTask.attemptId}`
      );
    }
    const entry = file as { path: string; size_bytes: number; sha256: string };
    const relativePath = assertSafeInvariantSuitePath(entry.path);
    assertInvariantSuiteSourceSize(relativePath, entry.size_bytes);
    if (expectedFiles.has(relativePath)) {
      throw new Error(`artifact-contract failure: duplicate invariant suite manifest file ${relativePath}`);
    }
    expectedFiles.set(relativePath, { sha256: entry.sha256, sizeBytes: entry.size_bytes });
  }

  const suiteRoot = path.join(dependencyRoot, "invariant-suite");
  const actualPaths = existsSync(suiteRoot) ? listInvariantSuiteSources(suiteRoot) : [];
  if (expectedFiles.size > 0 && actualPaths.length === 0) {
    throw new Error(`artifact-contract failure: invariant suite artifact root is missing ${dependencyTask.attemptId}`);
  }
  if (
    actualPaths.length !== expectedFiles.size ||
    actualPaths.some((relativePath) => !expectedFiles.has(relativePath))
  ) {
    throw new Error("artifact-contract failure: invariant suite artifact set changed");
  }
  for (const relativePath of actualPaths) {
    const bytes = readInvariantSuiteSourceBytes(suiteRoot, relativePath, "artifact handoff invariant suite");
    const expected = expectedFiles.get(relativePath);
    if (expected === undefined) {
      throw new Error(`artifact-contract failure: unexpected invariant suite artifact ${relativePath}`);
    }
    if (bytes.length !== expected.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== expected.sha256) {
      throw new Error(`artifact-contract failure: invariant suite artifact changed ${relativePath}`);
    }
    rememberExpectedVerifiedPublication(publications, path.posix.join("invariant-suite", relativePath), bytes);
  }
}

function resolveRegularArtifactFile(artifactDir: string, artifactPath: string, failureMessage: string): string {
  try {
    assertRegularFileInside(artifactDir, artifactPath, failureMessage);
    const resolvedPath = realpathSync(artifactPath);
    if (!isStrictlyInsideDirectory(artifactDir, resolvedPath) || !statSync(resolvedPath).isFile()) {
      throw new Error(failureMessage);
    }
    return resolvedPath;
  } catch {
    throw new Error(failureMessage);
  }
}

function resolveNonEmptyRegularArtifactFile(
  artifactDir: string,
  artifactPath: string,
  missingFailureMessage: string,
  emptyFailureMessage: string
): string {
  const resolvedPath = resolveRegularArtifactFile(artifactDir, artifactPath, missingFailureMessage);
  if (statSync(resolvedPath).size === 0) {
    throw new Error(emptyFailureMessage);
  }
  return resolvedPath;
}

/**
 * Validate, publish, and attest one attempt's declared outputs.
 *
 * `evidence.agentReturned` is not a convenience flag, it is what makes this function's answer a
 * statement about work that actually happened (#677). Everything below it is a pure function of the
 * filesystem, and preparation deliberately seeds every goal lane's mirror with the canonical empty
 * findings array so that a lane which genuinely searched and found nothing still satisfies its
 * contract. Those two facts together are a laundering machine. Once goal lanes carry
 * `continueOnFail`, a lane killed at its timeout is TERMINAL, so Smithers makes its verifier
 * runnable; a filesystem-only verifier then finds the seeded `[]`, validates it, copies it into the
 * canonical artifact directory and writes a verification marker over it. Downstream -- through
 * `goalSearchDependencyIsUnverified`, `assertVerifiedDependency`, `dependencyFindingSources` and
 * `materializeMissingDedupeArtifact` -- that lane reads as a completed search with zero findings. For
 * a security audit that is strictly worse than the 97-event cascade the tolerance replaced: it
 * attests to a search nobody ran, and the attestation is indistinguishable from a real negative.
 *
 * So the caller must state whether the agent returned, and the answer has to come from Smithers' own
 * durable output row rather than from anything in the workspace. A row is written by the engine when
 * a task completes, before the completion is reported and therefore before any render can see the
 * task as terminal; a killed, cancelled, credit-exhausted, or disconnected attempt has none; and no
 * model can author one. Bytes in the worktree prove nothing by comparison -- an agent that wrote an
 * empty `findings.json` early and was then killed mid-search leaves exactly the artifact a
 * successful negative result leaves.
 *
 * Refusal THROWS rather than returning a row, and that is deliberate: `outputs.verification` is
 * itself consumed as evidence (`recordGoalSearchCoverage` reads it to decide `unverified` versus
 * `completed`, and `readyGroupIds` gates dynamic expansion on it), so a "verified nothing" row would
 * relocate the same lie one level up. The failing verifier is the honest outcome; `continueOnFail`
 * on a goal lane's verifier is what keeps that failure from cascading, and it can no longer turn a
 * refusal into an attestation.
 *
 * The check is not scoped to goal lanes. No other group can reach it -- without `continueOnFail` a
 * non-goal agent task is terminal only when it succeeded, so its row always exists -- but a
 * `continueOnFail` added elsewhere later must fail closed here by default instead of silently
 * inheriting this hole.
 */
function verifyArtifacts(
  task: (typeof taskSpecs)[number],
  evidence: { agentReturned: boolean }
): z.infer<typeof verificationOutput> {
  const artifactDir = realpathSync(task.metadata.artifacts.dir);
  // A model-controlled workspace can pre-create arbitrary sidecars. Remove
  // any stale marker before validating so only this verifier can publish the
  // success boundary consumed by downstream preparation tasks.
  clearArtifactVerificationMarker(task);
  if (evidence.agentReturned !== true) {
    // Ordered after the clear on purpose. The in-agent verification runs inside the agent task, before
    // Smithers commits that task's row, so an attempt killed in exactly that window can leave a marker
    // behind with no row to back it. Demoting such a lane means REMOVING the marker, not merely
    // declining to write one -- otherwise `goalSearchDependencyIsUnverified` would still report it
    // verified and every consumer would read the stale attestation.
    throw new Error(
      `artifact-contract failure: refusing to verify ${task.attemptId} because its agent produced no output row`
    );
  }
  const artifactRoots = taskArtifactRoots(task, artifactDir);
  verifyInvariantLedgerSourceEvidence(task, artifactRoots);
  const publications = new Map<string, Buffer>();
  const artifacts = task.outputs.map((output) => {
    const canonicalPath = path.resolve(artifactDir, output.path);
    if (!isStrictlyInsideDirectory(artifactDir, canonicalPath)) {
      throw new Error(`artifact-contract failure: unsafe output path ${output.path}`);
    }
    const failureMessage = `artifact-contract failure: output is not a regular file ${output.path}`;
    let artifactRoot: string | undefined;
    let resolvedPath: string | undefined;
    for (const candidateRoot of artifactRoots) {
      try {
        resolvedPath = resolveRegularArtifactFile(
          candidateRoot,
          path.resolve(candidateRoot, output.path),
          failureMessage
        );
        artifactRoot = candidateRoot;
        break;
      } catch {
        // Try the exact task-owned worktree mirror before failing closed.
      }
    }
    if (artifactRoot === undefined || resolvedPath === undefined) {
      throw new Error(failureMessage);
    }
    const bytes = readFileSync(resolvedPath);
    const contents = bytes.toString("utf8");
    const validation = validateArtifactContract(output.contract, contents, output.path);
    if (!validation.ok) {
      throw new Error(
        `artifact-contract failure for ${output.path} (${output.contract}): ${formatSchemaValidationIssues(validation.issues)}`
      );
    }
    rememberVerifiedPublication(publications, output.path, bytes);
    if (output.contract === "ultrafuzz/generated-tests@1") {
      for (const companion of verifyGeneratedTestFiles(artifactRoot, validation.value)) {
        rememberVerifiedPublication(publications, companion.path, companion.contents);
      }
    }
    if (output.contract === "ultrafuzz/goal-plan@1") {
      for (const selected of verifyGoalPlanSelectedRecordSnapshots(artifactRoot, validation.value)) {
        rememberVerifiedPublication(publications, selected.path, selected.contents);
      }
    }
    return {
      path: output.path,
      contract: output.contract,
      contract_digest: output.contractDigest,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      primary: output.primary
    };
  });
  if (invariantSuiteNodeIds.has(task.metadata.node.logicalNodeId)) {
    rememberInvariantSuitePublications(task, publications, artifactRoots);
  }
  const primary = artifacts.find((artifact) => artifact.primary);
  if (primary === undefined) {
    throw new Error("artifact-contract failure: primary artifact is missing");
  }
  publishVerifiedArtifacts(artifactDir, publications);
  writeArtifactVerificationMarker(task, artifacts, publications);
  return { artifacts, primary_artifact: primary.path };
}

function readInvariantSourceSnapshot(
  workspaceRoot: string,
  relativePath: string,
  label: "scan probe" | "invariant source"
): { bytes: Buffer; content: string } {
  const sourceCandidate = path.resolve(workspaceRoot, relativePath);
  if (!isStrictlyInsideDirectory(workspaceRoot, sourceCandidate)) {
    throw new Error(`artifact-contract failure: invariant ${label} path escapes the task workspace: ${relativePath}`);
  }
  let sourcePath: string;
  try {
    sourcePath = resolveRegularArtifactFile(workspaceRoot, sourceCandidate, `${label} is not a regular file`);
  } catch (error) {
    throw new Error(
      `artifact-contract failure: invariant ${label} ${relativePath} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  const bytes = readFileSync(sourcePath);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`artifact-contract failure: invariant ${label} ${relativePath} is binary`);
  }
  if (content.includes("\u0000")) {
    throw new Error(`artifact-contract failure: invariant ${label} ${relativePath} is binary`);
  }
  if (
    usesPinnedSource &&
    !checkInvariantSourcePinned({ workspacePath: workspaceRoot, relativePath, bytes, ref: pinnedSourceRef }).ok
  ) {
    throw new Error(`artifact-contract failure: invariant ${label} ${relativePath} is not pinned and unchanged`);
  }
  return { bytes, content };
}

function verifyInvariantLedgerSourceEvidence(task: (typeof taskSpecs)[number], artifactRoots: readonly string[]): void {
  if (task.metadata.node.logicalNodeId !== "project-discovery") {
    return;
  }
  const ledgerOutput = task.outputs.find((output) => output.path === "setup/invariant-evidence-ledger.json");
  if (ledgerOutput === undefined) {
    return;
  }
  let ledgerPath: string | undefined;
  for (const root of artifactRoots) {
    try {
      ledgerPath = resolveRegularArtifactFile(
        root,
        path.resolve(root, ledgerOutput.path),
        "artifact-contract failure: invariant ledger is not a regular file"
      );
      break;
    } catch {
      // The normal output verifier below reports the missing artifact.
    }
  }
  if (ledgerPath === undefined) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(ledgerPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `artifact-contract failure: invariant ledger JSON is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  const validation = validateInvariantLedgerSchema(parsed, ledgerPath);
  if (!validation.ok || validation.value === undefined) {
    return;
  }
  const ledgerBytes = readFileSync(ledgerPath);
  const files = new Map<string, { path: string; sha256: string; content: string }>();
  const sourceSnapshots = new Map<string, { bytes: Buffer; content: string }>();
  const workspacePath = path.resolve(task.workspacePath);
  const workspaceStat = lstatSync(workspacePath);
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink() || realpathSync(workspacePath) !== workspacePath) {
    throw new Error("artifact-contract failure: invariant discovery workspace is not a canonical directory");
  }
  const workspaceRoot = workspacePath;
  for (const probe of validation.value.scan_probes) {
    const probeCandidate = path.resolve(workspaceRoot, probe.source_path);
    const isSafeRelativeProbe = isSafeInvariantProbePath(probe.source_path);
    const isWorkspaceRootProbe = isSafeRelativeProbe && probeCandidate === workspaceRoot;
    if (!isSafeRelativeProbe || (!isWorkspaceRootProbe && !isStrictlyInsideDirectory(workspaceRoot, probeCandidate))) {
      throw new Error(
        `artifact-contract failure: invariant scan probe path escapes the task workspace: ${probe.source_path}`
      );
    }
    if (isWorkspaceRootProbe) {
      if (
        !workspaceStat.isDirectory() ||
        workspaceStat.isSymbolicLink() ||
        realpathSync(workspacePath) !== workspacePath
      ) {
        throw new Error(
          `artifact-contract failure: invariant repository-root scan probe requires a canonical workspace directory: ${probe.source_path}`
        );
      }
      // A repository-wide probe names the workspace directory itself. It is
      // valid evidence, but cannot be snapshotted as a regular UTF-8 file.
      continue;
    }
    if (!invariantPathParentsInsideWorkspace(workspaceRoot, probeCandidate)) {
      throw new Error(
        `artifact-contract failure: invariant scan probe path crosses a symlinked parent: ${probe.source_path}`
      );
    }
    // Scan probes may intentionally target optional files. When a probe path
    // is absent, its result text is the durable evidence of that absence.
    let probeStat: ReturnType<typeof lstatSync>;
    try {
      probeStat = lstatSync(probeCandidate);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    // A directory probe names where the agent searched, exactly like the repository-root probe
    // above. It is valid evidence but cannot be snapshotted as a regular UTF-8 file (issue #289).
    if (probeStat.isDirectory() && !probeStat.isSymbolicLink()) {
      continue;
    }
    const snapshot = readInvariantSourceSnapshot(workspaceRoot, probe.source_path, "scan probe");
    sourceSnapshots.set(probe.source_path, snapshot);
    files.set(probe.source_path, {
      path: probe.source_path,
      sha256: createHash("sha256").update(snapshot.bytes).digest("hex"),
      content: snapshot.content
    });
  }
  for (const entry of validation.value.entries) {
    const snapshot =
      sourceSnapshots.get(entry.source_path) ??
      readInvariantSourceSnapshot(workspaceRoot, entry.source_path, "invariant source");
    sourceSnapshots.set(entry.source_path, snapshot);
    const sourceBytes = snapshot.bytes;
    const source = snapshot.content;
    const locationMatch = /^(?:line|lines)\s+(\d+)(?:\s*[-–]\s*(\d+))?/iu.exec(entry.source_location);
    const sourceLines =
      locationMatch === null
        ? undefined
        : source.split(/\r\n|\r|\n/u).slice(Number(locationMatch[1]) - 1, Number(locationMatch[2] ?? locationMatch[1]));
    const locatedSource = sourceLines === undefined ? source : normalizeInvariantSourceLines(sourceLines);
    const sourceMatches =
      locationMatch === null
        ? symbolFromInvariantLocation(entry.source_location) !== undefined &&
          invariantSymbolDeclaration(source, symbolFromInvariantLocation(entry.source_location)!) !== undefined &&
          normalizeInvariantSourceLines(
            invariantSymbolDeclaration(source, symbolFromInvariantLocation(entry.source_location)!)!.split(/\r?\n/u)
          ).includes(normalizeInvariantSourceLines([entry.verbatim]))
        : locatedSource === normalizeInvariantSourceLines([entry.verbatim]);
    if (!sourceMatches) {
      const expected = sourceLines === undefined ? undefined : normalizeInvariantSourceLines(sourceLines);
      const expectedDetail = expected === undefined ? "the source declaration" : JSON.stringify(expected);
      throw new Error(
        `artifact-contract failure: invariant ledger entry ${entry.id} does not preserve source text at ${entry.source_location}; expected ${expectedDetail}, received ${JSON.stringify(entry.verbatim)}. Derive verbatim from the cited source with a JSON serializer so repeated backslashes and other literals remain intact.`
      );
    }
    if (!files.has(entry.source_path)) {
      files.set(entry.source_path, {
        path: entry.source_path,
        sha256: createHash("sha256").update(sourceBytes).digest("hex"),
        content: source
      });
    }
  }
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspaceRoot, encoding: "utf8" })
    .trim()
    .toLowerCase();
  const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: workspaceRoot,
    encoding: "utf8"
  })
    .trim()
    .toLowerCase();
  const proof = {
    schema_version: "ultrafuzz.invariant-source-proof.v1",
    attempt_id: task.attemptId,
    commit,
    tree,
    ledger_sha256: createHash("sha256").update(ledgerBytes).digest("hex"),
    files: [...files.values()]
  };
  const proofValidation = validateInvariantSourceProofSchema(proof, "invariant-source-proof");
  if (!proofValidation.ok) {
    throw new Error(
      `artifact-contract failure: invariant source proof is invalid: ${formatSchemaValidationIssues(proofValidation.issues)}`
    );
  }
  const runRoot = realpathSync(path.resolve(process.cwd(), task.metadata.artifacts.dir, "..", ".."));
  const proofRoot = path.join(runRoot, "source-proofs");
  const proofPath = path.join(proofRoot, `${task.attemptId}.invariant.json`);
  if (!isStrictlyInsideDirectory(runRoot, proofRoot) || !isStrictlyInsideDirectory(proofRoot, proofPath)) {
    throw new Error(`artifact-contract failure: unsafe invariant source proof path ${task.attemptId}`);
  }
  mkdirSync(proofRoot, { recursive: true });
  const resolvedProofRoot = realpathSync(proofRoot);
  if (resolvedProofRoot !== proofRoot || !isStrictlyInsideDirectory(runRoot, resolvedProofRoot)) {
    throw new Error(`artifact-contract failure: unsafe invariant source proof root ${task.attemptId}`);
  }
  writeFileDurable(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
}

function normalizeInvariantSourceLines(lines: readonly string[]): string {
  return lines
    .flatMap((line) => line.replace(/\r\n?/gu, "\n").split("\n"))
    .map((line) => line.replace(/^\s*(?:[-*+]\s+|>\s+)/u, ""))
    .join("\n")
    .replace(/\n+$/u, "");
}

function symbolFromInvariantLocation(location: string): string | undefined {
  return /([A-Za-z_$][A-Za-z0-9_$]*)\s*$/u.exec(location)?.[1];
}

function escapeRegExpForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function invariantSymbolDeclaration(source: string, symbol: string): string | undefined {
  const declaration = new RegExp(
    `\\b(?:function|contract|library|interface|modifier|event|error|struct|enum)\\s+(?:[A-Za-z_$][A-Za-z0-9_$]*\\.)?${escapeRegExpForPattern(symbol)}\\b`,
    "u"
  ).exec(source);
  if (declaration === null || declaration.index === undefined) return undefined;
  const tail = source.slice(declaration.index + declaration[0].length);
  const next = /\n\s*(?:function|contract|library|interface|modifier|event|error|struct|enum)\s+/u.exec(tail);
  return source.slice(declaration.index, declaration.index + declaration[0].length + (next?.index ?? tail.length));
}

function invariantPathParentsInsideWorkspace(workspaceRoot: string, candidatePath: string): boolean {
  let current = path.dirname(candidatePath);
  while (current !== workspaceRoot) {
    if (!isStrictlyInsideDirectory(workspaceRoot, current)) return false;
    try {
      return realpathSync(current) === current;
    } catch (error) {
      if (!isMissingPathError(error)) return false;
      try {
        if (lstatSync(current).isSymbolicLink()) return false;
      } catch (lstatError) {
        if (!isMissingPathError(lstatError)) return false;
      }
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
  return true;
}

function isSafeInvariantProbePath(relativePath: string): boolean {
  return (
    !path.isAbsolute(relativePath) &&
    !relativePath.includes("\u0000") &&
    !relativePath.includes("\\") &&
    !/^[A-Za-z]:/u.test(relativePath) &&
    !relativePath.split("/").includes("..")
  );
}

function rememberVerifiedPublication(publications: Map<string, Buffer>, relativePath: string, contents: Buffer): void {
  const previous = publications.get(relativePath);
  if (previous !== undefined && !previous.equals(contents)) {
    throw new Error(`artifact-contract failure: conflicting verified output path ${relativePath}`);
  }
  publications.set(relativePath, contents);
}

function publishVerifiedArtifacts(artifactDir: string, publications: ReadonlyMap<string, Buffer>): void {
  for (const [relativePath, contents] of [...publications].sort(([left], [right]) => left.localeCompare(right))) {
    publishFileDurableExclusive(artifactDir, relativePath, contents);
  }
}

function artifactVerificationMarkerLocation(
  runRoot: string,
  attemptId: string,
  createRoot: boolean
): { root: string; path: string; relativePath: string } | undefined {
  const resolvedRunRoot = realpathSync(runRoot);
  const rootCandidate = path.resolve(resolvedRunRoot, ARTIFACT_VERIFICATION_DIRECTORY);
  if (!isStrictlyInsideDirectory(resolvedRunRoot, rootCandidate)) {
    throw new Error("artifact-contract failure: unsafe artifact verification marker root");
  }
  if (createRoot) {
    mkdirSync(rootCandidate, { recursive: true, mode: 0o700 });
  }
  let rootStat: ReturnType<typeof lstatSync>;
  try {
    rootStat = lstatSync(rootCandidate);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("artifact-contract failure: unsafe artifact verification marker root");
  }
  const root = realpathSync(rootCandidate);
  if (root !== rootCandidate || !isStrictlyInsideDirectory(resolvedRunRoot, root)) {
    throw new Error("artifact-contract failure: unsafe artifact verification marker root");
  }
  const relativePath = `${attemptId}.json`;
  const markerPath = path.resolve(root, relativePath);
  if (!isStrictlyInsideDirectory(root, markerPath)) {
    throw new Error("artifact-contract failure: unsafe artifact verification marker path");
  }
  return { root, path: markerPath, relativePath };
}

function clearArtifactVerificationMarker(task: (typeof taskSpecs)[number]): void {
  const location = artifactVerificationMarkerLocation(task.runRoot, task.attemptId, false);
  if (location === undefined) return;
  try {
    const stat = lstatSync(location.path);
    if (stat.isDirectory()) {
      throw new Error("artifact-contract failure: artifact verification marker is a directory");
    }
    rmSync(location.path, { force: true });
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
}

function writeArtifactVerificationMarker(
  task: (typeof taskSpecs)[number],
  artifacts: readonly {
    path: string;
    contract: string;
    contract_digest: string;
    sha256: string;
    primary: boolean;
  }[],
  publications: ReadonlyMap<string, Buffer>
): void {
  const location = artifactVerificationMarkerLocation(task.runRoot, task.attemptId, true);
  if (location === undefined) {
    throw new Error(`artifact-contract failure: verification marker root is unavailable ${task.attemptId}`);
  }
  const publicationEntries = [...publications]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, contents]) => {
      assertSafeVerifiedPublicationPath(relativePath);
      return {
        path: relativePath,
        sha256: createHash("sha256").update(contents).digest("hex")
      };
    });
  if (publicationEntries.length === 0) {
    throw new Error(`artifact-contract failure: verification marker has no publications ${task.attemptId}`);
  }
  const marker = `${JSON.stringify(
    {
      schema_version: ARTIFACT_VERIFICATION_SCHEMA_VERSION,
      attempt_id: task.attemptId,
      node_id: task.metadata.node.logicalNodeId,
      artifacts,
      publications: publicationEntries
    },
    null,
    2
  )}\n`;
  publishFileDurableExclusive(location.root, location.relativePath, marker);
}

function verifyGeneratedTestFiles(artifactDir: string, value: unknown): Array<{ path: string; contents: Buffer }> {
  const entries = (value as { generated_tests?: Array<{ path?: string }> }).generated_tests ?? [];
  return entries.map((entry) => {
    const relativePath = entry.path ?? "";
    const artifactPath = path.resolve(artifactDir, relativePath);
    if (!isStrictlyInsideDirectory(artifactDir, artifactPath)) {
      throw new Error(`artifact-contract failure: unsafe generated test path ${relativePath}`);
    }
    const resolvedPath = resolveNonEmptyRegularArtifactFile(
      artifactDir,
      artifactPath,
      `artifact-contract failure: generated test file is missing ${relativePath}`,
      `artifact-contract failure: generated test file is empty ${relativePath}`
    );
    return { path: relativePath, contents: readFileSync(resolvedPath) };
  });
}

/**
 * Where the run-level goal-search census lives.
 *
 * The run root, beside `source-proofs/` and `.ultrafuzz-verification/`, because this is the same kind
 * of thing they are: a runtime-owned, model-free record about a run rather than a declared node
 * artifact. Putting it here instead of adding a topology output is deliberate -- a new declared output
 * would have to be produced by SOME node, and every candidate is either a node that may itself have
 * been killed (a goal lane) or a node whose output is agent-authored (`dedupe-findings`,
 * `final-report`), and coverage honesty is exactly the claim an agent must not be the source of.
 *
 * An absent run root returns `undefined` rather than throwing, following
 * `artifactVerificationMarkerLocation`: this census is diagnostic evidence, and a run whose root is
 * not materialized yet must not have its render aborted over it. An UNSAFE path still throws, because
 * that is a security signal and not a missing file.
 */
function goalSearchCoveragePath(runRoot: string): string | undefined {
  let resolvedRunRoot: string;
  try {
    resolvedRunRoot = realpathSync(path.resolve(process.cwd(), runRoot));
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
  const candidate = path.resolve(resolvedRunRoot, GOAL_SEARCH_COVERAGE_FILE);
  if (!isStrictlyInsideDirectory(resolvedRunRoot, candidate)) {
    throw new Error("goal-coverage failure: unsafe goal search coverage path");
  }
  return candidate;
}

/**
 * How many findings did this goal lane actually publish?
 *
 * Only the CANONICAL artifact directory is read, never the task worktree mirror. The canonical bytes
 * are the ones `publishVerifiedArtifacts` wrote and `writeArtifactVerificationMarker` then bound to a
 * digest, so a count taken from them is a count of verified findings. `undefined` means the count is
 * unknown, and the census says so rather than reporting zero -- an unknown count reported as zero is
 * the precise mistake this whole record exists to prevent.
 */
function verifiedGoalSearchFindingCount(task: (typeof taskSpecs)[number]): number | undefined {
  const findingsOutput = task.outputs.find((output) => output.primary && output.contract === "ultrafuzz/findings@1");
  if (findingsOutput === undefined) {
    return undefined;
  }
  try {
    const artifactDir = realpathSync(path.resolve(process.cwd(), task.metadata.artifacts.dir));
    const resolvedPath = resolveRegularArtifactFile(
      artifactDir,
      path.resolve(artifactDir, findingsOutput.path),
      `artifact-contract failure: output is not a regular file ${findingsOutput.path}`
    );
    const validation = validateArtifactContract(
      "ultrafuzz/findings@1",
      readFileSync(resolvedPath, "utf8"),
      findingsOutput.path
    );
    return validation.ok && Array.isArray(validation.value) ? validation.value.length : undefined;
  } catch {
    return undefined;
  }
}

/** Last recorded lane-state signature per run root; see `recordGoalSearchCoverage`. */
const goalSearchCoverageSignatures = new Map<string, string>();

/**
 * Record which goal searches completed and which did not (issue #677).
 *
 * This is the honesty counterpart to `continueOnFail` on the goal lanes. Once a goal search may end
 * with no output and the run still finishes, the difference between "77 classes were hunted and none
 * was exploitable" and "3 of 77 classes were hunted" is invisible in the artifacts -- both leave the
 * same empty `findings.json` behind, because preparation seeds every goal lane with the canonical
 * empty findings array so that a lane which produced nothing still satisfies its contract. The
 * distinguishing evidence is not in the artifacts at all; it is in Smithers' own durable output rows,
 * which is why the two probes are passed in from the render:
 *
 *   - no `outputs.task` row  -> the agent never returned. Timed out, killed, or failed outright. This
 *     is the 7200000ms case, and it is the one that must never be read as coverage.
 *   - a task row but no `outputs.verification` row -> the agent returned but its artifacts did not
 *     satisfy their contract. Also not coverage, and distinct from the case above, because the two
 *     have different fixes: one is a budget problem, the other is a contract problem.
 *   - both rows -> the search ran to completion, and the verified findings count says whether the
 *     completed answer was positive or negative.
 *
 * Called on every render pass, so it is gated on a cheap lane-state signature built purely from
 * Smithers' in-memory output rows. Without that gate an 18-hour run would re-read and re-validate 88
 * findings documents on every one of thousands of renders; with it, the artifact reads happen only
 * when a lane actually settles. The gate is exact rather than merely cheap: published artifacts are
 * immutable once their verifier has produced its row, so the only way a lane's findings count can
 * change is a retry, and a retry necessarily moves the lane through the signature.
 */
function recordGoalSearchCoverage(
  tasks: typeof taskSpecs,
  hasAgentOutput: (nodeId: string) => boolean,
  hasVerification: (nodeId: string) => boolean
): void {
  const lanes = tasks.filter((task) => isGoalSearchTask(task));
  const runRoot = lanes[0]?.runRoot;
  if (runRoot === undefined) {
    return;
  }
  const signature = lanes
    .map((task) => `${task.attemptId}:${hasAgentOutput(task.id) ? 1 : 0}${hasVerification(task.verifierId) ? 1 : 0}`)
    .sort()
    .join("|");
  if (goalSearchCoverageSignatures.get(runRoot) === signature) {
    return;
  }
  const goals = lanes
    .map((task) => {
      const agentReturned = hasAgentOutput(task.id);
      const verified = agentReturned && hasVerification(task.verifierId);
      const findingCount = verified ? verifiedGoalSearchFindingCount(task) : undefined;
      const status = !agentReturned
        ? "stopped-early"
        : !verified
          ? "unverified"
          : findingCount === undefined
            ? "completed"
            : findingCount > 0
              ? "completed-with-findings"
              : "completed-no-findings";
      return {
        node_id: task.metadata.node.concreteNodeId,
        logical_node_id: task.metadata.node.logicalNodeId,
        attempt_id: task.attemptId,
        status,
        finding_count: findingCount ?? null
      };
    })
    .sort((left, right) => left.attempt_id.localeCompare(right.attempt_id));
  const count = (predicate: (status: string) => boolean): number =>
    goals.filter((goal) => predicate(goal.status)).length;
  const record = {
    schema_version: GOAL_SEARCH_COVERAGE_SCHEMA_VERSION,
    run_id: __ULTRAFUZZ_RUN_ID_LITERAL__,
    totals: {
      planned: goals.length,
      completed: count((status) => status.startsWith("completed")),
      completed_with_findings: count((status) => status === "completed-with-findings"),
      completed_no_findings: count((status) => status === "completed-no-findings"),
      stopped_early: count((status) => status === "stopped-early"),
      unverified: count((status) => status === "unverified")
    },
    goals
  };
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  const coveragePath = goalSearchCoveragePath(runRoot);
  if (coveragePath === undefined) {
    return;
  }
  writeFileDurable(coveragePath, contents);
  goalSearchCoverageSignatures.set(runRoot, signature);
}

/**
 * Read the census back, defensively.
 *
 * Absent, unparsable, or schema-mismatched is not an error here: it is the "coverage is unknown"
 * answer, and the caller stamps the same `"unavailable"` sentinel the property-implementation coverage
 * reconstruction already uses for its producer-free topologies. A relocated cloud worker legitimately
 * hits this path, because the census is written by the controller render into the controller run root.
 */
function readGoalSearchCoverage(runRoot: string): unknown | undefined {
  try {
    const coveragePath = goalSearchCoveragePath(runRoot);
    if (coveragePath === undefined) {
      return undefined;
    }
    const resolvedPath = resolveRegularArtifactFile(
      path.dirname(coveragePath),
      coveragePath,
      "goal-coverage failure: goal search coverage is not a regular file"
    );
    const parsed = JSON.parse(readFileSync(resolvedPath, "utf8")) as unknown;
    if (!isPlainRecord(parsed) || parsed.schema_version !== GOAL_SEARCH_COVERAGE_SCHEMA_VERSION) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function replaceReportGoalSearchCoverage(contents: string, coverage: unknown): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    return undefined;
  }
  if (!isPlainRecord(parsed)) {
    return undefined;
  }
  const report = { ...parsed };
  delete report.goal_search_coverage;
  return `${JSON.stringify({ ...report, goal_search_coverage: coverage }, null, 2)}\n`;
}

/**
 * Stamp the runtime-owned goal-search census into the terminal report (issue #677).
 *
 * Deliberately built as a twin of `reconstructAuthoritativeReportImplementationCoverage`: the report
 * is the stage the coverage claim is actually made at, `ultrafuzz/report@1` is a loose object so an
 * added top-level key validates unchanged, and the canonical projection preserves unknown report
 * fields, so the same mechanism that already carries authoritative property coverage into the report
 * carries authoritative goal coverage. Reconstructing it after the agent returns rather than asking
 * the agent for it is the whole point -- a model that ran out of budget is the last thing that should
 * be describing how much budget it had.
 *
 * The report agent cannot see this stamp, since it lands after the agent's own writes; making the
 * numbers visible to the reviewing and reporting agents while they work needs the run-root census file
 * named in `review/dedupe-findings.md` and `review/final-report.md`, which are prompt-owned.
 */
function reconstructAuthoritativeGoalSearchCoverage(task: (typeof taskSpecs)[number]): void {
  if (task.metadata.node.logicalNodeId !== "final-report") {
    return;
  }
  const reportOutput = task.outputs.find(
    (output) => output.path === "report.json" && output.contract === "ultrafuzz/report@1"
  );
  if (reportOutput === undefined) {
    return;
  }
  const artifactDir = realpathSync(task.metadata.artifacts.dir);
  const reportPaths = taskArtifactRoots(task, artifactDir).flatMap((artifactRoot) => {
    try {
      return [
        resolveRegularArtifactFile(
          artifactRoot,
          path.resolve(artifactRoot, reportOutput.path),
          `artifact-contract failure: output is not a regular file ${reportOutput.path}`
        )
      ];
    } catch {
      return [];
    }
  });
  const coverage = readGoalSearchCoverage(task.runRoot) ?? "unavailable";
  for (const reportPath of reportPaths) {
    const reconstructed = replaceReportGoalSearchCoverage(readBoundedFinalReportJson(reportPath), coverage);
    if (reconstructed !== undefined) {
      writeFileDurable(reportPath, reconstructed);
    }
  }
}

export default smithers((ctx) => {
  // The dispatch is re-validated against the exact outer contract here, so an unknown or aliased
  // dispatch key is refused inside the workflow itself rather than only wherever it was submitted.
  const dispatch = parseWorkflowInput(ctx.input);
  const inputTasks = new Map(dispatch.tasks.map((task) => [task.id, task]));
  const operatorPromptInput =
    typeof dispatch.operator_prompt === "string" && dispatch.operator_prompt.length > 0
      ? dispatch.operator_prompt
      : undefined;
  const operatorPrompt = operatorPromptInput === undefined ? "" : `${operatorPromptInput}\n\n`;
  const cloudWorker = dispatch.cloud_worker === true;
  let availableTaskSpecs = taskSpecs;
  if (cloudWorker && dispatch.tasks.length > 0) {
    // A worker runs exactly the attempt the controller already materialized, and it reads that
    // attempt's prompt from the validated handoff path. An outer task entry has only two possible
    // effects here -- replacing the prompt body with attacker text, or naming a second attempt -- so
    // a non-empty `tasks` array is refused rather than filtered down to the dispatched ID.
    throw new Error("cloud worker dispatch must not carry outer task entries");
  }
  if (cloudWorker) {
    // The controller owns graph.json, smithers/tasks.json, expansion manifests, and template
    // snapshots. A worker receives its already-materialized selected task plus read-only dependency
    // specs reconstructed from this workflow's own compiled dynamic templates.
    availableTaskSpecs = cloudWorkerTaskSpecs(dispatch as Record<string, unknown>);
    // Only execution narrows to the selected attempt. Dependency identity lookups by attempt ID use
    // every compiled static attempt plus the generated dependency specs reconstructed above.
    const hydratedIds = new Set(availableTaskSpecs.map((task) => task.id));
    taskSpecs = [...taskSpecs.filter((task) => !hydratedIds.has(task.id)), ...availableTaskSpecs];
  } else if (dynamicGroupSpecs.length > 0) {
    const readyGroupIds = dynamicGroupSpecs
      .filter((group) => {
        if (group.source.verifierSmithersNodeId === undefined) {
          return existsSync(currentProjectPath(group.source.artifactPath, "dynamic source artifact"));
        }
        return ctx.outputMaybe(outputs.verification, { nodeId: group.source.verifierSmithersNodeId }) !== undefined;
      })
      .map((group) => group.groupNodeId);
    const materialized = materializeDynamicRuntime({
      runId: __ULTRAFUZZ_RUN_ID_LITERAL__,
      projectRoot: process.cwd(),
      runRoot: dynamicRunRoot,
      graphPath: dynamicGraphPath,
      tasksPath: dynamicTasksPath,
      ...(dynamicBaseGraphPath === undefined ? {} : { baseGraphPath: dynamicBaseGraphPath }),
      ...(dynamicBaseTasksPath === undefined ? {} : { baseTasksPath: dynamicBaseTasksPath }),
      baseTasks: compiledBaseTasks,
      groups: dynamicGroupSpecs,
      readyGroupIds
    });
    taskSpecs = taskSpecsFromCompiled(materialized.tasks as typeof compiledBaseTasks);
    availableTaskSpecs = dynamicallyAvailableTaskSpecs(taskSpecs, new Set(materialized.expandedGroupIds));
  }
  if (!cloudWorker) {
    // #677: record the goal-search census from Smithers' own durable output rows. Only the controller
    // renders the whole graph, so only the controller can see which goal lanes settled; a relocated
    // worker sees one attempt and must not overwrite a run-wide record from that keyhole view. This
    // runs on every render pass, which is also how the dynamic goal expansion above works, and the
    // writer is a no-op unless the bytes changed.
    recordGoalSearchCoverage(
      taskSpecs,
      (nodeId) => ctx.outputMaybe(outputs.task, { nodeId }) !== undefined,
      (nodeId) => ctx.outputMaybe(outputs.verification, { nodeId }) !== undefined
    );
  }
  const selectedTaskSpecs = cloudWorker
    ? availableTaskSpecs.filter((task) => task.id === dispatch.task_id)
    : availableTaskSpecs;
  if (cloudWorker && selectedTaskSpecs.length !== 1) {
    throw new Error("cloud worker task selection must identify exactly one concrete attempt");
  }
  return (
    <Workflow name={__ULTRAFUZZ_WORKFLOW_NAME__}>
      <Parallel id="ultrafuzz-agent-tasks">
        {selectedTaskSpecs.map((task) => {
          const inputTask = inputTasks.get(task.id);
          // #672/#677: finding no bug for an assigned goal is a NEGATIVE RESULT, not a run failure, so
          // a goal lane is allowed to fail without taking this `<Parallel>` -- and with it every fan-in
          // that depends on all 88 goals -- down with it. This is scoped to the `goals` topology group
          // on purpose and must stay that way: for every other node an absent artifact really is a
          // broken contract, and the 97-event cascade the 18-hour run produced was that contract
          // working exactly as designed. Both the agent task and its verifier carry the flag, because a
          // lane killed mid-write leaves artifacts its verifier will legitimately reject, and leaving
          // `verify:*` fatal would simply move the same cascade one node downstream. The preparation
          // task deliberately does NOT carry it: preparation is synchronous, deterministic, model-free
          // work, so a preparation failure is a real defect (#672) that should still fail loudly, and a
          // lane whose mirror was never prepared cannot produce a defensible negative result anyway.
          //
          // `continueOnFail` on a verifier means "this failure does not take the graph down", never
          // "this node cannot fail". Getting those two confused is what made the tolerance dangerous:
          // a killed lane's verifier became runnable AND unfailable, and because verification was a
          // pure function of the filesystem it happily attested the empty artifacts preparation had
          // seeded. `verifyArtifacts` now refuses without a durable agent output row, so for a lane
          // that never ran the verifier FAILS -- once, visibly, without cascading -- and the lane
          // stays unattested and unpublished. That is the outcome the flag is here to survive.
          //
          // Note that Smithers' `depsOptional` is not the lever here: it relaxes `deps`, the typed
          // render-time output wiring, and this template expresses dependencies with `dependsOn`
          // (ordering) plus its own artifact handoff. The equivalent tolerance therefore lives in
          // `assertTaskInputs`, which now treats a goal lane with no verification marker as a missing
          // dependency instead of a failed one, while still failing closed for every other class.
          // It is not the lever for the row gate below either, and not for lack of trying: wiring the
          // verifier as `deps` on the agent task resolves to this very probe internally, but an
          // unresolved dep DEFERS the node, and a deferral that survives to quiescence fails the whole
          // run with `DEPENDENCY_DEADLOCK` -- a killed goal lane would take the run down harder than
          // the cascade #677 removed. Relaxing that with the optional-deps flag then buys nothing the
          // plain probe does not already give, so the probe is read directly and the decision is made
          // inside `verifyArtifacts`, where it is one function's documented precondition instead of
          // three props spread across two execution modes.
          const goalSearch = isGoalSearchTask(task);
          // #677: does Smithers hold a durable output row for this attempt's agent task? This is the
          // only "did the work happen" evidence in the run that a model cannot author, and it is the
          // same probe the goal-search census uses, so the census and the verifier can never disagree.
          // Read during render deliberately: the engine re-renders after every task completion before
          // it schedules anything new (`requireRerenderOnOutputChange` defaults on), and the row is
          // persisted before the completion is reported, so the render that first makes this verifier
          // runnable is a render in which a successful agent's row is already visible. A cloud worker
          // renders the same lane against its own run state and reaches the same answer for it.
          const agentReturned = ctx.outputMaybe(outputs.task, { nodeId: task.id }) !== undefined;
          if (task.execution.mode === "cloud" && !cloudWorker) {
            if (cloudProvider === undefined || task.execution.provider !== "modal") {
              throw new Error("cloud execution provider is unavailable");
            }
            if (task.executionSnapshotRoot === undefined) {
              throw new Error("cloud execution requires a sealed workflow execution snapshot");
            }
            return (
              <Fragment key={task.id}>
                <Sandbox
                  id={task.id}
                  provider={cloudProvider}
                  input={{
                    schema_version: "ultrafuzz.modal.node.v1",
                    run_id: __ULTRAFUZZ_RUN_ID_LITERAL__,
                    task_id: task.id,
                    attempt_id: task.attemptId,
                    execution_generation: cloudExecutionGeneration,
                    execution_snapshot_root: cloudSnapshotRelativePath(
                      task.executionSnapshotRoot,
                      "workflow execution snapshot"
                    ),
                    workflow_path: cloudSnapshotRelativePath(task.workflowPath, "workflow path"),
                    ...(task.promptPath === undefined
                      ? {}
                      : { prompt_path: cloudSnapshotRelativePath(task.promptPath, "rendered prompt path") }),
                    run_root: task.runRoot,
                    artifact_dir: task.artifactRelativeDir,
                    workspace_dir: task.workspaceRelativePath,
                    dependency_artifact_dirs: task.dependencyArtifactDirs,
                    reference_artifact_dirs: task.referenceArtifactDirs ?? [],
                    ...(task.vulnerabilityDatabase === undefined
                      ? {}
                      : { vulnerability_database: task.vulnerabilityDatabase }),
                    selected_task: cloudSelectedTaskHandoff(task),
                    resources: {
                      cpu: task.execution.resources.cpu,
                      memory_mib: task.execution.resources.memoryMiB,
                      timeout_seconds: task.execution.resources.timeoutSeconds
                    },
                    agent_credential_env: task.execution.agentCredentialEnv,
                    ...(operatorPromptInput === undefined ? {} : { operator_prompt: operatorPromptInput })
                  }}
                  output={outputs.task}
                  dependsOn={task.dependsOn}
                  allowNetwork
                  reviewDiffs={false}
                  timeoutMs={task.execution.resources.timeoutSeconds * 1000}
                  heartbeatTimeoutMs={task.execution.resources.timeoutSeconds * 1000}
                  retries={task.retries}
                  retryPolicy={task.retryPolicy}
                  continueOnFail={goalSearch}
                  meta={task.metadata}
                />
                <Task
                  id={task.verifierId}
                  output={outputs.verification}
                  dependsOn={[task.id]}
                  retries={0}
                  continueOnFail={goalSearch}
                  metadata={{
                    category: "artifact-contract",
                    agentTaskId: task.id,
                    attemptId: task.attemptId,
                    executionMode: "cloud"
                  }}
                >
                  {() => verifyArtifacts(task, { agentReturned })}
                </Task>
              </Fragment>
            );
          }
          const fullTaskPrompt = renderEmbeddedPromptTemplate("agent prompt", agentPromptTemplate, {
            authorized_defensive_security_context: authorizedDefensiveSecurityContext,
            untrusted_content_boundary: untrustedContentBoundary,
            runtime_context: task.runtimeContext,
            operator_prompt: operatorPrompt,
            task_prompt: promptForTask(task, inputTask)
          });
          return (
            <Worktree
              key={task.id}
              path={task.workspacePath}
              branch={task.branch}
              baseBranch={usesPinnedSource ? pinnedSourceBranch : localSourceCommit}
            >
              <Task
                id={task.preparationId}
                output={outputs.preparation}
                dependsOn={cloudWorker ? [] : task.dependsOn}
                retries={0}
                metadata={{
                  category: "artifact-preparation",
                  agentTaskId: task.id,
                  attemptId: task.attemptId
                }}
              >
                {() => prepareArtifactMirror(task)}
              </Task>
              <Task
                id={task.id}
                output={outputs.task}
                agent={agentForTask(task)}
                dependsOn={[task.preparationId]}
                timeoutMs={task.timeoutMs}
                heartbeatTimeoutMs={task.heartbeatTimeoutMs}
                retries={cloudWorker ? 0 : task.retries}
                retryPolicy={task.retryPolicy}
                // Excluded on the cloud worker's own single-task render. There `continueOnFail` would let the
                // inner run finish despite a killed agent, so `smithers up` exits 0, the worker records a
                // "completed" durability checkpoint, and the sandbox retry then skips `runDurableWorkflow`
                // entirely -- spending the lane's second attempt on a publication retry instead of on
                // re-running the agent. A worker render has exactly one task and therefore no siblings to
                // protect, and an honest worker failure produces the identical controller-side outcome: no
                // agent output row, so `agentReturned` is false there too.
                continueOnFail={goalSearch && !cloudWorker}
                metadata={task.metadata}
              >
                {fullTaskPrompt}
              </Task>
              <Task
                id={task.verifierId}
                output={outputs.verification}
                dependsOn={[task.id]}
                retries={0}
                continueOnFail={goalSearch && !cloudWorker}
                metadata={{
                  category: "artifact-contract",
                  agentTaskId: task.id,
                  attemptId: task.attemptId
                }}
              >
                {() => verifyArtifacts(task, { agentReturned })}
              </Task>
            </Worktree>
          );
        })}
      </Parallel>
    </Workflow>
  );
});
