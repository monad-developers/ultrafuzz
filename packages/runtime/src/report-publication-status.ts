import fs from "node:fs";
import path from "node:path";

import {
  assertNoSymlinkComponents,
  isTerminalRunStatus,
  layoutForRunRoot,
  prepareSafeFilePath,
  readSinglyLinkedRegularFileSnapshotInside,
  readRunState,
  safeResolveInside,
  sha256Bytes,
  toPosixRelativePath,
  writeFileDurable,
  type RunState
} from "@ultrafuzz/artifacts";

import {
  REPORT_PUBLICATION_STATUS_JSON_SCHEMA_ID,
  REPORT_PUBLICATION_STATUS_SCHEMA_VERSION,
  type ReportPublicationFileIdentity,
  type ReportPublicationStatusDocument
} from "./runtime-contracts.js";
import { parseRuntimeDocumentBytes, serializeRuntimeDocument } from "./runtime-document-codec.js";
import type { RunHealthVerdict, RunReportStatus } from "./types.js";
import type { ReportSnapshot } from "./unverified-report.js";

const SUMMARY_PATH = "review/report-publication.json";
const TERMINAL_WORKFLOW_STATUSES = new Set(["finished", "continued", "failed", "cancelled"]);
const LIVE_WORKFLOW_STATUSES = new Set([
  "running",
  "waiting-approval",
  "waiting-event",
  "waiting-timer",
  "waiting-quota",
  "paused",
  "unsubmitted"
]);

/** Capture identity before explicit report access; unverifiable run records must not block that access. */
export function reportPublicationStateBeforeRead(runRoot: string): RunState | undefined {
  try {
    const state = readRunState(layoutForRunRoot(path.resolve(runRoot)));
    return isTerminalRunStatus(state.status) ? state : undefined;
  } catch {
    return undefined;
  }
}

/** Explicit report access may repair a previous publication failure; ordinary status polls never call this. */
export function refreshReportPublicationStatusAfterRead(report: ReportSnapshot, before: RunState | undefined): void {
  if (before === undefined) return;
  try {
    const current = reportPublicationStateBeforeRead(report.run_root);
    if (current === undefined || publicationStateFingerprint(before) !== publicationStateFingerprint(current)) return;
    writeReportPublicationStatus({ runRoot: report.run_root, state: current, report });
  } catch {
    // Presentation remains useful even when its optional status cache cannot be saved.
  }
}

/** A stopped watch is not proof that execution ended: pauses and attention are separate states. */
export function observedRunEnded(
  runStatus: RunState["status"],
  workflowStatus: string,
  verdict?: RunHealthVerdict
): boolean | null {
  if (verdict === "cancel-pending" || verdict === "paused") return false;
  const localEnded = isTerminalRunStatus(runStatus);
  if (TERMINAL_WORKFLOW_STATUSES.has(workflowStatus)) return localEnded ? true : null;
  if (LIVE_WORKFLOW_STATUSES.has(workflowStatus)) return localEnded ? null : false;
  return null;
}

/** Cheap observation only: one bounded summary read and two file identities, with no report parsing. */
export function readReportPublicationStatus(runRoot: string, state: RunState, ended?: boolean | null): RunReportStatus {
  if (ended === null) return emptyStatus("unknown", "run-lifecycle-unknown");
  if (ended === false) return emptyStatus("pending", "run-has-not-ended");
  if (!isTerminalRunStatus(state.status)) return emptyStatus("pending", "run-has-not-ended");
  const saved = readCurrentSummary(runRoot, state);
  if (saved === undefined) return emptyStatus("unknown", "report-publication-not-recorded");
  if (saved.status === "unavailable") return emptyStatus("unavailable", saved.reason);
  try {
    if (saved.json_file === null || saved.markdown_file === null) throw new Error("published report paths are missing");
    const jsonPath = currentFilePath(runRoot, saved.json_file);
    const markdownPath = currentFilePath(runRoot, saved.markdown_file);
    return {
      status: "available",
      reason: null,
      completion: saved.completion,
      verification: saved.verification,
      json_path: jsonPath,
      markdown_path: markdownPath
    };
  } catch {
    return emptyStatus("unknown", "published-report-files-changed-or-unreadable");
  }
}

/** Failure is also a publication result: polling must not repeatedly attempt report generation. */
export function hasCurrentReportPublicationStatus(runRoot: string, state: RunState): boolean {
  return isTerminalRunStatus(state.status) && readCurrentSummary(runRoot, state) !== undefined;
}

/** Called once after the controller completes its report publication attempt for this terminal state. */
export function writeReportPublicationStatus(input: {
  runRoot: string;
  state: RunState;
  report?: Pick<ReportSnapshot, "artifacts" | "verification" | "completion" | "observed_completion">;
  unavailableReason?: Exclude<ReportPublicationStatusDocument["reason"], null>;
}): RunReportStatus {
  if (!isTerminalRunStatus(input.state.status)) throw new Error("report publication requires an ended run");
  const root = path.resolve(input.runRoot);
  const report = input.report;
  const summary: ReportPublicationStatusDocument = {
    schema_version: REPORT_PUBLICATION_STATUS_SCHEMA_VERSION,
    state_fingerprint: publicationStateFingerprint(input.state),
    status: report === undefined ? "unavailable" : "available",
    reason: report === undefined ? (input.unavailableReason ?? "report-agent-output-unavailable") : null,
    completion: report?.completion?.outcome ?? report?.observed_completion?.outcome ?? "unknown",
    verification: report?.verification ?? "unknown",
    json_file: report === undefined ? null : fileIdentity(root, report.artifacts.json_path),
    markdown_file: report === undefined ? null : fileIdentity(root, report.artifacts.markdown_path)
  };
  writeFileDurable(
    prepareSafeFilePath(root, SUMMARY_PATH),
    serializeRuntimeDocument(REPORT_PUBLICATION_STATUS_JSON_SCHEMA_ID, summary, "report publication status")
  );
  return readReportPublicationStatus(root, input.state);
}

function readCurrentSummary(runRoot: string, state: RunState): ReportPublicationStatusDocument | undefined {
  try {
    const root = path.resolve(runRoot);
    const summary = parseRuntimeDocumentBytes(
      REPORT_PUBLICATION_STATUS_JSON_SCHEMA_ID,
      readSinglyLinkedRegularFileSnapshotInside(root, safeResolveInside(root, SUMMARY_PATH), 16 * 1024),
      "report publication status"
    );
    return summary.state_fingerprint === publicationStateFingerprint(state) ? summary : undefined;
  } catch {
    return undefined;
  }
}

function publicationStateFingerprint(state: RunState): string {
  // Exclude controller heartbeats and observed concurrency; ordinary status polling changes them.
  // Include recovery and node attempt records so a resumed run cannot reuse a previous final result.
  return sha256Bytes(
    Buffer.from(
      JSON.stringify({
        run_id: state.run_id,
        status: state.status,
        graph_fingerprint: state.graph_fingerprint,
        config_fingerprint: state.config_fingerprint,
        started_at: state.started_at,
        finished_at: state.finished_at,
        last_transition_at: state.last_transition_at,
        provenance: state.provenance,
        nodes: Object.entries(state.nodes)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([id, node]) => [
            id,
            node.status,
            node.retry_count,
            node.attempt_index,
            node.loop_index,
            node.started_at,
            node.finished_at,
            node.provenance
          ])
      })
    )
  );
}

function fileIdentity(root: string, candidate: string): ReportPublicationFileIdentity {
  const relative = toPosixRelativePath(root, candidate);
  const file = safeResolveInside(root, relative);
  assertNoSymlinkComponents(root, file, "published report");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("published report must be a singly linked regular file");
  return {
    path: relative,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtime_ms: stat.mtimeMs,
    ctime_ms: stat.ctimeMs
  };
}

function currentFilePath(root: string, saved: ReportPublicationFileIdentity): string {
  const file = safeResolveInside(root, saved.path);
  const current = fileIdentity(root, file);
  if (
    Object.keys(current).some(
      (key) => current[key as keyof ReportPublicationFileIdentity] !== saved[key as keyof ReportPublicationFileIdentity]
    )
  ) {
    throw new Error("published report file changed");
  }
  return file;
}

function emptyStatus(status: RunReportStatus["status"], reason: string | null): RunReportStatus {
  return { status, reason, completion: "unknown", verification: "unknown", json_path: null, markdown_path: null };
}
