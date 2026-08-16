import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  appendEvent,
  assertNoSymlinkComponents,
  layoutForRunRoot,
  readRegularFileSnapshot,
  safeResolveInside,
  sha256Bytes,
  type RunLayout
} from "@ultrafuzz/artifacts";
import { loadProjectConfig, resolveConfig } from "@ultrafuzz/config";
import { isPathInside, validateMaterializePolicy, type MaterializeCopySelection } from "@ultrafuzz/security";

import {
  appendMaterializeAuditRecord,
  MATERIALIZE_AUDIT_SCHEMA_VERSION,
  readMaterializeAuditJournal,
  type MaterializeAuditRecord
} from "./audit-contracts.js";
import type { MaterializeInput, MaterializeValue, RuntimeDiagnostic, RuntimeResult } from "./types.js";
import { hasRuntimeErrors, policyDiagnostics, runtimeError, runtimeFailure, runtimeResult } from "./utils.js";

interface PlannedMaterialization {
  selection: MaterializeCopySelection;
  destinationPath: string;
  bytes: Buffer;
  sizeBytes: number;
  sha256: string;
}

type PlannedCopyResult =
  { status: "planned"; value: PlannedMaterialization } | { status: "invalid" } | { status: "snapshot-budget-exceeded" };

interface OpenedMaterializeDirectory {
  descriptor: number;
  lexicalPath: string;
  accessPath: string;
  identity: fs.BigIntStats;
}

interface StagedMaterialization {
  descriptor: number;
  accessPath: string;
  device: bigint;
  inode: bigint;
  sizeBytes: number;
}

const MAX_MATERIALIZE_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_MATERIALIZE_COPY_SELECTIONS = 128;
const MAX_MATERIALIZE_SNAPSHOT_BYTES = 64 * 1024 * 1024;

export async function materializeSelection(input: MaterializeInput): Promise<RuntimeResult<MaterializeValue>> {
  const projectRoot = path.resolve(input.projectRoot);
  try {
    assertNoSymlinkComponents(projectRoot, path.join(projectRoot, ".ultrafuzz"), "materialize generated root");
  } catch (error) {
    return runtimeFailure([
      runtimeError(
        "MATERIALIZE_ROOT_UNSAFE",
        error instanceof Error ? error.message : String(error),
        "materialize",
        ".ultrafuzz"
      )
    ]);
  }
  const runsRoot = await runsRootForProject(projectRoot);
  const layoutResult = resolveRunLayout(runsRoot, input.runId);
  if (!layoutResult.ok || layoutResult.value === undefined) {
    return runtimeFailure(layoutResult.diagnostics);
  }
  const layout = layoutResult.value;
  if (!fs.existsSync(layout.root)) {
    return runtimeFailure([
      runtimeError("RUN_NOT_FOUND", `run ${input.runId} does not exist`, "materialize", layout.root)
    ]);
  }

  const copySelections = input.copies ?? [];
  if (copySelections.length > MAX_MATERIALIZE_COPY_SELECTIONS) {
    return runtimeFailure([
      runtimeError(
        "MATERIALIZE_COPY_SELECTION_LIMIT_EXCEEDED",
        `materialize copy selection exceeds the ${MAX_MATERIALIZE_COPY_SELECTIONS}-entry limit`,
        "materialize",
        undefined,
        { actual_entries: copySelections.length, limit_entries: MAX_MATERIALIZE_COPY_SELECTIONS }
      )
    ]);
  }

  const policy = validateMaterializePolicy({
    patches: input.patches,
    copies: copySelections,
    confirmed: input.confirmed,
    dryRun: input.dryRun,
    allowOverwrite: input.allowOverwrite,
    mode: input.dryRun ? "dry-run" : "unstaged-working-tree"
  });
  const diagnostics = policyDiagnostics(policy, "materialize");
  if (!policy.ok) {
    return runtimeFailure(diagnostics);
  }

  const plannedCopies: PlannedMaterialization[] = [];
  let plannedSnapshotBytes = 0;
  for (const copy of copySelections) {
    const result = planCopy(
      layout,
      projectRoot,
      copy,
      input.allowOverwrite === true,
      MAX_MATERIALIZE_SNAPSHOT_BYTES - plannedSnapshotBytes,
      plannedSnapshotBytes,
      diagnostics
    );
    if (result.status === "snapshot-budget-exceeded") break;
    if (result.status === "invalid") continue;
    const planned = result.value;
    const nextSnapshotBytes = plannedSnapshotBytes + planned.sizeBytes;
    if (!Number.isSafeInteger(nextSnapshotBytes) || nextSnapshotBytes > MAX_MATERIALIZE_SNAPSHOT_BYTES) {
      diagnostics.push(materializeSnapshotBudgetDiagnostic(copy, nextSnapshotBytes));
      break;
    }
    plannedSnapshotBytes = nextSnapshotBytes;
    plannedCopies.push(planned);
  }
  if (hasRuntimeErrors(diagnostics)) {
    return runtimeFailure(diagnostics);
  }

  const auditPath = path.join(projectRoot, ".ultrafuzz", "materialize-audit.jsonl");
  try {
    assertNoSymlinkComponents(projectRoot, auditPath, "materialize audit");
    readMaterializeAuditJournal(auditPath);
  } catch (error) {
    return runtimeFailure([
      runtimeError(
        "MATERIALIZE_AUDIT_ROOT_UNSAFE",
        error instanceof Error ? error.message : String(error),
        "materialize",
        ".ultrafuzz/materialize-audit.jsonl"
      )
    ]);
  }
  if (input.dryRun !== true) {
    for (const copy of plannedCopies) {
      const destinationCheck = resolveDestination(
        copy.selection.destination,
        projectRoot,
        input.allowOverwrite === true,
        []
      );
      if (destinationCheck === undefined) {
        diagnostics.push(
          runtimeError(
            "MATERIALIZE_DESTINATION_RACE",
            `destination ${copy.selection.destination} became invalid before copy`,
            "materialize",
            copy.selection.destination
          )
        );
        break;
      }
      try {
        copyMaterializationWithoutFollowingDestination(copy, projectRoot, input.allowOverwrite === true);
      } catch (error) {
        diagnostics.push(
          runtimeError(
            "MATERIALIZE_DESTINATION_RACE",
            `destination ${copy.selection.destination} changed or could not be replaced safely`,
            "materialize",
            copy.selection.destination,
            { error: error instanceof Error ? error.message : String(error) }
          )
        );
        break;
      }
    }
  }
  if (hasRuntimeErrors(diagnostics)) {
    return runtimeFailure(diagnostics);
  }

  const mode: "dry-run" | "unstaged-working-tree" = input.dryRun === true ? "dry-run" : "unstaged-working-tree";
  const auditRecord: MaterializeAuditRecord = {
    schema_version: MATERIALIZE_AUDIT_SCHEMA_VERSION,
    audit_id: crypto.randomUUID(),
    run_id: layout.runId,
    timestamp: new Date().toISOString(),
    operation: "materializeSelection",
    mode,
    unstaged: true,
    confirmed: input.confirmed === true,
    allow_overwrite: input.allowOverwrite === true,
    copies: plannedCopies.map((copy) => ({
      source: copy.selection.source,
      destination: copy.selection.destination,
      size_bytes: copy.sizeBytes,
      sha256: copy.sha256
    })),
    patches: []
  };
  appendMaterializeAuditRecord(auditPath, auditRecord, projectRoot);
  const event = appendEvent(layout, {
    eventType: "materialize-selection",
    status: mode === "dry-run" ? "dry-run" : "succeeded",
    payload: {
      audit_path: path.relative(layout.root, auditPath).split(path.sep).join("/"),
      mode: auditRecord.mode,
      unstaged: true,
      copies: auditRecord.copies,
      patches: []
    }
  });

  return runtimeResult(true, {
    run_id: layout.runId,
    dry_run: input.dryRun === true,
    copied: plannedCopies.map((copy) => copy.selection),
    patches: [],
    audit: {
      schema_version: MATERIALIZE_AUDIT_SCHEMA_VERSION,
      audit_id: auditRecord.audit_id,
      mode: auditRecord.mode,
      unstaged: true,
      audit_path: auditPath,
      event_id: event.event_id,
      copies: auditRecord.copies,
      patches: []
    }
  });
}

export const materializeRun = materializeSelection;

function copyMaterializationWithoutFollowingDestination(
  copy: PlannedMaterialization,
  projectRoot: string,
  allowOverwrite: boolean
): void {
  const destinationDirectory = path.dirname(copy.destinationPath);
  const openedDirectory = openMaterializeDestinationDirectory(projectRoot, destinationDirectory);
  let committed = false;
  let failure: unknown;
  let staged: StagedMaterialization | undefined;
  try {
    assertMaterializeDirectoryCurrent(projectRoot, openedDirectory);
    const destinationAccessPath = path.join(openedDirectory.accessPath, path.basename(copy.destinationPath));
    const stageAccessPath = allowOverwrite
      ? path.join(
          openedDirectory.accessPath,
          `.${path.basename(copy.destinationPath)}.ultrafuzz-materialize-${process.pid}-${crypto.randomUUID()}.tmp`
        )
      : destinationAccessPath;
    staged = createStagedMaterialization(openedDirectory, stageAccessPath, copy);
    assertMaterializeDirectoryCurrent(projectRoot, openedDirectory);
    if (allowOverwrite) {
      // Both names resolve below the same opened parent descriptor. A lexical
      // parent swap can therefore make the operation fail its identity recheck,
      // but it cannot redirect the replacement to the attacker's directory.
      fs.renameSync(staged.accessPath, destinationAccessPath);
    }
    assertStagedMaterializationAt(destinationAccessPath, staged);
    assertMaterializeDirectoryCurrent(projectRoot, openedDirectory);
    fs.fsyncSync(openedDirectory.descriptor);
    assertMaterializeDirectoryCurrent(projectRoot, openedDirectory);
    committed = true;
  } catch (error) {
    failure = error;
  }
  if (!committed && staged !== undefined) {
    try {
      // Node does not expose unlinkat-by-descriptor. Truncate only the inode we
      // own and leave any uncertain pathname in place; deleting by basename
      // here would reintroduce an lstat-to-unlink race against unrelated files.
      fs.ftruncateSync(staged.descriptor, 0);
      fs.fsyncSync(staged.descriptor);
      fs.fsyncSync(openedDirectory.descriptor);
    } catch (error) {
      failure ??= error;
    }
  }
  if (staged !== undefined) {
    try {
      closeStagedMaterialization(staged);
    } catch (error) {
      if (!committed) failure ??= error;
    }
  }
  try {
    closeMaterializeDirectory(openedDirectory);
  } catch (error) {
    // Publication is already committed and identity-verified at this point.
    // A close error cannot be rolled back safely, so it must not turn a
    // successful materialization into a reported failure.
    if (!committed) failure ??= error;
  }
  if (!committed) throw failure;
}

function createStagedMaterialization(
  directory: OpenedMaterializeDirectory,
  accessPath: string,
  copy: PlannedMaterialization
): StagedMaterialization {
  const descriptor = fs.openSync(
    accessPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
    0o600
  );
  let staged: StagedMaterialization | undefined;
  let failure: unknown;
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    staged = {
      descriptor,
      accessPath,
      device: opened.dev,
      inode: opened.ino,
      sizeBytes: copy.bytes.length
    };
    if (!opened.isFile() || opened.nlink !== 1n || opened.size !== 0n) {
      throw new Error("materialization stage is not a new singly linked regular file");
    }
    writeMaterializationDescriptor(descriptor, copy.bytes);
    fs.fsyncSync(descriptor);
    assertStagedMaterializationAt(accessPath, staged);
    return staged;
  } catch (error) {
    failure = error;
  }
  if (staged === undefined) {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      failure ??= error;
    }
  } else {
    try {
      fs.ftruncateSync(descriptor, 0);
      fs.fsyncSync(descriptor);
      fs.fsyncSync(directory.descriptor);
    } catch (error) {
      failure ??= error;
    }
    try {
      closeStagedMaterialization(staged);
    } catch (error) {
      failure ??= error;
    }
  }
  throw failure;
}

function writeMaterializationDescriptor(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (written === 0) throw new Error("materialization stage stopped accepting bytes");
    offset += written;
  }
}

function assertStagedMaterializationAt(accessPath: string, staged: StagedMaterialization): void {
  const opened = fs.fstatSync(staged.descriptor, { bigint: true });
  const lexical = fs.lstatSync(accessPath, { bigint: true });
  if (
    !opened.isFile() ||
    !lexical.isFile() ||
    opened.dev !== staged.device ||
    opened.ino !== staged.inode ||
    lexical.dev !== staged.device ||
    lexical.ino !== staged.inode ||
    opened.nlink !== 1n ||
    lexical.nlink !== 1n ||
    opened.size !== BigInt(staged.sizeBytes) ||
    lexical.size !== BigInt(staged.sizeBytes)
  ) {
    throw new Error("materialization stage changed while it was published");
  }
}

function closeStagedMaterialization(staged: StagedMaterialization): void {
  if (staged.descriptor < 0) return;
  const descriptor = staged.descriptor;
  staged.descriptor = -1;
  fs.closeSync(descriptor);
}

function openMaterializeDestinationDirectory(
  projectRoot: string,
  destinationDirectory: string
): OpenedMaterializeDirectory {
  const relativeDirectory = path.relative(projectRoot, destinationDirectory);
  if (
    relativeDirectory === ".." ||
    relativeDirectory.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeDirectory)
  ) {
    throw new Error("materialize destination directory escapes the project root");
  }

  let current = openVerifiedMaterializeDirectory(projectRoot, projectRoot, "materialize project root");
  try {
    const components = relativeDirectory === "" ? [] : relativeDirectory.split(path.sep);
    for (const component of components) {
      assertMaterializeDirectoryCurrent(projectRoot, current);
      const childLexicalPath = path.join(current.lexicalPath, component);
      const childAccessPath = path.join(current.accessPath, component);
      let child: OpenedMaterializeDirectory;
      try {
        child = openVerifiedMaterializeDirectory(
          projectRoot,
          childLexicalPath,
          "materialize destination directory",
          childAccessPath
        );
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
        assertMaterializeDirectoryCurrent(projectRoot, current);
        fs.mkdirSync(childAccessPath);
        assertMaterializeDirectoryCurrent(projectRoot, current);
        child = openVerifiedMaterializeDirectory(
          projectRoot,
          childLexicalPath,
          "materialize destination directory",
          childAccessPath
        );
      }
      try {
        assertMaterializeDirectoryCurrent(projectRoot, current);
        assertMaterializeDirectoryCurrent(projectRoot, child);
        closeMaterializeDirectory(current);
      } catch (error) {
        closeMaterializeDirectory(child);
        throw error;
      }
      current = child;
    }
    return current;
  } catch (error) {
    closeMaterializeDirectory(current);
    throw error;
  }
}

function openVerifiedMaterializeDirectory(
  projectRoot: string,
  lexicalPath: string,
  label: string,
  openPath = lexicalPath
): OpenedMaterializeDirectory {
  assertNoSymlinkComponents(projectRoot, lexicalPath, label);
  const descriptor = fs.openSync(
    openPath,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (fs.constants.O_NOFOLLOW ?? 0)
  );
  try {
    const identity = fs.fstatSync(descriptor, { bigint: true });
    if (!identity.isDirectory()) throw new Error(`${label} is not a physical directory`);
    const accessPath = materializeDirectoryDescriptorPath(descriptor, identity);
    const opened = { descriptor, lexicalPath, accessPath, identity };
    assertMaterializeDirectoryCurrent(projectRoot, opened);
    return opened;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function materializeDirectoryDescriptorPath(descriptor: number, identity: fs.BigIntStats): string {
  for (const candidate of [`/proc/self/fd/${descriptor}`, `/dev/fd/${descriptor}`]) {
    try {
      const accessed = fs.statSync(candidate, { bigint: true });
      if (accessed.isDirectory() && accessed.dev === identity.dev && accessed.ino === identity.ino) return candidate;
    } catch {
      // Continue to the next descriptor filesystem.
    }
  }
  throw new Error("materialize destination directory has no verifiable descriptor path");
}

function assertMaterializeDirectoryCurrent(projectRoot: string, opened: OpenedMaterializeDirectory): void {
  assertNoSymlinkComponents(projectRoot, opened.lexicalPath, "materialize destination directory");
  const descriptor = fs.fstatSync(opened.descriptor, { bigint: true });
  const lexical = fs.lstatSync(opened.lexicalPath, { bigint: true });
  const accessed = fs.statSync(opened.accessPath, { bigint: true });
  if (
    !descriptor.isDirectory() ||
    !lexical.isDirectory() ||
    !accessed.isDirectory() ||
    descriptor.dev !== opened.identity.dev ||
    descriptor.ino !== opened.identity.ino ||
    lexical.dev !== opened.identity.dev ||
    lexical.ino !== opened.identity.ino ||
    accessed.dev !== opened.identity.dev ||
    accessed.ino !== opened.identity.ino
  ) {
    throw new Error("materialize destination directory changed while it was opened");
  }
}

function closeMaterializeDirectory(opened: OpenedMaterializeDirectory): void {
  if (opened.descriptor < 0) return;
  const descriptor = opened.descriptor;
  opened.descriptor = -1;
  fs.closeSync(descriptor);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function planCopy(
  layout: RunLayout,
  projectRoot: string,
  copy: MaterializeCopySelection,
  allowOverwrite: boolean,
  remainingSnapshotBytes: number,
  plannedSnapshotBytes: number,
  diagnostics: RuntimeDiagnostic[]
): PlannedCopyResult {
  const sourcePath = resolveSource(copy.source, layout, diagnostics);
  const destinationPath = resolveDestination(copy.destination, projectRoot, allowOverwrite, diagnostics);
  if (sourcePath === undefined || destinationPath === undefined) {
    return { status: "invalid" };
  }
  try {
    const expectedSize = fs.lstatSync(sourcePath).size;
    if (
      Number.isSafeInteger(expectedSize) &&
      expectedSize >= 0 &&
      expectedSize <= MAX_MATERIALIZE_SOURCE_BYTES &&
      expectedSize > remainingSnapshotBytes
    ) {
      diagnostics.push(materializeSnapshotBudgetDiagnostic(copy, plannedSnapshotBytes + expectedSize));
      return { status: "snapshot-budget-exceeded" };
    }
    const bytes = readRegularFileSnapshot(sourcePath, Math.min(MAX_MATERIALIZE_SOURCE_BYTES, remainingSnapshotBytes));
    return {
      status: "planned",
      value: {
        selection: copy,
        destinationPath,
        bytes,
        sizeBytes: bytes.length,
        sha256: sha256Bytes(bytes)
      }
    };
  } catch (error) {
    diagnostics.push(
      runtimeError(
        "MATERIALIZE_SOURCE_CHANGED",
        `source ${copy.source} could not be captured as a stable bounded snapshot`,
        "materialize",
        copy.source,
        { error: error instanceof Error ? error.message : String(error) }
      )
    );
    return { status: "invalid" };
  }
}

function materializeSnapshotBudgetDiagnostic(
  copy: MaterializeCopySelection,
  attemptedBytes: number
): RuntimeDiagnostic {
  return runtimeError(
    "MATERIALIZE_SNAPSHOT_BUDGET_EXCEEDED",
    `materialize copy snapshots exceed the ${MAX_MATERIALIZE_SNAPSHOT_BYTES}-byte aggregate limit`,
    "materialize",
    copy.source,
    {
      attempted_bytes: Number.isSafeInteger(attemptedBytes) ? attemptedBytes : "unsafe-integer",
      limit_bytes: MAX_MATERIALIZE_SNAPSHOT_BYTES
    }
  );
}

function resolveSource(selection: string, layout: RunLayout, diagnostics: RuntimeDiagnostic[]): string | undefined {
  let sourcePath: string;
  try {
    sourcePath = safeResolveInside(layout.root, selection, "materialize source");
  } catch (error) {
    diagnostics.push(
      runtimeError("MATERIALIZE_SOURCE_INVALID", `source ${selection} is not path-safe`, "materialize", selection, {
        error: String(error)
      })
    );
    return undefined;
  }
  if (!fs.existsSync(sourcePath)) {
    diagnostics.push(
      runtimeError("MATERIALIZE_SOURCE_MISSING", `source ${selection} does not exist`, "materialize", selection)
    );
    return undefined;
  }
  const stat = fs.lstatSync(sourcePath);
  if (stat.isSymbolicLink()) {
    diagnostics.push(
      runtimeError("MATERIALIZE_SOURCE_SYMLINK", `source ${selection} is a symlink`, "materialize", selection)
    );
    return undefined;
  }
  if (!stat.isFile()) {
    diagnostics.push(
      runtimeError("MATERIALIZE_SOURCE_NOT_FILE", `source ${selection} must be a file`, "materialize", selection)
    );
    return undefined;
  }
  if (!isPathInside(fs.realpathSync.native(layout.root), fs.realpathSync.native(sourcePath))) {
    diagnostics.push(
      runtimeError(
        "MATERIALIZE_SOURCE_ESCAPE",
        `source ${selection} resolves outside the run root`,
        "materialize",
        selection
      )
    );
    return undefined;
  }
  return sourcePath;
}

function resolveDestination(
  selection: string,
  projectRoot: string,
  allowOverwrite: boolean,
  diagnostics: RuntimeDiagnostic[]
): string | undefined {
  let destinationPath: string;
  try {
    destinationPath = safeResolveInside(projectRoot, selection, "materialize destination");
  } catch (error) {
    diagnostics.push(
      runtimeError(
        "MATERIALIZE_DESTINATION_INVALID",
        `destination ${selection} is not path-safe`,
        "materialize",
        selection,
        { error: String(error) }
      )
    );
    return undefined;
  }
  if (fs.existsSync(destinationPath)) {
    const stat = fs.lstatSync(destinationPath);
    if (stat.isSymbolicLink()) {
      diagnostics.push(
        runtimeError(
          "MATERIALIZE_DESTINATION_SYMLINK",
          `destination ${selection} is a symlink`,
          "materialize",
          selection
        )
      );
      return undefined;
    }
    if (!stat.isFile()) {
      diagnostics.push(
        runtimeError(
          "MATERIALIZE_DESTINATION_NOT_FILE",
          `destination ${selection} is not a file`,
          "materialize",
          selection
        )
      );
      return undefined;
    }
    if (!allowOverwrite) {
      diagnostics.push(
        runtimeError(
          "MATERIALIZE_DESTINATION_EXISTS",
          `destination ${selection} already exists`,
          "materialize",
          selection
        )
      );
      return undefined;
    }
  }
  return destinationPath;
}

async function runsRootForProject(projectRoot: string): Promise<string> {
  const loaded = await loadProjectConfig(projectRoot);
  if (loaded.ok) {
    const resolved = resolveConfig({ projectConfig: loaded.value.config, env: process.env });
    if (resolved.ok) {
      return path.resolve(projectRoot, resolved.value.run.outputDir);
    }
  }
  return path.resolve(projectRoot, ".ultrafuzz", "runs");
}

function resolveRunLayout(runsRoot: string, runId: string): RuntimeResult<RunLayout> {
  try {
    const layout = layoutForRunRoot(path.join(runsRoot, runId), runId);
    return runtimeResult(true, layout);
  } catch (error) {
    return runtimeFailure([
      runtimeError("RUN_ID_INVALID", `run ID ${runId} is not safe`, "materialize", runId, { error: String(error) })
    ]);
  }
}
