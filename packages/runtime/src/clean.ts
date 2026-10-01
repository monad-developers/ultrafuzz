import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { assertNoSymlinkComponents, readRunPlanDocument, safeResolveInside } from "@ultrafuzz/artifacts";
import { isPathInside, validateCleanPolicy } from "@ultrafuzz/security";

import {
  appendCleanAuditRecord,
  CLEAN_AUDIT_SCHEMA_VERSION,
  readCleanAuditJournal,
  type CleanAuditRecord
} from "./audit-contracts.js";
import {
  assertRunSourceRevision,
  deleteRunSourceRevisions,
  runSourceRef,
  type RunSourceRevision
} from "./source-revision.js";
import type { CleanGeneratedInput, CleanGeneratedValue, RuntimeDiagnostic, RuntimeResult } from "./types.js";
import { hasRuntimeErrors, policyDiagnostics, runtimeError, runtimeFailure, runtimeResult } from "./utils.js";

interface PlannedRemoval {
  selection: string;
  absolutePath: string;
  existed: boolean;
}

export async function cleanRun(input: CleanGeneratedInput): Promise<RuntimeResult<CleanGeneratedValue>> {
  const policy = validateCleanPolicy({
    selections: input.selections,
    confirmed: input.confirmed,
    dryRun: input.dryRun
  });
  const diagnostics = policyDiagnostics(policy, "clean");
  if (!policy.ok) {
    return runtimeFailure(diagnostics);
  }

  const generatedRoot = path.resolve(input.projectRoot, ".ultrafuzz");
  try {
    assertNoSymlinkComponents(path.resolve(input.projectRoot), generatedRoot, "clean generated root");
  } catch (error) {
    return runtimeFailure([
      runtimeError("CLEAN_ROOT_UNSAFE", error instanceof Error ? error.message : String(error), "clean", ".ultrafuzz")
    ]);
  }
  const planned = input.selections.flatMap((selection) => {
    const removal = planRemoval(generatedRoot, selection, diagnostics);
    return removal === undefined ? [] : [removal];
  });
  if (hasRuntimeErrors(diagnostics)) {
    return runtimeFailure(diagnostics);
  }

  const auditPath = path.join(generatedRoot, "clean-audit.jsonl");
  try {
    assertNoSymlinkComponents(path.resolve(input.projectRoot), auditPath, "clean audit");
    readCleanAuditJournal(auditPath);
  } catch (error) {
    return runtimeFailure([
      runtimeError(
        "CLEAN_AUDIT_ROOT_UNSAFE",
        error instanceof Error ? error.message : String(error),
        "clean",
        ".ultrafuzz/clean-audit.jsonl"
      )
    ]);
  }

  // Read before anything is removed: deleting a run deletes the plan that
  // names its Modal storage. Every result below carries these warnings.
  const retainedStorage = retainedCloudStorageWarnings(planned);
  if (input.dryRun !== true) {
    let sources: RunSourceRevision[];
    try {
      sources = runSourceRefsForCleanup(input.projectRoot, planned);
    } catch {
      return runtimeFailure([
        runtimeError(
          "CLEAN_SOURCE_REF_FAILED",
          "run source revision cleanup could not be prepared; local evidence was preserved",
          "clean",
          ".ultrafuzz/runs"
        ),
        ...retainedStorage
      ]);
    }
    if (retainedStorage.length > 0) input.onRetainedStorage?.(retainedStorage);
    try {
      for (const removal of planned) {
        restoreRemovableDirectoryPermissions(removal.absolutePath);
        fs.rmSync(removal.absolutePath, { recursive: true, force: false });
      }
    } catch {
      return runtimeFailure([
        runtimeError(
          "CLEAN_REMOVE_FAILED",
          "generated artifact cleanup failed; run source refs were preserved",
          "clean",
          ".ultrafuzz"
        ),
        ...retainedStorage
      ]);
    }
    try {
      deleteRunSourceRevisions(input.projectRoot, sources);
    } catch {
      return runtimeFailure([
        runtimeError(
          "CLEAN_SOURCE_REF_FAILED",
          "local evidence was removed, but run source ref cleanup failed; retained refs remain safe",
          "clean",
          ".ultrafuzz/runs"
        ),
        ...retainedStorage
      ]);
    }
  }

  const auditRecord: CleanAuditRecord = {
    schema_version: CLEAN_AUDIT_SCHEMA_VERSION,
    audit_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    operation: "cleanRun",
    status: input.dryRun === true ? "dry-run" : "succeeded",
    confirmed: input.confirmed === true,
    selections: planned.map((removal) => ({
      path: removal.selection,
      existed: removal.existed
    }))
  };
  try {
    appendCleanAuditRecord(auditPath, auditRecord, path.resolve(input.projectRoot));
  } catch (error) {
    return runtimeFailure([
      runtimeError(
        "CLEAN_AUDIT_FAILED",
        `${input.dryRun === true ? "nothing was removed" : "the selections were removed"}, but the clean audit record could not be appended: ${error instanceof Error ? error.message : String(error)}`,
        "clean",
        ".ultrafuzz/clean-audit.jsonl"
      ),
      ...retainedStorage
    ]);
  }

  return runtimeResult(
    true,
    {
      dry_run: input.dryRun === true,
      removed: planned.map((removal) => removal.selection),
      audit: {
        schema_version: CLEAN_AUDIT_SCHEMA_VERSION,
        audit_id: auditRecord.audit_id,
        audit_path: auditPath,
        selections: planned.map((removal) => removal.selection)
      }
    },
    retainedStorage
  );
}

/**
 * An earlier release could plan a run for per-node Modal execution (#134).
 * Its sandboxes and Modal volume outlive the run directory, and the code that
 * removed them with the run went with that execution mode (#1197), so name
 * what is left to remove by hand. The run's plan records the mode and the app
 * from its resolved config. An unreadable plan yields no warning here and
 * stops runSourceRefsForCleanup before anything is removed.
 */
function retainedCloudStorageWarnings(planned: PlannedRemoval[]): RuntimeDiagnostic[] {
  let runRoots: string[];
  try {
    runRoots = runRootsForCleanup(planned);
  } catch {
    return [];
  }
  return runRoots.flatMap((root): RuntimeDiagnostic[] => {
    const runId = path.basename(root);
    let app: string | undefined;
    try {
      const planPath = path.join(root, "plan.json");
      if (!fs.existsSync(planPath)) return [];
      assertNoSymlinkComponents(root, planPath, "cloud storage cleanup plan");
      const execution = readRunPlanDocument(planPath, runId).execution;
      if (execution.mode !== "cloud") return [];
      app = execution.providers.modal?.app;
    } catch {
      return [];
    }
    // The removed provider keyed both by the run's Smithers run ID.
    const identity = modalNodeRunIdentity(`ultrafuzz-${runId}`);
    const volume = `ultrafuzz-node-${identity}`;
    return [
      {
        code: "CLEAN_CLOUD_STORAGE_RETAINED",
        message: `run ${runId} was planned by an earlier release for per-node Modal execution, and clean no longer removes that storage, which may still be billed: delete its Modal volume with \`modal volume delete ${volume}\`, and stop any of its sandboxes still running in ${app === undefined ? "its Modal app" : `Modal app ${app}`} (tagged purpose=ultrafuzz-node and run=${identity})`,
        severity: "warning",
        source: "clean",
        path: `runs/${runId}`
      }
    ];
  });
}

/** The removed Modal node provider's bounded identity: its volume suffix and sandbox `run` tag. */
function modalNodeRunIdentity(smithersRunId: string): string {
  const normalized =
    smithersRunId
      .replace(/[^A-Za-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 32) || "run";
  return `${normalized}-${crypto.createHash("sha256").update(smithersRunId).digest("hex").slice(0, 12)}`;
}

function runSourceRefsForCleanup(projectRoot: string, planned: PlannedRemoval[]): RunSourceRevision[] {
  const sources = runRootsForCleanup(planned).flatMap((root): RunSourceRevision[] => {
    const planPath = path.join(root, "plan.json");
    if (!fs.existsSync(planPath)) return [];
    assertNoSymlinkComponents(root, planPath, "source revision cleanup plan");
    const plan = readRunPlanDocument(planPath, path.basename(root));
    const ref = runSourceRef(plan.run_id);
    return plan.source_revision === undefined || plan.source_ref !== ref
      ? []
      : [{ revision: plan.source_revision, ref, pinned: false }];
  });
  for (const source of sources) {
    assertRunSourceRevision(projectRoot, source);
  }
  return sources;
}

function runRootsForCleanup(planned: PlannedRemoval[]): string[] {
  return planned.flatMap((removal) => {
    const match = /^runs\/([A-Za-z0-9][A-Za-z0-9._-]*)$/u.exec(removal.selection);
    if (match?.[1] !== undefined) {
      return [removal.absolutePath];
    }
    if (removal.selection !== "runs") return [];
    return fs
      .readdirSync(removal.absolutePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => path.join(removal.absolutePath, entry.name));
  });
}

function planRemoval(
  generatedRoot: string,
  selection: string,
  diagnostics: RuntimeDiagnostic[]
): PlannedRemoval | undefined {
  let absolutePath: string;
  try {
    absolutePath = safeResolveInside(generatedRoot, selection, "clean selection");
  } catch (error) {
    diagnostics.push(
      runtimeError("CLEAN_SELECTION_INVALID", `clean selection ${selection} is not path-safe`, "clean", selection, {
        error: String(error)
      })
    );
    return undefined;
  }
  if (!fs.existsSync(absolutePath)) {
    diagnostics.push(
      runtimeError("CLEAN_SELECTION_MISSING", `clean selection ${selection} does not exist`, "clean", selection)
    );
    return undefined;
  }
  const stat = fs.lstatSync(absolutePath);
  if (stat.isSymbolicLink()) {
    diagnostics.push(
      runtimeError("CLEAN_SELECTION_SYMLINK", `clean selection ${selection} is a symlink`, "clean", selection)
    );
    return undefined;
  }
  if (!stat.isDirectory()) {
    diagnostics.push(
      runtimeError(
        "CLEAN_SELECTION_NOT_DIRECTORY",
        `clean selection ${selection} must be a directory`,
        "clean",
        selection
      )
    );
    return undefined;
  }
  if (!isPathInside(fs.realpathSync.native(generatedRoot), fs.realpathSync.native(absolutePath))) {
    diagnostics.push(
      runtimeError(
        "CLEAN_SELECTION_ESCAPE",
        `clean selection ${selection} resolves outside .ultrafuzz`,
        "clean",
        selection
      )
    );
    return undefined;
  }
  return {
    selection,
    absolutePath,
    existed: true
  };
}

/**
 * Restore owner write permission on directories in a tree that is about to be
 * removed.
 *
 * Published workflow execution snapshots are sealed: sealSnapshotPermissions
 * drops the write bit from their directories, leaving them dr-x------. Removing
 * an entry needs the write bit on its parent directory rather than on the entry
 * itself, so rmSync cannot unlink anything inside a sealed snapshot and clean
 * failed with CLEAN_REMOVE_FAILED for every run that had published one. That
 * left the tool unable to remove state it had created, and the abandoned
 * snapshots accumulated at roughly a gigabyte and 59,000 files per run.
 *
 * Only directories are changed, and only the owner write bit is added. Symlinks
 * are never followed, so this cannot alter permissions outside the tree. The
 * caller has already resolved and path-guarded the root being removed.
 */
function restoreRemovableDirectoryPermissions(root: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(root);
  } catch {
    return;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return;
  try {
    fs.chmodSync(root, stat.mode | 0o700);
  } catch {
    // Best effort: rmSync reports the actionable failure.
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) restoreRemovableDirectoryPermissions(path.join(root, entry.name));
  }
}
