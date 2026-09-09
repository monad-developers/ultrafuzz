import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  assertNoSymlinkComponents,
  prepareSafeFilePath,
  readSinglyLinkedRegularFileSnapshotInside,
  safeResolveInside,
  sha256Bytes,
  validateSafeId,
  writeFileDurable,
  type ObservedReportCompletion
} from "@ultrafuzz/artifacts";

import { projectCanonicalFinalReport } from "./final-report-markdown.js";
import {
  loadCurrentFinalReportSnapshot,
  publishTerminalReport,
  type CurrentFinalReportSnapshot,
  type TerminalReportObservation
} from "./terminal-report.js";
import { readUnverifiedReportInputs, type UnverifiedReportInputs } from "./unverified-report-inputs.js";
import {
  reportPublicationStateBeforeRead,
  refreshReportPublicationStatusAfterRead
} from "./report-publication-status.js";
export { ReportUnavailableError } from "./report-unavailable.js";

export interface ReportSnapshot extends Omit<CurrentFinalReportSnapshot, "artifacts"> {
  artifacts: {
    markdown_path: string;
    json_path: string;
    source: CurrentFinalReportSnapshot["artifacts"]["source"] | "unverified-runtime-report";
  };
  verification: "verified" | "not-checked";
  observed_completion?: ObservedReportCompletion;
  /** Snapshot consistency only. This digest does not authenticate the input records. */
  sources_sha256?: string;
}

export interface ReportReadOptions {
  requireVerified?: boolean;
}

/** Optional verification applies to report presentation, never execution or scoring. */
export function loadReportSnapshot(runRoot: string, options: ReportReadOptions = {}): ReportSnapshot {
  const before = reportPublicationStateBeforeRead(runRoot);
  const report = loadAvailableReportSnapshot(runRoot, options);
  refreshReportPublicationStatusAfterRead(report, before);
  return report;
}

function loadAvailableReportSnapshot(runRoot: string, options: ReportReadOptions): ReportSnapshot {
  let verified: CurrentFinalReportSnapshot;
  try {
    verified = loadCurrentFinalReportSnapshot(runRoot);
  } catch (error) {
    if (options.requireVerified === true) throw error;
    return publishUnverifiedReport(runRoot);
  }
  if (options.requireVerified !== true && verified.artifacts.source === "verified-agent-report") {
    const inputs = readUnverifiedReportInputs(path.resolve(runRoot));
    if (stoppedStatus(inputs.state?.status)) return publishUnverifiedReport(runRoot, inputs);
  }
  return { ...verified, verification: "verified" };
}

/** The controller calls this only after observing the workflow stop. */
export function publishBestEffortTerminalReport(
  runRoot: string,
  observation: TerminalReportObservation
): ReportSnapshot | undefined {
  let verified: CurrentFinalReportSnapshot | undefined;
  try {
    verified = publishTerminalReport(runRoot, observation);
  } catch {
    return publishUnverifiedReport(runRoot);
  }
  if (verified === undefined) return undefined;
  return { ...verified, verification: "verified" };
}

export function assertReportSnapshotRemainedCurrent(snapshot: ReportSnapshot): void {
  const current =
    snapshot.verification === "verified"
      ? { ...loadCurrentFinalReportSnapshot(snapshot.run_root), verification: "verified" as const }
      : captureUnverifiedReport(readUnverifiedReportInputs(snapshot.run_root));
  if (!isDeepStrictEqual(current, snapshot)) throw new Error("report inputs changed after the snapshot was captured");
}

function publishUnverifiedReport(runRoot: string, captured?: UnverifiedReportInputs): ReportSnapshot {
  const inputs = captured ?? readUnverifiedReportInputs(path.resolve(runRoot));
  const snapshot = captureUnverifiedReport(inputs);
  for (const publication of snapshot.publications ?? []) {
    publishUncheckedPresentation(inputs.root, publication.path, publication.bytes);
  }
  return snapshot;
}

function publishUncheckedPresentation(root: string, file: string, bytes: Buffer): void {
  assertNoSymlinkComponents(root, file, "unchecked report output");
  if (fs.existsSync(file)) {
    const current = readSinglyLinkedRegularFileSnapshotInside(root, file, 64 * 1024 * 1024);
    if (current.equals(bytes)) return;
  }
  // These files are disposable presentations. Regenerate changed copies from
  // source records without changing agent artifacts or verified publications.
  writeFileDurable(prepareSafeFilePath(root, path.relative(root, file)), bytes);
}

function captureUnverifiedReport(inputs: UnverifiedReportInputs): ReportSnapshot {
  validateSafeId(inputs.runId, "run ID");
  const projection = projectCanonicalFinalReport({
    ...inputs.agentReport,
    verification: inputs.verification,
    observed_completion: inputs.observed
  });
  const jsonBytes = Buffer.from(`${JSON.stringify(projection.report, null, 2)}\n`, "utf8");
  const markdownBytes = Buffer.from(projection.markdown, "utf8");
  const generation = sha256Bytes(Buffer.concat([jsonBytes, markdownBytes]));
  const root = safeResolveInside(inputs.root, `review/unverified-report/${generation}`);
  const jsonPath = safeResolveInside(root, "report.json");
  const markdownPath = safeResolveInside(root, "report.md");
  return {
    run_root: inputs.root,
    artifacts: { json_path: jsonPath, markdown_path: markdownPath, source: "unverified-runtime-report" },
    json: projection.report,
    json_bytes: jsonBytes,
    markdown: projection.markdown,
    markdown_bytes: markdownBytes,
    validation_warnings: [],
    verification: "not-checked",
    observed_completion: inputs.observed,
    terminal: stoppedStatus(inputs.state?.status),
    sources_sha256: inputs.sources_sha256,
    publications: [
      { path: jsonPath, bytes: jsonBytes },
      { path: markdownPath, bytes: markdownBytes }
    ]
  };
}

function stoppedStatus(status: unknown): boolean {
  return typeof status === "string" && ["succeeded", "failed", "timed-out", "canceled"].includes(status);
}
