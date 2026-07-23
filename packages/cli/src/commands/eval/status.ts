import { Args, Command, Flags } from "@oclif/core";
import { readEvalStatus, renderEvalStatusTable, type EvalStatusSnapshot } from "@ultrafuzz/evals";

import {
  cliIo,
  commandFailure,
  emitCommandResult,
  envelope,
  globalFlags,
  projectRoot,
  type CommandResult
} from "../../command-shared.js";

const DEFAULT_WATCH_INTERVAL_SECONDS = 30;

export default class EvalStatus extends Command {
  static override summary = "Show node progress and ETA for every row in an eval matrix";
  static override args = { evalRunId: Args.string({ required: true, description: "Eval run ID" }) };
  static override flags = {
    ...globalFlags,
    watch: Flags.boolean({ summary: "Refresh active rows until they finish or become unavailable" }),
    interval: Flags.integer({
      summary: "Watch refresh interval in seconds",
      min: 1,
      default: DEFAULT_WATCH_INTERVAL_SECONDS
    })
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(EvalStatus);
    try {
      let refresh = true;
      while (refresh) {
        const snapshot = readEvalStatus({
          projectRoot: projectRoot(flags),
          evalRunId: args.evalRunId
        });
        const result = statusResult(snapshot);
        emitStatusResult(this, result, flags.watch === true, flags.json === true);
        refresh = flags.watch === true && shouldRefresh(snapshot);
        if (refresh) {
          await wait(flags.interval * 1_000);
        }
      }
    } catch (error) {
      emitStatusResult(
        this,
        commandFailure(
          "eval status",
          error instanceof Error ? error.message : "eval status is unavailable",
          "EVAL_STATUS_FAILED"
        ),
        flags.watch === true,
        flags.json === true
      );
    }
  }
}

function statusResult(snapshot: EvalStatusSnapshot): CommandResult {
  return {
    ok: true,
    command: "eval status",
    data: snapshot,
    text: renderEvalStatusTable(snapshot),
    diagnostics: []
  };
}

function emitStatusResult(command: Command, result: CommandResult, watch: boolean, json: boolean): void {
  if (watch && json) {
    if (!result.ok) process.exitCode = process.exitCode ?? 1;
    cliIo().stdout.write(`${JSON.stringify(envelope("eval status", result))}\n`);
    return;
  }
  emitCommandResult(command, "eval status", result, json);
}

function shouldRefresh(snapshot: EvalStatusSnapshot): boolean {
  return snapshot.rows.some((row) => !row.terminal && rowMayStillProgress(row.status));
}

function rowMayStillProgress(status: string): boolean {
  return status === "not-launched" || status === "pending" || status === "running" || status === "paused";
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
