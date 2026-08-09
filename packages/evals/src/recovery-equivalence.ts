import path from "node:path";

import {
  assertPlannedGraph,
  assertRegularFileInside,
  parseStrictJsonBytes,
  readRegularFileSnapshot,
  readRunState,
  replayEvents,
  replayNodeAttempts,
  type EventRecord,
  type NodeAttemptLedgerEntry,
  type PlannedGraphDocument,
  type RunState
} from "@ultrafuzz/artifacts";
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

interface RecoveryGeneration {
  id: string;
  controllerInvocationId: string;
  firstObservedAt: string;
  attempts: NodeAttemptLedgerEntry[];
  executedModelAttempts: NodeAttemptLedgerEntry[];
}

interface ControllerObservation {
  id: string;
  at: string;
  workflowRunId: string;
  controlGeneration: string;
}

export function parseRecoveryEquivalence(value: unknown): EvalRecoveryEquivalence {
  return recoveryEquivalenceSchema.parse(value) as EvalRecoveryEquivalence;
}

/**
 * Derive recovery exposure from immutable node attempts and controller
 * submissions. Only aggregate counts leave the run directory.
 */
export function classifyRecoveryEquivalence(input: {
  runRoot: string;
  policy?: EvalRecoveryEquivalencePolicy;
}): EvalRecoveryEquivalence {
  const policy = resolveRecoveryEquivalencePolicy(input.policy);
  const runRoot = path.resolve(input.runRoot);
  const graph = assertPlannedGraph(readCurrentJson(path.join(runRoot, "graph.json"), runRoot));
  const state = readRunState(path.join(runRoot, "state.json"));
  if (new Set(graph.nodes.map((node) => node.id)).size !== graph.nodes.length) {
    throw evidenceError("planned graph contains duplicate node identities");
  }
  if (graph.nodes.some((node) => node.kind === "reference" && node.model_fanout.length > 0)) {
    throw evidenceError("planned graph model metadata is inconsistent");
  }
  const modelNodeIds = new Set(graph.nodes.filter(isModelBackedNode).map((node) => node.id));
  const ledgerPath = path.join(runRoot, "attempts.jsonl");
  const entries = readNodeAttemptLedger(ledgerPath, runRoot, state.run_id);
  const graphNodeIds = new Set(graph.nodes.map((node) => node.id));
  if (entries.some((entry) => !graphNodeIds.has(entry.node_id))) {
    throw evidenceError("node attempt lineage does not match the planned graph");
  }
  const observedModelNodeIds = new Set(
    entries.filter((entry) => modelNodeIds.has(entry.node_id)).map((entry) => entry.node_id)
  );
  if (modelWorkMayHaveStarted(state, modelNodeIds) && observedModelNodeIds.size === 0) {
    throw evidenceError("model execution exposure cannot be reconstructed");
  }
  if ([...startedModelNodeIds(state, modelNodeIds)].some((nodeId) => !observedModelNodeIds.has(nodeId))) {
    throw evidenceError("model execution exposure is incomplete");
  }

  const controllerObservations = controllerInvocations(path.join(runRoot, "events.jsonl"), runRoot, state.run_id);
  const generationsById = new Map<string, RecoveryGeneration>();
  for (const observation of controllerObservations) {
    const generationId = recoveryGenerationId(observation.controlGeneration, observation.workflowRunId);
    if (generationsById.has(generationId)) {
      throw evidenceError(`multiple controller submissions name recovery generation ${generationId}`);
    }
    generationsById.set(generationId, {
      id: generationId,
      controllerInvocationId: observation.id,
      firstObservedAt: observation.at,
      attempts: [],
      executedModelAttempts: []
    });
  }
  for (const entry of entries) {
    const generationId = recoveryGenerationId(entry.control_generation, entry.workflow_run_id);
    const generation = generationsById.get(generationId);
    if (generation === undefined || entry.lifecycle.started_at < generation.firstObservedAt) {
      throw evidenceError("node attempt lineage does not match a prior controller submission");
    }
    generation.attempts.push(entry);
    if (entry.reuse.status === "executed" && modelNodeIds.has(entry.node_id)) {
      generation.executedModelAttempts.push(entry);
    }
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
    observed_node_attempts: entries.length,
    observed_workflow_executions: new Set(entries.map((entry) => entry.workflow_run_id)).size,
    observed_controller_invocations: controllerObservations.length,
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
  if (record.ultrafuzz_run_root === undefined) {
    throw evidenceError(`eval row ${record.row_id} has no run root for recovery classification`);
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
  if (record.ultrafuzz_run_root === undefined) {
    throw evidenceError(`eval row ${record.row_id} has no run root for recovery classification`);
  }
  return isTerminalStatus(readRunState(path.join(record.ultrafuzz_run_root, "state.json")).status);
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

function modelWorkMayHaveStarted(state: RunState, modelNodeIds: ReadonlySet<string>): boolean {
  if (state.status === "succeeded" && modelNodeIds.size > 0) return true;
  return [...modelNodeIds].some((nodeId) => {
    const node = state.nodes[nodeId];
    return (
      node?.started_at !== undefined || (node?.status !== undefined && !["pending", "skipped"].includes(node.status))
    );
  });
}

function startedModelNodeIds(
  state: RunState,
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

function isTerminalStatus(status: string): boolean {
  return ["succeeded", "failed", "timed-out", "canceled"].includes(status);
}

function isModelBackedNode(node: PlannedGraphDocument["nodes"][number]): boolean {
  return node.kind === "agentic";
}

function controllerInvocations(eventsPath: string, root: string, expectedRunId: string): ControllerObservation[] {
  let records: EventRecord[];
  try {
    assertRegularFileInside(root, eventsPath, "recovery equivalence event ledger");
    records = replayEvents(eventsPath, Number.MAX_SAFE_INTEGER).records;
  } catch (error) {
    throw evidenceError(`failed to read current recovery ledger ${eventsPath}`, error);
  }
  const observations = new Map<string, ControllerObservation>();
  for (const [index, record] of records.entries()) {
    if (record.run_id !== expectedRunId) throw evidenceError(`workflow event ${index + 1} names another run`);
    const eventType = requireString(record.event_type, `workflow event ${index + 1} event_type`);
    if (!["workflow-submitted", "workflow-lifecycle-submitted"].includes(eventType)) continue;
    const payload = requireRecord(record.payload, `workflow event ${index + 1} payload`);
    const id = requireString(payload.controller_invocation_id, `workflow event ${index + 1} controller_invocation_id`);
    const at = requireTimestamp(payload.controller_invoked_at, `workflow event ${index + 1} controller_invoked_at`);
    const workflowRunId = requireString(payload.workflow_run_id, `workflow event ${index + 1} workflow_run_id`);
    const controlGeneration = requireString(
      payload.control_generation,
      `workflow event ${index + 1} control_generation`
    );
    if (!/^[a-f0-9]{64}$/u.test(controlGeneration)) {
      throw evidenceError(`workflow event ${index + 1} control_generation must be a lowercase SHA-256 digest`);
    }
    if (observations.has(id)) throw evidenceError(`duplicate controller invocation ${JSON.stringify(id)}`);
    observations.set(id, { id, at, workflowRunId, controlGeneration });
  }
  if (observations.size === 0) throw evidenceError("workflow event ledger has no controller submission evidence");
  return [...observations.values()];
}

function recoveryGenerationId(controlGeneration: string, workflowRunId: string): string {
  return JSON.stringify([controlGeneration, workflowRunId]);
}

function readCurrentJson(filePath: string, root: string): unknown {
  try {
    assertRegularFileInside(root, filePath, "recovery equivalence source");
    return parseStrictJsonBytes(readRegularFileSnapshot(filePath, MAX_RECOVERY_SOURCE_BYTES), {
      maxBytes: MAX_RECOVERY_SOURCE_BYTES,
      maxDepth: 128,
      maxItems: 500_000,
      maxProperties: 500_000
    });
  } catch (error) {
    throw evidenceError(`failed to read current recovery evidence ${filePath}`, error);
  }
}

function readNodeAttemptLedger(filePath: string, root: string, expectedRunId: string): NodeAttemptLedgerEntry[] {
  try {
    assertRegularFileInside(root, filePath, "recovery equivalence ledger");
    return replayNodeAttempts({ attemptLedgerPath: filePath, runId: expectedRunId }).entries;
  } catch (error) {
    throw evidenceError(`failed to read current recovery ledger ${filePath}`, error);
  }
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw evidenceError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw evidenceError(`${field} must be a non-empty string`);
  return value;
}

function requireTimestamp(value: unknown, field: string): string {
  const timestamp = requireString(value, field);
  if (!Number.isFinite(Date.parse(timestamp))) throw evidenceError(`${field} must be a valid timestamp`);
  return timestamp;
}

function evidenceError(message: string, cause?: unknown): EvalError {
  return new EvalError("EVAL_RECOVERY_EVIDENCE_INVALID", message, {
    ...(cause === undefined ? {} : { reason: cause instanceof Error ? cause.message : String(cause) })
  });
}
