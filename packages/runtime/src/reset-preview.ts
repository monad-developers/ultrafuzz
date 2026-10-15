import path from "node:path";

import { previewSmithersReset, readSmithersResetMarker } from "./smithers.js";
import type { WorkflowLifecycleInput, WorkflowLifecycleValue } from "./types.js";

/** Called before controller preparation; preview reads only run identity and runner state. */
export async function previewResumeReset(
  input: WorkflowLifecycleInput,
  runRoot: string,
  smithersRunId: string
): Promise<WorkflowLifecycleValue | undefined> {
  if (input.dryRun !== true && input.resetGeneration === undefined) return undefined;
  const nodeId = input.resetNode;
  if (nodeId === undefined) throw new Error("reset preview requires --reset-node");
  const applied = readSmithersResetMarker(
    path.join(runRoot, "smithers", "reset-node-applied.json"),
    smithersRunId,
    nodeId
  );
  if (applied !== undefined && applied.plan === undefined && input.dryRun === true) {
    throw new Error(
      "This reset was already applied without a saved preview; resume the same node without --dry-run to continue"
    );
  }
  const plan =
    applied?.plan ??
    (await previewSmithersReset({
      projectRoot: path.resolve(input.projectRoot),
      smithersRunId,
      nodeId,
      env: input.env
    }));
  if (input.resetGeneration !== undefined && input.resetGeneration !== plan.generation) {
    throw new Error("Reset plan generation changed; preview the reset again before resuming");
  }
  if (input.dryRun !== true) return undefined;
  return {
    run_id: input.runId,
    workflow_run_id: smithersRunId,
    action: "resume",
    submitted: false,
    dry_run: true,
    reset_plan: plan,
    reset_already_applied: applied !== undefined
  };
}
