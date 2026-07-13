import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { initProject } from "@ultrafuzz/runtime";

import { serveDashboard } from "../src/index.js";

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
    const flow = await getJson<FlowResponse>(apiUrl(handle.url, "/api/flow"));
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
      body: JSON.stringify({
        content: "---\nid: added-check\ndisplay_name: Added check\n---\n\n# Added check\n",
        group: "strategies",
        dependsOn: []
      })
    });
    if (response.status !== 201) {
      assert.fail(await response.text());
    }
    const saved = (await response.json()) as { nodeId: string; path: string };
    assert.equal(saved.nodeId, "added-check");
    assert.equal(saved.path, ".ultrafuzz/prompts/strategies/added-check.md");
    assert.equal(
      fs.readFileSync(path.join(projectRoot, ".ultrafuzz", "prompts", "strategies", "added-check.md"), "utf8"),
      "---\nid: added-check\ndisplay_name: Added check\n---\n\n# Added check\n"
    );

    const topology = await getJson<TopologyResponse>(apiUrl(handle.url, "/api/topology"));
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
      body: JSON.stringify({ content: "unknown_key = true\n" })
    });
    assert.equal(denied.status, 401);

    const invalid = await fetch(apiUrl(handle.url, "/api/config"), {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-ultrafuzz-session": handle.sessionToken
      },
      body: JSON.stringify({ content: "unknown_key = true\n" })
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

test("dashboard responses set browser security headers", async () => {
  const projectRoot = makeProject();
  const handle = await serveDashboard({ projectRoot, port: 0 });
  try {
    const response = await fetch(apiUrl(handle.url, "/api/session"));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/u);
    assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'self'/u);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  } finally {
    await handle.close();
  }
});

test("dashboard rejects oversized JSON bodies", async () => {
  const projectRoot = makeProject();
  const handle = await serveDashboard({ projectRoot, port: 0 });
  try {
    const response = await fetch(apiUrl(handle.url, "/api/config"), {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-ultrafuzz-session": handle.sessionToken
      },
      body: JSON.stringify({ content: "x".repeat(1024 * 1024) })
    });
    assert.equal(response.status, 413);
  } finally {
    await handle.close();
  }
});

test("unexpected dashboard errors use a correlation ID and a redacted audit record", async () => {
  const projectRoot = makeProject();
  const handle = await serveDashboard({ projectRoot, port: 0 });
  try {
    const response = await fetch(apiUrl(handle.url, "/api/prompts/strategies/%E0%A4%A"));
    assert.equal(response.status, 500);
    const body = (await response.json()) as { error?: string; error_id?: string };
    assert.equal(body.error, "internal dashboard error");
    assert.match(body.error_id ?? "", /^[0-9a-f-]{36}$/u);
    const audit = fs.readFileSync(path.join(projectRoot, ".ultrafuzz", "dashboard-audit.jsonl"), "utf8");
    assert.match(audit, new RegExp(body.error_id ?? "missing"));
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

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    assert.fail(await response.text());
  }
  return (await response.json()) as T;
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
