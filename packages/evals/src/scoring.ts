import fs from "node:fs";
import path from "node:path";

import { validateFindingsSchema, writeJsonDurable } from "@ultrafuzz/artifacts";
import { parse } from "yaml";
import { z } from "zod/v4";

import {
  type EvalCompareValue,
  type EvalFindingScore,
  type EvalMatrixRow,
  type EvalRowScore,
  type EvalRunRecord,
  type EvalScoreSummary,
  type EvalSuiteSpec,
  type EvalVariantScoreSummary,
  type FindingJudge,
  type FindingJudgeResult,
  type FindingMatchSignalScores,
  type GroundTruthBug,
  type HumanReviewQueueItem
} from "./types.js";
import {
  EvalError,
  appendJsonLine,
  evalRunRoot,
  isRecord,
  jsonFile,
  mean,
  readJsonLines,
  roundMetric
} from "./utils.js";

const SCORE_PROMPT_VERSION = "ultrafuzz-eval-judge-v1";

const groundTruthBugSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  severity: z.string().min(1).optional(),
  root_cause: z.string().min(1).optional(),
  root_cause_keywords: z.array(z.string().min(1)).optional(),
  affected_files: z.array(z.string().min(1)).optional(),
  affected_functions: z.array(z.string().min(1)).optional(),
  impact: z.string().min(1).optional(),
  impact_keywords: z.array(z.string().min(1)).optional(),
  evidence: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
  evidence_keywords: z.array(z.string().min(1)).optional(),
  keywords: z.array(z.string().min(1)).optional()
});

const groundTruthSchema = z.union([
  z.array(groundTruthBugSchema),
  z.looseObject({ bugs: z.array(groundTruthBugSchema) })
]);

const llmJudgeSchema = z.looseObject({
  matched_ground_truth_bug_id: z.string().min(1).nullable().optional(),
  score: z.number().min(0).max(1),
  signals: z.looseObject({
    root_cause: z.number().min(0).max(1),
    affected_area: z.number().min(0).max(1),
    impact: z.number().min(0).max(1),
    evidence: z.number().min(0).max(1)
  }),
  classification: z.enum(["true-positive", "false-positive", "needs-human-review"]),
  rationale: z.string().min(1),
  confidence: z.number().min(0).max(1)
});

export interface ScoreEvalRunInput {
  projectRoot: string;
  evalRunId: string;
  /** `true` selects the default gateway LLM judge; pass a `FindingJudge` to plug in your own. */
  llmJudge?: boolean | FindingJudge;
  env?: Record<string, string | undefined>;
}

export interface ScoreEvalRowReportInput {
  suite: EvalSuiteSpec;
  row: EvalMatrixRow;
  reportPath: string;
  record?: EvalRunRecord;
  llmJudge?: boolean | FindingJudge;
  env?: Record<string, string | undefined>;
}

export interface ScoreFindingsAgainstGroundTruthInput {
  suite: EvalSuiteSpec;
  row: EvalMatrixRow;
  findings: unknown[];
  bugs: GroundTruthBug[];
  matchMode?: "report" | "candidate";
  reportPath?: string;
  reportSchemaValid?: boolean;
  record?: EvalRunRecord;
  llmJudge?: boolean | FindingJudge;
  env?: Record<string, string | undefined>;
}

export async function scoreEvalRun(input: ScoreEvalRunInput): Promise<EvalScoreSummary> {
  const root = evalRunRoot(input.projectRoot, input.evalRunId);
  const evalManifest = jsonFile<{ suite?: EvalSuiteSpec }>(path.join(root, "eval.json"));
  if (evalManifest.suite === undefined) {
    throw new EvalError("EVAL_RUN_MANIFEST_INVALID", "eval run manifest is missing suite");
  }
  const suite = evalManifest.suite;
  const matrix = jsonFile<EvalMatrixRow[]>(path.join(root, "matrix.json"));
  const records = readJsonLines<EvalRunRecord>(path.join(root, "runs.jsonl"));
  const recordsByRow = new Map(records.map((record) => [record.row_id, record]));
  const scoresPath = path.join(root, "scores.jsonl");
  const reviewQueuePath = path.join(root, "review", "new-findings.jsonl");
  fs.rmSync(scoresPath, { force: true });
  fs.rmSync(reviewQueuePath, { force: true });

  const llmJudge = resolveJudge(input.llmJudge, input.env);
  const rowScores: EvalRowScore[] = [];
  for (const row of matrix) {
    const record = recordsByRow.get(row.id);
    const scored = await scoreRow({
      suite,
      row,
      record,
      llmJudge,
      reportPath: record?.report_json_path ?? defaultReportPath(row)
    });
    rowScores.push(scored.rowScore);
    for (const findingScore of scored.findingScores) {
      appendJsonLine(scoresPath, findingScore);
    }
    for (const reviewItem of scored.reviewQueue) {
      appendJsonLine(reviewQueuePath, reviewItem);
    }
  }

  const summaryPath = path.join(root, "summary.json");
  const variants = summarizeVariants(rowScores);
  const summary: EvalScoreSummary = {
    eval_run_id: input.evalRunId,
    eval_run_root: root,
    recall_threshold: suite.metrics.recall_threshold,
    rows: rowScores,
    variants,
    scores_path: scoresPath,
    summary_path: summaryPath,
    review_queue_path: reviewQueuePath
  };
  writeJsonDurable(summaryPath, summary);
  fs.writeFileSync(path.join(root, "summary.md"), renderSummaryMarkdown(summary), "utf8");
  return summary;
}

export async function scoreEvalRowReport(input: ScoreEvalRowReportInput): Promise<{
  rowScore: EvalRowScore;
  findingScores: EvalFindingScore[];
  reviewQueue: HumanReviewQueueItem[];
}> {
  return scoreRow({
    suite: input.suite,
    row: input.row,
    record: input.record,
    reportPath: input.reportPath,
    llmJudge: resolveJudge(input.llmJudge, input.env)
  });
}

export async function scoreFindingsAgainstGroundTruth(input: ScoreFindingsAgainstGroundTruthInput): Promise<{
  rowScore: EvalRowScore;
  findingScores: EvalFindingScore[];
  reviewQueue: HumanReviewQueueItem[];
}> {
  return scoreFindings({
    suite: input.suite,
    row: input.row,
    record: input.record,
    reportPath: input.reportPath ?? "inline-findings",
    findings: input.findings,
    bugs: input.bugs,
    reportSchemaValid: input.reportSchemaValid ?? true,
    matchMode: input.matchMode ?? "report",
    llmJudge: resolveJudge(input.llmJudge, input.env)
  });
}

export function compareEvalRun(input: { projectRoot: string; evalRunId: string; baseline: string }): EvalCompareValue {
  const root = evalRunRoot(input.projectRoot, input.evalRunId);
  const summary = jsonFile<EvalScoreSummary>(path.join(root, "summary.json"));
  const baseline = summary.variants.find((variant) => variant.variant_id === input.baseline);
  if (baseline === undefined) {
    throw new EvalError("EVAL_BASELINE_UNKNOWN", `baseline variant ${input.baseline} not found`, {
      baseline: input.baseline
    });
  }
  return {
    baseline: input.baseline,
    variants: summary.variants.map((variant) => ({
      ...variant,
      delta_f1_score: roundMetric(variant.f1_score - baseline.f1_score),
      delta_recall: roundMetric(variant.recall - baseline.recall),
      delta_precision: roundMetric(variant.precision - baseline.precision)
    }))
  };
}

export function renderSummaryMarkdown(summary: EvalScoreSummary): string {
  const lines = [
    `# Ultrafuzz Eval ${summary.eval_run_id}`,
    "",
    `Recall threshold: ${summary.recall_threshold}`,
    "",
    "| Variant | Rows | Precision | Recall | F1 | Full match | Review queue | Duplicate rate | Schema valid |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  ];
  for (const variant of summary.variants) {
    lines.push(
      [
        `| ${variant.variant_id}`,
        variant.row_count,
        variant.precision,
        variant.recall,
        variant.f1_score,
        variant.full_match_rate,
        variant.human_review_queue_count,
        variant.duplicate_rate,
        variant.report_schema_valid_rate
      ].join(" | ") + " |"
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function defaultReportPath(row: EvalMatrixRow): string {
  if (row.target.path === undefined) {
    return `missing-target-path/${row.run_id}/report.json`;
  }
  return path.join(row.target.path, ".ultrafuzz", "runs", row.run_id, "artifacts", "final-report", "report.json");
}

function resolveJudge(
  llmJudge: boolean | FindingJudge | undefined,
  env: Record<string, string | undefined> | undefined
): FindingJudge | undefined {
  if (llmJudge === undefined || llmJudge === false) {
    return undefined;
  }
  if (llmJudge === true) {
    return gatewayLlmJudge(env ?? process.env);
  }
  return llmJudge;
}

async function scoreRow(input: {
  suite: EvalSuiteSpec;
  row: EvalMatrixRow;
  record?: EvalRunRecord;
  reportPath: string;
  llmJudge?: FindingJudge;
}): Promise<{
  rowScore: EvalRowScore;
  findingScores: EvalFindingScore[];
  reviewQueue: HumanReviewQueueItem[];
}> {
  const bugs = loadGroundTruth(input.row.target.ground_truth_path);
  const report = readReport(input.reportPath);
  const findings = report.findings;
  const schemaValidation = validateFindingsSchema(findings);
  return scoreFindings({
    suite: input.suite,
    row: input.row,
    record: input.record,
    reportPath: input.reportPath,
    findings,
    bugs,
    reportSchemaValid: report.schemaValid && schemaValidation.ok,
    matchMode: "report",
    llmJudge: input.llmJudge
  });
}

async function scoreFindings(input: {
  suite: EvalSuiteSpec;
  row: EvalMatrixRow;
  record?: EvalRunRecord;
  reportPath: string;
  findings: unknown[];
  bugs: GroundTruthBug[];
  reportSchemaValid: boolean;
  matchMode: "report" | "candidate";
  llmJudge?: FindingJudge;
}): Promise<{
  rowScore: EvalRowScore;
  findingScores: EvalFindingScore[];
  reviewQueue: HumanReviewQueueItem[];
}> {
  const matches: EvalFindingScore[] = [];
  const reviewQueue: HumanReviewQueueItem[] = [];
  const matchedBugIds = new Set<string>();
  let duplicates = 0;
  let falsePositives = 0;
  let truePositives = 0;
  let fullMatches = 0;
  let severityChecks = 0;
  let severityMatches = 0;

  for (const [index, finding] of input.findings.entries()) {
    const match = await bestMatch(
      finding,
      input.bugs,
      input.suite.metrics.recall_threshold,
      input.row,
      input.suite,
      input.matchMode,
      input.llmJudge
    );
    const bugId = match.judge_result.matched_ground_truth_bug_id;
    if (match.judge_result.classification === "true-positive" && bugId !== undefined) {
      if (matchedBugIds.has(bugId)) {
        duplicates += 1;
      } else {
        truePositives += 1;
        matchedBugIds.add(bugId);
        if (match.judge_result.score >= 1) {
          fullMatches += 1;
        }
        const bug = input.bugs.find((candidate) => candidate.id === bugId);
        const severity = stringField(finding, "severity_guess");
        if (bug?.severity && severity) {
          severityChecks += 1;
          if (bug.severity.toLowerCase() === severity.toLowerCase()) {
            severityMatches += 1;
          }
        }
      }
    } else if (match.judge_result.classification === "needs-human-review") {
      reviewQueue.push({
        target_id: input.row.target_id,
        variant_id: input.row.variant_id,
        trial_id: input.row.trial_id,
        ...(input.record?.ultrafuzz_run_id !== undefined ? { ultrafuzz_run_id: input.record.ultrafuzz_run_id } : {}),
        workflow_ids: input.record?.workflow_ids ?? [],
        finding,
        report_path: input.reportPath,
        deterministic_match: match.deterministic_match,
        judge_result: match.judge_result,
        reviewer_status: "pending"
      });
    } else {
      falsePositives += 1;
    }
    const findingTitle = stringField(finding, "title");
    matches.push({
      row_id: input.row.id,
      finding_id: stringField(finding, "id") ?? `finding-${index + 1}`,
      ...(findingTitle !== undefined ? { finding_title: findingTitle } : {}),
      report_path: input.reportPath,
      deterministic_match: match.deterministic_match,
      judge_result: match.judge_result
    });
  }

  const missed = Math.max(0, input.bugs.length - matchedBugIds.size);
  const precisionDenominator = truePositives + falsePositives;
  const precision = precisionDenominator === 0 ? 0 : roundMetric(truePositives / precisionDenominator);
  const recall = input.bugs.length === 0 ? 0 : roundMetric(matchedBugIds.size / input.bugs.length);
  const f1 = precision + recall === 0 ? 0 : roundMetric((2 * precision * recall) / (precision + recall));
  const judgedFindings = truePositives + falsePositives + duplicates;
  const rowScore: EvalRowScore = {
    row_id: input.row.id,
    target_id: input.row.target_id,
    variant_id: input.row.variant_id,
    trial_id: input.row.trial_id,
    report_schema_valid: input.reportSchemaValid,
    ground_truth_bug_count: input.bugs.length,
    finding_count: input.findings.length,
    true_positives: truePositives,
    false_positives: falsePositives,
    missed,
    human_review_queue_count: reviewQueue.length,
    duplicate_count: duplicates,
    precision,
    recall,
    f1_score: f1,
    full_match_rate: input.bugs.length === 0 ? 0 : roundMetric(fullMatches / input.bugs.length),
    severity_accuracy: severityChecks === 0 ? null : roundMetric(severityMatches / severityChecks),
    true_positive_accuracy: input.findings.length === 0 ? 0 : roundMetric(truePositives / input.findings.length),
    duplicate_rate: judgedFindings === 0 ? 0 : roundMetric(duplicates / judgedFindings),
    runtime_seconds: null,
    cost_estimate: null
  };
  return { rowScore, findingScores: matches, reviewQueue };
}

async function bestMatch(
  finding: unknown,
  bugs: GroundTruthBug[],
  threshold: number,
  row: EvalMatrixRow,
  suite: EvalSuiteSpec,
  matchMode: "report" | "candidate",
  llmJudge?: FindingJudge
): Promise<{ deterministic_match: FindingJudgeResult; judge_result: FindingJudgeResult }> {
  let bestBug: GroundTruthBug | undefined;
  let bestSignals = emptySignals();
  let bestScore = 0;
  for (const bug of bugs) {
    const signals = scoreSignals(finding, bug);
    const score = matchMode === "candidate" ? candidateMatchScore(signals) : reportMatchScore(signals);
    if (score > bestScore) {
      bestBug = bug;
      bestSignals = signals;
      bestScore = score;
    }
  }
  const plausible = isPlausibleFinding(finding);
  const effectiveThreshold = matchMode === "candidate" ? Math.min(threshold, 0.45) : threshold;
  const classification =
    bestBug && bestScore >= effectiveThreshold ? "true-positive" : plausible ? "needs-human-review" : "false-positive";
  const timestamp = new Date().toISOString();
  const judgeModel = row.judge_model ?? row.judge_model_profile;
  const result: FindingJudgeResult = {
    ...(bestBug && bestScore > 0 ? { matched_ground_truth_bug_id: bestBug.id } : {}),
    score: bestScore,
    signals: bestSignals,
    classification,
    rationale:
      classification === "true-positive"
        ? "Deterministic matcher found enough root-cause, area, impact, and evidence overlap."
        : classification === "needs-human-review"
          ? "Finding did not match known ground truth but is plausible enough for review."
          : "Finding did not match ground truth and lacked plausibility signals.",
    confidence: bestScore >= threshold ? 0.75 : plausible ? 0.5 : 0.7,
    judge_model: judgeModel,
    judge_kind: "deterministic",
    ...(row.judge_reasoning ? { reasoning_effort: row.judge_reasoning } : {}),
    prompt_version: SCORE_PROMPT_VERSION,
    timestamp
  };
  if (llmJudge !== undefined) {
    const judgeResult = await llmJudge({
      suite,
      row,
      finding,
      bugs,
      deterministicResult: result,
      threshold
    });
    return {
      deterministic_match: result,
      judge_result: judgeResult
    };
  }
  return {
    deterministic_match: result,
    judge_result: result
  };
}

/**
 * Default optional LLM judge. Talks to an OpenAI-compatible chat-completions
 * gateway; nothing in the scoring loop depends on it (grading is deterministic
 * unless a judge is explicitly enabled).
 */
export function gatewayLlmJudge(env: Record<string, string | undefined>): FindingJudge {
  const apiKey = env.ULTRAFUZZ_EVAL_JUDGE_API_KEY ?? env.BRAINTRUST_API_KEY ?? env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new EvalError(
      "EVAL_LLM_JUDGE_KEY_MISSING",
      "ULTRAFUZZ_EVAL_JUDGE_API_KEY (or BRAINTRUST_API_KEY / OPENAI_API_KEY) is required for --llm-judge"
    );
  }
  const endpoint = env.ULTRAFUZZ_EVAL_JUDGE_URL ?? "https://gateway.braintrust.dev/v1/chat/completions";
  return async (input) => {
    const profile = input.suite.model_profiles[input.row.judge_model_profile];
    const model = input.row.judge_model ?? profile?.model;
    if (!model) {
      throw new EvalError("EVAL_LLM_JUDGE_MODEL_MISSING", "LLM judge requires a model in the judge profile", {
        judgeProfileId: input.row.judge_model_profile
      });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, profile?.timeout_seconds ?? 1800) * 1000);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages: judgeMessages(input),
          response_format: { type: "json_object" }
        }),
        signal: controller.signal
      });
      const bodyText = await response.text();
      if (!response.ok) {
        throw new EvalError("EVAL_LLM_JUDGE_REQUEST_FAILED", "LLM judge gateway request failed", {
          status: response.status,
          body: bodyText.slice(0, 1000)
        });
      }
      const content = chatCompletionContent(bodyText);
      const parsed = llmJudgeSchema.safeParse(parseJsonObject(content));
      if (!parsed.success) {
        throw new EvalError("EVAL_LLM_JUDGE_INVALID", "LLM judge returned invalid JSON", {
          issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
          content: content.slice(0, 1000)
        });
      }
      return normalizeLlmJudgeResult(parsed.data, input);
    } finally {
      clearTimeout(timeout);
    }
  };
}

function judgeMessages(input: Parameters<FindingJudge>[0]): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content:
        "You are an eval judge for smart-contract security findings. Compare one finding against known ground-truth bugs. Return only JSON. Classify plausible unmatched findings as needs-human-review, not false-positive."
    },
    {
      role: "user",
      content: [
        "Score the finding with this rubric:",
        "- 0.0: no meaningful match",
        "- 0.4: weak signal in the same area",
        "- 0.7: same root cause and impact, but incomplete localization or evidence",
        "- 1.0: same root cause, affected area, impact, and concrete PoC/test/evidence",
        "",
        "Return JSON with matched_ground_truth_bug_id, score, signals.root_cause, signals.affected_area, signals.impact, signals.evidence, classification, rationale, and confidence.",
        "",
        `Target: ${input.row.target.repo}@${input.row.target.ref}`,
        `Recall threshold: ${input.threshold}`,
        "",
        "Deterministic prefilter:",
        boundedJson(input.deterministicResult, 4000),
        "",
        "Ground truth bugs:",
        boundedJson(input.bugs, 12000),
        "",
        "Finding:",
        boundedJson(input.finding, 12000)
      ].join("\n")
    }
  ];
}

function normalizeLlmJudgeResult(
  data: z.infer<typeof llmJudgeSchema>,
  input: Parameters<FindingJudge>[0]
): FindingJudgeResult {
  const validBugIds = new Set(input.bugs.map((bug) => bug.id));
  const candidateBugId = data.matched_ground_truth_bug_id ?? undefined;
  const matchedBugId = candidateBugId && validBugIds.has(candidateBugId) ? candidateBugId : undefined;
  const score = roundMetric(data.score);
  const plausible = isPlausibleFinding(input.finding);
  let classification = data.classification;
  if (matchedBugId !== undefined && score >= input.threshold) {
    classification = "true-positive";
  } else if (classification === "true-positive") {
    classification = plausible ? "needs-human-review" : "false-positive";
  }
  return {
    ...(matchedBugId ? { matched_ground_truth_bug_id: matchedBugId } : {}),
    score,
    signals: {
      root_cause: roundMetric(data.signals.root_cause),
      affected_area: roundMetric(data.signals.affected_area),
      impact: roundMetric(data.signals.impact),
      evidence: roundMetric(data.signals.evidence)
    },
    classification,
    rationale: data.rationale,
    confidence: roundMetric(data.confidence),
    judge_model: input.row.judge_model ?? input.row.judge_model_profile,
    judge_kind: "llm",
    ...(input.row.judge_reasoning ? { reasoning_effort: input.row.judge_reasoning } : {}),
    prompt_version: SCORE_PROMPT_VERSION,
    timestamp: new Date().toISOString()
  };
}

function chatCompletionContent(bodyText: string): string {
  const parsed = JSON.parse(bodyText) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) {
    throw new EvalError("EVAL_LLM_JUDGE_RESPONSE_INVALID", "LLM judge response is missing choices");
  }
  const first = parsed.choices[0];
  if (!isRecord(first) || !isRecord(first.message) || typeof first.message.content !== "string") {
    throw new EvalError("EVAL_LLM_JUDGE_RESPONSE_INVALID", "LLM judge response is missing message content");
  }
  return first.message.content;
}

function parseJsonObject(content: string): unknown {
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/u.exec(trimmed);
  if (fenced?.[1]) {
    return JSON.parse(fenced[1]);
  }
  throw new EvalError("EVAL_LLM_JUDGE_RESPONSE_INVALID", "LLM judge content did not contain JSON", {
    content: content.slice(0, 1000)
  });
}

function boundedJson(value: unknown, maxLength: number): string {
  const rendered = JSON.stringify(value, null, 2);
  if (rendered.length <= maxLength) {
    return rendered;
  }
  return `${rendered.slice(0, maxLength)}\n... truncated ...`;
}

export function scoreSignals(finding: unknown, bug: GroundTruthBug): FindingMatchSignalScores {
  const text = searchableText(finding);
  const findingFiles = stringArrayField(finding, "affected_files");
  const findingFunctions = stringArrayField(finding, "affected_functions");
  const idOrTitleMatch = keywordScore([bug.id, bug.title ?? ""], text);
  const root = Math.max(
    idOrTitleMatch,
    keywordScore(
      [...stringList(bug.root_cause_keywords), ...stringList(bug.keywords), ...stringList(bug.root_cause)],
      text
    )
  );
  const affectedFileScore = overlapScore(bug.affected_files ?? [], findingFiles, text);
  const affectedFunctionScore = overlapScore(bug.affected_functions ?? [], findingFunctions, text);
  const impact = keywordScore([...stringList(bug.impact_keywords), ...stringList(bug.impact)], text);
  const evidenceKeywords = [...stringList(bug.evidence_keywords), ...stringList(bug.evidence)];
  const evidence = evidenceKeywords.length > 0 ? keywordScore(evidenceKeywords, text) : hasEvidence(finding) ? 1 : 0;
  return {
    root_cause: roundMetric(root),
    affected_area: roundMetric(Math.max(affectedFileScore, affectedFunctionScore)),
    impact: roundMetric(impact),
    evidence: roundMetric(evidence)
  };
}

export function reportMatchScore(signals: FindingMatchSignalScores): number {
  return roundMetric((signals.root_cause + signals.affected_area + signals.impact + signals.evidence) / 4);
}

function candidateMatchScore(signals: FindingMatchSignalScores): number {
  const weighted = roundMetric(signals.root_cause * 0.45 + signals.affected_area * 0.35 + signals.impact * 0.2);
  if (signals.affected_area < 0.5 || Math.max(signals.root_cause, signals.impact) < 0.25) {
    return Math.min(weighted, 0.44);
  }
  return weighted;
}

export function loadGroundTruth(filePath: string): GroundTruthBug[] {
  if (!fs.existsSync(filePath)) {
    throw new EvalError("EVAL_GROUND_TRUTH_MISSING", `ground truth file is missing: ${filePath}`, { path: filePath });
  }
  const parsed = parse(fs.readFileSync(filePath, "utf8"));
  const result = groundTruthSchema.safeParse(parsed);
  if (!result.success) {
    throw new EvalError("EVAL_GROUND_TRUTH_INVALID", `ground truth file is invalid: ${filePath}`, {
      path: filePath,
      issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    });
  }
  return (Array.isArray(result.data) ? result.data : result.data.bugs) as GroundTruthBug[];
}

function readReport(filePath: string): { schemaValid: boolean; findings: unknown[] } {
  if (!fs.existsSync(filePath)) {
    return { schemaValid: false, findings: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (Array.isArray(parsed)) {
      return { schemaValid: true, findings: parsed };
    }
    if (isRecord(parsed)) {
      const findings = Array.isArray(parsed.findings)
        ? parsed.findings
        : Array.isArray(parsed.issues)
          ? parsed.issues
          : [];
      return {
        schemaValid: findings.length > 0 || Array.isArray(parsed.findings) || Array.isArray(parsed.issues),
        findings
      };
    }
  } catch {
    return { schemaValid: false, findings: [] };
  }
  return { schemaValid: false, findings: [] };
}

function summarizeVariants(rows: EvalRowScore[]): EvalVariantScoreSummary[] {
  const byVariant = new Map<string, EvalRowScore[]>();
  for (const row of rows) {
    const existing = byVariant.get(row.variant_id) ?? [];
    existing.push(row);
    byVariant.set(row.variant_id, existing);
  }
  return [...byVariant.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([variantId, variantRows]) => ({
      variant_id: variantId,
      row_count: variantRows.length,
      precision: mean(variantRows.map((row) => row.precision)),
      recall: mean(variantRows.map((row) => row.recall)),
      f1_score: mean(variantRows.map((row) => row.f1_score)),
      full_match_rate: mean(variantRows.map((row) => row.full_match_rate)),
      human_review_queue_count: variantRows.reduce((sum, row) => sum + row.human_review_queue_count, 0),
      duplicate_rate: mean(variantRows.map((row) => row.duplicate_rate)),
      report_schema_valid_rate: mean(variantRows.map((row) => (row.report_schema_valid ? 1 : 0)))
    }));
}

function keywordScore(keywords: string[], text: string): number {
  const normalized = keywords.map(normalizeText).filter((keyword) => keyword.length > 0);
  if (normalized.length === 0) {
    return 0;
  }
  const hits = normalized.filter((keyword) => text.includes(keyword)).length;
  return hits === 0 ? 0 : Math.min(1, hits / Math.min(3, normalized.length));
}

function overlapScore(expected: string[], actual: string[], text: string): number {
  const normalizedExpected = expected.map(normalizePathish).filter((value) => value.length > 0);
  if (normalizedExpected.length === 0) {
    return 0;
  }
  const actualSet = new Set(actual.map(normalizePathish));
  const hits = normalizedExpected.filter((value) => actualSet.has(value) || text.includes(value)).length;
  return hits === 0 ? 0 : Math.min(1, hits / Math.min(2, normalizedExpected.length));
}

function searchableText(value: unknown): string {
  return normalizeText(JSON.stringify(value ?? ""));
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_./:-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizePathish(value: string): string {
  return value.toLowerCase().replace(/\\/gu, "/").replace(/^\.\//u, "").trim();
}

function isPlausibleFinding(finding: unknown): boolean {
  const status = stringField(finding, "status")?.toLowerCase();
  const triage = stringField(finding, "triage_classification")?.toLowerCase();
  if (status === "false-positive" || triage === "false-positive") {
    return false;
  }
  return Boolean(stringField(finding, "summary") || stringField(finding, "title"));
}

function hasEvidence(finding: unknown): boolean {
  if (isRecord(finding) && Array.isArray(finding.evidence) && finding.evidence.length > 0) {
    return true;
  }
  const text = searchableText(finding);
  return ["poc", "proof", "test", "trace", "reproduction", "reproduce"].some((term) => text.includes(term));
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const field = value[key];
  return typeof field === "string" && field.trim().length > 0 ? field.trim() : undefined;
}

function stringArrayField(value: unknown, key: string): string[] {
  if (!isRecord(value)) {
    return [];
  }
  const field = value[key];
  return Array.isArray(field) ? field.filter((entry): entry is string => typeof entry === "string") : [];
}

function stringList(value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) {
    return [value];
  }
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function emptySignals(): FindingMatchSignalScores {
  return {
    root_cause: 0,
    affected_area: 0,
    impact: 0,
    evidence: 0
  };
}
