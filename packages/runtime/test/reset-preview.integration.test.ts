import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import { resumeRun } from "../src/start-run.js";
import { parseResetPlan } from "../src/reset-plan.js";
import { previewSmithersReset, runSmithersLifecycleCommand } from "../src/smithers.js";
import type { ResetPlan } from "../src/types.js";
import { temporaryRoot } from "./temporary-root.js";

const runner = createRequire(import.meta.url).resolve("smthrs/bin/smithers");
const runnerRequire = createRequire(runner);
const timeTravelModule = runnerRequire.resolve("@smthrs/time-travel/timetravel");
const rootRunId = "reset-preview-example";

// Real dynamic render: seed publishes two children, and both feed a verifier.
// An earlier independent node must survive a reset of either producer.
function campaign() {
  const root = temporaryRoot("ufz-reset-preview-");
  const workflow = path.join(root, ".smithers", "workflows", "preview.tsx");
  fs.mkdirSync(path.dirname(workflow), { recursive: true });
  fs.symlinkSync(
    path.dirname(path.dirname(path.dirname(path.dirname(runner)))),
    path.join(root, ".smithers", "node_modules"),
    "dir"
  );
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root });
  fs.writeFileSync(
    workflow,
    `/** @jsxImportSource smthrs */
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
const { Workflow, Sequence, Parallel, Task, smithers, outputs } = createSmithers({
  input: z.object({}), result: z.object({ value: z.string() })
});
export default smithers((ctx) => {
  const expanded = ctx.outputMaybe("result", { nodeId: "node:seed" });
  return <Workflow name="preview"><Sequence>
    <Task id="independent" output={outputs.result}>{() => ({ value: "before" })}</Task>
    <Task id="node:seed" output={outputs.result}>{() => ({ value: "expanded" })}</Task>
    {expanded ? <Sequence>
      <Parallel>{["one", "two"].map((id) => <Task key={id} id={"node:dynamic-" + id} output={outputs.result}>
        {() => ({ value: id })}
      </Task>)}</Parallel>
      <Task id="verify:dynamic" output={outputs.result}>{() => ({ value: "verified" })}</Task>
      <Task id="node:downstream" output={outputs.result}>{() => ({ value: "done" })}</Task>
    </Sequence> : null}
  </Sequence></Workflow>;
});
`
  );
  const run = (args: string[]) => {
    const result = spawnSync("bun", [runner, ...args, "--format", "json", "--full-output"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, SMITHERS_POST_FAILURE: "0", SMITHERS_MONITOR_SUPPRESS: "1" },
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  // Foreground execution completes before the read-only snapshot assertions.
  run(["up", workflow, "--run-id", rootRunId, "--root", root, "--input", "{}"]);
  const runRoot = path.join(root, ".ultrafuzz", "runs", "preview");
  fs.mkdirSync(path.join(runRoot, "smithers"), { recursive: true });
  fs.writeFileSync(
    path.join(runRoot, "run.json"),
    JSON.stringify({ run_id: "preview", workflow: { run_id: rootRunId } })
  );
  return { root, workflow, run, runRoot };
}

function snapshotTree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(directory: string) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        result[path.relative(root, file) + "/"] = "directory";
        walk(file);
      } else
        result[path.relative(root, file)] = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    }
  }
  walk(root);
  return result;
}

function payload(output: string): { resetPlan: ResetPlan; resetNodes?: string[] } {
  const lines = output.trim().split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    try {
      const value = JSON.parse(lines.slice(index).join("\n")) as {
        ok?: boolean;
        data?: { resetPlan: ResetPlan; resetNodes?: string[] };
      };
      if (value.ok === true && value.data?.resetPlan !== undefined) return value.data;
    } catch {
      /* Progress records precede the final envelope. */
    }
  }
  throw new Error("No reset plan in runner output: " + output);
}

test("dynamic reset preview is deterministic, read-only, and execution reports the exact closure", async () => {
  const fixture = campaign();
  const before = snapshotTree(fixture.root);
  const first = await resumeRun({
    projectRoot: fixture.root,
    runId: "preview",
    resetNode: "node:seed",
    dryRun: true,
    refreshController: true
  });
  assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
  const plan = first.value?.reset_plan;
  assert.ok(plan);
  assert.equal(first.value?.submitted, false);
  assert.equal(first.value?.dry_run, true);
  assert.deepEqual(
    plan.nodes.map((node) => node.node_id),
    ["node:downstream", "node:dynamic-one", "node:dynamic-two", "node:seed", "verify:dynamic"]
  );
  const again = await previewSmithersReset({
    projectRoot: fixture.root,
    smithersRunId: rootRunId,
    nodeId: "node:seed"
  });
  assert.deepEqual(again, plan);
  const unknown = await resumeRun({
    projectRoot: fixture.root,
    runId: "preview",
    resetNode: "node:missing",
    dryRun: true
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.value, undefined);
  assert.deepEqual(
    snapshotTree(fixture.root),
    before,
    "preview must not write run state, locks, archives, prompts, or the database"
  );
  const executed = payload(
    fixture.run([
      "timetravel",
      fixture.workflow,
      "--run-id",
      rootRunId,
      "--node-id",
      "node:seed",
      "--no-vcs",
      "--force",
      "--expected-generation",
      plan.generation
    ])
  );
  assert.deepEqual(executed.resetPlan, plan);
  assert.deepEqual(
    executed.resetNodes?.sort(),
    plan.nodes.map((node) => node.node_id)
  );
  assert.doesNotMatch(JSON.stringify(first.value), /expanded|verified|\.tsx|result|smithers\.db/u);
});

test("verifier-only retry preserves producers and reports the node-only reset", () => {
  const fixture = campaign();
  const targeted = payload(
    fixture.run(["timetravel", fixture.workflow, "--run-id", rootRunId, "--node-id", "verify:dynamic", "--dry-run"])
  ).resetPlan;
  assert.deepEqual(
    targeted.nodes.map((node) => node.node_id),
    ["node:downstream", "verify:dynamic"]
  );
  const options = ["timetravel", fixture.workflow, "--run-id", rootRunId, "--node-id", "verify:dynamic", "--no-deps"];
  const preview = payload(fixture.run([...options, "--dry-run"])).resetPlan;
  assert.deepEqual(
    preview.nodes.map((node) => node.node_id),
    ["verify:dynamic"]
  );
  assert.equal(preview.reset_dependents, false);
  const result = payload(fixture.run([...options, "--no-vcs", "--force", "--expected-generation", preview.generation]));
  assert.deepEqual(result.resetPlan, preview);
  assert.deepEqual(result.resetNodes, ["verify:dynamic"]);
});

test("preview resolves a failed nonzero iteration instead of silently planning iteration zero", async () => {
  const fixture = campaign();
  execFileSync(
    "bun",
    [
      "-e",
      `import { Database } from "bun:sqlite";
    const db = new Database("smithers.db");
    db.query("UPDATE _smithers_nodes SET iteration = 3, state = 'failed' WHERE run_id = ? AND node_id = ?").run(${JSON.stringify(rootRunId)}, "node:seed");
    db.query("UPDATE _smithers_attempts SET iteration = 3, state = 'failed' WHERE run_id = ? AND node_id = ?").run(${JSON.stringify(rootRunId)}, "node:seed");
    db.close();`
    ],
    { cwd: fixture.root }
  );
  const plan = await previewSmithersReset({ projectRoot: fixture.root, smithersRunId: rootRunId, nodeId: "node:seed" });
  assert.equal(plan.iteration, 3);
  assert.ok(plan.nodes.some((node) => node.node_id === "node:seed" && node.iteration === 3));
  const executed = payload(
    fixture.run([
      "timetravel",
      fixture.workflow,
      "--run-id",
      rootRunId,
      "--node-id",
      "node:seed",
      "--iteration",
      "3",
      "--no-vcs",
      "--force",
      "--expected-generation",
      plan.generation
    ])
  );
  assert.deepEqual(executed.resetPlan, plan);
});

test("native targeted resume returns the reset plan and clears its receipt after controller admission", async () => {
  const fixture = campaign();
  const plan = await previewSmithersReset({ projectRoot: fixture.root, smithersRunId: rootRunId, nodeId: "node:seed" });
  const result = await runSmithersLifecycleCommand({
    action: "resume",
    projectRoot: fixture.root,
    smithersRunId: rootRunId,
    workflowPath: fixture.workflow,
    resetNode: "node:seed",
    resetGeneration: plan.generation,
    controllerLeaseSeconds: 30,
    relaunchPaths: { runRoot: fixture.runRoot, logsDir: path.join(fixture.runRoot, "smithers", "logs") }
  });
  assert.deepEqual(result.resetPlan, plan);
  assert.equal(result.resetAlreadyApplied, false);
  assert.equal(fs.existsSync(path.join(fixture.runRoot, "smithers", "reset-node-applied.json")), false);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const inspected = JSON.parse(fixture.run(["inspect", rootRunId])) as { data: { run: { status: string } } };
    if (inspected.data.run.status === "finished") return;
    assert.notEqual(inspected.data.run.status, "failed");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("continued workflow did not finish");
});

function childRunScript(workflow: string): string {
  return `import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Database } from "bun:sqlite";
const require = createRequire(${JSON.stringify(runner)});
const { SmithersDb } = await import(require.resolve("@smthrs/db/adapter"));
const { ultrafuzzPreviewReset, ultrafuzzResolveResetPlan, timeTravel } = await import(${JSON.stringify(timeTravelModule)});
const workflow = (await import(${JSON.stringify(workflow)})).default;
const adapter = new SmithersDb(workflow.db);
const db = new Database("smithers.db");
const opts = { runId: ${JSON.stringify(rootRunId)}, nodeId: "node:seed", restoreVcs: false, force: true };
const parent = db.query("SELECT * FROM _smithers_runs WHERE run_id = ?").get(opts.runId);
const node = db.query("SELECT * FROM _smithers_nodes WHERE run_id = ? AND node_id = ?").get(opts.runId, opts.nodeId);
const attempt = db.query("SELECT * FROM _smithers_attempts WHERE run_id = ? AND node_id = ?").get(opts.runId, opts.nodeId);
const insert = (table, row) => {
  const keys = Object.keys(row);
  db.query("INSERT INTO " + table + " (" + keys.join(",") + ") VALUES (" + keys.map(() => "?").join(",") + ")")
    .run(...Object.values(row));
};
const child = (runId, parentId = opts.runId, config = { subflowWorkspaceParentRunId: parentId }, branch) => {
  insert("_smithers_runs", { ...parent, run_id: runId, parent_run_id: parentId, config_json: JSON.stringify(config), status: "finished" });
  insert("_smithers_nodes", { ...node, run_id: runId });
  insert("_smithers_attempts", { ...attempt, run_id: runId });
  if (branch !== undefined) insert("_smithers_branches", {
    run_id: runId, parent_run_id: parentId, parent_frame_no: 0, branch_label: branch, created_at_ms: 1
  });
};
`;
}

test("ordinary targeted resume resets every owned child beyond the native descendant listing limit", async () => {
  const fixture = campaign();
  const script = `${childRunScript(fixture.workflow)}
db.exec("BEGIN IMMEDIATE");
for (let index = 0; index < 1001; index += 1) child("explicit-subflow-" + String(index).padStart(4, "0"));
db.exec("COMMIT");
assert.equal((await adapter.listRunDescendants(opts.runId)).length, 1000, "fixture exceeds the native listing default");
const preview = await ultrafuzzPreviewReset("smithers.db", opts);
const native = (await ultrafuzzResolveResetPlan(adapter, opts)).plan;
assert.equal(preview.node_count, 1006, "all 1001 children and five parent nodes are included");
assert.deepEqual(native, preview);
assert.deepEqual(await ultrafuzzPreviewReset("smithers.db", opts), preview);
console.log(JSON.stringify(preview));
process.exit(0);`;
  const output = execFileSync("bun", ["-e", script], { cwd: fixture.root, encoding: "utf8", timeout: 60_000 });
  const plan = parseResetPlan(JSON.parse(output), rootRunId, "node:seed");
  const before = snapshotTree(fixture.root);
  assert.deepEqual(
    await previewSmithersReset({ projectRoot: fixture.root, smithersRunId: rootRunId, nodeId: "node:seed" }),
    plan
  );
  assert.deepEqual(snapshotTree(fixture.root), before);
  // No explicit generation: ordinary targeted resume previews and executes its own token.
  const result = await runSmithersLifecycleCommand({
    action: "resume",
    projectRoot: fixture.root,
    smithersRunId: rootRunId,
    workflowPath: fixture.workflow,
    resetNode: "node:seed",
    controllerLeaseSeconds: 30,
    relaunchPaths: { runRoot: fixture.runRoot, logsDir: path.join(fixture.runRoot, "smithers", "logs") }
  });
  assert.deepEqual(result.resetPlan, plan);
  assert.equal(result.resetAlreadyApplied, false);
  assert.equal(fs.existsSync(path.join(fixture.runRoot, "smithers", "reset-node-applied.json")), false);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const inspected = JSON.parse(fixture.run(["inspect", rootRunId])) as { data: { run: { status: string } } };
    assert.notEqual(inspected.data.run.status, "failed");
    if (inspected.data.run.status === "finished") break;
    assert.notEqual(attempt, 99, "continued workflow did not finish");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  execFileSync(
    "bun",
    [
      "-e",
      `import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
const db = new Database("smithers.db", { readonly: true });
for (const [table, state] of [["_smithers_nodes", "pending"], ["_smithers_attempts", "cancelled"]]) {
  const rows = db.query("SELECT state FROM " + table + " WHERE run_id LIKE 'explicit-subflow-%'").all();
  assert.equal(rows.length, 1001);
  assert.ok(rows.every((row) => row.state === state), "every child is reset, including those beyond row 1000");
}
db.close();`
    ],
    { cwd: fixture.root, encoding: "utf8", timeout: 30_000 }
  );
});

test("preview and native reset share fork exclusions and continuation-successor discovery", () => {
  const fixture = campaign();
  const script = `${childRunScript(fixture.workflow)}
child("explicit-child");
child("forked-child", opts.runId, { subflowWorkspaceParentRunId: opts.runId }, "fork");
child("unlabelled-fork", opts.runId, { subflowWorkspaceParentRunId: opts.runId }, null);
child("continued-child", "explicit-child", { continuation: { parentRunId: "explicit-child" } }, "continue-as-new");
child("newer-fork", "explicit-child", { continuation: { parentRunId: "explicit-child" } }, "fork");
db.query("UPDATE _smithers_runs SET created_at_ms = created_at_ms + 1 WHERE run_id = 'newer-fork'").run();
const preview = await ultrafuzzPreviewReset("smithers.db", opts);
assert.deepEqual((await ultrafuzzResolveResetPlan(adapter, opts)).plan, preview);
assert.equal(preview.node_count, 7);
assert.deepEqual(preview.nodes.filter((node) => node.workflow_run_id !== opts.runId).map((node) => node.workflow_run_id),
  ["continued-child", "explicit-child"]);
const result = await timeTravel(adapter, { ...opts, expectedGeneration: preview.generation });
assert.equal(result.success, true);
assert.deepEqual(result.resetPlan, preview);
for (const id of ["explicit-child", "continued-child"]) {
  assert.equal((await adapter.getNode(id, opts.nodeId, 0)).state, "pending");
}
for (const id of ["forked-child", "unlabelled-fork", "newer-fork"]) {
  assert.equal((await adapter.getNode(id, opts.nodeId, 0)).state, "finished");
}
process.exit(0);`;
  const result = spawnSync("bun", ["-e", script], { cwd: fixture.root, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("a generation race refuses a stale plan before resetting a node", async () => {
  const fixture = campaign();
  const plan = await previewSmithersReset({ projectRoot: fixture.root, smithersRunId: rootRunId, nodeId: "node:seed" });
  execFileSync(
    "bun",
    [
      "-e",
      `import { Database } from "bun:sqlite";
    const db = new Database("smithers.db");
    db.query("UPDATE _smithers_nodes SET updated_at_ms = updated_at_ms + 1 WHERE run_id = ? AND node_id = ?").run(${JSON.stringify(rootRunId)}, "node:dynamic-one");
    db.close();`
    ],
    { cwd: fixture.root }
  );
  const before = snapshotTree(fixture.runRoot);
  const stale = await resumeRun({
    projectRoot: fixture.root,
    runId: "preview",
    resetNode: "node:seed",
    resetGeneration: plan.generation
  });
  assert.equal(stale.ok, false);
  assert.match(stale.diagnostics[0]?.message ?? "", /generation changed/u);
  assert.deepEqual(snapshotTree(fixture.runRoot), before);
  const recomputed = await previewSmithersReset({
    projectRoot: fixture.root,
    smithersRunId: rootRunId,
    nodeId: "node:seed"
  });
  assert.notEqual(recomputed.generation, plan.generation);
  assert.deepEqual(recomputed.nodes, plan.nodes);
});

test("the reset transaction rejects a race after effect processing and before node mutation", () => {
  const fixture = campaign();
  const script = `import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(${JSON.stringify(runner)});
const { SmithersDb } = await import(require.resolve("@smthrs/db/adapter"));
const { ultrafuzzResolveResetPlan, timeTravel } = await import(${JSON.stringify(timeTravelModule)});
const workflow = (await import(${JSON.stringify(fixture.workflow)})).default;
const adapter = new SmithersDb(workflow.db);
const opts = { runId: ${JSON.stringify(rootRunId)}, nodeId: "node:seed", restoreVcs: false, force: true };
const { plan } = await ultrafuzzResolveResetPlan(adapter, opts);
await assert.rejects(timeTravel(adapter, { ...opts, expectedGeneration: plan.generation, hooks: {
  afterEffectReverts: async () => {
    const node = await adapter.getNode(opts.runId, "node:dynamic-one", 0);
    await adapter.insertNode({ ...node, updatedAtMs: node.updatedAtMs + 1 });
  }
}}), /generation changed/);
assert.equal((await adapter.getNode(opts.runId, "node:seed", 0)).state, "finished");
assert.equal((await adapter.getNode(opts.runId, "node:downstream", 0)).state, "finished");
process.exit(0);`;
  const result = spawnSync("bun", ["-e", script], { cwd: fixture.root, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("child status and lineage bind the closure, and the transactional guard rejects stale selections", () => {
  const fixture = campaign();
  const script = `import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Database } from "bun:sqlite";
const require = createRequire(${JSON.stringify(runner)});
const { SmithersDb } = await import(require.resolve("@smthrs/db/adapter"));
const { ultrafuzzPreviewReset, ultrafuzzResolveResetPlan, timeTravel } = await import(${JSON.stringify(timeTravelModule)});
const workflow = (await import(${JSON.stringify(fixture.workflow)})).default;
const adapter = new SmithersDb(workflow.db);
const db = new Database("smithers.db");
db.exec("PRAGMA busy_timeout = 1");
const opts = { runId: ${JSON.stringify(rootRunId)}, nodeId: "node:seed", restoreVcs: false, force: true };
const childId = opts.runId + ":child:node:seed:0";
const insert = (table, row) => {
  const keys = Object.keys(row);
  db.query("INSERT INTO " + table + " (" + keys.join(",") + ") VALUES (" + keys.map(() => "?").join(",") + ")")
    .run(...Object.values(row));
};
const root = db.query("SELECT * FROM _smithers_runs WHERE run_id = ?").get(opts.runId);
insert("_smithers_runs", { ...root, run_id: childId, parent_run_id: opts.runId, config_json: "{}", status: "paused" });
for (const [id, state] of [["child-done", "finished"], ["child-work", "pending"]]) {
  for (const table of ["_smithers_nodes", "_smithers_attempts"]) {
    const row = db.query("SELECT * FROM " + table + " WHERE run_id = ? AND node_id = ?").get(opts.runId, opts.nodeId);
    insert(table, { ...row, run_id: childId, node_id: id, state });
  }
}
const preview = () => ultrafuzzPreviewReset("smithers.db", opts);
const paused = await preview();
assert.deepEqual((await ultrafuzzResolveResetPlan(adapter, opts)).plan, paused);
assert.equal(paused.nodes.filter((node) => node.workflow_run_id === childId).length, 1);
const nodeOnly = await ultrafuzzPreviewReset("smithers.db", { ...opts, resetDependents: false });
assert.notEqual(nodeOnly.generation, paused.generation, "generation binds the requested selection");
db.query("UPDATE _smithers_runs SET status = 'continued' WHERE run_id = ?").run(childId);
const continued = await preview();
assert.notEqual(continued.generation, paused.generation);
assert.equal(continued.node_count, paused.node_count + 1);
const persisted = () => ["_smithers_nodes", "_smithers_attempts", "_smithers_frames"].map((table) =>
  db.query("SELECT * FROM " + table + " ORDER BY rowid").all());
const before = persisted();
await assert.rejects(timeTravel(adapter, { ...opts, expectedGeneration: paused.generation }), /generation changed/);
assert.deepEqual(persisted(), before);
db.query("UPDATE _smithers_runs SET parent_run_id = 'different-parent' WHERE run_id = ?").run(childId);
const detached = await preview();
assert.notEqual(detached.generation, continued.generation);
assert.equal(detached.nodes.some((node) => node.workflow_run_id === childId), false);
db.query("UPDATE _smithers_runs SET parent_run_id = ?, status = 'running' WHERE run_id = ?").run(opts.runId, childId);
const running = await preview();
db.query("UPDATE _smithers_runs SET status = 'finished' WHERE run_id = ?").run(childId);
const finished = await preview();
assert.notEqual(running.generation, finished.generation, "newly eligible children change the generation");
assert.equal(finished.node_count, running.node_count + 2);
for (const checked of [true, false]) {
  db.query("UPDATE _smithers_runs SET status = 'paused' WHERE run_id = ?").run(childId);
  const plan = await preview();
  await assert.rejects(timeTravel(adapter, {
    ...opts, ...(checked ? { expectedGeneration: plan.generation } : {}),
    hooks: { afterEffectReverts: async () => { await adapter.updateRun(childId, { status: "continued" }); } }
  }), /generation changed/);
  assert.deepEqual(persisted(), before, "a rejected race cannot reset nodes/attempts or truncate frames");
}
let sawTransaction = false;
const originalListNodes = adapter.listNodes.bind(adapter);
adapter.listNodes = (id) => {
  if (adapter.ownsActiveTransaction() && !sawTransaction) {
    sawTransaction = true;
    assert.throws(() => db.query("UPDATE _smithers_runs SET status = 'paused' WHERE run_id = ?").run(childId), /locked|busy/i);
  }
  return originalListNodes(id);
};
const current = await preview();
const result = await timeTravel(adapter, { ...opts, expectedGeneration: current.generation });
assert.equal(result.success, true);
assert.deepEqual(result.resetPlan, current);
assert.equal(sawTransaction, true, "generation reads execute inside the write transaction");
assert.equal((await adapter.getNode(childId, "child-done", 0)).state, "pending");
process.exit(0);`;
  const result = spawnSync("bun", ["-e", script], { cwd: fixture.root, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("preview preserves absent sidecars, source SHM and committed WAL-only graph changes", () => {
  const fixture = campaign();
  const offline = path.join(fixture.root, "offline");
  fs.mkdirSync(offline);
  const script = `import assert from "node:assert/strict";
import fs from "node:fs";
import { Database } from "bun:sqlite";
const { ultrafuzzPreviewReset } = await import(${JSON.stringify(timeTravelModule)});
const opts = { runId: ${JSON.stringify(rootRunId)}, nodeId: "node:seed" };
const db = new Database("smithers.db");
db.exec("PRAGMA wal_autocheckpoint = 0");
db.query("PRAGMA wal_checkpoint(TRUNCATE)").all();
const offlineDb = "offline/smithers.db";
fs.copyFileSync("smithers.db", offlineDb);
const bytes = fs.readFileSync(offlineDb);
const original = await ultrafuzzPreviewReset(offlineDb, opts);
assert.deepEqual(fs.readdirSync("offline"), ["smithers.db"]);
assert.deepEqual(fs.readFileSync(offlineDb), bytes);
fs.writeFileSync("offline/sentinel", Buffer.alloc(32768, 0x5a));
fs.symlinkSync("sentinel", offlineDb + "-shm");
const sentinel = fs.readFileSync("offline/sentinel");
assert.deepEqual(await ultrafuzzPreviewReset(offlineDb, opts), original);
assert.deepEqual(fs.readFileSync("offline/sentinel"), sentinel);
assert.deepEqual(fs.readdirSync("offline").sort(), ["sentinel", "smithers.db", "smithers.db-shm"]);
const baseBytes = fs.readFileSync("smithers.db");
db.query("INSERT INTO _smithers_nodes SELECT run_id, 'wal-only-child', 2, state, last_attempt, updated_at_ms, output_table, label FROM _smithers_nodes WHERE run_id = ? AND node_id = ?")
  .run(opts.runId, opts.nodeId);
assert.deepEqual(fs.readFileSync("smithers.db"), baseBytes, "new node is committed only in WAL");
assert.ok(fs.statSync("smithers.db-wal").size > 0);
const files = ["smithers.db", "smithers.db-wal", "smithers.db-shm"];
const before = files.map((file) => fs.readFileSync(file));
const current = await ultrafuzzPreviewReset("smithers.db", opts);
assert.equal(current.nodes.some((node) => node.node_id === "wal-only-child"), true);
assert.notEqual(current.generation, original.generation);
assert.deepEqual(files.map((file) => fs.readFileSync(file)), before);
await assert.rejects(ultrafuzzPreviewReset("offline/absent.db", opts));
assert.equal(fs.existsSync("offline/absent.db"), false);
process.exit(0);`;
  const result = spawnSync("bun", ["-e", script], { cwd: fixture.root, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("preview retries a database-copy race and refuses a continuously changing snapshot", () => {
  const fixture = campaign();
  const script = `import assert from "node:assert/strict";
import fs from "node:fs";
import { Database } from "bun:sqlite";
const { ultrafuzzPreviewReset } = await import(${JSON.stringify(timeTravelModule)});
const opts = { runId: ${JSON.stringify(rootRunId)}, nodeId: "node:seed" };
const db = new Database("smithers.db");
const original = await ultrafuzzPreviewReset("smithers.db", opts);
const copy = fs.copyFileSync;
let copies = 0;
let continuous = false;
fs.copyFileSync = (source, destination, ...args) => {
  copy(source, destination, ...args);
  if (source === "smithers.db") {
    copies += 1;
    if (copies === 1 || continuous) {
      db.query("UPDATE _smithers_nodes SET updated_at_ms = updated_at_ms + 1 WHERE run_id = ? AND node_id = ?")
        .run(opts.runId, opts.nodeId);
    }
  }
};
try {
  const current = await ultrafuzzPreviewReset("smithers.db", opts);
  assert.ok(copies >= 2, "the source change must invalidate the first copied snapshot");
  assert.notEqual(current.generation, original.generation);
  assert.deepEqual(current, await ultrafuzzPreviewReset("smithers.db", opts));
  continuous = true;
  await assert.rejects(ultrafuzzPreviewReset("smithers.db", opts), /changed while taking a snapshot/);
} finally { fs.copyFileSync = copy; }
process.exit(0);`;
  const result = spawnSync("bun", ["-e", script], { cwd: fixture.root, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("invalid preview options fail before opening any project or launching a runner", async () => {
  const root = temporaryRoot("ufz-reset-options-");
  for (const options of [
    { dryRun: true },
    { dryRun: true, resetNode: "node:x", retryFailed: true },
    { resetGeneration: "bad" }
  ]) {
    const result = await resumeRun({ projectRoot: root, runId: "preview", ...options });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics[0]?.code, "WORKFLOW_RESET_PREVIEW_OPTIONS");
  }
  assert.deepEqual(fs.readdirSync(root), []);
});

test("reset plan parsing rejects missing, duplicate, or substituted node identities", () => {
  const fixture = campaign();
  const plan = payload(
    fixture.run(["timetravel", "not-loaded", "--run-id", rootRunId, "--node-id", "node:seed", "--dry-run"])
  ).resetPlan;
  assert.throws(() => parseResetPlan({ ...plan, nodes: [], node_count: 0 }, rootRunId, "node:seed"));
  assert.throws(() =>
    parseResetPlan({ ...plan, nodes: [plan.nodes[0], plan.nodes[0]], node_count: 2 }, rootRunId, "node:seed")
  );
  assert.throws(() => parseResetPlan(plan, "different", "node:seed"));
  assert.throws(() => parseResetPlan({ ...plan, generation: "not-a-generation" }, rootRunId, "node:seed"));
});
