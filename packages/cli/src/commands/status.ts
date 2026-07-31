import { Args, Command, Flags } from "@oclif/core";
import { TERMINAL_RUN_STATE_STATUSES } from "@ultrafuzz/artifacts";
import { getRunHealth, type RunHealthValue } from "@ultrafuzz/runtime";

import {
  cliIo,
  commandFromRuntime,
  emitCommandResult,
  envelope,
  globalFlags,
  projectRoot,
  type CommandResult
} from "../command-shared.js";

const DEFAULT_WATCH_INTERVAL_SECONDS = 30;

const TERMINAL_RUN_STATUSES = new Set<string>(TERMINAL_RUN_STATE_STATUSES);

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
    let refresh = true;
    while (refresh) {
      const health = await getRunHealth({
        projectRoot: projectRoot(flags),
        runId: args.runId,
        windowMinutes: flags.window,
        env: cliIo().env
      });
      emitStatusResult(
        this,
        commandFromRuntime("status", health, renderHealth),
        flags.watch === true,
        flags.json === true
      );
      refresh = flags.watch === true && health.ok && shouldRefresh(health.value);
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
  emitCommandResult(command, "status", result, json);
}

function shouldRefresh(value: RunHealthValue | undefined): boolean {
  return value !== undefined && !TERMINAL_RUN_STATUSES.has(value.status);
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function renderHealth(value: RunHealthValue): string {
  const progress = value.progress;
  const lines = [
    `Run: ${value.run_id}`,
    `Status: ${value.verdict} (${value.status})`,
    `Reason: ${value.reason}`,
    `Progress: ${progress.percent}% (${progress.finished} finished / ${progress.in_progress} running / ${progress.pending} pending / ${progress.failed} failed / ${progress.total} total)`,
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
  return `${lines.join("\n")}\n`;
}

function renderEta(eta: RunHealthValue["eta"]): string {
  if (eta.seconds === null) {
    return `unavailable (${eta.unavailable_reason ?? "unknown"})`;
  }
  return eta.seconds === 0 ? "no remaining nodes" : formatDuration(eta.seconds);
}

function renderCurrentStep(step: RunHealthValue["current_step"]): string {
  if (step.running_count === 0) {
    return "no running step";
  }
  const others = step.running_count > 1 ? ` (+${step.running_count - 1} more running)` : "";
  if (step.elapsed_seconds === null) {
    return `unavailable (no recorded start)${others}`;
  }
  return `${formatDuration(step.elapsed_seconds)} on ${step.node_id ?? "unknown"}${others}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return "less than a minute";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
