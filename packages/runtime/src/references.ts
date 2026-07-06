import path from "node:path";

import { statusProjectReferences, syncProjectReferences, updateProjectReferencesLatest } from "@ultrafuzz/references";

import type {
  ReferencesStatusInput,
  ReferencesStatusValue,
  ReferencesSyncInput,
  ReferencesSyncValue,
  ReferencesUpdateInput,
  ReferencesUpdateValue,
  RuntimeDiagnostic
} from "./types.js";
import { diagnosticFromError, runtimeFailure, runtimeResult } from "./utils.js";

export function referencesStatus(input: ReferencesStatusInput) {
  try {
    const report = statusProjectReferences(path.resolve(input.projectRoot));
    const value: ReferencesStatusValue = {
      catalog_path: report.catalogPath,
      cache_root: report.cacheRoot,
      references: report.references.map((reference) => ({
        id: reference.id,
        repo: reference.repo,
        commit: reference.commit,
        cache_dir: reference.cacheDir,
        ok: reference.ok,
        messages: reference.messages
      }))
    };
    return runtimeResult(report.ok, value, report.ok ? [] : missingReferenceDiagnostics(value));
  } catch (error) {
    return runtimeFailure<ReferencesStatusValue>([
      diagnosticFromError(error, "references", "REFERENCES_STATUS_FAILED")
    ]);
  }
}

export function referencesSync(input: ReferencesSyncInput) {
  try {
    const report = syncProjectReferences(path.resolve(input.projectRoot));
    const value: ReferencesSyncValue = {
      cache_root: report.cacheRoot,
      synced: report.synced.map((reference) => ({
        id: reference.id,
        repo: reference.repo,
        commit: reference.commit,
        cache_dir: reference.cacheDir,
        fetched: reference.fetched
      }))
    };
    return runtimeResult(true, value);
  } catch (error) {
    return runtimeFailure<ReferencesSyncValue>([diagnosticFromError(error, "references", "REFERENCES_SYNC_FAILED")]);
  }
}

export function referencesUpdate(input: ReferencesUpdateInput) {
  if (input.latest !== true) {
    return runtimeFailure<ReferencesUpdateValue>([
      {
        code: "REFERENCES_UPDATE_REQUIRES_LATEST",
        message: "`ultrafuzz references update` requires `--latest` to intentionally rewrite .ultrafuzz/references.yml",
        severity: "error",
        source: "references",
        path: ".ultrafuzz/references.yml"
      }
    ]);
  }
  try {
    const report = updateProjectReferencesLatest(path.resolve(input.projectRoot));
    return runtimeResult(true, {
      catalog_path: report.catalogPath,
      updated: report.updated.map((reference) => ({
        id: reference.id,
        repo: reference.repo,
        old_commit: reference.oldCommit,
        new_commit: reference.newCommit
      }))
    });
  } catch (error) {
    return runtimeFailure<ReferencesUpdateValue>([
      diagnosticFromError(error, "references", "REFERENCES_UPDATE_FAILED")
    ]);
  }
}

function missingReferenceDiagnostics(value: ReferencesStatusValue): RuntimeDiagnostic[] {
  return value.references
    .filter((reference) => !reference.ok)
    .map((reference) => ({
      code: "REFERENCE_CACHE_MISSING",
      message: `${reference.id}: ${reference.messages.join("; ")}`,
      severity: "error",
      source: "references",
      path: reference.cache_dir
    }));
}
