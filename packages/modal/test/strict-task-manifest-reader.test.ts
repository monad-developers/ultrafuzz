import fs from "node:fs";
import path from "node:path";

import { expect, it } from "vitest";

import { inspectTerminalDispositionAtRunRoot } from "../src/terminal-disposition.js";
import { currentGenuineTaskFailureState, writeCurrentSmithersTaskFixture } from "./current-artifact-fixtures.js";

function genuineFailureRun(): { runRoot: string; tasksPath: string; graphPath: string } {
  const runRoot = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "ultrafuzz-strict-task-reader-"));
  fs.writeFileSync(path.join(runRoot, "state.json"), `${JSON.stringify(currentGenuineTaskFailureState("task-one"))}\n`);
  writeCurrentSmithersTaskFixture(runRoot, "task-one");
  return {
    runRoot,
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

  const currentTasks = fs.readFileSync(fixture.tasksPath, "utf8");
  fs.writeFileSync(
    fixture.tasksPath,
    currentTasks.replace("ultrafuzz.smithers.workflow.v2", "ultrafuzz.smithers.workflow.v1")
  );
  expect(inspectTerminalDispositionAtRunRoot(fixture.runRoot).kind).toBe("operational-failure");

  fs.writeFileSync(
    fixture.tasksPath,
    currentTasks.replace(
      '"schema_version":"ultrafuzz.smithers.workflow.v2"',
      '"schema_version":"ultrafuzz.smithers.workflow.v2","schema_version":"ultrafuzz.smithers.workflow.v2"'
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
