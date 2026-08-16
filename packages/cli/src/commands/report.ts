import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { Args, Command } from "@oclif/core";
import {
  assertNoSymlinkComponents,
  assertPathInside,
  DEFAULT_STRICT_JSONL_MAX_BYTES,
  layoutForRunRoot,
  parseStrictJsonBytes,
  parseStrictJsonlBytes,
  readRunMetadataDocument,
  safeResolveInside,
  sha256Bytes,
  validateSafeIdOrThrow,
  type StrictJsonlCodec,
  type StrictJsonlSnapshot
} from "@ultrafuzz/artifacts";
import {
  DATA_GOVERNANCE_POLICY_ENV,
  MAX_MATERIALIZE_COMMIT_WITNESS_BYTES,
  loadOperatorAuthenticatedMaterializeReviewAuthorities,
  materializeCommitWitnessMatches,
  materializeAuditCodec,
  materializeIntentCodec,
  parseMaterializeCommitWitness,
  recordedMaterializeReviewSignoffRequest,
  runsRootForProject,
  verifyRecordedMaterializeReviewSignoff,
  type MaterializeAuditRecord,
  type MaterializeCommitWitness,
  type MaterializeIntentRecord,
  type RuntimeDiagnostic
} from "@ultrafuzz/runtime";

import { cliIo, commandFailure, emitCommandResult, globalFlags, projectRoot } from "../command-shared.js";
import type { CliReportAssurance } from "../cli-contracts.js";
import { loadValidatedReportSnapshot, type ValidatedReportSnapshot } from "../report-artifacts.js";

type AccountingField = "tokens_used" | "estimated_spend";

interface ExpectedAccounting {
  tokens_used?: string;
  estimated_spend?: string;
  partial_pricing?: boolean;
}

interface OpenedReportAssuranceDirectory {
  descriptor: number;
  projectRoot: string;
  lexicalPath: string;
  accessPath: string;
  identity: fs.BigIntStats;
}

interface StableReportAssuranceSnapshot {
  bytes: Buffer;
  generation: fs.BigIntStats;
}

interface OpenedAcceptedMaterializeDestination {
  descriptor: number;
  directory: OpenedReportAssuranceDirectory;
  accessPath: string;
  destination: string;
  expectedSize: number;
  expectedSha256: string;
  identity: fs.BigIntStats;
  verifiedGeneration?: fs.BigIntStats;
}

const MAX_ACCEPTED_MATERIALIZE_COPIES = 128;
const MAX_ACCEPTED_MATERIALIZE_BYTES = 64 * 1024 * 1024;

export default class Report extends Command {
  static override summary = "Show the agent-written final report for a run";
  static override args = { runId: Args.string({ required: true, description: "Ultrafuzz run ID" }) };
  static override flags = globalFlags;

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Report);
    const root = projectRoot(flags);
    try {
      const runsRoot = await runsRootForProject(root);
      const runId = validateSafeIdOrThrow(args.runId, "run ID");
      const layout = layoutForRunRoot(path.join(runsRoot, runId), runId);
      assertPathInside(runsRoot, layout.root, "run root");
      assertNoSymlinkComponents(runsRoot, layout.root, "run root");
      const loaded = loadValidatedReportSnapshot(layout.root);
      const assurance = reportAssuranceDiagnostics(root, layout.root, runId, cliIo().env[DATA_GOVERNANCE_POLICY_ENV]);
      const diagnostics = [...reportAccountingDiagnostics(layout.root, loaded), ...assurance.diagnostics];
      emitCommandResult(
        this,
        "report",
        {
          ok: true,
          command: "report",
          data: { ...loaded.artifacts, assurance: assurance.publicAssurance },
          text:
            `Report: ${loaded.artifacts.markdown_path}\nJSON: ${loaded.artifacts.json_path}\n` +
            `Assurance — structural verification: passed\n` +
            `Assurance — model consensus: agent-produced; not human acceptance\n` +
            `Assurance — executable reproduction: evidence recorded; not replayed by this command\n` +
            `Assurance — human acceptance: ${assurance.humanAcceptanceText}\n`,
          diagnostics
        },
        flags.json === true
      );
    } catch (error) {
      emitCommandResult(
        this,
        "report",
        commandFailure("report", error instanceof Error ? error.message : String(error), "REPORT_FAILED"),
        flags.json === true
      );
    }
  }
}

function reportAssuranceDiagnostics(
  projectRoot: string,
  runRoot: string,
  runId: string,
  operatorPolicyJson: string | undefined
): { diagnostics: RuntimeDiagnostic[]; publicAssurance: CliReportAssurance; humanAcceptanceText: string } {
  let humanAcceptance: CliReportAssurance["human_acceptance"] = "not-recorded";
  let reviewSignoff: CliReportAssurance["review_signoff"] = "not-present";
  let invalidSignoff = false;
  try {
    const layout = layoutForRunRoot(runRoot, runId);
    const audit = readAnchoredReportAssuranceJournal(
      projectRoot,
      path.join(projectRoot, ".ultrafuzz", "materialize-audit.jsonl"),
      materializeAuditCodec
    );
    const intents = readAnchoredReportAssuranceJournal(
      projectRoot,
      path.join(projectRoot, ".ultrafuzz", "materialize-intent.jsonl"),
      materializeIntentCodec
    );
    const candidates = audit.records.filter(
      (record) =>
        record.run_id === runId &&
        record.mode === "unstaged-working-tree" &&
        record.confirmed === true &&
        record.review_signoff !== undefined
    );
    let authorities: ReturnType<typeof loadOperatorAuthenticatedMaterializeReviewAuthorities> = [];
    if (candidates.length > 0) {
      if (operatorPolicyJson === undefined || operatorPolicyJson.trim().length === 0) {
        humanAcceptance = "unverified";
        reviewSignoff = "operator-policy-required";
      } else {
        try {
          authorities = loadOperatorAuthenticatedMaterializeReviewAuthorities({
            projectRoot,
            layout,
            operatorPolicyJson
          });
        } catch {
          humanAcceptance = "unverified";
          reviewSignoff = "invalid";
          invalidSignoff = true;
        }
      }
    }
    for (const record of candidates) {
      if (authorities.length === 0) break;
      try {
        assertAcceptedMaterializeLifecycle(projectRoot, record, intents.records);
        const expected = recordedMaterializeReviewSignoffRequest({
          projectRoot,
          layout,
          selections: record.copies.map((copy) => ({
            source: copy.source,
            destination: copy.destination,
            sha256: copy.sha256
          })),
          authorities,
          signoff: record.review_signoff!
        });
        verifyRecordedMaterializeReviewSignoff({ signoff: record.review_signoff!, expected, authorities });
        humanAcceptance = "accepted";
        reviewSignoff = "verified";
      } catch {
        invalidSignoff = true;
      }
    }
    if (invalidSignoff && humanAcceptance !== "accepted") {
      humanAcceptance = "unverified";
      reviewSignoff = "invalid";
    }
  } catch {
    humanAcceptance = "unverified";
    reviewSignoff = "audit-unavailable";
  }
  const publicAssurance: CliReportAssurance = {
    structural_verification: "passed",
    model_consensus: "agent-produced",
    executable_reproduction: "not-replayed",
    human_acceptance: humanAcceptance,
    review_signoff: reviewSignoff
  };
  const humanAcceptanceText = humanAcceptance.replace("-", " ");
  return {
    publicAssurance,
    humanAcceptanceText,
    diagnostics: [
      {
        code: "REPORT_ASSURANCE_STRUCTURAL_VERIFICATION",
        message: "structural verification passed for the authenticated final-report pair",
        severity: "info",
        source: "report",
        details: { assurance_level: "structural-verification", status: "passed" }
      },
      {
        code: "REPORT_ASSURANCE_MODEL_CONSENSUS",
        message: "model consensus is agent-produced evidence and is not independent human acceptance",
        severity: "info",
        source: "report",
        details: { assurance_level: "model-consensus", status: "agent-produced" }
      },
      {
        code: "REPORT_ASSURANCE_EXECUTABLE_REPRODUCTION",
        message: "executable reproduction is represented by report evidence; the report command does not replay it",
        severity: "info",
        source: "report",
        details: { assurance_level: "executable-reproduction", status: "not-replayed" }
      },
      {
        code: "REPORT_ASSURANCE_HUMAN_ACCEPTANCE",
        message: `human acceptance: ${humanAcceptanceText}`,
        severity: humanAcceptance === "unverified" ? "warning" : "info",
        source: "report",
        details: { assurance_level: "human-acceptance", status: humanAcceptance }
      },
      ...(invalidSignoff
        ? [
            {
              code: "REPORT_ASSURANCE_SIGNOFF_INVALID",
              message:
                "a materialization audit claimed human acceptance but failed intent, current-destination, authority, binding, digest, or signature verification",
              severity: "warning" as const,
              source: "report"
            }
          ]
        : [])
    ]
  };
}

function assertAcceptedMaterializeLifecycle(
  projectRoot: string,
  completion: MaterializeAuditRecord,
  intents: readonly MaterializeIntentRecord[]
): void {
  const intent = intents.find((record) => record.intent_id === completion.audit_id);
  if (intent === undefined) {
    throw new Error(`materialize completion ${completion.audit_id} has no matching durable intent`);
  }
  const witness = readAnchoredReportAssuranceCommitWitness(projectRoot, completion.audit_id);
  if (!materializeCommitWitnessMatches(witness, intent, completion)) {
    throw new Error(`materialize completion ${completion.audit_id} has no exact durable commit witness`);
  }
  const expectedCompletion = {
    run_id: intent.run_id,
    timestamp: intent.timestamp,
    operation: intent.operation,
    mode: intent.mode,
    unstaged: intent.unstaged,
    confirmed: intent.confirmed,
    allow_overwrite: intent.allow_overwrite,
    commit_nonce_sha256: intent.commit_nonce_sha256,
    commit_witness_device: intent.commit_witness_device,
    commit_witness_inode: intent.commit_witness_inode,
    copies: intent.copies,
    patches: intent.patches
  };
  const actualCompletion = {
    run_id: completion.run_id,
    timestamp: completion.timestamp,
    operation: completion.operation,
    mode: completion.mode,
    unstaged: completion.unstaged,
    confirmed: completion.confirmed,
    allow_overwrite: completion.allow_overwrite,
    commit_nonce_sha256: completion.commit_nonce_sha256,
    commit_witness_device: completion.commit_witness_device,
    commit_witness_inode: completion.commit_witness_inode,
    copies: completion.copies,
    patches: completion.patches
  };
  if (!isDeepStrictEqual(actualCompletion, expectedCompletion)) {
    throw new Error(`materialize completion ${completion.audit_id} does not exactly match its durable intent`);
  }
  if (completion.allow_overwrite || completion.copies.length === 0) {
    throw new Error("accepted materialization evidence must be a non-empty create-only copy transaction");
  }
  if (completion.copies.length > MAX_ACCEPTED_MATERIALIZE_COPIES) {
    throw new Error(`accepted materialization exceeds ${MAX_ACCEPTED_MATERIALIZE_COPIES} copies`);
  }
  const aggregateBytes = completion.copies.reduce((total, copy) => total + BigInt(copy.size_bytes), 0n);
  if (aggregateBytes > BigInt(MAX_ACCEPTED_MATERIALIZE_BYTES)) {
    throw new Error(`accepted materialization exceeds ${MAX_ACCEPTED_MATERIALIZE_BYTES} bytes`);
  }

  const destinations = new Set<string>();
  const selectedDestinations: Array<{
    destination: string;
    expectedSize: number;
    expectedSha256: string;
  }> = [];
  for (const copy of completion.copies) {
    const destination = safeResolveInside(projectRoot, copy.destination, "accepted materialize destination");
    const relative = path.relative(projectRoot, destination).split(path.sep).join("/");
    if (
      relative === ".git" ||
      relative.startsWith(".git/") ||
      relative === ".ultrafuzz" ||
      relative.startsWith(".ultrafuzz/")
    ) {
      throw new Error(`accepted materialize destination is a protected product path: ${copy.destination}`);
    }
    if (destinations.has(destination)) {
      throw new Error(`accepted materialize destination resolves more than once: ${copy.destination}`);
    }
    destinations.add(destination);
    selectedDestinations.push({
      destination,
      expectedSize: copy.size_bytes,
      expectedSha256: copy.sha256
    });
  }
  assertCurrentAcceptedMaterializeDestinations(projectRoot, selectedDestinations);
}

function readAnchoredReportAssuranceCommitWitness(projectRoot: string, auditId: string): MaterializeCommitWitness {
  const directory = openReportAssuranceDirectory(
    projectRoot,
    path.join(projectRoot, ".ultrafuzz", "materialize-commits")
  );
  const accessPath = path.join(directory.accessPath, `${auditId}.json`);
  let descriptor: number | undefined;
  let result: MaterializeCommitWitness | undefined;
  let failure: unknown;
  try {
    descriptor = fs.openSync(accessPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const initial = assertAnchoredReportAssuranceFile(descriptor, accessPath, "materialize commit witness");
    if (initial.size > BigInt(MAX_MATERIALIZE_COMMIT_WITNESS_BYTES) || (initial.mode & 0o7777n) !== 0o600n) {
      throw new Error("materialize commit witness exceeds its byte bound or is not mode 0600");
    }
    const captured = captureStableReportAssuranceDescriptor(
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
    if (!captured.bytes.equals(Buffer.from(`${JSON.stringify(parsed)}\n`, "utf8"))) {
      throw new Error("materialize commit witness is not canonical JSON with one trailing newline");
    }
    assertAnchoredReportAssuranceFile(descriptor, accessPath, "materialize commit witness", initial);
    assertReportAssuranceDirectoryCurrent(directory);
    assertAnchoredReportAssuranceFileGeneration(
      descriptor,
      accessPath,
      "materialize commit witness",
      captured.generation
    );
    assertReportAssuranceDirectoryCurrent(directory);
    result = parsed;
  } catch (error) {
    failure = error;
  }
  if (descriptor !== undefined) {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      failure = aggregateReportAssuranceFailure(failure, error, "failed to close materialize commit witness");
    }
  }
  try {
    closeReportAssuranceDirectory(directory);
  } catch (error) {
    failure = aggregateReportAssuranceFailure(failure, error, "failed to close materialize commit witness directory");
  }
  if (failure !== undefined) throw failure;
  if (result === undefined) throw new Error("materialize commit witness produced no anchored assurance snapshot");
  return result;
}

function assertCurrentAcceptedMaterializeDestinations(
  projectRoot: string,
  selected: ReadonlyArray<{ destination: string; expectedSize: number; expectedSha256: string }>
): void {
  const opened: OpenedAcceptedMaterializeDestination[] = [];
  let failure: unknown;
  try {
    for (const destination of selected) {
      opened.push(openAcceptedMaterializeDestination(projectRoot, destination));
    }
    for (const destination of opened) verifyAcceptedMaterializeDestination(destination);
    for (const destination of opened) assertAcceptedMaterializeDestinationGeneration(destination);
  } catch (error) {
    failure = error;
  }
  for (const destination of opened) {
    if (destination.descriptor >= 0) {
      const descriptor = destination.descriptor;
      destination.descriptor = -1;
      try {
        fs.closeSync(descriptor);
      } catch (error) {
        failure = aggregateReportAssuranceFailure(failure, error, "failed to close accepted destination");
      }
    }
  }
  for (const destination of opened) {
    try {
      closeReportAssuranceDirectory(destination.directory);
    } catch (error) {
      failure = aggregateReportAssuranceFailure(failure, error, "failed to close accepted destination directory");
    }
  }
  if (failure !== undefined) throw failure;
}

function openAcceptedMaterializeDestination(
  projectRoot: string,
  selected: { destination: string; expectedSize: number; expectedSha256: string }
): OpenedAcceptedMaterializeDestination {
  const { destination, expectedSize, expectedSha256 } = selected;
  const directory = openReportAssuranceDirectory(projectRoot, path.dirname(destination));
  const accessPath = path.join(directory.accessPath, path.basename(destination));
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(accessPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const identity = assertAnchoredReportAssuranceFile(descriptor, accessPath, "accepted materialize destination");
    if (identity.size !== BigInt(expectedSize) || (identity.mode & 0o7777n) !== 0o600n) {
      throw new Error("accepted materialize destination size or mode differs from the completed operation");
    }
    assertReportAssuranceDirectoryCurrent(directory);
    return { descriptor, directory, accessPath, destination, expectedSize, expectedSha256, identity };
  } catch (error) {
    let failure: unknown = error;
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (closeError) {
        failure = aggregateReportAssuranceFailure(failure, closeError, "failed to close accepted destination");
      }
    }
    try {
      closeReportAssuranceDirectory(directory);
    } catch (closeError) {
      failure = aggregateReportAssuranceFailure(failure, closeError, "failed to close accepted destination directory");
    }
    throw failure;
  }
}

function verifyAcceptedMaterializeDestination(destination: OpenedAcceptedMaterializeDestination): void {
  const captured = captureStableReportAssuranceDescriptor(
    destination.descriptor,
    MAX_ACCEPTED_MATERIALIZE_BYTES,
    "accepted materialize destination"
  );
  if (!sameReportAssuranceFileGeneration(destination.identity, captured.generation)) {
    throw new Error("accepted materialize destination changed before its exact-byte proof completed");
  }
  if (sha256Bytes(captured.bytes) !== destination.expectedSha256) {
    throw new Error("accepted materialize destination digest differs from the completed operation");
  }
  assertReportAssuranceDirectoryCurrent(destination.directory);
  const final = assertAnchoredReportAssuranceFileGeneration(
    destination.descriptor,
    destination.accessPath,
    "accepted materialize destination",
    captured.generation
  );
  if (final.size !== BigInt(destination.expectedSize) || (final.mode & 0o7777n) !== 0o600n) {
    throw new Error("accepted materialize destination changed while assurance was verified");
  }
  assertReportAssuranceDirectoryCurrent(destination.directory);
  destination.verifiedGeneration = final;
}

function assertAcceptedMaterializeDestinationGeneration(destination: OpenedAcceptedMaterializeDestination): void {
  if (destination.verifiedGeneration === undefined) {
    throw new Error("accepted materialize destination has no exact-byte generation proof");
  }
  assertReportAssuranceDirectoryCurrent(destination.directory);
  assertAnchoredReportAssuranceFileGeneration(
    destination.descriptor,
    destination.accessPath,
    "accepted materialize destination",
    destination.verifiedGeneration
  );
  assertReportAssuranceDirectoryCurrent(destination.directory);
}

function readAnchoredReportAssuranceJournal<RecordType>(
  projectRoot: string,
  journalPath: string,
  codec: StrictJsonlCodec<RecordType>
): StrictJsonlSnapshot<RecordType> {
  const directory = openReportAssuranceDirectory(projectRoot, path.dirname(journalPath));
  const accessPath = path.join(directory.accessPath, path.basename(journalPath));
  let descriptor: number | undefined;
  let result: StrictJsonlSnapshot<RecordType> | undefined;
  let failure: unknown;
  try {
    try {
      descriptor = fs.openSync(accessPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (error) {
      if (!isReportNodeError(error) || error.code !== "ENOENT") throw error;
      assertReportAssuranceDirectoryCurrent(directory);
      try {
        fs.lstatSync(accessPath);
      } catch (absenceError) {
        if (!isReportNodeError(absenceError) || absenceError.code !== "ENOENT") throw absenceError;
        assertReportAssuranceDirectoryCurrent(directory);
        result = { records: [], byteLength: 0, exists: false };
      }
    }
    if (descriptor !== undefined) {
      const initial = assertAnchoredReportAssuranceFile(descriptor, accessPath, codec.label);
      const captured = captureStableReportAssuranceDescriptor(
        descriptor,
        codec.maxBytes ?? DEFAULT_STRICT_JSONL_MAX_BYTES,
        codec.label
      );
      result = parseStrictJsonlBytes(captured.bytes, codec);
      assertAnchoredReportAssuranceFile(descriptor, accessPath, codec.label, initial);
      assertReportAssuranceDirectoryCurrent(directory);
      assertAnchoredReportAssuranceFileGeneration(descriptor, accessPath, codec.label, captured.generation);
      assertReportAssuranceDirectoryCurrent(directory);
    }
  } catch (error) {
    failure = error;
  }
  if (descriptor !== undefined) {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      failure = aggregateReportAssuranceFailure(failure, error, `failed to close ${codec.label}`);
    }
  }
  try {
    closeReportAssuranceDirectory(directory);
  } catch (error) {
    failure = aggregateReportAssuranceFailure(failure, error, `failed to close ${codec.label} directory`);
  }
  if (failure !== undefined) throw failure;
  if (result === undefined) throw new Error(`${codec.label} produced no anchored assurance snapshot`);
  return result;
}

function openReportAssuranceDirectory(projectRoot: string, targetDirectory: string): OpenedReportAssuranceDirectory {
  const relative = path.relative(projectRoot, targetDirectory);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("report assurance directory escapes the project root");
  }
  let current = openVerifiedReportAssuranceDirectory(projectRoot, projectRoot, "report assurance project root");
  try {
    for (const component of relative === "" ? [] : relative.split(path.sep)) {
      assertReportAssuranceDirectoryCurrent(current);
      const child = openVerifiedReportAssuranceDirectory(
        projectRoot,
        path.join(current.lexicalPath, component),
        "report assurance directory",
        path.join(current.accessPath, component)
      );
      try {
        assertReportAssuranceDirectoryCurrent(current);
        assertReportAssuranceDirectoryCurrent(child);
        closeReportAssuranceDirectory(current);
      } catch (error) {
        closeReportAssuranceDirectory(child);
        throw error;
      }
      current = child;
    }
    return current;
  } catch (error) {
    closeReportAssuranceDirectory(current);
    throw error;
  }
}

function openVerifiedReportAssuranceDirectory(
  projectRoot: string,
  lexicalPath: string,
  label: string,
  openPath = lexicalPath
): OpenedReportAssuranceDirectory {
  assertNoSymlinkComponents(projectRoot, lexicalPath, label);
  const descriptor = fs.openSync(openPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const identity = fs.fstatSync(descriptor, { bigint: true });
    if (!identity.isDirectory()) throw new Error(`${label} is not a physical directory`);
    const accessPath = reportAssuranceDirectoryDescriptorPath(descriptor, identity);
    const opened = { descriptor, projectRoot, lexicalPath, accessPath, identity };
    assertReportAssuranceDirectoryCurrent(opened);
    return opened;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function reportAssuranceDirectoryDescriptorPath(descriptor: number, identity: fs.BigIntStats): string {
  for (const candidate of [`/proc/self/fd/${descriptor}`, `/dev/fd/${descriptor}`]) {
    try {
      const accessed = fs.statSync(candidate, { bigint: true });
      if (accessed.isDirectory() && accessed.dev === identity.dev && accessed.ino === identity.ino) return candidate;
    } catch {
      // Continue to the next descriptor filesystem.
    }
  }
  throw new Error("report assurance directory has no verifiable descriptor path");
}

function assertReportAssuranceDirectoryCurrent(opened: OpenedReportAssuranceDirectory): void {
  assertNoSymlinkComponents(opened.projectRoot, opened.lexicalPath, "report assurance directory");
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
    throw new Error("report assurance directory changed while it was held");
  }
}

function assertAnchoredReportAssuranceFile(
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
    throw new Error(`${label} is not the exact singly linked held regular file`);
  }
  return opened;
}

function assertAnchoredReportAssuranceFileGeneration(
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
    !sameReportAssuranceFileGeneration(opened, expected) ||
    !sameReportAssuranceFileGeneration(named, expected)
  ) {
    throw new Error(`${label} content generation changed after its exact-byte proof`);
  }
  return opened;
}

function sameReportAssuranceFileGeneration(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
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

function captureStableReportAssuranceDescriptor(
  descriptor: number,
  maxBytes: number,
  label: string
): StableReportAssuranceSnapshot {
  const before = fs.fstatSync(descriptor, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes)) {
    throw new Error(`${label} exceeds its bounded regular-file contract`);
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

function closeReportAssuranceDirectory(opened: OpenedReportAssuranceDirectory): void {
  if (opened.descriptor < 0) return;
  const descriptor = opened.descriptor;
  opened.descriptor = -1;
  fs.closeSync(descriptor);
}

function aggregateReportAssuranceFailure(primary: unknown, secondary: unknown, message: string): unknown {
  if (primary === undefined) return secondary;
  return new AggregateError([primary, secondary], message, { cause: secondary });
}

function isReportNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function reportAccountingDiagnostics(runRoot: string, report: ValidatedReportSnapshot): RuntimeDiagnostic[] {
  const expected = expectedAccountingFromRunMetadata(path.join(runRoot, "run.json"));
  if (expected === undefined) {
    return [];
  }

  const diagnostics: RuntimeDiagnostic[] = [];
  diagnostics.push(
    ...markdownAccountingDiagnostics(report.markdown, expected, report.artifacts.markdown_path),
    ...reportJsonAccountingDiagnostics(report.json, expected, report.artifacts.json_path)
  );
  return diagnostics;
}

function expectedAccountingFromRunMetadata(metadataPath: string): ExpectedAccounting | undefined {
  const metadata = readRunMetadataDocument(metadataPath, path.basename(path.dirname(metadataPath)));
  const cumulative = metadata.accounting?.cumulative;
  if (cumulative === undefined) return undefined;
  const tokensUsed = cumulative.tokens_used;
  const estimatedSpend = cumulative.estimated_spend;
  const partialPricing = cumulative.partial_pricing;
  const expected = {
    ...(isAvailableLabel(tokensUsed) ? { tokens_used: tokensUsed } : {}),
    ...(isAvailableLabel(estimatedSpend) ? { estimated_spend: estimatedSpend } : {}),
    partial_pricing: partialPricing
  };
  return expected.tokens_used === undefined && expected.estimated_spend === undefined ? undefined : expected;
}

function markdownAccountingDiagnostics(
  markdown: string,
  expected: ExpectedAccounting,
  markdownPath: string
): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  diagnostics.push(
    ...accountingValueDiagnostics({
      field: "tokens_used",
      actual: markdownLabel(markdown, "Tokens used"),
      expected: expected.tokens_used,
      expectedPartialPricing: false,
      filePath: markdownPath,
      artifact: "markdown"
    })
  );
  diagnostics.push(
    ...accountingValueDiagnostics({
      field: "estimated_spend",
      actual: markdownLabel(markdown, "Estimated spend"),
      expected: expected.estimated_spend,
      expectedPartialPricing: expected.partial_pricing === true,
      filePath: markdownPath,
      artifact: "markdown"
    })
  );
  return diagnostics;
}

function reportJsonAccountingDiagnostics(
  reportJson: unknown,
  expected: ExpectedAccounting,
  jsonPath: string
): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  const runMetadata = recordField(reportJson, "run_metadata");
  if (runMetadata === undefined) {
    diagnostics.push({
      code: "REPORT_RUN_METADATA_MISSING",
      message: "report.json is missing run_metadata despite populated accounting in run metadata",
      severity: "warning",
      source: "report",
      path: jsonPath
    });
    return diagnostics;
  }
  diagnostics.push(
    ...accountingValueDiagnostics({
      field: "tokens_used",
      actual: labelField(runMetadata, "tokens_used", "integer"),
      expected: expected.tokens_used,
      expectedPartialPricing: false,
      filePath: jsonPath,
      artifact: "json"
    })
  );
  diagnostics.push(
    ...accountingValueDiagnostics({
      field: "estimated_spend",
      actual: labelField(runMetadata, "estimated_spend", "usd"),
      expected: expected.estimated_spend,
      expectedPartialPricing: expected.partial_pricing === true,
      filePath: jsonPath,
      artifact: "json"
    })
  );
  return diagnostics;
}

function accountingValueDiagnostics(input: {
  field: AccountingField;
  actual: string | undefined;
  expected: string | undefined;
  expectedPartialPricing: boolean;
  filePath: string;
  artifact: "markdown" | "json";
}): RuntimeDiagnostic[] {
  if (input.expected === undefined) {
    return [];
  }
  const reason = accountingValueProblem(input.field, input.actual, input.expected, input.expectedPartialPricing);
  return reason === undefined
    ? []
    : [accountingDiagnostic(input.field, input.expected, input.filePath, input.artifact, input.actual, reason)];
}

function accountingValueProblem(
  field: AccountingField,
  actual: string | undefined,
  expected: string,
  expectedPartialPricing: boolean
): string | undefined {
  if (!isAvailableLabel(actual)) {
    return "missing or unavailable";
  }
  if (field === "tokens_used") {
    const actualTokens = parseIntegerLabel(actual);
    const expectedTokens = parseIntegerLabel(expected);
    if (actualTokens === undefined || actualTokens <= 0) {
      return "not a positive integer";
    }
    if (expectedTokens !== undefined && actualTokens > expectedTokens) {
      return "greater than current run metadata";
    }
    return undefined;
  }

  const actualSpend = parseUsdLabel(actual);
  const expectedSpend = parseUsdLabel(expected);
  if (actualSpend === undefined || actualSpend <= 0) {
    return "not a positive USD amount";
  }
  if ((expectedPartialPricing || hasPartialPricingSuffix(expected)) && !hasPartialPricingSuffix(actual)) {
    return "missing partial-pricing + suffix";
  }
  if (expectedSpend !== undefined && actualSpend > expectedSpend + 0.000001) {
    return "greater than current run metadata";
  }
  return undefined;
}

function accountingDiagnostic(
  field: AccountingField,
  expected: string,
  filePath: string,
  artifact: "markdown" | "json",
  actual: string | undefined,
  reason: string
): RuntimeDiagnostic {
  return {
    code: "REPORT_ACCOUNTING_MISMATCH",
    message: `${artifact} final report did not preserve usable ${field} from run metadata; expected ${expected}, got ${
      actual ?? "missing"
    } (${reason})`,
    severity: "warning",
    source: "report",
    path: filePath,
    details: { field, expected, ...(actual === undefined ? {} : { actual }), reason }
  };
}

function markdownLabel(markdown: string, label: string): string | undefined {
  const match = markdown.match(
    new RegExp(`^\\s*(?:[-*+]\\s*)?(?:\\*\\*)?${escapeRegExp(label)}(?:\\*\\*)?\\s*:\\s*(.+)$`, "imu")
  );
  return match?.[1] === undefined ? undefined : firstAccountingLabel(match[1]);
}

function firstAccountingLabel(value: string): string | undefined {
  const trimmed = value.trim();
  const code = trimmed.match(/`([^`]+)`/u);
  if (code?.[1] !== undefined) {
    return code[1].trim();
  }
  const inline = trimmed.match(/^\$?\d[\d,]*(?:\.\d+)?\+?|^unavailable\b/iu);
  return inline?.[0];
}

function isAvailableLabel(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0 && value.trim().toLowerCase() !== "unavailable";
}

function labelField(
  value: Record<string, unknown> | undefined,
  key: string,
  numericFormat: "integer" | "usd"
): string | undefined {
  const field = value?.[key];
  if (typeof field === "string") {
    return field;
  }
  return typeof field === "number" && Number.isFinite(field)
    ? numericFormat === "usd"
      ? formatUsd(field)
      : formatInteger(field)
    : undefined;
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return field && typeof field === "object" && !Array.isArray(field) ? (field as Record<string, unknown>) : undefined;
}

function formatInteger(value: number): string {
  return Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`;
}

function parseIntegerLabel(value: string): number | undefined {
  const normalized = value.trim().replace(/,/gu, "");
  return /^\d+$/u.test(normalized) ? Number(normalized) : undefined;
}

function parseUsdLabel(value: string): number | undefined {
  const normalized = value.trim().replace(/,/gu, "").replace(/^\$/u, "").replace(/\+$/u, "");
  if (!/^\d+(?:\.\d+)?$/u.test(normalized)) {
    return undefined;
  }
  return Number(normalized);
}

function hasPartialPricingSuffix(value: string): boolean {
  return value.trim().endsWith("+");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
