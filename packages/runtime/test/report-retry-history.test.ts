import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import * as ts from "typescript";
import { parseStrictJsonBytes, type SmithersTaskManifestTask } from "@ultrafuzz/artifacts";

import {
  inspectSmithersAttemptAgentSelection,
  reconcileSmithersAttemptAgentSelection,
  smithersTaskAgentId
} from "../src/smithers-attempt-authority.js";

type Selection = { attempt: number; chainIndex: number };
type Execution = {
  planned_chain: Array<{ attempt: number; profile_id: string }>;
  failed_attempts: Array<{ attempt: number; profile_id: string }>;
  producer: { attempt: number; profile_id: string };
};
type Task = SmithersTaskManifestTask & { id: string; smithersRunId: string };

function taskFixture(singleRung = false): Task {
  const profiles = ["primary", "fallback-a", "fallback-b"];
  return {
    attemptId: "report",
    id: "node:report",
    smithersNodeId: "node:report",
    smithersRunId: "report-history",
    execution: { mode: "local" },
    agentChain: profiles.slice(0, singleRung ? 1 : 3).map((profileId, index) => ({
      profileId,
      agentRef: "CodexAgent",
      modelName: "synthetic-model",
      role: index === 0 ? "primary" : "fallback"
    }))
  } as Task;
}

function attempt(task: Task, number: number, chainIndex: number | null, state = "failed") {
  return {
    nodeId: task.smithersNodeId,
    attempt: number,
    state,
    meta:
      chainIndex === null
        ? { agentChainIndex: null, agentId: null, agentModel: null }
        : {
            agentChainIndex: chainIndex,
            agentId: smithersTaskAgentId(task, chainIndex),
            agentModel: "synthetic-model"
          }
  };
}

function loadAuthority(readDetail: () => unknown) {
  const source = fs.readFileSync(
    new URL("../../src/templates/smithers/workflows/workflow.tsx", import.meta.url),
    "utf8"
  );
  const projectionStart = source.indexOf("function finalReportAgentExecution");
  const projectionEnd = source.indexOf("\n\ntype FinalReportPromptAuthorityProjection", projectionStart);
  const authorityStart = source.indexOf("const finalReportAgentExecutionAuthority");
  const authorityEnd = source.indexOf("\n\nfunction baseAgentForProfile", authorityStart);
  assert.ok(projectionStart >= 0 && projectionEnd > projectionStart);
  assert.ok(authorityStart >= 0 && authorityEnd > authorityStart);
  const helper = ts.transpileModule(
    `${source.slice(projectionStart, projectionEnd)}\n${source.slice(authorityStart, authorityEnd)}`,
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }
  ).outputText;
  return new Function(
    "execFileSync",
    "parseStrictJsonBytes",
    "isPlainJsonRecord",
    "reconcileSmithersAttemptAgentSelection",
    "inspectSmithersAttemptAgentSelection",
    "declaredFinalReportOutputPair",
    `${helper}; return {
      selections: finalReportAgentSelectionsForAttempt,
      project: finalReportAgentExecution,
      remember: rememberFinalReportAgentExecutionAuthority,
      read: authoritativeFinalReportAgentExecution
    };`
  )(
    (_file: string, args: string[]) => {
      assert.deepEqual(args, ["node", "node:report", "-r", "report-history", "--format", "json", "--full-output"]);
      return JSON.stringify(readDetail());
    },
    parseStrictJsonBytes,
    (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value),
    reconcileSmithersAttemptAgentSelection,
    inspectSmithersAttemptAgentSelection,
    () => ({})
  ) as {
    selections(task: Task, currentAttempt: number, chainIndex: number): Selection[];
    project(task: Task, chainIndex: number, selections: Selection[]): Execution;
    remember(task: Task, execution: Execution): void;
    read(task: Task): Execution;
  };
}

test("report retry prompt and fresh verifier preserve durable physical attempts across restarts", () => {
  const task = taskFixture();
  const attempts = [attempt(task, 4, 1, "running"), attempt(task, 1, 2), attempt(task, 3, 2), attempt(task, 2, null)];
  const detail = { ok: true, data: { node: { nodeId: task.id, lastAttempt: 4 }, attempts } };
  let reads = 0;
  const readDetail = () => {
    reads += 1;
    return detail;
  };
  const producerProcess = loadAuthority(readDetail);
  const selections = producerProcess.selections(task, 4, 1);
  assert.deepEqual(selections, [
    { attempt: 1, chainIndex: 2 },
    { attempt: 3, chainIndex: 2 },
    { attempt: 4, chainIndex: 1 }
  ]);
  const prompt = producerProcess.project(task, 1, selections);
  assert.deepEqual(
    prompt.failed_attempts.map((row) => [row.attempt, row.profile_id]),
    [
      [1, "fallback-b"],
      [3, "fallback-b"]
    ]
  );
  assert.equal(prompt.producer.attempt, 4);
  assert.equal(prompt.producer.profile_id, "fallback-a");
  producerProcess.remember(task, prompt);
  assert.deepEqual(producerProcess.read(task), prompt);
  assert.deepEqual(producerProcess.selections(task, 4, 1), selections);
  assert.equal(reads, 1, "same-attempt rerenders must retain the original authority");
  const resumedProducerProcess = loadAuthority(readDetail);
  assert.deepEqual(resumedProducerProcess.project(task, 1, resumedProducerProcess.selections(task, 4, 1)), prompt);
  attempts[0] = attempt(task, 4, 1, "finished");
  assert.deepEqual(
    loadAuthority(readDetail).read(task),
    prompt,
    "verifier-only restart must accept copied prompt data"
  );
});

test("a local single-rung report retains quota-exempt physical retry history", () => {
  const task = taskFixture(true);
  const detail = {
    node: { nodeId: task.id, lastAttempt: 2 },
    attempts: [attempt(task, 1, 0), attempt(task, 2, 0, "running")]
  };
  const authority = loadAuthority(() => detail);
  const prompt = authority.project(task, 0, authority.selections(task, 2, 0));
  detail.attempts[1] = attempt(task, 2, 0, "finished");
  const verified = loadAuthority(() => detail).read(task);
  assert.deepEqual(verified, prompt);
  assert.equal(verified.producer.attempt, 2);
  assert.deepEqual(
    verified.failed_attempts.map((row) => row.attempt),
    [1]
  );
});

test("ordinary report retries retain complete in-process history without another CLI dependency", () => {
  const task = taskFixture();
  const authority = loadAuthority(() => assert.fail("the controller already observed every selected attempt"));
  assert.deepEqual(authority.selections(task, 1, 2), [{ attempt: 1, chainIndex: 2 }]);
  // An unselected preflight at physical attempt 2 need not appear as a model
  // execution; the complete selected history still resides in this process.
  const selections = authority.selections(task, 3, 1);
  const execution = authority.project(task, 1, selections);
  assert.deepEqual(
    execution.failed_attempts.map((row) => row.attempt),
    [1]
  );
  assert.equal(execution.producer.attempt, 3);
  assert.throws(() => authority.selections(task, 2, 0), /moved behind its observed history/u);
});

test("report history fails closed on inconsistent or untrusted prior attempts", () => {
  const task = taskFixture();
  const valid = {
    node: { nodeId: task.id, lastAttempt: 2 },
    attempts: [attempt(task, 1, 0), attempt(task, 2, 1, "running")]
  };
  const invalid = [
    { ...valid, node: { ...valid.node, nodeId: "node:other" } },
    { ...valid, node: { ...valid.node, lastAttempt: 1 } },
    { ...valid, attempts: [attempt(task, 1, 0), attempt(task, 1, 0), attempt(task, 2, 1, "running")] },
    { ...valid, attempts: [attempt(task, 1, 0, "running"), attempt(task, 2, 1, "running")] },
    { ...valid, attempts: [attempt(task, 1, null, "finished"), attempt(task, 2, 1, "running")] },
    { ...valid, attempts: [{ ...attempt(task, 1, 0), nodeId: "node:other" }, attempt(task, 2, 1, "running")] }
  ];
  for (const detail of invalid) {
    assert.throws(() => loadAuthority(() => detail).selections(task, 2, 1), /Smithers/u);
  }
  const authority = loadAuthority(() => valid);
  authority.selections(task, 2, 1);
  assert.throws(() => authority.selections(task, 2, 2), /selection changed within an attempt/u);
});
