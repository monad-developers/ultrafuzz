import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

import type { WorkspacePatchCapture } from "../../src/workspace-handoff.js";
import { temporaryRoot } from "../temporary-root.js";

/** Build a valid v1 fixture with Git, without the new generated-file classifier. */
export function captureLegacyWorkspacePatch(root: string, baseline: string): WorkspacePatchCapture {
  const index = path.join(temporaryRoot("ultrafuzz-legacy-index-"), "index");
  const indexedGit = (args: string[]): string =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_INDEX_FILE: index }
    });
  indexedGit(["read-tree", baseline]);
  indexedGit(["add", "-A"]);
  const patch = indexedGit(["diff", "--cached", "--binary", "--no-renames", baseline]);
  return {
    patch,
    manifest: {
      schema_version: "ultrafuzz.workspace-patch.v1",
      base_commit: indexedGit(["rev-parse", "HEAD"]).trim(),
      base_tree: baseline,
      result_tree: indexedGit(["write-tree"]).trim(),
      patch_sha256: createHash("sha256").update(patch).digest("hex"),
      files: indexedGit(["diff", "--cached", "--name-only", "-z", "--no-renames", baseline])
        .split("\0")
        .filter(Boolean)
        .sort()
        .map((filename) => ({ path: filename })),
      source_snapshot: { status: "preserved", protected_roots: ["src", "contracts"] }
    }
  };
}
