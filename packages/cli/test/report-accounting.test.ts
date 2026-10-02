import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  formatEstimatedSpendUsd,
  readRunMetadataDocument,
  writeRunMetadataDocument,
  type RunMetadataDocument
} from "@ultrafuzz/artifacts";
import type { ReportSnapshot } from "@ultrafuzz/runtime";

import { reportAccountingDiagnostics } from "../src/commands/report.js";
import { temporaryRoot } from "./temporary-root.js";

const RUN_ID = "report-accounting-run";
const WORKFLOW_RUN_ID = "workflow-current";

/** A run root whose run.json carries a spend estimate of `usd`. */
function runWithSpendEstimate(t: TestContext, usd: number): string {
  const runRoot = path.join(temporaryRoot("ufz-cli-report-accounting-", t), RUN_ID);
  fs.mkdirSync(runRoot, { recursive: true });
  writeRunMetadataDocument(path.join(runRoot, "run.json"), runMetadataWithSpendEstimate(usd));
  return runRoot;
}

function runMetadataWithSpendEstimate(usd: number): RunMetadataDocument {
  return {
    schema_version: "ultrafuzz.run-metadata.v2",
    run_id: RUN_ID,
    created_at: "2026-10-02T00:00:00.000Z",
    mode: "run",
    workflow_ids: [WORKFLOW_RUN_ID],
    redacted_config_fingerprint: "a".repeat(64),
    forge_guard: { enabled: true, active: true, virtual_memory_limit_kb: 1_048_576, rayon_threads: 4 },
    workflow: {
      run_id: WORKFLOW_RUN_ID,
      compiled_run_id: "compiled-current",
      name: "current workflow",
      path: "workflow.tsx",
      evidence_path: "evidence.json",
      expanded_graph_path: "expanded-graph.json",
      config_path: "config.json",
      input_path: "input.json",
      tasks_path: "tasks.json",
      control_integrity_path: "control-integrity.json",
      control_generation: "b".repeat(64),
      workflow_link_id: "123e4567-e89b-42d3-a456-426614174000",
      execution_snapshot_path: "execution-snapshot.json",
      task_node_ids: ["node-a-0"]
    },
    spend_estimate: {
      schema_version: "ultrafuzz.spend-estimate.v1",
      workflow_run_id: WORKFLOW_RUN_ID,
      estimated_spend_usd: usd,
      estimated_spend: formatEstimatedSpendUsd(usd),
      complete: true,
      fallback_pricing_table: "ultrafuzz.fallback-pricing.2026-10-01",
      basis_usd: { recorded: usd, catalog: 0, fallback: 0, imputed: 0, source_runs: 0 },
      accounted_attempts: 1,
      models: [{ model: "model-a", attempts: 1, estimated_spend_usd: usd, price_source: "recorded" }],
      assumptions: [],
      unaccounted_attempts: { count: 0, imputed_spend_usd: 0, omitted: 0, entries: [] },
      source_run_ids: [],
      updated_at: "2026-10-02T01:00:00.000Z"
    }
  };
}

/**
 * A report presentation of `spend`. A runtime presentation carries the run.json it restated, by
 * default the run root's current one.
 */
function presentation(
  runRoot: string,
  source: ReportSnapshot["artifacts"]["source"],
  spend: { markdown: string; json: unknown },
  restated: unknown = source === "verified-agent-report"
    ? undefined
    : readRunMetadataDocument(path.join(runRoot, "run.json"), RUN_ID)
): ReportSnapshot {
  const markdown = `# Report\n\n## Run summary\n\n- Tokens used: \`unavailable\`\n- Estimated spend: ${spend.markdown}\n`;
  const json = { run_metadata: { tokens_used: "unavailable", estimated_spend: spend.json } };
  return {
    ...(restated === undefined ? {} : { restated_run_metadata: restated }),
    run_root: runRoot,
    artifacts: { markdown_path: path.join(runRoot, "report.md"), json_path: path.join(runRoot, "report.json"), source },
    json,
    json_bytes: Buffer.from(JSON.stringify(json)),
    markdown,
    markdown_bytes: Buffer.from(markdown),
    validation_warnings: [],
    terminal: true,
    verification: source === "unverified-runtime-report" ? "not-checked" : "verified"
  };
}

function spendProblems(report: ReportSnapshot): Array<[string | undefined, string | undefined]> {
  return reportAccountingDiagnostics(report.run_root, report, false).map((diagnostic) => {
    const details = diagnostic.details as { field?: string; reason?: string } | undefined;
    assert.equal(diagnostic.code, "REPORT_ACCOUNTING_MISMATCH");
    assert.equal(details?.field, "estimated_spend");
    return [diagnostic.path === report.artifacts.json_path ? "json" : "markdown", details?.reason];
  });
}

test("runtime report presentations must restate run.json's spend estimate exactly", (t) => {
  const runRoot = runWithSpendEstimate(t, 0.46);
  for (const source of ["verified-runtime-report", "unverified-runtime-report"] as const) {
    assert.deepEqual(spendProblems(presentation(runRoot, source, { markdown: "`$0.46`", json: "$0.46" })), [], source);
    assert.deepEqual(
      spendProblems(presentation(runRoot, source, { markdown: "`$0.50`", json: "$0.4600" })),
      [
        ["markdown", "differs from the run.json spend estimate"],
        ["json", "differs from the run.json spend estimate"]
      ],
      source
    );
  }
});

test("a runtime presentation is checked against the run.json it restated, not a later rewrite", (t) => {
  const runRoot = runWithSpendEstimate(t, 0.46);
  for (const source of ["verified-runtime-report", "unverified-runtime-report"] as const) {
    const report = presentation(runRoot, source, { markdown: "`$0.46`", json: "$0.46" });
    // A synchronization rewrites the estimate after the presentation was captured.
    writeRunMetadataDocument(path.join(runRoot, "run.json"), runMetadataWithSpendEstimate(0.5));
    assert.deepEqual(spendProblems(report), [], source);
    // The record it restated, not the current file, sets the expectation.
    assert.deepEqual(
      spendProblems(
        presentation(runRoot, source, { markdown: "`$0.50`", json: "$0.50" }, runMetadataWithSpendEstimate(0.46))
      ),
      [
        ["markdown", "differs from the run.json spend estimate"],
        ["json", "differs from the run.json spend estimate"]
      ],
      source
    );
    writeRunMetadataDocument(path.join(runRoot, "run.json"), runMetadataWithSpendEstimate(0.46));
  }

  // An unchecked report that could not read run.json, or read an invalid one, cannot be checked.
  for (const restated of [undefined, { run_id: RUN_ID }]) {
    const report = presentation(runRoot, "unverified-runtime-report", { markdown: "`$0.46`", json: "$0.46" });
    const unreadable: ReportSnapshot = { ...report, restated_run_metadata: restated };
    const diagnostics = reportAccountingDiagnostics(runRoot, unreadable, false);
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.code),
      ["REPORT_ACCOUNTING_UNAVAILABLE"],
      JSON.stringify(restated)
    );
    assert.throws(() => reportAccountingDiagnostics(runRoot, unreadable, true));
  }
  assert.match(
    reportAccountingDiagnostics(
      runRoot,
      {
        ...presentation(runRoot, "unverified-runtime-report", { markdown: "`$0.46`", json: "$0.46" }),
        restated_run_metadata: undefined
      },
      false
    )[0]?.message ?? "",
    /run\.json could not be read when the report was presented/u
  );
});

test("the agent's report-start snapshot needs only a numeric spend estimate", (t) => {
  const runRoot = runWithSpendEstimate(t, 0.46);
  // Above or below the run's current estimate: the estimate is not monotonic.
  for (const spend of ["$3.26", "$0.10", "$0.0042"]) {
    assert.deepEqual(
      spendProblems(presentation(runRoot, "verified-agent-report", { markdown: `\`${spend}\``, json: spend })),
      [],
      spend
    );
  }
  // A `+` suffix or `unavailable` is never accepted, in a code span or inline.
  assert.deepEqual(
    spendProblems(presentation(runRoot, "verified-agent-report", { markdown: "`$0.46+`", json: "$0.46+" })),
    [
      ["markdown", "not a numeric USD estimate"],
      ["json", "not a numeric USD estimate"]
    ]
  );
  assert.deepEqual(
    spendProblems(presentation(runRoot, "verified-agent-report", { markdown: "$0.46+", json: "unavailable" })),
    [
      ["markdown", "not a numeric USD estimate"],
      ["json", "missing or unavailable"]
    ]
  );
  assert.deepEqual(
    spendProblems(presentation(runRoot, "verified-agent-report", { markdown: "unavailable", json: "$0.46" })),
    [["markdown", "missing or unavailable"]]
  );
  assert.deepEqual(
    spendProblems(presentation(runRoot, "verified-agent-report", { markdown: "$0.46 (estimated)", json: 0.46 })),
    [["json", "missing or unavailable"]]
  );

  // Its problems never name the run's estimate as the expected value.
  const [diagnostic] = reportAccountingDiagnostics(
    runRoot,
    presentation(runRoot, "verified-agent-report", { markdown: "`$0.46+`", json: "$0.46" }),
    false
  );
  assert.equal(
    diagnostic?.message,
    "markdown final report has no usable estimated_spend; got $0.46+ (not a numeric USD estimate)"
  );
  assert.deepEqual(diagnostic?.details, {
    field: "estimated_spend",
    actual: "$0.46+",
    reason: "not a numeric USD estimate"
  });
});
