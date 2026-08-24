/**
 * Splits a node timeout into a working budget and a finalization reserve.
 *
 * The 300-second reserve cap is deliberately kept: an agentic node's finalization work is writing
 * two small JSON documents (the normalized findings array and the generated-test manifest), copying
 * any generated test files, and hashing them. None of that compiles or executes anything, so five
 * minutes is ample, and reserve seconds are taken directly out of hunting time — on a 7200-second
 * node the cap already costs 4.2% of the budget. The failure mode this reserve guards against is
 * "agent never stops working", which is addressed by making the deadline measurable in
 * `topologyRuntimeContextForTimeout` (run reliability, #672/#677), not by reserving more time.
 *
 * The cap is also load-bearing elsewhere and cannot be changed in isolation:
 * `assertInvariantCampaignTimeoutBudget` adds it to the smoke, fuzzer, and host-shutdown-grace
 * timeouts when validating campaign node timeouts, and `artifact-gates` rejects a campaign plan
 * whose recorded `artifact_finalization_reserve_seconds` disagrees with the value computed here.
 */
export function topologyRuntimeBudgetForTimeout(timeoutMs: number): {
  timeoutSeconds: number;
  finalizationReserveSeconds: number;
  workingBudgetSeconds: number;
} {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const maximumReserveSeconds = timeoutSeconds > 1 ? timeoutSeconds - 1 : 1;
  const finalizationReserveSeconds = Math.min(maximumReserveSeconds, 300, Math.max(1, Math.floor(timeoutSeconds / 6)));
  const workingBudgetSeconds = Math.max(0, timeoutSeconds - finalizationReserveSeconds);
  return { timeoutSeconds, finalizationReserveSeconds, workingBudgetSeconds };
}
