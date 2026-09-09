import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { redactSecretsInText } from "@ultrafuzz/security";

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
import { asRecord, readUnverifiedReportInputs, type UnverifiedReportInputs } from "./unverified-report-inputs.js";
import { loadVerifiedFinalReportSnapshot } from "./verified-output.js";

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
  let verified: CurrentFinalReportSnapshot;
  try {
    verified = loadCurrentFinalReportSnapshot(runRoot);
  } catch (error) {
    if (options.requireVerified === true) throw error;
    return publishUnverifiedReport(runRoot);
  }
  if (
    options.requireVerified !== true &&
    (lacksFinalReview(verified) || verified.artifacts.source === "verified-agent-report")
  ) {
    const inputs = readUnverifiedReportInputs(path.resolve(runRoot));
    if (
      (verified.artifacts.source === "verified-agent-report" && stoppedStatus(inputs.state?.status)) ||
      (lacksFinalReview(verified) && inputs.findings.length > 0)
    )
      return publishUnverifiedReport(runRoot, inputs);
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
  if (lacksFinalReview(verified)) {
    const inputs = readUnverifiedReportInputs(path.resolve(runRoot));
    if (inputs.findings.length > 0) return publishUnverifiedReport(runRoot, inputs);
  }
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
  const reviewed = optionalVerifiedAgentReport(inputs.root);
  const available = reviewed ?? {
    schema_version: "ultrafuzz.report.v3",
    run_metadata: observedMetadata(inputs),
    issues: [],
    non_production_outcomes: [],
    property_provenance: [],
    unreviewed_findings: inputs.findings,
    property_implementation_coverage: { status: "unavailable", reason: "final-review-not-completed" }
  };
  const verification =
    reviewed === undefined
      ? inputs.verification
      : {
          ...inputs.verification,
          reason_codes: inputs.verification.reason_codes.filter((reason) => reason !== "result-not-reviewed")
        };
  const projection = projectCanonicalFinalReport({
    ...available,
    verification,
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

function optionalVerifiedAgentReport(root: string): Record<string, unknown> | undefined {
  try {
    return asRecord(loadVerifiedFinalReportSnapshot(root).json);
  } catch {
    return undefined;
  }
}

function observedMetadata(inputs: UnverifiedReportInputs): Record<string, unknown> {
  const { runId, metadata, state } = inputs;
  const profile = asRecord(metadata?.audit_profile);
  const accounting = asRecord(asRecord(metadata?.accounting)?.cumulative);
  const digest = (value: unknown) =>
    typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : "unavailable";
  return {
    run_id: runId,
    source_run_id: runId,
    repository: "unavailable",
    elapsed_time: "unavailable",
    models_used: [],
    tokens_used: reportLabel(accounting?.tokens_used),
    estimated_spend: reportLabel(accounting?.estimated_spend),
    partial_pricing: true,
    strategy_loops: "unavailable",
    audit_profile: reportLabel(profile?.effective),
    audit_profile_catalog_digest: digest(profile?.catalog_digest),
    topology_digest: digest(profile?.topology_digest),
    prompt_digest: digest(metadata?.prompt_digest),
    expanded_graph_fingerprint: digest(state?.graph_fingerprint)
  };
}

function reportLabel(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) return "unavailable";
  const label = redactSecretsInText(value.slice(0, 512), "REDACTED");
  // Run-summary fields are inline labels, not arbitrary Markdown. Damaged
  // optional metadata must not make the canonical fallback unrenderable.
  for (const character of label) {
    if (
      character.charCodeAt(0) < 32 ||
      character.charCodeAt(0) === 127 ||
      ["<", ">", "[", "]", "`", "\\"].includes(character)
    )
      return "unavailable";
  }
  return label;
}

function lacksFinalReview(snapshot: CurrentFinalReportSnapshot): boolean {
  return asRecord(asRecord(snapshot.json)?.property_implementation_coverage)?.status === "unavailable";
}

function stoppedStatus(status: unknown): boolean {
  return typeof status === "string" && ["succeeded", "failed", "timed-out", "canceled"].includes(status);
}
