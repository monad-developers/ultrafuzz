import type { ArtifactManifestEntry } from "@ultrafuzz/artifacts";
import type { RuntimeDiagnostic } from "@ultrafuzz/runtime";

import type { EvalMatrixRow, EvalPlanValue, EvalRecoveryEquivalence, EvalRowScore, EvalScoreSummary } from "./types.js";
import { isRecord, warningDiagnostic } from "./utils.js";

/** The plan handed to reporters is the local plan value — providers never shape it. */
export type EvalPlan = EvalPlanValue;

/** Local score summary mirrored out to providers; grading never depends on them. */
export type EvalSummary = EvalScoreSummary;

/** Terminal outcome of one matrix row (one full ultrafuzz run). */
export interface EvalRowResult {
  status: "succeeded" | "failed" | "timed-out" | "canceled" | "launched";
  runId?: string;
  runRoot?: string;
  startedAt?: string;
  finishedAt?: string;
  graphFingerprint?: string;
  configFingerprint?: string;
  executionArtifactId?: string;
  recoveryEquivalence?: EvalRecoveryEquivalence;
  diagnostics?: RuntimeDiagnostic[];
}

/** Topology handed to the provider once per row, derived from the run's graph.json. */
export interface EvalRowGraph {
  rowId: string;
  nodes: Array<{
    id: string; // concrete node id (fanout-expanded attempt)
    logicalId: string; // node id as written in topology.yml
    kind: "agentic" | "meta" | "reference";
    group: string; // setup | properties | strategies | references | review
    dependsOn: string[]; // DAG edges from topology.yml
    modelProfileId?: string;
    model?: string;
    loopIndex?: number;
  }>;
}

export type EvalNodeEvent =
  | { type: "node-started"; at: string; attempt: number }
  | {
      type: "node-heartbeat";
      at: string;
      status: "running" | "retrying" | "waiting-approval";
      activeSeconds: number;
    }
  | {
      type: "node-finished";
      at: string;
      status: "succeeded" | "failed" | "timed-out" | "skipped";
      startedAt?: string;
      attempt: number;
      error?: string;
      findingsCount?: number;
    }
  | { type: "node-artifacts"; at: string; manifest: ArtifactManifestEntry[] };

export interface EvalNodeEventEnvelope {
  eventId: string; // events.jsonl event_id — provider idempotency key
  rowId: string;
  nodeId: string; // joins to EvalRowGraph.nodes[].id
  event: EvalNodeEvent;
}

export interface EvalArtifactUpload {
  rowId: string;
  nodeId: string;
  relativePath: string; // e.g. "report.md", "report.json"
  contentType: string;
  sizeBytes: number;
  sha256: string;
  /** Absent in manifest-only mode (private targets): publish metadata, not payload. */
  read?: () => Promise<Buffer>;
}

/**
 * Providers are pure observers/exporters. Ultrafuzz owns the loop
 * (plan → run → score → summarize, all writing local artifacts); a reporter
 * translates that stream into provider objects. Adding a provider is one file
 * implementing this interface plus one `[eval.providers.<name>]` block.
 */
export interface EvalReporter {
  readonly name: string;
  onPlan(plan: EvalPlan): Promise<void>;
  onRowStart(row: EvalMatrixRow, graph: EvalRowGraph): Promise<void>;
  onNodeEvent(envelope: EvalNodeEventEnvelope): Promise<void>;
  onArtifact(artifact: EvalArtifactUpload): Promise<void>;
  onRowFinish(row: EvalMatrixRow, result: EvalRowResult): Promise<void>;
  onScores(scores: EvalRowScore[], summary: EvalSummary): Promise<void>;
  finalize(summary: EvalSummary): Promise<{ url?: string }>;
}

const KNOWN_GROUPS = ["setup", "properties", "strategies", "references", "review"];
export const DEFAULT_GRAPH_GROUP = "default";

const guardedReporterTargets = new WeakMap<EvalReporter, EvalReporter>();

/**
 * Build the provider-facing row graph from a run's graph.json (PlannedGraph).
 * Tolerant by design: unknown shapes degrade to an empty node list rather than
 * failing telemetry for the whole row.
 */
export function graphFromPlannedGraph(graph: unknown, rowId: string): EvalRowGraph {
  if (!isRecord(graph) || !Array.isArray(graph.nodes)) {
    return { rowId, nodes: [] };
  }
  const groupNames = isRecord(graph.groups) ? Object.keys(graph.groups) : [];
  const nodes: EvalRowGraph["nodes"] = [];
  for (const candidate of graph.nodes) {
    if (!isRecord(candidate) || typeof candidate.id !== "string") {
      continue;
    }
    const logicalId = typeof candidate.logical_id === "string" ? candidate.logical_id : candidate.id;
    const fanout = Array.isArray(candidate.model_fanout) ? candidate.model_fanout[0] : undefined;
    const loop = isRecord(candidate.loop) ? candidate.loop : undefined;
    nodes.push({
      id: candidate.id,
      logicalId,
      kind: normalizeKind(candidate.kind),
      group: resolveGroup(candidate, logicalId, groupNames),
      dependsOn: Array.isArray(candidate.depends_on)
        ? candidate.depends_on.filter((entry): entry is string => typeof entry === "string")
        : [],
      ...(isRecord(fanout) && typeof fanout.model_profile_id === "string"
        ? { modelProfileId: fanout.model_profile_id }
        : {}),
      ...(isRecord(fanout) && typeof fanout.model_name === "string" ? { model: fanout.model_name } : {}),
      ...(loop && typeof loop.index === "number" ? { loopIndex: loop.index } : {})
    });
  }
  return { rowId, nodes };
}

export function groupsInGraph(graph: EvalRowGraph): string[] {
  return [...new Set(graph.nodes.map((node) => node.group))].sort();
}

function normalizeKind(kind: unknown): "agentic" | "meta" | "reference" {
  if (kind === "meta" || kind === "reference") {
    return kind;
  }
  return "agentic";
}

function resolveGroup(candidate: Record<string, unknown>, logicalId: string, groupNames: string[]): string {
  if (typeof candidate.group === "string" && candidate.group.length > 0) {
    return candidate.group;
  }
  for (const names of [groupNames, KNOWN_GROUPS]) {
    for (const name of names) {
      if (logicalId === name || logicalId.startsWith(`${name}-`) || logicalId.startsWith(`${name}.`)) {
        return name;
      }
    }
  }
  return DEFAULT_GRAPH_GROUP;
}

/**
 * Wrap a reporter so that every callback failure degrades to a warning
 * diagnostic instead of an exception — a provider outage must never kill an
 * eval run.
 */
export function guardReporter(
  reporter: EvalReporter,
  onWarning: (diagnostic: RuntimeDiagnostic) => void
): EvalReporter {
  const guard = async (operation: string, action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      onWarning(
        warningDiagnostic(
          "EVAL_REPORTER_CALLBACK_FAILED",
          `${reporter.name} ${operation} failed: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  };
  const guarded: EvalReporter = {
    name: reporter.name,
    onPlan: (plan) => guard("onPlan", () => reporter.onPlan(plan)),
    onRowStart: (row, graph) => guard("onRowStart", () => reporter.onRowStart(row, graph)),
    onNodeEvent: (envelope) => guard("onNodeEvent", () => reporter.onNodeEvent(envelope)),
    onArtifact: (artifact) => guard("onArtifact", () => reporter.onArtifact(artifact)),
    onRowFinish: (row, result) => guard("onRowFinish", () => reporter.onRowFinish(row, result)),
    onScores: (scores, summary) => guard("onScores", () => reporter.onScores(scores, summary)),
    finalize: async (summary) => {
      try {
        return await reporter.finalize(summary);
      } catch (error) {
        onWarning(
          warningDiagnostic(
            "EVAL_REPORTER_CALLBACK_FAILED",
            `${reporter.name} finalize failed: ${error instanceof Error ? error.message : String(error)}`
          )
        );
        return {};
      }
    }
  };
  guardedReporterTargets.set(guarded, reporter);
  return guarded;
}

/**
 * Return the underlying reporter for delivery loops that own their retry and
 * warning semantics. Other call sites keep using the guarded facade so a
 * provider outage cannot abort an eval run.
 */
export function reporterForReliableDelivery(reporter: EvalReporter): EvalReporter {
  let current = reporter;
  const seen = new Set<EvalReporter>();
  while (!seen.has(current)) {
    seen.add(current);
    const target = guardedReporterTargets.get(current);
    if (target === undefined) {
      return current;
    }
    current = target;
  }
  return current;
}
