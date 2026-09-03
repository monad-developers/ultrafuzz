import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  assertNoSymlinkComponents,
  assertPathInside,
  assertRegularFileInside,
  parseStrictJsonBytes,
  publishFileDurableExclusive,
  readRegularFileSnapshot
} from "@ultrafuzz/artifacts";

import { DynamicExpansionError, readExpansionManifests, type DynamicExpansionManifest } from "./dynamic-expansion.js";
import { materializeDynamicRuntime } from "./dynamic-runtime.js";
import type { CompiledSmithersDynamicGroup, CompiledSmithersTask } from "./smithers.js";

const MAX_RUNTIME_BASE_CONTROL_BYTES = 64 * 1024 * 1024;

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
}

/**
 * Decide whether an explicit source retry must withdraw the published expansion
 * generation, and validate everything that could refuse it.
 *
 * Smithers resets the producer and all of its dependents, but the expansion
 * manifests live outside Smithers state. Leaving them active makes the next
 * workflow render require the canonical source artifact during the gap between
 * producer completion and verifier publication. The decision is taken here,
 * before the first `timetravel`, so ambiguous or unrecognized manifest state
 * fails closed while Smithers state is still untouched. Returns `undefined`
 * when no published manifest belongs to a retried source.
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
  const unexpectedEntries = fs.readdirSync(manifestDir).filter((entry) => !expectedEntries.has(entry));
  if (unexpectedEntries.length > 0) {
    throw dynamicError(
      "DYNAMIC_RETRY_EXPANSION_INVALID",
      "Dynamic expansion manifest root contains unrecognized retry state",
      { unexpectedEntries }
    );
  }
  // Validate the attempt-owned entries now; the move itself waits for the reset.
  collectAttemptStateMoves(runRoot, manifests);
  return {
    projectRoot,
    runRoot,
    manifestDir,
    manifestDirMode: manifestStat.mode & 0o777,
    sourceNodeIds: [...new Set(input.sourceNodeIds)].sort(),
    manifests,
    runtimeBase: readDynamicRuntimeBase(runRoot)
  };
}

/**
 * Withdraw the planned expansion generation into `dynamic-expansion-history/`.
 *
 * The whole manifest directory is renamed in one step, so the old generation
 * stays durable and no partially rewritten manifest set can be observed. The
 * generation's attempt-owned artifacts move with it, so a regenerated attempt
 * with a stable storage ID never meets a stale rendered prompt. The mutable
 * runtime graph and task plan are then re-derived from the sealed base with no
 * ready group, exactly as the next render would publish them, so the control
 * admission check re-derives cleanly before that render happens.
 */
export function archiveDynamicExpansionsForRetry(plan: DynamicExpansionRetryPlan): DynamicExpansionRetryArchive {
  const archiveRoot = path.join(plan.runRoot, "dynamic-expansion-history");
  fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(plan.runRoot, archiveRoot, "dynamic expansion history");
  const archivedAt = new Date().toISOString();
  const archiveDir = path.join(archiveRoot, `${archivedAt.replaceAll(":", "-")}-${crypto.randomUUID()}`);
  fs.mkdirSync(archiveDir, { mode: 0o700 });
  fs.renameSync(plan.manifestDir, path.join(archiveDir, "manifests"));
  fs.mkdirSync(plan.manifestDir, { mode: plan.manifestDirMode });
  const archivedAttemptPaths = collectAttemptStateMoves(plan.runRoot, plan.manifests).map((move) => {
    const destination = path.join(archiveDir, move.relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.renameSync(move.source, destination);
    return path.relative(plan.runRoot, destination).split(path.sep).join("/");
  });
  rematerializeDynamicRuntimeBase(plan);
  const groupNodeIds = plan.manifests.map((manifest) => manifest.group_node_id);
  publishFileDurableExclusive(
    archiveDir,
    "retry.json",
    `${JSON.stringify(
      {
        schema_version: "ultrafuzz.dynamic-expansion-retry.v1",
        archived_at: archivedAt,
        source_node_ids: plan.sourceNodeIds,
        group_node_ids: groupNodeIds,
        archived_attempt_paths: archivedAttemptPaths.sort()
      },
      null,
      2
    )}\n`
  );
  return { archive_path: archiveDir, group_node_ids: groupNodeIds };
}

function collectAttemptStateMoves(
  runRoot: string,
  manifests: readonly DynamicExpansionManifest[]
): Array<{ source: string; relativePath: string }> {
  const storageIds = manifests.flatMap((manifest) => manifest.items.map((item) => item.storage_id));
  const ownsAttempt = (attemptId: string): boolean =>
    storageIds.some((storageId) => attemptId === storageId || attemptId.startsWith(`${storageId}__model_`));
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
