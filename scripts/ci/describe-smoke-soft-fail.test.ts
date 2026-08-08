import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
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

    expect(describeSmokeSoftFail(write(document))).toEqual({
      validated: false,
      detail: "public eval diagnostics are internally inconsistent (summary scoring_ready=true against 0/1 ready rows)"
    });
  });

  it("refuses to read readiness out of a document that describes no rows", () => {
    const document = diagnostics([]);
    // The vacuous shape #354 fixed: an empty row set claiming readiness.
    document.summary.scoring_ready = true;

    expect(describeSmokeSoftFail(write(document))).toEqual({
      validated: false,
      detail: "public eval diagnostics describe no rows, so there is nothing to score"
    });
  });

  it("reports an absent, unparseable, or non-regular diagnostics file as unknown", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-soft-fail-"));
    roots.push(root);
    const unknown = {
      validated: false,
      detail: "no readable public eval diagnostics, so scoring readiness is unknown"
    };

    expect(describeSmokeSoftFail(path.join(root, "absent.json"))).toEqual(unknown);

    const invalidPath = path.join(root, "invalid.json");
    fs.writeFileSync(invalidPath, "{ not json");
    expect(describeSmokeSoftFail(invalidPath)).toEqual(unknown);

    const arrayPath = path.join(root, "array.json");
    fs.writeFileSync(arrayPath, "[]");
    expect(describeSmokeSoftFail(arrayPath)).toEqual(unknown);

    expect(describeSmokeSoftFail(root)).toEqual(unknown);
  });
});

describe("smoke soft-fail ref policy", () => {
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

    expect(decideSmokeSoftFail(diagnosticsPath, "release/v0.1.0")).toMatchObject({
      validated: false,
      scoring_ready_required: true,
      blocks_gate: true
    });
    expect(decideSmokeSoftFail(diagnosticsPath, "feature/my-change")).toMatchObject({
      validated: false,
      scoring_ready_required: false,
      blocks_gate: false
    });
  });

  it("allows a release soft-fail when scoring readiness is internally consistent and true", () => {
    const diagnosticsPath = write(diagnostics([row(true), row(true), row(true)]));

    expect(decideSmokeSoftFail(diagnosticsPath, "release/v0.1.0")).toEqual({
      validated: true,
      detail: "public eval diagnostics report scoring_ready=true for 3/3 rows",
      scoring_ready_required: true,
      blocks_gate: false
    });
  });

  it("emits the decision as machine-readable JSON for the workflow", () => {
    const diagnosticsPath = write(diagnostics([row(false, ["terminal-report-missing"])]));
    const output = execFileSync(
      "node",
      [
        path.resolve("scripts/ci/describe-smoke-soft-fail.mjs"),
        "--json",
        "--ref",
        "test/v0.1.0-ultrafuzz-bench",
        diagnosticsPath
      ],
      { encoding: "utf8" }
    );

    expect(JSON.parse(output)).toMatchObject({
      validated: false,
      scoring_ready_required: true,
      blocks_gate: true
    });
  });
});

type Row = { scoring_ready: boolean; reason_codes: string[] };
type Diagnostics = { summary: { scoring_ready: boolean }; rows: Row[] };

function row(scoringReady: boolean, reasonCodes: string[] = []): Row {
  return { scoring_ready: scoringReady, reason_codes: reasonCodes };
}

function diagnostics(rows: Row[]): Diagnostics {
  return { summary: { scoring_ready: rows.length > 0 && rows.every((entry) => entry.scoring_ready) }, rows };
}

function write(document: Diagnostics): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-soft-fail-"));
  roots.push(root);
  const diagnosticsPath = path.join(root, "public-eval-diagnostics.json");
  fs.writeFileSync(diagnosticsPath, `${JSON.stringify(document)}\n`);
  return diagnosticsPath;
}
