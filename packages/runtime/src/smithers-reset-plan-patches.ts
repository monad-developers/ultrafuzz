import type { SmithersCompatibilityPatch } from "./smithers.js";

// Keep planning beside the pinned runner's resolver: its reset policy is attempt order,
// not a traversal of the rendered dependency graph. Preview never loads a workflow.
const planHelpers = String.raw`
export async function ultrafuzzResolveResetPlan(adapter, opts) {
  const runId = opts.runId;
  const iteration = opts.iteration ?? 0;
  const run = await adapter.getRun(runId);
  if (!run) throw new Error("Reset preview requires an existing workflow run");
  const nodes = await adapter.listNodes(runId);
  const attemptsForRun = await adapter.listAttemptsForRun(runId);
  const targetNode = nodes.find((node) => node.nodeId === opts.nodeId && (node.iteration ?? 0) === iteration);
  const targetAttempt = selectAttempt(
    attemptsForRun.filter((attempt) => attempt.nodeId === opts.nodeId && (attempt.iteration ?? 0) === iteration)
      .sort((left, right) => right.attempt - left.attempt),
    opts.attempt,
  );
  if (!targetNode || !targetAttempt) throw new Error("Reset preview requires a recorded node attempt");
  const resetNodes = await resolveResetNodes({ listNodes: async () => nodes }, {
    runId, targetNode, targetAttempt, attemptsForRun, resetDependents: opts.resetDependents ?? true,
  });
  const childResetPlans = await resolveCompletedChildResetPlans(adapter, runId, resetNodes);
  const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  const generations = [];
  const addGeneration = (id, workflow, allNodes, attempts) => {
    const config = parseRunConfig(workflow);
    generations.push([id, workflow?.workflowHash ?? null, workflow?.status ?? null,
      workflow?.parentRunId ?? null, workflow?.createdAtMs ?? null,
      config?.subflowWorkspaceParentRunId ?? null, config?.continuation?.parentRunId ?? null,
      allNodes.map((node) => [node.nodeId, node.iteration ?? 0, node.state, node.lastAttempt ?? null, node.updatedAtMs,
        node.outputTable ?? null])
        .sort((left, right) => compare(JSON.stringify(left), JSON.stringify(right))),
      attempts.map((attempt) => [attempt.nodeId, attempt.iteration ?? 0, attempt.attempt, attempt.state,
        attempt.startedAtMs, attempt.finishedAtMs ?? null]),
    ]);
  };
  addGeneration(runId, run, nodes, attemptsForRun);
  for (const child of childResetPlans) {
    addGeneration(child.runId, await adapter.getRun(child.runId), await adapter.listNodes(child.runId),
      await adapter.listAttemptsForRun(child.runId));
  }
  generations.sort((left, right) => compare(left[0], right[0]));
  const publicNodes = [{ runId, nodes: resetNodes }, ...childResetPlans]
    .flatMap((group) => group.nodes.map((node) => ({
      workflow_run_id: group.runId, node_id: node.nodeId, iteration: node.iteration ?? 0,
    })))
    .sort((left, right) => compare(left.workflow_run_id, right.workflow_run_id) ||
      compare(left.node_id, right.node_id) || left.iteration - right.iteration);
  const plan = {
    schema_version: "ultrafuzz.reset-plan.v1",
    workflow_run_id: runId,
    requested_node_id: opts.nodeId,
    iteration,
    attempt: targetAttempt.attempt,
    reset_dependents: opts.resetDependents ?? true,
    policy: "attempt-order",
    node_count: publicNodes.length,
    nodes: publicNodes,
  };
  // The exact selection is part of the token, not just the rows in its runs.
  // This also binds newly eligible children and continuation successors.
  const { createHash } = await import("node:crypto");
  const generation = "sha256:" + createHash("sha256").update(JSON.stringify([plan, generations])).digest("hex");
  return { plan: { ...plan, generation }, targetAttempt, targetNode, attemptsForRun, resetNodes, childResetPlans };
}

async function ultrafuzzCopyPreviewSnapshot(databasePath) {
  const fs = (await import("node:fs")).default;
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const files = [databasePath, databasePath + "-wal", databasePath + "-journal"];
  const versions = () => files.map((file, index) => {
    try {
      const stat = fs.lstatSync(file, { bigint: true });
      if (!stat.isFile()) throw new Error("Reset preview requires regular database files");
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
    } catch (error) {
      if (index !== 0 && error?.code === "ENOENT") return null;
      throw error;
    }
  });
  const directory = fs.mkdtempSync(join(tmpdir(), "ultrafuzz-reset-preview-"));
  const snapshotPath = join(directory, "smithers.db");
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    // Never open the source with SQLite: even readonly connections can create
    // or update WAL/SHM sidecars. Copy only a stable DB + WAL/journal version;
    // the private copy recovers committed WAL data without touching source SHM.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = versions();
      for (let index = 0; index < files.length; index += 1) {
        const destination = snapshotPath + ["", "-wal", "-journal"][index];
        if (before[index] === null) fs.rmSync(destination, { force: true });
        else fs.copyFileSync(files[index], destination);
      }
      if (JSON.stringify(before) === JSON.stringify(versions())) return { snapshotPath, cleanup };
    }
    throw new Error("Reset preview database changed while taking a snapshot; retry the preview");
  } catch (error) {
    cleanup();
    throw error;
  }
}

export async function ultrafuzzPreviewReset(databasePath, opts) {
  const { Database } = await import("bun:sqlite");
  const snapshot = await ultrafuzzCopyPreviewSnapshot(databasePath);
  let db;
  try {
    // Recovery/checkpoint writes are confined to the private temporary copy.
    db = new Database(snapshot.snapshotPath, { strict: true });
    return await ultrafuzzReadPreviewSnapshot(db, opts);
  } finally {
    db?.close();
    snapshot.cleanup();
  }
}

async function ultrafuzzReadPreviewSnapshot(db, opts) {
  // Use the execution adapter's descendant, fork and continuation semantics.
  // Constructing it does not migrate tables or load a target workflow.
  const { SmithersDb } = await import("@smthrs/db/adapter");
  const adapter = new SmithersDb(db);
  // One SQLite snapshot for every read, including dynamically added nodes and child runs.
  db.exec("BEGIN");
  let iteration = opts.iteration;
  if (iteration === undefined) {
    const failed = (await adapter.listNodes(opts.runId)).filter((node) =>
      node.nodeId === opts.nodeId && (node.state === "failed" || node.state === "stalled"));
    if (failed.length > 1) throw new Error("Reset preview has multiple failed iterations; an explicit iteration is required");
    iteration = failed[0]?.iteration ?? 0;
  }
  return (await ultrafuzzResolveResetPlan(adapter, { ...opts, iteration })).plan;
}

async function ultrafuzzAssertResetGeneration(adapter, opts, generation) {
  const current = await ultrafuzzResolveResetPlan(adapter, opts);
  if ((opts.expectedGeneration !== undefined && generation !== opts.expectedGeneration) || current.plan.generation !== generation) {
    throw new Error("Reset plan generation changed; preview the reset again before resuming");
  }
}
`;

const originalChildDiscovery = `  const candidates = [];
  if (typeof adapter.listRunDescendants === "function" && typeof adapter.getRun === "function") {
    const descendants = await adapter.listRunDescendants(runId);
    for (const descendant of descendants) {
      if (descendant.runId === runId || (descendant.depth !== 1 && descendant.parentRunId !== runId)) continue;
      const child = await adapter.getRun(descendant.runId);
      if (child?.parentRunId === runId) candidates.push(child);
    }
  } else if (typeof adapter.listRuns === "function") {
    candidates.push(...(await adapter.listRuns(1_000, undefined, undefined, { parentRunId: runId })));
  }`;

const originalSelection = `  const attempts = await adapter.listAttempts(runId, nodeId, iteration);
  const targetAttempt = selectAttempt(attempts, opts.attempt);
  if (!targetAttempt) {
    return {
      success: false,
      vcsRestored: false,
      resetNodes: [],
      error: \`Attempt not found: \${runId}/\${nodeId}/\${iteration}/\${opts.attempt ?? "latest"}\`,
      effectBoundary: cleanReport,
    };
  }
  const targetAttemptNo = targetAttempt.attempt;
  const jjPointer = targetAttempt.jjPointer ?? undefined;
  const targetNode = await adapter.getNode(runId, nodeId, iteration);
  if (!targetNode) {
    return {
      success: false,
      vcsRestored: false,
      resetNodes: [],
      error: \`Node not found: \${runId}/\${nodeId}/\${iteration}\`,
      effectBoundary: cleanReport,
    };
  }
  const attemptsForRun = await adapter.listAttemptsForRun(runId);
  const resetNodes = await resolveResetNodes(adapter, {
    runId,
    targetNode,
    targetAttempt,
    attemptsForRun,
    resetDependents,
  });`;

export const SMITHERS_RESET_PLAN_PATCHES: readonly SmithersCompatibilityPatch[] = [
  {
    id: "reset_plan_child_discovery",
    packageName: "@smthrs/time-travel",
    sourceRelativePath: "src/timetravel.js",
    patchable: originalChildDiscovery,
    // This is reset closure discovery, not a paginated UI listing. Both native
    // execution and the snapshot adapter must see every eligible descendant.
    patched: originalChildDiscovery
      .replace("listRunDescendants(runId)", "listRunDescendants(runId, Number.MAX_SAFE_INTEGER)")
      .replace("listRuns(1_000,", "listRuns(Number.MAX_SAFE_INTEGER,"),
    upstreamAbsent: ["listRunDescendants(runId, Number.MAX_SAFE_INTEGER)"]
  },
  {
    id: "reset_plan_helpers",
    packageName: "@smthrs/time-travel",
    sourceRelativePath: "src/timetravel.js",
    patchable: "export async function timeTravel(adapter, opts) {",
    patched: `${planHelpers}\nexport async function timeTravel(adapter, opts) {`,
    upstreamAbsent: ["ultrafuzzResolveResetPlan", "ultrafuzzPreviewReset"]
  },
  {
    id: "reset_plan_selection",
    packageName: "@smthrs/time-travel",
    sourceRelativePath: "src/timetravel.js",
    patchable: originalSelection,
    patched: `  const resolvedReset = await ultrafuzzResolveResetPlan(adapter, opts);
  const { targetAttempt, targetNode, attemptsForRun, resetNodes } = resolvedReset;
  const targetAttemptNo = targetAttempt.attempt;
  const jjPointer = targetAttempt.jjPointer ?? undefined;
  await ultrafuzzAssertResetGeneration(adapter, opts, resolvedReset.plan.generation);`,
    upstreamAbsent: ["resolvedReset"]
  },
  {
    id: "reset_plan_children",
    packageName: "@smthrs/time-travel",
    sourceRelativePath: "src/timetravel.js",
    patchable: "    const childResetPlans = await resolveCompletedChildResetPlans(adapter, runId, resetNodes);",
    patched: "    const childResetPlans = resolvedReset.childResetPlans;",
    upstreamAbsent: ["resolvedReset.childResetPlans"]
  },
  {
    id: "reset_plan_guard",
    packageName: "@smthrs/time-travel",
    sourceRelativePath: "src/timetravel.js",
    patchable: "          const frames = yield* adapter.listFrames(runId, 1_000_000);",
    patched: `          // Check under the reset transaction before deleting any durable state.
          yield* Effect.promise(() => ultrafuzzAssertResetGeneration(adapter, opts, resolvedReset.plan.generation));
          const frames = yield* adapter.listFrames(runId, 1_000_000);`,
    upstreamAbsent: ["resolvedReset.plan.generation"]
  },
  {
    id: "reset_plan_result",
    packageName: "@smthrs/time-travel",
    sourceRelativePath: "src/timetravel.js",
    patchable: "      resetNodes: resetNodeIds,\n      effectBoundary: boundary.report,",
    patched:
      "      resetNodes: resetNodeIds,\n      resetPlan: resolvedReset.plan,\n      effectBoundary: boundary.report,",
    upstreamAbsent: ["resetPlan: resolvedReset.plan"]
  },
  {
    id: "reset_plan_cli_options",
    packageName: "@smthrs/cli",
    sourceRelativePath: "src/index.js",
    patchable: `      nodeId: z.string().describe("Task/node ID to travel back to"),
      iteration: z.number().int().default(0).describe("Loop iteration"),`,
    patched: `      nodeId: z.string().describe("Task/node ID to travel back to"),
      dryRun: z.boolean().default(false).describe("Preview the exact reset without loading the workflow"),
      expectedGeneration: z.string().optional().describe("Refuse a reset whose preview generation changed"),
      iteration: z.number().int().optional().describe("Loop iteration (default: 0; preview resolves a failed iteration)"),`,
    upstreamAbsent: ["Preview the exact reset without loading the workflow"]
  },
  {
    id: "reset_plan_cli_preview",
    packageName: "@smthrs/cli",
    sourceRelativePath: "src/index.js",
    patchable: `        const { adapter, cleanup } = await loadWorkflowDb(c.args.workflow);
        try {
          const run = await adapter.getRun(c.options.runId);
          if (!c.options.stealOwnership) {`,
    patched: `        if (c.options.dryRun) {
          const ultrafuzzPreviewReset = (await import("@smthrs/time-travel/timetravel")).ultrafuzzPreviewReset;
          const resetPlan = await ultrafuzzPreviewReset(resolve(cliWorkspace.cwd(), "smithers.db"), {
            runId: c.options.runId, nodeId: c.options.nodeId, iteration: c.options.iteration,
            attempt: c.options.attempt, resetDependents: c.options.deps,
          });
          return c.ok({ resetPlan });
        }
        const { adapter, cleanup } = await loadWorkflowDb(c.args.workflow);
        try {
          const run = await adapter.getRun(c.options.runId);
          if (!c.options.stealOwnership) {`,
    upstreamAbsent: ["ultrafuzzPreviewReset"]
  },
  {
    id: "reset_plan_cli_generation",
    packageName: "@smthrs/cli",
    sourceRelativePath: "src/index.js",
    patchable: `            resetDependents: c.options.deps,
            restoreVcs: c.options.vcs,
            force: c.options.force,
            stealOwnership: c.options.stealOwnership,
            noRevert: !c.options.revert,
            caller: "cli",
            onProgress: (e) => console.log(JSON.stringify(e)),`,
    patched: `            resetDependents: c.options.deps,
            expectedGeneration: c.options.expectedGeneration,
            restoreVcs: c.options.vcs,
            force: c.options.force,
            stealOwnership: c.options.stealOwnership,
            noRevert: !c.options.revert,
            caller: "cli",
            // A generation-checked reset returns one machine-readable receipt.
            onProgress: c.options.expectedGeneration === undefined ? (e) => console.log(JSON.stringify(e)) : undefined,`,
    upstreamAbsent: ["expectedGeneration: c.options.expectedGeneration"]
  }
];
