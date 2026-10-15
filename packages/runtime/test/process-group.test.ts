import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runProcessGroup } from "../src/process-group.js";
import { temporaryRoot } from "./temporary-root.js";

const options = { timeoutMs: 5_000, maxBuffer: 1024 * 1024 };
const posix = { skip: process.platform === "win32", timeout: 10_000 };

function fixture() {
  const root = temporaryRoot("ultrafuzz-process-group-");
  const script = path.join(root, "backend.cjs");
  const pidsPath = path.join(root, "pids");
  fs.writeFileSync(
    script,
    `const fs = require("node:fs");
const { spawn } = require("node:child_process");
const [mode, pids] = process.argv.slice(2);
fs.appendFileSync(pids, process.pid + "\\n");
process.on("SIGTERM", () => {});
if (mode === "tree") {
  spawn(process.execPath, [__filename, "worker", pids], { stdio: "inherit" });
} else if (mode === "worker") {
  spawn(process.execPath, [__filename, "leaf", pids], { stdio: "inherit" });
} else if (mode === "success" || mode === "failure" || mode === "nested-success") {
  if (mode === "nested-success") {
    spawn("/usr/bin/timeout", ["60s", process.execPath, __filename, "leaf", pids], { stdio: "inherit" });
  } else {
    spawn(process.execPath, [__filename, "leaf", pids], { stdio: "inherit" });
  }
  const ready = setInterval(() => {
    if (fs.readFileSync(pids, "utf8").trim().split("\\n").length === 2) {
      clearInterval(ready);
      process.stdout.write("leader completed\\n");
      process.exit(mode === "failure" ? 7 : 0);
    }
  }, 10);
}
setInterval(() => {}, 1000);
`
  );
  const pids = () => (fs.existsSync(pidsPath) ? fs.readFileSync(pidsPath, "utf8").trim().split("\n").map(Number) : []);
  return { root, script, pidsPath, pids };
}

function running(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      // Containers may retain adopted zombies until PID 1 reaps them.
      if (/^\d+ \(.*\) Z /u.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"))) return false;
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition() && Date.now() < deadline) await delay(10);
  assert.ok(condition(), "process fixture did not reach the expected state");
}

function cleanup(pids: readonly number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The assertion path should already have terminated the group.
    }
  }
}

test("process group captures bounded output without interpreting command arguments", posix, async () => {
  const argument = "literal '$HOME' `command` $(command)";
  const result = await runProcessGroup(
    process.execPath,
    ["-e", "process.stdout.write(process.argv[1]); process.stderr.write('diagnostic')", argument],
    options
  );
  assert.deepEqual(result, { stdout: argument, stderr: "diagnostic" });
});

test("process group preserves immediate ENOENT as a launch failure", posix, async () => {
  const startedAt = Date.now();
  await assert.rejects(runProcessGroup("/nonexistent-ultrafuzz-executable", [], options), { code: "ENOENT" });
  assert.ok(Date.now() - startedAt < 2_000);
});

test(
  "process group timeout kills a launcher, timeout wrapper, and SIGTERM-resistant descendants",
  { ...posix, skip: process.platform !== "linux" },
  async () => {
    const backend = fixture();
    const startedAt = Date.now();
    try {
      await assert.rejects(
        runProcessGroup(
          "/bin/sh",
          [
            "-c",
            'timeout 60s "$1" "$2" tree "$3" & wait',
            "launcher",
            process.execPath,
            backend.script,
            backend.pidsPath
          ],
          { ...options, timeoutMs: 1_000 }
        ),
        { code: "PROCESS_TIMEOUT" }
      );
      assert.equal(backend.pids().length, 3, "the launcher must reach both descendant levels before timing out");
      await waitFor(() => backend.pids().every((pid) => !running(pid)));
      assert.ok(Date.now() - startedAt < 3_000, "inherited pipes must not extend the execution deadline");
    } finally {
      cleanup(backend.pids());
    }
  }
);

for (const mode of ["success", "failure", "nested-success"] as const) {
  test(
    `process group records ${mode} at leader exit and cleans children retaining pipes`,
    { ...posix, skip: process.platform !== "linux" },
    async () => {
      const backend = fixture();
      const startedAt = Date.now();
      try {
        const result = runProcessGroup(process.execPath, [backend.script, mode, backend.pidsPath], options);
        if (mode !== "failure") assert.equal((await result).stdout, "leader completed\n");
        else await assert.rejects(result, { code: "PROCESS_EXIT", exitCode: 7 });
        assert.equal(backend.pids().length, 2);
        await waitFor(() => backend.pids().every((pid) => !running(pid)));
        assert.ok(Date.now() - startedAt < 2_000, "leader exit must not wait for the execution timer");
      } finally {
        cleanup(backend.pids());
      }
    }
  );
}

test("process group cleanup leaves processes in another session running", posix, async () => {
  const backend = fixture();
  const unrelated = spawn(process.execPath, [backend.script, "leaf", backend.pidsPath], {
    detached: true,
    stdio: "ignore"
  });
  const reaped = new Promise<void>((resolve) => unrelated.once("close", () => resolve()));
  try {
    await waitFor(() => backend.pids().length === 1);
    await runProcessGroup(process.execPath, ["-e", "process.stdout.write('ok')"], options);
    const pid = backend.pids()[0];
    assert.ok(pid !== undefined && running(pid));
  } finally {
    unrelated.kill("SIGKILL");
    await reaped;
  }
});

test("process group cancellation escalates against a resistant leader and descendants", posix, async () => {
  const backend = fixture();
  const controller = new AbortController();
  const result = runProcessGroup(process.execPath, [backend.script, "tree", backend.pidsPath], {
    ...options,
    signal: controller.signal
  });
  const rejected = assert.rejects(result, { code: "TASK_ABORTED" });
  try {
    await waitFor(() => backend.pids().length === 3);
    controller.abort();
    await rejected;
    await waitFor(() => backend.pids().every((pid) => !running(pid)));
  } finally {
    controller.abort();
    cleanup(backend.pids());
    await rejected;
  }
});

test("process group never launches with an already canceled signal", posix, async () => {
  const backend = fixture();
  await assert.rejects(
    runProcessGroup(process.execPath, [backend.script, "tree", backend.pidsPath], {
      ...options,
      signal: AbortSignal.abort()
    }),
    { code: "TASK_ABORTED" }
  );
  assert.deepEqual(backend.pids(), []);
});

test("process group output overflow terminates the writer without becoming a timeout", posix, async () => {
  await assert.rejects(
    runProcessGroup(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => process.stdout.write('x'.repeat(8192)), 1)"],
      { ...options, maxBuffer: 1024 }
    ),
    { code: "PROCESS_OUTPUT_LIMIT" }
  );
});
