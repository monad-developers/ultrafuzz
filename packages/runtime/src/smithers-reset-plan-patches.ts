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
    generations.push([id, workflow?.workflowHash ?? null,
      allNodes.map((node) => [node.nodeId, node.iteration ?? 0, node.state, node.lastAttempt ?? null, node.updatedAtMs])
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
  const { createHash } = await import("node:crypto");
  const generation = "sha256:" + createHash("sha256").update(JSON.stringify(generations)).digest("hex");
  const publicNodes = [{ runId, nodes: resetNodes }, ...childResetPlans]
    .flatMap((group) => group.nodes.map((node) => ({
      workflow_run_id: group.runId, node_id: node.nodeId, iteration: node.iteration ?? 0,
    })))
    .sort((left, right) => compare(left.workflow_run_id, right.workflow_run_id) ||
      compare(left.node_id, right.node_id) || left.iteration - right.iteration);
  const plan = {
    schema_version: "ultrafuzz.reset-plan.v1",
    workflow_run_id: runId,
    generation,
    requested_node_id: opts.nodeId,
    iteration,
    attempt: targetAttempt.attempt,
    reset_dependents: opts.resetDependents ?? true,
    policy: "attempt-order",
    node_count: publicNodes.length,
    nodes: publicNodes,
  };
  return { plan, targetAttempt, targetNode, attemptsForRun, resetNodes, childResetPlans };
}

export async function ultrafuzzPreviewReset(databasePath, opts) {
  const { Database } = await import("bun:sqlite");
  const db = new Database(databasePath, { readonly: true, strict: true });
  const rows = (sql, args) => db.query(sql).all(...args).map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]),
  ));
  const adapter = {
    getRun: async (id) => rows("SELECT * FROM _smithers_runs WHERE run_id = ?", [id])[0],
    listNodes: async (id) => rows("SELECT * FROM _smithers_nodes WHERE run_id = ? ORDER BY rowid ASC", [id]),
    listAttemptsForRun: async (id) => rows("SELECT * FROM _smithers_attempts WHERE run_id = ? ORDER BY started_at_ms ASC, node_id ASC, iteration ASC, attempt ASC", [id]),
    listRuns: async (_limit, _status, _workflow, options) => rows("SELECT * FROM _smithers_runs WHERE parent_run_id = ?", [options.parentRunId]),
  };
  try {
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
  } finally {
    db.close();
  }
}

async function ultrafuzzAssertResetGeneration(adapter, opts, generation) {
  if (opts.expectedGeneration === undefined) return;
  const current = await ultrafuzzResolveResetPlan(adapter, opts);
  if (generation !== opts.expectedGeneration || current.plan.generation !== generation) {
    throw new Error("Reset plan generation changed; preview the reset again before resuming");
  }
}
`;

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
          const { ultrafuzzPreviewReset } = await import("@smthrs/time-travel/timetravel");
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
