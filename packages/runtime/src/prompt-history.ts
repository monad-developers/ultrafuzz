import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  assertNoSymlinkComponents,
  prepareSafeFilePath,
  publishFileDurableExclusive,
  sha256Bytes,
  writeFileDurable
} from "@ultrafuzz/artifacts";

import type { RuntimeDiagnostic } from "./types.js";

const PROMPT_HISTORY_DIR = "prompt-history";
const PROMPT_REFRESH_SCHEMA_VERSION = "ultrafuzz.prompt-refresh.v1";

/** One file the refresh rewrites: a task's rendered prompt, or a template copy for tasks not rendered yet. */
export interface PromptFileChange {
  /** Path relative to the run root. */
  relativePath: string;
  /** Catalog path of the prompt it comes from, such as `setup/project-discovery.md`. */
  prompt: string;
  /** The attempt whose prompt this is; absent for a template copy. */
  attemptId?: string;
  /** The bytes it replaces; absent when the file is missing. */
  previous?: Buffer;
  next: string;
}

/**
 * Copy each file about to be replaced into a new `prompt-history/` entry, then replace it atomically,
 * then record what changed, and describe it. A process killed part way leaves every file whole: each
 * one either holds its old bytes or its new ones, whose old bytes are already in the entry.
 */
export function applyPromptRefresh(runRoot: string, changes: readonly PromptFileChange[]): RuntimeDiagnostic {
  const historyRoot = path.join(runRoot, PROMPT_HISTORY_DIR);
  fs.mkdirSync(historyRoot, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(runRoot, historyRoot, "prompt history");
  const refreshedAt = new Date().toISOString();
  const entry = path.join(historyRoot, `${refreshedAt.replaceAll(":", "-")}-${crypto.randomUUID()}`);
  fs.mkdirSync(entry, { mode: 0o700 });
  for (const change of changes) {
    if (change.previous !== undefined) publishFileDurableExclusive(entry, change.relativePath, change.previous);
    writeFileDurable(prepareSafeFilePath(runRoot, change.relativePath), change.next);
  }
  publishFileDurableExclusive(
    entry,
    "refresh.json",
    `${JSON.stringify(
      {
        schema_version: PROMPT_REFRESH_SCHEMA_VERSION,
        refreshed_at: refreshedAt,
        files: changes.map((change) => ({
          path: change.relativePath,
          ...(change.attemptId === undefined ? {} : { attempt_id: change.attemptId }),
          prompt: `.ultrafuzz/prompts/${change.prompt}`,
          previous_sha256: change.previous === undefined ? null : sha256Bytes(change.previous),
          sha256: sha256Bytes(Buffer.from(change.next, "utf8"))
        }))
      },
      null,
      2
    )}\n`
  );
  return refreshedInfo(path.relative(runRoot, entry).split(path.sep).join("/"), changes);
}

function refreshedInfo(entry: string, changes: readonly PromptFileChange[]): RuntimeDiagnostic {
  const attempts = changes.flatMap((change) => (change.attemptId === undefined ? [] : [change.attemptId])).sort();
  const templates = changes.length - attempts.length;
  const listed = attempts.length <= 10 ? attempts : [...attempts.slice(0, 10), `${String(attempts.length - 10)} more`];
  const targets = [
    ...(attempts.length === 0
      ? []
      : [`${String(attempts.length)} unfinished task${attempts.length === 1 ? "" : "s"} (${listed.join(", ")})`]),
    ...(templates === 0
      ? []
      : [`${String(templates)} template cop${templates === 1 ? "y" : "ies"} that later prompts are rendered from`])
  ];
  return {
    code: "PROMPTS_REFRESHED",
    message: `resume applied the project's current prompts to ${targets.join(" and ")}; the files it replaced and refresh.json are in ${entry}/`,
    severity: "info",
    source: "prompts",
    path: entry
  };
}
