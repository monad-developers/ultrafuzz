import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  MODAL_BENCHMARK_CONFIG_SCHEMA_ID,
  MODAL_BENCHMARK_CONTROL_MANIFEST_SCHEMA_ID,
  MODAL_COMMON_SCHEMA_ID,
  MODAL_EXECUTION_DEPENDENCY_MANIFEST_SCHEMA_ID,
  MODAL_LAUNCH_STATE_SCHEMA_ID,
  MODAL_NODE_CHECKPOINT_INDEX_SCHEMA_ID,
  MODAL_NODE_CHECKPOINT_SCHEMA_ID,
  MODAL_NODE_INPUT_SCHEMA_ID,
  MODAL_NODE_RESTORE_SCHEMA_ID,
  MODAL_NODE_RESULT_SCHEMA_ID,
  MODAL_NODE_WORKER_ERROR_SCHEMA_ID,
  MODAL_PINNED_SOURCE_PROOF_SCHEMA_ID,
  MODAL_RECOVERY_LIFECYCLE_SCHEMA_ID,
  MODAL_RECOVERY_STATE_SCHEMA_ID,
  MODAL_SMOKE_RESULT_SCHEMA_ID,
  MODAL_WORKER_LINEAGE_SCHEMA_ID,
  MODAL_WORKER_RESULT_SCHEMA_ID,
  type ModalContractBySchemaId,
  type ModalContractForSchemaId,
  type ModalContractSchemaId,
  type StrictModalRecoveryLifecycleSummary
} from "../src/modal-contracts.js";
import {
  ModalDocumentValidationError,
  parseModalDocumentBytes,
  readModalDocument,
  writeModalDocumentAtomic
} from "../src/modal-documents.js";
import {
  MODAL_SCHEMA_EXPORTS,
  MODAL_SCHEMA_METADATA,
  modalSchemaBundleDigest,
  modalSchemaRegistry,
  validateModalJsonSchema
} from "../src/modal-schema-registry.js";
import { IMPLEMENTED_MODAL_SEMANTIC_GATES } from "../src/modal-semantic-gates.js";

const timestamp = "2026-08-09T00:00:00.000Z";
const shaA = "a".repeat(64);
const shaB = "b".repeat(64);
const shaC = "c".repeat(64);
const shaD = "d".repeat(64);
const gitA = "a".repeat(40);
const gitB = "b".repeat(40);

type ContractFixtures = { [SchemaId in ModalContractSchemaId]: ModalContractForSchemaId<SchemaId> };

function emptyRecoverySummary(): StrictModalRecoveryLifecycleSummary {
  return {
    total_generations: 0,
    terminal_generations: 0,
    active_generations: 0,
    progress_generations: 0,
    no_progress_generations: 0,
    unknown_progress_generations: 0,
    model_work_generations: 0,
    no_model_work_generations: 0,
    unknown_model_work_generations: 0,
    genuine_failures: 0,
    rotations: 0,
    resumptions: 0,
    start_reasons: {
      initial: 0,
      "pre-model-retry": 0,
      "post-model-resume": 0,
      "image-rollout": 0,
      "stale-probe-rotation": 0,
      "operator-restart": 0,
      unknown: 0
    },
    terminal_reasons: {
      active: 0,
      succeeded: 0,
      "genuine-worker-failure": 0,
      "operational-failure": 0,
      "image-rollout": 0,
      "stale-probe-rotation": 0,
      "operator-request": 0,
      timeout: 0,
      "resource-termination": 0,
      "recovery-budget-exhausted": 0,
      unknown: 0
    },
    terminal_classes: {
      active: 0,
      succeeded: 0,
      "genuine-worker-failure": 0,
      "operational-failure": 0,
      "controller-rotation": 0,
      timeout: 0,
      "resource-termination": 0,
      "recovery-budget-exhausted": 0,
      unknown: 0
    }
  };
}

function contractFixtures(): ContractFixtures {
  return {
    [MODAL_BENCHMARK_CONFIG_SCHEMA_ID]: {
      schema_version: "ultrafuzz.modal.benchmark.v2",
      run_id: "private-run",
      app_name: "ultrafuzz-evals",
      image_name: "ultrafuzz-security-runner:latest",
      braintrust: {
        project: "private-evals",
        api_key_env: "BRAINTRUST_API_KEY",
        judge_api_key_env: "OPENAI_API_KEY",
        judge_url: "https://api.openai.com/v1/chat/completions",
        judge_credential_ttl_seconds: 57_600
      },
      node_timeout_seconds: 7_200,
      loops: 3,
      models: [
        {
          slug: "gpt-5-6-sol",
          model: "gpt-5.6-sol",
          provider: "openai",
          agent: "CodexAgent",
          reasoning: "xhigh",
          auth_mode: "subscription"
        }
      ],
      target: { repo: "https://github.com/example/target", ref: gitA },
      benchmark_execution: { excluded_node_ids: [] },
      eval_reporting: { provider: "braintrust" },
      ground_truth: {
        repo: "https://github.com/example/ground-truth",
        ref: gitB,
        file: "findings.yml",
        format: "ultrafuzz"
      }
    },
    [MODAL_BENCHMARK_CONTROL_MANIFEST_SCHEMA_ID]: {
      schema_version: "ultrafuzz.modal.benchmark-control-manifest.v1",
      candidate_commit: gitA,
      repository: "https://github.com/monad-developers/ultrafuzz",
      generation: "12345-1",
      mode: "smoke",
      benchmark: "ultrafuzz-bench",
      execution: { mode: "modal", dry_run: false },
      image_name: `ufz-runner-${gitA}`,
      targets: [
        {
          id: "target-a",
          repository: "https://github.com/example/target-a",
          revision: gitB,
          framework: "foundry"
        }
      ],
      matrix_rows_per_pair: 1,
      control_timeout_seconds: 19_800,
      concurrency: {
        max_parallel_eval_rows_per_sandbox: 1,
        max_parallel_workflow_nodes_per_row: 8,
        max_live_runner_workflows_by_provider: { openai: 1 },
        max_live_judge_rows: 1
      },
      pairs: [
        {
          pair: "ultrafuzz-bench-benchmark-smoke-model-high",
          benchmark: "ultrafuzz-bench",
          mode: "smoke",
          lane: "smoke",
          model_slug: "benchmark-smoke-model-high",
          provider: "openai",
          config_path: "ultrafuzz-bench-benchmark-smoke-model-high.json",
          state_path: "ultrafuzz-bench-benchmark-smoke-model-high.state.json"
        }
      ]
    },
    [MODAL_LAUNCH_STATE_SCHEMA_ID]: {
      schema_version: "ultrafuzz.modal.launch-state.v3",
      logical_run_id: "logical-run",
      generation: 1,
      generation_mode: "fresh",
      generation_start_reason: "initial",
      app: "ultrafuzz-evals",
      image: "ultrafuzz-security-runner:latest",
      image_id: "image-id",
      timeout_ms: 60_000,
      source_revision: gitA,
      fingerprints: { config: shaA, source: shaB, image: shaC },
      launches: [],
      attempt_history: [],
      recovery_lifecycle: []
    },
    [MODAL_RECOVERY_LIFECYCLE_SCHEMA_ID]: {
      schema_version: "ultrafuzz.modal.recovery-lifecycle.v1",
      summary: emptyRecoverySummary(),
      records: []
    },
    [MODAL_RECOVERY_STATE_SCHEMA_ID]: {
      schema_version: "ultrafuzz.modal.recovery-state.v1",
      logical_run_id: "logical-run",
      launch_generation: 1,
      app: "ultrafuzz-evals",
      rows: []
    },
    [MODAL_WORKER_LINEAGE_SCHEMA_ID]: {
      schema_version: "ultrafuzz.modal.worker-lineage.v1",
      logical_run_id: "logical-run",
      generation: 1,
      attempt: 1,
      attempt_id: "attempt-1",
      workspace_mode: "fresh",
      fingerprints: { config: shaA, source: shaB, image: shaC },
      model_fingerprint: shaD
    },
    [MODAL_WORKER_RESULT_SCHEMA_ID]: {
      schema_version: "ultrafuzz.modal.worker-result.v2",
      result_type: "partial",
      generation: 1,
      launch_generation: 1,
      attempt: 1,
      model_work_started: false,
      counts: { succeeded: 0, failed: 0, remaining: 1 },
      checkpoint: { age_ms: null, digest: null },
      exit_category: "live",
      runtime_ms: 0,
      usage: null,
      diagnostic_code: "worker-live"
    },
    [MODAL_NODE_INPUT_SCHEMA_ID]: {
      schema_version: "ultrafuzz.modal.node.v1",
      run_id: "run-1",
      task_id: "task-1",
      attempt_id: "attempt-1",
      execution_generation: "base",
      execution_snapshot_root: ".ultrafuzz/runs/run-1/smithers/execution-snapshots/generation",
      workflow_path: ".ultrafuzz/runs/run-1/workflow.tsx",
      run_root: ".ultrafuzz/runs/run-1",
      artifact_dir: ".ultrafuzz/runs/run-1/artifacts/attempt-1",
      workspace_dir: ".ultrafuzz/runs/run-1/workspaces/attempt-1",
      dependency_artifact_dirs: [],
      resources: { cpu: 1, memory_mib: 1024, timeout_seconds: 60 },
      agent_credential_env: ["OPENAI_API_KEY"]
    },
    [MODAL_NODE_RESULT_SCHEMA_ID]: {
      schema_version: "ultrafuzz.modal.node-result.v2",
      status: "succeeded",
      artifact_archive: "/data/run/artifacts.tgz",
      artifact_sha256: shaA,
      storage_lineage: "run-1/attempt-1/base",
      durable_checkpoint: "/data/run/checkpoints/0003-completed.json",
      durable_checkpoint_index: "/data/run/checkpoints/index.json"
    },
    [MODAL_NODE_CHECKPOINT_SCHEMA_ID]: {
      schema_version: "ultrafuzz.modal.node-checkpoint.v1",
      checkpoint_id: "0001-prepared",
      sequence: 1,
      stage: "prepared",
      created_at: timestamp,
      storage_lineage: "run-1/attempt-1/base",
      workspace_path: "/data/run/workspace",
      run_root: ".ultrafuzz/runs/run-1",
      execution_snapshot_root: ".ultrafuzz/runs/run-1/smithers/execution-snapshots/generation",
      handoff_archive: "/data/run/input/project.tgz",
      project_archive_sha256: shaA
    },
    [MODAL_NODE_CHECKPOINT_INDEX_SCHEMA_ID]: {
      schema_version: "ultrafuzz.modal.node-checkpoint-index.v1",
      storage_lineage: "run-1/attempt-1/base",
      workspace_path: "/data/run/workspace",
      run_root: ".ultrafuzz/runs/run-1",
      execution_snapshot_root: ".ultrafuzz/runs/run-1/smithers/execution-snapshots/generation",
      handoff_archive: "/data/run/input/project.tgz",
      project_archive_sha256: shaA,
      checkpoints: [
        {
          checkpoint_id: "0001-prepared",
          sequence: 1,
          stage: "prepared",
          created_at: timestamp,
          manifest: "/data/run/checkpoints/0001-prepared.json"
        }
      ]
    },
    [MODAL_NODE_RESTORE_SCHEMA_ID]: {
      schema_version: "ultrafuzz.modal.node-restore.v1",
      source_root: "/data/prior-run"
    },
    [MODAL_NODE_WORKER_ERROR_SCHEMA_ID]: {
      schema_version: "ultrafuzz.modal.node-worker-error.v1",
      message: "workflow command failed",
      phase: "workflow",
      command: "ultrafuzz",
      exit_code: 1,
      stderr: "command failed"
    },
    [MODAL_EXECUTION_DEPENDENCY_MANIFEST_SCHEMA_ID]: {
      schema_version: "ultrafuzz.workflow-execution-dependencies.v1",
      modules: [],
      packages: [],
      issuers: [{ id: "root", snapshot_path: ".", dependencies: {} }],
      executable_paths: ["bin/smithers"],
      smithers_bin: "bin/smithers"
    },
    [MODAL_PINNED_SOURCE_PROOF_SCHEMA_ID]: {
      schema_version: "ultrafuzz.pinned-source-proof.v1",
      commit: gitA,
      tree: gitB,
      base_ref: "refs/heads/ultrafuzz-pinned",
      refs: [{ name: "refs/heads/ultrafuzz-pinned", object: gitA }],
      remotes: [],
      revision_count: 1,
      commit_object_count: 1
    },
    [MODAL_SMOKE_RESULT_SCHEMA_ID]: {
      schema_version: "ultrafuzz.modal.smoke-result.v1",
      status: "passed",
      provider: "openai",
      checks: {
        production_image: true,
        production_entrypoint: true,
        non_root: true,
        durable_storage: true,
        provider_auth: true,
        same_volume_resume: true,
        completed_work_not_repeated: true,
        single_launch_owner: true
      },
      diagnostics: { completed_units: 1, repeated_units: 0, launch_owners: 1 }
    }
  };
}

function bytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

describe("Modal strict JSON contract foundation", () => {
  it("registers and strictly compiles every schema with matching checked-in exports and gates", () => {
    const registry = modalSchemaRegistry();
    expect(registry).toHaveLength(17);
    expect(registry.map((entry) => entry.filename)).toEqual(Object.keys(MODAL_SCHEMA_METADATA).sort());
    expect(modalSchemaBundleDigest()).toMatch(/^[0-9a-f]{64}$/u);

    const implemented = new Set<string>(IMPLEMENTED_MODAL_SEMANTIC_GATES);
    for (const entry of registry) {
      expect(entry.schema).toEqual(MODAL_SCHEMA_EXPORTS[entry.typescriptExport as keyof typeof MODAL_SCHEMA_EXPORTS]);
      for (const gate of entry.semanticGates) expect(implemented.has(gate)).toBe(true);
    }
    expect(registry.find((entry) => entry.id === MODAL_COMMON_SCHEMA_ID)?.role).toBe("subschema");
    expect(registry.find((entry) => entry.id === MODAL_BENCHMARK_CONFIG_SCHEMA_ID)?.zodParser).toBe(
      "modalBenchmarkConfigZodSchema"
    );
  });

  it("validates one exact TypeScript fixture for every root contract", () => {
    const fixtures = contractFixtures();
    for (const [schemaId, value] of Object.entries(fixtures) as Array<
      [ModalContractSchemaId, ModalContractBySchemaId[ModalContractSchemaId]]
    >) {
      expect(validateModalJsonSchema(schemaId, value)).toMatchObject({ ok: true });
      expect(parseModalDocumentBytes(schemaId, bytes(value)).value).toEqual(value);
    }
  });

  it("rejects duplicate keys, invalid UTF-8, unknown fields, old versions, and numeric coercion", () => {
    expect(() =>
      parseModalDocumentBytes(
        MODAL_NODE_RESTORE_SCHEMA_ID,
        Buffer.from('{"schema_version":"ultrafuzz.modal.node-restore.v1","source_root":"/a","source_root":"/b"}')
      )
    ).toThrow(ModalDocumentValidationError);
    expect(() => parseModalDocumentBytes(MODAL_NODE_RESTORE_SCHEMA_ID, Uint8Array.from([0x7b, 0xff, 0x7d]))).toThrow(
      ModalDocumentValidationError
    );
    expect(() =>
      parseModalDocumentBytes(
        MODAL_WORKER_LINEAGE_SCHEMA_ID,
        bytes({ ...contractFixtures()[MODAL_WORKER_LINEAGE_SCHEMA_ID], unexpected: true })
      )
    ).toThrow(ModalDocumentValidationError);
    expect(() =>
      parseModalDocumentBytes(
        MODAL_WORKER_RESULT_SCHEMA_ID,
        bytes({
          ...contractFixtures()[MODAL_WORKER_RESULT_SCHEMA_ID],
          schema_version: "ultrafuzz.modal.worker-status.v2"
        })
      )
    ).toThrow(ModalDocumentValidationError);
    expect(() =>
      parseModalDocumentBytes(
        MODAL_NODE_CHECKPOINT_SCHEMA_ID,
        bytes({ ...contractFixtures()[MODAL_NODE_CHECKPOINT_SCHEMA_ID], sequence: "1" })
      )
    ).toThrow(ModalDocumentValidationError);
  });

  it("runs trusted semantic gates after shape validation", () => {
    const fixtures = contractFixtures();
    expect(() =>
      parseModalDocumentBytes(
        MODAL_RECOVERY_LIFECYCLE_SCHEMA_ID,
        bytes({
          ...fixtures[MODAL_RECOVERY_LIFECYCLE_SCHEMA_ID],
          summary: { ...emptyRecoverySummary(), total_generations: 1 }
        })
      )
    ).toThrow(ModalDocumentValidationError);
    expect(() =>
      parseModalDocumentBytes(
        MODAL_NODE_CHECKPOINT_INDEX_SCHEMA_ID,
        bytes({
          ...fixtures[MODAL_NODE_CHECKPOINT_INDEX_SCHEMA_ID],
          checkpoints: [
            {
              ...fixtures[MODAL_NODE_CHECKPOINT_INDEX_SCHEMA_ID].checkpoints[0],
              sequence: 2,
              checkpoint_id: "0002-prepared"
            }
          ]
        })
      )
    ).toThrow(ModalDocumentValidationError);
  });

  it("reads one immutable byte snapshot and atomically writes only validated documents", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "modal-documents-"));
    const filePath = path.join(root, "state", "lineage.json");
    const fixture = contractFixtures()[MODAL_WORKER_LINEAGE_SCHEMA_ID];
    const written = await writeModalDocumentAtomic(filePath, MODAL_WORKER_LINEAGE_SCHEMA_ID, fixture, {
      trustedRoot: root
    });
    const contents = fs.readFileSync(filePath);
    expect(written.bytes_sha256).toBe(crypto.createHash("sha256").update(contents).digest("hex"));
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);

    const read = readModalDocument(filePath, MODAL_WORKER_LINEAGE_SCHEMA_ID);
    expect(read.value).toEqual(fixture);
    expect(Object.isFrozen(read.value)).toBe(true);
    expect(Object.isFrozen(read.value.fingerprints)).toBe(true);

    fs.writeFileSync(filePath, "{}\n", "utf8");
    expect(() => readModalDocument(filePath, MODAL_WORKER_LINEAGE_SCHEMA_ID)).toThrow(ModalDocumentValidationError);
    const symlink = path.join(root, "lineage-link.json");
    fs.symlinkSync(filePath, symlink);
    expect(() => readModalDocument(symlink, MODAL_WORKER_LINEAGE_SCHEMA_ID)).toThrow();
  });

  it("requires containment in a canonical trusted root and rejects symlinked parents and targets", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "modal-document-paths-"));
    const root = path.join(base, "trusted");
    const outside = path.join(base, "outside");
    fs.mkdirSync(root, { mode: 0o700 });
    fs.mkdirSync(outside, { mode: 0o700 });
    const fixture = contractFixtures()[MODAL_WORKER_LINEAGE_SCHEMA_ID];

    await expect(
      writeModalDocumentAtomic(path.join(outside, "escaped.json"), MODAL_WORKER_LINEAGE_SCHEMA_ID, fixture, {
        trustedRoot: root
      })
    ).rejects.toThrow(/escapes/u);
    expect(fs.existsSync(path.join(outside, "escaped.json"))).toBe(false);

    const linkedParent = path.join(root, "linked-parent");
    fs.symlinkSync(outside, linkedParent, "dir");
    await expect(
      writeModalDocumentAtomic(path.join(linkedParent, "lineage.json"), MODAL_WORKER_LINEAGE_SCHEMA_ID, fixture, {
        trustedRoot: root
      })
    ).rejects.toThrow(/symlink/u);
    expect(fs.existsSync(path.join(outside, "lineage.json"))).toBe(false);

    const outsideTarget = path.join(outside, "outside.json");
    fs.writeFileSync(outsideTarget, "outside\n", { mode: 0o600 });
    const linkedTarget = path.join(root, "linked-target.json");
    fs.symlinkSync(outsideTarget, linkedTarget);
    await expect(
      writeModalDocumentAtomic(linkedTarget, MODAL_WORKER_LINEAGE_SCHEMA_ID, fixture, { trustedRoot: root })
    ).rejects.toThrow(/symlink/u);
    expect(fs.readFileSync(outsideTarget, "utf8")).toBe("outside\n");
    expect(fs.lstatSync(linkedTarget).isSymbolicLink()).toBe(true);

    const hardlinkedTarget = path.join(root, "hardlinked-target.json");
    fs.linkSync(outsideTarget, hardlinkedTarget);
    await expect(
      writeModalDocumentAtomic(hardlinkedTarget, MODAL_WORKER_LINEAGE_SCHEMA_ID, fixture, { trustedRoot: root })
    ).rejects.toThrow(/single-link/u);
    expect(fs.readFileSync(outsideTarget, "utf8")).toBe("outside\n");

    const directoryTarget = path.join(root, "directory-target.json");
    fs.mkdirSync(directoryTarget);
    await expect(
      writeModalDocumentAtomic(directoryTarget, MODAL_WORKER_LINEAGE_SCHEMA_ID, fixture, { trustedRoot: root })
    ).rejects.toThrow(/regular file/u);

    const rootAlias = path.join(base, "trusted-alias");
    fs.symlinkSync(root, rootAlias, "dir");
    await expect(
      writeModalDocumentAtomic(path.join(rootAlias, "aliased.json"), MODAL_WORKER_LINEAGE_SCHEMA_ID, fixture, {
        trustedRoot: rootAlias
      })
    ).rejects.toThrow(/symlink|canonical/u);
  });

  it("fails closed when the parent is swapped after the temp write and before descriptor-anchored rename", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "modal-document-race-"));
    const root = path.join(base, "trusted");
    const parent = path.join(root, "state");
    const displaced = path.join(base, "displaced-state");
    const outside = path.join(base, "outside");
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    fs.mkdirSync(outside, { mode: 0o700 });
    const target = path.join(parent, "lineage.json");
    const fixture = contractFixtures()[MODAL_WORKER_LINEAGE_SCHEMA_ID];
    const rename = fs.promises.rename.bind(fs.promises);
    let raced = false;
    const renameSpy = vi.spyOn(fs.promises, "rename").mockImplementation(async (source, destination) => {
      if (!raced && path.basename(destination.toString()) === path.basename(target)) {
        raced = true;
        await rename(parent, displaced);
        await fs.promises.symlink(outside, parent, "dir");
      }
      await rename(source, destination);
    });

    try {
      await expect(
        writeModalDocumentAtomic(target, MODAL_WORKER_LINEAGE_SCHEMA_ID, fixture, { trustedRoot: root })
      ).rejects.toThrow(/symlink|changed|canonical/u);
    } finally {
      renameSpy.mockRestore();
    }

    expect(raced).toBe(true);
    expect(fs.existsSync(path.join(outside, "lineage.json"))).toBe(false);
    expect(fs.existsSync(path.join(displaced, "lineage.json"))).toBe(false);
    expect(fs.readdirSync(displaced).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("detects same-inode byte tampering in the rename window", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "modal-document-byte-race-"));
    const target = path.join(root, "lineage.json");
    const fixture = contractFixtures()[MODAL_WORKER_LINEAGE_SCHEMA_ID];
    const rename = fs.promises.rename.bind(fs.promises);
    let raced = false;
    const renameSpy = vi.spyOn(fs.promises, "rename").mockImplementation(async (source, destination) => {
      await rename(source, destination);
      if (!raced && path.basename(destination.toString()) === path.basename(target)) {
        raced = true;
        const size = (await fs.promises.stat(destination)).size;
        await fs.promises.writeFile(destination, Buffer.alloc(size, 0x20));
      }
    });

    try {
      await expect(
        writeModalDocumentAtomic(target, MODAL_WORKER_LINEAGE_SCHEMA_ID, fixture, { trustedRoot: root })
      ).rejects.toThrow(/persisted bytes/u);
    } finally {
      renameSpy.mockRestore();
    }

    expect(raced).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(root).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
});
