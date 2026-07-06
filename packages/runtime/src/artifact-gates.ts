import fs from "node:fs";
import path from "node:path";

import {
  getNodeArtifactDir,
  readRunState,
  safeResolveInside,
  updateNodeState,
  type RunLayout,
  type RunState
} from "@ultrafuzz/artifacts";

import type { PlannedGraph, PlannedGraphNode, RuntimeDiagnostic } from "./types.js";
import { diagnosticFromError } from "./utils.js";

export interface DependencyGateDecision {
  ok: boolean;
  reason_code?: string;
  reason?: string;
  blocked_by?: string[];
}

export interface RequiredArtifactGate {
  ok: boolean;
  diagnostics: RuntimeDiagnostic[];
  missing: string[];
}

export function checkDependencyLegality(graph: PlannedGraph): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  const ids = new Set(graph.nodes.map((node) => node.id));
  for (const node of graph.nodes) {
    const seen = new Set<string>();
    for (const dependency of node.depends_on) {
      if (dependency === node.id) {
        diagnostics.push({
          code: "RUNTIME_DEPENDENCY_SELF",
          message: `node ${node.id} depends on itself`,
          severity: "error",
          source: "runtime",
          path: `graph.nodes.${node.id}.depends_on`
        });
      }
      if (seen.has(dependency)) {
        diagnostics.push({
          code: "RUNTIME_DEPENDENCY_DUPLICATE",
          message: `node ${node.id} repeats dependency ${dependency}`,
          severity: "error",
          source: "runtime",
          path: `graph.nodes.${node.id}.depends_on`
        });
      }
      seen.add(dependency);
      if (!ids.has(dependency)) {
        diagnostics.push({
          code: "RUNTIME_DEPENDENCY_UNKNOWN",
          message: `node ${node.id} depends on unknown node ${dependency}`,
          severity: "error",
          source: "runtime",
          path: `graph.nodes.${node.id}.depends_on`
        });
      }
    }
  }
  return diagnostics;
}

export function dependencyGateForNode(node: PlannedGraphNode, state: RunState): DependencyGateDecision {
  const blockedBy = node.depends_on.filter((dependency) => {
    const status = state.nodes[dependency]?.status;
    return status !== "succeeded" && status !== "reused-from-prior-run";
  });
  if (blockedBy.length === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    reason_code: "DEPENDENCY_NOT_SATISFIED",
    reason: `node ${node.id} cannot run until dependencies succeed or are compatibly reused`,
    blocked_by: blockedBy
  };
}

export function verifyRequiredArtifactsForNode(layout: RunLayout, node: PlannedGraphNode): RequiredArtifactGate {
  return verifyRequiredArtifactsForAttempt(layout, node, node.id);
}

export function verifyRequiredArtifactsForAttempt(
  layout: RunLayout,
  node: PlannedGraphNode,
  attemptId: string
): RequiredArtifactGate {
  const diagnostics: RuntimeDiagnostic[] = [];
  const missing: string[] = [];
  let artifactDir: string;
  try {
    artifactDir = getNodeArtifactDir(layout, attemptId);
  } catch (error) {
    diagnostics.push(diagnosticFromError(error, "artifact-gates", "ARTIFACT_DIR_INVALID"));
    return { ok: false, diagnostics, missing };
  }

  for (const required of node.required_artifacts) {
    try {
      const absolutePath = safeResolveInside(artifactDir, required, "required artifact");
      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
        missing.push(required);
        diagnostics.push({
          code: "REQUIRED_ARTIFACT_MISSING",
          message: `required artifact ${required} was not produced by ${attemptId}`,
          severity: "error",
          source: "artifact-gates",
          path: path.posix.join("artifacts", attemptId, required)
        });
      }
    } catch (error) {
      diagnostics.push(diagnosticFromError(error, "artifact-gates", "REQUIRED_ARTIFACT_INVALID"));
    }
  }

  return {
    ok: diagnostics.length === 0,
    diagnostics,
    missing
  };
}

export function markNodeBlockedByDependencies(
  layout: RunLayout,
  node: PlannedGraphNode,
  decision: DependencyGateDecision
): RunState {
  return updateNodeState(layout, node.id, {
    status: "skipped",
    finished_at: new Date().toISOString(),
    last_error: decision.reason ?? "dependency gate blocked node",
    provenance: {
      reason_code: decision.reason_code ?? "DEPENDENCY_NOT_SATISFIED",
      blocked_by: decision.blocked_by ?? []
    }
  });
}

export function invalidateDownstreamOfFailedRequiredNodes(layout: RunLayout, graph: PlannedGraph): RunState {
  let state = readRunState(layout);
  for (const node of graph.nodes) {
    if (state.nodes[node.id]?.status !== "pending") {
      continue;
    }
    const failedDependencies = node.depends_on.filter((dependency) =>
      ["failed", "timed-out", "canceled", "invalidated", "skipped"].includes(state.nodes[dependency]?.status ?? "")
    );
    if (failedDependencies.length > 0) {
      state = markNodeBlockedByDependencies(layout, node, {
        ok: false,
        reason_code: "DEPENDENCY_NOT_SATISFIED",
        reason: `node ${node.id} cannot run until dependencies succeed or are compatibly reused`,
        blocked_by: failedDependencies
      });
    }
  }
  return state;
}
