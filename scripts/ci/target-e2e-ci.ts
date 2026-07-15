#!/usr/bin/env bun
/**
 * Target E2E CI helper commands.
 *
 * Runs under Bun (which executes TypeScript directly); only Node.js built-ins
 * are used so the script stays dependency-free.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

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

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function redact(path: string): void {
  const secret = process.env.OPENAI_API_KEY ?? "";
  if (secret === "" || !existsSync(path)) {
    return;
  }
  const body = readFileSync(path, "latin1");
  writeFileSync(path, body.split(secret).join("[REDACTED_OPENAI_API_KEY]"), "latin1");
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

function writeTargetMetadata(
  path: string,
  targetName: string,
  targetRepository: string,
  signalProfile: string,
  expectedFindings: string
): void {
  writeJson(path, {
    schema_version: "1.0",
    target_name: targetName,
    target_repository: targetRepository,
    signal_profile: signalProfile,
    expected_findings: expectedFindings
  });
}

function copyReportJson(envelopePath: string, outputPath: string): void {
  const envelope = loadJson(envelopePath);
  const data = isJsonObject(envelope.data) ? envelope.data : {};
  const jsonPath = data.json_path;
  if (typeof jsonPath !== "string") {
    fail("report command did not return data.json_path");
  }
  if (!existsSync(jsonPath)) {
    fail(`report JSON does not exist: ${jsonPath}`);
  }
  const report: unknown = JSON.parse(readFileSync(jsonPath, "utf-8"));
  writeJson(outputPath, report);
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
    if (typeof field === "string") {
      return field;
    }
    if (typeof field === "number" && Number.isInteger(field)) {
      return formatThousands(field);
    }
  }
  return null;
}

function positiveIntegerLabel(value: string | null): boolean {
  if (value === null || value.trim().toLowerCase() === "unavailable") {
    return false;
  }
  const digits = value.replaceAll(",", "").trim();
  return /^\d+$/.test(digits) && Number(digits) > 0;
}

function positiveUsdLabel(value: string | null): boolean {
  if (value === null || value.trim().toLowerCase() === "unavailable") {
    return false;
  }
  let normalized = value.trim();
  if (normalized.startsWith("$")) {
    normalized = normalized.slice(1);
  }
  if (normalized.endsWith("+")) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized.trim() === "") {
    return false;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0;
}

function assertReportAccounting(envelopePath: string, targetName: string, signalProfile: string): void {
  const envelope = loadJson(envelopePath);
  const mismatches = reportAccountingMismatches(envelope);
  if (mismatches.length > 0) {
    fail(
      `${targetName} (${signalProfile}) report command returned accounting mismatch diagnostics: ` +
        JSON.stringify(mismatches, null, 2)
    );
  }

  const data = isJsonObject(envelope.data) ? envelope.data : {};
  const jsonPath = data.json_path;
  const markdownPath = data.markdown_path;
  if (typeof jsonPath !== "string") {
    fail("report command did not return data.json_path");
  }
  if (typeof markdownPath !== "string") {
    fail("report command did not return data.markdown_path");
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
    fail(
      `${targetName} (${signalProfile}) final report is missing positive token usage: ${JSON.stringify(tokensUsed)}`
    );
  }
  const hasPositiveSpend = positiveUsdLabel(estimatedSpend);
  const hasHonestUnpricedSpend = estimatedSpend === "unavailable" && partialPricing;
  if (!hasPositiveSpend && !hasHonestUnpricedSpend) {
    fail(
      `${targetName} (${signalProfile}) final report has invalid estimated spend accounting: ` +
        JSON.stringify(estimatedSpend)
    );
  }

  const markdown = readFileSync(markdownPath, "utf-8");
  if (markdown.includes("Tokens used: unavailable") || !markdown.includes(tokensUsed as string)) {
    fail(`${targetName} (${signalProfile}) report.md does not render token usage ${JSON.stringify(tokensUsed)}`);
  }
  if (
    (hasPositiveSpend &&
      (markdown.includes("Estimated spend: unavailable") || !markdown.includes(estimatedSpend as string))) ||
    (hasHonestUnpricedSpend && !markdown.includes("Estimated spend: unavailable"))
  ) {
    fail(
      `${targetName} (${signalProfile}) report.md does not render estimated spend ${JSON.stringify(estimatedSpend)}`
    );
  }

  console.log(
    `Accounting assertion passed for ${targetName} (${signalProfile}): ` +
      `tokens=${tokensUsed}, estimated_spend=${estimatedSpend}, partial_pricing=${partialPricing}`
  );
}

function assertReportFindings(reportPath: string, expected: string, targetName: string, signalProfile: string): void {
  const report = loadJson(reportPath);
  if (!report.schema_version) {
    fail("Final report JSON is missing schema_version");
  }
  const issues = report.issues;
  if (!Array.isArray(issues)) {
    fail("Final report JSON must contain an issues array");
  }
  const findings = report.findings;
  if (!Array.isArray(findings)) {
    fail("Final report JSON must contain a findings array");
  }
  if (findings.length !== issues.length) {
    fail("Final report JSON issues and findings arrays must have matching counts");
  }
  const count = issues.length;
  if (expected === "eq:0" && count !== 0) {
    fail(`${targetName} (${signalProfile}) expected exactly 0 findings, got ${count}`);
  }
  if (expected === "gt:0" && count <= 0) {
    fail(`${targetName} (${signalProfile}) expected more than 0 findings, got ${count}`);
  }
  if (!["any", "eq:0", "gt:0"].includes(expected)) {
    fail(`Unsupported expected findings expression: ${JSON.stringify(expected)}`);
  }
  console.log(
    `Finding count assertion passed for ${targetName} (${signalProfile}): ${count} findings matched ${expected}`
  );
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
      redact(path as string);
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
    case "write-target-metadata": {
      const [path, targetName, targetRepository, signalProfile, expectedFindings] = requireArgs(
        rest,
        ["path", "target_name", "target_repository", "signal_profile", "expected_findings"],
        command
      );
      writeTargetMetadata(
        path as string,
        targetName as string,
        targetRepository as string,
        signalProfile as string,
        expectedFindings as string
      );
      return 0;
    }
    case "copy-report-json": {
      const [envelopePath, outputPath] = requireArgs(rest, ["envelope_path", "output_path"], command);
      copyReportJson(envelopePath as string, outputPath as string);
      return 0;
    }
    case "assert-report-accounting": {
      const [envelopePath, targetName, signalProfile] = requireArgs(
        rest,
        ["envelope_path", "target_name", "signal_profile"],
        command
      );
      assertReportAccounting(envelopePath as string, targetName as string, signalProfile as string);
      return 0;
    }
    case "assert-report-findings": {
      const [reportPath, expected, targetName, signalProfile] = requireArgs(
        rest,
        ["report_path", "expected", "target_name", "signal_profile"],
        command
      );
      assertReportFindings(reportPath as string, expected as string, targetName as string, signalProfile as string);
      return 0;
    }
    default:
      fail(
        "usage: target-e2e-ci.ts <redact|assert-cli-ok|assert-inspect-healthy|write-target-metadata|" +
          "copy-report-json|assert-report-accounting|assert-report-findings> [args...]"
      );
  }
}

process.exit(main(process.argv.slice(2)));
