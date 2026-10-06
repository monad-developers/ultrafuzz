import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  assertValidPromptArtifactAuthority,
  derivePromptArtifactAuthority,
  MAX_PROMPT_ARTIFACT_AUTHORITY_BYTES,
  PROMPT_ARTIFACT_AUTHORITY_SCHEMA_VERSION,
  serializePromptArtifactAuthority,
  type DerivePromptArtifactAuthorityInput,
  type PromptArtifactAuthorityDocument
} from "../src/prompt-artifact-authority.js";
import type { SemanticArtifactTaskDeclaration } from "../src/semantic-artifact-context.js";

const planRunRoot = "/controller/project/.ultrafuzz/runs/run-1";
const relocatedRunRoot = "/modal/project/.ultrafuzz/runs/run-1";

function declaredTask(input: {
  attemptId: string;
  logicalNodeId?: string;
  outputs: Array<{ path: string; contract: string }>;
  dependencies?: string[];
  dependencyArtifactDirs?: string[];
}): SemanticArtifactTaskDeclaration {
  return {
    attemptId: input.attemptId,
    logicalNodeId: input.logicalNodeId ?? input.attemptId,
    artifactDir: path.join(planRunRoot, "artifacts", input.attemptId),
    dependencies: input.dependencies ?? [],
    dependencyArtifactDirs: input.dependencyArtifactDirs ?? [],
    outputs: input.outputs
  };
}

function fixturePlan(): { consumer: SemanticArtifactTaskDeclaration; tasks: SemanticArtifactTaskDeclaration[] } {
  const producerA = declaredTask({
    attemptId: "producer-a",
    logicalNodeId: "strategy-a",
    outputs: [
      { path: "generated-tests/manifest.json", contract: "ultrafuzz/generated-tests@3" },
      { path: "findings.json", contract: "ultrafuzz/findings@2" },
      { path: "notes.txt", contract: "ultrafuzz/text@1" }
    ]
  });
  const producerB = declaredTask({
    attemptId: "producer-b",
    logicalNodeId: "optional-strategy",
    outputs: [{ path: "findings.json", contract: "ultrafuzz/findings@2" }]
  });
  const unrelated = declaredTask({
    attemptId: "unrelated",
    outputs: [{ path: "generated-tests/manifest.json", contract: "ultrafuzz/generated-tests@3" }]
  });
  const consumer = declaredTask({
    attemptId: "consumer",
    outputs: [{ path: "report.md", contract: "ultrafuzz/nonempty-markdown@1" }],
    dependencies: [producerA.attemptId, producerB.attemptId],
    // A reference ancestor has an artifact directory but no task declaration.
    dependencyArtifactDirs: [
      producerA.artifactDir,
      producerB.artifactDir,
      path.join(planRunRoot, "artifacts", "reference-docs")
    ]
  });
  return { consumer, tasks: [producerA, producerB, unrelated, consumer] };
}

function deriveInput(overrides: Partial<DerivePromptArtifactAuthorityInput> = {}): DerivePromptArtifactAuthorityInput {
  const { consumer, tasks } = fixturePlan();
  return {
    runId: "run-1",
    current: consumer,
    tasks,
    artifactPathBase: relocatedRunRoot,
    admittedDependencyArtifactDirs: [
      path.join(planRunRoot, "artifacts", "producer-a"),
      path.join(planRunRoot, "artifacts", "reference-docs")
    ],
    ...overrides
  };
}

test("the prompt input index is portable, lists every declared output of each admitted ancestor, and round-trips", () => {
  const authority = derivePromptArtifactAuthority(deriveInput());

  assert.deepEqual(authority, {
    schema_version: PROMPT_ARTIFACT_AUTHORITY_SCHEMA_VERSION,
    run_id: "run-1",
    attempt_id: "consumer",
    artifact_path_base: relocatedRunRoot,
    producers: [
      {
        attempt_id: "producer-a",
        logical_node_id: "strategy-a",
        artifact_dir: "artifacts/producer-a",
        outputs: [
          { path: "findings.json", contract: "ultrafuzz/findings@2" },
          { path: "generated-tests/manifest.json", contract: "ultrafuzz/generated-tests@3" },
          { path: "notes.txt", contract: "ultrafuzz/text@1" }
        ]
      }
    ]
  });

  const bytes = serializePromptArtifactAuthority(authority);
  const json = bytes.toString("utf8");
  const parsed: unknown = JSON.parse(json);
  assertValidPromptArtifactAuthority(parsed);
  assert.deepEqual(parsed, authority);
  assert.deepEqual(serializePromptArtifactAuthority(parsed), bytes);
  assert.equal(json.includes(planRunRoot), false);
  assert.doesNotMatch(json, /producer-b|unrelated|reference-docs/u);
});

test("optional producers appear only in the exact admitted dependency set", () => {
  const authority = derivePromptArtifactAuthority(
    deriveInput({
      admittedDependencyArtifactDirs: [
        path.join(planRunRoot, "artifacts", "producer-a"),
        path.join(planRunRoot, "artifacts", "producer-b")
      ]
    })
  );
  assert.deepEqual(
    authority.producers.map((producer) => producer.artifact_dir),
    ["artifacts/producer-a", "artifacts/producer-b"]
  );
  assert.deepEqual(derivePromptArtifactAuthority(deriveInput({ admittedDependencyArtifactDirs: [] })).producers, []);
});

test("a directory admitted outside the task's ancestor closure is not indexed", () => {
  const authority = derivePromptArtifactAuthority(
    deriveInput({
      admittedDependencyArtifactDirs: [
        path.join(planRunRoot, "artifacts", "producer-a"),
        path.join(planRunRoot, "artifacts", "unrelated")
      ]
    })
  );
  assert.deepEqual(
    authority.producers.map((producer) => producer.attempt_id),
    ["producer-a"]
  );
});

test("derivation orders producers whose attempt IDs share a prefix, such as loop iterations 1 and 10", () => {
  const producers = ["strategy-10", "strategy-1"].map((attemptId) =>
    declaredTask({ attemptId, outputs: [{ path: "findings.json", contract: "ultrafuzz/findings@2" }] })
  );
  const consumer = declaredTask({
    attemptId: "consumer",
    outputs: [{ path: "report.md", contract: "ultrafuzz/nonempty-markdown@1" }],
    dependencies: producers.map((producer) => producer.attemptId),
    dependencyArtifactDirs: producers.map((producer) => producer.artifactDir)
  });
  const authority = derivePromptArtifactAuthority({
    runId: "run-1",
    current: consumer,
    tasks: [...producers, consumer],
    artifactPathBase: relocatedRunRoot,
    admittedDependencyArtifactDirs: producers.map((producer) => producer.artifactDir)
  });
  assert.deepEqual(
    authority.producers.map((producer) => producer.attempt_id),
    ["strategy-1", "strategy-10"]
  );
});

test("derivation rejects a rebound ancestor directory, a duplicate output path and a relative path base", () => {
  const { consumer, tasks } = fixturePlan();
  const rebound = tasks.map((task) =>
    task.attemptId === "producer-a" ? { ...task, artifactDir: path.join(planRunRoot, "artifacts", "elsewhere") } : task
  );
  assert.throws(
    () => derivePromptArtifactAuthority(deriveInput({ tasks: rebound })),
    /does not match producer "producer-a" declaration/u
  );

  const duplicated = tasks.map((task) =>
    task.attemptId === "producer-a" ? { ...task, outputs: [...task.outputs, ...task.outputs.slice(0, 1)] } : task
  );
  assert.throws(() => derivePromptArtifactAuthority(deriveInput({ tasks: duplicated })), /repeats output path/u);

  assert.throws(
    () => derivePromptArtifactAuthority(deriveInput({ current: { ...consumer, logicalNodeId: "other" } })),
    /identity disagrees with the sealed task set/u
  );
  assert.throws(
    () => derivePromptArtifactAuthority(deriveInput({ artifactPathBase: "runs/run-1" })),
    /artifact path base must be a canonical absolute path/u
  );
});

test("serialization rejects an authority over 32 MiB before materialization", () => {
  const boundedPrefix = Array.from({ length: 32 }, () => "a".repeat(128)).join("/");
  const paths = Array.from({ length: 10_000 }, (_, index) => `${boundedPrefix}/${String(index).padStart(5, "0")}.json`);
  const oversized: PromptArtifactAuthorityDocument = {
    schema_version: PROMPT_ARTIFACT_AUTHORITY_SCHEMA_VERSION,
    run_id: "run-1",
    attempt_id: "consumer",
    artifact_path_base: relocatedRunRoot,
    producers: [
      {
        attempt_id: "producer-a",
        logical_node_id: "strategy-a",
        artifact_dir: "artifacts/producer-a",
        outputs: paths.map((outputPath) => ({ path: outputPath, contract: "ultrafuzz/text@1" }))
      }
    ]
  };

  assert.throws(
    () => serializePromptArtifactAuthority(oversized),
    new RegExp(`exceeds the ${MAX_PROMPT_ARTIFACT_AUTHORITY_BYTES}-byte materialization limit`, "u")
  );
});

test("authority validation rejects traversal, absolute run-relative fields, duplicates, and metadata expansion", () => {
  const valid = derivePromptArtifactAuthority(deriveInput());
  const mutate = (change: (document: PromptArtifactAuthorityDocument) => void): PromptArtifactAuthorityDocument => {
    const document = structuredClone(valid);
    change(document);
    return document;
  };

  for (const artifactDirectory of ["../artifacts/producer-a", "/artifacts/producer-a"]) {
    assert.throws(
      () =>
        assertValidPromptArtifactAuthority(
          mutate((document) => {
            document.producers[0]!.artifact_dir = artifactDirectory;
          })
        ),
      /without traversal or an absolute prefix/u
    );
  }
  for (const outputPath of ["../findings.json", "/findings.json"]) {
    assert.throws(
      () =>
        assertValidPromptArtifactAuthority(
          mutate((document) => {
            document.producers[0]!.outputs[0]!.path = outputPath;
          })
        ),
      /without traversal or an absolute prefix/u
    );
  }

  assert.throws(
    () =>
      assertValidPromptArtifactAuthority(
        mutate((document) => {
          document.producers.push(structuredClone(document.producers[0]!));
        })
      ),
    /repeats producer attempt/u
  );
  assert.throws(
    () =>
      assertValidPromptArtifactAuthority(
        mutate((document) => {
          document.producers[0]!.outputs.push(structuredClone(document.producers[0]!.outputs[0]!));
        })
      ),
    /repeats output path/u
  );
  assert.throws(
    () => assertValidPromptArtifactAuthority({ ...valid, model: { name: "secret-controller-metadata" } }),
    /unexpected or missing fields/u
  );
  assert.throws(
    () =>
      assertValidPromptArtifactAuthority(
        mutate((document) => {
          document.producers[0]!.attempt_id = document.attempt_id;
          document.producers[0]!.artifact_dir = `artifacts/${document.attempt_id}`;
        })
      ),
    /current task as its own producer/u
  );
  assert.throws(
    () =>
      assertValidPromptArtifactAuthority(
        mutate((document) => {
          for (const producer of document.producers) producer.outputs.reverse();
        })
      ),
    /outputs are not canonically ordered/u
  );
});
