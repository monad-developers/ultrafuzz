import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { gatewayLlmJudge, loadGroundTruth, scoreEvalRun, scoreFindingsAgainstGroundTruth } from "../src/scoring.js";
import type { GroundTruthBug } from "../src/types.js";
import {
  cleanRecoveryEquivalence,
  currentEvalRunRecord,
  currentPlannedGraph,
  currentRunManifest,
  currentRunState,
  initializeTestGitRepository,
  testRow,
  testSuite,
  writeCurrentRunEvidence
} from "./helpers.js";

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

function canonicalFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "ultrafuzz.finding.v2",
    id: "finding-1",
    title: "Canonical finding",
    status: "needs-review",
    summary: "A complete finding used by the scoring fixtures.",
    severity_guess: "High",
    confidence: "high",
    triage_classification: "true-positive",
    recommended_next_action: "Fix the affected code path.",
    affected_files: ["src/Target.sol"],
    evidence: ["A focused proof reproduces the issue."],
    severity: "High",
    impact: "High",
    likelihood: "High",
    impact_rationale: "Successful exploitation causes a material loss.",
    likelihood_rationale: "An untrusted caller can reach the affected path.",
    severity_rationale: "High impact and likelihood make this a high-severity issue.",
    description: "The affected path violates an intended security invariant.",
    proof_of_concept: {
      scenario: ["Invoke the affected path with attacker-controlled input.", "Observe the invariant violation."],
      language: "text",
      code: "reproduce();"
    },
    lifecycle: { dedupe_key: "finding-1", source_artifacts: [], strategy_hits: [] },
    ...overrides
  };
}

function matchedFinding(): unknown {
  return canonicalFinding({
    title: "Reentrancy lets attackers drain the vault via withdraw",
    summary: "reentrancy in withdraw allows drain",
    recommended_next_action: "Fix the reentrant withdrawal path.",
    affected_files: ["src/Vault.sol"],
    evidence: ["poc test reproduces the drain"],
    description: "The withdrawal path transfers control before its balance update.",
    lifecycle: { dedupe_key: "finding-1", source_artifacts: [], strategy_hits: [] }
  });
}

function canonicalReport(issues: unknown[]): Record<string, unknown> {
  return {
    schema_version: "ultrafuzz.report.v2",
    run_metadata: {
      run_id: "generated-run",
      source_run_id: "generated-run",
      repository: "https://example.com/target-a",
      elapsed_time: "10s",
      models_used: ["gpt-test"],
      tokens_used: "123",
      estimated_spend: "$0.456",
      partial_pricing: false,
      strategy_loops: 1
    },
    issues,
    non_production_outcomes: [],
    property_provenance: []
  };
}

async function scoreInMemory(
  input: Omit<Parameters<typeof scoreFindingsAgainstGroundTruth>[0], "record"> & {
    record?: Parameters<typeof scoreFindingsAgainstGroundTruth>[0]["record"];
  }
) {
  const { record, ...scoreInput } = input;
  if (record !== undefined) return scoreFindingsAgainstGroundTruth({ ...scoreInput, record });
  const runRoot = mkdtempSync(path.join(tmpdir(), "ufz-scoring-inline-run-"));
  const runId = path.basename(runRoot).slice(0, 100);
  writeCurrentRunEvidence({
    runRoot,
    runId,
    state: currentRunState({ runId, nodes: { "final-report": {} } }),
    graph: currentPlannedGraph()
  });
  return scoreFindingsAgainstGroundTruth({
    ...scoreInput,
    record: currentEvalRunRecord({ row: scoreInput.row, runRoot, runId })
  });
}

function scoreRunFixture(): {
  projectRoot: string;
  evalRunId: string;
  evalRunRoot: string;
  groundTruthPath: string;
  outputContents: Map<string, string>;
} {
  const base = mkdtempSync(path.join(tmpdir(), "ufz-scoring-transaction-"));
  const projectRoot = path.join(base, "project");
  initializeTestGitRepository(projectRoot);
  const groundTruthRoot = path.join(base, "ground-truth");
  fs.mkdirSync(groundTruthRoot, { recursive: true });
  fs.writeFileSync(
    path.join(groundTruthRoot, "target-a.yml"),
    JSON.stringify({
      schema_version: "ultrafuzz.eval-ground-truth.v1",
      subject: {
        repository: "https://example.com/target-a",
        revision: "0123456789abcdef0123456789abcdef01234567"
      },
      bugs: BUGS
    }),
    "utf8"
  );

  const suite = testSuite(groundTruthRoot, {
    targets: [
      {
        id: "target-a",
        repo: "https://example.com/target-a",
        ref: "0123456789abcdef0123456789abcdef01234567",
        sensitivity: "private",
        ground_truth: "target-a.yml"
      }
    ]
  });
  const row = testRow(suite);
  const runRoot = path.join(base, "generated-run");
  const reportPath = path.join(runRoot, "artifacts", "final-report", "report.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      canonicalReport([
        matchedFinding(),
        canonicalFinding({
          id: "finding-2",
          title: "Plausible but unknown overflow",
          summary: "overflow in mint",
          severity_guess: "Medium",
          severity: "Medium",
          impact: "Medium",
          likelihood: "Medium",
          confidence: "medium",
          triage_classification: "undetermined",
          recommended_next_action: "Review the overflow trace.",
          evidence: ["reproduction trace"],
          description: "The mint path may overflow an intermediate value.",
          impact_rationale: "An overflow could corrupt minted balances.",
          likelihood_rationale: "The boundary input is reachable but constrained.",
          severity_rationale: "Moderate impact and likelihood make this medium severity.",
          lifecycle: { dedupe_key: "finding-2", source_artifacts: [], strategy_hits: [] }
        })
      ])
    ),
    "utf8"
  );
  writeCurrentRunEvidence({
    runRoot,
    runId: "generated-run",
    state: currentRunState({ runId: "generated-run", nodes: { "final-report": {} } }),
    graph: currentPlannedGraph(),
    accounting: {
      total_tokens: 123,
      estimated_spend_usd: 0.456,
      usage_complete: true,
      pricing_complete: true,
      partial_pricing: false
    }
  });

  const evalRunId = "eval-transaction";
  const evalRunRoot = path.join(projectRoot, ".ultrafuzz", "evals", "runs", evalRunId);
  fs.mkdirSync(evalRunRoot, { recursive: true });
  fs.writeFileSync(
    path.join(evalRunRoot, "eval.json"),
    JSON.stringify(currentRunManifest({ suite, projectRoot, evalRunId })),
    "utf8"
  );
  fs.writeFileSync(path.join(evalRunRoot, "matrix.json"), JSON.stringify([row]), "utf8");
  fs.writeFileSync(
    path.join(evalRunRoot, "runs.jsonl"),
    `${JSON.stringify(currentEvalRunRecord({ row, runRoot, runId: "generated-run", evalRunId }))}\n`,
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
  return {
    projectRoot,
    evalRunId,
    evalRunRoot,
    groundTruthPath: path.join(groundTruthRoot, "target-a.yml"),
    outputContents
  };
}

describe("deterministic scorer math", () => {
  it("fails closed before emitting metrics when private subject binding mismatches", async () => {
    const fixture = scoreRunFixture();
    const groundTruthPath = fixture.groundTruthPath;
    const document = JSON.parse(fs.readFileSync(groundTruthPath, "utf8")) as Record<string, unknown>;
    document.subject = {
      repository: "https://github.com/example/fork",
      revision: "0123456789abcdef0123456789abcdef01234567"
    };
    fs.writeFileSync(groundTruthPath, JSON.stringify(document), "utf8");

    await expect(
      scoreEvalRun({ projectRoot: fixture.projectRoot, evalRunId: "eval-transaction" })
    ).rejects.toMatchObject({
      code: "EVAL_GROUND_TRUTH_SUBJECT_REPOSITORY_MISMATCH"
    });
    expect(fs.existsSync(path.join(fixture.evalRunRoot, "summary.json"))).toBe(true);
  });

  it("requires a validated subject for private in-memory scoring", async () => {
    const suite = testSuite("/tmp/gt", {
      targets: [
        {
          id: "target-a",
          repo: "https://example.com/target-a",
          ref: "0123456789abcdef0123456789abcdef01234567",
          sensitivity: "private",
          ground_truth: "target-a.yml"
        }
      ]
    });

    await expect(
      scoreInMemory({
        suite,
        row: testRow(suite),
        findings: [],
        bugs: BUGS
      })
    ).rejects.toMatchObject({ code: "EVAL_GROUND_TRUTH_SUBJECT_MISSING" });
  });

  it("revalidates the subject on private in-memory scoring", async () => {
    const suite = testSuite("/tmp/gt", {
      targets: [
        {
          id: "target-a",
          repo: "https://example.com/target-a",
          ref: "0123456789abcdef0123456789abcdef01234567",
          sensitivity: "private",
          ground_truth: "target-a.yml"
        }
      ]
    });

    await expect(
      scoreInMemory({
        suite,
        row: testRow(suite),
        findings: [],
        bugs: BUGS,
        groundTruthSubject: {
          repository: "https://github.com/example/fork",
          revision: "0123456789abcdef0123456789abcdef01234567"
        }
      })
    ).rejects.toMatchObject({ code: "EVAL_GROUND_TRUTH_SUBJECT_REPOSITORY_MISMATCH" });
  });

  it("fails closed when the private subject names another immutable revision", async () => {
    const fixture = scoreRunFixture();
    const document = JSON.parse(fs.readFileSync(fixture.groundTruthPath, "utf8")) as {
      subject: { revision: string };
    };
    document.subject.revision = "f".repeat(40);
    fs.writeFileSync(fixture.groundTruthPath, JSON.stringify(document), "utf8");

    await expect(
      scoreEvalRun({ projectRoot: fixture.projectRoot, evalRunId: "eval-transaction" })
    ).rejects.toMatchObject({
      code: "EVAL_GROUND_TRUTH_SUBJECT_REVISION_MISMATCH"
    });
  });

  it("does not persist a recovery snapshot while the workflow is running", async () => {
    const fixture = scoreRunFixture();
    const runsPath = path.join(fixture.evalRunRoot, "runs.jsonl");
    const record = JSON.parse(fs.readFileSync(runsPath, "utf8")) as Record<string, unknown> & {
      ultrafuzz_run_root: string;
    };
    delete record.recovery_equivalence;
    fs.writeFileSync(runsPath, `${JSON.stringify(record)}\n`, "utf8");
    const statePath = path.join(record.ultrafuzz_run_root, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(statePath, JSON.stringify({ ...state, status: "running", finished_at: undefined }), "utf8");

    await expect(
      scoreEvalRun({ projectRoot: fixture.projectRoot, evalRunId: fixture.evalRunId })
    ).rejects.toMatchObject({ code: "EVAL_RECOVERY_EQUIVALENCE_NOT_FINAL" });

    const records = fs
      .readFileSync(runsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { recovery_equivalence?: unknown });
    expect(records).toHaveLength(1);
    expect(records[0]).not.toHaveProperty("recovery_equivalence");
  });

  it.each([
    ["include", 1, 0, 0],
    ["exclude", 0, 1, 0],
    ["separate", 0, 1, 1]
  ] as const)(
    "%s mode exposes non-comparable rows without silently dropping them",
    async (mode, included, excluded, separateRows) => {
      const fixture = scoreRunFixture();
      const manifestPath = path.join(fixture.evalRunRoot, "eval.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        suite: ReturnType<typeof testSuite>;
      };
      manifest.suite.recovery_equivalence = {
        max_repeated_model_executions: 0,
        aggregate_non_comparable: mode,
        publication: "comparable"
      };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
      const runsPath = path.join(fixture.evalRunRoot, "runs.jsonl");
      const record = JSON.parse(fs.readFileSync(runsPath, "utf8")) as Record<string, unknown>;
      fs.writeFileSync(
        runsPath,
        `${JSON.stringify({
          ...record,
          recovery_equivalence: cleanRecoveryEquivalence({
            classification: "non-comparable",
            reason: "generated untraceable recovery"
          })
        })}\n`,
        "utf8"
      );

      const summary = await scoreEvalRun({ projectRoot: fixture.projectRoot, evalRunId: fixture.evalRunId });

      expect(summary.recovery_equivalence).toMatchObject({
        aggregate_non_comparable: mode,
        included_row_count: included,
        excluded_row_count: excluded,
        classification_counts: { "non-comparable": 1 }
      });
      expect(summary.variants.reduce((total, variant) => total + variant.row_count, 0)).toBe(included);
      expect(
        summary.recovery_equivalence.non_comparable_variants.reduce((total, variant) => total + variant.row_count, 0)
      ).toBe(separateRows);
    }
  );

  it("computes exact precision/recall/f1 for known inputs", async () => {
    const suite = testSuite("/tmp/gt");
    const row = testRow(suite);
    const scored = await scoreInMemory({
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
    const scored = await scoreInMemory({
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
    const scored = await scoreInMemory({
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
    const scored = await scoreInMemory({
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
    const scored = await scoreInMemory({
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
        },
        {
          id: "finding-minimal",
          title: "An unsupported minimal issue",
          summary: "An unmatched issue without substantive details",
          proof_of_concept: "yes"
        },
        {
          id: "finding-reference",
          title: "A supported issue with a compact reference",
          summary: "An unmatched issue with a source reference",
          evidence: [{ path: "A.sol" }]
        }
      ],
      bugs: BUGS
    });

    expect(scored.rowScore).toMatchObject({ false_positives: 3, human_review_queue_count: 2 });
    expect(scored.findingScores.map((score) => score.judge_result.reason_code)).toEqual([
      "weak-unmatched-finding",
      "strong-novel-finding",
      "weak-unmatched-finding",
      "weak-unmatched-finding",
      "strong-novel-finding"
    ]);
  });

  it("supports a custom FindingJudge (grading never depends on a provider)", async () => {
    const suite = testSuite("/tmp/gt", { judge_panel: { total: 1, quorum: 1 } });
    const row = testRow(suite);
    const scored = await scoreInMemory({
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
    expect(scored.findingScores[0]?.judge_result).toMatchObject({
      rationale: "custom judge",
      panel: {
        total: 1,
        quorum: 1,
        model: "gpt-5.5",
        prompt_version: "ultrafuzz-eval-judge-v9-independent-semantic-boundary-family",
        aggregate_decision: { votes: 1 },
        member_votes: [{ member: 1, rationale: "custom judge" }]
      }
    });
  });

  it("uses three fresh default members and accepts an exact normalized 2-of-3 decision", async () => {
    const suite = testSuite("/tmp/gt");
    let calls = 0;
    const observedInputs: string[] = [];
    const scored = await scoreInMemory({
      suite,
      row: testRow(suite),
      findings: [{ id: "finding-default-panel", title: "Possible issue", summary: "A partial match" }],
      bugs: BUGS,
      llmJudge: async (input) => {
        const member = calls++;
        observedInputs.push(JSON.stringify(input));
        const agreed = member < 2;
        return {
          ...input.deterministicResult,
          ...(agreed ? { matched_ground_truth_bug_id: "BUG-1" } : {}),
          score: agreed ? 0.8 : 0.1,
          classification: agreed ? ("true-positive" as const) : ("false-positive" as const),
          reason_code: agreed ? ("judge-confirmed-match" as const) : ("weak-unmatched-finding" as const),
          rationale: `default member ${member + 1}`,
          confidence: 0.9,
          judge_kind: "llm" as const
        };
      }
    });

    expect(calls).toBe(3);
    expect(new Set(observedInputs)).toHaveLength(1);
    expect(scored.findingScores[0]?.judge_result).toMatchObject({
      classification: "true-positive",
      matched_ground_truth_bug_id: "BUG-1",
      panel: {
        total: 3,
        quorum: 2,
        aggregate_decision: { classification: "true-positive", votes: 2 },
        member_votes: [{ member: 1 }, { member: 2 }, { member: 3 }]
      }
    });
  });

  it("routes a default three-way normalized-decision split to human review", async () => {
    const suite = testSuite("/tmp/gt");
    let calls = 0;
    const scored = await scoreInMemory({
      suite,
      row: testRow(suite),
      findings: [{ id: "finding-three-way", title: "Possible issue", summary: "A partial match" }],
      bugs: BUGS,
      llmJudge: async (input) => {
        const member = calls++;
        const bugId = member === 0 ? "BUG-1" : member === 1 ? "BUG-2" : undefined;
        return {
          ...input.deterministicResult,
          ...(bugId === undefined ? {} : { matched_ground_truth_bug_id: bugId }),
          score: bugId === undefined ? 0.1 : 0.8,
          classification: bugId === undefined ? ("false-positive" as const) : ("true-positive" as const),
          reason_code: bugId === undefined ? ("weak-unmatched-finding" as const) : ("judge-confirmed-match" as const),
          rationale: `three-way member ${member + 1}`,
          confidence: 0.9,
          judge_kind: "llm" as const
        };
      }
    });

    expect(calls).toBe(3);
    expect(scored.reviewQueue[0]?.judge_result).toMatchObject({
      classification: "needs-human-review",
      reason_code: "panel-disagreement",
      rationale: "Judge panel disagreement: no identical decision reached quorum (2 of 3).",
      panel: {
        total: 3,
        quorum: 2,
        aggregate_decision: { classification: "needs-human-review", votes: 1 }
      }
    });
    expect(scored.reviewQueue[0]?.judge_result.panel?.vote_split).toHaveLength(3);
  });

  it("aggregates a 3-of-4 panel agreement and preserves every independent vote", async () => {
    const suite = testSuite("/tmp/gt", { judge_panel: { total: 4, quorum: 3 } });
    let calls = 0;
    const observedInputs: string[] = [];
    const scored = await scoreInMemory({
      suite,
      row: testRow(suite, { judge_reasoning: "xhigh" }),
      findings: [{ id: "finding-panel", title: "Possible issue", summary: "A partial match" }],
      bugs: BUGS,
      llmJudge: async (input) => {
        const member = calls;
        calls += 1;
        observedInputs.push(JSON.stringify(input));
        const agreed = member < 3;
        return {
          ...input.deterministicResult,
          ...(agreed ? { matched_ground_truth_bug_id: "BUG-1" } : {}),
          score: agreed ? 0.8 : 0.1,
          classification: agreed ? "true-positive" : "false-positive",
          reason_code: agreed ? "judge-confirmed-match" : "weak-unmatched-finding",
          rationale: `member ${member + 1}`,
          confidence: 0.9,
          judge_kind: "llm"
        };
      }
    });

    expect(calls).toBe(4);
    expect(new Set(observedInputs)).toHaveLength(1);
    expect(scored.rowScore).toMatchObject({ true_positives: 1, human_review_queue_count: 0 });
    expect(scored.findingScores[0]?.judge_result).toMatchObject({
      matched_ground_truth_bug_id: "BUG-1",
      classification: "true-positive",
      reason_code: "judge-confirmed-match",
      panel: {
        total: 4,
        quorum: 3,
        model: "gpt-5.5",
        reasoning_effort: "xhigh",
        prompt_version: "ultrafuzz-eval-judge-v9-independent-semantic-boundary-family",
        vote_split: [
          { classification: "true-positive", matched_ground_truth_bug_id: "BUG-1", votes: 3 },
          { classification: "false-positive", votes: 1 }
        ],
        aggregate_decision: {
          classification: "true-positive",
          matched_ground_truth_bug_id: "BUG-1",
          votes: 3
        }
      }
    });
    expect(scored.findingScores[0]?.judge_result.panel?.member_votes.map((vote) => vote.rationale)).toEqual([
      "member 1",
      "member 2",
      "member 3",
      "member 4"
    ]);
  });

  it("routes panel disagreement to human review with an explicit reason", async () => {
    const suite = testSuite("/tmp/gt", { judge_panel: { total: 4, quorum: 3 } });
    let calls = 0;
    const scored = await scoreInMemory({
      suite,
      row: testRow(suite),
      findings: [{ id: "finding-panel", title: "Possible issue", summary: "A partial match" }],
      bugs: BUGS,
      llmJudge: async (input) => {
        const positive = calls++ < 2;
        return {
          ...input.deterministicResult,
          ...(positive ? { matched_ground_truth_bug_id: "BUG-1" } : {}),
          score: positive ? 0.9 : 0.1,
          classification: positive ? "true-positive" : "false-positive",
          reason_code: positive ? "judge-confirmed-match" : "weak-unmatched-finding",
          rationale: positive ? "match" : "no match",
          confidence: 0.9,
          judge_kind: "llm"
        };
      }
    });

    expect(scored.rowScore).toMatchObject({ true_positives: 0, false_positives: 0, human_review_queue_count: 1 });
    expect(scored.reviewQueue[0]?.judge_result).toMatchObject({
      classification: "needs-human-review",
      reason_code: "panel-disagreement",
      rationale: "Judge panel disagreement: no identical decision reached quorum (3 of 4).",
      panel: {
        vote_split: [
          { classification: "false-positive", votes: 2 },
          { classification: "true-positive", matched_ground_truth_bug_id: "BUG-1", votes: 2 }
        ],
        aggregate_decision: {
          classification: "needs-human-review",
          reason_code: "panel-disagreement",
          votes: 2
        }
      }
    });
  });

  it("counts true-positive vote identity by matched canonical bug ID", async () => {
    const suite = testSuite("/tmp/gt", { judge_panel: { total: 4, quorum: 3 } });
    let calls = 0;
    const scored = await scoreInMemory({
      suite,
      row: testRow(suite),
      findings: [{ id: "finding-panel", title: "Possible issue", summary: "A partial match" }],
      bugs: BUGS,
      llmJudge: async (input) => {
        const bugId = calls++ < 2 ? "BUG-1" : "BUG-2";
        return {
          ...input.deterministicResult,
          matched_ground_truth_bug_id: bugId,
          score: 0.9,
          classification: "true-positive",
          reason_code: "judge-confirmed-match",
          rationale: `match ${bugId}`,
          confidence: 0.9,
          judge_kind: "llm"
        };
      }
    });

    expect(scored.findingScores[0]?.judge_result).toMatchObject({
      classification: "needs-human-review",
      reason_code: "panel-disagreement",
      panel: {
        vote_split: [
          { classification: "true-positive", matched_ground_truth_bug_id: "BUG-1", votes: 2 },
          { classification: "true-positive", matched_ground_truth_bug_id: "BUG-2", votes: 2 }
        ]
      }
    });
    expect(scored.findingScores[0]?.judge_result.matched_ground_truth_bug_id).toBeUndefined();
  });

  it("bounds panel member concurrency", async () => {
    const suite = testSuite("/tmp/gt", { judge_panel: { total: 6, quorum: 4 } });
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    await scoreInMemory({
      suite,
      row: testRow(suite),
      findings: [{ id: "finding-panel", title: "Possible issue", summary: "A partial match" }],
      bugs: BUGS,
      llmJudge: async (input) => {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        active -= 1;
        return { ...input.deterministicResult, judge_kind: "llm", rationale: "no match" };
      }
    });

    expect(calls).toBe(6);
    expect(maximumActive).toBe(4);
  });

  it("uses the candidate-mode threshold consistently for deterministic and optional judges", async () => {
    const suite = testSuite("/tmp/gt");
    let observedThreshold: number | undefined;
    const scored = await scoreInMemory({
      suite,
      row: testRow(suite),
      findings: [{ id: "candidate-finding", title: "Possible issue", summary: "A partial match" }],
      bugs: BUGS,
      matchMode: "candidate",
      llmJudge: async (input) => {
        observedThreshold = input.threshold;
        const classification = 0.5 >= input.threshold ? "true-positive" : "false-positive";
        return {
          ...input.deterministicResult,
          matched_ground_truth_bug_id: "BUG-1",
          score: 0.5,
          confidence: 0.5,
          classification,
          reason_code: classification === "true-positive" ? "judge-confirmed-match" : "weak-unmatched-finding",
          judge_kind: "llm"
        };
      }
    });

    expect(observedThreshold).toBe(0.45);
    expect(scored.findingScores[0]?.deterministic_match.classification).toBe("false-positive");
    expect(scored.findingScores[0]?.judge_result).toMatchObject({
      matched_ground_truth_bug_id: "BUG-1",
      score: 0.5,
      confidence: 0.5,
      classification: "true-positive",
      reason_code: "judge-confirmed-match"
    });
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
    expect(judgeCalls).toBe(3);
    expectPriorOutputs();
    expect(fs.readdirSync(fixture.evalRunRoot).some((entry) => entry.startsWith(".scoring-transaction-"))).toBe(false);

    const summary = await scoreEvalRun({ projectRoot: fixture.projectRoot, evalRunId: fixture.evalRunId });
    expect(summary.eval_run_id).toBe(fixture.evalRunId);
    expect(summary.rows[0]).toMatchObject({
      runtime_seconds: 60,
      cost_estimate: 0.456,
      lifecycle: {
        launcher: { status: "succeeded", finished_at: "2026-07-09T00:00:00.000Z" },
        workflow: { status: "succeeded", terminal: true, finished_at: "2026-07-09T00:01:00.000Z" }
      },
      efficiency: {
        wall_time_seconds: 60,
        active_time_seconds: 60,
        wait_time_seconds: 0,
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
        availability: "available",
        scoring: {
          judge_mode: "deterministic",
          judge_prompt_version: "ultrafuzz-eval-judge-v9-independent-semantic-boundary-family",
          judge_models: ["gpt-5.5"],
          judge_panel: { total: 3, quorum: 2 },
          ground_truth_sha256: { "target-a": expect.stringMatching(/^sha256:/u) }
        }
      }
    });
    const markdown = fs.readFileSync(path.join(fixture.evalRunRoot, "summary.md"), "utf8");
    expect(markdown).toContain(`# Ultrafuzz Eval ${fixture.evalRunId}`);
    expect(markdown).toContain(
      `| target-a-baseline-trial-1 | succeeded | 2026-07-09T00:00:00.000Z | 2026-07-09T00:00:00.000Z | succeeded | true | 2026-07-09T00:00:00.000Z | 2026-07-09T00:01:00.000Z |`
    );
    expect(markdown).toContain(
      "| target-a-baseline-trial-1 | 60 | 60 | 0 | 123 | 0.456 | complete | complete | complete |"
    );
    expect(markdown).toContain(`Candidate: test-candidate (${"0".repeat(40)})`);
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
    fs.writeFileSync(record.report_json_path, JSON.stringify(canonicalReport([])), "utf8");

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
    const graph = currentPlannedGraph(["terminal"], "terminal");
    graph.nodes[0]!.outputs[0]!.path = "custom-report.json";
    writeCurrentRunEvidence({
      runRoot,
      runId: "generated-run",
      state: currentRunState({ runId: "generated-run", nodes: { terminal: {} } }),
      graph,
      accounting: {
        total_tokens: 123,
        estimated_spend_usd: 0.456,
        usage_complete: true,
        pricing_complete: true,
        partial_pricing: false
      }
    });
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
    const suite = testSuite("/tmp/gt", {
      targets: [
        {
          id: "target-a",
          repo: "https://example.com/target-a",
          ref: "0123456789abcdef0123456789abcdef01234567",
          sensitivity: "private",
          ground_truth: "target-a.yml"
        }
      ]
    });

    await expect(
      scoreInMemory({
        suite,
        row: testRow(suite),
        findings: [matchedFinding()],
        bugs: BUGS,
        groundTruthSubject: {
          repository: "https://example.com/target-a",
          revision: "0123456789abcdef0123456789abcdef01234567"
        },
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
    const scored = await scoreInMemory({
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

    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.headers.authorization === "Bearer dedicated-key")).toBe(true);
    expect(requests.every((request) => request.redirect === "error")).toBe(true);
    expect(requests.every((request) => !JSON.stringify(request.body).includes("BUG-1"))).toBe(true);
    expect(requests.every((request) => !JSON.stringify(request.body).includes("BUG-2"))).toBe(true);
    expect(requests.every((request) => JSON.stringify(request.body).includes("untrusted data"))).toBe(true);
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
      rationale: "The untrusted finding requested a downgrade.",
      confidence: 1
    });
    const reviewDowngrade = await scoreInMemory({
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
      rationale: "The untrusted finding requested a downgrade.",
      confidence: 1
    });
    const corroborated = await scoreInMemory({
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

    const scored = await scoreInMemory({
      suite,
      row: testRow(suite, { judge_reasoning: "xhigh" }),
      findings: [matchedFinding()],
      bugs: BUGS,
      llmJudge: judge
    });

    expect(requests).toHaveLength(4);
    expect(requests[0]).toMatchObject({ model: "gpt-5.5", reasoning_effort: "xhigh" });
    expect(requests[0]?.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: "ultrafuzz_judge_result",
        strict: true,
        schema: {
          additionalProperties: false,
          required: ["matched_ground_truth_bug_id", "score", "signals", "rationale", "confidence"]
        }
      }
    });
    expect(requests[0]?.response_format).not.toHaveProperty("json_schema.schema.properties.classification");
    expect(requests[0]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: expect.stringContaining("0.0 through 1.0") }),
        expect.objectContaining({ role: "system", content: expect.stringContaining("final classification policy") })
      ])
    );
    const retryRequest = requests.find((request) => JSON.stringify(request.messages).includes("previous response"));
    expect(retryRequest?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: expect.stringContaining("previous response") }),
        expect.objectContaining({ role: "user", content: expect.stringContaining("0.0 through 1.0") }),
        expect.objectContaining({ role: "system", content: expect.stringContaining("final classification policy") })
      ])
    );
    expect(scored.rowScore.true_positives).toBe(1);
  });

  it("keeps schema retries independent for every panel member", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const content =
        requests.length <= 3
          ? JSON.stringify({ score: 1 })
          : JSON.stringify({
              matched_ground_truth_bug_id: "candidate-1",
              score: 1,
              signals: { root_cause: 1, affected_area: 1, impact: 1, evidence: 1 },
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
    const suite = testSuite("/tmp/gt", { judge_panel: { total: 3, quorum: 2 } });

    const scored = await scoreInMemory({
      suite,
      row: testRow(suite),
      findings: [matchedFinding()],
      bugs: BUGS,
      llmJudge: judge
    });

    expect(requests).toHaveLength(6);
    expect(new Set(requests.slice(0, 3).map((request) => JSON.stringify(request.messages)))).toHaveLength(1);
    expect(requests.slice(3).every((request) => JSON.stringify(request).includes("previous response"))).toBe(true);
    expect(scored.findingScores[0]?.judge_result.panel).toMatchObject({
      total: 3,
      quorum: 2,
      aggregate_decision: {
        classification: "true-positive",
        matched_ground_truth_bug_id: "BUG-1",
        votes: 3
      }
    });
    expect(scored.findingScores[0]?.judge_result.panel?.member_votes).toHaveLength(3);
    expect(
      scored.findingScores[0]?.judge_result.panel?.member_votes.every(
        (vote) => vote.prompt_version === "ultrafuzz-eval-judge-v9-independent-semantic-boundary-family"
      )
    ).toBe(true);
  });

  it("omits optional Claude reasoning parameters in structured-output mode", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const content = JSON.stringify({
        matched_ground_truth_bug_id: "candidate-1",
        score: 1,
        signals: { root_cause: 1, affected_area: 1, impact: 1, evidence: 1 },
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

    await scoreInMemory({
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
    const scored = await scoreInMemory({ suite, row, findings: [], bugs: BUGS });
    expect(scored.rowScore).toMatchObject({ precision: 0, recall: 0, f1_score: 0, missed: 2 });
  });
});
