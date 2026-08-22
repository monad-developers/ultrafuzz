import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  artifactContractDefinition,
  artifactContractSchemaBinding,
  promptArtifactAuthorityPathSelectorId,
  SMITHERS_TASK_MANIFEST_SCHEMA_VERSION,
  SMITHERS_TASK_METADATA_SCHEMA_VERSION,
  type ArtifactContractId,
  type SmithersTaskManifestDocument,
  type SmithersTaskManifestOutput,
  type SmithersTaskManifestTask
} from "@ultrafuzz/artifacts";

import {
  assertValidPromptArtifactAuthority,
  derivePromptArtifactAuthority,
  MAX_PROMPT_ARTIFACT_AUTHORITY_BYTES,
  parsePromptArtifactAuthorityBytes,
  PROMPT_ARTIFACT_AUTHORITY_JSON_SCHEMA_ID,
  PROMPT_ARTIFACT_AUTHORITY_SCHEMA_VERSION,
  promptArtifactAuthorityJsonSchema,
  serializePromptArtifactAuthority,
  type DerivePromptArtifactAuthorityInput,
  type PromptArtifactAuthorityDocument
} from "../src/prompt-artifact-authority.js";

const controllerRunRoot = "/controller/project/.ultrafuzz/runs/run-1";
const relocatedRunRoot = "/modal/project/.ultrafuzz/runs/run-1";

function pathSelector(paths: string[]) {
  return { kind: "path" as const, id: promptArtifactAuthorityPathSelectorId(paths), paths };
}

function declaredOutput(outputPath: string, contract: ArtifactContractId, primary = false): SmithersTaskManifestOutput {
  const binding = artifactContractSchemaBinding(contract);
  return {
    path: outputPath,
    contract,
    contractDigest: artifactContractDefinition(contract).digest,
    ...(binding === undefined
      ? {}
      : {
          schemaFile: binding.schema_file,
          schemaId: binding.schema_id,
          schemaSha256: binding.schema_sha256,
          schemaBundleSha256: binding.schema_bundle_sha256,
          validatorBuild: binding.validator_build
        }),
    primary
  };
}

function sealedTask(input: {
  attemptId: string;
  logicalNodeId?: string;
  outputs: SmithersTaskManifestOutput[];
  dependencies?: string[];
  dependencyArtifactDirs?: string[];
  optionalDependencyArtifactDirs?: string[];
  promptArtifactAuthoritySelectors?: SmithersTaskManifestTask["promptArtifactAuthoritySelectors"];
}): SmithersTaskManifestTask {
  const dependencies = input.dependencies ?? [];
  const dependencySmithersNodeIds = dependencies.map((attemptId) => `verify:${attemptId}`);
  const artifactDir = path.join(controllerRunRoot, "artifacts", input.attemptId);
  const workspacePath = path.join(controllerRunRoot, "workspaces", input.attemptId);
  const logicalNodeId = input.logicalNodeId ?? input.attemptId;
  const agentChain = [
    {
      profileId: "default",
      agentRef: "CodexAgent",
      modelName: "gpt-test",
      reasoningEffort: "high",
      role: "primary" as const
    }
  ];
  const execution = {
    mode: "local" as const,
    resources: { cpu: 1, memoryMiB: 1_024, timeoutSeconds: 60 },
    agentCredentialEnv: []
  };
  return {
    attemptId: input.attemptId,
    concreteNodeId: input.attemptId,
    logicalNodeId,
    preparationSmithersNodeId: `prepare:${input.attemptId}`,
    smithersNodeId: `node:${input.attemptId}`,
    verifierSmithersNodeId: `verify:${input.attemptId}`,
    agentRef: "CodexAgent",
    agentChain,
    modelName: "gpt-test",
    reasoningEffort: "high",
    dependencies,
    dependencySmithersNodeIds,
    timeoutMs: 60_000,
    heartbeatTimeoutMs: 60_000,
    retries: 0,
    retryPolicy: { backoff: "exponential", initialDelayMs: 1_000 },
    workspacePath,
    artifactDir,
    dependencyArtifactDirs: input.dependencyArtifactDirs ?? [],
    ...(input.optionalDependencyArtifactDirs === undefined
      ? {}
      : { optionalDependencyArtifactDirs: input.optionalDependencyArtifactDirs }),
    ...(input.promptArtifactAuthoritySelectors === undefined
      ? {}
      : { promptArtifactAuthoritySelectors: input.promptArtifactAuthoritySelectors }),
    execution,
    metadata: {
      schemaVersion: SMITHERS_TASK_METADATA_SCHEMA_VERSION,
      run: {
        ultrafuzzRunId: "run-1",
        smithersWorkflowName: "workflow-run-1",
        graphVersion: "4",
        topologyVersion: 2
      },
      node: {
        concreteNodeId: input.attemptId,
        logicalNodeId,
        attemptId: input.attemptId,
        label: logicalNodeId,
        kind: "agentic"
      },
      dependencies: {
        concreteNodeIds: [...dependencies],
        attemptIds: [...dependencies],
        smithersNodeIds: dependencySmithersNodeIds
      },
      loop: { index: 0, count: 1, mode: "parallel", attemptIndex: 0 },
      model: {
        profileId: "default",
        agentRef: "CodexAgent",
        modelName: "gpt-test",
        reasoningEffort: "high",
        modelIndex: 0,
        attemptIndex: 0,
        agentChain
      },
      workspace: {
        primitive: "worktree",
        path: workspacePath,
        repoPath: "/controller/project",
        trustModel: "skip-permissions"
      },
      artifacts: {
        dir: artifactDir,
        outputs: input.outputs,
        manifestPath: path.join(artifactDir, "artifact-manifest.json")
      },
      retryPolicy: { maxAttempts: 1, sameAgentAttempts: 1, smithersRetries: 0 },
      timeout: { milliseconds: 60_000, seconds: 60, heartbeatTimeoutMs: 60_000 },
      execution: { mode: "local", resources: execution.resources }
    }
  };
}

function fixtureManifest(): SmithersTaskManifestDocument {
  const producerA = sealedTask({
    attemptId: "producer-a",
    logicalNodeId: "strategy-a",
    outputs: [
      declaredOutput("generated-tests/manifest.json", "ultrafuzz/generated-tests@3"),
      declaredOutput("findings.json", "ultrafuzz/findings@2", true),
      declaredOutput("notes.txt", "ultrafuzz/text@1")
    ]
  });
  const producerB = sealedTask({
    attemptId: "producer-b",
    logicalNodeId: "optional-strategy",
    outputs: [declaredOutput("findings.json", "ultrafuzz/findings@2", true)]
  });
  const unrelated = sealedTask({
    attemptId: "unrelated",
    outputs: [declaredOutput("generated-tests/manifest.json", "ultrafuzz/generated-tests@3", true)]
  });
  const dependencyArtifactDirs = [producerA.artifactDir, producerB.artifactDir];
  const consumer = sealedTask({
    attemptId: "consumer",
    outputs: [declaredOutput("report.md", "ultrafuzz/nonempty-markdown@1", true)],
    dependencies: [producerA.attemptId, producerB.attemptId],
    dependencyArtifactDirs,
    optionalDependencyArtifactDirs: [producerB.artifactDir],
    promptArtifactAuthoritySelectors: [
      { kind: "contract", contract: "ultrafuzz/generated-tests@3" },
      pathSelector(["findings.json"])
    ]
  });
  return {
    schema_version: SMITHERS_TASK_MANIFEST_SCHEMA_VERSION,
    run_id: "run-1",
    smithers_run_id: "ultrafuzz-run-1",
    workflow_name: "workflow-run-1",
    pinned_submodules: null,
    tasks: [producerA, producerB, unrelated, consumer]
  };
}

function manifestBytes(manifest = fixtureManifest()): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function deriveInput(overrides: Partial<DerivePromptArtifactAuthorityInput> = {}): DerivePromptArtifactAuthorityInput {
  return {
    sealedTaskManifestBytes: manifestBytes(),
    currentAttemptId: "consumer",
    relocatedRunRoot,
    admittedDependencyArtifactDirs: [path.join(relocatedRunRoot, "artifacts", "producer-a")],
    selectors: [pathSelector(["findings.json"]), { kind: "contract", contract: "ultrafuzz/generated-tests@3" }],
    ...overrides
  };
}

test("per-task prompt authority is portable, minimized, deterministic, and round-trips", () => {
  const authority = derivePromptArtifactAuthority(deriveInput());

  assert.equal(promptArtifactAuthorityJsonSchema.$id, PROMPT_ARTIFACT_AUTHORITY_JSON_SCHEMA_ID);

  assert.deepEqual(authority, {
    schema_version: PROMPT_ARTIFACT_AUTHORITY_SCHEMA_VERSION,
    run_id: "run-1",
    attempt_id: "consumer",
    artifact_path_base: relocatedRunRoot,
    selectors: [{ kind: "contract", contract: "ultrafuzz/generated-tests@3" }, pathSelector(["findings.json"])],
    producers: [
      {
        attempt_id: "producer-a",
        logical_node_id: "strategy-a",
        artifact_dir: "artifacts/producer-a",
        outputs: [
          { path: "findings.json", contract: "ultrafuzz/findings@2" },
          { path: "generated-tests/manifest.json", contract: "ultrafuzz/generated-tests@3" }
        ]
      }
    ]
  });

  const bytes = serializePromptArtifactAuthority(authority);
  assert.deepEqual(parsePromptArtifactAuthorityBytes(bytes), authority);
  assert.deepEqual(serializePromptArtifactAuthority(parsePromptArtifactAuthorityBytes(bytes)), bytes);
  const json = bytes.toString("utf8");
  assert.equal(json.includes(controllerRunRoot), false);
  assert.doesNotMatch(json, /modelName|reasoningEffort|workspacePath|source_revision|dependencyArtifactDirs/u);
  assert.doesNotMatch(json, /producer-b|unrelated|notes\.txt/u);
});

test("optional producers appear only in the exact admitted dependency set", () => {
  const authority = derivePromptArtifactAuthority(
    deriveInput({
      admittedDependencyArtifactDirs: [
        path.join(relocatedRunRoot, "artifacts", "producer-a"),
        path.join(relocatedRunRoot, "artifacts", "producer-b")
      ]
    })
  );
  assert.deepEqual(
    authority.producers.map((producer) => producer.attempt_id),
    ["producer-a", "producer-b"]
  );
  assert.deepEqual(
    authority.producers.map((producer) => producer.artifact_dir),
    ["artifacts/producer-a", "artifacts/producer-b"]
  );
});

test("derivation rejects missing required, foreign, and duplicate admitted roots", () => {
  assert.throws(
    () => derivePromptArtifactAuthority(deriveInput({ admittedDependencyArtifactDirs: [] })),
    /missing required admitted dependency/u
  );
  assert.throws(
    () =>
      derivePromptArtifactAuthority(
        deriveInput({
          admittedDependencyArtifactDirs: [
            path.join(relocatedRunRoot, "artifacts", "producer-a"),
            path.join(relocatedRunRoot, "artifacts", "foreign")
          ]
        })
      ),
    /outside the sealed ancestor closure/u
  );
  const admittedA = path.join(relocatedRunRoot, "artifacts", "producer-a");
  assert.throws(
    () => derivePromptArtifactAuthority(deriveInput({ admittedDependencyArtifactDirs: [admittedA, admittedA] })),
    /repeats admitted dependency/u
  );
  assert.throws(
    () =>
      derivePromptArtifactAuthority(
        deriveInput({ admittedDependencyArtifactDirs: ["/modal/project/.ultrafuzz/runs/foreign/artifacts/producer-a"] })
      ),
    /escapes the run root/u
  );
});

test("derivation reparses the sealed manifest and rejects noncanonical declarations and duplicates", () => {
  assert.throws(
    () => derivePromptArtifactAuthority(deriveInput({ sealedTaskManifestBytes: Buffer.from("{}") })),
    /Smithers task manifest violates its registered schema/u
  );
  assert.throws(
    () =>
      derivePromptArtifactAuthority(
        deriveInput({ selectors: [{ kind: "contract", contract: "ultrafuzz/findings@2" }] })
      ),
    /selectors do not match the sealed current-task declaration/u
  );

  const noncanonical = fixtureManifest();
  const producer = noncanonical.tasks.find((task) => task.attemptId === "producer-a")!;
  producer.artifactDir = `${controllerRunRoot}/artifacts/../producer-a`;
  producer.metadata.artifacts.dir = producer.artifactDir;
  producer.metadata.artifacts.manifestPath = path.join(producer.artifactDir, "artifact-manifest.json");
  assert.throws(
    () => derivePromptArtifactAuthority(deriveInput({ sealedTaskManifestBytes: manifestBytes(noncanonical) })),
    /canonical absolute path/u
  );

  const duplicateOutput = fixtureManifest();
  const duplicateProducer = duplicateOutput.tasks.find((task) => task.attemptId === "producer-a")!;
  duplicateProducer.metadata.artifacts.outputs.push({ ...duplicateProducer.metadata.artifacts.outputs[0]! });
  assert.throws(
    () => derivePromptArtifactAuthority(deriveInput({ sealedTaskManifestBytes: manifestBytes(duplicateOutput) })),
    /repeats output path/u
  );

  assert.throws(
    () =>
      derivePromptArtifactAuthority(
        deriveInput({
          selectors: [pathSelector(["findings.json"]), pathSelector(["findings.json"])]
        })
      ),
    /repeats selector/u
  );
  assert.throws(
    () => derivePromptArtifactAuthority(deriveInput({ selectors: [pathSelector(["../findings.json"])] })),
    /without traversal or an absolute prefix/u
  );
});

test("serialization rejects an authority over 32 MiB before materialization", () => {
  const boundedPrefix = Array.from({ length: 32 }, () => "a".repeat(128)).join("/");
  const paths = Array.from({ length: 4_096 }, (_, index) => `${boundedPrefix}/${String(index).padStart(4, "0")}.json`);
  const selector = pathSelector(paths);
  const oversized: PromptArtifactAuthorityDocument = {
    schema_version: PROMPT_ARTIFACT_AUTHORITY_SCHEMA_VERSION,
    run_id: "run-1",
    attempt_id: "consumer",
    artifact_path_base: relocatedRunRoot,
    selectors: [selector],
    producers: [
      {
        attempt_id: "producer-a",
        logical_node_id: "strategy-a",
        artifact_dir: "artifacts/producer-a",
        outputs: paths.map((selectedPath) => ({ path: selectedPath, contract: "ultrafuzz/text@1" }))
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
    () =>
      assertValidPromptArtifactAuthority(
        mutate((document) => {
          document.selectors.push(structuredClone(document.selectors[0]!));
        })
      ),
    /duplicated or not canonically ordered/u
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
          document.producers[0]!.outputs[0] = {
            path: "unselected.txt",
            contract: "ultrafuzz/text@1"
          };
        })
      ),
    /outside the declared selectors/u
  );
});
