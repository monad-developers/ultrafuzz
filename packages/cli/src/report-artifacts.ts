import { loadVerifiedFinalReportSnapshot } from "@ultrafuzz/runtime";

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
}

/**
 * Locate an agent-authored final report only after current verifier and
 * controller finalization records bind its exact bytes. This compatibility
 * export retains the CLI-local API name while delegating the trust boundary to
 * the shared runtime reader used by other external consumers.
 */
export function loadValidatedReportArtifacts(runRoot: string): ValidatedReportArtifacts {
  return loadValidatedReportSnapshot(runRoot).artifacts;
}

export function loadValidatedReportSnapshot(runRoot: string): ValidatedReportSnapshot {
  const report = loadVerifiedFinalReportSnapshot(runRoot);
  return {
    artifacts: report.artifacts,
    json: report.json,
    json_bytes: report.json_bytes,
    markdown: report.markdown,
    markdown_bytes: report.markdown_bytes
  };
}
