import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FINDINGS_SCHEMA_VERSION,
  REPORT_SCHEMA_VERSION,
  artifactContractDefinition,
  artifactContractSchemaBinding,
  layoutForRunRoot,
  writeArtifactManifest
} from "@ultrafuzz/artifacts";
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
        schema_version: REPORT_SCHEMA_VERSION,
        run_metadata: {
          run_id: path.basename(runRoot),
          source_run_id: "none",
          repository: "unavailable",
          elapsed_time: "unavailable",
          models_used: [],
          tokens_used: accounting.tokensUsed,
          estimated_spend: accounting.estimatedSpend,
          partial_pricing: accounting.partialPricing,
          strategy_loops: 1,
          source_run_ids: []
        },
        issues: [],
        non_production_outcomes: [],
        property_provenance: []
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return reportDir;
}

function currentReport(runId: string, issues: Record<string, unknown>[] = []): Record<string, unknown> {
  return {
    schema_version: REPORT_SCHEMA_VERSION,
    run_metadata: {
      run_id: runId,
      source_run_id: "none",
      repository: "unavailable",
      elapsed_time: "unavailable",
      models_used: [],
      tokens_used: "unavailable",
      estimated_spend: "unavailable",
      partial_pricing: false,
      strategy_loops: 1
    },
    issues,
    non_production_outcomes: [],
    property_provenance: []
  };
}

function currentReportIssue(id = "finding-1"): Record<string, unknown> {
  return {
    schema_version: FINDINGS_SCHEMA_VERSION,
    id,
    title: "[M-01] - Canonical finding",
    status: "confirmed",
    severity_guess: "Medium",
    confidence: "high",
    summary: "A bounded state transition violates the expected relationship.",
    description: "A caller can reach a state that violates the documented relationship.",
    severity: "Medium",
    impact: "Medium",
    likelihood: "Medium",
    impact_rationale: "The affected state remains bounded.",
    likelihood_rationale: "The transition uses ordinary preconditions.",
    severity_rationale: "Medium impact and Medium likelihood map to Medium.",
    proof_of_concept: {
      scenario: ["Prepare the bounded state.", "Execute the transition and observe the mismatch."],
      language: "solidity",
      code: "function testCanonicalFinding() public {}"
    },
    lifecycle: {
      dedupe_key: `dedupe-${id}`,
      source_artifacts: [],
      strategy_hits: []
    }
  };
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
    tokensUsed: "123",
    estimatedSpend: "$0.46+",
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
    assert.equal(data.references?.length, 9);
    assert.equal(
      data.references?.some((reference) => reference.id === "properties.certora-thinking"),
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
  assert.equal(accountingMismatchCount(parseJson(missingPlusReport)), 2);

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

test("report validates current artifacts without rewriting agent-owned bytes", async () => {
  const project = tempProject();
  const runData = await createReportRun(project, "report-current-artifacts");
  const reportDir = path.join(runData.run_root, "artifacts", "final-report");
  const reportPath = path.join(reportDir, "report.json");
  const markdownPath = path.join(reportDir, "report.md");
  fs.mkdirSync(reportDir, { recursive: true });
  writeJsonRecord(reportPath, currentReport(runData.run_id));
  fs.writeFileSync(markdownPath, "# Agent-authored report\n\nNo issues reported.\n", "utf8");
  const jsonBefore = fs.readFileSync(reportPath);
  const markdownBefore = fs.readFileSync(markdownPath);

  const result = await cli(project, ["report", runData.run_id, "--json"]);

  assert.equal(result.code, 0, result.stderr);
  const data = parseJson(result).data as { json_path: string; markdown_path: string; source: string };
  assert.equal(data.json_path, reportPath);
  assert.equal(data.markdown_path, markdownPath);
  assert.equal(data.source, "validated-agent-report");
  assert.deepEqual(fs.readFileSync(reportPath), jsonBefore);
  assert.deepEqual(fs.readFileSync(markdownPath), markdownBefore);
});

test("report rejects final_severity compatibility aliases without rewriting artifacts", async () => {
  const project = tempProject();
  const runData = await createReportRun(project, "report-rejects-severity-alias");
  const reportDir = path.join(runData.run_root, "artifacts", "final-report");
  const reportPath = path.join(reportDir, "report.json");
  const markdownPath = path.join(reportDir, "report.md");
  fs.mkdirSync(reportDir, { recursive: true });
  writeJsonRecord(reportPath, currentReport(runData.run_id, [{ ...currentReportIssue(), final_severity: "Medium" }]));
  fs.writeFileSync(markdownPath, "# Agent-authored report\n", "utf8");
  const jsonBefore = fs.readFileSync(reportPath);
  const markdownBefore = fs.readFileSync(markdownPath);

  const result = await cli(project, ["report", runData.run_id, "--json"]);

  assert.equal(result.code, 1);
  assert.match(JSON.stringify(parseJson(result).diagnostics), /ARTIFACT_SCHEMA_INVALID|additional propert/iu);
  assert.deepEqual(fs.readFileSync(reportPath), jsonBefore);
  assert.deepEqual(fs.readFileSync(markdownPath), markdownBefore);
});

test("report does not synthesize missing Markdown", async () => {
  const project = tempProject();
  const runData = await createReportRun(project, "report-missing-markdown");
  const reportDir = path.join(runData.run_root, "artifacts", "final-report");
  const reportPath = path.join(reportDir, "report.json");
  const markdownPath = path.join(reportDir, "report.md");
  fs.mkdirSync(reportDir, { recursive: true });
  writeJsonRecord(reportPath, currentReport(runData.run_id));
  const jsonBefore = fs.readFileSync(reportPath);

  const result = await cli(project, ["report", runData.run_id, "--json"]);

  assert.equal(result.code, 1);
  assert.match(JSON.stringify(parseJson(result).diagnostics), /report Markdown path does not exist/iu);
  assert.equal(fs.existsSync(markdownPath), false);
  assert.deepEqual(fs.readFileSync(reportPath), jsonBefore);
});

test("report accepts canonical severity and complete proof without rewriting either artifact", async () => {
  const project = tempProject();
  const runData = await createReportRun(project, "report-canonical-severity");
  const reportDir = path.join(runData.run_root, "artifacts", "final-report");
  const reportPath = path.join(reportDir, "report.json");
  const markdownPath = path.join(reportDir, "report.md");
  fs.mkdirSync(reportDir, { recursive: true });
  writeJsonRecord(reportPath, currentReport(runData.run_id, [currentReportIssue()]));
  fs.writeFileSync(markdownPath, "# Canonical agent-authored report\n", "utf8");
  const jsonBefore = fs.readFileSync(reportPath);
  const markdownBefore = fs.readFileSync(markdownPath);

  const result = await cli(project, ["report", runData.run_id, "--json"]);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(reportPath), jsonBefore);
  assert.deepEqual(fs.readFileSync(markdownPath), markdownBefore);
  const report = JSON.parse(jsonBefore.toString("utf8")) as { issues: Array<Record<string, unknown>> };
  assert.equal(report.issues[0]?.severity, "Medium");
  assert.equal(Object.hasOwn(report.issues[0] ?? {}, "final_severity"), false);
});

test("current reports with malformed issues fail closed without preserving stale bytes", async () => {
  const project = tempProject();
  const runData = await createReportRun(project, "report-current-malformed");
  const reportDir = path.join(runData.run_root, "artifacts", "final-report");
  const reportPath = path.join(reportDir, "report.json");
  const markdownPath = path.join(reportDir, "report.md");
  fs.mkdirSync(reportDir, { recursive: true });
  writeJsonRecord(
    reportPath,
    currentReport(runData.run_id, [
      {
        schema_version: FINDINGS_SCHEMA_VERSION,
        id: "malformed-current",
        title: "Malformed current issue",
        status: "confirmed",
        severity_guess: "Medium",
        confidence: "high",
        summary: "Missing required report evidence."
      }
    ])
  );
  fs.writeFileSync(markdownPath, "# Agent-authored malformed report\n", "utf8");
  const jsonBefore = fs.readFileSync(reportPath);
  const markdownBefore = fs.readFileSync(markdownPath);

  const result = await cli(project, ["report", runData.run_id, "--json"]);

  assert.equal(result.code, 1);
  assert.match(JSON.stringify(parseJson(result).diagnostics), /ARTIFACT_SCHEMA_INVALID.*required/iu);
  assert.deepEqual(fs.readFileSync(reportPath), jsonBefore);
  assert.deepEqual(fs.readFileSync(markdownPath), markdownBefore);
});

test("legacy report versions are rejected without a compatibility reader", async () => {
  const project = tempProject();
  const runData = await createReportRun(project, "report-legacy-version");
  const reportDir = path.join(runData.run_root, "artifacts", "final-report");
  const reportPath = path.join(reportDir, "report.json");
  const markdownPath = path.join(reportDir, "report.md");
  fs.mkdirSync(reportDir, { recursive: true });
  writeJsonRecord(reportPath, { ...currentReport(runData.run_id), schema_version: "1.0" });
  fs.writeFileSync(markdownPath, "# Legacy report\n", "utf8");
  const jsonBefore = fs.readFileSync(reportPath);
  const markdownBefore = fs.readFileSync(markdownPath);

  const result = await cli(project, ["report", runData.run_id, "--json"]);

  assert.equal(result.code, 1);
  assert.match(JSON.stringify(parseJson(result).diagnostics), /ARTIFACT_SCHEMA_INVALID.*constant/iu);
  assert.deepEqual(fs.readFileSync(reportPath), jsonBefore);
  assert.deepEqual(fs.readFileSync(markdownPath), markdownBefore);
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
  const reportDir = writeFinalReportAccounting(runData.run_root, {
    tokensUsed: "123",
    estimatedSpend: "$0.46",
    partialPricing: false
  });
  const reportSchemaBinding = artifactContractSchemaBinding("ultrafuzz/report@2");
  assert.ok(reportSchemaBinding);
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
        contract: "ultrafuzz/report@2",
        contract_digest: artifactContractDefinition("ultrafuzz/report@2").digest,
        ...reportSchemaBinding,
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
