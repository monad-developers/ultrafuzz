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
      // SQLite readers update shared-memory read marks, never the DB or WAL contents.
      if (entry.name === "smithers.db-shm") continue;
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
