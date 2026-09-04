import { loadVerifiedFinalReportSnapshot, type VerifiedFinalReportSnapshot } from "@ultrafuzz/runtime";

export interface ValidatedReportArtifacts {
  markdown_path: string;
  json_path: string;
  source: "verified-agent-report";
}

export interface ValidatedReportSnapshot {
  artifacts: ValidatedReportArtifacts;
  json: unknown;
  json_bytes: Buffer;
  markdown: string;
  markdown_bytes: Buffer;
  validation_warnings: VerifiedFinalReportSnapshot["validation_warnings"];
}

export function loadValidatedReportSnapshot(runRoot: string): ValidatedReportSnapshot {
  const report = loadVerifiedFinalReportSnapshot(runRoot);
  return {
    artifacts: report.artifacts,
    json: report.json,
    json_bytes: report.json_bytes,
    markdown: report.markdown,
    markdown_bytes: report.markdown_bytes,
    validation_warnings: report.validation_warnings
  };
}
