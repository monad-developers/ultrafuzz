import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AnalysisCommandName } from "../types.js";
import { analyzeArchive } from "./analysis.js";
import { buildComparisonChart, buildCostChart, buildScoreChart, buildUpSetChart } from "./charts.js";
import { writeMethodOutputs, writeProvenanceOutputs, writeScoreOutputs, writeTableOutputs } from "./outputs.js";

export interface AnalysisOptions {
  input: string;
  output: string;
  projectRoot: string;
}

export interface AnalysisSummary {
  command: AnalysisCommandName;
  sourceArchive: string;
  sourceSha256: string;
  handoffSchemaVersion: string;
  rows: number;
  findingInstances: number;
  rootCauseClusters: number;
  groundTruthCount: number;
  groundTruthTpCredits: number;
  truePositiveInstances: number;
  falsePositiveInstances: number;
  needsHumanReviewInstances: number;
  duplicateInstances: number;
  outputDirectory: string;
  outputs: string[];
}

export async function runAnalysisCommand(
  command: AnalysisCommandName,
  options: AnalysisOptions
): Promise<AnalysisSummary> {
  const input = fs.realpathSync(options.input);
  const projectRoot = fs.realpathSync(options.projectRoot);
  const output = canonicalDestination(options.output);
  assertOutsideProject(input, projectRoot, "input archive");
  assertOutsideProject(output, projectRoot, "output directory");
  await mkdir(output, { recursive: true });

  const result = await analyzeArchive(input);
  const outputs: string[] = [];
  if (command === "provenance" || command === "all") {
    outputs.push(...(await writeProvenanceOutputs(result, output)));
  }
  if (command === "upset" || command === "all") outputs.push(...(await buildUpSetChart(result, output)));
  if (command === "scores" || command === "all") {
    outputs.push(...(await writeScoreOutputs(result, output)));
    outputs.push(...(await buildScoreChart(result, output)));
  }
  if (command === "cost" || command === "all") outputs.push(...(await buildCostChart(result, output)));
  if (command === "pairwise" || command === "all") outputs.push(...(await buildComparisonChart(result, output)));
  if (command === "table" || command === "all") outputs.push(...(await writeTableOutputs(result, output)));
  if (command === "all") outputs.push(...(await writeMethodOutputs(result, output)));
  const analysisManifestPath = path.join(output, "analysis_manifest.json");
  await writeFile(
    analysisManifestPath,
    `${JSON.stringify(
      {
        schema_version: "ultrafuzz.benchmark-analysis.manifest.v1",
        privacy: "private-analysis-output-do-not-commit",
        command,
        source_archive: result.sourceArchive,
        source_sha256: result.sourceSha256,
        handoff_schema_version: result.handoffSchemaVersion,
        artifacts: outputs
          .map((file) => {
            const bytes = fs.readFileSync(file);
            return {
              path: path.basename(file),
              size_bytes: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex")
            };
          })
          .sort((left, right) => left.path.localeCompare(right.path))
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  outputs.push(analysisManifestPath);

  return {
    command,
    sourceArchive: result.sourceArchive,
    sourceSha256: result.sourceSha256,
    handoffSchemaVersion: result.handoffSchemaVersion,
    rows: result.rows.length,
    findingInstances: result.records.length,
    rootCauseClusters: result.entities.length,
    groundTruthCount: result.groundTruthCount,
    groundTruthTpCredits: result.entities
      .filter((entity) => entity.classification === "true-positive")
      .reduce((total, entity) => total + entity.groundTruthTpCredits, 0),
    truePositiveInstances: result.records.filter(
      (record) => record.classification === "true-positive" && !record.isDuplicate
    ).length,
    falsePositiveInstances: result.records.filter(
      (record) => record.classification === "false-positive" && !record.isDuplicate
    ).length,
    needsHumanReviewInstances: result.records.filter(
      (record) => record.classification === "needs-human-review" && !record.isDuplicate
    ).length,
    duplicateInstances: result.records.filter((record) => record.isDuplicate).length,
    outputDirectory: output,
    outputs: outputs.map((file) => path.basename(file)).sort()
  };
}

function canonicalDestination(destination: string): string {
  const absolute = path.resolve(destination);
  const missing: string[] = [];
  let current = absolute;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Cannot resolve output directory: ${destination}`);
    missing.unshift(path.basename(current));
    current = parent;
  }
  const canonicalParent = fs.realpathSync(current);
  return path.resolve(canonicalParent, ...missing);
}

function assertOutsideProject(candidate: string, projectRoot: string, label: string): void {
  const relative = path.relative(projectRoot, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error(
      `Benchmark ${label} must be outside the project repository because handoff bundles and generated reports may contain private target and ground-truth data: ${candidate}`
    );
  }
}
