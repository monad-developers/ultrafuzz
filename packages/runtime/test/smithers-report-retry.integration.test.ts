import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { temporaryRoot } from "./temporary-root.js";

const runtimeRoot = fileURLToPath(new URL("../..", import.meta.url));
const workspaceRoot = path.resolve(runtimeRoot, "../..");
const smithers = path.join(runtimeRoot, "node_modules", ".bin", "smithers");

function productionReportSource(): string {
  const source = fs.readFileSync(path.join(runtimeRoot, "src/templates/smithers/workflows/workflow.tsx"), "utf8");
  const ranges = [
    ["function declaredFinalReportOutputPair", "\ntype FinalReportRunMetadataProjection"],
    ["type FinalReportAgentAttempt", "\nfunction baseAgentForProfile"],
    ["function artifactAwareAgent", "\nfunction isStrictlyInsideDirectory"],
    ["function isStrictlyInsideDirectory", "\nfunction isPlainRecord"],
    ["function prepareTaskLocalAuthorityPath", "\n/**\n * Derive the least-authority"],
    ["function isMissingPathError", "\nfunction pathEntryExists"],
    ["function resolveRegularArtifactFile", "\nfunction resolveNonEmptyRegularArtifactFile"],
    ["function readBoundedRegularArtifactSnapshot", "\nfunction decodeStrictUtf8Snapshot"],
    ["function parseStrictJsonSnapshot", "\nfunction captureTaskOutputs"],
    ["function verifyFinalReportCanonicalProjection", "\nfunction readInvariantSourceSnapshot"]
  ];
  return ranges
    .map(([startMarker, endMarker]) => {
      assert.ok(startMarker && endMarker);
      const start = source.indexOf(startMarker);
      const end = source.indexOf(endMarker, start);
      assert.ok(start >= 0 && end > start, startMarker);
      return source.slice(start, end);
    })
    .join("\n");
}

function workflowSource(root: string, runId: string, quotaRetry: boolean): string {
  const artifactsModule = pathToFileURL(path.join(workspaceRoot, "packages/artifacts/dist/index.js")).href;
  const runtimeModule = pathToFileURL(path.join(runtimeRoot, "dist/index.js")).href;
  const fixtures = JSON.parse(
    fs.readFileSync(path.join(workspaceRoot, "packages/artifacts/test/fixtures/contract-schema-fixtures.json"), "utf8")
  ) as Record<string, { valid: unknown }>;
  const report = fixtures["ultrafuzz/report@3"]?.valid;
  assert.ok(report);
  return `/** @jsxImportSource smthrs */
import { execFileSync } from "node:child_process";
import fs, { lstatSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createSmithers } from "smthrs";
import { z } from "zod/v4";
const { assertRegularFileInside, normalizeNodeAttemptFailureMessage, parseStrictJsonBytes,
  prepareSafeFilePath, readRegularFileSnapshot, sensitiveEnvironmentValues,
  validateArtifactContractBytes, writeFileDurable } = await import(${JSON.stringify(artifactsModule)});
const { inspectSmithersAttemptAgentSelection, reconcileSmithersAttemptAgentSelection,
  smithersTaskAgentId, projectCanonicalFinalReport } = await import(${JSON.stringify(runtimeModule)});
const root = ${JSON.stringify(root)};
const baseReport = ${JSON.stringify(report)};
const reportPath = path.join(root, "report.json");
const markdownPath = path.join(root, "report.md");
const evidencePath = path.join(root, "executions.jsonl");
const task = {
  id: "node:report", smithersNodeId: "node:report", logicalNodeId: "report", attemptId: "report",
  smithersRunId: ${JSON.stringify(runId)}, runRoot: root, workspacePath: root,
  execution: { mode: "local" },
  outputs: [{path: "report.json", contract: "ultrafuzz/report@3"},
    {path: "report.md", contract: "ultrafuzz/nonempty-markdown@1"}],
  agentChain: ${JSON.stringify(quotaRetry ? ["primary"] : ["primary", "fallback-a", "fallback-b"])}.map((profileId, index) => ({
    profileId, agentRef: "CodexAgent", modelName: "synthetic-model", role: index === 0 ? "primary" : "fallback"
  }))
};
const PROMPT_ARTIFACT_AUTHORITY_DIRECTORY = ".ultrafuzz/authorities";
const MAX_FINAL_REPORT_PROMPT_AUTHORITY_BYTES = 1024 * 1024;
const untrustedContentBoundary = "UNTRUSTED CONTENT BOUNDARY";
const originalPrompt = untrustedContentBoundary + "\\n\\nCopy the supplied report authority.";
const isPlainJsonRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// This fixture isolates report provenance: source/dependency and run-metric
// authorities are fixed synthetic inputs. Prompt materialization, tamper
// checks, agent retry handling, durable selection reconciliation, report
// schema validation, Markdown projection, and canonical verification are real.
const assertWorkspaceSourceRevision = () => {};
const resetTaskArtifactsForRetry = async () => {};
const finalReportTaskRuntimeFromAgentArgs = () => undefined;
const assertDependencyArtifactAdmissionCurrent = () => {};
const assertPromptArtifactAuthorityUnchanged = () => {};
const assertFinalReportRunMetadataAuthorityUnchanged = () => {};
const authoritativeFinalReportRunMetadataArgs = (_task, args) => args;
const authoritativeFinalReportCoverage = () => baseReport.property_implementation_coverage;
const authoritativeFinalReportRunMetadata = () => baseReport.run_metadata;
const readGoalSearchCoverage = () => undefined;
${productionReportSource()}
const { Workflow, Task, smithers, outputs } = createSmithers({
  input: z.object({}), producer: z.object({completed: z.literal(true)}), verifier: z.object({verified: z.literal(true)})
});
const agents = task.agentChain.map((_profile, chainIndex) => artifactAwareAgent(task, chainIndex, originalPrompt, {
  async generate(args) {
    const attempt = args.taskContext.attempt;
    const promptAuthorityPath = path.join(root, finalReportPromptAuthorityRelativePath(task));
    if (!args.prompt.includes(finalReportPromptAuthorityRelativePath(task))) throw new Error("authority omitted from prompt");
    const authority = JSON.parse(fs.readFileSync(promptAuthorityPath, "utf8"));
    fs.appendFileSync(evidencePath, JSON.stringify({phase: "producer", pid: process.pid, attempt, chainIndex, authority}) + "\\n");
    execFileSync("smithers", ["pause", task.smithersRunId, "--format", "json"], {cwd: root, timeout: 30_000});
    if (attempt === 1) {
      const error = new Error("synthetic first producer failure");
      ${quotaRetry ? 'error.code = "AGENT_QUOTA_EXCEEDED"; error.details = {failureQuota: true, failureRetryable: true};' : ""}
      throw error;
    }
    const candidate = structuredClone(baseReport);
    candidate.run_metadata.agent_execution = authority.agent_execution;
    candidate.property_implementation_coverage = authority.property_implementation_coverage;
    const projection = projectCanonicalFinalReport(candidate);
    fs.writeFileSync(reportPath, JSON.stringify(projection.report));
    fs.writeFileSync(markdownPath, projection.markdown);
    return {text: "synthetic report complete"};
  }
}));
export default smithers(() => (
  <Workflow name="synthetic-report-retry">
    <Task id={task.id} output={outputs.producer} agent={agents} retries={2}
      retryPolicy={{backoff: "fixed", initialDelayMs: 100}}>{originalPrompt}</Task>
    <Task id="verify:report" output={outputs.verifier} dependsOn={[task.id]} retries={0}>
      {() => {
        const bytes = fs.readFileSync(reportPath);
        const validation = validateArtifactContractBytes("ultrafuzz/report@3", bytes, reportPath);
        if (!validation.ok) throw new Error(JSON.stringify(validation.issues));
        const value = JSON.parse(bytes);
        verifyFinalReportCanonicalProjection(task, new Map([
          ["report.json", {value, file: {bytes}}],
          ["report.md", {file: {bytes: fs.readFileSync(markdownPath)}}]
        ]));
        fs.appendFileSync(evidencePath, JSON.stringify({phase: "verifier", pid: process.pid}) + "\\n");
        return {verified: true};
      }}
    </Task>
  </Workflow>
));
`;
}

function cli(root: string, args: string[]): unknown {
  return JSON.parse(
    execFileSync(smithers, [...args, "--format", "json", "--full-output"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${path.dirname(smithers)}${path.delimiter}${process.env.PATH ?? ""}`,
        SMITHERS_POST_FAILURE: "0"
      },
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024
    })
  );
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function waitForStatus(root: string, runId: string, expected: string, minimumExecutions: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  let status: unknown;
  while (Date.now() < deadline) {
    const envelope = record(cli(root, ["inspect", runId]));
    const detail = envelope.ok === true ? record(envelope.data) : envelope;
    status = record(detail.run ?? detail).status;
    const executionsPath = path.join(root, "executions.jsonl");
    const executions = fs.existsSync(executionsPath)
      ? fs.readFileSync(executionsPath, "utf8").trim().split("\n").length
      : 0;
    if (status === expected && executions >= minimumExecutions) return;
    assert.notEqual(status, "failed", JSON.stringify(detail));
    assert.notEqual(status, "cancelled", JSON.stringify(detail));
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.fail(`Smithers did not reach ${expected}; last status ${String(status)}`);
}

for (const quotaRetry of [false, true]) {
  test(`a real Smithers ${quotaRetry ? "quota" : "fallback"} report retry survives producer and verifier restarts`, async () => {
    const root = temporaryRoot("ultrafuzz-report-retry-");
    const runId = `report-retry-${process.pid}-${Date.now()}`;
    const workflowDir = path.join(root, ".smithers", "workflows");
    fs.mkdirSync(workflowDir, { recursive: true });
    const packageRoot = fs.realpathSync(path.join(runtimeRoot, "node_modules/smthrs"));
    fs.symlinkSync(path.dirname(packageRoot), path.join(root, ".smithers/node_modules"), "dir");
    const workflowPath = path.join(workflowDir, "report-retry.tsx");
    fs.writeFileSync(workflowPath, workflowSource(root, runId, quotaRetry));
    const launch = ["up", workflowPath, "--detach", "--run-id", runId, "--root", root, "--input", "{}"];
    try {
      cli(root, launch);
      await waitForStatus(root, runId, "paused", 1);
      cli(root, [...launch, "--resume", runId]);
      await waitForStatus(root, runId, "paused", 2);
      assert.ok(fs.existsSync(path.join(root, "report.json")));
      const reportBytes = fs.readFileSync(path.join(root, "report.json"));
      cli(root, [...launch, "--resume", runId]);
      await waitForStatus(root, runId, "finished", 3);
      assert.deepEqual(
        fs.readFileSync(path.join(root, "report.json")),
        reportBytes,
        "verification must not repair producer bytes"
      );
      const events = fs
        .readFileSync(path.join(root, "executions.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => record(JSON.parse(line)));
      assert.deepEqual(
        events.map((event) => event.phase),
        ["producer", "producer", "verifier"]
      );
      assert.equal(
        new Set(events.map((event) => event.pid)).size,
        3,
        "each phase must execute in a fresh controller process"
      );
      assert.deepEqual(
        events.slice(0, 2).map((event) => event.attempt),
        [1, 2]
      );
      assert.deepEqual(
        events.slice(0, 2).map((event) => event.chainIndex),
        quotaRetry ? [0, 0] : [0, 1]
      );
      const execution = record(record(events[1]?.authority).agent_execution);
      assert.deepEqual(
        (execution.failed_attempts as Array<{ attempt: number }>).map((entry) => entry.attempt),
        [1]
      );
      assert.equal(record(execution.producer).attempt, 2);
    } finally {
      try {
        cli(root, ["cancel", runId]);
      } catch {
        /* A terminal fixture may already have exited. */
      }
    }
  });
}
