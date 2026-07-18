import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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

async function cli(project: string, argv: string[], env: Record<string, string | undefined> = {}): Promise<Capture> {
  let stdout = "";
  let stderr = "";
  const code = await runCli([...argv, "--project", project], {
    cwd: project,
    env,
    stdout: {
      write: (chunk: string | Uint8Array) => {
        stdout += String(chunk);
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
    workflow: { run_id: string; inspect: { ok: boolean }; events: { ok: boolean } };
  };
  assert.equal(inspectData.metadata.workflow.run_id, "ultrafuzz-cli-run");
  assert.equal(inspectData.workflow.run_id, "ultrafuzz-cli-run");
  assert.equal(inspectData.workflow.inspect.ok, true);
  assert.equal(inspectData.workflow.events.ok, true);

  const status = await cli(project, ["status", runData.run_id, "--window", "5", "--json"], env);
  assert.equal(status.code, 0, status.stderr);
  const statusBody = parseJson(status);
  assertNoSmithersSurface(statusBody);
  const statusData = statusBody.data as {
    run_id: string;
    verdict: string;
    counts: { in_progress: number };
    gating: Array<{ node_id: string }>;
  };
  assert.equal(statusData.run_id, "cli-run");
  assert.equal(statusData.verdict, "running-healthy");
  assert.equal(statusData.counts.in_progress, 1);
  assert.equal(statusData.gating[0]?.node_id, "project-discovery");

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
  const reportDir = path.join(runData.run_root, "artifacts", "final-report");
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(
    path.join(reportDir, "report.md"),
    "# Agent report\n\n- Tokens used: unavailable\n- Estimated spend: unavailable\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(reportDir, "report.json"),
    '{"run_metadata":{"tokens_used":"unavailable","estimated_spend":"unavailable"}}\n',
    "utf8"
  );

  const report = await cli(project, ["report", runData.run_id, "--json"]);
  assert.equal(report.code, 0, report.stderr);
  const reportBody = parseJson(report);
  assertNoSmithersSurface(reportBody);
  assert.equal((reportBody.data as { json_path?: string }).json_path, path.join(reportDir, "report.json"));
  assert.equal(accountingMismatchCount(reportBody), 4);

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
