import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../src/index.js";

test("eval bundle rejects an eval run without canonical terminal and scoring evidence", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-cli-analysis-"));
  const evalRunId = "eval-cli-analysis";
  fs.mkdirSync(path.join(project, ".ultrafuzz", "evals", "runs", evalRunId), { recursive: true });
  let stdout = "";
  let stderr = "";
  const code = await runCli(["eval", "bundle", evalRunId, "--output", "analysis", "--project", project, "--json"], {
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

  assert.equal(code, 1, stderr || stdout);
  const result = JSON.parse(stdout) as {
    command: string;
    ok: boolean;
    diagnostics: Array<{ code: string; message: string }>;
    data: null;
  };
  assert.equal(result.command, "eval bundle");
  assert.equal(result.ok, false);
  assert.equal(result.data, null);
  assert.deepEqual(
    result.diagnostics.map(({ code }) => code),
    ["EVAL_BUNDLE_FAILED"]
  );
  assert.match(result.diagnostics[0]?.message ?? "", /runs\.jsonl/u);
  assert.equal(fs.existsSync(path.join(project, "analysis")), false);
});
