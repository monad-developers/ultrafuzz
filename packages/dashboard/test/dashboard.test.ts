import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ARTIFACT_VERIFICATION_SCHEMA_VERSION,
  createEventRecord,
  parseStrictJsonBytes,
  readRunState,
  sha256Bytes,
  updateNodeState,
  writeArtifactManifest,
  writeFileDurable,
  writeJsonDurable,
  type ArtifactVerificationMarker,
  type PlannedGraphNodeDocument,
  type RunLayout
} from "@ultrafuzz/artifacts";
import {
  initProject,
  loadVerifiedRunOutputAuthoritySnapshot,
  planRun,
  projectCanonicalFinalReport,
  sealWorkflowControlFiles
} from "@ultrafuzz/runtime";

import {
  assertDashboardHttpDocument,
  assertDashboardSseDocument,
  dashboardFlowAuthorityProjection,
  DASHBOARD_HTTP_SCHEMA_VERSION,
  readDashboardAuditJournal,
  serveDashboard,
  verifiedDeclaredFindingsFromAuthoritySnapshot,
  type DashboardHttpDefinition,
  type DashboardServerDiagnostic,
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
      artifacts?: Record<string, boolean>;
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

interface DashboardTestHandle {
  url: string;
  sessionToken: string;
}

test("serves logical topology flow with expanded attempt details", async () => {
  const projectRoot = makeProject();
  const handle = await serveDashboard({ projectRoot, port: 0 });
  try {
    const flow = await getJson<FlowResponse>(handle, "/api/flow", "flowResponse");
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
  const diagnostics: DashboardServerDiagnostic[] = [];
  const handle = await serveDashboard({ projectRoot, port: 0, onDiagnostic: (entry) => diagnostics.push(entry) });
  try {
    const response = await dashboardFetch(handle, "/api/flow");
    assert.equal(response.status, 500);
    await assertGenericUnexpectedError(response, diagnostics, /topology/u);
  } finally {
    await handle.close();
  }
});

test("dashboard preview binds confirmation to the comprehensive runtime launch review", async () => {
  const projectRoot = makeProject();
  writeSmallTopology(projectRoot);
  const fakeRunner = fakeDashboardSmithersEnv(projectRoot);
  const runId = "dashboard-reviewed-launch";
  const handle = await serveDashboard({ projectRoot, port: 0, env: fakeRunner.env });
  const commandRequest = (argumentsValue: Record<string, unknown>) =>
    dashboardRequest("command", { command: "run", arguments: argumentsValue });
  const post = (route: string, argumentsValue: Record<string, unknown>) =>
    fetch(apiUrl(handle.url, route), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ultrafuzz-session": handle.sessionToken
      },
      body: JSON.stringify(commandRequest(argumentsValue))
    });
  try {
    const unconfirmed = await post("/api/commands/run", { runId });
    assert.equal(unconfirmed.status, 400);
    assert.match(String((await parseHttpResponse(unconfirmed, "errorResponse")).error), /explicit pre-launch/u);

    const previewResponse = await post("/api/commands/run/preview", { runId, maxConcurrency: 2 });
    if (previewResponse.status !== 200) assert.fail(await previewResponse.text());
    const preview = await parseHttpResponse(previewResponse, "launchPreviewResponse");
    assert.equal(preview.document_type, "launch-preview");
    assert.equal(preview.reviewRequired, true);
    assert.match(String(preview.confirmationDigest), /^[a-f0-9]{64}$/u);
    const review = preview.review as Record<string, unknown>;
    assert.equal(review.schema_version, "ultrafuzz.launch-review.v1");
    for (const field of ["config_fingerprint", "prompt_digest", "topology_digest", "controller_source_digest"]) {
      assert.match(String(review[field]), /^[a-f0-9]{64}$/u, field);
    }
    assert.equal(fs.existsSync(path.join(projectRoot, ".ultrafuzz", "runs", runId)), false);
    assert.equal(fs.existsSync(fakeRunner.logPath), false);

    fs.appendFileSync(
      path.join(projectRoot, ".ultrafuzz", "prompts", "setup", "project-discovery.md"),
      "\nDashboard launch review changed.\n",
      "utf8"
    );
    const stale = await post("/api/commands/run", {
      runId,
      maxConcurrency: 2,
      confirmed: true,
      confirmationDigest: preview.confirmationDigest
    });
    assert.equal(stale.status, 409);
    assert.match(String((await parseHttpResponse(stale, "errorResponse")).error), /stale/u);
    assert.equal(fs.existsSync(path.join(projectRoot, ".ultrafuzz", "runs", runId)), false);
    assert.equal(fs.existsSync(fakeRunner.logPath), false);

    const currentPreviewResponse = await post("/api/commands/run/preview", { runId, maxConcurrency: 2 });
    if (currentPreviewResponse.status !== 200) assert.fail(await currentPreviewResponse.text());
    const currentPreview = await parseHttpResponse(currentPreviewResponse, "launchPreviewResponse");
    assert.notEqual(currentPreview.confirmationDigest, preview.confirmationDigest);
    const accepted = await post("/api/commands/run", {
      runId,
      maxConcurrency: 2,
      confirmed: true,
      confirmationDigest: currentPreview.confirmationDigest
    });
    if (accepted.status !== 202) assert.fail(await accepted.text());
    const job = await parseHttpResponse(accepted, "commandJobResponse");
    assert.equal(typeof job.jobId, "string");
    await waitForFile(fakeRunner.logPath);
    const completed = await waitForDashboardCommand(handle, String(job.jobId));
    assert.equal(completed.status, "succeeded", JSON.stringify(completed));
    assert.equal(fs.existsSync(path.join(projectRoot, ".ultrafuzz", "runs", runId)), true);
    assert.match(fs.readFileSync(fakeRunner.logPath, "utf8"), /up .*ultrafuzz-dashboard-reviewed-launch\.tsx/u);
  } finally {
    await handle.close();
  }
});

test("creates a topology node prompt as terminal work before finish", async () => {
  const projectRoot = makeProject();
  const prompt =
    "---\nid: added-check\ndisplay_name: Added check\n---\n\n# Added check\n\n" +
    "{{finding_reachability_vocabulary}}\n\n{{finding_note_key_vocabulary}}\n";
  const handle = await serveDashboard({ projectRoot, port: 0 });
  try {
    const response = await dashboardFetch(handle, "/api/prompts/nodes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ultrafuzz-session": handle.sessionToken
      },
      body: JSON.stringify(
        dashboardRequest("prompt-create", {
          content: prompt,
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
      prompt
    );

    const topology = await getJson<TopologyResponse>(handle, "/api/topology", "topologyDetailResponse");
    const added = topology.topology.nodes.find((node) => node.id === "added-check");
    const finish = topology.topology.nodes.find((node) => node.id === "__finish__");
    assert.deepEqual(added?.depends_on, ["__start__"]);
    assert.equal(added?.prompt, "strategies/added-check.md");
    assert.ok(finish?.depends_on?.includes("added-check"));
  } finally {
    await handle.close();
  }
});

test("rejects prompt identity changes instead of converting them into topology renames", async () => {
  const projectRoot = makeProject();
  const promptPath = path.join(projectRoot, ".ultrafuzz", "prompts", "setup", "project-discovery.md");
  const topologyPath = path.join(projectRoot, ".ultrafuzz", "topology.yml");
  const originalPrompt = fs.readFileSync(promptPath);
  const originalTopology = fs.readFileSync(topologyPath);
  const handle = await serveDashboard({ projectRoot, port: 0 });
  try {
    const response = await dashboardFetch(handle, "/api/prompts/nodes/project-discovery", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-ultrafuzz-session": handle.sessionToken
      },
      body: JSON.stringify(
        dashboardRequest("prompt-save", {
          content: "---\nid: renamed-project-discovery\ndisplay_name: Renamed\n---\n\n# Renamed\n"
        })
      )
    });
    assert.equal(response.status, 400);
    await parseHttpResponse(response, "errorResponse");
    assert.deepEqual(fs.readFileSync(promptPath), originalPrompt);
    assert.deepEqual(fs.readFileSync(topologyPath), originalTopology);
    assert.equal(
      fs.existsSync(path.join(projectRoot, ".ultrafuzz", "prompts", "setup", "renamed-project-discovery.md")),
      false
    );
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

    const invalid = await dashboardFetch(handle, "/api/config", {
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

test("every dashboard API read, mutation, job route, unknown route, and SSE stream requires the session token", async () => {
  const projectRoot = makeProject();
  const handle = await serveDashboard({ projectRoot, port: 0 });
  try {
    const cases: Array<{ path: string; init?: RequestInit }> = [
      { path: "/api" },
      { path: "/api/session" },
      { path: "/api/flow" },
      {
        path: "/api/config",
        init: {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(dashboardRequest("config-save", { content: "" }))
        }
      },
      { path: "/api/commands/missing-job" },
      { path: "/api/not-a-route" },
      { path: "/api/events/stream", init: { headers: { accept: "text/event-stream" } } },
      { path: "/api/commands/stream", init: { headers: { accept: "text/event-stream" } } }
    ];
    for (const entry of cases) {
      const response = await fetch(apiUrl(handle.url, entry.path), entry.init);
      assert.equal(response.status, 401, entry.path);
      const error = await parseHttpResponse(response, "errorResponse");
      assert.match(String(error.error), /session token/u, entry.path);
      assert.match(String(error.correlationId), /^[a-f0-9-]{36}$/u, entry.path);
    }
  } finally {
    await handle.close();
  }
});

test("dashboard session credentials are disclosed only through the launch fragment", async () => {
  const projectRoot = makeProject();
  const handle = await serveDashboard({ projectRoot, port: 0 });
  try {
    const launchUrl = new URL(handle.url);
    assert.equal(launchUrl.pathname, "/dashboard");
    assert.equal(launchUrl.search, "");
    assert.equal(new URLSearchParams(launchUrl.hash.slice(1)).get("session"), handle.sessionToken);
    assert.doesNotMatch(launchUrl.origin + launchUrl.pathname + launchUrl.search, new RegExp(handle.sessionToken, "u"));

    const response = await dashboardFetch(handle, "/api/session");
    const bytes = await response.clone().text();
    assert.doesNotMatch(bytes, new RegExp(handle.sessionToken, "u"));
    const session = await parseHttpResponse(response, "sessionResponse");
    assert.equal(Object.prototype.hasOwnProperty.call(session, "sessionToken"), false);
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
    const malformed = await requestStatusWithHost(apiUrl(handle.url, "/api/session"), "127.0.0.1:");
    assert.equal(malformed, 403);
  } finally {
    await handle.close();
  }
});

test("dashboard request provenance fails closed for missing Host, invalid Origin, and non-same-origin fetches", async () => {
  const projectRoot = makeProject();
  const handle = await serveDashboard({ projectRoot, port: 0 });
  try {
    assert.equal(
      await requestStatusWithoutHost(apiUrl(handle.url, "/api/session"), {
        "x-ultrafuzz-session": handle.sessionToken
      }),
      403
    );
    for (const origin of ["https://127.0.0.1", "http://example.com", "not-an-origin"]) {
      assert.equal(
        await requestStatus(apiUrl(handle.url, "/api/session"), {
          headers: { origin, "x-ultrafuzz-session": handle.sessionToken }
        }),
        403,
        origin
      );
    }
    for (const fetchSite of ["same-site", "cross-site"]) {
      assert.equal(
        await requestStatus(apiUrl(handle.url, "/api/session"), {
          headers: { "sec-fetch-site": fetchSite, "x-ultrafuzz-session": handle.sessionToken }
        }),
        403,
        fetchSite
      );
    }

    const parsed = new URL(handle.url);
    assert.equal(
      await requestStatus(apiUrl(handle.url, "/api/session"), {
        headers: {
          origin: parsed.origin,
          "sec-fetch-site": "same-origin",
          "x-ultrafuzz-session": handle.sessionToken
        }
      }),
      200
    );
  } finally {
    await handle.close();
  }
});

test("dashboard redacts stdout, stderr, and rendered prompts before publishing node evidence", async () => {
  const projectRoot = makeProject();
  writeSmallTopology(projectRoot);
  const runId = "dashboard-redaction";
  const plan = await planRun({ projectRoot, runId, env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  assert.ok(plan.value);
  const attempt = plan.value.expanded_graph.nodes.find((node) => node.logicalId === "project-discovery");
  assert.ok(attempt);
  const artifactDir = path.join(plan.value.layout.root, attempt.artifactDir);
  const secret = "dashboard-secret-value-12345";
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "stdout.log"), `stdout ${secret}\n`, "utf8");
  fs.writeFileSync(path.join(artifactDir, "stderr.log"), `stderr ${secret}\n`, "utf8");
  fs.writeFileSync(path.join(artifactDir, "prompt.rendered.md"), `prompt ${secret}\n`, "utf8");

  const handle = await serveDashboard({
    projectRoot,
    runId,
    port: 0,
    env: { DASHBOARD_TEST_SECRET: secret }
  });
  try {
    const response = await dashboardFetch(handle, "/api/nodes/project-discovery");
    const serialized = await response.clone().text();
    assert.doesNotMatch(serialized, new RegExp(secret, "u"));
    const node = await parseHttpResponse(response, "nodeDetailResponse");
    assert.match(String(node.stdout), /stdout <redacted>/u);
    assert.match(String(node.stderr), /stderr <redacted>/u);
    assert.match(String(node.rendered_prompt), /prompt <redacted>/u);
    assert.match(fs.readFileSync(path.join(artifactDir, "stdout.log"), "utf8"), new RegExp(secret, "u"));
  } finally {
    await handle.close();
  }
});

test("unexpected dashboard failures return a correlation ID while server diagnostics are redacted", async () => {
  const projectRoot = makeProject();
  const secret = path.basename(projectRoot);
  fs.writeFileSync(path.join(projectRoot, ".ultrafuzz", "topology.yml"), "version: [\n", "utf8");
  const diagnostics: DashboardServerDiagnostic[] = [];
  const handle = await serveDashboard({
    projectRoot,
    port: 0,
    env: { DASHBOARD_TEST_SECRET: secret },
    onDiagnostic: (entry) => diagnostics.push(entry)
  });
  try {
    const response = await dashboardFetch(handle, "/api/flow");
    assert.equal(response.status, 500);
    await assertGenericUnexpectedError(response, diagnostics, /<redacted>/u);
    assert.equal(diagnostics.length, 1);
    assert.doesNotMatch(diagnostics[0]!.message, new RegExp(secret, "u"));
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
    assert.match(csp, /img-src 'self'/u);
    assert.doesNotMatch(csp, /img-src[^;]*data:/u);
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

    const apiResponse = await dashboardFetch(handle, "/api/session");
    assert.equal(apiResponse.status, 200);
    assert.equal(apiResponse.headers.get("x-content-type-options"), "nosniff");
  } finally {
    await handle.close();
    fs.rmSync(testPublicRoot, { recursive: true, force: true });
  }
});

test("dashboard records authenticated CSP violations for development and CI visibility", async () => {
  const projectRoot = makeProject();
  const secret = "csp-secret-value-12345";
  const diagnostics: DashboardServerDiagnostic[] = [];
  const handle = await serveDashboard({
    projectRoot,
    port: 0,
    env: { DASHBOARD_CSP_SECRET: secret },
    onDiagnostic: (entry) => diagnostics.push(entry)
  });
  try {
    const response = await dashboardFetch(handle, "/api/csp-violations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        dashboardRequest("csp-violation", {
          blockedURI: `https://example.invalid/${secret}`,
          violatedDirective: "img-src-elem",
          effectiveDirective: "img-src",
          sourceFile: `http://127.0.0.1/dashboard/${secret}`,
          lineNumber: 12,
          columnNumber: 34,
          disposition: "enforce"
        })
      )
    });
    assert.equal(response.status, 202);
    const reported = await parseHttpResponse(response, "cspViolationsResponse");
    assert.ok(Array.isArray(reported.violations));
    const violation = reported.violations[0] as Record<string, unknown>;
    assert.equal(violation.blockedURI, "https://example.invalid/<redacted>");
    assert.equal(violation.sourceFile, "http://127.0.0.1/dashboard/<redacted>");
    assert.equal(violation.effectiveDirective, "img-src");
    assert.equal(violation.lineNumber, 12);
    assert.match(String(violation.correlationId), /^[a-f0-9-]{36}$/u);

    const visible = await getJson<{ violations: unknown[] }>(handle, "/api/csp-violations", "cspViolationsResponse");
    assert.deepEqual(visible.violations, reported.violations);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]!.kind, "csp-violation");
    assert.equal(diagnostics[0]!.correlationId, violation.correlationId);
    assert.doesNotMatch(diagnostics[0]!.message, new RegExp(secret, "u"));
    assert.match(diagnostics[0]!.message, /<redacted>/u);
  } finally {
    await handle.close();
  }
});

test("dashboard run launch requires a matching preview confirmation and appends an audit record", async () => {
  const projectRoot = makeProject();
  const handle = await serveDashboard({ projectRoot, port: 0 });
  try {
    const commandRequest = (argumentsValue: Record<string, unknown>) =>
      dashboardRequest("command", { command: "run", arguments: argumentsValue });
    const unconfirmed = await dashboardFetch(handle, "/api/commands/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(commandRequest({}))
    });
    assert.equal(unconfirmed.status, 400);
    assert.match(String((await parseHttpResponse(unconfirmed, "errorResponse")).error), /explicit pre-launch/u);

    const previewResponse = await dashboardFetch(handle, "/api/commands/run/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(commandRequest({ maxConcurrency: 2 }))
    });
    assert.equal(previewResponse.status, 200);
    const preview = await parseHttpResponse(previewResponse, "launchPreviewResponse");
    assert.equal(preview.document_type, "launch-preview");
    assert.equal(typeof preview.target, "string");
    assert.ok(Array.isArray(preview.providers));
    assert.ok(preview.providers.length > 0);
    assert.equal((preview.configuredBudget as Record<string, unknown>).maxParallelAgents, 2);
    assert.match(String(preview.confirmationDigest), /^[a-f0-9]{64}$/u);

    const configPath = path.join(projectRoot, "ultrafuzz.toml");
    const confirmedConfig = fs.readFileSync(configPath, "utf8");
    const changedConfig = confirmedConfig.replace(
      "controller_lease_seconds = 30",
      "controller_lease_seconds = 30\nmax_parallel_nodes = 7"
    );
    assert.notEqual(changedConfig, confirmedConfig);
    fs.writeFileSync(configPath, changedConfig, "utf8");
    const changedAfterPreview = await dashboardFetch(handle, "/api/commands/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        commandRequest({ confirmed: true, confirmationDigest: preview.confirmationDigest, maxConcurrency: 2 })
      )
    });
    assert.equal(changedAfterPreview.status, 409);
    fs.writeFileSync(configPath, confirmedConfig, "utf8");

    const stale = await dashboardFetch(handle, "/api/commands/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(commandRequest({ confirmed: true, confirmationDigest: "0".repeat(64), maxConcurrency: 2 }))
    });
    assert.equal(stale.status, 409);
    assert.match(String((await parseHttpResponse(stale, "errorResponse")).error), /stale|does not match/u);

    const accepted = await dashboardFetch(handle, "/api/commands/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        commandRequest({
          confirmed: true,
          confirmationDigest: preview.confirmationDigest,
          maxConcurrency: 2
        })
      )
    });
    assert.equal(accepted.status, 202, await accepted.text());

    const auditPath = path.join(projectRoot, ".ultrafuzz", "dashboard-audit.jsonl");
    const audit = await waitForDashboardAuditRecord(auditPath, "run-launch");
    const launch = audit.records.at(-1);
    assert.equal(launch?.kind, "run-launch");
    if (launch?.kind !== "run-launch") assert.fail("expected a run-launch audit record");
    assert.equal(launch.target, preview.target);
    assert.deepEqual(launch.providers, preview.providers);
    assert.equal(launch.configured_budget.max_parallel_agents, 2);
    assert.equal(launch.confirmation_digest, preview.confirmationDigest);
  } finally {
    await handle.close();
  }
});

test("dashboard rejects oversized JSON request bodies", async () => {
  const projectRoot = makeProject();
  const handle = await serveDashboard({ projectRoot, port: 0 });
  try {
    const response = await dashboardFetch(handle, "/api/config", {
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
    const response = await dashboardFetch(handle, "/api/config", {
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
    const response = await dashboardFetch(handle, "/api/config", {
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
      ["/api/csp-violations", "cspViolationsResponse", "csp-violations"],
      ["/api/config", "configDetailResponse", "config-detail"],
      ["/api/topology", "topologyDetailResponse", "topology-detail"],
      ["/api/prompts/strategies", "promptListResponse", "prompt-list"],
      ["/api/prompts/nodes/project-discovery", "promptDetailResponse", "prompt-detail"]
    ];
    for (const [route, definition, documentType] of routes) {
      const response = await dashboardFetch(handle, route);
      if (response.status !== 200) assert.fail(`${route}: ${await response.text()}`);
      const document = await parseHttpResponse(response, definition);
      assert.equal(document.schema_version, DASHBOARD_HTTP_SCHEMA_VERSION, route);
      assert.equal(document.document_type, documentType, route);
    }

    const missing = await dashboardFetch(handle, "/api/not-a-route");
    assert.equal(missing.status, 404);
    const error = await parseHttpResponse(missing, "errorResponse");
    assert.equal(error.document_type, "error");
  } finally {
    await handle.close();
  }
});

test("dashboard validates persisted run-state v5 documents through the composed schema registry", async () => {
  const projectRoot = makeProject();
  writeSmallTopology(projectRoot);
  const runId = "dashboard-persisted";
  const plan = await planRun({ projectRoot, runId, env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  const artifactDir = path.join(plan.value!.run_root, "artifacts", "project-discovery");
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "transcript.json"), '{"provider":"unowned"}\n', "utf8");
  const handle = await serveDashboard({ projectRoot, runId, port: 0 });
  try {
    const routes: Array<[string, DashboardHttpDefinition, string]> = [
      ["/api/run", "runOverviewResponse", "run-overview"],
      ["/api/flow", "flowResponse", "flow"],
      ["/api/nodes/project-discovery", "nodeDetailResponse", "node-detail"],
      ["/api/events", "eventsResponse", "events"]
    ];
    for (const [route, definition, documentType] of routes) {
      const response = await dashboardFetch(handle, route);
      if (response.status !== 200) assert.fail(`${route}: ${await response.text()}`);
      const document = await parseHttpResponse(response, definition);
      assert.equal(document.schema_version, DASHBOARD_HTTP_SCHEMA_VERSION, route);
      assert.equal(document.document_type, documentType, route);
      if (definition === "nodeDetailResponse") {
        assert.equal(Object.prototype.hasOwnProperty.call(document, "transcript"), false);
        assert.throws(
          () =>
            assertDashboardHttpDocument(
              { ...document, transcript: { previously: "opaque" } },
              "nodeDetailResponse",
              "obsolete transcript response"
            ),
          /additionalProperties/u
        );
      }
    }
  } finally {
    await handle.close();
  }
});

test("dashboard events returns one captured journal epoch when the path is replaced after its snapshot", async (t) => {
  const projectRoot = makeProject();
  writeSmallTopology(projectRoot);
  const runId = "dashboard-event-snapshot";
  const plan = await planRun({ projectRoot, runId, env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  assert.ok(plan.value);

  const first = createEventRecord(plan.value.layout, {
    eventType: "node-synced",
    nodeId: "project-discovery",
    status: "running",
    timestamp: "2026-08-10T00:00:00.000Z",
    payload: { workflow_run_id: "workflow-1", workflow_task_id: "task-1" }
  });
  const second = createEventRecord(plan.value.layout, {
    eventType: "node-synced",
    nodeId: "project-discovery",
    status: "succeeded",
    timestamp: "2026-08-10T00:00:01.000Z",
    payload: { workflow_run_id: "workflow-1", workflow_task_id: "task-1" }
  });
  fs.writeFileSync(plan.value.layout.eventsPath, `${JSON.stringify(first)}\n`, "utf8");
  const replacementPath = path.join(plan.value.layout.root, "events.replacement.jsonl");
  fs.writeFileSync(replacementPath, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`, "utf8");

  const originalOpenSync = fs.openSync;
  const originalCloseSync = fs.closeSync;
  const eventDescriptors = new Set<number>();
  let eventJournalOpens = 0;
  let replaced = false;
  t.mock.method(fs, "openSync", ((...args: Parameters<typeof fs.openSync>) => {
    const descriptor = Reflect.apply(originalOpenSync, fs, args) as number;
    if (args[0] === plan.value!.layout.eventsPath) {
      eventJournalOpens += 1;
      eventDescriptors.add(descriptor);
    }
    return descriptor;
  }) as typeof fs.openSync);
  t.mock.method(fs, "closeSync", ((descriptor: number) => {
    const closesEventJournal = eventDescriptors.delete(descriptor);
    const result = originalCloseSync(descriptor);
    if (closesEventJournal && !replaced) {
      fs.renameSync(replacementPath, plan.value!.layout.eventsPath);
      replaced = true;
    }
    return result;
  }) as typeof fs.closeSync);

  const handle = await serveDashboard({ projectRoot, runId, port: 0 });
  try {
    const events = await getJson<{
      events: Array<{ event_id: string }>;
      malformed_records: number;
      truncated_records: number;
    }>(handle, "/api/events", "eventsResponse");
    assert.equal(replaced, true);
    assert.equal(eventJournalOpens, 1);
    assert.deepEqual(
      events.events.map((event) => event.event_id),
      [first.event_id]
    );
    assert.equal(events.malformed_records, 0);
    assert.equal(events.truncated_records, 0);
    assert.equal(
      fs.readFileSync(plan.value.layout.eventsPath, "utf8"),
      `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`
    );
  } finally {
    await handle.close();
  }
});

test("dashboard discovers verified findings from exact renamed graph declarations and ignores wrong-contract lookalikes", async () => {
  const fixture = await createDashboardFindingsFixture({ includeWrongContractLookalike: true });
  updateNodeState(fixture.layout, fixture.attemptId, { outputs: undefined });
  const handle = await serveDashboard({ projectRoot: fixture.projectRoot, runId: fixture.runId, port: 0 });
  try {
    const findings = await getJson<{ source: string; findings: unknown[] }>(
      handle,
      "/api/findings",
      "findingsResponse"
    );
    assert.equal(findings.source, `artifacts/${fixture.attemptId}/custom/nested/review-findings.json`);
    assert.deepEqual(findings.findings, [fixture.finding]);

    const node = await getJson<{ findings: unknown[] }>(handle, "/api/nodes/renamed-review", "nodeDetailResponse");
    assert.deepEqual(node.findings, [fixture.finding]);
  } finally {
    await handle.close();
  }
});

test("dashboard fails closed when run-state outputs disagree with a planned findings declaration", async () => {
  const fixture = await createDashboardFindingsFixture({ includeWrongContractLookalike: true });
  const textOutput = fixture.node.outputs.find((output) => output.contract === "ultrafuzz/text@1");
  assert.ok(textOutput);
  updateNodeState(fixture.layout, fixture.attemptId, { outputs: [{ ...textOutput, primary: true }] });

  const diagnostics: DashboardServerDiagnostic[] = [];
  const handle = await serveDashboard({
    projectRoot: fixture.projectRoot,
    runId: fixture.runId,
    port: 0,
    onDiagnostic: (entry) => diagnostics.push(entry)
  });
  try {
    const response = await dashboardFetch(handle, "/api/findings");
    assert.equal(response.status, 500);
    await assertGenericUnexpectedError(
      response,
      diagnostics,
      /run-state output contracts do not match the current planned node/u
    );
  } finally {
    await handle.close();
  }
});

test("dashboard rejects duplicate typed findings declarations on one planned producer", async () => {
  const fixture = await createDashboardFindingsFixture({ duplicateFindingsDeclaration: true });
  const diagnostics: DashboardServerDiagnostic[] = [];
  const handle = await serveDashboard({
    projectRoot: fixture.projectRoot,
    runId: fixture.runId,
    port: 0,
    onDiagnostic: (entry) => diagnostics.push(entry)
  });
  try {
    const response = await dashboardFetch(handle, "/api/findings");
    assert.equal(response.status, 500);
    await assertGenericUnexpectedError(response, diagnostics, /declares 2 ultrafuzz\/findings@2 outputs/u);
  } finally {
    await handle.close();
  }
});

test("dashboard prefers a completed declared report over raw findings without a lifecycle-ledger sibling", async () => {
  const fixture = await createDashboardFindingsFixture({ includeFinalReport: true, emptyFindings: true });
  assert.ok(fixture.reportAttemptId);
  const handle = await serveDashboard({ projectRoot: fixture.projectRoot, runId: fixture.runId, port: 0 });
  try {
    const findings = await getJson<{ source: string; findings: unknown[] }>(
      handle,
      "/api/findings",
      "findingsResponse"
    );
    assert.equal(findings.source, `artifacts/${fixture.reportAttemptId}/deliverables/current-report.json`);
    assert.deepEqual(findings.findings, []);

    const report = await getJson<{
      markdown_path: string;
      json_path: string;
      markdown: string;
      json: unknown;
    }>(handle, "/api/report", "reportResponse");
    assert.equal(report.markdown_path, `artifacts/${fixture.reportAttemptId}/deliverables/current-report.md`);
    assert.equal(report.json_path, `artifacts/${fixture.reportAttemptId}/deliverables/current-report.json`);
    assert.match(report.markdown, /^# Ultrafuzz report/mu);
    assert.ok(report.json);

    const flow = await getJson<FlowResponse>(handle, "/api/flow", "flowResponse");
    const reportNode = flow.nodes.find((node) => node.id === "summary-review");
    assert.equal(reportNode?.data.artifacts?.report, true);
    assert.equal(reportNode?.data.artifacts?.findings, true);
  } finally {
    await handle.close();
  }
});

test("dashboard does not hide unavailable custom report authority after the renamed producer claims success", async () => {
  const fixture = await createDashboardFindingsFixture({ includeFinalReport: true, emptyFindings: true });
  assert.ok(fixture.reportAttemptId);
  const reportDir = path.join(fixture.layout.artifactsDir, fixture.reportAttemptId, "deliverables");
  fs.rmSync(path.join(reportDir, "current-report.md"));
  fs.rmSync(path.join(reportDir, "current-report.json"));
  updateNodeState(fixture.layout, fixture.reportAttemptId, { provenance: undefined });

  const diagnostics: DashboardServerDiagnostic[] = [];
  const handle = await serveDashboard({
    projectRoot: fixture.projectRoot,
    runId: fixture.runId,
    port: 0,
    onDiagnostic: (entry) => diagnostics.push(entry)
  });
  try {
    const response = await dashboardFetch(handle, "/api/report");
    assert.equal(response.status, 500);
    await assertGenericUnexpectedError(
      response,
      diagnostics,
      /claims succeeded without complete current verification\/finalization authority/iu
    );
  } finally {
    await handle.close();
  }
});

test("dashboard report rejects malformed present task-manifest and control-seal authority", async () => {
  const fixture = await createDashboardFindingsFixture({ includeFinalReport: true, emptyFindings: true });
  const handle = await serveDashboard({ projectRoot: fixture.projectRoot, runId: fixture.runId, port: 0 });
  try {
    const valid = await dashboardFetch(handle, "/api/report");
    assert.equal(valid.status, 200, await valid.text());

    for (const [label, authorityPath] of [
      ["task manifest", path.join(fixture.layout.root, "smithers", "tasks.json")],
      ["control seal", path.join(fixture.layout.root, "smithers", "control-integrity.json")]
    ] as const) {
      const original = fs.readFileSync(authorityPath);
      fs.writeFileSync(authorityPath, "{", "utf8");
      try {
        const response = await dashboardFetch(handle, "/api/report");
        assert.equal(response.status, 500, label);
        const error = await parseHttpResponse(response, "errorResponse");
        assert.ok(String(error.error).length > 0, label);
      } finally {
        fs.writeFileSync(authorityPath, original);
      }
    }
  } finally {
    await handle.close();
  }
});

test("dashboard findings rejects a run authority snapshot whose state changed before aggregation returned", async () => {
  const fixture = await createDashboardFindingsFixture();
  const authority = loadVerifiedRunOutputAuthoritySnapshot(fixture.layout.root);
  updateNodeState(fixture.layout, fixture.attemptId, { finished_at: "2026-08-10T10:00:00.000Z" });
  assert.throws(
    () => verifiedDeclaredFindingsFromAuthoritySnapshot(authority),
    /run output authority changed while recursive bundle inputs were being captured/iu
  );
});

test("dashboard overview does not infer findings availability from a lookalike filename", async () => {
  const fixture = await createDashboardFindingsFixture({
    includeWrongContractLookalike: true,
    wrongContractOnly: true
  });
  const handle = await serveDashboard({ projectRoot: fixture.projectRoot, runId: fixture.runId, port: 0 });
  try {
    const flow = await getJson<FlowResponse>(handle, "/api/flow", "flowResponse");
    const reviewNode = flow.nodes.find((node) => node.id === "renamed-review");
    assert.equal(reviewNode?.data.artifacts?.findings, false);
    assert.equal(reviewNode?.data.artifacts?.report, false);
  } finally {
    await handle.close();
  }
});

test("dashboard flow captures run-wide authority outside per-node projection and rechecks once", () => {
  const compiledSource = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js"),
    "utf8"
  );
  const flowStart = compiledSource.indexOf("async flow()");
  const flowNodeStart = compiledSource.indexOf("\n    flowNode(", flowStart);
  assert.ok(flowStart >= 0 && flowNodeStart > flowStart);
  const flow = compiledSource.slice(flowStart, flowNodeStart);
  const flowNode = compiledSource.slice(flowNodeStart, compiledSource.indexOf("async runOverview()", flowNodeStart));
  const captureContextStart = compiledSource.indexOf("async captureRunAuthorityContext()");
  const captureContext = compiledSource.slice(
    captureContextStart,
    compiledSource.indexOf("async assertCapturedRunAuthorityRemainedCurrent", captureContextStart)
  );
  const projection = compiledSource.slice(
    compiledSource.indexOf("function dashboardFlowAuthorityProjection"),
    compiledSource.indexOf("function dashboardDeclaredReportAvailability")
  );
  assert.match(flow, /captureRunAuthorityContext/u);
  assert.match(captureContext, /dashboardFlowAuthorityProjection/u);
  assert.match(flow, /assertCapturedRunAuthorityRemainedCurrent/u);
  assert.doesNotMatch(flowNode, /loadVerifiedRunOutputAuthoritySnapshot/u);
  assert.equal(projection.match(/loadVerifiedRunOutputAuthoritySnapshot/gmu)?.length, 1);
});

test("dashboard authority capture rejects a run state that changed after the endpoint's initial read", async () => {
  const fixture = await createDashboardFindingsFixture();
  const observedState = readRunState(fixture.layout);
  updateNodeState(fixture.layout, fixture.attemptId, { finished_at: "2026-08-10T10:00:00.000Z" });

  assert.throws(
    () => dashboardFlowAuthorityProjection(fixture.layout.root, observedState),
    /state changed between the initial read and output-authority capture/iu
  );
});

test("dashboard emits typed SSE envelopes with monotonic per-stream sequences", async () => {
  const projectRoot = makeProject();
  const handle = await serveDashboard({ projectRoot, port: 0 });
  try {
    const eventFrames = await readSseFrames(handle, "/api/events/stream", 1);
    assertSseFrame(eventFrames[0]!, "eventsEnvelope", "ultrafuzz-event", 0);

    const commandFrames = await readSseFrames(handle, "/api/commands/stream", 2);
    assertSseFrame(commandFrames[0]!, "commandJobsEnvelope", "ultrafuzz-command-jobs", 0);
    assertSseFrame(commandFrames[1]!, "commandJobsEnvelope", "ultrafuzz-command-jobs", 1);
  } finally {
    await handle.close();
  }
});

test("dashboard frontend does not use native EventSource for authenticated streams", () => {
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "frontend", "src", "main.tsx"),
    "utf8"
  );
  assert.doesNotMatch(source, /\bEventSource\b/u);
  assert.match(source, /connectAuthenticatedEventStream/u);
  assert.match(source, /window\.confirm\(launchConfirmationMessage\(preview\)\)/u);
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
    const response = await dashboardFetch(handle, "/api/config", {
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

interface DashboardCompiledTaskFixture {
  attemptId: string;
  concreteNodeId: string;
  logicalNodeId: string;
  smithersNodeId: string;
  verifierSmithersNodeId: string;
  agentRef: string;
  metadata: {
    loop: { index: number; attemptIndex: number };
    model: { modelIndex: number };
  };
}

interface DashboardCompiledWorkflowFixture {
  smithersRunId: string;
  projectRoot: string;
  workflowPath: string;
  evidenceWorkflowPath: string;
  expandedGraphPath: string;
  configPath: string;
  inputPath: string;
  tasksPath: string;
  tasks: readonly DashboardCompiledTaskFixture[];
}

interface DashboardFindingsFixture {
  projectRoot: string;
  runId: string;
  layout: RunLayout;
  attemptId: string;
  node: PlannedGraphNodeDocument;
  finding: Record<string, unknown>;
  reportAttemptId?: string;
}

async function createDashboardFindingsFixture(
  options: {
    includeWrongContractLookalike?: boolean;
    duplicateFindingsDeclaration?: boolean;
    includeFinalReport?: boolean;
    emptyFindings?: boolean;
    wrongContractOnly?: boolean;
  } = {}
): Promise<DashboardFindingsFixture> {
  const projectRoot = makeProject();
  const runId = "dashboard-declared-findings";
  const promptDirectory = path.join(projectRoot, ".ultrafuzz", "prompts", "review");
  const reportVocabulary = "{{finding_reachability_vocabulary}}\n\n{{finding_note_key_vocabulary}}\n\n";
  fs.mkdirSync(promptDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(promptDirectory, "renamed-review.md"),
    `---\nid: renamed-review\ndisplay_name: Renamed review\n---\n\n${reportVocabulary}Produce the declared review artifacts.\n`,
    "utf8"
  );
  if (options.includeFinalReport === true) {
    fs.writeFileSync(
      path.join(promptDirectory, "summary-review.md"),
      `---\nid: summary-review\ndisplay_name: Summary review\n---\n\n${reportVocabulary}Produce the declared report artifacts.\n`,
      "utf8"
    );
  }
  const outputDeclarations = [
    ...(options.wrongContractOnly === true
      ? []
      : [
          {
            path: "custom/nested/review-findings.json",
            contract: "ultrafuzz/findings@2",
            primary: true
          }
        ]),
    ...(options.duplicateFindingsDeclaration === true
      ? [
          {
            path: "custom/nested/second-findings.json",
            contract: "ultrafuzz/findings@2",
            primary: false
          }
        ]
      : []),
    ...(options.includeWrongContractLookalike === true
      ? [
          {
            path: "severity-classified-findings.json",
            contract: "ultrafuzz/text@1",
            primary: options.wrongContractOnly === true
          }
        ]
      : [])
  ];
  const renderedOutputs = outputDeclarations
    .map(
      (output) =>
        `      - path: ${output.path}\n        contract: ${output.contract}\n        primary: ${String(output.primary)}`
    )
    .join("\n");
  const reportNode =
    options.includeFinalReport === true
      ? `  - id: summary-review
    kind: agentic
    prompt: review/summary-review.md
    depends_on:
      - __start__
    outputs:
      - path: deliverables/current-report.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
      - path: deliverables/current-report.json
        contract: ultrafuzz/report@3
        primary: false
`
      : "";
  fs.writeFileSync(
    path.join(projectRoot, ".ultrafuzz", "topology.yml"),
    `version: 2
defaults:
  strategy_loops: 1
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: renamed-review
    kind: agentic
    prompt: review/renamed-review.md
    depends_on:
      - __start__
    outputs:
${renderedOutputs}
${reportNode}  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - renamed-review
${options.includeFinalReport === true ? "      - summary-review\n" : ""}
`,
    "utf8"
  );

  const plan = await planRun({ projectRoot, runId, env: {} });
  assert.equal(plan.ok, true, JSON.stringify(plan.diagnostics));
  assert.ok(plan.value);
  const compiled = await compileDashboardFixtureWorkflow({
    projectRoot,
    config: plan.value.resolved_config,
    graph: plan.value.expanded_graph,
    runLayout: plan.value.layout,
    workflowName: `ultrafuzz-${runId}`,
    renderedPrompts: plan.value.rendered_prompts
  });
  const node = plan.value.graph.nodes.find((candidate) => candidate.logical_id === "renamed-review");
  assert.ok(node);
  const tasks = compiled.tasks.filter((task) => task.concreteNodeId === node.id);
  assert.ok(tasks.length > 0);
  for (const plannedNode of plan.value.graph.nodes) {
    const plannedTasks = compiled.tasks.filter((task) => task.concreteNodeId === plannedNode.id);
    if (plannedTasks.length === 0) continue;
    plannedNode.workflow = {
      node_id: plannedTasks[0]!.smithersNodeId,
      task_node_ids: plannedTasks.map((task) => task.smithersNodeId)
    };
  }
  writeJsonDurable(plan.value.layout.graphPath, plan.value.graph);
  sealWorkflowControlFiles({
    projectRoot: compiled.projectRoot,
    layout: plan.value.layout,
    workflowPath: compiled.workflowPath,
    expandedGraphPath: compiled.expandedGraphPath,
    configPath: compiled.configPath,
    evidenceWorkflowPath: compiled.evidenceWorkflowPath,
    tasksPath: compiled.tasksPath,
    inputPath: compiled.inputPath,
    executionFiles: []
  });

  const task = tasks[0]!;
  const finding = {
    schema_version: "ultrafuzz.finding.v2",
    id: "declared-finding",
    title: "Declared custom-path finding",
    status: "confirmed",
    severity_guess: "Medium",
    confidence: "high",
    summary: "The dashboard must use the exact declared path and contract.",
    source_node_id: task.logicalNodeId
  };
  const wrongContractFinding = {
    ...finding,
    id: "wrong-contract-lookalike",
    title: "This conventional filename is only text"
  };
  const bytesByPath = new Map<string, Buffer>();
  for (const output of node.outputs) {
    const value =
      output.contract === "ultrafuzz/text@1" ? [wrongContractFinding] : options.emptyFindings === true ? [] : [finding];
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    bytesByPath.set(output.path, bytes);
  }
  finalizeDashboardFixtureNode(plan.value.layout, compiled, node, task, bytesByPath);

  let reportAttemptId: string | undefined;
  if (options.includeFinalReport === true) {
    const reportNode = plan.value.graph.nodes.find((candidate) => candidate.logical_id === "summary-review");
    assert.ok(reportNode);
    const reportTask = compiled.tasks.find((candidate) => candidate.concreteNodeId === reportNode.id);
    assert.ok(reportTask);
    const report = {
      schema_version: "ultrafuzz.report.v3",
      run_metadata: {
        run_id: runId,
        source_run_id: runId,
        repository: ".",
        elapsed_time: "0s",
        models_used: [],
        tokens_used: "0",
        estimated_spend: "$0",
        partial_pricing: false,
        strategy_loops: 1,
        audit_profile: "full",
        audit_profile_catalog_digest: "a".repeat(64),
        topology_digest: "b".repeat(64),
        prompt_digest: "c".repeat(64),
        expanded_graph_fingerprint: "d".repeat(64)
      },
      issues: [],
      non_production_outcomes: [],
      property_provenance: [],
      property_implementation_coverage: {
        status: "not-planned",
        reason: "property-implementation-track-not-declared"
      }
    };
    const projection = projectCanonicalFinalReport(report);
    const reportBytesByPath = new Map<string, Buffer>();
    for (const output of reportNode.outputs) {
      reportBytesByPath.set(
        output.path,
        output.contract === "ultrafuzz/report@3"
          ? Buffer.from(`${JSON.stringify(projection.report, null, 2)}\n`, "utf8")
          : Buffer.from(projection.markdown, "utf8")
      );
    }
    finalizeDashboardFixtureNode(plan.value.layout, compiled, reportNode, reportTask, reportBytesByPath);
    reportAttemptId = reportTask.attemptId;
  }

  return {
    projectRoot,
    runId,
    layout: plan.value.layout,
    attemptId: task.attemptId,
    node,
    finding,
    ...(reportAttemptId === undefined ? {} : { reportAttemptId })
  };
}

function finalizeDashboardFixtureNode(
  layout: RunLayout,
  compiled: DashboardCompiledWorkflowFixture,
  node: PlannedGraphNodeDocument,
  task: DashboardCompiledTaskFixture,
  bytesByPath: ReadonlyMap<string, Buffer>,
  prerequisiteAttemptIds: readonly string[] = []
): void {
  for (const output of node.outputs) {
    writeFileDurable(path.join(layout.artifactsDir, task.attemptId, output.path), bytesByPath.get(output.path)!);
  }
  writeArtifactManifest({
    layout,
    nodeId: task.attemptId,
    include: node.outputs.map((output) => output.path),
    outputs: node.outputs,
    prerequisiteNodeIds: [...prerequisiteAttemptIds],
    provenance: {
      producer_node_id: task.attemptId,
      logical_node_id: task.logicalNodeId,
      attempt_index: task.metadata.loop.attemptIndex,
      loop_index: task.metadata.loop.index,
      model_index: task.metadata.model.modelIndex,
      agent_ref: task.agentRef,
      workflow_run_id: compiled.smithersRunId,
      workflow_task_id: task.smithersNodeId,
      origin: "workflow",
      metadata: { concrete_node_id: task.concreteNodeId }
    }
  });
  const marker: ArtifactVerificationMarker = {
    schema_version: ARTIFACT_VERIFICATION_SCHEMA_VERSION,
    attempt_id: task.attemptId,
    node_id: task.logicalNodeId,
    artifacts: node.outputs.map((output) => ({ ...output, sha256: sha256Bytes(bytesByPath.get(output.path)!) })),
    publications: node.outputs.map((output) => ({
      path: output.path,
      sha256: sha256Bytes(bytesByPath.get(output.path)!)
    }))
  };
  writeJsonDurable(path.join(layout.root, ".ultrafuzz-verification", `${task.attemptId}.json`), marker);
  const artifactManifestPath = path.join(layout.artifactsDir, task.attemptId, "artifact-manifest.json");
  updateNodeState(layout, task.attemptId, {
    status: "succeeded",
    logical_node_id: task.logicalNodeId,
    artifact_dir: `artifacts/${task.attemptId}`,
    outputs: node.outputs,
    finished_at: new Date().toISOString(),
    wait_since: undefined,
    wait_reason: undefined,
    next_eligible_action: undefined,
    provenance: {
      workflow: {
        run_id: compiled.smithersRunId,
        task_id: task.verifierSmithersNodeId,
        agent_task_id: task.smithersNodeId,
        verifier_task_id: task.verifierSmithersNodeId,
        state: "finished",
        attempt: 0
      },
      output_contracts: {
        ok: true,
        missing: [],
        artifact_manifest_sha256: sha256Bytes(fs.readFileSync(artifactManifestPath))
      }
    }
  });
}

async function compileDashboardFixtureWorkflow(input: unknown): Promise<DashboardCompiledWorkflowFixture> {
  const runtimeEntry = fileURLToPath(import.meta.resolve("@ultrafuzz/runtime"));
  const smithersModuleUrl = pathToFileURL(path.join(path.dirname(runtimeEntry), "smithers.js")).href;
  const smithersModule = (await import(smithersModuleUrl)) as {
    compileSmithersWorkflow: (compileInput: unknown) => DashboardCompiledWorkflowFixture;
  };
  return smithersModule.compileSmithersWorkflow(input);
}

function makeProject(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-dashboard-"));
  const result = initProject({ projectRoot, force: true });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return projectRoot;
}

function fakeDashboardSmithersEnv(projectRoot: string): {
  env: Record<string, string | undefined>;
  logPath: string;
} {
  const binDir = path.join(projectRoot, "fake-bin");
  const smithers = path.join(binDir, "smithers");
  const logPath = path.join(projectRoot, "dashboard-smithers.log");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    smithers,
    [
      "#!/usr/bin/env node",
      'import fs from "node:fs";',
      `fs.appendFileSync(${JSON.stringify(logPath)}, process.argv.slice(2).join(" ") + "\\n");`,
      'process.stdout.write("{\\"ok\\":true}\\n");',
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(smithers, 0o755);
  return {
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      SMITHERS_BIN: smithers,
      ULTRAFUZZ_PRICING_CATALOG_URL: "off"
    },
    logPath
  };
}

function writeSmallTopology(projectRoot: string): void {
  fs.writeFileSync(
    path.join(projectRoot, ".ultrafuzz", "topology.yml"),
    `version: 2
defaults:
  strategy_loops: 1
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: project-discovery
    kind: agentic
    prompt: setup/project-discovery.md
    depends_on:
      - __start__
    outputs:
      - path: report.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - project-discovery
`,
    "utf8"
  );
}

async function waitForDashboardAuditRecord(
  auditPath: string,
  kind: "run-launch",
  timeoutMs = 5000
): Promise<ReturnType<typeof readDashboardAuditJournal>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(auditPath)) {
      const audit = readDashboardAuditJournal(auditPath);
      if (audit.records.some((record) => record.kind === kind)) return audit;
    }
    if (Date.now() >= deadline) assert.fail(`dashboard audit record ${kind} was not written`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function getJson<T>(
  handle: DashboardTestHandle,
  apiPath: string,
  definition: DashboardHttpDefinition
): Promise<T> {
  const response = await dashboardFetch(handle, apiPath);
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

async function assertGenericUnexpectedError(
  response: Response,
  diagnostics: readonly DashboardServerDiagnostic[],
  diagnosticPattern: RegExp
): Promise<void> {
  const error = await parseHttpResponse(response, "errorResponse");
  assert.equal(error.error, "Unexpected dashboard error. Use the correlation ID to inspect the server diagnostic.");
  const correlationId = String(error.correlationId);
  assert.match(correlationId, /^[a-f0-9-]{36}$/u);
  const diagnostic = diagnostics.find((entry) => entry.correlationId === correlationId);
  assert.ok(diagnostic);
  assert.equal(diagnostic.kind, "unexpected-error");
  assert.match(diagnostic.message, diagnosticPattern);
  assert.doesNotMatch(String(error.error), diagnosticPattern);
}

async function waitForDashboardCommand(handle: DashboardTestHandle, jobId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const response = await dashboardFetch(handle, `/api/commands/${encodeURIComponent(jobId)}`);
    if (response.status !== 200) assert.fail(await response.text());
    const job = await parseHttpResponse(response, "commandJobResponse");
    if (job.status !== "running") return job;
    if (Date.now() >= deadline) assert.fail(`dashboard command ${jobId} did not finish`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) assert.fail(`file was not created: ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

interface SseFrame {
  event: string;
  data: string;
}

async function readSseFrames(handle: DashboardTestHandle, apiPath: string, count: number): Promise<SseFrame[]> {
  const response = await dashboardFetch(handle, apiPath, { headers: { accept: "text/event-stream" } });
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
  return new URL(apiPath, new URL(dashboardUrl).origin).toString();
}

function dashboardFetch(handle: DashboardTestHandle, apiPath: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-ultrafuzz-session", handle.sessionToken);
  return fetch(apiUrl(handle.url, apiPath), { ...init, headers });
}

function requestStatusWithHost(url: string, host: string): Promise<number> {
  return requestStatus(url, { headers: { host } });
}

function requestStatus(
  url: string,
  options: { headers?: Record<string, string>; setHost?: boolean } = {}
): Promise<number> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers: options.headers,
        setHost: options.setHost
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

function requestStatusWithoutHost(url: string, headers: Record<string, string>): Promise<number> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(parsed.port), parsed.hostname);
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      const headerLines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
      socket.end([`GET ${parsed.pathname}${parsed.search} HTTP/1.0`, ...headerLines, "", ""].join("\r\n"));
    });
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => {
      const status = /^HTTP\/1\.[01] (\d{3})/u.exec(response)?.[1];
      if (status === undefined) {
        reject(new Error("dashboard returned no HTTP status for a Host-free request"));
        return;
      }
      resolve(Number(status));
    });
  });
}
