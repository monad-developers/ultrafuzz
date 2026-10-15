import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { ARTIFACT_SECRET_GATE_ERROR_CODE, isRecord, type NodeState, type NodeStatus } from "@ultrafuzz/artifacts";

type Task = {
  concreteNodeId: string;
  attemptId: string;
  metadata: { node: { storageId?: string } };
};
type Graph = { nodes: Array<{ id: string; dynamic?: { status: string; generated_node_ids: string[] } }> };
type Nodes = Record<string, Pick<NodeState, "status" | "provenance">>;

/** Exercise the private production selection without loading the workflow controller's I/O. */
function loadWithheldReportStateIds(): (graph: Graph, tasks: readonly Task[], nodes: Nodes) => ReadonlySet<string> {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const runtimeRoot = fs.existsSync(path.resolve(directory, "../src/workflow-sync.ts"))
    ? path.resolve(directory, "..")
    : path.resolve(directory, "../..");
  const filename = path.join(runtimeRoot, "src/workflow-sync.ts");
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
  const names = new Set(["withheldReportNodeIds", "withheldReportStateIds", "recordField"]);
  const declarations = source.statements.flatMap((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name !== undefined && names.has(statement.name.text)
      ? [statement.getText(source)]
      : []
  );
  assert.equal(declarations.length, names.size);
  const emitted = ts.transpileModule(declarations.join("\n"), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  return new Function("ARTIFACT_SECRET_GATE_ERROR_CODE", "isRecord", `${emitted}; return withheldReportStateIds;`)(
    ARTIFACT_SECRET_GATE_ERROR_CODE,
    isRecord
  ) as ReturnType<typeof loadWithheldReportStateIds>;
}

const withheldReportStateIds = loadWithheldReportStateIds();

function withheldNode(attemptId: string): Nodes[string] {
  return {
    status: "failed",
    provenance: {
      failure: {
        category: "artifact-contract",
        causal_task_id: attemptId,
        causal_failure_category: "artifact-contract",
        dependent_task_ids: [],
        reason_code: ARTIFACT_SECRET_GATE_ERROR_CODE
      }
    }
  };
}

function fixture(): { graph: Graph; tasks: Task[]; nodes: Nodes } {
  return {
    graph: {
      nodes: [
        { id: "reports", dynamic: { status: "expanded", generated_node_ids: ["report-a", "report-b"] } },
        { id: "report-a" },
        { id: "report-b" }
      ]
    },
    tasks: [
      { concreteNodeId: "report-a", attemptId: "a-claude", metadata: { node: { storageId: "storage-a" } } },
      { concreteNodeId: "report-a", attemptId: "a-codex", metadata: { node: { storageId: "storage-a" } } },
      { concreteNodeId: "report-b", attemptId: "b-codex", metadata: { node: { storageId: "storage-b" } } }
    ],
    nodes: {
      "a-claude": withheldNode("a-claude"),
      "a-codex": { status: "succeeded" },
      "b-codex": { status: "reused-from-prior-run" },
      "storage-a": { status: "failed" },
      "storage-b": { status: "reused-from-prior-run" },
      reports: { status: "failed" }
    }
  };
}

function selected(input: ReturnType<typeof fixture>): string[] {
  return [...withheldReportStateIds(input.graph, input.tasks, input.nodes)].sort();
}

test("withheld report attempts roll up through model fanout and an expanded dynamic group", () => {
  const input = fixture();
  assert.deepEqual(selected(input), ["a-claude", "reports", "storage-a"]);
  // The group is visited before the concrete graph nodes, and task order is not significant.
  input.tasks.reverse();
  assert.deepEqual(selected(input), ["a-claude", "reports", "storage-a"]);
  // A generated node without a separate aggregate uses its attempts directly.
  delete input.nodes["storage-b"];
  assert.deepEqual(selected(input), ["a-claude", "reports", "storage-a"]);
});

test("unfinished or independently failed siblings keep both report aggregates blocking", () => {
  const blocking: NodeStatus[] = [
    "pending",
    "ready",
    "runnable",
    "running",
    "skipped",
    "failed",
    "timed-out",
    "invalidated"
  ];
  for (const status of blocking) {
    const input = fixture();
    input.nodes["a-codex"] = { status };
    assert.deepEqual(selected(input), ["a-claude"], status);
  }
  const missing = fixture();
  delete missing.nodes["a-codex"];
  assert.deepEqual(selected(missing), ["a-claude"]);
});

test("a dynamic group cannot omit missing generated tasks or attempt states", () => {
  const missingTask = fixture();
  missingTask.tasks = missingTask.tasks.filter((task) => task.concreteNodeId !== "report-b");
  assert.deepEqual(selected(missingTask), ["a-claude", "storage-a"]);
  missingTask.nodes["report-b"] = withheldNode("report-b");
  assert.deepEqual(selected(missingTask), ["a-claude", "report-b", "storage-a"]);
  missingTask.nodes["report-b"] = { status: "succeeded" };
  assert.deepEqual(selected(missingTask), ["a-claude", "storage-a"]);

  const missingState = fixture();
  delete missingState.nodes["storage-b"];
  delete missingState.nodes["b-codex"];
  assert.deepEqual(selected(missingState), ["a-claude", "storage-a"]);
});

test("only failed aggregates explained by at least one withheld child are exempt", () => {
  const notFailed: NodeStatus[] = [
    "pending",
    "ready",
    "runnable",
    "running",
    "skipped",
    "timed-out",
    "invalidated",
    "succeeded",
    "reused-from-prior-run"
  ];
  for (const status of notFailed) {
    const input = fixture();
    input.nodes["storage-a"] = { status };
    assert.deepEqual(selected(input), ["a-claude"], `concrete aggregate ${status}`);

    const group = fixture();
    group.nodes.reports = { status };
    assert.deepEqual(selected(group), ["a-claude", "storage-a"], `dynamic aggregate ${status}`);
  }
  const allSucceeded = fixture();
  allSucceeded.nodes["a-claude"] = { status: "succeeded" };
  allSucceeded.nodes["unrelated-withheld"] = withheldNode("unrelated-withheld");
  assert.deepEqual(selected(allSucceeded), ["unrelated-withheld"]);
});

test("unexpanded and empty dynamic groups remain blocking", () => {
  const unexpanded = fixture();
  const pendingGroup = unexpanded.graph.nodes[0]?.dynamic;
  assert.ok(pendingGroup !== undefined);
  pendingGroup.status = "pending";
  assert.deepEqual(selected(unexpanded), ["a-claude", "storage-a"]);
  const empty = fixture();
  const emptyGroup = empty.graph.nodes[0]?.dynamic;
  assert.ok(emptyGroup !== undefined);
  emptyGroup.generated_node_ids = [];
  assert.deepEqual(selected(empty), ["a-claude", "storage-a"]);
});
