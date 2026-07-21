import type { Severity } from "../types.js";

const SEVERITY_RANK: Record<Severity, number> = { H: 3, M: 2, L: 1, I: 0 };

export function bugSort(a: string, b: string): number {
  const left = /^([HMLI])-(\d+)$/.exec(a);
  const right = /^([HMLI])-(\d+)$/.exec(b);
  if (!left || !right) return a.localeCompare(b);
  const severityDelta = SEVERITY_RANK[right[1] as Severity] - SEVERITY_RANK[left[1] as Severity];
  if (severityDelta) return severityDelta;
  return Number(left[2]) - Number(right[2]);
}

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined || (typeof value === "number" && !Number.isFinite(value))) return "";
  const raw = Array.isArray(value)
    ? value.join("; ")
    : typeof value === "boolean"
      ? String(value)
      : typeof value === "number"
        ? Number.isInteger(value)
          ? String(value)
          : value.toFixed(6)
        : String(value);
  const rendered =
    (typeof value === "string" || Array.isArray(value)) && /^(?:[=+@]|-(?![0-9.]))/u.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(rendered) ? `"${rendered.replaceAll('"', '""')}"` : rendered;
}

export function toCsv(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (!rows.length) return "";
  const headers = columns ?? Object.keys(rows[0] ?? {});
  return (
    [
      headers.map(csvEscape).join(","),
      ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))
    ].join("\n") + "\n"
  );
}

export function percent(value: number | null, digits = 1): string {
  return value === null || !Number.isFinite(value) ? "NA" : `${(value * 100).toFixed(digits)}%`;
}

export function fixed(value: number | null, digits = 1): string {
  return value === null || !Number.isFinite(value) ? "NA" : value.toFixed(digits);
}

export function escapeXml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (item instanceof Set ? [...item] : item), 2) + "\n";
}
