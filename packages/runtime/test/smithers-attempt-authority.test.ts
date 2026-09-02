import assert from "node:assert/strict";
import test from "node:test";

import type { SmithersTaskManifestTask } from "@ultrafuzz/artifacts";

import {
  inspectSmithersAttemptAgentSelection,
  reconcileSmithersAttemptAgentSelection,
  smithersTaskAgentId
} from "../src/smithers-attempt-authority.js";

function sealedTask(
  agentChain: Array<{
    profileId: string;
    agentRef: string;
    modelName: string;
    role: "primary" | "fallback";
  }>
): SmithersTaskManifestTask {
  return {
    attemptId: "authority-task",
    smithersNodeId: "node:authority-task",
    agentChain
  } as unknown as SmithersTaskManifestTask;
}

function terminalDetail(
  task: SmithersTaskManifestTask,
  input: { attempt: number; chainIndex?: number; agentId?: string; agentModel?: string }
): unknown {
  return {
    node: { nodeId: task.smithersNodeId, lastAttempt: input.attempt },
    attempts: [
      {
        nodeId: task.smithersNodeId,
        attempt: input.attempt,
        state: "finished",
        meta: {
          ...(input.chainIndex === undefined ? {} : { agentChainIndex: input.chainIndex }),
          ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
          ...(input.agentModel === undefined ? {} : { agentModel: input.agentModel })
        }
      }
    ]
  };
}

test("Smithers authority accepts a preflight or quota selection that skips ordinal retry rungs", () => {
  const task = sealedTask([
    { profileId: "primary", agentRef: "CodexAgent", modelName: "gpt-primary", role: "primary" },
    { profileId: "quota-parked", agentRef: "CodexAgent", modelName: "gpt-parked", role: "fallback" },
    { profileId: "available", agentRef: "DeepSeekAgent", modelName: "deepseek-chat", role: "fallback" }
  ]);
  const detail = terminalDetail(task, {
    attempt: 1,
    chainIndex: 2,
    agentId: smithersTaskAgentId(task, 2),
    agentModel: "deepseek-chat"
  });

  const selection = reconcileSmithersAttemptAgentSelection(task, detail, 1);

  assert.equal(selection.chainIndex, 2);
  assert.equal(selection.profile.profileId, "available");
});

test("Smithers authority distinguishes opaque profiles that share the same model", () => {
  const task = sealedTask([
    { profileId: "profile-a", agentRef: "CodexAgent", modelName: "shared-model", role: "primary" },
    { profileId: "profile-b", agentRef: "DeepSeekAgent", modelName: "shared-model", role: "fallback" }
  ]);
  const detail = terminalDetail(task, {
    attempt: 1,
    chainIndex: 1,
    agentId: smithersTaskAgentId(task, 1),
    agentModel: "shared-model"
  });

  const selection = reconcileSmithersAttemptAgentSelection(task, detail, 1);

  assert.equal(selection.chainIndex, 1);
  assert.equal(selection.profile.profileId, "profile-b");
  assert.equal(selection.profile.agentRef, "DeepSeekAgent");
});

test("Smithers authority reconciles quota-exempt physical attempts beyond the sealed chain length", () => {
  const task = sealedTask([
    { profileId: "primary", agentRef: "CodexAgent", modelName: "gpt-primary", role: "primary" },
    { profileId: "fallback", agentRef: "DeepSeekAgent", modelName: "deepseek-chat", role: "fallback" }
  ]);
  const detail = {
    node: { nodeId: task.smithersNodeId, lastAttempt: 3 },
    attempts: [
      {
        nodeId: task.smithersNodeId,
        attempt: 1,
        state: "failed",
        meta: { agentChainIndex: 0, agentId: smithersTaskAgentId(task, 0), agentModel: "gpt-primary" }
      },
      {
        nodeId: task.smithersNodeId,
        attempt: 2,
        state: "failed",
        meta: { agentChainIndex: 1, agentId: smithersTaskAgentId(task, 1), agentModel: "deepseek-chat" }
      },
      {
        nodeId: task.smithersNodeId,
        attempt: 3,
        state: "finished",
        meta: { agentChainIndex: 0, agentId: smithersTaskAgentId(task, 0), agentModel: "gpt-primary" }
      }
    ]
  };

  const selection = reconcileSmithersAttemptAgentSelection(task, detail, 3);

  assert.equal(selection.chainIndex, 0);
  assert.equal(selection.profile.profileId, "primary");
});

test("Smithers authority fails closed when durable selection metadata is missing or mismatched", () => {
  const task = sealedTask([
    { profileId: "profile-a", agentRef: "CodexAgent", modelName: "shared-model", role: "primary" },
    { profileId: "profile-b", agentRef: "DeepSeekAgent", modelName: "shared-model", role: "fallback" }
  ]);

  assert.throws(
    () =>
      reconcileSmithersAttemptAgentSelection(
        task,
        terminalDetail(task, {
          attempt: 1,
          agentId: smithersTaskAgentId(task, 0),
          agentModel: "shared-model"
        }),
        1
      ),
    /no sealed agent-chain selection/u
  );
  assert.throws(
    () =>
      reconcileSmithersAttemptAgentSelection(
        task,
        terminalDetail(task, {
          attempt: 1,
          chainIndex: 1,
          agentId: smithersTaskAgentId(task, 0),
          agentModel: "shared-model"
        }),
        1
      ),
    /agent ID does not match sealed chain rung 1/u
  );
});

test("Smithers authority distinguishes a pre-agent terminal failure from an executed attempt", () => {
  const task = sealedTask([
    { profileId: "primary", agentRef: "CodexAgent", modelName: "gpt-primary", role: "primary" }
  ]);
  const failedBeforeSelection = {
    node: { nodeId: task.smithersNodeId, lastAttempt: 1 },
    attempts: [{ nodeId: task.smithersNodeId, attempt: 1, state: "failed", meta: {} }]
  };

  assert.equal(inspectSmithersAttemptAgentSelection(task, failedBeforeSelection, 1), undefined);
  assert.throws(
    () => reconcileSmithersAttemptAgentSelection(task, failedBeforeSelection, 1),
    /no sealed agent-chain selection/u
  );
  assert.throws(
    () =>
      inspectSmithersAttemptAgentSelection(
        task,
        {
          node: { nodeId: task.smithersNodeId, lastAttempt: 1 },
          attempts: [
            {
              nodeId: task.smithersNodeId,
              attempt: 1,
              state: "failed",
              meta: { agentId: smithersTaskAgentId(task, 0) }
            }
          ]
        },
        1
      ),
    /no sealed agent-chain selection/u
  );
});
