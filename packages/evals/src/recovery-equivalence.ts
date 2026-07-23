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
import { EvalError } from "./utils.js";

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
    if (value.model_work_recovery_generations > value.recovery_reexecuted_model_backed_node_executions) {
      context.addIssue({
        code: "custom",
        path: ["model_work_recovery_generations"],
        message: "cannot exceed recovery model re-executions"
      });
    }
    if (
      value.observed_node_attempts <
      value.unique_model_backed_node_executions + value.repeated_model_backed_node_executions
    ) {
      context.addIssue({
        code: "custom",
        path: ["observed_node_attempts"],
        message: "cannot be less than accounted model-backed node executions"
      });
    }
    if (
      value.unique_model_backed_node_executions + value.repeated_model_backed_node_executions > 0 &&
      (value.observed_workflow_executions === 0 || value.observed_controller_invocations === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["observed_workflow_executions"],
        message: "model-backed executions require observed workflow and controller lineage"
      });
    }
    if ((value.classification === "non-comparable") !== (value.reason !== null)) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "must be present exactly for non-comparable classifications"
      });
    }
    if (
      value.classification !== "non-comparable" &&
      value.recovery_reexecuted_model_backed_node_executions > value.policy.max_repeated_model_executions
    ) {
      context.addIssue({
        code: "custom",
        path: ["classification"],
        message: "must be non-comparable when recovery model re-executions exceed the policy maximum"
      });
    }
    if (
      value.classification === "clean" &&
      (value.recovery_generations !== 0 ||
        value.recovery_reexecuted_model_backed_node_executions !== 0 ||
        value.model_work_recovery_generations !== 0 ||
        value.observed_workflow_executions > 1 ||
        value.observed_controller_invocations > 1)
    ) {
      context.addIssue({
        code: "custom",
        path: ["classification"],
        message: "clean classifications cannot contain recovery generations or recovery model re-executions"
      });
    }
    if (
      value.classification === "infrastructure-recovered" &&
      (value.recovery_generations === 0 ||
        value.model_work_recovery_generations !== 0 ||
        value.recovery_reexecuted_model_backed_node_executions !== 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["classification"],
        message: "infrastructure-recovered classifications require infrastructure-only recovery"
      });
    }
    if (
      value.classification === "model-reexecuted-within-policy" &&
      (value.recovery_generations === 0 ||
        value.model_work_recovery_generations === 0 ||
        value.recovery_reexecuted_model_backed_node_executions === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["classification"],
        message: "model-reexecuted classifications require recovery model re-executions"
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
  if (new Set(graph.nodes.map((node) => node.id)).size !== graph.nodes.length) {
    return nonComparable(policy, "planned graph contains duplicate node identities");
  }
  if (
    graph.nodes.some(
      (node) => (node.kind === "meta" || node.kind === "reference") && (node.model_fanout?.length ?? 0) > 0
    )
  ) {
    return nonComparable(policy, "planned graph model metadata is inconsistent");
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
  const observedModelNodeIds = new Set(
    replay.entries.filter((entry) => modelNodeIds.has(entry.node_id)).map((entry) => entry.node_id)
  );
  if (modelWorkMayHaveStarted(state, modelNodeIds) && observedModelNodeIds.size === 0) {
    return nonComparable(policy, "model execution exposure cannot be reconstructed");
  }
  if ([...startedModelNodeIds(state, modelNodeIds)].some((nodeId) => !observedModelNodeIds.has(nodeId))) {
    return nonComparable(policy, "model execution exposure is incomplete", replay.entries);
  }

  const controllerObservations = controllerInvocations(path.join(runRoot, "events.jsonl"));
  if (controllerObservations === undefined) {
    return nonComparable(policy, "controller recovery lineage cannot be reconstructed", replay.entries);
  }
  const reconciledControllers = reconcileAttemptControllers(replay.entries, controllerObservations);
  if (reconciledControllers === undefined) {
    return nonComparable(policy, "controller recovery lineage cannot be reconciled", replay.entries);
  }
  const generationsById = new Map<string, RecoveryGeneration>();
  for (const entry of replay.entries) {
    const controllerInvocationId = reconciledControllers.get(entry.attempt_id);
    if (controllerInvocationId === undefined) {
      return nonComparable(policy, "controller recovery lineage cannot be reconciled", replay.entries);
    }
    const generationId = JSON.stringify([controllerInvocationId, entry.workflow_execution_id]);
    const generation = generationsById.get(generationId) ?? {
      id: generationId,
      controllerInvocationId,
      firstObservedAt:
        controllerObservations.find((observation) => observation.id === controllerInvocationId)?.at ??
        entry.lifecycle.started_at,
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
  const controllersWithAttempts = new Set<string>(reconciledControllers.values());
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
      ...reconciledControllers.values()
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

/**
 * Collapse the append-only run ledger while rejecting any attempt to replace
 * an already-recorded recovery classification for a row.
 */
export function reconcileEvalRunRecords(records: readonly EvalRunRecord[]): Map<string, EvalRunRecord> {
  const recordsByRow = new Map<string, EvalRunRecord>();
  const recoveryByRow = new Map<string, EvalRecoveryEquivalence>();
  for (const record of records) {
    const recovery =
      record.recovery_equivalence === undefined
        ? recoveryByRow.get(record.row_id)
        : parseRecoveryEquivalence(record.recovery_equivalence);
    const previous = recoveryByRow.get(record.row_id);
    if (previous !== undefined && recovery !== undefined && JSON.stringify(previous) !== JSON.stringify(recovery)) {
      throw new EvalError(
        "EVAL_RECOVERY_EQUIVALENCE_CONFLICT",
        `eval row ${record.row_id} has conflicting recorded recovery classifications`
      );
    }
    if (recovery !== undefined) recoveryByRow.set(record.row_id, recovery);
    recordsByRow.set(record.row_id, {
      ...record,
      ...(recovery === undefined ? {} : { recovery_equivalence: recovery })
    });
  }
  return recordsByRow;
}

/** Recovery evidence is immutable only after the underlying workflow is terminal. */
export function recoveryEquivalenceCanBeRecorded(record: EvalRunRecord): boolean {
  if (record.ultrafuzz_run_root !== undefined) {
    const state = readJsonSource(path.join(record.ultrafuzz_run_root, "state.json"), stateSchema);
    if (state !== undefined) {
      return isTerminalStatus(state.status);
    }
  }
  return record.workflow?.terminal === true && isTerminalStatus(record.workflow.status);
}

export function recoveryEquivalenceIsPublishable(
  equivalence: EvalRecoveryEquivalence,
  policyInput: EvalRecoveryEquivalencePolicy | undefined
): boolean {
  const policy = resolveRecoveryEquivalencePolicy(policyInput);
  const parsed = recoveryEquivalenceSchema.safeParse(equivalence);
  if (!parsed.success) return false;
  return (
    parsed.data.policy.max_repeated_model_executions === policy.max_repeated_model_executions &&
    parsed.data.recovery_reexecuted_model_backed_node_executions <= policy.max_repeated_model_executions &&
    parsed.data.classification !== "non-comparable" &&
    (policy.publication !== "clean" || parsed.data.classification === "clean")
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

function startedModelNodeIds(
  state: z.infer<typeof stateSchema>,
  modelNodeIds: ReadonlySet<string>
): ReadonlySet<string> {
  return new Set(
    [...modelNodeIds].filter((nodeId) => {
      const node = state.nodes[nodeId];
      return (
        node?.started_at !== undefined || (node?.status !== undefined && !["pending", "skipped"].includes(node.status))
      );
    })
  );
}

function isTerminalStatus(status: string | undefined): boolean {
  return status !== undefined && ["succeeded", "failed", "timed-out", "canceled"].includes(status);
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
      if (observations.has(id)) return undefined;
      observations.set(id, at);
    }
    return [...observations].map(([id, at]) => ({ id, at }));
  } catch {
    return undefined;
  }
}

function reconcileAttemptControllers(
  entries: readonly NodeAttemptLedgerEntry[],
  observations: readonly { id: string; at: string }[]
): Map<string, string> | undefined {
  if (entries.length > 0 && observations.length === 0) return undefined;
  const orderedObservations = [...observations].sort(
    (left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id)
  );
  const observationIds = new Set(orderedObservations.map((observation) => observation.id));
  const aliasesByObservation = new Map<string, string>();
  const reconciled = new Map<string, string>();
  const seenAttemptControllerIds = new Set<string>();
  let previousAttemptControllerId: string | undefined;
  for (const entry of [...entries].sort((left, right) =>
    left.lifecycle.started_at.localeCompare(right.lifecycle.started_at)
  )) {
    if (
      entry.controller_invocation_id !== previousAttemptControllerId &&
      seenAttemptControllerIds.has(entry.controller_invocation_id)
    ) {
      return undefined;
    }
    seenAttemptControllerIds.add(entry.controller_invocation_id);
    previousAttemptControllerId = entry.controller_invocation_id;
    if (
      orderedObservations.some(
        (observation) =>
          observation.id === entry.controller_invocation_id && observation.at <= entry.lifecycle.started_at
      )
    ) {
      reconciled.set(entry.attempt_id, entry.controller_invocation_id);
      continue;
    }
    const observation = orderedObservations.filter((candidate) => candidate.at <= entry.lifecycle.started_at).at(-1);
    if (observation === undefined) return undefined;
    const alias = aliasesByObservation.get(observation.id);
    if (alias === undefined || alias === entry.controller_invocation_id) {
      aliasesByObservation.set(observation.id, entry.controller_invocation_id);
      reconciled.set(entry.attempt_id, observation.id);
    } else {
      let syntheticId = JSON.stringify(["attempt-controller", entry.controller_invocation_id]);
      while (observationIds.has(syntheticId)) syntheticId = `:${syntheticId}`;
      reconciled.set(entry.attempt_id, syntheticId);
    }
  }
  return reconciled;
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
