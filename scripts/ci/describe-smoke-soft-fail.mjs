import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { parseStrictJsonBytes, readRegularFileSnapshot } from "../../packages/artifacts/dist/index.js";
import { MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES, parsePublicEvalDiagnostics } from "../../packages/evals/dist/index.js";

const AUTOMATIC_SMOKE_SOFT_FAIL_CATEGORIES = new Set([
  "resume-required",
  "transient-operational-failure",
  "permanent-operational-failure",
  "collection-failed",
  "collection-timeout"
]);

// Automatic smoke runs report operational pair failures without making the
// post-merge workflow red. That hatch says nothing about whether the eval got
// far enough to be scored, so a forgiven run reads exactly like a validated
// one. Describe the collected diagnostics alongside the hatch so the two stay
// distinguishable.
export function describeSmokeSoftFail(diagnosticsPath) {
  const diagnostics = readDiagnostics(diagnosticsPath);
  if (diagnostics === undefined) {
    return { validated: false, detail: "public eval diagnostics are absent, so scoring readiness is unknown" };
  }

  const rows = diagnostics.rows;
  const summary = diagnostics.summary;

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

// Release-validation refs use automatic smoke as a scoring-readiness gate, so
// they may only use the operational hatch when the collected diagnostics prove
// the failed pair was still scoreable.
export function smokeSoftFailRequiresScoringReady(refName) {
  return refName.startsWith("release/") || refName === "test/v0.1.0-ultrafuzz-bench";
}

export function automaticSmokeOperationalSoftFail(mode, eventName, outcome) {
  const terminalOutcome = record(outcome);
  return (
    mode === "smoke" &&
    eventName === "push" &&
    terminalOutcome.terminal_status === "failed" &&
    typeof terminalOutcome.category === "string" &&
    AUTOMATIC_SMOKE_SOFT_FAIL_CATEGORIES.has(terminalOutcome.category)
  );
}

export function decideSmokeSoftFail(diagnosticsPath, refName, policy) {
  const readiness = describeSmokeSoftFail(diagnosticsPath);
  const scoringReadyRequired = smokeSoftFailRequiresScoringReady(refName);
  const softFail =
    policy !== undefined && automaticSmokeOperationalSoftFail(policy.mode, policy.eventName, policy.outcome);
  return {
    ...readiness,
    soft_fail: softFail,
    scoring_ready_required: scoringReadyRequired,
    blocks_gate: !softFail || (scoringReadyRequired && !readiness.validated)
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
  let entry;
  try {
    entry = fs.lstatSync(diagnosticsPath, { throwIfNoEntry: false });
  } catch {
    throw invalidDiagnostics(diagnosticsPath);
  }
  if (entry === undefined) return undefined;
  if (!entry.isFile()) throw invalidDiagnostics(diagnosticsPath);

  try {
    const bytes = readRegularFileSnapshot(diagnosticsPath, MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES);
    return parsePublicEvalDiagnostics(
      parseStrictJsonBytes(bytes, {
        maxBytes: MAX_PUBLIC_EVAL_DIAGNOSTICS_BYTES,
        maxDepth: 128,
        maxItems: 250_000,
        maxProperties: 250_000
      })
    );
  } catch {
    throw invalidDiagnostics(diagnosticsPath);
  }
}

function invalidDiagnostics(diagnosticsPath) {
  return new Error(`public eval diagnostics are present but invalid: ${diagnosticsPath}`);
}

function main(args) {
  let json = false;
  let refName;
  let mode;
  let eventName;
  let outcomePath;
  let diagnosticsPath;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      json = true;
    } else if (argument === "--ref" && args[index + 1] !== undefined) {
      refName = args[index + 1];
      index += 1;
    } else if (argument === "--mode" && args[index + 1] !== undefined) {
      mode = args[index + 1];
      index += 1;
    } else if (argument === "--event" && args[index + 1] !== undefined) {
      eventName = args[index + 1];
      index += 1;
    } else if (argument === "--outcome" && args[index + 1] !== undefined) {
      outcomePath = args[index + 1];
      index += 1;
    } else if (!argument.startsWith("--") && diagnosticsPath === undefined) {
      diagnosticsPath = argument;
    } else {
      throw usageError();
    }
  }
  if (diagnosticsPath === undefined) throw usageError();

  const policyArgs = [mode, eventName, outcomePath].filter((value) => value !== undefined).length;
  if (policyArgs !== 0 && policyArgs !== 3) throw usageError();
  const policy =
    policyArgs === 0
      ? undefined
      : {
          mode,
          eventName,
          outcome: readOutcome(outcomePath)
        };
  const result =
    refName === undefined
      ? describeSmokeSoftFail(diagnosticsPath)
      : decideSmokeSoftFail(diagnosticsPath, refName, policy);
  console.log(json ? JSON.stringify(result) : result.detail);
}

function readOutcome(outcomePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(outcomePath, "utf8"));
    return record(parsed);
  } catch {
    return {};
  }
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function usageError() {
  return new Error(
    "usage: describe-smoke-soft-fail.mjs [--json] [--ref <ref-name>] [--mode <mode> --event <event> --outcome <outcome.json>] <public-eval-diagnostics.json>"
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
