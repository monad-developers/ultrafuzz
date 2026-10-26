import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

import { temporaryRoot } from "./temporary-root.js";

interface ControllerRun {
  status: string;
  eventTypes: Record<string, number>;
  attempts: Array<{
    state: string;
    started_at_ms: number;
    heartbeat_at_ms: number | null;
    error_json: string | null;
    meta_json: string | null;
  }>;
}

// Runs a workflow on the engine Ultrafuzz ships: the repository install, which
// pnpm has already patched with every Smithers compatibility patch.
function runOnControllerEngine(root: string, workflow: string, env: Record<string, string> = {}): ControllerRun {
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
const attempts = db.query("SELECT state, started_at_ms, heartbeat_at_ms, error_json, meta_json FROM _smithers_attempts").all();
fs.writeFileSync("result.json", JSON.stringify({ status: run.status, eventTypes, attempts }));
process.exit(0);
`
  );
  const result = spawnSync("bun", [path.join(root, "workflow.mjs")], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000
  });
  const output = [result.error, result.stdout, result.stderr].map((part) => String(part ?? "").slice(-4_000));
  assert.equal(result.status, 0, output.join("\n"));
  return JSON.parse(fs.readFileSync(path.join(root, "result.json"), "utf8")) as ControllerRun;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("controller persists a missing generated validator as TOOL_UNAVAILABLE without retrying preparation", () => {
  const root = temporaryRoot("ufz-controller-missing-validator-");
  const source = fs.readFileSync(
    fileURLToPath(new URL("../../src/templates/smithers/workflows/workflow.tsx", import.meta.url)),
    "utf8"
  );
  const helpers = (
    [
      ["const JSON_VALIDATOR_PREFLIGHT_TIMEOUT_MS", "\n\nfunction taskPublishesWorkspacePatch"],
      ["function preparationStep", "\n\nfunction prepareArtifactMirror"],
      ["function nonRetryableFailure", "\n\nfunction assertVerifiedDependency"]
    ] as const
  )
    .map(([startMarker, endMarker]) => {
      const start = source.indexOf(startMarker);
      const end = source.indexOf(endMarker, start);
      assert.ok(start >= 0 && end > start, startMarker);
      return source.slice(start, end);
    })
    .join("\n");
  const compiled = ts.transpileModule(helpers, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText;
  const run = runOnControllerEngine(
    root,
    `
import { runProcessGroup } from ${JSON.stringify(new URL("../src/process-group.js", import.meta.url).href)};
import path from "node:path";
const artifactValidatorSmokeFixturePath = () => "synthetic-fixture.json";
${compiled}
const workflow = smithers(() => h(Workflow, { name: "missing-validator" },
  h(Task, { id: "prepare:synthetic", output: outputs.result, retries: 3,
    retryPolicy: { backoff: "fixed", initialDelayMs: 1 } }, async () => {
    try {
      await preflightJsonValidator(
        process.cwd(), { registry: [{ filename: "findings.schema.json" }] }, process.cwd(),
        new AbortController().signal);
    } catch (error) {
      // The generated workflow awaits this probe before wrapping its failure
      // as a named, nonretryable preparation step.
      preparationStep("synthetic", "preflight-json-validator", () => { throw error; });
    }
    return { value: "unreachable" };
  })));
`
  );
  assert.equal(run.status, "failed");
  assert.equal(run.attempts.length, 1, JSON.stringify(run));
  assert.equal(run.eventTypes.NodeFailed, 1);
  assert.equal(run.eventTypes.NodeRetrying ?? 0, 0);
  const attempt = run.attempts[0];
  assert.ok(attempt?.error_json && attempt.meta_json);
  const failure = JSON.parse(attempt.error_json) as {
    code?: string;
    message: string;
    details?: { failureRetryable?: boolean };
  };
  assert.equal(failure.code, "TOOL_UNAVAILABLE");
  assert.equal(failure.details?.failureRetryable, false);
  assert.match(failure.message, /prepare:synthetic failed at step preflight-json-validator: tool_unavailable/u);
  assert.doesNotMatch(failure.message, /timeout|budget|180000/u);
  assert.equal((JSON.parse(attempt.meta_json) as { failureRetryable?: boolean }).failureRetryable, false);
});

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

// #1148: Ultrafuzz seeds each <Worktree> from the recorded launch commit, which can
// exist only locally. Smithers fetched origin before creating a worktree, and when a
// task re-entered it fetched again (unless a fetch had succeeded in the last minute)
// and rebased onto `origin/<sha>`, which is never a ref.
test("controller task worktrees stay on a local-only launch commit without fetching or rebasing", () => {
  const root = temporaryRoot("ufz-controller-worktree-");
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.name", "Ultrafuzz Synthetic Test");
  git(root, "config", "user.email", "synthetic@example.invalid");
  fs.writeFileSync(path.join(root, "source.txt"), "published\n");
  git(root, "add", "source.txt");
  git(root, "commit", "--quiet", "-m", "published base");
  git(root, "init", "--quiet", "--bare", path.join(root, "origin.git"));
  git(root, "remote", "add", "origin", path.join(root, "origin.git"));
  git(root, "push", "--quiet", "origin", "main");
  fs.writeFileSync(path.join(root, "source.txt"), "launch\n");
  git(root, "commit", "--quiet", "-am", "local-only launch commit");
  const launch = git(root, "rev-parse", "HEAD");
  const gitLog = path.join(root, "git.log");
  const recorder = path.join(root, "git-recorder.sh");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  fs.writeFileSync(recorder, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${gitLog}'\nexec '${realGit}' "$@"\n`, {
    mode: 0o755
  });
  const workspace = path.join(root, "workspaces", "task-a");

  // Preparation creates the worktree; the verifier re-enters it, as in Ultrafuzz.
  const run = runOnControllerEngine(
    root,
    `const lane = { path: ${JSON.stringify(workspace)}, branch: "ultrafuzz/r1/task-a", baseBranch: ${JSON.stringify(launch)} };
const workflow = smithers(() =>
  h(Workflow, { name: "worktree" },
    h(Worktree, lane,
      h(Task, { id: "prepare", output: outputs.result, retries: 0 }, () => ({ value: "prepared" })),
      h(Task, { id: "verify", output: outputs.result, dependsOn: ["prepare"], retries: 0 }, () => ({ value: "verified" })))));`,
    { SMITHERS_GIT_PATH: recorder, SMITHERS_KEEP_WORKTREES: "1" }
  );

  assert.equal(run.status, "finished");
  const synchronization = fs
    .readFileSync(gitLog, "utf8")
    .split("\n")
    .filter((command) => /(?:^| )(?:fetch|rebase)(?: |$)/u.test(command));
  assert.deepEqual(synchronization, [], "a task worktree fetched origin or rebased onto origin/<commit>");
  assert.equal(git(workspace, "rev-parse", "HEAD"), launch);
  assert.equal(git(workspace, "branch", "--show-current"), "ultrafuzz/r1/task-a");
});
