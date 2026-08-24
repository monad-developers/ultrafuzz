/** Structural primitives shared across packages; previously copy-pasted per file. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Renders a JSON pointer as a JavaScript-style property path rooted at `root`. */
export function jsonPointerPath(root: string, pointer: string): string {
  if (pointer === "") return root;
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce(
      (current, segment) =>
        /^(?:0|[1-9][0-9]*)$/u.test(segment)
          ? `${current}[${segment}]`
          : `${current}${/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`}`,
      root
    );
}

/** Order-insensitive canonical key for structural JSON equality and dedupe. */
export function canonicalJsonValueKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJsonValueKey(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJsonValueKey(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
