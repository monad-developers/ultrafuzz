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
  if (process.platform === "win32") return true;
  if (!pidIsAlive(-pgid)) return false;
  if (process.platform !== "linux") return true;
  let processes;
  try {
    processes = fs.readdirSync("/proc", { withFileTypes: true });
  } catch {
    return true;
  }
  let uncertain = false;
  for (const entry of processes) {
    if (!/^[0-9]+$/u.test(entry.name)) continue;
    const info = processInfo(entry.name);
    if (info?.group === pgid && info.state !== "Z" && info.state !== "X") return true;
    if (info === undefined && pidIsAlive(Number(entry.name))) uncertain = true;
  }
  return uncertain;
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

function processInfo(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(") ");
    if (commandEnd === -1) return undefined;
    // Field 22 is starttime; the text after the command starts at field 3.
    const fields = stat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/u);
    const value = fields[19];
    const group = Number(fields[2]); // Field 5 is the process group ID.
    return /^[0-9]+$/u.test(value ?? "") && Number.isSafeInteger(group)
      ? { start: BigInt(value), state: fields[0], group }
      : undefined;
  } catch {
    return undefined;
  }
}

function processStartTicks(pid) {
  return processInfo(pid)?.start;
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

function sameUidStatus(processRoot) {
  try {
    // Non-dumpable processes can have root-owned /proc directories.
    const status = fs.readFileSync(path.join(processRoot, "status"), "utf8");
    const match = /^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)/mu.exec(status);
    if (match === null) return "uncertain";
    return match.slice(1).some((uid) => Number(uid) === process.getuid()) ? "same" : "other";
  } catch {
    return "uncertain";
  }
}

function environmentUseStatus(processRoot, paths) {
  try {
    const environment = fs.readFileSync(path.join(processRoot, "environ"), "utf8");
    const usesScratch = environment
      .split("\0")
      .some((field) =>
        paths.some(
          (directory) =>
            field === `TMPDIR=${directory}` || field === `TMP=${directory}` || field === `TEMP=${directory}`
        )
      );
    return usesScratch ? "active" : "clear";
  } catch {
    return "uncertain";
  }
}

function cwdUseStatus(processRoot, paths) {
  try {
    const cwd = fs.readlinkSync(path.join(processRoot, "cwd"));
    return paths.some((directory) => pathIsWithin(cwd, directory)) ? "active" : "clear";
  } catch {
    return "uncertain";
  }
}

function fdUseStatus(processRoot, paths) {
  let descriptors;
  try {
    descriptors = fs.readdirSync(path.join(processRoot, "fd"));
  } catch {
    return "uncertain";
  }
  let uncertain = false;
  for (const descriptor of descriptors) {
    let target;
    try {
      target = fs.readlinkSync(path.join(processRoot, "fd", descriptor));
    } catch (error) {
      if (error.code !== "ENOENT") uncertain = true;
      continue; // A descriptor may close during the scan.
    }
    if (paths.some((directory) => pathIsWithin(target, directory))) return "active";
  }
  return uncertain ? "uncertain" : "clear";
}

function uncertainProcessIsGoneOrOlder(name, firstInfo, launcherStart) {
  const currentInfo = processInfo(name);
  if (currentInfo?.state === "Z" || currentInfo?.state === "X") return true;
  if (currentInfo === undefined && !pidIsAlive(Number(name))) return true;
  // The harness passes private scratch paths only to processes it launches.
  // Check readable older env/cwd/fds first; age excuses only unreadable /proc
  // evidence from preexisting host daemons, never newer test descendants.
  return firstInfo?.start < launcherStart && currentInfo?.start < launcherStart;
}

function processScratchUseStatus(name, paths, launcherStart) {
  const processRoot = path.join("/proc", name);
  const firstInfo = processInfo(name);
  if (firstInfo?.state === "Z" || firstInfo?.state === "X") return "clear";
  const ownership = sameUidStatus(processRoot);
  if (ownership === "other") return "clear";
  const environment = environmentUseStatus(processRoot, paths);
  if (environment === "active") return "active";
  const cwd = cwdUseStatus(processRoot, paths);
  if (cwd === "active") return "active";
  const fds = fdUseStatus(processRoot, paths);
  if (fds === "active") return "active";
  if (ownership === "same" && environment === "clear" && cwd === "clear" && fds === "clear") return "clear";
  return uncertainProcessIsGoneOrOlder(name, firstInfo, launcherStart) ? "clear" : "uncertain";
}

function scratchUseStatus(scratch, original = scratch) {
  if (process.platform !== "linux" || process.getuid === undefined) return "uncertain";
  const launcherStart = recordedLauncherStart(scratch);
  if (launcherStart === undefined) return "uncertain";
  let processes;
  try {
    processes = fs.readdirSync("/proc", { withFileTypes: true });
  } catch {
    return "uncertain";
  }
  let uncertain = false;
  for (const entry of processes) {
    if (!/^[0-9]+$/u.test(entry.name)) continue;
    const use = processScratchUseStatus(entry.name, [original, scratch], launcherStart);
    if (use === "active") return "active";
    if (use === "uncertain") uncertain = true;
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

function scratchOwnerIsActive(kind, pid, suffix, launcherStart) {
  const claimMatch = /^([0-9]+)x[0-9a-f]{32}$/u.exec(suffix);
  const ownerStart = kind === "run" ? launcherStart : claimMatch === null ? undefined : BigInt(claimMatch[1]);
  const currentStart = processStartTicks(pid);
  if (ownerStart !== undefined && currentStart === ownerStart) return true;
  // Legacy claims have no recorded start tick. Retain while their owner PID
  // exists, even if it has been reused; new claims include the identity.
  return (currentStart === undefined || ownerStart === undefined) && pidIsAlive(Number(pid));
}

function reapStaleScratch(parent, entry) {
  if (!entry.isDirectory() || process.platform !== "linux") return;
  const match = /^(run|reap)-([1-9][0-9]*)-([A-Za-z0-9]+)$/u.exec(entry.name);
  if (match === null) return;
  const stale = path.join(parent, entry.name);
  const launcherStart = recordedLauncherStart(stale);
  if (launcherStart === undefined) return;
  if (scratchOwnerIsActive(match[1], match[2], match[3], launcherStart)) return;
  const original = recordedOriginalScratch(stale, parent);
  if (original === undefined || !recordedTestGroupIsDead(stale) || scratchUseStatus(stale, original) !== "clear")
    return;
  const claimStart = processStartTicks("self");
  if (claimStart === undefined) return;
  const claimed = path.join(parent, `reap-${process.pid}-${claimStart}x${randomUUID().replaceAll("-", "")}`);
  try {
    fs.renameSync(stale, claimed);
  } catch (error) {
    if (error.code === "ENOENT") return; // Another test launcher claimed it first.
    throw error;
  }
  // An escaped child still has the original run path after the rename.
  if (recordedTestGroupIsDead(claimed) && scratchUseStatus(claimed, original) === "clear") removeScratch(claimed);
}

function createScratch(parent) {
  const scratch = fs.mkdtempSync(path.join(parent, `run-${process.pid}-`));
  try {
    fs.writeFileSync(path.join(scratch, ".test-scratch-origin"), `${scratch}\n`, { mode: 0o600, flag: "wx" });
    if (process.platform === "linux") {
      const start = processStartTicks("self");
      if (start === undefined) throw new Error("Runtime test launcher start time is unavailable from /proc/self/stat");
      fs.writeFileSync(path.join(scratch, ".test-launcher-start"), `${start}\n`, { mode: 0o600, flag: "wx" });
    }
  } catch (error) {
    try {
      removeScratch(scratch);
    } catch (cleanupError) {
      process.stderr.write(`Runtime test scratch setup cleanup failed for ${scratch}: ${String(cleanupError)}\n`);
    }
    throw error;
  }
  return scratch;
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
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) reapStaleScratch(parent, entry);
  return createScratch(parent);
}

function forwardTestSignals(groupId) {
  if (process.platform === "win32" || groupId === undefined) return () => {};
  const handlers = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => {
    const handler = () => signalTestGroup(groupId, signal);
    process.on(signal, handler);
    return [signal, handler];
  });
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

function recordTestGroup(scratch, child) {
  if (child.pid === undefined) return undefined;
  try {
    const pendingMarker = path.join(scratch, ".test-child-pgid.pending");
    fs.writeFileSync(pendingMarker, `${child.pid}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(pendingMarker, path.join(scratch, ".test-child-pgid"));
    return undefined;
  } catch (error) {
    if (process.platform === "win32") child.kill("SIGKILL");
    else signalTestGroup(child.pid, "SIGKILL");
    return error;
  }
}

function observeTestOutput(child, observation) {
  for (const [stream, output] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr]
  ]) {
    let tail = "";
    stream.on("data", (chunk) => {
      const value = tail + String(chunk);
      if (scratchExhaustionOutput.test(value)) observation.diskFull = true;
      tail = value.slice(-40);
    });
    stream.pipe(output, { end: false });
  }
}

function waitForTestChild(child, observation) {
  return new Promise((resolve) => {
    child.once("error", (error) => {
      if (scratchExhaustionError(error)) observation.diskFull = true;
      process.stderr.write(`Runtime test process could not start: ${String(error)}\n`);
      resolve({ status: 1, closed: false, exitCode: undefined });
    });
    child.once("close", (code) => resolve({ status: code ?? 1, closed: true, exitCode: code }));
  });
}

async function runTestChild(args, extraEnv, scratch) {
  let child;
  let stopForwarding = () => {};
  const observation = { diskFull: false };
  try {
    child = spawn(process.execPath, args, {
      env: { ...process.env, ...extraEnv, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
      stdio: ["inherit", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    stopForwarding = forwardTestSignals(child.pid);
    const markerError = recordTestGroup(scratch, child);
    observeTestOutput(child, observation);
    const result = await waitForTestChild(child, observation);
    let status = result.status;
    if (markerError !== undefined) {
      process.stderr.write(`Runtime test scratch owner could not be recorded: ${String(markerError)}\n`);
      status = 1;
    }
    if (observation.diskFull) {
      process.stderr.write(`Runtime tests exhausted scratch space or quota (ENOSPC/EDQUOT) under ${scratch}.\n`);
      status = 1;
    }
    return { ...result, status, groupId: child.pid };
  } catch (error) {
    process.stderr.write(`Runtime test process failed: ${String(error)}\n`);
    return { status: 1, closed: false, exitCode: undefined, groupId: child?.pid };
  } finally {
    stopForwarding();
  }
}

function currentTestGroupIsActive(groupId) {
  return process.platform !== "win32" && groupId !== undefined && processGroupIsAlive(groupId);
}

async function cleanupCurrentScratch(scratch, result) {
  let groupActive = currentTestGroupIsActive(result.groupId);
  let scratchUse = scratchUseStatus(scratch);
  // A worker or unrelated process can exit during /proc enumeration.
  for (
    let attempt = 0;
    attempt < 5 && (groupActive || (process.platform === "linux" && scratchUse === "uncertain"));
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    groupActive = currentTestGroupIsActive(result.groupId);
    scratchUse = scratchUseStatus(scratch);
  }
  // Non-Linux platforms have no proc scan. A closed POSIX runner with a dead
  // group can release scratch; Windows requires a normal successful exit.
  const completedOutsideLinux =
    process.platform !== "linux" &&
    result.closed &&
    Number.isInteger(result.exitCode) &&
    !groupActive &&
    (process.platform !== "win32" || result.exitCode === 0);
  if (groupActive || (scratchUse !== "clear" && !completedOutsideLinux)) {
    process.stderr.write(
      `Runtime test scratch retained for a possibly active test process (group ${groupActive ? "active" : "dead"}, scratch ${scratchUse}): ${scratch}\n`
    );
    // Unrelated processes can make /proc uncertain; preserve test status.
    return groupActive || scratchUse === "active" ? 1 : result.status;
  }
  try {
    removeScratch(scratch);
  } catch (error) {
    process.stderr.write(`Runtime test scratch cleanup failed for ${scratch}: ${String(error)}\n`);
    return 1;
  }
  return result.status;
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
  const result = await runTestChild(args, extraEnv, scratch);
  return cleanupCurrentScratch(scratch, result);
}
