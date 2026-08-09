import fs from "node:fs";
import { pathToFileURL } from "node:url";

const MAX_DIAGNOSTICS_BYTES = 1024 * 1024;

// The non-default-branch smoke gate forgives an operational pair failure so an
// unrelated PR is not blocked. That hatch says nothing about whether the eval
// got far enough to be scored, so a forgiven run reads exactly like a validated
// one. Describe the collected diagnostics alongside the hatch so the two stay
// distinguishable.
export function describeSmokeSoftFail(diagnosticsPath) {
  const diagnostics = readDiagnostics(diagnosticsPath);
  if (diagnostics === undefined) {
    return { validated: false, detail: "no readable public eval diagnostics, so scoring readiness is unknown" };
  }

  const rows = Array.isArray(diagnostics.rows) ? diagnostics.rows.map(record) : [];
  const summary = record(diagnostics.summary);
  if (rows.length === 0) {
    return { validated: false, detail: "public eval diagnostics describe no rows, so there is nothing to score" };
  }

  const ready = rows.filter((row) => row.scoring_ready === true).length;
  // Recheck rather than trusting the stored flag: a document whose summary and
  // rows disagree is not evidence of anything.
  if (summary.scoring_ready !== (ready === rows.length)) {
    return {
      validated: false,
      detail: `public eval diagnostics are internally inconsistent (summary scoring_ready=${String(
        summary.scoring_ready
      )} against ${ready}/${rows.length} ready rows)`
    };
  }
  if (summary.scoring_ready !== true) {
    return {
      validated: false,
      detail: `public eval diagnostics report scoring_ready=false (${ready}/${rows.length} rows ready; ${reasonSummary(
        rows
      )})`
    };
  }
  return {
    validated: true,
    detail: `public eval diagnostics report scoring_ready=true for ${ready}/${rows.length} rows`
  };
}

// The hatch exists to keep an unrelated feature branch from being held
// hostage by the benchmark plane. Release-validation refs have the opposite
// purpose, so they may only use the hatch when the collected diagnostics prove
// the failed pair was still scoreable.
export function smokeSoftFailRequiresScoringReady(refName) {
  return refName.startsWith("release/") || refName === "test/v0.1.0-ultrafuzz-bench";
}

export function decideSmokeSoftFail(diagnosticsPath, refName) {
  const readiness = describeSmokeSoftFail(diagnosticsPath);
  const scoringReadyRequired = smokeSoftFailRequiresScoringReady(refName);
  return {
    ...readiness,
    scoring_ready_required: scoringReadyRequired,
    blocks_gate: scoringReadyRequired && !readiness.validated
  };
}

function reasonSummary(rows) {
  const reasons = new Set();
  for (const row of rows) {
    if (!Array.isArray(row.reason_codes)) continue;
    for (const reason of row.reason_codes) if (typeof reason === "string") reasons.add(reason);
  }
  return reasons.size === 0 ? "no reason codes recorded" : `reasons: ${[...reasons].sort().join(", ")}`;
}

function readDiagnostics(diagnosticsPath) {
  let raw;
  try {
    const stats = fs.statSync(diagnosticsPath);
    if (!stats.isFile() || stats.size > MAX_DIAGNOSTICS_BYTES) return undefined;
    raw = fs.readFileSync(diagnosticsPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function main(args) {
  let json = false;
  let refName;
  let diagnosticsPath;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      json = true;
    } else if (argument === "--ref" && args[index + 1] !== undefined) {
      refName = args[index + 1];
      index += 1;
    } else if (!argument.startsWith("--") && diagnosticsPath === undefined) {
      diagnosticsPath = argument;
    } else {
      throw usageError();
    }
  }
  if (diagnosticsPath === undefined) throw usageError();

  const result =
    refName === undefined ? describeSmokeSoftFail(diagnosticsPath) : decideSmokeSoftFail(diagnosticsPath, refName);
  console.log(json ? JSON.stringify(result) : result.detail);
}

function usageError() {
  return new Error("usage: describe-smoke-soft-fail.mjs [--json] [--ref <ref-name>] <public-eval-diagnostics.json>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
