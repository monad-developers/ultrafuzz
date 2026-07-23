import { join } from "node:path";

import type { AnalysisResult, PairComparison, RowMetric, Severity } from "../types.js";
import { SEVERITY_ORDER } from "../types.js";
import { intersectionGroups, orderedSetRows, severityCounts } from "./analysis.js";
import { mean, sampleStdev } from "./stats.js";
import { circle, element, line, polygon, rect, svgDocument, text, writeSvgAndPng } from "./svg.js";

const SEVERITY_COLORS: Record<Severity, string> = {
  H: "#111111",
  M: "#555555",
  L: "#aaaaaa",
  I: "#e3e3e3"
};
const METRICS = ["precision", "recall", "f1"] as const;
const METRIC_COLORS = { precision: "#222222", recall: "#777777", f1: "#c4c4c4" } as const;
const CONDITION_STYLES = [
  { fill: "#111111", stroke: "#111111", square: false },
  { fill: "#4d4d4d", stroke: "#333333", square: true },
  { fill: "#858585", stroke: "#444444", square: false },
  { fill: "#bdbdbd", stroke: "#555555", square: true },
  { fill: "#e0e0e0", stroke: "#666666", square: false },
  { fill: "#ffffff", stroke: "#777777", square: true }
] as const;

function tickLabel(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function symbolDiamond(x: number, y: number, size: number, options: Record<string, unknown> = {}): string {
  return polygon(
    [
      [x, y - size],
      [x + size, y],
      [x, y + size],
      [x - size, y]
    ],
    options
  );
}

function markerSquare(x: number, y: number, size: number, options: Record<string, unknown> = {}): string {
  return rect(x - size, y - size, size * 2, size * 2, options);
}

function niceAxisMaximum(value: number, divisions: number): number {
  const roughStep = Math.max(value, Number.EPSILON) / divisions;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const step =
    normalized <= 1
      ? magnitude
      : normalized <= 2
        ? 2 * magnitude
        : normalized <= 2.5
          ? 2.5 * magnitude
          : normalized <= 5
            ? 5 * magnitude
            : 10 * magnitude;
  return step * divisions;
}

interface PairwisePanel {
  title: string;
  note: string;
  maximum: number;
  divisions: number;
  value: (pair: PairComparison, condition: "ultrafuzz" | "no-fuzz") => number | null;
  format: (value: number) => string;
  formatTick: (value: number) => string;
}

interface RowComparisonPanel {
  title: string;
  note: string;
  maximum: number;
  divisions: number;
  value: (row: RowMetric) => number | null;
  format: (value: number) => string;
  formatTick: (value: number) => string;
}

function rowLabel(result: AnalysisResult, rowId: string): string {
  return result.rows.find((row) => row.rowId === rowId)?.label ?? rowId;
}

export async function buildUpSetChart(result: AnalysisResult, outputDir: string): Promise<string[]> {
  const rows = orderedSetRows(result);
  const groups = intersectionGroups(result);
  const width = Math.max(1500, 600 + groups.length * 34);
  const rowTop = 570;
  const rowStep = 46;
  const height = rowTop + rows.length * rowStep + 80;
  const matrixLeft = 540;
  const matrixRight = width - 55;
  const topBase = 485;
  const barWidth = Math.min(23, Math.max(9, ((matrixRight - matrixLeft) / Math.max(groups.length, 1)) * 0.62));
  const xStep = (matrixRight - matrixLeft) / Math.max(groups.length, 1);
  const xAt = (index: number) => matrixLeft + xStep * (index + 0.5);
  const maxIntersection = Math.max(1, ...groups.map((group) => group.entities.length));
  const topScale = 300 / maxIntersection;
  const maxSet = Math.max(1, ...rows.map((rowId) => result.entities.filter((entity) => entity.rows.has(rowId)).length));
  const leftBarEnd = 395;
  const leftScale = 285 / maxSet;
  const parts: string[] = [];

  parts.push(text(55, 55, "Root-cause intersections by benchmark row", { "font-size": 28, "font-weight": 650 }));
  parts.push(
    text(
      55,
      86,
      `${result.entities.length} root-cause clusters · ${result.records.length} finding instances · ${rows.length} rows`,
      {
        "font-size": 15,
        fill: "#666"
      }
    )
  );
  parts.push(text(55, 111, "Generated from finalized global adjudication", { "font-size": 14, fill: "#777" }));

  let legendX = 55;
  parts.push(text(legendX, 151, "Severity", { "font-size": 13, "font-weight": 600 }));
  legendX += 78;
  for (const severity of SEVERITY_ORDER) {
    parts.push(rect(legendX, 138, 20, 15, { fill: SEVERITY_COLORS[severity], stroke: "#444", "stroke-width": 0.6 }));
    parts.push(text(legendX + 27, 151, severity, { "font-size": 13 }));
    legendX += 64;
  }

  for (let tick = 0; tick <= maxIntersection; tick += Math.max(1, Math.ceil(maxIntersection / 5))) {
    const y = topBase - tick * topScale;
    parts.push(line(matrixLeft, y, matrixRight, y, { stroke: "#e3e3e3" }));
    parts.push(text(matrixLeft - 12, y + 5, tick, { "font-size": 12, "text-anchor": "end", fill: "#666" }));
  }
  parts.push(text(matrixLeft - 5, 166, "Intersection size", { "font-size": 13, "text-anchor": "end", fill: "#555" }));
  parts.push(line(matrixLeft, topBase, matrixRight, topBase, { stroke: "#777" }));

  groups.forEach((group, index) => {
    const counts = severityCounts(group.entities, (entity) => entity.topSeverity);
    let bottom = topBase;
    for (const severity of SEVERITY_ORDER) {
      const segmentHeight = counts[severity] * topScale;
      bottom -= segmentHeight;
      if (segmentHeight > 0) {
        parts.push(
          rect(xAt(index) - barWidth / 2, bottom, barWidth, segmentHeight, {
            fill: SEVERITY_COLORS[severity],
            stroke: "#333",
            "stroke-width": 0.5
          })
        );
      }
    }
  });

  parts.push(
    text(leftBarEnd - 140, rowTop - 48, "Root causes", { "font-size": 13, "text-anchor": "middle", fill: "#555" })
  );
  parts.push(line(90, rowTop - 37, leftBarEnd, rowTop - 37, { stroke: "#777" }));
  for (let tick = 0; tick <= maxSet; tick += Math.max(1, Math.ceil(maxSet / 4))) {
    const x = leftBarEnd - tick * leftScale;
    parts.push(line(x, rowTop - 42, x, rowTop - 32, { stroke: "#777" }));
    parts.push(text(x, rowTop - 48, tick, { "font-size": 11, "text-anchor": "middle", fill: "#666" }));
  }

  rows.forEach((rowId, rowIndex) => {
    const y = rowTop + rowIndex * rowStep;
    if (rowIndex % 2 === 1) parts.push(rect(45, y - rowStep / 2, width - 90, rowStep, { fill: "#f5f5f5" }));
    const rowEntities = result.entities.filter((entity) => entity.rows.has(rowId));
    const counts = severityCounts(rowEntities, (entity) => entity.topSeverity);
    let right = leftBarEnd;
    for (const severity of SEVERITY_ORDER) {
      const segmentWidth = counts[severity] * leftScale;
      right -= segmentWidth;
      if (segmentWidth > 0) {
        parts.push(
          rect(right, y - 13, segmentWidth, 26, {
            fill: SEVERITY_COLORS[severity],
            stroke: "#333",
            "stroke-width": 0.5
          })
        );
      }
    }
    parts.push(
      text(505, y + 5, rowLabel(result, rowId), {
        "font-size": 15,
        "font-weight": 650,
        "text-anchor": "end"
      })
    );
    groups.forEach((group, groupIndex) => {
      const x = xAt(groupIndex);
      parts.push(circle(x, y, 4, { fill: "#d4d4d4" }));
      if (group.rows.has(rowId)) parts.push(circle(x, y, 7, { fill: "#111" }));
    });
  });

  groups.forEach((group, groupIndex) => {
    const active = rows.map((row, index) => (group.rows.has(row) ? index : -1)).filter((index) => index >= 0);
    if (active.length > 1) {
      parts.push(
        line(
          xAt(groupIndex),
          rowTop + (active[0] ?? 0) * rowStep,
          xAt(groupIndex),
          rowTop + (active.at(-1) ?? 0) * rowStep,
          { stroke: "#111", "stroke-width": 2 }
        )
      );
      for (const rowIndex of active)
        parts.push(circle(xAt(groupIndex), rowTop + rowIndex * rowStep, 7, { fill: "#111" }));
    }
  });

  parts.push(
    text(width - 55, height - 24, "Sets are ordered by globally deduplicated root-cause count.", {
      "font-size": 12,
      "text-anchor": "end",
      fill: "#777"
    })
  );
  const svgPath = join(outputDir, "upset_provenance.svg");
  return writeSvgAndPng(svgDocument(width, height, parts.join("\n")), svgPath);
}

export async function buildScoreChart(result: AnalysisResult, outputDir: string): Promise<string[]> {
  const width = 1500;
  const rowTop = 235;
  const rowStep = 65;
  const summaryConditions = result.conditions.filter(
    (condition) => result.rows.filter((row) => row.condition === condition).length > 1
  );
  const summaryTop = rowTop + result.rowOrder.length * rowStep + 45;
  const plotBottom = summaryTop + summaryConditions.length * rowStep + 20;
  const height = plotBottom + 70;
  const plotLeft = 300;
  const plotRight = 1410;
  const plotWidth = plotRight - plotLeft;
  const lookup = new Map(result.rowMetrics.map((row) => [row.rowId, row]));
  const summary = new Map(result.conditionSummary.map((item) => [item.condition, item]));
  const parts: string[] = [];

  parts.push(text(60, 58, "Precision · recall · F1 by row", { "font-size": 28, "font-weight": 650 }));
  parts.push(text(60, 90, "Recall uses explicit ground-truth TP credits", { "font-size": 15, fill: "#666" }));
  let legendX = 60;
  for (const metric of METRICS) {
    parts.push(rect(legendX, 122, 24, 15, { fill: METRIC_COLORS[metric], stroke: "#333", "stroke-width": 0.5 }));
    parts.push(
      text(legendX + 31, 135, metric === "f1" ? "F1" : metric[0]?.toUpperCase() + metric.slice(1), { "font-size": 13 })
    );
    legendX += metric === "precision" ? 125 : 105;
  }
  parts.push(
    text(
      60,
      164,
      summaryConditions.length > 0
        ? "Condition summary: bar = mean · diamond = median · whisker = ±1 sample SD"
        : "Each independently configured row is shown once.",
      {
        "font-size": 12,
        fill: "#666"
      }
    )
  );

  for (let tick = 0; tick <= 4; tick += 1) {
    const x = plotLeft + (plotWidth * tick) / 4;
    parts.push(line(x, 180, x, plotBottom, { stroke: tick === 0 ? "#999" : "#e2e2e2" }));
    parts.push(
      text(x, plotBottom + 28, tickLabel(tick / 4), { "font-size": 12, "text-anchor": "middle", fill: "#666" })
    );
  }

  result.rowOrder.forEach((rowId, index) => {
    const y = rowTop + index * rowStep;
    if (index % 2 === 1) parts.push(rect(50, y - rowStep / 2, width - 100, rowStep, { fill: "#f5f5f5" }));
    const row = lookup.get(rowId);
    if (!row) return;
    parts.push(
      text(270, y + 6, rowLabel(result, rowId), {
        "font-size": 16,
        "font-weight": 650,
        "text-anchor": "end"
      })
    );
    const offsets = [-16, 0, 16];
    METRICS.forEach((metric, metricIndex) => {
      const value = row[metric];
      if (value === null) return;
      parts.push(
        rect(plotLeft, y + (offsets[metricIndex] ?? 0) - 6, value * plotWidth, 12, {
          fill: METRIC_COLORS[metric],
          stroke: "#333",
          "stroke-width": 0.4
        })
      );
    });
  });

  summaryConditions.forEach((condition, index) => {
    const y = summaryTop + index * rowStep;
    parts.push(rect(50, y - rowStep / 2, width - 100, rowStep, { fill: index % 2 ? "#e7e7e7" : "#eeeeee" }));
    const item = summary.get(condition);
    parts.push(text(270, y + 6, `${condition} μ`, { "font-size": 15, "font-weight": 650, "text-anchor": "end" }));
    if (!item) return;
    const offsets = [-16, 0, 16];
    METRICS.forEach((metric, metricIndex) => {
      const summaryStat = item.stats[metric];
      if (!summaryStat || summaryStat.mean === null) return;
      const yy = y + (offsets[metricIndex] ?? 0);
      parts.push(
        rect(plotLeft, yy - 6, summaryStat.mean * plotWidth, 12, {
          fill: METRIC_COLORS[metric],
          stroke: "#333",
          "stroke-width": 0.4
        })
      );
      const lower = Math.max(0, summaryStat.mean - (summaryStat.stdev ?? 0));
      const upper = Math.min(1, summaryStat.mean + (summaryStat.stdev ?? 0));
      parts.push(
        line(plotLeft + lower * plotWidth, yy, plotLeft + upper * plotWidth, yy, {
          stroke: "#111",
          "stroke-width": 1.2
        })
      );
      if (summaryStat.median !== null) {
        parts.push(symbolDiamond(plotLeft + summaryStat.median * plotWidth, yy, 6, { fill: "#fff", stroke: "#111" }));
      }
    });
  });

  parts.push(
    text(plotRight, height - 20, `Recall denominator: ${result.groundTruthCount} canonical ground-truth causes`, {
      "font-size": 12,
      "text-anchor": "end",
      fill: "#777"
    })
  );
  const svgPath = join(outputDir, "precision_recall_f1.svg");
  return writeSvgAndPng(svgDocument(width, height, parts.join("\n")), svgPath);
}

export async function buildPairwiseChart(result: AnalysisResult, outputDir: string): Promise<string[]> {
  const pairs = result.pairComparison;
  if (pairs.length === 0) throw new Error("No Ultrafuzz/no-fuzz row pairs are available for pairwise analysis");

  const creditMaximum = niceAxisMaximum(
    Math.max(
      1,
      ...pairs.flatMap((pair) => [
        pair.ultrafuzz.distinctGroundTruthCredits ?? 0,
        pair.noFuzz.distinctGroundTruthCredits ?? 0
      ])
    ),
    3
  );
  const tokenMaximum = niceAxisMaximum(
    Math.max(1, ...pairs.flatMap((pair) => [pair.ultrafuzz.totalTokensMillions, pair.noFuzz.totalTokensMillions])),
    4
  );
  const panels: PairwisePanel[] = [
    {
      title: "Ground-truth TP credits",
      note: "Higher is better",
      maximum: creditMaximum,
      divisions: 3,
      value: (pair, condition) =>
        condition === "ultrafuzz" ? pair.ultrafuzz.distinctGroundTruthCredits : pair.noFuzz.distinctGroundTruthCredits,
      format: (value) => value.toFixed(0),
      formatTick: (value) => value.toFixed(0)
    },
    {
      title: "F1 score",
      note: "Higher is better",
      maximum: 1,
      divisions: 4,
      value: (pair, condition) => (condition === "ultrafuzz" ? pair.ultrafuzz.f1 : pair.noFuzz.f1),
      format: (value) => `${(value * 100).toFixed(1)}%`,
      formatTick: (value) => tickLabel(value)
    },
    {
      title: "Total tokens (millions)",
      note: "Lower is better",
      maximum: tokenMaximum,
      divisions: 4,
      value: (pair, condition) =>
        condition === "ultrafuzz" ? pair.ultrafuzz.totalTokensMillions : pair.noFuzz.totalTokensMillions,
      format: (value) => value.toFixed(1),
      formatTick: (value) => value.toFixed(0)
    }
  ];

  const width = 1600;
  const panelLeft = [145, 655, 1165];
  const panelWidth = 375;
  const rowTop = 270;
  const rowStep = 92;
  const axisTop = 220;
  const axisBottom = rowTop + (pairs.length - 1) * rowStep + 58;
  const height = axisBottom + 105;
  const parts: string[] = [];

  parts.push(text(60, 58, "Paired Ultrafuzz vs no-fuzz comparison", { "font-size": 28, "font-weight": 650 }));
  parts.push(
    text(60, 90, `${pairs.length} matched row pairs · finalized global adjudication`, {
      "font-size": 15,
      fill: "#666"
    })
  );
  parts.push(circle(72, 132, 8, CONDITION_STYLES[0]));
  parts.push(text(91, 137, "Ultrafuzz (d#)", { "font-size": 13 }));
  parts.push(markerSquare(248, 132, 8, CONDITION_STYLES[1]));
  parts.push(text(267, 137, "no-fuzz (n#)", { "font-size": 13 }));

  pairs.forEach((pair, index) => {
    const y = rowTop + index * rowStep;
    if (index % 2 === 1) parts.push(rect(45, y - 35, width - 90, 70, { fill: "#f5f5f5" }));
    parts.push(
      text(116, y + 6, `${pair.ultrafuzz.rowId} / ${pair.noFuzz.rowId}`, {
        "font-size": 15,
        "font-weight": 650,
        "text-anchor": "end"
      })
    );
  });

  panels.forEach((panel, panelIndex) => {
    const left = panelLeft[panelIndex] ?? 145;
    const right = left + panelWidth;
    const xAt = (value: number) => left + (value / panel.maximum) * panelWidth;
    parts.push(text(left, 172, panel.title, { "font-size": 17, "font-weight": 650 }));
    parts.push(text(right, 195, panel.note, { "font-size": 12, fill: "#666", "text-anchor": "end" }));

    for (let tick = 0; tick <= panel.divisions; tick += 1) {
      const value = (panel.maximum * tick) / panel.divisions;
      const x = xAt(value);
      parts.push(line(x, axisTop, x, axisBottom, { stroke: tick === 0 ? "#999" : "#e1e1e1" }));
      parts.push(
        text(x, axisBottom + 28, panel.formatTick(value), {
          "font-size": 11,
          "text-anchor": "middle",
          fill: "#666"
        })
      );
    }

    pairs.forEach((pair, pairIndex) => {
      const y = rowTop + pairIndex * rowStep;
      const ultrafuzz = panel.value(pair, "ultrafuzz");
      const noFuzz = panel.value(pair, "no-fuzz");
      if (ultrafuzz === null || noFuzz === null) {
        parts.push(text((left + right) / 2, y + 5, "NA", { "font-size": 12, "text-anchor": "middle", fill: "#777" }));
        return;
      }
      const ultrafuzzX = xAt(ultrafuzz);
      const noFuzzX = xAt(noFuzz);
      parts.push(line(ultrafuzzX, y, noFuzzX, y, { stroke: "#777", "stroke-width": 2 }));
      parts.push(circle(ultrafuzzX, y, 8, CONDITION_STYLES[0]));
      parts.push(markerSquare(noFuzzX, y, 8, CONDITION_STYLES[1]));
      parts.push(
        text(ultrafuzzX, y - 15, panel.format(ultrafuzz), {
          "font-size": 11,
          "font-weight": 600,
          "text-anchor": "middle"
        })
      );
      parts.push(
        text(noFuzzX, y + 25, panel.format(noFuzz), {
          "font-size": 11,
          "font-weight": 600,
          "text-anchor": "middle",
          fill: "#555"
        })
      );
    });
  });

  parts.push(
    text(
      width - 55,
      height - 22,
      "Lines connect matched benchmark rows; repeated findings are deduplicated before TP crediting.",
      {
        "font-size": 12,
        "text-anchor": "end",
        fill: "#777"
      }
    )
  );
  const svgPath = join(outputDir, "paired_row_comparison.svg");
  return writeSvgAndPng(svgDocument(width, height, parts.join("\n")), svgPath);
}

export async function buildComparisonChart(result: AnalysisResult, outputDir: string): Promise<string[]> {
  if (result.pairComparison.length > 0) return buildPairwiseChart(result, outputDir);
  return buildCrossRowChart(result, outputDir);
}

async function buildCrossRowChart(result: AnalysisResult, outputDir: string): Promise<string[]> {
  const rows = [...result.rowMetrics].sort(
    (left, right) =>
      (right.f1 ?? -1) - (left.f1 ?? -1) ||
      (right.distinctGroundTruthCredits ?? -1) - (left.distinctGroundTruthCredits ?? -1) ||
      left.totalTokensMillions - right.totalTokensMillions ||
      left.rowId.localeCompare(right.rowId)
  );
  if (rows.length === 0) throw new Error("No benchmark rows are available for comparison");

  const creditMaximum = niceAxisMaximum(Math.max(1, ...rows.map((row) => row.distinctGroundTruthCredits ?? 0)), 3);
  const scoreMaximum = Math.min(1, niceAxisMaximum(Math.max(0.05, ...rows.map((row) => row.f1 ?? 0)), 4));
  const tokenMaximum = niceAxisMaximum(Math.max(1, ...rows.map((row) => row.totalTokensMillions)), 4);
  const panels: RowComparisonPanel[] = [
    {
      title: "Ground-truth TP credits",
      note: "Higher is better",
      maximum: creditMaximum,
      divisions: 3,
      value: (row) => row.distinctGroundTruthCredits,
      format: (value) => value.toFixed(0),
      formatTick: (value) => value.toFixed(0)
    },
    {
      title: "F1 score",
      note: "Higher is better",
      maximum: scoreMaximum,
      divisions: 4,
      value: (row) => row.f1,
      format: (value) => `${(value * 100).toFixed(1)}%`,
      formatTick: (value) => tickLabel(value)
    },
    {
      title: "Total tokens (millions)",
      note: "Lower is better",
      maximum: tokenMaximum,
      divisions: 4,
      value: (row) => row.totalTokensMillions,
      format: (value) => value.toFixed(1),
      formatTick: (value) => value.toFixed(0)
    }
  ];

  const width = 1650;
  const panelLeft = [360, 785, 1210];
  const panelWidth = 360;
  const rowTop = 245;
  const rowStep = 82;
  const axisTop = 195;
  const axisBottom = rowTop + (rows.length - 1) * rowStep + 48;
  const height = axisBottom + 105;
  const parts: string[] = [];

  parts.push(text(60, 58, "Cross-row benchmark comparison", { "font-size": 28, "font-weight": 650 }));
  parts.push(
    text(60, 90, `${rows.length} independently configured rows · finalized global adjudication`, {
      "font-size": 15,
      fill: "#666"
    })
  );
  parts.push(
    text(60, 122, "Rows are ranked by F1, then ground-truth credits, then compute cost.", {
      "font-size": 12,
      fill: "#777"
    })
  );

  rows.forEach((row, index) => {
    const y = rowTop + index * rowStep;
    if (index % 2 === 1) parts.push(rect(45, y - 32, width - 90, 64, { fill: "#f5f5f5" }));
    parts.push(
      text(325, y + 6, `${index + 1}. ${row.label}`, {
        "font-size": 15,
        "font-weight": 650,
        "text-anchor": "end"
      })
    );
  });

  panels.forEach((panel, panelIndex) => {
    const left = panelLeft[panelIndex] ?? 360;
    const right = left + panelWidth;
    const xAt = (value: number) => left + (value / panel.maximum) * panelWidth;
    parts.push(text(left, 154, panel.title, { "font-size": 17, "font-weight": 650 }));
    parts.push(text(right, 177, panel.note, { "font-size": 12, fill: "#666", "text-anchor": "end" }));

    for (let tick = 0; tick <= panel.divisions; tick += 1) {
      const value = (panel.maximum * tick) / panel.divisions;
      const x = xAt(value);
      parts.push(line(x, axisTop, x, axisBottom, { stroke: tick === 0 ? "#999" : "#e1e1e1" }));
      parts.push(
        text(x, axisBottom + 28, panel.formatTick(value), {
          "font-size": 11,
          "text-anchor": "middle",
          fill: "#666"
        })
      );
    }

    rows.forEach((row, rowIndex) => {
      const y = rowTop + rowIndex * rowStep;
      const value = panel.value(row);
      if (value === null) {
        parts.push(text((left + right) / 2, y + 5, "NA", { "font-size": 12, "text-anchor": "middle", fill: "#777" }));
        return;
      }
      const x = xAt(value);
      parts.push(line(left, y, x, y, { stroke: "#b5b5b5", "stroke-width": 2 }));
      parts.push(circle(x, y, 8, { fill: "#111", stroke: "#111" }));
      parts.push(
        text(Math.min(right - 3, x + 12), y - 12, panel.format(value), {
          "font-size": 11,
          "font-weight": 600,
          "text-anchor": x > right - 55 ? "end" : "start"
        })
      );
    });
  });

  parts.push(
    text(width - 55, height - 22, "Repeated findings are globally deduplicated before ground-truth crediting.", {
      "font-size": 12,
      "text-anchor": "end",
      fill: "#777"
    })
  );
  const svgPath = join(outputDir, "model_comparison.svg");
  return writeSvgAndPng(svgDocument(width, height, parts.join("\n")), svgPath);
}

function pareto(rows: AnalysisResult["rowMetrics"]): AnalysisResult["rowMetrics"] {
  const sorted = [...rows].sort((left, right) => left.totalTokensMillions - right.totalTokensMillions);
  let best = -Infinity;
  return sorted.filter((row) => {
    if (row.f1 === null || row.f1 <= best) return false;
    best = row.f1;
    return true;
  });
}

export async function buildCostChart(result: AnalysisResult, outputDir: string): Promise<string[]> {
  const width = 1500;
  const height = 980;
  const plotLeft = 145;
  const plotRight = 1420;
  const plotTop = 190;
  const plotBottom = 840;
  const valid = result.rowMetrics.filter((row) => row.f1 !== null);
  const allCosts = result.rowMetrics.map((row) => row.totalTokensMillions);
  const rawMin = Math.min(...allCosts);
  const rawMax = Math.max(...allCosts);
  const padding = Math.max(1, (rawMax - rawMin) * 0.1);
  const minX = Math.max(0, rawMin - padding);
  const maxX = rawMax + padding;
  const maxY = Math.max(0.1, Math.max(...valid.map((row) => row.f1 ?? 0)) * 1.15);
  const xAt = (value: number) => plotLeft + ((value - minX) / (maxX - minX)) * (plotRight - plotLeft);
  const yAt = (value: number) => plotBottom - (value / maxY) * (plotBottom - plotTop);
  const parts: string[] = [];

  parts.push(text(60, 58, "Performance × compute cost", { "font-size": 28, "font-weight": 650 }));
  parts.push(text(60, 90, "F1 score vs total tokens", { "font-size": 15, fill: "#666" }));
  result.conditions.forEach((condition, index) => {
    const style = CONDITION_STYLES[index % CONDITION_STYLES.length] ?? CONDITION_STYLES[0];
    const x = 70 + index * 220;
    parts.push(style.square ? markerSquare(x, 132, 8, style) : circle(x, 132, 8, style));
    parts.push(text(x + 18, 137, condition, { "font-size": 13 }));
  });

  for (let tick = 0; tick <= 6; tick += 1) {
    const value = minX + ((maxX - minX) * tick) / 6;
    const x = xAt(value);
    parts.push(line(x, plotBottom, x, plotBottom + 7, { stroke: "#777" }));
    parts.push(text(x, plotBottom + 28, value.toFixed(1), { "font-size": 12, "text-anchor": "middle", fill: "#666" }));
    const score = (maxY * tick) / 6;
    const y = yAt(score);
    parts.push(line(plotLeft, y, plotRight, y, { stroke: tick === 0 ? "#888" : "#e3e3e3" }));
    parts.push(text(plotLeft - 13, y + 5, tickLabel(score), { "font-size": 12, "text-anchor": "end", fill: "#666" }));
  }
  parts.push(
    text((plotLeft + plotRight) / 2, 905, "Compute cost (total tokens, millions)", {
      "font-size": 14,
      "text-anchor": "middle",
      fill: "#444"
    })
  );
  parts.push(
    element(
      "text",
      {
        x: 35,
        y: (plotTop + plotBottom) / 2,
        "font-family": "Inter, Arial, sans-serif",
        "font-size": 14,
        fill: "#444",
        transform: `rotate(-90 35 ${(plotTop + plotBottom) / 2})`,
        "text-anchor": "middle"
      },
      "Performance (F1 score)"
    )
  );

  result.conditions.forEach((condition, index) => {
    const style = CONDITION_STYLES[index % CONDITION_STYLES.length] ?? CONDITION_STYLES[0];
    const rows = valid.filter((row) => row.condition === condition);
    const frontier = pareto(rows);
    if (frontier.length > 1) {
      parts.push(
        element("polyline", {
          points: frontier.map((row) => `${xAt(row.totalTokensMillions)},${yAt(row.f1 ?? 0)}`).join(" "),
          fill: "none",
          stroke: style.stroke,
          "stroke-width": 2
        })
      );
    }
    rows.forEach((row, rowIndex) => {
      const x = xAt(row.totalTokensMillions);
      const y = yAt(row.f1 ?? 0);
      parts.push(style.square ? markerSquare(x, y, 8, style) : circle(x, y, 8, style));
      parts.push(
        text(x + 11, y + (rowIndex % 2 === 0 ? -10 : 20), row.label, {
          "font-size": 14,
          "font-weight": 650
        })
      );
    });
    if (rows.length > 0) {
      const costs = rows.map((row) => row.totalTokensMillions);
      const scores = rows.map((row) => row.f1 ?? 0);
      const xMean = mean(costs) ?? 0;
      const yMean = mean(scores) ?? 0;
      const xSd = sampleStdev(costs) ?? 0;
      const ySd = sampleStdev(scores) ?? 0;
      const cx = xAt(xMean);
      const cy = yAt(yMean);
      parts.push(
        line(xAt(Math.max(minX, xMean - xSd)), cy, xAt(Math.min(maxX, xMean + xSd)), cy, {
          stroke: style.stroke,
          "stroke-width": 1.3
        })
      );
      parts.push(
        line(cx, yAt(Math.min(maxY, yMean + ySd)), cx, yAt(Math.max(0, yMean - ySd)), {
          stroke: style.stroke,
          "stroke-width": 1.3
        })
      );
      parts.push(symbolDiamond(cx, cy, 9, { fill: "#fff", stroke: style.stroke, "stroke-width": 1.5 }));
    }
  });

  parts.push(
    text(plotRight, 948, "USD estimates may be partial and are not used on the axis.", {
      "font-size": 12,
      "text-anchor": "end",
      fill: "#777"
    })
  );
  const svgPath = join(outputDir, "cost_performance.svg");
  return writeSvgAndPng(svgDocument(width, height, parts.join("\n")), svgPath);
}
