import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateAnalysisBundle } from "@ultrafuzz/artifacts";

import { runCli } from "../src/index.js";

test("eval bundle exposes the privacy-safe offline export mode", async () => {
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

  assert.equal(code, 0, stderr || stdout);
  const result = JSON.parse(stdout) as {
    command: string;
    ok: boolean;
    data: { output_dir: string; omissions: { omissions: unknown[] } };
  };
  assert.equal(result.command, "eval bundle");
  assert.equal(result.ok, true);
  assert.equal(result.data.output_dir, path.join(project, "analysis"));
  assert.equal(result.data.omissions.omissions.length, 4);
  assert.doesNotThrow(() => validateAnalysisBundle(result.data.output_dir));
});
