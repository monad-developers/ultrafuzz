import type { Stats } from "../types.js";

export function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function mean(values: number[]): number | null {
  return values.length ? sum(values) / values.length : null;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? (ordered[middle] ?? null) : ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2;
}

export function sampleStdev(values: number[]): number | null {
  if (!values.length) return null;
  if (values.length === 1) return 0;
  const average = mean(values) ?? 0;
  const variance = sum(values.map((value) => (value - average) ** 2)) / (values.length - 1);
  return Math.sqrt(variance);
}

export function stats(values: Array<number | null | undefined>): Stats {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    mean: mean(finite),
    median: median(finite),
    stdev: sampleStdev(finite),
    n: finite.length
  };
}

export function harmonicMean(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  if (a + b === 0) return 0;
  return (2 * a * b) / (a + b);
}
