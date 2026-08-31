import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Whether this platform can address an open directory descriptor as a path and
 * traverse through it, which is what workflow execution snapshot publication
 * requires.
 *
 * This is probed rather than tested as `existsSync("/proc/self/fd")`. The
 * platform name and the /proc mount are proxies for the capability, not the
 * capability itself: macOS has no /proc but reaches the same swap-immunity
 * through volfs, and a Linux container can be run with /proc unmounted. Asking
 * for /proc directly skipped every descriptor test on any platform that
 * supports this by another spelling, which is exactly where the coverage was
 * needed.
 *
 * The probe mirrors real use: the descriptor path must name the opened
 * directory and resolve a child through it. A path that merely stats is not
 * enough.
 */
function probeDescriptorPaths(): boolean {
  if (process.platform === "win32") return false;
  let root: string | undefined;
  let descriptor: number | undefined;
  try {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ufz-descriptor-probe-"));
    const child = path.join(root, "child");
    fs.mkdirSync(child, { mode: 0o700 });
    const childInode = fs.statSync(child).ino;
    descriptor = fs.openSync(root, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
    const opened = fs.fstatSync(descriptor);
    for (const candidate of [
      `/proc/self/fd/${descriptor}`,
      `/dev/fd/${descriptor}`,
      `/.vol/${String(opened.dev)}/${String(opened.ino)}`
    ]) {
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isDirectory() || stat.dev !== opened.dev || stat.ino !== opened.ino) continue;
        if (fs.statSync(path.join(candidate, "child")).ino !== childInode) continue;
        return true;
      } catch {
        // Try the next platform descriptor path.
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Best effort.
      }
    }
    if (root !== undefined) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // Best effort.
      }
    }
  }
}

export const descriptorPathsAvailable = probeDescriptorPaths();
