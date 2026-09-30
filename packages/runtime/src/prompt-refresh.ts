import fs from "node:fs";
import path from "node:path";

import {
  assertNoSymlinkComponents,
  assertRegularFileInside,
  parseSmithersTaskManifestBytes,
  parseStrictJsonBytes,
  readRegularFileSnapshot,
  readRunPlanDocument,
  safeResolveInside,
  sha256Bytes,
  type RunLayout,
  type SmithersTaskManifestDynamicGroup,
  type SmithersTaskManifestTask
} from "@ultrafuzz/artifacts";
import { loadProjectConfig, redactDiagnostics, type ResolvedConfig } from "@ultrafuzz/config";
import { loadPromptCatalog, validatePromptVariables, type PromptCatalog } from "@ultrafuzz/prompts";
import {
  assertExpandedGraphSchema,
  loadTopology,
  validateArtifactHandoffs,
  validateTopology,
  type ExpandedGraph,
  type NormalizedProjectTopology
} from "@ultrafuzz/topology";

import { effectiveTopologyPath } from "./audit-profile-policy.js";
import { readDynamicRuntimeBase } from "./dynamic-expansion-retry.js";
import {
  deriveDynamicRuntimeMaterialization,
  renderRuntimePromptsFromTemplates,
  type DynamicRuntimeMaterialization
} from "./dynamic-runtime.js";
import { renderRunStaticPrompts } from "./plan-run.js";
import { applyPromptRefresh, type PromptFileChange } from "./prompt-history.js";
import type { SmithersContinuationContext } from "./smithers.js";
import { transformPromptCatalogForRun, transformTopologyForRun } from "./topology-transform.js";
import type { RenderedPromptPlan, RuntimeDiagnostic } from "./types.js";

const MAX_RUN_DOCUMENT_BYTES = 128 * 1024 * 1024;
const MAX_PROMPT_FILE_BYTES = 16 * 1024 * 1024;

interface RefreshInput {
  projectRoot: string;
  layout: RunLayout;
  /** The run's resolved config, frozen at launch. */
  config: ResolvedConfig;
  context: SmithersContinuationContext;
}

/** A prompt whose current text is not applied: every file rendered from it keeps its bytes. */
interface PromptRejection {
  prompt: string;
  reason: string;
}

/**
 * `resume` applies the project's current prompts, `.ultrafuzz/prompts/**` and the packaged
 * built-ins selected exactly as `run` selects them, to every task of the run that has not finished.
 * A task has finished when Smithers reports its agent node `finished` and this resume does not reset
 * it. That covers static tasks, including those a reset reruns, generated children that are already
 * rendered, and the template copies under `dynamic-prompt-templates/` that a later render reads, such
 * as those of unexpanded children and of the final report. A group that this resume withdraws counts
 * as unexpanded, and the files of its generation move to `dynamic-expansion-history/` as they are.
 * `run.refresh_prompts_on_resume = false` in the project's current `ultrafuzz.toml` turns it off.
 *
 * It runs after every check that can refuse the resume before it resets or archives anything, and
 * before the first reset, and it never fails the resume:
 *
 * - When it cannot rebuild the run's plan exactly as launch built it, from the run's frozen config
 *   and the project's current topology and prompts, or the topology is not the one the run launched
 *   with, it changes nothing and returns one warning.
 * - A prompt is applied to every file rendered from it, or to none. One that `run` would reject, that
 *   cannot be rendered for one of its tasks, that would name an artifact authority a task was not
 *   compiled with, or that shares a template copy with a prompt whose new text differs, is not
 *   applied; it returns one warning naming the prompt and the reason.
 * - `prompt-history/<time>-<uuid>/refresh.json` lists every file it rewrites with its old and new
 *   digests before the first one changes, each old file is copied beside it, and each file is
 *   written atomically.
 */
export async function refreshRunPrompts(input: RefreshInput): Promise<RuntimeDiagnostic[]> {
  let enabled: boolean;
  try {
    enabled = await refreshEnabled(input.projectRoot);
  } catch (error) {
    return [skipped(`it cannot read run.refresh_prompts_on_resume from ultrafuzz.toml: ${errorMessage(error)}`)];
  }
  if (!enabled) return [];
  let plan: ReturnType<typeof planPromptRefresh>;
  try {
    // `resume` also continues bare Smithers runs that Ultrafuzz never planned; they have no prompts to refresh.
    if (fs.lstatSync(path.join(input.layout.root, "plan.json"), { throwIfNoEntry: false }) === undefined) return [];
    if (input.context.active) return [skipped("the workflow run is still active, so an engine may be reading them")];
    plan = planPromptRefresh(input);
  } catch (error) {
    return [skipped(errorMessage(error))];
  }
  const diagnostics = plan.rejections.map(rejectedWarning);
  if (plan.changes.length > 0) diagnostics.push(applyPromptRefresh(input.layout.root, plan.changes));
  return diagnostics;
}

async function refreshEnabled(projectRoot: string): Promise<boolean> {
  const loaded = await loadProjectConfig(projectRoot);
  if (!loaded.ok) {
    throw new Error(
      redactDiagnostics(loaded.diagnostics)
        .map((diagnostic) => diagnostic.message)
        .join("; ")
    );
  }
  return loaded.value.config.run?.refreshPromptsOnResume ?? true;
}

/** The run's own launch record: its plan, its expanded graph and its current task manifest. */
interface LaunchedRun {
  runPlan: ReturnType<typeof readRunPlanDocument>;
  launchGraph: ExpandedGraph;
  tasks: SmithersTaskManifestTask[];
  /** Catalog path of the prompt of each agentic logical node. */
  promptByLogicalId: ReadonlyMap<string, string>;
}

/** A dynamic run's runtime, as the next render derives it. */
interface RunRuntime {
  runId: string;
  groups: readonly SmithersTaskManifestDynamicGroup[];
  materialization: DynamicRuntimeMaterialization;
}

/** What the refresh has decided so far. */
interface RefreshState {
  runRoot: string;
  /** Current text of each prompt the run uses that validated. */
  bodies: Map<string, string>;
  /** Prompts it does not apply, with the first reason. */
  rejected: Map<string, string>;
  /** The unfinished tasks and template copies each prompt would change, for its warning. */
  targets: Map<string, Set<string>>;
  /**
   * Each template copy the run's groups and tasks name, relative to the run root, and the prompts
   * rendered from it.
   */
  templates: Map<string, Set<string>>;
  /** The template copies a later render reads; only these are rewritten. */
  liveTemplates: Set<string>;
  changes: PromptFileChange[];
}

function planPromptRefresh(input: RefreshInput): { changes: PromptFileChange[]; rejections: PromptRejection[] } {
  const run = readLaunchedRun(input.layout);
  const { catalog, topology } = currentProjectInputs(input, run);
  const runtime = deriveRunRuntime(input);
  const state: RefreshState = {
    runRoot: input.layout.root,
    bodies: new Map(),
    rejected: new Map(),
    targets: new Map(),
    templates: new Map(),
    liveTemplates: new Set(),
    changes: []
  };
  for (const prompt of new Set(run.promptByLogicalId.values())) {
    try {
      state.bodies.set(prompt, currentPromptBody(input.projectRoot, catalog, topology, prompt));
    } catch (error) {
      reject(state, prompt, errorMessage(error));
    }
  }
  // The derived runtime also lists generated children, with the dependencies the next render gives them.
  const unfinished = unfinishedAttempts(runtime?.materialization.tasks ?? run.tasks, input.context);
  refreshStaticPrompts(input, run, catalog, unfinished, state);
  if (runtime !== undefined) refreshRuntimePrompts(input, run, runtime, unfinished, state);
  settleTemplateCopies(state);
  return {
    changes: state.changes.filter((change) =>
      [...(change.attemptId === undefined ? (state.templates.get(change.relativePath) ?? []) : [change.prompt])].every(
        (prompt) => isAccepted(state, prompt)
      )
    ),
    // A prompt that no unfinished task or template copy uses changes nothing, so it needs no warning.
    rejections: [...state.rejected]
      .filter(([prompt]) => (state.targets.get(prompt)?.size ?? 0) > 0)
      .map(([prompt, reason]) => ({ prompt, reason }))
  };
}

function readLaunchedRun(layout: RunLayout): LaunchedRun {
  const runRoot = layout.root;
  const launchGraph = assertExpandedGraphSchema(
    parseStrictJsonBytes(readRunFile(runRoot, "smithers/expanded-graph.json", "expanded workflow graph"))
  );
  return {
    runPlan: readRunPlanDocument(path.join(runRoot, "plan.json"), layout.runId),
    launchGraph,
    tasks: parseSmithersTaskManifestBytes(readRunFile(runRoot, "smithers/tasks.json", "workflow task manifest")).tasks,
    promptByLogicalId: new Map(
      launchGraph.nodes.flatMap((node) =>
        node.kind === "agentic" && node.promptPath !== undefined ? [[node.logicalId, node.promptPath] as const] : []
      )
    )
  };
}

/**
 * The project's current topology and prompt catalog, loaded with the planning inputs launch used:
 * the run's frozen config and the topology choices its plan records. The refresh renders against the
 * run's own graph and checks each prompt's artifact handoffs against this topology, so it throws, which
 * skips the whole refresh, unless the topology file is the one the run launched with.
 */
function currentProjectInputs(
  input: RefreshInput,
  run: LaunchedRun
): { catalog: PromptCatalog; topology: NormalizedProjectTopology } {
  const { projectRoot, config } = input;
  const auditProfile = run.runPlan.audit_profile;
  const recordedLoops = auditProfile.effective_settings.strategy_loops;
  const strategyLoops =
    auditProfile.setting_origins.strategy_loops === "runtime-override" && typeof recordedLoops === "number"
      ? recordedLoops
      : config.strategyLoops;
  const transform = strategyLoops === undefined ? undefined : { strategyLoops };
  const topologyPath = effectiveTopologyPath({
    projectRoot,
    config,
    ...(auditProfile.topology_path_origin === "runtime-override"
      ? { runtimeTopologyPath: auditProfile.effective_topology_path }
      : {})
  });
  // Launch records the digest of the file's bytes, so any edit, even to a comment, skips the refresh.
  if (sha256Bytes(fs.readFileSync(topologyPath)) !== auditProfile.topology_digest) {
    throw new Error(`the topology ${auditProfile.effective_topology_path} changed since the run launched`);
  }
  const topology = transformTopologyForRun(loadTopology(projectRoot, { topologyPath, validate: false }), transform);
  // Without a project root or prompt texts this checks the topology's structure only; each prompt is
  // validated on its own, so one bad prompt cannot hide every other edit.
  const normalized = validateTopology(topology).topology;
  // An eval run can launch without some of the topology's nodes, which its plan does not record.
  const launched = new Set(run.launchGraph.nodes.map((node) => node.logicalId));
  if (normalized.nodes.length !== launched.size || normalized.nodes.some((node) => !launched.has(node.id))) {
    throw new Error("the run launched without some of its topology's nodes");
  }
  return {
    catalog: transformPromptCatalogForRun(loadPromptCatalog({ projectRoot, validateVariables: false }), transform),
    topology: normalized
  };
}

/** The dynamic runtime of a run that compiled a dynamic group, derived as the next render derives it. */
function deriveRunRuntime(input: RefreshInput): RunRuntime | undefined {
  const runRoot = input.layout.root;
  const base = readDynamicRuntimeBase(runRoot);
  if (base === undefined) return undefined;
  return {
    runId: base.runId,
    groups: base.groups,
    materialization: deriveDynamicRuntimeMaterialization({
      runId: base.runId,
      projectRoot: input.projectRoot,
      runRoot,
      graphPath: path.join(runRoot, "graph.json"),
      tasksPath: path.join(runRoot, "smithers", "tasks.json"),
      baseGraphPath: base.graphPath,
      baseTasksPath: base.tasksPath,
      baseTasks: base.tasks,
      groups: base.groups
    })
  };
}

/** Static prompts, rendered by planning's own renderer against the run's sealed graph and config. */
function refreshStaticPrompts(
  input: RefreshInput,
  run: LaunchedRun,
  catalog: PromptCatalog,
  unfinished: ReadonlySet<string>,
  state: RefreshState
): void {
  const taskByAttempt = new Map(run.tasks.map((task) => [task.attemptId, task]));
  const targets = new Map(
    run.runPlan.rendered_prompts
      .filter((row) => unfinished.has(row.attempt_id))
      .map((row) => {
        const task = taskByAttempt.get(row.attempt_id);
        if (task === undefined) throw new Error(`planned task ${row.attempt_id} is missing from the task manifest`);
        return [row.attempt_id, { task, prompt: promptOf(run, task) }] as const;
      })
  );
  for (const [attemptId, { prompt }] of targets) markTarget(state, prompt, attemptId);
  const { rendered, failures } = renderRunStaticPrompts({
    catalog,
    expandedGraph: run.launchGraph,
    layout: input.layout,
    projectRoot: input.projectRoot,
    resolvedConfig: input.config,
    attemptIds: new Set(
      [...targets].filter(([, { prompt }]) => isAccepted(state, prompt)).map(([attemptId]) => attemptId)
    )
  });
  for (const failure of failures) {
    const target = targets.get(failure.attemptId);
    if (target !== undefined) reject(state, target.prompt, `${failure.attemptId}: ${failure.message}`);
  }
  for (const { plan, result } of rendered) {
    const target = targets.get(plan.attempt_id);
    if (target === undefined) continue;
    tryPropose(state, [target.prompt], plan.attempt_id, () => {
      const relativePath = promptFilePath(plan.attempt_id);
      if (path.resolve(result.renderedPromptPath) !== path.join(state.runRoot, relativePath)) {
        throw new Error(`its prompt path is not ${relativePath}`);
      }
      const added = addedAuthoritySelectors(target.task, plan.artifact_references);
      if (added.length > 0) {
        throw new Error(`it names artifact authorities the task was not compiled with: ${added.join(", ")}`);
      }
      return { relativePath, prompt: target.prompt, attemptId: plan.attempt_id, next: result.renderedMarkdown };
    });
  }
}

/**
 * Runtime prompts: the published prompts of unfinished generated or deferred tasks, rendered as the
 * next publishing render would render them, and the template copies that a later render reads: those
 * of groups that have not expanded, and those of unfinished tasks whose prompt is not published yet.
 */
function refreshRuntimePrompts(
  input: RefreshInput,
  run: LaunchedRun,
  runtime: RunRuntime,
  unfinished: ReadonlySet<string>,
  state: RefreshState
): void {
  // A withdrawn group expands again from its template copy, and so do the prompts that wait on it;
  // their current files are the withdrawn generation's record, so they are left as they are.
  const withdrawn = new Set(input.context.withdrawnGroupIds);
  const expanded = new Set(runtime.materialization.expandedGroupIds.filter((groupId) => !withdrawn.has(groupId)));
  for (const group of runtime.groups) {
    const prompt = run.promptByLogicalId.get(group.logicalNodeId);
    if (prompt === undefined) continue;
    bindTemplateCopy(state, input.projectRoot, group.templatePath, prompt, !expanded.has(group.groupNodeId));
  }
  const published = new Map<string, { prompt: string; body: string }>();
  for (const task of runtime.materialization.tasks) {
    if (task.promptTemplatePath === undefined) continue;
    const prompt = promptOf(run, task);
    const groupId = task.metadata.node.dynamic?.groupNodeId;
    const open = unfinished.has(task.attemptId) && (groupId === undefined || !withdrawn.has(groupId));
    const hasPrompt =
      open &&
      (task.deferredPromptGroups ?? []).every((id) => expanded.has(id)) &&
      fs.lstatSync(path.join(state.runRoot, promptFilePath(task.attemptId)), { throwIfNoEntry: false }) !== undefined;
    bindTemplateCopy(state, input.projectRoot, task.promptTemplatePath, prompt, open && !hasPrompt);
    if (!hasPrompt) continue;
    markTarget(state, prompt, task.attemptId);
    const body = acceptedBody(state, prompt);
    if (body !== undefined) published.set(task.attemptId, { prompt, body });
  }
  const renders = renderRuntimePromptsFromTemplates({
    materialization: runtime.materialization,
    groups: runtime.groups,
    projectRoot: input.projectRoot,
    runRoot: state.runRoot,
    runId: runtime.runId,
    templates: new Map([...published].map(([attemptId, { body }]) => [attemptId, body]))
  });
  for (const [attemptId, render] of renders) {
    const target = published.get(attemptId);
    if (target === undefined) continue;
    tryPropose(state, [target.prompt], attemptId, () => {
      if ("error" in render) throw new Error(render.error);
      return { relativePath: promptFilePath(attemptId), prompt: target.prompt, attemptId, next: render.markdown };
    });
  }
}

/**
 * Records that `prompt` is rendered from this template copy, and whether a later render reads it.
 * The task manifest records template copies relative to the project root.
 */
function bindTemplateCopy(
  state: RefreshState,
  projectRoot: string,
  templatePath: string,
  prompt: string,
  read: boolean
): void {
  const relativePath = path.relative(state.runRoot, path.resolve(projectRoot, templatePath)).split(path.sep).join("/");
  safeResolveInside(state.runRoot, relativePath, `template copy of ${prompt}`);
  state.templates.set(relativePath, (state.templates.get(relativePath) ?? new Set()).add(prompt));
  if (!read) return;
  state.liveTemplates.add(relativePath);
  markTarget(state, prompt, relativePath);
}

/**
 * A template copy is named by the digest of its launch text and bound into the task manifest, so it
 * is rewritten in place, and only when every prompt rendered from it is applied with the same new
 * text; otherwise none of those prompts is applied. A prompt's only copy is the one named by its
 * launch text, so rejecting the prompts of one copy never affects another, and one pass settles all.
 */
function settleTemplateCopies(state: RefreshState): void {
  for (const relativePath of state.liveTemplates) {
    const users = [...(state.templates.get(relativePath) ?? [])].sort();
    const blocked = users.filter((prompt) => !isAccepted(state, prompt));
    const [first] = users;
    const next = first === undefined ? undefined : acceptedBody(state, first);
    if (first !== undefined && next !== undefined && users.every((prompt) => acceptedBody(state, prompt) === next)) {
      tryPropose(state, users, relativePath, () => ({ relativePath, prompt: first, next }));
      continue;
    }
    for (const prompt of users) {
      const others = (blocked.length > 0 ? blocked : users).filter((other) => other !== prompt);
      if (others.length === 0) continue;
      const why = blocked.length > 0 ? "which is not applied" : "whose new text differs";
      reject(state, prompt, `it shares the template copy ${relativePath} with ${others.join(", ")}, ${why}`);
    }
  }
}

function promptOf(run: LaunchedRun, task: SmithersTaskManifestTask): string {
  const prompt = run.promptByLogicalId.get(task.logicalNodeId);
  if (prompt === undefined) throw new Error(`task ${task.attemptId} has no prompt in the run's topology`);
  return prompt;
}

function promptFilePath(attemptId: string): string {
  return `artifacts/${attemptId}/prompt.rendered.md`;
}

function isAccepted(state: RefreshState, prompt: string): boolean {
  return state.bodies.has(prompt) && !state.rejected.has(prompt);
}

function acceptedBody(state: RefreshState, prompt: string): string | undefined {
  return state.rejected.has(prompt) ? undefined : state.bodies.get(prompt);
}

function reject(state: RefreshState, prompt: string, reason: string): void {
  if (!state.rejected.has(prompt)) state.rejected.set(prompt, reason);
}

function markTarget(state: RefreshState, prompt: string, target: string): void {
  state.targets.set(prompt, (state.targets.get(prompt) ?? new Set()).add(target));
}

/** Queue the change unless the file already holds these bytes; a file that is not regular throws. */
function propose(state: RefreshState, change: PromptFileChange): void {
  const current = currentPromptFile(state.runRoot, change.relativePath);
  if (current?.equals(Buffer.from(change.next, "utf8")) === true) return;
  state.changes.push({ ...change, ...(current === undefined ? {} : { previous: current }) });
}

/** Propose the change; when it cannot be, none of these prompts is applied. */
function tryPropose(
  state: RefreshState,
  prompts: readonly string[],
  label: string,
  change: () => PromptFileChange
): void {
  try {
    propose(state, change());
  } catch (error) {
    for (const prompt of prompts) reject(state, prompt, `${label}: ${errorMessage(error)}`);
  }
}

/**
 * The prompt `run` would select for this path, checked as `run` checks it: the project copy must be a
 * regular file, and its text must parse and name only artifacts of the node's ancestors.
 */
function currentPromptBody(
  projectRoot: string,
  catalog: PromptCatalog,
  topology: NormalizedProjectTopology,
  prompt: string
): string {
  const promptRoot = path.join(projectRoot, ".ultrafuzz", "prompts");
  const promptFile = safeResolveInside(promptRoot, prompt, "project prompt");
  assertNoSymlinkComponents(promptRoot, promptFile, "project prompt");
  assertRegularFileInside(promptRoot, promptFile, "project prompt");
  const entry = [...catalog.entries.values()].find((candidate) => candidate.relativePath === prompt);
  if (entry === undefined) throw new Error("it is not in the prompt catalog");
  validatePromptVariables(entry.body, { allowDynamicItemVariables: true });
  validateArtifactHandoffs(topology, { promptTexts: { [prompt]: entry.body } });
  return entry.body;
}

/**
 * Attempts whose agent has not finished, and finished ones this resume's resets reopen. Smithers
 * resets a node's dependents by start time, so a reset also reruns a finished task that merely
 * started after it; only the reset task and the tasks that depend on it are counted here.
 */
function unfinishedAttempts(
  tasks: readonly SmithersTaskManifestTask[],
  context: SmithersContinuationContext
): Set<string> {
  const ownerOf = new Map<string, SmithersTaskManifestTask>();
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    for (const nodeId of [task.preparationSmithersNodeId, task.smithersNodeId, task.verifierSmithersNodeId]) {
      ownerOf.set(nodeId, task);
    }
    for (const dependency of task.dependencies) {
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), task.attemptId]);
    }
  }
  const reopened = new Set<string>();
  for (const reset of context.resets) {
    const task = ownerOf.get(reset.nodeId);
    if (task === undefined) continue;
    // Resetting a verifier reruns the verifier, not the agent before it.
    if (reset.nodeId !== task.verifierSmithersNodeId) reopened.add(task.attemptId);
    if (!reset.dependents) continue;
    const pending = [...(dependents.get(task.attemptId) ?? [])];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (reopened.has(next)) continue;
      reopened.add(next);
      pending.push(...(dependents.get(next) ?? []));
    }
  }
  return new Set(
    tasks
      .filter((task) => context.nodeStates?.get(task.smithersNodeId) !== "finished" || reopened.has(task.attemptId))
      .map((task) => task.attemptId)
  );
}

/** Authority selectors the new render names that the task was not compiled with; dropping one is harmless. */
function addedAuthoritySelectors(
  task: SmithersTaskManifestTask,
  references: RenderedPromptPlan["artifact_references"]
): string[] {
  const compiled = new Set(
    (task.promptArtifactAuthoritySelectors ?? []).map((selector) =>
      selector.kind === "contract" ? `contract ${selector.contract}` : `path ${selector.id}`
    )
  );
  const named = references.flatMap((reference) =>
    reference.kind === "ancestor_contract_artifact_authority"
      ? [`contract ${reference.contract}`]
      : reference.kind === "ancestor_artifact_path_authority"
        ? [`path ${reference.selectorId}`]
        : []
  );
  return [...new Set(named)].filter((selector) => !compiled.has(selector)).sort();
}

/** The file's bytes, or undefined when it is missing; anything else at the path is refused. */
function currentPromptFile(runRoot: string, relativePath: string): Buffer | undefined {
  const filePath = safeResolveInside(runRoot, relativePath, "prompt file");
  assertNoSymlinkComponents(runRoot, filePath, "prompt file");
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (stat === undefined) return undefined;
  if (!stat.isFile()) throw new Error(`${relativePath} is not a regular file`);
  return readRegularFileSnapshot(filePath, MAX_PROMPT_FILE_BYTES);
}

function readRunFile(runRoot: string, relativePath: string, label: string): Buffer {
  const filePath = safeResolveInside(runRoot, relativePath, label);
  assertNoSymlinkComponents(runRoot, filePath, label);
  assertRegularFileInside(runRoot, filePath, label);
  return readRegularFileSnapshot(filePath, MAX_RUN_DOCUMENT_BYTES);
}

function rejectedWarning(rejection: PromptRejection): RuntimeDiagnostic {
  return {
    code: "PROMPT_REFRESH_REJECTED",
    message: `resume did not apply .ultrafuzz/prompts/${rejection.prompt}, so every task rendered from it keeps the run's prompt: ${rejection.reason}`,
    severity: "warning",
    source: "prompts",
    path: `.ultrafuzz/prompts/${rejection.prompt}`
  };
}

function skipped(reason: string): RuntimeDiagnostic {
  return {
    code: "PROMPT_REFRESH_SKIPPED",
    message: `resume kept the run's prompts instead of applying the project's current ones: ${reason}`,
    severity: "warning",
    source: "prompts"
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
