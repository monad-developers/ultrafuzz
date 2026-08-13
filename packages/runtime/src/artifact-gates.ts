import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  artifactContractDefinition,
  artifactContractSchemaBinding,
  artifactSchemaDirectory,
  artifactSchemaRegistry,
  assertArtifactVerificationMarkerSemantics,
  assertNoSymlinkComponents,
  assertPlannedGraph,
  assertRegularFileInside,
  checkInvariantSourcePinned,
  derivePropertyImplementationCoverage,
  executeSemanticGate,
  getNodeArtifactDir,
  getNodeWorkspaceDir,
  findingFuzzerBackendProvenance,
  invariantPinnedSourceRefExists,
  IMPLEMENTED_PROPERTIES_SCHEMA_VERSION,
  MAX_COVERAGE_EVIDENCE_FILES,
  MAX_COVERAGE_EVIDENCE_RANGES,
  MAX_PROPERTY_CAMPAIGN_EVIDENCE_FILE_BYTES,
  PROPERTIES_SCHEMA_VERSION,
  readArtifactManifest,
  readRegularFileSnapshot,
  readSinglyLinkedRegularFileSnapshotInside,
  readRunState,
  parseStrictJsonBytes,
  redactValue,
  resolveCampaignFindingBackends,
  safeResolveInside,
  sha256Bytes,
  updateNodeState,
  validateArtifactContractBytes,
  validateArtifactVerificationMarker,
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
  validateRegisteredJsonBytesSync,
  validateRegisteredJsonSchema,
  verifyArtifactManifestPrerequisites,
  type ArtifactSchemaFilename,
  type ArtifactVerificationMarker,
  type ImplementedPropertiesArtifact,
  type InvariantLedgerEntry,
  type InvariantSourceProof,
  type LensPropertiesArtifact,
  type PropertiesArtifact,
  type PropertyCampaignArtifact,
  type PropertyReferenceInput,
  type RunLayout,
  type RunState,
  type SmithersTaskManifestOutput,
  type SmithersTaskManifestTask,
  type NodeProvenanceReasonCode,
  type NodeOutputContract,
  type SemanticArtifactSetContext,
  type SemanticDifferentialArtifactBinding,
  type SemanticGateContext,
  type SemanticGitContext,
  type SemanticPropertyLensContext,
  type SemanticPropertyCampaignEvidenceContext,
  type SemanticPropertyCampaignTimeoutContext,
  type SemanticReviewStageContext,
  type WorkspacePatchManifest
} from "@ultrafuzz/artifacts";
import { parseProjectConfigToml } from "@ultrafuzz/config";

import { authenticatedAggregationSemanticContext } from "./aggregation-semantic-context.js";
import {
  canonicalPropertiesMarkdownParityIssues,
  invariantLedgerMarkdownParityIssues
} from "./canonical-properties-markdown.js";
import {
  declaredAncestorOutputsByContract,
  declaredSiblingOutputsByContract,
  type SemanticArtifactTaskDeclaration
} from "./semantic-artifact-context.js";
import { runtimeSemanticGateDiagnostics } from "./semantic-gates.js";
import { WORKSPACE_PATCH_BASELINE_JSON_SCHEMA_ID } from "./runtime-contracts.js";
import { parseRuntimeDocumentBytes } from "./runtime-document-codec.js";
import type { PlannedGraph, PlannedGraphNode, RuntimeDiagnostic } from "./types.js";
import { topologyRuntimeBudgetForTimeout } from "./topology-runtime-budget.js";
import { diagnosticFromError } from "./utils.js";
import { validateSeverityMatrixArtifact, type SeverityArtifactKind } from "./severity-matrix.js";
import { deriveWorkspacePatchGitFacts } from "./workspace-handoff.js";
import { loadFinalizedNodeOutputSnapshot, type VerifiedOutputArtifactSnapshot } from "./verified-output.js";
import { renderCoverageEvidenceMarkdownSection } from "./final-report-markdown.js";

const MAX_ARTIFACT_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const PROPERTY_LENS_CONTRACT = "ultrafuzz/property-lens@2" as const;
const ARTIFACT_VERIFICATION_DIRECTORY = ".ultrafuzz-verification";
const INVARIANT_LEDGER_CONTRACT = "ultrafuzz/invariant-ledger@1" as const;
const INVARIANT_LEDGER_CONVENTIONAL_PATH = "setup/invariant-evidence-ledger.json";
const DISCOVERY_MARKDOWN_CONVENTIONAL_PATH = "setup/project-discovery.md";
const CANONICAL_PROPERTIES_CONTRACT = "ultrafuzz/properties@2" as const;
const CANONICAL_PROPERTIES_CONVENTIONAL_PATH = "properties.json";
const CANONICAL_PROPERTIES_MARKDOWN_CONTRACT = "ultrafuzz/nonempty-markdown@1" as const;
const CANONICAL_PROPERTIES_MARKDOWN_CONVENTIONAL_PATH = "properties.md";

// These are semantic projections for topologies that deliberately omit the
// corresponding producer. They are never written or published as artifacts;
// a planned producer that is missing or malformed must not reach either value.
const UNPLANNED_PROPERTY_CATALOG_CONTEXT = {
  schema_version: PROPERTIES_SCHEMA_VERSION,
  properties: []
} satisfies PropertiesArtifact;
const UNPLANNED_IMPLEMENTED_PROPERTIES_CONTEXT = {
  schema_version: IMPLEMENTED_PROPERTIES_SCHEMA_VERSION,
  selection: { priority_threshold: "high", priorities: ["high"], property_ids: [] },
  properties: []
} satisfies ImplementedPropertiesArtifact;
const UNPLANNED_IMPLEMENTATION_COVERAGE = {
  status: "not-planned",
  reason: "property-implementation-track-not-declared"
} as const;

export type DependencyGateDecision =
  | { ok: true }
  | {
      ok: false;
      reason_code: NodeProvenanceReasonCode;
      reason: string;
      blocked_by: string[];
    };

export interface RequiredArtifactGate {
  ok: boolean;
  diagnostics: RuntimeDiagnostic[];
  missing: string[];
}

/** Exact sealed Smithers attempt declarations available during workflow synchronization. */
export interface ArtifactGateAttemptAuthority {
  task: SmithersTaskManifestTask;
  tasks: readonly SmithersTaskManifestTask[];
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

export interface AuthenticatedArtifactGateSnapshot {
  absolutePath: string;
  bytes: Buffer;
}

export interface AuthenticatedArtifactGateSnapshots {
  outputs: ReadonlyMap<string, AuthenticatedArtifactGateSnapshot>;
  publications: ReadonlyMap<string, Uint8Array>;
  files?: ReadonlyMap<string, Uint8Array>;
}

/**
 * Read a current-node artifact from one authority for the whole gate pass.
 * Once authenticated snapshots are supplied, the mutable artifact directory
 * is no longer an admissible source, including for optional Markdown and
 * generated-test companions.
 */
function readCurrentArtifactSnapshot(
  artifactDir: string,
  absolutePath: string,
  authenticated?: AuthenticatedArtifactGateSnapshots
): Buffer | undefined {
  const relativeNativePath = path.relative(path.resolve(artifactDir), path.resolve(absolutePath));
  if (
    relativeNativePath === "" ||
    path.isAbsolute(relativeNativePath) ||
    relativeNativePath === ".." ||
    relativeNativePath.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`current artifact path escapes its artifact directory: ${absolutePath}`);
  }
  const relativePath = relativeNativePath.split(path.sep).join(path.posix.sep);
  if (authenticated !== undefined) {
    const output = authenticated.outputs.get(relativePath);
    const publication = authenticated.publications.get(relativePath);
    const file = authenticated.files?.get(relativePath);
    if (output !== undefined && output.absolutePath !== absolutePath) {
      throw new Error(`authenticated current artifact path does not match its declaration: ${relativePath}`);
    }
    const snapshots = [output?.bytes, publication, file].filter(
      (snapshot): snapshot is Uint8Array => snapshot !== undefined
    );
    if (snapshots.some((snapshot) => !Buffer.from(snapshot).equals(Buffer.from(snapshots[0]!)))) {
      throw new Error(`authenticated current artifact snapshots disagree: ${relativePath}`);
    }
    const bytes = snapshots[0];
    if (bytes === undefined) return undefined;
    if (bytes.byteLength > MAX_ARTIFACT_SNAPSHOT_BYTES) {
      throw new Error(`authenticated current artifact exceeds snapshot limit: ${relativePath}`);
    }
    return Buffer.from(bytes);
  }
  if (!fs.existsSync(absolutePath)) return undefined;
  assertRegularFileInside(artifactDir, absolutePath, "current artifact");
  return readRegularFileSnapshot(absolutePath, MAX_ARTIFACT_SNAPSHOT_BYTES);
}

function parseCurrentArtifactJson(
  artifactDir: string,
  absolutePath: string,
  authenticated?: AuthenticatedArtifactGateSnapshots
): unknown | undefined {
  const bytes = readCurrentArtifactSnapshot(artifactDir, absolutePath, authenticated);
  return bytes === undefined ? undefined : parseStrictJsonBytes(bytes);
}

export function verifyRequiredArtifactsForNode(layout: RunLayout, node: PlannedGraphNode): RequiredArtifactGate {
  return verifyRequiredArtifactsForAttempt(layout, node, node.id);
}

export function verifyRequiredArtifactsForAttempt(
  layout: RunLayout,
  node: PlannedGraphNode,
  attemptId: string,
  attemptAuthority?: ArtifactGateAttemptAuthority,
  authenticated?: AuthenticatedArtifactGateSnapshots
): RequiredArtifactGate {
  const diagnostics: RuntimeDiagnostic[] = [];
  const missing: string[] = [];
  if (
    node.outputs.some((output) => output.contract === "ultrafuzz/implemented-properties@3") &&
    node.outputs.some((output) => output.contract === "ultrafuzz/property-campaign@3")
  ) {
    diagnostics.push({
      code: "PROPERTY_ROLE_DECLARATION_CONFLICT",
      message: `Node ${node.id} must not declare both ultrafuzz/implemented-properties@3 and ultrafuzz/property-campaign@3; split implementation and campaign into dependency-ordered nodes`,
      severity: "error",
      source: "property-provenance",
      path: layout.graphPath
    });
    return { ok: false, diagnostics, missing };
  }
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
      const authenticatedOutput = authenticated?.outputs.get(required);
      if (authenticated !== undefined && authenticatedOutput === undefined) {
        missing.push(required);
        diagnostics.push({
          code: "REQUIRED_ARTIFACT_MISSING",
          message: `authenticated required artifact ${required} is unavailable for ${attemptId}`,
          severity: "error",
          source: "artifact-gates",
          path: path.posix.join("artifacts", attemptId, required)
        });
      } else if (authenticated === undefined && !fs.existsSync(absolutePath)) {
        missing.push(required);
        diagnostics.push({
          code: "REQUIRED_ARTIFACT_MISSING",
          message: `required artifact ${required} was not produced by ${attemptId}`,
          severity: "error",
          source: "artifact-gates",
          path: path.posix.join("artifacts", attemptId, required)
        });
      } else {
        if (authenticatedOutput !== undefined && authenticatedOutput.absolutePath !== absolutePath) {
          throw new Error(`authenticated required artifact path does not match its declaration: ${required}`);
        }
        if (authenticated === undefined) assertRegularFileInside(artifactDir, absolutePath, "required artifact");
        diagnostics.push(
          ...verifyRequiredArtifactShape(
            layout,
            artifactDir,
            absolutePath,
            output,
            node,
            attemptId,
            attemptAuthority,
            authenticated
          )
        );
      }
    } catch (error) {
      diagnostics.push(diagnosticFromError(error, "artifact-gates", "REQUIRED_ARTIFACT_INVALID"));
    }
  }
  diagnostics.push(...verifySeverityMatrixArtifacts(artifactDir, node, authenticated));
  try {
    diagnostics.push(...verifyInvariantEvidenceArtifacts(layout, artifactDir, node, attemptAuthority, authenticated));
  } catch (error) {
    diagnostics.push(diagnosticFromError(error, "invariant-ledger", "INVARIANT_EVIDENCE_READ_FAILED"));
  }
  try {
    diagnostics.push(
      ...verifyPropertyProvenanceArtifacts(layout, artifactDir, node, attemptId, attemptAuthority, authenticated)
    );
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
function declaredInvariantLedgerProducerPair(node: PlannedGraphNode):
  | {
      ledger?: PlannedGraphNode["outputs"][number];
      markdown?: PlannedGraphNode["outputs"][number];
      diagnostics: RuntimeDiagnostic[];
    }
  | undefined {
  const ledgerOutputs = node.outputs.filter((output) => output.contract === INVARIANT_LEDGER_CONTRACT);
  const wrongContractLookalikes = node.outputs.filter(
    (output) =>
      (output.path === INVARIANT_LEDGER_CONVENTIONAL_PATH && output.contract !== INVARIANT_LEDGER_CONTRACT) ||
      (output.path === DISCOVERY_MARKDOWN_CONVENTIONAL_PATH &&
        output.contract !== CANONICAL_PROPERTIES_MARKDOWN_CONTRACT)
  );
  const hasConventionalRolePath = node.outputs.some(
    (output) =>
      output.path === INVARIANT_LEDGER_CONVENTIONAL_PATH || output.path === DISCOVERY_MARKDOWN_CONVENTIONAL_PATH
  );
  if (ledgerOutputs.length === 0 && !hasConventionalRolePath) return undefined;

  const diagnostics: RuntimeDiagnostic[] = wrongContractLookalikes.map((output) => ({
    code: "INVARIANT_LEDGER_DECLARATION_WRONG_CONTRACT",
    message: `Project discovery lookalike ${JSON.stringify(output.path)} has the wrong contract ${output.contract}`,
    severity: "error",
    source: "invariant-ledger",
    path: output.path
  }));
  if (ledgerOutputs.length !== 1) {
    diagnostics.push({
      code:
        ledgerOutputs.length === 0 ? "INVARIANT_LEDGER_DECLARATION_MISSING" : "INVARIANT_LEDGER_DECLARATION_AMBIGUOUS",
      message: `Invariant ledger producer must declare exactly one ${INVARIANT_LEDGER_CONTRACT} output; found ${ledgerOutputs.length}`,
      severity: "error",
      source: "invariant-ledger"
    });
  }
  const markdownOutputs = node.outputs.filter((output) => output.contract === CANONICAL_PROPERTIES_MARKDOWN_CONTRACT);
  if (markdownOutputs.length !== 1) {
    diagnostics.push({
      code:
        markdownOutputs.length === 0
          ? "INVARIANT_LEDGER_MARKDOWN_DECLARATION_MISSING"
          : "INVARIANT_LEDGER_MARKDOWN_DECLARATION_AMBIGUOUS",
      message: `Invariant ledger producer must declare exactly one ${CANONICAL_PROPERTIES_MARKDOWN_CONTRACT} Markdown handoff; found ${markdownOutputs.length}`,
      severity: "error",
      source: "invariant-ledger"
    });
  }
  return {
    ledger: ledgerOutputs.length === 1 ? ledgerOutputs[0] : undefined,
    markdown: markdownOutputs.length === 1 ? markdownOutputs[0] : undefined,
    diagnostics
  };
}

function declaredCanonicalPropertiesPair(node: PlannedGraphNode):
  | {
      catalog?: PlannedGraphNode["outputs"][number];
      markdown?: PlannedGraphNode["outputs"][number];
      diagnostics: RuntimeDiagnostic[];
    }
  | undefined {
  const catalogOutputs = node.outputs.filter((output) => output.contract === CANONICAL_PROPERTIES_CONTRACT);
  const hasConventionalRolePath = node.outputs.some(
    (output) =>
      output.path === CANONICAL_PROPERTIES_CONVENTIONAL_PATH ||
      output.path === CANONICAL_PROPERTIES_MARKDOWN_CONVENTIONAL_PATH
  );
  if (catalogOutputs.length === 0 && !hasConventionalRolePath) return undefined;
  const diagnostics: RuntimeDiagnostic[] = node.outputs
    .filter(
      (output) =>
        output.path === CANONICAL_PROPERTIES_CONVENTIONAL_PATH && output.contract !== CANONICAL_PROPERTIES_CONTRACT
    )
    .map((output) => ({
      code: "PROPERTY_CATALOG_DECLARATION_WRONG_CONTRACT",
      message: `Canonical property catalog lookalike ${JSON.stringify(output.path)} must declare contract ${CANONICAL_PROPERTIES_CONTRACT}, not ${output.contract}`,
      severity: "error" as const,
      source: "property-fanin",
      path: output.path
    }));
  if (catalogOutputs.length === 0) {
    diagnostics.push({
      code: "PROPERTY_CATALOG_DECLARATION_MISSING",
      message: `Canonical property producer must declare exactly one ${CANONICAL_PROPERTIES_CONTRACT} output; found none`,
      severity: "error",
      source: "property-fanin"
    });
  }
  if (catalogOutputs.length > 1) {
    diagnostics.push({
      code: "PROPERTY_CATALOG_DECLARATION_AMBIGUOUS",
      message: `Canonical property producer must declare exactly one ${CANONICAL_PROPERTIES_CONTRACT} output; found ${catalogOutputs.length}`,
      severity: "error",
      source: "property-fanin"
    });
  }
  const wrongContractLookalikes = node.outputs.filter(
    (output) =>
      output.path === CANONICAL_PROPERTIES_MARKDOWN_CONVENTIONAL_PATH &&
      output.contract !== CANONICAL_PROPERTIES_MARKDOWN_CONTRACT
  );
  diagnostics.push(
    ...wrongContractLookalikes.map((output): RuntimeDiagnostic => ({
      code: "PROPERTY_MARKDOWN_DECLARATION_WRONG_CONTRACT",
      message: `Canonical properties Markdown lookalike ${JSON.stringify(output.path)} must declare contract ${CANONICAL_PROPERTIES_MARKDOWN_CONTRACT}, not ${output.contract}`,
      severity: "error",
      source: "property-fanin",
      path: output.path
    }))
  );
  const markdownOutputs = node.outputs.filter((output) => output.contract === CANONICAL_PROPERTIES_MARKDOWN_CONTRACT);
  if (markdownOutputs.length !== 1) {
    diagnostics.push({
      code:
        markdownOutputs.length === 0
          ? "PROPERTY_MARKDOWN_DECLARATION_MISSING"
          : "PROPERTY_MARKDOWN_DECLARATION_AMBIGUOUS",
      message: `Canonical property producer must declare exactly one ${CANONICAL_PROPERTIES_MARKDOWN_CONTRACT} companion; found ${markdownOutputs.length}`,
      severity: "error",
      source: "property-fanin"
    });
  }
  return {
    catalog: catalogOutputs.length === 1 ? catalogOutputs[0] : undefined,
    markdown: markdownOutputs.length === 1 ? markdownOutputs[0] : undefined,
    diagnostics
  };
}

function verifyInvariantEvidenceArtifacts(
  layout: RunLayout,
  artifactDir: string,
  node: PlannedGraphNode,
  attemptAuthority?: ArtifactGateAttemptAuthority,
  authenticated?: AuthenticatedArtifactGateSnapshots
): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  try {
    diagnostics.push(
      ...verifyInvariantLedgerProducerArtifacts(layout, artifactDir, node, attemptAuthority, authenticated)
    );
  } catch (error) {
    diagnostics.push(diagnosticFromError(error, "invariant-ledger", "INVARIANT_EVIDENCE_READ_FAILED"));
  }
  try {
    diagnostics.push(
      ...verifyCanonicalPropertiesProducerArtifacts(layout, artifactDir, node, attemptAuthority, authenticated)
    );
  } catch (error) {
    diagnostics.push(diagnosticFromError(error, "property-fanin", "PROPERTY_CATALOG_READ_FAILED"));
  }
  return diagnostics;
}

function verifyInvariantLedgerProducerArtifacts(
  layout: RunLayout,
  artifactDir: string,
  node: PlannedGraphNode,
  attemptAuthority?: ArtifactGateAttemptAuthority,
  authenticated?: AuthenticatedArtifactGateSnapshots
): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  const invariantProducer = declaredInvariantLedgerProducerPair(node);
  if (invariantProducer === undefined) return diagnostics;
  diagnostics.push(...invariantProducer.diagnostics);
  if (invariantProducer.ledger === undefined || invariantProducer.markdown === undefined) return diagnostics;
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return diagnostics;
  const ledgerPath = safeResolveInside(artifactDir, invariantProducer.ledger.path, "invariant ledger output");
  const markdownPath = safeResolveInside(
    artifactDir,
    invariantProducer.markdown.path,
    "invariant ledger Markdown handoff"
  );
  const ledgerBytes = readCurrentArtifactSnapshot(artifactDir, ledgerPath, authenticated);
  const markdownBytes = readCurrentArtifactSnapshot(artifactDir, markdownPath, authenticated);
  if (ledgerBytes === undefined || markdownBytes === undefined) {
    return diagnostics;
  }
  const parsed = validateInvariantLedgerSchema(parseStrictJsonBytes(ledgerBytes), ledgerPath);
  if (!parsed.ok || parsed.value === undefined) {
    return diagnostics;
  }
  diagnostics.push(
    ...invariantLedgerMarkdownParityIssues(parsed.value, markdownBytes.toString("utf8"), markdownPath).map((issue) => ({
      ...issue,
      severity: "error" as const
    }))
  );
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
      readInvariantSourceProof(sourceProofPath, ledgerPath, ledgerBytes, diagnostics);
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
    ? readInvariantSourceProof(sourceProofPath, ledgerPath, ledgerBytes, diagnostics)
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
  for (const [entryIndex, entry] of parsed.value.entries.entries()) {
    if (sourceProof !== undefined) {
      verifyInvariantSourceProofEvidence(sourceProof, entry, entryIndex, ledgerPath, diagnostics);
    } else if (!sourceProofPresent && fs.existsSync(discoveryWorkspace)) {
      verifyInvariantSourceEvidence(discoveryWorkspace, entry, entryIndex, ledgerPath, diagnostics);
    }
  }
  return diagnostics;
}

function verifyCanonicalPropertiesProducerArtifacts(
  layout: RunLayout,
  artifactDir: string,
  node: PlannedGraphNode,
  attemptAuthority?: ArtifactGateAttemptAuthority,
  authenticated?: AuthenticatedArtifactGateSnapshots
): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  const canonicalPair = declaredCanonicalPropertiesPair(node);
  if (canonicalPair === undefined) return diagnostics;
  diagnostics.push(
    ...canonicalPair.diagnostics.map((diagnostic) => ({ ...diagnostic, path: diagnostic.path ?? layout.graphPath }))
  );
  if (canonicalPair.catalog === undefined || canonicalPair.markdown === undefined) return diagnostics;
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return diagnostics;
  const catalogPath = safeResolveInside(artifactDir, canonicalPair.catalog.path, "canonical property catalog output");
  const canonicalMarkdownPath = safeResolveInside(
    artifactDir,
    canonicalPair.markdown.path,
    "canonical property Markdown output"
  );
  let ledgerProducer: FinalizedDeclaredProducer | undefined;
  let ledgerArtifact: VerifiedOutputArtifactSnapshot | undefined;
  try {
    const ledgerProducers = finalizedDeclaredContractProducers(
      layout,
      "ultrafuzz/invariant-ledger@1",
      node,
      attemptAuthority
    );
    const ledgerArtifacts = ledgerProducers.flatMap((producer) =>
      producer.outputs.map((output) => ({ producer, output }))
    );
    if (ledgerArtifacts.length > 1) {
      diagnostics.push({
        code: "INVARIANT_LEDGER_DECLARATION_AMBIGUOUS",
        message: `Property fan-in requires exactly one finalized declared ${INVARIANT_LEDGER_CONTRACT} output; found ${ledgerArtifacts.length}`,
        severity: "error",
        source: "invariant-ledger",
        path: catalogPath
      });
      return diagnostics;
    }
    if (ledgerArtifacts.length === 1) {
      ledgerProducer = ledgerArtifacts[0]!.producer;
      ledgerArtifact = ledgerArtifacts[0]!.output;
    }
  } catch (error) {
    diagnostics.push(diagnosticFromError(error, "invariant-ledger", "INVARIANT_LEDGER_AUTHORITY_INVALID"));
    return diagnostics;
  }
  if (ledgerProducer === undefined || ledgerArtifact === undefined) {
    diagnostics.push({
      code: "INVARIANT_LEDGER_MISSING",
      message: "Property fan-in requires exactly one finalized declared invariant evidence ledger",
      severity: "error",
      source: "invariant-ledger",
      path: catalogPath
    });
    return diagnostics;
  }
  const declaredLedgerPair = declaredInvariantLedgerProducerPair(ledgerProducer.node);
  if (
    declaredLedgerPair === undefined ||
    declaredLedgerPair.ledger?.path !== ledgerArtifact.path ||
    declaredLedgerPair.diagnostics.some((diagnostic) => diagnostic.severity === "error")
  ) {
    diagnostics.push(...(declaredLedgerPair?.diagnostics ?? []), {
      code: "INVARIANT_LEDGER_AUTHORITY_INVALID",
      message: "Property fan-in invariant ledger authority does not match one exact typed producer declaration",
      severity: "error",
      source: "invariant-ledger",
      path: ledgerArtifact.absolute_path
    });
    return diagnostics;
  }
  const catalogDocument = parseCurrentArtifactJson(artifactDir, catalogPath, authenticated);
  if (catalogDocument === undefined) {
    return diagnostics;
  }
  const ledgerPath = ledgerArtifact.absolute_path;
  const ledger = validateInvariantLedgerSchema(ledgerArtifact.value, ledgerPath);
  const catalog = validatePropertiesSchema(catalogDocument, catalogPath);
  if (!ledger.ok || ledger.value === undefined || !catalog.ok || catalog.value === undefined) {
    return diagnostics;
  }
  const markdownBytes = readCurrentArtifactSnapshot(artifactDir, canonicalMarkdownPath, authenticated);
  if (markdownBytes !== undefined) {
    diagnostics.push(
      ...canonicalPropertiesMarkdownParityIssues(
        catalog.value,
        markdownBytes.toString("utf8"),
        canonicalMarkdownPath
      ).map((issue) => ({ ...issue, severity: "error" as const }))
    );
  }
  diagnostics.push(
    ...verifyLensReferenceExpectationPreservation(layout, node, catalog.value, catalogPath, attemptAuthority)
  );
  // Fan-in re-checks probe containment on the SAME ledger discovery published (issue #292). It used
  // to check none: every shape of the ledger returned before reaching a `verifyInvariantProbePath`
  // call, so an escaping probe path only ever had to survive the discovery node. The ledger lives in
  // discovery's artifact directory, so its workspace is the one the probes are relative to; when
  // that workspace has already been reclaimed the check is a no-op, exactly as it is on discovery.
  const discoveryWorkspace = path.join(layout.workspacesDir, ledgerProducer.authority.attempt_id);
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

function isSyntheticLedgerDependency(node: PlannedGraphNode): boolean {
  return (
    node.outputs.some((output) => output.contract === "ultrafuzz/invariant-ledger@1") &&
    !node.outputs.some((output) => output.contract === PROPERTY_LENS_CONTRACT)
  );
}

type DeclaredPropertyLensResolution =
  { ok: true; output: NodeOutputContract } | { ok: false; diagnostic: RuntimeDiagnostic };

function resolveStateDeclaredPropertyLens(
  state: RunState,
  nodeId: string,
  source: "property-fanin" | "property-provenance"
): DeclaredPropertyLensResolution {
  const declarationPath = `state.nodes.${nodeId}.outputs`;
  const outputs = (state.nodes[nodeId]?.outputs ?? []).filter((output) => output.contract === PROPERTY_LENS_CONTRACT);
  if (outputs.length === 0) {
    return {
      ok: false,
      diagnostic: {
        code: "PROPERTY_LENS_DECLARATION_MISSING",
        message: `State node ${JSON.stringify(nodeId)} must declare exactly one ${PROPERTY_LENS_CONTRACT} output; found none`,
        severity: "error",
        source,
        path: declarationPath
      }
    };
  }
  if (outputs.length !== 1) {
    return {
      ok: false,
      diagnostic: {
        code: "PROPERTY_LENS_DECLARATION_AMBIGUOUS",
        message: `State node ${JSON.stringify(nodeId)} must declare exactly one ${PROPERTY_LENS_CONTRACT} output; found ${outputs.length}`,
        severity: "error",
        source,
        path: declarationPath,
        details: { declared_paths: outputs.map((output) => output.path) }
      }
    };
  }

  const output = outputs[0]!;
  const definition = artifactContractDefinition(PROPERTY_LENS_CONTRACT);
  const binding = artifactContractSchemaBinding(PROPERTY_LENS_CONTRACT);
  const bindingMatches =
    binding !== undefined &&
    output.contract_digest === definition.digest &&
    output.schema_file === binding.schema_file &&
    output.schema_id === binding.schema_id &&
    output.schema_sha256 === binding.schema_sha256 &&
    output.schema_bundle_sha256 === binding.schema_bundle_sha256 &&
    output.validator_build === binding.validator_build;
  if (!bindingMatches) {
    return {
      ok: false,
      diagnostic: {
        code: "PROPERTY_LENS_SCHEMA_BINDING_INVALID",
        message: `State node ${JSON.stringify(nodeId)} declares ${PROPERTY_LENS_CONTRACT} without its exact registered contract and schema binding`,
        severity: "error",
        source,
        path: `${declarationPath}[${state.nodes[nodeId]?.outputs?.indexOf(output) ?? 0}]`,
        details: {
          expected: { contract_digest: definition.digest, ...binding },
          actual: {
            contract_digest: output.contract_digest,
            schema_file: output.schema_file,
            schema_id: output.schema_id,
            schema_sha256: output.schema_sha256,
            schema_bundle_sha256: output.schema_bundle_sha256,
            validator_build: output.validator_build
          }
        }
      }
    };
  }
  return { ok: true, output };
}

type FinalizedPropertyLensResolution =
  | {
      ok: true;
      declaration: Pick<NodeOutputContract, "path">;
      artifact: VerifiedOutputArtifactSnapshot;
      document: LensPropertiesArtifact;
    }
  | { ok: false; diagnostics: RuntimeDiagnostic[] };

function loadFinalizedPropertyLens(
  layout: RunLayout,
  state: RunState,
  nodeId: string,
  source: "property-fanin" | "property-provenance"
): FinalizedPropertyLensResolution {
  const declaration = resolveStateDeclaredPropertyLens(state, nodeId, source);
  if (!declaration.ok) return { ok: false, diagnostics: [declaration.diagnostic] };
  const logicalNodeId = state.nodes[nodeId]?.logical_node_id ?? nodeId;
  let authority: ReturnType<typeof loadFinalizedNodeOutputSnapshot>;
  try {
    authority = loadFinalizedNodeOutputSnapshot({
      runRoot: layout.root,
      logicalNodeId,
      attemptId: nodeId
    });
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "PROPERTY_LENS_AUTHORITY_INVALID",
          message: `Property lens producer ${JSON.stringify(nodeId)} has no current finalized output authority: ${error instanceof Error ? error.message : String(error)}`,
          severity: "error",
          source,
          path: `state.nodes.${nodeId}`
        }
      ]
    };
  }
  const artifacts = authority.outputs.filter((output) => output.contract === PROPERTY_LENS_CONTRACT);
  if (artifacts.length !== 1 || artifacts[0]?.path !== declaration.output.path) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "PROPERTY_LENS_AUTHORITY_INVALID",
          message: `Finalized authority for ${JSON.stringify(nodeId)} does not bind its one declared ${PROPERTY_LENS_CONTRACT} output`,
          severity: "error",
          source,
          path: `state.nodes.${nodeId}.outputs`
        }
      ]
    };
  }
  const artifact = artifacts[0];
  const typed = validateLensPropertiesSchema(artifact.value, artifact.absolute_path);
  if (!typed.ok || typed.value === undefined) {
    return {
      ok: false,
      diagnostics: typed.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        severity: "error" as const,
        source,
        path: issue.path
      }))
    };
  }
  return { ok: true, declaration: declaration.output, artifact, document: typed.value };
}

type DirectArtifactDependency = {
  attemptId: string;
  node: PlannedGraphNode;
  task?: SmithersTaskManifestTask;
};

/** Resolve the current attempt's exact direct dependencies from its sealed task declaration. */
function sealedDirectArtifactDependencies(
  layout: RunLayout,
  consumer: PlannedGraphNode,
  authority: ArtifactGateAttemptAuthority
): DirectArtifactDependency[] {
  assertRegularFileInside(layout.root, layout.graphPath, "sealed direct artifact dependency authority");
  const graph = assertPlannedGraph(readStrictRegisteredDocument(layout.graphPath, "planned-graph.schema.json"));
  semanticAttemptDeclarations(consumer, authority);
  assertExactSealedAttemptAuthority(layout, graph, consumer, authority);
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const tasksByAttempt = new Map<string, SmithersTaskManifestTask>();
  for (const task of authority.tasks) {
    if (tasksByAttempt.has(task.attemptId)) {
      throw new Error(`sealed Smithers task set repeats attempt ${JSON.stringify(task.attemptId)}`);
    }
    tasksByAttempt.set(task.attemptId, task);
  }

  const dependencies: DirectArtifactDependency[] = [];
  for (const dependencyAttemptId of authority.task.dependencies) {
    const task = tasksByAttempt.get(dependencyAttemptId);
    if (task !== undefined) {
      const node = nodesById.get(task.concreteNodeId);
      if (
        node === undefined ||
        node.kind !== "agentic" ||
        node.logical_id !== task.logicalNodeId ||
        (node.workflow !== undefined && !node.workflow.task_node_ids.includes(`node:${task.attemptId}`))
      ) {
        throw new Error(
          `sealed Smithers dependency ${JSON.stringify(dependencyAttemptId)} does not bind one planned agentic attempt`
        );
      }
      dependencies.push({ attemptId: dependencyAttemptId, node, task });
      continue;
    }

    // Reference attempts deliberately have artifact directories but no Smithers
    // task declaration. An absent agentic task is never interpreted as a
    // reference or as an empty producer.
    const node = nodesById.get(dependencyAttemptId);
    if (node === undefined || node.kind !== "reference") {
      throw new Error(
        `sealed Smithers dependency ${JSON.stringify(dependencyAttemptId)} has no task or planned reference declaration`
      );
    }
    dependencies.push({ attemptId: dependencyAttemptId, node });
  }
  return dependencies;
}

function smithersOutputMatchesPlanned(
  output: SmithersTaskManifestOutput,
  planned: PlannedGraphNode["outputs"][number]
): boolean {
  return (
    output.path === planned.path &&
    output.contract === planned.contract &&
    output.contractDigest === planned.contract_digest &&
    output.schemaFile === planned.schema_file &&
    output.schemaId === planned.schema_id &&
    output.schemaSha256 === planned.schema_sha256 &&
    output.schemaBundleSha256 === planned.schema_bundle_sha256 &&
    output.validatorBuild === planned.validator_build &&
    output.primary === planned.primary
  );
}

/** Authenticate one fanout attempt's property lens against both sealed and planned declarations. */
function loadFinalizedTaskPropertyLens(
  layout: RunLayout,
  dependency: DirectArtifactDependency,
  source: "property-fanin" | "property-provenance"
): FinalizedPropertyLensResolution {
  const declarationPath = `smithers.tasks.${dependency.attemptId}.metadata.artifacts.outputs`;
  const taskOutputs =
    dependency.task?.metadata.artifacts.outputs.filter((output) => output.contract === PROPERTY_LENS_CONTRACT) ?? [];
  if (taskOutputs.length !== 1) {
    return {
      ok: false,
      diagnostics: [
        {
          code: taskOutputs.length === 0 ? "PROPERTY_LENS_DECLARATION_MISSING" : "PROPERTY_LENS_DECLARATION_AMBIGUOUS",
          message: `Sealed Smithers attempt ${JSON.stringify(dependency.attemptId)} must declare exactly one ${PROPERTY_LENS_CONTRACT} output; found ${taskOutputs.length}`,
          severity: "error",
          source,
          path: declarationPath,
          ...(taskOutputs.length < 2 ? {} : { details: { declared_paths: taskOutputs.map((output) => output.path) } })
        }
      ]
    };
  }
  const plannedOutputs = dependency.node.outputs.filter((output) => output.contract === PROPERTY_LENS_CONTRACT);
  const declaration = taskOutputs[0]!;
  if (plannedOutputs.length !== 1 || !smithersOutputMatchesPlanned(declaration, plannedOutputs[0]!)) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "PROPERTY_LENS_SCHEMA_BINDING_INVALID",
          message: `Sealed Smithers attempt ${JSON.stringify(dependency.attemptId)} does not match its exact planned ${PROPERTY_LENS_CONTRACT} declaration`,
          severity: "error",
          source,
          path: declarationPath
        }
      ]
    };
  }

  let authority: ReturnType<typeof loadFinalizedNodeOutputSnapshot>;
  try {
    authority = loadFinalizedNodeOutputSnapshot({
      runRoot: layout.root,
      logicalNodeId: dependency.node.logical_id,
      attemptId: dependency.attemptId
    });
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "PROPERTY_LENS_AUTHORITY_INVALID",
          message: `Property lens attempt ${JSON.stringify(dependency.attemptId)} has no current finalized output authority: ${error instanceof Error ? error.message : String(error)}`,
          severity: "error",
          source,
          path: declarationPath
        }
      ]
    };
  }
  const artifacts = authority.outputs.filter((output) => output.contract === PROPERTY_LENS_CONTRACT);
  if (artifacts.length !== 1 || artifacts[0]?.path !== declaration.path) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "PROPERTY_LENS_AUTHORITY_INVALID",
          message: `Finalized authority for ${JSON.stringify(dependency.attemptId)} does not bind its sealed ${PROPERTY_LENS_CONTRACT} output`,
          severity: "error",
          source,
          path: declarationPath
        }
      ]
    };
  }
  const artifact = artifacts[0]!;
  const typed = validateLensPropertiesSchema(artifact.value, artifact.absolute_path);
  if (!typed.ok || typed.value === undefined) {
    return {
      ok: false,
      diagnostics: typed.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        severity: "error" as const,
        source,
        path: issue.path
      }))
    };
  }
  return { ok: true, declaration, artifact, document: typed.value };
}

function verifyLensReferenceExpectationPreservation(
  layout: RunLayout,
  node: PlannedGraphNode,
  catalog: PropertiesArtifact,
  catalogPath: string,
  attemptAuthority?: ArtifactGateAttemptAuthority
): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  const lensRows = new Map<string, LensReferenceRow>();
  const lensPathsByDependency = new Map<string, string>();
  const state = readRunState(layout);
  let dependencies: DirectArtifactDependency[];
  try {
    dependencies =
      attemptAuthority === undefined
        ? plannedDirectDependencyNodes(layout, node).map((dependency) => ({
            attemptId: dependency.id,
            node: dependency
          }))
        : sealedDirectArtifactDependencies(layout, node, attemptAuthority);
  } catch (error) {
    return [diagnosticFromError(error, "property-fanin", "PROPERTY_LENS_AUTHORITY_INVALID")];
  }
  for (const plannedDependency of dependencies) {
    const dependencyId = plannedDependency.attemptId;
    const dependency = plannedDependency.node.logical_id;
    const isCatalogSource = catalog.properties.some((property) =>
      property.sources.some((source) => source.source_node_id === dependency)
    );
    const declaresLens =
      plannedDependency.task?.metadata.artifacts.outputs.some((output) => output.contract === PROPERTY_LENS_CONTRACT) ??
      plannedDependency.node.outputs.some((output) => output.contract === PROPERTY_LENS_CONTRACT);
    if (isCatalogSource && isSyntheticLedgerDependency(plannedDependency.node)) continue;
    if (!isCatalogSource && !declaresLens) continue;
    // Expanded graphs may give fan-in concrete dependencies such as
    // `property-specification-recon-0` and `property-specification-recon-1`.
    // Only that declared concrete dependency may satisfy the handoff.
    const lens =
      attemptAuthority === undefined
        ? loadFinalizedPropertyLens(layout, state, dependencyId, "property-fanin")
        : loadFinalizedTaskPropertyLens(layout, plannedDependency, "property-fanin");
    if (!lens.ok) {
      diagnostics.push(...lens.diagnostics);
      continue;
    }
    const lensRelativePath = lens.declaration.path;
    lensPathsByDependency.set(dependencyId, lensRelativePath);
    for (const [index, property] of lens.document.properties.entries()) {
      lensRows.set(`${dependencyId}\u0000${property.id}`, {
        concreteNodeId: dependencyId,
        sourceNodeId: dependency,
        propertyId: property.id,
        expectationIds: property.reference_expectations ?? [],
        path: lens.artifact.absolute_path,
        index
      });
    }
  }

  for (const plannedDependency of dependencies) {
    if (isSyntheticLedgerDependency(plannedDependency.node)) continue;
    const dependencyId = plannedDependency.attemptId;
    const dependency = plannedDependency.node.logical_id;
    if (
      !catalog.properties.some((property) => property.sources.some((source) => source.source_node_id === dependency))
    ) {
      continue;
    }
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
          path:
            lensPathsByDependency.get(dependencyId) === undefined
              ? `state.nodes.${dependencyId}.outputs`
              : `artifacts/${dependencyId}/${lensPathsByDependency.get(dependencyId)}`
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
        path: `${catalogPath}#$.properties[${propertyIndex}].reference_expectations`
      });
    }
  }

  const rowsBySource = new Map<string, LensReferenceRow[]>();
  for (const row of lensRows.values()) {
    const key = `${row.sourceNodeId}\u0000${row.propertyId}`;
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

  const dependencyLogicalIds = new Set(dependencies.map((dependency) => dependency.node.logical_id));
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
        path: `${catalogPath}#$.properties[${propertyIndex}].sources[${sourceIndex}]`
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
      let bytes: Buffer;
      try {
        bytes = fs.readFileSync(probePath);
        const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        if (content.includes("\u0000")) throw new Error("NUL");
      } catch {
        diagnostics.push({
          code: "INVARIANT_LEDGER_PROBE_SOURCE_BINARY",
          message: `Invariant scan probe source is not UTF-8 text: ${relativePath}`,
          severity: "error",
          source: "invariant-ledger",
          path: diagnosticPath
        });
        return;
      }
      verifyInvariantProbeSourcePin(workspacePath, relativePath, bytes, diagnosticPath, diagnostics);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    diagnostics.push(diagnosticFromError(error, "invariant-ledger", "INVARIANT_LEDGER_PROBE_PATH_INVALID"));
  }
}

/**
 * The generated workflow refuses any probe source that is not tracked, unmodified,
 * and byte-identical to the pinned commit, but only when the pinned ref exists. The
 * gate used to skip that check entirely, so `ultrafuzz validate` accepted ledgers the
 * run then killed the node over (issue #301). Both halves now come from one shared
 * validator, including the "only when pinned" condition.
 */
function verifyInvariantProbeSourcePin(
  workspacePath: string,
  relativePath: string,
  bytes: Buffer,
  diagnosticPath: string,
  diagnostics: RuntimeDiagnostic[]
): void {
  if (!invariantPinnedSourceRefExists(workspacePath)) return;
  const pinned = checkInvariantSourcePinned({ workspacePath, relativePath, bytes });
  if (pinned.ok) return;
  diagnostics.push({
    code: "INVARIANT_LEDGER_PROBE_SOURCE_UNPINNED",
    message: `Invariant scan probe source is ${pinned.detail}: ${relativePath}`,
    severity: "error",
    source: "invariant-ledger",
    path: diagnosticPath
  });
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
  ledgerBytes: Uint8Array,
  diagnostics: RuntimeDiagnostic[]
): InvariantSourceProof | undefined {
  try {
    assertRegularFileInside(path.dirname(path.dirname(proofPath)), proofPath, "invariant source proof");
    const parsed = validateInvariantSourceProofSchema(
      readStrictRegisteredDocument(proofPath, "invariant-source-proof.schema.json"),
      proofPath
    );
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
    let durableGitContext: SemanticGitContext | undefined;
    if (baseProofPresent) {
      assertRegularFileInside(path.dirname(path.dirname(proofPath)), baseProofPath, "pinned source proof");
      const base = readStrictRegisteredDocument(baseProofPath, "agent-source-proof.schema.json") as
        | {
            attempt_id?: unknown;
            commit?: unknown;
            tree?: unknown;
          }
        | undefined;
      if (
        base?.attempt_id !== expectedAttemptId ||
        base?.commit !== parsed.value.commit ||
        base?.tree !== parsed.value.tree
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
      durableGitContext = { commit: parsed.value.commit, tree: parsed.value.tree };
    }
    const semanticContext = invariantSourceProofGitContext(proofPath, expectedAttemptId, durableGitContext);
    const semanticDiagnostics = runtimeSemanticGateDiagnostics({
      schemaFilename: "invariant-source-proof.schema.json",
      document: parsed.value,
      artifactPath: proofPath,
      ...(semanticContext === undefined ? {} : { context: { git: semanticContext } })
    });
    diagnostics.push(...semanticDiagnostics);
    if (semanticDiagnostics.some((diagnostic) => diagnostic.severity === "error")) return undefined;
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

function invariantSourceProofGitContext(
  proofPath: string,
  attemptId: string,
  durableContext: SemanticGitContext | undefined
): SemanticGitContext | undefined {
  const runRoot = path.dirname(path.dirname(proofPath));
  const workspacePath = path.join(runRoot, "workspaces", attemptId);
  try {
    fs.lstatSync(workspacePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return durableContext;
    throw error;
  }
  assertNoSymlinkComponents(runRoot, workspacePath, "invariant source-proof workspace");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspacePath, encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: workspacePath,
    encoding: "utf8"
  }).trim();
  return { commit, tree };
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function verifyRequiredArtifactShape(
  layout: RunLayout,
  artifactDir: string,
  absolutePath: string,
  output: PlannedGraphNode["outputs"][number],
  node: PlannedGraphNode,
  attemptId: string,
  attemptAuthority?: ArtifactGateAttemptAuthority,
  authenticated?: AuthenticatedArtifactGateSnapshots
): RuntimeDiagnostic[] {
  const artifactBytes =
    authenticated === undefined && output.contract === "ultrafuzz/generated-tests@3"
      ? readSinglyLinkedRegularFileSnapshotInside(
          artifactDir,
          absolutePath,
          MAX_ARTIFACT_SNAPSHOT_BYTES,
          "generated-test manifest"
        )
      : readCurrentArtifactSnapshot(artifactDir, absolutePath, authenticated);
  if (artifactBytes === undefined) throw new Error(`required artifact snapshot is unavailable: ${output.path}`);
  const schemaDiagnostics = verifyRequiredArtifactSchemaBinding(absolutePath, output, artifactBytes);
  if (schemaDiagnostics.some((diagnostic) => diagnostic.severity === "error")) return schemaDiagnostics;
  const binding = artifactContractSchemaBinding(output.contract);
  const contract =
    binding === undefined
      ? validateArtifactContractBytes(output.contract, artifactBytes, absolutePath)
      : { ok: true, issues: [], value: parseStrictJsonBytes(artifactBytes) };
  const diagnostics: RuntimeDiagnostic[] = [
    ...schemaDiagnostics,
    ...contract.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      severity: "error" as const,
      source: "artifact-contracts",
      path: issue.path,
      details: { contract: output.contract, contract_digest: output.contract_digest }
    }))
  ];
  if (contract.ok && contract.value !== undefined && binding !== undefined) {
    diagnostics.push(
      ...runtimeSemanticGateDiagnostics({
        schemaFilename: binding.schema_file as ArtifactSchemaFilename,
        document: contract.value,
        artifactPath: absolutePath,
        context: semanticGateContextForArtifact({
          layout,
          artifactDir,
          node,
          attemptId,
          output,
          schemaFilename: binding.schema_file as ArtifactSchemaFilename,
          attemptAuthority,
          authenticated,
          document: contract.value
        })
      })
    );
  }
  if (contract.ok && output.contract === "ultrafuzz/workspace-patch@1") {
    const manifest = contract.value as WorkspacePatchManifest;
    const excluded = manifest.excluded_files ?? [];
    if (excluded.length > 0) {
      const visible = excluded.slice(0, 5).map((entry) => entry.path);
      diagnostics.push({
        code: "WORKSPACE_PATCH_FILES_EXCLUDED",
        message: `Workspace patch omitted ${excluded.length} measured overflow file${excluded.length === 1 ? "" : "s"}: ${visible.join(", ")}${excluded.length > visible.length ? ` (and ${excluded.length - visible.length} more)` : ""}`,
        severity: "warning",
        source: "workspace-patch",
        path: absolutePath,
        details: {
          reason: "git-diff-overflow",
          excluded_file_count: excluded.length,
          excluded_files: excluded.slice(0, 20)
        }
      });
    }
    return diagnostics;
  }
  if (!contract.ok || String(output.contract) !== "ultrafuzz/generated-tests@3") {
    return diagnostics;
  }

  const parsed = validateGeneratedTestManifestSchema(contract.value, absolutePath);
  if (!parsed.ok || parsed.value === undefined) {
    return parsed.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      severity: "error",
      source: "generated-tests",
      path: `${absolutePath}#${issue.path}`
    }));
  }

  for (const [field, label, entries] of [
    ["generated_tests", "generated test", parsed.value.generated_tests],
    ["support_files", "generated-test support file", parsed.value.support_files]
  ] as const) {
    for (const [index, entry] of entries.entries()) {
      try {
        const generatedPath = safeResolveInside(artifactDir, entry.path, `${label} manifest entry`);
        const generatedBytes = readCurrentArtifactSnapshot(artifactDir, generatedPath, authenticated);
        if (generatedBytes === undefined) {
          diagnostics.push({
            code: "GENERATED_TEST_FILE_MISSING",
            message: `${label} manifest entry ${entry.path} was not produced`,
            severity: "error",
            source: "generated-tests",
            path: `${absolutePath}#$.${field}[${index}].path`
          });
        } else if (generatedBytes.byteLength === 0) {
          diagnostics.push({
            code: "GENERATED_TEST_FILE_EMPTY",
            message: `${label} manifest entry ${entry.path} is empty`,
            severity: "error",
            source: "generated-tests",
            path: `${absolutePath}#$.${field}[${index}].path`
          });
        }
      } catch (error) {
        diagnostics.push(diagnosticFromError(error, "generated-tests", "GENERATED_TEST_FILE_INVALID"));
      }
    }
  }

  return diagnostics;
}

function capturePropertyCampaignEvidenceContext(
  layout: RunLayout,
  artifactDir: string,
  attemptId: string,
  node: PlannedGraphNode,
  campaign: PropertyCampaignArtifact,
  authenticated?: AuthenticatedArtifactGateSnapshots
): SemanticPropertyCampaignEvidenceContext {
  const snapshots = campaign.evidence_files.map((entry) => {
    const base = {
      path: entry.path,
      exists: false,
      regularFile: false,
      symbolicLink: false,
      linkCount: null,
      stableIdentity: false
    };
    try {
      const evidencePath = safeResolveInside(artifactDir, entry.path, "property campaign evidence path");
      if (authenticated !== undefined) {
        const bytes = readCurrentArtifactSnapshot(artifactDir, evidencePath, authenticated);
        return bytes === undefined
          ? base
          : {
              ...base,
              exists: true,
              regularFile: true,
              symbolicLink: false,
              linkCount: 1,
              stableIdentity: true,
              bytes
            };
      }
      if (!fs.existsSync(evidencePath)) {
        return base;
      }
      assertRegularFileInside(artifactDir, evidencePath, "property campaign evidence path");
      const before = fs.lstatSync(evidencePath, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
        return {
          ...base,
          exists: true,
          regularFile: before.isFile(),
          symbolicLink: before.isSymbolicLink(),
          linkCount: Number(before.nlink),
          device: String(before.dev),
          inode: String(before.ino),
          error: `property campaign evidence must be a singly linked regular file: ${entry.path}`
        };
      }
      const bytes = readRegularFileSnapshot(evidencePath, MAX_PROPERTY_CAMPAIGN_EVIDENCE_FILE_BYTES);
      const after = fs.lstatSync(evidencePath, { bigint: true });
      const stableIdentity =
        after.isFile() &&
        !after.isSymbolicLink() &&
        after.nlink === 1n &&
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs &&
        after.size === BigInt(bytes.byteLength);
      return {
        ...base,
        exists: true,
        regularFile: after.isFile(),
        symbolicLink: after.isSymbolicLink(),
        linkCount: Number(after.nlink),
        stableIdentity,
        device: String(after.dev),
        inode: String(after.ino),
        bytes,
        ...(stableIdentity ? {} : { error: `property campaign evidence changed while captured: ${entry.path}` })
      };
    } catch (error) {
      return {
        ...base,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });
  const publicationAuthority =
    authenticated === undefined
      ? readPropertyCampaignPublicationAuthority(layout, attemptId)
      : {
          markerAttemptId: attemptId,
          markerNodeId: node.logical_id ?? node.id,
          publications: [...authenticated.publications].map(([publicationPath, bytes]) => ({
            path: publicationPath,
            sha256: crypto.createHash("sha256").update(bytes).digest("hex")
          }))
        };
  return {
    snapshots,
    ...(publicationAuthority === undefined ? {} : { publicationAuthority })
  };
}

function readPropertyCampaignPublicationAuthority(
  layout: RunLayout,
  attemptId: string
): SemanticPropertyCampaignEvidenceContext["publicationAuthority"] {
  try {
    const markerRoot = path.join(layout.root, ARTIFACT_VERIFICATION_DIRECTORY);
    const markerPath = safeResolveInside(markerRoot, `${attemptId}.json`, "verification marker path");
    assertRegularFileInside(layout.root, markerPath, "property campaign verification marker");
    const markerValue = parseStrictJsonBytes(readRegularFileSnapshot(markerPath, MAX_ARTIFACT_SNAPSHOT_BYTES));
    const validation = validateArtifactVerificationMarker(markerValue);
    if (!validation.ok) return undefined;
    const marker = markerValue as ArtifactVerificationMarker;
    assertArtifactVerificationMarkerSemantics(marker);
    return {
      markerAttemptId: marker.attempt_id,
      markerNodeId: marker.node_id,
      publications: marker.publications.map((publication) => ({ ...publication }))
    };
  } catch {
    return undefined;
  }
}

function semanticGateContextForArtifact(input: {
  layout: RunLayout;
  artifactDir: string;
  node: PlannedGraphNode;
  attemptId: string;
  output: PlannedGraphNode["outputs"][number];
  schemaFilename: ArtifactSchemaFilename;
  attemptAuthority?: ArtifactGateAttemptAuthority;
  authenticated?: AuthenticatedArtifactGateSnapshots;
  document: unknown;
}): SemanticGateContext {
  const context: SemanticGateContext = {
    filesystem: {
      rootDirectory: input.artifactDir,
      ...(input.authenticated === undefined ? {} : { files: input.authenticated.publications })
    },
    plannedGraph: { node: input.node },
    artifactIdentity: {
      runId: input.layout.runId,
      nodeId: input.node.logical_id ?? input.node.id,
      attemptId: input.attemptId,
      artifactPath: input.output.path
    }
  };
  const artifactSet = semanticArtifactSetForSchema(input);
  const git =
    input.schemaFilename === "workspace-patch.schema.json"
      ? workspacePatchGitContext(input.layout, input.artifactDir, input.attemptId, input.authenticated)
      : undefined;
  const aggregation =
    input.schemaFilename === "aggregation-manifest.schema.json"
      ? authenticatedAggregationSemanticContext({
          layout: input.layout,
          node: input.node,
          attemptId: input.attemptId
        })
      : undefined;
  const propertyCampaignEvidence =
    input.schemaFilename === "property-campaign.schema.json"
      ? capturePropertyCampaignEvidenceContext(
          input.layout,
          input.artifactDir,
          input.attemptId,
          input.node,
          input.document as PropertyCampaignArtifact,
          input.authenticated
        )
      : undefined;
  const propertyCampaignTimeout =
    input.schemaFilename === "property-campaign.schema.json"
      ? semanticPropertyCampaignTimeoutContext(input.layout, input.node, input.attemptId)
      : undefined;
  return {
    ...context,
    ...(artifactSet === undefined ? {} : { artifactSet }),
    ...(git === undefined ? {} : { git }),
    ...(aggregation === undefined ? {} : { aggregation }),
    ...(propertyCampaignEvidence === undefined ? {} : { propertyCampaignEvidence }),
    ...(propertyCampaignTimeout === undefined ? {} : { propertyCampaignTimeout })
  };
}

function semanticArtifactSetForSchema(input: {
  layout: RunLayout;
  artifactDir: string;
  node: PlannedGraphNode;
  attemptId: string;
  output: PlannedGraphNode["outputs"][number];
  schemaFilename: ArtifactSchemaFilename;
  attemptAuthority?: ArtifactGateAttemptAuthority;
  authenticated?: AuthenticatedArtifactGateSnapshots;
}): SemanticArtifactSetContext | undefined {
  if (input.schemaFilename === "campaign-summary.schema.json") {
    return semanticCampaignArtifacts(input.artifactDir, input.node, input.authenticated);
  }
  if (input.schemaFilename === "property-campaign.schema.json") {
    return semanticPropertyCampaignContext(
      input.layout,
      input.artifactDir,
      input.node,
      input.attemptAuthority,
      input.authenticated
    );
  }
  if (input.schemaFilename === "implemented-properties.schema.json") {
    const propertyCatalog = semanticCanonicalPropertyCatalog(input.layout, input.node, input.attemptAuthority);
    return propertyCatalog === undefined ? {} : { propertyCatalog };
  }
  if (input.schemaFilename === "properties.schema.json") {
    const propertyLenses = semanticPropertyLenses(input.layout, input.node, input.attemptAuthority);
    return propertyLenses === undefined ? {} : { propertyLenses };
  }
  if (
    input.schemaFilename === "finding-lifecycle-ledger.schema.json" ||
    input.schemaFilename === "strategy-detections.schema.json"
  ) {
    const reviewStage = semanticReviewStageContext(input);
    return reviewStage === undefined ? {} : { reviewStage };
  }
  if (input.schemaFilename === "triaged-findings.schema.json") {
    const dedupedFindings = semanticDedupedFindings(input.layout, input.node, input.attemptAuthority);
    return dedupedFindings === undefined ? {} : { dedupedFindings };
  }
  if (input.schemaFilename === "severity-classified-findings.schema.json") {
    const triagedFindings = semanticTriagedFindings(input.layout, input.node, input.attemptAuthority);
    return triagedFindings === undefined ? {} : { triagedFindings };
  }
  if (input.schemaFilename === "selected-strategies.schema.json") {
    return { dynamicStrategyArtifacts: semanticDynamicStrategyArtifacts(input) };
  }
  if (
    input.schemaFilename === "reference-harness.schema.json" ||
    input.schemaFilename === "audited-differential-lanes.schema.json" ||
    input.schemaFilename === "differential-lane-result.schema.json" ||
    input.schemaFilename === "semantic-red-registry.schema.json" ||
    input.schemaFilename === "differential-red-triage.schema.json" ||
    input.schemaFilename === "differential-repair-summary.schema.json" ||
    input.schemaFilename === "differential-gap-review.schema.json" ||
    input.schemaFilename === "differential-report-review.schema.json"
  ) {
    return { differentialArtifacts: semanticDifferentialArtifacts(input) };
  }
  if (input.schemaFilename === "report.schema.json") {
    const propertyCatalog = semanticCanonicalPropertyCatalog(input.layout, input.node, input.attemptAuthority);
    const implementedProperties = semanticImplementedProperties(input.layout, input.node, input.attemptAuthority);
    const severity = semanticFinalSeverityContext(input.layout, input.node, input.attemptAuthority);
    const campaignSummary = semanticCampaignSummary(input.layout, input.node, input.attemptAuthority);
    return {
      ...(campaignSummary === undefined ? {} : { campaignSummary: campaignSummary.value }),
      ...(campaignSummary?.path === undefined ? {} : { campaignSummaryPath: campaignSummary.path }),
      ...(propertyCatalog === undefined ? {} : { propertyCatalog }),
      ...(implementedProperties === undefined ? {} : { implementedProperties }),
      ...(severity.severityClassifiedFindings === undefined
        ? {}
        : { severityClassifiedFindings: severity.severityClassifiedFindings }),
      ...(severity.findingLifecycleLedger === undefined
        ? {}
        : { findingLifecycleLedger: severity.findingLifecycleLedger })
    };
  }
  return undefined;
}

function semanticTriagedFindings(
  layout: RunLayout,
  consumer: PlannedGraphNode,
  attemptAuthority?: ArtifactGateAttemptAuthority
): unknown | undefined {
  return finalizedSingletonAncestorOutput(
    layout,
    consumer,
    "ultrafuzz/triaged-findings@1",
    "triaged findings semantic context",
    attemptAuthority,
    { directOnly: true }
  )?.value;
}

function semanticSiblingJsonArtifact(
  artifactDir: string,
  node: PlannedGraphNode,
  contract: PlannedGraphNode["outputs"][number]["contract"],
  label: string,
  authenticated?: AuthenticatedArtifactGateSnapshots
): { value: unknown; path: string } {
  const outputs = node.outputs.filter((output) => output.contract === contract);
  if (outputs.length !== 1) {
    throw new Error(`${label} semantic context requires exactly one declared ${contract} sibling`);
  }
  const output = outputs[0]!;
  const artifactPath = safeResolveInside(artifactDir, output.path, `${label} semantic context`);
  const artifact = parseCurrentArtifactJson(artifactDir, artifactPath, authenticated);
  if (artifact === undefined) throw new Error(`${label} semantic context is unavailable: ${artifactPath}`);
  return {
    value: assertContractDocument(artifact, artifactPath, contract),
    path: output.path
  };
}

function semanticPropertyCampaignContext(
  layout: RunLayout,
  artifactDir: string,
  node: PlannedGraphNode,
  attemptAuthority?: ArtifactGateAttemptAuthority,
  authenticated?: AuthenticatedArtifactGateSnapshots
): SemanticArtifactSetContext {
  const campaignPlan = semanticSiblingJsonArtifact(
    artifactDir,
    node,
    "ultrafuzz/invariant-campaign-plan@2",
    "campaign plan",
    authenticated
  );
  const findings = semanticSiblingJsonArtifact(
    artifactDir,
    node,
    "ultrafuzz/findings@2",
    "campaign findings",
    authenticated
  );
  if (!Array.isArray(findings.value)) {
    throw new Error("campaign findings semantic context must be an array");
  }
  const campaignSummary = semanticSiblingJsonArtifact(
    artifactDir,
    node,
    "ultrafuzz/campaign-summary@2",
    "campaign summary",
    authenticated
  );
  const implementedProperties = semanticImplementedProperties(layout, node, attemptAuthority);
  const implementedPropertiesArtifact = semanticImplementedPropertiesArtifact(layout, node, attemptAuthority);
  if (implementedProperties === undefined || implementedPropertiesArtifact === undefined) {
    throw new Error("implemented property semantic context is unavailable");
  }
  return {
    campaignPlan: campaignPlan.value,
    campaignPlanPath: campaignPlan.path,
    campaignSummary: campaignSummary.value,
    campaignSummaryPath: campaignSummary.path,
    findings: findings.value,
    findingsPath: findings.path,
    implementedProperties,
    implementedPropertiesPath: implementedPropertiesArtifact.path
  };
}

function authenticatedSemanticAttempt(
  input: {
    layout: RunLayout;
    artifactDir: string;
    node: PlannedGraphNode;
    attemptId: string;
    attemptAuthority?: ArtifactGateAttemptAuthority;
    authenticated?: AuthenticatedArtifactGateSnapshots;
  },
  label: string
): { current: SemanticArtifactTaskDeclaration; authority: ArtifactGateAttemptAuthority } {
  if (input.attemptAuthority === undefined || input.authenticated === undefined) {
    throw new Error(`${label} requires sealed attempt declarations and authenticated current snapshots`);
  }
  if (input.attemptAuthority.task.attemptId !== input.attemptId) {
    throw new Error(`${label} attempt identity does not match its sealed current task`);
  }
  const { current } = semanticAttemptDeclarations(input.node, input.attemptAuthority);
  const expectedArtifactDir = getNodeArtifactDir(input.layout, input.attemptId);
  if (
    path.resolve(input.artifactDir) !== expectedArtifactDir ||
    path.resolve(current.artifactDir) !== expectedArtifactDir
  ) {
    throw new Error(`${label} artifact directory does not match its sealed attempt declaration`);
  }
  assertRegularFileInside(input.layout.root, input.layout.graphPath, `${label} planned graph authority`);
  const graph = assertPlannedGraph(readStrictRegisteredDocument(input.layout.graphPath, "planned-graph.schema.json"));
  assertExactSealedAttemptAuthority(input.layout, graph, input.node, input.attemptAuthority);
  return { current, authority: input.attemptAuthority };
}

function semanticRunRelativePath(layout: RunLayout, absolutePath: string, label: string): string {
  const relativePath = path.relative(path.resolve(layout.root), path.resolve(absolutePath)).split(path.sep).join("/");
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    path.posix.isAbsolute(relativePath)
  ) {
    throw new Error(`${label} is outside the run layout: ${absolutePath}`);
  }
  return relativePath;
}

function semanticDifferentialArtifacts(input: {
  layout: RunLayout;
  artifactDir: string;
  node: PlannedGraphNode;
  attemptId: string;
  output: PlannedGraphNode["outputs"][number];
  schemaFilename: ArtifactSchemaFilename;
  attemptAuthority?: ArtifactGateAttemptAuthority;
  authenticated?: AuthenticatedArtifactGateSnapshots;
}): NonNullable<SemanticArtifactSetContext["differentialArtifacts"]> {
  const { current, authority } = authenticatedSemanticAttempt(input, "differential semantic context");
  const currentOutput = current.outputs.filter(
    (output) => output.path === input.output.path && output.contract === input.output.contract
  );
  if (currentOutput.length !== 1) {
    throw new Error(
      `differential current output is absent from the sealed task declaration: ${JSON.stringify(input.output.path)}`
    );
  }

  const tasksByAttempt = new Map(authority.tasks.map((task) => [task.attemptId, task] as const));
  const ancestors = (contract: PlannedGraphNode["outputs"][number]["contract"]) =>
    finalizedDeclaredContractProducers(input.layout, contract, input.node, authority).flatMap((producer) => {
      const task = tasksByAttempt.get(producer.attemptId);
      if (task === undefined) {
        throw new Error(
          `differential artifact producer declaration is unavailable: ${JSON.stringify(producer.attemptId)}`
        );
      }
      return producer.outputs.map((output): SemanticDifferentialArtifactBinding => ({
        attemptId: producer.attemptId,
        logicalNodeId: task.logicalNodeId,
        attemptIndex: task.metadata.loop.attemptIndex,
        path: semanticRunRelativePath(input.layout, output.absolute_path, "finalized differential artifact"),
        contract: output.contract,
        document: assertContractDocument(output.value, output.absolute_path, output.contract)
      }));
    });
  const siblings = (contract: PlannedGraphNode["outputs"][number]["contract"]) =>
    declaredSiblingOutputsByContract(current, contract).map((output): SemanticDifferentialArtifactBinding => {
      const artifactPath = safeResolveInside(input.artifactDir, output.path, "current differential sibling");
      const document = parseCurrentArtifactJson(input.artifactDir, artifactPath, input.authenticated);
      if (document === undefined) {
        throw new Error(`authenticated differential sibling is unavailable: ${artifactPath}`);
      }
      return {
        attemptId: authority.task.attemptId,
        logicalNodeId: authority.task.logicalNodeId,
        attemptIndex: authority.task.metadata.loop.attemptIndex,
        path: semanticRunRelativePath(input.layout, artifactPath, "current differential sibling"),
        contract: output.contract,
        document: assertContractDocument(
          document,
          artifactPath,
          output.contract as PlannedGraphNode["outputs"][number]["contract"]
        )
      };
    });
  const currentPath = safeResolveInside(input.artifactDir, input.output.path, "current differential artifact");
  const currentIdentity = {
    attemptId: authority.task.attemptId,
    logicalNodeId: authority.task.logicalNodeId,
    attemptIndex: authority.task.metadata.loop.attemptIndex,
    path: semanticRunRelativePath(input.layout, currentPath, "current differential artifact"),
    contract: input.output.contract
  };

  switch (input.schemaFilename) {
    case "reference-harness.schema.json":
      return { current: currentIdentity, plans: ancestors("ultrafuzz/differential-plan@1") };
    case "audited-differential-lanes.schema.json":
      return {
        current: currentIdentity,
        plans: ancestors("ultrafuzz/differential-plan@1"),
        harnesses: ancestors("ultrafuzz/reference-harness@1")
      };
    case "differential-lane-result.schema.json":
      return { current: currentIdentity, auditedLanes: ancestors("ultrafuzz/audited-differential-lanes@1") };
    case "semantic-red-registry.schema.json":
      return { laneResults: ancestors("ultrafuzz/differential-lane-result@1") };
    case "differential-red-triage.schema.json":
      return { current: currentIdentity, registries: siblings("ultrafuzz/semantic-red-registry@1") };
    case "differential-repair-summary.schema.json":
      return {
        registries: ancestors("ultrafuzz/semantic-red-registry@1"),
        triages: ancestors("ultrafuzz/differential-red-triage@1")
      };
    case "differential-gap-review.schema.json":
      return {
        auditedLanes: ancestors("ultrafuzz/audited-differential-lanes@1"),
        laneResults: ancestors("ultrafuzz/differential-lane-result@1")
      };
    case "differential-report-review.schema.json":
      return {
        registries: ancestors("ultrafuzz/semantic-red-registry@1"),
        triages: ancestors("ultrafuzz/differential-red-triage@1"),
        repairSummaries: siblings("ultrafuzz/differential-repair-summary@1"),
        gapReviews: siblings("ultrafuzz/differential-gap-review@1"),
        findings: siblings("ultrafuzz/findings@2")
      };
    default:
      return {};
  }
}

function semanticDynamicStrategyArtifacts(input: {
  layout: RunLayout;
  artifactDir: string;
  node: PlannedGraphNode;
  attemptId: string;
  attemptAuthority?: ArtifactGateAttemptAuthority;
  authenticated?: AuthenticatedArtifactGateSnapshots;
}): NonNullable<SemanticArtifactSetContext["dynamicStrategyArtifacts"]> {
  authenticatedSemanticAttempt(input, "dynamic strategy semantic context");
  const readDeclaredSibling = (contract: PlannedGraphNode["outputs"][number]["contract"], label: string): unknown =>
    semanticSiblingJsonArtifact(input.artifactDir, input.node, contract, label, input.authenticated).value;

  const strategyPlan = readDeclaredSibling("ultrafuzz/dynamic-strategy-plan@1", "dynamic strategy plan");
  const enumeratorOutputs = readDeclaredSibling("ultrafuzz/dynamic-enumerator-outputs@1", "dynamic enumerator outputs");
  const findings = readDeclaredSibling("ultrafuzz/findings@2", "dynamic findings");
  const provenance = readDeclaredSibling("ultrafuzz/dynamic-strategy-provenance@1", "dynamic strategy provenance");
  return { strategyPlan, enumeratorOutputs, findings, provenance };
}

function semanticReviewStageContext(input: {
  layout: RunLayout;
  artifactDir: string;
  node: PlannedGraphNode;
  attemptId: string;
  attemptAuthority?: ArtifactGateAttemptAuthority;
  authenticated?: AuthenticatedArtifactGateSnapshots;
}): SemanticReviewStageContext | undefined {
  authenticatedSemanticAttempt(input, "review stage semantic context");
  const stageCandidates = [
    { contract: "ultrafuzz/findings@2", stage: "dedupe-findings" },
    { contract: "ultrafuzz/triaged-findings@1", stage: "triage" },
    { contract: "ultrafuzz/severity-classified-findings@1", stage: "severity-classification" }
  ] as const;
  const declaredStages = stageCandidates.flatMap((candidate) => {
    const count = input.node.outputs.filter((output) => output.contract === candidate.contract).length;
    if (count > 1) {
      throw new Error(`review stage declares ${count} ${candidate.contract} findings outputs; expected at most one`);
    }
    return count === 1 ? [candidate.stage] : [];
  });
  if (declaredStages.length !== 1) {
    throw new Error("review stage semantic context is not identified by one exact typed findings declaration");
  }
  const stage = declaredStages[0]!;
  const sibling = (contract: PlannedGraphNode["outputs"][number]["contract"], label: string) => {
    const artifact = semanticSiblingJsonArtifact(input.artifactDir, input.node, contract, label, input.authenticated);
    return {
      value: artifact.value,
      declaredPath: artifact.path
    };
  };
  const optionalSibling = (contract: PlannedGraphNode["outputs"][number]["contract"], label: string) => {
    const count = input.node.outputs.filter((output) => output.contract === contract).length;
    if (count === 0) return undefined;
    if (count !== 1) throw new Error(`${label} must have at most one exact declared output`);
    return sibling(contract, label).value;
  };
  const finalized = (contract: PlannedGraphNode["outputs"][number]["contract"], label: string, directOnly: boolean) =>
    finalizedSingletonAncestorOutput(input.layout, input.node, contract, label, input.attemptAuthority, {
      directOnly
    })?.value;
  if (stage === "dedupe-findings") {
    const findings = sibling("ultrafuzz/findings@2", "deduped findings");
    const strategyDetections = optionalSibling("ultrafuzz/strategy-detections@1", "dedupe strategy detections");
    return {
      stage: "dedupe",
      findingsArtifactPath: findings.declaredPath,
      findings: findings.value,
      lifecycleLedger: sibling("ultrafuzz/finding-lifecycle-ledger@1", "dedupe lifecycle ledger").value,
      ...(strategyDetections === undefined ? {} : { strategyDetections })
    };
  }
  if (stage === "triage") {
    const findings = sibling("ultrafuzz/triaged-findings@1", "triaged findings");
    return {
      stage: "triage",
      findingsArtifactPath: findings.declaredPath,
      findings: findings.value,
      lifecycleLedger: sibling("ultrafuzz/finding-lifecycle-ledger@1", "triage lifecycle ledger").value,
      upstreamLifecycleLedger: finalized("ultrafuzz/finding-lifecycle-ledger@1", "dedupe lifecycle ledger", true),
      upstreamStrategyDetections: finalized("ultrafuzz/strategy-detections@1", "dedupe strategy detections", true)
    };
  }
  if (stage === "severity-classification") {
    const findings = sibling("ultrafuzz/severity-classified-findings@1", "severity findings");
    const strategyDetections = optionalSibling("ultrafuzz/strategy-detections@1", "severity strategy detections");
    return {
      stage: "severity-classification",
      findingsArtifactPath: findings.declaredPath,
      findings: findings.value,
      lifecycleLedger: sibling("ultrafuzz/finding-lifecycle-ledger@1", "severity lifecycle ledger").value,
      ...(strategyDetections === undefined ? {} : { strategyDetections }),
      upstreamLifecycleLedger: finalized("ultrafuzz/finding-lifecycle-ledger@1", "triage lifecycle ledger", true),
      upstreamStrategyDetections: finalized("ultrafuzz/strategy-detections@1", "dedupe strategy detections", false)
    };
  }
  return undefined;
}

function semanticDedupedFindings(
  layout: RunLayout,
  consumer: PlannedGraphNode,
  attemptAuthority?: ArtifactGateAttemptAuthority
): unknown | undefined {
  return finalizedSingletonAncestorOutput(
    layout,
    consumer,
    "ultrafuzz/findings@2",
    "deduped findings semantic context",
    attemptAuthority,
    { directOnly: true }
  )?.value;
}

function semanticFinalSeverityContext(
  layout: RunLayout,
  consumer: PlannedGraphNode,
  attemptAuthority?: ArtifactGateAttemptAuthority
): { severityClassifiedFindings: unknown | null | undefined; findingLifecycleLedger?: unknown } {
  const producers = finalizedDeclaredContractProducers(
    layout,
    "ultrafuzz/severity-classified-findings@1",
    consumer,
    attemptAuthority
  );
  if (producers.length === 0) return { severityClassifiedFindings: null };
  if (producers.length !== 1 || producers[0]!.outputs.length !== 1) {
    throw new Error(
      `final report severity authority is ambiguous: expected one finalized producer/output, found ${producers.length}`
    );
  }
  const producer = producers[0]!;
  const severity = producer.outputs[0]!;
  const declaredLedgerPaths = producer.node.outputs
    .filter((output) => output.contract === "ultrafuzz/finding-lifecycle-ledger@1")
    .map((output) => output.path)
    .sort();
  const ledgers = producer.authority.outputs.filter(
    (output) => output.contract === "ultrafuzz/finding-lifecycle-ledger@1"
  );
  const finalizedLedgerPaths = ledgers.map((output) => output.path).sort();
  if (
    declaredLedgerPaths.length !== 1 ||
    ledgers.length !== 1 ||
    !sameStringSequence(declaredLedgerPaths, finalizedLedgerPaths)
  ) {
    throw new Error(
      `finalized severity producer ${JSON.stringify(producer.attemptId)} must declare exactly one paired lifecycle ledger`
    );
  }
  return {
    severityClassifiedFindings: assertContractDocument(
      severity.value,
      severity.absolute_path,
      "ultrafuzz/severity-classified-findings@1"
    ),
    findingLifecycleLedger: assertContractDocument(
      ledgers[0]!.value,
      ledgers[0]!.absolute_path,
      "ultrafuzz/finding-lifecycle-ledger@1"
    )
  };
}

function semanticCampaignArtifacts(
  artifactDir: string,
  node: PlannedGraphNode,
  authenticated?: AuthenticatedArtifactGateSnapshots
): SemanticArtifactSetContext {
  const campaignOutputs = node.outputs.filter((output) => output.contract === "ultrafuzz/property-campaign@3");
  const findingOutputs = node.outputs.filter((output) => output.contract === "ultrafuzz/findings@2");
  const campaigns: PropertyCampaignArtifact[] = [];
  const findings: Array<Readonly<Record<string, unknown>>> = [];
  for (const output of campaignOutputs) {
    const artifactPath = safeResolveInside(artifactDir, output.path, "campaign semantic context");
    const artifact = parseCurrentArtifactJson(artifactDir, artifactPath, authenticated);
    if (artifact === undefined) throw new Error(`campaign semantic context is unavailable: ${artifactPath}`);
    const parsed = validatePropertyCampaignSchema(
      assertContractDocument(artifact, artifactPath, "ultrafuzz/property-campaign@3"),
      artifactPath
    );
    if (!parsed.ok || parsed.value === undefined) {
      throw new Error(`campaign semantic context is schema-invalid: ${artifactPath}`);
    }
    campaigns.push(parsed.value);
  }
  for (const output of findingOutputs) {
    const artifactPath = safeResolveInside(artifactDir, output.path, "finding semantic context");
    const artifact = parseCurrentArtifactJson(artifactDir, artifactPath, authenticated);
    if (artifact === undefined) throw new Error(`finding semantic context is unavailable: ${artifactPath}`);
    const parsed = validateFindingsSchema(
      assertContractDocument(artifact, artifactPath, "ultrafuzz/findings@2"),
      artifactPath
    );
    if (!parsed.ok || parsed.value === undefined) {
      throw new Error(`finding semantic context is schema-invalid: ${artifactPath}`);
    }
    findings.push(...parsed.value);
  }
  return { campaigns, findings };
}

function semanticCanonicalPropertyCatalog(
  layout: RunLayout,
  consumer: PlannedGraphNode,
  attemptAuthority?: ArtifactGateAttemptAuthority
): PropertiesArtifact | undefined {
  const pair = finalizedCanonicalPropertyPair(layout, consumer, attemptAuthority);
  if (pair !== undefined) return pair.value;
  return plannedContractProducerStatus(layout, consumer, CANONICAL_PROPERTIES_CONTRACT, attemptAuthority) === "absent"
    ? UNPLANNED_PROPERTY_CATALOG_CONTEXT
    : undefined;
}

function semanticImplementedPropertiesArtifact(
  layout: RunLayout,
  consumer: PlannedGraphNode,
  attemptAuthority?: ArtifactGateAttemptAuthority
): { value: ImplementedPropertiesArtifact; path: string } | undefined {
  const artifact = finalizedSingletonAncestorOutput(
    layout,
    consumer,
    "ultrafuzz/implemented-properties@3",
    "implemented property semantic context",
    attemptAuthority
  );
  if (artifact !== undefined) {
    const parsed = validateImplementedPropertiesSchema(artifact.value, artifact.absolute_path);
    if (!parsed.ok || parsed.value === undefined) {
      throw new Error(`implemented property semantic context is schema-invalid: ${artifact.absolute_path}`);
    }
    return { value: parsed.value, path: artifact.path };
  }
  return undefined;
}

function semanticImplementedProperties(
  layout: RunLayout,
  consumer: PlannedGraphNode,
  attemptAuthority?: ArtifactGateAttemptAuthority
): ImplementedPropertiesArtifact | undefined {
  const artifact = semanticImplementedPropertiesArtifact(layout, consumer, attemptAuthority);
  if (artifact !== undefined) return artifact.value;
  return plannedContractProducerStatus(layout, consumer, "ultrafuzz/implemented-properties@3", attemptAuthority) ===
    "absent"
    ? UNPLANNED_IMPLEMENTED_PROPERTIES_CONTEXT
    : undefined;
}

function semanticCampaignSummary(
  layout: RunLayout,
  consumer: PlannedGraphNode,
  attemptAuthority?: ArtifactGateAttemptAuthority
): { value: unknown | null; path?: string } | undefined {
  const artifact = finalizedSingletonAncestorOutput(
    layout,
    consumer,
    "ultrafuzz/campaign-summary@2",
    "campaign summary semantic context",
    attemptAuthority
  );
  if (artifact !== undefined) return { value: artifact.value, path: artifact.path };
  return plannedContractProducerStatus(layout, consumer, "ultrafuzz/campaign-summary@2", attemptAuthority) === "absent"
    ? { value: null }
    : undefined;
}

function plannedContractProducerStatus(
  layout: RunLayout,
  consumer: PlannedGraphNode,
  contract: PlannedGraphNode["outputs"][number]["contract"],
  attemptAuthority?: ArtifactGateAttemptAuthority
): "absent" | "present" | "unknown" {
  if (attemptAuthority !== undefined) {
    try {
      const { current, declarations } = semanticAttemptDeclarations(consumer, attemptAuthority);
      assertRegularFileInside(layout.root, layout.graphPath, "planned contract producer authority");
      const graph = assertPlannedGraph(readStrictRegisteredDocument(layout.graphPath, "planned-graph.schema.json"));
      assertExactSealedAttemptAuthority(layout, graph, consumer, attemptAuthority);
      return declaredAncestorOutputsByContract(current, declarations, contract).length === 0 ? "absent" : "present";
    } catch {
      return "unknown";
    }
  }
  if (!fs.existsSync(layout.graphPath)) return "unknown";
  try {
    assertRegularFileInside(layout.root, layout.graphPath, "planned graph semantic context");
    const graph = assertPlannedGraph(readStrictRegisteredDocument(layout.graphPath, "planned-graph.schema.json"));
    const ancestorIds = plannedAncestorIds(graph, consumer);
    return graph.nodes.some(
      (node) => ancestorIds.has(node.id) && node.outputs.some((output) => output.contract === contract)
    )
      ? "present"
      : "absent";
  } catch {
    return "unknown";
  }
}

type FinalizedDeclaredProducer = {
  attemptId: string;
  node: PlannedGraphNode;
  authority: ReturnType<typeof loadFinalizedNodeOutputSnapshot>;
  outputs: readonly VerifiedOutputArtifactSnapshot[];
};

function semanticAttemptDeclarations(
  consumer: PlannedGraphNode,
  authority: ArtifactGateAttemptAuthority
): { current: SemanticArtifactTaskDeclaration; declarations: SemanticArtifactTaskDeclaration[] } {
  if (
    authority.task.concreteNodeId !== consumer.id ||
    authority.task.logicalNodeId !== (consumer.logical_id ?? consumer.id)
  ) {
    throw new Error(
      `sealed Smithers attempt ${JSON.stringify(authority.task.attemptId)} does not bind consumer ${JSON.stringify(consumer.id)}`
    );
  }
  const currentTasks = authority.tasks.filter((task) => task.attemptId === authority.task.attemptId);
  if (currentTasks.length !== 1 || currentTasks[0] !== authority.task) {
    throw new Error(
      `current Smithers attempt is not the exact unique declaration in the sealed task set: ${authority.task.attemptId}`
    );
  }
  const declarations = authority.tasks.map((task): SemanticArtifactTaskDeclaration => ({
    attemptId: task.attemptId,
    logicalNodeId: task.logicalNodeId,
    artifactDir: task.artifactDir,
    dependencies: task.dependencies,
    dependencyArtifactDirs: task.dependencyArtifactDirs,
    outputs: task.metadata.artifacts.outputs.map((output) => ({ path: output.path, contract: output.contract }))
  }));
  const current = declarations.find((task) => task.attemptId === authority.task.attemptId);
  if (current === undefined) {
    throw new Error(`current Smithers attempt is absent from the sealed task set: ${authority.task.attemptId}`);
  }
  return { current, declarations };
}

function plannedAttemptIdsForAuthority(node: PlannedGraphNode): string[] {
  if (node.model_fanout.length <= 1) return [node.id];
  return node.model_fanout.map((model) => `${node.id}__model_${model.model_index}__attempt_${model.attempt_index}`);
}

function assertExactStringSet(actual: readonly string[], expected: readonly string[], label: string): void {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const duplicates = (values: readonly string[]): string[] => {
    const seen = new Set<string>();
    const repeated = new Set<string>();
    for (const value of values) {
      if (seen.has(value)) repeated.add(value);
      else seen.add(value);
    }
    return [...repeated];
  };
  const duplicateActual = duplicates(actual);
  const duplicateExpected = duplicates(expected);
  const missing = expected.filter((value) => !actualSet.has(value));
  const unexpected = actual.filter((value) => !expectedSet.has(value));
  if (duplicateActual.length === 0 && duplicateExpected.length === 0 && missing.length === 0 && unexpected.length === 0)
    return;
  const summarize = (values: readonly string[]): string => {
    const visible = [...new Set(values)].slice(0, 8);
    return `${visible.map((value) => JSON.stringify(value)).join(", ")}${values.length > visible.length ? `, and ${values.length - visible.length} more` : ""}`;
  };
  throw new Error(
    `${label} does not match the exact planned set` +
      `${missing.length === 0 ? "" : `; missing: ${summarize(missing)}`}` +
      `${unexpected.length === 0 ? "" : `; unexpected: ${summarize(unexpected)}`}` +
      `${duplicateActual.length === 0 ? "" : `; duplicate actual values: ${summarize(duplicateActual)}`}` +
      `${duplicateExpected.length === 0 ? "" : `; duplicate planned values: ${summarize(duplicateExpected)}`}`
  );
}

/** Bind the complete sealed task set and this attempt's artifact closure to the current graph. */
function assertExactSealedAttemptAuthority(
  layout: RunLayout,
  graph: PlannedGraph,
  consumer: PlannedGraphNode,
  authority: ArtifactGateAttemptAuthority
): void {
  semanticAttemptDeclarations(consumer, authority);
  const plannedConsumer = graph.nodes.find((node) => node.id === consumer.id);
  if (plannedConsumer === undefined || plannedConsumer.logical_id !== consumer.logical_id) {
    throw new Error(`planned graph does not bind exact consumer ${JSON.stringify(consumer.id)}`);
  }
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const plannedAgenticAttempts = new Map<string, PlannedGraphNode>();
  for (const node of graph.nodes) {
    if (node.kind !== "agentic") continue;
    for (const attemptId of plannedAttemptIdsForAuthority(node)) {
      if (plannedAgenticAttempts.has(attemptId)) {
        throw new Error(`planned graph repeats Smithers attempt ${JSON.stringify(attemptId)}`);
      }
      plannedAgenticAttempts.set(attemptId, node);
    }
  }

  const tasksByAttempt = new Map<string, SmithersTaskManifestTask>();
  for (const task of authority.tasks) {
    if (tasksByAttempt.has(task.attemptId)) {
      throw new Error(`sealed Smithers task set repeats attempt ${JSON.stringify(task.attemptId)}`);
    }
    tasksByAttempt.set(task.attemptId, task);
  }
  assertExactStringSet([...tasksByAttempt.keys()], [...plannedAgenticAttempts.keys()], "sealed Smithers task coverage");
  for (const [attemptId, node] of plannedAgenticAttempts) {
    const task = tasksByAttempt.get(attemptId)!;
    const expectedArtifactDir = getNodeArtifactDir(layout, attemptId);
    if (
      task.concreteNodeId !== node.id ||
      task.logicalNodeId !== node.logical_id ||
      path.resolve(task.artifactDir) !== expectedArtifactDir ||
      task.metadata.artifacts.outputs.length !== node.outputs.length ||
      task.metadata.artifacts.outputs.some(
        (output) => !node.outputs.some((planned) => smithersOutputMatchesPlanned(output, planned))
      ) ||
      node.outputs.some(
        (planned) => !task.metadata.artifacts.outputs.some((output) => smithersOutputMatchesPlanned(output, planned))
      )
    ) {
      throw new Error(`sealed Smithers attempt does not match its planned node and outputs: ${attemptId}`);
    }
    const expectedDirectDependencies = node.depends_on.flatMap((dependencyId) => {
      const dependency = nodesById.get(dependencyId);
      if (dependency === undefined) {
        throw new Error(`planned dependency ${JSON.stringify(dependencyId)} is unavailable`);
      }
      return plannedAttemptIdsForAuthority(dependency);
    });
    assertExactStringSet(
      task.dependencies,
      expectedDirectDependencies,
      `sealed Smithers attempt ${JSON.stringify(attemptId)} direct dependencies`
    );
  }

  const ancestorNodeIds = plannedAncestorIds(graph, plannedConsumer);
  const expectedAncestorAttempts = graph.nodes
    .filter((node) => ancestorNodeIds.has(node.id))
    .flatMap(plannedAttemptIdsForAuthority);
  const expectedAncestorDirectories = expectedAncestorAttempts.map((attemptId) =>
    getNodeArtifactDir(layout, attemptId)
  );
  const actualAncestorDirectories = authority.task.dependencyArtifactDirs.map((directory) => path.resolve(directory));
  assertExactStringSet(
    actualAncestorDirectories,
    expectedAncestorDirectories,
    `sealed Smithers attempt ${JSON.stringify(authority.task.attemptId)} artifact ancestor closure`
  );
}

function plannedAncestorIds(
  graph: ReturnType<typeof assertPlannedGraph>,
  consumer: PlannedGraphNode
): ReadonlySet<string> {
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const plannedConsumers = graph.nodes.filter((node) => node.id === consumer.id);
  if (plannedConsumers.length !== 1) {
    throw new Error(`planned graph does not bind exact consumer ${JSON.stringify(consumer.id)}`);
  }
  const ancestors = new Set<string>();
  const pending = [...plannedConsumers[0]!.depends_on];
  while (pending.length > 0) {
    const dependencyId = pending.shift()!;
    const dependency = byId.get(dependencyId);
    if (dependency === undefined) {
      throw new Error(
        `planned consumer ${JSON.stringify(consumer.id)} names missing concrete dependency ${JSON.stringify(dependencyId)}`
      );
    }
    if (ancestors.has(dependency.id)) continue;
    ancestors.add(dependency.id);
    pending.push(...dependency.depends_on);
  }
  return ancestors;
}

function plannedDirectDependencyNodes(layout: RunLayout, consumer: PlannedGraphNode): readonly PlannedGraphNode[] {
  assertRegularFileInside(layout.root, layout.graphPath, "planned direct dependency authority");
  const graph = assertPlannedGraph(readStrictRegisteredDocument(layout.graphPath, "planned-graph.schema.json"));
  const plannedConsumers = graph.nodes.filter((node) => node.id === consumer.id);
  if (plannedConsumers.length !== 1) {
    throw new Error(`planned graph does not bind exact consumer ${JSON.stringify(consumer.id)}`);
  }
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const dependencies: PlannedGraphNode[] = [];
  for (const dependencyId of plannedConsumers[0]!.depends_on) {
    const dependency = byId.get(dependencyId);
    if (dependency === undefined) {
      throw new Error(
        `planned consumer ${JSON.stringify(consumer.id)} names missing concrete dependency ${JSON.stringify(dependencyId)}`
      );
    }
    dependencies.push(dependency);
  }
  return dependencies;
}

function finalizedDeclaredContractProducers(
  layout: RunLayout,
  contract: PlannedGraphNode["outputs"][number]["contract"],
  consumer: PlannedGraphNode,
  attemptAuthority?: ArtifactGateAttemptAuthority,
  options: { directOnly?: boolean } = {}
): FinalizedDeclaredProducer[] {
  assertRegularFileInside(layout.root, layout.graphPath, "planned graph finalized artifact authority");
  const graph = assertPlannedGraph(readStrictRegisteredDocument(layout.graphPath, "planned-graph.schema.json"));
  let current: SemanticArtifactTaskDeclaration;
  let declarations: SemanticArtifactTaskDeclaration[];
  const concreteNodeIdByAttempt = new Map<string, string>();
  const sealedTaskByAttempt = new Map<string, SmithersTaskManifestTask>();
  if (attemptAuthority !== undefined) {
    ({ current, declarations } = semanticAttemptDeclarations(consumer, attemptAuthority));
    for (const task of attemptAuthority.tasks) {
      if (sealedTaskByAttempt.has(task.attemptId)) {
        throw new Error(`sealed Smithers task set repeats attempt ${JSON.stringify(task.attemptId)}`);
      }
      sealedTaskByAttempt.set(task.attemptId, task);
      concreteNodeIdByAttempt.set(task.attemptId, task.concreteNodeId);
    }
  } else {
    const ancestorIds = plannedAncestorIds(graph, consumer);
    const artifactDirectory = (node: PlannedGraphNode): string =>
      safeResolveInside(layout.root, node.artifact_dir, `planned artifact directory for ${node.id}`);
    const ancestorDirectories = graph.nodes
      .filter((node) => ancestorIds.has(node.id))
      .map((node) => artifactDirectory(node));
    declarations = graph.nodes.map((node) => ({
      attemptId: node.id,
      logicalNodeId: node.logical_id,
      artifactDir: artifactDirectory(node),
      dependencies: node.depends_on,
      dependencyArtifactDirs: node.id === consumer.id ? ancestorDirectories : [],
      outputs: node.outputs
    }));
    current = declarations.find((declaration) => declaration.attemptId === consumer.id)!;
    if (current === undefined) {
      throw new Error(`planned graph does not bind exact consumer ${JSON.stringify(consumer.id)}`);
    }
    for (const node of graph.nodes) concreteNodeIdByAttempt.set(node.id, node.id);
  }
  if (attemptAuthority !== undefined) {
    assertExactSealedAttemptAuthority(layout, graph, consumer, attemptAuthority);
  }
  const bindings = declaredAncestorOutputsByContract(current, declarations, contract, options);
  const bindingsByAttempt = new Map<string, typeof bindings>();
  for (const binding of bindings) {
    bindingsByAttempt.set(binding.attemptId, [...(bindingsByAttempt.get(binding.attemptId) ?? []), binding]);
  }
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node] as const));
  return [...bindingsByAttempt.entries()].map(([attemptId, declaredOutputs]) => {
    const concreteNodeId = concreteNodeIdByAttempt.get(attemptId);
    const node = concreteNodeId === undefined ? undefined : nodesById.get(concreteNodeId);
    if (node === undefined)
      throw new Error(`declared semantic producer is absent from the planned graph: ${attemptId}`);
    const sealedTask = sealedTaskByAttempt.get(attemptId);
    if (
      attemptAuthority !== undefined &&
      (sealedTask === undefined ||
        node.kind !== "agentic" ||
        sealedTask.logicalNodeId !== node.logical_id ||
        (node.workflow !== undefined && !node.workflow.task_node_ids.includes(`node:${attemptId}`)))
    ) {
      throw new Error(`sealed semantic producer does not bind its planned attempt: ${attemptId}`);
    }
    if (sealedTask !== undefined) {
      const sealedOutputs = sealedTask.metadata.artifacts.outputs.filter((output) => output.contract === contract);
      const plannedOutputs = node.outputs.filter((output) => output.contract === contract);
      if (
        sealedOutputs.length !== plannedOutputs.length ||
        sealedOutputs.some((output) => !plannedOutputs.some((planned) => smithersOutputMatchesPlanned(output, planned)))
      ) {
        throw new Error(`sealed ${contract} declaration does not match the planned producer: ${attemptId}`);
      }
    }
    let outputAuthority: ReturnType<typeof loadFinalizedNodeOutputSnapshot>;
    try {
      outputAuthority = loadFinalizedNodeOutputSnapshot({
        runRoot: layout.root,
        logicalNodeId: node.logical_id,
        attemptId
      });
    } catch (error) {
      throw new Error(
        `finalized ${contract} authority is invalid for ${attemptId}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
    const declaredPaths = declaredOutputs.map((output) => output.path).sort();
    const outputs = outputAuthority.outputs.filter((output) => output.contract === contract);
    const finalizedPaths = outputs.map((output) => output.path).sort();
    if (!sameStringSequence(declaredPaths, finalizedPaths)) {
      throw new Error(`finalized ${contract} authority does not match the current declarations for ${attemptId}`);
    }
    return { attemptId, node, authority: outputAuthority, outputs };
  });
}

interface FinalizedCanonicalPropertyPair {
  producer: FinalizedDeclaredProducer;
  catalog: VerifiedOutputArtifactSnapshot;
  markdown: VerifiedOutputArtifactSnapshot;
  value: PropertiesArtifact;
}

function finalizedCanonicalPropertyPair(
  layout: RunLayout,
  consumer: PlannedGraphNode,
  attemptAuthority?: ArtifactGateAttemptAuthority
): FinalizedCanonicalPropertyPair | undefined {
  const bindings = finalizedDeclaredContractProducers(
    layout,
    CANONICAL_PROPERTIES_CONTRACT,
    consumer,
    attemptAuthority
  ).flatMap((producer) => producer.outputs.map((catalog) => ({ producer, catalog })));
  if (bindings.length === 0) return undefined;
  if (bindings.length !== 1) {
    throw new Error(
      `canonical property authority is ambiguous: expected one finalized ${CANONICAL_PROPERTIES_CONTRACT} output, found ${bindings.length}`
    );
  }
  const { producer, catalog } = bindings[0]!;
  const declaration = declaredCanonicalPropertiesPair(producer.node);
  if (
    declaration === undefined ||
    declaration.catalog?.path !== catalog.path ||
    declaration.markdown === undefined ||
    declaration.diagnostics.some((diagnostic) => diagnostic.severity === "error")
  ) {
    const details = declaration?.diagnostics
      .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
      .join("; ");
    throw new Error(
      `canonical property authority does not bind one exact typed JSON/Markdown producer${details === undefined || details.length === 0 ? "" : `: ${details}`}`
    );
  }
  const markdownOutputs = producer.authority.outputs.filter(
    (output) => output.contract === CANONICAL_PROPERTIES_MARKDOWN_CONTRACT
  );
  if (markdownOutputs.length !== 1 || markdownOutputs[0]!.path !== declaration.markdown.path) {
    throw new Error("finalized canonical properties Markdown authority does not match its exact producer declaration");
  }
  const parsed = validatePropertiesSchema(catalog.value, catalog.absolute_path);
  if (!parsed.ok || parsed.value === undefined) {
    throw new Error(`canonical property semantic context is schema-invalid: ${catalog.absolute_path}`);
  }
  const markdown = markdownOutputs[0]!;
  const markdownText = new TextDecoder("utf-8", { fatal: true }).decode(markdown.bytes);
  const parityIssues = canonicalPropertiesMarkdownParityIssues(parsed.value, markdownText, markdown.absolute_path);
  if (parityIssues.length > 0) {
    throw new Error(
      `canonical property JSON/Markdown authority is inconsistent: ${parityIssues
        .map((issue) => `${issue.code} ${issue.path}: ${issue.message}`)
        .join("; ")}`
    );
  }
  return { producer, catalog, markdown, value: parsed.value };
}

function finalizedSingletonAncestorOutput(
  layout: RunLayout,
  consumer: PlannedGraphNode,
  contract: PlannedGraphNode["outputs"][number]["contract"],
  label: string,
  attemptAuthority?: ArtifactGateAttemptAuthority,
  options: { directOnly?: boolean } = {}
): VerifiedOutputArtifactSnapshot | undefined {
  const outputs = finalizedDeclaredContractProducers(layout, contract, consumer, attemptAuthority, options).flatMap(
    (producer) => producer.outputs.slice()
  );
  if (outputs.length === 0) return undefined;
  if (outputs.length !== 1) {
    throw new Error(`${label} is ambiguous: expected one finalized ${contract} output, found ${outputs.length}`);
  }
  return outputs[0];
}

function semanticPropertyLenses(
  layout: RunLayout,
  consumer: PlannedGraphNode,
  attemptAuthority?: ArtifactGateAttemptAuthority
): SemanticPropertyLensContext[] | undefined {
  const state = readRunState(layout);
  const lenses: SemanticPropertyLensContext[] = [];
  let producerCount = 0;
  // Discovery is the transitive root evidence authority for every property
  // lens and fan-in, even though fan-in depends directly on the lens nodes.
  const ledgerArtifacts = finalizedDeclaredContractProducers(
    layout,
    "ultrafuzz/invariant-ledger@1",
    consumer,
    attemptAuthority
  ).flatMap((producer) => producer.outputs.map((artifact) => ({ producer, artifact })));
  if (ledgerArtifacts.length === 0) return undefined;
  if (ledgerArtifacts.length !== 1) {
    throw new Error(
      `property semantic context is ambiguous: expected one finalized ultrafuzz/invariant-ledger@1 output, found ${ledgerArtifacts.length}`
    );
  }
  for (const { producer, artifact: ledgerArtifact } of ledgerArtifacts) {
    const declaration = declaredInvariantLedgerProducerPair(producer.node);
    if (
      declaration === undefined ||
      declaration.ledger?.path !== ledgerArtifact.path ||
      declaration.diagnostics.some((diagnostic) => diagnostic.severity === "error")
    ) {
      const details = declaration?.diagnostics
        .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
        .join("; ");
      throw new Error(
        `property semantic context does not bind one exact invariant-ledger JSON/Markdown producer${details === undefined || details.length === 0 ? "" : `: ${details}`}`
      );
    }
    producerCount += 1;
    const ledger = validateInvariantLedgerSchema(ledgerArtifact.value, ledgerArtifact.absolute_path);
    if (!ledger.ok || ledger.value === undefined) {
      throw new Error(`property semantic context contains a schema-invalid invariant ledger: ${ledgerArtifact.path}`);
    }
    lenses.push({
      sourceNodeId: producer.node.logical_id,
      projectionRequired: false,
      document: { properties: ledger.value.entries.map((entry) => ({ id: entry.id })) }
    });
  }

  const directDependencies: DirectArtifactDependency[] =
    attemptAuthority === undefined
      ? plannedDirectDependencyNodes(layout, consumer).map((dependency) => ({
          attemptId: dependency.id,
          node: dependency
        }))
      : sealedDirectArtifactDependencies(layout, consumer, attemptAuthority);
  for (const dependency of directDependencies) {
    const nodeId = dependency.attemptId;
    const nodeState = state.nodes[nodeId];
    if (
      attemptAuthority === undefined &&
      nodeState?.logical_node_id !== undefined &&
      nodeState.logical_node_id !== dependency.node.logical_id
    ) {
      throw new Error(`property semantic dependency state does not bind planned node ${dependency.attemptId}`);
    }
    const declaredLensCount =
      dependency.task?.metadata.artifacts.outputs.filter((output) => output.contract === PROPERTY_LENS_CONTRACT)
        .length ?? dependency.node.outputs.filter((output) => output.contract === PROPERTY_LENS_CONTRACT).length;
    if (declaredLensCount === 0) continue;
    if (declaredLensCount !== 1) {
      throw new Error(
        `property semantic dependency ${dependency.attemptId} declares ${declaredLensCount} ultrafuzz/property-lens@2 outputs`
      );
    }
    producerCount += 1;
    const lens =
      attemptAuthority === undefined
        ? loadFinalizedPropertyLens(layout, state, nodeId, "property-fanin")
        : loadFinalizedTaskPropertyLens(layout, dependency, "property-fanin");
    if (!lens.ok) {
      throw new Error(
        `property semantic lens authority is invalid for ${dependency.attemptId}: ${lens.diagnostics
          .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
          .join("; ")}`
      );
    }
    lenses.push({ sourceNodeId: dependency.node.logical_id, projectionRequired: true, document: lens.document });
  }
  return producerCount === 0 ? undefined : lenses;
}

function workspacePatchGitContext(
  layout: RunLayout,
  artifactDir: string,
  attemptId: string,
  authenticated?: AuthenticatedArtifactGateSnapshots
): SemanticGitContext | undefined {
  const baselinePath = path.join(artifactDir, "workspace-patch-baseline.json");
  const patchPath = path.join(artifactDir, "workspace.patch");
  const workspacePath = path.join(layout.workspacesDir, attemptId);
  try {
    const baselineBytes = readCurrentArtifactSnapshot(artifactDir, baselinePath, authenticated);
    const patchBytes = readCurrentArtifactSnapshot(artifactDir, patchPath, authenticated);
    if (baselineBytes === undefined || patchBytes === undefined) return undefined;
    assertNoSymlinkComponents(layout.root, workspacePath, "workspace patch Git context");
    const baseline = parseRuntimeDocumentBytes(
      WORKSPACE_PATCH_BASELINE_JSON_SCHEMA_ID,
      baselineBytes,
      "workspace patch baseline"
    );
    if (baseline.attempt_id !== attemptId || typeof baseline.baseline_tree !== "string") {
      return undefined;
    }
    return deriveWorkspacePatchGitFacts(workspacePath, baseline.baseline_tree, patchBytes.toString("utf8"));
  } catch {
    return undefined;
  }
}

function assertContractDocument(
  document: unknown,
  artifactPath: string,
  contract: Parameters<typeof artifactContractSchemaBinding>[0]
): unknown {
  const binding = artifactContractSchemaBinding(contract);
  if (binding === undefined) throw new Error(`registered schema binding is unavailable for ${contract}`);
  if (!validateRegisteredJsonSchema(binding.schema_id, document).ok) {
    throw new Error(`registered ${contract} document is schema-invalid: ${artifactPath}`);
  }
  return document;
}

function readStrictRegisteredDocument(artifactPath: string, schemaFilename: ArtifactSchemaFilename): unknown {
  const registration = artifactSchemaRegistry().find((entry) => entry.filename === schemaFilename);
  if (registration === undefined) throw new Error(`registered schema is unavailable: ${schemaFilename}`);
  const document = parseStrictJsonBytes(readRegularFileSnapshot(artifactPath, MAX_ARTIFACT_SNAPSHOT_BYTES));
  if (!validateRegisteredJsonSchema(registration.id, document).ok) {
    throw new Error(`registered ${schemaFilename} document is schema-invalid: ${artifactPath}`);
  }
  return document;
}

function verifyRequiredArtifactSchemaBinding(
  absolutePath: string,
  output: PlannedGraphNode["outputs"][number],
  artifactBytes: Uint8Array
): RuntimeDiagnostic[] {
  const expected = artifactContractSchemaBinding(output.contract);
  const actual = {
    schema_file: output.schema_file,
    schema_id: output.schema_id,
    schema_sha256: output.schema_sha256,
    schema_bundle_sha256: output.schema_bundle_sha256,
    validator_build: output.validator_build
  };
  if (
    expected?.schema_file !== actual.schema_file ||
    expected?.schema_id !== actual.schema_id ||
    expected?.schema_sha256 !== actual.schema_sha256 ||
    expected?.schema_bundle_sha256 !== actual.schema_bundle_sha256 ||
    expected?.validator_build !== actual.validator_build
  ) {
    return [
      {
        code: "ARTIFACT_SCHEMA_BINDING_MISMATCH",
        message: `Planned schema identity for ${output.path} does not match validator build ${expected?.validator_build ?? "unbound"}`,
        severity: "error",
        source: "artifact-schema",
        path: absolutePath,
        details: { contract: output.contract, expected: expected ?? null, actual }
      }
    ];
  }
  if (expected === undefined) return [];

  const validation = validateRegisteredJsonBytesSync({
    schemaPath: path.join(artifactSchemaDirectory(), expected.schema_file),
    instanceBytes: artifactBytes
  });
  if (
    validation.schema?.id !== expected.schema_id ||
    validation.schema?.sha256 !== expected.schema_sha256 ||
    validation.schema?.bundle_sha256 !== expected.schema_bundle_sha256 ||
    validation.schema?.validator_build !== expected.validator_build
  ) {
    return [
      {
        code: "ARTIFACT_VALIDATOR_IDENTITY_MISMATCH",
        message: `Host validator identity for ${output.path} does not match the planned schema binding`,
        severity: "error",
        source: "artifact-schema",
        path: absolutePath,
        details: { contract: output.contract, expected, actual: validation.schema }
      }
    ];
  }
  if (validation.status === "valid") return [];
  return validation.diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    message: diagnostic.message,
    severity: "error" as const,
    source: "artifact-schema",
    path: `${absolutePath}${diagnostic.instancePath === undefined ? "" : `#${diagnostic.instancePath || "/"}`}`,
    details: {
      contract: output.contract,
      schema_id: expected.schema_id,
      schema_sha256: expected.schema_sha256,
      schema_bundle_sha256: expected.schema_bundle_sha256,
      validator_build: expected.validator_build,
      ...(diagnostic.schemaPath === undefined ? {} : { schema_path: diagnostic.schemaPath }),
      ...(diagnostic.keyword === undefined ? {} : { keyword: diagnostic.keyword })
    }
  }));
}

function verifySeverityMatrixArtifacts(
  artifactDir: string,
  node: PlannedGraphNode,
  authenticated?: AuthenticatedArtifactGateSnapshots
): RuntimeDiagnostic[] {
  const artifact = severityArtifactForNode(node);
  if (artifact === undefined) {
    return [];
  }
  const artifactPath = safeResolveInside(artifactDir, artifact.path, "severity artifact output");
  try {
    const document = parseCurrentArtifactJson(artifactDir, artifactPath, authenticated);
    if (document === undefined) return [];
    return validateSeverityMatrixArtifact({
      artifact: document,
      artifactPath,
      kind: artifact.kind
    });
  } catch (error) {
    return [diagnosticFromError(error, "severity-matrix", "SEVERITY_ARTIFACT_READ_FAILED")];
  }
}

function severityArtifactForNode(node: PlannedGraphNode): { kind: SeverityArtifactKind; path: string } | undefined {
  const logicalId = node.logical_id ?? node.id;
  if (logicalId === "severity-classification") {
    return { kind: "severity-classification", path: "severity-classified-findings.json" };
  }
  const reportOutputs = node.outputs.filter((output) => output.contract === "ultrafuzz/report@2");
  if (reportOutputs.length === 1) {
    return { kind: "final-report", path: reportOutputs[0]!.path };
  }
  return undefined;
}

const RECON_MAX_TEST_LIMIT = "18446744073709551615";
const RECON_STATEFUL_SEQUENCE_LENGTH = 100;
const CAMPAIGN_HOST_FORCE_KILL_GRACE_SECONDS = 300;
const CAMPAIGN_DURATION_TOLERANCE_MS = 5_000;
const campaignTerminationReasons = new Set([
  "configured-timeout",
  "test-limit",
  "process-exit",
  "launch-error",
  "host-force-kill"
]);
const campaignOutcomes = new Set(["complete", "partial", "blocked"]);

const currentCampaignRoleContracts = new Set<PlannedGraphNode["outputs"][number]["contract"]>([
  "ultrafuzz/invariant-campaign-plan@2",
  "ultrafuzz/property-campaign@3",
  "ultrafuzz/campaign-summary@2"
]);

function hasCurrentCampaignOutputRole(node: PlannedGraphNode): boolean {
  return node.outputs.some((output) => currentCampaignRoleContracts.has(output.contract));
}

function campaignTimeoutDiagnostic(code: string, message: string, pathValue: string): RuntimeDiagnostic {
  return {
    code,
    message,
    severity: "error",
    source: "campaign-timeout-evidence",
    path: pathValue
  };
}

function declaredCampaignTimeoutArtifactPath(
  artifactDir: string,
  node: PlannedGraphNode,
  contract: PlannedGraphNode["outputs"][number]["contract"],
  label: string,
  diagnostics: RuntimeDiagnostic[]
): string | undefined {
  const outputs = node.outputs.filter((output) => output.contract === contract);
  if (outputs.length !== 1) {
    diagnostics.push(
      campaignTimeoutDiagnostic(
        "CAMPAIGN_TIMEOUT_OUTPUT_DECLARATION_INVALID",
        `Current campaign timeout evidence requires exactly one declared ${contract} ${label}; found ${outputs.length}`,
        artifactDir
      )
    );
    return undefined;
  }
  return safeResolveInside(artifactDir, outputs[0]!.path, `campaign timeout ${label}`);
}

function positiveIntegerField(
  record: Record<string, unknown>,
  field: string,
  artifactPath: string,
  diagnostics: RuntimeDiagnostic[]
): number | undefined {
  const value = record[field];
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  diagnostics.push(
    campaignTimeoutDiagnostic(
      "CAMPAIGN_TIMEOUT_EVIDENCE_INVALID",
      `${field} must be a positive safe integer`,
      `${artifactPath}#$.${field}`
    )
  );
  return undefined;
}

function stringField(
  record: Record<string, unknown>,
  field: string,
  artifactPath: string,
  diagnostics: RuntimeDiagnostic[]
): string | undefined {
  const value = record[field];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  diagnostics.push(
    campaignTimeoutDiagnostic(
      "CAMPAIGN_TIMEOUT_EVIDENCE_INVALID",
      `${field} must be a non-empty string`,
      `${artifactPath}#$.${field}`
    )
  );
  return undefined;
}

function timestampField(
  record: Record<string, unknown>,
  field: string,
  artifactPath: string,
  diagnostics: RuntimeDiagnostic[]
): { text: string; milliseconds: number } | undefined {
  const text = stringField(record, field, artifactPath, diagnostics);
  if (text === undefined) return undefined;
  const milliseconds = Date.parse(text);
  if (Number.isFinite(milliseconds)) {
    return { text, milliseconds };
  }
  diagnostics.push(
    campaignTimeoutDiagnostic(
      "CAMPAIGN_TIMEOUT_EVIDENCE_INVALID",
      `${field} must be a valid timestamp`,
      `${artifactPath}#$.${field}`
    )
  );
  return undefined;
}

function constrainedShellTokens(command: string): string[] | undefined {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (
      character === "#" ||
      character === ";" ||
      character === "&" ||
      character === "|" ||
      character === "<" ||
      character === ">" ||
      character === "`" ||
      character === "\n" ||
      character === "\r" ||
      (character === "$" && command[index + 1] === "(")
    ) {
      return undefined;
    }
  }
  if (quote !== undefined || escaped) return undefined;
  const tokens = command.trim().split(/\s+/u);
  return tokens;
}

function exactReconCommandFlagValues(command: string, flag: "--timeout" | "--test-limit" | "--seq-len"): string[] {
  const tokens = constrainedShellTokens(command);
  if (tokens === undefined) return [];
  const reconIndexes = tokens.flatMap((token, index) =>
    token === "recon" && tokens[index + 1] === "fuzz" ? [index] : []
  );
  if (reconIndexes.length !== 1) return [];
  const argv = tokens.slice(reconIndexes[0]! + 2);
  if (argv.includes("--")) return [];
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === flag) {
      values.push(argv[index + 1] ?? "");
    } else if (token.startsWith(`${flag}=`)) {
      values.push(token.slice(flag.length + 1));
    }
  }
  return values;
}

function hasExactHostTimeoutWrapper(command: string, configuredTimeoutSeconds: number): boolean {
  const tokens = constrainedShellTokens(command);
  if (tokens === undefined) return false;
  const timeoutIndexes = tokens.flatMap((token, index) => (token === "timeout" ? [index] : []));
  if (timeoutIndexes.length !== 1 || tokens.includes("--foreground")) return false;
  const timeoutIndex = timeoutIndexes[0]!;
  const prefix = tokens.slice(0, timeoutIndex);
  const assignmentStart = prefix[0] === "env" ? 1 : 0;
  if (
    prefix.slice(assignmentStart).some((token) => !/^[A-Za-z_][A-Za-z0-9_]*=\S+$/u.test(token)) ||
    (prefix[0] === "env" && prefix.length === 1)
  ) {
    return false;
  }
  const reconIndex = tokens.indexOf("recon", timeoutIndex + 1);
  if (reconIndex < 0 || tokens[reconIndex + 1] !== "fuzz") return false;
  const wrapperArguments = tokens.slice(timeoutIndex + 1, reconIndex);
  return (
    wrapperArguments.length === 4 &&
    wrapperArguments.at(-1) === `${configuredTimeoutSeconds}s` &&
    wrapperArguments.filter((argument) => argument === "--preserve-status").length === 1 &&
    wrapperArguments.filter((argument) => argument === "--signal=INT").length === 1 &&
    wrapperArguments.filter((argument) => argument === `--kill-after=${CAMPAIGN_HOST_FORCE_KILL_GRACE_SECONDS}s`)
      .length === 1
  );
}

function readConfiguredInvariantFuzzerTimeoutSeconds(layout: RunLayout): number | undefined {
  if (!fs.existsSync(layout.resolvedConfigPath)) return undefined;
  try {
    const parsed = parseProjectConfigToml(
      fs.readFileSync(layout.resolvedConfigPath, "utf8"),
      layout.resolvedConfigPath
    );
    return parsed.ok ? parsed.value.invariants?.invariantTestingFuzzerTimeoutSeconds : undefined;
  } catch {
    return undefined;
  }
}

function configuredInvariantFuzzerTimeoutSeconds(
  layout: RunLayout,
  diagnostics: RuntimeDiagnostic[]
): number | undefined {
  if (!fs.existsSync(layout.resolvedConfigPath)) {
    diagnostics.push(
      campaignTimeoutDiagnostic(
        "CAMPAIGN_TIMEOUT_CONFIG_MISSING",
        "Current campaign timeout evidence requires the resolved configuration",
        layout.resolvedConfigPath
      )
    );
    return undefined;
  }
  const timeout = readConfiguredInvariantFuzzerTimeoutSeconds(layout);
  if (timeout !== undefined) return timeout;
  diagnostics.push(
    campaignTimeoutDiagnostic(
      "CAMPAIGN_TIMEOUT_CONFIG_MISSING",
      "Resolved configuration must declare invariants.invariant_testing_fuzzer_timeout",
      layout.resolvedConfigPath
    )
  );
  return undefined;
}

function plannedCampaignTimeoutSeconds(node: PlannedGraphNode, attemptId: string): number | undefined {
  const modelAttempt = node.model_fanout.find((model) => {
    const plannedAttemptId =
      model.attempt_id ??
      (node.model_fanout.length <= 1
        ? node.id
        : `${node.id}__model_${model.model_index}__attempt_${model.attempt_index}`);
    return plannedAttemptId === attemptId;
  });
  const timeout = node.timeout_seconds ?? modelAttempt?.timeout_seconds;
  return typeof timeout === "number" && Number.isSafeInteger(timeout) && timeout > 0 ? timeout : undefined;
}

function semanticPropertyCampaignTimeoutContext(
  layout: RunLayout,
  node: PlannedGraphNode,
  attemptId: string
): SemanticPropertyCampaignTimeoutContext | undefined {
  const configuredFuzzerTimeoutSeconds = readConfiguredInvariantFuzzerTimeoutSeconds(layout);
  const plannedTimeoutSeconds = plannedCampaignTimeoutSeconds(node, attemptId);
  if (configuredFuzzerTimeoutSeconds === undefined || plannedTimeoutSeconds === undefined) return undefined;
  return {
    configuredFuzzerTimeoutSeconds,
    plannedTimeoutSeconds,
    finalizationReserveSeconds: topologyRuntimeBudgetForTimeout(plannedTimeoutSeconds * 1_000)
      .finalizationReserveSeconds
  };
}

function verifyCurrentCampaignTimeoutEvidence(
  layout: RunLayout,
  artifactDir: string,
  node: PlannedGraphNode,
  attemptId: string,
  authenticated?: AuthenticatedArtifactGateSnapshots
): RuntimeDiagnostic[] {
  if (!hasCurrentCampaignOutputRole(node)) return [];

  const diagnostics: RuntimeDiagnostic[] = [];
  const planPath = declaredCampaignTimeoutArtifactPath(
    artifactDir,
    node,
    "ultrafuzz/invariant-campaign-plan@2",
    "plan",
    diagnostics
  );
  const resultPath = declaredCampaignTimeoutArtifactPath(
    artifactDir,
    node,
    "ultrafuzz/property-campaign@3",
    "result",
    diagnostics
  );
  const summaryPath = declaredCampaignTimeoutArtifactPath(
    artifactDir,
    node,
    "ultrafuzz/campaign-summary@2",
    "summary",
    diagnostics
  );
  const findingsPath = declaredCampaignTimeoutArtifactPath(
    artifactDir,
    node,
    "ultrafuzz/findings@2",
    "findings",
    diagnostics
  );
  if (planPath === undefined || resultPath === undefined || summaryPath === undefined || findingsPath === undefined) {
    return diagnostics;
  }
  const planValue = parseCurrentArtifactJson(artifactDir, planPath, authenticated);
  if (!isRecord(planValue) || planValue.schema_version !== "ultrafuzz.invariant-campaign-plan.v2") {
    return [
      campaignTimeoutDiagnostic(
        "CAMPAIGN_TIMEOUT_EVIDENCE_INVALID",
        "The current invariant campaign-plan contract requires schema_version ultrafuzz.invariant-campaign-plan.v2",
        `${planPath}#$.schema_version`
      )
    ];
  }
  const resultValue = parseCurrentArtifactJson(artifactDir, resultPath, authenticated);
  const summaryValue = parseCurrentArtifactJson(artifactDir, summaryPath, authenticated);
  if (!isRecord(resultValue)) {
    diagnostics.push(
      campaignTimeoutDiagnostic(
        "CAMPAIGN_TIMEOUT_EVIDENCE_INVALID",
        "The current property-campaign result must be an object",
        resultPath
      )
    );
  }
  if (!isRecord(summaryValue)) {
    diagnostics.push(
      campaignTimeoutDiagnostic(
        "CAMPAIGN_TIMEOUT_EVIDENCE_INVALID",
        "The current campaign summary must be an object",
        summaryPath
      )
    );
  }
  if (!isRecord(resultValue) || !isRecord(summaryValue)) return diagnostics;

  const configuredTimeoutSeconds = configuredInvariantFuzzerTimeoutSeconds(layout, diagnostics);

  const summarySequenceLength = positiveIntegerField(summaryValue, "sequence_length", summaryPath, diagnostics);
  if (summarySequenceLength !== RECON_STATEFUL_SEQUENCE_LENGTH) {
    diagnostics.push(
      campaignTimeoutDiagnostic(
        "CAMPAIGN_SEQUENCE_LENGTH_MISMATCH",
        `campaign summary sequence_length must be ${RECON_STATEFUL_SEQUENCE_LENGTH}`,
        `${summaryPath}#$.sequence_length`
      )
    );
  }

  const planConfiguredTimeout = positiveIntegerField(
    planValue,
    "configured_fuzzer_timeout_seconds",
    planPath,
    diagnostics
  );
  const configuredBudget = positiveIntegerField(planValue, "configured_budget_seconds", planPath, diagnostics);
  const reconInternalTimeout = positiveIntegerField(planValue, "recon_internal_timeout_seconds", planPath, diagnostics);
  const hostSoftTimeout = positiveIntegerField(planValue, "host_soft_timeout_seconds", planPath, diagnostics);
  const forceKillGrace = positiveIntegerField(planValue, "host_force_kill_grace_seconds", planPath, diagnostics);
  const finalizationReserve = positiveIntegerField(
    planValue,
    "artifact_finalization_reserve_seconds",
    planPath,
    diagnostics
  );
  const requiredFinalizationReserve = positiveIntegerField(
    planValue,
    "finalization_reserve_seconds",
    planPath,
    diagnostics
  );
  const plannedTimeoutSeconds = plannedCampaignTimeoutSeconds(node, attemptId);
  if (plannedTimeoutSeconds === undefined) {
    diagnostics.push(
      campaignTimeoutDiagnostic(
        "CAMPAIGN_TIMEOUT_PLAN_BUDGET_MISSING",
        "Current campaign timeout evidence requires the effective node, model-profile, or run-default timeout for this attempt in the sealed run graph",
        `${layout.graphPath}#$.nodes.${node.id}.effective_timeout_seconds`
      )
    );
  } else if (finalizationReserve !== undefined) {
    const expectedReserve = topologyRuntimeBudgetForTimeout(plannedTimeoutSeconds * 1_000).finalizationReserveSeconds;
    if (finalizationReserve !== expectedReserve) {
      diagnostics.push(
        campaignTimeoutDiagnostic(
          "CAMPAIGN_TIMEOUT_FINALIZATION_RESERVE_MISMATCH",
          `artifact_finalization_reserve_seconds reports ${finalizationReserve}, but the sealed topology budget requires ${expectedReserve}`,
          `${planPath}#$.artifact_finalization_reserve_seconds`
        )
      );
    }
  }
  const reconTestLimit = stringField(planValue, "recon_test_limit", planPath, diagnostics);
  const reconSequenceLength = positiveIntegerField(planValue, "recon_sequence_length", planPath, diagnostics);
  const backendStartedAt = timestampField(planValue, "backend_started_at", planPath, diagnostics);
  const fuzzingDeadline = timestampField(planValue, "fuzzing_deadline_utc", planPath, diagnostics);
  const forceKillDeadline = timestampField(planValue, "force_kill_deadline_utc", planPath, diagnostics);
  const finalArtifactDeadline = timestampField(planValue, "final_artifact_deadline_utc", planPath, diagnostics);
  const requiredDeadline = timestampField(planValue, "deadline", planPath, diagnostics);
  const planBackend = isRecord(planValue.backend) ? planValue.backend : undefined;
  if (planBackend === undefined) {
    diagnostics.push(
      campaignTimeoutDiagnostic(
        "CAMPAIGN_TIMEOUT_EVIDENCE_INVALID",
        "campaign plan backend must be an object",
        `${planPath}#$.backend`
      )
    );
  }
  const planCommand =
    planBackend === undefined
      ? undefined
      : stringField(planBackend, "exact_shell_escaped_command", `${planPath}#$.backend`, diagnostics);

  for (const [field, value] of [
    ["configured_fuzzer_timeout_seconds", planConfiguredTimeout],
    ["recon_internal_timeout_seconds", reconInternalTimeout],
    ["host_soft_timeout_seconds", hostSoftTimeout]
  ] as const) {
    if (configuredTimeoutSeconds !== undefined && value !== undefined && value !== configuredTimeoutSeconds) {
      diagnostics.push(
        campaignTimeoutDiagnostic(
          "CAMPAIGN_TIMEOUT_CONFIG_MISMATCH",
          `${field} reports ${value}, but resolved configuration requires ${configuredTimeoutSeconds}`,
          `${planPath}#$.${field}`
        )
      );
    }
  }
  if (reconTestLimit !== undefined && reconTestLimit !== RECON_MAX_TEST_LIMIT) {
    diagnostics.push(
      campaignTimeoutDiagnostic(
        "CAMPAIGN_TIMEOUT_TEST_LIMIT_MISMATCH",
        `recon_test_limit must be ${RECON_MAX_TEST_LIMIT}`,
        `${planPath}#$.recon_test_limit`
      )
    );
  }
  if (reconSequenceLength !== RECON_STATEFUL_SEQUENCE_LENGTH) {
    diagnostics.push(
      campaignTimeoutDiagnostic(
        "CAMPAIGN_SEQUENCE_LENGTH_MISMATCH",
        `recon_sequence_length must be ${RECON_STATEFUL_SEQUENCE_LENGTH} for a stateful invariant campaign`,
        `${planPath}#$.recon_sequence_length`
      )
    );
  }
  if (forceKillGrace !== undefined && forceKillGrace !== CAMPAIGN_HOST_FORCE_KILL_GRACE_SECONDS) {
    diagnostics.push(
      campaignTimeoutDiagnostic(
        "CAMPAIGN_TIMEOUT_HOST_GRACE_MISMATCH",
        `host_force_kill_grace_seconds must be ${CAMPAIGN_HOST_FORCE_KILL_GRACE_SECONDS}`,
        `${planPath}#$.host_force_kill_grace_seconds`
      )
    );
  }
  if (
    planConfiguredTimeout !== undefined &&
    forceKillGrace !== undefined &&
    finalizationReserve !== undefined &&
    configuredBudget !== undefined &&
    configuredBudget !== planConfiguredTimeout + forceKillGrace + finalizationReserve
  ) {
    diagnostics.push(
      campaignTimeoutDiagnostic(
        "CAMPAIGN_TIMEOUT_PLAN_BUDGET_MISMATCH",
        "configured_budget_seconds must equal the full fuzzer timeout plus host shutdown grace and artifact reserve",
        `${planPath}#$.configured_budget_seconds`
      )
    );
  }
  if (
    requiredFinalizationReserve !== undefined &&
    finalizationReserve !== undefined &&
    requiredFinalizationReserve !== finalizationReserve
  ) {
    diagnostics.push(
      campaignTimeoutDiagnostic(
        "CAMPAIGN_TIMEOUT_FINALIZATION_RESERVE_MISMATCH",
        "finalization_reserve_seconds must equal artifact_finalization_reserve_seconds",
        `${planPath}#$.finalization_reserve_seconds`
      )
    );
  }
  if (
    requiredDeadline !== undefined &&
    finalArtifactDeadline !== undefined &&
    requiredDeadline.milliseconds !== finalArtifactDeadline.milliseconds
  ) {
    diagnostics.push(
      campaignTimeoutDiagnostic(
        "CAMPAIGN_TIMEOUT_DEADLINE_MISMATCH",
        "The campaign plan deadline must equal final_artifact_deadline_utc",
        `${planPath}#$.deadline`
      )
    );
  }

  if (
    configuredTimeoutSeconds !== undefined &&
    forceKillGrace !== undefined &&
    finalizationReserve !== undefined &&
    backendStartedAt !== undefined &&
    fuzzingDeadline !== undefined &&
    forceKillDeadline !== undefined &&
    finalArtifactDeadline !== undefined
  ) {
    const expectedFuzzingDeadline = backendStartedAt.milliseconds + configuredTimeoutSeconds * 1_000;
    const expectedForceKillDeadline = expectedFuzzingDeadline + forceKillGrace * 1_000;
    const expectedFinalArtifactDeadline = expectedForceKillDeadline + finalizationReserve * 1_000;
    for (const [field, actual, expected] of [
      ["fuzzing_deadline_utc", fuzzingDeadline.milliseconds, expectedFuzzingDeadline],
      ["force_kill_deadline_utc", forceKillDeadline.milliseconds, expectedForceKillDeadline],
      ["final_artifact_deadline_utc", finalArtifactDeadline.milliseconds, expectedFinalArtifactDeadline]
    ] as const) {
      if (actual !== expected) {
        diagnostics.push(
          campaignTimeoutDiagnostic(
            "CAMPAIGN_TIMEOUT_DEADLINE_MISMATCH",
            `${field} does not match the configured timeout and reserve arithmetic`,
            `${planPath}#$.${field}`
          )
        );
      }
    }
  }

  const resultConfiguredTimeout = positiveIntegerField(
    resultValue,
    "configured_timeout_seconds",
    resultPath,
    diagnostics
  );
  if (
    configuredTimeoutSeconds !== undefined &&
    resultConfiguredTimeout !== undefined &&
    resultConfiguredTimeout !== configuredTimeoutSeconds
  ) {
    diagnostics.push(
      campaignTimeoutDiagnostic(
        "CAMPAIGN_TIMEOUT_CONFIG_MISMATCH",
        `configured_timeout_seconds reports ${resultConfiguredTimeout}, but resolved configuration requires ${configuredTimeoutSeconds}`,
        `${resultPath}#$.configured_timeout_seconds`
      )
    );
  }
  const resultCommand = stringField(resultValue, "exact_command", resultPath, diagnostics);
  const resultSequenceLength = positiveIntegerField(resultValue, "sequence_length", resultPath, diagnostics);
  if (resultSequenceLength !== RECON_STATEFUL_SEQUENCE_LENGTH) {
    diagnostics.push(
      campaignTimeoutDiagnostic(
        "CAMPAIGN_SEQUENCE_LENGTH_MISMATCH",
        `sequence_length must be ${RECON_STATEFUL_SEQUENCE_LENGTH} for a stateful invariant campaign`,
        `${resultPath}#$.sequence_length`
      )
    );
  }
  if (planCommand !== undefined && resultCommand !== undefined && planCommand !== resultCommand) {
    diagnostics.push(
      campaignTimeoutDiagnostic(
        "CAMPAIGN_TIMEOUT_COMMAND_MISMATCH",
        "Backend result exact_command must equal the campaign plan command",
        `${resultPath}#$.exact_command`
      )
    );
  }
  if (resultCommand !== undefined && configuredTimeoutSeconds !== undefined) {
    const timeoutValues = exactReconCommandFlagValues(resultCommand, "--timeout");
    const testLimitValues = exactReconCommandFlagValues(resultCommand, "--test-limit");
    const sequenceLengthValues = exactReconCommandFlagValues(resultCommand, "--seq-len");
    if (timeoutValues.length !== 1 || timeoutValues[0] !== String(configuredTimeoutSeconds)) {
      diagnostics.push(
        campaignTimeoutDiagnostic(
          "CAMPAIGN_TIMEOUT_COMMAND_INVALID",
          `Recon command must contain exactly one --timeout ${configuredTimeoutSeconds} flag`,
          `${resultPath}#$.exact_command`
        )
      );
    }
    if (testLimitValues.length !== 1 || testLimitValues[0] !== RECON_MAX_TEST_LIMIT) {
      diagnostics.push(
        campaignTimeoutDiagnostic(
          "CAMPAIGN_TIMEOUT_COMMAND_INVALID",
          `Recon command must contain exactly one --test-limit ${RECON_MAX_TEST_LIMIT} flag`,
          `${resultPath}#$.exact_command`
        )
      );
    }
    if (sequenceLengthValues.length !== 1 || sequenceLengthValues[0] !== String(RECON_STATEFUL_SEQUENCE_LENGTH)) {
      diagnostics.push(
        campaignTimeoutDiagnostic(
          "CAMPAIGN_SEQUENCE_LENGTH_COMMAND_INVALID",
          `Recon command must contain exactly one --seq-len ${RECON_STATEFUL_SEQUENCE_LENGTH} flag`,
          `${resultPath}#$.exact_command`
        )
      );
    }
    if (!hasExactHostTimeoutWrapper(resultCommand, configuredTimeoutSeconds)) {
      diagnostics.push(
        campaignTimeoutDiagnostic(
          "CAMPAIGN_TIMEOUT_HOST_WRAPPER_INVALID",
          `Recon command must use exactly one timeout --preserve-status --signal=INT --kill-after=${CAMPAIGN_HOST_FORCE_KILL_GRACE_SECONDS}s ${configuredTimeoutSeconds}s wrapper and must not use --foreground`,
          `${resultPath}#$.exact_command`
        )
      );
    }
  }

  const startTimestamp = timestampField(resultValue, "start_timestamp", resultPath, diagnostics);
  const endTimestamp = timestampField(resultValue, "end_timestamp", resultPath, diagnostics);
  if (
    backendStartedAt !== undefined &&
    startTimestamp !== undefined &&
    backendStartedAt.milliseconds !== startTimestamp.milliseconds
  ) {
    diagnostics.push(
      campaignTimeoutDiagnostic(
        "CAMPAIGN_TIMEOUT_START_MISMATCH",
        "Backend result start_timestamp must equal campaign plan backend_started_at",
        `${resultPath}#$.start_timestamp`
      )
    );
  }
  const terminationReason = stringField(resultValue, "termination_reason", resultPath, diagnostics);
  if (terminationReason !== undefined && !campaignTerminationReasons.has(terminationReason)) {
    diagnostics.push(
      campaignTimeoutDiagnostic(
        "CAMPAIGN_TIMEOUT_EVIDENCE_INVALID",
        `termination_reason must be one of ${[...campaignTerminationReasons].join(", ")}`,
        `${resultPath}#$.termination_reason`
      )
    );
  }
  const campaignOutcome = stringField(resultValue, "campaign_outcome", resultPath, diagnostics);
  if (campaignOutcome !== undefined && !campaignOutcomes.has(campaignOutcome)) {
    diagnostics.push(
      campaignTimeoutDiagnostic(
        "CAMPAIGN_TIMEOUT_EVIDENCE_INVALID",
        "campaign_outcome must be complete, partial, or blocked",
        `${resultPath}#$.campaign_outcome`
      )
    );
  }
  const usableResults = resultValue.usable_results;
  if (typeof usableResults !== "boolean") {
    diagnostics.push(
      campaignTimeoutDiagnostic(
        "CAMPAIGN_TIMEOUT_EVIDENCE_INVALID",
        "usable_results must be a boolean",
        `${resultPath}#$.usable_results`
      )
    );
  }

  const executionValue = isRecord(resultValue.execution) ? resultValue.execution : undefined;
  if (executionValue === undefined) {
    diagnostics.push(
      campaignTimeoutDiagnostic(
        "CAMPAIGN_TIMEOUT_EVIDENCE_INVALID",
        "Backend result execution must be an object",
        `${resultPath}#$.execution`
      )
    );
  } else {
    const executionCommand = stringField(executionValue, "command", `${resultPath}#$.execution`, diagnostics);
    const executionStartedAt = timestampField(executionValue, "started_at", `${resultPath}#$.execution`, diagnostics);
    const executionFinishedAt = timestampField(executionValue, "finished_at", `${resultPath}#$.execution`, diagnostics);
    const executionDeadline = timestampField(executionValue, "deadline", `${resultPath}#$.execution`, diagnostics);
    if (resultCommand !== undefined && executionCommand !== undefined && resultCommand !== executionCommand) {
      diagnostics.push(
        campaignTimeoutDiagnostic(
          "CAMPAIGN_TIMEOUT_COMMAND_MISMATCH",
          "Backend result exact_command must equal execution.command",
          `${resultPath}#$.execution.command`
        )
      );
    }
    if (
      startTimestamp !== undefined &&
      executionStartedAt !== undefined &&
      startTimestamp.milliseconds !== executionStartedAt.milliseconds
    ) {
      diagnostics.push(
        campaignTimeoutDiagnostic(
          "CAMPAIGN_TIMEOUT_START_MISMATCH",
          "Backend result start_timestamp must equal execution.started_at",
          `${resultPath}#$.execution.started_at`
        )
      );
    }
    if (
      endTimestamp !== undefined &&
      executionFinishedAt !== undefined &&
      endTimestamp.milliseconds !== executionFinishedAt.milliseconds
    ) {
      diagnostics.push(
        campaignTimeoutDiagnostic(
          "CAMPAIGN_TIMEOUT_END_MISMATCH",
          "Backend result end_timestamp must equal execution.finished_at",
          `${resultPath}#$.execution.finished_at`
        )
      );
    }
    if (
      finalArtifactDeadline !== undefined &&
      executionDeadline !== undefined &&
      finalArtifactDeadline.milliseconds !== executionDeadline.milliseconds
    ) {
      diagnostics.push(
        campaignTimeoutDiagnostic(
          "CAMPAIGN_TIMEOUT_DEADLINE_MISMATCH",
          "Backend execution.deadline must equal the plan final_artifact_deadline_utc",
          `${resultPath}#$.execution.deadline`
        )
      );
    }
    if (typeof usableResults === "boolean" && executionValue.usable_results !== usableResults) {
      diagnostics.push(
        campaignTimeoutDiagnostic(
          "CAMPAIGN_TIMEOUT_OUTCOME_MISMATCH",
          "Backend usable_results must equal execution.usable_results",
          `${resultPath}#$.execution.usable_results`
        )
      );
    }
  }

  if (startTimestamp !== undefined && endTimestamp !== undefined) {
    const elapsedMs = endTimestamp.milliseconds - startTimestamp.milliseconds;
    if (elapsedMs < 0) {
      diagnostics.push(
        campaignTimeoutDiagnostic(
          "CAMPAIGN_TIMEOUT_DURATION_MISMATCH",
          "Backend end_timestamp cannot precede start_timestamp",
          `${resultPath}#$.end_timestamp`
        )
      );
    } else if (configuredTimeoutSeconds !== undefined) {
      const endedEarly = elapsedMs + CAMPAIGN_DURATION_TOLERANCE_MS < configuredTimeoutSeconds * 1_000;
      if (terminationReason === "configured-timeout" && endedEarly) {
        diagnostics.push(
          campaignTimeoutDiagnostic(
            "CAMPAIGN_TIMEOUT_DURATION_MISMATCH",
            "A configured-timeout campaign must run for the configured fuzzer timeout",
            `${resultPath}#$.end_timestamp`
          )
        );
      }
      if (endedEarly && usableResults === true && campaignOutcome !== "partial") {
        diagnostics.push(
          campaignTimeoutDiagnostic(
            "CAMPAIGN_TIMEOUT_OUTCOME_MISMATCH",
            "A campaign that ends before the configured timeout with usable results must be partial",
            `${resultPath}#$.campaign_outcome`
          )
        );
      }
      if (
        !endedEarly &&
        terminationReason === "configured-timeout" &&
        usableResults === true &&
        campaignOutcome !== "complete"
      ) {
        diagnostics.push(
          campaignTimeoutDiagnostic(
            "CAMPAIGN_TIMEOUT_OUTCOME_MISMATCH",
            "A configured-timeout campaign with usable results must be complete",
            `${resultPath}#$.campaign_outcome`
          )
        );
      }
    }
    if (
      forceKillDeadline !== undefined &&
      endTimestamp.milliseconds > forceKillDeadline.milliseconds + CAMPAIGN_DURATION_TOLERANCE_MS
    ) {
      if (terminationReason !== "host-force-kill") {
        diagnostics.push(
          campaignTimeoutDiagnostic(
            "CAMPAIGN_TIMEOUT_FORCE_KILL_MISMATCH",
            "A backend ending after the host force-kill deadline must report termination_reason host-force-kill",
            `${resultPath}#$.termination_reason`
          )
        );
      }
      if (usableResults === true && campaignOutcome !== "partial") {
        diagnostics.push(
          campaignTimeoutDiagnostic(
            "CAMPAIGN_TIMEOUT_OUTCOME_MISMATCH",
            "A host-force-killed campaign with usable results must be partial",
            `${resultPath}#$.campaign_outcome`
          )
        );
      }
    }
    if (
      forceKillDeadline !== undefined &&
      terminationReason === "host-force-kill" &&
      endTimestamp.milliseconds + CAMPAIGN_DURATION_TOLERANCE_MS < forceKillDeadline.milliseconds
    ) {
      diagnostics.push(
        campaignTimeoutDiagnostic(
          "CAMPAIGN_TIMEOUT_FORCE_KILL_MISMATCH",
          "A host-force-kill termination cannot precede the host force-kill deadline",
          `${resultPath}#$.termination_reason`
        )
      );
    }
  }
  if (usableResults === false && campaignOutcome !== "blocked") {
    diagnostics.push(
      campaignTimeoutDiagnostic(
        "CAMPAIGN_TIMEOUT_OUTCOME_MISMATCH",
        "A campaign without usable results must be blocked",
        `${resultPath}#$.campaign_outcome`
      )
    );
  }
  if (campaignOutcome === "complete" && (terminationReason !== "configured-timeout" || usableResults !== true)) {
    diagnostics.push(
      campaignTimeoutDiagnostic(
        "CAMPAIGN_TIMEOUT_OUTCOME_MISMATCH",
        "A complete campaign must have usable results and termination_reason configured-timeout",
        `${resultPath}#$.campaign_outcome`
      )
    );
  }
  if (usableResults === true && terminationReason !== "configured-timeout" && campaignOutcome !== "partial") {
    diagnostics.push(
      campaignTimeoutDiagnostic(
        "CAMPAIGN_TIMEOUT_OUTCOME_MISMATCH",
        "A campaign with usable results and a non-configured terminal reason must be partial",
        `${resultPath}#$.campaign_outcome`
      )
    );
  }
  if (usableResults === true && campaignOutcome === "blocked") {
    diagnostics.push(
      campaignTimeoutDiagnostic(
        "CAMPAIGN_TIMEOUT_OUTCOME_MISMATCH",
        "A blocked campaign cannot report usable results",
        `${resultPath}#$.campaign_outcome`
      )
    );
  }

  const summaryOutcome = stringField(summaryValue, "outcome", summaryPath, diagnostics);
  if (summaryOutcome !== undefined && campaignOutcome !== undefined && summaryOutcome !== campaignOutcome) {
    diagnostics.push(
      campaignTimeoutDiagnostic(
        "CAMPAIGN_TIMEOUT_SUMMARY_MISMATCH",
        "Campaign summary outcome must equal the backend result campaign_outcome",
        `${summaryPath}#$.outcome`
      )
    );
  }
  return diagnostics;
}

function verifyPropertyProvenanceArtifacts(
  layout: RunLayout,
  artifactDir: string,
  node: PlannedGraphNode,
  attemptId: string,
  attemptAuthority?: ArtifactGateAttemptAuthority,
  authenticated?: AuthenticatedArtifactGateSnapshots
): RuntimeDiagnostic[] {
  const isPropertyLens = node.outputs.some((output) => output.contract === "ultrafuzz/property-lens@2");
  const isFinalReport = node.outputs.some((output) => output.contract === "ultrafuzz/report@2");
  const isCoverageEvidence = node.outputs.some((output) => output.contract === "ultrafuzz/coverage-evidence@1");
  const isImplementation = node.outputs.some((output) => output.contract === "ultrafuzz/implemented-properties@3");
  const isCampaign = node.outputs.some((output) => output.contract === "ultrafuzz/property-campaign@3");
  const diagnostics: RuntimeDiagnostic[] = [];
  if (hasCurrentCampaignOutputRole(node)) {
    diagnostics.push(...verifyCurrentCampaignTimeoutEvidence(layout, artifactDir, node, attemptId, authenticated));
  }
  if (isPropertyLens) {
    diagnostics.push(
      ...verifyLensReferenceExpectationAuthority(layout, artifactDir, node, attemptId, attemptAuthority, authenticated)
    );
  }
  if (isFinalReport) {
    diagnostics.push(
      ...verifyFinalReportPropertyReferences(layout, artifactDir, node, attemptAuthority, authenticated)
    );
  }
  if (isCoverageEvidence) {
    diagnostics.push(...verifyCoverageProductionInventory(layout, artifactDir, node, attemptId, authenticated));
    diagnostics.push(...verifyCoverageGoalEvidenceParity(artifactDir, node, authenticated));
  }
  if (!isImplementation && !isCampaign) return diagnostics;

  const catalog = readCanonicalPropertyCatalog(layout, node, attemptAuthority);
  if (catalog.diagnostics.length > 0 || catalog.value === undefined) {
    return [...diagnostics, ...catalog.diagnostics];
  }

  const siblingImplementation = isImplementation
    ? readDeclaredSiblingImplementedProperties(artifactDir, node, layout, authenticated)
    : undefined;
  if (isImplementation) {
    diagnostics.push(...(siblingImplementation?.diagnostics ?? []));
    if (siblingImplementation?.value !== undefined && siblingImplementation.path !== undefined) {
      diagnostics.push(
        ...verifyImplementationPropertyReferences(
          layout,
          artifactDir,
          catalog.value,
          node,
          siblingImplementation.value,
          siblingImplementation.path,
          authenticated
        )
      );
    }
  }
  if (isCampaign) {
    diagnostics.push(
      ...verifyCampaignPropertyReferences(layout, artifactDir, catalog.value, node, attemptAuthority, authenticated)
    );
  }
  return diagnostics;
}

function verifyCoverageGoalEvidenceParity(
  artifactDir: string,
  node: PlannedGraphNode,
  authenticated?: AuthenticatedArtifactGateSnapshots
): RuntimeDiagnostic[] {
  const goalOutputs = node.outputs.filter((output) => output.contract === "ultrafuzz/coverage-goal@1");
  const evidenceOutputs = node.outputs.filter((output) => output.contract === "ultrafuzz/coverage-evidence@1");
  if (goalOutputs.length !== 1 || evidenceOutputs.length !== 1) {
    return [
      {
        code: "COVERAGE_GOAL_EVIDENCE_DECLARATION_AMBIGUOUS",
        message: `Coverage producer must declare exactly one coverage goal and one coverage evidence output; found ${goalOutputs.length} goal and ${evidenceOutputs.length} evidence outputs`,
        severity: "error",
        source: "coverage-evidence",
        path: node.id
      }
    ];
  }
  const goalPath = safeResolveInside(artifactDir, goalOutputs[0]!.path, "coverage goal output");
  const evidencePath = safeResolveInside(artifactDir, evidenceOutputs[0]!.path, "coverage evidence output");
  const goal = parseCurrentArtifactJson(artifactDir, goalPath, authenticated);
  const evidence = parseCurrentArtifactJson(artifactDir, evidencePath, authenticated);
  if (!isRecord(goal) || !isRecord(evidence) || !Array.isArray(evidence.views)) return [];
  const selected = evidence.views.find(
    (view): view is Record<string, unknown> => isRecord(view) && view.scope === "selected-range"
  );
  if (selected === undefined) return [];
  const measurement = goal.current_measurement;
  if (measurement !== null && !isDeepStrictEqual(measurement, selected)) {
    return [
      {
        code: "COVERAGE_GOAL_MEASUREMENT_MISMATCH",
        message: "Terminal coverage goal measurement must exactly equal the selected-range coverage evidence view",
        severity: "error",
        source: "coverage-evidence",
        path: `${goalPath}#$.current_measurement`
      }
    ];
  }
  return [];
}

function verifyCoverageProductionInventory(
  layout: RunLayout,
  artifactDir: string,
  node: PlannedGraphNode,
  attemptId: string,
  authenticated?: AuthenticatedArtifactGateSnapshots
): RuntimeDiagnostic[] {
  const coverageOutputs = node.outputs.filter((output) => output.contract === "ultrafuzz/coverage-evidence@1");
  if (coverageOutputs.length !== 1) {
    return [
      {
        code: "COVERAGE_EVIDENCE_DECLARATION_AMBIGUOUS",
        message: `Coverage producer must declare exactly one ultrafuzz/coverage-evidence@1 output; found ${coverageOutputs.length}`,
        severity: "error",
        source: "coverage-evidence",
        path: layout.graphPath
      }
    ];
  }
  const markdownOutputs = node.outputs.filter((output) => output.contract === "ultrafuzz/nonempty-markdown@1");
  if (markdownOutputs.length !== 1) {
    return [
      {
        code: "COVERAGE_MARKDOWN_DECLARATION_AMBIGUOUS",
        message: `Coverage producer must declare exactly one scoped Markdown output; found ${markdownOutputs.length}`,
        severity: "error",
        source: "coverage-evidence",
        path: layout.graphPath
      }
    ];
  }

  const evidencePath = safeResolveInside(artifactDir, coverageOutputs[0]!.path, "coverage evidence output");
  const markdownPath = safeResolveInside(artifactDir, markdownOutputs[0]!.path, "coverage Markdown output");
  const evidence = parseCurrentArtifactJson(artifactDir, evidencePath, authenticated);
  const markdownBytes = readCurrentArtifactSnapshot(artifactDir, markdownPath, authenticated);
  if (!isRecord(evidence) || !Array.isArray(evidence.files) || !Array.isArray(evidence.counted_ranges)) return [];

  const diagnostics =
    markdownBytes === undefined ? [] : unscopedCoverageScoreDiagnostics(markdownBytes.toString("utf8"), markdownPath);
  if (markdownBytes !== undefined) {
    diagnostics.push(
      ...coverageEvidenceMarkdownProjectionDiagnostics(
        evidence,
        markdownBytes.toString("utf8"),
        markdownPath,
        "COVERAGE_EVIDENCE_MARKDOWN_MISMATCH"
      )
    );
  }
  const workspacePath = getNodeWorkspaceDir(layout, attemptId);
  const productionRoots = configuredProductionSourceRoots(layout);
  if (!fs.existsSync(workspacePath) || productionRoots === undefined) {
    diagnostics.push({
      code: "COVERAGE_SOURCE_INVENTORY_UNAVAILABLE",
      message: "Coverage evidence requires the trusted node workspace and configured production source roots",
      severity: "error",
      source: "coverage-evidence",
      path: evidencePath
    });
    return diagnostics;
  }

  const declaredProductionFiles = new Map<string, Record<string, unknown>>();
  const declaredNonProductionFiles = new Map<string, Record<string, unknown>>();
  for (const entry of evidence.files.filter(isRecord)) {
    if (typeof entry.path !== "string") continue;
    if (entry.kind === "production") declaredProductionFiles.set(entry.path, entry);
    else declaredNonProductionFiles.set(entry.path, entry);
  }
  const declaredFiles = new Map([...declaredProductionFiles, ...declaredNonProductionFiles]);
  const sourceSnapshots = new Map<string, { text: string; lineCount: number }>();
  const sourceSnapshot = (relativePath: string, label: string): { text: string; lineCount: number } => {
    const cached = sourceSnapshots.get(relativePath);
    if (cached !== undefined) return cached;
    const sourcePath = safeResolveInside(workspacePath, relativePath, label);
    assertRegularFileInside(workspacePath, sourcePath, label);
    const text = readRegularFileSnapshot(sourcePath, MAX_ARTIFACT_SNAPSHOT_BYTES).toString("utf8");
    const normalized = text.replace(/\r?\n$/u, "");
    const snapshot = { text, lineCount: normalized === "" ? 0 : normalized.split(/\r?\n/u).length };
    sourceSnapshots.set(relativePath, snapshot);
    return snapshot;
  };
  let inventory: Set<string>;
  try {
    inventory = new Set(productionContractSourceFiles(workspacePath, productionRoots));
  } catch (error) {
    diagnostics.push({
      code: "COVERAGE_SOURCE_INVENTORY_UNSAFE",
      message: error instanceof Error ? error.message : "Coverage production source inventory is unsafe",
      severity: "error",
      source: "coverage-evidence",
      path: evidencePath
    });
    return diagnostics;
  }
  const reconSelection = readReconCoverageSelection(workspacePath, inventory);
  diagnostics.push(...reconSelection.diagnostics);

  let lcovCoverage: TrustedLcovCoverage | undefined;
  try {
    lcovCoverage = readTrustedLcovCoverage(workspacePath, evidence.lcov);
  } catch (error) {
    diagnostics.push({
      code: "COVERAGE_LCOV_INVALID",
      message: `Coverage evidence LCOV source is unsafe, stale, or invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
      severity: "error",
      source: "coverage-evidence",
      path: `${evidencePath}#$.lcov`
    });
  }

  const expectedSourceKinds = new Map<string, CoverageSourceKind>();
  for (const relativePath of inventory) expectedSourceKinds.set(relativePath, "production");
  if (lcovCoverage !== undefined) {
    for (const [relativePath, hitLines] of lcovCoverage.hitsBySource) {
      const kind = trustedCoverageSourceKind(relativePath, inventory);
      if (kind === undefined) {
        diagnostics.push({
          code: "COVERAGE_LCOV_SOURCE_KIND_UNKNOWN",
          message: `LCOV source ${relativePath} is outside every trusted production, dependency, test, or harness root`,
          severity: "error",
          source: "coverage-evidence",
          path: `${evidencePath}#$.lcov`
        });
        continue;
      }
      expectedSourceKinds.set(relativePath, kind);
      let lineCount: number;
      try {
        lineCount = sourceSnapshot(relativePath, "LCOV source").lineCount;
      } catch (error) {
        diagnostics.push({
          code: "COVERAGE_LCOV_SOURCE_UNKNOWN",
          message: `LCOV source ${relativePath} is nonexistent or unsafe: ${
            error instanceof Error ? error.message : String(error)
          }`,
          severity: "error",
          source: "coverage-evidence",
          path: `${evidencePath}#$.lcov`
        });
        continue;
      }
      if ([...hitLines.keys()].some((line) => line > lineCount)) {
        diagnostics.push({
          code: "COVERAGE_LCOV_LINE_OUT_OF_BOUNDS",
          message: `LCOV source ${relativePath} contains a DA line beyond its ${lineCount}-line trusted source`,
          severity: "error",
          source: "coverage-evidence",
          path: `${evidencePath}#$.lcov`
        });
      }
    }
  }

  for (const [relativePath, expectedKind] of expectedSourceKinds) {
    const declared = declaredFiles.get(relativePath);
    if (declared === undefined) {
      diagnostics.push({
        code: expectedKind === "production" ? "COVERAGE_PRODUCTION_FILE_OMITTED" : "COVERAGE_LCOV_SOURCE_OMITTED",
        message: `Coverage denominator omits trusted ${expectedKind} source ${relativePath}`,
        severity: "error",
        source: "coverage-evidence",
        path: `${evidencePath}#$.files`
      });
    } else if (declared.kind !== expectedKind) {
      diagnostics.push({
        code: "COVERAGE_SOURCE_ATTRIBUTION_MISMATCH",
        message: `Coverage source ${relativePath} must be attributed as ${expectedKind}, not ${String(declared.kind)}`,
        severity: "error",
        source: "coverage-evidence",
        path: `${evidencePath}#$.files`
      });
    }
  }
  for (const [relativePath, declared] of declaredFiles) {
    if (expectedSourceKinds.has(relativePath)) continue;
    diagnostics.push({
      code:
        declared.kind === "production" ? "COVERAGE_PRODUCTION_FILE_UNKNOWN" : "COVERAGE_NON_PRODUCTION_FILE_UNKNOWN",
      message: `Coverage denominator includes ${String(declared.kind)} source ${relativePath} that is absent from the trusted production inventory and LCOV source set`,
      severity: "error",
      source: "coverage-evidence",
      path: `${evidencePath}#$.files`
    });
  }

  const productionRangesByFile = new Map<
    string,
    { all: Record<string, unknown>[]; byStartLine: Map<number, Record<string, unknown>[]> }
  >();
  for (const [index, candidate] of evidence.counted_ranges.entries()) {
    if (!isRecord(candidate) || typeof candidate.file !== "string") continue;
    if (candidate.kind === "production") {
      const ranges = productionRangesByFile.get(candidate.file) ?? {
        all: [] as Record<string, unknown>[],
        byStartLine: new Map<number, Record<string, unknown>[]>()
      };
      ranges.all.push(candidate);
      if (typeof candidate.start_line === "number") {
        const sameLine = ranges.byStartLine.get(candidate.start_line) ?? [];
        sameLine.push(candidate);
        ranges.byStartLine.set(candidate.start_line, sameLine);
      }
      productionRangesByFile.set(candidate.file, ranges);
    }
    if (!declaredFiles.has(candidate.file)) continue;
    let lineCount: number;
    try {
      lineCount = sourceSnapshot(candidate.file, "coverage range").lineCount;
    } catch {
      continue;
    }
    const candidateEndLine =
      typeof candidate.start_line === "number" && typeof candidate.line_count === "number"
        ? candidate.start_line + candidate.line_count - 1
        : undefined;
    if (candidateEndLine !== undefined && candidateEndLine > lineCount) {
      diagnostics.push({
        code: "COVERAGE_PRODUCTION_RANGE_OUT_OF_BOUNDS",
        message: `Coverage range for ${candidate.file} ends past its ${lineCount}-line source file`,
        severity: "error",
        source: "coverage-evidence",
        path: `${evidencePath}#$.counted_ranges[${index}].line_count`
      });
    }
    if (
      lcovCoverage !== undefined &&
      typeof candidate.start_line === "number" &&
      candidateEndLine !== undefined &&
      typeof candidate.covered === "boolean"
    ) {
      const coveredByLcov = lcovRangeCovered(
        lcovCoverage.coveredLinesBySource.get(candidate.file),
        candidate.start_line,
        candidateEndLine
      );
      if (candidate.covered !== coveredByLcov) {
        diagnostics.push({
          code: "COVERAGE_RANGE_RESULT_MISMATCH",
          message: `Coverage result for ${candidate.file}:${candidate.start_line}-${candidateEndLine} must be ${String(
            coveredByLcov
          )} according to the authenticated LCOV DA hits`,
          severity: "error",
          source: "coverage-evidence",
          path: `${evidencePath}#$.counted_ranges[${index}].covered`
        });
      }
    }
  }

  let materialRangeCount = 0;
  for (const relativePath of inventory) {
    const sourceText = sourceSnapshot(relativePath, "production coverage source").text;
    let declarations: MaterialCoverageDeclaration[];
    try {
      declarations = materialCoverageDeclarations(
        relativePath,
        sourceText,
        MAX_COVERAGE_EVIDENCE_RANGES - materialRangeCount
      );
    } catch (error) {
      diagnostics.push({
        code: "COVERAGE_SOURCE_INVENTORY_UNSAFE",
        message: error instanceof Error ? error.message : "Coverage production range inventory is unsafe",
        severity: "error",
        source: "coverage-evidence",
        path: evidencePath
      });
      return diagnostics;
    }
    materialRangeCount += declarations.length;
    const declarationLines = declarations.map((declaration) => declaration.line);
    const declarationLineSet = new Set(declarationLines);
    const declaredFile = declaredProductionFiles.get(relativePath);
    if (declaredFile === undefined) continue;
    const declaredRangeIndex = productionRangesByFile.get(relativePath);
    const declaredRanges = declaredRangeIndex?.all ?? [];

    if (declaredFile.total_ranges !== declarationLines.length) {
      diagnostics.push({
        code: "COVERAGE_PRODUCTION_FILE_DENOMINATOR_MISMATCH",
        message: `Production source ${relativePath} declares ${String(declaredFile.total_ranges)} material ranges but the trusted source contains ${declarationLines.length}`,
        severity: "error",
        source: "coverage-evidence",
        path: `${evidencePath}#$.files`
      });
    }

    if (declaredFile.included === false && declaredRanges.some((candidate) => candidate.selected === true)) {
      diagnostics.push({
        code: "COVERAGE_EXCLUDED_FILE_HAS_SELECTED_RANGES",
        message: `Excluded production source ${relativePath} cannot contribute counted selected-range entries`,
        severity: "error",
        source: "coverage-evidence",
        path: `${evidencePath}#$.counted_ranges`
      });
    }
    for (const declaration of declarations) {
      const matching = declaredRangeIndex?.byStartLine.get(declaration.line) ?? [];
      if (matching.length !== 1) {
        diagnostics.push({
          code: "COVERAGE_PRODUCTION_RANGE_OMITTED",
          message: `Coverage denominator must contain exactly one range starting at material declaration ${relativePath}:${declaration.line}`,
          severity: "error",
          source: "coverage-evidence",
          path: `${evidencePath}#$.counted_ranges`
        });
        continue;
      }
      const selectedByRecon = reconCoverageRangesOverlap(
        reconSelection.ranges?.get(relativePath),
        declaration.line,
        declaration.endLine
      );
      if (reconSelection.ranges !== undefined && matching[0]!.selected !== selectedByRecon) {
        diagnostics.push({
          code: "COVERAGE_PRODUCTION_RANGE_SELECTION_MISMATCH",
          message: `Coverage selection for ${relativePath}:${declaration.line} does not match trusted Recon selection semantics`,
          severity: "error",
          source: "coverage-evidence",
          path: `${evidencePath}#$.counted_ranges`
        });
      }
      if (matching[0]!.line_count !== declaration.endLine - declaration.line + 1) {
        diagnostics.push({
          code: "COVERAGE_PRODUCTION_RANGE_BOUNDARY_MISMATCH",
          message: `Coverage range for ${relativePath}:${declaration.line} must end at trusted declaration boundary ${declaration.endLine}`,
          severity: "error",
          source: "coverage-evidence",
          path: `${evidencePath}#$.counted_ranges`
        });
      }
    }
    for (const candidate of declaredRanges) {
      if (typeof candidate.start_line !== "number" || declarationLineSet.has(candidate.start_line)) continue;
      diagnostics.push({
        code: "COVERAGE_PRODUCTION_RANGE_NOT_DECLARATION",
        message: `Coverage range for ${relativePath}:${candidate.start_line} does not start at a material declaration`,
        severity: "error",
        source: "coverage-evidence",
        path: `${evidencePath}#$.counted_ranges`
      });
    }
  }
  return diagnostics;
}

type CoverageSourceKind = "production" | "test" | "harness" | "dependency";
type TrustedLcovCoverage = {
  hitsBySource: ReadonlyMap<string, ReadonlyMap<number, bigint>>;
  coveredLinesBySource: ReadonlyMap<string, readonly number[]>;
};

function readTrustedLcovCoverage(workspacePath: string, descriptor: unknown): TrustedLcovCoverage {
  if (
    !isRecord(descriptor) ||
    typeof descriptor.path !== "string" ||
    typeof descriptor.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(descriptor.sha256)
  ) {
    throw new Error("LCOV descriptor must contain an exact safe path and lowercase SHA-256");
  }
  const lcovPath = safeResolveInside(workspacePath, descriptor.path, "coverage LCOV source");
  const bytes = readSinglyLinkedRegularFileSnapshotInside(
    workspacePath,
    lcovPath,
    MAX_ARTIFACT_SNAPSHOT_BYTES,
    "coverage LCOV source"
  );
  const digest = sha256Bytes(bytes);
  if (digest !== descriptor.sha256) {
    throw new Error(`LCOV SHA-256 mismatch: expected ${descriptor.sha256}, observed ${digest}`);
  }

  const hitsBySource = new Map<string, Map<number, bigint>>();
  let distinctDaLineCount = 0;
  let currentSource: string | undefined;
  for (const [index, line] of bytes.toString("utf8").split(/\r?\n/u).entries()) {
    if (line.startsWith("SF:")) {
      if (currentSource !== undefined) throw new Error(`LCOV line ${index + 1} starts a nested SF record`);
      currentSource = trustedLcovRelativeSourcePath(workspacePath, line.slice(3));
      if (!hitsBySource.has(currentSource)) {
        if (hitsBySource.size >= MAX_COVERAGE_EVIDENCE_FILES) {
          throw new Error(`LCOV exceeds ${MAX_COVERAGE_EVIDENCE_FILES} distinct source files`);
        }
        hitsBySource.set(currentSource, new Map());
      }
      continue;
    }
    if (line === "end_of_record") {
      if (currentSource === undefined) throw new Error(`LCOV line ${index + 1} ends no active SF record`);
      currentSource = undefined;
      continue;
    }
    if (!line.startsWith("DA:")) continue;
    if (currentSource === undefined) throw new Error(`LCOV line ${index + 1} contains DA outside an SF record`);
    const match = /^DA:([1-9][0-9]*),([0-9]+)(?:,[^,\r\n]+)?$/u.exec(line);
    if (match === null) throw new Error(`LCOV line ${index + 1} contains an invalid DA record`);
    const sourceLine = Number(match[1]);
    if (!Number.isSafeInteger(sourceLine)) throw new Error(`LCOV line ${index + 1} has an unsafe DA line number`);
    const count = BigInt(match[2]!);
    const sourceHits = hitsBySource.get(currentSource)!;
    if (!sourceHits.has(sourceLine)) {
      distinctDaLineCount += 1;
      if (distinctDaLineCount > MAX_COVERAGE_EVIDENCE_RANGES) {
        throw new Error(`LCOV exceeds ${MAX_COVERAGE_EVIDENCE_RANGES} distinct DA line records`);
      }
    }
    sourceHits.set(sourceLine, (sourceHits.get(sourceLine) ?? 0n) + count);
  }
  if (currentSource !== undefined) throw new Error(`LCOV SF record for ${currentSource} lacks end_of_record`);

  return {
    hitsBySource,
    coveredLinesBySource: new Map(
      [...hitsBySource].map(([source, hits]) => [
        source,
        [...hits]
          .filter(([, count]) => count > 0n)
          .map(([line]) => line)
          .sort((left, right) => left - right)
      ])
    )
  };
}

function trustedLcovRelativeSourcePath(workspacePath: string, sourcePath: string): string {
  if (sourcePath.length === 0 || sourcePath.includes("\0") || sourcePath.includes("\\")) {
    throw new Error("LCOV SF paths must be nonempty forward-slash paths without NUL bytes");
  }
  const workspaceAbsolute = path.resolve(workspacePath);
  const absoluteSource = path.isAbsolute(sourcePath)
    ? path.resolve(sourcePath)
    : safeResolveInside(workspaceAbsolute, sourcePath, "LCOV SF source");
  const relativeSource = path.relative(workspaceAbsolute, absoluteSource).split(path.sep).join("/");
  const canonicalSource = safeResolveInside(workspaceAbsolute, relativeSource, "LCOV SF source");
  if (canonicalSource !== absoluteSource) throw new Error(`LCOV SF source is not canonical: ${sourcePath}`);
  assertRegularFileInside(workspaceAbsolute, canonicalSource, "LCOV SF source");
  return relativeSource;
}

function trustedCoverageSourceKind(
  relativePath: string,
  productionInventory: ReadonlySet<string>
): CoverageSourceKind | undefined {
  if (productionInventory.has(relativePath)) return "production";
  const segments = relativePath.split("/").map((segment) => segment.toLowerCase());
  const dependencyRoots = new Set(["lib", "libs", "vendor", "vendors", "dependency", "dependencies"]);
  const testRoots = new Set(["test", "tests"]);
  const harnessRoots = new Set([
    "recon",
    "echidna",
    "fuzz",
    "fuzzing",
    "invariant",
    "invariants",
    "harness",
    "harnesses",
    "script",
    "scripts"
  ]);
  const rootedKinds = segments
    .map((segment, index): { index: number; kind: CoverageSourceKind } | undefined => {
      if (dependencyRoots.has(segment) || segment === "node_modules") return { index, kind: "dependency" };
      if (testRoots.has(segment)) return { index, kind: "test" };
      if (harnessRoots.has(segment)) return { index, kind: "harness" };
      return undefined;
    })
    .filter((entry): entry is { index: number; kind: CoverageSourceKind } => entry !== undefined);
  const root = rootedKinds[0];
  if (root?.kind !== "test") return root?.kind;
  return rootedKinds.some((entry) => entry.index > root.index && entry.kind === "harness") ? "harness" : "test";
}

function lcovRangeCovered(coveredLines: readonly number[] | undefined, startLine: number, endLine: number): boolean {
  if (coveredLines === undefined) return false;
  let low = 0;
  let high = coveredLines.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (coveredLines[middle]! < startLine) low = middle + 1;
    else high = middle;
  }
  return low < coveredLines.length && coveredLines[low]! <= endLine;
}

type MaterialCoverageDeclaration = { line: number; endLine: number };
type ReconCoverageRange = { startLine: number; endLine: number };
type ReconCoverageSelection = {
  ranges?: ReadonlyMap<string, readonly ReconCoverageRange[]>;
  diagnostics: RuntimeDiagnostic[];
};

function materialCoverageDeclarations(
  relativePath: string,
  source: string,
  maximumRanges: number
): MaterialCoverageDeclaration[] {
  const declarationsByLine = new Map<number, number>();
  const recordDeclaration = (declaration: MaterialCoverageDeclaration): void => {
    const previousEndLine = declarationsByLine.get(declaration.line);
    if (previousEndLine === undefined && declarationsByLine.size >= maximumRanges) {
      throw new Error(`Coverage production source inventory exceeds ${MAX_COVERAGE_EVIDENCE_RANGES} material ranges`);
    }
    declarationsByLine.set(declaration.line, Math.max(previousEndLine ?? declaration.endLine, declaration.endLine));
  };
  if (path.extname(relativePath) === ".sol") {
    const lexicalSource = stripCoverageSourceCommentsAndStrings(source);
    let parenthesisDepth = 0;
    let braceDepth = 0;
    let scannedThrough = 0;
    let currentLine = 1;
    for (const match of lexicalSource.matchAll(
      /\b(?:function(?:\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\(|\s*\([^;{}]*\)[^;{}]*\{)|constructor\s*\(|fallback\s*\(|receive\s*\(|modifier\s+[A-Za-z_$][A-Za-z0-9_$]*)/gu
    )) {
      for (const character of lexicalSource.slice(scannedThrough, match.index)) {
        if (character === "(") parenthesisDepth += 1;
        if (character === ")") parenthesisDepth = Math.max(0, parenthesisDepth - 1);
        if (character === "{") braceDepth += 1;
        if (character === "}") braceDepth = Math.max(0, braceDepth - 1);
        if (character === "\n") currentLine += 1;
      }
      scannedThrough = match.index ?? scannedThrough;
      if (parenthesisDepth > 0 || braceDepth > 1) continue;
      const signatureEnd = solidityDeclarationSignatureEnd(lexicalSource, match.index ?? 0, currentLine);
      // Interface and abstract signatures end in `;` and have no executable
      // range that LCOV can cover. Only declarations with an implementation
      // body belong in the production-source denominator.
      if (lexicalSource[signatureEnd.index - 1] !== "{") continue;
      recordDeclaration({
        line: currentLine,
        endLine: solidityDeclarationEndLine(lexicalSource, signatureEnd.index, signatureEnd.line)
      });
    }
    for (const getter of solidityPublicGetterDeclarations(lexicalSource)) {
      recordDeclaration(getter);
    }
  }
  if (path.extname(relativePath) === ".vy") {
    const vyperLines = stripVyperCoverageSourceCommentsAndStrings(source)
      .replace(/\r?\n$/u, "")
      .split(/\r?\n/u);
    for (const declaration of vyperMaterialCoverageDeclarations(vyperLines)) {
      recordDeclaration(declaration);
    }
  }

  // The portable evidence contract addresses ranges by line, not column. Treat
  // every material declaration that begins on one physical line as one trusted
  // range whose boundary covers the furthest declaration on that line. This
  // keeps minified/generated sources representable without weakening the
  // complete production-source denominator.
  return [...declarationsByLine.entries()]
    .sort(([left], [right]) => left - right)
    .map(([line, endLine]) => ({ line, endLine }));
}

function solidityDeclarationSignatureEnd(
  source: string,
  start: number,
  startLine: number
): { index: number; line: number } {
  let parenthesisDepth = 0;
  let line = startLine;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "(") parenthesisDepth += 1;
    else if (character === ")") parenthesisDepth = Math.max(0, parenthesisDepth - 1);
    else if (parenthesisDepth === 0 && (character === "{" || character === ";")) return { index: index + 1, line };
    if (character === "\n") line += 1;
  }
  return { index: source.length, line };
}

function solidityDeclarationEndLine(source: string, signatureEnd: number, signatureEndLine: number): number {
  if (source[signatureEnd - 1] !== "{") return signatureEndLine;
  let depth = 1;
  let line = signatureEndLine;
  for (let index = signatureEnd; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\n") line += 1;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return line;
    }
  }
  return signatureEndLine;
}

function solidityPublicGetterDeclarations(source: string): MaterialCoverageDeclaration[] {
  const declarations: MaterialCoverageDeclaration[] = [];
  let structuralBraceDepth = 0;
  let initializerBraceDepth = 0;
  let line = 1;
  let statementStart = 0;
  let statementLine = 1;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\n") line += 1;
    if (character === "{") {
      if (initializerBraceDepth > 0) {
        initializerBraceDepth += 1;
        continue;
      }
      if (structuralBraceDepth === 0) {
        statementStart = index + 1;
        statementLine = line;
      } else if (structuralBraceDepth === 1) {
        const prefix = source.slice(statementStart, index);
        if (solidityStatementHasTopLevelInitializer(prefix)) {
          initializerBraceDepth = 1;
          continue;
        }
        statementStart = index + 1;
        statementLine = line;
      }
      structuralBraceDepth += 1;
      continue;
    }
    if (character === "}") {
      if (initializerBraceDepth > 0) {
        initializerBraceDepth -= 1;
        continue;
      }
      structuralBraceDepth = Math.max(0, structuralBraceDepth - 1);
      if (structuralBraceDepth === 1) {
        statementStart = index + 1;
        statementLine = line;
      }
      continue;
    }
    if (character !== ";" || structuralBraceDepth !== 1 || initializerBraceDepth !== 0) continue;

    const statement = source.slice(statementStart, index + 1);
    const leadingWhitespace = statement.match(/^\s*/u)?.[0] ?? "";
    const declarationLine = statementLine + (leadingWhitespace.match(/\n/gu)?.length ?? 0);
    if (
      /\bpublic\b/u.test(statement) &&
      !/\b(?:function\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\(|constructor\s*\(|fallback\s*\(|receive\s*\(|modifier\s+)/u.test(
        statement
      )
    ) {
      declarations.push({ line: declarationLine, endLine: line });
    }
    statementStart = index + 1;
    statementLine = line;
  }
  return declarations;
}

function solidityStatementHasTopLevelInitializer(statementPrefix: string): boolean {
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  for (let index = 0; index < statementPrefix.length; index += 1) {
    const character = statementPrefix[index]!;
    if (character === "(") parenthesisDepth += 1;
    else if (character === ")") parenthesisDepth = Math.max(0, parenthesisDepth - 1);
    else if (character === "[") bracketDepth += 1;
    else if (character === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (character === "=" && parenthesisDepth === 0 && bracketDepth === 0) {
      const previous = statementPrefix[index - 1];
      const next = statementPrefix[index + 1];
      if (previous !== "=" && previous !== "!" && previous !== "<" && previous !== ">" && next !== "=") {
        return true;
      }
    }
  }
  return false;
}

function vyperMaterialCoverageDeclarations(sourceLines: readonly string[]): MaterialCoverageDeclaration[] {
  const declarations: MaterialCoverageDeclaration[] = [];
  for (const [lineIndex, sourceLine] of sourceLines.entries()) {
    const definition = /^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/u.exec(sourceLine);
    if (definition !== null) {
      const indentation = definition[1]!.length;
      // Executable Vyper functions are module-level. Indented `def` rows are
      // interface signatures and cannot receive runtime coverage.
      if (indentation !== 0) continue;
      const signatureEndIndex = vyperSignatureEndLineIndex(sourceLines, lineIndex, definition.index);
      let endIndex = signatureEndIndex;
      for (let candidateIndex = signatureEndIndex + 1; candidateIndex < sourceLines.length; candidateIndex += 1) {
        const candidate = sourceLines[candidateIndex]!;
        if (candidate.trim().length === 0) continue;
        const candidateIndentation = /^\s*/u.exec(candidate)?.[0].length ?? 0;
        if (candidateIndentation <= indentation) break;
        endIndex = candidateIndex;
      }

      declarations.push({ line: lineIndex + 1, endLine: endIndex + 1 });
      continue;
    }

    const publicGetter = /^(\s*)[A-Za-z_][A-Za-z0-9_]*\s*:\s*public\s*\(/u.exec(sourceLine);
    if (publicGetter === null || publicGetter[1]!.length !== 0) continue;
    declarations.push({
      line: lineIndex + 1,
      endLine: vyperBalancedDeclarationEndLineIndex(sourceLines, lineIndex, publicGetter.index) + 1
    });
  }
  return declarations;
}

function stripVyperCoverageSourceCommentsAndStrings(source: string): string {
  let state: "code" | "comment" | "single" | "double" | "triple-single" | "triple-double" = "code";
  let escaped = false;
  let result = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const triple = source.slice(index, index + 3);
    if (state === "code") {
      if (character === "#") {
        state = "comment";
        result += " ";
      } else if (triple === "'''" || triple === '"""') {
        state = triple === "'''" ? "triple-single" : "triple-double";
        result += "   ";
        index += 2;
      } else if (character === "'" || character === '"') {
        state = character === "'" ? "single" : "double";
        result += " ";
      } else result += character;
      continue;
    }
    if (state === "comment" && (character === "\n" || character === "\r")) {
      state = "code";
      result += character;
      continue;
    }
    if ((state === "triple-single" && triple === "'''") || (state === "triple-double" && triple === '"""')) {
      state = "code";
      result += "   ";
      index += 2;
      continue;
    }
    if (
      (state === "single" || state === "double") &&
      !escaped &&
      ((state === "single" && character === "'") || (state === "double" && character === '"'))
    ) {
      state = "code";
      result += " ";
      continue;
    }
    escaped = (state === "single" || state === "double") && !escaped && character === "\\";
    if (character !== "\\") escaped = false;
    result += character === "\n" || character === "\r" ? character : " ";
  }
  return result;
}

function vyperSignatureEndLineIndex(sourceLines: readonly string[], startIndex: number, startColumn: number): number {
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  for (let lineIndex = startIndex; lineIndex < sourceLines.length; lineIndex += 1) {
    const line = sourceLines[lineIndex]!;
    const columnStart = lineIndex === startIndex ? startColumn : 0;
    for (let column = columnStart; column < line.length; column += 1) {
      const character = line[column]!;
      if (character === "(") parenthesisDepth += 1;
      else if (character === ")") parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      else if (character === "[") bracketDepth += 1;
      else if (character === "]") bracketDepth = Math.max(0, bracketDepth - 1);
      else if (character === ":" && parenthesisDepth === 0 && bracketDepth === 0) return lineIndex;
    }
  }
  return startIndex;
}

function vyperBalancedDeclarationEndLineIndex(
  sourceLines: readonly string[],
  startIndex: number,
  startColumn: number
): number {
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  let sawDelimiter = false;
  for (let lineIndex = startIndex; lineIndex < sourceLines.length; lineIndex += 1) {
    const line = sourceLines[lineIndex]!;
    const columnStart = lineIndex === startIndex ? startColumn : 0;
    for (let column = columnStart; column < line.length; column += 1) {
      const character = line[column]!;
      if (character === "(") {
        parenthesisDepth += 1;
        sawDelimiter = true;
      } else if (character === ")") parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      else if (character === "[") {
        bracketDepth += 1;
        sawDelimiter = true;
      } else if (character === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    }
    if (sawDelimiter && parenthesisDepth === 0 && bracketDepth === 0) return lineIndex;
  }
  return startIndex;
}

function stripCoverageSourceCommentsAndStrings(source: string): string {
  let state: "code" | "line-comment" | "block-comment" | "single-string" | "double-string" = "code";
  let escaped = false;
  let result = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (state === "code") {
      if (character === "/" && next === "/") {
        state = "line-comment";
        result += "  ";
        index += 1;
      } else if (character === "/" && next === "*") {
        state = "block-comment";
        result += "  ";
        index += 1;
      } else if (character === "'") {
        state = "single-string";
        result += " ";
      } else if (character === '"') {
        state = "double-string";
        result += " ";
      } else result += character;
      continue;
    }
    if (state === "line-comment" && (character === "\n" || character === "\r")) {
      state = "code";
      result += character;
    } else if (state === "block-comment" && character === "*" && next === "/") {
      state = "code";
      result += "  ";
      index += 1;
    } else if (
      (state === "single-string" || state === "double-string") &&
      !escaped &&
      ((state === "single-string" && character === "'") || (state === "double-string" && character === '"'))
    ) {
      state = "code";
      result += " ";
    } else {
      escaped = (state === "single-string" || state === "double-string") && !escaped && character === "\\";
      if (character !== "\\") escaped = false;
      result += character === "\n" || character === "\r" ? character : " ";
    }
  }
  return result;
}

function configuredProductionSourceRoots(layout: RunLayout): string[] | undefined {
  if (!fs.existsSync(layout.resolvedConfigPath)) return undefined;
  const parsed = parseProjectConfigToml(fs.readFileSync(layout.resolvedConfigPath, "utf8"), layout.resolvedConfigPath);
  const roots = parsed.ok ? parsed.value.permissions?.productionSourceRoots : undefined;
  return roots === undefined || roots.length === 0 ? undefined : roots;
}

function productionContractSourceFiles(workspacePath: string, productionRoots: readonly string[]): string[] {
  const productionExtensions = new Set([".sol", ".vy"]);
  const results: string[] = [];
  let existingRootCount = 0;
  const visit = (directory: string, relativeDirectory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (entry.isSymbolicLink())
        throw new Error(`Coverage production source inventory contains symlink ${relativePath}`);
      if (entry.isDirectory()) visit(path.join(directory, entry.name), relativePath);
      else if (entry.isFile() && productionExtensions.has(path.extname(entry.name))) {
        if (results.length >= MAX_COVERAGE_EVIDENCE_FILES) {
          throw new Error(`Coverage production source inventory exceeds ${MAX_COVERAGE_EVIDENCE_FILES} files`);
        }
        results.push(relativePath);
      }
    }
  };
  for (const root of productionRoots) {
    const absoluteRoot = safeResolveInside(workspacePath, root, "production source root");
    let rootStat: fs.Stats;
    try {
      rootStat = fs.lstatSync(absoluteRoot);
    } catch (error) {
      if (isMissingFileError(error)) continue;
      throw error;
    }
    if (rootStat.isSymbolicLink()) throw new Error(`Coverage production source root is a symlink: ${root}`);
    if (!rootStat.isDirectory()) throw new Error(`Coverage production source root is not a directory: ${root}`);
    existingRootCount += 1;
    visit(absoluteRoot, root);
  }
  if (existingRootCount === 0) {
    throw new Error(`Every configured coverage production source root is missing: ${productionRoots.join(", ")}`);
  }
  if (results.length === 0) {
    throw new Error("Coverage production source roots contain no Solidity or Vyper production sources");
  }
  return results.sort();
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function readReconCoverageSelection(workspacePath: string, inventory: ReadonlySet<string>): ReconCoverageSelection {
  const selectionPath = safeResolveInside(workspacePath, "magic/recon-coverage.json", "Recon coverage selection map");
  if (!fs.existsSync(selectionPath)) return { ranges: new Map(), diagnostics: [] };

  let document: unknown;
  try {
    assertRegularFileInside(workspacePath, selectionPath, "Recon coverage selection map");
    document = parseStrictJsonBytes(readRegularFileSnapshot(selectionPath, MAX_ARTIFACT_SNAPSHOT_BYTES));
  } catch (error) {
    return {
      diagnostics: [
        {
          code: "COVERAGE_RECON_SELECTION_INVALID",
          message: `Recon coverage selection map is unsafe or invalid: ${error instanceof Error ? error.message : String(error)}`,
          severity: "error",
          source: "coverage-evidence",
          path: selectionPath
        }
      ]
    };
  }
  if (!isRecord(document)) {
    return {
      diagnostics: [
        {
          code: "COVERAGE_RECON_SELECTION_INVALID",
          message: "Recon coverage selection map must be a JSON object from production source paths to line ranges",
          severity: "error",
          source: "coverage-evidence",
          path: selectionPath
        }
      ]
    };
  }

  const ranges = new Map<string, ReconCoverageRange[]>();
  const diagnostics: RuntimeDiagnostic[] = [];
  let selectedRangeCount = 0;
  for (const [relativePath, rawRanges] of Object.entries(document)) {
    const safeRelativePath =
      !path.isAbsolute(relativePath) &&
      !relativePath.includes("\\") &&
      !relativePath.includes("\u0000") &&
      !/^[A-Za-z]:/u.test(relativePath) &&
      relativePath.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
    if (!safeRelativePath) {
      diagnostics.push({
        code: "COVERAGE_RECON_SELECTION_INVALID",
        message: `Recon coverage selection map includes unsafe source path ${JSON.stringify(relativePath)}`,
        severity: "error",
        source: "coverage-evidence",
        path: selectionPath
      });
      continue;
    }
    if (!inventory.has(relativePath)) {
      // Recon recursively follows calls into dependencies. Those paths are
      // outside the configured production-source authority and therefore do
      // not authenticate selected production ranges; dependency evidence is
      // still reconciled independently against declared workspace files.
      try {
        const sourcePath = safeResolveInside(workspacePath, relativePath, "Recon-selected non-production source");
        assertRegularFileInside(workspacePath, sourcePath, "Recon-selected non-production source");
      } catch {
        diagnostics.push({
          code: "COVERAGE_RECON_SELECTION_FILE_UNKNOWN",
          message: `Recon coverage selection map includes nonexistent or unsafe non-production source ${relativePath}`,
          severity: "error",
          source: "coverage-evidence",
          path: selectionPath
        });
      }
      continue;
    }
    if (!Array.isArray(rawRanges) || rawRanges.length === 0) {
      diagnostics.push({
        code: "COVERAGE_RECON_SELECTION_INVALID",
        message: `Recon coverage selection for ${relativePath} must contain at least one line range`,
        severity: "error",
        source: "coverage-evidence",
        path: selectionPath
      });
      continue;
    }
    selectedRangeCount += rawRanges.length;
    if (selectedRangeCount > MAX_COVERAGE_EVIDENCE_RANGES) {
      diagnostics.push({
        code: "COVERAGE_RECON_SELECTION_INVALID",
        message: `Recon coverage selection exceeds ${MAX_COVERAGE_EVIDENCE_RANGES} line ranges`,
        severity: "error",
        source: "coverage-evidence",
        path: selectionPath
      });
      continue;
    }
    const sourcePath = safeResolveInside(workspacePath, relativePath, "Recon-selected production source");
    const source = readRegularFileSnapshot(sourcePath, MAX_ARTIFACT_SNAPSHOT_BYTES).toString("utf8");
    const normalizedSource = source.replace(/\r?\n$/u, "");
    const sourceLineCount = normalizedSource === "" ? 0 : normalizedSource.split(/\r?\n/u).length;
    const parsedRanges: ReconCoverageRange[] = [];
    for (const [index, rawRange] of rawRanges.entries()) {
      const match = typeof rawRange === "string" ? /^([1-9]\d*)(?:-([1-9]\d*))?$/u.exec(rawRange) : null;
      const startLine = match === null ? Number.NaN : Number(match[1]);
      const endLine = match === null ? Number.NaN : Number(match[2] ?? match[1]);
      if (
        match === null ||
        !Number.isSafeInteger(startLine) ||
        !Number.isSafeInteger(endLine) ||
        endLine < startLine ||
        endLine > sourceLineCount
      ) {
        diagnostics.push({
          code: "COVERAGE_RECON_SELECTION_INVALID",
          message: `Recon coverage selection ${relativePath}[${index}] is not a valid in-bounds positive line range`,
          severity: "error",
          source: "coverage-evidence",
          path: selectionPath
        });
        continue;
      }
      parsedRanges.push({ startLine, endLine });
    }
    ranges.set(relativePath, coalesceReconCoverageRanges(parsedRanges));
  }
  return diagnostics.length === 0 ? { ranges, diagnostics } : { diagnostics };
}

function coalesceReconCoverageRanges(ranges: readonly ReconCoverageRange[]): ReconCoverageRange[] {
  const sorted = [...ranges].sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
  const coalesced: ReconCoverageRange[] = [];
  for (const range of sorted) {
    const previous = coalesced.at(-1);
    if (previous === undefined || range.startLine > previous.endLine + 1) {
      coalesced.push({ ...range });
      continue;
    }
    previous.endLine = Math.max(previous.endLine, range.endLine);
  }
  return coalesced;
}

function reconCoverageRangesOverlap(
  ranges: readonly ReconCoverageRange[] | undefined,
  startLine: number,
  endLine: number
): boolean {
  if (ranges === undefined || ranges.length === 0) return false;
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (ranges[middle]!.startLine <= endLine) low = middle + 1;
    else high = middle;
  }
  return low > 0 && ranges[low - 1]!.endLine >= startLine;
}

type ImplementedPropertiesRead = {
  value?: ImplementedPropertiesArtifact;
  path?: string;
  diagnostics: RuntimeDiagnostic[];
};

/**
 * Capture the implementation half of a mixed-role producer from its exact
 * declared output. The immutable bytes are schema-validated before either the
 * implementation gate or a sibling campaign join can consume the document.
 */
function readDeclaredSiblingImplementedProperties(
  artifactDir: string,
  node: PlannedGraphNode,
  layout: RunLayout,
  authenticated?: AuthenticatedArtifactGateSnapshots
): ImplementedPropertiesRead {
  const outputs = node.outputs.filter((output) => output.contract === "ultrafuzz/implemented-properties@3");
  if (outputs.length !== 1) {
    return {
      diagnostics: [
        {
          code: "PROPERTY_IMPLEMENTATION_DECLARATION_AMBIGUOUS",
          message: `Property implementation must declare exactly one ultrafuzz/implemented-properties@3 output; found ${outputs.length}`,
          severity: "error",
          source: "property-provenance",
          path: layout.graphPath
        }
      ]
    };
  }
  const artifactPath = safeResolveInside(artifactDir, outputs[0]!.path, "implemented property sibling output");
  const bytes = readCurrentArtifactSnapshot(artifactDir, artifactPath, authenticated);
  if (bytes === undefined) {
    return {
      diagnostics: [
        {
          code: "IMPLEMENTED_PROPERTIES_SIBLING_MISSING",
          message: `Declared sibling implementation output ${JSON.stringify(outputs[0]!.path)} is unavailable`,
          severity: "error",
          source: "property-provenance",
          path: artifactPath
        }
      ]
    };
  }
  try {
    const contract = validateArtifactContractBytes("ultrafuzz/implemented-properties@3", bytes, artifactPath);
    if (!contract.ok || contract.value === undefined) {
      return { diagnostics: schemaDiagnostics(contract.issues) };
    }
    const parsed = validateImplementedPropertiesSchema(contract.value, artifactPath);
    return parsed.ok && parsed.value !== undefined
      ? { value: parsed.value, path: artifactPath, diagnostics: [] }
      : { diagnostics: schemaDiagnostics(parsed.issues) };
  } catch (error) {
    return {
      diagnostics: [diagnosticFromError(error, "property-provenance", "IMPLEMENTED_PROPERTIES_SIBLING_INVALID")]
    };
  }
}

function verifyImplementationPropertyReferences(
  layout: RunLayout,
  artifactDir: string,
  catalog: PropertiesArtifact,
  node: PlannedGraphNode,
  implementation: ImplementedPropertiesArtifact,
  implementationPath: string,
  authenticated?: AuthenticatedArtifactGateSnapshots
): RuntimeDiagnostic[] {
  const references: PropertyReferenceInput[] = implementation.properties.map((record, index) => ({
    propertyIds: [record.property_id],
    path: `${implementationPath}#$.properties[${index}].property_id`
  }));
  for (const output of node.outputs.filter((candidate) => candidate.contract === "ultrafuzz/findings@2")) {
    const findingsPath = safeResolveInside(artifactDir, output.path, "implementation finding output");
    const findings = parseCurrentArtifactJson(artifactDir, findingsPath, authenticated);
    if (findings !== undefined) references.push(...findingPropertyReferences(findings, findingsPath));
  }
  return [
    ...propertyReferenceDiagnostics(catalog, references),
    ...verifyImplementationSelectionCoverage(catalog, implementation, implementationPath, layout)
  ];
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
  node: PlannedGraphNode,
  attemptId: string,
  attemptAuthority?: ArtifactGateAttemptAuthority,
  authenticated?: AuthenticatedArtifactGateSnapshots
): RuntimeDiagnostic[] {
  let declaration: Pick<NodeOutputContract, "path">;
  if (attemptAuthority === undefined) {
    const resolved = resolveStateDeclaredPropertyLens(readRunState(layout), attemptId, "property-provenance");
    if (!resolved.ok) return [resolved.diagnostic];
    declaration = resolved.output;
  } else {
    try {
      assertRegularFileInside(layout.root, layout.graphPath, "current property lens attempt authority");
      const graph = assertPlannedGraph(readStrictRegisteredDocument(layout.graphPath, "planned-graph.schema.json"));
      assertExactSealedAttemptAuthority(layout, graph, node, attemptAuthority);
    } catch (error) {
      return [diagnosticFromError(error, "property-provenance", "PROPERTY_LENS_AUTHORITY_INVALID")];
    }
    const sealedOutputs = attemptAuthority.task.metadata.artifacts.outputs.filter(
      (output) => output.contract === PROPERTY_LENS_CONTRACT
    );
    const plannedOutputs = node.outputs.filter((output) => output.contract === PROPERTY_LENS_CONTRACT);
    if (
      sealedOutputs.length !== 1 ||
      plannedOutputs.length !== 1 ||
      !smithersOutputMatchesPlanned(sealedOutputs[0]!, plannedOutputs[0]!)
    ) {
      return [
        {
          code: "PROPERTY_LENS_SCHEMA_BINDING_INVALID",
          message: `Current Smithers attempt ${JSON.stringify(attemptId)} must match its exact planned ${PROPERTY_LENS_CONTRACT} declaration`,
          severity: "error",
          source: "property-provenance",
          path: `smithers.tasks.${attemptId}.metadata.artifacts.outputs`
        }
      ];
    }
    declaration = sealedOutputs[0]!;
  }
  const lensPath = safeResolveInside(artifactDir, declaration.path, "property lens output");
  const lensDocument = parseCurrentArtifactJson(artifactDir, lensPath, authenticated);
  if (lensDocument === undefined) {
    return [
      {
        code: "PROPERTY_LENS_MISSING",
        message: `Declared property lens output ${JSON.stringify(declaration.path)} is unavailable`,
        severity: "error",
        source: "property-provenance",
        path: lensPath
      }
    ];
  }
  const lens = validateLensPropertiesSchema(lensDocument, lensPath);
  if (!lens.ok || lens.value === undefined) {
    return lens.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      severity: "error",
      source: "property-provenance",
      path: issue.path
    }));
  }

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
    const provenance = state.nodes[dependencyId]?.provenance;
    if (provenance === undefined || !("origin" in provenance) || provenance.origin !== "pinned-reference") continue;
    const dependencyDir = getNodeArtifactDir(layout, dependencyId);
    const expectationPaths = [
      ...(declaresReferenceExpectationCatalog(state.nodes[dependencyId]?.outputs, "references/expectations.json")
        ? ["references/expectations.json"]
        : [])
    ];
    if (expectationPaths.length === 0) continue;
    catalogSupplied = true;
    const metadata = provenance.reference_expectations;
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
      (output) => output.path === expectedPath && output.contract === "ultrafuzz/reference-expectations@2"
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
    const catalogContents = readRegularFileSnapshot(catalogPath, MAX_ARTIFACT_SNAPSHOT_BYTES);
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
    const parsed = validateReferenceExpectationsSchema(parseStrictJsonBytes(catalogContents), catalogPath);
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
    const uniqueness = executeSemanticGate("reference-expectation-id-uniqueness", { document: parsed.value });
    if (uniqueness.status !== "passed") {
      diagnostics.push({
        code: "PROPERTY_REFERENCE_EXPECTATION_TAMPERED",
        message: `Reference expectation catalog for ${JSON.stringify(dependencyId)} failed semantic validation`,
        severity: "error",
        source: "property-provenance",
        path: catalogPath,
        details:
          uniqueness.status === "failed"
            ? { gate: uniqueness.gate, issues: uniqueness.issues }
            : { gate: uniqueness.gate, missing_context: uniqueness.missingContext }
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

/** Validate the explicit priority selection required by the current contract. */
function verifyImplementationSelectionCoverage(
  catalog: PropertiesArtifact,
  implementation: ImplementedPropertiesArtifact,
  implementationPath: string,
  layout: RunLayout
): RuntimeDiagnostic[] {
  const selection = implementation.selection;
  if (selection === undefined) {
    return [
      {
        code: "PROPERTY_IMPLEMENTATION_SELECTION_MISSING",
        message: "Invariant implementation artifacts must declare selection metadata",
        severity: "error",
        source: "property-provenance",
        path: `${implementationPath}#$.selection`
      }
    ];
  }

  const diagnostics: RuntimeDiagnostic[] = [];
  const configuredSelection = readConfiguredInvariantPrioritySelection(layout);
  if (configuredSelection === undefined) {
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

function verifyCampaignPropertyReferences(
  layout: RunLayout,
  artifactDir: string,
  catalog: PropertiesArtifact,
  node: PlannedGraphNode,
  attemptAuthority?: ArtifactGateAttemptAuthority,
  authenticated?: AuthenticatedArtifactGateSnapshots
): RuntimeDiagnostic[] {
  const campaignOutputs = node.outputs.filter((output) => output.contract === "ultrafuzz/property-campaign@3");
  const findingOutputs = node.outputs.filter((output) => output.contract === "ultrafuzz/findings@2");
  const summaryOutputs = node.outputs.filter((output) => output.contract === "ultrafuzz/campaign-summary@2");
  if (findingOutputs.length !== 1 || summaryOutputs.length > 1) {
    return [
      {
        code: "PROPERTY_CAMPAIGN_DECLARATION_AMBIGUOUS",
        message: `Property campaign must declare one ultrafuzz/findings@2 output and at most one ultrafuzz/campaign-summary@2 output; found ${findingOutputs.length} and ${summaryOutputs.length}`,
        severity: "error",
        source: "property-provenance",
        path: layout.graphPath
      }
    ];
  }
  const findingsPath = safeResolveInside(artifactDir, findingOutputs[0]!.path, "campaign finding output");
  const campaignPaths = campaignOutputs.map((output) =>
    safeResolveInside(artifactDir, output.path, "property campaign output")
  );
  const summaryPath =
    summaryOutputs.length === 0
      ? undefined
      : safeResolveInside(artifactDir, summaryOutputs[0]!.path, "campaign summary output");
  const campaignDocuments = campaignPaths.map((campaignPath) =>
    parseCurrentArtifactJson(artifactDir, campaignPath, authenticated)
  );
  const findingsDocument = parseCurrentArtifactJson(artifactDir, findingsPath, authenticated);
  if (campaignDocuments.some((document) => document === undefined) || findingsDocument === undefined) return [];
  const campaigns = campaignPaths.flatMap((campaignPath) => {
    const campaign = validatePropertyCampaignSchema(
      campaignDocuments[campaignPaths.indexOf(campaignPath)],
      campaignPath
    );
    return campaign.ok && campaign.value !== undefined ? [{ path: campaignPath, value: campaign.value }] : [];
  });
  const findings = validateFindingsSchema(findingsDocument, findingsPath);
  if (!findings.ok || findings.value === undefined) {
    return [];
  }
  const validatedFindings = findings.value;
  const campaignValues = campaigns.map((campaign) => campaign.value);
  const summaryDiagnostics =
    campaigns.length === campaignPaths.length
      ? campaignSummaryFailureCountDiagnostics(
          artifactDir,
          summaryPath,
          campaignValues,
          validatedFindings,
          authenticated
        )
      : [];
  const backendDiagnostics =
    campaigns.length === campaignPaths.length
      ? campaignFindingFuzzerBackendDiagnostics(campaignValues, validatedFindings, findingsPath)
      : [];
  const partitionDiagnostics =
    campaigns.length === campaignPaths.length
      ? campaignFailurePartitionDiagnostics(campaigns, validatedFindings, findingsPath)
      : [];
  const implementation = readImplementedProperties(layout, node, attemptAuthority);
  if (implementation.diagnostics.length > 0 || implementation.value === undefined) {
    return [...summaryDiagnostics, ...backendDiagnostics, ...partitionDiagnostics, ...implementation.diagnostics];
  }
  const candidateFindingIds = new Set(
    campaigns.flatMap((campaign) => campaign.value.failures.map((failure) => failure.id))
  );

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
    ...summaryDiagnostics,
    ...backendDiagnostics,
    ...partitionDiagnostics,
    ...propertyReferenceDiagnostics(catalog, references),
    ...campaigns.flatMap((campaign) =>
      campaignFindingReferenceDiagnostics(
        campaign.value.failures,
        validatedFindings,
        candidateFindingIds,
        campaign.path,
        findingsPath
      )
    ),
    ...danglingCampaignFindingDiagnostics(
      new Set(campaigns.flatMap((campaign) => campaign.value.failures.map((failure) => failure.id))),
      validatedFindings,
      findingsPath
    ),
    ...unobservedFindingPropertyDiagnostics(
      new Set(
        campaigns.flatMap((campaign) => campaign.value.failures.flatMap((failure) => failure.property_ids ?? []))
      ),
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
      if (!implementedIds.has(propertyId)) {
        diagnostics.push({
          code: "PROPERTY_IMPLEMENTATION_REFERENCE_INVALID",
          message: `Property ${JSON.stringify(propertyId)} is outside the exact implemented-property set`,
          severity: "error",
          source: "property-provenance",
          path: reference.path
        });
      }
    }
  }
  return diagnostics;
}

interface CampaignFailureReference {
  fuzzer_backend: string;
  failure_id: string;
  raw_result_ref: string;
}

interface PartitionedCampaignFailure {
  key: string;
  id: string;
  fuzzerBackend?: string;
  rawResultRef: string;
  propertyIds: readonly string[];
  path: string;
}

/** Prove the producer-owned failure-to-finding partition for every campaign. */
function campaignFailurePartitionDiagnostics(
  campaigns: readonly { path: string; value: PropertyCampaignArtifact }[],
  findings: readonly Readonly<Record<string, unknown>>[],
  findingsPath: string
): RuntimeDiagnostic[] {
  const failures: PartitionedCampaignFailure[] = campaigns.flatMap((campaign, campaignIndex) =>
    campaign.value.failures.map((failure, failureIndex) => ({
      key: `${campaignIndex}\u0000${failureIndex}`,
      id: failure.id,
      ...(campaign.value.fuzzer_backend === undefined ? {} : { fuzzerBackend: campaign.value.fuzzer_backend }),
      rawResultRef: path.basename(campaign.path),
      propertyIds: failure.property_ids ?? [],
      path: `${campaign.path}#$.failures[${failureIndex}].id`
    }))
  );
  const failuresById = new Map<string, PartitionedCampaignFailure[]>();
  const failuresByBackendAndId = new Map<string, PartitionedCampaignFailure[]>();
  for (const failure of failures) {
    const byId = failuresById.get(failure.id) ?? [];
    byId.push(failure);
    failuresById.set(failure.id, byId);
    if (failure.fuzzerBackend !== undefined) {
      const qualifiedKey = campaignBackendFailureKey(failure.fuzzerBackend, failure.id);
      const qualified = failuresByBackendAndId.get(qualifiedKey) ?? [];
      qualified.push(failure);
      failuresByBackendAndId.set(qualifiedKey, qualified);
    }
  }

  const diagnostics: RuntimeDiagnostic[] = [];
  const claimedBy = new Map<string, { findingIndex: number; referenceIndex: number }>();
  for (const [findingIndex, finding] of findings.entries()) {
    const propertyIds = Array.isArray(finding.property_ids)
      ? finding.property_ids.filter((propertyId): propertyId is string => typeof propertyId === "string")
      : [];
    const hasContributions = Object.prototype.hasOwnProperty.call(finding, "contributing_backend_failures");
    const hasDeduplication = Object.prototype.hasOwnProperty.call(finding, "deduplication");
    const mustAccount = propertyIds.length > 0 || hasContributions || hasDeduplication;
    if (!mustAccount) continue;

    const contributionPath = `${findingsPath}#$[${findingIndex}].contributing_backend_failures`;
    const deduplicationPath = `${findingsPath}#$[${findingIndex}].deduplication`;
    if (!hasContributions) {
      diagnostics.push({
        code: "PROPERTY_CAMPAIGN_PARTITION_REQUIRED",
        message: `Finding ${JSON.stringify(finding.id)} must declare contributing_backend_failures`,
        severity: "error",
        source: "property-provenance",
        path: contributionPath
      });
    }
    if (!hasDeduplication) {
      diagnostics.push({
        code: "PROPERTY_CAMPAIGN_PARTITION_REQUIRED",
        message: `Finding ${JSON.stringify(finding.id)} must declare deduplication.pre_dedup_count`,
        severity: "error",
        source: "property-provenance",
        path: deduplicationPath
      });
    }

    const references = campaignFailureReferences(finding.contributing_backend_failures);
    const deduplication = isRecord(finding.deduplication) ? finding.deduplication : undefined;
    const preDedupCount = deduplication?.pre_dedup_count;
    if (references !== undefined && typeof preDedupCount === "number" && preDedupCount !== references.length) {
      diagnostics.push({
        code: "PROPERTY_CAMPAIGN_PARTITION_COUNT_MISMATCH",
        message: `Finding ${JSON.stringify(finding.id)} reports deduplication.pre_dedup_count ${preDedupCount}, but contributing_backend_failures contains ${references.length} entries`,
        severity: "error",
        source: "property-provenance",
        path: `${deduplicationPath}.pre_dedup_count`
      });
    }
    if (references === undefined) continue;

    const resolvedFailures: PartitionedCampaignFailure[] = [];
    for (const [referenceIndex, reference] of references.entries()) {
      const referencePath = `${contributionPath}[${referenceIndex}]`;
      const candidates =
        failuresByBackendAndId.get(campaignBackendFailureKey(reference.fuzzer_backend, reference.failure_id)) ?? [];
      if (candidates.length === 0) {
        diagnostics.push({
          code: "PROPERTY_CAMPAIGN_PARTITION_REFERENCE_UNKNOWN",
          message: `Finding ${JSON.stringify(finding.id)} names unknown contributing backend failure ${JSON.stringify(reference)}`,
          severity: "error",
          source: "property-provenance",
          path: referencePath
        });
        continue;
      }
      if (candidates.length > 1) {
        diagnostics.push({
          code: "PROPERTY_CAMPAIGN_PARTITION_REFERENCE_AMBIGUOUS",
          message: `Finding ${JSON.stringify(finding.id)} uses an ambiguous contributing backend failure ${JSON.stringify(reference)}; qualify it with fuzzer_backend and failure_id`,
          severity: "error",
          source: "property-provenance",
          path: referencePath
        });
        continue;
      }
      const failure = candidates[0]!;
      if (reference.raw_result_ref !== failure.rawResultRef) {
        diagnostics.push({
          code: "PROPERTY_CAMPAIGN_PARTITION_RAW_RESULT_MISMATCH",
          message: `Finding ${JSON.stringify(finding.id)} contribution raw_result_ref must name the authenticated campaign result ${JSON.stringify(failure.rawResultRef)}`,
          severity: "error",
          source: "property-provenance",
          path: `${referencePath}.raw_result_ref`
        });
        continue;
      }
      if (failure.propertyIds.length === 0) {
        diagnostics.push({
          code: "PROPERTY_CAMPAIGN_PARTITION_REFERENCE_UNKNOWN",
          message: `Finding ${JSON.stringify(finding.id)} contribution ${JSON.stringify(reference)} does not name a property-derived failure`,
          severity: "error",
          source: "property-provenance",
          path: referencePath
        });
        continue;
      }
      resolvedFailures.push(failure);

      const earlierClaim = claimedBy.get(failure.key);
      if (earlierClaim !== undefined) {
        diagnostics.push({
          code: "PROPERTY_CAMPAIGN_PARTITION_DUPLICATE",
          message: `Property-derived failure ${JSON.stringify(failure.id)} is claimed more than once across findings`,
          severity: "error",
          source: "property-provenance",
          path: referencePath,
          details: {
            first_claim: `${findingsPath}#$[${earlierClaim.findingIndex}].contributing_backend_failures[${earlierClaim.referenceIndex}]`
          }
        });
      } else {
        claimedBy.set(failure.key, { findingIndex, referenceIndex });
      }
    }

    // Unknown, ambiguous, and non-property references already carry precise
    // diagnostics above. Do not derive a partial partition from them.
    if (resolvedFailures.length !== references.length) continue;

    if (typeof finding.id !== "string" || !resolvedFailures.some((failure) => failure.id === finding.id)) {
      diagnostics.push({
        code: "PROPERTY_CAMPAIGN_PARTITION_REPRESENTATIVE_MISMATCH",
        message: `Finding ${JSON.stringify(finding.id)} must use the ID of one failure in its contributing_backend_failures partition`,
        severity: "error",
        source: "property-provenance",
        path: `${findingsPath}#$[${findingIndex}].id`
      });
    }

    const contributedPropertyIds = [...new Set(resolvedFailures.flatMap((failure) => failure.propertyIds))];
    if (!sameStringSet(propertyIds, contributedPropertyIds)) {
      diagnostics.push({
        code: "PROPERTY_CAMPAIGN_PARTITION_PROPERTY_MISMATCH",
        message: `Finding ${JSON.stringify(finding.id)} property_ids must exactly equal the union reported by its contributing_backend_failures`,
        severity: "error",
        source: "property-provenance",
        path: `${findingsPath}#$[${findingIndex}].property_ids`
      });
    }

    const missingBackendCount = resolvedFailures.filter((failure) => failure.fuzzerBackend === undefined).length;
    const contributedBackends = [
      ...new Set(
        resolvedFailures.flatMap((failure) => (failure.fuzzerBackend === undefined ? [] : [failure.fuzzerBackend]))
      )
    ];
    const ownedBackends = findingFuzzerBackendProvenance(finding);
    const hasExpectedBackendShape =
      contributedBackends.length === 0
        ? !ownedBackends.present
        : contributedBackends.length === 1
          ? Object.prototype.hasOwnProperty.call(finding, "fuzzer_backend")
          : Object.prototype.hasOwnProperty.call(finding, "fuzzer_backends");
    if (
      !ownedBackends.valid ||
      missingBackendCount > 0 ||
      !hasExpectedBackendShape ||
      !sameStringSet(ownedBackends.backends, contributedBackends)
    ) {
      diagnostics.push({
        code: "PROPERTY_CAMPAIGN_PARTITION_BACKEND_MISMATCH",
        message:
          missingBackendCount > 0
            ? `Finding ${JSON.stringify(finding.id)} cannot bind backend provenance because ${missingBackendCount} contributing failure record(s) omit fuzzer_backend`
            : `Finding ${JSON.stringify(finding.id)} fuzzer backend provenance must exactly match its contributing_backend_failures`,
        severity: "error",
        source: "property-provenance",
        path: `${findingsPath}#$[${findingIndex}]`
      });
    }
  }

  for (const failure of failures) {
    if (failure.propertyIds.length === 0 || claimedBy.has(failure.key)) continue;
    diagnostics.push({
      code: "PROPERTY_CAMPAIGN_PARTITION_UNCLAIMED",
      message: `Property-derived campaign failure ${JSON.stringify(failure.id)} is not claimed by any finding's contributing_backend_failures`,
      severity: "error",
      source: "property-provenance",
      path: failure.path
    });
  }
  return diagnostics;
}

function campaignFailureReferences(value: unknown): CampaignFailureReference[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const references: CampaignFailureReference[] = [];
  for (const reference of value) {
    if (
      isRecord(reference) &&
      typeof reference.fuzzer_backend === "string" &&
      typeof reference.failure_id === "string" &&
      typeof reference.raw_result_ref === "string"
    ) {
      references.push({
        fuzzer_backend: reference.fuzzer_backend,
        failure_id: reference.failure_id,
        raw_result_ref: reference.raw_result_ref
      });
    }
  }
  return references;
}

function campaignBackendFailureKey(fuzzerBackend: string, failureId: string): string {
  return JSON.stringify([fuzzerBackend, failureId]);
}

function campaignSummaryFailureCountDiagnostics(
  artifactDir: string,
  summaryPath: string | undefined,
  campaigns: readonly PropertyCampaignArtifact[],
  findings: readonly Readonly<Record<string, unknown>>[],
  authenticated?: AuthenticatedArtifactGateSnapshots
): RuntimeDiagnostic[] {
  if (summaryPath === undefined) return [];
  const summary = parseCurrentArtifactJson(artifactDir, summaryPath, authenticated);
  if (summary === undefined) return [];
  if (!isRecord(summary) || !Object.prototype.hasOwnProperty.call(summary, "failure_counts")) return [];
  if (!isRecord(summary.failure_counts)) {
    return [
      {
        code: "CAMPAIGN_SUMMARY_FAILURE_COUNTS_INVALID",
        message:
          "Declared campaign summary failure_counts must be an object containing pre_deduplication and post_deduplication counts",
        severity: "error",
        source: "campaign-summary",
        path: `${summaryPath}#$.failure_counts`
      }
    ];
  }

  const expected = {
    pre_deduplication: campaigns.reduce((total, campaign) => total + campaign.failures.length, 0),
    post_deduplication: findings.length
  } as const;
  const diagnostics: RuntimeDiagnostic[] = [];
  for (const field of ["pre_deduplication", "post_deduplication"] as const) {
    const actual = summary.failure_counts[field];
    const population =
      field === "pre_deduplication"
        ? "total failures across the sibling backend records"
        : "objects in the sibling findings.json array";
    if (typeof actual !== "number" || !Number.isSafeInteger(actual) || actual < 0) {
      diagnostics.push({
        code: "CAMPAIGN_SUMMARY_FAILURE_COUNT_INVALID",
        message: `Declared campaign summary failure_counts.${field} must be a non-negative safe integer equal to the ${population}`,
        severity: "error",
        source: "campaign-summary",
        path: `${summaryPath}#$.failure_counts.${field}`
      });
      continue;
    }
    if (actual !== expected[field]) {
      diagnostics.push({
        code: "CAMPAIGN_SUMMARY_FAILURE_COUNT_MISMATCH",
        message: `Declared campaign summary failure_counts.${field} reports ${actual}, but the ${population} is ${expected[field]}`,
        severity: "error",
        source: "campaign-summary",
        path: `${summaryPath}#$.failure_counts.${field}`
      });
    }
  }
  return diagnostics;
}

function campaignFindingFuzzerBackendDiagnostics(
  campaigns: readonly PropertyCampaignArtifact[],
  findings: readonly Readonly<Record<string, unknown>>[],
  findingsPath: string
): RuntimeDiagnostic[] {
  const knownBackends = new Set(
    campaigns.flatMap((campaign) => (campaign.fuzzer_backend === undefined ? [] : [campaign.fuzzer_backend]))
  );
  const inferredByFailureId = new Map<string, Set<string>>();
  for (const campaign of campaigns) {
    if (campaign.fuzzer_backend === undefined) continue;
    for (const failure of campaign.failures) {
      const backends = inferredByFailureId.get(failure.id) ?? new Set<string>();
      backends.add(campaign.fuzzer_backend);
      inferredByFailureId.set(failure.id, backends);
    }
  }

  const diagnostics: RuntimeDiagnostic[] = [];
  for (const [findingIndex, finding] of findings.entries()) {
    const owned = findingFuzzerBackendProvenance(finding);
    if (owned.present && !owned.valid) {
      diagnostics.push({
        code: "PROPERTY_FINDING_FUZZER_BACKEND_INVALID",
        message:
          "Campaign findings must use one non-empty fuzzer_backend string or one non-empty unique fuzzer_backends array, never both",
        severity: "error",
        source: "property-provenance",
        path: `${findingsPath}#$[${findingIndex}]`
      });
      continue;
    }
    if (owned.present) {
      const unknownBackends = owned.backends.filter((backend) => !knownBackends.has(backend));
      if (unknownBackends.length > 0) {
        diagnostics.push({
          code: "PROPERTY_FINDING_FUZZER_BACKEND_UNKNOWN",
          message: `Campaign finding ${JSON.stringify(finding.id)} names backends absent from the sibling result records: ${unknownBackends.map((backend) => JSON.stringify(backend)).join(", ")}`,
          severity: "error",
          source: "property-provenance",
          path: `${findingsPath}#$[${findingIndex}].${Array.isArray(finding.fuzzer_backends) ? "fuzzer_backends" : "fuzzer_backend"}`
        });
      }
      continue;
    }
    if (
      typeof finding.id === "string" &&
      stringArray(finding.property_ids).length > 0 &&
      (inferredByFailureId.get(finding.id)?.size ?? 0) > 1
    ) {
      diagnostics.push({
        code: "PROPERTY_FINDING_FUZZER_BACKEND_AMBIGUOUS",
        message: `Campaign finding ${JSON.stringify(finding.id)} matches failures from several backends and must own an explicit fuzzer_backends array`,
        severity: "error",
        source: "property-provenance",
        path: `${findingsPath}#$[${findingIndex}].id`
      });
    }
  }
  return diagnostics;
}

function verifyFinalReportPropertyReferences(
  layout: RunLayout,
  artifactDir: string,
  node: PlannedGraphNode,
  attemptAuthority?: ArtifactGateAttemptAuthority,
  authenticated?: AuthenticatedArtifactGateSnapshots
): RuntimeDiagnostic[] {
  const reportOutputs = node.outputs.filter((output) => output.contract === "ultrafuzz/report@2");
  if (reportOutputs.length !== 1) {
    return [
      {
        code: "PROPERTY_REPORT_DECLARATION_AMBIGUOUS",
        message: `Final report must declare exactly one ultrafuzz/report@2 output; found ${reportOutputs.length}`,
        severity: "error",
        source: "property-provenance",
        path: layout.graphPath
      }
    ];
  }
  const markdownOutputs = node.outputs.filter((output) => output.contract === "ultrafuzz/nonempty-markdown@1");
  if (markdownOutputs.length !== 1) {
    return [
      {
        code: "PROPERTY_REPORT_MARKDOWN_DECLARATION_AMBIGUOUS",
        message: `Report producer must declare exactly one corresponding ultrafuzz/nonempty-markdown@1 output; found ${markdownOutputs.length}`,
        severity: "error",
        source: "property-provenance",
        path: layout.graphPath
      }
    ];
  }
  const reportPath = safeResolveInside(artifactDir, reportOutputs[0]!.path, "final report output");
  const markdownPath = safeResolveInside(artifactDir, markdownOutputs[0]!.path, "final report Markdown output");
  const report = parseCurrentArtifactJson(artifactDir, reportPath, authenticated);
  if (report === undefined) return [];
  if (!isRecord(report)) {
    return [];
  }
  const diagnostics = verifyFinalReportImplementationCoverage(
    layout,
    artifactDir,
    node,
    report,
    reportPath,
    markdownPath,
    attemptAuthority,
    authenticated
  );
  diagnostics.push(
    ...verifyFinalReportCoverageEvidence(
      layout,
      artifactDir,
      node,
      report,
      reportPath,
      markdownPath,
      attemptAuthority,
      authenticated
    )
  );
  if (!Array.isArray(report.property_provenance)) {
    return diagnostics;
  }
  if (report.property_provenance.length === 0) {
    return diagnostics;
  }

  const catalog = readCanonicalPropertyCatalog(layout, node, attemptAuthority);
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
  const implementation = readImplementedProperties(layout, node, attemptAuthority);
  if (implementation.diagnostics.length > 0 || implementation.value === undefined) {
    return [...diagnostics, ...implementation.diagnostics];
  }
  const campaignAuthority = readCampaignFuzzerBackends(layout, node, attemptAuthority);
  diagnostics.push(...campaignAuthority.diagnostics);
  diagnostics.push(
    ...reportPropertyJoinDiagnostics(
      report.property_provenance,
      catalog.value,
      implementation.value,
      campaignAuthority.value,
      campaignAuthority.sourceNodeIds,
      report,
      reportPath
    )
  );
  return diagnostics;
}

function verifyFinalReportCoverageEvidence(
  layout: RunLayout,
  artifactDir: string,
  node: PlannedGraphNode,
  report: Record<string, unknown>,
  reportPath: string,
  markdownPath: string,
  attemptAuthority?: ArtifactGateAttemptAuthority,
  authenticated?: AuthenticatedArtifactGateSnapshots
): RuntimeDiagnostic[] {
  const diagnostics = unscopedCoverageScoreDiagnosticsInJson(report, reportPath);
  const markdownBytes = readCurrentArtifactSnapshot(artifactDir, markdownPath, authenticated);
  const markdown = markdownBytes?.toString("utf8") ?? "";
  diagnostics.push(...unscopedReportCoverageScoreDiagnostics(markdown, markdownPath));

  const producerStatus = plannedContractProducerStatus(layout, node, "ultrafuzz/coverage-evidence@1", attemptAuthority);
  if (producerStatus === "absent") {
    if (report.coverage_evidence !== undefined) {
      diagnostics.push({
        code: "REPORT_COVERAGE_EVIDENCE_UNPLANNED",
        message: "Final report must not invent coverage evidence without a planned typed producer",
        severity: "error",
        source: "coverage-evidence",
        path: `${reportPath}#$.coverage_evidence`
      });
    }
    return diagnostics;
  }
  if (producerStatus === "unknown" && report.coverage_evidence === undefined) return diagnostics;
  const evidence = finalizedSingletonAncestorOutput(
    layout,
    node,
    "ultrafuzz/coverage-evidence@1",
    "coverage evidence semantic context",
    attemptAuthority
  );
  if (evidence === undefined) {
    diagnostics.push({
      code: "REPORT_COVERAGE_EVIDENCE_UNAVAILABLE",
      message: "Final report cannot verify the planned coverage denominator without finalized producer authority",
      severity: "error",
      source: "coverage-evidence",
      path: `${reportPath}#$.coverage_evidence`
    });
    return diagnostics;
  }
  if (!isDeepStrictEqual(report.coverage_evidence, evidence.value)) {
    diagnostics.push({
      code: "REPORT_COVERAGE_EVIDENCE_MISMATCH",
      message: "Final report must preserve the complete scoped coverage denominator",
      severity: "error",
      source: "coverage-evidence",
      path: `${reportPath}#$.coverage_evidence`
    });
    return diagnostics;
  }

  diagnostics.push(
    ...coverageEvidenceMarkdownProjectionDiagnostics(
      evidence.value,
      markdown,
      markdownPath,
      "REPORT_COVERAGE_EVIDENCE_MARKDOWN_MISSING"
    )
  );
  return diagnostics;
}

function coverageEvidenceMarkdownProjectionDiagnostics(
  evidence: unknown,
  markdown: string,
  markdownPath: string,
  code: string
): RuntimeDiagnostic[] {
  const expectedLines = renderCoverageEvidenceMarkdownSection(evidence)
    .slice(1)
    .filter((line) => line.length > 0);
  const sections = markdownSectionOccurrences(markdown, "## Scoped coverage evidence");
  const renderedLines = sections[0]?.filter((line) => line.length > 0);
  const containsScopedFraction = (line: string): boolean =>
    /\b(?:selected-range|production-source)\b/u.test(line) && /\b\d+\s*\/\s*\d+\b/u.test(line);
  const scopedFractions = unfencedMarkdownLines(markdown).filter(containsScopedFraction);
  const expectedFractions = expectedLines.filter(containsScopedFraction);
  return sections.length === 1 &&
    renderedLines !== undefined &&
    sameStringSequence(renderedLines, expectedLines) &&
    sameStringSequence(scopedFractions, expectedFractions)
    ? []
    : [
        {
          code,
          message:
            "Markdown must contain exactly one canonical scoped coverage section, including every view, excluded component, and zero-coverage component, with no duplicate or misplaced scoped fractions",
          severity: "error",
          source: "coverage-evidence",
          path: markdownPath
        }
      ];
}

function unscopedCoverageScoreDiagnostics(
  contents: string,
  artifactPath: string,
  requireCoverageContext = false
): RuntimeDiagnostic[] {
  return contents
    .split(/\r?\n/u)
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .flatMap(({ line, lineNumber }) =>
      unscopedCoverageScoreKinds(line, requireCoverageContext).map((kind) => ({ lineNumber, kind }))
    )
    .map(({ lineNumber, kind }) => ({
      code: kind === "percentage" ? "UNSCOPED_COVERAGE_PERCENTAGE" : "UNSCOPED_COVERAGE_FRACTION",
      message:
        kind === "percentage"
          ? "Coverage percentages must name the exact selected-range or production-source scope on the same line"
          : "Coverage fractions must name the exact selected-range or production-source scope",
      severity: "error" as const,
      source: "coverage-evidence",
      path: `${artifactPath}:${lineNumber}`
    }));
}

function unscopedReportCoverageScoreDiagnostics(contents: string, artifactPath: string): RuntimeDiagnostic[] {
  let fenced = false;
  let coverageSection = false;
  return contents
    .split(/\r?\n/u)
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .map(({ line, lineNumber }) => {
      const trimmed = line.trim();
      if (/^(?:`{3,}|~{3,})/u.test(trimmed)) {
        fenced = !fenced;
        return { lineNumber, kinds: [] };
      }
      if (fenced) return { lineNumber, kinds: [] };
      if (/^##\s+/u.test(trimmed)) {
        coverageSection =
          /^##\s+(?:scoped coverage evidence|coverage(?:\s+(?:evidence|report|results?|summary))?)\s*$/iu.test(trimmed);
      }
      return {
        lineNumber,
        kinds: unscopedCoverageScoreKinds(line, !coverageSection)
      };
    })
    .flatMap(({ lineNumber, kinds }) => kinds.map((kind) => ({ lineNumber, kind })))
    .map(({ lineNumber, kind }) => ({
      code: kind === "percentage" ? "UNSCOPED_COVERAGE_PERCENTAGE" : "UNSCOPED_COVERAGE_FRACTION",
      message:
        kind === "percentage"
          ? "Coverage percentages must name the exact selected-range or production-source scope on the same line"
          : "Coverage fractions must name the exact selected-range or production-source scope",
      severity: "error" as const,
      source: "coverage-evidence",
      path: `${artifactPath}:${lineNumber}`
    }));
}

function unscopedCoverageScoreKinds(line: string, requireCoverageContext: boolean): ("percentage" | "fraction")[] {
  const score = /\b(?:100(?:\.0+)?|\d{1,2}(?:\.\d+)?)\s*%|\b\d+\s*\/\s*\d+\b/gu;
  const namedScope = /\b(?:selected-range|production-source)\b/giu;
  const kinds = new Set<"percentage" | "fraction">();
  const normalizedLine = line.replace(/(?:&#(?:0*37|x0*25)|&percnt);/giu, "%");
  for (const clause of normalizedLine.split(
    /\s*(?:[,!?;()[\]{}]|\u2013|\u2014|(?<!\d)\.|\.(?!\d)|\b(?:and|but|whereas|while)\b)\s*/iu
  )) {
    const scores = [...clause.matchAll(score)];
    const scopes = [...clause.matchAll(namedScope)];
    for (const [index, match] of scores.entries()) {
      const start = match.index!;
      const end = start + match[0].length;
      const previous = scores[index - 1];
      const next = scores[index + 1];
      const regionStart = previous === undefined ? 0 : Math.floor((previous.index! + previous[0].length + start) / 2);
      const regionEnd = next === undefined ? clause.length : Math.ceil((end + next.index!) / 2);
      const contextRegion = clause.slice(
        previous === undefined ? 0 : previous.index! + previous[0].length,
        next === undefined ? clause.length : next.index!
      );
      const scoped = scopes.some((scope) => {
        const midpoint = scope.index! + scope[0].length / 2;
        return midpoint >= regionStart && midpoint < regionEnd;
      });
      if (scoped) continue;
      if (requireCoverageContext && !coverageMetricScoreLanguageContext(contextRegion)) continue;
      kinds.add(match[0].includes("%") ? "percentage" : "fraction");
    }
  }
  return [...kinds];
}

function coverageMetricScoreLanguageContext(value: string): boolean {
  const score = "(?:\\b(?:100(?:\\.0+)?|\\d{1,2}(?:\\.\\d+)?)\\s*%|\\b\\d+\\s*\\/\\s*\\d+\\b)";
  const coverageMetric = "(?:coverage|lcov|covg-eval|standardized[ \\t]+(?:measurement|rate|result|score))";
  const metricQualifier = "(?:branch|code|function|line|overall|range|source|standardized|test)";
  const metricLink = "(?::|=|at\\b|is\\b|measured\\b|of\\b|reached\\b|remained\\b|was\\b|stood[ \\t]+at\\b)?";
  return new RegExp(
    `(?:${coverageMetric}[ \\t]*(?:(?:measurement|percentage|rate|result|score)[ \\t]*)?${metricLink}[ \\t]*${score}|${score}[ \\t]*(?:${metricQualifier}[ \\t]+)?${coverageMetric})`,
    "iu"
  ).test(value);
}

function markdownSectionOccurrences(contents: string, heading: string): string[][] {
  const lines = contents.split(/\r?\n/u);
  let fenced = false;
  const headingIndexes: number[] = [];
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (/^(?:`{3,}|~{3,})/u.test(trimmed)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && trimmed === heading) {
      headingIndexes.push(index);
    }
  }
  return headingIndexes.map((headingIndex) => {
    fenced = false;
    const sectionLines: string[] = [];
    for (let index = headingIndex + 1; index < lines.length; index += 1) {
      const trimmed = lines[index]!.trim();
      if (/^(?:`{3,}|~{3,})/u.test(trimmed)) {
        fenced = !fenced;
        continue;
      }
      if (fenced) continue;
      if (trimmed.startsWith("## ")) break;
      sectionLines.push(trimmed);
    }
    return sectionLines;
  });
}

function unfencedMarkdownLines(contents: string): string[] {
  let fenced = false;
  return contents.split(/\r?\n/u).filter((line) => {
    const trimmed = line.trim();
    if (/^(?:`{3,}|~{3,})/u.test(trimmed)) {
      fenced = !fenced;
      return false;
    }
    return !fenced;
  });
}

function unscopedCoverageScoreDiagnosticsInJson(
  report: Record<string, unknown>,
  reportPath: string
): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  const visit = (value: unknown, jsonPath: string, directCoverageField: boolean): void => {
    if (typeof value === "string") {
      if (directCoverageField || coverageMetricLanguageContext(value)) {
        diagnostics.push(...unscopedCoverageScoreDiagnostics(value, `${reportPath}#${jsonPath}`, !directCoverageField));
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${jsonPath}[${index}]`, directCoverageField));
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      visit(entry, `${jsonPath}.${key}`, directCoverageField || coverageMetricFieldName(key));
    }
  };
  visit(report, "$", false);
  return diagnostics;
}

function coverageMetricLanguageContext(value: string): boolean {
  return /(?<![A-Za-z0-9_-])(?:coverage|lcov|selected-range|production-source)(?![A-Za-z0-9_-])|(?<![A-Za-z0-9_-])covg-eval(?![A-Za-z0-9_-])|\bstandardized\s+(?:measurement|rate|result|score)\b/iu.test(
    value
  );
}

function coverageMetricFieldName(key: string): boolean {
  return /^(?:coverage|coverage_(?:fraction|measurement|percentage|rate|result|score|summary)|lcov|standardized_coverage)$/iu.test(
    key
  );
}

/** Require the final report to preserve the current implementation selection. */
function verifyFinalReportImplementationCoverage(
  layout: RunLayout,
  artifactDir: string,
  node: PlannedGraphNode,
  report: Record<string, unknown>,
  reportPath: string,
  markdownPath: string,
  attemptAuthority?: ArtifactGateAttemptAuthority,
  authenticated?: AuthenticatedArtifactGateSnapshots
): RuntimeDiagnostic[] {
  if (
    plannedContractProducerStatus(layout, node, "ultrafuzz/implemented-properties@3", attemptAuthority) === "absent"
  ) {
    return isDeepStrictEqual(report.property_implementation_coverage, UNPLANNED_IMPLEMENTATION_COVERAGE)
      ? []
      : [
          {
            code: "PROPERTY_REPORT_IMPLEMENTATION_COVERAGE_MISMATCH",
            message:
              "A report without a planned property implementation producer must declare the exact not-planned coverage value",
            severity: "error",
            source: "property-provenance",
            path: `${reportPath}#$.property_implementation_coverage`
          }
        ];
  }
  const implementation = readImplementedProperties(layout, node, attemptAuthority);
  if (
    implementation.diagnostics.length > 0 ||
    implementation.value === undefined ||
    implementation.path === undefined
  ) {
    return implementation.diagnostics;
  }
  const implementationPath = implementation.path;
  if (implementation.value.selection === undefined) {
    return [
      {
        code: "PROPERTY_IMPLEMENTATION_SELECTION_MISSING",
        message: "Invariant implementation artifacts must declare selection metadata",
        severity: "error",
        source: "property-provenance",
        path: `${implementationPath}#$.selection`
      }
    ];
  }

  const catalog = readCanonicalPropertyCatalog(layout, node, attemptAuthority);
  if (catalog.diagnostics.length > 0 || catalog.value === undefined || catalog.path === undefined) {
    return catalog.diagnostics;
  }

  const catalogPath = catalog.path;
  const derived = derivePropertyImplementationCoverage(catalog.value, implementation.value, {
    configuredSelection: readConfiguredInvariantPrioritySelection(layout),
    requireConfiguredSelection: true,
    catalogPath,
    implementationPath,
    configPath: layout.resolvedConfigPath
  });
  const diagnostics: RuntimeDiagnostic[] = derived.issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    severity: "error",
    source: "property-provenance",
    path: issue.path
  }));
  const coverage = report.property_implementation_coverage;
  if (!isRecord(coverage)) {
    diagnostics.push({
      code: "PROPERTY_REPORT_IMPLEMENTATION_COVERAGE_MISSING",
      message: "Current invariant reports must include property_implementation_coverage",
      severity: "error",
      source: "property-provenance",
      path: `${reportPath}#$.property_implementation_coverage`
    });
  } else if (derived.value !== undefined) {
    const expectedFields: Record<string, readonly string[]> = {
      selected_property_ids: derived.value.selected_property_ids,
      implemented_property_ids: derived.value.implemented_property_ids,
      blocked_property_ids: derived.value.blocked_property_ids,
      pending_property_ids: derived.value.pending_property_ids,
      deferred_property_ids: derived.value.deferred_property_ids,
      reference_expected_property_ids: derived.value.reference_expected_property_ids,
      reference_expectation_ids: derived.value.reference_expectation_ids,
      blocker_summaries: derived.value.blocker_summaries
    };
    const mismatches: string[] = [];
    for (const field of ["reference_expected_property_ids", "reference_expectation_ids", "blocker_summaries"]) {
      if (!Array.isArray(coverage[field])) {
        mismatches.push(field);
      }
    }
    if (coverage.priority_threshold !== derived.value.priority_threshold) {
      mismatches.push("priority_threshold");
    }
    if (!sameStringSequence(stringArray(coverage.priorities), derived.value.priorities)) {
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

  const markdownBytes = readCurrentArtifactSnapshot(artifactDir, markdownPath, authenticated);
  if (markdownBytes !== undefined) {
    const markdown = markdownBytes.toString("utf8");
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
      // The Markdown must report the same blockers as the JSON. It must not
      // also require the author to reproduce reportPublicProse character for
      // character: that function redacts secrets and several relative path
      // prefixes, escapes eight Markdown characters, and HTML-escapes two
      // more, and no prose description of it has yet survived review. Accept
      // the escaped rendering or the summary text as written.
      const blockerMatches = (rendered: string | undefined, summary: string): boolean =>
        rendered === `- ${reportPublicProse(summary)}` || rendered === `- ${summary.replace(/\s+/gu, " ").trim()}`;
      if (
        renderedBlockers.length !== expectedBlockerSummaries.length ||
        expectedBlockerSummaries.some((summary, index) => !blockerMatches(renderedBlockers[index], summary))
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
  return diagnostics;
}

function reportPropertyJoinDiagnostics(
  entries: unknown[],
  catalog: PropertiesArtifact,
  implementation: ImplementedPropertiesArtifact,
  fuzzerBackendsByFinding: ReadonlyMap<string, readonly string[]>,
  campaignSourceNodeIds: ReadonlySet<string>,
  report: Record<string, unknown>,
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

    const campaignSourceFindingIds = reportCampaignSourceFindingIds(entry, report, campaignSourceNodeIds);
    const reportFindingId = typeof entry.finding_id === "string" ? entry.finding_id : undefined;
    const sourceFindingId = typeof entry.source_finding_id === "string" ? entry.source_finding_id : undefined;
    if (
      reportFindingId !== undefined &&
      campaignSourceFindingIds.length > 0 &&
      !campaignSourceFindingIds.includes(reportFindingId)
    ) {
      if (sourceFindingId === undefined) {
        addReportJoinMismatch(
          diagnostics,
          false,
          "PROPERTY_REPORT_SOURCE_FINDING_ID_REQUIRED",
          "Renumbered report property provenance must retain its authenticated campaign finding ID",
          `${reportPath}#$.property_provenance[${entryIndex}].source_finding_id`
        );
      } else if (!campaignSourceFindingIds.includes(sourceFindingId)) {
        addReportJoinMismatch(
          diagnostics,
          false,
          "PROPERTY_REPORT_SOURCE_FINDING_ID_MISMATCH",
          "Report property provenance source_finding_id does not match the authenticated campaign finding",
          `${reportPath}#$.property_provenance[${entryIndex}].source_finding_id`
        );
      }
    }

    const expectedBackends = verifiedReportFindingAliases(entry, report, campaignSourceNodeIds).flatMap(
      (findingId) => fuzzerBackendsByFinding.get(findingId) ?? []
    );
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

function verifiedReportFindingAliases(
  entry: Record<string, unknown>,
  report: Record<string, unknown>,
  campaignSourceNodeIds: ReadonlySet<string>
): string[] {
  const findingId = typeof entry.finding_id === "string" ? entry.finding_id : undefined;
  if (findingId === undefined) {
    return [];
  }
  const verifiedAliases = new Set([findingId]);
  const lifecycleFindingIds = new Set(reportCampaignSourceFindingIds(entry, report, campaignSourceNodeIds));
  const sourceFindingId = typeof entry.source_finding_id === "string" ? entry.source_finding_id : undefined;
  if (sourceFindingId !== undefined && lifecycleFindingIds.has(sourceFindingId)) {
    verifiedAliases.add(sourceFindingId);
  }
  return stringArray([entry.finding_id, entry.source_finding_id]).filter(
    (alias, index, aliases) => aliases.indexOf(alias) === index && verifiedAliases.has(alias)
  );
}

function reportCampaignSourceFindingIds(
  entry: Record<string, unknown>,
  report: Record<string, unknown>,
  campaignSourceNodeIds: ReadonlySet<string>
): string[] {
  const findingId = typeof entry.finding_id === "string" ? entry.finding_id : undefined;
  if (findingId === undefined) return [];
  const outcomes = [report.issues, report.non_production_outcomes].flatMap((entries) =>
    Array.isArray(entries) ? entries.filter(isRecord) : []
  );
  for (const outcome of outcomes) {
    if (
      outcome.id !== findingId ||
      !isRecord(outcome.lifecycle) ||
      !Array.isArray(outcome.lifecycle.source_artifacts)
    ) {
      continue;
    }
    return outcome.lifecycle.source_artifacts.flatMap((source) =>
      isRecord(source) &&
      typeof source.node_id === "string" &&
      campaignSourceNodeIds.has(source.node_id) &&
      source.relationship === "primary" &&
      typeof source.finding_id === "string"
        ? [source.finding_id]
        : []
    );
  }
  return [];
}

function readCampaignFuzzerBackends(
  layout: RunLayout,
  consumer: PlannedGraphNode,
  attemptAuthority?: ArtifactGateAttemptAuthority
): {
  value: ReadonlyMap<string, readonly string[]>;
  sourceNodeIds: ReadonlySet<string>;
  diagnostics: RuntimeDiagnostic[];
} {
  const campaigns: PropertyCampaignArtifact[] = [];
  const findings: Array<Record<string, unknown>> = [];
  const sourceNodeIds = new Set<string>();
  const diagnostics: RuntimeDiagnostic[] = [];
  let producers: FinalizedDeclaredProducer[];
  try {
    producers = finalizedDeclaredContractProducers(layout, "ultrafuzz/property-campaign@3", consumer, attemptAuthority);
  } catch (error) {
    return {
      value: new Map(),
      sourceNodeIds,
      diagnostics: [diagnosticFromError(error, "property-provenance", "PROPERTY_CAMPAIGN_AUTHORITY_INVALID")]
    };
  }
  for (const producer of producers) {
    sourceNodeIds.add(producer.node.logical_id);
    for (const artifact of producer.outputs) {
      const result = validatePropertyCampaignSchema(artifact.value, artifact.absolute_path);
      if (result.ok && result.value !== undefined) {
        campaigns.push(result.value);
      } else {
        diagnostics.push(...schemaDiagnostics(result.issues));
      }
    }
    const declaredFindingPaths = producer.node.outputs
      .filter((output) => output.contract === "ultrafuzz/findings@2")
      .map((output) => output.path);
    const findingArtifacts = producer.authority.outputs.filter((output) => output.contract === "ultrafuzz/findings@2");
    if (
      declaredFindingPaths.length !== 1 ||
      findingArtifacts.length !== 1 ||
      findingArtifacts[0]?.path !== declaredFindingPaths[0]
    ) {
      diagnostics.push({
        code: "PROPERTY_CAMPAIGN_FINDINGS_AUTHORITY_AMBIGUOUS",
        message: `Finalized campaign producer ${JSON.stringify(producer.node.id)} must declare and finalize the same one ultrafuzz/findings@2 output`,
        severity: "error",
        source: "property-provenance",
        path: layout.graphPath,
        details: {
          declared_paths: declaredFindingPaths,
          finalized_paths: findingArtifacts.map((artifact) => artifact.path)
        }
      });
      continue;
    }
    const findingArtifact = findingArtifacts[0]!;
    const result = validateFindingsSchema(findingArtifact.value, findingArtifact.absolute_path);
    if (result.ok && result.value !== undefined) {
      findings.push(...result.value);
    } else {
      diagnostics.push(...schemaDiagnostics(result.issues));
    }
  }
  return {
    value: resolveCampaignFindingBackends(campaigns, findings),
    sourceNodeIds,
    diagnostics
  };
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
  candidateFindingIds: ReadonlySet<string>,
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
  // A finding covers a failure when it claims every property that failure
  // exercised. Coverage is judged per finding, never against the union of all
  // findings: a counterexample that broke two invariants at once is a distinct
  // observation, and two single-property findings do not report it.
  const findingPropertySets = [...findingsById.entries()].flatMap(([findingId, matches]) =>
    candidateFindingIds.has(findingId) ? matches.map((match) => new Set(match.propertyIds)) : []
  );
  const isCovered = (failurePropertyIds: readonly string[]): boolean =>
    findingPropertySets.some((propertySet) => failurePropertyIds.every((propertyId) => propertySet.has(propertyId)));

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
      // A campaign legitimately deduplicates many counterexamples of the same
      // property into one finding, so a failure need not have a finding sharing
      // its ID. What it must have is a finding that claims everything it broke;
      // otherwise a violation was observed and then dropped.
      if (!isCovered(failurePropertyIds)) {
        // Name what is actually wrong. Saying "no finding covers property-1,
        // property-2" when property-1 is covered sends the retry after the
        // wrong artifact, and the node fails again the same way.
        const unclaimed = failurePropertyIds.filter(
          (propertyId) => !findingPropertySets.some((propertySet) => propertySet.has(propertyId))
        );
        const quoted = (propertyIds: readonly string[]): string =>
          propertyIds.map((propertyId) => JSON.stringify(propertyId)).join(", ");
        diagnostics.push({
          code: "PROPERTY_FINDING_REFERENCE_MISSING",
          message:
            unclaimed.length > 0
              ? `Property-derived campaign failure ${JSON.stringify(failure.id)} has no resulting finding covering ${quoted(unclaimed)}`
              : `Property-derived campaign failure ${JSON.stringify(failure.id)} broke ${quoted(failurePropertyIds)} together, and no single resulting finding claims that combination`,
          severity: "error",
          source: "property-provenance",
          path: `${campaignPath}#$.failures[${failureIndex}].id`
        });
      }
      continue;
    }
    // A deduplicated finding reuses one of its failures' IDs, so it may carry
    // more properties than that one failure did. It may never carry fewer:
    // dropping a property from the finding that anchors a failure loses the
    // violation just as surely as omitting the finding.
    const anchorCovers =
      matchingFinding !== undefined &&
      failurePropertyIds.every((propertyId) => matchingFinding.propertyIds.includes(propertyId));
    if (matchingFinding !== undefined && !anchorCovers) {
      diagnostics.push({
        code: "PROPERTY_FINDING_REFERENCE_MISMATCH",
        message: `Campaign failure ${JSON.stringify(failure.id)} has a resulting finding that drops some of its property_ids`,
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

/**
 * Reports findings that attribute a property no counterexample ever reported.
 * A deduplicated finding may carry more properties than the single failure whose
 * ID it reuses, so the failure-to-finding join cannot judge this; without a
 * separate check the campaign could invent a violation the fuzzer never
 * observed. Like the dangling check this is judged once against the union of
 * every campaign record in the node.
 */
function unobservedFindingPropertyDiagnostics(
  observedPropertyIds: ReadonlySet<string>,
  findings: Array<Record<string, unknown>>,
  findingsPath: string
): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  for (const [findingIndex, finding] of findings.entries()) {
    const propertyIds = Array.isArray(finding.property_ids)
      ? finding.property_ids.filter((propertyId): propertyId is string => typeof propertyId === "string")
      : [];
    const unobserved = propertyIds.filter((propertyId) => !observedPropertyIds.has(propertyId));
    if (unobserved.length === 0) {
      continue;
    }
    diagnostics.push({
      code: "PROPERTY_CAMPAIGN_PROPERTY_UNOBSERVED",
      message: `Finding ${JSON.stringify(finding.id)} claims ${unobserved.map((propertyId) => JSON.stringify(propertyId)).join(", ")}, which no campaign failure reported`,
      severity: "error",
      source: "property-provenance",
      path: `${findingsPath}#$[${findingIndex}].property_ids`
    });
  }
  return diagnostics;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const rightSet = new Set(right);
  return new Set(left).size === rightSet.size && left.every((value) => rightSet.has(value));
}

function readCanonicalPropertyCatalog(
  layout: RunLayout,
  consumer: PlannedGraphNode,
  attemptAuthority?: ArtifactGateAttemptAuthority
): {
  value?: PropertiesArtifact;
  path?: string;
  diagnostics: RuntimeDiagnostic[];
} {
  let pair: FinalizedCanonicalPropertyPair | undefined;
  try {
    pair = finalizedCanonicalPropertyPair(layout, consumer, attemptAuthority);
  } catch (error) {
    return {
      diagnostics: [diagnosticFromError(error, "property-provenance", "PROPERTY_CATALOG_AUTHORITY_INVALID")]
    };
  }
  if (pair === undefined) {
    if (plannedContractProducerStatus(layout, consumer, CANONICAL_PROPERTIES_CONTRACT, attemptAuthority) === "absent") {
      return { value: UNPLANNED_PROPERTY_CATALOG_CONTEXT, diagnostics: [] };
    }
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
  return { value: pair.value, path: pair.catalog.absolute_path, diagnostics: [] };
}

function readImplementedProperties(
  layout: RunLayout,
  consumer: PlannedGraphNode,
  attemptAuthority?: ArtifactGateAttemptAuthority
): {
  value?: ImplementedPropertiesArtifact;
  path?: string;
  diagnostics: RuntimeDiagnostic[];
} {
  let artifact: VerifiedOutputArtifactSnapshot | undefined;
  try {
    artifact = finalizedSingletonAncestorOutput(
      layout,
      consumer,
      "ultrafuzz/implemented-properties@3",
      "implemented property handoff",
      attemptAuthority
    );
  } catch (error) {
    return {
      diagnostics: [diagnosticFromError(error, "property-provenance", "IMPLEMENTED_PROPERTIES_AUTHORITY_INVALID")]
    };
  }
  if (artifact === undefined) {
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
  const result = validateImplementedPropertiesSchema(artifact.value, artifact.absolute_path);
  return result.ok && result.value !== undefined
    ? { value: result.value, path: artifact.absolute_path, diagnostics: [] }
    : { diagnostics: schemaDiagnostics(result.issues) };
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
  decision: Extract<DependencyGateDecision, { ok: false }>
): RunState {
  return updateNodeState(layout, node.id, {
    status: "skipped",
    finished_at: new Date().toISOString(),
    last_error: decision.reason,
    provenance: {
      reason_code: decision.reason_code,
      blocked_by: decision.blocked_by
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
