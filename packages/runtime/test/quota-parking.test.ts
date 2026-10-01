import assert from "node:assert/strict";
import test from "node:test";

import { describeQuotaParking, untilQuotaReset } from "../src/lifecycle-inspection.js";
import type { DiagnoseRunValue, RunBlocker } from "../src/types.js";

const NOW_MS = Date.parse("2026-10-01T03:43:47.000Z");
const RESET_AT_MS = Date.parse("2026-10-01T03:48:33.544Z");
const QUOTA_ERROR =
  'Error: Agent "agent-1" (claude, model=claude-opus-4-8) hit a provider usage/quota limit: Claude five_hour usage limit exceeded (rate_limit_event rejected). Retry after 299 seconds.';

function blocker(overrides: Partial<RunBlocker> = {}): RunBlocker {
  return {
    kind: "retries-exhausted",
    node_id: "node:summarize",
    iteration: 0,
    reason: `All retries exhausted. Last error: ${QUOTA_ERROR}`,
    unblocker: "ultrafuzz resume quota-check",
    waiting_since: "2026-10-01T03:43:35.229Z",
    attempt: 3,
    max_attempts: 3,
    ...overrides
  };
}

// What `ultrafuzz why` returned for a real quota-parked run before #82.
function parkedDiagnosis(blockers: RunBlocker[] = [blocker()]): DiagnoseRunValue {
  return {
    run_id: "quota-check",
    workflow_run_id: "ultrafuzz-quota-check",
    run_status: "running",
    workflow_status: "waiting-quota",
    summary: "Run ultrafuzz-quota-check is waiting-quota",
    current_node_id: "node:final-report",
    blockers,
    notes: [],
    generated_at: "2026-10-01T03:43:47.000Z"
  };
}

test("why reports a quota-parked node as parked until the provider reset, not as exhausted", () => {
  const value = describeQuotaParking(
    parkedDiagnosis(),
    { parked_count: 1, parked_node_ids: ["node:summarize"], reset_at_ms: RESET_AT_MS },
    NOW_MS
  );
  assert.equal(
    value.summary,
    "Run is paused on a provider usage limit: 1 node(s) parked with their attempts preserved. The run resumes on its own after the provider reset at 2026-10-01T03:48:33.544Z (in 5 min)."
  );
  assert.equal(value.current_node_id, "node:summarize");
  const [parked] = value.blockers;
  assert.equal(parked?.kind, "quota-parked");
  assert.equal(parked?.node_id, "node:summarize");
  // It resumes on its own, and quota attempts do not count against the retry budget.
  assert.equal(parked?.unblocker, null);
  assert.equal(parked?.attempt, null);
  assert.equal(parked?.max_attempts, null);
  assert.equal(
    parked?.reason,
    `Parked on a provider usage limit with its attempts preserved. The run resumes on its own after the provider reset at 2026-10-01T03:48:33.544Z (in 5 min). Last error: ${QUOTA_ERROR}`
  );
  assert.doesNotMatch(parked?.reason ?? "", /retries exhausted/iu);
  assert.equal(parked?.waiting_since, "2026-10-01T03:43:35.229Z");
});

test("why tells the operator to resume a quota park that has no provider reset time", () => {
  const value = describeQuotaParking(
    parkedDiagnosis(),
    { parked_count: 1, parked_node_ids: ["node:summarize"], reset_at_ms: null },
    NOW_MS
  );
  assert.match(
    value.summary,
    /reported no reset time, as when credit is exhausted: restore it, then run `ultrafuzz resume quota-check`\.$/u
  );
  assert.equal(value.blockers[0]?.kind, "quota-parked");
  assert.equal(value.blockers[0]?.unblocker, "ultrafuzz resume quota-check");
});

test("why still explains a quota park when the runner's parking summary cannot be read", () => {
  const value = describeQuotaParking(parkedDiagnosis(), undefined, NOW_MS);
  assert.match(value.summary, /^Run is paused on a provider usage limit: 1 node\(s\) parked/u);
  assert.match(value.summary, /reset time could not be read; `ultrafuzz status` reports it\.$/u);
  assert.equal(value.current_node_id, "node:summarize");
  assert.equal(value.blockers[0]?.kind, "quota-parked");
  assert.equal(value.blockers[0]?.unblocker, "ultrafuzz resume quota-check");
});

test("why keeps blockers on nodes the quota did not park, and leaves other runs untouched", () => {
  const failed = blocker({ node_id: "node:other", reason: "All retries exhausted. Last error: boom" });
  const value = describeQuotaParking(
    parkedDiagnosis([blocker(), failed]),
    { parked_count: 1, parked_node_ids: ["node:summarize"], reset_at_ms: RESET_AT_MS },
    NOW_MS
  );
  assert.deepEqual(
    value.blockers.map((entry) => entry.kind),
    ["quota-parked", "retries-exhausted"]
  );
  assert.deepEqual(value.blockers[1], failed);

  const running = { ...parkedDiagnosis(), workflow_status: "running" };
  assert.deepEqual(describeQuotaParking(running, undefined, NOW_MS), running);
});

test("untilQuotaReset words the time left before a provider reset", () => {
  assert.equal(untilQuotaReset(0), "already passed");
  assert.equal(untilQuotaReset(-5_000), "already passed");
  assert.equal(untilQuotaReset(30_000), "in 1 min");
  assert.equal(untilQuotaReset(286_544), "in 5 min");
  assert.equal(untilQuotaReset(3 * 60 * 60_000 + 7 * 60_000), "in 3 h 7 min");
  assert.equal(untilQuotaReset(9 * 24 * 60 * 60_000), "in 9 days");
});
