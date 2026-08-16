import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendCleanAuditRecord,
  appendMaterializeAuditRecord,
  appendMaterializeIntentRecord,
  CLEAN_AUDIT_SCHEMA_VERSION,
  MATERIALIZE_AUDIT_SCHEMA_VERSION,
  MATERIALIZE_COMMIT_WITNESS_SCHEMA_VERSION,
  MATERIALIZE_INTENT_SCHEMA_VERSION,
  canonicalMaterializeRecordDigest,
  materializeCommitWitnessMatches,
  parseCleanAuditRecord,
  parseMaterializeAuditRecord,
  parseMaterializeCommitWitness,
  parseMaterializeIntentRecord,
  readCleanAuditJournal,
  readMaterializeAuditJournal,
  readMaterializeIntentJournal,
  runtimeSchemaRegistry
} from "../src/index.js";

test("runtime audit schemas are closed, registered, and enforce exact current versions", () => {
  const registry = runtimeSchemaRegistry();
  assert.deepEqual(
    registry.map((entry) => entry.filename),
    [
      "clean-audit.schema.json",
      "cloud-execution-generation.schema.json",
      "invariant-suite-baseline.schema.json",
      "invariant-suite-handoff.schema.json",
      "invariant-workspace-snapshot.schema.json",
      "materialize-audit.schema.json",
      "materialize-commit-witness.schema.json",
      "materialize-intent.schema.json",
      "pinned-submodule-expectation.schema.json",
      "pinned-submodule-snapshot.schema.json",
      "smithers-reset-node.schema.json",
      "smithers-submission.schema.json",
      "workflow-control-integrity.schema.json",
      "workflow-execution-dependencies.schema.json",
      "workflow-run-link-journal.schema.json",
      "workspace-patch-baseline.schema.json",
      "workspace-patch-preparation.schema.json"
    ]
  );
  const clean = currentCleanRecord();
  assert.equal(parseCleanAuditRecord(clean), clean);
  assert.throws(
    () => parseCleanAuditRecord({ ...clean, schema_version: "1.0" }),
    /clean-audit:1: \/schema_version const/u
  );
  assert.throws(() => parseCleanAuditRecord({ ...clean, legacy: true }), /additionalProperties/u);

  const materialize = currentMaterializeRecord();
  assert.equal(parseMaterializeAuditRecord(materialize), materialize);
  assert.throws(
    () => parseMaterializeAuditRecord({ ...materialize, schema_version: "1.0" }),
    /materialize-audit:1: \/schema_version const/u
  );
  assert.throws(
    () =>
      parseMaterializeAuditRecord({
        ...materialize,
        copies: [materialize.copies[0], { ...materialize.copies[0], destination: "src/Other.sol" }]
      }),
    /copies source values must be unique/u
  );
  assert.throws(
    () =>
      parseMaterializeAuditRecord({
        ...materialize,
        commit_nonce_sha256: "a".repeat(64),
        commit_witness_device: "1",
        commit_witness_inode: "2"
      }),
    /commit_nonce_sha256 false schema/u
  );
  const legacyMaterialize = { ...materialize, mode: "unstaged-working-tree" as const };
  assert.equal(parseMaterializeAuditRecord(legacyMaterialize), legacyMaterialize);
  assert.throws(
    () => parseMaterializeAuditRecord({ ...legacyMaterialize, commit_nonce_sha256: "a".repeat(64) }),
    /dependentRequired/u
  );

  const intent = currentMaterializeIntentRecord();
  assert.equal(parseMaterializeIntentRecord(intent), intent);
  assert.throws(
    () => parseMaterializeIntentRecord({ ...intent, schema_version: "1.0" }),
    /materialize-intent:1: \/schema_version const/u
  );
  assert.throws(() => parseMaterializeIntentRecord({ ...intent, completed: true }), /additionalProperties/u);
  assert.deepEqual(registry.find((entry) => entry.filename === "materialize-intent.schema.json")?.semanticGates, [
    "materialize-intent-copy-source-uniqueness",
    "materialize-intent-copy-destination-uniqueness",
    "materialize-intent-copy-aggregate-budget",
    "materialize-intent-create-only",
    "materialize-intent-patch-source-uniqueness",
    "audit-history-ordering"
  ]);
  assert.throws(
    () =>
      parseMaterializeIntentRecord({
        ...intent,
        copies: [
          { ...intent.copies[0], size_bytes: 40 * 1024 * 1024 },
          {
            ...intent.copies[0],
            source: "artifacts/node/other.sol",
            destination: "src/Other.sol",
            size_bytes: 40 * 1024 * 1024
          }
        ]
      }),
    /64 MiB transaction byte budget/u
  );
  assert.throws(() => parseMaterializeIntentRecord({ ...intent, allow_overwrite: true }), /allow_overwrite const/u);
  assert.throws(() => parseMaterializeIntentRecord({ ...intent, confirmed: false }), /confirmed const/u);
  assert.throws(() => parseMaterializeIntentRecord({ ...intent, copies: [] }), /copies minItems/u);

  const completion = currentMaterializeCompletionRecord(intent);
  const witness = currentMaterializeCommitWitness(intent, completion);
  assert.deepEqual(
    registry.find((entry) => entry.filename === "materialize-commit-witness.schema.json")?.semanticGates,
    ["materialize-commit-witness-canonical-timestamp"]
  );
  assert.equal(parseMaterializeCommitWitness(witness), witness);
  assert.equal(materializeCommitWitnessMatches(witness, intent, completion), true);
  assert.equal(
    materializeCommitWitnessMatches(witness, intent, {
      ...completion,
      copies: [{ ...completion.copies[0]!, destination: "src/Different.sol" }]
    }),
    false
  );
  assert.throws(
    () => parseMaterializeCommitWitness({ ...witness, committed_at: "2026-08-16T00:00:00Z" }),
    /committed_at must use canonical UTC milliseconds/u
  );
  assert.throws(() => parseMaterializeCommitWitness({ ...witness, legacy: true }), /additionalProperties/u);
});

test("runtime audit journals validate immutable complete history before append", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-runtime-audits-"));
  const cleanPath = path.join(root, "clean-audit.jsonl");
  const materializePath = path.join(root, "materialize-audit.jsonl");
  const intentPath = path.join(root, "materialize-intent.jsonl");
  const clean = currentCleanRecord();
  const materialize = currentMaterializeRecord();

  appendCleanAuditRecord(cleanPath, clean, root);
  appendMaterializeAuditRecord(materializePath, materialize, root);
  const intent = currentMaterializeIntentRecord();
  appendMaterializeIntentRecord(intentPath, intent, root);
  assert.deepEqual(readCleanAuditJournal(cleanPath).records, [clean]);
  assert.deepEqual(readMaterializeAuditJournal(materializePath).records, [materialize]);
  assert.deepEqual(readMaterializeIntentJournal(intentPath).records, [intent]);

  const cleanBytes = fs.readFileSync(cleanPath);
  fs.writeFileSync(cleanPath, `${cleanBytes.toString("utf8").trimEnd()} `, "utf8");
  assert.throws(() => readCleanAuditJournal(cleanPath), /torn or unterminated/u);
  assert.deepEqual(fs.readFileSync(cleanPath), Buffer.from(`${cleanBytes.toString("utf8").trimEnd()} `, "utf8"));

  fs.writeFileSync(materializePath, `${JSON.stringify({ ...materialize, schema_version: "1.0" })}\n`, "utf8");
  const malformedBytes = fs.readFileSync(materializePath);
  assert.throws(
    () => appendMaterializeAuditRecord(materializePath, currentMaterializeRecord(), root),
    /schema_version/u
  );
  assert.deepEqual(fs.readFileSync(materializePath), malformedBytes);
});

function currentCleanRecord() {
  return {
    schema_version: CLEAN_AUDIT_SCHEMA_VERSION,
    audit_id: crypto.randomUUID(),
    timestamp: "2026-08-09T12:00:00.000Z",
    operation: "cleanRun" as const,
    status: "dry-run" as const,
    confirmed: true as const,
    selections: [{ path: "runs/example", existed: true }]
  };
}

function currentMaterializeRecord() {
  return {
    schema_version: MATERIALIZE_AUDIT_SCHEMA_VERSION,
    audit_id: crypto.randomUUID(),
    run_id: "example-run",
    timestamp: "2026-08-09T12:00:00.000Z",
    operation: "materializeSelection" as const,
    mode: "dry-run" as const,
    unstaged: true as const,
    confirmed: true,
    allow_overwrite: false,
    copies: [
      {
        source: "artifacts/node/output.sol",
        destination: "src/Output.sol",
        size_bytes: 12,
        sha256: "a".repeat(64)
      }
    ],
    patches: []
  };
}

function currentMaterializeIntentRecord() {
  const commitNonce = "b".repeat(64);
  return {
    schema_version: MATERIALIZE_INTENT_SCHEMA_VERSION,
    intent_id: crypto.randomUUID(),
    run_id: "example-run",
    timestamp: "2026-08-09T12:00:00.000Z",
    operation: "materializeSelection" as const,
    mode: "unstaged-working-tree" as const,
    unstaged: true as const,
    confirmed: true as const,
    allow_overwrite: false as const,
    commit_nonce_sha256: crypto.createHash("sha256").update(commitNonce).digest("hex"),
    commit_witness_device: "123",
    commit_witness_inode: "456",
    copies: [
      {
        source: "artifacts/node/output.sol",
        destination: "src/Output.sol",
        size_bytes: 12,
        sha256: "a".repeat(64)
      }
    ],
    patches: []
  };
}

function currentMaterializeCompletionRecord(intent: ReturnType<typeof currentMaterializeIntentRecord>) {
  return {
    ...currentMaterializeRecord(),
    audit_id: intent.intent_id,
    run_id: intent.run_id,
    timestamp: intent.timestamp,
    mode: "unstaged-working-tree" as const,
    confirmed: true,
    commit_nonce_sha256: intent.commit_nonce_sha256,
    commit_witness_device: intent.commit_witness_device,
    commit_witness_inode: intent.commit_witness_inode,
    copies: intent.copies
  };
}

function currentMaterializeCommitWitness(
  intent: ReturnType<typeof currentMaterializeIntentRecord>,
  completion: ReturnType<typeof currentMaterializeCompletionRecord>
) {
  return {
    schema_version: MATERIALIZE_COMMIT_WITNESS_SCHEMA_VERSION,
    witness_id: crypto.randomUUID(),
    audit_id: completion.audit_id,
    intent_id: intent.intent_id,
    run_id: completion.run_id,
    committed_at: "2026-08-16T00:00:00.000Z",
    commit_nonce: "b".repeat(64),
    commit_witness_device: intent.commit_witness_device,
    commit_witness_inode: intent.commit_witness_inode,
    intent_sha256: canonicalMaterializeRecordDigest(intent),
    completion_sha256: canonicalMaterializeRecordDigest(completion),
    copies_sha256: canonicalMaterializeRecordDigest(intent.copies)
  };
}
