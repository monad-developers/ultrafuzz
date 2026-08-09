import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  EVMBENCH_CATALOG_JSON_SCHEMA_ID,
  EVMBENCH_LOCK_JSON_SCHEMA_ID,
  EVMBENCH_PROFILE_JSON_SCHEMA_ID,
  EVMBENCH_RESULT_JSON_SCHEMA_ID,
  evmbenchCatalogSchema,
  evmbenchLockSchema,
  evmbenchProfileSchema,
  normalizedEvmbenchResultSchema,
  parseEvmbenchCatalogBytes,
  parseEvmbenchLockBytes,
  parseEvmbenchProfileBytes,
  parseNormalizedEvmbenchResultBytes,
  serializeEvmbenchCatalog,
  serializeEvmbenchLock,
  serializeEvmbenchProfile,
  serializeNormalizedEvmbenchResult
} from "../src/contracts.js";
import {
  evmbenchSchemaBundleDigest,
  evmbenchSchemaRegistry,
  validateEvmbenchJsonSchema
} from "../src/schema-registry.js";
import { EVMBENCH_SEMANTIC_GATES_BY_SCHEMA_ID, IMPLEMENTED_EVMBENCH_SEMANTIC_GATES } from "../src/semantic-gates.js";
import { findUltrafuzzRepoRoot } from "../src/definition.js";
import {
  EVMBENCH_CLI_EXPECTED_COMMAND_CONTEXT_GATE,
  EVMBENCH_CLI_RESULT_JSON_SCHEMA_ID,
  parseEvmbenchCliResult
} from "../src/cli-contracts.js";
import {
  NANOEVAL_FINAL_REPORT_JSON_SCHEMA_ID,
  NANOEVAL_RECORD_JSON_SCHEMA_ID,
  nanoevalFinalReportSchema,
  nanoevalRecordSchema,
  parseNanoevalFinalReport,
  parseNanoevalRecord
} from "../src/results.js";

describe("EVMBench JSON Schema and Zod parity", () => {
  it("compiles a closed, immutable Draft 2020-12 registry", () => {
    const registry = evmbenchSchemaRegistry();
    expect(registry.map((entry) => entry.id)).toEqual([
      EVMBENCH_CATALOG_JSON_SCHEMA_ID,
      EVMBENCH_LOCK_JSON_SCHEMA_ID,
      EVMBENCH_PROFILE_JSON_SCHEMA_ID,
      EVMBENCH_RESULT_JSON_SCHEMA_ID,
      EVMBENCH_CLI_RESULT_JSON_SCHEMA_ID,
      NANOEVAL_FINAL_REPORT_JSON_SCHEMA_ID,
      NANOEVAL_RECORD_JSON_SCHEMA_ID
    ]);
    expect(evmbenchSchemaBundleDigest()).toMatch(/^[0-9a-f]{64}$/u);
    for (const entry of registry) {
      expect(entry.schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      if (entry.id === NANOEVAL_RECORD_JSON_SCHEMA_ID) {
        const definitions = entry.schema.$defs as Readonly<Record<string, Readonly<Record<string, unknown>>>>;
        for (const name of [
          "runStartedRecord",
          "samplingRecord",
          "matchRecord",
          "extraRecord",
          "sampleCompletedRecord",
          "errorRecord",
          "finalReportRecord"
        ]) {
          expect(definitions[name]?.additionalProperties).toBe(false);
        }
      } else {
        expect(entry.schema.additionalProperties).toBe(false);
      }
      expect(Object.isFrozen(entry.schema)).toBe(true);
      expect(Object.isFrozen(entry.schema.properties)).toBe(true);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(entry.semanticGates).toEqual(
        EVMBENCH_SEMANTIC_GATES_BY_SCHEMA_ID[entry.id as keyof typeof EVMBENCH_SEMANTIC_GATES_BY_SCHEMA_ID]
      );
      for (const gate of entry.semanticGates) expect(IMPLEMENTED_EVMBENCH_SEMANTIC_GATES).toContain(gate);
    }
  });

  it("parses and reserializes every checked-in definition/profile fixture through both validators", () => {
    const benchmarkRoot = path.join(findUltrafuzzRepoRoot(), "benchmarks", "evmbench");
    const catalog = parseEvmbenchCatalogBytes(fs.readFileSync(path.join(benchmarkRoot, "audit-catalog.json")));
    const lock = parseEvmbenchLockBytes(fs.readFileSync(path.join(benchmarkRoot, "benchmark.lock.json")));
    const smoke = parseEvmbenchProfileBytes(fs.readFileSync(path.join(benchmarkRoot, "profiles", "smoke.json")));
    const full = parseEvmbenchProfileBytes(fs.readFileSync(path.join(benchmarkRoot, "profiles", "full.json")));

    expect(parseEvmbenchCatalogBytes(serializeEvmbenchCatalog(catalog))).toEqual(catalog);
    expect(parseEvmbenchLockBytes(serializeEvmbenchLock(lock))).toEqual(lock);
    expect(parseEvmbenchProfileBytes(serializeEvmbenchProfile(smoke))).toEqual(smoke);
    expect(parseEvmbenchProfileBytes(serializeEvmbenchProfile(full))).toEqual(full);
  });

  it.each([
    {
      label: "profile extra property",
      schemaId: EVMBENCH_PROFILE_JSON_SCHEMA_ID,
      parser: evmbenchProfileSchema,
      value: { ...validProfile(), compatibility_model: "legacy" }
    },
    {
      label: "legacy lock version",
      schemaId: EVMBENCH_LOCK_JSON_SCHEMA_ID,
      parser: evmbenchLockSchema,
      value: { ...validLock(), schema_version: "ultrafuzz.evmbench.lock.v1" }
    },
    {
      label: "structurally duplicated lock split item",
      schemaId: EVMBENCH_LOCK_JSON_SCHEMA_ID,
      parser: evmbenchLockSchema,
      value: {
        ...validLock(),
        splits: { debug: ["synthetic-audit", "synthetic-audit"], "detect-tasks": ["synthetic-audit"] }
      }
    },
    {
      label: "untyped catalog field",
      schemaId: EVMBENCH_CATALOG_JSON_SCHEMA_ID,
      parser: evmbenchCatalogSchema,
      value: {
        ...validCatalog(),
        audits: [{ ...validCatalog().audits[0], framework: { legacy: "foundry" } }]
      }
    },
    {
      label: "out-of-contract catalog repository",
      schemaId: EVMBENCH_CATALOG_JSON_SCHEMA_ID,
      parser: evmbenchCatalogSchema,
      value: {
        ...validCatalog(),
        audits: [
          {
            ...validCatalog().audits[0],
            repository: "https://github.com/evmbench-org/nested/synthetic-audit.git"
          }
        ]
      }
    },
    {
      label: "structurally duplicated catalog item",
      schemaId: EVMBENCH_CATALOG_JSON_SCHEMA_ID,
      parser: evmbenchCatalogSchema,
      value: { ...validCatalog(), audits: [validCatalog().audits[0], validCatalog().audits[0]] }
    },
    {
      label: "generic per-audit object",
      schemaId: EVMBENCH_RESULT_JSON_SCHEMA_ID,
      parser: normalizedEvmbenchResultSchema,
      value: {
        ...validResult(),
        official_evmbench: { ...validResult().official_evmbench, per_audit: { "synthetic-audit": {} } }
      }
    },
    {
      label: "legacy arbitrary metrics",
      schemaId: EVMBENCH_RESULT_JSON_SCHEMA_ID,
      parser: normalizedEvmbenchResultSchema,
      value: { ...validResult(), ultrafuzz_metrics: { precision: 1 } }
    },
    {
      label: "structurally duplicated result target",
      schemaId: EVMBENCH_RESULT_JSON_SCHEMA_ID,
      parser: normalizedEvmbenchResultSchema,
      value: {
        ...validResult(),
        provenance: {
          ...validResult().provenance,
          targets: [validResult().provenance.targets[0], validResult().provenance.targets[0]]
        }
      }
    },
    {
      label: "invalid overlay provenance",
      schemaId: EVMBENCH_RESULT_JSON_SCHEMA_ID,
      parser: normalizedEvmbenchResultSchema,
      value: {
        ...validResult(),
        provenance: {
          ...validResult().provenance,
          audit_images: [{ ...validResult().provenance.audit_images[0], overlay_image_digest: null }]
        }
      }
    },
    {
      label: "inconsistent completeness",
      schemaId: EVMBENCH_RESULT_JSON_SCHEMA_ID,
      parser: normalizedEvmbenchResultSchema,
      value: {
        ...validResult(),
        operational: {
          ...validResult().operational,
          runtime_seconds: null,
          completeness: { ...validResult().operational.completeness, runtime: "complete" }
        }
      }
    },
    {
      label: "unsafe normalized result run count",
      schemaId: EVMBENCH_RESULT_JSON_SCHEMA_ID,
      parser: normalizedEvmbenchResultSchema,
      value: {
        ...validResult(),
        official_evmbench: {
          ...validResult().official_evmbench,
          per_audit: {
            "synthetic-audit": {
              ...validResult().official_evmbench.per_audit["synthetic-audit"],
              n_runs: Number.MAX_SAFE_INTEGER + 1
            }
          }
        }
      }
    },
    {
      label: "unsafe normalized result token count",
      schemaId: EVMBENCH_RESULT_JSON_SCHEMA_ID,
      parser: normalizedEvmbenchResultSchema,
      value: {
        ...validResult(),
        operational: {
          ...validResult().operational,
          token_usage: Number.MAX_SAFE_INTEGER + 1,
          completeness: { ...validResult().operational.completeness, token_usage: "complete" as const }
        }
      }
    },
    {
      label: "NanoEval final report with an empty per-audit map",
      schemaId: NANOEVAL_FINAL_REPORT_JSON_SCHEMA_ID,
      parser: nanoevalFinalReportSchema,
      value: {
        ...validNanoevalFinalReport(),
        metrics: { ...validNanoevalFinalReport().metrics, per_audit: {} }
      }
    },
    {
      label: "NanoEval final report with an unsafe integer",
      schemaId: NANOEVAL_FINAL_REPORT_JSON_SCHEMA_ID,
      parser: nanoevalFinalReportSchema,
      value: {
        ...validNanoevalFinalReport(),
        params: { ...validNanoevalFinalReport().params, n_samples: Number.MAX_SAFE_INTEGER + 1 }
      }
    },
    {
      label: "open NanoEval recorder envelope",
      schemaId: NANOEVAL_RECORD_JSON_SCHEMA_ID,
      parser: nanoevalRecordSchema,
      value: { ...validNanoevalRecord(), compatibility_payload: {} }
    }
  ])("rejects $label structurally in JSON Schema and Zod", ({ schemaId, parser, value }) => {
    expect(validateEvmbenchJsonSchema(schemaId, value).ok).toBe(false);
    expect(parser.safeParse(value).success).toBe(false);
  });

  it.each([
    {
      label: "profile timeout order",
      schemaId: EVMBENCH_PROFILE_JSON_SCHEMA_ID,
      parser: evmbenchProfileSchema,
      parseBytes: parseEvmbenchProfileBytes,
      gate: "node timeout does not exceed workflow timeout",
      value: { ...validProfile(), workflow_timeout_seconds: 60, node_timeout_seconds: 61 }
    },
    {
      label: "catalog projected audit identity",
      schemaId: EVMBENCH_CATALOG_JSON_SCHEMA_ID,
      parser: evmbenchCatalogSchema,
      parseBytes: parseEvmbenchCatalogBytes,
      gate: "audit IDs are unique",
      value: {
        ...validCatalog(),
        audits: [
          validCatalog().audits[0],
          {
            ...validCatalog().audits[0],
            target_commit: "d".repeat(40)
          }
        ]
      }
    },
    {
      label: "lock split subset",
      schemaId: EVMBENCH_LOCK_JSON_SCHEMA_ID,
      parser: evmbenchLockSchema,
      parseBytes: parseEvmbenchLockBytes,
      gate: "debug is a subset of detect-tasks",
      value: { ...validLock(), splits: { debug: ["debug-only"], "detect-tasks": ["synthetic-audit"] } }
    },
    {
      label: "result aggregate",
      schemaId: EVMBENCH_RESULT_JSON_SCHEMA_ID,
      parser: normalizedEvmbenchResultSchema,
      parseBytes: parseNormalizedEvmbenchResultBytes,
      gate: "official totals equal the per-audit aggregates",
      value: {
        ...validResult(),
        official_evmbench: { ...validResult().official_evmbench, score: 2, recall: 0.5 }
      }
    },
    {
      label: "result projected target identity",
      schemaId: EVMBENCH_RESULT_JSON_SCHEMA_ID,
      parser: normalizedEvmbenchResultSchema,
      parseBytes: parseNormalizedEvmbenchResultBytes,
      gate: "target, image, and per-audit identities agree",
      value: {
        ...validResult(),
        provenance: {
          ...validResult().provenance,
          targets: [
            validResult().provenance.targets[0],
            { ...validResult().provenance.targets[0], source_commit: "f".repeat(40) }
          ]
        }
      }
    }
  ])(
    "keeps $label out of both shape validators and rejects it in its registered gate",
    ({ schemaId, parser, parseBytes, gate, value }) => {
      expect(validateEvmbenchJsonSchema(schemaId, value).ok).toBe(true);
      const retained = parser.safeParse(value);
      expect(retained.success).toBe(true);
      if (retained.success) expect(retained.data).toEqual(value);
      expect(() => parseBytes(Buffer.from(JSON.stringify(value)))).toThrow(gate);
    }
  );

  it("round-trips the normalized v2 result from exact validated bytes", () => {
    const value = normalizedEvmbenchResultSchema.parse(validResult());
    const bytes = serializeNormalizedEvmbenchResult(value);
    expect(parseNormalizedEvmbenchResultBytes(bytes)).toEqual(value);
    expect(bytes.at(-1)).toBe(0x0a);
  });

  it("validates the exact registered CLI consumer contract without a parallel Zod authority", () => {
    const data = { project_root: "/tmp/project", created: [], preserved: [], overwritten: [] };
    const envelope = {
      schema_version: "ultrafuzz.cli.result.v2",
      command: "init",
      ok: true,
      diagnostics: [],
      data
    };

    expect(validateEvmbenchJsonSchema(EVMBENCH_CLI_RESULT_JSON_SCHEMA_ID, envelope)).toMatchObject({ ok: true });
    expect(parseEvmbenchCliResult("init", envelope)).toBe(data);
    expect(() => parseEvmbenchCliResult("run", envelope)).toThrow(EVMBENCH_CLI_EXPECTED_COMMAND_CONTEXT_GATE);
    expect(
      validateEvmbenchJsonSchema(EVMBENCH_CLI_RESULT_JSON_SCHEMA_ID, {
        ...envelope,
        data: { ...data, compatibility_payload: {} }
      })
    ).toMatchObject({ ok: false });
  });

  it("validates pinned NanoEval documents Ajv-first while preserving the retained Zod value", () => {
    const report = validNanoevalFinalReport();
    const record = validNanoevalRecord({
      record_type: "extra",
      data: { opaque: [null, true, 1, "third-party", { nested: false }] }
    });

    expect(parseNanoevalFinalReport(report)).toEqual(report);
    expect(parseNanoevalRecord(record)).toEqual(record);
    expect(validateEvmbenchJsonSchema(NANOEVAL_FINAL_REPORT_JSON_SCHEMA_ID, report)).toMatchObject({ ok: true });
    expect(validateEvmbenchJsonSchema(NANOEVAL_RECORD_JSON_SCHEMA_ID, record)).toMatchObject({ ok: true });
  });

  it("keeps every pinned NanoEval recorder variant closed and aligned in Ajv and Zod", () => {
    const rows = [
      validNanoevalRecord({
        record_type: "run_started",
        sample_id: null,
        group_id: null,
        run_spec: { run_id: "260809000000AAAA", run_set_id: "synthetic-run-set" }
      }),
      validNanoevalRecord(),
      validNanoevalRecord({
        record_type: "match",
        correct: true,
        expected: null,
        picked: null,
        prob_correct: null
      }),
      validNanoevalRecord({ record_type: "extra", data: { opaque: [null, true, 1, "text"] } }),
      validNanoevalRecord({ record_type: "sample_completed", status: "completed" }),
      validNanoevalRecord({ record_type: "error", message: "rollout failed", error: null }),
      validNanoevalRecord({
        record_type: "final_report",
        sample_id: null,
        group_id: null,
        final_report: validNanoevalFinalReport()
      })
    ];

    for (const row of rows) {
      expect(validateEvmbenchJsonSchema(NANOEVAL_RECORD_JSON_SCHEMA_ID, row)).toMatchObject({ ok: true });
      const retained = nanoevalRecordSchema.safeParse(row);
      expect(retained.success).toBe(true);
      if (retained.success) expect(retained.data).toEqual(row);

      const open = { ...row, compatibility_payload: {} };
      expect(validateEvmbenchJsonSchema(NANOEVAL_RECORD_JSON_SCHEMA_ID, open)).toMatchObject({ ok: false });
      expect(nanoevalRecordSchema.safeParse(open).success).toBe(false);
    }
  });

  it("runs registered NanoEval final-report gates for nested JSONL records", () => {
    const record = validNanoevalRecord({
      record_type: "final_report",
      sample_id: null,
      group_id: null,
      final_report: {
        ...validNanoevalFinalReport(),
        run_health: { n_rollouts_failed: 2 }
      }
    });

    expect(validateEvmbenchJsonSchema(NANOEVAL_RECORD_JSON_SCHEMA_ID, record)).toMatchObject({ ok: true });
    expect(nanoevalRecordSchema.safeParse(record).success).toBe(true);
    expect(() => parseNanoevalRecord(record)).toThrow("NanoEval failed rollout count does not exceed sample count");
  });

  it.each([
    {
      gate: "NanoEval scores do not exceed their maxima",
      value: {
        ...validNanoevalFinalReport(),
        metrics: { ...validNanoevalFinalReport().metrics, score: 5, score_percentage: 100 }
      }
    },
    {
      gate: "NanoEval totals and percentages equal per-audit aggregates",
      value: {
        ...validNanoevalFinalReport(),
        metrics: { ...validNanoevalFinalReport().metrics, score: 2, score_percentage: 50 }
      }
    },
    {
      gate: "NanoEval failed rollout count does not exceed sample count",
      value: { ...validNanoevalFinalReport(), run_health: { n_rollouts_failed: 2 } }
    }
  ])("keeps $gate out of both NanoEval shape authorities and rejects it in its named gate", ({ gate, value }) => {
    expect(validateEvmbenchJsonSchema(NANOEVAL_FINAL_REPORT_JSON_SCHEMA_ID, value)).toMatchObject({ ok: true });
    const retained = nanoevalFinalReportSchema.safeParse(value);
    expect(retained.success).toBe(true);
    if (retained.success) expect(retained.data).toEqual(value);
    expect(() => parseNanoevalFinalReport(value)).toThrow(gate);
  });
});

function validProfile() {
  return {
    schema_version: "ultrafuzz.evmbench.profile.v2" as const,
    id: "smoke" as const,
    max_concurrency: 2,
    poll_interval_seconds: 15,
    workflow_timeout_seconds: 7200,
    node_timeout_seconds: 900,
    model: "synthetic-model",
    reasoning: "high"
  };
}

function validCatalog() {
  return {
    schema_version: "ultrafuzz.evmbench.catalog.v2" as const,
    audits: [
      {
        id: "synthetic-audit",
        repository: "https://github.com/evmbench-org/synthetic-audit.git",
        framework: "foundry",
        target_commit: "a".repeat(40),
        audit_context_sha256: `sha256:${"b".repeat(64)}`,
        ground_truth_manifest_sha256: `sha256:${"c".repeat(64)}`
      }
    ]
  };
}

function validLock() {
  return {
    schema_version: "ultrafuzz.evmbench.lock.v2" as const,
    evmbench: {
      repository: "https://github.com/paradigmxyz/evmbench.git" as const,
      commit: "a".repeat(40)
    },
    frontier_evals: {
      repository: "https://github.com/openai/frontier-evals.git" as const,
      commit: "b".repeat(40)
    },
    selected_split: "detect-tasks" as const,
    splits: { debug: ["synthetic-audit"], "detect-tasks": ["synthetic-audit"] },
    catalog: { path: "audit-catalog.json" as const, sha256: `sha256:${"c".repeat(64)}` }
  };
}

function validResult() {
  return {
    schema_version: "ultrafuzz.evmbench.result.v2" as const,
    official_evmbench: {
      score: 3,
      max_score: 4,
      recall: 0.75,
      detect_award: 7.5,
      detect_max_award: 10,
      per_audit: {
        "synthetic-audit": {
          score: 3,
          max_score: 4,
          n_runs: 1,
          detect_award: 7.5,
          detect_max_award: 10
        }
      }
    },
    provenance: {
      benchmark_identity: `sha256:${"0".repeat(64)}`,
      ultrafuzz_commit: "a".repeat(40),
      ultrafuzz_dirty: false,
      evmbench_commit: "b".repeat(40),
      frontier_evals_commit: "c".repeat(40),
      targets: [{ audit_id: "synthetic-audit", source_commit: "d".repeat(40) }],
      audit_images: [
        {
          audit_id: "synthetic-audit",
          source_image_digest: `sha256:${"e".repeat(64)}`,
          overlay_image_digest: `sha256:${"f".repeat(64)}`
        }
      ],
      profile: "smoke" as const,
      profile_fingerprint: `sha256:${"1".repeat(64)}`,
      topology_fingerprint: `sha256:${"2".repeat(64)}`,
      model: "synthetic-model",
      agent: "ultrafuzz" as const,
      reasoning: "high",
      concurrency: 2
    },
    operational: {
      runtime_seconds: 12,
      token_usage: null,
      cost_usd: null,
      completeness: { runtime: "complete" as const, token_usage: "unavailable" as const, cost: "unavailable" as const }
    }
  };
}

function validNanoevalFinalReport() {
  return {
    params: {
      audit_split: "synthetic-audit",
      mode: "detect" as const,
      n_tries: 1,
      n_samples: 1,
      agent: "ultrafuzz" as const
    },
    run_health: { n_rollouts_failed: 0 },
    metrics: {
      score: 3,
      max_score: 4,
      score_percentage: 75,
      per_audit: {
        "synthetic-audit": {
          score: 3,
          max_score: 4,
          n_runs: 1,
          detect_award: 7.5,
          detect_max_award: 10
        }
      },
      detect_award: 7.5,
      detect_max_award: 10,
      detect_score_percentage: 75
    },
    run_group_id: "synthetic-run-group"
  };
}

function validNanoevalRecord(
  fields: Record<string, unknown> = {
    record_type: "sampling",
    prompt: "audit this target",
    sampled: "sample"
  }
): Record<string, unknown> {
  return {
    timestamp: "2026-08-09T00:00:00.000+00:00",
    sample_id: "synthetic-audit",
    group_id: "0.0",
    ...fields
  };
}
