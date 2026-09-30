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
  type RunLayout,
  type SmithersTaskManifestTask
} from "@ultrafuzz/artifacts";
import { loadProjectConfig, redactDiagnostics, type ResolvedConfig } from "@ultrafuzz/config";
import { loadPromptCatalog, validatePromptVariables, type PromptCatalog } from "@ultrafuzz/prompts";
import { loadReferenceCatalog } from "@ultrafuzz/references";
import {
  assertExpandedGraphSchema,
  expandTopology,
  loadTopology,
  validateArtifactHandoffs,
  validateTopology,
  type ExpandedGraph,
  type ExpandedNode,
  type NormalizedProjectTopology
} from "@ultrafuzz/topology";

import { effectiveTopologyPath } from "./audit-profile-policy.js";
import { readDynamicRuntimeBase } from "./dynamic-expansion-retry.js";
import { renderRuntimePromptsFromTemplates, verifyDynamicRuntimeMaterialization } from "./dynamic-runtime.js";
import { renderRunStaticPrompts } from "./plan-run.js";
import { applyPromptRefresh, type PromptFileChange } from "./prompt-history.js";
import { assertExpandedGraphRetryChains } from "./retry-chain.js";
import { transformPromptCatalogForRun, transformTopologyForRun } from "./topology-transform.js";
import type { RenderedPromptPlan, RuntimeDiagnostic } from "./types.js";
import { sha256Stable } from "./utils.js";
import { modelProfilesForTopology } from "./validate.js";

const MAX_RUN_DOCUMENT_BYTES = 128 * 1024 * 1024;
const MAX_PROMPT_FILE_BYTES = 16 * 1024 * 1024;
/** Planning adds this output to reference nodes for `run --reference-expectations`; the topology never declares it. */
const REFERENCE_EXPECTATIONS_CONTRACT = "ultrafuzz/reference-expectations@2";
/** Output fields the installed build supplies; the run keeps the bindings it planned with. */
const BUILD_OWNED_OUTPUT_FIELDS = new Set([
  "contractDigest",
  "schemaFile",
  "schemaId",
  "schemaSha256",
  "schemaBundleSha256",
  "validatorBuild"
]);

/** What `resume` knows about the run before it resets, archives or submits anything. */
interface PromptRefreshContext {
  /** Each Smithers node's state before this resume; undefined for a run with no Smithers history. */
  nodeStates: ReadonlyMap<string, string> | undefined;
  /** The Smithers nodes this resume resets, and whether a reset also reopens the tasks after them. */
  resets: ReadonlyArray<{ nodeId: string; dependents: boolean }>;
  /** Smithers still reports the run active, so an engine may be reading its prompt files. */
  active: boolean;
}

interface RefreshInput {
  projectRoot: string;
  layout: RunLayout;
  /** The run's resolved config, frozen at launch. */
  config: ResolvedConfig;
  context: PromptRefreshContext;
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
 * rendered, and the template copies under `dynamic-prompt-templates/` from which every prompt not
 * rendered yet will be, such as unexpanded children and the final report.
 * `run.refresh_prompts_on_resume = false` in the project's current `ultrafuzz.toml` turns it off.
 *
 * It runs before this resume resets, archives or submits anything, and it never fails the resume:
 *
 * - When it cannot rebuild the run's plan exactly as launch built it, from the run's frozen config
 *   and the project's current topology and prompts, or the rebuilt topology differs from the run's,
 *   it changes nothing and returns one warning.
 * - A prompt is applied to every file rendered from it, or to none. One that `run` would reject, that
 *   cannot be rendered for one of its tasks, that would name an artifact authority a task was not
 *   compiled with, or that shares a template copy with a prompt whose new text differs, is not
 *   applied; it returns one warning naming the prompt and the reason.
 * - Every file it replaces is copied first to `prompt-history/<time>-<uuid>/`, where `refresh.json`
 *   lists each rewritten file with its old and new digests; each file is written atomically.
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
  if (plan.changes.length === 0) return diagnostics;
  try {
    diagnostics.push(applyPromptRefresh(input.layout.root, plan.changes));
  } catch (error) {
    diagnostics.push({
      code: "PROMPT_REFRESH_INCOMPLETE",
      message: `resume could not finish applying the project's current prompts, so some unfinished tasks keep the run's: ${errorMessage(error)}; the files it replaced are under prompt-history/, and the next resume applies the rest`,
      severity: "warning",
      source: "prompts"
    });
  }
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

/** What the refresh has decided so far. */
interface RefreshState {
  runRoot: string;
  /** Current text of each prompt the run uses that validated. */
  bodies: Map<string, string>;
  /** Prompts it does not apply, with the first reason. */
  rejected: Map<string, string>;
  /** The unfinished tasks and template copies each prompt would change, for its warning. */
  targets: Map<string, Set<string>>;
  /** Each template copy, relative to the run root, and the prompts rendered from it. */
  templates: Map<string, Set<string>>;
  changes: PromptFileChange[];
}

function planPromptRefresh(input: RefreshInput): { changes: PromptFileChange[]; rejections: PromptRejection[] } {
  const run = readLaunchedRun(input.layout);
  const { catalog, topology } = currentProjectInputs(input, run);
  const state: RefreshState = {
    runRoot: input.layout.root,
    bodies: new Map(),
    rejected: new Map(),
    targets: new Map(),
    templates: new Map(),
    changes: []
  };
  for (const prompt of new Set(run.promptByLogicalId.values())) {
    try {
      state.bodies.set(prompt, currentPromptBody(input.projectRoot, catalog, topology, prompt));
    } catch (error) {
      reject(state, prompt, errorMessage(error));
    }
  }
  const unfinished = unfinishedAttempts(run.tasks, input.context);
  refreshStaticPrompts(input, run, catalog, unfinished, state);
  refreshRuntimePrompts(input, run, unfinished, state);
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
 * the run's frozen config and the topology choices its plan records. A topology that no longer
 * expands to the run's graph throws, which skips the whole refresh.
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
  const topology = transformTopologyForRun(loadTopology(projectRoot, { topologyPath, validate: false }), transform);
  // Without a project root or prompt texts these check the topology's structure only; each prompt is
  // validated on its own, so one bad prompt cannot hide every other edit.
  const normalized = validateTopology(topology).topology;
  const current = expandTopology(topology, {
    runId: input.layout.runId,
    defaultTimeoutSeconds: config.run.defaultTimeoutSeconds,
    defaultMaxAttempts: config.retry.sameAgentAttempts,
    modelProfiles: modelProfilesForTopology(config),
    defaultModelProfileId: config.retry.agents[0] ?? config.models.default,
    ...(normalized.nodes.some((node) => node.kind === "reference")
      ? { referenceCatalog: loadReferenceCatalog(projectRoot) }
      : {})
  });
  assertExpandedGraphRetryChains(config, current);
  const difference = topologyChange(run.launchGraph, current);
  if (difference !== undefined) throw new Error(`the project's topology no longer matches the run's: ${difference}`);
  return {
    catalog: transformPromptCatalogForRun(loadPromptCatalog({ projectRoot, validateVariables: false }), transform),
    topology: normalized
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
    tryPropose(state, target.prompt, plan.attempt_id, () => {
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
 * Runtime prompts: the template copies, and the published prompts of unfinished generated or deferred
 * tasks, rendered as the next publishing render would render them. A prompt that waits on a group, or
 * is not published yet, is rendered later from its template copy.
 */
function refreshRuntimePrompts(
  input: RefreshInput,
  run: LaunchedRun,
  unfinished: ReadonlySet<string>,
  state: RefreshState
): void {
  const base = readDynamicRuntimeBase(state.runRoot);
  if (base === undefined) return;
  const materialization = verifyDynamicRuntimeMaterialization({
    runId: base.runId,
    projectRoot: input.projectRoot,
    runRoot: state.runRoot,
    graphPath: path.join(state.runRoot, "graph.json"),
    tasksPath: path.join(state.runRoot, "smithers", "tasks.json"),
    baseGraphPath: base.graphPath,
    baseTasksPath: base.tasksPath,
    baseTasks: base.tasks,
    groups: base.groups
  });
  for (const group of base.groups) {
    const prompt = run.promptByLogicalId.get(group.logicalNodeId);
    if (prompt !== undefined) addTemplateCopy(state, input.projectRoot, group.templatePath, prompt);
  }
  const expanded = new Set(materialization.expandedGroupIds);
  const published = new Map<string, { prompt: string; body: string }>();
  for (const task of materialization.tasks) {
    if (task.promptTemplatePath === undefined) continue;
    const prompt = promptOf(run, task);
    addTemplateCopy(state, input.projectRoot, task.promptTemplatePath, prompt);
    if (!unfinished.has(task.attemptId) || !(task.deferredPromptGroups ?? []).every((id) => expanded.has(id))) continue;
    markTarget(state, prompt, task.attemptId);
    const body = acceptedBody(state, prompt);
    const file = fs.lstatSync(path.join(state.runRoot, promptFilePath(task.attemptId)), { throwIfNoEntry: false });
    if (body !== undefined && file !== undefined) published.set(task.attemptId, { prompt, body });
  }
  const renders = renderRuntimePromptsFromTemplates({
    materialization,
    groups: base.groups,
    projectRoot: input.projectRoot,
    runRoot: state.runRoot,
    runId: base.runId,
    templates: new Map([...published].map(([attemptId, { body }]) => [attemptId, body]))
  });
  for (const [attemptId, render] of renders) {
    const target = published.get(attemptId);
    if (target === undefined) continue;
    tryPropose(state, target.prompt, attemptId, () => {
      if ("error" in render) throw new Error(render.error);
      return { relativePath: promptFilePath(attemptId), prompt: target.prompt, attemptId, next: render.markdown };
    });
  }
}

/** The task manifest records template copies relative to the project root. */
function addTemplateCopy(state: RefreshState, projectRoot: string, templatePath: string, prompt: string): void {
  const relativePath = path.relative(state.runRoot, path.resolve(projectRoot, templatePath)).split(path.sep).join("/");
  safeResolveInside(state.runRoot, relativePath, `template copy of ${prompt}`);
  state.templates.set(relativePath, (state.templates.get(relativePath) ?? new Set()).add(prompt));
  markTarget(state, prompt, relativePath);
}

/**
 * A template copy is named by the digest of its launch text and bound into the task manifest, so it
 * is rewritten in place, and only when every prompt behind it is applied with the same new text.
 * Rejecting one prompt can block another that shares a copy with it, so this repeats until stable.
 */
function settleTemplateCopies(state: RefreshState): void {
  for (let settled = false; !settled;) {
    settled = true;
    for (const [relativePath, prompts] of state.templates) {
      const conflict = templateConflict(state, prompts);
      if (conflict === undefined) continue;
      for (const prompt of [...prompts].filter((user) => isAccepted(state, user))) {
        reject(state, prompt, `it shares the template copy ${relativePath} with ${conflict(prompt)}`);
        settled = false;
      }
    }
  }
  for (const [relativePath, prompts] of state.templates) {
    const [prompt] = [...prompts].sort();
    const body = prompt === undefined ? undefined : acceptedBody(state, prompt);
    if (prompt === undefined || body === undefined) continue;
    try {
      propose(state, { relativePath, prompt, next: body });
    } catch (error) {
      for (const user of prompts) reject(state, user, `${relativePath}: ${errorMessage(error)}`);
    }
  }
}

function templateConflict(state: RefreshState, prompts: ReadonlySet<string>): ((prompt: string) => string) | undefined {
  const blocked = [...prompts].find((prompt) => !isAccepted(state, prompt));
  if (blocked !== undefined) return () => `${blocked}, which is not applied`;
  if (new Set([...prompts].map((prompt) => state.bodies.get(prompt))).size <= 1) return undefined;
  return (prompt) => `${[...prompts].filter((other) => other !== prompt).join(", ")}, whose new text differs`;
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

function tryPropose(state: RefreshState, prompt: string, label: string, change: () => PromptFileChange): void {
  try {
    propose(state, change());
  } catch (error) {
    reject(state, prompt, `${label}: ${errorMessage(error)}`);
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
function unfinishedAttempts(tasks: readonly SmithersTaskManifestTask[], context: PromptRefreshContext): Set<string> {
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

/**
 * The first structural difference between the run's launch graph and one expanded from the current
 * topology. Prompt digests and the schema bindings and contract digests the installed build supplies
 * are ignored: prompts are what the refresh applies, and bindings stay as the run planned them.
 */
function topologyChange(launched: ExpandedGraph, current: ExpandedGraph): string | undefined {
  const structure = (graph: ExpandedGraph): Map<string, string> =>
    new Map(graph.nodes.map((node) => [node.id, sha256Stable(structuralNode(node))]));
  const before = structure(launched);
  const after = structure(current);
  for (const nodeId of before.keys()) {
    if (!after.has(nodeId)) return `node ${nodeId} was removed`;
  }
  for (const [nodeId, digest] of after) {
    if (!before.has(nodeId)) return `node ${nodeId} was added`;
    if (before.get(nodeId) !== digest) return `node ${nodeId} changed`;
  }
  return sha256Stable(launched.groups) === sha256Stable(current.groups) ? undefined : "its groups changed";
}

function structuralNode(node: ExpandedNode): unknown {
  const { dynamic, outputs, ...rest } = node;
  return {
    ...rest,
    outputs: outputs
      .filter((output) => node.kind !== "reference" || output.contract !== REFERENCE_EXPECTATIONS_CONTRACT)
      .map((output) =>
        Object.fromEntries(Object.entries(output).filter(([key]) => !BUILD_OWNED_OUTPUT_FIELDS.has(key)))
      ),
    ...(dynamic === undefined
      ? {}
      : { dynamic: { from: dynamic.from, key: dynamic.key, nodeIdTemplate: dynamic.nodeIdTemplate } })
  };
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
