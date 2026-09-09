import { loadCurrentFinalReportSnapshot, type CurrentFinalReportSnapshot } from "@ultrafuzz/runtime";

export interface ValidatedReportArtifacts {
  markdown_path: string;
  json_path: string;
  source: "verified-agent-report" | "verified-runtime-report";
  completion?: "complete" | "partial";
  terminal?: boolean;
}

export type ValidatedReportSnapshot = CurrentFinalReportSnapshot;

export function loadValidatedReportSnapshot(runRoot: string): ValidatedReportSnapshot {
  return loadCurrentFinalReportSnapshot(runRoot);
}
