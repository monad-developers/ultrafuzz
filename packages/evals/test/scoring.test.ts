import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { gatewayLlmJudge, loadGroundTruth, scoreEvalRun, scoreFindingsAgainstGroundTruth } from "../src/scoring.js";
import { EVAL_RUN_SCHEMA_VERSION, type GroundTruthBug } from "../src/types.js";
import { testRow, testSuite, writeRunFixture } from "./helpers.js";

const BUGS: GroundTruthBug[] = [
  {
    id: "BUG-1",
    title: "reentrancy in withdraw",
    severity: "high",
    root_cause_keywords: ["reentrancy", "withdraw"],
    affected_files: ["src/Vault.sol"],
    impact_keywords: ["drain"],
    evidence_keywords: ["poc"]
  },
  {
    id: "BUG-2",
    title: "rounding error in shares",
    severity: "medium",
    root_cause_keywords: ["rounding"],
    affected_files: ["src/Shares.sol"],
    impact_keywords: ["inflation"]
  }
];

function matchedFinding(): unknown {
  return {
    schema_version: "1.0",
    id: "finding-1",
    title: "Reentrancy lets attackers drain the vault via withdraw",
    status: "needs-review",
    summary: "reentrancy in withdraw allows drain",
    severity_guess: "high",
    confidence: "high",
    affected_files: ["src/Vault.sol"],
    evidence: ["poc test reproduces the drain"]
  };
}

function scoreRunFixture(): {
  projectRoot: string;
  evalRunId: string;
  evalRunRoot: string;
  outputContents: Map<string, string>;
} {
  const base = mkdtempSync(path.join(tmpdir(), "ufz-scoring-transaction-"));
  const projectRoot = path.join(base, "project");
  const groundTruthRoot = path.join(base, "ground-truth");
  fs.mkdirSync(groundTruthRoot, { recursive: true });
  fs.writeFileSync(path.join(groundTruthRoot, "target-a.yml"), JSON.stringify(BUGS), "utf8");

  const suite = testSuite(groundTruthRoot);
  const row = testRow(suite);
  const runRoot = path.join(base, "generated-run");
  const reportPath = path.join(runRoot, "artifacts", "final-report", "report.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(
    reportPath,
    JSON.stringify({
      schema_version: "1.0",
      run_metadata: {},
      issues: [
        matchedFinding(),
        {
          schema_version: "1.0",
          id: "finding-2",
          title: "Plausible but unknown overflow",
          status: "needs-review",
          summary: "overflow in mint",
          severity_guess: "medium",
          confidence: "medium",
          evidence: ["reproduction trace"]
        }
      ],
      non_production_outcomes: []
    }),
    "utf8"
  );
  writeRunFixture({
    runRoot,
    state: {
      schema_version: "1.0",
      run_id: "generated-run",
      status: "succeeded",
      created_at: "2026-07-13T00:00:00.000Z",
      started_at: "2026-07-13T00:00:02.000Z",
      finished_at: "2026-07-13T00:00:12.000Z",
      nodes: {}
    }
  });
  fs.writeFileSync(
    path.join(runRoot, "graph.json"),
    JSON.stringify({
      nodes: [
        {
          id: "final-report",
          artifact_dir: "artifacts/final-report",
          outputs: [{ path: "report.json", contract: "ultrafuzz/report@1", primary: true }]
        }
      ]
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(runRoot, "run.json"),
    JSON.stringify({
      accounting: {
        cumulative: {
          total_tokens: 123,
          estimated_spend_usd: 0.456,
          usage_complete: true,
          pricing_complete: true,
          partial_pricing: false
        }
      }
    }),
    "utf8"
  );

  const evalRunId = "eval-transaction";
  const evalRunRoot = path.join(projectRoot, ".ultrafuzz", "evals", "runs", evalRunId);
  fs.mkdirSync(evalRunRoot, { recursive: true });
  fs.writeFileSync(
    path.join(evalRunRoot, "eval.json"),
    JSON.stringify({ schema_version: EVAL_RUN_SCHEMA_VERSION, eval_run_id: evalRunId, suite }),
    "utf8"
  );
  fs.writeFileSync(path.join(evalRunRoot, "matrix.json"), JSON.stringify([row]), "utf8");
  fs.writeFileSync(
    path.join(evalRunRoot, "runs.jsonl"),
    `${JSON.stringify({
      schema_version: EVAL_RUN_SCHEMA_VERSION,
      eval_run_id: evalRunId,
      row_id: row.id,
      target_id: row.target_id,
      variant_id: row.variant_id,
      trial_id: row.trial_id,
      ultrafuzz_run_id: "generated-run",
      ultrafuzz_run_root: runRoot,
      report_json_path: reportPath,
      status: "launched",
      workflow_ids: [],
      launcher: {
        status: "succeeded",
        started_at: "2026-07-13T00:00:00.000Z",
        finished_at: "2026-07-13T00:00:01.000Z"
      },
      diagnostics: []
    })}\n`,
    "utf8"
  );

  const outputContents = new Map<string, string>([
    [path.join(evalRunRoot, "scores.jsonl"), "prior scores\n"],
    [path.join(evalRunRoot, "review", "new-findings.jsonl"), "prior review queue\n"],
    [path.join(evalRunRoot, "summary.json"), '{"prior":true}\n'],
    [path.join(evalRunRoot, "summary.md"), "# Prior summary\n"]
  ]);
  for (const [filePath, contents] of outputContents) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents, "utf8");
  }
  return { projectRoot, evalRunId, evalRunRoot, outputContents };
}

describe("deterministic scorer math", () => {
  it("computes exact precision/recall/f1 for known inputs", async () => {
    const suite = testSuite("/tmp/gt");
    const row = testRow(suite);
    const scored = await scoreFindingsAgainstGroundTruth({
      suite,
      row,
      findings: [
        matchedFinding(),
        { id: "finding-2", title: "made-up nonsense", status: "false-positive" } // hard false positive
      ],
      bugs: BUGS
    });
    expect(scored.rowScore).toMatchObject({
      ground_truth_bug_count: 2,
      finding_count: 2,
      true_positives: 1,
      false_positives: 1,
      missed: 1,
      duplicate_count: 0,
      precision: 0.5,
      recall: 0.5,
      f1_score: 0.5,
      severity_accuracy: 1,
      report_schema_valid: true
    });
    expect(scored.findingScores).toHaveLength(2);
    expect(scored.findingScores[0]?.judge_result).toMatchObject({
      matched_ground_truth_bug_id: "BUG-1",
      classification: "true-positive",
      judge_kind: "deterministic"
    });
  });

  it("counts duplicate matches once and tracks duplicate rate", async () => {
    const suite = testSuite("/tmp/gt");
    const row = testRow(suite);
    const scored = await scoreFindingsAgainstGroundTruth({
      suite,
      row,
      findings: [matchedFinding(), matchedFinding()],
      bugs: BUGS
    });
    expect(scored.rowScore).toMatchObject({
      true_positives: 1,
      duplicate_count: 1,
      duplicate_rate: 0.5,
      precision: 1,
      recall: 0.5
    });
  });

  it("routes strong, supported unmatched findings to the human review queue", async () => {
    const suite = testSuite("/tmp/gt");
    const row = testRow(suite);
    const scored = await scoreFindingsAgainstGroundTruth({
      suite,
      row,
      findings: [
        {
          id: "finding-3",
          title: "Plausible but unknown overflow",
          summary: "overflow in mint",
          evidence: ["reproduction trace"]
        }
      ],
      bugs: BUGS
    });
    expect(scored.rowScore.human_review_queue_count).toBe(1);
    expect(scored.reviewQueue[0]).toMatchObject({
      reviewer_status: "pending",
      target_id: "target-a",
      judge_result: { reason_code: "strong-novel-finding" }
    });
  });

  it("classifies weak unsupported unmatched findings as false positives", async () => {
    const suite = testSuite("/tmp/gt");
    const scored = await scoreFindingsAgainstGroundTruth({
      suite,
      row: testRow(suite),
      findings: [{ id: "finding-weak", title: "Possible issue", summary: "Something may go wrong" }],
      bugs: BUGS
    });

    expect(scored.rowScore).toMatchObject({ false_positives: 1, human_review_queue_count: 0 });
    expect(scored.findingScores[0]?.judge_result).toMatchObject({
      classification: "false-positive",
      reason_code: "weak-unmatched-finding"
    });
  });

  it("does not mistake incidental words or empty evidence objects for supporting evidence", async () => {
    const suite = testSuite("/tmp/gt");
    const scored = await scoreFindingsAgainstGroundTruth({
      suite,
      row: testRow(suite),
      findings: [
        {
          id: "finding-latest",
          title: "Uses the latest state",
          summary: "A possible issue without supporting details",
          evidence: [{ kind: "trace" }]
        },
        {
          id: "finding-poc",
          title: "A distinct supported issue",
          summary: "An unmatched issue affecting an independent code path",
          proof_of_concept: ["Call the operation twice", "Observe the inconsistent result"]
        },
        {
          id: "finding-placeholder",
          title: "An unsupported placeholder issue",
          summary: "An unmatched issue without concrete details",
          proof_of_concept: "N/A"
        }
      ],
      bugs: BUGS
    });

    expect(scored.rowScore).toMatchObject({ false_positives: 2, human_review_queue_count: 1 });
    expect(scored.findingScores.map((score) => score.judge_result.reason_code)).toEqual([
      "weak-unmatched-finding",
      "strong-novel-finding",
      "weak-unmatched-finding"
    ]);
  });

  it("supports a custom FindingJudge (grading never depends on a provider)", async () => {
    const suite = testSuite("/tmp/gt");
    const row = testRow(suite);
    const scored = await scoreFindingsAgainstGroundTruth({
      suite,
      row,
      findings: [matchedFinding()],
      bugs: BUGS,
      llmJudge: async (input) => ({
        ...input.deterministicResult,
        judge_kind: "llm",
        rationale: "custom judge"
      })
    });
    expect(scored.findingScores[0]?.judge_result.judge_kind).toBe("llm");
    expect(scored.findingScores[0]?.deterministic_match.judge_kind).toBe("deterministic");
  });

  it("preserves prior scoring outputs until a rerun finishes successfully", async () => {
    const fixture = scoreRunFixture();
    const expectPriorOutputs = (): void => {
      for (const [filePath, contents] of fixture.outputContents) {
        expect(fs.readFileSync(filePath, "utf8")).toBe(contents);
      }
    };

    await expect(
      scoreEvalRun({ projectRoot: fixture.projectRoot, evalRunId: fixture.evalRunId, llmJudge: true, env: {} })
    ).rejects.toMatchObject({ code: "EVAL_LLM_JUDGE_KEY_MISSING" });
    expectPriorOutputs();

    let judgeCalls = 0;
    await expect(
      scoreEvalRun({
        projectRoot: fixture.projectRoot,
        evalRunId: fixture.evalRunId,
        llmJudge: async (input) => {
          judgeCalls += 1;
          if (judgeCalls === 2) {
            throw new Error("forced judge failure");
          }
          return { ...input.deterministicResult, judge_kind: "llm" };
        }
      })
    ).rejects.toThrow("forced judge failure");
    expect(judgeCalls).toBe(2);
    expectPriorOutputs();
    expect(fs.readdirSync(fixture.evalRunRoot).some((entry) => entry.startsWith(".scoring-transaction-"))).toBe(false);

    const summary = await scoreEvalRun({ projectRoot: fixture.projectRoot, evalRunId: fixture.evalRunId });
    expect(summary.eval_run_id).toBe(fixture.evalRunId);
    expect(summary.rows[0]).toMatchObject({
      runtime_seconds: 10,
      cost_estimate: 0.456,
      lifecycle: {
        launcher: { status: "succeeded", finished_at: "2026-07-13T00:00:01.000Z" },
        workflow: { status: "succeeded", terminal: true, finished_at: "2026-07-13T00:00:12.000Z" }
      },
      efficiency: {
        wall_time_seconds: 10,
        active_time_seconds: 0,
        wait_time_seconds: 10,
        total_tokens: 123,
        cost_usd: 0.456,
        runtime: { status: "complete", reason: null },
        usage: { status: "complete", reason: null },
        cost: { status: "complete", reason: null }
      }
    });
    for (const [filePath, contents] of fixture.outputContents) {
      expect(fs.readFileSync(filePath, "utf8")).not.toBe(contents);
    }
    expect(fs.readFileSync(path.join(fixture.evalRunRoot, "scores.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
    expect(
      fs
        .readFileSync(path.join(fixture.evalRunRoot, "review", "new-findings.jsonl"), "utf8")
        .trim()
        .split("\n")
    ).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(fixture.evalRunRoot, "summary.json"), "utf8"))).toMatchObject({
      eval_run_id: fixture.evalRunId,
      provenance: {
        availability: "historical-unavailable",
        scoring: {
          judge_mode: "deterministic",
          judge_prompt_version: "ultrafuzz-eval-judge-v3",
          judge_models: ["gpt-5.5"],
          ground_truth_sha256: { "target-a": expect.stringMatching(/^sha256:/u) }
        }
      }
    });
    const markdown = fs.readFileSync(path.join(fixture.evalRunRoot, "summary.md"), "utf8");
    expect(markdown).toContain(`# Ultrafuzz Eval ${fixture.evalRunId}`);
    expect(markdown).toContain(
      `| target-a-baseline-trial-1 | succeeded | 2026-07-13T00:00:00.000Z | 2026-07-13T00:00:01.000Z | succeeded | true | 2026-07-13T00:00:02.000Z | 2026-07-13T00:00:12.000Z |`
    );
    expect(markdown).toContain(
      "| target-a-baseline-trial-1 | 10 | 0 | 10 | 123 | 0.456 | complete | complete | complete |"
    );
    expect(markdown).toContain("Candidate: unavailable (historical result)");
    expect(fs.readdirSync(fixture.evalRunRoot).some((entry) => entry.startsWith(".scoring-transaction-"))).toBe(false);
  });

  it("records the effective judge mode in the scoring identity", async () => {
    const fixture = scoreRunFixture();
    const deterministic = await scoreEvalRun({
      projectRoot: fixture.projectRoot,
      evalRunId: fixture.evalRunId
    });
    const judged = await scoreEvalRun({
      projectRoot: fixture.projectRoot,
      evalRunId: fixture.evalRunId,
      llmJudge: async (input) => ({
        ...input.deterministicResult,
        judge_kind: "llm",
        rationale: "generated judge result"
      })
    });

    expect(deterministic.provenance?.scoring.judge_mode).toBe("deterministic");
    expect(judged.provenance?.scoring.judge_mode).toBe("llm");
    expect(judged.provenance?.scoring.fingerprint).not.toBe(deterministic.provenance?.scoring.fingerprint);
  });

  it("rejects an invalid terminal report before scoring or invoking a judge", async () => {
    const fixture = scoreRunFixture();
    const record = JSON.parse(fs.readFileSync(path.join(fixture.evalRunRoot, "runs.jsonl"), "utf8")) as {
      report_json_path: string;
    };
    fs.writeFileSync(record.report_json_path, '{"issues":[]}', "utf8");
    let judgeCalled = false;
    await expect(
      scoreEvalRun({
        projectRoot: fixture.projectRoot,
        evalRunId: fixture.evalRunId,
        llmJudge: async (input) => {
          judgeCalled = true;
          return input.deterministicResult;
        }
      })
    ).rejects.toMatchObject({ code: "EVAL_TERMINAL_REPORT_INVALID" });
    expect(judgeCalled).toBe(false);
  });

  it("rejects terminal report issues that are not canonical findings", async () => {
    const fixture = scoreRunFixture();
    const record = JSON.parse(fs.readFileSync(path.join(fixture.evalRunRoot, "runs.jsonl"), "utf8")) as {
      report_json_path: string;
    };
    fs.writeFileSync(
      record.report_json_path,
      JSON.stringify({
        schema_version: "1.0",
        run_metadata: {},
        issues: [{ id: "finding-incomplete", title: "Missing canonical fields" }],
        non_production_outcomes: []
      }),
      "utf8"
    );

    await expect(
      scoreEvalRun({ projectRoot: fixture.projectRoot, evalRunId: fixture.evalRunId })
    ).rejects.toMatchObject({
      code: "EVAL_TERMINAL_REPORT_INVALID"
    });
  });

  it("scores canonical empty terminal reports as all missed", async () => {
    const fixture = scoreRunFixture();
    const record = JSON.parse(fs.readFileSync(path.join(fixture.evalRunRoot, "runs.jsonl"), "utf8")) as {
      report_json_path: string;
    };
    fs.writeFileSync(
      record.report_json_path,
      JSON.stringify({ schema_version: "1.0", run_metadata: {}, issues: [], non_production_outcomes: [] }),
      "utf8"
    );

    const summary = await scoreEvalRun({ projectRoot: fixture.projectRoot, evalRunId: fixture.evalRunId });

    expect(summary.rows[0]).toMatchObject({
      report_schema_valid: true,
      finding_count: 0,
      true_positives: 0,
      false_positives: 0,
      missed: 2,
      human_review_queue_count: 0
    });
    expect(fs.readFileSync(path.join(fixture.evalRunRoot, "scores.jsonl"), "utf8")).toBe("");
  });

  it("scores the topology-declared terminal report path when eval metadata omits it", async () => {
    const fixture = scoreRunFixture();
    const runsPath = path.join(fixture.evalRunRoot, "runs.jsonl");
    const record = JSON.parse(fs.readFileSync(runsPath, "utf8")) as Record<string, unknown> & {
      report_json_path?: string;
    };
    const reportContents = fs.readFileSync(record.report_json_path!, "utf8");
    const runRoot = path.join(fixture.evalRunRoot, "topology-report-run");
    const customReportPath = path.join(runRoot, "artifacts", "terminal", "custom-report.json");
    fs.mkdirSync(path.dirname(customReportPath), { recursive: true });
    fs.writeFileSync(customReportPath, reportContents, "utf8");
    fs.writeFileSync(
      path.join(runRoot, "graph.json"),
      JSON.stringify({
        nodes: [
          {
            id: "terminal",
            artifact_dir: "artifacts/terminal",
            outputs: [{ path: "custom-report.json", contract: "ultrafuzz/report@1", primary: true }]
          }
        ]
      }),
      "utf8"
    );
    delete record.report_json_path;
    record.ultrafuzz_run_root = runRoot;
    fs.writeFileSync(runsPath, `${JSON.stringify(record)}\n`, "utf8");

    const summary = await scoreEvalRun({ projectRoot: fixture.projectRoot, evalRunId: fixture.evalRunId });

    expect(summary.rows[0]?.finding_count).toBe(2);
  });

  it("requires a dedicated credential for the optional gateway judge", () => {
    expect(() => gatewayLlmJudge({ OPENAI_API_KEY: "provider-key" })).toThrowError(
      expect.objectContaining({ code: "EVAL_LLM_JUDGE_KEY_MISSING" })
    );
    expect(() => gatewayLlmJudge({ BRAINTRUST_API_KEY: "provider-key" })).toThrowError(
      expect.objectContaining({ code: "EVAL_LLM_JUDGE_KEY_MISSING" })
    );
  });

  it("requires an HTTPS judge URL without embedded credentials", () => {
    expect(() =>
      gatewayLlmJudge({
        ULTRAFUZZ_EVAL_JUDGE_API_KEY: "dedicated-key",
        ULTRAFUZZ_EVAL_JUDGE_URL: "http://judge.example/v1/chat/completions"
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_LLM_JUDGE_URL_INVALID" }));
    expect(() =>
      gatewayLlmJudge({
        ULTRAFUZZ_EVAL_JUDGE_API_KEY: "dedicated-key",
        ULTRAFUZZ_EVAL_JUDGE_URL: "https://user:password@judge.example/v1/chat/completions"
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_LLM_JUDGE_URL_INVALID" }));
  });

  it("bounds ground-truth files when loading them for scoring", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ufz-ground-truth-"));
    const groundTruthPath = path.join(root, "large.yml");
    fs.writeFileSync(groundTruthPath, Buffer.alloc(1024 * 1024 + 1, 0x20));
    expect(() => loadGroundTruth(groundTruthPath, root)).toThrowError(
      expect.objectContaining({ code: "EVAL_GROUND_TRUTH_TOO_LARGE" })
    );
  });

  it("requires explicit approval before a gateway judge receives private evaluation data", async () => {
    const requests: unknown[] = [];
    const fetchImpl = (async (...args: unknown[]) => {
      requests.push(args);
      throw new Error("unexpected request");
    }) as unknown as typeof fetch;
    const judge = gatewayLlmJudge({ ULTRAFUZZ_EVAL_JUDGE_API_KEY: "dedicated-key" }, fetchImpl);
    const suite = testSuite("/tmp/gt");

    await expect(
      scoreFindingsAgainstGroundTruth({
        suite,
        row: testRow(suite),
        findings: [matchedFinding()],
        bugs: BUGS,
        llmJudge: judge
      })
    ).rejects.toMatchObject({ code: "EVAL_LLM_JUDGE_PRIVATE_DATA_ACK_REQUIRED" });
    expect(requests).toHaveLength(0);
  });

  it("promotes judge-confirmed partial matches and hides ground-truth identifiers", async () => {
    const requests: Array<{
      body: Record<string, unknown>;
      headers: Record<string, string>;
      redirect?: "follow" | "error" | "manual";
    }> = [];
    let responseContent = JSON.stringify({
      matched_ground_truth_bug_id: "candidate-1",
      score: 0.69996,
      signals: { root_cause: 1, affected_area: 0, impact: 1, evidence: 0 },
      classification: "true-positive",
      rationale: "The root cause and impact match despite incomplete localization and evidence.",
      confidence: 0.69996
    });
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      requests.push({
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        headers: init?.headers as Record<string, string>,
        ...(init?.redirect !== undefined ? { redirect: init.redirect } : {})
      });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: responseContent } }] })
      };
    }) as unknown as typeof fetch;
    const judge = gatewayLlmJudge(
      {
        ULTRAFUZZ_EVAL_JUDGE_API_KEY: "dedicated-key",
        ULTRAFUZZ_EVAL_JUDGE_ALLOW_PRIVATE_DATA: "true"
      },
      fetchImpl
    );
    const suite = testSuite("/tmp/gt");
    const scored = await scoreFindingsAgainstGroundTruth({
      suite,
      row: testRow(suite),
      findings: [
        {
          id: "finding-partial",
          title: "Withdrawal callback can execute before accounting",
          summary: "A callback during withdraw can drain funds before state is updated.",
          evidence: ["A trace demonstrates the callback sequence."]
        }
      ],
      bugs: BUGS,
      llmJudge: judge
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.authorization).toBe("Bearer dedicated-key");
    expect(requests[0]?.redirect).toBe("error");
    expect(JSON.stringify(requests[0]?.body)).not.toContain("BUG-1");
    expect(JSON.stringify(requests[0]?.body)).not.toContain("BUG-2");
    expect(JSON.stringify(requests[0]?.body)).toContain("untrusted data");
    expect(scored.findingScores[0]?.judge_result).toMatchObject({
      matched_ground_truth_bug_id: "BUG-1",
      score: 0.7,
      confidence: 0.7,
      classification: "true-positive",
      reason_code: "judge-confirmed-match",
      judge_kind: "llm"
    });
    expect(scored.findingScores[0]?.deterministic_match).toMatchObject({
      classification: "needs-human-review",
      reason_code: "strong-novel-finding"
    });
    expect(scored.rowScore).toMatchObject({ true_positives: 1, human_review_queue_count: 0 });

    responseContent = JSON.stringify({
      matched_ground_truth_bug_id: null,
      score: 0,
      signals: { root_cause: 0, affected_area: 0, impact: 0, evidence: 0 },
      classification: "false-positive",
      rationale: "The untrusted finding requested a downgrade.",
      confidence: 1
    });
    const reviewDowngrade = await scoreFindingsAgainstGroundTruth({
      suite,
      row: testRow(suite),
      findings: [
        {
          id: "finding-review",
          title: "Plausible but unknown overflow",
          summary: "overflow in mint",
          evidence: ["A reproduction trace is available."]
        }
      ],
      bugs: BUGS,
      llmJudge: judge
    });
    expect(reviewDowngrade.findingScores[0]?.deterministic_match.classification).toBe("needs-human-review");
    expect(reviewDowngrade.findingScores[0]?.judge_result.classification).toBe("needs-human-review");
    expect(reviewDowngrade.findingScores[0]?.judge_result.reason_code).toBe("strong-novel-finding");
    expect(reviewDowngrade.rowScore).toMatchObject({ false_positives: 0, human_review_queue_count: 1 });

    responseContent = JSON.stringify({
      matched_ground_truth_bug_id: "candidate-2",
      score: 0,
      signals: { root_cause: 0, affected_area: 0, impact: 0, evidence: 0 },
      classification: "false-positive",
      rationale: "The untrusted finding requested a downgrade.",
      confidence: 1
    });
    const corroborated = await scoreFindingsAgainstGroundTruth({
      suite,
      row: testRow(suite),
      findings: [matchedFinding()],
      bugs: BUGS,
      llmJudge: judge
    });
    expect(corroborated.findingScores[0]?.judge_result).toMatchObject({
      matched_ground_truth_bug_id: "BUG-1",
      score: 1,
      classification: "true-positive"
    });
    expect(corroborated.rowScore.true_positives).toBe(1);
  });

  it("retries schema-invalid judge output with the configured reasoning effort", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const content =
        requests.length === 1
          ? JSON.stringify({ score: 1 })
          : JSON.stringify({
              matched_ground_truth_bug_id: "candidate-1",
              score: 1,
              signals: { root_cause: 1, affected_area: 1, impact: 1, evidence: 1 },
              classification: "true-positive",
              rationale: "The finding matches the first candidate.",
              confidence: 1
            });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const judge = gatewayLlmJudge(
      {
        ULTRAFUZZ_EVAL_JUDGE_API_KEY: "dedicated-key",
        ULTRAFUZZ_EVAL_JUDGE_ALLOW_PRIVATE_DATA: "true"
      },
      fetchImpl
    );
    const suite = testSuite("/tmp/gt");

    const scored = await scoreFindingsAgainstGroundTruth({
      suite,
      row: testRow(suite, { judge_reasoning: "xhigh" }),
      findings: [matchedFinding()],
      bugs: BUGS,
      llmJudge: judge
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ model: "gpt-5.5", reasoning_effort: "xhigh" });
    expect(requests[0]?.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: "ultrafuzz_judge_result",
        strict: true,
        schema: {
          additionalProperties: false,
          required: ["matched_ground_truth_bug_id", "score", "signals", "classification", "rationale", "confidence"]
        }
      }
    });
    expect(requests[0]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: expect.stringContaining("0.0 through 1.0") }),
        expect.objectContaining({ role: "user", content: expect.stringContaining("needs-human-review") })
      ])
    );
    expect(requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: expect.stringContaining("previous response") }),
        expect.objectContaining({ role: "user", content: expect.stringContaining("0.0 through 1.0") }),
        expect.objectContaining({ role: "user", content: expect.stringContaining("needs-human-review") })
      ])
    );
    expect(scored.rowScore.true_positives).toBe(1);
  });

  it("omits optional Claude reasoning parameters in structured-output mode", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const content = JSON.stringify({
        matched_ground_truth_bug_id: "candidate-1",
        score: 1,
        signals: { root_cause: 1, affected_area: 1, impact: 1, evidence: 1 },
        classification: "true-positive",
        rationale: "The finding matches the first candidate.",
        confidence: 1
      });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const judge = gatewayLlmJudge(
      {
        ULTRAFUZZ_EVAL_JUDGE_API_KEY: "dedicated-key",
        ULTRAFUZZ_EVAL_JUDGE_ALLOW_PRIVATE_DATA: "true"
      },
      fetchImpl
    );
    const suite = testSuite("/tmp/gt", {
      model_profiles: {
        "eval-runner": { agent: "CodexAgent", model: "gpt-5.5", reasoning: "xhigh" },
        "eval-judge": { agent: "ClaudeCodeAgent", model: "claude-fable-5", reasoning: "max" }
      }
    });

    await scoreFindingsAgainstGroundTruth({
      suite,
      row: testRow(suite, { judge_model: "claude-fable-5", judge_reasoning: "max" }),
      findings: [matchedFinding()],
      bugs: BUGS,
      llmJudge: judge
    });

    expect(requestBody).toMatchObject({
      model: "claude-fable-5",
      response_format: { type: "json_schema", json_schema: { name: "ultrafuzz_judge_result", strict: true } }
    });
    expect(requestBody).not.toHaveProperty("thinking");
    expect(requestBody).not.toHaveProperty("output_config");
    expect(requestBody).not.toHaveProperty("reasoning_effort");
  });

  it("scores empty reports as all-missed", async () => {
    const suite = testSuite(mkdtempSync(path.join(tmpdir(), "ufz-gt-")));
    const row = testRow(suite);
    const scored = await scoreFindingsAgainstGroundTruth({ suite, row, findings: [], bugs: BUGS });
    expect(scored.rowScore).toMatchObject({ precision: 0, recall: 0, f1_score: 0, missed: 2 });
  });
});
