import { createHash } from "node:crypto";

import { topologyError } from "./errors.js";
import type { ExpandedGraph, ExpandedNode, FingerprintInputs } from "./types.js";

export interface FingerprintGraphOptions {
  inputs?: FingerprintInputs;
}

export function fingerprintGraph(graph: ExpandedGraph, options: FingerprintGraphOptions = {}): string {
  const payload = {
    graphVersion: graph.graphVersion,
    topologyVersion: graph.topologyVersion,
    groups: graph.groups,
    nodes: graph.nodes.map(fingerprintNode).sort((left, right) => left.id.localeCompare(right.id)),
    inputs: {
      ...(graph.fingerprintInputs ?? {}),
      ...(options.inputs ?? {})
    }
  };
  try {
    return createHash("sha256").update(canonicalJson(payload)).digest("hex");
  } catch (error) {
    throw topologyError("SERIALIZATION", "Failed to serialize graph fingerprint payload", {
      reason: error instanceof Error ? error.message : String(error)
    });
  }
}

interface FingerprintNodePayload {
  id: string;
  [key: string]: unknown;
}

function fingerprintNode(node: ExpandedNode): FingerprintNodePayload {
  return {
    id: node.id,
    logicalId: node.logicalId,
    label: node.label,
    kind: node.kind,
    ...(node.role ? { role: node.role } : {}),
    ...(node.promptPath ? { promptPath: node.promptPath } : {}),
    ...(node.reference ? { reference: node.reference } : {}),
    ...(node.referenceRevision ? { referenceRevision: node.referenceRevision } : {}),
    ...(node.group ? { group: node.group } : {}),
    dependsOn: [...node.dependsOn].sort(),
    ...(node.requiredCommands === undefined ? {} : { requiredCommands: [...node.requiredCommands].sort() }),
    artifactDir: node.artifactDir,
    ...(node.timeoutSeconds !== undefined ? { timeoutSeconds: node.timeoutSeconds } : {}),
    retryPolicy: node.retryPolicy,
    loop: node.loop,
    outputs: [...node.outputs].sort((left, right) => left.path.localeCompare(right.path)),
    ...(node.dynamic ? { dynamic: node.dynamic } : {}),
    modelFanout: [...node.modelFanout].sort((left, right) => {
      if (left.loopIndex !== right.loopIndex) {
        return left.loopIndex - right.loopIndex;
      }
      return left.modelIndex - right.modelIndex;
    })
  };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (record[key] !== undefined) {
      result[key] = canonicalize(record[key]);
    }
  }
  return result;
}
