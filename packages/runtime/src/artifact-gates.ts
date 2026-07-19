import fs from "node:fs";
import path from "node:path";

import {
  assertRegularFileInside,
  getNodeArtifactDir,
  readJsonFile,
  readRunState,
  safeResolveInside,
  updateNodeState,
  validateArtifactContract,
  validateFindingsSchema,
  validateGeneratedTestManifestSchema,
  validateImplementedPropertiesSchema,
  validatePropertiesSchema,
  validatePropertyCampaignSchema,
  validatePropertyReferences,
  verifyArtifactManifestPrerequisites,
  type ImplementedPropertiesArtifact,
  type PropertiesArtifact,
  type PropertyReferenceInput,
  type RunLayout,
  type RunState
} from "@ultrafuzz/artifacts";

import type { PlannedGraph, PlannedGraphNode, RuntimeDiagnostic } from "./types.js";
import { diagnosticFromError } from "./utils.js";
import { validateSeverityMatrixArtifact, type SeverityArtifactKind } from "./severity-matrix.js";

export interface DependencyGateDecision {
  ok: boolean;
  reason_code?: string;
  reason?: string;
  blocked_by?: string[];
}

export interface RequiredArtifactGate {
  ok: boolean;
  diagnostics: RuntimeDiagnostic[];
  missing: string[];
}

export function checkDependencyLegality(graph: PlannedGraph): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  const ids = new Set(graph.nodes.map((node) => node.id));
  for (const node of graph.nodes) {
    const seen = new Set<string>();
    for (const dependency of node.depends_on) {
      if (dependency === node.id) {
        diagnostics.push({
          code: "RUNTIME_DEPENDENCY_SELF",
          message: `node ${node.id} depends on itself`,
          severity: "error",
          source: "runtime",
          path: `graph.nodes.${node.id}.depends_on`
        });
      }
      if (seen.has(dependency)) {
        diagnostics.push({
          code: "RUNTIME_DEPENDENCY_DUPLICATE",
          message: `node ${node.id} repeats dependency ${dependency}`,
          severity: "error",
          source: "runtime",
          path: `graph.nodes.${node.id}.depends_on`
        });
      }
      seen.add(dependency);
      if (!ids.has(dependency)) {
        diagnostics.push({
          code: "RUNTIME_DEPENDENCY_UNKNOWN",
          message: `node ${node.id} depends on unknown node ${dependency}`,
          severity: "error",
          source: "runtime",
          path: `graph.nodes.${node.id}.depends_on`
        });
      }
    }
  }
  return diagnostics;
}

export function dependencyGateForNode(
  node: PlannedGraphNode,
  state: RunState,
  layout?: RunLayout
): DependencyGateDecision {
  const blockedBy = node.depends_on.filter((dependency) => {
    const status = state.nodes[dependency]?.status;
    return status !== "succeeded" && status !== "reused-from-prior-run";
  });
  if (blockedBy.length === 0) {
    if (layout !== undefined) {
      const causallyInvalid = node.depends_on.filter((dependency) => {
        if (state.nodes[dependency]?.status !== "reused-from-prior-run") {
          return false;
        }
        try {
          return !verifyArtifactManifestPrerequisites(layout, dependency).ok;
        } catch {
          return true;
        }
      });
      if (causallyInvalid.length > 0) {
        return {
          ok: false,
          reason_code: "CAUSAL_MANIFEST_MISMATCH",
          reason: `node ${node.id} cannot reuse descendants after a prerequisite manifest changed`,
          blocked_by: causallyInvalid
        };
      }
    }
    return { ok: true };
  }
  return {
    ok: false,
    reason_code: "DEPENDENCY_NOT_SATISFIED",
    reason: `node ${node.id} cannot run until dependencies succeed or are compatibly reused`,
    blocked_by: blockedBy
  };
}

export function verifyRequiredArtifactsForNode(layout: RunLayout, node: PlannedGraphNode): RequiredArtifactGate {
  return verifyRequiredArtifactsForAttempt(layout, node, node.id);
}

export function verifyRequiredArtifactsForAttempt(
  layout: RunLayout,
  node: PlannedGraphNode,
  attemptId: string
): RequiredArtifactGate {
  const diagnostics: RuntimeDiagnostic[] = [];
  const missing: string[] = [];
  let artifactDir: string;
  try {
    artifactDir = getNodeArtifactDir(layout, attemptId);
  } catch (error) {
    diagnostics.push(diagnosticFromError(error, "artifact-gates", "ARTIFACT_DIR_INVALID"));
    return { ok: false, diagnostics, missing };
  }

  for (const output of node.outputs) {
    const required = output.path;
    try {
      const absolutePath = safeResolveInside(artifactDir, required, "required artifact");
      if (!fs.existsSync(absolutePath)) {
        missing.push(required);
        diagnostics.push({
          code: "REQUIRED_ARTIFACT_MISSING",
          message: `required artifact ${required} was not produced by ${attemptId}`,
          severity: "error",
          source: "artifact-gates",
          path: path.posix.join("artifacts", attemptId, required)
        });
      } else {
        assertRegularFileInside(artifactDir, absolutePath, "required artifact");
        const requiredStat = fs.lstatSync(absolutePath);
        if (!requiredStat.isFile() || requiredStat.isSymbolicLink()) {
          throw new Error(`required artifact ${required} must be a regular file`);
        }
        diagnostics.push(...verifyRequiredArtifactShape(artifactDir, absolutePath, output));
      }
    } catch (error) {
      diagnostics.push(diagnosticFromError(error, "artifact-gates", "REQUIRED_ARTIFACT_INVALID"));
    }
  }
  diagnostics.push(...verifySeverityMatrixArtifacts(artifactDir, node));
  try {
    diagnostics.push(...verifyPropertyProvenanceArtifacts(layout, artifactDir, node));
  } catch (error) {
    diagnostics.push(diagnosticFromError(error, "property-provenance", "PROPERTY_PROVENANCE_READ_FAILED"));
  }

  return {
    ok: diagnostics.length === 0,
    diagnostics,
    missing
  };
}

function verifyRequiredArtifactShape(
  artifactDir: string,
  absolutePath: string,
  output: PlannedGraphNode["outputs"][number]
): RuntimeDiagnostic[] {
  const contract = validateArtifactContract(output.contract, fs.readFileSync(absolutePath, "utf8"), absolutePath);
  const diagnostics: RuntimeDiagnostic[] = contract.issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    severity: "error",
    source: "artifact-contracts",
    path: issue.path,
    details: { contract: output.contract, contract_digest: output.contract_digest }
  }));
  if (!contract.ok || output.contract !== "ultrafuzz/generated-tests@1") {
    return diagnostics;
  }

  const parsed = validateGeneratedTestManifestSchema(readJsonFile(absolutePath));
  if (!parsed.ok || parsed.value === undefined) {
    return parsed.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      severity: "error",
      source: "generated-tests",
      path: `${absolutePath}#${issue.path}`
    }));
  }

  for (const [index, entry] of parsed.value.generated_tests.entries()) {
    try {
      const generatedPath = safeResolveInside(artifactDir, entry.path, "generated test manifest entry");
      if (!fs.existsSync(generatedPath)) {
        diagnostics.push({
          code: "GENERATED_TEST_FILE_MISSING",
          message: `generated test manifest entry ${entry.path} was not produced`,
          severity: "error",
          source: "generated-tests",
          path: `${absolutePath}#$.generated_tests[${index}].path`
        });
      } else {
        assertRegularFileInside(artifactDir, generatedPath, "generated test manifest entry");
        const generatedStat = fs.lstatSync(generatedPath);
        if (!generatedStat.isFile() || generatedStat.isSymbolicLink()) {
          throw new Error(`generated test manifest entry ${entry.path} must be a regular file`);
        }
        if (generatedStat.size === 0) {
          diagnostics.push({
            code: "GENERATED_TEST_FILE_EMPTY",
            message: `generated test manifest entry ${entry.path} is empty`,
            severity: "error",
            source: "generated-tests",
            path: `${absolutePath}#$.generated_tests[${index}].path`
          });
        }
      }
    } catch (error) {
      diagnostics.push(diagnosticFromError(error, "generated-tests", "GENERATED_TEST_FILE_INVALID"));
    }
  }

  return diagnostics;
}

function verifySeverityMatrixArtifacts(artifactDir: string, node: PlannedGraphNode): RuntimeDiagnostic[] {
  const artifact = severityArtifactForNode(node);
  if (artifact === undefined) {
    return [];
  }
  const artifactPath = path.join(artifactDir, artifact.file);
  if (!fs.existsSync(artifactPath)) {
    return [];
  }
  try {
    return validateSeverityMatrixArtifact({
      artifact: readJsonFile(artifactPath),
      artifactPath,
      kind: artifact.kind
    });
  } catch (error) {
    return [diagnosticFromError(error, "severity-matrix", "SEVERITY_ARTIFACT_READ_FAILED")];
  }
}

function severityArtifactForNode(
  node: PlannedGraphNode
): { kind: SeverityArtifactKind; file: "severity-classified-findings.json" | "report.json" } | undefined {
  const logicalId = node.logical_id ?? node.id;
  if (logicalId === "severity-classification") {
    return { kind: "severity-classification", file: "severity-classified-findings.json" };
  }
  if (logicalId === "final-report") {
    return { kind: "final-report", file: "report.json" };
  }
  return undefined;
}

function verifyPropertyProvenanceArtifacts(
  layout: RunLayout,
  artifactDir: string,
  node: PlannedGraphNode
): RuntimeDiagnostic[] {
  const logicalId = node.logical_id ?? node.id;
  if (logicalId === "final-report") {
    return verifyFinalReportPropertyReferences(layout, artifactDir);
  }
  if (logicalId !== "stateful-invariant-implement-properties" && logicalId !== "stateful-invariant-recon-campaign") {
    return [];
  }

  const catalog = readCanonicalPropertyCatalog(layout);
  if (catalog.diagnostics.length > 0 || catalog.value === undefined) {
    return catalog.diagnostics;
  }

  if (logicalId === "stateful-invariant-implement-properties") {
    const implementationPath = path.join(artifactDir, "implemented-properties.json");
    if (!fs.existsSync(implementationPath)) {
      return [];
    }
    const implementation = validateImplementedPropertiesSchema(readJsonFile(implementationPath), implementationPath);
    if (!implementation.ok || implementation.value === undefined) {
      return [];
    }
    const references: PropertyReferenceInput[] = implementation.value.properties.map((record, index) => ({
      propertyIds: [record.property_id],
      path: `${implementationPath}#$.properties[${index}].property_id`
    }));
    const findingsPath = path.join(artifactDir, "findings.json");
    if (fs.existsSync(findingsPath)) {
      references.push(...findingPropertyReferences(readJsonFile(findingsPath), findingsPath));
    }
    return propertyReferenceDiagnostics(catalog.value, references);
  }

  return verifyCampaignPropertyReferences(layout, artifactDir, catalog.value);
}

function verifyCampaignPropertyReferences(
  layout: RunLayout,
  artifactDir: string,
  catalog: PropertiesArtifact
): RuntimeDiagnostic[] {
  const implementation = readImplementedProperties(layout);
  if (implementation.diagnostics.length > 0 || implementation.value === undefined) {
    return implementation.diagnostics;
  }

  const campaignPath = path.join(artifactDir, "recon-fuzzer-results.json");
  const findingsPath = path.join(artifactDir, "findings.json");
  if (!fs.existsSync(campaignPath) || !fs.existsSync(findingsPath)) {
    return [];
  }
  const campaign = validatePropertyCampaignSchema(readJsonFile(campaignPath), campaignPath);
  if (!campaign.ok || campaign.value === undefined) {
    return [];
  }
  const findings = validateFindingsSchema(readJsonFile(findingsPath), findingsPath);
  if (!findings.ok || findings.value === undefined) {
    return [];
  }

  const references: PropertyReferenceInput[] = campaign.value.failures.flatMap((failure, index) =>
    failure.property_ids === undefined
      ? []
      : failure.property_ids.map((propertyId, propertyIndex) => ({
          propertyIds: [propertyId],
          path: `${campaignPath}#$.failures[${index}].property_ids[${propertyIndex}]`
        }))
  );
  references.push(...findingPropertyReferences(findings.value, findingsPath));

  const diagnostics = [
    ...propertyReferenceDiagnostics(catalog, references),
    ...campaignFindingReferenceDiagnostics(campaign.value.failures, findings.value, campaignPath, findingsPath)
  ];
  const implementedIds = new Set(
    implementation.value.properties
      .filter((record) => record.status === "implemented")
      .map((record) => record.property_id)
  );
  for (const reference of references) {
    for (const propertyId of reference.propertyIds) {
      if (catalog.properties.some((property) => property.id === propertyId) && !implementedIds.has(propertyId)) {
        diagnostics.push({
          code: "PROPERTY_IMPLEMENTATION_REFERENCE_INVALID",
          message: `Canonical property ${JSON.stringify(propertyId)} was not recorded with implemented status`,
          severity: "error",
          source: "property-provenance",
          path: reference.path
        });
      }
    }
  }
  return diagnostics;
}

function verifyFinalReportPropertyReferences(layout: RunLayout, artifactDir: string): RuntimeDiagnostic[] {
  const reportPath = path.join(artifactDir, "report.json");
  if (!fs.existsSync(reportPath)) {
    return [];
  }
  const report = readJsonFile(reportPath);
  if (!isRecord(report) || !Array.isArray(report.property_provenance)) {
    return [];
  }

  const catalog = readCanonicalPropertyCatalog(layout);
  if (catalog.diagnostics.length > 0 || catalog.value === undefined) {
    return catalog.diagnostics;
  }
  const references = report.property_provenance.flatMap((entry, entryIndex) => {
    if (!isRecord(entry) || !Array.isArray(entry.property_ids)) {
      return [];
    }
    return entry.property_ids.flatMap((propertyId, propertyIndex) =>
      typeof propertyId === "string"
        ? [
            {
              propertyIds: [propertyId],
              path: `${reportPath}#$.property_provenance[${entryIndex}].property_ids[${propertyIndex}]`
            }
          ]
        : []
    );
  });
  const diagnostics = propertyReferenceDiagnostics(catalog.value, references);
  if (report.property_provenance.length === 0) {
    return diagnostics;
  }

  const implementation = readImplementedProperties(layout);
  if (implementation.diagnostics.length > 0 || implementation.value === undefined) {
    return [...diagnostics, ...implementation.diagnostics];
  }
  diagnostics.push(
    ...reportPropertyJoinDiagnostics(
      report.property_provenance,
      catalog.value,
      implementation.value,
      readCampaignFuzzerBackend(layout),
      reportPath
    )
  );
  return diagnostics;
}

function reportPropertyJoinDiagnostics(
  entries: unknown[],
  catalog: PropertiesArtifact,
  implementation: ImplementedPropertiesArtifact,
  fuzzerBackend: string | undefined,
  reportPath: string
): RuntimeDiagnostic[] {
  const catalogById = new Map(catalog.properties.map((property) => [property.id, property]));
  const implementationById = new Map(implementation.properties.map((property) => [property.property_id, property]));
  const diagnostics: RuntimeDiagnostic[] = [];

  for (const [entryIndex, entry] of entries.entries()) {
    if (!isRecord(entry) || !Array.isArray(entry.property_ids)) {
      continue;
    }
    const propertyIds = stringArray(entry.property_ids);
    if (propertyIds.some((propertyId) => !catalogById.has(propertyId))) {
      continue;
    }

    const implementations = propertyIds.flatMap((propertyId) => {
      const record = implementationById.get(propertyId);
      if (record === undefined) {
        diagnostics.push({
          code: "PROPERTY_REPORT_IMPLEMENTATION_MISSING",
          message: `Report provenance references property ${JSON.stringify(propertyId)} without an implementation record`,
          severity: "error",
          source: "property-provenance",
          path: `${reportPath}#$.property_provenance[${entryIndex}].property_ids`
        });
        return [];
      }
      return [record];
    });
    if (implementations.length !== propertyIds.length) {
      continue;
    }

    const expectedSources = propertyIds.flatMap(
      (propertyId) => catalogById.get(propertyId)?.sources.map(propertySourceKey) ?? []
    );
    const actualSources = Array.isArray(entry.sources)
      ? entry.sources.flatMap((source) => (isRecord(source) ? [propertySourceKey(source)] : []))
      : [];
    addReportJoinMismatch(
      diagnostics,
      sameStringSet(expectedSources, actualSources),
      "PROPERTY_REPORT_SOURCES_MISMATCH",
      "Report property sources do not match the canonical catalog",
      `${reportPath}#$.property_provenance[${entryIndex}].sources`
    );

    addReportJoinMismatch(
      diagnostics,
      sameStringSet(
        implementations.flatMap((record) => record.implementation_paths),
        stringArray(entry.implementation_paths)
      ),
      "PROPERTY_REPORT_IMPLEMENTATION_PATHS_MISMATCH",
      "Report implementation paths do not match the implementation records",
      `${reportPath}#$.property_provenance[${entryIndex}].implementation_paths`
    );

    addReportJoinMismatch(
      diagnostics,
      sameStringSet(
        implementations.flatMap((record) => record.test_paths),
        stringArray(entry.test_paths)
      ),
      "PROPERTY_REPORT_TEST_PATHS_MISMATCH",
      "Report test paths do not match the implementation records",
      `${reportPath}#$.property_provenance[${entryIndex}].test_paths`
    );

    addReportJoinMismatch(
      diagnostics,
      entry.fuzzer_backend === fuzzerBackend,
      "PROPERTY_REPORT_FUZZER_BACKEND_MISMATCH",
      "Report fuzzer backend does not match the campaign record",
      `${reportPath}#$.property_provenance[${entryIndex}].fuzzer_backend`
    );
  }
  return diagnostics;
}

function readCampaignFuzzerBackend(layout: RunLayout): string | undefined {
  const campaignPath = findLogicalNodeArtifact(
    layout,
    "stateful-invariant-recon-campaign",
    "recon-fuzzer-results.json"
  );
  if (campaignPath === undefined) {
    return undefined;
  }
  const result = validatePropertyCampaignSchema(readJsonFile(campaignPath), campaignPath);
  return result.value?.fuzzer_backend;
}

function propertySourceKey(source: { source_node_id?: unknown; source_property_id?: unknown }): string {
  return `${String(source.source_node_id)}\u0000${String(source.source_property_id)}`;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function addReportJoinMismatch(
  diagnostics: RuntimeDiagnostic[],
  matches: boolean,
  code: string,
  message: string,
  issuePath: string
): void {
  if (!matches) {
    diagnostics.push({
      code,
      message,
      severity: "error",
      source: "property-provenance",
      path: issuePath
    });
  }
}

function campaignFindingReferenceDiagnostics(
  failures: Array<{ id: string; property_ids?: string[] }>,
  findings: Array<Record<string, unknown>>,
  campaignPath: string,
  findingsPath: string
): RuntimeDiagnostic[] {
  const findingsById = new Map<string, Array<{ index: number; propertyIds: string[] }>>();
  for (const [findingIndex, finding] of findings.entries()) {
    if (typeof finding.id !== "string") {
      continue;
    }
    const propertyIds = Array.isArray(finding.property_ids)
      ? finding.property_ids.filter((propertyId): propertyId is string => typeof propertyId === "string")
      : [];
    const matches = findingsById.get(finding.id) ?? [];
    matches.push({ index: findingIndex, propertyIds });
    findingsById.set(finding.id, matches);
  }

  const diagnostics: RuntimeDiagnostic[] = [];
  const failureIds = new Set<string>();
  for (const [failureIndex, failure] of failures.entries()) {
    failureIds.add(failure.id);
    const failurePropertyIds = failure.property_ids ?? [];
    const matchingFindings = findingsById.get(failure.id) ?? [];
    if (
      matchingFindings.length > 1 &&
      (failurePropertyIds.length > 0 || matchingFindings.some((finding) => finding.propertyIds.length > 0))
    ) {
      diagnostics.push({
        code: "PROPERTY_FINDING_REFERENCE_AMBIGUOUS",
        message: `Property-derived campaign failure ${JSON.stringify(failure.id)} has multiple resulting findings`,
        severity: "error",
        source: "property-provenance",
        path: `${campaignPath}#$.failures[${failureIndex}].id`
      });
      continue;
    }
    const matchingFinding = matchingFindings[0];
    if (failurePropertyIds.length > 0 && matchingFinding === undefined) {
      diagnostics.push({
        code: "PROPERTY_FINDING_REFERENCE_MISSING",
        message: `Property-derived campaign failure ${JSON.stringify(failure.id)} has no resulting finding with the same ID`,
        severity: "error",
        source: "property-provenance",
        path: `${campaignPath}#$.failures[${failureIndex}].id`
      });
      continue;
    }
    if (matchingFinding !== undefined && !sameStringSet(failurePropertyIds, matchingFinding.propertyIds)) {
      diagnostics.push({
        code: "PROPERTY_FINDING_REFERENCE_MISMATCH",
        message: `Campaign failure ${JSON.stringify(failure.id)} and its resulting finding must carry the same property_ids`,
        severity: "error",
        source: "property-provenance",
        path: `${findingsPath}#$[${matchingFinding.index}].property_ids`
      });
    }
  }

  for (const [findingId, matchingFindings] of findingsById) {
    if (failureIds.has(findingId)) {
      continue;
    }
    for (const finding of matchingFindings) {
      if (finding.propertyIds.length === 0) {
        continue;
      }
      diagnostics.push({
        code: "PROPERTY_CAMPAIGN_REFERENCE_MISSING",
        message: `Property-derived finding ${JSON.stringify(findingId)} has no campaign failure with the same ID`,
        severity: "error",
        source: "property-provenance",
        path: `${findingsPath}#$[${finding.index}].id`
      });
    }
  }
  return diagnostics;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const rightSet = new Set(right);
  return new Set(left).size === rightSet.size && left.every((value) => rightSet.has(value));
}

function readCanonicalPropertyCatalog(layout: RunLayout): {
  value?: PropertiesArtifact;
  diagnostics: RuntimeDiagnostic[];
} {
  const catalogPath = findLogicalNodeArtifact(layout, "property-specification-fanin", "properties.json");
  if (catalogPath === undefined) {
    return {
      diagnostics: [
        {
          code: "PROPERTY_CATALOG_MISSING",
          message: "Canonical property provenance catalog properties.json is unavailable",
          severity: "error",
          source: "property-provenance"
        }
      ]
    };
  }
  const result = validatePropertiesSchema(readJsonFile(catalogPath), catalogPath);
  return result.ok && result.value !== undefined
    ? { value: result.value, diagnostics: [] }
    : { diagnostics: schemaDiagnostics(result.issues) };
}

function readImplementedProperties(layout: RunLayout): {
  value?: ImplementedPropertiesArtifact;
  diagnostics: RuntimeDiagnostic[];
} {
  const implementationPath = findLogicalNodeArtifact(
    layout,
    "stateful-invariant-implement-properties",
    "implemented-properties.json"
  );
  if (implementationPath === undefined) {
    return {
      diagnostics: [
        {
          code: "IMPLEMENTED_PROPERTIES_MISSING",
          message: "Implemented property provenance artifact implemented-properties.json is unavailable",
          severity: "error",
          source: "property-provenance"
        }
      ]
    };
  }
  const result = validateImplementedPropertiesSchema(readJsonFile(implementationPath), implementationPath);
  return result.ok && result.value !== undefined
    ? { value: result.value, diagnostics: [] }
    : { diagnostics: schemaDiagnostics(result.issues) };
}

function findLogicalNodeArtifact(layout: RunLayout, logicalNodeId: string, fileName: string): string | undefined {
  const state = readRunState(layout);
  const candidateIds = new Set([logicalNodeId]);
  for (const [nodeId, nodeState] of Object.entries(state.nodes)) {
    if (nodeState.logical_node_id === logicalNodeId) {
      candidateIds.add(nodeId);
    }
  }
  for (const nodeId of candidateIds) {
    const candidate = path.join(getNodeArtifactDir(layout, nodeId), fileName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function findingPropertyReferences(value: unknown, artifactPath: string): PropertyReferenceInput[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((finding, findingIndex) => {
    if (typeof finding !== "object" || finding === null || !("property_ids" in finding)) {
      return [];
    }
    const propertyIds = (finding as { property_ids?: unknown }).property_ids;
    if (!Array.isArray(propertyIds)) {
      return [];
    }
    return propertyIds.flatMap((propertyId, propertyIndex) =>
      typeof propertyId === "string"
        ? [
            {
              propertyIds: [propertyId],
              path: `${artifactPath}#$[${findingIndex}].property_ids[${propertyIndex}]`
            }
          ]
        : []
    );
  });
}

function propertyReferenceDiagnostics(
  catalog: PropertiesArtifact,
  references: readonly PropertyReferenceInput[]
): RuntimeDiagnostic[] {
  return schemaDiagnostics(validatePropertyReferences(catalog, references));
}

function schemaDiagnostics(issues: Array<{ code: string; message: string; path: string }>): RuntimeDiagnostic[] {
  return issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    severity: "error",
    source: "property-provenance",
    path: issue.path
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function markNodeBlockedByDependencies(
  layout: RunLayout,
  node: PlannedGraphNode,
  decision: DependencyGateDecision
): RunState {
  return updateNodeState(layout, node.id, {
    status: "skipped",
    finished_at: new Date().toISOString(),
    last_error: decision.reason ?? "dependency gate blocked node",
    provenance: {
      reason_code: decision.reason_code ?? "DEPENDENCY_NOT_SATISFIED",
      blocked_by: decision.blocked_by ?? []
    }
  });
}

export function invalidateDownstreamOfFailedRequiredNodes(layout: RunLayout, graph: PlannedGraph): RunState {
  let state = readRunState(layout);
  for (const node of graph.nodes) {
    if (state.nodes[node.id]?.status !== "pending") {
      continue;
    }
    const failedDependencies = node.depends_on.filter((dependency) =>
      ["failed", "timed-out", "canceled", "invalidated", "skipped"].includes(state.nodes[dependency]?.status ?? "")
    );
    if (failedDependencies.length > 0) {
      state = markNodeBlockedByDependencies(layout, node, {
        ok: false,
        reason_code: "DEPENDENCY_NOT_SATISFIED",
        reason: `node ${node.id} cannot run until dependencies succeed or are compatibly reused`,
        blocked_by: failedDependencies
      });
    }
  }
  return state;
}
