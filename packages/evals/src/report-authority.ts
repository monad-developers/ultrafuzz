import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { readRunState, sha256Bytes, type RunState } from "@ultrafuzz/artifacts";
import {
  loadVerifiedFinalReportSnapshot,
  type VerifiedFinalReportSnapshot,
  type VerifiedOutputArtifactSnapshot
} from "@ultrafuzz/runtime";

import type { EvalReportAuthority, EvalRunRecord } from "./types.js";
import { EvalError } from "./utils.js";

export interface BoundEvalReportAuthority {
  state: RunState;
  snapshot: VerifiedFinalReportSnapshot;
  authority: EvalReportAuthority;
}

/**
 * Bind scoring/publication to one current run-state identity and the exact
 * verified JSON/Markdown report bytes. No path or artifact is repaired.
 */
export function loadBoundEvalReportAuthority(
  record: EvalRunRecord,
  capturedSnapshot?: VerifiedFinalReportSnapshot
): BoundEvalReportAuthority {
  if (
    record.ultrafuzz_run_root === undefined ||
    record.ultrafuzz_run_id === undefined ||
    record.report_json_path === undefined
  ) {
    throw invalidReportAuthority(record, "eval run record has no bound Ultrafuzz report authority");
  }

  const state = readRunState(path.join(record.ultrafuzz_run_root, "state.json"));
  if (state.run_id !== record.ultrafuzz_run_id) {
    throw invalidReportAuthority(record, "eval run record and current run state name different run IDs", {
      recorded_run_id: record.ultrafuzz_run_id,
      current_run_id: state.run_id
    });
  }
  if (record.graph_fingerprint !== undefined && record.graph_fingerprint !== state.graph_fingerprint) {
    throw invalidReportAuthority(record, "recorded graph fingerprint does not match current run state");
  }
  if (record.config_fingerprint !== undefined && record.config_fingerprint !== state.config_fingerprint) {
    throw invalidReportAuthority(record, "recorded config fingerprint does not match current run state");
  }

  const snapshot = capturedSnapshot ?? loadVerifiedFinalReportSnapshot(record.ultrafuzz_run_root);
  if (path.resolve(snapshot.authority.run_root) !== path.resolve(record.ultrafuzz_run_root)) {
    throw invalidReportAuthority(record, "verified report snapshot belongs to a different run root");
  }
  if (path.resolve(snapshot.artifacts.json_path) !== path.resolve(record.report_json_path)) {
    throw invalidReportAuthority(
      record,
      "eval run record names a different report than current verification authority"
    );
  }
  const reportDocument = snapshot.json as { run_metadata?: { run_id?: unknown } };
  if (reportDocument.run_metadata?.run_id !== state.run_id) {
    throw invalidReportAuthority(record, "verified report names a different run than current run-state authority");
  }

  const report = exactSnapshotOutput(snapshot, snapshot.artifacts.json_path, "ultrafuzz/report@3", "JSON report");
  const markdown = exactSnapshotOutput(
    snapshot,
    snapshot.artifacts.markdown_path,
    "ultrafuzz/nonempty-markdown@1",
    "Markdown report"
  );
  if (
    report.schema_id === undefined ||
    report.schema_sha256 === undefined ||
    report.schema_bundle_sha256 === undefined ||
    report.validator_build === undefined
  ) {
    throw invalidReportAuthority(record, "verified report lacks complete schema/build identity");
  }
  if (report.sha256 !== sha256Bytes(snapshot.json_bytes) || markdown.sha256 !== sha256Bytes(snapshot.markdown_bytes)) {
    throw invalidReportAuthority(record, "verified report digests do not match the captured report bytes");
  }

  return {
    state,
    snapshot,
    authority: {
      ultrafuzz_run_id: state.run_id,
      producer_attempt_id: snapshot.authority.attempt_id,
      graph_fingerprint: state.graph_fingerprint,
      config_fingerprint: state.config_fingerprint,
      report_json_path: snapshot.artifacts.json_path,
      report_json_sha256: report.sha256,
      report_markdown_path: snapshot.artifacts.markdown_path,
      report_markdown_sha256: markdown.sha256,
      contract: "ultrafuzz/report@3",
      contract_digest: report.contract_digest,
      schema_id: report.schema_id,
      schema_sha256: report.schema_sha256,
      schema_bundle_sha256: report.schema_bundle_sha256,
      validator_build: report.validator_build
    }
  };
}

/** Require a persisted score authority to remain the exact current report authority. */
export function assertEvalReportAuthorityRemainedCurrent(
  record: EvalRunRecord,
  expected: EvalReportAuthority
): BoundEvalReportAuthority {
  const current = loadBoundEvalReportAuthority(record);
  if (!isDeepStrictEqual(current.authority, expected)) {
    throw invalidReportAuthority(record, "persisted score authority does not match the current verified report", {
      expected,
      current: current.authority
    });
  }
  return current;
}

function exactSnapshotOutput(
  snapshot: VerifiedFinalReportSnapshot,
  artifactPath: string,
  contract: VerifiedOutputArtifactSnapshot["contract"],
  label: string
): VerifiedOutputArtifactSnapshot {
  const matches = snapshot.authority.outputs.filter(
    (output) => output.contract === contract && path.resolve(output.absolute_path) === path.resolve(artifactPath)
  );
  if (matches.length !== 1) {
    throw new EvalError(
      "EVAL_TERMINAL_REPORT_INVALID",
      `verified final-report authority does not bind exactly one ${label}`,
      { path: artifactPath, contract, matches: matches.length }
    );
  }
  return matches[0]!;
}

function invalidReportAuthority(
  record: EvalRunRecord,
  message: string,
  details: Record<string, unknown> = {}
): EvalError {
  return new EvalError("EVAL_TERMINAL_REPORT_INVALID", message, {
    row_id: record.row_id,
    run_root: record.ultrafuzz_run_root,
    ...details
  });
}
