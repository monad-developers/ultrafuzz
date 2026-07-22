import { EVAL_JUDGE_PROMPT_VERSION } from "./adjudicator-prompt.js";
import { resolveJudgePanelConfig } from "../suite.js";
import type {
  EvalClassification,
  EvalClassificationReasonCode,
  EvalJudgePanelConfig,
  FindingJudge,
  FindingJudgeInput,
  FindingJudgePanelMemberVote,
  FindingJudgePanelVoteSplit,
  FindingJudgeResult,
  FindingMatchSignalScores
} from "../types.js";
import { roundMetric } from "../utils.js";

export const MAX_JUDGE_PANEL_CONCURRENCY = 4;

interface VoteGroup {
  identity: string;
  classification: EvalClassification;
  matchedGroundTruthBugId?: string;
  memberVotes: FindingJudgePanelMemberVote[];
}

/**
 * Run independent judge calls with bounded concurrency, then deterministically
 * aggregate policy-normalized member decisions.
 */
export async function runIndependentJudgePanel(input: {
  judge: FindingJudge;
  judgeInput: FindingJudgeInput;
  config: EvalJudgePanelConfig;
}): Promise<FindingJudgeResult> {
  const config = resolveJudgePanelConfig(input.config);
  const results = await boundedJudgeCalls(config.total, async () => input.judge(input.judgeInput));
  const memberVotes = results.map((result, index) => memberVote(result, index + 1));
  const groups = voteGroups(memberVotes);
  const voteSplit = groups.map(publicVoteSplit);
  const canonicalBugIds = new Set(input.judgeInput.bugs.map((bug) => bug.id));
  const winner = groups.find(
    (group) =>
      group.memberVotes.length >= config.quorum &&
      group.classification !== "missed" &&
      (group.classification !== "true-positive" ||
        (group.matchedGroundTruthBugId !== undefined && canonicalBugIds.has(group.matchedGroundTruthBugId)))
  );
  const selectedVotes = winner?.memberVotes ?? memberVotes;
  const classification =
    winner === undefined || winner.classification === "missed" ? "needs-human-review" : winner.classification;
  const matchedGroundTruthBugId =
    winner?.classification === "true-positive" ? winner.matchedGroundTruthBugId : undefined;
  const reasonCode = aggregateReasonCode(classification, input.judgeInput, winner !== undefined);
  const decidingVotes = winner?.memberVotes.length ?? voteSplit[0]?.votes ?? 0;
  const rationale = aggregateRationale(classification, matchedGroundTruthBugId, decidingVotes, config, winner);
  const model = input.judgeInput.row.judge_model ?? input.judgeInput.row.judge_model_profile;
  const panel = {
    ...config,
    model,
    ...(input.judgeInput.row.judge_reasoning ? { reasoning_effort: input.judgeInput.row.judge_reasoning } : {}),
    prompt_version: EVAL_JUDGE_PROMPT_VERSION,
    vote_split: voteSplit,
    member_votes: memberVotes,
    aggregate_decision: {
      classification,
      ...(matchedGroundTruthBugId === undefined ? {} : { matched_ground_truth_bug_id: matchedGroundTruthBugId }),
      reason_code: reasonCode,
      votes: decidingVotes,
      rationale
    }
  };

  if (memberVotes.length === 1 && winner !== undefined) {
    const only = memberVotes[0]!;
    const { member: _member, ...decision } = only;
    return { ...decision, panel };
  }

  return {
    ...(matchedGroundTruthBugId === undefined ? {} : { matched_ground_truth_bug_id: matchedGroundTruthBugId }),
    score: meanMetric(selectedVotes.map((vote) => vote.score)),
    signals: meanSignals(selectedVotes),
    classification,
    reason_code: reasonCode,
    rationale,
    confidence: meanMetric(selectedVotes.map((vote) => vote.confidence)),
    judge_model: model,
    judge_kind: "llm",
    ...(input.judgeInput.row.judge_reasoning ? { reasoning_effort: input.judgeInput.row.judge_reasoning } : {}),
    prompt_version: EVAL_JUDGE_PROMPT_VERSION,
    timestamp: latestTimestamp(memberVotes),
    panel
  };
}

async function boundedJudgeCalls(
  total: number,
  request: (member: number) => Promise<FindingJudgeResult>
): Promise<FindingJudgeResult[]> {
  const results = new Array<FindingJudgeResult>(total);
  const concurrency = Math.min(total, MAX_JUDGE_PANEL_CONCURRENCY);
  let nextMember = 0;
  let failed = false;
  const workers = Array.from({ length: concurrency }, async () => {
    while (!failed) {
      const member = nextMember;
      nextMember += 1;
      if (member >= total) return;
      try {
        results[member] = await request(member + 1);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function memberVote(result: FindingJudgeResult, member: number): FindingJudgePanelMemberVote {
  const vote = { ...result, member };
  delete vote.panel;
  return vote;
}

function voteGroups(memberVotes: FindingJudgePanelMemberVote[]): VoteGroup[] {
  const byIdentity = new Map<string, VoteGroup>();
  for (const vote of memberVotes) {
    const matchedGroundTruthBugId =
      vote.classification === "true-positive" ? vote.matched_ground_truth_bug_id : undefined;
    const identity = JSON.stringify([vote.classification, matchedGroundTruthBugId ?? null]);
    const existing = byIdentity.get(identity);
    if (existing !== undefined) {
      existing.memberVotes.push(vote);
      continue;
    }
    byIdentity.set(identity, {
      identity,
      classification: vote.classification,
      ...(matchedGroundTruthBugId === undefined ? {} : { matchedGroundTruthBugId }),
      memberVotes: [vote]
    });
  }
  return [...byIdentity.values()].sort(
    (left, right) => right.memberVotes.length - left.memberVotes.length || left.identity.localeCompare(right.identity)
  );
}

function publicVoteSplit(group: VoteGroup): FindingJudgePanelVoteSplit {
  return {
    classification: group.classification,
    ...(group.matchedGroundTruthBugId === undefined
      ? {}
      : { matched_ground_truth_bug_id: group.matchedGroundTruthBugId }),
    votes: group.memberVotes.length
  };
}

function aggregateReasonCode(
  classification: EvalClassification,
  input: FindingJudgeInput,
  reachedQuorum: boolean
): EvalClassificationReasonCode {
  if (!reachedQuorum || classification === "missed") return "panel-disagreement";
  if (classification === "true-positive") {
    return input.deterministicResult.classification === "true-positive"
      ? "deterministic-match"
      : "judge-confirmed-match";
  }
  if (classification === "needs-human-review") return "strong-novel-finding";
  return "weak-unmatched-finding";
}

function aggregateRationale(
  classification: EvalClassification,
  matchedGroundTruthBugId: string | undefined,
  decidingVotes: number,
  config: EvalJudgePanelConfig,
  winner: VoteGroup | undefined
): string {
  if (winner === undefined || classification === "missed") {
    return `Judge panel disagreement: no identical decision reached quorum (${config.quorum} of ${config.total}).`;
  }
  const identity =
    classification === "true-positive"
      ? `${classification} for ${matchedGroundTruthBugId ?? "an invalid canonical bug ID"}`
      : classification;
  return `Judge panel reached quorum with ${decidingVotes} of ${config.total} votes for ${identity}.`;
}

function meanSignals(votes: FindingJudgePanelMemberVote[]): FindingMatchSignalScores {
  return {
    root_cause: meanMetric(votes.map((vote) => vote.signals.root_cause)),
    affected_area: meanMetric(votes.map((vote) => vote.signals.affected_area)),
    impact: meanMetric(votes.map((vote) => vote.signals.impact)),
    evidence: meanMetric(votes.map((vote) => vote.signals.evidence))
  };
}

function meanMetric(values: number[]): number {
  return roundMetric(values.reduce((total, value) => total + value, 0) / values.length);
}

function latestTimestamp(votes: FindingJudgePanelMemberVote[]): string {
  return (
    votes
      .map((vote) => vote.timestamp)
      .sort()
      .at(-1) ?? new Date(0).toISOString()
  );
}
