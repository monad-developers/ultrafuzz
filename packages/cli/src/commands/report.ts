import path from "node:path";

import { Args, Command, Flags } from "@oclif/core";
import {
  assertNoSymlinkComponents,
  assertPathInside,
  assertRunMetadataDocument,
  ESTIMATED_SPEND_PATTERN,
  layoutForRunRoot,
  readRunMetadataDocument,
  validateSafeId,
  type RunMetadataDocument
} from "@ultrafuzz/artifacts";
import { runsRootForProject, type RuntimeDiagnostic } from "@ultrafuzz/runtime";

import { commandFailure, diagnosticsText, emitCommandResult, globalFlags, projectRoot } from "../command-shared.js";
import { loadReportArtifactsSnapshot, type ReportArtifactsSnapshot } from "../report-artifacts.js";

type AccountingField = "tokens_used" | "estimated_spend";

interface ExpectedAccounting {
  /** `accounting.cumulative.tokens_used`, when it is available. */
  tokens_used?: string;
  /** `spend_estimate.estimated_spend`, when run.json has a spend estimate. */
  estimated_spend?: string;
}

/**
 * Whether the presented report is a runtime presentation, which restates the spend from run.json,
 * rather than the agent's report-start snapshot.
 */
type ReportPresentation = "runtime" | "agent";

export default class Report extends Command {
  static override summary = "Show the available report for a run";
  static override args = { runId: Args.string({ required: true, description: "Ultrafuzz run ID" }) };
  static override flags = {
    ...globalFlags,
    "require-verified": Flags.boolean({ summary: "Require the report to match verified run records" })
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Report);
    const root = projectRoot(flags);
    try {
      const runsRoot = await runsRootForProject(root);
      const runId = validateSafeId(args.runId, "run ID");
      const layout = layoutForRunRoot(path.join(runsRoot, runId), runId);
      assertPathInside(runsRoot, layout.root, "run root");
      assertNoSymlinkComponents(runsRoot, layout.root, "run root");
      const loaded = loadReportArtifactsSnapshot(layout.root, { requireVerified: flags["require-verified"] });
      const completion = loaded.completion?.outcome ?? loaded.observed_completion?.outcome;
      const validationDiagnostics = loaded.validation_warnings.map((warning): RuntimeDiagnostic => ({
        code: warning.code,
        severity: "warning",
        source: "artifact-validation",
        message: `${warning.message} at ${warning.artifact_path}#${warning.field_path}${
          warning.source_path === undefined ? "" : `; available context: ${warning.source_path}`
        }`,
        path: `${warning.artifact_path}#${warning.field_path}`,
        details: {
          gate: warning.gate,
          ...(warning.source_path === undefined ? {} : { source_path: warning.source_path })
        }
      }));
      const diagnostics: RuntimeDiagnostic[] = [
        ...reportAccountingDiagnostics(layout.root, loaded, flags["require-verified"]),
        ...validationDiagnostics
      ];
      emitCommandResult(
        this,
        "report",
        {
          ok: true,
          command: "report",
          data: {
            ...loaded.artifacts,
            verification: loaded.verification,
            ...(completion === undefined ? {} : { completion }),
            terminal: loaded.terminal
          },
          text: `Report: ${loaded.artifacts.markdown_path}\nJSON: ${loaded.artifacts.json_path}\n${
            completion === undefined ? "" : `Completion: ${completion}\n`
          }Verification: ${loaded.verification}\n${diagnosticsText(diagnostics)}`,
          diagnostics
        },
        flags.json === true
      );
    } catch (error) {
      emitCommandResult(
        this,
        "report",
        commandFailure("report", error instanceof Error ? error.message : String(error), "REPORT_FAILED"),
        flags.json === true
      );
    }
  }
}

/**
 * Warnings for a report whose `Tokens used` or `Estimated spend` does not preserve the run's
 * accounting: tokens against run.json `accounting.cumulative`, spend against
 * `spend_estimate.estimated_spend`.
 */
export function reportAccountingDiagnostics(
  runRoot: string,
  report: ReportArtifactsSnapshot,
  requireVerified: boolean
): RuntimeDiagnostic[] {
  const presentation: ReportPresentation = report.artifacts.source === "verified-agent-report" ? "agent" : "runtime";
  const metadataPath = path.join(runRoot, "run.json");
  let expected: ExpectedAccounting | undefined;
  try {
    expected = expectedAccountingFromRunMetadata(runMetadataForPresentation(metadataPath, report, presentation));
  } catch (error) {
    if (requireVerified) throw error;
    return [
      {
        code: "REPORT_ACCOUNTING_UNAVAILABLE",
        message: `Report accounting could not be checked: ${error instanceof Error ? error.message : String(error)}`,
        severity: "warning",
        source: "report",
        path: metadataPath
      }
    ];
  }
  if (expected === undefined) {
    return [];
  }

  const diagnostics: RuntimeDiagnostic[] = [];
  diagnostics.push(
    ...markdownAccountingDiagnostics(report.markdown, expected, presentation, report.artifacts.markdown_path),
    ...reportJsonAccountingDiagnostics(report.json, expected, presentation, report.artifacts.json_path)
  );
  return diagnostics;
}

/**
 * The run.json the report is checked against. A runtime presentation must equal the spend estimate
 * it restated, so it is checked against the run.json it was built from rather than a second read
 * that a synchronization may have rewritten since. The agent's snapshot depends on no run.json, and
 * its checks hold against a later one (tokens only grow, and its spend has no bound), so it is
 * checked against the current file.
 */
function runMetadataForPresentation(
  metadataPath: string,
  report: ReportArtifactsSnapshot,
  presentation: ReportPresentation
): RunMetadataDocument {
  const runId = path.basename(path.dirname(metadataPath));
  if (presentation === "agent") {
    return readRunMetadataDocument(metadataPath, runId);
  }
  if (report.restated_run_metadata === undefined) {
    throw new Error("run.json could not be read when the report was presented");
  }
  return assertRunMetadataDocument(report.restated_run_metadata, runId);
}

function expectedAccountingFromRunMetadata(metadata: RunMetadataDocument): ExpectedAccounting | undefined {
  const tokensUsed = metadata.accounting?.cumulative.tokens_used;
  const estimatedSpend = metadata.spend_estimate?.estimated_spend;
  const expected = {
    ...(isAvailableLabel(tokensUsed) ? { tokens_used: tokensUsed } : {}),
    ...(estimatedSpend === undefined ? {} : { estimated_spend: estimatedSpend })
  };
  return expected.tokens_used === undefined && expected.estimated_spend === undefined ? undefined : expected;
}

function markdownAccountingDiagnostics(
  markdown: string,
  expected: ExpectedAccounting,
  presentation: ReportPresentation,
  markdownPath: string
): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  diagnostics.push(
    ...accountingValueDiagnostics({
      field: "tokens_used",
      actual: markdownLabel(markdown, "Tokens used", "tokens_used"),
      expected: expected.tokens_used,
      presentation,
      filePath: markdownPath,
      artifact: "markdown"
    })
  );
  diagnostics.push(
    ...accountingValueDiagnostics({
      field: "estimated_spend",
      actual: markdownLabel(markdown, "Estimated spend", "estimated_spend"),
      expected: expected.estimated_spend,
      presentation,
      filePath: markdownPath,
      artifact: "markdown"
    })
  );
  return diagnostics;
}

function reportJsonAccountingDiagnostics(
  reportJson: unknown,
  expected: ExpectedAccounting,
  presentation: ReportPresentation,
  jsonPath: string
): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  const runMetadata = recordField(reportJson, "run_metadata");
  if (runMetadata === undefined) {
    diagnostics.push({
      code: "REPORT_RUN_METADATA_MISSING",
      message: "report.json is missing run_metadata despite populated accounting in run metadata",
      severity: "warning",
      source: "report",
      path: jsonPath
    });
    return diagnostics;
  }
  diagnostics.push(
    ...accountingValueDiagnostics({
      field: "tokens_used",
      actual: tokensField(runMetadata),
      expected: expected.tokens_used,
      presentation,
      filePath: jsonPath,
      artifact: "json"
    })
  );
  const spend = runMetadata.estimated_spend;
  diagnostics.push(
    ...accountingValueDiagnostics({
      field: "estimated_spend",
      actual: typeof spend === "string" ? spend : undefined,
      expected: expected.estimated_spend,
      presentation,
      filePath: jsonPath,
      artifact: "json"
    })
  );
  return diagnostics;
}

function accountingValueDiagnostics(input: {
  field: AccountingField;
  actual: string | undefined;
  expected: string | undefined;
  presentation: ReportPresentation;
  filePath: string;
  artifact: "markdown" | "json";
}): RuntimeDiagnostic[] {
  if (input.expected === undefined) {
    return [];
  }
  const reason =
    input.field === "tokens_used"
      ? tokensValueProblem(input.actual, input.expected)
      : spendValueProblem(input.actual, input.expected, input.presentation);
  if (reason === undefined) {
    return [];
  }
  // The agent's snapshot is never expected to equal the run's current spend estimate.
  const expected = input.field === "estimated_spend" && input.presentation === "agent" ? undefined : input.expected;
  return [accountingDiagnostic(input.field, expected, input.filePath, input.artifact, input.actual, reason)];
}

function tokensValueProblem(actual: string | undefined, expected: string): string | undefined {
  if (!isAvailableLabel(actual)) {
    return "missing or unavailable";
  }
  const actualTokens = parseIntegerLabel(actual);
  const expectedTokens = parseIntegerLabel(expected);
  if (actualTokens === undefined || actualTokens <= 0) {
    return "not a positive integer";
  }
  if (expectedTokens !== undefined && actualTokens > expectedTokens) {
    return "greater than current run metadata";
  }
  return undefined;
}

/**
 * The spend is an estimate that can fall as well as rise (a catalog price can replace a fallback
 * rate), so the agent's report-start snapshot needs only the numeric form, while a runtime
 * presentation restates run.json's estimate and must equal it.
 */
function spendValueProblem(
  actual: string | undefined,
  expected: string,
  presentation: ReportPresentation
): string | undefined {
  if (!isAvailableLabel(actual)) {
    return "missing or unavailable";
  }
  if (!ESTIMATED_SPEND_PATTERN.test(actual)) {
    return "not a numeric USD estimate";
  }
  if (presentation === "runtime" && actual !== expected) {
    return "differs from the run.json spend estimate";
  }
  return undefined;
}

function accountingDiagnostic(
  field: AccountingField,
  expected: string | undefined,
  filePath: string,
  artifact: "markdown" | "json",
  actual: string | undefined,
  reason: string
): RuntimeDiagnostic {
  const got = `got ${actual ?? "missing"} (${reason})`;
  return {
    code: "REPORT_ACCOUNTING_MISMATCH",
    message:
      expected === undefined
        ? `${artifact} final report has no usable ${field}; ${got}`
        : `${artifact} final report did not preserve usable ${field} from run metadata; expected ${expected}, ${got}`,
    severity: "warning",
    source: "report",
    path: filePath,
    details: {
      field,
      ...(expected === undefined ? {} : { expected }),
      ...(actual === undefined ? {} : { actual }),
      reason
    }
  };
}

function markdownLabel(markdown: string, label: string, field: AccountingField): string | undefined {
  const match = markdown.match(
    new RegExp(`^\\s*(?:[-*+]\\s*)?(?:\\*\\*)?${escapeRegExp(label)}(?:\\*\\*)?\\s*:\\s*(.+)$`, "imu")
  );
  return match?.[1] === undefined ? undefined : firstAccountingLabel(match[1], field);
}

/**
 * The value of a Run summary label: its first code span, else a leading token count (or
 * `unavailable`) for tokens and the leading word for spend, which `ESTIMATED_SPEND_PATTERN` then
 * classifies, so an inline `$0.46+` is reported as not numeric rather than missing.
 */
function firstAccountingLabel(value: string, field: AccountingField): string | undefined {
  const trimmed = value.trim();
  const code = trimmed.match(/`([^`]+)`/u);
  if (code?.[1] !== undefined) {
    return code[1].trim();
  }
  const inline =
    field === "tokens_used" ? trimmed.match(/^\$?\d[\d,]*(?:\.\d+)?\+?|^unavailable\b/iu) : trimmed.match(/^\S+/u);
  return inline?.[0];
}

function isAvailableLabel(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0 && value.trim().toLowerCase() !== "unavailable";
}

function tokensField(value: Record<string, unknown>): string | undefined {
  const field = value.tokens_used;
  if (typeof field === "string") {
    return field;
  }
  return typeof field === "number" && Number.isFinite(field) ? formatInteger(field) : undefined;
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return field && typeof field === "object" && !Array.isArray(field) ? (field as Record<string, unknown>) : undefined;
}

function formatInteger(value: number): string {
  return Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

function parseIntegerLabel(value: string): number | undefined {
  const normalized = value.trim().replace(/,/gu, "");
  return /^\d+$/u.test(normalized) ? Number(normalized) : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
