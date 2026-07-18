import { describe, expect, it } from "vitest";

import { graphFromPlannedGraph } from "../src/reporter.js";
import { BraintrustReporter } from "../src/reporters/braintrust.js";
import { boundedResponseText } from "../src/reporters/http.js";
import { LangSmithReporter, dottedOrderSegment } from "../src/reporters/langsmith.js";
import {
  EVAL_PROVIDER_NONE,
  createEvalReporters,
  resolveEvalProvider,
  resolveEvalSuitePath
} from "../src/reporters/index.js";
import { EvalError } from "../src/utils.js";
import type { EvalRunProvenance, EvalScoreSummary } from "../src/types.js";
import { testReportingPolicy, testRow, testSuite } from "./helpers.js";

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
    braintrust: { apiKeyEnv: "BRAINTRUST_API_KEY", project: "ultrafuzz-evals" },
    langsmith: {
      apiKeyEnv: "LANGSMITH_API_KEY",
      workspaceIdEnv: "LANGSMITH_WORKSPACE_ID",
      project: "ultrafuzz-evals"
    }
  }
};

describe("provider resolution", () => {
  it("applies CLI > env > toml precedence", () => {
    expect(resolveEvalProvider({ env: {}, evalConfig: EVAL_CONFIG }).provider).toBe("braintrust");
    expect(
      resolveEvalProvider({ env: { ULTRAFUZZ_EVAL_PROVIDER: "langsmith" }, evalConfig: EVAL_CONFIG }).provider
    ).toBe("langsmith");
    expect(
      resolveEvalProvider({
        cliProvider: "none",
        env: { ULTRAFUZZ_EVAL_PROVIDER: "langsmith" },
        evalConfig: EVAL_CONFIG
      }).provider
    ).toBe(EVAL_PROVIDER_NONE);
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

    expect(
      () =>
        new LangSmithReporter({
          apiKey: "secret",
          project: "ultrafuzz-evals",
          evalRunId: "eval-1",
          policy,
          endpoint: "http://api.smith.langchain.com"
        })
    ).toThrowError(expect.objectContaining({ code: "EVAL_PROVIDER_ENDPOINT_INVALID" }));
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
    const graph = graphFromPlannedGraph(
      {
        schema_version: "1.0",
        groups: { setup: {}, strategies: {} },
        nodes: [
          {
            id: "setup-1-a1",
            logical_id: "setup-1",
            kind: "agentic",
            depends_on: [],
            loop: { index: 0, count: 1 },
            model_fanout: [{ model_profile_id: "eval-runner", model_name: "gpt-5.4-mini" }]
          },
          {
            id: "strategies-fuzz-a1",
            logical_id: "strategies-fuzz",
            kind: "agentic",
            depends_on: ["setup-1-a1"]
          },
          { id: "mystery", logical_id: "mystery", kind: "reference", depends_on: [] }
        ]
      },
      "row-1"
    );
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

  it("degrades unknown shapes to an empty graph", () => {
    expect(graphFromPlannedGraph(undefined, "row-1")).toEqual({ rowId: "row-1", nodes: [] });
    expect(graphFromPlannedGraph({ nodes: "nope" }, "row-1")).toEqual({ rowId: "row-1", nodes: [] });
  });
});

describe("BraintrustReporter", () => {
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
        targets: [{ id: "target-a", repo: "https://example.com/generated", commit: "b".repeat(40) }],
        ground_truth_sha256: { "target-a": "ground-truth-generated" },
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
      executionArtifactId: "image-generated"
    });
    const summary: EvalScoreSummary = {
      eval_run_id: "eval-lineage",
      eval_run_root: "/tmp/generated-run",
      recall_threshold: 0.7,
      rows: [],
      variants: [],
      scores_path: "scores.jsonl",
      summary_path: "summary.json",
      review_queue_path: "review.jsonl",
      provenance: {
        availability: "available",
        ...provenance,
        scoring: {
          implementation_revision: "scorer-generated",
          implementation_dirty: false,
          judge_prompt_version: "judge-prompt-generated",
          judge_models: ["judge-generated"],
          ground_truth_sha256: provenance.benchmark.ground_truth_sha256,
          fingerprint: "scoring-generated"
        }
      }
    };
    await reporter.onScores([], summary);

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
      metadata: {
        graph_fingerprint: "graph-generated",
        config_fingerprint: "config-generated",
        execution_artifact_id: "image-generated"
      }
    });
    expect(events.find((event) => event.id === "summary-eval-lineage")).toMatchObject({
      metadata: {
        scoring_revision: "scorer-generated",
        scoring_fingerprint: "scoring-generated",
        judge_prompt_version: "judge-prompt-generated",
        judge_models: ["judge-generated"]
      }
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
      id: "evt-4",
      span_parents: [`span-group-${row.id}-setup`],
      metrics: {
        start: Date.parse("2026-07-09T00:00:00.000Z") / 1000,
        end: Date.parse("2026-07-09T00:05:00.000Z") / 1000
      },
      output: { status: "succeeded", findings_count: 3 }
    });
  });
});

describe("LangSmithReporter", () => {
  it("creates live runs on node-started and patches them on node-finished", async () => {
    const { requests, fetchImpl } = fakeFetch();
    const suite = testSuite("/tmp/gt");
    const row = testRow(suite);
    const reporter = new LangSmithReporter({
      apiKey: "secret",
      project: "ultrafuzz-evals",
      evalRunId: "eval-1",
      policy: testReportingPolicy(),
      fetchImpl
    });
    await reporter.onRowStart(row, {
      rowId: row.id,
      nodes: [{ id: "setup-1", logicalId: "setup-1", kind: "agentic", group: "setup", dependsOn: [] }]
    });
    await reporter.onNodeEvent({
      eventId: "evt-1",
      rowId: row.id,
      nodeId: "setup-1",
      event: { type: "node-started", at: "2026-07-09T00:00:00.000Z", attempt: 1 }
    });
    await reporter.onNodeEvent({
      eventId: "evt-4",
      rowId: row.id,
      nodeId: "setup-1",
      event: { type: "node-finished", at: "2026-07-09T00:05:00.000Z", status: "failed", attempt: 1, error: "boom" }
    });

    const creates = requests.filter((request) => request.method === "POST" && request.url.endsWith("/api/v1/runs"));
    // root run + group run + node run
    expect(creates).toHaveLength(3);
    const nodeCreate = creates[2]?.body as Record<string, unknown>;
    expect(nodeCreate).toMatchObject({
      name: "setup-1",
      run_type: "chain",
      session_name: "ultrafuzz-evals",
      start_time: "2026-07-09T00:00:00.000Z"
    });
    expect(String(nodeCreate.dotted_order).split(".")).toHaveLength(3);

    const patches = requests.filter((request) => request.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.body).toMatchObject({
      end_time: "2026-07-09T00:05:00.000Z",
      outputs: { status: "failed" },
      error: "boom"
    });
    expect(patches[0]?.url).toContain(String(nodeCreate.id));
  });

  it("routes artifact events to the latest attempt run, even beyond 16 retries", async () => {
    const { requests, fetchImpl } = fakeFetch();
    const suite = testSuite("/tmp/gt");
    const row = testRow(suite);
    const reporter = new LangSmithReporter({
      apiKey: "secret",
      project: "ultrafuzz-evals",
      evalRunId: "eval-1",
      policy: testReportingPolicy(),
      fetchImpl
    });
    await reporter.onRowStart(row, {
      rowId: row.id,
      nodes: [{ id: "setup-1", logicalId: "setup-1", kind: "agentic", group: "setup", dependsOn: [] }]
    });
    await reporter.onNodeEvent({
      eventId: "evt-1",
      rowId: row.id,
      nodeId: "setup-1",
      event: { type: "node-started", at: "2026-07-09T00:00:00.000Z", attempt: 17 }
    });
    const creates = requests.filter((request) => request.method === "POST" && request.url.endsWith("/api/v1/runs"));
    const nodeCreate = creates[creates.length - 1]?.body as Record<string, unknown>;
    expect(nodeCreate).toMatchObject({ name: "setup-1 (attempt 17)" });

    await reporter.onNodeEvent({
      eventId: "evt-2",
      rowId: row.id,
      nodeId: "setup-1",
      event: {
        type: "node-artifacts",
        at: "2026-07-09T00:05:00.000Z",
        manifest: [{ path: "report.md", size_bytes: 8, sha256: "abc", provenance: { producer_node_id: "setup-1" } }]
      }
    });
    const patches = requests.filter((request) => request.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.url).toContain(String(nodeCreate.id));
  });

  it("patches root and group start_time from result.startedAt on row finish (post-hoc publish)", async () => {
    const { requests, fetchImpl } = fakeFetch();
    const suite = testSuite("/tmp/gt");
    const row = testRow(suite);
    const reporter = new LangSmithReporter({
      apiKey: "secret",
      project: "ultrafuzz-evals",
      evalRunId: "eval-1",
      policy: testReportingPolicy(),
      fetchImpl
    });
    await reporter.onRowStart(row, {
      rowId: row.id,
      nodes: [{ id: "setup-1", logicalId: "setup-1", kind: "agentic", group: "setup", dependsOn: [] }]
    });
    await reporter.onRowFinish(row, {
      status: "succeeded",
      startedAt: "2026-07-01T00:00:00.000Z",
      finishedAt: "2026-07-01T01:00:00.000Z"
    });

    const patches = requests.filter((request) => request.method === "PATCH");
    // group run + root run, both backdated to the actual run start
    expect(patches).toHaveLength(2);
    for (const patch of patches) {
      expect(patch.body).toMatchObject({
        start_time: "2026-07-01T00:00:00.000Z",
        end_time: "2026-07-01T01:00:00.000Z"
      });
    }
  });

  it("leaves start_time untouched on row finish when result.startedAt is absent", async () => {
    const { requests, fetchImpl } = fakeFetch();
    const suite = testSuite("/tmp/gt");
    const row = testRow(suite);
    const reporter = new LangSmithReporter({
      apiKey: "secret",
      project: "ultrafuzz-evals",
      evalRunId: "eval-1",
      policy: testReportingPolicy(),
      fetchImpl
    });
    await reporter.onRowStart(row, { rowId: row.id, nodes: [] });
    await reporter.onRowFinish(row, { status: "succeeded", finishedAt: "2026-07-01T01:00:00.000Z" });

    const patches = requests.filter((request) => request.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.body).not.toHaveProperty("start_time");
  });

  it("formats dotted-order segments the way LangSmith expects", () => {
    const segment = dottedOrderSegment("2026-07-09T01:02:03.456Z", "abc");
    expect(segment).toBe("20260709T010203456000Zabc");
  });
});
