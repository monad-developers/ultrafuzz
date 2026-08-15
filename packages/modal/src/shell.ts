/** Quote one opaque value for a POSIX shell command string. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
