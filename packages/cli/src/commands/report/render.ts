import path from "node:path";

import { Command, Flags } from "@oclif/core";
import { parseStrictJsonBytes, readRegularFileSnapshot, sha256Bytes, writeFileDurable } from "@ultrafuzz/artifacts";
import {
  GOAL_SEARCH_COVERAGE_FILE,
  loadGoalSearchCoverageSnapshot,
  MAX_FINAL_REPORT_JSON_BYTES,
  projectCanonicalFinalReport
} from "@ultrafuzz/runtime";

import { cliIo, commandFailure, emitCommandResult, globalFlags } from "../../command-shared.js";

export default class ReportRender extends Command {
  static override summary = "Render canonical final-report Markdown from a validated report JSON document";
  static override description =
    "Pass --goal-search-coverage with the run-root census so goal coverage renders from measured data; without it the section states that coverage is unknown.";
  static override flags = {
    ...globalFlags,
    file: Flags.string({ required: true, summary: "Current report.json input" }),
    output: Flags.string({ required: true, summary: "Canonical report.md destination" }),
    "goal-search-coverage": Flags.string({
      summary: "Run-root goal-search-coverage.json census to render goal coverage from"
    })
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ReportRender);
    const io = cliIo();
    const source = path.resolve(io.cwd, flags.file);
    const destination = path.resolve(io.cwd, flags.output);
    try {
      const report = parseStrictJsonBytes(readRegularFileSnapshot(source, MAX_FINAL_REPORT_JSON_BYTES), {
        maxBytes: MAX_FINAL_REPORT_JSON_BYTES
      });
      let goalSearchCoverage: unknown | undefined;
      if (flags["goal-search-coverage"] !== undefined) {
        const censusPath = path.resolve(io.cwd, flags["goal-search-coverage"]);
        if (path.basename(censusPath) !== GOAL_SEARCH_COVERAGE_FILE) {
          throw new Error(
            `goal search coverage census must be a run-root ${GOAL_SEARCH_COVERAGE_FILE} document: ${censusPath}`
          );
        }
        // A missing, invalid, or run-mismatched census loads as undefined and renders as unknown
        // coverage — the same fail-closed state the runtime verifier computes for that census.
        goalSearchCoverage = loadGoalSearchCoverageSnapshot(path.dirname(censusPath));
      }
      const projection = projectCanonicalFinalReport(report, { goalSearchCoverage });
      writeFileDurable(destination, projection.markdown);
      emitCommandResult(
        this,
        "report render",
        {
          ok: true,
          command: "report render",
          data: {
            source_path: source,
            destination_path: destination,
            sha256: sha256Bytes(Buffer.from(projection.markdown, "utf8"))
          },
          text: `Rendered canonical report Markdown: ${destination}\n`,
          diagnostics: []
        },
        flags.json === true
      );
    } catch (error) {
      process.exitCode = 1;
      emitCommandResult(
        this,
        "report render",
        commandFailure("report render", error instanceof Error ? error.message : String(error), "REPORT_RENDER_FAILED"),
        flags.json === true
      );
    }
  }
}
