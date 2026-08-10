import { PromptError, extractPromptVariables } from "@ultrafuzz/prompts";
import type { PromptVariableReference } from "@ultrafuzz/prompts";
import { START_NODE_ID } from "./types.js";
import type { NormalizedProjectTopology, NormalizedTopologyNode } from "./types.js";
import { topologyError } from "./errors.js";
import { isSafeId } from "./path-utils.js";

export { extractPromptVariables };
export type { PromptVariableReference };

export interface ArtifactHandoffValidationOptions {
  promptTexts?: Record<string, string>;
}

export function validateArtifactHandoffs(
  topology: NormalizedProjectTopology,
  options: ArtifactHandoffValidationOptions = {}
): void {
  const nodeById = new Map(topology.nodes.map((node) => [node.id, node]));
  for (const node of topology.nodes) {
    if (node.kind !== "agentic") {
      continue;
    }
    const promptText = promptTextForNode(node, options.promptTexts);
    if (promptText === undefined) {
      continue;
    }
    for (const variable of extractPromptVariablesForNode(node, promptText)) {
      validatePromptVariable(node, variable, nodeById);
    }
  }
}

function promptTextForNode(
  node: NormalizedTopologyNode,
  promptTexts: Record<string, string> | undefined
): string | undefined {
  if (!promptTexts) {
    return undefined;
  }
  const promptPath = node.prompt ?? (node.group ? `${node.group}/${node.id}.md` : `${node.id}.md`);
  return promptTexts[promptPath] ?? promptTexts[node.id];
}

function validatePromptVariable(
  node: NormalizedTopologyNode,
  variable: PromptVariableReference,
  nodeById: Map<string, NormalizedTopologyNode>
): void {
  if (variable.name === "artifact_path" && variable.argument !== undefined) {
    const referenced = requireSingleNodeId(node, variable);
    const producer = validateAncestorReference(node, referenced, nodeById);
    if (variable.path !== undefined && !producer.outputs.some((output) => output.path === variable.path)) {
      throw topologyError(
        "UNDECLARED_PROMPT_ARTIFACT_REFERENCE",
        `Prompt references undeclared output \`${variable.path}\` from node \`${referenced}\``,
        { nodeId: node.id, referenced, path: variable.path }
      );
    }
    return;
  }

  if (variable.name === "artifact_handoff") {
    const referenced = requireSingleNodeId(node, variable);
    const producer = validateAncestorReference(node, referenced, nodeById);
    if (!producer.outputs.some((output) => output.primary)) {
      throw topologyError(
        "MISSING_PROMPT_ARTIFACT_HANDOFF",
        `Node \`${referenced}\` does not declare a primary output for handoff`,
        { nodeId: node.id, referenced }
      );
    }
    return;
  }

  if (variable.name === "ancestor_artifacts") {
    const producers =
      variable.argument === undefined || variable.argument.trim().length === 0
        ? node.depends_on
        : variable.argument
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean);
    if (producers.length === 0) {
      throw topologyError("INVALID_PROMPT_ARTIFACT_REFERENCE", "ancestor_artifacts found no producer nodes", {
        nodeId: node.id,
        variable: variable.raw
      });
    }
    for (const producerId of producers) {
      if (!isSafeId(producerId)) {
        throw topologyError("INVALID_PROMPT_ARTIFACT_REFERENCE", `Invalid producer id \`${producerId}\``, {
          nodeId: node.id,
          referenced: producerId
        });
      }
      const producer = validateAncestorReference(node, producerId, nodeById);
      if (producer.outputs.length === 0) {
        throw topologyError(
          "INVALID_PROMPT_ARTIFACT_REFERENCE",
          `ancestor_artifacts producer \`${producerId}\` has no outputs`,
          { nodeId: node.id, referenced: producerId }
        );
      }
    }
    return;
  }

  if (variable.name === "ancestor_generated_test_manifests") {
    const producers = [...nodeById.values()].filter(
      (candidate) =>
        candidate.id !== node.id &&
        isAncestor(node, candidate.id, nodeById, new Set()) &&
        candidate.outputs.some((output) => output.contract === "ultrafuzz/generated-tests@1")
    );
    if (producers.length === 0) {
      throw topologyError(
        "INVALID_PROMPT_ARTIFACT_REFERENCE",
        "ancestor_generated_test_manifests found no ancestor outputs with contract `ultrafuzz/generated-tests@1`",
        { nodeId: node.id, variable: variable.raw }
      );
    }
  }
}

function extractPromptVariablesForNode(node: NormalizedTopologyNode, promptText: string): PromptVariableReference[] {
  try {
    return extractPromptVariables(promptText);
  } catch (error) {
    if (error instanceof PromptError) {
      throw topologyErrorForPromptError(node, error);
    }
    throw error;
  }
}

function topologyErrorForPromptError(node: NormalizedTopologyNode, error: PromptError): Error {
  const details = isRecord(error.details) ? error.details : {};
  const variable = typeof details.variable === "string" ? details.variable : undefined;
  if (error.code === "missing-template-variable") {
    return topologyError("UNKNOWN_PROMPT_VARIABLE", error.message, {
      nodeId: node.id,
      ...(variable ? { variable } : {}),
      reason: error.code
    });
  }
  return topologyError("INVALID_PROMPT_ARTIFACT_REFERENCE", error.message, {
    nodeId: node.id,
    ...(variable ? { variable } : {}),
    reason: error.code
  });
}

function requireSingleNodeId(node: NormalizedTopologyNode, variable: PromptVariableReference): string {
  const referenced = variable.argument?.trim();
  if (!referenced || referenced.includes(",")) {
    throw topologyError("INVALID_PROMPT_ARTIFACT_REFERENCE", `Invalid artifact variable \`${variable.raw}\``, {
      nodeId: node.id,
      variable: variable.raw
    });
  }
  if (!isSafeId(referenced) || referenced === START_NODE_ID) {
    throw topologyError("INVALID_PROMPT_ARTIFACT_REFERENCE", `Invalid producer id \`${referenced}\``, {
      nodeId: node.id,
      referenced
    });
  }
  return referenced;
}

function validateAncestorReference(
  node: NormalizedTopologyNode,
  referenced: string,
  nodeById: Map<string, NormalizedTopologyNode>
): NormalizedTopologyNode {
  const producer = nodeById.get(referenced);
  if (!producer) {
    throw topologyError(
      "UNKNOWN_PROMPT_ARTIFACT_REFERENCE",
      `Prompt references unknown topology node \`${referenced}\``,
      { nodeId: node.id, referenced }
    );
  }
  if (producer.id === node.id || !isAncestor(node, referenced, nodeById, new Set())) {
    throw topologyError(
      "NON_ANCESTOR_PROMPT_ARTIFACT_REFERENCE",
      `Prompt references non-ancestor topology node \`${referenced}\``,
      { nodeId: node.id, referenced }
    );
  }
  return producer;
}

function isAncestor(
  node: NormalizedTopologyNode,
  referenced: string,
  nodeById: Map<string, NormalizedTopologyNode>,
  visited: Set<string>
): boolean {
  for (const dependency of node.depends_on) {
    if (dependency === referenced) {
      return true;
    }
    if (visited.has(dependency)) {
      continue;
    }
    visited.add(dependency);
    const dependencyNode = nodeById.get(dependency);
    if (dependencyNode && isAncestor(dependencyNode, referenced, nodeById, visited)) {
      return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
