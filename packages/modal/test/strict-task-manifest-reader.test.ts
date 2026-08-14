import fs from "node:fs";
import path from "node:path";

import { expect, it } from "vitest";

import { inspectTerminalDispositionAtRunRoot } from "../src/terminal-disposition.js";
import { currentGenuineTaskFailureState, writeCurrentSmithersTaskFixture } from "./current-artifact-fixtures.js";

function genuineFailureRun(): { runRoot: string; statePath: string; tasksPath: string; graphPath: string } {
  const runRoot = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-strict-task-reader-"));
  const statePath = path.join(runRoot, "state.json");
  fs.writeFileSync(statePath, `${JSON.stringify(currentGenuineTaskFailureState("task-one"))}\n`);
  writeCurrentSmithersTaskFixture(runRoot, "task-one");
  return {
    runRoot,
    statePath,
    tasksPath: path.join(runRoot, "smithers", "tasks.json"),
    graphPath: path.join(runRoot, "graph.json")
  };
}

it("classifies only a current strict task manifest joined to its planned graph", () => {
  const fixture = genuineFailureRun();
  expect(inspectTerminalDispositionAtRunRoot(fixture.runRoot)).toEqual({
    kind: "genuine-task-failures",
    failedTasks: 1,
    operationalFailures: 0
  });

  const currentState = fs.readFileSync(fixture.statePath, "utf8");
  fs.writeFileSync(
    fixture.statePath,
    currentState.replace(
      '"schema_version":"ultrafuzz.run-state.v5"',
      '"schema_version":"ultrafuzz.run-state.v5","schema_version":"ultrafuzz.run-state.v5"'
    )
  );
  expect(inspectTerminalDispositionAtRunRoot(fixture.runRoot).kind).toBe("operational-failure");
  fs.writeFileSync(fixture.statePath, currentState.replace("ultrafuzz.run-state.v5", "ultrafuzz.run-state.v4"));
  expect(inspectTerminalDispositionAtRunRoot(fixture.runRoot).kind).toBe("operational-failure");
  fs.writeFileSync(fixture.statePath, currentState);

  const currentTasks = fs.readFileSync(fixture.tasksPath, "utf8");
  fs.writeFileSync(
    fixture.tasksPath,
    currentTasks.replace("ultrafuzz.smithers.workflow.v4", "ultrafuzz.smithers.workflow.v2")
  );
  expect(inspectTerminalDispositionAtRunRoot(fixture.runRoot).kind).toBe("operational-failure");

  fs.writeFileSync(
    fixture.tasksPath,
    currentTasks.replace(
      /"schema_version"\s*:\s*"ultrafuzz\.smithers\.workflow\.v4"/u,
      '"schema_version":"ultrafuzz.smithers.workflow.v4","schema_version":"ultrafuzz.smithers.workflow.v4"'
    )
  );
  expect(inspectTerminalDispositionAtRunRoot(fixture.runRoot).kind).toBe("operational-failure");

  fs.writeFileSync(fixture.tasksPath, currentTasks);
  const graph = JSON.parse(fs.readFileSync(fixture.graphPath, "utf8")) as {
    nodes: Array<{ id: string; workflow?: unknown }>;
  };
  delete graph.nodes.find((node) => node.id === "task-one")!.workflow;
  fs.writeFileSync(fixture.graphPath, `${JSON.stringify(graph)}\n`);
  expect(inspectTerminalDispositionAtRunRoot(fixture.runRoot).kind).toBe("operational-failure");
});
