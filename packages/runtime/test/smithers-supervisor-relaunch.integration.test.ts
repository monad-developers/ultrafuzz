import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { BUN_TARGET_CONFIGURATION_GUARD_ARGS } from "../src/smithers-executable-capability.js";
import { patchedSmithersRunner } from "./patched-smithers-runner.js";
import { temporaryRoot } from "./temporary-root.js";

interface TaskRecord {
  task: string;
  pid: number;
  cwd: string;
  dotenv: string | null;
}

// An engine run from plain paths, as `ultrafuzz resume` runs it: the workflow file lives in a
// run-owned directory below the launch root, its packages resolve through NODE_PATH, and no snapshot
// descriptor is inherited. When the engine dies, only Smithers' own supervisor can finish the run
// without an operator.
test("the supervisor relaunch finishes a SIGKILLed engine's run from its launch root and log directory", async () => {
  const root = temporaryRoot("ufz-supervisor-relaunch-");
  // Smithers anchors its store on a `.smithers` directory only below HOME. With the target outside
  // HOME, the store is `smithers.db` in whatever directory the engine starts in.
  const home = path.join(root, "home");
  const target = path.join(root, "target");
  const runRoot = path.join(target, ".ultrafuzz", "runs", "r1", "smithers");
  const workflow = path.join(runRoot, "workflows", "relaunch.tsx");
  const logDir = path.join(runRoot, "logs");
  const records = path.join(root, "tasks.jsonl");
  const preloaded = path.join(root, "target-preload-ran");
  fs.mkdirSync(home);
  fs.mkdirSync(path.dirname(workflow), { recursive: true });
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: target });
  // Bun loads both files from its working directory, which is the target repository.
  fs.writeFileSync(path.join(target, "bunfig.toml"), 'preload = ["./preload.js"]\n');
  fs.writeFileSync(
    path.join(target, "preload.js"),
    `require("node:fs").appendFileSync(${JSON.stringify(preloaded)}, process.argv.join(" ") + "\\n");\n`
  );
  fs.writeFileSync(path.join(target, ".env"), "TARGET_DOTENV=loaded\n");
  fs.writeFileSync(workflow, relaunchWorkflowSource(records));

  const runner = patchedSmithersRunner(path.join(root, "runner"));
  const runId = `supervisor-relaunch-${process.pid}`;
  const cli = [...BUN_TARGET_CONFIGURATION_GUARD_ARGS, path.join(runner, "src", "bin", "smithers.js")];
  const smithers = (...args: string[]): string => {
    const result = spawnSync("bun", [...cli, ...args], {
      cwd: target,
      encoding: "utf8",
      env: {
        HOME: home,
        PATH: process.env.PATH,
        ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
        NODE_PATH: path.dirname(runner),
        SMITHERS_MONITOR_SUPPRESS: "1",
        SMITHERS_POST_FAILURE: "0",
        ULTRAFUZZ_WORKFLOW_PERSISTED_PATH: workflow
      },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000
    });
    assert.equal(result.status, 0, [result.error, result.stdout, result.stderr].join("\n").slice(-4_000));
    return result.stdout;
  };
  try {
    smithers(
      "up",
      workflow,
      "--detach",
      "--run-id",
      runId,
      "--root",
      target,
      "--input",
      "{}",
      "--log-dir",
      logDir,
      "--format",
      "json",
      "--supervise",
      "--supervise-interval",
      "1s",
      // Production's threshold (controller_lease_seconds). A relaunch that has not activated within
      // it is claimed again as a second attempt.
      "--supervise-stale-threshold",
      "30s",
      "--supervise-max-concurrent",
      "1"
    );
    const killed = await waitFor("the first attempt", () => taskRecords(records)[0]);
    process.kill(killed.pid, "SIGKILL");
    const status = await waitFor("the run to end", () => {
      const inspected = JSON.parse(smithers("inspect", runId, "--format", "json")) as {
        status?: string;
        run?: { status?: string };
      };
      const current = inspected.run?.status ?? inspected.status;
      return current === "finished" || current === "failed" || current === "cancelled" ? current : undefined;
    });

    const events = smithers("events", runId, "--json")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; payload: { resumeAttempt?: number } });
    assert.equal(status, "finished", events.map((event) => event.type).join(","));
    assert.deepEqual(
      events.filter((event) => event.type === "RunAutoResumed").map((event) => event.payload.resumeAttempt),
      [1],
      "the first supervisor relaunch did not finish the run"
    );
    const recorded = taskRecords(records);
    assert.deepEqual(
      recorded.map((record) => record.task),
      ["interrupted", "interrupted", "after"]
    );
    assert.notEqual(recorded[1]?.pid, killed.pid);
    for (const record of recorded) {
      assert.equal(record.cwd, target, "the relaunched engine did not start in the launch root");
      assert.equal(record.dotenv, null, "an engine loaded the target's .env");
    }
    assert.equal(fs.existsSync(preloaded), false, "a controller process ran the target's bunfig.toml preload");
    // Both engines append to the run's log directory; none falls back to the default one.
    const logged = fs
      .readFileSync(path.join(logDir, "stream.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type);
    assert.equal(logged.filter((type) => type === "RunStarted").length, 2);
    assert.equal(logged.at(-1), "RunFinished");
    assert.equal(fs.existsSync(path.join(target, ".smithers", "executions")), false);
  } finally {
    // The supervisor exits once the run ends; a failed run can leave it and a hung engine behind.
    // Both run the copied CLI below `root`, and `pkill -f` takes a regular expression.
    spawnSync("pkill", ["-KILL", "-f", root.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&")]);
  }
});

// The first attempt blocks until the test kills its engine; the relaunched attempt returns.
function relaunchWorkflowSource(records: string): string {
  return `/** @jsxImportSource smthrs */
import fs from "node:fs";
import { createSmithers } from "smthrs";
import { z } from "zod/v4";

const { Workflow, Sequence, Task, smithers, outputs } = createSmithers({
  input: z.object({}),
  result: z.object({ value: z.string() })
});
const records = ${JSON.stringify(records)};
const record = (task: string): boolean => {
  const repeated = fs.existsSync(records) && fs.readFileSync(records, "utf8").includes('"task":"' + task + '"');
  const entry = { task, pid: process.pid, cwd: process.cwd(), dotenv: process.env.TARGET_DOTENV ?? null };
  fs.appendFileSync(records, JSON.stringify(entry) + "\\n");
  return repeated;
};
export default smithers(() => (
  <Workflow name="relaunch">
    <Sequence>
      <Task id="interrupted" output={outputs.result} retries={0}>
        {async () => {
          if (!record("interrupted")) await new Promise(() => {});
          return { value: "interrupted" };
        }}
      </Task>
      <Task id="after" output={outputs.result} retries={0}>
        {() => (record("after"), { value: "after" })}
      </Task>
    </Sequence>
  </Workflow>
));
`;
}

function taskRecords(file: string): TaskRecord[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TaskRecord);
}

// Long enough for the supervisor to give up after three relaunches, so a regression reports its events.
async function waitFor<T>(label: string, probe: () => T | undefined): Promise<T> {
  for (const deadline = Date.now() + 180_000; Date.now() < deadline;) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${label}`);
}
