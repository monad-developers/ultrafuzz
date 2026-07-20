import { describe, expect, it } from "vitest";

import { terminalDurableRunNeedsMoreWorkflowPolling } from "../src/worker-recovery.js";

describe("Modal worker recovery state", () => {
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
