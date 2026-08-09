import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { artifactContractDefinition, artifactContractSchemaBinding } from "./artifact-contracts.js";
import { ARTIFACT_SCHEMA_METADATA, type ArtifactSchemaFilename } from "./artifact-schema-metadata.js";
import { MAX_NODE_ATTEMPT_FAILURE_MESSAGE_BYTES } from "./attempt-ledger.js";

export const SEMANTIC_GATE_SCOPES = ["document", "filesystem", "cross-artifact", "git", "runtime-state"] as const;

export type SemanticGateScope = (typeof SEMANTIC_GATE_SCOPES)[number];

export interface SemanticFilesystemContext {
  /** Directory against which artifact-relative paths are resolved. */
  rootDirectory: string;
}

export interface SemanticGitContext {
  commit: string;
  tree: string;
  refs?: Readonly<Record<string, string>>;
  baseCommit?: string;
  baseTree?: string;
  resultTree?: string;
  patchSha256?: string;
}

export interface SemanticPropertyLensContext {
  sourceNodeId: string;
  document: unknown;
}

export interface SemanticArtifactSetContext {
  campaigns?: readonly unknown[];
  findings?: readonly unknown[];
  propertyCatalog?: unknown;
  propertyLenses?: readonly SemanticPropertyLensContext[];
  implementedProperties?: unknown;
}

export interface SemanticPlannedGraphContext {
  node?: unknown;
  document?: unknown;
}

export interface SemanticAttemptLedgerContext {
  entries: readonly unknown[];
  /** Trusted entries from a source run that may be referenced by reuse evidence. */
  sourceEntries?: readonly unknown[];
}

export interface SemanticRuntimeStateContext {
  graphFingerprint: string;
  configFingerprint: string;
}

export interface SemanticUsageLedgerContext {
  entries: readonly unknown[];
}

export interface SemanticEventLogContext {
  events: readonly {
    workflow_run_id: string;
    source_event_sequence: number;
    timestamp_ms: number;
    type: string;
    payload: unknown;
  }[];
}

/**
 * Host facts available to contextual semantic gates. Every field is read-only;
 * gate execution never writes an artifact, repository, ledger, or filesystem.
 */
export interface SemanticGateContext {
  filesystem?: SemanticFilesystemContext;
  git?: SemanticGitContext;
  artifactSet?: SemanticArtifactSetContext;
  plannedGraph?: SemanticPlannedGraphContext;
  attemptLedger?: SemanticAttemptLedgerContext;
  runtimeState?: SemanticRuntimeStateContext;
  usageLedger?: SemanticUsageLedgerContext;
  eventLog?: SemanticEventLogContext;
}

export interface SemanticGateExecutionRequest {
  document: unknown;
  context?: SemanticGateContext;
}

export interface SemanticGateIssue {
  path: string;
  message: string;
}

export interface SemanticGateRegistration<Name extends string = string> {
  name: Name;
  scope: SemanticGateScope;
  /** Dot-separated context capabilities required before this gate can run. */
  requiredContext: readonly string[];
}

export type SemanticGateExecutionResult<Name extends string = string> =
  | {
      status: "passed";
      gate: Name;
      scope: SemanticGateScope;
    }
  | {
      status: "failed";
      gate: Name;
      scope: SemanticGateScope;
      issues: readonly SemanticGateIssue[];
    }
  | {
      status: "requires-context";
      gate: Name;
      scope: Exclude<SemanticGateScope, "document">;
      requiredContext: readonly string[];
      missingContext: readonly string[];
    };

type GateHandler = (document: unknown, context: SemanticGateContext) => SemanticGateIssue[];

interface InternalRegistration<Name extends string = string> extends SemanticGateRegistration<Name> {
  handler: GateHandler;
}

function documentGate(handler: GateHandler): Omit<InternalRegistration, "name"> {
  return Object.freeze({ scope: "document" as const, requiredContext: Object.freeze([]), handler });
}

function contextualGate(
  scope: Exclude<SemanticGateScope, "document">,
  requiredContext: readonly string[],
  handler: GateHandler
): Omit<InternalRegistration, "name"> {
  return Object.freeze({ scope, requiredContext: Object.freeze([...requiredContext]), handler });
}

function issue(pathValue: string, message: string): SemanticGateIssue {
  return { path: pathValue, message };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function at(value: unknown, keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function arrayAt(value: unknown, keys: readonly string[]): readonly unknown[] {
  const candidate = keys.length === 0 ? value : at(value, keys);
  return Array.isArray(candidate) ? candidate : [];
}

function stringField(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  return isRecord(value) && typeof value[key] === "number" ? value[key] : undefined;
}

function booleanField(value: unknown, key: string): boolean | undefined {
  return isRecord(value) && typeof value[key] === "boolean" ? value[key] : undefined;
}

function displayPath(keys: readonly string[]): string {
  return keys.length === 0 ? "$" : `$.${keys.join(".")}`;
}

function projectedUniquenessIssues(
  groups: readonly {
    items: readonly unknown[];
    path: string;
    project: (item: Readonly<Record<string, unknown>>) => string | undefined;
    label: string;
  }[]
): SemanticGateIssue[] {
  const issues: SemanticGateIssue[] = [];
  for (const group of groups) {
    const seen = new Set<string>();
    for (const [index, value] of group.items.entries()) {
      if (!isRecord(value)) continue;
      const key = group.project(value);
      if (key === undefined) continue;
      if (seen.has(key)) {
        issues.push(issue(`${group.path}[${index}]`, `Duplicate ${group.label} ${JSON.stringify(key)}`));
      }
      seen.add(key);
    }
  }
  return issues;
}

function uniqueFieldGate(
  paths: readonly (readonly string[])[],
  field: string,
  label: string,
  options: { global?: boolean } = {}
): GateHandler {
  return (document) => {
    if (options.global) {
      return projectedUniquenessIssues([
        {
          items: paths.flatMap((keys) => arrayAt(document, keys)),
          path: paths.length === 1 ? displayPath(paths[0]!) : "$",
          project: (row) => stringField(row, field),
          label
        }
      ]);
    }
    return projectedUniquenessIssues(
      paths.map((keys) => ({
        items: arrayAt(document, keys),
        path: displayPath(keys),
        project: (row) => stringField(row, field),
        label
      }))
    );
  };
}

function uniqueCompositeGate(
  paths: readonly (readonly string[])[],
  fields: readonly string[],
  label: string,
  options: { global?: boolean } = {}
): GateHandler {
  const project = (row: Readonly<Record<string, unknown>>): string | undefined => {
    const values = fields.map((field) => row[field]);
    return values.some((value) => value === undefined) ? undefined : JSON.stringify(values);
  };
  return (document) => {
    if (options.global) {
      return projectedUniquenessIssues([
        {
          items: paths.flatMap((keys) => arrayAt(document, keys)),
          path: paths.length === 1 ? displayPath(paths[0]!) : "$",
          project,
          label
        }
      ]);
    }
    return projectedUniquenessIssues(
      paths.map((keys) => ({ items: arrayAt(document, keys), path: displayPath(keys), project, label }))
    );
  };
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const a = sortedUnique(left);
  const b = sortedUnique(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function adminConfigJoinIssues(document: unknown): SemanticGateIssue[] {
  const ids = new Set(arrayAt(document, ["surfaces"]).flatMap((row) => stringField(row, "surface_id") ?? ""));
  ids.delete("");
  const issues: SemanticGateIssue[] = [];
  for (const key of ["selector_mismatches", "ambiguous_or_incomplete_specs", "coverage_notes"] as const) {
    for (const [index, row] of arrayAt(document, [key]).entries()) {
      const id = stringField(row, "surface_id");
      if (id !== undefined && !ids.has(id)) {
        issues.push(issue(`$.${key}[${index}].surface_id`, `Unknown admin surface ID ${JSON.stringify(id)}`));
      }
    }
  }
  return issues;
}

function aggregationDestinationIssues(document: unknown): SemanticGateIssue[] {
  const rows = [...arrayAt(document, ["files"]), ...arrayAt(document, ["support_files"])];
  return [
    ...projectedUniquenessIssues([
      { items: rows, path: "$", project: (row) => stringField(row, "destination_path"), label: "destination path" }
    ]),
    ...projectedUniquenessIssues([
      {
        items: rows,
        path: "$",
        project: (row) => stringField(row, "destination_relative_path"),
        label: "destination relative path"
      }
    ])
  ];
}

function aggregationCountIssues(document: unknown): SemanticGateIssue[] {
  if (!isRecord(document)) return [];
  const expected: Readonly<Record<string, number>> = {
    copied_generated_tests: arrayAt(document, ["files"]).length,
    copied_support_files: arrayAt(document, ["support_files"]).length
  };
  return Object.entries(expected).flatMap(([field, count]) =>
    numberField(document, field) === count
      ? []
      : [issue(`$.${field}`, `${field} must equal the corresponding copied-file array length (${count})`)]
  );
}

function analysisBundlePathIssues(document: unknown): SemanticGateIssue[] {
  const files = arrayAt(document, ["files"]);
  const paths = files
    .map((entry) => stringField(entry, "path"))
    .filter((entry): entry is string => entry !== undefined);
  const issues: SemanticGateIssue[] = [];
  const sorted = [...paths].sort();
  if (paths.some((entry, index) => entry !== sorted[index])) {
    issues.push(issue("$.files", "Analysis bundle file paths must be sorted lexicographically"));
  }
  issues.push(
    ...projectedUniquenessIssues([
      { items: files, path: "$.files", project: (row) => stringField(row, "path"), label: "analysis bundle path" },
      { items: files, path: "$.files", project: (row) => stringField(row, "kind"), label: "analysis bundle kind" }
    ])
  );
  if (!files.some((entry) => stringField(entry, "kind") === "omissions")) {
    issues.push(issue("$.files", "Analysis bundle must include its omissions manifest"));
  }
  return issues;
}

function artifactVerificationDigestIssues(document: unknown): SemanticGateIssue[] {
  const publications = new Map<string, string>();
  for (const row of arrayAt(document, ["publications"])) {
    const rowPath = stringField(row, "path");
    const digest = stringField(row, "sha256");
    if (rowPath !== undefined && digest !== undefined) publications.set(rowPath, digest);
  }
  const issues: SemanticGateIssue[] = [];
  for (const [index, artifact] of arrayAt(document, ["artifacts"]).entries()) {
    const artifactPath = stringField(artifact, "path");
    const digest = stringField(artifact, "sha256");
    if (artifactPath !== undefined && publications.get(artifactPath) !== digest) {
      issues.push(
        issue(
          `$.artifacts[${index}].sha256`,
          `Publication digest does not correspond to artifact ${JSON.stringify(artifactPath)}`
        )
      );
    }
  }
  return issues;
}

function exactlyOnePrimaryIssues(document: unknown, key: string): SemanticGateIssue[] {
  const count = arrayAt(document, [key]).filter((row) => booleanField(row, "primary") === true).length;
  return count === 1 ? [] : [issue(`$.${key}`, `Exactly one ${key} entry must be primary; found ${count}`)];
}

function attemptOrderIssues(document: unknown): SemanticGateIssue[] {
  const lifecycle = at(document, ["lifecycle"]);
  const started = stringField(lifecycle, "started_at");
  const finished = stringField(lifecycle, "finished_at");
  const startedSequence = numberField(document, "started_event_sequence");
  const finishedSequence = numberField(document, "source_event_sequence");
  const issues: SemanticGateIssue[] = [];
  if (started !== undefined && finished !== undefined && Date.parse(finished) < Date.parse(started)) {
    issues.push(issue("$.lifecycle.finished_at", "Attempt finish time cannot precede its start time"));
  }
  if (startedSequence !== undefined && finishedSequence !== undefined && startedSequence >= finishedSequence) {
    issues.push(issue("$.started_event_sequence", "Attempt start event must precede its terminal source event"));
  }
  return issues;
}

function attemptFailureMessageByteLengthIssues(document: unknown): SemanticGateIssue[] {
  const message = stringField(document, "failure_message");
  if (message === undefined || Buffer.byteLength(message, "utf8") <= MAX_NODE_ATTEMPT_FAILURE_MESSAGE_BYTES) {
    return [];
  }
  return [
    issue(
      "$.failure_message",
      `Attempt failure message must not exceed ${MAX_NODE_ATTEMPT_FAILURE_MESSAGE_BYTES} UTF-8 bytes`
    )
  ];
}

function attemptOutcomeDigestIssues(document: unknown): SemanticGateIssue[] {
  if (!isRecord(document)) return [];
  const outcome = stringField(document, "outcome");
  const reuse = at(document, ["reuse"]);
  const reuseStatus = stringField(reuse, "status");
  const outputDigest = isRecord(document.manifests) ? document.manifests.output_sha256 : undefined;
  const failed = outcome !== undefined && ["failed", "timed-out", "canceled"].includes(outcome);
  const issues: SemanticGateIssue[] = [];
  if ((outcome === "reused") !== (reuseStatus === "reused")) {
    issues.push(issue("$.reuse.status", "Attempt outcome and reuse status must agree"));
  }
  if ((outcome === "succeeded" || outcome === "reused") && outputDigest === null) {
    issues.push(issue("$.manifests.output_sha256", "Succeeded and reused attempts require an output manifest digest"));
  }
  if (failed && document.failure_category === undefined) {
    issues.push(issue("$.failure_category", "Failed attempts require a failure category"));
  }
  if (!failed && (document.failure_category !== undefined || document.failure_message !== undefined)) {
    issues.push(issue("$", "Non-failed attempts cannot carry failure details"));
  }
  return issues;
}

function dependencyJoinIssues(document: unknown): SemanticGateIssue[] {
  const ids = new Set(arrayAt(document, ["dependencies"]).flatMap((row) => stringField(row, "dependency_id") ?? ""));
  ids.delete("");
  const issues: SemanticGateIssue[] = [];
  for (const key of [
    "in_scope_test_targets",
    "non_finding_rows",
    "source_backed_in_scope_rationales",
    "coverage_notes"
  ] as const) {
    for (const [index, row] of arrayAt(document, [key]).entries()) {
      const id = stringField(row, "dependency_id");
      if (id !== undefined && !ids.has(id)) {
        issues.push(issue(`$.${key}[${index}].dependency_id`, `Unknown dependency ID ${JSON.stringify(id)}`));
      }
    }
  }
  return issues;
}

function differentialResultIdentityIssues(document: unknown): SemanticGateIssue[] {
  const rows = arrayAt(document, ["red_candidates"]);
  return projectedUniquenessIssues([
    {
      items: rows,
      path: "$.red_candidates",
      project: (row) =>
        stringField(row, "stable_failure_hash") ??
        stringField(row, "failure_signature") ??
        stringField(row, "red_candidate_id"),
      label: "differential failure identity"
    }
  ]);
}

function dynamicModelJoinIssues(document: unknown): SemanticGateIssue[] {
  const agents = new Set(arrayAt(document, ["agents"]).flatMap((row) => stringField(row, "agent_id") ?? ""));
  agents.delete("");
  return arrayAt(document, ["models"]).flatMap((row, index) => {
    const agentId = stringField(row, "agent_id");
    return agentId !== undefined && !agents.has(agentId)
      ? [issue(`$.models[${index}].agent_id`, `Unknown dynamic agent ID ${JSON.stringify(agentId)}`)]
      : [];
  });
}

function dynamicRecommendationUniquenessIssues(document: unknown): SemanticGateIssue[] {
  const recommendations = arrayAt(document, ["enumerators"]).flatMap((entry) => arrayAt(entry, ["recommendations"]));
  return projectedUniquenessIssues([
    {
      items: recommendations,
      path: "$.enumerators[*].recommendations",
      project: (row) => stringField(row, "strategy_id"),
      label: "dynamic recommendation ID"
    }
  ]);
}

function dynamicSelectionCountIssues(document: unknown): SemanticGateIssue[] {
  if (!isRecord(document)) return [];
  const count = numberField(document, "selected_strategy_count");
  const actual = stringArray(document.selected_strategies).length;
  return count === actual
    ? []
    : [issue("$.selected_strategy_count", `selected_strategy_count must equal selected_strategies.length (${actual})`)];
}

function externalizedStateJoinIssues(document: unknown): SemanticGateIssue[] {
  const componentIds = new Set(
    arrayAt(document, ["state_components"]).flatMap((row) => stringField(row, "component_id") ?? "")
  );
  componentIds.delete("");
  const issues: SemanticGateIssue[] = [];
  for (const key of ["scenarios", "accounting_oracles"] as const) {
    for (const [rowIndex, row] of arrayAt(document, [key]).entries()) {
      for (const [idIndex, id] of stringArray(at(row, ["state_component_ids"])).entries()) {
        if (!componentIds.has(id)) {
          issues.push(
            issue(
              `$.${key}[${rowIndex}].state_component_ids[${idIndex}]`,
              `Unknown state component ID ${JSON.stringify(id)}`
            )
          );
        }
      }
    }
  }
  return issues;
}

function findingProjectedReferenceIssues(document: unknown): SemanticGateIssue[] {
  if (!isRecord(document)) return [];
  const groups: Array<{
    items: readonly unknown[];
    path: string;
    project: (row: Readonly<Record<string, unknown>>) => string | undefined;
    label: string;
  }> = [
    {
      items: arrayAt(document, ["family_variants"]),
      path: "$.family_variants",
      project: (row) => stringField(row, "id"),
      label: "family variant ID"
    },
    {
      items: arrayAt(document, ["family_variants"]),
      path: "$.family_variants",
      project: (row) => stringField(row, "dedupe_key"),
      label: "family variant dedupe key"
    },
    {
      items: arrayAt(document, ["related_findings"]),
      path: "$.related_findings",
      project: (row) => stringField(row, "id"),
      label: "related finding ID"
    },
    {
      items: arrayAt(document, ["lifecycle", "source_artifacts"]),
      path: "$.lifecycle.source_artifacts",
      project: (row) => {
        const values = [row.path, row.node_id, row.finding_id];
        return values.some((value) => value === undefined) ? undefined : JSON.stringify(values);
      },
      label: "lifecycle source reference"
    },
    {
      items: arrayAt(document, ["lifecycle", "strategy_hits"]),
      path: "$.lifecycle.strategy_hits",
      project: (row) =>
        JSON.stringify([
          row.strategy,
          row.attempt_index ?? null,
          row.model_id ?? null,
          row.model_index ?? null,
          row.loop_index ?? null
        ]),
      label: "strategy hit identity"
    }
  ];
  const issues = projectedUniquenessIssues(groups);
  const contributions = arrayAt(document, ["contributing_backend_failures"]);
  const seen = new Set<string>();
  for (const [index, contribution] of contributions.entries()) {
    const key =
      typeof contribution === "string"
        ? JSON.stringify([null, contribution])
        : isRecord(contribution)
          ? JSON.stringify([contribution.fuzzer_backend, contribution.failure_id])
          : undefined;
    if (key === undefined) continue;
    if (seen.has(key)) {
      issues.push(issue(`$.contributing_backend_failures[${index}]`, `Duplicate contributing backend failure ${key}`));
    }
    seen.add(key);
  }
  return issues;
}

function invariantLedgerUniquenessIssues(document: unknown): SemanticGateIssue[] {
  const issues: SemanticGateIssue[] = [
    ...uniqueFieldGate([["entries"]], "id", "invariant ledger entry ID")(document, {}),
    ...uniqueFieldGate([["inventory_rows"]], "id", "inventory row ID")(document, {}),
    ...uniqueFieldGate([["scan_probes"]], "id", "scan probe ID")(document, {})
  ];
  for (const [entryIndex, entry] of arrayAt(document, ["entries"]).entries()) {
    const ids = stringArray(at(entry, ["inventory_ids"]));
    if (new Set(ids).size !== ids.length) {
      issues.push(
        issue(`$.entries[${entryIndex}].inventory_ids`, "Inventory IDs within a ledger entry must be unique")
      );
    }
  }
  for (const [rowIndex, row] of arrayAt(document, ["inventory_rows"]).entries()) {
    const ids = stringArray(at(row, ["ledger_ids"]));
    if (new Set(ids).size !== ids.length) {
      issues.push(
        issue(`$.inventory_rows[${rowIndex}].ledger_ids`, "Ledger IDs within an inventory row must be unique")
      );
    }
  }
  return issues;
}

function invariantLedgerJoinIssues(document: unknown): SemanticGateIssue[] {
  const entries = arrayAt(document, ["entries"]);
  const rows = arrayAt(document, ["inventory_rows"]);
  const entryById = new Map(
    entries.flatMap((entry) => {
      const id = stringField(entry, "id");
      return id === undefined ? [] : [[id, entry] as const];
    })
  );
  const rowById = new Map(
    rows.flatMap((row) => {
      const id = stringField(row, "id");
      return id === undefined ? [] : [[id, row] as const];
    })
  );
  const issues: SemanticGateIssue[] = [];
  for (const [entryIndex, entry] of entries.entries()) {
    const entryId = stringField(entry, "id");
    for (const [inventoryIndex, inventoryId] of stringArray(at(entry, ["inventory_ids"])).entries()) {
      const row = rowById.get(inventoryId);
      if (row === undefined) {
        issues.push(
          issue(
            `$.entries[${entryIndex}].inventory_ids[${inventoryIndex}]`,
            `Unknown inventory row ${JSON.stringify(inventoryId)}`
          )
        );
      } else if (entryId !== undefined && !stringArray(at(row, ["ledger_ids"])).includes(entryId)) {
        issues.push(
          issue(`$.entries[${entryIndex}].inventory_ids[${inventoryIndex}]`, "Inventory join is not bidirectional")
        );
      }
    }
  }
  for (const [rowIndex, row] of rows.entries()) {
    const rowId = stringField(row, "id");
    for (const [ledgerIndex, ledgerId] of stringArray(at(row, ["ledger_ids"])).entries()) {
      const entry = entryById.get(ledgerId);
      if (entry === undefined) {
        issues.push(
          issue(
            `$.inventory_rows[${rowIndex}].ledger_ids[${ledgerIndex}]`,
            `Unknown ledger entry ${JSON.stringify(ledgerId)}`
          )
        );
      } else if (rowId !== undefined && !stringArray(at(entry, ["inventory_ids"])).includes(rowId)) {
        issues.push(
          issue(`$.inventory_rows[${rowIndex}].ledger_ids[${ledgerIndex}]`, "Ledger join is not bidirectional")
        );
      }
    }
  }
  return issues;
}

function plannedNodes(document: unknown): readonly unknown[] {
  return arrayAt(document, ["nodes"]);
}

function plannedNodeIdIssues(document: unknown): SemanticGateIssue[] {
  return uniqueFieldGate([["nodes"]], "id", "planned graph node ID")(document, {});
}

function plannedDependencyJoinIssues(document: unknown): SemanticGateIssue[] {
  const ids = new Set(plannedNodes(document).flatMap((node) => stringField(node, "id") ?? ""));
  ids.delete("");
  const issues: SemanticGateIssue[] = [];
  for (const [nodeIndex, node] of plannedNodes(document).entries()) {
    const nodeId = stringField(node, "id");
    for (const [dependencyIndex, dependency] of stringArray(at(node, ["depends_on"])).entries()) {
      if (!ids.has(dependency)) {
        issues.push(
          issue(
            `$.nodes[${nodeIndex}].depends_on[${dependencyIndex}]`,
            `Unknown planned dependency ${JSON.stringify(dependency)}`
          )
        );
      } else if (dependency === nodeId) {
        issues.push(
          issue(`$.nodes[${nodeIndex}].depends_on[${dependencyIndex}]`, "A planned node cannot depend on itself")
        );
      }
    }
  }
  return issues;
}

function plannedAcyclicityIssues(document: unknown): SemanticGateIssue[] {
  const nodes = new Map<string, unknown>();
  for (const node of plannedNodes(document)) {
    const id = stringField(node, "id");
    if (id !== undefined) nodes.set(id, node);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  let cycle: string | undefined;
  const visit = (nodeId: string): void => {
    if (cycle !== undefined || visited.has(nodeId)) return;
    if (visiting.has(nodeId)) {
      cycle = nodeId;
      return;
    }
    visiting.add(nodeId);
    for (const dependency of stringArray(at(nodes.get(nodeId), ["depends_on"]))) {
      if (nodes.has(dependency)) visit(dependency);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const nodeId of nodes.keys()) visit(nodeId);
  return cycle === undefined
    ? []
    : [issue("$.nodes", `Planned graph contains a dependency cycle at ${JSON.stringify(cycle)}`)];
}

function plannedOutputPathIssues(document: unknown): SemanticGateIssue[] {
  return plannedNodes(document).flatMap((node, nodeIndex) =>
    projectedUniquenessIssues([
      {
        items: arrayAt(node, ["outputs"]),
        path: `$.nodes[${nodeIndex}].outputs`,
        project: (row) => stringField(row, "path"),
        label: "planned output path"
      }
    ])
  );
}

function plannedPrimaryIssues(document: unknown): SemanticGateIssue[] {
  return plannedNodes(document).flatMap((node, nodeIndex) => {
    const count = arrayAt(node, ["outputs"]).filter((output) => booleanField(output, "primary") === true).length;
    return count === 1
      ? []
      : [
          issue(
            `$.nodes[${nodeIndex}].outputs`,
            `Planned node must identify exactly one primary output; found ${count}`
          )
        ];
  });
}

function plannedModelFanoutIssues(document: unknown): SemanticGateIssue[] {
  return plannedNodes(document).flatMap((node, nodeIndex) =>
    projectedUniquenessIssues([
      {
        items: arrayAt(node, ["model_fanout"]),
        path: `$.nodes[${nodeIndex}].model_fanout`,
        project: (row) => JSON.stringify([row.model_profile_id, row.model_index, row.loop_index, row.attempt_index]),
        label: "model-fanout identity"
      }
    ])
  );
}

function plannedWorkflowTaskIssues(document: unknown): SemanticGateIssue[] {
  const seen = new Set<string>();
  const issues: SemanticGateIssue[] = [];
  for (const [nodeIndex, node] of plannedNodes(document).entries()) {
    for (const [taskIndex, taskId] of stringArray(at(node, ["workflow", "task_node_ids"])).entries()) {
      if (seen.has(taskId)) {
        issues.push(
          issue(
            `$.nodes[${nodeIndex}].workflow.task_node_ids[${taskIndex}]`,
            `Duplicate workflow task ID ${JSON.stringify(taskId)}`
          )
        );
      }
      seen.add(taskId);
    }
  }
  return issues;
}

function plannedWorkflowJoinIssues(document: unknown): SemanticGateIssue[] {
  return plannedNodes(document).flatMap((node, nodeIndex) => {
    const workflow = at(node, ["workflow"]);
    if (!isRecord(workflow)) return [];
    const nodeId = stringField(workflow, "node_id");
    return nodeId !== undefined && !stringArray(workflow.task_node_ids).includes(nodeId)
      ? [issue(`$.nodes[${nodeIndex}].workflow.node_id`, "Workflow node_id must be present in task_node_ids")]
      : [];
  });
}

function plannedArtifactDirIssues(document: unknown): SemanticGateIssue[] {
  return plannedNodes(document).flatMap((node, nodeIndex) => {
    const id = stringField(node, "id");
    const artifactDir = stringField(node, "artifact_dir");
    return id !== undefined && artifactDir !== `artifacts/${id}`
      ? [issue(`$.nodes[${nodeIndex}].artifact_dir`, "artifact_dir must be derived from the planned node ID")]
      : [];
  });
}

function plannedLoopIssues(document: unknown): SemanticGateIssue[] {
  return plannedNodes(document).flatMap((node, nodeIndex) => {
    const loop = at(node, ["loop"]);
    const index = numberField(loop, "index");
    const count = numberField(loop, "count");
    const attempt = numberField(loop, "attempt_index");
    return index !== undefined && count !== undefined && (index >= count || attempt !== index)
      ? [issue(`$.nodes[${nodeIndex}].loop`, "Planned loop coordinates are inconsistent")]
      : [];
  });
}

function plannedContractIdentityIssues(document: unknown): SemanticGateIssue[] {
  const issues: SemanticGateIssue[] = [];
  for (const [nodeIndex, node] of plannedNodes(document).entries()) {
    for (const [outputIndex, output] of arrayAt(node, ["outputs"]).entries()) {
      const contract = stringField(output, "contract");
      if (contract === undefined) continue;
      let definition: ReturnType<typeof artifactContractDefinition>;
      try {
        definition = artifactContractDefinition(contract as Parameters<typeof artifactContractDefinition>[0]);
      } catch {
        continue;
      }
      if (stringField(output, "contract_digest") !== definition.digest) {
        issues.push(
          issue(
            `$.nodes[${nodeIndex}].outputs[${outputIndex}].contract_digest`,
            "Planned output contract digest changed"
          )
        );
      }
      const binding = artifactContractSchemaBinding(contract as Parameters<typeof artifactContractSchemaBinding>[0]);
      const bindingFields = [
        "schema_file",
        "schema_id",
        "schema_sha256",
        "schema_bundle_sha256",
        "validator_build"
      ] as const;
      if (
        (binding === undefined && bindingFields.some((field) => isRecord(output) && output[field] !== undefined)) ||
        (binding !== undefined && bindingFields.some((field) => isRecord(output) && output[field] !== binding[field]))
      ) {
        issues.push(issue(`$.nodes[${nodeIndex}].outputs[${outputIndex}]`, "Planned output schema binding changed"));
      }
    }
  }
  return issues;
}

function plannedModelLoopIssues(document: unknown): SemanticGateIssue[] {
  return plannedNodes(document).flatMap((node, nodeIndex) => {
    const loopIndex = numberField(at(node, ["loop"]), "index");
    return arrayAt(node, ["model_fanout"]).flatMap((model, modelIndex) =>
      numberField(model, "loop_index") === loopIndex
        ? []
        : [issue(`$.nodes[${nodeIndex}].model_fanout[${modelIndex}].loop_index`, "Model is bound to another loop")]
    );
  });
}

function propertySourceProjectedIssues(document: unknown): SemanticGateIssue[] {
  const seen = new Set<string>();
  const issues: SemanticGateIssue[] = [];
  for (const [propertyIndex, property] of arrayAt(document, ["properties"]).entries()) {
    for (const [sourceIndex, source] of arrayAt(property, ["sources"]).entries()) {
      if (!isRecord(source)) continue;
      const key = JSON.stringify([source.source_node_id, source.source_property_id]);
      if (seen.has(key)) {
        issues.push(
          issue(`$.properties[${propertyIndex}].sources[${sourceIndex}]`, `Duplicate projected property source ${key}`)
        );
      }
      seen.add(key);
    }
  }
  return issues;
}

function reportFindingIdIssues(document: unknown): SemanticGateIssue[] {
  const rows = [...arrayAt(document, ["issues"]), ...arrayAt(document, ["non_production_outcomes"])];
  return projectedUniquenessIssues([
    { items: rows, path: "$", project: (row) => stringField(row, "id"), label: "report finding ID" }
  ]);
}

function runStateNodeKeyIssues(document: unknown): SemanticGateIssue[] {
  const nodes = at(document, ["nodes"]);
  if (!isRecord(nodes)) return [];
  return Object.entries(nodes).flatMap(([key, node]) =>
    stringField(node, "node_id") === key
      ? []
      : [issue(`$.nodes.${key}.node_id`, `Run-state node_id must match map key ${JSON.stringify(key)}`)]
  );
}

function smithersTasks(document: unknown): readonly unknown[] {
  return arrayAt(document, ["tasks"]);
}

function smithersWorkflowIdentityIssues(document: unknown): SemanticGateIssue[] {
  return [
    ...uniqueFieldGate([["tasks"]], "smithersNodeId", "Smithers workflow node ID")(document, {}),
    ...uniqueFieldGate([["tasks"]], "verifierSmithersNodeId", "Smithers verifier node ID")(document, {})
  ];
}

function sameUnknownArray(left: unknown, right: unknown): boolean {
  return Array.isArray(left) && Array.isArray(right) && JSON.stringify(left) === JSON.stringify(right);
}

function smithersDocumentIdentityIssues(document: unknown): SemanticGateIssue[] {
  const runId = stringField(document, "run_id");
  const workflowName = stringField(document, "workflow_name");
  const issues: SemanticGateIssue[] = [];
  for (const [index, task] of smithersTasks(document).entries()) {
    if (!isRecord(task)) continue;
    const taskPath = `$.tasks[${index}]`;
    const attemptId = stringField(task, "attemptId");
    if (attemptId !== undefined && stringField(task, "smithersNodeId") !== `node:${attemptId}`) {
      issues.push(issue(`${taskPath}.smithersNodeId`, "Smithers workflow node ID must be derived from attemptId"));
    }
    if (attemptId !== undefined && stringField(task, "verifierSmithersNodeId") !== `verify:${attemptId}`) {
      issues.push(
        issue(`${taskPath}.verifierSmithersNodeId`, "Smithers verifier node ID must be derived from attemptId")
      );
    }
    const metadata = at(task, ["metadata"]);
    if (isRecord(metadata)) {
      const metadataRun = at(metadata, ["run"]);
      if (
        stringField(metadataRun, "ultrafuzzRunId") !== runId ||
        stringField(metadataRun, "smithersWorkflowName") !== workflowName
      ) {
        issues.push(issue(`${taskPath}.metadata.run`, "Smithers task run metadata does not match its document"));
      }
      const metadataNode = at(metadata, ["node"]);
      if (
        stringField(metadataNode, "attemptId") !== attemptId ||
        stringField(metadataNode, "concreteNodeId") !== stringField(task, "concreteNodeId") ||
        stringField(metadataNode, "logicalNodeId") !== stringField(task, "logicalNodeId")
      ) {
        issues.push(issue(`${taskPath}.metadata.node`, "Smithers task node metadata does not match its envelope"));
      }
      const metadataModel = at(metadata, ["model"]);
      if (
        stringField(metadataModel, "agentRef") !== stringField(task, "agentRef") ||
        (isRecord(metadataModel) ? metadataModel.modelName : undefined) !== task.modelName ||
        (isRecord(metadataModel) ? metadataModel.reasoningEffort : undefined) !== task.reasoningEffort
      ) {
        issues.push(issue(`${taskPath}.metadata.model`, "Smithers task model metadata does not match its envelope"));
      }
      if (!sameUnknownArray(task.dependencies, at(metadata, ["dependencies", "attemptIds"]))) {
        issues.push(
          issue(`${taskPath}.metadata.dependencies.attemptIds`, "Dependency attempt metadata does not match")
        );
      }
      if (!sameUnknownArray(task.dependencySmithersNodeIds, at(metadata, ["dependencies", "smithersNodeIds"]))) {
        issues.push(
          issue(`${taskPath}.metadata.dependencies.smithersNodeIds`, "Dependency workflow metadata does not match")
        );
      }
      const timeout = at(metadata, ["timeout"]);
      const retryPolicy = at(metadata, ["retryPolicy"]);
      const timeoutMs = numberField(task, "timeoutMs");
      const retries = numberField(task, "retries");
      if (
        numberField(timeout, "milliseconds") !== timeoutMs ||
        numberField(timeout, "heartbeatTimeoutMs") !== numberField(task, "heartbeatTimeoutMs") ||
        numberField(retryPolicy, "smithersRetries") !== retries ||
        (retries !== undefined && numberField(retryPolicy, "maxAttempts") !== retries + 1) ||
        (timeoutMs !== undefined && numberField(timeout, "seconds") !== Math.ceil(timeoutMs / 1_000))
      ) {
        issues.push(issue(`${taskPath}.metadata.timeout`, "Smithers timeout or retry metadata does not match"));
      }
      const execution = at(task, ["execution"]);
      const metadataExecution = at(metadata, ["execution"]);
      if (
        stringField(execution, "mode") !== stringField(metadataExecution, "mode") ||
        (isRecord(execution) ? execution.provider : undefined) !==
          (isRecord(metadataExecution) ? metadataExecution.provider : undefined) ||
        JSON.stringify(at(execution, ["resources"])) !== JSON.stringify(at(metadataExecution, ["resources"])) ||
        stringField(at(metadata, ["artifacts"]), "dir") !== stringField(task, "artifactDir")
      ) {
        issues.push(issue(`${taskPath}.metadata.execution`, "Smithers execution or artifact metadata does not match"));
      }
    }
  }
  return issues;
}

function smithersDependencyJoinIssues(document: unknown): SemanticGateIssue[] {
  const tasks = smithersTasks(document);
  const byAttempt = new Map(
    tasks.flatMap((task) => {
      const id = stringField(task, "attemptId");
      return id === undefined ? [] : [[id, task] as const];
    })
  );
  const byVerifier = new Map(
    tasks.flatMap((task) => {
      const id = stringField(task, "verifierSmithersNodeId");
      return id === undefined ? [] : [[id, task] as const];
    })
  );
  const issues: SemanticGateIssue[] = [];
  for (const [taskIndex, task] of tasks.entries()) {
    const attemptId = stringField(task, "attemptId");
    const dependencies = stringArray(at(task, ["dependencies"]));
    const joined = new Set<string>();
    for (const [dependencyIndex, verifierId] of stringArray(at(task, ["dependencySmithersNodeIds"])).entries()) {
      const dependency = byVerifier.get(verifierId);
      const dependencyAttempt = stringField(dependency, "attemptId");
      if (dependency === undefined) {
        issues.push(
          issue(
            `$.tasks[${taskIndex}].dependencySmithersNodeIds[${dependencyIndex}]`,
            `Unknown verifier dependency ${JSON.stringify(verifierId)}`
          )
        );
      } else if (dependencyAttempt !== undefined && !dependencies.includes(dependencyAttempt)) {
        issues.push(
          issue(
            `$.tasks[${taskIndex}].dependencySmithersNodeIds[${dependencyIndex}]`,
            "Verifier dependency is absent from dependency attempts"
          )
        );
      } else if (dependencyAttempt !== undefined) {
        joined.add(dependencyAttempt);
      }
    }
    for (const [dependencyIndex, dependencyId] of dependencies.entries()) {
      if (dependencyId === attemptId) {
        issues.push(
          issue(`$.tasks[${taskIndex}].dependencies[${dependencyIndex}]`, "A Smithers task cannot depend on itself")
        );
      } else if (byAttempt.has(dependencyId) && !joined.has(dependencyId)) {
        issues.push(
          issue(
            `$.tasks[${taskIndex}].dependencies[${dependencyIndex}]`,
            "Task dependency is missing its verifier workflow dependency"
          )
        );
      }
    }
  }
  return issues;
}

function smithersDependencyAcyclicityIssues(document: unknown): SemanticGateIssue[] {
  const byVerifier = new Map(
    smithersTasks(document).flatMap((task) => {
      const id = stringField(task, "verifierSmithersNodeId");
      return id === undefined ? [] : [[id, task] as const];
    })
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  let cycle: string | undefined;
  const visit = (task: unknown): void => {
    const id = stringField(task, "attemptId");
    if (id === undefined || cycle !== undefined || visited.has(id)) return;
    if (visiting.has(id)) {
      cycle = id;
      return;
    }
    visiting.add(id);
    for (const verifier of stringArray(at(task, ["dependencySmithersNodeIds"]))) {
      const dependency = byVerifier.get(verifier);
      if (dependency !== undefined) visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of smithersTasks(document)) visit(task);
  return cycle === undefined
    ? []
    : [issue("$.tasks", `Smithers task dependencies contain a cycle at ${JSON.stringify(cycle)}`)];
}

function smithersPlannedAttemptIds(node: unknown): string[] {
  const id = stringField(node, "id");
  if (id === undefined) return [];
  const models = arrayAt(node, ["model_fanout"]);
  if (models.length <= 1) return [id];
  return models.flatMap((model) => {
    const modelIndex = numberField(model, "model_index");
    const attemptIndex = numberField(model, "attempt_index");
    return modelIndex === undefined || attemptIndex === undefined
      ? []
      : [`${id}__model_${modelIndex}__attempt_${attemptIndex}`];
  });
}

function smithersGraphNodes(context: SemanticGateContext): readonly unknown[] {
  return arrayAt(context.plannedGraph!.document, ["nodes"]);
}

function smithersPlannedCoverageIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const tasks = smithersTasks(document);
  const issues: SemanticGateIssue[] = [];
  for (const [nodeIndex, node] of smithersGraphNodes(context).entries()) {
    const id = stringField(node, "id");
    const matching = tasks.filter((task) => stringField(task, "concreteNodeId") === id);
    if (stringField(node, "kind") === "reference") {
      if (matching.length > 0)
        issues.push(issue(`$.nodes[${nodeIndex}]`, "Reference planned nodes cannot have Smithers tasks"));
      continue;
    }
    const expected = smithersPlannedAttemptIds(node);
    const actual = matching.flatMap((task) => stringField(task, "attemptId") ?? "").filter((idValue) => idValue !== "");
    if (!sameStringSet(actual, expected)) {
      issues.push(issue(`$.nodes[${nodeIndex}]`, `Smithers tasks do not cover planned node ${JSON.stringify(id)}`));
    }
  }
  return issues;
}

function smithersPlannedIdentityIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const nodes = new Map(
    smithersGraphNodes(context).flatMap((node) => {
      const id = stringField(node, "id");
      return id === undefined ? [] : [[id, node] as const];
    })
  );
  const issues: SemanticGateIssue[] = [];
  for (const [taskIndex, task] of smithersTasks(document).entries()) {
    const node = nodes.get(stringField(task, "concreteNodeId") ?? "");
    if (node === undefined || stringField(node, "kind") !== "agentic") {
      issues.push(
        issue(`$.tasks[${taskIndex}].concreteNodeId`, "Smithers task does not join to an agentic planned node")
      );
      continue;
    }
    const metadata = at(task, ["metadata"]);
    const plannedLoop = at(node, ["loop"]);
    const metadataLoop = at(metadata, ["loop"]);
    if (
      stringField(task, "logicalNodeId") !== stringField(node, "logical_id") ||
      stringField(at(metadata, ["node"]), "logicalNodeId") !== stringField(node, "logical_id") ||
      stringField(at(metadata, ["node"]), "label") !== stringField(node, "display_name") ||
      numberField(metadataLoop, "index") !== numberField(plannedLoop, "index") ||
      numberField(metadataLoop, "count") !== numberField(plannedLoop, "count") ||
      stringField(metadataLoop, "mode") !== stringField(plannedLoop, "mode") ||
      numberField(metadataLoop, "attemptIndex") !== numberField(plannedLoop, "attempt_index")
    ) {
      issues.push(issue(`$.tasks[${taskIndex}].metadata`, "Smithers task identity does not match its planned node"));
    }
    const outputFields = [
      ["path", "path"],
      ["contract", "contract"],
      ["contractDigest", "contract_digest"],
      ["schemaFile", "schema_file"],
      ["schemaId", "schema_id"],
      ["schemaSha256", "schema_sha256"],
      ["schemaBundleSha256", "schema_bundle_sha256"],
      ["validatorBuild", "validator_build"],
      ["primary", "primary"]
    ] as const;
    const actualOutputs = arrayAt(metadata, ["artifacts", "outputs"]);
    const plannedOutputs = arrayAt(node, ["outputs"]);
    if (
      actualOutputs.length !== plannedOutputs.length ||
      plannedOutputs.some((output, outputIndex) =>
        outputFields.some(
          ([actualField, plannedField]) =>
            !isRecord(actualOutputs[outputIndex]) ||
            !isRecord(output) ||
            actualOutputs[outputIndex]![actualField] !== output[plannedField]
        )
      )
    ) {
      issues.push(
        issue(
          `$.tasks[${taskIndex}].metadata.artifacts.outputs`,
          "Smithers output contracts differ from the planned node"
        )
      );
    }
  }
  return issues;
}

function smithersPlannedDependencyJoinIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const nodes = new Map(
    smithersGraphNodes(context).flatMap((node) => {
      const id = stringField(node, "id");
      return id === undefined ? [] : [[id, node] as const];
    })
  );
  const issues: SemanticGateIssue[] = [];
  for (const [taskIndex, task] of smithersTasks(document).entries()) {
    const node = nodes.get(stringField(task, "concreteNodeId") ?? "");
    if (node === undefined) continue;
    const dependencyNodes = stringArray(at(node, ["depends_on"])).flatMap((id) => {
      const dependency = nodes.get(id);
      return dependency === undefined ? [] : [dependency];
    });
    const expectedAttempts = dependencyNodes.flatMap(smithersPlannedAttemptIds);
    const actualAttempts = stringArray(at(task, ["dependencies"])).filter((id) => id !== "meta-start");
    if (!sameStringSet(actualAttempts, expectedAttempts)) {
      issues.push(
        issue(`$.tasks[${taskIndex}].dependencies`, "Smithers dependency attempts do not match planned dependencies")
      );
    }
    const expectedNodes = stringArray(at(node, ["depends_on"]));
    const actualNodes = stringArray(at(task, ["metadata", "dependencies", "concreteNodeIds"])).filter(
      (id) => id !== "__start__"
    );
    if (!sameStringSet(actualNodes, expectedNodes)) {
      issues.push(
        issue(
          `$.tasks[${taskIndex}].metadata.dependencies.concreteNodeIds`,
          "Smithers concrete dependencies do not match the plan"
        )
      );
    }
    const expectedVerifiers = dependencyNodes
      .filter((dependency) => stringField(dependency, "kind") === "agentic")
      .flatMap(smithersPlannedAttemptIds)
      .map((id) => `verify:${id}`);
    if (!sameStringSet(stringArray(at(task, ["dependencySmithersNodeIds"])), expectedVerifiers)) {
      issues.push(
        issue(`$.tasks[${taskIndex}].dependencySmithersNodeIds`, "Smithers workflow dependencies do not match the plan")
      );
    }
  }
  return issues;
}

function workspacePatchPathIssues(document: unknown): SemanticGateIssue[] {
  const included = arrayAt(document, ["files"]);
  const excluded = arrayAt(document, ["excluded_files"]);
  return projectedUniquenessIssues([
    { items: included, path: "$.files", project: (row) => stringField(row, "path"), label: "workspace patch path" },
    {
      items: excluded,
      path: "$.excluded_files",
      project: (row) => stringField(row, "path"),
      label: "excluded workspace patch path"
    },
    {
      items: [...included, ...excluded],
      path: "$",
      project: (row) => stringField(row, "path"),
      label: "included/excluded workspace patch path"
    }
  ]);
}

function resolveArtifactFile(rootDirectory: string, relativePath: string): string | undefined {
  const root = path.resolve(rootDirectory);
  const candidate = path.resolve(root, relativePath);
  return candidate !== root && candidate.startsWith(`${root}${path.sep}`) ? candidate : undefined;
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function filesystemManifestIssues(
  document: unknown,
  context: SemanticGateContext,
  rowsPath: readonly string[]
): SemanticGateIssue[] {
  const root = context.filesystem!.rootDirectory;
  const issues: SemanticGateIssue[] = [];
  for (const [index, row] of arrayAt(document, rowsPath).entries()) {
    const relativePath = stringField(row, "path");
    const expectedDigest = stringField(row, "sha256");
    if (relativePath === undefined) continue;
    const filePath = resolveArtifactFile(root, relativePath);
    let stats: fs.Stats | undefined;
    try {
      if (filePath !== undefined) stats = fs.lstatSync(filePath);
    } catch {
      // Reported below as a missing/nonregular file.
    }
    const rowPath = `${displayPath(rowsPath)}[${index}]`;
    if (filePath === undefined || stats === undefined || !stats.isFile() || stats.isSymbolicLink()) {
      issues.push(
        issue(`${rowPath}.path`, `Referenced file is missing or nonregular: ${JSON.stringify(relativePath)}`)
      );
      continue;
    }
    if (expectedDigest !== undefined && sha256File(filePath) !== expectedDigest) {
      issues.push(issue(`${rowPath}.sha256`, `Referenced file digest does not match ${JSON.stringify(relativePath)}`));
    }
    const expectedSize = numberField(row, "size_bytes");
    if (expectedSize !== undefined && expectedSize !== stats.size) {
      issues.push(
        issue(`${rowPath}.size_bytes`, `Referenced file size does not match ${JSON.stringify(relativePath)}`)
      );
    }
  }
  return issues;
}

function generatedTestExistenceIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const root = context.filesystem!.rootDirectory;
  return arrayAt(document, ["generated_tests"]).flatMap((row, index) => {
    const relativePath = stringField(row, "path");
    if (relativePath === undefined) return [];
    const filePath = resolveArtifactFile(root, relativePath);
    try {
      if (filePath !== undefined) {
        const stats = fs.lstatSync(filePath);
        if (stats.isFile() && !stats.isSymbolicLink()) return [];
      }
    } catch {
      // Reported below.
    }
    return [
      issue(`$.generated_tests[${index}].path`, `Generated test does not exist: ${JSON.stringify(relativePath)}`)
    ];
  });
}

function agentSourceProofGitIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const git = context.git!;
  const issues: SemanticGateIssue[] = [];
  if (stringField(document, "commit") !== git.commit)
    issues.push(issue("$.commit", "Source proof commit does not match Git"));
  if (stringField(document, "tree") !== git.tree) issues.push(issue("$.tree", "Source proof tree does not match Git"));
  for (const [index, ref] of arrayAt(document, ["refs"]).entries()) {
    const name = stringField(ref, "name");
    const object = stringField(ref, "object");
    if (name !== undefined && git.refs?.[name] !== object) {
      issues.push(issue(`$.refs[${index}].object`, `Source proof ref ${JSON.stringify(name)} does not match Git`));
    }
  }
  return issues;
}

function invariantSourceProofGitIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const git = context.git!;
  const issues: SemanticGateIssue[] = [];
  if (stringField(document, "commit") !== git.commit)
    issues.push(issue("$.commit", "Invariant proof commit does not match Git"));
  if (stringField(document, "tree") !== git.tree)
    issues.push(issue("$.tree", "Invariant proof tree does not match Git"));
  for (const [index, file] of arrayAt(document, ["files"]).entries()) {
    const content = stringField(file, "content");
    const digest = stringField(file, "sha256");
    if (content !== undefined && digest !== crypto.createHash("sha256").update(content, "utf8").digest("hex")) {
      issues.push(issue(`$.files[${index}].sha256`, "Invariant proof content digest does not match its snapshot"));
    }
  }
  return issues;
}

function workspacePatchGitIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const git = context.git!;
  const comparisons: Array<[string, unknown, unknown]> = [
    ["base_commit", isRecord(document) ? document.base_commit : undefined, git.baseCommit],
    ["base_tree", isRecord(document) ? document.base_tree : undefined, git.baseTree],
    ["result_tree", isRecord(document) ? document.result_tree : undefined, git.resultTree],
    ["patch_sha256", isRecord(document) ? document.patch_sha256 : undefined, git.patchSha256]
  ];
  return comparisons.flatMap(([field, actual, expected]) =>
    actual === expected ? [] : [issue(`$.${field}`, `${field} does not match the captured Git patch`)]
  );
}

function artifactVerificationPlanIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const planned = context.plannedGraph!.node;
  const issues: SemanticGateIssue[] = [];
  if (stringField(document, "node_id") !== stringField(planned, "id")) {
    issues.push(issue("$.node_id", "Verification marker node_id does not match the planned node"));
  }
  const actual = arrayAt(document, ["artifacts"]);
  const expected = arrayAt(planned, ["outputs"]);
  if (actual.length !== expected.length) {
    issues.push(issue("$.artifacts", "Verification marker artifact count does not match planned outputs"));
    return issues;
  }
  for (const [index, output] of expected.entries()) {
    const artifact = actual[index];
    for (const field of [
      "path",
      "contract",
      "contract_digest",
      "schema_file",
      "schema_id",
      "schema_sha256",
      "schema_bundle_sha256",
      "validator_build",
      "primary"
    ] as const) {
      if (isRecord(artifact) && isRecord(output) && artifact[field] === output[field]) continue;
      issues.push(issue(`$.artifacts[${index}].${field}`, `Verification marker ${field} does not match the plan`));
    }
  }
  return issues;
}

function campaignSummaryCountIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const campaigns = context.artifactSet!.campaigns!;
  const findings = context.artifactSet!.findings!;
  const expected = {
    pre_deduplication: campaigns.reduce<number>((total, campaign) => total + arrayAt(campaign, ["failures"]).length, 0),
    post_deduplication: findings.length
  };
  const counts = at(document, ["failure_counts"]);
  return Object.entries(expected).flatMap(([field, count]) =>
    numberField(counts, field) === count
      ? []
      : [issue(`$.failure_counts.${field}`, `${field} must equal its sibling artifact population (${count})`)]
  );
}

function implementedSelectionJoinIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const selectedIds = stringArray(at(document, ["selection", "property_ids"]));
  const recordIds = arrayAt(document, ["properties"]).flatMap((row) => stringField(row, "property_id") ?? "");
  const catalog = context.artifactSet!.propertyCatalog;
  const catalogIds = new Set(arrayAt(catalog, ["properties"]).flatMap((row) => stringField(row, "id") ?? ""));
  const issues: SemanticGateIssue[] = [];
  if (
    !sameStringSet(
      selectedIds,
      recordIds.filter((id) => id !== "")
    )
  ) {
    issues.push(issue("$.selection.property_ids", "Implementation selection must equal the implementation record IDs"));
  }
  for (const [index, id] of selectedIds.entries()) {
    if (!catalogIds.has(id)) {
      issues.push(
        issue(
          `$.selection.property_ids[${index}]`,
          `Selection references unknown canonical property ${JSON.stringify(id)}`
        )
      );
    }
  }
  return issues;
}

function propertySourceJoinIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const known = new Set<string>();
  for (const lens of context.artifactSet!.propertyLenses!) {
    for (const row of arrayAt(lens.document, ["properties"])) {
      const id = stringField(row, "id");
      if (id !== undefined) known.add(JSON.stringify([lens.sourceNodeId, id]));
    }
  }
  const issues: SemanticGateIssue[] = [];
  for (const [propertyIndex, property] of arrayAt(document, ["properties"]).entries()) {
    for (const [sourceIndex, source] of arrayAt(property, ["sources"]).entries()) {
      if (!isRecord(source)) continue;
      const key = JSON.stringify([source.source_node_id, source.source_property_id]);
      if (!known.has(key)) {
        issues.push(issue(`$.properties[${propertyIndex}].sources[${sourceIndex}]`, `Unknown property source ${key}`));
      }
    }
  }
  return issues;
}

function reportPropertyJoinIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const catalog = context.artifactSet!.propertyCatalog;
  const implementation = context.artifactSet!.implementedProperties;
  const catalogById = new Map(
    arrayAt(catalog, ["properties"]).flatMap((row) => {
      const id = stringField(row, "id");
      return id === undefined ? [] : [[id, row] as const];
    })
  );
  const implementationById = new Map(
    arrayAt(implementation, ["properties"]).flatMap((row) => {
      const id = stringField(row, "property_id");
      return id === undefined ? [] : [[id, row] as const];
    })
  );
  const findingIds = new Set(
    [...arrayAt(document, ["issues"]), ...arrayAt(document, ["non_production_outcomes"])]
      .flatMap((row) => stringField(row, "id") ?? "")
      .filter((id) => id !== "")
  );
  const issues: SemanticGateIssue[] = [];
  for (const [entryIndex, entry] of arrayAt(document, ["property_provenance"]).entries()) {
    const findingId = stringField(entry, "finding_id");
    if (findingId !== undefined && !findingIds.has(findingId)) {
      issues.push(
        issue(`$.property_provenance[${entryIndex}].finding_id`, `Unknown report finding ${JSON.stringify(findingId)}`)
      );
    }
    const propertyIds = stringArray(at(entry, ["property_ids"]));
    for (const [propertyIndex, propertyId] of propertyIds.entries()) {
      if (!catalogById.has(propertyId)) {
        issues.push(
          issue(
            `$.property_provenance[${entryIndex}].property_ids[${propertyIndex}]`,
            `Unknown canonical property ${JSON.stringify(propertyId)}`
          )
        );
      }
      if (!implementationById.has(propertyId)) {
        issues.push(
          issue(
            `$.property_provenance[${entryIndex}].property_ids[${propertyIndex}]`,
            `Missing implementation record for ${JSON.stringify(propertyId)}`
          )
        );
      }
    }
    const expectedSources = propertyIds.flatMap((id) =>
      arrayAt(catalogById.get(id), ["sources"]).flatMap((source) =>
        isRecord(source) ? [JSON.stringify([source.source_node_id, source.source_property_id])] : []
      )
    );
    const actualSources = arrayAt(entry, ["sources"]).flatMap((source) =>
      isRecord(source) ? [JSON.stringify([source.source_node_id, source.source_property_id])] : []
    );
    if (!sameStringSet(expectedSources, actualSources)) {
      issues.push(
        issue(`$.property_provenance[${entryIndex}].sources`, "Report property sources do not match the catalog")
      );
    }
    const expectedImplementationPaths = propertyIds.flatMap((id) =>
      stringArray(at(implementationById.get(id), ["implementation_paths"]))
    );
    const expectedTestPaths = propertyIds.flatMap((id) => stringArray(at(implementationById.get(id), ["test_paths"])));
    if (!sameStringSet(expectedImplementationPaths, stringArray(at(entry, ["implementation_paths"])))) {
      issues.push(
        issue(
          `$.property_provenance[${entryIndex}].implementation_paths`,
          "Report implementation paths do not match implementation records"
        )
      );
    }
    if (!sameStringSet(expectedTestPaths, stringArray(at(entry, ["test_paths"])))) {
      issues.push(
        issue(
          `$.property_provenance[${entryIndex}].test_paths`,
          "Report test paths do not match implementation records"
        )
      );
    }
  }
  return issues;
}

function attemptReuseSourceLinkIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const reuse = at(document, ["reuse"]);
  if (stringField(reuse, "status") !== "reused") return [];
  const source = at(reuse, ["source"]);
  const sourceWorkflowRunId = stringField(source, "workflow_run_id");
  const sourceSequence = numberField(source, "source_event_sequence");
  if (sourceWorkflowRunId === undefined || sourceSequence === undefined) return [];

  const currentWorkflowRunId = stringField(document, "workflow_run_id");
  const currentSequence = numberField(document, "source_event_sequence");
  if (sourceWorkflowRunId === currentWorkflowRunId && sourceSequence === currentSequence) {
    return [issue("$.reuse.source", "An attempt cannot reuse its own Smithers source identity")];
  }

  const entries = context.attemptLedger!.entries;
  const currentIndex = entries.indexOf(document);
  const candidates = [
    ...entries.slice(0, currentIndex < 0 ? entries.length : currentIndex),
    ...(context.attemptLedger?.sourceEntries ?? [])
  ];
  const found = candidates.some(
    (entry) =>
      stringField(entry, "workflow_run_id") === sourceWorkflowRunId &&
      numberField(entry, "source_event_sequence") === sourceSequence
  );
  return found ? [] : [issue("$.reuse.source", "Reuse source must identify trusted, different attempt evidence")];
}

function sourceEventKey(workflowRunId: string, sequence: number): string {
  return JSON.stringify([workflowRunId, sequence]);
}

function sourceEventsByIdentity(context: SemanticGateContext): Map<string, SemanticEventLogContext["events"][number]> {
  return new Map(
    context.eventLog!.events.map((event) => [sourceEventKey(event.workflow_run_id, event.source_event_sequence), event])
  );
}

function attemptSourceEventJoinIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const workflowRunId = stringField(document, "workflow_run_id");
  const startedSequence = numberField(document, "started_event_sequence");
  const terminalSequence = numberField(document, "source_event_sequence");
  if (workflowRunId === undefined || startedSequence === undefined || terminalSequence === undefined) return [];
  const events = sourceEventsByIdentity(context);
  const started = events.get(sourceEventKey(workflowRunId, startedSequence));
  const terminal = events.get(sourceEventKey(workflowRunId, terminalSequence));
  const issues: SemanticGateIssue[] = [];
  if (started?.type !== "NodeStarted") {
    issues.push(issue("$.started_event_sequence", "Attempt start does not join an exact NodeStarted source event"));
  }
  const outcome = stringField(document, "outcome");
  const failureCategory = stringField(document, "failure_category");
  const expectedTerminal = outcome === "succeeded" || outcome === "reused" ? "NodeFinished" : "NodeFailed";
  const hostValidationDisposition =
    outcome === "failed" &&
    (failureCategory === "artifact-validation" || failureCategory === "invalid-output") &&
    terminal?.type === "NodeFinished";
  if (terminal?.type !== expectedTerminal && !hostValidationDisposition) {
    issues.push(
      issue("$.source_event_sequence", `Attempt terminal does not join an exact ${expectedTerminal} source event`)
    );
  }
  const nodeId = stringField(document, "node_id");
  const iteration = numberField(document, "iteration");
  const attempt = numberField(document, "attempt");
  for (const [name, event, recordPath] of [
    ["start", started, "$.started_event_sequence"],
    ["terminal", terminal, "$.source_event_sequence"]
  ] as const) {
    if (!isRecord(event?.payload)) continue;
    if (
      stringField(event.payload, "nodeId") !== nodeId ||
      numberField(event.payload, "iteration") !== iteration ||
      numberField(event.payload, "attempt") !== attempt
    ) {
      issues.push(issue(recordPath, `Attempt ${name} event identity does not match node_id, iteration, and attempt`));
    }
  }
  const lifecycle = at(document, ["lifecycle"]);
  if (started !== undefined && stringField(lifecycle, "started_at") !== new Date(started.timestamp_ms).toISOString()) {
    issues.push(issue("$.lifecycle.started_at", "Attempt start timestamp does not match its source event"));
  }
  if (
    terminal !== undefined &&
    stringField(lifecycle, "finished_at") !== new Date(terminal.timestamp_ms).toISOString()
  ) {
    issues.push(issue("$.lifecycle.finished_at", "Attempt finish timestamp does not match its source event"));
  }
  return issues;
}

function runStateFingerprintIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const expected = context.runtimeState!;
  const issues: SemanticGateIssue[] = [];
  if (stringField(document, "graph_fingerprint") !== expected.graphFingerprint) {
    issues.push(issue("$.graph_fingerprint", "Run-state graph fingerprint does not match runtime state"));
  }
  if (stringField(document, "config_fingerprint") !== expected.configFingerprint) {
    issues.push(issue("$.config_fingerprint", "Run-state config fingerprint does not match runtime state"));
  }
  return issues;
}

function usageEventOrderIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const entries = [...context.usageLedger!.entries];
  if (!entries.includes(document)) entries.push(document);
  const issues: SemanticGateIssue[] = [];
  const identities = new Set<string>();
  const lastByWorkflow = new Map<string, { sequence: number; controlGeneration: string }>();
  for (const [index, entry] of entries.entries()) {
    const workflowRunId = stringField(entry, "workflow_run_id");
    const sequence = numberField(entry, "source_event_sequence");
    const controlGeneration = stringField(entry, "control_generation");
    if (workflowRunId === undefined || sequence === undefined || controlGeneration === undefined) continue;
    const identity = sourceEventKey(workflowRunId, sequence);
    if (identities.has(identity)) {
      issues.push(issue(`$[${index}].source_event_sequence`, "Usage ledger repeats a Smithers source identity"));
    }
    identities.add(identity);
    const prior = lastByWorkflow.get(workflowRunId);
    if (prior !== undefined && sequence <= prior.sequence) {
      issues.push(
        issue(`$[${index}].source_event_sequence`, "Usage source sequences must be strictly increasing per workflow")
      );
    }
    if (prior !== undefined && controlGeneration !== prior.controlGeneration) {
      issues.push(
        issue(`$[${index}].control_generation`, "A workflow run cannot change its sealed control generation")
      );
    }
    lastByWorkflow.set(workflowRunId, { sequence, controlGeneration });
  }
  return issues;
}

function usageSourceEventJoinIssues(document: unknown, context: SemanticGateContext): SemanticGateIssue[] {
  const workflowRunId = stringField(document, "workflow_run_id");
  const sourceSequence = numberField(document, "source_event_sequence");
  if (workflowRunId === undefined || sourceSequence === undefined) return [];
  const source = sourceEventsByIdentity(context).get(sourceEventKey(workflowRunId, sourceSequence));
  if (source?.type !== "TokenUsageReported" || !isRecord(source.payload)) {
    return [issue("$.source_event_sequence", "Usage entry does not join an exact TokenUsageReported source event")];
  }
  const usage = at(document, ["usage"]);
  const expectedUsage = {
    model: source.payload.model,
    agent: source.payload.agent,
    input_tokens: source.payload.inputTokens,
    output_tokens: source.payload.outputTokens,
    ...(source.payload.cacheReadTokens === undefined ? {} : { cache_read_tokens: source.payload.cacheReadTokens }),
    ...(source.payload.cacheWriteTokens === undefined ? {} : { cache_write_tokens: source.payload.cacheWriteTokens }),
    ...(source.payload.reasoningTokens === undefined ? {} : { reasoning_tokens: source.payload.reasoningTokens })
  };
  const issues: SemanticGateIssue[] = [];
  if (
    stringField(document, "node_id") !== stringField(source.payload, "nodeId") ||
    numberField(document, "iteration") !== numberField(source.payload, "iteration") ||
    numberField(document, "attempt") !== numberField(source.payload, "attempt")
  ) {
    issues.push(issue("$", "Usage attempt coordinates do not match the source event"));
  }
  if (numberField(document, "observed_timestamp_ms") !== source.timestamp_ms) {
    issues.push(issue("$.observed_timestamp_ms", "Usage observation timestamp does not match the source event"));
  }
  if (!isDeepStrictEqual(usage, expectedUsage)) {
    issues.push(issue("$.usage", "Canonical usage does not exactly project the source event payload"));
  }
  return issues;
}

const gateSpecifications = {
  "admin-config-surface-id-uniqueness": documentGate(uniqueFieldGate([["surfaces"]], "surface_id", "admin surface ID")),
  "admin-config-surface-joins": documentGate(adminConfigJoinIssues),
  "agent-source-proof-commit-binding": contextualGate(
    "git",
    ["git.commit", "git.tree", "git.refs"],
    agentSourceProofGitIssues
  ),
  "agent-source-proof-ref-uniqueness": documentGate(uniqueFieldGate([["refs"]], "name", "source proof ref name")),
  "aggregation-count-coupling": documentGate(aggregationCountIssues),
  "aggregation-destination-path-uniqueness": documentGate(aggregationDestinationIssues),
  "analysis-bundle-file-digest": contextualGate("filesystem", ["filesystem.rootDirectory"], (document, context) =>
    filesystemManifestIssues(document, context, ["files"])
  ),
  "analysis-bundle-path-order": documentGate(analysisBundlePathIssues),
  "artifact-manifest-file-digest": contextualGate("filesystem", ["filesystem.rootDirectory"], (document, context) =>
    filesystemManifestIssues(document, context, ["files"])
  ),
  "artifact-manifest-file-path-uniqueness": documentGate(uniqueFieldGate([["files"]], "path", "artifact file path")),
  "artifact-manifest-output-path-uniqueness": documentGate(
    uniqueFieldGate([["output_contracts"]], "path", "artifact output path")
  ),
  "artifact-manifest-prerequisite-node-uniqueness": documentGate(
    uniqueFieldGate([["prerequisite_manifests"]], "node_id", "prerequisite node ID")
  ),
  "artifact-verification-artifact-path-uniqueness": documentGate(
    uniqueFieldGate([["artifacts"]], "path", "verified artifact path")
  ),
  "artifact-verification-exactly-one-primary": documentGate((document) =>
    exactlyOnePrimaryIssues(document, "artifacts")
  ),
  "artifact-verification-plan-contract-identity": contextualGate(
    "cross-artifact",
    ["plannedGraph.node"],
    artifactVerificationPlanIssues
  ),
  "artifact-verification-publication-digest-correspondence": documentGate(artifactVerificationDigestIssues),
  "artifact-verification-publication-path-uniqueness": documentGate(
    uniqueFieldGate([["publications"]], "path", "publication path")
  ),
  "attempt-order": documentGate(attemptOrderIssues),
  "attempt-failure-message-byte-length": documentGate(attemptFailureMessageByteLengthIssues),
  "attempt-outcome-digest-coupling": documentGate(attemptOutcomeDigestIssues),
  "attempt-reuse-source-link": contextualGate("runtime-state", ["attemptLedger.entries"], attemptReuseSourceLinkIssues),
  "attempt-source-event-join": contextualGate("runtime-state", ["eventLog.events"], attemptSourceEventJoinIssues),
  "audited-differential-lane-id-uniqueness": documentGate(
    uniqueFieldGate([["ready_lanes"], ["rejected_or_narrowed_lanes"]], "lane_id", "audited lane ID")
  ),
  "boundary-recipe-id-uniqueness": documentGate(
    uniqueFieldGate([["recipes"], ["deferred_or_spec_gated"]], "id", "boundary recipe ID", { global: true })
  ),
  "campaign-summary-backend-uniqueness": documentGate(
    uniqueFieldGate([["backend_results"]], "fuzzer_backend", "campaign backend")
  ),
  "campaign-summary-count-coupling": contextualGate(
    "cross-artifact",
    ["artifactSet.campaigns", "artifactSet.findings"],
    campaignSummaryCountIssues
  ),
  "config-redactions-path-key-equality": documentGate((document) =>
    arrayAt(document, ["entries"]).flatMap((entry, index) => {
      const pathValue = at(entry, ["path"]);
      const projected = Array.isArray(pathValue) ? pathValue.join(".") : undefined;
      const key = stringField(entry, "key");
      return projected !== undefined && key !== projected
        ? [issue(`$.entries[${index}].key`, "Configuration redaction key does not equal its projected path")]
        : [];
    })
  ),
  "config-redactions-path-uniqueness": documentGate((document) => {
    const seen = new Set<string>();
    return arrayAt(document, ["entries"]).flatMap((entry, index) => {
      const pathValue = at(entry, ["path"]);
      if (!Array.isArray(pathValue)) return [];
      const projected = JSON.stringify(pathValue);
      const duplicate = seen.has(projected);
      seen.add(projected);
      return duplicate ? [issue(`$.entries[${index}].path`, "Duplicate configuration redaction path")] : [];
    });
  }),
  "dependency-id-uniqueness": documentGate(uniqueFieldGate([["dependencies"]], "dependency_id", "dependency ID")),
  "dependency-row-joins": documentGate(dependencyJoinIssues),
  "differential-gap-lane-uniqueness": documentGate(
    uniqueCompositeGate(
      [
        ["ready_lanes"],
        ["lane_results_seen"],
        ["missing_lane_work_orders"],
        ["incomplete_campaign_work_orders"],
        ["green_suite_evidence"]
      ],
      ["lane_id", "attempt_index"],
      "differential gap lane identity"
    )
  ),
  "differential-plan-lane-id-uniqueness": documentGate(
    uniqueFieldGate(
      [["assigned_differential_lanes"], ["deferred_lane_candidates"]],
      "lane_id",
      "differential lane ID",
      {
        global: true
      }
    )
  ),
  "differential-plan-surface-id-uniqueness": documentGate(
    uniqueFieldGate([["candidate_surfaces"], ["out_of_scope_surfaces"]], "surface_id", "differential surface ID", {
      global: true
    })
  ),
  "differential-repair-failure-hash-uniqueness": documentGate(
    uniqueFieldGate(
      [["repairs_attempted"], ["repaired_failures"], ["preserved_production_or_unknown_reds"]],
      "stable_failure_hash",
      "repair failure hash"
    )
  ),
  "differential-report-failure-hash-uniqueness": documentGate(
    uniqueFieldGate(
      [["production_bug_reds"], ["harness_or_reference_repairs"], ["report_rows_ready"]],
      "stable_failure_hash",
      "report failure hash"
    )
  ),
  "differential-result-failure-hash-uniqueness": documentGate(differentialResultIdentityIssues),
  "differential-triage-failure-hash-uniqueness": documentGate(
    uniqueFieldGate([["classifications"]], "stable_failure_hash", "triage failure hash")
  ),
  "dynamic-agent-id-uniqueness": documentGate(uniqueFieldGate([["agents"]], "agent_id", "dynamic agent ID")),
  "dynamic-enumerator-id-uniqueness": documentGate(
    uniqueFieldGate([["enumerators"]], "enumerator_id", "dynamic enumerator ID")
  ),
  "dynamic-model-agent-join": documentGate(dynamicModelJoinIssues),
  "dynamic-recommendation-id-uniqueness": documentGate(dynamicRecommendationUniquenessIssues),
  "dynamic-strategy-selection-count": documentGate(dynamicSelectionCountIssues),
  "externalized-state-id-uniqueness": documentGate((document, context) => [
    ...uniqueFieldGate([["state_components"]], "component_id", "state component ID")(document, context),
    ...uniqueFieldGate([["scenarios"]], "scenario_id", "state scenario ID")(document, context),
    ...uniqueFieldGate([["accounting_oracles"]], "oracle_id", "accounting oracle ID")(document, context)
  ]),
  "externalized-state-scenario-joins": documentGate(externalizedStateJoinIssues),
  "finding-lifecycle-dedupe-key-uniqueness": documentGate(
    uniqueFieldGate([["records"]], "dedupe_key", "finding lifecycle dedupe key")
  ),
  "finding-projected-reference-uniqueness": documentGate(findingProjectedReferenceIssues),
  "findings-id-uniqueness": documentGate(uniqueFieldGate([[]], "id", "finding ID")),
  "generated-test-path-exists": contextualGate(
    "filesystem",
    ["filesystem.rootDirectory"],
    generatedTestExistenceIssues
  ),
  "generated-test-path-uniqueness": documentGate(uniqueFieldGate([["generated_tests"]], "path", "generated test path")),
  "harness-repair-failure-id-uniqueness": documentGate(uniqueFieldGate([[]], "failure_id", "harness failure ID")),
  "implemented-property-id-uniqueness": documentGate(
    uniqueFieldGate([["properties"]], "property_id", "implemented property ID")
  ),
  "implemented-property-selection-join": contextualGate(
    "cross-artifact",
    ["artifactSet.propertyCatalog"],
    implementedSelectionJoinIssues
  ),
  "invariant-ledger-id-joins": documentGate(invariantLedgerJoinIssues),
  "invariant-ledger-projected-id-uniqueness": documentGate(invariantLedgerUniquenessIssues),
  "invariant-source-proof-git-binding": contextualGate(
    "git",
    ["git.commit", "git.tree"],
    invariantSourceProofGitIssues
  ),
  "invariant-source-proof-path-uniqueness": documentGate(
    uniqueFieldGate([["files"]], "path", "invariant source proof path")
  ),
  "invariant-suite-file-path-uniqueness": documentGate(
    uniqueFieldGate([["files"]], "path", "invariant suite file path")
  ),
  "invariant-suite-file-tombstone-disjointness": documentGate((document) => {
    const files = new Set(arrayAt(document, ["files"]).flatMap((row) => stringField(row, "path") ?? ""));
    return stringArray(at(document, ["tombstones"])).flatMap((tombstone, index) =>
      files.has(tombstone)
        ? [
            issue(
              `$.tombstones[${index}]`,
              `Invariant suite path is both present and tombstoned ${JSON.stringify(tombstone)}`
            )
          ]
        : []
    );
  }),
  "invariant-suite-tombstone-uniqueness": documentGate((document) => {
    const tombstones = stringArray(at(document, ["tombstones"]));
    const seen = new Set<string>();
    return tombstones.flatMap((tombstone, index) => {
      const duplicate = seen.has(tombstone);
      seen.add(tombstone);
      return duplicate
        ? [issue(`$.tombstones[${index}]`, `Duplicate invariant suite tombstone ${JSON.stringify(tombstone)}`)]
        : [];
    });
  }),
  "planned-graph-acyclicity": documentGate(plannedAcyclicityIssues),
  "planned-graph-artifact-dir-identity": documentGate(plannedArtifactDirIssues),
  "planned-graph-contract-identity": documentGate(plannedContractIdentityIssues),
  "planned-graph-dependency-join": documentGate(plannedDependencyJoinIssues),
  "planned-graph-exactly-one-primary": documentGate(plannedPrimaryIssues),
  "planned-graph-loop-coupling": documentGate(plannedLoopIssues),
  "planned-graph-model-fanout-uniqueness": documentGate(plannedModelFanoutIssues),
  "planned-graph-model-loop-coupling": documentGate(plannedModelLoopIssues),
  "planned-graph-node-id-uniqueness": documentGate(plannedNodeIdIssues),
  "planned-graph-output-path-uniqueness": documentGate(plannedOutputPathIssues),
  "planned-graph-workflow-node-join": documentGate(plannedWorkflowJoinIssues),
  "planned-graph-workflow-task-uniqueness": documentGate(plannedWorkflowTaskIssues),
  "property-campaign-failure-id-uniqueness": documentGate(
    uniqueFieldGate([["failures"]], "id", "property campaign failure ID")
  ),
  "property-id-uniqueness": documentGate(uniqueFieldGate([["properties"]], "id", "property ID")),
  "property-lens-id-uniqueness": documentGate(uniqueFieldGate([["properties"]], "id", "property lens ID")),
  "property-source-join": contextualGate("cross-artifact", ["artifactSet.propertyLenses"], propertySourceJoinIssues),
  "property-source-projected-uniqueness": documentGate(propertySourceProjectedIssues),
  "reference-expectation-id-uniqueness": documentGate(
    uniqueFieldGate([["expectations"]], "id", "reference expectation ID")
  ),
  "reference-manifest-path-uniqueness": documentGate(
    uniqueFieldGate([["source_files"], ["artifacts"]], "path", "reference manifest path", { global: true })
  ),
  "report-finding-id-uniqueness": documentGate(reportFindingIdIssues),
  "report-property-provenance-join": contextualGate(
    "cross-artifact",
    ["artifactSet.propertyCatalog", "artifactSet.implementedProperties"],
    reportPropertyJoinIssues
  ),
  "run-metadata-accounting-workflow-identity": documentGate((document) => {
    const workflowRunId = stringField(at(document, ["workflow"]), "run_id");
    const accounting = at(document, ["accounting"]);
    if (accounting === undefined) return [];
    const accountingRunId = stringField(accounting, "workflow_run_id");
    const currentRunId = stringField(at(accounting, ["current"]), "workflow_run_id");
    return workflowRunId !== accountingRunId || workflowRunId !== currentRunId
      ? [issue("$.accounting.workflow_run_id", "Accounting identity does not equal the active workflow run")]
      : [];
  }),
  "run-metadata-current-segment-equality": documentGate((document) => {
    const accounting = at(document, ["accounting"]);
    if (accounting === undefined) return [];
    const segments = arrayAt(accounting, ["segments"]);
    return isDeepStrictEqual(at(accounting, ["current"]), segments.at(-1))
      ? []
      : [issue("$.accounting.current", "Current accounting does not equal the final segment")];
  }),
  "run-metadata-workflow-id-equality": documentGate((document) => {
    const workflow = at(document, ["workflow"]);
    const ids = stringArray(at(document, ["workflow_ids"]));
    if (workflow === undefined) {
      return ids.length === 0 ? [] : [issue("$.workflow_ids", "Unlinked metadata carries workflow IDs")];
    }
    const runId = stringField(workflow, "run_id");
    return ids.length === 1 && ids[0] === runId
      ? []
      : [issue("$.workflow_ids", "Workflow IDs do not equal the active workflow run")];
  }),
  "run-plan-attempt-id-uniqueness": documentGate(
    uniqueFieldGate([["rendered_prompts"]], "attempt_id", "rendered prompt attempt ID")
  ),
  "run-state-fingerprint": contextualGate(
    "runtime-state",
    ["runtimeState.graphFingerprint", "runtimeState.configFingerprint"],
    runStateFingerprintIssues
  ),
  "run-state-node-key-equality": documentGate(runStateNodeKeyIssues),
  "selected-strategy-id-uniqueness": documentGate(
    uniqueFieldGate([["strategies"]], "strategy_id", "selected strategy ID")
  ),
  "semantic-red-hash-uniqueness": documentGate(
    uniqueFieldGate([["semantic_reds"]], "stable_failure_hash", "semantic red hash")
  ),
  "severity-finding-id-uniqueness": documentGate(uniqueFieldGate([[]], "id", "severity finding ID")),
  "smithers-task-attempt-id-uniqueness": documentGate(uniqueFieldGate([["tasks"]], "attemptId", "Smithers attempt ID")),
  "smithers-task-workflow-id-uniqueness": documentGate(smithersWorkflowIdentityIssues),
  "smithers-task-document-identity": documentGate(smithersDocumentIdentityIssues),
  "smithers-task-dependency-join": documentGate(smithersDependencyJoinIssues),
  "smithers-task-dependency-acyclicity": documentGate(smithersDependencyAcyclicityIssues),
  "smithers-task-planned-graph-coverage": contextualGate(
    "cross-artifact",
    ["plannedGraph.document"],
    smithersPlannedCoverageIssues
  ),
  "smithers-task-planned-graph-identity": contextualGate(
    "cross-artifact",
    ["plannedGraph.document"],
    smithersPlannedIdentityIssues
  ),
  "smithers-task-planned-graph-dependency-join": contextualGate(
    "cross-artifact",
    ["plannedGraph.document"],
    smithersPlannedDependencyJoinIssues
  ),
  "source-run-not-self": documentGate((document) =>
    stringField(document, "run_id") === stringField(document, "source_run_id")
      ? [issue("$.source_run_id", "Source run must differ from the destination run")]
      : []
  ),
  "strategy-detection-dedupe-key-uniqueness": documentGate(
    uniqueFieldGate([[]], "dedupe_key", "strategy detection dedupe key")
  ),
  "triaged-finding-id-uniqueness": documentGate(uniqueFieldGate([[]], "id", "triaged finding ID")),
  "usage-ledger-event-order": contextualGate("runtime-state", ["usageLedger.entries"], usageEventOrderIssues),
  "usage-ledger-source-event-join": contextualGate("runtime-state", ["eventLog.events"], usageSourceEventJoinIssues),
  "workspace-patch-git-binding": contextualGate(
    "git",
    ["git.baseCommit", "git.baseTree", "git.resultTree", "git.patchSha256"],
    workspacePatchGitIssues
  ),
  "workspace-patch-path-uniqueness": documentGate(workspacePatchPathIssues)
} as const satisfies Readonly<Record<string, Omit<InternalRegistration, "name">>>;

export type SemanticGateName = keyof typeof gateSpecifications;

function buildRegistry(): Readonly<Record<SemanticGateName, InternalRegistration<SemanticGateName>>> {
  const entries = Object.entries(gateSpecifications).map(([name, specification]) => [
    name,
    Object.freeze({ name, ...specification })
  ]);
  return Object.freeze(Object.fromEntries(entries)) as Readonly<
    Record<SemanticGateName, InternalRegistration<SemanticGateName>>
  >;
}

/** Exact-name dispatcher registry. Its key set is audited against schema metadata at module load and in tests. */
export const SEMANTIC_GATE_REGISTRY = buildRegistry();

function assertRegistryMatchesMetadata(): void {
  const metadataNames = Object.values(ARTIFACT_SCHEMA_METADATA).flatMap((entry) => entry.semanticGates);
  const duplicates = metadataNames.filter((name, index) => metadataNames.indexOf(name) !== index);
  if (duplicates.length > 0) {
    throw new Error(`Artifact schema metadata repeats semantic gate names: ${sortedUnique(duplicates).join(", ")}`);
  }
  const registered = Object.keys(SEMANTIC_GATE_REGISTRY);
  const missing = metadataNames.filter((name) => !registered.includes(name));
  const stale = registered.filter((name) => !metadataNames.includes(name));
  if (missing.length > 0 || stale.length > 0) {
    throw new Error(
      `Semantic gate registry is out of sync with artifact schema metadata; missing=${missing.join(",")}; stale=${stale.join(",")}`
    );
  }
}

assertRegistryMatchesMetadata();

export function semanticGateRegistration<Name extends SemanticGateName>(name: Name): SemanticGateRegistration<Name> {
  const registration = SEMANTIC_GATE_REGISTRY[name];
  if (registration === undefined) throw new Error(`Unknown semantic gate ${JSON.stringify(name)}`);
  return registration as unknown as SemanticGateRegistration<Name>;
}

function hasCapability(context: SemanticGateContext | undefined, capability: string): boolean {
  let current: unknown = context;
  for (const segment of capability.split(".")) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return false;
    current = current[segment];
    if (current === undefined) return false;
  }
  return true;
}

export function executeSemanticGate<Name extends SemanticGateName>(
  name: Name,
  request: SemanticGateExecutionRequest
): SemanticGateExecutionResult<Name> {
  const registration = SEMANTIC_GATE_REGISTRY[name];
  if (registration === undefined) throw new Error(`Unknown semantic gate ${JSON.stringify(name)}`);
  const missingContext = registration.requiredContext.filter(
    (capability) => !hasCapability(request.context, capability)
  );
  if (missingContext.length > 0) {
    return {
      status: "requires-context",
      gate: name,
      scope: registration.scope as Exclude<SemanticGateScope, "document">,
      requiredContext: registration.requiredContext,
      missingContext
    };
  }
  let issues: SemanticGateIssue[];
  try {
    issues = registration.handler(request.document, request.context ?? {});
  } catch (error) {
    issues = [issue("$", `Semantic gate could not execute: ${error instanceof Error ? error.message : String(error)}`)];
  }
  return issues.length === 0
    ? { status: "passed", gate: name, scope: registration.scope }
    : { status: "failed", gate: name, scope: registration.scope, issues: Object.freeze(issues) };
}

export function executeSemanticGates<Names extends readonly SemanticGateName[]>(
  names: Names,
  request: SemanticGateExecutionRequest
): SemanticGateExecutionResult<Names[number]>[] {
  return names.map((name) => executeSemanticGate(name, request));
}

export function executeSchemaSemanticGates(
  schemaFilename: ArtifactSchemaFilename,
  request: SemanticGateExecutionRequest
): SemanticGateExecutionResult[] {
  const names = ARTIFACT_SCHEMA_METADATA[schemaFilename].semanticGates as readonly SemanticGateName[];
  return executeSemanticGates(names, request);
}

/**
 * Execute every document-local gate for an offline JSON validation and expose
 * contextual gates as `requires-context`; contextual gates are never reported
 * as passed by this entry point.
 */
export function executeOfflineSchemaSemanticGates(
  schemaFilename: ArtifactSchemaFilename,
  document: unknown
): SemanticGateExecutionResult[] {
  return executeSchemaSemanticGates(schemaFilename, { document });
}
