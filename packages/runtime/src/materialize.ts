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
import {
  loadOperatorAuthenticatedDataGovernancePolicy,
  loadOperatorAuthenticatedMaterializeReviewAuthorities,
  loadAndVerifyMaterializeReviewSignoff,
  materializeReviewSignoffRequest,
  assertMaterializeReviewTargetRemainedCurrent,
  type MaterializeReviewSignoff,
  type MaterializeReviewSigningAuthority,
  type MaterializeReviewSignoffRequest
} from "./review-signoff.js";
import { loadVerifiedFinalReportSnapshot } from "./verified-output.js";

interface PlannedMaterialization {
  selection: MaterializeCopySelection;
  sourcePath: string;
  destinationPath: string;
  bytes: Buffer;
  sizeBytes: number;
  sha256: string;
}

const MAX_MATERIALIZE_SOURCE_BYTES = 64 * 1024 * 1024;

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

  let productionSourceRoots: string[];
  try {
    productionSourceRoots = loadOperatorAuthenticatedDataGovernancePolicy({
      projectRoot,
      layout,
      operatorPolicyJson: input.operatorDataGovernancePolicy
    }).production_source_roots;
  } catch (error) {
    return runtimeFailure([
      runtimeError(
        "MATERIALIZE_GOVERNANCE_AUTHORITY_INVALID",
        error instanceof Error ? error.message : String(error),
        "materialize",
        layout.root
      )
    ]);
  }
  const reviewSignoffRequired = publicationSensitiveMaterialization(layout, plannedCopies, productionSourceRoots);
  let reviewSignoffRequest: MaterializeReviewSignoffRequest | undefined;
  let reviewSignoff: MaterializeReviewSignoff | undefined;
  let reviewAuthorities: MaterializeReviewSigningAuthority[];
  if (reviewSignoffRequired) {
    try {
      reviewAuthorities = loadOperatorAuthenticatedMaterializeReviewAuthorities({
        projectRoot,
        layout,
        operatorPolicyJson: input.operatorDataGovernancePolicy
      });
      reviewSignoffRequest = materializeReviewSignoffRequest({
        projectRoot,
        layout,
        selections: plannedCopies.map((copy) => ({
          source: copy.selection.source,
          destination: copy.selection.destination,
          sha256: copy.sha256
        })),
        authorities: reviewAuthorities
      });
    } catch (error) {
      return runtimeFailure([
        runtimeError(
          "MATERIALIZE_REVIEW_AUTHORITY_INVALID",
          error instanceof Error ? error.message : String(error),
          "materialize",
          layout.root
        )
      ]);
    }
    if (input.dryRun !== true) {
      if (input.reviewSignoffPath === undefined) {
        return runtimeFailure([
          runtimeError(
            "MATERIALIZE_REVIEW_SIGNOFF_REQUIRED",
            "publication-sensitive materialization requires an operator-owned review signoff outside the project",
            "materialize",
            "reviewSignoffPath",
            {
              required_signoff: {
                ...reviewSignoffRequest,
                reviewer: "<reviewer identity>",
                reviewed_at: "<ISO 8601 timestamp>",
                signing_key_id: "<trusted_signers key_id>",
                signature: "<canonical base64 Ed25519 signature>"
              }
            }
          )
        ]);
      }
      try {
        reviewSignoff = loadAndVerifyMaterializeReviewSignoff({
          signoffPath: input.reviewSignoffPath,
          projectRoot,
          layout,
          expected: reviewSignoffRequest,
          authorities: reviewAuthorities
        });
      } catch (error) {
        return runtimeFailure([
          runtimeError(
            "MATERIALIZE_REVIEW_SIGNOFF_INVALID",
            error instanceof Error ? error.message : String(error),
            "materialize",
            input.reviewSignoffPath,
            { required_signoff: reviewSignoffRequest }
          )
        ]);
      }
    }
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
    if (reviewSignoffRequest !== undefined) {
      try {
        assertMaterializeReviewTargetRemainedCurrent(projectRoot, reviewSignoffRequest);
      } catch (error) {
        return runtimeFailure([
          runtimeError(
            "MATERIALIZE_REVIEW_TARGET_CHANGED",
            error instanceof Error ? error.message : String(error),
            "materialize",
            projectRoot
          )
        ]);
      }
    }
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
        writeMaterializationSnapshot(copy, projectRoot, input.allowOverwrite === true);
      } catch (error) {
        diagnostics.push(
          runtimeError(
            "MATERIALIZE_DESTINATION_RACE",
            `destination ${copy.selection.destination} changed or could not be created safely`,
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
    allow_overwrite: false,
    copies: plannedCopies.map((copy) => ({
      source: copy.selection.source,
      destination: copy.selection.destination,
      size_bytes: copy.sizeBytes,
      sha256: copy.sha256
    })),
    patches: [],
    ...(reviewSignoff === undefined ? {} : { review_signoff: reviewSignoff })
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
    review_signoff_required: reviewSignoffRequired,
    ...(reviewSignoffRequest === undefined ? {} : { review_signoff_request: reviewSignoffRequest }),
    audit: {
      schema_version: MATERIALIZE_AUDIT_SCHEMA_VERSION,
      audit_id: auditRecord.audit_id,
      mode: auditRecord.mode,
      unstaged: true,
      audit_path: auditPath,
      event_id: event.event_id,
      copies: auditRecord.copies,
      patches: [],
      ...(reviewSignoff === undefined ? {} : { review_signoff: reviewSignoff })
    }
  });
}

export const materializeRun = materializeSelection;

function publicationSensitiveMaterialization(
  layout: RunLayout,
  copies: PlannedMaterialization[],
  productionSourceRoots: string[]
): boolean {
  if (
    copies.some((copy) =>
      productionSourceRoots.some(
        (root) =>
          root === "." || copy.selection.destination === root || copy.selection.destination.startsWith(`${root}/`)
      )
    )
  ) {
    return true;
  }
  try {
    const report = loadVerifiedFinalReportSnapshot(layout.root);
    const reportPaths = new Set(
      [report.artifacts.json_path, report.artifacts.markdown_path].map((entry) => path.resolve(entry))
    );
    const reportDigests = new Set([sha256Bytes(report.json_bytes), sha256Bytes(report.markdown_bytes)]);
    if (copies.some((copy) => reportPaths.has(path.resolve(copy.sourcePath)) || reportDigests.has(copy.sha256))) {
      return true;
    }
  } catch {
    // A conventional final-report selection still enters the review path; the
    // request builder will then return the specific authenticated-report error.
  }
  return copies.some((copy) => /^artifacts\/[^/]*final-report(?:\/|$)/u.test(copy.selection.source));
}

function writeMaterializationSnapshot(
  copy: PlannedMaterialization,
  projectRoot: string,
  allowOverwrite: boolean
): void {
  const destinationDirectory = path.dirname(copy.destinationPath);
  assertNoSymlinkComponents(projectRoot, destinationDirectory, "materialize destination directory");
  if (!allowOverwrite) {
    fs.writeFileSync(copy.destinationPath, copy.bytes, { flag: "wx", mode: 0o600 });
    return;
  }
  const temporaryPath = path.join(
    destinationDirectory,
    `.${path.basename(copy.destinationPath)}.ultrafuzz-materialize-${process.pid}-${crypto.randomUUID()}.tmp`
  );
  try {
    fs.writeFileSync(temporaryPath, copy.bytes, { flag: "wx", mode: 0o600 });
    const temporaryStat = fs.lstatSync(temporaryPath);
    if (temporaryStat.isSymbolicLink() || !temporaryStat.isFile() || temporaryStat.nlink !== 1) {
      throw new Error("temporary materialization is not a singly linked regular file");
    }
    if (temporaryStat.size !== copy.sizeBytes || !fs.readFileSync(temporaryPath).equals(copy.bytes)) {
      throw new Error("temporary materialization does not match the reviewed source snapshot");
    }
    assertNoSymlinkComponents(projectRoot, destinationDirectory, "materialize destination directory");

    // POSIX rename replaces the destination directory entry itself. If an attacker swaps the checked
    // destination for a symlink, the symlink is replaced rather than followed, so its target is never
    // opened for writing. Keeping the temporary file in the same directory also makes the replacement
    // atomic and avoids an EXDEV fallback with weaker semantics.
    fs.renameSync(temporaryPath, copy.destinationPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function planCopy(
  layout: RunLayout,
  projectRoot: string,
  copy: MaterializeCopySelection,
  allowOverwrite: boolean,
  diagnostics: RuntimeDiagnostic[]
): PlannedMaterialization | undefined {
  const sourcePath = resolveSource(copy.source, layout, diagnostics);
  const destinationPath = resolveDestination(copy.destination, projectRoot, diagnostics);
  if (sourcePath === undefined || destinationPath === undefined) {
    return undefined;
  }
  try {
    const bytes = readRegularFileSnapshot(sourcePath, MAX_MATERIALIZE_SOURCE_BYTES);
    return {
      selection: copy,
      sourcePath,
      destinationPath,
      bytes,
      sizeBytes: bytes.length,
      sha256: sha256Bytes(bytes)
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
    return undefined;
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
