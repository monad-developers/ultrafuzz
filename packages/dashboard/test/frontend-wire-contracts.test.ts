import assert from "node:assert/strict";
import test from "node:test";

import {
  DASHBOARD_FRONTEND_JSON_MAX_BYTES,
  DASHBOARD_HTTP_SCHEMA_VERSION,
  DASHBOARD_SSE_SCHEMA_VERSION,
  dashboardCommandRequest,
  dashboardRequest,
  dashboardSseCommandJobs,
  dashboardSseErrorMessage,
  dashboardSseEvents,
  parseDashboardHttpDocument,
  parseDashboardHttpResponse,
  throwDashboardHttpError
} from "../frontend/src/wireContracts.js";

test("frontend HTTP readers strictly parse bounded current dashboard bytes", async () => {
  const valid = {
    schema_version: DASHBOARD_HTTP_SCHEMA_VERSION,
    document_type: "error",
    error: "example",
    correlationId: "00000000-0000-4000-8000-000000000001"
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

  assert.throws(
    () =>
      parseDashboardHttpDocument(
        {
          schema_version: DASHBOARD_HTTP_SCHEMA_VERSION,
          document_type: "flow",
          nodes: "not-an-array",
          edges: null,
          unexpected: true
        },
        "flow"
      ),
    /does not match its registered JSON Schema/u
  );
  assert.throws(
    () => parseDashboardHttpDocument({ ...valid, unexpected: true }, "error"),
    /does not match its registered JSON Schema/u
  );
});

test("frontend HTTP readers stop oversized response streams at the shared byte limit", async () => {
  const oversized = new Uint8Array(DASHBOARD_FRONTEND_JSON_MAX_BYTES + 1);
  oversized.fill(0x20);
  await assert.rejects(parseDashboardHttpResponse(byteResponse(oversized), "error"), /invalid strict JSON \(limit\)/u);
});

test("frontend request builders and non-success responses use the canonical HTTP schema", async () => {
  assert.deepEqual(
    dashboardRequest("config-save", {
      schema_version: "do-not-override",
      request_type: "topology-save",
      content: "example"
    }),
    {
      schema_version: DASHBOARD_HTTP_SCHEMA_VERSION,
      request_type: "config-save",
      content: "example"
    }
  );
  assert.throws(() => dashboardRequest("config-save", {}), /does not match its registered JSON Schema/u);
  assert.throws(
    () => dashboardCommandRequest("run", { maxConcurrency: 0 }),
    /does not match its registered JSON Schema/u
  );
  assert.deepEqual(
    dashboardRequest("csp-violation", {
      blockedURI: "data:image/svg+xml",
      violatedDirective: "img-src-elem",
      effectiveDirective: "img-src",
      disposition: "enforce"
    }),
    {
      schema_version: DASHBOARD_HTTP_SCHEMA_VERSION,
      request_type: "csp-violation",
      blockedURI: "data:image/svg+xml",
      violatedDirective: "img-src-elem",
      effectiveDirective: "img-src",
      disposition: "enforce"
    }
  );

  await assert.rejects(
    throwDashboardHttpError(
      jsonResponse(
        JSON.stringify({
          schema_version: DASHBOARD_HTTP_SCHEMA_VERSION,
          document_type: "error",
          error: "canonical failure",
          correlationId: "00000000-0000-4000-8000-000000000001"
        })
      )
    ),
    /canonical failure.*00000000-0000-4000-8000-000000000001/u
  );
  await assert.rejects(
    throwDashboardHttpError(jsonResponse("unbounded-do-not-echo")),
    redactedError(/invalid strict JSON \(syntax\)/u, "unbounded-do-not-echo")
  );
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

  const invalidEvents = JSON.stringify({
    ...eventsEnvelope,
    payload: { ...eventsEnvelope.payload, events: "not-an-array" }
  });
  assert.throws(() => dashboardSseEvents(invalidEvents), /does not match its registered JSON Schema/u);
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
  assert.throws(
    () => dashboardSseErrorMessage(unknownField),
    redactedError(/does not match its registered JSON Schema/u, "unknown-do-not-echo")
  );

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
