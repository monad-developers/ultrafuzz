import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createInitialRunState, reportSchema } from "@ultrafuzz/artifacts";
import {
  readReportPublicationStatus,
  writeReportPublicationStatus,
  reportPublicationStateBeforeRead,
  refreshReportPublicationStatusAfterRead
} from "../src/report-publication-status.js";
import {
  loadReportSnapshot,
  assertReportSnapshotRemainedCurrent,
  ReportUnavailableError
} from "../src/unverified-report.js";
import { temporaryRoot } from "./temporary-root.js";

function reportRun(name: string): string {
  const root = path.join(temporaryRoot("ultrafuzz-unverified-"), name);
  fs.mkdirSync(root);
  return root;
}

function writeAgentReport(root: string, status = "succeeded"): string {
  const runId = path.basename(root);
  fs.writeFileSync(
    path.join(root, "state.json"),
    JSON.stringify({
      run_id: runId,
      status: "failed",
      nodes: { "final-report": { status }, strategy: { status: "failed" } }
    })
  );
  fs.writeFileSync(
    path.join(root, "graph.json"),
    JSON.stringify({
      nodes: [{ id: "final-report", outputs: [{ path: "report.json", contract: "ultrafuzz/report@3" }] }]
    })
  );
  const directory = path.join(root, "artifacts", "final-report");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "report.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      schema_version: "ultrafuzz.report.v3",
      run_metadata: {
        run_id: runId,
        source_run_id: runId,
        repository: "example/repository",
        elapsed_time: "1m",
        models_used: [],
        tokens_used: "unavailable",
        estimated_spend: "unavailable",
        partial_pricing: true,
        strategy_loops: 0,
        audit_profile: "example",
        audit_profile_catalog_digest: "unavailable",
        topology_digest: "unavailable",
        prompt_digest: "unavailable",
        expanded_graph_fingerprint: "unavailable"
      },
      issues: [],
      non_production_outcomes: [],
      property_provenance: [],
      property_implementation_coverage: { status: "not-planned", reason: "property-implementation-track-not-declared" }
    })
  );
  return file;
}

test("readable agent-written reports remain available when verification records are missing", () => {
  const root = reportRun("missing-records");
  const file = writeAgentReport(root);
  const before = fs.readFileSync(file);
  const report = loadReportSnapshot(root);
  assert.equal(report.verification, "not-checked");
  assert.equal(report.terminal, true);
  assert.equal(report.artifacts.source, "unverified-runtime-report");
  assert.equal(report.observed_completion?.counts.planned, null);
  assert.equal(report.completion, undefined);
  const document = reportSchema.parse(report.json);
  assert.deepEqual(document.issues, []);
  assert.equal(document.run_metadata.repository, "example/repository");
  assert.match(report.markdown, /^# Ultrafuzz report — PARTIAL/u);
  assert.match(report.markdown, /verification not checked/iu);
  assert.match(report.markdown, /unknown/u);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readFileSync(report.artifacts.json_path), report.json_bytes);
  assert.deepEqual(fs.readFileSync(report.artifacts.markdown_path), report.markdown_bytes);
  assert.throws(() => loadReportSnapshot(root, { requireVerified: true }));
  assertReportSnapshotRemainedCurrent(report);
});

test("saved strategy findings never become a replacement report", () => {
  const root = reportRun("no-agent-report");
  fs.mkdirSync(path.join(root, "artifacts", "strategy"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "artifacts", "strategy", "findings.json"),
    JSON.stringify([{ title: "Recorded observation", summary: "A saved strategy result." }])
  );
  assert.throws(() => loadReportSnapshot(root), ReportUnavailableError);
  assert.equal(fs.existsSync(path.join(root, "review")), false);
});

for (const status of ["failed", "pending", "running", "skipped"]) {
  test(`a ${status} report task does not publish leftover agent output`, () => {
    const root = reportRun(`agent-${status}`);
    const file = writeAgentReport(root, status);
    const before = fs.readFileSync(file);
    assert.throws(() => loadReportSnapshot(root), /Report unavailable: no unique successful report-agent attempt/u);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(fs.existsSync(path.join(root, "review")), false);
  });
}

test("unchecked agent reports disclose saved failures without inventing planned counts", () => {
  const root = reportRun("failed-records");
  writeAgentReport(root);
  const report = loadReportSnapshot(root);
  assert.equal(report.observed_completion?.counts.planned, null);
  assert.deepEqual(report.observed_completion?.incomplete_nodes, [{ node_id: "strategy", outcome: "failed" }]);
  assert.match(report.markdown, /strategy/u);
});

test("missing and invalid agent JSON are report-unavailable, never replacement reports", () => {
  const root = reportRun("invalid-report");
  const file = writeAgentReport(root);
  for (const bytes of ["{", "{}", '{"issues":[]}']) {
    fs.writeFileSync(file, bytes);
    assert.throws(() => loadReportSnapshot(root), /Report unavailable:.*JSON/u);
  }
  fs.unlinkSync(file);
  assert.throws(() => loadReportSnapshot(root), ReportUnavailableError);
  assert.equal(fs.existsSync(path.join(root, "review")), false);
});

test("unchecked report reads reject symlinked files and noncanonical declared paths", () => {
  const root = reportRun("safe-report-input");
  const file = writeAgentReport(root);
  const outside = path.join(temporaryRoot("ultrafuzz-outside-"), "report.json");
  fs.renameSync(file, outside);
  fs.symlinkSync(outside, file);
  assert.throws(() => loadReportSnapshot(root), ReportUnavailableError);
  fs.unlinkSync(file);
  fs.copyFileSync(outside, file);
  for (const relative of ["../final-report/report.json", "./report.json", "/report.json"]) {
    fs.writeFileSync(
      path.join(root, "graph.json"),
      JSON.stringify({
        nodes: [{ id: "final-report", outputs: [{ path: relative, contract: "ultrafuzz/report@3" }] }]
      })
    );
    assert.throws(() => loadReportSnapshot(root), /declared report output path is invalid/u);
  }
});

test("unchecked report snapshots detect changed agent source without repairing it", () => {
  const root = reportRun("changed-records");
  const file = writeAgentReport(root);
  const before = loadReportSnapshot(root);
  const changed = JSON.parse(fs.readFileSync(file, "utf8"));
  changed.run_metadata.repository = "example/changed";
  fs.writeFileSync(file, JSON.stringify(changed));
  assert.throws(() => assertReportSnapshotRemainedCurrent(before), /inputs changed/u);
  const after = loadReportSnapshot(root);
  assert.notEqual(after.artifacts.json_path, before.artifacts.json_path);
  assert.match(after.markdown, /example\/changed/u);
  assert.deepEqual(fs.readFileSync(before.artifacts.json_path), before.json_bytes);
});

test("changed presentation files regenerate only from the successful report-agent output", () => {
  const root = reportRun("changed-presentation");
  const file = writeAgentReport(root);
  const original = fs.readFileSync(file);
  const report = loadReportSnapshot(root);
  fs.writeFileSync(report.artifacts.markdown_path, "edited presentation");
  fs.writeFileSync(report.artifacts.json_path, "{}");
  const regenerated = loadReportSnapshot(root);
  assert.deepEqual(regenerated.json_bytes, report.json_bytes);
  assert.deepEqual(fs.readFileSync(report.artifacts.markdown_path), report.markdown_bytes);
  assert.deepEqual(fs.readFileSync(file), original);
});

test("explicit report access refreshes unavailable or changed publication status without rerunning analysis", () => {
  const root = reportRun("publication-recovered");
  const file = writeAgentReport(root);
  const state = createInitialRunState({
    runId: path.basename(root),
    nodes: [
      { id: "final-report", status: "succeeded" },
      { id: "strategy", status: "failed" }
    ]
  });
  state.status = "failed";
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify(state));
  writeReportPublicationStatus({ runRoot: root, state, unavailableReason: "report-publication-failed" });
  assert.equal(readReportPublicationStatus(root, state).status, "unavailable");
  const original = fs.readFileSync(file);
  const report = loadReportSnapshot(root);
  assert.equal(readReportPublicationStatus(root, state).status, "available");
  fs.writeFileSync(report.artifacts.markdown_path, "edited presentation");
  assert.equal(readReportPublicationStatus(root, state).status, "unknown");
  const refreshed = loadReportSnapshot(root);
  const status = readReportPublicationStatus(root, state);
  assert.equal(status.status, "available");
  assert.equal(status.markdown_path, refreshed.artifacts.markdown_path);
  assert.deepEqual(fs.readFileSync(file), original);
  const beforeResume = reportPublicationStateBeforeRead(root);
  const summary = path.join(root, "review", "report-publication.json");
  const summaryIdentity = fs.statSync(summary).ino;
  state.status = "running";
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify(state));
  refreshReportPublicationStatusAfterRead(refreshed, beforeResume);
  assert.equal(fs.statSync(summary).ino, summaryIdentity);
  assert.equal(readReportPublicationStatus(root, state).status, "pending");
});

test("failure to save the status cache does not suppress explicit report access", () => {
  const root = reportRun("publication-cache-unwritable");
  writeAgentReport(root);
  const state = createInitialRunState({
    runId: path.basename(root),
    nodes: [{ id: "final-report", status: "succeeded" }]
  });
  state.status = "failed";
  fs.writeFileSync(path.join(root, "state.json"), JSON.stringify(state));
  fs.mkdirSync(path.join(root, "review", "report-publication.json"), { recursive: true });
  assert.equal(loadReportSnapshot(root).terminal, true);
  assert.equal(readReportPublicationStatus(root, state).status, "unknown");
});
