import { redactValue, validateArtifactContract } from "@ultrafuzz/artifacts";

export const MAX_FINAL_REPORT_JSON_BYTES = 64 * 1024 * 1024;
export const MAX_FINAL_REPORT_MARKDOWN_BYTES = 16 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

const reportSummaryFields = [
  ["Run ID", "run_id"],
  ["Source run ID", "source_run_id"],
  ["Repository", "repository"],
  ["Elapsed time", "elapsed_time"],
  ["Models used", "models_used"],
  ["Tokens used", "tokens_used"],
  ["Estimated spend", "estimated_spend"],
  ["Strategy loops", "strategy_loops"],
  ["Audit profile", "audit_profile"],
  ["Audit profile catalog digest", "audit_profile_catalog_digest"],
  ["Topology digest", "topology_digest"],
  ["Prompt digest", "prompt_digest"],
  ["Expanded graph fingerprint", "expanded_graph_fingerprint"]
] as const;

type ReportSeverity = "High" | "Medium" | "Low";

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
      proofOfConcept(issue) !== undefined &&
      (collectStrategyRows(issue)?.length ?? 0) > 0
    );
  });
}

/**
 * Validate final-review issue presentation and render its allowlisted public
 * Markdown without repairing, reordering, or rewriting the validated report.
 * This function is intentionally filesystem-free so the CLI and generated
 * runtime use exactly the same checks and rendering.
 */
export function projectCanonicalFinalReport(report: unknown): CanonicalFinalReportProjection {
  assertReportJsonWithinBound(report);
  const input = validateReport(report);
  if (isCanonicalEmptyReport(input)) {
    throw new Error("canonical empty final report is not final-review evidence");
  }
  if (!supportsCanonicalFinalReportProjection(input)) {
    throw new Error("final report is not renderable under the final-review report contract");
  }

  assertCanonicalIssuePresentation(input);

  const markdown = renderCanonicalReport(input);
  if (Buffer.byteLength(markdown, "utf8") > MAX_FINAL_REPORT_MARKDOWN_BYTES) {
    throw new Error(`canonical final report Markdown exceeds ${MAX_FINAL_REPORT_MARKDOWN_BYTES} bytes`);
  }
  if (!isDirectiveConformingFinalReportMarkdown(markdown, input)) {
    throw new Error("canonical final report Markdown does not satisfy the final-review report shape");
  }
  const markdownValidation = validateArtifactContract("ultrafuzz/nonempty-markdown@1", markdown, "report.md");
  if (!markdownValidation.ok) {
    throw new Error(reportValidationMessage(markdownValidation.issues));
  }
  return { report: input, markdown };
}

export function isDirectiveConformingFinalReportMarkdown(
  markdown: string,
  report: JsonRecord,
  requireImplementationCoverage = true
): boolean {
  if (!markdown.startsWith("# Ultrafuzz report\n") || !markdown.includes("\n## Run summary\n")) {
    return false;
  }
  if (requireImplementationCoverage && !markdown.includes("\n## Property implementation coverage\n")) {
    return false;
  }
  if (!markdown.includes("\n## Property provenance\n")) {
    return false;
  }
  const prose = markdownOutsideFencedCode(markdown).replace(/<br\s*\/?\s*>/giu, "");
  if (
    /\bCritical\b/iu.test(prose) ||
    /(?:^|\n)#### Sources\s*$/imu.test(prose) ||
    /\*\*Source (?:Node|Property) Id\*\*/iu.test(prose) ||
    /(?:^|\n)- \*\*Item \d+\*\*/imu.test(prose) ||
    /(?:^|\n)## (?:Executive summary|Issue index|Additional report data)\s*$/imu.test(prose) ||
    /(?:^|\n)#{3,6} (?:Lifecycle|Strategy provenance)\s*$/imu.test(prose)
  ) {
    return false;
  }
  if (
    containsUnredactedSecret(markdown) ||
    containsPrivatePath(markdown) ||
    /<[A-Za-z][^>]*>/u.test(prose) ||
    /!\[[^\]]*\]\(/u.test(prose) ||
    /(?<!\\)\]\((?!#[a-z0-9-]+\))/iu.test(prose)
  ) {
    return false;
  }
  const rendered = renderedIssues(Array.isArray(report.issues) ? report.issues.filter(isRecord) : []);
  const expectedHeadings = rendered.map(renderedIssueHeading);
  const headings = markdown.split("\n").filter((line) => line.startsWith("## ["));
  if (
    headings.length !== expectedHeadings.length ||
    headings.some((heading, index) => heading !== expectedHeadings[index])
  ) {
    return false;
  }
  // Exact equality above proves the Markdown kept the validated JSON order,
  // IDs, and titles. Presentation never assigns severity-local identities.
  if (expectedHeadings.length === 0) {
    return !markdown.includes("| Issue id | Title |");
  }
  if (!markdown.startsWith("# Ultrafuzz report\n\n| Issue id | Title |\n| --- | --- |\n")) {
    return false;
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
    const strategyIndex = block.indexOf("\n### Strategy\n");
    return (
      severityIndex >= 0 &&
      proofIndex > severityIndex &&
      strategyIndex > proofIndex &&
      /\| [^|\n]+ \| \d+\/\d+ \|/u.test(block.slice(strategyIndex))
    );
  });
}

function validateReport(report: unknown): JsonRecord {
  const serialized = `${JSON.stringify(report)}\n`;
  const validation = validateArtifactContract("ultrafuzz/report@2", serialized, "report.json");
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
    const findingId = typeof candidate.id === "string" ? candidate.id : "";
    const title = recordTitle(candidate, "");
    if (findingId.length === 0 || title.length === 0) {
      throw new Error(`final report production issue ${index} lacks its preserved finding ID or title`);
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

function renderCanonicalReport(report: JsonRecord): string {
  const issues = renderedIssues(Array.isArray(report.issues) ? report.issues.filter(isRecord) : []);
  const outcomes = Array.isArray(report.non_production_outcomes) ? report.non_production_outcomes.filter(isRecord) : [];
  const lines = ["# Ultrafuzz report", ""];

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

  for (const issue of issues) {
    appendProductionIssue(lines, issue);
  }

  if (issues.length === 0 && outcomes.length === 0) {
    lines.push("", "No issues reported.");
  }

  appendPropertyImplementationCoverage(lines, report.property_implementation_coverage);
  appendPropertyProvenance(lines, report.property_provenance, issues, outcomes);
  appendPriorFindingDisposition(lines, issues, outcomes);
  appendNonProductionOutcomes(lines, outcomes);
  return `${trimTrailingBlankLines(lines).join("\n")}\n`;
}

function renderedIssues(issues: JsonRecord[]): RenderedIssue[] {
  return issues.map((issue) => ({
    issue,
    severity: requiredSeverity(issue),
    id: typeof issue.id === "string" ? issue.id : "",
    title: recordTitle(issue, "")
  }));
}

function renderedIssueLabel(issue: RenderedIssue): string {
  return `[${publicProse(issue.id)}] - ${publicProse(issue.title)}`;
}

function renderedIssueHeading(issue: RenderedIssue): string {
  return `## ${renderedIssueLabel(issue)}`;
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

function appendProductionIssue(lines: string[], rendered: RenderedIssue): void {
  const { issue } = rendered;
  lines.push("", renderedIssueHeading(rendered), "", publicProse(issueDescription(issue)), "", "### Severity", "");
  const impact = riskAssessment(issue, "impact");
  const likelihood = riskAssessment(issue, "likelihood");
  lines.push(`- **Impact**: ${impact.label}: ${publicProse(impact.rationale)}`);
  lines.push(`- **Likelihood**: ${likelihood.label}: ${publicProse(likelihood.rationale)}`);
  lines.push("", "### Proof of Concept", "");
  appendProofOfConcept(lines, issue);
  appendFamilyVariants(lines, issue.family_variants);
  lines.push("", "### Strategy", "", "| Strategy | Detection rate |", "| --- | --- |");
  for (const row of strategyRows(issue)) {
    lines.push(`| ${tableCell(row.strategy)} | ${tableCell(row.rate)} |`);
  }
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

function strategyRows(issue: JsonRecord): Array<{ strategy: string; rate: string }> {
  const rows = collectStrategyRows(issue);
  if (rows === undefined || rows.length === 0) {
    throw new Error("production issue is missing exact strategy detection rates");
  }
  return rows;
}

function collectStrategyRows(issue: JsonRecord): Array<{ strategy: string; rate: string }> | undefined {
  const provenance = isRecord(issue.strategy_provenance) ? issue.strategy_provenance : {};
  const rates = Array.isArray(provenance.detection_rates) ? provenance.detection_rates.filter(isRecord) : [];
  const rows: Array<{ strategy: string; rate: string }> = [];
  for (const rate of rates) {
    const strategy = rate.strategy;
    if (typeof strategy !== "string" || strategy.length === 0) {
      return undefined;
    }
    const detected = rate.detections;
    const configured = rate.configured_loops;
    if (
      typeof detected !== "number" ||
      !Number.isInteger(detected) ||
      detected < 0 ||
      typeof configured !== "number" ||
      !Number.isInteger(configured) ||
      configured <= 0 ||
      detected > configured
    ) {
      return undefined;
    }
    rows.push({ strategy, rate: `${detected}/${configured}` });
  }
  return rows;
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

function appendPropertyImplementationCoverage(lines: string[], value: unknown): void {
  lines.push("", "## Property implementation coverage", "");
  if (!isRecord(value)) {
    throw new Error("Validated final report is missing typed property implementation coverage");
  }
  if (value.status === "not-planned") {
    lines.push("- Status: `not-planned`");
    lines.push("- Reason: `property-implementation-track-not-declared`");
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
    "| Classification | Title | Status | Evidence | Strategy provenance | Recommended next action |",
    "| --- | --- | --- | --- | --- | --- |"
  );
  for (const outcome of outcomes) {
    lines.push(
      `| ${tableCell(outcome.triage_classification)} | ${tableCell(recordTitle(outcome, "Untitled outcome"))} | ${tableCell(outcome.status)} | ${tableCell(evidenceSummary(outcome.evidence, outcome.summary))} | ${tableCell(strategySummary(outcome))} | ${tableCell(outcome.recommended_next_action)} |`
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
  return containsPrivatePath(text) ? "Evidence retained in structured report." : text;
}

function strategySummary(record: JsonRecord): string {
  const rows = collectStrategyRows(record);
  if (rows === undefined || rows.length === 0) {
    return firstAvailableString(record.strategy) ?? "unavailable";
  }
  return rows.map((row) => `${row.strategy} (${row.rate})`).join(", ");
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
  return redactPrivatePaths(redactSecrets(value))
    .replace(/\s+/gu, " ")
    .trim()
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("*", "\\*")
    .replaceAll("_", "\\_")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("!", "\\!")
    .replaceAll("#", "\\#")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function publicCode(value: string): string {
  return redactPrivatePaths(redactSecrets(value));
}

function publicInlineCode(value: string): string {
  return redactPrivatePaths(redactSecrets(value)).replace(/\s+/gu, " ").trim().replaceAll("`", "'");
}

function redactSecrets(value: string): string {
  const redacted = redactValue(value);
  return typeof redacted === "string" ? redacted : "<redacted>";
}

function containsUnredactedSecret(value: string): boolean {
  const normalizedPlaceholders = value.replaceAll("&lt;redacted&gt;", "<redacted>");
  return redactValue(normalizedPlaceholders) !== normalizedPlaceholders;
}

function containsPrivatePath(value: string): boolean {
  return privatePathPatterns().some((pattern) => pattern.test(value));
}

function redactPrivatePaths(value: string): string {
  return privatePathPatterns().reduce(
    (current, pattern) => current.replace(pattern, (_match, prefix: string) => `${prefix}[redacted-path]`),
    value
  );
}

function privatePathPatterns(): RegExp[] {
  return [
    /(^|[\s("'`])\/(?:home|Users|tmp|var|private|root|opt|mnt|workspace|workspaces)(?:\/[^\s"'`()[\]{}<>]*)?/gmu,
    /(^|[\s("'`])(?:\.ultrafuzz|artifacts|workspaces|generated-tests)\/[^\s"'`()[\]{}<>]*/gmu,
    /(^|[\s("'`])[A-Za-z]:\\(?:Users|Temp|Windows|workspace|workspaces)\\[^\s"'`()[\]{}<>]*/gmu
  ];
}

function recordField(value: unknown, key: string): JsonRecord | undefined {
  return isRecord(value) && isRecord(value[key]) ? value[key] : undefined;
}

function uniqueStrings(value: unknown[]): string[] {
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))];
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
