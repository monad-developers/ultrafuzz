// Shared by the generated agent adapters so that a parsing fix lands once for
// every backend rather than being copied into each one.

const SIMPLE_ESCAPES: Record<string, string> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  '"': '"',
  "\\": "\\"
};

export function readStringTable(text: string, tableName: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let inTable = false;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const table = /^\[([^\]]+)\]$/u.exec(line);
    if (table) {
      inTable = table[1]?.trim() === tableName;
      continue;
    }
    if (!inTable) {
      continue;
    }
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*"((?:\\.|[^"\\])*)"\s*(?:#.*)?$/u.exec(line);
    if (assignment?.[1] && assignment[2] !== undefined) {
      fields[assignment[1]] = decodeBasicString(assignment[2], `${tableName}.${assignment[1]}`);
    }
  }
  return fields;
}

/**
 * Read the assignments that precede the first table header. TOML calls these
 * the root table; `readStringTable` cannot express them because it only starts
 * collecting once a `[table]` line matches.
 */
export function readRootStringTable(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("[")) {
      break;
    }
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*"((?:\\.|[^"\\])*)"\s*(?:#.*)?$/u.exec(line);
    if (assignment?.[1] && assignment[2] !== undefined) {
      fields[assignment[1]] = decodeBasicString(assignment[2], assignment[1]);
    }
  }
  return fields;
}

export function stringField(table: Record<string, string>, key: string): string | undefined {
  const value = table[key];
  if (value === undefined) {
    return undefined;
  }
  return value;
}

// A TOML basic string is not a JSON string: TOML adds \UXXXXXXXX, which JSON's
// parser rejects outright. Decoding here keeps a config typo a readable error
// instead of an uncaught SyntaxError raised while the workflow is rendering.
function decodeBasicString(value: string, context: string): string {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      decoded += char;
      continue;
    }
    index += 1;
    const escape = value[index] ?? "";
    const simple = SIMPLE_ESCAPES[escape];
    if (simple !== undefined) {
      decoded += simple;
      continue;
    }
    if (escape !== "u" && escape !== "U") {
      throw new Error(`${context} has an unsupported escape \\${escape}`);
    }
    const width = escape === "u" ? 4 : 8;
    const hex = value.slice(index + 1, index + 1 + width);
    if (!new RegExp(`^[0-9A-Fa-f]{${width}}$`, "u").test(hex)) {
      throw new Error(`${context} has a malformed \\${escape} escape`);
    }
    const codePoint = Number.parseInt(hex, 16);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      throw new Error(`${context} has a \\${escape} escape outside the Unicode scalar range`);
    }
    decoded += String.fromCodePoint(codePoint);
    index += width;
  }
  return decoded;
}
