import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export interface StrictJsonLimits {
  maxBytes: number;
  maxDepth: number;
  maxItems: number;
  maxProperties: number;
}

const DEFAULT_STRICT_JSON_LIMITS: Readonly<StrictJsonLimits> = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxDepth: 128,
  maxItems: 1_000_000,
  maxProperties: 1_000_000
});

export type StrictJsonErrorKind = "duplicate-key" | "encoding" | "limit" | "syntax";

export class StrictJsonError extends Error {
  readonly kind: StrictJsonErrorKind;
  readonly pointer: string;

  constructor(kind: StrictJsonErrorKind, message: string, pointer = "") {
    super(message);
    this.name = "StrictJsonError";
    this.kind = kind;
    this.pointer = pointer;
  }
}

/** Capture one bounded, no-follow regular-file snapshot and reject concurrent replacement or mutation. */
export function readRegularFileSnapshot(filePath: string, maxBytes: number): Buffer {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let descriptor: number;
  try {
    descriptor = openSync(filePath, flags);
  } catch (error) {
    throw new Error(`cannot open regular file ${filePath}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error(`path is not a regular file: ${filePath}`);
    if (before.size > BigInt(maxBytes)) throw new Error(`file exceeds the ${maxBytes}-byte limit: ${filePath}`);
    const chunks: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - offset));
      const read = readSync(descriptor, chunk, 0, chunk.length, offset);
      if (read === 0) break;
      offset += read;
      if (offset > maxBytes) throw new Error(`file exceeds the ${maxBytes}-byte limit: ${filePath}`);
      chunks.push(chunk.subarray(0, read));
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.size !== BigInt(offset)
    ) {
      throw new Error(`file changed while it was read: ${filePath}`);
    }
    return Buffer.concat(chunks, offset);
  } finally {
    closeSync(descriptor);
  }
}

/** Parse RFC 8259 JSON without the duplicate-key and UTF-8 ambiguity of JSON.parse(Buffer.toString()). */
export function parseStrictJsonBytes(bytes: Uint8Array, limits: Partial<StrictJsonLimits> = {}): unknown {
  const resolved = { ...DEFAULT_STRICT_JSON_LIMITS, ...limits };
  if (bytes.byteLength > resolved.maxBytes) {
    throw new StrictJsonError("limit", `JSON exceeds the ${resolved.maxBytes}-byte limit`);
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new StrictJsonError("syntax", "A UTF-8 byte-order mark is not permitted in strict JSON");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new StrictJsonError("encoding", "JSON is not valid UTF-8");
  }
  return parseStrictJson(text, resolved);
}

export function parseStrictJson(text: string, limits: Partial<StrictJsonLimits> = {}): unknown {
  const resolved = { ...DEFAULT_STRICT_JSON_LIMITS, ...limits };
  if (utf8ByteLengthExceeds(text, resolved.maxBytes)) {
    throw new StrictJsonError("limit", `JSON exceeds the ${resolved.maxBytes}-byte limit`);
  }
  return new Parser(text, resolved).parse();
}

function utf8ByteLengthExceeds(text: string, maximum: number): boolean {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > maximum) return true;
  }
  return false;
}

class Parser {
  private index = 0;
  private items = 0;
  private properties = 0;

  constructor(
    private readonly text: string,
    private readonly limits: StrictJsonLimits
  ) {}

  parse(): unknown {
    this.skipWhitespace();
    const value = this.parseValue(0, "");
    this.skipWhitespace();
    if (this.index !== this.text.length) this.syntax("Unexpected content after the JSON value");
    return value;
  }

  private parseValue(depth: number, pointer: string): unknown {
    if (depth > this.limits.maxDepth) {
      throw new StrictJsonError("limit", `JSON exceeds the nesting-depth limit of ${this.limits.maxDepth}`, pointer);
    }
    const char = this.text[this.index];
    if (char === "{") return this.parseObject(depth, pointer);
    if (char === "[") return this.parseArray(depth, pointer);
    if (char === '"') return this.parseString();
    if (char === "t") return this.parseLiteral("true", true);
    if (char === "f") return this.parseLiteral("false", false);
    if (char === "n") return this.parseLiteral("null", null);
    if (char === "-" || (char !== undefined && char >= "0" && char <= "9")) return this.parseNumber();
    this.syntax(char === undefined ? "Unexpected end of JSON" : "Expected a JSON value", pointer);
  }

  private parseObject(depth: number, pointer: string): Record<string, unknown> {
    this.index += 1;
    this.skipWhitespace();
    const output: Record<string, unknown> = {};
    const keys = new Set<string>();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return output;
    }
    for (;;) {
      if (this.text[this.index] !== '"') this.syntax("Expected an object-property string", pointer);
      const key = this.parseString();
      const childPointer = `${pointer}/${escapePointer(key)}`;
      if (keys.has(key)) {
        throw new StrictJsonError("duplicate-key", "JSON object contains a duplicate property name", childPointer);
      }
      keys.add(key);
      this.properties += 1;
      if (this.properties > this.limits.maxProperties) {
        throw new StrictJsonError(
          "limit",
          `JSON exceeds the property limit of ${this.limits.maxProperties}`,
          childPointer
        );
      }
      this.skipWhitespace();
      if (this.text[this.index] !== ":") this.syntax("Expected ':' after an object-property name", childPointer);
      this.index += 1;
      this.skipWhitespace();
      Object.defineProperty(output, key, {
        value: this.parseValue(depth + 1, childPointer),
        enumerable: true,
        configurable: true,
        writable: true
      });
      this.skipWhitespace();
      const separator = this.text[this.index];
      if (separator === "}") {
        this.index += 1;
        return output;
      }
      if (separator !== ",") this.syntax("Expected ',' or '}' in an object", pointer);
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number, pointer: string): unknown[] {
    this.index += 1;
    this.skipWhitespace();
    const output: unknown[] = [];
    if (this.text[this.index] === "]") {
      this.index += 1;
      return output;
    }
    for (;;) {
      this.items += 1;
      const childPointer = `${pointer}/${output.length}`;
      if (this.items > this.limits.maxItems) {
        throw new StrictJsonError("limit", `JSON exceeds the item limit of ${this.limits.maxItems}`, childPointer);
      }
      output.push(this.parseValue(depth + 1, childPointer));
      this.skipWhitespace();
      const separator = this.text[this.index];
      if (separator === "]") {
        this.index += 1;
        return output;
      }
      if (separator !== ",") this.syntax("Expected ',' or ']' in an array", pointer);
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    this.index += 1;
    let segmentStart = this.index;
    let output = "";
    for (;;) {
      const char = this.text[this.index];
      if (char === undefined) this.syntax("Unterminated JSON string");
      if (char === '"') {
        output += this.text.slice(segmentStart, this.index);
        this.index += 1;
        return output;
      }
      if (char.charCodeAt(0) <= 0x1f) this.syntax("Unescaped control character in JSON string");
      if (char !== "\\") {
        this.index += 1;
        continue;
      }
      output += this.text.slice(segmentStart, this.index);
      this.index += 1;
      const escape = this.text[this.index];
      if (escape === "u") {
        const hex = this.text.slice(this.index + 1, this.index + 5);
        if (!/^[0-9a-fA-F]{4}$/u.test(hex)) this.syntax("Invalid Unicode escape in JSON string");
        output += String.fromCharCode(Number.parseInt(hex, 16));
        this.index += 5;
        segmentStart = this.index;
        continue;
      }
      const escaped = escape === undefined ? undefined : STRING_ESCAPES[escape];
      if (escaped === undefined) this.syntax("Invalid escape in JSON string");
      output += escaped;
      this.index += 1;
      segmentStart = this.index;
    }
  }

  private parseNumber(): number {
    const tail = this.text.slice(this.index);
    const matched = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(tail)?.[0];
    if (matched === undefined) this.syntax("Invalid JSON number");
    this.index += matched.length;
    const terminator = this.text[this.index];
    if (terminator !== undefined && !isWhitespace(terminator) && !",]}".includes(terminator)) {
      this.syntax("Invalid character after JSON number");
    }
    const value = Number(matched);
    if (!Number.isFinite(value)) this.syntax("JSON number is outside the supported finite range");
    return value;
  }

  private parseLiteral<T>(token: string, value: T): T {
    if (!this.text.startsWith(token, this.index)) this.syntax("Invalid JSON literal");
    this.index += token.length;
    return value;
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length && isWhitespace(this.text[this.index]!)) this.index += 1;
  }

  private syntax(message: string, pointer = ""): never {
    throw new StrictJsonError("syntax", `${message} at character ${this.index}`, pointer);
  }
}

const STRING_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t"
});

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
