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
