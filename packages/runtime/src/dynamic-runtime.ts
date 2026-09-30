import fs from "node:fs";
import path from "node:path";

import {
  artifactContractDefinition,
  assertNoSymlinkComponents,
  assertPathInside,
  assertRegularFileInside,
  safeResolveInside,
  PLANNED_GRAPH_SCHEMA_VERSION,
  sha256Bytes,
  validateNodeReference,
  validateSafeId,
  writeFileDurable
} from "@ultrafuzz/artifacts";
import { renderPrompt, type PromptConcreteNode, type PromptGraphNode } from "@ultrafuzz/prompts";

import {
  loadOrCreateDynamicExpansion,
  type DynamicExpansionItem,
  type DynamicExpansionManifest
} from "./dynamic-expansion.js";
import { projectArtifactSchemaDir } from "./init.js";
import type { CompiledSmithersDynamicGroup, CompiledSmithersTask, SmithersTaskMetadata } from "./smithers.js";
import type { PlannedGraph, PlannedGraphNode } from "./types.js";
import { sha256Stable } from "./utils.js";
import { assertRenderedPromptValidatorCommands, producerSchemaBackedOutputCount } from "./prompt-validator-command.js";

export const DYNAMIC_RUNTIME_SCHEMA_VERSION = "ultrafuzz.dynamic-runtime.v1" as const;

export interface DynamicRuntimeMaterializeInput {
  runId: string;
  projectRoot: string;
  runRoot: string;
  graphPath: string;
  tasksPath: string;
  /** Immutable pre-expansion controls. Defaults to the publication paths for legacy callers. */
  baseGraphPath?: string;
  baseTasksPath?: string;
  baseTasks: readonly CompiledSmithersTask[];
  groups: readonly CompiledSmithersDynamicGroup[];
  readyGroupIds: Iterable<string>;
}

export interface DynamicRuntimeMaterialization {
  tasks: CompiledSmithersTask[];
  graph: PlannedGraph;
  expandedGroupIds: string[];
  unresolvedGroupIds: string[];
  /**
   * Ready runtime prompts this render could not publish, with the renderer's message. Only a
   * publishing render has any. They are never persisted: the next render tries each one again, and
   * until one succeeds the workflow fails that task alone, at `assert-task-inputs`.
   */
  promptRenderFailures: Array<{ attemptId: string; message: string }>;
}

/**
 * Rebuilds all runtime-derived graph/task records from immutable compiled
 * templates plus validated expansion manifests. The function is deterministic
 * and idempotent so Smithers may call it on every reactive render and resume.
 */
export function materializeDynamicRuntime(input: DynamicRuntimeMaterializeInput): DynamicRuntimeMaterialization {
  return deriveDynamicRuntime(input, "publish");
}

/**
 * Re-derives an already-published dynamic graph/task extension from the sealed base controls and
 * digest-bound expansion manifests. This is the admission check used before lifecycle commands trust
 * mutable runtime state; it never creates a manifest, prompt, graph, or task document. It renders no
 * prompt either, so a missing, edited, or no longer renderable prompt file never fails it.
 */
export function verifyDynamicRuntimeMaterialization(
  input: Omit<DynamicRuntimeMaterializeInput, "readyGroupIds">
): DynamicRuntimeMaterialization {
  return deriveDynamicRuntime({ ...input, readyGroupIds: publishedGroupIds(input) }, "verify");
}

/**
 * The same derivation from the sealed base controls and the published expansion manifests, as the
 * next render derives it, without publishing, rendering or comparing anything. `resume` renders the
 * project's current prompts against it, before any render has republished what launch wrote.
 */
export function deriveDynamicRuntimeMaterialization(
  input: Omit<DynamicRuntimeMaterializeInput, "readyGroupIds">
): DynamicRuntimeMaterialization {
  return deriveDynamicRuntime({ ...input, readyGroupIds: publishedGroupIds(input) }, "derive");
}

function publishedGroupIds(input: Pick<DynamicRuntimeMaterializeInput, "groups" | "runRoot">): string[] {
  return input.groups
    .map((group) => group.groupNodeId)
    .filter((groupId) => fs.existsSync(path.join(input.runRoot, "dynamic-expansions", `${groupId}.json`)));
}

function deriveDynamicRuntime(
  input: DynamicRuntimeMaterializeInput,
  mode: "publish" | "verify" | "derive"
): DynamicRuntimeMaterialization {
  const runId = validateSafeId(input.runId, "run ID");
  const projectRoot = path.resolve(input.projectRoot);
  const runRoot = path.resolve(input.runRoot);
  assertPathInside(projectRoot, runRoot, "dynamic run root");
  assertNoSymlinkComponents(projectRoot, runRoot, "dynamic run root");
  const graphPath = checkedRunFile(runRoot, input.graphPath, "runtime graph");
  const tasksPath = checkedRunFile(runRoot, input.tasksPath, "runtime task plan");
  const baseGraphPath = checkedRunFile(runRoot, input.baseGraphPath ?? graphPath, "base runtime graph");
  const baseTasksPath = checkedRunFile(runRoot, input.baseTasksPath ?? tasksPath, "base runtime task plan");
  const graph = readPlannedGraph(baseGraphPath);
  const ready = new Set(input.readyGroupIds);
  const groups = [...input.groups].sort((left, right) => left.groupNodeId.localeCompare(right.groupNodeId));
  const groupIds = new Set(groups.map((group) => validateSafeId(group.groupNodeId, "dynamic group node ID")));
  for (const readyId of ready) {
    if (!groupIds.has(readyId)) throw new Error(`unknown ready dynamic group ${readyId}`);
  }

  const manifests = new Map<string, DynamicExpansionManifest>();
  for (const group of groups) {
    const manifestPath = path.join(runRoot, "dynamic-expansions", `${group.groupNodeId}.json`);
    if (!ready.has(group.groupNodeId) && !fs.existsSync(manifestPath)) continue;
    const sourceArtifactPath = remapProjectPath(
      group.source.artifactPath,
      group.promptContext.projectRoot,
      projectRoot
    );
    const manifest = loadOrCreateDynamicExpansion({
      runRoot,
      runId,
      groupNodeId: group.groupNodeId,
      sourceNodeId: group.source.concreteNodeId,
      sourceAttemptId: group.source.attemptId,
      sourceArtifactPath,
      sourcePath: group.sourcePath,
      keyPath: group.keyPath,
      nodeIdTemplate: group.nodeIdTemplate,
      templateDigest: group.templateDigest,
      templateFingerprint: group.templateFingerprint,
      maxDynamicNodes: group.maxDynamicNodes,
      reservedNodeIds: unique([...group.reservedNodeIds, ...input.baseTasks.map((task) => task.attemptId)])
    });
    manifests.set(group.groupNodeId, manifest);
  }

  const baseGraphNodes = graph.nodes.filter((node) => node.dynamic_generated === undefined);
  const generatedTasksByGroup = new Map<string, CompiledSmithersTask[]>();
  const generatedNodesByGroup = new Map<string, PlannedGraphNode[]>();
  for (const group of groups) {
    const manifest = manifests.get(group.groupNodeId);
    if (manifest === undefined) continue;
    const templateNode = baseGraphNodes.find((node) => node.id === group.groupNodeId);
    if (templateNode === undefined || templateNode.dynamic === undefined) {
      throw new Error(`dynamic group ${group.groupNodeId} is missing from the persisted graph`);
    }
    const tasks = manifest.items.flatMap((item) =>
      instantiateDynamicTasks({ group, manifest, item, runRoot, projectRoot })
    );
    const nodes = manifest.items.map((item) =>
      instantiateDynamicGraphNode({ group, manifest, item, template: templateNode, tasks })
    );
    generatedTasksByGroup.set(group.groupNodeId, tasks);
    generatedNodesByGroup.set(group.groupNodeId, nodes);
  }

  const staticTasks = input.baseTasks.map((task) =>
    lowerTaskDynamicDependencies(task, groups, manifests, generatedTasksByGroup, runRoot)
  );
  const generatedTasks = groups.flatMap((group) => generatedTasksByGroup.get(group.groupNodeId) ?? []);
  const tasks = [...staticTasks, ...generatedTasks];
  const loweredBaseNodes = baseGraphNodes.map((node) =>
    lowerGraphDynamicDependencies(node, groups, manifests, generatedNodesByGroup)
  );
  const runtimeGraph: PlannedGraph = {
    ...graph,
    nodes: insertGeneratedNodes(loweredBaseNodes, generatedNodesByGroup)
  };

  assertRuntimeIdentityUniqueness(runtimeGraph, tasks, generatedTasks);

  const promptRenderFailures = renderReadyRuntimePrompts({
    tasks,
    graph: runtimeGraph,
    groups,
    manifests,
    projectRoot,
    runRoot,
    runId,
    publishMissing: mode === "publish"
  });
  attachWorkflowGraphMetadata(runtimeGraph, tasks);

  const baseTaskDocument = readRecord(baseTasksPath);
  const runtimeTaskDocument = {
    ...baseTaskDocument,
    schema_version: baseTaskDocument.schema_version ?? DYNAMIC_RUNTIME_SCHEMA_VERSION,
    run_id: baseTaskDocument.run_id ?? runId,
    tasks,
    dynamic_groups: groups
  };

  if (mode === "publish") {
    // Publish tasks first. A concurrent synchronizer may temporarily skip an
    // unknown graph node, while the reverse ordering could finalize a graph node
    // against stale task identity. Both files are themselves atomically replaced,
    // and only when their bytes change: this runs on every render, and most
    // renders re-derive exactly the documents already on disk.
    writeJsonDurableIfChanged(tasksPath, runtimeTaskDocument);
    writeJsonDurableIfChanged(graphPath, runtimeGraph);
  } else if (mode === "verify") {
    const observedTasks = readRecord(tasksPath);
    const observedGraph = readPlannedGraph(graphPath);
    if (jsonFingerprint(observedTasks) !== jsonFingerprint(runtimeTaskDocument)) {
      throw new Error("persisted dynamic runtime task plan does not match its sealed templates and manifests");
    }
    if (jsonFingerprint(observedGraph) !== jsonFingerprint(runtimeGraph)) {
      throw new Error("persisted dynamic runtime graph does not match its sealed templates and manifests");
    }
  }

  return {
    tasks,
    graph: runtimeGraph,
    expandedGroupIds: [...manifests.keys()].sort(),
    unresolvedGroupIds: groups
      .map((group) => group.groupNodeId)
      .filter((groupId) => !manifests.has(groupId))
      .sort(),
    promptRenderFailures
  };
}

function instantiateDynamicTasks(input: {
  group: CompiledSmithersDynamicGroup;
  manifest: DynamicExpansionManifest;
  item: DynamicExpansionItem;
  runRoot: string;
  projectRoot: string;
}): CompiledSmithersTask[] {
  return input.group.taskTemplates.map((template, templateIndex) => {
    const model = template.metadata.model;
    const attemptId = dynamicAttemptId(
      input.item.storage_id,
      input.group.taskTemplates.length,
      model?.modelIndex ?? templateIndex,
      model?.attemptIndex ?? templateIndex
    );
    validateSafeId(attemptId, "dynamic attempt ID");
    const artifactDir = path.join(input.runRoot, "artifacts", attemptId);
    const workspacePath = path.join(input.runRoot, "workspaces", attemptId);
    const manifestPath = path.join(artifactDir, "artifact-manifest.json");
    const expansionManifestPath = path.join(input.runRoot, "dynamic-expansions", `${input.group.groupNodeId}.json`);
    const metadata: SmithersTaskMetadata = {
      ...structuredClone(template.metadata),
      node: {
        ...structuredClone(template.metadata.node),
        concreteNodeId: input.item.node_id,
        attemptId,
        label: `${template.metadata.node.label}: ${input.item.key}`,
        producerNodeId: input.item.node_id,
        storageId: input.item.storage_id,
        dynamic: {
          groupNodeId: input.group.groupNodeId,
          sourceNodeId: input.manifest.source.node_id,
          sourceAttemptId: input.manifest.source.attempt_id,
          sourceDigest: input.manifest.source.output_sha256,
          expansionKey: input.item.key,
          itemDigest: input.item.item_sha256,
          manifestPath: path.relative(input.runRoot, expansionManifestPath).split(path.sep).join("/")
        }
      },
      workspace: {
        ...structuredClone(template.metadata.workspace),
        path: workspacePath
      },
      artifacts: {
        ...structuredClone(template.metadata.artifacts),
        dir: artifactDir,
        manifestPath
      }
    };
    return {
      ...structuredClone(template),
      attemptId,
      concreteNodeId: input.item.node_id,
      preparationSmithersNodeId: `prepare:${attemptId}`,
      smithersNodeId: smithersNodeIdForAttempt(attemptId),
      verifierSmithersNodeId: verifierSmithersNodeIdForAttempt(attemptId),
      workspacePath,
      artifactDir,
      dependencyArtifactDirs: template.dependencyArtifactDirs.map((directory) =>
        remapProjectPath(directory, input.group.promptContext.projectRoot, input.projectRoot)
      ),
      ...(template.optionalDependencyArtifactDirs === undefined
        ? {}
        : {
            optionalDependencyArtifactDirs: template.optionalDependencyArtifactDirs.map((directory) =>
              remapProjectPath(directory, input.group.promptContext.projectRoot, input.projectRoot)
            )
          }),
      renderedPromptPath: path.join(artifactDir, "prompt.rendered.md"),
      promptTemplatePath: remapProjectPath(
        input.group.templatePath,
        input.group.promptContext.projectRoot,
        input.projectRoot
      ),
      deferredPromptGroups: [input.group.groupNodeId],
      dynamicVariables: structuredClone(input.item.variables),
      metadata
    };
  });
}

function instantiateDynamicGraphNode(input: {
  group: CompiledSmithersDynamicGroup;
  manifest: DynamicExpansionManifest;
  item: DynamicExpansionItem;
  template: PlannedGraphNode;
  tasks: readonly CompiledSmithersTask[];
}): PlannedGraphNode {
  const itemTasks = input.tasks.filter((task) => task.concreteNodeId === input.item.node_id);
  return {
    ...structuredClone(input.template),
    id: input.item.node_id,
    display_name: `${input.template.display_name}: ${input.item.key}`,
    depends_on: [...(input.template.declared_depends_on ?? input.template.depends_on)],
    artifact_dir: `artifacts/${itemTasks[0]?.attemptId ?? input.item.storage_id}`,
    artifact_dirs:
      itemTasks.length === 0
        ? [`artifacts/${input.item.storage_id}`]
        : itemTasks.map((task) => `artifacts/${task.attemptId}`),
    model_fanout:
      itemTasks.length === 0
        ? structuredClone(input.template.model_fanout)
        : itemTasks.map((task, index) => ({
            ...structuredClone(input.template.model_fanout[index]!),
            attempt_id: task.attemptId
          })),
    dynamic: undefined,
    dynamic_dependencies: undefined,
    declared_depends_on: undefined,
    dynamic_generated: {
      group_node_id: input.group.groupNodeId,
      source_node_id: input.manifest.source.node_id,
      source_attempt_id: input.manifest.source.attempt_id,
      expansion_key: input.item.key,
      item_sha256: input.item.item_sha256,
      storage_id: input.item.storage_id,
      manifest_path: `dynamic-expansions/${input.group.groupNodeId}.json`
    },
    ...(itemTasks[0] === undefined
      ? {}
      : {
          workflow: {
            node_id: itemTasks[0].smithersNodeId,
            task_node_ids: itemTasks.map((task) => task.smithersNodeId)
          }
        })
  };
}

/**
 * Whether `consumer` treats the output of a continuing producer in `producerGroup` as optional.
 * Consumers outside that group reconcile whichever results succeeded (the review group, and the
 * property fan-in reading its lenses). Inside the group the output stays required, so a chain within
 * one group, such as a stateful stage after its setup, never runs without its predecessor (#1120).
 * The compiler and dynamic lowering share this one rule; the task-manifest gate checks only that
 * optional inputs come from continuing producers.
 */
export function reconcilesPartialResults(
  consumer: Pick<CompiledSmithersTask, "metadata">,
  producerGroup: string | undefined
): boolean {
  return consumer.metadata.node.group !== producerGroup;
}

function lowerTaskDynamicDependencies(
  task: CompiledSmithersTask,
  groups: readonly CompiledSmithersDynamicGroup[],
  manifests: ReadonlyMap<string, DynamicExpansionManifest>,
  generatedTasksByGroup: ReadonlyMap<string, CompiledSmithersTask[]>,
  runRoot: string
): CompiledSmithersTask {
  const dynamicDependencies = task.dynamicDependencies ?? [];
  if (dynamicDependencies.length === 0) return structuredClone(task);
  const dependencies = [...task.dependencies];
  const dependencySmithersNodeIds = [...task.dependencySmithersNodeIds];
  const dependencyArtifactDirs = [...task.dependencyArtifactDirs];
  let optionalDependencyArtifactDirs = [...(task.optionalDependencyArtifactDirs ?? [])];
  const concreteNodeIds = task.metadata.dependencies.concreteNodeIds.filter(
    (nodeId) => !dynamicDependencies.includes(nodeId)
  );
  for (const groupId of dynamicDependencies) {
    const group = groups.find((candidate) => candidate.groupNodeId === groupId);
    if (group === undefined) throw new Error(`task ${task.attemptId} references unknown dynamic group ${groupId}`);
    const manifest = manifests.get(groupId);
    if (manifest === undefined) continue;
    const generated = generatedTasksByGroup.get(groupId) ?? [];
    if (manifest.items.length === 0) {
      dependencies.push(group.source.attemptId);
      if (group.source.verifierSmithersNodeId !== undefined) {
        dependencySmithersNodeIds.push(group.source.verifierSmithersNodeId);
      }
      const sourceArtifactDir = path.join(runRoot, "artifacts", group.source.attemptId);
      dependencyArtifactDirs.push(sourceArtifactDir);
      // An empty expansion is a successful planner result, not an optional failure.
      // Keep its source required so the empty result remains authenticated.
      optionalDependencyArtifactDirs = optionalDependencyArtifactDirs.filter(
        (directory) => directory !== sourceArtifactDir
      );
      concreteNodeIds.push(group.source.concreteNodeId);
      continue;
    }
    dependencies.push(...generated.map((candidate) => candidate.attemptId));
    dependencySmithersNodeIds.push(...generated.map((candidate) => candidate.verifierSmithersNodeId));
    dependencyArtifactDirs.push(...generated.map((candidate) => candidate.artifactDir));
    if (group.continueOnFail) {
      optionalDependencyArtifactDirs.push(
        ...generated
          .filter((candidate) => reconcilesPartialResults(task, candidate.metadata.node.group))
          .map((candidate) => candidate.artifactDir)
      );
    }
    concreteNodeIds.push(...manifest.items.map((item) => item.node_id));
  }
  return {
    ...structuredClone(task),
    dependencies: unique(dependencies),
    dependencySmithersNodeIds: unique(dependencySmithersNodeIds),
    dependencyArtifactDirs: unique(dependencyArtifactDirs),
    optionalDependencyArtifactDirs: unique(optionalDependencyArtifactDirs),
    metadata: {
      ...structuredClone(task.metadata),
      dependencies: {
        concreteNodeIds: unique(concreteNodeIds),
        attemptIds: unique(dependencies),
        smithersNodeIds: unique(dependencySmithersNodeIds)
      }
    }
  };
}

function lowerGraphDynamicDependencies(
  node: PlannedGraphNode,
  groups: readonly CompiledSmithersDynamicGroup[],
  manifests: ReadonlyMap<string, DynamicExpansionManifest>,
  generatedNodesByGroup: ReadonlyMap<string, PlannedGraphNode[]>
): PlannedGraphNode {
  const dynamicDependencies = node.dynamic_dependencies ?? [];
  let dependsOn = [...(node.declared_depends_on ?? node.depends_on)];
  for (const groupId of dynamicDependencies) {
    const group = groups.find((candidate) => candidate.groupNodeId === groupId);
    const manifest = manifests.get(groupId);
    if (group === undefined || manifest === undefined) continue;
    dependsOn = dependsOn.flatMap((dependency) => {
      if (dependency !== groupId) return [dependency];
      const generated = generatedNodesByGroup.get(groupId) ?? [];
      return generated.length === 0 ? [group.source.concreteNodeId] : generated.map((candidate) => candidate.id);
    });
  }
  const manifest = manifests.get(node.id);
  return {
    ...structuredClone(node),
    depends_on: unique(dependsOn),
    ...(node.dynamic === undefined
      ? {}
      : {
          dynamic: {
            ...structuredClone(node.dynamic),
            status: manifest === undefined ? "pending" : "expanded",
            generated_node_ids: manifest?.items.map((item) => item.node_id) ?? []
          }
        })
  };
}

function insertGeneratedNodes(
  baseNodes: readonly PlannedGraphNode[],
  generatedNodesByGroup: ReadonlyMap<string, PlannedGraphNode[]>
): PlannedGraphNode[] {
  return baseNodes.flatMap((node) => [node, ...(generatedNodesByGroup.get(node.id) ?? [])]);
}

/**
 * A runtime prompt is rendered once, by the first publishing render that finds its task ready and
 * its file missing. From then on the file is the task's prompt and is used as it is: it is never
 * rendered again or compared, so an edited file, an edited template copy or an upgraded renderer
 * never strands the run. Admission (`publishMissing: false`) renders nothing and opens no prompt
 * entry, so it accepts a prompt that is not published yet.
 *
 * A task whose prompt cannot be rendered is returned, not thrown, so every other prompt still
 * renders and the task plan is still published; the workflow then fails that task alone. So is a
 * published entry that is not a regular file, such as a symlink: it is neither read nor replaced.
 * The artifact-directory checks stay outside that scope, so a corrupted run tree still fails the
 * whole render.
 */
function renderReadyRuntimePrompts(input: {
  tasks: CompiledSmithersTask[];
  graph: PlannedGraph;
  groups: readonly CompiledSmithersDynamicGroup[];
  manifests: ReadonlyMap<string, DynamicExpansionManifest>;
  projectRoot: string;
  runRoot: string;
  runId: string;
  publishMissing: boolean;
}): DynamicRuntimeMaterialization["promptRenderFailures"] {
  const failures: DynamicRuntimeMaterialization["promptRenderFailures"] = [];
  const groupContext = input.groups[0]?.promptContext;
  if (groupContext === undefined) return failures;
  let graphContext: ReturnType<typeof promptGraphContext> | undefined;
  for (const task of input.tasks) {
    if (task.promptTemplatePath === undefined) continue;
    if ((task.deferredPromptGroups ?? []).some((groupId) => !input.manifests.has(groupId))) continue;
    const artifactDir = remapProjectPath(task.artifactDir, groupContext.projectRoot, input.projectRoot);
    const promptPath = path.join(artifactDir, "prompt.rendered.md");
    assertPathInside(input.runRoot, artifactDir, `runtime artifact directory for ${task.attemptId}`);
    assertNoSymlinkComponents(input.runRoot, artifactDir, `runtime artifact directory for ${task.attemptId}`);
    // Both modes bind the same path whether or not the prompt exists, so admission re-derives the
    // task plan a render published even when that render could not publish the prompt.
    task.renderedPromptPath = promptPath;
    if (!input.publishMissing) continue;
    if (fs.lstatSync(promptPath, { throwIfNoEntry: false }) !== undefined) {
      failures.push(...unusablePublishedPrompt(task.attemptId, promptPath));
      continue;
    }
    graphContext ??= promptGraphContext(input.graph, input.tasks);
    let renderedMarkdown: string;
    try {
      renderedMarkdown = renderRuntimePrompt({
        task,
        promptTemplatePath: task.promptTemplatePath,
        artifactDir,
        groupContext,
        graphContext,
        projectRoot: input.projectRoot,
        runRoot: input.runRoot,
        runId: input.runId
      });
    } catch (error) {
      failures.push({ attemptId: task.attemptId, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    fs.mkdirSync(artifactDir, { recursive: true });
    assertNoSymlinkComponents(input.runRoot, artifactDir, `runtime artifact directory for ${task.attemptId}`);
    writeFileDurable(promptPath, renderedMarkdown);
  }
  return failures;
}

/**
 * Resolves the documented `vulnerability_database_path` and `artifact_schema_dir` core variables
 * against the actual run and project roots.
 *
 * The compiled group stores the digest-bound catalog run-root-relative, so a relocated workspace
 * renders the correct absolute path instead of silently substituting "unavailable".
 */
function resolvedConfigForRuntimeRoot(
  resolvedConfig: CompiledSmithersDynamicGroup["promptContext"]["resolvedConfig"],
  runRoot: string,
  projectRoot: string
): CompiledSmithersDynamicGroup["promptContext"]["resolvedConfig"] & {
  vulnerabilityDatabasePath?: string;
  artifactSchemaDir?: string;
} {
  const withSchemaDir = { ...resolvedConfig, artifactSchemaDir: projectArtifactSchemaDir(projectRoot) };
  const relativePath = resolvedConfig.vulnerabilityDatabaseRelativePath;
  if (relativePath === undefined) return withSchemaDir;
  const catalogPath = safeResolveInside(runRoot, relativePath, "materialized vulnerability database catalog");
  assertRegularFileInside(runRoot, catalogPath, "materialized vulnerability database catalog");
  if (
    resolvedConfig.vulnerabilityDatabaseSha256 !== undefined &&
    sha256Bytes(fs.readFileSync(catalogPath)) !== resolvedConfig.vulnerabilityDatabaseSha256
  ) {
    throw new Error("materialized vulnerability-database catalog does not match the digest recorded at plan time");
  }
  return { ...withSchemaDir, vulnerabilityDatabasePath: catalogPath };
}

function promptGraphContext(
  graph: PlannedGraph,
  tasks: readonly CompiledSmithersTask[]
): { logicalNodes: PromptGraphNode[]; concreteNodes: PromptConcreteNode[] } {
  const graphNodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const logical = new Map<string, PromptGraphNode>();
  for (const node of graph.nodes) {
    const previous = logical.get(node.logical_id);
    const dependencies = node.depends_on
      .map((dependency) => graphNodeById.get(dependency)?.logical_id)
      .filter((dependency): dependency is string => dependency !== undefined && dependency !== node.logical_id);
    const taskArtifactDirs = tasks
      .filter((task) => task.logicalNodeId === node.logical_id)
      .map((task) => task.artifactDir);
    logical.set(node.logical_id, {
      id: node.logical_id,
      kind: previous?.kind === "reference" ? "reference" : node.kind,
      dependsOn: unique([...(previous?.dependsOn ?? []), ...dependencies]),
      outputs: node.outputs.map((output) => {
        const definition = artifactContractDefinition(output.contract);
        return {
          path: output.path,
          contract: output.contract,
          primary: output.primary,
          description: definition.description,
          ...(definition.validEmptyExample === undefined ? {} : { validEmptyExample: definition.validEmptyExample }),
          ...(output.schema_file === undefined ? {} : { schemaFile: output.schema_file })
        };
      }),
      artifactDirs: unique([...(previous?.artifactDirs ?? []), ...taskArtifactDirs])
    });
  }
  return {
    logicalNodes: [...logical.values()].sort((left, right) => left.id.localeCompare(right.id)),
    concreteNodes: tasks.map((task) => ({
      id: task.attemptId,
      logicalId: task.logicalNodeId,
      dependsOn: [...task.dependencies],
      artifactDir: task.artifactDir,
      loopIndex: task.metadata.loop.index,
      attemptIndex: task.metadata.model?.attemptIndex ?? task.metadata.loop.attemptIndex,
      modelProfileId: task.metadata.model?.profileId,
      agentRef: task.agentRef,
      modelName: task.modelName,
      modelIndex: task.metadata.model?.modelIndex
    }))
  };
}

/** Render one runtime prompt from the run's template copy, with the checks every fresh render keeps. */
function renderRuntimePrompt(input: {
  task: CompiledSmithersTask;
  promptTemplatePath: string;
  templateBody?: string; // rendered instead of the template copy's current text
  artifactDir: string;
  groupContext: CompiledSmithersDynamicGroup["promptContext"];
  graphContext: ReturnType<typeof promptGraphContext>;
  projectRoot: string;
  runRoot: string;
  runId: string;
}): string {
  const { task, artifactDir, groupContext } = input;
  const templatePath = remapProjectPath(input.promptTemplatePath, groupContext.projectRoot, input.projectRoot);
  assertPathInside(input.projectRoot, templatePath, `runtime prompt template for ${task.attemptId}`);
  assertNoSymlinkComponents(input.projectRoot, templatePath, `runtime prompt template for ${task.attemptId}`);
  assertRegularFileInside(input.projectRoot, templatePath, `runtime prompt template for ${task.attemptId}`);
  const workspacePath = remapProjectPath(task.workspacePath, groupContext.projectRoot, input.projectRoot);
  const result = renderPrompt({
    prompt: input.templateBody ?? fs.readFileSync(templatePath, "utf8"),
    ...(task.dynamicVariables === undefined ? {} : { dynamicVariables: { ...task.dynamicVariables } }),
    graph: input.graphContext,
    node: {
      logicalId: task.logicalNodeId,
      concreteId: task.attemptId,
      artifactDir,
      workspacePath,
      repoPath: remapProjectPath(groupContext.repoPath, groupContext.projectRoot, input.projectRoot),
      attemptIndex: task.metadata.model.attemptIndex,
      loopIndex: task.metadata.loop.index,
      loopCount: task.metadata.loop.count,
      agentRef: task.agentRef,
      modelProfileId: task.metadata.model.profileId,
      modelName: task.modelName,
      modelIndex: task.metadata.model.modelIndex
    },
    run: {
      id: input.runId,
      artifactsDir: path.join(input.runRoot, "artifacts"),
      metadataPath: path.join(input.runRoot, path.basename(groupContext.runMetadataPath))
    },
    outputs: {
      patchPath: path.join(artifactDir, "patch.diff")
    },
    resolvedConfig: resolvedConfigForRuntimeRoot(groupContext.resolvedConfig, input.runRoot, input.projectRoot)
  });
  assertRenderedPromptValidatorCommands({
    attemptId: task.attemptId,
    outputContractMarkdown: result.outputContractMarkdown,
    schemaBackedOutputCount: producerSchemaBackedOutputCount(task.metadata.artifacts.outputs)
  });
  return result.renderedMarkdown;
}

function attachWorkflowGraphMetadata(graph: PlannedGraph, tasks: readonly CompiledSmithersTask[]): void {
  const byConcrete = new Map<string, CompiledSmithersTask[]>();
  for (const task of tasks) {
    const values = byConcrete.get(task.concreteNodeId) ?? [];
    values.push(task);
    byConcrete.set(task.concreteNodeId, values);
  }
  for (const node of graph.nodes) {
    const nodeTasks = byConcrete.get(node.id) ?? [];
    if (nodeTasks.length === 0) continue;
    node.workflow = {
      node_id: nodeTasks[0]!.smithersNodeId,
      task_node_ids: nodeTasks.map((task) => task.smithersNodeId)
    };
  }
}

function assertRuntimeIdentityUniqueness(
  graph: PlannedGraph,
  tasks: readonly CompiledSmithersTask[],
  generatedTasks: readonly CompiledSmithersTask[]
): void {
  const graphIds = new Set<string>();
  for (const node of graph.nodes) {
    if (graphIds.has(node.id)) throw new Error(`runtime graph node ID ${node.id} is duplicated`);
    graphIds.add(node.id);
  }
  const attemptIds = new Set<string>();
  for (const task of tasks) {
    if (attemptIds.has(task.attemptId)) {
      throw new Error(`runtime task attempt ID ${task.attemptId} collides with another task`);
    }
    attemptIds.add(task.attemptId);
  }
  for (const task of generatedTasks) {
    if (graphIds.has(task.attemptId)) {
      throw new Error(`runtime task attempt ID ${task.attemptId} collides with a graph node`);
    }
  }
}

function readPlannedGraph(graphPath: string): PlannedGraph {
  const value = JSON.parse(fs.readFileSync(graphPath, "utf8")) as Partial<PlannedGraph>;
  if (
    value.schema_version !== PLANNED_GRAPH_SCHEMA_VERSION ||
    !Array.isArray(value.nodes) ||
    typeof value.groups !== "object"
  ) {
    throw new Error("persisted runtime graph is invalid");
  }
  return value as PlannedGraph;
}

/** Same bytes as `writeJsonDurable`, skipping the replace and fsyncs when the file already holds them. */
function writeJsonDurableIfChanged(filePath: string, value: unknown): void {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (fs.readFileSync(filePath, "utf8") !== bytes) writeFileDurable(filePath, bytes);
}

function readRecord(filePath: string): Record<string, unknown> {
  const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`persisted runtime document is invalid: ${filePath}`);
  }
  return value as Record<string, unknown>;
}

function checkedRunFile(runRoot: string, candidate: string, label: string): string {
  const resolved = path.resolve(candidate);
  assertPathInside(runRoot, resolved, label);
  assertNoSymlinkComponents(runRoot, resolved, label);
  assertRegularFileInside(runRoot, resolved, label);
  return resolved;
}

function remapProjectPath(value: string, sourceProjectRoot: string, projectRoot: string): string {
  const sourceRoot = path.resolve(sourceProjectRoot);
  const candidate = path.isAbsolute(value) ? path.resolve(value) : path.resolve(sourceRoot, value);
  const relative = path.relative(sourceRoot, candidate);
  if (relative === "" || relative === ".") return projectRoot;
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`dynamic runtime path is outside the compiled project root: ${value}`);
  }
  return path.join(projectRoot, relative);
}

function dynamicAttemptId(storageId: string, templateCount: number, modelIndex: number, attemptIndex: number): string {
  validateSafeId(storageId, "dynamic storage ID");
  if (templateCount <= 1) return storageId;
  return `${storageId}__model_${modelIndex}__attempt_${attemptIndex}`;
}

function smithersNodeIdForAttempt(attemptId: string): string {
  return `node:${attemptId}`;
}

function verifierSmithersNodeIdForAttempt(attemptId: string): string {
  return `verify:${attemptId}`;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function jsonFingerprint(value: unknown): string {
  return sha256Stable(JSON.parse(JSON.stringify(value)) as unknown);
}

/** Human provenance identifiers are deliberately separate from filesystem-safe IDs. */
export function validateHumanNodeReference(value: string, label = "node reference"): string {
  return validateNodeReference(value, label);
}

export function dynamicRuntimeFingerprint(value: DynamicRuntimeMaterialization): string {
  return sha256Stable({
    expanded_group_ids: value.expandedGroupIds,
    nodes: value.graph.nodes.map((node) => ({ id: node.id, depends_on: node.depends_on })),
    tasks: value.tasks.map((task) => ({
      attempt_id: task.attemptId,
      concrete_node_id: task.concreteNodeId,
      dependencies: task.dependencies
    }))
  });
}

/**
 * A published runtime prompt is used as it is. An entry there that is not a regular file, such as a
 * symlink or a directory, is neither read nor replaced: it fails its task until someone removes it.
 */
function unusablePublishedPrompt(
  attemptId: string,
  promptPath: string
): DynamicRuntimeMaterialization["promptRenderFailures"] {
  if (fs.lstatSync(promptPath).isFile()) return [];
  return [{ attemptId, message: `runtime rendered prompt for ${attemptId} is not a regular file: ${promptPath}` }];
}

/**
 * Renders the listed runtime tasks' prompts in memory, each from the template body given instead of
 * its template copy's current text, exactly as a publishing render would and with the same checks.
 * It writes nothing. `resume` uses it to apply the project's current prompts to published ones.
 */
export function renderRuntimePromptsFromTemplates(input: {
  materialization: Pick<DynamicRuntimeMaterialization, "tasks" | "graph">;
  groups: readonly CompiledSmithersDynamicGroup[];
  projectRoot: string;
  runRoot: string;
  runId: string;
  /** Template body per attempt ID. */
  templates: ReadonlyMap<string, string>;
}): Map<string, { markdown: string } | { error: string }> {
  const rendered = new Map<string, { markdown: string } | { error: string }>();
  const groupContext = input.groups[0]?.promptContext;
  if (groupContext === undefined) return rendered;
  const graphContext = promptGraphContext(input.materialization.graph, input.materialization.tasks);
  for (const task of input.materialization.tasks) {
    const templateBody = input.templates.get(task.attemptId);
    if (templateBody === undefined || task.promptTemplatePath === undefined) continue;
    try {
      const markdown = renderRuntimePrompt({
        task,
        promptTemplatePath: task.promptTemplatePath,
        templateBody,
        artifactDir: remapProjectPath(task.artifactDir, groupContext.projectRoot, input.projectRoot),
        groupContext,
        graphContext,
        projectRoot: input.projectRoot,
        runRoot: input.runRoot,
        runId: input.runId
      });
      rendered.set(task.attemptId, { markdown });
    } catch (error) {
      rendered.set(task.attemptId, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  return rendered;
}
