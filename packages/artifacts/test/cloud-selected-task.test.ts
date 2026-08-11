import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertCloudSelectedTaskMatchesCanonical,
  CLOUD_SELECTED_TASK_CLOUD_EXECUTION,
  CLOUD_SELECTED_TASK_RUNTIME_PROMPT_BASENAME,
  CLOUD_SELECTED_TASK_SCHEMA_VERSION,
  isCloudExecutionGeneration,
  parseCloudSelectedTask,
  type CloudSelectedTask
} from "../src/index.js";

const RUN_ROOT = ".ultrafuzz/runs/run-one";
const ATTEMPT = "attempt-one";
const ARTIFACT_DIR = `${RUN_ROOT}/artifacts/${ATTEMPT}`;

/** The declared group in these cases derives exactly one generated attempt for `dynamic:item:one`. */
const EVIDENCE = {
  admissibleAttemptIds: (concreteNodeId: string): string[] =>
    concreteNodeId === "dynamic:item:one" ? ["generated-one"] : [],
  requiredVerifierSmithersNodeId: (concreteNodeId: string, attemptId: string): string | undefined =>
    concreteNodeId === "dynamic:item:one" && attemptId === "generated-one" ? "verify:generated-one" : undefined
};

/** Applies one dependency-array override on top of the canonical handoff. */
function withDependencies(overrides: {
  artifactDirs?: string[];
  concreteNodeIds?: string[];
  attemptIds?: string[];
  smithersNodeIds?: string[];
}): CloudSelectedTask {
  const canonical = handoff();
  return handoff({
    dependencyArtifactDirs: overrides.artifactDirs ?? canonical.dependencyArtifactDirs,
    metadata: {
      ...canonical.metadata,
      dependencies: {
        concreteNodeIds: overrides.concreteNodeIds ?? canonical.metadata.dependencies.concreteNodeIds,
        attemptIds: overrides.attemptIds ?? canonical.metadata.dependencies.attemptIds,
        smithersNodeIds: overrides.smithersNodeIds ?? canonical.metadata.dependencies.smithersNodeIds
      }
    }
  });
}

/**
 * The runtime-extension rules the two boundaries cannot easily reach.
 *
 * A compiled task that declares dynamic dependencies gains its expanded children's artifact
 * directories and identities -- but as one correlated set per materialized attempt, never as three
 * independent supersets. The generated workflow exercises the accepting side; these cover the
 * rejecting side, which requires a controller that lies about its own compiled dependencies.
 */
test("a compiled attempt may only gain correlated evidence of the dependencies its expansion produced", () => {
  const canonical = handoff();
  const extended = withDependencies({
    artifactDirs: [...canonical.dependencyArtifactDirs, `${RUN_ROOT}/artifacts/generated-one`],
    concreteNodeIds: [...canonical.metadata.dependencies.concreteNodeIds, "dynamic:item:one"],
    attemptIds: [...canonical.metadata.dependencies.attemptIds, "generated-one"],
    smithersNodeIds: [...canonical.metadata.dependencies.smithersNodeIds, "verify:generated-one"]
  });
  assertCloudSelectedTaskMatchesCanonical(extended, canonical, { runtimeDependencies: EVIDENCE });

  // Without a declared dynamic dependency, the same extension is an unexplained divergence.
  assert.throws(
    () => assertCloudSelectedTaskMatchesCanonical(extended, canonical),
    /does not match the compiled attempt: dependencyArtifactDirs/u
  );

  const rejections: Array<[string, CloudSelectedTask, RegExp]> = [
    [
      "a compiled dependency dropped",
      withDependencies({ artifactDirs: [`${RUN_ROOT}/artifacts/generated-one`] }),
      /dependencyArtifactDirs must extend the compiled attempt without reordering, dropping, or repeating/u
    ],
    [
      "a repeated entry counting one materialization twice",
      withDependencies({
        artifactDirs: [...canonical.dependencyArtifactDirs, ...canonical.dependencyArtifactDirs]
      }),
      /dependencyArtifactDirs must extend the compiled attempt without reordering, dropping, or repeating/u
    ],
    [
      "an artifact directory with no attempt behind it",
      withDependencies({
        artifactDirs: [...canonical.dependencyArtifactDirs, `${RUN_ROOT}/artifacts/generated-one`]
      }),
      /dependencyArtifactDirs must contain each materialized dependency attempt's run-root artifact directory/u
    ],
    [
      "an arbitrary safe path instead of the attempt's own directory",
      withDependencies({
        artifactDirs: [...canonical.dependencyArtifactDirs, ".smithers/agents"],
        concreteNodeIds: [...canonical.metadata.dependencies.concreteNodeIds, "dynamic:item:one"],
        attemptIds: [...canonical.metadata.dependencies.attemptIds, "generated-one"]
      }),
      /dependencyArtifactDirs must contain each materialized dependency attempt's run-root artifact directory/u
    ],
    [
      "a verifier for an attempt that was never added",
      withDependencies({
        smithersNodeIds: [...canonical.metadata.dependencies.smithersNodeIds, "verify:generated-one"]
      }),
      /smithersNodeIds must gain exactly the required verifiers of materialized dependency attempts/u
    ],
    [
      "a required verifier omitted",
      withDependencies({
        artifactDirs: [...canonical.dependencyArtifactDirs, `${RUN_ROOT}/artifacts/generated-one`],
        concreteNodeIds: [...canonical.metadata.dependencies.concreteNodeIds, "dynamic:item:one"],
        attemptIds: [...canonical.metadata.dependencies.attemptIds, "generated-one"]
      }),
      /smithersNodeIds must gain exactly the required verifiers of materialized dependency attempts/u
    ],
    [
      "a generated node no declared group derives",
      withDependencies({
        artifactDirs: [...canonical.dependencyArtifactDirs, `${RUN_ROOT}/artifacts/generated-one`],
        concreteNodeIds: [...canonical.metadata.dependencies.concreteNodeIds, "dynamic:item:two"],
        attemptIds: [...canonical.metadata.dependencies.attemptIds, "generated-one"]
      }),
      /gained dynamic:item:two, which no declared dynamic group materialized/u
    ],
    [
      "an attempt with no generated node behind it",
      withDependencies({
        artifactDirs: [...canonical.dependencyArtifactDirs, `${RUN_ROOT}/artifacts/generated-one`],
        attemptIds: [...canonical.metadata.dependencies.attemptIds, "generated-one"]
      }),
      /gained generated-one without the generated node that produced it/u
    ]
  ];
  for (const [label, actual, message] of rejections) {
    assert.throws(
      () => assertCloudSelectedTaskMatchesCanonical(actual, canonical, { runtimeDependencies: EVIDENCE }),
      message,
      label
    );
  }
});

/**
 * A group that expanded to no items substitutes its own source attempt, and a non-agentic source has
 * no verifier at all, so the verifier identities are a subsequence of the added attempts.
 */
test("a runtime extension without a verifier is still correlated with its attempt", () => {
  const canonical = handoff();
  const sourceOnly = withDependencies({
    artifactDirs: [...canonical.dependencyArtifactDirs, `${RUN_ROOT}/artifacts/source-one`],
    concreteNodeIds: [...canonical.metadata.dependencies.concreteNodeIds, "reference-source"],
    attemptIds: [...canonical.metadata.dependencies.attemptIds, "source-one"]
  });
  const evidence = {
    admissibleAttemptIds: (concreteNodeId: string): string[] =>
      concreteNodeId === "reference-source" ? ["source-one"] : [],
    requiredVerifierSmithersNodeId: (): undefined => undefined
  };
  assertCloudSelectedTaskMatchesCanonical(sourceOnly, canonical, { runtimeDependencies: evidence });
});

test("an agentic empty-group source retains its exact compiled verifier", () => {
  const canonical = handoff();
  const sourceOnly = withDependencies({
    artifactDirs: [...canonical.dependencyArtifactDirs, `${RUN_ROOT}/artifacts/source-one`],
    concreteNodeIds: [...canonical.metadata.dependencies.concreteNodeIds, "agentic-source"],
    attemptIds: [...canonical.metadata.dependencies.attemptIds, "source-one"],
    smithersNodeIds: [...canonical.metadata.dependencies.smithersNodeIds, "verify:source-one"]
  });
  const evidence = {
    admissibleAttemptIds: (concreteNodeId: string): string[] =>
      concreteNodeId === "agentic-source" ? ["source-one"] : [],
    requiredVerifierSmithersNodeId: (concreteNodeId: string, attemptId: string): string | undefined =>
      concreteNodeId === "agentic-source" && attemptId === "source-one" ? "verify:source-one" : undefined
  };
  assertCloudSelectedTaskMatchesCanonical(sourceOnly, canonical, { runtimeDependencies: evidence });
  const canonicalWithSourceArtifact = handoff({
    dependencyArtifactDirs: [...canonical.dependencyArtifactDirs, `${RUN_ROOT}/artifacts/source-one`]
  });
  const sourceWithCompiledArtifact = handoff({
    dependencyArtifactDirs: canonicalWithSourceArtifact.dependencyArtifactDirs,
    metadata: {
      ...canonicalWithSourceArtifact.metadata,
      dependencies: sourceOnly.metadata.dependencies
    }
  });
  assertCloudSelectedTaskMatchesCanonical(sourceWithCompiledArtifact, canonicalWithSourceArtifact, {
    runtimeDependencies: evidence
  });
  assert.throws(
    () =>
      assertCloudSelectedTaskMatchesCanonical(
        withDependencies({
          artifactDirs: [...canonical.dependencyArtifactDirs, `${RUN_ROOT}/artifacts/source-one`],
          concreteNodeIds: [...canonical.metadata.dependencies.concreteNodeIds, "agentic-source"],
          attemptIds: [...canonical.metadata.dependencies.attemptIds, "source-one"]
        }),
        canonical,
        { runtimeDependencies: evidence }
      ),
    /smithersNodeIds must gain exactly the required verifiers of materialized dependency attempts/u
  );
});

test("a deferred attempt may only claim its own runtime-rendered prompt", () => {
  const canonical = handoff();
  const rendered = handoff({ promptPath: `${ARTIFACT_DIR}/${CLOUD_SELECTED_TASK_RUNTIME_PROMPT_BASENAME}` });
  assertCloudSelectedTaskMatchesCanonical(rendered, canonical, { allowsRuntimeRenderedPrompt: true });

  for (const promptPath of [
    `${RUN_ROOT}/artifacts/other/${CLOUD_SELECTED_TASK_RUNTIME_PROMPT_BASENAME}`,
    `${ARTIFACT_DIR}/other.md`
  ]) {
    assert.throws(
      () =>
        assertCloudSelectedTaskMatchesCanonical(handoff({ promptPath }), canonical, {
          allowsRuntimeRenderedPrompt: true
        }),
      /must be the attempt's runtime-rendered prompt inside its artifact directory/u
    );
  }
});

/**
 * Controller-only provenance never crosses the DTO.
 *
 * `metadata.workspace.repoPath` is the configured `project.repo`, which the worker never reads and
 * cannot meaningfully resolve in its relocated root, so the strict schema rejects it as an unknown
 * nested key instead of transporting an unusable path.
 */
test("hydrated controller-only workspace provenance is an unknown nested key", () => {
  const withRepoPath = handoff();
  (withRepoPath.metadata.workspace as unknown as Record<string, unknown>).repoPath = ".";
  assert.throws(() => parseCloudSelectedTask(withRepoPath), /metadata\.workspace: Unrecognized key: "repoPath"/u);
  // Even the harmless-looking canonical spelling stays out of the contract.
  assert.throws(
    () => assertCloudSelectedTaskMatchesCanonical(parseCloudSelectedTask(handoff()), withRepoPath as CloudSelectedTask),
    /does not match the compiled attempt: metadata.workspace.repoPath/u
  );
});

test("only the dispatched cloud execution identity may run as a cloud attempt", () => {
  assert.equal(
    parseCloudSelectedTask(handoff(), {
      ...CLOUD_SELECTED_TASK_CLOUD_EXECUTION,
      executionGeneration: "base"
    }).metadata.execution.provider,
    "modal"
  );
  // A self-consistent local handoff -- the shape a runtime-generated attempt could otherwise smuggle.
  const local = handoff({ execution: { mode: "local", generation: "base" } });
  local.metadata = { ...local.metadata, execution: { ...local.metadata.execution, mode: "local" } };
  assert.throws(
    () => parseCloudSelectedTask(local, CLOUD_SELECTED_TASK_CLOUD_EXECUTION),
    /execution mode local is not the dispatched cloud execution identity/u
  );
  const withoutProvider = handoff();
  withoutProvider.metadata = {
    ...withoutProvider.metadata,
    execution: { mode: "cloud", resources: withoutProvider.metadata.execution.resources }
  };
  assert.throws(
    () => parseCloudSelectedTask(withoutProvider, CLOUD_SELECTED_TASK_CLOUD_EXECUTION),
    /metadata.execution.provider is not the dispatched modal provider/u
  );
  const wrongGeneration = handoff({ execution: { mode: "cloud", generation: "reset-one" } });
  assert.throws(
    () =>
      parseCloudSelectedTask(wrongGeneration, {
        ...CLOUD_SELECTED_TASK_CLOUD_EXECUTION,
        executionGeneration: "base"
      }),
    /execution\.generation reset-one is not the dispatched base generation/u
  );
});

test("a cloud execution generation is a bounded dispatch identity", () => {
  for (const generation of ["base", "reset-one", "reset.2_final"]) {
    assert.equal(isCloudExecutionGeneration(generation), true, generation);
  }
  for (const generation of ["", "-leading", "../escape", "reset/one", "a".repeat(129), 7, undefined]) {
    assert.equal(isCloudExecutionGeneration(generation), false, String(generation));
  }
});

test("every unbound expectation still leaves the handoff bound to its own metadata", () => {
  assert.deepEqual(parseCloudSelectedTask(handoff()).attemptId, ATTEMPT);
  assert.throws(
    () => parseCloudSelectedTask(handoff(), { branch: "ultrafuzz/other/attempt" }),
    /branch does not match the dispatching workflow/u
  );
  assert.throws(
    () => parseCloudSelectedTask(handoff(), { runId: "another-run" }),
    /metadata.run.ultrafuzzRunId does not match the dispatching workflow/u
  );
});

function handoff(overrides: Partial<CloudSelectedTask> = {}): CloudSelectedTask {
  return {
    schema_version: CLOUD_SELECTED_TASK_SCHEMA_VERSION,
    id: `node:${ATTEMPT}`,
    attemptId: ATTEMPT,
    preparationId: `prepare:${ATTEMPT}`,
    verifierId: `verify:${ATTEMPT}`,
    agentRef: "ClaudeAgent",
    modelName: null,
    reasoningEffort: null,
    branch: `ultrafuzz/run-one/${ATTEMPT}`,
    promptPath: `${RUN_ROOT}/prompts/${ATTEMPT}.md`,
    workspacePath: `${RUN_ROOT}/workspaces/${ATTEMPT}`,
    artifactDir: ARTIFACT_DIR,
    runRoot: RUN_ROOT,
    workflowPath: ".smithers/workflows/ultrafuzz-run-one.tsx",
    sourceProjectRoot: "/controller/project",
    dependencyArtifactDirs: [`${RUN_ROOT}/artifacts/upstream`],
    referenceArtifactDirs: [],
    timeoutMs: 600_000,
    heartbeatTimeoutMs: 120_000,
    retries: 1,
    retryPolicy: { backoff: "exponential", initialDelayMs: 1_000, maxDelayMs: 30_000 },
    metadata: {
      schemaVersion: "ultrafuzz.smithers.task-metadata.v1",
      run: {
        ultrafuzzRunId: "run-one",
        smithersWorkflowName: "ultrafuzz-run-one",
        graphVersion: "1",
        topologyVersion: 2
      },
      node: {
        concreteNodeId: "join",
        logicalNodeId: "join",
        attemptId: ATTEMPT,
        label: "Join",
        kind: "agentic"
      },
      dependencies: { concreteNodeIds: ["upstream"], attemptIds: ["upstream"], smithersNodeIds: ["verify:upstream"] },
      loop: { index: 0, count: 1, mode: "single", attemptIndex: 0 },
      workspace: {
        primitive: "worktree",
        path: `${RUN_ROOT}/workspaces/${ATTEMPT}`,
        trustModel: "trusted-local"
      },
      artifacts: {
        dir: ARTIFACT_DIR,
        outputs: [
          {
            path: "report.md",
            contract: "ultrafuzz/nonempty-markdown@1",
            contractDigest: "a".repeat(64),
            primary: true
          }
        ],
        manifestPath: `${ARTIFACT_DIR}/artifact-manifest.json`
      },
      retryPolicy: { maxAttempts: 2, smithersRetries: 1 },
      timeout: { milliseconds: 600_000, seconds: 600, heartbeatTimeoutMs: 120_000 },
      execution: { mode: "cloud", provider: "modal", resources: { cpu: 2, memoryMiB: 4096, timeoutSeconds: 60 } }
    },
    execution: { mode: "cloud", generation: "base" },
    ...overrides
  };
}
