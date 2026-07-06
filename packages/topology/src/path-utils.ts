import { lstatSync } from "node:fs";
import path from "node:path";

import { topologyError } from "./errors.js";

export function isSafeId(value: string): boolean {
  return value.length > 0 && /^[a-z0-9_-]+$/.test(value) && value !== "." && value !== "..";
}

export function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes("\\")) {
    return false;
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return false;
  }
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

export function assertSafeRelativePath(kind: string, value: string, code = "INVALID_PROMPT_PATH"): void {
  if (!isSafeRelativePath(value)) {
    throw topologyError(code as never, `Invalid ${kind} path: ${value}`, { path: value, kind });
  }
}

export function ensureInside(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw topologyError("INVALID_PROMPT_PATH", `Path escapes root: ${candidate}`, { path: candidate, root });
}

export function ensureNoSymlinkComponents(candidate: string): void {
  let current = path.isAbsolute(candidate) ? path.parse(candidate).root : "";
  for (const part of path.resolve(candidate).slice(path.parse(candidate).root.length).split(path.sep)) {
    if (part.length === 0) {
      continue;
    }
    current = path.join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw topologyError("SYMLINK_PATH", `Topology path contains a symlink component: ${current}`, {
          path: current
        });
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
}

export function titleFromId(id: string): string {
  return id
    .replace(/^__|__$/g, "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
