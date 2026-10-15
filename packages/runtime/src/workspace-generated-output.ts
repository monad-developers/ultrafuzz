import { lstatSync } from "node:fs";
import path from "node:path";

import { isRecord, parseStrictJsonBytes, readRegularFileSnapshot } from "@ultrafuzz/artifacts";

const SCRATCH_DIRECTORIES = new Set([".cov-work", ".recon"]);
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
// Do not read arbitrarily large payloads just to classify a path. Unknown or
// oversized output stays eligible for capture and measured overflow recovery.
const MAX_COMPILER_ARTIFACT_BYTES = 16 * 1024 * 1024;

/**
 * Additional generated outputs, classified per untracked file rather than by
 * dropping a mixed source/scratch directory. The existing root exclusions still
 * prune known large trees before Git enumerates them. These rules also work in
 * nested layouts and below the diff-overflow threshold (#1308).
 *
 * Unknown files stay eligible for capture, including authored sources and JSON
 * configuration beside the output. Tracked entries never call this classifier.
 * Previously handed-off paths are also preserved by explicit tree/manifest
 * authority: an authored JSON file acquiring compiler fields cannot vanish from
 * its next patch or from replay's reconstruction of an authenticated tree.
 */
export function isGeneratedWorkspaceOutput(workspaceRoot: string, relativePath: string): boolean {
  const segments = relativePath.split("/");
  const filename = segments.pop() ?? "";
  const scratch = segments.some((segment) => SCRATCH_DIRECTORIES.has(segment));
  const sourceFilename = segments.at(-1) ?? "";
  const compilerLayout = segments.at(-2) === "out" && sourceFilename.endsWith(".sol") && filename.endsWith(".json");
  const namedOutput = isNamedOutput(segments, filename, scratch);
  if (!namedOutput && !compilerLayout) return false;

  const absolutePath = path.join(workspaceRoot, relativePath);
  // Leave symlinks and other non-files to the existing fail-closed path checks.
  // A concurrently vanished file must still take the normal staging retry path.
  const stat = lstatSync(absolutePath, { throwIfNoEntry: false });
  if (stat?.isFile() !== true) return false;
  return namedOutput || isCompilerArtifact(absolutePath, sourceFilename, filename);
}

function isNamedOutput(segments: readonly string[], filename: string, scratch: boolean): boolean {
  return (
    (scratch && SCRATCH_BUILD_FILES.has(filename)) ||
    isBuildSnapshot(segments, filename, scratch) ||
    isCoverageOutput(filename, scratch) ||
    isCorpusOutput(segments, filename, scratch) ||
    filename === "solidity-files-cache.json"
  );
}

function isBuildSnapshot(segments: readonly string[], filename: string, scratch: boolean): boolean {
  const parent = segments.at(-1) ?? "";
  return (
    (parent === "build-info" || parent === "build-snapshot") &&
    /^[0-9a-f]{8,64}\.json$/u.test(filename) &&
    (scratch || segments.slice(0, -1).some((segment) => segment === "out" || CORPUS_DIRECTORIES.has(segment)))
  );
}

function isCoverageOutput(filename: string, scratch: boolean): boolean {
  return (
    filename === "lcov.info" ||
    filename.endsWith(".lcov") ||
    /^covered\.[0-9]+\.(?:html|txt)$/u.test(filename) ||
    (scratch && filename === "recon-coverage.json")
  );
}

function isCorpusOutput(segments: readonly string[], filename: string, scratch: boolean): boolean {
  return (
    /\.(?:json|bin|txt)$/u.test(filename) &&
    (segments.some((segment) => CORPUS_DIRECTORIES.has(segment)) || (scratch && segments.includes("corpus")))
  );
}

function isCompilerArtifact(absolutePath: string, sourceFilename: string, filename: string): boolean {
  // Foundry names JSON after the compiled type, not its source: Harness.t.sol
  // produces Harness.json, and one source can produce several differently named
  // types. Positive compiler structure plus its matching compilation target
  // distinguishes these from authored config/cases in the same output layout.
  try {
    const artifact = parseStrictJsonBytes(readRegularFileSnapshot(absolutePath, MAX_COMPILER_ARTIFACT_BYTES), {
      maxBytes: MAX_COMPILER_ARTIFACT_BYTES
    });
    return (
      isRecord(artifact) &&
      Array.isArray(artifact.abi) &&
      isBytecode(artifact.bytecode) &&
      isBytecode(artifact.deployedBytecode) &&
      matchesCompilationTarget(artifact.metadata, sourceFilename, filename)
    );
  } catch {
    // Malformed, ambiguous, oversized, unreadable, or changing files are not
    // proven generated output; keep them on the normal fail-closed path.
    return false;
  }
}

function isBytecode(value: unknown): boolean {
  return isRecord(value) && typeof value.object === "string";
}

function matchesCompilationTarget(metadata: unknown, sourceFilename: string, filename: string): boolean {
  if (!isRecord(metadata) || metadata.language !== "Solidity") return false;
  if (!isRecord(metadata.compiler) || typeof metadata.compiler.version !== "string") return false;
  if (!isRecord(metadata.settings) || !isRecord(metadata.settings.compilationTarget)) return false;
  const targets = Object.entries(metadata.settings.compilationTarget);
  return (
    targets.length === 1 &&
    targets.some(
      ([source, type]) =>
        typeof type === "string" && path.posix.basename(source) === sourceFilename && `${type}.json` === filename
    )
  );
}
