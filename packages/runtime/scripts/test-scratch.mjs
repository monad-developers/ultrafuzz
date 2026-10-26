import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function restoreWritePermissions(root) {
  const stat = fs.lstatSync(root);
  // Unlinking a file needs write permission on its parent, not on the file.
  // A file may be hard-linked outside scratch, so never change its mode.
  if (!stat.isDirectory()) return;
  fs.chmodSync(root, stat.mode | 0o700);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) restoreWritePermissions(path.join(root, entry.name));
  }
}

function removeScratch(root) {
  restoreWritePermissions(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function processGroupIsAlive(pgid) {
  // A Node --test runner can exit while its per-file workers keep running.
  // On Windows a group probe is unavailable, so stale scratch is retained.
  return process.platform === "win32" || pidIsAlive(-pgid);
}

function recordedTestGroupIsDead(root) {
  let marker;
  try {
    marker = fs.readFileSync(path.join(root, ".test-child-pgid"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return false; // The launcher may have died before publishing the marker.
    throw error;
  }
  if (!/^[1-9][0-9]*\n?$/u.test(marker)) return false;
  const pgid = Number(marker.trim());
  return Number.isSafeInteger(pgid) && !processGroupIsAlive(pgid);
}

function scratchExhaustionError(error) {
  return error.code === "ENOSPC" || error.code === "EDQUOT" || error.errno === -122;
}

const scratchExhaustionOutput = /\b(?:ENOSPC|EDQUOT)\b|Unknown system error:?\s*-122\b|\berrno\s*[:=]?\s*-122\b/iu;

function pathIsWithin(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function processStartTicks(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(") ");
    if (commandEnd === -1) return undefined;
    // Field 22 is starttime; the text after the command starts at field 3.
    const value = stat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/u)[19];
    return /^[0-9]+$/u.test(value ?? "") ? BigInt(value) : undefined;
  } catch {
    return undefined;
  }
}

function recordedLauncherStart(root) {
  let marker;
  try {
    marker = fs.readFileSync(path.join(root, ".test-launcher-start"), "utf8");
  } catch {
    return undefined;
  }
  return /^[0-9]+\n$/u.test(marker) ? BigInt(marker.trim()) : undefined;
}

function scratchUseStatus(scratch, original = scratch) {
  if (process.platform !== "linux" || process.getuid === undefined) return "uncertain";
  const launcherStart = recordedLauncherStart(scratch);
  if (launcherStart === undefined) return "uncertain";
  const paths = [original, scratch];
  let processes;
  try {
    processes = fs.readdirSync("/proc", { withFileTypes: true });
  } catch {
    return "uncertain";
  }
  let uncertain = false;
  for (const entry of processes) {
    if (!/^[0-9]+$/u.test(entry.name)) continue;
    const pid = Number(entry.name);
    const processRoot = path.join("/proc", entry.name);
    const started = processStartTicks(entry.name);
    // A process that started before this launcher predates its scratch.
    // Readable cwd/fds may still show later use; age excuses only read errors.
    const olderProcess = started !== undefined && started < launcherStart;
    let readUncertain = false;
    try {
      // Non-dumpable processes can have root-owned /proc directories even
      // while their real/effective UIDs still match this test launcher.
      const status = fs.readFileSync(path.join(processRoot, "status"), "utf8");
      const match = /^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)/mu.exec(status);
      if (match === null) readUncertain = true;
      else if (!match.slice(1).some((uid) => Number(uid) === process.getuid())) continue;
    } catch (error) {
      if ((error.code === "ENOENT" || error.code === "ESRCH") && !pidIsAlive(pid)) continue;
      readUncertain = true;
    }
    let environment;
    try {
      environment = fs.readFileSync(path.join(processRoot, "environ"), "utf8");
    } catch (error) {
      if ((error.code === "ENOENT" || error.code === "ESRCH") && !pidIsAlive(pid)) continue;
      readUncertain = true;
    }
    if (
      environment
        ?.split("\0")
        .some((field) =>
          paths.some(
            (directory) =>
              field === `TMPDIR=${directory}` || field === `TMP=${directory}` || field === `TEMP=${directory}`
          )
        )
    ) {
      return "active";
    }
    try {
      const cwd = fs.readlinkSync(path.join(processRoot, "cwd"));
      if (paths.some((directory) => pathIsWithin(cwd, directory))) return "active";
      for (const descriptor of fs.readdirSync(path.join(processRoot, "fd"))) {
        let target;
        try {
          target = fs.readlinkSync(path.join(processRoot, "fd", descriptor));
        } catch (error) {
          if (error.code === "ENOENT" && !pidIsAlive(pid)) break;
          if (error.code === "ENOENT") continue; // A descriptor closed during the scan.
          throw error;
        }
        if (paths.some((directory) => pathIsWithin(target, directory))) return "active";
      }
    } catch (error) {
      if ((error.code === "ENOENT" || error.code === "ESRCH") && !pidIsAlive(pid)) continue;
      readUncertain = true;
    }
    if (readUncertain) {
      if (!pidIsAlive(pid)) continue;
      const currentStart = processStartTicks(entry.name);
      const stillOlder = currentStart !== undefined && currentStart < launcherStart;
      if (!olderProcess || !stillOlder) uncertain = true;
    }
  }
  return uncertain ? "uncertain" : "clear";
}

function signalTestGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function recordedOriginalScratch(root, parent) {
  let original;
  try {
    original = fs.readFileSync(path.join(root, ".test-scratch-origin"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  if (!original.endsWith("\n")) return undefined;
  original = original.slice(0, -1);
  if (path.dirname(original) !== parent || !/^run-[1-9][0-9]*-[A-Za-z0-9]+$/u.test(path.basename(original))) {
    return undefined;
  }
  return original;
}

function ownedScratchDirectory() {
  const parent = path.join(fs.realpathSync(os.tmpdir()), `ultrafuzz-runtime-tests-${process.getuid?.() ?? "user"}`);
  fs.mkdirSync(parent, { mode: 0o700, recursive: true });
  const parentStat = fs.lstatSync(parent);
  if (
    !parentStat.isDirectory() ||
    (process.getuid !== undefined && parentStat.uid !== process.getuid()) ||
    (parentStat.mode & 0o077) !== 0
  ) {
    throw new Error(`Runtime test scratch parent is not owned by this process: ${parent}`);
  }
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    const match = /^(?:run|reap)-([1-9][0-9]*)-[A-Za-z0-9]+$/u.exec(entry.name);
    if (!match || !entry.isDirectory() || pidIsAlive(Number(match[1]))) continue;
    const stale = path.join(parent, entry.name);
    const original = recordedOriginalScratch(stale, parent);
    if (original === undefined || !recordedTestGroupIsDead(stale) || scratchUseStatus(stale, original) !== "clear")
      continue;
    const claimed = path.join(parent, `reap-${process.pid}-${randomUUID().replaceAll("-", "")}`);
    try {
      fs.renameSync(stale, claimed);
    } catch (error) {
      if (error.code === "ENOENT") continue; // Another test launcher claimed it first.
      throw error;
    }
    // A process can start while we claim the directory, and an escaped child
    // still has the original run path in its environment after the rename.
    if (recordedTestGroupIsDead(claimed) && scratchUseStatus(claimed, original) === "clear") removeScratch(claimed);
  }
  const scratch = fs.mkdtempSync(path.join(parent, `run-${process.pid}-`));
  fs.writeFileSync(path.join(scratch, ".test-scratch-origin"), `${scratch}\n`, { mode: 0o600, flag: "wx" });
  if (process.platform === "linux") {
    const start = processStartTicks("self");
    if (start === undefined) throw new Error("Runtime test launcher start time is unavailable from /proc/self/stat");
    fs.writeFileSync(path.join(scratch, ".test-launcher-start"), `${start}\n`, { mode: 0o600, flag: "wx" });
  }
  return scratch;
}

export async function runTests(args, extraEnv = {}) {
  let scratch;
  try {
    scratch = ownedScratchDirectory();
  } catch (error) {
    process.stderr.write(
      `Runtime test scratch setup failed${scratchExhaustionError(error) ? " (disk full or quota exceeded, ENOSPC/EDQUOT)" : ""}: ${String(error)}\n`
    );
    return 1;
  }

  let status;
  let diskFull = false;
  let childGroupId;
  let childClosed = false;
  let childExitCode;
  const signalHandlers = [];
  try {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...extraEnv, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
      stdio: ["inherit", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    childGroupId = child.pid;
    if (process.platform !== "win32" && childGroupId !== undefined) {
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        const handler = () => signalTestGroup(childGroupId, signal);
        process.on(signal, handler);
        signalHandlers.push([signal, handler]);
      }
    }
    let markerError;
    if (child.pid !== undefined) {
      try {
        const pendingMarker = path.join(scratch, ".test-child-pgid.pending");
        fs.writeFileSync(pendingMarker, `${child.pid}\n`, { mode: 0o600, flag: "wx" });
        fs.renameSync(pendingMarker, path.join(scratch, ".test-child-pgid"));
      } catch (error) {
        markerError = error;
        if (process.platform === "win32") child.kill("SIGKILL");
        else signalTestGroup(child.pid, "SIGKILL");
      }
    }
    for (const [stream, output] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr]
    ]) {
      let tail = "";
      stream.on("data", (chunk) => {
        const text = tail + String(chunk);
        if (scratchExhaustionOutput.test(text)) diskFull = true;
        tail = text.slice(-40);
      });
      stream.pipe(output, { end: false });
    }
    status = await new Promise((resolve) => {
      child.once("error", (error) => {
        if (scratchExhaustionError(error)) diskFull = true;
        process.stderr.write(`Runtime test process could not start: ${String(error)}\n`);
        resolve(1);
      });
      child.once("close", (code) => {
        childClosed = true;
        childExitCode = code;
        resolve(code ?? 1);
      });
    });
    if (markerError !== undefined) {
      process.stderr.write(`Runtime test scratch owner could not be recorded: ${String(markerError)}\n`);
      status = 1;
    }
    if (diskFull) {
      process.stderr.write(`Runtime tests exhausted scratch space or quota (ENOSPC/EDQUOT) under ${scratch}.\n`);
      status = 1;
    }
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    let groupActive = process.platform !== "win32" && childGroupId !== undefined && processGroupIsAlive(childGroupId);
    let scratchUse = scratchUseStatus(scratch);
    // A worker or unrelated process can exit during /proc enumeration.
    // Retry brief ambiguity before retaining an otherwise completed run.
    for (
      let attempt = 0;
      attempt < 5 && (groupActive || (process.platform === "linux" && scratchUse === "uncertain"));
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      groupActive = process.platform !== "win32" && childGroupId !== undefined && processGroupIsAlive(childGroupId);
      scratchUse = scratchUseStatus(scratch);
    }
    // Non-Linux platforms have no proc scan. A closed POSIX runner with a dead
    // group can release its scratch; Windows requires a normal successful exit.
    const completedOutsideLinux =
      process.platform !== "linux" &&
      childClosed &&
      Number.isInteger(childExitCode) &&
      !groupActive &&
      (process.platform !== "win32" || childExitCode === 0);
    if (groupActive || (scratchUse !== "clear" && !completedOutsideLinux)) {
      process.stderr.write(
        `Runtime test scratch retained for a possibly active test process (group ${groupActive ? "active" : "dead"}, scratch ${scratchUse}): ${scratch}\n`
      );
      status = 1;
    } else {
      try {
        removeScratch(scratch);
      } catch (error) {
        process.stderr.write(`Runtime test scratch cleanup failed for ${scratch}: ${String(error)}\n`);
        status = 1;
      }
    }
  }
  return status;
}
