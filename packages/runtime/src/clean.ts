import fs from "node:fs";
import path from "node:path";

import { appendLineDurable, assertNoSymlinkComponents, safeResolveInside } from "@ultrafuzz/artifacts";
import {
  validateCleanPolicy,
  type CleanPolicyInput,
  type PolicyDiagnostic,
  type PolicyResult
} from "@ultrafuzz/security";

const RUNTIME_SCHEMA_VERSION = "ultrafuzz.runtime.v1" as const;
const CLEAN_AUDIT_SCHEMA_VERSION = "ultrafuzz.clean.audit.v1" as const;

type RuntimeDiagnosticSeverity = "error" | "warning" | "info";

interface RuntimeDiagnostic {
  code: string;
  message: string;
  severity: RuntimeDiagnosticSeverity;
  source: string;
  path?: string;
  details?: Record<string, unknown>;
}

export interface CleanOperationResult<T> {
  schema_version: typeof RUNTIME_SCHEMA_VERSION;
  ok: boolean;
  diagnostics: RuntimeDiagnostic[];
  value?: T;
}

export interface CleanGeneratedInput {
  projectRoot: string;
  selections: string[];
  confirmed?: boolean;
  dryRun?: boolean;
}

export interface CleanGeneratedValue {
  dry_run: boolean;
  removed: string[];
  audit: {
    schema_version: typeof CLEAN_AUDIT_SCHEMA_VERSION;
    audit_path: string;
    selections: string[];
  };
}

interface PlannedRemoval {
  selection: string;
  absolutePath: string;
  existed: boolean;
}

export async function cleanRun(input: CleanGeneratedInput): Promise<CleanOperationResult<CleanGeneratedValue>> {
  const policyInput: CleanPolicyInput = {
    selections: input.selections,
    confirmed: input.confirmed,
    dryRun: input.dryRun
  };
  const policy = validateCleanPolicy(policyInput);
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
  if (!realPathInside(generatedRoot, absolutePath)) {
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

function realPathInside(root: string, candidate: string): boolean {
  const rootReal = fs.realpathSync.native(root);
  const candidateReal = fs.realpathSync.native(candidate);
  const relative = path.relative(rootReal, candidateReal);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function policyDiagnostics<T>(policy: PolicyResult<T>, source: string): RuntimeDiagnostic[] {
  return policy.diagnostics.map((diagnostic: PolicyDiagnostic) => ({
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnostic.severity,
    source,
    ...(diagnostic.path ? { path: diagnostic.path } : {}),
    ...(diagnostic.details ? { details: diagnostic.details } : {})
  }));
}

function runtimeResult<T>(ok: boolean, value?: T, diagnostics: RuntimeDiagnostic[] = []): CleanOperationResult<T> {
  return {
    schema_version: RUNTIME_SCHEMA_VERSION,
    ok,
    diagnostics,
    ...(value !== undefined ? { value } : {})
  };
}

function runtimeFailure<T>(diagnostics: RuntimeDiagnostic[]): CleanOperationResult<T> {
  return {
    schema_version: RUNTIME_SCHEMA_VERSION,
    ok: false,
    diagnostics
  };
}

function runtimeError(
  code: string,
  message: string,
  source: string,
  pathValue?: string,
  details?: Record<string, unknown>
): RuntimeDiagnostic {
  return {
    code,
    message,
    severity: "error",
    source,
    ...(pathValue !== undefined ? { path: pathValue } : {}),
    ...(details !== undefined ? { details } : {})
  };
}

function hasRuntimeErrors(diagnostics: RuntimeDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}
