import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertConfigRedactionsDocument,
  assertRunMetadataDocument,
  assertRunPlanDocument,
  assertSourceRunDocument,
  readConfigRedactionsDocument,
  readRunMetadataDocument,
  readRunPlanDocument,
  readSourceRunDocument,
  StrictJsonError,
  writeConfigRedactionsDocument,
  writeRunMetadataDocument,
  writeRunPlanDocument,
  writeSourceRunDocument,
  type ConfigRedactionsDocument,
  type RunAccountingSegment,
  type RunAccountingSummary,
  type RunMetadataDocument,
  type RunPlanDocument,
  type SourceRunDocument
} from "../src/index.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const CREATED_AT = "2026-08-09T12:00:00.000Z";

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ultrafuzz-run-documents-"));
}

function canonicalSourceRun(overrides: Partial<SourceRunDocument> = {}): SourceRunDocument {
  return {
    schema_version: "ultrafuzz.source-run.v2",
    run_id: "run-child",
    source_run_id: "run-parent",
    created_at: CREATED_AT,
    ...overrides
  };
}

function canonicalConfigRedactions(): ConfigRedactionsDocument {
  return {
    schemaVersion: "ultrafuzz.config-redactions.v2",
    placeholder: "<redacted>",
    entries: [
      {
        path: ["providers", "modal", "token"],
        key: "providers.modal.token",
        reason: "sensitive-value",
        restoreFrom: "environment",
        requiredForWorkflowLaunch: true,
        requiredForWorkflowSubmission: true
      }
    ]
  };
}

function canonicalRunPlan(): RunPlanDocument {
  return {
    schema_version: "ultrafuzz.run-plan.v3",
    run_id: "run-child",
    mode: "run",
    graph_fingerprint: DIGEST_A,
    config_fingerprint: DIGEST_B,
    redacted_config_fingerprint: DIGEST_A,
    prompt_digest: DIGEST_B,
    controller_source_digest: DIGEST_A,
    execution: {
      mode: "local",
      retentionDays: 30,
      resources: { cpu: 1, memoryMiB: 512, timeoutSeconds: 300 },
      nodes: { node_a: { resources: { memoryMiB: 1_024 } } },
      providers: {}
    },
    topology: { path: "topology.json", logical_nodes: 1, expanded_nodes: 1, required_commands: [] },
    audit_profile: {
      id: "full",
      catalog_digest: DIGEST_A,
      effective_topology_path: "topology.json",
      topology_path_origin: "audit-profile",
      topology_digest: DIGEST_B,
      prompt_digest: DIGEST_B,
      expanded_graph_fingerprint: DIGEST_A,
      effective_settings: {},
      setting_origins: {},
      overridden_settings: [],
      topology_overridden: false
    },
    // prettier-ignore
    data_governance: { schema_version: "ultrafuzz.data-governance-provenance.v1", path: "data-governance.json", sha256: DIGEST_A, policy_digest: DIGEST_B, input_digest: DIGEST_A, sensitivity: "private", acknowledgement_status: "approved" },
    rendered_prompts: [
      {
        node_id: "node-a-0",
        logical_node_id: "node-a",
        attempt_id: "attempt-a-0",
        prompt_id: "prompt-a",
        prompt_path: "prompts/prompt-a.md",
        rendered_prompt_path: "rendered/node-a-0.md",
        rendered_prompt_digest: DIGEST_B,
        rendered_prompt_snapshot_path: "snapshots/node-a-0.md",
        variables_used: ["run_id"],
        artifact_references: [
          { kind: "artifact_path", logicalId: "node-a", suffix: "result.json" },
          { kind: "ancestor_artifacts", logicalIds: "direct" },
          {
            kind: "ancestor_artifacts_by_path",
            logicalIds: [],
            relativePaths: ["optional/context.md"]
          }
        ]
      }
    ],
    policy_posture: {
      config: "pass",
      topology: "pass",
      prompts: "pass",
      paths: "pass",
      agents: "pass",
      trust: "pass"
    }
  };
}

function canonicalAccountingSummary(): RunAccountingSummary {
  return {
    uncached_input_tokens: 10,
    input_tokens: 12,
    output_tokens: 3,
    cache_read_tokens: 2,
    cache_write_tokens: 0,
    reasoning_tokens: 1,
    inclusive_token_total: 18,
    billable_token_total: 16,
    total_tokens: 16,
    tokens_used: "16",
    estimated_spend: "$0.000016",
    estimated_spend_usd: 0.000016,
    component_costs_usd: {
      uncached_input: 0.00001,
      cache_read: 0.000001,
      cache_write: 0,
      output: 0.000003,
      reasoning: 0.000002
    },
    usage_complete: true,
    usage_incomplete_reasons: [],
    pricing_complete: true,
    pricing_incomplete_reasons: [],
    partial_pricing: false,
    cache_read_pricing_estimated: false,
    event_count: 1,
    priced_event_count: 1,
    unpriced_event_count: 0,
    models: ["model-current"],
    agents: ["agent-current"]
  };
}

function canonicalAccountingSegment(): RunAccountingSegment {
  return {
    ...canonicalAccountingSummary(),
    control_generation: DIGEST_B,
    workflow_run_id: "workflow-current",
    source_event_sequences: [1],
    attempts: [{ node_id: "node-a-0", iteration: 0, attempt: 0 }]
  };
}

function canonicalRunMetadata(): RunMetadataDocument {
  const segment = canonicalAccountingSegment();
  return {
    schema_version: "ultrafuzz.run-metadata.v2",
    run_id: "run-child",
    created_at: CREATED_AT,
    mode: "run",
    workflow_ids: ["workflow-current"],
    redacted_config_fingerprint: DIGEST_A,
    forge_guard: {
      enabled: true,
      active: true,
      virtual_memory_limit_kb: 1_048_576,
      rayon_threads: 4
    },
    workflow: {
      run_id: "workflow-current",
      compiled_run_id: "compiled-current",
      name: "current workflow",
      path: "workflow.tsx",
      evidence_path: "evidence.json",
      expanded_graph_path: "expanded-graph.json",
      config_path: "config.json",
      input_path: "input.json",
      tasks_path: "tasks.json",
      control_integrity_path: "control-integrity.json",
      control_generation: DIGEST_B,
      workflow_link_id: "123e4567-e89b-42d3-a456-426614174000",
      execution_snapshot_path: "execution-snapshot.json",
      task_node_ids: ["node-a-0"]
    },
    accounting: {
      schema_version: "ultrafuzz.accounting.v3",
      source: "usage-ledger",
      workflow_run_id: "workflow-current",
      current: structuredClone(segment),
      segments: [structuredClone(segment)],
      cumulative: { ...canonicalAccountingSummary(), source_run_ids: ["run-child"] },
      checkpoint: {
        schema_version: "ultrafuzz.accounting-checkpoint.v1",
        ledger_event_count: 1,
        last_source_event_sequence: 1,
        control_generation: DIGEST_B,
        workflow_run_id: "workflow-current"
      },
      pricing_catalog: {
        source: "configured-catalog",
        status: "available",
        fetched_at: CREATED_AT,
        resolved_models: ["model-current"],
        unresolved_models: [],
        model_prices: {
          "model-current": { inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 2 }
        }
      },
      updated_at: CREATED_AT
    }
  };
}

test("canonical runtime documents round-trip through their validated writers and strict readers", (t) => {
  const root = temporaryDirectory();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const sourceRun = canonicalSourceRun();
  const redactions = canonicalConfigRedactions();
  const runPlan = canonicalRunPlan();
  const runMetadata = canonicalRunMetadata();
  const sourcePath = path.join(root, "source-run.json");
  const redactionsPath = path.join(root, "config-redactions.json");
  const planPath = path.join(root, "plan.json");
  const metadataPath = path.join(root, "metadata.json");

  writeSourceRunDocument(sourcePath, sourceRun);
  writeConfigRedactionsDocument(redactionsPath, redactions);
  writeRunPlanDocument(planPath, runPlan);
  writeRunMetadataDocument(metadataPath, runMetadata);

  assert.deepEqual(readSourceRunDocument(sourcePath, sourceRun.run_id), sourceRun);
  assert.deepEqual(readConfigRedactionsDocument(redactionsPath), redactions);
  assert.deepEqual(readRunPlanDocument(planPath, runPlan.run_id), runPlan);
  assert.deepEqual(readRunMetadataDocument(metadataPath, runMetadata.run_id), runMetadata);
});

test("every runtime document rejects its historical schema version", () => {
  assert.throws(
    () => assertSourceRunDocument({ ...canonicalSourceRun(), schema_version: "ultrafuzz.source-run.v1" }),
    /unsupported source run document schema_version/u
  );
  assert.throws(
    () =>
      assertConfigRedactionsDocument({
        ...canonicalConfigRedactions(),
        schemaVersion: "ultrafuzz.config-redactions.v1"
      }),
    /unsupported configuration redaction manifest schemaVersion/u
  );
  assert.throws(
    () => assertRunPlanDocument({ ...canonicalRunPlan(), schema_version: "ultrafuzz.run-plan.v2" }),
    /unsupported run plan schema_version/u
  );
  assert.throws(
    () => assertRunMetadataDocument({ ...canonicalRunMetadata(), schema_version: "ultrafuzz.run-metadata.v1" }),
    /unsupported run metadata schema_version/u
  );
});

test("every runtime document rejects unknown properties", () => {
  assert.throws(() => assertSourceRunDocument({ ...canonicalSourceRun(), unexpected: true }), /schema-invalid/u);
  assert.throws(
    () => assertConfigRedactionsDocument({ ...canonicalConfigRedactions(), unexpected: true }),
    /schema-invalid/u
  );
  assert.throws(() => assertRunPlanDocument({ ...canonicalRunPlan(), unexpected: true }), /schema-invalid/u);
  assert.throws(() => assertRunMetadataDocument({ ...canonicalRunMetadata(), unexpected: true }), /schema-invalid/u);
});

test("strict runtime document reads reject duplicate keys and invalid UTF-8 before schema validation", (t) => {
  const root = temporaryDirectory();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const duplicatePath = path.join(root, "duplicate.json");
  const duplicate = JSON.stringify(canonicalSourceRun()).replace(
    '"run_id":"run-child"',
    '"run_id":"run-child","run_id":"run-shadow"'
  );
  fs.writeFileSync(duplicatePath, duplicate, "utf8");
  assert.throws(
    () => readSourceRunDocument(duplicatePath),
    (error: unknown) =>
      error instanceof StrictJsonError && error.kind === "duplicate-key" && error.pointer === "/run_id"
  );

  const invalidUtf8Path = path.join(root, "invalid-utf8.json");
  fs.writeFileSync(invalidUtf8Path, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]));
  assert.throws(
    () => readSourceRunDocument(invalidUtf8Path),
    (error: unknown) => error instanceof StrictJsonError && error.kind === "encoding"
  );
});

test("run-bound documents reject an unexpected run identity", (t) => {
  const root = temporaryDirectory();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "source-run.json");
  const planPath = path.join(root, "plan.json");
  const metadataPath = path.join(root, "metadata.json");

  writeSourceRunDocument(sourcePath, canonicalSourceRun());
  writeRunPlanDocument(planPath, canonicalRunPlan());
  writeRunMetadataDocument(metadataPath, canonicalRunMetadata());

  assert.throws(() => readSourceRunDocument(sourcePath, "run-other"), /identity does not match run/u);
  assert.throws(() => readRunPlanDocument(planPath, "run-other"), /identity does not match run/u);
  assert.throws(() => readRunMetadataDocument(metadataPath, "run-other"), /identity does not match run/u);
});

test("source links cannot point to the run itself", () => {
  assert.throws(
    () => assertSourceRunDocument(canonicalSourceRun({ source_run_id: "run-child" })),
    /cannot link a run to itself/u
  );
});

test("configuration redaction keys must exactly project their paths", () => {
  const redactions = canonicalConfigRedactions();
  redactions.entries[0]!.key = "providers.modal.other-token";
  assert.throws(() => assertConfigRedactionsDocument(redactions), /does not match path/u);
});

test("run metadata workflow IDs must exactly identify the active workflow", () => {
  const metadata = canonicalRunMetadata();
  metadata.workflow_ids = ["workflow-other"];
  assert.throws(() => assertRunMetadataDocument(metadata), /workflow IDs do not exactly match/u);
});

test("run metadata current accounting must exactly equal its final segment", () => {
  const metadata = canonicalRunMetadata();
  metadata.accounting!.current.output_tokens += 1;
  assert.throws(
    () => assertRunMetadataDocument(metadata),
    /current accounting does not equal the final accounting segment/u
  );
});

test("a malformed present document fails differently from a genuinely missing document", (t) => {
  const root = temporaryDirectory();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const malformedPath = path.join(root, "metadata.json");
  const missingPath = path.join(root, "missing.json");
  fs.writeFileSync(malformedPath, '{"schema_version":', "utf8");

  assert.throws(
    () => readRunMetadataDocument(malformedPath),
    (error: unknown) => error instanceof StrictJsonError && error.kind === "syntax"
  );
  assert.throws(() => readRunMetadataDocument(missingPath), /cannot open regular file/u);
});

test("a runtime document read rejects an atomic path replacement during its snapshot", (t) => {
  const root = temporaryDirectory();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "source-run.json");
  const replacementPath = path.join(root, "replacement.json");
  const original = canonicalSourceRun();
  const replacement = canonicalSourceRun({ run_id: "run-replacement" });
  writeSourceRunDocument(sourcePath, original);
  writeSourceRunDocument(replacementPath, replacement);

  const originalReadSync = fs.readSync;
  let replaced = false;
  t.mock.method(fs, "readSync", ((...args: unknown[]) => {
    const bytesRead = Reflect.apply(originalReadSync, fs, args) as number;
    if (!replaced && bytesRead > 0) {
      replaced = true;
      fs.renameSync(replacementPath, sourcePath);
    }
    return bytesRead;
  }) as typeof fs.readSync);

  assert.throws(() => readSourceRunDocument(sourcePath, original.run_id), /file changed while it was read/u);
  assert.equal(replaced, true);
  assert.deepEqual(readSourceRunDocument(sourcePath, replacement.run_id), replacement);
});

test("runtime document reads detect same-file mutation and refuse symlinks", (t) => {
  const root = temporaryDirectory();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "source-run.json");
  const symlinkPath = path.join(root, "source-run-link.json");
  writeSourceRunDocument(sourcePath, canonicalSourceRun());
  fs.symlinkSync(sourcePath, symlinkPath);
  assert.throws(() => readSourceRunDocument(symlinkPath), /cannot open regular file/u);

  const originalReadSync = fs.readSync;
  let mutated = false;
  t.mock.method(fs, "readSync", ((...args: unknown[]) => {
    const bytesRead = Reflect.apply(originalReadSync, fs, args) as number;
    if (!mutated && bytesRead > 0) {
      mutated = true;
      fs.appendFileSync(sourcePath, " ", "utf8");
    }
    return bytesRead;
  }) as typeof fs.readSync);

  assert.throws(() => readSourceRunDocument(sourcePath), /file changed while it was read/u);
  assert.equal(mutated, true);
});
