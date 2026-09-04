import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { describeEvalError, EvalError } from "@ultrafuzz/evals";

import { commandFailure, envelope } from "../src/command-shared.js";
import { runCli } from "../src/index.js";

interface FailureEnvelope {
  ok: boolean;
  command: string;
  data: unknown;
  diagnostics: Array<{ code: string; message: string; severity: string; source: string }>;
}

test("eval score failure envelope carries the eval error code and details", async () => {
  const project = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ufz-cli-eval-score-failure-"));
  const manifestPath = path.join(project, ".ultrafuzz", "evals", "runs", "missing-eval-run", "eval.json");

  const json = await invoke(project, ["eval", "score", "missing-eval-run", "--project", project, "--json"]);
  assert.equal(json.code, 1);
  assert.equal(json.stderr, "");
  const result = JSON.parse(json.stdout) as FailureEnvelope;
  assert.equal(result.ok, false);
  assert.equal(result.command, "eval score");
  assert.equal(result.data, null);
  assert.equal(result.diagnostics.length, 1);
  const diagnostic = single(result.diagnostics);
  assert.equal(diagnostic.code, "EVAL_SCORE_FAILED");
  assert.equal(diagnostic.source, "cli");
  assert.ok(
    diagnostic.message.startsWith(`EVAL_DURABLE_READ_FAILED: failed to read durable JSON ${manifestPath} (details: {`),
    diagnostic.message
  );
  assert.ok(diagnostic.message.includes(`"path":${JSON.stringify(manifestPath)}`), diagnostic.message);
  assert.ok(diagnostic.message.includes('"kind":"io"'), diagnostic.message);
  assert.ok(diagnostic.message.endsWith("})"), diagnostic.message);

  const text = await invoke(project, ["eval", "score", "missing-eval-run", "--project", project]);
  assert.equal(text.code, 1);
  assert.equal(text.stdout, "");
  assert.equal(text.stderr, `${diagnostic.message}\n`);
});

test("eval report failure envelope carries the eval error code and details", async () => {
  const project = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ufz-cli-eval-report-failure-"));
  const json = await invoke(project, ["eval", "report", "missing-eval-run", "--project", project, "--json"]);
  assert.equal(json.code, 1);
  const result = JSON.parse(json.stdout) as FailureEnvelope;
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0]?.code, "EVAL_REPORT_FAILED");
  assert.ok(result.diagnostics[0]?.message.startsWith("EVAL_DURABLE_READ_FAILED: "), result.diagnostics[0]?.message);
  assert.ok(result.diagnostics[0]?.message.includes('"kind":"io"'), result.diagnostics[0]?.message);
});

test("eval failure envelope redacts secret-like details and validates against the CLI result schema", () => {
  const error = new EvalError("EVAL_LLM_JUDGE_REQUEST_FAILED", "LLM judge gateway request failed", {
    status: 401,
    body: '{"error":"invalid key sk-live-0123456789abcdef"}',
    judge_api_key: "plain-looking-value",
    headers: { Authorization: "Bearer abcdefghijklmnop", accept: "application/json" }
  });
  // `envelope` throws when the producer result does not validate against the strict CLI result schema.
  const value = envelope("eval score", commandFailure("eval score", describeEvalError(error), "EVAL_SCORE_FAILED"));
  assert.equal(value.ok, false);
  const diagnostic = single(value.diagnostics);
  assert.deepEqual(Object.keys(diagnostic).sort(), ["code", "message", "severity", "source"]);
  const message = diagnostic.message;
  assert.equal(diagnostic.code, "EVAL_SCORE_FAILED");
  assert.equal(
    message,
    "EVAL_LLM_JUDGE_REQUEST_FAILED: LLM judge gateway request failed (details: " +
      '{"status":401,"body":"[redacted]","judge_api_key":"[redacted]",' +
      '"headers":{"Authorization":"[redacted]","accept":"application/json"}})'
  );
  const serialized = JSON.stringify(value);
  for (const secret of ["sk-live", "abcdefghijklmnop", "plain-looking-value"]) {
    assert.ok(!serialized.includes(secret), `envelope leaks ${secret}`);
  }

  const plain = envelope(
    "eval score",
    commandFailure("eval score", describeEvalError(new Error("boom")), "EVAL_SCORE_FAILED")
  );
  assert.equal(single(plain.diagnostics).message, "boom");
  assert.equal(single(plain.diagnostics).code, "EVAL_SCORE_FAILED");
});

function single<T>(items: readonly T[]): T {
  assert.equal(items.length, 1);
  const [item] = items;
  assert.ok(item !== undefined);
  return item;
}

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
