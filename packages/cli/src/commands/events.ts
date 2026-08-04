import { Args, Command, Flags } from "@oclif/core";
import {
  isLifecycleEventCategory,
  queryWorkflowEvents,
  watchWorkflowEvents,
  type WorkflowEventsValue,
  type WorkflowLifecycleEvent
} from "@ultrafuzz/runtime";

import {
  cliIo,
  commandFailure,
  commandFromRuntime,
  emitCommandResult,
  emitWatchFailure,
  envelope,
  globalFlags,
  projectRoot,
  type CommandResult
} from "../command-shared.js";

const DEFAULT_WATCH_INTERVAL_SECONDS = 5;

export default class Events extends Command {
  static override summary = "Show linked workflow lifecycle events for a run";
  static override args = { runId: Args.string({ required: true, description: "Ultrafuzz run ID" }) };
  static override flags = {
    ...globalFlags,
    node: Flags.string({ summary: "Filter to one workflow node ID" }),
    type: Flags.string({ summary: "Filter to one event category" }),
    since: Flags.string({ summary: "Filter to a recent duration window, such as 5m or 2h" }),
    limit: Flags.integer({ min: 1, summary: "Maximum events to return" }),
    watch: Flags.boolean({ summary: "Stream new events as they arrive" }),
    interval: Flags.integer({
      summary: "Watch poll interval in seconds",
      min: 1,
      default: DEFAULT_WATCH_INTERVAL_SECONDS
    }),
    history: Flags.boolean({ summary: "Replay existing history before streaming in watch mode" })
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Events);
    if (flags.type !== undefined && !isLifecycleEventCategory(flags.type)) {
      emitCommandResult(
        this,
        "events",
        commandFailure(
          "events",
          `--type must be a lifecycle event category, not ${flags.type}; raw agent and tool categories are not exposed`,
          "WORKFLOW_EVENTS_TYPE_UNSUPPORTED"
        ),
        flags.json === true
      );
      return;
    }
    const query = {
      projectRoot: projectRoot(flags),
      runId: args.runId,
      env: cliIo().env,
      ...(flags.node === undefined ? {} : { nodeId: flags.node }),
      ...(flags.type === undefined ? {} : { type: flags.type }),
      ...(flags.since === undefined ? {} : { since: flags.since }),
      ...(flags.limit === undefined ? {} : { limit: flags.limit }),
      ...(flags.history === true ? { history: true } : {})
    };
    if (flags.watch !== true) {
      const result = await queryWorkflowEvents(query);
      emitCommandResult(this, "events", commandFromRuntime("events", result, renderEvents), flags.json === true);
      return;
    }
    const json = flags.json === true;
    const result = await watchWorkflowEvents({
      ...query,
      intervalSeconds: flags.interval,
      onEvent: (event) => {
        emitWatchEvent(event, json);
      }
    });
    if (!result.ok) {
      emitWatchFailure("events", commandFromRuntime("events", result, renderEvents), json);
    }
  }
}

function emitWatchEvent(event: WorkflowLifecycleEvent, json: boolean): void {
  const io = cliIo();
  if (!json) {
    io.stdout.write(`${renderEvent(event)}\n`);
    return;
  }
  const result: CommandResult = { ok: true, command: "events", data: event, diagnostics: [] };
  io.stdout.write(`${JSON.stringify(envelope("events", result))}\n`);
}

function renderEvents(value: WorkflowEventsValue): string {
  if (value.events.length === 0) {
    return `Run: ${value.run_id}\nNo linked workflow lifecycle events matched.\n`;
  }
  const lines = [
    `Run: ${value.run_id}`,
    `Events: ${value.events.length}${value.truncated ? ` (truncated at ${value.limit})` : ""}`,
    ...value.events.map(renderEvent)
  ];
  return `${lines.join("\n")}\n`;
}

function renderEvent(event: WorkflowLifecycleEvent): string {
  const node = event.node_id === null ? "run" : event.node_id;
  const iteration = event.iteration === null ? "" : `#${event.iteration}`;
  const attempt = event.attempt === null ? "" : ` attempt ${event.attempt}`;
  const detail = event.detail === null ? "" : ` - ${event.detail}`;
  return `${event.timestamp ?? "unknown time"} ${event.category} ${node}${iteration}${attempt}${detail}`;
}
