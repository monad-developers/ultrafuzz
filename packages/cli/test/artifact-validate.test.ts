import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../src/index.js";

const validCoverageEvidence = {
  schema_version: "ultrafuzz.coverage-evidence.v1",
  lcov: { path: "echidna/covered.test.lcov", sha256: "a".repeat(64) },
  views: [
    { scope: "selected-range", covered_ranges: 1, total_ranges: 1 },
    { scope: "production-source", covered_ranges: 1, total_ranges: 2 }
  ],
  files: [
    {
      path: "src/Core.sol",
      kind: "production",
      included: true,
      covered_ranges: 1,
      total_ranges: 1
    },
    {
      path: "src/Critical.sol",
      kind: "production",
      included: false,
      exclusion_reason: "not selected",
      covered_ranges: 0,
      total_ranges: 1
    }
  ],
  counted_ranges: [
    {
      file: "src/Core.sol",
      kind: "production",
      start_line: 1,
      line_count: 1,
      selected: true,
      covered: true
    },
    {
      file: "src/Critical.sol",
      kind: "production",
      start_line: 1,
      line_count: 1,
      selected: false,
      covered: false
    }
  ],
  zero_coverage_components: [{ path: "src/Critical.sol", kind: "production", start_line: 1, line_count: 1 }]
};

test("artifact validate executes document-local coverage evidence gates", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-artifact-validate-"));
  try {
    const validPath = path.join(temporary, "valid.json");
    fs.writeFileSync(validPath, JSON.stringify(validCoverageEvidence));

    const valid = await capture(["artifact", "validate", "ultrafuzz/coverage-evidence@1", validPath, "--json"]);
    assert.equal(valid.code, 0);
    assert.equal(valid.stderr, "");
    assert.deepEqual(JSON.parse(valid.stdout), {
      schema_version: "ultrafuzz.cli.result.v2",
      command: "artifact validate",
      ok: true,
      diagnostics: [],
      data: { contract: "ultrafuzz/coverage-evidence@1", path: validPath }
    });

    const invalidPath = path.join(temporary, "excluded-range.json");
    const invalidDocument = structuredClone(validCoverageEvidence) as {
      counted_ranges: Array<Record<string, unknown>>;
    };
    invalidDocument.counted_ranges.push({
      file: "src/Critical.sol",
      kind: "production",
      start_line: 1,
      line_count: 1,
      selected: true,
      covered: false
    });
    fs.writeFileSync(invalidPath, JSON.stringify(invalidDocument));

    const invalid = await capture(["artifact", "validate", "ultrafuzz/coverage-evidence@1", invalidPath, "--json"]);
    assert.equal(invalid.code, 1);
    assert.equal(invalid.stderr, "");
    const envelope = JSON.parse(invalid.stdout) as {
      command: string;
      ok: boolean;
      data: { contract: string; path: string } | null;
      diagnostics: Array<{ code: string; message: string }>;
    };
    assert.equal(envelope.command, "artifact validate");
    assert.equal(envelope.ok, false);
    assert.deepEqual(envelope.data, { contract: "ultrafuzz/coverage-evidence@1", path: invalidPath });
    assert.ok(
      envelope.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "ARTIFACT_SEMANTIC_GATE_FAILED" &&
          /included in the selected-range scope/u.test(diagnostic.message)
      )
    );

    const invalidUtf8Path = path.join(temporary, "invalid-utf8.json");
    fs.writeFileSync(invalidUtf8Path, Buffer.from([0x7b, 0xff, 0x7d]));
    const invalidUtf8 = await capture([
      "artifact",
      "validate",
      "ultrafuzz/coverage-evidence@1",
      invalidUtf8Path,
      "--json"
    ]);
    assert.equal(invalidUtf8.code, 1);
    const invalidUtf8Envelope = JSON.parse(invalidUtf8.stdout) as {
      ok: boolean;
      diagnostics: Array<{ code: string; message: string }>;
    };
    assert.equal(invalidUtf8Envelope.ok, false);
    assert.match(invalidUtf8Envelope.diagnostics[0]?.code ?? "", /ARTIFACT_(?:JSON|UTF8)_INVALID/u);
    assert.match(invalidUtf8Envelope.diagnostics[0]?.message ?? "", /UTF-8/u);

    const invalidGoalPath = path.join(temporary, "invalid-goal.json");
    fs.writeFileSync(
      invalidGoalPath,
      JSON.stringify({
        schema_version: "ultrafuzz.coverage-goal.v1",
        target: { scope: "selected-range", minimum_percent: 90 },
        current_measurement: { scope: "selected-range", covered_ranges: 2, total_ranges: 1 },
        current_status: "measured",
        planned_commands: [],
        stop_conditions: ["reserve time for finalization"],
        timeout_seconds: 60,
        finalization_reserve_seconds: 10,
        blockers: []
      })
    );
    const invalidGoal = await capture(["artifact", "validate", "ultrafuzz/coverage-goal@1", invalidGoalPath, "--json"]);
    assert.equal(invalidGoal.code, 1);
    const invalidGoalEnvelope = JSON.parse(invalidGoal.stdout) as {
      diagnostics: Array<{ code: string; message: string }>;
    };
    assert.ok(
      invalidGoalEnvelope.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "ARTIFACT_SEMANTIC_GATE_FAILED" &&
          /covered_ranges cannot exceed total_ranges/u.test(diagnostic.message)
      )
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

async function capture(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    cwd: process.cwd(),
    env: process.env,
    stdout: {
      write(chunk: string | Uint8Array) {
        stdout += String(chunk);
        return true;
      }
    },
    stderr: {
      write(chunk: string | Uint8Array) {
        stderr += String(chunk);
        return true;
      }
    }
  });
  return { code, stdout, stderr };
}
