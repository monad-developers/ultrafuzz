import fs from "node:fs";
import path from "node:path";

import { appendLineDurable, assertNoSymlinkComponents, safeResolveInside } from "@ultrafuzz/artifacts";
import { isPathInside, validateCleanPolicy } from "@ultrafuzz/security";

const CLEAN_AUDIT_SCHEMA_VERSION = "ultrafuzz.clean.audit.v1" as const;

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

  if (input.dryRun !== true) {
    for (const removal of planned) {
      fs.rmSync(removal.absolutePath, { recursive: true, force: false });
    }
  }

  const auditPath = path.join(generatedRoot, "clean-audit.jsonl");
  try {
    assertNoSymlinkComponents(path.resolve(input.projectRoot), auditPath, "clean audit");
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
  const auditRecord = {
    schema_version: CLEAN_AUDIT_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    operation: "cleanRun",
    status: input.dryRun === true ? "dry-run" : "succeeded",
    confirmed: input.confirmed === true,
    selections: planned.map((removal) => ({
      path: removal.selection,
      existed: removal.existed
    }))
  };
  appendLineDurable(auditPath, JSON.stringify(auditRecord));

  return runtimeResult(true, {
    dry_run: input.dryRun === true,
    removed: planned.map((removal) => removal.selection),
    audit: {
      schema_version: CLEAN_AUDIT_SCHEMA_VERSION,
      audit_path: auditPath,
      selections: planned.map((removal) => removal.selection)
    }
  });
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
