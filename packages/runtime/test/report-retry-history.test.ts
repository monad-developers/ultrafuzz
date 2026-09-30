import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as ts from "typescript";
import { parseStrictJsonBytes, readRegularFileSnapshot, writeFileDurable } from "@ultrafuzz/artifacts";

import { temporaryRoot } from "./temporary-root.js";

type Selection = { attempt: number; chainIndex: number };
type Execution = {
  planned_chain: Array<{ attempt: number; profile_id: string }>;
  failed_attempts: Array<{ attempt: number; profile_id: string }>;
  producer: { attempt: number; profile_id: string };
};
type Task = {
  attemptId: string;
  runRoot: string;
  agentChain: Array<{ profileId: string; agentRef: string; modelName: string; role: "primary" | "fallback" }>;
};

function taskFixture(options: { singleRung?: boolean } = {}): Task {
  const profiles = ["primary", "fallback-a", "fallback-b"];
  return {
    attemptId: "report",
    runRoot: temporaryRoot("ultrafuzz-report-history-"),
    agentChain: profiles.slice(0, options.singleRung === true ? 1 : 3).map((profileId, index) => ({
      profileId,
      agentRef: "CodexAgent",
      modelName: "synthetic-model",
      role: index === 0 ? "primary" : "fallback"
    }))
  };
}

// The documented location of the run's report-producer selection record.
function recordPath(task: Task): string {
  return path.join(task.runRoot, "smithers", "final-report-selections", `${task.attemptId}.json`);
}

const workflowSource = fs.readFileSync(
  new URL("../../src/templates/smithers/workflows/workflow.tsx", import.meta.url),
  "utf8"
);
const helperRanges: ReadonlyArray<readonly [string, string]> = [
  ["function finalReportAgentExecution", "\n\ntype FinalReportPromptAuthorityProjection"],
  ["const finalReportAgentExecutionAuthority", "\n\nfunction baseAgentForProfile"],
  ["function isMissingPathError", "\n\nfunction compareCanonicalRuntimeStrings"]
];
const helper = ts.transpileModule(
  helperRanges
    .map(([startMarker, endMarker]) => {
      const start = workflowSource.indexOf(startMarker);
      const end = workflowSource.indexOf(endMarker, start);
      assert.ok(start >= 0 && end > start, startMarker);
      return workflowSource.slice(start, end);
    })
    .join("\n"),
  { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }
).outputText;

/**
 * Loads the generated workflow's report-producer helpers. Every call is a fresh
 * controller process: the process-local selection and execution maps start
 * empty, and only the run directory carries history between calls.
 */
function loadAuthority() {
  return new Function(
    "declaredFinalReportOutputPair",
    "isPlainJsonRecord",
    "lstatSync",
    "parseStrictJsonBytes",
    "path",
    "readRegularFileSnapshot",
    "realpathSync",
    "writeFileDurable",
    `${helper}; return {
      selections: finalReportAgentSelectionsForAttempt,
      project: finalReportAgentExecution,
      remember: rememberFinalReportAgentExecutionAuthority,
      read: authoritativeFinalReportAgentExecution
    };`
  )(
    () => ({}),
    (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value),
    fs.lstatSync,
    parseStrictJsonBytes,
    path,
    readRegularFileSnapshot,
    fs.realpathSync,
    writeFileDurable
  ) as {
    selections(task: Task, currentAttempt: number, chainIndex: number): Selection[];
    project(task: Task, chainIndex: number, selections: Selection[]): Execution;
    remember(task: Task, execution: Execution): void;
    read(task: Task): Execution;
  };
}

test("a restarted report producer and a restarted verifier rebuild agent_execution from the run", () => {
  const task = taskFixture();
  // Controller process 1: the primary's attempt 1 runs and fails.
  assert.deepEqual(loadAuthority().selections(task, 1, 0), [{ attempt: 1, chainIndex: 0 }]);
  // Attempt 2 failed its preflight and never generated. Controller process 2
  // runs attempt 3 on the first fallback.
  const producerProcess = loadAuthority();
  const selections = producerProcess.selections(task, 3, 1);
  assert.deepEqual(selections, [
    { attempt: 1, chainIndex: 0 },
    { attempt: 3, chainIndex: 1 }
  ]);
  const prompt = producerProcess.project(task, 1, selections);
  assert.deepEqual(
    prompt.failed_attempts.map((row) => [row.attempt, row.profile_id]),
    [[1, "primary"]]
  );
  assert.deepEqual([prompt.producer.attempt, prompt.producer.profile_id], [3, "fallback-a"]);
  producerProcess.remember(task, prompt);
  assert.deepEqual(producerProcess.selections(task, 3, 1), selections, "a correction turn keeps its attempt");
  // Controller process 3 runs only the verifier.
  assert.deepEqual(loadAuthority().read(task), prompt);
});

test("an attempt number dispatched again after a restart replaces its own recorded selection", () => {
  const task = taskFixture();
  const first = loadAuthority();
  first.selections(task, 1, 0);
  first.selections(task, 2, 1);
  assert.deepEqual(loadAuthority().selections(task, 2, 1), [
    { attempt: 1, chainIndex: 0 },
    { attempt: 2, chainIndex: 1 }
  ]);
  const verified = loadAuthority().read(task);
  assert.deepEqual(
    verified.failed_attempts.map((row) => row.attempt),
    [1]
  );
  assert.equal(verified.producer.attempt, 2);

  // A node that Smithers restarts from attempt 1 starts a new history.
  loadAuthority().selections(task, 1, 0);
  const restarted = loadAuthority().read(task);
  assert.deepEqual(restarted.failed_attempts, []);
  assert.deepEqual([restarted.producer.attempt, restarted.producer.profile_id], [1, "primary"]);
});

test("a single-rung report keeps quota-exempt physical retries across restarts", () => {
  const task = taskFixture({ singleRung: true });
  loadAuthority().selections(task, 1, 0);
  const producer = loadAuthority();
  const prompt = producer.project(task, 0, producer.selections(task, 2, 0));
  const verified = loadAuthority().read(task);
  assert.deepEqual(verified, prompt);
  assert.equal(verified.producer.attempt, 2);
  assert.deepEqual(
    verified.failed_attempts.map((row) => row.attempt),
    [1]
  );
});

test("ordinary report retries keep their in-process history and reject an attempt moving backwards", () => {
  const task = taskFixture();
  const authority = loadAuthority();
  assert.deepEqual(authority.selections(task, 1, 2), [{ attempt: 1, chainIndex: 2 }]);
  const selections = authority.selections(task, 3, 1);
  const execution = authority.project(task, 1, selections);
  assert.deepEqual(
    execution.failed_attempts.map((row) => row.attempt),
    [1]
  );
  assert.equal(execution.producer.attempt, 3);
  assert.throws(() => authority.selections(task, 2, 0), /moved behind its observed history/u);
  assert.throws(() => authority.selections(task, 3, 2), /selection changed within an attempt/u);
});

test("a missing or malformed selection record fails the report instead of inventing a producer", () => {
  const task = taskFixture();
  assert.throws(() => loadAuthority().read(task), /report producer selection was never recorded/u);
  fs.mkdirSync(path.dirname(recordPath(task)), { recursive: true });
  for (const malformed of [
    "not json",
    '{"attempt":1,"chainIndex":0}',
    "[null]",
    '[{"attempt":1}]',
    '[{"attempt":"1","chainIndex":0}]',
    '[{"attempt":1.5,"chainIndex":0}]'
  ]) {
    fs.writeFileSync(recordPath(task), malformed);
    assert.throws(() => loadAuthority().selections(task, 2, 1), /selections are malformed/u, malformed);
    assert.throws(() => loadAuthority().read(task), /selections are malformed/u, malformed);
  }
  for (const inconsistent of [
    [
      { attempt: 2, chainIndex: 0 },
      { attempt: 1, chainIndex: 1 }
    ],
    [{ attempt: 1, chainIndex: 3 }],
    [{ attempt: 0, chainIndex: 0 }]
  ]) {
    fs.writeFileSync(recordPath(task), JSON.stringify(inconsistent));
    const producer = loadAuthority();
    assert.throws(
      () => producer.project(task, 1, producer.selections(task, 3, 1)),
      /outside the sealed agent chain/u,
      JSON.stringify(inconsistent)
    );
    fs.writeFileSync(recordPath(task), JSON.stringify(inconsistent));
    assert.throws(() => loadAuthority().read(task), /outside the sealed agent chain/u, JSON.stringify(inconsistent));
  }
});
