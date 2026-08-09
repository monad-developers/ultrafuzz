import { describe, expect, it } from "vitest";

import { graphFromPlannedGraph } from "../src/reporter.js";
import { BraintrustReporter } from "../src/reporters/braintrust.js";
import { boundedResponseText } from "../src/reporters/http.js";
import {
  EVAL_PROVIDER_NONE,
  createEvalReporters,
  resolveEvalProvider,
  resolveEvalSuitePath
} from "../src/reporters/index.js";
import { EvalError } from "../src/utils.js";
import type { EvalRunProvenance, EvalScoreSummary } from "../src/types.js";
import {
  cleanRecoveryEquivalence,
  currentPlannedGraph,
  currentRowScore,
  recoveryEquivalenceSummary,
  testReportingPolicy,
  testRow,
  testSuite
} from "./helpers.js";

interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
  redirect?: "follow" | "error" | "manual";
  hasSignal: boolean;
}

function fakeFetch(respond?: (request: RecordedRequest) => unknown): {
  requests: RecordedRequest[];
  fetchImpl: typeof fetch;
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined,
      ...(init?.redirect !== undefined ? { redirect: init.redirect } : {}),
      hasSignal: init?.signal !== undefined && init.signal !== null
    };
    requests.push(request);
    const payload = respond?.(request) ?? { id: `id-${requests.length}` };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload)
    };
  }) as unknown as typeof fetch;
  return { requests, fetchImpl };
}

const EVAL_CONFIG = {
  provider: "braintrust",
  evalConfig: ".ultrafuzz/evals/bug-finding.yml",
  providers: {
    braintrust: { apiKeyEnv: "BRAINTRUST_API_KEY", project: "ultrafuzz-evals" }
  }
};

describe("provider resolution", () => {
  it("applies CLI > env > toml precedence", () => {
    expect(resolveEvalProvider({ env: {}, evalConfig: EVAL_CONFIG }).provider).toBe("braintrust");
    expect(resolveEvalProvider({ env: { ULTRAFUZZ_EVAL_PROVIDER: "none" }, evalConfig: EVAL_CONFIG }).provider).toBe(
      EVAL_PROVIDER_NONE
    );
    expect(
      resolveEvalProvider({
        cliProvider: "braintrust",
        env: { ULTRAFUZZ_EVAL_PROVIDER: "none" },
        evalConfig: EVAL_CONFIG
      }).provider
    ).toBe("braintrust");
  });

  it("fails on unknown providers and missing profiles at plan time", () => {
    expect(() => resolveEvalProvider({ cliProvider: "prefect", env: {}, evalConfig: EVAL_CONFIG })).toThrowError(
      expect.objectContaining({ code: "EVAL_PROVIDER_UNKNOWN" })
    );
    expect(() => resolveEvalProvider({ env: {}, evalConfig: { provider: "braintrust", providers: {} } })).toThrowError(
      expect.objectContaining({ code: "EVAL_PROVIDER_PROFILE_MISSING" })
    );
  });

  it("resolves the suite path with CLI > env > toml > default precedence", () => {
    expect(resolveEvalSuitePath({ env: {}, evalConfig: EVAL_CONFIG })).toBe(".ultrafuzz/evals/bug-finding.yml");
    expect(resolveEvalSuitePath({ env: { ULTRAFUZZ_EVAL_CONFIG: "custom.yml" }, evalConfig: EVAL_CONFIG })).toBe(
      "custom.yml"
    );
    expect(
      resolveEvalSuitePath({
        cliSuite: "flag.yml",
        env: { ULTRAFUZZ_EVAL_CONFIG: "custom.yml" },
        evalConfig: EVAL_CONFIG
      })
    ).toBe("flag.yml");
    expect(resolveEvalSuitePath({ env: {}, evalConfig: undefined })).toBe(".ultrafuzz/evals/bug-finding.yml");
  });

  it("returns no reporters for provider=none and errors on missing credentials only at publish time", () => {
    const policy = testReportingPolicy();
    expect(
      createEvalReporters({ cliProvider: "none", env: {}, evalConfig: EVAL_CONFIG, evalRunId: "eval-1", policy })
    ).toEqual([]);
    try {
      createEvalReporters({ env: {}, evalConfig: EVAL_CONFIG, evalRunId: "eval-1", policy });
      expect.unreachable("expected EVAL_PROVIDER_CREDENTIALS_MISSING");
    } catch (error) {
      expect(error).toBeInstanceOf(EvalError);
      expect((error as EvalError).code).toBe("EVAL_PROVIDER_CREDENTIALS_MISSING");
    }
    const reporters = createEvalReporters({
      env: { BRAINTRUST_API_KEY: "secret" },
      evalConfig: EVAL_CONFIG,
      evalRunId: "eval-1",
      policy,
      fetchImpl: fakeFetch().fetchImpl
    });
    expect(reporters.map((reporter) => reporter.name)).toEqual(["braintrust"]);
  });

  it("binds provider credentials and endpoints to approved destinations", () => {
    const policy = testReportingPolicy();
    expect(() =>
      createEvalReporters({
        env: { AWS_SECRET_ACCESS_KEY: "secret" },
        evalConfig: {
          provider: "braintrust",
          providers: { braintrust: { apiKeyEnv: "AWS_SECRET_ACCESS_KEY" } }
        },
        evalRunId: "eval-1",
        policy
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_PROVIDER_CREDENTIAL_BINDING_INVALID" }));

    expect(() =>
      createEvalReporters({
        env: { BRAINTRUST_API_KEY: "secret" },
        evalConfig: {
          provider: "braintrust",
          providers: {
            braintrust: { apiKeyEnv: "BRAINTRUST_API_KEY", endpoint: "https://example.com" }
          }
        },
        evalRunId: "eval-1",
        policy
      })
    ).toThrowError(expect.objectContaining({ code: "EVAL_PROVIDER_ENDPOINT_UNTRUSTED" }));

    const custom = createEvalReporters({
      env: {
        BRAINTRUST_API_KEY: "custom-service-key",
        ULTRAFUZZ_EVAL_BRAINTRUST_TRUSTED_ENDPOINT: "https://braintrust.internal.example"
      },
      evalConfig: {
        provider: "braintrust",
        providers: {
          braintrust: { apiKeyEnv: "BRAINTRUST_API_KEY", endpoint: "https://braintrust.internal.example" }
        }
      },
      evalRunId: "eval-1",
      policy,
      fetchImpl: fakeFetch().fetchImpl
    });
    expect(custom.map((reporter) => reporter.name)).toEqual(["braintrust"]);
  });
});

describe("provider transport", () => {
  it("rejects provider responses larger than the transport limit", async () => {
    const response = new Response("oversized", {
      headers: { "content-length": String(1024 * 1024 + 1) }
    });
    await expect(boundedResponseText(response, "provider", "EVAL_TEST_RESPONSE_TOO_LARGE")).rejects.toMatchObject({
      code: "EVAL_TEST_RESPONSE_TOO_LARGE"
    });
  });
});

describe("graphFromPlannedGraph", () => {
  it("maps planned nodes into the provider row graph with group inference", () => {
    const planned = currentPlannedGraph(["setup-1-a1", "strategies-fuzz-a1", "mystery"], undefined);
    planned.groups = { setup: {}, strategies: {} };
    planned.nodes[0]!.logical_id = "setup-1";
    planned.nodes[0]!.model_fanout[0]!.model_profile_id = "eval-runner";
    planned.nodes[0]!.model_fanout[0]!.model_name = "gpt-5.4-mini";
    planned.nodes[1]!.depends_on = ["setup-1-a1"];
    Object.assign(planned.nodes[2]!, {
      kind: "reference",
      prompt_path: "",
      model_fanout: [],
      reference: "monad-developers/ultrafuzz",
      reference_revision: {
        provider: "github",
        repo: "monad-developers/ultrafuzz",
        commit: "a".repeat(40),
        paths: ["README.md"]
      }
    });

    const graph = graphFromPlannedGraph(planned, "row-1");
    expect(graph.rowId).toBe("row-1");
    expect(graph.nodes).toHaveLength(3);
    expect(graph.nodes[0]).toMatchObject({
      id: "setup-1-a1",
      logicalId: "setup-1",
      group: "setup",
      modelProfileId: "eval-runner",
      model: "gpt-5.4-mini",
      loopIndex: 0
    });
    expect(graph.nodes[1]).toMatchObject({ group: "strategies", dependsOn: ["setup-1-a1"] });
    expect(graph.nodes[2]).toMatchObject({ group: "default", kind: "reference" });
  });

  it("uses an empty graph only when graph.json is absent", () => {
    expect(graphFromPlannedGraph(undefined, "row-1")).toEqual({ rowId: "row-1", nodes: [] });
  });

  it("rejects every malformed, schema-invalid, or semantically invalid present graph", () => {
    expect(() => graphFromPlannedGraph({ nodes: "nope" }, "row-1")).toThrow("planned graph is schema-invalid");

    const missingLogicalId = currentPlannedGraph(["setup-1"], undefined);
    Reflect.deleteProperty(missingLogicalId.nodes[0]!, "logical_id");
    expect(() => graphFromPlannedGraph(missingLogicalId, "row-1")).toThrow("planned graph is schema-invalid");

    const unknownDependency = currentPlannedGraph(["setup-1"], undefined);
    unknownDependency.nodes[0]!.depends_on = ["missing-node"];
    expect(() => graphFromPlannedGraph(unknownDependency, "row-1")).toThrow(
      'planned graph node "setup-1" depends on unknown node "missing-node"'
    );
  });
});

describe("BraintrustReporter", () => {
  it.each(["", "{", '{"id":"first","id":"shadow"}', "[]"])(
    "rejects a non-strict Braintrust success response instead of substituting an empty object: %j",
    async (payload) => {
      const suite = testSuite("/tmp/gt");
      const reporter = new BraintrustReporter({
        apiKey: "secret",
        project: "ultrafuzz-evals",
        evalRunId: "eval-invalid-response",
        policy: testReportingPolicy(),
        fetchImpl: (async () => new Response(payload, { status: 200 })) as typeof fetch
      });

      await expect(
        reporter.onPlan({
          suite_path: "suite.yml",
          project_root: "/tmp/project",
          suite,
          matrix: [testRow(suite)]
        })
      ).rejects.toMatchObject({ code: "EVAL_BRAINTRUST_RESPONSE_INVALID" });
    }
  );

  it("requires every successful Braintrust response to be a JSON object", async () => {
    const suite = testSuite("/tmp/gt");
    let request = 0;
    const reporter = new BraintrustReporter({
      apiKey: "secret",
      project: "ultrafuzz-evals",
      evalRunId: "eval-invalid-insert-response",
      policy: testReportingPolicy(),
      fetchImpl: (async () => {
        request += 1;
        return new Response(request < 3 ? `{"id":"provider-${request}"}` : "[]", { status: 200 });
      }) as typeof fetch
    });

    await expect(
      reporter.onPlan({
        suite_path: "suite.yml",
        project_root: "/tmp/project",
        suite,
        matrix: [testRow(suite)]
      })
    ).rejects.toMatchObject({ code: "EVAL_BRAINTRUST_RESPONSE_INVALID" });
  });

  it("mirrors comparison lineage and runtime fingerprints into provider metadata", async () => {
    const { requests, fetchImpl } = fakeFetch();
    const suite = testSuite("/tmp/generated-ground-truth");
    const row = testRow(suite);
    const provenance: EvalRunProvenance = {
      candidate: { label: "v0.0.2", commit: "a".repeat(40), dirty: false },
      benchmark: {
        availability: "available",
        series: "generated-series",
        protocol_revision: "1",
        cohort_fingerprint: "cohort-generated",
        targets: [{ id: "target-a", repo: "https://example.com/generated", commit: "b".repeat(40), dirty: false }],
        ground_truth_sha256: { "target-a": "ground-truth-generated" },
        ground_truth_subjects: {
          "target-a": {
            repository: "https://example.com/generated",
            revision: "b".repeat(40)
          }
        },
        execution_policy: {
          revision: "ultrafuzz.eval-controller.v1",
          fingerprint: "policy-generated",
          max_parallel_targets: 1,
          max_parallel_runs: 1,
          node_telemetry: true,
          heartbeat_interval_seconds: 60,
          controller_mode: "watch",
          watch_timeout_seconds: 120,
          poll_interval_ms: 10
        }
      }
    };
    const reporter = new BraintrustReporter({
      apiKey: "secret",
      project: "ultrafuzz-evals",
      evalRunId: "eval-lineage",
      policy: testReportingPolicy(),
      fetchImpl
    });
    await reporter.onPlan({
      suite_path: "generated-suite.yml",
      project_root: "/tmp/generated-project",
      suite,
      matrix: [row],
      provenance
    });
    await reporter.onRowStart(row, { rowId: row.id, nodes: [] });
    await reporter.onRowFinish(row, {
      status: "succeeded",
      graphFingerprint: "graph-generated",
      configFingerprint: "config-generated",
      executionArtifactId: "image-generated",
      recoveryEquivalence: cleanRecoveryEquivalence()
    });
    const summary: EvalScoreSummary = {
      schema_version: "ultrafuzz.eval.score-summary.v1",
      eval_run_id: "eval-lineage",
      eval_run_root: "/tmp/generated-run",
      recall_threshold: 0.7,
      rows: [],
      variants: [],
      scores_path: "scores.jsonl",
      summary_path: "summary.json",
      review_queue_path: "review.jsonl",
      recovery_equivalence: recoveryEquivalenceSummary(),
      provenance: {
        availability: "available",
        ...provenance,
        scoring: {
          implementation_revision: "scorer-generated",
          implementation_dirty: false,
          judge_mode: "deterministic",
          judge_prompt_version: "judge-prompt-generated",
          judge_models: ["judge-generated"],
          judge_panel: { total: 4, quorum: 3 },
          ground_truth_sha256: provenance.benchmark.ground_truth_sha256,
          ground_truth_subjects: provenance.benchmark.ground_truth_subjects,
          fingerprint: "scoring-generated"
        }
      }
    };
    const rowScore = currentRowScore(row, {
      precision: 1,
      recall: 1,
      f1_score: 1,
      full_match_rate: 1,
      true_positives: 1,
      false_positives: 0,
      missed: 0,
      human_review_queue_count: 0,
      recovery_equivalence: cleanRecoveryEquivalence()
    });
    await reporter.onScores([rowScore], summary);

    const inserts = requests.filter((request) => request.url.includes("/insert"));
    const events = inserts.flatMap(
      (request) => (request.body as { events?: Array<Record<string, unknown>> }).events ?? []
    );
    expect(events.find((event) => event.id === "plan-eval-lineage")).toMatchObject({
      metadata: {
        benchmark_series: "generated-series",
        cohort_fingerprint: "cohort-generated",
        execution_policy_fingerprint: "policy-generated",
        candidate_label: "v0.0.2",
        candidate_commit: "a".repeat(40)
      }
    });
    expect(events.find((event) => event.id === `row-${row.id}` && event.output !== undefined)).toMatchObject({
      output: { recovery_equivalence: { classification: "clean" } },
      metadata: {
        graph_fingerprint: "graph-generated",
        config_fingerprint: "config-generated",
        execution_artifact_id: "image-generated"
      }
    });
    expect(events.find((event) => event.id === "summary-eval-lineage")).toMatchObject({
      output: { recovery_equivalence: { aggregate_non_comparable: "include" } },
      metadata: {
        scoring_revision: "scorer-generated",
        scoring_fingerprint: "scoring-generated",
        judge_mode: "deterministic",
        judge_prompt_version: "judge-prompt-generated",
        judge_models: ["judge-generated"],
        judge_panel_total: 4,
        judge_panel_quorum: 3
      }
    });
    expect(events.find((event) => event.id === `row-${row.id}` && event.scores !== undefined)).toMatchObject({
      output: { recovery_equivalence: { classification: "clean" } }
    });
  });

  it("creates the experiment once and emits terminal-time node spans with backdated times", async () => {
    const { requests, fetchImpl } = fakeFetch();
    const suite = testSuite("/tmp/gt");
    const row = testRow(suite);
    const reporter = new BraintrustReporter({
      apiKey: "secret",
      project: "ultrafuzz-evals",
      evalRunId: "eval-1",
      policy: testReportingPolicy({ experiment_prefix: "bug-finding" }),
      fetchImpl
    });
    await reporter.onRowStart(row, {
      rowId: row.id,
      nodes: [
        { id: "setup-1", logicalId: "setup-1", kind: "agentic", group: "setup", dependsOn: [] },
        { id: "review-1", logicalId: "review-1", kind: "agentic", group: "review", dependsOn: ["setup-1"] }
      ]
    });
    await reporter.onNodeEvent({
      eventId: "evt-4",
      idempotencyKey: "ultrafuzz-event-stable-evt-4",
      rowId: row.id,
      nodeId: "setup-1",
      event: {
        type: "node-finished",
        at: "2026-07-09T00:05:00.000Z",
        startedAt: "2026-07-09T00:00:00.000Z",
        status: "succeeded",
        attempt: 1,
        findingsCount: 3
      }
    });

    expect(requests[0]).toMatchObject({ method: "POST", url: expect.stringContaining("/v1/project") });
    expect(requests[0]).toMatchObject({ redirect: "error", hasSignal: true });
    expect(requests[1]).toMatchObject({ method: "POST", url: expect.stringContaining("/v1/experiment") });
    expect((requests[1]?.body as { name?: string }).name).toBe("bug-finding-eval-1");

    const inserts = requests.filter((request) => request.url.includes("/insert"));
    expect(inserts.length).toBeGreaterThanOrEqual(2);
    const rowInsert = inserts[0]?.body as { events: Array<Record<string, unknown>> };
    expect(rowInsert.events[0]).toMatchObject({
      span_id: `span-row-${row.id}`,
      root_span_id: `span-row-${row.id}`
    });
    // group child spans under the row root
    expect(rowInsert.events.slice(1).map((event) => event.span_id)).toEqual([
      `span-group-${row.id}-review`,
      `span-group-${row.id}-setup`
    ]);
    const nodeInsert = inserts.find((request) =>
      JSON.stringify(request.body).includes(`span-node-${row.id}-setup-1-a1`)
    );
    expect(nodeInsert).toBeDefined();
    const nodeEvent = (nodeInsert?.body as { events: Array<Record<string, unknown>> }).events[0]!;
    expect(nodeEvent).toMatchObject({
      id: "ultrafuzz-event-stable-evt-4",
      span_parents: [`span-group-${row.id}-setup`],
      metrics: {
        start: Date.parse("2026-07-09T00:00:00.000Z") / 1000,
        end: Date.parse("2026-07-09T00:05:00.000Z") / 1000
      },
      output: { status: "succeeded", findings_count: 3 }
    });
  });
});
