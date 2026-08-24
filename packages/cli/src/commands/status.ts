import { Args, Command, Flags } from "@oclif/core";
import { TERMINAL_RUN_STATE_STATUSES } from "@ultrafuzz/artifacts";
import { getRunHealth, isLiveWorkflowRunStatus, type RunHealthValue } from "@ultrafuzz/runtime";

import {
  cliIo,
  commandFailure,
  commandFromRuntime,
  emitCommandResult,
  envelope,
  globalFlags,
  projectRoot,
  type CommandResult
} from "../command-shared.js";
import { formatStatusDuration } from "../status-rendering.js";
import { setTimeout as wait } from "node:timers/promises";

const DEFAULT_WATCH_INTERVAL_SECONDS = 30;

const TERMINAL_RUN_STATUSES = new Set<string>(TERMINAL_RUN_STATE_STATUSES);
const STOP_WATCH_VERDICTS = new Set<RunHealthValue["verdict"]>([
  "done",
  "degraded",
  "orphaned",
  "cancel-pending",
  "paused",
  "cancelled",
  "failed"
]);

export default class Status extends Command {
  static override summary = "Show concise health for an Ultrafuzz run";
  static override args = { runId: Args.string({ required: true, description: "Ultrafuzz run ID" }) };
  static override flags = {
    ...globalFlags,
    window: Flags.integer({ min: 1, summary: "Recent activity window in minutes" }),
    watch: Flags.boolean({ summary: "Refresh until the run reaches a terminal state" }),
    interval: Flags.integer({
      summary: "Watch refresh interval in seconds",
      min: 1,
      default: DEFAULT_WATCH_INTERVAL_SECONDS
    })
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Status);
    const watch = flags.watch === true;
    const json = flags.json === true;
    let refresh = true;
    while (refresh) {
      let result: CommandResult;
      let health: Awaited<ReturnType<typeof getRunHealth>> | undefined;
      try {
        health = await getRunHealth({
          projectRoot: projectRoot(flags),
          runId: args.runId,
          windowMinutes: flags.window,
          env: cliIo().env
        });
        result = commandFromRuntime("status", health, renderHealth);
      } catch (error) {
        // A throw must stay inside the envelope: letting it escape would print a
        // pretty-printed failure into the middle of the NDJSON stream.
        result = commandFailure(
          "status",
          error instanceof Error ? error.message : "status is unavailable",
          "RUN_STATUS_FAILED"
        );
      }
      emitStatusResult(this, result, watch, json);
      refresh = watch && health?.ok === true && shouldRefresh(health.value);
      if (refresh) {
        await wait(flags.interval * 1_000);
      }
    }
  }
}

function emitStatusResult(command: Command, result: CommandResult, watch: boolean, json: boolean): void {
  if (watch && json) {
    if (!result.ok) {
      process.exitCode = process.exitCode ?? 1;
    }
    cliIo().stdout.write(`${JSON.stringify(envelope("status", result))}\n`);
    return;
  }
  if (watch && !json && result.ok) {
    // Blank-line separated so consecutive polls stay readable in a terminal.
    cliIo().stdout.write(`Snapshot: ${new Date().toISOString()}\n${result.text ?? ""}\n`);
    return;
  }
  emitCommandResult(command, "status", result, json);
}

function shouldRefresh(value: RunHealthValue | undefined): boolean {
  return value !== undefined && !TERMINAL_RUN_STATUSES.has(value.status) && !STOP_WATCH_VERDICTS.has(value.verdict);
}

function renderHealth(value: RunHealthValue): string {
  const progress = value.progress;
  const lines = [
    `Run: ${value.run_id}`,
    ...(typeof value.audit_profile?.effective === "string" ? [`Audit profile: ${value.audit_profile.effective}`] : []),
    `Status: ${value.verdict} (${value.status})`,
    ...lifecycleDivergenceLines(value),
    `Reason: ${value.reason}`,
    `Progress: ${progress.percent}% (${progress.finished} finished / ${progress.in_progress} running / ${progress.pending} pending / ${progress.failed} failed${extraBuckets(value)} / ${progress.total} total)`,
    `ETA: ${renderEta(value.eta)}`,
    `Time on current step: ${renderCurrentStep(value.current_step)}`,
    `Pace: ${value.throughput.recent_finished} finished in the last ${Math.max(1, Math.round(value.throughput.window_ms / 60_000))}m`
  ];
  if (value.gating.length > 0) {
    lines.push(
      `Gating: ${value.gating.map((entry) => `${entry.node_id} (${entry.detail ?? entry.state})`).join(", ")}${
        value.gating_omitted > 0 ? `, +${value.gating_omitted} more` : ""
      }`
    );
  }
  if (value.quota !== null) {
    lines.push(renderQuota(value.quota, value.run_id));
  }
  return `${lines.join("\n")}\n`;
}

const QUOTA_PARKED_NODE_SAMPLE = 3;

/** Parked nodes hold their attempts; say how the operator un-parks them (#677). */
function renderQuota(quota: NonNullable<RunHealthValue["quota"]>, runId: string): string {
  const sample = quota.parked_node_ids.slice(0, QUOTA_PARKED_NODE_SAMPLE);
  const omitted = quota.parked_node_ids.length - sample.length;
  const nodes = sample.length === 0 ? "" : ` — ${sample.join(", ")}${omitted > 0 ? `, +${omitted} more` : ""}`;
  const remediation =
    quota.reset_at_ms === null
      ? `no provider reset time — provider credit exhausted; restore credit, then run \`ultrafuzz resume ${runId}\``
      : `earliest provider reset ${new Date(quota.reset_at_ms).toISOString()}`;
  return `Quota: ${quota.parked_count} node(s) parked (attempts preserved)${nodes}; ${remediation}`;
}

function lifecycleDivergenceLines(value: RunHealthValue): string[] {
  if (!TERMINAL_RUN_STATUSES.has(value.status) || !isLiveWorkflowRunStatus(value.workflow_status)) return [];
  return [
    `Lifecycle divergence: Ultrafuzz is terminal ${value.status}, but the workflow runner is ${value.workflow_status}; workflow work may still be active.`
  ];
}

function renderEta(eta: RunHealthValue["eta"]): string {
  if (eta.seconds === null) {
    return `unavailable (${eta.unavailable_reason ?? "unknown"})`;
  }
  return eta.seconds === 0 ? "no remaining nodes" : formatStatusDuration(eta.seconds);
}

function renderCurrentStep(step: RunHealthValue["current_step"]): string {
  if (step.running_count === 0) {
    return "no running step";
  }
  const others = step.running_count > 1 ? ` (+${step.running_count - 1} more running)` : "";
  if (step.elapsed_seconds === null || step.node_id === null) {
    return `unavailable (no recorded start)${others}`;
  }
  return `${formatStatusDuration(step.elapsed_seconds)} on ${step.node_id}${others}`;
}

/** Keeps the Progress line's buckets summing to `total` when nodes are waiting. */
function extraBuckets(value: RunHealthValue): string {
  const counts = value.counts;
  const waiting = counts.waiting_approval + counts.waiting_event + counts.waiting_timer;
  const entries = [
    waiting > 0 ? `${waiting} waiting` : undefined,
    value.progress.skipped > 0 ? `${value.progress.skipped} skipped` : undefined,
    counts.other > 0 ? `${counts.other} other` : undefined
  ].filter((entry): entry is string => entry !== undefined);
  return entries.length === 0 ? "" : ` / ${entries.join(" / ")}`;
}
