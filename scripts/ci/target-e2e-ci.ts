#!/usr/bin/env bun
/** Dependency-light command surface for the paid target repository smoke workflow. */
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

import {
  extractReportEvidence,
  loadTargetManifest,
  redactFile,
  targetField,
  writeTargetMetadata
} from "./target-e2e-lib.js";

const FAILED_STATUSES = new Set(["failed", "cancelled", "canceled", "timed_out", "timeout", "error"]);

type JsonObject = Record<string, unknown>;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadJson(path: string): JsonObject {
  const body: unknown = JSON.parse(readFileSync(path, "utf-8"));
  if (!isJsonObject(body)) {
    fail(`Expected JSON object in ${path}`);
  }
  return body;
}

function assertCliOk(path: string, label: string): void {
  const body = loadJson(path);
  if (body.ok !== true) {
    fail(`${label} returned ok=false: ${JSON.stringify(body.diagnostics ?? null, null, 2)}`);
  }
}

function assertInspectHealthy(path: string): void {
  const body = loadJson(path);
  const diagnostics = Array.isArray(body.diagnostics) ? body.diagnostics : [];
  const blocking = diagnostics.filter((diagnostic) => isJsonObject(diagnostic) && diagnostic.severity === "error");
  if (blocking.length > 0) {
    fail(`inspect reported blocking diagnostics: ${JSON.stringify(blocking, null, 2)}`);
  }

  const data = isJsonObject(body.data) ? body.data : {};
  const status = data.status;
  const workflow = isJsonObject(data.workflow) ? data.workflow : {};
  const workflowStatus = workflow.status;
  if (
    (typeof status === "string" && FAILED_STATUSES.has(status)) ||
    (typeof workflowStatus === "string" && FAILED_STATUSES.has(workflowStatus))
  ) {
    fail(
      `run is not healthy: status=${JSON.stringify(status ?? null)}, ` +
        `workflow_status=${JSON.stringify(workflowStatus ?? null)}`
    );
  }
}

function reportAccountingMismatches(envelope: JsonObject): JsonObject[] {
  const diagnostics = envelope.diagnostics;
  if (!Array.isArray(diagnostics)) {
    return [];
  }
  return diagnostics.filter(
    (diagnostic): diagnostic is JsonObject =>
      isJsonObject(diagnostic) && diagnostic.code === "REPORT_ACCOUNTING_MISMATCH"
  );
}

function formatThousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function labelField(value: JsonObject, keys: string[]): string | null {
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string") return field;
    if (typeof field === "number" && Number.isInteger(field)) return formatThousands(field);
  }
  return null;
}

function positiveIntegerLabel(value: string | null): boolean {
  if (value === null || value.trim().toLowerCase() === "unavailable") return false;
  const digits = value.replaceAll(",", "").trim();
  return /^\d+$/u.test(digits) && Number(digits) > 0;
}

function positiveUsdLabel(value: string | null): boolean {
  if (value === null || value.trim().toLowerCase() === "unavailable") return false;
  let normalized = value.trim();
  if (normalized.startsWith("$")) normalized = normalized.slice(1);
  if (normalized.endsWith("+")) normalized = normalized.slice(0, -1);
  const parsed = Number(normalized);
  return normalized !== "" && Number.isFinite(parsed) && parsed > 0;
}

function assertReportAccounting(envelopePath: string, targetName: string): void {
  const envelope = loadJson(envelopePath);
  const mismatches = reportAccountingMismatches(envelope);
  if (mismatches.length > 0) {
    fail(
      `${targetName} report command returned accounting mismatch diagnostics: ${JSON.stringify(mismatches, null, 2)}`
    );
  }

  const data = isJsonObject(envelope.data) ? envelope.data : {};
  const jsonPath = data.json_path;
  const markdownPath = data.markdown_path;
  if (typeof jsonPath !== "string" || typeof markdownPath !== "string") {
    fail("report command did not return both terminal report paths");
  }
  if (!existsSync(jsonPath) || !existsSync(markdownPath)) {
    fail("terminal report paths do not exist");
  }

  const report = loadJson(jsonPath);
  const runMetadata = isJsonObject(report.run_metadata) ? report.run_metadata : {};
  const tokensUsed = labelField(runMetadata, ["tokens_used", "tokensUsed", "token_usage", "tokenUsage"]);
  const estimatedSpend = labelField(runMetadata, [
    "estimated_spend",
    "estimatedSpend",
    "estimated_cost",
    "estimatedCost"
  ]);
  const partialPricing = runMetadata.partial_pricing === true || runMetadata.partialPricing === true;
  if (!positiveIntegerLabel(tokensUsed)) {
    fail(`${targetName} final report is missing positive token usage`);
  }
  const hasPositiveSpend = positiveUsdLabel(estimatedSpend);
  const hasHonestUnpricedSpend = estimatedSpend === "unavailable" && partialPricing;
  if (!hasPositiveSpend && !hasHonestUnpricedSpend) {
    fail(`${targetName} final report has invalid estimated spend accounting`);
  }

  const markdown = readFileSync(markdownPath, "utf-8");
  if (markdown.includes("Tokens used: unavailable") || !markdown.includes(tokensUsed as string)) {
    fail(`${targetName} report Markdown does not render token usage`);
  }
  if (
    (hasPositiveSpend &&
      (markdown.includes("Estimated spend: unavailable") || !markdown.includes(estimatedSpend as string))) ||
    (hasHonestUnpricedSpend && !markdown.includes("Estimated spend: unavailable"))
  ) {
    fail(`${targetName} report Markdown does not render estimated spend`);
  }
}

function requireArgs(rest: string[], names: string[], command: string): string[] {
  if (rest.length !== names.length) {
    fail(`usage: target-e2e-ci.ts ${command} ${names.map((name) => `<${name}>`).join(" ")}`);
  }
  return rest;
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  switch (command) {
    case "redact": {
      const [path] = requireArgs(rest, ["path"], command);
      redactFile(path as string);
      return 0;
    }
    case "assert-cli-ok": {
      const [path, label] = requireArgs(rest, ["path", "label"], command);
      assertCliOk(path as string, label as string);
      return 0;
    }
    case "assert-inspect-healthy": {
      const [path] = requireArgs(rest, ["path"], command);
      assertInspectHealthy(path as string);
      return 0;
    }
    case "validate-manifest": {
      const [manifestPath] = requireArgs(rest, ["manifest_path"], command);
      loadTargetManifest(manifestPath as string);
      return 0;
    }
    case "target-field": {
      const [manifestPath, id, field] = requireArgs(rest, ["manifest_path", "target_id", "field"], command);
      process.stdout.write(targetField(manifestPath as string, id as string, field as string));
      return 0;
    }
    case "write-target-metadata": {
      const [manifestPath, id, outputPath, revision] = requireArgs(
        rest,
        ["manifest_path", "target_id", "output_path", "checked_out_revision"],
        command
      );
      writeTargetMetadata(manifestPath as string, id as string, outputPath as string, revision as string);
      return 0;
    }
    case "extract-evidence": {
      const [envelopePath, evidenceRoot] = requireArgs(rest, ["envelope_path", "evidence_root"], command);
      extractReportEvidence(envelopePath as string, evidenceRoot as string);
      return 0;
    }
    case "assert-report-accounting": {
      const [envelopePath, targetName] = requireArgs(rest, ["envelope_path", "target_name"], command);
      assertReportAccounting(envelopePath as string, targetName as string);
      return 0;
    }
    default:
      fail(
        "usage: target-e2e-ci.ts <redact|assert-cli-ok|assert-inspect-healthy|validate-manifest|target-field|" +
          "write-target-metadata|extract-evidence|assert-report-accounting> [args...]"
      );
  }
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
