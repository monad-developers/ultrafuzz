import path from "node:path";

import { Args, Command } from "@oclif/core";
import {
  assertNoSymlinkComponents,
  assertPathInside,
  layoutForRunRoot,
  readRunMetadataDocument,
  validateSafeId
} from "@ultrafuzz/artifacts";
import { runsRootForProject, type RuntimeDiagnostic } from "@ultrafuzz/runtime";

import { commandFailure, diagnosticsText, emitCommandResult, globalFlags, projectRoot } from "../command-shared.js";
import { loadValidatedReportSnapshot, type ValidatedReportSnapshot } from "../report-artifacts.js";

type AccountingField = "tokens_used" | "estimated_spend";

interface ExpectedAccounting {
  tokens_used?: string;
  estimated_spend?: string;
  partial_pricing?: boolean;
}

export default class Report extends Command {
  static override summary = "Show the agent-written final report for a run";
  static override args = { runId: Args.string({ required: true, description: "Ultrafuzz run ID" }) };
  static override flags = globalFlags;

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Report);
    const root = projectRoot(flags);
    try {
      const runsRoot = await runsRootForProject(root);
      const runId = validateSafeId(args.runId, "run ID");
      const layout = layoutForRunRoot(path.join(runsRoot, runId), runId);
      assertPathInside(runsRoot, layout.root, "run root");
      assertNoSymlinkComponents(runsRoot, layout.root, "run root");
      const loaded = loadValidatedReportSnapshot(layout.root);
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
        ...reportAccountingDiagnostics(layout.root, loaded),
        ...validationDiagnostics
      ];
      emitCommandResult(
        this,
        "report",
        {
          ok: true,
          command: "report",
          data: loaded.artifacts,
          text: `Report: ${loaded.artifacts.markdown_path}\nJSON: ${loaded.artifacts.json_path}\n${diagnosticsText(validationDiagnostics)}`,
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

function reportAccountingDiagnostics(runRoot: string, report: ValidatedReportSnapshot): RuntimeDiagnostic[] {
  const expected = expectedAccountingFromRunMetadata(path.join(runRoot, "run.json"));
  if (expected === undefined) {
    return [];
  }

  const diagnostics: RuntimeDiagnostic[] = [];
  diagnostics.push(
    ...markdownAccountingDiagnostics(report.markdown, expected, report.artifacts.markdown_path),
    ...reportJsonAccountingDiagnostics(report.json, expected, report.artifacts.json_path)
  );
  return diagnostics;
}

function expectedAccountingFromRunMetadata(metadataPath: string): ExpectedAccounting | undefined {
  const metadata = readRunMetadataDocument(metadataPath, path.basename(path.dirname(metadataPath)));
  const cumulative = metadata.accounting?.cumulative;
  if (cumulative === undefined) return undefined;
  const tokensUsed = cumulative.tokens_used;
  const estimatedSpend = cumulative.estimated_spend;
  const partialPricing = cumulative.partial_pricing;
  const expected = {
    ...(isAvailableLabel(tokensUsed) ? { tokens_used: tokensUsed } : {}),
    ...(isAvailableLabel(estimatedSpend) ? { estimated_spend: estimatedSpend } : {}),
    partial_pricing: partialPricing
  };
  return expected.tokens_used === undefined && expected.estimated_spend === undefined ? undefined : expected;
}

function markdownAccountingDiagnostics(
  markdown: string,
  expected: ExpectedAccounting,
  markdownPath: string
): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  diagnostics.push(
    ...accountingValueDiagnostics({
      field: "tokens_used",
      actual: markdownLabel(markdown, "Tokens used"),
      expected: expected.tokens_used,
      expectedPartialPricing: false,
      filePath: markdownPath,
      artifact: "markdown"
    })
  );
  diagnostics.push(
    ...accountingValueDiagnostics({
      field: "estimated_spend",
      actual: markdownLabel(markdown, "Estimated spend"),
      expected: expected.estimated_spend,
      expectedPartialPricing: expected.partial_pricing === true,
      filePath: markdownPath,
      artifact: "markdown"
    })
  );
  return diagnostics;
}

function reportJsonAccountingDiagnostics(
  reportJson: unknown,
  expected: ExpectedAccounting,
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
      actual: labelField(runMetadata, "tokens_used", "integer"),
      expected: expected.tokens_used,
      expectedPartialPricing: false,
      filePath: jsonPath,
      artifact: "json"
    })
  );
  diagnostics.push(
    ...accountingValueDiagnostics({
      field: "estimated_spend",
      actual: labelField(runMetadata, "estimated_spend", "usd"),
      expected: expected.estimated_spend,
      expectedPartialPricing: expected.partial_pricing === true,
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
  expectedPartialPricing: boolean;
  filePath: string;
  artifact: "markdown" | "json";
}): RuntimeDiagnostic[] {
  if (input.expected === undefined) {
    return [];
  }
  const reason = accountingValueProblem(input.field, input.actual, input.expected, input.expectedPartialPricing);
  return reason === undefined
    ? []
    : [accountingDiagnostic(input.field, input.expected, input.filePath, input.artifact, input.actual, reason)];
}

function accountingValueProblem(
  field: AccountingField,
  actual: string | undefined,
  expected: string,
  expectedPartialPricing: boolean
): string | undefined {
  if (!isAvailableLabel(actual)) {
    return "missing or unavailable";
  }
  if (field === "tokens_used") {
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

  const actualSpend = parseUsdLabel(actual);
  const expectedSpend = parseUsdLabel(expected);
  if (actualSpend === undefined || actualSpend <= 0) {
    return "not a positive USD amount";
  }
  if ((expectedPartialPricing || hasPartialPricingSuffix(expected)) && !hasPartialPricingSuffix(actual)) {
    return "missing partial-pricing + suffix";
  }
  if (expectedSpend !== undefined && actualSpend > expectedSpend + 0.000001) {
    return "greater than current run metadata";
  }
  return undefined;
}

function accountingDiagnostic(
  field: AccountingField,
  expected: string,
  filePath: string,
  artifact: "markdown" | "json",
  actual: string | undefined,
  reason: string
): RuntimeDiagnostic {
  return {
    code: "REPORT_ACCOUNTING_MISMATCH",
    message: `${artifact} final report did not preserve usable ${field} from run metadata; expected ${expected}, got ${
      actual ?? "missing"
    } (${reason})`,
    severity: "warning",
    source: "report",
    path: filePath,
    details: { field, expected, ...(actual === undefined ? {} : { actual }), reason }
  };
}

function markdownLabel(markdown: string, label: string): string | undefined {
  const match = markdown.match(
    new RegExp(`^\\s*(?:[-*+]\\s*)?(?:\\*\\*)?${escapeRegExp(label)}(?:\\*\\*)?\\s*:\\s*(.+)$`, "imu")
  );
  return match?.[1] === undefined ? undefined : firstAccountingLabel(match[1]);
}

function firstAccountingLabel(value: string): string | undefined {
  const trimmed = value.trim();
  const code = trimmed.match(/`([^`]+)`/u);
  if (code?.[1] !== undefined) {
    return code[1].trim();
  }
  const inline = trimmed.match(/^\$?\d[\d,]*(?:\.\d+)?\+?|^unavailable\b/iu);
  return inline?.[0];
}

function isAvailableLabel(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0 && value.trim().toLowerCase() !== "unavailable";
}

function labelField(
  value: Record<string, unknown> | undefined,
  key: string,
  numericFormat: "integer" | "usd"
): string | undefined {
  const field = value?.[key];
  if (typeof field === "string") {
    return field;
  }
  return typeof field === "number" && Number.isFinite(field)
    ? numericFormat === "usd"
      ? formatUsd(field)
      : formatInteger(field)
    : undefined;
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

function formatUsd(value: number): string {
  return `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`;
}

function parseIntegerLabel(value: string): number | undefined {
  const normalized = value.trim().replace(/,/gu, "");
  return /^\d+$/u.test(normalized) ? Number(normalized) : undefined;
}

function parseUsdLabel(value: string): number | undefined {
  const normalized = value.trim().replace(/,/gu, "").replace(/^\$/u, "").replace(/\+$/u, "");
  if (!/^\d+(?:\.\d+)?$/u.test(normalized)) {
    return undefined;
  }
  return Number(normalized);
}

function hasPartialPricingSuffix(value: string): boolean {
  return value.trim().endsWith("+");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
