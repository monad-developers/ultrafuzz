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

/**
 * The runtime-extension rules the two boundaries cannot easily reach.
 *
 * A compiled task that declares dynamic dependencies gains its expanded children's artifact
 * directories and identities. The generated workflow exercises the accepting side; these cover the
 * rejecting side, which requires a controller that lies about its own compiled dependencies.
 */
test("a compiled attempt may only gain the dependencies its dynamic expansion produced", () => {
  const canonical = handoff();
  const extended = handoff({
    dependencyArtifactDirs: [...canonical.dependencyArtifactDirs, `${RUN_ROOT}/artifacts/generated-one`],
    metadata: {
      ...canonical.metadata,
      dependencies: {
        concreteNodeIds: [...canonical.metadata.dependencies.concreteNodeIds, "dynamic:item:one"],
        attemptIds: [...canonical.metadata.dependencies.attemptIds, "generated-one"],
        smithersNodeIds: [...canonical.metadata.dependencies.smithersNodeIds, "verify:generated-one"]
      }
    }
  });
  assertCloudSelectedTaskMatchesCanonical(extended, canonical, { allowsRuntimeDependencies: true });

  // Without a declared dynamic dependency, the same extension is an unexplained divergence.
  assert.throws(
    () => assertCloudSelectedTaskMatchesCanonical(extended, canonical),
    /does not match the compiled attempt: dependencyArtifactDirs/u
  );
  // A compiled dependency may never be dropped, even when extension is allowed.
  assert.throws(
    () =>
      assertCloudSelectedTaskMatchesCanonical(
        handoff({ dependencyArtifactDirs: [`${RUN_ROOT}/artifacts/generated-one`] }),
        canonical,
        { allowsRuntimeDependencies: true }
      ),
    /dependencyArtifactDirs must extend the compiled attempt without dropping entries/u
  );
  // An extension must be a run-root artifact directory, not an arbitrary safe path.
  assert.throws(
    () =>
      assertCloudSelectedTaskMatchesCanonical(
        handoff({ dependencyArtifactDirs: [...canonical.dependencyArtifactDirs, ".smithers/agents"] }),
        canonical,
        { allowsRuntimeDependencies: true }
      ),
    /may only gain run-root artifact directories/u
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
