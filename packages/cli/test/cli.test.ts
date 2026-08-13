import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ARTIFACT_VERIFICATION_SCHEMA_VERSION,
  FINDINGS_SCHEMA_VERSION,
  REPORT_SCHEMA_VERSION,
  artifactContractDefinition,
  artifactSchemaDirectory,
  appendNodeAttempt,
  appendUsageEvents,
  createInitialRunState,
  createEventRecord,
  createRunLayout,
  layoutForRunRoot,
  manifestDigest,
  readPlannedGraphDocument,
  readRunMetadataDocument,
  updateNodeState,
  updateRunStatus,
  writeArtifactManifest,
  writeRunMetadataDocument,
  type RunLayout
} from "@ultrafuzz/artifacts";
import { DASHBOARD_HTTP_SCHEMA_VERSION, serveDashboard } from "@ultrafuzz/dashboard";
import { NodeTelemetryPump, type EvalArtifactUpload, type EvalMatrixRow, type EvalReporter } from "@ultrafuzz/evals";
import { loadVerifiedRunOutputSnapshots, projectCanonicalFinalReport, syncRun } from "@ultrafuzz/runtime";
import AdmZip from "adm-zip";

import { validateReportBundleManifest } from "../src/cli-schema-registry.js";
import { runCli } from "../src/index.js";

interface Capture {
  stdout: string;
  stderr: string;
  code: number;
}

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ufz-cli-"));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function fakeWorkflowEventPrintf(event: Record<string, unknown>): string {
  const runIdToken = "ultrafuzz-cli-run";
  const serialized = JSON.stringify(event);
  const runIdCount = serialized.split(runIdToken).length - 1;
  assert.ok(runIdCount > 0);
  return `printf ${shellQuote(`${serialized.replaceAll(runIdToken, "%s")}\n`)} ${Array.from(
    { length: runIdCount },
    () => '"$2"'
  ).join(" ")}`;
}

function fakeSmithersEnv(
  project: string,
  includeFinalReport = false,
  additionalTerminalNodeIds: readonly string[] = []
): Record<string, string | undefined> {
  const binDir = path.join(project, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const inspectStatePath = path.join(project, "fake-smithers-inspect-state");
  fs.writeFileSync(inspectStatePath, "running\n", "utf8");
  const smithers = path.join(binDir, "smithers");
  const terminalNodeIds = [
    "project-discovery",
    ...additionalTerminalNodeIds,
    ...(includeFinalReport ? ["final-report"] : [])
  ];
  const finishedNodes = terminalNodeIds.flatMap((nodeId) => [
    { nodeId: `prepare:${nodeId}`, state: "finished", attempt: 1, label: `prepare:${nodeId}` },
    { nodeId: `node:${nodeId}`, state: "finished", attempt: 1, label: `node:${nodeId}` },
    { nodeId: `verify:${nodeId}`, state: "finished", attempt: 1, label: `verify:${nodeId}` }
  ]);
  const workflowEvents = [
    {
      runId: "ultrafuzz-cli-run",
      seq: 1,
      timestampMs: 1_775_865_599_000,
      type: "RunStarted",
      payload: { runId: "ultrafuzz-cli-run", timestampMs: 1_775_865_599_000, type: "RunStarted" }
    },
    ...terminalNodeIds.flatMap((nodeId, index) => {
      const startedSequence = 2 + index * 2;
      const startedAt = 1_775_865_600_000 + index * 2_000;
      return [
        {
          runId: "ultrafuzz-cli-run",
          seq: startedSequence,
          timestampMs: startedAt,
          type: "NodeStarted",
          payload: {
            runId: "ultrafuzz-cli-run",
            timestampMs: startedAt,
            type: "NodeStarted",
            nodeId: `node:${nodeId}`,
            iteration: 0,
            attempt: 1
          }
        },
        {
          runId: "ultrafuzz-cli-run",
          seq: startedSequence + 1,
          timestampMs: startedAt + 1_000,
          type: "NodeFinished",
          payload: {
            runId: "ultrafuzz-cli-run",
            timestampMs: startedAt + 1_000,
            type: "NodeFinished",
            nodeId: `node:${nodeId}`,
            iteration: 0,
            attempt: 1
          }
        }
      ];
    }),
    {
      runId: "ultrafuzz-cli-run",
      seq: 2 + terminalNodeIds.length * 2,
      timestampMs: 1_775_865_600_000 + terminalNodeIds.length * 2_000,
      type: "RunFinished",
      payload: {
        runId: "ultrafuzz-cli-run",
        timestampMs: 1_775_865_600_000 + terminalNodeIds.length * 2_000,
        type: "RunFinished"
      }
    }
  ];
  fs.writeFileSync(
    smithers,
    [
      "#!/bin/sh",
      'if [ -n "$SMITHERS_FAKE_LOG" ]; then printf \'%s\\n\' "$*" >> "$SMITHERS_FAKE_LOG"; fi',
      'case "$1" in',
      "  ps)",
      `    printf '%s\\n' ${shellQuote(
        JSON.stringify({
          ok: true,
          data: {
            runs: [
              {
                id: "ultrafuzz-cli-run",
                workflow: "ultrafuzz-cli-run",
                status: "running",
                dbStatus: "running",
                state: "running",
                step: "project-discovery",
                started: "2026-08-09T00:00:00Z"
              }
            ]
          },
          meta: { command: "ps", duration: "1ms" }
        })
      )}`,
      "    ;;",
      "  inspect)",
      "    inspect_state=$(tr -d '\\n' < \"$SMITHERS_FAKE_INSPECT_STATE\")",
      '    inspect_status="running"',
      '    inspect_nodes="[]"',
      '    if [ "$inspect_state" = "succeeded" ]; then',
      '      inspect_status="finished"',
      `      inspect_nodes=${shellQuote(JSON.stringify(finishedNodes))}`,
      "    fi",
      `    printf '{"ok":true,"data":{"run":{"id":"%s","workflow":"workflow","status":"%s","started":"2026-08-09T00:00:00.000Z","elapsed":"1s"},"runState":{"runId":"%s","state":"%s","computedAt":"2026-08-09T00:00:01.000Z"},"steps":%s,"nodes":%s},"meta":{"command":"inspect","duration":"1ms"}}\\n' "$2" "$inspect_status" "$2" "$inspect_state" "$inspect_nodes" "$inspect_nodes"`,
      "    ;;",
      "  events)",
      '    if [ "$SMITHERS_FAKE_INVALID_EVENT_STREAM" = "events" ] && [ "$3" != "--type" ]; then',
      "      printf '%s' '{\"malformed\":'",
      "      exit 0",
      '    elif [ "$SMITHERS_FAKE_INVALID_EVENT_STREAM" = "token-events" ] && [ "$3" = "--type" ]; then',
      "      printf '%s' '{\"malformed\":'",
      "      exit 0",
      "    fi",
      '    case "$*" in',
      `      *--full-output*) printf '%s\\n' ${shellQuote(
        JSON.stringify({ ok: true, data: [], meta: { command: "events", duration: "1ms" } })
      )} ;;`,
      "      *)",
      '        if [ "$(tr -d \'\\n\' < "$SMITHERS_FAKE_INSPECT_STATE")" = "succeeded" ]; then',
      ...workflowEvents.map((event) => `          ${fakeWorkflowEventPrintf(event)}`),
      "        fi",
      "        ;;",
      "    esac",
      "    ;;",
      "  fork)",
      '    printf \'%s\\n\' \'{"ok":true,"data":{"forkedRunId":"ultrafuzz-cli-run-forked"}}\'',
      "    ;;",
      "  replay)",
      '    printf \'%s\\n\' \'{"ok":true,"data":{"forkedRunId":"ultrafuzz-cli-run-replayed"}}\'',
      "    ;;",
      "  pause)",
      '    printf \'%s\\n\' \'{"ok":true,"data":{"status":"pause-requested"}}\'',
      "    exit 2",
      "    ;;",
      "  status)",
      `    printf '%s\\n' ${shellQuote(
        JSON.stringify({
          ok: true,
          data: {
            status: "running",
            verdict: "running-healthy",
            reason: "1 running, 2 finished in last 10m",
            counts: {
              finished: 2,
              inProgress: 1,
              pending: 3,
              failed: 0,
              waitingApproval: 0,
              waitingEvent: 0,
              waitingTimer: 0,
              skipped: 0,
              other: 0,
              total: 6
            },
            modelMix: [{ engine: "codex", model: "gpt-test", attempts: 3, quotaParked: false }],
            throughput: { recentFinished: 2, windowMs: 600_000, totalFinished: 2, lastFinishedAtMs: 1_000 },
            bottleneck: [{ nodeId: "project-discovery", iteration: 0, state: "in-progress", detail: "running 1m" }],
            bottleneckOmitted: 0,
            quota: null,
            generatedAtMs: 2_000
          },
          meta: { command: "status", duration: "1ms" }
        })
      )}`,
      "    ;;",
      "  *)",
      "    printf '%s\\n' '{\"ok\":true}'",
      "    ;;",
      "esac",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(smithers, 0o755);
  return {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    SMITHERS_BIN: smithers,
    SMITHERS_FAKE_LOG: path.join(project, "smithers-commands.log"),
    SMITHERS_FAKE_INSPECT_STATE: inspectStatePath
  };
}

function writeSmallTopology(project: string): void {
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "topology.yml"),
    `version: 2
defaults:
  strategy_loops: 1
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: project-discovery
    kind: agentic
    prompt: setup/project-discovery.md
    depends_on:
      - __start__
    outputs:
      - path: stdout.txt
        contract: ultrafuzz/text@1
        primary: true
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - project-discovery
`,
    "utf8"
  );
}

function writeReportTopology(project: string): void {
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "topology.yml"),
    `version: 2
defaults:
  strategy_loops: 1
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: project-discovery
    kind: agentic
    prompt: setup/project-discovery.md
    depends_on:
      - __start__
    outputs:
      - path: stdout.txt
        contract: ultrafuzz/text@1
        primary: true
  - id: final-report
    kind: agentic
    prompt: setup/project-discovery.md
    depends_on:
      - __start__
    outputs:
      - path: report.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
      - path: report.json
        contract: ultrafuzz/report@2
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - project-discovery
      - final-report
`,
    "utf8"
  );
}

function writeCustomReportTopology(project: string): void {
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "topology.yml"),
    `version: 2
defaults:
  strategy_loops: 1
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: audit-delivery
    kind: agentic
    prompt: setup/project-discovery.md
    depends_on:
      - __start__
    outputs:
      - path: deliverables/current-audit.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
      - path: deliverables/current-audit.json
        contract: ultrafuzz/report@2
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - audit-delivery
`,
    "utf8"
  );
}

function writeByteIdentityTopology(project: string): void {
  fs.writeFileSync(
    path.join(project, ".ultrafuzz", "topology.yml"),
    `version: 2
defaults:
  strategy_loops: 1
nodes:
  - id: __start__
    kind: meta
    role: start
    depends_on: []
  - id: project-discovery
    kind: agentic
    prompt: setup/project-discovery.md
    depends_on:
      - __start__
    outputs:
      - path: stdout.txt
        contract: ultrafuzz/text@1
        primary: true
  - id: aggregate-test-files
    kind: agentic
    prompt: setup/project-discovery.md
    depends_on:
      - project-discovery
    outputs:
      - path: aggregation.json
        contract: ultrafuzz/aggregation-manifest@1
        primary: true
  - id: final-report
    kind: agentic
    prompt: setup/project-discovery.md
    depends_on:
      - aggregate-test-files
    outputs:
      - path: report.md
        contract: ultrafuzz/nonempty-markdown@1
        primary: true
      - path: report.json
        contract: ultrafuzz/report@2
  - id: __finish__
    kind: meta
    role: finish
    depends_on:
      - final-report
`,
    "utf8"
  );
}

async function cli(
  project: string,
  argv: string[],
  env: Record<string, string | undefined> = {},
  onStdout?: (stdout: string) => void
): Promise<Capture> {
  let stdout = "";
  let stderr = "";
  const code = await runCli([...argv, "--project", project], {
    cwd: project,
    env,
    stdout: {
      write: (chunk: string | Uint8Array) => {
        stdout += String(chunk);
        onStdout?.(stdout);
        return true;
      }
    },
    stderr: {
      write: (chunk: string | Uint8Array) => {
        stderr += String(chunk);
        return true;
      }
    }
  });
  return { stdout, stderr, code };
}

async function withInjectedBundleCollectionRead<T>(
  targetPath: string,
  injectedBytes: Buffer,
  operation: () => Promise<T>
): Promise<T> {
  const injectionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufz-bundle-read-injection-"));
  const injectionPath = path.join(injectionRoot, "injected-bytes");
  fs.writeFileSync(injectionPath, injectedBytes);
  const target = path.resolve(targetPath);
  const originalOpenSync = fs.openSync;
  const mutableFs = fs as { openSync: typeof fs.openSync };
  let injected = false;
  // The CLI suite runs with --test-concurrency=1; keep this global read shim
  // scoped to one awaited command and restore it before deleting its fixture.
  mutableFs.openSync = ((...args: unknown[]) => {
    const candidate = args[0];
    if (
      !injected &&
      typeof candidate === "string" &&
      path.resolve(candidate) === target &&
      new Error().stack?.includes("addBundleFile") === true
    ) {
      injected = true;
      return Reflect.apply(originalOpenSync, fs, [injectionPath, ...args.slice(1)]);
    }
    return Reflect.apply(originalOpenSync, fs, args);
  }) as typeof fs.openSync;
  try {
    const result = await operation();
    assert.equal(injected, true, `bundle collection did not read ${target}`);
    return result;
  } finally {
    mutableFs.openSync = originalOpenSync;
    fs.unlinkSync(injectionPath);
    fs.rmdirSync(injectionRoot);
  }
}

function parseJson(capture: Capture): Record<string, unknown> {
  return JSON.parse(capture.stdout) as Record<string, unknown>;
}

function assertNoSmithersSurface(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertNoSmithersSurface(entry);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      assert.doesNotMatch(key, /smithers/i);
      assertNoSmithersSurface(entry);
    }
    return;
  }
  if (typeof value === "string") {
    assert.doesNotMatch(value, /smithers/i);
  }
}

function writeRunAccounting(
  runRoot: string,
  accounting: {
    totalTokens: number;
    tokensUsed: string;
    estimatedSpend: string;
    partialPricing: boolean;
    unpricedEventCount?: number;
  }
): void {
  const runMetadataPath = path.join(runRoot, "run.json");
  const runMetadata = readRunMetadataDocument(runMetadataPath, path.basename(runRoot));
  assert.ok(runMetadata.workflow, "accounting fixtures require a linked workflow");
  const workflowRunId = runMetadata.workflow.run_id;
  const controlGeneration = runMetadata.workflow.control_generation;
  const unpricedEventCount = accounting.unpricedEventCount ?? (accounting.partialPricing ? 1 : 0);
  const eventCount = 1 + unpricedEventCount;
  const estimatedSpendUsd = Number(accounting.estimatedSpend.replace(/[$,+]/gu, ""));
  const summary = {
    uncached_input_tokens: accounting.totalTokens,
    input_tokens: accounting.totalTokens,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    inclusive_token_total: accounting.totalTokens,
    billable_token_total: accounting.totalTokens,
    total_tokens: accounting.totalTokens,
    tokens_used: accounting.tokensUsed,
    estimated_spend: accounting.estimatedSpend,
    estimated_spend_usd: estimatedSpendUsd,
    component_costs_usd: {
      uncached_input: estimatedSpendUsd,
      cache_read: 0,
      cache_write: 0,
      output: 0,
      reasoning: 0
    },
    usage_complete: true,
    usage_incomplete_reasons: [],
    pricing_complete: !accounting.partialPricing,
    pricing_incomplete_reasons: accounting.partialPricing
      ? [{ code: "model-pricing-unavailable" as const, model: "gpt-test" }]
      : [],
    partial_pricing: accounting.partialPricing,
    cache_read_pricing_estimated: false,
    event_count: eventCount,
    priced_event_count: 1,
    unpriced_event_count: unpricedEventCount,
    models: ["gpt-test"],
    agents: ["codex"]
  };
  const current = {
    ...summary,
    control_generation: controlGeneration,
    workflow_run_id: workflowRunId,
    source_event_sequences: Array.from({ length: eventCount }, (_, index) => index),
    attempts: []
  };
  writeRunMetadataDocument(runMetadataPath, {
    ...runMetadata,
    accounting: {
      schema_version: "ultrafuzz.accounting.v3",
      source: "usage-ledger",
      workflow_run_id: workflowRunId,
      current,
      segments: [current],
      cumulative: { ...summary, source_run_ids: [] },
      checkpoint: {
        schema_version: "ultrafuzz.accounting-checkpoint.v1",
        ledger_event_count: eventCount,
        last_source_event_sequence: eventCount - 1,
        control_generation: controlGeneration,
        workflow_run_id: workflowRunId
      },
      pricing_catalog: {
        source: "configured-catalog",
        status: "available",
        resolved_models: ["gpt-test"],
        unresolved_models: [],
        model_prices: {
          "gpt-test": { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }
        }
      },
      updated_at: new Date().toISOString()
    }
  });
}

function writeFinalReportAccounting(
  runRoot: string,
  accounting: { tokensUsed: string; estimatedSpend: string; partialPricing: boolean }
): string {
  const reportDir = path.join(runRoot, "artifacts", "final-report");
  fs.mkdirSync(reportDir, { recursive: true });
  writeCanonicalReportPair(
    reportDir,
    currentReport(path.basename(runRoot), [], {
      tokens_used: accounting.tokensUsed,
      estimated_spend: accounting.estimatedSpend,
      partial_pricing: accounting.partialPricing,
      source_run_ids: []
    })
  );
  sealVerifiedFinalReport(runRoot);
  return reportDir;
}

function currentReport(
  runId: string,
  issues: Record<string, unknown>[] = [],
  metadata: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schema_version: REPORT_SCHEMA_VERSION,
    run_metadata: {
      run_id: runId,
      source_run_id: "none",
      repository: "unavailable",
      elapsed_time: "unavailable",
      models_used: [],
      tokens_used: "unavailable",
      estimated_spend: "unavailable",
      partial_pricing: false,
      strategy_loops: 1,
      audit_profile: "full",
      audit_profile_catalog_digest: "a".repeat(64),
      topology_digest: "b".repeat(64),
      prompt_digest: "c".repeat(64),
      expanded_graph_fingerprint: "d".repeat(64),
      ...metadata
    },
    issues,
    non_production_outcomes: [],
    property_provenance: [],
    property_implementation_coverage: {
      status: "not-planned",
      reason: "property-implementation-track-not-declared"
    }
  };
}

function currentReportIssue(id = "M-01"): Record<string, unknown> {
  return {
    schema_version: FINDINGS_SCHEMA_VERSION,
    id,
    title: "[M-01] - Canonical finding",
    status: "confirmed",
    severity_guess: "Medium",
    confidence: "high",
    summary: "A bounded state transition violates the expected relationship.",
    description: "A caller can reach a state that violates the documented relationship.",
    severity: "Medium",
    impact: "Medium",
    likelihood: "Medium",
    impact_rationale: "The affected state remains bounded.",
    likelihood_rationale: "The transition uses ordinary preconditions.",
    severity_rationale: "Medium impact and Medium likelihood map to Medium.",
    proof_of_concept: {
      scenario: ["Prepare the bounded state.", "Execute the transition and observe the mismatch."],
      language: "solidity",
      code: "function testCanonicalFinding() public {}"
    },
    strategy: "stateful-invariant",
    strategy_provenance: {
      detection_rates: [{ strategy: "stateful-invariant", detections: 1, configured_loops: 1 }]
    },
    lifecycle: {
      dedupe_key: `dedupe-${id}`,
      source_artifacts: [],
      strategy_hits: [],
      canonical_severity: "Medium"
    }
  };
}

function writeCanonicalReportPair(reportDir: string, report: Record<string, unknown>): void {
  const projection = projectCanonicalFinalReport(report);
  writeJsonRecord(path.join(reportDir, "report.json"), projection.report);
  fs.writeFileSync(path.join(reportDir, "report.md"), projection.markdown, "utf8");
}

test("report render gives producers the exact canonical Markdown without host repair", async () => {
  const project = tempProject();
  const reportPath = path.join(project, "report.json");
  const markdownPath = path.join(project, "report.md");
  const report = currentReport("producer-render", [currentReportIssue()]);
  const expected = projectCanonicalFinalReport(report).markdown;
  writeJsonRecord(reportPath, report);

  const result = await cli(project, ["report", "render", "--file", reportPath, "--output", markdownPath]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.readFileSync(markdownPath, "utf8"), expected);

  writeJsonRecord(reportPath, { ...report, issues: [{ id: "invalid" }] });
  const before = fs.readFileSync(markdownPath);
  const invalid = await cli(project, ["report", "render", "--file", reportPath, "--output", markdownPath]);
  assert.equal(invalid.code, 1);
  assert.deepEqual(fs.readFileSync(markdownPath), before);
});

function sealVerifiedFinalReport(runRoot: string): void {
  sealVerifiedNodeOutputs(runRoot, "final-report");
}

function sealVerifiedNodeOutputs(
  runRoot: string,
  logicalNodeId: string,
  additionalPublicationPaths: readonly string[] = []
): void {
  const authority = writeVerifierNodeAuthority(runRoot, logicalNodeId, additionalPublicationPaths);
  const { layout, plannedNode, attemptId, artifactDir, publications } = authority;
  const runMetadata = readRunMetadataDocument(layout.runMetadataPath, layout.runId);
  assert.ok(runMetadata.workflow, "verified-output fixtures require an active workflow link");
  const workflowRunId = runMetadata.workflow.run_id;
  const agentTaskId = `node:${attemptId}`;
  const verifierTaskId = `verify:${attemptId}`;

  writeArtifactManifest({
    layout,
    nodeId: attemptId,
    include: publications.map((publication) => publication.path),
    outputs: plannedNode.outputs,
    provenance: {
      producer_node_id: attemptId,
      logical_node_id: plannedNode.logical_id,
      attempt_index: plannedNode.loop.attempt_index,
      loop_index: plannedNode.loop.index,
      model_index: 0,
      agent_ref: "Codex",
      workflow_run_id: workflowRunId,
      workflow_task_id: agentTaskId,
      origin: "workflow",
      metadata: { concrete_node_id: plannedNode.id }
    }
  });
  const manifestBytes = fs.readFileSync(path.join(artifactDir, "artifact-manifest.json"));
  updateNodeState(layout, attemptId, {
    status: "succeeded",
    finished_at: new Date().toISOString(),
    wait_since: undefined,
    wait_reason: undefined,
    next_eligible_action: undefined,
    provenance: {
      workflow: {
        run_id: workflowRunId,
        task_id: verifierTaskId,
        agent_task_id: agentTaskId,
        verifier_task_id: verifierTaskId,
        state: "finished",
        attempt: 0
      },
      output_contracts: { ok: true, missing: [], artifact_manifest_sha256: digest(manifestBytes) }
    }
  });
}

function writeVerifierNodeAuthority(
  runRoot: string,
  logicalNodeId: string,
  additionalPublicationPaths: readonly string[] = []
): {
  layout: ReturnType<typeof layoutForRunRoot>;
  plannedNode: ReturnType<typeof readPlannedGraphDocument>["nodes"][number];
  attemptId: string;
  artifactDir: string;
  snapshots: Array<{
    output: ReturnType<typeof readPlannedGraphDocument>["nodes"][number]["outputs"][number];
    path: string;
    bytes: Buffer;
  }>;
  publications: Array<{ path: string; bytes: Buffer }>;
} {
  const layout = layoutForRunRoot(runRoot, path.basename(runRoot));
  const graph = readPlannedGraphDocument(layout.graphPath);
  const candidates = graph.nodes.filter((node) => node.logical_id === logicalNodeId);
  assert.equal(candidates.length, 1, `fixtures require exactly one planned ${logicalNodeId} attempt`);
  const plannedNode = candidates[0]!;
  const attemptId = plannedNode.id;
  const artifactDir = path.join(layout.artifactsDir, attemptId);
  const snapshots = plannedNode.outputs.map((output) => ({
    output,
    path: output.path,
    bytes: fs.readFileSync(path.join(artifactDir, output.path))
  }));
  const outputPaths = new Set(snapshots.map((snapshot) => snapshot.path));
  const additionalPublications = additionalPublicationPaths.map((publicationPath) => {
    assert.equal(outputPaths.has(publicationPath), false, `duplicate fixture publication ${publicationPath}`);
    return { path: publicationPath, bytes: fs.readFileSync(path.join(artifactDir, publicationPath)) };
  });
  const publications = [...snapshots, ...additionalPublications];
  fs.mkdirSync(path.join(layout.root, ".ultrafuzz-verification"), { recursive: true });
  writeJsonRecord(path.join(layout.root, ".ultrafuzz-verification", `${attemptId}.json`), {
    schema_version: ARTIFACT_VERIFICATION_SCHEMA_VERSION,
    attempt_id: attemptId,
    node_id: plannedNode.logical_id,
    artifacts: snapshots.map(({ output, bytes }) => ({ ...output, sha256: digest(bytes) })),
    publications: publications.map(({ path: publicationPath, bytes }) => ({
      path: publicationPath,
      sha256: digest(bytes)
    }))
  });
  return { layout, plannedNode, attemptId, artifactDir, snapshots, publications };
}

function digest(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

interface FinalReportByteSnapshot {
  json: Buffer;
  markdown: Buffer;
  jsonSha256: string;
  markdownSha256: string;
}

function snapshotFinalReport(reportDir: string): FinalReportByteSnapshot {
  const json = fs.readFileSync(path.join(reportDir, "report.json"));
  const markdown = fs.readFileSync(path.join(reportDir, "report.md"));
  return {
    json,
    markdown,
    jsonSha256: digest(json),
    markdownSha256: digest(markdown)
  };
}

function assertFinalReportUnchanged(reportDir: string, expected: FinalReportByteSnapshot): void {
  const actual = snapshotFinalReport(reportDir);
  assert.deepEqual(actual.json, expected.json);
  assert.deepEqual(actual.markdown, expected.markdown);
  assert.equal(actual.jsonSha256, expected.jsonSha256);
  assert.equal(actual.markdownSha256, expected.markdownSha256);
}

function assertBundledFinalReport(zip: AdmZip, expected: FinalReportByteSnapshot): void {
  const bundledJson = zip.readFile("artifacts/final-report/report.json");
  const bundledMarkdown = zip.readFile("artifacts/final-report/report.md");
  assert.ok(bundledJson);
  assert.ok(bundledMarkdown);
  assert.deepEqual(bundledJson, expected.json);
  assert.deepEqual(bundledMarkdown, expected.markdown);
  assert.equal(digest(bundledJson), expected.jsonSha256);
  assert.equal(digest(bundledMarkdown), expected.markdownSha256);
}

function accountingMismatchCount(value: Record<string, unknown>): number {
  return (
    (value.diagnostics as Array<{ code?: string }> | undefined)?.filter(
      (diagnostic) => diagnostic.code === "REPORT_ACCOUNTING_MISMATCH"
    ).length ?? 0
  );
}

async function createReportRun(project: string, runId: string): Promise<{ run_id: string; run_root: string }> {
  assert.equal((await cli(project, ["init", "--force"])).code, 0);
  writeReportTopology(project);
  const run = await cli(project, ["run", "--run-id", runId, "--json"], fakeSmithersEnv(project));
  assert.equal(run.code, 0, `${run.stderr}\n${run.stdout}`);
  return parseJson(run).data as { run_id: string; run_root: string };
}

function bundleFixtureEvent(runId: string) {
  return createEventRecord(
    { runId },
    {
      eventType: "findings-validated",
      nodeId: "final-report",
      status: "succeeded",
      timestamp: "2026-08-09T00:00:00.000Z",
      payload: { count: 1, path: "artifacts/final-report/report.json" }
    }
  );
}

function writeJsonRecord(filePath: string, value: Record<string, unknown>): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("init and validate emit schema-versioned launch JSON", async () => {
  const project = tempProject();
  fs.writeFileSync(path.join(project, "ultrafuzz.toml"), "# owned\n", "utf8");

  const init = await cli(project, ["init", "--json"]);
  assert.equal(init.code, 0, init.stderr);
  const initBody = parseJson(init);
  assertNoSmithersSurface(initBody);
  assert.equal((initBody.data as { preserved: string[] }).preserved.includes("ultrafuzz.toml"), true);

  const validate = await cli(project, ["validate", "--json"]);
  const body = parseJson(validate);
  assert.equal(validate.code, 0, validate.stderr);
  assertNoSmithersSurface(body);
  assert.equal(body.schema_version, "ultrafuzz.cli.result.v2");
  const posture = (body.data as { policy_posture: Record<string, unknown> }).policy_posture;
  for (const key of ["config", "topology", "prompts", "paths", "agents", "trust"]) {
    assert.equal(Boolean(posture[key]), true, `${key} posture missing`);
  }
  assert.equal("repository_mutation" in posture, false);
});

test("plain init surfaces a customized stale agent adapter diagnostic", async () => {
  const project = tempProject();
  const initial = await cli(project, ["init", "--force"]);
  assert.equal(initial.code, 0, initial.stderr);

  const adapterPath = path.join(project, ".smithers", "agents", "codex.ts");
  const customAdapter = 'export const customConfigPath = "ultrafuzz.toml";\n';
  fs.writeFileSync(adapterPath, customAdapter, "utf8");

  const result = await cli(project, ["init"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /warning: INIT_AGENT_ADAPTER_UPDATE_REQUIRED:/u);
  assert.match(result.stdout, /ULTRAFUZZ_CONFIG_PATH/u);
  assert.equal(fs.readFileSync(adapterPath, "utf8"), customAdapter);
});

test("run exposes the trusted reference expectation catalog option", async () => {
  const project = tempProject();
  assert.equal((await cli(project, ["init", "--force"])).code, 0);
  writeSmallTopology(project);
  const run = await cli(
    project,
    ["run", "--run-id", "catalog-cli-run", "--reference-expectations", "missing.json", "--json"],
    fakeSmithersEnv(project)
  );
  assert.equal(run.code, 1, run.stderr);
  const body = parseJson(run);
  assert.equal(
    (body.diagnostics as Array<{ code?: string }>).some(
      (diagnostic) => diagnostic.code === "REFERENCE_EXPECTATIONS_INVALID" || diagnostic.code === "ENOENT"
    ),
    true
  );
});

test("run input flags are explicit, strict, and never reinterpret malformed inline JSON as a path", async () => {
  const project = tempProject();
  fs.writeFileSync(path.join(project, "looks-like-a-path.json"), '{"loaded":true}\n', "utf8");

  const malformedInline = await cli(project, ["run", "--input-json", "looks-like-a-path.json", "--json"]);
  assert.equal(malformedInline.code, 1);
  assert.match(JSON.stringify(parseJson(malformedInline).diagnostics), /inline workflow input.*strict JSON/iu);

  const duplicateInline = await cli(project, ["run", "--input-json", '{"ticket":1,"ticket":2}', "--json"]);
  assert.equal(duplicateInline.code, 1);
  assert.match(JSON.stringify(parseJson(duplicateInline).diagnostics), /duplicate property name/iu);

  const mutuallyExclusive = await cli(project, [
    "run",
    "--input-json",
    "{}",
    "--input-file",
    "looks-like-a-path.json",
    "--json"
  ]);
  assert.equal(mutuallyExclusive.code, 2);
  assert.deepEqual(parseJson(mutuallyExclusive).data, null);
  assert.match(JSON.stringify(parseJson(mutuallyExclusive).diagnostics), /cannot also be provided/iu);

  const legacyInput = await cli(project, ["run", "--input", "{}", "--json"]);
  assert.equal(legacyInput.code, 2);
  assert.deepEqual(parseJson(legacyInput).data, null);
  assert.match(JSON.stringify(parseJson(legacyInput).diagnostics), /Nonexistent flag: --input/iu);

  const symlink = path.join(project, "operator-input-link.json");
  fs.symlinkSync(path.join(project, "looks-like-a-path.json"), symlink);
  const linkedInput = await cli(project, ["run", "--input-file", symlink, "--json"]);
  assert.equal(linkedInput.code, 1);
  assert.match(JSON.stringify(parseJson(linkedInput).diagnostics), /cannot open regular file/iu);
});

test("run reads a bounded immutable workflow-input file", async () => {
  const project = tempProject();
  assert.equal((await cli(project, ["init", "--force"])).code, 0);
  writeSmallTopology(project);
  fs.writeFileSync(path.join(project, "operator-input.json"), '{"ticket":3}\n', "utf8");

  const run = await cli(
    project,
    ["run", "--run-id", "cli-file-input", "--input-file", "operator-input.json", "--json"],
    fakeSmithersEnv(project)
  );
  assert.equal(run.code, 0, run.stderr);
  const runData = parseJson(run).data as { run_root: string };
  const smithersInput = JSON.parse(fs.readFileSync(path.join(runData.run_root, "smithers", "input.json"), "utf8")) as {
    operator_input?: { ticket?: number };
  };
  assert.equal(smithersInput.operator_input?.ticket, 3);
});

test("run, ps, status, inspect, report, materialize, clean, and lifecycle commands expose product workflow evidence", async () => {
  const project = tempProject();
  assert.equal((await cli(project, ["init", "--force"])).code, 0);
  writeReportTopology(project);

  const env = fakeSmithersEnv(project, true);
  const run = await cli(
    project,
    [
      "run",
      "--run-id",
      "cli-run",
      "--max-concurrency",
      "2",
      "--prompt",
      "Operator prompt",
      "--input-json",
      '{"ticket":2}',
      "--json"
    ],
    env
  );
  assert.equal(run.code, 0, run.stderr);
  const runBody = parseJson(run);
  assertNoSmithersSurface(runBody);
  const runData = runBody.data as { run_id: string; run_root: string; status: string; workflow_ids: string[] };
  assert.equal(runData.status, "running");
  assert.deepEqual(runData.workflow_ids, ["ultrafuzz-cli-run"]);
  const smithersInput = JSON.parse(fs.readFileSync(path.join(runData.run_root, "smithers", "input.json"), "utf8")) as {
    operator_prompt?: string;
    operator_input?: { ticket?: number };
  };
  assert.equal(smithersInput.operator_prompt, "Operator prompt");
  assert.equal(smithersInput.operator_input?.ticket, 2);

  const ps = await cli(project, ["ps", "--json"], env);
  assert.equal(ps.code, 0, ps.stderr);
  const psBody = parseJson(ps);
  assertNoSmithersSurface(psBody);
  const psData = psBody.data as { runs: Array<{ workflow_run_id: string; ultrafuzz_run_id?: string }> };
  assert.equal(psData.runs.length, 1);
  assert.equal(psData.runs[0]?.workflow_run_id, "ultrafuzz-cli-run");
  assert.equal(psData.runs[0]?.ultrafuzz_run_id, "cli-run");
  assert.equal("smithers" in (psBody.data as Record<string, unknown>), false);

  const inspect = await cli(project, ["inspect", runData.run_id, "--json"], env);
  assert.equal(inspect.code, 0, `${inspect.stderr}\n${inspect.stdout}`);
  const inspectBody = parseJson(inspect);
  assertNoSmithersSurface(inspectBody);
  const inspectData = inspectBody.data as {
    metadata: { workflow: { run_id: string } };
    state: { provenance?: { workflow?: Record<string, unknown> } };
    workflow: { run_id: string; inspect: { ok: boolean }; events: { ok: boolean } };
  };
  assert.equal(inspectData.metadata.workflow.run_id, "ultrafuzz-cli-run");
  assert.equal(inspectData.workflow.run_id, "ultrafuzz-cli-run");
  assert.equal(inspectData.workflow.inspect.ok, true);
  assert.equal(inspectData.workflow.events.ok, true);
  assert.equal(Object.hasOwn(inspectData.state.provenance?.workflow ?? {}, "executionSnapshot"), false);

  const status = await cli(project, ["status", runData.run_id, "--window", "5", "--json"], env);
  assert.equal(status.code, 0, `${status.stderr}\n${status.stdout}`);
  const statusBody = parseJson(status);
  assertNoSmithersSurface(statusBody);
  const statusData = statusBody.data as {
    run_id: string;
    verdict: string;
    counts: { in_progress: number };
    gating: Array<{ node_id: string }>;
    progress: { percent: number; remaining: number; total: number };
    eta: { available: boolean; seconds: number | null; basis: string | null };
    current_step: { running_count: number; elapsed_seconds: number | null };
  };
  assert.equal(statusData.run_id, "cli-run");
  assert.equal(statusData.verdict, "running-healthy");
  assert.equal(statusData.counts.in_progress, 1);
  assert.equal(statusData.gating[0]?.node_id, "project-discovery");
  assert.equal(statusData.progress.percent, 33);
  assert.equal(statusData.progress.remaining, 4);
  assert.equal(statusData.progress.total, 6);
  assert.equal(statusData.eta.available, true);
  assert.equal(statusData.eta.basis, "recent-throughput");
  assert.equal(statusData.eta.seconds, 1_200);
  assert.equal(statusData.current_step.running_count, 0);
  assert.equal(statusData.current_step.elapsed_seconds, null);

  const statePath = path.join(runData.run_root, "state.json");
  const runningState = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    status: string;
    nodes: Record<string, Record<string, unknown>>;
  };
  const firstNodeId = Object.keys(runningState.nodes)[0]!;
  runningState.nodes[firstNodeId] = {
    ...runningState.nodes[firstNodeId],
    status: "running",
    started_at: new Date(Date.now() - 600_000).toISOString()
  };
  fs.writeFileSync(statePath, `${JSON.stringify(runningState, null, 2)}\n`, "utf8");

  const statusText = await cli(project, ["status", runData.run_id, "--window", "5"], env);
  assert.equal(statusText.code, 0, statusText.stderr);
  assert.doesNotMatch(statusText.stdout, /smithers/iu);
  assert.match(statusText.stdout, /^Status: running-healthy \(running\)$/mu);
  assert.match(statusText.stdout, /^Progress: 33% \(2 finished \/ 1 running \/ 3 pending \/ 0 failed \/ 6 total\)$/mu);
  assert.match(statusText.stdout, /^ETA: 20 minutes$/mu);
  assert.match(statusText.stdout, /^Time on current step: 10 minutes on \S+$/mu);

  // Long-running steps roll over into hours and then days.
  for (const [elapsedMs, expected] of [
    [30_000, "less than a minute"],
    [60_000, "1 minute"],
    [5_400_000, "1h 30m"],
    [3 * 86_400_000, "3d 00h"]
  ] as const) {
    const rolled = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      nodes: Record<string, Record<string, unknown>>;
    };
    rolled.nodes[firstNodeId] = {
      ...rolled.nodes[firstNodeId],
      status: "running",
      started_at: new Date(Date.now() - elapsedMs).toISOString()
    };
    fs.writeFileSync(statePath, `${JSON.stringify(rolled, null, 2)}\n`, "utf8");
    const rolledText = await cli(project, ["status", runData.run_id], env);
    assert.equal(rolledText.code, 0, rolledText.stderr);
    assert.match(rolledText.stdout, new RegExp(`^Time on current step: ${expected} on \\S+$`, "mu"));
  }

  // Restore the 10-minute step for the watch assertions below.
  const restored = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    nodes: Record<string, Record<string, unknown>>;
  };
  restored.nodes[firstNodeId] = {
    ...restored.nodes[firstNodeId],
    status: "running",
    started_at: new Date(Date.now() - 600_000).toISOString()
  };
  fs.writeFileSync(statePath, `${JSON.stringify(restored, null, 2)}\n`, "utf8");

  const artifactDir = path.join(runData.run_root, "artifacts", "project-discovery");
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "stdout.txt"), "generated stdout\n", "utf8");
  writeArtifactManifest({
    layout: layoutForRunRoot(runData.run_root, runData.run_id),
    nodeId: "project-discovery",
    include: ["stdout.txt"],
    outputs: [
      {
        path: "stdout.txt",
        contract: "ultrafuzz/text@1",
        contract_digest: artifactContractDefinition("ultrafuzz/text@1").digest,
        primary: true
      }
    ]
  });
  writeVerifierNodeAuthority(runData.run_root, "project-discovery");

  const reportDir = writeFinalReportAccounting(runData.run_root, {
    tokensUsed: "123",
    estimatedSpend: "$0.46+",
    partialPricing: true
  });
  const reportSnapshot = snapshotFinalReport(reportDir);

  let resolveFirstStatusLine!: () => void;
  let rejectFirstStatusLine!: (error: Error) => void;
  let sawFirstStatusLine = false;
  const firstStatusLine = new Promise<void>((resolve, reject) => {
    resolveFirstStatusLine = resolve;
    rejectFirstStatusLine = reject;
  });
  const firstStatusTimeout = setTimeout(
    () => rejectFirstStatusLine(new Error("status watch did not emit its initial sample")),
    15_000
  );
  const watching = cli(project, ["status", runData.run_id, "--watch", "--interval", "1", "--json"], env, (stdout) => {
    if (!sawFirstStatusLine && stdout.includes("\n")) {
      sawFirstStatusLine = true;
      resolveFirstStatusLine();
    }
  });
  try {
    await Promise.race([
      firstStatusLine,
      watching.then(() => {
        throw new Error("status watch completed before emitting its initial sample");
      })
    ]);
  } catch (error) {
    const terminalState = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(statePath, `${JSON.stringify({ ...terminalState, status: "succeeded" }, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(project, "fake-smithers-inspect-state"), "succeeded\n", "utf8");
    await watching;
    throw error;
  } finally {
    clearTimeout(firstStatusTimeout);
  }
  const terminalState = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(statePath, `${JSON.stringify({ ...terminalState, status: "succeeded" }, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(project, "fake-smithers-inspect-state"), "succeeded\n", "utf8");
  const watched = await watching;
  assert.equal(watched.code, 0, `${watched.stderr}\n${watched.stdout}`);
  const watchedLines = watched.stdout.split("\n").filter(Boolean);
  assert.equal(watchedLines.length, 2);
  const watchedEnvelopes = watchedLines.map((line) => JSON.parse(line) as Record<string, unknown>);
  for (const body of watchedEnvelopes) {
    assertNoSmithersSurface(body);
    assert.equal(body.command, "status");
    assert.equal(body.ok, true);
  }
  assert.equal((watchedEnvelopes[0]!.data as { status: string }).status, "running");
  assert.equal((watchedEnvelopes[1]!.data as { status: string }).status, "succeeded");

  writeRunAccounting(runData.run_root, {
    totalTokens: 123,
    tokensUsed: "123",
    estimatedSpend: "$0.46+",
    partialPricing: true,
    unpricedEventCount: 1
  });
  const report = await cli(project, ["report", runData.run_id, "--json"]);
  assert.equal(report.code, 0, report.stderr);
  const reportBody = parseJson(report);
  assertNoSmithersSurface(reportBody);
  assert.equal((reportBody.data as { json_path?: string }).json_path, path.join(reportDir, "report.json"));
  assert.equal(accountingMismatchCount(reportBody), 0);
  const reportMarkdown = fs.readFileSync(path.join(reportDir, "report.md"), "utf8");
  assert.match(reportMarkdown, /- Tokens used: `123`/u);
  assert.match(reportMarkdown, /- Estimated spend: `\$0\.46\+`/u);
  assertFinalReportUnchanged(reportDir, reportSnapshot);

  const escapedReport = await cli(project, ["report", "../../outside", "--json"]);
  const escapedReportBody = parseJson(escapedReport);
  assert.equal(escapedReportBody.ok, false);
  assertNoSmithersSurface(escapedReportBody);
  assert.match(JSON.stringify(escapedReportBody.diagnostics), /run ID/);

  const materialize = await cli(project, [
    "materialize",
    runData.run_id,
    "--copy",
    "artifacts/project-discovery/stdout.txt:materialized/stdout.txt",
    "--yes",
    "--json"
  ]);
  assert.equal(materialize.code, 0, `${materialize.stderr}\n${materialize.stdout}`);
  assertNoSmithersSurface(parseJson(materialize));
  assert.equal(fs.existsSync(path.join(project, "materialized", "stdout.txt")), true);

  const clean = await cli(project, [
    "clean",
    runData.run_id,
    "--select",
    "runs/cli-run/artifacts/project-discovery",
    "--yes",
    "--json"
  ]);
  assert.equal(clean.code, 0, clean.stderr);
  assertNoSmithersSurface(parseJson(clean));
  assert.equal(fs.existsSync(path.join(runData.run_root, "artifacts", "project-discovery")), false);

  for (const command of ["resume", "replay"]) {
    const args =
      command === "resume"
        ? [command, runData.run_id, "--max-concurrency", "8", "--json"]
        : [command, runData.run_id, "--json"];
    const lifecycle = await cli(project, args, env);
    assert.equal(lifecycle.code, 0, `${command}: ${lifecycle.stderr}${lifecycle.stdout}`);
    const lifecycleBody = parseJson(lifecycle);
    assertNoSmithersSurface(lifecycleBody);
    const lifecycleData = lifecycleBody.data as { submitted: boolean; workflow_run_id: string };
    assert.equal(lifecycleData.submitted, true);
    assert.equal(
      lifecycleData.workflow_run_id,
      command === "replay" ? "ultrafuzz-cli-run-replayed" : "ultrafuzz-cli-run"
    );
  }

  const retried = await cli(
    project,
    ["resume", runData.run_id, "--reset-node", "node:project-discovery", "--max-concurrency", "8", "--json"],
    env
  );
  assert.equal(retried.code, 0, `resume reset: ${retried.stderr}${retried.stdout}`);
  const retriedBody = parseJson(retried);
  assertNoSmithersSurface(retriedBody);
  const retriedData = retriedBody.data as { submitted: boolean; workflow_run_id: string };
  assert.equal(retriedData.submitted, true);
  assert.equal(retriedData.workflow_run_id, "ultrafuzz-cli-run-replayed");

  const fork = await cli(
    project,
    [
      "fork",
      runData.run_id,
      "--frame",
      "44",
      "--reset-node",
      "node:project-discovery",
      "--label",
      "after-edit",
      "--max-concurrency",
      "8",
      "--json"
    ],
    env
  );
  assert.equal(fork.code, 0, `fork: ${fork.stderr}${fork.stdout}`);
  const forkBody = parseJson(fork);
  assertNoSmithersSurface(forkBody);
  const forkData = forkBody.data as { submitted: boolean; workflow_run_id: string };
  assert.equal(forkData.submitted, true);
  assert.equal(forkData.workflow_run_id, "ultrafuzz-cli-run-forked");

  const pause = await cli(project, ["pause", runData.run_id, "--json"], env);
  assert.equal(pause.code, 0, pause.stderr);
  const pauseBody = parseJson(pause);
  assertNoSmithersSurface(pauseBody);
  const pauseData = pauseBody.data as { action: string; status: string; submitted: boolean };
  assert.equal(pauseData.action, "pause");
  assert.equal(pauseData.status, "pause-requested");
  assert.equal(pauseData.submitted, true);
});

test("status --watch --json keeps a failing poll on one NDJSON line", async () => {
  const project = tempProject();
  const env = fakeSmithersEnv(project);
  const init = await cli(project, ["init", "--json"], env);
  assert.equal(init.code, 0, init.stderr);
  writeSmallTopology(project);
  const run = await cli(project, ["run", "--run-id", "watch-failure-run", "--json"], env);
  assert.equal(run.code, 0, run.stderr);
  const runRoot = (parseJson(run).data as { run_root: string }).run_root;
  // A corrupt state.json now fails closed while verifying sealed control
  // evidence; the typed failure must stay newline-delimited for `jq` consumers.
  fs.writeFileSync(path.join(runRoot, "state.json"), "{ not json", "utf8");

  const watched = await cli(project, ["status", "watch-failure-run", "--watch", "--json"], env);

  assert.equal(watched.code, 1);
  const lines = watched.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const body = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(body.ok, false);
  assert.equal(body.command, "status");
  assert.equal((body.diagnostics as Array<{ code: string }>)[0]?.code, "WORKFLOW_CONTROL_EVIDENCE_INVALID");
});

test("old commands and backend flags are rejected instead of aliased or shimmed", async () => {
  const project = tempProject();
  assert.equal((await cli(project, ["init", "--force"])).code, 0);

  for (const argv of [
    ["doctor", "--json"],
    ["list", "--json"],
    ["restart", "cli-run", "--json"],
    ["continue", "cli-run", "--json"],
    ["dashboard", "--json"],
    ["triage", "cli-run", "--json"],
    ["review", "cli-run", "--json"],
    ["run", "--backend", "mock", "--json"],
    ["materialize", "cli-run", "--patch", "artifacts/node/patch.diff", "--yes", "--json"]
  ]) {
    const rejected = await cli(project, argv);
    assert.notEqual(rejected.code, 0, argv.join(" "));
    const body = parseJson(rejected);
    assert.equal(body.ok, false, JSON.stringify(body));
  }
});

test("references status is restored and reports offline cache state", async () => {
  const project = tempProject();
  assert.equal((await cli(project, ["init", "--force"])).code, 0);
  const previousXdgCacheHome = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = path.join(project, "empty-cache");
  try {
    const status = await cli(project, ["references", "status", "--json"]);
    const body = parseJson(status);

    assert.equal(status.code, 1);
    assert.equal(body.command, "references status");
    assert.equal(body.ok, false);
    const data = body.data as { references?: Array<{ id: string; ok: boolean }> };
    assert.equal(data.references?.length, 9);
    assert.equal(
      data.references?.some((reference) => reference.id === "properties.certora-thinking"),
      true
    );
    assert.equal(
      data.references?.every((reference) => reference.ok === false),
      true
    );
    assert.match(JSON.stringify(body.diagnostics), /ultrafuzz references sync/u);
  } finally {
    if (previousXdgCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = previousXdgCacheHome;
    }
  }
});

test("runtime command failures emit a failing exit code with JSON", async () => {
  const project = tempProject();
  assert.equal((await cli(project, ["init", "--force"])).code, 0);
  writeSmallTopology(project);

  const failed = await cli(project, ["run", "--run-id", "missing-agent", "--agent", "MissingAgent", "--json"]);
  assert.equal(failed.code, 1);
  assert.equal(failed.stderr, "");
  const body = parseJson(failed);
  assert.equal(body.ok, false, JSON.stringify(body));
  assertNoSmithersSurface(body);
  assert.match(JSON.stringify(body.diagnostics), /AGENT_REFERENCE_UNKNOWN/);
});

test("report accepts populated accounting snapshots and preserves partial-pricing marker", async () => {
  const project = tempProject();
  assert.equal((await cli(project, ["init", "--force"])).code, 0);
  writeReportTopology(project);

  const env = fakeSmithersEnv(project);
  const run = await cli(project, ["run", "--run-id", "report-accounting", "--json"], env);
  assert.equal(run.code, 0, run.stderr);
  const runData = parseJson(run).data as { run_id: string; run_root: string };

  writeRunAccounting(runData.run_root, {
    totalTokens: 56_523,
    tokensUsed: "56,523",
    estimatedSpend: "$0.16+",
    partialPricing: true
  });
  const reportDir = writeFinalReportAccounting(runData.run_root, {
    tokensUsed: "56,523",
    estimatedSpend: "$0.16+",
    partialPricing: true
  });
  const initialSnapshot = snapshotFinalReport(reportDir);

  const initialReport = await cli(project, ["report", runData.run_id, "--json"]);
  assert.equal(initialReport.code, 0, initialReport.stderr);
  const initialBody = parseJson(initialReport);
  assert.equal(accountingMismatchCount(initialBody), 0);
  assert.equal((initialBody.data as { json_path?: string }).json_path, path.join(reportDir, "report.json"));
  assertFinalReportUnchanged(reportDir, initialSnapshot);

  writeRunAccounting(runData.run_root, {
    totalTokens: 725_905,
    tokensUsed: "725,905",
    estimatedSpend: "$1.98+",
    partialPricing: true
  });

  const postSyncReport = await cli(project, ["report", runData.run_id, "--json"]);
  assert.equal(postSyncReport.code, 0, postSyncReport.stderr);
  assert.equal(accountingMismatchCount(parseJson(postSyncReport)), 0);
  assertFinalReportUnchanged(reportDir, initialSnapshot);

  writeFinalReportAccounting(runData.run_root, {
    tokensUsed: "56,523",
    estimatedSpend: "$0.16",
    partialPricing: true
  });
  const missingPlusSnapshot = snapshotFinalReport(reportDir);
  const missingPlusReport = await cli(project, ["report", runData.run_id, "--json"]);
  assert.equal(missingPlusReport.code, 0, missingPlusReport.stderr);
  assert.equal(accountingMismatchCount(parseJson(missingPlusReport)), 2);
  assertFinalReportUnchanged(reportDir, missingPlusSnapshot);

  writeRunAccounting(runData.run_root, {
    totalTokens: 725_905,
    tokensUsed: "725,905",
    estimatedSpend: "$1.98",
    partialPricing: true,
    unpricedEventCount: 0
  });
  const inconsistentPartialReport = await cli(project, ["report", runData.run_id, "--json"]);
  assert.equal(inconsistentPartialReport.code, 0, inconsistentPartialReport.stderr);
  assert.equal(accountingMismatchCount(parseJson(inconsistentPartialReport)), 2);
  assertFinalReportUnchanged(reportDir, missingPlusSnapshot);

  writeRunAccounting(runData.run_root, {
    totalTokens: 725_905,
    tokensUsed: "725,905",
    estimatedSpend: "$1.98",
    partialPricing: false,
    unpricedEventCount: 0
  });
  writeFinalReportAccounting(runData.run_root, {
    tokensUsed: "56,523",
    estimatedSpend: "$0.16",
    partialPricing: false
  });
  const estimatedSnapshot = snapshotFinalReport(reportDir);
  const estimatedReport = await cli(project, ["report", runData.run_id, "--json"]);
  assert.equal(estimatedReport.code, 0, estimatedReport.stderr);
  assert.equal(accountingMismatchCount(parseJson(estimatedReport)), 0);
  assertFinalReportUnchanged(reportDir, estimatedSnapshot);
});

test("report validates current artifacts without rewriting agent-owned bytes", async () => {
  const project = tempProject();
  const runData = await createReportRun(project, "report-current-artifacts");
  const reportDir = path.join(runData.run_root, "artifacts", "final-report");
  const reportPath = path.join(reportDir, "report.json");
  const markdownPath = path.join(reportDir, "report.md");
  fs.mkdirSync(reportDir, { recursive: true });
  writeCanonicalReportPair(reportDir, currentReport(runData.run_id));
  sealVerifiedFinalReport(runData.run_root);
  const reportSnapshot = snapshotFinalReport(reportDir);
  const jsonBefore = reportSnapshot.json;
  const markdownBefore = reportSnapshot.markdown;

  const result = await cli(project, ["report", runData.run_id, "--json"]);

  assert.equal(result.code, 0, result.stderr);
  const data = parseJson(result).data as { json_path: string; markdown_path: string; source: string };
  assert.equal(data.json_path, reportPath);
  assert.equal(data.markdown_path, markdownPath);
  assert.equal(data.source, "verified-agent-report");
  assert.deepEqual(fs.readFileSync(reportPath), jsonBefore);
  assert.deepEqual(fs.readFileSync(markdownPath), markdownBefore);
  assertFinalReportUnchanged(reportDir, reportSnapshot);
});

test("eval report validates the registered summary and never synthesizes missing Markdown", async () => {
  const project = tempProject();
  const evalRunId = "eval-report-strict";
  const runRoot = path.join(project, ".ultrafuzz", "evals", "runs", evalRunId);
  const summaryPath = path.join(runRoot, "summary.json");
  const markdownPath = path.join(runRoot, "summary.md");
  fs.mkdirSync(runRoot, { recursive: true });
  const sha256 = "a".repeat(64);
  const summary = {
    schema_version: "ultrafuzz.eval.score-summary.v2",
    eval_run_id: evalRunId,
    eval_run_root: runRoot,
    recall_threshold: 0.7,
    rows: [],
    variants: [],
    scores_path: path.join(runRoot, "scores.jsonl"),
    summary_path: summaryPath,
    review_queue_path: path.join(runRoot, "review", "new-findings.jsonl"),
    recovery_equivalence: {
      aggregate_non_comparable: "include",
      included_row_count: 0,
      excluded_row_count: 0,
      classification_counts: {
        clean: 0,
        "infrastructure-recovered": 0,
        "model-reexecuted-within-policy": 0,
        "non-comparable": 0
      },
      non_comparable_variants: []
    },
    provenance: {
      availability: "available",
      candidate: { label: "candidate", commit: "a".repeat(40), dirty: false },
      benchmark: {
        availability: "available",
        series: "series",
        protocol_revision: "protocol-v1",
        cohort_fingerprint: sha256,
        targets: [],
        ground_truth_sha256: {},
        ground_truth_subjects: {},
        execution_policy: {
          revision: "policy-v1",
          fingerprint: sha256,
          max_parallel_targets: null,
          max_parallel_runs: 1,
          node_telemetry: true,
          heartbeat_interval_seconds: 60,
          controller_mode: "watch",
          watch_timeout_seconds: 60,
          poll_interval_ms: 100,
          recovery_equivalence_fingerprint: sha256
        }
      },
      scoring: {
        implementation_revision: "a".repeat(40),
        implementation_dirty: false,
        judge_mode: "deterministic",
        judge_prompt_version: "judge-v1",
        judge_models: ["judge-model"],
        judge_panel: { total: 1, quorum: 1 },
        ground_truth_sha256: {},
        ground_truth_subjects: {},
        fingerprint: sha256
      }
    }
  };
  writeJsonRecord(summaryPath, summary);
  const summaryBytes = fs.readFileSync(summaryPath);

  const missingMarkdown = await cli(project, ["eval", "report", evalRunId, "--json"]);
  assert.equal(missingMarkdown.code, 1);
  assert.match(JSON.stringify(parseJson(missingMarkdown).diagnostics), /summary\.md|ENOENT/iu);
  assert.deepEqual(fs.readFileSync(summaryPath), summaryBytes);

  fs.writeFileSync(markdownPath, "# Canonical eval summary\n", "utf8");
  writeJsonRecord(summaryPath, { ...summary, unexpected: true });
  const invalidBytes = fs.readFileSync(summaryPath);
  const invalidSummary = await cli(project, ["eval", "report", evalRunId, "--json"]);
  assert.equal(invalidSummary.code, 1);
  assert.match(JSON.stringify(parseJson(invalidSummary).diagnostics), /additional propert/iu);
  assert.deepEqual(fs.readFileSync(summaryPath), invalidBytes);

  writeJsonRecord(summaryPath, summary);
  const valid = await cli(project, ["eval", "report", evalRunId, "--json"]);
  assert.equal(valid.code, 0, valid.stderr);
  assert.equal((parseJson(valid).data as { eval_run_id: string }).eval_run_id, evalRunId);
});

test("report rejects final_severity compatibility aliases without rewriting artifacts", async () => {
  const project = tempProject();
  const runData = await createReportRun(project, "report-rejects-severity-alias");
  const reportDir = path.join(runData.run_root, "artifacts", "final-report");
  const reportPath = path.join(reportDir, "report.json");
  const markdownPath = path.join(reportDir, "report.md");
  fs.mkdirSync(reportDir, { recursive: true });
  writeJsonRecord(reportPath, currentReport(runData.run_id, [{ ...currentReportIssue(), final_severity: "Medium" }]));
  fs.writeFileSync(markdownPath, "# Agent-authored report\n", "utf8");
  sealVerifiedFinalReport(runData.run_root);
  const reportSnapshot = snapshotFinalReport(reportDir);
  const jsonBefore = reportSnapshot.json;
  const markdownBefore = reportSnapshot.markdown;

  const result = await cli(project, ["report", runData.run_id, "--json"]);

  assert.equal(result.code, 1);
  assert.match(JSON.stringify(parseJson(result).diagnostics), /ARTIFACT_SCHEMA_INVALID|additional propert/iu);
  assert.deepEqual(fs.readFileSync(reportPath), jsonBefore);
  assert.deepEqual(fs.readFileSync(markdownPath), markdownBefore);
  assertFinalReportUnchanged(reportDir, reportSnapshot);
});

test("report does not synthesize missing Markdown", async () => {
  const project = tempProject();
  const runData = await createReportRun(project, "report-missing-markdown");
  const reportDir = path.join(runData.run_root, "artifacts", "final-report");
  const reportPath = path.join(reportDir, "report.json");
  const markdownPath = path.join(reportDir, "report.md");
  fs.mkdirSync(reportDir, { recursive: true });
  writeJsonRecord(reportPath, currentReport(runData.run_id));
  const jsonBefore = fs.readFileSync(reportPath);
  const jsonSha256Before = digest(jsonBefore);

  const result = await cli(project, ["report", runData.run_id, "--json"]);

  assert.equal(result.code, 1);
  assert.match(
    JSON.stringify(parseJson(result).diagnostics),
    /no successful current verification\/finalization authority is available/iu
  );
  assert.equal(fs.existsSync(markdownPath), false);
  assert.deepEqual(fs.readFileSync(reportPath), jsonBefore);
  assert.equal(digest(fs.readFileSync(reportPath)), jsonSha256Before);
});

test("report accepts canonical severity and complete proof without rewriting either artifact", async () => {
  const project = tempProject();
  const runData = await createReportRun(project, "report-canonical-severity");
  const reportDir = path.join(runData.run_root, "artifacts", "final-report");
  const reportPath = path.join(reportDir, "report.json");
  const markdownPath = path.join(reportDir, "report.md");
  fs.mkdirSync(reportDir, { recursive: true });
  writeCanonicalReportPair(reportDir, currentReport(runData.run_id, [currentReportIssue()]));
  sealVerifiedFinalReport(runData.run_root);
  const reportSnapshot = snapshotFinalReport(reportDir);
  const jsonBefore = reportSnapshot.json;
  const markdownBefore = reportSnapshot.markdown;

  const result = await cli(project, ["report", runData.run_id, "--json"]);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(reportPath), jsonBefore);
  assert.deepEqual(fs.readFileSync(markdownPath), markdownBefore);
  assertFinalReportUnchanged(reportDir, reportSnapshot);
  const report = JSON.parse(jsonBefore.toString("utf8")) as { issues: Array<Record<string, unknown>> };
  assert.equal(report.issues[0]?.severity, "Medium");
  assert.equal(Object.hasOwn(report.issues[0] ?? {}, "final_severity"), false);
});

test("current reports with malformed issues fail closed without preserving stale bytes", async () => {
  const project = tempProject();
  const runData = await createReportRun(project, "report-current-malformed");
  const reportDir = path.join(runData.run_root, "artifacts", "final-report");
  const reportPath = path.join(reportDir, "report.json");
  const markdownPath = path.join(reportDir, "report.md");
  fs.mkdirSync(reportDir, { recursive: true });
  writeJsonRecord(
    reportPath,
    currentReport(runData.run_id, [
      {
        schema_version: FINDINGS_SCHEMA_VERSION,
        id: "malformed-current",
        title: "Malformed current issue",
        status: "confirmed",
        severity_guess: "Medium",
        confidence: "high",
        summary: "Missing required report evidence."
      }
    ])
  );
  fs.writeFileSync(markdownPath, "# Agent-authored malformed report\n", "utf8");
  sealVerifiedFinalReport(runData.run_root);
  const reportSnapshot = snapshotFinalReport(reportDir);
  const jsonBefore = reportSnapshot.json;
  const markdownBefore = reportSnapshot.markdown;

  const result = await cli(project, ["report", runData.run_id, "--json"]);

  assert.equal(result.code, 1);
  assert.match(JSON.stringify(parseJson(result).diagnostics), /ARTIFACT_SCHEMA_INVALID.*required/iu);
  assert.deepEqual(fs.readFileSync(reportPath), jsonBefore);
  assert.deepEqual(fs.readFileSync(markdownPath), markdownBefore);
  assertFinalReportUnchanged(reportDir, reportSnapshot);
});

test("legacy report versions are rejected without a compatibility reader", async () => {
  const project = tempProject();
  const runData = await createReportRun(project, "report-legacy-version");
  const reportDir = path.join(runData.run_root, "artifacts", "final-report");
  const reportPath = path.join(reportDir, "report.json");
  const markdownPath = path.join(reportDir, "report.md");
  fs.mkdirSync(reportDir, { recursive: true });
  writeJsonRecord(reportPath, { ...currentReport(runData.run_id), schema_version: "1.0" });
  fs.writeFileSync(markdownPath, "# Legacy report\n", "utf8");
  sealVerifiedFinalReport(runData.run_root);
  const reportSnapshot = snapshotFinalReport(reportDir);
  const jsonBefore = reportSnapshot.json;
  const markdownBefore = reportSnapshot.markdown;

  const result = await cli(project, ["report", runData.run_id, "--json"]);

  assert.equal(result.code, 1);
  assert.match(JSON.stringify(parseJson(result).diagnostics), /ARTIFACT_SCHEMA_INVALID.*constant/iu);
  assert.deepEqual(fs.readFileSync(reportPath), jsonBefore);
  assert.deepEqual(fs.readFileSync(markdownPath), markdownBefore);
  assertFinalReportUnchanged(reportDir, reportSnapshot);
});

test("agent-owned bytes stay identical across validation, sync, aggregation, report, dashboard, eval, and bundle reads", async () => {
  const project = tempProject();
  assert.equal((await cli(project, ["init", "--force"])).code, 0);
  writeByteIdentityTopology(project);
  const env = fakeSmithersEnv(project, true, ["aggregate-test-files"]);
  const launched = await cli(project, ["run", "--run-id", "byte-identity", "--json"], env);
  assert.equal(launched.code, 0, launched.stderr);
  const runData = parseJson(launched).data as { run_id: string; run_root: string };

  const discoveryPath = path.join(runData.run_root, "artifacts", "project-discovery", "stdout.txt");
  const aggregationPath = path.join(runData.run_root, "artifacts", "aggregate-test-files", "aggregation.json");
  const reportDir = path.join(runData.run_root, "artifacts", "final-report");
  const reportJsonPath = path.join(reportDir, "report.json");
  const reportMarkdownPath = path.join(reportDir, "report.md");
  fs.mkdirSync(path.dirname(discoveryPath), { recursive: true });
  fs.mkdirSync(path.dirname(aggregationPath), { recursive: true });
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(discoveryPath, "agent-authored discovery bytes\n", "utf8");
  writeJsonRecord(aggregationPath, {
    schema_version: "ultrafuzz.aggregation-manifest.v1",
    source_generated_tests: 0,
    copied_generated_tests: 0,
    source_support_files: 0,
    copied_support_files: 0,
    source_bundles: [],
    files: [],
    support_files: [],
    skipped_files: []
  });
  writeCanonicalReportPair(reportDir, currentReport(runData.run_id));

  const agentPaths = [discoveryPath, aggregationPath, reportMarkdownPath, reportJsonPath];
  const agentBytes = new Map(agentPaths.map((filePath) => [filePath, fs.readFileSync(filePath)] as const));
  const assertAgentBytesUnchanged = (): void => {
    for (const [filePath, expected] of agentBytes) assert.deepEqual(fs.readFileSync(filePath), expected, filePath);
  };

  for (const [schemaFilename, artifactPath] of [
    ["aggregation-manifest.schema.json", aggregationPath],
    ["report.schema.json", reportJsonPath]
  ] as const) {
    const validated = await cli(project, [
      "json",
      "validate",
      "--schema",
      path.join(artifactSchemaDirectory(), schemaFilename),
      "--file",
      artifactPath,
      "--json"
    ]);
    assert.equal(validated.code, 0, `${schemaFilename}: ${validated.stderr}${validated.stdout}`);
  }
  assertAgentBytesUnchanged();

  writeVerifierNodeAuthority(runData.run_root, "project-discovery");
  const aggregationAuthority = writeVerifierNodeAuthority(runData.run_root, "aggregate-test-files");
  fs.mkdirSync(path.join(runData.run_root, "workspaces", aggregationAuthority.attemptId), { recursive: true });
  writeVerifierNodeAuthority(runData.run_root, "final-report");
  fs.writeFileSync(path.join(project, "fake-smithers-inspect-state"), "succeeded\n", "utf8");
  const synchronized = await syncRun({ projectRoot: project, runId: runData.run_id, env });
  assert.equal(synchronized.ok, true, JSON.stringify(synchronized.diagnostics));
  assert.equal(synchronized.value?.status, "succeeded", JSON.stringify(synchronized.diagnostics));
  assertAgentBytesUnchanged();

  const verified = loadVerifiedRunOutputSnapshots(runData.run_root);
  assert.deepEqual(
    verified.map((snapshot) => snapshot.attempt_id),
    ["project-discovery", "aggregate-test-files", "final-report"]
  );
  const verifiedAggregation = verified
    .flatMap((snapshot) => snapshot.outputs)
    .find((output) => output.contract === "ultrafuzz/aggregation-manifest@1");
  assert.ok(verifiedAggregation);
  assert.deepEqual(verifiedAggregation.bytes, agentBytes.get(aggregationPath));
  assertAgentBytesUnchanged();

  const reported = await cli(project, ["report", runData.run_id, "--json"]);
  assert.equal(reported.code, 0, reported.stderr);
  assertAgentBytesUnchanged();

  const dashboard = await serveDashboard({ projectRoot: project, runId: runData.run_id, port: 0 });
  try {
    const reportResponse = await fetch(new URL("/api/report", dashboard.url));
    assert.equal(reportResponse.status, 200, await reportResponse.text());
    const findingsResponse = await fetch(new URL("/api/findings", dashboard.url));
    const findingsBody = await findingsResponse.text();
    assert.equal(findingsResponse.status, 200, findingsBody);
    assert.deepEqual(JSON.parse(findingsBody), {
      schema_version: DASHBOARD_HTTP_SCHEMA_VERSION,
      document_type: "findings",
      source: "artifacts/final-report/report.json",
      findings: []
    });
  } finally {
    await dashboard.close();
  }
  assertAgentBytesUnchanged();

  const uploads: EvalArtifactUpload[] = [];
  const reporter: EvalReporter = {
    name: "byte-identity",
    async onPlan() {},
    async onRowStart() {},
    async onNodeEvent() {},
    async onArtifact(artifact) {
      uploads.push(artifact);
    },
    async onRowFinish() {},
    async onScores() {},
    async finalize() {
      return {};
    }
  };
  const row: EvalMatrixRow = {
    id: "byte-identity-row",
    target_id: "target",
    variant_id: "variant",
    trial_id: "trial",
    run_id: runData.run_id,
    target: {
      id: "target",
      repo: "https://example.com/target.git",
      ref: "a".repeat(40),
      ground_truth: "target.yml",
      ground_truth_path: path.join(project, "target.yml"),
      sensitivity: "public"
    },
    variant: { id: "variant" },
    runner_model_profile: "runner",
    judge_model_profile: "judge"
  };
  const cursorPath = path.join(project, ".ultrafuzz", "evals", "byte-identity-cursor.json");
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  const telemetry = new NodeTelemetryPump({
    runRoot: runData.run_root,
    row,
    reporters: [reporter],
    policy: {
      node_telemetry: true,
      heartbeat_interval_seconds: 60,
      artifacts: {
        mode: "upload",
        mode_explicit: true,
        include: ["report.json", "report.md"],
        max_file_bytes: 1024 * 1024
      }
    },
    cursorPath,
    retryDelayMs: 0
  });
  const drained = await telemetry.drain();
  assert.deepEqual(drained.warnings, []);
  assert.deepEqual(uploads.map((upload) => upload.relativePath).sort(), ["report.json", "report.md"]);
  for (const upload of uploads) {
    assert.ok(upload.read);
    const expected =
      upload.relativePath === "report.json" ? agentBytes.get(reportJsonPath) : agentBytes.get(reportMarkdownPath);
    assert.deepEqual(await upload.read(), expected);
  }
  assertAgentBytesUnchanged();

  const bundled = await cli(project, ["report", "bundle", runData.run_id, "--json"]);
  assert.equal(bundled.code, 0, bundled.stderr);
  const bundlePath = (parseJson(bundled).data as { zip_path: string }).zip_path;
  const zip = new AdmZip(bundlePath);
  for (const [filePath, expected] of agentBytes) {
    const relativePath = path.relative(runData.run_root, filePath).split(path.sep).join("/");
    assert.deepEqual(zip.readFile(relativePath), expected, relativePath);
  }
  assertAgentBytesUnchanged();
});

test("report bundle creates a portable ZIP without workspaces", async () => {
  const project = tempProject();
  assert.equal((await cli(project, ["init", "--force"])).code, 0);
  writeReportTopology(project);

  const env = fakeSmithersEnv(project);
  const run = await cli(project, ["run", "--run-id", "report-bundle", "--json"], env);
  assert.equal(run.code, 0, run.stderr);
  const runData = parseJson(run).data as { run_id: string; run_root: string };

  const artifactDir = path.join(runData.run_root, "artifacts", "project-discovery");
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "stdout.txt"), "generated stdout\n", "utf8");
  const supportPublicationPath = "evidence/discovery-trace.txt";
  fs.mkdirSync(path.join(artifactDir, "evidence"), { recursive: true });
  fs.writeFileSync(path.join(artifactDir, supportPublicationPath), "authenticated discovery trace\n", "utf8");
  sealVerifiedNodeOutputs(runData.run_root, "project-discovery", [supportPublicationPath]);
  fs.writeFileSync(path.join(artifactDir, "bad\\name.txt"), "unsafe archive path\n", "utf8");
  const reportDir = writeFinalReportAccounting(runData.run_root, {
    tokensUsed: "123",
    estimatedSpend: "$0.46",
    partialPricing: false
  });
  const reportSnapshot = snapshotFinalReport(reportDir);
  const workspaceDir = path.join(runData.run_root, "workspaces", "project-discovery");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "large-cache.txt"), "do not bundle\n", "utf8");
  const engineLogDir = path.join(runData.run_root, "smithers", "logs");
  fs.mkdirSync(engineLogDir, { recursive: true });
  fs.writeFileSync(path.join(engineLogDir, "stream.ndjson"), '{"event":"retry"}\n', "utf8");
  fs.writeFileSync(path.join(engineLogDir, "node:project-discovery-0-1.ndjson"), '{"event":"agent"}\n', "utf8");
  fs.writeFileSync(path.join(engineLogDir, "node%3Aproject-discovery-0-1.ndjson"), '{"event":"literal"}\n', "utf8");
  fs.writeFileSync(path.join(engineLogDir, "CON.log"), '{"event":"device"}\n', "utf8");
  fs.writeFileSync(path.join(engineLogDir, "Trace.log"), '{"event":"uppercase"}\n', "utf8");
  fs.writeFileSync(path.join(engineLogDir, "trace.log"), '{"event":"lowercase"}\n', "utf8");

  const bundled = await cli(project, ["report", "bundle", runData.run_id, "--json"]);
  assert.equal(bundled.code, 0, bundled.stderr);
  assertFinalReportUnchanged(reportDir, reportSnapshot);
  const body = parseJson(bundled);
  assertNoSmithersSurface(body);
  assert.match(JSON.stringify(body.diagnostics), /REPORT_BUNDLE_FILE_SKIPPED/u);
  const data = body.data as { zip_path: string; bytes: number; sha256: string; entry_count: number };
  assert.equal(fs.existsSync(data.zip_path), true);
  assert.equal(data.bytes, fs.statSync(data.zip_path).size);
  assert.match(data.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(data.entry_count > 0, true);

  const zip = new AdmZip(data.zip_path);
  assertBundledFinalReport(zip, reportSnapshot);
  const entries = zip
    .getEntries()
    .filter((entry) => !entry.isDirectory)
    .map((entry) => entry.entryName)
    .sort();
  assert.equal(entries.includes("bundle-manifest.json"), true);
  const bundleManifest = JSON.parse(zip.readAsText("bundle-manifest.json")) as { schema_version?: unknown };
  assert.equal(bundleManifest.schema_version, "ultrafuzz.report-bundle-manifest.v3");
  assert.equal(validateReportBundleManifest(bundleManifest).ok, true);
  assert.equal(entries.includes("artifacts/final-report/report.md"), true);
  assert.equal(entries.includes("artifacts/final-report/report.json"), true);
  assert.equal(entries.includes("artifacts/project-discovery/stdout.txt"), true);
  assert.equal(entries.includes(`artifacts/project-discovery/${supportPublicationPath}`), true);
  assert.equal(
    zip.readAsText(`artifacts/project-discovery/${supportPublicationPath}`),
    "authenticated discovery trace\n"
  );
  assert.equal(entries.includes("run.json"), true);
  assert.equal(entries.includes("state.json"), true);
  assert.deepEqual(
    zip.readFile("graph.fingerprint"),
    fs.readFileSync(path.join(runData.run_root, "graph.fingerprint"))
  );
  assert.deepEqual(
    zip.readFile("artifacts/project-discovery/artifact-manifest.json"),
    fs.readFileSync(path.join(artifactDir, "artifact-manifest.json"))
  );
  assert.equal(
    entries.some((entry) => entry.startsWith("workspaces/")),
    false
  );
  assert.equal(
    entries.some((entry) => entry.includes("\\")),
    false
  );
  // Engine retry/validation evidence must reach an operator bundle, under a
  // neutral prefix so the archive never names the orchestration engine.
  const portableEnginePath = (name: string): string =>
    `engine-logs/entry-${crypto.createHash("sha256").update(name, "utf8").digest("hex")}`;
  const expectedEngineLogs = new Map([
    ["stream.ndjson", '{"event":"retry"}\n'],
    ["node:project-discovery-0-1.ndjson", '{"event":"agent"}\n'],
    ["node%3Aproject-discovery-0-1.ndjson", '{"event":"literal"}\n'],
    ["CON.log", '{"event":"device"}\n'],
    ["Trace.log", '{"event":"uppercase"}\n'],
    ["trace.log", '{"event":"lowercase"}\n']
  ]);
  for (const [name, content] of expectedEngineLogs) {
    assert.equal(entries.includes(portableEnginePath(name)), true);
    assert.equal(zip.readAsText(portableEnginePath(name)), content);
  }
  assert.equal(new Set([...expectedEngineLogs.keys()].map(portableEnginePath)).size, expectedEngineLogs.size);
  const mappedManifest = JSON.parse(zip.readAsText("bundle-manifest.json")) as {
    path_mappings: Array<{ source_path: string; archive_path: string }>;
  };
  assert.deepEqual(
    mappedManifest.path_mappings,
    [...expectedEngineLogs.keys()]
      .map((name) => ({ source_path: `engine-logs/${name}`, archive_path: portableEnginePath(name) }))
      .sort((left, right) => left.archive_path.localeCompare(right.archive_path))
  );
  assert.equal(
    entries.some((entry) => /smithers/iu.test(entry)),
    false
  );
  const bundledMarkdown = zip.readAsText("artifacts/final-report/report.md");
  assert.doesNotMatch(bundledMarkdown, /Placeholder/iu);
  assert.match(bundledMarkdown, /- Tokens used: `123`/u);
  assert.match(bundledMarkdown, /- Estimated spend: `\$0\.46`/u);
  const finalReportManifest = JSON.parse(zip.readAsText("artifacts/final-report/artifact-manifest.json")) as {
    files: Array<{ path: string; size_bytes: number; sha256: string }>;
  };
  for (const entry of finalReportManifest.files) {
    assert.ok(zip.getEntry(`artifacts/final-report/${entry.path}`), entry.path);
  }
  for (const relativePath of ["report.md", "report.json"]) {
    const bytes = zip.readFile(`artifacts/final-report/${relativePath}`);
    const entry = finalReportManifest.files.find((candidate) => candidate.path === relativePath);
    assert.ok(bytes, relativePath);
    assert.ok(entry, relativePath);
    assert.equal(entry.size_bytes, bytes.length);
    assert.equal(entry.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  }

  const existing = await cli(project, ["report", "bundle", runData.run_id, "--json"]);
  assert.equal(existing.code, 1);
  assert.match(JSON.stringify(parseJson(existing).diagnostics), /already exists/u);
  assertFinalReportUnchanged(reportDir, reportSnapshot);

  const forced = await cli(project, ["report", "bundle", runData.run_id, "--force", "--json"]);
  assert.equal(forced.code, 0, forced.stderr);
  assertFinalReportUnchanged(reportDir, reportSnapshot);
  assertBundledFinalReport(new AdmZip(data.zip_path), reportSnapshot);

  const customPath = "attachments/custom-report-bundle.zip";
  const custom = await cli(project, ["report", "bundle", runData.run_id, "--output", customPath, "--json"]);
  assert.equal(custom.code, 0, custom.stderr);
  const customData = parseJson(custom).data as { zip_path: string };
  assert.equal(customData.zip_path, path.join(project, customPath));
  assertFinalReportUnchanged(reportDir, reportSnapshot);
  assertBundledFinalReport(new AdmZip(customData.zip_path), reportSnapshot);

  const symlinkOutput = path.join(project, "attachments", "symlink-output.zip");
  fs.symlinkSync(path.join(project, "missing-target.zip"), symlinkOutput);
  const symlinkAttempt = await cli(project, [
    "report",
    "bundle",
    runData.run_id,
    "--output",
    symlinkOutput,
    "--force",
    "--json"
  ]);
  assert.equal(symlinkAttempt.code, 1);
  assert.match(JSON.stringify(parseJson(symlinkAttempt).diagnostics), /symlink/u);

  const realOutputDir = path.join(project, "real-output");
  const linkedOutputDir = path.join(project, "linked-output");
  fs.mkdirSync(realOutputDir, { recursive: true });
  fs.symlinkSync(realOutputDir, linkedOutputDir, "dir");
  const linkedParentAttempt = await cli(project, [
    "report",
    "bundle",
    runData.run_id,
    "--output",
    "linked-output/bundle.zip",
    "--json"
  ]);
  assert.equal(linkedParentAttempt.code, 1);
  assert.match(JSON.stringify(parseJson(linkedParentAttempt).diagnostics), /symlink/u);
  assertFinalReportUnchanged(reportDir, reportSnapshot);
});

test("report bundle rejects a changed authenticated publication from any finalized producer", async () => {
  const project = tempProject();
  const runData = await createReportRun(project, "report-bundle-mutated-publication");
  const artifactDir = path.join(runData.run_root, "artifacts", "project-discovery");
  const supportPublicationPath = "evidence/discovery-trace.txt";
  const supportPublication = path.join(artifactDir, supportPublicationPath);
  fs.mkdirSync(path.dirname(supportPublication), { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "stdout.txt"), "generated stdout\n", "utf8");
  fs.writeFileSync(supportPublication, "authenticated discovery trace\n", "utf8");
  sealVerifiedNodeOutputs(runData.run_root, "project-discovery", [supportPublicationPath]);

  const changedBytes = Buffer.from("post-finalization mutation!!!!\n", "utf8");
  fs.writeFileSync(supportPublication, changedBytes);
  const bundled = await cli(project, ["report", "bundle", runData.run_id, "--json"]);

  assert.equal(bundled.code, 1, bundled.stderr);
  assert.match(JSON.stringify(parseJson(bundled).diagnostics), /verified publication.*changed/iu);
  assert.deepEqual(fs.readFileSync(supportPublication), changedBytes);
  assert.equal(
    fs.existsSync(path.join(project, ".ultrafuzz", "bundles", `${runData.run_id}-report-bundle.zip`)),
    false
  );
});

test("report bundle rejects manifest bytes injected only into the recursive archive read", async () => {
  const project = tempProject();
  const runData = await createReportRun(project, "report-bundle-manifest-read-injection");
  const artifactDir = path.join(runData.run_root, "artifacts", "project-discovery");
  fs.writeFileSync(path.join(artifactDir, "stdout.txt"), "generated stdout\n", "utf8");
  sealVerifiedNodeOutputs(runData.run_root, "project-discovery");
  const manifestPath = path.join(artifactDir, "artifact-manifest.json");
  const manifestBytes = fs.readFileSync(manifestPath);

  const bundled = await withInjectedBundleCollectionRead(
    manifestPath,
    Buffer.alloc(manifestBytes.byteLength, 0x78),
    () => cli(project, ["report", "bundle", runData.run_id, "--json"])
  );

  assert.equal(bundled.code, 1, bundled.stderr);
  assert.match(JSON.stringify(parseJson(bundled).diagnostics), /artifact manifest authority changed/iu);
  assert.deepEqual(fs.readFileSync(manifestPath), manifestBytes);
  assert.equal(
    fs.existsSync(path.join(project, ".ultrafuzz", "bundles", `${runData.run_id}-report-bundle.zip`)),
    false
  );
});

test("report bundle rejects graph-fingerprint bytes injected only into the archive read", async () => {
  const project = tempProject();
  const runData = await createReportRun(project, "report-bundle-fingerprint-read-injection");
  const artifactDir = path.join(runData.run_root, "artifacts", "project-discovery");
  fs.writeFileSync(path.join(artifactDir, "stdout.txt"), "generated stdout\n", "utf8");
  sealVerifiedNodeOutputs(runData.run_root, "project-discovery");
  const fingerprintPath = path.join(runData.run_root, "graph.fingerprint");
  const fingerprintBytes = fs.readFileSync(fingerprintPath);

  const bundled = await withInjectedBundleCollectionRead(
    fingerprintPath,
    Buffer.alloc(fingerprintBytes.byteLength, 0x61),
    () => cli(project, ["report", "bundle", runData.run_id, "--json"])
  );

  assert.equal(bundled.code, 1, bundled.stderr);
  assert.match(JSON.stringify(parseJson(bundled).diagnostics), /run authority changed/iu);
  assert.deepEqual(fs.readFileSync(fingerprintPath), fingerprintBytes);
  assert.equal(
    fs.existsSync(path.join(project, ".ultrafuzz", "bundles", `${runData.run_id}-report-bundle.zip`)),
    false
  );
});

test("report bundle rejects a persistently tampered sealed graph fingerprint before writing a ZIP", async () => {
  const project = tempProject();
  const runData = await createReportRun(project, "report-bundle-fingerprint-persistent-tamper");
  const fingerprintPath = path.join(runData.run_root, "graph.fingerprint");
  const tamperedBytes = Buffer.from(`${"a".repeat(64)}\n`, "utf8");
  fs.writeFileSync(fingerprintPath, tamperedBytes);

  const bundled = await cli(project, ["report", "bundle", runData.run_id, "--json"]);

  assert.equal(bundled.code, 1, bundled.stderr);
  assert.match(JSON.stringify(parseJson(bundled).diagnostics), /graph fingerprint.*sealed workflow control/iu);
  assert.deepEqual(fs.readFileSync(fingerprintPath), tamperedBytes);
  assert.equal(
    fs.existsSync(path.join(project, ".ultrafuzz", "bundles", `${runData.run_id}-report-bundle.zip`)),
    false
  );
});

test("report bundle rejects a declared report producer that claims success without finalization authority", async () => {
  const project = tempProject();
  const runData = await createReportRun(project, "report-bundle-invalid-success-claim");
  const layout = layoutForRunRoot(runData.run_root, runData.run_id);
  updateNodeState(layout, "final-report", {
    status: "succeeded",
    finished_at: new Date().toISOString(),
    wait_since: undefined,
    wait_reason: undefined,
    next_eligible_action: undefined,
    provenance: undefined
  });

  const bundled = await cli(project, ["report", "bundle", runData.run_id, "--json"]);

  assert.equal(bundled.code, 1, bundled.stderr);
  assert.match(JSON.stringify(parseJson(bundled).diagnostics), /lacks current finalization authority/iu);
  assert.equal(
    fs.existsSync(path.join(project, ".ultrafuzz", "bundles", `${runData.run_id}-report-bundle.zip`)),
    false
  );
});

test("report bundle applies canonical report-pair validation to custom declarations", async () => {
  const project = tempProject();
  assert.equal((await cli(project, ["init", "--force"])).code, 0);
  writeCustomReportTopology(project);
  const run = await cli(
    project,
    ["run", "--run-id", "report-bundle-custom-declaration", "--json"],
    fakeSmithersEnv(project)
  );
  assert.equal(run.code, 0, `${run.stderr}\n${run.stdout}`);
  const runData = parseJson(run).data as { run_id: string; run_root: string };
  const reportDir = path.join(runData.run_root, "artifacts", "audit-delivery", "deliverables");
  fs.mkdirSync(reportDir, { recursive: true });
  const projection = projectCanonicalFinalReport(
    currentReport(runData.run_id, [], {
      tokens_used: "123",
      estimated_spend: "$0.46",
      partial_pricing: false,
      source_run_ids: []
    })
  );
  writeJsonRecord(path.join(reportDir, "current-audit.json"), projection.report);
  fs.writeFileSync(path.join(reportDir, "current-audit.md"), `${projection.markdown}\n<!-- drift -->\n`, "utf8");
  sealVerifiedNodeOutputs(runData.run_root, "audit-delivery");

  const bundled = await cli(project, ["report", "bundle", runData.run_id, "--json"]);

  assert.equal(bundled.code, 1, `${bundled.stderr}\n${bundled.stdout}`);
  assert.match(JSON.stringify(parseJson(bundled).diagnostics), /canonical projection/iu);
  assert.equal(
    fs.existsSync(path.join(project, ".ultrafuzz", "bundles", `${runData.run_id}-report-bundle.zip`)),
    false
  );
});

test("report bundle preserves the exact validated event-record-v2 journal snapshot", async () => {
  const project = tempProject();
  const runId = "report-bundle-event-snapshot";
  const runRoot = (await createReportRun(project, runId)).run_root;
  const record = bundleFixtureEvent(runId);
  const journalBytes = Buffer.from(`  ${JSON.stringify(record)}  \n`, "utf8");
  fs.writeFileSync(path.join(runRoot, "events.jsonl"), journalBytes);

  const bundled = await cli(project, ["report", "bundle", runId, "--json"]);

  assert.equal(bundled.code, 0, bundled.stderr);
  const data = parseJson(bundled).data as { zip_path: string };
  const captured = new AdmZip(data.zip_path).readFile("events.jsonl");
  assert.ok(captured);
  assert.deepEqual(captured, journalBytes);
});

test("report bundle treats only an absent event journal as optional", async () => {
  const project = tempProject();
  const runId = "report-bundle-no-event-journal";
  const runRoot = (await createReportRun(project, runId)).run_root;
  fs.rmSync(path.join(runRoot, "events.jsonl"), { force: true });

  const bundled = await cli(project, ["report", "bundle", runId, "--json"]);

  assert.equal(bundled.code, 0, bundled.stderr);
  const data = parseJson(bundled).data as { zip_path: string };
  const zip = new AdmZip(data.zip_path);
  assert.equal(zip.getEntry("events.jsonl"), null);
  assert.equal(zip.readAsText("graph.fingerprint"), fs.readFileSync(path.join(runRoot, "graph.fingerprint"), "utf8"));
});

test("report bundle rejects historical runs without current sealed workflow authority", async () => {
  const project = tempProject();
  assert.equal((await cli(project, ["init", "--force"])).code, 0);
  const runId = "report-bundle-historical-unsealed";
  const runRoot = path.join(project, ".ultrafuzz", "runs", runId);
  fs.mkdirSync(runRoot, { recursive: true });
  fs.writeFileSync(path.join(runRoot, "graph.fingerprint"), "sha256:historical\n", "utf8");

  const bundled = await cli(project, ["report", "bundle", runId, "--json"]);

  assert.equal(bundled.code, 1, bundled.stderr);
  assert.match(JSON.stringify(parseJson(bundled).diagnostics), /historical or unsealed runs is unsupported/iu);
  assert.equal(fs.existsSync(path.join(project, ".ultrafuzz", "bundles", `${runId}-report-bundle.zip`)), false);
});

test("report bundle fails closed on every present invalid event journal", async (context) => {
  const project = tempProject();
  const cases: Array<{
    name: string;
    prepare(eventsPath: string, runId: string): void;
    diagnostic: RegExp;
  }> = [
    {
      name: "malformed JSON",
      prepare: (eventsPath) => fs.writeFileSync(eventsPath, '{"schema_version":\n', "utf8"),
      diagnostic: /invalid strict JSON/iu
    },
    {
      name: "duplicate JSON property",
      prepare: (eventsPath, runId) => {
        const line = JSON.stringify(bundleFixtureEvent(runId)).replace(
          `"run_id":"${runId}"`,
          `"run_id":"${runId}","run_id":"${runId}"`
        );
        fs.writeFileSync(eventsPath, `${line}\n`, "utf8");
      },
      diagnostic: /duplicate property name/iu
    },
    {
      name: "foreign run record",
      prepare: (eventsPath) => fs.writeFileSync(eventsPath, `${JSON.stringify(bundleFixtureEvent("foreign-run"))}\n`),
      diagnostic: /belongs to.*expected/iu
    },
    {
      name: "torn final record",
      prepare: (eventsPath, runId) => fs.writeFileSync(eventsPath, JSON.stringify(bundleFixtureEvent(runId))),
      diagnostic: /torn or unterminated/iu
    },
    {
      name: "legacy event schema",
      prepare: (eventsPath, runId) => {
        fs.writeFileSync(
          eventsPath,
          `${JSON.stringify({ ...bundleFixtureEvent(runId), schema_version: "ultrafuzz.event-record.v1" })}\n`
        );
      },
      diagnostic: /event record schema validation failed/iu
    },
    {
      name: "duplicate event identity",
      prepare: (eventsPath, runId) => {
        const line = JSON.stringify(bundleFixtureEvent(runId));
        fs.writeFileSync(eventsPath, `${line}\n${line}\n`, "utf8");
      },
      diagnostic: /duplicate identity/iu
    },
    {
      name: "dangling symlink",
      prepare: (eventsPath) => fs.symlinkSync(`${eventsPath}.missing`, eventsPath),
      diagnostic: /cannot be a symlink/iu
    },
    {
      name: "nonregular file",
      prepare: (eventsPath) => fs.mkdirSync(eventsPath),
      diagnostic: /not a regular file/iu
    }
  ];

  for (const [index, invalidCase] of cases.entries()) {
    await context.test(invalidCase.name, async () => {
      const runId = `report-bundle-invalid-events-${index}`;
      const runRoot = (await createReportRun(project, runId)).run_root;
      fs.rmSync(path.join(runRoot, "events.jsonl"), { force: true });
      invalidCase.prepare(path.join(runRoot, "events.jsonl"), runId);

      const bundled = await cli(project, ["report", "bundle", runId, "--json"]);

      assert.equal(bundled.code, 1, bundled.stderr);
      assert.match(JSON.stringify(parseJson(bundled).diagnostics), invalidCase.diagnostic);
      assert.equal(fs.existsSync(path.join(project, ".ultrafuzz", "bundles", `${runId}-report-bundle.zip`)), false);
    });
  }
});

test("report bundle packages incomplete runs without a final-report JSON", async () => {
  const project = tempProject();
  const runData = await createReportRun(project, "report-bundle-incomplete");

  const bundled = await cli(project, ["report", "bundle", runData.run_id, "--json"]);
  assert.equal(bundled.code, 0, bundled.stderr);
  const data = parseJson(bundled).data as { zip_path: string };
  const zip = new AdmZip(data.zip_path);
  const entries = zip
    .getEntries()
    .filter((entry) => !entry.isDirectory)
    .map((entry) => entry.entryName);
  assert.equal(entries.includes("bundle-manifest.json"), true);
  assert.equal(entries.includes("run.json"), true);
  assert.equal(entries.includes("state.json"), true);
  assert.equal(
    entries.some((entry) => /^artifacts\/final-report[^/]*\/report\.json$/u.test(entry)),
    false
  );
});

test("stats reads strict local current evidence and reports genuinely absent ledgers", async () => {
  const project = tempProject();
  const fixture = writeStatsFixture(project, "stats-local", { linked: false });

  const captured = await cli(project, ["stats", fixture.runId, "--json"]);
  assert.equal(captured.code, 0, captured.stderr);
  const body = parseJson(captured);
  assert.equal(body.ok, true);
  const data = body.data as {
    schema_version: string;
    run_id: string;
    status: string;
    source: { kind: string };
    nodes: Array<{
      node_id: string;
      duration_ms: number | null;
      attempt_count: number | null;
      usage: {
        input_tokens: number;
        cache_read_tokens: number;
        output_tokens: number;
        total_tokens: number;
        estimated_spend_usd: number | null;
        usage_complete: boolean;
        pricing_complete: boolean;
      } | null;
    }>;
    totals: { usage: { total_tokens: number; estimated_spend_usd: number | null } | null };
  };
  assert.equal(data.schema_version, "ultrafuzz.stats.v1");
  assert.equal(data.run_id, fixture.runId);
  assert.equal(data.status, "succeeded");
  assert.equal(data.source.kind, "local-run");
  const node = data.nodes.find((entry) => entry.node_id === "node-a");
  assert.ok(node);
  assert.equal(node.duration_ms, null);
  assert.equal(node.attempt_count, null);
  assert.equal(node.usage, null);
  assert.equal(data.totals.usage, null);
  assert.match(JSON.stringify(body.diagnostics), /STATS_ATTEMPTS_UNAVAILABLE/u);
  assert.match(JSON.stringify(body.diagnostics), /STATS_USAGE_UNAVAILABLE/u);

  const human = await cli(project, ["stats", fixture.runId]);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /node-a\s+succeeded/u);
  assert.match(human.stdout, /Outcome/u);
  assert.match(human.stdout, /CacheR\s+CacheW/u);
  assert.match(human.stdout, /Exec\/Reuse\s+Completeness/u);
  assert.match(human.stdout, /Warnings:/u);
});

test("stats falls back to unchanged local evidence when workflow event output is malformed", async (context) => {
  const project = tempProject();
  assert.equal((await cli(project, ["init", "--force"])).code, 0);
  writeSmallTopology(project);
  const env = fakeSmithersEnv(project);
  const run = await cli(project, ["run", "--run-id", "stats-invalid-workflow-events", "--json"], env);
  assert.equal(run.code, 0, run.stderr);
  const runRoot = (parseJson(run).data as { run_root: string }).run_root;
  const evidencePaths = ["state.json", "run.json", "attempts.jsonl", "usage.jsonl"].map((name) =>
    path.join(runRoot, name)
  );
  const before = evidencePaths.map((filePath) => fs.readFileSync(filePath));

  for (const [stream, diagnosticCode] of [
    ["events", "WORKFLOW_EVENTS_INVALID"],
    ["token-events", "WORKFLOW_TOKEN_EVENTS_INVALID"]
  ] as const) {
    await context.test(stream, async () => {
      const captured = await cli(project, ["stats", "stats-invalid-workflow-events", "--json"], {
        ...env,
        SMITHERS_FAKE_INVALID_EVENT_STREAM: stream
      });
      assert.equal(captured.code, 0, captured.stderr);
      const body = parseJson(captured);
      assert.equal(body.ok, true);
      assert.equal(
        (body.diagnostics as Array<{ code: string; severity: string }>).some(
          (diagnostic) => diagnostic.code === diagnosticCode && diagnostic.severity === "warning"
        ),
        true,
        JSON.stringify(body.diagnostics)
      );
      evidencePaths.forEach((filePath, index) => assert.deepEqual(fs.readFileSync(filePath), before[index]));
    });
  }
});

test("stats queries a current report bundle offline and reports genuinely missing ledgers", async () => {
  const project = tempProject();
  const fixture = writeStatsFixture(project, "stats-bundle");
  const bundlePath = path.join(project, "stats-bundle.zip");
  writeStatsBundle(bundlePath, fixture);
  fs.rmSync(fixture.runRoot, { recursive: true });

  const captured = await cli(project, ["stats", "--bundle", bundlePath, "--json"]);
  assert.equal(captured.code, 0, captured.stderr);
  const body = parseJson(captured);
  const data = body.data as {
    source: { kind: string; path: string };
    nodes: Array<{ node_id: string; duration_ms: number | null; usage: { total_tokens: number } | null }>;
  };
  assert.equal(data.source.kind, "report-bundle");
  assert.equal(data.source.path, bundlePath);
  assert.equal(data.nodes.find((entry) => entry.node_id === "node-a")?.duration_ms, 60_000);
  assert.equal(data.nodes.find((entry) => entry.node_id === "node-a")?.usage?.total_tokens, 17);

  const missingLedgersFixture = writeStatsFixture(project, "stats-missing-ledgers");
  const missingLedgersPath = path.join(project, "stats-missing-ledgers.zip");
  writeStatsBundle(missingLedgersPath, missingLedgersFixture, {
    omitted: new Set(["attempts.jsonl", "usage.jsonl"])
  });
  const degraded = await cli(project, ["stats", "--bundle", missingLedgersPath, "--json"]);
  assert.equal(degraded.code, 0, degraded.stderr);
  const degradedBody = parseJson(degraded);
  assert.match(JSON.stringify(degradedBody.diagnostics), /STATS_ATTEMPTS_UNAVAILABLE/u);
  assert.match(JSON.stringify(degradedBody.diagnostics), /STATS_USAGE_UNAVAILABLE/u);
  assert.match(JSON.stringify(degradedBody.diagnostics), /STATS_ACCOUNTING_UNVERIFIED/u);
  assert.equal((degradedBody.data as { nodes: Array<{ usage: unknown }> }).nodes[0]?.usage, null);
  assert.equal(
    (degradedBody.data as { totals: { accounting_cumulative: unknown } }).totals.accounting_cumulative,
    null
  );
});

test("stats rejects a historical report-bundle manifest", async () => {
  const project = tempProject();
  const fixture = writeStatsFixture(project, "stats-v1-bundle");
  const bundlePath = path.join(project, "stats-v1-bundle.zip");
  writeStatsBundle(bundlePath, fixture, {
    manifestBytes: Buffer.from(
      `${JSON.stringify({ schema_version: "ultrafuzz.report_bundle.v1", run_id: fixture.runId })}\n`,
      "utf8"
    )
  });

  const captured = await cli(project, ["stats", "--bundle", bundlePath, "--json"]);
  assert.equal(captured.code, 1);
  assert.match(JSON.stringify(parseJson(captured).diagnostics), /report bundle manifest is invalid/iu);
});

test("stats fails closed for malformed present bundle evidence", async (context) => {
  const project = tempProject();
  const cases: Array<{
    name: string;
    member?: string;
    bytes?: (fixture: ReturnType<typeof writeStatsFixture>) => Buffer;
    mutateZip?: (bytes: Buffer) => Buffer;
    diagnostic: RegExp;
  }> = [
    {
      name: "invalid UTF-8 JSON",
      member: "state.json",
      bytes: () => Buffer.from([0x7b, 0xff, 0x7d]),
      diagnostic: /valid UTF-8/iu
    },
    {
      name: "duplicate JSON key",
      member: "run.json",
      bytes: (fixture) =>
        Buffer.from(
          `{"schema_version":"ultrafuzz.run-metadata.v2","run_id":"${fixture.runId}","run_id":"${fixture.runId}"}\n`
        ),
      diagnostic: /duplicate property name/iu
    },
    {
      name: "duplicate attempt identity",
      member: "attempts.jsonl",
      bytes: (fixture) => {
        const line = fs.readFileSync(path.join(fixture.runRoot, "attempts.jsonl"));
        return Buffer.concat([line, line]);
      },
      diagnostic: /duplicate identity/iu
    },
    {
      name: "conflicting usage identity",
      member: "usage.jsonl",
      bytes: (fixture) => {
        const canonical = JSON.parse(fs.readFileSync(path.join(fixture.runRoot, "usage.jsonl"), "utf8")) as {
          observed_timestamp_ms: number;
        };
        const conflict = { ...canonical, observed_timestamp_ms: canonical.observed_timestamp_ms + 1 };
        return Buffer.from(`${JSON.stringify(canonical)}\n${JSON.stringify(conflict)}\n`, "utf8");
      },
      diagnostic: /conflicting duplicate identity/iu
    },
    {
      name: "cross-run usage row",
      member: "usage.jsonl",
      bytes: (fixture) => {
        const canonical = JSON.parse(fs.readFileSync(path.join(fixture.runRoot, "usage.jsonl"), "utf8")) as {
          run_id: string;
        };
        return Buffer.from(`${JSON.stringify({ ...canonical, run_id: "foreign-run" })}\n`, "utf8");
      },
      diagnostic: /belongs to.*expected/iu
    },
    {
      name: "same-identity usage content drift",
      member: "usage.jsonl",
      bytes: (fixture) => {
        const canonical = JSON.parse(fs.readFileSync(path.join(fixture.runRoot, "usage.jsonl"), "utf8")) as {
          usage: { input_tokens: number };
        };
        canonical.usage.input_tokens += 1;
        return Buffer.from(`${JSON.stringify(canonical)}\n`, "utf8");
      },
      diagnostic: /does not exactly match usage-ledger accounting/iu
    },
    {
      name: "capture before node finish",
      member: "state.json",
      bytes: (fixture) => {
        const state = JSON.parse(fs.readFileSync(path.join(fixture.runRoot, "state.json"), "utf8")) as {
          nodes: Record<string, { finished_at?: string }>;
        };
        state.nodes["node-a"]!.finished_at = "2026-08-11T10:03:00.000Z";
        return Buffer.from(`${JSON.stringify(state)}\n`, "utf8");
      },
      diagnostic: /capture precedes node .* finished_at/iu
    },
    {
      name: "capture before attempt finish",
      member: "attempts.jsonl",
      bytes: (fixture) => {
        const attempt = JSON.parse(fs.readFileSync(path.join(fixture.runRoot, "attempts.jsonl"), "utf8")) as {
          lifecycle: { finished_at: string };
        };
        attempt.lifecycle.finished_at = "2026-08-11T10:03:00.000Z";
        return Buffer.from(`${JSON.stringify(attempt)}\n`, "utf8");
      },
      diagnostic: /capture precedes attempt ledger entry 0 lifecycle finished_at/iu
    },
    {
      name: "capture before usage observation",
      member: "usage.jsonl",
      bytes: (fixture) => {
        const usage = JSON.parse(fs.readFileSync(path.join(fixture.runRoot, "usage.jsonl"), "utf8")) as {
          observed_timestamp_ms: number;
        };
        usage.observed_timestamp_ms = Date.parse("2026-08-11T10:03:00.000Z");
        return Buffer.from(`${JSON.stringify(usage)}\n`, "utf8");
      },
      diagnostic: /capture precedes usage ledger entry 0 observed_timestamp_ms/iu
    },
    {
      name: "capture before accounting update",
      member: "run.json",
      bytes: (fixture) => {
        const metadata = JSON.parse(fs.readFileSync(path.join(fixture.runRoot, "run.json"), "utf8")) as {
          accounting: { updated_at: string };
        };
        metadata.accounting.updated_at = "2026-08-11T10:03:00.000Z";
        return Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8");
      },
      diagnostic: /capture precedes accounting updated_at/iu
    },
    {
      name: "present empty usage ledger with accounting",
      member: "usage.jsonl",
      bytes: () => Buffer.alloc(0),
      diagnostic: /present empty usage ledger/iu
    },
    {
      name: "uppercase graph fingerprint",
      member: "graph.fingerprint",
      bytes: () => Buffer.from(`${"A".repeat(64)}\n`),
      diagnostic: /lowercase SHA-256 digest/iu
    },
    {
      name: "short graph fingerprint",
      member: "graph.fingerprint",
      bytes: () => Buffer.from("abc\n"),
      diagnostic: /lowercase SHA-256 digest/iu
    },
    {
      name: "noncanonical graph fingerprint newline",
      member: "graph.fingerprint",
      bytes: () => Buffer.from(`${"a".repeat(64)}\n\n`),
      diagnostic: /canonical single-line fingerprint/iu
    },
    {
      name: "duplicate ZIP member",
      mutateZip: (bytes) => duplicateCentralDirectoryEntry(bytes, "state.json"),
      diagnostic: /duplicate ZIP member/iu
    }
  ];

  for (const [index, invalidCase] of cases.entries()) {
    await context.test(invalidCase.name, async () => {
      const fixture = writeStatsFixture(project, `stats-invalid-${index}`);
      const bundlePath = path.join(project, `stats-invalid-${index}.zip`);
      writeStatsBundle(bundlePath, fixture, {
        ...(invalidCase.member === undefined || invalidCase.bytes === undefined
          ? {}
          : { replacements: new Map([[invalidCase.member, invalidCase.bytes(fixture)]]) })
      });
      if (invalidCase.mutateZip !== undefined) {
        fs.writeFileSync(bundlePath, invalidCase.mutateZip(fs.readFileSync(bundlePath)));
      }

      const captured = await cli(project, ["stats", "--bundle", bundlePath, "--json"]);
      assert.equal(captured.code, 1, captured.stderr);
      assert.match(JSON.stringify(parseJson(captured).diagnostics), invalidCase.diagnostic);
    });
  }
});

test("stats binds the v3 manifest entry count and rejects ZIP path aliases", async (context) => {
  const project = tempProject();
  await context.test("manifest entry count", async () => {
    const fixture = writeStatsFixture(project, "stats-count-mismatch");
    const bundlePath = path.join(project, "stats-count-mismatch.zip");
    writeStatsBundle(bundlePath, fixture, { manifestBytes: statsBundleManifestBytes(fixture, 99) });

    const captured = await cli(project, ["stats", "--bundle", bundlePath, "--json"]);
    assert.equal(captured.code, 1);
    assert.match(JSON.stringify(parseJson(captured).diagnostics), /entry count.*does not match/iu);
  });
  await context.test("path alias", async () => {
    const fixture = writeStatsFixture(project, "stats-path-alias");
    const bundlePath = path.join(project, "stats-path-alias.zip");
    writeStatsBundle(bundlePath, fixture);
    fs.writeFileSync(bundlePath, renameCentralDirectoryEntry(fs.readFileSync(bundlePath), "state.json", "./run.json"));

    const captured = await cli(project, ["stats", "--bundle", bundlePath, "--json"]);
    assert.equal(captured.code, 1);
    assert.match(JSON.stringify(parseJson(captured).diagnostics), /non-canonical ZIP member/iu);
  });
  for (const [name, replacement] of [
    ["backslash", "dir\\x.json"],
    ["drive colon", "C:/run.jsn"],
    ["control character", "\u0001state.jsn"],
    ["parent traversal", "../run.jsn"]
  ] as const) {
    await context.test(name, async () => {
      const fixture = writeStatsFixture(project, `stats-path-${name.replaceAll(" ", "-")}`);
      const bundlePath = path.join(project, `stats-path-${name.replaceAll(" ", "-")}.zip`);
      writeStatsBundle(bundlePath, fixture);
      fs.writeFileSync(bundlePath, renameCentralDirectoryEntry(fs.readFileSync(bundlePath), "state.json", replacement));

      const captured = await cli(project, ["stats", "--bundle", bundlePath, "--json"]);
      assert.equal(captured.code, 1);
      assert.match(JSON.stringify(parseJson(captured).diagnostics), /non-canonical ZIP member/iu);
    });
  }
  await context.test("capture precedes durable state", async () => {
    const fixture = writeStatsFixture(project, "stats-early-capture");
    const bundlePath = path.join(project, "stats-early-capture.zip");
    writeStatsBundle(bundlePath, fixture, {
      manifestBytes: statsBundleManifestBytes(fixture, 6, "2026-08-11T09:59:59.000Z")
    });

    const captured = await cli(project, ["stats", "--bundle", bundlePath, "--json"]);
    assert.equal(captured.code, 1);
    assert.match(JSON.stringify(parseJson(captured).diagnostics), /capture precedes state created_at/iu);
  });
  await context.test("manifest capture is in the future", async () => {
    const fixture = writeStatsFixture(project, "stats-future-capture");
    const bundlePath = path.join(project, "stats-future-capture.zip");
    writeStatsBundle(bundlePath, fixture, {
      manifestBytes: statsBundleManifestBytes(fixture, 6, "2099-08-11T10:02:00.000Z")
    });

    const captured = await cli(project, ["stats", "--bundle", bundlePath, "--json"]);
    assert.equal(captured.code, 1);
    assert.match(JSON.stringify(parseJson(captured).diagnostics), /evidence capture cannot be in the future/iu);
  });
});

test("stats rejects local evidence whose leaf is a symlink", async () => {
  const project = tempProject();
  const fixture = writeStatsFixture(project, "stats-symlink");
  const usagePath = path.join(fixture.runRoot, "usage.jsonl");
  const outsidePath = path.join(project, "outside-usage.jsonl");
  fs.copyFileSync(usagePath, outsidePath);
  fs.unlinkSync(usagePath);
  fs.symlinkSync(outsidePath, usagePath);

  const captured = await cli(project, ["stats", fixture.runId, "--json"]);
  assert.equal(captured.code, 1);
  assert.match(JSON.stringify(parseJson(captured).diagnostics), /symlink/u);
});

test("stats rejects linked local evidence without sealed workflow authority", async () => {
  const project = tempProject();
  const fixture = writeStatsFixture(project, "stats-missing-control-authority");

  const captured = await cli(project, ["stats", fixture.runId, "--json"]);
  assert.equal(captured.code, 1);
  assert.match(JSON.stringify(parseJson(captured).diagnostics), /linked workflow authority is invalid/iu);
  assert.match(JSON.stringify(parseJson(captured).diagnostics), /control seal/iu);
});

function writeStatsFixture(
  project: string,
  runId: string,
  options: { linked?: boolean } = {}
): { runId: string; runRoot: string; layout: RunLayout } {
  const linked = options.linked ?? true;
  const startedAt = "2026-08-11T10:00:00.000Z";
  const finishedAt = "2026-08-11T10:01:00.000Z";
  const graphFingerprint = "a".repeat(64);
  const workflowRunId = `workflow-${runId}`;
  const workflowTaskId = "node:node-a";
  const controlGeneration = "c".repeat(64);
  const workflowLinkId = "00000000-0000-4000-8000-000000000001";
  const executionSnapshotPath = `smithers/execution-snapshots/${"e".repeat(64)}`;
  const output = {
    path: "result.md",
    contract: "ultrafuzz/nonempty-markdown@1" as const,
    contract_digest: artifactContractDefinition("ultrafuzz/nonempty-markdown@1").digest,
    primary: true
  };
  const summary = {
    uncached_input_tokens: 10,
    input_tokens: 10,
    output_tokens: 2,
    cache_read_tokens: 5,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    inclusive_token_total: 17,
    billable_token_total: 17,
    total_tokens: 17,
    tokens_used: "17",
    estimated_spend: "$0.0000",
    estimated_spend_usd: 0.0000165,
    component_costs_usd: {
      uncached_input: 0.00001,
      cache_read: 0.0000025,
      cache_write: 0,
      output: 0.000004,
      reasoning: 0
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
    models: ["gpt-test"],
    agents: ["agent-test"]
  };
  const currentAccounting = {
    ...summary,
    control_generation: controlGeneration,
    workflow_run_id: workflowRunId,
    source_event_sequences: [3],
    attempts: [{ node_id: "node-a", iteration: 0, attempt: 1 }]
  };
  const initialState = createInitialRunState({
    runId,
    graphFingerprint,
    configFingerprint: "b".repeat(64),
    createdAt: startedAt,
    nodes: [
      {
        id: "node-a",
        logicalNodeId: "node-a",
        artifactDir: "artifacts/node-a",
        outputs: [output],
        model: "gpt-test",
        ...(linked
          ? {
              provenance: {
                workflow: {
                  run_id: workflowRunId,
                  task_id: workflowTaskId,
                  agent_task_id: workflowTaskId,
                  verifier_task_id: "verify:node-a"
                }
              }
            }
          : {})
      }
    ],
    ...(linked
      ? {
          provenance: {
            workflow: {
              inspection: { runId: workflowRunId },
              runId: workflowRunId,
              compiledRunId: workflowRunId,
              name: "stats-workflow",
              controlGeneration,
              linkId: workflowLinkId,
              executionSnapshot: executionSnapshotPath
            }
          }
        }
      : {})
  });
  const layout = createRunLayout({
    projectRoot: project,
    runId,
    createdAt: startedAt,
    graphFingerprint,
    configFingerprint: "b".repeat(64),
    graph: {
      schema_version: "ultrafuzz.planned-graph.v3",
      graph_version: "3",
      topology_version: 2,
      groups: {},
      nodes: [
        {
          id: "node-a",
          logical_id: "node-a",
          display_name: "Node A",
          kind: "agentic",
          depends_on: [],
          artifact_dir: "artifacts/node-a",
          outputs: [output],
          prompt_id: "node-a",
          prompt_path: ".ultrafuzz/prompts/node-a.mdx",
          loop: { index: 0, count: 1, mode: "parallel", attempt_index: 0 },
          model_fanout: [
            {
              model_profile_id: "gpt-test",
              agent_ref: "agent-test",
              model_name: "gpt-test",
              model_index: 0,
              loop_index: 0,
              attempt_index: 0
            }
          ],
          ...(linked ? { workflow: { node_id: workflowTaskId, task_node_ids: [workflowTaskId] } } : {})
        }
      ]
    },
    state: initialState,
    ...(linked
      ? {
          runMetadata: {
            mode: "run" as const,
            workflow_ids: [workflowRunId],
            redacted_config_fingerprint: "d".repeat(64),
            forge_guard: { enabled: false, active: false, virtual_memory_limit_kb: 1, rayon_threads: 1 },
            workflow: {
              run_id: workflowRunId,
              compiled_run_id: workflowRunId,
              name: "stats-workflow",
              path: "workflow.tsx",
              evidence_path: "smithers/workflow.tsx",
              expanded_graph_path: "smithers/expanded-graph.json",
              config_path: "smithers/config.json",
              input_path: "smithers/input.json",
              tasks_path: "smithers/tasks.json",
              control_integrity_path: "smithers/control-integrity.json",
              control_generation: controlGeneration,
              workflow_link_id: workflowLinkId,
              execution_snapshot_path: executionSnapshotPath,
              task_node_ids: [workflowTaskId]
            },
            accounting: {
              schema_version: "ultrafuzz.accounting.v3" as const,
              source: "usage-ledger" as const,
              workflow_run_id: workflowRunId,
              current: currentAccounting,
              segments: [currentAccounting],
              cumulative: { ...summary, source_run_ids: [] },
              checkpoint: {
                schema_version: "ultrafuzz.accounting-checkpoint.v1" as const,
                ledger_event_count: 1,
                last_source_event_sequence: 3,
                control_generation: controlGeneration,
                workflow_run_id: workflowRunId
              },
              pricing_catalog: {
                source: "configured-catalog" as const,
                status: "available" as const,
                fetched_at: startedAt,
                resolved_models: ["gpt-test"],
                unresolved_models: [],
                model_prices: {
                  "gpt-test": {
                    inputUsdPerMillion: 1,
                    cachedInputUsdPerMillion: 0.5,
                    cacheWriteUsdPerMillion: 1.5,
                    outputUsdPerMillion: 2
                  }
                }
              },
              updated_at: finishedAt
            }
          }
        }
      : {})
  });
  updateRunStatus(layout, "running", startedAt);
  updateNodeState(
    layout,
    "node-a",
    { status: "succeeded", started_at: startedAt, finished_at: finishedAt, model: "gpt-test" },
    finishedAt
  );
  updateRunStatus(layout, "succeeded", finishedAt);
  if (linked) {
    appendNodeAttempt(layout, {
      workflowRunId,
      controlGeneration,
      nodeId: "node-a",
      strategyAttemptId: "node-a",
      iteration: 0,
      attempt: 1,
      startedEventSequence: 1,
      sourceEventSequence: 2,
      startedAt,
      finishedAt,
      outcome: "succeeded",
      inputManifestDigest: manifestDigest("input"),
      outputManifestDigest: manifestDigest("output")
    });
    appendUsageEvents(layout, [
      {
        workflowRunId,
        controlGeneration,
        sourceEventSequence: 3,
        observedTimestampMs: Date.parse(finishedAt),
        nodeId: "node-a",
        iteration: 0,
        attempt: 1,
        usage: {
          input_tokens: 10,
          cache_read_tokens: 5,
          cache_write_tokens: 0,
          output_tokens: 2,
          reasoning_tokens: 0,
          model: "gpt-test",
          agent: "agent-test"
        }
      }
    ]);
  } else {
    fs.unlinkSync(layout.attemptLedgerPath);
    fs.unlinkSync(layout.usageLedgerPath);
  }
  return { runId, runRoot: layout.root, layout };
}

const REPORT_BUNDLE_INCLUDED_ROOTS = [
  "attempts.jsonl",
  "config.redactions.json",
  "config.resolved.toml",
  "events.jsonl",
  "graph.fingerprint",
  "graph.json",
  "plan.json",
  "run.json",
  "state.json",
  "usage.jsonl",
  "artifacts",
  "review",
  "events.index",
  "engine-logs"
] as const;

function writeStatsBundle(
  bundlePath: string,
  fixture: ReturnType<typeof writeStatsFixture>,
  options: {
    omitted?: ReadonlySet<string>;
    replacements?: ReadonlyMap<string, Buffer>;
    manifestBytes?: Buffer;
    extraEntries?: ReadonlyMap<string, Buffer>;
  } = {}
): void {
  const evidenceNames = ["run.json", "state.json", "graph.json", "graph.fingerprint", "attempts.jsonl", "usage.jsonl"];
  const zip = new AdmZip();
  let entryCount = 0;
  for (const name of evidenceNames) {
    if (options.omitted?.has(name) === true) continue;
    zip.addFile(name, options.replacements?.get(name) ?? fs.readFileSync(path.join(fixture.runRoot, name)));
    entryCount += 1;
  }
  for (const [name, bytes] of options.extraEntries ?? []) {
    zip.addFile(name, bytes);
    entryCount += 1;
  }
  const manifest = {
    schema_version: "ultrafuzz.report-bundle-manifest.v3",
    run_id: fixture.runId,
    created_at: "2026-08-11T10:02:00.000Z",
    included_roots: REPORT_BUNDLE_INCLUDED_ROOTS,
    excluded_roots: ["workspaces"],
    excluded_patterns: ["artifacts/final-report/report.json.pre-*"],
    path_mappings: [],
    entry_count_without_manifest: entryCount
  };
  zip.addFile("bundle-manifest.json", options.manifestBytes ?? Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8"));
  zip.writeZip(bundlePath);
}

function statsBundleManifestBytes(
  fixture: ReturnType<typeof writeStatsFixture>,
  entryCountWithoutManifest: number,
  createdAt = "2026-08-11T10:02:00.000Z"
): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      schema_version: "ultrafuzz.report-bundle-manifest.v3",
      run_id: fixture.runId,
      created_at: createdAt,
      included_roots: REPORT_BUNDLE_INCLUDED_ROOTS,
      excluded_roots: ["workspaces"],
      excluded_patterns: ["artifacts/final-report/report.json.pre-*"],
      path_mappings: [],
      entry_count_without_manifest: entryCountWithoutManifest
    })}\n`,
    "utf8"
  );
}

function duplicateCentralDirectoryEntry(zipBytes: Buffer, entryName: string): Buffer {
  const endSignature = 0x06054b50;
  const centralSignature = 0x02014b50;
  let endOffset = -1;
  for (let offset = zipBytes.length - 22; offset >= Math.max(0, zipBytes.length - 65_557); offset -= 1) {
    if (zipBytes.readUInt32LE(offset) === endSignature) {
      endOffset = offset;
      break;
    }
  }
  assert.notEqual(endOffset, -1, "ZIP end-of-central-directory record");
  const centralOffset = zipBytes.readUInt32LE(endOffset + 16);
  const centralSize = zipBytes.readUInt32LE(endOffset + 12);
  let offset = centralOffset;
  let selected: Buffer | undefined;
  while (offset < centralOffset + centralSize) {
    assert.equal(zipBytes.readUInt32LE(offset), centralSignature);
    const nameLength = zipBytes.readUInt16LE(offset + 28);
    const extraLength = zipBytes.readUInt16LE(offset + 30);
    const commentLength = zipBytes.readUInt16LE(offset + 32);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    const name = zipBytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name === entryName) selected = Buffer.from(zipBytes.subarray(offset, offset + recordLength));
    offset += recordLength;
  }
  assert.ok(selected, entryName);
  const end = Buffer.from(zipBytes.subarray(endOffset));
  const diskEntries = end.readUInt16LE(8);
  const totalEntries = end.readUInt16LE(10);
  end.writeUInt16LE(diskEntries + 1, 8);
  end.writeUInt16LE(totalEntries + 1, 10);
  end.writeUInt32LE(centralSize + selected.length, 12);
  return Buffer.concat([zipBytes.subarray(0, endOffset), selected, end]);
}

function renameCentralDirectoryEntry(zipBytes: Buffer, entryName: string, replacement: string): Buffer {
  assert.equal(Buffer.byteLength(entryName), Buffer.byteLength(replacement));
  const copy = Buffer.from(zipBytes);
  const endSignature = 0x06054b50;
  const centralSignature = 0x02014b50;
  let endOffset = -1;
  for (let offset = copy.length - 22; offset >= Math.max(0, copy.length - 65_557); offset -= 1) {
    if (copy.readUInt32LE(offset) === endSignature) {
      endOffset = offset;
      break;
    }
  }
  assert.notEqual(endOffset, -1, "ZIP end-of-central-directory record");
  const centralOffset = copy.readUInt32LE(endOffset + 16);
  const centralSize = copy.readUInt32LE(endOffset + 12);
  let offset = centralOffset;
  while (offset < centralOffset + centralSize) {
    assert.equal(copy.readUInt32LE(offset), centralSignature);
    const nameLength = copy.readUInt16LE(offset + 28);
    const extraLength = copy.readUInt16LE(offset + 30);
    const commentLength = copy.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const name = copy.subarray(nameStart, nameStart + nameLength).toString("utf8");
    if (name === entryName) {
      copy.write(replacement, nameStart, nameLength, "utf8");
      return copy;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  assert.fail(`missing ZIP central-directory entry ${entryName}`);
}
