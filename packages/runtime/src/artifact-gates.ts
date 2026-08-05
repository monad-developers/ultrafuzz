import crypto from "node:crypto";
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
  validateInvariantLedgerSchema,
  validateInvariantSourceProofSchema,
  validateImplementedPropertiesSchema,
  validatePropertiesSchema,
  validatePropertyCampaignSchema,
  validatePropertyReferences,
  verifyArtifactManifestPrerequisites,
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
      // Probe paths may intentionally name optional files; the probe result
      // records absence, so containment is the invariant we can enforce.
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
    // Probe paths may intentionally name optional files; the probe result
    // records absence, so containment is the invariant we can enforce.
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
      const block = markdownDelimitedBlock(markdown, `### Ledger entry: ${entry.id}`);
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
        const rowBlock = markdownDelimitedBlock(markdown, `### Inventory row: ${inventoryId}`);
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
  if (ledger.value.entries.length === 0 && (ledger.value.scan_probes?.length ?? 0) > 0) {
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
      for (const [propertyIndex, property] of catalog.value.properties.entries()) {
        for (const ledgerId of property.ledger_ids ?? []) {
          const block = markdownDelimitedBlock(markdown, `### Canonical property: ${property.id}`);
          if (block !== undefined && markdownContainsToken(block, ledgerId)) {
            continue;
          }
          diagnostics.push({
            code: "INVARIANT_LEDGER_MARKDOWN_MAPPING_MISSING",
            message: `Properties Markdown must preserve canonical property ${JSON.stringify(property.id)} and ledger ID ${JSON.stringify(ledgerId)}`,
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

function verifyInvariantProbePath(
  workspacePath: string,
  relativePath: string,
  probeIndex: number,
  ledgerPath: string,
  diagnostics: RuntimeDiagnostic[]
): void {
  const probePath = path.resolve(workspacePath, relativePath);
  const diagnosticPath = `${ledgerPath}#$.scan_probes[${probeIndex}].source_path`;
  if (probePath === workspacePath || !probePath.startsWith(`${workspacePath}${path.sep}`)) {
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
    const stat = fs.lstatSync(probePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      diagnostics.push({
        code: "INVARIANT_LEDGER_PROBE_PATH_INVALID",
        message: `Invariant scan probe path must be a regular file when present: ${relativePath}`,
        severity: "error",
        source: "invariant-ledger",
        path: diagnosticPath
      });
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    diagnostics.push(diagnosticFromError(error, "invariant-ledger", "INVARIANT_LEDGER_PROBE_PATH_INVALID"));
  }
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
    if (!normalizeInvariantSourceText(declaration).includes(normalizeInvariantSourceLines([entry.verbatim]))) {
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
  const lines = source.split(/\r?\n/u).slice(Math.max(0, startLine - 1), endLine);
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

function normalizeInvariantSourceText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizeInvariantSourceLines(lines: readonly string[]): string {
  return normalizeInvariantSourceText(lines.map((line) => line.replace(/^\s*(?:[-*+]\s+|>\s+)/u, "").trim()).join(" "));
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

function markdownDelimitedBlock(markdown: string, marker: string): string | undefined {
  const markerPattern = new RegExp(`^${escapeRegExp(marker)}[ \\t]*$`, "mu");
  const match = markerPattern.exec(markdown);
  if (match === null || match.index === undefined) {
    return undefined;
  }
  const start = match.index;
  const endMarker = marker
    .replace("### Ledger entry:", "### End ledger entry:")
    .replace("### Inventory row:", "### End inventory row:")
    .replace("### Canonical property:", "### End canonical property:");
  const endPattern = new RegExp(`^${escapeRegExp(endMarker)}[ \\t]*$`, "mu");
  endPattern.lastIndex = start + match[0].length;
  const endMatch = endPattern.exec(markdown);
  if (endMatch === null || endMatch.index === undefined) {
    return undefined;
  }
  return markdown.slice(start, endMatch.index + endMatch[0].length);
}

function markdownContainsToken(markdown: string, token: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9._-])${escapeRegExp(token)}(?![A-Za-z0-9._-])`, "u").test(markdown);
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
  if (logicalId === "final-report") {
    return verifyFinalReportPropertyReferences(layout, artifactDir);
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

function verifyFinalReportPropertyReferences(layout: RunLayout, artifactDir: string): RuntimeDiagnostic[] {
  const reportPath = path.join(artifactDir, "report.json");
  if (!fs.existsSync(reportPath)) {
    return [];
  }
  const report = readJsonFile(reportPath);
  if (!isRecord(report) || !Array.isArray(report.property_provenance)) {
    return [];
  }
  if (report.property_provenance.length === 0) {
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
