import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createInitialRunState, createNodeState } from "@ultrafuzz/artifacts";
import {
  hasCurrentReportPublicationStatus,
  observedRunEnded,
  readReportPublicationStatus,
  writeReportPublicationStatus
} from "../src/report-publication-status.js";
import { temporaryRoot } from "./temporary-root.js";

test("ended distinguishes terminal execution from pauses, cancellation requests, and conflicting observations", () => {
  assert.equal(observedRunEnded("succeeded", "finished", "degraded"), true);
  assert.equal(observedRunEnded("failed", "failed", "failed"), true);
  assert.equal(observedRunEnded("timed-out", "cancelled", "cancelled"), true);
  assert.equal(observedRunEnded("paused", "paused", "paused"), false);
  assert.equal(observedRunEnded("running", "running", "cancel-pending"), false);
  assert.equal(observedRunEnded("running", "running", "degraded"), false);
  assert.equal(observedRunEnded("failed", "running", "running-healthy"), null);
  assert.equal(observedRunEnded("running", "finished", "done"), null);
  assert.equal(observedRunEnded("running", "unknown"), null);
  assert.equal(observedRunEnded("pending", "unsubmitted", "launch-incomplete"), false);
});

test("failed report attempts are terminal observations and repeated polling does not create reports or rewrite the summary", () => {
  const root = temporaryRoot("ufz-report-status-");
  const state = createInitialRunState({ runId: "failed-report" });
  state.status = "failed";
  assert.deepEqual(readReportPublicationStatus(root, state), {
    status: "unknown",
    reason: "report-publication-not-recorded",
    completion: "unknown",
    verification: "unknown",
    json_path: null,
    markdown_path: null
  });
  assert.equal(fs.existsSync(path.join(root, "review")), false);
  writeReportPublicationStatus({ runRoot: root, state });
  const summary = path.join(root, "review", "report-publication.json");
  const before = fs.statSync(summary);
  for (let index = 0; index < 3; index += 1) {
    assert.equal(hasCurrentReportPublicationStatus(root, state), true);
    assert.equal(readReportPublicationStatus(root, state).status, "unavailable");
  }
  assert.deepEqual(fs.readdirSync(path.dirname(summary)), ["report-publication.json"]);
  assert.equal(fs.statSync(summary).mtimeMs, before.mtimeMs);
  assert.equal(fs.statSync(summary).ino, before.ino);
  assert.equal(readReportPublicationStatus(root, state, false).status, "pending");
  assert.equal(readReportPublicationStatus(root, state, null).status, "unknown");
});

test("partial publication is available without requiring report verification and loses availability if its files change", () => {
  const root = temporaryRoot("ufz-report-status-");
  const state = createInitialRunState({ runId: "partial-report" });
  state.status = "succeeded";
  const reportRoot = path.join(root, "review", "agent-report");
  fs.mkdirSync(reportRoot, { recursive: true });
  const jsonPath = path.join(reportRoot, "report.json");
  const markdownPath = path.join(reportRoot, "report.md");
  fs.writeFileSync(jsonPath, "{}\n");
  fs.writeFileSync(markdownPath, "# Agent report — PARTIAL\n");
  const result = writeReportPublicationStatus({
    runRoot: root,
    state,
    report: {
      artifacts: { json_path: jsonPath, markdown_path: markdownPath, source: "verified-agent-report" },
      verification: "not-checked",
      observed_completion: {
        outcome: "partial",
        counts: {
          planned: null,
          succeeded: null,
          failed: null,
          timed_out: null,
          skipped: null,
          cancelled: null,
          unverified: null
        }
      }
    }
  });
  assert.deepEqual(result, {
    status: "available",
    reason: null,
    completion: "partial",
    verification: "not-checked",
    json_path: jsonPath,
    markdown_path: markdownPath
  });
  fs.writeFileSync(jsonPath, "[]\n");
  assert.equal(readReportPublicationStatus(root, state).status, "unknown");
  // Changed files must not make a status poll launch or rebuild the report again.
  assert.equal(hasCurrentReportPublicationStatus(root, state), true);
  assert.equal(fs.readFileSync(jsonPath, "utf8"), "[]\n");
});

test("resume invalidates the previous publication even when it later returns to the same terminal status", () => {
  const root = temporaryRoot("ufz-report-status-");
  const state = createInitialRunState({ runId: "resumed-report", nodes: [{ id: "report" }] });
  state.status = "failed";
  writeReportPublicationStatus({ runRoot: root, state, unavailableReason: "report-publication-failed" });
  state.status = "running";
  assert.equal(readReportPublicationStatus(root, state).status, "pending");
  assert.equal(hasCurrentReportPublicationStatus(root, state), false);
  state.nodes.report = createNodeState({ id: "report", status: "failed" });
  state.nodes.report.retry_count = 1;
  state.status = "failed";
  assert.equal(hasCurrentReportPublicationStatus(root, state), false);
  assert.equal(readReportPublicationStatus(root, state).status, "unknown");
  writeReportPublicationStatus({ runRoot: root, state });
  assert.equal(readReportPublicationStatus(root, state).reason, "report-agent-output-unavailable");
  state.controller_lease.renewed_at = new Date().toISOString();
  state.concurrency.observed_at = new Date().toISOString();
  assert.equal(hasCurrentReportPublicationStatus(root, state), true);
});

test("missing, invalid and oversized publication records remain unknown without failing status or inventing coverage", () => {
  const root = temporaryRoot("ufz-report-status-");
  const state = createInitialRunState({ runId: "missing-report" });
  state.status = "failed";
  writeReportPublicationStatus({ runRoot: root, state });
  const summary = path.join(root, "review", "report-publication.json");
  for (const bytes of ["{", " ".repeat(17 * 1024), '{"status":"available"}']) {
    fs.writeFileSync(summary, bytes);
    const result = readReportPublicationStatus(root, state);
    assert.equal(result.status, "unknown");
    assert.equal(result.completion, "unknown");
    assert.equal(result.json_path, null);
  }
});
