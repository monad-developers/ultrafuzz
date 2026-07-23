import fs from "node:fs";
import path from "node:path";

import { assertRegularFileInside, replayNodeAttempts, type NodeAttemptLedgerEntry } from "@ultrafuzz/artifacts";
import { z } from "zod/v4";

import { resolveRecoveryEquivalencePolicy } from "./suite.js";
import {
  type EvalRecoveryEquivalence,
  type EvalRecoveryEquivalenceClassification,
  type EvalRecoveryEquivalencePolicy,
  type EvalRunRecord,
  type EvalSuiteSpec
} from "./types.js";

export const RECOVERY_EQUIVALENCE_SCHEMA_VERSION = "ultrafuzz.eval.recovery-equivalence.v1" as const;

const MAX_RECOVERY_SOURCE_BYTES = 16 * 1024 * 1024;
const nonNegativeInteger = z.number().int().nonnegative();

const recoveryEquivalenceSchema = z
  .strictObject({
    schema_version: z.literal(RECOVERY_EQUIVALENCE_SCHEMA_VERSION),
    policy: z.strictObject({ max_repeated_model_executions: nonNegativeInteger }),
    unique_model_backed_node_executions: nonNegativeInteger,
    repeated_model_backed_node_executions: nonNegativeInteger,
    recovery_reexecuted_model_backed_node_executions: nonNegativeInteger,
    infrastructure_only_recovery_generations: nonNegativeInteger,
    model_work_recovery_generations: nonNegativeInteger,
    no_progress_recovery_generations: nonNegativeInteger,
    recovery_generations: nonNegativeInteger,
    observed_node_attempts: nonNegativeInteger,
    observed_workflow_executions: nonNegativeInteger,
    observed_controller_invocations: nonNegativeInteger,
    classification: z.enum(["clean", "infrastructure-recovered", "model-reexecuted-within-policy", "non-comparable"]),
    reason: z.string().min(1).nullable()
  })
  .superRefine((value, context) => {
    if (
      value.recovery_generations !==
      value.infrastructure_only_recovery_generations + value.model_work_recovery_generations
    ) {
      context.addIssue({
        code: "custom",
        path: ["recovery_generations"],
        message: "must equal infrastructure-only plus model-work recovery generations"
      });
    }
    if (value.no_progress_recovery_generations > value.infrastructure_only_recovery_generations) {
      context.addIssue({
        code: "custom",
        path: ["no_progress_recovery_generations"],
        message: "cannot exceed infrastructure-only recovery generations"
      });
    }
    if (value.recovery_reexecuted_model_backed_node_executions > value.repeated_model_backed_node_executions) {
      context.addIssue({
        code: "custom",
        path: ["recovery_reexecuted_model_backed_node_executions"],
        message: "cannot exceed all repeated model-backed node executions"
      });
    }
    if ((value.classification === "non-comparable") !== (value.reason !== null)) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "must be present exactly for non-comparable classifications"
      });
    }
  });

const graphSchema = z.looseObject({
  nodes: z.array(
    z.looseObject({
      id: z.string().min(1),
      kind: z.string().optional(),
      model_fanout: z.array(z.unknown()).optional()
    })
  )
});

const stateSchema = z.looseObject({
  status: z.string().optional(),
  nodes: z.record(z.string(), z.looseObject({ status: z.string().optional(), started_at: z.string().optional() }))
});

const eventSchema = z.looseObject({
  event_id: z.string().min(1).optional(),
  timestamp: z.string().min(1),
  event_type: z.string().min(1),
  payload: z.unknown()
});

interface RecoveryGeneration {
  id: string;
  controllerInvocationId: string;
  firstObservedAt: string;
  attempts: NodeAttemptLedgerEntry[];
  executedModelAttempts: NodeAttemptLedgerEntry[];
}

export function parseRecoveryEquivalence(value: unknown): EvalRecoveryEquivalence {
  return recoveryEquivalenceSchema.parse(value) as EvalRecoveryEquivalence;
}

/**
 * Derive recovery exposure from immutable node attempts and controller
 * submissions. Only aggregate counts leave the run directory.
 */
export function classifyRecoveryEquivalence(input: {
  runRoot?: string;
  policy?: EvalRecoveryEquivalencePolicy;
}): EvalRecoveryEquivalence {
  const policy = resolveRecoveryEquivalencePolicy(input.policy);
  if (input.runRoot === undefined) {
    return nonComparable(policy, "run evidence is unavailable");
  }
  const runRoot = path.resolve(input.runRoot);
  const graph = readJsonSource(path.join(runRoot, "graph.json"), graphSchema);
  const state = readJsonSource(path.join(runRoot, "state.json"), stateSchema);
  if (graph === undefined || state === undefined) {
    return nonComparable(policy, "execution lineage is unavailable");
  }
  const modelNodeIds = new Set(graph.nodes.filter(isModelBackedNode).map((node) => node.id));
  const ledgerPath = path.join(runRoot, "attempts.jsonl");
  let replay: ReturnType<typeof replayNodeAttempts>;
  try {
    assertRegularFileInside(runRoot, ledgerPath, "node attempt ledger");
    if (fs.statSync(ledgerPath).size > MAX_RECOVERY_SOURCE_BYTES) {
      return nonComparable(policy, "node attempt ledger exceeds the size limit");
    }
    replay = replayNodeAttempts(ledgerPath);
  } catch {
    if (modelWorkMayHaveStarted(state, modelNodeIds)) {
      return nonComparable(policy, "node attempt ledger is unavailable");
    }
    replay = { entries: [], malformedEntries: 0, duplicateEntries: 0 };
  }
  if (replay.malformedEntries > 0 || replay.duplicateEntries > 0) {
    return nonComparable(policy, "node attempt ledger cannot be reconstructed");
  }
  const graphNodeIds = new Set(graph.nodes.map((node) => node.id));
  if (replay.entries.some((entry) => !graphNodeIds.has(entry.node_id))) {
    return nonComparable(policy, "node attempt lineage does not match the planned graph", replay.entries);
  }
  if (replay.entries.length === 0 && modelWorkMayHaveStarted(state, modelNodeIds)) {
    return nonComparable(policy, "model execution exposure cannot be reconstructed");
  }

  const controllerObservations = controllerInvocations(path.join(runRoot, "events.jsonl"));
  if (controllerObservations === undefined) {
    return nonComparable(policy, "controller recovery lineage cannot be reconstructed", replay.entries);
  }
  const generationsById = new Map<string, RecoveryGeneration>();
  for (const entry of replay.entries) {
    const generationId = JSON.stringify([entry.controller_invocation_id, entry.workflow_execution_id]);
    const generation = generationsById.get(generationId) ?? {
      id: generationId,
      controllerInvocationId: entry.controller_invocation_id,
      firstObservedAt: entry.lifecycle.started_at,
      attempts: [],
      executedModelAttempts: []
    };
    if (entry.lifecycle.started_at < generation.firstObservedAt) {
      generation.firstObservedAt = entry.lifecycle.started_at;
    }
    generation.attempts.push(entry);
    if (entry.reuse.status === "executed" && modelNodeIds.has(entry.node_id)) {
      generation.executedModelAttempts.push(entry);
    }
    generationsById.set(generation.id, generation);
  }
  const controllersWithAttempts = new Set<string>(replay.entries.map((entry) => entry.controller_invocation_id));
  for (const observation of controllerObservations) {
    if (controllersWithAttempts.has(observation.id)) continue;
    const generationId = JSON.stringify([observation.id, null]);
    generationsById.set(generationId, {
      id: generationId,
      controllerInvocationId: observation.id,
      firstObservedAt: observation.at,
      attempts: [],
      executedModelAttempts: []
    });
  }
  const generations = [...generationsById.values()].sort(
    (left, right) => left.firstObservedAt.localeCompare(right.firstObservedAt) || left.id.localeCompare(right.id)
  );
  const recoveryGenerations = generations.slice(1);
  const noProgress = recoveryGenerations.filter((generation) => generation.attempts.length === 0).length;

  const seenModelStrategies = new Set<string>();
  let repeatedModelExecutions = 0;
  let modelWork = 0;
  generations.forEach((generation, index) => {
    const priorStrategies = new Set(seenModelStrategies);
    let generationRepeatedModelExecutions = 0;
    for (const entry of generation.executedModelAttempts) {
      if (priorStrategies.has(entry.strategy_attempt_id)) {
        repeatedModelExecutions += 1;
        generationRepeatedModelExecutions += 1;
      }
      seenModelStrategies.add(entry.strategy_attempt_id);
    }
    if (index > 0 && generationRepeatedModelExecutions > 0) {
      modelWork += 1;
    }
  });
  const infrastructureOnly = recoveryGenerations.length - modelWork;

  const executedModelAttempts = generations.reduce(
    (total, generation) => total + generation.executedModelAttempts.length,
    0
  );
  const allRepeatedModelExecutions = executedModelAttempts - seenModelStrategies.size;
  let classification: EvalRecoveryEquivalenceClassification;
  let reason: string | null = null;
  if (repeatedModelExecutions > policy.max_repeated_model_executions) {
    classification = "non-comparable";
    reason = `repeated model execution count ${repeatedModelExecutions} exceeds policy maximum ${policy.max_repeated_model_executions}`;
  } else if (repeatedModelExecutions > 0) {
    classification = "model-reexecuted-within-policy";
  } else if (recoveryGenerations.length > 0) {
    classification = "infrastructure-recovered";
  } else {
    classification = "clean";
  }

  return parseRecoveryEquivalence({
    schema_version: RECOVERY_EQUIVALENCE_SCHEMA_VERSION,
    policy: { max_repeated_model_executions: policy.max_repeated_model_executions },
    unique_model_backed_node_executions: seenModelStrategies.size,
    repeated_model_backed_node_executions: allRepeatedModelExecutions,
    recovery_reexecuted_model_backed_node_executions: repeatedModelExecutions,
    infrastructure_only_recovery_generations: infrastructureOnly,
    model_work_recovery_generations: modelWork,
    no_progress_recovery_generations: noProgress,
    recovery_generations: recoveryGenerations.length,
    observed_node_attempts: replay.entries.length,
    observed_workflow_executions: new Set(replay.entries.map((entry) => entry.workflow_execution_id)).size,
    observed_controller_invocations: new Set([
      ...controllerObservations.map((observation) => observation.id),
      ...replay.entries.map((entry) => entry.controller_invocation_id)
    ]).size,
    classification,
    reason
  });
}

/** Preserve a recorded classification verbatim; derive it only once when absent. */
export function withRecordedRecoveryEquivalence(
  record: EvalRunRecord,
  suite: Pick<EvalSuiteSpec, "recovery_equivalence">
): EvalRunRecord {
  if (record.recovery_equivalence !== undefined) {
    return { ...record, recovery_equivalence: parseRecoveryEquivalence(record.recovery_equivalence) };
  }
  return {
    ...record,
    recovery_equivalence: classifyRecoveryEquivalence({
      runRoot: record.ultrafuzz_run_root,
      policy: suite.recovery_equivalence
    })
  };
}

export function recoveryEquivalenceIsPublishable(
  equivalence: EvalRecoveryEquivalence,
  policyInput: EvalRecoveryEquivalencePolicy | undefined
): boolean {
  const policy = resolveRecoveryEquivalencePolicy(policyInput);
  return (
    equivalence.policy.max_repeated_model_executions === policy.max_repeated_model_executions &&
    equivalence.recovery_reexecuted_model_backed_node_executions <= policy.max_repeated_model_executions &&
    equivalence.classification !== "non-comparable" &&
    (policy.publication !== "clean" || equivalence.classification === "clean")
  );
}

function nonComparable(
  policy: EvalRecoveryEquivalencePolicy,
  reason: string,
  entries: readonly NodeAttemptLedgerEntry[] = []
): EvalRecoveryEquivalence {
  return parseRecoveryEquivalence({
    schema_version: RECOVERY_EQUIVALENCE_SCHEMA_VERSION,
    policy: { max_repeated_model_executions: policy.max_repeated_model_executions },
    unique_model_backed_node_executions: 0,
    repeated_model_backed_node_executions: 0,
    recovery_reexecuted_model_backed_node_executions: 0,
    infrastructure_only_recovery_generations: 0,
    model_work_recovery_generations: 0,
    no_progress_recovery_generations: 0,
    recovery_generations: 0,
    observed_node_attempts: entries.length,
    observed_workflow_executions: new Set(entries.map((entry) => entry.workflow_execution_id)).size,
    observed_controller_invocations: new Set(entries.map((entry) => entry.controller_invocation_id)).size,
    classification: "non-comparable",
    reason
  });
}

function modelWorkMayHaveStarted(state: z.infer<typeof stateSchema>, modelNodeIds: ReadonlySet<string>): boolean {
  if (state.status === "succeeded" && modelNodeIds.size > 0) return true;
  return [...modelNodeIds].some((nodeId) => {
    const node = state.nodes[nodeId];
    return (
      node?.started_at !== undefined || (node?.status !== undefined && !["pending", "skipped"].includes(node.status))
    );
  });
}

function isModelBackedNode(node: z.infer<typeof graphSchema>["nodes"][number]): boolean {
  if (node.kind === "meta" || node.kind === "reference") return false;
  if (node.kind === "agentic") return true;
  if ((node.model_fanout?.length ?? 0) > 0) return true;
  return node.kind === undefined && node.model_fanout === undefined;
}

function controllerInvocations(eventsPath: string): Array<{ id: string; at: string }> | undefined {
  if (!fs.existsSync(eventsPath)) return undefined;
  try {
    assertRegularFileInside(path.dirname(eventsPath), eventsPath, "workflow event ledger");
    if (fs.statSync(eventsPath).size > MAX_RECOVERY_SOURCE_BYTES) return undefined;
    const observations = new Map<string, string>();
    for (const line of fs.readFileSync(eventsPath, "utf8").split(/\r?\n/u)) {
      if (line.trim().length === 0) continue;
      const raw = JSON.parse(line) as unknown;
      const rawRecord = recordValue(raw);
      const eventType = stringField(rawRecord, "event_type");
      if (eventType === undefined || !["workflow-submitted", "workflow-lifecycle-submitted"].includes(eventType)) {
        continue;
      }
      const parsed = eventSchema.safeParse(raw);
      if (!parsed.success) return undefined;
      const payload = recordValue(parsed.data.payload);
      const id = stringField(payload, "controller_invocation_id") ?? parsed.data.event_id;
      const at = stringField(payload, "controller_invoked_at") ?? parsed.data.timestamp;
      if (id === undefined || !Number.isFinite(Date.parse(at))) return undefined;
      const previous = observations.get(id);
      observations.set(id, previous === undefined || at < previous ? at : previous);
    }
    return [...observations].map(([id, at]) => ({ id, at }));
  } catch {
    return undefined;
  }
}

function readJsonSource<T>(filePath: string, schema: z.ZodType<T>): T | undefined {
  try {
    assertRegularFileInside(path.dirname(filePath), filePath, "recovery equivalence source");
    if (fs.statSync(filePath).size > MAX_RECOVERY_SOURCE_BYTES) return undefined;
    const parsed = schema.safeParse(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}
