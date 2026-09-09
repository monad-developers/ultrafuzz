import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ARTIFACT_VERIFICATION_SCHEMA_VERSION,
  appendEvent,
  createEventRecord,
  parseSmithersTaskManifestBytes,
  parseStrictJsonBytes,
  readRunMetadataDocument,
  readRunState,
  sha256Bytes,
  updateNodeState,
  writeArtifactManifest,
  writeFileDurable,
  writeJsonDurable,
  writeRunMetadataDocument,
  writeRunState,
  type ArtifactVerificationMarker,
  type PlannedGraphNodeDocument,
  type RunLayout
} from "@ultrafuzz/artifacts";
import {
  initProject,
  loadVerifiedRunOutputAuthoritySnapshot,
  planRun,
  projectCanonicalFinalReport,
  publishTerminalReport,
  sealWorkflowControlFiles
} from "@ultrafuzz/runtime";

import {
  assertDashboardHttpDocument,
  assertDashboardSseDocument,
  dashboardFlowAuthorityProjection,
  DASHBOARD_HTTP_SCHEMA_VERSION,
  serveDashboard,
  verifiedDeclaredFindingsFromAuthoritySnapshot,
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
  const prompt =
    "---\nid: added-check\ndisplay_name: Added check\n---\n\n# Added check\n\n" +
    "{{finding_reachability_vocabulary}}\n\n{{finding_note_key_vocabulary}}\n";
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

test("rejects prompt identity changes instead of converting them into topology renames", async () => {
  const projectRoot = makeProject();
  const promptPath = path.join(projectRoot, ".ultrafuzz", "prompts", "setup", "project-discovery.md");
  const topologyPath = path.join(projectRoot, ".ultrafuzz", "topology.yml");
  const originalPrompt = fs.readFileSync(promptPath);
  const originalTopology = fs.readFileSync(topologyPath);
  const handle = await serveDashboard({ projectRoot, port: 0 });
  try {
    const response = await fetch(apiUrl(handle.url, "/api/prompts/nodes/project-discovery"), {
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
  const outsideDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-dashboard-audit-"));
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
      if (response.status !== 200) assert.fail(`${route}: ${await response.text()}`);
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
      const response = await fetch(apiUrl(handle.url, route));
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
    }>(apiUrl(handle.url, "/api/events"), "eventsResponse");
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
      apiUrl(handle.url, "/api/findings"),
      "findingsResponse"
    );
    assert.equal(findings.source, `artifacts/${fixture.attemptId}/custom/nested/review-findings.json`);
    assert.deepEqual(findings.findings, [fixture.finding]);

    const node = await getJson<{ findings: unknown[] }>(
      apiUrl(handle.url, "/api/nodes/renamed-review"),
      "nodeDetailResponse"
    );
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

  const handle = await serveDashboard({ projectRoot: fixture.projectRoot, runId: fixture.runId, port: 0 });
  try {
    const response = await fetch(apiUrl(handle.url, "/api/findings"));
    assert.equal(response.status, 500);
    const error = await parseHttpResponse(response, "errorResponse");
    assert.match(String(error.error), /run-state output contracts do not match the current planned node/u);
  } finally {
    await handle.close();
  }
});

test("dashboard rejects duplicate typed findings declarations on one planned producer", async () => {
  const fixture = await createDashboardFindingsFixture({ duplicateFindingsDeclaration: true });
  const handle = await serveDashboard({ projectRoot: fixture.projectRoot, runId: fixture.runId, port: 0 });
  try {
    const response = await fetch(apiUrl(handle.url, "/api/findings"));
    assert.equal(response.status, 500);
    const error = await parseHttpResponse(response, "errorResponse");
    assert.match(String(error.error), /declares 2 ultrafuzz\/findings@2 outputs/u);
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
      apiUrl(handle.url, "/api/findings"),
      "findingsResponse"
    );
    assert.equal(findings.source, `artifacts/${fixture.reportAttemptId}/deliverables/current-report.json`);
    assert.deepEqual(findings.findings, []);

    const report = await getJson<{
      markdown_path: string;
      json_path: string;
      markdown: string;
      json: unknown;
    }>(apiUrl(handle.url, "/api/report"), "reportResponse");
    assert.equal(report.markdown_path, `artifacts/${fixture.reportAttemptId}/deliverables/current-report.md`);
    assert.equal(report.json_path, `artifacts/${fixture.reportAttemptId}/deliverables/current-report.json`);
    assert.match(report.markdown, /^# Ultrafuzz report/mu);
    assert.ok(report.json);

    const flow = await getJson<FlowResponse>(apiUrl(handle.url, "/api/flow"), "flowResponse");
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

  const handle = await serveDashboard({ projectRoot: fixture.projectRoot, runId: fixture.runId, port: 0 });
  try {
    const response = await fetch(apiUrl(handle.url, "/api/report"));
    assert.equal(response.status, 500);
    const error = await parseHttpResponse(response, "errorResponse");
    assert.match(
      String(error.error),
      /claims succeeded without complete current verification\/finalization authority/iu
    );
  } finally {
    await handle.close();
  }
});

test("dashboard rejects a malformed runtime report receipt instead of serving an older agent report", async () => {
  const fixture = await createDashboardFindingsFixture({ includeFinalReport: true, emptyFindings: true });
  const handle = await serveDashboard({ projectRoot: fixture.projectRoot, runId: fixture.runId, port: 0 });
  try {
    const valid = await fetch(apiUrl(handle.url, "/api/report"));
    assert.equal(valid.status, 200, await valid.text());
    const receiptPath = path.join(fixture.layout.root, "review", "runtime-report", "current.json");
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    fs.writeFileSync(receiptPath, "{", "utf8");

    const response = await fetch(apiUrl(handle.url, "/api/report"));
    assert.equal(response.status, 500);
    const error = await parseHttpResponse(response, "errorResponse");
    assert.match(String(error.error), /terminal report receipt|JSON|parse|object-property/iu);
  } finally {
    await handle.close();
  }
});

test("dashboard serves the current partial report while retaining the failed run state", async () => {
  const fixture = await createDashboardFindingsFixture({ includeFinalReport: true, emptyFindings: true });
  const { layout } = fixture;
  const manifest = parseSmithersTaskManifestBytes(fs.readFileSync(path.join(layout.root, "smithers", "tasks.json")));
  const task = manifest.tasks.find((candidate) => candidate.attemptId === fixture.attemptId);
  assert.ok(task);
  const workflowRunId = manifest.smithers_run_id;
  const generation = sha256Bytes(fs.readFileSync(path.join(layout.root, "smithers", "control-integrity.json")));
  const linkId = "123e4567-e89b-42d3-a456-426614174000";
  const executionSnapshot = `smithers/execution-snapshots/${generation}`;
  updateNodeState(layout, fixture.attemptId, {
    status: "failed",
    provenance: {
      workflow: {
        run_id: workflowRunId,
        task_id: task.smithersNodeId,
        agent_task_id: task.smithersNodeId,
        verifier_task_id: task.verifierSmithersNodeId,
        state: "failed",
        attempt: 1
      },
      failure: {
        category: "agent-failure",
        causal_task_id: task.smithersNodeId,
        causal_failure_category: "agent-failure",
        dependent_task_ids: []
      }
    }
  });
  const state = readRunState(layout);
  state.status = "failed";
  state.finished_at = new Date().toISOString();
  state.provenance = {
    workflow: {
      inspection: { runId: workflowRunId },
      runId: workflowRunId,
      compiledRunId: workflowRunId,
      name: manifest.workflow_name,
      controlGeneration: generation,
      linkId,
      executionSnapshot
    }
  };
  writeRunState(layout, state);
  const metadata = readRunMetadataDocument(layout.runMetadataPath);
  writeRunMetadataDocument(layout.runMetadataPath, {
    ...metadata,
    workflow_ids: [workflowRunId],
    workflow: {
      run_id: workflowRunId,
      compiled_run_id: workflowRunId,
      name: manifest.workflow_name,
      path: "smithers/workflow.tsx",
      evidence_path: "smithers/evidence.json",
      expanded_graph_path: "smithers/expanded-graph.json",
      config_path: "smithers/config.json",
      input_path: "smithers/input.json",
      tasks_path: "smithers/tasks.json",
      control_integrity_path: "smithers/control-integrity.json",
      control_generation: generation,
      workflow_link_id: linkId,
      execution_snapshot_path: executionSnapshot,
      task_node_ids: manifest.tasks.map((entry) => entry.smithersNodeId)
    }
  });
  appendEvent(layout, {
    eventType: "node-synced",
    nodeId: fixture.attemptId,
    status: "failed",
    payload: {
      workflow_run_id: workflowRunId,
      workflow_task_id: task.smithersNodeId,
      workflow_state: "failed",
      attempt: 1
    }
  });
  appendEvent(layout, {
    eventType: "workflow-synced",
    status: "failed",
    payload: {
      workflow_run_id: workflowRunId,
      workflow_status: "failed",
      workflow_state: "failed",
      exhausted_loops: [],
      synced_nodes: manifest.tasks.length,
      accounting_available: false,
      recovery_due: false,
      deadline_exceeded: false
    }
  });
  const snapshot = publishTerminalReport(layout.root, { workflowRunId, workflowState: "failed" });
  assert.ok(snapshot);
  const stateBytes = fs.readFileSync(layout.statePath);
  const handle = await serveDashboard({ projectRoot: fixture.projectRoot, runId: fixture.runId, port: 0 });
  try {
    const report = await getJson<{
      markdown: string;
      json_path: string;
      json: { completion: { outcome: string; counts: { failed: number } } };
    }>(apiUrl(handle.url, "/api/report"), "reportResponse");
    assert.match(report.markdown, /^# Ultrafuzz report — PARTIAL/u);
    assert.match(report.json_path, /^review\/runtime-report\/[0-9a-f]{64}\/report.json$/u);
    assert.equal(report.json.completion.outcome, "partial");
    assert.equal(report.json.completion.counts.failed, 1);
    assert.deepEqual(fs.readFileSync(layout.statePath), stateBytes);
  } finally {
    await handle.close();
  }
});

test("dashboard report rejects malformed present task-manifest and control-seal authority", async () => {
  const fixture = await createDashboardFindingsFixture({ includeFinalReport: true, emptyFindings: true });
  const handle = await serveDashboard({ projectRoot: fixture.projectRoot, runId: fixture.runId, port: 0 });
  try {
    const valid = await fetch(apiUrl(handle.url, "/api/report"));
    assert.equal(valid.status, 200, await valid.text());

    for (const [label, authorityPath] of [
      ["task manifest", path.join(fixture.layout.root, "smithers", "tasks.json")],
      ["control seal", path.join(fixture.layout.root, "smithers", "control-integrity.json")]
    ] as const) {
      const original = fs.readFileSync(authorityPath);
      fs.writeFileSync(authorityPath, "{", "utf8");
      try {
        const response = await fetch(apiUrl(handle.url, "/api/report"));
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
    const flow = await getJson<FlowResponse>(apiUrl(handle.url, "/api/flow"), "flowResponse");
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
        audit_profile: "exhaustive",
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
  const projectRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-dashboard-"));
  const result = initProject({ projectRoot, force: true });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return projectRoot;
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
