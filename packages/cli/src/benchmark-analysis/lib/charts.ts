import { join } from "node:path";

import type { AnalysisResult, Severity } from "../types.js";
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
  { fill: "#bdbdbd", stroke: "#444444", square: true },
  { fill: "#ffffff", stroke: "#777777", square: false }
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
    parts.push(text(505, y + 5, rowId, { "font-size": 15, "font-weight": 650, "text-anchor": "end" }));
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
  const summaryTop = rowTop + result.rowOrder.length * rowStep + 45;
  const plotBottom = summaryTop + result.conditions.length * rowStep + 20;
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
    text(60, 164, "Condition summary: bar = mean · diamond = median · whisker = ±1 sample SD", {
      "font-size": 12,
      fill: "#666"
    })
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
    parts.push(text(270, y + 6, rowId, { "font-size": 16, "font-weight": 650, "text-anchor": "end" }));
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

  result.conditions.forEach((condition, index) => {
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
    const x = 70 + index * 180;
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
      parts.push(text(x + 11, y + (rowIndex % 2 === 0 ? -10 : 20), row.rowId, { "font-size": 14, "font-weight": 650 }));
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
