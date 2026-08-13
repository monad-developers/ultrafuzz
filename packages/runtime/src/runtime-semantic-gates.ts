import path from "node:path";

import {
  INVARIANT_SUITE_BASELINE_JSON_SCHEMA_ID,
  INVARIANT_SUITE_HANDOFF_JSON_SCHEMA_ID,
  INVARIANT_WORKSPACE_SNAPSHOT_JSON_SCHEMA_ID,
  PINNED_SUBMODULE_EXPECTATION_JSON_SCHEMA_ID,
  PINNED_SUBMODULE_SNAPSHOT_JSON_SCHEMA_ID,
  WORKFLOW_CONTROL_INTEGRITY_JSON_SCHEMA_ID,
  WORKFLOW_EXECUTION_DEPENDENCIES_JSON_SCHEMA_ID,
  WORKFLOW_RUN_LINK_JOURNAL_JSON_SCHEMA_ID,
  type InvariantSuiteBaselineDocument,
  type InvariantSuiteHandoffDocument,
  type InvariantWorkspaceSnapshotDocument,
  type PinnedSubmoduleExpectationDocument,
  type PinnedSubmoduleSnapshotDocument,
  type RuntimeDocumentForSchemaId,
  type RuntimeDocumentSchemaId,
  type WorkflowControlIntegrityDocument,
  type WorkflowExecutionDependenciesDocument,
  type WorkflowRunLinkJournalDocument
} from "./runtime-contracts.js";

export const IMPLEMENTED_RUNTIME_SEMANTIC_GATES = Object.freeze([
  "invariant-suite-baseline-path-identity-and-budget",
  "invariant-workspace-snapshot-path-identity-and-budget",
  "invariant-suite-handoff-identity-order-and-budget",
  "pinned-submodule-expectation-order-and-accounting",
  "pinned-submodule-snapshot-closure-order-and-budget",
  "workflow-control-integrity-identity-order",
  "workflow-execution-dependency-closure-and-order",
  "workflow-run-link-chain-and-order"
] as const);

export type RuntimeSemanticGateName = (typeof IMPLEMENTED_RUNTIME_SEMANTIC_GATES)[number];

export const RUNTIME_SEMANTIC_GATES_BY_SCHEMA_ID = Object.freeze({
  [INVARIANT_SUITE_BASELINE_JSON_SCHEMA_ID]: ["invariant-suite-baseline-path-identity-and-budget"],
  [INVARIANT_WORKSPACE_SNAPSHOT_JSON_SCHEMA_ID]: ["invariant-workspace-snapshot-path-identity-and-budget"],
  [INVARIANT_SUITE_HANDOFF_JSON_SCHEMA_ID]: ["invariant-suite-handoff-identity-order-and-budget"],
  [PINNED_SUBMODULE_EXPECTATION_JSON_SCHEMA_ID]: ["pinned-submodule-expectation-order-and-accounting"],
  [PINNED_SUBMODULE_SNAPSHOT_JSON_SCHEMA_ID]: ["pinned-submodule-snapshot-closure-order-and-budget"],
  [WORKFLOW_CONTROL_INTEGRITY_JSON_SCHEMA_ID]: ["workflow-control-integrity-identity-order"],
  [WORKFLOW_EXECUTION_DEPENDENCIES_JSON_SCHEMA_ID]: ["workflow-execution-dependency-closure-and-order"],
  [WORKFLOW_RUN_LINK_JOURNAL_JSON_SCHEMA_ID]: ["workflow-run-link-chain-and-order"]
} as const satisfies Partial<Record<RuntimeDocumentSchemaId, readonly RuntimeSemanticGateName[]>>);

export class RuntimeSemanticValidationError extends Error {
  readonly gate: RuntimeSemanticGateName;

  constructor(gate: RuntimeSemanticGateName, message: string) {
    super(`${gate}: ${message}`);
    this.name = "RuntimeSemanticValidationError";
    this.gate = gate;
  }
}

export function assertRuntimeDocumentSemantics<SchemaId extends RuntimeDocumentSchemaId>(
  schemaId: SchemaId,
  value: RuntimeDocumentForSchemaId<SchemaId>
): void {
  switch (schemaId) {
    case INVARIANT_SUITE_BASELINE_JSON_SCHEMA_ID:
      assertInvariantSuiteBaseline(value as InvariantSuiteBaselineDocument);
      return;
    case INVARIANT_WORKSPACE_SNAPSHOT_JSON_SCHEMA_ID:
      assertInvariantWorkspaceSnapshot(value as InvariantWorkspaceSnapshotDocument);
      return;
    case INVARIANT_SUITE_HANDOFF_JSON_SCHEMA_ID:
      assertInvariantSuiteHandoff(value as InvariantSuiteHandoffDocument);
      return;
    case PINNED_SUBMODULE_EXPECTATION_JSON_SCHEMA_ID:
      assertPinnedSubmoduleExpectation(value as PinnedSubmoduleExpectationDocument);
      return;
    case PINNED_SUBMODULE_SNAPSHOT_JSON_SCHEMA_ID:
      assertPinnedSubmoduleSnapshot(value as PinnedSubmoduleSnapshotDocument);
      return;
    case WORKFLOW_CONTROL_INTEGRITY_JSON_SCHEMA_ID:
      assertWorkflowControlIntegrity(value as WorkflowControlIntegrityDocument);
      return;
    case WORKFLOW_EXECUTION_DEPENDENCIES_JSON_SCHEMA_ID:
      assertWorkflowExecutionDependencies(value as WorkflowExecutionDependenciesDocument);
      return;
    case WORKFLOW_RUN_LINK_JOURNAL_JSON_SCHEMA_ID:
      assertWorkflowRunLinkJournal(value as WorkflowRunLinkJournalDocument);
      return;
    default:
      return;
  }
}

function assertInvariantSuiteBaseline(document: InvariantSuiteBaselineDocument): void {
  assertUniqueAndOrderedPaths(
    "invariant-suite-baseline-path-identity-and-budget",
    document.files.map((entry) => entry.path),
    "baseline files"
  );
  const total = document.files.reduce((sum, entry) => sum + entry.size, 0);
  if (total > 64 * 1024 * 1024) {
    fail("invariant-suite-baseline-path-identity-and-budget", "baseline files exceed the 64 MiB aggregate budget");
  }
}

function assertInvariantWorkspaceSnapshot(document: InvariantWorkspaceSnapshotDocument): void {
  assertUniqueAndOrderedPaths(
    "invariant-workspace-snapshot-path-identity-and-budget",
    document.files.map((entry) => entry.path),
    "snapshot files"
  );
  const total = document.files.reduce((sum, entry) => sum + entry.size, 0);
  if (total > 128 * 1024 * 1024) {
    fail("invariant-workspace-snapshot-path-identity-and-budget", "snapshot files exceed the 128 MiB aggregate budget");
  }
}

function assertInvariantSuiteHandoff(document: InvariantSuiteHandoffDocument): void {
  const gate = "invariant-suite-handoff-identity-order-and-budget";
  assertUniqueAndOrderedStrings(
    gate,
    document.producers.map((entry) => entry.attempt_id),
    "producer attempt IDs"
  );
  assertUniqueAndOrderedPaths(
    gate,
    document.dependencies.map((entry) => entry.path),
    "dependency paths"
  );
  assertUniqueAndOrderedPaths(gate, document.tombstones, "tombstones");
  const total = document.dependencies.reduce((sum, entry) => sum + entry.size, 0);
  if (total > 64 * 1024 * 1024) fail(gate, "dependencies exceed the 64 MiB aggregate budget");
}

function assertPinnedSubmoduleExpectation(document: PinnedSubmoduleExpectationDocument): void {
  const gate = "pinned-submodule-expectation-order-and-accounting";
  assertPinnedPaths(gate, document.top_level_roots, "top-level roots");
  assertPinnedGitlinks(gate, document.recursive_gitlinks, "recursive gitlinks");
  if (document.file_count > document.entry_count) {
    fail(gate, "file count exceeds the total entry count");
  }
  for (const root of document.top_level_roots) {
    if (!document.recursive_gitlinks.some((entry) => entry.path === root)) {
      fail(gate, `top-level root is not a recursive gitlink: ${root}`);
    }
  }
  assertNonoverlappingRoots(gate, document.top_level_roots);
}

function assertPinnedSubmoduleSnapshot(document: PinnedSubmoduleSnapshotDocument): void {
  const gate = "pinned-submodule-snapshot-closure-order-and-budget";
  assertPinnedPaths(gate, document.top_level_roots, "top-level roots");
  assertPinnedGitlinks(gate, document.recursive_gitlinks, "recursive gitlinks");
  assertPinnedPaths(
    gate,
    document.entries.map((entry) => entry.path),
    "snapshot entries"
  );
  assertNonoverlappingRoots(gate, document.top_level_roots);

  const entryByPath = new Map(document.entries.map((entry) => [entry.path, entry]));
  const gitlinkPaths = new Set(document.recursive_gitlinks.map((entry) => entry.path));
  for (const link of document.recursive_gitlinks) {
    if (entryByPath.get(link.path)?.type !== "directory") {
      fail(gate, `gitlink has no dependency directory: ${link.path}`);
    }
    if (!document.top_level_roots.some((root) => isAtOrBelowPinnedPath(link.path, root))) {
      fail(gate, `recursive gitlink is outside the top-level roots: ${link.path}`);
    }
    if (
      !document.top_level_roots.includes(link.path) &&
      !document.recursive_gitlinks.some(
        (candidate) => candidate.path !== link.path && isAtOrBelowPinnedPath(link.path, candidate.path)
      )
    ) {
      fail(gate, `recursive gitlink has no parent repository: ${link.path}`);
    }
  }

  for (const entry of document.entries) {
    const root = document.top_level_roots.find((candidate) => isAtOrBelowPinnedPath(entry.path, candidate));
    if (root === undefined) fail(gate, `snapshot entry is outside the top-level roots: ${entry.path}`);
    if (entry.path !== root && entryByPath.get(path.posix.dirname(entry.path))?.type !== "directory") {
      fail(gate, `snapshot entry has no physical directory parent: ${entry.path}`);
    }
    if (
      entry.type !== "directory" &&
      document.entries.some((candidate) => isStrictlyBelowPinnedPath(candidate.path, entry.path))
    ) {
      fail(gate, `non-directory entry is a path prefix: ${entry.path}`);
    }
    if (entry.type === "symlink") {
      const owner = document.recursive_gitlinks
        .filter((candidate) => isAtOrBelowPinnedPath(entry.path, candidate.path))
        .sort(
          (left, right) =>
            pinnedPathDepth(right.path) - pinnedPathDepth(left.path) || left.path.localeCompare(right.path)
        )[0];
      if (owner === undefined) fail(gate, `snapshot entry has no owning repository: ${entry.path}`);
      assertPinnedSymlinkTarget(gate, entry.path, entry.target, [owner.path]);
    }
  }
  for (const root of document.top_level_roots) {
    if (entryByPath.get(root)?.type !== "directory" || !gitlinkPaths.has(root)) {
      fail(gate, `top-level root is absent from the byte tree: ${root}`);
    }
  }

  const totalFileBytes = document.entries.reduce(
    (total, entry) => total + (entry.type === "file" ? entry.size_bytes : 0),
    0
  );
  if (!Number.isSafeInteger(totalFileBytes) || totalFileBytes > 2 * 1024 * 1024 * 1024) {
    fail(gate, "snapshot exceeds the aggregate file-byte budget");
  }
  if (Buffer.byteLength(`${JSON.stringify(document, null, 2)}\n`, "utf8") > 64 * 1024 * 1024) {
    fail(gate, "snapshot manifest exceeds the serialized byte budget");
  }
}

function assertPinnedGitlinks(gate: RuntimeSemanticGateName, values: readonly { path: string }[], label: string): void {
  assertPinnedPaths(
    gate,
    values.map((entry) => entry.path),
    label
  );
}

function pinnedPathDepth(value: string): number {
  return value.split("/").length;
}

function assertPinnedPaths(gate: RuntimeSemanticGateName, values: readonly string[], label: string): void {
  for (const value of values) {
    assertPortableRelativePath(gate, value, label);
    const segments = value.split("/");
    if (
      Buffer.byteLength(value, "utf8") > 4_096 ||
      segments.length > 128 ||
      segments.some(
        (segment) =>
          segment.length === 0 ||
          segment === ".git" ||
          segment === "." ||
          segment === ".." ||
          /^[A-Za-z]:/u.test(segment)
      )
    ) {
      fail(gate, `${label} contains an unsafe Git path ${JSON.stringify(value)}`);
    }
  }
  assertUniqueAndOrderedStrings(gate, values, label);
}

function assertNonoverlappingRoots(gate: RuntimeSemanticGateName, roots: readonly string[]): void {
  for (const [index, root] of roots.entries()) {
    if (roots.some((candidate, candidateIndex) => candidateIndex !== index && isAtOrBelowPinnedPath(root, candidate))) {
      fail(gate, `top-level roots overlap at ${JSON.stringify(root)}`);
    }
  }
}

function assertPinnedSymlinkTarget(
  gate: RuntimeSemanticGateName,
  relativePath: string,
  target: string,
  roots: readonly string[]
): void {
  if (
    Buffer.byteLength(target, "utf8") > 4_096 ||
    target.includes("\\") ||
    path.posix.isAbsolute(target) ||
    path.win32.isAbsolute(target) ||
    target.split("/").some((segment) => /^[A-Za-z]:/u.test(segment))
  ) {
    fail(gate, `symlink has an unsafe target: ${relativePath}`);
  }
  const root = roots.find((candidate) => isAtOrBelowPinnedPath(relativePath, candidate));
  if (root === undefined) fail(gate, `symlink is outside the top-level roots: ${relativePath}`);
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), target));
  if (!isAtOrBelowPinnedPath(resolved, root) || resolved.split("/").includes(".git")) {
    fail(gate, `symlink escapes its root: ${relativePath}`);
  }
}

function isAtOrBelowPinnedPath(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function isStrictlyBelowPinnedPath(candidate: string, root: string): boolean {
  return candidate !== root && candidate.startsWith(`${root}/`);
}

function assertWorkflowControlIntegrity(document: WorkflowControlIntegrityDocument): void {
  const gate = "workflow-control-integrity-identity-order";
  assertUniqueAndOrderedStrings(
    gate,
    document.execution_files.map((entry) => entry.snapshot_path),
    "execution snapshot paths"
  );
  assertUniqueStrings(
    gate,
    document.execution_files.map((entry) => entry.source_path),
    "execution source paths"
  );
  for (const [label, values] of [
    ["expected state node IDs", document.bindings.expected_state_node_ids],
    ["expected task attempt IDs", document.bindings.expected_task_attempt_ids],
    ["expected task node IDs", document.bindings.expected_task_node_ids]
  ] as const) {
    assertUniqueAndOrderedStrings(gate, values, label);
  }
  if (document.bindings.run_id !== document.run_id) fail(gate, "binding run ID differs from the seal run ID");
}

function assertWorkflowExecutionDependencies(document: WorkflowExecutionDependenciesDocument): void {
  const gate = "workflow-execution-dependency-closure-and-order";
  assertUniqueAndOrderedStrings(
    gate,
    document.modules.map((entry) => entry.id),
    "module IDs"
  );
  assertUniqueAndOrderedStrings(
    gate,
    document.packages.map((entry) => entry.id),
    "package IDs"
  );
  const targets = [...document.modules, ...document.packages];
  assertUniqueStrings(
    gate,
    targets.map((entry) => entry.id),
    "target IDs"
  );
  assertUniqueStrings(
    gate,
    targets.map((entry) => entry.snapshot_path),
    "target snapshot paths"
  );
  assertUniqueAndOrderedStrings(
    gate,
    document.issuers.map((entry) => entry.id),
    "issuer IDs"
  );
  assertUniqueAndOrderedStrings(gate, document.executable_paths, "executable paths");
  const targetIds = new Set(targets.map((entry) => entry.id));
  for (const module of document.modules) {
    if (module.id !== `module:${module.name}` || module.snapshot_path !== path.posix.join("modules", module.name)) {
      fail(gate, `module ${module.id} does not use its derived identity and snapshot path`);
    }
  }
  for (const [index, entry] of document.packages.entries()) {
    const sequence = String(index + 1).padStart(6, "0");
    if (entry.id !== `package:${sequence}` || entry.snapshot_path !== `dependencies/packages/${sequence}`) {
      fail(gate, `package ${entry.id} does not use its derived identity and snapshot path`);
    }
  }
  const expectedIssuers = [
    { id: "root", snapshot_path: "." },
    ...targets.map(({ id, snapshot_path }) => ({ id, snapshot_path }))
  ].sort((left, right) => compareStrings(left.id, right.id));
  if (
    document.issuers.length !== expectedIssuers.length ||
    document.issuers.some(
      (entry, index) =>
        entry.id !== expectedIssuers[index]?.id || entry.snapshot_path !== expectedIssuers[index]?.snapshot_path
    )
  ) {
    fail(gate, "issuer set is incomplete or does not match target snapshot paths");
  }
  for (const issuer of document.issuers) {
    const names = Object.keys(issuer.dependencies);
    if (!isStrictlyOrdered(names)) fail(gate, `issuer ${issuer.id} dependency names are not canonically ordered`);
    if (Object.values(issuer.dependencies).some((target) => !targetIds.has(target))) {
      fail(gate, `issuer ${issuer.id} references an undeclared target`);
    }
  }
  if (document.smithers_bin !== null && !document.executable_paths.includes(document.smithers_bin)) {
    fail(gate, "smithers_bin is not one of the declared executable paths");
  }
}

function assertWorkflowRunLinkJournal(document: WorkflowRunLinkJournalDocument): void {
  const gate = "workflow-run-link-chain-and-order";
  assertUniqueStrings(
    gate,
    document.entries.map((entry) => entry.link_id),
    "link IDs"
  );
  for (const [index, entry] of document.entries.entries()) {
    const previous = document.entries[index - 1];
    if (index === 0) {
      if (entry.action !== "start") fail(gate, "the initial link is not a start link");
    } else if (
      previous === undefined ||
      previous.phase !== "committed" ||
      entry.action === "start" ||
      entry.source_workflow_run_id !== previous.workflow_run_id ||
      entry.source_workflow_link_id !== previous.link_id ||
      entry.control_generation !== previous.control_generation
    ) {
      fail(gate, `link ${index + 1} does not extend the preceding committed link`);
    }
    if (entry.phase !== "committed" && index !== document.entries.length - 1) {
      fail(gate, "an unresolved prepared link appears before the end of the journal");
    }
  }
}

function assertUniqueAndOrderedPaths(gate: RuntimeSemanticGateName, values: readonly string[], label: string): void {
  for (const value of values) assertPortableRelativePath(gate, value, label);
  assertUniqueAndOrderedStrings(gate, values, label);
}

function assertPortableRelativePath(gate: RuntimeSemanticGateName, value: string, label: string): void {
  if (
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value === "." ||
    value.startsWith("../")
  ) {
    fail(gate, `${label} contains unsafe path ${JSON.stringify(value)}`);
  }
}

function assertUniqueAndOrderedStrings(gate: RuntimeSemanticGateName, values: readonly string[], label: string): void {
  assertUniqueStrings(gate, values, label);
  if (!isStrictlyOrdered(values)) fail(gate, `${label} are not canonically ordered`);
}

function assertUniqueStrings(gate: RuntimeSemanticGateName, values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) fail(gate, `${label} are not unique`);
}

function isStrictlyOrdered(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || compareStrings(values[index - 1]!, value) < 0);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(gate: RuntimeSemanticGateName, message: string): never {
  throw new RuntimeSemanticValidationError(gate, message);
}
