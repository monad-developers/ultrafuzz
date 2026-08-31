import assert from "node:assert/strict";
import { temporaryRoot } from "./temporary-root.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  appendCleanAuditRecord,
  appendMaterializeAuditRecord,
  CLEAN_AUDIT_SCHEMA_VERSION,
  MATERIALIZE_AUDIT_SCHEMA_VERSION,
  parseCleanAuditRecord,
  parseMaterializeAuditRecord,
  readCleanAuditJournal,
  readMaterializeAuditJournal,
  runtimeSchemaRegistry
} from "../src/index.js";

test("runtime audit schemas are closed, registered, and enforce exact current versions", () => {
  assert.deepEqual(
    runtimeSchemaRegistry().map((entry) => entry.filename),
    [
      "clean-audit.schema.json",
      "cloud-execution-generation.schema.json",
      "data-disclosure-acknowledgements.schema.json",
      "data-governance-policy.schema.json",
      "invariant-suite-baseline.schema.json",
      "invariant-suite-handoff.schema.json",
      "invariant-workspace-snapshot.schema.json",
      "materialize-audit.schema.json",
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
});

test("runtime audit journals validate immutable complete history before append", () => {
  const root = temporaryRoot("ufz-runtime-audits-");
  const cleanPath = path.join(root, "clean-audit.jsonl");
  const materializePath = path.join(root, "materialize-audit.jsonl");
  const clean = currentCleanRecord();
  const materialize = currentMaterializeRecord();

  appendCleanAuditRecord(cleanPath, clean, root);
  appendMaterializeAuditRecord(materializePath, materialize, root);
  assert.deepEqual(readCleanAuditJournal(cleanPath).records, [clean]);
  assert.deepEqual(readMaterializeAuditJournal(materializePath).records, [materialize]);

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
    confirmed: true,
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
