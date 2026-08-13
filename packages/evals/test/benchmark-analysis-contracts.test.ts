import { describe, expect, it } from "vitest";

import {
  assertBenchmarkAnalysisSources,
  benchmarkAnalysisSourceIssues,
  parseAdjudicationHandoff,
  parseBenchmarkAnalysisManifest,
  parseBenchmarkFindingManifest,
  parseBenchmarkGroundTruthCredits,
  parseBenchmarkInstanceClusters,
  parseBenchmarkProvenance,
  parseBenchmarkSourceManifest,
  type AdjudicationHandoff,
  type BenchmarkAnalysisManifest,
  type BenchmarkFindingManifest,
  type BenchmarkGroundTruthCredits,
  type BenchmarkInstanceClusters,
  type BenchmarkProvenance,
  type BenchmarkSourceManifest
} from "../src/benchmark-analysis-contracts.js";
import {
  EVAL_ADJUDICATION_HANDOFF_SCHEMA_ID,
  EVAL_BENCHMARK_ANALYSIS_MANIFEST_SCHEMA_ID,
  EVAL_BENCHMARK_PROVENANCE_SCHEMA_ID,
  EVAL_BENCHMARK_SOURCE_MANIFEST_SCHEMA_ID,
  EVAL_FINDING_MANIFEST_SCHEMA_ID,
  EVAL_GROUND_TRUTH_CREDITS_SCHEMA_ID,
  EVAL_INSTANCE_CLUSTERS_SCHEMA_ID,
  validateEvalJsonSchema
} from "../src/eval-schema-registry.js";
import { executeEvalSchemaSemanticGates } from "../src/eval-semantic-gates.js";

function canonicalDocuments(): {
  handoff: AdjudicationHandoff;
  manifest: BenchmarkFindingManifest;
  instances: BenchmarkInstanceClusters;
  credits: BenchmarkGroundTruthCredits;
  provenance: BenchmarkProvenance;
  sourceManifest: BenchmarkSourceManifest;
  analysisManifest: BenchmarkAnalysisManifest;
} {
  return {
    handoff: {
      schema_version: "ultrafuzz.eval.adjudication-handoff.v1",
      provenance: { outputPath: "adjudication/root-cause-final/output" }
    },
    manifest: {
      schema_version: "ultrafuzz.eval.finding-manifest.v1",
      rows: [
        {
          rowId: "d1",
          label: "Default trial 1",
          condition: "Ultrafuzz",
          order: 0,
          variant: "default",
          rowArchivePath: "rows/default/d1/row-artifacts.tar.gz",
          runMetadataPath: "synthetic/.ultrafuzz/runs/run-d1/run.json",
          runId: "run-d1",
          findingCount: 1
        }
      ],
      candidateCatalog: [
        {
          candidateId: "candidate-alpha",
          label: "H-01",
          title: "Synthetic cause alpha",
          source: "canonical-ground-truth"
        }
      ],
      findingInstances: [
        {
          rowId: "d1",
          issueIndex: 0,
          findingId: "H-01",
          findingInstanceId: "d1:issue-a",
          stableIssueId: "issue-a",
          title: "Synthetic invariant alpha",
          severity: "High",
          sourceArtifactRefs: [{ nodeId: "synthetic-strategy" }]
        }
      ]
    },
    instances: {
      schema_version: "ultrafuzz.eval.instance-clusters.v1",
      instances: [
        {
          rowId: "d1",
          issueIndex: 0,
          findingInstanceId: "d1:issue-a",
          stableIssueId: "issue-a",
          rootCauseClusterId: "cluster-alpha",
          instanceClassification: "true-positive",
          matchedCandidateId: "candidate-alpha",
          matchedSource: "canonical-ground-truth",
          duplicateOfFindingInstanceId: null
        }
      ]
    },
    credits: {
      schema_version: "ultrafuzz.eval.ground-truth-credits.v1",
      clusters: [{ rootCauseClusterId: "cluster-alpha", groundTruthTpCredits: 1 }]
    },
    provenance: {
      schema_version: "ultrafuzz.eval.benchmark-provenance.v1",
      privacy: "private-analysis-output-do-not-commit",
      rows_are_sets: true,
      finding_instances: [
        {
          row_id: "d1",
          condition: "Ultrafuzz",
          finding_id: "H-01",
          qualified_id: "d1:H-01",
          finding_instance_id: "d1:issue-a",
          root_cause_cluster_id: "cluster-alpha",
          severity: "H",
          title: "Synthetic invariant alpha",
          source_strategies: ["synthetic-strategy"],
          classification: "true-positive",
          matched_source: "canonical-ground-truth",
          matched_candidate_id: "candidate-alpha",
          matched_identity: "candidate-alpha",
          ground_truth_label: "H-01",
          ground_truth_title: "Synthetic cause alpha",
          ground_truth_tp_credits: 1,
          stable_issue_id: "issue-a",
          duplicate_of_finding_instance_id: null
        }
      ],
      root_cause_entities: [
        {
          root_cause_cluster_id: "cluster-alpha",
          top_severity: "H",
          classification: "true-positive",
          ground_truth_tp_credits: 1,
          rows: ["d1"],
          row_count: 1,
          detection_count: 1,
          qualified_findings: ["d1:H-01"]
        }
      ],
      row_statuses: [{ rowId: "d1", condition: "Ultrafuzz", valid: true, status: "valid", reason: null }]
    },
    sourceManifest: {
      schema_version: "ultrafuzz.eval.benchmark-source-manifest.v1",
      privacy: "private-analysis-output-do-not-commit",
      source_archive: "synthetic-handoff.zip",
      source_size_bytes: 1024,
      source_sha256: "a".repeat(64),
      archive_root: "synthetic-bundle/",
      handoff_schema_version: "ultrafuzz.eval.adjudication-handoff.v1",
      adjudication_output_path: "adjudication/root-cause-final/output",
      rows: [{ row_id: "d1", row_label: "Default trial 1", condition: "Ultrafuzz", variant: "default", order: 0 }],
      ground_truth_count: 1
    },
    analysisManifest: {
      schema_version: "ultrafuzz.eval.benchmark-analysis-manifest.v1",
      privacy: "private-analysis-output-do-not-commit",
      command: "all",
      source_archive: "synthetic-handoff.zip",
      source_sha256: "a".repeat(64),
      handoff_schema_version: "ultrafuzz.eval.adjudication-handoff.v1",
      artifacts: [{ path: "provenance.json", size_bytes: 1024, sha256: "b".repeat(64) }]
    }
  };
}

describe("benchmark analysis contracts", () => {
  it("accepts the current closed contract for every source and output document", () => {
    const documents = canonicalDocuments();
    const cases: Array<[string, unknown]> = [
      [EVAL_ADJUDICATION_HANDOFF_SCHEMA_ID, documents.handoff],
      [EVAL_FINDING_MANIFEST_SCHEMA_ID, documents.manifest],
      [EVAL_INSTANCE_CLUSTERS_SCHEMA_ID, documents.instances],
      [EVAL_GROUND_TRUTH_CREDITS_SCHEMA_ID, documents.credits],
      [EVAL_BENCHMARK_PROVENANCE_SCHEMA_ID, documents.provenance],
      [EVAL_BENCHMARK_SOURCE_MANIFEST_SCHEMA_ID, documents.sourceManifest],
      [EVAL_BENCHMARK_ANALYSIS_MANIFEST_SCHEMA_ID, documents.analysisManifest]
    ];
    for (const [schemaId, value] of cases) {
      expect(validateEvalJsonSchema(schemaId, value), schemaId).toMatchObject({ ok: true, issues: [] });
      expect(executeEvalSchemaSemanticGates(schemaId, value), schemaId).toEqual([]);
    }

    expect(parseAdjudicationHandoff(documents.handoff)).toEqual(documents.handoff);
    expect(parseBenchmarkFindingManifest(documents.manifest)).toEqual(documents.manifest);
    expect(parseBenchmarkInstanceClusters(documents.instances)).toEqual(documents.instances);
    expect(parseBenchmarkGroundTruthCredits(documents.credits)).toEqual(documents.credits);
    expect(parseBenchmarkProvenance(documents.provenance)).toEqual(documents.provenance);
    expect(parseBenchmarkSourceManifest(documents.sourceManifest)).toEqual(documents.sourceManifest);
    expect(parseBenchmarkAnalysisManifest(documents.analysisManifest)).toEqual(documents.analysisManifest);
    expect(() =>
      assertBenchmarkAnalysisSources({
        manifest: documents.manifest,
        instanceClusters: documents.instances,
        credits: documents.credits
      })
    ).not.toThrow();
  });

  it("executes each benchmark semantic gate against a schema-valid negative fixture", () => {
    const documents = canonicalDocuments();
    const secondRow = {
      ...documents.manifest.rows[0]!,
      rowId: "d2",
      label: "Default trial 2",
      rowArchivePath: "rows/default/d2/row-artifacts.tar.gz",
      runMetadataPath: "synthetic/.ultrafuzz/runs/run-d2/run.json",
      runId: "run-d2",
      findingCount: 0
    };
    const duplicateInstance = {
      ...documents.instances.instances[0]!,
      rowId: "d2",
      issueIndex: 1,
      findingInstanceId: "d2:issue-b",
      stableIssueId: "issue-b",
      duplicateOfFindingInstanceId: "d1:issue-a"
    };
    const cases: Array<[string, unknown, string]> = [
      [
        EVAL_ADJUDICATION_HANDOFF_SCHEMA_ID,
        { ...documents.handoff, provenance: { outputPath: "adjudication/./output" } },
        "eval-adjudication-handoff-canonical-path"
      ],
      [
        EVAL_FINDING_MANIFEST_SCHEMA_ID,
        { ...documents.manifest, rows: [...documents.manifest.rows, secondRow] },
        "eval-finding-manifest-identity-joins"
      ],
      [
        EVAL_INSTANCE_CLUSTERS_SCHEMA_ID,
        { ...documents.instances, instances: [...documents.instances.instances, duplicateInstance] },
        "eval-instance-clusters-identity-joins"
      ],
      [
        EVAL_GROUND_TRUTH_CREDITS_SCHEMA_ID,
        {
          ...documents.credits,
          clusters: [...documents.credits.clusters, { rootCauseClusterId: "cluster-alpha", groundTruthTpCredits: 0 }]
        },
        "eval-ground-truth-credits-identity-joins"
      ],
      [
        EVAL_BENCHMARK_PROVENANCE_SCHEMA_ID,
        {
          ...documents.provenance,
          root_cause_entities: [{ ...documents.provenance.root_cause_entities[0]!, detection_count: 2 }]
        },
        "eval-benchmark-provenance-identity-joins"
      ],
      [
        EVAL_BENCHMARK_SOURCE_MANIFEST_SCHEMA_ID,
        {
          ...documents.sourceManifest,
          rows: [
            ...documents.sourceManifest.rows,
            {
              ...documents.sourceManifest.rows[0]!,
              row_id: "d2",
              row_label: "Default trial 2"
            }
          ]
        },
        "eval-benchmark-source-manifest-identity-joins"
      ],
      [
        EVAL_BENCHMARK_ANALYSIS_MANIFEST_SCHEMA_ID,
        {
          ...documents.analysisManifest,
          artifacts: [
            ...documents.analysisManifest.artifacts,
            { path: "provenance.json", size_bytes: 2048, sha256: "c".repeat(64) }
          ]
        },
        "eval-benchmark-analysis-manifest-identity-joins"
      ]
    ];
    for (const [schemaId, value, gate] of cases) {
      expect(validateEvalJsonSchema(schemaId, value), gate).toMatchObject({ ok: true, issues: [] });
      expect(
        executeEvalSchemaSemanticGates(schemaId, value).map((item) => item.gate),
        gate
      ).toContain(gate);
    }
  });

  it("rejects cross-document source drift without repairing it", () => {
    const documents = canonicalDocuments();
    const instances: BenchmarkInstanceClusters = {
      ...documents.instances,
      instances: [{ ...documents.instances.instances[0]!, stableIssueId: "different-stable-id" }]
    };
    expect(
      benchmarkAnalysisSourceIssues({
        manifest: documents.manifest,
        instanceClusters: instances,
        credits: documents.credits
      })
    ).toContainEqual(
      expect.objectContaining({
        gate: "eval-benchmark-analysis-source-joins",
        path: expect.stringContaining("stableIssueId")
      })
    );
  });

  it("rejects duplicate-reference cycles", () => {
    const documents = canonicalDocuments();
    const first = {
      ...documents.instances.instances[0]!,
      duplicateOfFindingInstanceId: "d1:issue-b"
    };
    const second = {
      ...documents.instances.instances[0]!,
      issueIndex: 1,
      findingInstanceId: "d1:issue-b",
      stableIssueId: "issue-b",
      duplicateOfFindingInstanceId: "d1:issue-a"
    };
    const value: BenchmarkInstanceClusters = { ...documents.instances, instances: [first, second] };
    expect(validateEvalJsonSchema(EVAL_INSTANCE_CLUSTERS_SCHEMA_ID, value)).toMatchObject({ ok: true, issues: [] });
    expect(executeEvalSchemaSemanticGates(EVAL_INSTANCE_CLUSTERS_SCHEMA_ID, value)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gate: "eval-instance-clusters-identity-joins",
          message: "duplicate references must not contain a cycle"
        })
      ])
    );
  });
});
