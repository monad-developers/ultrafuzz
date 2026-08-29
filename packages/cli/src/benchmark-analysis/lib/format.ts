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
