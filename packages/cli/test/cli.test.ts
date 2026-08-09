import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { artifactContractDefinition, layoutForRunRoot, writeArtifactManifest } from "@ultrafuzz/artifacts";
import AdmZip from "adm-zip";

import { runCli } from "../src/index.js";

interface Capture {
  stdout: string;
  stderr: string;
  code: number;
}

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ufz-cli-"));
}

function fakeSmithersEnv(project: string): Record<string, string | undefined> {
  const binDir = path.join(project, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const smithers = path.join(binDir, "smithers");
  fs.writeFileSync(
    smithers,
    [
      "#!/bin/sh",
      'if [ -n "$SMITHERS_FAKE_LOG" ]; then printf \'%s\\n\' "$*" >> "$SMITHERS_FAKE_LOG"; fi',
      'case "$1" in',
      "  fork)",
      "    printf '%s\\n' '{\"forkedRunId\":\"ultrafuzz-cli-run-forked\"}'",
      "    ;;",
      "  pause)",
      "    printf '%s\\n' '{\"status\":\"pause-requested\"}'",
      "    exit 2",
      "    ;;",
      "  status)",
      '    printf \'%s\\n\' \'{"data":{"status":"running","verdict":"running-healthy","reason":"1 running, 2 finished in last 10m","counts":{"finished":2,"inProgress":1,"pending":3,"failed":0,"waitingApproval":0,"waitingEvent":0,"waitingTimer":0,"skipped":0,"other":0,"total":6},"modelMix":[{"engine":"codex","model":"gpt-test","attempts":3,"quotaParked":false}],"throughput":{"recentFinished":2,"windowMs":600000,"totalFinished":2,"lastFinishedAtMs":1000},"bottleneck":[{"nodeId":"project-discovery","iteration":0,"state":"in-progress","detail":"running 1m"}],"bottleneckOmitted":0,"quota":null,"generatedAtMs":2000}}\'',
      "    ;;",
      "  *)",
      "    printf '%s\\n' '{\"ok\":true}'",
      "    ;;",
      "esac",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(smithers, 0o755);
  return {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    SMITHERS_BIN: smithers,
    SMITHERS_FAKE_LOG: path.join(project, "smithers-commands.log")
  };
}

function writeSmallTopology(project: string): void {
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "topology.yml"),
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
      - path: stdout.txt
        contract: ultrafuzz/text@1
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

async function cli(
  project: string,
  argv: string[],
  env: Record<string, string | undefined> = {},
  onStdout?: (stdout: string) => void
): Promise<Capture> {
  let stdout = "";
  let stderr = "";
  const code = await runCli([...argv, "--project", project], {
    cwd: project,
    env,
    stdout: {
      write: (chunk: string | Uint8Array) => {
        stdout += String(chunk);
        onStdout?.(stdout);
        return true;
      }
    },
    stderr: {
      write: (chunk: string | Uint8Array) => {
        stderr += String(chunk);
        return true;
      }
    }
  });
  return { stdout, stderr, code };
}

function parseJson(capture: Capture): Record<string, unknown> {
  return JSON.parse(capture.stdout) as Record<string, unknown>;
}

function assertNoSmithersSurface(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertNoSmithersSurface(entry);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      assert.doesNotMatch(key, /smithers/i);
      assertNoSmithersSurface(entry);
    }
    return;
  }
  if (typeof value === "string") {
    assert.doesNotMatch(value, /smithers/i);
  }
}

function writeRunAccounting(
  runRoot: string,
  accounting: {
    totalTokens: number;
    tokensUsed: string;
    estimatedSpend: string;
    partialPricing: boolean;
    unpricedEventCount?: number;
  }
): void {
  const runMetadataPath = path.join(runRoot, "run.json");
  const runMetadata = JSON.parse(fs.readFileSync(runMetadataPath, "utf8")) as Record<string, unknown>;
  const summary = {
    input_tokens: accounting.totalTokens,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: accounting.totalTokens,
    tokens_used: accounting.tokensUsed,
    estimated_spend: accounting.estimatedSpend,
    estimated_spend_usd: Number(accounting.estimatedSpend.replace(/[$,+]/gu, "")),
    partial_pricing: accounting.partialPricing,
    event_count: 1 + (accounting.unpricedEventCount ?? (accounting.partialPricing ? 1 : 0)),
    priced_event_count: 1,
    unpriced_event_count: accounting.unpricedEventCount ?? (accounting.partialPricing ? 1 : 0),
    models: ["gpt-test"],
    agents: ["codex"]
  };
  fs.writeFileSync(
    runMetadataPath,
    `${JSON.stringify(
      {
        ...runMetadata,
        accounting: {
          schema_version: "1.0",
          source: "workflow-events",
          workflow_run_id: "ultrafuzz-cli-run",
          current: summary,
          cumulative: {
            ...summary,
            source_run_ids: []
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function writeFinalReportAccounting(
  runRoot: string,
  accounting: { tokensUsed: string; estimatedSpend: string; partialPricing: boolean }
): string {
  const reportDir = path.join(runRoot, "artifacts", "final-report");
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(
    path.join(reportDir, "report.md"),
    [
      "# Agent report",
      "",
      "## Run summary",
      "",
      `- Tokens used: \`${accounting.tokensUsed}\``,
      `- Estimated spend: \`${accounting.estimatedSpend}\``,
      ""
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(reportDir, "report.json"),
    `${JSON.stringify(
      {
        schema_version: "1.0",
        run_metadata: {
          tokens_used: accounting.tokensUsed,
          estimated_spend: accounting.estimatedSpend,
          partial_pricing: accounting.partialPricing,
          source_run_ids: []
        },
        issues: [],
        non_production_outcomes: []
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return reportDir;
}

function accountingMismatchCount(value: Record<string, unknown>): number {
  return (
    (value.diagnostics as Array<{ code?: string }> | undefined)?.filter(
      (diagnostic) => diagnostic.code === "REPORT_ACCOUNTING_MISMATCH"
    ).length ?? 0
  );
}

async function createReportRun(project: string, runId: string): Promise<{ run_id: string; run_root: string }> {
  assert.equal((await cli(project, ["init", "--force"])).code, 0);
  writeSmallTopology(project);
  const run = await cli(project, ["run", "--run-id", runId, "--json"], fakeSmithersEnv(project));
  assert.equal(run.code, 0, run.stderr);
  return parseJson(run).data as { run_id: string; run_root: string };
}

function writeJsonRecord(filePath: string, value: Record<string, unknown>): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("init and validate emit schema-versioned launch JSON", async () => {
  const project = tempProject();
  fs.writeFileSync(path.join(project, "ultrafuzz.toml"), "# owned\n", "utf8");

  const init = await cli(project, ["init", "--json"]);
  assert.equal(init.code, 0, init.stderr);
  const initBody = parseJson(init);
  assertNoSmithersSurface(initBody);
  assert.equal((initBody.data as { preserved: string[] }).preserved.includes("ultrafuzz.toml"), true);

  // A clean shipped scaffold validates with no fixture mutation whatsoever: the pinned
  // vulnerability-database reference is part of the scaffolded catalog.
  const shippedReferences = fs.readFileSync(path.join(project, ".ultrafuzz", "references.yml"), "utf8");
  assert.match(shippedReferences, /^ {2}vulnerability-database\.web3:$/mu);
  assert.match(shippedReferences, /^ {4}commit: e46c0e472c28596f30decbb08549c9d9630f47cb$/mu);
  const validate = await cli(project, ["validate", "--json"]);
  const body = parseJson(validate);
  assert.equal(validate.code, 0, validate.stderr);
  assertNoSmithersSurface(body);
  assert.equal(body.schema_version, "ultrafuzz.cli.result.v1");
  const posture = (body.data as { policy_posture: Record<string, unknown> }).policy_posture;
  for (const key of ["config", "topology", "prompts", "paths", "agents", "trust"]) {
    assert.equal(Boolean(posture[key]), true, `${key} posture missing`);
  }
  assert.equal("repository_mutation" in posture, false);

  // Repointing the pinned reference at an unknown ID is a topology error, so the shipped catalog
  // entry is load-bearing rather than decorative.
  const topologyPath = path.join(project, ".ultrafuzz", "topology.yml");
  fs.writeFileSync(
    topologyPath,
    fs
      .readFileSync(topologyPath, "utf8")
      .replace("reference: vulnerability-database.web3", "reference: absent.database"),
    "utf8"
  );
  const tampered = await cli(project, ["validate", "--json"]);
  assert.notEqual(tampered.code, 0);
  assert.match(tampered.stdout + tampered.stderr, /absent\.database/u);
});

test("plain init surfaces a customized stale agent adapter diagnostic", async () => {
  const project = tempProject();
  const initial = await cli(project, ["init", "--force"]);
  assert.equal(initial.code, 0, initial.stderr);

  const adapterPath = path.join(project, ".smithers", "agents", "codex.ts");
  const customAdapter = 'export const customConfigPath = "ultrafuzz.toml";\n';
  fs.writeFileSync(adapterPath, customAdapter, "utf8");

  const result = await cli(project, ["init"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /warning: INIT_AGENT_ADAPTER_UPDATE_REQUIRED:/u);
  assert.match(result.stdout, /ULTRAFUZZ_CONFIG_PATH/u);
  assert.equal(fs.readFileSync(adapterPath, "utf8"), customAdapter);
});

test("run exposes the trusted reference expectation catalog option", async () => {
  const project = tempProject();
  assert.equal((await cli(project, ["init", "--force"])).code, 0);
  writeSmallTopology(project);
  const run = await cli(
    project,
    ["run", "--run-id", "catalog-cli-run", "--reference-expectations", "missing.json", "--json"],
    fakeSmithersEnv(project)
  );
  assert.equal(run.code, 1, run.stderr);
  const body = parseJson(run);
  assert.equal(
    (body.diagnostics as Array<{ code?: string }>).some(
      (diagnostic) => diagnostic.code === "REFERENCE_EXPECTATIONS_INVALID" || diagnostic.code === "ENOENT"
    ),
    true
  );
});

test("run, ps, status, inspect, report, materialize, clean, and lifecycle commands expose product workflow evidence", async () => {
  const project = tempProject();
  assert.equal((await cli(project, ["init", "--force"])).code, 0);
  writeSmallTopology(project);

  const env = fakeSmithersEnv(project);
  const run = await cli(
    project,
    [
      "run",
      "--run-id",
      "cli-run",
      "--max-concurrency",
      "2",
      "--prompt",
      "Operator prompt",
      "--input",
      '{"ticket":2}',
      "--json"
    ],
    env
  );
  assert.equal(run.code, 0, run.stderr);
  const runBody = parseJson(run);
  assertNoSmithersSurface(runBody);
  const runData = runBody.data as { run_id: string; run_root: string; status: string; workflow_ids: string[] };
  assert.equal(runData.status, "running");
  assert.deepEqual(runData.workflow_ids, ["ultrafuzz-cli-run"]);
  const smithersInput = JSON.parse(fs.readFileSync(path.join(runData.run_root, "smithers", "input.json"), "utf8")) as {
    operator_prompt?: string;
    operator_input?: { ticket?: number };
  };
  assert.equal(smithersInput.operator_prompt, "Operator prompt");
  assert.equal(smithersInput.operator_input?.ticket, 2);

  const ps = await cli(project, ["ps", "--json"], env);
  assert.equal(ps.code, 0, ps.stderr);
  const psBody = parseJson(ps);
  assertNoSmithersSurface(psBody);
  const psData = psBody.data as { runs: Array<{ workflow_run_id: string; ultrafuzz_run_id?: string }> };
  assert.equal(psData.runs.length, 1);
  assert.equal(psData.runs[0]?.workflow_run_id, "ultrafuzz-cli-run");
  assert.equal(psData.runs[0]?.ultrafuzz_run_id, "cli-run");
  assert.equal("smithers" in (psBody.data as Record<string, unknown>), false);

  const inspect = await cli(project, ["inspect", runData.run_id, "--json"], env);
  assert.equal(inspect.code, 0, inspect.stderr);
  const inspectBody = parseJson(inspect);
  assertNoSmithersSurface(inspectBody);
  const inspectData = inspectBody.data as {
    metadata: { workflow: { run_id: string } };
    state: { provenance?: { workflow?: Record<string, unknown> } };
    workflow: { run_id: string; inspect: { ok: boolean }; events: { ok: boolean } };
  };
  assert.equal(inspectData.metadata.workflow.run_id, "ultrafuzz-cli-run");
  assert.equal(inspectData.workflow.run_id, "ultrafuzz-cli-run");
  assert.equal(inspectData.workflow.inspect.ok, true);
  assert.equal(inspectData.workflow.events.ok, true);
  assert.equal(Object.hasOwn(inspectData.state.provenance?.workflow ?? {}, "executionSnapshot"), false);

  const status = await cli(project, ["status", runData.run_id, "--window", "5", "--json"], env);
  assert.equal(status.code, 0, status.stderr);
  const statusBody = parseJson(status);
  assertNoSmithersSurface(statusBody);
  const statusData = statusBody.data as {
    run_id: string;
    verdict: string;
    counts: { in_progress: number };
    gating: Array<{ node_id: string }>;
    progress: { percent: number; remaining: number; total: number };
    eta: { available: boolean; seconds: number | null; basis: string | null };
    current_step: { running_count: number; elapsed_seconds: number | null };
  };
  assert.equal(statusData.run_id, "cli-run");
  assert.equal(statusData.verdict, "running-healthy");
  assert.equal(statusData.counts.in_progress, 1);
  assert.equal(statusData.gating[0]?.node_id, "project-discovery");
  assert.equal(statusData.progress.percent, 33);
  assert.equal(statusData.progress.remaining, 4);
  assert.equal(statusData.progress.total, 6);
  assert.equal(statusData.eta.available, true);
  assert.equal(statusData.eta.basis, "recent-throughput");
  assert.equal(statusData.eta.seconds, 1_200);
  assert.equal(statusData.current_step.running_count, 0);
  assert.equal(statusData.current_step.elapsed_seconds, null);

  const statePath = path.join(runData.run_root, "state.json");
  const runningState = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    status: string;
    nodes: Record<string, Record<string, unknown>>;
  };
  const firstNodeId = Object.keys(runningState.nodes)[0]!;
  runningState.nodes[firstNodeId] = {
    ...runningState.nodes[firstNodeId],
    status: "running",
    started_at: new Date(Date.now() - 600_000).toISOString()
  };
  fs.writeFileSync(statePath, `${JSON.stringify(runningState, null, 2)}\n`, "utf8");

  const statusText = await cli(project, ["status", runData.run_id, "--window", "5"], env);
  assert.equal(statusText.code, 0, statusText.stderr);
  assert.doesNotMatch(statusText.stdout, /smithers/iu);
  assert.match(statusText.stdout, /^Status: running-healthy \(running\)$/mu);
  assert.match(statusText.stdout, /^Progress: 33% \(2 finished \/ 1 running \/ 3 pending \/ 0 failed \/ 6 total\)$/mu);
  assert.match(statusText.stdout, /^ETA: 20 minutes$/mu);
  assert.match(statusText.stdout, /^Time on current step: 10 minutes on \S+$/mu);

  // Long-running steps roll over into hours and then days.
  for (const [elapsedMs, expected] of [
    [30_000, "less than a minute"],
    [60_000, "1 minute"],
    [5_400_000, "1h 30m"],
    [3 * 86_400_000, "3d 00h"]
  ] as const) {
    const rolled = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      nodes: Record<string, Record<string, unknown>>;
    };
    rolled.nodes[firstNodeId] = {
      ...rolled.nodes[firstNodeId],
      status: "running",
      started_at: new Date(Date.now() - elapsedMs).toISOString()
    };
    fs.writeFileSync(statePath, `${JSON.stringify(rolled, null, 2)}\n`, "utf8");
    const rolledText = await cli(project, ["status", runData.run_id], env);
    assert.equal(rolledText.code, 0, rolledText.stderr);
    assert.match(rolledText.stdout, new RegExp(`^Time on current step: ${expected} on \\S+$`, "mu"));
  }

  // Restore the 10-minute step for the watch assertions below.
  const restored = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    nodes: Record<string, Record<string, unknown>>;
  };
  restored.nodes[firstNodeId] = {
    ...restored.nodes[firstNodeId],
    status: "running",
    started_at: new Date(Date.now() - 600_000).toISOString()
  };
  fs.writeFileSync(statePath, `${JSON.stringify(restored, null, 2)}\n`, "utf8");

  let resolveFirstStatusLine!: () => void;
  let rejectFirstStatusLine!: (error: Error) => void;
  let sawFirstStatusLine = false;
  const firstStatusLine = new Promise<void>((resolve, reject) => {
    resolveFirstStatusLine = resolve;
    rejectFirstStatusLine = reject;
  });
  const firstStatusTimeout = setTimeout(
    () => rejectFirstStatusLine(new Error("status watch did not emit its initial sample")),
    15_000
  );
  const watching = cli(project, ["status", runData.run_id, "--watch", "--interval", "1", "--json"], env, (stdout) => {
    if (!sawFirstStatusLine && stdout.includes("\n")) {
      sawFirstStatusLine = true;
      resolveFirstStatusLine();
    }
  });
  try {
    await Promise.race([
      firstStatusLine,
      watching.then(() => {
        throw new Error("status watch completed before emitting its initial sample");
      })
    ]);
  } catch (error) {
    const terminalState = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(statePath, `${JSON.stringify({ ...terminalState, status: "succeeded" }, null, 2)}\n`, "utf8");
    await watching;
    throw error;
  } finally {
    clearTimeout(firstStatusTimeout);
  }
  const terminalState = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(statePath, `${JSON.stringify({ ...terminalState, status: "succeeded" }, null, 2)}\n`, "utf8");
  const watched = await watching;
  assert.equal(watched.code, 0, watched.stderr);
  const watchedLines = watched.stdout.split("\n").filter(Boolean);
  assert.equal(watchedLines.length, 2);
  const watchedEnvelopes = watchedLines.map((line) => JSON.parse(line) as Record<string, unknown>);
  for (const body of watchedEnvelopes) {
    assertNoSmithersSurface(body);
    assert.equal(body.command, "status");
    assert.equal(body.ok, true);
  }
  assert.equal((watchedEnvelopes[0]!.data as { status: string }).status, "running");
  assert.equal((watchedEnvelopes[1]!.data as { status: string }).status, "succeeded");

  const artifactDir = path.join(runData.run_root, "artifacts", "project-discovery");
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "stdout.txt"), "generated stdout\n", "utf8");
  const runMetadataPath = path.join(runData.run_root, "run.json");
  const runMetadata = JSON.parse(fs.readFileSync(runMetadataPath, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(
    runMetadataPath,
    `${JSON.stringify(
      {
        ...runMetadata,
        accounting: {
          schema_version: "1.0",
          source: "workflow-events",
          workflow_run_id: "ultrafuzz-cli-run",
          current: {
            input_tokens: 100,
            output_tokens: 23,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            reasoning_tokens: 0,
            total_tokens: 123,
            tokens_used: "123",
            estimated_spend: "$0.46+",
            estimated_spend_usd: 0.46,
            partial_pricing: true,
            event_count: 2,
            priced_event_count: 1,
            unpriced_event_count: 1,
            models: ["gpt-test"],
            agents: ["codex"]
          },
          cumulative: {
            input_tokens: 100,
            output_tokens: 23,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            reasoning_tokens: 0,
            total_tokens: 123,
            tokens_used: "123",
            estimated_spend: "$0.46+",
            estimated_spend_usd: 0.46,
            partial_pricing: true,
            event_count: 2,
            priced_event_count: 1,
            unpriced_event_count: 1,
            models: ["gpt-test"],
            agents: ["codex"],
            source_run_ids: []
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  const reportDir = writeFinalReportAccounting(runData.run_root, {
    tokensUsed: "unavailable",
    estimatedSpend: "unavailable",
    partialPricing: true
  });

  const report = await cli(project, ["report", runData.run_id, "--json"]);
  assert.equal(report.code, 0, report.stderr);
  const reportBody = parseJson(report);
  assertNoSmithersSurface(reportBody);
  assert.equal((reportBody.data as { json_path?: string }).json_path, path.join(reportDir, "report.json"));
  assert.equal(accountingMismatchCount(reportBody), 0);
  const reportMarkdown = fs.readFileSync(path.join(reportDir, "report.md"), "utf8");
  assert.match(reportMarkdown, /- Tokens used: `123`/u);
  assert.match(reportMarkdown, /- Estimated spend: `\$0\.46\+`/u);

  const escapedReport = await cli(project, ["report", "../../outside", "--json"]);
  const escapedReportBody = parseJson(escapedReport);
  assert.equal(escapedReportBody.ok, false);
  assertNoSmithersSurface(escapedReportBody);
  assert.match(JSON.stringify(escapedReportBody.diagnostics), /run ID/);

  const materialize = await cli(project, [
    "materialize",
    runData.run_id,
    "--copy",
    "artifacts/project-discovery/stdout.txt:materialized/stdout.txt",
    "--yes",
    "--json"
  ]);
  assert.equal(materialize.code, 0, materialize.stderr);
  assertNoSmithersSurface(parseJson(materialize));
  assert.equal(fs.existsSync(path.join(project, "materialized", "stdout.txt")), true);

  const clean = await cli(project, [
    "clean",
    runData.run_id,
    "--select",
    "runs/cli-run/artifacts/project-discovery",
    "--yes",
    "--json"
  ]);
  assert.equal(clean.code, 0, clean.stderr);
  assertNoSmithersSurface(parseJson(clean));
  assert.equal(fs.existsSync(path.join(runData.run_root, "artifacts", "project-discovery")), false);

  for (const command of ["resume", "replay"]) {
    const args =
      command === "resume"
        ? [command, runData.run_id, "--max-concurrency", "8", "--json"]
        : [command, runData.run_id, "--json"];
    const lifecycle = await cli(project, args, env);
    assert.equal(lifecycle.code, 0, `${command}: ${lifecycle.stderr}${lifecycle.stdout}`);
    const lifecycleBody = parseJson(lifecycle);
    assertNoSmithersSurface(lifecycleBody);
    const lifecycleData = lifecycleBody.data as { submitted: boolean; workflow_run_id: string };
    assert.equal(lifecycleData.submitted, true);
    assert.equal(lifecycleData.workflow_run_id, "ultrafuzz-cli-run");
  }

  const retried = await cli(
    project,
    ["resume", runData.run_id, "--reset-node", "node:project-discovery", "--max-concurrency", "8", "--json"],
    env
  );
  assert.equal(retried.code, 0, `resume reset: ${retried.stderr}${retried.stdout}`);
  const retriedBody = parseJson(retried);
  assertNoSmithersSurface(retriedBody);
  const retriedData = retriedBody.data as { submitted: boolean; workflow_run_id: string };
  assert.equal(retriedData.submitted, true);
  assert.equal(retriedData.workflow_run_id, "ultrafuzz-cli-run");

  const fork = await cli(
    project,
    [
      "fork",
      runData.run_id,
      "--frame",
      "44",
      "--reset-node",
      "node:project-discovery",
      "--label",
      "after-edit",
      "--max-concurrency",
      "8",
      "--json"
    ],
    env
  );
  assert.equal(fork.code, 0, `fork: ${fork.stderr}${fork.stdout}`);
  const forkBody = parseJson(fork);
  assertNoSmithersSurface(forkBody);
  const forkData = forkBody.data as { submitted: boolean; workflow_run_id: string };
  assert.equal(forkData.submitted, true);
  assert.equal(forkData.workflow_run_id, "ultrafuzz-cli-run-forked");

  const pause = await cli(project, ["pause", runData.run_id, "--json"], env);
  assert.equal(pause.code, 0, pause.stderr);
  const pauseBody = parseJson(pause);
  assertNoSmithersSurface(pauseBody);
  const pauseData = pauseBody.data as { action: string; status: string; submitted: boolean };
  assert.equal(pauseData.action, "pause");
  assert.equal(pauseData.status, "pause-requested");
  assert.equal(pauseData.submitted, true);
});

test("status --watch --json keeps a failing poll on one NDJSON line", async () => {
  const project = tempProject();
  const env = fakeSmithersEnv(project);
  const init = await cli(project, ["init", "--json"], env);
  assert.equal(init.code, 0, init.stderr);
  writeSmallTopology(project);
  const run = await cli(project, ["run", "--run-id", "watch-failure-run", "--json"], env);
  assert.equal(run.code, 0, run.stderr);
  const runRoot = (parseJson(run).data as { run_root: string }).run_root;
  // A corrupt state.json now fails closed while verifying sealed control
  // evidence; the typed failure must stay newline-delimited for `jq` consumers.
  fs.writeFileSync(path.join(runRoot, "state.json"), "{ not json", "utf8");

  const watched = await cli(project, ["status", "watch-failure-run", "--watch", "--json"], env);

  assert.equal(watched.code, 1);
  const lines = watched.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const body = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(body.ok, false);
  assert.equal(body.command, "status");
  assert.equal((body.diagnostics as Array<{ code: string }>)[0]?.code, "WORKFLOW_CONTROL_EVIDENCE_INVALID");
});

test("old commands and backend flags are rejected instead of aliased or shimmed", async () => {
  const project = tempProject();
  assert.equal((await cli(project, ["init", "--force"])).code, 0);

  for (const argv of [
    ["doctor", "--json"],
    ["list", "--json"],
    ["restart", "cli-run", "--json"],
    ["continue", "cli-run", "--json"],
    ["dashboard", "--json"],
    ["triage", "cli-run", "--json"],
    ["review", "cli-run", "--json"],
    ["run", "--backend", "mock", "--json"],
    ["materialize", "cli-run", "--patch", "artifacts/node/patch.diff", "--yes", "--json"]
  ]) {
    const rejected = await cli(project, argv);
    assert.notEqual(rejected.code, 0, argv.join(" "));
    const body = parseJson(rejected);
    assert.equal(body.ok, false, JSON.stringify(body));
  }
});

test("references status is restored and reports offline cache state", async () => {
  const project = tempProject();
  assert.equal((await cli(project, ["init", "--force"])).code, 0);
  const previousXdgCacheHome = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = path.join(project, "empty-cache");
  try {
    const status = await cli(project, ["references", "status", "--json"]);
    const body = parseJson(status);

    assert.equal(status.code, 1);
    assert.equal(body.command, "references status");
    assert.equal(body.ok, false);
    const data = body.data as { references?: Array<{ id: string; ok: boolean }> };
    assert.equal(data.references?.length, 10);
    assert.equal(
      data.references?.some((reference) => reference.id === "properties.certora-thinking"),
      true
    );
    assert.equal(
      data.references?.some((reference) => reference.id === "vulnerability-database.web3"),
      true
    );
    assert.equal(
      data.references?.every((reference) => reference.ok === false),
      true
    );
    assert.match(JSON.stringify(body.diagnostics), /ultrafuzz references sync/u);
  } finally {
    if (previousXdgCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = previousXdgCacheHome;
    }
  }
});

test("runtime command failures emit a failing exit code with JSON", async () => {
  const project = tempProject();
  assert.equal((await cli(project, ["init", "--force"])).code, 0);
  writeSmallTopology(project);

  const failed = await cli(project, ["run", "--run-id", "missing-agent", "--agent", "MissingAgent", "--json"]);
  assert.equal(failed.code, 1);
  assert.equal(failed.stderr, "");
  const body = parseJson(failed);
  assert.equal(body.ok, false, JSON.stringify(body));
  assertNoSmithersSurface(body);
  assert.match(JSON.stringify(body.diagnostics), /AGENT_REFERENCE_UNKNOWN/);
});

test("report accepts populated accounting snapshots and preserves partial-pricing marker", async () => {
  const project = tempProject();
  assert.equal((await cli(project, ["init", "--force"])).code, 0);
  writeSmallTopology(project);

  const env = fakeSmithersEnv(project);
  const run = await cli(project, ["run", "--run-id", "report-accounting", "--json"], env);
  assert.equal(run.code, 0, run.stderr);
  const runData = parseJson(run).data as { run_id: string; run_root: string };

  writeRunAccounting(runData.run_root, {
    totalTokens: 56_523,
    tokensUsed: "56,523",
    estimatedSpend: "$0.16+",
    partialPricing: true
  });
  const reportDir = writeFinalReportAccounting(runData.run_root, {
    tokensUsed: "56,523",
    estimatedSpend: "$0.16+",
    partialPricing: true
  });

  const initialReport = await cli(project, ["report", runData.run_id, "--json"]);
  assert.equal(initialReport.code, 0, initialReport.stderr);
  const initialBody = parseJson(initialReport);
  assert.equal(accountingMismatchCount(initialBody), 0);
  assert.equal((initialBody.data as { json_path?: string }).json_path, path.join(reportDir, "report.json"));

  writeRunAccounting(runData.run_root, {
    totalTokens: 725_905,
    tokensUsed: "725,905",
    estimatedSpend: "$1.98+",
    partialPricing: true
  });

  const postSyncReport = await cli(project, ["report", runData.run_id, "--json"]);
  assert.equal(postSyncReport.code, 0, postSyncReport.stderr);
  assert.equal(accountingMismatchCount(parseJson(postSyncReport)), 0);

  writeFinalReportAccounting(runData.run_root, {
    tokensUsed: "56,523",
    estimatedSpend: "$0.16",
    partialPricing: true
  });
  const missingPlusReport = await cli(project, ["report", runData.run_id, "--json"]);
  assert.equal(missingPlusReport.code, 0, missingPlusReport.stderr);
  assert.equal(accountingMismatchCount(parseJson(missingPlusReport)), 0);

  writeRunAccounting(runData.run_root, {
    totalTokens: 725_905,
    tokensUsed: "725,905",
    estimatedSpend: "$1.98",
    partialPricing: true,
    unpricedEventCount: 0
  });
  const inconsistentPartialReport = await cli(project, ["report", runData.run_id, "--json"]);
  assert.equal(inconsistentPartialReport.code, 0, inconsistentPartialReport.stderr);
  assert.equal(accountingMismatchCount(parseJson(inconsistentPartialReport)), 2);

  writeRunAccounting(runData.run_root, {
    totalTokens: 725_905,
    tokensUsed: "725,905",
    estimatedSpend: "$1.98",
    partialPricing: false,
    unpricedEventCount: 0
  });
  writeFinalReportAccounting(runData.run_root, {
    tokensUsed: "56,523",
    estimatedSpend: "$0.16",
    partialPricing: false
  });
  const estimatedReport = await cli(project, ["report", runData.run_id, "--json"]);
  assert.equal(estimatedReport.code, 0, estimatedReport.stderr);
  assert.equal(accountingMismatchCount(parseJson(estimatedReport)), 0);
});

test("report regenerates canonical Markdown from structured issues and non-production outcomes", async () => {
  const project = tempProject();
  assert.equal((await cli(project, ["init", "--force"])).code, 0);
  writeSmallTopology(project);

  const run = await cli(project, ["run", "--run-id", "report-reconciliation", "--json"], fakeSmithersEnv(project));
  assert.equal(run.code, 0, run.stderr);
  const runData = parseJson(run).data as { run_id: string; run_root: string };
  writeRunAccounting(runData.run_root, {
    totalTokens: 321,
    tokensUsed: "321",
    estimatedSpend: "$0.72",
    partialPricing: false
  });

  const reportDir = path.join(runData.run_root, "artifacts", "final-report");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "report.json");
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        schema_version: "1.0",
        run_metadata: {
          source_run_id: "none",
          repository: "https://github.com/example/report-contract",
          elapsed_time: "1h 2m",
          models_used: ["gpt-test xhigh"],
          tokens_used: "unavailable",
          estimated_spend: "unavailable",
          strategy_loops: "8 loops per strategy",
          internal_accounting_note: "must remain structured-only"
        },
        issues: [
          {
            schema_version: "1.0",
            id: "finding-stable-1",
            title: "[M-01] - Structured issue title",
            status: "confirmed",
            severity_guess: "Medium",
            severity: "Medium",
            confidence: "high",
            summary: "Structured issue summary.",
            description:
              "Depositor can exercise the structured path which leads to the recorded state becoming inconsistent.",
            impact: "Medium",
            impact_rationale: "Structured impact rationale.",
            likelihood: "Medium",
            likelihood_rationale: "Structured likelihood rationale.",
            proof_of_concept: {
              scenario: [
                "Depositor prepares the structured state.",
                "Depositor runs the focused check and observes the inconsistency."
              ],
              language: "solidity",
              code: "function testExample() public {}"
            },
            recommendation: "Apply the structured remediation.",
            strategy: "stateful-invariant",
            strategy_provenance: {
              detection_rates: [{ strategy: "stateful-invariant", detections: 2, configured_loops: 8 }],
              attempts: [{ loop_index: 1, model: "internal-test-model" }]
            },
            property_ids: ["property-report-contract-1"],
            lifecycle: {
              dedupe_key: "internal-dedupe-key",
              source_artifacts: ["internal/artifact.json"],
              strategy_hits: ["stateful-invariant"]
            }
          }
        ],
        non_production_outcomes: [
          {
            title: "Review-only outcome",
            triage_classification: "harness-defect",
            status: "non-production",
            summary: "Retained for review.",
            evidence: "Focused harness evidence.",
            strategy_provenance: {
              detection_rates: [{ strategy: "stateful-invariant", detections: 1, configured_loops: 8 }]
            },
            recommended_next_action: "Repair the focused harness.",
            lifecycle: { dedupe_key: "internal-outcome-key", source_artifacts: ["internal/outcome.json"] }
          }
        ],
        property_implementation_coverage: {
          priority_threshold: "high",
          priorities: ["high"],
          selected_property_ids: ["bogus"],
          implemented_property_ids: ["bogus"],
          blocked_property_ids: [],
          pending_property_ids: [],
          deferred_property_ids: []
        },
        property_provenance: [
          {
            finding_id: "finding-stable-1",
            title: "[M-01] - Structured issue title",
            property_ids: ["property-report-contract-1"],
            sources: [
              {
                source_node_id: "property-specification-example",
                source_property_id: "property-specification-example-001"
              }
            ],
            implementation_paths: ["src/Example.sol"],
            test_paths: ["test/ExampleInvariant.t.sol"],
            fuzzer_backend: "echidna"
          }
        ],
        internal_adapter_note: "must not render"
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  fs.mkdirSync(path.join(runData.run_root, "artifacts", "property-specification-fanin"), { recursive: true });
  fs.writeFileSync(
    path.join(runData.run_root, "artifacts", "property-specification-fanin", "properties.json"),
    JSON.stringify({
      schema_version: "ultrafuzz.properties.v1",
      properties: [
        {
          id: "property-report-contract-1",
          description: "Structured report property",
          category: "accounting",
          priority: "high",
          reference_expectations: ["scfuzzbench:aave-v4:iSpoke_supply"],
          sources: [
            {
              source_node_id: "property-specification-example",
              source_property_id: "property-specification-example-001"
            }
          ]
        }
      ]
    }),
    "utf8"
  );
  fs.mkdirSync(path.join(runData.run_root, "artifacts", "stateful-invariant-implement-properties"), {
    recursive: true
  });
  fs.writeFileSync(
    path.join(runData.run_root, "artifacts", "stateful-invariant-implement-properties", "implemented-properties.json"),
    JSON.stringify({
      schema_version: "ultrafuzz.implemented-properties.v1",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: ["property-report-contract-1"] },
      properties: [
        {
          property_id: "property-report-contract-1",
          status: "implemented",
          implementation_paths: ["src/Example.sol"],
          test_paths: ["test/ExampleInvariant.t.sol"]
        }
      ]
    }),
    "utf8"
  );
  fs.mkdirSync(path.join(runData.run_root, "artifacts", "stateful-invariant-campaign"), { recursive: true });
  fs.writeFileSync(
    path.join(runData.run_root, "artifacts", "stateful-invariant-campaign", "recon-fuzzer-results.json"),
    JSON.stringify({
      schema_version: "ultrafuzz.property-campaign.v1",
      fuzzer_backend: "recon",
      failures: [{ id: "finding-stable-1", status: "reproduced", property_ids: ["property-report-contract-1"] }]
    }),
    "utf8"
  );
  fs.writeFileSync(path.join(reportDir, "report.md"), "# Placeholder\n\nunavailable\n", "utf8");

  const repaired = await cli(project, ["report", runData.run_id, "--json"]);
  assert.equal(repaired.code, 0, repaired.stderr);
  assert.equal(accountingMismatchCount(parseJson(repaired)), 0);
  const markdown = fs.readFileSync(path.join(reportDir, "report.md"), "utf8");
  assert.match(
    markdown,
    /^# Ultrafuzz report\n\n\| Issue id \| Title \|\n\| --- \| --- \|\n\| M-01 \| \[\[M-01\] - Structured issue title\]\(#m-01---structured-issue-title\) \|/u
  );
  assert.match(
    markdown,
    /The report contains 1 issues, with severity distribution 0 high, 1 medium, and 0 low\.\n\nUltrafuzz is an automated smart-contract fuzzing campaign assistant\. Issues below are machine-generated findings that must be manually validated\. This report is not a security review and does not guarantee the protocol is secure\./u
  );
  const runSummary = /^## Run summary\n\n(?<body>[\s\S]*?)(?=\n## )/mu.exec(markdown)?.groups?.body;
  assert.ok(runSummary);
  const runSummaryLabels = [...runSummary.matchAll(/^- ([^:]+): `[^`\n]+`$/gmu)].map((match) => match[1]);
  assert.deepEqual(runSummaryLabels, [
    "Run ID",
    "Source run ID",
    "Repository",
    "Elapsed time",
    "Models used",
    "Tokens used",
    "Estimated spend",
    "Strategy loops"
  ]);
  assert.match(
    markdown,
    /## \[M-01\] - Structured issue title\n\nDepositor can exercise the structured path which leads to the recorded state becoming inconsistent\./u
  );
  assert.match(
    markdown,
    /### Severity\n\n- \*\*Impact\*\*: Medium: Structured impact rationale\.\n- \*\*Likelihood\*\*: Medium: Structured likelihood rationale\./u
  );
  assert.match(
    markdown,
    /### Proof of Concept\n\n1\. Depositor prepares the structured state\.\n2\. Depositor runs the focused check and observes the inconsistency\.\n\n```solidity\nfunction testExample\(\) public \{\}\n```/u
  );
  assert.equal(markdown.match(/^```/gmu)?.length, 2);
  assert.match(
    markdown,
    /### Strategy\n\n\| Strategy \| Detection rate \|\n\| --- \| --- \|\n\| stateful-invariant \| 2\/8 \|/u
  );
  assert.match(
    markdown,
    /## Property provenance\n\n\| Finding \| Property IDs \| Source nodes \| Source property IDs \| Implementation\/test paths \| Fuzzer backends \|\n\| --- \| --- \| --- \| --- \| --- \| --- \|\n\| \\\[M-01\\\] - Structured issue title \| property-report-contract-1 \| property-specification-example \| property-specification-example-001 \| src\/Example\.sol<br>test\/ExampleInvariant\.t\.sol \| recon \|/u
  );
  assert.match(markdown, /## Property implementation coverage\n\n- Priority threshold: `high`/u);
  assert.match(markdown, /- Reference expectation properties: `1`/u);
  assert.match(
    markdown,
    /## Non-production actionable outcomes\n\n\| Classification \| Title \| Status \| Evidence \| Strategy provenance \| Recommended next action \|\n\| --- \| --- \| --- \| --- \| --- \| --- \|\n\| harness-defect \| Review-only outcome \| non-production \| Focused harness evidence\. \| stateful-invariant \(1\/8\) \| Repair the focused harness\. \|/u
  );
  assert.doesNotMatch(markdown, /unavailable/iu);
  assert.doesNotMatch(markdown, /#### Sources/u);
  assert.doesNotMatch(markdown, /\*\*Source Node Id\*\*/u);
  assert.doesNotMatch(markdown, /\*\*Source Property Id\*\*/u);
  assert.doesNotMatch(markdown, /Item 1/u);
  assert.doesNotMatch(markdown, /## Executive summary/u);
  assert.doesNotMatch(markdown, /## Issue index/u);
  assert.doesNotMatch(markdown, /## Additional report data/u);
  assert.doesNotMatch(markdown, /^#{3,6} Lifecycle$/imu);
  assert.doesNotMatch(markdown, /^#{3,6} Strategy provenance$/imu);
  assert.doesNotMatch(
    markdown,
    /internal-(?:dedupe|outcome)|internal\/artifact|internal\/outcome|internal-test-model|must remain structured-only|must not render/u
  );
  const json = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
    run_metadata: Record<string, unknown>;
    issues: Array<{ id: string; title: string }>;
    property_provenance: Array<{ finding_id: string; title: string }>;
    property_implementation_coverage: Record<string, unknown>;
  };
  assert.equal(json.run_metadata.tokens_used, "321");
  assert.equal(json.run_metadata.estimated_spend, "$0.72");
  assert.deepEqual(
    json.issues.map(({ id, title }) => ({ id, title })),
    [{ id: "M-01", title: "[M-01] - Structured issue title" }]
  );
  assert.deepEqual(
    json.property_provenance.map(({ finding_id, title }) => ({ finding_id, title })),
    [{ finding_id: "M-01", title: "[M-01] - Structured issue title" }]
  );
  assert.deepEqual(json.property_implementation_coverage, {
    priority_threshold: "high",
    priorities: ["high"],
    selected_property_ids: ["property-report-contract-1"],
    implemented_property_ids: ["property-report-contract-1"],
    blocked_property_ids: [],
    pending_property_ids: [],
    deferred_property_ids: [],
    reference_expected_property_ids: ["property-report-contract-1"],
    reference_expectation_ids: ["scfuzzbench:aave-v4:iSpoke_supply"],
    blocker_summaries: []
  });

  fs.writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        schema_version: "1.0",
        run_metadata: {
          source_run_id: "none",
          repository: "https://github.com/example/report-contract",
          elapsed_time: "1h 2m",
          models_used: ["gpt-test xhigh"],
          strategy_loops: "8 loops per strategy"
        },
        issues: [],
        non_production_outcomes: [
          {
            title: "Bounded non-production outcome",
            triage_classification: "incomplete-spec",
            status: "non-production",
            summary: "Preserved context.",
            evidence: "Bounded review evidence.",
            strategy_provenance: {
              detection_rates: [{ strategy: "stateful-invariant", detections: 1, configured_loops: 8 }]
            },
            recommended_next_action: "Complete the bounded specification."
          }
        ],
        property_provenance: []
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  fs.unlinkSync(path.join(reportDir, "report.md"));
  const recoveredMissingMarkdown = await cli(project, ["report", runData.run_id, "--json"]);
  assert.equal(recoveredMissingMarkdown.code, 0, recoveredMissingMarkdown.stderr);
  const zeroIssueMarkdown = fs.readFileSync(path.join(reportDir, "report.md"), "utf8");
  assert.match(
    zeroIssueMarkdown,
    /^# Ultrafuzz report\n\nUltrafuzz is an automated smart-contract fuzzing campaign assistant\. Issues below are machine-generated findings that must be manually validated\. This report is not a security review and does not guarantee the protocol is secure\./u
  );
  assert.doesNotMatch(zeroIssueMarkdown, /\| Issue id \| Title \|/u);
  assert.doesNotMatch(zeroIssueMarkdown, /The report contains/u);
  assert.doesNotMatch(zeroIssueMarkdown, /^No issues reported\.?$/imu);
  const zeroIssueRunSummary = /^## Run summary\n\n(?<body>[\s\S]*?)(?=\n## )/mu.exec(zeroIssueMarkdown)?.groups?.body;
  assert.ok(zeroIssueRunSummary);
  assert.equal([...zeroIssueRunSummary.matchAll(/^- [^:]+: `[^`\n]+`$/gmu)].length, 8);
  assert.ok(zeroIssueMarkdown.indexOf("## Property provenance") < zeroIssueMarkdown.indexOf("## Non-production"));
  assert.match(zeroIssueMarkdown, /## Property provenance\n\nNo property-derived findings\./u);
  assert.match(
    zeroIssueMarkdown,
    /## Non-production actionable outcomes\n\n\| Classification \| Title \| Status \| Evidence \| Strategy provenance \| Recommended next action \|\n\| --- \| --- \| --- \| --- \| --- \| --- \|\n\| incomplete-spec \| Bounded non-production outcome \| non-production \| Bounded review evidence\. \| stateful-invariant \(1\/8\) \| Complete the bounded specification\. \|/u
  );
  assert.doesNotMatch(zeroIssueMarkdown, /## Executive summary|## Issue index|## Additional report data/u);
  assert.doesNotMatch(zeroIssueMarkdown, /^#{3,6} (?:Lifecycle|Strategy provenance)$/imu);
});

test("report reconciliation normalizes alternate severities, recovers source runs, and preserves unavailable provenance", async () => {
  const project = tempProject();
  const runData = await createReportRun(project, "report-structured-reconciliation");
  const runMetadataPath = path.join(runData.run_root, "run.json");
  const statePath = path.join(runData.run_root, "state.json");
  writeJsonRecord(runMetadataPath, {
    ...(JSON.parse(fs.readFileSync(runMetadataPath, "utf8")) as Record<string, unknown>),
    source_run_id: "source-from-run"
  });
  writeJsonRecord(statePath, {
    ...(JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>),
    source_run_id: "source-from-state"
  });

  const reportDir = path.join(runData.run_root, "artifacts", "final-report");
  const reportPath = path.join(reportDir, "report.json");
  fs.mkdirSync(reportDir, { recursive: true });
  writeJsonRecord(reportPath, {
    schema_version: "1.0",
    run_metadata: { source_run_id: "stale-source" },
    issues: [
      {
        schema_version: "1.0",
        id: "structured-severity",
        title: "Structured severity finding",
        status: "confirmed",
        severity: "Critical",
        severity_guess: "Critical",
        final_severity: "Critical",
        confidence: "high",
        summary: "A structured state transition violates the expected relationship.",
        description: "A caller can reach a state that violates the documented relationship.",
        impact: "Medium",
        impact_rationale: "The affected state remains bounded.",
        likelihood: "Low",
        likelihood_rationale: "The transition requires uncommon preconditions.",
        proof_of_concept: {
          scenario: ["Prepare the bounded state.", "Execute the transition and observe the mismatch."]
        },
        recommendation: "Enforce the relationship before committing state.",
        strategy: "stateful-invariant",
        strategy_provenance: {
          detection_rates: [{ strategy: "stateful-invariant", detections: 1, configured_loops: 4 }]
        },
        lifecycle: {
          severity: "Critical",
          final_severity: "Critical",
          canonical_severity: "Critical"
        }
      }
    ],
    non_production_outcomes: [],
    property_provenance: "unavailable"
  });

  const reconciled = await cli(project, ["report", runData.run_id, "--json"]);
  assert.equal(reconciled.code, 0, reconciled.stderr);
  let report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
    run_metadata: { source_run_id?: string };
    issues: Array<{ id: string; severity?: string; severity_guess?: string }>;
    property_provenance?: unknown;
  };
  assert.equal(report.run_metadata.source_run_id, "source-from-run");
  assert.equal(report.issues[0]?.severity, "Low");
  assert.equal(report.issues[0]?.severity_guess, "Low");
  assert.equal(report.property_provenance, "unavailable");
  assert.doesNotMatch(JSON.stringify(report), /Critical/u);

  const runMetadata = JSON.parse(fs.readFileSync(runMetadataPath, "utf8")) as Record<string, unknown>;
  delete runMetadata.source_run_id;
  writeJsonRecord(runMetadataPath, runMetadata);
  const stateFallback = await cli(project, ["report", runData.run_id, "--json"]);
  assert.equal(stateFallback.code, 0, stateFallback.stderr);
  report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as typeof report;
  assert.equal(report.run_metadata.source_run_id, "source-from-state");
});

test("report reconciliation links dedicated audit context and preserves dynamic discovery provenance", async () => {
  const project = tempProject();
  const runData = await createReportRun(project, "report-threat-provenance");
  const artifactsRoot = path.join(runData.run_root, "artifacts");
  const threatDir = path.join(artifactsRoot, "threat-model");
  const goalPlanDir = path.join(artifactsRoot, "goal-plan");
  const severityDir = path.join(artifactsRoot, "severity-classification");
  const reportDir = path.join(artifactsRoot, "final-report");
  for (const directory of [threatDir, goalPlanDir, severityDir, reportDir])
    fs.mkdirSync(directory, { recursive: true });

  fs.writeFileSync(path.join(threatDir, "THREAT_MODEL.md"), "# Threat model\n\nDETAIL-MUST-STAY-DEDICATED\n", "utf8");
  writeJsonRecord(path.join(threatDir, "threat-model.json"), { schema_version: "test" });
  writeJsonRecord(path.join(goalPlanDir, "goal-plan.json"), { schema_version: "test" });
  const sourceNodes = ["dynamic:threat:liquidation:overdue", "dynamic:class:liquidation:fixed-term-before-overdue"];
  fs.writeFileSync(
    path.join(severityDir, "severity-classified-findings.json"),
    `${JSON.stringify([
      {
        id: "finding-overdue",
        source_node_id: sourceNodes[0],
        source_nodes: sourceNodes
      }
    ])}\n`,
    "utf8"
  );
  writeJsonRecord(path.join(reportDir, "report.json"), {
    schema_version: "1.0",
    run_metadata: {},
    issues: [
      {
        schema_version: "1.0",
        id: "finding-overdue",
        title: "Fixed-term liquidation before overdue",
        status: "confirmed",
        severity: "High",
        severity_guess: "High",
        confidence: "high",
        summary: "A fixed-term position can be liquidated before its overdue boundary.",
        description: "A liquidator can seize collateral before the documented lifecycle boundary.",
        impact: "High",
        impact_rationale: "Borrower collateral can be seized prematurely.",
        likelihood: "Medium",
        likelihood_rationale: "The path is permissionless when a fixed-term position exists.",
        proof_of_concept: { scenario: ["Open a fixed-term position.", "Liquidate it before it is overdue."] },
        strategy: "goal-hunter",
        strategy_provenance: {
          detection_rates: [{ strategy: "goal-hunter", detections: 2, configured_loops: 2 }]
        }
      }
    ],
    non_production_outcomes: [],
    property_provenance: []
  });

  const rendered = await cli(project, ["report", runData.run_id, "--json"]);
  assert.equal(rendered.code, 0, rendered.stderr);
  const markdown = fs.readFileSync(path.join(reportDir, "report.md"), "utf8");
  assert.match(
    markdown,
    /## Audit context\n\n- Threat model: \[THREAT_MODEL\.md\]\(\.\.\/threat-model\/THREAT_MODEL\.md\); \[threat-model\.json\]\(\.\.\/threat-model\/threat-model\.json\)\n- Goal plan: \[goal-plan\.json\]\(\.\.\/goal-plan\/goal-plan\.json\)/u
  );
  assert.match(
    markdown,
    /- \*\*Source nodes\*\*: `dynamic:threat:liquidation:overdue`, `dynamic:class:liquidation:fixed-term-before-overdue`/u
  );
  assert.doesNotMatch(markdown, /DETAIL-MUST-STAY-DEDICATED/u);
  const report = JSON.parse(fs.readFileSync(path.join(reportDir, "report.json"), "utf8")) as {
    issues: Array<{ source_node_id?: string; source_nodes?: string[] }>;
  };
  assert.equal(report.issues[0]?.source_node_id, sourceNodes[0]);
  assert.deepEqual(report.issues[0]?.source_nodes, sourceNodes);
});

test("canonical report Markdown neutralizes injected markup and redacts secrets and internal paths", async () => {
  const project = tempProject();
  const runData = await createReportRun(project, "report-public-prose");
  const reportDir = path.join(runData.run_root, "artifacts", "final-report");
  fs.mkdirSync(reportDir, { recursive: true });
  writeJsonRecord(path.join(reportDir, "report.json"), {
    schema_version: "1.0",
    run_metadata: {},
    issues: [
      {
        schema_version: "1.0",
        id: "public-prose-finding",
        title: "Markup <script>alert(1)</script> title",
        status: "confirmed",
        severity: "Medium",
        severity_guess: "Medium",
        confidence: "high",
        summary: "Public summary.",
        description:
          "Summary with token=synthetic-report-value and /home/runner/private/reproducer.sol.\n## Injected heading\n[click](https://example.invalid) ![pixel](https://example.invalid/pixel.png) <img src=x onerror=alert(1)>",
        impact: "Medium",
        impact_rationale: "Bounded impact <em>must not become HTML</em>.",
        likelihood: "Medium",
        likelihood_rationale: "Ordinary preconditions.",
        proof_of_concept: {
          scenario: ["Prepare the state.", "Run the check with <iframe src=x></iframe> input."]
        },
        recommendation: "Validate the transition.",
        strategy: "stateful-invariant",
        strategy_provenance: {
          detection_rates: [{ strategy: "stateful-invariant", detections: 2, configured_loops: 5 }]
        }
      }
    ],
    non_production_outcomes: [],
    property_provenance: []
  });

  const rendered = await cli(project, ["report", runData.run_id, "--json"]);
  assert.equal(rendered.code, 0, `${rendered.stderr}${rendered.stdout}`);
  const markdown = fs.readFileSync(path.join(reportDir, "report.md"), "utf8");
  assert.doesNotMatch(markdown, /synthetic-report-value/u);
  assert.doesNotMatch(markdown, /\/home\/runner\/private\/reproducer\.sol/u);
  assert.doesNotMatch(markdown, /<(?:script|img|iframe|em)\b/iu);
  assert.doesNotMatch(markdown, /^## Injected heading$/mu);
  assert.doesNotMatch(markdown, /(?<!\\)\[click\]\(/u);
  assert.doesNotMatch(markdown, /(?<!\\)!\[pixel\]\(/u);
});

test("canonical production reports require an exact strategy rate but accept a prose-only proof of concept", async () => {
  const project = tempProject();
  const runData = await createReportRun(project, "report-evidence-requirements");
  const reportDir = path.join(runData.run_root, "artifacts", "final-report");
  const reportPath = path.join(reportDir, "report.json");
  fs.mkdirSync(reportDir, { recursive: true });
  const report: Record<string, unknown> = {
    schema_version: "1.0",
    run_metadata: {},
    issues: [
      {
        schema_version: "1.0",
        id: "evidence-requirements",
        title: "Evidence requirements",
        status: "confirmed",
        severity: "Medium",
        severity_guess: "Medium",
        confidence: "high",
        summary: "The bounded check demonstrates a state mismatch.",
        description: "The bounded check demonstrates a state mismatch.",
        impact: "Medium",
        impact_rationale: "The mismatch affects bounded state.",
        likelihood: "Medium",
        likelihood_rationale: "The check exercises ordinary inputs.",
        proof_of_concept: {
          scenario: ["Prepare the bounded state.", "Execute the check and observe the mismatch."]
        },
        recommendation: "Validate the state relationship.",
        strategy: "stateful-invariant",
        strategy_provenance: {
          detection_rates: [{ strategy: "stateful-invariant" }]
        }
      }
    ],
    non_production_outcomes: [],
    property_provenance: []
  };
  writeJsonRecord(reportPath, report);

  const missingRate = await cli(project, ["report", runData.run_id, "--json"]);
  assert.equal(missingRate.code, 1);
  assert.match(JSON.stringify(parseJson(missingRate).diagnostics), /strategy|detection|historical|Markdown/iu);
  assert.equal(fs.existsSync(path.join(reportDir, "report.md")), false);

  const issue = (report.issues as Array<Record<string, unknown>>)[0]!;
  issue.strategy_provenance = {
    detection_rates: [{ strategy: "stateful-invariant", detections: 3, configured_loops: 6 }]
  };
  writeJsonRecord(reportPath, report);
  const proseOnlyProof = await cli(project, ["report", runData.run_id, "--json"]);
  assert.equal(proseOnlyProof.code, 0, proseOnlyProof.stderr);
  const markdown = fs.readFileSync(path.join(reportDir, "report.md"), "utf8");
  assert.match(markdown, /1\. Prepare the bounded state\./u);
  assert.match(markdown, /2\. Execute the check and observe the mismatch\./u);
  assert.equal(markdown.match(/^```/gmu)?.length ?? 0, 0);
  assert.match(markdown, /\| stateful-invariant \| 3\/6 \|/u);
});

test("current invariant reports with malformed issues fail closed instead of preserving stale coverage", async () => {
  const project = tempProject();
  const runData = await createReportRun(project, "report-current-malformed");
  const reportDir = path.join(runData.run_root, "artifacts", "final-report");
  const reportPath = path.join(reportDir, "report.json");
  fs.mkdirSync(reportDir, { recursive: true });
  fs.mkdirSync(path.join(runData.run_root, "artifacts", "property-specification-fanin"), { recursive: true });
  fs.mkdirSync(path.join(runData.run_root, "artifacts", "stateful-invariant-implement-properties"), {
    recursive: true
  });
  writeJsonRecord(path.join(runData.run_root, "artifacts", "property-specification-fanin", "properties.json"), {
    schema_version: "ultrafuzz.properties.v1",
    properties: []
  });
  writeJsonRecord(
    path.join(runData.run_root, "artifacts", "stateful-invariant-implement-properties", "implemented-properties.json"),
    {
      schema_version: "ultrafuzz.implemented-properties.v1",
      selection: { priority_threshold: "high", priorities: ["high"], property_ids: [] },
      properties: []
    }
  );
  writeJsonRecord(reportPath, {
    schema_version: "1.0",
    run_metadata: {},
    issues: [
      {
        schema_version: "1.0",
        id: "malformed-current",
        title: "Malformed current issue",
        status: "confirmed",
        severity_guess: "Medium",
        confidence: "high",
        summary: "Missing renderable evidence."
      }
    ],
    non_production_outcomes: [],
    property_implementation_coverage: "unavailable"
  });
  fs.writeFileSync(path.join(reportDir, "report.md"), "# historical placeholder\n", "utf8");

  const result = await cli(project, ["report", runData.run_id, "--json"]);
  assert.equal(result.code, 1);
  assert.match(
    JSON.stringify(parseJson(result).diagnostics),
    /current invariant final report|historical|renderable|FINDINGS_SCHEMA_INVALID/iu
  );
});

test("historical loose reports preserve conforming Markdown and reject missing or nonconforming Markdown", async () => {
  const project = tempProject();
  const runData = await createReportRun(project, "report-historical-compatibility");
  const reportDir = path.join(runData.run_root, "artifacts", "final-report");
  const reportPath = path.join(reportDir, "report.json");
  const markdownPath = path.join(reportDir, "report.md");
  fs.mkdirSync(reportDir, { recursive: true });
  writeJsonRecord(reportPath, {
    schema_version: "1.0",
    run_metadata: {},
    issues: [
      {
        schema_version: "1.0",
        id: "historical-issue",
        title: "Historical issue",
        status: "confirmed",
        severity: "Medium",
        severity_guess: "Medium",
        confidence: "high",
        summary: "Historical public summary."
      }
    ],
    non_production_outcomes: []
  });
  const historicalMarkdown = [
    "# Ultrafuzz report",
    "",
    "| Issue id | Title |",
    "| --- | --- |",
    "| M-01 | [[M-01] - Historical issue](#m-01---historical-issue) |",
    "",
    "The report contains 1 issues, with severity distribution 0 high, 1 medium, and 0 low.",
    "",
    "Ultrafuzz is an automated smart-contract fuzzing campaign assistant. Issues below are machine-generated findings that must be manually validated. This report is not a security review and does not guarantee the protocol is secure.",
    "",
    "## Run summary",
    "",
    "- Run ID: `historical-run`",
    "- Source run ID: `none`",
    "- Repository: `unavailable`",
    "- Elapsed time: `unavailable`",
    "- Models used: `unavailable`",
    "- Tokens used: `unavailable`",
    "- Estimated spend: `unavailable`",
    "- Strategy loops: `unavailable`",
    "",
    "## [M-01] - Historical issue",
    "",
    "Historical public summary.",
    "",
    "### Severity",
    "",
    "- **Impact**: Medium: Historical impact rationale.",
    "- **Likelihood**: Medium: Historical likelihood rationale.",
    "",
    "### Proof of Concept",
    "",
    "1. Prepare the historical state and observe the mismatch.",
    "",
    "### Strategy",
    "",
    "| Strategy | Detection rate |",
    "| --- | --- |",
    "| stateful-invariant | 1/2 |",
    "",
    "## Property provenance",
    "",
    "No property-derived findings.",
    ""
  ].join("\n");
  fs.writeFileSync(markdownPath, historicalMarkdown, "utf8");

  const preserved = await cli(project, ["report", runData.run_id, "--json"]);
  assert.equal(preserved.code, 0, `${preserved.stderr}${preserved.stdout}`);
  assert.equal(fs.readFileSync(markdownPath, "utf8"), historicalMarkdown);

  fs.writeFileSync(markdownPath, "# Historical agent report\n", "utf8");
  const nonconforming = await cli(project, ["report", runData.run_id, "--json"]);
  assert.equal(nonconforming.code, 1);
  assert.match(JSON.stringify(parseJson(nonconforming).diagnostics), /historical|Markdown|final-review/iu);

  // A preserved agent report is only gated by the directive shape check, so its links must be
  // restricted to in-document anchors and safe report-relative audit-context artifacts.
  const withLink = (link: string): string =>
    historicalMarkdown.replace("Historical public summary.", `Historical public summary. [context](${link})`);
  for (const rejected of [
    "https://example.invalid",
    "mailto:someone@example.invalid",
    "javascript:alert(1)",
    "/etc/passwd",
    "../../../../etc/passwd",
    "../threat-model/../../../escape.md"
  ]) {
    fs.writeFileSync(markdownPath, withLink(rejected), "utf8");
    const result = await cli(project, ["report", runData.run_id, "--json"]);
    assert.equal(result.code, 1, `link ${rejected} must be rejected`);
    assert.match(JSON.stringify(parseJson(result).diagnostics), /historical|Markdown|final-review/iu);
  }
  for (const accepted of ["#m-01---historical-issue", "../threat-model/THREAT_MODEL.md"]) {
    fs.writeFileSync(markdownPath, withLink(accepted), "utf8");
    const result = await cli(project, ["report", runData.run_id, "--json"]);
    assert.equal(result.code, 0, `link ${accepted} must be accepted: ${result.stderr}${result.stdout}`);
  }

  fs.unlinkSync(markdownPath);
  const missing = await cli(project, ["report", runData.run_id, "--json"]);
  assert.equal(missing.code, 1);
  assert.match(JSON.stringify(parseJson(missing).diagnostics), /historical|Markdown|missing/iu);
});

test("report bundle creates a portable ZIP without workspaces or stale report backups", async () => {
  const project = tempProject();
  assert.equal((await cli(project, ["init", "--force"])).code, 0);
  writeSmallTopology(project);

  const env = fakeSmithersEnv(project);
  const run = await cli(project, ["run", "--run-id", "report-bundle", "--json"], env);
  assert.equal(run.code, 0, run.stderr);
  const runData = parseJson(run).data as { run_id: string; run_root: string };

  const artifactDir = path.join(runData.run_root, "artifacts", "project-discovery");
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "stdout.txt"), "generated stdout\n", "utf8");
  fs.writeFileSync(path.join(artifactDir, "bad\\name.txt"), "unsafe archive path\n", "utf8");
  const goalPlanDir = path.join(runData.run_root, "artifacts", "goal-plan");
  const selectedClassPath = "vulnerability-db/selected/liquidation/fixed-term-before-overdue.md";
  fs.mkdirSync(path.dirname(path.join(goalPlanDir, selectedClassPath)), { recursive: true });
  fs.writeFileSync(path.join(goalPlanDir, "goal-plan.json"), "{}\n", "utf8");
  fs.writeFileSync(path.join(goalPlanDir, "vulnerability-db-manifest.json"), "{}\n", "utf8");
  fs.writeFileSync(path.join(goalPlanDir, selectedClassPath), "# Fixed-term liquidation before overdue\n", "utf8");
  writeArtifactManifest({
    layout: layoutForRunRoot(runData.run_root, runData.run_id),
    nodeId: "goal-plan",
    include: ["goal-plan.json", "vulnerability-db-manifest.json", selectedClassPath]
  });
  const reportDir = writeFinalReportAccounting(runData.run_root, {
    tokensUsed: "123",
    estimatedSpend: "$0.46",
    partialPricing: false
  });
  fs.writeFileSync(path.join(reportDir, "report.md"), "# Placeholder\n\nunavailable\n", "utf8");
  writeArtifactManifest({
    layout: layoutForRunRoot(runData.run_root, runData.run_id),
    nodeId: "final-report",
    include: ["report.md", "report.json"],
    outputs: [
      {
        path: "report.md",
        contract: "ultrafuzz/nonempty-markdown@1",
        contract_digest: artifactContractDefinition("ultrafuzz/nonempty-markdown@1").digest,
        primary: true
      },
      {
        path: "report.json",
        contract: "ultrafuzz/report@1",
        contract_digest: artifactContractDefinition("ultrafuzz/report@1").digest,
        primary: true
      }
    ]
  });
  fs.writeFileSync(path.join(reportDir, "report.json.pre-old"), '{"stale":true}\n', "utf8");
  const workspaceDir = path.join(runData.run_root, "workspaces", "project-discovery");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "large-cache.txt"), "do not bundle\n", "utf8");
  const engineLogDir = path.join(runData.run_root, "smithers", "logs");
  fs.mkdirSync(engineLogDir, { recursive: true });
  fs.writeFileSync(path.join(engineLogDir, "stream.ndjson"), '{"event":"retry"}\n', "utf8");

  const bundled = await cli(project, ["report", "bundle", runData.run_id, "--json"]);
  assert.equal(bundled.code, 0, bundled.stderr);
  const body = parseJson(bundled);
  assertNoSmithersSurface(body);
  assert.match(JSON.stringify(body.diagnostics), /REPORT_BUNDLE_FILE_SKIPPED/u);
  const data = body.data as { zip_path: string; bytes: number; sha256: string; entry_count: number };
  assert.equal(fs.existsSync(data.zip_path), true);
  assert.equal(data.bytes, fs.statSync(data.zip_path).size);
  assert.match(data.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(data.entry_count > 0, true);

  const zip = new AdmZip(data.zip_path);
  const entries = zip
    .getEntries()
    .filter((entry) => !entry.isDirectory)
    .map((entry) => entry.entryName)
    .sort();
  assert.equal(entries.includes("bundle-manifest.json"), true);
  assert.equal(entries.includes("artifacts/final-report/report.md"), true);
  assert.equal(entries.includes("artifacts/final-report/report.json"), true);
  assert.equal(entries.includes("artifacts/project-discovery/stdout.txt"), true);
  assert.equal(entries.includes(`artifacts/goal-plan/${selectedClassPath}`), true);
  assert.equal(entries.includes("run.json"), true);
  assert.equal(entries.includes("state.json"), true);
  assert.equal(
    entries.some((entry) => entry.startsWith("workspaces/")),
    false
  );
  assert.equal(
    entries.some((entry) => entry.includes("\\")),
    false
  );
  assert.equal(entries.includes("artifacts/final-report/report.json.pre-old"), false);
  // Engine retry/validation evidence must reach an operator bundle, under a
  // neutral prefix so the archive never names the orchestration engine.
  assert.equal(entries.includes("engine-logs/stream.ndjson"), true);
  assert.equal(zip.readAsText("engine-logs/stream.ndjson"), '{"event":"retry"}\n');
  assert.equal(
    entries.some((entry) => /smithers/iu.test(entry)),
    false
  );
  const bundledMarkdown = zip.readAsText("artifacts/final-report/report.md");
  assert.doesNotMatch(bundledMarkdown, /Placeholder/iu);
  assert.match(bundledMarkdown, /- Tokens used: `123`/u);
  assert.match(bundledMarkdown, /- Estimated spend: `\$0\.46`/u);
  const goalPlanManifest = JSON.parse(zip.readAsText("artifacts/goal-plan/artifact-manifest.json")) as {
    files: Array<{ path: string }>;
  };
  assert.equal(
    goalPlanManifest.files.some((entry) => entry.path === selectedClassPath),
    true
  );
  const finalReportManifest = JSON.parse(zip.readAsText("artifacts/final-report/artifact-manifest.json")) as {
    files: Array<{ path: string; size_bytes: number; sha256: string }>;
  };
  assert.equal(
    finalReportManifest.files.some((entry) => /^report\.json\.pre-/u.test(entry.path)),
    false
  );
  for (const entry of finalReportManifest.files) {
    assert.ok(zip.getEntry(`artifacts/final-report/${entry.path}`), entry.path);
  }
  for (const relativePath of ["report.md", "report.json"]) {
    const bytes = zip.readFile(`artifacts/final-report/${relativePath}`);
    const entry = finalReportManifest.files.find((candidate) => candidate.path === relativePath);
    assert.ok(bytes, relativePath);
    assert.ok(entry, relativePath);
    assert.equal(entry.size_bytes, bytes.length);
    assert.equal(entry.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  }

  const existing = await cli(project, ["report", "bundle", runData.run_id, "--json"]);
  assert.equal(existing.code, 1);
  assert.match(JSON.stringify(parseJson(existing).diagnostics), /already exists/u);

  const forced = await cli(project, ["report", "bundle", runData.run_id, "--force", "--json"]);
  assert.equal(forced.code, 0, forced.stderr);

  const customPath = "attachments/custom-report-bundle.zip";
  const custom = await cli(project, ["report", "bundle", runData.run_id, "--output", customPath, "--json"]);
  assert.equal(custom.code, 0, custom.stderr);
  const customData = parseJson(custom).data as { zip_path: string };
  assert.equal(customData.zip_path, path.join(project, customPath));

  const symlinkOutput = path.join(project, "attachments", "symlink-output.zip");
  fs.symlinkSync(path.join(project, "missing-target.zip"), symlinkOutput);
  const symlinkAttempt = await cli(project, [
    "report",
    "bundle",
    runData.run_id,
    "--output",
    symlinkOutput,
    "--force",
    "--json"
  ]);
  assert.equal(symlinkAttempt.code, 1);
  assert.match(JSON.stringify(parseJson(symlinkAttempt).diagnostics), /symlink/u);

  const realOutputDir = path.join(project, "real-output");
  const linkedOutputDir = path.join(project, "linked-output");
  fs.mkdirSync(realOutputDir, { recursive: true });
  fs.symlinkSync(realOutputDir, linkedOutputDir, "dir");
  const linkedParentAttempt = await cli(project, [
    "report",
    "bundle",
    runData.run_id,
    "--output",
    "linked-output/bundle.zip",
    "--json"
  ]);
  assert.equal(linkedParentAttempt.code, 1);
  assert.match(JSON.stringify(parseJson(linkedParentAttempt).diagnostics), /symlink/u);
});

test("report bundle packages incomplete runs without a final-report JSON", async () => {
  const project = tempProject();
  const runData = await createReportRun(project, "report-bundle-incomplete");

  const bundled = await cli(project, ["report", "bundle", runData.run_id, "--json"]);
  assert.equal(bundled.code, 0, bundled.stderr);
  const data = parseJson(bundled).data as { zip_path: string };
  const zip = new AdmZip(data.zip_path);
  const entries = zip
    .getEntries()
    .filter((entry) => !entry.isDirectory)
    .map((entry) => entry.entryName);
  assert.equal(entries.includes("bundle-manifest.json"), true);
  assert.equal(entries.includes("run.json"), true);
  assert.equal(entries.includes("state.json"), true);
  assert.equal(
    entries.some((entry) => /^artifacts\/final-report[^/]*\/report\.json$/u.test(entry)),
    false
  );
});
