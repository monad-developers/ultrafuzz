import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FINDING_JSON_SCHEMA_ID, schemaRegistryBundleDigest } from "@ultrafuzz/artifacts";
import { describe, expect, it, vi } from "vitest";

import {
  appendEvalRunRecord,
  parseEvalFindingScore,
  parseEvalPublicationState,
  parseEvalReviewQueueItem,
  parseEvalRunManifest,
  parseEvalRunRecord,
  parseEvalRunSummary,
  parseEvalScoreSummary,
  parseTelemetryCursor,
  readEvalFindingScores,
  readEvalMatrix,
  readEvalPublicationState,
  readEvalReviewQueue,
  readEvalRunManifest,
  readEvalRunRecords,
  readEvalRunSummary,
  readEvalScoreSummary,
  readStrictJsonDocument,
  serializeEvalFindingScores,
  serializeEvalReviewQueue,
  writeEvalMatrix,
  writeEvalPublicationState,
  writeEvalRunManifest,
  writeEvalRunSummary,
  writeEvalScoreSummary
} from "../src/eval-durable.js";
import {
  EVAL_FINDING_SCORE_SCHEMA_ID,
  EVAL_MATRIX_SCHEMA_ID,
  EVAL_REVIEW_QUEUE_ITEM_SCHEMA_ID,
  EVAL_RUN_MANIFEST_SCHEMA_ID,
  EVAL_RUN_RECORD_SCHEMA_ID,
  EVAL_RUN_SUMMARY_SCHEMA_ID,
  EVAL_SCHEMA_EXPORTS,
  EVAL_SCHEMA_METADATA,
  EVAL_SCORE_SUMMARY_SCHEMA_ID,
  evalSchemaBundleDigest,
  evalSchemaDirectory,
  evalSchemaRegistry,
  validateEvalJsonSchema
} from "../src/eval-schema-registry.js";
import { assertEvalSemanticGateRegistry, executeEvalSchemaSemanticGates } from "../src/eval-semantic-gates.js";
import type { EvalFindingScore, FindingJudgeResult, HumanReviewQueueItem } from "../src/types.js";
import {
  currentEvalRunRecord,
  currentRunManifest,
  currentScoreSummary,
  testReportAuthority,
  testRow,
  testSuite
} from "./helpers.js";

const timestamp = "2026-07-09T00:00:00.000Z";

function fixtureRoot(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function judgeResult(overrides: Partial<FindingJudgeResult> = {}): FindingJudgeResult {
  return {
    matched_ground_truth_bug_id: "BUG-1",
    score: 1,
    signals: { root_cause: 1, affected_area: 1, impact: 1, evidence: 1 },
    classification: "true-positive",
    reason_code: "deterministic-match",
    rationale: "Exact canonical match.",
    confidence: 1,
    judge_model: "deterministic-v1",
    judge_kind: "deterministic",
    prompt_version: "deterministic-v1",
    timestamp,
    ...overrides
  };
}

function findingScore(): EvalFindingScore {
  const decision = judgeResult();
  return {
    schema_version: "ultrafuzz.eval.finding-score.v2",
    row_id: "target-a-baseline-trial-1",
    finding_id: "finding-1",
    report_path: "/tmp/report.json",
    report_authority: testReportAuthority({ run_id: "run-1" }),
    deterministic_match: decision,
    judge_result: decision
  };
}

function reviewItem(): HumanReviewQueueItem {
  const decision = judgeResult({
    matched_ground_truth_bug_id: undefined,
    score: 0.5,
    classification: "needs-human-review",
    reason_code: "strong-novel-finding"
  });
  return {
    schema_version: "ultrafuzz.eval.review-queue-item.v2",
    target_id: "target-a",
    variant_id: "baseline",
    trial_id: "trial-1",
    workflow_ids: ["workflow-1"],
    finding: {
      schema_version: "ultrafuzz.finding.v2",
      id: "finding-1",
      title: "Novel finding",
      status: "needs-review",
      severity_guess: "Medium",
      confidence: "medium",
      summary: "A novel finding requiring review."
    },
    report_path: "/tmp/report.json",
    deterministic_match: decision,
    judge_result: decision,
    reviewer_status: "pending"
  };
}

function canonicalFixtures() {
  const root = fixtureRoot("ufz-eval-durable");
  const suite = testSuite(path.join(root, "ground-truth"));
  const row = testRow(suite);
  const record = currentEvalRunRecord({ row, runRoot: path.join(root, "run") });
  const manifest = currentRunManifest({ suite, projectRoot: root });
  const runSummary = {
    schema_version: "ultrafuzz.eval.run-summary.v2" as const,
    eval_run_id: "eval-test",
    launched: 1,
    failed: 0,
    incomplete: 0,
    records: [record]
  };
  const scoreSummary = currentScoreSummary({ row, evalRunRoot: path.join(root, "eval") });
  return { root, row, record, manifest, runSummary, scoreSummary };
}

interface AppendChild {
  process: ChildProcess;
  completed: Promise<void>;
}

function startAppendChild(args: string[]): AppendChild {
  const localRequire = createRequire(import.meta.url);
  const requireFromVitest = createRequire(localRequire.resolve("vitest"));
  const viteNode = requireFromVitest.resolve("vite-node/vite-node.mjs");
  const testDirectory = path.dirname(fileURLToPath(import.meta.url));
  const childScript = path.join(testDirectory, "append-eval-run-record-child.ts");
  const child = spawn(process.execPath, [viteNode, "--script", childScript, ...args], {
    cwd: path.resolve(testDirectory, "../../.."),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  return {
    process: child,
    completed: new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(
            `append child exited with ${code ?? signal ?? "unknown"}: ${Buffer.concat(stderr).toString("utf8")} ${Buffer.concat(stdout).toString("utf8")}`
          )
        );
      });
    })
  };
}

async function waitForFiles(filePaths: string[], timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!filePaths.every((filePath) => fs.existsSync(filePath))) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for child markers: ${filePaths.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("eval durable schema registry", () => {
  it("enumerates, compiles, and digests the complete sorted schema bundle", () => {
    const registry = evalSchemaRegistry();
    const discovered = fs
      .readdirSync(evalSchemaDirectory())
      .filter((filename) => filename.endsWith(".schema.json"))
      .sort();
    expect(registry.map((entry) => entry.filename)).toEqual(discovered);
    expect(Object.keys(EVAL_SCHEMA_METADATA).sort()).toEqual(discovered);
    expect(new Set(registry.map((entry) => entry.id)).size).toBe(registry.length);
    const exportsByName = EVAL_SCHEMA_EXPORTS as Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    const exportNames = Object.values(EVAL_SCHEMA_METADATA)
      .map((metadata) => metadata.typescriptExport)
      .sort();
    expect(exportNames).toEqual(Object.keys(EVAL_SCHEMA_EXPORTS).sort());
    const ids = new Set([...registry.map((entry) => entry.id), FINDING_JSON_SCHEMA_ID]);
    for (const entry of registry) {
      const metadata = EVAL_SCHEMA_METADATA[entry.filename]!;
      const checkedIn = JSON.parse(fs.readFileSync(path.join(evalSchemaDirectory(), entry.filename), "utf8"));
      expect(entry.typescriptExport).toBe(metadata.typescriptExport);
      expect(entry.schema).toEqual(exportsByName[metadata.typescriptExport]);
      expect(entry.schema).toEqual(checkedIn);
      expect(entry.semanticGates).toEqual(metadata.semanticGates);
      for (const reference of entry.localReferences) {
        if (reference.startsWith("#")) continue;
        expect(reference).not.toMatch(/^(?:file|https?):/u);
        expect(ids.has(reference.split("#", 1)[0]!)).toBe(true);
      }
      expect(() => validateEvalJsonSchema(entry.id, null)).not.toThrow();
    }
    expect(evalSchemaBundleDigest()).toMatch(/^[0-9a-f]{64}$/u);
    expect(evalSchemaBundleDigest()).toBe(schemaRegistryBundleDigest(registry));
    expect(() => assertEvalSemanticGateRegistry()).not.toThrow();
  });

  it("accepts one canonical value for every materialized eval schema", () => {
    const { row, record, manifest, runSummary, scoreSummary } = canonicalFixtures();
    const fixtures = new Map<string, unknown>([
      [EVAL_RUN_MANIFEST_SCHEMA_ID, manifest],
      [EVAL_MATRIX_SCHEMA_ID, [row]],
      [EVAL_RUN_RECORD_SCHEMA_ID, record],
      [EVAL_RUN_SUMMARY_SCHEMA_ID, runSummary],
      [EVAL_FINDING_SCORE_SCHEMA_ID, findingScore()],
      [EVAL_SCORE_SUMMARY_SCHEMA_ID, scoreSummary],
      [EVAL_REVIEW_QUEUE_ITEM_SCHEMA_ID, reviewItem()]
    ]);
    for (const [schemaId, value] of fixtures) {
      expect(validateEvalJsonSchema(schemaId, value), schemaId).toMatchObject({ ok: true, issues: [] });
    }
    expect(
      parseEvalPublicationState({
        schema_version: "ultrafuzz.eval.publication.v1",
        status: "publishable",
        diagnostics: []
      })
    ).toBeDefined();
    expect(
      parseTelemetryCursor({
        schemaVersion: "ultrafuzz.eval.telemetry-cursor.v1",
        byteOffset: 0,
        deliveredEventIds: [],
        uploadedArtifacts: {},
        lastHeartbeatAt: {},
        providerIds: {},
        findingsCountByNode: {}
      })
    ).toBeDefined();
  });

  it("accepts run audit lineage fields while rejecting unknown run-record fields", () => {
    const record = {
      ...canonicalFixtures().record,
      audit_profile: "smoke",
      audit_profile_catalog_digest: "a".repeat(64),
      topology_digest: "b".repeat(64),
      prompt_digest: "c".repeat(64)
    };
    expect(validateEvalJsonSchema(EVAL_RUN_RECORD_SCHEMA_ID, record)).toMatchObject({ ok: true, issues: [] });
    expect(
      validateEvalJsonSchema(EVAL_RUN_RECORD_SCHEMA_ID, { ...record, unknown_lineage: "d".repeat(64) })
    ).toMatchObject({ ok: false });
  });
});

describe("eval durable readers and writers", () => {
  it("round-trips canonical documents without mutation", () => {
    const { root, row, record, manifest, runSummary, scoreSummary } = canonicalFixtures();
    const manifestPath = path.join(root, "eval.json");
    const matrixPath = path.join(root, "matrix.json");
    const recordsPath = path.join(root, "runs.jsonl");
    const runSummaryPath = path.join(root, "run-summary.json");
    const scoreSummaryPath = path.join(root, "summary.json");
    const publicationPath = path.join(root, "publication-state.json");
    writeEvalRunManifest(manifestPath, manifest);
    writeEvalMatrix(matrixPath, [row]);
    fs.writeFileSync(recordsPath, "");
    appendEvalRunRecord(recordsPath, record);
    writeEvalRunSummary(runSummaryPath, runSummary);
    writeEvalScoreSummary(scoreSummaryPath, scoreSummary);
    writeEvalPublicationState(publicationPath, {
      schema_version: "ultrafuzz.eval.publication.v1",
      status: "publishable",
      diagnostics: []
    });
    expect(readEvalRunManifest(manifestPath)).toEqual(manifest);
    expect(readEvalMatrix(matrixPath)).toEqual([row]);
    expect(readEvalRunRecords(recordsPath)).toEqual([record]);
    expect(readEvalRunSummary(runSummaryPath)).toEqual(runSummary);
    expect(readEvalScoreSummary(scoreSummaryPath)).toEqual(scoreSummary);
    expect(readEvalPublicationState(publicationPath).status).toBe("publishable");
  });

  it("rejects duplicate keys, invalid UTF-8, and wrong versions", () => {
    const root = fixtureRoot("ufz-eval-strict-json");
    const duplicatePath = path.join(root, "duplicate.json");
    fs.writeFileSync(duplicatePath, '{"schema_version":"x","schema_version":"y"}');
    expect(() => readStrictJsonDocument(duplicatePath)).toThrow(/duplicate/iu);
    const utf8Path = path.join(root, "invalid-utf8.json");
    fs.writeFileSync(utf8Path, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]));
    expect(() => readStrictJsonDocument(utf8Path)).toThrow(/invalid/iu);
    const fixtures = canonicalFixtures();
    expect(() => parseEvalRunManifest({ ...fixtures.manifest, schema_version: "ultrafuzz.eval.run.v1" })).toThrow();
    expect(() => parseEvalRunRecord({ ...fixtures.record, schema_version: "ultrafuzz.eval.run.v1" })).toThrow();
    expect(() => parseEvalRunSummary({ ...fixtures.runSummary, schema_version: "1.0" })).toThrow();
    expect(() => parseEvalScoreSummary({ ...fixtures.scoreSummary, schema_version: "1.0" })).toThrow();
    expect(() =>
      parseEvalScoreSummary({
        ...fixtures.scoreSummary,
        rows: fixtures.scoreSummary.rows.map((row) => ({ ...row, runtime_seconds: row.efficiency.wall_time_seconds }))
      })
    ).toThrow();
    expect(() =>
      parseEvalScoreSummary({
        ...fixtures.scoreSummary,
        rows: fixtures.scoreSummary.rows.map((row) => ({ ...row, cost_estimate: row.efficiency.cost_usd }))
      })
    ).toThrow();
  });

  it("requires a materialized run journal, accepts its canonical empty state, and rejects malformed rows", () => {
    const root = fixtureRoot("ufz-eval-journal");
    const journal = path.join(root, "runs.jsonl");
    const record = canonicalFixtures().record;
    expect(() => readEvalRunRecords(journal)).toThrow();
    expect(() => appendEvalRunRecord(journal, record)).toThrow();
    expect(fs.existsSync(journal)).toBe(false);
    fs.writeFileSync(journal, "");
    expect(readEvalRunRecords(journal)).toEqual([]);
    appendEvalRunRecord(journal, record);
    expect(readEvalRunRecords(journal)).toEqual([record]);
    fs.writeFileSync(journal, JSON.stringify(record));
    const unterminated = fs.readFileSync(journal);
    expect(() => readEvalRunRecords(journal)).toThrow(/unterminated/iu);
    expect(() => appendEvalRunRecord(journal, record)).toThrow(/unterminated/iu);
    expect(fs.readFileSync(journal)).toEqual(unterminated);
    fs.writeFileSync(journal, '{"schema_version":\n');
    const malformed = fs.readFileSync(journal);
    expect(() => readEvalRunRecords(journal)).toThrow(/invalid/iu);
    expect(() => appendEvalRunRecord(journal, record)).toThrow(/invalid/iu);
    expect(fs.readFileSync(journal)).toEqual(malformed);
  });

  it("serializes contending process writers without losing any validated run record", async () => {
    const root = fixtureRoot("ufz-eval-journal-concurrent");
    const journal = path.join(root, "runs.jsonl");
    const lockPath = `${journal}.lock`;
    const gatePath = path.join(root, "append.gate");
    fs.writeFileSync(journal, "");
    // Hold the real lock path until every independent process has reached the
    // same gate, making lock contention deterministic instead of scheduler luck.
    fs.mkdirSync(lockPath);
    const baseRecord = canonicalFixtures().record;
    const records = Array.from({ length: 4 }, (_, index) => ({
      ...baseRecord,
      candidate_label: `concurrent-${index}`
    }));
    const readyPaths = records.map((_, index) => path.join(root, `ready-${index}`));
    const contendingPaths = records.map((_, index) => path.join(root, `contending-${index}`));
    const children = records.map((record, index) =>
      startAppendChild([
        journal,
        readyPaths[index]!,
        gatePath,
        contendingPaths[index]!,
        Buffer.from(JSON.stringify(record), "utf8").toString("base64url")
      ])
    );
    let released = false;
    try {
      await waitForFiles(readyPaths);
      fs.writeFileSync(gatePath, "");
      await waitForFiles(contendingPaths);
      fs.rmdirSync(lockPath);
      released = true;
      await Promise.all(children.map((child) => child.completed));
    } finally {
      if (!released && fs.existsSync(lockPath)) fs.rmdirSync(lockPath);
      for (const child of children) {
        if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill("SIGKILL");
      }
      await Promise.allSettled(children.map((child) => child.completed));
    }

    const observed = readEvalRunRecords(journal);
    expect(observed).toHaveLength(records.length);
    expect(observed.map((record) => record.candidate_label).sort()).toEqual(
      records.map((record) => record.candidate_label).sort()
    );
    expect(fs.existsSync(lockPath)).toBe(false);
  }, 60_000);

  it("rejects a same-size canonical path replacement after validation and before append", () => {
    const root = fixtureRoot("ufz-eval-journal-replacement");
    const journal = path.join(root, "runs.jsonl");
    const retained = path.join(root, "runs.validated.jsonl");
    const baseRecord = canonicalFixtures().record;
    const originalRecord = { ...baseRecord, candidate_label: "original-aa" };
    const replacementRecord = { ...baseRecord, candidate_label: "replacement" };
    const candidateRecord = { ...baseRecord, candidate_label: "candidate-c" };
    const originalBytes = Buffer.from(`${JSON.stringify(originalRecord)}\n`, "utf8");
    const replacementBytes = Buffer.from(`${JSON.stringify(replacementRecord)}\n`, "utf8");
    expect(replacementBytes.byteLength).toBe(originalBytes.byteLength);
    fs.writeFileSync(journal, originalBytes);

    const originalLstat = fs.lstatSync.bind(fs);
    let replaced = false;
    const lstat = vi.spyOn(fs, "lstatSync").mockImplementation(((candidate: fs.PathLike, options: { bigint: true }) => {
      if (!replaced && path.resolve(String(candidate)) === journal) {
        replaced = true;
        fs.renameSync(journal, retained);
        fs.writeFileSync(journal, replacementBytes);
      }
      return originalLstat(candidate, options);
    }) as typeof fs.lstatSync);
    try {
      expect(() => appendEvalRunRecord(journal, candidateRecord)).toThrow(
        expect.objectContaining({ code: "EVAL_DURABLE_APPEND_RACE" })
      );
    } finally {
      lstat.mockRestore();
    }

    expect(replaced).toBe(true);
    expect(fs.readFileSync(journal)).toEqual(replacementBytes);
    expect(fs.readFileSync(retained)).toEqual(originalBytes);
    expect(fs.existsSync(`${journal}.lock`)).toBe(false);
  });

  it("requires score/review files but permits explicit zero-record materializations", () => {
    const root = fixtureRoot("ufz-eval-zero-jsonl");
    const scores = path.join(root, "scores.jsonl");
    const review = path.join(root, "review.jsonl");
    expect(() => readEvalFindingScores(scores)).toThrow();
    expect(() => readEvalReviewQueue(review)).toThrow();
    fs.writeFileSync(scores, serializeEvalFindingScores([]));
    fs.writeFileSync(review, serializeEvalReviewQueue([]));
    expect(readEvalFindingScores(scores)).toEqual([]);
    expect(readEvalReviewQueue(review)).toEqual([]);
    fs.writeFileSync(scores, serializeEvalFindingScores([findingScore()]));
    fs.writeFileSync(review, serializeEvalReviewQueue([reviewItem()]));
    expect(readEvalFindingScores(scores)).toEqual([parseEvalFindingScore(findingScore())]);
    expect(readEvalReviewQueue(review)).toEqual([parseEvalReviewQueueItem(reviewItem())]);
  });
});

describe("eval semantic gates", () => {
  it("executes every registered gate and rejects each gate's negative fixture", () => {
    const { row, record, manifest, runSummary, scoreSummary } = canonicalFixtures();
    const missedWithMatch = findingScore();
    missedWithMatch.judge_result = judgeResult({ classification: "missed" });
    const reviewWithMatch = reviewItem();
    reviewWithMatch.judge_result = judgeResult({ classification: "missed" });
    const cases: Array<[string, unknown, string]> = [
      [EVAL_MATRIX_SCHEMA_ID, [{ ...row, target_id: "other-target" }, { ...row }], "eval-matrix-identity-joins"],
      [
        EVAL_RUN_MANIFEST_SCHEMA_ID,
        { ...manifest, suite: { ...manifest.suite, run: { ...manifest.suite.run, runner_model_profile: "missing" } } },
        "eval-run-manifest-suite-joins"
      ],
      [
        EVAL_RUN_RECORD_SCHEMA_ID,
        { ...record, workflow: { ...record.workflow!, terminal: false } },
        "eval-run-record-lifecycle-coupling"
      ],
      [EVAL_RUN_SUMMARY_SCHEMA_ID, { ...runSummary, launched: 0 }, "eval-run-summary-count-coupling"],
      [
        EVAL_RUN_SUMMARY_SCHEMA_ID,
        { ...runSummary, records: [{ ...record, eval_run_id: "another-eval" }] },
        "eval-run-summary-record-lineage"
      ],
      [EVAL_FINDING_SCORE_SCHEMA_ID, missedWithMatch, "eval-finding-score-decision-coupling"],
      [EVAL_REVIEW_QUEUE_ITEM_SCHEMA_ID, reviewWithMatch, "eval-review-queue-decision-coupling"],
      [
        EVAL_SCORE_SUMMARY_SCHEMA_ID,
        { ...scoreSummary, rows: [{ ...scoreSummary.rows[0]!, finding_count: 2 }] },
        "eval-score-summary-count-coupling"
      ],
      [
        EVAL_SCORE_SUMMARY_SCHEMA_ID,
        { ...scoreSummary, rows: [{ ...scoreSummary.rows[0]!, variant_id: "missing" }] },
        "eval-score-summary-lineage"
      ]
    ];
    for (const [schemaId, value, gate] of cases) {
      expect(
        executeEvalSchemaSemanticGates(schemaId, value).map((issue) => issue.gate),
        gate
      ).toContain(gate);
    }
  });
});
