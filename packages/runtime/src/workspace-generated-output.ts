import { lstatSync } from "node:fs";
import path from "node:path";

const SCRATCH_DIRECTORIES = new Set([".cov-work", ".recon"]);
const BUILD_DIRECTORIES = new Set(["out", "build-info", "build-snapshot"]);
const CORPUS_DIRECTORIES = new Set(["recon-corpus", "echidna"]);
const SCRATCH_BUILD_FILES = new Set([
  "build.json",
  "build-info.json",
  "compilation.json",
  "compiler-input.json",
  "compiler-output.json",
  "standard-input.json",
  "standard-output.json"
]);

/**
 * Additional generated outputs, classified per untracked file rather than by
 * dropping a mixed source/scratch directory. The existing root exclusions still
 * prune known large trees before Git enumerates them. These rules also work in
 * nested layouts and below the diff-overflow threshold (#1308).
 *
 * Unknown files stay eligible for capture, including authored sources and JSON
 * configuration beside the output. Tracked entries never call this classifier.
 * Classification must not depend on file contents: replay rebuilds a tree from
 * HEAD, where previously handed-off additions still appear as untracked. A new
 * compiler-shaped value in an authored JSON file must not make that file vanish.
 */
export function isGeneratedWorkspaceOutput(workspaceRoot: string, relativePath: string): boolean {
  const segments = relativePath.split("/");
  const filename = segments.pop() ?? "";
  const scratch = segments.some((segment) => SCRATCH_DIRECTORIES.has(segment));
  const buildJson =
    filename.endsWith(".json") &&
    (segments.some((segment) => BUILD_DIRECTORIES.has(segment) || segment.endsWith(".sol")) ||
      (scratch && SCRATCH_BUILD_FILES.has(filename)));
  const coverage =
    filename === "lcov.info" ||
    filename.endsWith(".lcov") ||
    /^covered\.[0-9]+\.(?:html|txt)$/u.test(filename) ||
    (scratch && filename === "recon-coverage.json");
  const corpus =
    /\.(?:json|bin|txt)$/u.test(filename) &&
    (segments.some((segment) => CORPUS_DIRECTORIES.has(segment)) ||
      (scratch && segments.some((segment) => segment === "corpus")));
  const compilerCache = filename === "solidity-files-cache.json";
  if (!buildJson && !coverage && !corpus && !compilerCache) return false;

  const absolutePath = path.join(workspaceRoot, relativePath);
  // Leave symlinks and other non-files to the existing fail-closed path checks.
  // A concurrently vanished file must still take the normal staging retry path.
  const stat = lstatSync(absolutePath, { throwIfNoEntry: false });
  return stat?.isFile() === true;
}
