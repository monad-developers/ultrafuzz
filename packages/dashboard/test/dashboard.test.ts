import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { initProject, WORKFLOW_CHECKPOINT_FRAME_MAX } from "@ultrafuzz/runtime";

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

test("dashboard replay and fork require a checkpoint frame and expose it in argv", async () => {
  const projectRoot = makeProject();
  const handle = await serveDashboard({ projectRoot, port: 0 });
  const postLifecycle = (command: "replay" | "fork", body: Record<string, unknown>) =>
    fetch(apiUrl(handle.url, `/api/commands/${command}`), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ultrafuzz-session": handle.sessionToken
      },
      body: JSON.stringify(body)
    });
  try {
    const missing = await postLifecycle("replay", { runId: "dashboard-frame-test" });
    assert.equal(missing.status, 400);
    assert.match(await missing.text(), /forkFrame must be a non-negative 32-bit integer/u);

    for (const forkFrame of [-1, 1.5, WORKFLOW_CHECKPOINT_FRAME_MAX + 1, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = await postLifecycle("replay", { forkFrame, runId: "dashboard-frame-test" });
      assert.equal(invalid.status, 400);
      assert.match(await invalid.text(), /forkFrame must be a non-negative 32-bit integer/u);
    }

    const maximum = await postLifecycle("replay", {
      forkFrame: WORKFLOW_CHECKPOINT_FRAME_MAX,
      runId: "dashboard-frame-test"
    });
    if (maximum.status !== 202) {
      assert.fail(await maximum.text());
    }
    const maximumJob = (await maximum.json()) as { argv: string[]; command: string };
    assert.deepEqual(maximumJob.argv, [
      "ultrafuzz",
      "replay",
      "dashboard-frame-test",
      "--frame",
      String(WORKFLOW_CHECKPOINT_FRAME_MAX),
      "--json"
    ]);

    for (const command of ["replay", "fork"] as const) {
      const accepted = await postLifecycle(command, { forkFrame: 12, runId: "dashboard-frame-test" });
      if (accepted.status !== 202) {
        assert.fail(await accepted.text());
      }
      const job = (await accepted.json()) as { argv: string[]; command: string };
      assert.equal(job.command, command);
      assert.deepEqual(job.argv, ["ultrafuzz", command, "dashboard-frame-test", "--frame", "12", "--json"]);
    }

    const populatedFork = await postLifecycle("fork", {
      forkFrame: 13,
      runId: "dashboard-frame-test",
      resetNode: "triage",
      label: "retry-triage",
      maxConcurrency: 4
    });
    if (populatedFork.status !== 202) {
      assert.fail(await populatedFork.text());
    }
    const populatedJob = (await populatedFork.json()) as { argv: string[]; command: string };
    assert.deepEqual(populatedJob.argv, [
      "ultrafuzz",
      "fork",
      "dashboard-frame-test",
      "--frame",
      "13",
      "--reset-node",
      "triage",
      "--label",
      "retry-triage",
      "--max-concurrency",
      "4",
      "--json"
    ]);

    for (const maxConcurrency of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = await postLifecycle("fork", {
        forkFrame: 13,
        runId: "dashboard-frame-test",
        maxConcurrency
      });
      assert.equal(invalid.status, 400);
      assert.match(await invalid.text(), /maxConcurrency must be a positive safe integer/u);
    }
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
      body: JSON.stringify({ content: "x".repeat(1024 * 1024) })
    });
    assert.equal(response.status, 413);
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
