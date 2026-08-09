import fs from "node:fs";
import path from "node:path";

import {
  assertNoSymlinkComponents,
  assertRegularFileInside,
  layoutForRunRoot,
  readRegularFileSnapshot,
  readRunState,
  safeResolveInside,
  validateArtifactContractBytes,
  validateSafeId,
  type ArtifactContractId,
  type ArtifactContractIssue
} from "@ultrafuzz/artifacts";

export interface ValidatedReportArtifacts {
  markdown_path: string;
  json_path: string;
  source: "validated-agent-report";
}

export interface ValidatedReportSnapshot {
  artifacts: ValidatedReportArtifacts;
  json: unknown;
  json_bytes: Buffer;
  markdown: string;
  markdown_bytes: Buffer;
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
  return loadValidatedReportSnapshot(runRoot).artifacts;
}

export function loadValidatedReportSnapshot(runRoot: string): ValidatedReportSnapshot {
  const root = path.resolve(runRoot);
  assertNoSymlinkComponents(root, root, "run root");
  const reportDirectory = findCurrentReportDirectory(root);
  const jsonPath = safeResolveInside(reportDirectory, "report.json", "report JSON path");
  const markdownPath = safeResolveInside(reportDirectory, "report.md", "report Markdown path");
  assertRegularFileInside(root, jsonPath, "report JSON path");
  assertRegularFileInside(root, markdownPath, "report Markdown path");

  const reportBytes = readBoundedBytes(root, jsonPath, "report JSON", MAX_REPORT_JSON_BYTES);
  const markdownBytes = readBoundedBytes(root, markdownPath, "report Markdown", MAX_REPORT_MARKDOWN_BYTES);
  const reportValidation = validateArtifactContractBytes(REPORT_CONTRACT, reportBytes, jsonPath);
  if (!reportValidation.ok) {
    throw new Error(validationMessage("report JSON", reportValidation.issues));
  }

  const markdownValidation = validateArtifactContractBytes(MARKDOWN_CONTRACT, markdownBytes, markdownPath);
  if (!markdownValidation.ok) {
    throw new Error(validationMessage("report Markdown", markdownValidation.issues));
  }

  if (typeof markdownValidation.value !== "string") {
    throw new Error("report Markdown validation did not return its immutable text snapshot");
  }
  return {
    artifacts: { markdown_path: markdownPath, json_path: jsonPath, source: "validated-agent-report" },
    json: reportValidation.value,
    json_bytes: reportBytes,
    markdown: markdownValidation.value,
    markdown_bytes: markdownBytes
  };
}

function findCurrentReportDirectory(runRoot: string): string {
  const artifactsRoot = safeResolveInside(runRoot, "artifacts", "report artifacts root");
  const candidates = new Set<string>(["final-report"]);
  const state = readRunState(layoutForRunRoot(runRoot));
  for (const [nodeId, nodeState] of Object.entries(state.nodes)) {
    if (nodeState.logical_node_id === "final-report") {
      candidates.add(validateSafeId(nodeId, "final report node ID"));
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

function readBoundedBytes(runRoot: string, filePath: string, label: string, maximumBytes: number): Buffer {
  assertRegularFileInside(runRoot, filePath, `${label} path`);
  return readRegularFileSnapshot(filePath, maximumBytes);
}

function validationMessage(label: string, issues: readonly ArtifactContractIssue[]): string {
  return `${label} failed contract validation: ${issues
    .map((issue) => `${issue.code} ${issue.path}: ${issue.message}`)
    .join("; ")}`;
}
