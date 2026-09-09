import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Args, Command, Flags } from "@oclif/core";
import {
  DEFAULT_STRICT_JSONL_MAX_BYTES,
  DEFAULT_STRICT_JSONL_MAX_RECORD_BYTES,
  DEFAULT_STRICT_JSONL_MAX_RECORDS,
  assertEventRecord,
  assertNoSymlinkComponents,
  assertPathInside,
  assertRegularFileInside,
  layoutForRunRoot,
  parseStrictJsonBytes,
  readRegularFileSnapshot,
  validateStrictJsonlHistory,
  type EventRecord,
  type StrictJsonlCodec,
  validateSafeId
} from "@ultrafuzz/artifacts";
import {
  assertReportSnapshotRemainedCurrent,
  assertVerifiedRunOutputAuthorityRemainedCurrent,
  isVerifiedOutputAuthorityUnavailable,
  loadVerifiedRunOutputAuthoritySnapshot,
  runsRootForProject,
  type RuntimeDiagnostic,
  type VerifiedRunOutputAuthoritySnapshot
} from "@ultrafuzz/runtime";
import AdmZip from "adm-zip";

import { commandFailure, emitCommandResult, globalFlags, projectRoot } from "../../command-shared.js";
import { validateReportBundleManifest } from "../../cli-schema-registry.js";
import { loadReportArtifactsSnapshot, type ReportArtifactsSnapshot } from "../../report-artifacts.js";

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
  scope?: "report-only";
  verification?: "verified" | "not-checked";
}

interface BundleFile {
  absolutePath: string;
  archivePath: string;
  contents: Buffer;
  sourceArchivePath?: string;
}

interface ReportBundleManifest {
  schema_version: "ultrafuzz.report-bundle-manifest.v3";
  run_id: string;
  created_at: string;
  included_roots: string[];
  excluded_roots: ["workspaces"];
  excluded_patterns: ["artifacts/final-report/report.json.pre-*"];
  path_mappings: Array<{ source_path: string; archive_path: string }>;
  entry_count_without_manifest: number;
  scope?: "report-only";
  verification?: "verified" | "not-checked";
}

export default class ReportBundle extends Command {
  static override summary = "Create a ZIP bundle of report artifacts for a run";
  static override args = { runId: Args.string({ required: true, description: "Ultrafuzz run ID" }) };
  static override flags = {
    ...globalFlags,
    "require-verified": Flags.boolean({ summary: "Require a verified full-run bundle" }),
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
      let files: BundleFile[];
      let reportOnly: ReportArtifactsSnapshot | undefined;
      try {
        files = collectVerifiedBundleFiles(
          layout.root,
          layout.eventsPath,
          runId,
          diagnostics,
          !flags["require-verified"]
        );
      } catch (error) {
        if (flags["require-verified"]) throw error;
        reportOnly = loadReportArtifactsSnapshot(layout.root);
        files = [
          { absolutePath: reportOnly.artifacts.json_path, archivePath: "report.json", contents: reportOnly.json_bytes },
          {
            absolutePath: reportOnly.artifacts.markdown_path,
            archivePath: "report.md",
            contents: reportOnly.markdown_bytes
          }
        ];
        assertReportSnapshotRemainedCurrent(reportOnly);
        diagnostics.push({
          code: "REPORT_BUNDLE_REPORT_ONLY",
          severity: "warning",
          source: "report",
          message: `This archive contains only the available report pair: ${
            error instanceof Error ? error.message : String(error)
          }`
        });
      }
      const includedRoots =
        reportOnly === undefined
          ? [...TOP_LEVEL_RUN_FILES, ...INCLUDED_DIRECTORIES, ...RENAMED_DIRECTORIES.map((entry) => entry.archive)]
          : ["report.json", "report.md"];
      const reportOnlyLabels =
        reportOnly === undefined
          ? {}
          : {
              scope: "report-only" as const,
              verification: reportOnly.verification
            };
      if (files.length === 0) {
        throw new Error("run has no report bundle artifacts to package");
      }

      const zip = new AdmZip();
      for (const file of files) {
        zip.addFile(file.archivePath, file.contents);
      }
      const manifest: ReportBundleManifest = {
        schema_version: "ultrafuzz.report-bundle-manifest.v3",
        run_id: runId,
        created_at: new Date().toISOString(),
        included_roots: includedRoots,
        ...reportOnlyLabels,
        excluded_roots: ["workspaces"],
        excluded_patterns: ["artifacts/final-report/report.json.pre-*"],
        path_mappings: files.flatMap((file) =>
          file.sourceArchivePath === undefined
            ? []
            : [{ source_path: file.sourceArchivePath, archive_path: file.archivePath }]
        ),
        entry_count_without_manifest: files.length
      };
      const manifestValidation = validateReportBundleManifest(manifest);
      if (!manifestValidation.ok) {
        const summary = manifestValidation.issues
          .slice(0, 10)
          .map((issue) => `${issue.instancePath || "/"} ${issue.keyword}: ${issue.message}`)
          .join("; ");
        throw new Error(`report bundle manifest is invalid: ${summary}`);
      }
      zip.addFile("bundle-manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
      writeZipSafely(zip, outputPath);

      const data: BundleData = {
        zip_path: outputPath,
        bytes: fs.statSync(outputPath).size,
        sha256: sha256File(outputPath),
        entry_count: files.length + 1,
        included_roots: includedRoots,
        ...reportOnlyLabels,
        excluded_roots: ["workspaces"]
      };

      emitCommandResult(
        this,
        commandName,
        {
          ok: true,
          command: commandName,
          data,
          text: `Report bundle: ${data.zip_path}\n${reportOnly === undefined ? "" : `Scope: report-only\nVerification: ${reportOnly.verification}\n`}SHA256: ${data.sha256}\nEntries: ${String(data.entry_count)}\n`,
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

function collectVerifiedBundleFiles(
  runRoot: string,
  eventsPath: string,
  runId: string,
  diagnostics: RuntimeDiagnostic[],
  preferBestEffort: boolean
): BundleFile[] {
  assertCurrentBundleAuthorityPresent(runRoot);
  const authority = loadVerifiedRunOutputAuthoritySnapshot(runRoot);
  const report = loadDeclaredReportArtifactsSnapshot(runRoot);
  if (preferBestEffort && report !== undefined && loadReportArtifactsSnapshot(runRoot).verification === "not-checked") {
    throw new Error("the selected report includes available findings that have not received final review");
  }
  const eventJournal = loadValidatedEventJournalSnapshot(runRoot, eventsPath, runId);
  const files = collectBundleFiles(runRoot, diagnostics, eventJournal, report);
  assertVerifiedRunAuthorityBundleSnapshots(files, authority);
  if (report !== undefined) assertValidatedReportBundleSnapshot(files, report);
  assertVerifiedRunOutputAuthorityRemainedCurrent(authority);
  if (report !== undefined) {
    assertReportSnapshotRemainedCurrent(report);
  } else if (loadDeclaredReportArtifactsSnapshot(runRoot) !== undefined) {
    throw new Error("report authority appeared while bundle inputs were being captured");
  }
  return files;
}

function assertValidatedReportBundleSnapshot(files: readonly BundleFile[], report: ReportArtifactsSnapshot): void {
  const expected = [
    { path: report.artifacts.json_path, contents: report.json_bytes },
    { path: report.artifacts.markdown_path, contents: report.markdown_bytes },
    ...(report.publications ?? []).map((publication) => ({ path: publication.path, contents: publication.bytes }))
  ];
  for (const entry of expected) {
    const captured = files.find((file) => file.absolutePath === entry.path);
    if (captured === undefined || !captured.contents.equals(entry.contents)) {
      throw new Error(`validated report changed before its immutable bundle snapshot was captured: ${entry.path}`);
    }
  }
}

function assertCurrentBundleAuthorityPresent(runRoot: string): void {
  const smithersRoot = path.join(runRoot, "smithers");
  const required = [path.join(smithersRoot, "tasks.json"), path.join(smithersRoot, "control-integrity.json")];
  if (required.some((authorityPath) => lstatIfPresent(authorityPath) === undefined)) {
    throw new Error(
      "report bundling for historical or unsealed runs is unsupported; current sealed workflow authority is required"
    );
  }
}

function loadDeclaredReportArtifactsSnapshot(runRoot: string): ReportArtifactsSnapshot | undefined {
  try {
    return loadReportArtifactsSnapshot(runRoot, { requireVerified: true });
  } catch (error) {
    if (isVerifiedOutputAuthorityUnavailable(error)) return undefined;
    throw error;
  }
}

function assertVerifiedRunAuthorityBundleSnapshots(
  files: readonly BundleFile[],
  authority: VerifiedRunOutputAuthoritySnapshot
): void {
  const capturedByPath = new Map<string, BundleFile>();
  const capturedArchivePaths = new Set<string>();
  for (const file of files) {
    const absolutePath = path.resolve(file.absolutePath);
    if (capturedByPath.has(absolutePath)) {
      throw new Error(`report bundle captured the same physical file more than once: ${absolutePath}`);
    }
    if (capturedArchivePaths.has(file.archivePath)) {
      throw new Error(`report bundle captured the same archive path more than once: ${file.archivePath}`);
    }
    capturedByPath.set(absolutePath, file);
    capturedArchivePaths.add(file.archivePath);
  }
  for (const snapshot of authority.outputs) {
    for (const publication of snapshot.publications) {
      const captured = capturedByPath.get(path.resolve(publication.absolute_path));
      if (captured === undefined || !captured.contents.equals(publication.bytes)) {
        throw new Error(
          `verified publication changed before its immutable bundle snapshot was captured: ${publication.absolute_path}`
        );
      }
    }
  }
  for (const document of [authority.state, authority.graph, authority.graph_fingerprint]) {
    const captured = capturedByPath.get(path.resolve(document.path));
    if (captured === undefined || !captured.contents.equals(document.bytes)) {
      throw new Error(`run authority changed before its immutable bundle snapshot was captured: ${document.path}`);
    }
  }
  for (const manifest of authority.artifact_manifests) {
    const captured = capturedByPath.get(path.resolve(manifest.path));
    if (captured === undefined || !captured.contents.equals(manifest.bytes)) {
      throw new Error(
        `artifact manifest authority changed before its immutable bundle snapshot was captured: ${manifest.path}`
      );
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

function loadValidatedEventJournalSnapshot(
  runRoot: string,
  eventsPath: string,
  expectedRunId: string
): BundleFile | undefined {
  const stat = lstatIfPresent(eventsPath);
  if (stat === undefined) return undefined;
  if (stat.isSymbolicLink()) throw new Error(`event journal cannot be a symlink: ${eventsPath}`);
  if (!stat.isFile()) throw new Error(`event journal is not a regular file: ${eventsPath}`);

  assertRegularFileInside(runRoot, eventsPath, "event journal");
  const contents = readRegularFileSnapshot(eventsPath, DEFAULT_STRICT_JSONL_MAX_BYTES);
  validateEventJournalSnapshot(contents, expectedRunId);
  return {
    absolutePath: eventsPath,
    archivePath: "events.jsonl",
    contents
  };
}

function validateEventJournalSnapshot(contents: Buffer, expectedRunId: string): void {
  if (contents.byteLength === 0) return;
  if (contents[contents.byteLength - 1] !== 0x0a) {
    throw new Error("event journal has a torn or unterminated final record");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch (error) {
    throw new Error("event journal is not valid UTF-8", { cause: error });
  }
  const lines = text.split("\n");
  lines.pop();
  if (lines.length > DEFAULT_STRICT_JSONL_MAX_RECORDS) {
    throw new Error(`event journal exceeds the ${DEFAULT_STRICT_JSONL_MAX_RECORDS}-record limit`);
  }

  const codec = eventJournalCodec(expectedRunId);
  const records: EventRecord[] = [];
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (line.trim().length === 0) throw new Error(`event journal contains a blank record at line ${lineNumber}`);
    const lineBytes = Buffer.from(line, "utf8");
    if (lineBytes.byteLength > DEFAULT_STRICT_JSONL_MAX_RECORD_BYTES) {
      throw new Error(
        `event journal record ${lineNumber} exceeds the ${DEFAULT_STRICT_JSONL_MAX_RECORD_BYTES}-byte limit`
      );
    }
    let parsed: unknown;
    try {
      parsed = parseStrictJsonBytes(lineBytes, {
        maxBytes: DEFAULT_STRICT_JSONL_MAX_RECORD_BYTES,
        maxDepth: 128,
        maxItems: 100_000,
        maxProperties: 100_000
      });
    } catch (error) {
      throw new Error(
        `event journal record ${lineNumber} is invalid strict JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
    records.push(codec.parseRecord(parsed, `$[${index}]`));
  }
  validateStrictJsonlHistory(records, codec);
}

function eventJournalCodec(expectedRunId: string): StrictJsonlCodec<EventRecord> {
  return {
    label: "event journal",
    parseRecord: (value, recordPath) => {
      const record = assertEventRecord(value, recordPath);
      if (record.run_id !== expectedRunId) {
        throw new Error(
          `${recordPath}.run_id belongs to ${JSON.stringify(record.run_id)}, expected ${JSON.stringify(expectedRunId)}`
        );
      }
      return record;
    },
    identity: (record) => record.event_id,
    validateHistory: (records) => {
      const firstRunId = records[0]?.run_id;
      let priorTimestamp = records[0]?.timestamp;
      for (const [index, record] of records.entries()) {
        if (firstRunId !== undefined && record.run_id !== firstRunId) {
          throw new Error(`event journal changes run_id at record ${index + 1}`);
        }
        if (priorTimestamp !== undefined && record.timestamp < priorTimestamp) {
          throw new Error(`event journal timestamps are not ordered at record ${index + 1}`);
        }
        priorTimestamp = record.timestamp;
      }
    }
  };
}

function collectBundleFiles(
  runRoot: string,
  diagnostics: RuntimeDiagnostic[],
  eventJournal: BundleFile | undefined,
  report: ReportArtifactsSnapshot | undefined
): BundleFile[] {
  const files: BundleFile[] = eventJournal === undefined ? [] : [eventJournal];

  for (const relativePath of TOP_LEVEL_RUN_FILES) {
    if (relativePath === "events.jsonl") continue;
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

  const runtimeReportRoot = path.join(runRoot, "review", "runtime-report");
  if (report?.artifacts.source === "verified-runtime-report") {
    const publications = report.publications;
    if (publications === undefined || publications.length === 0) {
      throw new Error("runtime report has no authenticated publication files");
    }
    for (const publication of publications) {
      assertPathInside(runtimeReportRoot, publication.path, "runtime report publication");
      addBundleFile(runRoot, publication.path, displayRelativePath(runRoot, publication.path), files, diagnostics);
    }
  } else if (lstatIfPresent(runtimeReportRoot) !== undefined) {
    throw new Error("runtime report directory has no authenticated current publication");
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
  // Runtime publication generations are admitted only by the current report
  // snapshot. Recursive enumeration must not publish stale or unverified copies.
  if (["review/runtime-report", "review/unverified-report"].includes(displayRelativePath(runRoot, absoluteDirectory)))
    return;
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
          : `${rename.archiveRoot}/${portableArchiveRelativePath(displayRelativePath(rename.sourceRoot, absolutePath))}`;
      if (shouldExcludeArchivePath(archivePath)) {
        continue;
      }
      const sourceArchivePath =
        rename === undefined
          ? undefined
          : `${rename.archiveRoot}/${displayRelativePath(rename.sourceRoot, absolutePath)}`;
      addBundleFile(runRoot, absolutePath, archivePath, files, diagnostics, sourceArchivePath);
    }
  }
}

function addBundleFile(
  runRoot: string,
  absolutePath: string,
  archivePath: string,
  files: BundleFile[],
  diagnostics: RuntimeDiagnostic[],
  sourceArchivePath?: string
): void {
  try {
    assertRegularFileInside(runRoot, absolutePath, "bundle file");
    const normalizedArchivePath = normalizeArchivePath(archivePath);
    files.push({
      absolutePath,
      archivePath: normalizedArchivePath,
      contents: readRegularFileSnapshot(absolutePath, MAX_BUNDLE_FILE_BYTES),
      ...(sourceArchivePath !== undefined && sourceArchivePath !== normalizedArchivePath ? { sourceArchivePath } : {})
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

function portableArchiveRelativePath(relativePath: string): string {
  return relativePath
    .split("/")
    .map((segment) => `entry-${crypto.createHash("sha256").update(segment, "utf8").digest("hex")}`)
    .join("/");
}

function shouldExcludeArchivePath(archivePath: string): boolean {
  return /^artifacts\/final-report\/report\.json\.pre-/u.test(archivePath);
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
  return fs.lstatSync(filePath, { throwIfNoEntry: false });
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
