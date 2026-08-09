import { TextDecoder } from "node:util";

export interface StrictJsonLimits {
  maxBytes: number;
  maxDepth: number;
  maxItems: number;
  maxProperties: number;
}

export const DEFAULT_STRICT_JSON_LIMITS: Readonly<StrictJsonLimits> = Object.freeze({
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
  if (Buffer.byteLength(text, "utf8") > resolved.maxBytes) {
    throw new StrictJsonError("limit", `JSON exceeds the ${resolved.maxBytes}-byte limit`);
  }
  return new Parser(text, resolved).parse();
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
    const start = this.index;
    this.index += 1;
    for (;;) {
      const char = this.text[this.index];
      if (char === undefined) this.syntax("Unterminated JSON string");
      if (char === '"') {
        this.index += 1;
        try {
          return JSON.parse(this.text.slice(start, this.index)) as string;
        } catch {
          this.syntax("Invalid JSON string escape");
        }
      }
      if (char.charCodeAt(0) <= 0x1f) this.syntax("Unescaped control character in JSON string");
      if (char === "\\") {
        this.index += 1;
        const escape = this.text[this.index];
        if (escape === "u") {
          const hex = this.text.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) this.syntax("Invalid Unicode escape in JSON string");
          this.index += 5;
          continue;
        }
        if (escape === undefined || !'"\\/bfnrt'.includes(escape)) {
          this.syntax("Invalid escape in JSON string");
        }
      }
      this.index += 1;
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
    if (!this.text.startsWith(token, this.index)) this.syntax(`Invalid JSON literal`);
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

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
