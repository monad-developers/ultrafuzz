import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { extractReportEvidence, loadTargetManifest, redactText, validateTargetManifest } from "./target-e2e-lib.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = join(repoRoot, "scripts", "ci", "target-e2e-manifest.json");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("target manifest", () => {
  it("accepts exactly the canonical immutable framework matrix", () => {
    const manifest = loadTargetManifest(manifestPath);

    expect(manifest.targets).toHaveLength(3);
    expect(new Set(manifest.targets.map((target) => target.framework))).toEqual(
      new Set(["foundry", "hardhat", "vyper"])
    );
    expect(manifest.targets.every((target) => /^[0-9a-f]{40}$/u.test(target.revision))).toBe(true);
    expect(manifest.targets.every((target) => target.known_vulnerability_references.length > 0)).toBe(true);
  });

  it("rejects mutable revisions and incomplete matrices", () => {
    const manifest = structuredClone(loadTargetManifest(manifestPath));
    manifest.targets[0]!.revision = "main";
    expect(() => validateTargetManifest(manifest)).toThrow("immutable commit SHA");

    const incomplete = structuredClone(loadTargetManifest(manifestPath));
    incomplete.targets.pop();
    expect(() => validateTargetManifest(incomplete)).toThrow("exactly 3 targets");
  });

  it("rejects canonical target repository and revision drift", () => {
    const wrongRevision = structuredClone(loadTargetManifest(manifestPath));
    wrongRevision.targets[0]!.revision = "0".repeat(40);
    expect(() => validateTargetManifest(wrongRevision)).toThrow("canonical smoke matrix");

    const wrongRepository = structuredClone(loadTargetManifest(manifestPath));
    wrongRepository.targets[1]!.repository = "https://github.com/example/other";
    wrongRepository.targets[1]!.repository_slug = "example/other";
    expect(() => validateTargetManifest(wrongRepository)).toThrow("canonical smoke matrix");
  });
});

describe("terminal evidence extraction", () => {
  it("copies real terminal reports and preserves normalized finding content", () => {
    const fixture = evidenceFixture();

    extractReportEvidence(fixture.envelopePath, fixture.evidenceRoot);

    expect(readFileSync(join(fixture.evidenceRoot, "report.json"), "utf-8")).toBe(fixture.reportText);
    expect(readFileSync(join(fixture.evidenceRoot, "report.md"), "utf-8")).toBe(fixture.markdown);
    expect(JSON.parse(readFileSync(join(fixture.evidenceRoot, "findings.json"), "utf-8"))).toEqual([fixture.finding]);
    expect(JSON.parse(readFileSync(join(fixture.evidenceRoot, "run-summary.json"), "utf-8"))).toMatchObject({
      finding_count: 1,
      run_metadata: { tokens_used: "123", estimated_spend: "$0.10" }
    });
  });

  it("rejects former synthetic helper provenance", () => {
    const fixture = evidenceFixture({ findingOverrides: { reproductions: [{ type: "ci-helper" }] } });

    expect(() => extractReportEvidence(fixture.envelopePath, fixture.evidenceRoot)).toThrow(
      "synthetic helper provenance"
    );
  });

  it("rejects empty promoted findings", () => {
    const fixture = evidenceFixture({ findings: [], issueCount: 0 });

    expect(() => extractReportEvidence(fixture.envelopePath, fixture.evidenceRoot)).toThrow(
      "at least one promoted finding"
    );
  });

  it("rejects report and findings count drift", () => {
    const fixture = evidenceFixture({ issueCount: 2 });

    expect(() => extractReportEvidence(fixture.envelopePath, fixture.evidenceRoot)).toThrow(
      "does not match final findings count"
    );
  });
});

describe("diagnostic redaction", () => {
  it("removes sensitive names, values, tokens, and URL user information", () => {
    const input =
      "MODEL_SECRET=sensitive-value github_pat_abcdefghijklmnopqrstuvwxyz https://alice:password@example.test";
    const redacted = redactText(input, { MODEL_SECRET: "sensitive-value" });

    expect(redacted).not.toContain("MODEL_SECRET");
    expect(redacted).not.toContain("sensitive-value");
    expect(redacted).not.toContain("github_pat_abcdefghijklmnopqrstuvwxyz");
    expect(redacted).not.toContain("alice:password");
  });

  it("redacts longer overlapping sensitive values before shorter prefixes", () => {
    const redacted = redactText("prefix-value-long", {
      LONGER_SECRET_NAME: "prefix-value-long",
      KEY: "prefix-value"
    });

    expect(redacted).toBe("[REDACTED_SENSITIVE_VALUE]");
  });
});

function evidenceFixture(
  options: {
    findings?: unknown[];
    findingOverrides?: Record<string, unknown>;
    issueCount?: number;
  } = {}
) {
  const root = mkdtempSync(join(tmpdir(), "ultrafuzz-target-e2e-"));
  temporaryRoots.push(root);
  const artifactsRoot = join(root, "run", "artifacts");
  const reportRoot = join(artifactsRoot, "final-report");
  const severityRoot = join(artifactsRoot, "severity-classification");
  const evidenceRoot = join(root, "evidence");
  mkdirSync(reportRoot, { recursive: true });
  mkdirSync(severityRoot, { recursive: true });

  const finding = {
    schema_version: "1.0",
    id: "finding-1",
    title: "Generic protocol condition",
    status: "needs-review",
    severity_guess: "High",
    confidence: "High",
    summary: "A source-backed protocol condition was reproduced.",
    triage_classification: "true-positive",
    final_disposition: "promoted",
    source_node_id: "boundary-tests",
    strategy: "boundary-tests",
    attempt_index: 0,
    model_id: "target-e2e",
    model: "model-under-test",
    model_index: 0,
    loop_index: 0,
    affected_files: ["src/Example.sol"],
    evidence: [{ kind: "generated-test", path: "generated-tests/Example.t.sol" }],
    ...options.findingOverrides
  };
  const findings = options.findings ?? [finding];
  const issueCount = options.issueCount ?? 1;
  const issues = Array.from({ length: issueCount }, (_value, index) => ({ title: `Issue ${index + 1}` }));
  const report = {
    schema_version: "1.0",
    run_metadata: { tokens_used: "123", estimated_spend: "$0.10" },
    issues,
    non_production_outcomes: []
  };
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = [
    "# Ultrafuzz report",
    "",
    ...Array.from({ length: issueCount }, (_value, index) => `## [H-${String(index + 1).padStart(2, "0")}] - Issue`),
    ""
  ].join("\n");
  const jsonPath = join(reportRoot, "report.json");
  const markdownPath = join(reportRoot, "report.md");
  const envelopePath = join(root, "envelope.json");
  writeFileSync(jsonPath, reportText, "utf-8");
  writeFileSync(markdownPath, markdown, "utf-8");
  writeFileSync(join(severityRoot, "severity-classified-findings.json"), `${JSON.stringify(findings, null, 2)}\n`);
  writeFileSync(
    envelopePath,
    `${JSON.stringify({ ok: true, data: { json_path: jsonPath, markdown_path: markdownPath } }, null, 2)}\n`
  );
  return { envelopePath, evidenceRoot, finding, reportText, markdown };
}
