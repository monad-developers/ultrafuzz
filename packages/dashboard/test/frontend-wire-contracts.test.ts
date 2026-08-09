import assert from "node:assert/strict";
import test from "node:test";

import {
  DASHBOARD_FRONTEND_JSON_MAX_BYTES,
  DASHBOARD_HTTP_SCHEMA_VERSION,
  DASHBOARD_SSE_SCHEMA_VERSION,
  dashboardSseCommandJobs,
  dashboardSseErrorMessage,
  dashboardSseEvents,
  parseDashboardHttpResponse
} from "../frontend/src/wireContracts.js";

test("frontend HTTP readers strictly parse bounded current dashboard bytes", async () => {
  const valid = {
    schema_version: DASHBOARD_HTTP_SCHEMA_VERSION,
    document_type: "error",
    error: "example"
  };
  assert.deepEqual(await parseDashboardHttpResponse(jsonResponse(JSON.stringify(valid)), "error"), valid);

  await assert.rejects(
    parseDashboardHttpResponse(
      jsonResponse(
        `{"schema_version":"${DASHBOARD_HTTP_SCHEMA_VERSION}","schema_version":"do-not-echo","document_type":"error","error":"example"}`
      ),
      "error"
    ),
    redactedError(/duplicate-key/u, "do-not-echo")
  );
  await assert.rejects(
    parseDashboardHttpResponse(byteResponse(Uint8Array.of(0x7b, 0xff, 0x7d)), "error"),
    /invalid strict JSON \(encoding\)/u
  );
  await assert.rejects(
    parseDashboardHttpResponse(jsonResponse('{"error":"syntax-do-not-echo"'), "error"),
    redactedError(/invalid strict JSON \(syntax\)/u, "syntax-do-not-echo")
  );
  await assert.rejects(parseDashboardHttpResponse(new Response(null), "error"), /invalid strict JSON \(syntax\)/u);
  await assert.rejects(
    parseDashboardHttpResponse(
      jsonResponse(JSON.stringify({ ...valid, schema_version: "unsupported-do-not-echo" })),
      "error"
    ),
    redactedError(/unsupported schema version/u, "unsupported-do-not-echo")
  );
});

test("frontend HTTP readers stop oversized response streams at the shared byte limit", async () => {
  const oversized = new Uint8Array(DASHBOARD_FRONTEND_JSON_MAX_BYTES + 1);
  oversized.fill(0x20);
  await assert.rejects(parseDashboardHttpResponse(byteResponse(oversized), "error"), /invalid strict JSON \(limit\)/u);
});

test("frontend SSE readers accept each current envelope and reject duplicate keys at any depth", () => {
  const eventsEnvelope = {
    schema_version: DASHBOARD_SSE_SCHEMA_VERSION,
    event_type: "ultrafuzz-event",
    sequence: 0,
    generated_at: "2026-08-09T00:00:00.000Z",
    payload: {
      schema_version: DASHBOARD_HTTP_SCHEMA_VERSION,
      document_type: "events",
      source: "none",
      events: [],
      malformed_records: 0,
      truncated_records: 0
    }
  };
  assert.deepEqual(dashboardSseEvents(JSON.stringify(eventsEnvelope)), eventsEnvelope.payload);

  const errorEnvelope = {
    schema_version: DASHBOARD_SSE_SCHEMA_VERSION,
    event_type: "ultrafuzz-error",
    sequence: 1,
    generated_at: "2026-08-09T00:00:01.000Z",
    payload: { message: "example" }
  };
  assert.equal(dashboardSseErrorMessage(JSON.stringify(errorEnvelope)), "example");

  const commandEnvelope = {
    schema_version: DASHBOARD_SSE_SCHEMA_VERSION,
    event_type: "ultrafuzz-command-jobs",
    sequence: 2,
    generated_at: "2026-08-09T00:00:02.000Z",
    payload: {
      jobs: [
        {
          schema_version: DASHBOARD_HTTP_SCHEMA_VERSION,
          document_type: "command-job",
          jobId: "job-example-0123abcd",
          command: "ps",
          status: "running",
          startedAtUnixSeconds: 1,
          argv: ["ultrafuzz", "ps", "--json"],
          output: ""
        }
      ]
    }
  };
  assert.deepEqual(dashboardSseCommandJobs(JSON.stringify(commandEnvelope)), commandEnvelope.payload.jobs);

  const duplicateEnvelope = JSON.stringify(eventsEnvelope).replace(
    `"schema_version":"${DASHBOARD_SSE_SCHEMA_VERSION}"`,
    `"schema_version":"${DASHBOARD_SSE_SCHEMA_VERSION}","schema_version":"do-not-echo"`
  );
  assert.throws(() => dashboardSseEvents(duplicateEnvelope), redactedError(/duplicate-key/u, "do-not-echo"));

  const duplicateJob = JSON.stringify(commandEnvelope).replace(
    '"status":"running"',
    '"status":"running","status":"do-not-echo"'
  );
  assert.throws(() => dashboardSseCommandJobs(duplicateJob), redactedError(/duplicate-key/u, "do-not-echo"));
});

test("frontend SSE failures are bounded and do not echo rejected values or fields", () => {
  assert.throws(
    () => dashboardSseErrorMessage('{"payload":"syntax-do-not-echo"'),
    redactedError(/invalid strict JSON \(syntax\)/u, "syntax-do-not-echo")
  );

  const unsupported = JSON.stringify({
    schema_version: "unsupported-do-not-echo",
    event_type: "ultrafuzz-error",
    sequence: 0,
    generated_at: "2026-08-09T00:00:00.000Z",
    payload: { message: "example" }
  });
  assert.throws(
    () => dashboardSseErrorMessage(unsupported),
    redactedError(/unsupported schema version/u, "unsupported-do-not-echo")
  );

  const unknownField = JSON.stringify({
    schema_version: DASHBOARD_SSE_SCHEMA_VERSION,
    event_type: "ultrafuzz-error",
    sequence: 0,
    generated_at: "2026-08-09T00:00:00.000Z",
    "unknown-do-not-echo": true,
    payload: { message: "example" }
  });
  assert.throws(() => dashboardSseErrorMessage(unknownField), redactedError(/1 unknown field/u, "unknown-do-not-echo"));

  const tooDeep = `${"[".repeat(130)}null${"]".repeat(130)}`;
  assert.throws(() => dashboardSseErrorMessage(tooDeep), /invalid strict JSON \(limit\)/u);
});

function jsonResponse(serialized: string): Response {
  return new Response(serialized, { headers: { "content-type": "application/json" } });
}

function byteResponse(bytes: Uint8Array): Response {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Response(copy.buffer, { headers: { "content-type": "application/json" } });
}

function redactedError(pattern: RegExp, forbidden: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof Error);
    assert.match(error.message, pattern);
    assert.equal(error.message.includes(forbidden), false);
    assert.ok(error.message.length < 256);
    return true;
  };
}
