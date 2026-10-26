import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const nodeTest = process.versions.bun === undefined ? test : test.skip;
const linuxNodeTest = process.platform === "linux" && process.versions.bun === undefined ? test : test.skip;
const deadLauncherPid = 99_999_999;
const deadChildPid = 99_999_998;

function runScratchProbe(childCode = ""): ReturnType<typeof spawnSync> {
  const runner = new URL("../../scripts/test-scratch.mjs", import.meta.url).href;
  const script = `import { runTests } from ${JSON.stringify(runner)}; process.exitCode = await runTests(["--eval", ${JSON.stringify(childCode)}]);`;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
}

function liveChildIn(scratch: string): ChildProcess {
  return spawn(
    process.execPath,
    [
      "--eval",
      'const fs = require("node:fs"); fs.writeFileSync(process.env.TMPDIR + "/alive", "yes"); process.stdout.write("ready"); setInterval(() => {}, 1000);'
    ],
    { env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch }, stdio: ["ignore", "pipe", "pipe"] }
  );
}

function linuxProcessIsActive(pid: number): boolean {
  let stat;
  try {
    stat = fs.readFileSync(path.join("/proc", String(pid), "stat"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  return !/^[ZX]/u.test(stat.slice(stat.lastIndexOf(") ") + 2));
}

async function waitForLinuxProcessStop(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!linuxProcessIsActive(pid)) return true;
    await delay(25);
  }
  return false;
}

nodeTest("stale scratch is reclaimed only after a complete child marker confirms exit", async (context) => {
  const parent = path.join(fs.realpathSync(os.tmpdir()), `ultrafuzz-runtime-tests-${process.getuid?.() ?? "user"}`);
  fs.mkdirSync(parent, { mode: 0o700, recursive: true });
  const missing = fs.mkdtempSync(path.join(parent, `run-${deadLauncherPid}-`));
  const torn = fs.mkdtempSync(path.join(parent, `run-${deadLauncherPid}-`));
  fs.writeFileSync(path.join(torn, ".test-child-pgid"), "not-a-pid\n");
  const confirmedDead = fs.mkdtempSync(path.join(parent, `run-${deadLauncherPid}-`));
  fs.writeFileSync(path.join(confirmedDead, ".test-child-pgid"), `${deadChildPid}\n`);
  const reusedPid = fs.mkdtempSync(path.join(parent, `run-${process.pid}-`));
  fs.writeFileSync(path.join(reusedPid, ".test-child-pgid"), `${deadChildPid}\n`);
  const claimedOriginal = fs.mkdtempSync(path.join(parent, `run-${deadLauncherPid}-`));
  fs.writeFileSync(path.join(claimedOriginal, ".test-child-pgid"), `${deadChildPid}\n`);
  const claimedByLiveOriginal = fs.mkdtempSync(path.join(parent, `run-${deadLauncherPid}-`));
  fs.writeFileSync(path.join(claimedByLiveOriginal, ".test-child-pgid"), `${deadChildPid}\n`);
  let ownStart: bigint | undefined;
  if (process.platform === "linux") {
    const stat = fs.readFileSync("/proc/self/stat", "utf8");
    const start = stat
      .slice(stat.lastIndexOf(") ") + 2)
      .trim()
      .split(/\s+/u)[19];
    if (start === undefined) throw new Error("test process start time is unavailable");
    ownStart = BigInt(start);
  }
  for (const directory of [missing, torn, confirmedDead, reusedPid, claimedOriginal, claimedByLiveOriginal]) {
    fs.writeFileSync(path.join(directory, ".test-scratch-origin"), `${directory}\n`);
    if (ownStart !== undefined) {
      const marker = directory === reusedPid || directory === claimedByLiveOriginal ? ownStart - 1n : ownStart;
      fs.writeFileSync(path.join(directory, ".test-launcher-start"), `${marker}\n`);
    }
  }
  const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ufz-scratch-hardlink-"));
  const outsideFile = path.join(outside, "shared");
  fs.writeFileSync(outsideFile, "fixture");
  fs.chmodSync(outsideFile, 0o400);
  fs.linkSync(outsideFile, path.join(confirmedDead, "shared"));
  fs.chmodSync(confirmedDead, 0o500);

  const children = [liveChildIn(missing), liveChildIn(torn), liveChildIn(claimedOriginal)];
  const claimed = path.join(parent, `reap-${deadLauncherPid}-testclaim`);
  const claimedByLive = path.join(parent, `reap-${process.pid}-${ownStart ?? "unknown"}x${"a".repeat(32)}`);
  context.after(async () => {
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        await once(child, "exit");
      })
    );
    for (const directory of [
      missing,
      torn,
      confirmedDead,
      reusedPid,
      claimedOriginal,
      claimed,
      claimedByLiveOriginal,
      claimedByLive,
      outside
    ]) {
      if (fs.existsSync(directory)) fs.chmodSync(directory, 0o700);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  await Promise.all(
    children.map(async (child) => {
      assert.ok(child.stdout);
      return once(child.stdout, "data");
    })
  );
  fs.renameSync(claimedOriginal, claimed);
  fs.renameSync(claimedByLiveOriginal, claimedByLive);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const probe = runScratchProbe();
    if (probe.status !== 0) assert.match(String(probe.stderr), /scratch retained for a possibly active test process/u);
    assert.equal(fs.existsSync(path.join(missing, "alive")), true);
    assert.equal(fs.existsSync(path.join(torn, "alive")), true);
    assert.equal(fs.existsSync(path.join(claimed, "alive")), true);
    assert.equal(fs.existsSync(claimedByLive), true, "reaper claimed scratch owned by a live reaper");
    if (process.platform !== "linux" || (!fs.existsSync(confirmedDead) && !fs.existsSync(reusedPid))) break;
    await delay(50);
  }
  if (process.platform === "linux") {
    assert.equal(fs.existsSync(confirmedDead), false);
    assert.equal(fs.existsSync(reusedPid), false, "reaper treated a reused PID as the original launcher");
  }
  assert.equal(fs.statSync(outsideFile).mode & 0o777, 0o400);
  assert.equal(
    children.every((child) => child.exitCode === null && child.signalCode === null),
    true
  );
});

nodeTest("scratch cleanup does not change an outside hard link's mode", (context) => {
  const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ufz-scratch-hardlink-"));
  context.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const outsideFile = path.join(outside, "shared");
  fs.writeFileSync(outsideFile, "fixture");
  fs.chmodSync(outsideFile, 0o400);
  const probe = runScratchProbe(
    `const fs = require("node:fs"); fs.linkSync(${JSON.stringify(outsideFile)}, process.env.TMPDIR + "/shared"); fs.chmodSync(process.env.TMPDIR, 0o500);`
  );
  assert.equal(probe.status, 0, `${probe.stdout}${probe.stderr}`);
  assert.equal(fs.statSync(outsideFile).mode & 0o777, 0o400);
});

linuxNodeTest("a surviving test worker keeps scratch after its launcher and runner die", async (context) => {
  const coordination = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ufz-scratch-worker-"));
  const ready = path.join(coordination, "ready.json");
  const workerTest = path.join(coordination, "worker.test.mjs");
  fs.writeFileSync(
    workerTest,
    [
      'import fs from "node:fs";',
      'import test from "node:test";',
      'test("held worker", async () => {',
      `  fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, scratch: process.env.TMPDIR }));`,
      "  await new Promise((resolve) => setTimeout(resolve, 30_000));",
      "});"
    ].join("\n")
  );
  const runner = new URL("../../scripts/test-scratch.mjs", import.meta.url).href;
  const launcherCode = `import { runTests } from ${JSON.stringify(runner)}; process.exitCode = await runTests(["--test", ${JSON.stringify(workerTest)}]);`;
  const launcherEnv = { ...process.env };
  delete launcherEnv.NODE_TEST_CONTEXT;
  const launcher = spawn(process.execPath, ["--input-type=module", "--eval", launcherCode], {
    env: launcherEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let launcherOutput = "";
  assert.ok(launcher.stdout);
  assert.ok(launcher.stderr);
  launcher.stdout.on("data", (chunk: Buffer) => (launcherOutput += String(chunk)));
  launcher.stderr.on("data", (chunk: Buffer) => (launcherOutput += String(chunk)));
  const live: { runnerPgid?: number; workerPid?: number; scratch?: string } = {};
  context.after(async () => {
    if (launcher.exitCode === null && launcher.signalCode === null) {
      launcher.kill("SIGKILL");
      await once(launcher, "exit");
    }
    if (live.runnerPgid !== undefined) {
      try {
        process.kill(-live.runnerPgid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    if (live.workerPid !== undefined) {
      try {
        process.kill(live.workerPid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    if (live.workerPid !== undefined && (await waitForLinuxProcessStop(live.workerPid)) && live.scratch !== undefined) {
      fs.rmSync(live.scratch, { recursive: true, force: true });
    }
    fs.rmSync(coordination, { recursive: true, force: true });
  });

  for (let attempt = 0; attempt < 200 && !fs.existsSync(ready); attempt += 1) {
    assert.equal(launcher.exitCode, null, `test launcher exited before its worker was ready: ${launcherOutput}`);
    await delay(25);
  }
  assert.equal(fs.existsSync(ready), true, "test worker never reported its scratch directory");
  const readyState = JSON.parse(fs.readFileSync(ready, "utf8")) as { pid: number; scratch: string };
  const workerPid = readyState.pid;
  live.workerPid = readyState.pid;
  live.scratch = readyState.scratch;
  live.runnerPgid = Number(fs.readFileSync(path.join(live.scratch, ".test-child-pgid"), "utf8").trim());
  assert.equal(Number.isSafeInteger(live.runnerPgid), true);

  launcher.kill("SIGKILL");
  await once(launcher, "exit");
  process.kill(live.runnerPgid, "SIGKILL");
  await delay(25);
  assert.equal(linuxProcessIsActive(workerPid), true, "test worker stopped before stale reaping began");
  const probe = runScratchProbe();
  assert.equal(probe.status, 0, `${probe.stdout}${probe.stderr}`);
  assert.equal(linuxProcessIsActive(workerPid), true, "test worker stopped during stale reaping");
  assert.equal(fs.existsSync(live.scratch), true, "reaper deleted scratch still owned by a live worker");
});

linuxNodeTest("SIGINT to the launcher reaches its detached test worker", async (context) => {
  const coordination = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ufz-scratch-signal-"));
  const ready = path.join(coordination, "ready.json");
  const workerTest = path.join(coordination, "signal.test.mjs");
  fs.writeFileSync(
    workerTest,
    [
      'import fs from "node:fs";',
      'import test from "node:test";',
      'test("held worker", async () => {',
      `  fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, scratch: process.env.TMPDIR }));`,
      "  await new Promise((resolve) => setTimeout(resolve, 30_000));",
      "});"
    ].join("\n")
  );
  const runner = new URL("../../scripts/test-scratch.mjs", import.meta.url).href;
  const launcherCode = `import { runTests } from ${JSON.stringify(runner)}; process.exitCode = await runTests(["--test", ${JSON.stringify(workerTest)}]);`;
  const launcherEnv = { ...process.env };
  delete launcherEnv.NODE_TEST_CONTEXT;
  const launcher = spawn(process.execPath, ["--input-type=module", "--eval", launcherCode], {
    env: launcherEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const live: { runnerPgid?: number; workerPid?: number; scratch?: string } = {};
  context.after(async () => {
    if (launcher.exitCode === null && launcher.signalCode === null) {
      launcher.kill("SIGKILL");
      await once(launcher, "exit");
    }
    if (live.runnerPgid !== undefined) {
      try {
        process.kill(-live.runnerPgid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    if (live.workerPid !== undefined && (await waitForLinuxProcessStop(live.workerPid)) && live.scratch !== undefined) {
      fs.rmSync(live.scratch, { recursive: true, force: true });
    }
    fs.rmSync(coordination, { recursive: true, force: true });
  });

  for (let attempt = 0; attempt < 200 && !fs.existsSync(ready); attempt += 1) {
    assert.equal(launcher.exitCode, null, "test launcher exited before its worker was ready");
    await delay(25);
  }
  assert.equal(fs.existsSync(ready), true, "test worker never reported its scratch directory");
  const readyState = JSON.parse(fs.readFileSync(ready, "utf8")) as { pid: number; scratch: string };
  live.workerPid = readyState.pid;
  live.scratch = readyState.scratch;
  live.runnerPgid = Number(fs.readFileSync(path.join(live.scratch, ".test-child-pgid"), "utf8").trim());
  assert.equal(Number.isSafeInteger(live.runnerPgid), true);

  launcher.kill("SIGINT");
  await Promise.race([
    once(launcher, "exit"),
    delay(5_000, undefined, { ref: false }).then(() => assert.fail("launcher ignored SIGINT"))
  ]);
  assert.notEqual(launcher.exitCode, 0);
  assert.equal(await waitForLinuxProcessStop(live.workerPid), true, "test worker remained active after SIGINT");
});

nodeTest("scratch runner identifies quota exhaustion reported by Node or the filesystem", () => {
  for (const symptom of ["Error: EDQUOT\n", "Error: Unknown system error -122\n"]) {
    const probe = runScratchProbe(`process.stderr.write(${JSON.stringify(symptom)});`);
    assert.equal(probe.status, 1, `${probe.stdout}${probe.stderr}`);
    assert.match(`${probe.stdout}${probe.stderr}`, /exhausted scratch space or quota \(ENOSPC\/EDQUOT\)/u);
  }
});

nodeTest("a failed scratch marker write removes the new markerless directory", () => {
  const runner = new URL("../../scripts/test-scratch.mjs", import.meta.url).href;
  const markers =
    process.platform === "linux" ? [".test-scratch-origin", ".test-launcher-start"] : [".test-scratch-origin"];
  for (const marker of markers) {
    const script = `
      import fs from "node:fs";
      import os from "node:os";
      import path from "node:path";
      import { runTests } from ${JSON.stringify(runner)};
      const originalWrite = fs.writeFileSync;
      fs.writeFileSync = (target, ...args) => {
        if (String(target).endsWith(${JSON.stringify(marker)})) {
          throw Object.assign(new Error("quota exceeded"), { code: "EDQUOT", errno: -122 });
        }
        return originalWrite(target, ...args);
      };
      const status = await runTests(["--eval", ""]);
      const parent = path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-runtime-tests-" + (process.getuid?.() ?? "user"));
      const leaked = fs.readdirSync(parent).some((name) => name.startsWith("run-" + process.pid + "-"));
      if (leaked) process.stderr.write("markerless scratch leaked\\n");
      process.exitCode = leaked ? 2 : status;
    `;
    const probe = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
    assert.equal(probe.status, 1, `${marker}: ${probe.stdout}${probe.stderr}`);
    assert.match(probe.stderr, /disk full or quota exceeded, ENOSPC\/EDQUOT/u);
  }
});

linuxNodeTest("an uncertain proc scan retains scratch without failing a passing run", (context) => {
  const runner = new URL("../../scripts/test-scratch.mjs", import.meta.url).href;
  const script = `
    import fs from "node:fs";
    import { runTests } from ${JSON.stringify(runner)};
    const originalRead = fs.readFileSync;
    fs.readFileSync = (target, ...args) => {
      if (String(target) === "/proc/" + process.pid + "/environ") {
        throw Object.assign(new Error("proc read denied"), { code: "EACCES" });
      }
      return originalRead(target, ...args);
    };
    process.exitCode = await runTests(["--eval", ""]);
  `;
  const probe = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
  const retained = /scratch retained for a possibly active test process \(group dead, scratch uncertain\): (.+)/u.exec(
    String(probe.stderr)
  );
  assert.equal(probe.status, 0, `${probe.stdout}${probe.stderr}`);
  assert.ok(retained, "the uncertain scan did not retain scratch");
  const scratch = retained[1];
  assert.ok(scratch);
  context.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  assert.equal(fs.existsSync(scratch), true);
});
