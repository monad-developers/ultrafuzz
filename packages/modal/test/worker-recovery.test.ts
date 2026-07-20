import { describe, expect, it } from "vitest";

import { staleRunningResetGraceActive, terminalDurableRunNeedsMoreWorkflowPolling } from "../src/worker-recovery.js";

describe("Modal worker recovery state", () => {
  it("blocks stale-running resets during the post-resume grace window only", () => {
    expect(staleRunningResetGraceActive("stale-running", 2_000, 1_000)).toBe(true);
    expect(staleRunningResetGraceActive("stale-running", 1_000, 2_000)).toBe(false);
    expect(staleRunningResetGraceActive("failed", 2_000, 1_000)).toBe(false);
  });

  it("keeps polling a failed durable run while the workflow is still progressing", () => {
    expect(
      terminalDurableRunNeedsMoreWorkflowPolling(
        {
          status: "failed",
          workflow_status: "running",
          workflow_verdict: "progressing",
          nodes: {
            complete: { status: "succeeded" },
            next: { status: "pending" }
          }
        },
        0
      )
    ).toBe(true);
  });

  it("keeps polling when the status summary is running even if the lower-level workflow is failed", () => {
    expect(
      terminalDurableRunNeedsMoreWorkflowPolling(
        {
          status: "failed",
          sync_status: "running",
          workflow_status: "failed",
          workflow_verdict: "failed",
          nodes: {
            complete: { status: "succeeded" },
            next: { status: "pending" }
          }
        },
        0
      )
    ).toBe(true);
  });

  it("stops polling when the lower-level workflow owner is stale", () => {
    expect(
      terminalDurableRunNeedsMoreWorkflowPolling(
        {
          status: "failed",
          sync_status: "running",
          workflow_status: "running",
          workflow_state: "orphaned",
          workflow_verdict: "progressing",
          nodes: {
            complete: { status: "succeeded" },
            next: { status: "pending" }
          }
        },
        0
      )
    ).toBe(false);
  });

  it("stops waiting when failed durable nodes need recovery", () => {
    expect(
      terminalDurableRunNeedsMoreWorkflowPolling(
        {
          status: "failed",
          workflow_status: "running",
          workflow_verdict: "progressing",
          nodes: {
            failed: { status: "failed" },
            next: { status: "pending" }
          }
        },
        1
      )
    ).toBe(false);
  });

  it("stops waiting when no unfinished durable nodes remain", () => {
    expect(
      terminalDurableRunNeedsMoreWorkflowPolling(
        {
          status: "failed",
          workflow_status: "running",
          workflow_verdict: "progressing",
          nodes: {
            complete: { status: "succeeded" }
          }
        },
        0
      )
    ).toBe(false);
  });
});
