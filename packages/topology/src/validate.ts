import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { ARTIFACT_MANIFEST_FILE, isArtifactContractId, type ArtifactContractId } from "@ultrafuzz/artifacts";
import { RUN_REFERENCE_MANIFEST_FILE } from "@ultrafuzz/references";

import { validateArtifactHandoffs } from "./artifact-handoffs.js";
import { topologyError } from "./errors.js";
import {
  FINISH_NODE_ID,
  MAX_EXPANDED_TOPOLOGY_NODES,
  MAX_LOOPS,
  MAX_TOPOLOGY_NODES,
  START_NODE_ID,
  TOPOLOGY_VERSION
} from "./types.js";
import type {
  NormalizedProjectTopology,
  NormalizedArtifactOutput,
  NormalizedTopologyNode,
  ProjectTopology,
  TopologyGroupDefaults,
  TopologyLimits,
  TopologyNodeKind,
  TopologyValidationOptions,
  TopologyValidationResult
} from "./types.js";
import { assertSafeRelativePath, ensureInside, ensureNoSymlinkComponents, isSafeId } from "./path-utils.js";

const DEFAULT_LIMITS: TopologyLimits = {
  maxLoops: MAX_LOOPS,
  maxTopologyNodes: MAX_TOPOLOGY_NODES,
  maxExpandedNodes: MAX_EXPANDED_TOPOLOGY_NODES
};

export function validateTopology(
  topologyInput: ProjectTopology | unknown,
  options: TopologyValidationOptions = {}
): TopologyValidationResult {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const topology = normalizeTopology(topologyInput);
  if (topology.version !== TOPOLOGY_VERSION) {
    throw topologyError(
      "UNSUPPORTED_TOPOLOGY_VERSION",
      `Unsupported topology version ${topology.version}; expected ${TOPOLOGY_VERSION}`,
      { version: topology.version }
    );
  }
  if (topology.nodes.length === 0) {
    throw topologyError("NO_TOPOLOGY_NODES", "Topology must define at least one node");
  }
  if (topology.nodes.length > limits.maxTopologyNodes) {
    throw topologyError("TOO_MANY_TOPOLOGY_NODES", "Topology defines too many logical nodes", {
      count: topology.nodes.length,
      max: limits.maxTopologyNodes
    });
  }
  validateLoopDefault(topology.defaults.strategy_loops, limits);
  validateGroups(topology.groups, limits);

  const ids = new Set<string>();
  const nodeById = new Map<string, NormalizedTopologyNode>();
  for (const node of topology.nodes) {
    validateNodeShape(node, topology.groups, options, limits);
    if (ids.has(node.id)) {
      throw topologyError("DUPLICATE_NODE_ID", `Duplicate topology node id \`${node.id}\``, {
        nodeId: node.id
      });
    }
    ids.add(node.id);
    nodeById.set(node.id, node);
  }

  validateRequiredMetaNodes(nodeById);
  validateDependencies(topology.nodes, ids);
  validateNoCycles(nodeById);
  validateEntryExit(topology.nodes);

  const effectiveLoopCounts = resolveEffectiveLoopCounts(topology, options, limits);
  validateExpandedSize(effectiveLoopCounts, limits);
  validateConcreteIdCollisions(topology.nodes, effectiveLoopCounts);
  validatePromptArtifacts(topology, options);

  return { topology, effectiveLoopCounts };
}

export function normalizeTopology(topologyInput: ProjectTopology | unknown): NormalizedProjectTopology {
  if (!isRecord(topologyInput)) {
    throw topologyError("INVALID_TOPOLOGY_SHAPE", "Topology document must be a mapping");
  }
  assertOnlyKeys(topologyInput, ["version", "defaults", "groups", "nodes"], "topology document");
  if (!Number.isInteger(topologyInput.version)) {
    throw topologyError("INVALID_TOPOLOGY_SHAPE", "Topology version must be an integer");
  }
  if (!isRecord(topologyInput.defaults) || !Number.isInteger(topologyInput.defaults.strategy_loops)) {
    throw topologyError("INVALID_TOPOLOGY_SHAPE", "Topology defaults.strategy_loops must be an integer");
  }
  assertOnlyKeys(topologyInput.defaults, ["strategy_loops"], "topology defaults");
  if (!Array.isArray(topologyInput.nodes)) {
    throw topologyError("INVALID_TOPOLOGY_SHAPE", "Topology nodes must be an array");
  }

  const strategyLoops = topologyInput.defaults.strategy_loops as number;
  const groups = normalizeGroups(topologyInput.groups);
  const nodes = topologyInput.nodes.map((node, index) => normalizeNode(node, index));
  return {
    version: topologyInput.version as typeof TOPOLOGY_VERSION,
    defaults: { strategy_loops: strategyLoops },
    groups,
    nodes
  };
}

export function concreteIdsFor(logicalId: string, loops: number): string[] {
  if (loops === 1) {
    return [logicalId];
  }
  return Array.from({ length: loops }, (_value, index) => `${logicalId}-${index}`);
}

export function resolvedPromptPath(node: NormalizedTopologyNode): string {
  if (node.prompt) {
    return node.prompt;
  }
  return node.group ? `${node.group}/${node.id}.md` : `${node.id}.md`;
}

export function isNormalStrategyNode(node: NormalizedTopologyNode): boolean {
  if (node.kind !== "agentic" || node.group !== "strategies") {
    return false;
  }
  const promptPath = resolvedPromptPath(node);
  const fileName = promptPath.split("/").at(-1) ?? "";
  return (
    promptPath.startsWith("strategies/") &&
    !promptPath.startsWith("strategies/invariants/") &&
    !fileName.endsWith("-plan.md")
  );
}

function normalizeGroups(
  input: unknown
): Record<string, { label?: string; color?: string; defaults?: TopologyGroupDefaults }> {
  if (input === undefined) {
    return {};
  }
  if (!isRecord(input)) {
    throw topologyError("INVALID_TOPOLOGY_SHAPE", "Topology groups must be a mapping");
  }
  const groups: Record<string, { label?: string; color?: string; defaults?: TopologyGroupDefaults }> = {};
  for (const [id, group] of Object.entries(input)) {
    if (!isRecord(group)) {
      throw topologyError("INVALID_TOPOLOGY_SHAPE", `Topology group \`${id}\` must be a mapping`, {
        group: id
      });
    }
    assertOnlyKeys(group, ["label", "color", "defaults"], `topology group \`${id}\``);
    const label = normalizeOptionalString(group.label, "label", `Topology group \`${id}\``);
    const color = normalizeOptionalString(group.color, "color", `Topology group \`${id}\``);
    groups[id] = {
      ...(label === undefined ? {} : { label }),
      ...(color === undefined ? {} : { color }),
      ...(group.defaults === undefined ? {} : { defaults: normalizeGroupDefaults(id, group.defaults) })
    };
  }
  return groups;
}

function normalizeGroupDefaults(groupId: string, input: unknown): TopologyGroupDefaults {
  if (!isRecord(input)) {
    throw topologyError("INVALID_TOPOLOGY_SHAPE", `Topology group \`${groupId}\` defaults must be a mapping`, {
      group: groupId
    });
  }
  assertOnlyKeys(
    input,
    ["loops", "timeout_seconds", "max_attempts", "model_profiles"],
    `topology group \`${groupId}\` defaults`
  );
  return {
    ...(input.loops === undefined ? {} : { loops: normalizePositiveInteger(input.loops, "loops", groupId) }),
    ...(input.timeout_seconds === undefined
      ? {}
      : { timeout_seconds: normalizePositiveInteger(input.timeout_seconds, "timeout_seconds", groupId) }),
    ...(input.max_attempts === undefined
      ? {}
      : { max_attempts: normalizePositiveInteger(input.max_attempts, "max_attempts", groupId) }),
    model_profiles: normalizeStringArray(input.model_profiles, "model_profiles", groupId, false)
  };
}

function normalizeNode(input: unknown, index: number): NormalizedTopologyNode {
  if (!isRecord(input)) {
    throw topologyError("INVALID_TOPOLOGY_SHAPE", `Topology node at index ${index} must be a mapping`, {
      index
    });
  }
  if (typeof input.id !== "string") {
    throw topologyError("INVALID_TOPOLOGY_SHAPE", `Topology node at index ${index} must define string id`, {
      index
    });
  }
  assertOnlyKeys(
    input,
    [
      "id",
      "kind",
      "role",
      "prompt",
      "reference",
      "group",
      "depends_on",
      "loops",
      "loop_mode",
      "timeout_seconds",
      "max_attempts",
      "outputs",
      "model_profiles",
      "required_commands"
    ],
    `topology node \`${input.id}\``
  );
  const kind = normalizeKind(input.kind, input.id);
  const role = normalizeOptionalString(input.role, "role", `Node \`${input.id}\``);
  const prompt = normalizeOptionalString(input.prompt, "prompt", `Node \`${input.id}\``);
  const reference = normalizeOptionalString(input.reference, "reference", `Node \`${input.id}\``);
  const group = normalizeOptionalString(input.group, "group", `Node \`${input.id}\``);
  return {
    id: input.id,
    kind,
    ...(role === undefined ? {} : { role: role as never }),
    ...(prompt === undefined ? {} : { prompt }),
    ...(reference === undefined ? {} : { reference }),
    ...(group === undefined ? {} : { group }),
    depends_on: normalizeStringArray(input.depends_on, "depends_on", input.id, true),
    loops: input.loops === undefined ? 1 : normalizePositiveInteger(input.loops, "loops", input.id),
    explicit_loops: input.loops !== undefined,
    loop_mode: input.loop_mode === undefined ? "parallel" : normalizeLoopMode(input.loop_mode, input.id),
    ...(input.timeout_seconds === undefined
      ? {}
      : { timeout_seconds: normalizePositiveInteger(input.timeout_seconds, "timeout_seconds", input.id) }),
    ...(input.max_attempts === undefined
      ? {}
      : { max_attempts: normalizePositiveInteger(input.max_attempts, "max_attempts", input.id) }),
    outputs: normalizeOutputs(input.outputs, input.id),
    model_profiles: normalizeStringArray(input.model_profiles, "model_profiles", input.id, false),
    required_commands: normalizeRequiredCommands(input.required_commands, input.id)
  };
}

function normalizeRequiredCommands(input: unknown, nodeId: string): string[] {
  const commands = normalizeStringArray(input, "required_commands", nodeId, false);
  if (commands.some((command) => !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(command))) {
    throw topologyError(
      "INVALID_TOPOLOGY_SHAPE",
      `Node \`${nodeId}\` field required_commands must contain bare executable names`,
      { nodeId, field: "required_commands" }
    );
  }
  return [...new Set(commands)].sort();
}

function normalizeOutputs(input: unknown, nodeId: string): NormalizedArtifactOutput[] {
  if (input === undefined) {
    return [];
  }
  if (!Array.isArray(input)) {
    throw topologyError("INVALID_OUTPUT_CONTRACT", `Node \`${nodeId}\` outputs must be an array`, { nodeId });
  }
  return input.map((output, index) => {
    if (!isRecord(output)) {
      throw topologyError("INVALID_OUTPUT_CONTRACT", `Node \`${nodeId}\` output ${index} must be a mapping`, {
        nodeId,
        index
      });
    }
    assertOnlyKeys(output, ["path", "contract", "primary"], `node \`${nodeId}\` output ${index}`);
    if (typeof output.path !== "string" || !isArtifactContractId(output.contract)) {
      throw topologyError("INVALID_OUTPUT_CONTRACT", `Node \`${nodeId}\` output ${index} is incomplete`, {
        nodeId,
        index
      });
    }
    if (output.primary !== undefined && typeof output.primary !== "boolean") {
      throw topologyError("INVALID_OUTPUT_CONTRACT", `Node \`${nodeId}\` output ${index} primary must be boolean`, {
        nodeId,
        index
      });
    }
    return {
      path: output.path,
      contract: output.contract as ArtifactContractId,
      primary: output.primary === true
    };
  });
}

function normalizeKind(input: unknown, nodeId: string): TopologyNodeKind {
  if (input === undefined) {
    return "agentic";
  }
  if (input === "agentic" || input === "meta" || input === "reference") {
    return input;
  }
  throw topologyError("INVALID_TOPOLOGY_SHAPE", `Node \`${nodeId}\` has invalid kind`, { nodeId });
}

function normalizeLoopMode(input: unknown, nodeId: string): "parallel" | "series" {
  if (input === "parallel" || input === "series") {
    return input;
  }
  throw topologyError("INVALID_TOPOLOGY_SHAPE", `Node \`${nodeId}\` has invalid loop_mode`, { nodeId });
}

function normalizePositiveInteger(input: unknown, field: string, nodeId: string): number {
  if (Number.isInteger(input)) {
    return input as number;
  }
  throw topologyError("INVALID_TOPOLOGY_SHAPE", `Node \`${nodeId}\` field ${field} must be an integer`, {
    nodeId,
    field
  });
}

function normalizeStringArray(input: unknown, field: string, nodeId: string, required: boolean): string[] {
  if (input === undefined) {
    if (required) {
      throw topologyError("INVALID_TOPOLOGY_SHAPE", `Node \`${nodeId}\` must define ${field}`, { nodeId, field });
    }
    return [];
  }
  if (!Array.isArray(input) || input.some((item) => typeof item !== "string")) {
    throw topologyError("INVALID_TOPOLOGY_SHAPE", `Node \`${nodeId}\` field ${field} must be a string array`, {
      nodeId,
      field
    });
  }
  return [...input];
}

function normalizeOptionalString(input: unknown, field: string, context: string): string | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (typeof input !== "string") {
    throw topologyError("INVALID_TOPOLOGY_SHAPE", `${context} field ${field} must be a string`, { field });
  }
  return input;
}

function validateNodeShape(
  node: NormalizedTopologyNode,
  groups: Record<string, unknown>,
  options: TopologyValidationOptions,
  limits: TopologyLimits
): void {
  if (!isSafeId(node.id)) {
    throw topologyError("INVALID_NODE_ID", `Invalid topology node id \`${node.id}\``, { nodeId: node.id });
  }
  validateLoopCount(node.id, node.loops, limits);
  if (node.timeout_seconds !== undefined && node.timeout_seconds <= 0) {
    throw topologyError("INVALID_TIMEOUT", `Node \`${node.id}\` timeout_seconds must be greater than zero`, {
      nodeId: node.id
    });
  }
  if (node.max_attempts !== undefined && node.max_attempts <= 0) {
    throw topologyError("INVALID_TOPOLOGY_SHAPE", `Node \`${node.id}\` max_attempts must be greater than zero`, {
      nodeId: node.id
    });
  }
  if (node.group !== undefined) {
    validateGroupId(node.group);
    if (Object.keys(groups).length > 0 && !groups[node.group]) {
      throw topologyError("INVALID_GROUP_ID", `Node \`${node.id}\` references undeclared group \`${node.group}\``, {
        nodeId: node.id,
        group: node.group
      });
    }
  }

  if (node.kind === "meta") {
    validateMetaNode(node);
  } else if (node.kind === "reference") {
    validateReferenceNode(node);
  } else {
    validateAgenticNode(node, options);
  }
}

function validateGroups(
  groups: Record<string, { color?: string; defaults?: TopologyGroupDefaults }>,
  limits: TopologyLimits
): void {
  for (const [groupId, group] of Object.entries(groups)) {
    validateGroupId(groupId);
    if (group.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(group.color)) {
      throw topologyError("INVALID_GROUP_COLOR", `Group \`${groupId}\` has invalid color`, {
        group: groupId,
        color: group.color
      });
    }
    if (group.defaults?.loops !== undefined) {
      validateLoopCount(groupId, group.defaults.loops, limits);
    }
    if (group.defaults?.timeout_seconds !== undefined && group.defaults.timeout_seconds <= 0) {
      throw topologyError("INVALID_TIMEOUT", `Group \`${groupId}\` timeout_seconds must be greater than zero`, {
        group: groupId
      });
    }
    if (group.defaults?.max_attempts !== undefined && group.defaults.max_attempts <= 0) {
      throw topologyError("INVALID_TOPOLOGY_SHAPE", `Group \`${groupId}\` max_attempts must be greater than zero`, {
        group: groupId
      });
    }
    for (const modelProfile of group.defaults?.model_profiles ?? []) {
      if (!isSafeId(modelProfile)) {
        throw topologyError("INVALID_MODEL_PROFILE", `Group \`${groupId}\` has invalid model profile id`, {
          group: groupId,
          modelProfile
        });
      }
    }
  }
}

function validateGroupId(groupId: string): void {
  if (!isSafeId(groupId)) {
    throw topologyError("INVALID_GROUP_ID", `Invalid topology group id \`${groupId}\``, { group: groupId });
  }
}

function validateAgenticNode(node: NormalizedTopologyNode, options: TopologyValidationOptions): void {
  if (node.role !== undefined) {
    throw topologyError("INVALID_META_NODE", "Agentic nodes must not set a meta role", { nodeId: node.id });
  }
  if (node.id === START_NODE_ID || node.id === FINISH_NODE_ID) {
    throw topologyError("INVALID_META_NODE", "Reserved start/finish IDs must use kind: meta", { nodeId: node.id });
  }
  if (node.reference !== undefined) {
    throw topologyError("INVALID_REFERENCE_NODE", "Agentic nodes must not set reference", { nodeId: node.id });
  }
  validatePromptPath(node, options);
  for (const modelProfile of node.model_profiles) {
    if (!isSafeId(modelProfile)) {
      throw topologyError("INVALID_MODEL_PROFILE", `Node \`${node.id}\` has invalid model profile id`, {
        nodeId: node.id,
        modelProfile
      });
    }
  }
  validateOutputs(node);
}

function validateMetaNode(node: NormalizedTopologyNode): void {
  if (node.role !== "start" && node.role !== "finish") {
    throw topologyError("INVALID_META_NODE", "Meta nodes must set role: start or role: finish", { nodeId: node.id });
  }
  const expectedId = node.role === "start" ? START_NODE_ID : FINISH_NODE_ID;
  if (node.id !== expectedId) {
    throw topologyError("INVALID_META_NODE", `${node.role} meta node must use id ${expectedId}`, {
      nodeId: node.id
    });
  }
  const forbidden = [
    ["prompt", node.prompt],
    ["reference", node.reference],
    ["group", node.group],
    ["timeout_seconds", node.timeout_seconds],
    ["max_attempts", node.max_attempts],
    ["required_commands", node.required_commands.length === 0 ? undefined : node.required_commands]
  ].filter(([, value]) => value !== undefined);
  if (forbidden.length > 0 || node.outputs.length > 0) {
    throw topologyError("INVALID_META_NODE", "Meta nodes must not define execution fields", { nodeId: node.id });
  }
  if (node.loops !== 1 || node.loop_mode !== "parallel") {
    throw topologyError("INVALID_META_NODE", "Meta nodes must use loops: 1 and loop_mode: parallel", {
      nodeId: node.id
    });
  }
}

function validateReferenceNode(node: NormalizedTopologyNode): void {
  if (node.role !== undefined) {
    throw topologyError("INVALID_REFERENCE_NODE", "Reference nodes must not set a meta role", { nodeId: node.id });
  }
  if (node.prompt !== undefined) {
    throw topologyError("INVALID_REFERENCE_NODE", "Reference nodes must not set a prompt", { nodeId: node.id });
  }
  if (node.id === START_NODE_ID || node.id === FINISH_NODE_ID) {
    throw topologyError("INVALID_REFERENCE_NODE", "Reserved start/finish IDs must use kind: meta", { nodeId: node.id });
  }
  if (node.reference === undefined || !/^[a-z0-9][a-z0-9._-]*$/u.test(node.reference)) {
    throw topologyError("INVALID_REFERENCE_NODE", "Reference nodes must define a valid reference id", {
      nodeId: node.id,
      reference: node.reference
    });
  }
  if (node.model_profiles.length > 0) {
    throw topologyError("INVALID_REFERENCE_NODE", "Reference nodes must not set model_profiles", { nodeId: node.id });
  }
  if (node.required_commands.length > 0) {
    throw topologyError("INVALID_REFERENCE_NODE", "Reference nodes must not set required_commands", {
      nodeId: node.id
    });
  }
  if (node.max_attempts !== undefined) {
    throw topologyError("INVALID_REFERENCE_NODE", "Reference nodes must not set max_attempts", { nodeId: node.id });
  }
  if (node.loops !== 1 || node.loop_mode !== "parallel") {
    throw topologyError("INVALID_REFERENCE_NODE", "Reference nodes must use loops: 1 and loop_mode: parallel", {
      nodeId: node.id
    });
  }
  validateOutputs(node);
  const primary = node.outputs.find((output) => output.primary);
  if (primary?.path === RUN_REFERENCE_MANIFEST_FILE) {
    throw topologyError(
      "INVALID_REFERENCE_NODE",
      `Reference nodes must not use ${RUN_REFERENCE_MANIFEST_FILE} as their primary output`,
      { nodeId: node.id }
    );
  }
  if (!node.outputs.some((output) => output.path === RUN_REFERENCE_MANIFEST_FILE)) {
    throw topologyError(
      "INVALID_REFERENCE_NODE",
      `Reference nodes must include ${RUN_REFERENCE_MANIFEST_FILE} in outputs`,
      { nodeId: node.id }
    );
  }
}

function validatePromptPath(node: NormalizedTopologyNode, options: TopologyValidationOptions): void {
  const promptPath = resolvedPromptPath(node);
  assertSafeRelativePath("prompt", promptPath, "INVALID_PROMPT_PATH");
  if (!options.projectRoot) {
    return;
  }
  const promptRoot = path.join(options.projectRoot, ".ultrafuzz", "prompts");
  const fullPath = path.join(promptRoot, promptPath);
  ensureInside(promptRoot, fullPath);
  if (options.requirePromptFiles) {
    ensureNoSymlinkComponents(promptRoot);
    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
      throw topologyError("MISSING_PROMPT_FILE", `Missing prompt file ${promptPath}`, {
        nodeId: node.id,
        path: promptPath
      });
    }
    ensureNoSymlinkComponents(fullPath);
  }
}

function validateArtifactPath(nodeId: string, artifact: string): void {
  if (!artifact || !isString(artifact)) {
    throw topologyError("INVALID_OUTPUT_CONTRACT", "Invalid artifact output path", { nodeId, path: artifact });
  }
  if (!isSafeArtifactPath(artifact)) {
    throw topologyError("INVALID_OUTPUT_CONTRACT", `Invalid artifact output path ${artifact}`, {
      nodeId,
      path: artifact
    });
  }
  if (artifact === ARTIFACT_MANIFEST_FILE) {
    throw topologyError(
      "INVALID_OUTPUT_CONTRACT",
      `Artifact output path ${artifact} is reserved for the runtime manifest`,
      { nodeId, path: artifact }
    );
  }
}

function isSafeArtifactPath(artifact: string): boolean {
  return !artifact.startsWith("artifacts/") && !artifact.startsWith(".ultrafuzz/") && artifact.length > 0
    ? /^[A-Za-z0-9._/@+-]+$/.test(artifact) &&
        !artifact.includes("//") &&
        !artifact.includes("\\") &&
        !artifact.split("/").some((part) => part === "" || part === "." || part === "..") &&
        !path.posix.isAbsolute(artifact) &&
        !path.win32.isAbsolute(artifact)
    : false;
}

function validateOutputs(node: NormalizedTopologyNode): void {
  if (node.outputs.length === 0) {
    throw topologyError("MISSING_OUTPUT_CONTRACT", `Node \`${node.id}\` must declare at least one output`, {
      nodeId: node.id
    });
  }
  const seen = new Set<string>();
  for (const output of node.outputs) {
    validateArtifactPath(node.id, output.path);
    if (seen.has(output.path)) {
      throw topologyError("DUPLICATE_OUTPUT_PATH", `Node \`${node.id}\` repeats output \`${output.path}\``, {
        nodeId: node.id,
        path: output.path
      });
    }
    seen.add(output.path);
  }
  const primaries = node.outputs.filter((output) => output.primary);
  if (primaries.length !== 1) {
    throw topologyError("INVALID_PRIMARY_OUTPUT", `Node \`${node.id}\` must declare exactly one primary output`, {
      nodeId: node.id,
      count: primaries.length
    });
  }
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw topologyError("UNKNOWN_TOPOLOGY_FIELD", `${context} contains unknown field \`${unknown[0]}\``, {
      field: unknown[0]
    });
  }
}

function validateRequiredMetaNodes(nodeById: Map<string, NormalizedTopologyNode>): void {
  if (!nodeById.has(START_NODE_ID)) {
    throw topologyError("MISSING_META_NODE", `Missing ${START_NODE_ID} meta node`, { nodeId: START_NODE_ID });
  }
  if (!nodeById.has(FINISH_NODE_ID)) {
    throw topologyError("MISSING_META_NODE", `Missing ${FINISH_NODE_ID} meta node`, { nodeId: FINISH_NODE_ID });
  }
}

function validateDependencies(nodes: NormalizedTopologyNode[], ids: Set<string>): void {
  for (const node of nodes) {
    const seen = new Set<string>();
    for (const dependency of node.depends_on) {
      if (dependency === node.id) {
        throw topologyError("CYCLE_DETECTED", `Node \`${node.id}\` depends on itself`, { nodeId: node.id });
      }
      if (seen.has(dependency)) {
        throw topologyError("DUPLICATE_DEPENDENCY", `Node \`${node.id}\` repeats dependency \`${dependency}\``, {
          nodeId: node.id,
          dependency
        });
      }
      seen.add(dependency);
      if (!ids.has(dependency)) {
        throw topologyError("UNKNOWN_DEPENDENCY", `Node \`${node.id}\` depends on unknown node \`${dependency}\``, {
          nodeId: node.id,
          dependency
        });
      }
    }
  }
}

function validateNoCycles(nodeById: Map<string, NormalizedTopologyNode>): void {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  for (const id of [...nodeById.keys()].sort()) {
    visit(id, nodeById, state, stack);
  }
}

function visit(
  id: string,
  nodeById: Map<string, NormalizedTopologyNode>,
  state: Map<string, "visiting" | "done">,
  stack: string[]
): void {
  const mark = state.get(id);
  if (mark === "done") {
    return;
  }
  if (mark === "visiting") {
    const start = stack.indexOf(id);
    throw topologyError("CYCLE_DETECTED", "Topology contains a dependency cycle", {
      cycle: stack.slice(start >= 0 ? start : 0)
    });
  }
  state.set(id, "visiting");
  stack.push(id);
  const node = nodeById.get(id);
  if (!node) {
    return;
  }
  for (const dependency of node.depends_on) {
    visit(dependency, nodeById, state, stack);
  }
  stack.pop();
  state.set(id, "done");
}

function validateEntryExit(nodes: NormalizedTopologyNode[]): void {
  const start = nodes.find((node) => node.id === START_NODE_ID);
  const finish = nodes.find((node) => node.id === FINISH_NODE_ID);
  if (!start || start.kind !== "meta" || start.role !== "start" || start.depends_on.length !== 0) {
    throw topologyError("INVALID_ENTRY_EXIT", `${START_NODE_ID} must be the only root`, { nodeId: START_NODE_ID });
  }
  if (!finish || finish.kind !== "meta" || finish.role !== "finish" || finish.depends_on.length === 0) {
    throw topologyError("INVALID_ENTRY_EXIT", `${FINISH_NODE_ID} must depend on terminal work`, {
      nodeId: FINISH_NODE_ID
    });
  }
  if (!nodes.some((node) => node.kind === "agentic")) {
    throw topologyError("INVALID_ENTRY_EXIT", "Topology must include at least one agentic node", {
      nodeId: START_NODE_ID
    });
  }
  const dependents = new Map<string, number>();
  for (const node of nodes) {
    for (const dependency of node.depends_on) {
      dependents.set(dependency, (dependents.get(dependency) ?? 0) + 1);
    }
  }
  for (const node of nodes) {
    if (node.id !== START_NODE_ID && node.depends_on.length === 0) {
      throw topologyError("INVALID_ENTRY_EXIT", `Only ${START_NODE_ID} may have no dependencies`, { nodeId: node.id });
    }
    const dependentCount = dependents.get(node.id) ?? 0;
    if (node.id === FINISH_NODE_ID && dependentCount > 0) {
      throw topologyError("INVALID_ENTRY_EXIT", `${FINISH_NODE_ID} must not have dependents`, { nodeId: node.id });
    }
    if (node.id !== FINISH_NODE_ID && dependentCount === 0) {
      throw topologyError("INVALID_ENTRY_EXIT", `Only ${FINISH_NODE_ID} may be terminal`, { nodeId: node.id });
    }
  }
}

function resolveEffectiveLoopCounts(
  topology: NormalizedProjectTopology,
  options: TopologyValidationOptions,
  limits: TopologyLimits
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of topology.nodes) {
    let loops = node.loops;
    if (!node.explicit_loops) {
      loops =
        groupDefaultsFor(topology, node).loops ??
        (isNormalStrategyNode(node) ? topology.defaults.strategy_loops : loops);
    }
    validateLoopCount(node.id, loops, limits);
    counts[node.id] = loops;
  }
  return counts;
}

function groupDefaultsFor(topology: NormalizedProjectTopology, node: NormalizedTopologyNode): TopologyGroupDefaults {
  return node.group === undefined ? {} : (topology.groups[node.group]?.defaults ?? {});
}

function validatePromptArtifacts(topology: NormalizedProjectTopology, options: TopologyValidationOptions): void {
  const promptTexts = { ...(options.promptTexts ?? {}) };
  if (options.projectRoot) {
    for (const node of topology.nodes) {
      if (node.kind !== "agentic") {
        continue;
      }
      const promptPath = resolvedPromptPath(node);
      if (promptTexts[node.id] !== undefined || promptTexts[promptPath] !== undefined) {
        continue;
      }
      const fullPath = path.join(options.projectRoot, ".ultrafuzz", "prompts", promptPath);
      if (existsSync(fullPath) && statSync(fullPath).isFile()) {
        promptTexts[promptPath] = readFileSync(fullPath, "utf8");
      }
    }
  }
  validateArtifactHandoffs(topology, { promptTexts });
}

function validateLoopDefault(loops: number, limits: TopologyLimits): void {
  if (loops <= 0) {
    throw topologyError("INVALID_LOOP_COUNT", "defaults.strategy_loops must be greater than zero", {
      loops
    });
  }
  if (loops > limits.maxLoops) {
    throw topologyError("TOO_MANY_LOOPS", "defaults.strategy_loops exceeds limit", {
      loops,
      max: limits.maxLoops
    });
  }
}

function validateLoopCount(nodeId: string, loops: number, limits: TopologyLimits): void {
  if (loops <= 0) {
    throw topologyError("INVALID_LOOP_COUNT", `Node \`${nodeId}\` loops must be greater than zero`, {
      nodeId,
      loops
    });
  }
  if (loops > limits.maxLoops) {
    throw topologyError("TOO_MANY_LOOPS", `Node \`${nodeId}\` loops exceeds limit`, {
      nodeId,
      loops,
      max: limits.maxLoops
    });
  }
}

function validateExpandedSize(effectiveLoopCounts: Record<string, number>, limits: TopologyLimits): void {
  const count = Object.values(effectiveLoopCounts).reduce((sum, loops) => sum + loops, 0);
  if (count > limits.maxExpandedNodes) {
    throw topologyError("TOO_MANY_EXPANDED_NODES", "Expanded topology exceeds node limit", {
      count,
      max: limits.maxExpandedNodes
    });
  }
}

function validateConcreteIdCollisions(
  nodes: NormalizedTopologyNode[],
  effectiveLoopCounts: Record<string, number>
): void {
  const logicalIds = new Set(nodes.map((node) => node.id));
  const concreteIds = new Set<string>();
  for (const node of nodes) {
    for (const concreteId of concreteIdsFor(node.id, effectiveLoopCounts[node.id] ?? node.loops)) {
      if (concreteId !== node.id && logicalIds.has(concreteId)) {
        throw topologyError(
          "CONCRETE_NODE_ID_COLLISION",
          `Concrete node id \`${concreteId}\` collides with a logical id`,
          {
            nodeId: node.id,
            concreteId
          }
        );
      }
      if (concreteIds.has(concreteId)) {
        throw topologyError("CONCRETE_NODE_ID_COLLISION", `Duplicate concrete node id \`${concreteId}\``, {
          nodeId: node.id,
          concreteId
        });
      }
      concreteIds.add(concreteId);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
