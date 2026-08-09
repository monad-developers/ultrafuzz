import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseStrictJsonBytes } from "@ultrafuzz/artifacts";

import {
  appendDashboardAuditRecord,
  assertDashboardHttpDocument,
  assertDashboardJsonSchema,
  assertDashboardSseDocument,
  DASHBOARD_AUDIT_SCHEMA_VERSION,
  DASHBOARD_HTTP_JSON_SCHEMA_ID,
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
  assert.deepEqual(
    registry.flatMap((entry) => arraysWithoutItemSchemas(entry.schema, entry.filename)),
    []
  );

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

  const promptSave = {
    schema_version: DASHBOARD_HTTP_SCHEMA_VERSION,
    document_type: "prompt-save",
    strategyId: "project-discovery",
    nodeId: "project-discovery",
    path: ".ultrafuzz/prompts/setup/project-discovery.md",
    contentHash: "a".repeat(64),
    validation: { valid: true, message: "prompt validates" }
  };
  assert.doesNotThrow(() => assertDashboardHttpDocument(promptSave, "promptSaveResponse", "prompt save"));
  assert.throws(
    () =>
      assertDashboardHttpDocument(
        { ...promptSave, renamedFrom: "legacy-node" },
        "promptSaveResponse",
        "legacy prompt save"
      ),
    /additionalProperties/u
  );
});

test("dashboard exposes only the bounded operator-defined JSON extension point", () => {
  const registry = dashboardSchemaRegistry();
  const httpSchema = registry.find((entry) => entry.filename === "dashboard-http.schema.json")?.schema as
    { $defs?: Record<string, unknown> } | undefined;
  assert.ok(httpSchema?.$defs);
  assert.equal(Object.prototype.hasOwnProperty.call(httpSchema.$defs, "jsonValue"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(httpSchema.$defs, "operatorWorkflowInput"), true);

  const textPreview = {
    logicalNodeId: "project-discovery",
    concreteNodeId: "project-discovery",
    path: "artifacts/project-discovery/report.md",
    state: "available",
    content: { kind: "markdown", text: "# Report" }
  };
  assert.doesNotThrow(() =>
    assertDashboardJsonSchema(
      `${DASHBOARD_HTTP_JSON_SCHEMA_ID}#/$defs/artifactPreview`,
      textPreview,
      "text artifact preview"
    )
  );
  assert.throws(
    () =>
      assertDashboardJsonSchema(
        `${DASHBOARD_HTTP_JSON_SCHEMA_ID}#/$defs/artifactPreview`,
        { ...textPreview, content: { kind: "json", json: { previously: "opaque" } } },
        "obsolete JSON artifact preview"
      ),
    /kind enum|additionalProperties|required/u
  );

  const availability = {
    logs: false,
    renderedPrompt: false,
    findings: false,
    patch: false,
    report: false,
    metadata: false
  };
  assert.doesNotThrow(() =>
    assertDashboardJsonSchema(
      `${DASHBOARD_HTTP_JSON_SCHEMA_ID}#/$defs/artifactAvailability`,
      availability,
      "artifact availability"
    )
  );
  assert.throws(
    () =>
      assertDashboardJsonSchema(
        `${DASHBOARD_HTTP_JSON_SCHEMA_ID}#/$defs/artifactAvailability`,
        { ...availability, transcript: true },
        "obsolete transcript availability"
      ),
    /additionalProperties/u
  );

  const runRequest = {
    schema_version: DASHBOARD_HTTP_SCHEMA_VERSION,
    request_type: "command",
    command: "run",
    arguments: {
      workflowInput: {
        applicationDefined: [null, true, 7, "value", { nested: [false] }]
      }
    }
  };
  assert.doesNotThrow(() => assertDashboardHttpDocument(runRequest, "commandRequest", "operator workflow input"));
  assert.throws(
    () =>
      assertDashboardHttpDocument(
        { ...runRequest, arguments: { ...runRequest.arguments, historicalInput: {} } },
        "commandRequest",
        "unknown run argument"
      ),
    /additionalProperties|anyOf/u
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

function arraysWithoutItemSchemas(value: unknown, path: string): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => arraysWithoutItemSchemas(entry, `${path}/${index}`));
  }
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const current =
    record.type === "array" && !("items" in record) && !("prefixItems" in record)
      ? [`${path}: array schema has no items or prefixItems`]
      : [];
  return [
    ...current,
    ...Object.entries(record).flatMap(([key, entry]) => arraysWithoutItemSchemas(entry, `${path}/${key}`))
  ];
}
