import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import { SMITHERS_COMPATIBILITY_PATCHES } from "../src/smithers.js";
import { temporaryRoot } from "./temporary-root.js";

interface ControllerRun {
  status: string;
  patchedModules: string[];
  eventTypes: Record<string, number>;
  attempts: Array<{ state: string; started_at_ms: number; heartbeat_at_ms: number | null }>;
}

// Rewrites every Smithers module the operator controller patches as Bun loads it,
// with the same exactly-once replacement, so a workflow runs on the engine
// Ultrafuzz ships without copying or mutating the shared package store.
const CONTROLLER_PATCH_PLUGIN = `import fs from "node:fs";
import { plugin } from "bun";

const modules = JSON.parse(fs.readFileSync(process.env.CONTROLLER_PATCHES, "utf8"));
globalThis.ultrafuzzPatchedModules = [];
plugin({
  name: "ultrafuzz-controller-patches",
  setup(build) {
    for (const { target, filter, patches } of modules) {
      build.onLoad({ filter: new RegExp(filter) }, (args) => {
        let source = fs.readFileSync(args.path, "utf8");
        for (const [id, patchable, patched] of patches) {
          if (source.split(patchable).length !== 2) throw new Error(id + " does not anchor exactly once");
          source = source.replace(patchable, patched);
        }
        globalThis.ultrafuzzPatchedModules.push(target);
        return { contents: source, loader: "js" };
      });
    }
  }
});
`;

function runOnControllerEngine(root: string, workflow: string, env: Record<string, string> = {}): ControllerRun {
  const modules = new Map<string, Array<[string, string, string]>>();
  for (const patch of SMITHERS_COMPATIBILITY_PATCHES) {
    const target = `${patch.packageName}/${patch.sourceRelativePath}`;
    modules.set(target, [...(modules.get(target) ?? []), [patch.id, patch.patchable, patch.patched]]);
  }
  fs.writeFileSync(
    path.join(root, "controller-patches.json"),
    JSON.stringify(
      [...modules].map(([target, patches]) => ({
        target,
        filter: `/${target.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`,
        patches
      }))
    )
  );
  fs.writeFileSync(path.join(root, "controller-patches.mjs"), CONTROLLER_PATCH_PLUGIN);
  const runner = createRequire(import.meta.url).resolve("smthrs");
  fs.symlinkSync(path.dirname(path.dirname(path.dirname(runner))), path.join(root, "node_modules"), "dir");
  fs.writeFileSync(
    path.join(root, "workflow.mjs"),
    `import { spawn } from "node:child_process";
import fs from "node:fs";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import React from "react";
import { createSmithers, runWorkflow } from "smthrs";
import { z } from "zod/v4";

const h = React.createElement;
const { Workflow, Worktree, Task, smithers, outputs } = createSmithers(
  { result: z.object({ value: z.string() }) },
  { dbPath: "smithers.db" }
);
${workflow}
const run = await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "controller-engine", rootDir: process.cwd() }));
const db = new Database("smithers.db", { readonly: true });
const eventTypes = Object.fromEntries(
  db.query("SELECT type, count(*) AS n FROM _smithers_events GROUP BY type").all().map((row) => [row.type, row.n])
);
const attempts = db.query("SELECT state, started_at_ms, heartbeat_at_ms FROM _smithers_attempts").all();
fs.writeFileSync("result.json", JSON.stringify({ status: run.status, patchedModules: globalThis.ultrafuzzPatchedModules, eventTypes, attempts }));
process.exit(0);
`
  );
  const result = spawnSync("bun", ["--preload", "./controller-patches.mjs", "./workflow.mjs"], {
    cwd: root,
    env: { ...process.env, ...env, CONTROLLER_PATCHES: path.join(root, "controller-patches.json") },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000
  });
  const output = [result.error, result.stdout, result.stderr].map((part) => String(part ?? "").slice(-4_000));
  assert.equal(result.status, 0, output.join("\n"));
  const run = JSON.parse(fs.readFileSync(path.join(root, "result.json"), "utf8")) as ControllerRun;
  assert.ok(run.patchedModules.includes("@smthrs/engine/src/engine.js"), "the engine was not patched");
  return run;
}

// #1147: each successful attempt-row heartbeat write also appended a TaskHeartbeat
// event row and stream.ndjson line. This agent is quiet, so only the throttled
// liveness pulse keeps it live, through the fenced attempt-row write that the
// heartbeat timeout and `smithers why` depend on.
test("controller agent tasks stay live on their attempt row without a TaskHeartbeat event per pulse", () => {
  const root = temporaryRoot("ufz-controller-heartbeat-");
  const run = runOnControllerEngine(
    root,
    `const agent = {
  id: "sleeping-agent",
  async generate(options) {
    const child = spawn("sleep", ["3.5"], { stdio: "ignore" });
    options.onProcess?.({ phase: "started", pid: child.pid });
    const exitCode = await new Promise((resolve) => child.on("exit", resolve));
    options.onProcess?.({ phase: "exited", pid: child.pid, exitCode });
    return { text: JSON.stringify({ value: "done" }) };
  }
};
const workflow = smithers(() =>
  h(Workflow, { name: "heartbeat" },
    h(Task, { id: "agent", output: outputs.result, agent, heartbeatTimeoutMs: 3_000, retries: 0 }, "work")));`
  );

  // The agent outlived its 3s heartbeat timeout, so the fenced write kept it live.
  assert.equal(run.status, "finished");
  assert.equal(run.eventTypes.TaskHeartbeat ?? 0, 0, JSON.stringify(run.eventTypes));
  const [attempt, ...others] = run.attempts;
  assert.ok(attempt !== undefined && others.length === 0, JSON.stringify(run.attempts));
  assert.ok(
    attempt.heartbeat_at_ms !== null && attempt.heartbeat_at_ms - attempt.started_at_ms >= 2_000,
    `the attempt row stopped recording liveness: ${JSON.stringify(attempt)}`
  );
});
