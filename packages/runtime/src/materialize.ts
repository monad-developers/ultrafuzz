import fs from "node:fs";
import path from "node:path";

import {
  appendEvent,
  appendLineDurable,
  assertNoSymlinkComponents,
  layoutForRunRoot,
  safeResolveInside,
  sha256Bytes,
  type RunLayout
} from "@ultrafuzz/artifacts";
import { loadProjectConfig, resolveConfig } from "@ultrafuzz/config";
import { isPathInside, validateMaterializePolicy, type MaterializeCopySelection } from "@ultrafuzz/security";

const MATERIALIZE_AUDIT_SCHEMA_VERSION = "ultrafuzz.materialize.audit.v1" as const;

import type { MaterializeInput, MaterializeValue, RuntimeDiagnostic, RuntimeResult } from "./types.js";
import { hasRuntimeErrors, policyDiagnostics, runtimeError, runtimeFailure, runtimeResult } from "./utils.js";

interface PlannedMaterialization {
  selection: MaterializeCopySelection;
  sourcePath: string;
  destinationPath: string;
  sizeBytes: number;
  sha256: string;
  device: number;
  inode: number;
}

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

  const policy = validateMaterializePolicy({
    patches: input.patches,
    copies: input.copies,
    confirmed: input.confirmed,
    dryRun: input.dryRun,
    allowOverwrite: input.allowOverwrite,
    mode: input.dryRun ? "dry-run" : "unstaged-working-tree"
  });
  const diagnostics = policyDiagnostics(policy, "materialize");
  if (!policy.ok) {
    return runtimeFailure(diagnostics);
  }

  const plannedCopies = (input.copies ?? []).flatMap((copy) => {
    const planned = planCopy(layout, projectRoot, copy, input.allowOverwrite === true, diagnostics);
    return planned === undefined ? [] : [planned];
  });
  if (hasRuntimeErrors(diagnostics)) {
    return runtimeFailure(diagnostics);
  }

  const auditPath = path.join(projectRoot, ".ultrafuzz", "materialize-audit.jsonl");
  try {
    assertNoSymlinkComponents(projectRoot, auditPath, "materialize audit");
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
      fs.mkdirSync(path.dirname(copy.destinationPath), { recursive: true });
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
        const contents = readPlannedSource(copy);
        writeMaterializedFile(destinationCheck, contents, input.allowOverwrite === true);
      } catch (error) {
        diagnostics.push(
          runtimeError(
            "MATERIALIZE_SOURCE_CHANGED",
            `source ${copy.selection.source} changed after it was validated`,
            "materialize",
            copy.selection.source,
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
  const auditRecord = {
    schema_version: MATERIALIZE_AUDIT_SCHEMA_VERSION,
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
  appendLineDurable(auditPath, JSON.stringify(auditRecord));
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

function planCopy(
  layout: RunLayout,
  projectRoot: string,
  copy: MaterializeCopySelection,
  allowOverwrite: boolean,
  diagnostics: RuntimeDiagnostic[]
): PlannedMaterialization | undefined {
  const sourcePath = resolveSource(copy.source, layout, diagnostics);
  const destinationPath = resolveDestination(copy.destination, projectRoot, allowOverwrite, diagnostics);
  if (sourcePath === undefined || destinationPath === undefined) {
    return undefined;
  }
  const source = readSourceSnapshot(sourcePath);
  return {
    selection: copy,
    sourcePath,
    destinationPath,
    sizeBytes: source.contents.length,
    sha256: source.sha256,
    device: source.device,
    inode: source.inode
  };
}

function readSourceSnapshot(sourcePath: string): {
  contents: Buffer;
  sha256: string;
  device: number;
  inode: number;
} {
  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(sourcePath, fs.constants.O_RDONLY | noFollow);
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) {
      throw new Error("materialize source is not a regular file");
    }
    const contents = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      contents.length !== after.size
    ) {
      throw new Error("materialize source changed while it was read");
    }
    return {
      contents,
      sha256: sha256Bytes(contents),
      device: after.dev,
      inode: after.ino
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function readPlannedSource(copy: PlannedMaterialization): Buffer {
  const source = readSourceSnapshot(copy.sourcePath);
  if (
    source.device !== copy.device ||
    source.inode !== copy.inode ||
    source.contents.length !== copy.sizeBytes ||
    source.sha256 !== copy.sha256
  ) {
    throw new Error("materialize source identity or contents changed");
  }
  return source.contents;
}

function writeMaterializedFile(destinationPath: string, contents: Buffer, allowOverwrite: boolean): void {
  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    noFollow |
    (allowOverwrite ? fs.constants.O_TRUNC : fs.constants.O_EXCL);
  const descriptor = fs.openSync(destinationPath, flags, 0o600);
  try {
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
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
