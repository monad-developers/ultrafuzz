import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  declaredAncestorOutputsByContract,
  declaredSiblingOutputsByContract,
  type SemanticArtifactTaskDeclaration
} from "../src/semantic-artifact-context.js";

const root = path.resolve("/tmp/ultrafuzz-semantic-artifact-context");

function task(
  attemptId: string,
  logicalNodeId: string,
  options: {
    dependencies?: string[];
    dependencyArtifactDirs?: string[];
    artifactDir?: string;
    outputs?: Array<{ path: string; contract: string }>;
  } = {}
): SemanticArtifactTaskDeclaration {
  return {
    attemptId,
    logicalNodeId,
    artifactDir: options.artifactDir ?? path.join(root, "artifacts", attemptId),
    dependencies: options.dependencies ?? [],
    dependencyArtifactDirs: options.dependencyArtifactDirs ?? [],
    outputs: options.outputs ?? []
  };
}

test("sibling resolution retains every distinct declared path for one contract", () => {
  const producer = task("triage-0", "differential-red-triage", {
    outputs: [
      { path: "registry.json", contract: "ultrafuzz/semantic-red-registry@1" },
      { path: "triage-a.json", contract: "ultrafuzz/differential-red-triage@1" },
      { path: "triage-b.json", contract: "ultrafuzz/differential-red-triage@1" }
    ]
  });

  const bindings = declaredSiblingOutputsByContract(producer, "ultrafuzz/differential-red-triage@1");
  assert.deepEqual(bindings, [
    {
      attemptId: "triage-0",
      logicalNodeId: "differential-red-triage",
      artifactDir: producer.artifactDir,
      path: "triage-a.json",
      contract: "ultrafuzz/differential-red-triage@1"
    },
    {
      attemptId: "triage-0",
      logicalNodeId: "differential-red-triage",
      artifactDir: producer.artifactDir,
      path: "triage-b.json",
      contract: "ultrafuzz/differential-red-triage@1"
    }
  ]);
  assert.equal(Object.isFrozen(bindings), true);
  assert.equal(
    bindings.every((binding) => Object.isFrozen(binding)),
    true
  );
});

test("ancestor resolution follows exact sealed attempt directories and retains loop attempts", () => {
  const lane0 = task("lane-0", "differential-lane-author", {
    outputs: [{ path: "lane-result.json", contract: "ultrafuzz/differential-lane-result@1" }]
  });
  const lane1 = task("lane-1", "differential-lane-author", {
    outputs: [{ path: "custom-result.json", contract: "ultrafuzz/differential-lane-result@1" }]
  });
  const stale = task("lane-stale", "differential-lane-author", {
    outputs: [{ path: "lane-result.json", contract: "ultrafuzz/differential-lane-result@1" }]
  });
  const wrongContract = task("lookalike", "unrelated", {
    outputs: [{ path: "lane-result.json", contract: "ultrafuzz/findings@2" }]
  });
  const consumer = task("review-0", "differential-repair-and-report-review", {
    dependencies: ["lane-1"],
    dependencyArtifactDirs: [lane0.artifactDir, lane1.artifactDir, wrongContract.artifactDir]
  });

  assert.deepEqual(
    declaredAncestorOutputsByContract(
      consumer,
      [consumer, lane0, lane1, stale, wrongContract],
      "ultrafuzz/differential-lane-result@1"
    ).map((binding) => [binding.attemptId, binding.path]),
    [
      ["lane-0", "lane-result.json"],
      ["lane-1", "custom-result.json"]
    ]
  );
  assert.deepEqual(
    declaredAncestorOutputsByContract(
      consumer,
      [consumer, lane0, lane1, stale, wrongContract],
      "ultrafuzz/differential-lane-result@1",
      { directOnly: true }
    ).map((binding) => binding.attemptId),
    ["lane-1"]
  );
});

test("an undeclared reference artifact directory cannot satisfy a task-output contract", () => {
  const consumer = task("review-0", "review", {
    dependencyArtifactDirs: [path.join(root, "artifacts", "pinned-reference")]
  });
  assert.deepEqual(declaredAncestorOutputsByContract(consumer, [consumer], "ultrafuzz/differential-lane-result@1"), []);
});

test("ancestor resolution rejects dependency directory rebinding", () => {
  const producer = task("lane-0", "differential-lane-author", {
    artifactDir: path.join(root, "elsewhere", "lane-0"),
    outputs: [{ path: "lane-result.json", contract: "ultrafuzz/differential-lane-result@1" }]
  });
  const consumer = task("review-0", "review", {
    dependencyArtifactDirs: [path.join(root, "artifacts", "lane-0")]
  });
  assert.throws(
    () => declaredAncestorOutputsByContract(consumer, [consumer, producer], "ultrafuzz/differential-lane-result@1"),
    /does not match producer/u
  );
});

test("ancestor resolution uses the sealed current task closure, not a supplied lookalike", () => {
  const producer = task("lane-0", "differential-lane-author", {
    outputs: [{ path: "lane-result.json", contract: "ultrafuzz/differential-lane-result@1" }]
  });
  const sealedConsumer = task("review-0", "review");
  const suppliedLookalike = task("review-0", "review", {
    dependencyArtifactDirs: [producer.artifactDir]
  });

  assert.deepEqual(
    declaredAncestorOutputsByContract(
      suppliedLookalike,
      [sealedConsumer, producer],
      "ultrafuzz/differential-lane-result@1"
    ),
    []
  );
});

test("resolution rejects duplicate output paths instead of choosing one declaration", () => {
  const producer = task("triage-0", "differential-red-triage", {
    outputs: [
      { path: "triage.json", contract: "ultrafuzz/differential-red-triage@1" },
      { path: "triage.json", contract: "ultrafuzz/differential-red-triage@1" }
    ]
  });
  assert.throws(
    () => declaredSiblingOutputsByContract(producer, "ultrafuzz/differential-red-triage@1"),
    /repeats output path/u
  );
});
