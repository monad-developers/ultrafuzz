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
 * Record the refresh in a new `prompt-history/` entry, then copy each file about to be replaced into
 * it and replace the file atomically, and describe the outcome; it never throws. `refresh.json` is
 * published before the first file changes, so after a failure or a killed process every file it
 * lists holds either its previous bytes or its new ones.
 */
export function applyPromptRefresh(runRoot: string, changes: readonly PromptFileChange[]): RuntimeDiagnostic {
  let entry: string | undefined;
  let replaced = 0;
  try {
    const historyRoot = path.join(runRoot, PROMPT_HISTORY_DIR);
    fs.mkdirSync(historyRoot, { recursive: true, mode: 0o700 });
    assertNoSymlinkComponents(runRoot, historyRoot, "prompt history");
    const refreshedAt = new Date().toISOString();
    const entryPath = path.join(historyRoot, `${refreshedAt.replaceAll(":", "-")}-${crypto.randomUUID()}`);
    fs.mkdirSync(entryPath, { mode: 0o700 });
    publishFileDurableExclusive(entryPath, "refresh.json", refreshRecord(refreshedAt, changes));
    entry = path.relative(runRoot, entryPath).split(path.sep).join("/");
    for (const change of changes) {
      if (change.previous !== undefined) publishFileDurableExclusive(entryPath, change.relativePath, change.previous);
      writeFileDurable(prepareSafeFilePath(runRoot, change.relativePath), change.next);
      replaced += 1;
    }
    return refreshedInfo(entry, changes);
  } catch (error) {
    return incompleteWarning(error, entry, replaced, changes.length);
  }
}

function refreshRecord(refreshedAt: string, changes: readonly PromptFileChange[]): string {
  return `${JSON.stringify(
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
  )}\n`;
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

function incompleteWarning(
  error: unknown,
  entry: string | undefined,
  replaced: number,
  planned: number
): RuntimeDiagnostic {
  const outcome =
    entry === undefined
      ? "no prompt file changed"
      : `${entry}/refresh.json lists every file it planned, and each holds either its previous bytes or its new ones`;
  return {
    code: "PROMPT_REFRESH_INCOMPLETE",
    message: `resume stopped applying the project's current prompts after ${String(replaced)} of ${String(planned)} files: ${error instanceof Error ? error.message : String(error)}; ${outcome}. Resume again once the cause is fixed.`,
    severity: "warning",
    source: "prompts",
    ...(entry === undefined ? {} : { path: entry })
  };
}
