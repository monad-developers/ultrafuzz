import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import test from "node:test";
import { gzipSync } from "node:zlib";

import AdmZip from "adm-zip";
import tar from "tar-stream";

import { runCli } from "../src/index.js";

interface Capture {
  stdout: string;
  stderr: string;
  code: number;
}

interface SyntheticBundleOptions {
  mixedComparison?: boolean;
  modelComparison?: boolean;
  unresolvedDuplicate?: boolean;
}

async function rowArchive(totalTokens: number): Promise<Buffer> {
  const pack = tar.pack();
  pack.entry(
    { name: "synthetic/.ultrafuzz/runs/example/run.json" },
    JSON.stringify({
      accounting: {
        current: {
          input_tokens: totalTokens,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          total_tokens: totalTokens,
          estimated_spend: "$0.00+",
          estimated_spend_usd: 0,
          partial_pricing: true,
          priced_event_count: 0,
          unpriced_event_count: 1
        }
      }
    })
  );
  pack.finalize();
  return gzipSync(await buffer(pack));
}

async function writeSyntheticBundle(target: string, options: SyntheticBundleOptions = {}): Promise<void> {
  const { mixedComparison = false, modelComparison = false, unresolvedDuplicate = false } = options;
  const root = "synthetic-bundle/";
  const outputPath = "adjudication/root-cause-final/output";
  const findings = [
    finding("d1", 0, "d1:issue-a", "issue-a", "[H-01] - Synthetic invariant alpha", "High"),
    finding("d1", 1, "d1:issue-b", "issue-b", "[L-01] - Synthetic unsupported report", "Low"),
    finding("n1", 0, "n1:issue-c", "issue-c", "[H-01] - Synthetic invariant alpha", "High"),
    finding("n1", 1, "n1:issue-d", "issue-d", "[M-01] - Synthetic report awaiting review", "Medium")
  ];
  const mappings = [
    mapping("d1", 0, "d1:issue-a", "issue-a", "cluster-alpha", "true-positive", "candidate-alpha"),
    mapping("d1", 1, "d1:issue-b", "issue-b", "cluster-fp", "false-positive", null),
    mapping("n1", 0, "n1:issue-c", "issue-c", "cluster-alpha", "true-positive", "candidate-alpha"),
    mapping("n1", 1, "n1:issue-d", "issue-d", "cluster-review", "needs-human-review", null)
  ];
  if (modelComparison) {
    mappings[3] = {
      ...mapping("n1", 1, "n1:issue-d", "issue-d", "cluster-alpha", "true-positive", "candidate-alpha"),
      duplicateOfFindingInstanceId: "n1:issue-c"
    };
  }
  if (unresolvedDuplicate) {
    findings.push(finding("n1", 2, "n1:issue-e", "issue-e", "[M-02] - Synthetic duplicate awaiting review", "Medium"));
    mappings.push({
      ...mapping("n1", 2, "n1:issue-e", "issue-e", "cluster-review", "needs-human-review", null),
      duplicateOfFindingInstanceId: "n1:issue-d"
    });
  }
  if (mixedComparison) {
    findings.push(finding("x1", 0, "x1:issue-e", "issue-e", "[L-02] - Synthetic independent report", "Low"));
    mappings.push(mapping("x1", 0, "x1:issue-e", "issue-e", "cluster-extra", "false-positive", null));
  }
  const rows = mixedComparison ? ["d1", "n1", "x1"] : ["d1", "n1"];
  const rowCounts = {
    d1: 2,
    n1: unresolvedDuplicate ? 3 : 2,
    ...(mixedComparison ? { x1: 1 } : {})
  };
  const zip = new AdmZip();
  addJson(zip, `${root}handoff/current-state.json`, {
    schemaVersion: "ultrafuzz-adjudication-handoff/test",
    provenance: { outputPath }
  });
  addJson(zip, `${root}${outputPath}/finding-manifest.json`, {
    rows,
    rowCounts,
    ...(modelComparison || mixedComparison
      ? {
          rowMetadata: {
            ...(modelComparison
              ? {
                  d1: { label: "Model Alpha", condition: "Model Alpha", order: 0 },
                  n1: { label: "Model Beta", condition: "Model Beta", order: 1 }
                }
              : {}),
            ...(mixedComparison ? { x1: { label: "Model Gamma", condition: "Model Gamma", order: 2 } } : {})
          }
        }
      : {}),
    candidateCatalog: [
      { candidateId: "candidate-alpha", heading: "[H-01] - Synthetic cause alpha", source: "canonical-ground-truth" },
      { candidateId: "candidate-beta", heading: "[M-01] - Synthetic cause beta", source: "canonical-ground-truth" }
    ],
    findingInstances: findings
  });
  addJson(zip, `${root}${outputPath}/instance-to-cluster.json`, mappings);
  addJson(zip, `${root}${outputPath}/ground-truth-tp-credits.json`, {
    clusters: [
      { rootCauseClusterId: "cluster-alpha", groundTruthTpCredits: 2 },
      { rootCauseClusterId: "cluster-fp", groundTruthTpCredits: 0 },
      { rootCauseClusterId: "cluster-review", groundTruthTpCredits: 0 },
      ...(mixedComparison ? [{ rootCauseClusterId: "cluster-extra", groundTruthTpCredits: 0 }] : [])
    ]
  });
  zip.addFile(
    `${root}rows/${modelComparison ? "model-alpha" : "default"}/d1/row-artifacts.tar.gz`,
    await rowArchive(1_000_000)
  );
  zip.addFile(
    `${root}rows/${modelComparison ? "model-beta" : "no-fuzz"}/n1/row-artifacts.tar.gz`,
    await rowArchive(2_000_000)
  );
  if (mixedComparison) {
    zip.addFile(`${root}rows/model-gamma/x1/row-artifacts.tar.gz`, await rowArchive(3_000_000));
  }
  zip.writeZip(target);
}

function finding(
  rowId: string,
  issueIndex: number,
  findingInstanceId: string,
  stableIssueId: string,
  title: string,
  severity: string
): Record<string, unknown> {
  return {
    rowId,
    issueIndex,
    findingInstanceId,
    stableIssueId,
    title,
    severity,
    sourceArtifactRefs: [{ nodeId: "synthetic-strategy" }]
  };
}

function mapping(
  rowId: string,
  issueIndex: number,
  findingInstanceId: string,
  stableIssueId: string,
  rootCauseClusterId: string,
  instanceClassification: string,
  matchedCandidateId: string | null
): Record<string, unknown> {
  return {
    rowId,
    issueIndex,
    findingInstanceId,
    stableIssueId,
    rootCauseClusterId,
    instanceClassification,
    matchedCandidateId,
    matchedSource: matchedCandidateId ? "canonical-ground-truth" : null
  };
}

function addJson(zip: AdmZip, name: string, value: unknown): void {
  zip.addFile(name, Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
}

async function cli(cwd: string, argv: string[]): Promise<Capture> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, {
    cwd,
    env: process.env,
    stdout: {
      write: (chunk: string | Uint8Array) => {
        stdout += String(chunk);
        return true;
      }
    },
    stderr: {
      write: (chunk: string | Uint8Array) => {
        stderr += String(chunk);
        return true;
      }
    }
  });
  return { stdout, stderr, code };
}

test("eval analyze all generates reports from finalized handoff data", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-analysis-test-"));
  const project = path.join(root, "project");
  const privateData = path.join(root, "private-data");
  const input = path.join(privateData, "synthetic-handoff.zip");
  const output = path.join(privateData, "reports");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(privateData, { recursive: true });
  await writeSyntheticBundle(input);

  const capture = await cli(root, [
    "eval",
    "analyze",
    "all",
    "--input",
    input,
    "--output",
    output,
    "--project",
    project,
    "--json"
  ]);
  assert.equal(capture.code, 0, capture.stderr);
  const body = JSON.parse(capture.stdout) as { ok: boolean; data: Record<string, unknown> };
  assert.equal(body.ok, true);
  assert.equal(body.data.findingInstances, 4);
  assert.equal(body.data.rootCauseClusters, 3);
  assert.equal(body.data.groundTruthTpCredits, 2);
  for (const file of [
    "row_scores.csv",
    "condition_aggregate.csv",
    "row_results_table.md",
    "provenance.json",
    "upset_provenance.svg",
    "upset_provenance.png",
    "precision_recall_f1.svg",
    "precision_recall_f1.png",
    "cost_performance.svg",
    "cost_performance.png",
    "paired_row_comparison.svg",
    "paired_row_comparison.png",
    "METHOD.md",
    "source_manifest.json",
    "analysis_manifest.json"
  ]) {
    assert.equal(fs.existsSync(path.join(output, file)), true, file);
  }
  for (const file of [
    "upset_provenance.png",
    "precision_recall_f1.png",
    "cost_performance.png",
    "paired_row_comparison.png"
  ]) {
    const signature = fs.readFileSync(path.join(output, file)).subarray(0, 8);
    assert.deepEqual(signature, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), file);
  }
  const scores = fs.readFileSync(path.join(output, "row_scores.csv"), "utf8");
  assert.match(scores, /d1,Ultrafuzz,true,valid,,2,1,1,0,2/u);
  assert.match(scores, /n1,no-fuzz,true,valid,,2,1,0,1,2/u);
  const rowTable = fs.readFileSync(path.join(output, "row_results_table.md"), "utf8");
  for (const section of [
    "## Row quality",
    "## Finding disposition",
    "## Compute and spend",
    "## Condition quality",
    "## Condition finding disposition",
    "## Condition compute",
    "## Paired score comparison",
    "## Paired detection overlap"
  ]) {
    assert.match(rowTable, new RegExp(section, "u"), section);
  }
  const markdownTableWidths = rowTable
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) => (line.match(/(?<!\\)\|/gu)?.length ?? 1) - 1);
  assert.equal(Math.max(...markdownTableWidths) <= 6, true, "Markdown tables should have at most six columns");
  assert.match(fs.readFileSync(path.join(output, "METHOD.md"), "utf8"), /Do not commit it/u);
  const manifest = JSON.parse(fs.readFileSync(path.join(output, "analysis_manifest.json"), "utf8")) as {
    artifacts: Array<{ path: string; sha256: string }>;
  };
  assert.equal(
    manifest.artifacts.some((artifact) => artifact.path === "row_scores.csv"),
    true
  );
  assert.equal(manifest.artifacts.filter((artifact) => artifact.path.endsWith(".png")).length, 4);
  assert.equal(
    manifest.artifacts.every((artifact) => /^[a-f0-9]{64}$/u.test(artifact.sha256)),
    true
  );

  const pairwiseOutput = path.join(privateData, "pairwise-reports");
  const pairwise = await cli(root, [
    "eval",
    "analyze",
    "pairwise",
    "--input",
    input,
    "--output",
    pairwiseOutput,
    "--project",
    project,
    "--json"
  ]);
  assert.equal(pairwise.code, 0, pairwise.stderr);
  assert.equal(fs.existsSync(path.join(pairwiseOutput, "paired_row_comparison.svg")), true);
  assert.equal(fs.existsSync(path.join(pairwiseOutput, "paired_row_comparison.png")), true);
});

test("eval analyze refuses private input or output inside the project repository", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-analysis-guard-"));
  const project = path.join(root, "project");
  const input = path.join(project, "private-handoff.zip");
  const output = path.join(root, "reports");
  fs.mkdirSync(project, { recursive: true });
  await writeSyntheticBundle(input);

  const capture = await cli(root, [
    "eval",
    "analyze",
    "scores",
    "--input",
    input,
    "--output",
    output,
    "--project",
    project,
    "--json"
  ]);
  assert.equal(capture.code, 1);
  const body = JSON.parse(capture.stdout) as { ok: boolean; diagnostics: Array<{ code: string; message: string }> };
  assert.equal(body.ok, false);
  assert.equal(body.diagnostics[0]?.code, "BENCHMARK_ANALYSIS_FAILED");
  assert.match(body.diagnostics[0]?.message ?? "", /must be outside the project repository/u);
  assert.equal(fs.existsSync(output), false);
});

test("eval analyze all generates cross-row comparison outputs for independently configured models", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-model-analysis-test-"));
  const project = path.join(root, "project");
  const privateData = path.join(root, "private-data");
  const input = path.join(privateData, "synthetic-model-handoff.zip");
  const output = path.join(privateData, "reports");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(privateData, { recursive: true });
  await writeSyntheticBundle(input, { modelComparison: true });

  const capture = await cli(root, [
    "eval",
    "analyze",
    "all",
    "--input",
    input,
    "--output",
    output,
    "--project",
    project,
    "--json"
  ]);
  assert.equal(capture.code, 0, capture.stderr);
  for (const file of ["model_comparison.svg", "model_comparison.png", "row_comparison.csv", "row_results_table.md"]) {
    assert.equal(fs.existsSync(path.join(output, file)), true, file);
  }
  assert.equal(fs.existsSync(path.join(output, "paired_row_comparison.svg")), false);
  assert.match(fs.readFileSync(path.join(output, "row_results_table.md"), "utf8"), /Cross-row ranking/u);
  assert.match(fs.readFileSync(path.join(output, "row_comparison.csv"), "utf8"), /Model Alpha/u);
  const scoreLines = fs.readFileSync(path.join(output, "row_scores.csv"), "utf8").trim().split("\n");
  const scoreHeader = scoreLines[0]?.split(",") ?? [];
  const beta = scoreLines.find((line) => line.startsWith("n1,"))?.split(",") ?? [];
  assert.equal(beta[scoreHeader.indexOf("duplicate_count")], "1");
  assert.equal(beta[scoreHeader.indexOf("true_positives")], "1");
  assert.equal(beta[scoreHeader.indexOf("precision")], "0.500000");
});

test("eval analyze all preserves paired detail and every row in mixed comparisons", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-mixed-analysis-test-"));
  const project = path.join(root, "project");
  const privateData = path.join(root, "private-data");
  const input = path.join(privateData, "synthetic-mixed-handoff.zip");
  const output = path.join(privateData, "reports");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(privateData, { recursive: true });
  await writeSyntheticBundle(input, { mixedComparison: true });

  const capture = await cli(root, [
    "eval",
    "analyze",
    "all",
    "--input",
    input,
    "--output",
    output,
    "--project",
    project,
    "--json"
  ]);
  assert.equal(capture.code, 0, capture.stderr);
  for (const file of [
    "paired_row_comparison.svg",
    "paired_row_comparison.png",
    "paired_row_comparison.csv",
    "model_comparison.svg",
    "model_comparison.png",
    "row_comparison.csv"
  ]) {
    assert.equal(fs.existsSync(path.join(output, file)), true, file);
  }
  const rowTable = fs.readFileSync(path.join(output, "row_results_table.md"), "utf8");
  assert.match(rowTable, /## Paired score comparison/u);
  assert.match(rowTable, /## Cross-row ranking/u);
  assert.match(fs.readFileSync(path.join(output, "row_comparison.csv"), "utf8"), /Model Gamma/u);
});

test("unresolved duplicates do not lower row or condition precision", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-unresolved-duplicate-test-"));
  const project = path.join(root, "project");
  const privateData = path.join(root, "private-data");
  const input = path.join(privateData, "synthetic-unresolved-duplicate-handoff.zip");
  const output = path.join(privateData, "reports");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(privateData, { recursive: true });
  await writeSyntheticBundle(input, { unresolvedDuplicate: true });

  const capture = await cli(root, [
    "eval",
    "analyze",
    "scores",
    "--input",
    input,
    "--output",
    output,
    "--project",
    project,
    "--json"
  ]);
  assert.equal(capture.code, 0, capture.stderr);
  const body = JSON.parse(capture.stdout) as { data: { duplicateInstances: number } };
  assert.equal(body.data.duplicateInstances, 1);

  const scoreLines = fs.readFileSync(path.join(output, "row_scores.csv"), "utf8").trim().split("\n");
  const scoreHeader = scoreLines[0]?.split(",") ?? [];
  const noFuzz = scoreLines.find((line) => line.startsWith("n1,"))?.split(",") ?? [];
  assert.equal(noFuzz[scoreHeader.indexOf("duplicate_count")], "1");
  assert.equal(noFuzz[scoreHeader.indexOf("needs_human_review")], "1");
  assert.equal(Number(noFuzz[scoreHeader.indexOf("precision")]), 1);

  const aggregateLines = fs.readFileSync(path.join(output, "condition_aggregate.csv"), "utf8").trim().split("\n");
  const aggregateHeader = aggregateLines[0]?.split(",") ?? [];
  const noFuzzAggregate = aggregateLines.find((line) => line.startsWith("no-fuzz,"))?.split(",") ?? [];
  assert.equal(noFuzzAggregate[aggregateHeader.indexOf("duplicate_count")], "1");
  assert.equal(Number(noFuzzAggregate[aggregateHeader.indexOf("pooled_precision")]), 1);
});
