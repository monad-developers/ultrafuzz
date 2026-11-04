import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { installSharedLogIfReferenced, SHARED_LOG_COMMAND_PATH } from "../src/shared-log.js";
import { temporaryRoot } from "./temporary-root.js";

interface Fixture {
  runRoot: string;
  command: string;
}

// A run root with two task workspaces, and a prompt that names the command when `referenced`.
function runFixture(referenced = true, workflowRunId = "wf-1", parent = "runs"): Fixture {
  const runRoot = path.join(fs.realpathSync(temporaryRoot("ultrafuzz-shared-log-")), parent, "run-1");
  const command = path.join(runRoot, ...SHARED_LOG_COMMAND_PATH.split("/"));
  for (const task of ["lens-a", "lens-b"]) {
    fs.mkdirSync(path.join(runRoot, "workspaces", task), { recursive: true });
    fs.mkdirSync(path.join(runRoot, "artifacts", task), { recursive: true });
    fs.writeFileSync(
      path.join(runRoot, "artifacts", task, "prompt.rendered.md"),
      referenced ? `Share what helps with ${command} post <text>.\n` : "Work alone.\n"
    );
  }
  writeJson(runRoot, "state.json", { nodes: { "lens-a": { retry_count: 0 }, "lens-b": { retry_count: 2 } } });
  setWorkflow(runRoot, workflowRunId);
  return { runRoot, command };
}

function writeJson(runRoot: string, name: string, value: unknown): void {
  fs.writeFileSync(path.join(runRoot, name), JSON.stringify(value));
}

function setWorkflow(runRoot: string, workflowRunId: string): void {
  writeJson(runRoot, "run.json", { workflow: { run_id: workflowRunId } });
}

function run(fixture: Fixture, cwd: string, args: string[], input?: string) {
  return spawnSync(fixture.command, args, {
    cwd: path.join(fixture.runRoot, cwd),
    encoding: "utf8",
    input: input ?? "",
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function lines(file: string): Record<string, unknown>[] {
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("the shared log command is installed only in a run whose prompts name it", () => {
  const unreferenced = runFixture(false);
  assert.equal(installSharedLogIfReferenced(unreferenced.runRoot), false);
  assert.equal(fs.existsSync(path.join(unreferenced.runRoot, "shared-log-bin")), false);
  assert.equal(fs.existsSync(path.join(unreferenced.runRoot, "shared-log")), false);

  const referenced = runFixture();
  assert.equal(installSharedLogIfReferenced(referenced.runRoot), true);
  assert.equal(fs.statSync(referenced.command).mode & 0o777, 0o700);
  // Installing again replaces the command in place.
  assert.equal(installSharedLogIfReferenced(referenced.runRoot), true);
  assert.deepEqual(fs.readdirSync(path.dirname(referenced.command)).sort(), ["shared-log.mjs", "ultrafuzz-shared-log"]);
});

test("the shared log stamps each post with its task and records every read", () => {
  const fixture = runFixture();
  installSharedLogIfReferenced(fixture.runRoot);

  const first = run(fixture, "workspaces/lens-a", ["post", "the", "fee", "rounds", "down"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, "posted entry #1\n");
  // A task's subdirectory is still that task's workspace, and stdin carries a multi-line entry.
  fs.mkdirSync(path.join(fixture.runRoot, "workspaces", "lens-b", "src"));
  const second = run(fixture, "workspaces/lens-b/src", ["post"], "line one\nline two\n");
  assert.equal(second.status, 0, second.stderr);

  const all = run(fixture, "workspaces/lens-b", ["read"]);
  assert.equal(all.status, 0, all.stderr);
  assert.match(
    all.stdout,
    /^#1 from lens-a at \S+\nthe fee rounds down\n\n#2 from lens-b at \S+\nline one\nline two\n$/u
  );
  assert.equal(run(fixture, "workspaces/lens-b", ["read", "--new"]).stdout, "(no new entries since your last read)\n");
  run(fixture, "workspaces/lens-a", ["post", "third"]);
  assert.match(run(fixture, "workspaces/lens-b", ["read", "--new"]).stdout, /^#3 from lens-a at \S+\nthird\n$/u);
  // A task that never read gets every entry from --new.
  assert.match(run(fixture, "workspaces/lens-a", ["read", "--new"]).stdout, /^#1 [^]*#2 [^]*#3 /u);

  const log = path.join(fixture.runRoot, "shared-log", "wf-1");
  const entries = lines(path.join(log, "entries.jsonl"));
  assert.deepEqual(
    entries.map(({ seq, task, retry_count, text }) => ({ seq, task, retry_count, text })),
    [
      { seq: 1, task: "lens-a", retry_count: 0, text: "the fee rounds down" },
      { seq: 2, task: "lens-b", retry_count: 2, text: "line one\nline two" },
      { seq: 3, task: "lens-a", retry_count: 0, text: "third" }
    ]
  );
  assert.ok(entries.every((entry) => !Number.isNaN(Date.parse(String(entry.posted_at)))));
  assert.deepEqual(
    lines(path.join(log, "reads.jsonl")).map(({ task, mode, seqs, through_seq }) => ({
      task,
      mode,
      seqs,
      through_seq
    })),
    [
      { task: "lens-b", mode: "all", seqs: [1, 2], through_seq: 2 },
      { task: "lens-b", mode: "new", seqs: [], through_seq: 2 },
      { task: "lens-b", mode: "new", seqs: [3], through_seq: 3 },
      { task: "lens-a", mode: "new", seqs: [1, 2, 3], through_seq: 3 }
    ]
  );
});

test("the shared log refuses a caller outside a task workspace, an empty post and unknown arguments", () => {
  const fixture = runFixture();
  installSharedLogIfReferenced(fixture.runRoot);

  for (const [cwd, args, message] of [
    [".", ["post", "x"], /run this command from your task workspace/u],
    ["workspaces", ["read"], /run this command from your task workspace/u],
    ["workspaces/lens-a", ["post"], /nothing to post/u],
    ["workspaces/lens-a", ["read", "--all"], /usage:/u],
    ["workspaces/lens-a", ["delete"], /usage:/u]
  ] as const) {
    const result = run(fixture, cwd, [...args]);
    assert.equal(result.status, 2, `${cwd} ${args.join(" ")}`);
    assert.match(result.stderr, message);
  }
  assert.equal(fs.existsSync(path.join(fixture.runRoot, "shared-log", "wf-1", "entries.jsonl")), false);
});

test("each workflow of a run, such as a fork, gets its own shared log", () => {
  const fixture = runFixture();
  installSharedLogIfReferenced(fixture.runRoot);
  run(fixture, "workspaces/lens-a", ["post", "from the original"]);

  setWorkflow(fixture.runRoot, "wf-2");
  assert.equal(run(fixture, "workspaces/lens-a", ["read"]).stdout, "(no entries yet)\n");
  assert.equal(run(fixture, "workspaces/lens-a", ["post", "from the fork"]).stdout, "posted entry #1\n");
  assert.equal(lines(path.join(fixture.runRoot, "shared-log", "wf-1", "entries.jsonl")).length, 1);
  assert.deepEqual(
    lines(path.join(fixture.runRoot, "shared-log", "wf-2", "entries.jsonl")).map((entry) => entry.text),
    ["from the fork"]
  );
});

test("parallel posts each get their own entry and number", async () => {
  const fixture = runFixture();
  installSharedLogIfReferenced(fixture.runRoot);
  const text = "x".repeat(200_000);

  const codes = await Promise.all(
    Array.from(
      { length: 8 },
      (_, index) =>
        new Promise<number | null>((resolve) => {
          // Entries this long go on stdin: an argument this long exceeds the exec limit.
          const child = spawn(fixture.command, ["post"], {
            cwd: path.join(fixture.runRoot, "workspaces", index % 2 === 0 ? "lens-a" : "lens-b"),
            stdio: ["pipe", "ignore", "ignore"]
          });
          child.stdin.end(`${index} ${text}`);
          child.on("close", resolve);
        })
    )
  );
  assert.deepEqual(codes, Array(8).fill(0));
  const entries = lines(path.join(fixture.runRoot, "shared-log", "wf-1", "entries.jsonl"));
  assert.deepEqual(
    entries.map((entry) => entry.seq),
    [1, 2, 3, 4, 5, 6, 7, 8]
  );
  assert.deepEqual(entries.map((entry) => String(entry.text).split(" ")[0]).sort(), [
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7"
  ]);
  assert.equal(fs.existsSync(path.join(fixture.runRoot, "shared-log", "wf-1", ".lock")), false);
});

test("rounds of many parallel posts never crash a writer or reuse a number", async () => {
  const fixture = runFixture();
  installSharedLogIfReferenced(fixture.runRoot);
  // Many writers taking and releasing the lock back to back: a lock released by deleting it in
  // place was briefly an empty directory that a waiter's staged lock could replace.
  const rounds = 10;
  const writers = 24;
  for (let round = 0; round < rounds; round += 1) {
    const codes = await Promise.all(
      Array.from(
        { length: writers },
        (_, index) =>
          new Promise<number | null>((resolve) => {
            const child = spawn(fixture.command, ["post", `${String(round)}-${String(index)}`], {
              cwd: path.join(fixture.runRoot, "workspaces", index % 2 === 0 ? "lens-a" : "lens-b"),
              stdio: ["ignore", "ignore", "ignore"]
            });
            child.on("close", resolve);
          })
      )
    );
    assert.deepEqual(codes, Array(writers).fill(0), `round ${String(round)}`);
  }
  const log = path.join(fixture.runRoot, "shared-log", "wf-1");
  assert.deepEqual(
    lines(path.join(log, "entries.jsonl")).map((entry) => entry.seq),
    Array.from({ length: rounds * writers }, (_, index) => index + 1)
  );
  assert.deepEqual(fs.readdirSync(log), ["entries.jsonl"]);
});

test("a dynamic task's prompt template that names the command installs it at launch", () => {
  // Rendered prompts that do not name it, as for a run whose only reference is in a dynamic task.
  const fixture = runFixture(false);
  const templates = path.join(fixture.runRoot, "dynamic-prompt-templates");
  fs.mkdirSync(templates);
  // An escaped reference renders literally, so it names nothing.
  fs.writeFileSync(path.join(templates, "a.md"), "Literal \\{{shared_log_command}} only.\n");
  assert.equal(installSharedLogIfReferenced(fixture.runRoot), false);

  fs.writeFileSync(path.join(templates, "b.md"), "Share with {{ shared_log_command }} post <text>.\n");
  assert.equal(installSharedLogIfReferenced(fixture.runRoot), true);
  assert.equal(run(fixture, "workspaces/lens-a", ["post", "from a dynamic lens"]).stdout, "posted entry #1\n");
});

test("a run path with spaces gets a quoted command that still finds and runs it", () => {
  const fixture = runFixture(false, "wf-1", "my runs");
  for (const task of ["lens-a", "lens-b"]) {
    fs.writeFileSync(
      path.join(fixture.runRoot, "artifacts", task, "prompt.rendered.md"),
      `Share with '${fixture.command}' post <text>.\n`
    );
  }
  assert.equal(installSharedLogIfReferenced(fixture.runRoot), true);
  const result = spawnSync("/bin/sh", ["-c", `'${fixture.command}' post "it works"`], {
    cwd: path.join(fixture.runRoot, "workspaces", "lens-a"),
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "posted entry #1\n");
});

test("waiters that all find a dead writer's lock move it aside once and then write one at a time", async () => {
  const fixture = runFixture();
  installSharedLogIfReferenced(fixture.runRoot);
  const log = path.join(fixture.runRoot, "shared-log", "wf-1");
  const old = new Date(Date.now() - 120_000);
  const staleLock = (directory: string, owner: string): void => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "owner"), owner);
    fs.utimesSync(directory, old, old);
  };
  staleLock(path.join(log, ".lock"), "111-1-dead");
  const seen = fs.statSync(path.join(log, ".lock"), { bigint: true });
  const recoveredLock = `.lock-stale-ino-${String(seen.dev)}-${String(seen.ino)}`;
  // What earlier crashes leave: a lock already moved aside, and a dead waiter's staged lock.
  staleLock(path.join(log, ".lock-stale-99-1-older"), "99-1-older");
  staleLock(path.join(log, ".lock-98-1-waiter"), "98-1-waiter");

  const codes = await Promise.all(
    Array.from(
      { length: 8 },
      (_, index) =>
        new Promise<number | null>((resolve) => {
          const child = spawn(fixture.command, ["post", `entry ${String(index)}`], {
            cwd: path.join(fixture.runRoot, "workspaces", index % 2 === 0 ? "lens-a" : "lens-b"),
            stdio: ["ignore", "ignore", "ignore"]
          });
          child.on("close", resolve);
        })
    )
  );
  assert.deepEqual(codes, Array(8).fill(0));
  const entries = lines(path.join(log, "entries.jsonl"));
  assert.deepEqual(
    entries.map((entry) => entry.seq),
    [1, 2, 3, 4, 5, 6, 7, 8]
  );
  assert.equal(new Set(entries.map((entry) => entry.text)).size, 8);
  // The dead writer's lock was moved aside exactly once, and no waiter left a lock behind.
  assert.deepEqual(fs.readdirSync(log).sort(), [
    ".lock-98-1-waiter",
    ".lock-stale-99-1-older",
    recoveredLock,
    "entries.jsonl"
  ]);
  assert.equal(fs.readFileSync(path.join(log, recoveredLock, "owner"), "utf8"), "111-1-dead");
});

test("a waiter that inspected a stale lock cannot move a replacement writer's lock", { timeout: 25_000 }, async () => {
  const fixture = runFixture();
  installSharedLogIfReferenced(fixture.runRoot);
  const log = path.join(fixture.runRoot, "shared-log", "wf-1");
  const lock = path.join(log, ".lock");
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, "owner"), "111-1-dead");
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(lock, old, old);

  // Run the installed script unchanged. The preload controls only the interleaving: A keeps an
  // old stat result while B recovers that lock, acquires a new one and pauses before appending.
  const hook = path.join(fixture.runRoot, "lock-scheduler.mjs");
  fs.writeFileSync(
    hook,
    String.raw`import fs from "node:fs";
import path from "node:path";

const root = process.env.SHARED_LOG_TEST_ROOT;
const role = process.env.SHARED_LOG_TEST_ROLE;
const lock = path.join(root, "shared-log", "wf-1", ".lock");
const stat = fs.statSync;
const rename = fs.renameSync;
const append = fs.appendFileSync;
let paused = false;
let attempted = false;

function signal(name) {
  fs.writeFileSync(path.join(root, name), "");
}

function wait(name) {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(path.join(root, name))) {
    if (Date.now() > deadline) throw new Error("scheduler timed out waiting for " + name);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

fs.statSync = function(file, ...args) {
  const value = stat.call(fs, file, ...args);
  if (role === "a" && !paused && String(file) === lock && value !== undefined) {
    paused = true;
    signal("a-saw-stale-lock");
    wait("continue-a");
  }
  return value;
};

fs.renameSync = function(source, destination, ...args) {
  if (role === "a" && !attempted && String(source) === lock && path.basename(String(destination)).startsWith(".lock-stale-")) {
    attempted = true;
    try {
      return rename.call(fs, source, destination, ...args);
    } finally {
      // The fixed recovery fails with ENOTEMPTY because B already moved this generation aside.
      signal("a-attempted-recovery");
    }
  }
  return rename.call(fs, source, destination, ...args);
};

fs.appendFileSync = function(file, ...args) {
  if (role === "b" && String(file) === path.join(root, "shared-log", "wf-1", "entries.jsonl")) {
    signal("b-holds-new-lock");
    wait("continue-b");
  }
  return append.call(fs, file, ...args);
};
`
  );

  const children: {
    child: ReturnType<typeof spawn>;
    done: Promise<{ code: number | null; stderr: string }>;
  }[] = [];
  const start = (role: "a" | "b") => {
    const child = spawn(
      process.execPath,
      ["--import", hook, path.join(fixture.runRoot, "shared-log-bin", "shared-log.mjs"), "post", `post-from-${role}`],
      {
        cwd: path.join(fixture.runRoot, "workspaces", `lens-${role}`),
        env: { ...process.env, SHARED_LOG_TEST_ROOT: fixture.runRoot, SHARED_LOG_TEST_ROLE: role },
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 15_000,
        killSignal: "SIGKILL"
      }
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const done = new Promise<{ code: number | null; stderr: string }>((resolve) => {
      child.on("error", (error) => {
        stderr += error.message;
      });
      child.on("close", (code) => resolve({ code, stderr }));
    });
    children.push({ child, done });
  };
  const waitFor = async (name: string): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(path.join(fixture.runRoot, name))) {
      assert.ok(Date.now() < deadline, `timed out waiting for ${name}`);
      await delay(10);
    }
  };

  try {
    start("a");
    await waitFor("a-saw-stale-lock");
    start("b");
    await waitFor("b-holds-new-lock");
    const replacementOwner = fs.readFileSync(path.join(lock, "owner"), "utf8");
    assert.notEqual(replacementOwner, "111-1-dead");
    fs.writeFileSync(path.join(fixture.runRoot, "continue-a"), "");
    await waitFor("a-attempted-recovery");
    assert.equal(fs.readFileSync(path.join(lock, "owner"), "utf8"), replacementOwner);

    fs.writeFileSync(path.join(fixture.runRoot, "continue-b"), "");
    for (const result of await Promise.all(children.map(({ done }) => done))) {
      assert.equal(result.code, 0, result.stderr);
    }
    const entries = lines(path.join(log, "entries.jsonl"));
    assert.deepEqual(
      entries.map((entry) => entry.seq),
      [1, 2]
    );
    assert.deepEqual(
      entries.map((entry) => entry.text),
      ["post-from-b", "post-from-a"]
    );
    const firstRead = run(fixture, "workspaces/lens-a", ["read", "--new"]);
    assert.equal(firstRead.status, 0, firstRead.stderr);
    assert.match(firstRead.stdout, /^#1 from lens-b at \S+\npost-from-b\n\n#2 from lens-a at \S+\npost-from-a\n$/u);
    assert.equal(
      run(fixture, "workspaces/lens-a", ["read", "--new"]).stdout,
      "(no new entries since your last read)\n"
    );
  } finally {
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.all(children.map(({ done }) => done));
  }
});

test("a lock that is not yet stale is left in place", () => {
  const fixture = runFixture();
  installSharedLogIfReferenced(fixture.runRoot);
  const log = path.join(fixture.runRoot, "shared-log", "wf-1");
  const lock = path.join(log, ".lock");
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, "owner"), "222-1-live");
  // Due to go stale only after the command has given up waiting.
  const recent = new Date(Date.now() - 20_000);
  fs.utimesSync(lock, recent, recent);

  const result = run(fixture, "workspaces/lens-a", ["post", "blocked"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /stayed locked for 30 seconds/u);
  assert.equal(fs.readFileSync(path.join(lock, "owner"), "utf8"), "222-1-live");
  assert.equal(fs.existsSync(path.join(log, "entries.jsonl")), false);
});
