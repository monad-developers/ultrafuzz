import assert from "node:assert/strict";
import test from "node:test";

import { renderReportStatusLines, shouldRefreshStatus } from "../src/status-report.js";

test("watch stops at ended runs with unavailable reports and distinguishes attention stops", () => {
  assert.equal(shouldRefreshStatus({ ended: true, status: "failed", verdict: "failed" }), false);
  assert.equal(shouldRefreshStatus({ ended: true, status: "succeeded", verdict: "degraded" }), false);
  assert.equal(shouldRefreshStatus({ ended: false, status: "running", verdict: "running-healthy" }), true);
  assert.equal(shouldRefreshStatus({ ended: false, status: "paused", verdict: "paused" }), false);
  assert.equal(shouldRefreshStatus({ ended: false, status: "running", verdict: "cancel-pending" }), false);
  assert.equal(shouldRefreshStatus(undefined), false);
});

test("status shows complete execution with a partial unchecked report without changing the execution verdict", () => {
  const lines = renderReportStatusLines({
    ended: true,
    report: {
      status: "available",
      reason: null,
      completion: "partial",
      verification: "not-checked",
      json_path: "/run/review/report.json",
      markdown_path: "/run/review/report.md"
    }
  });
  assert.deepEqual(lines, [
    "Run ended: yes",
    "Report: available",
    "Report completion: PARTIAL",
    "Report verification: not-checked",
    "Report Markdown: /run/review/report.md",
    "Report JSON: /run/review/report.json"
  ]);
});

test("status shows report failure and unknown coverage without presenting a false report path", () => {
  const lines = renderReportStatusLines({
    ended: true,
    report: {
      status: "unavailable",
      reason: "report-agent-output-unavailable",
      completion: "unknown",
      verification: "unknown",
      json_path: null,
      markdown_path: null
    }
  });
  assert.ok(lines.includes("Run ended: yes"));
  assert.ok(lines.includes("Report: unavailable"));
  assert.ok(lines.includes("Report reason: The report agent did not produce usable output."));
  assert.ok(lines.includes("Report completion: UNKNOWN"));
  assert.equal(
    lines.some((line) => line.startsWith("Report Markdown:")),
    false
  );
});
