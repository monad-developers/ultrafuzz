import { describe, expect, it } from "vitest";

import {
  MODAL_EXECUTION_DEPENDENCY_MANIFEST_SCHEMA_ID,
  MODAL_SMOKE_RESULT_SCHEMA_ID,
  MODAL_WORKER_RESULT_SCHEMA_ID,
  type ModalContractSchemaId,
  type StrictModalExecutionDependencyManifestDocument,
  type StrictModalSmokeResultDocument,
  type StrictModalWorkerResultDocument
} from "../src/modal-contracts.js";
import { ModalDocumentValidationError, parseModalDocumentBytes } from "../src/modal-documents.js";
import { MODAL_SCHEMA_METADATA, modalSchemaRegistry } from "../src/modal-schema-registry.js";
import { IMPLEMENTED_MODAL_SEMANTIC_GATES, MODAL_SEMANTIC_GATES_BY_SCHEMA_ID } from "../src/modal-semantic-gates.js";

function bytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function workerResult(): StrictModalWorkerResultDocument {
  return {
    schema_version: "ultrafuzz.modal.worker-result.v2",
    result_type: "terminal",
    generation: 1,
    launch_generation: 1,
    attempt: 1,
    model_work_started: true,
    counts: { succeeded: 1, failed: 0, remaining: 0 },
    checkpoint: { age_ms: 0, digest: `sha256:${"a".repeat(64)}` },
    exit_category: "capacity-unavailable",
    runtime_ms: 1,
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      cache_read_tokens: 3,
      cache_write_tokens: 2,
      reasoning_tokens: 5,
      total_tokens: 28,
      estimated_cost_usd: 0.125,
      partial_pricing: false,
      event_count: 1,
      priced_event_count: 1,
      unpriced_event_count: 0
    },
    pricing: {
      source: "configured-catalog",
      status: "available",
      fetched_at: "2026-08-09T00:00:00.000Z",
      resolved_model_count: 1,
      unresolved_model_count: 0
    },
    diagnostic_code: "capacity-unavailable"
  };
}

function smokeResult(): StrictModalSmokeResultDocument {
  return {
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
  };
}

function dependencyManifest(): StrictModalExecutionDependencyManifestDocument {
  const moduleA = {
    id: "module:@ultrafuzz/a",
    name: "@ultrafuzz/a",
    snapshot_path: "modules/@ultrafuzz/a"
  };
  const moduleB = {
    id: "module:@ultrafuzz/b",
    name: "@ultrafuzz/b",
    snapshot_path: "modules/@ultrafuzz/b"
  };
  return {
    schema_version: "ultrafuzz.workflow-execution-dependencies.v1",
    modules: [moduleA, moduleB],
    packages: [],
    issuers: [
      { id: moduleA.id, snapshot_path: moduleA.snapshot_path, dependencies: {} },
      { id: moduleB.id, snapshot_path: moduleB.snapshot_path, dependencies: {} },
      {
        id: "root",
        snapshot_path: ".",
        dependencies: { "@ultrafuzz/a": moduleA.id, "@ultrafuzz/b": moduleB.id }
      }
    ],
    executable_paths: ["bin/helper", "bin/smithers"],
    smithers_bin: "bin/smithers"
  };
}

describe("Modal semantic gate parity", () => {
  it("uses the dispatch table as registry metadata and declares every implemented gate", () => {
    const registry = modalSchemaRegistry();
    for (const entry of registry) {
      if (entry.role === "subschema") continue;
      const expected = MODAL_SEMANTIC_GATES_BY_SCHEMA_ID[entry.id as ModalContractSchemaId];
      expect(entry.semanticGates).toEqual(expected);
      expect(MODAL_SCHEMA_METADATA[entry.filename]?.semanticGates).toEqual(expected);
    }
    expect(new Set(Object.values(MODAL_SEMANTIC_GATES_BY_SCHEMA_ID).flat())).toEqual(
      new Set(IMPLEMENTED_MODAL_SEMANTIC_GATES)
    );
  });

  it("rejects contradictory worker accounting, diagnostic, and pricing state", () => {
    const invalid: StrictModalWorkerResultDocument[] = [
      { ...workerResult(), usage: { ...workerResult().usage!, total_tokens: 27 } },
      { ...workerResult(), usage: { ...workerResult().usage!, event_count: 0 } },
      { ...workerResult(), diagnostic_code: "authentication-failure" },
      { ...workerResult(), usage: null },
      {
        ...workerResult(),
        pricing: { ...workerResult().pricing!, source: "disabled", status: "available" }
      },
      {
        ...workerResult(),
        pricing: { ...workerResult().pricing!, unresolved_model_count: 1 }
      },
      {
        ...workerResult(),
        pricing: { ...workerResult().pricing!, status: "unavailable", unresolved_model_count: 0 }
      }
    ];

    for (const value of invalid) {
      expect(() => parseModalDocumentBytes(MODAL_WORKER_RESULT_SCHEMA_ID, bytes(value))).toThrow(
        ModalDocumentValidationError
      );
    }
  });

  it("binds smoke check booleans to their diagnostic counts", () => {
    expect(() =>
      parseModalDocumentBytes(
        MODAL_SMOKE_RESULT_SCHEMA_ID,
        bytes({ ...smokeResult(), diagnostics: { ...smokeResult().diagnostics, completed_units: 0 } })
      )
    ).toThrow(ModalDocumentValidationError);
    expect(() =>
      parseModalDocumentBytes(
        MODAL_SMOKE_RESULT_SCHEMA_ID,
        bytes({ ...smokeResult(), diagnostics: { ...smokeResult().diagnostics, repeated_units: 1 } })
      )
    ).toThrow(ModalDocumentValidationError);
    expect(() =>
      parseModalDocumentBytes(
        MODAL_SMOKE_RESULT_SCHEMA_ID,
        bytes({ ...smokeResult(), diagnostics: { ...smokeResult().diagnostics, launch_owners: 2 } })
      )
    ).toThrow(ModalDocumentValidationError);
    expect(() =>
      parseModalDocumentBytes(
        MODAL_SMOKE_RESULT_SCHEMA_ID,
        bytes({
          ...smokeResult(),
          status: "failed",
          checks: { ...smokeResult().checks, production_image: false },
          diagnostics: {
            ...smokeResult().diagnostics,
            failure_code: "cloud-operation-failed",
            failure_stage: "prepare"
          }
        })
      )
    ).toThrow(ModalDocumentValidationError);
  });

  it("requires canonical dependency target, issuer-edge, and executable ordering", () => {
    const base = dependencyManifest();
    const unorderedModules = { ...base, modules: [...base.modules].reverse() };
    const unorderedExecutables = { ...base, executable_paths: [...base.executable_paths].reverse() };
    const root = base.issuers.at(-1)!;
    const unorderedEdges = {
      ...base,
      issuers: [
        ...base.issuers.slice(0, -1),
        {
          ...root,
          dependencies: {
            "@ultrafuzz/b": root.dependencies["@ultrafuzz/b"]!,
            "@ultrafuzz/a": root.dependencies["@ultrafuzz/a"]!
          }
        }
      ]
    };

    for (const value of [unorderedModules, unorderedExecutables, unorderedEdges]) {
      expect(() => parseModalDocumentBytes(MODAL_EXECUTION_DEPENDENCY_MANIFEST_SCHEMA_ID, bytes(value))).toThrow(
        ModalDocumentValidationError
      );
    }
  });
});
