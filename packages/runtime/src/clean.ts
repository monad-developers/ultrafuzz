import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { assertNoSymlinkComponents, readRunPlanDocument, safeResolveInside } from "@ultrafuzz/artifacts";
import type { ModalExecutionProviderConfig } from "@ultrafuzz/config";
import { isPathInside, validateCleanPolicy } from "@ultrafuzz/security";

import {
  appendCleanAuditRecord,
  CLEAN_AUDIT_SCHEMA_VERSION,
  readCleanAuditJournal,
  type CleanAuditRecord
} from "./audit-contracts.js";
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

  if (input.dryRun !== true) {
    const cloudCleanup = await cleanupCloudRunStorage(input, planned);
    if (cloudCleanup !== undefined) {
      return runtimeFailure([cloudCleanup]);
    }
    for (const removal of planned) {
      fs.rmSync(removal.absolutePath, { recursive: true, force: false });
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
  appendCleanAuditRecord(auditPath, auditRecord, path.resolve(input.projectRoot));

  return runtimeResult(true, {
    dry_run: input.dryRun === true,
    removed: planned.map((removal) => removal.selection),
    audit: {
      schema_version: CLEAN_AUDIT_SCHEMA_VERSION,
      audit_id: auditRecord.audit_id,
      audit_path: auditPath,
      selections: planned.map((removal) => removal.selection)
    }
  });
}

async function cleanupCloudRunStorage(
  input: CleanGeneratedInput,
  planned: PlannedRemoval[]
): Promise<RuntimeDiagnostic | undefined> {
  try {
    const cloudRuns = cloudRunsForCleanup(planned);
    if (cloudRuns.length === 0) return undefined;
    const moduleName = "@ultrafuzz/modal";
    const provider = (await import(moduleName)) as {
      cleanupModalNodeRun(
        options: {
          app: string;
          image: string;
          region?: string;
          credentialEnv: readonly string[];
        },
        controllerRunId: string,
        cleanupOptions: { force: boolean }
      ): Promise<unknown>;
    };
    for (const { runId, modal } of cloudRuns) {
      await provider.cleanupModalNodeRun(
        {
          app: modal.app,
          image: modal.image,
          ...(modal.region === undefined ? {} : { region: modal.region }),
          credentialEnv: modal.credentialEnv
        },
        `ultrafuzz-${runId}`,
        { force: input.confirmed === true }
      );
    }
    return undefined;
  } catch (error) {
    if (isRecord(error) && error.code === "MODAL_NODE_CLEANUP_REFUSED") {
      return runtimeError(
        "CLEAN_CLOUD_STORAGE_REFUSED",
        "cloud run storage cleanup was refused because active sandboxes remain; rerun with --yes or --confirm to terminate them, or wait for them to finish; local evidence was preserved",
        "clean",
        ".ultrafuzz/runs"
      );
    }
    return runtimeError(
      "CLEAN_CLOUD_STORAGE_FAILED",
      "cloud run storage cleanup failed; local evidence was preserved",
      "clean",
      ".ultrafuzz/runs"
    );
  }
}

function cloudRunsForCleanup(planned: PlannedRemoval[]): Array<{ runId: string; modal: ModalExecutionProviderConfig }> {
  const runRoots = planned.flatMap((removal) => {
    const match = /^runs\/([A-Za-z0-9][A-Za-z0-9._-]*)$/u.exec(removal.selection);
    if (match?.[1] !== undefined) {
      return [{ runId: match[1], root: removal.absolutePath }];
    }
    if (removal.selection !== "runs") return [];
    return fs
      .readdirSync(removal.absolutePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => ({ runId: entry.name, root: path.join(removal.absolutePath, entry.name) }));
  });
  return runRoots.flatMap(({ runId, root }) => {
    const modal = readPersistedModalExecution(root);
    return modal === undefined ? [] : [{ runId, modal }];
  });
}

function readPersistedModalExecution(runRoot: string): ModalExecutionProviderConfig | undefined {
  const planPath = path.join(runRoot, "plan.json");
  if (!fs.existsSync(planPath)) return undefined;
  assertNoSymlinkComponents(runRoot, planPath, "cloud cleanup plan");
  const plan = readRunPlanDocument(planPath, path.basename(runRoot));
  if (plan.execution.mode !== "cloud") return undefined;
  const modal = plan.execution.providers.modal;
  if (modal === undefined) throw new Error("persisted cloud cleanup plan is missing its Modal provider");
  return modal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const cleanGenerated = cleanRun;

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
