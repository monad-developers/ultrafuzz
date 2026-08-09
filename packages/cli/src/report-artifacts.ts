import fs from "node:fs";
import path from "node:path";

import {
  assertNoSymlinkComponents,
  assertRegularFileInside,
  safeResolveInside,
  validateArtifactContract,
  validateSafeId,
  type ArtifactContractId,
  type ArtifactContractIssue
} from "@ultrafuzz/artifacts";

export interface ValidatedReportArtifacts {
  markdown_path: string;
  json_path: string;
  source: "validated-agent-report";
}

const REPORT_CONTRACT = "ultrafuzz/report@2" as ArtifactContractId;
const MARKDOWN_CONTRACT = "ultrafuzz/nonempty-markdown@1" as ArtifactContractId;
const MAX_REPORT_JSON_BYTES = 64 * 1024 * 1024;
const MAX_REPORT_MARKDOWN_BYTES = 16 * 1024 * 1024;

/**
 * Locate and validate the agent-authored final report without rewriting it.
 *
 * Finalization owns publication. CLI readers must treat the published bytes as
 * immutable: malformed or missing report artifacts are errors, never inputs to
 * a renderer, normalizer, metadata merger, or manifest resealer.
 */
export function loadValidatedReportArtifacts(runRoot: string): ValidatedReportArtifacts {
  const root = path.resolve(runRoot);
  assertNoSymlinkComponents(root, root, "run root");
  const reportDirectory = findCurrentReportDirectory(root);
  const jsonPath = safeResolveInside(reportDirectory, "report.json", "report JSON path");
  const markdownPath = safeResolveInside(reportDirectory, "report.md", "report Markdown path");
  assertRegularFileInside(root, jsonPath, "report JSON path");
  assertRegularFileInside(root, markdownPath, "report Markdown path");

  const reportValidation = validateArtifactContract(
    REPORT_CONTRACT,
    readBoundedText(root, jsonPath, "report JSON", MAX_REPORT_JSON_BYTES),
    jsonPath
  );
  if (!reportValidation.ok) {
    throw new Error(validationMessage("report JSON", reportValidation.issues));
  }

  const markdownValidation = validateArtifactContract(
    MARKDOWN_CONTRACT,
    readBoundedText(root, markdownPath, "report Markdown", MAX_REPORT_MARKDOWN_BYTES),
    markdownPath
  );
  if (!markdownValidation.ok) {
    throw new Error(validationMessage("report Markdown", markdownValidation.issues));
  }

  return { markdown_path: markdownPath, json_path: jsonPath, source: "validated-agent-report" };
}

function findCurrentReportDirectory(runRoot: string): string {
  const artifactsRoot = safeResolveInside(runRoot, "artifacts", "report artifacts root");
  const candidates = new Set<string>(["final-report"]);
  const statePath = safeResolveInside(runRoot, "state.json", "run state path");
  if (fs.existsSync(statePath)) {
    assertRegularFileInside(runRoot, statePath, "run state path");
    const state = JSON.parse(readBoundedText(runRoot, statePath, "run state", 64 * 1024 * 1024)) as unknown;
    const nodes = recordField(state, "nodes");
    for (const [nodeId, nodeState] of Object.entries(nodes ?? {})) {
      if (recordFieldValue(nodeState, "logical_node_id") === "final-report") {
        candidates.add(validateSafeId(nodeId, "final report node ID"));
      }
    }
  }

  for (const nodeId of candidates) {
    const directory = safeResolveInside(artifactsRoot, nodeId, "final report directory");
    const jsonPath = safeResolveInside(directory, "report.json", "report JSON path");
    if (fs.existsSync(jsonPath)) {
      assertRegularFileInside(runRoot, jsonPath, "report JSON path");
      return directory;
    }
  }
  throw new Error("agent-written report JSON is not available for the current run");
}

function readBoundedText(runRoot: string, filePath: string, label: string, maximumBytes: number): string {
  assertRegularFileInside(runRoot, filePath, `${label} path`);
  const stat = fs.statSync(filePath);
  if (stat.size > maximumBytes) {
    throw new Error(`${label} exceeds the ${maximumBytes}-byte limit: ${filePath}`);
  }
  return fs.readFileSync(filePath, "utf8");
}

function validationMessage(label: string, issues: readonly ArtifactContractIssue[]): string {
  return `${label} failed contract validation: ${issues
    .map((issue) => `${issue.code} ${issue.path}: ${issue.message}`)
    .join("; ")}`;
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return field !== null && typeof field === "object" && !Array.isArray(field)
    ? (field as Record<string, unknown>)
    : undefined;
}

function recordFieldValue(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
