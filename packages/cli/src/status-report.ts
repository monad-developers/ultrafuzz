import { TERMINAL_RUN_STATE_STATUSES } from "@ultrafuzz/artifacts";
import type { RunHealthValue } from "@ultrafuzz/runtime";

const TERMINAL_RUN_STATUSES = new Set<string>(TERMINAL_RUN_STATE_STATUSES);
const STOP_WATCH_VERDICTS = new Set<RunHealthValue["verdict"]>([
  "done",
  "degraded",
  "orphaned",
  "cancel-pending",
  "paused",
  "cancelled",
  "failed"
]);
const REPORT_REASONS: Readonly<Record<string, string>> = {
  "run-has-not-ended": "The run has not ended.",
  "run-lifecycle-unknown": "Run records disagree about whether execution has ended.",
  "report-publication-not-recorded": "No current report publication result was recorded.",
  "published-report-files-changed-or-unreadable": "The published report files changed or could not be read.",
  "report-agent-output-unavailable": "The report agent did not produce usable output.",
  "report-publication-failed": "The agent report could not be published."
};

/** The watch may also stop for attention; callers must read ended before treating it as completion. */
export function shouldRefreshStatus(value: Pick<RunHealthValue, "ended" | "status" | "verdict"> | undefined): boolean {
  return (
    value !== undefined &&
    value.ended !== true &&
    !TERMINAL_RUN_STATUSES.has(value.status) &&
    !STOP_WATCH_VERDICTS.has(value.verdict)
  );
}

export function renderReportStatusLines(value: Pick<RunHealthValue, "ended" | "report">): string[] {
  const report = value.report;
  return [
    `Run ended: ${value.ended === null ? "unknown" : value.ended ? "yes" : "no"}`,
    `Report: ${report.status}`,
    ...(report.reason === null ? [] : [`Report reason: ${REPORT_REASONS[report.reason] ?? report.reason}`]),
    `Report completion: ${report.completion.toUpperCase()}`,
    `Report verification: ${report.verification}`,
    ...(report.markdown_path === null ? [] : [`Report Markdown: ${report.markdown_path}`]),
    ...(report.json_path === null ? [] : [`Report JSON: ${report.json_path}`])
  ];
}
