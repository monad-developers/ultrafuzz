import { dashboardAuthenticatedHeaders } from "./dashboardSession.js";

export const DASHBOARD_SSE_FRAME_MAX_BYTES = 16 * 1024 * 1024;
const textEncoder = new TextEncoder();

export interface DashboardSseMessage {
  event: string;
  data: string;
}

export interface AuthenticatedEventStreamOptions {
  url: string;
  sessionToken: string;
  onOpen: () => void;
  onEvent: (message: DashboardSseMessage) => void;
  onError: (error: Error) => void;
  retryMilliseconds?: number;
  fetchImplementation?: typeof fetch;
}

export interface AuthenticatedEventStream {
  close: () => void;
}

/** Fetch-based SSE transport: unlike EventSource, this sends the session token
 * in a request header and never places credentials in a URL. */
export function connectAuthenticatedEventStream(options: AuthenticatedEventStreamOptions): AuthenticatedEventStream {
  const controller = new AbortController();
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const retryMilliseconds = options.retryMilliseconds ?? 1000;

  const run = async () => {
    while (!controller.signal.aborted) {
      try {
        await consumeAuthenticatedEventStream(
          options.url,
          options.sessionToken,
          controller.signal,
          options.onOpen,
          options.onEvent,
          fetchImplementation
        );
        if (!controller.signal.aborted) throw new Error("Dashboard event stream ended unexpectedly.");
      } catch (error) {
        if (controller.signal.aborted) return;
        options.onError(error instanceof Error ? error : new Error("Dashboard event stream failed."));
        await waitForRetry(retryMilliseconds, controller.signal);
      }
    }
  };
  run().catch((error) => {
    if (!controller.signal.aborted) {
      options.onError(error instanceof Error ? error : new Error("Dashboard event stream failed."));
    }
  });
  return { close: () => controller.abort() };
}

export async function consumeAuthenticatedEventStream(
  url: string,
  sessionToken: string,
  signal: AbortSignal,
  onOpen: () => void,
  onEvent: (message: DashboardSseMessage) => void,
  fetchImplementation: typeof fetch = fetch
): Promise<void> {
  const response = await fetchImplementation(url, {
    method: "GET",
    headers: dashboardAuthenticatedHeaders(sessionToken, { accept: "text/event-stream" }),
    cache: "no-store",
    credentials: "same-origin",
    signal
  });
  if (!response.ok) throw new Error(`Dashboard event stream returned HTTP ${response.status}.`);
  if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/event-stream")) {
    throw new Error("Dashboard event stream returned an unexpected content type.");
  }
  if (response.body === null) throw new Error("Dashboard event stream returned no body.");
  onOpen();

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      buffered += decoder.decode(next.value, { stream: true });
      let boundary = findSseBoundary(buffered);
      while (boundary !== null) {
        const frame = buffered.slice(0, boundary.index);
        assertSseFrameSize(frame);
        buffered = buffered.slice(boundary.index + boundary.length);
        const message = parseSseFrame(frame);
        if (message !== null) onEvent(message);
        boundary = findSseBoundary(buffered);
      }
      assertSseFrameSize(buffered);
    }
    buffered += decoder.decode();
    assertSseFrameSize(buffered);
    if (buffered.trim() !== "") {
      const message = parseSseFrame(buffered);
      if (message !== null) onEvent(message);
    }
  } finally {
    reader.releaseLock();
  }
}

export function parseSseFrame(frame: string): DashboardSseMessage | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.replace(/\r\n?|\n/gu, "\n").split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const rawValue = separator === -1 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
  return data.length === 0 ? null : { event, data: data.join("\n") };
}

function findSseBoundary(value: string): { index: number; length: number } | null {
  const candidates = ["\r\n\r\n", "\n\n", "\r\r"]
    .map((separator) => ({ index: value.indexOf(separator), length: separator.length }))
    .filter((candidate) => candidate.index >= 0)
    .sort((left, right) => left.index - right.index || right.length - left.length);
  return candidates[0] ?? null;
}

function assertSseFrameSize(value: string): void {
  if (textEncoder.encode(value).byteLength > DASHBOARD_SSE_FRAME_MAX_BYTES) {
    throw new Error("Dashboard event stream frame exceeds the byte limit.");
  }
}

function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
