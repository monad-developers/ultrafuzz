import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function restoreWritePermissions(root) {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) return;
  fs.chmodSync(root, stat.mode | (stat.isDirectory() ? 0o700 : 0o600));
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() || entry.isFile()) restoreWritePermissions(path.join(root, entry.name));
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

function activeTestChild(root) {
  let marker;
  try {
    marker = fs.readFileSync(path.join(root, ".test-child-pid"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  const pid = Number(marker.trim());
  return Number.isSafeInteger(pid) && pid > 0 && pidIsAlive(pid);
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
    if (activeTestChild(stale)) continue;
    const claimed = path.join(parent, `reap-${process.pid}-${randomUUID().replaceAll("-", "")}`);
    try {
      fs.renameSync(stale, claimed);
    } catch (error) {
      if (error.code === "ENOENT") continue; // Another test launcher claimed it first.
      throw error;
    }
    removeScratch(claimed);
  }
  return fs.mkdtempSync(path.join(parent, `run-${process.pid}-`));
}

export async function runTests(args, extraEnv = {}) {
  let scratch;
  try {
    scratch = ownedScratchDirectory();
  } catch (error) {
    process.stderr.write(
      `Runtime test scratch setup failed${error.code === "ENOSPC" ? " (disk full, ENOSPC)" : ""}: ${String(error)}\n`
    );
    return 1;
  }

  let status;
  let diskFull = false;
  try {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...extraEnv, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
      stdio: ["inherit", "pipe", "pipe"]
    });
    let markerError;
    if (child.pid !== undefined) {
      try {
        fs.writeFileSync(path.join(scratch, ".test-child-pid"), `${child.pid}\n`, { mode: 0o600 });
      } catch (error) {
        markerError = error;
        child.kill("SIGKILL");
      }
    }
    for (const [stream, output] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr]
    ]) {
      let tail = "";
      stream.on("data", (chunk) => {
        const text = tail + String(chunk);
        if (text.includes("ENOSPC")) diskFull = true;
        tail = text.slice(-5);
      });
      stream.pipe(output, { end: false });
    }
    status = await new Promise((resolve) => {
      child.once("error", (error) => {
        if (error.code === "ENOSPC") diskFull = true;
        process.stderr.write(`Runtime test process could not start: ${String(error)}\n`);
        resolve(1);
      });
      child.once("close", (code) => resolve(code ?? 1));
    });
    if (markerError !== undefined) {
      process.stderr.write(`Runtime test scratch owner could not be recorded: ${String(markerError)}\n`);
      status = 1;
    }
    if (diskFull) {
      process.stderr.write(`Runtime tests exhausted scratch space (ENOSPC) under ${scratch}.\n`);
      status = 1;
    }
  } finally {
    try {
      removeScratch(scratch);
    } catch (error) {
      process.stderr.write(`Runtime test scratch cleanup failed for ${scratch}: ${String(error)}\n`);
      status = 1;
    }
  }
  return status;
}
