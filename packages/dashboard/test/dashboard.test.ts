import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { initProject, planRun } from "@ultrafuzz/runtime";

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

test("API requests require a Host header", async () => {
  const projectRoot = makeProject();
  const handle = await serveDashboard({ projectRoot, port: 0 });
  try {
    const status = await requestStatusWithoutHost(apiUrl(handle.url, "/api/session"));
    assert.equal(status, 403);
  } finally {
    await handle.close();
  }
});

test("redacts node evidence before serving it", async () => {
  const projectRoot = makeProject();
  const planned = await planRun({ projectRoot, runId: "redacted-node-evidence", env: {} });
  assert.equal(planned.ok, true, JSON.stringify(planned.diagnostics));
  const attempt = planned.value!.expanded_graph.nodes.find((node) => node.kind === "agentic");
  assert.ok(attempt);
  const artifactDir = path.join(planned.value!.run_root, attempt.artifactDir);
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "stdout.log"), "stdout api_key=sk-dashboardstdout\n", "utf8");
  fs.writeFileSync(path.join(artifactDir, "stderr.log"), "Bearer sk-dashboardstderr\n", "utf8");
  fs.writeFileSync(path.join(artifactDir, "prompt.rendered.md"), "prompt token=sk-dashboardprompt\n", "utf8");
  fs.writeFileSync(
    path.join(artifactDir, "transcript.json"),
    JSON.stringify({ api_key: "sk-dashboardtranscript", message: "token=sk-dashboardmessage" }),
    "utf8"
  );

  const handle = await serveDashboard({ projectRoot, port: 0, runId: "redacted-node-evidence" });
  try {
    const detail = await getJson<{
      stdout?: string;
      stderr?: string;
      rendered_prompt?: string;
      transcript?: { api_key?: string; message?: string };
    }>(apiUrl(handle.url, `/api/nodes/${attempt.logicalId}`));
    assert.equal(detail.stdout, "stdout api_key=<redacted>\n");
    assert.equal(detail.stderr, "Bearer <redacted>\n");
    assert.equal(detail.rendered_prompt, "prompt token=<redacted>\n");
    assert.deepEqual(detail.transcript, { api_key: "<redacted>", message: "token=<redacted>" });
    assert.doesNotMatch(JSON.stringify(detail), /sk-dashboard/);
  } finally {
    await handle.close();
  }
});

test("audit logging refuses a final-component symlink", async () => {
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
      body: JSON.stringify({ content: config })
    });
    assert.equal(response.status, 500);
    assert.equal(fs.readFileSync(outsidePath, "utf8"), "sentinel\n");
    assert.equal(fs.lstatSync(auditPath).isSymbolicLink(), true);
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

function requestStatusWithoutHost(url: string): Promise<number> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    let response = "";
    const socket = net.createConnection({ host: parsed.hostname, port: Number(parsed.port) }, () => {
      socket.write(`GET ${parsed.pathname}${parsed.search} HTTP/1.0\r\n\r\n`);
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => {
      const status = /^HTTP\/\d\.\d (\d{3})/u.exec(response)?.[1];
      resolve(status === undefined ? 0 : Number(status));
    });
  });
}
