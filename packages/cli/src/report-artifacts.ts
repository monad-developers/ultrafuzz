import fs from "node:fs";
import path from "node:path";

import {
  assertNoSymlinkComponents,
  assertRegularFileInside,
  layoutForRunRoot,
  readArtifactManifest,
  resolveCampaignFindingBackends,
  validateArtifactContract,
  validateFindingsSchema,
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
import {
  isDirectiveConformingFinalReportMarkdown,
  MAX_FINAL_REPORT_JSON_BYTES,
  MAX_FINAL_REPORT_MARKDOWN_BYTES,
  projectCanonicalFinalReport,
  supportsCanonicalFinalReportProjection
} from "@ultrafuzz/runtime";

export interface ReconciledReportArtifacts {
  markdown_path: string;
  json_path: string;
  source: "canonical-final-report" | "preserved-agent-report";
}

type JsonRecord = Record<string, unknown>;

const MAX_AUXILIARY_JSON_BYTES = 16 * 1024 * 1024;

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
    readBoundedText(root, jsonPath, "report JSON", MAX_FINAL_REPORT_JSON_BYTES),
    jsonPath
  );
  if (!original.ok || !isRecord(original.value)) {
    throw new Error(reportValidationMessage(original.issues));
  }

  if (!supportsCanonicalFinalReportProjection(original.value)) {
    if (readImplementedPropertiesArtifact(root)?.selection !== undefined) {
      throw new Error("current invariant final report is not renderable and cannot be preserved as historical");
    }
    if (!fs.existsSync(markdownPath)) {
      throw new Error("historical final report cannot be regenerated because its Markdown artifact is missing");
    }
    assertRegularFileInside(root, markdownPath, "report markdown path");
    const existingMarkdown = readBoundedText(root, markdownPath, "report Markdown", MAX_FINAL_REPORT_MARKDOWN_BYTES);
    if (!isDirectiveConformingFinalReportMarkdown(existingMarkdown, original.value, false)) {
      throw new Error("historical final report Markdown does not satisfy the final-review report shape");
    }
    reconcileReportArtifactManifest(root, reportDirectory, original.value);
    return { markdown_path: markdownPath, json_path: jsonPath, source: "preserved-agent-report" };
  }

  let report = reconcileRunMetadata(root, original.value);
  report = reconcilePropertyImplementationCoverage(root, report);
  report = reconcilePropertyProvenance(root, report);
  const projection = projectCanonicalFinalReport(report);
  report = projection.report;
  const markdown = projection.markdown;

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

function readCampaignBackends(runRoot: string): ReadonlyMap<string, readonly string[]> {
  const campaigns: PropertyCampaignArtifact[] = [];
  const findings: Array<Record<string, unknown>> = [];
  for (const logicalNodeId of ["stateful-invariant-campaign", "stateful-invariant-recon-campaign"] as const) {
    for (const fileName of ["echidna-results.json", "medusa-results.json", "recon-fuzzer-results.json"] as const) {
      const artifactPath = logicalArtifactPath(runRoot, logicalNodeId, fileName);
      if (artifactPath === undefined) continue;
      const validation = validatePropertyCampaignSchema(readUnknown(runRoot, artifactPath), artifactPath);
      if (validation.ok && validation.value !== undefined) campaigns.push(validation.value);
    }
    const findingsPath = logicalArtifactPath(runRoot, logicalNodeId, "findings.json");
    if (findingsPath === undefined) continue;
    const validation = validateFindingsSchema(readUnknown(runRoot, findingsPath), findingsPath);
    if (validation.ok && validation.value !== undefined) findings.push(...validation.value);
  }
  return resolveCampaignFindingBackends(campaigns, findings);
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

function reportValidationMessage(issues: Array<{ code: string; message: string; path: string }>): string {
  const detail = issues.slice(0, 5).map((issue) => `${issue.code} at ${issue.path}: ${issue.message}`);
  return `final report JSON failed validation${detail.length === 0 ? "" : `: ${detail.join("; ")}`}`;
}
