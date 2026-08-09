import type { EvmbenchCatalog, EvmbenchLock, EvmbenchProfile, NormalizedEvmbenchResult } from "./contracts.js";

export const IMPLEMENTED_EVMBENCH_SEMANTIC_GATES = Object.freeze([
  "audit IDs are unique",
  "debug is a subset of detect-tasks",
  "node timeout does not exceed workflow timeout",
  "official scores do not exceed their maxima",
  "recall equals score divided by max_score",
  "official totals equal the per-audit aggregates",
  "target, image, and per-audit identities agree",
  "operational values agree with completeness labels"
] as const);

export type EvmbenchSemanticGateName = (typeof IMPLEMENTED_EVMBENCH_SEMANTIC_GATES)[number];

export const EVMBENCH_SEMANTIC_GATES_BY_SCHEMA_ID = Object.freeze({
  "urn:ultrafuzz:schema:evmbench:catalog:2": ["audit IDs are unique"],
  "urn:ultrafuzz:schema:evmbench:lock:2": ["debug is a subset of detect-tasks"],
  "urn:ultrafuzz:schema:evmbench:profile:2": ["node timeout does not exceed workflow timeout"],
  "urn:ultrafuzz:schema:evmbench:result:2": [
    "official scores do not exceed their maxima",
    "recall equals score divided by max_score",
    "official totals equal the per-audit aggregates",
    "target, image, and per-audit identities agree",
    "operational values agree with completeness labels"
  ]
} as const satisfies Readonly<Record<string, readonly EvmbenchSemanticGateName[]>>);

export class EvmbenchSemanticValidationError extends Error {
  readonly gate: EvmbenchSemanticGateName;

  constructor(gate: EvmbenchSemanticGateName, message: string) {
    super(`${gate}: ${message}`);
    this.name = "EvmbenchSemanticValidationError";
    this.gate = gate;
  }
}

/** Run each semantic gate registered for an already shape-valid document once. */
export function assertEvmbenchDocumentSemantics(schemaId: string, value: unknown): void {
  const gates = EVMBENCH_SEMANTIC_GATES_BY_SCHEMA_ID[schemaId as keyof typeof EVMBENCH_SEMANTIC_GATES_BY_SCHEMA_ID];
  if (gates === undefined) throw new Error(`unregistered EVMBench schema: ${schemaId}`);
  for (const gate of gates) assertEvmbenchSemanticGate(gate, value);
}

function assertEvmbenchSemanticGate(gate: EvmbenchSemanticGateName, value: unknown): void {
  switch (gate) {
    case "audit IDs are unique":
      assertUnique(
        (value as EvmbenchCatalog).audits.map((audit) => audit.id),
        gate,
        "catalog audit ID"
      );
      return;
    case "debug is a subset of detect-tasks": {
      const lock = value as EvmbenchLock;
      const detected = new Set(lock.splits["detect-tasks"]);
      for (const auditId of lock.splits.debug) {
        if (!detected.has(auditId)) fail(gate, `debug audit ${auditId} is absent from detect-tasks`);
      }
      return;
    }
    case "node timeout does not exceed workflow timeout": {
      const profile = value as EvmbenchProfile;
      if (profile.node_timeout_seconds > profile.workflow_timeout_seconds) {
        fail(gate, "node timeout exceeds workflow timeout");
      }
      return;
    }
    case "official scores do not exceed their maxima": {
      const metrics = (value as NormalizedEvmbenchResult).official_evmbench;
      assertBoundedMetric(metrics.score, metrics.max_score, gate, "score", "max_score");
      assertBoundedMetric(metrics.detect_award, metrics.detect_max_award, gate, "detect_award", "detect_max_award");
      for (const [auditId, row] of Object.entries(metrics.per_audit)) {
        assertBoundedMetric(row.score, row.max_score, gate, `${auditId} score`, "max_score");
        assertBoundedMetric(
          row.detect_award,
          row.detect_max_award,
          gate,
          `${auditId} detect_award`,
          "detect_max_award"
        );
      }
      return;
    }
    case "recall equals score divided by max_score": {
      const metrics = (value as NormalizedEvmbenchResult).official_evmbench;
      if (!approximatelyEqual(metrics.recall, metrics.score / metrics.max_score)) {
        fail(gate, "recall does not match score/max_score");
      }
      return;
    }
    case "official totals equal the per-audit aggregates": {
      const metrics = (value as NormalizedEvmbenchResult).official_evmbench;
      const perAudit = Object.values(metrics.per_audit);
      assertAggregate(metrics.score, sum(perAudit, "score"), gate, "score");
      assertAggregate(metrics.max_score, sum(perAudit, "max_score"), gate, "max_score");
      assertAggregate(metrics.detect_award, sum(perAudit, "detect_award"), gate, "detect_award");
      assertAggregate(metrics.detect_max_award, sum(perAudit, "detect_max_award"), gate, "detect_max_award");
      return;
    }
    case "target, image, and per-audit identities agree": {
      const result = value as NormalizedEvmbenchResult;
      const targetIds = result.provenance.targets.map((target) => target.audit_id);
      const imageIds = result.provenance.audit_images.map((image) => image.audit_id);
      const perAuditIds = Object.keys(result.official_evmbench.per_audit);
      assertUnique(targetIds, gate, "target audit ID");
      assertUnique(imageIds, gate, "audit image ID");
      if (!sameValues(targetIds, imageIds)) fail(gate, "audit image identities do not match targets");
      if (!sameValues(targetIds, perAuditIds)) fail(gate, "official per-audit identities do not match targets");
      return;
    }
    case "operational values agree with completeness labels": {
      const operational = (value as NormalizedEvmbenchResult).operational;
      assertCompleteness(operational.runtime_seconds, operational.completeness.runtime, gate, "runtime_seconds");
      assertCompleteness(operational.token_usage, operational.completeness.token_usage, gate, "token_usage");
      assertCompleteness(operational.cost_usd, operational.completeness.cost, gate, "cost_usd");
      return;
    }
  }
}

function assertUnique(values: readonly string[], gate: EvmbenchSemanticGateName, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) fail(gate, `duplicate ${label} ${value}`);
    seen.add(value);
  }
}

function assertBoundedMetric(
  value: number,
  maximum: number,
  gate: EvmbenchSemanticGateName,
  valueLabel: string,
  maximumLabel: string
): void {
  if (value > maximum) fail(gate, `${valueLabel} exceeds ${maximumLabel}`);
}

function assertAggregate(value: number, aggregate: number, gate: EvmbenchSemanticGateName, field: string): void {
  if (!approximatelyEqual(value, aggregate)) fail(gate, `${field} does not equal its per-audit aggregate`);
}

function assertCompleteness(
  value: number | null,
  completeness: "complete" | "unavailable",
  gate: EvmbenchSemanticGateName,
  field: string
): void {
  if ((completeness === "complete") !== (value !== null)) {
    fail(gate, `${field} does not match its completeness label`);
  }
}

function sum<Row extends Record<Field, number>, Field extends string>(rows: readonly Row[], field: Field): number {
  return rows.reduce((total, row) => total + row[field], 0);
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  const sortedRight = [...right].sort();
  return left.length === right.length && [...left].sort().every((value, index) => value === sortedRight[index]);
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right)) * 8;
}

function fail(gate: EvmbenchSemanticGateName, message: string): never {
  throw new EvmbenchSemanticValidationError(gate, message);
}
