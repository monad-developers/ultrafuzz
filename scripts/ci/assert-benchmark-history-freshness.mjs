import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import * as evals from "../../packages/evals/dist/index.js";

/**
 * Wall-clock freshness gate for the published benchmark history.
 *
 * Every other gate in this repository reasons about the run in front of it, so a
 * producer that soft-fails on every push and a publication that is correctly
 * refused every time both read as an unbroken row of green checks. Nothing else
 * compares the published document against the calendar; this does.
 *
 * The recency rule is NOT reimplemented here. `readEvalHistory` owns the document
 * contract and `assertEvalHistoryRecency` owns the staleness comparison and its
 * refusal to age an observation-less history, so a second copy of either cannot
 * drift out from under this monitor.
 */

const MILLISECONDS_PER_DAY = 86_400_000;
const CANONICAL_HISTORY_EXPORTS = ["readEvalHistory", "assertEvalHistoryRecency"];

/**
 * Resolve the canonical history API, refusing to run at all when it is absent.
 * A missing build must fail this monitor, never quietly reduce it to a no-op.
 */
function canonicalHistoryApi() {
  for (const name of CANONICAL_HISTORY_EXPORTS) {
    if (typeof evals[name] !== "function") {
      throw new Error(
        `packages/evals/dist/index.js does not export ${name}; ` +
          "build the workspace (pnpm --filter @ultrafuzz/evals... build) before asserting history freshness"
      );
    }
  }
  return evals;
}

/**
 * Measure the published history against a freshness budget.
 *
 * `now` is injected so the verdict is a function of its inputs alone.
 *
 * @param {{ historyPath: string, maxAgeDays: number, now: Date }} input
 */
export function assertBenchmarkHistoryFreshness(input) {
  const historyPath = input.historyPath;
  if (typeof historyPath !== "string" || historyPath.length === 0) {
    throw new Error("a history path is required");
  }
  const maxAgeDays = input.maxAgeDays;
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    throw new Error(`max age must be a positive number of days, received ${String(maxAgeDays)}`);
  }
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new Error("a valid current instant is required");
  }
  const resolved = path.resolve(historyPath);
  const entry = fs.statSync(resolved, { throwIfNoEntry: false });
  // `readEvalHistory` answers a missing file with an empty history, so an absent
  // document has to be refused here rather than aged as if it were readable.
  if (entry === undefined || !entry.isFile()) throw new Error(`${historyPath} is not a regular file`);

  const api = canonicalHistoryApi();
  const history = api.readEvalHistory(resolved);
  const stale = historyIsStale(api.assertEvalHistoryRecency, history, maxAgeDays, input.now);
  const newest = newestObservation(history.observations);
  if (newest === undefined) throw new Error(`${historyPath} carries no observation to age`);
  return {
    history_path: historyPath,
    status: stale ? "stale" : "fresh",
    newest: {
      run_timestamp: newest.run_timestamp,
      source_eval_run_id: newest.source_eval_run_id,
      candidate_commit: newest.candidate_commit,
      benchmark: newest.benchmark,
      lane: newest.lane
    },
    age_days: (input.now.getTime() - Date.parse(newest.run_timestamp)) / MILLISECONDS_PER_DAY,
    max_age_days: maxAgeDays,
    observation_count: history.observations.length
  };
}

export function describeBenchmarkHistoryFreshness(result) {
  if (result.status === "fresh") {
    return [`## Benchmark history is advancing`, ``, ...newestTable(result), ``].join("\n");
  }
  return [
    `## Benchmark history has stopped advancing`,
    ``,
    `\`${result.history_path}\` has published no new observation for ${result.age_days.toFixed(1)} days,`,
    `past the ${result.max_age_days}-day freshness budget. Automatic smoke runs are meant to publish on roughly every`,
    `push to \`main\`, so this is a producer or publication outage rather than a quiet week.`,
    ``,
    ...newestTable(result),
    ``,
    `### Where to look, in the order this has actually failed before`,
    ``,
    `1. **The producer soft-failed on push.** \`scripts/ci/describe-smoke-soft-fail.mjs\` forgives`,
    `   \`resume-required\`, \`transient-operational-failure\`, \`permanent-operational-failure\`,`,
    `   \`collection-failed\` and \`collection-timeout\` when \`mode == "smoke"\` and the event is \`push\`, so a`,
    `   run that collected no bundle at all still exits 0. Green \`Modal Eval Benchmarks\` push runs are`,
    `   therefore not evidence that data was produced.`,
    `   \`\`\``,
    `   gh run list --workflow eval-benchmarks.yml --event push --limit 20`,
    `   gh run view <run-id> --log | grep -iE "soft.fail|scoring_ready|exit_category|diagnostic_code"`,
    `   \`\`\``,
    `2. **The publication classifier refused and skipped.**`,
    `   \`scripts/ci/classify-modal-benchmark-publication.mjs\` reports \`ready: false\` for an incomplete`,
    `   generation and \`Publish Eval History\` then no-ops green. That refusal is correct and must keep`,
    `   failing closed: the defect is always upstream of it, never in loosening it.`,
    `   \`\`\``,
    `   gh run list --workflow eval-history-publication.yml --limit 20`,
    `   \`\`\``,
    `3. **No producer run exists at all,** or push runs are being cancelled by merge velocity before they`,
    `   finish. Compare the push-run count against the merge count over the same window.`,
    `4. **A smoke target became unreachable before the model ran.** A dependency that was made private or`,
    `   deleted — a target's transitive git submodule is the known shape — makes the credential-less sandbox`,
    `   clone abort in seconds with \`model_work_started: false\`, \`exit_category: "unreachable"\` and`,
    `   \`diagnostic_code: "dependency-unreachable"\`. Reproduce by cloning the pinned target revision and`,
    `   running \`git submodule update --init --recursive --depth 1\` with no credential.`,
    ``,
    `This monitor asserts freshness only. It never writes, repairs, or synthesizes history data.`,
    ``
  ].join("\n");
}

/** Exit code by verdict: a stale history is a failure, not a warning. */
export function benchmarkHistoryFreshnessExitCode(status) {
  return status === "fresh" ? 0 : 1;
}

/**
 * Delegate the verdict to the canonical rule. Only its staleness code is a
 * verdict; an empty, unparseable, or unaskable history propagates, because an
 * unevaluable monitor must fail loudly rather than report freshness.
 */
function historyIsStale(assertRecency, history, maxAgeDays, now) {
  try {
    assertRecency({ history, maxAgeDays, now });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EVAL_HISTORY_STALE") return true;
    throw error;
  }
  return false;
}

function newestObservation(observations) {
  let newest;
  let newestMilliseconds = Number.NEGATIVE_INFINITY;
  for (const observation of observations) {
    const milliseconds = Date.parse(observation.run_timestamp);
    if (milliseconds > newestMilliseconds) {
      newest = observation;
      newestMilliseconds = milliseconds;
    }
  }
  return newest;
}

function newestTable(result) {
  return [
    `| Field | Value |`,
    `| --- | --- |`,
    `| Document | \`${result.history_path}\` |`,
    `| Newest \`run_timestamp\` | \`${result.newest.run_timestamp}\` |`,
    `| Age | ${result.age_days.toFixed(2)} days |`,
    `| Freshness budget | ${result.max_age_days} days |`,
    `| Observations | ${result.observation_count} |`,
    `| Newest \`source_eval_run_id\` | \`${result.newest.source_eval_run_id}\` |`,
    `| Newest \`candidate_commit\` | \`${result.newest.candidate_commit}\` |`,
    `| Newest benchmark / lane | \`${result.newest.benchmark}\` / \`${result.newest.lane}\` |`
  ];
}

function appendFile(target, value) {
  if (target === undefined || target.length === 0) return;
  fs.appendFileSync(target, value);
}

function main(args) {
  let historyPath;
  let maxAgeDaysText;
  let reportPath;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--history" && args[index + 1] !== undefined) {
      historyPath = args[index + 1];
      index += 1;
    } else if (argument === "--max-age-days" && args[index + 1] !== undefined) {
      maxAgeDaysText = args[index + 1];
      index += 1;
    } else if (argument === "--report" && args[index + 1] !== undefined) {
      reportPath = args[index + 1];
      index += 1;
    } else {
      throw usageError();
    }
  }
  if (historyPath === undefined || maxAgeDaysText === undefined || reportPath === undefined) throw usageError();
  const result = assertBenchmarkHistoryFreshness({
    historyPath,
    maxAgeDays: Number(maxAgeDaysText),
    now: new Date()
  });
  const report = describeBenchmarkHistoryFreshness(result);
  appendFile(
    process.env.GITHUB_OUTPUT,
    [
      `status=${result.status}`,
      `newest_run_timestamp=${result.newest.run_timestamp}`,
      `age_days=${result.age_days.toFixed(2)}`,
      ``
    ].join("\n")
  );
  fs.writeFileSync(reportPath, report);
  appendFile(process.env.GITHUB_STEP_SUMMARY, report);
  if (result.status === "fresh") process.stdout.write(report);
  else process.stderr.write(report);
  process.exitCode = benchmarkHistoryFreshnessExitCode(result.status);
}

function usageError() {
  return new Error(
    "usage: assert-benchmark-history-freshness.mjs --history <history.json> --max-age-days <days> --report <report.md>"
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
