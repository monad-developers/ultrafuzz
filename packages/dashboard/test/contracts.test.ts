import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseStrictJsonBytes } from "@ultrafuzz/artifacts";

import {
  appendDashboardAuditRecord,
  assertDashboardHttpDocument,
  assertDashboardSseDocument,
  DASHBOARD_AUDIT_SCHEMA_VERSION,
  DASHBOARD_HTTP_SCHEMA_VERSION,
  DASHBOARD_SSE_SCHEMA_VERSION,
  dashboardSchemaBundleDigest,
  dashboardSchemaRegistry,
  readDashboardAuditJournal,
  serializeDashboardHttpDocument,
  serializeDashboardSseDocument
} from "../src/index.js";

test("dashboard schemas are complete, closed, and reference only current composed schemas", () => {
  const registry = dashboardSchemaRegistry();
  assert.deepEqual(
    registry.map((entry) => entry.filename),
    ["dashboard-audit.schema.json", "dashboard-http.schema.json", "dashboard-sse.schema.json"]
  );
  assert.match(dashboardSchemaBundleDigest(), /^[a-f0-9]{64}$/u);
  assert.ok(registry.every((entry) => entry.schema.$schema === "https://json-schema.org/draft/2020-12/schema"));

  const references = registry.flatMap((entry) => entry.localReferences);
  assert.ok(references.some((reference) => reference.startsWith("urn:ultrafuzz:schema:artifacts:run-state:4#")));
  assert.equal(
    references.some((reference) => reference.includes("run-state:3")),
    false
  );

  const errorDocument = {
    schema_version: DASHBOARD_HTTP_SCHEMA_VERSION,
    document_type: "error",
    error: "example"
  };
  assert.doesNotThrow(() => assertDashboardHttpDocument(errorDocument, "errorResponse", "test error response"));
  assert.throws(
    () => assertDashboardHttpDocument({ ...errorDocument, schema_version: "1.0" }, "errorResponse", "legacy"),
    /schema_version const/u
  );
  assert.throws(
    () => assertDashboardHttpDocument({ ...errorDocument, legacy: true }, "errorResponse", "legacy"),
    /additionalProperties/u
  );
});

test("dashboard HTTP and SSE serializers validate the exact bytes they return", () => {
  const errorDocument = {
    schema_version: DASHBOARD_HTTP_SCHEMA_VERSION,
    document_type: "error",
    error: "example"
  };
  const httpBytes = serializeDashboardHttpDocument(errorDocument, "errorResponse");
  assert.equal(httpBytes.at(-1), 0x0a);
  const parsedHttp = parseStrictJsonBytes(httpBytes);
  assert.deepEqual(parsedHttp, errorDocument);
  assertDashboardHttpDocument(parsedHttp, "errorResponse", "serialized error response");
  assert.throws(
    () => serializeDashboardHttpDocument({ ...errorDocument, unknown: true }, "errorResponse"),
    /additionalProperties/u
  );
  assert.throws(() => serializeDashboardHttpDocument(undefined, "errorResponse"), /not JSON-serializable/u);

  const events = {
    schema_version: DASHBOARD_HTTP_SCHEMA_VERSION,
    document_type: "events",
    source: "none",
    events: [],
    malformed_records: 0,
    truncated_records: 0
  };
  const envelope = {
    schema_version: DASHBOARD_SSE_SCHEMA_VERSION,
    event_type: "ultrafuzz-event",
    sequence: 0,
    generated_at: "2026-08-09T12:00:00.000Z",
    payload: events
  };
  const sseJson = serializeDashboardSseDocument(envelope, "eventsEnvelope");
  assert.equal(sseJson.includes("\n"), false);
  const parsedSse = parseStrictJsonBytes(Buffer.from(sseJson, "utf8"));
  assert.deepEqual(parsedSse, envelope);
  assertDashboardSseDocument(parsedSse, "eventsEnvelope", "serialized events envelope");
  assert.throws(
    () => serializeDashboardSseDocument({ ...envelope, schema_version: "1.0" }, "eventsEnvelope"),
    /schema_version const/u
  );
  assert.throws(
    () => serializeDashboardSseDocument({ ...envelope, legacy: true }, "eventsEnvelope"),
    /additionalProperties/u
  );
});

test("dashboard audit journals reject malformed history without changing its bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-dashboard-contracts-"));
  const auditPath = path.join(root, "dashboard-audit.jsonl");
  appendDashboardAuditRecord(
    auditPath,
    {
      kind: "config-edit",
      path: "ultrafuzz.toml",
      content_hash: "a".repeat(64)
    },
    root
  );
  assert.equal(readDashboardAuditJournal(auditPath).records[0]?.schema_version, DASHBOARD_AUDIT_SCHEMA_VERSION);

  const malformedBytes = Buffer.from(
    `${JSON.stringify({
      schema_version: "1.0",
      audit_id: "00000000-0000-4000-8000-000000000001",
      timestamp: "2026-08-09T12:00:00.000Z",
      kind: "config-edit",
      path: "ultrafuzz.toml",
      content_hash: "b".repeat(64)
    })}\n`,
    "utf8"
  );
  fs.writeFileSync(auditPath, malformedBytes);
  assert.throws(() => readDashboardAuditJournal(auditPath), /schema_version/u);
  assert.throws(
    () =>
      appendDashboardAuditRecord(
        auditPath,
        {
          kind: "config-edit",
          path: "ultrafuzz.toml",
          content_hash: "c".repeat(64)
        },
        root
      ),
    /schema_version/u
  );
  assert.deepEqual(fs.readFileSync(auditPath), malformedBytes);
});
