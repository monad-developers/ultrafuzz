import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  assertRegularFileInside,
  artifactValidationWarningsSchema,
  parseStrictJsonBytes,
  readRegularFileSnapshot,
  reportCompletionSchema,
  reportObservedCompletionSchema,
  reportUnreviewedFindingsSchema,
  reportVerificationSchema,
  safeResolveInside,
  validateArtifactContract,
  type ArtifactValidationWarning,
  type ReportCompletion,
  type ReportObservedCompletion,
  type ReportUnreviewedFinding,
  type ReportVerification
} from "@ultrafuzz/artifacts";
import { redactSecretsInText, type SecretScanMode } from "@ultrafuzz/security";

export const MAX_FINAL_REPORT_JSON_BYTES = 64 * 1024 * 1024;
export const MAX_FINAL_REPORT_MARKDOWN_BYTES = 16 * 1024 * 1024;
const SAFE_REPORT_RELATIVE_LINK_PATTERN = /^\.\.\/(?:(?!\.\.?\/)[A-Za-z0-9._-]+\/)+(?!\.\.?$)[A-Za-z0-9._-]+$/u;
/**
 * Secret placeholder for the public projection only. Two constraints pick it:
 *
 * - The public bundle re-projects the published report.json and requires the same bytes back, so
 *   the placeholder must be a fixed point of the redaction pass. The key-name assignment rule's
 *   unquoted value class stops at whitespace, `,`, `;`, `]`, and `}`, so a placeholder containing
 *   any of those is re-redacted on the next pass (`token=[redacted]` becomes `token=[redacted]]`).
 * - The final-review Markdown gate rejects raw HTML, images, and links outside fenced code, and
 *   redacted values land unescaped in inline code (run summary values, coverage paths, source
 *   nodes), so the placeholder must not read as HTML (`<redacted>`), a link (`[redacted](`),
 *   an image, or emphasis (`*`, `_`).
 *
 * A bare uppercase word satisfies both. Every other redaction keeps the security package's default.
 */
const PUBLIC_SECRET_REDACTION_PLACEHOLDER = "REDACTED";
const PARTIAL_REPORT_WARNING =
  "> **PARTIAL REPORT — coverage is incomplete.** This run did not complete successfully. The findings below cover the available verified results; missing results are coverage gaps, and an empty findings list is not a clean result. See [Run completion](#run-completion).";
const PARTIAL_EMPTY_FINDINGS_NOTICE =
  "No production issues were reported from the available verified results. This partial report is not a clean result and does not establish that uncompleted work found no issues. See [Run completion](#run-completion).";
const UNAVAILABLE_FINAL_REVIEW_NOTICE =
  "**No verified report agent output is available; final review was not completed.** Property implementation coverage is unknown. This report does not claim that no properties were planned or implemented.";
const UNCHECKED_PARTIAL_REPORT_WARNING =
  "> **PARTIAL REPORT — verification not checked.** This report uses available saved results. Task counts and results could not be fully verified. Missing or uncertain results are coverage gaps, and an empty findings list is not a clean result. See [Run completion](#run-completion).";
const UNCHECKED_EMPTY_FINDINGS_NOTICE =
  "No final findings are included in this report. Available unreviewed findings are listed separately. This partial report is not a clean result and does not establish that unfinished or unchecked work found no issues. See [Run completion](#run-completion).";
const UNCHECKED_FINAL_REVIEW_NOTICE =
  "**Final review was not completed or could not be verified.** Property implementation coverage is unknown. This report does not claim that no properties were planned or implemented.";
const REPORT_VERIFICATION_REASON_TEXT: Record<ReportVerification["reason_codes"][number], string> = {
  "verification-unavailable": "Run and output verification could not be completed.",
  "record-missing": "Some saved run records are missing.",
  "record-invalid": "Some saved run records did not pass the required checks.",
  "result-unreadable": "Some output files could not be read.",
  "result-not-reviewed": "Some available findings did not complete final review.",
  "results-truncated": "Some available results were omitted because a file, item, or size limit was reached."
};

/**
 * The run-root goal-search census the runtime writes (issue #677), and the schema version it stamps.
 *
 * Exported from the renderer because every runtime producer and external verified-output reader has
 * to name the same file and schema version. The census stays beside the run, never inside the closed
 * report.json contract.
 */
export const GOAL_SEARCH_COVERAGE_FILE = "goal-search-coverage.json";
export const GOAL_SEARCH_COVERAGE_SCHEMA_VERSION = "ultrafuzz.goal-search-coverage.v1";
export const MAX_GOAL_SEARCH_COVERAGE_BYTES = 64 * 1024 * 1024;

export function loadGoalSearchCoverageSnapshot(runRoot: string): unknown | undefined {
  const coveragePath = safeResolveInside(runRoot, GOAL_SEARCH_COVERAGE_FILE, "goal search coverage census");
  if (!fs.existsSync(coveragePath)) return undefined;
  assertRegularFileInside(runRoot, coveragePath, "goal search coverage census");
  let parsed: unknown;
  try {
    parsed = parseStrictJsonBytes(readRegularFileSnapshot(coveragePath, MAX_GOAL_SEARCH_COVERAGE_BYTES), {
      maxBytes: MAX_GOAL_SEARCH_COVERAGE_BYTES
    });
  } catch {
    return undefined;
  }
  if (
    !isRecord(parsed) ||
    parsed.schema_version !== GOAL_SEARCH_COVERAGE_SCHEMA_VERSION ||
    parsed.run_id !== path.basename(path.resolve(runRoot))
  ) {
    return undefined;
  }
  return parsed;
}

type JsonRecord = Record<string, unknown>;

const reportSummaryFields = [
  ["Run ID", "run_id"],
  ["Source run ID", "source_run_id"],
  ["Repository", "repository"],
  ["Elapsed time", "elapsed_time"],
  ["Models used", "models_used"],
  ["Tokens used", "tokens_used"],
  ["Estimated spend", "estimated_spend"],
  ["Audit profile", "audit_profile"]
] as const;

const severityOrder = ["High", "Medium", "Low"] as const;
type ReportSeverity = (typeof severityOrder)[number];

interface RenderedIssue {
  issue: JsonRecord;
  id: string;
  severity: ReportSeverity;
  title: string;
}

interface RenderableProof {
  steps: string[];
  code: string;
  language: string;
}

export interface CanonicalFinalReportProjection {
  report: JsonRecord;
  markdown: string;
}

export interface CanonicalFinalReportContext {
  /** Runtime-owned run-root census; it is never copied into the closed report.json contract. */
  goalSearchCoverage?: unknown;
}

/**
 * Project a verified internal report across the public privacy boundary.
 *
 * Internal report.json remains the immutable agent/controller authority used by
 * scoring and lifecycle consumers. Public publication instead receives a deep
 * copy with secrets and private filesystem paths redacted, then re-validates
 * and renders that copy as an exact canonical JSON/Markdown pair. The ordinary
 * canonical projection remains the unredacted developer report.
 */
export function projectPublicCanonicalFinalReport(
  report: unknown,
  context: CanonicalFinalReportContext = {}
): CanonicalFinalReportProjection {
  const internal = projectCanonicalFinalReport(report, context);
  const publicReport = redactSecretsInStringValues(redactPrivatePathsInValue(internal.report));
  if (!isRecord(publicReport)) {
    throw new Error("public final-report projection did not produce an object");
  }
  preserveDistinctPublicCompletionNodes(internal.report, publicReport);
  const projection = projectCanonicalFinalReport(publicReport, context);
  if (
    containsPrivatePathInValue(projection.report) ||
    containsPrivatePath(projection.markdown) ||
    containsUnredactedSecretInValue(projection.report) ||
    containsUnredactedSecretInMarkdown(projection.markdown, projection.report)
  ) {
    throw new Error("public final-report projection contains private report content");
  }
  return projection;
}

/**
 * Return whether a schema-valid final report carries enough final-review
 * evidence to project the public Markdown contract without inventing content.
 */
export function supportsCanonicalFinalReportProjection(report: unknown): report is JsonRecord {
  if (!isRecord(report) || !Array.isArray(report.issues)) {
    return false;
  }
  return report.issues.every((issue) => {
    if (!isRecord(issue)) {
      return false;
    }
    return (
      requiredAssessmentIfPresent(issue, "impact") !== undefined &&
      requiredAssessmentIfPresent(issue, "likelihood") !== undefined &&
      proofOfConcept(issue) !== undefined
    );
  });
}

/**
 * Validate final-review issue presentation and render its allowlisted public
 * Markdown without repairing, reordering, or rewriting the validated report.
 * This function is intentionally filesystem-free so the CLI and generated
 * runtime use exactly the same checks and rendering.
 */
export function projectCanonicalFinalReport(
  report: unknown,
  context: CanonicalFinalReportContext = {}
): CanonicalFinalReportProjection {
  assertReportJsonWithinBound(report);
  const input = validateReport(report);
  if (isCanonicalEmptyReport(input)) {
    throw new Error("canonical empty final report is not final-review evidence");
  }
  if (!supportsCanonicalFinalReportProjection(input)) {
    throw new Error("final report is not renderable under the final-review report contract");
  }

  assertCanonicalIssuePresentation(input);
  assertStructuredStrategyProvenance(input);

  const markdown = renderCanonicalReport(input, context.goalSearchCoverage);
  if (Buffer.byteLength(markdown, "utf8") > MAX_FINAL_REPORT_MARKDOWN_BYTES) {
    throw new Error(`canonical final report Markdown exceeds ${MAX_FINAL_REPORT_MARKDOWN_BYTES} bytes`);
  }
  const directiveViolation = finalReportMarkdownDirectiveViolation(markdown, input);
  if (directiveViolation !== undefined) {
    throw new Error(
      `canonical final report Markdown does not satisfy the final-review report shape: ${directiveViolation}`
    );
  }
  const markdownValidation = validateArtifactContract("ultrafuzz/nonempty-markdown@1", markdown, "report.md");
  if (!markdownValidation.ok) {
    throw new Error(reportValidationMessage(markdownValidation.issues));
  }
  return { report: input, markdown };
}

export function isDirectiveConformingFinalReportMarkdown(markdown: string, report: JsonRecord): boolean {
  return finalReportMarkdownDirectiveViolation(markdown, report) === undefined;
}

function finalReportMarkdownDirectiveViolation(markdown: string, report: JsonRecord): string | undefined {
  const completionResult = reportCompletionSchema.optional().safeParse(report.completion);
  if (!completionResult.success) return "invalid report completion census";
  const completion = completionResult.data;
  const observationResult = reportObservedCompletionSchema.optional().safeParse(report.observed_completion);
  const verificationResult = reportVerificationSchema.optional().safeParse(report.verification);
  const unreviewedResult = reportUnreviewedFindingsSchema.optional().safeParse(report.unreviewed_findings);
  if (!observationResult.success || !verificationResult.success || !unreviewedResult.success) {
    return "invalid unchecked report metadata";
  }
  const observed = observationResult.data;
  const verification = verificationResult.data;
  if (
    (observed !== undefined || verification !== undefined || unreviewedResult.data !== undefined) &&
    (observed === undefined || verification === undefined || completion !== undefined)
  ) {
    return "unchecked reports require observations without a completion census";
  }
  if (completion !== undefined && completion.run_id !== recordField(report, "run_metadata")?.run_id) {
    return "completion run ID does not match the report";
  }
  const opening = reportOpening(completion, observed);
  if (!markdown.startsWith(opening) || !markdown.includes("\n## Run summary\n")) {
    return "missing report title or run summary";
  }
  const completionViolation = completionMarkdownViolation(markdown, report, completion, observed, verification);
  if (completionViolation !== undefined) return completionViolation;
  const unreviewedViolation = unreviewedMarkdownViolation(markdown, unreviewedResult.data);
  if (unreviewedViolation !== undefined) return unreviewedViolation;
  if (!markdown.includes("\n## Property implementation coverage\n")) {
    return "missing property implementation coverage";
  }
  if (
    recordField(report, "property_implementation_coverage")?.status === "unavailable" &&
    !markdownOutsideFencedCode(markdown).includes(
      observed === undefined ? UNAVAILABLE_FINAL_REVIEW_NOTICE : UNCHECKED_FINAL_REVIEW_NOTICE
    )
  ) {
    return "missing unavailable final-review disclosure";
  }
  // A current-run projection always states its goal-search coverage, even when that statement is
  // "coverage is unknown". Requiring the heading keeps a future edit from turning a partial hunt back
  // into silence, which is indistinguishable from full coverage to a reader (issue #677). Both
  // coverage headings are required unconditionally: the former requireImplementationCoverage
  // parameter had no remaining caller and coupled the goal-coverage requirement to the
  // property-implementation one, so a single flag could silently drop both (issue #702).
  if (!markdown.includes("\n## Goal search coverage\n")) {
    return "missing goal search coverage";
  }
  if (!markdown.includes("\n## Property provenance\n")) {
    return "missing property provenance";
  }
  const prose = markdownOutsideFencedCode(markdown).replace(/<br\s*\/?\s*>/giu, "");
  const proseViolation = finalReportProseDirectiveViolation(prose);
  if (proseViolation !== undefined) return proseViolation;
  const rendered = renderedIssues(Array.isArray(report.issues) ? report.issues.filter(isRecord) : []);
  const expectedHeadings = rendered.map(renderedIssueHeading);
  const headings = markdown.split("\n").filter((line) => line.startsWith("## ["));
  if (
    headings.length !== expectedHeadings.length ||
    headings.some((heading, index) => heading !== expectedHeadings[index])
  ) {
    return "issue headings do not match the validated report order";
  }
  // Exact equality above proves the Markdown kept the validated JSON order,
  // IDs, and titles. Presentation never assigns severity-local identities.
  if (expectedHeadings.length === 0) {
    return markdown.includes("| Issue id | Title |") ? "contains an issue index without rendered issues" : undefined;
  }
  if (!markdown.startsWith(`${opening}| Issue id | Title |\n| --- | --- |\n`)) {
    return "issue index is missing or malformed";
  }
  const issueBlocks = expectedHeadings.map((heading, index) => {
    const start = markdown.indexOf(`${heading}\n`);
    const nextHeading = expectedHeadings[index + 1];
    const end =
      nextHeading === undefined ? markdown.length : markdown.indexOf(`${nextHeading}\n`, start + heading.length);
    return markdown.slice(start, end < 0 ? markdown.length : end);
  });
  return issueBlocks.every((block) => {
    const severityIndex = block.indexOf("\n### Severity\n");
    const proofIndex = block.indexOf("\n### Proof of Concept\n");
    return severityIndex >= 0 && proofIndex > severityIndex;
  })
    ? undefined
    : "an issue is missing severity or proof-of-concept ordering";
}

function completionMarkdownViolation(
  markdown: string,
  report: JsonRecord,
  completion: ReportCompletion | undefined,
  observed: ReportObservedCompletion | undefined,
  verification: ReportVerification | undefined
): string | undefined {
  const prose = markdownOutsideFencedCode(markdown);
  const sections = prose.split("\n## Run completion\n");
  if (completion === undefined && observed === undefined) {
    return sections.length !== 1 ||
      prose.includes(PARTIAL_REPORT_WARNING) ||
      prose.includes(UNCHECKED_PARTIAL_REPORT_WARNING)
      ? "contains completion claims without a report completion census"
      : undefined;
  }
  const completionSection = sections[1];
  if (sections.length !== 2 || completionSection === undefined) return "missing or repeated run completion census";
  const expected: string[] = [];
  appendRunCompletion(expected, completion, observed, verification);
  const actualSection = `## Run completion\n${completionSection.split("\n## ")[0] ?? ""}`.trim();
  if (actualSection !== expected.join("\n").trim()) return "run completion census does not match the report";
  const completionIndex = prose.indexOf("\n## Run completion\n");
  const firstFindingIndex = prose.indexOf("\n## [");
  if (
    completionIndex < prose.indexOf("\n## Run summary\n") ||
    (firstFindingIndex >= 0 && completionIndex > firstFindingIndex)
  ) {
    return "run completion census must precede findings";
  }
  if (completion?.outcome === "partial" || observed !== undefined) {
    if (/^No issues reported\.$/mu.test(prose)) return "partial report claims a clean empty result";
    const emptyNotice = observed === undefined ? PARTIAL_EMPTY_FINDINGS_NOTICE : UNCHECKED_EMPTY_FINDINGS_NOTICE;
    if (Array.isArray(report.issues) && report.issues.length === 0 && !prose.includes(emptyNotice)) {
      return "partial report is missing its empty findings caveat";
    }
  } else if (prose.includes(PARTIAL_REPORT_WARNING) || prose.includes(PARTIAL_EMPTY_FINDINGS_NOTICE)) {
    return "complete report contains partial completion claims";
  }
  return undefined;
}

function unreviewedMarkdownViolation(
  markdown: string,
  findings: ReportUnreviewedFinding[] | undefined
): string | undefined {
  const sections = markdownOutsideFencedCode(markdown).split("\n## Unreviewed findings\n");
  if (findings === undefined || findings.length === 0) {
    return sections.length === 1 ? undefined : "unreviewed findings have no report source";
  }
  const section = sections[1];
  if (sections.length !== 2 || section === undefined) return "missing or repeated unreviewed findings";
  const expected: string[] = [];
  appendUnreviewedFindings(expected, findings);
  return `## Unreviewed findings\n${section.split("\n## ")[0] ?? ""}`.trim() === expected.join("\n").trim()
    ? undefined
    : "unreviewed findings do not match the report";
}

function finalReportProseDirectiveViolation(prose: string): string | undefined {
  // Critical is not a supported report severity, but the word remains valid in explanatory prose
  // (for example, "a critical invariant"). Reject only a standalone severity-like label rather than
  // rewriting or discarding the validated finding text.
  const forbiddenPatterns: ReadonlyArray<readonly [RegExp, string]> = [
    [/(?:^|\n)(?:#{1,6}\s+|-\s+)?(?:\*\*)?Critical(?:\*\*)?\s*$/imu, "contains the unsupported Critical severity"],
    [/(?:^|\n)#### Sources\s*$/imu, "contains a legacy Sources section"],
    [/\*\*Source (?:Node|Property) Id\*\*/iu, "contains a legacy source identifier field"],
    [/(?:^|\n)- \*\*Item \d+\*\*/imu, "contains a legacy numbered-item field"],
    [/(?:^|\n)## (?:Executive summary|Issue index|Additional report data)\s*$/imu, "contains a legacy report section"],
    [/(?:^|\n)#{3,6} (?:Lifecycle|Strategy|Strategy provenance)\s*$/imu, "contains a legacy issue subsection"],
    [
      /(?:^|\n)- (?:Strategy loops|Audit profile catalog digest|Topology digest|Prompt digest|Expanded graph fingerprint):/imu,
      "contains legacy run metadata"
    ],
    [/<[A-Za-z][^>]*>/u, "contains raw HTML outside fenced code"],
    [/!\[[^\]]*\]\(/u, "contains an embedded image outside fenced code"],
    [
      /(?<!\\)\]\((?!(?:#[a-z0-9-]+|\.\.\/(?:(?!\.\.?\/)[A-Za-z0-9._-]+\/)+(?!\.\.?\))[A-Za-z0-9._-]+)\))/iu,
      "contains a disallowed Markdown link outside fenced code"
    ]
  ];
  return forbiddenPatterns.find(([pattern]) => pattern.test(prose))?.[1];
}

function validateReport(report: unknown): JsonRecord {
  const serialized = `${JSON.stringify(report)}\n`;
  const validation = validateArtifactContract("ultrafuzz/report@3", serialized, "report.json");
  if (!validation.ok || !isRecord(validation.value)) {
    throw new Error(reportValidationMessage(validation.issues));
  }
  return validation.value;
}

function assertReportJsonWithinBound(report: unknown): void {
  let serialized: string;
  try {
    serialized = `${JSON.stringify(report, null, 2)}\n`;
  } catch (error) {
    throw new Error("final report JSON could not be serialized", { cause: error });
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_FINAL_REPORT_JSON_BYTES) {
    throw new Error(`final report JSON exceeds ${MAX_FINAL_REPORT_JSON_BYTES} bytes`);
  }
}

function reportValidationMessage(issues: Array<{ code: string; message: string; path: string }>): string {
  const detail = issues.slice(0, 5).map((issue) => `${issue.code} at ${issue.path}: ${issue.message}`);
  return `final report JSON failed validation${detail.length === 0 ? "" : `: ${detail.join("; ")}`}`;
}

function isCanonicalEmptyReport(value: JsonRecord): boolean {
  return (
    isRecord(value.run_metadata) &&
    Object.keys(value.run_metadata).length === 0 &&
    Array.isArray(value.issues) &&
    value.issues.length === 0 &&
    Array.isArray(value.non_production_outcomes) &&
    value.non_production_outcomes.length === 0
  );
}

function assertCanonicalIssuePresentation(report: JsonRecord): void {
  if (!Array.isArray(report.issues)) return;
  const counters: Record<ReportSeverity, number> = { High: 0, Medium: 0, Low: 0 };
  let priorSeverityIndex = -1;
  const findingsById = new Map<string, JsonRecord>();
  for (const [index, candidate] of report.issues.entries()) {
    if (!isRecord(candidate)) {
      throw new Error(`final report production issue ${index} is not an object`);
    }
    const impact = requiredAssessment(candidate, "impact");
    const likelihood = requiredAssessment(candidate, "likelihood");
    const severity = requiredSeverity(candidate);
    const expectedSeverity = matrixSeverity(impact.label, likelihood.label);
    if (severity !== expectedSeverity) {
      throw new Error(
        `final report production issue ${index} has severity ${severity}; expected ${expectedSeverity} from impact ${impact.label} and likelihood ${likelihood.label}`
      );
    }
    const severityIndex = severityOrder.indexOf(severity);
    if (severityIndex < priorSeverityIndex) {
      throw new Error("final report production issues are not ordered High, Medium, then Low");
    }
    priorSeverityIndex = severityIndex;
    counters[severity] += 1;
    const findingId = `${severity[0]}-${String(counters[severity]).padStart(2, "0")}`;
    if (candidate.id !== findingId) {
      throw new Error(`final report production issue ${index} must use canonical ID ${findingId}`);
    }
    const title = recordTitle(candidate, "");
    const expectedTitle = `[${findingId}] - ${cleanIssueTitle(title)}`;
    if (title !== expectedTitle || cleanIssueTitle(title) === "") {
      throw new Error(`final report production issue ${findingId} must use title ${JSON.stringify(expectedTitle)}`);
    }
    findingsById.set(findingId, candidate);
  }

  for (const candidate of Array.isArray(report.non_production_outcomes) ? report.non_production_outcomes : []) {
    if (isRecord(candidate) && typeof candidate.id === "string") findingsById.set(candidate.id, candidate);
  }
  for (const [index, candidate] of (Array.isArray(report.property_provenance)
    ? report.property_provenance
    : []
  ).entries()) {
    if (!isRecord(candidate) || typeof candidate.finding_id !== "string") continue;
    const finding = findingsById.get(candidate.finding_id);
    if (finding === undefined) {
      throw new Error(
        `final report property provenance ${index} references unknown finding ${JSON.stringify(candidate.finding_id)}`
      );
    }
    if (candidate.title !== finding.title) {
      throw new Error(`final report property provenance ${index} title does not equal its referenced finding title`);
    }
  }
}

/**
 * Keep machine-readable execution provenance honest even though it is no longer developer-facing.
 * A detection is one distinct contributing execution, not one duplicate finding or family member.
 */
function assertStructuredStrategyProvenance(report: JsonRecord): void {
  for (const [recordIndex, candidate] of finalReportFindingRecords(report).entries()) {
    const provenance = recordField(candidate, "strategy_provenance");
    if (provenance === undefined) continue;
    const lifecycle = recordField(candidate, "lifecycle");
    const authenticatedHits = Array.isArray(lifecycle?.strategy_hits)
      ? (lifecycle.strategy_hits as unknown[]).filter(isRecord)
      : [];
    assertPreservedStrategyAttempts(provenance.attempts, authenticatedHits, recordIndex);
    const detectionsByStrategy = strategyDetectionCounts(provenance, recordIndex);
    assertStrategyAttempts(authenticatedHits, detectionsByStrategy, recordIndex);
  }
}

function assertPreservedStrategyAttempts(
  value: unknown,
  authenticatedHits: readonly JsonRecord[],
  recordIndex: number
): void {
  if (value === undefined) return;
  if (!isDeepStrictEqual(value, authenticatedHits)) {
    throw new Error(
      `final report record ${String(recordIndex)} strategy attempts do not exactly preserve authenticated lifecycle strategy hits`
    );
  }
}

function finalReportFindingRecords(report: JsonRecord): unknown[] {
  const issues = Array.isArray(report.issues) ? (report.issues as unknown[]) : [];
  const outcomes = Array.isArray(report.non_production_outcomes) ? (report.non_production_outcomes as unknown[]) : [];
  return issues.concat(outcomes);
}

function strategyDetectionCounts(provenance: JsonRecord, recordIndex: number): Map<string, number> {
  const rates = Array.isArray(provenance.detection_rates)
    ? (provenance.detection_rates as unknown[]).filter(isRecord)
    : [];
  const detectionsByStrategy = new Map<string, number>();
  for (const rate of rates) {
    const strategy = typeof rate.strategy === "string" ? rate.strategy : "";
    const detections = typeof rate.detections === "number" ? rate.detections : -1;
    const configuredLoops = typeof rate.configured_loops === "number" ? rate.configured_loops : -1;
    assertPossibleDetectionCount(strategy, detections, configuredLoops, recordIndex);
    if (detectionsByStrategy.has(strategy)) {
      throw new Error(
        `final report record ${String(recordIndex)} repeats strategy detection provenance for ${JSON.stringify(strategy)}`
      );
    }
    detectionsByStrategy.set(strategy, detections);
  }
  return detectionsByStrategy;
}

function assertPossibleDetectionCount(
  strategy: string,
  detections: number,
  configuredLoops: number,
  recordIndex: number
): void {
  if (detections <= configuredLoops) return;
  throw new Error(
    `final report record ${String(recordIndex)} strategy ${JSON.stringify(strategy)} reports ${String(detections)} detections from only ${String(configuredLoops)} configured executions`
  );
}

function assertStrategyAttempts(
  value: unknown,
  detectionsByStrategy: ReadonlyMap<string, number>,
  recordIndex: number
): void {
  if (!Array.isArray(value)) return;
  const identities = new Set<string>();
  const attemptsByStrategy = new Map<string, number>();
  for (const attempt of (value as unknown[]).filter(isRecord)) {
    const strategy = addStrategyAttempt(attempt, identities, recordIndex);
    attemptsByStrategy.set(strategy, (attemptsByStrategy.get(strategy) ?? 0) + 1);
  }
  const detections = [...detectionsByStrategy.values()].reduce((total, count) => total + count, 0);
  if (identities.size !== detections) {
    throw new Error(
      `final report record ${String(recordIndex)} has ${String(identities.size)} distinct contributing executions, which does not match ${String(detections)} detections`
    );
  }
  for (const [strategy, strategyDetections] of detectionsByStrategy) {
    const strategyAttempts = attemptsByStrategy.get(strategy) ?? 0;
    if (strategyAttempts !== strategyDetections) {
      throw new Error(
        `final report record ${String(recordIndex)} strategy ${JSON.stringify(strategy)} has ${String(strategyAttempts)} distinct contributing executions, which does not match ${String(strategyDetections)} detections`
      );
    }
  }
}

function addStrategyAttempt(attempt: JsonRecord, identities: Set<string>, recordIndex: number): string {
  const strategy = typeof attempt.strategy === "string" ? attempt.strategy : "";
  const identity = strategyAttemptIdentity(attempt, strategy);
  if (identities.has(identity)) {
    throw new Error(
      `final report record ${String(recordIndex)} repeats contributing execution provenance for strategy ${JSON.stringify(strategy)}`
    );
  }
  identities.add(identity);
  return strategy;
}

function strategyAttemptIdentity(attempt: JsonRecord, strategy: string): string {
  return JSON.stringify([
    strategy,
    attempt.attempt_index ?? null,
    attempt.model_id ?? null,
    attempt.model ?? null,
    attempt.model_index ?? null,
    attempt.loop_index ?? null
  ]);
}

function requiredAssessment(
  issue: JsonRecord,
  field: "impact" | "likelihood"
): { label: ReportSeverity; rationale: string } {
  const label = exactSeverity(issue[field]);
  if (label === undefined) {
    throw new Error(`production issue is missing a High, Medium, or Low ${field}`);
  }
  const rationale = issue[`${field}_rationale`];
  if (typeof rationale !== "string" || rationale.length === 0) {
    throw new Error(`production issue is missing its canonical ${field}_rationale`);
  }
  return { label, rationale };
}

function matrixSeverity(impact: ReportSeverity, likelihood: ReportSeverity): ReportSeverity {
  if (impact === "High") {
    return likelihood === "Low" ? "Medium" : "High";
  }
  if (impact === "Medium") {
    return likelihood === "Low" ? "Low" : "Medium";
  }
  return "Low";
}

function requiredAssessmentIfPresent(issue: JsonRecord, field: "impact" | "likelihood"): ReportSeverity | undefined {
  return exactSeverity(issue[field]);
}

function proofOfConcept(issue: JsonRecord): RenderableProof | undefined {
  const proof = issue.proof_of_concept;
  if (
    !isRecord(proof) ||
    !Array.isArray(proof.scenario) ||
    !proof.scenario.every((step): step is string => typeof step === "string" && step.length > 0) ||
    proof.scenario.length === 0 ||
    typeof proof.code !== "string" ||
    proof.code.length === 0 ||
    typeof proof.language !== "string" ||
    proof.language.length === 0
  ) {
    return undefined;
  }
  return {
    steps: [...proof.scenario],
    code: proof.code,
    language: proof.language
  };
}

function markdownOutsideFencedCode(markdown: string): string {
  const prose: string[] = [];
  let openFence: { marker: "`" | "~"; length: number } | undefined;
  for (const line of markdown.split("\n")) {
    if (openFence === undefined) {
      const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
      if (opening === null) {
        prose.push(line);
        continue;
      }
      const delimiter = opening[1]!;
      const marker = delimiter[0] as "`" | "~";
      if (marker === "`" && opening[2]!.includes("`")) {
        prose.push(line);
        continue;
      }
      openFence = { marker, length: delimiter.length };
      continue;
    }
    const closing = /^ {0,3}(`+|~+)[ \t]*$/u.exec(line)?.[1];
    if (closing?.[0] === openFence.marker && closing.length >= openFence.length) {
      openFence = undefined;
      continue;
    }
  }
  return prose.join("\n");
}

function renderCanonicalReport(report: JsonRecord, goalSearchCoverage: unknown): string {
  const completion = report.completion === undefined ? undefined : reportCompletionSchema.parse(report.completion);
  const observed = reportObservedCompletionSchema.optional().parse(report.observed_completion);
  const verification = reportVerificationSchema.optional().parse(report.verification);
  const unreviewed = reportUnreviewedFindingsSchema.optional().parse(report.unreviewed_findings);
  if (completion !== undefined && completion.run_id !== recordField(report, "run_metadata")?.run_id) {
    throw new Error("completion run ID does not match the report");
  }
  const issues = renderedIssues(Array.isArray(report.issues) ? report.issues.filter(isRecord) : []);
  const outcomes = Array.isArray(report.non_production_outcomes) ? report.non_production_outcomes.filter(isRecord) : [];
  const lines = reportOpening(completion, observed).trimEnd().split("\n").concat("");

  if (issues.length > 0) {
    lines.push("| Issue id | Title |", "| --- | --- |");
    for (const issue of issues) {
      const heading = renderedIssueLabel(issue);
      const linkLabel = renderedIssueLabel(issue);
      lines.push(`| ${issue.id} | [${escapeTable(linkLabel)}](#${markdownAnchor(heading)}) |`);
    }
    lines.push("", issueCountSentence(issues), "");
  }

  lines.push(
    "Ultrafuzz is an automated smart-contract fuzzing campaign assistant. Issues below are machine-generated findings that must be manually validated. This report is not a security review and does not guarantee the protocol is secure.",
    "",
    "## Run summary",
    ""
  );
  appendRunSummary(lines, isRecord(report.run_metadata) ? report.run_metadata : {});
  appendArtifactValidationWarnings(
    lines,
    isRecord(report.run_metadata) ? report.run_metadata.artifact_validation_warnings : undefined
  );
  appendAuditContext(lines, report.audit_context);
  const campaignDidNotRun = appendCampaignOutcome(lines, report.campaign_outcome);
  appendCoverageEvidence(lines, report.coverage_evidence);
  const goalCoverage = summarizeGoalSearchCoverage(goalSearchCoverage);
  if (issues.length > 0) appendRunCompletion(lines, completion, observed, verification);

  for (const issue of issues) {
    appendProductionIssue(lines, issue);
  }

  if (issues.length === 0 && observed !== undefined) {
    lines.push("", UNCHECKED_EMPTY_FINDINGS_NOTICE);
  } else if (issues.length === 0 && completion?.outcome === "partial") {
    lines.push("", PARTIAL_EMPTY_FINDINGS_NOTICE);
  } else if (issues.length === 0 && outcomes.length === 0) {
    // Saying "no issues" after a campaign that never fuzzed, or after a goal
    // hunt where most lanes never searched, would report an absence of
    // measurement as a clean result.
    lines.push("", noIssuesSentence(campaignDidNotRun, goalCoverage));
  }
  if (issues.length === 0) appendRunCompletion(lines, completion, observed, verification);
  appendUnreviewedFindings(lines, unreviewed);

  appendPropertyImplementationCoverage(lines, report.property_implementation_coverage, observed !== undefined);
  appendGoalSearchCoverage(lines, goalCoverage);
  appendPropertyProvenance(lines, report.property_provenance, issues, outcomes);
  appendPriorFindingDisposition(lines, issues, outcomes);
  appendNonProductionOutcomes(lines, outcomes);
  return `${trimTrailingBlankLines(lines).join("\n")}\n`;
}

function reportOpening(
  completion: ReportCompletion | undefined,
  observed: ReportObservedCompletion | undefined
): string {
  if (observed !== undefined) return `# Ultrafuzz report — PARTIAL\n\n${UNCHECKED_PARTIAL_REPORT_WARNING}\n\n`;
  return completion?.outcome === "partial"
    ? `# Ultrafuzz report — PARTIAL\n\n${PARTIAL_REPORT_WARNING}\n\n`
    : "# Ultrafuzz report\n\n";
}

function appendRunCompletion(
  lines: string[],
  completion: ReportCompletion | undefined,
  observed: ReportObservedCompletion | undefined,
  verification: ReportVerification | undefined
): void {
  if (observed !== undefined && verification !== undefined) {
    lines.push(
      "",
      "## Run completion",
      "",
      "- Outcome: `partial`",
      "- Verification: `not-checked`",
      ...verification.reason_codes.map((reason) => `- ${REPORT_VERIFICATION_REASON_TEXT[reason]}`)
    );
    for (const [key, label] of [
      ["planned", "Planned"],
      ["succeeded", "Succeeded"],
      ["failed", "Failed"],
      ["timed_out", "Timed-out"],
      ["skipped", "Skipped"],
      ["cancelled", "Cancelled"],
      ["unverified", "Unverified"]
    ] as const) {
      lines.push(`- ${label} nodes: \`${observed.counts[key] === null ? "unknown" : String(observed.counts[key])}\``);
    }
    lines.push(
      "",
      "These counts are observations from available saved records. They have not been verified and may be incomplete or inconsistent. Unknown counts are not zero. This report does not establish full audit coverage or a clean security result."
    );
    if (observed.incomplete_nodes !== undefined && observed.incomplete_nodes.length > 0) {
      lines.push("", "Observed incomplete nodes:", "", "| Node | Outcome |", "| --- | --- |");
      for (const node of observed.incomplete_nodes) {
        lines.push(`| \`${inlineValue(node.node_id)}\` | \`${inlineValue(node.outcome)}\` |`);
      }
    }
    if (observed.incomplete_nodes !== undefined || observed.incomplete_nodes_omitted !== undefined) {
      lines.push(
        "",
        `- Additional observed incomplete node identities omitted: \`${observed.incomplete_nodes_omitted == null ? "unknown" : String(observed.incomplete_nodes_omitted)}\``
      );
    }
    return;
  }
  if (completion === undefined) return;
  const counts = completion.counts;
  lines.push(
    "",
    "## Run completion",
    "",
    `- Outcome: \`${completion.outcome}\``,
    `- Planned nodes: \`${String(counts.planned)}\``,
    `- Succeeded nodes: \`${String(counts.succeeded)}\``,
    `- Failed nodes: \`${String(counts.failed)}\``,
    `- Timed-out nodes: \`${String(counts.timed_out)}\``,
    `- Skipped nodes: \`${String(counts.skipped)}\``,
    `- Cancelled nodes: \`${String(counts.cancelled)}\``,
    `- Unverified nodes: \`${String(counts.unverified)}\``,
    "",
    "These counts describe recorded node outcomes. They do not establish full audit coverage or a clean security result. Incomplete nodes have no verified successful result; their absence from the findings is a coverage gap."
  );
  if (completion.incomplete_nodes.length > 0) {
    lines.push("", "Incomplete nodes:", "", "| Node | Outcome | Failure category |", "| --- | --- | --- |");
    for (const node of completion.incomplete_nodes) {
      lines.push(
        `| \`${inlineValue(node.node_id)}\` | \`${inlineValue(node.outcome)}\` | \`${inlineValue(node.failure_category)}\` |`
      );
    }
  }
  lines.push(
    "",
    `- Additional incomplete node identities omitted from this bounded census: \`${String(completion.incomplete_nodes_omitted)}\``
  );
}

function appendUnreviewedFindings(lines: string[], findings: ReportUnreviewedFinding[] | undefined): void {
  if (findings === undefined || findings.length === 0) return;
  lines.push(
    "",
    "## Unreviewed findings",
    "",
    "These entries were read from available result files. They are unreviewed and unverified candidates, not final findings. Their source labels are observations, not verified provenance."
  );
  const prose = (value: string): string => publicProse(value).replaceAll("[", "\\[").replaceAll("]", "\\]");
  for (const [index, finding] of findings.entries()) {
    lines.push(
      "",
      `### Candidate ${String(index + 1)}: ${prose(finding.title)}`,
      "",
      `- Source: ${prose(finding.source_path)}`,
      "",
      `Description: ${prose(finding.description)}`
    );
  }
}

/** Host diagnostics can accompany an immutable report without rewriting its JSON/Markdown pair. */
export function renderArtifactValidationWarningsMarkdown(warnings: readonly ArtifactValidationWarning[]): string {
  const lines: string[] = [];
  appendArtifactValidationWarnings(lines, warnings);
  return lines.length === 0 ? "" : `${lines.join("\n").trim()}\n`;
}

/** A separately named public companion uses the same privacy boundary as the report. */
export function projectPublicArtifactValidationWarnings(warnings: readonly ArtifactValidationWarning[]): {
  warnings: ArtifactValidationWarning[];
  markdown: string;
} {
  const publicWarnings = artifactValidationWarningsSchema.parse(
    redactSecretsInStringValues(redactPrivatePathsInValue(warnings))
  );
  return { warnings: publicWarnings, markdown: renderArtifactValidationWarningsMarkdown(publicWarnings) };
}

function appendArtifactValidationWarnings(lines: string[], value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) return;
  lines.push(
    "",
    "## Artifact validation warnings",
    "",
    "The run continued with partial metadata. Producer artifacts were preserved unchanged.",
    ""
  );
  for (const warning of value.filter(isRecord)) {
    lines.push(
      `- ${inlineValue(warning.code)} — \`${inlineValue(warning.artifact_path)}#${inlineValue(warning.field_path)}\`: ${publicProse(String(warning.message))}`
    );
    if (warning.source_path !== undefined) lines.push(`  - Available context: \`${inlineValue(warning.source_path)}\``);
  }
}

function appendCoverageEvidence(lines: string[], value: unknown): void {
  if (!isRecord(value) || (value.status !== "measured" && value.status !== "unavailable")) return;
  lines.push("", ...renderCoverageEvidenceMarkdownSection(value));
}

export function renderCoverageEvidenceMarkdownSection(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const lines = ["## Scoped coverage evidence", ""];
  if (value.status === "unavailable" && Array.isArray(value.blockers)) {
    lines.push("- Status: unavailable", "", "Blockers:");
    for (const blocker of value.blockers.filter(isRecord)) {
      lines.push(
        `- ${inlineValue(blocker.category)}: ${isAvailable(blocker.summary) ? publicProse(String(blocker.summary)) : "unavailable"}`
      );
      const evidencePaths = Array.isArray(blocker.evidence_paths) ? blocker.evidence_paths : [];
      for (const evidencePath of evidencePaths) lines.push(`  - Evidence: \`${inlineValue(evidencePath)}\``);
    }
    return lines;
  }
  if (value.status !== "measured" || !Array.isArray(value.views)) return [];
  for (const view of value.views.filter(isRecord)) {
    lines.push(
      `- ${inlineValue(view.scope)}: \`${inlineValue(view.covered_ranges)}/${inlineValue(view.total_ranges)}\``
    );
  }
  const excluded = Array.isArray(value.files)
    ? value.files.filter((entry): entry is JsonRecord => isRecord(entry) && entry.included === false)
    : [];
  lines.push("", "Excluded from Recon-selected scope:");
  if (excluded.length === 0) lines.push("- None");
  else {
    for (const entry of excluded) {
      lines.push(
        `- \`${inlineValue(entry.path)}\` (${inlineValue(entry.kind)}): ${isAvailable(entry.exclusion_reason) ? publicProse(String(entry.exclusion_reason)) : "unavailable"}`
      );
    }
  }
  const zero = Array.isArray(value.zero_coverage_components) ? value.zero_coverage_components.filter(isRecord) : [];
  lines.push("", "Zero-coverage components:");
  if (zero.length === 0) lines.push("- None");
  else {
    for (const entry of zero) {
      const startLine = entry.start_line;
      const endLine =
        typeof entry.start_line === "number" && typeof entry.line_count === "number"
          ? entry.start_line + entry.line_count - 1
          : "?";
      lines.push(
        `- \`${inlineValue(entry.path)}:${inlineValue(startLine)}-${inlineValue(endLine)}\` (${inlineValue(entry.kind)})`
      );
    }
  }
  return lines;
}

function renderedIssues(issues: JsonRecord[]): RenderedIssue[] {
  return issues.map((issue) => ({
    issue,
    severity: requiredSeverity(issue),
    id: typeof issue.id === "string" ? issue.id : "",
    title: cleanIssueTitle(recordTitle(issue, ""))
  }));
}

function renderedIssueLabel(issue: RenderedIssue): string {
  return `[${publicProse(issue.id)}] - ${publicProse(issue.title)}`;
}

function renderedIssueHeading(issue: RenderedIssue): string {
  return `## ${renderedIssueLabel(issue)}`;
}

/** Outcomes that mean the campaign fuzzed to completion. */
const COMPLETED_CAMPAIGN_OUTCOMES = new Set(["completed", "complete", "succeeded", "success", "finished"]);
/**
 * Outcomes that mean no fuzzing happened at all. Kept separate from merely
 * incomplete ones: a `partial` campaign did produce results, and describing it
 * as a non-run would be as wrong as describing a blocked one as clean.
 */
const UNRUN_CAMPAIGN_OUTCOMES = new Set(["blocked", "not-started", "not_started", "skipped", "unavailable"]);

/**
 * Disclose a campaign that did not fuzz to completion. Returns whether the run
 * produced no fuzzing at all, so an empty findings list is an absence of
 * measurement rather than a clean result.
 */
function appendCampaignOutcome(lines: string[], campaignOutcome: unknown): boolean {
  if (!isRecord(campaignOutcome)) return false;
  const outcome = typeof campaignOutcome.outcome === "string" ? campaignOutcome.outcome.trim() : "";
  if (outcome === "" || COMPLETED_CAMPAIGN_OUTCOMES.has(outcome.toLowerCase())) return false;
  const neverRan = UNRUN_CAMPAIGN_OUTCOMES.has(outcome.toLowerCase());
  const reason = typeof campaignOutcome.reason === "string" ? campaignOutcome.reason.trim() : "";
  lines.push(
    "",
    "## Campaign status",
    "",
    neverRan
      ? `The invariant campaign did not run: \`${publicProse(outcome)}\`. No fuzzing result is available, and an empty findings list below does not mean the properties held.`
      : `The invariant campaign did not complete: \`${publicProse(outcome)}\`. Any findings below come from a partial campaign, and absence of a finding does not mean the property held.`
  );
  if (reason !== "") {
    lines.push("", `Reason: ${publicProse(reason)}`);
  }
  return neverRan;
}

function appendRunSummary(lines: string[], metadata: JsonRecord): void {
  for (const [label, key] of reportSummaryFields) {
    let value = metadata[key];
    if (key === "source_run_id" && !isAvailable(value)) {
      value = "none";
    }
    lines.push(`- ${label}: \`${inlineValue(value)}\``);
  }
}

function appendAuditContext(lines: string[], value: unknown): void {
  if (!isRecord(value)) return;
  const threat = recordField(value, "threat_model");
  const goalPlan = recordField(value, "goal_plan");
  const threatMarkdown = safeReportLink(threat?.markdown);
  const threatJson = safeReportLink(threat?.json);
  const goalPlanJson = safeReportLink(goalPlan?.json);
  if (threatMarkdown === undefined && threatJson === undefined && goalPlanJson === undefined) return;
  lines.push("", "## Audit context", "");
  if (threatMarkdown !== undefined || threatJson !== undefined) {
    const links = [
      threatMarkdown === undefined ? undefined : `[THREAT_MODEL.md](${threatMarkdown})`,
      threatJson === undefined ? undefined : `[threat-model.json](${threatJson})`
    ].filter((entry): entry is string => entry !== undefined);
    lines.push(`- Threat model: ${links.join("; ")}`);
  }
  if (goalPlanJson !== undefined) lines.push(`- Goal plan: [goal-plan.json](${goalPlanJson})`);
}

function safeReportLink(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_REPORT_RELATIVE_LINK_PATTERN.test(value) ? value : undefined;
}

function appendProductionIssue(lines: string[], rendered: RenderedIssue): void {
  const { issue } = rendered;
  lines.push("", renderedIssueHeading(rendered), "", publicProse(issueDescription(issue)), "", "### Severity", "");
  const impact = riskAssessment(issue, "impact");
  const likelihood = riskAssessment(issue, "likelihood");
  lines.push(`- **Impact**: ${impact.label}: ${publicProse(impact.rationale)}`);
  lines.push(`- **Likelihood**: ${likelihood.label}: ${publicProse(likelihood.rationale)}`);
  const sourceNodes = findingSourceNodes(issue);
  if (sourceNodes.length > 0) {
    lines.push(`- **Source nodes**: ${sourceNodes.map((source) => `\`${publicInlineCode(source)}\``).join(", ")}`);
  }
  lines.push("", "### Proof of Concept", "");
  appendProofOfConcept(lines, issue);
  appendFamilyVariants(lines, issue.family_variants);
}

function appendProofOfConcept(lines: string[], issue: JsonRecord): void {
  const proof = proofOfConcept(issue);
  if (proof === undefined) {
    throw new Error("production issue proof of concept is missing a human-readable scenario or execution trace");
  }
  for (const [index, step] of proof.steps.entries()) {
    lines.push(`${index + 1}. ${publicProse(step)}`);
  }
  const code = publicCode(proof.code);
  const language = safeFenceLanguage(proof.language);
  const fence = codeFence(code);
  lines.push("", `${fence}${language}`, code, fence);
}

function appendFamilyVariants(lines: string[], value: unknown): void {
  if (!Array.isArray(value)) {
    return;
  }
  const variants = value.filter(isRecord);
  if (variants.length === 0) {
    return;
  }
  lines.push("", "#### Family variants", "");
  for (const variant of variants) {
    const title = firstAvailableString(variant.title) ?? "Variant";
    const summary = firstAvailableString(variant.summary, variant.description);
    lines.push(`- **${publicProse(title)}**${summary === undefined ? "" : `: ${publicProse(summary)}`}`);
  }
}

function appendPropertyProvenance(
  lines: string[],
  value: unknown,
  issues: RenderedIssue[],
  outcomes: JsonRecord[]
): void {
  lines.push("", "## Property provenance", "");
  if (isUnavailable(value)) {
    lines.push("unavailable");
    return;
  }
  const entries = Array.isArray(value) ? value.filter(isRecord) : [];
  if (entries.length === 0) {
    lines.push("No property-derived findings.");
    return;
  }
  lines.push(
    "| Finding | Property IDs | Source nodes | Source property IDs | Implementation/test paths | Fuzzer backends |",
    "| --- | --- | --- | --- | --- | --- |"
  );
  for (const entry of entries) {
    const finding = propertyFindingLabel(entry, issues, outcomes);
    const sources = Array.isArray(entry.sources) ? entry.sources.filter(isRecord) : [];
    const paths = uniqueStrings([
      ...(Array.isArray(entry.implementation_paths) ? entry.implementation_paths : []),
      ...(Array.isArray(entry.test_paths) ? entry.test_paths : [])
    ]);
    const backends = uniqueStrings([
      ...(Array.isArray(entry.fuzzer_backends) ? entry.fuzzer_backends : []),
      ...(typeof entry.fuzzer_backend === "string" ? [entry.fuzzer_backend] : [])
    ]);
    lines.push(
      `| ${tableCell(finding)} | ${tableList(entry.property_ids)} | ${tableList(sources.map((source) => source.source_node_id))} | ${tableList(sources.map((source) => source.source_property_id))} | ${tableList(paths)} | ${tableList(backends)} |`
    );
  }
}

function appendPropertyImplementationCoverage(lines: string[], value: unknown, unchecked: boolean): void {
  lines.push("", "## Property implementation coverage", "");
  if (!isRecord(value)) {
    throw new Error("Validated final report is missing typed property implementation coverage");
  }
  if (value.status === "not-planned") {
    lines.push("- Status: `not-planned`");
    lines.push("- Reason: `property-implementation-track-not-declared`");
    return;
  }
  if (value.status === "unavailable") {
    lines.push(
      "- Status: `unavailable`",
      "- Reason: `final-review-not-completed`",
      "",
      unchecked ? UNCHECKED_FINAL_REVIEW_NOTICE : UNAVAILABLE_FINAL_REVIEW_NOTICE
    );
    return;
  }
  const priorities = Array.isArray(value.priorities) ? value.priorities : [];
  const selected = Array.isArray(value.selected_property_ids) ? value.selected_property_ids : [];
  const implemented = Array.isArray(value.implemented_property_ids) ? value.implemented_property_ids : [];
  const blocked = Array.isArray(value.blocked_property_ids) ? value.blocked_property_ids : [];
  const pending = Array.isArray(value.pending_property_ids) ? value.pending_property_ids : [];
  const deferred = Array.isArray(value.deferred_property_ids) ? value.deferred_property_ids : [];
  lines.push(`- Priority threshold: \`${inlineValue(value.priority_threshold)}\``);
  lines.push(`- Included priorities: \`${tableList(priorities)}\``);
  lines.push(`- Selected properties: \`${selected.length}\``);
  lines.push(`- Implemented properties: \`${implemented.length}\``);
  lines.push(`- Blocked properties: \`${blocked.length}\``);
  lines.push(`- Pending properties: \`${pending.length}\``);
  lines.push(`- Deferred properties: \`${deferred.length}\``);
  const referenceExpected = Array.isArray(value.reference_expected_property_ids)
    ? value.reference_expected_property_ids
    : [];
  lines.push(`- Reference expectation properties: \`${referenceExpected.length}\``);
  const blockerSummaries = Array.isArray(value.blocker_summaries)
    ? value.blocker_summaries.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (blockerSummaries.length > 0) {
    lines.push("", "Blocker summaries:");
    for (const summary of blockerSummaries) {
      lines.push(`- ${publicProse(summary)}`);
    }
  }
}

/**
 * The topology logical node that runs the untargeted roaming goal pass.
 *
 * `goal-roaming` sits in the same `group: goals` as the targeted `class-goals` and `threat-goals`
 * lanes, so the runtime census tallies it in the same lane list and `logical_node_id` is the only
 * field that separates them. Rendering it inside the targeted denominator would let one untargeted
 * sweep stand in for a targeted goal that never ran, which is the exact substitution this section
 * exists to prevent, so it is tallied and rendered on its own line (issue #677).
 */
const ROAMING_GOAL_LOGICAL_NODE_ID = "goal-roaming";

interface GoalLaneTally {
  lanes: number;
  completed: number;
  withFindings: number;
  noFindings: number;
  unknownFindingCount: number;
  stoppedEarly: number;
  unverified: number;
  unrecognized: number;
}

interface GoalSearchCoverageSummary {
  targeted: GoalLaneTally;
  roaming: GoalLaneTally;
  /** Set when the census `totals.planned` disagrees with the lane list shipped alongside it. */
  inconsistentTotals: boolean;
}

function emptyGoalLaneTally(): GoalLaneTally {
  return {
    lanes: 0,
    completed: 0,
    withFindings: 0,
    noFindings: 0,
    unknownFindingCount: 0,
    stoppedEarly: 0,
    unverified: 0,
    unrecognized: 0
  };
}

/**
 * Tally the runtime-owned goal-search census, or answer `undefined` for "coverage is unknown".
 *
 * Recomputed from the per-lane `goals` list rather than trusted from `totals`, because the lane list
 * is the only place the targeted/roaming split exists, and because a summary that disagrees with its
 * own detail is exactly the kind of quiet arithmetic error a coverage claim must not inherit. A
 * disagreement is recorded and disclosed rather than resolved silently.
 *
 * Every rejection path returns `undefined` so the render states that coverage is unknown: a missing
 * field, the `"unavailable"` sentinel the producers stamp when no census was written, a census under
 * an unrecognized schema version, and a census with no lanes at all. That last case is not
 * hypothetical -- the recorder writes nothing when a run expanded zero goal lanes, which is precisely
 * what a dead goal plan leaves behind, and reporting zero planned lanes as full coverage would invert
 * the worst case into the best one.
 */
function summarizeGoalSearchCoverage(value: unknown): GoalSearchCoverageSummary | undefined {
  if (!isRecord(value) || value.schema_version !== GOAL_SEARCH_COVERAGE_SCHEMA_VERSION) {
    return undefined;
  }
  const goals = Array.isArray(value.goals) ? value.goals.filter(isRecord) : [];
  if (goals.length === 0) {
    return undefined;
  }
  const targeted = emptyGoalLaneTally();
  const roaming = emptyGoalLaneTally();
  for (const goal of goals) {
    const tally = goal.logical_node_id === ROAMING_GOAL_LOGICAL_NODE_ID ? roaming : targeted;
    tally.lanes += 1;
    const status = typeof goal.status === "string" ? goal.status : "";
    if (status.startsWith("completed")) {
      tally.completed += 1;
      if (status === "completed-with-findings") {
        tally.withFindings += 1;
      } else if (status === "completed-no-findings") {
        tally.noFindings += 1;
      } else {
        tally.unknownFindingCount += 1;
      }
    } else if (status === "stopped-early") {
      tally.stoppedEarly += 1;
    } else if (status === "unverified") {
      tally.unverified += 1;
    } else {
      // An unrecognized status is counted as a lane but never as a completion, so a status this
      // renderer has not been taught can only ever lower the reported coverage.
      tally.unrecognized += 1;
    }
  }
  const planned = recordField(value, "totals")?.planned;
  return {
    targeted,
    roaming,
    inconsistentTotals: typeof planned === "number" && planned !== goals.length
  };
}

/**
 * Report how much of the goal hunt actually ran (issue #677).
 *
 * Goal lanes carry `continueOnFail` and are pre-seeded with a contract-valid empty findings array, so
 * a lane that was killed before it searched leaves behind bytes indistinguishable from a lane that
 * searched and found nothing. The census is the only surviving difference between those two, and this
 * section is where a reader of `report.md` alone -- the document the prompt designs to be forwarded on
 * its own -- gets told which one happened. Modelled on `appendPropertyImplementationCoverage`: same
 * heading style, same counted bullets, same explicit handling of an absent or sentinel census.
 *
 * Two limits of the census are stated in the rendered text rather than smoothed over:
 *
 *   1. The denominator is lanes that were expanded and run, not goals the plan asked for. A goal that
 *      never became a lane cannot appear as unsearched here, and a run that expanded no lanes at all
 *      has no census and therefore reports unknown coverage.
 *   2. The untargeted roaming pass shares the goal group with the targeted lanes, so it is split out
 *      by `logical_node_id` and reported on its own line instead of diluting the targeted ratio.
 */
function appendGoalSearchCoverage(lines: string[], summary: GoalSearchCoverageSummary | undefined): void {
  lines.push("", "## Goal search coverage", "");
  if (summary === undefined) {
    lines.push(
      "**Goal search coverage is unknown.** This run published no authoritative goal-search census, so this report cannot state how many of its goal searches ran: either the run performed no goal searches at all, or it performed them without recording coverage. Unknown coverage is not full coverage. Treat any goal-derived result in this report as an unquantified sample, and do not read a goal that reported nothing as a goal that was searched."
    );
    return;
  }
  const { targeted, roaming } = summary;
  const missing = targeted.lanes - targeted.completed;
  if (targeted.lanes === 0) {
    lines.push(
      "**No targeted goal search coverage: this run recorded no targeted goal search lanes.** Nothing in this report is a statement about targeted goal coverage."
    );
  } else if (missing > 0) {
    // "of the ${lanes}" rather than "of ${lanes}": these are lane counts, not code-coverage scores,
    // but "coverage ... N of M" on one rendered line parses as an unscoped coverage fraction under
    // the published-coverage gates, and the runtime verifier requires exactly these bytes, so the
    // gate would reject every partial-census report the projector produced (issue #702).
    lines.push(
      `**Partial goal search coverage: only ${targeted.completed} of the ${targeted.lanes} targeted goal searches completed.** The other ${missing} published no verified result, so nothing was measured for those goals: their empty findings are an absence of evidence, not evidence of absence. This report does not cover them.`
    );
  } else {
    lines.push(
      `All ${targeted.lanes} targeted goal searches completed and published a verified result, so a goal that reported no findings here was searched and found nothing.`
    );
  }
  lines.push("");
  lines.push(`- Targeted goal search lanes: \`${targeted.lanes}\``);
  lines.push(`- Completed with a verified result: \`${targeted.completed}\``);
  lines.push(`- Completed and reported findings: \`${targeted.withFindings}\``);
  lines.push(`- Completed and reported no findings: \`${targeted.noFindings}\``);
  if (targeted.unknownFindingCount > 0) {
    lines.push(`- Completed with an unreadable finding count: \`${targeted.unknownFindingCount}\``);
  }
  lines.push(`- Stopped early without returning: \`${targeted.stoppedEarly}\``);
  lines.push(`- Returned without passing verification: \`${targeted.unverified}\``);
  if (targeted.unrecognized > 0) {
    lines.push(`- Recorded with an unrecognized status: \`${targeted.unrecognized}\``);
  }
  if (roaming.lanes > 0) {
    lines.push(
      `- Untargeted roaming passes, counted separately: \`${roaming.completed}\` of \`${roaming.lanes}\` completed`
    );
  }
  lines.push(
    "",
    "These counts cover goal search lanes this run expanded and executed, not goals the plan requested: a planned goal that never became a lane is absent from them entirely, and a run whose goal planning or expansion produced no lanes publishes no census and reports its coverage as unknown rather than as zero."
  );
  if (roaming.lanes > 0) {
    lines.push(
      "",
      "The untargeted roaming pass shares its execution group with the targeted goal lanes but is counted on its own line here, so it can neither raise nor lower targeted coverage."
    );
  }
  if (summary.inconsistentTotals) {
    lines.push(
      "",
      "The census summary disagrees with the per-lane record it ships with. The counts above come from the per-lane record; treat the totals as unreliable and this coverage statement as approximate."
    );
  }
}

/**
 * State an empty issue list without letting it stand in for coverage.
 *
 * Two different absences of measurement can leave the issue list empty: an invariant campaign that
 * never fuzzed, and a goal hunt whose lanes were killed before they searched. Either one makes "no
 * issues reported" a false summary, so both are named here, and the goal case points at the section
 * that carries the numbers. Unknown goal coverage deliberately does NOT amend this sentence: a
 * topology with no goal lanes at all reports unknown coverage as a matter of course, and turning
 * every such run's clean result into a warning would spend the warning where it means nothing. That
 * run still gets an explicit "coverage is unknown" statement in its own section.
 */
function noIssuesSentence(campaignDidNotRun: boolean, coverage: GoalSearchCoverageSummary | undefined): string {
  const targeted = coverage?.targeted;
  const goalClause =
    targeted === undefined || (targeted.lanes > 0 && targeted.completed >= targeted.lanes)
      ? undefined
      : targeted.lanes === 0
        ? "no targeted goal search lane ran"
        : `only ${targeted.completed} of ${targeted.lanes} targeted goal searches completed`;
  const clauses = [campaignDidNotRun ? "the invariant campaign did not run" : undefined, goalClause].filter(
    (clause): clause is string => clause !== undefined
  );
  if (clauses.length === 0) {
    return "No issues reported.";
  }
  const sentence = `No issues were reported, but ${clauses.join(" and ")}, so this is not a result.`;
  return goalClause === undefined
    ? sentence
    : `${sentence} See [Goal search coverage](#${markdownAnchor("Goal search coverage")}).`;
}

function appendPriorFindingDisposition(lines: string[], issues: RenderedIssue[], outcomes: JsonRecord[]): void {
  const groups = new Map<string, string[]>();
  for (const issue of issues) {
    addPriorDisposition(
      groups,
      recordField(issue.issue, "lifecycle")?.comparison_disposition,
      `[${issue.id}] - ${issue.title}`
    );
  }
  for (const outcome of outcomes) {
    addPriorDisposition(
      groups,
      recordField(outcome, "lifecycle")?.comparison_disposition,
      recordTitle(outcome, "Untitled outcome")
    );
  }
  if (groups.size === 0) {
    return;
  }
  lines.push("", "## Prior finding disposition");
  for (const label of ["Promoted again", "Rediscovered but demoted", "Not reproduced", "Not searched"]) {
    const entries = groups.get(label);
    if (entries === undefined) {
      continue;
    }
    lines.push("", `### ${label}`, "");
    for (const entry of entries) {
      lines.push(`- ${publicProse(entry)}`);
    }
  }
}

function appendNonProductionOutcomes(lines: string[], outcomes: JsonRecord[]): void {
  if (outcomes.length === 0) {
    return;
  }
  lines.push(
    "",
    "## Non-production actionable outcomes",
    "",
    "| Classification | Title | Status | Evidence | Recommended next action |",
    "| --- | --- | --- | --- | --- |"
  );
  for (const outcome of outcomes) {
    lines.push(
      `| ${tableCell(outcome.triage_classification)} | ${tableCell(recordTitle(outcome, "Untitled outcome"))} | ${tableCell(outcome.status)} | ${tableCell(evidenceSummary(outcome.evidence, outcome.summary))} | ${tableCell(outcome.recommended_next_action)} |`
    );
  }
}

function issueCountSentence(issues: RenderedIssue[]): string {
  const counts: Record<ReportSeverity, number> = { High: 0, Medium: 0, Low: 0 };
  for (const issue of issues) {
    counts[issue.severity] += 1;
  }
  return `The report contains ${issues.length} issues, with severity distribution ${counts.High} high, ${counts.Medium} medium, and ${counts.Low} low.`;
}

function requiredSeverity(issue: JsonRecord): ReportSeverity {
  const severity = exactSeverity(issue.severity);
  if (severity === undefined) {
    throw new Error("production issue is missing a High, Medium, or Low report severity");
  }
  return severity;
}

function cleanIssueTitle(value: string): string {
  return value
    .replace(/^\s*\[[HML]-\d{2,}\]\s*-\s*/iu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function riskAssessment(
  issue: JsonRecord,
  field: "impact" | "likelihood"
): { label: ReportSeverity; rationale: string } {
  return requiredAssessment(issue, field);
}

function exactSeverity(value: unknown): ReportSeverity | undefined {
  return value === "High" || value === "Medium" || value === "Low" ? value : undefined;
}

function issueDescription(issue: JsonRecord): string {
  return firstAvailableString(issue.description, issue.summary) ?? "No public issue description was recorded.";
}

function markdownAnchor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/gu, "-");
}

function propertyFindingLabel(entry: JsonRecord, issues: RenderedIssue[], outcomes: JsonRecord[]): string {
  const findingId = firstAvailableString(entry.finding_id);
  const issue = issues.find(({ issue: candidate }) => candidate.id === findingId);
  if (issue !== undefined) {
    return `[${issue.id}] - ${issue.title}`;
  }
  const outcome = outcomes.find((candidate) => candidate.id === findingId);
  return outcome === undefined
    ? (firstAvailableString(entry.title, findingId) ?? "unavailable")
    : recordTitle(outcome, findingId ?? "Untitled outcome");
}

function addPriorDisposition(groups: Map<string, string[]>, value: unknown, title: string): void {
  const normalized = typeof value === "string" ? value.trim().toLowerCase().replace(/[ _]+/gu, "-") : "";
  const label =
    normalized === "promoted-again"
      ? "Promoted again"
      : normalized === "rediscovered-but-demoted"
        ? "Rediscovered but demoted"
        : normalized === "not-reproduced"
          ? "Not reproduced"
          : normalized === "not-searched"
            ? "Not searched"
            : undefined;
  if (label !== undefined) {
    groups.set(label, [...(groups.get(label) ?? []), title]);
  }
}

function evidenceSummary(value: unknown, fallback: unknown): string {
  const entries = Array.isArray(value) ? value : [value];
  const labels = entries.flatMap((entry) => {
    if (typeof entry === "string" && isAvailable(entry)) {
      return [publicEvidenceText(entry)];
    }
    if (isRecord(entry)) {
      const label = firstAvailableString(entry.summary, entry.description, entry.kind);
      return label === undefined ? [] : [label];
    }
    return [];
  });
  return labels.slice(0, 2).join("; ") || firstAvailableString(fallback) || "Evidence retained in structured report.";
}

function publicEvidenceText(value: string): string {
  const text = value.trim();
  return text;
}

function inlineValue(value: unknown): string {
  if (!isAvailable(value)) {
    return "unavailable";
  }
  if (Array.isArray(value)) {
    const values = value.filter(isAvailable).map((entry) => publicInlineCode(String(entry)));
    return values.length > 0 ? values.join(", ") : "unavailable";
  }
  return publicInlineCode(String(value));
}

function tableList(value: unknown): string {
  const values = Array.isArray(value) ? value.filter(isAvailable).map(String) : [];
  return values.length > 0 ? values.map((entry) => escapeTable(publicProse(entry))).join("<br>") : "unavailable";
}

function tableCell(value: unknown): string {
  return isAvailable(value) ? escapeTable(publicProse(String(value))) : "unavailable";
}

function isAvailable(value: unknown): boolean {
  return (
    value !== undefined &&
    value !== null &&
    !isUnavailable(value) &&
    (!(typeof value === "string") || value.trim() !== "")
  );
}

function firstAvailableString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && isAvailable(value))?.trim();
}

function safeFenceLanguage(value: string): string {
  return /^[A-Za-z0-9_+-]+$/u.test(value) ? value : "text";
}

function codeFence(code: string): string {
  const longest = [...code.matchAll(/`+/gu)].reduce((maximum, match) => Math.max(maximum, match[0].length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

function recordTitle(record: JsonRecord, fallback: string): string {
  return typeof record.title === "string" && record.title.trim().length > 0 ? record.title.trim() : fallback;
}

function publicProse(value: string): string {
  return value
    .replace(/\s+/gu, " ")
    .trim()
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("*", "\\*")
    .replaceAll("_", "\\_")
    .replaceAll("!", "\\!")
    .replaceAll("#", "\\#")
    .replaceAll("~", "\\~")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function publicCode(value: string): string {
  return value;
}

function publicInlineCode(value: string): string {
  return value.replace(/\s+/gu, " ").trim().replaceAll("`", "'");
}

function redactSecrets(value: string, mode: SecretScanMode = "all"): string {
  return redactSecretsInText(value, PUBLIC_SECRET_REDACTION_PLACEHOLDER, [], mode);
}

/**
 * `run_metadata.run_id`, `run_metadata.source_run_id`, and `completion.run_id` are machine-generated safe IDs
 * (`validateSafeId`, so `[A-Za-z0-9._-]`) that the public bundle already publishes in its run
 * records and then requires report.json to repeat. The speculative high-entropy pass redacts the
 * bounded eval run IDs (`ci-<run>-1-smoke-...-<16 hex>`), which breaks that lineage check, so these
 * fields scan positive-only: a vendor-format credential or URL credential in the slot is still
 * redacted (and the bundle then fails closed on lineage), while a high-entropy safe ID is kept.
 */
function secretScanModeForPath(keyPath: readonly string[]): SecretScanMode {
  const isRetainedIdentifier =
    keyPath.length === 2 &&
    ((keyPath[0] === "run_metadata" && (keyPath[1] === "run_id" || keyPath[1] === "source_run_id")) ||
      (keyPath[0] === "completion" && keyPath[1] === "run_id"));
  return isRetainedIdentifier ? "positive-only" : "all";
}

function containsUnredactedSecret(value: string, mode: SecretScanMode = "all"): boolean {
  // The fail-closed check asks whether another pass with the public placeholder would change the
  // text. The placeholder is a fixed point of that pass, so no folding is needed and a leftover
  // secret is the only thing that can still differ.
  return redactSecrets(value, mode) !== value;
}

function containsUnredactedSecretInValue(value: unknown, keyPath: readonly string[] = []): boolean {
  if (typeof value === "string") return containsUnredactedSecret(value, secretScanModeForPath(keyPath));
  if (Array.isArray(value)) {
    return value.some((entry, index) => containsUnredactedSecretInValue(entry, [...keyPath, String(index)]));
  }
  return (
    isRecord(value) &&
    Object.entries(value).some(([key, entry]) => containsUnredactedSecretInValue(entry, [...keyPath, key]))
  );
}

/**
 * The Markdown re-scan has no key path, so the retained identifiers (which the speculative pass
 * would flag) are substituted with the placeholder before scanning. They were already scanned
 * positive-only in the report walk; a leftover real secret anywhere else still changes under the pass.
 */
function containsUnredactedSecretInMarkdown(markdown: string, report: JsonRecord): boolean {
  const scanned = retainedIdentifierValues(report).reduce(
    (current, identifier) => current.replaceAll(identifier, PUBLIC_SECRET_REDACTION_PLACEHOLDER),
    markdown
  );
  return containsUnredactedSecret(scanned);
}

function retainedIdentifierValues(report: JsonRecord): string[] {
  const metadata = recordField(report, "run_metadata");
  const completion = recordField(report, "completion");
  return [metadata?.run_id, metadata?.source_run_id, completion?.run_id].filter(
    (value): value is string => typeof value === "string" && value !== ""
  );
}

/** Keep all census rows when redaction maps distinct node identities to the same placeholder. */
function preserveDistinctPublicCompletionNodes(internal: JsonRecord, published: JsonRecord): void {
  const internalCompletion = recordField(internal, "completion");
  const publicCompletion = recordField(published, "completion");
  if (!Array.isArray(internalCompletion?.incomplete_nodes) || !Array.isArray(publicCompletion?.incomplete_nodes)) {
    return;
  }
  const originals = internalCompletion.incomplete_nodes as JsonRecord[];
  const nodes = publicCompletion.incomplete_nodes as JsonRecord[];
  const reserved = new Set(nodes.map((node) => String(node.node_id)));
  for (const [index, node] of nodes.entries()) {
    if (node.node_id === originals[index]?.node_id) continue;
    let suffix = index + 1;
    while (reserved.has(`redacted-node-${String(suffix)}`)) suffix += 1;
    const placeholder = `redacted-node-${String(suffix)}`;
    node.node_id = placeholder;
    reserved.add(placeholder);
  }
}

function redactSecretsInStringValues(value: unknown, keyPath: readonly string[] = []): unknown {
  if (typeof value === "string") return redactSecrets(value, secretScanModeForPath(keyPath));
  if (Array.isArray(value)) {
    return collapseRedactionDuplicates(
      value,
      value.map((entry, index) => redactSecretsInStringValues(entry, [...keyPath, String(index)]))
    );
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redactSecretsInStringValues(entry, [...keyPath, key])])
  );
}

function containsPrivatePath(value: string): boolean {
  return privatePathPatterns().some((pattern) => pattern.test(value));
}

function containsPrivatePathInValue(value: unknown): boolean {
  if (typeof value === "string") return containsPrivatePath(value);
  if (Array.isArray(value)) return value.some(containsPrivatePathInValue);
  return isRecord(value) && Object.values(value).some(containsPrivatePathInValue);
}

function redactPrivatePathsInValue(value: unknown): unknown {
  if (typeof value === "string") return redactPrivatePaths(value);
  if (Array.isArray(value)) return collapseRedactionDuplicates(value, value.map(redactPrivatePathsInValue));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactPrivatePathsInValue(entry)]));
}

/**
 * Collapse the duplicates a redaction pass created in an array of strings.
 *
 * Redaction maps every private path to `[redacted-path]` and every flagged string to the secret
 * placeholder, so two distinct entries of one array can come out identical. The report schema
 * declares `affected_files`, `affected_functions`, `patch_refs`, `property_ids`, `fuzzer_backends`,
 * `duplicate_finding_ids`, and `family_variant_keys` as unique arrays, so the public copy would then
 * fail the validation the internal report passed (UltraFuzzBench smoke run 33933691679, issue #1028).
 *
 * Only duplicates the pass itself introduced are collapsed, keeping the first occurrence of each value
 * in place: an array the pass did not change, an array that already repeated a value before the pass,
 * and an array with a non-string entry are returned exactly as mapped. Every unredacted entry survives,
 * and the result is a fixed point of the projection: a second pass changes nothing, so it collapses
 * nothing.
 */
function collapseRedactionDuplicates(original: readonly unknown[], redacted: unknown[]): unknown[] {
  if (!original.every((entry) => typeof entry === "string")) return redacted;
  if (redacted.every((entry, index) => entry === original[index])) return redacted;
  if (new Set(original).size !== original.length) return redacted;
  if (new Set(redacted).size === redacted.length) return redacted;
  return [...new Set(redacted)];
}

function redactPrivatePaths(value: string): string {
  return privatePathPatterns().reduce(
    (current, pattern) => current.replace(pattern, (_match, prefix: string) => `${prefix}[redacted-path]`),
    value
  );
}

function privatePathPatterns(): RegExp[] {
  return [
    /(^|[\s("'`=,:;[])file:(?:\/{1,3}|\\{1,3})[^\s"'`()[\]{}<>]*/gimu,
    /(^|[\s("'`=,:;[])(?<!&lt;)\/(?![/*])[^/\s"'`()[\]{}<>][^\s"'`()[\]{}<>]*/gmu,
    /(^|[\s("'`=,:[])(?:~|\.ultrafuzz|artifacts|workspaces|generated-tests)\/[^\s"'`()[\]{}<>]+/gmu,
    /(^|[\s("'`=,:[])[A-Za-z]:\\[^\s"'`()[\]{}<>]+/gmu,
    /(^|[\s("'`=,:[])\\\\[^\s"'`()[\]{}<>]+/gmu
  ];
}

function recordField(value: unknown, key: string): JsonRecord | undefined {
  return isRecord(value) && isRecord(value[key]) ? value[key] : undefined;
}

function uniqueStrings(value: unknown[]): string[] {
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))];
}

function findingSourceNodes(record: JsonRecord): string[] {
  return uniqueStrings(
    [
      ...(Array.isArray(record.source_nodes) ? record.source_nodes : []),
      ...(typeof record.source_node_id === "string" ? [record.source_node_id] : [])
    ].map((value) => (typeof value === "string" ? value.trim() : value))
  );
}

function isUnavailable(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "unavailable";
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function trimTrailingBlankLines(lines: string[]): string[] {
  while (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}
