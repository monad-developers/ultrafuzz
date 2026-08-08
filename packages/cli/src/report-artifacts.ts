import fs from "node:fs";
import path from "node:path";

import {
  assertNoSymlinkComponents,
  assertRegularFileInside,
  layoutForRunRoot,
  readArtifactManifest,
  redactValue,
  validateArtifactContract,
  validateImplementedPropertiesSchema,
  validatePropertiesSchema,
  validatePropertyCampaignSchema,
  writeArtifactManifest,
  writeFileDurable,
  writeJsonDurable,
  type ImplementedPropertiesArtifact,
  type PropertiesArtifact,
  type PropertyCampaignArtifact
} from "@ultrafuzz/artifacts";

export interface ReconciledReportArtifacts {
  markdown_path: string;
  json_path: string;
  source: "canonical-final-report" | "preserved-agent-report";
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
  ["Strategy loops", "strategy_loops"]
] as const;

const severityOrder = ["High", "Medium", "Low"] as const;
type ReportSeverity = (typeof severityOrder)[number];
const MAX_REPORT_JSON_BYTES = 64 * 1024 * 1024;
const MAX_REPORT_MARKDOWN_BYTES = 16 * 1024 * 1024;
const MAX_AUXILIARY_JSON_BYTES = 16 * 1024 * 1024;
/**
 * A report-relative audit-context link: `../<dir>/.../<file>` with no traversal past the sibling
 * artifact directory. Every segment after the single leading `..` must be an ordinary name, so a
 * link such as `../threat-model/../../../escape.md` is rejected.
 */
const SAFE_REPORT_RELATIVE_LINK_PATTERN = /^\.\.\/(?:(?!\.\.?\/)[A-Za-z0-9._-]+\/)+(?!\.\.?$)[A-Za-z0-9._-]+$/u;
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

export function reconcileReportArtifacts(runRoot: string): ReconciledReportArtifacts {
  const root = path.resolve(runRoot);
  assertNoSymlinkComponents(root, root, "run root");
  const reportDirectory = findReportDirectory(root);
  const jsonPath = path.join(reportDirectory, "report.json");
  const markdownPath = path.join(reportDirectory, "report.md");
  assertRegularFileInside(root, jsonPath, "report JSON path");
  if (fs.existsSync(markdownPath)) {
    assertRegularFileInside(root, markdownPath, "report markdown path");
  }

  const original = validateArtifactContract(
    "ultrafuzz/report@1",
    readBoundedText(root, jsonPath, "report JSON", MAX_REPORT_JSON_BYTES),
    jsonPath
  );
  if (!original.ok || !isRecord(original.value)) {
    throw new Error(reportValidationMessage(original.issues));
  }

  if (!reportSupportsCanonicalRendering(original.value)) {
    if (readImplementedPropertiesArtifact(root)?.selection !== undefined) {
      throw new Error("current invariant final report is not renderable and cannot be preserved as historical");
    }
    if (!fs.existsSync(markdownPath)) {
      throw new Error("historical final report cannot be regenerated because its Markdown artifact is missing");
    }
    assertRegularFileInside(root, markdownPath, "report markdown path");
    const existingMarkdown = readBoundedText(root, markdownPath, "report Markdown", MAX_REPORT_MARKDOWN_BYTES);
    if (!isDirectiveConformingMarkdown(existingMarkdown, original.value, false)) {
      throw new Error("historical final report Markdown does not satisfy the final-review report shape");
    }
    reconcileReportArtifactManifest(root, reportDirectory, original.value);
    return { markdown_path: markdownPath, json_path: jsonPath, source: "preserved-agent-report" };
  }

  let report = reconcileRunMetadata(root, original.value);
  report = reconcileAuditContext(root, reportDirectory, report);
  report = reconcileFindingSourceProvenance(root, report);
  report = reconcilePropertyImplementationCoverage(root, report);
  report = reconcilePropertyProvenance(root, report);
  report = reconcileIssuePresentation(report);
  assertValidReport(report, jsonPath);

  const markdown = renderCanonicalReport(report);
  if (!isDirectiveConformingMarkdown(markdown, report)) {
    throw new Error("canonical final report Markdown does not satisfy the final-review report shape");
  }
  const markdownValidation = validateArtifactContract("ultrafuzz/nonempty-markdown@1", markdown, markdownPath);
  if (!markdownValidation.ok) {
    throw new Error(reportValidationMessage(markdownValidation.issues));
  }

  writeJsonDurable(jsonPath, report);
  writeFileDurable(markdownPath, markdown);
  reconcileReportArtifactManifest(root, reportDirectory, report);
  assertRegularFileInside(root, jsonPath, "report JSON path");
  assertRegularFileInside(root, markdownPath, "report markdown path");
  return { markdown_path: markdownPath, json_path: jsonPath, source: "canonical-final-report" };
}

function reconcileReportArtifactManifest(runRoot: string, reportDirectory: string, report: JsonRecord): void {
  const manifestPath = path.join(reportDirectory, "artifact-manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return;
  }
  assertRegularFileInside(runRoot, manifestPath, "report artifact manifest path");
  const runId =
    typeof recordField(report, "run_metadata")?.run_id === "string"
      ? String(recordField(report, "run_metadata")?.run_id)
      : path.basename(runRoot);
  const layout = layoutForRunRoot(runRoot, runId);
  const nodeId = path.relative(layout.artifactsDir, reportDirectory);
  const existing = readArtifactManifest(layout, nodeId);
  writeArtifactManifest({
    layout,
    nodeId,
    provenance: existing.provenance,
    include: existing.files.map((entry) => entry.path).filter((entry) => !isReportBackupPath(entry)),
    outputs: existing.output_contracts,
    prerequisiteNodeIds: existing.prerequisite_manifests.map((entry) => entry.node_id),
    createdAt: existing.created_at
  });
}

function findReportDirectory(runRoot: string): string {
  for (const candidate of reportDirectories(runRoot)) {
    const jsonPath = path.join(candidate, "report.json");
    if (fs.existsSync(jsonPath)) {
      assertRegularFileInside(runRoot, jsonPath, "report JSON path");
      return candidate;
    }
  }
  throw new Error("agent-written report JSON is not available for this run");
}

function reportDirectories(runRoot: string): string[] {
  const artifactsRoot = path.join(runRoot, "artifacts");
  const candidates = [path.join(artifactsRoot, "final-report")];
  if (fs.existsSync(artifactsRoot)) {
    for (const entry of fs.readdirSync(artifactsRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("final-report")) {
        candidates.push(path.join(artifactsRoot, entry.name));
      }
    }
  }
  return Array.from(new Set(candidates));
}

function reconcileRunMetadata(runRoot: string, report: JsonRecord): JsonRecord {
  const run = readRecord(runRoot, path.join(runRoot, "run.json"));
  const state = readRecord(runRoot, path.join(runRoot, "state.json"));
  const accounting = recordField(recordField(run, "accounting"), "cumulative");
  const current = isRecord(report.run_metadata) ? report.run_metadata : {};
  const metadata: JsonRecord = { ...current };

  assignAuthoritative(metadata, "run_id", firstDefined(run?.run_id, state?.run_id));
  assignAuthoritative(metadata, "source_run_id", firstDefined(run?.source_run_id, state?.source_run_id));
  assignAuthoritative(
    metadata,
    "tokens_used",
    availableValue(firstDefined(accounting?.tokens_used, accounting?.tokensUsed))
  );
  assignAuthoritative(
    metadata,
    "estimated_spend",
    availableValue(firstDefined(accounting?.estimated_spend, accounting?.estimatedSpend))
  );
  assignAuthoritative(
    metadata,
    "partial_pricing",
    firstDefined(accounting?.partial_pricing, accounting?.partialPricing)
  );
  assignAuthoritative(metadata, "source_run_ids", firstDefined(accounting?.source_run_ids, accounting?.sourceRunIds));
  const models = firstDefined(accounting?.models, accounting?.models_used, accounting?.modelsUsed);
  if (Array.isArray(models) && models.every((entry) => typeof entry === "string")) {
    metadata.models_used = models;
  }
  const elapsed = elapsedLabel(state?.started_at, state?.finished_at ?? state?.last_transition_at);
  if (elapsed !== undefined) {
    metadata.elapsed_time = elapsed;
  }
  return { ...report, run_metadata: metadata };
}

function reconcileAuditContext(runRoot: string, reportDirectory: string, report: JsonRecord): JsonRecord {
  const threatMarkdown = logicalArtifactPath(runRoot, "threat-model", "THREAT_MODEL.md");
  const threatJson = logicalArtifactPath(runRoot, "threat-model", "threat-model.json");
  const goalPlanJson = logicalArtifactPath(runRoot, "goal-plan", "goal-plan.json");
  const context: JsonRecord = {};
  if (threatMarkdown !== undefined || threatJson !== undefined) {
    context.threat_model = {
      ...(threatMarkdown === undefined ? {} : { markdown: reportRelativeArtifact(reportDirectory, threatMarkdown) }),
      ...(threatJson === undefined ? {} : { json: reportRelativeArtifact(reportDirectory, threatJson) })
    };
  }
  if (goalPlanJson !== undefined) {
    context.goal_plan = { json: reportRelativeArtifact(reportDirectory, goalPlanJson) };
  }
  const { audit_context: _untrustedAuditContext, ...rest } = report;
  return Object.keys(context).length === 0 ? rest : { ...rest, audit_context: context };
}

function reconcileFindingSourceProvenance(runRoot: string, report: JsonRecord): JsonRecord {
  const upstream = readFindingHandoff(runRoot);
  if (upstream.length === 0) return report;
  const uniqueByKey = uniqueFindingRecordsByKey(upstream);
  const reconcile = (value: unknown): unknown => {
    if (!isRecord(value)) return value;
    const match = findingKeys(value)
      .map((key) => uniqueByKey.get(key))
      .find((candidate): candidate is JsonRecord => candidate !== undefined);
    const sourceNodes = findingSourceNodes(match ?? value);
    if (sourceNodes.length === 0) return value;
    return { ...value, source_node_id: sourceNodes[0], source_nodes: sourceNodes };
  };
  return {
    ...report,
    ...(Array.isArray(report.issues) ? { issues: report.issues.map(reconcile) } : {}),
    ...(Array.isArray(report.non_production_outcomes)
      ? { non_production_outcomes: report.non_production_outcomes.map(reconcile) }
      : {})
  };
}

function readFindingHandoff(runRoot: string): JsonRecord[] {
  for (const [logicalNodeId, fileName] of [
    ["severity-classification", "severity-classified-findings.json"],
    ["dedupe-findings", "deduped-findings.json"]
  ] as const) {
    const artifactPath = logicalArtifactPath(runRoot, logicalNodeId, fileName);
    if (artifactPath === undefined) continue;
    const value = readUnknown(runRoot, artifactPath);
    const findings = Array.isArray(value)
      ? value
      : isRecord(value) && Array.isArray(value.findings)
        ? value.findings
        : [];
    const records = findings.filter(isRecord);
    if (records.length > 0) return records;
  }
  return [];
}

function uniqueFindingRecordsByKey(records: JsonRecord[]): Map<string, JsonRecord> {
  const candidates = new Map<string, JsonRecord | undefined>();
  for (const record of records) {
    for (const key of findingKeys(record)) {
      candidates.set(key, candidates.has(key) ? undefined : record);
    }
  }
  return new Map([...candidates].filter((entry): entry is [string, JsonRecord] => entry[1] !== undefined));
}

function findingKeys(record: JsonRecord): string[] {
  const lifecycle = recordField(record, "lifecycle");
  return uniqueStrings(
    [record.dedupe_key, lifecycle?.dedupe_key, record.id, record.upstream_id, record.source_finding_id]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
  );
}

function findingSourceNodes(record: JsonRecord): string[] {
  return uniqueStrings(
    [
      ...(Array.isArray(record.source_nodes) ? record.source_nodes : []),
      ...(typeof record.source_node_id === "string" ? [record.source_node_id] : [])
    ].map((value) => (typeof value === "string" ? value.trim() : value))
  );
}

function reportRelativeArtifact(reportDirectory: string, artifactPath: string): string {
  const relative = path.relative(reportDirectory, artifactPath).split(path.sep).join("/");
  if (!SAFE_REPORT_RELATIVE_LINK_PATTERN.test(relative)) {
    throw new Error("audit context artifact did not produce a safe report-relative link");
  }
  return relative;
}

function reconcilePropertyProvenance(runRoot: string, report: JsonRecord): JsonRecord {
  if (!Array.isArray(report.property_provenance) || report.property_provenance.length === 0) {
    return report;
  }
  const catalog = readPropertiesArtifact(runRoot);
  const implementation = readImplementedPropertiesArtifact(runRoot);
  if (catalog === undefined || implementation === undefined) {
    return report;
  }

  const catalogById = new Map(catalog.properties.map((entry) => [entry.id, entry]));
  const implementationById = new Map(implementation.properties.map((entry) => [entry.property_id, entry]));
  const backendsByFinding = readCampaignBackends(runRoot);
  const entries: JsonRecord[] = [];

  for (const rawEntry of report.property_provenance) {
    if (!isRecord(rawEntry) || !Array.isArray(rawEntry.property_ids)) {
      continue;
    }
    const requestedPropertyIds = uniqueStrings(rawEntry.property_ids).sort();
    const unknownCatalogIds = requestedPropertyIds.filter((propertyId) => !catalogById.has(propertyId));
    const unknownImplementationIds = requestedPropertyIds.filter((propertyId) => !implementationById.has(propertyId));
    if (unknownCatalogIds.length > 0 || unknownImplementationIds.length > 0) {
      throw new Error("current-run property provenance references an unknown canonical or implementation property");
    }
    const propertyIds = requestedPropertyIds;
    if (propertyIds.length === 0) {
      continue;
    }
    const sources = dedupeRecords(
      propertyIds.flatMap((propertyId) => catalogById.get(propertyId)?.sources ?? []),
      (source) => `${String(source.source_node_id)}\u0000${String(source.source_property_id)}`
    );
    const implementationPaths = uniqueStrings(
      propertyIds.flatMap((propertyId) => implementationById.get(propertyId)?.implementation_paths ?? [])
    ).sort();
    const testPaths = uniqueStrings(
      propertyIds.flatMap((propertyId) => implementationById.get(propertyId)?.test_paths ?? [])
    ).sort();
    const findingId = typeof rawEntry.finding_id === "string" ? rawEntry.finding_id : undefined;
    const backends = findingId === undefined ? [] : [...(backendsByFinding.get(findingId) ?? [])].sort();
    const { fuzzer_backend: _legacyBackend, fuzzer_backends: _legacyBackends, ...rest } = rawEntry;
    entries.push({
      ...rest,
      property_ids: propertyIds,
      sources,
      implementation_paths: implementationPaths,
      test_paths: testPaths,
      ...(backends.length === 1
        ? { fuzzer_backend: backends[0] }
        : backends.length > 1
          ? { fuzzer_backends: backends }
          : {})
    });
  }
  return { ...report, property_provenance: entries };
}

function reconcilePropertyImplementationCoverage(runRoot: string, report: JsonRecord): JsonRecord {
  const catalog = readPropertiesArtifact(runRoot);
  const implementation = readImplementedPropertiesArtifact(runRoot);
  if (catalog === undefined || implementation?.selection === undefined) {
    return { ...report, property_implementation_coverage: "unavailable" };
  }

  const selection = implementation.selection;
  const priorityOrder = ["high", "medium", "low"] as const;
  const thresholdIndex = priorityOrder.indexOf(selection.priority_threshold);
  const expectedPriorities = priorityOrder.slice(0, thresholdIndex + 1);
  if (!sameStringArray(selection.priorities, expectedPriorities)) {
    throw new Error("current-run property implementation selection priorities do not match its threshold");
  }
  const configuredSelection = readConfiguredInvariantPrioritySelection(runRoot);
  if (
    configuredSelection !== undefined &&
    (selection.priority_threshold !== configuredSelection.priority_threshold ||
      !sameStringArray(selection.priorities, configuredSelection.priorities))
  ) {
    throw new Error("current-run property implementation selection does not match resolved invariant configuration");
  }
  const expectedIds = catalog.properties
    .filter(
      (property) =>
        selection.priorities.includes(property.priority) ||
        (property.reference_expectations !== undefined && property.reference_expectations.length > 0)
    )
    .map((property) => property.id);
  if (!sameStringArray(selection.property_ids, expectedIds)) {
    throw new Error("current-run property implementation selection does not match the canonical catalog");
  }
  const recordsById = new Map(implementation.properties.map((record) => [record.property_id, record]));
  if (
    recordsById.size !== expectedIds.length ||
    expectedIds.some((propertyId) => !recordsById.has(propertyId)) ||
    implementation.properties.some((record) => !expectedIds.includes(record.property_id))
  ) {
    throw new Error("current-run property implementation records do not match the canonical selection");
  }
  const idsWithStatus = (status: string): string[] =>
    expectedIds.filter((propertyId) => recordsById.get(propertyId)?.status === status);
  const blockerSummaries = expectedIds.flatMap((propertyId) => {
    const record = recordsById.get(propertyId);
    if (record === undefined || record.status === "implemented" || record.blocker === undefined) return [];
    return [`${propertyId}: ${record.blocker.summary}`];
  });
  const referenceExpectedPropertyIds = catalog.properties
    .filter((property) => (property.reference_expectations?.length ?? 0) > 0)
    .map((property) => property.id);
  const referenceExpectationIds = uniqueStrings(
    catalog.properties.flatMap((property) => property.reference_expectations ?? [])
  );
  return {
    ...report,
    property_implementation_coverage: {
      priority_threshold: selection.priority_threshold,
      priorities: selection.priorities,
      selected_property_ids: expectedIds,
      implemented_property_ids: idsWithStatus("implemented"),
      blocked_property_ids: idsWithStatus("blocked"),
      pending_property_ids: idsWithStatus("pending"),
      deferred_property_ids: idsWithStatus("deferred"),
      reference_expected_property_ids: referenceExpectedPropertyIds,
      reference_expectation_ids: referenceExpectationIds,
      blocker_summaries: blockerSummaries
    }
  };
}

function readConfiguredInvariantPrioritySelection(
  runRoot: string
): { priority_threshold: "high" | "medium" | "low"; priorities: ("high" | "medium" | "low")[] } | undefined {
  const configPath = path.join(runRoot, "config.resolved.toml");
  if (!fs.existsSync(configPath)) return undefined;
  const contents = fs.readFileSync(configPath, "utf8");
  const match = /^\s*property_priority_threshold\s*=\s*["'](high|medium|low)["']\s*$/mu.exec(contents);
  if (match === null) return undefined;
  const priority_threshold = match[1] as "high" | "medium" | "low";
  const order = ["high", "medium", "low"] as const;
  return { priority_threshold, priorities: order.slice(0, order.indexOf(priority_threshold) + 1) };
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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

function readPropertiesArtifact(runRoot: string): PropertiesArtifact | undefined {
  const artifactPath = logicalArtifactPath(runRoot, "property-specification-fanin", "properties.json");
  if (artifactPath === undefined) {
    return undefined;
  }
  const result = validatePropertiesSchema(readUnknown(runRoot, artifactPath), artifactPath);
  return result.ok ? result.value : undefined;
}

function readImplementedPropertiesArtifact(runRoot: string): ImplementedPropertiesArtifact | undefined {
  const artifactPath = logicalArtifactPath(
    runRoot,
    "stateful-invariant-implement-properties",
    "implemented-properties.json"
  );
  if (artifactPath === undefined) {
    return undefined;
  }
  const result = validateImplementedPropertiesSchema(readUnknown(runRoot, artifactPath), artifactPath);
  return result.ok ? result.value : undefined;
}

function readCampaignBackends(runRoot: string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const [logicalNodeId, fileName] of [
    ["stateful-invariant-campaign", "echidna-results.json"],
    ["stateful-invariant-campaign", "medusa-results.json"],
    ["stateful-invariant-campaign", "recon-fuzzer-results.json"],
    ["stateful-invariant-recon-campaign", "recon-fuzzer-results.json"]
  ] as const) {
    const artifactPath = logicalArtifactPath(runRoot, logicalNodeId, fileName);
    if (artifactPath === undefined) {
      continue;
    }
    const validation = validatePropertyCampaignSchema(readUnknown(runRoot, artifactPath), artifactPath);
    if (!validation.ok || validation.value?.fuzzer_backend === undefined) {
      continue;
    }
    addCampaignBackends(result, validation.value);
  }
  return result;
}

function addCampaignBackends(target: Map<string, Set<string>>, campaign: PropertyCampaignArtifact): void {
  if (campaign.fuzzer_backend === undefined) {
    return;
  }
  for (const failure of campaign.failures) {
    const backends = target.get(failure.id) ?? new Set<string>();
    backends.add(campaign.fuzzer_backend);
    target.set(failure.id, backends);
  }
}

function logicalArtifactPath(runRoot: string, logicalNodeId: string, fileName: string): string | undefined {
  const candidates = new Set([logicalNodeId]);
  const state = readRecord(runRoot, path.join(runRoot, "state.json"));
  const nodes = recordField(state, "nodes");
  for (const [nodeId, nodeState] of Object.entries(nodes ?? {})) {
    if (isRecord(nodeState) && nodeState.logical_node_id === logicalNodeId) {
      candidates.add(nodeId);
    }
  }
  for (const nodeId of candidates) {
    const candidate = path.join(runRoot, "artifacts", nodeId, fileName);
    if (fs.existsSync(candidate)) {
      assertRegularFileInside(runRoot, candidate, `${logicalNodeId} artifact`);
      return candidate;
    }
  }
  return undefined;
}

function reportSupportsCanonicalRendering(report: JsonRecord): boolean {
  if (!Array.isArray(report.issues)) {
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

function isDirectiveConformingMarkdown(
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
  if (
    /\bCritical\b/iu.test(markdown) ||
    /(?:^|\n)#### Sources\s*$/imu.test(markdown) ||
    /\*\*Source (?:Node|Property) Id\*\*/iu.test(markdown) ||
    /(?:^|\n)- \*\*Item \d+\*\*/imu.test(markdown) ||
    /(?:^|\n)## (?:Executive summary|Issue index|Additional report data)\s*$/imu.test(markdown) ||
    /(?:^|\n)#{3,6} (?:Lifecycle|Strategy provenance)\s*$/imu.test(markdown)
  ) {
    return false;
  }
  const prose = markdownOutsideFencedCode(markdown).replace(/<br\s*\/?\s*>/giu, "");
  if (
    containsUnredactedSecret(markdown) ||
    containsPrivatePath(markdown) ||
    /<[A-Za-z][^>]*>/u.test(prose) ||
    /!\[[^\]]*\]\(/u.test(prose) ||
    /(?<!\\)\]\((?!(?:#[a-z0-9-]+|\.\.\/(?:(?!\.\.?\/)[A-Za-z0-9._-]+\/)+(?!\.\.?\))[A-Za-z0-9._-]+)\))/iu.test(prose)
  ) {
    return false;
  }
  const issueCount = Array.isArray(report.issues) ? report.issues.length : 0;
  const headings = [...markdown.matchAll(/^## \[[HML]-\d{2}\] - .+$/gmu)];
  if (headings.length !== issueCount) {
    return false;
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

function markdownOutsideFencedCode(markdown: string): string {
  const prose: string[] = [];
  let fenceLength: number | undefined;
  for (const line of markdown.split("\n")) {
    const fence = /^(`{3,})/u.exec(line)?.[1];
    if (fenceLength === undefined && fence !== undefined) {
      fenceLength = fence.length;
      continue;
    }
    if (fenceLength !== undefined && fence !== undefined && fence.length >= fenceLength) {
      fenceLength = undefined;
      continue;
    }
    if (fenceLength === undefined) {
      prose.push(line);
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
  appendAuditContext(lines, report.audit_context);

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
  const sourceNodes = findingSourceNodes(issue);
  if (sourceNodes.length > 0) {
    lines.push(`- **Source nodes**: ${sourceNodes.map((source) => `\`${publicInlineCode(source)}\``).join(", ")}`);
  }
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

function readBoundedText(runRoot: string, filePath: string, label: string, maximumBytes: number): string {
  assertRegularFileInside(runRoot, filePath, label);
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new Error(`${label} must be a regular file`);
    }
    if (stat.size > maximumBytes) {
      throw new Error(`${label} exceeds the ${maximumBytes}-byte read limit`);
    }
    const contents = fs.readFileSync(descriptor);
    if (contents.byteLength > maximumBytes) {
      throw new Error(`${label} exceeds the ${maximumBytes}-byte read limit`);
    }
    return contents.toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function lstatIfPresent(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function isReportBackupPath(relativePath: string): boolean {
  return /(?:^|\/)report\.json\.pre-/u.test(relativePath);
}

function readRecord(runRoot: string, filePath: string): JsonRecord | undefined {
  if (lstatIfPresent(filePath) === undefined) {
    return undefined;
  }
  const value = readUnknown(runRoot, filePath);
  return isRecord(value) ? value : undefined;
}

function readUnknown(runRoot: string, filePath: string): unknown {
  return JSON.parse(readBoundedText(runRoot, filePath, "report auxiliary JSON", MAX_AUXILIARY_JSON_BYTES)) as unknown;
}

function recordField(value: unknown, key: string): JsonRecord | undefined {
  return isRecord(value) && isRecord(value[key]) ? value[key] : undefined;
}

function assignAuthoritative(target: JsonRecord, key: string, value: unknown): void {
  if (value !== undefined && value !== null && !isUnavailable(value)) {
    target[key] = value;
  }
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function availableValue(value: unknown): unknown {
  return isUnavailable(value) ? undefined : value;
}

function elapsedLabel(startedAt: unknown, finishedAt: unknown): string | undefined {
  if (typeof startedAt !== "string" || typeof finishedAt !== "string") {
    return undefined;
  }
  const start = Date.parse(startedAt);
  const finish = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) {
    return undefined;
  }
  const totalSeconds = Math.floor((finish - start) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours > 0 ? `${hours}h` : undefined, minutes > 0 ? `${minutes}m` : undefined, `${seconds}s`]
    .filter((part): part is string => part !== undefined)
    .join(" ");
}

function uniqueStrings(value: unknown[]): string[] {
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))];
}

function dedupeRecords<T extends object>(records: T[], key: (record: T) => string): T[] {
  return [...new Map(records.map((record) => [key(record), record])).values()];
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

function assertValidReport(report: JsonRecord, reportPath: string): void {
  const validation = validateArtifactContract("ultrafuzz/report@1", `${JSON.stringify(report)}\n`, reportPath);
  if (!validation.ok) {
    throw new Error(reportValidationMessage(validation.issues));
  }
}

function reportValidationMessage(issues: Array<{ code: string; message: string; path: string }>): string {
  const detail = issues.slice(0, 5).map((issue) => `${issue.code} at ${issue.path}: ${issue.message}`);
  return `final report JSON failed validation${detail.length === 0 ? "" : `: ${detail.join("; ")}`}`;
}
