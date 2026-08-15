import assert from "node:assert/strict";
import test from "node:test";

import {
  DASHBOARD_SSE_FRAME_MAX_BYTES,
  consumeAuthenticatedEventStream,
  parseSseFrame
} from "../frontend/src/authenticatedSse.js";

const SESSION_TOKEN = "b".repeat(64);

test("authenticated dashboard SSE sends the session header and parses chunked bounded frames", async () => {
  const observed: Array<{ input: URL | RequestInfo; init?: RequestInit }> = [];
  const chunks = ["event: first\r", "\ndata: alpha\r\n\r", "\nevent: second\ndata: beta\n\n"];
  const fetchImplementation = (async (input: URL | RequestInfo, init?: RequestInit) => {
    observed.push({ input, ...(init === undefined ? {} : { init }) });
    return new Response(streamResponse(chunks), {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" }
    });
  }) as typeof fetch;
  const events: Array<{ event: string; data: string }> = [];
  let opened = 0;

  await consumeAuthenticatedEventStream(
    "/api/events/stream",
    SESSION_TOKEN,
    new AbortController().signal,
    () => {
      opened += 1;
    },
    (event) => events.push(event),
    fetchImplementation
  );

  assert.equal(opened, 1);
  assert.deepEqual(events, [
    { event: "first", data: "alpha" },
    { event: "second", data: "beta" }
  ]);
  assert.equal(observed.length, 1);
  assert.equal(String(observed[0]!.input), "/api/events/stream");
  assert.equal(new Headers(observed[0]!.init?.headers).get("x-ultrafuzz-session"), SESSION_TOKEN);
  assert.equal(new Headers(observed[0]!.init?.headers).get("accept"), "text/event-stream");
  assert.equal(observed[0]!.init?.credentials, "same-origin");
  assert.equal(observed[0]!.init?.cache, "no-store");
});

test("authenticated dashboard SSE rejects non-event responses and oversized incomplete frames", async () => {
  const wrongContentType = (async () =>
    new Response("not an event stream", {
      status: 200,
      headers: { "content-type": "text/plain" }
    })) as typeof fetch;
  await assert.rejects(
    consumeAuthenticatedEventStream(
      "/api/events/stream",
      SESSION_TOKEN,
      new AbortController().signal,
      () => undefined,
      () => undefined,
      wrongContentType
    ),
    /unexpected content type/u
  );

  const oversized = (async () =>
    new Response(`data: ${"x".repeat(DASHBOARD_SSE_FRAME_MAX_BYTES + 1)}`, {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    })) as typeof fetch;
  await assert.rejects(
    consumeAuthenticatedEventStream(
      "/api/events/stream",
      SESSION_TOKEN,
      new AbortController().signal,
      () => undefined,
      () => undefined,
      oversized
    ),
    /frame exceeds the byte limit/u
  );
});

test("dashboard SSE frame parsing follows comments, default events, and multiline data", () => {
  assert.deepEqual(parseSseFrame(": keepalive\nevent: update\ndata: first\ndata: second"), {
    event: "update",
    data: "first\nsecond"
  });
  assert.deepEqual(parseSseFrame("data:value"), { event: "message", data: "value" });
  assert.equal(parseSseFrame(": keepalive"), null);
});

function streamResponse(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
}
