import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  assertRegularFileInside,
  getNodeArtifactDir,
  readArtifactManifest,
  readJsonFile,
  readRunState,
  redactValue,
  safeResolveInside,
  sha256Bytes,
  updateNodeState,
  validateArtifactContract,
  validateFindingsSchema,
  validateGeneratedTestManifestSchema,
  validateInvariantLedgerSchema,
  validateInvariantSourceProofSchema,
  validateImplementedPropertiesSchema,
  validateLensPropertiesSchema,
  validateReferenceExpectationsSchema,
  validatePropertiesSchema,
  validatePropertyCampaignSchema,
  validatePropertyReferences,
  verifyArtifactManifestPrerequisites,
  writeJsonDurable,
  type ImplementedPropertiesArtifact,
  type InvariantLedgerEntry,
  type InvariantSourceProof,
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
    diagnostics.push(...verifyInvariantEvidenceArtifacts(layout, artifactDir, node));
  } catch (error) {
    diagnostics.push(diagnosticFromError(error, "invariant-ledger", "INVARIANT_EVIDENCE_READ_FAILED"));
  }
  try {
    diagnostics.push(...sanitizeLensReferenceExpectationAuthority(layout, artifactDir, node, attemptId));
  } catch (error) {
    diagnostics.push(
      diagnosticFromError(error, "property-provenance", "PROPERTY_REFERENCE_EXPECTATION_SANITIZE_FAILED")
    );
  }
  try {
    diagnostics.push(...verifyPropertyProvenanceArtifacts(layout, artifactDir, node));
  } catch (error) {
    diagnostics.push(diagnosticFromError(error, "property-provenance", "PROPERTY_PROVENANCE_READ_FAILED"));
  }

  return {
    ok: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
    diagnostics,
    missing
  };
}

/**
 * Enforce the cross-artifact joins that cannot be expressed by an individual
 * JSON schema: discovery's source evidence must survive into the Markdown
 * handoff, and every discovered source statement must reach at least one
 * canonical property before invariant implementation begins.
 */
function verifyInvariantEvidenceArtifacts(
  layout: RunLayout,
  artifactDir: string,
  node: PlannedGraphNode
): RuntimeDiagnostic[] {
  const logicalId = node.logical_id ?? node.id;
  const diagnostics: RuntimeDiagnostic[] = [];
  if (
    logicalId === "project-discovery" &&
    node.outputs.some((output) => output.path === "setup/invariant-evidence-ledger.json")
  ) {
    const ledgerPath = path.join(artifactDir, "setup", "invariant-evidence-ledger.json");
    const markdownPath = path.join(artifactDir, "setup", "project-discovery.md");
    if (!fs.existsSync(ledgerPath) || !fs.existsSync(markdownPath)) {
      return diagnostics;
    }
    const parsed = validateInvariantLedgerSchema(readJsonFile(ledgerPath), ledgerPath);
    if (!parsed.ok || parsed.value === undefined) {
      return diagnostics;
    }
    if (parsed.value.entries.length === 0 && (parsed.value.scan_probes?.length ?? 0) > 0) {
      verifyNoInvariantsJustification(parsed.value.no_invariants_justification, ledgerPath, diagnostics);
      if (parsed.value.inventory_rows === undefined) {
        diagnostics.push({
          code: "INVARIANT_LEDGER_INVENTORY_MISSING",
          message: "An explicit no-evidence ledger must include an empty inventory_rows array",
          severity: "error",
          source: "invariant-ledger",
          path: `${ledgerPath}#$.inventory_rows`
        });
      } else if (parsed.value.inventory_rows.length > 0) {
        diagnostics.push({
          code: "INVARIANT_LEDGER_INVENTORY_UNEXPECTED",
          message: "An explicit no-evidence ledger must not contain inventory rows",
          severity: "error",
          source: "invariant-ledger",
          path: `${ledgerPath}#$.inventory_rows`
        });
      }
      const discoveryWorkspace = path.join(layout.workspacesDir, path.basename(artifactDir));
      const sourceProofPath = invariantSourceProofPath(layout.root, path.basename(artifactDir));
      if (fs.existsSync(sourceProofPath)) {
        readInvariantSourceProof(sourceProofPath, ledgerPath, diagnostics);
      } else if (!fs.existsSync(discoveryWorkspace)) {
        diagnostics.push({
          code: "INVARIANT_LEDGER_SOURCE_PROOF_MISSING",
          message: "Invariant ledger source proof and discovery workspace are unavailable",
          severity: "error",
          source: "invariant-ledger",
          path: ledgerPath
        });
      }
      // DECISION (issue #292), not a fact about probes: a probe path that names nothing is still
      // accepted, because a probe records WHERE the agent looked and an optional file it did not
      // find is a legitimate record. Containment stays the only property enforced here — probe
      // `result` text has zero consumers, so it cannot be checked against anything. What the
      // decision changed is the weight put on that text: it is no longer allowed to stand in for
      // the claim "this target has no invariant". That claim now needs
      // `no_invariants_justification` above.
      for (const [probeIndex, probe] of (parsed.value.scan_probes ?? []).entries()) {
        verifyInvariantProbePath(discoveryWorkspace, probe.source_path, probeIndex, ledgerPath, diagnostics);
      }
      return diagnostics;
    }
    if (parsed.value.entries.length === 0) {
      diagnostics.push({
        code: "INVARIANT_LEDGER_EMPTY",
        message: "Project discovery invariant evidence ledger must contain at least one source entry",
        severity: "error",
        source: "invariant-ledger",
        path: `${ledgerPath}#$.entries`
      });
      return diagnostics;
    }
    if (parsed.value.inventory_rows === undefined) {
      diagnostics.push({
        code: "INVARIANT_LEDGER_INVENTORY_MISSING",
        message: "Project discovery invariant evidence ledger is missing structured inventory rows",
        severity: "error",
        source: "invariant-ledger",
        path: `${ledgerPath}#$.inventory_rows`
      });
      return diagnostics;
    }
    if (parsed.value.scan_probes === undefined) {
      diagnostics.push({
        code: "INVARIANT_LEDGER_PROBES_MISSING",
        message: "Project discovery invariant evidence ledger is missing scan probe results",
        severity: "error",
        source: "invariant-ledger",
        path: `${ledgerPath}#$.scan_probes`
      });
    }
    const discoveryWorkspace = path.join(layout.workspacesDir, path.basename(artifactDir));
    const sourceProofPath = invariantSourceProofPath(layout.root, path.basename(artifactDir));
    const sourceProofPresent = fs.existsSync(sourceProofPath);
    const sourceProof = sourceProofPresent
      ? readInvariantSourceProof(sourceProofPath, ledgerPath, diagnostics)
      : undefined;
    if (!sourceProofPresent && !fs.existsSync(discoveryWorkspace)) {
      diagnostics.push({
        code: "INVARIANT_LEDGER_SOURCE_PROOF_MISSING",
        message: "Invariant ledger source proof and discovery workspace are unavailable",
        severity: "error",
        source: "invariant-ledger",
        path: ledgerPath
      });
    }
    // Same DECISION as the no-evidence branch above (issue #292): an absent probe path is accepted
    // because a probe records where the agent looked, and containment is the only property that can
    // be enforced when nothing consumes `result`. On this branch the ledger carries entries, and
    // those remain byte-checked against the pinned source below.
    for (const [probeIndex, probe] of (parsed.value.scan_probes ?? []).entries()) {
      verifyInvariantProbePath(discoveryWorkspace, probe.source_path, probeIndex, ledgerPath, diagnostics);
    }
    const markdown = fs.readFileSync(markdownPath, "utf8");
    for (const [entryIndex, entry] of parsed.value.entries.entries()) {
      if (sourceProof !== undefined) {
        verifyInvariantSourceProofEvidence(sourceProof, entry, entryIndex, ledgerPath, diagnostics);
      } else if (!sourceProofPresent && fs.existsSync(discoveryWorkspace)) {
        verifyInvariantSourceEvidence(discoveryWorkspace, entry, entryIndex, ledgerPath, diagnostics);
      }
      const block = markdownDelimitedBlock(markdown, `### Ledger entry: ${entry.id}`, [
        entry.id,
        entry.source_path,
        entry.source_location,
        entry.verbatim,
        ...entry.inventory_ids
      ]);
      if (block === undefined) {
        diagnostics.push({
          code: "INVARIANT_LEDGER_MARKDOWN_EVIDENCE_MISSING",
          message: `Discovery Markdown is missing the delimited block for ledger entry ${JSON.stringify(entry.id)}`,
          severity: "error",
          source: "invariant-ledger",
          path: `${markdownPath}#$.entries[${entryIndex}]`
        });
        continue;
      }
      const evidence = [entry.id, entry.source_path, entry.source_location, entry.verbatim, ...entry.inventory_ids];
      for (const token of evidence) {
        if (markdownContainsToken(block, token)) {
          continue;
        }
        diagnostics.push({
          code: "INVARIANT_LEDGER_MARKDOWN_EVIDENCE_MISSING",
          message: `Discovery Markdown must preserve ledger entry ${JSON.stringify(entry.id)} token ${JSON.stringify(token)}`,
          severity: "error",
          source: "invariant-ledger",
          path: `${markdownPath}#$.entries[${entryIndex}]`
        });
      }
      for (const inventoryId of entry.inventory_ids) {
        const row = parsed.value.inventory_rows.find((candidate) => candidate.id === inventoryId);
        const rowBlock =
          row === undefined
            ? undefined
            : markdownDelimitedBlock(markdown, `### Inventory row: ${inventoryId}`, [
                inventoryId,
                row.description,
                ...row.ledger_ids
              ]);
        if (row === undefined || rowBlock === undefined || !markdownContainsToken(rowBlock, row.description)) {
          diagnostics.push({
            code: "INVARIANT_LEDGER_MARKDOWN_INVENTORY_MISSING",
            message: `Discovery Markdown is missing normalized inventory row ${JSON.stringify(inventoryId)}`,
            severity: "error",
            source: "invariant-ledger",
            path: `${markdownPath}#$.entries[${entryIndex}].inventory_ids`
          });
          continue;
        }
        for (const ledgerId of row.ledger_ids) {
          if (!markdownContainsToken(rowBlock, ledgerId)) {
            diagnostics.push({
              code: "INVARIANT_LEDGER_MARKDOWN_INVENTORY_MISSING",
              message: `Inventory row ${JSON.stringify(inventoryId)} is missing ledger ID ${JSON.stringify(ledgerId)}`,
              severity: "error",
              source: "invariant-ledger",
              path: `${markdownPath}#$.entries[${entryIndex}].inventory_ids`
            });
          }
        }
      }
    }
    return diagnostics;
  }

  if (
    logicalId !== "property-specification-fanin" ||
    !node.outputs.some((output) => output.path === "properties.json")
  ) {
    return diagnostics;
  }

  const ledgerPath = findLogicalNodeArtifact(layout, "project-discovery", "setup/invariant-evidence-ledger.json");
  const catalogPath = path.join(artifactDir, "properties.json");
  if (ledgerPath === undefined) {
    diagnostics.push({
      code: "INVARIANT_LEDGER_MISSING",
      message: "Project discovery invariant evidence ledger is unavailable for property fan-in",
      severity: "error",
      source: "invariant-ledger",
      path: catalogPath
    });
    return diagnostics;
  }
  if (!fs.existsSync(catalogPath)) {
    return diagnostics;
  }
  const ledger = validateInvariantLedgerSchema(readJsonFile(ledgerPath), ledgerPath);
  const catalog = validatePropertiesSchema(readJsonFile(catalogPath), catalogPath);
  if (!ledger.ok || ledger.value === undefined || !catalog.ok || catalog.value === undefined) {
    return diagnostics;
  }
  diagnostics.push(...verifyLensReferenceExpectationPreservation(layout, node, catalog.value));
  // Fan-in re-checks probe containment on the SAME ledger discovery published (issue #292). It used
  // to check none: every shape of the ledger returned before reaching a `verifyInvariantProbePath`
  // call, so an escaping probe path only ever had to survive the discovery node. The ledger lives in
  // discovery's artifact directory, so its workspace is the one the probes are relative to; when
  // that workspace has already been reclaimed the check is a no-op, exactly as it is on discovery.
  const discoveryWorkspace = path.join(layout.workspacesDir, path.basename(path.dirname(path.dirname(ledgerPath))));
  for (const [probeIndex, probe] of (ledger.value.scan_probes ?? []).entries()) {
    verifyInvariantProbePath(discoveryWorkspace, probe.source_path, probeIndex, ledgerPath, diagnostics);
  }
  if (ledger.value.entries.length === 0 && (ledger.value.scan_probes?.length ?? 0) > 0) {
    verifyNoInvariantsJustification(ledger.value.no_invariants_justification, ledgerPath, diagnostics);
    if (ledger.value.inventory_rows === undefined || ledger.value.inventory_rows.length > 0) {
      diagnostics.push({
        code: "INVARIANT_LEDGER_INVENTORY_UNEXPECTED",
        message: "An explicit no-evidence ledger must include an empty inventory_rows array",
        severity: "error",
        source: "invariant-ledger",
        path: `${ledgerPath}#$.inventory_rows`
      });
    }
    for (const [propertyIndex, property] of catalog.value.properties.entries()) {
      for (const [ledgerIndex, ledgerId] of (property.ledger_ids ?? []).entries()) {
        diagnostics.push({
          code: "INVARIANT_LEDGER_REFERENCE_UNKNOWN",
          message: `Canonical property ${JSON.stringify(property.id)} references ledger ID ${JSON.stringify(ledgerId)} but discovery recorded no invariant entries`,
          severity: "error",
          source: "invariant-ledger",
          path: `${catalogPath}#$.properties[${propertyIndex}].ledger_ids[${ledgerIndex}]`
        });
      }
    }
    return diagnostics;
  }
  if (ledger.value.entries.length === 0 || ledger.value.inventory_rows === undefined) {
    diagnostics.push({
      code: "INVARIANT_LEDGER_INCOMPLETE",
      message: "Property fan-in requires a non-empty invariant ledger with structured inventory rows",
      severity: "error",
      source: "invariant-ledger",
      path: ledgerPath
    });
    return diagnostics;
  }
  if (ledger.value.scan_probes === undefined) {
    diagnostics.push({
      code: "INVARIANT_LEDGER_PROBES_MISSING",
      message: "Property fan-in requires scan probe results from project discovery",
      severity: "error",
      source: "invariant-ledger",
      path: `${ledgerPath}#$.scan_probes`
    });
  }

  const ledgerIds = new Set(ledger.value.entries.map((entry) => entry.id));
  const referenced = new Set<string>();
  for (const [propertyIndex, property] of catalog.value.properties.entries()) {
    for (const [ledgerIndex, ledgerId] of (property.ledger_ids ?? []).entries()) {
      if (!ledgerIds.has(ledgerId)) {
        diagnostics.push({
          code: "INVARIANT_LEDGER_REFERENCE_UNKNOWN",
          message: `Canonical property ${JSON.stringify(property.id)} references unknown invariant ledger ID ${JSON.stringify(ledgerId)}`,
          severity: "error",
          source: "invariant-ledger",
          path: `${catalogPath}#$.properties[${propertyIndex}].ledger_ids[${ledgerIndex}]`
        });
      } else {
        referenced.add(ledgerId);
      }
    }
  }
  for (const [entryIndex, entry] of ledger.value.entries.entries()) {
    if (referenced.has(entry.id)) {
      continue;
    }
    diagnostics.push({
      code: "INVARIANT_LEDGER_REFERENCE_MISSING",
      message: `Invariant ledger entry ${JSON.stringify(entry.id)} is not mapped to a canonical property`,
      severity: "error",
      source: "invariant-ledger",
      path: `${ledgerPath}#$.entries[${entryIndex}].id`
    });
  }
  if (node.outputs.some((output) => output.path === "properties.md")) {
    const markdownPath = path.join(artifactDir, "properties.md");
    if (fs.existsSync(markdownPath)) {
      const markdown = fs.readFileSync(markdownPath, "utf8");
      const markdownPropertyIds = [...markdown.matchAll(/^### Canonical property:\s*(.+?)\s*$/gmu)].map(
        (match) => match[1] ?? ""
      );
      const catalogPropertyIds = new Set(catalog.value.properties.map((property) => property.id));
      const seenMarkdownPropertyIds = new Set<string>();
      for (const [markdownIndex, propertyId] of markdownPropertyIds.entries()) {
        if (seenMarkdownPropertyIds.has(propertyId)) {
          diagnostics.push({
            code: "PROPERTY_MARKDOWN_CANONICAL_DUPLICATE",
            message: `Properties Markdown contains duplicate canonical property ${JSON.stringify(propertyId)}`,
            severity: "error",
            source: "property-fanin",
            path: `${markdownPath}#canonical-property-${markdownIndex}`
          });
        }
        seenMarkdownPropertyIds.add(propertyId);
        if (!catalogPropertyIds.has(propertyId)) {
          diagnostics.push({
            code: "PROPERTY_MARKDOWN_CANONICAL_UNKNOWN",
            message: `Properties Markdown contains canonical property ${JSON.stringify(propertyId)} absent from properties.json`,
            severity: "error",
            source: "property-fanin",
            path: `${markdownPath}#canonical-property-${markdownIndex}`
          });
        }
      }
      for (const [propertyIndex, property] of catalog.value.properties.entries()) {
        const block = markdownDelimitedBlock(markdown, `### Canonical property: ${property.id}`, [property.id]);
        const propertyFields: Array<[string, string]> = [
          ["description", property.description],
          ["category", property.category],
          ["priority", property.priority]
        ];
        const missingPropertyField = propertyFields.find(
          ([field, value]) => block === undefined || !markdownFieldEqualsValue(block, field, value)
        );
        const markdownIdValues = block === undefined ? [] : markdownFieldValues(block, "id");
        const mismatchedMarkdownId =
          markdownIdValues.length > 0 &&
          (markdownIdValues.length !== 1 ||
            normalizeMarkdownFieldValue(markdownIdValues[0] ?? "") !== normalizeMarkdownFieldValue(property.id));
        const missingSource =
          block === undefined
            ? property.sources[0]
            : property.sources.find(
                (source) =>
                  !markdownFieldContainsAnyValue(
                    block,
                    "sources",
                    sourcePairVariants(source.source_node_id, source.source_property_id)
                  )
              );
        const expectedSourcePairs = property.sources.map((source) =>
          normalizeSourcePair(`${source.source_node_id}:${source.source_property_id}`)
        );
        const renderedSourcePairs =
          block === undefined ? [] : markdownFieldEntries(block, "sources", normalizeSourcePair);
        const ledgerFieldValues = block === undefined ? [] : markdownFieldValues(block, "ledger_ids");
        // Only required when the property actually has ledger IDs to render. Demanding the field
        // unconditionally contradicted both the schema, where `canonical_property.ledger_ids` is
        // `.optional()`, and the fan-in prompt, which asks for it on "every canonical property THAT
        // REPRESENTS one or more ledger entries". R45 and R46 each lost a full fan-in attempt to that
        // (issue #297): R46 emitted 219 properties, 78 with ledger IDs, and rendered the field exactly
        // 78 times — correct by both other definitions, rejected by this one. The parity checks below
        // still enforce everything that matters once a property does have IDs: each must be rendered,
        // the right number of times, with no extras.
        const expectsLedgerField = (property.ledger_ids ?? []).length > 0;
        const missingLedgerField = block !== undefined && expectsLedgerField && ledgerFieldValues.length !== 1;
        const expectedReferenceExpectations = property.reference_expectations ?? [];
        const renderedReferenceExpectations =
          block === undefined ? [] : markdownFieldEntries(block, "reference_expectations", normalizeLedgerId);
        const missingReferenceExpectation = expectedReferenceExpectations.find(
          (expectationId) => !renderedReferenceExpectations.includes(expectationId)
        );
        const extraReferenceExpectation = renderedReferenceExpectations.find(
          (expectationId) =>
            !expectedReferenceExpectations.includes(expectationId) ||
            renderedReferenceExpectations.filter((candidate) => candidate === expectationId).length >
              expectedReferenceExpectations.filter((candidate) => candidate === expectationId).length
        );
        const extraSourcePair = renderedSourcePairs.find(
          (source) =>
            !expectedSourcePairs.includes(source) ||
            renderedSourcePairs.filter((candidate) => candidate === source).length >
              expectedSourcePairs.filter((candidate) => candidate === source).length
        );
        if (
          missingPropertyField !== undefined ||
          mismatchedMarkdownId ||
          missingSource !== undefined ||
          missingLedgerField ||
          missingReferenceExpectation !== undefined
        ) {
          const missingValue =
            missingPropertyField?.[0] ??
            (mismatchedMarkdownId
              ? "id"
              : missingLedgerField
                ? "ledger_ids"
                : missingReferenceExpectation !== undefined
                  ? "reference_expectations"
                  : `${missingSource?.source_node_id}:${missingSource?.source_property_id}`);
          diagnostics.push({
            code: "PROPERTY_MARKDOWN_PARITY_MISSING",
            message: `Properties Markdown must preserve canonical property ${JSON.stringify(property.id)} with its description, category, priority, and sources (missing ${JSON.stringify(missingValue)})`,
            severity: "error",
            source: "property-fanin",
            path: `${markdownPath}#$.properties[${propertyIndex}]`
          });
        }
        if (extraSourcePair !== undefined) {
          diagnostics.push({
            code: "PROPERTY_MARKDOWN_PARITY_EXTRA",
            message: `Properties Markdown must not add an unlisted source pair ${JSON.stringify(extraSourcePair)} to canonical property ${JSON.stringify(property.id)}`,
            severity: "error",
            source: "property-fanin",
            path: `${markdownPath}#$.properties[${propertyIndex}].sources`
          });
        }
        if (extraReferenceExpectation !== undefined) {
          diagnostics.push({
            code: "PROPERTY_MARKDOWN_PARITY_EXTRA",
            message: `Properties Markdown must not add an unlisted reference expectation ${JSON.stringify(extraReferenceExpectation)} to canonical property ${JSON.stringify(property.id)}`,
            severity: "error",
            source: "property-fanin",
            path: `${markdownPath}#$.properties[${propertyIndex}].reference_expectations`
          });
        }
        if (block === undefined) {
          for (const ledgerId of property.ledger_ids ?? []) {
            diagnostics.push({
              code: "INVARIANT_LEDGER_MARKDOWN_MAPPING_MISSING",
              message: `Properties Markdown must preserve canonical property ${JSON.stringify(property.id)} and ledger ID ${JSON.stringify(ledgerId)}`,
              severity: "error",
              source: "invariant-ledger",
              path: `${markdownPath}#$.properties[${propertyIndex}].ledger_ids`
            });
          }
          continue;
        }
        const expectedLedgerIds = new Set(property.ledger_ids ?? []);
        const renderedLedgerIds = markdownFieldEntries(block, "ledger_ids", normalizeLedgerId);
        for (const ledgerId of property.ledger_ids ?? []) {
          if (markdownFieldContainsValue(block, "ledger_ids", ledgerId)) continue;
          diagnostics.push({
            code: "INVARIANT_LEDGER_MARKDOWN_MAPPING_MISSING",
            message: `Properties Markdown must preserve canonical property ${JSON.stringify(property.id)} and ledger ID ${JSON.stringify(ledgerId)}`,
            severity: "error",
            source: "invariant-ledger",
            path: `${markdownPath}#$.properties[${propertyIndex}].ledger_ids`
          });
        }
        for (const ledgerId of renderedLedgerIds) {
          const renderedCount = renderedLedgerIds.filter((candidate) => candidate === ledgerId).length;
          const expectedCount = (property.ledger_ids ?? []).filter((candidate) => candidate === ledgerId).length;
          if (expectedLedgerIds.has(ledgerId) && renderedCount <= expectedCount) continue;
          diagnostics.push({
            code: "INVARIANT_LEDGER_MARKDOWN_MAPPING_EXTRA",
            message: `Properties Markdown must not add an unlisted ledger ID ${JSON.stringify(ledgerId)} to canonical property ${JSON.stringify(property.id)}`,
            severity: "error",
            source: "invariant-ledger",
            path: `${markdownPath}#$.properties[${propertyIndex}].ledger_ids`
          });
        }
      }
    }
  }
  return diagnostics;
}

interface LensReferenceRow {
  concreteNodeId: string;
  sourceNodeId: string;
  propertyId: string;
  expectationIds: string[];
  path: string;
  index: number;
}

function verifyLensReferenceExpectationPreservation(
  layout: RunLayout,
  node: PlannedGraphNode,
  catalog: PropertiesArtifact
): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  const lensRows = new Map<string, LensReferenceRow>();
  const lensPathsByDependency = new Map<string, string>();
  const state = readRunState(layout);
  for (const dependencyId of node.depends_on) {
    const dependency = state.nodes[dependencyId]?.logical_node_id ?? dependencyId;
    if (!dependency.startsWith("property-specification-") || dependency === "property-specification-fanin") continue;
    const lensName = dependency.slice("property-specification-".length);
    // Expanded graphs may give fan-in concrete dependencies such as
    // `property-specification-recon-0` and `property-specification-recon-1`.
    // Resolve each concrete artifact directory first so one loop cannot hide
    // metadata emitted by another; retain the logical lookup for historical
    // runs whose artifacts were written under the unexpanded logical ID.
    const declaredLensPath = state.nodes[dependencyId]?.outputs?.find(
      (output) => output.contract === "ultrafuzz/property-lens@1"
    )?.path;
    const lensRelativePath = declaredLensPath ?? `properties/${lensName}.json`;
    lensPathsByDependency.set(dependencyId, lensRelativePath);
    const lensPath = findDependencyArtifact(layout, dependencyId, dependency, lensRelativePath);
    if (lensPath === undefined) {
      diagnostics.push({
        code: "PROPERTY_LENS_MISSING",
        message: `Property fan-in cannot verify reference expectations because lens artifact for ${JSON.stringify(dependency)} is unavailable`,
        severity: "error",
        source: "property-fanin",
        path: `artifacts/${dependency}/${lensRelativePath}`
      });
      continue;
    }
    const lens = validateLensPropertiesSchema(readJsonFile(lensPath), lensPath);
    if (!lens.ok || lens.value === undefined) {
      diagnostics.push(
        ...lens.issues.map((issue) => ({
          code: issue.code,
          message: issue.message,
          severity: "error" as const,
          source: "property-fanin",
          path: issue.path
        }))
      );
      continue;
    }
    for (const [index, property] of lens.value.properties.entries()) {
      lensRows.set(`${dependencyId}\u0000${property.id}`, {
        concreteNodeId: dependencyId,
        sourceNodeId: dependency,
        propertyId: property.id,
        expectationIds: property.reference_expectations ?? [],
        path: lensPath,
        index
      });
    }
  }

  for (const dependencyId of node.depends_on) {
    const dependency = state.nodes[dependencyId]?.logical_node_id ?? dependencyId;
    if (!dependency.startsWith("property-specification-") || dependency === "property-specification-fanin") continue;
    for (const property of catalog.properties) {
      if ((property.reference_expectations?.length ?? 0) === 0) continue;
      for (const source of property.sources) {
        if (source.source_node_id !== dependency) continue;
        if (
          [...lensRows.values()].some(
            (row) => row.concreteNodeId === dependencyId && row.propertyId === source.source_property_id
          )
        )
          continue;
        diagnostics.push({
          code: "PROPERTY_REFERENCE_EXPECTATION_DROPPED",
          message: `Lens artifact for ${JSON.stringify(dependency)} is missing source property ${JSON.stringify(source.source_property_id)} carrying reference expectations`,
          severity: "error",
          source: "property-fanin",
          path: `artifacts/${dependencyId}/${lensPathsByDependency.get(dependencyId) ?? "properties.json"}`
        });
      }
    }
  }

  for (const [propertyIndex, property] of catalog.properties.entries()) {
    const expectedReferenceIds = property.reference_expectations ?? [];
    if (expectedReferenceIds.length === 0) continue;
    const sourcePairs = new Set(
      property.sources.map((source) => `${source.source_node_id}\u0000${source.source_property_id}`)
    );
    const lensReferenceIds = new Set(
      [...lensRows.values()]
        .filter((row) => sourcePairs.has(`${row.sourceNodeId}\u0000${row.propertyId}`))
        .flatMap((row) => row.expectationIds)
    );
    const missingReferenceIds = expectedReferenceIds.filter((expectationId) => !lensReferenceIds.has(expectationId));
    if (missingReferenceIds.length > 0) {
      diagnostics.push({
        code: "PROPERTY_REFERENCE_EXPECTATION_DROPPED",
        message: `Canonical property ${JSON.stringify(property.id)} carries reference expectations not present in its source lens artifacts: ${JSON.stringify(missingReferenceIds)}`,
        severity: "error",
        source: "property-fanin",
        path: `${path.join(getNodeArtifactDir(layout, node.id), "properties.json")}#$.properties[${propertyIndex}].reference_expectations`
      });
    }
  }

  const rowsBySource = new Map<string, LensReferenceRow[]>();
  for (const row of lensRows.values()) {
    const key = `${row.sourceNodeId}\\u0000${row.propertyId}`;
    const rows = rowsBySource.get(key) ?? [];
    rows.push(row);
    rowsBySource.set(key, rows);
  }
  for (const rows of rowsBySource.values()) {
    const first = rows[0];
    if (first === undefined) continue;
    for (const row of rows.slice(1)) {
      if (sameStringSet(row.expectationIds, first.expectationIds)) continue;
      diagnostics.push({
        code: "PROPERTY_REFERENCE_EXPECTATION_INCONSISTENT",
        message: `Lens artifacts for ${JSON.stringify(row.sourceNodeId)}:${JSON.stringify(row.propertyId)} disagree on reference expectations across concrete dependencies`,
        severity: "error",
        source: "property-fanin",
        path: `${row.path}#$.properties[${row.index}].reference_expectations`
      });
    }
  }

  const dependencyLogicalIds = new Set(
    node.depends_on.map((dependencyId) => state.nodes[dependencyId]?.logical_node_id ?? dependencyId)
  );
  for (const [propertyIndex, property] of catalog.properties.entries()) {
    if ((property.reference_expectations?.length ?? 0) === 0) continue;
    for (const [sourceIndex, source] of property.sources.entries()) {
      if (source.source_node_id === "property-specification-fanin") continue;
      if (dependencyLogicalIds.has(source.source_node_id)) continue;
      diagnostics.push({
        code: "PROPERTY_LENS_DEPENDENCY_MISSING",
        message: `Canonical property ${JSON.stringify(property.id)} carries reference expectations but fan-in does not depend on source lens ${JSON.stringify(source.source_node_id)}`,
        severity: "error",
        source: "property-fanin",
        path: `${path.join(getNodeArtifactDir(layout, node.id), "properties.json")}#$.properties[${propertyIndex}].sources[${sourceIndex}]`
      });
    }
  }

  for (const row of lensRows.values()) {
    if (row.expectationIds.length === 0) continue;
    const canonicalMatches = catalog.properties.filter((property) =>
      property.sources.some(
        (source) => source.source_node_id === row.sourceNodeId && source.source_property_id === row.propertyId
      )
    );
    if (canonicalMatches.length === 0) {
      diagnostics.push({
        code: "PROPERTY_REFERENCE_EXPECTATION_DROPPED",
        message: `Canonical property fan-in dropped reference expectations ${JSON.stringify(row.expectationIds)} from ${JSON.stringify(row.sourceNodeId)}:${JSON.stringify(row.propertyId)}`,
        severity: "error",
        source: "property-fanin",
        path: `${row.path}#$.properties[${row.index}].reference_expectations`
      });
      continue;
    }
    for (const expectationId of row.expectationIds) {
      if (canonicalMatches.some((property) => (property.reference_expectations ?? []).includes(expectationId))) {
        continue;
      }
      diagnostics.push({
        code: "PROPERTY_REFERENCE_EXPECTATION_DROPPED",
        message: `Canonical property fan-in dropped reference expectation ${JSON.stringify(expectationId)} for ${JSON.stringify(row.sourceNodeId)}:${JSON.stringify(row.propertyId)}`,
        severity: "error",
        source: "property-fanin",
        path: `${row.path}#$.properties[${row.index}].reference_expectations`
      });
    }
  }
  return diagnostics;
}

function verifyInvariantSourceEvidence(
  workspacePath: string,
  entry: InvariantLedgerEntry,
  entryIndex: number,
  ledgerPath: string,
  diagnostics: RuntimeDiagnostic[]
): void {
  let sourcePath: string;
  try {
    sourcePath = path.resolve(workspacePath, entry.source_path);
    if (sourcePath === workspacePath || !sourcePath.startsWith(`${workspacePath}${path.sep}`)) {
      throw new Error(`invariant evidence source path escapes workspace: ${entry.source_path}`);
    }
  } catch (error) {
    diagnostics.push({
      code: "INVARIANT_LEDGER_SOURCE_PATH_INVALID",
      message: diagnosticFromError(error, "invariant-ledger", "INVARIANT_LEDGER_SOURCE_PATH_INVALID").message,
      severity: "error",
      source: "invariant-ledger",
      path: `${ledgerPath}#$.entries[${entryIndex}].source_path`
    });
    return;
  }
  if (!fs.existsSync(sourcePath)) {
    diagnostics.push({
      code: "INVARIANT_LEDGER_SOURCE_MISSING",
      message: `Invariant ledger source path ${JSON.stringify(entry.source_path)} does not exist in the discovery workspace`,
      severity: "error",
      source: "invariant-ledger",
      path: `${ledgerPath}#$.entries[${entryIndex}].source_path`
    });
    return;
  }
  try {
    assertRegularFileInside(workspacePath, sourcePath, "invariant evidence source");
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(sourcePath));
    } catch {
      diagnostics.push({
        code: "INVARIANT_LEDGER_SOURCE_BINARY",
        message: `Invariant ledger source ${JSON.stringify(entry.source_path)} is not UTF-8 text`,
        severity: "error",
        source: "invariant-ledger",
        path: `${ledgerPath}#$.entries[${entryIndex}].source_path`
      });
      return;
    }
    verifyInvariantSourceText(source, entry, entryIndex, ledgerPath, diagnostics);
  } catch (error) {
    diagnostics.push(diagnosticFromError(error, "invariant-ledger", "INVARIANT_LEDGER_SOURCE_READ_FAILED"));
  }
}

/**
 * Issue #292 verdict, recorded as a decision: REJECT SILENCE, ACCEPT EXPLICIT EMPTINESS.
 *
 * A ledger with no entries used to pass on the SHAPE of its emptiness alone — `inventory_rows: []`
 * plus at least one scan probe — and that shape is free to fabricate: nothing anywhere reads
 * `probe.result`, every consumer is a presence check, so invented probe text satisfied both evidence
 * gates. "The agent searched and found nothing" was therefore unfalsifiable.
 *
 * A genuinely invariant-free target has to stay possible, so emptiness is not banned; it is made
 * ATTRIBUTABLE. The ledger must state the claim in `no_invariants_justification`, which survives in
 * the artifact and can be read against the target after the fact.
 *
 * Deliberately NOT the third option in the issue (mark the derived proof `partial`): that adds a
 * state every consumer of the ledger has to learn, to describe a case that is already fully
 * described by two existing ones.
 */
function verifyNoInvariantsJustification(
  justification: string | undefined,
  ledgerPath: string,
  diagnostics: RuntimeDiagnostic[]
): void {
  if (justification !== undefined) {
    return;
  }
  diagnostics.push({
    code: "INVARIANT_LEDGER_NO_INVARIANTS_UNJUSTIFIED",
    message:
      "An invariant evidence ledger with no entries must record no_invariants_justification stating why the target carries no invariant",
    severity: "error",
    source: "invariant-ledger",
    path: `${ledgerPath}#$.no_invariants_justification`
  });
}

function verifyInvariantProbePath(
  workspacePath: string,
  relativePath: string,
  probeIndex: number,
  ledgerPath: string,
  diagnostics: RuntimeDiagnostic[]
): void {
  const probePath = path.resolve(workspacePath, relativePath);
  const diagnosticPath = `${ledgerPath}#$.scan_probes[${probeIndex}].source_path`;
  const isSafeRelativeProbe = isSafeInvariantProbePath(relativePath);
  const isWorkspaceRootProbe = isSafeRelativeProbe && probePath === workspacePath;
  if (!isSafeRelativeProbe || (!isWorkspaceRootProbe && !probePath.startsWith(`${workspacePath}${path.sep}`))) {
    diagnostics.push({
      code: "INVARIANT_LEDGER_PROBE_PATH_INVALID",
      message: `Invariant scan probe path escapes the discovery workspace: ${relativePath}`,
      severity: "error",
      source: "invariant-ledger",
      path: diagnosticPath
    });
    return;
  }
  try {
    const workspaceStat = fs.lstatSync(workspacePath);
    if (
      !workspaceStat.isDirectory() ||
      workspaceStat.isSymbolicLink() ||
      fs.realpathSync(workspacePath) !== workspacePath
    ) {
      throw new Error("workspace root is not a canonical directory");
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    diagnostics.push({
      code: "INVARIANT_LEDGER_PROBE_PATH_INVALID",
      message: `Invariant scan probe requires a canonical discovery workspace: ${relativePath}`,
      severity: "error",
      source: "invariant-ledger",
      path: `${ledgerPath}#$.scan_probes[${probeIndex}].source_path`
    });
    return;
  }
  if (isWorkspaceRootProbe) {
    return;
  }
  if (!invariantPathParentsInsideWorkspace(workspacePath, probePath)) {
    diagnostics.push({
      code: "INVARIANT_LEDGER_PROBE_PATH_INVALID",
      message: `Invariant scan probe path crosses a symlinked parent: ${relativePath}`,
      severity: "error",
      source: "invariant-ledger",
      path: diagnosticPath
    });
    return;
  }
  try {
    const stat = fs.lstatSync(probePath);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      // A directory probe records where the agent searched, exactly like the repository-root probe
      // handled above. It is valid evidence and simply cannot be snapshotted as a UTF-8 file
      // (issue #289 — R45's project-discovery died naming `tests`).
      return;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      diagnostics.push({
        code: "INVARIANT_LEDGER_PROBE_PATH_INVALID",
        message: `Invariant scan probe path must be a regular file or a non-symlink directory when present: ${relativePath}`,
        severity: "error",
        source: "invariant-ledger",
        path: diagnosticPath
      });
    } else {
      try {
        const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(probePath));
        if (content.includes("\u0000")) throw new Error("NUL");
      } catch {
        diagnostics.push({
          code: "INVARIANT_LEDGER_PROBE_SOURCE_BINARY",
          message: `Invariant scan probe source is not UTF-8 text: ${relativePath}`,
          severity: "error",
          source: "invariant-ledger",
          path: diagnosticPath
        });
      }
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    diagnostics.push(diagnosticFromError(error, "invariant-ledger", "INVARIANT_LEDGER_PROBE_PATH_INVALID"));
  }
}

function isSafeInvariantProbePath(relativePath: string): boolean {
  return (
    !path.isAbsolute(relativePath) &&
    !relativePath.includes("\u0000") &&
    !relativePath.includes("\\") &&
    !/^[A-Za-z]:/u.test(relativePath) &&
    !relativePath.split("/").includes("..")
  );
}

function invariantPathParentsInsideWorkspace(workspacePath: string, candidatePath: string): boolean {
  let current = path.dirname(candidatePath);
  while (current !== workspacePath) {
    if (!current.startsWith(`${workspacePath}${path.sep}`)) return false;
    try {
      return fs.realpathSync(current) === current;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) return false;
      try {
        if (fs.lstatSync(current).isSymbolicLink()) return false;
      } catch (lstatError) {
        if (!(lstatError instanceof Error && "code" in lstatError && lstatError.code === "ENOENT")) {
          return false;
        }
      }
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
  return true;
}

function invariantSourceProofPath(runRoot: string, attemptId: string): string {
  return safeResolveInside(runRoot, `source-proofs/${attemptId}.invariant.json`, "invariant source proof");
}

function readInvariantSourceProof(
  proofPath: string,
  ledgerPath: string,
  diagnostics: RuntimeDiagnostic[]
): InvariantSourceProof | undefined {
  try {
    assertRegularFileInside(path.dirname(path.dirname(proofPath)), proofPath, "invariant source proof");
    const parsed = validateInvariantSourceProofSchema(JSON.parse(fs.readFileSync(proofPath, "utf8")), proofPath);
    if (!parsed.ok || parsed.value === undefined) {
      diagnostics.push({
        code: "INVARIANT_LEDGER_SOURCE_PROOF_INVALID",
        message: parsed.issues.map((issue) => issue.message).join("; "),
        severity: "error",
        source: "invariant-ledger",
        path: `${proofPath}#${parsed.issues[0]?.path ?? "$"}`
      });
      return undefined;
    }
    const expectedAttemptId = path.basename(proofPath).replace(/\.invariant\.json$/u, "");
    if (parsed.value.attempt_id !== expectedAttemptId) {
      diagnostics.push({
        code: "INVARIANT_LEDGER_SOURCE_PROOF_ATTEMPT_MISMATCH",
        message: "Invariant source proof attempt does not match its durable path",
        severity: "error",
        source: "invariant-ledger",
        path: `${proofPath}#$.attempt_id`
      });
      return undefined;
    }
    const ledgerBytes = fs.readFileSync(ledgerPath);
    const ledgerDigest = crypto.createHash("sha256").update(ledgerBytes).digest("hex");
    if (ledgerDigest !== parsed.value.ledger_sha256) {
      diagnostics.push({
        code: "INVARIANT_LEDGER_SOURCE_PROOF_LEDGER_MISMATCH",
        message: "Invariant source proof is not bound to the published ledger bytes",
        severity: "error",
        source: "invariant-ledger",
        path: `${proofPath}#$.ledger_sha256`
      });
      return undefined;
    }
    const baseProofPath = proofPath.replace(/\.invariant\.json$/u, ".json");
    let baseProofPresent = false;
    try {
      fs.lstatSync(baseProofPath);
      baseProofPresent = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (baseProofPresent) {
      assertRegularFileInside(path.dirname(path.dirname(proofPath)), baseProofPath, "pinned source proof");
      const base = JSON.parse(fs.readFileSync(baseProofPath, "utf8")) as {
        attempt_id?: unknown;
        commit?: unknown;
        tree?: unknown;
      };
      if (
        base.attempt_id !== expectedAttemptId ||
        base.commit !== parsed.value.commit ||
        base.tree !== parsed.value.tree
      ) {
        diagnostics.push({
          code: "INVARIANT_LEDGER_SOURCE_PROOF_SOURCE_MISMATCH",
          message: "Invariant source proof does not match the pinned source proof",
          severity: "error",
          source: "invariant-ledger",
          path: `${proofPath}#$.commit`
        });
        return undefined;
      }
    }
    return parsed.value;
  } catch (error) {
    diagnostics.push({
      code: "INVARIANT_LEDGER_SOURCE_PROOF_INVALID",
      message: diagnosticFromError(error, "invariant-ledger", "INVARIANT_LEDGER_SOURCE_PROOF_INVALID").message,
      severity: "error",
      source: "invariant-ledger",
      path: proofPath
    });
    return undefined;
  }
}

function verifyInvariantSourceProofEvidence(
  proof: InvariantSourceProof,
  entry: InvariantLedgerEntry,
  entryIndex: number,
  ledgerPath: string,
  diagnostics: RuntimeDiagnostic[]
): void {
  const file = proof.files.find((candidate) => candidate.path === entry.source_path);
  if (file === undefined) {
    diagnostics.push({
      code: "INVARIANT_LEDGER_SOURCE_PROOF_FILE_MISSING",
      message: `Invariant source proof does not contain ${JSON.stringify(entry.source_path)}`,
      severity: "error",
      source: "invariant-ledger",
      path: `${ledgerPath}#$.entries[${entryIndex}].source_path`
    });
    return;
  }
  const digest = crypto.createHash("sha256").update(file.content, "utf8").digest("hex");
  if (digest !== file.sha256) {
    diagnostics.push({
      code: "INVARIANT_LEDGER_SOURCE_PROOF_FILE_INVALID",
      message: `Invariant source proof content hash does not match ${JSON.stringify(entry.source_path)}`,
      severity: "error",
      source: "invariant-ledger",
      path: `${ledgerPath}#$.entries[${entryIndex}].source_path`
    });
    return;
  }
  verifyInvariantSourceText(file.content, entry, entryIndex, ledgerPath, diagnostics);
}

function verifyInvariantSourceText(
  source: string,
  entry: InvariantLedgerEntry,
  entryIndex: number,
  ledgerPath: string,
  diagnostics: RuntimeDiagnostic[]
): void {
  if (source.includes("\u0000")) {
    diagnostics.push({
      code: "INVARIANT_LEDGER_SOURCE_BINARY",
      message: `Invariant ledger source ${JSON.stringify(entry.source_path)} is not UTF-8 text`,
      severity: "error",
      source: "invariant-ledger",
      path: `${ledgerPath}#$.entries[${entryIndex}].source_path`
    });
    return;
  }
  const lineMatch = /^(?:line|lines)\s+(\d+)(?:\s*[-–]\s*(\d+))?/iu.exec(entry.source_location);
  const symbol = lineMatch === null ? /([A-Za-z_$][A-Za-z0-9_$]*)\s*$/u.exec(entry.source_location)?.[1] : undefined;
  if (lineMatch === null && symbol === undefined) {
    diagnostics.push({
      code: "INVARIANT_LEDGER_SOURCE_LOCATION_INVALID",
      message: `Invariant ledger source location ${JSON.stringify(entry.source_location)} is not a line range or symbol`,
      severity: "error",
      source: "invariant-ledger",
      path: `${ledgerPath}#$.entries[${entryIndex}].source_location`
    });
    return;
  }
  if (lineMatch === null) {
    const declaration = invariantSymbolDeclaration(source, symbol!);
    if (declaration === undefined) {
      diagnostics.push({
        code: "INVARIANT_LEDGER_SOURCE_TEXT_MISMATCH",
        message: `Invariant ledger symbol ${JSON.stringify(symbol)} does not occur in ${JSON.stringify(entry.source_path)}`,
        severity: "error",
        source: "invariant-ledger",
        path: `${ledgerPath}#$.entries[${entryIndex}].source_location`
      });
      return;
    }
    if (
      !normalizeInvariantSourceLines(declaration.split(/\r?\n/u)).includes(
        normalizeInvariantSourceLines([entry.verbatim])
      )
    ) {
      diagnostics.push({
        code: "INVARIANT_LEDGER_SOURCE_TEXT_MISMATCH",
        message: `Invariant ledger verbatim text does not occur in ${JSON.stringify(entry.source_path)}`,
        severity: "error",
        source: "invariant-ledger",
        path: `${ledgerPath}#$.entries[${entryIndex}].verbatim`
      });
    }
    return;
  }
  const startLine = Number(lineMatch[1]);
  const endLine = Number(lineMatch[2] ?? lineMatch[1]);
  const lines = source.split(/\r\n|\r|\n/u).slice(Math.max(0, startLine - 1), endLine);
  if (lines.length === 0 || normalizeInvariantSourceLines(lines) !== normalizeInvariantSourceLines([entry.verbatim])) {
    diagnostics.push({
      code: "INVARIANT_LEDGER_SOURCE_TEXT_MISMATCH",
      message: `Invariant ledger verbatim text does not occur at ${entry.source_location} in ${JSON.stringify(entry.source_path)}`,
      severity: "error",
      source: "invariant-ledger",
      path: `${ledgerPath}#$.entries[${entryIndex}].verbatim`
    });
  }
}

function normalizeInvariantSourceLines(lines: readonly string[]): string {
  return lines
    .flatMap((line) => line.replace(/\r\n?/gu, "\n").split("\n"))
    .map((line) => line.replace(/^\s*(?:[-*+]\s+|>\s+)/u, ""))
    .join("\n")
    .replace(/\n+$/u, "");
}

function invariantSymbolDeclaration(source: string, symbol: string): string | undefined {
  const declaration = new RegExp(
    `\\b(?:function|contract|library|interface|modifier|event|error|struct|enum)\\s+(?:[A-Za-z_$][A-Za-z0-9_$]*\\.)?${escapeRegExp(symbol)}\\b`,
    "u"
  ).exec(source);
  if (declaration === null || declaration.index === undefined) return undefined;
  const tail = source.slice(declaration.index + declaration[0].length);
  const next = /\n\s*(?:function|contract|library|interface|modifier|event|error|struct|enum)\s+/u.exec(tail);
  return source.slice(declaration.index, declaration.index + declaration[0].length + (next?.index ?? tail.length));
}

function markdownDelimitedBlock(
  markdown: string,
  marker: string,
  requiredTokens: readonly string[] = []
): string | undefined {
  const endMarker = marker
    .replace("### Ledger entry:", "### End ledger entry:")
    .replace("### Inventory row:", "### End inventory row:")
    .replace("### Canonical property:", "### End canonical property:");
  const markerPattern = new RegExp(`^${escapeRegExp(marker)}[ \\t]*$`, "gmu");
  for (const match of markdown.matchAll(markerPattern)) {
    if (match.index === undefined) continue;
    const start = match.index;
    const contentStart = start + match[0].length;
    const nextBlockPattern = /^### (?:Ledger entry:|Inventory row:|Canonical property:)/gmu;
    nextBlockPattern.lastIndex = contentStart;
    const nextBlock = nextBlockPattern.exec(markdown);
    const contentLimit = nextBlock?.index ?? markdown.length;
    const endPattern = new RegExp(`^${escapeRegExp(endMarker)}[ \\t]*$`, "gmu");
    let endMatch: RegExpExecArray | null = null;
    for (const candidate of markdown.slice(contentStart, contentLimit).matchAll(endPattern)) {
      endMatch = candidate;
    }
    if (endMatch?.index !== undefined) {
      const block = markdown.slice(start, contentStart + endMatch.index + endMatch[0].length);
      if (requiredTokens.every((token) => markdownContainsToken(block, token))) {
        return block;
      }
    }
  }
  return undefined;
}

function markdownContainsToken(markdown: string, token: string): boolean {
  const pattern = new RegExp(`(?<![A-Za-z0-9._-])${escapeRegExp(token)}(?![A-Za-z0-9._-])`, "u");
  if (pattern.test(markdown)) return true;
  const normalizeIndented = (value: string): string => value.replace(/\r\n?/gu, "\n").replace(/^ {2}/gmu, "");
  return pattern.test(normalizeIndented(markdown));
}

function markdownContainsCanonicalValue(markdown: string, value: string): boolean {
  const normalized = value.replace(/\r\n?/gu, "\n");
  const rendered = markdown.replaceAll("\\|", "|").replaceAll("<br>", "\n");
  const variants = new Set([normalized, normalized.replaceAll("|", "\\|"), normalized.replaceAll("\n", "<br>")]);
  if (markdownContainsToken(rendered, normalized)) return true;
  return [...variants].some((variant) => markdownContainsToken(markdown, variant));
}

function markdownFieldContainsValue(markdown: string, field: string, value: string): boolean {
  return markdownFieldContainsAnyValue(markdown, field, [value]);
}

function markdownFieldEqualsValue(markdown: string, field: string, value: string): boolean {
  const fieldValues = markdownFieldValues(markdown, field);
  return (
    fieldValues.length === 1 && normalizeMarkdownFieldValue(fieldValues[0] ?? "") === normalizeMarkdownFieldValue(value)
  );
}

function markdownFieldContainsAnyValue(markdown: string, field: string, values: readonly string[]): boolean {
  return markdownFieldValues(markdown, field).some((fieldValue) =>
    values.some((value) => markdownContainsCanonicalValue(fieldValue, value))
  );
}

function markdownFieldEntries<T>(markdown: string, field: string, normalize: (value: string) => T): T[] {
  return markdownFieldValues(markdown, field)
    .flatMap((value) => value.replaceAll("<br>", "\n").split(/[,;\n]/u))
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value !== "[]")
    .map(normalize);
}

function normalizeSourcePair(value: string): string {
  return value
    .replaceAll("`", "")
    .replace(/^\s*[-*+]\s*/u, "")
    .replace(/\s*(?::|\/)\s*/u, ":")
    .trim();
}

function normalizeLedgerId(value: string): string {
  return value
    .replaceAll("`", "")
    .replace(/^\s*[-*+]\s*/u, "")
    .trim();
}

function normalizeMarkdownFieldValue(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replaceAll("\\|", "|")
    .replaceAll("<br>", "\n")
    .replace(/\n?Ledger evidence(?: retained)?:[\s\S]*$/iu, "")
    .replaceAll("`", "")
    .trim();
}

function markdownFieldValues(markdown: string, field: string): string[] {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  const fieldPattern = new RegExp(`^\\s*(?:\\|\\s*)?(?:[-*+]\\s*)?${escapeRegExp(field)}\\s*(?::|\\|)\\s*(.*)$`, "iu");
  const nextFieldPattern =
    /^\s*(?:\|\s*)?(?:[-*+]\s*)?(?:id|description|category|priority|sources?|ledger[_ -]?ids?|reference[_ -]?expectations?|ledger evidence(?: retained)?)\s*(?::|\|)/iu;
  const values: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = fieldPattern.exec(lines[index] ?? "");
    if (match?.[1] === undefined) continue;
    const parts = [match[1].replace(/\s*\|\s*$/u, "")];
    for (let continuation = index + 1; continuation < lines.length; continuation += 1) {
      const line = lines[continuation] ?? "";
      if (
        /^\s*(?:\|\s*)?(?:[-*+]\s*)?ledger[_ -]?evidence(?: retained?)?\s*(?::|\|)/iu.test(line) ||
        /^\s*###\s/u.test(line) ||
        nextFieldPattern.test(line)
      )
        break;
      if (line.trim() !== "") parts.push(line.trim());
      index = continuation;
    }
    values.push(parts.join("\n"));
  }
  return values;
}

function sourcePairVariants(sourceNodeId: string, sourcePropertyId: string): string[] {
  return [
    `${sourceNodeId}:${sourcePropertyId}`,
    `${sourceNodeId} / ${sourcePropertyId}`,
    `${sourceNodeId}/${sourcePropertyId}`
  ];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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

/**
 * Logical node IDs whose artifacts carry campaign property provenance. The
 * default topology runs one final recon-fuzzer campaign in
 * `stateful-invariant-campaign`; the dedicated recon campaign node stays
 * accepted so project-owned topologies that split the campaign keep their
 * gates. Exported so a test can pin this list to the shipped topology — the
 * bug this list fixes was a gate keyed on an ID the topology did not contain.
 */
export const CAMPAIGN_LOGICAL_NODE_IDS = ["stateful-invariant-campaign", "stateful-invariant-recon-campaign"] as const;

// Mirrors the generated workflow's verification-marker directory inside the run root.
const ARTIFACT_VERIFICATION_DIRECTORY = ".ultrafuzz-verification";

const campaignLogicalNodeIds = CAMPAIGN_LOGICAL_NODE_IDS;

const campaignResultArtifactNames = [
  "recon-fuzzer-results.json",
  "echidna-results.json",
  "medusa-results.json"
] as const;

function isCampaignLogicalId(logicalId: string): boolean {
  return campaignLogicalNodeIds.some((nodeId) => nodeId === logicalId);
}

function verifyPropertyProvenanceArtifacts(
  layout: RunLayout,
  artifactDir: string,
  node: PlannedGraphNode
): RuntimeDiagnostic[] {
  const logicalId = node.logical_id ?? node.id;
  const isPropertyLens = node.outputs.some((output) => output.contract === "ultrafuzz/property-lens@1");
  if (isPropertyLens) {
    return verifyLensReferenceExpectationAuthority(layout, artifactDir, node);
  }
  if (logicalId === "final-report") {
    return verifyFinalReportPropertyReferences(layout, artifactDir, node);
  }
  if (logicalId !== "stateful-invariant-implement-properties" && !isCampaignLogicalId(logicalId)) {
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
    return [
      ...propertyReferenceDiagnostics(catalog.value, references),
      ...verifyImplementationSelectionCoverage(
        catalog.value,
        implementation.value,
        implementationPath,
        layout,
        node.outputs.some(
          (output) =>
            output.path === "implemented-properties.json" && output.contract === "ultrafuzz/implemented-properties@2"
        )
      )
    ];
  }

  return verifyCampaignPropertyReferences(layout, artifactDir, catalog.value);
}

/**
 * A reference expectation is provenance, not free-form model metadata. A lens
 * may copy an ID only when the exact token is present in a declared pinned
 * reference input artifact. This keeps illustrative prompt text from becoming
 * an apparently authorized benchmark mapping.
 */
function verifyLensReferenceExpectationAuthority(
  layout: RunLayout,
  artifactDir: string,
  node: PlannedGraphNode
): RuntimeDiagnostic[] {
  const lensOutput = propertyLensOutput(node);
  if (lensOutput === undefined) return [];
  const lensPath = safeResolveInside(artifactDir, lensOutput.path, "property lens output");
  if (!fs.existsSync(lensPath)) return [];
  const lens = validateLensPropertiesSchema(readJsonFile(lensPath), lensPath);
  if (!lens.ok || lens.value === undefined) return [];

  const supplied = readLensSuppliedExpectationIds(layout, node);
  const suppliedExpectationIds = supplied.ids;
  const diagnostics: RuntimeDiagnostic[] = [...supplied.diagnostics];
  for (const [propertyIndex, property] of lens.value.properties.entries()) {
    for (const [expectationIndex, expectationId] of (property.reference_expectations ?? []).entries()) {
      if (suppliedExpectationIds.has(expectationId)) continue;
      diagnostics.push({
        code: "PROPERTY_REFERENCE_EXPECTATION_UNAUTHORIZED",
        message: `Property lens expectation ${JSON.stringify(expectationId)} is not present in a supplied pinned-reference catalog`,
        severity: "error",
        source: "property-provenance",
        path: `${lensPath}#$.properties[${propertyIndex}].reference_expectations[${expectationIndex}]`
      });
    }
  }
  return diagnostics;
}

/**
 * Keep a verification marker consistent with an artifact a runtime gate just rewrote. Updates the
 * recorded sha256 for that one path in both `artifacts` and `publications`, leaving every other
 * entry and the rest of the marker untouched, so the marker still attests exactly what is on disk.
 */
function refreshVerifiedArtifactDigest(
  layout: RunLayout,
  attemptId: string,
  relativePath: string,
  absolutePath: string
): RuntimeDiagnostic[] {
  const markerPath = path.join(layout.root, ARTIFACT_VERIFICATION_DIRECTORY, `${attemptId}.json`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch {
    // No marker yet: the verifier has not run, so it will hash the sanitized bytes itself.
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const marker = parsed as Record<string, unknown>;
  const digest = crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
  const previous = new Set<string>();
  let updated = false;
  for (const key of ["artifacts", "publications"] as const) {
    const entries = marker[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (record.path !== relativePath || typeof record.sha256 !== "string") continue;
      if (record.sha256 === digest) continue;
      previous.add(record.sha256);
      record.sha256 = digest;
      updated = true;
    }
  }
  if (!updated) return [];
  writeJsonDurable(markerPath, marker);
  return [
    {
      code: "ARTIFACT_VERIFICATION_DIGEST_REFRESHED",
      message: `Refreshed the verification marker digest for ${relativePath} after runtime sanitization`,
      severity: "warning",
      source: "property-provenance",
      path: markerPath,
      details: {
        attempt_id: attemptId,
        artifact_path: relativePath,
        sha256: digest,
        // Both sides recorded: this rewrites a security-relevant attestation.
        previous_sha256: [...previous].sort()
      }
    }
  ];
}

/**
 * Report a verification marker that disagrees with the bytes on disk for one artifact, without
 * touching either. Used where the runtime did not itself rewrite the artifact, so re-sealing would
 * be indistinguishable from laundering an unexplained change past verification.
 */
function reportVerifiedArtifactDigestDrift(
  layout: RunLayout,
  attemptId: string,
  relativePath: string,
  absolutePath: string
): RuntimeDiagnostic[] {
  const markerPath = path.join(layout.root, ARTIFACT_VERIFICATION_DIRECTORY, `${attemptId}.json`);
  const recorded = recordedMarkerDigests(markerPath, relativePath);
  if (recorded === undefined || recorded.size === 0) return [];
  let digest: string;
  try {
    digest = crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
  } catch {
    return [];
  }
  if (recorded.size === 1 && recorded.has(digest)) return [];
  return [
    {
      code: "ARTIFACT_VERIFICATION_DIGEST_DRIFTED",
      message: `Verification marker digest for ${relativePath} does not match the published artifact`,
      severity: "error",
      source: "property-provenance",
      path: markerPath,
      details: {
        attempt_id: attemptId,
        artifact_path: relativePath,
        sha256: digest,
        marker_sha256: [...recorded].sort()
      }
    }
  ];
}

/** Digests recorded for one artifact path across the marker's artifact and publication sets. */
function recordedMarkerDigests(markerPath: string, relativePath: string): Set<string> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const marker = parsed as Record<string, unknown>;
  const digests = new Set<string>();
  for (const key of ["artifacts", "publications"] as const) {
    const entries = marker[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (record.path === relativePath && typeof record.sha256 === "string") digests.add(record.sha256);
    }
  }
  return digests;
}

function sanitizeLensReferenceExpectationAuthority(
  layout: RunLayout,
  artifactDir: string,
  node: PlannedGraphNode,
  attemptId: string
): RuntimeDiagnostic[] {
  const lensOutput = propertyLensOutput(node);
  if (lensOutput === undefined) return [];
  const lensPath = safeResolveInside(artifactDir, lensOutput.path, "property lens output");
  if (!fs.existsSync(lensPath)) return [];
  const lens = validateLensPropertiesSchema(readJsonFile(lensPath), lensPath);
  if (!lens.ok || lens.value === undefined) return [];
  const supplied = readLensSuppliedExpectationIds(layout, node);
  if (supplied.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return supplied.diagnostics;
  }
  if (supplied.catalogSupplied && readReferenceExpectationEnforcement(layout) === "fail") {
    // Issue #285 staging switch, deliberately OFF by default. Once an operator supplies a catalogue,
    // a citation outside it is a stronger signal than the same citation on a run with no catalogue
    // at all — the authoritative set was declared and the lens went outside it. Enforcing that as a
    // node failure is still a behaviour change nobody has watched land, so it stays opt-in until a
    // smoke lane has been observed. Skipping the rewrite leaves the lens bytes intact, and
    // `verifyLensReferenceExpectationAuthority` then reports each unauthorized ID as an error. The
    // marker/disk drift report still runs: no rewrite happened, which is the case it exists for.
    return reportVerifiedArtifactDigestDrift(layout, attemptId, lensOutput.path, lensPath);
  }

  let removed = 0;
  const removedExpectationIds = new Set<string>();
  const properties = lens.value.properties.map((property) => {
    const expectationIds = property.reference_expectations ?? [];
    if (expectationIds.length === 0) return property;
    // Judged per property, not per ID, and deliberately so: unless EVERY unauthorized ID is a plausible
    // copied citation, the lens is left byte-unchanged. An ID claiming a reserved authority namespace is
    // a forged benchmark mapping, and free text or a URL is an authoring error,
    // and the artifact as the model wrote it is the evidence of that, so rewriting it would destroy
    // what the authority check exists to surface. `verifyPropertyProvenanceArtifacts` reports it and
    // the node fails with the citation intact.
    const unauthorized = expectationIds.filter((expectationId) => !supplied.ids.has(expectationId));
    if (!unauthorized.every((expectationId) => isCopiedReferenceCitation(expectationId))) return property;
    const authorized = expectationIds.filter((expectationId) => supplied.ids.has(expectationId));
    if (authorized.length === expectationIds.length) return property;
    removed += expectationIds.length - authorized.length;
    for (const expectationId of expectationIds) {
      if (!supplied.ids.has(expectationId)) removedExpectationIds.add(expectationId);
    }
    const sanitized = { ...property };
    if (authorized.length === 0) {
      delete sanitized.reference_expectations;
    } else {
      sanitized.reference_expectations = authorized;
    }
    return sanitized;
  });
  if (removed === 0) {
    // Nothing to sanitize now, but the marker can still disagree with disk: the verifier may have
    // hashed the lens and published its marker while an earlier pass was mid-rewrite. That leftover
    // never repairs itself here, and downstream it surfaces only on a `prepare:` wrapper, which
    // records no failed node and so cannot be retried. Report it as an error instead, so the node
    // fails visibly and `--retry-failed` can act on it (issue #275).
    return reportVerifiedArtifactDigestDrift(layout, attemptId, lensOutput.path, lensPath);
  }

  writeJsonDurable(lensPath, {
    ...lens.value,
    properties
  });
  // This gate rewrites an artifact the workflow verifier may already have published and sealed.
  // Leaving the marker describing the pre-sanitization bytes makes every dependent's
  // `assertVerifiedDependency` fail permanently with no failed node to retry, which stranded Aave
  // run R43 (issue #275). The sanitizer is trusted runtime policy removing unauthorized reference
  // expectation IDs, so the marker must follow its edit rather than contradict it.
  const markerDiagnostics = refreshVerifiedArtifactDigest(layout, attemptId, lensOutput.path, lensPath);
  return [
    ...markerDiagnostics,
    {
      code: "PROPERTY_REFERENCE_EXPECTATION_SANITIZED",
      message: `Removed ${removed} unauthorized reference expectation ID${removed === 1 ? "" : "s"} from property lens output`,
      severity: "warning",
      source: "property-provenance",
      path: lensPath,
      details: {
        removed_reference_expectations: [...removedExpectationIds].sort()
      }
    }
  ];
}

function propertyLensOutput(node: PlannedGraphNode): PlannedGraphNode["outputs"][number] | undefined {
  return node.outputs.find((output) => output.contract === "ultrafuzz/property-lens@1");
}

/**
 * Namespaces that assert an external authority blessed a property. An identifier under one of these is
 * a benchmark-mapping claim: the gate exists to reject it, so it fails the node with its bytes intact.
 *
 * Everything else is a citation the lens prompt told the model to copy out of a pinned-reference
 * document, and is stripped with a `PROPERTY_REFERENCE_EXPECTATION_SANITIZED` diagnostic.
 *
 * This rule was previously approximated by a SHAPE pattern, and the approximation kept costing runs:
 *
 *   1. `LEND-01` — stripped correctly.
 *   2. `LEND_ACC_01` — killed R44's `property-specification-0kn0t` (issue #283) because the pattern
 *      allowed only a single hyphen before the digits, so the ID was neither authorised nor
 *      strippable. Fixed by widening the pattern to `-`/`_` segments (PR #284).
 *   3. `testConvertToAssetsSharesDesirable` — killed R45's `property-specification-runtime-verification`
 *      (issue #293). A test-function name from that lens's own pinned reference, which no shape pattern
 *      should be expected to anticipate.
 *
 * An allowlist of authority prefixes is used rather than "does it contain a colon", because a colon
 * test fails in both directions. Real catalogue identifiers are not colon-namespaced: the ScFuzzBench
 * ground truth uses bare labels such as `total-borrowed-v0`, `reference-expectations.schema.json` puts
 * no namespace requirement on `id`, and `.ultrafuzz/references.yml` namespaces with dots
 * (`properties.crytic`). Meanwhile a colon appears in perfectly ordinary citations — a source URL, a
 * `RoundingProps.sol:88` line reference, or `ERC4626-01: totalAssets never reverts` — and hard-failing
 * a whole lens on one punctuation character in model-authored text is the same trap in a new costume.
 *
 * Matching is prefix-anchored and case-insensitive so `Benchmark:` cannot slip past.
 *
 * Stripping is not free, and the cost is worth stating rather than assuming. `reference_expectations`
 * forces a property into the implementation selection regardless of the priority threshold
 * (`report-artifacts.ts`), and every fan-in `PROPERTY_REFERENCE_EXPECTATION_DROPPED` check skips a row
 * whose expectation list is empty — so a stripped property can quietly fall out of implementation and
 * out of those checks, with only a `warning` to show for it. What stripping cannot do is manufacture
 * provenance: `reference_expectation_ids` is report-only and no grading path reads it. So the residual
 * exposure is reduced DETECTION of an odd citation, weighed against losing an entire reference lens's
 * coverage, which is what failing the node actually costs.
 *
 * The wider authority question (#285) is now DECIDED, in two stages, and this rule is unchanged by
 * either. The disagreement was that the lens prompt says "copy identifiers out of the supplied
 * pinned-reference artifacts" — Markdown documents — while authority comes only from a structured
 * `ultrafuzz/reference-expectations@1` catalogue, which no benchmark run supplies. Option 3 in the
 * issue was taken: the catalogue is the definition of "supplied", and a run that wants its lens
 * citations authorized has to provide one.
 *
 * Stage one, shipped: when no dependency supplies a catalogue,
 * `readLensSuppliedExpectationIds` now says so with `PROPERTY_REFERENCE_EXPECTATION_CATALOG_ABSENT`
 * instead of returning an empty id set in silence. That path was not the exception, it was every
 * benchmark run, and the silence is what let the gate — and #240's
 * `verifyImplementationSelectionCoverage` — look active while doing nothing.
 *
 * Stage two, NOT shipped by default: once a catalogue is supplied, treating a citation outside it as
 * a node failure is available behind `invariants.reference_expectation_enforcement = "fail"`. It
 * stays `warn` (strip, report, keep the run alive) until a smoke lane has been observed, because the
 * failure mode of getting this wrong is exactly the one items 2 and 3 above document: killing a
 * whole reference lens over model-authored text.
 */
// Separator-agnostic on purpose, both BETWEEN the namespace and the identifier and WITHIN the keyword.
// A prefix allowlist that only knew `:` would let `scfuzzbench_aave_v4_iSpoke_supply` through as an
// ordinary citation, and one that only allowed a hyphen inside `ground-truth` would let
// `ground_truth.total-borrowed-v0` and `sc_fuzzbench.x` through — the same forgery with different
// punctuation each time. A separator is still REQUIRED after the keyword, so ordinary words that merely
// begin with one (`benchmarking`, `Benchmarks-are-fine`) are citations, not authority claims.
const RESERVED_REFERENCE_AUTHORITY = /^(?:sc[._-]?fuzz[._-]?bench|benchmark|ground[-._]?truth)[:._/-]/u;

// The strippable set is bounded POSITIVELY: a single-line token that could plausibly have been copied
// out of a reference document. Bounding it negatively ("anything without an authority prefix") would
// silently swallow a sentence, a whitespace-only entry, a URL or a JSON blob -- all of which are
// authoring errors worth failing on, and none of which any prompt asks a model to put in this field.
//
// Deliberately admits shapes that would otherwise be the NEXT trap in this series: a leading digit or
// underscore (`4626-01`, `_internal`) and an interior colon (`RoundingProps.sol:88`). A colon is safe
// here precisely because the authority check runs first and wins, so `benchmark:unexpected` still fails
// closed. `testConvertToAssetsSharesDesirable` (issue #293) and `LEND_ACC_01` (issue #283) both match,
// so this stays as permissive as it needs to be and no more.
const COPIED_REFERENCE_CITATION = /^[A-Za-z0-9_][A-Za-z0-9._:-]{0,63}$/u;

function claimsReservedReferenceAuthority(expectationId: string): boolean {
  // Lower-cased so `Benchmark_unexpected` cannot slip past; a regression pins that. NOT trimmed: a
  // `.trim()` here would be unreachable defensive code, because `isCopiedReferenceCitation` tests the raw
  // string first and any leading or trailing whitespace fails it outright. Keeping it would imply a
  // protection that no test could pin.
  return RESERVED_REFERENCE_AUTHORITY.test(expectationId.toLowerCase());
}

function isCopiedReferenceCitation(expectationId: string): boolean {
  return COPIED_REFERENCE_CITATION.test(expectationId) && !claimsReservedReferenceAuthority(expectationId);
}

function readLensSuppliedExpectationIds(
  layout: RunLayout,
  node: PlannedGraphNode
): { ids: Set<string>; catalogSupplied: boolean; diagnostics: RuntimeDiagnostic[] } {
  const expectationIds = new Set<string>();
  const diagnostics: RuntimeDiagnostic[] = [];
  let catalogSupplied = false;
  const state = readRunState(layout);
  for (const dependencyId of node.depends_on) {
    // Only declared, pinned-reference inputs can authorize provenance. In
    // particular, an agentic setup/lens node or unrelated reference elsewhere
    // in the run cannot authorize an ID for this lens.
    if (state.nodes[dependencyId]?.provenance?.origin !== "pinned-reference") continue;
    const dependencyDir = getNodeArtifactDir(layout, dependencyId);
    const expectationPaths = [
      ...(declaresReferenceExpectationCatalog(state.nodes[dependencyId]?.outputs, "references/expectations.json")
        ? ["references/expectations.json"]
        : []),
      ...(declaresReferenceExpectationCatalog(
        state.nodes[dependencyId]?.outputs,
        "references/reference-expectations.json"
      )
        ? ["references/reference-expectations.json"]
        : [])
    ];
    if (expectationPaths.length === 0) continue;
    catalogSupplied = true;
    const metadata = state.nodes[dependencyId]?.provenance?.reference_expectations;
    if (
      !isRecord(metadata) ||
      metadata.source !== "operator-supplied" ||
      typeof metadata.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(metadata.sha256)
    ) {
      diagnostics.push({
        code: "PROPERTY_REFERENCE_EXPECTATION_PROVENANCE_INVALID",
        message: `Pinned reference dependency ${JSON.stringify(dependencyId)} does not carry operator-supplied expectation provenance`,
        severity: "error",
        source: "property-provenance",
        path: `state.nodes.${dependencyId}.provenance.reference_expectations`
      });
      continue;
    }
    for (const expectationPath of expectationPaths) {
      appendExpectationCatalog(
        layout,
        dependencyId,
        path.join(dependencyDir, expectationPath),
        expectationIds,
        metadata.sha256,
        diagnostics
      );
    }
  }
  if (!catalogSupplied) {
    // Issue #285, part (a): say so. This path used to return an empty id set in silence, which made
    // EVERY citation a lens emitted unauthorized and every reference-expectation check downstream
    // inert — including `verifyImplementationSelectionCoverage`, whose expectation-forced selection
    // can never fire when no property is allowed to keep an expectation. On a benchmark run with no
    // `--reference-expectations` catalogue that is the normal case, not the exceptional one, so the
    // gate was quietly doing nothing exactly where it was supposed to be doing the most.
    diagnostics.push({
      code: "PROPERTY_REFERENCE_EXPECTATION_CATALOG_ABSENT",
      message:
        "No pinned-reference dependency supplies a reference expectation catalog, so every lens reference expectation is unauthorized and the provenance gate is inert",
      severity: "warning",
      source: "property-provenance",
      path: `state.nodes.${node.id}.depends_on`
    });
  }
  return { ids: expectationIds, catalogSupplied, diagnostics };
}

function declaresReferenceExpectationCatalog(
  outputs: ReadonlyArray<{ path: string; contract: string }> | undefined,
  expectedPath: string
): boolean {
  return (
    outputs?.some(
      (output) => output.path === expectedPath && output.contract === "ultrafuzz/reference-expectations@1"
    ) ?? false
  );
}

function appendExpectationCatalog(
  layout: RunLayout,
  dependencyId: string,
  catalogPath: string,
  expectationIds: Set<string>,
  expectedDigest: string,
  diagnostics: RuntimeDiagnostic[]
): void {
  try {
    const stat = fs.lstatSync(catalogPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      diagnostics.push({
        code: "PROPERTY_REFERENCE_EXPECTATION_TAMPERED",
        message: `Reference expectation catalog for ${JSON.stringify(dependencyId)} is not a regular file`,
        severity: "error",
        source: "property-provenance",
        path: catalogPath
      });
      return;
    }
    const catalogContents = fs.readFileSync(catalogPath);
    const actualDigest = sha256Bytes(catalogContents);
    if (actualDigest !== expectedDigest) {
      diagnostics.push({
        code: "PROPERTY_REFERENCE_EXPECTATION_TAMPERED",
        message: `Reference expectation catalog for ${JSON.stringify(dependencyId)} does not match its recorded provenance digest`,
        severity: "error",
        source: "property-provenance",
        path: catalogPath
      });
      return;
    }
    const manifest = readArtifactManifest(layout, dependencyId);
    const manifestEntry = manifest.files.find(
      (file) => file.path === path.relative(getNodeArtifactDir(layout, dependencyId), catalogPath)
    );
    if (manifestEntry?.sha256 !== expectedDigest) {
      diagnostics.push({
        code: "PROPERTY_REFERENCE_EXPECTATION_MANIFEST_MISMATCH",
        message: `Reference expectation catalog for ${JSON.stringify(dependencyId)} is not bound to its artifact manifest digest`,
        severity: "error",
        source: "property-provenance",
        path: path.join(getNodeArtifactDir(layout, dependencyId), "artifact-manifest.json")
      });
      return;
    }
    const parsed = validateReferenceExpectationsSchema(
      JSON.parse(catalogContents.toString("utf8")) as unknown,
      catalogPath
    );
    if (!parsed.ok || parsed.value === undefined) {
      diagnostics.push({
        code: "PROPERTY_REFERENCE_EXPECTATION_TAMPERED",
        message: `Reference expectation catalog for ${JSON.stringify(dependencyId)} failed schema validation`,
        severity: "error",
        source: "property-provenance",
        path: catalogPath
      });
      return;
    }
    for (const expectation of parsed.value.expectations) expectationIds.add(expectation.id);
  } catch {
    diagnostics.push({
      code: "PROPERTY_REFERENCE_EXPECTATION_MANIFEST_MISMATCH",
      message: `Reference expectation catalog for ${JSON.stringify(dependencyId)} has no verifiable artifact manifest`,
      severity: "error",
      source: "property-provenance",
      path: catalogPath
    });
    return;
  }
}

/**
 * Validate the explicit priority selection emitted by new invariant
 * implementation agents. Historical artifacts omit `selection`; those remain
 * valid and continue to receive the legacy canonical-reference checks above.
 */
function verifyImplementationSelectionCoverage(
  catalog: PropertiesArtifact,
  implementation: ImplementedPropertiesArtifact,
  implementationPath: string,
  layout: RunLayout,
  required: boolean
): RuntimeDiagnostic[] {
  const selection = implementation.selection;
  if (selection === undefined) {
    return required
      ? [
          {
            code: "PROPERTY_IMPLEMENTATION_SELECTION_MISSING",
            message: "Current invariant implementation artifacts must declare selection metadata",
            severity: "error",
            source: "property-provenance",
            path: `${implementationPath}#$.selection`
          }
        ]
      : [];
  }

  const diagnostics: RuntimeDiagnostic[] = [];
  const configuredSelection = readConfiguredInvariantPrioritySelection(layout);
  if (required && configuredSelection === undefined) {
    diagnostics.push({
      code: "PROPERTY_IMPLEMENTATION_CONFIG_MISSING",
      message:
        "Current invariant implementation coverage cannot be verified without resolved invariant priority configuration",
      severity: "error",
      source: "property-provenance",
      path: layout.resolvedConfigPath
    });
  }
  const priorityOrder = ["high", "medium", "low"] as const;
  const thresholdIndex = priorityOrder.indexOf(selection.priority_threshold);
  const expectedPriorities = priorityOrder.slice(0, thresholdIndex + 1);
  if (
    selection.priorities.length !== expectedPriorities.length ||
    selection.priorities.some((priority, index) => priority !== expectedPriorities[index])
  ) {
    diagnostics.push({
      code: "PROPERTY_IMPLEMENTATION_SELECTION_INVALID",
      message: `Implementation selection priorities must include exactly the priorities at or above ${JSON.stringify(selection.priority_threshold)}`,
      severity: "error",
      source: "property-provenance",
      path: `${implementationPath}#$.selection.priorities`
    });
  }
  if (
    configuredSelection !== undefined &&
    (selection.priority_threshold !== configuredSelection.priority_threshold ||
      selection.priorities.length !== configuredSelection.priorities.length ||
      selection.priorities.some((priority, index) => priority !== configuredSelection.priorities[index]))
  ) {
    diagnostics.push({
      code: "PROPERTY_IMPLEMENTATION_SELECTION_CONFIG_MISMATCH",
      message: "Implementation selection does not match the resolved invariant priority configuration",
      severity: "error",
      source: "property-provenance",
      path: `${implementationPath}#$.selection`
    });
  }

  const expectedIds = catalog.properties
    .filter(
      (property) =>
        selection.priorities.includes(property.priority) ||
        (property.reference_expectations !== undefined && property.reference_expectations.length > 0)
    )
    .map((property) => property.id);
  const selectedIds = new Set(selection.property_ids);
  const expectedIdSet = new Set(expectedIds);
  const missingSelectedIds = expectedIds.filter((propertyId) => !selectedIds.has(propertyId));
  const extraSelectedIds = selection.property_ids.filter((propertyId) => !expectedIdSet.has(propertyId));
  const selectionOrderMatches =
    selection.property_ids.length === expectedIds.length &&
    selection.property_ids.every((propertyId, index) => propertyId === expectedIds[index]);
  if (missingSelectedIds.length > 0 || extraSelectedIds.length > 0 || !selectionOrderMatches) {
    diagnostics.push({
      code: "PROPERTY_IMPLEMENTATION_SELECTION_MISMATCH",
      message: `Implementation selection must list every canonical property matching its priority scope or an explicit reference expectation in catalog order (missing: ${JSON.stringify(missingSelectedIds)}, extra: ${JSON.stringify(extraSelectedIds)})`,
      severity: "error",
      source: "property-provenance",
      path: `${implementationPath}#$.selection.property_ids`
    });
  }

  const recordsById = new Map(implementation.properties.map((record) => [record.property_id, record]));
  const recordIds = new Set(recordsById.keys());
  const missingRecords = expectedIds.filter((propertyId) => !recordIds.has(propertyId));
  const extraRecords = implementation.properties
    .map((record) => record.property_id)
    .filter((propertyId) => !expectedIdSet.has(propertyId));
  if (missingRecords.length > 0 || extraRecords.length > 0) {
    diagnostics.push({
      code: "PROPERTY_IMPLEMENTATION_COVERAGE_INCOMPLETE",
      message: `Implementation records must cover exactly the selected canonical properties (missing: ${JSON.stringify(missingRecords)}, extra: ${JSON.stringify(extraRecords)})`,
      severity: "error",
      source: "property-provenance",
      path: `${implementationPath}#$.properties`
    });
  }

  for (const [recordIndex, record] of implementation.properties.entries()) {
    const canonical = catalog.properties.find((property) => property.id === record.property_id);
    const expectedReferenceExpectations = canonical?.reference_expectations ?? [];
    const actualReferenceExpectations = record.reference_expectations ?? [];
    if (!sameStringSet(actualReferenceExpectations, expectedReferenceExpectations)) {
      diagnostics.push({
        code: "PROPERTY_IMPLEMENTATION_REFERENCE_EXPECTATIONS_MISMATCH",
        message: `Implementation record ${JSON.stringify(record.property_id)} must preserve the complete canonical reference expectation ID set`,
        severity: "error",
        source: "property-provenance",
        path: `${implementationPath}#$.properties[${recordIndex}].reference_expectations`
      });
    }
  }

  for (const [recordIndex, record] of implementation.properties.entries()) {
    if (!expectedIdSet.has(record.property_id) || record.status === "implemented") continue;
    if (record.blocker !== undefined) continue;
    diagnostics.push({
      code: "PROPERTY_IMPLEMENTATION_BLOCKER_MISSING",
      message: `Selected property ${JSON.stringify(record.property_id)} is ${record.status} and must carry an actionable blocker with code, summary, and next_action`,
      severity: "error",
      source: "property-provenance",
      path: `${implementationPath}#$.properties[${recordIndex}].blocker`
    });
  }
  return diagnostics;
}

function readConfiguredInvariantPrioritySelection(
  layout: RunLayout
): { priority_threshold: "high" | "medium" | "low"; priorities: ("high" | "medium" | "low")[] } | undefined {
  if (!fs.existsSync(layout.resolvedConfigPath)) return undefined;
  const contents = fs.readFileSync(layout.resolvedConfigPath, "utf8");
  const match = /^\s*property_priority_threshold\s*=\s*["'](high|medium|low)["']\s*$/mu.exec(contents);
  if (match === null) return undefined;
  const priority_threshold = match[1] as "high" | "medium" | "low";
  const order = ["high", "medium", "low"] as const;
  return { priority_threshold, priorities: order.slice(0, order.indexOf(priority_threshold) + 1) };
}

/**
 * Staging switch for issue #285, read the same way as the invariant priority threshold above.
 * `warn` — the default, and what every run gets until someone changes it — keeps today's behaviour:
 * an expectation absent from a supplied catalogue is stripped and reported as a warning. `fail`
 * escalates that to a node failure with the lens bytes left intact.
 */
function readReferenceExpectationEnforcement(layout: RunLayout): "warn" | "fail" {
  if (!fs.existsSync(layout.resolvedConfigPath)) return "warn";
  const contents = fs.readFileSync(layout.resolvedConfigPath, "utf8");
  const match = /^\s*reference_expectation_enforcement\s*=\s*["'](warn|fail)["']\s*$/mu.exec(contents);
  return match === null ? "warn" : (match[1] as "warn" | "fail");
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

  const findingsPath = path.join(artifactDir, "findings.json");
  const campaignPaths = campaignResultArtifactNames
    .map((artifactName) => path.join(artifactDir, artifactName))
    .filter((campaignPath) => fs.existsSync(campaignPath));
  if (campaignPaths.length === 0 || !fs.existsSync(findingsPath)) {
    return [];
  }
  const campaigns = campaignPaths.flatMap((campaignPath) => {
    const campaign = validatePropertyCampaignSchema(readJsonFile(campaignPath), campaignPath);
    return campaign.ok && campaign.value !== undefined ? [{ path: campaignPath, value: campaign.value }] : [];
  });
  const findings = validateFindingsSchema(readJsonFile(findingsPath), findingsPath);
  if (!findings.ok || findings.value === undefined) {
    return [];
  }
  const validatedFindings = findings.value;

  const references: PropertyReferenceInput[] = campaigns.flatMap((campaign) =>
    campaign.value.failures.flatMap((failure, index) =>
      failure.property_ids === undefined
        ? []
        : failure.property_ids.map((propertyId, propertyIndex) => ({
            propertyIds: [propertyId],
            path: `${campaign.path}#$.failures[${index}].property_ids[${propertyIndex}]`
          }))
    )
  );
  references.push(...findingPropertyReferences(validatedFindings, findingsPath));

  const diagnostics = [
    ...propertyReferenceDiagnostics(catalog, references),
    ...campaigns.flatMap((campaign) =>
      campaignFindingReferenceDiagnostics(campaign.value.failures, validatedFindings, campaign.path, findingsPath)
    ),
    ...danglingCampaignFindingDiagnostics(
      new Set(campaigns.flatMap((campaign) => campaign.value.failures.map((failure) => failure.id))),
      validatedFindings,
      findingsPath
    )
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

function verifyFinalReportPropertyReferences(
  layout: RunLayout,
  artifactDir: string,
  node: PlannedGraphNode
): RuntimeDiagnostic[] {
  const reportPath = path.join(artifactDir, "report.json");
  if (!fs.existsSync(reportPath)) {
    return [];
  }
  const report = readJsonFile(reportPath);
  if (!isRecord(report)) {
    return [];
  }
  const diagnostics = verifyFinalReportImplementationCoverage(layout, node, report, reportPath);
  if (!Array.isArray(report.property_provenance)) {
    return diagnostics;
  }
  if (report.property_provenance.length === 0) {
    return diagnostics;
  }

  const catalog = readCanonicalPropertyCatalog(layout);
  if (catalog.diagnostics.length > 0 || catalog.value === undefined) {
    return [...diagnostics, ...catalog.diagnostics];
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
  diagnostics.push(...propertyReferenceDiagnostics(catalog.value, references));
  const implementation = readImplementedProperties(layout);
  if (implementation.diagnostics.length > 0 || implementation.value === undefined) {
    return [...diagnostics, ...implementation.diagnostics];
  }
  diagnostics.push(
    ...reportPropertyJoinDiagnostics(
      report.property_provenance,
      catalog.value,
      implementation.value,
      readCampaignFuzzerBackends(layout),
      reportPath
    )
  );
  return diagnostics;
}

/**
 * A current invariant run carries selection metadata in the @2 implementation
 * handoff. Its terminal report must preserve the same coverage accounting and
 * render the corresponding Markdown section. Reports from before this
 * handoff, which have no implementation selection, retain historical
 * compatibility.
 */
function verifyFinalReportImplementationCoverage(
  layout: RunLayout,
  node: PlannedGraphNode,
  report: Record<string, unknown>,
  reportPath: string
): RuntimeDiagnostic[] {
  const implementationPath = findLogicalNodeArtifact(
    layout,
    "stateful-invariant-implement-properties",
    "implemented-properties.json"
  );
  if (implementationPath === undefined) {
    return [];
  }
  const implementation = validateImplementedPropertiesSchema(readJsonFile(implementationPath), implementationPath);
  if (!implementation.ok || implementation.value === undefined || implementation.value.selection === undefined) {
    return [];
  }

  const catalog = readCanonicalPropertyCatalog(layout);
  if (catalog.diagnostics.length > 0 || catalog.value === undefined) {
    return catalog.diagnostics;
  }

  const diagnostics = verifyImplementationSelectionCoverage(
    catalog.value,
    implementation.value,
    implementationPath,
    layout,
    true
  );
  const coverage = report.property_implementation_coverage;
  if (!isRecord(coverage)) {
    diagnostics.push({
      code: "PROPERTY_REPORT_IMPLEMENTATION_COVERAGE_MISSING",
      message: "Current invariant reports must include property_implementation_coverage",
      severity: "error",
      source: "property-provenance",
      path: `${reportPath}#$.property_implementation_coverage`
    });
  } else {
    const selection = implementation.value.selection;
    const expectedIds = catalog.value.properties
      .filter(
        (property) =>
          selection.priorities.includes(property.priority) ||
          (property.reference_expectations !== undefined && property.reference_expectations.length > 0)
      )
      .map((property) => property.id);
    const recordsById = new Map(implementation.value.properties.map((record) => [record.property_id, record]));
    const expectedReferencePropertyIds = catalog.value.properties
      .filter((property) => (property.reference_expectations?.length ?? 0) > 0)
      .map((property) => property.id);
    const expectedReferenceExpectationIds = [
      ...new Set(catalog.value.properties.flatMap((property) => property.reference_expectations ?? []))
    ];
    const expectedByStatus = (status: string): string[] =>
      expectedIds.filter((propertyId) => recordsById.get(propertyId)?.status === status);
    const expectedFields: Record<string, readonly string[]> = {
      selected_property_ids: expectedIds,
      implemented_property_ids: expectedByStatus("implemented"),
      blocked_property_ids: expectedByStatus("blocked"),
      pending_property_ids: expectedByStatus("pending"),
      deferred_property_ids: expectedByStatus("deferred"),
      reference_expected_property_ids: expectedReferencePropertyIds,
      reference_expectation_ids: expectedReferenceExpectationIds,
      blocker_summaries: expectedIds.flatMap((propertyId) => {
        const record = recordsById.get(propertyId);
        if (record === undefined || record.status === "implemented" || record.blocker === undefined) return [];
        return [`${propertyId}: ${record.blocker.summary}`];
      })
    };
    const mismatches: string[] = [];
    for (const field of ["reference_expected_property_ids", "reference_expectation_ids", "blocker_summaries"]) {
      if (!Array.isArray(coverage[field])) {
        mismatches.push(field);
      }
    }
    if (coverage.priority_threshold !== selection.priority_threshold) {
      mismatches.push("priority_threshold");
    }
    if (!sameStringSequence(stringArray(coverage.priorities), selection.priorities)) {
      mismatches.push("priorities");
    }
    for (const [field, expected] of Object.entries(expectedFields)) {
      if (!sameStringSequence(stringArray(coverage[field]), expected)) {
        mismatches.push(field);
      }
    }
    if (mismatches.length > 0) {
      diagnostics.push({
        code: "PROPERTY_REPORT_IMPLEMENTATION_COVERAGE_MISMATCH",
        message: `Current invariant report coverage does not match the implementation handoff (${mismatches.join(", ")})`,
        severity: "error",
        source: "property-provenance",
        path: `${reportPath}#$.property_implementation_coverage`
      });
    }
  }

  if (node.outputs.some((output) => output.path === "report.md")) {
    const markdownPath = path.join(path.dirname(reportPath), "report.md");
    if (fs.existsSync(markdownPath)) {
      const markdown = fs.readFileSync(markdownPath, "utf8");
      const markdownLines = markdown.split(/\r?\n/u);
      let fenced = false;
      let headingLineIndex = -1;
      for (const [index, line] of markdownLines.entries()) {
        const trimmed = line.trim();
        if (/^(?:`{3,}|~{3,})/u.test(trimmed)) {
          fenced = !fenced;
          continue;
        }
        if (!fenced && trimmed === "## Property implementation coverage") {
          headingLineIndex = index;
          break;
        }
      }
      if (headingLineIndex < 0) {
        diagnostics.push({
          code: "PROPERTY_REPORT_IMPLEMENTATION_COVERAGE_MARKDOWN_MISSING",
          message: "Current invariant report Markdown must render the property implementation coverage section",
          severity: "error",
          source: "property-provenance",
          path: markdownPath
        });
      } else if (isRecord(coverage)) {
        fenced = false;
        let nextHeadingLineIndex = -1;
        for (const [index, line] of markdownLines.entries()) {
          if (index <= headingLineIndex) continue;
          const trimmed = line.trim();
          if (/^(?:`{3,}|~{3,})/u.test(trimmed)) {
            fenced = !fenced;
            continue;
          }
          if (!fenced && trimmed.startsWith("## ")) {
            nextHeadingLineIndex = index;
            break;
          }
        }
        const lines = markdownLines
          .slice(headingLineIndex + 1, nextHeadingLineIndex < 0 ? undefined : nextHeadingLineIndex)
          .map((line) => line.trim());
        const expectedCountFields: Array<[string, number]> = [
          ["Selected properties", stringArray(coverage.selected_property_ids).length],
          ["Implemented properties", stringArray(coverage.implemented_property_ids).length],
          ["Blocked properties", stringArray(coverage.blocked_property_ids).length],
          ["Pending properties", stringArray(coverage.pending_property_ids).length],
          ["Deferred properties", stringArray(coverage.deferred_property_ids).length],
          ["Reference expectation properties", stringArray(coverage.reference_expected_property_ids).length]
        ];
        const markdownMismatches: string[] = [];
        const expectedThreshold =
          typeof coverage.priority_threshold === "string" ? coverage.priority_threshold : "unavailable";
        const thresholdLine = lines.find((line) => line.startsWith("- Priority threshold:"));
        if (thresholdLine !== `- Priority threshold: \`${expectedThreshold}\``) {
          markdownMismatches.push("priority_threshold");
        }
        const expectedPriorities = stringArray(coverage.priorities);
        const includedPrioritiesLine = lines.find((line) => line.startsWith("- Included priorities:"));
        const renderedPriorities = expectedPriorities.length > 0 ? expectedPriorities.join("<br>") : "unavailable";
        if (includedPrioritiesLine !== `- Included priorities: \`${renderedPriorities}\``) {
          markdownMismatches.push("priorities");
        }
        for (const [label, expectedCount] of expectedCountFields) {
          const prefix = `- ${label}:`;
          const line = lines.find((candidate) => candidate.startsWith(prefix));
          if (line !== `- ${label}: \`${expectedCount}\``) {
            markdownMismatches.push(label);
          }
        }
        const expectedBlockerSummaries = stringArray(coverage.blocker_summaries);
        const blockerHeadingIndex = lines.indexOf("Blocker summaries:");
        const renderedBlockers: string[] = [];
        if (blockerHeadingIndex >= 0) {
          for (const line of lines.slice(blockerHeadingIndex + 1)) {
            if (!line.startsWith("- ")) break;
            renderedBlockers.push(line);
          }
        }
        const expectedRenderedBlockers = expectedBlockerSummaries.map((summary) => `- ${reportPublicProse(summary)}`);
        if (
          renderedBlockers.length !== expectedRenderedBlockers.length ||
          expectedRenderedBlockers.some((summary, index) => renderedBlockers[index] !== summary)
        ) {
          markdownMismatches.push("blocker_summaries");
        }
        if (markdownMismatches.length > 0) {
          diagnostics.push({
            code: "PROPERTY_REPORT_IMPLEMENTATION_COVERAGE_MARKDOWN_MISMATCH",
            message: `Current invariant report Markdown coverage does not match report.json (${markdownMismatches.join(", ")})`,
            severity: "error",
            source: "property-provenance",
            path: markdownPath
          });
        }
      }
    }
  }
  return diagnostics;
}

function reportPropertyJoinDiagnostics(
  entries: unknown[],
  catalog: PropertiesArtifact,
  implementation: ImplementedPropertiesArtifact,
  fuzzerBackendsByFinding: ReadonlyMap<string, readonly string[]>,
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

    const expectedBackends =
      typeof entry.finding_id === "string" ? (fuzzerBackendsByFinding.get(entry.finding_id) ?? []) : [];
    const actualBackends = Array.isArray(entry.fuzzer_backends)
      ? stringArray(entry.fuzzer_backends)
      : typeof entry.fuzzer_backend === "string"
        ? [entry.fuzzer_backend]
        : [];
    addReportJoinMismatch(
      diagnostics,
      sameStringSet(expectedBackends, actualBackends),
      "PROPERTY_REPORT_FUZZER_BACKEND_MISMATCH",
      "Report fuzzer backends do not match the campaign records",
      `${reportPath}#$.property_provenance[${entryIndex}].${Array.isArray(entry.fuzzer_backends) ? "fuzzer_backends" : "fuzzer_backend"}`
    );
  }
  return diagnostics;
}

function readCampaignFuzzerBackends(layout: RunLayout): ReadonlyMap<string, readonly string[]> {
  const backendsByFinding = new Map<string, Set<string>>();
  for (const nodeId of campaignLogicalNodeIds) {
    for (const artifactName of campaignResultArtifactNames) {
      const campaignPath = findLogicalNodeArtifact(layout, nodeId, artifactName);
      if (campaignPath === undefined) {
        continue;
      }
      const result = validatePropertyCampaignSchema(readJsonFile(campaignPath), campaignPath);
      if (result.value?.fuzzer_backend === undefined) {
        continue;
      }
      for (const failure of result.value.failures) {
        const backends = backendsByFinding.get(failure.id) ?? new Set<string>();
        backends.add(result.value.fuzzer_backend);
        backendsByFinding.set(failure.id, backends);
      }
    }
  }
  return new Map([...backendsByFinding].map(([findingId, backends]) => [findingId, [...backends].sort()]));
}

function propertySourceKey(source: { source_node_id?: unknown; source_property_id?: unknown }): string {
  return `${String(source.source_node_id)}\u0000${String(source.source_property_id)}`;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function reportPublicProse(value: string): string {
  const redacted = redactValue(value);
  const safe = typeof redacted === "string" ? redacted : "<redacted>";
  const pathRedacted = [
    /(^|[\s("'`])\/(?:home|Users|tmp|var|private|root|opt|mnt|workspace|workspaces)(?:\/[^\s"'`()[\]{}<>]*)?/gmu,
    /(^|[\s("'`])(?:\.ultrafuzz|artifacts|workspaces|generated-tests)\/[^\s"'`()[\]{}<>]*/gmu,
    /(^|[\s("'`])[A-Za-z]:\\(?:Users|Temp|Windows|workspace|workspaces)\\[^\s"'`()[\]{}<>]*/gmu
  ].reduce(
    (current, pattern) => current.replace(pattern, (_match, prefix: string) => `${prefix}[redacted-path]`),
    safe
  );
  return pathRedacted
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

function sameStringSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
  for (const [failureIndex, failure] of failures.entries()) {
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

  return diagnostics;
}

/**
 * Reports findings that no campaign record explains. This must be judged once
 * against the union of every campaign record in the node: when a node runs more
 * than one backend, a failure observed by one backend is legitimately absent
 * from the other backend's record.
 */
function danglingCampaignFindingDiagnostics(
  failureIds: ReadonlySet<string>,
  findings: Array<Record<string, unknown>>,
  findingsPath: string
): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  for (const [findingIndex, finding] of findings.entries()) {
    if (typeof finding.id !== "string" || failureIds.has(finding.id)) {
      continue;
    }
    const propertyIds = Array.isArray(finding.property_ids)
      ? finding.property_ids.filter((propertyId): propertyId is string => typeof propertyId === "string")
      : [];
    if (propertyIds.length === 0) {
      continue;
    }
    diagnostics.push({
      code: "PROPERTY_CAMPAIGN_REFERENCE_MISSING",
      message: `Property-derived finding ${JSON.stringify(finding.id)} has no campaign failure with the same ID`,
      severity: "error",
      source: "property-provenance",
      path: `${findingsPath}#$[${findingIndex}].id`
    });
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

function findDependencyArtifact(
  layout: RunLayout,
  dependencyId: string,
  logicalNodeId: string,
  fileName: string
): string | undefined {
  const concretePath = path.join(getNodeArtifactDir(layout, dependencyId), fileName);
  if (fs.existsSync(concretePath)) {
    return concretePath;
  }
  // A persisted concrete node proves that this run was expanded. In that
  // case, do not satisfy the dependency from a stale logical-ID artifact.
  const state = readRunState(layout);
  if (dependencyId !== logicalNodeId && state.nodes[dependencyId] !== undefined) {
    return undefined;
  }
  return findLogicalNodeArtifact(layout, logicalNodeId, fileName);
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
