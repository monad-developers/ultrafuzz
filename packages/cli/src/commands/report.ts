import fs from "node:fs";
import path from "node:path";

import { Args, Command } from "@oclif/core";
import {
  assertNoSymlinkComponents,
  assertPathInside,
  assertRegularFileInside,
  layoutForRunRoot,
  validateSafeId
} from "@ultrafuzz/artifacts";
import { runsRootForProject } from "@ultrafuzz/runtime";

import { commandFailure, emitCommandResult, globalFlags, projectRoot } from "../command-shared.js";

export default class Report extends Command {
  static override summary = "Show the agent-written final report for a run";
  static override args = { runId: Args.string({ required: true, description: "Ultrafuzz run ID" }) };
  static override flags = globalFlags;

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Report);
    const root = projectRoot(flags);
    try {
      const runsRoot = await runsRootForProject(root);
      const runId = validateSafeId(args.runId, "run ID");
      const layout = layoutForRunRoot(path.join(runsRoot, runId), runId);
      assertPathInside(runsRoot, layout.root, "run root");
      assertNoSymlinkComponents(runsRoot, layout.root, "run root");
      const written = findAgenticReport(layout.root);
      emitCommandResult(
        this,
        "report",
        {
          ok: true,
          command: "report",
          data: written,
          text: `Report: ${written.markdown_path}\nJSON: ${written.json_path}\n`,
          diagnostics: []
        },
        flags.json === true
      );
    } catch (error) {
      emitCommandResult(
        this,
        "report",
        commandFailure("report", error instanceof Error ? error.message : String(error), "REPORT_FAILED"),
        flags.json === true
      );
    }
  }
}

function findAgenticReport(runRoot: string): {
  markdown_path: string;
  json_path: string;
  source: "agentic-final-report";
} {
  for (const candidate of candidateReportDirs(runRoot)) {
    const markdownPath = path.join(candidate, "report.md");
    const jsonPath = path.join(candidate, "report.json");
    if (fs.existsSync(markdownPath) && fs.existsSync(jsonPath)) {
      assertRegularFileInside(runRoot, markdownPath, "report markdown path");
      assertRegularFileInside(runRoot, jsonPath, "report JSON path");
      return {
        markdown_path: markdownPath,
        json_path: jsonPath,
        source: "agentic-final-report"
      };
    }
  }
  throw new Error("agent-written report artifacts are not available for this run");
}

function candidateReportDirs(runRoot: string): string[] {
  const candidates = [path.join(runRoot, "artifacts", "final-report")];
  const artifactsRoot = path.join(runRoot, "artifacts");
  if (fs.existsSync(artifactsRoot)) {
    for (const entry of fs.readdirSync(artifactsRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("final-report")) {
        candidates.push(path.join(artifactsRoot, entry.name));
      }
    }
  }
  return Array.from(new Set(candidates));
}
