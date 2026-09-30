import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  assertNoSymlinkComponents,
  assertPathInside,
  assertRegularFileInside,
  parseStrictJsonBytes,
  publishFileDurableExclusive,
  readRegularFileSnapshot,
  readRunState,
  safeResolveInside,
  writeFileDurable,
  writeRunState,
  type RunState
} from "@ultrafuzz/artifacts";

import { DynamicExpansionError, readExpansionManifests, type DynamicExpansionManifest } from "./dynamic-expansion.js";
import { materializeDynamicRuntime } from "./dynamic-runtime.js";
import type { CompiledSmithersDynamicGroup, CompiledSmithersTask } from "./smithers.js";

const MAX_RUNTIME_BASE_CONTROL_BYTES = 64 * 1024 * 1024;

/**
 * The record of a withdrawal in progress. It is written into the manifest directory before anything
 * moves, so the manifest rename takes it along: while it is still there, a withdrawal that began
 * after its Smithers reset has not finished, and the next engine start completes it.
 */
const RETRY_WITHDRAWAL_FILE = ".retry-withdrawal.json";
const RETRY_WITHDRAWAL_SCHEMA_VERSION = "ultrafuzz.dynamic-expansion-withdrawal.v1";
const MAX_RETRY_WITHDRAWAL_BYTES = 16 * 1024 * 1024;

/**
 * Attempt-owned state that belongs to a generated dynamic attempt. The
 * `workspaces/` root is deliberately absent: a durable worktree stays where
 * Smithers registered it and the reopened attempt reuses it.
 */
const ATTEMPT_STATE_ROOTS = [
  { name: "artifacts", kind: "directory", suffix: "" },
  { name: "invariant-suite-workspace-snapshots", kind: "directory", suffix: "" },
  { name: ".ultrafuzz-verification", kind: "file", suffix: ".json" }
] as const;

interface DynamicRuntimeBase {
  graphPath: string;
  tasksPath: string;
  runId: string;
  tasks: CompiledSmithersTask[];
  groups: CompiledSmithersDynamicGroup[];
}

/** A validated decision to withdraw the published expansion generation, taken before any reset. */
export interface DynamicExpansionRetryPlan {
  projectRoot: string;
  runRoot: string;
  manifestDir: string;
  manifestDirMode: number;
  sourceNodeIds: string[];
  manifests: DynamicExpansionManifest[];
  runtimeBase: DynamicRuntimeBase | undefined;
}

export interface DynamicExpansionRetryArchive {
  archive_path: string;
  group_node_ids: string[];
  pruned_state_node_ids: string[];
}

interface RetryWithdrawal {
  archived_at: string;
  archive_path: string;
  source_node_ids: string[];
  archived_attempt_paths: string[];
}

/**
 * Decide whether an explicit source retry must withdraw the published expansion
 * generation, and validate everything that could refuse it.
 *
 * Smithers resets the producer and all of its dependents, but the expansion
 * manifests live outside Smithers state. Left in place, they keep the group at
 * its published items; withdrawing them lets the group expand again from the
 * retried source's new output. The decision is taken here, before the first
 * `timetravel`, so ambiguous or unrecognized manifest state fails closed while
 * Smithers state is still untouched. Returns `undefined` when no published
 * manifest belongs to a retried source.
 */
export function planDynamicExpansionRetryArchive(input: {
  projectRoot: string;
  runRoot: string;
  sourceNodeIds: readonly string[];
}): DynamicExpansionRetryPlan | undefined {
  const runRoot = path.resolve(input.runRoot);
  const projectRoot = path.resolve(input.projectRoot);
  assertPathInside(projectRoot, runRoot, "dynamic expansion run root");
  const manifestDir = path.join(runRoot, "dynamic-expansions");
  if (!fs.existsSync(manifestDir)) return undefined;
  assertNoSymlinkComponents(runRoot, manifestDir, "dynamic expansion manifest directory");
  const manifestStat = fs.lstatSync(manifestDir);
  if (!manifestStat.isDirectory()) {
    throw dynamicError("DYNAMIC_RETRY_EXPANSION_INVALID", "Dynamic expansion manifest root is not a directory", {
      manifestDir
    });
  }
  const manifests = readExpansionManifests(manifestDir);
  if (manifests.length === 0) return undefined;

  // Smithers names the producer `node:<attemptId>`; a manifest records the bare
  // concrete node and attempt IDs of its source.
  const retried = new Set(
    input.sourceNodeIds.flatMap((nodeId) => [
      nodeId,
      nodeId.startsWith("node:") ? nodeId.slice("node:".length) : `node:${nodeId}`
    ])
  );
  const matches = (manifest: DynamicExpansionManifest): boolean =>
    retried.has(manifest.source.node_id) || retried.has(manifest.source.attempt_id);
  const matched = manifests.filter(matches);
  if (matched.length === 0) return undefined;
  if (matched.length !== manifests.length) {
    throw dynamicError(
      "DYNAMIC_RETRY_EXPANSION_AMBIGUOUS",
      "Dynamic source retry cannot withdraw only part of the published expansion generation",
      {
        matchedGroupNodeIds: matched.map((manifest) => manifest.group_node_id),
        retainedGroupNodeIds: manifests
          .filter((manifest) => !matches(manifest))
          .map((manifest) => manifest.group_node_id)
      }
    );
  }
  const expectedEntries = new Set(manifests.map((manifest) => `${manifest.group_node_id}.json`));
  // A dot entry is never a manifest (readExpansionManifests skips it): an interrupted publication's
  // temporary file, a withdrawal record, or the `.expansion.lock` older builds left behind. It moves
  // with the directory.
  const unexpectedEntries = fs
    .readdirSync(manifestDir)
    .filter((entry) => !entry.startsWith(".") && !expectedEntries.has(entry));
  if (unexpectedEntries.length > 0) {
    throw dynamicError(
      "DYNAMIC_RETRY_EXPANSION_INVALID",
      "Dynamic expansion manifest root contains unrecognized retry state",
      { unexpectedEntries }
    );
  }
  // Validate the attempt-owned entries and the run state now; the move and the
  // prune themselves wait for the reset.
  const runtimeBase = readDynamicRuntimeBase(runRoot);
  collectAttemptStateMoves(runRoot, manifests, runtimeBase);
  readArchivableRunState(runRoot);
  return {
    projectRoot,
    runRoot,
    manifestDir,
    manifestDirMode: manifestStat.mode & 0o777,
    sourceNodeIds: [...new Set(input.sourceNodeIds)].sort(),
    manifests,
    runtimeBase
  };
}

/**
 * Withdraw the planned expansion generation into `dynamic-expansion-history/`.
 *
 * The withdrawal is recorded in the manifest directory first. The generation's attempt-owned
 * artifacts move next, so a regenerated attempt with a stable storage ID never meets a stale
 * rendered prompt. The published prompt of each planned task that waits on the generation moves
 * too, so the next expansion renders it afresh from the new items. Rendered prompts are used as
 * they are, never compared, so a stale one left beside a new manifest would silently run the
 * withdrawn item's prompt. Only after every move has succeeded is the whole manifest directory
 * renamed, in one step, so the old generation stays durable and no partially rewritten manifest set
 * can be observed. A move that fails, or a process killed before the rename, leaves the old
 * manifests and the record in place: every render stays consistent with the old generation, and
 * `finishInterruptedDynamicExpansionRetry` completes the withdrawal before the next engine starts,
 * because nothing would plan it again once Smithers has reset the source. The mutable runtime graph
 * and task plan are then re-derived from the sealed base with no ready group, exactly as the next
 * render would publish them, so the control admission check re-derives cleanly before that render
 * happens. Finally the generation's node records leave `state.json`. The synchronizer creates a
 * record only for an attempt that has none and never re-finalizes a successful one, so a
 * regenerated attempt that reuses a storage ID would otherwise start from the archived record, and
 * an archived success would stand in for it.
 */
export function archiveDynamicExpansionsForRetry(plan: DynamicExpansionRetryPlan): DynamicExpansionRetryArchive {
  const archiveRoot = path.join(plan.runRoot, "dynamic-expansion-history");
  fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(plan.runRoot, archiveRoot, "dynamic expansion history");
  const archivedAt = new Date().toISOString();
  const archiveDir = path.join(archiveRoot, `${archivedAt.replaceAll(":", "-")}-${crypto.randomUUID()}`);
  fs.mkdirSync(archiveDir, { mode: 0o700 });
  const withdrawal: RetryWithdrawal = {
    archived_at: archivedAt,
    archive_path: runRelativePath(plan.runRoot, archiveDir),
    source_node_ids: plan.sourceNodeIds,
    archived_attempt_paths: collectAttemptStateMoves(plan.runRoot, plan.manifests, plan.runtimeBase)
      .map((move) => runRelativePath(plan.runRoot, path.join(archiveDir, move.relativePath)))
      .sort()
  };
  writeFileDurable(
    path.join(plan.manifestDir, RETRY_WITHDRAWAL_FILE),
    `${JSON.stringify({ schema_version: RETRY_WITHDRAWAL_SCHEMA_VERSION, ...withdrawal }, null, 2)}\n`
  );
  return withdrawDynamicExpansions(plan, archiveDir, withdrawal);
}

/**
 * Complete a withdrawal that `archiveDynamicExpansionsForRetry` recorded but did not finish, into
 * the same history directory; returns `undefined` when none is recorded. It re-validates the
 * manifests as a new plan would and moves only what is still in place. Every engine start runs it
 * before it resets or renders anything.
 */
export function finishInterruptedDynamicExpansionRetry(input: {
  projectRoot: string;
  runRoot: string;
}): DynamicExpansionRetryArchive | undefined {
  const runRoot = path.resolve(input.runRoot);
  const manifestDir = path.join(runRoot, "dynamic-expansions");
  if (fs.lstatSync(manifestDir, { throwIfNoEntry: false })?.isDirectory() !== true) return undefined;
  const withdrawalPath = path.join(manifestDir, RETRY_WITHDRAWAL_FILE);
  if (fs.lstatSync(withdrawalPath, { throwIfNoEntry: false }) === undefined) return undefined;
  assertNoSymlinkComponents(runRoot, withdrawalPath, "interrupted dynamic retry");
  assertRegularFileInside(runRoot, withdrawalPath, "interrupted dynamic retry");
  const withdrawal = parseRetryWithdrawal(
    parseStrictJsonBytes(readRegularFileSnapshot(withdrawalPath, MAX_RETRY_WITHDRAWAL_BYTES)),
    withdrawalPath
  );
  const plan = planDynamicExpansionRetryArchive({
    projectRoot: input.projectRoot,
    runRoot,
    sourceNodeIds: withdrawal.source_node_ids
  });
  const archiveDir = safeResolveInside(runRoot, withdrawal.archive_path, "interrupted dynamic retry archive");
  if (plan === undefined || path.dirname(archiveDir) !== path.join(runRoot, "dynamic-expansion-history")) {
    throw dynamicError("DYNAMIC_RETRY_EXPANSION_INVALID", "Interrupted dynamic source retry cannot be completed", {
      withdrawalPath
    });
  }
  fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  return withdrawDynamicExpansions(plan, archiveDir, withdrawal);
}

function withdrawDynamicExpansions(
  plan: DynamicExpansionRetryPlan,
  archiveDir: string,
  withdrawal: RetryWithdrawal
): DynamicExpansionRetryArchive {
  const archivedAttemptPaths = new Set(withdrawal.archived_attempt_paths);
  for (const move of collectAttemptStateMoves(plan.runRoot, plan.manifests, plan.runtimeBase)) {
    // A render between an interrupted withdrawal and its completion can recreate an entry that has
    // already moved. Both copies belong to the withdrawn generation, so the later one moves beside it.
    let destination = path.join(archiveDir, move.relativePath);
    for (let copy = 1; fs.lstatSync(destination, { throwIfNoEntry: false }) !== undefined; copy += 1) {
      destination = `${path.join(archiveDir, move.relativePath)}.${String(copy)}`;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.renameSync(move.source, destination);
    archivedAttemptPaths.add(runRelativePath(plan.runRoot, destination));
  }
  fs.renameSync(plan.manifestDir, path.join(archiveDir, "manifests"));
  fs.mkdirSync(plan.manifestDir, { mode: plan.manifestDirMode });
  fs.rmSync(path.join(archiveDir, "manifests", RETRY_WITHDRAWAL_FILE), { force: true });
  rematerializeDynamicRuntimeBase(plan);
  const prunedStateNodeIds = pruneArchivedRunStateNodes(plan.runRoot, plan.manifests);
  const groupNodeIds = plan.manifests.map((manifest) => manifest.group_node_id);
  publishFileDurableExclusive(
    archiveDir,
    "retry.json",
    `${JSON.stringify(
      {
        schema_version: "ultrafuzz.dynamic-expansion-retry.v1",
        archived_at: withdrawal.archived_at,
        source_node_ids: plan.sourceNodeIds,
        group_node_ids: groupNodeIds,
        archived_attempt_paths: [...archivedAttemptPaths].sort(),
        pruned_state_node_ids: prunedStateNodeIds
      },
      null,
      2
    )}\n`
  );
  return { archive_path: archiveDir, group_node_ids: groupNodeIds, pruned_state_node_ids: prunedStateNodeIds };
}

function parseRetryWithdrawal(value: unknown, withdrawalPath: string): RetryWithdrawal {
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
  const { schema_version, archived_at, archive_path, source_node_ids, archived_attempt_paths } = record as Record<
    string,
    unknown
  >;
  const isStringList = (list: unknown): list is string[] =>
    Array.isArray(list) && list.every((entry) => typeof entry === "string");
  if (
    schema_version !== RETRY_WITHDRAWAL_SCHEMA_VERSION ||
    typeof archived_at !== "string" ||
    typeof archive_path !== "string" ||
    !isStringList(source_node_ids) ||
    source_node_ids.length === 0 ||
    !isStringList(archived_attempt_paths)
  ) {
    throw dynamicError("DYNAMIC_RETRY_EXPANSION_INVALID", "Interrupted dynamic source retry record is invalid", {
      withdrawalPath
    });
  }
  return { archived_at, archive_path, source_node_ids, archived_attempt_paths };
}

function runRelativePath(runRoot: string, candidate: string): string {
  return path.relative(runRoot, candidate).split(path.sep).join("/");
}

/**
 * A generated attempt is stored under its storage ID, or under
 * `<storageId>__model_<i>__attempt_<j>` when the group fans out over models
 * (`dynamicAttemptId` in dynamic-runtime.ts). Every attempt-owned file and
 * every run state record of the generation is keyed by one of those IDs.
 */
function generationOwnsAttempt(manifests: readonly DynamicExpansionManifest[]): (attemptId: string) => boolean {
  const storageIds = manifests.flatMap((manifest) => manifest.items.map((item) => item.storage_id));
  return (attemptId) =>
    storageIds.some((storageId) => attemptId === storageId || attemptId.startsWith(`${storageId}__model_`));
}

/**
 * The synchronizer records a generated graph node under its storage ID and each
 * generated task under its attempt ID; the human node ID never becomes a state
 * key. Every other node and every other field is preserved, and the document
 * goes through the validated durable writer the synchronizer uses. Returns the
 * pruned node IDs, sorted.
 */
function pruneArchivedRunStateNodes(runRoot: string, manifests: readonly DynamicExpansionManifest[]): string[] {
  const state = readArchivableRunState(runRoot);
  if (state === undefined) return [];
  const owned = generationOwnsAttempt(manifests);
  const pruned = Object.keys(state.document.nodes).filter(owned).sort();
  if (pruned.length === 0) return [];
  writeRunState(state.statePath, {
    ...state.document,
    nodes: Object.fromEntries(Object.entries(state.document.nodes).filter(([nodeId]) => !owned(nodeId)))
  });
  return pruned;
}

/** Read and validate the run state, or `undefined` for a run root that has none. */
function readArchivableRunState(runRoot: string): { statePath: string; document: RunState } | undefined {
  const statePath = path.join(runRoot, "state.json");
  if (!fs.existsSync(statePath)) return undefined;
  assertNoSymlinkComponents(runRoot, statePath, "dynamic retry run state");
  assertRegularFileInside(runRoot, statePath, "dynamic retry run state");
  return { statePath, document: readRunState(statePath) };
}

function collectAttemptStateMoves(
  runRoot: string,
  manifests: readonly DynamicExpansionManifest[],
  runtimeBase: DynamicRuntimeBase | undefined
): Array<{ source: string; relativePath: string }> {
  const ownsAttempt = generationOwnsAttempt(manifests);
  const moves: Array<{ source: string; relativePath: string }> = [];
  for (const root of ATTEMPT_STATE_ROOTS) {
    const sourceRoot = path.join(runRoot, root.name);
    if (!fs.existsSync(sourceRoot)) continue;
    assertNoSymlinkComponents(runRoot, sourceRoot, `dynamic retry ${root.name} root`);
    if (!fs.lstatSync(sourceRoot).isDirectory()) {
      throw dynamicError("DYNAMIC_RETRY_EXPANSION_INVALID", `Dynamic retry ${root.name} root is not a directory`, {
        sourceRoot
      });
    }
    for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
      if (!entry.name.endsWith(root.suffix)) continue;
      const attemptId = root.suffix === "" ? entry.name : entry.name.slice(0, -root.suffix.length);
      if (!ownsAttempt(attemptId)) continue;
      if (entry.isSymbolicLink() || (root.kind === "directory" ? !entry.isDirectory() : !entry.isFile())) {
        throw dynamicError(
          "DYNAMIC_RETRY_EXPANSION_INVALID",
          `Dynamic retry ${root.name} entry has an unexpected file type`,
          { entry: entry.name }
        );
      }
      moves.push({ source: path.join(sourceRoot, entry.name), relativePath: `${root.name}/${entry.name}` });
    }
  }
  // A planned task whose prompt waits on a withdrawn group was rendered from this generation's
  // children. Left in place, it would be used as it is once the retried source plans other items,
  // naming children that no longer exist. Moved, it renders again from the new expansion. Only a
  // prompt that was never rendered is skipped: `lstat` counts a dangling symlink as present, so the
  // file-type check refuses it.
  const groupIds = new Set(manifests.map((manifest) => manifest.group_node_id));
  for (const task of runtimeBase?.tasks ?? []) {
    if (!(task.deferredPromptGroups ?? []).some((groupId) => groupIds.has(groupId))) continue;
    const relativePath = `artifacts/${task.attemptId}/prompt.rendered.md`;
    const source = path.join(runRoot, relativePath);
    assertNoSymlinkComponents(runRoot, source, `dynamic retry prompt for ${task.attemptId}`);
    if (fs.lstatSync(source, { throwIfNoEntry: false }) === undefined) continue;
    assertRegularFileInside(runRoot, source, `dynamic retry prompt for ${task.attemptId}`);
    moves.push({ source, relativePath });
  }
  return moves;
}

/**
 * The seal keeps byte copies of the pre-expansion graph and task manifest next
 * to the mutable controls, and only for a run that compiled a dynamic group.
 * The same light shape check `verifyDynamicRuntimeMaterialization`'s caller
 * applies to the sealed copy is applied here.
 */
function readDynamicRuntimeBase(runRoot: string): DynamicRuntimeBase | undefined {
  const graphPath = path.join(runRoot, "smithers", "runtime-base-graph.json");
  const tasksPath = path.join(runRoot, "smithers", "runtime-base-tasks.json");
  const hasGraph = fs.existsSync(graphPath);
  const hasTasks = fs.existsSync(tasksPath);
  if (!hasGraph && !hasTasks) return undefined;
  if (hasGraph !== hasTasks) {
    throw dynamicError("DYNAMIC_RETRY_EXPANSION_INVALID", "Dynamic runtime base controls are incomplete", {
      graphPath,
      tasksPath
    });
  }
  for (const [filePath, label] of [
    [graphPath, "dynamic runtime base graph"],
    [tasksPath, "dynamic runtime base task manifest"]
  ] as const) {
    assertNoSymlinkComponents(runRoot, filePath, label);
    assertRegularFileInside(runRoot, filePath, label);
  }
  const document = parseStrictJsonBytes(readRegularFileSnapshot(tasksPath, MAX_RUNTIME_BASE_CONTROL_BYTES));
  if (
    typeof document !== "object" ||
    document === null ||
    Array.isArray(document) ||
    typeof (document as { run_id?: unknown }).run_id !== "string" ||
    !Array.isArray((document as { tasks?: unknown }).tasks) ||
    !Array.isArray((document as { dynamic_groups?: unknown }).dynamic_groups)
  ) {
    throw dynamicError(
      "DYNAMIC_RETRY_EXPANSION_INVALID",
      "Dynamic runtime base task manifest cannot define dynamic runtime controls",
      { tasksPath }
    );
  }
  const base = document as { run_id: string; tasks: unknown[]; dynamic_groups: unknown[] };
  return {
    graphPath,
    tasksPath,
    runId: base.run_id,
    tasks: base.tasks as CompiledSmithersTask[],
    groups: base.dynamic_groups as CompiledSmithersDynamicGroup[]
  };
}

function rematerializeDynamicRuntimeBase(plan: DynamicExpansionRetryPlan): void {
  const base = plan.runtimeBase;
  if (base === undefined) return;
  materializeDynamicRuntime({
    runId: base.runId,
    projectRoot: plan.projectRoot,
    runRoot: plan.runRoot,
    graphPath: path.join(plan.runRoot, "graph.json"),
    tasksPath: path.join(plan.runRoot, "smithers", "tasks.json"),
    baseGraphPath: base.graphPath,
    baseTasksPath: base.tasksPath,
    baseTasks: base.tasks,
    groups: base.groups,
    readyGroupIds: []
  });
}

function dynamicError(code: string, message: string, details: Record<string, unknown> = {}): DynamicExpansionError {
  return new DynamicExpansionError(code, message, details);
}
