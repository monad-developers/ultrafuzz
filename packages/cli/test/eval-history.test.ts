import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { emptyEvalHistory } from "@ultrafuzz/evals";

import { runCli } from "../src/index.js";

test("eval history renders and checks deterministic public charts", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-cli-history-"));
  fs.mkdirSync(path.join(project, "benchmarks", "ultrafuzzbench"), { recursive: true });
  fs.writeFileSync(
    path.join(project, "benchmarks", "ultrafuzzbench", "history.json"),
    `${JSON.stringify(emptyEvalHistory())}\n`,
    "utf8"
  );

  const rendered = await invoke(project, ["eval", "history", "--project", project, "--json"]);
  assert.equal(rendered.code, 0, rendered.stderr || rendered.stdout);
  const result = JSON.parse(rendered.stdout) as { command: string; ok: boolean; data: { observations: number } };
  assert.equal(result.command, "eval history");
  assert.equal(result.ok, true);
  assert.equal(result.data.observations, 0);
  assert.deepEqual(fs.readdirSync(path.join(project, "docs", "assets", "eval-history")).sort(), [
    "cost.svg",
    "cumulative-unique-true-positives.svg",
    "f1.svg",
    "latest-summary.svg",
    "performance-cost.svg",
    "precision.svg",
    "quality.svg",
    "recall.svg",
    "wall-clock-time.svg"
  ]);

  const checked = await invoke(project, ["eval", "history", "--project", project, "--check", "--json"]);
  assert.equal(checked.code, 0, checked.stderr || checked.stdout);

  fs.appendFileSync(path.join(project, "docs", "assets", "eval-history", "precision.svg"), "stale\n");
  const stale = await invoke(project, ["eval", "history", "--project", project, "--check", "--json"]);
  assert.equal(stale.code, 1);
  assert.equal((JSON.parse(stale.stdout) as { ok: boolean }).ok, false);
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
