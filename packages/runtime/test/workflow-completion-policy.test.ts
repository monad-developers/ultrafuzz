import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { NodeStatus, RunStatus } from "@ultrafuzz/artifacts";
import * as ts from "typescript";

function terminalPolicyHelpers(): {
  recoveryAuthorizesTerminalAggregate: (input: Record<string, unknown>) => boolean;
  finalRunStatus: (
    inspect: { runState: string; exhaustedLoops: unknown[] },
    nodeStatuses: Map<string, NodeStatus>,
    currentStatus: RunStatus,
    options: { evidenceComplete: boolean; recoveredAggregateAuthorized: boolean; nonBlockingNodeIds: Set<string> }
  ) => RunStatus;
} {
  const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const packageRoot = fs.existsSync(path.join(testRoot, "src", "workflow-sync.ts"))
    ? testRoot
    : path.resolve(testRoot, "..");
  const source = fs.readFileSync(path.join(packageRoot, "src", "workflow-sync.ts"), "utf8");
  const sections = [
    ["function recoveryAuthorizesTerminalAggregate(", "function reconcilePreparedRecoveryProvenance("],
    ["function finalRunStatus(", "function nonBlockingRuntimeNodeIds("]
  ].map(([startMarker, endMarker]) => {
    assert.ok(startMarker && endMarker);
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start);
    return source.slice(start, end);
  });
  const emitted = ts.transpileModule(sections.join("\n"), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const recordField = (value: Record<string, unknown> | undefined, key: string) => value?.[key];
  // This fixture starts after recovery submission has been independently verified.
  return new Function(
    "recoverySubmissionAuthority",
    "recordField",
    "stringField",
    "numberField",
    `${emitted}; return { recoveryAuthorizesTerminalAggregate, finalRunStatus };`
  )(() => ({ attemptEpoch: "retained" }), recordField, recordField, recordField) as ReturnType<
    typeof terminalPolicyHelpers
  >;
}

for (const taskStatus of ["failed", "timed-out", "skipped"] as const) {
  test(`strict completion does not recover a retained failed aggregate while a continued task is ${taskStatus}`, () => {
    const { recoveryAuthorizesTerminalAggregate, finalRunStatus } = terminalPolicyHelpers();
    const inspect = { runState: "failed", exhaustedLoops: [], steps: [] };
    const nodeStatuses = new Map<string, NodeStatus>([
      ["continued-task", taskStatus],
      ["report", "succeeded"]
    ]);
    const input = {
      records: [],
      state: {
        provenance: { recovery: { workflow_run_id: "workflow", failed_nodes: [] } },
        nodes: {
          "continued-task": { status: taskStatus },
          report: {
            status: "succeeded",
            provenance: { workflow: { run_id: "workflow", task_id: "node:report", attempt: 2 } }
          }
        }
      },
      inspect,
      nodeStatuses,
      observedTaskEvidence: new Map([
        ["continued-task", { status: taskStatus, workflowState: "failed", taskId: "node:continued-task", attempt: 2 }],
        ["report", { status: "succeeded", workflowState: "finished", taskId: "node:report", attempt: 2 }]
      ]),
      evidenceComplete: true,
      workflowRunId: "workflow",
      workflowLinkId: "link",
      controlGeneration: "generation",
      tasks: []
    };

    for (const requireComplete of [false, true]) {
      const nonBlockingNodeIds = new Set(requireComplete ? [] : ["continued-task"]);
      const recoveredAggregateAuthorized = recoveryAuthorizesTerminalAggregate({ ...input, nonBlockingNodeIds });
      assert.equal(recoveredAggregateAuthorized, !requireComplete);
      assert.equal(
        finalRunStatus(inspect, nodeStatuses, "failed", {
          evidenceComplete: true,
          recoveredAggregateAuthorized,
          nonBlockingNodeIds
        }),
        requireComplete ? "failed" : "succeeded"
      );
    }
    assert.equal(
      finalRunStatus(inspect, nodeStatuses, "failed", {
        evidenceComplete: true,
        recoveredAggregateAuthorized: true,
        nonBlockingNodeIds: new Set()
      }),
      "failed",
      "a failure or timeout remains blocking even if recovery authorization was computed earlier"
    );
  });
}

test("recovery cannot turn incomplete current task evidence into successful completion", () => {
  const { recoveryAuthorizesTerminalAggregate } = terminalPolicyHelpers();
  for (const status of ["pending", "ready", "runnable", "running", "skipped", "invalidated"] as const) {
    const authorized = recoveryAuthorizesTerminalAggregate({
      records: [],
      state: { provenance: { recovery: {} } },
      inspect: { runState: "failed" },
      nodeStatuses: new Map([["report", status]]),
      nonBlockingNodeIds: new Set(),
      evidenceComplete: true,
      observedTaskEvidence: new Map([["report", {}]])
    });
    assert.equal(authorized, false, status);
  }
  assert.equal(
    recoveryAuthorizesTerminalAggregate({
      records: [],
      state: { provenance: { recovery: {} } },
      inspect: { runState: "failed" },
      nodeStatuses: new Map([["report", "succeeded"]]),
      nonBlockingNodeIds: new Set(),
      evidenceComplete: false,
      observedTaskEvidence: new Map([["report", {}]])
    }),
    false
  );
});
