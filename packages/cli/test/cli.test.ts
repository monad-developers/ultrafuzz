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
      'if [ "$1" = "fork" ]; then',
      "  printf '%s\\n' '{\"forkedRunId\":\"ultrafuzz-cli-run-forked\"}'",
      "else",
      "  printf '%s\\n' '{\"ok\":true}'",
      "fi",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(smithers, 0o755);
  return {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    SMITHERS_FAKE_LOG: path.join(project, "smithers-commands.log")
  };
}

function writeSmallTopology(project: string): void {
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "topology.yml"),
    `version: 1
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
    required_artifacts:
      - stdout.txt
    primary_artifact: stdout.txt
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

test("run, ps, inspect, report, materialize, clean, and lifecycle commands expose product workflow evidence", async () => {
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

  const artifactDir = path.join(runData.run_root, "artifacts", "project-discovery");
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "stdout.txt"), "generated stdout\n", "utf8");
  const reportDir = path.join(runData.run_root, "artifacts", "final-report");
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, "report.md"), "# Agent report\n", "utf8");
  fs.writeFileSync(path.join(reportDir, "report.json"), '{"ok":true}\n', "utf8");

  const report = await cli(project, ["report", runData.run_id, "--json"]);
  assert.equal(report.code, 0, report.stderr);
  assertNoSmithersSurface(parseJson(report));
  assert.equal((parseJson(report).data as { json_path?: string }).json_path, path.join(reportDir, "report.json"));

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
});

test("old commands and backend flags are rejected instead of aliased or shimmed", async () => {
  const project = tempProject();
  assert.equal((await cli(project, ["init", "--force"])).code, 0);

  for (const argv of [
    ["doctor", "--json"],
    ["list", "--json"],
    ["status", "cli-run", "--json"],
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
