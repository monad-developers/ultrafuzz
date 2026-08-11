import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../src/index.js";

test("eval status renders disclosure-safe table and JSON snapshots without mutating run state", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-cli-eval-status-"));
  const evalRunId = "synthetic-eval";
  const evalRoot = path.join(project, ".ultrafuzz", "evals", "runs", evalRunId);
  const runRoot = path.join(project, "private-target-checkout", ".ultrafuzz", "runs", "synthetic-run");
  fs.mkdirSync(evalRoot, { recursive: true });
  fs.mkdirSync(runRoot, { recursive: true });
  fs.writeFileSync(
    path.join(evalRoot, "matrix.json"),
    `${JSON.stringify([
      {
        id: "secret-target-private-variant",
        target: {
          sensitivity: "private",
          repo: "https://private.example/secret-repository",
          path: "/private/secret-target-checkout",
          ref: "secret-ref",
          ground_truth_path: "/private/secret-ground-truth.yml"
        }
      }
    ])}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(evalRoot, "runs.jsonl"),
    `${JSON.stringify({
      eval_run_id: evalRunId,
      row_id: "secret-target-private-variant",
      status: "launched",
      ultrafuzz_run_id: "synthetic-run",
      ultrafuzz_run_root: runRoot,
      diagnostics: [{ message: "secret-finding-evidence" }]
    })}\n`,
    "utf8"
  );
  const timestamp = new Date().toISOString();
  const statePath = path.join(runRoot, "state.json");
  fs.writeFileSync(
    statePath,
    `${JSON.stringify({
      schema_version: "1.1",
      run_id: "synthetic-run",
      status: "succeeded",
      created_at: timestamp,
      started_at: timestamp,
      finished_at: timestamp,
      last_transition_at: timestamp,
      controller_lease: { renewed_at: timestamp },
      concurrency: { observed_at: timestamp },
      nodes: {
        first: { node_id: "first", status: "succeeded", finished_at: timestamp },
        second: { node_id: "second", status: "reused-from-prior-run", finished_at: timestamp }
      }
    })}\n`,
    "utf8"
  );
  const stateBefore = fs.readFileSync(statePath, "utf8");
  const modifiedBefore = fs.statSync(statePath).mtimeMs;

  const json = await invoke(project, ["eval", "status", evalRunId, "--project", project, "--json"]);
  assert.equal(json.code, 0, json.stderr || json.stdout);
  const result = JSON.parse(json.stdout) as {
    command: string;
    ok: boolean;
    data: {
      schema_version: string;
      completed_node_statuses: string[];
      rows: Array<{
        row: string;
        status: string;
        executed_nodes: number;
        total_nodes: number;
        progress_percent: number;
        active_node_ids: string[];
        waiting_nodes: unknown[];
        linked_workflow_status: string | null;
      }>;
    };
  };
  assert.equal(result.command, "eval status");
  assert.equal(result.ok, true);
  assert.equal(result.data.schema_version, "ultrafuzz.eval.status.v1");
  assert.deepEqual(
    result.data.rows.map((row) => ({
      row: row.row,
      status: row.status,
      executed_nodes: row.executed_nodes,
      total_nodes: row.total_nodes,
      progress_percent: row.progress_percent,
      active_node_ids: row.active_node_ids,
      waiting_nodes: row.waiting_nodes,
      linked_workflow_status: row.linked_workflow_status
    })),
    [
      {
        row: "row-01",
        status: "succeeded",
        executed_nodes: 2,
        total_nodes: 2,
        progress_percent: 100,
        active_node_ids: [],
        waiting_nodes: [],
        linked_workflow_status: null
      }
    ]
  );
  assert.deepEqual(result.data.completed_node_statuses, [
    "succeeded",
    "failed",
    "skipped",
    "timed-out",
    "reused-from-prior-run",
    "invalidated"
  ]);

  const table = await invoke(project, ["eval", "status", evalRunId, "--project", project]);
  assert.equal(table.code, 0, table.stderr || table.stdout);
  assert.match(table.stdout, /Row\s+Status\s+Progress\s+ETA\s+Checkpoint\s+Nodes\s+Workflow/u);
  assert.match(
    table.stdout,
    /row-01\s+succeeded\s+100\.0% \(2\/2\)\s+complete\s+\d+(?:s|m(?: \d+s)?|h(?: \d+m)?|d(?: \d+h)?)\s+none\s+none/u
  );

  const watch = await invoke(project, [
    "eval",
    "status",
    evalRunId,
    "--project",
    project,
    "--watch",
    "--interval",
    "1",
    "--json"
  ]);
  assert.equal(watch.code, 0, watch.stderr || watch.stdout);
  assert.equal(watch.stdout.trim().split("\n").length, 1);
  assert.equal((JSON.parse(watch.stdout) as { command: string }).command, "eval status");

  const output = `${json.stdout}\n${table.stdout}\n${watch.stdout}\n${json.stderr}\n${table.stderr}\n${watch.stderr}`;
  for (const sensitive of [
    "secret-target-private-variant",
    "secret-repository",
    "secret-target-checkout",
    "secret-ref",
    "secret-ground-truth",
    "secret-finding-evidence"
  ]) {
    assert.equal(output.includes(sensitive), false);
  }
  assert.equal(fs.readFileSync(statePath, "utf8"), stateBefore);
  assert.equal(fs.statSync(statePath).mtimeMs, modifiedBefore);
});

test("eval status watch exits when remaining rows cannot progress", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-cli-eval-status-invalid-"));
  const evalRunId = "synthetic-invalid-eval";
  const evalRoot = path.join(project, ".ultrafuzz", "evals", "runs", evalRunId);
  const runRoot = path.join(project, "private-invalid-target", ".ultrafuzz", "runs", "synthetic-invalid-run");
  fs.mkdirSync(evalRoot, { recursive: true });
  fs.mkdirSync(runRoot, { recursive: true });
  fs.writeFileSync(
    path.join(evalRoot, "matrix.json"),
    `${JSON.stringify([
      {
        id: "secret-invalid-row",
        target: {
          sensitivity: "private",
          repo: "https://private.example/secret-invalid-repository",
          path: "/private/secret-invalid-target",
          ref: "secret-invalid-ref",
          ground_truth_path: "/private/secret-invalid-ground-truth.yml"
        }
      }
    ])}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(evalRoot, "runs.jsonl"),
    `${JSON.stringify({
      eval_run_id: evalRunId,
      row_id: "secret-invalid-row",
      status: "launched",
      ultrafuzz_run_id: "synthetic-invalid-run",
      ultrafuzz_run_root: runRoot
    })}\n`,
    "utf8"
  );
  fs.writeFileSync(path.join(runRoot, "state.json"), "{invalid", "utf8");

  const watch = await invoke(project, [
    "eval",
    "status",
    evalRunId,
    "--project",
    project,
    "--watch",
    "--interval",
    "1",
    "--json"
  ]);

  assert.equal(watch.code, 0, watch.stderr || watch.stdout);
  const lines = watch.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const result = JSON.parse(lines[0] ?? "") as {
    data: { rows: Array<{ row: string; status: string; terminal: boolean }> };
  };
  assert.deepEqual(
    result.data.rows.map((row) => ({ row: row.row, status: row.status, terminal: row.terminal })),
    [{ row: "row-01", status: "invalid", terminal: false }]
  );
  assert.equal(`${watch.stdout}\n${watch.stderr}`.includes("secret-invalid"), false);
});

test("eval status watch keeps JSON failures on one line", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-cli-eval-status-error-"));

  const result = await invoke(project, [
    "eval",
    "status",
    "synthetic-missing-eval",
    "--project",
    project,
    "--watch",
    "--json"
  ]);

  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const envelope = JSON.parse(lines[0] ?? "") as { command: string; ok: boolean; diagnostics: unknown[]; data: null };
  assert.equal(envelope.command, "eval status");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.data, null);
  assert.equal(envelope.diagnostics.length, 1);
});

async function invoke(project: string, argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    cwd: project,
    env: {},
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
  return { code, stdout, stderr };
}
