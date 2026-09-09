import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { reportSchema } from "@ultrafuzz/artifacts";
import { loadReportSnapshot, assertReportSnapshotRemainedCurrent } from "../src/unverified-report.js";
import { temporaryRoot } from "./temporary-root.js";

function reportRun(name: string): string {
  const root = path.join(temporaryRoot("ultrafuzz-unverified-"), name);
  fs.mkdirSync(root);
  return root;
}

function writeResult(root: string, node: string, content: unknown): string {
  const directory = path.join(root, "artifacts", node);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "findings.json");
  fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

test("missing run records produce unknown counts and explicitly unreviewed readable findings", () => {
  const root = reportRun("missing-records");
  const file = writeResult(root, "strategy", [
    { title: "Recorded observation", summary: "The strategy recorded this observation." }
  ]);
  const before = fs.readFileSync(file);
  const report = loadReportSnapshot(root);
  assert.equal(report.verification, "not-checked");
  assert.equal(report.terminal, false);
  assert.equal(report.artifacts.source, "unverified-runtime-report");
  assert.equal(report.observed_completion?.counts.planned, null);
  assert.equal(report.observed_completion?.counts.succeeded, null);
  assert.equal(report.completion, undefined);
  const document = reportSchema.parse(report.json);
  assert.deepEqual(document.issues, []);
  assert.equal(document.unreviewed_findings?.[0]?.title, "Recorded observation");
  assert.match(report.markdown, /^# Ultrafuzz report — PARTIAL/u);
  assert.match(report.markdown, /verification not checked/iu);
  assert.match(report.markdown, /unknown/u);
  assert.match(report.markdown, /unreviewed/iu);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readFileSync(report.artifacts.json_path), report.json_bytes);
  assert.deepEqual(fs.readFileSync(report.artifacts.markdown_path), report.markdown_bytes);
  assert.throws(() => loadReportSnapshot(root, { requireVerified: true }));
  assertReportSnapshotRemainedCurrent(report);
});

test("invalid state and unreadable results do not discard other readable results", () => {
  const root = reportRun("bad-records");
  fs.writeFileSync(path.join(root, "state.json"), "{");
  fs.writeFileSync(writeResult(root, "broken", {}), "{");
  writeResult(root, "readable", { issues: [{ title: "Available", description: "Readable candidate." }] });
  const report = loadReportSnapshot(root);
  const document = reportSchema.parse(report.json);
  assert.equal(document.unreviewed_findings?.length, 1);
  assert.equal(document.unreviewed_findings[0]?.title, "Available");
  assert.ok(document.verification?.reason_codes.includes("record-invalid"));
  assert.equal(report.observed_completion?.counts.failed, null);
  assert.equal(fs.readFileSync(path.join(root, "state.json"), "utf8"), "{");
});

test("unchecked reports disclose saved failures without inferring complete planned counts", () => {
  const root = reportRun("failed-records");
  fs.writeFileSync(
    path.join(root, "state.json"),
    JSON.stringify({
      run_id: "failed-records",
      status: "failed",
      nodes: {
        strategy: { status: "failed" },
        review: { status: "pending" },
        finished: { status: "succeeded" }
      }
    })
  );
  const report = loadReportSnapshot(root);
  assert.equal(report.terminal, true);
  assert.equal(report.observed_completion?.counts.planned, null);
  assert.deepEqual(report.observed_completion?.incomplete_nodes, [
    { node_id: "review", outcome: "unverified" },
    { node_id: "strategy", outcome: "failed" }
  ]);
  assert.match(report.markdown, /strategy/u);
});

test("report-only reads exclude symlinks and retain local path boundaries", () => {
  const root = reportRun("symlink-records");
  const outside = path.join(temporaryRoot("ultrafuzz-outside-"), "private.json");
  fs.writeFileSync(outside, JSON.stringify({ findings: [{ title: "Outside", summary: "Must not be included." }] }));
  const file = writeResult(root, "linked", {});
  fs.unlinkSync(file);
  fs.symlinkSync(outside, file);
  const report = loadReportSnapshot(root);
  assert.deepEqual(reportSchema.parse(report.json).unreviewed_findings, []);
  assert.doesNotMatch(report.markdown, /Must not be included/u);
  assert.ok(reportSchema.parse(report.json).verification?.reason_codes.includes("result-unreadable"));
});

test("unchecked report snapshots detect changes without repairing source records", () => {
  const root = reportRun("changed-records");
  const file = writeResult(root, "strategy", { findings: [{ title: "First", summary: "Original." }] });
  const before = loadReportSnapshot(root);
  fs.writeFileSync(file, JSON.stringify({ findings: [{ title: "Second", summary: "Updated." }] }));
  assert.throws(() => assertReportSnapshotRemainedCurrent(before), /inputs changed/u);
  const after = loadReportSnapshot(root);
  assert.notEqual(after.artifacts.json_path, before.artifacts.json_path);
  assert.match(after.markdown, /Second/u);
  assert.deepEqual(fs.readFileSync(before.artifacts.json_path), before.json_bytes);
});

test("unchecked reports bound candidate output and redact secret-shaped text", () => {
  const root = reportRun("bounded-records");
  writeResult(root, "strategy", {
    findings: Array.from({ length: 300 }, (_, index) => ({
      title: `Observation ${index}`,
      summary: "api_key=abcdefghijklmnopqrstuvwx1234567890"
    }))
  });
  const report = loadReportSnapshot(root);
  const document = reportSchema.parse(report.json);
  assert.equal(document.unreviewed_findings?.length, 256);
  assert.ok(document.verification?.reason_codes.includes("results-truncated"));
  assert.doesNotMatch(report.markdown, /abcdefghijklmnopqrstuvwx1234567890/u);
});

test("changed unchecked presentation files can be regenerated without changing result files", () => {
  const root = reportRun("changed-presentation");
  const file = writeResult(root, "strategy", [{ title: "Recorded", summary: "Available candidate." }]);
  const original = fs.readFileSync(file);
  const report = loadReportSnapshot(root);
  fs.writeFileSync(report.artifacts.markdown_path, "edited presentation");
  fs.writeFileSync(report.artifacts.json_path, "{}");
  const regenerated = loadReportSnapshot(root);
  assert.deepEqual(regenerated.json_bytes, report.json_bytes);
  assert.deepEqual(fs.readFileSync(report.artifacts.markdown_path), report.markdown_bytes);
  assert.deepEqual(fs.readFileSync(file), original);
});

test("malformed optional display metadata cannot block the unchecked report", () => {
  const root = reportRun("invalid-labels");
  fs.writeFileSync(
    path.join(root, "run.json"),
    JSON.stringify({
      run_id: "invalid-labels",
      audit_profile: { effective: "<broken>" },
      accounting: { cumulative: { tokens_used: "[bad](https://example.test)", estimated_spend: "`broken`" } }
    })
  );
  const report = loadReportSnapshot(root);
  const document = reportSchema.parse(report.json);
  assert.equal(document.run_metadata.audit_profile, "unavailable");
  assert.equal(document.run_metadata.tokens_used, "unavailable");
  assert.equal(document.run_metadata.estimated_spend, "unavailable");
  assert.match(report.markdown, /^# Ultrafuzz report — PARTIAL/u);
});
