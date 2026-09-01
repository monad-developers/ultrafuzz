import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import test from "node:test";
import { gzipSync } from "node:zlib";

import AdmZip from "adm-zip";
import {
  parseBenchmarkAnalysisManifest,
  parseBenchmarkProvenance,
  parseBenchmarkSourceManifest
} from "@ultrafuzz/evals";
import tar from "tar-stream";

import { runCli } from "../src/index.js";

interface Capture {
  stdout: string;
  stderr: string;
  code: number;
}

interface SyntheticBundleOptions {
  legacyRunMetadata?: boolean;
  mixedComparison?: boolean;
  modelComparison?: boolean;
  unresolvedDuplicate?: boolean;
}

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const CREATED_AT = "2026-08-09T00:00:00.000Z";

function accountingSummary(totalTokens: number): Record<string, unknown> {
  return {
    uncached_input_tokens: totalTokens,
    input_tokens: totalTokens,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    inclusive_token_total: totalTokens,
    billable_token_total: totalTokens,
    total_tokens: totalTokens,
    tokens_used: String(totalTokens),
    estimated_spend: "$0.00",
    estimated_spend_usd: 0,
    component_costs_usd: {
      uncached_input: 0,
      cache_read: 0,
      cache_write: 0,
      output: 0,
      reasoning: 0
    },
    usage_complete: true,
    usage_incomplete_reasons: [],
    pricing_complete: true,
    pricing_incomplete_reasons: [],
    partial_pricing: false,
    cache_read_pricing_estimated: false,
    event_count: 1,
    priced_event_count: 1,
    unpriced_event_count: 0,
    models: ["synthetic-model"],
    agents: ["synthetic-agent"]
  };
}

function runMetadata(runId: string, totalTokens: number): Record<string, unknown> {
  const workflowRunId = `workflow-${runId}`;
  const summary = accountingSummary(totalTokens);
  const segment = {
    ...summary,
    control_generation: DIGEST_B,
    workflow_run_id: workflowRunId,
    source_event_sequences: [1],
    attempts: [{ node_id: "synthetic-strategy", iteration: 0, attempt: 0 }]
  };
  return {
    schema_version: "ultrafuzz.run-metadata.v2",
    run_id: runId,
    created_at: CREATED_AT,
    mode: "run",
    workflow_ids: [workflowRunId],
    redacted_config_fingerprint: DIGEST_A,
    forge_guard: {
      enabled: true,
      active: true,
      virtual_memory_limit_kb: 1_048_576,
      rayon_threads: 4
    },
    workflow: {
      run_id: workflowRunId,
      compiled_run_id: `compiled-${runId}`,
      name: "synthetic workflow",
      path: "workflow.tsx",
      evidence_path: "evidence.json",
      expanded_graph_path: "expanded-graph.json",
      config_path: "config.json",
      input_path: "input.json",
      tasks_path: "tasks.json",
      control_integrity_path: "control-integrity.json",
      control_generation: DIGEST_B,
      workflow_link_id: "123e4567-e89b-42d3-a456-426614174000",
      execution_snapshot_path: "execution-snapshot.json",
      task_node_ids: ["synthetic-strategy"]
    },
    accounting: {
      schema_version: "ultrafuzz.accounting.v4",
      source: "usage-ledger",
      workflow_run_id: workflowRunId,
      current: structuredClone(segment),
      segments: [structuredClone(segment)],
      cumulative: { ...summary, source_run_ids: [runId] },
      checkpoint: {
        schema_version: "ultrafuzz.accounting-checkpoint.v1",
        ledger_event_count: 1,
        last_source_event_sequence: 1,
        control_generation: DIGEST_B,
        workflow_run_id: workflowRunId
      },
      pricing_catalog: {
        source: "configured-catalog",
        status: "available",
        fetched_at: CREATED_AT,
        resolved_models: ["synthetic-model"],
        unresolved_models: [],
        model_prices: {
          "synthetic-model": { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }
        }
      },
      updated_at: CREATED_AT
    }
  };
}

async function rowArchive(
  runId: string,
  runMetadataPath: string,
  totalTokens: number,
  legacyRunMetadata: boolean
): Promise<Buffer> {
  const pack = tar.pack();
  const metadata = runMetadata(runId, totalTokens);
  if (legacyRunMetadata) metadata.schema_version = "ultrafuzz.run-metadata.v1";
  pack.entry({ name: runMetadataPath }, JSON.stringify(metadata));
  pack.finalize();
  return gzipSync(await buffer(pack));
}

async function writeSyntheticBundle(target: string, options: SyntheticBundleOptions = {}): Promise<void> {
  const {
    legacyRunMetadata = false,
    mixedComparison = false,
    modelComparison = false,
    unresolvedDuplicate = false
  } = options;
  const root = "synthetic-bundle/";
  const outputPath = "adjudication/root-cause-final/output";
  const findings = [
    finding("d1", 0, "H-01", "d1:issue-a", "issue-a", "Synthetic invariant alpha", "High"),
    finding("d1", 1, "L-01", "d1:issue-b", "issue-b", "Synthetic unsupported report", "Low"),
    finding("n1", 0, "H-01", "n1:issue-c", "issue-c", "Synthetic invariant alpha", "High"),
    finding("n1", 1, "M-01", "n1:issue-d", "issue-d", "Synthetic report awaiting review", "Medium")
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
    findings.push(finding("n1", 2, "M-02", "n1:issue-e", "issue-e", "Synthetic duplicate awaiting review", "Medium"));
    mappings.push({
      ...mapping("n1", 2, "n1:issue-e", "issue-e", "cluster-review", "needs-human-review", null),
      duplicateOfFindingInstanceId: "n1:issue-d"
    });
  }
  if (mixedComparison) {
    findings.push(finding("x1", 0, "L-02", "x1:issue-e", "issue-e", "Synthetic independent report", "Low"));
    mappings.push(mapping("x1", 0, "x1:issue-e", "issue-e", "cluster-extra", "false-positive", null));
  }
  const rowIds = mixedComparison ? ["d1", "n1", "x1"] : ["d1", "n1"];
  const rowCounts = {
    d1: 2,
    n1: unresolvedDuplicate ? 3 : 2,
    ...(mixedComparison ? { x1: 1 } : {})
  };
  const rows = rowIds.map((rowId, order) => {
    const variant =
      rowId === "d1"
        ? modelComparison
          ? "model-alpha"
          : "default"
        : rowId === "n1"
          ? modelComparison
            ? "model-beta"
            : "no-fuzz"
          : "model-gamma";
    const label =
      rowId === "d1" && modelComparison
        ? "Model Alpha"
        : rowId === "n1" && modelComparison
          ? "Model Beta"
          : rowId === "x1"
            ? "Model Gamma"
            : rowId;
    const condition = modelComparison || rowId === "x1" ? label : variant === "default" ? "Ultrafuzz" : "no-fuzz";
    const runId = `run-${rowId}`;
    return {
      rowId,
      label,
      condition,
      order,
      variant,
      rowArchivePath: `rows/${variant}/${rowId}/row-artifacts.tar.gz`,
      runMetadataPath: `synthetic/.ultrafuzz/runs/${runId}/run.json`,
      runId,
      findingCount: rowCounts[rowId as keyof typeof rowCounts]
    };
  });
  const zip = new AdmZip();
  addJson(zip, `${root}handoff/current-state.json`, {
    schema_version: "ultrafuzz.eval.adjudication-handoff.v1",
    provenance: { outputPath }
  });
  addJson(zip, `${root}${outputPath}/finding-manifest.json`, {
    schema_version: "ultrafuzz.eval.finding-manifest.v1",
    rows,
    candidateCatalog: [
      {
        candidateId: "candidate-alpha",
        label: "H-01",
        title: "Synthetic cause alpha",
        source: "canonical-ground-truth"
      },
      {
        candidateId: "candidate-beta",
        label: "M-01",
        title: "Synthetic cause beta",
        source: "canonical-ground-truth"
      }
    ],
    findingInstances: findings
  });
  addJson(zip, `${root}${outputPath}/instance-to-cluster.json`, {
    schema_version: "ultrafuzz.eval.instance-clusters.v1",
    instances: mappings
  });
  addJson(zip, `${root}${outputPath}/ground-truth-tp-credits.json`, {
    schema_version: "ultrafuzz.eval.ground-truth-credits.v1",
    clusters: [
      { rootCauseClusterId: "cluster-alpha", groundTruthTpCredits: 2 },
      { rootCauseClusterId: "cluster-fp", groundTruthTpCredits: 0 },
      ...(modelComparison ? [] : [{ rootCauseClusterId: "cluster-review", groundTruthTpCredits: 0 }]),
      ...(mixedComparison ? [{ rootCauseClusterId: "cluster-extra", groundTruthTpCredits: 0 }] : [])
    ]
  });
  const totalTokens = new Map([
    ["d1", 1_000_000],
    ["n1", 2_000_000],
    ["x1", 3_000_000]
  ]);
  for (const row of rows) {
    zip.addFile(
      `${root}${row.rowArchivePath}`,
      await rowArchive(row.runId, row.runMetadataPath, totalTokens.get(row.rowId)!, legacyRunMetadata)
    );
  }
  zip.writeZip(target);
}

function finding(
  rowId: string,
  issueIndex: number,
  findingId: string,
  findingInstanceId: string,
  stableIssueId: string,
  title: string,
  severity: string
): Record<string, unknown> {
  return {
    rowId,
    issueIndex,
    findingId,
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
    matchedSource: matchedCandidateId ? "canonical-ground-truth" : null,
    duplicateOfFindingInstanceId: null
  };
}

function addJson(zip: AdmZip, name: string, value: unknown): void {
  zip.addFile(name, Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
}

function rewriteBundleJson(target: string, relativePath: string, transform: (value: unknown) => unknown): void {
  const zip = new AdmZip(target);
  const entryName = `synthetic-bundle/${relativePath}`;
  const entry = zip.getEntry(entryName);
  assert.ok(entry, `missing synthetic fixture member ${entryName}`);
  const value: unknown = JSON.parse(entry.getData().toString("utf8"));
  zip.updateFile(entryName, Buffer.from(`${JSON.stringify(transform(value))}\n`, "utf8"));
  zip.writeZip(target);
}

function fixtureRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("fixture value is not an object");
  return value as Record<string, unknown>;
}

function fixtureArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("fixture value is not an array");
  return value;
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
  assert.doesNotThrow(() =>
    parseBenchmarkProvenance(JSON.parse(fs.readFileSync(path.join(output, "provenance.json"), "utf8")))
  );
  assert.doesNotThrow(() =>
    parseBenchmarkSourceManifest(JSON.parse(fs.readFileSync(path.join(output, "source_manifest.json"), "utf8")))
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(output, "analysis_manifest.json"), "utf8")) as {
    artifacts: Array<{ path: string; sha256: string }>;
  };
  assert.doesNotThrow(() => parseBenchmarkAnalysisManifest(manifest));
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

test("eval analyze rejects legacy aliases, rewritten paths, malformed typed rows, and v1 run metadata", async (t) => {
  const cases: Array<{
    name: string;
    options?: SyntheticBundleOptions;
    rewrite?: { path: string; transform: (value: unknown) => unknown };
  }> = [
    {
      name: "camelCase handoff version",
      rewrite: {
        path: "handoff/current-state.json",
        transform: (value) => {
          const handoff: Record<string, unknown> = {
            ...fixtureRecord(value),
            schemaVersion: "ultrafuzz.eval.adjudication-handoff.v1"
          };
          delete handoff.schema_version;
          return handoff;
        }
      }
    },
    {
      name: "backslash output path",
      rewrite: {
        path: "handoff/current-state.json",
        transform: (value) => {
          const handoff = fixtureRecord(value);
          return {
            ...handoff,
            provenance: { outputPath: "adjudication\\root-cause-final\\output" }
          };
        }
      }
    },
    {
      name: "lowercase severity alias",
      rewrite: {
        path: "adjudication/root-cause-final/output/finding-manifest.json",
        transform: (value) => {
          const manifest = fixtureRecord(value);
          const findings = fixtureArray(manifest.findingInstances);
          fixtureRecord(findings[0]).severity = "high";
          return manifest;
        }
      }
    },
    {
      name: "finding label embedded in title",
      rewrite: {
        path: "adjudication/root-cause-final/output/finding-manifest.json",
        transform: (value) => {
          const manifest = fixtureRecord(value);
          const findings = fixtureArray(manifest.findingInstances);
          fixtureRecord(findings[0]).title = "[H-01] - Synthetic invariant alpha";
          return manifest;
        }
      }
    },
    {
      name: "malformed source artifact reference",
      rewrite: {
        path: "adjudication/root-cause-final/output/finding-manifest.json",
        transform: (value) => {
          const manifest = fixtureRecord(value);
          const findings = fixtureArray(manifest.findingInstances);
          fixtureRecord(findings[0]).sourceArtifactRefs = [
            { nodeId: "synthetic-strategy" },
            { legacyNodeId: "ignored-before-strict-contracts" }
          ];
          return manifest;
        }
      }
    },
    {
      name: "nonexistent declared nested run metadata path",
      rewrite: {
        path: "adjudication/root-cause-final/output/finding-manifest.json",
        transform: (value) => {
          const manifest = fixtureRecord(value);
          const rows = fixtureArray(manifest.rows);
          fixtureRecord(rows[0]).runMetadataPath = "synthetic/.ultrafuzz/runs/run-d1/renamed-run.json";
          return manifest;
        }
      }
    },
    { name: "run metadata v1", options: { legacyRunMetadata: true } }
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-analysis-strict-rejection-"));
      const project = path.join(root, "project");
      const input = path.join(root, "private-data", "synthetic-handoff.zip");
      const output = path.join(root, "private-data", "reports");
      fs.mkdirSync(project, { recursive: true });
      fs.mkdirSync(path.dirname(input), { recursive: true });
      await writeSyntheticBundle(input, item.options);
      if (item.rewrite !== undefined) rewriteBundleJson(input, item.rewrite.path, item.rewrite.transform);

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
      assert.equal(capture.code, 1, `${item.name}: ${capture.stdout}${capture.stderr}`);
      const body = JSON.parse(capture.stdout) as { diagnostics: Array<{ code: string }> };
      assert.equal(body.diagnostics[0]?.code, "BENCHMARK_ANALYSIS_FAILED");
      assert.equal(fs.existsSync(path.join(output, "analysis_manifest.json")), false);
    });
  }
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
