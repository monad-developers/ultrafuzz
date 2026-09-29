import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseCurrentSmithersInspect, type CurrentSmithersInspect } from "../src/smithers.js";
import { resumeRun } from "../src/start-run.js";
import { temporaryRoot } from "./temporary-root.js";

// #272: the pinned runner can end a run `failed` with no failed task (a run-level error such as
// WORKFLOW_RENDER_FAILED) while dependent work is still pending. Recovery is a same-id
// `ultrafuzz resume`, not a rewind or a replacement lineage, so this drives that command's runtime
// entry against a real run: while the render-time cause persists the resume is refused and the run
// is left as it was; once the cause is gone the same run runs only its pending task.
test("a run-level render failure resumes under the same id once its cause is gone, without re-running finished work", async () => {
  const root = temporaryRoot("ufz-terminal-resume-");
  const runtimeRoot = runtimePackageRoot();
  const runId = `terminal-resume-${process.pid}-${Date.now()}`;
  const workflowPath = path.join(root, ".smithers", "workflows", "terminal-resume.tsx");
  const executionLog = path.join(root, "execution.log");
  const poison = path.join(root, "render-poison");
  const runRoot = path.join(root, ".ultrafuzz", "runs", runId);
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  fs.mkdirSync(path.join(runRoot, "smithers"), { recursive: true });
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root });
  const fixtureModules = path.join(root, ".smithers", "node_modules");
  fs.symlinkSync(path.dirname(fs.realpathSync(path.join(runtimeRoot, "node_modules", "smthrs"))), fixtureModules);
  fs.writeFileSync(workflowPath, workflowSource({ executionLog, poison }));
  fs.writeFileSync(poison, "");
  execFileSync(
    smithersBinary(runtimeRoot),
    ["up", workflowPath, "--detach", "--run-id", runId, "--root", root, "--input", "{}", "--format", "json"],
    { cwd: root, encoding: "utf8", env: { ...process.env, SMITHERS_POST_FAILURE: "0" } }
  );

  const failed = await stoppedRun(runtimeRoot, root, runId);
  assert.equal(failed.runState, "failed");
  assert.deepEqual(nodeStates(failed), { dependent: "pending", producer: "finished@1" });
  // No task owns this failure, so the run row's error is the only record of why it stopped.
  assert.deepEqual(failed.runError, { code: "WORKFLOW_RENDER_FAILED", message: "synthetic run-level render failure" });

  // Continuation runs on Ultrafuzz's own attested controller, never on packages in the target
  // (#973), so the fixture's direct `smithers up` link goes before the first resume.
  fs.unlinkSync(fixtureModules);
  fs.writeFileSync(
    path.join(runRoot, "run.json"),
    `${JSON.stringify({
      run_id: runId,
      workflow_ids: [runId],
      workflow: { run_id: runId, path: path.relative(root, workflowPath) }
    })}\n`
  );

  const refused = await resume(root, runId);
  assert.equal(refused.ok, false);
  assert.equal(refused.diagnostics?.[0]?.code, "WORKFLOW_LIFECYCLE_FAILED");
  assert.match(refused.diagnostics?.[0]?.message ?? "", /synthetic run-level render failure/u);
  assert.deepEqual(await stoppedRun(runtimeRoot, root, runId), failed);
  assert.deepEqual(executed(executionLog), ["producer"]);

  fs.rmSync(poison);
  const resumed = await resume(root, runId);
  assert.equal(resumed.ok, true, JSON.stringify(resumed.diagnostics));
  assert.equal(resumed.value?.workflow_run_id, runId);
  assert.equal(resumed.value?.submitted, true);
  const finished = await stoppedRun(runtimeRoot, root, runId);
  assert.equal(finished.runState, "succeeded");
  assert.equal(finished.runError, undefined);
  assert.deepEqual(nodeStates(finished), { dependent: "finished@1", producer: "finished@1" });
  assert.deepEqual(executed(executionLog), ["producer", "dependent"]);
});

function workflowSource(input: { executionLog: string; poison: string }): string {
  return `/** @jsxImportSource smthrs */
import fs from "node:fs";
import { createSmithers } from "smthrs";
import { z } from "zod/v4";

const { Workflow, Parallel, Task, smithers, outputs } = createSmithers({
  input: z.object({}),
  result: z.object({ value: z.string() })
});
const record = (value: string) => {
  fs.appendFileSync(${JSON.stringify(input.executionLog)}, value + "\\n");
  return { value };
};

export default smithers((ctx) => {
  // Render-time I/O that starts once the producer has output, like the generated workflow's reads
  // of a published dynamic expansion and of the prompts of the tasks it adds. Every later render
  // hits it, including the preflight render a detached resume runs; the first launch's does not.
  if (ctx.outputMaybe(outputs.result, { nodeId: "producer" }) !== undefined && fs.existsSync(${JSON.stringify(input.poison)})) {
    throw new Error("synthetic run-level render failure");
  }
  return (
    <Workflow name="terminal-resume">
      <Parallel>
        <Task id="producer" output={outputs.result} retries={0}>{() => record("producer")}</Task>
        <Task id="dependent" output={outputs.result} dependsOn={["producer"]} retries={0}>{() => record("dependent")}</Task>
      </Parallel>
    </Workflow>
  );
});
`;
}

// `ultrafuzz resume --force --retry-failed`, through the runtime entry the CLI calls.
async function resume(root: string, runId: string) {
  return resumeRun({
    projectRoot: root,
    runId,
    force: true,
    retryFailed: true,
    env: { PATH: process.env.PATH, SMITHERS_POST_FAILURE: "0" }
  });
}

// A detached submission returns only after the runner has re-activated the run, so the first
// stopped state observed after an accepted resume is the continuation's own.
async function stoppedRun(runtimeRoot: string, root: string, runId: string): Promise<CurrentSmithersInspect> {
  const deadline = Date.now() + 60_000;
  let last: unknown;
  while (Date.now() < deadline) {
    let stdout: string;
    let json: { data?: { run?: { status?: unknown } } };
    try {
      stdout = execFileSync(smithersBinary(runtimeRoot), ["inspect", runId, "--format", "json", "--full-output"], {
        cwd: root,
        encoding: "utf8"
      });
      json = JSON.parse(stdout) as typeof json;
    } catch (error) {
      // Retry a transient inspect failure until the deadline, as the sibling integration tests do.
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    last = json.data?.run?.status;
    if (last === "finished" || last === "failed" || last === "cancelled") {
      // The production reader, on the runner's real output.
      return parseCurrentSmithersInspect({ command: ["inspect", runId], ok: true, stdout, stderr: "", json }, runId);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`run ${runId} did not stop; last observation ${String(last)}`);
}

function nodeStates(inspect: CurrentSmithersInspect): Record<string, string> {
  return Object.fromEntries(
    inspect.nodes.map((node) => [node.nodeId, node.attempt === 0 ? node.state : `${node.state}@${node.attempt}`])
  );
}

function executed(executionLog: string): string[] {
  return fs.readFileSync(executionLog, "utf8").trim().split("\n");
}

function smithersBinary(runtimeRoot: string): string {
  return path.join(runtimeRoot, "node_modules", ".bin", process.platform === "win32" ? "smithers.cmd" : "smithers");
}

function runtimePackageRoot(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (directory !== path.dirname(directory)) {
    const candidate = path.join(directory, "package.json");
    if (fs.existsSync(candidate)) {
      const metadata = JSON.parse(fs.readFileSync(candidate, "utf8")) as { name?: string };
      if (metadata.name === "@ultrafuzz/runtime") return directory;
    }
    directory = path.dirname(directory);
  }
  throw new Error("runtime package root not found");
}
