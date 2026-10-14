import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  clearPersistedTaskDependencyChanges,
  persistTaskDependencyChanges,
  readPersistedTaskDependencyChanges,
  readRunDependencyChanges
} from "../src/dependency-change-records.js";
import { withWholeRunSummary } from "../src/terminal-report-projection.js";
import { temporaryRoot } from "./temporary-root.js";

function marker(attemptId: string, dependencyChanges?: unknown): Record<string, unknown> {
  return {
    schema_version: "ultrafuzz.artifact-verification.v2",
    attempt_id: attemptId,
    node_id: attemptId,
    artifacts: [
      {
        path: "stdout.txt",
        contract: "ultrafuzz/text@1",
        contract_digest: "a".repeat(64),
        sha256: "b".repeat(64),
        primary: true
      }
    ],
    publications: [{ path: "stdout.txt", sha256: "b".repeat(64) }],
    ...(dependencyChanges === undefined ? {} : { dependency_changes: dependencyChanges })
  };
}

test("a run's restored dependency edits are read from its verification markers in attempt order (#1251)", (context) => {
  const runRoot = temporaryRoot("ufz-dependency-changes-");
  context.after(() => fs.rmSync(runRoot, { recursive: true, force: true }));
  assert.deepEqual(readRunDependencyChanges(runRoot), [], "a run without markers records nothing");

  const markers = path.join(runRoot, ".ultrafuzz-verification");
  fs.mkdirSync(markers);
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(markers, name), JSON.stringify(value));
  write("zeta.json", marker("zeta", { changed_path_count: 3, changed_paths: ["lib/a/one.sol"] }));
  write("alpha.json", marker("alpha", { changed_path_count: 1, changed_paths: ["lib/b/two.sol"] }));
  write("clean.json", marker("clean"));
  write("malformed.json", { ...marker("malformed"), dependency_changes: { changed_path_count: 0, changed_paths: [] } });
  fs.writeFileSync(path.join(markers, "broken.json"), "{");

  assert.deepEqual(readRunDependencyChanges(runRoot), [
    { attempt_id: "alpha", changed_path_count: 1, changed_paths: ["lib/b/two.sol"] },
    { attempt_id: "zeta", changed_path_count: 3, changed_paths: ["lib/a/one.sol"] }
  ]);
});

test("the runtime restates dependency changes into the Run summary metadata, replacing any agent copy", () => {
  const change = { attempt_id: "alpha", changed_path_count: 1, changed_paths: ["lib/b/two.sol"] };
  const agentCopy = { run_id: "r", dependency_changes: [{ ...change, attempt_id: "forged" }] };
  assert.deepEqual(withWholeRunSummary(agentCopy, undefined, undefined, [change]).dependency_changes, [change]);
  assert.equal("dependency_changes" in withWholeRunSummary(agentCopy, undefined, undefined, []), false);
  assert.deepEqual(
    withWholeRunSummary(agentCopy, undefined, undefined).dependency_changes,
    agentCopy.dependency_changes
  );
});

test("a task's dependency record survives a restart until its next attempt clears it", (context) => {
  const runRoot = temporaryRoot("ufz-pending-dependency-changes-");
  context.after(() => fs.rmSync(runRoot, { recursive: true, force: true }));
  const changes = { changed_path_count: 2, changed_paths: ["lib/a/one.sol", "lib/a/two words.sol"] };
  assert.equal(readPersistedTaskDependencyChanges(runRoot, "task-a"), undefined);
  persistTaskDependencyChanges(runRoot, "task-a", changes);
  assert.deepEqual(readPersistedTaskDependencyChanges(runRoot, "task-a"), changes);
  assert.equal(readPersistedTaskDependencyChanges(runRoot, "task-b"), undefined);
  clearPersistedTaskDependencyChanges(runRoot, "task-a");
  assert.equal(readPersistedTaskDependencyChanges(runRoot, "task-a"), undefined);
  clearPersistedTaskDependencyChanges(runRoot, "task-a");
});

test("direct writes and pending rereads durably omit sensitive names while preserving counts", (context) => {
  const runRoot = temporaryRoot("ufz-safe-dependency-changes-");
  const name = "ULTRAFUZZ_TEST_DEPENDENCY_PASSWORD";
  const previous = process.env[name];
  const credential = 'dependency-"quoted"-secret-value';
  process.env[name] = credential;
  context.after(() => {
    if (previous === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = previous;
  });
  const input = { changed_path_count: 1, changed_paths: [`lib/dependency/${credential}.sol`] };
  const expected = { changed_path_count: 1, changed_paths: [] };
  persistTaskDependencyChanges(runRoot, "write", input);
  const pending = path.join(runRoot, ".ultrafuzz-dependency-changes");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(pending, "write.json"), "utf8")), expected);
  fs.writeFileSync(path.join(pending, "read.json"), JSON.stringify(input));
  assert.deepEqual(readPersistedTaskDependencyChanges(runRoot, "read"), expected);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(pending, "read.json"), "utf8")), expected);
  Reflect.deleteProperty(process.env, name);
  assert.deepEqual(readPersistedTaskDependencyChanges(runRoot, "write"), expected);
  assert.deepEqual(readPersistedTaskDependencyChanges(runRoot, "read"), expected);
  const markers = path.join(runRoot, ".ultrafuzz-verification");
  fs.mkdirSync(markers);
  fs.writeFileSync(path.join(markers, "write.json"), JSON.stringify(marker("write", expected)));
  assert.deepEqual(readRunDependencyChanges(runRoot), [{ attempt_id: "write", ...expected }]);
});
