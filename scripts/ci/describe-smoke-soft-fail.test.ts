import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PublicEvalDiagnostics, PublicEvalDiagnosticsRow } from "../../packages/evals/src/public-diagnostics.js";

import {
  automaticSmokeOperationalSoftFail,
  decideSmokeSoftFail,
  describeSmokeSoftFail,
  smokeSoftFailRequiresScoringReady
} from "./describe-smoke-soft-fail.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("smoke soft-fail description", () => {
  it("reports a scored eval as validated", () => {
    const diagnosticsPath = write(diagnostics([row(true), row(true), row(true)]));

    expect(describeSmokeSoftFail(diagnosticsPath)).toEqual({
      validated: true,
      detail: "public eval diagnostics report scoring_ready=true for 3/3 rows"
    });
  });

  it("names the reason codes that kept an eval from scoring", () => {
    const diagnosticsPath = write(diagnostics([row(true), row(false, ["terminal-report-missing"])]));

    expect(describeSmokeSoftFail(diagnosticsPath)).toEqual({
      validated: false,
      detail: "public eval diagnostics report scoring_ready=false (1/2 rows ready; reasons: terminal-report-missing)"
    });
  });

  it("refuses to read readiness out of a document whose summary and rows disagree", () => {
    const document = diagnostics([row(false, ["terminal-report-missing"])]);
    document.summary.scoring_ready = true;

    expect(() => describeSmokeSoftFail(write(document))).toThrow(/public eval diagnostics are present but invalid/u);
  });

  it("refuses to read readiness out of a document that describes no rows", () => {
    const document = diagnostics([]);
    // The vacuous shape #354 fixed: an empty row set claiming readiness.
    document.summary.scoring_ready = true;

    expect(() => describeSmokeSoftFail(write(document))).toThrow(/public eval diagnostics are present but invalid/u);
  });

  it("reports only an absent diagnostics file as unknown", () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "smoke-soft-fail-"));
    roots.push(root);
    expect(describeSmokeSoftFail(path.join(root, "absent.json"))).toEqual({
      validated: false,
      detail: "public eval diagnostics are absent, so scoring readiness is unknown"
    });
  });

  it("rejects malformed-present, non-regular, oversized, and symlinked diagnostics", () => {
    const invalidPath = writeBytes("{ not json");
    expect(() => describeSmokeSoftFail(invalidPath)).toThrow(/public eval diagnostics are present but invalid/u);

    const arrayPath = writeBytes("[]");
    expect(() => describeSmokeSoftFail(arrayPath)).toThrow(/public eval diagnostics are present but invalid/u);

    const invalidUtf8Path = writeBytes(Buffer.from([0x7b, 0xff, 0x7d]));
    expect(() => describeSmokeSoftFail(invalidUtf8Path)).toThrow(/public eval diagnostics are present but invalid/u);

    const duplicate = JSON.stringify(diagnostics([row(true)])).replace(
      "{",
      '{"schema_version":"ultrafuzz.modal.public-eval-diagnostics.v2",'
    );
    const duplicatePath = writeBytes(duplicate);
    expect(() => describeSmokeSoftFail(duplicatePath)).toThrow(/public eval diagnostics are present but invalid/u);

    const oversizedPath = writeBytes(Buffer.alloc(1024 * 1024 + 1, 0x20));
    expect(() => describeSmokeSoftFail(oversizedPath)).toThrow(/public eval diagnostics are present but invalid/u);

    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "smoke-soft-fail-"));
    roots.push(root);
    expect(() => describeSmokeSoftFail(root)).toThrow(/public eval diagnostics are present but invalid/u);

    const targetPath = path.join(root, "target.json");
    fs.writeFileSync(targetPath, `${JSON.stringify(diagnostics([row(true)]))}\n`);
    const symlinkPath = path.join(root, "diagnostics.json");
    fs.symlinkSync(targetPath, symlinkPath);
    expect(() => describeSmokeSoftFail(symlinkPath)).toThrow(/public eval diagnostics are present but invalid/u);
  });
});

describe("smoke soft-fail ref policy", () => {
  it("soft-fails operational outcomes for automatic main smoke runs", () => {
    const resumeRequired = { terminal_status: "failed", category: "resume-required" };

    expect(automaticSmokeOperationalSoftFail("smoke", "push", resumeRequired)).toBe(true);
    expect(
      decideSmokeSoftFail("/absent/diagnostics.json", "main", {
        mode: "smoke",
        eventName: "push",
        outcome: resumeRequired
      })
    ).toMatchObject({ soft_fail: true, blocks_gate: false });
    for (const category of [
      "transient-operational-failure",
      "permanent-operational-failure",
      "collection-failed",
      "collection-timeout"
    ]) {
      expect(automaticSmokeOperationalSoftFail("smoke", "push", { terminal_status: "failed", category })).toBe(true);
    }
  });

  it("keeps manual, full, successful, genuine, and control outcomes strict", () => {
    const operational = { terminal_status: "failed", category: "resume-required" };
    const genuine = { terminal_status: "failed", category: "genuine-task-outcome" };

    expect(automaticSmokeOperationalSoftFail("smoke", "workflow_dispatch", operational)).toBe(false);
    expect(automaticSmokeOperationalSoftFail("full", "push", operational)).toBe(false);
    expect(automaticSmokeOperationalSoftFail("smoke", "push", genuine)).toBe(false);
    expect(automaticSmokeOperationalSoftFail("smoke", "push", { terminal_status: "failed" })).toBe(false);
    for (const category of [
      "incompatible-checkpoint",
      "runner-status-invalid",
      "launch-state-missing",
      "control-plane-timeout"
    ]) {
      expect(automaticSmokeOperationalSoftFail("smoke", "push", { terminal_status: "failed", category })).toBe(false);
    }
    expect(
      automaticSmokeOperationalSoftFail("smoke", "push", {
        terminal_status: "succeeded",
        category: "succeeded"
      })
    ).toBe(false);
    for (const policy of [
      { mode: "smoke", eventName: "workflow_dispatch", outcome: operational },
      { mode: "full", eventName: "push", outcome: operational },
      { mode: "smoke", eventName: "push", outcome: genuine }
    ]) {
      expect(decideSmokeSoftFail("/absent/diagnostics.json", "main", policy)).toMatchObject({
        soft_fail: false,
        blocks_gate: true
      });
    }
  });

  it("requires scoring readiness on every release branch and the benchmark validation branch", () => {
    for (const refName of ["release/v0.1.0", "release/v0.2.0-rc.1", "test/v0.1.0-ultrafuzz-bench"]) {
      expect(smokeSoftFailRequiresScoringReady(refName)).toBe(true);
    }
  });

  it("preserves the hatch on feature branches and similarly named refs", () => {
    for (const refName of [
      "feature/my-change",
      "fix/release-smoke",
      "releases/v0.1.0",
      "test/v0.1.0-ultrafuzz-bench-copy",
      "main"
    ]) {
      expect(smokeSoftFailRequiresScoringReady(refName)).toBe(false);
    }
  });

  it("blocks an unscoreable release soft-fail but not the same feature-branch failure", () => {
    const diagnosticsPath = write(diagnostics([row(false, ["terminal-report-missing"])]));
    const policy = automaticPolicy();

    expect(decideSmokeSoftFail(diagnosticsPath, "release/v0.1.0", policy)).toMatchObject({
      validated: false,
      soft_fail: true,
      scoring_ready_required: true,
      blocks_gate: true
    });
    expect(decideSmokeSoftFail(diagnosticsPath, "feature/my-change", policy)).toMatchObject({
      validated: false,
      soft_fail: true,
      scoring_ready_required: false,
      blocks_gate: false
    });
  });

  it("allows a release soft-fail when scoring readiness is internally consistent and true", () => {
    const diagnosticsPath = write(diagnostics([row(true), row(true), row(true)]));

    expect(decideSmokeSoftFail(diagnosticsPath, "release/v0.1.0", automaticPolicy())).toEqual({
      validated: true,
      detail: "public eval diagnostics report scoring_ready=true for 3/3 rows",
      soft_fail: true,
      scoring_ready_required: true,
      blocks_gate: false
    });
  });

  it("emits the decision as machine-readable JSON for the workflow", () => {
    const diagnosticsPath = write(diagnostics([row(false, ["terminal-report-missing"])]));
    const outcomePath = writeOutcome({ terminal_status: "failed", category: "resume-required" });
    const output = execFileSync(
      "node",
      [
        path.resolve("scripts/ci/describe-smoke-soft-fail.mjs"),
        "--json",
        "--ref",
        "main",
        "--mode",
        "smoke",
        "--event",
        "push",
        "--outcome",
        outcomePath,
        diagnosticsPath
      ],
      { encoding: "utf8" }
    );

    expect(JSON.parse(output)).toMatchObject({
      validated: false,
      soft_fail: true,
      scoring_ready_required: false,
      blocks_gate: false
    });
  });
});

type Row = Pick<PublicEvalDiagnosticsRow, "scoring_ready" | "reason_codes" | "terminal_report_present">;

function row(scoringReady: boolean, reasonCodes: PublicEvalDiagnosticsRow["reason_codes"] = []): Row {
  return {
    scoring_ready: scoringReady,
    reason_codes: reasonCodes,
    terminal_report_present: !reasonCodes.includes("terminal-report-missing")
  };
}

function diagnostics(rows: Row[]): PublicEvalDiagnostics {
  const completeRows: PublicEvalDiagnosticsRow[] = rows.map((entry, index) => ({
    row_id: `row-${index + 1}`,
    target_id: `target-${index + 1}`,
    variant_id: "variant-one",
    trial_id: `trial-${index + 1}`,
    run_status: "launched",
    final_status: "succeeded",
    workflow_status: "succeeded",
    workflow_terminal: true,
    terminal_disposition: "clean",
    terminal_report_present: entry.terminal_report_present,
    workflow_ids: [`workflow-${index + 1}`],
    diagnostic_codes: [],
    failed_nodes: [],
    scoring_ready: entry.scoring_ready,
    reason_codes: entry.reason_codes
  }));
  return {
    schema_version: "ultrafuzz.modal.public-eval-diagnostics.v2",
    stage: "post-eval-pre-score",
    benchmark: "evmbench",
    lane: "smoke",
    model_slug: "model-one",
    model: "model-one",
    reasoning: "high",
    candidate_commit: "a".repeat(40),
    eval_run_id: "logical-run-model-one",
    created_at: "2026-01-01T00:00:00.000Z",
    lineage: {
      logical_run_id: "logical-run",
      generation: 1,
      attempt: 1,
      attempt_id: "attempt-one",
      config_fingerprint: "b".repeat(64),
      source_fingerprint: "c".repeat(64),
      image_fingerprint: "d".repeat(64),
      model_fingerprint: "e".repeat(64)
    },
    summary: {
      planned: completeRows.length,
      launched: completeRows.length,
      launch_failed: 0,
      run_records_missing: 0,
      workflow_succeeded: completeRows.length,
      workflow_failed: 0,
      workflow_nonterminal: 0,
      genuine_task_failure_rows: 0,
      terminal_reports_present: completeRows.filter((entry) => entry.terminal_report_present).length,
      scoring_ready: completeRows.length > 0 && completeRows.every((entry) => entry.scoring_ready)
    },
    rows: completeRows
  };
}

function write(document: unknown): string {
  return writeBytes(`${JSON.stringify(document)}\n`);
}

function writeBytes(contents: string | Buffer): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "smoke-soft-fail-"));
  roots.push(root);
  const diagnosticsPath = path.join(root, "public-eval-diagnostics.json");
  fs.writeFileSync(diagnosticsPath, contents);
  return diagnosticsPath;
}

function writeOutcome(document: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "smoke-soft-fail-outcome-"));
  roots.push(root);
  const outcomePath = path.join(root, "outcome.json");
  fs.writeFileSync(outcomePath, `${JSON.stringify(document)}\n`);
  return outcomePath;
}

function automaticPolicy() {
  return {
    mode: "smoke",
    eventName: "push",
    outcome: { terminal_status: "failed", category: "resume-required" }
  };
}
