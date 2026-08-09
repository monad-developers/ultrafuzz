import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseStrictJsonBytes } from "@ultrafuzz/artifacts";
import { initProject } from "@ultrafuzz/runtime";

import {
  assertDashboardHttpDocument,
  assertDashboardSseDocument,
  DASHBOARD_HTTP_SCHEMA_VERSION,
  serveDashboard,
  type DashboardHttpDefinition,
  type DashboardSseDefinition
} from "../src/index.js";

interface FlowResponse {
  run: {
    run_id: string;
    expanded_nodes: number;
  };
  nodes: Array<{
    id: string;
    data: {
      logicalNodeId: string;
    };
  }>;
  capabilities: Record<string, boolean>;
}

interface TopologyResponse {
  topology: {
    nodes: Array<{
      id: string;
      depends_on?: string[];
      prompt?: string;
    }>;
  };
}

test("serves logical topology flow with expanded attempt details", async () => {
  const projectRoot = makeProject();
  const handle = await serveDashboard({ projectRoot, port: 0 });
  try {
    const flow = await getJson<FlowResponse>(apiUrl(handle.url, "/api/flow"), "flowResponse");
    assert.equal(flow.run.run_id, "preview");
    assert.ok(flow.nodes.length > 0);
    assert.ok(flow.run.expanded_nodes > flow.nodes.length);
    assert.ok(flow.nodes.every((node) => node.id === node.data.logicalNodeId));
    assert.equal(flow.capabilities.runNewCampaign, true);
    assert.equal(flow.capabilities.referencesStatus, true);
    assert.equal(flow.capabilities.doctor, false);
    assert.equal(flow.capabilities.merge, false);
  } finally {
    await handle.close();
  }
});

test("does not replace a malformed present topology with an empty preview", async () => {
  const projectRoot = makeProject();
  fs.writeFileSync(path.join(projectRoot, ".ultrafuzz", "topology.yml"), "version: [\n", "utf8");
  const handle = await serveDashboard({ projectRoot, port: 0 });
  try {
    const response = await fetch(apiUrl(handle.url, "/api/flow"));
    assert.equal(response.status, 500);
    assert.match(await response.text(), /topology/u);
  } finally {
    await handle.close();
  }
});

test("creates a topology node prompt as terminal work before finish", async () => {
  const projectRoot = makeProject();
  const handle = await serveDashboard({ projectRoot, port: 0 });
  try {
    const response = await fetch(apiUrl(handle.url, "/api/prompts/nodes"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ultrafuzz-session": handle.sessionToken
      },
      body: JSON.stringify(
        dashboardRequest("prompt-create", {
          content: "---\nid: added-check\ndisplay_name: Added check\n---\n\n# Added check\n",
          group: "strategies",
          dependsOn: []
        })
      )
    });
    if (response.status !== 201) {
      assert.fail(await response.text());
    }
    const saved = await parseHttpResponse(response, "promptSaveResponse");
    assert.equal(saved.nodeId, "added-check");
    assert.equal(saved.path, ".ultrafuzz/prompts/strategies/added-check.md");
    assert.equal(
      fs.readFileSync(path.join(projectRoot, ".ultrafuzz", "prompts", "strategies", "added-check.md"), "utf8"),
      "---\nid: added-check\ndisplay_name: Added check\n---\n\n# Added check\n"
    );

    const topology = await getJson<TopologyResponse>(apiUrl(handle.url, "/api/topology"), "topologyDetailResponse");
    const added = topology.topology.nodes.find((node) => node.id === "added-check");
    const finish = topology.topology.nodes.find((node) => node.id === "__finish__");
    assert.deepEqual(added?.depends_on, ["__start__"]);
    assert.equal(added?.prompt, "strategies/added-check.md");
    assert.ok(finish?.depends_on?.includes("added-check"));
  } finally {
    await handle.close();
  }
});

test("mutating APIs require the session token and reject invalid saves without writes", async () => {
  const projectRoot = makeProject();
  const configPath = path.join(projectRoot, "ultrafuzz.toml");
  const originalConfig = fs.readFileSync(configPath, "utf8");
  const handle = await serveDashboard({ projectRoot, port: 0 });
  try {
    const denied = await fetch(apiUrl(handle.url, "/api/config"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(dashboardRequest("config-save", { content: "unknown_key = true\n" }))
    });
    assert.equal(denied.status, 401);

    const invalid = await fetch(apiUrl(handle.url, "/api/config"), {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-ultrafuzz-session": handle.sessionToken
      },
      body: JSON.stringify(dashboardRequest("config-save", { content: "unknown_key = true\n" }))
    });
    assert.equal(invalid.status, 400);
    assert.equal(fs.readFileSync(configPath, "utf8"), originalConfig);
  } finally {
    await handle.close();
  }
});

test("API requests reject non-loopback host headers", async () => {
  const projectRoot = makeProject();
  const handle = await serveDashboard({ projectRoot, port: 0 });
  try {
    const status = await requestStatusWithHost(apiUrl(handle.url, "/api/session"), "example.com");
    assert.equal(status, 403);
  } finally {
    await handle.close();
  }
});

test("dashboard serves external theme bootstrap with restrictive security and cache headers", async () => {
  const projectRoot = makeProject();
  const testPublicRoot = path.join(process.cwd(), "dist-test", "src", "public");
  fs.cpSync(path.join(process.cwd(), "dist", "public"), testPublicRoot, { recursive: true });
  const handle = await serveDashboard({ projectRoot, port: 0 });
  try {
    const documentResponse = await fetch(handle.url);
    assert.equal(documentResponse.status, 200);
    const documentBody = await documentResponse.text();
    const csp = documentResponse.headers.get("content-security-policy") ?? "";
    const scriptPolicy = csp.split(";").find((directive) => directive.trim().startsWith("script-src")) ?? "";
    assert.match(scriptPolicy, /script-src 'self'/u);
    assert.doesNotMatch(scriptPolicy, /'unsafe-inline'/u);
    assert.match(csp, /frame-ancestors 'none'/u);
    assert.equal(documentResponse.headers.get("x-content-type-options"), "nosniff");
    assert.equal(documentResponse.headers.get("x-frame-options"), "DENY");
    assert.equal(documentResponse.headers.get("referrer-policy"), "no-referrer");
    assert.equal(documentResponse.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(documentResponse.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/u.test(documentBody), false);

    const iconSource = /<link[^>]+rel="icon"[^>]+href="([^"]+)"/u.exec(documentBody)?.[1];
    assert.equal(iconSource, "/dashboard/favicon.svg");
    const iconResponse = await fetch(new URL(iconSource, handle.url));
    assert.equal(iconResponse.status, 200);
    assert.equal(iconResponse.headers.get("content-type"), "image/svg+xml");
    assert.match(await iconResponse.text(), /fill="#6E55FF"/u);

    const scriptSource = /<script[^>]+src="([^"]+)"/u.exec(documentBody)?.[1];
    assert.ok(scriptSource);
    const scriptResponse = await fetch(new URL(scriptSource, handle.url));
    assert.equal(scriptResponse.status, 200);
    assert.equal(scriptResponse.headers.get("cache-control"), "no-cache");
    await scriptResponse.body?.cancel();

    const apiResponse = await fetch(apiUrl(handle.url, "/api/session"));
    assert.equal(apiResponse.status, 200);
    assert.equal(apiResponse.headers.get("x-content-type-options"), "nosniff");
  } finally {
    await handle.close();
    fs.rmSync(testPublicRoot, { recursive: true, force: true });
  }
});

test("dashboard rejects oversized JSON request bodies", async () => {
  const projectRoot = makeProject();
  const handle = await serveDashboard({ projectRoot, port: 0 });
  try {
    const response = await fetch(apiUrl(handle.url, "/api/config"), {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-ultrafuzz-session": handle.sessionToken
      },
      body: JSON.stringify(dashboardRequest("config-save", { content: "x".repeat(1024 * 1024) }))
    });
    assert.equal(response.status, 413);
  } finally {
    await handle.close();
  }
});

test("dashboard rejects duplicate JSON request keys before handling a mutation", async () => {
  const projectRoot = makeProject();
  const configPath = path.join(projectRoot, "ultrafuzz.toml");
  const originalConfig = fs.readFileSync(configPath, "utf8");
  const handle = await serveDashboard({ projectRoot, port: 0 });
  try {
    const response = await fetch(apiUrl(handle.url, "/api/config"), {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-ultrafuzz-session": handle.sessionToken
      },
      body: `{"schema_version":"${DASHBOARD_HTTP_SCHEMA_VERSION}","request_type":"config-save","content":"project_name = \\"first\\"\\n","content":"project_name = \\"second\\"\\n"}`
    });
    assert.equal(response.status, 400);
    assert.equal(fs.readFileSync(configPath, "utf8"), originalConfig);
  } finally {
    await handle.close();
  }
});

test("dashboard stops reading an oversized unfinished chunked body", async () => {
  const projectRoot = makeProject();
  const handle = await serveDashboard({ projectRoot, port: 0 });
  let request: http.ClientRequest | undefined;
  let timeout: NodeJS.Timeout | undefined;
  try {
    const parsed = new URL(apiUrl(handle.url, "/api/config"));
    const responsePromise = new Promise<{ connection?: string; status: number }>((resolve, reject) => {
      request = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname,
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "x-ultrafuzz-session": handle.sessionToken
          }
        },
        (response) => {
          response.resume();
          response.on("error", reject);
          response.on("end", () => {
            resolve({
              connection: response.headers.connection,
              status: response.statusCode ?? 0
            });
          });
        }
      );
      request.on("error", reject);
      request.write(Buffer.alloc(1024 * 1024, "x"));
      request.write("x");
    });
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("server kept draining the unfinished request body")), 5000);
    });

    const response = await Promise.race([responsePromise, timeoutPromise]);
    assert.equal(response.status, 413);
    assert.equal(response.connection, "close");
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    request?.destroy();
    await handle.close();
  }
});

test("dashboard audit append refuses a final-component symlink", async () => {
  const projectRoot = makeProject();
  const auditPath = path.join(projectRoot, ".ultrafuzz", "dashboard-audit.jsonl");
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-dashboard-audit-"));
  const outsidePath = path.join(outsideDir, "outside.log");
  fs.writeFileSync(outsidePath, "sentinel\n", "utf8");
  fs.symlinkSync(outsidePath, auditPath, "file");
  const config = fs.readFileSync(path.join(projectRoot, "ultrafuzz.toml"), "utf8");

  const handle = await serveDashboard({ projectRoot, port: 0 });
  try {
    const response = await fetch(apiUrl(handle.url, "/api/config"), {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-ultrafuzz-session": handle.sessionToken
      },
      body: JSON.stringify(dashboardRequest("config-save", { content: config }))
    });
    assert.equal(response.status, 500);
    assert.equal(fs.readFileSync(outsidePath, "utf8"), "sentinel\n");
    assert.equal(fs.lstatSync(auditPath).isSymbolicLink(), true);
  } finally {
    await handle.close();
  }
});

test("dashboard validates the serialized bytes and identities of every preview API document", async () => {
  const projectRoot = makeProject();
  const handle = await serveDashboard({ projectRoot, port: 0 });
  try {
    const routes: Array<[string, DashboardHttpDefinition, string]> = [
      ["/api/session", "sessionResponse", "session"],
      ["/api/flow", "flowResponse", "flow"],
      ["/api/run", "runOverviewResponse", "run-overview"],
      ["/api/graph", "graphResponse", "graph"],
      ["/api/nodes", "nodesResponse", "nodes"],
      ["/api/nodes/project-discovery", "nodeDetailResponse", "node-detail"],
      ["/api/findings", "findingsResponse", "findings"],
      ["/api/report", "reportResponse", "report"],
      ["/api/events", "eventsResponse", "events"],
      ["/api/config", "configDetailResponse", "config-detail"],
      ["/api/topology", "topologyDetailResponse", "topology-detail"],
      ["/api/prompts/strategies", "promptListResponse", "prompt-list"],
      ["/api/prompts/nodes/project-discovery", "promptDetailResponse", "prompt-detail"]
    ];
    for (const [route, definition, documentType] of routes) {
      const response = await fetch(apiUrl(handle.url, route));
      assert.equal(response.status, 200, route);
      const document = await parseHttpResponse(response, definition);
      assert.equal(document.schema_version, DASHBOARD_HTTP_SCHEMA_VERSION, route);
      assert.equal(document.document_type, documentType, route);
    }

    const missing = await fetch(apiUrl(handle.url, "/api/not-a-route"));
    assert.equal(missing.status, 404);
    const error = await parseHttpResponse(missing, "errorResponse");
    assert.equal(error.document_type, "error");
  } finally {
    await handle.close();
  }
});

test("dashboard emits typed SSE envelopes with monotonic per-stream sequences", async () => {
  const projectRoot = makeProject();
  const handle = await serveDashboard({ projectRoot, port: 0 });
  try {
    const eventFrames = await readSseFrames(apiUrl(handle.url, "/api/events/stream"), 1);
    assertSseFrame(eventFrames[0]!, "eventsEnvelope", "ultrafuzz-event", 0);

    const commandFrames = await readSseFrames(apiUrl(handle.url, "/api/commands/stream"), 2);
    assertSseFrame(commandFrames[0]!, "commandJobsEnvelope", "ultrafuzz-command-jobs", 0);
    assertSseFrame(commandFrames[1]!, "commandJobsEnvelope", "ultrafuzz-command-jobs", 1);
  } finally {
    await handle.close();
  }
});

test("dashboard refuses malformed historical audit data before changing project files", async () => {
  const projectRoot = makeProject();
  const configPath = path.join(projectRoot, "ultrafuzz.toml");
  const auditPath = path.join(projectRoot, ".ultrafuzz", "dashboard-audit.jsonl");
  const originalConfig = fs.readFileSync(configPath);
  const malformedAudit = Buffer.from(
    '{"schema_version":"1.0","audit_id":"00000000-0000-4000-8000-000000000001","timestamp":"2026-08-09T12:00:00.000Z","kind":"config-edit","path":"ultrafuzz.toml","content_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\n',
    "utf8"
  );
  fs.writeFileSync(auditPath, malformedAudit);

  const handle = await serveDashboard({ projectRoot, port: 0 });
  try {
    const response = await fetch(apiUrl(handle.url, "/api/config"), {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-ultrafuzz-session": handle.sessionToken
      },
      body: JSON.stringify(
        dashboardRequest("config-save", { content: `${originalConfig.toString("utf8")}\n# proposed change\n` })
      )
    });
    assert.equal(response.status, 500);
    await parseHttpResponse(response, "errorResponse");
    assert.deepEqual(fs.readFileSync(configPath), originalConfig);
    assert.deepEqual(fs.readFileSync(auditPath), malformedAudit);
  } finally {
    await handle.close();
  }
});

function makeProject(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-dashboard-"));
  const result = initProject({ projectRoot, force: true });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return projectRoot;
}

async function getJson<T>(url: string, definition: DashboardHttpDefinition): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    assert.fail(await response.text());
  }
  return (await parseHttpResponse(response, definition)) as T;
}

async function parseHttpResponse(
  response: Response,
  definition: DashboardHttpDefinition
): Promise<Record<string, unknown>> {
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("content-length"), String(bytes.byteLength));
  const document = parseStrictJsonBytes(bytes);
  assertDashboardHttpDocument(document, definition, `HTTP ${definition} bytes`);
  assert.ok(isRecord(document));
  return document;
}

interface SseFrame {
  event: string;
  data: string;
}

async function readSseFrames(url: string, count: number): Promise<SseFrame[]> {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let pending = "";
  try {
    while (frames.length < count) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, "SSE stream ended before the expected frames arrived");
      pending += decoder.decode(chunk.value, { stream: true });
      let boundary = pending.indexOf("\n\n");
      while (boundary >= 0) {
        const block = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        if (!block.startsWith(":")) {
          const event = block
            .split("\n")
            .find((line) => line.startsWith("event: "))
            ?.slice("event: ".length);
          const data = block
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice("data: ".length);
          assert.ok(event);
          assert.ok(data);
          frames.push({ event, data });
          if (frames.length === count) break;
        }
        boundary = pending.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel();
  }
  return frames;
}

function assertSseFrame(
  frame: SseFrame,
  definition: DashboardSseDefinition,
  eventType: string,
  sequence: number
): void {
  assert.equal(frame.event, eventType);
  const document = parseStrictJsonBytes(Buffer.from(frame.data, "utf8"));
  assertDashboardSseDocument(document, definition, `SSE ${definition} bytes`);
  assert.ok(isRecord(document));
  assert.equal(document.event_type, eventType);
  assert.equal(document.sequence, sequence);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dashboardRequest(requestType: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: DASHBOARD_HTTP_SCHEMA_VERSION,
    request_type: requestType,
    ...fields
  };
}

function apiUrl(dashboardUrl: string, apiPath: string): string {
  return dashboardUrl.replace(/\/dashboard$/u, apiPath);
}

function requestStatusWithHost(url: string, host: string): Promise<number> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers: { host }
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      }
    );
    request.on("error", reject);
    request.end();
  });
}
