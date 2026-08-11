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

const severityOrder = ["High", "Medium", "Low"] as const;
type ReportSeverity = (typeof severityOrder)[number];

const alternateSeverityFields = new Set([
  "canonical_severity",
  "classified_severity",
  "final_severity",
  "original_severity",
  "report_severity",
  "severity_final",
  "severity_level",
  "upstream_severity"
]);

interface RenderedIssue {
  issue: JsonRecord;
  id: string;
  severity: ReportSeverity;
  title: string;
}

interface RenderableProof {
  introduction?: string;
  steps: string[];
  code?: string;
  language?: string;
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
 * Canonicalize final-review issue presentation and render its allowlisted
 * public Markdown. This function is intentionally filesystem-free so the CLI
 * and generated runtime use exactly the same projection.
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

  const canonicalReport = reconcileIssuePresentation(input);
  assertReportJsonWithinBound(canonicalReport);
  validateReport(canonicalReport);

  const markdown = renderCanonicalReport(canonicalReport);
  if (Buffer.byteLength(markdown, "utf8") > MAX_FINAL_REPORT_MARKDOWN_BYTES) {
    throw new Error(`canonical final report Markdown exceeds ${MAX_FINAL_REPORT_MARKDOWN_BYTES} bytes`);
  }
  if (!isDirectiveConformingFinalReportMarkdown(markdown, canonicalReport)) {
    throw new Error("canonical final report Markdown does not satisfy the final-review report shape");
  }
  const markdownValidation = validateArtifactContract("ultrafuzz/nonempty-markdown@1", markdown, "report.md");
  if (!markdownValidation.ok) {
    throw new Error(reportValidationMessage(markdownValidation.issues));
  }
  return { report: canonicalReport, markdown };
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
  const issueCount = Array.isArray(report.issues) ? report.issues.length : 0;
  const headings = [...markdown.matchAll(/^## \[[HML]-\d{2}\] - .+$/gmu)];
  if (headings.length !== issueCount) {
    return false;
  }
  if (requireImplementationCoverage) {
    const expectedHeadings = renderedIssues(Array.isArray(report.issues) ? report.issues.filter(isRecord) : []).map(
      (issue) => `## [${issue.id}] - ${publicProse(issue.title)}`
    );
    if (headings.some((heading, index) => heading[0] !== expectedHeadings[index])) {
      return false;
    }
  }
  if (issueCount === 0) {
    return !markdown.includes("| Issue id | Title |");
  }
  if (!markdown.startsWith("# Ultrafuzz report\n\n| Issue id | Title |\n| --- | --- |\n")) {
    return false;
  }
  const issueBlocks = markdown.split(/(?=^## \[[HML]-\d{2}\] - )/gmu).slice(1);
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
  const validation = validateArtifactContract("ultrafuzz/report@1", serialized, "report.json");
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

function reconcileIssuePresentation(report: JsonRecord): JsonRecord {
  if (!Array.isArray(report.issues)) {
    return report;
  }
  const issues = report.issues.map((issue) => {
    if (!isRecord(issue)) {
      throw new Error("final report contains a non-object production issue");
    }
    const impact = requiredAssessment(issue, "impact");
    const likelihood = requiredAssessment(issue, "likelihood");
    return {
      issue,
      impact,
      likelihood,
      severity: matrixSeverity(impact.label, likelihood.label)
    };
  });
  const counters: Record<ReportSeverity, number> = { High: 0, Medium: 0, Low: 0 };
  const idRemap = new Map<string, string>();
  const normalizedIssues = issues
    .map((entry, index) => ({ ...entry, index }))
    .sort(
      (left, right) =>
        severityOrder.indexOf(left.severity) - severityOrder.indexOf(right.severity) || left.index - right.index
    )
    .map(({ issue, impact, likelihood, severity }) => {
      counters[severity] += 1;
      const id = `${severity[0]}-${String(counters[severity]).padStart(2, "0")}`;
      for (const candidate of [issue.id, issue.upstream_id, issue.source_finding_id]) {
        if (typeof candidate === "string" && candidate.trim() !== "") {
          idRemap.set(candidate, id);
        }
      }
      const previousId = firstAvailableString(issue.id);
      const normalizedIssue = removeAlternateSeverityFields(issue, true);
      return {
        ...normalizedIssue,
        ...(previousId !== undefined && !/^[HML]-\d{2}$/u.test(previousId) && issue.upstream_id === undefined
          ? { upstream_id: previousId }
          : {}),
        id,
        title: `[${id}] - ${cleanIssueTitle(recordTitle(issue, "Untitled issue"))}`,
        severity,
        severity_guess: severity,
        impact: impact.label,
        likelihood: likelihood.label,
        ...(impact.rationale === undefined ? {} : { impact_rationale: impact.rationale }),
        ...(likelihood.rationale === undefined ? {} : { likelihood_rationale: likelihood.rationale })
      };
    });

  const propertyProvenance = Array.isArray(report.property_provenance)
    ? report.property_provenance.map((entry) => {
        if (!isRecord(entry)) {
          return entry;
        }
        const findingId = firstAvailableString(entry.finding_id);
        const publicId = findingId === undefined ? undefined : idRemap.get(findingId);
        const issue =
          publicId === undefined ? undefined : normalizedIssues.find((candidate) => candidate.id === publicId);
        return issue === undefined
          ? entry
          : { ...entry, finding_id: publicId, title: firstAvailableString(issue.title) ?? entry.title };
      })
    : report.property_provenance;

  return {
    ...report,
    issues: normalizedIssues,
    ...(propertyProvenance === undefined ? {} : { property_provenance: propertyProvenance })
  };
}

function removeAlternateSeverityFields(value: JsonRecord, preserveCanonical: boolean): JsonRecord {
  const normalized: JsonRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
    if (alternateSeverityFields.has(normalizedKey)) {
      continue;
    }
    if (!preserveCanonical && (key === "severity" || key === "severity_guess")) {
      continue;
    }
    if (Array.isArray(entry)) {
      normalized[key] = entry.map((item) => (isRecord(item) ? removeAlternateSeverityFields(item, false) : item));
      continue;
    }
    normalized[key] = isRecord(entry) ? removeAlternateSeverityFields(entry, false) : entry;
  }
  return normalized;
}

function requiredAssessment(
  issue: JsonRecord,
  field: "impact" | "likelihood"
): { label: ReportSeverity; rationale?: string } {
  const raw = issue[field];
  const label = normalizedSeverity(raw);
  if (label === undefined) {
    throw new Error(`production issue is missing a High, Medium, or Low ${field}`);
  }
  const embedded = typeof raw === "string" ? raw.replace(/^\s*(?:high|medium|low)\s*:\s*/iu, "").trim() : undefined;
  const rationale = firstAvailableString(issue[`${field}_rationale`], embedded);
  return { label, ...(rationale === undefined ? {} : { rationale }) };
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
  return normalizedSeverity(issue[field]);
}

function proofOfConcept(issue: JsonRecord): RenderableProof | undefined {
  const rawProof = issue.proof_of_concept;
  const proof = isRecord(rawProof) ? rawProof : {};
  const candidateSteps = [proof.scenario, proof.steps, proof.execution_trace, proof.trace, rawProof];
  let steps: string[] | undefined;
  for (const candidate of candidateSteps) {
    if (!Array.isArray(candidate)) {
      continue;
    }
    const available = candidate.filter((entry): entry is string => typeof entry === "string" && isAvailable(entry));
    if (available.length > 0) {
      steps = available;
      break;
    }
  }
  const introduction = firstAvailableString(
    typeof proof.scenario === "string" ? proof.scenario : undefined,
    proof.description,
    typeof proof.execution_trace === "string" ? proof.execution_trace : undefined,
    typeof proof.trace === "string" ? proof.trace : undefined,
    typeof rawProof === "string" ? rawProof : undefined
  );
  const normalizedSteps = steps?.map((step) => step.trim()).filter((step) => step.length > 0) ?? [];
  if (normalizedSteps.length === 0 && introduction !== undefined) {
    normalizedSteps.push(introduction);
  }
  if (normalizedSteps.length === 0) {
    return undefined;
  }
  const code = firstAvailableString(proof.code, proof.reproducer, proof.source);
  const language = firstAvailableString(proof.language);
  return {
    ...(introduction !== undefined && steps !== undefined && steps.length > 0 ? { introduction } : {}),
    steps: normalizedSteps,
    ...(code === undefined ? {} : { code }),
    ...(language === undefined ? {} : { language })
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
      const heading = `[${issue.id}] - ${issue.title}`;
      const linkLabel = `[${issue.id}] - ${publicProse(issue.title)}`;
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
  const campaignDidNotRun = appendCampaignOutcome(lines, report.campaign_outcome);

  for (const issue of issues) {
    appendProductionIssue(lines, issue);
  }

  if (issues.length === 0 && outcomes.length === 0) {
    // Saying "no issues" after a campaign that never fuzzed would report an
    // absence of measurement as a clean result.
    lines.push(
      "",
      campaignDidNotRun
        ? "No issues were reported, but the invariant campaign did not run, so this is not a result."
        : "No issues reported."
    );
  }

  appendPropertyImplementationCoverage(lines, report.property_implementation_coverage);
  appendPropertyProvenance(lines, report.property_provenance, issues, outcomes);
  appendPriorFindingDisposition(lines, issues, outcomes);
  appendNonProductionOutcomes(lines, outcomes);
  return `${trimTrailingBlankLines(lines).join("\n")}\n`;
}

function renderedIssues(issues: JsonRecord[]): RenderedIssue[] {
  const counters: Record<ReportSeverity, number> = { High: 0, Medium: 0, Low: 0 };
  return issues
    .map((issue, index) => ({ issue, index, severity: requiredSeverity(issue) }))
    .sort(
      (left, right) =>
        severityOrder.indexOf(left.severity) - severityOrder.indexOf(right.severity) || left.index - right.index
    )
    .map(({ issue, severity }) => {
      counters[severity] += 1;
      return {
        issue,
        severity,
        id: `${severity[0]}-${String(counters[severity]).padStart(2, "0")}`,
        title: cleanIssueTitle(recordTitle(issue, "Untitled issue"))
      };
    });
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

function appendProductionIssue(lines: string[], rendered: RenderedIssue): void {
  const { issue, id, severity, title } = rendered;
  lines.push(
    "",
    `## [${id}] - ${publicProse(title)}`,
    "",
    publicProse(issueDescription(issue)),
    "",
    "### Severity",
    ""
  );
  const impact = riskAssessment(issue, "impact", severity);
  const likelihood = riskAssessment(issue, "likelihood", severity);
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
  if (proof.introduction !== undefined) {
    lines.push(publicProse(proof.introduction), "");
  }
  for (const [index, step] of proof.steps.entries()) {
    lines.push(`${index + 1}. ${publicProse(step)}`);
  }
  if (proof.code !== undefined) {
    const code = publicCode(proof.code);
    const language = safeFenceLanguage(proof.language ?? "text");
    const fence = codeFence(code);
    lines.push("", `${fence}${language}`, code, fence);
  }
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
  const rates = Array.isArray(provenance.detection_rates)
    ? provenance.detection_rates.filter(isRecord)
    : Array.isArray(provenance.strategies)
      ? provenance.strategies.filter(isRecord)
      : [];
  const rows: Array<{ strategy: string; rate: string }> = [];
  for (const rate of rates) {
    const strategy = firstAvailableString(rate.strategy);
    if (strategy === undefined) {
      return undefined;
    }
    const detected = firstDetectionCount(
      rate.detections,
      rate.detected_loops,
      rate.hits,
      rate.matches,
      rate.loop_attempts
    );
    const configured = firstPositiveInteger(rate.configured_loops);
    const explicit = firstAvailableString(rate.rate, rate.detection_rate);
    const exact =
      detected !== undefined && configured !== undefined && detected <= configured
        ? `${detected}/${configured}`
        : exactRate(explicit);
    if (exact === undefined) {
      return undefined;
    }
    rows.push({ strategy, rate: exact });
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
  if (isUnavailable(value)) {
    lines.push("unavailable");
    return;
  }
  if (!isRecord(value)) {
    lines.push("unavailable");
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
  const raw = firstDefined(issue.severity, issue.severity_guess);
  const severity = normalizedSeverity(raw);
  if (severity === undefined) {
    throw new Error("production issue is missing a High, Medium, or Low report severity");
  }
  return severity;
}

function riskAssessment(
  issue: JsonRecord,
  field: "impact" | "likelihood",
  fallback: ReportSeverity
): { label: ReportSeverity; rationale: string } {
  const raw = issue[field];
  const label = normalizedSeverity(raw) ?? fallback;
  const embedded = typeof raw === "string" ? raw.replace(/^\s*(?:high|medium|low)\s*:\s*/iu, "").trim() : "";
  const rationale = firstAvailableString(issue[`${field}_rationale`], embedded, issue.description, issue.summary);
  return { label, rationale: rationale ?? "No additional rationale was recorded." };
}

function normalizedSeverity(value: unknown): ReportSeverity | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = value
    .trim()
    .match(/^(high|medium|low)(?:\s*:|$)/iu)?.[1]
    ?.toLowerCase();
  return match === "high" ? "High" : match === "medium" ? "Medium" : match === "low" ? "Low" : undefined;
}

function issueDescription(issue: JsonRecord): string {
  return firstAvailableString(issue.description, issue.summary) ?? "No public issue description was recorded.";
}

function cleanIssueTitle(value: string): string {
  return value
    .replace(/^\s*\[[HML]-\d{2}\]\s*-\s*/iu, "")
    .replace(/\s+/gu, " ")
    .trim();
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
  const issue = issues.find(({ issue: candidate }) =>
    [candidate.id, candidate.upstream_id, candidate.source_finding_id].some((value) => value === findingId)
  );
  if (issue !== undefined) {
    return `[${issue.id}] - ${issue.title}`;
  }
  const outcome = outcomes.find((candidate) =>
    [candidate.id, candidate.upstream_id, candidate.source_finding_id].some((value) => value === findingId)
  );
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

function exactRate(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = /^(\d+)\/(\d+)$/u.exec(value.trim());
  if (match === null) {
    return undefined;
  }
  const detected = Number(match[1]);
  const configured = Number(match[2]);
  return configured > 0 && detected <= configured ? `${detected}/${configured}` : undefined;
}

function firstPositiveInteger(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isInteger(value) && value > 0);
}

function firstDetectionCount(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      return value;
    }
    if (Array.isArray(value)) {
      return value.length;
    }
  }
  return undefined;
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

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
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
