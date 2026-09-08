import path from "node:path";

import {
  assertNoSymlinkComponents,
  assertPathInside,
  layoutForRunRoot,
  readRunMetadataDocument,
  readRunState,
  validateSafeId
} from "@ultrafuzz/artifacts";

import { retryTransientSnapshotRead } from "./observation-snapshot.js";
import { summarizeRunProgress } from "./run-progress.js";
import type { RunHealthCounts, RunHealthValue, RuntimeDiagnostic } from "./types.js";
import { runsRootForProject } from "./validate.js";

/** Observe incomplete launch without synchronizing, executing, or inventing a workflow identity. */
export async function readPendingRunHealth(
  projectRoot: string,
  runId: string,
  diagnostic: RuntimeDiagnostic,
  windowMinutes = 30
): Promise<RunHealthValue | undefined> {
  const runsRoot = await runsRootForProject(projectRoot);
  const safeRunId = validateSafeId(runId, "run ID");
  const layout = layoutForRunRoot(path.join(runsRoot, safeRunId), safeRunId);
  assertPathInside(runsRoot, layout.root, "run root");
  assertNoSymlinkComponents(runsRoot, layout.root, "run root");
  const { state, metadata } = retryTransientSnapshotRead(() => ({
    state: readRunState(layout),
    metadata: readRunMetadataDocument(layout.runMetadataPath, safeRunId)
  }));
  if (state.status !== "pending") return undefined;
  const counts: RunHealthCounts = {
    finished: 0,
    in_progress: 0,
    pending: 0,
    failed: 0,
    waiting_approval: 0,
    waiting_event: 0,
    waiting_timer: 0,
    skipped: 0,
    other: 0,
    total: 0
  };
  const throughput = {
    recent_finished: 0,
    window_ms: windowMinutes * 60_000,
    total_finished: 0,
    last_finished_at_ms: null
  };
  const nowMs = Date.now();
  return {
    run_id: safeRunId,
    run_root: layout.root,
    status: "pending",
    created_at: metadata.created_at,
    ...(metadata.audit_profile === undefined ? {} : { audit_profile: metadata.audit_profile }),
    workflow_ids: [],
    workflow_status: "unsubmitted",
    verdict: "launch-incomplete",
    reason: diagnostic.message,
    counts,
    model_mix: [],
    throughput,
    ...summarizeRunProgress({ runStatus: "pending", counts, throughput, nowMs }),
    gating: [],
    gating_omitted: 0,
    quota: null,
    generated_at_ms: nowMs
  };
}
