import { loadReportSnapshot, type ReportSnapshot } from "@ultrafuzz/runtime";

export interface ReportArtifacts {
  markdown_path: string;
  json_path: string;
  source: "verified-agent-report" | "verified-runtime-report" | "unverified-runtime-report";
  verification?: "verified" | "not-checked";
  completion?: "complete" | "partial";
  terminal?: boolean;
}

export type ReportArtifactsSnapshot = ReportSnapshot;

export function loadReportArtifactsSnapshot(
  runRoot: string,
  options?: { requireVerified?: boolean }
): ReportArtifactsSnapshot {
  return loadReportSnapshot(runRoot, options);
}
