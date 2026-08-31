import path from "node:path";

import { Args, Command, Flags } from "@oclif/core";
import {
  assertEvalHistoryRecency,
  checkEvalHistoryCharts,
  publishEvalRunToHistory,
  readEvalHistory,
  writeEvalHistoryCharts,
  type EvalHistoryBenchmark,
  type EvalHistoryLane
} from "@ultrafuzz/evals";

import { commandFailure, emitCommandResult, globalFlags, projectRoot } from "../../command-shared.js";

export default class EvalHistory extends Command {
  static override summary = "Validate, render, or append to the public longitudinal eval history";
  static override args = {
    evalRunId: Args.string({ required: false, description: "Complete scored eval run to append" })
  };
  static override flags = {
    ...globalFlags,
    history: Flags.string({
      default: "benchmarks/ultrafuzzbench/history.json",
      summary: "Versioned history JSON path"
    }),
    charts: Flags.string({
      default: "docs/assets/eval-history",
      summary: "Directory for deterministic SVG charts"
    }),
    benchmark: Flags.string({ options: ["evmbench", "ultrafuzz-bench"], summary: "Benchmark cohort" }),
    lane: Flags.string({ options: ["smoke", "full"], summary: "Benchmark lane" }),
    repository: Flags.string({ summary: "Public candidate repository URL" }),
    artifact: Flags.string({ summary: "Immutable source eval artifact reference" }),
    "publication-url": Flags.string({ summary: "Public URL for the validated result bundle" }),
    "benchmark-policy-root": Flags.string({
      summary: "Candidate checkout whose benchmark manifests define the published run"
    }),
    check: Flags.boolean({ summary: "Validate history and fail when checked-in charts are stale" }),
    "max-age-days": Flags.integer({
      summary: "Fail when the newest observation is older than this many days",
      min: 1
    })
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(EvalHistory);
    const root = projectRoot(flags);
    const historyPath = path.resolve(root, flags.history);
    const chartsDirectory = path.resolve(root, flags.charts);
    try {
      if (args.evalRunId !== undefined) {
        if (flags.check) throw new Error("--check cannot append an eval run");
        if (flags["max-age-days"] !== undefined) throw new Error("--max-age-days cannot append an eval run");
        if (
          flags.benchmark === undefined ||
          flags.lane === undefined ||
          flags.repository === undefined ||
          flags.artifact === undefined ||
          flags["publication-url"] === undefined
        ) {
          throw new Error("appending requires --benchmark, --lane, --repository, --artifact, and --publication-url");
        }
        const result = publishEvalRunToHistory({
          projectRoot: root,
          ...(flags["benchmark-policy-root"] === undefined
            ? {}
            : { benchmarkPolicyRoot: path.resolve(flags["benchmark-policy-root"]) }),
          evalRunId: args.evalRunId,
          benchmark: flags.benchmark as EvalHistoryBenchmark,
          lane: flags.lane as EvalHistoryLane,
          candidateRepositoryUrl: flags.repository,
          sourceArtifact: flags.artifact,
          ...(flags["publication-url"] === undefined ? {} : { publicationUrl: flags["publication-url"] }),
          historyPath,
          chartsDirectory
        });
        emitCommandResult(
          this,
          "eval history",
          {
            ok: true,
            command: "eval history",
            data: {
              history_path: historyPath,
              observations: result.history.observations.length,
              appended: result.appended,
              charts: result.chartPaths
            },
            text: `History: ${historyPath}\nAppended: ${result.appended}\nCharts: ${result.chartPaths.length}\n`,
            diagnostics: []
          },
          flags.json === true
        );
        return;
      }

      const history = readEvalHistory(historyPath);
      if (flags["max-age-days"] !== undefined) {
        assertEvalHistoryRecency({ history, maxAgeDays: flags["max-age-days"], now: new Date() });
      }
      if (flags.check) {
        const mismatches = checkEvalHistoryCharts(history, chartsDirectory);
        if (mismatches.length > 0) throw new Error(`eval history charts are stale: ${mismatches.join(", ")}`);
      } else {
        writeEvalHistoryCharts(history, chartsDirectory);
      }
      emitCommandResult(
        this,
        "eval history",
        {
          ok: true,
          command: "eval history",
          data: {
            history_path: historyPath,
            observations: history.observations.length,
            charts_directory: chartsDirectory,
            checked: flags.check === true
          },
          text: `History: ${historyPath}\nObservations: ${history.observations.length}\nCharts: ${chartsDirectory}\n`,
          diagnostics: []
        },
        flags.json === true
      );
    } catch (error) {
      emitCommandResult(
        this,
        "eval history",
        commandFailure("eval history", error instanceof Error ? error.message : String(error), "EVAL_HISTORY_FAILED"),
        flags.json === true
      );
    }
  }
}
