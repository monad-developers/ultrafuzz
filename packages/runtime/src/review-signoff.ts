import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  assertNoSymlinkComponents,
  assertRunPlanDocument,
  parseStrictJsonBytes,
  readRunPlanDocument,
  readRunState,
  sha256Bytes,
  type RunLayout,
  type RunPlanDocument
} from "@ultrafuzz/artifacts";

import { loadVerifiedFinalReportSnapshot } from "./verified-output.js";
import { sha256Stable, stableJson } from "./utils.js";
import { verifyWorkflowControlSnapshot } from "./workflow-integrity.js";
import {
  captureDataGovernanceTargetIdentity,
  dataGovernanceReviewSignoffAuthorities,
  parseDataGovernancePolicy,
  type DataGovernancePolicy,
  type DataGovernanceProvenance
} from "./data-governance.js";

export const MATERIALIZE_REVIEW_SIGNOFF_SCHEMA_VERSION = "ultrafuzz.materialize.review-signoff.v1" as const;
const MAX_SIGNOFF_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface MaterializeReviewArtifactBinding {
  source: string;
  destination: string;
  sha256: string;
}

export interface MaterializeReviewTrustedSigner {
  key_id: string;
  algorithm: "ed25519";
  public_key_sha256: string;
}

export interface MaterializeReviewSigningAuthority extends MaterializeReviewTrustedSigner {
  public_key_spki_base64: string;
}

export interface MaterializeReviewSignoffRequest {
  schema_version: typeof MATERIALIZE_REVIEW_SIGNOFF_SCHEMA_VERSION;
  decision: "accepted";
  run_id: string;
  target_commit: string;
  target_tree: string;
  target_clean: true;
  target_worktree_digest: string;
  graph_fingerprint: string;
  final_report_digest: string;
  selected_artifacts: MaterializeReviewArtifactBinding[];
  trusted_signers: MaterializeReviewTrustedSigner[];
}

export interface MaterializeReviewUnsignedSignoff extends MaterializeReviewSignoffRequest {
  reviewer: string;
  reviewed_at: string;
  signing_key_id: string;
}

export interface MaterializeReviewSignoff extends MaterializeReviewUnsignedSignoff {
  signature: string;
  signoff_sha256: string;
}

export function materializeReviewSignoffRequest(input: {
  projectRoot: string;
  layout: RunLayout;
  selections: MaterializeReviewArtifactBinding[];
  authorities: MaterializeReviewSigningAuthority[];
}): MaterializeReviewSignoffRequest {
  const target = cleanTargetIdentity(input.projectRoot);
  return materializeReviewSignoffRequestForTarget(input, {
    target_commit: target.commit,
    target_tree: target.tree,
    target_clean: true,
    target_worktree_digest: target.worktreeDigest
  });
}

/** Rebuild current report/selection bindings while retaining the signed pre-write target. */
export function recordedMaterializeReviewSignoffRequest(input: {
  projectRoot: string;
  layout: RunLayout;
  selections: MaterializeReviewArtifactBinding[];
  authorities: MaterializeReviewSigningAuthority[];
  signoff: MaterializeReviewSignoff;
}): MaterializeReviewSignoffRequest {
  const head = targetHeadIdentity(input.projectRoot);
  if (head.commit !== input.signoff.target_commit || head.tree !== input.signoff.target_tree) {
    throw new Error("materialization review signoff target commit/tree is no longer current");
  }
  return materializeReviewSignoffRequestForTarget(input, {
    target_commit: input.signoff.target_commit,
    target_tree: input.signoff.target_tree,
    target_clean: true,
    target_worktree_digest: input.signoff.target_worktree_digest
  });
}

export function assertMaterializeReviewTargetRemainedCurrent(
  projectRoot: string,
  expected: MaterializeReviewSignoffRequest
): void {
  const target = cleanTargetIdentity(projectRoot);
  if (
    target.commit !== expected.target_commit ||
    target.tree !== expected.target_tree ||
    target.worktreeDigest !== expected.target_worktree_digest
  ) {
    throw new Error("materialization review target changed after signoff verification and before mutation");
  }
}

function materializeReviewSignoffRequestForTarget(
  input: {
    projectRoot: string;
    layout: RunLayout;
    selections: MaterializeReviewArtifactBinding[];
    authorities: MaterializeReviewSigningAuthority[];
  },
  target: Pick<
    MaterializeReviewSignoffRequest,
    "target_commit" | "target_tree" | "target_clean" | "target_worktree_digest"
  >
): MaterializeReviewSignoffRequest {
  const provenance = loadAuthenticatedDataGovernanceProvenance(input.projectRoot, input.layout);
  if (
    provenance.target.commit !== target.target_commit ||
    provenance.target.tree !== target.target_tree ||
    provenance.target.dirty ||
    provenance.target.worktree_digest !== target.target_worktree_digest
  ) {
    throw new Error(
      "materialization review target does not exactly match the clean target sealed before model execution"
    );
  }
  const state = readRunState(input.layout);
  const report = loadVerifiedFinalReportSnapshot(input.layout.root);
  return {
    schema_version: MATERIALIZE_REVIEW_SIGNOFF_SCHEMA_VERSION,
    decision: "accepted",
    run_id: input.layout.runId,
    ...target,
    graph_fingerprint: state.graph_fingerprint,
    final_report_digest: sha256Stable({
      json_sha256: sha256Bytes(report.json_bytes),
      markdown_sha256: sha256Bytes(report.markdown_bytes)
    }),
    selected_artifacts: canonicalArtifactBindings(input.selections),
    trusted_signers: canonicalTrustedSigners(input.authorities)
  };
}

/**
 * Return the exact canonical bytes an off-host reviewer signs with Ed25519.
 * The detached signature is then added as the `signature` field.
 */
export function materializeReviewSignoffSigningPayload(signoff: MaterializeReviewUnsignedSignoff): Buffer {
  return Buffer.from(stableJson(signoff), "utf8");
}

/**
 * Re-root reviewer trust in the operator-owned policy supplied to this command.
 *
 * The run-local snapshot is useful immutable provenance only relative to its
 * hash journal; a same-UID YOLO agent can replace that journal and its files.
 * Consequently it is never sufficient as a reviewer trust root. The caller
 * must supply the policy again after model execution. Its exact policy digest
 * and reviewer-key fingerprints must match the pre-execution snapshot, and the
 * externally supplied keys are the only keys returned for signature checks.
 */
export function loadOperatorAuthenticatedMaterializeReviewAuthorities(input: {
  projectRoot: string;
  layout: RunLayout;
  operatorPolicyJson: string | undefined;
}): MaterializeReviewSigningAuthority[] {
  const authenticated = loadOperatorAuthenticatedDataGovernanceContext(input);
  const operatorAuthorities = validateSigningAuthorities(dataGovernanceReviewSignoffAuthorities(authenticated.policy));
  if (operatorAuthorities.length === 0) {
    throw new Error("the operator data-governance policy contains no trusted materialization reviewer signing key");
  }
  const sealedAuthorities = validateSigningAuthorities(authenticated.plan.data_governance.review_signoff_authorities);
  if (
    sha256Stable(canonicalTrustedSigners(operatorAuthorities)) !==
    sha256Stable(canonicalTrustedSigners(sealedAuthorities))
  ) {
    throw new Error("operator reviewer-key fingerprints do not exactly match the pre-execution run plan");
  }
  return operatorAuthorities;
}

/** Authenticate the full operator policy again before classifying any materialization destination. */
export function loadOperatorAuthenticatedDataGovernancePolicy(input: {
  projectRoot: string;
  layout: RunLayout;
  operatorPolicyJson: string | undefined;
}): DataGovernancePolicy {
  return loadOperatorAuthenticatedDataGovernanceContext(input).policy;
}

function loadOperatorAuthenticatedDataGovernanceContext(input: {
  projectRoot: string;
  layout: RunLayout;
  operatorPolicyJson: string | undefined;
}): { policy: DataGovernancePolicy; plan: RunPlanDocument } {
  if (input.operatorPolicyJson === undefined || input.operatorPolicyJson.trim().length === 0) {
    throw new Error("materialization requires the operator data-governance policy to be supplied again");
  }
  const operatorPolicy = parseDataGovernancePolicy(input.operatorPolicyJson);
  const plan = loadAuthenticatedMaterializationRunPlan(input.projectRoot, input.layout, true);
  const provenance = loadAuthenticatedDataGovernanceProvenance(input.projectRoot, input.layout, plan);
  const operatorPolicyDigest = sha256Stable(operatorPolicy);
  if (
    plan.data_governance.policy_digest !== operatorPolicyDigest ||
    provenance.policy_digest !== operatorPolicyDigest ||
    sha256Stable(provenance.policy) !== operatorPolicyDigest
  ) {
    throw new Error("operator data-governance policy does not match the policy sealed before model execution");
  }
  if (JSON.stringify(operatorPolicy.production_source_roots) !== JSON.stringify(plan.production_source_roots)) {
    throw new Error("operator production source roots do not match the roots sealed before model execution");
  }
  return { policy: operatorPolicy, plan };
}

/** Read and authenticate the retained full governance provenance against the sealed plan reference. */
export function loadAuthenticatedDataGovernanceProvenance(
  projectRoot: string,
  layout: RunLayout,
  planInput?: RunPlanDocument
): DataGovernanceProvenance {
  const verified = verifyWorkflowControlSnapshot(projectRoot, layout);
  const plan =
    planInput ??
    (() => {
      const planSnapshot = verified.executionFiles.find((entry) => entry.snapshotPath === "controls/plan.json");
      if (planSnapshot === undefined) throw new Error("sealed workflow authority does not contain the run plan");
      return assertRunPlanDocument(parseStrictJsonBytes(planSnapshot.contents), layout.runId);
    })();
  const governanceSnapshot = verified.executionFiles.find(
    (entry) => entry.snapshotPath === "controls/data-governance.json"
  );
  if (governanceSnapshot === undefined) {
    throw new Error("sealed workflow authority does not contain campaign data-governance provenance");
  }
  if (sha256Bytes(governanceSnapshot.contents) !== plan.data_governance.sha256) {
    throw new Error("campaign data-governance provenance does not match the sealed run-plan reference");
  }
  const value = parseStrictJsonBytes(governanceSnapshot.contents);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("campaign data-governance provenance must be an object");
  }
  const record = value as Record<string, unknown>;
  const policy = parseDataGovernancePolicy(JSON.stringify(record.policy));
  if (
    record.schema_version !== plan.data_governance.schema_version ||
    record.policy_digest !== plan.data_governance.policy_digest ||
    record.input_digest !== plan.data_governance.input_digest ||
    record.acknowledgement_status !== plan.data_governance.acknowledgement_status ||
    policy.sensitivity !== plan.data_governance.sensitivity
  ) {
    throw new Error("campaign data-governance provenance fields do not match the sealed run-plan reference");
  }
  if (sha256Stable(policy) !== record.policy_digest) {
    throw new Error("campaign data-governance policy digest does not match its canonical policy");
  }
  return { ...record, policy } as unknown as DataGovernanceProvenance;
}

export function loadAuthenticatedMaterializationRunPlan(
  projectRoot: string,
  layout: RunLayout,
  requireSeal = false
): RunPlanDocument {
  const sealPath = path.join(layout.root, "smithers", "control-integrity.json");
  if (fs.existsSync(sealPath)) {
    const sealed = verifyWorkflowControlSnapshot(projectRoot, layout);
    const planSnapshot = sealed.executionFiles.find((entry) => entry.snapshotPath === "controls/plan.json");
    if (planSnapshot === undefined) throw new Error("sealed workflow authority does not contain the run plan");
    return assertRunPlanDocument(parseStrictJsonBytes(planSnapshot.contents), layout.runId);
  }
  if (requireSeal) throw new Error("materialization reviewer authority requires a sealed workflow run plan");
  const state = readRunState(layout);
  const smithersRoot = path.join(layout.root, "smithers");
  if (state.status !== "pending" || fs.existsSync(smithersRoot)) {
    throw new Error("a run that entered execution is missing its sealed materialization policy");
  }
  return readRunPlanDocument(path.join(layout.root, "plan.json"), layout.runId);
}

export function loadAndVerifyMaterializeReviewSignoff(input: {
  signoffPath: string;
  projectRoot: string;
  layout: RunLayout;
  expected: MaterializeReviewSignoffRequest;
  authorities: MaterializeReviewSigningAuthority[];
}): MaterializeReviewSignoff {
  if (!path.isAbsolute(input.signoffPath)) throw new Error("materialization review signoff path must be absolute");
  const absolutePath = path.resolve(input.signoffPath);
  const projectRoot = path.resolve(input.projectRoot);
  if (isPathInside(projectRoot, absolutePath) || isPathInside(input.layout.root, absolutePath)) {
    throw new Error("materialization review signoff must be operator-owned outside the project and run directories");
  }
  assertNoSymlinkComponents(path.parse(absolutePath).root, absolutePath, "materialization review signoff");
  const stat = fs.lstatSync(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("materialization review signoff must be a regular file");
  if (stat.size > MAX_SIGNOFF_BYTES)
    throw new Error(`materialization review signoff exceeds ${MAX_SIGNOFF_BYTES} bytes`);
  const bytes = fs.readFileSync(absolutePath);
  return verifyMaterializeReviewSignoff(parseStrictJsonBytes(bytes), input.expected, input.authorities, false);
}

/** Reauthenticate a normalized signoff retained in the append-only materialization audit. */
export function verifyRecordedMaterializeReviewSignoff(input: {
  signoff: MaterializeReviewSignoff;
  expected: MaterializeReviewSignoffRequest;
  authorities: MaterializeReviewSigningAuthority[];
}): MaterializeReviewSignoff {
  return verifyMaterializeReviewSignoff(input.signoff, input.expected, input.authorities, true);
}

function verifyMaterializeReviewSignoff(
  value: unknown,
  expected: MaterializeReviewSignoffRequest,
  authoritiesInput: MaterializeReviewSigningAuthority[],
  recorded: boolean
): MaterializeReviewSignoff {
  const record = strictSignoffRecord(value, recorded);
  const unsigned: MaterializeReviewUnsignedSignoff = {
    schema_version: MATERIALIZE_REVIEW_SIGNOFF_SCHEMA_VERSION,
    decision: "accepted",
    run_id: boundedString(record.run_id, "run_id"),
    target_commit: digestLike(record.target_commit, "target_commit"),
    target_tree: digestLike(record.target_tree, "target_tree"),
    target_clean: literalTrue(record.target_clean, "target_clean"),
    target_worktree_digest: sha256(record.target_worktree_digest, "target_worktree_digest"),
    graph_fingerprint: sha256(record.graph_fingerprint, "graph_fingerprint"),
    final_report_digest: sha256(record.final_report_digest, "final_report_digest"),
    selected_artifacts: artifactBindings(record.selected_artifacts),
    trusted_signers: trustedSigners(record.trusted_signers),
    reviewer: boundedString(record.reviewer, "reviewer"),
    reviewed_at: timestamp(record.reviewed_at, "reviewed_at"),
    signing_key_id: safeId(record.signing_key_id, "signing_key_id")
  };
  const actualRequest: MaterializeReviewSignoffRequest = {
    schema_version: unsigned.schema_version,
    decision: unsigned.decision,
    run_id: unsigned.run_id,
    target_commit: unsigned.target_commit,
    target_tree: unsigned.target_tree,
    target_clean: unsigned.target_clean,
    target_worktree_digest: unsigned.target_worktree_digest,
    graph_fingerprint: unsigned.graph_fingerprint,
    final_report_digest: unsigned.final_report_digest,
    selected_artifacts: unsigned.selected_artifacts,
    trusted_signers: unsigned.trusted_signers
  };
  if (sha256Stable(actualRequest) !== sha256Stable(expected)) {
    throw new Error(
      "materialization review signoff is stale or does not bind the current target, graph, report, selections, and trusted signers"
    );
  }

  const authorities = validateSigningAuthorities(authoritiesInput);
  if (authorities.length === 0) {
    throw new Error("the sealed run plan contains no trusted materialization reviewer signing key");
  }
  const authority = authorities.find((entry) => entry.key_id === unsigned.signing_key_id);
  if (authority === undefined) throw new Error("materialization review signoff uses an untrusted signing key ID");
  const trusted = unsigned.trusted_signers.find((entry) => entry.key_id === authority.key_id);
  if (
    trusted === undefined ||
    trusted.algorithm !== authority.algorithm ||
    trusted.public_key_sha256 !== authority.public_key_sha256
  ) {
    throw new Error("materialization review signoff signing key does not match the sealed reviewer authority");
  }
  const signature = canonicalSignature(record.signature);
  const publicKey = publicKeyForAuthority(authority);
  if (
    !crypto.verify(null, materializeReviewSignoffSigningPayload(unsigned), publicKey, Buffer.from(signature, "base64"))
  ) {
    throw new Error("materialization review signoff has an invalid Ed25519 signature");
  }
  const canonicalSigned = { ...unsigned, signature };
  const signoffSha256 = sha256Bytes(Buffer.from(stableJson(canonicalSigned), "utf8"));
  if (recorded && sha256(record.signoff_sha256, "signoff_sha256") !== signoffSha256) {
    throw new Error("recorded materialization review signoff digest does not match its canonical signed content");
  }
  return { ...canonicalSigned, signoff_sha256: signoffSha256 };
}

function strictSignoffRecord(value: unknown, recorded: boolean): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("materialization review signoff must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const expected = [
    "schema_version",
    "decision",
    "run_id",
    "target_commit",
    "target_tree",
    "target_clean",
    "target_worktree_digest",
    "graph_fingerprint",
    "final_report_digest",
    "selected_artifacts",
    "trusted_signers",
    "reviewer",
    "reviewed_at",
    "signing_key_id",
    "signature",
    ...(recorded ? ["signoff_sha256"] : [])
  ].sort();
  const actual = Object.keys(record).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`materialization review signoff must contain exactly: ${expected.join(", ")}`);
  }
  if (record.schema_version !== MATERIALIZE_REVIEW_SIGNOFF_SCHEMA_VERSION) {
    throw new Error(
      `materialization review signoff schema_version must be ${MATERIALIZE_REVIEW_SIGNOFF_SCHEMA_VERSION}`
    );
  }
  if (record.decision !== "accepted") throw new Error("materialization review signoff decision must be accepted");
  return record;
}

function artifactBindings(value: unknown): MaterializeReviewArtifactBinding[] {
  if (!Array.isArray(value) || value.length > 4096) {
    throw new Error("materialization review signoff selected_artifacts must be a bounded array");
  }
  return canonicalArtifactBindings(
    value.map((candidate, index) => {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error(`materialization review signoff selected_artifacts[${index}] must be an object`);
      }
      const record = candidate as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      if (keys.length !== 3 || keys[0] !== "destination" || keys[1] !== "sha256" || keys[2] !== "source") {
        throw new Error(`materialization review signoff selected_artifacts[${index}] has unknown or missing fields`);
      }
      return {
        source: boundedString(record.source, `selected_artifacts[${index}].source`),
        destination: boundedString(record.destination, `selected_artifacts[${index}].destination`),
        sha256: sha256(record.sha256, `selected_artifacts[${index}].sha256`)
      };
    })
  );
}

function canonicalArtifactBindings(
  values: readonly MaterializeReviewArtifactBinding[]
): MaterializeReviewArtifactBinding[] {
  const sorted = [...values].sort((left, right) =>
    `${left.destination}\u0000${left.source}`.localeCompare(`${right.destination}\u0000${right.source}`)
  );
  const identities = sorted.map((entry) => `${entry.destination}\u0000${entry.source}`);
  if (new Set(identities).size !== identities.length) {
    throw new Error("materialization review signoff selected artifacts must be unique by source and destination");
  }
  return sorted;
}

function trustedSigners(value: unknown): MaterializeReviewTrustedSigner[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error("materialization review signoff trusted_signers must be an array with at most 32 entries");
  }
  return canonicalTrustedSigners(
    value.map((candidate, index) => {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error(`materialization review signoff trusted_signers[${index}] must be an object`);
      }
      const record = candidate as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      if (keys.length !== 3 || keys[0] !== "algorithm" || keys[1] !== "key_id" || keys[2] !== "public_key_sha256") {
        throw new Error(`materialization review signoff trusted_signers[${index}] has unknown or missing fields`);
      }
      if (record.algorithm !== "ed25519") {
        throw new Error(`materialization review signoff trusted_signers[${index}].algorithm must be ed25519`);
      }
      return {
        key_id: safeId(record.key_id, `trusted_signers[${index}].key_id`),
        algorithm: "ed25519" as const,
        public_key_sha256: sha256(record.public_key_sha256, `trusted_signers[${index}].public_key_sha256`)
      };
    })
  );
}

function canonicalTrustedSigners(values: readonly MaterializeReviewTrustedSigner[]): MaterializeReviewTrustedSigner[] {
  const sorted = values
    .map((entry) => ({
      key_id: safeId(entry.key_id, "trusted signer key_id"),
      algorithm: entry.algorithm,
      public_key_sha256: sha256(entry.public_key_sha256, "trusted signer public_key_sha256")
    }))
    .sort((left, right) => left.key_id.localeCompare(right.key_id));
  if (sorted.some((entry) => entry.algorithm !== "ed25519")) {
    throw new Error("materialization review trusted signer algorithm must be ed25519");
  }
  if (new Set(sorted.map((entry) => entry.key_id)).size !== sorted.length) {
    throw new Error("materialization review trusted signer key IDs must be unique");
  }
  return sorted as MaterializeReviewTrustedSigner[];
}

function validateSigningAuthorities(value: unknown): MaterializeReviewSigningAuthority[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error("sealed materialization reviewer authorities must be an array with at most 32 entries");
  }
  const authorities = value.map((candidate, index): MaterializeReviewSigningAuthority => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`sealed materialization reviewer authority ${index} must be an object`);
    }
    const record = candidate as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (
      keys.length !== 4 ||
      keys[0] !== "algorithm" ||
      keys[1] !== "key_id" ||
      keys[2] !== "public_key_sha256" ||
      keys[3] !== "public_key_spki_base64"
    ) {
      throw new Error(`sealed materialization reviewer authority ${index} has unknown or missing fields`);
    }
    if (record.algorithm !== "ed25519") {
      throw new Error(`sealed materialization reviewer authority ${index} algorithm must be ed25519`);
    }
    const authority = {
      key_id: safeId(record.key_id, `reviewer authority ${index} key_id`),
      algorithm: "ed25519" as const,
      public_key_sha256: sha256(record.public_key_sha256, `reviewer authority ${index} public_key_sha256`),
      public_key_spki_base64: canonicalBase64(
        record.public_key_spki_base64,
        `reviewer authority ${index} public_key_spki_base64`
      )
    };
    const key = publicKeyForAuthority(authority);
    const canonical = Buffer.from(key.export({ format: "der", type: "spki" }));
    if (sha256Bytes(canonical) !== authority.public_key_sha256) {
      throw new Error(`sealed materialization reviewer authority ${index} public-key fingerprint does not match`);
    }
    return authority;
  });
  authorities.sort((left, right) => left.key_id.localeCompare(right.key_id));
  if (new Set(authorities.map((entry) => entry.key_id)).size !== authorities.length) {
    throw new Error("sealed materialization reviewer authority key IDs must be unique");
  }
  return authorities;
}

function publicKeyForAuthority(authority: MaterializeReviewSigningAuthority): crypto.KeyObject {
  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey({
      key: Buffer.from(authority.public_key_spki_base64, "base64"),
      format: "der",
      type: "spki"
    });
  } catch (error) {
    throw new Error("sealed materialization reviewer authority is not a DER SPKI public key", { cause: error });
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("sealed materialization reviewer authority is not an Ed25519 public key");
  }
  return key;
}

function canonicalSignature(value: unknown): string {
  const encoded = canonicalBase64(value, "signature");
  if (Buffer.from(encoded, "base64").byteLength !== 64) {
    throw new Error("materialization review signoff signature must be a 64-byte Ed25519 signature");
  }
  return encoded;
}

function canonicalBase64(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    throw new Error(`materialization review signoff ${label} must be bounded canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value) {
    throw new Error(`materialization review signoff ${label} must be canonical base64`);
  }
  return value;
}

function targetHeadIdentity(projectRoot: string): { commit: string; tree: string } {
  const git = (args: string[]): string =>
    execFileSync("git", args, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024
    })
      .trim()
      .toLowerCase();
  return {
    commit: digestLike(git(["rev-parse", "--verify", "HEAD^{commit}"]), "target commit"),
    tree: digestLike(git(["rev-parse", "--verify", "HEAD^{tree}"]), "target tree")
  };
}

function cleanTargetIdentity(projectRoot: string): { commit: string; tree: string; worktreeDigest: string } {
  const target = captureDataGovernanceTargetIdentity(projectRoot);
  const status = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: projectRoot,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024
  });
  if (status.length !== 0) {
    throw new Error("publication-sensitive materialization requires a clean target working tree");
  }
  if (target.commit === null || target.tree === null || target.worktree_digest === null || target.dirty) {
    throw new Error("publication-sensitive materialization requires an exactly bound clean Git target");
  }
  return {
    commit: target.commit,
    tree: target.tree,
    worktreeDigest: target.worktree_digest
  };
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function boundedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 8192) {
    throw new Error(`materialization review signoff ${label} must be a non-empty bounded string`);
  }
  return value.trim();
}

function literalTrue(value: unknown, label: string): true {
  if (value !== true) throw new Error(`materialization review signoff ${label} must be true`);
  return true;
}

function timestamp(value: unknown, label: string): string {
  const normalized = boundedString(value, label);
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== normalized) {
    throw new Error(`materialization review signoff ${label} must be a canonical UTC timestamp`);
  }
  return normalized;
}

function safeId(value: unknown, label: string): string {
  const normalized = boundedString(value, label);
  if (!SAFE_ID_PATTERN.test(normalized)) {
    throw new Error(`materialization review signoff ${label} must be a canonical safe ID`);
  }
  return normalized;
}

function sha256(value: unknown, label: string): string {
  const normalized = boundedString(value, label).toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`materialization review signoff ${label} must be SHA-256`);
  return normalized;
}

function digestLike(value: unknown, label: string): string {
  const normalized = boundedString(value, label).toLowerCase();
  if (!/^[a-f0-9]{40,64}$/u.test(normalized)) {
    throw new Error(`materialization review signoff ${label} must be a Git object ID`);
  }
  return normalized;
}
