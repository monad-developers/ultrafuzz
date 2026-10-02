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
  formatEstimatedSpendUsd,
  readConfigRedactionsDocument,
  readRunMetadataDocument,
  readRunPlanDocument,
  readSourceRunDocument,
  promptArtifactAuthorityPathSelectorId,
  StrictJsonError,
  updateRunMetadataDocument,
  writeConfigRedactionsDocument,
  writeRunMetadataDocument,
  writeRunPlanDocument,
  writeSourceRunDocument,
  type ConfigRedactionsDocument,
  type RunAccountingSegment,
  type RunAccountingSummary,
  type RunMetadataDocument,
  type RunPlanDocument,
  type RunSpendEstimate,
  type SourceRunDocument
} from "../src/index.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const CREATED_AT = "2026-08-09T12:00:00.000Z";

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ultrafuzz-run-documents-"));
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
      id: "exhaustive",
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
    data_governance: {
      schema_version: "ultrafuzz.data-governance-provenance.v1",
      path: "data-governance.json",
      sha256: DIGEST_A,
      policy_digest: DIGEST_B,
      input_digest: DIGEST_A,
      sensitivity: "private",
      acknowledgement_status: "approved"
    },
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
          {
            kind: "ancestor_artifact_path_authority",
            logicalIds: [],
            selectorId: promptArtifactAuthorityPathSelectorId(["optional/context.md"]),
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
      schema_version: "ultrafuzz.accounting.v4",
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

function canonicalSpendEstimate(): RunSpendEstimate {
  return {
    schema_version: "ultrafuzz.spend-estimate.v1",
    workflow_run_id: "workflow-current",
    estimated_spend_usd: 12.3456,
    estimated_spend: "$12.35",
    complete: false,
    fallback_pricing_table: "ultrafuzz.fallback-pricing.2026-10-01",
    basis_usd: { recorded: 1.2, catalog: 0.0456, fallback: 3.1, imputed: 8, source_runs: 0 },
    accounted_attempts: 3,
    models: [
      {
        model: "anthropic/claude-opus-4.8",
        attempts: 2,
        estimated_spend_usd: 1.2456,
        price_source: "mixed",
        catalog_provider: "openrouter",
        catalog_model_id: "anthropic/claude-opus-4.8"
      },
      {
        model: "claude-opus-4-8[1m]",
        attempts: 2,
        estimated_spend_usd: 11.1,
        price_source: "fallback",
        fallback_family: "claude-opus",
        fallback_rates: {
          inputUsdPerMillion: 5,
          cachedInputUsdPerMillion: 0.5,
          cacheWriteUsdPerMillion: 6.25,
          outputUsdPerMillion: 25
        }
      }
    ],
    assumptions: [
      { code: "model-not-in-route-catalog", count: 1, model: "claude-opus-4-8[1m]" },
      { code: "unaccounted-attempt-imputed", count: 1 }
    ],
    unaccounted_attempts: {
      count: 1,
      imputed_spend_usd: 8,
      omitted: 0,
      entries: [
        {
          node_id: "node-a-0",
          iteration: 0,
          attempt: 2,
          model_name: "claude-opus-4-8[1m]",
          imputation: "same-model-mean"
        }
      ]
    },
    source_run_ids: [],
    updated_at: CREATED_AT
  };
}

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  assert.ok(value !== undefined, `fixture has no entry ${String(index)}`);
  return value;
}

function runMetadataWithSpendEstimate(
  update: (estimate: RunSpendEstimate) => void = () => undefined
): RunMetadataDocument {
  const estimate = canonicalSpendEstimate();
  update(estimate);
  return { ...canonicalRunMetadata(), spend_estimate: estimate };
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

test("run plans round-trip compact selector groups in either path order and reject mismatched path IDs", (t) => {
  const root = temporaryDirectory();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const runPlan = canonicalRunPlan();
  const emptyContractReference = {
    kind: "ancestor_contract_artifact_authority" as const,
    logicalIds: [],
    contract: "ultrafuzz/findings@2"
  };
  const pathAuthority = (paths: string[]) => ({
    kind: "ancestor_artifact_path_authority" as const,
    logicalIds: [],
    selectorId: promptArtifactAuthorityPathSelectorId(paths),
    relativePaths: paths
  });
  // Code-unit order, which planning now produces ("F" sorts before "c"), and the
  // host-collation order that plans sealed before it hold.
  const pathReference = pathAuthority(["reports/Final.json", "reports/context.md"]);
  const collatedReference = pathAuthority(["reports/context.md", "reports/Final.json"]);
  const [prompt] = runPlan.rendered_prompts;
  assert.ok(prompt);
  prompt.artifact_references.push(emptyContractReference, pathReference, collatedReference);
  const planPath = path.join(root, "plan.json");

  writeRunPlanDocument(planPath, runPlan);

  const roundTripped = readRunPlanDocument(planPath, runPlan.run_id);
  assert.deepEqual(roundTripped.rendered_prompts[0]?.artifact_references.slice(-3), [
    emptyContractReference,
    pathReference,
    collatedReference
  ]);

  pathReference.selectorId = "0".repeat(64);
  assert.throws(() => assertRunPlanDocument(runPlan), /invalid compact path authority group/u);
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

test("run metadata updates apply to the document as it is when they write, under its lock", (t) => {
  const root = temporaryDirectory();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const metadataPath = path.join(root, "run.json");
  const launched = canonicalRunMetadata();
  writeRunMetadataDocument(metadataPath, launched);
  // Another process's write after this one would have read the document.
  const { accounting: _accounting, ...withoutAccounting } = launched;
  writeRunMetadataDocument(metadataPath, withoutAccounting);
  let lockHeld = false;

  updateRunMetadataDocument(metadataPath, launched.run_id, (current) => {
    lockHeld = fs.existsSync(`${metadataPath}.lock`);
    return { ...current, forge_guard: { ...launched.forge_guard, active: false } };
  });

  assert.equal(lockHeld, true);
  assert.equal(fs.existsSync(`${metadataPath}.lock`), false);
  assert.deepEqual(readRunMetadataDocument(metadataPath, launched.run_id), {
    ...withoutAccounting,
    forge_guard: { ...launched.forge_guard, active: false }
  });
});

test("source links cannot point to the run itself", () => {
  assert.throws(
    () => assertSourceRunDocument(canonicalSourceRun({ source_run_id: "run-child" })),
    /cannot link a run to itself/u
  );
});

test("run source refs are bound to the document run identity", () => {
  const source_revision = "c".repeat(40);
  const foreignRef = "refs/ultrafuzz/runs/run-foreign/source";
  assert.throws(
    () => assertRunPlanDocument({ ...canonicalRunPlan(), source_revision, source_ref: foreignRef }),
    /source ref does not belong/u
  );
  assert.throws(
    () => assertRunMetadataDocument({ ...canonicalRunMetadata(), source_revision, source_ref: foreignRef }),
    /source ref does not belong/u
  );
  assert.doesNotThrow(() =>
    assertRunPlanDocument({
      ...canonicalRunPlan(),
      source_revision,
      source_ref: "refs/ultrafuzz/runs/run-child/source"
    })
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

test("run metadata round-trips a spend estimate and accepts one without v4 accounting", (t) => {
  const root = temporaryDirectory();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const metadataPath = path.join(root, "run.json");
  const metadata = runMetadataWithSpendEstimate();
  writeRunMetadataDocument(metadataPath, metadata);
  assert.deepEqual(readRunMetadataDocument(metadataPath, metadata.run_id), metadata);

  // Executed agent attempts without any usage evidence produce an estimate while v4 accounting stays absent.
  const { accounting: _accounting, ...withoutAccounting } = metadata;
  assert.doesNotThrow(() => assertRunMetadataDocument(withoutAccounting));
});

test("run metadata spend estimates are closed and require the workflow they describe", () => {
  const { workflow: _workflow, ...unlinked } = runMetadataWithSpendEstimate();
  const { accounting: _accounting, ...unlinkedWithoutAccounting } = unlinked;
  assert.throws(
    () => assertRunMetadataDocument({ ...unlinkedWithoutAccounting, workflow_ids: [] }),
    /schema-invalid: \/ must have property workflow when property spend_estimate is present/u
  );
  const invalidShapes: Array<[string, (estimate: RunSpendEstimate) => void]> = [
    ["unknown property", (estimate) => Object.assign(estimate, { unexpected: true })],
    ["unknown basis", (estimate) => Object.assign(estimate.basis_usd, { estimated: 0 })],
    ["negative basis", (estimate) => (estimate.basis_usd.source_runs = -1)],
    ["suffixed label", (estimate) => (estimate.estimated_spend = "$12.35+")],
    ["unavailable label", (estimate) => (estimate.estimated_spend = "unavailable")],
    ["unknown fallback table", (estimate) => (estimate.fallback_pricing_table = "ultrafuzz.fallback-pricing.v1")],
    ["unknown price source", (estimate) => Object.assign(at(estimate.models, 0), { price_source: "estimated" })],
    ["unknown fallback family", (estimate) => Object.assign(at(estimate.models, 1), { fallback_family: "opus" })],
    ["fallback family without its rates", (estimate) => delete at(estimate.models, 1).fallback_rates],
    ["catalog provider without its model ID", (estimate) => delete at(estimate.models, 0).catalog_model_id],
    [
      "report-production imputation code",
      (estimate) => Object.assign(at(estimate.assumptions, 0), { code: "report-attempt-imputed" })
    ],
    [
      "unknown imputation",
      (estimate) => Object.assign(at(estimate.unaccounted_attempts.entries, 0), { imputation: "guess" })
    ],
    [
      "unbounded unaccounted entries",
      (estimate) => {
        const template = at(estimate.unaccounted_attempts.entries, 0);
        estimate.unaccounted_attempts.entries = Array.from({ length: 257 }, (_entry, attempt) => ({
          ...template,
          attempt
        }));
        estimate.unaccounted_attempts.count = 257;
      }
    ]
  ];
  for (const [label, update] of invalidShapes) {
    assert.throws(() => assertRunMetadataDocument(runMetadataWithSpendEstimate(update)), /schema-invalid/u, label);
  }
});

test("run metadata spend estimates must agree with their workflow, label, basis, and attempt census", () => {
  const invalidSemantics: Array<[RegExp, (estimate: RunSpendEstimate) => void]> = [
    [/does not match the active workflow run/u, (estimate) => (estimate.workflow_run_id = "workflow-other")],
    [/label does not format its USD amount/u, (estimate) => (estimate.estimated_spend = "$12.3456")],
    [/label does not format its USD amount/u, (estimate) => (estimate.estimated_spend = "$12.34")],
    [/basis does not sum to its USD amount/u, (estimate) => (estimate.basis_usd.source_runs = 0.01)],
    [/basis does not sum to its USD amount/u, (estimate) => (estimate.basis_usd.imputed = 7.999)],
    [/models must be unique and sorted by model/u, (estimate) => estimate.models.reverse()],
    [
      /models must be unique and sorted by model/u,
      (estimate) => (at(estimate.models, 1).model = at(estimate.models, 0).model)
    ],
    [/assumptions must be unique and sorted by code and model/u, (estimate) => estimate.assumptions.reverse()],
    [
      // Distinct counts keep these entries apart for the schema's uniqueItems, but they repeat one key.
      /assumptions must be unique and sorted by code and model/u,
      (estimate) =>
        (estimate.assumptions = [
          { code: "catalog-unavailable", count: 1 },
          { code: "catalog-unavailable", count: 2 }
        ])
    ],
    [
      /assumptions must be unique and sorted by code and model/u,
      (estimate) =>
        (estimate.assumptions = [
          { code: "model-not-in-route-catalog", count: 1, model: "claude-opus-4-8[1m]" },
          { code: "model-not-in-route-catalog", count: 1 }
        ])
    ],
    [
      /unaccounted attempts must be unique by node, iteration, and attempt/u,
      (estimate) => {
        const entry = at(estimate.unaccounted_attempts.entries, 0);
        estimate.unaccounted_attempts.entries.push({ ...entry, imputation: "run-mean" });
        estimate.unaccounted_attempts.count = 2;
      }
    ],
    [/unaccounted-attempt count does not match its entries/u, (estimate) => (estimate.unaccounted_attempts.count = 2)],
    [/claims completeness/u, (estimate) => (estimate.complete = true)]
  ];
  for (const [message, update] of invalidSemantics) {
    assert.throws(() => assertRunMetadataDocument(runMetadataWithSpendEstimate(update)), message, String(message));
  }
  // A code without a model sorts before the same code with one, and one node may have several unaccounted attempts.
  assert.doesNotThrow(() =>
    assertRunMetadataDocument(
      runMetadataWithSpendEstimate((estimate) => {
        estimate.assumptions = [
          { code: "model-not-in-route-catalog", count: 1 },
          { code: "model-not-in-route-catalog", count: 1, model: "claude-opus-4-8[1m]" },
          { code: "unaccounted-attempt-imputed", count: 2 }
        ];
        const entry = at(estimate.unaccounted_attempts.entries, 0);
        estimate.unaccounted_attempts.entries.push({ ...entry, attempt: 3 }, { ...entry, iteration: 1 });
        estimate.unaccounted_attempts.count = 3;
      })
    )
  );
  // Entries beyond the bounded list are counted as omitted.
  assert.doesNotThrow(() =>
    assertRunMetadataDocument(
      runMetadataWithSpendEstimate((estimate) => {
        estimate.unaccounted_attempts.count = 3;
        estimate.unaccounted_attempts.omitted = 2;
      })
    )
  );
  // A complete estimate has no fallback, imputed or assumed spend.
  assert.doesNotThrow(() =>
    assertRunMetadataDocument(
      runMetadataWithSpendEstimate((estimate) => {
        Object.assign(estimate, {
          complete: true,
          estimated_spend_usd: 1.2456,
          estimated_spend: "$1.25",
          basis_usd: { recorded: 1.2, catalog: 0.0456, fallback: 0, imputed: 0, source_runs: 0 },
          models: [at(estimate.models, 0)],
          assumptions: [],
          unaccounted_attempts: { count: 0, imputed_spend_usd: 0, omitted: 0, entries: [] }
        });
      })
    )
  );
});

test("spend estimates format without suffixes and keep a nonzero amount visible", () => {
  const label = /^\$(?:0|[1-9][0-9]*)\.[0-9]{2,10}$/u;
  const expected: Array<[number, string]> = [
    [0, "$0.00"],
    [0.01, "$0.01"],
    [0.125, "$0.13"],
    // toFixed rounds the exact binary value: 12.345 is stored just above the tie and 1.005 just below it.
    [12.345, "$12.35"],
    [1.005, "$1.00"],
    [12.3456, "$12.35"],
    [123_456_789.999, "$123456790.00"],
    [0.0099, "$0.0099"],
    [0.009995, "$0.0100"],
    [0.005, "$0.0050"],
    [1.65e-5, "$0.000017"],
    [1.23456e-5, "$0.000012"],
    [1e-10, "$0.0000000001"],
    [4e-11, "$0.0000000000"],
    [Number.MIN_VALUE, "$0.0000000000"]
  ];
  for (const [value, formatted] of expected) {
    assert.equal(formatEstimatedSpendUsd(value), formatted, String(value));
    assert.match(formatEstimatedSpendUsd(value), label, String(value));
  }
  for (const value of [
    -0.01,
    -Number.MIN_VALUE,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1e21
  ]) {
    assert.throws(
      () => formatEstimatedSpendUsd(value),
      /spend estimate is outside the supported range/u,
      String(value)
    );
  }
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

test("a runtime document read ignores a hard link or an atomic replacement made during its snapshot", (t) => {
  const root = temporaryDirectory();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "source-run.json");
  const replacementPath = path.join(root, "replacement.json");
  const original = canonicalSourceRun();
  const replacement = canonicalSourceRun({ run_id: "run-replacement" });
  writeSourceRunDocument(sourcePath, original);
  writeSourceRunDocument(replacementPath, replacement);
  assert.deepEqual(readSourceRunDocument(sourcePath, original.run_id), original);

  const originalReadSync = fs.readSync;
  let midRead: (() => void) | undefined;
  t.mock.method(fs, "readSync", ((...args: unknown[]) => {
    const bytesRead = Reflect.apply(originalReadSync, fs, args) as number;
    const action = midRead;
    midRead = undefined;
    action?.();
    return bytesRead;
  }) as typeof fs.readSync);

  // pnpm links one store inode into every node_modules that installs the package, so an install
  // anywhere on the host changes the link count and ctime of a file while it is read.
  midRead = () => fs.linkSync(sourcePath, path.join(root, "linked-elsewhere.json"));
  assert.deepEqual(readSourceRunDocument(sourcePath, original.run_id), original);
  assert.equal(fs.statSync(sourcePath).nlink, 2);

  // Writers publish whole documents by rename, which leaves the open descriptor on the complete
  // original: the read returns the document as it was when it was opened.
  midRead = () => fs.renameSync(replacementPath, sourcePath);
  assert.deepEqual(readSourceRunDocument(sourcePath, original.run_id), original);
  assert.equal(midRead, undefined);
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
