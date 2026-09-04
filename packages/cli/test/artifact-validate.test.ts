import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../src/index.js";

test("artifact validate warns on partial metadata and --strict fails without rewriting input", async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-partial-artifact-"));
  try {
    const file = path.join(root, "findings.json");
    const bytes = JSON.stringify([
      { schema_version: "ultrafuzz.finding.v2", id: "f-1", title: "Partial", status: "candidate" }
    ]);
    fs.writeFileSync(file, bytes);
    const command = ["artifact", "validate", "ultrafuzz/findings@2", file, "--json"];
    const permissive = await capture(command);
    assert.equal(permissive.code, 0, permissive.stdout);
    const accepted = JSON.parse(permissive.stdout);
    assert.equal(accepted.ok, true);
    assert.equal(accepted.diagnostics.length, 3);
    assert.ok(accepted.diagnostics.every((entry: { severity: string }) => entry.severity === "warning"));
    const strict = await capture([...command, "--strict"]);
    assert.equal(strict.code, 1, strict.stdout);
    assert.equal(JSON.parse(strict.stdout).ok, false);
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const coverageInputBytes = Buffer.from("TN:\nSF:src/Core.sol\nDA:1,1\nend_of_record\n", "utf8");
const reconSelectionBytes = Buffer.from(
  `${JSON.stringify({ files: [{ path: "src/Core.sol", ranges: [{ start_line: 1, line_count: 1 }] }] })}\n`,
  "utf8"
);
const sha256 = (bytes: Uint8Array): string => crypto.createHash("sha256").update(bytes).digest("hex");

const validCoverageEvidence = {
  schema_version: "ultrafuzz.coverage-evidence.v1",
  status: "measured",
  lcov: { path: "coverage-input.lcov", sha256: sha256(coverageInputBytes) },
  recon_selection: { path: "recon-coverage.json", sha256: sha256(reconSelectionBytes) },
  views: [
    { scope: "recon-selected-declaration-completeness", covered_ranges: 1, total_ranges: 1 },
    { scope: "production-declaration-completeness", covered_ranges: 1, total_ranges: 2 }
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
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-artifact-validate-"));
  try {
    fs.writeFileSync(path.join(temporary, validCoverageEvidence.lcov.path), coverageInputBytes);
    fs.writeFileSync(path.join(temporary, validCoverageEvidence.recon_selection.path), reconSelectionBytes);
    assert.equal(
      validCoverageEvidence.lcov.sha256,
      sha256(fs.readFileSync(path.join(temporary, validCoverageEvidence.lcov.path)))
    );
    assert.equal(
      validCoverageEvidence.recon_selection.sha256,
      sha256(fs.readFileSync(path.join(temporary, validCoverageEvidence.recon_selection.path)))
    );

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

    const missingSelection = structuredClone(validCoverageEvidence) as Record<string, unknown>;
    delete missingSelection.recon_selection;
    const aliasedInputs = structuredClone(validCoverageEvidence);
    aliasedInputs.recon_selection = { ...aliasedInputs.lcov };
    const unsafeInputPath = structuredClone(validCoverageEvidence);
    unsafeInputPath.lcov.path = "../coverage-input.lcov";
    const malformedInputHash = structuredClone(validCoverageEvidence);
    malformedInputHash.recon_selection.sha256 = "not-a-sha256";
    for (const invalidInput of [
      { name: "missing-selection", document: missingSelection, diagnostic: /recon_selection/u },
      { name: "aliased-inputs", document: aliasedInputs, diagnostic: /distinct sibling artifacts/u },
      { name: "unsafe-input-path", document: unsafeInputPath, diagnostic: /pattern|safe relative/u },
      { name: "malformed-input-hash", document: malformedInputHash, diagnostic: /sha256|pattern/u }
    ]) {
      const invalidInputPath = path.join(temporary, `${invalidInput.name}.json`);
      fs.writeFileSync(invalidInputPath, JSON.stringify(invalidInput.document));
      const invalidInputResult = await capture([
        "artifact",
        "validate",
        "ultrafuzz/coverage-evidence@1",
        invalidInputPath,
        "--json"
      ]);
      assert.equal(invalidInputResult.code, 1, invalidInput.name);
      const invalidInputEnvelope = JSON.parse(invalidInputResult.stdout) as {
        diagnostics: Array<{ message: string }>;
      };
      assert.match(
        invalidInputEnvelope.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
        invalidInput.diagnostic,
        invalidInput.name
      );
    }

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
          /included in the recon-selected-declaration-completeness scope/u.test(diagnostic.message)
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
        schema_version: "ultrafuzz.coverage-goal.v2",
        target: { scope: "recon-selected-declaration-completeness", minimum_percent: 90 },
        current_measurement: { scope: "recon-selected-declaration-completeness", covered_ranges: 2, total_ranges: 1 },
        current_status: "target-met",
        planned_commands: [],
        stop_conditions: ["reserve time for finalization"],
        timeout_seconds: 60,
        finalization_reserve_seconds: 10,
        blockers: []
      })
    );
    const invalidGoal = await capture(["artifact", "validate", "ultrafuzz/coverage-goal@2", invalidGoalPath, "--json"]);
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

test("artifact validate exposes generated-test task authority before producer completion", async () => {
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-artifact-context-"));
  try {
    const artifactRoot = path.join(temporary, "artifacts", "dynamic-class-goals-storage-7");
    const companionPath = path.join(artifactRoot, "generated-tests", "Dynamic.t.sol");
    fs.mkdirSync(path.dirname(companionPath), { recursive: true });
    const companionBytes = Buffer.from("contract DynamicTest {}\n", "utf8");
    fs.writeFileSync(companionPath, companionBytes);
    const manifestPath = path.join(artifactRoot, "generated-tests.json");
    const logicalNodeId = "class-goals";
    const runId = "run-context";
    const matchingProvenance = {
      run_id: runId,
      producer_node_id: logicalNodeId,
      logical_node_id: logicalNodeId
    };
    const manifest = {
      schema_version: "ultrafuzz.generated-tests.v3",
      run_id: runId,
      node_id: "dynamic-class-goals-storage-7",
      framework: "foundry",
      generated_tests: [
        {
          path: "generated-tests/Dynamic.t.sol",
          size_bytes: companionBytes.byteLength,
          sha256: sha256(companionBytes),
          provenance: matchingProvenance
        }
      ],
      support_files: [],
      provenance: matchingProvenance
    };
    const writeManifest = (value: unknown): Buffer => {
      const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
      fs.writeFileSync(manifestPath, bytes);
      return bytes;
    };
    const contextualArgs = [
      "artifact",
      "validate",
      "ultrafuzz/generated-tests@3",
      manifestPath,
      "--run-id",
      runId,
      "--logical-node-id",
      logicalNodeId,
      "--artifact-root",
      artifactRoot,
      "--json"
    ];

    const wrongRootBytes = writeManifest(manifest);
    const documentLocal = await capture([
      "artifact",
      "validate",
      "ultrafuzz/generated-tests@3",
      manifestPath,
      "--json"
    ]);
    assert.equal(documentLocal.code, 0);
    const wrongRoot = await capture(contextualArgs);
    assert.equal(wrongRoot.code, 1);
    assert.deepEqual(fs.readFileSync(manifestPath), wrongRootBytes);
    assert.match(wrongRoot.stdout, /generated-test-current-identity/iu);
    assert.match(wrongRoot.stdout, /logical producer/iu);

    for (const [label, candidate] of [
      [
        "manifest provenance",
        { ...manifest, node_id: logicalNodeId, provenance: { ...matchingProvenance, producer_node_id: "attempt-7" } }
      ],
      [
        "entry provenance",
        {
          ...manifest,
          node_id: logicalNodeId,
          generated_tests: [
            {
              ...manifest.generated_tests[0],
              provenance: { ...matchingProvenance, run_id: "run-foreign" }
            }
          ]
        }
      ]
    ] as const) {
      const bytes = writeManifest(candidate);
      const result = await capture(contextualArgs);
      assert.equal(result.code, 1, label);
      assert.deepEqual(fs.readFileSync(manifestPath), bytes, label);
      assert.match(result.stdout, /generated-test-current-identity/iu, label);
    }

    const correctedBytes = writeManifest({ ...manifest, node_id: logicalNodeId });
    const corrected = await capture(contextualArgs);
    assert.equal(corrected.code, 0);
    assert.equal(corrected.stderr, "");
    assert.deepEqual(fs.readFileSync(manifestPath), correctedBytes);
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
