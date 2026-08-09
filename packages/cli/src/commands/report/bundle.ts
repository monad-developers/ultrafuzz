import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Args, Command, Flags } from "@oclif/core";
import {
  assertNoSymlinkComponents,
  assertPathInside,
  assertRegularFileInside,
  layoutForRunRoot,
  readRegularFileSnapshot,
  readRunState,
  validateSafeId
} from "@ultrafuzz/artifacts";
import { runsRootForProject, type RuntimeDiagnostic } from "@ultrafuzz/runtime";
import AdmZip from "adm-zip";

import { commandFailure, emitCommandResult, globalFlags, projectRoot } from "../../command-shared.js";
import { loadValidatedReportSnapshot, type ValidatedReportSnapshot } from "../../report-artifacts.js";

const TOP_LEVEL_RUN_FILES = [
  "attempts.jsonl",
  "config.redactions.json",
  "config.resolved.toml",
  "events.jsonl",
  "graph.fingerprint",
  "graph.json",
  "plan.json",
  "run.json",
  "state.json",
  "usage.jsonl"
] as const;

const INCLUDED_DIRECTORIES = ["artifacts", "review", "events.index"] as const;

// Engine logs carry the per-attempt retry and validation evidence that explains
// why a node failed, which nothing else in the run root records. They ship under
// a neutral archive prefix so the bundle does not name the orchestration engine.
const RENAMED_DIRECTORIES = [{ source: "smithers/logs", archive: "engine-logs" }] as const;
const MAX_BUNDLE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_BUNDLE_TOTAL_BYTES = 512 * 1024 * 1024;

interface BundleData {
  zip_path: string;
  bytes: number;
  sha256: string;
  entry_count: number;
  included_roots: string[];
  excluded_roots: string[];
}

interface BundleFile {
  absolutePath: string;
  archivePath: string;
  contents: Buffer;
}

export default class ReportBundle extends Command {
  static override summary = "Create a ZIP bundle of report artifacts for a run";
  static override args = { runId: Args.string({ required: true, description: "Ultrafuzz run ID" }) };
  static override flags = {
    ...globalFlags,
    output: Flags.string({
      char: "o",
      summary: "Output ZIP path; relative paths resolve from the project root"
    }),
    force: Flags.boolean({
      summary: "Overwrite the output ZIP if it already exists"
    })
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ReportBundle);
    const root = projectRoot(flags);
    const commandName = "report bundle";
    try {
      const runsRoot = await runsRootForProject(root);
      const runId = validateSafeId(args.runId, "run ID");
      const layout = layoutForRunRoot(path.join(runsRoot, runId), runId);
      assertPathInside(runsRoot, layout.root, "run root");
      assertNoSymlinkComponents(runsRoot, layout.root, "run root");

      const outputPath = resolveOutputPath(root, runId, flags.output);
      const outputDirectory = path.dirname(outputPath);
      assertOutputIsOutsideRun(layout.root, outputPath);
      const existingOutput = lstatIfPresent(outputPath);
      if (existingOutput?.isSymbolicLink() === true) {
        throw new Error(`output ZIP cannot be a symlink: ${outputPath}`);
      }
      if (existingOutput !== undefined && !existingOutput.isFile()) {
        throw new Error(`output ZIP path exists and is not a regular file: ${outputPath}`);
      }
      if (existingOutput !== undefined && flags.force !== true) {
        throw new Error(`output ZIP already exists; pass --force to overwrite: ${outputPath}`);
      }
      const outputGuardRoot = path.parse(outputDirectory).root;
      assertNoSymlinkComponents(outputGuardRoot, nearestExistingAncestor(outputDirectory), "output directory");
      fs.mkdirSync(outputDirectory, { recursive: true });
      assertNoSymlinkComponents(outputGuardRoot, outputDirectory, "output directory");

      const diagnostics: RuntimeDiagnostic[] = [];
      const validatedReport = hasFinalReportJson(layout.root, layout.artifactsDir)
        ? loadValidatedReportSnapshot(layout.root)
        : undefined;
      const files = collectBundleFiles(layout.root, diagnostics);
      if (validatedReport !== undefined) assertValidatedReportBundleSnapshot(files, validatedReport);
      if (files.length === 0) {
        throw new Error("run has no report bundle artifacts to package");
      }

      const zip = new AdmZip();
      for (const file of files) {
        zip.addFile(file.archivePath, file.contents);
      }
      const manifest = {
        schema_version: "ultrafuzz.report_bundle.v1",
        run_id: runId,
        created_at: new Date().toISOString(),
        included_roots: [
          ...TOP_LEVEL_RUN_FILES,
          ...INCLUDED_DIRECTORIES,
          ...RENAMED_DIRECTORIES.map((entry) => entry.archive)
        ],
        excluded_roots: ["workspaces"],
        excluded_patterns: ["artifacts/final-report/report.json.pre-*"],
        entry_count_without_manifest: files.length
      };
      zip.addFile("bundle-manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
      writeZipSafely(zip, outputPath);

      const data: BundleData = {
        zip_path: outputPath,
        bytes: fs.statSync(outputPath).size,
        sha256: sha256File(outputPath),
        entry_count: files.length + 1,
        included_roots: [
          ...TOP_LEVEL_RUN_FILES,
          ...INCLUDED_DIRECTORIES,
          ...RENAMED_DIRECTORIES.map((entry) => entry.archive)
        ],
        excluded_roots: ["workspaces"]
      };

      emitCommandResult(
        this,
        commandName,
        {
          ok: true,
          command: commandName,
          data,
          text: `Report bundle: ${data.zip_path}\nSHA256: ${data.sha256}\nEntries: ${data.entry_count}\n`,
          diagnostics
        },
        flags.json === true
      );
    } catch (error) {
      emitCommandResult(
        this,
        commandName,
        commandFailure(commandName, error instanceof Error ? error.message : String(error), "REPORT_BUNDLE_FAILED"),
        flags.json === true
      );
    }
  }
}

function assertValidatedReportBundleSnapshot(files: readonly BundleFile[], report: ValidatedReportSnapshot): void {
  const expected = [
    { path: report.artifacts.json_path, contents: report.json_bytes },
    { path: report.artifacts.markdown_path, contents: report.markdown_bytes }
  ];
  for (const entry of expected) {
    const captured = files.find((file) => file.absolutePath === entry.path);
    if (captured === undefined || !captured.contents.equals(entry.contents)) {
      throw new Error(`validated report changed before its immutable bundle snapshot was captured: ${entry.path}`);
    }
  }
}

function resolveOutputPath(project: string, runId: string, requested: string | undefined): string {
  if (requested !== undefined) {
    return path.resolve(path.isAbsolute(requested) ? requested : path.join(project, requested));
  }
  return path.join(project, ".ultrafuzz", "bundles", `${runId}-report-bundle.zip`);
}

function assertOutputIsOutsideRun(runRoot: string, outputPath: string): void {
  const relative = path.relative(path.resolve(runRoot), path.resolve(outputPath));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("output ZIP must be outside the run root to avoid self-including bundles");
  }
}

function hasFinalReportJson(runRoot: string, artifactsDirectory: string): boolean {
  if (!fs.existsSync(artifactsDirectory)) {
    return false;
  }
  assertPathInside(runRoot, artifactsDirectory, "report artifacts directory");
  assertNoSymlinkComponents(runRoot, artifactsDirectory, "report artifacts directory");

  const nodeIds = new Set(["final-report"]);
  const statePath = path.join(runRoot, "state.json");
  if (fs.existsSync(statePath)) {
    assertRegularFileInside(runRoot, statePath, "run state path");
    const state = readRunState(layoutForRunRoot(runRoot));
    for (const [nodeId, nodeState] of Object.entries(state.nodes)) {
      if (nodeState.logical_node_id === "final-report") {
        nodeIds.add(validateSafeId(nodeId, "final report node ID"));
      }
    }
  }
  for (const nodeId of nodeIds) {
    const reportJsonPath = path.join(artifactsDirectory, nodeId, "report.json");
    if (lstatIfPresent(reportJsonPath) === undefined) {
      continue;
    }
    assertRegularFileInside(runRoot, reportJsonPath, "report JSON path");
    return true;
  }
  return false;
}

function collectBundleFiles(runRoot: string, diagnostics: RuntimeDiagnostic[]): BundleFile[] {
  const files: BundleFile[] = [];

  for (const relativePath of TOP_LEVEL_RUN_FILES) {
    const absolutePath = path.join(runRoot, relativePath);
    if (fs.existsSync(absolutePath)) {
      addBundleFile(runRoot, absolutePath, relativePath, files, diagnostics);
    }
  }

  for (const relativeDirectory of INCLUDED_DIRECTORIES) {
    const absoluteDirectory = path.join(runRoot, ...relativeDirectory.split("/"));
    if (fs.existsSync(absoluteDirectory)) {
      collectDirectory(runRoot, absoluteDirectory, files, diagnostics);
    }
  }

  for (const renamed of RENAMED_DIRECTORIES) {
    const absoluteDirectory = path.join(runRoot, ...renamed.source.split("/"));
    if (fs.existsSync(absoluteDirectory)) {
      collectDirectory(runRoot, absoluteDirectory, files, diagnostics, {
        sourceRoot: absoluteDirectory,
        archiveRoot: renamed.archive
      });
    }
  }

  const totalBytes = files.reduce((total, file) => total + file.contents.byteLength, 0);
  if (totalBytes > MAX_BUNDLE_TOTAL_BYTES) {
    throw new Error(`report bundle inputs exceed the ${MAX_BUNDLE_TOTAL_BYTES}-byte limit`);
  }
  return files.sort((left, right) => left.archivePath.localeCompare(right.archivePath));
}

interface ArchiveRename {
  sourceRoot: string;
  archiveRoot: string;
}

function collectDirectory(
  runRoot: string,
  absoluteDirectory: string,
  files: BundleFile[],
  diagnostics: RuntimeDiagnostic[],
  rename?: ArchiveRename
): void {
  assertPathInside(runRoot, absoluteDirectory, "bundle directory");
  assertNoSymlinkComponents(runRoot, absoluteDirectory, "bundle directory");
  for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const absolutePath = path.join(absoluteDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      diagnostics.push(skippedSymlinkDiagnostic(runRoot, absolutePath));
      continue;
    }
    if (entry.isDirectory()) {
      collectDirectory(runRoot, absolutePath, files, diagnostics, rename);
      continue;
    }
    if (entry.isFile()) {
      const archivePath =
        rename === undefined
          ? displayRelativePath(runRoot, absolutePath)
          : `${rename.archiveRoot}/${displayRelativePath(rename.sourceRoot, absolutePath)}`;
      if (shouldExcludeArchivePath(archivePath)) {
        continue;
      }
      addBundleFile(runRoot, absolutePath, archivePath, files, diagnostics);
    }
  }
}

function addBundleFile(
  runRoot: string,
  absolutePath: string,
  archivePath: string,
  files: BundleFile[],
  diagnostics: RuntimeDiagnostic[]
): void {
  try {
    assertRegularFileInside(runRoot, absolutePath, "bundle file");
    files.push({
      absolutePath,
      archivePath: normalizeArchivePath(archivePath),
      contents: readRegularFileSnapshot(absolutePath, MAX_BUNDLE_FILE_BYTES)
    });
  } catch (error) {
    diagnostics.push({
      code: "REPORT_BUNDLE_FILE_SKIPPED",
      message: `skipped unsafe bundle file ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
      severity: "warning",
      source: "report-bundle",
      path: absolutePath
    });
  }
}

function normalizeArchivePath(relativePath: string): string {
  const archivePath = relativePath.split(path.sep).join("/");
  if (
    archivePath.length === 0 ||
    archivePath.startsWith("/") ||
    archivePath.includes("\\") ||
    archivePath.includes("\0") ||
    hasControlCharacter(archivePath)
  ) {
    throw new Error(`unsafe archive path: ${JSON.stringify(relativePath)}`);
  }
  const normalized = path.posix.normalize(archivePath);
  if (normalized !== archivePath || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`unsafe archive path: ${JSON.stringify(relativePath)}`);
  }
  for (const segment of archivePath.split("/")) {
    if (segment.length === 0 || segment === "." || segment === ".." || segment.includes(":")) {
      throw new Error(`unsafe archive path segment: ${JSON.stringify(segment)}`);
    }
  }
  return archivePath;
}

function shouldExcludeArchivePath(archivePath: string): boolean {
  return /^artifacts\/final-report\/report\.json\.pre-/u.test(archivePath);
}

function skippedSymlinkDiagnostic(runRoot: string, absolutePath: string): RuntimeDiagnostic {
  return {
    code: "REPORT_BUNDLE_SYMLINK_SKIPPED",
    message: `skipped symlink while creating report bundle: ${displayRelativePath(runRoot, absolutePath)}`,
    severity: "warning",
    source: "report-bundle",
    path: absolutePath
  };
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function displayRelativePath(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function lstatIfPresent(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function nearestExistingAncestor(candidate: string): string {
  let current = path.resolve(candidate);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return current;
}

function writeZipSafely(zip: AdmZip, outputPath: string): void {
  const outputDirectory = path.dirname(outputPath);
  const outputBase = path.basename(outputPath);
  const tempPath = reserveTempPath(outputDirectory, outputBase);
  try {
    zip.writeZip(tempPath);
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, outputPath);
  } catch (error) {
    try {
      unlinkIfPresent(tempPath);
    } catch (cleanupError) {
      throw new Error(
        `failed to clean up temporary ZIP output ${tempPath}: ${
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }; original write failure: ${error instanceof Error ? error.message : String(error)}`,
        { cause: cleanupError }
      );
    }
    throw error;
  }
}

function reserveTempPath(outputDirectory: string, outputBase: string): string {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = crypto.randomBytes(8).toString("hex");
    const tempPath = path.join(outputDirectory, `.${outputBase}.${process.pid}.${suffix}.tmp`);
    if (lstatIfPresent(tempPath)?.isSymbolicLink() === true) {
      continue;
    }
    try {
      const handle = fs.openSync(tempPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.closeSync(handle);
      return tempPath;
    } catch (error) {
      if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }
  throw new Error("unable to reserve a temporary ZIP output path");
}

function unlinkIfPresent(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}
