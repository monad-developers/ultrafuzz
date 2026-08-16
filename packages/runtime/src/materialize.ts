import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  appendEvent,
  assertNoSymlinkComponents,
  DEFAULT_STRICT_JSONL_MAX_BYTES,
  DEFAULT_STRICT_JSONL_MAX_RECORD_BYTES,
  layoutForRunRoot,
  parseStrictJsonBytes,
  parseStrictJsonlBytes,
  readRegularFileSnapshot,
  safeResolveInside,
  sha256Bytes,
  type RunLayout,
  type StrictJsonlCodec,
  type StrictJsonlSnapshot
} from "@ultrafuzz/artifacts";
import { loadProjectConfig, resolveConfig } from "@ultrafuzz/config";
import {
  isPathInside,
  normalizeRelativePath,
  validateMaterializePolicy,
  type MaterializeCopySelection
} from "@ultrafuzz/security";

import {
  MATERIALIZE_AUDIT_SCHEMA_VERSION,
  MATERIALIZE_COMMIT_WITNESS_SCHEMA_VERSION,
  MATERIALIZE_INTENT_SCHEMA_VERSION,
  MAX_MATERIALIZE_COMMIT_WITNESS_BYTES,
  canonicalMaterializeRecordDigest,
  materializeCommitWitnessMatches,
  materializeAuditCodec,
  materializeIntentCodec,
  parseMaterializeCommitWitness,
  type MaterializeAuditRecord,
  type MaterializeCommitWitness,
  type MaterializeIntentRecord
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

interface OpenedMaterializeDirectory {
  descriptor: number;
  projectRoot: string;
  lexicalPath: string;
  accessPath: string;
  identity: fs.BigIntStats;
}

interface OwnedMaterializeFile {
  descriptor: number;
  directory: OpenedMaterializeDirectory;
  destinationAccessPath: string;
  destination: string;
  expectedSizeBytes: number;
  expectedSha256: string;
  device?: bigint;
  inode?: bigint;
  verifiedGeneration?: fs.BigIntStats;
}

interface MaterializePublicationState {
  owned: OwnedMaterializeFile[];
  directories: OpenedMaterializeDirectory[];
  uncertainReasons: string[];
}

interface DurableJournalAppendOutcome {
  reconciled: boolean;
  postWriteError?: string;
  generation: fs.BigIntStats;
}

interface DurableCommitWitnessOutcome {
  record: MaterializeCommitWitness;
  path: string;
  reconciled: boolean;
  warnings: string[];
}

interface ReservedMaterializeCommitWitness {
  descriptor: number;
  directory: OpenedMaterializeDirectory;
  accessPath: string;
  path: string;
  identity: fs.BigIntStats;
  nonce: string;
}

interface MaterializeJournalState {
  intents: StrictJsonlSnapshot<MaterializeIntentRecord>;
  audits: StrictJsonlSnapshot<MaterializeAuditRecord>;
}

interface StableMaterializeDescriptorSnapshot {
  bytes: Buffer;
  generation: fs.BigIntStats;
}

interface HeldMaterializeJournal<RecordType> {
  descriptor: number;
  directory: OpenedMaterializeDirectory;
  accessPath: string;
  identity: fs.BigIntStats;
  codec: StrictJsonlCodec<RecordType>;
  verifiedGeneration?: fs.BigIntStats;
}

interface MaterializeEvidenceCapture {
  entries: Array<Record<string, unknown>>;
  errors: string[];
}

const MAX_MATERIALIZE_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_MATERIALIZE_COPY_SELECTIONS = 128;
const MAX_MATERIALIZE_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_UNMATCHED_MATERIALIZE_BYTES = 64 * 1024 * 1024;
const MAX_UNMATCHED_MATERIALIZE_COPY_ENTRIES = 1024;
const MATERIALIZE_FILE_MODE = 0o600;

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
  if (!layoutResult.ok || layoutResult.value === undefined) return runtimeFailure(layoutResult.diagnostics);
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
        "copies",
        { actual_entries: copySelections.length, limit_entries: MAX_MATERIALIZE_COPY_SELECTIONS }
      )
    ]);
  }
  if (input.allowOverwrite === true) {
    return runtimeFailure([
      runtimeError(
        "MATERIALIZE_OVERWRITE_UNSUPPORTED",
        "materialization cannot safely replace an exact destination inode while same-user agents remain unrestricted",
        "materialize",
        "allowOverwrite",
        { create_only: true, yolo_mode_preserved: true }
      )
    ]);
  }

  const policy = validateMaterializePolicy({
    patches: input.patches,
    copies: copySelections,
    confirmed: input.confirmed,
    dryRun: input.dryRun,
    allowOverwrite: false,
    mode: input.dryRun ? "dry-run" : "unstaged-working-tree"
  });
  const diagnostics = policyDiagnostics(policy, "materialize");
  if (!policy.ok) return runtimeFailure(diagnostics);

  const operationId = crypto.randomUUID();
  const plannedCopies: PlannedMaterialization[] = [];
  let remainingSnapshotBytes = MAX_MATERIALIZE_SNAPSHOT_BYTES;
  for (const copy of copySelections) {
    const planned = planCopy(layout, projectRoot, copy, remainingSnapshotBytes, diagnostics);
    if (planned === undefined) continue;
    remainingSnapshotBytes -= planned.sizeBytes;
    plannedCopies.push(planned);
  }
  if (hasRuntimeErrors(diagnostics)) return runtimeFailure(diagnostics);

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
  const intentPath = path.join(projectRoot, ".ultrafuzz", "materialize-intent.jsonl");
  let initialAudit: StrictJsonlSnapshot<MaterializeAuditRecord>;
  try {
    initialAudit = readAnchoredMaterializeJournal(projectRoot, auditPath, materializeAuditCodec);
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
  let initialIntent: StrictJsonlSnapshot<MaterializeIntentRecord>;
  try {
    initialIntent = readAnchoredMaterializeJournal(projectRoot, intentPath, materializeIntentCodec);
  } catch (error) {
    return runtimeFailure([
      runtimeError(
        "MATERIALIZE_INTENT_ROOT_UNSAFE",
        error instanceof Error ? error.message : String(error),
        "materialize",
        ".ultrafuzz/materialize-intent.jsonl"
      )
    ]);
  }

  const mode: "dry-run" | "unstaged-working-tree" = input.dryRun === true ? "dry-run" : "unstaged-working-tree";
  const timestamp = new Date().toISOString();
  const commitNonce = input.dryRun === true ? undefined : crypto.randomBytes(32).toString("hex");
  const commitNonceSha256 = commitNonce === undefined ? undefined : sha256Bytes(Buffer.from(commitNonce, "utf8"));
  const copies = plannedCopies.map((copy) => ({
    source: copy.selection.source,
    destination: copy.selection.destination,
    size_bytes: copy.sizeBytes,
    sha256: copy.sha256
  }));
  const initialJournals = { intents: initialIntent, audits: initialAudit };
  let reservedWitness: ReservedMaterializeCommitWitness | undefined;
  if (input.dryRun !== true) {
    let committedWitnessIds: ReadonlySet<string>;
    try {
      assertMaterializeOperationIdUnused(initialJournals, operationId);
      committedWitnessIds = assertUnmatchedMaterializeCapacity(projectRoot, initialJournals, copies, "precheck");
    } catch (error) {
      return runtimeFailure([
        runtimeError(
          "MATERIALIZE_INTENT_CAPACITY_EXCEEDED",
          error instanceof Error ? error.message : String(error),
          "materialize",
          ".ultrafuzz/materialize-intent.jsonl"
        )
      ]);
    }
    try {
      if (commitNonce === undefined) throw new Error("materialize commit nonce is unavailable");
      reservedWitness = reserveMaterializeCommitWitness(projectRoot, operationId, commitNonce, committedWitnessIds);
    } catch (error) {
      return runtimeFailure([
        runtimeError(
          "MATERIALIZE_COMMIT_WITNESS_RESERVATION_FAILED",
          error instanceof Error ? error.message : String(error),
          "materialize",
          ".ultrafuzz/materialize-commits",
          { audit_id: operationId, destination_recovery_required: false, manual_recovery_required: true }
        )
      ]);
    }
  }
  const witnessBinding =
    reservedWitness === undefined
      ? {}
      : {
          commit_nonce_sha256: commitNonceSha256!,
          commit_witness_device: reservedWitness.identity.dev.toString(),
          commit_witness_inode: reservedWitness.identity.ino.toString()
        };
  const auditRecord: MaterializeAuditRecord = {
    schema_version: MATERIALIZE_AUDIT_SCHEMA_VERSION,
    audit_id: operationId,
    run_id: layout.runId,
    timestamp,
    operation: "materializeSelection",
    mode,
    unstaged: true,
    confirmed: input.confirmed === true,
    allow_overwrite: false,
    ...witnessBinding,
    copies,
    patches: [],
    ...(reviewSignoff === undefined ? {} : { review_signoff: reviewSignoff })
  };
  const intentRecord: MaterializeIntentRecord | undefined =
    input.dryRun === true
      ? undefined
      : {
          schema_version: MATERIALIZE_INTENT_SCHEMA_VERSION,
          intent_id: operationId,
          run_id: layout.runId,
          timestamp,
          operation: "materializeSelection",
          mode: "unstaged-working-tree",
          unstaged: true,
          confirmed: true,
          allow_overwrite: false,
          commit_nonce_sha256: witnessBinding.commit_nonce_sha256!,
          commit_witness_device: witnessBinding.commit_witness_device!,
          commit_witness_inode: witnessBinding.commit_witness_inode!,
          copies,
          patches: []
        };

  const publication: MaterializePublicationState = { owned: [], directories: [], uncertainReasons: [] };
  let heldIntent: HeldMaterializeJournal<MaterializeIntentRecord> | undefined;
  if (intentRecord !== undefined) {
    let intentAppend: DurableJournalAppendOutcome;
    try {
      intentAppend = appendExactMaterializeJournal(projectRoot, intentPath, intentRecord, materializeIntentCodec);
    } catch (error) {
      const failure = closeReservedMaterializeWitnessAfterFailure(reservedWitness, error);
      return runtimeFailure([
        runtimeError(
          "MATERIALIZE_INTENT_WRITE_FAILED",
          failure instanceof Error ? failure.message : String(failure),
          "materialize",
          ".ultrafuzz/materialize-intent.jsonl",
          { intent_id: operationId, destination_recovery_required: false, manual_recovery_required: true }
        )
      ]);
    }
    if (intentAppend.reconciled) {
      diagnostics.push(
        materializeWarning(
          "MATERIALIZE_INTENT_WRITE_RECONCILED",
          "the write-ahead intent was accepted only after exact held-descriptor reconciliation",
          ".ultrafuzz/materialize-intent.jsonl",
          { intent_id: operationId, post_write_error: intentAppend.postWriteError }
        )
      );
    }

    try {
      heldIntent = openHeldMaterializeJournal(projectRoot, intentPath, materializeIntentCodec, intentAppend.generation);
      const postIntentJournals = {
        intents: readHeldMaterializeJournal(heldIntent),
        audits: readAnchoredMaterializeJournal(projectRoot, auditPath, materializeAuditCodec)
      };
      const recorded = postIntentJournals.intents.records.find((record) => record.intent_id === operationId);
      if (recorded === undefined || !isDeepStrictEqual(recorded, intentRecord)) {
        throw new Error(`materialize intent ${operationId} is not the exact durable postcheck record`);
      }
      if (postIntentJournals.audits.records.some((record) => record.audit_id === operationId)) {
        throw new Error(`materialize completion ${operationId} appeared before destination publication`);
      }
      assertUnmatchedMaterializeCapacity(projectRoot, postIntentJournals, [], "postcheck");
    } catch (error) {
      let failure = closeHeldMaterializeJournalAfterFailure(heldIntent, error);
      heldIntent = undefined;
      failure = closeReservedMaterializeWitnessAfterFailure(reservedWitness, failure);
      return runtimeFailure([
        runtimeError(
          "MATERIALIZE_INTENT_POSTCHECK_FAILED",
          failure instanceof Error ? failure.message : String(failure),
          "materialize",
          ".ultrafuzz/materialize-intent.jsonl",
          { intent_id: operationId, destination_recovery_required: false, manual_recovery_required: true }
        )
      ]);
    }

    if (reviewSignoffRequest !== undefined) {
      try {
        assertMaterializeReviewTargetRemainedCurrent(projectRoot, reviewSignoffRequest);
      } catch (error) {
        let failure = closeHeldMaterializeJournalAfterFailure(heldIntent, error);
        heldIntent = undefined;
        failure = closeReservedMaterializeWitnessAfterFailure(reservedWitness, failure);
        return runtimeFailure([
          runtimeError(
            "MATERIALIZE_REVIEW_TARGET_CHANGED",
            failure instanceof Error ? failure.message : String(failure),
            "materialize",
            projectRoot,
            { intent_id: operationId, manual_recovery_required: true }
          )
        ]);
      }
    }

    try {
      publishMaterializationSet(plannedCopies, projectRoot, publication);
      verifyOwnedMaterializationSet(publication);
    } catch (error) {
      let failure = closeHeldMaterializeJournalAfterFailure(heldIntent, error);
      heldIntent = undefined;
      failure = closeReservedMaterializeWitnessAfterFailure(reservedWitness, failure);
      return materializePublicationFailure(
        "MATERIALIZE_DESTINATION_WRITE_FAILED",
        "destination publication failed; held descriptors were retained for bounded recovery evidence",
        failure,
        publication,
        operationId
      );
    }
  }

  const verifyCompletionBoundary =
    publication.owned.length === 0
      ? undefined
      : () => {
          verifyOwnedMaterializationSet(publication);
          if (heldIntent === undefined || intentRecord === undefined) {
            throw new Error("materialize completion lost its held durable intent");
          }
          assertHeldMaterializeIntentCurrent(heldIntent, intentRecord);
          verifyOwnedMaterializationGenerationSet(publication);
          assertHeldMaterializeJournalGeneration(heldIntent);
        };
  let auditAppend: DurableJournalAppendOutcome;
  try {
    auditAppend = appendExactMaterializeJournal(
      projectRoot,
      auditPath,
      auditRecord,
      materializeAuditCodec,
      verifyCompletionBoundary,
      verifyCompletionBoundary
    );
  } catch (error) {
    let failure = closeHeldMaterializeJournalAfterFailure(heldIntent, error);
    heldIntent = undefined;
    failure = closeReservedMaterializeWitnessAfterFailure(reservedWitness, failure);
    if (publication.owned.length > 0 || publication.uncertainReasons.length > 0) {
      return materializePublicationFailure(
        "MATERIALIZE_AUDIT_WRITE_FAILED",
        "completed-operation audit state is unproven; destinations were not rolled back and held descriptors were retained",
        failure,
        publication,
        operationId
      );
    }
    return runtimeFailure([
      runtimeError(
        "MATERIALIZE_AUDIT_WRITE_FAILED",
        failure instanceof Error ? failure.message : String(failure),
        "materialize",
        ".ultrafuzz/materialize-audit.jsonl",
        { audit_id: operationId, recovery_required: false }
      )
    ]);
  }
  if (auditAppend.reconciled) {
    diagnostics.push(
      materializeWarning(
        "MATERIALIZE_AUDIT_WRITE_RECONCILED",
        "the completion audit was accepted only after exact held-descriptor reconciliation",
        ".ultrafuzz/materialize-audit.jsonl",
        { audit_id: operationId, post_write_error: auditAppend.postWriteError }
      )
    );
  }

  let commitWitness: DurableCommitWitnessOutcome | undefined;
  let heldAudit: HeldMaterializeJournal<MaterializeAuditRecord> | undefined;
  if (intentRecord !== undefined) {
    try {
      heldAudit = openHeldMaterializeJournal(projectRoot, auditPath, materializeAuditCodec, auditAppend.generation);
      if (reservedWitness === undefined) throw new Error("materialize commit witness reservation is unavailable");
      const witnessRecord = materializeCommitWitness(intentRecord, auditRecord, reservedWitness);
      const verifyCommitBoundary = () => {
        verifyOwnedMaterializationSet(publication);
        if (heldIntent === undefined || heldAudit === undefined) {
          throw new Error("materialize commit lost a held journal descriptor");
        }
        assertHeldMaterializeIntentCurrent(heldIntent, intentRecord);
        assertHeldMaterializeAuditCurrent(heldAudit, auditRecord);
        verifyOwnedMaterializationGenerationSet(publication);
        assertHeldMaterializeJournalGeneration(heldIntent);
        assertHeldMaterializeJournalGeneration(heldAudit);
      };
      commitWitness = commitReservedMaterializeWitness(
        projectRoot,
        reservedWitness,
        witnessRecord,
        verifyCommitBoundary
      );
      reservedWitness = undefined;
    } catch (error) {
      let failure = closeReservedMaterializeWitnessAfterFailure(reservedWitness, error);
      failure = closeHeldMaterializeJournalAfterFailure(heldAudit, failure);
      heldAudit = undefined;
      failure = closeHeldMaterializeJournalAfterFailure(heldIntent, failure);
      heldIntent = undefined;
      return materializePublicationFailure(
        "MATERIALIZE_COMMIT_WITNESS_WRITE_FAILED",
        "completion audit exists but the durable commit witness is absent or unproven",
        failure,
        publication,
        operationId
      );
    }
    if (commitWitness.reconciled || commitWitness.warnings.length > 0) {
      diagnostics.push(
        materializeWarning(
          "MATERIALIZE_COMMIT_WITNESS_RECONCILED",
          "the durable commit witness required exact reconciliation or had a post-proof close warning",
          path.relative(projectRoot, commitWitness.path).split(path.sep).join("/"),
          {
            witness_id: commitWitness.record.witness_id,
            reconciled: commitWitness.reconciled,
            warnings: commitWitness.warnings
          }
        )
      );
    }
  }

  const heldAuditCloseErrors = closeHeldMaterializeJournal(heldAudit);
  heldAudit = undefined;
  if (heldAuditCloseErrors.length > 0) {
    diagnostics.push(
      materializeWarning(
        "MATERIALIZE_AUDIT_DESCRIPTOR_CLOSE_FAILED",
        "materialization committed, but the held audit descriptor did not close cleanly",
        ".ultrafuzz/materialize-audit.jsonl",
        { close_errors: heldAuditCloseErrors }
      )
    );
  }

  const heldIntentCloseErrors = closeHeldMaterializeJournal(heldIntent);
  heldIntent = undefined;
  if (heldIntentCloseErrors.length > 0) {
    diagnostics.push(
      materializeWarning(
        "MATERIALIZE_INTENT_DESCRIPTOR_CLOSE_FAILED",
        "materialization committed, but the held intent descriptor did not close cleanly",
        ".ultrafuzz/materialize-intent.jsonl",
        { close_errors: heldIntentCloseErrors }
      )
    );
  }

  const closeErrors = closeMaterializePublication(publication);
  if (closeErrors.length > 0) {
    diagnostics.push(
      materializeWarning(
        "MATERIALIZE_DESCRIPTOR_CLOSE_FAILED",
        "materialization committed, but held destination descriptors did not all close cleanly",
        "copies",
        { close_errors: closeErrors }
      )
    );
  }

  let eventId: string | undefined;
  try {
    eventId = appendEvent(layout, {
      eventType: "materialize-selection",
      status: mode === "dry-run" ? "dry-run" : "succeeded",
      payload: {
        audit_path: path.relative(layout.root, auditPath).split(path.sep).join("/"),
        mode: auditRecord.mode,
        unstaged: true,
        copies: auditRecord.copies,
        patches: []
      }
    }).event_id;
  } catch (error) {
    diagnostics.push(
      materializeWarning(
        "MATERIALIZE_EVENT_WRITE_FAILED",
        "materialization completed and was audited, but its run event could not be appended",
        layout.eventsPath,
        { error: error instanceof Error ? error.message : String(error) }
      )
    );
  }

  return runtimeResult(
    true,
    {
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
        ...(eventId === undefined ? {} : { event_id: eventId }),
        copies: auditRecord.copies,
        patches: [],
        ...(reviewSignoff === undefined ? {} : { review_signoff: reviewSignoff })
      }
    },
    diagnostics
  );
}

export const materializeRun = materializeSelection;

function publicationSensitiveMaterialization(
  layout: RunLayout,
  copies: PlannedMaterialization[],
  productionSourceRoots: string[]
): boolean {
  if (
    copies.some((copy) => {
      const destinationKey = materializationPathPolicyKey(copy.selection.destination);
      return productionSourceRoots.some((root) => {
        if (root === ".") return true;
        const rootKey = materializationPathPolicyKey(root);
        return destinationKey === rootKey || destinationKey.startsWith(`${rootKey}/`);
      });
    })
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
    // Conventional final-report selections still enter the authenticated review path.
  }
  return copies.some((copy) =>
    /^artifacts\/[^/]*final-report(?:\/|$)/u.test(materializationPathPolicyKey(copy.selection.source))
  );
}

function materializationPathPolicyKey(value: string): string {
  return normalizeRelativePath(value).normalize("NFC").toLowerCase();
}

function appendExactMaterializeJournal<RecordType>(
  projectRoot: string,
  journalPath: string,
  record: RecordType,
  codec: StrictJsonlCodec<RecordType>,
  beforeWrite?: () => void,
  afterWrite?: () => void
): DurableJournalAppendOutcome {
  const directory = openMaterializeDestinationDirectory(projectRoot, path.dirname(journalPath));
  const accessPath = path.join(directory.accessPath, path.basename(journalPath));
  let descriptor: number | undefined;
  let result: DurableJournalAppendOutcome | undefined;
  let failure: unknown;
  try {
    descriptor = fs.openSync(
      accessPath,
      fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
      MATERIALIZE_FILE_MODE
    );
    const initial = assertAnchoredMaterializeFile(descriptor, accessPath, codec.label);
    const prior = readStableMaterializeDescriptor(
      descriptor,
      codec.maxBytes ?? DEFAULT_STRICT_JSONL_MAX_BYTES,
      codec.label
    );
    const priorSnapshot = parseStrictJsonlBytes(prior, codec);
    const identity = codec.identity(record);
    if (priorSnapshot.records.some((entry) => codec.identity(entry) === identity)) {
      throw new Error(`${codec.label} already contains identity ${JSON.stringify(identity)}; append was not attempted`);
    }

    const payload = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (payload.byteLength - 1 > (codec.maxRecordBytes ?? DEFAULT_STRICT_JSONL_MAX_RECORD_BYTES)) {
      throw new Error(`${codec.label} record exceeds the serialized byte limit`);
    }
    const expectedBytes = Buffer.concat([prior, payload]);
    const expectedSnapshot = parseStrictJsonlBytes(expectedBytes, codec);
    const appended = expectedSnapshot.records.at(-1);
    if (appended === undefined || !isDeepStrictEqual(appended, record)) {
      throw new Error(`${codec.label} record is not its exact canonical contract value`);
    }
    assertAnchoredMaterializeFile(descriptor, accessPath, codec.label, initial);
    assertMaterializeDirectoryCurrent(projectRoot, directory);
    // This is the point-in-time completion boundary: the exact held
    // destinations are reverified after the audit inode is opened and parsed,
    // with no filesystem operation between verification and the append write.
    beforeWrite?.();

    let writeReturnedFull = false;
    let writeReturnedPartial = false;
    let postWriteError: unknown;
    try {
      const written = fs.writeSync(descriptor, payload, 0, payload.byteLength, null);
      if (written !== payload.byteLength) {
        writeReturnedPartial = true;
        throw new Error(`${codec.label} append wrote ${written} of ${payload.byteLength} bytes`);
      }
      writeReturnedFull = true;
      fs.fsyncSync(descriptor);
      fs.fsyncSync(directory.descriptor);
      assertMaterializeDirectoryCurrent(projectRoot, directory);
    } catch (error) {
      postWriteError = error;
    }
    if (writeReturnedPartial) throw postWriteError;

    try {
      fs.fsyncSync(descriptor);
      fs.fsyncSync(directory.descriptor);
      assertMaterializeDirectoryCurrent(projectRoot, directory);
      const final = captureStableMaterializeDescriptor(
        descriptor,
        codec.maxBytes ?? DEFAULT_STRICT_JSONL_MAX_BYTES,
        codec.label
      );
      if (!final.bytes.equals(expectedBytes)) {
        throw new Error(`${codec.label} final bytes are not exactly the prior snapshot plus this append`);
      }
      const finalSnapshot = parseStrictJsonlBytes(final.bytes, codec);
      const finalRecord = finalSnapshot.records.at(-1);
      if (finalRecord === undefined || !isDeepStrictEqual(finalRecord, record)) {
        throw new Error(`${codec.label} final record is not the exact requested record`);
      }
      assertAnchoredMaterializeFile(descriptor, accessPath, codec.label, initial);
      assertMaterializeDirectoryCurrent(projectRoot, directory);
      afterWrite?.();
      assertAnchoredMaterializeFileGeneration(descriptor, accessPath, codec.label, final.generation);
      assertMaterializeDirectoryCurrent(projectRoot, directory);
      result = {
        reconciled: !writeReturnedFull || postWriteError !== undefined,
        generation: final.generation,
        ...(postWriteError === undefined
          ? {}
          : { postWriteError: postWriteError instanceof Error ? postWriteError.message : String(postWriteError) })
      };
    } catch (error) {
      failure = new AggregateError(
        postWriteError === undefined ? [error] : [postWriteError, error],
        `${codec.label} append could not be proven exact and durable`
      );
    }
  } catch (error) {
    failure = aggregateMaterializeFailure(failure, error, `${codec.label} append failed`);
  }
  if (descriptor !== undefined) {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      if (result === undefined) {
        failure = aggregateMaterializeFailure(failure, error, `failed to close ${codec.label}`);
      } else {
        result = materializeJournalAppendWarning(result, error, `failed to close ${codec.label}`);
      }
    }
  }
  try {
    closeMaterializeDirectory(directory);
  } catch (error) {
    if (result === undefined) {
      failure = aggregateMaterializeFailure(failure, error, `failed to close ${codec.label} directory`);
    } else {
      result = materializeJournalAppendWarning(result, error, `failed to close ${codec.label} directory`);
    }
  }
  if (failure !== undefined) throw failure;
  if (result === undefined) throw new Error(`${codec.label} append produced no durability result`);
  return result;
}

function materializeJournalAppendWarning(
  outcome: DurableJournalAppendOutcome,
  error: unknown,
  context: string
): DurableJournalAppendOutcome {
  const message = `${context}: ${error instanceof Error ? error.message : String(error)}`;
  return {
    ...outcome,
    reconciled: true,
    postWriteError: outcome.postWriteError === undefined ? message : `${outcome.postWriteError}; ${message}`
  };
}

function materializeCommitWitness(
  intent: MaterializeIntentRecord,
  completion: MaterializeAuditRecord,
  reservation: ReservedMaterializeCommitWitness
): MaterializeCommitWitness {
  return {
    schema_version: MATERIALIZE_COMMIT_WITNESS_SCHEMA_VERSION,
    witness_id: crypto.randomUUID(),
    audit_id: completion.audit_id,
    intent_id: intent.intent_id,
    run_id: completion.run_id,
    committed_at: new Date().toISOString(),
    commit_nonce: reservation.nonce,
    commit_witness_device: reservation.identity.dev.toString(),
    commit_witness_inode: reservation.identity.ino.toString(),
    intent_sha256: canonicalMaterializeRecordDigest(intent),
    completion_sha256: canonicalMaterializeRecordDigest(completion),
    copies_sha256: canonicalMaterializeRecordDigest(intent.copies)
  };
}

function reserveMaterializeCommitWitness(
  projectRoot: string,
  auditId: string,
  nonce: string,
  committedWitnessIds: ReadonlySet<string>
): ReservedMaterializeCommitWitness {
  const witnessDirectory = path.join(projectRoot, ".ultrafuzz", "materialize-commits");
  const directory = openMaterializeDestinationDirectory(projectRoot, witnessDirectory);
  const witnessPath = path.join(witnessDirectory, `${auditId}.json`);
  const accessPath = path.join(directory.accessPath, path.basename(witnessPath));
  let descriptor: number | undefined;
  try {
    assertMaterializeCommitReservationCapacity(directory, committedWitnessIds);
    descriptor = fs.openSync(
      accessPath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      MATERIALIZE_FILE_MODE
    );
    const identity = assertNewMaterializeCommitWitnessFile(descriptor, accessPath);
    fs.fsyncSync(descriptor);
    fs.fsyncSync(directory.descriptor);
    assertAnchoredMaterializeFileGeneration(descriptor, accessPath, "materialize commit witness", identity);
    assertMaterializeDirectoryCurrent(projectRoot, directory);
    return {
      descriptor,
      directory,
      accessPath,
      path: witnessPath,
      identity,
      nonce
    };
  } catch (error) {
    let failure: unknown = error;
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (closeError) {
        failure = aggregateMaterializeFailure(failure, closeError, "failed to close commit witness reservation");
      }
    }
    try {
      closeMaterializeDirectory(directory);
    } catch (closeError) {
      failure = aggregateMaterializeFailure(
        failure,
        closeError,
        "failed to close commit witness reservation directory"
      );
    }
    throw failure;
  }
}

function assertMaterializeCommitReservationCapacity(
  directory: OpenedMaterializeDirectory,
  committedWitnessIds: ReadonlySet<string>
): void {
  const opened = fs.opendirSync(directory.accessPath);
  let entries = 0;
  let unmatched = 0;
  try {
    for (;;) {
      const entry = opened.readSync();
      if (entry === null) break;
      entries += 1;
      if (entries > 100_000) {
        throw new Error("materialize commit witness directory exceeds the 100000-entry inspection limit");
      }
      const auditId = entry.name.endsWith(".json") ? entry.name.slice(0, -".json".length) : undefined;
      if (auditId !== undefined && committedWitnessIds.has(auditId)) continue;
      unmatched += 1;
      if (unmatched >= MAX_UNMATCHED_MATERIALIZE_COPY_ENTRIES) {
        throw new Error(
          `materialize commit reservations reached the ${MAX_UNMATCHED_MATERIALIZE_COPY_ENTRIES}-entry limit`
        );
      }
    }
  } finally {
    opened.closeSync();
  }
}

function commitReservedMaterializeWitness(
  projectRoot: string,
  reservation: ReservedMaterializeCommitWitness,
  record: MaterializeCommitWitness,
  beforeCommit: () => void
): DurableCommitWitnessOutcome {
  const { descriptor, directory, accessPath } = reservation;
  const payload = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  if (payload.byteLength > MAX_MATERIALIZE_COMMIT_WITNESS_BYTES) {
    throw new Error("materialize commit witness exceeds its canonical byte limit");
  }

  let result: DurableCommitWitnessOutcome | undefined;
  let failure: unknown;
  try {
    assertMaterializeDirectoryCurrent(projectRoot, directory);
    beforeCommit();
    assertAnchoredMaterializeFileGeneration(
      descriptor,
      accessPath,
      "materialize commit witness reservation",
      reservation.identity
    );
    assertMaterializeDirectoryCurrent(projectRoot, directory);

    let writeReturnedFull = false;
    let writeReturnedPartial = false;
    let postWriteError: unknown;
    try {
      const written = fs.writeSync(descriptor, payload, 0, payload.byteLength, 0);
      if (written !== payload.byteLength) {
        writeReturnedPartial = true;
        throw new Error(`materialize commit witness wrote ${written} of ${payload.byteLength} bytes`);
      }
      writeReturnedFull = true;
      fs.fsyncSync(descriptor);
      fs.fsyncSync(directory.descriptor);
      assertMaterializeDirectoryCurrent(projectRoot, directory);
    } catch (error) {
      postWriteError = error;
    }
    if (writeReturnedPartial) throw postWriteError;

    fs.fsyncSync(descriptor);
    fs.fsyncSync(directory.descriptor);
    assertMaterializeDirectoryCurrent(projectRoot, directory);
    const captured = captureStableMaterializeDescriptor(
      descriptor,
      MAX_MATERIALIZE_COMMIT_WITNESS_BYTES,
      "materialize commit witness"
    );
    if (!captured.bytes.equals(payload)) {
      throw new Error("materialize commit witness bytes are not the exact canonical record");
    }
    const parsed = parseMaterializeCommitWitness(
      parseStrictJsonBytes(captured.bytes, {
        maxBytes: MAX_MATERIALIZE_COMMIT_WITNESS_BYTES,
        maxDepth: 8,
        maxItems: 16,
        maxProperties: 32
      })
    );
    if (!isDeepStrictEqual(parsed, record)) {
      throw new Error("materialize commit witness is not the exact requested contract value");
    }
    assertAnchoredMaterializeFile(descriptor, accessPath, "materialize commit witness", reservation.identity);
    assertMaterializeDirectoryCurrent(projectRoot, directory);
    assertAnchoredMaterializeFileGeneration(descriptor, accessPath, "materialize commit witness", captured.generation);
    assertMaterializeDirectoryCurrent(projectRoot, directory);
    result = {
      record,
      path: reservation.path,
      reconciled: !writeReturnedFull || postWriteError !== undefined,
      warnings:
        postWriteError === undefined
          ? []
          : [postWriteError instanceof Error ? postWriteError.message : String(postWriteError)]
    };
  } catch (error) {
    failure = error;
  }
  reservation.descriptor = -1;
  if (descriptor >= 0) {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      if (result === undefined) {
        failure = aggregateMaterializeFailure(failure, error, "failed to close materialize commit witness");
      } else {
        result.warnings.push(`failed to close materialize commit witness: ${String(error)}`);
      }
    }
  }
  try {
    closeMaterializeDirectory(directory);
  } catch (error) {
    if (result === undefined) {
      failure = aggregateMaterializeFailure(failure, error, "failed to close materialize commit witness directory");
    } else {
      result.warnings.push(`failed to close materialize commit witness directory: ${String(error)}`);
    }
  }
  if (failure !== undefined) throw failure;
  if (result === undefined) throw new Error("materialize commit witness produced no durability result");
  return result;
}

function closeReservedMaterializeWitnessAfterFailure(
  reservation: ReservedMaterializeCommitWitness | undefined,
  primary: unknown
): unknown {
  if (reservation === undefined) return primary;
  let failure = primary;
  if (reservation.descriptor >= 0) {
    const descriptor = reservation.descriptor;
    reservation.descriptor = -1;
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      failure = aggregateMaterializeFailure(failure, error, "failed to close commit witness reservation");
    }
  }
  try {
    closeMaterializeDirectory(reservation.directory);
  } catch (error) {
    failure = aggregateMaterializeFailure(failure, error, "failed to close commit witness reservation directory");
  }
  return failure;
}

function assertNewMaterializeCommitWitnessFile(descriptor: number, accessPath: string): fs.BigIntStats {
  const opened = fs.fstatSync(descriptor, { bigint: true });
  const named = fs.lstatSync(accessPath, { bigint: true });
  if (
    !opened.isFile() ||
    !named.isFile() ||
    opened.nlink !== 1n ||
    named.nlink !== 1n ||
    opened.size !== 0n ||
    named.size !== 0n ||
    (opened.mode & 0o7777n) !== BigInt(MATERIALIZE_FILE_MODE) ||
    (named.mode & 0o7777n) !== BigInt(MATERIALIZE_FILE_MODE) ||
    opened.dev !== named.dev ||
    opened.ino !== named.ino
  ) {
    throw new Error("materialize commit witness is not the exact new mode-0600 singly linked inode");
  }
  return opened;
}

function readAnchoredMaterializeCommitWitness(
  projectRoot: string,
  auditId: string
): MaterializeCommitWitness | undefined {
  const witnessDirectory = path.join(projectRoot, ".ultrafuzz", "materialize-commits");
  let directory: OpenedMaterializeDirectory;
  try {
    directory = openVerifiedMaterializeDirectory(projectRoot, witnessDirectory, "materialize commit witness directory");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    assertNoSymlinkComponents(projectRoot, path.dirname(witnessDirectory), "materialize commit witness root");
    return undefined;
  }
  const accessPath = path.join(directory.accessPath, `${auditId}.json`);
  let descriptor: number | undefined;
  let result: MaterializeCommitWitness | undefined;
  let absent = false;
  let failure: unknown;
  try {
    try {
      descriptor = fs.openSync(accessPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      assertMaterializeDirectoryCurrent(projectRoot, directory);
      try {
        fs.lstatSync(accessPath);
      } catch (absenceError) {
        if (!isNodeError(absenceError) || absenceError.code !== "ENOENT") throw absenceError;
        assertMaterializeDirectoryCurrent(projectRoot, directory);
        absent = true;
      }
    }
    if (descriptor !== undefined) {
      const initial = assertAnchoredMaterializeFile(descriptor, accessPath, "materialize commit witness");
      if ((initial.mode & 0o7777n) !== BigInt(MATERIALIZE_FILE_MODE)) {
        throw new Error("materialize commit witness mode is not 0600");
      }
      const captured = captureStableMaterializeDescriptor(
        descriptor,
        MAX_MATERIALIZE_COMMIT_WITNESS_BYTES,
        "materialize commit witness"
      );
      const parsed = parseMaterializeCommitWitness(
        parseStrictJsonBytes(captured.bytes, {
          maxBytes: MAX_MATERIALIZE_COMMIT_WITNESS_BYTES,
          maxDepth: 8,
          maxItems: 16,
          maxProperties: 32
        })
      );
      if (
        initial.dev.toString() !== parsed.commit_witness_device ||
        initial.ino.toString() !== parsed.commit_witness_inode
      ) {
        throw new Error("materialize commit witness content does not bind its held inode identity");
      }
      const canonical = Buffer.from(`${JSON.stringify(parsed)}\n`, "utf8");
      if (!captured.bytes.equals(canonical)) {
        throw new Error("materialize commit witness is not canonical JSON with one trailing newline");
      }
      assertAnchoredMaterializeFile(descriptor, accessPath, "materialize commit witness", initial);
      assertMaterializeDirectoryCurrent(projectRoot, directory);
      assertAnchoredMaterializeFileGeneration(
        descriptor,
        accessPath,
        "materialize commit witness",
        captured.generation
      );
      assertMaterializeDirectoryCurrent(projectRoot, directory);
      result = parsed;
    }
  } catch (error) {
    failure = error;
  }
  if (descriptor !== undefined) {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      failure = aggregateMaterializeFailure(failure, error, "failed to close materialize commit witness");
    }
  }
  try {
    closeMaterializeDirectory(directory);
  } catch (error) {
    failure = aggregateMaterializeFailure(failure, error, "failed to close materialize commit witness directory");
  }
  if (failure !== undefined) throw failure;
  if (absent) return undefined;
  if (result === undefined) throw new Error("materialize commit witness produced no anchored snapshot");
  return result;
}

function readAnchoredMaterializeJournal<RecordType>(
  projectRoot: string,
  journalPath: string,
  codec: StrictJsonlCodec<RecordType>
): StrictJsonlSnapshot<RecordType> {
  const directory = openMaterializeDestinationDirectory(projectRoot, path.dirname(journalPath));
  const accessPath = path.join(directory.accessPath, path.basename(journalPath));
  let descriptor: number | undefined;
  let result: StrictJsonlSnapshot<RecordType> | undefined;
  let failure: unknown;
  try {
    try {
      descriptor = fs.openSync(accessPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      assertMaterializeDirectoryCurrent(projectRoot, directory);
      try {
        fs.lstatSync(accessPath);
      } catch (absenceError) {
        if (!isNodeError(absenceError) || absenceError.code !== "ENOENT") throw absenceError;
        assertMaterializeDirectoryCurrent(projectRoot, directory);
        result = { records: [], byteLength: 0, exists: false };
      }
    }
    if (descriptor !== undefined) {
      const initial = assertAnchoredMaterializeFile(descriptor, accessPath, codec.label);
      const bytes = readStableMaterializeDescriptor(
        descriptor,
        codec.maxBytes ?? DEFAULT_STRICT_JSONL_MAX_BYTES,
        codec.label
      );
      result = parseStrictJsonlBytes(bytes, codec);
      assertAnchoredMaterializeFile(descriptor, accessPath, codec.label, initial);
      assertMaterializeDirectoryCurrent(projectRoot, directory);
    }
  } catch (error) {
    failure = error;
  }
  if (descriptor !== undefined) {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      failure = aggregateMaterializeFailure(failure, error, `failed to close ${codec.label}`);
    }
  }
  try {
    closeMaterializeDirectory(directory);
  } catch (error) {
    failure = aggregateMaterializeFailure(failure, error, `failed to close ${codec.label} directory`);
  }
  if (failure !== undefined) throw failure;
  if (result === undefined) throw new Error(`${codec.label} produced no held-descriptor snapshot`);
  return result;
}

function openHeldMaterializeJournal<RecordType>(
  projectRoot: string,
  journalPath: string,
  codec: StrictJsonlCodec<RecordType>,
  expectedIdentity?: fs.BigIntStats
): HeldMaterializeJournal<RecordType> {
  const directory = openMaterializeDestinationDirectory(projectRoot, path.dirname(journalPath));
  const accessPath = path.join(directory.accessPath, path.basename(journalPath));
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(accessPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const identity = assertAnchoredMaterializeFile(descriptor, accessPath, codec.label, expectedIdentity);
    return { descriptor, directory, accessPath, identity, codec };
  } catch (error) {
    let failure: unknown = error;
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (closeError) {
        failure = aggregateMaterializeFailure(failure, closeError, `failed to close held ${codec.label}`);
      }
    }
    try {
      closeMaterializeDirectory(directory);
    } catch (closeError) {
      failure = aggregateMaterializeFailure(failure, closeError, `failed to close held ${codec.label} directory`);
    }
    throw failure;
  }
}

function readHeldMaterializeJournal<RecordType>(
  held: HeldMaterializeJournal<RecordType>
): StrictJsonlSnapshot<RecordType> {
  const captured = captureStableMaterializeDescriptor(
    held.descriptor,
    held.codec.maxBytes ?? DEFAULT_STRICT_JSONL_MAX_BYTES,
    held.codec.label
  );
  const snapshot = parseStrictJsonlBytes(captured.bytes, held.codec);
  assertAnchoredMaterializeFile(held.descriptor, held.accessPath, held.codec.label, held.identity);
  assertMaterializeDirectoryCurrent(held.directory.projectRoot, held.directory);
  assertAnchoredMaterializeFileGeneration(held.descriptor, held.accessPath, held.codec.label, captured.generation);
  assertMaterializeDirectoryCurrent(held.directory.projectRoot, held.directory);
  held.verifiedGeneration = captured.generation;
  return snapshot;
}

function assertHeldMaterializeIntentCurrent(
  held: HeldMaterializeJournal<MaterializeIntentRecord>,
  expected: MaterializeIntentRecord
): void {
  const snapshot = readHeldMaterializeJournal(held);
  const current = snapshot.records.find((record) => record.intent_id === expected.intent_id);
  if (current === undefined || !isDeepStrictEqual(current, expected)) {
    throw new Error(`materialize intent ${expected.intent_id} is not exact and current at completion`);
  }
}

function assertHeldMaterializeAuditCurrent(
  held: HeldMaterializeJournal<MaterializeAuditRecord>,
  expected: MaterializeAuditRecord
): void {
  const snapshot = readHeldMaterializeJournal(held);
  const current = snapshot.records.find((record) => record.audit_id === expected.audit_id);
  if (current === undefined || !isDeepStrictEqual(current, expected)) {
    throw new Error(`materialize completion ${expected.audit_id} is not exact and current at commit`);
  }
}

function assertHeldMaterializeJournalGeneration<RecordType>(held: HeldMaterializeJournal<RecordType>): void {
  if (held.verifiedGeneration === undefined) {
    throw new Error(`${held.codec.label} has no exact-byte generation proof`);
  }
  assertAnchoredMaterializeFileGeneration(held.descriptor, held.accessPath, held.codec.label, held.verifiedGeneration);
  assertMaterializeDirectoryCurrent(held.directory.projectRoot, held.directory);
}

function closeHeldMaterializeJournal<RecordType>(held: HeldMaterializeJournal<RecordType> | undefined): string[] {
  if (held === undefined) return [];
  const errors: string[] = [];
  if (held.descriptor >= 0) {
    const descriptor = held.descriptor;
    held.descriptor = -1;
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      errors.push(`${held.codec.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    closeMaterializeDirectory(held.directory);
  } catch (error) {
    errors.push(`${held.codec.label} directory: ${error instanceof Error ? error.message : String(error)}`);
  }
  return errors;
}

function closeHeldMaterializeJournalAfterFailure<RecordType>(
  held: HeldMaterializeJournal<RecordType> | undefined,
  failure: unknown
): unknown {
  const closeErrors = closeHeldMaterializeJournal(held);
  if (closeErrors.length === 0) return failure;
  return new AggregateError(
    [failure, ...closeErrors.map((message) => new Error(message))],
    "materialize failed and its held intent did not close cleanly"
  );
}

function assertAnchoredMaterializeFile(
  descriptor: number,
  accessPath: string,
  label: string,
  expected?: fs.BigIntStats
): fs.BigIntStats {
  const opened = fs.fstatSync(descriptor, { bigint: true });
  const named = fs.lstatSync(accessPath, { bigint: true });
  if (
    !opened.isFile() ||
    !named.isFile() ||
    opened.nlink !== 1n ||
    named.nlink !== 1n ||
    opened.dev !== named.dev ||
    opened.ino !== named.ino ||
    (expected !== undefined && (opened.dev !== expected.dev || opened.ino !== expected.ino))
  ) {
    throw new Error(`${label} path is not the exact singly linked held inode`);
  }
  return opened;
}

function assertAnchoredMaterializeFileGeneration(
  descriptor: number,
  accessPath: string,
  label: string,
  expected: fs.BigIntStats
): fs.BigIntStats {
  const opened = fs.fstatSync(descriptor, { bigint: true });
  const named = fs.lstatSync(accessPath, { bigint: true });
  if (
    !opened.isFile() ||
    !named.isFile() ||
    opened.dev !== named.dev ||
    opened.ino !== named.ino ||
    !sameMaterializeFileGeneration(opened, expected) ||
    !sameMaterializeFileGeneration(named, expected)
  ) {
    throw new Error(`${label} content generation changed after its exact-byte proof`);
  }
  return opened;
}

function sameMaterializeFileGeneration(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertMaterializeOperationIdUnused(journals: MaterializeJournalState, operationId: string): void {
  if (journals.intents.records.some((record) => record.intent_id === operationId)) {
    throw new Error(`materialize intent identity ${operationId} is already present`);
  }
  if (journals.audits.records.some((record) => record.audit_id === operationId)) {
    throw new Error(`materialize completion identity ${operationId} is already present`);
  }
}

function assertUnmatchedMaterializeCapacity(
  projectRoot: string,
  journals: MaterializeJournalState,
  proposed: ReadonlyArray<{ size_bytes: number }>,
  phase: "precheck" | "postcheck"
): ReadonlySet<string> {
  const audits = new Map(journals.audits.records.map((record) => [record.audit_id, record]));
  const committedWitnessIds = new Set<string>();
  let bytes = 0n;
  let entries = 0n;
  for (const intent of journals.intents.records) {
    const completion = audits.get(intent.intent_id);
    if (completion !== undefined && materializeCompletionMatchesIntent(intent, completion)) {
      let witness: MaterializeCommitWitness | undefined;
      try {
        witness = readAnchoredMaterializeCommitWitness(projectRoot, completion.audit_id);
      } catch {
        // Empty, partial, replaced, or otherwise invalid recovery witnesses are
        // deliberately counted as unmatched. The later exclusive reservation
        // still verifies the witness directory before any destination mutation.
        witness = undefined;
      }
      if (witness !== undefined && materializeCommitWitnessMatches(witness, intent, completion)) {
        committedWitnessIds.add(completion.audit_id);
        continue;
      }
    }
    for (const copy of intent.copies) {
      bytes += BigInt(copy.size_bytes);
      entries += 1n;
    }
  }
  for (const copy of proposed) {
    bytes += BigInt(copy.size_bytes);
    entries += 1n;
  }
  if (bytes > BigInt(MAX_UNMATCHED_MATERIALIZE_BYTES) || entries > BigInt(MAX_UNMATCHED_MATERIALIZE_COPY_ENTRIES)) {
    throw new Error(
      `unmatched materialize intent ${phase} exceeds ${MAX_UNMATCHED_MATERIALIZE_BYTES} bytes or ${MAX_UNMATCHED_MATERIALIZE_COPY_ENTRIES} copy entries (bytes=${bytes}, entries=${entries})`
    );
  }
  return committedWitnessIds;
}

function materializeCompletionMatchesIntent(
  intent: MaterializeIntentRecord,
  completion: MaterializeAuditRecord
): boolean {
  return (
    completion.audit_id === intent.intent_id &&
    completion.run_id === intent.run_id &&
    completion.timestamp === intent.timestamp &&
    completion.operation === intent.operation &&
    completion.mode === intent.mode &&
    completion.unstaged === intent.unstaged &&
    completion.confirmed === intent.confirmed &&
    completion.allow_overwrite === intent.allow_overwrite &&
    completion.commit_nonce_sha256 === intent.commit_nonce_sha256 &&
    completion.commit_witness_device === intent.commit_witness_device &&
    completion.commit_witness_inode === intent.commit_witness_inode &&
    isDeepStrictEqual(completion.copies, intent.copies) &&
    isDeepStrictEqual(completion.patches, intent.patches)
  );
}

function publishMaterializationSet(
  copies: PlannedMaterialization[],
  projectRoot: string,
  publication: MaterializePublicationState
): void {
  for (const copy of copies) {
    let directory: OpenedMaterializeDirectory;
    try {
      directory = openMaterializeDestinationDirectory(projectRoot, path.dirname(copy.destinationPath));
      publication.directories.push(directory);
    } catch (error) {
      publication.uncertainReasons.push(
        `destination parent ${copy.selection.destination}: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
    const destinationAccessPath = path.join(directory.accessPath, path.basename(copy.destinationPath));
    let descriptor: number;
    try {
      descriptor = fs.openSync(
        destinationAccessPath,
        fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        MATERIALIZE_FILE_MODE
      );
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        publication.uncertainReasons.push(
          `exclusive destination open ${copy.selection.destination}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      throw error;
    }

    const owned: OwnedMaterializeFile = {
      descriptor,
      directory,
      destinationAccessPath,
      destination: copy.selection.destination,
      expectedSizeBytes: copy.sizeBytes,
      expectedSha256: copy.sha256
    };
    // Ownership is recorded immediately after O_EXCL succeeds. Every later
    // error therefore preserves this descriptor for anchored evidence.
    publication.owned.push(owned);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    owned.device = opened.dev;
    owned.inode = opened.ino;
    assertNewOwnedMaterializeFile(owned, opened);
    writeMaterializationDescriptor(descriptor, copy.bytes);
    fs.fsyncSync(descriptor);
    fs.fsyncSync(directory.descriptor);
    verifyOwnedMaterializeFile(owned);
  }
}

function assertNewOwnedMaterializeFile(owned: OwnedMaterializeFile, opened: fs.BigIntStats): void {
  const named = fs.lstatSync(owned.destinationAccessPath, { bigint: true });
  if (
    !opened.isFile() ||
    !named.isFile() ||
    opened.nlink !== 1n ||
    named.nlink !== 1n ||
    opened.size !== 0n ||
    named.size !== 0n ||
    (opened.mode & 0o7777n) !== BigInt(MATERIALIZE_FILE_MODE) ||
    (named.mode & 0o7777n) !== BigInt(MATERIALIZE_FILE_MODE) ||
    opened.dev !== named.dev ||
    opened.ino !== named.ino ||
    opened.dev !== owned.device ||
    opened.ino !== owned.inode
  ) {
    throw new Error(`destination ${owned.destination} is not the exact new mode-0600 singly linked inode`);
  }
  assertMaterializeDirectoryCurrent(owned.directory.projectRoot, owned.directory);
}

function verifyOwnedMaterializationSet(publication: MaterializePublicationState): void {
  for (const owned of publication.owned) verifyOwnedMaterializeFile(owned);
}

function verifyOwnedMaterializationGenerationSet(publication: MaterializePublicationState): void {
  for (const owned of publication.owned) {
    if (owned.verifiedGeneration === undefined) {
      throw new Error(`destination ${owned.destination} has no exact-byte generation proof`);
    }
    assertMaterializeDirectoryCurrent(owned.directory.projectRoot, owned.directory);
    assertAnchoredMaterializeFileGeneration(
      owned.descriptor,
      owned.destinationAccessPath,
      `materialize destination ${owned.destination}`,
      owned.verifiedGeneration
    );
    assertMaterializeDirectoryCurrent(owned.directory.projectRoot, owned.directory);
  }
}

function verifyOwnedMaterializeFile(owned: OwnedMaterializeFile): void {
  fs.fsyncSync(owned.descriptor);
  fs.fsyncSync(owned.directory.descriptor);
  assertMaterializeDirectoryCurrent(owned.directory.projectRoot, owned.directory);
  const before = fs.fstatSync(owned.descriptor, { bigint: true });
  const namedBefore = fs.lstatSync(owned.destinationAccessPath, { bigint: true });
  assertOwnedMaterializeIdentity(owned, before, namedBefore);
  const captured = captureStableMaterializeDescriptor(
    owned.descriptor,
    MAX_MATERIALIZE_SOURCE_BYTES,
    `materialize destination ${owned.destination}`
  );
  if (
    !sameMaterializeFileGeneration(before, captured.generation) ||
    !sameMaterializeFileGeneration(namedBefore, captured.generation)
  ) {
    throw new Error(`destination ${owned.destination} changed before its exact-byte proof completed`);
  }
  if (sha256Bytes(captured.bytes) !== owned.expectedSha256) {
    throw new Error(`destination ${owned.destination} bytes do not match the reviewed SHA-256`);
  }
  assertMaterializeDirectoryCurrent(owned.directory.projectRoot, owned.directory);
  const after = assertAnchoredMaterializeFileGeneration(
    owned.descriptor,
    owned.destinationAccessPath,
    `materialize destination ${owned.destination}`,
    captured.generation
  );
  assertOwnedMaterializeIdentity(owned, after, after);
  assertMaterializeDirectoryCurrent(owned.directory.projectRoot, owned.directory);
  owned.verifiedGeneration = after;
}

function assertOwnedMaterializeIdentity(
  owned: OwnedMaterializeFile,
  opened: fs.BigIntStats,
  named: fs.BigIntStats
): void {
  if (
    owned.device === undefined ||
    owned.inode === undefined ||
    !opened.isFile() ||
    !named.isFile() ||
    opened.dev !== owned.device ||
    opened.ino !== owned.inode ||
    named.dev !== owned.device ||
    named.ino !== owned.inode ||
    opened.nlink !== 1n ||
    named.nlink !== 1n ||
    opened.size !== BigInt(owned.expectedSizeBytes) ||
    named.size !== BigInt(owned.expectedSizeBytes) ||
    (opened.mode & 0o7777n) !== BigInt(MATERIALIZE_FILE_MODE) ||
    (named.mode & 0o7777n) !== BigInt(MATERIALIZE_FILE_MODE)
  ) {
    throw new Error(`destination ${owned.destination} no longer identifies the exact reviewed owned inode`);
  }
}

function writeMaterializationDescriptor(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (written <= 0) throw new Error("materialization destination stopped accepting bytes");
    offset += written;
  }
}

function materializePublicationFailure(
  code: string,
  message: string,
  error: unknown,
  publication: MaterializePublicationState,
  operationId: string
): RuntimeResult<MaterializeValue> {
  const evidence = materializeAnchoredRecoveryEvidence(publication);
  const recoveryRequired =
    publication.owned.length > 0 || publication.uncertainReasons.length > 0 || evidence.errors.length > 0;
  const closeErrors = closeMaterializePublication(publication);
  return runtimeFailure([
    runtimeError(code, message, "materialize", "copies", {
      intent_id: operationId,
      error: error instanceof Error ? error.message : String(error),
      recovery_required: recoveryRequired,
      manual_recovery_required: true,
      recovery_entries: evidence.entries,
      ...(publication.uncertainReasons.length === 0 ? {} : { uncertain_state: publication.uncertainReasons }),
      ...(evidence.errors.length === 0 ? {} : { evidence_errors: evidence.errors }),
      ...(closeErrors.length === 0 ? {} : { preservation_errors: closeErrors })
    })
  ]);
}

function materializeAnchoredRecoveryEvidence(publication: MaterializePublicationState): MaterializeEvidenceCapture {
  const entries: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  for (const owned of publication.owned) {
    const entry: Record<string, unknown> = {
      destination: owned.destination,
      expected_size_bytes: owned.expectedSizeBytes,
      expected_sha256: owned.expectedSha256
    };
    try {
      const directory = fs.fstatSync(owned.directory.descriptor, { bigint: true });
      const accessed = fs.statSync(owned.directory.accessPath, { bigint: true });
      entry.parent = {
        device: directory.dev.toString(),
        inode: directory.ino.toString(),
        anchored_identity_current:
          directory.isDirectory() &&
          accessed.isDirectory() &&
          directory.dev === accessed.dev &&
          directory.ino === accessed.ino
      };
    } catch (error) {
      errors.push(`${owned.destination} parent evidence: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const opened = fs.fstatSync(owned.descriptor, { bigint: true });
      const inodeEvidence: Record<string, unknown> = {
        device: opened.dev.toString(),
        inode: opened.ino.toString(),
        mode: Number(opened.mode & 0o7777n),
        link_count: opened.nlink.toString(),
        size_bytes: Number(opened.size)
      };
      if (opened.isFile() && opened.size <= BigInt(owned.expectedSizeBytes)) {
        try {
          inodeEvidence.sha256 = sha256Bytes(
            readStableMaterializeDescriptor(
              owned.descriptor,
              owned.expectedSizeBytes,
              `materialize recovery evidence ${owned.destination}`,
              opened.nlink
            )
          );
        } catch (error) {
          inodeEvidence.digest_error = error instanceof Error ? error.message : String(error);
        }
      } else if (opened.isFile()) {
        inodeEvidence.digest_skipped = "current size exceeds the bounded reviewed size";
      }
      entry.owned_inode = inodeEvidence;
      try {
        const named = fs.lstatSync(owned.destinationAccessPath, { bigint: true });
        entry.anchored_path = {
          state: named.dev === opened.dev && named.ino === opened.ino ? "owned" : "different",
          device: named.dev.toString(),
          inode: named.ino.toString(),
          mode: Number(named.mode & 0o7777n),
          link_count: named.nlink.toString(),
          size_bytes: Number(named.size)
        };
      } catch (error) {
        entry.anchored_path = {
          state: isNodeError(error) && error.code === "ENOENT" ? "absent" : "unreadable",
          error: error instanceof Error ? error.message : String(error)
        };
      }
    } catch (error) {
      errors.push(`${owned.destination} inode evidence: ${error instanceof Error ? error.message : String(error)}`);
    }
    entries.push(entry);
  }
  return { entries, errors };
}

function closeMaterializePublication(publication: MaterializePublicationState): string[] {
  const errors: string[] = [];
  for (const owned of publication.owned) {
    if (owned.descriptor < 0) continue;
    const descriptor = owned.descriptor;
    owned.descriptor = -1;
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      errors.push(`${owned.destination}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const directory of publication.directories) {
    try {
      closeMaterializeDirectory(directory);
    } catch (error) {
      errors.push(`${directory.lexicalPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}

function readStableMaterializeDescriptor(
  descriptor: number,
  maxBytes: number,
  label: string,
  expectedLinks = 1n
): Buffer {
  return captureStableMaterializeDescriptor(descriptor, maxBytes, label, expectedLinks).bytes;
}

function captureStableMaterializeDescriptor(
  descriptor: number,
  maxBytes: number,
  label: string,
  expectedLinks = 1n
): StableMaterializeDescriptorSnapshot {
  const before = fs.fstatSync(descriptor, { bigint: true });
  if (!before.isFile() || before.nlink !== expectedLinks || before.size > BigInt(maxBytes)) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte safe-file limit or has an unexpected link count`);
  }
  const chunks: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - offset));
    const read = fs.readSync(descriptor, chunk, 0, chunk.length, offset);
    if (read === 0) break;
    offset += read;
    if (offset > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
    chunks.push(chunk.subarray(0, read));
  }
  const after = fs.fstatSync(descriptor, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.nlink !== after.nlink ||
    before.mode !== after.mode ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    after.size !== BigInt(offset)
  ) {
    throw new Error(`${label} changed while it was captured`);
  }
  return { bytes: Buffer.concat(chunks, offset), generation: after };
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
        fs.fsyncSync(current.descriptor);
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
  const descriptor = fs.openSync(openPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const identity = fs.fstatSync(descriptor, { bigint: true });
    if (!identity.isDirectory()) throw new Error(`${label} is not a physical directory`);
    const accessPath = materializeDirectoryDescriptorPath(descriptor, identity);
    const opened = { descriptor, projectRoot, lexicalPath, accessPath, identity };
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

function planCopy(
  layout: RunLayout,
  projectRoot: string,
  copy: MaterializeCopySelection,
  remainingSnapshotBytes: number,
  diagnostics: RuntimeDiagnostic[]
): PlannedMaterialization | undefined {
  const sourcePath = resolveSource(copy.source, layout, diagnostics);
  const destinationPath = resolveDestination(copy.destination, projectRoot, diagnostics);
  if (sourcePath === undefined || destinationPath === undefined) return undefined;
  try {
    const sourceSize = fs.lstatSync(sourcePath).size;
    if (sourceSize > remainingSnapshotBytes) {
      diagnostics.push(
        runtimeError(
          "MATERIALIZE_SNAPSHOT_BUDGET_EXCEEDED",
          `materialize copy snapshots exceed the ${MAX_MATERIALIZE_SNAPSHOT_BYTES}-byte aggregate limit`,
          "materialize",
          copy.source,
          {
            attempted_bytes: MAX_MATERIALIZE_SNAPSHOT_BYTES - remainingSnapshotBytes + sourceSize,
            limit_bytes: MAX_MATERIALIZE_SNAPSHOT_BYTES
          }
        )
      );
      return undefined;
    }
    const bytes = readRegularFileSnapshot(sourcePath, Math.min(MAX_MATERIALIZE_SOURCE_BYTES, remainingSnapshotBytes));
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
    const code = stat.isSymbolicLink()
      ? "MATERIALIZE_DESTINATION_SYMLINK"
      : stat.isFile()
        ? "MATERIALIZE_DESTINATION_EXISTS"
        : "MATERIALIZE_DESTINATION_NOT_FILE";
    diagnostics.push(
      runtimeError(code, `destination ${selection} must not already exist`, "materialize", selection, {
        create_only: true
      })
    );
    return undefined;
  }
  return destinationPath;
}

function aggregateMaterializeFailure(primary: unknown, secondary: unknown, message: string): unknown {
  if (primary === undefined) return secondary;
  return new AggregateError([primary, secondary], message, { cause: secondary });
}

function materializeWarning(
  code: string,
  message: string,
  pathValue: string,
  details?: Record<string, unknown>
): RuntimeDiagnostic {
  return {
    code,
    message,
    severity: "warning",
    source: "materialize",
    path: pathValue,
    ...(details === undefined ? {} : { details })
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function runsRootForProject(projectRoot: string): Promise<string> {
  const loaded = await loadProjectConfig(projectRoot);
  if (loaded.ok) {
    const resolved = resolveConfig({ projectConfig: loaded.value.config, env: process.env });
    if (resolved.ok) return path.resolve(projectRoot, resolved.value.run.outputDir);
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
